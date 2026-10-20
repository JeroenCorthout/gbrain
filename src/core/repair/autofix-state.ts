/**
 * GBRA-133 PR 3: what `gbrain sync status --json` and the MCP `sync_status` op report about inline autofix for one
 * source: `recent` (the source's autofix receipts, newest first), `pending` (what the next automatic pass would
 * repair; nothing is written to compute it) and `switches` (each automatic repair path's switch and its effective
 * value). This module is the one seam between the status surfaces and the autofix lane (admission table, receipts,
 * kill switch): the lane fills `recent` and `pending` here and adds its switches; until it lands they read empty.
 * Codes, kinds, tiers, paths and hashes only, never content.
 */
import type { BrainEngine } from '../engine.ts';
import { FENCE_REPAIR_ENABLED_KEY, FENCES_NORMALIZE_KEY } from '../fence-repair/config.ts';
import { SLUG_AUTO_REMOVE_KEY } from './slug-autoheal.ts';
import { ORIGIN_TWINS_AUTO_RESOLVE_KEY } from '../persistence/origin-twins.ts';

/** One automatic repair the lane recorded: what it touched, how, and the key that turns it off. */
export interface AutofixReceiptEntry {
  at: string; code: string; path: string; kind: string; tier: string; outcome: string;
  request_id: string | null; commit_sha: string | null; disabling_key: string;
}

/** One held file the next automatic pass would repair, and when. */
export interface AutofixPendingEntry { code: string; path: string; kind: string; tier: string; when: 'inline' | 'next_tick' }

/** An automatic repair path's switch: `enabled` is its effective value, `source` where it came from. */
export interface AutofixSwitch { kind: string; key: string; enabled: boolean; source: 'default' | 'config' }

export interface AutofixState { recent: AutofixReceiptEntry[]; pending: AutofixPendingEntry[]; switches: AutofixSwitch[] }

/** Any of false, 0, off or no turns a switch off, as each path's own reader does; a read error keeps the default (on). */
const OFF = /^(false|0|off|no)$/i;

function switchOf(kind: string, key: string, value: string | null | undefined): AutofixSwitch {
  const set = value !== null && value !== undefined;
  return { kind, key, enabled: !set || !OFF.test(String(value).trim()), source: set ? 'config' : 'default' };
}

/** The automatic repair paths with a switch today, all default on. */
export async function readAutofixState(engine: Pick<BrainEngine, 'getConfig'>, _sourceId: string): Promise<AutofixState> {
  const read = (value: Promise<string | null>) => value.catch(() => null);
  const [fences, normalize, slugs, twins] = await Promise.all([read(engine.getConfig(FENCE_REPAIR_ENABLED_KEY)), read(engine.getConfig(FENCES_NORMALIZE_KEY)),
    read(engine.getConfig(SLUG_AUTO_REMOVE_KEY)), read(engine.getConfig(ORIGIN_TWINS_AUTO_RESOLVE_KEY))]);
  return { recent: [], pending: [], switches: [switchOf('fences', FENCE_REPAIR_ENABLED_KEY, fences), switchOf('fences-normalize', FENCES_NORMALIZE_KEY, normalize),
    switchOf('slug-conflicts', SLUG_AUTO_REMOVE_KEY, slugs), switchOf('origin-twins', ORIGIN_TWINS_AUTO_RESOLVE_KEY, twins)] };
}
