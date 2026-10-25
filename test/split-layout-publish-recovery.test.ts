/**
 * Wave B PR 5 lane 5b (split git layout): a split page's publication recovers as one unit (persistence/split-files.ts).
 *   - a publication that fails after any one of its files (the head, a part, the last part) restores every file to
 *     its prior bytes: never a mix of old and new files, and the page row is unchanged (no database content write
 *     before the files are in place);
 *   - on a strict source, interrupted after the door commit, every file is kept (one commit holds them all), the
 *     replay completes against it and the receipt names that commit with landed_before_row; interrupted before the
 *     commit, every file is restored and the replay commits once;
 *   - a write whose target is a part file is refused;
 *   - the request protocol guard accepts the page_split recovery record on a page request (v275) and still refuses a
 *     skill bundle record there.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { publishMutation, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, prepareRecovery } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, reassemble, splitScratchPath, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const op = (name: string) => operations.find(o => o.name === name)!;
const lines = (from: number, to: number, tag = 'first') => Array.from({ length: to - from }, (_, i) => `Line ${String(from + i).padStart(4, '0')} (${tag}) of the split page body, long enough to fill a part.`);
const page = (body: string[]) => `---\ntype: note\ntitle: Split example\n---\n\n${body.join('\n')}\n`;
const interruption = (code: string) => Object.assign(new Error(`database interruption ${code}`), { code });
const put = (ctx: OperationContext, slug: string, content: string, expectedRevision?: string, requestId = randomUUID()) =>
  op('put_page').handler(ctx, { slug, content, request_id: requestId, wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const snapshotOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
/** Every file of the split unit at rel: the head and each file of its parts directory (a publication's own staging aside), with their bytes. */
const unit = (root: string, rel: string): Record<string, string> => {
  const head = join(root, rel), dir = partsDirFor(head);
  const files: Record<string, string> = existsSync(head) ? { [rel]: readFileSync(head, 'utf8') } : {};
  if (existsSync(dir)) for (const name of readdirSync(dir).filter(name => !name.includes('.tmp.'))) files[name] = readFileSync(join(dir, name), 'utf8');
  return files;
};
const reassembled = (path: string): string => {
  const parsed = parseHead(readFileSync(path, 'utf8'));
  if (!parsed || 'error' in parsed) throw new Error(`${path} is not a split head`);
  const scratch = splitScratchPath();
  expect(reassemble(path, parsed, scratch)).toMatchObject({ ok: true });
  return readFileSync(scratch, 'utf8');
};
const commitsTouching = (root: string, ...rels: string[]) => git(root, 'log', '--format=%H', '--', ...rels).split('\n').filter(Boolean);

/** One put_page publication run by hand (the consumer stopped), so the test's hooks see each file boundary. */
async function publishByHand(engine: BrainEngine, ctx: OperationContext, slug: string, content: string, hooks: PublicationHooks) {
  await disposePersistenceConsumer(engine);
  const hostId = localHostId();
  const binding = (await getWorktreeBinding(engine, 'default', hostId))!;
  const current = await snapshotOf(engine, slug);
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, slug);
  const intent = { slug, content, expected_revision: current.revision };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug, pageId: current.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const claimed = (await claimNextWrite(engine, hostId))!;
  return publishMutation(engine, claimed, await preparePageMutation(engine, claimed, ctx.config), hostId, hooks);
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: recovery as one unit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { installFaultHook(undefined); __setSplitLimitsForTests(null); });

  test('a publication failing after the head, a part or the last part leaves every file and the page row as they were', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/unit', page(lines(0, 60)))).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    const before = unit(root, 'notes/unit.md');
    const revision = (await snapshotOf(engine, 'notes/unit')).revision;
    const next = page([...lines(0, 2), ...lines(2, 70, 'second')]);
    let fileCount = 0;
    for (const at of ['head', 'part', 'last'] as const) {
      let crashed = -1;
      const done = await publishByHand(engine, ctx, 'notes/unit', next, {
        fileBoundary: (name, _row, index) => {
          if (name !== 'after_file' || crashed >= 0) return;
          fileCount = Math.max(fileCount, index + 1);
          const target = at === 'head' ? 0 : at === 'part' ? 1 : -1;
          if (index === target) { crashed = index; throw new Error('fixture failure after a file'); }
        },
        ...(at === 'last' ? { boundary: async (name: string) => {
          if (name === 'after_publication') { crashed = fileCount - 1; throw new Error('fixture failure after the last file'); }
        } } : {}),
      } as PublicationHooks);
      expect(crashed).toBeGreaterThanOrEqual(0);
      expect(done.state).toBe('failed');
      expect(unit(root, 'notes/unit.md')).toEqual(before);
      expect((await snapshotOf(engine, 'notes/unit')).revision).toBe(revision);
      expect(git(root, 'status', '--porcelain')).toBe('');
    }
    expect(fileCount).toBeGreaterThan(4);
    expect((await publishByHand(engine, ctx, 'notes/unit', next, {})).state).toBe('committed');
    expect(reassembled(join(root, 'notes/unit.md'))).toContain(lines(69, 70, 'second')[0]);
  }, { databaseUrl, setup }), 180_000);

  test('strict, interrupted after the door commit: every file is kept and the replay completes against that commit', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    await strict(engine);
    const first = await put(ctx, 'notes/kept', page(lines(0, 60)));
    expect(first).toMatchObject({ state: 'committed' });
    const requestId = randomUUID();
    let crash = '';
    installFaultHook(async (point, detail) => {
      if (point === 'publication:before_commit' && detail.requestId === requestId && !crash) { crash = git(root, 'rev-parse', 'HEAD').trim(); throw interruption('CONNECTION_CLOSED'); }
    });
    expect(await put(ctx, 'notes/kept', page(lines(0, 70, 'second')), first.revision, requestId)).toMatchObject({ state: 'committed' });
    expect(crash).not.toBe('');
    const committed = unit(root, 'notes/kept.md');
    expect(Object.keys(committed).length).toBeGreaterThan(4);
    for (const [name, bytes] of Object.entries(committed)) {
      expect(git(root, 'show', `${crash}:${name === 'notes/kept.md' ? name : `notes/.kept.gbparts/${name}`}`)).toBe(bytes);
    }
    expect(commitsTouching(root, 'notes/kept.md', 'notes/.kept.gbparts')).toHaveLength(2);
    expect(commitsTouching(root, 'notes/kept.md', 'notes/.kept.gbparts')[0]).toBe(crash);
    expect(git(root, 'status', '--porcelain')).toBe('');
    const [done] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(done!.outcome.persistence).toMatchObject({ git_commit: crash });
    expect((await snapshotOf(engine, 'notes/kept')).page.compiled_truth).toContain(lines(69, 70, 'second')[0]);
  }, { databaseUrl, setup }), 120_000);

  test('strict, interrupted before the door commit: every file is restored and the replay commits once', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    await strict(engine);
    const first = await put(ctx, 'notes/restored', page(lines(0, 60)));
    expect(first).toMatchObject({ state: 'committed' });
    const before = unit(root, 'notes/restored.md');
    const requestId = randomUUID();
    let thrown = 0;
    let seen: Record<string, string> | undefined;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'publication:after_publication' && !thrown) { thrown++; throw interruption('CONNECTION_CLOSED'); }
      if (point === 'publication:prepared' && thrown && !seen) seen = unit(root, 'notes/restored.md');
    });
    expect(await put(ctx, 'notes/restored', page(lines(0, 70, 'second')), first.revision, requestId)).toMatchObject({ state: 'committed' });
    expect(thrown).toBe(1);
    expect(seen).toEqual(before);
    expect(commitsTouching(root, 'notes/restored.md', 'notes/.restored.gbparts')).toHaveLength(2);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(reassembled(join(root, 'notes/restored.md'))).toContain(lines(69, 70, 'second')[0]);
  }, { databaseUrl, setup }), 120_000);

  test('a write whose file is a part file of a split page is refused and writes nothing', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    expect(await put(ctx, 'notes/owner', page(lines(0, 60)))).toMatchObject({ state: 'committed' });
    const first = await put(ctx, 'notes/stray', page(['A page whose recorded file is a part file.']));
    expect(first).toMatchObject({ state: 'committed' });
    const stray = join(partsDirFor(join(root, 'notes/owner.md')), 'stray.md');
    writeFileSync(stray, readFileSync(join(root, 'notes/stray.md')));
    const before = unit(root, 'notes/owner.md');
    await engine.executeRaw("UPDATE pages SET source_path='notes/.owner.gbparts/stray.md' WHERE source_id='default' AND slug='notes/stray'");
    const refused = await put(ctx, 'notes/stray', page(['Rewritten.']), first.revision).then(receipt => receipt, (error: unknown) => error) as Record<string, any>;
    expect(refused).toMatchObject({ code: 'source_changed', message: 'The canonical file target is inside a split page parts directory.' });
    expect(refused.writeRequest).toMatchObject({ state: 'conflict' });
    expect(unit(root, 'notes/owner.md')).toEqual(before);
  }, { databaseUrl, setup }), 120_000);

  test('the request guard accepts a page_split record on a page request and refuses a skill bundle record there', () => managedBrain(async ({ engine, ctx }) => {
    expect(await put(ctx, 'notes/guarded', page(lines(0, 3)))).toMatchObject({ state: 'committed' });
    await disposePersistenceConsumer(engine);
    const hostId = localHostId();
    const binding = (await getWorktreeBinding(engine, 'default', hostId))!;
    const current = await snapshotOf(engine, 'notes/guarded');
    const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, 'notes/guarded');
    const intent = { slug: 'notes/guarded', content: page(lines(0, 4)), expected_revision: current.revision };
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
      slug: 'notes/guarded', pageId: current.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const row = (await claimNextWrite(engine, hostId))!;
    const base = { version: 2 as const, root: binding.local_path!, ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token!, files: [] };
    await expect(prepareRecovery(engine, row, { ...base, target: 'skill_bundle' } as never, 1)).rejects.toThrow(/recovery target mismatch/);
    await prepareRecovery(engine, row, { ...base, target: 'page_split' } as never, 1);
    const [saved] = await engine.executeRaw<{ recovery: Record<string, unknown> }>('SELECT recovery FROM persistence_requests WHERE id=$1::uuid', [row.id]);
    expect(saved!.recovery).toMatchObject({ version: 2, target: 'page_split' });
  }, { databaseUrl }), 120_000);
});
