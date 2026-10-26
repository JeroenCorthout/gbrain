/**
 * Split git layout (Wave B PR 5): the page file a split head stands for at a Git revision, from blobs rather than from
 * disk. A caller that compares a committed page with the database (the git-gap census, the overwritten-edits hold) reads
 * the head blob and the blobs of the parts its manifest lists, and gets F' as `readPageFile` would read it from a checkout:
 * an ordinary blob reads as itself; a head whose listed parts are missing, unlisted, of another size or hash, or whose
 * body is not the one the manifest hashed is a hold; a page file over the in-memory bound is `split_page_too_large`.
 */
import { createHash } from 'node:crypto';
import { parseHead } from './head.ts';
import { PAGE_FILE_MEMORY_MAX_BYTES, type PageFileHold, type PageFileRead } from './page-file.ts';
import { PARTS_KEY } from './types.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The head blob parsed when it declares a split page: null for an ordinary page file. */
export function revisionHead(head: Buffer): ReturnType<typeof parseHead> {
  return head.includes(PARTS_KEY) ? parseHead(head.toString('utf8')) : null;
}

/**
 * The page file `path` names at `revision` (both only for messages): F' from the head blob and `parts`, the revision's
 * blobs of the parts directory keyed by their path relative to the head's directory (the manifest's form). An entry the
 * manifest does not list makes the page incomplete, as it does on disk; a caller that read only the listed parts passes
 * just those.
 */
export function pageFileAtRevision(path: string, revision: string, head: Buffer, parts: ReadonlyMap<string, Buffer>,
  opts: { maxBytes?: number } = {}): PageFileRead {
  const parsed = revisionHead(head);
  if (parsed === null) return { split: false, bytes: head };
  const hold = (code: PageFileHold['code'], reason: string): PageFileRead => ({ split: true, hold: { code, message: code === 'split_head_modified'
    ? `${path} at ${revision} is a split page head whose body was edited (${reason}), so the page file it names cannot be read; nothing was changed. Preview the resolution with gbrain pages split-storage <slug> --resolve-head keep-edit|discard.`
    : code === 'split_page_too_large' ? `${path} at ${revision} is a split page head whose page file is ${reason}, so it was passed by and nothing was changed.`
      : `${path} at ${revision} is a split page head whose committed part files do not match its manifest (${reason}), so the page file it names cannot be read; nothing was changed. Restore the head and its parts in Git, then run the command again.` } });
  if ('error' in parsed) return hold('split_page_incomplete', parsed.error.reason);
  const { manifest } = parsed;
  const listed = new Set(manifest.parts.map(part => part.path));
  const extra = [...parts.keys()].filter(name => !listed.has(name));
  if (extra.length) return hold('split_page_incomplete', `${extra.length} unlisted part files`);
  const frontmatter = Buffer.from(parsed.frontmatterWithoutParts, 'utf8');
  const max = opts.maxBytes ?? PAGE_FILE_MEMORY_MAX_BYTES;
  if (frontmatter.length + manifest.total_bytes > max) return hold('split_page_too_large', `${frontmatter.length + manifest.total_bytes} bytes, more than the ${max} bytes this command reads whole`);
  const pieces: Buffer[] = [];
  for (const part of manifest.parts) {
    const blob = parts.get(part.path);
    if (!blob) return hold('split_page_incomplete', `part ${part.path} is missing`);
    if (blob.length !== part.bytes || sha256(blob) !== part.sha256) return hold('split_page_incomplete', `part ${part.path} does not match its manifest entry`);
    pieces.push(blob);
  }
  const body = Buffer.concat(pieces);
  if (sha256(body) !== manifest.content_hash) return hold('split_page_incomplete', 'the parts do not hash to the manifest content_hash');
  if (sha256(Buffer.from(parsed.headBody, 'utf8')) !== manifest.lead_sha256) return hold('split_head_modified', 'the head body is not the lead and notice the manifest hashed (lead_sha256)');
  return { split: true, bytes: Buffer.concat([frontmatter, body]), head };
}
