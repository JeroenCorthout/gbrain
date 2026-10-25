/**
 * Wave B PR 5 (split git layout, spec §9 option B), the write path. A page whose canonical file F would exceed
 * `sync.max_file_bytes` is stored as a head file at the page's path plus part files in `.<name>.gbparts/`
 * (split-layout/). This module turns a page publication's single file target into that unit and recovers it.
 *
 * - `splitPublicationTargets` runs inside `publishMutation`, under the worktree lock, before the recovery record is
 *   written: a page over the threshold gets the head as its content plus part targets for the parts that are new or
 *   changed (an unchanged part, same name and bytes already on disk, is not rewritten) and removals for every other
 *   file its parts directory holds; a page at or under the threshold, or a removal, gets removals for every part file
 *   (a split page converting back to one file). The plan's private staged copy of F is disposed when the publication
 *   ends (`releaseSplitTargets`); `sweepSplitStaging` removes copies a dead process left.
 * - The recovery record (`SplitRecoveryRecord`, model.ts) holds the head first, then the parts, each with the
 *   single-file staging; a strict source commits every file of it through the door in one commit.
 * - `recoverPublication` (coordinator.ts) recovers the record as one unit: all files go back to their prior bytes, or
 *   all are kept when the door commit landed (`splitLandedCommit`, named on the receipt with `landed_before_row`),
 *   never a mix of old and new files. `assertSplitRecoveryBinding` checks the record is this owner's head and parts.
 * - A Git effect of a split publication carries `version: 3` (effect-model.ts `SPLIT_GIT_EFFECT_VERSION`): the
 *   current runner commits the head with every part path in one commit (effect-git.ts `publishSplitGitEffect`);
 *   binaries that predate it refuse the version (`targetedWithdrawalEffect`: `withdrawal_provenance`) and never commit a
 *   head without its parts.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { flushDirectory } from '../fs-durable.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import { headBodyFor, parseHead, partsDirFor, planSplit, PART_FILE_RE, reassemble, splitLimits, SplitLayoutError, splitNotice, splitScratchPath, splitThresholdBytes, type ParsedHead, type SplitPlan } from '../split-layout/index.ts';
import type { MutationFile } from './bundle-files.ts';
import type { PageMutationFile } from './coordinator.ts';
import { git, withSession } from './effect-git.ts';
import { SPLIT_GIT_EFFECT_VERSION } from './effect-model.ts';
import { fileContentBytes, FileBytes, hashFile, isStreamedContent, type StreamedFileContent } from './large-file.ts';
import type { FileRecoveryRecord, RecoveryRecord, SplitRecoveryRecord, WriteRequest } from './model.ts';
import type { WorktreeBinding } from './ownership.ts';

/** The split layout a page publication leaves; set by `splitPublicationTargets` on the page's file target. */
export interface SplitLayout {
  /** Absolute paths of the part files the new head lists (empty when the page is now one file or removed). */
  manifest: string[];
  /** The content the target had before it became the head (F, or null for a removal). */
  original: MutationFile['content'];
  plan: SplitPlan | null;
  /** The new manifest's parts already on disk with their planned bytes, not rewritten (absolute path to SHA-256). */
  kept: Record<string, string>;
}
/** Fields a page file target gains when its publication touches the split layout. */
export interface SplitFileFields {
  /**
   * The files of the parts directory beside the target when the write was prepared (absolute path to SHA-256): a verified
   * head's manifest, or the directory as found. Publication refuses as drift when the directory differs from it.
   */
  expectedParts?: Record<string, string>;
  /** Part files written (content) or removed (null) beside the head: the new manifest's changed parts, then removals. */
  /** Part files written (content) or removed (null) beside the head; each takes the head's exact publish mode, if any. */
  parts?: PartTarget[];
  split?: SplitLayout;
}
type PartTarget = MutationFile & { publishMode?: number };
type SplitTarget = PartTarget & SplitFileFields;

const ownersFix = (sourceId?: string): Action => readFix(sourceId
  ? `Shows source ${sourceId}'s canonical owner with its pending, failed and recovering write requests, read-only.`
  : "Shows every source's canonical owner with its pending, failed and recovering write requests, read-only.",
{ argv: ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'] });

/** A head is a frontmatter block plus at most a 64 KiB lead; anything larger at a head path is never read as one. */
const HEAD_READ_MAX_BYTES = 16 * 1024 ** 2;
const utf8 = new TextDecoder('utf-8', { fatal: true });
/** The maintenance intent `gbrain pages split-storage --apply` admits (split-layout/relayout.ts `SPLIT_RELAYOUT_INTENT`). */
const SPLIT_RELAYOUT_INTENT_KIND = 'managed_maintenance_split_relayout';

/**
 * The refusal of a parts directory that is not a plain directory of part files: `entry` is what is in the way (the
 * directory itself, or a file in it that is not a regular file named as a part, NNNN-<sha8>.gbpart). Nothing is written
 * or removed: what the entry is and whether it may go is the user's decision.
 */
function unexpectedPartsEntry(dir: string, entry: string): OperationError {
  return opError('split_parts_unexpected', 'A split page parts directory holds something that is not a part file.',
    `${entry === dir ? `${dir} is not a plain directory` : `${dir} holds ${basename(entry)}, which is not a part file (a regular file named NNNN-<sha8>.gbpart)`}, so the page's files were not written and nothing in it was removed. Ask the user what it is: move it out of the parts directory (or remove it, if they agree), then submit the write again with a new request_id.`,
    { fix: readFix('Lists split page layouts on this host (stray parts directories and held split pages) with their fixes, read-only.', { argv: ['gbrain', 'doctor', '--only', 'split_layout', '--json'] }),
      docs: 'docs/guides/write-refusals.md#split_parts_unexpected' });
}

/** The parts directory a head path names, or null for a target that cannot be a head (not a .md file). */
function partsDirOf(headPath: string): string | null {
  try { return partsDirFor(headPath); } catch { return null; }
}

/**
 * The part files in the parts directory beside `headPath` (empty when the directory is absent), read without their
 * bytes; refuses `split_parts_unexpected` for anything else in the way.
 */
export function partFilesOnly(headPath: string, root: string): string[] {
  const dir = partsDirOf(headPath);
  if (!dir) return [];
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || !isWriteTargetContained(dir, root)) throw unexpectedPartsEntry(dir, dir);
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    if (!PART_FILE_RE.test(name) || !lstatSync(path).isFile()) throw unexpectedPartsEntry(dir, path);
    return path;
  });
}

/** Every part file in the parts directory beside `headPath`, with its SHA-256. */
function currentParts(headPath: string, root: string): Map<string, string> {
  return new Map(partFilesOnly(headPath, root).map(path => [path, hashFile(path)!]));
}

/** The parts directory beside `headPath` as prepareFileTarget finds it (no split head there): path to SHA-256. */
export function preparedParts(headPath: string, root: string): Record<string, string> {
  return Object.fromEntries(currentParts(headPath, root));
}

/** F as a byte stream for planSplit, whatever form the target holds it in. */
async function* contentSource(engine: BrainEngine, content: string | Uint8Array | StreamedFileContent): AsyncIterable<Uint8Array> {
  if (isStreamedContent(content)) { yield* content.pieces(engine); return; }
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  for (let at = 0; at < bytes.length; at += SEGMENT_MAX_BYTES) yield bytes.subarray(at, at + SEGMENT_MAX_BYTES);
}

function splitRefusal(path: string, error: SplitLayoutError): OperationError {
  return opError('request_too_large', 'The canonical file is over sync.max_file_bytes and cannot be written as a split page.',
    `The file of ${basename(path)} is larger than sync.max_file_bytes, so it is written as a head file plus part files, but ${error.message} (${error.code}). Nothing was written. Fix the page, then submit the write again with a new request_id (docs/guides/memory-boundaries.md#large-pages).`);
}

/**
 * Whether a page target might take the split layout: its content is larger than the smallest threshold, or its path
 * already has a parts directory. A group publication leaves such a member to publishMutation (group-publish.ts).
 */
export function mayTakeSplitLayout(file: Pick<MutationFile, 'path' | 'content'> | undefined): boolean {
  const dir = file ? partsDirOf(file.path) : null;
  if (!file || !dir) return false;
  return (file.content !== null && fileContentBytes(file.content) > splitLimits.thresholdMin) || existsSync(dir);
}

/**
 * Turns a page's file target into the split unit, under the publication's worktree lock and before its recovery record:
 * true when the publication now writes or removes part files (`file.parts` and `file.split` set; the target's content is
 * the head for a split page), false when it is one ordinary file. Idempotent; undone by `releaseSplitTargets`.
 */
export async function splitPublicationTargets(engine: BrainEngine, file: SplitTarget): Promise<boolean> {
  if (file.split) return true;
  const dir = partsDirOf(file.path);
  if (!dir) return false;
  const bytes = file.content === null ? 0 : fileContentBytes(file.content);
  const threshold = await splitThresholdBytes(engine);
  if (bytes <= threshold && !existsSync(dir)) return false;
  const existing = currentParts(file.path, file.root);
  if (bytes <= threshold && !existing.size) return false;
  const original = file.content;
  const parts: PartTarget[] = [];
  const publishMode = file.publishMode === undefined ? {} : { publishMode: file.publishMode };
  const manifest: string[] = [];
  const kept: Record<string, string> = {};
  let plan: SplitPlan | null = null;
  try {
    if (original !== null && bytes > threshold) {
      try { plan = await planSplit(contentSource(engine, original), { headPath: file.path }); }
      catch (error) { throw error instanceof SplitLayoutError ? splitRefusal(file.path, error) : error; }
      for (const part of plan.parts) {
        const path = join(dirname(file.path), part.path);
        manifest.push(path);
        const current = existing.get(path) ?? null;
        if (current === part.sha256) { kept[path] = current; continue; }
        parts.push({ path, root: file.root, content: await plan.partContent(engine, part), expectedBeforeHash: current, ...publishMode });
      }
      file.content = plan.head();
    }
    const listed = new Set(manifest);
    for (const [path, hash] of existing) if (!listed.has(path)) parts.push({ path, root: file.root, content: null, expectedBeforeHash: hash, ...publishMode });
  } catch (error) {
    plan?.dispose();
    file.content = original;
    throw error;
  }
  file.parts = parts;
  file.split = { manifest, original, plan, kept };
  return true;
}

/** Disposes the plan's staged copy and gives the target back its original content, so a later publication plans again. */
export function releaseSplitTargets(file: SplitTarget | undefined): void {
  if (!file?.split) return;
  const { plan, original } = file.split;
  file.content = original;
  delete file.parts;
  delete file.split;
  plan?.dispose();
}

export function isSplitRecoveryRecord(record: RecoveryRecord | null | undefined): record is SplitRecoveryRecord {
  return record?.version === 2 && (record as { target?: unknown }).target === 'page_split';
}

/**
 * The split publication's recovery record: `recordOf` (coordinator.ts `pageRecoveryRecord`) gives each file its
 * single-file record, read under the worktree lock before any file is touched; the head comes first.
 */
export function splitRecoveryRecord(row: WriteRequest, file: PageMutationFile & SplitFileFields, binding: WorktreeBinding,
  recordOf: (row: WriteRequest, file: PageMutationFile, binding: WorktreeBinding) => { record: FileRecoveryRecord; bytes: number }): { record: SplitRecoveryRecord; bytes: number } {
  const records = [file, ...file.parts ?? []].map(target => recordOf(row, target, binding));
  return {
    record: { version: 2, target: 'page_split', root: file.root, ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token!, files: records.map(entry => entry.record) },
    bytes: records.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/**
 * Whether any file changed after preparation (its bytes are not the ones it expected), apart from a replay after its door
 * commit landed. The parts directory must hold exactly the parts the write was prepared against (expectedParts): every
 * part it rewrites, keeps or removes, at the hash prepared, and nothing else.
 */
export async function splitFilesChanged(files: MutationFile[], record: SplitRecoveryRecord,
  replayAfterDoorCommit: (record: FileRecoveryRecord) => Promise<boolean>): Promise<boolean> {
  const head = files[0] as SplitTarget | undefined;
  if (head?.expectedParts) {
    const found = new Map<string, string | null>(Object.entries(head.split?.kept ?? {}));
    for (const entry of record.files.slice(1)) found.set(entry.path, entry.beforeHash);
    for (const path of new Set([...found.keys(), ...Object.keys(head.expectedParts)])) {
      if ((found.get(path) ?? null) !== (head.expectedParts[path] ?? null)) return true;
    }
  }
  for (const [index, file] of files.entries()) {
    const entry = record.files[index]!;
    if (file.expectedBeforeHash !== undefined && entry.beforeHash !== file.expectedBeforeHash
      && !await replayAfterDoorCommit({ ...entry, ...(record.door ? { door: record.door } : {}) })) return true;
  }
  return false;
}

/** Whether a part the publication keeps (already on disk with its planned bytes) changed since it was planned; read under the lock. */
export function splitKeptPartsChanged(file: SplitTarget | undefined): boolean {
  return Object.entries(file?.split?.kept ?? {}).some(([path, hash]) => hashFile(path) !== hash);
}

/** Removes the parts directory beside `headPath` once it is empty (a page converted back to one file, or removed). */
export function removeEmptyPartsDir(headPath: string): void {
  const dir = partsDirOf(headPath);
  if (!dir || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || readdirSync(dir).length) return;
  rmdirSync(dir);
  flushDirectory(dirname(dir));
}

/**
 * The comparison reading of a split head: the reassembled page file F' (null for a head whose body was edited by hand,
 * `split_head_modified`, which then compares as itself: drift), the head's own hash, and the parsed edited head.
 */
export interface SplitHeadReading { reassembled: FileBytes | null; headHash: string; modified: ParsedHead | null; parts: Record<string, string>; dispose(): void }

/**
 * When the file at `path` is a split head whose parts verify, the page file it stands for, reassembled into a private
 * scratch file (prepareFileTarget compares that with the stored page, never the head); for a head whose parts verify
 * but whose body was edited, the parsed head (`resolvesModifiedHead`). Null for an ordinary file or any other head.
 */
export function readSplitHead(path: string, before: Buffer | FileBytes): SplitHeadReading | null {
  const dir = partsDirOf(path);
  if (!dir || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || before.length > HEAD_READ_MAX_BYTES) return null;
  const bytes = before instanceof FileBytes ? before.subarray() : before;
  let parsed;
  try { parsed = parseHead(utf8.decode(bytes)); } catch { return null; }
  if (!parsed || 'error' in parsed) return null;
  const headHash = before instanceof FileBytes ? before.hash() : createHash('sha256').update(bytes).digest('hex');
  const scratch = splitScratchPath();
  const verdict = reassemble(path, parsed, scratch);
  const parts = Object.fromEntries(parsed.manifest.parts.map(part => [join(dirname(path), part.path), part.sha256]));
  if (!verdict.ok) return verdict.code === 'split_head_modified' ? { reassembled: null, headHash, modified: parsed, parts, dispose: () => {} } : null;
  const reassembled = FileBytes.open(scratch);
  return { reassembled, headHash, modified: null, parts, dispose: () => { try { reassembled.close(); } finally { rmSync(scratch, { force: true }); } } };
}

/** SHA-256 of the last `bytes` bytes of a content, and the bytes before them (at most `keepPrefix` of them kept). */
async function contentTail(engine: BrainEngine, content: string | Uint8Array | StreamedFileContent, bytes: number, keepPrefix: number): Promise<{ prefix: Buffer; sha256: string } | null> {
  const total = fileContentBytes(content);
  if (total < bytes || total - bytes > keepPrefix) return null;
  const start = total - bytes;
  const prefix: Buffer[] = [];
  const hash = createHash('sha256');
  let at = 0;
  for await (const piece of contentSource(engine, content)) {
    if (at < start) prefix.push(Buffer.from(piece.subarray(0, Math.min(piece.length, start - at))));
    if (at + piece.length > start) hash.update(piece.subarray(Math.max(0, start - at)));
    at += piece.length;
  }
  return { prefix: Buffer.concat(prefix), sha256: hash.digest('hex') };
}

/** SHA-256 of the page body the parts hold after the lead, B[lead_bytes:], read through `O_NOFOLLOW` descriptors. */
function partsTailSha256(path: string, parsed: ParsedHead): string | null {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(SEGMENT_MAX_BYTES);
  let offset = 0;
  for (const part of parsed.manifest.parts) {
    let fd: number;
    try { fd = openSync(join(dirname(path), part.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
    try {
      for (let read = 0, n: number; read < part.bytes; read += n, offset += n) {
        n = readSync(fd, buffer, 0, Math.min(buffer.length, part.bytes - read), read);
        if (n <= 0) return null;
        if (offset + n > parsed.manifest.lead_bytes) hash.update(buffer.subarray(Math.max(0, parsed.manifest.lead_bytes - offset), n));
      }
    } finally { closeSync(fd); }
  }
  return hash.digest('hex');
}

/**
 * Whether a write over a split head whose body was edited by hand (`split_head_modified`; its parts still hold the body
 * the manifest describes) is that edit's resolution (`gbrain pages split-storage --resolve-head`), the only writes
 * allowed to replace it; every other write compares the edited head as itself and is refused as drift.
 * - discard: the split relayout maintenance intent bound to `resolve_head: 'discard'`, whose content (the stored page)
 *   ends with the page body the manifest hashes (`content_hash`), so it replaces only the head's edit.
 * - keep-edit: a write whose content's body (after its frontmatter block, which the write path renders) is the page body
 *   that keeps the edit: the lead the edited head body holds before its notice line, then B[lead_bytes:] from the parts.
 *   A head is `split_head_modified` only for an edit to its body (`lead_sha256`); a frontmatter edit verifies as is.
 */
export async function resolvesModifiedHead(engine: BrainEngine, row: object, path: string, parsed: ParsedHead,
  content: string | Uint8Array | StreamedFileContent | null): Promise<boolean> {
  if (content === null) return false;
  const { manifest } = parsed;
  const intent = (row as { intent?: { kind?: unknown; resolve_head?: unknown } }).intent;
  if (intent?.kind === SPLIT_RELAYOUT_INTENT_KIND && intent.resolve_head === 'discard') {
    return (await contentTail(engine, content, manifest.total_bytes, Number.MAX_SAFE_INTEGER))?.sha256 === manifest.content_hash;
  }
  const tailBytes = manifest.total_bytes - manifest.lead_bytes;
  const tail = await contentTail(engine, content, tailBytes, HEAD_READ_MAX_BYTES);
  const close = tail && tail.prefix.subarray(0, 4).toString('latin1') === '---\n' ? tail.prefix.indexOf('\n---\n', 3) : -1;
  if (!tail || close < 0) return false;
  let lead: string;
  try { lead = utf8.decode(tail.prefix.subarray(close + 5)); } catch { return false; }
  return parsed.headBody === headBodyFor(lead, splitNotice(manifest.parts.length, manifest.total_bytes)) && partsTailSha256(path, parsed) === tail.sha256;
}

/** The Git effect data of a split publication: the version older runners refuse (effect-targets.ts). */
export function splitGitEffectData(file: MutationFile & SplitFileFields): { version?: typeof SPLIT_GIT_EFFECT_VERSION } {
  return file.split ? { version: SPLIT_GIT_EFFECT_VERSION } : {};
}

/**
 * The door commit that landed for a split record: the newest commit after `doorHead` (to HEAD) touching any of the
 * record's paths, provided it holds every one of them as published (each worktree file hashes to its `afterHash` and
 * is that commit's blob; a removal is absent from both). Null for an empty range, a commit that does not hold every
 * file, or when Git cannot answer: the record's files then resolve to no one commit.
 */
export async function splitLandedCommit(root: string, doorHead: string | null, files: ReadonlyArray<Pick<FileRecoveryRecord, 'path' | 'afterHash'>>): Promise<string | null> {
  if (!files.length) return null;
  const rels = files.map(file => relative(root, file.path).split(sep).join('/'));
  try {
    return await withSession(root, undefined, undefined, false, async session => {
      const listed = await git(session, ['rev-list', '-1', doorHead ? `${doorHead}..HEAD` : 'HEAD', '--', ...rels.map(rel => `:(literal)${rel}`)], false);
      const commit = listed.code === 0 ? listed.stdout.trim() : '';
      if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
      for (const [index, file] of files.entries()) {
        const blob = await git(session, ['rev-parse', '--verify', '--quiet', `${commit}:./${rels[index]}`], false);
        if (file.afterHash === null) {
          if (blob.code === 0 || existsSync(file.path)) return null;
          continue;
        }
        if (blob.code !== 0 || hashFile(file.path) !== file.afterHash) return null;
        const worktree = await git(session, ['hash-object', '--', `./${rels[index]}`], false);
        if (worktree.code !== 0 || worktree.stdout.trim() !== blob.stdout.trim()) return null;
      }
      return commit;
    });
  } catch { return null; }
}

/** Refuses a split record that does not belong to this owner and claim, or whose files are not one head and its parts. */
export function assertSplitRecoveryBinding(record: SplitRecoveryRecord, binding: WorktreeBinding, attempt: string | null): void {
  const refuse = () => opError('recovery_required', 'Split page recovery identity is invalid; its files remain fenced.',
    `The recovery record for the split page files under ${record.root} does not match this owner (root, owner epoch ${binding.owner_epoch} or claim), or its files are not one head and the part files beside it, so recovery stopped and the files stay fenced; nothing was restored or deleted. Show the user the owner status; never delete the files or the record to force progress.`,
    { fix: ownersFix() });
  if (!binding.local_path || record.root !== resolve(binding.local_path, binding.relative_path)
    || record.ownerEpoch !== String(binding.owner_epoch) || record.attempt !== attempt) throw refuse();
  const [head, ...parts] = record.files;
  const dir = head ? partsDirOf(head.path) : null;
  if (!dir) throw refuse();
  const seen = new Set<string>();
  for (const file of record.files) {
    if (file.root !== record.root || file.ownerEpoch !== record.ownerEpoch || file.attempt !== record.attempt || seen.has(file.path) || !file.staging) throw refuse();
    seen.add(file.path);
  }
  if (parts.some(part => dirname(part.path) !== dir || !PART_FILE_RE.test(basename(part.path)))) throw refuse();
}
