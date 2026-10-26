/**
 * Wave B PR 5 (option B): the split check of every route outside the publication door. Only the strict door of a
 * git-canonical source creates or changes a split page (a head plus part files in `.<name>.gbparts/`); every other route
 * (write-through, a remover, a connector, a mirror, a file repair, a raw writer) refuses outright on any path of a split
 * unit through the one predicate, persistence/split-unit-guard.ts `assertSplitUnitMutable` (`split_page_unsupported`,
 * reason `outside_door`), before its first database or file write. Incoming content that is itself a split head (a
 * top-level `gbrain_parts` key) refuses `split_head_content` next to it. A path in no unit is written as one file, as
 * master writes it, whatever its size.
 */
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { parse } from 'node:path';
import { OperationError } from './ops/contract.ts';
import { assertNoReservedPartsKey } from './persistence/split-head-admission.ts';
import { assertSplitUnitMutable, assertSplitUnitMutableSync, type SplitUnitGuardInput } from './persistence/split-unit-guard.ts';
import { isSplitHeadPath } from './split-layout/paths.ts';

/** A route outside the door: everything assertSplitUnitMutable takes but the door's own fields; `strict` defaults to false. */
export type OutsideDoorInput = Omit<SplitUnitGuardInput, 'route' | 'strict' | 'planned' | 'phase'> & {
  route: Exclude<SplitUnitGuardInput['route'], 'door' | 'git_effect' | 'recovery'>; strict?: boolean;
};

/** `split_head_content` when `content` for a page path is itself a split head. */
function assertNotSplitHead(path: string, content: string | Uint8Array): void {
  if (isSplitHeadPath(path)) assertNoReservedPartsKey(typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
}

/**
 * The split check of a route outside the door before its first database or file write at `input.path`:
 * assertSplitUnitMutable first (`split_page_unsupported`, outside_door, when the path is in a split unit on disk, in the
 * index or in HEAD), so a writer that read a head and writes it back edited reports the unit; then `split_head_content`
 * when `content` for a path in no unit is itself a split head.
 */
export async function assertOutsideDoorWritable(input: OutsideDoorInput, content?: string | Uint8Array): Promise<void> {
  await assertSplitUnitMutable({ ...input, strict: input.strict ?? false });
  if (content !== undefined) assertNotSplitHead(input.path, content);
}

/** assertOutsideDoorWritable for a route that returns its refusal: the split_page_unsupported or split_head_content error, or null. */
export async function outsideDoorRefusal(input: OutsideDoorInput, content?: string | Uint8Array): Promise<OperationError | null> {
  try { await assertOutsideDoorWritable(input, content); return null; } catch (err) {
    if (err instanceof OperationError && (err.code === 'split_page_unsupported' || err.code === 'split_head_content')) return err;
    throw err;
  }
}

/**
 * assertOutsideDoorWritable for a writer that cannot await (skill tooling, the generic write helpers, writers with no
 * brain) and writes `content` as one file at `filePath`: assertSplitUnitMutableSync (a unit the disk shows), then
 * `split_head_content`. A path that can never be in a unit passes, so a generic write helper can call it on every file it
 * writes.
 */
export function assertOneFileWritable(filePath: string, content: string | Uint8Array): void {
  assertSplitUnitMutableSync({ root: parse(filePath).root, path: filePath, route: 'raw_writer' });
  assertNotSplitHead(filePath, content);
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
