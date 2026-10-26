/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): a split page compared at a Git revision.
 *
 * 1. Protects: the git-gap census (`gbrain sources git-gap`, doctor `db_ahead_of_git`) compares a split page's committed
 *    head as the page file its committed parts reassemble to (split-layout/git-page-file.ts), so a committed split page
 *    that matches the database is `equal`, never `database_ahead`; a committed head whose parts do not reassemble is
 *    `unparseable`, never a database gap. The overwritten-edits hold reads the same committed page file
 *    (repair/overwritten-edits.ts `committedPageFile`): F' for a split head, a typed hold for one whose committed parts
 *    or body do not match its manifest.
 * 2. Fails when: the committed head blob is compared as the page (every split page counts `database_ahead`), or a
 *    head with a missing part reads as a short page.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests.
 */
import type { BrainEngine } from '../src/core/engine.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { censusGitGap } from '../src/commands/sources-git-gap.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { committedPageFile } from '../src/core/repair/overwritten-edits.ts';
import { __setSplitLimitsForTests, partsDirFor, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/big-example';
const REL = SLUG + '.md';
const op = (name: string) => operations.find(o => o.name === name)!;
const page = (lines: number) => `---\ntype: note\ntitle: Split example\n---\n\n${Array.from({ length: lines }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`).join('\n')}\n`;
/** Option B: only a git-canonical source lays a page out as a split unit, so every fixture source is strict (canonical = git). */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };

async function splitPage(ctx: OperationContext, engine: OperationContext['engine'], root: string) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  expect(await op('put_page').handler(ctx, { slug: SLUG, content: page(80), request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
  expect(readdirSync(partsDirFor(join(root, REL))).length).toBeGreaterThan(2);
  expect(git(root, 'status', '--porcelain')).toBe('');
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: a split page at a Git revision`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });

  test('the git-gap census compares a committed split page as its page file: equal, not database_ahead', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitPage(ctx, engine, root);
    const census = await censusGitGap(engine, 'default', { sample: 10 });
    expect(census.states).toMatchObject({ equal: 1, database_ahead: 0, git_ahead: 0, unparseable: 0 });
  }, { databaseUrl, setup }), 120_000);

  test('a committed split head with a missing part is unparseable, never a database gap', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitPage(ctx, engine, root);
    const dir = partsDirFor(join(root, REL));
    git(root, 'rm', '-q', join(dir, readdirSync(dir).sort()[0]!));
    commitAll(root, 'drop a part');
    const census = await censusGitGap(engine, 'default', { sample: 10 });
    expect(census.states).toMatchObject({ equal: 0, database_ahead: 0, git_ahead: 0, unparseable: 1 });
  }, { databaseUrl, setup }), 120_000);

  test('the overwritten-edits reader takes the committed page file of a split head, or its typed hold', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitPage(ctx, engine, root);
    const whole = readPageFile(join(root, REL));
    expect(whole.hold).toBeUndefined();
    const head = readFileSync(join(root, REL));
    const read = committedPageFile(root, REL, head);
    expect(read).toMatchObject({ split: true });
    expect(!read.hold && read.bytes.equals(whole.hold ? Buffer.alloc(0) : whole.bytes)).toBe(true);
    expect(committedPageFile(root, REL, Buffer.from(head.toString('utf8').replace('Line 0000', 'Line 9999'))).hold?.code).toBe('split_head_modified');
    const dir = partsDirFor(join(root, REL));
    git(root, 'rm', '-q', join(dir, readdirSync(dir).sort()[0]!));
    commitAll(root, 'drop a part');
    expect(committedPageFile(root, REL, head).hold?.code).toBe('split_page_incomplete');
  }, { databaseUrl, setup }), 120_000);
});
