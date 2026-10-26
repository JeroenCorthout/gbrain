/**
 * Wave B PR 5 lane 5b: every commit of a split page holds the whole unit. effect-git.ts `splitUnitPaths` is the one path
 * set: the head, every part its manifest lists and every other path Git has under its parts directory, which the commit
 * removes. The strict door commit, the split Git effect and landed-commit recovery (split-files.ts `splitLandedCommit`)
 * all use it.
 *
 * 1. Protects: (a, b) a committed ordinary page whose worktree copy was turned into an equivalent head plus parts without
 *    committing them is a divergence the door did not produce: a title edit refuses split_page_unsupported (unit_diverged
 *    on a strict source, non_strict_source on any other) and leaves the disk, the index and HEAD as they were, rather
 *    than committing the hand conversion; (c) recovery reads a door commit missing a part the head lists (one only on disk) as not
 *    landed as published (`recovery_required`), and one holding the whole unit as landed.
 * 2. Fails when: a commit's paths are only the files the write wrote or removed, so a kept part Git never had stays out
 *    of HEAD (a fresh checkout cannot reassemble the page), or recovery accepts such a commit.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { splitLandedCommit } from '../src/core/persistence/split-files.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY, type ParsedHead } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of a synthetic acme-example page body, long enough to fill a part.`).join('\n');
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, content: string, expected_revision?: string) => operations.find(op => op.name === 'put_page')!.handler(ctx,
  { slug: 'notes/probe', content, ...(expected_revision ? { expected_revision } : {}), request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, any>>;

/** HEAD holds the head on disk and exactly the parts its manifest lists, each with the listed bytes. */
function expectHeadHoldsUnit(root: string): void {
  const head = join(root, 'notes/probe.md');
  const parsed = parseHead(readFileSync(head, 'utf8')) as ParsedHead;
  expect(git(root, 'show', 'HEAD:notes/probe.md')).toBe(readFileSync(head, 'utf8'));
  const tracked = git(root, 'ls-tree', '-r', '--name-only', 'HEAD', 'notes/.probe.gbparts').split('\n').filter(Boolean).sort();
  const listed = parsed.manifest.parts.map(part => `notes/.probe.gbparts/${part.path.slice(part.path.indexOf('/') + 1)}`).sort();
  expect(tracked).toEqual(listed);
  expect(readdirSync(partsDirFor(head)).map(name => `notes/.probe.gbparts/${name}`).sort()).toEqual(listed);
  for (const part of parsed.manifest.parts) expect(sha(Buffer.from(git(root, 'show', `HEAD:notes/.probe.gbparts/${part.path.slice(part.path.indexOf('/') + 1)}`), 'utf8'))).toBe(part.sha256);
}

/** The unit's bytes in each state: the head and parts on disk, the index entries and HEAD's tree under notes/. */
function unitBytes(root: string) {
  const head = join(root, 'notes/probe.md'), dir = partsDirFor(head);
  return { head: sha(readFileSync(head)), parts: Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(readFileSync(join(dir, name)))])),
    index: git(root, 'ls-files', '-s', '--', 'notes'), tree: git(root, 'ls-tree', '-r', 'HEAD', '--', 'notes') };
}

/** A committed ordinary page whose worktree copy is now an equivalent head plus parts, none of them committed. */
async function convertedNotCommitted(engine: BrainEngine, ctx: OperationContext, root: string): Promise<string> {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(24 * 1024 ** 2));
  expect(await put(ctx, page('Split example'))).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
  const head = join(root, 'notes/probe.md');
  await writeSplitPage(root, 'notes/probe.md', readFileSync(head, 'utf8'));
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  return (await engine.readPageSnapshot('notes/probe', { sourceId: 'default' }))!.revision;
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: every commit holds the whole unit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  // "Refuse rather than reconcile": a layout converted on disk and never committed is a divergence the door did not
  // produce, so the write refuses split_page_unsupported and every byte stays: the disk, the index and HEAD.
  for (const strict of [true, false]) test(`(${strict ? 'a' : 'b'}) ${strict ? 'strict' : 'non-strict'}: a title edit over a converted, never-committed layout refuses and leaves the disk, the index and HEAD as they were`, () => managedBrain(async ({ engine, ctx, root }) => {
    if (strict) await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    const revision = await convertedNotCommitted(engine, ctx, root);
    const before = unitBytes(root);
    expect(await put(ctx, page('Retitled example'), revision).then(() => null, error => `${error.code}:${error.reason}`)).toBe(`split_page_unsupported:${strict ? 'unit_diverged' : 'non_strict_source'}`);
    await settleManagedGitEffects(engine);
    expect(unitBytes(root)).toEqual(before);
    expect((await engine.readPageSnapshot('notes/probe', { sourceId: 'default' }))!.revision).toBe(revision);
  }, { databaseUrl, setup }), 120_000);

  test('(c) recovery: a door commit missing a part the head lists is not landed as published; the whole unit is', () => managedBrain(async ({ root }) => {
    __setSplitLimitsForTests(LIMITS);
    const doorHead = git(root, 'rev-parse', 'HEAD').trim();
    const written = await writeSplitPage(root, 'notes/probe.md', page('Split example'));
    const head = join(root, 'notes/probe.md');
    const files = [{ path: head, afterHash: sha(readFileSync(head)) }];
    git(root, 'add', 'notes/probe.md', ...written.parts.slice(1).map(part => part.rel));
    git(root, 'commit', '-qm', 'Synthetic partial unit');
    await expect(splitLandedCommit(root, doorHead, files)).rejects.toMatchObject({ code: 'recovery_required' });
    git(root, 'add', written.parts[0]!.rel);
    git(root, 'commit', '-q', '--amend', '-m', 'Synthetic whole unit');
    expect(await splitLandedCommit(root, doorHead, files)).toBe(git(root, 'rev-parse', 'HEAD').trim());
  }, { databaseUrl, setup }), 120_000);
});
