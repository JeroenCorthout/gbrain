/**
 * Database-canonical memory, wave 3: the reads over the observe-mode import lane's tables (import-conflicts-schema.ts) that
 * `gbrain sources canonical <id> --census` and the `database_canonical_census` doctor check share. Read-only.
 */
import type { SqlEngine } from './model.ts';
import { GBRAIN_OWNED_HINTS } from './import-lane-git.ts';
import type { ImportLaneOutcome } from './import-lane.ts';
import type { ImportConflictKind } from './import-conflict-mapping.ts';

export interface CensusWriter {
  writer_key: string;
  author_name: string | null;
  author_email: string | null;
  committer_email: string | null;
  process_hint: string | null;
  /** The managed Git effect: the exporter replaces its page commits, so it needs no moving. */
  gbrain_owned: boolean;
  commits: number;
  paths: number;
  commits_7d: number;
  last_committed_at: string | null;
  message_prefixes: string[];
}

export interface ImportCensus {
  source_id: string;
  last_pass: { id: number; finished_at: string; shadow_epoch: number; head_commit: string | null; scanned: number; unstable: number; commits: number } | null;
  /** Open rows by would-have outcome. */
  outcomes: Partial<Record<ImportLaneOutcome, number>>;
  /** Open would-be conflicts by kind: what a conversion would adopt. */
  conflicts: Array<{ kind: ImportConflictKind; count: number; oldest_observed_at: string; sample: Array<{ path: string; reason: string | null }> }>;
  /** Two-sided conflicts and how many of them a base-aware field merge would have resolved (null merge: no base blob). */
  merge: { two_sided: number; resolvable: number; no_base: number };
  /** Writers of page paths, committed and not gbrain's own Git effect first, by recency. */
  writers: CensusWriter[];
  uncommitted: { changes: number; paths: number };
}

const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export async function readImportCensus(exec: SqlEngine, sourceId: string, sample = 10): Promise<ImportCensus> {
  const [last] = await exec.executeRaw<NonNullable<ImportCensus['last_pass']>>(`SELECT id, ${ISO('finished_at')} AS finished_at, shadow_epoch::int AS shadow_epoch,
      head_commit, scanned, unstable, commits FROM import_lane_passes WHERE source_id=$1 ORDER BY id DESC LIMIT 1`, [sourceId]);
  const outcomeRows = await exec.executeRaw<{ outcome: ImportLaneOutcome; n: number }>(`SELECT outcome, count(*)::int AS n FROM import_conflicts
    WHERE source_id=$1 AND state='open' GROUP BY outcome ORDER BY outcome`, [sourceId]);
  const kindRows = await exec.executeRaw<{ kind: ImportConflictKind; n: number; oldest: string }>(`SELECT kind, count(*)::int AS n, ${ISO('min(first_observed_at)')} AS oldest
    FROM import_conflicts WHERE source_id=$1 AND state='open' AND kind IS NOT NULL GROUP BY kind ORDER BY count(*) DESC, kind`, [sourceId]);
  const conflicts: ImportCensus['conflicts'] = [];
  for (const row of kindRows) {
    const samples = await exec.executeRaw<{ path: string; reason: string | null }>(`SELECT path, detail->>'reason' AS reason FROM import_conflicts
      WHERE source_id=$1 AND state='open' AND kind=$2 ORDER BY first_observed_at, path LIMIT $3`, [sourceId, row.kind, sample]);
    conflicts.push({ kind: row.kind, count: Number(row.n), oldest_observed_at: row.oldest, sample: samples });
  }
  const [merge] = await exec.executeRaw<{ two_sided: number; resolvable: number; no_base: number }>(`SELECT count(*)::int AS two_sided,
      count(*) FILTER (WHERE (merge->>'resolvable')::boolean)::int AS resolvable, count(*) FILTER (WHERE merge IS NULL)::int AS no_base
    FROM import_conflicts WHERE source_id=$1 AND state='open' AND kind='both_changed'`, [sourceId]);
  const writers = await exec.executeRaw<CensusWriter & { prefixes: string[] | string }>(`SELECT writer_key, max(author_name) AS author_name, max(author_email) AS author_email,
      max(committer_email) AS committer_email, max(process_hint) AS process_hint, count(DISTINCT commit_sha)::int AS commits, count(DISTINCT path_folded)::int AS paths,
      count(DISTINCT commit_sha) FILTER (WHERE committed_at > now() - interval '7 days')::int AS commits_7d, ${ISO('max(committed_at)')} AS last_committed_at,
      (array_agg(DISTINCT message_prefix))[1:3] AS prefixes
    FROM import_foreign_writes WHERE source_id=$1 AND commit_sha IS NOT NULL GROUP BY writer_key ORDER BY max(committed_at) DESC NULLS LAST, writer_key`, [sourceId]);
  const [uncommitted] = await exec.executeRaw<{ changes: number; paths: number }>(`SELECT count(*)::int AS changes, count(DISTINCT path_folded)::int AS paths
    FROM import_foreign_writes WHERE source_id=$1 AND commit_sha IS NULL`, [sourceId]);
  return {
    source_id: sourceId,
    last_pass: last ? { ...last, id: Number(last.id), scanned: Number(last.scanned), unstable: Number(last.unstable), commits: Number(last.commits) } : null,
    outcomes: Object.fromEntries(outcomeRows.map(r => [r.outcome, Number(r.n)])),
    conflicts,
    merge: { two_sided: Number(merge?.two_sided ?? 0), resolvable: Number(merge?.resolvable ?? 0), no_base: Number(merge?.no_base ?? 0) },
    writers: writers.map(({ prefixes, ...w }) => ({ ...w, commits: Number(w.commits), paths: Number(w.paths), commits_7d: Number(w.commits_7d),
      gbrain_owned: GBRAIN_OWNED_HINTS.has(w.process_hint ?? ''), message_prefixes: (Array.isArray(prefixes) ? prefixes : []).filter((p): p is string => !!p) })),
    uncommitted: { changes: Number(uncommitted?.changes ?? 0), paths: Number(uncommitted?.paths ?? 0) },
  };
}

/** Writers that committed page files of these sources in the last `days` days, gbrain's own Git effect left out: what would need moving to put_page. */
export async function recentPageWriters(exec: SqlEngine, sourceIds: readonly string[], days = 7): Promise<Array<{ source_id: string; writer_key: string; author_name: string | null;
  process_hint: string | null; commits: number; last_committed_at: string }>> {
  if (!sourceIds.length) return [];
  const rows = await exec.executeRaw<{ source_id: string; writer_key: string; author_name: string | null; process_hint: string | null; commits: number; last_committed_at: string }>(
    `SELECT source_id, writer_key, max(author_name) AS author_name, max(process_hint) AS process_hint, count(DISTINCT commit_sha)::int AS commits,
      ${ISO('max(committed_at)')} AS last_committed_at
    FROM import_foreign_writes WHERE source_id = ANY($1::text[]) AND commit_sha IS NOT NULL AND committed_at > now() - make_interval(days => $2::int)
      AND NOT (COALESCE(process_hint, '') = ANY($3::text[]))
    GROUP BY source_id, writer_key ORDER BY source_id, max(committed_at) DESC`, [sourceIds, days, [...GBRAIN_OWNED_HINTS]]);
  return rows.map(r => ({ ...r, commits: Number(r.commits) }));
}
