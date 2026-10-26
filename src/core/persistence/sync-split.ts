/**
 * Wave B PR 5 (split git layout): a managed sync import of a split page head. A head never imports as the short page
 * it is on its own: the freeze reassembles the page file F' it stands for from the head and the part files of the
 * same commit the entry is pinned to (a working-tree entry: the files beside it), checking every part's size and
 * SHA-256, the manifest's content hash and the head body's lead hash. A page whose parts do not verify is held
 * `split_page_incomplete` or `split_head_modified` (read.ts); the stored page keeps its last good version.
 *
 * The intent freezes F' as its content (or by reference, `body_ref` kind `split_page`, over the read bound: the
 * owner reopens it from the same commit and streams it) plus a `SyncSplitMark`. Its `rawHash` stays the working-tree
 * head's bytes, so the publication's "file unchanged" check and every hold keyed by the file's bytes see the head;
 * the head is clean when `rawHash` is the mark's `head_sha256` (`frozenFileHash`), never F''s hash.
 */
import { execFileSync } from '../spawn.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitChildEnv } from '../git-env.ts';
import { opError } from '../ops/contract.ts';
import { gitParts, splitTreeOid, splitTreeOidAt } from '../split-layout/git-parts.ts';
import { parseHead } from '../split-layout/head.ts';
import { splitPartOf } from '../split-layout/paths.ts';
import { readBlobs, type GitTreeEntry } from './sync-git-stream.ts';
import { openSplitPage, type OpenedSplitPage, type SplitPageOpen, type SplitRefusal } from '../split-layout/read.ts';
import { sha256 } from './digest.ts';
import { readSyncFile, syncGitPath, type SyncDiscovery, type SyncEntry } from './sync-discovery.ts';
import { SYNC_READ_BOUND } from './sync-blobs.ts';
import type { SyncBodyRef } from './sync-streamed.ts';
import { PARTS_KEY } from '../split-layout/types.ts';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { serr } from '../console-prefix.ts';

/** What the intent of a split head's import carries beside F' (SyncIntent.split). */
export interface SyncSplitMark {
  /** SHA-256 of the head's bytes the freeze read; the working-tree head is clean when the intent's rawHash is this. */
  head_sha256: string;
  /** The commit the head and parts were read from; null for a working-tree entry (the files beside the head). */
  commit: string | null;
  /** The head's Git path from the repository root. */
  git_path: string;
  /** F''s size and SHA-256. */
  bytes: number; sha256: string;
  /** A commit read's split page identity (git-parts.ts `splitTreeOid`), recorded as the import's blob. */
  tree_oid?: string;
}

function git(cwd: string, args: string[], maxBuffer = 1024 ** 2): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], { env: gitChildEnv(), timeout: 60_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

function open(root: string, path: string, gitPath: string, commit: string | null, head: string): SplitPageOpen {
  return openSplitPage(commit === null ? join(root, path) : gitParts(root, commit, gitPath), path, head);
}

/** The freeze of an import: `plain`, `split_invalid` with the refusal its hold carries, or `split` (SplitFreeze). */
export type SplitFreeze = { kind: 'plain' } | { kind: 'split_invalid'; refusal: SplitRefusal } | { kind: 'split'; split: SyncSplitMark; content: string | null };

/**
 * The freeze of an import whose bytes are `head` (SplitFreeze); a split page's mark carries F' as text, null over
 * `inlineMax` bytes (frozen by reference and streamed by its owner).
 */
export function freezeSplitPage(input: { root: string; path: string; gitPath: string; commit: string | null; head: string; inlineMax: number }): SplitFreeze {
  const opened = open(input.root, input.path, input.gitPath, input.commit, input.head);
  if (opened.kind !== 'split') return opened;
  try {
    return { kind: 'split', split: { head_sha256: sha256(input.head), commit: input.commit, git_path: input.gitPath, bytes: opened.bytes, sha256: opened.sha256,
      ...(input.commit === null ? {} : { tree_oid: splitTreeOidAt(input.root, input.commit, input.gitPath) }) },
      content: opened.bytes <= input.inlineMax ? readFileSync(opened.path, 'utf8') : null };
  } finally {
    opened.dispose();
  }
}

/**
 * The freeze of one import entry whose content is `head` (sync-run.ts): a committed entry reads its parts at the
 * pinned commit, or at HEAD when its head came from HEAD (`headOid`, the head's blob there); a working-tree entry
 * reads the files beside the head.
 */
export function freezeSplitEntry(cursor: Pick<SyncDiscovery, 'root' | 'gitRoot' | 'target'>, entry: Pick<SyncEntry, 'path' | 'working'>, head: string, headOid: string | null): SplitFreeze {
  if (!head.includes(PARTS_KEY)) return { kind: 'plain' };
  const gitPath = syncGitPath(cursor, entry.path);
  const commit = entry.working ? null : headOid ? headCommitHolding(cursor.root, gitPath, headOid) : cursor.target;
  return freezeSplitPage({ root: cursor.root, path: entry.path, gitPath, commit, head, inlineMax: SYNC_READ_BOUND });
}

/** The reference a split page over the read bound is frozen by; its owner reopens and streams it (sync-streamed.ts). */
export function splitBodyRef(split: SyncSplitMark): SyncBodyRef {
  return { kind: 'split_page', sha256: split.sha256, bytes: split.bytes, blob_oid: '' };
}

/** The commit HEAD names when it holds `oid` at `gitPath` (the head a freeze took from HEAD), or a `source_changed` refusal. */
export function headCommitHolding(root: string, gitPath: string, oid: string): string {
  const commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
  let blob = '';
  try { blob = git(root, ['rev-parse', '--verify', commit + ':' + gitPath]).toString('utf8').trim(); } catch {}
  if (blob === oid) return commit;
  throw opError('source_changed', 'HEAD moved while a split page was frozen.',
    gitPath + ' changed in HEAD while sync read its split page, so nothing was imported from it; sync again to read the new commit.');
}

/** The frozen page reopened from its commit (or the working tree) at preparation; null when it no longer is the frozen F'. */
export function reopenSplitPage(root: string, path: string, mark: SyncSplitMark): OpenedSplitPage | null {
  let head: Buffer | null = null;
  try { head = mark.commit === null ? readSyncFile(root, path) : git(root, ['cat-file', 'blob', mark.commit + ':' + mark.git_path]); } catch {}
  if (!head || sha256(head) !== mark.head_sha256) return null;
  const opened = open(root, path, mark.git_path, mark.commit, head.toString('utf8'));
  if (opened.kind !== 'split') return null;
  if (opened.bytes === mark.bytes && opened.sha256 === mark.sha256) return opened;
  opened.dispose();
  return null;
}

/** The page file the working-tree head `head` at `path` stands for (its parts read beside it), or null: no verified split page, or over `max` bytes. */
export function workingSplitPage(root: string, path: string, head: string, max: number): string | null {
  const opened = openSplitPage(join(root, path), path, head);
  if (opened.kind !== 'split') return null;
  try { return opened.bytes <= max ? readFileSync(opened.path, 'utf8') : null; } finally { opened.dispose(); }
}

const splitLevels = new WeakMap<Map<string, GitTreeEntry>, Map<string, string>>();

/**
 * A pass level's split page heads (sync-pass.ts): each head of `tree` that declares `gbrain_parts` and has files
 * under its parts directory (`partFiles`, from the same listing) has its split identity as its level (`splitLevelsOf`),
 * the blob id the freeze records for it (`tree_oid`), so a commit that changes only a part file moves the page. The tree
 * keeps the head's own blob id, which the index and working-tree probes compare.
 */
export async function splitHeadLevels(gitRoot: string, tree: Map<string, GitTreeEntry>, partFiles: ReadonlyArray<readonly [string, GitTreeEntry]>): Promise<void> {
  const parts = new Map<string, Array<[string, string]>>();
  for (const [path, entry] of partFiles) {
    const at = splitPartOf(path);
    if (!at || !tree.has(at.head)) continue;
    const list = parts.get(at.head) ?? [];
    list.push([at.part, entry.oid]);
    parts.set(at.head, list);
  }
  if (!parts.size) return;
  const levels = new Map<string, string>();
  const heads = await readBlobs(gitRoot, [...new Set([...parts.keys()].map(head => tree.get(head)!.oid))], 1024 ** 2);
  for (const [head, list] of parts) {
    const entry = tree.get(head)!, text = heads.get(entry.oid)?.toString('utf8');
    if (text?.includes(PARTS_KEY) && parseHead(text) !== null) levels.set(head, splitTreeOid(entry.oid, list));
  }
  splitLevels.set(tree, levels);
}

/** The split page levels `splitHeadLevels` found for a level's tree (head Git path to split identity). */
export function splitLevelsOf(tree: Map<string, GitTreeEntry>): ReadonlyMap<string, string> | undefined {
  return splitLevels.get(tree);
}

/** The hash a frozen intent's working-tree bytes (rawHash) have when the file is the one it froze: the head's for a split page. */
export function frozenFileHash(p: { content: string | null; split?: SyncSplitMark }): string | null {
  return p.split ? p.split.head_sha256 : p.content === null ? null : sha256(p.content);
}

/** At most this many pages per source are rebuilt (and counted by doctor) per run; a later run takes the rest. */
export const STALE_SPLIT_SCAN_LIMIT = 10_000;

/**
 * Wave B PR 5: the live pages of a source an older gbrain stored from a split page head, as the short page the head is
 * on its own: their frontmatter carries the top-level `gbrain_parts` key, which no current write admits
 * (persistence/split-head-admission.ts `assertNoReservedPartsKey`). `frontmatter ? 'gbrain_parts'` is the jsonb key-existence operator, served by the GIN
 * index idx_pages_frontmatter on Postgres and PGLite alike; bounded by `limit`.
 */
export async function staleSplitImports(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, limit = STALE_SPLIT_SCAN_LIMIT):
  Promise<Array<{ id: number; slug: string; source_path: string | null }>> {
  const rows = await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null }>(
    `SELECT id, slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter ? '${PARTS_KEY}' ORDER BY id LIMIT $2`, [sourceId, limit]);
  return rows.map(row => ({ id: Number(row.id), slug: row.slug, source_path: row.source_path }));
}

/**
 * A sync run (managed or classic) that names the pages it rebuilt from their split heads: those `staleSplitImports` found
 * before the run that are live and free of `gbrain_parts` after it (`split_pages_rebuilt`; a remote caller gets the count).
 */
export async function withSplitRebuilds(engine: BrainEngine, opts: Pick<SyncOpts, 'sourceId' | 'dryRun'>, run: () => Promise<SyncResult>): Promise<SyncResult> {
  const stale = opts.dryRun ? [] : await staleSplitImports(engine, opts.sourceId ?? 'default');
  const result = await run();
  if (!stale.length) return result;
  const rebuilt = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND NOT (frontmatter ? '${PARTS_KEY}') ORDER BY slug`, [stale.map(page => page.id)]);
  if (!rebuilt.length) return result;
  const remote = currentSubmissionAuthority()?.kind === 'remote_generic';
  serr(`[sync] rebuilt ${rebuilt.length} page(s) an older gbrain had stored as their split head (the lead and a notice line) from Git${remote ? '' : `: ${rebuilt.map(row => row.slug).join(', ')}`}.`);
  return { ...result, split_pages_rebuilt: { count: rebuilt.length, ...(remote ? {} : { slugs: rebuilt.map(row => row.slug) }) } };
}
