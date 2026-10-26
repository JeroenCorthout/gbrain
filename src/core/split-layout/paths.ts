/**
 * Split git layout (Wave B PR 5): where a head's part files live. A head at `dir/name.md` keeps its parts in
 * `dir/.name.gbparts/NNNN-<first 8 hex of sha256>.gbpart` (NNNN is the 1-based index, four digits).
 * Relative paths here are Git-style (`/`-separated); absolute paths use the platform's own.
 */
import { basename, dirname, join } from 'node:path';
import { SplitLayoutError } from './types.ts';

const HEAD_EXTENSION = '.md';
const PARTS_DIR_RE = /^\.([^/\\\0]+)\.gbparts$/;
/** A part file name: index, then the first eight hex digits of its SHA-256. */
export const PART_FILE_RE = /^(\d{4})-([0-9a-f]{8})\.gbpart$/;

/** The parts directory's name for a head file name: `name.md` -> `.name.gbparts`. */
export function partsDirName(headName: string): string {
  if (!headName.endsWith(HEAD_EXTENSION) || headName.length <= HEAD_EXTENSION.length || /[/\\\0]/.test(headName)) {
    throw new SplitLayoutError('not_a_markdown_head', 'A split page head is a .md file; its parts directory is named after it.');
  }
  return '.' + headName.slice(0, -HEAD_EXTENSION.length) + '.gbparts';
}

/**
 * Whether `path` (relative or absolute) can be a split page head: a .md file. Any other path (an .mdx page, a README.txt)
 * has no parts directory, so a caller checks this before `partsDirFor`, which throws `not_a_markdown_head` for it.
 */
export function isSplitHeadPath(path: string): boolean {
  const name = basename(path);
  return name.endsWith(HEAD_EXTENSION) && name.length > HEAD_EXTENSION.length && !/[/\\\0]/.test(name);
}

/** The parts directory beside a head path (relative or absolute). */
export function partsDirFor(headPath: string): string {
  return join(dirname(headPath), partsDirName(basename(headPath)));
}

/**
 * Where manifest part `manifestPath` (`.<name>.gbparts/<file>`) lives for the head named `headName`: in that head's own
 * parts directory, by its file name. A head moved together with its directory (`git mv`) keeps the manifest's old
 * directory name, which therefore never decides where a part is read.
 */
export function partPathFor(headName: string, manifestPath: string): string {
  return partsDirName(headName) + '/' + manifestPath.slice(manifestPath.indexOf('/') + 1);
}

/** The path of manifest part `manifestPath` for the head at `headPath` (absolute or relative): partPathFor beside the head. */
export function partFilePath(headPath: string, manifestPath: string): string {
  return join(dirname(headPath), partPathFor(basename(headPath), manifestPath));
}

/** A part's file name. */
export function partFileName(index: number, sha256: string): string {
  return String(index).padStart(4, '0') + '-' + sha256.slice(0, 8) + '.gbpart';
}

/** True when a Git-relative path lies inside a parts directory: it is a part file or other content there, never a page. */
export function isPartPath(rel: string): boolean {
  return rel.split('/').slice(0, -1).some(segment => PARTS_DIR_RE.test(segment));
}

/** The head path a parts directory belongs to (`dir/.name.gbparts` -> `dir/name.md`), null when `rel` is not one. */
export function headPathForPartsDir(rel: string): string | null {
  const trimmed = rel.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  const match = PARTS_DIR_RE.exec(trimmed.slice(slash + 1));
  return match ? trimmed.slice(0, slash + 1) + match[1] + HEAD_EXTENSION : null;
}

/** The head of the parts directory that holds Git path `rel`, and `rel`'s path inside it; null outside any parts directory. */
export function splitPartOf(rel: string): { head: string; part: string } | null {
  const segments = rel.split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    if (!PARTS_DIR_RE.test(segments[i]!)) continue;
    const head = headPathForPartsDir(segments.slice(0, i + 1).join('/'));
    return head ? { head, part: segments.slice(i + 1).join('/') } : null;
  }
  return null;
}

/** Whether a directory name is a parts directory name. */
export function isPartsDirName(name: string): boolean {
  return PARTS_DIR_RE.test(name);
}
