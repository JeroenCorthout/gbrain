/**
 * Wave B PR 5 lane 5b: a split page (head file plus part files in `.<name>.gbparts/`) through its lifecycle on the
 * write path (persistence/split-files.ts with the coordinator, G7a and the door).
 *
 * 1. Protects: on a strict source (canonical = git) turning a split page private removes the head and every part in one
 *    door commit and records the head's path in `withheld_source_path`, and turning it back to world writes them again
 *    in one door commit; a soft delete then a restore gives back every part byte for byte and the head with the same
 *    manifest, lead and frontmatter (a restore renders frontmatter keys in their stored order, as it does for every page,
 *    so only the order of the head's frontmatter lines may change); an owner purge
 *    removes the head, every part and the parts directory; on a strict source shrinking under the threshold and
 *    growing over it each land in exactly one door commit that holds the head and every part it writes or removes.
 * 2. Fails when: a part (or the parts directory) is left behind, committed apart from its head, or written back with
 *    other bytes; or a transition takes more than one commit.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { __setSplitLimitsForTests, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const op = (name: string) => operations.find(o => o.name === name)!;
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `Line ${String(from + i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const page = (body: string[], extra = '') => `---\ntype: note\ntitle: Split example\n${extra}---\n\n${body.join('\n')}\n`;
/** Option B: only a git-canonical source lays a page out as a split unit, so every fixture source is strict (canonical = git). */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  op(name).handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>;
const revision = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** The head and every part of notes/big on disk, by path relative to the root, with their SHA-256. */
const unitFiles = (root: string): Record<string, string> => {
  const head = join(root, 'notes/big.md');
  const dir = partsDirFor(head);
  if (!existsSync(head)) return {};
  return { 'notes/big.md': sha(head), ...Object.fromEntries((existsSync(dir) ? readdirSync(dir).sort() : []).map(name => [`notes/.big.gbparts/${name}`, sha(join(dir, name))])) };
};
const atHead = (root: string) => git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'notes').split('\n').filter(Boolean).sort();
const commitCount = (root: string) => Number(git(root, 'rev-list', '--count', 'HEAD').trim());
const changedIn = (root: string, commit: string) => git(root, 'show', '--name-only', '--format=', commit).split('\n').filter(Boolean).sort();
const filed = async (engine: BrainEngine) => (await engine.executeRaw<{ reason: string | null; source_path: string | null; withheld: string | null }>(
  "SELECT database_only_reason AS reason, source_path, withheld_source_path AS withheld FROM pages WHERE source_id='default' AND slug='notes/big'"))[0];

for (const backend of testBackends()) describe(`[${backend}] split git layout: the lifecycle of a split page`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));
  const splitLimits = async (engine: BrainEngine) => { __setSplitLimitsForTests(LIMITS); await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048'); };

  test('strict: private removes the head and every part in one door commit and withholds the head path; world writes them again in one door commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitLimits(engine);
    await strict(engine);
    const body = lines(0, 80);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(body) })).toMatchObject({ state: 'committed' });
    const world = unitFiles(root);
    expect(Object.keys(world).length).toBeGreaterThan(4);
    expect(atHead(root)).toEqual(Object.keys(world).sort());
    const beforePrivate = commitCount(root);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(body, 'visibility: private\n'), expected_revision: await revision(engine, 'notes/big') }))
      .toMatchObject({ state: 'committed' });
    expect(commitCount(root)).toBe(beforePrivate + 1);
    expect(changedIn(root, 'HEAD')).toEqual(Object.keys(world).sort());
    expect(atHead(root)).toEqual([]);
    expect(unitFiles(root)).toEqual({});
    expect(existsSync(partsDirFor(join(root, 'notes/big.md')))).toBe(false);
    expect(await filed(engine)).toEqual({ reason: 'private', source_path: null, withheld: 'notes/big.md' });
    const beforeWorld = commitCount(root);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(body), expected_revision: await revision(engine, 'notes/big') })).toMatchObject({ state: 'committed' });
    expect(commitCount(root)).toBe(beforeWorld + 1);
    const again = unitFiles(root);
    expect(Object.keys(again).sort()).toEqual(Object.keys(world).sort());
    expect(changedIn(root, 'HEAD')).toEqual(Object.keys(again).sort());
    expect(atHead(root)).toEqual(Object.keys(again).sort());
    expect(await filed(engine)).toEqual({ reason: null, source_path: 'notes/big.md', withheld: null });
    await settleManagedGitEffects(engine);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('a soft delete then a restore gives back the head and every part byte for byte', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitLimits(engine);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(lines(0, 80)) })).toMatchObject({ state: 'committed' });
    const before = unitFiles(root);
    const beforeHead = readFileSync(join(root, 'notes/big.md'), 'utf8');
    expect(Object.keys(before).length).toBeGreaterThan(4);
    await settleManagedGitEffects(engine);
    expect(await call(ctx, 'delete_page', { slug: 'notes/big', expected_revision: await revision(engine, 'notes/big') })).toMatchObject({ state: 'committed' });
    expect(unitFiles(root)).toEqual({});
    expect(existsSync(partsDirFor(join(root, 'notes/big.md')))).toBe(false);
    expect(await call(ctx, 'restore_page', { slug: 'notes/big', expected_revision: await revision(engine, 'notes/big') })).toMatchObject({ state: 'committed' });
    const { 'notes/big.md': _head, ...parts } = before;
    const { 'notes/big.md': _restoredHead, ...restoredParts } = unitFiles(root);
    expect(restoredParts).toEqual(parts);
    const restoredHead = readFileSync(join(root, 'notes/big.md'), 'utf8');
    const frontmatterLines = (head: string) => head.slice(4, head.indexOf('\ngbrain_parts:')).split('\n').sort();
    expect(frontmatterLines(restoredHead)).toEqual(frontmatterLines(beforeHead));
    expect(restoredHead.slice(restoredHead.indexOf('\ngbrain_parts:'))).toBe(beforeHead.slice(beforeHead.indexOf('\ngbrain_parts:')));
    await settleManagedGitEffects(engine);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('an owner purge removes the head, every part and the parts directory', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitLimits(engine);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(lines(0, 80)) })).toMatchObject({ state: 'committed' });
    expect(Object.keys(unitFiles(root)).length).toBeGreaterThan(4);
    await settleManagedGitEffects(engine);
    const purged = await call(ctx, 'delete_page', { slug: 'notes/big', expected_revision: await revision(engine, 'notes/big'), purge: true });
    expect(purged).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/big.md'))).toBe(false);
    expect(existsSync(partsDirFor(join(root, 'notes/big.md')))).toBe(false);
    expect(await engine.readPageSnapshot('notes/big', { sourceId: 'default', includeDeleted: true })).toBeNull();
    await settleManagedGitEffects(engine);
    expect(atHead(root)).toEqual([]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('strict: shrinking under the threshold and growing over it each land in one door commit with the head and every part it writes or removes', () => managedBrain(async ({ engine, ctx, root }) => {
    await splitLimits(engine);
    await strict(engine);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(lines(0, 80)) })).toMatchObject({ state: 'committed' });
    const split = unitFiles(root);
    const beforeShrink = commitCount(root);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(lines(0, 5)), expected_revision: await revision(engine, 'notes/big') })).toMatchObject({ state: 'committed' });
    expect(commitCount(root)).toBe(beforeShrink + 1);
    expect(changedIn(root, 'HEAD')).toEqual(Object.keys(split).sort());
    expect(atHead(root)).toEqual(['notes/big.md']);
    expect(existsSync(partsDirFor(join(root, 'notes/big.md')))).toBe(false);
    const beforeGrow = commitCount(root);
    expect(await call(ctx, 'put_page', { slug: 'notes/big', content: page(lines(0, 90)), expected_revision: await revision(engine, 'notes/big') })).toMatchObject({ state: 'committed' });
    expect(commitCount(root)).toBe(beforeGrow + 1);
    const grown = unitFiles(root);
    expect(Object.keys(grown).length).toBeGreaterThan(4);
    expect(changedIn(root, 'HEAD')).toEqual(Object.keys(grown).sort());
    expect(atHead(root)).toEqual(Object.keys(grown).sort());
    await settleManagedGitEffects(engine);
    expect(commitCount(root)).toBe(beforeGrow + 1);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);
});
