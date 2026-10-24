/**
 * Database-canonical memory, wave 5a: the exporter's store (docs/designs/database-canonical-w5-contract.md). The per-source
 * export switch, the source's mode and binding as the exporter sees them, and the batch queue: claims, compare-and-set
 * transitions, backoff and parking. Plain SQL over `SqlEngine` like the rest of persistence/; no row is ever written to
 * `persistence_requests` or `persistence_effects`.
 */
import { randomUUID } from 'node:crypto';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { claimOwner, claimOwnerProvablyDead } from './claim-phase.ts';
import type { SqlEngine } from './model.ts';
import { refreshFenceClear } from './worktree-refresh-schema.ts';
import { UNFINISHED_EXPORT_BATCH_STATES_SQL, type EXPORT_BATCH_STATES, type EXPORT_CHECKOUT_STATES, type EXPORT_ENTRY_OPS,
  type EXPORT_ENTRY_STATES, type EXPORT_ONESHOT_OUTCOMES, type EXPORT_SKIP_REASONS } from './canonical-export-schema.ts';

export type ExportBatchState = typeof EXPORT_BATCH_STATES[number];
export type ExportEntryOp = typeof EXPORT_ENTRY_OPS[number];
export type ExportEntryState = typeof EXPORT_ENTRY_STATES[number];
export type ExportSkipReason = typeof EXPORT_SKIP_REASONS[number];
export type ExportCheckoutState = typeof EXPORT_CHECKOUT_STATES[number];
export type ExportOneshotOutcome = typeof EXPORT_ONESHOT_OUTCOMES[number];

/** Consecutive failed claims after which a batch parks until `--export-retry`. */
export const EXPORT_MAX_ATTEMPTS = 8;
/** The batch lease, renewed between steps. */
export const EXPORT_CLAIM_LEASE_SECONDS = 120;

const ISO = (column: string, alias = column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${alias}`;

export interface ExportSourceState {
  source_id: string;
  export_commits: boolean;
  export_epoch: number;
  committed_commit: string | null;
  pushed_commit: string | null;
  remote_tip: string | null;
  laned_through: string | null;
  checkout_state: ExportCheckoutState;
  checkout_reason: string | null;
  oneshot_outcome: ExportOneshotOutcome | null;
  oneshot_at: string | null;
  last_error_code: string | null;
}

export async function readExportSource(exec: SqlEngine, sourceId: string): Promise<ExportSourceState | null> {
  const [row] = await exec.executeRaw<ExportSourceState>(`SELECT source_id, export_commits, export_epoch::int AS export_epoch, committed_commit,
      pushed_commit, remote_tip, laned_through, checkout_state, checkout_reason, oneshot_outcome, ${ISO('oneshot_at')}, last_error_code
    FROM canonical_export_sources WHERE source_id=$1`, [sourceId]);
  return row ? { ...row, export_epoch: Number(row.export_epoch) } : null;
}

/** The mode wave 4 records for a source (`files` at epoch 0 without a row). */
export interface ExportModeState { mode: 'files' | 'database'; mode_epoch: number; eligibility_generation: number }

export async function readExportMode(exec: SqlEngine, sourceId: string, lock = false): Promise<ExportModeState> {
  const [row] = await exec.executeRaw<{ mode: string; mode_epoch: number; eligibility_generation: number }>(`SELECT mode, mode_epoch::int AS mode_epoch,
      eligibility_generation::int AS eligibility_generation FROM database_canonical_sources WHERE source_id=$1${lock ? ' FOR SHARE' : ''}`, [sourceId]);
  if (!row) return { mode: 'files', mode_epoch: 0, eligibility_generation: 0 };
  return { mode: row.mode === 'database' ? 'database' : 'files', mode_epoch: Number(row.mode_epoch), eligibility_generation: Number(row.eligibility_generation) };
}

/** Sources that export: in database mode with export commits on. */
export async function listExportingSources(exec: SqlEngine): Promise<string[]> {
  const rows = await exec.executeRaw<{ source_id: string }>(`SELECT e.source_id FROM canonical_export_sources e
    JOIN database_canonical_sources d ON d.source_id=e.source_id WHERE e.export_commits AND d.mode='database' ORDER BY e.source_id`);
  return rows.map(r => r.source_id);
}

/** Sets the export switch and advances its epoch. Callers hold the source row lock. */
export async function writeExportSwitch(tx: SqlEngine, sourceId: string, on: boolean): Promise<ExportSourceState> {
  await tx.executeRaw(`INSERT INTO canonical_export_sources(source_id, source_incarnation, export_commits, export_epoch)
      SELECT id, incarnation, $2, 1 FROM sources WHERE id=$1
    ON CONFLICT (source_id) DO UPDATE SET export_commits=EXCLUDED.export_commits, source_incarnation=EXCLUDED.source_incarnation,
      export_epoch=canonical_export_sources.export_epoch+1, export_changed_at=now()`, [sourceId, on]);
  return (await readExportSource(tx, sourceId))!;
}

export async function recordExportSource(exec: SqlEngine, sourceId: string, patch: Partial<{ checkout_state: ExportCheckoutState; checkout_reason: string | null;
  oneshot_outcome: ExportOneshotOutcome; last_error_code: string | null; committed_commit: string; pushed_commit: string; remote_tip: string; laned_through: string;
  import_pending_since: 'now' | null }>): Promise<void> {
  const sets: string[] = [], params: unknown[] = [sourceId];
  const put = (sql: string, value: unknown) => { params.push(value); sets.push(sql.replace('?', `$${params.length}`)); };
  if (patch.checkout_state !== undefined) put('checkout_state=?', patch.checkout_state);
  if (patch.checkout_reason !== undefined) put('checkout_reason=?', patch.checkout_reason);
  if (patch.oneshot_outcome !== undefined) { put('oneshot_outcome=?', patch.oneshot_outcome); sets.push('oneshot_at=now()'); }
  if (patch.last_error_code !== undefined) { put('last_error_code=?', patch.last_error_code); sets.push(patch.last_error_code ? 'last_error_at=now()' : 'last_error_at=NULL'); }
  if (patch.committed_commit !== undefined) { put('committed_commit=?', patch.committed_commit); sets.push('committed_at=now()'); }
  if (patch.pushed_commit !== undefined) { put('pushed_commit=?', patch.pushed_commit); sets.push('pushed_at=now()'); }
  if (patch.remote_tip !== undefined) {
    params.push(patch.remote_tip);
    sets.push(`remote_tip_seen_at=CASE WHEN remote_tip IS DISTINCT FROM $${params.length}::text THEN now() ELSE remote_tip_seen_at END`, `remote_tip=$${params.length}::text`);
  }
  if (patch.laned_through !== undefined) put('laned_through=?', patch.laned_through);
  if (patch.import_pending_since !== undefined) sets.push(patch.import_pending_since ? 'import_pending_since=COALESCE(import_pending_since, now())' : 'import_pending_since=NULL');
  if (!sets.length) return;
  await exec.executeRaw(`UPDATE canonical_export_sources SET ${sets.join(', ')} WHERE source_id=$1`, params);
}

/** The binding the exporter needs on this host: the source's worktree, its owner and this host's checkout path. */
export interface ExportBinding {
  worktree_id: string;
  topology_generation: number;
  relative_path: string;
  owner_host_id: string | null;
  owner_epoch: number;
  worktree_state: string;
  local_path: string | null;
  fenced: boolean;
  recovering: boolean;
}

export async function readExportBinding(exec: SqlEngine, sourceId: string, hostId: string): Promise<ExportBinding | null> {
  const [row] = await exec.executeRaw<ExportBinding>(`SELECT b.worktree_id::text, b.topology_generation::int AS topology_generation, b.relative_path,
      w.owner_host_id::text, w.owner_epoch::int AS owner_epoch, w.state AS worktree_state, h.local_path,
      NOT (${refreshFenceClear('b')}) AS fenced,
      (EXISTS (SELECT 1 FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.worktree_id=b.worktree_id AND e.recovery IS NOT NULL)) AS recovering
    FROM persistence_source_bindings b JOIN persistence_worktrees w ON w.id=b.worktree_id
    LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid
    WHERE b.source_id=$1`, [sourceId, hostId]);
  return row ? { ...row, topology_generation: Number(row.topology_generation), owner_epoch: Number(row.owner_epoch) } : null;
}

export interface ExportBatch {
  id: string;
  source_id: string;
  source_incarnation: string;
  mode_epoch: number;
  export_epoch: number;
  eligibility_generation: number;
  target: 'worktree' | 'bare';
  worktree_id: string | null;
  topology_generation: number | null;
  owner_epoch: number | null;
  state: ExportBatchState;
  claim_token: string | null;
  attempts: number;
  parked_at: string | null;
  parent_commit: string | null;
  tree_oid: string | null;
  commit_sha: string | null;
  pushed_commit: string | null;
  remote_tip: string | null;
  push_attempts: number;
  oldest_enqueued_at: string | null;
  error_code: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

const BATCH_COLUMNS = `id::text, source_id, source_incarnation::text, mode_epoch::int AS mode_epoch, export_epoch::int AS export_epoch,
  eligibility_generation::int AS eligibility_generation, target, worktree_id::text, topology_generation::int AS topology_generation,
  owner_epoch::int AS owner_epoch, state, claim_token::text, attempts, ${ISO('parked_at')}, parent_commit, tree_oid, commit_sha, pushed_commit, remote_tip,
  push_attempts, ${ISO('oldest_enqueued_at')}, error_code, detail, ${ISO('created_at')}`;

const batchRow = (row: ExportBatch): ExportBatch => ({ ...row, mode_epoch: Number(row.mode_epoch), export_epoch: Number(row.export_epoch),
  eligibility_generation: Number(row.eligibility_generation), topology_generation: row.topology_generation === null ? null : Number(row.topology_generation),
  owner_epoch: row.owner_epoch === null ? null : Number(row.owner_epoch), attempts: Number(row.attempts), push_attempts: Number(row.push_attempts),
  detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail ?? {} });

export async function readUnfinishedBatch(exec: SqlEngine, sourceId: string): Promise<ExportBatch | null> {
  const [row] = await exec.executeRaw<ExportBatch>(`SELECT ${BATCH_COLUMNS} FROM export_batches WHERE source_id=$1 AND state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL}`, [sourceId]);
  return row ? batchRow(row) : null;
}

export async function readBatch(exec: SqlEngine, batchId: string): Promise<ExportBatch | null> {
  const [row] = await exec.executeRaw<ExportBatch>(`SELECT ${BATCH_COLUMNS} FROM export_batches WHERE id=$1::uuid`, [batchId]);
  return row ? batchRow(row) : null;
}

export interface ExportBatchEntry {
  path: string;
  path_folded: string;
  page_id: number | null;
  lifetime: number | null;
  op: ExportEntryOp;
  revision: string | null;
  prior_disk_sha256: string | null;
  prior_blob_oid: string | null;
  disk_sha256: string | null;
  blob_oid: string | null;
  outbox_seq: string | null;
  first_enqueued_at: string | null;
  state: ExportEntryState;
  skip_reason: ExportSkipReason | null;
}

export async function readBatchEntries(exec: SqlEngine, batchId: string): Promise<ExportBatchEntry[]> {
  const rows = await exec.executeRaw<ExportBatchEntry>(`SELECT path, path_folded, page_id, lifetime, op, revision::text, prior_disk_sha256, prior_blob_oid,
      disk_sha256, blob_oid, outbox_seq::text, ${ISO('first_enqueued_at')}, state, skip_reason
    FROM export_batch_entries WHERE batch_id=$1::uuid ORDER BY path`, [batchId]);
  return rows.map(r => ({ ...r, page_id: r.page_id === null ? null : Number(r.page_id), lifetime: r.lifetime === null ? null : Number(r.lifetime) }));
}

/** The facts a batch is bound to; every transition compare-and-sets them. */
export interface ExportBound { sourceId: string; hostId: string; token: string; modeEpoch: number; exportEpoch: number; topologyGeneration: number; ownerEpoch: number }

const claimLost = (sourceId: string, batchId: string) => opError('write_claim_lost', 'The export batch claim changed.',
  `Another owner took over export batch ${batchId} of source ${sourceId} (its claim expired, the owner moved or the source's mode or export switch changed), so this attempt stopped; the current holder finishes the batch.`,
  { fix: readFix(`Shows source ${sourceId}'s export state, read-only.`, { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] }) });

/**
 * The SQL that holds only while the batch's binding is current: the claim token, the source's mode epoch and export epoch,
 * the binding's topology generation and the worktree's owner epoch and owner host. `p` is the first parameter index.
 */
function boundSql(p: number): string {
  return `claim_token=$${p}::uuid
    AND EXISTS (SELECT 1 FROM database_canonical_sources d WHERE d.source_id=export_batches.source_id AND d.mode='database' AND d.mode_epoch=$${p + 1})
    AND EXISTS (SELECT 1 FROM canonical_export_sources x WHERE x.source_id=export_batches.source_id AND x.export_commits AND x.export_epoch=$${p + 2})
    AND EXISTS (SELECT 1 FROM persistence_source_bindings b JOIN persistence_worktrees w ON w.id=b.worktree_id
      WHERE b.source_id=export_batches.source_id AND b.topology_generation=$${p + 3} AND w.owner_epoch=$${p + 4} AND w.owner_host_id=$${p + 5}::uuid)`;
}
const boundParams = (b: ExportBound) => [b.token, b.modeEpoch, b.exportEpoch, b.topologyGeneration, b.ownerEpoch, b.hostId];

/**
 * One compare-and-set transition of a held batch: `from` the states it may be in, the `SET` list and its parameters. Throws
 * `write_claim_lost` when the claim or the binding moved, so a former owner can never complete a batch.
 */
export async function transitionBatch(exec: SqlEngine, batchId: string, bound: ExportBound, from: readonly ExportBatchState[], set: string, params: unknown[] = []): Promise<void> {
  const base = params.length + 3;
  const rows = await exec.executeRaw(`UPDATE export_batches SET ${set}, updated_at=now(), claim_expires_at=now()+make_interval(secs => ${EXPORT_CLAIM_LEASE_SECONDS})
    WHERE id=$${params.length + 1}::uuid AND state = ANY($${params.length + 2}::text[]) AND ${boundSql(base)} RETURNING id`,
  [...params, batchId, [...from], ...boundParams(bound)]);
  if (!rows.length) throw claimLost(bound.sourceId, batchId);
}

/** Renews the lease between steps; throws `write_claim_lost` when the claim or binding moved. */
export async function renewBatchClaim(exec: SqlEngine, batchId: string, bound: ExportBound): Promise<void> {
  const rows = await exec.executeRaw(`UPDATE export_batches SET claim_expires_at=now()+make_interval(secs => ${EXPORT_CLAIM_LEASE_SECONDS}), updated_at=now()
    WHERE id=$1::uuid AND state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL} AND ${boundSql(2)} RETURNING id`, [batchId, ...boundParams(bound)]);
  if (!rows.length) throw claimLost(bound.sourceId, batchId);
}

export type ClaimResult =
  | { status: 'claimed'; batch: ExportBatch; bound: ExportBound }
  | { status: 'free'; bound: Omit<ExportBound, 'token'>; mode: ExportModeState }
  | { status: 'unavailable'; reason: 'gate_off' | 'files_mode' | 'export_off' | 'unbound' | 'not_owner' | 'no_checkout' | 'fenced' | 'recovering'
      | 'held' | 'backoff' | 'parked'; batch?: ExportBatch };

/**
 * The only claim of export work (export-claim): on the owner host, with a host binding, the refresh fence clear, no recovery
 * record on the worktree, database mode and export commits on. It claims the source's unfinished batch (minting a new token
 * and re-binding it to the current owner epoch, topology generation and export epoch, so an owner transfer re-binds instead
 * of failing), or reports the source free for a new batch. A batch prepared under another mode epoch is abandoned when it
 * has not committed and parks (`export_mode_changed`) when it has.
 */
export async function claimExportBatch(engine: SqlEngine & { transaction<T>(fn: (tx: SqlEngine) => Promise<T>): Promise<T> }, sourceId: string, hostId: string): Promise<ClaimResult> {
  return engine.transaction(async tx => {
    const mode = await readExportMode(tx, sourceId, true);
    if (mode.mode !== 'database') return { status: 'unavailable', reason: 'files_mode' } as const;
    const exp = await readExportSource(tx, sourceId);
    if (!exp?.export_commits) return { status: 'unavailable', reason: 'export_off' } as const;
    const binding = await readExportBinding(tx, sourceId, hostId);
    if (!binding) return { status: 'unavailable', reason: 'unbound' } as const;
    if (binding.owner_host_id !== hostId) return { status: 'unavailable', reason: 'not_owner' } as const;
    if (!binding.local_path) return { status: 'unavailable', reason: 'no_checkout' } as const;
    if (binding.fenced) return { status: 'unavailable', reason: 'fenced' } as const;
    if (binding.recovering) return { status: 'unavailable', reason: 'recovering' } as const;
    const loose = { sourceId, hostId, modeEpoch: mode.mode_epoch, exportEpoch: exp.export_epoch, topologyGeneration: binding.topology_generation, ownerEpoch: binding.owner_epoch };
    const [row] = await tx.executeRaw<ExportBatch & { claim_owner: unknown; expired: boolean; due: boolean }>(`SELECT ${BATCH_COLUMNS}, claim_owner,
        (claim_expires_at IS NULL OR claim_expires_at < now()) AS expired, next_attempt_at <= now() AS due
      FROM export_batches WHERE source_id=$1 AND state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL} FOR UPDATE`, [sourceId]);
    if (!row) return { status: 'free', bound: loose, mode } as const;
    const batch = batchRow(row);
    if (batch.parked_at) return { status: 'unavailable', reason: 'parked', batch } as const;
    if (batch.claim_token && !row.expired && !claimOwnerProvablyDead(row.claim_owner)) return { status: 'unavailable', reason: 'held', batch } as const;
    if (!row.due) return { status: 'unavailable', reason: 'backoff', batch } as const;
    if (batch.mode_epoch !== mode.mode_epoch) {
      if (batch.state === 'prepared' || batch.state === 'built') {
        await abandonBatchInTx(tx, batch.id, 'mode_changed');
        return { status: 'free', bound: loose, mode } as const;
      }
      await tx.executeRaw(`UPDATE export_batches SET parked_at=now(), error_code='export_mode_changed', claim_token=NULL, claim_owner=NULL, updated_at=now() WHERE id=$1::uuid`, [batch.id]);
      return { status: 'unavailable', reason: 'parked', batch: { ...batch, parked_at: new Date().toISOString(), error_code: 'export_mode_changed' } } as const;
    }
    const token = randomUUID();
    await tx.executeRaw(`UPDATE export_batches SET claim_token=$2::uuid, claim_owner=$3::text::jsonb, claim_expires_at=now()+make_interval(secs => ${EXPORT_CLAIM_LEASE_SECONDS}),
        attempts=attempts+1, export_epoch=$4, topology_generation=$5, owner_epoch=$6, worktree_id=$7::uuid, host_id=$8::uuid, updated_at=now() WHERE id=$1::uuid`,
    [batch.id, token, JSON.stringify({ token, owner: claimOwner() }), exp.export_epoch, binding.topology_generation, binding.owner_epoch, binding.worktree_id, hostId]);
    return { status: 'claimed', batch: { ...batch, claim_token: token, attempts: batch.attempts + 1, export_epoch: exp.export_epoch,
      topology_generation: binding.topology_generation, owner_epoch: binding.owner_epoch, worktree_id: binding.worktree_id }, bound: { ...loose, token } } as const;
  });
}

/**
 * Closes a batch that never committed: its entries' pages go back into the outbox (at their current slug and revision, kept
 * when a newer row is already there), so nothing it held is lost.
 */
export async function abandonBatchInTx(tx: SqlEngine, batchId: string, reason: string): Promise<void> {
  await tx.executeRaw(`INSERT INTO export_outbox(source_id, page_id, slug, revision, cause, first_enqueued_at)
      SELECT b.source_id, p.id, p.slug, p.knowledge_revision, 'written', COALESCE(e.first_enqueued_at, now())
      FROM export_batch_entries e JOIN export_batches b ON b.id=e.batch_id JOIN pages p ON p.id=e.page_id
      WHERE e.batch_id=$1::uuid AND e.page_id IS NOT NULL AND p.source_id=b.source_id
    ON CONFLICT (source_id, page_id) DO UPDATE SET first_enqueued_at=LEAST(export_outbox.first_enqueued_at, EXCLUDED.first_enqueued_at)`, [batchId]);
  await tx.executeRaw(`UPDATE export_batches SET state='abandoned', claim_token=NULL, claim_owner=NULL, claim_expires_at=NULL, completed_at=now(), updated_at=now(),
    detail=detail || jsonb_build_object('abandoned', $2::text) WHERE id=$1::uuid AND state IN ('prepared','built')`, [batchId, reason]);
}

/**
 * A failed attempt: releases the claim with backoff, or parks the batch after `EXPORT_MAX_ATTEMPTS` consecutive failures.
 * Returns whether it parked. Compare-and-set on the token only: a failure must be recordable after the binding moved.
 */
export async function failBatchAttempt(exec: SqlEngine, batchId: string, token: string, code: string, detail: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ parked: boolean }>(`UPDATE export_batches SET claim_token=NULL, claim_owner=NULL, claim_expires_at=NULL, error_code=$3,
      detail=detail || jsonb_build_object('last_error', $4::text),
      parked_at=CASE WHEN attempts >= ${EXPORT_MAX_ATTEMPTS} THEN now() ELSE parked_at END,
      next_attempt_at=now() + make_interval(secs => LEAST(600, 5 * power(2, LEAST(attempts, 7))::int)), updated_at=now()
    WHERE id=$1::uuid AND claim_token=$2::uuid RETURNING parked_at IS NOT NULL AS parked`, [batchId, token, code, detail]);
  return !!row?.parked;
}

/** Releases a claim without counting a failure (a contended push, a lagging checkout): the next tick resumes. */
export async function releaseBatchClaim(exec: SqlEngine, batchId: string, token: string, code: string | null = null): Promise<void> {
  await exec.executeRaw(`UPDATE export_batches SET claim_token=NULL, claim_owner=NULL, claim_expires_at=NULL, attempts=0, error_code=COALESCE($3, error_code),
    updated_at=now() WHERE id=$1::uuid AND claim_token=$2::uuid`, [batchId, token, code]);
}

/** `--export-retry`: clears the parking and the attempt count of a source's parked batch. */
export async function unparkBatch(tx: SqlEngine, batchId: string): Promise<boolean> {
  const rows = await tx.executeRaw(`UPDATE export_batches SET parked_at=NULL, attempts=0, next_attempt_at=now(), claim_token=NULL, claim_owner=NULL,
    claim_expires_at=NULL, updated_at=now() WHERE id=$1::uuid AND parked_at IS NOT NULL RETURNING id`, [batchId]);
  return rows.length > 0;
}

/** Deletes finished batches (and their entries) older than `days`; returns how many. */
export async function pruneFinishedBatches(exec: SqlEngine, sourceId: string, days = 7): Promise<number> {
  const rows = await exec.executeRaw(`DELETE FROM export_batches WHERE source_id=$1 AND state IN ('completed','abandoned')
    AND updated_at < now() - make_interval(days => $2) RETURNING id`, [sourceId, days]);
  return rows.length;
}

/** Whether any source holds an unfinished batch (graduation drain and deactivation refuse while one does). */
export async function unfinishedExportBatches(exec: SqlEngine, sourceIds?: readonly string[]): Promise<Array<{ source_id: string; id: string; state: ExportBatchState }>> {
  return exec.executeRaw(`SELECT source_id, id::text, state FROM export_batches WHERE state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL}
    AND ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id`, [sourceIds ? [...sourceIds] : null]);
}

/**
 * Wave 5b: `gbrain sources refresh` refuses `source_export_owned` for a worktree bound to a database-mode source, before
 * anything is fetched or drained; the exporter owns fetches and fast-forwards there.
 */
export async function assertWorktreeNotExportOwned(exec: SqlEngine, sourceId: string): Promise<void> {
  const [owned] = await exec.executeRaw<{ source_id: string }>(`SELECT d.source_id FROM persistence_source_bindings b
      JOIN persistence_source_bindings peer ON peer.worktree_id=b.worktree_id JOIN database_canonical_sources d ON d.source_id=peer.source_id
    WHERE b.source_id=$1 AND d.mode='database' ORDER BY d.source_id LIMIT 1`, [sourceId]);
  if (!owned) return;
  throw opError('source_export_owned', `Source ${owned.source_id} is in database mode, so its exporter owns fetches and fast-forwards of this worktree; nothing was fetched or drained.`,
    `Read gbrain sync status --source ${owned.source_id}; the exporter brings the remote in on its own schedule.`,
    { fix: readFix(`Shows source ${owned.source_id}'s exporter and checkout state, read-only.`, { argv: ['gbrain', 'sync', 'status', '--source', owned.source_id, '--json'] }) });
}
