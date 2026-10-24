/**
 * Database-canonical memory, wave 5a: the live import lane (docs/designs/database-canonical-w5-contract.md, "The live import
 * lane"). For a database-mode source with export commits on, it applies wave 3's decision table (`decideImportCase`) to
 * outside changes instead of only recording them: an adopt moves the ledger, an import or create writes the page with a
 * revision check under the page row's lock, a delete soft-deletes with the same check, and every conflict parks the path in
 * an open `import_conflicts` row with `mode='live'`. It never writes the checkout: the exporter renders what changed.
 */
import { CANONICAL_PROTOCOL_DECLARATION } from './canonical-mode.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { exportPathKey } from '../export-stage.ts';
import { readExportPage, readExportWithdrawals } from '../export-snapshot.ts';
import { importFromContent } from '../import-file.ts';
import { screenImportContent } from '../import-screen.ts';
import { pathToSlug } from '../sync.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { compareInlineExportFile } from './canonical-export.ts';
import { gitRun, writeBlob } from './export-core.ts';
import type { ImportConflictKind } from './import-conflict-mapping.ts';
import { IMPORT_CONFLICT_INLINE_BYTES } from './import-conflicts-schema.ts';
import { decideImportCase, type ImportCaseDecision } from './import-lane.ts';
import { protectedReconcileKey } from './reconcile-merge.ts';
import { UNFINISHED_EXPORT_BATCH_STATES_SQL } from './canonical-export-schema.ts';

export interface LiveImportChange {
  /** Source-relative path. */
  path: string;
  read: { state: 'missing'; evidence: 'at_head' | 'removed_by_commit' | 'none' } | { state: 'present'; bytes: Buffer };
  /** The fetched commit the bytes come from, or null for a worktree change. */
  commit_sha: string | null;
  /** The unpushed local range changed this path too: an import would overwrite the database's newer export. */
  bothChanged?: boolean;
}

export interface LiveImportContext { engine: BrainEngine; sourceId: string; root: string; top: string; prefix: string }

export interface LiveImportOutcome { path: string; outcome: ImportCaseDecision['outcome'] | 'own_write' | 'raced'; kind?: ImportConflictKind; reason: string }

interface PageRow { id: number; slug: string; source_id: string; revision: string; deleted: boolean; segmented: boolean }
const PAGE_SELECT = `SELECT id, slug, source_id, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, body_storage='segmented' AS segmented FROM pages`;

interface LedgerRow { id: number; page_id: number; path: string; path_folded: string; revision: string; disk_sha256: string; blob_oid: string | null; lifetime: number }

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function ledgerRow(engine: BrainEngine, sourceId: string, folded: string): Promise<LedgerRow | null> {
  const [row] = await engine.executeRaw<LedgerRow>(`SELECT id, page_id, path, path_folded, revision::text, disk_sha256, blob_oid, lifetime FROM export_ledger
    WHERE source_id=$1 AND path_folded=$2 AND retired_at IS NULL`, [sourceId, folded]);
  return row ? { ...row, id: Number(row.id), page_id: Number(row.page_id), lifetime: Number(row.lifetime) } : null;
}

/** True when an unfinished batch of the source wrote exactly these bytes to this path (a crash between file write and ledger write). */
async function ownWrite(engine: BrainEngine, sourceId: string, folded: string, hash: string | null): Promise<boolean> {
  const rows = await engine.executeRaw<{ disk_sha256: string | null; op: string }>(`SELECT e.disk_sha256, e.op FROM export_batch_entries e JOIN export_batches b ON b.id=e.batch_id
    WHERE b.source_id=$1 AND b.state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL} AND e.path_folded=$2 AND e.state<>'skipped'`, [sourceId, folded]);
  return rows.some(r => r.op === 'remove' ? hash === null : r.disk_sha256 === hash);
}

/** Classifies and applies every change; returns what happened to each. */
export async function applyLiveImport(ctx: LiveImportContext, changes: readonly LiveImportChange[]): Promise<LiveImportOutcome[]> {
  const mode = await scannerSlugRootMode(ctx.engine, ctx.sourceId, ctx.root);
  const out: LiveImportOutcome[] = [];
  for (const change of changes) out.push(await applyOne(ctx, mode, change, false));
  return out;
}

async function applyOne(ctx: LiveImportContext, mode: Awaited<ReturnType<typeof scannerSlugRootMode>>, change: LiveImportChange, retried: boolean): Promise<LiveImportOutcome> {
  const { engine, sourceId, root } = ctx;
  let folded: string;
  try { folded = exportPathKey(change.path); } catch { return { path: change.path, outcome: 'none', reason: 'unexportable_path' }; }
  const bytes = change.read.state === 'present' ? change.read.bytes : null;
  const hash = bytes ? sha256(bytes) : null;
  if (await ownWrite(engine, sourceId, folded, hash)) return { path: change.path, outcome: 'own_write', reason: 'unfinished_batch_entry' };
  const base = await ledgerRow(engine, sourceId, folded);
  const importPath = scannerSourcePath(root, join(root, ...change.path.split('/')), mode);
  const [row] = base
    ? await engine.executeRaw<PageRow>(`${PAGE_SELECT} WHERE id=$1`, [base.page_id])
    : await engine.executeRaw<PageRow>(`${PAGE_SELECT} WHERE source_id=$1 AND deleted_at IS NULL AND (source_path=$2 OR slug=$3) ORDER BY (source_path=$2) DESC LIMIT 1`,
      [sourceId, importPath, pathToSlug(change.path)]);
  const live = !!row && row.source_id === sourceId && !row.deleted;
  const page = row ? { live, revision: row.revision, segmented: row.segmented } : null;
  const facts = { base: base ? { revision: base.revision, disk_sha256: base.disk_sha256 } : null, page };

  let decision: ImportCaseDecision;
  let detail: Record<string, unknown> = {};
  if (change.read.state === 'missing') {
    decision = decideImportCase({ ...facts, file: { state: 'missing', evidence: change.read.evidence } });
  } else {
    if (base && hash === base.disk_sha256) return { path: change.path, outcome: 'none', reason: 'unchanged' };
    const tooLarge = bytes!.length > IMPORT_CONFLICT_INLINE_BYTES;
    let screen: string | null = null, equal = false, protectedChanged = false;
    if (!tooLarge) {
      const text = bytes!.toString('utf8');
      const screened = Buffer.from(text).equals(bytes!) ? screenImportContent({ content: text, path: change.path, expectedSlug: row?.slug ?? null, fences: 'coordinated' })
        : { status: 'refused' as const, refusal: { code: 'not_utf8', message: 'The file is not valid UTF-8.' } };
      if (screened.status === 'refused') { screen = screened.refusal.code; detail = { code: screened.refusal.code, message: screened.refusal.message }; }
      else if (row && live && !row.segmented) {
        const compared = await engine.transaction(async tx => {
          await tx.executeRaw('SET TRANSACTION READ ONLY');
          const withdrawals = await readExportWithdrawals(tx as BrainEngine, sourceId);
          return compareInlineExportFile(bytes!, importPath, await readExportPage(tx as BrainEngine, { id: String(row.id), source_id: sourceId, slug: row.slug }, withdrawals));
        });
        if (compared.state === 'unparseable') { screen = 'unparseable'; detail = { code: 'unparseable' }; }
        equal = compared.state === 'equal';
        if (compared.state === 'differs') {
          detail = { fields: compared.paths };
          protectedChanged = compared.paths.some(p => p.startsWith('/frontmatter/') && protectedReconcileKey(p.slice(13).replace(/~1/g, '/').replace(/~0/g, '~')));
        }
      }
    }
    decision = decideImportCase({ ...facts, file: { state: 'present', tooLarge, screen, equal, protectedChanged } });
  }
  if (change.bothChanged && ['import', 'delete', 'streamed_import'].includes(decision.outcome)) decision = { outcome: 'conflict', kind: 'both_changed', reason: 'local_and_remote_changed' };
  if (decision.outcome === 'streamed_import') { decision = { outcome: 'conflict', kind: 'too_large_for_lane', reason: 'over_request_cap' }; detail = { ...detail, reason: 'streamed_import_unavailable' }; }

  const result = { path: change.path, outcome: decision.outcome, kind: decision.kind, reason: decision.reason } as LiveImportOutcome;
  switch (decision.outcome) {
    case 'none': return result;
    case 'adopt': {
      const blob = await writeBlob(ctx.top, bytes!);
      if (base) {
        await engine.executeRaw(`UPDATE export_ledger SET disk_sha256=$2, blob_oid=$3, revision=$4::uuid, commit_sha=COALESCE($5, commit_sha), seeded_from='import_lane'
          WHERE id=$1 AND disk_sha256=$6`, [base.id, hash, blob, row!.revision, change.commit_sha, base.disk_sha256]);
      } else await insertLedger(engine, sourceId, row!.id, change.path, folded, row!.revision, hash!, blob, change.commit_sha);
      await resolveOpen(engine, sourceId, folded, 'cleared');
      return result;
    }
    case 'import': case 'create': case 'delete': {
      const applied = await writePage(ctx, decision.outcome, change, folded, importPath, base, row ?? null, bytes, hash);
      if (applied) { await resolveOpen(engine, sourceId, folded, 'cleared'); return result; }
      if (!retried) return applyOne(ctx, mode, change, true);
      decision = { outcome: 'conflict', kind: 'both_changed', reason: 'revision_race' };
      break;
    }
    default: break;
  }
  await parkConflict(ctx, change, folded, decision, base, row ?? null, bytes, hash, detail);
  return { path: change.path, outcome: 'conflict', kind: decision.kind, reason: decision.reason };
}

async function insertLedger(tx: BrainEngine, sourceId: string, pageId: number, path: string, folded: string, revision: string, hash: string, blob: string | null, commit: string | null): Promise<void> {
  await tx.executeRaw(`UPDATE export_ledger SET retired_at=now() WHERE source_id=$1 AND (page_id=$2 OR path_folded=$3) AND retired_at IS NULL`, [sourceId, pageId, folded]);
  await tx.executeRaw(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, lifetime, path, path_folded, revision, disk_sha256, blob_oid, commit_sha, seeded_from)
    SELECT $1, s.incarnation, $2, COALESCE((SELECT max(lifetime) FROM export_ledger WHERE source_id=$1 AND page_id=$2), 0) + 1, $3, $4, $5::uuid, $6, $7, $8, 'import_lane'
    FROM sources s WHERE s.id=$1`, [sourceId, pageId, path, folded, revision, hash, blob, commit]);
}

/**
 * The revision-checked page write: under the page row's lock, the page must still be at the ledger's revision (create: no
 * live page holds the slug). Returns false when it moved, so the caller re-decides once.
 */
async function writePage(ctx: LiveImportContext, outcome: 'import' | 'create' | 'delete', change: LiveImportChange, folded: string, importPath: string,
  base: LedgerRow | null, row: PageRow | null, bytes: Buffer | null, hash: string | null): Promise<boolean> {
  const { engine, sourceId } = ctx;
  const blob = bytes ? await writeBlob(ctx.top, bytes) : null;
  return engine.transaction(async txEngine => {
    const tx = txEngine as BrainEngine;
    await tx.executeRaw(`SELECT ${CANONICAL_PROTOCOL_DECLARATION}`);
    if (outcome === 'create') {
      const slug = pathToSlug(change.path);
      const [taken] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL FOR UPDATE', [sourceId, slug]);
      if (taken) return false;
      const imported = await importFromContent(tx, slug, bytes!.toString('utf8'), { sourceId, sourcePath: importPath, noEmbed: true, ingested_via: 'gbrain-import-lane' });
      if (imported.status === 'error') throw new Error(imported.error ?? 'import failed');
      const [now] = await tx.executeRaw<{ id: number; revision: string }>('SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
      await insertLedger(tx, sourceId, Number(now!.id), change.path, folded, now!.revision, hash!, blob, change.commit_sha);
      return true;
    }
    const [locked] = await tx.executeRaw<{ revision: string; deleted: boolean }>('SELECT knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE id=$1 FOR UPDATE', [row!.id]);
    if (!locked || locked.deleted || locked.revision !== base!.revision) return false;
    if (outcome === 'delete') {
      await tx.softDeletePage(row!.slug, { sourceId });
      await tx.executeRaw('UPDATE export_ledger SET retired_at=now() WHERE id=$1', [base!.id]);
      return true;
    }
    const imported = await importFromContent(tx, row!.slug, bytes!.toString('utf8'), { sourceId, sourcePath: importPath, noEmbed: true, ingested_via: 'gbrain-import-lane' });
    if (imported.status === 'error') throw new Error(imported.error ?? 'import failed');
    const [now] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [row!.id]);
    const moved = await tx.executeRaw(`UPDATE export_ledger SET revision=$2::uuid, disk_sha256=$3, blob_oid=$4, commit_sha=COALESCE($5, commit_sha), seeded_from='import_lane'
      WHERE id=$1 AND disk_sha256=$6 RETURNING id`, [base!.id, now!.revision, hash, blob, change.commit_sha, base!.disk_sha256]);
    if (!moved.length) throw new Error('export ledger moved under the live import lane');
    return true;
  }).catch(error => {
    if (error instanceof Error && /export ledger moved/.test(error.message)) return false;
    throw error;
  });
}

async function resolveOpen(engine: BrainEngine, sourceId: string, folded: string, resolution: 'cleared' | 'superseded'): Promise<void> {
  await engine.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution=$3 WHERE source_id=$1 AND path_folded=$2 AND state='open'`, [sourceId, folded, resolution]);
}

/** The private ref that pins the bytes of a live conflict above the inline limit. */
export function liveConflictRef(conflictId: number): string {
  return `refs/gbrain/conflicts/${conflictId}`;
}

/** An open live conflict for the path (superseding an older open row); bytes inline up to 24 MiB, else pinned under a private ref. */
async function parkConflict(ctx: LiveImportContext, change: LiveImportChange, folded: string, decision: ImportCaseDecision, base: LedgerRow | null,
  row: PageRow | null, bytes: Buffer | null, hash: string | null, detail: Record<string, unknown>): Promise<void> {
  const { engine, sourceId } = ctx;
  const inline = bytes && bytes.length <= IMPORT_CONFLICT_INLINE_BYTES ? bytes : null;
  const id = await engine.transaction(async tx => {
    const [flag] = await tx.executeRaw<{ shadow_epoch: number }>('SELECT shadow_epoch::int AS shadow_epoch FROM database_canonical_sources WHERE source_id=$1 FOR SHARE', [sourceId]);
    const [open] = await tx.executeRaw<{ id: number; same: boolean }>(`SELECT id, (kind IS NOT DISTINCT FROM $3 AND file_sha256 IS NOT DISTINCT FROM $4 AND db_revision IS NOT DISTINCT FROM $5::uuid) AS same
      FROM import_conflicts WHERE source_id=$1 AND path_folded=$2 AND state='open'`, [sourceId, folded, decision.kind ?? null, hash, row?.revision ?? null]);
    if (open?.same) { await tx.executeRaw('UPDATE import_conflicts SET observed_at=now(), mode=$2 WHERE id=$1', [open.id, 'live']); return null; }
    if (open) await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='superseded' WHERE id=$1`, [open.id]);
    const [inserted] = await tx.executeRaw<{ id: number }>(`INSERT INTO import_conflicts(source_id, path, path_folded, page_id, mode, outcome, kind, shadow_epoch, base_revision, db_revision,
        base_sha256, file_sha256, file_size, file_bytes, commit_sha, detail)
      VALUES ($1,$2,$3,$4,'live','conflict',$5,$6,$7::uuid,$8::uuid,$9,$10,$11,$12,$13,$14::text::jsonb) RETURNING id`,
      [sourceId, change.path, folded, row ? Number(row.id) : base?.page_id ?? null, decision.kind, Number(flag?.shadow_epoch ?? 0), base?.revision ?? null, row?.revision ?? null,
        base?.disk_sha256 ?? null, hash, bytes?.length ?? null, inline, change.commit_sha, JSON.stringify({ ...detail, reason: decision.reason })]);
    return Number(inserted!.id);
  });
  if (id === null || !bytes || inline) return;
  const blob = await writeBlob(ctx.top, bytes);
  const ref = liveConflictRef(id);
  const pinned = await gitRun(ctx.top, ['update-ref', ref, blob]);
  await engine.executeRaw('UPDATE import_conflicts SET file_ref=$2, detail=detail || $3::text::jsonb WHERE id=$1', [id, ref, JSON.stringify({ ref_pinned: pinned.code === 0 })]);
}
