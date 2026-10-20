/**
 * GBRA-133 PR 3 items 2 and 4: the per-kind admission table and the kill switches.
 *
 * Protects:
 *  - every admission cell: a kind runs by itself (default-on) only when it is receipted, kill-switched, previewable, free,
 *    needs no consent, is reversible, never deletes or moves content without an undo, carries a complete inverse when it
 *    rewrites a file, and is not operator-only; each property alone turns a default-on row preview-first;
 *  - the shipped table: the slug-line heal, fence and content repair (complete inverse), the verified twin merge (72 h
 *    restore, as on master), the re-screens and the index-lock reclaim are default-on; frontmatter repair and managed-sync
 *    orphans stay preview-first;
 *  - `admitAutofix`: the umbrella `sync.autofix.enabled` false refuses every automatic admission and names itself; a kind's
 *    own switch names itself; an operator apply is admitted whatever the switches say (the runner's `explicit: true` is not
 *    an operator apply); a classic source gets only kinds that rewrite nothing;
 *  - the maintenance phases (`fence_repair`, `content_repair`) skip with `autofix_disabled` under the umbrella and never call
 *    the kind; an applied managed repair leaves one receipt per item, with no content;
 *  - the preparation re-screen stops being automatic when its switch is off, while an operator's retry request still runs;
 *  - `gbrain config set` refuses a non-boolean value for every autofix key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { AUTOFIX_ADMISSION, AUTOFIX_KINDS, admissionGaps, admissionRow, admissionTier, admitAutofix, type AdmissionRow } from '../src/core/autofix/admission.ts';
import { AUTOFIX_CONFIG_KEYS, AUTOFIX_ENABLED_KEY, autofixValueRefusal } from '../src/core/autofix/switches.ts';
import { readAutofixReceipts } from '../src/core/autofix/receipts.ts';
import { readRescreenPolicy } from '../src/core/autofix/rescreen.ts';
import { readAutofixSwitches } from '../src/core/autofix/state.ts';
import { holdRescreenDue } from '../src/core/persistence/sync-holds.ts';
import { runFenceRepairPhase } from '../src/core/cycle/fence-repair.ts';
import { runContentRepairPhase } from '../src/core/cycle/content-repair.ts';
import type { RepairHandler, RepairItem } from '../src/core/repair/core.ts';
import type { RepairKindSpec } from '../src/core/repair/registry.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const configOf = (values: Record<string, string>) => ({ getConfig: async (key: string) => values[key] ?? null });
const ON: AdmissionRow = { kind: 'fence_repair', codes: ['invalid_fence'], when: 'maintenance', mutation: 'file_rewrite', sources: 'managed', undo: 'git_revert', receipted: true,
  switches: ['fences.repair.enabled'], preview: ['gbrain', 'repair', 'fences'], deletes_or_moves: false,
  inverse: { preimage_preserved: true, revision_checked: true, isolated_commit_tracked: true }, paid: false, consent_required: false };

describe('admission cells: each property alone keeps a kind preview-first', () => {
  test('the reference row is default-on', () => {
    expect(admissionGaps(ON)).toEqual([]);
    expect(admissionTier(ON)).toBe('default_on');
  });
  const cells: Array<[string, Partial<AdmissionRow>, string]> = [
    ['not receipted', { receipted: false }, 'not_receipted'],
    ['no kill switch', { switches: [] }, 'no_kill_switch'],
    ['not previewable', { preview: null }, 'not_previewable'],
    ['paid', { paid: true }, 'paid'],
    ['needs consent', { consent_required: true }, 'consent_required'],
    ['not reversible', { mutation: 'bookkeeping', undo: 'none', inverse: null }, 'not_reversible'],
    ['deletes without an undo', { mutation: 'lock_removal', undo: 'not_needed', deletes_or_moves: true, inverse: null }, 'deletes_without_undo'],
    ['a file rewrite without preserved recovery material', { inverse: { preimage_preserved: false, revision_checked: true, isolated_commit_tracked: true } }, 'no_complete_inverse'],
    ['a file rewrite without a revision check', { inverse: { preimage_preserved: true, revision_checked: false, isolated_commit_tracked: true } }, 'no_complete_inverse'],
    ['a file rewrite without a tracked isolated commit', { inverse: { preimage_preserved: true, revision_checked: true, isolated_commit_tracked: false } }, 'no_complete_inverse'],
    ['a file rewrite whose undo is not a Git revert', { undo: 'restore_72h' }, 'no_complete_inverse'],
    ['operator-only', { when: 'operator_only' }, 'operator_only'],
  ];
  for (const [name, change, gap] of cells) {
    test(name, () => {
      const row = { ...ON, ...change };
      expect(admissionGaps(row)).toEqual([gap]);
      expect(admissionTier(row)).toBe('preview_first');
    });
  }
  test('a soft delete with a 72 h restore is reversible and has an undo (the verified twin merge)', () => {
    expect(admissionGaps({ ...ON, mutation: 'page_soft_delete', undo: 'restore_72h', deletes_or_moves: true, inverse: null })).toEqual([]);
  });
});

describe('the shipped admission table', () => {
  test('every kind has exactly one row, and the tiers are derived, never declared', () => {
    expect(AUTOFIX_ADMISSION.map(row => row.kind).sort()).toEqual([...AUTOFIX_KINDS].sort());
    expect(Object.fromEntries(AUTOFIX_ADMISSION.map(row => [row.kind, admissionTier(row)]))).toEqual({
      slug_line_heal: 'default_on', origin_twin_merge: 'default_on', fence_repair: 'default_on', content_repair: 'default_on', preparation_rescreen: 'default_on',
      worktree_dirty_rescreen: 'default_on', index_lock_reclaim: 'default_on', frontmatter_repair: 'preview_first', managed_sync_orphans: 'preview_first' });
    expect(admissionGaps(admissionRow('frontmatter_repair'))).toEqual(['not_receipted', 'no_kill_switch', 'consent_required', 'no_complete_inverse', 'operator_only']);
    expect(admissionGaps(admissionRow('managed_sync_orphans'))).toEqual(['not_receipted', 'no_kill_switch', 'not_reversible', 'deletes_without_undo', 'operator_only']);
    for (const row of AUTOFIX_ADMISSION.filter(r => admissionTier(r) === 'default_on')) {
      expect(row.receipted && row.switches.length > 0 && row.preview !== null && !row.paid && !row.consent_required).toBe(true);
    }
  });
});

describe('admitAutofix: the one gate of every automatic admission', () => {
  test('the umbrella off refuses every automatic kind and names itself; an operator apply still runs', async () => {
    const off = configOf({ [AUTOFIX_ENABLED_KEY]: 'false' });
    for (const kind of AUTOFIX_KINDS) {
      const verdict = await admitAutofix(off, kind, { admission: 'automatic', sourceKind: 'managed' });
      expect(verdict.admitted).toBe(false);
      if (admissionTier(admissionRow(kind)) === 'default_on') expect(verdict).toMatchObject({ reason: 'disabled', disabling_key: AUTOFIX_ENABLED_KEY });
      else expect(verdict).toMatchObject({ reason: 'preview_first' });
      expect(await admitAutofix(off, kind, { admission: 'operator' })).toMatchObject({ admitted: true, admission: 'operator' });
    }
  });
  test("a kind's own switch off names that switch; the others still run", async () => {
    const off = configOf({ 'sync.autofix.preparation_rescreen': 'false' });
    expect(await admitAutofix(off, 'preparation_rescreen', { admission: 'automatic' })).toMatchObject({ admitted: false, reason: 'disabled', disabling_key: 'sync.autofix.preparation_rescreen' });
    expect(await admitAutofix(off, 'worktree_dirty_rescreen', { admission: 'automatic' })).toMatchObject({ admitted: true, disabling_key: 'sync.autofix.worktree_dirty_rescreen' });
    expect(await admitAutofix(configOf({ 'sync.origin_twins.auto_resolve': 'false' }), 'origin_twin_merge', { admission: 'automatic' }))
      .toMatchObject({ admitted: false, disabling_key: 'sync.origin_twins.auto_resolve' });
  });
  test('a classic source gets only the kinds that rewrite nothing', async () => {
    const on = configOf({});
    expect((await admitAutofix(on, 'preparation_rescreen', { admission: 'automatic', sourceKind: 'classic' })).admitted).toBe(true);
    for (const kind of ['slug_line_heal', 'fence_repair', 'content_repair', 'origin_twin_merge', 'worktree_dirty_rescreen', 'index_lock_reclaim'] as const) {
      expect(await admitAutofix(on, kind, { admission: 'automatic', sourceKind: 'classic' })).toMatchObject({ admitted: false, reason: 'classic_rewrite' });
    }
  });
  test('a stored value that is not a boolean reads as the default; the config command refuses it', async () => {
    expect((await admitAutofix(configOf({ [AUTOFIX_ENABLED_KEY]: 'maybe' }), 'fence_repair', { admission: 'automatic' })).admitted).toBe(true);
    for (const key of AUTOFIX_CONFIG_KEYS) {
      expect(autofixValueRefusal(key, 'maybe')).toContain(`${key} must be true or false`);
      expect(autofixValueRefusal(key, 'false')).toBeNull();
    }
  });
  test('the switch listing shows every kind with its effective state', async () => {
    await engine.setConfig(AUTOFIX_ENABLED_KEY, 'false');
    const items = await readAutofixSwitches(engine);
    expect(items.map(i => i.kind).sort()).toEqual([...AUTOFIX_KINDS].sort());
    expect(items.every(i => !i.effective)).toBe(true);
    expect(items.find(i => i.kind === 'fence_repair')).toMatchObject({ disabling_key: AUTOFIX_ENABLED_KEY, switches: [{ key: AUTOFIX_ENABLED_KEY, enabled: false, source: 'config' }, { key: 'fences.repair.enabled', enabled: true, source: 'default' }] });
  });
});

/** A stub lane kind whose applies report a managed rewrite, as the real fence and slug-conflict kinds do. */
function stubKind(kind: 'fences' | 'connector-fences', count: number) {
  const items: RepairItem[] = Array.from({ length: count }, (_, id) => ({ cursor: { phase: 0, id }, source_id: 'default', slug: `people/alice-example-${id}`, chars: 10, action: 'repair' }));
  const stub = { plans: 0, applied: 0, spec: undefined as unknown as RepairKindSpec };
  const handler: RepairHandler = {
    kind, publication: 'projection', embeds: false,
    async plan() { stub.plans++; return { items, residuals: {}, llm: { usd: 0, cap_remaining_usd: 1 }, scan: { fresh_at: null, partial: false } }; },
    async apply(_ctx, item) {
      stub.applied++;
      return { applied: true, outcome: 'repaired', detail: { mode: 'managed', slug: item.slug, path: `${item.slug}.md`, before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64),
        request_id: `request-${item.cursor.id}`, tier: 'deterministic' } };
    },
  };
  stub.spec = { kind, handler, summary: 'stub', embeds: 'none', checks: [], preview_bound: true } as RepairKindSpec;
  return stub;
}

describe('the maintenance repair phases', () => {
  test('fence_repair: the umbrella off skips with autofix_disabled and never calls the kind; on, each managed repair is receipted', async () => {
    const stub = stubKind('fences', 2);
    await engine.setConfig(AUTOFIX_ENABLED_KEY, 'false');
    const off = await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] });
    expect(off).toMatchObject({ status: 'skipped', details: { reason: 'autofix_disabled', disabling_key: AUTOFIX_ENABLED_KEY } });
    expect(off.summary).toContain(`gbrain config set ${AUTOFIX_ENABLED_KEY} true`);
    expect(stub.plans).toBe(0);
    expect(await readAutofixReceipts(engine, 'default')).toEqual([]);
    await engine.setConfig(AUTOFIX_ENABLED_KEY, 'true');
    expect((await runFenceRepairPhase(engine, { dryRun: false, registry: [stub.spec] })).status).toBe('ok');
    const receipts = await readAutofixReceipts(engine, 'default');
    expect(receipts.map(r => [r.kind, r.admission, r.outcome, r.code, r.path, r.disabling_key, r.preimage?.sha256, r.postimage_sha256, r.request_id, r.commit.state]).sort()).toEqual([
      ['fence_repair', 'automatic', 'applied', 'invalid_fence', 'people/alice-example-0.md', 'fences.repair.enabled', 'a'.repeat(64), 'b'.repeat(64), 'request-0', 'pending'],
      ['fence_repair', 'automatic', 'applied', 'invalid_fence', 'people/alice-example-1.md', 'fences.repair.enabled', 'a'.repeat(64), 'b'.repeat(64), 'request-1', 'pending']]);
  });
  test('content_repair: the umbrella off skips with autofix_disabled and never calls the kind; a dry run writes no receipt', async () => {
    const stub = stubKind('connector-fences', 1);
    await engine.setConfig(AUTOFIX_ENABLED_KEY, 'false');
    const off = await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [stub.spec] });
    expect(off).toMatchObject({ status: 'skipped', details: { reason: 'autofix_disabled', disabling_key: AUTOFIX_ENABLED_KEY, kinds: ['connector-fences'] } });
    expect(stub.plans).toBe(0);
    await engine.setConfig(AUTOFIX_ENABLED_KEY, 'true');
    await runContentRepairPhase(engine, { dryRun: true, kinds: ['connector-fences'], registry: [stub.spec] });
    expect(await readAutofixReceipts(engine, 'default')).toEqual([]);
    await runContentRepairPhase(engine, { dryRun: false, kinds: ['connector-fences'], registry: [stub.spec] });
    expect((await readAutofixReceipts(engine, 'default')).map(r => [r.kind, r.code])).toEqual([['content_repair', 'frontmatter_slug_conflict']]);
  });
});

describe('the preparation re-screen switch', () => {
  const stalled = { code: 'preparation_stalled' as const, meta: { attempts: 1, recovery_version: Number.MAX_SAFE_INTEGER, stall: { gbrain_version: 'x' } } } as never;
  test('on by default, off under its own switch or the umbrella; an operator retry request re-screens either way', async () => {
    expect(await readRescreenPolicy(engine)).toEqual({ preparation: true });
    expect(holdRescreenDue(stalled, false, await readRescreenPolicy(engine))).toBe(true);
    for (const key of ['sync.autofix.preparation_rescreen', AUTOFIX_ENABLED_KEY]) {
      await engine.setConfig(key, 'false');
      const policy = await readRescreenPolicy(engine);
      expect(policy).toEqual({ preparation: false });
      expect(holdRescreenDue(stalled, false, policy)).toBe(false);
      expect(holdRescreenDue(stalled, true, policy)).toBe(true);
      await engine.setConfig(key, 'true');
    }
  });
});
