/**
 * Database-canonical memory, wave 5a: the exporter (docs/designs/database-canonical-w5-contract.md, "The batch"). For a
 * database-mode source with export commits on, on the source's owner host, one tick drains the export outbox into one batch:
 * render the canonical export view of each page, record the durable manifest, build the commit in a private index, then
 * under the checkout's commit lock (and nothing else) write the files, update the real index and move the branch by
 * compare-and-set. A privacy gate runs after the commit and right before every push; a rejected push fetches, runs the live
 * import lane over the fetched page paths with no lock held, and pushes a merge built on the fetched tip (at most 8 times per
 * claim). Recovery always walks forward from the manifest.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, fsyncSync, openSync, closeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { exportPathKey } from '../export-stage.ts';
import { exportBodyLedger, inlineExportMarkdown, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown, type ExportWithdrawal } from '../export-snapshot.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { RestoreTargetError, restoreFilePath } from '../restore-target.ts';
import { privatePagesFilterFragment, readHonorAliases } from '../search/private-visibility.ts';
import { isSyncable } from '../sync.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { acquireCommitLockAsync, PUBLISH_LOCK_NAME } from '../git/commit-push.ts';
import { acquireNativeLock } from './native-lock.ts';
import { compareInlineExportFile, databaseCanonicalEnabled, exportIneligibility, ignoredPaths, type ExportPolicy } from './canonical-export.ts';
import { consumeExportOutbox, readExportOutbox, readLiveLedgerRows, type ExportOutboxRow } from './canonical-shadow.ts';
import { faultPoint } from './fault-points.ts';
import { localHostId } from './identity.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { buildExportTree, changedPaths, commitExportTree, compareAndSetRef, fetchExportTip, gitRun, isAncestor, mergeExportTrees, pushExportCommit,
  rangePaths, readExportUpstream, readTreeEntries, resolveRev, writeBlob, type ExportTreeEntry, type ExportUpstream } from './export-core.ts';
import { abandonBatchInTx, claimExportBatch, failBatchAttempt, pruneFinishedBatches, readBatchEntries, readExportBinding, readExportMode, readExportSource,
  recordExportSource, releaseBatchClaim, renewBatchClaim, transitionBatch, type ExportBatch, type ExportBatchEntry, type ExportBound,
  type ExportEntryOp, type ExportSkipReason } from './canonical-export-store.ts';
import { applyLiveImport, type LiveImportChange, type LiveImportContext } from './import-lane-live.ts';

/** Paths per batch and rejected pushes per claim (design open question 5; the soak picks the final values). */
export const EXPORT_BATCH_PATHS = 200;
export const EXPORT_MAX_PUSHES = 8;
export const EXPORTER_RENDERER_FP = 'export-v1';

export interface ExportTickOptions {
  hostId?: string;
  signal?: AbortSignal;
  batchPaths?: number;
  /** Push and fetch (default true); false keeps commits local (the PGLite one-shot with no time left). */
  push?: boolean;
  /** Fetch the remote even without outbox rows (an idle tick). */
  fetchIdle?: boolean;
  /** How long to wait for the commit lock. */
  lockWaitMs?: number;
}

export type ExportTickResult =
  | { status: 'skipped'; reason: string }
  | { status: 'idle'; integrated?: boolean; checkout?: 'current' | 'lagging' }
  | { status: 'exported'; batch_id: string; commit: string | null; pushed: boolean; entries: number; skipped: number; checkout: 'current' | 'lagging' }
  | { status: 'failed'; batch_id: string; code: string; parked: boolean }
  | { status: 'contended'; batch_id: string };

/** Everything a tick resolves once about the source and its checkout. */
interface ExportContext {
  engine: BrainEngine;
  sourceId: string;
  hostId: string;
  /** The source's root in the checkout (absolute, real path) and the repository top and the source root's prefix in it. */
  root: string;
  top: string;
  prefix: string;
  upstream: ExportUpstream | null;
  opts: ExportTickOptions;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const posix = (path: string) => path.split(sep).join('/');

async function gitText(dir: string, args: string[]): Promise<string | null> {
  const result = await gitRun(dir, args);
  return result.code === 0 ? result.stdout.toString('utf8').replace(/\n$/, '') : null;
}

async function loadContext(engine: BrainEngine, sourceId: string, hostId: string, opts: ExportTickOptions): Promise<ExportContext | { skip: string }> {
  const binding = await readExportBinding(engine, sourceId, hostId);
  if (!binding?.local_path) return { skip: 'unbound' };
  const sourceRoot = join(binding.local_path, ...binding.relative_path.split('/').filter(Boolean));
  if (!existsSync(sourceRoot)) return { skip: 'no_checkout' };
  const root = realpathSync(sourceRoot);
  const top = await gitText(root, ['rev-parse', '--show-toplevel']);
  if (!top) return { skip: 'no_checkout' };
  const prefix = (await gitText(root, ['rev-parse', '--show-prefix'])) ?? '';
  return { engine, sourceId, hostId, root, top: realpathSync(top), prefix, upstream: await readExportUpstream(top), opts };
}

/** One export tick for a source on this host. Never throws for an expected refusal; returns why it did nothing. */
export async function runExportTick(engine: BrainEngine, sourceId: string, opts: ExportTickOptions = {}): Promise<ExportTickResult> {
  if (!await databaseCanonicalEnabled(engine)) return { status: 'skipped', reason: 'gate_off' };
  const hostId = opts.hostId ?? localHostId();
  const claim = await claimExportBatch(engine as never, sourceId, hostId);
  if (claim.status === 'unavailable') {
    if (claim.reason === 'unbound' || claim.reason === 'no_checkout') await recordExportSource(engine, sourceId, { checkout_state: 'unbound', checkout_reason: claim.reason });
    return { status: 'skipped', reason: claim.reason };
  }
  const ctx = await loadContext(engine, sourceId, hostId, opts);
  if ('skip' in ctx) {
    await recordExportSource(engine, sourceId, { checkout_state: 'unbound', checkout_reason: ctx.skip });
    if (claim.status === 'claimed') await releaseBatchClaim(engine, claim.batch.id, claim.bound.token);
    return { status: 'skipped', reason: ctx.skip };
  }
  if (!ctx.upstream) {
    if (claim.status === 'claimed') await releaseBatchClaim(engine, claim.batch.id, claim.bound.token);
    await recordExportSource(engine, sourceId, { checkout_state: 'unbound', checkout_reason: 'detached_head' });
    return { status: 'skipped', reason: 'detached_head' };
  }
  await ensureSplitIndex(ctx);
  if (claim.status === 'claimed') return driveBatch(ctx, claim.batch, claim.bound);
  const created = await prepareBatch(ctx, claim.bound, claim.mode.eligibility_generation);
  if (created) return driveBatch(ctx, created.batch, created.bound);
  await pruneFinishedBatches(engine, sourceId);
  if (opts.fetchIdle && opts.push !== false && ctx.upstream.remote) return integrateIdle(ctx, claim.bound);
  return { status: 'idle' };
}

/** `core.splitIndex` keeps each index write to the split delta; the `--export-commits on` preview names this change. */
async function ensureSplitIndex(ctx: ExportContext): Promise<void> {
  if ((await gitText(ctx.top, ['config', '--get', 'core.splitIndex'])) === 'true') return;
  await gitRun(ctx.top, ['config', 'core.splitIndex', 'true']);
}

// ── Render and manifest ──────────────────────────────────────────────────────

interface PlannedEntry {
  path: string; path_folded: string; page_id: number | null; lifetime: number | null; op: ExportEntryOp; revision: string | null;
  prior_disk_sha256: string | null; prior_blob_oid: string | null; disk_sha256: string | null; blob_oid: string | null;
  outbox_seq: string | null; first_enqueued_at: string | null; skip_reason: ExportSkipReason | null;
}

interface PageKey { id: string; slug: string; source_id: string; source_path: string | null; source_path_bytes: number; database_only_reason: string | null;
  segmented: boolean; lineage_private: boolean; deleted: boolean; revision: string }

const PAGE_KEY_SQL = `SELECT id::text, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes, database_only_reason,
  body_storage='segmented' AS segmented, NOT ${privatePagesFilterFragment('pages')} AS lineage_private, deleted_at IS NOT NULL AS deleted,
  knowledge_revision::text AS revision FROM pages`;

/** Renders `bytes` of a page's canonical export view (overlaid with fact withdrawals). */
async function renderPage(tx: BrainEngine, key: PageKey, withdrawals: ExportWithdrawal[]): Promise<{ bytes: Buffer; snapshot: Awaited<ReturnType<typeof readExportPage>> }> {
  const snapshot = await readExportPage(tx, key, withdrawals);
  if (!key.segmented) return { bytes: Buffer.from(inlineExportMarkdown(snapshot)), snapshot };
  const parts: Buffer[] = [];
  for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(key.slug, withdrawals), segmentedExportHead(snapshot))) parts.push(Buffer.from(piece));
  return { bytes: Buffer.concat(parts), snapshot };
}

/** The open conflict rows that park paths (one per folded path). */
async function parkedPaths(engine: BrainEngine, sourceId: string): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ path_folded: string }>(`SELECT path_folded FROM import_conflicts WHERE source_id=$1 AND state='open' AND outcome='conflict'`, [sourceId]);
  return new Set(rows.map(r => r.path_folded));
}

/** Paths whose `.gitattributes` assign a filter driver; the exporter never writes them (their bytes would be cleaned or smudged). */
async function filteredPaths(top: string, repoPaths: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!repoPaths.length) return found;
  const result = await gitRun(top, ['check-attr', '-z', '--stdin', 'filter'], { input: repoPaths.map(p => `${p}\0`).join('') });
  if (result.code !== 0) return found;
  const fields = result.stdout.toString('utf8').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) if (!['unspecified', 'unset', ''].includes(fields[i + 2]!)) found.add(fields[i]!);
  return found;
}

async function ledgerByPath(engine: BrainEngine, sourceId: string, folded: string[]): Promise<Map<string, { page_id: number; path: string; disk_sha256: string; blob_oid: string | null; lifetime: number; revision: string }>> {
  if (!folded.length) return new Map();
  const rows = await engine.executeRaw<{ page_id: number; path: string; path_folded: string; disk_sha256: string; blob_oid: string | null; lifetime: number; revision: string }>(
    `SELECT page_id, path, path_folded, disk_sha256, blob_oid, lifetime, revision::text FROM export_ledger WHERE source_id=$1 AND retired_at IS NULL AND path_folded = ANY($2::text[])`,
    [sourceId, folded]);
  return new Map(rows.map(r => [r.path_folded, { ...r, page_id: Number(r.page_id), lifetime: Number(r.lifetime) }]));
}

function readDisk(abs: string): Buffer | null {
  try { return readFileSync(abs); } catch { return null; }
}

/**
 * Renders up to the batch size of outbox rows into planned entries, writes their blobs, and records the manifest in one
 * transaction that re-checks the binding and consumes the outbox rows by seq. Returns null when nothing is pending.
 */
async function prepareBatch(ctx: ExportContext, loose: Omit<ExportBound, 'token'>, generation: number): Promise<{ batch: ExportBatch; bound: ExportBound } | null> {
  const { engine, sourceId, root, top } = ctx;
  const rows = await readExportOutbox(engine, sourceId, ctx.opts.batchPaths ?? EXPORT_BATCH_PATHS);
  if (!rows.length) return null;
  await readHonorAliases(engine);
  const mirror = await sourceMirrorReadOnly(engine, sourceId);
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const parked = await parkedPaths(engine, sourceId);
  const keys = new Map<number, PageKey>();
  for (const row of rows) {
    const [key] = await engine.executeRaw<PageKey>(`${PAGE_KEY_SQL} WHERE id=$1`, [row.page_id]);
    if (key) keys.set(row.page_id, key);
  }
  const ledger = await readLiveLedgerRows(engine, sourceId, rows.map(r => r.page_id));
  const target = (key: PageKey): string | null => {
    try { return posix(relative(root, restoreFilePath(root, key.slug, key.source_path, Number(key.source_path_bytes), mode))); }
    catch (error) { if (error instanceof RestoreTargetError) return null; throw error; }
  };
  const paths = new Map<number, string | null>();
  for (const [id, key] of keys) if (key.source_id === sourceId && !key.deleted) paths.set(id, target(key));
  const candidatePaths = [...paths.values()].filter((p): p is string => !!p);
  const ignored = (await ignoredPaths(root, candidatePaths)) ?? new Set<string>();
  const policy: ExportPolicy = { mirror, dbOnly: slug => isSourceDbOnlySlug(root, slug, 'refuse'), ignored };
  const filtered = await filteredPaths(top, [...candidatePaths, ...[...ledger.values()].map(l => l.path)].map(p => ctx.prefix + p));
  const byPath = await ledgerByPath(engine, sourceId, candidatePaths.map(p => exportPathKey(p)));

  const planned: PlannedEntry[] = [];
  const outsideEdits: string[] = [];
  await engine.transaction(async txEngine => {
    const tx = txEngine as BrainEngine;
    await tx.executeRaw('SET TRANSACTION READ ONLY');
    const withdrawals = await readExportWithdrawals(tx, sourceId);
    for (const row of rows) {
      const key = keys.get(row.page_id);
      const live = ledger.get(row.page_id) ?? null;
      const base = { page_id: row.page_id, outbox_seq: row.seq, first_enqueued_at: row.first_enqueued_at, revision: key?.revision ?? null } as const;
      const remove = (path: string, folded: string, prior: { disk_sha256: string; blob_oid: string | null; lifetime: number }) => {
        const abs = join(root, ...path.split('/'));
        const disk = readDisk(abs);
        if (disk === null) { planned.push({ ...base, path, path_folded: folded, lifetime: prior.lifetime, op: 'remove', prior_disk_sha256: prior.disk_sha256, prior_blob_oid: prior.blob_oid, disk_sha256: null, blob_oid: null, skip_reason: null }); return; }
        const skip: ExportSkipReason | null = parked.has(folded) ? 'parked' : sha256(disk) !== prior.disk_sha256 ? 'outside_edit' : null;
        if (skip === 'outside_edit') outsideEdits.push(path);
        planned.push({ ...base, path, path_folded: folded, lifetime: prior.lifetime, op: 'remove', prior_disk_sha256: prior.disk_sha256, prior_blob_oid: prior.blob_oid, disk_sha256: null, blob_oid: null, skip_reason: skip });
      };
      const gone = !key || key.source_id !== sourceId || key.deleted;
      const path = gone ? null : paths.get(row.page_id) ?? null;
      const reason = gone || !path ? null : exportIneligibility({ ...(await readExportPage(tx, key!, withdrawals)).page, database_only_reason: key!.database_only_reason, lineage_private: key!.lineage_private }, path, policy);
      if (gone || !path || reason) {
        if (live) remove(live.path, live.path_folded, live);
        continue;
      }
      const folded = exportPathKey(path);
      if (live && live.path_folded !== folded) remove(live.path, live.path_folded, live);
      const holder = byPath.get(folded);
      if (holder && holder.page_id !== row.page_id) {
        planned.push({ ...base, path, path_folded: folded, lifetime: null, op: 'write', prior_disk_sha256: holder.disk_sha256, prior_blob_oid: holder.blob_oid, disk_sha256: null, blob_oid: null, skip_reason: 'superseded' });
        continue;
      }
      const prior = live && live.path_folded === folded ? live : null;
      const { bytes, snapshot } = await renderPage(tx, key!, withdrawals);
      const abs = join(root, ...path.split('/'));
      const disk = readDisk(abs);
      const entry: PlannedEntry = { ...base, path, path_folded: folded, lifetime: prior?.lifetime ?? null, op: 'write', prior_disk_sha256: prior?.disk_sha256 ?? null,
        prior_blob_oid: prior?.blob_oid ?? null, disk_sha256: sha256(bytes), blob_oid: null, skip_reason: null };
      if (parked.has(folded)) entry.skip_reason = 'parked';
      else if (filtered.has(ctx.prefix + path)) entry.skip_reason = 'filter_driver';
      else if (disk !== null && (prior ? sha256(disk) !== prior.disk_sha256 : true)) {
        const equal = disk.equals(bytes) || (!key!.segmented && compareInlineExportFile(disk, scannerSourcePath(root, abs, mode), snapshot).state === 'equal');
        if (equal) { entry.op = 'adopt'; entry.prior_disk_sha256 = sha256(disk); entry.disk_sha256 = sha256(disk); }
        else { entry.skip_reason = 'outside_edit'; outsideEdits.push(path); }
      } else if (disk !== null && prior && !disk.equals(bytes) && !key!.segmented && compareInlineExportFile(disk, scannerSourcePath(root, abs, mode), snapshot).state === 'equal') {
        entry.op = 'adopt'; entry.disk_sha256 = prior.disk_sha256;
      } else if (disk !== null && disk.equals(bytes)) entry.op = 'adopt';
      if (!entry.skip_reason && entry.op === 'write') entry.blob_oid = await writeBlob(top, bytes);
      if (entry.op === 'adopt') entry.blob_oid = (await gitText(top, ['hash-object', '--no-filters', '--', abs])) ?? null;
      planned.push(entry);
      pendingBytes.set(folded, bytes);
    }
  });

  const token = randomUUID();
  const bound: ExportBound = { ...loose, token };
  const batchId = randomUUID();
  const created = await engine.transaction(async tx => {
    const now = await readExportMode(tx, sourceId, true);
    const exp = await readExportSource(tx, sourceId);
    if (now.mode !== 'database' || now.mode_epoch !== loose.modeEpoch || !exp?.export_commits || exp.export_epoch !== loose.exportEpoch) return false;
    const [{ incarnation }] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId]);
    const consumed = await consumeExportOutbox(tx, rows);
    if (consumed !== rows.length) {
      const still = new Set((await tx.executeRaw<{ page_id: number }>(`SELECT page_id FROM export_outbox WHERE source_id=$1 AND page_id = ANY($2::int[])`,
        [sourceId, rows.map(r => r.page_id)])).map(r => Number(r.page_id)));
      for (let i = planned.length - 1; i >= 0; i--) if (planned[i]!.page_id !== null && still.has(planned[i]!.page_id!)) planned.splice(i, 1);
    }
    const oldest = rows.filter(r => planned.some(p => p.page_id === r.page_id)).map(r => r.first_enqueued_at).sort()[0] ?? null;
    await tx.executeRaw(`INSERT INTO export_batches(id, source_id, source_incarnation, mode_epoch, export_epoch, eligibility_generation, worktree_id, topology_generation,
        owner_epoch, host_id, state, claim_token, claim_owner, claim_expires_at, attempts, oldest_enqueued_at, renderer_fp)
      SELECT $1::uuid, $2, $3::uuid, $4, $5, $6, b.worktree_id, $7, $8, $9::uuid, 'prepared', $10::uuid, $11::text::jsonb, now() + interval '2 minutes', 1, $12::timestamptz, $13
      FROM persistence_source_bindings b WHERE b.source_id=$2`,
    [batchId, sourceId, incarnation, loose.modeEpoch, loose.exportEpoch, generation, loose.topologyGeneration, loose.ownerEpoch, ctx.hostId, token,
      JSON.stringify({ token, owner: (await import('./claim-phase.ts')).claimOwner() }), oldest, EXPORTER_RENDERER_FP]);
    if (planned.length) {
      await tx.executeRaw(`INSERT INTO export_batch_entries(batch_id, path, path_folded, page_id, lifetime, op, revision, prior_disk_sha256, prior_blob_oid, disk_sha256,
          blob_oid, outbox_seq, first_enqueued_at, state, skip_reason)
        SELECT $1::uuid, e.path, e.path_folded, e.page_id, e.lifetime, e.op, e.revision::uuid, e.prior_disk_sha256, e.prior_blob_oid, e.disk_sha256, e.blob_oid,
          e.outbox_seq::bigint, e.first_enqueued_at::timestamptz, CASE WHEN e.skip_reason IS NULL THEN 'pending' ELSE 'skipped' END, e.skip_reason
        FROM jsonb_to_recordset($2::text::jsonb) AS e(path text, path_folded text, page_id int, lifetime int, op text, revision text, prior_disk_sha256 text,
          prior_blob_oid text, disk_sha256 text, blob_oid text, outbox_seq text, first_enqueued_at text, skip_reason text)
        ON CONFLICT (batch_id, path_folded) DO NOTHING`, [batchId, JSON.stringify(planned)]);
    }
    return true;
  });
  if (!created) { pendingBytes.clear(); return null; }
  await faultPoint('export:prepared', { sourceId });
  if (outsideEdits.length) await handOutsideEdits(ctx, outsideEdits);
  const { readBatch } = await import('./canonical-export-store.ts');
  return { batch: (await readBatch(engine, batchId))!, bound };
}

/** Rendered bytes of the batch being prepared, by folded path, so the commit step writes exactly what the manifest hashed. */
const pendingBytes = new Map<string, Buffer>();

async function handOutsideEdits(ctx: ExportContext, paths: string[]): Promise<void> {
  const changes: LiveImportChange[] = paths.map(path => {
    const bytes = readDisk(join(ctx.root, ...path.split('/')));
    return { path, read: bytes === null ? { state: 'missing', evidence: 'none' } : { state: 'present', bytes }, commit_sha: null };
  });
  await applyLiveImport(liveContext(ctx), changes);
}

function liveContext(ctx: ExportContext): LiveImportContext {
  return { engine: ctx.engine, sourceId: ctx.sourceId, root: ctx.root, top: ctx.top, prefix: ctx.prefix };
}

// ── Drive a held batch ───────────────────────────────────────────────────────

async function driveBatch(ctx: ExportContext, batch: ExportBatch, bound: ExportBound): Promise<ExportTickResult> {
  try {
    let current = batch;
    if (current.state === 'prepared' || current.state === 'built') current = await commitBatch(ctx, current, bound);
    if (current.state === 'committed' || current.state === 'pushed') return await publishBatch(ctx, current, bound);
    return { status: 'idle' };
  } catch (error) {
    if (error instanceof OperationError && error.code === 'write_claim_lost') return { status: 'skipped', reason: 'claim_lost' };
    const code = error instanceof OperationError ? error.code : 'export_failed';
    const message = error instanceof Error ? error.message : String(error);
    const parked = await failBatchAttempt(ctx.engine, batch.id, bound.token, code, message.slice(0, 500));
    await recordExportSource(ctx.engine, ctx.sourceId, { last_error_code: code });
    return { status: 'failed', batch_id: batch.id, code, parked };
  } finally { pendingBytes.clear(); }
}

/** Atomic file write: temp file in the same directory, fsync, rename. */
function writeFileAtomic(abs: string, bytes: Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.gbrain-export-${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'w', 0o644);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, abs);
}

/** The bytes of an entry's blob (recovery reads them back from the object store). */
async function blobBytes(top: string, oid: string): Promise<Buffer> {
  const result = await gitRun(top, ['cat-file', 'blob', oid]);
  if (result.code !== 0) throw opError('git_unavailable', `The rendered blob ${oid} of an export batch is missing from the object store.`,
    'The batch is abandoned and its pages are rendered again by the next batch.');
  return result.stdout;
}

const treeEntriesOf = (ctx: ExportContext, entries: ExportBatchEntry[]): ExportTreeEntry[] =>
  entries.filter(e => e.state !== 'skipped' && e.op !== 'adopt').map(e => ({ path: ctx.prefix + e.path, blob: e.op === 'remove' ? null : e.blob_oid }));

/**
 * Steps 3 and 4: build the commit (no lock), then under the commit lock re-check HEAD and every entry's bytes, write the
 * files, update the real index for exactly those paths and move the branch by compare-and-set. Recovery re-enters here
 * from `prepared` or `built` and finishes forward.
 */
async function commitBatch(ctx: ExportContext, batch: ExportBatch, bound: ExportBound): Promise<ExportBatch> {
  const { engine, top, root } = ctx;
  let entries = await readBatchEntries(engine, batch.id);
  const head = await resolveRev(top, 'HEAD');
  if (batch.state === 'built' && batch.commit_sha && head && (head === batch.commit_sha || await isAncestor(top, batch.commit_sha, head))) {
    return recordCommitted(ctx, batch, bound, batch.commit_sha, entries);
  }
  const message = (n: number) => `gbrain: export ${n} page(s) from ${ctx.sourceId}\n\ngbrain-export-batch: ${batch.id}\n`;
  const build = async (parent: string | null, list: ExportBatchEntry[]) => {
    const tree = await buildExportTree(top, parent, treeEntriesOf(ctx, list), ctx.opts.signal);
    const changed = treeEntriesOf(ctx, list).length;
    return { tree, commit: changed ? await commitExportTree(top, tree, parent ? [parent] : [], message(changed)) : parent };
  };
  let built = await build(head, entries);
  await transitionBatch(engine, batch.id, bound, ['prepared', 'built'], `state='built', parent_commit=$1, tree_oid=$2, commit_sha=$3, built_at=now()`, [head, built.tree, built.commit]);
  await faultPoint('export:built', { sourceId: ctx.sourceId });

  const lock = await acquireCommitLockAsync(top, ctx.opts.lockWaitMs);
  let committed: string | null = null;
  const dropped: Array<{ path_folded: string; path: string }> = [];
  try {
    let now = await resolveRev(top, 'HEAD');
    for (const entry of entries) {
      if (entry.state === 'skipped' || entry.op === 'adopt') continue;
      const disk = readDisk(join(root, ...entry.path.split('/')));
      const hash = disk === null ? null : sha256(disk);
      const ok = hash === entry.prior_disk_sha256 || hash === entry.disk_sha256 || (entry.op === 'write' && hash === null && entry.prior_disk_sha256 === null);
      const okRemove = entry.op === 'remove' && (hash === null || hash === entry.prior_disk_sha256);
      if (entry.op === 'remove' ? !okRemove : !ok) { entry.state = 'skipped'; entry.skip_reason = 'outside_edit'; dropped.push(entry); }
    }
    if (now !== head || dropped.length) built = await build(now, entries);
    if (built.commit && built.commit !== now) {
      for (const entry of entries) {
        if (entry.state === 'skipped' || entry.op === 'adopt') continue;
        const abs = join(root, ...entry.path.split('/'));
        if (entry.op === 'remove') { try { unlinkSync(abs); } catch { /* already gone */ } continue; }
        const bytes = pendingBytes.get(entry.path_folded) ?? await blobBytes(top, entry.blob_oid!);
        if (sha256(bytes) !== entry.disk_sha256) throw opError('git_unavailable', `The bytes of ${entry.path} no longer match the batch manifest.`, 'The batch is retried.');
        writeFileAtomic(abs, bytes);
      }
      await faultPoint('export:files_written', { sourceId: ctx.sourceId });
      const repoPaths = entries.filter(e => e.state !== 'skipped' && e.op !== 'adopt').map(e => ctx.prefix + e.path);
      for (let i = 0; i < repoPaths.length; i += 200) {
        const update = await gitRun(top, ['update-index', '--add', '--remove', '--', ...repoPaths.slice(i, i + 200)]);
        if (update.code !== 0) throw opError('git_unavailable', 'git update-index failed for an export batch.', update.stderr.trim().slice(0, 300));
      }
      await faultPoint('export:index_updated', { sourceId: ctx.sourceId });
      if (!await compareAndSetRef(top, 'HEAD', built.commit, now)) throw opError('git_unavailable', 'The checkout branch moved while an export batch held the commit lock.', 'The batch is retried.');
      await faultPoint('export:ref_updated', { sourceId: ctx.sourceId });
      committed = built.commit;
    } else committed = now;
  } finally { await lock.release(); }
  if (dropped.length) await handOutsideEdits(ctx, dropped.map(d => d.path));
  if (built.commit !== batch.commit_sha || dropped.length) {
    await transitionBatch(engine, batch.id, bound, ['built'], `parent_commit=$1, tree_oid=$2, commit_sha=$3`, [head, built.tree, built.commit]);
    for (const d of dropped) await engine.executeRaw(`UPDATE export_batch_entries SET state='skipped', skip_reason='outside_edit' WHERE batch_id=$1::uuid AND path_folded=$2`, [batch.id, d.path_folded]);
    entries = await readBatchEntries(engine, batch.id);
  }
  return recordCommitted(ctx, batch, bound, committed, entries);
}

/** The ledger rows and `committed` state of a batch whose commit is in the checkout; one transaction. */
async function recordCommitted(ctx: ExportContext, batch: ExportBatch, bound: ExportBound, commit: string | null, entries: ExportBatchEntry[]): Promise<ExportBatch> {
  const { engine, sourceId } = ctx;
  await engine.transaction(async tx => {
    await transitionBatch(tx, batch.id, bound, ['built', 'prepared'], `state='committed', commit_sha=COALESCE($1, commit_sha), committed_at=now()`, [commit]);
    const [{ incarnation }] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId]);
    for (const e of entries) {
      if (e.state === 'skipped' || e.page_id === null) continue;
      if (e.op === 'remove') {
        await tx.executeRaw(`UPDATE export_ledger SET retired_at=now() WHERE source_id=$1 AND path_folded=$2 AND page_id=$3 AND retired_at IS NULL`, [sourceId, e.path_folded, e.page_id]);
        continue;
      }
      const updated = await tx.executeRaw(`UPDATE export_ledger SET revision=$4::uuid, disk_sha256=$5, blob_oid=$6, renderer_fp=$7, commit_sha=COALESCE($8, commit_sha),
          seeded_from='export', exported_at=now() WHERE source_id=$1 AND page_id=$2 AND path_folded=$3 AND retired_at IS NULL RETURNING id`,
        [sourceId, e.page_id, e.path_folded, e.revision, e.disk_sha256, e.blob_oid, e.op === 'adopt' ? null : EXPORTER_RENDERER_FP, commit]);
      if (updated.length) continue;
      await tx.executeRaw(`UPDATE export_ledger SET retired_at=now() WHERE source_id=$1 AND page_id=$2 AND retired_at IS NULL`, [sourceId, e.page_id]);
      await tx.executeRaw(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, lifetime, path, path_folded, revision, disk_sha256, blob_oid, renderer_fp,
          commit_sha, seeded_from)
        SELECT $1, $2::uuid, $3, COALESCE((SELECT max(lifetime) FROM export_ledger WHERE source_id=$1 AND page_id=$3), 0) + 1, $4, $5, $6::uuid, $7, $8, $9, $10, 'export'`,
        [sourceId, incarnation, e.page_id, e.path, e.path_folded, e.revision, e.disk_sha256, e.blob_oid, e.op === 'adopt' ? null : EXPORTER_RENDERER_FP, commit]);
    }
    await tx.executeRaw(`UPDATE export_batch_entries SET state='committed' WHERE batch_id=$1::uuid AND state='pending'`, [batch.id]);
    if (commit) await recordExportSource(tx, sourceId, { committed_commit: commit, last_error_code: null });
  });
  await faultPoint('export:committed', { sourceId });
  return { ...batch, state: 'committed', commit_sha: commit ?? batch.commit_sha };
}

// ── Privacy gate, push and integrate ─────────────────────────────────────────

/**
 * Step 5: every page path a push would publish (each commit in `remoteTip..candidate`), checked against the pages'
 * eligibility now. Returns the source-relative paths whose page may no longer be published.
 */
async function ineligiblePaths(ctx: ExportContext, remoteTip: string | null, candidate: string): Promise<string[]> {
  const { engine, sourceId, root, top, prefix } = ctx;
  const touched = (await rangePaths(top, remoteTip, candidate)).filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
  if (!touched.length) return [];
  const folded = touched.map(p => { try { return exportPathKey(p); } catch { return null; } });
  const rows = await engine.executeRaw<{ path_folded: string; page_id: number }>(`SELECT DISTINCT ON (path_folded) path_folded, page_id FROM export_ledger
    WHERE source_id=$1 AND path_folded = ANY($2::text[]) ORDER BY path_folded, id DESC`, [sourceId, folded.filter(Boolean)]);
  if (!rows.length) return [];
  await readHonorAliases(engine);
  const mirror = await sourceMirrorReadOnly(engine, sourceId);
  const policy: ExportPolicy = { mirror, dbOnly: slug => isSourceDbOnlySlug(root, slug, 'refuse'), ignored: new Set() };
  const bad: string[] = [];
  await engine.transaction(async txEngine => {
    const tx = txEngine as BrainEngine;
    await tx.executeRaw('SET TRANSACTION READ ONLY');
    const withdrawals = await readExportWithdrawals(tx, sourceId);
    for (const row of rows) {
      const [key] = await tx.executeRaw<PageKey>(`${PAGE_KEY_SQL} WHERE id=$1`, [row.page_id]);
      if (!key || key.deleted || key.source_id !== sourceId) continue;
      const snapshot = await readExportPage(tx, key, withdrawals).catch(() => null);
      const reason = exportIneligibility({ ...(snapshot?.page ?? { slug: key.slug }), database_only_reason: key.database_only_reason, lineage_private: key.lineage_private }, null, policy);
      if (reason) bad.push(touched[folded.indexOf(row.path_folded)]!);
    }
  });
  return bad;
}

/**
 * Replaces the unpushed range with one commit on the remote tip that leaves out the ineligible paths, moves the branch to it
 * under the commit lock (compare-and-set from the candidate) and retires their ledger rows. Returns the new candidate, or
 * null when HEAD moved meanwhile (the next tick tries again).
 */
async function rewriteForPrivacy(ctx: ExportContext, batch: ExportBatch, bound: ExportBound, remoteTip: string | null, candidate: string, bad: string[]): Promise<string | null> {
  const { engine, top, root, prefix, sourceId } = ctx;
  const squashed = (await gitText(top, ['log', '--format=%H %s', remoteTip ? `${remoteTip}..${candidate}` : candidate])) ?? '';
  const tree = await buildExportTree(top, candidate, bad.map(p => ({ path: prefix + p, blob: null })));
  const body = squashed.split('\n').filter(Boolean).slice(0, 200).map(l => `gbrain-squashed: ${l}`).join('\n');
  const replacement = await commitExportTree(top, tree, remoteTip ? [remoteTip] : [],
    `gbrain: export from ${sourceId} without ${bad.length} page(s) that may no longer be published\n\n${body}\n\ngbrain-export-batch: ${batch.id}\n`);
  const lock = await acquireCommitLockAsync(top, ctx.opts.lockWaitMs);
  try {
    if ((await resolveRev(top, 'HEAD')) !== candidate) return null;
    const read = await gitRun(top, ['read-tree', '-m', '-u', candidate, replacement]);
    if (read.code !== 0) return null;
    if (!await compareAndSetRef(top, 'HEAD', replacement, candidate)) return null;
  } finally { await lock.release(); }
  for (const p of bad) if (existsSync(join(root, ...p.split('/')))) { try { unlinkSync(join(root, ...p.split('/'))); } catch { /* best effort */ } }
  await engine.transaction(async tx => {
    await transitionBatch(tx, batch.id, bound, ['committed'], `commit_sha=$1, detail=detail || jsonb_build_object('privacy_rewrite', $2::int)`, [replacement, bad.length]);
    await tx.executeRaw(`UPDATE export_ledger SET retired_at=now() WHERE source_id=$1 AND path_folded = ANY($2::text[]) AND retired_at IS NULL`, [sourceId, bad.map(p => exportPathKey(p))]);
    await recordExportSource(tx, sourceId, { committed_commit: replacement });
  });
  return replacement;
}

async function publishLock(top: string) {
  const path = await gitText(top, ['rev-parse', '--path-format=absolute', '--git-path', PUBLISH_LOCK_NAME]);
  return acquireNativeLock(path!, { timeoutMs: 60_000 });
}

/**
 * Steps 5 to 7: the privacy gate, the push under the publish lock, and on a rejection fetch, lane, merge on the tip and push
 * again, at most `EXPORT_MAX_PUSHES` times per claim; then fast-forward the checkout under the commit lock.
 */
async function publishBatch(ctx: ExportContext, batch: ExportBatch, bound: ExportBound): Promise<ExportTickResult> {
  const { engine, top, sourceId } = ctx;
  const upstream = ctx.upstream!;
  const entries = await readBatchEntries(engine, batch.id);
  const counts = { entries: entries.filter(e => e.state === 'committed').length, skipped: entries.filter(e => e.state === 'skipped').length };
  if (batch.state === 'pushed') return complete(ctx, batch, bound, batch.pushed_commit, counts, 'current');
  let candidate = batch.commit_sha ?? await resolveRev(top, 'HEAD');
  if (!candidate) return complete(ctx, batch, bound, null, counts, 'current');
  if (!upstream.remote || ctx.opts.push === false) return complete(ctx, batch, bound, null, counts, 'current', true);
  let tip = upstream.trackingRef ? await resolveRev(top, upstream.trackingRef) : null;
  let builtFrom = candidate;
  for (let attempt = 0; attempt < EXPORT_MAX_PUSHES; attempt++) {
    await renewBatchClaim(engine, batch.id, bound);
    await faultPoint('export:before_push', { sourceId });
    const bad = await ineligiblePaths(ctx, tip && await isAncestor(top, tip, candidate) ? tip : null, candidate);
    if (bad.length) {
      const replaced = await rewriteForPrivacy(ctx, batch, bound, tip, candidate, bad);
      if (!replaced) { await releaseBatchClaim(engine, batch.id, bound.token); return { status: 'contended', batch_id: batch.id }; }
      candidate = replaced;
      builtFrom = replaced;
    }
    const lock = await publishLock(top);
    if (!lock) { await releaseBatchClaim(engine, batch.id, bound.token); return { status: 'contended', batch_id: batch.id }; }
    let outcome;
    try { outcome = await pushExportCommit(top, upstream.remote, candidate, upstream.mergeRef!, { signal: ctx.opts.signal }); }
    finally { await lock.release(); }
    if (outcome.status === 'pushed') {
      await faultPoint('export:pushed', { sourceId });
      await transitionBatch(engine, batch.id, bound, ['committed'], `state='pushed', pushed_commit=$1, pushed_at=now(), push_attempts=push_attempts+1`, [candidate]);
      if (upstream.trackingRef) await gitRun(top, ['update-ref', upstream.trackingRef, candidate]);
      const checkout = await fastForward(ctx, candidate, builtFrom);
      return complete(ctx, batch, bound, candidate, counts, checkout);
    }
    if (outcome.status === 'failed') throw opError('git_push_unavailable', 'The export commit is durable locally; its push will retry.',
      `git push to ${upstream.remote} failed (network, credentials or a remote that refused it): ${outcome.stderr || 'no detail'}. Nothing is lost locally; the exporter pushes again on a later tick.`);
    await transitionBatch(engine, batch.id, bound, ['committed'], 'push_attempts=push_attempts+1');
    const fetched = await fetchExportTip(top, upstream.remote, upstream.mergeRef!, upstream.trackingRef!, { signal: ctx.opts.signal });
    if (!fetched) throw opError('git_push_unavailable', 'The remote moved and fetching it failed; the export commit stays local.', 'The exporter fetches again on a later tick.');
    await faultPoint('export:fetched', { sourceId });
    tip = fetched;
    await recordExportSource(engine, sourceId, { remote_tip: tip });
    const merged = await integrate(ctx, batch.id, candidate, tip);
    await faultPoint('export:laned', { sourceId });
    candidate = merged;
    await transitionBatch(engine, batch.id, bound, ['committed'], `commit_sha=$1, remote_tip=$2`, [candidate, tip]);
  }
  await releaseBatchClaim(engine, batch.id, bound.token, 'export_push_contended');
  return { status: 'contended', batch_id: batch.id };
}

/**
 * A merge of `tip` into `candidate`: non-page paths merged in memory (a two-sided change to a non-page file is the only
 * `integrate_conflict` here), every page path the fetched commits changed taken from the tip after the live lane classified
 * it (imported, adopted, or parked as a conflict). A page path both the unpushed range and the remote changed is a
 * `both_changed` conflict: the database moved since the shared base and so did the file.
 */
async function integrate(ctx: ExportContext, batchId: string | null, candidate: string, tip: string): Promise<string> {
  const { top, prefix, sourceId } = ctx;
  if (await isAncestor(top, tip, candidate)) return candidate;
  const base = (await gitText(top, ['merge-base', candidate, tip])) ?? null;
  const remoteChanged = base ? await changedPaths(top, base, tip) : [];
  const localChanged = new Set(base ? await changedPaths(top, base, candidate) : []);
  const pagePath = (p: string) => p.startsWith(prefix) && isSyncable(p.slice(prefix.length));
  const remotePages = remoteChanged.filter(pagePath);
  const tipEntries = await readTreeEntries(top, tip, remotePages);
  const changes: LiveImportChange[] = [];
  for (const repoPath of remotePages) {
    const entry = tipEntries.get(repoPath);
    const read: LiveImportChange['read'] = entry ? { state: 'present', bytes: await blobBytes(top, entry.oid) } : { state: 'missing', evidence: 'removed_by_commit' };
    changes.push({ path: repoPath.slice(prefix.length), read, commit_sha: tip, bothChanged: localChanged.has(repoPath) });
  }
  if (changes.length) await applyLiveImport(liveContext(ctx), changes);
  const merged = await mergeExportTrees(top, candidate, tip);
  const nonPage = merged.conflicts.filter(p => !pagePath(p));
  if (nonPage.length) throw opError('integrate_conflict', `This machine and the remote both changed ${nonPage.length} file(s) outside the source's pages; nothing was merged.`,
    `Resolve ${nonPage.join(', ')} with gbrain git commit-push --push-only --expect-remote ${tip} --resolve <path>=ours|theirs, then the exporter pushes on its next tick.`,
    { detail: JSON.stringify({ local: candidate, remote: tip, paths: nonPage }) });
  const overrides: ExportTreeEntry[] = remotePages.map(p => ({ path: p, blob: tipEntries.get(p)?.oid ?? null }));
  for (const p of merged.conflicts.filter(pagePath)) if (!remotePages.includes(p)) overrides.push({ path: p, blob: tipEntries.get(p)?.oid ?? null });
  const tree = await buildExportTree(top, merged.tree, overrides);
  return commitExportTree(top, tree, [candidate, tip], `gbrain: merge ${ctx.upstream!.remote}/${ctx.upstream!.mergeRef!.replace(/^refs\/heads\//, '')} into export of ${sourceId}\n${batchId ? `\ngbrain-export-batch: ${batchId}\n` : ''}`);
}

/**
 * Fast-forwards the branch and worktree from `built` (the checkout commit the pushed candidate was built from) to `pushed`
 * under the commit lock. Inside the lock HEAD and the branch ref are read again and both must still be `built`; if either
 * moved (an operator commit, another fast-forward), nothing changes and the checkout is `lagging` until the next tick merges
 * again from the new HEAD.
 */
async function fastForward(ctx: ExportContext, pushed: string, built: string): Promise<'current' | 'lagging'> {
  const { top, engine, sourceId } = ctx;
  const upstream = ctx.upstream!;
  if (built === pushed) {
    await recordExportSource(engine, sourceId, { checkout_state: 'current', checkout_reason: null });
    return 'current';
  }
  const lock = await acquireCommitLockAsync(top, ctx.opts.lockWaitMs);
  try {
    const head = await resolveRev(top, 'HEAD');
    const branch = await resolveRev(top, upstream.branchRef);
    if (head !== built || branch !== built) return await lag(ctx, 'moved');
    const read = await gitRun(top, ['read-tree', '-m', '-u', built, pushed]);
    if (read.code !== 0) return await lag(ctx, 'local_edits');
    if (!await compareAndSetRef(top, upstream.branchRef, pushed, built)) {
      await gitRun(top, ['read-tree', '-m', '-u', pushed, built]);
      return await lag(ctx, 'moved');
    }
  } finally { await lock.release(); }
  await faultPoint('export:fast_forwarded', { sourceId });
  await recordExportSource(engine, sourceId, { checkout_state: 'current', checkout_reason: null });
  return 'current';
}

async function lag(ctx: ExportContext, reason: string): Promise<'lagging'> {
  await recordExportSource(ctx.engine, ctx.sourceId, { checkout_state: 'lagging', checkout_reason: reason });
  return 'lagging';
}

async function complete(ctx: ExportContext, batch: ExportBatch, bound: ExportBound, pushed: string | null, counts: { entries: number; skipped: number },
  checkout: 'current' | 'lagging', local = false): Promise<ExportTickResult> {
  await ctx.engine.transaction(async tx => {
    await transitionBatch(tx, batch.id, bound, ['committed', 'pushed'], `state='completed', completed_at=now(), claim_token=claim_token, error_code=NULL,
      detail=detail || jsonb_build_object('push', $1::text)`, [pushed ? 'pushed' : local ? 'local_only' : 'nothing']);
    await tx.executeRaw(`UPDATE export_batches SET claim_token=NULL, claim_owner=NULL, claim_expires_at=NULL WHERE id=$1::uuid`, [batch.id]);
    if (pushed) await recordExportSource(tx, ctx.sourceId, { pushed_commit: pushed, last_error_code: null });
    if (checkout === 'current') await recordExportSource(tx, ctx.sourceId, { checkout_state: 'current', checkout_reason: null });
  });
  return { status: 'exported', batch_id: batch.id, commit: batch.commit_sha ?? pushed, pushed: !!pushed, ...counts, checkout };
}

/**
 * Page paths that local commits not yet on the remote changed (an operator's commit in the owner checkout), handed to the
 * live lane at their committed bytes before they are pushed. The exporter's own commits are no-ops there: their bytes equal
 * the ledger's.
 */
async function laneLocalCommits(ctx: ExportContext, tip: string, head: string): Promise<void> {
  const { top, prefix } = ctx;
  const base = (await gitText(top, ['merge-base', tip, head])) ?? null;
  if (!base) return;
  const pages = (await changedPaths(top, base, head)).filter(p => p.startsWith(prefix) && isSyncable(p.slice(prefix.length)));
  if (!pages.length) return;
  const entries = await readTreeEntries(top, head, pages);
  const changes: LiveImportChange[] = [];
  for (const p of pages) {
    const entry = entries.get(p);
    changes.push({ path: p.slice(prefix.length), read: entry ? { state: 'present', bytes: await blobBytes(top, entry.oid) } : { state: 'missing', evidence: 'removed_by_commit' }, commit_sha: head });
  }
  await applyLiveImport(liveContext(ctx), changes);
}

/**
 * An idle tick: fetch the remote, lane the page paths the fetched commits changed, and bring the checkout and the remote
 * together: a fast-forward when the checkout has nothing unpushed, a push when only the checkout moved (an operator's
 * non-page commit whose own publish deferred to the exporter), and otherwise a merge built like step 7, pushed, then
 * fast-forwarded. The exporter is the only process that moves a database-mode source's checkout.
 */
async function integrateIdle(ctx: ExportContext, loose: Omit<ExportBound, 'token'>): Promise<ExportTickResult> {
  const { top, engine, sourceId } = ctx;
  const upstream = ctx.upstream!;
  const tip = await fetchExportTip(top, upstream.remote!, upstream.mergeRef!, upstream.trackingRef!, { signal: ctx.opts.signal });
  if (!tip) return { status: 'idle' };
  await recordExportSource(engine, sourceId, { remote_tip: tip });
  const head = await resolveRev(top, 'HEAD');
  if (!head || head === tip) {
    await recordExportSource(engine, sourceId, { laned_through: tip, import_pending_since: null, checkout_state: 'current', checkout_reason: null });
    return { status: 'idle', integrated: false, checkout: 'current' };
  }
  await laneLocalCommits(ctx, tip, head);
  let candidate = head;
  if (!await isAncestor(top, tip, head)) candidate = await integrate(ctx, null, head, tip);
  await recordExportSource(engine, sourceId, { laned_through: tip, import_pending_since: null });
  if (candidate !== tip) {
    const lock = await publishLock(top);
    if (!lock) return { status: 'idle', integrated: false };
    let outcome;
    try { outcome = await pushExportCommit(top, upstream.remote!, candidate, upstream.mergeRef!, { signal: ctx.opts.signal }); }
    finally { await lock.release(); }
    if (outcome.status !== 'pushed') return { status: 'idle', integrated: false, checkout: await lag(ctx, outcome.status === 'rejected' ? 'remote_moved' : 'push_failed') };
    await gitRun(top, ['update-ref', upstream.trackingRef!, candidate]);
    await recordExportSource(engine, sourceId, { pushed_commit: candidate });
  }
  void loose;
  return { status: 'idle', integrated: true, checkout: await fastForward(ctx, candidate, head) };
}
