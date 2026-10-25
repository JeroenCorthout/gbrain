/**
 * Split git layout (Wave B PR 5): checking and reassembling a split page from disk. Part files are read in manifest
 * order through `O_NOFOLLOW` descriptors: a symlink, a directory or any other non-regular entry is never read, and the
 * manifest's paths (validated by parseHead) cannot leave the head's directory. Every entry of the parts directory the
 * manifest does not list (a subdirectory included) is `extra`.
 *
 * Verdicts: ok; `split_page_incomplete` (missing, extra or mismatched parts, or a body hash that differs), checked
 * first; then `split_head_modified` when the head's body is no longer the one the manifest hashed (`lead_sha256`).
 */
import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import type { ParsedHead } from './head.ts';
import { partsDirName } from './paths.ts';

export type SplitVerdict =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; code: 'split_page_incomplete'; missing: string[]; extra: string[]; mismatched: string[]; reason: string }
  | { ok: false; code: 'split_head_modified'; reason: string };

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function missingCode(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

/** Streams one part into `sinks`; returns why it does not match its manifest entry, or null. */
function readPart(path: string, bytes: number, sha256: string, sinks: Hash[], write: ((piece: Uint8Array) => void) | null): 'missing' | 'mismatched' | null {
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
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(SEGMENT_MAX_BYTES, bytes));
    let read = 0;
    for (let n: number; read < bytes && (n = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - read), read)) > 0; read += n) {
      const piece = buffer.subarray(0, n);
      hash.update(piece);
      for (const sink of sinks) sink.update(piece);
      write?.(piece);
    }
    return read === bytes && hash.digest('hex') === sha256 ? null : 'mismatched';
  } finally {
    closeSync(fd);
  }
}

/** The shared check; `write` receives F' (the frontmatter without `gbrain_parts`, then the parts) while every part matches. */
function check(headPath: string, parsed: ParsedHead, write: ((piece: Uint8Array) => void) | null): SplitVerdict {
  const { manifest } = parsed;
  const headDir = dirname(headPath);
  const listed = manifest.parts.map(part => part.path);
  const fail = (reason: string, sets: { missing?: string[]; extra?: string[]; mismatched?: string[] }): SplitVerdict =>
    ({ ok: false, code: 'split_page_incomplete', missing: sets.missing ?? [], extra: sets.extra ?? [], mismatched: sets.mismatched ?? [], reason });
  let dirName: string;
  try { dirName = partsDirName(basename(headPath)); } catch { return fail('the head is not a .md file', { missing: listed }); }
  if (listed.some(path => path.slice(0, path.indexOf('/')) !== dirName)) return fail(`the manifest's parts are not in ${dirName}`, { missing: listed });
  const partsDir = join(headDir, dirName);
  let entries: string[];
  try {
    if (!lstatSync(partsDir).isDirectory()) return fail(`${dirName} is not a directory`, { mismatched: listed });
    entries = readdirSync(partsDir);
  } catch (error) {
    if (missingCode(error)) return fail(`${dirName} does not exist`, { missing: listed });
    throw error;
  }
  const names = new Set(listed.map(path => path.slice(dirName.length + 1)));
  const extra = entries.filter(name => !names.has(name)).sort().map(name => `${dirName}/${name}`);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const body = createHash('sha256');
  const file = createHash('sha256');
  const frontmatter = Buffer.from(parsed.frontmatterWithoutParts, 'utf8');
  file.update(frontmatter);
  write?.(frontmatter);
  for (const part of manifest.parts) {
    const path = join(headDir, part.path);
    const rel = relative(headDir, path);
    if (rel.startsWith('..') || isAbsolute(rel)) { mismatched.push(part.path); continue; }
    const fault = readPart(path, part.bytes, part.sha256, [body, file], missing.length || mismatched.length ? null : write);
    if (fault === 'missing') missing.push(part.path);
    else if (fault === 'mismatched') mismatched.push(part.path);
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

/** Checks a split page's parts on disk against its parsed head. `ok` carries F''s size and SHA-256. */
export function verifyParts(headPath: string, parsed: ParsedHead): SplitVerdict {
  return check(headPath, parsed, null);
}

/**
 * Writes F' (the head frontmatter without `gbrain_parts`, then the parts in order) to `destPath`, a new private file
 * (`splitScratchPath` names one the staging sweep covers), checking every part as it is copied. On any verdict but ok
 * the file is removed.
 */
export function reassemble(headPath: string, parsed: ParsedHead, destPath: string): SplitVerdict {
  const fd = openSync(destPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let verdict: SplitVerdict | null = null;
  try {
    verdict = check(headPath, parsed, piece => { for (let at = 0; at < piece.length;) at += writeSync(fd, piece, at, piece.length - at); });
    return verdict;
  } finally {
    closeSync(fd);
    if (!verdict?.ok) unlinkSync(destPath);
  }
}
