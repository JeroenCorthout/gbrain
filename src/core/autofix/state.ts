/**
 * GBRA-133 PR 3: what gbrain's automatic repairs did, will do and may do for one source, in one read shared by
 * `gbrain sync status --json` and the MCP `sync_status` op (lane F): `{ recent, pending, switches }`.
 *
 * - `recent`: the source's receipts (receipts.ts), newest first, each with its undo rendered now.
 * - `pending`: per kind and hold code, the holds the next automatic run will take (`next: 'next_sync'` for inline
 *   kinds, `'maintenance'` for the cycle's), or that a switch holds back (`held_by_switch`). Computed from the holds
 *   and their stored repair state; nothing is written.
 * - `switches`: every kind's tier (admission.ts), the gaps that keep a preview-first kind from running by itself, and
 *   each switch in effect with where its value comes from.
 *
 * `remote: true` (an MCP caller over http or any agent-facing transport) gets counts and hashes, never a path, a slug or
 * a host checkout path; the undo keeps its command without `--path`. Read-only.
 */
import type { BrainEngine } from '../engine.ts';
import { readGitSourceHolds, outOfAttemptsHold, fenceAutoRepairFor, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { HOLD_ATTEMPTS_NEEDS_HUMAN } from '../persistence/sync-fault-class.ts';
import { contentHoldDisposition } from '../repair/content-lane.ts';
import { AUTOFIX_ADMISSION, admissionGaps, admissionTier, type AutofixKind, type AutofixTier } from './admission.ts';
import { readAutofixReceipts, renderAutofixUndo, type AutofixReceipt, type AutofixUndoRendering } from './receipts.ts';
import { AUTOFIX_ENABLED_KEY, readSwitch, type SwitchState } from './switches.ts';

export interface AutofixRecentItem extends Omit<AutofixReceipt, 'path' | 'restore'> {
  /** Null for remote callers. */
  path: string | null;
  restore: AutofixReceipt['restore'];
  undo: AutofixUndoRendering;
}

export interface AutofixPendingItem {
  kind: AutofixKind;
  code: string;
  count: number;
  next: 'next_sync' | 'maintenance';
  /** The switch that keeps these from running now, or null when they will run. */
  held_by_switch: string | null;
  /** Up to 20 of the held paths; omitted for remote callers. */
  paths?: string[];
}

export interface AutofixSwitchItem {
  kind: AutofixKind;
  tier: AutofixTier;
  /** Why a preview-first kind does not run by itself (admission.ts `admissionGaps`); empty when default-on. */
  gaps: string[];
  /** Whether an automatic run of this kind is admitted now (default-on and every switch on). */
  effective: boolean;
  /** The umbrella first, then the kind's own switches, each as it is in effect. */
  switches: SwitchState[];
  /** The switch that is off, or the kind's own first switch when none is. */
  disabling_key: string | null;
}

export interface AutofixState {
  source_id: string;
  recent: AutofixRecentItem[];
  pending: AutofixPendingItem[];
  switches: AutofixSwitchItem[];
}

const PENDING_PATHS = 20;

/** Which default-on kind takes a hold now, by code and stored state; null when none does. */
function pendingKind(hold: GitHoldRecord, auto: Awaited<ReturnType<typeof fenceAutoRepairFor>>): AutofixKind | null {
  if (hold.code === 'frontmatter_slug_conflict' || hold.code === 'invalid_fence') {
    if (contentHoldDisposition(hold, auto).action !== 'repair') return null;
    return hold.code === 'invalid_fence' ? 'fence_repair' : 'slug_line_heal';
  }
  if (hold.code === 'origin_conflict') return hold.meta.reason ? null : 'origin_twin_merge';
  if (outOfAttemptsHold(hold.code)) return (hold.meta.attempts ?? 1) < HOLD_ATTEMPTS_NEEDS_HUMAN ? 'preparation_rescreen' : null;
  if (hold.code === 'worktree_dirty') return 'worktree_dirty_rescreen';
  return null;
}

async function sourceRoot(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ root: string | null; local_path: string | null }>(`SELECT h.local_path AS root, s.local_path
      FROM sources s
      LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
      LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
      LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
     WHERE s.id = $1`, [sourceId]).catch(() => [] as Array<{ root: string | null; local_path: string | null }>);
  return row?.root ?? row?.local_path ?? null;
}

export async function readAutofixSwitches(engine: Pick<BrainEngine, 'getConfig'>): Promise<AutofixSwitchItem[]> {
  const umbrella = await readSwitch(engine, AUTOFIX_ENABLED_KEY);
  const items: AutofixSwitchItem[] = [];
  for (const row of AUTOFIX_ADMISSION) {
    const switches = [umbrella, ...await Promise.all(row.switches.map(key => readSwitch(engine, key)))];
    const tier = admissionTier(row);
    const off = row.switches.length ? switches.find(s => !s.enabled) : undefined;
    items.push({ kind: row.kind, tier, gaps: admissionGaps(row), effective: tier === 'default_on' && !off, switches, disabling_key: off?.key ?? row.switches[0] ?? null });
  }
  return items;
}

/** `withhold`: paths the caller may not see (lane F's withheld holds); their receipts and holds are left out before anything is counted. */
export async function readAutofixState(engine: BrainEngine, sourceId: string, opts: { remote: boolean; limit?: number; withhold?: ReadonlySet<string> }): Promise<AutofixState> {
  const remote = opts.remote !== false;
  const visible = (path: string | null) => path === null || !opts.withhold?.has(path);
  const [switches, allReceipts, sourceHolds, root] = await Promise.all([readAutofixSwitches(engine), readAutofixReceipts(engine, sourceId, opts.limit),
    readGitSourceHolds(engine, { sourceIds: [sourceId] }), remote ? Promise.resolve(null) : sourceRoot(engine, sourceId)]);
  const receipts = allReceipts.filter(receipt => visible(receipt.path));
  const recent = receipts.map(receipt => ({ ...receipt, path: remote ? null : receipt.path, restore: remote && receipt.restore ? { ...receipt.restore, slug: '' } : receipt.restore,
    undo: renderAutofixUndo(receipt, { sourceId, root, remote }) }));
  const [entry] = sourceHolds;
  const holds = (entry?.holds ?? []).filter(hold => (!entry || hold.incarnation === entry.incarnation) && visible(hold.path));
  const auto = await fenceAutoRepairFor(engine, holds);
  const byKey = new Map<string, AutofixPendingItem>();
  for (const hold of holds) {
    const kind = pendingKind(hold, auto);
    if (!kind) continue;
    const sw = switches.find(s => s.kind === kind)!;
    const key = `${kind}\u0000${hold.code}`;
    const item = byKey.get(key) ?? { kind, code: hold.code, count: 0, next: AUTOFIX_ADMISSION.find(r => r.kind === kind)!.when === 'maintenance' ? 'maintenance' as const : 'next_sync' as const,
      held_by_switch: sw.effective ? null : sw.disabling_key, ...(remote ? {} : { paths: [] as string[] }) };
    item.count++;
    if (item.paths && item.paths.length < PENDING_PATHS) item.paths.push(hold.path);
    byKey.set(key, item);
  }
  return { source_id: sourceId, recent, pending: [...byKey.values()], switches };
}
