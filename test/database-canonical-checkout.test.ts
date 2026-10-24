/**
 * Database-canonical wave 4: a database-mode source's checkout belongs to the exporter. `gbrain git commit-push` refuses
 * its page paths and still commits every other file under the commit lock; a refresh of its worktree and a managed sync
 * refuse; writer status marks the checkout instead of reporting its dirt. Real PGLite and real Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { refreshManagedFilesystemRoots } from '../src/core/persistence/filesystem-guard.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };
const codeOf = async (run: () => unknown) => { try { await run(); } catch (error) { return (error as { code?: string }).code; } return 'no refusal'; };
/** Database mode set directly: these tests are about the checkout, not the flip's emptiness test. */
async function toDatabase(f: RefreshFixture, sourceId: string) {
  await f.engine.executeRaw(`INSERT INTO database_canonical_sources(source_id,source_incarnation,shadow,shadow_epoch,mode,mode_epoch)
    SELECT id,incarnation,true,1,'database',1 FROM sources WHERE id=$1`, [sourceId]);
  await refreshManagedFilesystemRoots(f.engine);
}

test('commit-push refuses only the page paths of a database-mode source; its other files and the files-mode source commit under the lock', () => each(async f => {
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(f.root, 'beta/agent.md'), page('Agent', 'Written by an agent script.'));
  writeFileSync(join(f.root, 'beta/notes.txt'), 'operator notes\n');
  writeFileSync(join(f.root, 'AGENTS.md'), '# Agents\n');
  writeFileSync(join(f.root, 'alpha/agent.md'), page('Alpha agent', 'A files-mode page.'));
  // Files mode first: the page path commits as before.
  expect(commitAndPush({ repo: f.root, cwd: f.root, paths: ['beta/agent.md'], message: 'files mode' })).toMatchObject({ outcome: 'committed_local' });
  writeFileSync(join(f.root, 'beta/agent.md'), page('Agent', 'Edited after the flip.'));
  await toDatabase(f, f.beta);
  const before = f.head();
  expect(await codeOf(() => commitAndPush({ repo: f.root, cwd: f.root, paths: ['beta/agent.md'], message: 'database mode page' }))).toBe('source_database_mode');
  expect(await codeOf(() => commitAndPush({ repo: f.root, cwd: f.root, paths: ['AGENTS.md', 'beta/agent.md'], message: 'mixed' }))).toBe('source_database_mode');
  expect(f.head()).toBe(before);
  for (const path of ['AGENTS.md', 'beta/notes.txt', 'alpha/agent.md']) {
    expect(commitAndPush({ repo: f.root, cwd: f.root, paths: [path], message: `operator: ${path}` })).toMatchObject({ outcome: 'committed_local', paths: [path] });
  }
  expect(git(f.root, 'status', '--porcelain', '--', 'beta/agent.md').trim()).toBe('M beta/agent.md');
}), 120_000);

test('a refresh of the shared worktree and a managed sync of the database-mode source refuse; writer status marks its checkout', () => each(async f => {
  await toDatabase(f, f.beta);
  expect(await codeOf(() => refreshWorktree(f.engine, f.beta, { dryRun: true }))).toBe('source_database_mode');
  expect(await codeOf(() => refreshWorktree(f.engine, f.alpha, { dryRun: true }))).toBe('source_database_mode');
  expect(await codeOf(() => performManagedSync(f.engine, { sourceId: f.beta, noPull: true, noEmbed: true }))).toBe('source_database_mode');
  writeFileSync(join(f.root, 'beta/scratch.md'), page('Scratch', 'Uncommitted.'));
  const status = await runPersistenceAdministration(f.engine, 'writer_status', {}) as { checkouts: Array<Record<string, unknown>> };
  // alpha and beta share one checkout, so it is not the exporter's alone and keeps the ordinary report.
  expect(status.checkouts).toHaveLength(1);
  expect(status.checkouts[0]!.database_mode).toBeUndefined();
  await toDatabase(f, f.alpha);
  const both = await runPersistenceAdministration(f.engine, 'writer_status', {}) as { checkouts: Array<Record<string, unknown>> };
  expect(both.checkouts[0]).toMatchObject({ database_mode: true, note: 'database mode: checkout owned by the exporter' });
}), 120_000);
