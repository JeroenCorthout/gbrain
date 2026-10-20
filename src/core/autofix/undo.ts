/**
 * GBRA-133 PR 3: the undo of an automatic file repair (`gbrain sync undo`). It reverts exactly one isolated repair commit a
 * `sync-autofix` receipt recorded: under the source's writer lock (the lock the persistence owner's Git effects take,
 * so nothing else writes the checkout meanwhile) it writes back the bytes the repair replaced and commits that one path
 * as a new commit (no force push, no history rewrite; the owner's next push publishes it). The next sync screens the
 * file as it was before the repair (held again when sync would hold it). A file that changed since the repair is
 * refused (`autofix_undo_conflict`), so a later edit is never overwritten. The undo leaves an `undone` receipt, and an
 * automatic repair never reapplies itself to those same bytes (`undoneSkipPaths`); editing the file lifts that.
 *
 * Preview first: without `apply` it reports what it would restore and writes nothing. A managed worktree refuses
 * `gbrain git commit-push` (its owner is the only writer), which is why the revert lives here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { sha256 } from '../persistence/digest.ts';
import { readAutofixReceipts, recordAutofixReceipts, type AutofixReceipt } from './receipts.ts';

const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
/** How long `--apply` waits for the writer lock before it refuses (the owner may be committing). */
const UNDO_LOCK_WAIT_MS = 30_000;

export interface AutofixUndoOutcome {
  source_id: string;
  commit: string;
  path: string;
  receipt_id: string;
  mode: 'preview' | 'apply';
  /** The file returns to these bytes (the repair's preimage). */
  restores_sha256: string;
  /** The undo commit (apply only). */
  undo_commit: string | null;
  status: 'would_revert' | 'reverted';
  /** The kind's switch: off, no automatic repair runs again; on, it still skips these restored bytes. */
  opt_out: string[];
}

const git = (root: string, args: string[]): Buffer => execFileSync('git', ['-C', root, ...args],
  { env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

function fileHash(root: string, path: string): string | null {
  try { return sha256(readFileSync(join(root, path))); } catch { return null; }
}

const help = (sourceId: string) => `List the source's autofix receipts with gbrain sync status --source ${sourceId} --json (autofix.recent); each landed repair names its undo.`;

export async function undoAutofixCommit(engine: BrainEngine, opts: { sourceId: string; sha: string; apply: boolean }): Promise<AutofixUndoOutcome> {
  const { sourceId } = opts;
  const sha = opts.sha.trim().toLowerCase();
  if (!OID.test(sha)) throw opError('invalid_params', `${opts.sha} is not a full commit id (40 or 64 hex digits).`, help(sourceId));
  const receipt: AutofixReceipt | undefined = (await readAutofixReceipts(engine, sourceId)).find(r => r.outcome === 'applied' && r.commit.state === 'landed' && r.commit.sha === sha);
  if (!receipt) throw opError('autofix_undo_unavailable', `Commit ${sha.slice(0, 12)} is not a repair commit an autofix receipt of source ${sourceId} recorded, so gbrain will not revert it.`, help(sourceId));
  const path = receipt.path, preimage = receipt.preimage, postimage = receipt.postimage_sha256;
  if (!path || !preimage || !postimage) throw opError('autofix_undo_unavailable', `The receipt of commit ${sha.slice(0, 12)} keeps no recovery material, so no undo exists for it.`, help(sourceId));
  const { managedRepairRoot } = await import('../persistence/file-repair.ts');
  const { root } = await managedRepairRoot(engine, sourceId, 'frontmatter', { remote: false });
  let touched: string[] = [], pre: Buffer | null = null;
  try {
    touched = git(root, ['diff-tree', '--no-commit-id', '--name-only', '--relative', '-r', '-z', '--no-renames', sha]).toString().split('\0').filter(Boolean);
    pre = git(root, ['cat-file', 'blob', `${sha}^:./${path}`]);
  } catch { pre = null; }
  if (!pre || touched.length !== 1 || touched[0] !== path || sha256(pre) !== preimage.sha256) {
    throw opError('autofix_undo_unavailable', `Commit ${sha.slice(0, 12)} is not (or no longer) the isolated repair of ${path} its receipt recorded in this checkout, so gbrain will not revert it.`, help(sourceId));
  }
  if (fileHash(root, path) !== postimage) {
    throw opError('autofix_undo_conflict', `${path} changed after the repair (or is gone), so reverting it would overwrite a later edit; nothing was written.`,
      'Edit the file by hand if the repair is still unwanted, commit, and run gbrain sync --source <id> --no-pull.');
  }
  const { admissionRow } = await import('./admission.ts');
  const optOut = ['gbrain', 'config', 'set', admissionRow(receipt.kind).switches[0] ?? 'sync.autofix.enabled', 'false'];
  const base = { source_id: sourceId, commit: sha, path, receipt_id: receipt.id, restores_sha256: preimage.sha256, opt_out: optOut };
  if (!opts.apply) return { ...base, mode: 'preview', undo_commit: null, status: 'would_revert' };

  const { getWorktreeBinding, acquireWorktree } = await import('../persistence/ownership.ts');
  const { withFilesystemPublication } = await import('../persistence/filesystem-guard.ts');
  const { commitGitTargets } = await import('../persistence/effect-git.ts');
  const binding = await getWorktreeBinding(engine, sourceId);
  const lock = binding ? await acquireWorktree(binding, UNDO_LOCK_WAIT_MS, undefined, engine) : null;
  if (!lock) throw opError('writer_busy', `The writer lock of source ${sourceId} stayed busy, so the undo wrote nothing.`, `Retry: gbrain sync undo --source ${sourceId} --commit ${sha} --apply`);
  let undoCommit: string | null = null;
  try {
    if (fileHash(root, path) !== postimage) {
      throw opError('autofix_undo_conflict', `${path} changed while the undo waited for the writer lock; nothing was written.`,
        'Edit the file by hand if the repair is still unwanted, commit, and run gbrain sync --source <id> --no-pull.');
    }
    const subject = `gbrain: undo automatic repair ${sha.slice(0, 12)} of ${path}`;
    const outcomes = await withFilesystemPublication([root], async () => {
      writeFileSync(join(root, path), pre!);
      return commitGitTargets(root, [path], undefined, new Map([[path, { subject, line: `Reverts ${sha}.` }]]), { writerLock: lock });
    });
    const outcome = outcomes.get(path);
    if (!outcome || outcome instanceof Error) throw outcome ?? opError('internal', `The undo commit of ${path} did not land.`, 'Run gbrain sources writer status --json.');
    undoCommit = git(root, ['rev-parse', 'HEAD']).toString().trim();
  } finally { lock.release(); }
  await recordAutofixReceipts(engine, sourceId, [{ kind: receipt.kind, admission: 'operator', outcome: 'undone', code: receipt.code, path, disabling_key: receipt.disabling_key,
    preimage: { sha256: postimage, blob_oid: null }, postimage_sha256: preimage.sha256, commit: { state: 'landed', sha: undoCommit } }]);
  return { ...base, mode: 'apply', undo_commit: undoCommit, status: 'reverted' };
}

/**
 * The paths of a source an operator undid whose bytes are still the restored ones (an `undone` receipt's postimage):
 * automatic repairs skip them. Editing the file (new bytes) lifts the skip.
 */
export async function undoneSkipPaths(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const undone = (await readAutofixReceipts(engine, sourceId)).filter(r => r.outcome === 'undone' && r.path && r.postimage_sha256);
  if (!undone.length) return [];
  const { managedRepairRoot } = await import('../persistence/file-repair.ts');
  const root = await managedRepairRoot(engine, sourceId, 'frontmatter', { remote: false }).then(r => r.root).catch(() => null);
  if (!root) return [];
  return [...new Set(undone.filter(r => fileHash(root, r.path!) === r.postimage_sha256).map(r => r.path!))];
}

/** `undoneSkipPaths` over every source a maintenance repair run covers (a repair kind takes `skip` paths). */
export async function undoneRepairPaths(engine: BrainEngine, sourceIds: readonly string[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const sourceId of sourceIds) for (const path of await undoneSkipPaths(engine, sourceId).catch(() => [] as string[])) paths.add(path);
  return [...paths];
}
