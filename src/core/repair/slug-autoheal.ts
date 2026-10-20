/**
 * #6865: the sync-time heal of stray frontmatter `slug:` lines. A file whose `slug:` line names a slug other than
 * its path is held by sync (`frontmatter_slug_conflict`, the anti-spoof screen, unchanged). When the declared slug
 * names no page and no file (the content-repair lane's deterministic `absent_page` rule), nothing is ambiguous: the
 * path is the only identity. So right after a managed sync of a source finishes and releases its drain lease, this
 * removes that one line from each such held file through the lane's managed repair publication (hash-bound bytes,
 * import under the path slug, hold clear and a `gbrain: repair frontmatter slug in <path>` commit in one coordinated
 * write) and records the declared slug as an alias of the page, so links written against it keep resolving.
 *
 * Scope and guards:
 * - only `absent_page`; a line naming an existing page (file-backed or database-only), another type, or anything the
 *   model would judge is left exactly as held, with nothing recorded, for the maintenance run and a person;
 * - only the bytes sync held: a file edited since (a newer draft) waits for the next sync to re-screen it;
 * - never while the source has an unfinished managed sync (another drainer, or this run's own resumable stop: an
 *   unfinished cursor, or an open, stopped or episode-holding pass), and every write re-reads the busy set at
 *   admission, so no file whose publication is in flight is edited;
 * - only under local authority: a sync a remote job or agent submitted defers to the maintenance run;
 * - the declared slug is checked again inside the publication: a page, an alias or a file at its path written since
 *   the heal read the source refuses the write;
 * - bounded: only holds the lane has not judged for these bytes (a current-lane verdict is the lane's), at most
 *   `SLUG_HEAL_MAX_FILES` attempts and `SLUG_HEAL_BUDGET_MS` (or the caller's deadline) per sync, one checkout scan
 *   per source; the rest are counted as pending for the next sync or the maintenance run;
 * - `sync.slug_conflicts.auto_remove false` turns it off (held until the maintenance run or an operator repairs
 *   them), and so does `fences.repair.enabled false` (the whole lane) and the umbrella `sync.autofix.enabled false`
 *   (GBRA-133 PR 3, autofix/admission.ts); a skipped heal says which setting skipped it.
 * GBRA-133 PR 3 (inline autofix): only the held files this sync screened (`result.held`) are taken, with no model and
 * within `SLUG_HEAL_BUDGET_MS`; every other slug-conflict hold waits for the content_repair maintenance phase, so a
 * backlog never delays the next commit. A file is edited only while its held bytes are in the checkout's Git objects
 * (the recovery material its undo restores); each edit leaves a `sync-autofix` receipt (preimage hash and blob,
 * postimage hash, request id; the repair commit's sha once it lands) whose undo is `gbrain sync undo` (autofix/undo.ts).
 * Nothing here runs at upgrade. A failure is counted and never fails the sync whose checkpoint already committed.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { serr } from '../console-prefix.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { readGitSourceHolds } from '../persistence/sync-holds.ts';
import { contentRepairLaneCurrent } from '../persistence/sync-fault-class.ts';
import { FENCE_REPAIR_ENABLED_KEY } from '../fence-repair/config.ts';
import { admitAutofix } from '../autofix/admission.ts';
import { undoneSkipPaths } from '../autofix/undo.ts';
import { recordAutofixReceipts, type AutofixReceiptInput } from '../autofix/receipts.ts';
import { AUTOFIX_ENABLED_KEY } from '../autofix/switches.ts';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { absentSlugHealRun, healAbsentSlugLine } from './slug-conflicts.ts';
import { inspectLock, syncLockId } from '../db-lock.ts';
import { currentDrainLease } from '../persistence/sync-lease.ts';
import { readLivePassRows } from '../persistence/sync-pass-row.ts';

export const SLUG_AUTO_REMOVE_KEY = 'sync.slug_conflicts.auto_remove';
/** The longest one sync spends healing (a small absolute deadline: inline repair never delays the next commit); a caller deadline that comes sooner wins. */
export const SLUG_HEAL_BUDGET_MS = 10_000;
/** The most held files one sync examines (each heal is one coordinated write and one commit); the rest wait for the next pass. */
export const SLUG_HEAL_MAX_FILES = 200;

const FALSE = /^(false|0|off|no)$/i;
const TRUE = /^(true|1|on|yes)$/i;

/** `gbrain config set` refusal text for a value that is not a boolean; null when it is one. */
export function slugAutoRemoveValueRefusal(value: string): string | null {
  return TRUE.test(value.trim()) || FALSE.test(value.trim()) ? null : `${SLUG_AUTO_REMOVE_KEY} must be true or false (got "${value}"). Nothing was written.`;
}

export interface SlugHealReport {
  /** Files whose stray slug: line was removed and which are now indexed under their path slug. */
  removed: number;
  /** Held files this pass did not reach (budget, deadline, cancellation); the next sync or the maintenance run takes them. */
  pending: number;
  failed: number;
  /** Held files left as they are, by why (an existing named page, a newer draft, a busy path, ...). */
  left_by_reason: Record<string, number>;
  /** Up to 20 of the files healed. */
  removed_paths: string[];
  /** Set when the pass did not run, naming why. */
  skipped?: 'disabled' | 'lane_paused' | 'autofix_disabled' | 'remote_authority' | 'sync_unfinished' | 'not_writable';
  notice: string;
  /** The read-only preview of what the content-repair lane would do with the rest, and the opt-out. */
  preview_argv: string[];
  opt_out_argv: string[];
}

const OK_STATUSES: ReadonlyArray<SyncResult['status']> = ['synced', 'first_sync', 'up_to_date'];

/** One line the sync caller sees, and the same text on the result for `--json`. */
function noticeOf(sourceId: string, r: Omit<SlugHealReport, 'notice' | 'preview_argv' | 'opt_out_argv'>): string {
  const left = Object.values(r.left_by_reason).reduce((a, b) => a + b, 0);
  if (r.skipped) {
    const why = r.skipped === 'disabled' ? `${SLUG_AUTO_REMOVE_KEY} is false` : r.skipped === 'lane_paused' ? `content repair is paused (${FENCE_REPAIR_ENABLED_KEY} false)`
      : r.skipped === 'autofix_disabled' ? `automatic repairs are off (${AUTOFIX_ENABLED_KEY} false)`
      : r.skipped === 'remote_authority' ? 'this sync runs under a remote job or agent, which may import but not rewrite files'
      : r.skipped === 'sync_unfinished' ? 'the source still has an unfinished sync' : 'this host may not write the source checkout';
    return `[sync] ${r.pending} held file(s) of source ${sourceId} have a stray frontmatter slug: line; sync left them held because ${why}. `
      + `Preview the repair with gbrain repair content --source ${sourceId} --no-llm (read-only); the maintenance run applies it when the lane is on.`;
  }
  return `[sync] removed the stray frontmatter slug: line of ${r.removed} file(s) in source ${sourceId} that named no page; each is indexed under its path and committed by gbrain`
    + `${r.pending ? `; ${r.pending} more wait for the next sync` : ''}${r.failed ? `; ${r.failed} failed (gbrain repair content --source ${sourceId} shows why)` : ''}`
    + `${left ? `; ${left} held file(s) need more than that and stay for the content-repair lane` : ''}. Opt out: gbrain config set ${SLUG_AUTO_REMOVE_KEY} false.`;
}

/**
 * Whether the source's sync has not finished: a managed sync cursor that has not finished (a company brain's drain in
 * progress, or a resumable stop), or, for a source the live pass syncs (#6712 PR 4b, design v3.2 §9), another drainer
 * holding its drain lease, a newest pass that is still open or ended other than `synced`/`up_to_date`, or an open episode.
 */
async function unfinishedCursor(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'
    AND completed_keys->0->>'sourceId'=$1 LIMIT 1`, [sourceId]);
  if (rows.length > 0) return true;
  const lease = await inspectLock(engine, syncLockId(sourceId));
  if (lease && !lease.ttl_expired && lease.acquisition_token !== currentDrainLease(sourceId)?.token) return true;
  const pass = (await readLivePassRows(engine, [sourceId])).get(sourceId)?.value;
  return !!pass && (!['synced', 'up_to_date'].includes(pass.telemetry.outcome) || !!pass.obligations.episode);
}

/** The post-sync heal of one managed source; returns the result with the report and the held fields it cleared. Never throws. */
export async function healAfterManagedSync(engine: BrainEngine, outer: SyncOpts, result: SyncResult, now: () => number = Date.now): Promise<SyncResult> {
  if (outer.dryRun || !OK_STATUSES.includes(result.status)) return result;
  const sourceId = outer.sourceId ?? 'default';
  try {
    // GBRA-133 PR 3: only the holds this sync screened; a result that lists none (a direct caller) leaves the source's holds.
    const touched = result.held ? new Set(result.held.map(item => item.path)) : null;
    const all = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.code === 'frontmatter_slug_conflict' && (!touched || touched.has(hold.path)));
    if (!all.length) return result;
    const undone = new Set(await undoneSkipPaths(engine, sourceId));
    const holds = all.filter(hold => !contentRepairLaneCurrent(hold.meta.content_repair) && !undone.has(hold.path));
    const judged = all.filter(hold => contentRepairLaneCurrent(hold.meta.content_repair)).length;
    const reverted = all.length - holds.length - judged;
    const base = { removed: 0, pending: holds.length, failed: 0, left_by_reason: { ...(judged ? { lane_verdict: judged } : {}), ...(reverted ? { undone: reverted } : {}) } as Record<string, number>, removed_paths: [] as string[] };
    const authority = currentSubmissionAuthority();
    const admission = await admitAutofix(engine, 'slug_line_heal', { admission: 'automatic', sourceKind: 'managed' });
    const skipped: SlugHealReport['skipped'] = !admission.admitted
      ? admission.disabling_key === SLUG_AUTO_REMOVE_KEY ? 'disabled' : admission.disabling_key === FENCE_REPAIR_ENABLED_KEY ? 'lane_paused' : 'autofix_disabled'
      : authority && authority.kind !== 'application' ? 'remote_authority'
      : await unfinishedCursor(engine, sourceId) ? 'sync_unfinished' : undefined;
    const run = skipped ? null : await absentSlugHealRun(engine, sourceId, { embed: !outer.noEmbed && !outer.embedDeferred && !result.inherited_options?.includes('noEmbed') });
    if (skipped || !run) return withReport(result, sourceId, { ...base, skipped: skipped ?? 'not_writable' }, []);
    const { loadConfig } = await import('../config.ts');
    const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, logger: { info: () => {}, warn: (m: string) => serr(m), error: (m: string) => serr(m) },
      remote: false, dryRun: false, sourceId } as unknown as OperationContext;
    const deadline = Math.min(now() + SLUG_HEAL_BUDGET_MS, outer.deadlineAtMs ?? Infinity);
    const healed: string[] = [];
    const receipts: AutofixReceiptInput[] = [];
    let attempts = 0;
    for (const hold of [...holds].sort((a, b) => a.path.localeCompare(b.path))) {
      if (attempts++ >= SLUG_HEAL_MAX_FILES || now() >= deadline || outer.signal?.aborted) break;
      base.pending--;
      // The recovery material: the held bytes must be in the checkout's Git objects before the file is edited.
      if (!hold.upstream_version || !hold.meta.blob_oid || !run.src.root || !blobPresent(run.src.root, hold.meta.blob_oid)) {
        base.left_by_reason.no_recovery_material = (base.left_by_reason.no_recovery_material ?? 0) + 1;
        continue;
      }
      try {
        const outcome = await healAbsentSlugLine(ctx, run, hold.path);
        if (outcome.applied) {
          healed.push(hold.path); base.removed++;
          const detail = outcome.detail as { request_id?: unknown; after_sha256?: unknown } | undefined;
          receipts.push({ kind: 'slug_line_heal', admission: 'automatic', outcome: 'applied', code: hold.code, path: hold.path, disabling_key: SLUG_AUTO_REMOVE_KEY,
            preimage: { sha256: hold.upstream_version, blob_oid: hold.meta.blob_oid }, postimage_sha256: typeof detail?.after_sha256 === 'string' ? detail.after_sha256 : null,
            request_id: typeof detail?.request_id === 'string' ? detail.request_id : null, commit: { state: 'pending', sha: null } });
          continue;
        }
        const reason = outcome.reason ?? outcome.outcome;
        base.left_by_reason[reason] = (base.left_by_reason[reason] ?? 0) + 1;
      } catch (error) {
        base.failed++;
        receipts.push({ kind: 'slug_line_heal', admission: 'automatic', outcome: 'failed', reason: 'write_failed', code: hold.code, path: hold.path, disabling_key: SLUG_AUTO_REMOVE_KEY,
          preimage: { sha256: hold.upstream_version, blob_oid: hold.meta.blob_oid } });
        serr(`[sync] could not remove the slug: line of ${hold.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await recordAutofixReceipts(engine, sourceId, receipts).catch(error => serr(`[sync] could not record the autofix receipts of source ${sourceId}: ${error instanceof Error ? error.message : String(error)}`));
    return withReport(result, sourceId, { ...base, removed_paths: healed.slice(0, 20) }, healed);
  } catch (error) {
    serr(`[sync] the stray slug: line heal of source ${sourceId} did not run (${error instanceof Error ? error.message : String(error)}); the maintenance run repairs those files.`);
    return result;
  }
}

/** True when the blob is in the checkout's object store (`git cat-file -e`). */
function blobPresent(root: string, oid: string): boolean {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return false;
  try { execFileSync('git', ['-C', root, 'cat-file', '-e', oid], { env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }), stdio: 'ignore' }); return true; } catch { return false; }
}

/** The result with the heal report, and the held files it cleared taken out of this run's hold fields. */
function withReport(result: SyncResult, sourceId: string, report: Omit<SlugHealReport, 'notice' | 'preview_argv' | 'opt_out_argv'>, healed: string[]): SyncResult {
  const notice = noticeOf(sourceId, report);
  if (report.removed || report.failed || report.skipped === 'lane_paused' || report.skipped === 'remote_authority') serr(notice);
  const full: SlugHealReport = { ...report, notice, preview_argv: ['gbrain', 'repair', 'content', '--source', sourceId, '--no-llm'], opt_out_argv: ['gbrain', 'config', 'set', SLUG_AUTO_REMOVE_KEY, 'false'] };
  const gone = new Set(healed);
  const held = result.held?.filter(item => !gone.has(item.path));
  const runHealed = (result.held?.length ?? 0) - (held?.length ?? 0);
  const heldCount = result.held_count !== undefined ? Math.max(0, result.held_count - runHealed) : undefined;
  const outstanding = result.holds_outstanding !== undefined ? Math.max(0, result.holds_outstanding - healed.length) : undefined;
  const cleared = !heldCount && !outstanding;
  return { ...result, slug_lines_removed: full,
    ...(held ? { held } : {}), ...(heldCount !== undefined ? { held_count: heldCount } : {}), ...(outstanding !== undefined ? { holds_outstanding: outstanding } : {}),
    ...(cleared && result.holds_fix ? { holds_fix: undefined, holds_escalated: undefined } : {}) };
}
