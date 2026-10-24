/**
 * Database-canonical memory, wave 2: the ledger seed and the shadow consumer (contract:
 * docs/designs/database-canonical-w2-contract.md). The seed turns managed sync's per-page import provenance into export
 * ledger rows, so the shadow has a base before anything is exported. The consumer turns export outbox rows into one
 * shadow batch: for each page, what the exporter would do against the file on disk (a diff kind), judged with wave 1's
 * eligibility predicate and equality contract. It writes only the shadow tables and `shadow_adopt` ledger rows for files
 * already equal to their page; it never touches the checkout.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { readExportPage, readExportWithdrawals } from '../export-snapshot.ts';
import { exportPathKey } from '../export-stage.ts';
import { RestoreTargetError, restoreFilePath } from '../restore-target.ts';
import { privatePagesFilterFragment, readHonorAliases } from '../search/private-visibility.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import type { SlugRootMode } from '../sync-anchor.ts';
import { compareInlineExportFile, compareSegmentedExportFile, exportIneligibility, ignoredPaths, type ExportPolicy } from './canonical-export.ts';
import { consumeExportOutbox, exportOutboxStats, isExpectedShadowDiff, readExportOutbox, readLiveLedgerRows, readSourceCanonicalState,
  type ExportLedgerRow, type ExportOutboxStats, type ShadowDiffKind } from './canonical-shadow.ts';
import { sha256 } from './digest.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import type { SqlEngine } from './model.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { SYNC_IMPORT_PROVENANCE_OP, type SyncImportProvenance } from './sync-holds.ts';

/** What rendered a shadow batch: the export view of export-snapshot.ts under wave 1's equality contract. */
export const SHADOW_RENDERER_FP = 'export-snapshot=1;equality=1';

const DOCS = 'docs/designs/database-canonical-w2-contract.md';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEED_BATCH = 500;

/** The source's checkout and the rules that place and admit its pages; `root` null when it has no readable checkout. */
interface SourceLayout { incarnation: string; root: string | null; mode: SlugRootMode | null; mirror: boolean }

async function sourceLayout(engine: BrainEngine, sourceId: string): Promise<SourceLayout> {
  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null }>('SELECT incarnation::text, local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source) throw new OperationError('unknown_source', `Source ${sourceId} does not exist.`, 'Run gbrain sources list and pass an existing source id.');
  const root = source.local_path && existsSync(source.local_path) ? source.local_path : null;
  if (root) isSourceDbOnlySlug(root, '', 'refuse');
  return { incarnation: source.incarnation, root, mode: root ? await scannerSlugRootMode(engine, sourceId, root) : null, mirror: await sourceMirrorReadOnly(engine, sourceId) };
}

type PathKey = { slug: string; source_path: string | null; source_path_bytes: number };

/** The page's file relative to the checkout (POSIX), or null when its slug or recorded path has no safe file. */
function relativeTarget(layout: SourceLayout, key: PathKey): string | null {
  try { return relative(layout.root!, restoreFilePath(layout.root!, key.slug, key.source_path, Number(key.source_path_bytes), layout.mode!)).split(sep).join('/'); }
  catch (error) { if (error instanceof RestoreTargetError) return null; throw error; }
}

function foldedPath(path: string): string | null {
  try { return exportPathKey(path); } catch { return null; }
}

export interface LedgerSeedReport {
  /** Import provenance records of the source's current incarnation. */
  records: number;
  /** Records carrying each field (the seed needs revision and disk hash). */
  coverage: { revision: number; raw_sha256: number; disk_sha256: number };
  /** Records that cannot be a base: they count as "no base" in the shadow report. */
  no_base: { no_revision: number; no_disk_hash: number };
  /** Records with a base that are not seeded: the page is gone or left the source, its slug has no safe path, two pages fold to one path, or the source has no checkout. */
  skipped: { page_gone: number; unsafe_path: number; path_collision: number; no_checkout: number };
  /** Rows written (apply) or that would be written (preview); `existing` pages already have a live ledger row and keep it. */
  seeded: number;
  existing: number;
}

/**
 * Seeds the export ledger from `SyncImportProvenance` (sync-holds.ts): a record with a revision and a disk SHA-256
 * becomes a `sync_provenance` row at the page's current file path, with `renderer_fp` NULL (imported bytes, never
 * rendered); any other record is "no base". Insert-only and idempotent: a page that already has a live row keeps it.
 * Each batch commits on its own, so seeding a large source holds no long transaction. `apply: false` counts only.
 */
export async function seedExportLedger(engine: BrainEngine, sourceId: string, opts: { apply: boolean }): Promise<LedgerSeedReport> {
  const layout = await sourceLayout(engine, sourceId);
  const report: LedgerSeedReport = { records: 0, coverage: { revision: 0, raw_sha256: 0, disk_sha256: 0 }, no_base: { no_revision: 0, no_disk_hash: 0 },
    skipped: { page_gone: 0, unsafe_path: 0, path_collision: 0, no_checkout: 0 }, seeded: 0, existing: 0 };
  const prefix = `${sourceId}:${layout.incarnation}:`;
  for (let cursor = prefix; ;) {
    const batch = await engine.executeRaw<{ fingerprint: string; record: SyncImportProvenance }>(`SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints
      WHERE op=$1 AND fingerprint > $2 AND left(fingerprint, length($3)) = $3 ORDER BY fingerprint LIMIT ${SEED_BATCH}`, [SYNC_IMPORT_PROVENANCE_OP, cursor, prefix]);
    if (!batch.length) return report;
    cursor = batch[batch.length - 1]!.fingerprint;
    const based: SyncImportProvenance[] = [];
    for (const { record } of batch) {
      report.records++;
      if (record.revision) report.coverage.revision++;
      if (record.raw_sha256) report.coverage.raw_sha256++;
      if (record.disk_sha256) report.coverage.disk_sha256++;
      if (!record.revision || !UUID.test(record.revision)) report.no_base.no_revision++;
      else if (!record.disk_sha256) report.no_base.no_disk_hash++;
      else based.push(record);
    }
    if (!based.length) continue;
    if (!layout.root) { report.skipped.no_checkout += based.length; continue; }
    const pages = new Map((await engine.executeRaw<PathKey & { id: number }>(`SELECT id::int AS id, slug, source_path, octet_length(source_path) AS source_path_bytes
      FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id = ANY($2::int[])`, [sourceId, based.map(r => Number(r.page_id))])).map(p => [Number(p.id), p]));
    const ledger = await readLiveLedgerRows(engine, sourceId, [...pages.keys()]);
    const rows: Array<{ page_id: number; path: string; path_folded: string; revision: string; disk_sha256: string; blob_oid: string | null }> = [];
    const folds = new Set<string>();
    for (const record of based) {
      const page = pages.get(Number(record.page_id));
      if (!page) { report.skipped.page_gone++; continue; }
      if (ledger.has(page.id)) { report.existing++; continue; }
      const path = relativeTarget(layout, page), folded = path ? foldedPath(path) : null;
      if (!path || !folded) { report.skipped.unsafe_path++; continue; }
      if (folds.has(folded)) { report.skipped.path_collision++; continue; }
      folds.add(folded);
      rows.push({ page_id: page.id, path, path_folded: folded, revision: record.revision!, disk_sha256: record.disk_sha256!, blob_oid: record.disk_blob_oid ?? null });
    }
    if (!rows.length) continue;
    if (!opts.apply) {
      const taken = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM export_ledger
        WHERE source_id=$1 AND retired_at IS NULL AND path_folded = ANY($2::text[])`, [sourceId, rows.map(r => r.path_folded)]);
      report.skipped.path_collision += Number(taken[0]?.n ?? 0);
      report.seeded += rows.length - Number(taken[0]?.n ?? 0);
      continue;
    }
    const inserted = await engine.executeRaw<{ page_id: number }>(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, path, path_folded, revision,
        disk_sha256, blob_oid, renderer_fp, seeded_from)
      SELECT $1, $2::uuid, r.page_id, r.path, r.path_folded, r.revision::uuid, r.disk_sha256, r.blob_oid, NULL, 'sync_provenance'
        FROM jsonb_to_recordset($3::text::jsonb) AS r(page_id int, path text, path_folded text, revision text, disk_sha256 text, blob_oid text)
      ON CONFLICT DO NOTHING RETURNING page_id`, [sourceId, layout.incarnation, JSON.stringify(rows)]);
    report.seeded += inserted.length;
    report.skipped.path_collision += rows.length - inserted.length;
  }
}

export interface ShadowDiff {
  page_id: number;
  slug: string;
  path: string | null;
  revision: string | null;
  kind: ShadowDiffKind;
  ledger_revision: string | null;
  disk_sha256: string | null;
  detail: Record<string, unknown>;
}

export interface ShadowBatchReport {
  source_id: string;
  batch_id: string | null;
  outbox_rows: number;
  /** Outbox rows deleted; a row a write upserted while the batch ran stays for the next batch. */
  consumed: number;
  counts: Partial<Record<ShadowDiffKind, number>>;
  adopted: number;
  unexpected: Array<Pick<ShadowDiff, 'slug' | 'path' | 'kind' | 'detail'>>;
}

type PageRow = PathKey & { id: number; source_id: string; deleted: boolean; revision: string; database_only_reason: string | null; segmented: boolean; lineage_private: boolean };

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Drains up to `limit` outbox rows of a source into one shadow batch. Reads in a read-only transaction, asks Git which
 * target paths it ignores (a failed check refuses with `storage_error`, never reads as "nothing ignored"), classifies
 * every page, then in one transaction records the batch, replaces each page's latest diff, adopts the hashes of files
 * equal to their page, and deletes the outbox rows it handled at the seq it read.
 */
export async function drainExportShadow(engine: BrainEngine, sourceId: string, opts: { limit: number }): Promise<ShadowBatchReport> {
  const startedAt = new Date().toISOString();
  const outbox = await readExportOutbox(engine, sourceId, opts.limit);
  const report: ShadowBatchReport = { source_id: sourceId, batch_id: null, outbox_rows: outbox.length, consumed: 0, counts: {}, adopted: 0, unexpected: [] };
  if (!outbox.length) return report;
  const layout = await sourceLayout(engine, sourceId);
  const epoch = (await readSourceCanonicalState(engine, sourceId))?.shadow_epoch ?? 0;
  await readHonorAliases(engine);
  const ids = outbox.map(row => row.page_id);
  const pageRows = await engine.executeRaw<PageRow>(`SELECT pages.id::int AS id, source_id, slug, source_path, octet_length(source_path) AS source_path_bytes,
      deleted_at IS NOT NULL AS deleted, knowledge_revision::text AS revision, database_only_reason, body_storage='segmented' AS segmented,
      NOT ${privatePagesFilterFragment('pages')} AS lineage_private
    FROM pages WHERE pages.id = ANY($1::int[])`, [ids]);
  const pages = new Map(pageRows.filter(p => p.source_id === sourceId && !p.deleted).map(p => [Number(p.id), { ...p, id: Number(p.id) }]));
  const ledger = await readLiveLedgerRows(engine, sourceId, ids);
  const targets = new Map<number, string | null>();
  if (layout.root) for (const page of pages.values()) targets.set(page.id, relativeTarget(layout, page));
  let ignored = new Set<string>();
  if (layout.root) {
    const answer = await ignoredPaths(layout.root, [...targets.values()].filter((p): p is string => p !== null));
    if (!answer) {
      throw new OperationError('storage_error', `Git could not say which paths the checkout at ${layout.root} ignores, so export eligibility is unknown.`,
        `Nothing was recorded and the outbox is unchanged. Check that ${layout.root} is a Git checkout (git -C ${layout.root} status), then rerun gbrain sources canonical ${sourceId} --shadow-drain.`, DOCS);
    }
    ignored = answer;
  }
  const policy: ExportPolicy = { mirror: layout.mirror, dbOnly: slug => layout.root !== null && isSourceDbOnlySlug(layout.root, slug, 'refuse'), ignored };
  const folds = new Map<string, number>();
  for (const [id, path] of targets) { const folded = path ? foldedPath(path) : null; if (folded) folds.set(folded, id); }
  const holders = folds.size ? await engine.executeRaw<{ page_id: number; path_folded: string }>(`SELECT page_id::int AS page_id, path_folded FROM export_ledger
    WHERE source_id=$1 AND retired_at IS NULL AND path_folded = ANY($2::text[])`, [sourceId, [...folds.keys()]]) : [];
  const collided = new Set(holders.filter(h => folds.get(h.path_folded) !== Number(h.page_id)).map(h => folds.get(h.path_folded)!));

  const diffs: ShadowDiff[] = [];
  const adoptions: Array<{ page_id: number; path: string; path_folded: string; revision: string; disk_sha256: string }> = [];
  await engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION READ ONLY');
    const withdrawals = await readExportWithdrawals(tx, sourceId);
    for (const row of outbox) {
      const page = pages.get(row.page_id);
      const base = ledger.get(row.page_id) ?? null;
      const diff = (kind: ShadowDiffKind, path: string | null, extra: { disk_sha256?: string | null; detail?: Record<string, unknown> } = {}) => {
        diffs.push({ page_id: row.page_id, slug: page?.slug ?? row.slug, path, revision: page?.revision ?? null, kind, ledger_revision: base?.revision ?? null,
          disk_sha256: extra.disk_sha256 ?? null, detail: extra.detail ?? {} });
      };
      if (!layout.root) { diff('no_checkout', null); continue; }
      const root = layout.root;
      if (!page) {
        if (!base || !existsSync(join(root, base.path))) { diff('absent', base?.path ?? null); continue; }
        const disk = await fileSha256(join(root, base.path));
        diff(disk === base.disk_sha256 ? 'remove' : 'both_changed', base.path, { disk_sha256: disk, detail: { cause: row.cause } });
        continue;
      }
      const path = targets.get(page.id) ?? null;
      const snapshot = await readExportPage(tx, { id: String(page.id), source_id: sourceId, slug: page.slug }, withdrawals);
      const reason = exportIneligibility({ ...snapshot.page, database_only_reason: page.database_only_reason, lineage_private: page.lineage_private }, path, policy);
      if (reason) {
        const filePath = base?.path ?? path;
        const present = filePath !== null && existsSync(join(root, filePath));
        diff(present && reason !== 'git_ignored' && reason !== 'mirror_source' ? 'ineligible_file' : 'ineligible', filePath, { detail: { reason } });
        continue;
      }
      if (!path) { diff('unsafe_path', null); continue; }
      if (collided.has(page.id)) { diff('path_collision', path); continue; }
      const sameBase: ExportLedgerRow | null = base && base.path === path ? base : null;
      const absolute = join(root, path);
      if (!existsSync(absolute)) { diff(sameBase ? 'file_deleted' : 'create', path); continue; }
      let disk: string, compared;
      if (page.segmented) {
        disk = await fileSha256(absolute);
        compared = await compareSegmentedExportFile(tx, absolute, snapshot, withdrawals);
      } else {
        const bytes = readFileSync(absolute);
        disk = sha256(bytes);
        compared = compareInlineExportFile(bytes, scannerSourcePath(root, absolute, layout.mode!), snapshot);
      }
      if (compared.state === 'unparseable') { diff('unparseable', path, { disk_sha256: disk }); continue; }
      if (compared.state === 'equal') {
        if (sameBase && sameBase.disk_sha256 === disk && sameBase.revision === page.revision) { diff('equal', path, { disk_sha256: disk }); continue; }
        diff('adopt', path, { disk_sha256: disk });
        adoptions.push({ page_id: page.id, path, path_folded: foldedPath(path)!, revision: page.revision, disk_sha256: disk });
        continue;
      }
      const detail = { fields: compared.paths };
      if (!sameBase) diff('unexported_collision', path, { disk_sha256: disk, detail });
      else if (sameBase.disk_sha256 === disk) diff(sameBase.revision === page.revision ? 'render_mismatch' : 'write', path, { disk_sha256: disk, detail });
      else diff(sameBase.revision === page.revision ? 'outside_edit' : 'both_changed', path, { disk_sha256: disk, detail });
    }
  });

  for (const d of diffs) report.counts[d.kind] = (report.counts[d.kind] ?? 0) + 1;
  report.unexpected = diffs.filter(d => !isExpectedShadowDiff(d.kind)).map(({ slug, path, kind, detail }) => ({ slug, path, kind, detail }));
  await engine.transaction(async tx => {
    const [batch] = await tx.executeRaw<{ id: string }>(`INSERT INTO export_shadow_batches(source_id, shadow_epoch, outbox_rows, counts, unexpected, renderer_fp, started_at)
      VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7::timestamptz) RETURNING id::text`,
    [sourceId, epoch, outbox.length, JSON.stringify(report.counts), report.unexpected.length, SHADOW_RENDERER_FP, startedAt]);
    report.batch_id = batch!.id;
    await tx.executeRaw(`INSERT INTO export_shadow_diffs(source_id, page_id, batch_id, slug, path, revision, kind, expected, ledger_revision, disk_sha256, detail)
      SELECT $1, d.page_id, $2::bigint, d.slug, d.path, d.revision::uuid, d.kind, d.expected, d.ledger_revision::uuid, d.disk_sha256, d.detail
        FROM jsonb_to_recordset($3::text::jsonb) AS d(page_id int, slug text, path text, revision text, kind text, expected boolean, ledger_revision text,
          disk_sha256 text, detail jsonb)
      ON CONFLICT (source_id, page_id) DO UPDATE SET batch_id=EXCLUDED.batch_id, slug=EXCLUDED.slug, path=EXCLUDED.path, revision=EXCLUDED.revision,
        kind=EXCLUDED.kind, expected=EXCLUDED.expected, ledger_revision=EXCLUDED.ledger_revision, disk_sha256=EXCLUDED.disk_sha256, detail=EXCLUDED.detail,
        recorded_at=now()`, [sourceId, report.batch_id, JSON.stringify(diffs.map(d => ({ ...d, expected: isExpectedShadowDiff(d.kind) })))]);
    for (const adoption of adoptions) {
      const updated = await tx.executeRaw(`UPDATE export_ledger SET path=$3, path_folded=$4, revision=$5::uuid, disk_sha256=$6, blob_oid=NULL, renderer_fp=NULL,
          seeded_from='shadow_adopt', exported_at=now()
        WHERE source_id=$1 AND page_id=$2 AND retired_at IS NULL RETURNING id`,
      [sourceId, adoption.page_id, adoption.path, adoption.path_folded, adoption.revision, adoption.disk_sha256]);
      const inserted = updated.length ? updated : await tx.executeRaw(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, lifetime, path, path_folded,
          revision, disk_sha256, seeded_from)
        SELECT $1, $2::uuid, $3, COALESCE((SELECT max(lifetime) FROM export_ledger WHERE source_id=$1 AND page_id=$3), 0) + 1, $4, $5, $6::uuid, $7, 'shadow_adopt'
        ON CONFLICT DO NOTHING RETURNING id`,
      [sourceId, layout.incarnation, adoption.page_id, adoption.path, adoption.path_folded, adoption.revision, adoption.disk_sha256]);
      report.adopted += inserted.length;
    }
    report.consumed = await consumeExportOutbox(tx, outbox);
  });
  return report;
}

export interface ShadowStatus {
  source_id: string;
  shadow: boolean;
  shadow_epoch: number;
  outbox: ExportOutboxStats;
  batches: { last_hour: number; last_day: number; last_at: string | null };
  /** Each page's latest diff, counted by kind. */
  diffs: Partial<Record<ShadowDiffKind, number>>;
  unexpected: Partial<Record<ShadowDiffKind, number>>;
  unexpected_sample: Array<{ slug: string; path: string | null; kind: ShadowDiffKind }>;
  ledger: { live: number; by_origin: Record<string, number> };
  /** Live pages with no live ledger row: no base yet. */
  pages_without_base: number;
}

/** Read-only: what doctor and `--shadow-status` report for one source. */
export async function readShadowStatus(exec: SqlEngine, sourceId: string): Promise<ShadowStatus> {
  const state = await readSourceCanonicalState(exec, sourceId);
  const [batches] = await exec.executeRaw<{ hour: number; day: number; last_at: string | null }>(`SELECT
      count(*) FILTER (WHERE finished_at > now() - interval '1 hour')::int AS hour, count(*) FILTER (WHERE finished_at > now() - interval '1 day')::int AS day,
      to_char(max(finished_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_at
    FROM export_shadow_batches WHERE source_id=$1`, [sourceId]);
  const kinds = await exec.executeRaw<{ kind: ShadowDiffKind; expected: boolean; n: number }>(
    'SELECT kind, expected, count(*)::int AS n FROM export_shadow_diffs WHERE source_id=$1 GROUP BY kind, expected ORDER BY kind', [sourceId]);
  const sample = await exec.executeRaw<{ slug: string; path: string | null; kind: ShadowDiffKind }>(
    'SELECT slug, path, kind FROM export_shadow_diffs WHERE source_id=$1 AND NOT expected ORDER BY kind, slug LIMIT 20', [sourceId]);
  const origins = await exec.executeRaw<{ seeded_from: string; n: number }>(
    'SELECT seeded_from, count(*)::int AS n FROM export_ledger WHERE source_id=$1 AND retired_at IS NULL GROUP BY seeded_from ORDER BY seeded_from', [sourceId]);
  const [unbased] = await exec.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM export_ledger l WHERE l.source_id=p.source_id AND l.page_id=p.id AND l.retired_at IS NULL)`, [sourceId]);
  const diffs: ShadowStatus['diffs'] = {}, unexpected: ShadowStatus['unexpected'] = {};
  for (const row of kinds) {
    diffs[row.kind] = Number(row.n);
    if (!row.expected) unexpected[row.kind] = Number(row.n);
  }
  const byOrigin = Object.fromEntries(origins.map(o => [o.seeded_from, Number(o.n)]));
  return { source_id: sourceId, shadow: state?.shadow === true, shadow_epoch: state?.shadow_epoch ?? 0, outbox: await exportOutboxStats(exec, sourceId),
    batches: { last_hour: Number(batches?.hour ?? 0), last_day: Number(batches?.day ?? 0), last_at: batches?.last_at ?? null }, diffs, unexpected,
    unexpected_sample: sample, ledger: { live: Object.values(byOrigin).reduce((a, b) => a + b, 0), by_origin: byOrigin }, pages_without_base: Number(unbased?.n ?? 0) };
}
