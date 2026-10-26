/**
 * Wave B PR 5 (option B): only the strict publication door commits a split page. A Git effect never commits or removes
 * a path of a split unit (persistence/effect-git.ts commitGitTargets runs split-unit-guard.ts splitUnitRefusals on every
 * target), and the Git effect of a strict door publication only pushes.
 *
 * 1. Protects: a non-strict source's queued Git effect whose page path became a split unit (a parts directory beside it,
 *    put there outside gbrain) parks on its first attempt as split_page_unsupported (non_strict_source), keeping the
 *    reason and its fix on the parked target, and commits and stages nothing; on a strict source the same check refuses
 *    outside_door; a strict source's split publication lands in its door commit and its Git effect is push-only,
 *    committing nothing else.
 * 2. Fails when: a Git effect commits a head without its parts or a part without its head, a strict effect stages a
 *    unit path itself, or the refusal is retried PARK_AFTER_FAILURES times instead of parking at once.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { __setSplitLimitsForTests, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { testWaitMs } from './helpers/wait-for.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const lines = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const content = `---\ntype: note\ntitle: Split example\n---\n\n${lines.join('\n')}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const put = (ctx: OperationContext, slug: string, body = content) => operations.find(o => o.name === 'put_page')!.handler(ctx,
  { slug, content: body, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, any>>;

/** Runs effects until the source's Git effects are all committed or failed; returns them. */
async function settledGitEffects(engine: BrainEngine): Promise<Array<{ state: string; error_code: string | null; data: Record<string, any> }>> {
  const deadline = performance.now() + testWaitMs(30_000);
  for (;;) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const rows = await engine.executeRaw<{ state: string; error_code: string | null; data: Record<string, any> }>(
      "SELECT state, error_code, data FROM persistence_effects WHERE source_id='default' AND kind='git' ORDER BY id");
    if (rows.every(row => row.state === 'committed' || row.state === 'failed')) return rows.map(row => ({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data }));
    if (performance.now() > deadline) throw new Error('Git effects still open after the wait');
    await Bun.sleep(50);
  }
}

const pageCommits = (root: string) => git(root, 'log', '--format=%H', '--', 'notes/big.md', 'notes/.big.gbparts').split('\n').filter(Boolean);

for (const backend of testBackends()) describe(`[${backend}] split git layout: only the strict door commits a split unit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  test('a non-strict Git effect whose page path became a split unit parks at once as split_page_unsupported with its reason and fix, and commits nothing', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await put(ctx, 'notes/big', '---\ntype: note\ntitle: Small\n---\n\nOne line.\n')).toMatchObject({ state: 'committed' });
    mkdirSync(partsDirFor(join(root, 'notes/big.md')));
    writeFileSync(join(partsDirFor(join(root, 'notes/big.md')), '0001-00000000.gbpart'), 'A part placed outside gbrain.\n');
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const [effect, ...rest] = await engine.executeRaw<{ state: string; error_code: string | null; attempts: number; data: unknown }>(
      "SELECT state, error_code, attempts, data FROM persistence_effects WHERE source_id='default' AND kind='git'");
    expect(rest).toEqual([]);
    const data = typeof effect!.data === 'string' ? JSON.parse(effect!.data) : effect!.data as Record<string, any>;
    console.log('R7_PARK', JSON.stringify({ backend, state: effect!.state, error_code: effect!.error_code, attempts: effect!.attempts, parked: data.parked }));
    expect({ state: effect!.state, error_code: effect!.error_code, attempts: effect!.attempts }).toEqual({ state: 'failed', error_code: 'targets_parked', attempts: 1 });
    expect(data.target_failures).toBeUndefined();
    expect(data.parked).toEqual([{ slug: 'notes/big', error_code: 'split_page_unsupported', reason: 'non_strict_source',
      fix: expect.objectContaining({ ask_user: true, verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } }) }]);
    expect(pageCommits(root)).toEqual([]);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('on a strict source the Git effect check refuses a unit path outside_door and stages nothing', () => managedBrain(async ({ root }) => {
    __setSplitLimitsForTests(LIMITS);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes/big.md'), 'A head placed outside gbrain.\n');
    mkdirSync(partsDirFor(join(root, 'notes/big.md')));
    writeFileSync(join(partsDirFor(join(root, 'notes/big.md')), '0001-00000000.gbpart'), 'A part placed outside gbrain.\n');
    const outcomes = await commitGitTargets(root, ['notes/big.md', 'notes/.big.gbparts/0001-00000000.gbpart'], undefined, undefined, undefined, true);
    expect([...outcomes.values()].map(outcome => (outcome as { code?: string; reason?: string }))).toEqual([
      expect.objectContaining({ code: 'split_page_unsupported', reason: 'outside_door' }), expect.objectContaining({ code: 'split_page_unsupported', reason: 'outside_door' })]);
    expect(pageCommits(root)).toEqual([]);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('a strict split publication lands in its door commit; its Git effect only pushes', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await strict(engine);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/big')).toMatchObject({ state: 'committed' });
    const commits = pageCommits(root);
    expect(commits).toHaveLength(1);
    const parts = readdirSync(partsDirFor(join(root, 'notes/big.md'))).sort();
    expect(parts.length).toBeGreaterThan(2);
    const effects = await settledGitEffects(engine);
    expect(effects).toEqual([expect.objectContaining({ state: 'committed', data: expect.objectContaining({ push_only: true }) })]);
    expect(pageCommits(root)).toEqual(commits);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);
});
