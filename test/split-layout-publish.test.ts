/**
 * Wave B PR 5 lane 5b (split git layout, spec §9 option B): the write path. A page whose canonical file F is larger
 * than sync.max_file_bytes is published as a head file at the page's path plus part files in .<name>.gbparts/
 * (persistence/split-files.ts), as one unit:
 *   - a split create writes the head and every part; the file F they reassemble to is the one-file write's F, byte for
 *     byte, and the page row holds the whole body, never the head;
 *   - only a strict source (canonical = git) takes the layout: its door commit at before_commit holds the head and every
 *     part and the effect only pushes; any other source writes the one file it wrote before (option B);
 *   - an append rewrites the head and the last part only: earlier parts keep their inode, mtime and bytes;
 *   - shrinking under the threshold converts back to one file and removes the parts and their directory;
 *   - delete removes the head and its parts; restore writes them again.
 * KB-sized limits through __setSplitLimitsForTests. Runs on PGLite and, with DATABASE_URL, on Postgres (where a single
 * write that may take the split layout leaves the group-of-one route for publishMutation).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, reassemble, splitScratchPath, verifyParts, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const op = (name: string) => operations.find(o => o.name === name)!;
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `Line ${String(from + i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const page = (body: string[]) => `---\ntype: note\ntitle: Split example\n---\n\n${body.join('\n')}\n`;
const put = (ctx: OperationContext, slug: string, content: string, expectedRevision?: string, requestId = randomUUID()) =>
  op('put_page').handler(ctx, { slug, content, request_id: requestId, wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const revision = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
const plainSetup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
/** Option B: only a git-canonical source lays a page out as a split unit, so every fixture source is strict (canonical = git). */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const partsOf = (root: string, rel: string) => {
  const dir = partsDirFor(join(root, rel));
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
/** The page file the head and its parts stand for (verified, reassembled into a scratch file). */
const reassembled = (path: string): string => {
  const parsed = parseHead(readFileSync(path, 'utf8'));
  if (!parsed || 'error' in parsed) throw new Error(`${path} is not a split head`);
  expect(verifyParts(path, parsed)).toMatchObject({ ok: true });
  const scratch = splitScratchPath();
  expect(reassemble(path, parsed, scratch)).toMatchObject({ ok: true });
  return readFileSync(scratch, 'utf8');
};
const stamped = (file: string) => file.replace(/^ingested_at: .*$/m, 'ingested_at: <stamp>');
const committedPaths = (root: string, commit = 'HEAD') => git(root, 'show', '--name-only', '--format=', commit).split('\n').filter(Boolean).sort();
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string }>(
  "SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]?.compiled_truth;

for (const backend of testBackends()) describe(`[${backend}] split git layout: the write path`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { installFaultHook(undefined); __setSplitLimitsForTests(null); });

  test('a page over the threshold is a head plus parts that reassemble to the one-file F; one Git commit holds them all', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    const content = page(lines(0, 80));
    expect(await put(ctx, 'notes/plain', content)).toMatchObject({ state: 'committed' });
    const plain = readFileSync(join(root, 'notes/plain.md'), 'utf8');
    expect(partsOf(root, 'notes/plain.md')).toEqual([]);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(Buffer.byteLength(plain)).toBeGreaterThan(2048);
    expect(await put(ctx, 'notes/big', content)).toMatchObject({ state: 'committed' });
    const head = join(root, 'notes/big.md');
    expect(Buffer.byteLength(readFileSync(head))).toBeLessThan(Buffer.byteLength(plain) / 2);
    const parts = partsOf(root, 'notes/big.md');
    expect(parts.length).toBeGreaterThan(4);
    expect(stamped(reassembled(head))).toBe(stamped(plain));
    expect(await body(engine, 'notes/big')).toBe(await body(engine, 'notes/plain'));
    await settleManagedGitEffects(engine);
    const commits = git(root, 'log', '--format=%H', '--', 'notes/big.md', 'notes/.big.gbparts').split('\n').filter(Boolean);
    expect(commits).toHaveLength(1);
    expect(committedPaths(root, commits[0])).toEqual([...parts.map(p => 'notes/.big.gbparts/' + p), 'notes/big.md'].sort());
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('an append writes the head and the parts from the old last one on; earlier parts keep inode, mtime and bytes', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/log', page(lines(0, 80)))).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    const dir = partsDirFor(join(root, 'notes/log.md'));
    const before = partsOf(root, 'notes/log.md');
    const stats = new Map(before.map(name => [name, { ...statSync(join(dir, name)), bytes: readFileSync(join(dir, name)) }]));
    await Bun.sleep(20);
    expect(await put(ctx, 'notes/log', page(lines(0, 81)), await revision(engine, 'notes/log'))).toMatchObject({ state: 'committed' });
    const after = partsOf(root, 'notes/log.md');
    const kept = after.filter(name => before.includes(name));
    const removed = before.filter(name => !after.includes(name));
    const written = after.filter(name => !before.includes(name));
    expect(kept).toEqual(before.slice(0, kept.length));
    expect(kept.length).toBeGreaterThanOrEqual(before.length - 1);
    expect(written.length).toBeGreaterThan(0);
    for (const name of kept) {
      const now = statSync(join(dir, name)), was = stats.get(name)!;
      expect([now.ino, now.mtimeMs]).toEqual([was.ino, was.mtimeMs]);
      expect(readFileSync(join(dir, name))).toEqual(was.bytes);
    }
    expect(reassembled(join(root, 'notes/log.md'))).toContain(lines(80, 81)[0]);
    await settleManagedGitEffects(engine);
    expect(committedPaths(root)).toEqual([...removed, ...written].map(name => `notes/.log.gbparts/${name}`).concat('notes/log.md').sort());
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('shrinking under the threshold converts back to one file and removes the parts and their directory', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/shrink', page(lines(0, 80)))).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    const parts = partsOf(root, 'notes/shrink.md');
    expect(parts.length).toBeGreaterThan(0);
    const small = page(lines(0, 5));
    expect(await put(ctx, 'notes/shrink', small, await revision(engine, 'notes/shrink'))).toMatchObject({ state: 'committed' });
    expect(existsSync(partsDirFor(join(root, 'notes/shrink.md')))).toBe(false);
    expect(parseHead(readFileSync(join(root, 'notes/shrink.md'), 'utf8'))).toBeNull();
    expect(readFileSync(join(root, 'notes/shrink.md'), 'utf8')).toContain(lines(4, 5)[0]);
    await settleManagedGitEffects(engine);
    expect(committedPaths(root)).toEqual([...parts.map(p => `notes/.shrink.gbparts/${p}`), 'notes/shrink.md'].sort());
    expect(git(root, 'ls-files', 'notes/.shrink.gbparts')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('a page growing over the threshold converts to the split layout', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/grow', page(lines(0, 5)))).toMatchObject({ state: 'committed' });
    expect(partsOf(root, 'notes/grow.md')).toEqual([]);
    expect(await put(ctx, 'notes/grow', page(lines(0, 80)), await revision(engine, 'notes/grow'))).toMatchObject({ state: 'committed' });
    expect(partsOf(root, 'notes/grow.md').length).toBeGreaterThan(4);
    expect(reassembled(join(root, 'notes/grow.md'))).toContain(lines(79, 80)[0]);
  }, { databaseUrl, setup }), 120_000);

  test('delete removes the head and every part; restore writes them again', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/gone', page(lines(0, 80)))).toMatchObject({ state: 'committed' });
    const parts = partsOf(root, 'notes/gone.md');
    await settleManagedGitEffects(engine);
    expect(await op('delete_page').handler(ctx, { slug: 'notes/gone', request_id: randomUUID(), expected_revision: await revision(engine, 'notes/gone'), wait_ms: 30_000 }))
      .toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/gone.md'))).toBe(false);
    expect(existsSync(partsDirFor(join(root, 'notes/gone.md')))).toBe(false);
    await settleManagedGitEffects(engine);
    expect(git(root, 'ls-files', 'notes')).toBe('');
    expect(await op('restore_page').handler(ctx, { slug: 'notes/gone', request_id: randomUUID(), expected_revision: await revision(engine, 'notes/gone'), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    expect(partsOf(root, 'notes/gone.md')).toEqual(parts);
    expect(reassembled(join(root, 'notes/gone.md'))).toContain(lines(0, 80).join('\n'));
  }, { databaseUrl, setup }), 120_000);

  test('a strict source commits the head and every part in the door commit before its row; the effect only pushes', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    await strict(engine);
    const requestId = randomUUID();
    const seen: { head?: string; paths?: string[] } = {};
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:before_commit' || detail.requestId !== requestId) return;
      seen.head = git(root, 'rev-parse', 'HEAD').trim();
      seen.paths = committedPaths(root);
    });
    expect(await put(ctx, 'notes/door', page(lines(0, 80)), undefined, requestId)).toMatchObject({ state: 'committed' });
    const parts = partsOf(root, 'notes/door.md');
    expect(parts.length).toBeGreaterThan(4);
    expect(seen.paths).toEqual([...parts.map(p => `notes/.door.gbparts/${p}`), 'notes/door.md'].sort());
    const [done] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(done!.outcome.persistence).toMatchObject({ git_state: 'committed', git_commit: seen.head });
    await settleManagedGitEffects(engine);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(seen.head!);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  // Option B: a source that is not git-canonical never lays a page out as a split unit; it writes the one file it wrote
  // before the layout existed (the same bytes as under the default threshold), and a Git-durable one commits just that file.
  for (const git_ of ['none', 'durable'] as const) test(`a non-strict source (${git_ === 'none' ? 'no Git' : 'Git-durable'}) writes a page over the threshold as one file, as before`, () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    const content = page(lines(0, 80));
    expect(await put(ctx, 'notes/plain', content)).toMatchObject({ state: 'committed' });
    const plain = readFileSync(join(root, 'notes/plain.md'));
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(plain.byteLength).toBeGreaterThan(2048);
    expect(await put(ctx, 'notes/files', content)).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, '.git'))).toBe(git_ === 'durable');
    expect(existsSync(partsDirFor(join(root, 'notes/files.md')))).toBe(false);
    expect(stamped(readFileSync(join(root, 'notes/files.md'), 'utf8'))).toBe(stamped(plain.toString('utf8')));
    expect(await body(engine, 'notes/files')).toBe(await body(engine, 'notes/plain'));
    if (git_ === 'none') return;
    await settleManagedGitEffects(engine);
    const commits = git(root, 'log', '--format=%H', '--', 'notes/files.md', 'notes/.files.gbparts').split('\n').filter(Boolean);
    expect(commits).toHaveLength(1);
    expect(committedPaths(root, commits[0])).toEqual(['notes/files.md']);
    expect(git(root, 'show', `${commits[0]}:notes/files.md`)).toBe(readFileSync(join(root, 'notes/files.md'), 'utf8'));
  }, { databaseUrl, ...(git_ === 'durable' ? { setup: plainSetup } : {}) }), 120_000);
});
