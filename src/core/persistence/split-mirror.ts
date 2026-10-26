/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): a withdrawal mirror of a split page. The mirror's render of
 * the withdrawn page (F, or its streamed form for a page stored in segments) goes through the split unit the
 * publication door uses (`splitPublicationTargets`, split-files.ts): a head plus the parts that changed and the removal
 * of every part the new manifest drops, or one file with every part removed once the page is at or under the threshold.
 *
 * The unit is one version 3 recovery record (effect-model.ts `SplitMirrorFile`): the head first, then the parts, each
 * file with its prior and new SHA-256 and the stage its new bytes are renamed from, then every part the new manifest
 * keeps as it is (equal prior and new SHA-256, no stage), so a kept part edited before publication blocks it. The unit's
 * parts are the ones the mirror compared (`expectedParts`): a part that changed since is a local edit (`splitPartsDrifted`). Every stage is written and fsynced
 * after the record is durable and before any file is touched, so recovery is forward-only like every mirror (it never
 * restores withdrawn bytes): once any file of the unit holds its new bytes, every other file is renamed from its stage or
 * removed; while none does, a moved page or a missing stage discards the stages and the mirror renders again.
 */
import { lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { atomicStagingPath, mkdirPrivate } from '../atomic-write.ts';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { PART_FILE_RE, partsDirFor } from '../split-layout/index.ts';
import type { MutationFile } from './bundle-files.ts';
import { persistenceFileHash, publishPersistenceFile } from './coordinator.ts';
import type { EffectRecovery, SplitMirrorFile } from './effect-model.ts';
import { existsAt, isStreamedContent, stageStreamedContent, StreamedFileContent } from './large-file.ts';
import { removeEmptyPartsDir, type SplitFileFields } from './split-files.ts';
import { cleanupRecoveryStaging, publishStreamedStage } from './staging.ts';

/** The mirror's record fields for the page's head, before its split unit is planned. */
export type SplitMirrorTarget = Omit<EffectRecovery, 'version' | 'afterHash' | 'after' | 'staging' | 'files'>;
export interface SplitMirrorPlan { record: EffectRecovery & { files: SplitMirrorFile[] }; bytes: number; contents: Map<string, StreamedFileContent> }

async function streamedOf(engine: BrainEngine, content: string | Uint8Array | StreamedFileContent): Promise<StreamedFileContent> {
  if (isStreamedContent(content)) return content;
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return StreamedFileContent.measure(engine, async function* () { yield bytes; });
}

/** The version 3 record of a split unit (`splitPublicationTargets` has set `unit.parts`), and the recovery bytes it reserves. */
export async function splitMirrorPlan(engine: BrainEngine, target: SplitMirrorTarget, unit: MutationFile & SplitFileFields): Promise<SplitMirrorPlan> {
  const contents = new Map<string, StreamedFileContent>();
  const files: SplitMirrorFile[] = [];
  for (const [index, member] of [unit, ...unit.parts ?? []].entries()) {
    const content = member.content === null ? null : await streamedOf(engine, member.content);
    if (content) contents.set(member.path, content);
    files.push({ path: member.path, root: member.root, beforeHash: index ? member.expectedBeforeHash ?? null : target.beforeHash,
      afterHash: content?.hash ?? null, mode: index ? (content ? (member as { publishMode?: number }).publishMode ?? null : null) : target.mode,
      ...(content ? { staging: { publication: { path: atomicStagingPath(member.path), hash: content.hash, bytes: content.bytes } } } : {}) });
  }
  for (const [path, hash] of Object.entries(unit.split?.kept ?? {})) files.push({ path, root: unit.root, beforeHash: hash, afterHash: hash, mode: null });
  if (files[0]!.afterHash === null) throw opError('storage_error', 'A withdrawal mirror has no head to write.', 'The mirror of a split page planned no head file, so nothing was written. Inspect the owner\'s effects.');
  const record = { ...target, version: 3 as const, afterHash: files[0]!.afterHash, after: null, files };
  const staged = [...contents.values()].reduce((sum, content) => sum + content.bytes, 0);
  return { record, contents, bytes: Buffer.byteLength(JSON.stringify(record)) + staged + 4096 };
}

/**
 * Whether the parts directory differs from the one the mirror compared (`expectedParts`, prepareFileTarget): a part the unit
 * rewrites, removes or keeps holds other bytes, or a file came or went. Read when the unit was planned.
 */
export function splitPartsDrifted(unit: MutationFile & SplitFileFields): boolean {
  if (!unit.expectedParts) return false;
  const found = new Map<string, string | null>(Object.entries(unit.split?.kept ?? {}));
  for (const part of unit.parts ?? []) found.set(part.path, part.expectedBeforeHash ?? null);
  return [...new Set([...found.keys(), ...Object.keys(unit.expectedParts)])].some(path => (found.get(path) ?? null) !== (unit.expectedParts![path] ?? null));
}

/** Creates the directory a stage is written in (a new parts directory, 0700 for a part whose mode grants nothing to group or other), confined to the source root before and after. */
function stageParent(file: SplitMirrorFile): void {
  const confined = () => isWriteTargetContained(file.path, file.root);
  if (!confined()) throw unsafeUnit(file.path);
  if (file.mode === null || file.mode & 0o077) mkdirSync(dirname(file.path), { recursive: true });
  else mkdirPrivate(dirname(file.path), dirname(dirname(file.path)));
  if (!confined() || !lstatSync(dirname(file.path)).isDirectory()) throw unsafeUnit(file.path);
}

const unsafeUnit = (path: string) => opError('storage_error', 'A split page file of the withdrawal mirror escapes its source root.',
  `${path} resolves outside its source's canonical root (a symlinked directory or a moved checkout), so the mirror wrote nothing. Inspect the owner's effects; how to repair the checkout is the user's decision.`);

/** Writes every new file of the unit to its stage (whole, fsynced, verified) once the record naming the stages is durable. */
export async function stageSplitMirror(engine: BrainEngine, plan: SplitMirrorPlan): Promise<void> {
  for (const file of plan.record.files) {
    const content = plan.contents.get(file.path);
    if (!content || !file.staging?.publication) continue;
    stageParent(file);
    await stageStreamedContent(engine, file.path, content, file.staging.publication, file.mode);
  }
}

/** Whether a version 3 record is one head and the parts beside it, each confined to the record's root with a stage of its new bytes. */
export function splitMirrorFilesBelong(record: EffectRecovery): boolean {
  const [head, ...parts] = record.files ?? [];
  if (!head || head.path !== record.path || head.beforeHash !== record.beforeHash || head.afterHash !== record.afterHash) return false;
  let dir: string;
  try { dir = partsDirFor(head.path); } catch { return false; }
  const paths = new Set<string>();
  for (const file of [head, ...parts]) {
    if (file.root !== record.root || !isWriteTargetContained(file.path, record.root) || paths.has(file.path)) return false;
    const kept = file !== head && file.beforeHash === file.afterHash && !file.staging?.publication;
    if (file.afterHash !== null && !kept && file.staging?.publication?.hash !== file.afterHash) return false;
    paths.add(file.path);
  }
  return parts.every(part => dirname(part.path) === dir && PART_FILE_RE.test(basename(part.path)));
}

/** Where the unit stands on disk: every file must hold its prior or its new bytes (`unexpected` names one that holds neither). */
export function splitMirrorState(record: EffectRecovery): { unexpected: string | null; moved: boolean; pending: SplitMirrorFile[]; staged: boolean } {
  const pending: SplitMirrorFile[] = [];
  let moved = false;
  for (const file of record.files ?? []) {
    const actual = persistenceFileHash(file.path);
    if (actual !== file.beforeHash && actual !== file.afterHash) return { unexpected: file.path, moved, pending, staged: false };
    if (file.beforeHash === file.afterHash) continue;
    if (actual === file.afterHash) moved = true;
    else pending.push(file);
  }
  return { unexpected: null, moved, pending, staged: pending.every(file => file.afterHash === null || existsAt(file.staging!.publication!.path)) };
}

/** Discards every stage of the unit (a stage a crash cut short included); stages already renamed into place are gone. */
export function discardSplitMirrorStages(record: EffectRecovery): void {
  for (const file of record.files ?? []) cleanupRecoveryStaging(file);
}

/** The forward publication: each pending file is renamed from its verified stage or removed, then an empty parts directory goes. */
export function publishSplitMirrorFiles(record: EffectRecovery, pending: readonly SplitMirrorFile[]): void {
  for (const file of pending) {
    if (file.afterHash === null) publishPersistenceFile({ path: file.path, root: file.root, content: null });
    else publishStreamedStage(file);
  }
  removeEmptyPartsDir(record.path);
}
