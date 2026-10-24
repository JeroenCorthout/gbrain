/**
 * Database-canonical memory, wave 5b: `put_page resolves_conflict` (docs/designs/database-canonical-w5-contract.md, "put_page
 * resolves_conflict"). Admission binds a revision-bound put_page to one open live import conflict of the page it writes and
 * pins the conflict's file hash in the stored intent; publication closes the conflict in the page's own transaction with a
 * compare-and-set on that hash and makes the stored file the exporter's base, so the exporter replaces the file with the
 * written page. Only the three kinds a page write settles are writable, so an agent write can never make the exporter
 * recreate a file deliberately deleted.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';

export const WRITABLE_CONFLICT_KINDS: ReadonlySet<string> = new Set(['both_changed', 'unexported_collision', 'protected_metadata']);
export const RESOLVES_CONFLICT_SHA_KEY = 'resolves_conflict_sha256';

const listHint = (sourceId: string) => `List the open conflicts again (list_source_conflicts, or gbrain sources conflicts ${sourceId} list on the brain host) and use an id from that list.`;

/** Validates `resolves_conflict` at admission; returns the conflict's file hash to pin in the intent. */
export async function admitConflictResolution(engine: BrainEngine, input: { operation: string; sourceId: string; slug: string; conflictId: unknown; expectedRevision: unknown }): Promise<string | null> {
  const id = Number(input.conflictId);
  if (input.operation !== 'put_page' || !Number.isSafeInteger(id) || id <= 0) {
    throw opError('invalid_params', 'resolves_conflict takes the id of an open import conflict and works with put_page only.', listHint(input.sourceId));
  }
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision) {
    throw opError('revision_required', 'resolves_conflict requires expected_revision.', 'Read the page with get_page and pass its revision as expected_revision.');
  }
  const [c] = await engine.executeRaw<{ state: string; outcome: string; kind: string; page_id: number | null; file_sha256: string | null; live_page_id: number | null }>(
    `SELECT c.state, c.outcome, c.kind, c.page_id, c.file_sha256,
       (SELECT p.id FROM pages p WHERE p.source_id=$2 AND p.slug=$3 AND p.deleted_at IS NULL) AS live_page_id
     FROM import_conflicts c WHERE c.id=$1 AND c.source_id=$2`, [id, input.sourceId, input.slug]);
  if (!c || c.outcome !== 'conflict' || c.page_id === null || c.live_page_id === null || Number(c.page_id) !== Number(c.live_page_id)) {
    throw opError('import_conflict_not_found', `No open import conflict ${id} belongs to page ${input.slug} of source ${input.sourceId}.`, listHint(input.sourceId));
  }
  if (c.state !== 'open') throw opError('import_conflict_stale', `Import conflict ${id} is already closed; nothing was written.`, listHint(input.sourceId));
  if (!WRITABLE_CONFLICT_KINDS.has(c.kind)) {
    throw opError('import_conflict_not_writable', `A ${c.kind} conflict is not settled by a page write; nothing was written.`,
      `Ask the brain host operator to run gbrain sources conflicts ${input.sourceId} resolve ${id} --take database --dry-run (or --take file).`);
  }
  return c.file_sha256;
}

/** Inside the page's publication transaction: close the conflict if it still holds the pinned file, else fail the write. */
export async function closeResolvedConflict(tx: BrainEngine, input: { sourceId: string; slug: string; pageId: number | null; conflictId: unknown; fileSha256: unknown }): Promise<void> {
  const sha = typeof input.fileSha256 === 'string' ? input.fileSha256 : null;
  const [closed] = await tx.executeRaw<{ path_folded: string }>(
    `UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='written'
     WHERE id=$1 AND source_id=$2 AND page_id=$3 AND state='open' AND file_sha256 IS NOT DISTINCT FROM $4 RETURNING path_folded`,
    [Number(input.conflictId), input.sourceId, input.pageId, sha]);
  if (!closed) {
    throw opError('import_conflict_stale', `Import conflict ${String(input.conflictId)} of page ${input.slug} closed or changed since admission; nothing was written.`, listHint(input.sourceId));
  }
  if (sha) await tx.executeRaw('UPDATE export_ledger SET disk_sha256=$3 WHERE source_id=$1 AND path_folded=$2 AND retired_at IS NULL', [input.sourceId, closed.path_folded, sha]);
  await tx.executeRaw(`INSERT INTO export_outbox(source_id, page_id, slug, revision, cause, first_enqueued_at)
      SELECT p.source_id, p.id, p.slug, p.knowledge_revision, 'written', now() FROM pages p WHERE p.id=$1 AND p.source_id=$2 AND p.deleted_at IS NULL
    ON CONFLICT (source_id, page_id) DO UPDATE SET seq=export_outbox.seq`, [input.pageId, input.sourceId]);
}
