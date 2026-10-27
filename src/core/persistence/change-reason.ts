/**
 * GBRA-217: a human reason on a page write. One canonical form for every source of a reason (a caller's
 * `reason` parameter, a Git `gbrain-reason:` trailer), admitted before the write request is journaled.
 *
 * Where it lands: the snapshot a write archives carries it (`page_versions.change_reason`, read back as
 * `replaced_because`), and a write whose file reaches Git carries it in the commit as a path-mapped
 * trailer `gbrain-reason: <path>: <text>`. A private page never puts its reason in a commit message, and
 * a repo-less brain keeps it in the database alone (`reason_recorded.git: 'no_repository'`).
 */
import { relative, sep } from 'node:path';
import { opError } from '../ops/contract.ts';
import { scanTextSpans } from '../secret-scan.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { GitCommitNote } from './effect-model.ts';
import { sourceCanonicalGit } from './git-door.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';

export const CHANGE_REASON_MAX = 500;
export const CHANGE_REASON_OPERATIONS: readonly string[] = ['put_page', 'edit_page', 'revert_version'];
export const REASON_TRAILER_KEY = 'gbrain-reason';
const DOCS = 'docs/guides/page-history.md#reasons';

/** Tabs and line breaks become spaces, other control characters go, runs of spaces collapse; empty means absent. */
export function canonicalChangeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\t\n\r\u2028\u2029]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/ {2,}/g, ' ').trim();
  return text || null;
}

/**
 * Admission: the canonical reason, or a refusal before anything is journaled. The value is never echoed: an over-long
 * reason is refused by its length, and a secret by the detector that matched.
 */
export function admitChangeReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw opError('invalid_params', 'reason must be a string.', 'Pass reason as one line of text, or omit it.');
  const reason = canonicalChangeReason(raw);
  if (reason === null) return null;
  const length = [...reason].length;
  if (length > CHANGE_REASON_MAX) {
    throw opError('change_reason_rejected', `reason is ${length} characters after normalisation; the limit is ${CHANGE_REASON_MAX}. Nothing was written.`,
      `Shorten reason to ${CHANGE_REASON_MAX} characters or fewer and retry the same request.`, { reason: 'reason_too_long', docs: DOCS, legacy_error: 'invalid_params' });
  }
  const hit = scanTextSpans(reason).find(span => span.finding !== null);
  if (hit) {
    const offset = [...reason.slice(0, hit.start)].length;
    throw opError('change_reason_rejected', `reason contains what looks like a secret (${hit.finding!.pattern} at character ${offset}). Nothing was written.`,
      'Remove the secret from reason and retry with a new request_id. A reason is stored in page history and can be pushed in a Git commit message.',
      { reason: 'reason_contains_secret', docs: DOCS, legacy_error: 'invalid_params' });
  }
  return reason;
}

/** The reason note for one path, merged into a note another preparer gave (a repair keeps its subject and trailer). */
export function withReasonNote(path: string, reason: string, base?: GitCommitNote): GitCommitNote {
  const trailer = `${REASON_TRAILER_KEY}: ${path}: ${reason}`;
  return base ? { ...base, trailers: [...(base.trailers ?? []), trailer] }
    : { subject: '', line: `${path}: ${reason}`, trailers: [trailer] };
}

export type ReasonGit = 'committed' | 'queued' | 'superseded' | 'not_file_backed' | 'private' | 'no_repository' | 'none';
export interface ReasonRecorded { reason: string; version: boolean; version_why?: 'page_created' | 'no_change'; git: ReasonGit }

/**
 * Wraps a page publication so the snapshot its apply archives carries the reason, and its file's commit note carries the
 * trailer when the page that results is world-visible. The snapshot rows are the ones this transaction created for the
 * page (the page lock is held), whichever writer path made them.
 */
export function withChangeReason(row: WriteRequest, prepared: PreparedMutation): PreparedMutation {
  const reason = CHANGE_REASON_OPERATIONS.includes(row.operation) ? canonicalChangeReason(row.intent?.reason) : null;
  if (!reason) return prepared;
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => {
    const pageId = preimage?.page.id ?? null;
    const [before] = pageId === null ? [] : await tx.executeRaw<{ last: number | string | null }>('SELECT max(id) AS last FROM page_versions WHERE page_id = $1', [pageId]);
    const outcome = await apply(tx, preimage);
    const stamped = pageId === null || prepared.noop ? [] : await tx.executeRaw<{ id: number }>(
      'UPDATE page_versions SET change_reason = $2 WHERE page_id = $1 AND id > $3 RETURNING id', [pageId, reason, Number(before?.last ?? 0)]);
    const [page] = await tx.executeRaw<{ world: boolean }>(
      `SELECT ${privatePagesFilterFragment('p')} AS world FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [row.source_id, row.slug]);
    const world = page?.world === true;
    let git: ReasonGit;
    if (!prepared.file) git = row.authority.databaseOnlyReason === 'no_repo_configured' ? 'no_repository' : world ? 'not_file_backed' : 'private';
    else if (prepared.noop) git = 'none';
    else if (!world) git = 'private';
    else {
      prepared.file.commit = withReasonNote(relative(prepared.file.root, prepared.file.path).split(sep).join('/'), reason, prepared.file.commit);
      git = await sourceCanonicalGit(tx, row.source_id) ? 'committed' : 'queued';
    }
    const recorded: ReasonRecorded = { reason, version: stamped.length > 0, git,
      ...(stamped.length ? {} : { version_why: prepared.observedRevision === null ? 'page_created' : 'no_change' }) };
    return { ...outcome, reason_recorded: recorded };
  };
  return prepared;
}

