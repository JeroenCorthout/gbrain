/**
 * Split git layout (Wave B PR 5): keeping an edit made to a split page's head (`split_head_modified`). The page file F
 * that keeps the edit is the head's frontmatter without `gbrain_parts` (frontmatter edits are kept as they are), the
 * edited head body without the notice line, then the page body from the parts after the lead, B[lead_bytes:]. The
 * parts are read once, in manifest order, through `O_NOFOLLOW` descriptors, and the whole body they hold is checked
 * against the manifest's `content_hash` while it is copied; F is written to a new private file the caller names
 * (`splitScratchPath`, which the staging sweep covers) and removed again on any failure.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import type { ParsedHead } from './head.ts';
import { partFilePath } from './paths.ts';

/** The notice line `splitNotice` writes, matched by its shape (any part count and size). */
const NOTICE_LINE = /^> \[gbrain\] This page continues in \d+ part files? \([^)\n]*\)\. Current gbrain versions read them; older versions see only this lead\.(?:\n|$)/gm;

/**
 * The edited head body without its notice line (the last one, when an edit copied it). `headBodyFor` put a line break
 * before the notice when the lead did not end in one; that break is dropped again when the notice was the last line.
 */
export function editedLead(headBody: string, leadEndsWithBreak: boolean): string {
  const last = [...headBody.matchAll(NOTICE_LINE)].at(-1);
  if (!last) return headBody;
  const before = headBody.slice(0, last.index);
  const after = headBody.slice(last.index + last[0].length);
  return (!leadEndsWithBreak && !after && before.endsWith('\n') ? before.slice(0, -1) : before) + after;
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
}

/** Streams every part of the manifest in order to `visit` with the body offset of each piece; false when a part is missing or not its listed size. */
function streamParts(headPath: string, parsed: ParsedHead, visit: (piece: Buffer, offset: number) => void): boolean {
  let offset = 0;
  const buffer = Buffer.allocUnsafe(SEGMENT_MAX_BYTES);
  for (const part of parsed.manifest.parts) {
    let fd: number;
    try { fd = openSync(partFilePath(headPath, part.path), READ_FLAGS); } catch { return false; }
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size !== part.bytes) return false;
      for (let read = 0, n: number; read < part.bytes; read += n) {
        n = readSync(fd, buffer, 0, Math.min(buffer.length, part.bytes - read), read);
        if (n <= 0) return false;
        visit(buffer.subarray(0, n), offset);
        offset += n;
      }
    } finally {
      closeSync(fd);
    }
  }
  return true;
}

export type KeptEdit = { ok: true; bytes: number; sha256: string; leadBytes: number } | { ok: false; reason: string };

/**
 * Writes F with the head's edit kept to `destPath` (created, 0600). Returns its size and SHA-256 and the kept lead's
 * byte count, or why the parts no longer hold the body the manifest describes (nothing is left at `destPath` then).
 */
export function writeKeptEdit(headPath: string, parsed: ParsedHead, destPath: string): KeptEdit {
  const { lead_bytes: leadBytes, content_hash: contentHash } = parsed.manifest;
  let leadLast = -1;
  if (!streamParts(headPath, parsed, (piece, offset) => {
    if (offset <= leadBytes - 1 && leadBytes - 1 < offset + piece.length) leadLast = piece[leadBytes - 1 - offset]!;
  })) return { ok: false, reason: 'a part file is missing or not the size its manifest entry lists' };
  const lead = Buffer.from(editedLead(parsed.headBody, leadLast === 0x0a), 'utf8');
  const fd = openSync(destPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const file = createHash('sha256');
  const body = createHash('sha256');
  let bytes = 0;
  const emit = (piece: Uint8Array) => { writeAll(fd, piece); file.update(piece); bytes += piece.length; };
  let result: KeptEdit = { ok: false, reason: 'the copy did not finish' };
  try {
    emit(Buffer.from(parsed.frontmatterWithoutParts, 'utf8'));
    emit(lead);
    const complete = streamParts(headPath, parsed, (piece, offset) => {
      body.update(piece);
      if (offset + piece.length > leadBytes) emit(piece.subarray(Math.max(0, leadBytes - offset)));
    });
    result = !complete ? { ok: false, reason: 'a part file is missing or not the size its manifest entry lists' }
      : body.digest('hex') !== contentHash ? { ok: false, reason: 'the parts no longer hash to the manifest content_hash' }
      : { ok: true, bytes, sha256: file.digest('hex'), leadBytes: lead.length };
    return result;
  } finally {
    closeSync(fd);
    if (!result.ok) unlinkSync(destPath);
  }
}
