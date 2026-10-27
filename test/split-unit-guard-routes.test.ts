/**
 * Wave B PR 5 (option B), C1: every route outside the publication door reaches the one split-unit predicate on the unit
 * as Git and the disk hold it. A synchronous writer sees parts held only in HEAD or the index, a symlink alias of a parts
 * directory names the real unit, local storage deletion refuses a live part, and gbrain git commit-push commits only a
 * whole, verified unit.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests, parseHead, verifyParts } from '../src/core/split-layout/index.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { assertSplitUnitMutable } from '../src/core/persistence/split-unit-guard.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/example', HEAD = SLUG + '.md', DIR = 'notes/.example.gbparts';
const page = '---\ntype: note\ntitle: First\n---\n\n' + Array.from({ length: 50 }, (_, i) => 'Line ' + i + ': original synthetic material filling this test page with enough data for part files.').join('\n') + '\n';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const outsideDoor = { code: 'split_page_unsupported', reason: 'outside_door' };
afterEach(() => __setSplitLimitsForTests(null));

async function committedSplit(engine: BrainEngine, ctx: OperationContext) {
  __setSplitLimitsForTests(LIMITS);
  await engine.executeRaw('UPDATE sources SET config=config || \'{"canonical":"git"}\'::jsonb WHERE id=\'default\'');
  expect(await operations.find(x => x.name === 'put_page')!.handler(ctx, { slug: SLUG, content: page, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
}
const refusal = (work: Promise<unknown>) => work.then(() => null, error => ({ code: error.code, reason: error.reason }));
function committedVerdict(root: string) {
  const parsed = parseHead(git(root, 'show', 'HEAD:' + HEAD));
  if (!parsed || 'error' in parsed) throw new Error('Expected a split head in HEAD');
  return verifyParts(join(root, HEAD), parsed);
}

for (const backend of testBackends()) describe('[' + backend + '] split unit routes outside the door', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const held of ['HEAD', 'index'] as const) test('a synchronous writer refuses a split unit held only in ' + held, () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const staged = git(root, 'ls-files', '-s', '--', DIR).trim().split('\n');
    git(root, 'rm', '-r', '-q', '--cached', '--', DIR);
    if (held === 'index') {
      git(root, 'commit', '-qm', 'Parts leave HEAD');
      for (const line of staged) {
        const [meta, path] = line.split('\t'), [mode, oid] = meta!.split(' ');
        git(root, 'update-index', '--add', '--cacheinfo', mode + ',' + oid + ',' + path);
      }
    }
    rmSync(join(root, DIR), { recursive: true });
    const before = 'An uncommitted one-file edit\n';
    writeFileSync(join(root, HEAD), before);
    expect(await refusal(assertSplitUnitMutable({ root, path: join(root, HEAD), route: 'raw_writer', strict: false }))).toEqual(outsideDoor);
    expect(await refusal(new LocalStorage(root).upload(HEAD, Buffer.from('Overwritten by an outside writer\n')))).toEqual(outsideDoor);
    expect(readFileSync(join(root, HEAD), 'utf8')).toBe(before);
  }, { databaseUrl, setup }), 120_000);

  test('local storage deletion refuses a live part', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const part = DIR + '/' + readdirSync(join(root, DIR))[0];
    expect(await refusal(new LocalStorage(root).delete(part))).toEqual(outsideDoor);
    expect(existsSync(join(root, part))).toBe(true);
    await new LocalStorage(root).upload('attachments/example.bin', Buffer.from([1, 2, 3]));
    await new LocalStorage(root).delete('attachments/example.bin');
    expect(existsSync(join(root, 'attachments/example.bin'))).toBe(false);
  }, { databaseUrl, setup }), 120_000);

  test('a symlink alias of the parts directory cannot hide a part from the predicate', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const name = readdirSync(join(root, DIR))[0]!;
    symlinkSync(join(root, DIR), join(root, 'attachment-alias'));
    const alias = 'attachment-alias/' + name, before = readFileSync(join(root, DIR, name), 'utf8');
    expect(await refusal(assertSplitUnitMutable({ root, path: join(root, alias), route: 'raw_writer', strict: false }))).toEqual(outsideDoor);
    expect(await refusal(new LocalStorage(root).upload(alias, Buffer.from('Overwritten through the alias\n')))).toEqual(outsideDoor);
    expect(readFileSync(join(root, DIR, name), 'utf8')).toBe(before);
    const parsed = parseHead(readFileSync(join(root, HEAD), 'utf8'));
    if (!parsed || 'error' in parsed) throw new Error('Expected a split head');
    expect(verifyParts(join(root, HEAD), parsed)).toMatchObject({ ok: true });
  }, { databaseUrl, setup }), 120_000);

  test('commit-push refuses an independently edited part and leaves HEAD and the index unchanged', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const part = DIR + '/' + readdirSync(join(root, DIR))[0];
    const before = git(root, 'rev-parse', 'HEAD').trim(), index = git(root, 'ls-files', '-s', '--', DIR);
    writeFileSync(join(root, part), 'An edit that does not match the manifest\n');
    let error: unknown = null;
    try { commitAndPush({ repo: root, cwd: root, paths: [part], message: 'Outside door part edit' }); }
    catch (caught: any) { error = { code: caught.code, reason: caught.reason }; }
    expect(error).toEqual(outsideDoor);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(root, 'ls-files', '-s', '--', DIR)).toBe(index);
    expect(git(root, 'diff', '--name-only', 'HEAD', '--', DIR).trim()).toBe(part);
    expect(committedVerdict(root)).toMatchObject({ ok: false });
  }, { databaseUrl, setup }), 120_000);

  test('commit-push refuses a whole new unit committed by its head alone, and commits it with its parts directory', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const before = git(root, 'rev-parse', 'HEAD').trim();
    rmSync(join(root, DIR), { recursive: true });
    await writeSplitPage(root, HEAD, page.replace('title: First', 'title: Second').replace('Line 0:', 'Line 0, edited:'));
    let error: unknown = null;
    try { commitAndPush({ repo: root, cwd: root, paths: [HEAD], message: 'Head alone' }); }
    catch (caught: any) { error = { code: caught.code, reason: caught.reason }; }
    expect(error).toEqual(outsideDoor);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(commitAndPush({ repo: root, cwd: root, paths: [HEAD, DIR], message: 'Whole unit' })).toMatchObject({ outcome: 'committed_local' });
    expect(git(root, 'show', 'HEAD:' + HEAD)).toContain('title: Second');
    expect(committedVerdict(root)).toMatchObject({ ok: true });
  }, { databaseUrl, setup }), 120_000);
});
