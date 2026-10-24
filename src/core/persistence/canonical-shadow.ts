/**
 * Database-canonical memory, wave 2: the store functions over the tables of canonical-schema.ts (the contract in
 * docs/designs/database-canonical-w2-contract.md). The per-source shadow flag, the export outbox the page and withdrawal
 * triggers fill, and the export ledger. Plain SQL over `SqlEngine`, like the rest of persistence/; every caller is a
 * trusted local command, never an MCP operation.
 */
import type { SqlEngine } from './model.ts';
import { LEDGER_ORIGINS, OUTBOX_CAUSES, SHADOW_DIFF_KINDS } from './canonical-schema.ts';

export type ShadowDiffKind = typeof SHADOW_DIFF_KINDS[number];
export type OutboxCause = typeof OUTBOX_CAUSES[number];
export type LedgerOrigin = typeof LEDGER_ORIGINS[number];

/**
 * The kinds that mean the exporter would do something wrong if it ran today: its render disagrees with bytes imported at
 * the same revision, a page it must never publish has a file, a slug has no safe path, or two pages fold to one path.
 * Every other kind is what a working exporter and a live checkout produce (lag, outside edits the import lane takes,
 * conflicts from real two-sided edits). Doctor is red while any page's latest diff is unexpected.
 */
export const UNEXPECTED_SHADOW_DIFF_KINDS: ReadonlySet<ShadowDiffKind> = new Set<ShadowDiffKind>(['render_mismatch', 'ineligible_file', 'unsafe_path', 'path_collision']);

export function isExpectedShadowDiff(kind: ShadowDiffKind): boolean {
  return !UNEXPECTED_SHADOW_DIFF_KINDS.has(kind);
}

/** One source's row in database_canonical_sources; null when the source never had shadow turned on. W4 adds mode and mode_epoch beside it. */
export interface SourceCanonicalState {
  source_id: string;
  source_incarnation: string;
  shadow: boolean;
  shadow_epoch: number;
  shadow_changed_at: string;
}

const STATE_COLUMNS = `source_id, source_incarnation::text, shadow, shadow_epoch::int AS shadow_epoch,
  to_char(shadow_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS shadow_changed_at`;

export async function readSourceCanonicalState(exec: SqlEngine, sourceId: string): Promise<SourceCanonicalState | null> {
  const [row] = await exec.executeRaw<SourceCanonicalState>(`SELECT ${STATE_COLUMNS} FROM database_canonical_sources WHERE source_id=$1`, [sourceId]);
  return row ?? null;
}

/** The gate later waves check before doing shadow work for a source (W3's observe-mode import lane included). */
export async function sourceShadowEnabled(exec: SqlEngine, sourceId: string): Promise<boolean> {
  return (await readSourceCanonicalState(exec, sourceId))?.shadow === true;
}

export async function listShadowedSources(exec: SqlEngine): Promise<string[]> {
  return (await exec.executeRaw<{ source_id: string }>('SELECT source_id FROM database_canonical_sources WHERE shadow ORDER BY source_id')).map(r => r.source_id);
}

/**
 * Waits for every in-flight page and withdrawal writer to commit and holds new ones off until the caller's transaction
 * ends, so a shadow flip is a clean cut: a write either committed before it (and the seed or a later sweep covers it) or
 * runs its trigger after it. Writers wait milliseconds; only the flip runs under it.
 */
export async function lockExportWriters(tx: SqlEngine): Promise<void> {
  await tx.executeRaw('LOCK TABLE pages, fact_withdrawals, fact_purges IN SHARE MODE');
}

/** Sets a source's shadow flag and advances its shadow epoch. Callers hold lockExportWriters in the same transaction. */
export async function writeSourceShadow(tx: SqlEngine, sourceId: string, shadow: boolean): Promise<SourceCanonicalState> {
  const [row] = await tx.executeRaw<SourceCanonicalState>(`INSERT INTO database_canonical_sources(source_id, source_incarnation, shadow, shadow_epoch)
      SELECT id, incarnation, $2, 1 FROM sources WHERE id=$1
    ON CONFLICT (source_id) DO UPDATE SET shadow=EXCLUDED.shadow, source_incarnation=EXCLUDED.source_incarnation,
      shadow_epoch=database_canonical_sources.shadow_epoch+1, shadow_changed_at=now()
    RETURNING ${STATE_COLUMNS}`, [sourceId, shadow]);
  if (!row) throw new Error(`Source ${sourceId} does not exist.`);
  return row;
}

/** One coalesced outbox row: the page's newest revision since the consumer last took it. `revision` is null when the page left the source. */
export interface ExportOutboxRow {
  source_id: string;
  page_id: number;
  slug: string;
  revision: string | null;
  cause: OutboxCause;
  /** Bumped by every upsert; consumeExportOutbox deletes a row only while it still has the seq the consumer read. */
  seq: string;
  first_enqueued_at: string;
  enqueued_at: string;
}

const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;

/** The oldest `limit` rows of a source's outbox, in upsert order. A consumer never keeps a seq watermark: a row committed later with a smaller seq is still here. */
export async function readExportOutbox(exec: SqlEngine, sourceId: string, limit: number): Promise<ExportOutboxRow[]> {
  const rows = await exec.executeRaw<ExportOutboxRow>(`SELECT source_id, page_id, slug, revision::text, cause, seq::text,
      ${ISO('first_enqueued_at')}, ${ISO('enqueued_at')}
    FROM export_outbox WHERE source_id=$1 ORDER BY seq LIMIT $2`, [sourceId, limit]);
  return rows.map(row => ({ ...row, page_id: Number(row.page_id) }));
}

/** Deletes the rows the consumer handled, each only if no write upserted it since (same seq); returns how many it deleted. */
export async function consumeExportOutbox(exec: SqlEngine, rows: ReadonlyArray<Pick<ExportOutboxRow, 'source_id' | 'page_id' | 'seq'>>): Promise<number> {
  if (!rows.length) return 0;
  const deleted = await exec.executeRaw<{ page_id: number }>(`DELETE FROM export_outbox o USING jsonb_to_recordset($1::text::jsonb) AS t(source_id text, page_id int, seq text)
    WHERE o.source_id=t.source_id AND o.page_id=t.page_id AND o.seq=t.seq::bigint RETURNING o.page_id`, [JSON.stringify(rows)]);
  return deleted.length;
}

export interface ExportOutboxStats { depth: number; oldest_age_seconds: number | null }

export async function exportOutboxStats(exec: SqlEngine, sourceId: string): Promise<ExportOutboxStats> {
  const [row] = await exec.executeRaw<{ depth: number; age: number | null }>(`SELECT count(*)::int AS depth,
    floor(extract(epoch FROM now() - min(first_enqueued_at)))::int AS age FROM export_outbox WHERE source_id=$1`, [sourceId]);
  return { depth: Number(row?.depth ?? 0), oldest_age_seconds: row?.age == null ? null : Number(row.age) };
}

/** A live export ledger row: the bytes the checkout holds for a page and the revision they render. */
export interface ExportLedgerRow {
  source_id: string;
  page_id: number;
  lifetime: number;
  path: string;
  path_folded: string;
  revision: string;
  disk_sha256: string;
  blob_oid: string | null;
  /** Null for bytes gbrain did not render (a sync import or an adopted file): keep-bytes decisions use the equality contract, never this. */
  renderer_fp: string | null;
  seeded_from: LedgerOrigin;
}

export async function readLiveLedgerRows(exec: SqlEngine, sourceId: string, pageIds: readonly number[]): Promise<Map<number, ExportLedgerRow>> {
  if (!pageIds.length) return new Map();
  const rows = await exec.executeRaw<ExportLedgerRow>(`SELECT source_id, page_id, lifetime, path, path_folded, revision::text, disk_sha256, blob_oid, renderer_fp, seeded_from
    FROM export_ledger WHERE source_id=$1 AND page_id = ANY($2::int[]) AND retired_at IS NULL`, [sourceId, pageIds.map(Number)]);
  return new Map(rows.map(row => [Number(row.page_id), { ...row, page_id: Number(row.page_id), lifetime: Number(row.lifetime) }]));
}
