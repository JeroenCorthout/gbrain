/**
 * Secret scan of split pages (Wave B PR 5, design §3). A page stored split is a head file plus part files of at most
 * 16 MiB each; every part is scanned whole like any other file, and a secret cut across a part boundary is found by
 * scanning each seam: the last SPLIT_SEAM_SCAN_BYTES of part k joined with the first SPLIT_SEAM_SCAN_BYTES of part
 * k+1. A seam claim is reported only when it crosses the seam (its value spans it, or its anchor such as `Bearer ` or
 * an assignment key ends in part k and its value starts in part k+1); a claim wholly inside one part is the whole-part
 * scan's. It is reported against part k, where its match starts: `line` is the line in part k and `seam.offset` the
 * byte offset in part k where the match starts. A part the caller cannot read (missing, or over its scan cap) leaves
 * the seams on either side of it to the caller's cap rule.
 */
import { dirname, isAbsolute, join, relative } from 'path';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'fs';
import { parseHead } from './split-layout/head.ts';
import { PARTS_KEY } from './split-layout/types.ts';
import { pathAllowlisted } from './secret-scan-allowlist.ts';
import { SCAN_MAX_FILE_BYTES, scanTextSpans, type ScanOpts, type SecretFinding } from './secret-scan.ts';

/** Bytes of each side of a seam the boundary scan joins. */
export const SPLIT_SEAM_SCAN_BYTES = 4 * 1024;

export interface SplitSeamFinding extends SecretFinding {
  file: string;
  /** The part after the seam, and the byte offset in `file` where the match starts. */
  seam: { next: string; offset: number };
}

/** The part paths (relative to the head's directory, in manifest order) of a split head with a readable manifest; otherwise null. */
export function splitHeadParts(text: string): string[] | null {
  if (!text.includes(PARTS_KEY)) return null;
  const parsed = parseHead(text);
  return parsed && !('error' in parsed) ? parsed.manifest.parts.map(part => part.path) : null;
}

function newlines(bytes: Uint8Array, end: number): number {
  let count = 0;
  for (let at = bytes.indexOf(0x0a); at >= 0 && at < end; at = bytes.indexOf(0x0a, at + 1)) count++;
  return count;
}

/** The claims crossing each seam between adjacent `parts` (display paths, in order); `read(i)` is part i's bytes, or null to skip its seams. */
export function scanSplitSeams(parts: readonly string[], read: (index: number) => Buffer | null, opts: ScanOpts = {}): SplitSeamFinding[] {
  const out: SplitSeamFinding[] = [];
  let next = parts.length > 1 ? read(0) : null;
  for (let k = 0; k + 1 < parts.length; k++) {
    const before = next;
    next = read(k + 1);
    if (!before || !next) continue;
    let tailStart = Math.max(0, before.length - SPLIT_SEAM_SCAN_BYTES);
    while (tailStart > 0 && tailStart < before.length && (before[tailStart]! & 0xc0) === 0x80) tailStart++;
    const seam = before.toString('utf8', tailStart).length;
    const text = before.toString('utf8', tailStart) + next.toString('utf8', 0, Math.min(next.length, SPLIT_SEAM_SCAN_BYTES));
    let baseLine: number | null = null;
    for (const span of scanTextSpans(text, opts)) {
      const crosses = span.start < seam && span.end > seam;
      const anchored = span.from < seam && span.start >= seam && span.start - span.from > 1;
      if (!span.finding || !(crosses || anchored)) continue;
      baseLine ??= newlines(before, tailStart);
      out.push({ ...span.finding, file: parts[k]!, line: baseLine + span.finding.line,
        seam: { next: parts[k + 1]!, offset: tailStart + Buffer.byteLength(text.slice(0, span.from)) } });
    }
  }
  return out;
}

/** `scanFiles`' rule for a split head on disk: its part paths beside it, and the seam findings of the parts within the scan cap. */
export function scanSplitHeadOnDisk(headPath: string, text: string, opts: ScanOpts = {}): { parts: string[]; findings: SplitSeamFinding[] } | null {
  const rels = headPath.endsWith('.md') ? splitHeadParts(text) : null;
  if (!rels) return null;
  const parts = rels.map(rel => join(dirname(headPath), rel));
  const read = (index: number): Buffer | null => {
    const path = parts[index]!;
    const rel = opts.workspaceRoot && isAbsolute(path) ? relative(opts.workspaceRoot, path) : path;
    if (pathAllowlisted(rel, opts.allowlist ?? [])) return null;
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
    try {
      const stat = fstatSync(fd);
      return stat.isFile() && stat.size <= SCAN_MAX_FILE_BYTES ? readFileSync(fd) : null;
    } finally { closeSync(fd); }
  };
  return { parts, findings: scanSplitSeams(parts, read, opts) };
}
