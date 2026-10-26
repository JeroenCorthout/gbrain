/**
 * Wave B PR 5 lane 5b: a page target published with an exact mode (`publishMode`, the 0600 Google pages) keeps that
 * mode across the split layout (persistence/split-files.ts, coordinator.ts).
 *
 * 1. Protects: every part file of a split page with `publishMode` is staged and published with that mode from its first
 *    byte, as its head is, and the `.<name>.gbparts` directory is created 0700, as the head's own created directories are.
 * 2. Fails when: a part, its staging file or the parts directory takes the process umask's default mode instead.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. POSIX only (file modes). KB-sized split limits through
 *    __setSplitLimitsForTests; the publication is driven through publishMutation, as the Google connector's is.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setSplitLimitsForTests, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const mode = (path: string) => lstatSync(path).mode & 0o7777;
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the private split page body, long enough to fill a part.`).join('\n');
const content = `---\ntype: note\ntitle: Private example\n---\n\n${body}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const page = (text: string) => ({ type: 'note' as const, title: 'Private example', compiled_truth: text, timeline: '', frontmatter: {} });

for (const backend of testBackends()) describe.skipIf(process.platform === 'win32')(`[${backend}] split git layout: an exact publish mode covers every part`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  test('a split page with publishMode 0600 stages and publishes the head and every part 0600 in a 0700 parts directory', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    const slug = 'mail/2026/thread';
    expect(await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug, content: '---\ntype: note\ntitle: Private example\n---\n\nBefore.\n', request_id: randomUUID(), wait_ms: 30_000 }))
      .toMatchObject({ state: 'committed' });
    await disposePersistenceConsumer(engine);
    const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, slug);
    const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
      callerIntent: { content: 'fixture' }, intent: { content: 'fixture' }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const row = (await claimNextWrite(engine, localHostId()))!;
    expect(row.id).toBe(admitted.id);
    const path = join(root, `${slug}.md`);
    const dir = partsDirFor(path);
    const staged: number[] = [];
    const done = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path, root, content, publishMode: 0o600 },
      apply: async tx => { await tx.putPage(slug, page(body), { sourceId: 'default' }); return {}; } }, localHostId(), {
      fileBoundary: (name, _row, index) => {
        if (name !== 'staging_flushed' || index === 0) return;
        for (const entry of readdirSync(dir)) if (entry.includes('.tmp.')) staged.push(mode(join(dir, entry)));
      } });
    expect(done.state).toBe('committed');
    const parts = readdirSync(dir);
    expect(parts.length).toBeGreaterThan(2);
    expect(staged.length).toBeGreaterThan(0);
    expect({ head: mode(path), parts: parts.map(part => mode(join(dir, part))), staged: [...new Set(staged)], gbparts: mode(dir) })
      .toEqual({ head: 0o600, parts: parts.map(() => 0o600), staged: [0o600], gbparts: 0o700 });
  }, { databaseUrl, setup }), 120_000);
});
