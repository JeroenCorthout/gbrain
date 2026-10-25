/**
 * Split git layout (Wave B PR 5): a split page's part files as one commit has them, for readers that import a commit
 * (managed sync). The same check as on disk (verify.ts `PartsSource`): a part is a regular file blob (mode 100644 or
 * 100755; a symlink, a submodule or a tree never matches) of exactly its manifest size and SHA-256, and every other
 * entry of the parts directory is unlisted. Paths are Git paths from the repository root.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { gitChildEnv } from '../git-env.ts';
import { partsDirName } from './paths.ts';
import { feedPart, type PartsSource } from './verify.ts';

interface TreeEntry { mode: string; type: string; oid: string; size: number }

function git(cwd: string, args: string[], maxBuffer = 4 * 1024 ** 2): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', '-C', cwd, ...args], { env: gitChildEnv(), timeout: 60_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `ls-tree` rows of one Git path at a commit (the entry itself, or with a trailing slash its children), by full path. */
function lsTree(cwd: string, commit: string, path: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (const row of git(cwd, ['ls-tree', '--full-tree', '-l', '-z', commit, '--', path]).toString('utf8').split('\0')) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, size] = row.slice(0, tab).split(/\s+/);
    out.set(row.slice(tab + 1), { mode: mode!, type: type!, oid: oid!, size: Number(size) });
  }
  return out;
}

/**
 * The Git identity of a split page at a commit: a hash (in the object format of `headOid`) of the head's blob id and
 * every file under its parts directory (path inside it and blob id). Sync records it as the page's imported blob, so a
 * commit that changes only a part file changes the page's identity (sync-pass.ts reads it from the tree listing).
 */
export function splitTreeOid(headOid: string, parts: Iterable<readonly [string, string]>): string {
  const listed = [...parts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, oid]) => path + ' ' + oid + '\n').join('');
  return createHash(headOid.length === 64 ? 'sha256' : 'sha1').update('gbrain split page\0' + headOid + '\0' + listed).digest('hex');
}

/** `splitTreeOid` of the head at `headGitPath` in `commit`, read through the repository that holds `cwd`. */
export function splitTreeOidAt(cwd: string, commit: string, headGitPath: string): string {
  const headOid = git(cwd, ['rev-parse', '--verify', commit + ':' + headGitPath]).toString('utf8').trim();
  const dir = posix.join(posix.dirname(headGitPath), partsDirName(posix.basename(headGitPath))) + '/';
  const parts: Array<[string, string]> = [];
  for (const row of git(cwd, ['ls-tree', '-r', '--full-tree', '-z', commit, '--', dir]).toString('utf8').split('\0')) {
    const tab = row.indexOf('\t');
    if (tab >= 0) parts.push([row.slice(tab + 1).slice(dir.length), row.slice(0, tab).split(/\s+/)[2]!]);
  }
  return splitTreeOid(headOid, parts);
}

/** The part files of the head at `headGitPath` in `commit`, read through the repository that holds `cwd`. */
export function gitParts(cwd: string, commit: string, headGitPath: string): PartsSource {
  const dir = posix.dirname(headGitPath);
  const prefix = dir === '.' ? '' : dir + '/';
  let entries = new Map<string, TreeEntry>();
  let dirName = '';
  return {
    headName: posix.basename(headGitPath),
    list: name => {
      dirName = name;
      const self = lsTree(cwd, commit, prefix + name).get(prefix + name);
      if (!self) return 'missing';
      if (self.type !== 'tree') return 'not_a_directory';
      entries = lsTree(cwd, commit, prefix + name + '/');
      return [...entries.keys()].map(path => path.slice(prefix.length + name.length + 1));
    },
    read: (partPath, bytes, sha256, sinks, write) => {
      const entry = entries.get(prefix + partPath);
      if (!entry || !partPath.startsWith(dirName + '/')) return 'missing';
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || entry.size !== bytes) return 'mismatched';
      return feedPart(git(cwd, ['cat-file', 'blob', entry.oid], bytes + 1), bytes, sha256, sinks, write);
    },
  };
}
