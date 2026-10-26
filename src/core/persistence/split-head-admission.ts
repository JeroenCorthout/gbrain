/**
 * Wave B PR 5 (split git layout): the page-write admission check for a top-level `gbrain_parts` key, kept out of
 * split-layout/head.ts so the head parser stays free of the operation-error graph (the embedded chunker smoketest
 * compiles head.ts).
 */
import { opError } from '../ops/contract.ts';
import { parseHead } from '../split-layout/head.ts';
import { PARTS_KEY } from '../split-layout/types.ts';

/**
 * A page write's admission (put_page, capture, edit_page, and the commit_page_upload preparation) and the split preflight
 * of every file writer outside the door (split-write-through.ts, with no `sourceId`): content whose own frontmatter
 * declares a top-level `gbrain_parts` key is refused, since that key marks a split page head in Git and the page would
 * be read back as one. Sync reads heads through the split read path and never comes here.
 */
export function assertNoReservedPartsKey(content: string, sourceId?: string): void {
  if (!content.includes(PARTS_KEY) || parseHead(content) === null) return;
  throw opError('split_head_content', 'The content is a split page head, not a page file, so it was not written.',
    'The content has a top-level gbrain_parts key: it is the head file of a split page (the first bytes of the page and the manifest of its part files), read and written back as if it were the whole page. '
    + 'Nothing was written. Write the whole page instead (gbrain get gives it whole), or rename the key if it is your own data.'
    + (sourceId === undefined ? '' : ` If the key came from the stored page, that copy is the short head an older gbrain imported; ask the user to run gbrain sync --source ${sourceId} --no-pull on the brain host, which rebuilds the whole page.`),
    { docs: 'docs/guides/write-refusals.md#split_head_content' });
}
