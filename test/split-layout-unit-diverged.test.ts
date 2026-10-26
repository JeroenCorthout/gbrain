/**
 * Wave B PR 5 lane 5b, round 6: a split page's unit (its head and everything under its parts directory) is published only
 * when Git HEAD, the index and the disk hold it the same way. persistence/effect-git.ts `readSplitUnitLayers` reads the
 * three (raw blob ids, no clean filter) and `splitUnitDivergence` names the first path they disagree on; split-files.ts
 * `assertSplitUnitIntact` refuses such a publication with `split_unit_diverged` before anything is written. A divergence
 * the door produced itself (a non-strict write whose Git effect has not committed yet) is not one.
 *
 * 1. Protects: a person converts a split page to one file on disk without committing (HEAD and the index still hold
 *    the head and its parts), then a shrink, a delete or a strict private transition runs. The write refuses and changes
 *    nothing: the disk, the index and HEAD keep their bytes, so no commit leaves the old parts beside a plain head.
 *    A part removed from the index alone (git rm --cached) refuses the same way, and a remote caller gets the code and
 *    its fix. Two writes in a row on a non-strict source, the second before the first's Git effect ran, still commit, and
 *    the effect commits the whole unit.
 * 2. Fails when: the publication decides from the disk alone, so the commit holds a plain head plus the obsolete parts
 *    (or the index-only removal rides into the next human commit).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe';
const lines = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of a synthetic acme-example page body long enough to fill parts.`);
const page = (title = 'Example', extra = '', body = lines.join('\n')) => `---\ntype: note\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const snapshot = (engine: BrainEngine) => engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
const strictSource = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
afterEach(() => __setSplitLimitsForTests(null));

async function call(ctx: OperationContext, name: string, params: Record<string, unknown>): Promise<{ code: string | null; state?: string }> {
  try {
    const result = await operations.find(op => op.name === name)!.handler(ctx, { slug: SLUG, request_id: randomUUID(), wait_ms: 30_000, ...params }) as { state?: string };
    return { code: null, state: result.state };
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { code: error.code };
  }
}

/** Every byte of the unit in each of the three states: the disk, the index and HEAD. */
function unitState(root: string) {
  const head = join(root, `${SLUG}.md`), dir = partsDirFor(head);
  return {
    disk: { head: existsSync(head) ? sha(readFileSync(head)) : null, parts: existsSync(dir) ? Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(readFileSync(join(dir, name)))])) : null },
    index: git(root, 'ls-files', '-s', '--', 'notes'),
    commit: git(root, 'rev-parse', 'HEAD').trim(),
    tree: git(root, 'ls-tree', '-r', 'HEAD', '--', 'notes'),
  };
}

async function committedSplitPage(engine: BrainEngine, ctx: OperationContext, strict: boolean) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  if (strict) await strictSource(engine);
  expect(await call(ctx, 'put_page', { content: page() })).toEqual({ code: null, state: 'committed' });
  await settleManagedGitEffects(engine);
  return (await snapshot(engine))!;
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: a unit HEAD, the index and the disk disagree on is refused`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const strict of [true, false]) for (const action of ['shrink', 'delete', 'private'] as const) {
    if (!strict && action === 'private') continue;
    test(`uncommitted split-to-plain conversion, then ${action} (strict=${strict}): refused, every byte kept`, () => managedBrain(async ({ engine, ctx, root }) => {
      const old = await committedSplitPage(engine, ctx, strict);
      const head = join(root, `${SLUG}.md`);
      writeFileSync(head, serializePageToMarkdown(old.page, old.tags));
      rmSync(partsDirFor(head), { recursive: true });
      const before = unitState(root);
      expect(before.tree.split('\n').filter(line => line.includes('.gbpart')).length).toBeGreaterThan(1);
      const result = action === 'delete' ? await call(ctx, 'delete_page', { expected_revision: old.revision })
        : await call(ctx, 'put_page', { content: page('Rewritten', action === 'private' ? 'visibility: private\n' : '', action === 'shrink' ? 'Short body.' : lines.join('\n')), expected_revision: old.revision });
      expect(result).toEqual({ code: 'split_unit_diverged' });
      await settleManagedGitEffects(engine);
      expect(unitState(root)).toEqual(before);
      expect((await snapshot(engine))!.revision).toBe(old.revision);
    }, { databaseUrl, setup }), 120_000);
  }

  for (const strict of [true, false]) test(`a part removed from the index only (strict=${strict}): refused, the index, disk and HEAD kept`, () => managedBrain(async ({ engine, ctx, root }) => {
    const old = await committedSplitPage(engine, ctx, strict);
    const dir = partsDirFor(join(root, `${SLUG}.md`));
    git(root, 'rm', '-q', '--cached', '--', join(dir, readdirSync(dir).sort()[3]!));
    const before = unitState(root);
    expect(await call(ctx, 'put_page', { content: page('Rewritten'), expected_revision: old.revision })).toEqual({ code: 'split_unit_diverged' });
    await settleManagedGitEffects(engine);
    expect(unitState(root)).toEqual(before);
  }, { databaseUrl, setup }), 120_000);

  test('a remote caller gets split_unit_diverged with its fix on the envelope', () => managedBrain(async ({ engine, ctx, root }) => {
    const old = await committedSplitPage(engine, ctx, true);
    const head = join(root, `${SLUG}.md`);
    writeFileSync(head, serializePageToMarkdown(old.page, old.tags));
    rmSync(partsDirFor(head), { recursive: true });
    const before = unitState(root);
    const result = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: page('Rewritten', '', 'Short body.'), expected_revision: old.revision, request_id: randomUUID(), wait_ms: 30_000 },
      { remote: true, transport: 'stdio', sourceId: 'default' });
    const envelope = JSON.parse(result.content.map(item => item.text).join('')) as { code: string; suggestion: string; fix?: unknown };
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe('split_unit_diverged');
    expect(envelope.suggestion).toContain('gbrain git commit-push');
    expect(envelope.fix).toBeDefined();
    expect(unitState(root)).toEqual(before);
  }, { databaseUrl, setup }), 120_000);

  test('a second non-strict write before the first Git effect ran still commits, and the effect commits the whole unit', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await call(ctx, 'put_page', { content: page() })).toEqual({ code: null, state: 'committed' });
    const first = (await snapshot(engine))!;
    expect(await call(ctx, 'put_page', { content: page('Second', '', lines.map(line => `${line} Second.`).join('\n')), expected_revision: first.revision })).toEqual({ code: null, state: 'committed' });
    await settleManagedGitEffects(engine);
    const head = join(root, `${SLUG}.md`), parsed = parseHead(readFileSync(head, 'utf8'))!;
    if ('error' in parsed) throw new Error(parsed.error.reason);
    const tracked = git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'notes').split('\n').filter(Boolean).sort();
    expect(tracked).toEqual([`${SLUG}.md`, ...parsed.manifest.parts.map(part => `notes/${part.path}`)].sort());
    for (const part of parsed.manifest.parts) expect(sha(git(root, 'show', `HEAD:notes/${part.path}`))).toBe(part.sha256);
  }, { databaseUrl, setup }), 120_000);
});
