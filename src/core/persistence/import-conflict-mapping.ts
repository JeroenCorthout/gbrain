/**
 * Database-canonical memory, wave 3: the hold-code to conflict-kind mapping, as data. A converted source adopts every sync
 * hold as one conflict (docs/designs/DATABASE_CANONICAL_MEMORY.md, "Migration for an existing brain with thousands of held
 * items"); this table says which. The record is keyed by every `GitHoldCode`, so a new hold code does not compile until it
 * has a row here. Read-only in this wave: the observe-mode lane, the census and the published table in the design use it,
 * and nothing converts.
 *
 * A row is a conflict kind, or one of two non-conflicts:
 * - `reclassify`: the hold is about the writer, not the file (a stalled or interrupted write, an uncommitted edit). In
 *   database mode the lane reads the path again and applies its decision table.
 * - `out_of_lane`: the path is not a page file the lane imports (an image, a name that is not a page path).
 * `file_drift` holds refine by their side, deleted state and deletion provenance (`refinements`), first match wins.
 */
import type { GitHoldCode, GitHoldMeta } from './sync-holds.ts';
import { fileDriftSide } from './sync-holds.ts';
import type { IMPORT_CONFLICT_KINDS } from './import-conflicts-schema.ts';

export type ImportConflictKind = typeof IMPORT_CONFLICT_KINDS[number];
export type HoldAdoption = ImportConflictKind | 'reclassify' | 'out_of_lane';

export interface HoldConflictRow {
  kind: HoldAdoption;
  /** Why, in the words the design table publishes. */
  why: string;
  /** Narrower rows for holds whose meta decides the kind; the first whose `when` matches wins, else `kind`. */
  refinements?: ReadonlyArray<{ when: HoldMatch; kind: HoldAdoption; why: string }>;
}

/** The hold fields a refinement reads: the `file_drift` side and deleted state, the hold reason, and the deletion provenance a census attached. */
export interface HoldMatch { side?: string; state?: string; reason?: string; provenance?: string }

const unparseable = (why: string): HoldConflictRow => ({ kind: 'unparseable', why });
const identity = (why: string): HoldConflictRow => ({ kind: 'identity', why });
const reclassify = (why: string): HoldConflictRow => ({ kind: 'reclassify', why });

export const HOLD_CONFLICT_KINDS: Readonly<Record<GitHoldCode, HoldConflictRow>> = {
  file_drift: { kind: 'both_changed', why: 'the file and the page both moved since the last import, or no import record says which did',
    refinements: [
      { when: { side: 'deleted', state: 'file_gone', provenance: 'deleted_by_commit' }, kind: 'deleted_vs_edited', why: 'a commit deleted the file while the page changed; the path stays parked so the exporter never recreates it' },
      { when: { side: 'deleted', state: 'file_gone', provenance: 'deletion_uncommitted' }, kind: 'deleted_uncommitted', why: 'only the worktree lost the file; it closes as a deletion once the removal is committed' },
      { when: { side: 'deleted', state: 'file_gone', provenance: 'never_committed' }, kind: 'never_exported', why: 'Git never committed the file; the default resolution exports the page' },
      { when: { side: 'deleted', state: 'file_gone', reason: 'never_committed' }, kind: 'never_exported', why: 'Git never committed the file; the default resolution exports the page' },
      { when: { side: 'deleted', state: 'file_gone', reason: 'ignored' }, kind: 'never_exported', why: 'the file sits where .gitignore excludes it, so Git never committed it' },
      { when: { side: 'deleted', state: 'file_gone' }, kind: 'deleted_vs_edited', why: 'the file is gone and the page changed; no provenance proves the deletion, so both stay' },
      { when: { side: 'deleted', state: 'tombstone_edited' }, kind: 'both_changed', why: 'the database deleted the page and the file was edited' },
      { when: { side: 'deleted', state: 'purged_differs' }, kind: 'both_changed', why: 'the page was purged and a different file is at its path' },
    ] },
  concurrent_write: { kind: 'both_changed', why: 'a database write landed while the file was imported, so both sides moved' },
  worktree_dirty: { kind: 'reclassify', why: 'an uncommitted edit is an ordinary outside edit to the lane, which reads the bytes again',
    refinements: [{ when: { reason: 'deleted_locally' }, kind: 'deleted_uncommitted', why: 'the worktree deleted a file HEAD still holds' }] },
  absent_from_worktree: { kind: 'deleted_uncommitted', why: 'the worktree lost a file HEAD still holds' },
  file_too_large: { kind: 'too_large_for_lane', why: 'the file is over the 24 MiB request cap' },
  preparation_stalled: reclassify('the write owner stalled, not the file'),
  write_interrupted: reclassify('the database ended the write every time, not the file'),
  settle_mismatch: reclassify('the pass could not settle the path; the lane decides it again from the ledger'),
  page_write_failed: reclassify('the writer failed the same unplaced way; the file is not the problem'),
  invalid_frontmatter: unparseable('the frontmatter does not parse or needs an interpretation'),
  invalid_fence: unparseable('a fence does not compile'),
  frontmatter_slug_conflict: unparseable('the frontmatter slug disagrees with the path'),
  frontmatter_alias_limit: unparseable('frontmatter aliases expand past the bound'),
  rename_held: unparseable('a rename the screen could not confirm'),
  parser_regression: unparseable('a gbrain parser refuses bytes an older gbrain imported'),
  content_rejected: unparseable('the sanity gate rejected the content'),
  write_gate_rejected: unparseable('the write gate rejected the content'),
  purged_content: unparseable('the file carries the content of a purged page'),
  content_null_bytes: unparseable('the text holds a NUL byte'),
  file_unreadable: unparseable('the file is not a readable regular file inside the root'),
  git_object_missing: unparseable('the committed blob is missing and the worktree copy differs or is gone'),
  path_not_utf8: unparseable('the file name is not UTF-8'),
  origin_conflict: identity('several live pages record the file as their origin'),
  legacy_slug_conflict: identity('legacy pages without an origin fold to the file slug'),
  page_identity_changed: identity('sync cannot decide which page the file is'),
  rename_identity_unreadable: identity('the rename identity holds characters the database cannot compare'),
  rename_reconcile_failed: identity('a rename left a possible duplicate page'),
  managed_image_sync_unsupported: { kind: 'out_of_lane', why: 'an image, not a page file' },
  unsupported_path: { kind: 'out_of_lane', why: 'the name is not a page path' },
};

/** The kind a hold adopts as: its code's row, narrowed by the first refinement whose fields all match. */
export function holdConflictKind(code: GitHoldCode, meta: Pick<GitHoldMeta, 'side' | 'sides' | 'state' | 'reason'> = {}, provenance?: string): HoldAdoption {
  const row = HOLD_CONFLICT_KINDS[code];
  const fields: HoldMatch = { side: fileDriftSide(meta), state: meta.state, reason: meta.reason, provenance };
  const hit = row.refinements?.find(r => Object.entries(r.when).every(([key, value]) => fields[key as keyof HoldMatch] === value));
  return hit?.kind ?? row.kind;
}
