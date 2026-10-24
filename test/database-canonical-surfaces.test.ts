/**
 * Database-canonical memory, wave 5b: the status surfaces (gbrain sync status, get_brain_health bands) and the
 * gbrain sources refresh refusal, on real PGLite and Postgres. Names are placeholders.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { DATABASE_CANONICAL_KEY } from '../src/core/persistence/canonical-export.ts';
import { lockExportWriters, writeSourceShadow } from '../src/core/persistence/canonical-shadow.ts';
import { writeExportSwitch } from '../src/core/persistence/canonical-export-store.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { readDatabaseCanonicalStatus, formatCanonicalStatus } from '../src/core/persistence/canonical-status.ts';
import { readBrainHealthBands } from '../src/commands/doctor/brain-health-bands.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import { runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { assertWorktreeNotExportOwned } from '../src/core/persistence/canonical-export-store.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { randomUUID } from 'node:crypto';
import { CANONICAL_PROTOCOL_DECLARATION } from '../src/core/persistence/canonical-mode.ts';

for (const backend of testBackends()) describe(`database-canonical wave 5b surfaces: ${backend}`, () => {
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-surfaces-')));
    for (const table of ['export_batch_entries', 'export_batches', 'canonical_export_sources', 'import_conflicts', 'export_ledger', 'export_outbox', 'database_canonical_sources',
      'persistence_host_bindings', 'persistence_source_bindings', 'persistence_worktrees', 'pages']) {
      await engine.executeRaw(`DELETE FROM ${table}`);
    }
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const databaseMode = async (sourceId: string) => {
    await engine.transaction(async tx => { await lockExportWriters(tx); await writeSourceShadow(tx, sourceId, true); });
    await engine.executeRaw("UPDATE database_canonical_sources SET mode='database', mode_epoch=1 WHERE source_id=$1", [sourceId]);
    await engine.transaction(tx => writeExportSwitch(tx, sourceId, true));
  };
  /** A page write as a canonical-protocol writer makes it (wave 4's fence refuses an undeclared write to a database-mode source). */
  const put = (slug: string, title: string) => engine.transaction(async tx => {
    await tx.executeRaw(`SELECT ${CANONICAL_PROTOCOL_DECLARATION}`);
    return (tx as BrainEngine).putPage(slug, { type: 'note', title, compiled_truth: `${title}.`, timeline: '' }, { sourceId: 'default' });
  });
  const captured = async (run: () => Promise<unknown>): Promise<string> => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try { await run(); } finally { log.mockRestore(); }
    return lines.join('\n');
  };

  test('sync status carries the database-canonical block: lag, coverage, a parked batch with its retry command, conflicts', async () => {
    expect(await readDatabaseCanonicalStatus(engine)).toEqual([]);
    await databaseMode('default');
    await put('notes/alpha-example', 'Alpha');
    await engine.executeRaw("UPDATE export_outbox SET first_enqueued_at=now() - interval '400 seconds' WHERE source_id='default'");
    await engine.executeRaw(`INSERT INTO export_batches(source_id, source_incarnation, mode_epoch, export_epoch, eligibility_generation, state, attempts, parked_at, error_code)
      SELECT id, incarnation, 1, 1, 0, 'committed', 8, now(), 'export_push_contended' FROM sources WHERE id='default'`);
    await engine.executeRaw(`INSERT INTO import_conflicts(source_id, path, path_folded, mode, outcome, kind, shadow_epoch) VALUES ('default', 'notes/b.md', 'notes/b.md', 'live', 'conflict', 'both_changed', 1)`);
    const [status] = await readDatabaseCanonicalStatus(engine, { sourceIds: ['default'] });
    expect(status!.mode).toBe('database');
    expect(status!.export_commits).toBe(true);
    expect(status!.export_pending).toBe(1);
    expect(status!.export_lag_seconds).toBeGreaterThanOrEqual(400);
    expect(status!.coverage.eligible).toBe(1);
    expect(status!.batch).toMatchObject({ state: 'committed', error_code: 'export_push_contended', retry: ['gbrain', 'sources', 'canonical', 'default', '--export-retry', '--dry-run'] });
    expect(status!.conflicts).toEqual([expect.objectContaining({ kind: 'both_changed', count: 1 })]);
    expect(status!.parked_paths_read).toEqual({ status: 'not_read', fix: ['gbrain', 'sync', 'status', '--source', 'default', '--detail', '--json'] });
    const text = formatCanonicalStatus(status!).join('\n');
    expect(text).toContain('PARKED');
    expect(text).toContain('gbrain sources canonical default --export-retry --dry-run');
    const json = JSON.parse(await captured(() => runSyncStatus(engine, ['--source', 'default', '--json']))) as { database_canonical: { batch: { retry: string[] } } };
    expect(json.database_canonical.batch.retry).toEqual(['gbrain', 'sources', 'canonical', 'default', '--export-retry', '--dry-run']);
  });

  test('get_brain_health bands the database-canonical state for the caller\'s sources, with no slugs or exact counts', async () => {
    const t = Date.now() + 1000 * 60_000;
    const quiet = await readBrainHealthBands(engine, { sourceIds: ['default'] }, t);
    expect(quiet.database_canonical).toEqual({ sources: 'none', export_behind: 'none', export_stalled: 'none', open_conflicts: 'none' });
    await databaseMode('default');
    await put('notes/beta-example', 'Beta');
    await engine.executeRaw("UPDATE export_outbox SET first_enqueued_at=now() - interval '4000 seconds' WHERE source_id='default'");
    await engine.executeRaw(`INSERT INTO import_conflicts(source_id, path, path_folded, mode, outcome, kind, shadow_epoch) VALUES ('default', 'notes/beta-example.md', 'notes/beta-example.md', 'live', 'conflict', 'both_changed', 1)`);
    const bands = await readBrainHealthBands(engine, { sourceIds: ['default'] }, t + 2 * 60_000);
    expect(bands.database_canonical).toEqual({ sources: '1-9', export_behind: '1-9', export_stalled: '1-9', open_conflicts: '1-9' });
    expect(bands.status).toBe('attention');
    expect(JSON.stringify(bands)).not.toContain('beta-example');
    const other = await readBrainHealthBands(engine, { sourceIds: ['other-source'] }, t + 2 * 60_000);
    expect(other.database_canonical.sources).toBe('none');
  });

  test('gbrain sources refresh refuses source_export_owned for a database-mode source before anything else, and is unchanged for files mode', async () => {
    const worktree = randomUUID();
    await engine.executeRaw('INSERT INTO persistence_worktrees(id, owner_host_id, owner_epoch) VALUES ($1::uuid, $2::uuid, 1)', [worktree, randomUUID()]);
    await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id, source_incarnation, worktree_id) SELECT id, incarnation, $1::uuid FROM sources WHERE id='default'`, [worktree]);
    await assertWorktreeNotExportOwned(engine, 'default');
    const filesMode = await captured(() => runSourcesRefresh(engine, ['default', '--json']));
    expect(filesMode).not.toContain('source_export_owned');
    await databaseMode('default');
    let code = '';
    try { await assertWorktreeNotExportOwned(engine, 'default'); } catch (error) { code = error instanceof OperationError ? error.code : String(error); }
    expect(code).toBe('source_export_owned');
    const refused = await captured(() => runSourcesRefresh(engine, ['default', '--json']));
    expect(refused).toContain('source_export_owned');
    expect(refused).toContain('gbrain');
  });
});
