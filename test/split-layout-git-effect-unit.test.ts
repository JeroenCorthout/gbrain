/**
 * Wave B PR 5 lane 5b: a split page's Git effect on a Git-durable source that is not strict commits the head and every
 * part file in one commit, or nothing (persistence/effect-git.ts publishSplitGitEffect).
 *
 * 1. Protects: no Git commit ever holds a split head without all of its parts. When the effect cannot commit the whole
 *    unit, it commits nothing of the page, leaves nothing staged, and parks with a typed code at once: a part a
 *    .gitignore rule excludes parks `git_target_ignored` naming the rule; a part changed after publication parks
 *    `split_page_incomplete`. The page row stays committed.
 * 2. Fails when: the head (or any other part) is committed while one part is refused, the refused unit leaves paths
 *    staged, or the effect retries and parks later under a generic code.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests; the
 *    checkout is changed at publication:before_commit, after the files are published and before the effect exists.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
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
const put = (ctx: OperationContext, slug: string) => operations.find(o => o.name === 'put_page')!.handler(ctx,
  { slug, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, any>>;

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

/** Puts a split page, running `tamper` once with its part file names at publication:before_commit. */
async function splitPut(engine: BrainEngine, ctx: OperationContext, root: string, tamper: (dir: string, parts: string[]) => void): Promise<void> {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  let done = false;
  installFaultHook(async point => {
    if (point !== 'publication:before_commit' || done) return;
    done = true;
    const dir = partsDirFor(join(root, 'notes/big.md'));
    tamper(dir, readdirSync(dir).sort());
  });
  expect(await put(ctx, 'notes/big')).toMatchObject({ state: 'committed' });
  expect(done).toBe(true);
}

const pageCommits = (root: string) => git(root, 'log', '--format=%H', '--', 'notes/big.md', 'notes/.big.gbparts').split('\n').filter(Boolean);

for (const backend of testBackends()) describe(`[${backend}] split git layout: the Git effect commits the whole unit or nothing`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { installFaultHook(undefined); __setSplitLimitsForTests(null); });

  test('a part a .gitignore rule excludes: neither the head nor any part is committed; the effect parks git_target_ignored', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitPut(engine, ctx, root, (_dir, parts) => {
      expect(parts.length).toBeGreaterThan(2);
      appendFileSync(join(root, '.gitignore'), `notes/.big.gbparts/${parts[1]}\n`);
    });
    const effects = await settledGitEffects(engine);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
    expect(effects[0]!.data.parked).toEqual([expect.objectContaining({ error_code: 'git_target_ignored' })]);
    expect(pageCommits(root)).toEqual([]);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(await engine.readPageSnapshot('notes/big', { sourceId: 'default' })).not.toBeNull();
  }, { databaseUrl, setup }), 120_000);

  test('a part changed before the effect runs: neither the head nor any part is committed; the effect parks split_page_incomplete', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitPut(engine, ctx, root, (dir, parts) => {
      const path = join(dir, parts[0]!);
      const bytes = readFileSync(path, 'utf8');
      writeFileSync(path, (bytes[0] === 'X' ? 'Y' : 'X') + bytes.slice(1));
    });
    const effects = await settledGitEffects(engine);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
    expect(effects[0]!.data.parked).toEqual([expect.objectContaining({ error_code: 'split_page_incomplete' })]);
    expect(pageCommits(root)).toEqual([]);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(await engine.readPageSnapshot('notes/big', { sourceId: 'default' })).not.toBeNull();
  }, { databaseUrl, setup }), 120_000);
});
