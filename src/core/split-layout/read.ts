/**
 * Split git layout (Wave B PR 5, spec §9 option B, design §3): the read path. A Markdown file whose frontmatter carries
 * `gbrain_parts` is a split page head and never a page of its own. Its parts are checked against the manifest and
 * reassembled into a private scratch file F' (the canonical file the page was written from), which the existing
 * importer reads as the head's path. A head whose parts are missing, unlisted or changed, or whose manifest does not
 * parse, is `split_page_incomplete`; one whose body (lead and notice) was edited is `split_head_modified`. Both are
 * refusals: sync holds the head and the stored page keeps its last good version; a short page is never imported.
 */
import { closeSync, constants, openSync, readSync, rmSync, statSync } from 'node:fs';
import type { ImportResult } from '../import-file.ts';
import { assertSourceFilePath } from '../minions/source-filesystem.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../page-body/limits.ts';
import { parseHead, type ParsedHead } from './head.ts';
import { partsDirFor } from './paths.ts';
import { splitScratchPath } from './plan.ts';
import { PARTS_KEY } from './types.ts';
import { reassemble, verifyParts, type SplitVerdict } from './verify.ts';
import { slugifyPath } from '../sync.ts';

export type SplitRefusalCode = 'split_page_incomplete' | 'split_head_modified';
export interface SplitRefusal { code: SplitRefusalCode; message: string }

/** The head's parts directory as Git names it (forward slashes, relative to the source root). */
function partsDirOf(relPath: string): string {
  return partsDirFor(relPath).split('\\').join('/');
}

function sample(paths: string[]): string {
  return paths.slice(0, 3).join(', ') + (paths.length > 3 ? `, and ${paths.length - 3} more` : '');
}

function refusalFor(relPath: string, verdict: Exclude<SplitVerdict, { ok: true }>): SplitRefusal {
  if (verdict.code === 'split_head_modified') {
    return { code: verdict.code, message: `${relPath} is a split page head whose body (the lead and the gbrain notice line) was edited, so the page it names `
      + 'cannot be reassembled from it; sync held it and kept the stored page. Preview the resolution with gbrain pages split-storage <slug> --resolve-head keep-edit|discard.' };
  }
  const sets = [['missing', verdict.missing], ['changed', verdict.mismatched], ['unlisted', verdict.extra]] as const;
  const named = sets.filter(([, paths]) => paths.length).map(([label, paths]) => `${label}: ${sample(paths)}`).join('; ');
  return { code: verdict.code, message: `${relPath} is a split page head whose part files in ${partsDirOf(relPath)} do not match its manifest (${named || verdict.reason}); `
    + `sync held it and kept the stored page. Restore them from Git (git checkout -- ${relPath} ${partsDirOf(relPath)}), then sync again.` };
}

function unreadable(relPath: string, reason: string): SplitRefusal {
  return { code: 'split_page_incomplete', message: `${relPath} declares gbrain_parts but is not a readable split page head (${reason}); sync held it and kept the stored page. `
    + `Restore the head and its parts from Git (git checkout -- ${relPath} ${partsDirOf(relPath)}), then sync again.` };
}

/** `text` read as a split head: null for an ordinary page (no `gbrain_parts` key), a refusal, or the parsed head. */
function parseSplitHead(relPath: string, text: string): { refusal: SplitRefusal } | { parsed: ParsedHead } | null {
  if (!text.includes(PARTS_KEY)) return null;
  const parsed = parseHead(text);
  if (parsed === null) return null;
  return 'error' in parsed ? { refusal: unreadable(relPath, parsed.error.reason) } : { parsed };
}

/** Read-only screen (rename destinations, dry runs): the refusal a split head at `headPath` would get, or null. */
export function screenSplitHead(headPath: string, relPath: string, text: string): SplitRefusal | null {
  const head = parseSplitHead(relPath, text);
  if (!head || 'refusal' in head) return head?.refusal ?? null;
  const verdict = verifyParts(headPath, head.parsed);
  return verdict.ok ? null : refusalFor(relPath, verdict);
}

/**
 * Opens the page a split head at `headPath` names: its reassembled file F' in a private scratch file (`dispose`
 * removes it), a refusal, or null when `text` (the head's content as import read it) is an ordinary page.
 */
export function openSplitPage(headPath: string, relPath: string, text: string): { refusal: SplitRefusal } | { path: string; dispose: () => void } | null {
  const head = parseSplitHead(relPath, text);
  if (!head || 'refusal' in head) return head;
  const path = splitScratchPath();
  const verdict = reassemble(headPath, head.parsed, path);
  return verdict.ok ? { path, dispose: () => rmSync(path, { force: true }) } : { refusal: refusalFor(relPath, verdict) };
}

/**
 * A file too large for any split head (over the import size limit) whose frontmatter declares `gbrain_parts`: the
 * refusal that keeps it from importing as a plain page, or null. Reads at most the bounded frontmatter head.
 */
export function oversizeSplitHead(filePath: string, relPath: string, size: number): SplitRefusal | null {
  const buffer = Buffer.alloc(Math.min(size, FRONTMATTER_HEAD_MAX_BYTES));
  const fd = openSync(assertSourceFilePath(filePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let read = 0;
  try { for (let n: number; read < buffer.length && (n = readSync(fd, buffer, read, buffer.length - read, read)) > 0;) read += n; }
  finally { closeSync(fd); }
  const text = buffer.subarray(0, read).toString('utf8');
  return text.includes(PARTS_KEY) && parseHead(text) !== null ? unreadable(relPath, `the file is ${size} bytes, larger than any split page head`) : null;
}

/** The file facts import uses for `filePath`: with `splitBody` (a reassembled split page), its size and mtime, with the head's file times. */
export function splitBodyStat(filePath: string, splitBody: string | undefined): { size: number; mtimeMs: number; birthtime: Date; mtime: Date } {
  const head = statSync(filePath);
  if (!splitBody) return head;
  const body = statSync(splitBody);
  return { size: body.size, mtimeMs: body.mtimeMs, birthtime: head.birthtime, mtime: head.mtime };
}

/** The import result of a refused split head: a typed content refusal sync holds (`holdRefusedImport`) and other callers fail. */
export function splitRefusalResult(relPath: string, refusal: SplitRefusal): ImportResult {
  return { slug: slugifyPath(relPath), status: 'skipped', chunks: 0, error: refusal.message, refusal, skip_reason: refusal.code };
}
