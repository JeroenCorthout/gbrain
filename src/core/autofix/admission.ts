/**
 * GBRA-133 PR 3: the per-kind admission table of gbrain's automatic repairs.
 *
 * Approved rule (GBRA-108, Garry): a repair may run by itself (default on) only when it is reversible, receipted,
 * kill-switched and previewable, never deletes or moves user content without an undo, spends nothing and needs no
 * consent. A kind that rewrites a file must also carry a demonstrated complete inverse: recovery material (the
 * preimage hash and a bytes reference) preserved before the mutation, the revision and hash checked before writing,
 * and an isolated repair commit tracked to completion; that commit is what `gbrain git commit-push --revert` undoes.
 * Every other kind stays preview-first: listed with its preview, run only by an operator's explicit apply.
 * Classic (unmanaged) sources take only kinds that rewrite nothing.
 *
 * `AUTOFIX_ADMISSION` states each kind's properties; `admissionTier` derives its tier from them (nothing is
 * declared default-on by hand), and `admitAutofix` is the one gate every automatic admission calls. An operator
 * apply (`admission: 'operator'`) is never gated by a switch; the repair runner's `explicit: true` only names the
 * kind it runs and is not an operator apply (content-lane.ts passes both separately).
 */
import type { BrainEngine } from '../engine.ts';
import { FENCE_REPAIR_ENABLED_KEY } from '../fence-repair/config.ts';
import { ORIGIN_TWINS_AUTO_RESOLVE_KEY } from '../persistence/origin-twins.ts';
import { AUTOFIX_ENABLED_KEY, AUTOFIX_INDEX_LOCK_RECLAIM_KEY, AUTOFIX_PREPARATION_RESCREEN_KEY, AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY, firstDisabled } from './switches.ts';

/** `sync.slug_conflicts.auto_remove` (repair/slug-autoheal.ts owns the constant; named here to keep this module import-light). */
export const SLUG_AUTO_REMOVE_SWITCH = 'sync.slug_conflicts.auto_remove';

export const AUTOFIX_KINDS = ['slug_line_heal', 'origin_twin_merge', 'fence_repair', 'content_repair', 'preparation_rescreen', 'worktree_dirty_rescreen',
  'index_lock_reclaim', 'frontmatter_repair', 'managed_sync_orphans'] as const;
export type AutofixKind = typeof AUTOFIX_KINDS[number];

export type AutofixMutation = 'none' | 'file_rewrite' | 'page_soft_delete' | 'lock_removal' | 'bookkeeping';
export type AutofixUndo = 'git_revert' | 'restore_72h' | 'not_needed' | 'none';

export interface AdmissionRow {
  kind: AutofixKind;
  /** The hold codes (or fault) the kind clears. */
  codes: readonly string[];
  /** When it runs by itself: right after a sync (`inline`), in the maintenance cycle, or inside the Git effect worker. */
  when: 'inline' | 'maintenance' | 'effect_worker' | 'operator_only';
  mutation: AutofixMutation;
  sources: 'managed' | 'managed_and_classic';
  undo: AutofixUndo;
  /** Writes a `sync-autofix` receipt for every automatic run (receipts.ts). */
  receipted: boolean;
  /** The kind's own switch; the umbrella `sync.autofix.enabled` is checked first for every kind. */
  switches: readonly string[];
  /** The read-only command that shows what the kind would do. */
  preview: readonly string[] | null;
  deletes_or_moves: boolean;
  /** A file rewrite's inverse: recovery material kept before writing, revision and hash checked, an isolated commit tracked to completion. */
  inverse: { preimage_preserved: boolean; revision_checked: boolean; isolated_commit_tracked: boolean } | null;
  /** May call a paid model, or needs the user's consent (`consent: destructive` repair kinds). */
  paid: boolean;
  consent_required: boolean;
}

const COMPLETE = { preimage_preserved: true, revision_checked: true, isolated_commit_tracked: true } as const;

export const AUTOFIX_ADMISSION: readonly AdmissionRow[] = [
  { kind: 'slug_line_heal', codes: ['frontmatter_slug_conflict'], when: 'inline', mutation: 'file_rewrite', sources: 'managed', undo: 'git_revert', receipted: true,
    switches: [SLUG_AUTO_REMOVE_SWITCH, FENCE_REPAIR_ENABLED_KEY], preview: ['gbrain', 'repair', 'content', '--no-llm'], deletes_or_moves: false, inverse: COMPLETE, paid: false, consent_required: false },
  { kind: 'origin_twin_merge', codes: ['origin_conflict'], when: 'inline', mutation: 'page_soft_delete', sources: 'managed', undo: 'restore_72h', receipted: true,
    switches: [ORIGIN_TWINS_AUTO_RESOLVE_KEY], preview: ['gbrain', 'repair', 'origin-twins'], deletes_or_moves: true, inverse: null, paid: false, consent_required: false },
  { kind: 'fence_repair', codes: ['invalid_fence'], when: 'maintenance', mutation: 'file_rewrite', sources: 'managed', undo: 'git_revert', receipted: true,
    switches: [FENCE_REPAIR_ENABLED_KEY], preview: ['gbrain', 'repair', 'fences'], deletes_or_moves: false, inverse: COMPLETE, paid: false, consent_required: false },
  { kind: 'content_repair', codes: ['frontmatter_slug_conflict'], when: 'maintenance', mutation: 'file_rewrite', sources: 'managed', undo: 'git_revert', receipted: true,
    switches: [FENCE_REPAIR_ENABLED_KEY], preview: ['gbrain', 'repair', 'content'], deletes_or_moves: false, inverse: COMPLETE, paid: false, consent_required: false },
  { kind: 'preparation_rescreen', codes: ['preparation_stalled', 'write_interrupted'], when: 'inline', mutation: 'none', sources: 'managed_and_classic', undo: 'not_needed', receipted: true,
    switches: [AUTOFIX_PREPARATION_RESCREEN_KEY], preview: ['gbrain', 'sync', 'status', '--json'], deletes_or_moves: false, inverse: null, paid: false, consent_required: false },
  { kind: 'worktree_dirty_rescreen', codes: ['worktree_dirty'], when: 'inline', mutation: 'none', sources: 'managed', undo: 'not_needed', receipted: true,
    switches: [AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY], preview: ['gbrain', 'sync', 'unblock'], deletes_or_moves: false, inverse: null, paid: false, consent_required: false },
  { kind: 'index_lock_reclaim', codes: ['git_index_stale', 'git_index_locked'], when: 'effect_worker', mutation: 'lock_removal', sources: 'managed', undo: 'not_needed', receipted: true,
    switches: [AUTOFIX_INDEX_LOCK_RECLAIM_KEY], preview: ['gbrain', 'sources', 'writer', 'status', '--json'], deletes_or_moves: false, inverse: null, paid: false, consent_required: false },
  { kind: 'frontmatter_repair', codes: ['invalid_frontmatter', 'rename_held'], when: 'operator_only', mutation: 'file_rewrite', sources: 'managed_and_classic', undo: 'git_revert', receipted: false,
    switches: [], preview: ['gbrain', 'repair', 'frontmatter'], deletes_or_moves: false, inverse: { preimage_preserved: true, revision_checked: true, isolated_commit_tracked: false }, paid: false, consent_required: true },
  { kind: 'managed_sync_orphans', codes: ['cursor_incarnation_retired'], when: 'operator_only', mutation: 'bookkeeping', sources: 'managed', undo: 'none', receipted: false,
    switches: [], preview: ['gbrain', 'repair', 'managed-sync-orphans'], deletes_or_moves: true, inverse: null, paid: false, consent_required: false },
];

export type AutofixTier = 'default_on' | 'preview_first';

/** The kind's row (every `AutofixKind` has one). */
export function admissionRow(kind: AutofixKind): AdmissionRow {
  return AUTOFIX_ADMISSION.find(row => row.kind === kind)!;
}

/** Why a row is not default-on, from its properties; an empty list is default-on. */
export function admissionGaps(row: AdmissionRow): string[] {
  const gaps: string[] = [];
  if (!row.receipted) gaps.push('not_receipted');
  if (!row.switches.length) gaps.push('no_kill_switch');
  if (!row.preview) gaps.push('not_previewable');
  if (row.paid) gaps.push('paid');
  if (row.consent_required) gaps.push('consent_required');
  if (row.mutation !== 'none' && row.mutation !== 'lock_removal' && row.undo === 'none') gaps.push('not_reversible');
  if (row.deletes_or_moves && row.undo !== 'git_revert' && row.undo !== 'restore_72h') gaps.push('deletes_without_undo');
  if (row.mutation === 'file_rewrite' && (row.undo !== 'git_revert' || !row.inverse?.preimage_preserved || !row.inverse.revision_checked || !row.inverse.isolated_commit_tracked)) {
    gaps.push('no_complete_inverse');
  }
  if (row.when === 'operator_only') gaps.push('operator_only');
  return gaps;
}

export function admissionTier(row: AdmissionRow): AutofixTier {
  return admissionGaps(row).length ? 'preview_first' : 'default_on';
}

export type AdmissionVerdict =
  | { admitted: true; kind: AutofixKind; tier: AutofixTier; admission: 'automatic' | 'operator'; disabling_key: string | null }
  | { admitted: false; kind: AutofixKind; reason: 'disabled' | 'preview_first' | 'classic_rewrite'; disabling_key: string | null; gaps?: string[] };

/**
 * The gate of every automatic admission. `operator` admits whatever the operator named (no switch applies); `automatic`
 * needs a default-on kind, a managed source for any kind that changes something, the umbrella on and the kind's switches
 * on. `disabling_key` names the switch that stops (or would stop) the kind: the one that is off, else its own first switch.
 */
export async function admitAutofix(engine: Pick<BrainEngine, 'getConfig'>, kind: AutofixKind, opts: { admission: 'automatic' | 'operator'; sourceKind?: 'managed' | 'classic' }): Promise<AdmissionVerdict> {
  const row = admissionRow(kind);
  const tier = admissionTier(row);
  const own = row.switches[0] ?? null;
  if (opts.admission === 'operator') return { admitted: true, kind, tier, admission: 'operator', disabling_key: own };
  if (tier !== 'default_on') return { admitted: false, kind, reason: 'preview_first', disabling_key: own, gaps: admissionGaps(row) };
  if (opts.sourceKind === 'classic' && (row.sources !== 'managed_and_classic' || row.mutation !== 'none')) return { admitted: false, kind, reason: 'classic_rewrite', disabling_key: own };
  const off = await firstDisabled(engine, [AUTOFIX_ENABLED_KEY, ...row.switches]);
  if (off) return { admitted: false, kind, reason: 'disabled', disabling_key: off };
  return { admitted: true, kind, tier, admission: 'automatic', disabling_key: own };
}

/** The opt-out a receipt prints: the umbrella and the kind's own switch. */
export function optOutArgv(kind: AutofixKind): string[] {
  return ['gbrain', 'config', 'set', admissionRow(kind).switches[0] ?? AUTOFIX_ENABLED_KEY, 'false'];
}
