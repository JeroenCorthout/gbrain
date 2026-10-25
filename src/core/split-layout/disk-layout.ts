/**
 * Split git layout (Wave B PR 5): what a page's canonical path holds on disk, read without writing anything. A path
 * holds nothing, one file, or a split head (a `.md` whose frontmatter declares `gbrain_parts`) with its parts
 * directory. `readHead` only parses the head; `readCanonicalLayout` also checks the parts (verifyParts), which streams
 * every part once. Reads are bounded: a file larger than any head this format writes is read only in its first
 * frontmatter window, so an oversize single file is never held whole.
 *
 * Used by `gbrain pages split-storage` (preview and apply checks) and doctor `split_layout` /
 * `oversize_canonical_file`.
 */
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../page-body/limits.ts';
import { parseHead, type ParsedHead } from './head.ts';
import { splitLimits } from './limits.ts';
import { partsDirFor } from './paths.ts';
import { verifyParts, type SplitVerdict } from './verify.ts';

/** Bytes a manifest entry takes at most in the head's frontmatter (path, bytes and sha256 lines, YAML indent). */
const MANIFEST_ENTRY_MAX_BYTES = 192;

/** The largest file that can be a head: the page frontmatter window, the manifest, the lead and the notice. */
export function headReadMaxBytes(): number {
  return FRONTMATTER_HEAD_MAX_BYTES + splitLimits.partCountMax * MANIFEST_ENTRY_MAX_BYTES + splitLimits.leadMax + 4096;
}

export type HeadRead =
  | { kind: 'missing' }
  | { kind: 'single'; bytes: number }
  | { kind: 'split'; bytes: number; parsed: ParsedHead }
  | { kind: 'invalid_head'; bytes: number; reason: string };

export type CanonicalLayout =
  | { kind: 'missing'; partsDirEntries: string[] }
  | { kind: 'single'; bytes: number; partsDirEntries: string[] }
  | { kind: 'split'; headBytes: number; parsed: ParsedHead | null; verdict: SplitVerdict; partsDirEntries: string[] };

function readPrefix(path: string, length: number): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    for (let n: number; read < length && (n = readSync(fd, buffer, read, length - read, read)) > 0;) read += n;
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** What the file at `path` is, by its head only (no part is read). A symlink or directory there reads as missing. */
export function readHead(path: string): HeadRead {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { kind: 'missing' };
  if (stat.size > headReadMaxBytes()) {
    const declared = parseHead(readPrefix(path, FRONTMATTER_HEAD_MAX_BYTES));
    return declared === null ? { kind: 'single', bytes: stat.size }
      : { kind: 'invalid_head', bytes: stat.size, reason: `the file declares gbrain_parts but is ${stat.size} bytes, larger than any split page head` };
  }
  const parsed = parseHead(readFileSync(path, 'utf8'));
  if (parsed === null) return { kind: 'single', bytes: stat.size };
  if ('error' in parsed) return { kind: 'invalid_head', bytes: stat.size, reason: parsed.error.reason };
  return { kind: 'split', bytes: stat.size, parsed };
}

/** Entry names of the parts directory beside `headPath`, sorted; empty when it is absent or not a directory. */
export function partsDirEntries(headPath: string): string[] {
  const dir = partsDirFor(headPath);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).sort();
}

/** The layout at a page's canonical path, with the parts checked against the head when it is split. */
export function readCanonicalLayout(path: string): CanonicalLayout {
  const head = readHead(path);
  const entries = partsDirEntries(path);
  if (head.kind === 'missing') return { kind: 'missing', partsDirEntries: entries };
  if (head.kind === 'single') return { kind: 'single', bytes: head.bytes, partsDirEntries: entries };
  if (head.kind === 'invalid_head') {
    return { kind: 'split', headBytes: head.bytes, parsed: null, partsDirEntries: entries,
      verdict: { ok: false, code: 'split_page_incomplete', missing: [], extra: [], mismatched: [], reason: head.reason } };
  }
  return { kind: 'split', headBytes: head.bytes, parsed: head.parsed, verdict: verifyParts(path, head.parsed), partsDirEntries: entries };
}
