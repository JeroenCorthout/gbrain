/**
 * Database-canonical memory, wave 3: what the import lane reads from Git, through hardened plumbing only
 * (src/core/hardened-git.ts): `rev-parse`, `ls-tree`, `cat-file --batch` and `diff-tree -r -z --no-renames`. None of
 * them converts working-tree bytes, so no clean, smudge or textconv driver a repository configures ever runs, and no hook
 * does. The commit walk feeds the foreign-writer census (who still commits page files, and how) and the deletion evidence
 * rule (#7130: a missing file is a deletion only when a commit removed it).
 */
import { hardenedGitStream, hardenedGitSync } from '../hardened-git.ts';
import { readTreeChanges } from './sync-git-stream.ts';

const LIMITS = { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 };
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EMPTY_TREE: Record<string, string> = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };

export interface GitCheckout {
  /** The Git top level of the source's checkout. */
  top: string;
  /** The source root relative to `top`, `/`-terminated, or '' when the root is the top level. */
  prefix: string;
  /** HEAD's commit, or null on an unborn branch. */
  head: string | null;
  emptyTree: string;
}

/** The checkout around `root`, or null when Git cannot say (not a work tree, or Git failed). */
export function readGitCheckout(root: string): GitCheckout | null {
  const top = hardenedGitSync(root, ['rev-parse', '--show-toplevel'], LIMITS);
  const format = hardenedGitSync(root, ['rev-parse', '--show-object-format'], LIMITS);
  if (!top.ok || !format.ok) return null;
  const topLevel = top.stdout.toString('utf8').trim();
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], LIMITS);
  if (!head.ok && !(head.reason === 'exit' && head.status === 1)) return null;
  const real = (path: string) => path.replace(/\/+$/, '');
  const prefix = real(root) === real(topLevel) ? '' : real(root).slice(real(topLevel).length + 1) + '/';
  return { top: topLevel, prefix, head: head.ok ? head.stdout.toString('utf8').trim() : null,
    emptyTree: EMPTY_TREE[format.stdout.toString('utf8').trim()] ?? EMPTY_TREE.sha1! };
}

/** Whether `commit`'s tree holds `path` (relative to the source root); null when Git could not answer. */
export function treeHoldsPath(checkout: GitCheckout, commit: string, path: string): boolean | null {
  const listed = hardenedGitSync(checkout.top, ['ls-tree', '-z', commit, '--', checkout.prefix + path], LIMITS);
  if (!listed.ok) return null;
  return listed.stdout.length > 0;
}

export interface GitPerson { name: string; email: string; at: string }
export interface GitCommitInfo { sha: string; parents: string[]; author: GitPerson | null; committer: GitPerson | null; subject: string; trailers: string[] }

function person(line: string | undefined): GitPerson | null {
  const match = line?.match(/^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/);
  if (!match) return null;
  return { name: match[1]!, email: match[2]!, at: new Date(Number(match[3]) * 1000).toISOString() };
}

/** Parses a raw commit object: parents, author, committer, the subject line and the trailer lines of the last paragraph. */
export function parseCommit(sha: string, raw: string): GitCommitInfo {
  const split = raw.indexOf('\n\n');
  const header = (split < 0 ? raw : raw.slice(0, split)).split('\n');
  const message = split < 0 ? '' : raw.slice(split + 2);
  const field = (name: string) => header.filter(line => line.startsWith(name + ' ')).map(line => line.slice(name.length + 1));
  const paragraphs = message.trimEnd().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]!.split('\n') : [];
  return { sha, parents: field('parent'), author: person(field('author')[0]), committer: person(field('committer')[0]),
    subject: message.split('\n')[0]!.trim(), trailers: last.every(line => /^[A-Za-z][A-Za-z0-9-]*: /.test(line)) ? last : [] };
}

/** Reads commit objects with one `cat-file --batch`; a missing or non-commit object is left out. */
export async function readCommits(checkout: GitCheckout, oids: readonly string[]): Promise<Map<string, GitCommitInfo>> {
  const commits = new Map<string, GitCommitInfo>();
  if (!oids.length) return commits;
  let pending = Buffer.alloc(0);
  const result = await hardenedGitStream(checkout.top, ['cat-file', '--batch'], { stdin: oids.map(oid => oid + '\n').join(''), timeoutMs: 120_000,
    maxBytes: 256 * 1024 * 1024, onChunk: chunk => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) return;
        const [oid = '', type = '', size = ''] = pending.subarray(0, newline).toString('utf8').split(' ');
        if (type === 'missing' || type === 'ambiguous') { pending = pending.subarray(newline + 1); continue; }
        const end = newline + 1 + Number(size);
        if (pending.length < end + 1) return;
        if (type === 'commit') commits.set(oid, parseCommit(oid, pending.subarray(newline + 1, end).toString('utf8')));
        pending = pending.subarray(end + 1);
      }
    } });
  if (!result.ok) throw new Error(`git cat-file could not read commits (${result.reason})`);
  return commits;
}

export interface CommitWalk {
  /** Commits newest first (by committer time), merges included. */
  commits: GitCommitInfo[];
  /** Per non-merge commit, the paths under the source root it changed (source-relative) and whether each was deleted. */
  changes: Map<string, Array<{ path: string; deleted: boolean }>>;
  /** True when the walk stopped at its commit cap before reaching `stopAt` or the horizon. */
  truncated: boolean;
}

/**
 * Walks HEAD's history back to `stopAt` (the commit a previous pass scanned up to), or to commits older than `horizonMs`,
 * at most `maxCommits` commits, breadth first over every parent. Each non-merge commit is diffed against its parent (a
 * root commit against the empty tree) with `diff-tree -r -z --no-renames`, limited to the source root; merges are not
 * diffed, because the commits they bring in are walked themselves.
 */
export async function walkCommits(checkout: GitCheckout, opts: { stopAt: string | null; horizonMs: number; maxCommits: number }): Promise<CommitWalk> {
  const walk: CommitWalk = { commits: [], changes: new Map(), truncated: false };
  if (!checkout.head) return walk;
  const seen = new Set<string>([checkout.head]);
  let frontier = [checkout.head];
  while (frontier.length) {
    const read = await readCommits(checkout, frontier);
    const next: string[] = [];
    for (const sha of frontier) {
      const commit = read.get(sha);
      if (!commit || sha === opts.stopAt) continue;
      if (commit.committer && Date.parse(commit.committer.at) < opts.horizonMs) continue;
      if (walk.commits.length >= opts.maxCommits) { walk.truncated = true; break; }
      walk.commits.push(commit);
      for (const parent of commit.parents) if (OID.test(parent) && !seen.has(parent)) { seen.add(parent); next.push(parent); }
    }
    if (walk.truncated) break;
    frontier = next;
  }
  walk.commits.sort((a, b) => Date.parse(b.committer?.at ?? '0') - Date.parse(a.committer?.at ?? '0'));
  for (const commit of walk.commits) {
    if (commit.parents.length > 1) continue;
    const changed = await readTreeChanges(checkout.top, commit.parents[0] ?? checkout.emptyTree, commit.sha, checkout.prefix.replace(/\/$/, ''));
    walk.changes.set(commit.sha, (changed ?? []).filter(change => change.path.startsWith(checkout.prefix))
      .map(change => ({ path: change.path.slice(checkout.prefix.length), deleted: change.entry === null })));
  }
  return walk;
}

/**
 * Process hints, as data: what a commit's subject, trailers or identity say about the process that made it. `gbrain_owned`
 * marks the managed Git effect, whose page commits the exporter replaces in database mode, so it is never a writer to move.
 * The first matching row wins; a commit no row matches has no hint (a person, as far as Git can tell).
 */
export const PROCESS_HINTS: ReadonlyArray<{ hint: string; gbrain_owned: boolean; matches: (commit: Pick<GitCommitInfo, 'subject' | 'author' | 'committer' | 'trailers'>) => boolean }> = [
  { hint: 'gbrain_git_effect', gbrain_owned: true, matches: c => /^gbrain: persist (?:\d+ )?canonical memory update/.test(c.subject) },
  { hint: 'gbrain_commit_push', gbrain_owned: false, matches: c => /^gbrain: (?:merge|replay)\b/.test(c.subject) },
  { hint: 'gbrain_sources_push', gbrain_owned: false, matches: c => c.subject.startsWith('gbrain: workspace push') },
  { hint: 'agent_session', gbrain_owned: false, matches: c => c.trailers.some(line => /^(?:Co-authored-by|Co-Authored-By): .*\b(?:agent|assistant|bot)\b/i.test(line)) },
  { hint: 'automation', gbrain_owned: false, matches: c => [c.author, c.committer].some(p => !!p && (/\[bot\]|\bbot\b|\bcron\b|auto-?commit|automation/i.test(p.name) || /\[bot\]|\bbot\b|cron|noreply\+?auto/i.test(p.email))) },
  { hint: 'auto_commit_message', gbrain_owned: false, matches: c => /^(?:auto(?:matic)?[- ]?commit|autosave|wip: auto|sync:)/i.test(c.subject) },
];

export const GBRAIN_OWNED_HINTS: ReadonlySet<string> = new Set(PROCESS_HINTS.filter(h => h.gbrain_owned).map(h => h.hint));

export function processHint(commit: Pick<GitCommitInfo, 'subject' | 'author' | 'committer' | 'trailers'>): string | null {
  return PROCESS_HINTS.find(row => row.matches(commit))?.hint ?? null;
}

/** The census groups changes by this: the author's address (or name), plus the process hint. */
export function writerKey(author: GitPerson | null, hint: string | null): string {
  return `${(author?.email || author?.name || 'unknown').toLowerCase()}|${hint ?? 'person'}`;
}

/** The first line of a commit message, at most 72 characters: enough to tell writers apart, never a body. */
export function messagePrefix(subject: string): string {
  return subject.length > 72 ? subject.slice(0, 71) + '…' : subject;
}
