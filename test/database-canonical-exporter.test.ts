/**
 * Database-canonical memory, wave 5a: the exporter (commit, privacy gate, push, integrate, fast-forward), its own batch
 * queue, the live import lane and the deactivation and graduation refusals, on real PGLite and Postgres with real Git
 * checkouts and a bare remote. Names and addresses are placeholders.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { DATABASE_CANONICAL_KEY } from '../src/core/persistence/canonical-export.ts';
import { lockExportWriters, writeSourceShadow } from '../src/core/persistence/canonical-shadow.ts';
import { claimExportBatch, readExportSource, transitionBatch, unparkBatch, writeExportSwitch, type ExportBound } from '../src/core/persistence/canonical-export-store.ts';
import { buildExportCommit, pushExportCommit } from '../src/core/persistence/export-core.ts';
import { runExportTick, type ExportTickOptions, type ExportTickResult } from '../src/core/persistence/exporter.ts';
import { installFaultHook, type ExportFaultStep } from '../src/core/persistence/fault-points.ts';
import { deactivationBlockers } from '../src/core/persistence/deactivation.ts';
import { graduationBlockers } from '../src/core/persistence/graduation-drain.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { parseExportArgs, retryExport, setExportCommits } from '../src/commands/sources-canonical-export.ts';
import { runOneShotExport } from '../src/core/persistence/export-runner.ts';

const ALICE = { name: 'Alice Example', email: 'alice@example.com' };
const env = (who = ALICE) => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
  GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
const tryGit = (dir: string, ...args: string[]): string | null => { try { return git(dir, ...args); } catch { return null; } };

for (const backend of testBackends()) describe(`database-canonical wave 5a exporter: ${backend}`, () => {
  let engine: BrainEngine;
  let home: string, root: string, remote: string, host: string, worktree: string;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    installFaultHook(undefined);
    for (const table of ['export_batch_entries', 'export_batches', 'canonical_export_sources', 'import_conflicts', 'import_foreign_writes', 'import_lane_passes',
      'export_ledger', 'export_outbox', 'database_canonical_sources', 'persistence_host_bindings', 'persistence_source_bindings', 'persistence_worktrees', 'pages']) {
      await engine.executeRaw(`DELETE FROM ${table}`);
    }
    home = realpathSync(mkdtempSync(join(tmpdir(), 'exporter-')));
    root = join(home, 'owner'); remote = join(home, 'remote.git');
    git(home, 'init', '-q', '--bare', '-b', 'main', remote);
    git(home, 'init', '-q', '-b', 'main', root);
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(root, 'README.md'), 'Notes\n');
    git(root, 'add', 'README.md'); git(root, 'commit', '-qm', 'Initial');
    git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
    host = randomUUID(); worktree = randomUUID();
    await engine.executeRaw('INSERT INTO persistence_worktrees(id, owner_host_id, owner_epoch) VALUES ($1::uuid, $2::uuid, 1)', [worktree, host]);
    await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id, source_incarnation, worktree_id) SELECT id, incarnation, $1::uuid FROM sources WHERE id='default'`, [worktree]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id, host_id, local_path, coordination_path) VALUES ($1::uuid, $2::uuid, $3, $4)', [worktree, host, root, join(home, 'coord')]);
    await engine.executeRaw("UPDATE sources SET local_path=$1, config='{}'::jsonb WHERE id='default'", [root]);
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
    await engine.transaction(async tx => { await lockExportWriters(tx); await writeSourceShadow(tx, 'default', true); });
    await engine.executeRaw("UPDATE database_canonical_sources SET mode='database', mode_epoch=1 WHERE source_id='default'");
    await engine.transaction(tx => writeExportSwitch(tx, 'default', true));
  });
  afterEach(() => { installFaultHook(undefined); rmSync(home, { recursive: true, force: true }); });

  const put = (slug: string, body: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: 'note', title: slug.split('/').pop()!, compiled_truth: body, timeline: '', frontmatter });
  const tick = (opts: ExportTickOptions = {}) => runExportTick(engine, 'default', { hostId: host, lockWaitMs: 5000, ...opts });
  /** A crashed owner's lease has expired and its backoff has run out (what time passing does in production). */
  const leaseExpired = () => engine.executeRaw("UPDATE export_batches SET claim_expires_at=now() - interval '1 second', next_attempt_at=now() WHERE state IN ('prepared','built','committed','pushed')");
  /** Ticks until the outbox and the queue are empty. */
  const drain = async (opts: ExportTickOptions = {}): Promise<ExportTickResult[]> => {
    const results: ExportTickResult[] = [];
    for (let i = 0; i < 12; i++) {
      await leaseExpired();
      const r = await tick(opts);
      results.push(r);
      if (r.status === 'idle') break;
    }
    return results;
  };
  const remoteFile = (path: string) => tryGit(remote, 'show', `main:${path}`);
  const remoteEverHad = (path: string) => git(remote, 'log', '--all', '--format=', '--name-only').split('\n').includes(path);
  const clean = () => {
    expect(git(root, 'diff-index', '--cached', 'HEAD')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe('');
  };
  const batches = () => engine.executeRaw<{ state: string; parked: boolean; error_code: string | null }>('SELECT state, parked_at IS NOT NULL AS parked, error_code FROM export_batches ORDER BY created_at');
  const otherClone = (name: string) => { const dir = join(home, name); git(home, 'clone', '-q', remote, dir); return dir; };
  const commitIn = (dir: string, path: string, content: string, message: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content);
    git(dir, 'add', path); git(dir, 'commit', '-qm', message);
  };

  test('a page write is committed and pushed, the ledger follows and the index stays clean', async () => {
    await put('notes/alpha', 'Alpha body.');
    const result = await tick();
    expect(result).toMatchObject({ status: 'exported', pushed: true, entries: 1, skipped: 0, checkout: 'current' });
    const file = readFileSync(join(root, 'notes/alpha.md'), 'utf8');
    expect(file).toContain('Alpha body.');
    expect(remoteFile('notes/alpha.md')).toBe(file.replace(/\n$/, ''));
    clean();
    expect(git(root, 'config', '--get', 'core.splitIndex')).toBe('true');
    const [ledger] = await engine.executeRaw<{ seeded_from: string; commit_sha: string }>("SELECT seeded_from, commit_sha FROM export_ledger WHERE retired_at IS NULL");
    expect(ledger!.seeded_from).toBe('export');
    expect(await batches()).toEqual([{ state: 'completed', parked: false, error_code: null }]);
    expect((await readExportSource(engine, 'default'))!.pushed_commit).toBe(git(remote, 'rev-parse', 'main'));
    expect((await engine.executeRaw('SELECT 1 FROM persistence_requests')).length + (await engine.executeRaw('SELECT 1 FROM persistence_effects')).length).toBe(0);
    expect(await tick()).toEqual({ status: 'idle' });
  });

  test('two clones race: no integrate_conflict, the edit is imported and AGENTS.md reaches the owner checkout', async () => {
    await put('notes/alpha', 'Alpha body.');
    await tick();
    const other = otherClone('other');
    commitIn(other, 'AGENTS.md', 'Agent rules\n', 'Add agent rules');
    const edited = readFileSync(join(other, 'notes/alpha.md'), 'utf8').replace('Alpha body.', 'Alpha edited elsewhere.');
    commitIn(other, 'notes/alpha.md', edited, 'Edit alpha');
    git(other, 'push', '-q', 'origin', 'main');
    await put('notes/beta', 'Beta body.');
    const result = await tick();
    expect(result).toMatchObject({ status: 'exported', pushed: true, checkout: 'current' });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('Agent rules\n');
    expect(remoteFile('notes/beta.md')).toContain('Beta body.');
    expect(remoteFile('AGENTS.md')).toBe('Agent rules');
    const [alpha] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/alpha'");
    expect(alpha!.compiled_truth).toContain('Alpha edited elsewhere.');
    expect(await engine.executeRaw("SELECT 1 FROM import_conflicts WHERE state='open'")).toEqual([]);
    clean();
    await drain();
    expect(remoteFile('notes/alpha.md')).toContain('Alpha edited elsewhere.');
    clean();
    expect((await batches()).every(b => b.state === 'completed')).toBe(true);
  });

  const STEPS: ExportFaultStep[] = ['prepared', 'built', 'files_written', 'index_updated', 'ref_updated', 'committed', 'before_push', 'pushed', 'fetched', 'laned', 'fast_forwarded'];

  for (const step of STEPS) test(`a crash at export:${step} finishes forward from the manifest`, async () => {
    if (['fetched', 'laned', 'fast_forwarded'].includes(step)) {
      const other = otherClone('other');
      commitIn(other, 'AGENTS.md', 'Agent rules\n', 'Add agent rules');
      git(other, 'push', '-q', 'origin', 'main');
    }
    await put('notes/crash', 'Crash body.');
    let fired = false;
    installFaultHook(point => { if (point === `export:${step}` && !fired) { fired = true; throw new Error(`simulated crash at ${step}`); } });
    await tick().catch(() => undefined);
    expect(fired).toBe(true);
    installFaultHook(undefined);
    await drain();
    expect(remoteFile('notes/crash.md')).toContain('Crash body.');
    expect(readFileSync(join(root, 'notes/crash.md'), 'utf8')).toContain('Crash body.');
    clean();
    expect((await batches()).map(b => b.state)).not.toContain('prepared');
    expect((await batches()).filter(b => b.state !== 'completed' && b.state !== 'abandoned')).toEqual([]);
    expect(await engine.executeRaw('SELECT 1 FROM export_ledger WHERE retired_at IS NULL')).toHaveLength(1);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
  });

  for (const step of ['prepared', 'built', 'files_written', 'index_updated', 'ref_updated', 'committed', 'before_push'] as ExportFaultStep[]) {
    test(`a page that turns private at export:${step} never reaches the remote`, async () => {
      await put('notes/public', 'Public body.');
      await put('notes/secret', 'Secret body.');
      installFaultHook(async point => {
        if (point !== `export:${step}`) return;
        installFaultHook(undefined);
        await put('notes/secret', 'Secret body.', { visibility: 'private' });
      });
      await drain();
      expect(remoteFile('notes/public.md')).toContain('Public body.');
      expect(remoteEverHad('notes/secret.md')).toBe(false);
      expect(existsSync(join(root, 'notes/secret.md'))).toBe(false);
      clean();
    });
  }

  test('fast-forward compare-and-set: a ref moved between the merge and the commit lock is never reset', async () => {
    await put('notes/alpha', 'Alpha body.');
    await tick();
    const other = otherClone('other');
    commitIn(other, 'AGENTS.md', 'Agent rules\n', 'Add agent rules');
    git(other, 'push', '-q', 'origin', 'main');
    await put('notes/beta', 'Beta body.');
    installFaultHook(point => {
      if (point !== 'export:laned') return;
      installFaultHook(undefined);
      commitIn(root, 'CLAUDE.md', 'Operator note\n', 'Operator note');
    });
    const operatorHead = () => git(root, 'log', '-1', '--format=%s');
    const result = await tick();
    expect(result).toMatchObject({ status: 'exported', pushed: true, checkout: 'lagging' });
    expect(operatorHead()).toBe('Operator note');
    expect((await readExportSource(engine, 'default'))!.checkout_state).toBe('lagging');
    expect(remoteFile('notes/beta.md')).toContain('Beta body.');
    expect(await tick({ fetchIdle: true })).toMatchObject({ status: 'idle', integrated: true, checkout: 'current' });
    expect(remoteFile('CLAUDE.md')).toBe('Operator note');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('Agent rules\n');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
    clean();
  });

  test('an operator commit of a non-page file during a batch is kept and published, without commit_lock_busy', async () => {
    await put('notes/alpha', 'Alpha body.');
    installFaultHook(point => {
      if (point !== 'export:built') return;
      installFaultHook(undefined);
      commitIn(root, 'AGENTS.md', 'Agent rules\n', 'Operator: agent rules');
    });
    expect(await tick()).toMatchObject({ status: 'exported', pushed: true, checkout: 'current' });
    expect(remoteFile('AGENTS.md')).toBe('Agent rules');
    expect(remoteFile('notes/alpha.md')).toContain('Alpha body.');
    clean();
  });

  test('an outside edit is handed to the live lane: imported when the database did not move, parked when both did', async () => {
    await put('notes/alpha', 'Alpha body.');
    await put('notes/beta', 'Beta body.');
    await tick();
    writeFileSync(join(root, 'notes/alpha.md'), readFileSync(join(root, 'notes/alpha.md'), 'utf8').replace('Alpha body.', 'Alpha edited in place.'));
    writeFileSync(join(root, 'notes/beta.md'), readFileSync(join(root, 'notes/beta.md'), 'utf8').replace('Beta body.', 'Beta edited in place.'));
    await put('notes/alpha', 'Alpha body.', { touched: 1 });
    await put('notes/beta', 'Beta changed in the database.');
    const result = await tick();
    expect(result).toMatchObject({ status: 'exported' });
    const conflicts = await engine.executeRaw<{ path: string; kind: string; mode: string }>("SELECT path, kind, mode FROM import_conflicts WHERE state='open' ORDER BY path");
    expect(conflicts.map(c => [c.path, c.kind, c.mode])).toContainEqual(['notes/beta.md', 'both_changed', 'live']);
    expect(readFileSync(join(root, 'notes/beta.md'), 'utf8')).toContain('Beta edited in place.');
    expect(remoteFile('notes/beta.md')).toContain('Beta body.');
    await put('notes/beta', 'Beta changed again.');
    const parked = await tick();
    expect(parked).toMatchObject({ status: 'exported', skipped: 1 });
    expect(readFileSync(join(root, 'notes/beta.md'), 'utf8')).toContain('Beta edited in place.');
  });

  test('a page under a filter driver is skipped and never written', async () => {
    commitIn(root, '.gitattributes', 'notes/filtered.md filter=example\n', 'attributes');
    git(root, 'push', '-q', 'origin', 'main');
    await put('notes/filtered', 'Filtered body.');
    await put('notes/plain', 'Plain body.');
    expect(await tick()).toMatchObject({ status: 'exported', entries: 1, skipped: 1 });
    expect(existsSync(join(root, 'notes/filtered.md'))).toBe(false);
    expect(remoteFile('notes/plain.md')).toContain('Plain body.');
  });

  test('owner transfer: the old owner can no longer move the batch and the new owner re-binds and finishes it', async () => {
    await put('notes/alpha', 'Alpha body.');
    installFaultHook(point => { if (point === 'export:built') throw new Error('crash'); });
    await tick().catch(() => undefined);
    installFaultHook(undefined);
    const [batch] = await engine.executeRaw<{ id: string; token: string }>("SELECT id::text, claim_token::text AS token FROM export_batches");
    const oldBound: ExportBound = { sourceId: 'default', hostId: host, token: batch!.token ?? randomUUID(), modeEpoch: 1, exportEpoch: 1, topologyGeneration: 1, ownerEpoch: 1 };
    const next = randomUUID();
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid, owner_epoch=2 WHERE id=$2::uuid', [next, worktree]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id, host_id, local_path, coordination_path) VALUES ($1::uuid, $2::uuid, $3, $4)', [worktree, next, root, join(home, 'coord2')]);
    const lost = await transitionBatch(engine, batch!.id, oldBound, ['prepared', 'built'], "state='built'").catch(e => e);
    expect(lost).toBeInstanceOf(OperationError);
    expect((lost as OperationError).code).toBe('write_claim_lost');
    await leaseExpired();
    expect(await tick()).toEqual({ status: 'skipped', reason: 'not_owner' });
    await leaseExpired();
    expect(await runExportTick(engine, 'default', { hostId: next })).toMatchObject({ status: 'exported', pushed: true });
    expect(remoteFile('notes/alpha.md')).toContain('Alpha body.');
    clean();
  });

  test('a batch that keeps failing parks after 8 attempts, shows its code, and --export-retry makes it claimable again', async () => {
    await put('notes/alpha', 'Alpha body.');
    git(root, 'remote', 'set-url', 'origin', join(home, 'missing.git'));
    let last: ExportTickResult | undefined;
    for (let i = 0; i < 8; i++) { await leaseExpired(); last = await tick(); }
    expect(last).toMatchObject({ status: 'failed', code: 'git_push_unavailable', parked: true });
    expect(await batches()).toEqual([{ state: 'committed', parked: true, error_code: 'git_push_unavailable' }]);
    await leaseExpired();
    expect(await tick()).toEqual({ status: 'skipped', reason: 'parked' });
    git(root, 'remote', 'set-url', 'origin', remote);
    const [batch] = await engine.executeRaw<{ id: string }>('SELECT id::text FROM export_batches');
    expect(await engine.transaction(tx => unparkBatch(tx, batch!.id))).toBe(true);
    expect(await tick()).toMatchObject({ status: 'exported', pushed: true });
  });

  test('deactivation and graduation drain refuse while an export batch is unfinished', async () => {
    await put('notes/alpha', 'Alpha body.');
    installFaultHook(point => { if (point === 'export:committed') throw new Error('crash'); });
    await tick().catch(() => undefined);
    installFaultHook(undefined);
    const deactivation = (await deactivationBlockers(engine)).filter(b => b.kind === 'export_batch');
    expect(deactivation).toHaveLength(1);
    expect(deactivation[0]!.exit).toContain('gbrain sync status --source default');
    const graduation = (await graduationBlockers(engine, host)).filter(b => b.kind === 'export_batch');
    expect(graduation).toHaveLength(1);
    expect(graduation[0]!.needsUser).toBe(false);
    await drain();
    expect((await deactivationBlockers(engine)).filter(b => b.kind === 'export_batch')).toEqual([]);
    expect((await graduationBlockers(engine, host)).filter(b => b.kind === 'export_batch')).toEqual([]);
  });

  test('the queue is the only claim: a second claim sees the held batch, and nothing enters the persistence journal', async () => {
    await put('notes/alpha', 'Alpha body.');
    installFaultHook(point => { if (point === 'export:built') throw new Error('crash'); });
    await tick().catch(() => undefined);
    installFaultHook(undefined);
    await engine.executeRaw("UPDATE export_batches SET next_attempt_at=now()");
    const held = await engine.executeRaw<{ token: string | null }>('SELECT claim_token::text AS token FROM export_batches');
    if (held[0]!.token) expect(await claimExportBatch(engine as never, 'default', host)).toMatchObject({ status: 'unavailable', reason: 'held' });
    expect(await engine.executeRaw('SELECT 1 FROM persistence_effects')).toEqual([]);
  });

  test('the bare-repository core builds and pushes a commit without a worktree', async () => {
    const bare = join(home, 'mirror.git');
    git(home, 'clone', '-q', '--bare', remote, bare);
    const parent = git(bare, 'rev-parse', 'main');
    const blob = execFileSync('git', ['-C', bare, 'hash-object', '-w', '--no-filters', '--stdin'], { input: 'Bare body\n', env: env() }).toString().trim();
    const built = await buildExportCommit(bare, { parent, entries: [{ path: 'notes/bare.md', blob }], message: 'gbrain: export 1 page(s) from default\n' });
    expect(await pushExportCommit(bare, 'origin', built.commit, 'refs/heads/main')).toEqual({ status: 'pushed' });
    expect(remoteFile('notes/bare.md')).toBe('Bare body');
  });

  const refusal = async (p: Promise<unknown>) => { const e = await p.catch(err => err); expect(e).toBeInstanceOf(OperationError); return (e as OperationError).code; };

  test('--export-commits is preview-bound: a dry run names the refusals and a fingerprint, a moved epoch refuses preview_changed', async () => {
    const args = (target: string, extra: string[] = []) => ({ ...parseExportArgs(['default', '--export-commits', target, ...extra]), hostId: host });
    const offPreview = await setExportCommits(engine, args('off', ['--dry-run']));
    expect(offPreview).toMatchObject({ current: 'on', target: 'off', changed: true, refusals: [], split_index: 'will_set' });
    expect(offPreview.apply).toEqual(['gbrain', 'sources', 'canonical', 'default', '--export-commits', 'off', '--admin-intent', 'source_canonical', '--expected-state', offPreview.fingerprint]);
    await engine.transaction(tx => writeExportSwitch(tx, 'default', true));
    expect(await refusal(setExportCommits(engine, args('off', ['--admin-intent', 'source_canonical', '--expected-state', offPreview.fingerprint])))).toBe('preview_changed');
    const again = await setExportCommits(engine, args('off', ['--dry-run']));
    expect(await setExportCommits(engine, args('off', ['--admin-intent', 'source_canonical', '--expected-state', again.fingerprint]))).toMatchObject({ current: 'off', changed: true });
    expect((await readExportSource(engine, 'default'))!.export_commits).toBe(false);
    await put('notes/alpha', 'Alpha body.');
    expect(await tick()).toEqual({ status: 'skipped', reason: 'export_off' });
    await engine.executeRaw("UPDATE database_canonical_sources SET mode='files', mode_epoch=2 WHERE source_id='default'");
    const files = await setExportCommits(engine, args('on', ['--dry-run']));
    expect(files.refusals.map(r => r.code)).toEqual(['export_commits_requires_database_mode']);
    expect(await refusal(setExportCommits(engine, args('on', ['--admin-intent', 'source_canonical', '--expected-state', files.fingerprint])))).toBe('export_commits_requires_database_mode');
    await engine.executeRaw("UPDATE database_canonical_sources SET mode='database', mode_epoch=3 WHERE source_id='default'");
    const on = await setExportCommits(engine, args('on', ['--dry-run']));
    expect(on.refusals).toEqual([]);
    await setExportCommits(engine, args('on', ['--admin-intent', 'source_canonical', '--expected-state', on.fingerprint]));
    expect(await tick()).toMatchObject({ status: 'exported', pushed: true });
    await engine.unsetConfig(DATABASE_CANONICAL_KEY);
    expect(await refusal(setExportCommits(engine, args('off', ['--dry-run'])))).toBe('database_canonical_disabled');
    expect(await refusal(Promise.resolve().then(() => parseExportArgs(['default', '--export-commits', 'on'])))).toBe('invalid_params');
  });

  test('--export-retry refuses with nothing parked and unparks a parked batch bound to its preview', async () => {
    const args = (extra: string[]) => ({ ...parseExportArgs(['default', '--export-retry', ...extra]), hostId: host });
    expect(await refusal(retryExport(engine, args(['--dry-run'])))).toBe('export_retry_nothing_parked');
    await put('notes/alpha', 'Alpha body.');
    git(root, 'remote', 'set-url', 'origin', join(home, 'missing.git'));
    for (let i = 0; i < 8; i++) { await leaseExpired(); await tick(); }
    const preview = await retryExport(engine, args(['--dry-run']));
    expect(preview.batch).toMatchObject({ state: 'committed', error_code: 'git_push_unavailable' });
    expect(await refusal(retryExport(engine, args(['--admin-intent', 'source_canonical', '--expected-state', 'stale'])))).toBe('preview_changed');
    git(root, 'remote', 'set-url', 'origin', remote);
    expect(await retryExport(engine, args(['--admin-intent', 'source_canonical', '--expected-state', preview.fingerprint!]))).toMatchObject({ retried: true });
    expect(await tick()).toMatchObject({ status: 'exported', pushed: true });
  });

  test('the PGLite one-shot attempt records a typed outcome, never a stall', async () => {
    if (backend !== 'pglite') return;
    git(root, 'remote', 'remove', 'origin');
    await put('notes/alpha', 'Alpha body.');
    await runOneShotExport(engine, host);
    expect((await readExportSource(engine, 'default'))!.oneshot_outcome).toBe('skipped_no_remote');
    expect(git(root, 'log', '-1', '--format=%s')).toContain('gbrain: export 1 page(s) from default');
    await put('notes/beta', 'Beta body.');
    await runOneShotExport(engine, randomUUID());
    expect((await readExportSource(engine, 'default'))!.oneshot_outcome).toBe('skipped_not_owner');
    await engine.executeRaw('UPDATE persistence_host_bindings SET local_path=$1', [join(home, 'gone')]);
    await runOneShotExport(engine, host);
    expect((await readExportSource(engine, 'default'))!.oneshot_outcome).toBe('skipped_no_checkout');
  });

  test('an operator commit of a page file in the owner checkout is imported before the idle tick pushes it', async () => {
    await put('notes/alpha', 'Alpha body.');
    await tick();
    commitIn(root, 'notes/alpha.md', readFileSync(join(root, 'notes/alpha.md'), 'utf8').replace('Alpha body.', 'Alpha committed by hand.'), 'Hand edit');
    expect(await tick({ fetchIdle: true })).toMatchObject({ status: 'idle', integrated: true, checkout: 'current' });
    const [alpha] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/alpha'");
    expect(alpha!.compiled_truth).toContain('Alpha committed by hand.');
    expect(remoteFile('notes/alpha.md')).toContain('Alpha committed by hand.');
    await drain();
    expect(remoteFile('notes/alpha.md')).toContain('Alpha committed by hand.');
    clean();
  });
});
