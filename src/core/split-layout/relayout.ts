/**
 * Wave B PR 5 (spec §9 option B): `managed_maintenance_split_relayout`, the coordinated republication of a live page's
 * canonical file with its database row untouched. `gbrain pages split-storage <slug> --apply` (and `--resolve-head
 * discard`) admits it bound to the revision its preview read; a page write whose content is unchanged is a no-op and
 * publishes no file, so changing only how the file is laid out (one file, or a head plus part files) needs its own intent.
 * The preparer renders the stored page (streamed from the segments for a segmented page) and hands it to the ordinary
 * file target, so the write path lays the file out, the recovery record and Git effect cover it, and the coordinator
 * re-checks the revision under its page guard. Trusted local CLI only.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { StreamedFileContent } from '../persistence/large-file.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { PageSnapshot } from '../page-state/types.ts';

export const SPLIT_RELAYOUT_INTENT = 'managed_maintenance_split_relayout';

/** The stored page's canonical file as the write path renders it: streamed from the segments for a segmented page, else the inline render. */
export async function renderedPageFile(engine: BrainEngine, snapshot: PageSnapshot): Promise<string | StreamedFileContent> {
  const { unreadPageFile } = await import('../persistence/page-prepare.ts');
  return isSegmentedPage(snapshot.page) ? unreadPageFile(engine, snapshot) : serializePageToMarkdown(snapshot.page, snapshot.tags);
}

export async function prepareSplitRelayout(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const expected = row.intent?.expected_revision;
  const preview = `gbrain pages split-storage ${row.slug} --source ${row.source_id}`;
  if (row.authority.remote || typeof expected !== 'string') {
    throw opError('invalid_params', 'The split relayout intent does not name the revision it lays out.',
      `Request ${row.request_id} for ${row.slug} in ${row.source_id} is not a local relayout bound to a previewed revision, so nothing changed. Preview again with ${preview}.`);
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.revision !== expected) {
    throw opError('changed_since_preview', `${row.slug} changed since its layout was previewed.`,
      `The page was ${snapshot ? 'written' : 'deleted or purged'} after the preview, so its file was not laid out again. Preview again with ${preview}.`);
  }
  const { prepareFileTarget } = await import('../persistence/page-prepare.ts');
  const file = await prepareFileTarget(engine, row, snapshot, await renderedPageFile(engine, snapshot));
  if (!file) {
    throw opError('invalid_params', `${row.slug} has no canonical file to lay out.`,
      `The page publishes to the database only in source ${row.source_id} (declared database-only, unbound, a mirror or a private page on a strict source), so there is no file to lay out; nothing changed.`);
  }
  return { observedRevision: snapshot.revision, file,
    apply: async () => ({ status: 'relaid_out', slug: row.slug, source_id: row.source_id, noop: false }) };
}
