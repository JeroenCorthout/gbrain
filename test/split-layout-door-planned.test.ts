/**
 * Wave B PR 5 C1: the split publication is one planned-state door commit (git-door.ts commitThroughDoor). Its DoorFiles
 * come from the recovery record and the manifest, never from the disk: the head and each written part at the record's
 * afterHash, each kept part at the manifest's sha256, and `planned: null` for anything else HEAD or the index hold in the
 * parts directory, which must hold nothing else (`exactDirs`).
 *
 * 1. Protects (the planned list and exactDirs): a staged change to the head (before the write, D1, or during it, D2) or to a part refuses
 *    git_index_conflict and leaves the index as the user left it; a part committed into the parts directory during the
 *    write (D3: before the door reads the tree, through its planned: null entry; after it, through exactDirs on the
 *    door's one retry) refuses git_target_changed naming it, and no door commit lands; a hand edit to the head (D4), a written
 *    part or a kept part during the write refuses git_target_changed, so Git never holds bytes the row does not; a part
 *    the new manifest drops leaves HEAD, and a kept part stays in it unchanged.
 * 2. Fails when: the door commit takes its paths or planned hashes from the disk (the r7b findings D1-D4 on cbac38c17:
 *    each of these publications committed), or ignores a stray committed part.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests, parseHead, type ParsedHead } from '../src/core/split-layout/index.ts';
import { publishMutation, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { doorSeams } from '../src/core/persistence/git-door.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe', HEAD = `${SLUG}.md`, DIR = 'notes/.probe.gbparts';
const page = (title = 'First', body = 'original', lines = 50) => `---\ntype: note\ntitle: ${title}\n---\n\n` + Array.from({ length: lines }, (_, i) => `Line ${i}: ${body} synthetic material filling this test page with enough data for part files.`).join('\n') + '\n';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, content: string) => operations.find(x => x.name === 'put_page')!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<any>;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config=config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const held = (root: string) => git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', DIR).trim().split('\n').filter(Boolean);
const committedHead = (root: string) => parseHead(git(root, 'show', `HEAD:${HEAD}`)) as ParsedHead;
const outcome = (result: any) => { if (process.env.DEBUG_DOOR) console.log('DOOR', JSON.stringify({ ...result, intent: undefined, caller_intent: undefined, outcome: undefined })); return [result.state, result.error_code]; };
afterEach(() => __setSplitLimitsForTests(null));

async function committedSplit(engine: BrainEngine, ctx: OperationContext) {
  __setSplitLimitsForTests(LIMITS);
  await strict(engine);
  expect(await put(ctx, page())).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
}

/** One strict publication through publishMutation, with `hooks` at its boundaries (the files are published at after_publication). */
async function publish(engine: BrainEngine, ctx: OperationContext, content: string, hooks: PublicationHooks = {}) {
  await disposePersistenceConsumer(engine);
  const host = localHostId(), binding = (await getWorktreeBinding(engine, 'default', host))!, old = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, SLUG);
  const intent = { slug: SLUG, content, expected_revision: old.revision };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug: SLUG, pageId: old.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, host))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, ctx.config), host, hooks) as Promise<any>;
}
const afterPublication = (act: () => void): PublicationHooks => ({ boundary: async name => { if (name === 'after_publication') act(); } });

for (const backend of testBackends()) describe(`[${backend}] split git layout: one planned-state door commit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('D1: the first split refuses a staged edit to the plain head and leaves it staged', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await strict(engine);
    expect(await put(ctx, '---\ntype: note\ntitle: Small\n---\nSmall body.\n')).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    const head = join(root, HEAD), original = readFileSync(head, 'utf8');
    writeFileSync(head, original.replace('title: Small', 'title: USER STAGED SMALL'));
    git(root, 'add', HEAD);
    const staged = git(root, 'rev-parse', `:${HEAD}`).trim(), commit = git(root, 'rev-parse', 'HEAD').trim();
    writeFileSync(head, original);
    expect(outcome(await publish(engine, ctx, page('First split')))).toEqual(['failed', 'git_index_conflict']);
    expect(git(root, 'rev-parse', `:${HEAD}`).trim()).toBe(staged);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(commit);
  }, { databaseUrl, setup }), 120_000);

  test('D2: a head edit staged during the write refuses and stays staged', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    let staged = '';
    const result = await publish(engine, ctx, page('Second'), afterPublication(() => {
      const head = join(root, HEAD), disk = readFileSync(head, 'utf8');
      writeFileSync(head, disk.replace('title: Second', 'title: USER STAGED EDIT'));
      git(root, 'add', HEAD);
      staged = git(root, 'rev-parse', `:${HEAD}`).trim();
      writeFileSync(head, disk);
    }));
    expect(outcome(result)).toEqual(['failed', 'git_index_conflict']);
    expect(git(root, 'rev-parse', `:${HEAD}`).trim()).toBe(staged);
  }, { databaseUrl, setup }), 120_000);

  test('D3: a part committed into the parts directory during the write refuses git_target_changed naming it; no door commit lands', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const extra = `${DIR}/9999-deadbeef.gbpart`;
    let userCommit = '';
    const result = await publish(engine, ctx, page('Second'), afterPublication(() => {
      writeFileSync(join(root, extra), 'USER CONCURRENT PART\n');
      git(root, 'add', extra);
      git(root, 'commit', '--only', '-qm', 'Concurrent user part', '--', extra);
      userCommit = git(root, 'rev-parse', 'HEAD').trim();
    }));
    expect(outcome(result)).toEqual(['recovering', 'git_target_changed']);
    expect(result.error_message).toContain(extra);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(userCommit);
    expect(committedHead(root).manifest.parts.length).toBeGreaterThan(0);
    expect(git(root, 'show', `HEAD:${HEAD}`)).toContain('title: First');
  }, { databaseUrl, setup }), 120_000);

  test('D3 inside the door: a part committed between the door\'s read and its ref update refuses git_target_changed on the retry (exactDirs)', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const extra = `${DIR}/9999-deadbeef.gbpart`;
    let userCommit = '';
    doorSeams.beforeUpdateRef = (_root, attempt) => {
      if (attempt) return;
      writeFileSync(join(root, extra), 'USER CONCURRENT PART\n');
      git(root, 'add', extra);
      git(root, 'commit', '--only', '-qm', 'Concurrent user part', '--', extra);
      userCommit = git(root, 'rev-parse', 'HEAD').trim();
    };
    try {
      const result = await publish(engine, ctx, page('Second'));
      expect(outcome(result)).toEqual(['recovering', 'git_target_changed']);
      expect(result.error_message).toContain(extra);
    } finally { doorSeams.beforeUpdateRef = undefined; }
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(userCommit);
    expect(git(root, 'show', `HEAD:${HEAD}`)).toContain('title: First');
  }, { databaseUrl, setup }), 120_000);

  test('D4: a hand edit to the head during the write refuses git_target_changed; Git and the row keep the prior page', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const result = await publish(engine, ctx, page('Second'), afterPublication(() => {
      const head = join(root, HEAD);
      writeFileSync(head, readFileSync(head, 'utf8').replace('title: Second', 'title: USER DISK EDIT'));
    }));
    expect(outcome(result)).toEqual(['recovering', 'git_target_changed']);
    expect(git(root, 'show', `HEAD:${HEAD}`)).not.toContain('USER DISK EDIT');
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.title).toBe('First');
  }, { databaseUrl, setup }), 120_000);

  test('a part the new manifest drops is removed (planned: null); HEAD holds exactly the new manifest', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const before = held(root);
    expect(outcome(await publish(engine, ctx, page('Shorter', 'shorter', 30)))).toEqual(['committed', null]);
    const after = held(root), listed = committedHead(root).manifest.parts.map(part => `notes/${part.path}`);
    expect(after.sort()).toEqual(listed.sort());
    expect(before.filter(path => !after.includes(path)).length).toBeGreaterThan(0);
    expect(readdirSync(join(root, DIR)).map(name => `${DIR}/${name}`).sort()).toEqual(listed.sort());
  }, { databaseUrl, setup }), 120_000);

  test('a kept part is committed at the manifest hash: unchanged when untouched, git_target_changed when edited during the write', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const parts = held(root), blobs = parts.map(path => git(root, 'rev-parse', `HEAD:${path}`).trim());
    expect(outcome(await publish(engine, ctx, page('Second')))).toEqual(['committed', null]);
    expect(held(root)).toEqual(parts);
    expect(parts.map(path => git(root, 'rev-parse', `HEAD:${path}`).trim())).toEqual(blobs);
    expect(git(root, 'show', `HEAD:${HEAD}`)).toContain('title: Second');
    const kept = parts[1]!, commit = git(root, 'rev-parse', 'HEAD').trim();
    const result = await publish(engine, ctx, page('Third'), afterPublication(() => writeFileSync(join(root, kept), 'USER EDIT OF A KEPT PART\n')));
    // Every file the record wrote still holds its bytes, so recovery restores them and the write fails; the edit stays on disk.
    expect(outcome(result)).toEqual(['failed', 'git_target_changed']);
    expect(readFileSync(join(root, kept), 'utf8')).toBe('USER EDIT OF A KEPT PART\n');
    expect(readFileSync(join(root, HEAD), 'utf8')).toBe(git(root, 'show', `HEAD:${HEAD}`));
    expect(result.error_message).toContain(kept);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(commit);
  }, { databaseUrl, setup }), 120_000);

  test('a written part edited during the write refuses git_target_changed naming it', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    let part = '';
    const result = await publish(engine, ctx, page('Second', 'replacement'), afterPublication(() => {
      part = `${DIR}/${readdirSync(join(root, DIR)).filter(name => name.endsWith('.gbpart')).sort()[0]}`;
      writeFileSync(join(root, part), 'USER EDIT OF A WRITTEN PART\n');
    }));
    expect(outcome(result)).toEqual(['recovering', 'git_target_changed']);
    expect(result.error_message).toContain(part);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(commit);
  }, { databaseUrl, setup }), 120_000);

  test('a part staged during the write refuses git_index_conflict and stays staged', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    let part = '', staged = '';
    const result = await publish(engine, ctx, page('Second', 'replacement'), afterPublication(() => {
      part = `${DIR}/${readdirSync(join(root, DIR)).filter(name => name.endsWith('.gbpart')).sort()[0]}`;
      const disk = readFileSync(join(root, part));
      writeFileSync(join(root, part), 'USER STAGED PART\n');
      git(root, 'add', part);
      staged = git(root, 'rev-parse', `:${part}`).trim();
      writeFileSync(join(root, part), disk);
    }));
    expect(outcome(result)).toEqual(['failed', 'git_index_conflict']);
    expect(git(root, 'rev-parse', `:${part}`).trim()).toBe(staged);
  }, { databaseUrl, setup }), 120_000);
});
