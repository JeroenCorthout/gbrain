/**
 * `gbrain sources conflicts <id> list|show|resolve` (database-canonical wave 5b, docs/designs/database-canonical-w5-contract.md).
 * Trusted local CLI. `resolve` is preview-bound: `--dry-run` prints the plan and its `plan_hash` (the conflict id, state,
 * file hash, page revision, page id and lifetime, and the take); the apply needs `--expect <plan_hash>` and refuses
 * `import_conflict_stale` when any of them moved. `--take database` unparks the path and points the ledger base at the stored
 * file so the exporter replaces the file with the render; `--take file` writes the stored bytes into the page (or deletes it)
 * with a revision check under the page row lock.
 */
import { CANONICAL_PROTOCOL_DECLARATION } from '../core/persistence/canonical-mode.ts';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { importFromContent } from '../core/import-file.ts';
import { listSourceConflicts, type SourceConflictDetail } from '../core/ops/source-conflicts.ts';
import { digest } from '../core/persistence/digest.ts';
import { gitRun } from '../core/persistence/export-core.ts';

const USAGE = [
  'gbrain sources conflicts <id> list [--kind <k>] [--json]',
  'gbrain sources conflicts <id> show <conflict-id> [--bytes] [--json]',
  'gbrain sources conflicts <id> resolve <conflict-id> --take file|database (--dry-run | --expect <plan_hash>) [--json]',
].join('\n');

const FILE_TAKE = new Set(['both_changed', 'protected_metadata', 'unexported_collision', 'deleted_vs_edited']);
const DATABASE_TAKE = new Set(['both_changed', 'protected_metadata', 'unexported_collision', 'deleted_vs_edited', 'deleted_uncommitted', 'bulk_delete', 'too_large_for_lane', 'unparseable']);

export interface ConflictsArgs { sourceId: string; action: 'list' | 'show' | 'resolve'; conflictId?: number; kind?: string; bytes: boolean; take?: 'file' | 'database'; dryRun: boolean; expect?: string }

export function parseConflictsArgs(args: string[]): ConflictsArgs {
  const positional: string[] = [];
  let kind: string | undefined, take: string | undefined, expect: string | undefined, dryRun = false, bytes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--bytes') { bytes = true; continue; }
    if (arg === '--kind') { kind = args[++i]; continue; }
    if (arg === '--take') { take = args[++i]; continue; }
    if (arg === '--expect') { expect = args[++i]; continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, USAGE);
    positional.push(arg);
  }
  const [sourceId, action, id] = positional;
  if (!sourceId || !['list', 'show', 'resolve'].includes(action ?? '')) throw opError('invalid_params', 'Name a source and list, show or resolve.', USAGE);
  const conflictId = id === undefined ? undefined : Number(id);
  if (action !== 'list' && (conflictId === undefined || !Number.isInteger(conflictId))) throw opError('invalid_params', `${action} needs a conflict id.`, USAGE);
  if (action === 'resolve') {
    if (take !== 'file' && take !== 'database') throw opError('invalid_params', 'resolve needs --take file or --take database.', USAGE);
    if (!dryRun && !expect) throw opError('invalid_params', 'resolve needs --dry-run, or --expect with the plan_hash a dry run printed.', USAGE);
  }
  return { sourceId, action: action as ConflictsArgs['action'], ...(conflictId !== undefined ? { conflictId } : {}), ...(kind ? { kind } : {}), bytes,
    ...(take ? { take: take as 'file' | 'database' } : {}), dryRun, ...(expect ? { expect } : {}) };
}

const one = async (engine: BrainEngine, o: ConflictsArgs, bytes = false) =>
  (await listSourceConflicts(engine, { scope: {}, sourceId: o.sourceId, conflictId: o.conflictId, remote: false, includeBytes: bytes }))[0]!;

export interface ResolvePlan { conflict_id: number; source_id: string; kind: string; take: 'file' | 'database'; action: string; slug: string | null; path: string; plan_hash: string; apply?: string[] }

function planHash(c: SourceConflictDetail, take: string): string {
  return digest({ id: c.id, state: c.state, file_sha256: c.file_sha256, db_revision: c.db_revision, page_id: c.page_id, lifetime: c.lifetime, take });
}

const stale = (o: ConflictsArgs) => opError('import_conflict_stale', `Conflict ${o.conflictId} of ${o.sourceId} changed since the preview; nothing changed.`,
  `Preview again with gbrain sources conflicts ${o.sourceId} resolve ${o.conflictId} --take ${o.take} --dry-run.`);

async function storedBytes(engine: BrainEngine, c: SourceConflictDetail): Promise<Buffer> {
  if (c.bytes_base64) return Buffer.from(c.bytes_base64, 'base64');
  const [src] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [c.source_id]);
  if (c.file_ref && src?.local_path) {
    const blob = await gitRun(src.local_path, ['cat-file', 'blob', c.file_ref]);
    if (blob.code === 0) return blob.stdout;
  }
  throw opError('conflict_take_unavailable', `The file bytes of conflict ${c.id} are not stored, so the file cannot be taken.`, 'Take the database, or fix the file so the import lane reads it again.');
}

/** Preview (dry run) or apply one resolution. */
export async function resolveConflict(engine: BrainEngine, o: ConflictsArgs): Promise<ResolvePlan> {
  const c = await one(engine, o, true);
  const take = o.take!;
  const allowed = take === 'file' ? FILE_TAKE : DATABASE_TAKE;
  if (!allowed.has(c.kind)) {
    throw opError('conflict_take_unavailable', `--take ${take} is not available for a ${c.kind} conflict.`,
      take === 'file' ? 'Take the database, or fix or commit the file so the import lane decides it again.' : 'This kind waits for a later phase; leave it parked.');
  }
  const action = take === 'database' ? 'unpark; the exporter replaces the file with the database render'
    : c.kind === 'deleted_vs_edited' ? 'soft-delete the page at its current revision' : 'write the stored file into the page at its current revision';
  const hash = planHash(c, take);
  const plan: ResolvePlan = { conflict_id: c.id, source_id: c.source_id, kind: c.kind, take, action, slug: c.slug, path: c.path, plan_hash: hash };
  if (o.dryRun) return { ...plan, apply: ['gbrain', 'sources', 'conflicts', o.sourceId, 'resolve', String(c.id), '--take', take, '--expect', hash] };
  if (o.expect !== hash) throw stale(o);
  const bytes = take === 'file' && c.kind !== 'deleted_vs_edited' ? await storedBytes(engine, c) : null;
  await engine.transaction(async txEngine => {
    const tx = txEngine as BrainEngine;
    await tx.executeRaw(`SELECT ${CANONICAL_PROTOCOL_DECLARATION}`);
    const [row] = await tx.executeRaw<{ state: string; file_sha256: string | null }>('SELECT state, file_sha256 FROM import_conflicts WHERE id=$1 FOR UPDATE', [c.id]);
    if (!row || row.state !== 'open' || row.file_sha256 !== c.file_sha256) throw stale(o);
    if (take === 'database') {
      const ids = c.kind === 'bulk_delete' && c.detail.batch_id
        ? (await tx.executeRaw<{ id: number }>(`SELECT id FROM import_conflicts WHERE source_id=$1 AND state='open' AND kind='bulk_delete' AND detail->>'batch_id'=$2`, [c.source_id, String(c.detail.batch_id)])).map(r => Number(r.id))
        : [c.id];
      for (const id of ids) {
        const [x] = await tx.executeRaw<{ page_id: number | null; path_folded: string; file_sha256: string | null }>('SELECT page_id, path_folded, file_sha256 FROM import_conflicts WHERE id=$1', [id]);
        if (x?.file_sha256) await tx.executeRaw('UPDATE export_ledger SET disk_sha256=$3 WHERE source_id=$1 AND path_folded=$2 AND retired_at IS NULL', [c.source_id, x.path_folded, x.file_sha256]);
        if (x?.page_id !== null && x?.page_id !== undefined) {
          await tx.executeRaw(`INSERT INTO export_outbox(source_id, page_id, slug, revision, cause, first_enqueued_at)
              SELECT p.source_id, p.id, p.slug, p.knowledge_revision, 'written', now() FROM pages p WHERE p.id=$1 AND p.source_id=$2 AND p.deleted_at IS NULL
            ON CONFLICT (source_id, page_id) DO UPDATE SET seq=export_outbox.seq`, [x.page_id, c.source_id]);
        }
        await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='taken_database' WHERE id=$1 AND state='open'`, [id]);
      }
      return;
    }
    const [page] = await tx.executeRaw<{ revision: string; slug: string; deleted: boolean }>('SELECT knowledge_revision::text AS revision, slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE id=$1 FOR UPDATE', [c.page_id]);
    if (!page || page.deleted || page.revision !== c.db_revision) throw stale(o);
    if (c.kind === 'deleted_vs_edited') {
      await tx.softDeletePage(page.slug, { sourceId: c.source_id });
      await tx.executeRaw('UPDATE export_ledger SET retired_at=now() WHERE source_id=$1 AND page_id=$2 AND retired_at IS NULL', [c.source_id, c.page_id]);
    } else {
      const imported = await importFromContent(tx, page.slug, bytes!.toString('utf8'), { sourceId: c.source_id, noEmbed: true, ingested_via: 'gbrain-conflict-resolve' });
      if (imported.status === 'error') throw opError('conflict_take_unavailable', `The stored file of conflict ${c.id} does not import: ${imported.error ?? 'unknown error'}.`, 'Take the database, or fix the file.');
      const [now] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [c.page_id]);
      await tx.executeRaw('UPDATE export_ledger SET revision=$3::uuid, disk_sha256=$4, seeded_from=$5 WHERE source_id=$1 AND page_id=$2 AND retired_at IS NULL',
        [c.source_id, c.page_id, now!.revision, c.file_sha256, 'import_lane']);
    }
    await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='taken_file' WHERE id=$1`, [c.id]);
  });
  return plan;
}

function describe(o: ConflictsArgs, result: unknown): string {
  if (o.action === 'list') {
    const rows = result as SourceConflictDetail[];
    if (!rows.length) return `No open import conflict for ${o.sourceId}.`;
    return rows.map(c => `${c.id}  ${c.kind}  ${c.path}${c.slug ? ` (${c.slug})` : ''}  ${c.age_seconds}s`).join('\n')
      + `\nShow one with gbrain sources conflicts ${o.sourceId} show <conflict-id>; resolve with resolve <conflict-id> --take file|database --dry-run.`;
  }
  if (o.action === 'show') {
    const c = result as SourceConflictDetail;
    return [`Conflict ${c.id} of ${c.source_id}: ${c.kind} at ${c.path}${c.slug ? ` (${c.slug})` : ''}, open ${c.age_seconds}s.`,
      `  page ${c.page_id ?? 'none'} lifetime ${c.lifetime ?? '-'}; base revision ${c.base_revision ?? 'none'}, database revision ${c.db_revision ?? 'none'}`,
      `  file ${c.file_sha256 ?? 'gone'}${c.file_size !== null ? ` (${c.file_size} bytes)` : ''}${c.commit_sha ? ` from commit ${c.commit_sha.slice(0, 12)}` : ''}${c.file_ref ? ` pinned at ${c.file_ref}` : ''}`,
      ...(c.bytes_base64 ? ['  --- stored file ---', Buffer.from(c.bytes_base64, 'base64').toString('utf8')] : [])].join('\n');
  }
  const plan = result as ResolvePlan;
  return o.dryRun ? `Conflict ${plan.conflict_id} (${plan.kind}), --take ${plan.take}: ${plan.action}.\nApply: ${plan.apply!.join(' ')}`
    : `Conflict ${plan.conflict_id} resolved: ${plan.action}.`;
}

export async function runSourcesConflicts(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const o = parseConflictsArgs(args);
    const result = o.action === 'list' ? await listSourceConflicts(engine, { scope: {}, sourceId: o.sourceId, kind: o.kind, remote: false, limit: 200 })
      : o.action === 'show' ? await one(engine, o, o.bytes) : await resolveConflict(engine, o);
    console.log(json ? JSON.stringify(result) : describe(o, result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources conflicts', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}
