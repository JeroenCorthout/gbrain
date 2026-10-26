/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the unmanaged writers' page file. A page whose canonical
 * file F is over `sync.max_file_bytes`, or whose path already has a parts directory, is written as the split unit the
 * publication door writes (`splitPublicationTargets`, split-files.ts): a head plus its new or changed parts, the removal
 * of every part the new manifest drops, or one file with every part removed once F is at or under the threshold. So an
 * unmanaged writer stays file-first for a split page exactly as for any other page: the files take the new page or the
 * writer refuses and nothing changes.
 *
 * Order: `precondition` (the caller's check of the page file it planned on) before any file is touched, then the new
 * parts (content-addressed names, so an old head never names one), then the head (atomically, refused when its bytes
 * changed since the unit was planned), then the removals. A crash leaves the old head with its parts plus unreferenced new
 * parts, or the new head with its parts plus unreferenced old ones, never a head naming a missing part. Callers hold
 * the source filesystem lock.
 */
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync, mkdirPrivate } from './atomic-write.ts';
import type { BrainEngine } from './engine.ts';
import { flushDirectory } from './fs-durable.ts';
import { isWriteTargetContained } from './path-confine.ts';
import type { MutationFile } from './persistence/bundle-files.ts';
import { hashFile, isStreamedContent } from './persistence/large-file.ts';
import { partFilesOnly, releaseSplitTargets, removeEmptyPartsDir, splitKeptPartsChanged, splitPublicationTargets, type SplitFileFields } from './persistence/split-files.ts';
import { readPageFile, type PageFileHold } from './split-layout/page-file.ts';
import { partsDirFor } from './split-layout/paths.ts';

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
 * Writes `content` (F) at `filePath` as its split unit; null, writing nothing, when the target is one ordinary file
 * (F at or under the threshold and no parts directory), which the caller writes as before. Returns every path written
 * or removed, head first. Throws `PageFileChanged` when the head or a part changed since the unit was planned, and
 * whatever `precondition` throws, before any file is written. `mode` is the head's exact mode (the Google connector's 0600);
 * omitted, the head keeps its file's mode. Every part takes the head's mode from its first byte, and a new parts directory
 * is 0700 when that mode grants nothing to group or other.
 */
export async function writeSplitPageFile(engine: BrainEngine, filePath: string, root: string, content: string,
  precondition?: () => void, mode?: number): Promise<string[] | null> {
  const headHash = hashFile(filePath);
  const unit: MutationFile & SplitFileFields & { publishMode?: number } = { path: filePath, root, content, expectedBeforeHash: headHash, ...(mode === undefined ? {} : { publishMode: mode }) };
  if (!await splitPublicationTargets(engine, unit)) return null;
  try {
    const parts = unit.parts ?? [];
    if (splitKeptPartsChanged(unit)) throw new PageFileChanged(partsDirFor(filePath));
    for (const part of parts) if (hashFile(part.path) !== (part.expectedBeforeHash ?? null)) throw new PageFileChanged(part.path);
    precondition?.();
    const touched = [filePath];
    for (const part of parts) {
      if (part.content === null) continue;
      if (part.publishMode === undefined || part.publishMode & 0o077) mkdirSync(dirname(part.path), { recursive: true });
      else mkdirPrivate(dirname(part.path), dirname(filePath));
      if (!isWriteTargetContained(part.path, root) || !lstatSync(dirname(part.path)).isDirectory()) throw new Error(`${part.path} resolves outside its source root`);
      const pieces: Uint8Array[] = [];
      if (isStreamedContent(part.content)) for await (const piece of part.content.pieces(engine)) pieces.push(piece);
      else pieces.push(typeof part.content === 'string' ? Buffer.from(part.content, 'utf8') : part.content);
      atomicWriteFileSync(part.path, Buffer.concat(pieces), { durable: true, mode: part.publishMode });
      touched.push(part.path);
    }
    atomicWriteFileSync(filePath, unit.content as string, { durable: true, mode, verify: () => { if (hashFile(filePath) !== headHash) throw new PageFileChanged(filePath); } });
    for (const part of parts) {
      if (part.content !== null) continue;
      unlinkSync(part.path);
      touched.push(part.path);
    }
    if (parts.some(part => part.content === null) && existsSync(partsDirFor(filePath))) flushDirectory(partsDirFor(filePath));
    removeEmptyPartsDir(filePath);
    return touched;
  } finally {
    releaseSplitTargets(unit);
  }
}

/**
 * Removes the split page at `filePath`: the head first (a crash then leaves unreferenced parts, never a head naming a
 * missing part), then every part file and the parts directory. Null, removing nothing, when the path has no parts
 * directory. Refuses `split_parts_unexpected` for anything in the parts directory that is not a part file.
 */
export function removeSplitPageFile(filePath: string, root: string): string[] | null {
  if (!lstatSync(partsDirFor(filePath), { throwIfNoEntry: false })) return null;
  const parts = partFilesOnly(filePath, root);
  unlinkSync(filePath);
  flushDirectory(dirname(filePath));
  for (const part of parts) unlinkSync(part);
  removeEmptyPartsDir(filePath);
  return [filePath, ...parts];
}
