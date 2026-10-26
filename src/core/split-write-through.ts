/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the unmanaged writers' page file. A page whose canonical
 * file F is over `sync.max_file_bytes`, or whose path already has a parts directory, is planned as the split unit the
 * publication door writes (`splitPublicationTargets`, split-files.ts). Outside the door there is no recovery record, and
 * a reader holds a head whose parts directory lists a part it does not name or misses one it does
 * (`split_page_incomplete`), so no order of writing a head and parts one by one survives a crash between them. An
 * unmanaged writer therefore writes only a unit whose parts all stay as they are (a new head, renamed into place
 * atomically) and refuses `split_page_unsupported` before any file is written when a part would be written or
 * removed, including a page that would grow into the layout or shrink out of it. A remover never removes a split page
 * (`assertPageFileRemovable`). A refused write leaves every file as it was. Callers hold the source filesystem lock.
 */
import { existsSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.ts';
import type { BrainEngine } from './engine.ts';
import { opError, type OperationError } from './ops/contract.ts';
import type { MutationFile } from './persistence/bundle-files.ts';
import { hashFile } from './persistence/large-file.ts';
import { releaseSplitTargets, splitKeptPartsChanged, splitPublicationTargets, type SplitFileFields } from './persistence/split-files.ts';
import { parseHead } from './split-layout/head.ts';
import { parseSplitThreshold } from './split-layout/limits.ts';
import { readPageFile, type PageFileHold } from './split-layout/page-file.ts';
import { isSplitHeadPath, partsDirFor } from './split-layout/paths.ts';

/** A file of the unit changed after it was planned (a part, or the head under `verify`); nothing more was written. */
export class PageFileChanged extends Error {
  constructor(readonly path: string) { super(`file_changed: ${path} changed while its page file was written`); }
}

/** The page file at `path` as text (F' for a split head whose parts verify), null when absent, or the hold that keeps it unreadable. */
export function readPageFileText(path: string): { text: string | null; split: boolean; hold?: undefined } | { hold: PageFileHold } {
  if (!existsSync(path)) return { text: null, split: false };
  const file = readPageFile(path);
  return file.hold ? { hold: file.hold } : { text: file.bytes.toString('utf8'), split: file.split };
}

/**
 * The one split preflight of every writer outside the publication door, called before its first database or file write
 * (docs/architecture/split-layout-writers.tsv lists each writer and its class). Plans the split unit of `content` (F) at
 * `filePath` and releases it, writing nothing: false when F is one ordinary file, true when it is a split unit whose
 * parts all stay (a new head only), and otherwise throws `split_page_unsupported` (a part would be written or removed,
 * including a page growing into the layout or shrinking out of it) or the planner's own refusal
 * (`split_parts_unexpected`, a part over its bounds), exactly as `writeSplitPageFile` would later.
 */
export async function assertSplitWritable(engine: BrainEngine, filePath: string, root: string, content: string): Promise<boolean> {
  const unit: MutationFile & SplitFileFields = { path: filePath, root, content, expectedBeforeHash: hashFile(filePath) };
  try {
    if (!await splitPublicationTargets(engine, unit)) return false;
    if (unit.parts?.length) throw splitPageUnsupported(filePath);
    return true;
  } finally { releaseSplitTargets(unit); }
}

/**
 * The refusal `writeSplitPageFile` would raise for `content` at `filePath` (`split_page_unsupported`), read before a
 * writer creates its temporary copy of the page, so a refused write never leaves the copy behind; undefined when the
 * write may go ahead. Any other planner refusal throws.
 */
export async function splitWriteRefusal(engine: BrainEngine, filePath: string, root: string, content: string): Promise<OperationError | undefined> {
  try {
    await assertSplitWritable(engine, filePath, root, content);
    return undefined;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'split_page_unsupported') return error as OperationError;
    throw error;
  }
}

/**
 * The refusal of a writer that writes `content` (F) at `filePath` as one whole file, read before its first write:
 * undefined only when F is one ordinary file there (`assertSplitWritable` false), else `split_page_unsupported` (a
 * split unit, even one whose parts all stay, is not one file). Any other planner refusal throws.
 */
export async function oneFileWriteRefusal(engine: BrainEngine, filePath: string, root: string, content: string): Promise<OperationError | undefined> {
  try {
    return await assertSplitWritable(engine, filePath, root, content) ? splitPageUnsupported(filePath) : undefined;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'split_page_unsupported') return error as OperationError;
    throw error;
  }
}

/**
 * The split preflight of a writer with no brain engine to plan with (skill tooling, the report and demo commands, lint
 * and backlinks run without a brain) that writes `content` as one whole file at `filePath`: throws
 * `split_page_unsupported`, writing nothing, when the file there is a split head (its text carries a `gbrain_parts`
 * manifest, whether or not its parts directory exists), its path has a parts directory, or `content` is over the split
 * threshold (`threshold`, the built-in default unless the caller read the brain's), so a page never grows into the
 * layout here. A path that can never be a split head (not a .md file) passes, so a generic write helper can call it on
 * every file it writes.
 */
export function assertOneFileWritable(filePath: string, content: string | Uint8Array, threshold = parseSplitThreshold(null)): void {
  if (!isSplitHeadPath(filePath)) return;
  const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
  if (bytes > threshold || isSplitPageFile(filePath, threshold)) throw splitPageUnsupported(filePath);
}

/**
 * True when the file at `filePath` is a split page: a head path whose parts directory exists, or whose text (at most
 * `threshold` bytes) carries a `gbrain_parts` manifest whether or not its parts directory exists.
 */
export function isSplitPageFile(filePath: string, threshold = parseSplitThreshold(null)): boolean {
  if (!isSplitHeadPath(filePath)) return false;
  if (lstatSync(partsDirFor(filePath), { throwIfNoEntry: false })) return true;
  const size = statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
  return size > 0 && size <= threshold && parseHead(readFileSync(filePath, 'utf8')) !== null;
}

/**
 * The check of every removal outside the publication door (unlink, rm or rename over a page path), called before the
 * remover's first database or file change: throws `split_page_unsupported`, removing nothing, when the file at
 * `filePath` is a split page (`isSplitPageFile`). A remover outside the door cannot remove a head and its parts as one
 * unit, nor prove they hold only what it compared, so the page goes only through the door.
 */
export function assertPageFileRemovable(filePath: string): void {
  if (isSplitPageFile(filePath)) throw splitPageOutsideDoor(filePath, 'removed');
}

/**
 * The check of an overwrite outside the publication door that is not bound to the page file it compared
 * (`expectedFileBytes` undefined): throws `split_page_unsupported`, writing nothing, when the file at `filePath` is a
 * split page, whose head or parts may hold an edit the database lacks. A bound overwrite passes; the writer rechecks
 * the bytes before it writes.
 */
export function assertPageFileOverwritable(filePath: string, expectedFileBytes: string | null | undefined): void {
  if (expectedFileBytes === undefined && isSplitPageFile(filePath)) throw splitPageOutsideDoor(filePath, 'overwritten');
}

/**
 * Writes a raw writer's temporary copy of the page file at `filePath` (`tmpPath`, renamed over it later) as a new file
 * with the page file's mode from its first byte (0644 when there is none), so a private page's copy is never readable
 * by others and the rename keeps the page's mode.
 */
export function writePageTemp(tmpPath: string, filePath: string, content: string): void {
  rmSync(tmpPath, { force: true });
  writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: (statSync(filePath, { throwIfNoEntry: false })?.mode ?? 0o644) & 0o777 });
}

/** The refusal of a write outside the publication door that would write or remove a part file of `filePath`. */
function splitPageUnsupported(filePath: string): OperationError {
  return opError('split_page_unsupported', 'split_page_unsupported: a split page whose part files would change cannot be written outside the publication door.',
    `${filePath} is, or would become, a split page (a head plus part files in ${partsDirFor(filePath)}) whose part files this write changes. A writer outside the publication door has no recovery record for a head and parts written one by one, so nothing was written. On a brain with a canonical owner the page is written through its door; otherwise ask the user how the page should be edited.`);
}

/** The refusal of a removal or unverified overwrite outside the publication door of the split page at `filePath`, naming the door. */
function splitPageOutsideDoor(filePath: string, action: 'removed' | 'overwritten'): OperationError {
  return opError('split_page_unsupported', `split_page_unsupported: ${filePath} is a split page (a head plus part files in ${partsDirFor(filePath)}), so it was not ${action} outside the publication door; nothing changed in the files or the database. `
    + 'Change it through the door: edit or delete the head and its parts directory in the checkout and publish them with gbrain git commit-push, write or delete the page with put_page or delete_page on a brain with a canonical owner, or change how it is stored with gbrain pages split-storage <slug> --source <id> (preview, then --apply).',
    'A writer outside the publication door cannot prove that the head and parts it would replace or remove hold only what it compared, and has no recovery record for removing them one by one. Ask the user how the page should change, then make the change through the door.');
}

/**
 * Writes `content` (F) at `filePath`: null, writing nothing, when the target is one ordinary file (F at or under the
 * threshold and no parts directory), which the caller writes as before; the head path when F is a split unit whose parts
 * all stay, its head written atomically (refused when its bytes changed since the unit was planned) with the exact `mode`
 * if given (the Google connector's 0600), else its file's mode. Throws `split_page_unsupported` when a part would be
 * written or removed or the split page there is held (a head edited by hand, a part missing or changed), `PageFileChanged` when a kept part changed, and whatever `precondition` throws, before any file
 * is written.
 */
export async function writeSplitPageFile(engine: BrainEngine, filePath: string, root: string, content: string,
  precondition?: () => void, mode?: number): Promise<string[] | null> {
  const headHash = hashFile(filePath);
  const unit: MutationFile & SplitFileFields = { path: filePath, root, content, expectedBeforeHash: headHash };
  if (!await splitPublicationTargets(engine, unit)) return null;
  try {
    if (unit.parts?.length) throw splitPageUnsupported(filePath);
    if (splitKeptPartsChanged(unit)) throw new PageFileChanged(partsDirFor(filePath));
    precondition?.();
    if (existsSync(filePath) && readPageFile(filePath).hold) throw splitPageOutsideDoor(filePath, 'overwritten');
    atomicWriteFileSync(filePath, unit.content as string, { durable: true, mode, verify: () => { if (hashFile(filePath) !== headHash) throw new PageFileChanged(filePath); } });
    return [filePath];
  } finally {
    releaseSplitTargets(unit);
  }
}

