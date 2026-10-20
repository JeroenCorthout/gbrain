/**
 * GBRA-133 PR 3: gbrain's automatic re-screens, each behind its own kill switch under the umbrella `sync.autofix.enabled`.
 * A re-screen changes no file and no page: it only asks the next sync to read a held path again.
 *
 * - `preparation_rescreen` (`sync.autofix.preparation_rescreen`): a `preparation_stalled` or `write_interrupted` hold (the
 *   write owner stalled, not the file) is re-screened by every sync while under `HOLD_ATTEMPTS_NEEDS_HUMAN` attempts and
 *   after an upgrade (`holdRescreenDue`, sync-holds.ts, takes the policy `readRescreenPolicy` returns). Off, such a hold
 *   waits for `gbrain sources retry-held` like any other.
 * - `worktree_dirty_rescreen` (`sync.autofix.worktree_dirty_rescreen`): after a managed sync, a `worktree_dirty` hold this
 *   sync screened whose working-tree bytes are now committed at HEAD is scheduled for a re-screen (the same check
 *   `gbrain sync unblock --apply` makes), so the next sync imports it with no operator.
 *
 * Every scheduled re-screen leaves a `sync-autofix` receipt (outcome `scheduled`) naming its switch; a preparation hold gets
 * one receipt per attempt.
 */
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { serr } from '../console-prefix.ts';
import { holdRescreenDue, outOfAttemptsHold, readGitHoldRetryPaths, readGitSourceHolds, requestGitHoldRetry, type RescreenPolicy } from '../persistence/sync-holds.ts';
import { admitAutofix } from './admission.ts';
import { readAutofixReceipts, recordAutofixReceipts, settleAutofixCommits, type AutofixReceiptInput } from './receipts.ts';
import { AUTOFIX_PREPARATION_RESCREEN_KEY, AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY } from './switches.ts';

const OK_STATUSES = ['synced', 'first_sync', 'up_to_date'];

/** Which automatic re-screens are admitted now (an operator's retry request re-screens a hold whatever this says). */
export async function readRescreenPolicy(engine: Pick<BrainEngine, 'getConfig'>): Promise<RescreenPolicy> {
  return { preparation: (await admitAutofix(engine, 'preparation_rescreen', { admission: 'automatic' })).admitted };
}

/** Records the landed commit of the source's pending repair receipts (settleAutofixCommits), from the owner's canonical root. */
async function settleLandedRepairs(engine: BrainEngine, sourceId: string): Promise<void> {
  if (!(await readAutofixReceipts(engine, sourceId)).some(r => r.commit.state === 'pending')) return;
  const { managedRepairRoot } = await import('../persistence/file-repair.ts');
  const root = await managedRepairRoot(engine, sourceId, 'frontmatter', { remote: false }).then(r => r.root).catch(() => null);
  if (root) await settleAutofixCommits(engine, sourceId, root);
}

/**
 * The post-sync autofix step of a managed sync: settles the repair commits that have landed since, schedules the committed `worktree_dirty` holds this sync screened and
 * receipts the preparation holds the next sync re-screens by itself. Never throws; a failure is logged and the result
 * returned as it was.
 */
export async function rescreenAfterManagedSync(engine: BrainEngine, outer: SyncOpts, result: SyncResult): Promise<SyncResult> {
  if (outer.dryRun || !OK_STATUSES.includes(result.status)) return result;
  const sourceId = outer.sourceId ?? 'default';
  try {
    await settleLandedRepairs(engine, sourceId);
    if (!result.held?.length) return result;
    const touched = new Set(result.held.map(item => item.path));
    const listed = (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0];
    const incarnation = listed?.incarnation;
    const holds = (listed?.holds ?? []).filter(hold => hold.incarnation === incarnation && touched.has(hold.path));
    if (!incarnation || !holds.length) return result;
    const retry = new Set(await readGitHoldRetryPaths(engine, sourceId, incarnation));
    const receipts: AutofixReceiptInput[] = [];
    const dirty = holds.filter(hold => hold.code === 'worktree_dirty' && !retry.has(hold.path));
    if (dirty.length && (await admitAutofix(engine, 'worktree_dirty_rescreen', { admission: 'automatic', sourceKind: 'managed' })).admitted) {
      const { resolveManagedSyncContext } = await import('../persistence/sync-discovery.ts');
      const { headCommittedBytes } = await import('../persistence/sync-page-fault.ts');
      const context = await resolveManagedSyncContext(engine, { sourceId, noPull: true }).catch(() => null);
      const committed = context ? dirty.filter(hold => headCommittedBytes(context, hold.path) !== null).map(hold => hold.path) : [];
      if (committed.length) {
        await requestGitHoldRetry(engine, sourceId, incarnation, committed);
        for (const path of committed) receipts.push({ kind: 'worktree_dirty_rescreen', admission: 'automatic', outcome: 'scheduled', code: 'worktree_dirty', path, disabling_key: AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY });
        serr(`[sync] ${committed.length} held file(s) of ${sourceId} are now committed at HEAD; scheduled a re-screen so the next sync imports them. Opt out: gbrain config set ${AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY} false.`);
      }
    }
    const policy = await readRescreenPolicy(engine);
    const stalled = holds.filter(hold => outOfAttemptsHold(hold.code) && !retry.has(hold.path) && holdRescreenDue(hold, false, policy));
    if (stalled.length) {
      const seen = new Set((await readAutofixReceipts(engine, sourceId)).filter(r => r.kind === 'preparation_rescreen').map(r => `${r.path}\u0000${r.reason}`));
      for (const hold of stalled) {
        const reason = `attempt_${hold.meta.attempts ?? 1}`;
        if (!seen.has(`${hold.path}\u0000${reason}`)) receipts.push({ kind: 'preparation_rescreen', admission: 'automatic', outcome: 'scheduled', code: hold.code, reason, path: hold.path, disabling_key: AUTOFIX_PREPARATION_RESCREEN_KEY });
      }
    }
    await recordAutofixReceipts(engine, sourceId, receipts);
  } catch (error) {
    serr(`[sync] the automatic re-screen step of ${sourceId} did not finish (${error instanceof Error ? error.message : String(error)}); the holds stay as they are and the next sync tries again.`);
  }
  return result;
}
