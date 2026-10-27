import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests, parseHead, verifyParts, type ParsedHead } from '../src/core/split-layout/index.ts';
import { publishMutation, recoverPublication, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { doorSeams } from '../src/core/persistence/git-door.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { assertSplitUnitMutable } from '../src/core/persistence/split-unit-guard.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { writeSplitPage } from './helpers/split-page.ts';

// Round 8 of the split layout (R2-R6): each case exercises the real failure path on both engines.
const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe', HEAD = SLUG + '.md', DIR = 'notes/.probe.gbparts';
const page = (title = 'First', eol = '\n') => '---\ntype: note\ntitle: ' + title + '\n---\n\n' + Array.from({ length: 50 }, (_, i) => 'Line ' + i + ': original synthetic material filling this test page with enough data for part files.').join(eol) + '\n';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, content: string) => operations.find(x => x.name === 'put_page')!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<any>;
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const refusal = (work: Promise<unknown>) => work.then(() => null, error => ({ code: error.code, reason: error.reason }));
const mismatchedParts = (root: string) => {
  const parsed = parseHead(git(root, 'show', 'HEAD:' + HEAD)) as ParsedHead;
  return parsed.manifest.parts.filter(p => sha(Buffer.from(git(root, 'show', 'HEAD:notes/' + p.path), 'utf8')) !== p.sha256).map(p => p.path);
};
afterEach(() => { __setSplitLimitsForTests(null); doorSeams.beforeUpdateRef = undefined; });

async function committedSplit(engine: BrainEngine, ctx: OperationContext, eol = '\n') {
  __setSplitLimitsForTests(LIMITS);
  await engine.executeRaw("UPDATE sources SET config=config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
  expect(await put(ctx, page('First', eol))).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
}

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

for (const backend of testBackends()) describe('[' + backend + '] split layout round 8', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('R2: a checkout-conversion rule committed during the publication fails the door commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const before = git(root, 'rev-parse', 'HEAD:' + HEAD).trim();
    let rule = '';
    const result = await publish(engine, ctx, page('Second'), { boundary: async name => {
      if (name !== 'after_publication') return;
      writeFileSync(join(root, '.gitattributes'), '*.gbpart text eol=crlf\n');
      git(root, 'add', '.gitattributes');
      git(root, 'commit', '--only', '-qm', 'Concurrent checkout conversion rule', '--', '.gitattributes');
      rule = git(root, 'rev-parse', 'HEAD').trim();
    } });
    git(root, 'checkout-index', '--force', '--all');
    const parsed = parseHead(git(root, 'show', 'HEAD:' + HEAD)) as ParsedHead;
    const verified = verifyParts(join(root, HEAD), parsed);
    console.log('R8_ATTRIBUTE_RACE', JSON.stringify({ backend, state: result.state, code: result.error_code, headIsRule: git(root, 'rev-parse', 'HEAD').trim() === rule, verified: verified.ok }));
    expect(result.error_code).toBe('git_target_changed');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(rule);
    expect(git(root, 'rev-parse', 'HEAD:' + HEAD).trim()).toBe(before);
    expect(verified).toMatchObject({ ok: true });
  }, { databaseUrl, setup }), 120_000);

  test('R3: a file symlink to a live part is refused before any write follows it', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const part = join(root, DIR, readdirSync(join(root, DIR))[0]!);
    const alias = join(root, 'attachment.bin'), before = sha(readFileSync(part));
    symlinkSync(part, alias);
    const guard = await refusal(assertSplitUnitMutable({ root, path: alias, route: 'raw_writer', strict: false }));
    const writer = await refusal(new LocalStorage(root).upload('attachment.bin', Buffer.from('OVERWRITTEN THROUGH FILE ALIAS\n')));
    console.log('R8_FILE_ALIAS', JSON.stringify({ backend, guard, writer, preserved: sha(readFileSync(part)) === before }));
    expect(guard).toEqual({ code: 'split_page_unsupported', reason: 'outside_door' });
    expect(writer).toEqual({ code: 'split_page_unsupported', reason: 'outside_door' });
    expect(sha(readFileSync(part))).toBe(before);
  }, { databaseUrl, setup }), 120_000);

  test('R4: commit-push takes back a commit whose pre-commit hook changed a part', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const start = git(root, 'rev-parse', 'HEAD').trim();
    const part = DIR + '/' + readdirSync(join(root, DIR))[0]!;
    const head = join(root, HEAD);
    writeFileSync(head, readFileSync(head, 'utf8').replace('title: First', 'title: Retitled'));
    const hooks = join(root, '.git', 'round8-hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), "#!/bin/sh\nprintf 'HOOK CHANGED PART\\n' >> '" + part + "'\ngit add -- '" + part + "'\n");
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(root, 'config', 'core.hooksPath', hooks);
    let error: any = null;
    try { commitAndPush({ repo: root, cwd: root, paths: [HEAD, DIR], message: 'Retitle a whole unit' }); }
    catch (e: any) { error = { code: e.code, reason: e.reason }; }
    console.log('R8_HOOK_COMMIT', JSON.stringify({ backend, error, headMoved: git(root, 'rev-parse', 'HEAD').trim() !== start, mismatchedGitParts: mismatchedParts(root) }));
    expect(error).toEqual({ code: 'split_page_unsupported', reason: 'outside_door' });
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(start);
    expect(mismatchedParts(root)).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('R4: a secret override does not let a converting attribute commit parts that differ from the manifest', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx, '\r\n');
    const start = git(root, 'rev-parse', 'HEAD').trim();
    rmSync(join(root, DIR), { recursive: true });
    await writeSplitPage(root, HEAD, page('Retitled', '\r\n').replaceAll('original', 'revised'));
    writeFileSync(join(root, '.gitattributes'), '*.gbpart text eol=lf\n');
    let error: any = null;
    try { commitAndPush({ repo: root, cwd: root, paths: [HEAD, DIR], message: 'Whole verified unit with filter', allowSecret: true }); }
    catch (e: any) { error = { code: e.code, reason: e.reason }; }
    console.log('R8_OVERRIDE_COMMIT', JSON.stringify({ backend, error, headMoved: git(root, 'rev-parse', 'HEAD').trim() !== start, mismatchedGitParts: mismatchedParts(root) }));
    expect(error).toEqual({ code: 'split_page_unsupported', reason: 'outside_door' });
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(start);
    expect(mismatchedParts(root)).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('R5: a landed split-to-plain publication recovers after its door commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    const result = await publish(engine, ctx, '---\ntype: note\ntitle: Small\n---\nSmall body.\n', { boundary: async name => {
      if (name !== 'before_commit') return;
      throw Object.assign(new Error('Synthetic interruption after door'), { code: 'CONNECTION_CLOSED' });
    } });
    let recovered: any = null, error: any = null;
    try { recovered = await recoverPublication(engine, result.id, localHostId()); }
    catch (e: any) { error = { code: e.code, reason: e.reason }; }
    console.log('R8_PLAIN_RECOVERY', JSON.stringify({ backend, state: result.state, recoveryError: error, recoveredState: recovered?.state, recordCleared: recovered?.recovery === null,
      gitHasSmall: git(root, 'show', 'HEAD:' + HEAD).includes('Small body.'), partsInHead: git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', DIR).trim() }));
    expect(error).toBeNull();
    expect(recovered?.recovery).toBeNull();
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', DIR).trim()).toBe('');
    const replay = (await claimNextWrite(engine, localHostId()))!;
    expect(replay.id).toBe(result.id);
    expect(await publishMutation(engine, replay, await preparePageMutation(engine, replay, ctx.config), localHostId())).toMatchObject({ state: 'committed' });
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.title).toBe('Small');
  }, { databaseUrl, setup }), 120_000);

  test('R6: under core.ignorecase, exactDirs refuses a case-variant parts directory committed during the write', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedSplit(engine, ctx);
    git(root, 'config', 'core.ignorecase', 'true');
    const extra = 'notes/.PROBE.gbparts/9999-deadbeef.gbpart';
    let foreign = '';
    doorSeams.beforeUpdateRef = (_root, attempt) => {
      if (attempt) return;
      mkdirSync(join(root, extra, '..'), { recursive: true });
      writeFileSync(join(root, extra), 'CONCURRENT EXTRA\n');
      git(root, '-c', 'core.ignorecase=false', 'add', '--', extra);
      git(root, 'commit', '-qm', 'Concurrent case-variant entry');
      foreign = git(root, 'rev-parse', 'HEAD').trim();
    };
    const result = await publish(engine, ctx, page('Second'));
    console.log('R8_EXACT_DIR_CASE', JSON.stringify({ backend, state: result.state, code: result.error_code, headStayedForeign: git(root, 'rev-parse', 'HEAD').trim() === foreign }));
    expect(result.error_code).toBe('git_target_changed');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(foreign);
  }, { databaseUrl, setup }), 120_000);

  test('R6: discovery folds case under core.ignorecase and only then', () => managedBrain(async ({ root }) => {
    const variant = 'notes/.PROBE.gbparts/0001-deadbeef.gbpart';
    mkdirSync(join(root, variant, '..'), { recursive: true });
    writeFileSync(join(root, variant), 'part bytes\n');
    git(root, '-c', 'core.ignorecase=false', 'add', '--', variant);
    git(root, 'commit', '-qm', 'A case-variant parts directory');
    rmSync(join(root, 'notes', '.PROBE.gbparts'), { recursive: true });
    const target = join(root, 'notes', 'probe.md');
    git(root, 'config', 'core.ignorecase', 'false');
    const sensitive = await refusal(assertSplitUnitMutable({ root, path: target, route: 'raw_writer', strict: false }));
    git(root, 'config', 'core.ignorecase', 'true');
    const folded = await refusal(assertSplitUnitMutable({ root, path: target, route: 'raw_writer', strict: false }));
    console.log('R8_DISCOVERY_CASE', JSON.stringify({ backend, sensitive, folded }));
    expect(sensitive).toBeNull();
    expect(folded).toEqual({ code: 'split_page_unsupported', reason: 'outside_door' });
  }, { databaseUrl, setup }), 120_000);
});
