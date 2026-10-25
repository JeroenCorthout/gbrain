/**
 * G2, the door of git-canonical memory (Git is the source of truth; the database derives from it): a source whose row says `config.canonical = "git"` (strict, default off)
 * commits each published file to Git before its database row commits. publishMutation and publishGroup commit the
 * published paths with one path-only `commit --only` under the worktree's writer lock, after the files are renamed into
 * place and before the database transaction commits, and stamp the commit on the receipt
 * (`outcome.persistence.git_commit`). The Git effect of such a write only pushes.
 *
 * Recovery inverts for those writes: the recovery record names the HEAD it was prepared against (`door`), and a
 * publication that stopped after its commit landed keeps the committed file instead of restoring the prior bytes.
 * The request is queued again; its replay finds the file already holding the bytes it publishes, committed, and
 * completes the database row against it (page-prepare.ts).
 */
import { relative, sep } from 'node:path';
import { OperationError, opError } from '../ops/contract.ts';
import { commitGitTargets } from './effect-git.ts';
import type { GitCommitNote } from './effect-model.ts';
import { hashFile } from './large-file.ts';
import type { FileRecoveryRecord, SqlEngine } from './model.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { committedBlob, headBlob, headCommit } from './pending-import.ts';

/** Whether `sourceId` is a strict (git-canonical) source; `lock` reads its row FOR SHARE inside a publication. */
export async function sourceCanonicalGit(engine: SqlEngine, sourceId: string, lock = false): Promise<boolean> {
  const [row] = await engine.executeRaw<{ strict: boolean }>(
    `SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [sourceId]);
  return row?.strict === true;
}

/** The door marker a strict publication's recovery record carries: the checkout it commits in and the HEAD it started from. */
export async function doorMarker(root: string): Promise<NonNullable<FileRecoveryRecord['door']>> {
  return { root, head: await headCommit(root) };
}

/** The refusal when a strict source's flag changed between preparation and publication. */
export function strictChanged(sourceId: string): OperationError {
  return new OperationError('source_changed', `Source ${sourceId}'s canonical mode changed after this write was prepared; nothing was published.`,
    'Retry the write with a new request_id.');
}

/**
 * Commits the published files of one publication with one path-only commit under the caller's writer lock and returns
 * the commit HEAD then names (the commit that holds these bytes, also when every path was already committed). A
 * target Git refuses throws, so the publication rolls back and recovery restores the prior bytes.
 */
export async function commitThroughDoor(root: string, files: { path: string; note?: GitCommitNote }[], writerLock?: NativeLockHandle): Promise<string | null> {
  const rel = (path: string) => relative(root, path).split(sep).join('/');
  const notes = new Map(files.flatMap(file => file.note ? [[rel(file.path), file.note] as const] : []));
  const outcomes = await commitGitTargets(root, files.map(file => rel(file.path)), undefined, notes, writerLock ? { writerLock } : undefined);
  for (const [path, outcome] of outcomes) if (outcome instanceof OperationError) {
    throw opError(outcome.code === 'git_target_ignored' ? 'git_target_ignored' : 'git_unavailable', `The strict source's commit of ${path} failed, so this write was not published.`,
      `${outcome.message} A strict (canonical: git) source publishes a file only once Git holds it; recovery restores the prior bytes. Fix the checkout (git status on the brain host), then retry the write with a new request_id.`);
  }
  return headCommit(root);
}

/** Whether the working tree and HEAD both hold the record's published state at its path (its bytes, or no entry for a removal). */
export async function holdsCommittedAfter(record: FileRecoveryRecord & { door: NonNullable<FileRecoveryRecord['door']> }): Promise<boolean> {
  if (record.afterHash === null) return hashFile(record.path) === null && await headBlob(record.door.root, record.path) === null;
  return hashFile(record.path) === record.afterHash && await committedBlob(record.door.root, record.path) !== null;
}

/**
 * Whether the door commit of a stopped strict publication landed: HEAD moved past the record's starting point and
 * holds the published state. Such a file is kept, never restored.
 */
export async function doorCommitLanded(record: FileRecoveryRecord): Promise<boolean> {
  if (!record.door) return false;
  const head = await headCommit(record.door.root);
  return !!head && head !== record.door.head && await holdsCommittedAfter({ ...record, door: record.door });
}

/** A strict write replayed after its door commit landed: the file already holds the bytes it publishes, committed. */
export async function replayAfterDoorCommit(record: FileRecoveryRecord): Promise<boolean> {
  return !!record.door && record.beforeHash === record.afterHash && await holdsCommittedAfter({ ...record, door: record.door });
}
