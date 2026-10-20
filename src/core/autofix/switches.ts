/**
 * GBRA-133 PR 3: the kill switches of gbrain's automatic repairs ("inline autofix").
 *
 * `sync.autofix.enabled` (default true) is the umbrella: false stops every automatic admission of a repair (the
 * post-sync heals, the maintenance cycle's repair phases, the automatic re-screens and the Git index-lock reclaim),
 * while an operator's explicit apply (`gbrain repair <kind> --apply`, `gbrain sync unblock --apply`) still runs.
 * Under it each kind keeps its own switch: the existing `sync.slug_conflicts.auto_remove`,
 * `sync.origin_twins.auto_resolve` and `fences.repair.enabled`, and three new ones for paths that had none:
 * `sync.autofix.preparation_rescreen`, `sync.autofix.worktree_dirty_rescreen` and `sync.autofix.index_lock_reclaim`.
 * Every switch is a boolean that defaults to true; a stored value that is not a boolean reads as the default (and
 * `gbrain config set` refuses one). Every receipt names the key that would have stopped it (admission.ts).
 */
import type { BrainEngine } from '../engine.ts';

export const AUTOFIX_ENABLED_KEY = 'sync.autofix.enabled';
export const AUTOFIX_PREPARATION_RESCREEN_KEY = 'sync.autofix.preparation_rescreen';
export const AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY = 'sync.autofix.worktree_dirty_rescreen';
export const AUTOFIX_INDEX_LOCK_RECLAIM_KEY = 'sync.autofix.index_lock_reclaim';

/** The keys this module owns; `gbrain config set` validates each as a boolean. */
export const AUTOFIX_CONFIG_KEYS = [AUTOFIX_ENABLED_KEY, AUTOFIX_PREPARATION_RESCREEN_KEY, AUTOFIX_WORKTREE_DIRTY_RESCREEN_KEY, AUTOFIX_INDEX_LOCK_RECLAIM_KEY] as const;

const TRUE = /^(true|1|on|yes)$/i;
const FALSE = /^(false|0|off|no)$/i;

/** `gbrain config set` refusal text for a value that is not a boolean; null when it is one. */
export function autofixValueRefusal(key: string, value: string): string | null {
  return TRUE.test(value.trim()) || FALSE.test(value.trim()) ? null : `${key} must be true or false (got "${value}"). Nothing was written.`;
}

/** `gbrain config set` hook: refuses a non-boolean value for one of the switches (a key outside them passes). */
export function refuseInvalidAutofixValue(key: string, value: string): void {
  const err = (AUTOFIX_CONFIG_KEYS as readonly string[]).includes(key) ? autofixValueRefusal(key, value) : null;
  if (err) { console.error(`[config] ${err}`); process.exit(1); }
}

export interface SwitchState {
  key: string;
  enabled: boolean;
  /** `config` when a boolean is stored for the key, `default` otherwise (on). */
  source: 'default' | 'config';
}

/** One switch as it is in effect: a stored false turns it off, anything else leaves the default (on). */
export async function readSwitch(engine: Pick<BrainEngine, 'getConfig'>, key: string): Promise<SwitchState> {
  const stored = String(await engine.getConfig(key).catch(() => null) ?? '').trim();
  if (FALSE.test(stored)) return { key, enabled: false, source: 'config' };
  return { key, enabled: true, source: TRUE.test(stored) ? 'config' : 'default' };
}

/** The first of these switches that is off (in order), or null when every one is on. */
export async function firstDisabled(engine: Pick<BrainEngine, 'getConfig'>, keys: readonly string[]): Promise<string | null> {
  for (const key of keys) if (!(await readSwitch(engine, key)).enabled) return key;
  return null;
}
