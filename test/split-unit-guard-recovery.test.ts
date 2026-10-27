/**
 * Wave B PR 5 (option B), C1: gbrain repair stuck-recovery runs the split-unit predicate (route recovery) before it
 * restores a record's prior bytes, so a legacy record that is not the strict door's own cannot replace a split head.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { __setSplitLimitsForTests } from '../src/core/split-layout/index.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { recoverPublication } from '../src/core/persistence/coordinator.ts';
import { admitWrite, claimNextWrite, prepareRecovery } from '../src/core/persistence/journal.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveStuckRecovery, scanStuckRecoveries } from '../src/core/persistence/recovery-resolve.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/example';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
afterEach(() => __setSplitLimitsForTests(null));

for (const backend of testBackends()) describe(`[${backend}] stuck-recovery resolution of a foreign record over a split unit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('stuck-recovery resolution cannot restore a non-door record over a split head', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.executeRaw(`UPDATE sources SET config=config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    const content = '---\ntype: note\ntitle: Split\n---\n' + 'Synthetic body paragraph for the split page.\n'.repeat(150);
    expect(await operations.find(x => x.name === 'put_page')!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    await disposePersistenceConsumer(engine);
    const host = localHostId(), binding = (await getWorktreeBinding(engine, 'default', host))!;
    const old = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
    const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, SLUG);
    const intent = { slug: SLUG, content: 'Failed old write', expected_revision: old.revision };
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
      slug: SLUG, pageId: old.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const row = (await claimNextWrite(engine, host))!, head = join(root, SLUG + '.md');
    const before = readFileSync(head, 'utf8'), legacy = '---\ntitle: Legacy prior\n---\nOld single file.\n';
    const lock = await acquireWorktree(binding);
    try {
      await prepareRecovery(engine, row, { version: 1, path: head, root, before: Buffer.from(legacy).toString('base64'),
        beforeHash: sha(legacy), afterHash: sha('Failed old write'), mode: 0o644, ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token! }, 4096);
    } finally { await lock?.release(); }
    const blocked = await recoverPublication(engine, row.id, host);
    const scan = await scanStuckRecoveries(engine, ['default'], { requestId: row.request_id });
    let result: unknown = null, error: unknown = null;
    if (scan.items[0]) {
      try { result = await resolveStuckRecovery(engine, scan.items[0], { keep: 'prior', previewHash: scan.items[0].digest, hostId: host }); }
      catch (caught: any) { error = { code: caught.code, reason: caught.reason }; }
    }
    expect(blocked.blocked_reason).toBe('unexpected_file_bytes');
    expect(scan.items).toHaveLength(1);
    expect({ result, error }).toEqual({ result: null, error: { code: 'split_page_unsupported', reason: 'recovery_unit_changed' } });
    expect(readFileSync(head, 'utf8')).toBe(before);
    expect(git(root, 'show', `HEAD:${SLUG}.md`)).toContain('gbrain_parts:');
  }, { databaseUrl, setup }), 120_000);
});
