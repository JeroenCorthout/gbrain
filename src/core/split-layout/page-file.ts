/**
 * Split git layout (Wave B PR 5): the page file a reader outside the publication door sees at a page's canonical path.
 * An ordinary file reads as itself. A split head (a `.md` whose frontmatter declares `gbrain_parts`) reads as the page
 * file F' its parts reassemble to, never as the head: repairs, drift guards and fact maintenance compare and edit the
 * page, and a page write through the door lays it out as head plus parts again. A head whose parts do not verify is a
 * hold (`split_page_incomplete` / `split_head_modified`), never read as a short page.
 *
 * `readPageFile` holds F' in memory, so it is bounded (`PAGE_FILE_MEMORY_MAX_BYTES`, the largest in-memory canonical
 * file the door accepts); a larger split page is the hold `split_page_too_large`. `pageFileSha256` streams instead and
 * has no bound.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { PUSH_SCAN_MAX_FILE_BYTES } from '../page-size-policy.ts';
import { parseHead, type ParsedHead } from './head.ts';
import { partsDirFor } from './paths.ts';
import { splitScratchPath } from './plan.ts';
import { PARTS_KEY } from './types.ts';
import { reassemble, verifyParts, type SplitVerdict } from './verify.ts';

/** The largest reassembled page file `readPageFile` holds in memory: the door's in-memory canonical file ceiling. */
export const PAGE_FILE_MEMORY_MAX_BYTES = PUSH_SCAN_MAX_FILE_BYTES;

export type PageFileHoldCode = 'split_page_incomplete' | 'split_head_modified' | 'split_page_too_large';
/** Why a split head cannot be read as its page file; `message` names the path and the fix. */
export interface PageFileHold { code: PageFileHoldCode; message: string }

/** The page file at a path: its bytes (F' for a split head), and for a split head the head's own bytes. */
export type PageFileRead =
  | { split: false; bytes: Buffer; hold?: undefined }
  | { split: true; bytes: Buffer; head: Buffer; hold?: undefined }
  | { split: true; hold: PageFileHold };

export type PageFileHash =
  | { split: false; sha256: string; hold?: undefined }
  | { split: true; sha256: string; headSha256: string; hold?: undefined }
  | { split: true; hold: PageFileHold };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function holdFor(path: string, verdict: Exclude<SplitVerdict, { ok: true }> | { code: 'split_page_incomplete'; reason: string }): PageFileHold {
  if (verdict.code === 'split_head_modified') return { code: verdict.code, message: `${path} is a split page head whose body was edited (${verdict.reason}), so the page file it names cannot be read; nothing was changed. Preview the resolution with gbrain pages split-storage <slug> --resolve-head keep-edit|discard.` };
  return { code: 'split_page_incomplete', message: `${path} is a split page head whose part files in ${partsDirFor(path)} do not match its manifest (${verdict.reason}), so the page file it names cannot be read; nothing was changed. Restore the head and its parts from Git, then run the command again.` };
}

/** The head at `path` parsed, when its bytes declare a split page: null for an ordinary file, a hold for an unreadable head. */
function parsedHead(path: string, bytes: Buffer): ParsedHead | PageFileHold | null {
  if (!bytes.includes(PARTS_KEY)) return null;
  const parsed = parseHead(bytes.toString('utf8'));
  if (parsed === null) return null;
  return 'error' in parsed ? holdFor(path, parsed.error) : parsed;
}

const isHold = (value: ParsedHead | PageFileHold): value is PageFileHold => 'code' in value;

/** The page file at `path` (which must exist), held in memory: F' for a split head whose parts verify. */
export function readPageFile(path: string, opts: { maxBytes?: number } = {}): PageFileRead {
  const bytes = readFileSync(path);
  const head = parsedHead(path, bytes);
  if (!head) return { split: false, bytes };
  if (isHold(head)) return { split: true, hold: head };
  const max = opts.maxBytes ?? PAGE_FILE_MEMORY_MAX_BYTES;
  const verdict = verifyParts(path, head);
  if (!verdict.ok) return { split: true, hold: holdFor(path, verdict) };
  if (verdict.bytes > max) return { split: true, hold: { code: 'split_page_too_large', message: `${path} is a split page head whose page file is ${verdict.bytes} bytes, more than the ${max} bytes this command reads whole, so it was passed by and nothing was changed.` } };
  const scratch = splitScratchPath();
  try {
    const copied = reassemble(path, head, scratch);
    if (!copied.ok) return { split: true, hold: holdFor(path, copied) };
    return { split: true, bytes: readFileSync(scratch), head: bytes };
  } finally {
    rmSync(scratch, { force: true });
  }
}

/** A head is small, so only a file at most this large is read whole to look for one; a larger file is hashed streamed. */
const HEAD_WINDOW_BYTES = 16 * 1024 ** 2;

function hashWhole(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.allocUnsafe(1024 ** 2);
    for (let at = 0, n: number; (n = readSync(fd, buffer, 0, buffer.length, at)) > 0; at += n) hash.update(buffer.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** SHA-256 of the page file at `path` (which must exist), streamed: F''s for a split head whose parts verify. */
export function pageFileSha256(path: string): PageFileHash {
  if (lstatSync(path).size > HEAD_WINDOW_BYTES) return { split: false, sha256: hashWhole(path) };
  const bytes = readFileSync(path);
  const head = parsedHead(path, bytes);
  if (!head) return { split: false, sha256: sha256(bytes) };
  if (isHold(head)) return { split: true, hold: head };
  const verdict = verifyParts(path, head);
  return verdict.ok ? { split: true, sha256: verdict.sha256, headSha256: sha256(bytes) } : { split: true, hold: holdFor(path, verdict) };
}
