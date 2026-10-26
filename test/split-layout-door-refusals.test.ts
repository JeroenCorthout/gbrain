/**
 * Wave B PR 5 round 7 (option B): the review's door findings F1, F2, F4 and F5, end to end through publishMutation.
 *
 * 1. Protects: an index flag (skip-worktree, assume-unchanged) on a split head refuses before any write (index_flag on a
 *    git-canonical source, non_strict_source otherwise), so no commit holds a manifest without its parts (F1); a queued
 *    Git effect for the path exempts nothing, so a human edit staged in the index refuses and survives (F2); an ident
 *    attribute on the part files refuses on a git-canonical source (git_attribute) and a non-strict source writes one
 *    file (F4); recovery verifies every before-copy before it restores any file, so a corrupted later copy blocks
 *    (unexpected_staging_bytes) with every canonical file as it was (F5).
 * 2. Fails when: a flagged head lets a commit drop the manifest's parts, a queued effect exempts a divergence, ident
 *    reaches a split commit, or recovery restores earlier files before it finds a bad copy.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor } from '../src/core/split-layout/index.ts';
import { publishMutation, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe';
const page = (title = 'First', body = 'original') => `---\ntype: note\ntitle: ${title}\n---\n\n` + Array.from({ length: 50 }, (_, i) => `Line ${i}: ${body} synthetic material filling this test page with enough data for part files.`).join('\n') + '\n';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const snapshot = (engine: BrainEngine) => engine.readPageSnapshot(SLUG, { sourceId: 'default' });
const put = (ctx: OperationContext, content: string) => operations.find(x => x.name === 'put_page')!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<any>;
afterEach(() => __setSplitLimitsForTests(null));

async function publish(engine: BrainEngine, ctx: OperationContext, content: string, hooks: PublicationHooks = {}) {
  await disposePersistenceConsumer(engine);
  const host = localHostId(), binding = (await getWorktreeBinding(engine, 'default', host))!, old = (await snapshot(engine))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, SLUG);
  const intent = { slug: SLUG, content, expected_revision: old.revision };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug: SLUG, pageId: old.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, host))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, ctx.config), host, hooks);
}

function treeProblems(root: string): string[] {
  const parsed = parseHead(git(root, 'show', `HEAD:${SLUG}.md`));
  if (!parsed || 'error' in parsed) return ['not a split head'];
  const listed = git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'notes/.probe.gbparts').trim().split('\n');
  return parsed.manifest.parts.map(part => `notes/${part.path}`).filter(path => !listed.includes(path));
}


const strictSource = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config=config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const nonStrict = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config = config - 'canonical' WHERE id='default'");
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const unit = (root: string) => {
  const file = join(root, `${SLUG}.md`), dir = partsDirFor(file);
  return { head: existsSync(file) ? sha(readFileSync(file)) : null, parts: existsSync(dir) ? Object.fromEntries(readdirSync(dir).sort().map(n => [n, sha(readFileSync(join(dir, n)))])) : {} };
};
const reason = (row: any) => row.error_detail?.origin ?? null;

/** A split page the strict door committed (option B: only a git-canonical source writes one). */
async function committedSplit(engine: BrainEngine, ctx: OperationContext) {
  __setSplitLimitsForTests(LIMITS);
  await strictSource(engine);
  expect(await put(ctx, page())).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: the door refuses a unit it cannot publish whole`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('F5: recovery verifies every before-copy before restoring any file (strict door)', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const head = join(root, `${SLUG}.md`);
    let records: any[] = [], atRefusal: ReturnType<typeof unit> | null = null;
    const result = await publish(engine, ctx, page('Second', 'replacement body'), { boundary: async (name, row) => {
      if (name === 'prepared') {
        const [saved] = await engine.executeRaw<any>('SELECT recovery FROM persistence_requests WHERE id=$1::uuid', [row.id]);
        records = (typeof saved.recovery === 'string' ? JSON.parse(saved.recovery) : saved.recovery).files;
      }
      if (name === 'after_publication') {
        const later = records.filter(record => record.staging?.before).at(-1)!;
        expect(later.path).not.toBe(head);
        writeFileSync(later.staging.before.path, 'Synthetic corrupted backup');
        atRefusal = unit(root);
        throw Object.assign(new Error('Synthetic interruption'), { code: 'CONNECTION_CLOSED' });
      }
    } });
    expect(unit(root)).toEqual(atRefusal!);
    expect(result.blocked_reason).toBe('unexpected_staging_bytes');
  }, { databaseUrl, setup }), 120_000);

  for (const strict of [true, false]) test(`F2: a queued Git effect does not exempt a later human index edit, strict=${strict}`, () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    expect(await publish(engine, ctx, page('Second'))).toMatchObject({ state: 'committed' });
    const pending = await engine.executeRaw(`SELECT state FROM persistence_effects WHERE kind='git' AND state='queued'`);
    expect(pending.length).toBeGreaterThan(0);
    if (!strict) await nonStrict(engine);
    const head = join(root, `${SLUG}.md`), disk = readFileSync(head, 'utf8');
    writeFileSync(head, disk.replace('title: Second', 'title: HUMAN STAGED EDIT'));
    git(root, 'add', `${SLUG}.md`);
    writeFileSync(head, disk);
    const staged = git(root, 'show', `:${SLUG}.md`), revision = (await snapshot(engine))!.revision;
    const result = await publish(engine, ctx, page('Third'));
    await settleManagedGitEffects(engine);
    expect(git(root, 'show', `:${SLUG}.md`)).toBe(staged);
    expect(readFileSync(head, 'utf8')).toBe(disk);
    expect((await snapshot(engine))!.revision).toBe(revision);
    expect([result.error_code, reason(result)]).toEqual(['split_page_unsupported', strict ? 'unit_diverged' : 'non_strict_source']);
  }, { databaseUrl, setup }), 120_000);

  for (const strict of [true, false]) for (const flag of ['--skip-worktree', '--assume-unchanged']) test(`F1: ${flag} on the head refuses before any write, strict=${strict}`, () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    if (!strict) await nonStrict(engine);
    git(root, 'update-index', flag, `${SLUG}.md`);
    const before = unit(root), commit = git(root, 'rev-parse', 'HEAD'), revision = (await snapshot(engine))!.revision;
    const result = await publish(engine, ctx, page('Second', 'entirely different'));
    await settleManagedGitEffects(engine);
    const missing = treeProblems(root);
    expect(missing).toEqual([]);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(commit);
    expect(unit(root)).toEqual(before);
    expect((await snapshot(engine))!.revision).toBe(revision);
    expect([result.error_code, reason(result)]).toEqual(['split_page_unsupported', strict ? 'index_flag' : 'non_strict_source']);
  }, { databaseUrl, setup }), 120_000);

  for (const strict of [true, false]) test(`F4: an ident attribute never publishes a split unit, strict=${strict}`, () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    if (strict) await strictSource(engine);
    writeFileSync(join(root, '.gitattributes'), '*.gbpart ident\n');
    git(root, 'add', '.gitattributes'); git(root, 'commit', '-qm', 'Synthetic ident attribute');
    const commit = git(root, 'rev-parse', 'HEAD');
    const result = await put(ctx, page('Ident', '$Id$')).catch(error => ({ code: error.code, reason: error.reason }));
    await settleManagedGitEffects(engine);
    const parts = existsSync(join(root, 'notes/.probe.gbparts'));
    expect(parts).toBe(false);
    if (strict) {
      expect([result.code, result.reason]).toEqual(['split_page_unsupported', 'git_attribute']);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(commit);
      expect(existsSync(join(root, `${SLUG}.md`))).toBe(false);
    } else {
      expect(result.state).toBe('committed');
      expect(git(root, 'show', `HEAD:${SLUG}.md`)).toContain('$Id$');
    }
  }, { databaseUrl, setup }), 120_000);
});
