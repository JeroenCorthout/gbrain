/**
 * GBRA-133 PR 3: the undo of an automatic file repair. A managed canonical worktree has one writer, the source's
 * persistence owner (`gbrain git commit-push` refuses it), so the undo is the repair's inverse write submitted to that
 * owner: the preimage bytes the receipt's repair commit replaced, bound to the postimage hash the file must still have.
 * The owner publishes the page and its Git effect lands one new commit under the writer lock; nothing is force-pushed
 * and history is never rewritten. Only a commit a `sync-autofix` receipt recorded can be undone here, and a file that
 * changed since the repair is refused (`autofix_undo_conflict`), so a later edit is never overwritten.
 *
 * Preview first: without `apply` it reports what it would restore and writes nothing.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { sha256 } from '../persistence/digest.ts';
import { readAutofixReceipts, type AutofixReceipt } from './receipts.ts';

const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export interface AutofixUndoOutcome {
  source_id: string;
  commit: string;
  path: string;
  slug: string;
  receipt_id: string;
  mode: 'preview' | 'apply';
  /** The file returns to these bytes (the repair's preimage). */
  restores_sha256: string;
  request_id: string | null;
  status: 'would_revert' | 'reverted';
}

const git = (root: string, args: string[]): Buffer => execFileSync('git', ['-C', root, ...args],
  { env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

function refuse(code: Parameters<typeof opError>[0], message: string, sourceId: string): never {
  throw opError(code, message, `List the source's autofix receipts with gbrain sync status --source ${sourceId} --json (autofix.recent); each landed repair names its undo.`);
}

export async function undoAutofixCommit(engine: BrainEngine, opts: { sourceId: string; sha: string; apply: boolean }): Promise<AutofixUndoOutcome> {
  const { sourceId } = opts;
  const sha = opts.sha.trim().toLowerCase();
  if (!OID.test(sha)) refuse('invalid_params', `${opts.sha} is not a full commit id (40 or 64 hex digits).`, sourceId);
  const receipt: AutofixReceipt | undefined = (await readAutofixReceipts(engine, sourceId)).find(r => r.commit.state === 'landed' && r.commit.sha === sha);
  if (!receipt) refuse('autofix_undo_unavailable', `Commit ${sha.slice(0, 12)} is not a repair commit an autofix receipt of source ${sourceId} recorded, so gbrain will not revert it.`, sourceId);
  if (!receipt.path || !receipt.preimage || !receipt.postimage_sha256) refuse('autofix_undo_unavailable', `The receipt of commit ${sha.slice(0, 12)} keeps no recovery material, so no undo exists for it.`, sourceId);
  const { managedRepairRoot } = await import('../persistence/file-repair.ts');
  const { root } = await managedRepairRoot(engine, sourceId, 'frontmatter', { remote: false });
  let touched: string[], pre: Buffer;
  try {
    touched = git(root, ['diff-tree', '--no-commit-id', '--name-only', '--relative', '-r', '-z', '--no-renames', sha]).toString().split('\0').filter(Boolean);
    pre = git(root, ['cat-file', 'blob', `${sha}^:./${receipt.path}`]);
  } catch { refuse('autofix_undo_unavailable', `Commit ${sha.slice(0, 12)} or its parent's copy of ${receipt.path} is not in this checkout, so it cannot be reverted here.`, sourceId); }
  if (touched.length !== 1 || touched[0] !== receipt.path || sha256(pre) !== receipt.preimage.sha256) {
    refuse('autofix_undo_unavailable', `Commit ${sha.slice(0, 12)} is not the isolated repair of ${receipt.path} its receipt recorded, so gbrain will not revert it.`, sourceId);
  }
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  let current: string | null = null;
  try { current = sha256(readFileSync(join(root, receipt.path))); } catch { current = null; }
  if (current !== receipt.postimage_sha256) {
    refuse('autofix_undo_conflict', `${receipt.path} changed after the repair (or is gone), so reverting it would overwrite a later edit; nothing was written. Edit the file by hand if the repair is still unwanted.`, sourceId);
  }
  const { canonicalOriginPage } = await import('../persistence/origin-guard.ts');
  const { resolveSlugForPath } = await import('../sync.ts');
  const origin = await canonicalOriginPage(engine, sourceId, receipt.path);
  if (origin && 'ambiguous' in origin) refuse('autofix_undo_unavailable', `Several pages claim ${receipt.path}, so the revert cannot name one; resolve them first (gbrain repair origin-twins --source ${sourceId}).`, sourceId);
  const slug = origin?.slug ?? resolveSlugForPath(receipt.path);
  const base = { source_id: sourceId, commit: sha, path: receipt.path, slug, receipt_id: receipt.id, restores_sha256: receipt.preimage.sha256 };
  if (!opts.apply) return { ...base, mode: 'preview', request_id: null, status: 'would_revert' };
  const { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } = await import('../persistence/file-repair.ts');
  const { repairRequestId } = await import('../repair/core.ts');
  const content = pre.toString('utf8');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const live = snapshot && !snapshot.page.deleted_at ? snapshot : null;
  const publication = await prepareRepairPublication(engine, { sourceId, slug, sourcePath: receipt.path, path: receipt.path, root, content, snapshot: live, base: live, ...await repairScreenConfig(engine, sourceId) });
  if (publication.status === 'refused') refuse('autofix_undo_unavailable', `Importing the restored ${receipt.path} would be refused (${publication.refusal.code}), so nothing was written.`, sourceId);
  if (publication.status === 'overlay') refuse('autofix_undo_unavailable', `The restored ${receipt.path} would drop page data the file does not carry, so nothing was written.`, sourceId);
  const { loadConfig } = await import('../config.ts');
  const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const requestId = await repairRequestId(ctx, 'frontmatter', { source_id: sourceId, slug }, `autofix-undo:${sha}:${receipt.postimage_sha256}`);
  await submitManagedFileRepair(ctx, { sourceId, requestId, slug, path: receipt.path, sourcePath: receipt.path, content, beforeHash: receipt.postimage_sha256,
    resultDigest: publication.digest, ...(live ? { expected_revision: live.revision } : {}), noEmbed: true });
  return { ...base, mode: 'apply', request_id: requestId, status: 'reverted' };
}
