/**
 * Split git layout (Wave B PR 5): planning a split. `planSplit` streams the page's canonical file F once (the
 * serializer's output, or `unreadPageFile`'s `StreamedFileContent` for a segmented page) into a private staged copy,
 * then cuts the body from that copy: it holds at most one part window (`partMax` + 1 bytes), the lead and the
 * frontmatter in memory, and every part is later produced as a byte range of the staged copy, never by streaming the
 * database again.
 *
 * F = frontmatter block (`---\n ... \n---\n`) + body B. Greedy cuts from the start of B: a part ends at the last line
 * break at or below `partTarget` bytes; without one, at the first line break after it up to `partMax`; without one, at
 * the last UTF-8 character boundary at or below `partMax`. A remainder of at most `partTarget` bytes (or one with no
 * line break up to its end within `partMax`) is the last part. Each cut depends only on the bytes before it, so an
 * append changes the last part and may add parts; earlier parts keep their bytes and names.
 *
 * A leading BOM is dropped (import reads a BOM as encoding noise, #4798; the serializer never writes one), so the
 * reassembled file is F without it. The staged copy lives under the persistence home in `split-staging/` as
 * `<pid>-<uuid>.page`: `dispose` removes it after publication, and `sweepSplitStaging` removes a copy whose process is
 * gone or that is older than a day.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { FRONTMATTER_HEAD_MAX_BYTES, SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import { StreamedFileContent } from '../persistence/large-file.ts';
import { persistenceHome } from '../persistence/identity.ts';
import { assertNoPartsKey, headBodyFor, renderHead, splitNotice } from './head.ts';
import { splitLimits } from './limits.ts';
import { partFileName, partsDirName } from './paths.ts';
import { SPLIT_FORMAT, SplitLayoutError, type SplitManifest } from './types.ts';

/** One planned part: `path` is relative to the head's directory; `start`/`end` are its byte range in F. */
export interface SplitPart {
  index: number;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  start: number;
  end: number;
}

const STAGING_DIR = 'split-staging';
const STAGED_NAME = /^(\d+)-[0-9a-f-]{36}\.(page|reassembled)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const BOM = [0xef, 0xbb, 0xbf];
const HEAD_LIMIT = FRONTMATTER_HEAD_MAX_BYTES + BOM.length;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The private directory staged copies live in (created 0700). */
export function splitStagingDir(): string {
  const dir = join(persistenceHome(), STAGING_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A fresh private path in the staging directory, for a reassembled file (verify.ts `reassemble`); the sweep covers it. */
export function splitScratchPath(): string {
  return join(splitStagingDir(), `${process.pid}-${randomUUID()}.reassembled`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Removes staged copies and reassembled files left by a process that is gone, or older than `maxAgeMs`. Returns how many. */
export function sweepSplitStaging(opts: { maxAgeMs?: number; now?: number } = {}): number {
  const dir = splitStagingDir();
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? DAY_MS);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = STAGED_NAME.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || (processAlive(Number(match[1])) && stat.mtimeMs >= cutoff)) continue;
    rmSync(path, { force: true });
    removed++;
  }
  return removed;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
}

function readAt(fd: number, buffer: Buffer, length: number, position: number): Buffer {
  for (let at = 0, n: number; at < length; at += n) {
    n = readSync(fd, buffer, at, length - at, position + at);
    if (n <= 0) throw new SplitLayoutError('staged_file_changed', 'The staged copy of the page file is shorter than when it was written; plan the split again.');
  }
  return buffer.subarray(0, length);
}

/** The largest cut at or below `at` that does not split a UTF-8 character (`at` itself for bytes that are not UTF-8). */
function charBoundary(window: Uint8Array, at: number): number {
  for (let cut = at; cut > 0 && at - cut <= 3; cut--) if ((window[cut]! & 0xc0) !== 0x80) return cut;
  return at;
}

/** Streams the source into the staged file; returns the file size and its first HEAD_LIMIT bytes. */
async function stage(source: AsyncIterable<Uint8Array>, path: string): Promise<{ size: number; head: Buffer }> {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const head = Buffer.alloc(HEAD_LIMIT);
  let size = 0;
  try {
    for await (const chunk of source) {
      if (size < HEAD_LIMIT) head.set(chunk.subarray(0, HEAD_LIMIT - size), size);
      writeAll(fd, chunk);
      size += chunk.length;
    }
  } finally {
    closeSync(fd);
  }
  return { size, head: head.subarray(0, Math.min(size, HEAD_LIMIT)) };
}

/** Where B starts in the staged file, past an optional BOM and the frontmatter block, and the block's text. */
function frontmatterOf(head: Buffer, size: number): { bom: number; bodyStart: number; frontmatter: string } {
  const bom = BOM.every((byte, i) => head[i] === byte) ? BOM.length : 0;
  const text = head.toString('latin1', bom);
  const opening = /^---\r?\n/.exec(text);
  if (!opening) throw new SplitLayoutError('not_a_page_file', 'A split page file starts with a --- frontmatter line.');
  const closing = /\n---[ \t]*\r?\n/g;
  closing.lastIndex = opening[0].length - 1;
  const found = closing.exec(text);
  if (!found) {
    throw size > HEAD_LIMIT
      ? new SplitLayoutError('frontmatter_too_large', `The page frontmatter does not close within the first ${FRONTMATTER_HEAD_MAX_BYTES} bytes.`)
      : new SplitLayoutError('not_a_page_file', 'The page frontmatter does not close with a --- line followed by a line break.');
  }
  const bodyStart = bom + found.index + found[0].length;
  let frontmatter: string;
  try { frontmatter = utf8.decode(head.subarray(bom, bodyStart)); } catch { throw new SplitLayoutError('not_utf8', 'The page frontmatter is not valid UTF-8.'); }
  if (bodyStart >= size) throw new SplitLayoutError('body_empty', 'The page has no body after its frontmatter, so there is nothing to put in part files.');
  return { bom, bodyStart, frontmatter };
}

interface Cuts { leadBytes: number; lead: string; bodyHash: string; parts: Array<{ start: number; bytes: number; sha256: string }> }

/** The lead and the greedy part cuts of B = the staged file's bytes from `bodyStart` on, read one window at a time. */
function cutBody(fd: number, bodyStart: number, bodyBytes: number): Cuts {
  const { partTarget, partMax, leadMax, partCountMax } = splitLimits;
  const buffer = Buffer.allocUnsafe(Math.min(bodyBytes, Math.max(partMax, leadMax) + 1));
  const leadWindow = readAt(fd, buffer, Math.min(bodyBytes, leadMax + 1), bodyStart);
  const lastBreak = bodyBytes <= leadMax ? -1 : leadWindow.lastIndexOf(0x0a, leadMax - 1);
  const leadBytes = bodyBytes <= leadMax ? bodyBytes : lastBreak >= 0 ? lastBreak + 1 : charBoundary(leadWindow, leadMax);
  let lead: string;
  try { lead = utf8.decode(leadWindow.subarray(0, leadBytes)); } catch { throw new SplitLayoutError('not_utf8', 'The page body is not valid UTF-8.'); }
  const bodyHash = createHash('sha256');
  const parts: Cuts['parts'] = [];
  for (let start = 0; start < bodyBytes;) {
    const remaining = bodyBytes - start;
    const window = readAt(fd, buffer, Math.min(remaining, partMax + 1), bodyStart + start);
    let bytes = remaining;
    if (remaining > partTarget) {
      const last = window.lastIndexOf(0x0a, partTarget - 1);
      const first = last >= 0 ? -1 : window.indexOf(0x0a, partTarget);
      if (last >= 0) bytes = last + 1;
      else if (first >= 0 && first < partMax) bytes = first + 1;
      else if (remaining > partMax) bytes = charBoundary(window, partMax);
    }
    if (parts.length >= partCountMax) throw new SplitLayoutError('too_many_parts', `The page body needs more than ${partCountMax} part files.`);
    const piece = window.subarray(0, bytes);
    bodyHash.update(piece);
    parts.push({ start, bytes, sha256: createHash('sha256').update(piece).digest('hex') });
    start += bytes;
  }
  return { leadBytes, lead, bodyHash: bodyHash.digest('hex'), parts };
}

/**
 * A planned split, backed by the private staged copy of F. `frontmatter` is F's frontmatter block (opening through
 * closing line), `headBody` the head's body (lead and notice), `manifest` the `gbrain_parts` value. Call `dispose`
 * once the publication that used it has finished (or failed).
 */
export class SplitPlan {
  constructor(
    readonly stagedPath: string,
    private readonly offset: number,
    readonly frontmatter: string,
    readonly lead: string,
    readonly notice: string,
    readonly headBody: string,
    readonly parts: readonly SplitPart[],
    readonly bodyBytes: number,
    readonly bodyHash: string,
    readonly fileBytes: number,
    readonly manifest: SplitManifest,
  ) {}

  /** The head file's text (renderHead). */
  head(): string { return renderHead(this); }

  /** Bytes `[start, end)` of F from the staged copy, in pieces of at most a segment. */
  async *range(start: number, end: number): AsyncIterable<Uint8Array> {
    const fd = openSync(this.stagedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (fstatSync(fd).size !== this.offset + this.fileBytes) throw new SplitLayoutError('staged_file_changed', 'The staged copy of the page file changed after planning; plan the split again.');
      for (let at = start; at < end;) {
        const piece = readAt(fd, Buffer.allocUnsafe(Math.min(SEGMENT_MAX_BYTES, end - at)), Math.min(SEGMENT_MAX_BYTES, end - at), this.offset + at);
        at += piece.length;
        yield piece;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** A part's bytes as a publication source (measured once from the staged copy and checked against the plan). */
  async partContent(engine: BrainEngine, part: SplitPart): Promise<StreamedFileContent> {
    const content = await StreamedFileContent.measure(engine, () => this.range(part.start, part.end));
    if (content.bytes !== part.bytes || content.hash !== part.sha256) {
      throw new SplitLayoutError('staged_file_changed', 'The staged copy of the page file changed after planning; plan the split again.');
    }
    return content;
  }

  /** Removes the staged copy; safe to call more than once. */
  dispose(): void {
    try { unlinkSync(this.stagedPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/**
 * Plans the split of a page's canonical file F for the head at `opts.headPath` (relative or absolute; only its file
 * name is used). Throws SplitLayoutError for a file the layout cannot hold; the staged copy is removed then.
 */
export async function planSplit(source: AsyncIterable<Uint8Array>, opts: { headPath: string }): Promise<SplitPlan> {
  const dirName = partsDirName(basename(opts.headPath));
  const stagedPath = join(splitStagingDir(), `${process.pid}-${randomUUID()}.page`);
  try {
    const { size, head } = await stage(source, stagedPath);
    const { bom, bodyStart, frontmatter } = frontmatterOf(head, size);
    assertNoPartsKey(frontmatter);
    const bodyBytes = size - bodyStart;
    const fd = openSync(stagedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let cuts: Cuts;
    try { cuts = cutBody(fd, bodyStart, bodyBytes); } finally { closeSync(fd); }
    const fmBytes = bodyStart - bom;
    const parts = cuts.parts.map((part, i): SplitPart => {
      const name = partFileName(i + 1, part.sha256);
      return { index: i + 1, name, path: `${dirName}/${name}`, bytes: part.bytes, sha256: part.sha256, start: fmBytes + part.start, end: fmBytes + part.start + part.bytes };
    });
    const notice = splitNotice(parts.length, bodyBytes);
    const headBody = headBodyFor(cuts.lead, notice);
    const manifest: SplitManifest = {
      format: SPLIT_FORMAT,
      total_bytes: bodyBytes,
      content_hash: cuts.bodyHash,
      lead_bytes: cuts.leadBytes,
      lead_sha256: createHash('sha256').update(headBody).digest('hex'),
      parts: parts.map(part => ({ path: part.path, bytes: part.bytes, sha256: part.sha256 })),
    };
    return new SplitPlan(stagedPath, bom, frontmatter, cuts.lead, notice, headBody, parts, bodyBytes, cuts.bodyHash, size - bom, manifest);
  } catch (error) {
    try { unlinkSync(stagedPath); } catch { /* never created, or already gone */ }
    throw error;
  }
}
