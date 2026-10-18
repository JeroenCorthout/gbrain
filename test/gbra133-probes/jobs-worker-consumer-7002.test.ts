/**
 * GBRA-133 lane D probe for #7002: on a managed Postgres brain, an idle
 * `gbrain jobs work` never starts a persistence consumer (src/commands/jobs/work.ts:250-254
 * calls worker.start() only), so a request admitted while no consumer runs stays
 * queued until something else starts one. Desired behavior (red on master c8354664):
 * the idle worker publishes it. The control arm proves the same request is drainable
 * by a `gbrain serve --http` subprocess.
 *
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test GBRAIN_TEST_ALLOW_DATABASE_URL=1 \
 *   bun test --timeout=300000 test/gbra133-probes/jobs-worker-consumer-7002.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { maintenancePreflight, publishMaintenancePage } from '../../src/core/persistence/prepared-maintenance.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from '../e2e/helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

const REPO = join(import.meta.dir, '..', '..');
const home = mkdtempSync(join(tmpdir(), 'gbra133-7002-'));
let engine: BrainEngine;
let close: (() => Promise<void>) | undefined;
const PROVIDER_KEYS = /(ANTHROPIC|OPENAI|GEMINI|GOOGLE|VOYAGE|TYPESAFE)_API_KEY|^GBRAIN_(DATABASE_URL|DIRECT_DATABASE_URL)$|^DATABASE_URL$/;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_KEYS.test(k)) env[k] = v;
  for (const k of ['GBRAIN_TEST_ALLOW_DATABASE_URL', 'GBRAIN_SOURCE', 'CLAUDECODE', 'CODEX_HOME']) delete env[k];
  Object.assign(env, { HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1', GBRAIN_NO_RETRY_CONNECT: '1', GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'gbra133-7002-token-0123456789abcdef' });
  return env;
}
function freePort(): Promise<number> {
  return new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
}

beforeAll(async () => {
  if (!hasDatabase()) return;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 8);
  engine = pg.engine; close = pg.close;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: pg.databaseUrl, embedding_disabled: true }));
}, 180_000);
afterAll(async () => {
  __setMaintenanceWriteWaitForTests(null);
  if (engine) await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
  resetWriteSwitches(); resetGateway();
  await close?.();
  rmSync(home, { recursive: true, force: true });
});

/** Admits one managed write while this process's consumer cannot publish it, then stops that consumer: a queued request with no consumer anywhere. */
async function strandedRequest(): Promise<{ sourceId: string; slug: string }> {
  const root = join(home, `brain-${randomUUID().slice(0, 8)}`); mkdirSync(root);
  const sourceId = `p7002-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await engine.setConfig('sync.write_through', 'true');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  __setMaintenanceWriteWaitForTests(300);
  const authority = (await maintenancePreflight(engine, sourceId))!;
  const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
  const slug = 'wiki/stranded';
  try {
    await publishMaintenancePage(engine, authority, slug, '---\ntitle: Stranded\ntype: note\n---\nStranded body.', { expectedRevision: null }).catch(() => undefined);
    await disposePersistenceConsumer(engine);
  } finally { await lock.release(); }
  return { sourceId, slug };
}
const state = async (sourceId: string, slug: string) =>
  (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]?.state;
async function pollCommitted(sourceId: string, slug: string, ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  let last: string | undefined;
  while (Date.now() < deadline) { last = await state(sourceId, slug); if (last === 'committed') return last; await Bun.sleep(500); }
  return last;
}
async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(20_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
}

describe.skipIf(!hasDatabase())('#7002 idle jobs worker on managed Postgres', () => {
  for (const single of [false, true]) {
    test(`persistence.single_consumer=${single}: an idle gbrain jobs work publishes a stranded request within 30 s`, () => withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('persistence.single_consumer', String(single)); resetWriteSwitches();
      const { sourceId, slug } = await strandedRequest();
      expect(await state(sourceId, slug)).not.toBe('committed');
      const worker = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), 'jobs', 'work'], { cwd: REPO, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });
      let observed: string | undefined;
      try { observed = await pollCommitted(sourceId, slug, 30_000); }
      finally { await stop(worker); }
      console.log(`[gbra133 #7002] single_consumer=${single} idle worker, request state after 30 s: ${observed}`);
      if (observed !== 'committed') {
        const port = await freePort();
        const serve = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), 'serve', '--http', '--port', String(port)], { cwd: REPO, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });
        const started = Date.now();
        let control: string | undefined;
        try { control = await pollCommitted(sourceId, slug, 60_000); }
        finally { await stop(serve); }
        console.log(`[gbra133 #7002] control: serve --http drained it: ${control} after ${Date.now() - started} ms`);
      }
      expect(observed).toBe('committed');
    }), 180_000);
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    test(`single_consumer=true: after serve stops (${signal}) the idle worker takes over a stranded request`, () => withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('persistence.single_consumer', 'true'); resetWriteSwitches();
      const port = await freePort();
      const serve = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), 'serve', '--http', '--port', String(port)], { cwd: REPO, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !(await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_consumers WHERE pid=$1 AND kind='serve'", [serve.pid]))[0]?.n) await Bun.sleep(250);
      const worker = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), 'jobs', 'work'], { cwd: REPO, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });
      try {
        await Bun.sleep(8_000);
        const rows = await engine.executeRaw<{ kind: string; mode: string }>('SELECT kind,mode FROM persistence_consumers ORDER BY kind');
        console.log(`[gbra133 #7002] before stop: consumer rows ${JSON.stringify(rows)}`);
        serve.kill(signal); await serve.exited;
        const { sourceId, slug } = await strandedRequest();
        const started = Date.now();
        const observed = await pollCommitted(sourceId, slug, 90_000);
        console.log(`[gbra133 #7002] serve ${signal}: worker took over: ${observed} after ${Date.now() - started} ms`);
        if (observed !== 'committed') {
          console.log('[gbra133 #7002] rows after:', JSON.stringify(await engine.executeRaw('SELECT kind,mode,pid,now()-renewed_at AS age FROM persistence_consumers')));
          console.log('[gbra133 #7002] request:', JSON.stringify(await engine.executeRaw('SELECT state,blocked_reason,error_code,retry_after FROM persistence_requests WHERE source_id=$1', [sourceId]).catch(e => String(e))));
          worker.kill('SIGTERM'); console.log('[gbra133 #7002] worker stderr:', (await new Response(worker.stderr).text()).slice(-3000));
          console.log('[gbra133 #7002] serve stderr:', (await new Response(serve.stderr).text()).slice(-2000));
        }
        expect(observed).toBe('committed');
      } finally { await stop(worker); if (serve.exitCode === null) await stop(serve); }
    }), 240_000);
  }
  test('idle worker cost: backend connections and statements over 30 s, with and without the boot consumer', () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.setConfig('persistence.single_consumer', 'false'); resetWriteSwitches();
    const [{ db }] = await engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
    for (const off of ['1', '0', 'serve']) {
      const [{ t0 }] = await engine.executeRaw<{ t0: string }>('SELECT now()::text AS t0');
      const [{ calls: c0 }] = await engine.executeRaw<{ calls: number }>("SELECT COALESCE(sum(xact_commit + xact_rollback),0)::bigint AS calls FROM pg_stat_database WHERE datname=$1", [db]);
      const argv = off === 'serve' ? ['serve', '--http', '--port', String(await freePort())] : ['jobs', 'work'];
      const worker = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), ...argv], { cwd: REPO, env: { ...childEnv(), GBRA133_NO_BOOT_CONSUMER: off }, stdout: 'pipe', stderr: 'pipe' });
      try {
        await Bun.sleep(10_000);
        const [{ calls: c1 }] = await engine.executeRaw<{ calls: number }>("SELECT COALESCE(sum(xact_commit + xact_rollback),0)::bigint AS calls FROM pg_stat_database WHERE datname=$1", [db]);
        await Bun.sleep(30_000);
        const live = await engine.executeRaw<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND backend_start > $2::timestamptz GROUP BY state', [db, t0]);
        const during = live.reduce((sum, row) => sum + row.n, 0);
        const [{ calls: c2 }] = await engine.executeRaw<{ calls: number }>("SELECT COALESCE(sum(xact_commit + xact_rollback),0)::bigint AS calls FROM pg_stat_database WHERE datname=$1", [db]);
        console.log(`[gbra133 #7002] ${off === 'serve' ? 'serve --http (reference)' : off === '1' ? 'jobs work, boot consumer OFF (master)' : 'jobs work, boot consumer ON (prototype)'}: worker backends=${during} ${JSON.stringify(live)}, transactions in steady 30 s=${Number(c2) - Number(c1)} (boot window ${Number(c1) - Number(c0)})`);
      } finally { await stop(worker); }
      await Bun.sleep(2_000);
    }
  }), 240_000);
});
