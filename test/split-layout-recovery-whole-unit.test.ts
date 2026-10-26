/**
 * Wave B PR 5 lane 5b, round 6: recovery of a strict split publication never overwrites a change made after its door
 * commit. persistence/split-files.ts splitLandedCommit searches every commit after the record's door head that touches
 * the head or anything under its parts directory (the whole unit in HEAD, not only the record's paths), and compares raw
 * bytes (rawBlobOid), never a clean-filtered hash-object.
 *
 * 1. Protects: a head-only write's door commit lands, then a person commits a change to a part the write kept, or adds
 *    a file to the parts directory, and the publication is interrupted. Recovery refuses (the request stays recovering,
 *    blocked unexpected_file_bytes for a person) and leaves every file as it is, so no replay commits over the change.
 *    A commit whose part blobs are Git's clean-filtered bytes (a text eol=lf rule renormalized CRLF parts) is not the
 *    door's: it is refused recovery_required even though hash-object of the disk matches it.
 * 2. Fails when: the candidate is the newest commit touching the record's paths only, so the kept part's later commit is
 *    missed, the door commit counts as landed and the replay reverts the human change; or the disk is hashed through
 *    the clean filter, so a converted commit counts as landed.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { __setSplitLimitsForTests, partsDirFor } from '../src/core/split-layout/index.ts';
import { publishMutation, recoverPublication, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { splitLandedCommit } from '../src/core/persistence/split-files.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe';
const page = (version: string, eol = '\n') => '---\ntype: note\ntitle: Example\n---\n\n' + Array.from({ length: 40 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the ${version} synthetic acme-example version, long enough to fill a part.`).join(eol) + '\n';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const snapshot = (engine: BrainEngine) => engine.readPageSnapshot(SLUG, { sourceId: 'default' });
const interruption = () => Object.assign(new Error('Synthetic database interruption'), { code: 'CONNECTION_CLOSED' });
afterEach(() => __setSplitLimitsForTests(null));

function unit(root: string) {
  const head = join(root, `${SLUG}.md`), dir = partsDirFor(head);
  return { head: existsSync(head) ? sha(readFileSync(head)) : null, parts: existsSync(dir) ? Object.fromEntries(readdirSync(dir).filter(n => !n.includes('.tmp.')).sort().map(n => [n, sha(readFileSync(join(dir, n)))])) : {} };
}

async function strictSplitPage(engine: BrainEngine, ctx: OperationContext) {
  __setSplitLimitsForTests(LIMITS);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
  await operations.find(op => op.name === 'put_page')!.handler(ctx, { slug: SLUG, content: page('first'), request_id: randomUUID(), wait_ms: 30_000 });
  await settleManagedGitEffects(engine);
}

/** One put_page publication driven by hand, so a boundary hook can act between its door commit and its row commit. */
async function publish(engine: BrainEngine, ctx: OperationContext, content: string, hooks: PublicationHooks) {
  await disposePersistenceConsumer(engine);
  const host = localHostId(), binding = (await getWorktreeBinding(engine, 'default', host))!, old = (await snapshot(engine))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, SLUG);
  const intent = { slug: SLUG, content, expected_revision: old.revision };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug: SLUG, pageId: old.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, host))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, ctx.config), host, hooks);
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: recovery searches the whole unit and never overwrites a later change`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const change of ['a committed edit to a kept part', 'a committed extra file in the parts directory'] as const) {
    test(`a head-only write interrupted after its door commit, then ${change}: recovery blocks for a person and leaves every file`, () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSplitPage(engine, ctx);
      const dir = partsDirFor(join(root, `${SLUG}.md`));
      const part = join(dir, readdirSync(dir).sort()[1]!), published = readFileSync(part);
      let foreignHead = '', left: ReturnType<typeof unit> | null = null;
      const result = await publish(engine, ctx, page('first').replace('title: Example', 'title: Retitled'), { boundary: async name => {
        if (name !== 'before_commit') return;
        if (change === 'a committed edit to a kept part') {
          writeFileSync(part, Buffer.concat([published, Buffer.from('HUMAN COMMITTED PART CHANGE\n')]));
          git(root, 'add', part); git(root, 'commit', '-qm', 'Synthetic foreign kept-part commit');
          writeFileSync(part, published);
        } else {
          const extra = join(dir, '9999-deadbeef.gbpart');
          writeFileSync(extra, 'HUMAN EXTRA\n'); git(root, 'add', extra); git(root, 'commit', '-qm', 'Synthetic foreign extra part');
        }
        foreignHead = git(root, 'rev-parse', 'HEAD').trim();
        left = unit(root);
        throw interruption();
      } });
      expect(result.state).toBe('recovering');
      expect(result.blocked_reason).toBe('unexpected_file_bytes');
      expect(unit(root)).toEqual(left!);
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(foreignHead);
      const again = await recoverPublication(engine, result.id, localHostId());
      expect({ state: again.state, blocked: again.blocked_reason }).toEqual({ state: 'recovering', blocked: 'unexpected_file_bytes' });
      expect(unit(root)).toEqual(left!);
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(foreignHead);
      if (change === 'a committed edit to a kept part') expect(git(root, 'show', `HEAD:${part.slice(root.length + 1)}`)).toContain('HUMAN COMMITTED PART CHANGE');
    }, { databaseUrl, setup }), 120_000);
  }

  test('a commit holding clean-filtered part bytes is not the door commit (raw bytes, not hash-object)', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await operations.find(op => op.name === 'put_page')!.handler(ctx, { slug: SLUG, content: page('first', '\r\n'), request_id: randomUUID(), wait_ms: 30_000 });
    await settleManagedGitEffects(engine);
    const head = join(root, `${SLUG}.md`), dir = partsDirFor(head);
    const files = [head, ...readdirSync(dir).sort().map(n => join(dir, n))].map(path => ({ path, afterHash: sha(readFileSync(path)) }));
    expect(readFileSync(files[1]!.path, 'utf8')).toContain('\r\n');
    const before = git(root, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(root, '.gitattributes'), '*.gbpart text eol=lf\n');
    git(root, 'add', '.gitattributes'); git(root, 'add', '--renormalize', 'notes'); git(root, 'commit', '-qm', 'Synthetic renormalized parts');
    expect(sha(git(root, 'show', `HEAD:${files[1]!.path.slice(root.length + 1)}`))).not.toBe(files[1]!.afterHash);
    const disk = unit(root);
    expect(await splitLandedCommit(root, before, files).then(commit => ({ commit }), error => ({ code: error.code }))).toEqual({ code: 'recovery_required' });
    expect(unit(root)).toEqual(disk);
  }, { databaseUrl, setup }), 120_000);
});
