/**
 * Database-canonical memory, wave 5b: the status store (docs/designs/database-canonical-w5-contract.md, "Surfaces"). One
 * read per database-mode (or exporting) source: export lag and pending count, import lag, coverage, the checkout's state,
 * open conflicts by kind, the unfinished batch (and, when parked, its error code and the retry command) and the PGLite
 * one-shot outcome. Read-only; `gbrain sync status`, doctor and `get_brain_health` render it.
 */
import type { SqlEngine } from './model.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { UNFINISHED_EXPORT_BATCH_STATES_SQL } from './canonical-export-schema.ts';

export interface CanonicalConflictCount { kind: string; count: number; oldest_age_seconds: number }
export interface CanonicalParkedPath { conflict_id: number; path: string; slug: string | null; kind: string; age_seconds: number }

export interface CanonicalSourceStatus {
  source_id: string;
  mode: 'files' | 'database';
  export_commits: boolean;
  export_pending: number;
  export_lag_seconds: number | null;
  import_lag_seconds: number | null;
  /** Live non-private pages; processed: ledger or unfinished entry at the page's revision; committed: the ledger row is current and committed; pushed: committed no later than the newest push. */
  coverage: { eligible: number; processed: number; committed: number; pushed: number };
  checkout_state: 'current' | 'lagging' | 'unbound' | null;
  checkout_reason: string | null;
  committed_commit: string | null;
  pushed_commit: string | null;
  last_error_code: string | null;
  conflicts_open: number;
  conflicts: CanonicalConflictCount[];
  batch: { id: string; state: string; attempts: number; error_code: string | null; parked_at: string | null; retry: string[] | null } | null;
  oneshot: { outcome: string; at: string | null } | null;
  parked_paths_read: { status: 'read' } | { status: 'not_read'; fix: string[] };
  parked_paths?: CanonicalParkedPath[];
}

const PARKED_LIMIT = 50;
const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** The retry command a parked batch names (preview first). */
export const exportRetryArgv = (sourceId: string) => ['gbrain', 'sources', 'canonical', sourceId, '--export-retry', '--dry-run'];

/** Every database-mode or exporting source (optionally only `sourceIds`); empty when none, after one cheap read. */
export async function readDatabaseCanonicalStatus(exec: SqlEngine, opts: { sourceIds?: readonly string[]; detail?: boolean } = {}): Promise<CanonicalSourceStatus[]> {
  const sources = await exec.executeRaw<{ source_id: string; mode: string; export_commits: boolean | null; checkout_state: string | null; checkout_reason: string | null;
    committed_commit: string | null; pushed_commit: string | null; pushed_at: string | null; last_error_code: string | null; oneshot_outcome: string | null; oneshot_at: string | null;
    import_lag: number | null }>(`SELECT d.source_id, d.mode, x.export_commits, x.checkout_state, x.checkout_reason, x.committed_commit, x.pushed_commit, x.pushed_at::text AS pushed_at,
      x.last_error_code, x.oneshot_outcome, ${ISO('x.oneshot_at')} AS oneshot_at, EXTRACT(EPOCH FROM now() - x.import_pending_since)::int AS import_lag
    FROM database_canonical_sources d LEFT JOIN canonical_export_sources x ON x.source_id=d.source_id
    WHERE (d.mode='database' OR x.export_commits) AND ($1::text[] IS NULL OR d.source_id = ANY($1::text[])) ORDER BY d.source_id`,
  [opts.sourceIds ? [...opts.sourceIds] : null]);
  const out: CanonicalSourceStatus[] = [];
  for (const s of sources) {
    const id = s.source_id;
    const [lag] = await exec.executeRaw<{ pending: number; lag: number | null }>(`SELECT count(*)::int AS pending, EXTRACT(EPOCH FROM now() - min(first_enqueued_at))::int AS lag FROM (
        SELECT o.first_enqueued_at FROM export_outbox o WHERE o.source_id=$1
        UNION ALL SELECT e.first_enqueued_at FROM export_batch_entries e JOIN export_batches b ON b.id=e.batch_id
          WHERE b.source_id=$1 AND b.state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL} AND b.parked_at IS NULL AND e.state<>'skipped') q`, [id]);
    const [cov] = await exec.executeRaw<{ eligible: number; processed: number; committed: number; pushed: number }>(`SELECT count(*)::int AS eligible,
        count(*) FILTER (WHERE l.revision=p.knowledge_revision OR EXISTS (SELECT 1 FROM export_batch_entries e JOIN export_batches b ON b.id=e.batch_id
          WHERE b.source_id=p.source_id AND b.state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL} AND e.page_id=p.id AND e.revision=p.knowledge_revision))::int AS processed,
        count(*) FILTER (WHERE l.revision=p.knowledge_revision AND l.commit_sha IS NOT NULL)::int AS committed,
        count(*) FILTER (WHERE l.revision=p.knowledge_revision AND l.commit_sha IS NOT NULL AND $2::timestamptz IS NOT NULL AND l.exported_at <= $2::timestamptz)::int AS pushed
      FROM pages p LEFT JOIN export_ledger l ON l.source_id=p.source_id AND l.page_id=p.id AND l.retired_at IS NULL
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.database_only_reason IS NULL AND ${privatePagesFilterFragment('p')}`, [id, s.pushed_at]);
    const conflicts = await exec.executeRaw<CanonicalConflictCount>(`SELECT kind, count(*)::int AS count, EXTRACT(EPOCH FROM now() - min(first_observed_at))::int AS oldest_age_seconds
      FROM import_conflicts WHERE source_id=$1 AND state='open' AND outcome='conflict' AND mode='live' GROUP BY kind ORDER BY kind`, [id]);
    const [batch] = await exec.executeRaw<{ id: string; state: string; attempts: number; error_code: string | null; parked_at: string | null }>(
      `SELECT id::text, state, attempts, error_code, ${ISO('parked_at')} AS parked_at FROM export_batches WHERE source_id=$1 AND state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL}`, [id]);
    const status: CanonicalSourceStatus = {
      source_id: id, mode: s.mode === 'database' ? 'database' : 'files', export_commits: !!s.export_commits,
      export_pending: Number(lag?.pending ?? 0), export_lag_seconds: lag?.lag === null || lag?.lag === undefined ? null : Number(lag.lag),
      import_lag_seconds: s.import_lag === null ? null : Number(s.import_lag),
      coverage: { eligible: Number(cov?.eligible ?? 0), processed: Number(cov?.processed ?? 0), committed: Number(cov?.committed ?? 0), pushed: Number(cov?.pushed ?? 0) },
      checkout_state: (s.checkout_state as CanonicalSourceStatus['checkout_state']) ?? null, checkout_reason: s.checkout_reason, committed_commit: s.committed_commit,
      pushed_commit: s.pushed_commit, last_error_code: s.last_error_code,
      conflicts_open: conflicts.reduce((n, c) => n + Number(c.count), 0), conflicts: conflicts.map(c => ({ kind: c.kind, count: Number(c.count), oldest_age_seconds: Number(c.oldest_age_seconds) })),
      batch: batch ? { ...batch, attempts: Number(batch.attempts), retry: batch.parked_at ? exportRetryArgv(id) : null } : null,
      oneshot: s.oneshot_outcome ? { outcome: s.oneshot_outcome, at: s.oneshot_at } : null,
      parked_paths_read: opts.detail ? { status: 'read' } : { status: 'not_read', fix: ['gbrain', 'sync', 'status', '--source', id, '--detail', '--json'] },
    };
    if (opts.detail) {
      status.parked_paths = (await exec.executeRaw<CanonicalParkedPath>(`SELECT c.id AS conflict_id, c.path, p.slug, c.kind, EXTRACT(EPOCH FROM now() - c.first_observed_at)::int AS age_seconds
        FROM import_conflicts c LEFT JOIN pages p ON p.id=c.page_id WHERE c.source_id=$1 AND c.state='open' AND c.outcome='conflict' AND c.mode='live'
        ORDER BY c.first_observed_at LIMIT ${PARKED_LIMIT}`, [id])).map(r => ({ ...r, conflict_id: Number(r.conflict_id), age_seconds: Number(r.age_seconds) }));
    }
    out.push(status);
  }
  return out;
}

/** One-line human summary per source (sync status text). */
export function formatCanonicalStatus(s: CanonicalSourceStatus): string[] {
  const lines = [`database-canonical: ${s.mode} mode, export commits ${s.export_commits ? 'on' : 'off'}; ${s.export_pending} page(s) to export${s.export_lag_seconds !== null ? `, oldest ${s.export_lag_seconds}s` : ''}`
    + `; coverage ${s.coverage.processed}/${s.coverage.committed}/${s.coverage.pushed} of ${s.coverage.eligible} (processed/committed/pushed); checkout ${s.checkout_state ?? 'unknown'}${s.checkout_reason ? ` (${s.checkout_reason})` : ''}`];
  if (s.batch) lines.push(`  export batch ${s.batch.id}: ${s.batch.state}, ${s.batch.attempts} attempt(s)${s.batch.error_code ? `, last error ${s.batch.error_code}` : ''}${s.batch.parked_at ? `, PARKED since ${s.batch.parked_at}; retry: ${s.batch.retry!.join(' ')}` : ''}`);
  if (s.conflicts_open) lines.push(`  open conflicts: ${s.conflicts.map(c => `${c.kind} ${c.count} (oldest ${c.oldest_age_seconds}s)`).join(', ')}; gbrain sources conflicts ${s.source_id} list`);
  if (s.oneshot) lines.push(`  last one-shot export attempt: ${s.oneshot.outcome} at ${s.oneshot.at}${s.oneshot.outcome.startsWith('skipped') ? ' (a skip, not a stall: the next command or resident exports)' : ''}`);
  for (const p of s.parked_paths ?? []) lines.push(`    parked ${p.path}${p.slug ? ` (${p.slug})` : ''}: ${p.kind}, ${p.age_seconds}s, conflict ${p.conflict_id}`);
  return lines;
}
