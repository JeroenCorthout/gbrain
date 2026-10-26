/**
 * Wave B PR 5 lane 5b: every commit of a split page holds the whole unit. effect-git.ts `splitUnitPaths` is the one path
 * set: the head, every part its manifest lists and every other path Git has under its parts directory, which the commit
 * removes. The strict door commit, the split Git effect and landed-commit recovery (split-files.ts `splitLandedCommit`)
 * all use it.
 *
 * 1. Protects: (a) a committed ordinary page whose worktree copy was turned into an equivalent head plus parts without
 *    committing them; a title edit on a strict source reports `committed` and HEAD holds the head with every manifest part
 *    (the parts it kept unwritten included) and nothing else in the parts directory; (b) the same on a non-strict source
 *    through the split Git effect; (c) recovery reads a door commit missing a part the head lists (one only on disk) as not
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

  test('(a) strict: a title edit over a converted, never-committed layout commits the head with every manifest part and nothing else', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    const revision = await convertedNotCommitted(engine, ctx, root);
    const result = await put(ctx, page('Retitled example'), revision);
    expect(result).toMatchObject({ state: 'committed' });
    expectHeadHoldsUnit(root);
  }, { databaseUrl, setup }), 120_000);

  test('(b) non-strict: the split Git effect commits the head with every manifest part and nothing else', () => managedBrain(async ({ engine, ctx, root }) => {
    const revision = await convertedNotCommitted(engine, ctx, root);
    expect(await put(ctx, page('Retitled example'), revision)).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    expectHeadHoldsUnit(root);
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
