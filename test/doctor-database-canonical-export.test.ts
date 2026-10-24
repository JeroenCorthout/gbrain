/**
 * Database-canonical memory, wave 5b: the doctor checks database_canonical_backup, export_lag and import_conflicts, green,
 * yellow and red, and the mode-aware git_convergence, on real PGLite and Postgres. Names are placeholders.
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
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { BACKUP_ATTESTATION_KEY, databaseCanonicalBackupEntry, exportLagEntry, importConflictsEntry } from '../src/commands/doctor/checks/database-canonical-export.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { OPS_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { __setBackupStatusPathForTests } from '../src/core/backup/status-file.ts';

const HOUR = 3_600_000;
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } }).toString().trim();
}

for (const backend of testBackends()) describe(`database-canonical wave 5b doctor: ${backend}`, () => {
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-doctor-')));
    __setBackupStatusPathForTests(join(home, 'no-backup-status.json'));
    for (const table of ['export_batch_entries', 'export_batches', 'canonical_export_sources', 'import_conflicts', 'export_ledger', 'export_outbox', 'database_canonical_sources']) {
      await engine.executeRaw(`DELETE FROM ${table}`);
    }
    await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
    await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
    await engine.executeRaw('DELETE FROM config WHERE key=$1', [BACKUP_ATTESTATION_KEY]);
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
  });
  afterEach(() => { __setBackupStatusPathForTests(null); rmSync(home, { recursive: true, force: true }); });

  const ctx = () => ({ engine }) as unknown as DoctorContext;
  const databaseMode = async (sourceId: string, exportCommits: boolean) => {
    await engine.transaction(async tx => { await lockExportWriters(tx); await writeSourceShadow(tx, sourceId, true); });
    await engine.executeRaw("UPDATE database_canonical_sources SET mode='database', mode_epoch=1 WHERE source_id=$1", [sourceId]);
    if (exportCommits) await engine.transaction(tx => writeExportSwitch(tx, sourceId, true));
  };
  const enqueuedSecondsAgo = (seconds: number) => engine.executeRaw(`INSERT INTO export_outbox(source_id, page_id, slug, revision, cause, first_enqueued_at)
    VALUES ('default', 1, 'notes/lag-example', NULL, 'written', now() - make_interval(secs => $1))`, [seconds]);

  test('registered as ops checks and green while no source is in database mode', async () => {
    for (const name of ['database_canonical_backup', 'export_lag', 'import_conflicts']) {
      expect(DOCTOR_CHECK_REGISTRY.some(entry => entry.emits.includes(name))).toBe(true);
      expect(OPS_CHECK_NAMES.has(name)).toBe(true);
    }
    for (const entry of [databaseCanonicalBackupEntry, exportLagEntry, importConflictsEntry]) {
      const [check] = await entry.run(ctx()) as unknown as Array<{ status: string; details: { database_sources: number } }>;
      expect(check!.status).toBe('ok');
      expect(check!.details.database_sources).toBe(0);
    }
  });

  test('database_canonical_backup: red without evidence, yellow on an expired attestation, green on a valid one', async () => {
    await databaseMode('default', false);
    const run = async () => (await databaseCanonicalBackupEntry.run(ctx()) as unknown as Array<{ status: string; message: string }>)[0]!;
    expect((await run()).status).toBe('fail');
    expect((await run()).message).toContain('gbrain backup check');
    await engine.setConfig(BACKUP_ATTESTATION_KEY, JSON.stringify({ kind: 'pitr', provider: 'provider-a', expires_at: new Date(Date.now() - HOUR).toISOString() }));
    expect((await run()).status).toBe('warn');
    await engine.setConfig(BACKUP_ATTESTATION_KEY, JSON.stringify({ kind: 'pitr', provider: 'provider-a', expires_at: new Date(Date.now() + 24 * HOUR).toISOString() }));
    expect((await run()).status).toBe('ok');
  });

  test('export_lag: yellow above 300 s, red above 3600 s, red for a parked batch with its retry command', async () => {
    await databaseMode('default', true);
    const run = async () => (await exportLagEntry.run(ctx()) as unknown as Array<{ status: string; message: string }>)[0]!;
    expect((await run()).status).toBe('ok');
    await enqueuedSecondsAgo(400);
    expect((await run()).status).toBe('warn');
    await engine.executeRaw("UPDATE export_outbox SET first_enqueued_at=now() - interval '4000 seconds'");
    const stalled = await run();
    expect(stalled.status).toBe('fail');
    expect(stalled.message).toContain('gbrain sync status --source default');
    await engine.executeRaw('DELETE FROM export_outbox');
    await engine.executeRaw(`INSERT INTO export_batches(source_id, source_incarnation, mode_epoch, export_epoch, eligibility_generation, state, attempts, parked_at, error_code)
      SELECT id, incarnation, 1, 1, 0, 'committed', 8, now(), 'export_push_contended' FROM sources WHERE id='default'`);
    const parked = await run();
    expect(parked.status).toBe('fail');
    expect(parked.message).toContain('export_push_contended');
    expect(parked.message).toContain('gbrain sources canonical default --export-retry --dry-run');
  });

  test('export_lag on PGLite: a typed one-shot skip is yellow with its reason, never red', async () => {
    if (backend !== 'pglite') return;
    await databaseMode('default', true);
    await enqueuedSecondsAgo(4000);
    await engine.executeRaw("UPDATE canonical_export_sources SET oneshot_outcome='skipped_no_remote', oneshot_at=now() WHERE source_id='default'");
    const [check] = await exportLagEntry.run(ctx()) as unknown as Array<{ status: string; message: string }>;
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('skipped_no_remote');
  });

  test('import_conflicts: yellow with kind, age and the list command while a live conflict is open', async () => {
    await databaseMode('default', true);
    await engine.executeRaw(`INSERT INTO import_conflicts(source_id, path, path_folded, mode, outcome, kind, shadow_epoch) VALUES ('default', 'notes/a.md', 'notes/a.md', 'live', 'conflict', 'both_changed', 1)`);
    const [check] = await importConflictsEntry.run(ctx()) as unknown as Array<{ status: string; message: string }>;
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('both_changed');
    expect(check!.message).toContain('gbrain sources conflicts default list');
  });

  test('git_convergence: a database-mode checkout diverged with export commits off is not a finding; with them on it names sync status, never a git push', async () => {
    const bare = join(home, 'remote.git'), work = join(home, 'work'), other = join(home, 'other');
    git(home, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(home, ['clone', '-q', bare, work]);
    for (const [k, v] of [['user.email', 'writer@example.invalid'], ['user.name', 'Example Writer']]) git(work, ['config', k!, v!]);
    writeFileSync(join(work, 'note.md'), 'first\n');
    git(work, ['add', 'note.md']); git(work, ['commit', '-qm', 'first']); git(work, ['push', '-q', 'origin', 'HEAD:main']);
    git(work, ['branch', '--set-upstream-to', 'origin/main']);
    git(home, ['clone', '-q', bare, other]);
    for (const [k, v] of [['user.email', 'writer@example.invalid'], ['user.name', 'Example Writer']]) git(other, ['config', k!, v!]);
    writeFileSync(join(other, 'remote.md'), 'remote\n');
    git(other, ['add', 'remote.md']); git(other, ['commit', '-qm', 'remote']); git(other, ['push', '-q', 'origin', 'HEAD:main']);
    git(work, ['fetch', '-q']);
    const date = new Date(Date.now() - 48 * HOUR).toISOString();
    writeFileSync(join(work, 'local.md'), 'local\n');
    git(work, ['add', 'local.md']); git(work, ['commit', '-qm', 'local'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [work]);

    const filesMode = await gitConvergenceCheck(engine);
    expect(filesMode!.status).not.toBe('ok');
    expect(filesMode!.message).toContain('Commit and push them');

    await databaseMode('default', false);
    const exportOff = await gitConvergenceCheck(engine);
    expect(exportOff!.status).toBe('ok');

    await engine.transaction(tx => writeExportSwitch(tx, 'default', true));
    const exportOn = await gitConvergenceCheck(engine);
    expect(exportOn!.status).not.toBe('ok');
    expect(exportOn!.message).toContain('gbrain sync status --source default');
    expect(exportOn!.message).not.toContain('Commit and push them');
    expect(JSON.stringify(exportOn)).not.toContain('commit-push');
  });
});
