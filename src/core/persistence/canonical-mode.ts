/**
 * Database-canonical memory, wave 4: the source's mode and the helpers every writer consults (the contract in
 * docs/designs/database-canonical-w4-contract.md). The fence itself lives in the database (canonical-mode-schema.ts); this
 * module reads the mode, declares the canonical protocol, routes checkout effects, maps the fence's refusals to typed codes
 * and names the file-lane operations a database-mode source refuses. Plain SQL over `SqlEngine`, like wave 2's store.
 */
import { OperationError, opError } from '../ops/contract.ts';
import type { SqlEngine } from './model.ts';
import { UNSETTLED_REQUEST_SQL } from './canonical-mode-schema.ts';

export const CANONICAL_MODES = ['files', 'database'] as const;
export type CanonicalMode = typeof CANONICAL_MODES[number];
/** The canonical protocol this build speaks; a resident process records it in `persistence_consumers.canonical_protocol`. */
export const CANONICAL_PROTOCOL = 1;
/**
 * The transaction-local declaration (`set_config(..., true)`, the third argument is `is_local`): it ends with the
 * transaction, so a transaction-mode pooler never hands it to another client. Every writer of this build sends it in a
 * statement it already sends (protocol.ts, context.ts); a session that sets `gbrain.write_sources` by hand does not.
 */
export const CANONICAL_PROTOCOL_DECLARATION = "set_config('gbrain.canonical_protocol','1',true)";
export const DATABASE_CANONICAL_DOCS = 'docs/designs/database-canonical-w4-contract.md';

export interface SourceModeState {
  source_id: string;
  mode: CanonicalMode;
  mode_epoch: number;
  eligibility_generation: number;
  shadow: boolean;
  shadow_epoch: number;
}

/** A source without a row is in files mode at epoch 0. */
export async function readSourceMode(exec: SqlEngine, sourceId: string): Promise<SourceModeState> {
  const [row] = await exec.executeRaw<SourceModeState>(`SELECT source_id, mode, mode_epoch::int AS mode_epoch, eligibility_generation::int AS eligibility_generation,
      shadow, shadow_epoch::int AS shadow_epoch FROM database_canonical_sources WHERE source_id=$1`, [sourceId]);
  return row ? { ...row, mode_epoch: Number(row.mode_epoch), eligibility_generation: Number(row.eligibility_generation), shadow_epoch: Number(row.shadow_epoch) }
    : { source_id: sourceId, mode: 'files', mode_epoch: 0, eligibility_generation: 0, shadow: false, shadow_epoch: 0 };
}

export async function sourceInDatabaseMode(exec: SqlEngine, sourceId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ mode: string }>('SELECT mode FROM database_canonical_sources WHERE source_id=$1', [sourceId]);
  return row?.mode === 'database';
}

export async function listDatabaseModeSources(exec: SqlEngine): Promise<string[]> {
  return (await exec.executeRaw<{ source_id: string }>("SELECT source_id FROM database_canonical_sources WHERE mode='database' ORDER BY source_id")).map(r => r.source_id);
}

/**
 * Effect routing for the writers that insert `persistence_effects` rows from a `sources` row aliased `alias` (withdrawal,
 * purge, segmented repair): for a database-mode source the effects carry no worktree and the checkout kinds are not
 * inserted. A files-mode source joins no row, so its statement inserts exactly what it did before.
 */
export function databaseModeEffectRouting(alias: string): { join: string; worktree: (expr: string) => string; filter: (kind: string) => string } {
  return {
    join: `LEFT JOIN database_canonical_sources dcm ON dcm.source_id=${alias}.id AND dcm.mode='database'`,
    worktree: expr => `CASE WHEN dcm.source_id IS NULL THEN ${expr} END`,
    filter: kind => `AND (dcm.source_id IS NULL OR ${kind} NOT IN ('git','withdrawal-mirror'))`,
  };
}

/** The claim predicate a `git` or `withdrawal-mirror` effect must pass (fence point 3b): its source is in files mode. */
export const checkoutEffectClaimable = (alias: string) => `gbrain_source_publication_epoch(${alias}.source_id) IS NULL`;

/** Intent kinds that read or write the source's checkout: in database mode the import lane owns outside edits. */
const FILE_LANE_INTENT_KINDS: ReadonlySet<string> = new Set(['managed_file_import', 'managed_file_repair', 'managed_quarantine_clear', 'canonical_reconcile', 'segmented_mirror']);

export function isFileLaneAdmission(input: { intent?: Record<string, unknown>; callerIntent?: Record<string, unknown> }): boolean {
  const kind = String(input.intent?.kind ?? input.callerIntent?.kind ?? '');
  return kind.startsWith('managed_sync_') || FILE_LANE_INTENT_KINDS.has(kind);
}

/** The file-lane refusal: a checkout operation targeted a database-mode source. */
export function sourceDatabaseModeError(sourceId: string, what: string): OperationError {
  const error = opError('source_database_mode', `Source ${sourceId} is in database mode, so ${what} does not run for it.`,
    `Nothing was changed. In database mode the database holds the source's pages and the exporter owns its checkout; write pages with put_page. To return the source to files, run gbrain sources canonical ${sourceId} --to files --dry-run.`);
  error.docs = DATABASE_CANONICAL_DOCS;
  return error;
}

/** Fence refusal codes, keyed by the message prefix the fence triggers raise (canonical-mode-schema.ts). */
export const CANONICAL_FENCE_CODES = ['canonical_protocol_required', 'canonical_publication_required', 'canonical_mode_changed'] as const;
export type CanonicalFenceCode = typeof CANONICAL_FENCE_CODES[number];
const FENCE_TEXT: Record<CanonicalFenceCode, string> = {
  canonical_protocol_required: 'The source is in database mode and this writer does not declare the canonical protocol (an older gbrain, or gbrain.write_sources set by hand). Nothing was written.',
  canonical_publication_required: 'A files-mode publication (a worktree-bound request or a checkout effect) reached a source in database mode. Nothing was written.',
  canonical_mode_changed: 'The source changed mode after this request was admitted, so it was not published under the new mode. Nothing was written.',
};

/** Null when `error` is not a fence refusal. `point` is the fence point that refused (`request`, `effect`, `mutation`, `publication`). */
export function canonicalFenceRefusal(error: unknown): { code: CanonicalFenceCode; message: string; point?: string } | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const message = typeof e.message === 'string' ? e.message : '';
  const constraint = String(e.constraint_name ?? e.constraint ?? '');
  const code = CANONICAL_FENCE_CODES.find(c => message.startsWith(`${c}:`));
  if (!code || (constraint && !constraint.startsWith('database_canonical_fence:'))) return null;
  const point = constraint.startsWith('database_canonical_fence:') ? constraint.slice('database_canonical_fence:'.length) : undefined;
  return { code, message: FENCE_TEXT[code], ...(point ? { point } : {}) };
}

/** The same refusal as a typed OperationError, for paths that surface database errors directly. */
export function canonicalFenceError(error: unknown): OperationError | null {
  const refusal = canonicalFenceRefusal(error);
  if (!refusal) return null;
  const hint = refusal.code === 'canonical_mode_changed' ? 'Submit the write again with a new request_id; it is routed under the source\'s current mode.'
    : refusal.code === 'canonical_protocol_required' ? 'Upgrade or stop the process that wrote it (gbrain upgrade on its host); gbrain doctor names database_canonical_fence findings.'
    : 'Run gbrain doctor --json and report the database_canonical_fence finding; the write path routes these writes by mode.';
  const typed = opError(refusal.code, refusal.message, hint);
  typed.docs = DATABASE_CANONICAL_DOCS;
  return typed;
}

/**
 * Every in-flight unit of work a flip must wait for, in either direction (canonical_inflight_work). The request predicate
 * is the fence's own (`UNSETTLED_REQUEST_SQL`), so a request holding a recovery record blocks the flip and the 3a/3c
 * refusal of that recovery is unreachable through the verb. Checkout effects that a retry could requeue count too;
 * a settled effect (`data ? 'settled'`) never runs again and does not.
 */
export async function inflightWork(exec: SqlEngine, sourceId: string): Promise<{ requests: number; effects: number; old_processes: number }> {
  const [row] = await exec.executeRaw<{ requests: number; effects: number; old_processes: number }>(`SELECT
      (SELECT count(*)::int FROM persistence_requests r WHERE r.source_id=$1 AND ${UNSETTLED_REQUEST_SQL('r')}) AS requests,
      (SELECT count(*)::int FROM persistence_effects e WHERE e.source_id=$1 AND (e.state IN ('queued','running') OR e.recovery IS NOT NULL
        OR (e.kind IN ('git','withdrawal-mirror') AND e.state='failed' AND NOT (e.data ? 'settled')))) AS effects,
      (SELECT count(*)::int FROM persistence_consumers c WHERE c.renewed_at > now() - interval '5 minutes' AND c.canonical_protocol IS NULL) AS old_processes`, [sourceId]);
  return { requests: Number(row?.requests ?? 0), effects: Number(row?.effects ?? 0), old_processes: Number(row?.old_processes ?? 0) };
}

/**
 * Locks out every writer the fence covers for the rest of the caller's transaction, after the source row: in-flight
 * writers of these tables commit first, and a later one waits and then runs its fence trigger against the flipped mode
 * (a trigger function is volatile, so each of its statements reads a fresh snapshot). That is what closes the race of a
 * writer that read `database_sources = 0` before the flip committed.
 */
export const CANONICAL_WRITER_TABLES = ['pages', 'tags', 'slug_aliases', 'page_aliases', 'facts', 'takes', 'timeline_entries', 'page_segment_texts',
  'page_body_manifest', 'fact_withdrawals', 'fact_purges', 'persistence_requests', 'persistence_effects'] as const;
export async function lockCanonicalWriters(tx: SqlEngine): Promise<void> {
  const [present] = await tx.executeRaw<{ tables: string[] }>('SELECT array_agg(t ORDER BY n) AS tables FROM unnest($1::text[]) WITH ORDINALITY AS u(t,n) WHERE to_regclass(t) IS NOT NULL',
    [[...CANONICAL_WRITER_TABLES]]);
  await tx.executeRaw(`LOCK TABLE ${present!.tables.join(', ')} IN SHARE MODE`);
}

/**
 * Wave 2's `--shadow off` calls this first: a database-mode source keeps its shadow flag (the constraint
 * `database_canonical_mode_shadow` is the backstop), because its outbox is how the exporter learns of every write.
 */
export async function assertShadowOffAllowed(exec: SqlEngine, sourceId: string): Promise<void> {
  if (!await sourceInDatabaseMode(exec, sourceId)) return;
  const error = opError('canonical_mode_requires_shadow', `Source ${sourceId} is in database mode, so its shadow flag stays on: the export outbox it feeds is how the exporter learns of every write.`,
    `Nothing changed. Return the source to files first with gbrain sources canonical ${sourceId} --to files --dry-run, then turn shadow off.`);
  error.docs = DATABASE_CANONICAL_DOCS;
  throw error;
}
