/**
 * Database-canonical wave 4: the canonical-protocol declaration is transaction-local (`set_config(..., true)`), so a
 * transaction-mode pooler never hands it to another client. Declared and undeclared transactions run interleaved over
 * one engine's pool against a source in database mode: every declared write commits, every undeclared one is refused
 * `canonical_protocol_required`, and no autocommit statement sees the setting.
 *
 * Listed in scripts/e2e-backend-matrix.txt: run once on direct Postgres and once through transaction-mode PgBouncer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { CANONICAL_PROTOCOL_DECLARATION, canonicalFenceRefusal } from '../../src/core/persistence/canonical-mode.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const target = process.env.DATABASE_URL;
const pooled = process.env.GBRAIN_TEST_BACKEND === 'pgbouncer';
const adminUrl = pooled ? process.env.GBRAIN_PGBOUNCER_DIRECT_URL : target;
const available = Boolean(target && adminUrl);
const describeDb = available ? describe : describe.skip;

let database = '';
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine | undefined;
const withDatabase = (url: string) => { const u = new URL(url); u.pathname = `/${database}`; return u.toString(); };

beforeAll(async () => {
  if (!available) return;
  assertSafeE2eDatabaseUrl(adminUrl!);
  database = `gbrain_test_canonical_fence_${randomUUID().replaceAll('-', '')}`;
  admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const setup = new PostgresEngine();
  await setup.connect({ database_url: withDatabase(adminUrl!), poolSize: 2 });
  await setup.initSchema();
  await setup.executeRaw("INSERT INTO sources(id,name) VALUES ('source-a','source-a')");
  await setup.executeRaw(`INSERT INTO database_canonical_sources(source_id,source_incarnation,shadow,shadow_epoch,mode,mode_epoch)
    SELECT id,incarnation,true,1,'database',1 FROM sources WHERE id='source-a'`);
  await setup.disconnect();
  engine = new PostgresEngine();
  await engine.connect({ database_url: withDatabase(target!), poolSize: 4 });
}, 120_000);
afterAll(async () => {
  await engine?.disconnect();
  if (admin && database) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin?.end();
});

describeDb('database-canonical fence through the pool', () => {
  test('declared transactions commit, interleaved undeclared ones are refused, and no statement inherits the declaration', async () => {
    const write = (slug: string, declare: boolean) => engine!.transaction(async tx => {
      await tx.executeRaw(`SELECT set_config('gbrain.write_sources', '["source-a"]', true)${declare ? `,${CANONICAL_PROTOCOL_DECLARATION}` : ''}`);
      await tx.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline) VALUES ('source-a',$1,'note',$1,'Body.','')", [slug]);
    }).then(() => 'committed', error => canonicalFenceRefusal(error)?.code ?? String(error));
    const rounds = Array.from({ length: 24 }, (_, i) => i);
    const results = await Promise.all(rounds.map(i => write(`notes/n-${i}`, i % 2 === 0)));
    expect(results).toEqual(rounds.map(i => i % 2 === 0 ? 'committed' : 'canonical_protocol_required'));
    const seen = await Promise.all(rounds.map(() => engine!.executeRaw<{ v: string | null }>("SELECT current_setting('gbrain.canonical_protocol', true) AS v")));
    expect(seen.map(rows => rows[0]!.v ?? '')).toEqual(rounds.map(() => ''));
    const [count] = await engine!.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='source-a'");
    expect(Number(count!.n)).toBe(12);
  }, 60_000);
});
