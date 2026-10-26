/**
 * Split git layout (Wave B PR 5): checking and reassembling a split page from disk, or from a commit's tree through a
 * `PartsSource` (git-parts.ts). Part files on disk are read in manifest
 * order through `O_NOFOLLOW` descriptors: a symlink, a directory or any other non-regular entry is never read, and the
 * manifest's paths (validated by parseHead) cannot leave the head's directory; each part is read by its file name in
 * the head's own parts directory (paths.ts `partPathFor`), so a head and directory moved together still verify. Every entry of the parts directory the
 * manifest does not list (a subdirectory included) is `extra`, except, on disk, a regular file named as gbrain's own
 * in-flight atomic write stages a sibling (`.<sha256>.tmp.<uuid>`, atomic-write.ts): a write of the next version.
 *
 * Verdicts: ok; `split_page_incomplete` (missing, extra or mismatched parts, or a body hash that differs), checked
 * first; then `split_head_modified` when the head's body is no longer the one the manifest hashed (`lead_sha256`).
 */
import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import type { ParsedHead } from './head.ts';
import { partPathFor, partsDirName } from './paths.ts';

export type SplitVerdict =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; code: 'split_page_incomplete'; missing: string[]; extra: string[]; mismatched: string[]; reason: string; /** The head's parts directory is absent. */ noDir?: true }
  | { ok: false; code: 'split_head_modified'; reason: string };

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function missingCode(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

/** One part's feed: its bytes go to its own hash, to `sinks` and to `write`. */
type PartFeed = (piece: Uint8Array) => void;
function partFeed(sinks: Hash[], write: PartFeed | null): { feed: PartFeed; digest: () => string } {
  const hash = createHash('sha256');
  return { feed: piece => { hash.update(piece); for (const sink of sinks) sink.update(piece); write?.(piece); }, digest: () => hash.digest('hex') };
}

/**
 * Where a head's part files are read from: its parts directory on disk (`diskParts`), or a commit's tree
 * (git-parts.ts). `list` names the directory's entries; `read` streams one manifest part (its manifest path) into
 * `sinks` and `write` and returns why it does not match its entry, or null.
 */
export interface PartsSource {
  headName: string;
  list(dirName: string): string[] | 'missing' | 'not_a_directory';
  read(partPath: string, bytes: number, sha256: string, sinks: Hash[], write: PartFeed | null): 'missing' | 'mismatched' | null;
}

/** Streams one part file into `sinks`; returns why it does not match its manifest entry, or null. */
function readPart(path: string, bytes: number, sha256: string, sinks: Hash[], write: PartFeed | null): 'missing' | 'mismatched' | null {
  let fd: number;
  try {
    const leaf = lstatSync(path);
    if (!leaf.isFile()) return 'mismatched';
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    return missingCode(error) ? 'missing' : 'mismatched';
  }
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size !== bytes) return 'mismatched';
    const part = partFeed(sinks, write);
    const buffer = Buffer.allocUnsafe(Math.min(SEGMENT_MAX_BYTES, bytes));
    let read = 0;
    for (let n: number; read < bytes && (n = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - read), read)) > 0; read += n) part.feed(buffer.subarray(0, n));
    return read === bytes && part.digest() === sha256 ? null : 'mismatched';
  } finally {
    closeSync(fd);
  }
}

const STAGING_NAME = /^\.[0-9a-f]{64}\.tmp\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The part files beside a head on disk, read through `O_NOFOLLOW` descriptors. */
export function diskParts(headPath: string): PartsSource {
  const headDir = dirname(headPath);
  return {
    headName: basename(headPath),
    list: dirName => {
      const partsDir = join(headDir, dirName);
      try {
        if (!lstatSync(partsDir).isDirectory()) return 'not_a_directory';
        return readdirSync(partsDir).filter(name => !STAGING_NAME.test(name) || lstatSync(join(partsDir, name), { throwIfNoEntry: false })?.isFile() === false);
      } catch (error) {
        if (missingCode(error)) return 'missing';
        throw error;
      }
    },
    read: (partPath, bytes, sha256, sinks, write) => {
      const path = join(headDir, partPath);
      const rel = relative(headDir, path);
      return rel.startsWith('..') || isAbsolute(rel) ? 'mismatched' : readPart(path, bytes, sha256, sinks, write);
    },
  };
}

/** Feeds a part read whole (a Git blob) as `readPart` streams one from disk. */
export function feedPart(content: Buffer, bytes: number, sha256: string, sinks: Hash[], write: PartFeed | null): 'mismatched' | null {
  if (content.length !== bytes) return 'mismatched';
  const part = partFeed(sinks, write);
  for (let at = 0; at < content.length; at += SEGMENT_MAX_BYTES) part.feed(content.subarray(at, at + SEGMENT_MAX_BYTES));
  return part.digest() === sha256 ? null : 'mismatched';
}

/** The shared check; `write` receives F' (the frontmatter without `gbrain_parts`, then the parts) while every part matches. */
function check(source: PartsSource, parsed: ParsedHead, write: PartFeed | null): SplitVerdict {
  const { manifest } = parsed;
  const fail = (reason: string, sets: { missing?: string[]; extra?: string[]; mismatched?: string[]; noDir?: true }): SplitVerdict =>
    ({ ok: false, code: 'split_page_incomplete', missing: sets.missing ?? [], extra: sets.extra ?? [], mismatched: sets.mismatched ?? [], reason, ...(sets.noDir ? { noDir: true as const } : {}) });
  let dirName: string;
  try { dirName = partsDirName(source.headName); } catch { return fail('the head is not a .md file', { missing: manifest.parts.map(part => part.path) }); }
  const listed = manifest.parts.map(part => partPathFor(source.headName, part.path));
  const entries = source.list(dirName);
  if (entries === 'not_a_directory') return fail(`${dirName} is not a directory`, { mismatched: listed });
  if (entries === 'missing') return fail(`${dirName} does not exist`, { missing: listed, noDir: true });
  const names = new Set(listed.map(path => path.slice(dirName.length + 1)));
  const extra = entries.filter(name => !names.has(name)).sort().map(name => `${dirName}/${name}`);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const body = createHash('sha256');
  const file = createHash('sha256');
  const frontmatter = Buffer.from(parsed.frontmatterWithoutParts, 'utf8');
  file.update(frontmatter);
  write?.(frontmatter);
  for (const [i, part] of manifest.parts.entries()) {
    const fault = source.read(listed[i]!, part.bytes, part.sha256, [body, file], missing.length || mismatched.length ? null : write);
    if (fault === 'missing') missing.push(listed[i]!);
    else if (fault === 'mismatched') mismatched.push(listed[i]!);
  }
  if (missing.length || mismatched.length || extra.length) {
    return fail(`${missing.length} missing, ${mismatched.length} mismatched and ${extra.length} unlisted part files`, { missing, extra, mismatched });
  }
  if (body.digest('hex') !== manifest.content_hash) return fail('the parts do not hash to the manifest content_hash', {});
  if (createHash('sha256').update(parsed.headBody).digest('hex') !== manifest.lead_sha256) {
    return { ok: false, code: 'split_head_modified', reason: 'the head body is not the lead and notice the manifest hashed (lead_sha256)' };
  }
  return { ok: true, bytes: frontmatter.length + manifest.total_bytes, sha256: file.digest('hex') };
}

/** Checks a split page's parts (on disk beside `headPath`, or from a `PartsSource`) against its parsed head. `ok` carries F''s size and SHA-256. */
export function verifyParts(headPath: string | PartsSource, parsed: ParsedHead): SplitVerdict {
  return check(typeof headPath === 'string' ? diskParts(headPath) : headPath, parsed, null);
}

/**
 * Writes F' (the head frontmatter without `gbrain_parts`, then the parts in order) to `destPath`, a new private file
 * (`splitScratchPath` names one the staging sweep covers), checking every part as it is copied. On any verdict but ok
 * the file is removed.
 */
export function reassemble(headPath: string | PartsSource, parsed: ParsedHead, destPath: string): SplitVerdict {
  const fd = openSync(destPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let verdict: SplitVerdict | null = null;
  try {
    verdict = check(typeof headPath === 'string' ? diskParts(headPath) : headPath, parsed, piece => { for (let at = 0; at < piece.length;) at += writeSync(fd, piece, at, piece.length - at); });
    return verdict;
  } finally {
    closeSync(fd);
    if (!verdict?.ok) unlinkSync(destPath);
  }
}
