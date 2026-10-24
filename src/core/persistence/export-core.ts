/**
 * Database-canonical memory, wave 5a: the bare-repository export core (docs/designs/database-canonical-w5-contract.md,
 * "Bare-repository core"). Every function takes only a Git directory (a bare repository or a checkout) and runs plumbing:
 * blobs are written with `hash-object -w --no-filters`, trees are built in a private index file, commits with
 * `commit-tree`, refs move only by compare-and-set `update-ref`. Nothing here reads or writes a worktree, runs a hook, a
 * filter driver or a pager, or asks for credentials, so it is the seam a hosted brain exports through with no checkout at
 * all; the checkout exporter (exporter.ts) adds the worktree and index steps on top.
 */
import { spawn } from '../spawn.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitChildEnv } from '../git-env.ts';
import { persistenceHome } from './identity.ts';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' };
const STEP_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

export interface GitRunResult { code: number | null; stdout: Buffer; stderr: string; timedOut: boolean }
export interface GitRunOptions { input?: Buffer | string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }

function emptyHooks(): string {
  const dir = join(persistenceHome(), 'empty-hooks', 'export');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** One bounded git call in `dir` with an empty hooks directory, signing off and a C locale. Never throws for an exit code. */
export function gitRun(dir: string, args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  return new Promise(resolve => {
    const child = spawn('git', ['-C', dir, '-c', `core.hooksPath=${emptyHooks()}`, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', ...args],
      { env: gitChildEnv({ ...GIT_ENV, ...(opts.env ?? {}) }), stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs ?? STEP_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    };
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_OUTPUT) child.kill('SIGTERM'); else out.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

export class ExportGitError extends Error {
  constructor(readonly step: string, readonly result: GitRunResult) {
    super(`git ${step} failed (${result.timedOut ? 'timed out' : `exit ${result.code}`}): ${result.stderr.trim().slice(0, 300) || 'no detail'}`);
  }
}

async function gitOk(dir: string, args: string[], step: string, opts: GitRunOptions = {}): Promise<string> {
  const result = await gitRun(dir, args, opts);
  if (result.code !== 0) throw new ExportGitError(step, result);
  return result.stdout.toString('utf8').replace(/\n$/, '');
}

/** The commit or object `rev` names, or null when it does not resolve. */
export async function resolveRev(dir: string, rev: string): Promise<string | null> {
  const result = await gitRun(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null;
}

export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitRun(dir, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/** The all-zero object id of this repository's hash (40 hex digits for SHA-1, 64 for SHA-256). */
export async function nullOid(dir: string): Promise<string> {
  const format = (await gitRun(dir, ['rev-parse', '--show-object-format'])).stdout.toString('utf8').trim();
  return '0'.repeat(format === 'sha256' ? 64 : 40);
}

/** Writes `bytes` as a blob exactly as given: no clean filter, no line-ending conversion. */
export async function writeBlob(dir: string, bytes: Buffer | string): Promise<string> {
  return gitOk(dir, ['hash-object', '-w', '--no-filters', '--stdin'], 'hash-object', { input: bytes });
}

/** One path of a tree build: the blob it holds (mode 100644), or null to remove it. Paths are repository-relative POSIX. */
export interface ExportTreeEntry { path: string; blob: string | null }

/**
 * The tree of `base` (a commit or tree, or null for an empty tree) with `entries` applied, built in a private index file
 * (`GIT_INDEX_FILE`) so the repository's own index is never read or written.
 */
export async function buildExportTree(dir: string, base: string | null, entries: readonly ExportTreeEntry[], signal?: AbortSignal): Promise<string> {
  const scratch = join(persistenceHome(), 'export-index');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(scratch, 'build-'));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    if (base) await gitOk(dir, ['read-tree', base], 'read-tree', { env, signal });
    else await gitOk(dir, ['read-tree', '--empty'], 'read-tree', { env, signal });
    if (entries.length) {
      const zero = await nullOid(dir);
      const info = entries.map(e => e.blob ? `100644 ${e.blob}\t${e.path}\0` : `0 ${zero}\t${e.path}\0`).join('');
      await gitOk(dir, ['update-index', '-z', '--index-info'], 'update-index', { env, input: info, signal });
    }
    return await gitOk(dir, ['write-tree'], 'write-tree', { env, signal });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export interface ExportIdentity { name: string; email: string }
/** Commits made by the exporter carry the checkout's configured identity, else this one. */
export const EXPORTER_IDENTITY: ExportIdentity = { name: 'gbrain exporter', email: 'exporter@gbrain.invalid' };

async function configured(dir: string, key: string): Promise<string | null> {
  const result = await gitRun(dir, ['config', '--get', key]);
  return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null;
}

export async function exportIdentity(dir: string): Promise<ExportIdentity> {
  const [name, email] = await Promise.all([configured(dir, 'user.name'), configured(dir, 'user.email')]);
  return name && email ? { name, email } : EXPORTER_IDENTITY;
}

export async function commitExportTree(dir: string, tree: string, parents: readonly string[], message: string, identity?: ExportIdentity): Promise<string> {
  const who = identity ?? await exportIdentity(dir);
  const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  return gitOk(dir, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p])], 'commit-tree', { env, input: message.endsWith('\n') ? message : `${message}\n` });
}

/** Moves `ref` to `next` only while it still names `expected` (null: the ref must not exist yet). False when it moved. */
export async function compareAndSetRef(dir: string, ref: string, next: string, expected: string | null, reason = 'gbrain export'): Promise<boolean> {
  const old = expected ?? await nullOid(dir);
  return (await gitRun(dir, ['update-ref', '-m', reason, ref, next, old])).code === 0;
}

/** `parent`'s tree with `entries` applied, committed on `parent`: the whole bare-repository export of one batch. */
export async function buildExportCommit(dir: string, input: { parent: string | null; entries: readonly ExportTreeEntry[]; message: string; identity?: ExportIdentity; signal?: AbortSignal }): Promise<{ tree: string; commit: string }> {
  const tree = await buildExportTree(dir, input.parent, input.entries, input.signal);
  const commit = await commitExportTree(dir, tree, input.parent ? [input.parent] : [], input.message, input.identity);
  return { tree, commit };
}

export interface TreeBlob { mode: string; type: string; oid: string }

/** The entries `commit` holds at exactly these paths (absent paths are missing from the map). */
export async function readTreeEntries(dir: string, commit: string, paths: readonly string[]): Promise<Map<string, TreeBlob>> {
  const found = new Map<string, TreeBlob>();
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const out = await gitOk(dir, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...chunk], 'ls-tree');
    for (const record of out.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      found.set(record.slice(tab + 1), { mode: mode!, type: type!, oid: oid! });
    }
  }
  return found;
}

/** The paths that differ between two trees or commits, recursively, without rename detection. */
export async function changedPaths(dir: string, from: string, to: string): Promise<string[]> {
  const out = await gitOk(dir, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to], 'diff-tree');
  return out.split('\0').filter(Boolean);
}

/** Every path any commit in `from..to` touched (merges included), without rename detection. */
export async function rangePaths(dir: string, from: string | null, to: string): Promise<string[]> {
  const range = from ? `${from}..${to}` : to;
  const out = await gitOk(dir, ['log', '--format=', '--name-only', '-z', '--no-renames', '-m', range], 'log');
  return [...new Set(out.split(/[\0\n]/).filter(Boolean))];
}

export interface MergedTree { tree: string; conflicts: string[] }

/** A three-way merge of two commits in memory (`merge-tree --write-tree`); the tree holds conflict markers at `conflicts`. */
export async function mergeExportTrees(dir: string, ours: string, theirs: string): Promise<MergedTree> {
  const result = await gitRun(dir, ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, theirs]);
  if (result.code !== 0 && result.code !== 1) throw new ExportGitError('merge-tree', result);
  const fields = result.stdout.toString('utf8').split('\0');
  return { tree: fields[0]!.trim(), conflicts: result.code === 1 ? [...new Set(fields.slice(1).filter(Boolean))] : [] };
}

export type PushOutcome = { status: 'pushed' } | { status: 'rejected'; stderr: string } | { status: 'failed'; stderr: string };

/** Git's refusal of a push because the remote branch moved (LC_ALL=C keeps it untranslated). */
const NON_FAST_FORWARD = /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|\[remote rejected\][^\n]*(?:cannot lock ref|stale info)/;

/** Pushes `commit` to `mergeRef` on `remote`. Never forces: a commit that does not descend from the remote tip is rejected. */
export async function pushExportCommit(dir: string, remote: string, commit: string, mergeRef: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PushOutcome> {
  const result = await gitRun(dir, ['push', '--porcelain', '--no-verify', '--', remote, `${commit}:${mergeRef}`], { timeoutMs: opts.timeoutMs ?? 300_000, signal: opts.signal });
  if (result.code === 0) return { status: 'pushed' };
  const text = `${result.stdout.toString('utf8')}\n${result.stderr}`;
  return NON_FAST_FORWARD.test(text) ? { status: 'rejected', stderr: result.stderr } : { status: 'failed', stderr: result.stderr.trim().slice(0, 300) };
}

/** Fetches `mergeRef` from `remote` into `trackingRef`; returns the fetched tip, or null when the fetch failed. */
export async function fetchExportTip(dir: string, remote: string, mergeRef: string, trackingRef: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  const result = await gitRun(dir, ['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', '--', remote, `+${mergeRef}:${trackingRef}`],
    { timeoutMs: opts.timeoutMs ?? 300_000, signal: opts.signal });
  if (result.code !== 0) return null;
  return resolveRev(dir, trackingRef);
}

export interface ExportUpstream { branch: string; branchRef: string; remote: string | null; mergeRef: string | null; trackingRef: string | null }

/** The checked-out branch and its tracking remote (null fields: no upstream, so exports stay local). Null for a detached HEAD. */
export async function readExportUpstream(dir: string): Promise<ExportUpstream | null> {
  const head = await gitRun(dir, ['symbolic-ref', '--quiet', 'HEAD']);
  if (head.code !== 0) return null;
  const branchRef = head.stdout.toString('utf8').trim();
  const branch = branchRef.replace(/^refs\/heads\//, '');
  const remote = await configured(dir, `branch.${branch}.remote`);
  const mergeRef = await configured(dir, `branch.${branch}.merge`);
  if (!remote || remote === '.' || !mergeRef) return { branch, branchRef, remote: null, mergeRef: null, trackingRef: null };
  return { branch, branchRef, remote, mergeRef, trackingRef: `refs/remotes/${remote}/${mergeRef.replace(/^refs\/heads\//, '')}` };
}
