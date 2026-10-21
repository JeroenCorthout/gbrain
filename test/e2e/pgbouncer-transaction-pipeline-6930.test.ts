/**
 * #6930: behind a transaction-mode PgBouncer, the statements one transaction issues together are pipelined again.
 *
 * #6543 turned pipelining off on a transaction-mode pooler URL (`?prepare=false` or port 6543) because statements
 * pipelined across a transaction boundary went to the wrong server connection. That also cost every transaction one
 * round trip per statement, though the pooler pins one server connection from BEGIN until the transaction ends: a
 * one-file managed commit took 354-500 dependent round trips behind PgBouncer against about 230 direct. The driver
 * now pipelines on a connection its owner holds while every statement in flight leaves it inside a transaction, and
 * never sends anything behind a statement that may end one.
 *
 * Each case reads the socket trace (GBRAIN_SQL_TRACE): a statement sent before the previous one's answer arrived was
 * pipelined, a client decision rather than a timing. Safety: every statement of a pipelined transaction runs in that
 * transaction on one backend; a failure inside one rolls it back; autocommit statements and anything after COMMIT
 * still wait; prepared statements stay off.
 *
 * Runs when the CI PgBouncer fixture is configured (GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL), against a
 * database of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { readSqlTrace, type StatementRecord } from '../helpers/statement-counter.ts';
import { withEnv } from '../helpers/with-env.ts';

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledAdmin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !(pooled && pooledAdmin)) throw new Error('The transaction pipeline PgBouncer test requires the configured CI PgBouncer fixture.');
const database = `gbrain_test_txn_pipeline_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const pooledUrl = (query: string) => { const url = new URL(pooled!); url.pathname = `/${database}`; url.search = query; return url.toString(); };
const dir = mkdtempSync(join(tmpdir(), 'gbrain-6930-pgbouncer-'));
const trace = join(dir, 'trace.jsonl');

beforeAll(async () => {
  if (!(pooled && pooledAdmin)) return;
  assertSafeE2eDatabaseUrl(pooledAdmin);
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
}, 60_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (!(pooled && pooledAdmin)) return;
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
});

/** Runs `run` on a traced pooled engine and returns the trace records it produced, in send order. */
async function traced(label: string, poolSize: number, run: (engine: PostgresEngine) => Promise<void>, env: Record<string, string | undefined> = {}): Promise<StatementRecord[]> {
  const url = pooledUrl('?prepare=false');
  assertSafeE2eDatabaseUrl(url);
  await withEnv({ PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, GBRAIN_DISABLE_DIRECT_POOL: '1', GBRAIN_PG_TXN_PIPELINE: undefined,
    GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: label, ...env }, async () => {
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize });
    try { await run(engine); } finally { await engine.disconnect(); }
  });
  await Bun.sleep(1200);
  return readSqlTrace(trace).filter(r => (r as { label?: string }).label === label && r.kind !== 'connect').sort((a, b) => a.t - b.t);
}
const end = (r: StatementRecord) => r.t + (r.ms ?? 0);
/** For each record matching `re` after the first on its connection: was it sent before the previous one there was answered? */
const sentBeforeAnswer = (records: StatementRecord[], re: RegExp, limit = Infinity) => {
  const last = new Map<number, StatementRecord>();
  const out: boolean[] = [];
  for (const r of records.filter(x => re.test(x.sql)).slice(0, limit)) {
    const prev = last.get(r.conn);
    if (prev) out.push(r.t < end(prev));
    last.set(r.conn, r);
  }
  return out;
};

describe.skipIf(!(pooled && pooledAdmin))('#6930 transaction pipelining through transaction-mode PgBouncer', () => {
  test('a transaction\'s concurrent statements are pipelined, each reads its own rows, all on one backend in one transaction', async () => {
    let rows: Array<{ n: number; pid: number; xid: string }> = [];
    let prepare: unknown;
    const records = await traced('txn-pipeline', 1, async engine => {
      prepare = (engine.sql as unknown as { options: { prepare: boolean } }).options.prepare;
      rows = (await engine.sql.begin(tx => Promise.all(Array.from({ length: 12 }, (_, n) =>
        tx.unsafe(`SELECT ${n}::int AS n, pg_backend_pid() AS pid, txid_current()::text AS xid /* pipelined */`))))).map(r => r[0] as unknown as { n: number; pid: number; xid: string });
    });
    expect(prepare).toBe(false);
    expect(rows.map(r => r.n)).toEqual(Array.from({ length: 12 }, (_, n) => n));
    expect(new Set(rows.map(r => r.pid)).size).toBe(1);
    expect(new Set(rows.map(r => r.xid)).size).toBe(1);
    expect(sentBeforeAnswer(records, /\/\* pipelined \*\/$/)).toEqual(Array.from({ length: 11 }, () => true));
  }, 60_000);

  test('a bounded read sends BEGIN; SET LOCAL, the read and COMMIT before any answer, and the bound still applies server-side', async () => {
    let timedOut: string | undefined;
    const records = await traced('txn-bounded', 1, async engine => {
      await engine.executeRaw('SELECT 1 AS bounded_read', [], { timeoutMs: 5000 });
      timedOut = await engine.executeRaw('SELECT pg_sleep(2) AS slept', [], { timeoutMs: 200 }).then(() => 'none', (e: { code?: string }) => e.code);
    });
    expect(sentBeforeAnswer(records, /^BEGIN; SET LOCAL statement_timeout|^SELECT 1 AS bounded_read$|^COMMIT$/, 3)).toEqual([true, true]);
    expect(timedOut).toBe('57014');
  }, 60_000);

  test('a failure inside a pipelined transaction rolls the whole transaction back, and the pool answers the next statement with its own rows', async () => {
    const table = `txn_pipeline_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    let failed: string | undefined;
    let count = -1;
    let after: unknown;
    await traced('txn-failure', 1, async engine => {
      await engine.sql.unsafe(`CREATE TABLE ${table} (n int)`);
      failed = await engine.sql.begin(tx => Promise.all([tx.unsafe(`INSERT INTO ${table} VALUES (1)`), tx.unsafe('SELECT 1/0 AS boom'), tx.unsafe(`INSERT INTO ${table} VALUES (2)`)]))
        .then(() => 'none', (e: { code?: string }) => e.code);
      count = Number((await engine.sql.unsafe(`SELECT count(*)::int AS c FROM ${table}`))[0]!.c);
      after = (await engine.sql.unsafe('SELECT 42 AS after_failure'))[0]!.after_failure;
    });
    expect(failed).toBe('22012');
    expect(count).toBe(0);
    expect(after).toBe(42);
  }, 60_000);

  test('#6543 kept: autocommit statements are not pipelined, nothing is sent behind COMMIT, and concurrent transactions over a small pool never share a backend mid-transaction', async () => {
    let txns: Array<Array<{ pid: number; xid: string; tag: number }>> = [];
    const records = await traced('txn-safety', 2, async engine => {
      await Promise.all(Array.from({ length: 6 }, (_, n) => engine.sql.unsafe(`SELECT ${n} AS autocommit_read`)));
      const reserved = await engine.sql.reserve();
      try {
        await Promise.all([reserved.unsafe('BEGIN').simple().execute(), reserved.unsafe('SELECT 1 AS inside_reserved').execute(),
          reserved.unsafe('COMMIT').execute(), reserved.unsafe('SELECT 2 AS after_commit').execute()]);
      } finally { reserved.release(); }
      txns = await Promise.all(Array.from({ length: 16 }, (_, tag) => engine.sql.begin(tx => Promise.all(Array.from({ length: 4 }, () =>
        tx.unsafe(`SELECT pg_backend_pid() AS pid, txid_current()::text AS xid, ${tag}::int AS tag`)))).then(rs => rs.map(r => r[0] as unknown as { pid: number; xid: string; tag: number }))));
    });
    const autocommit = sentBeforeAnswer(records, /AS autocommit_read$/);
    expect(autocommit.length).toBeGreaterThanOrEqual(4);
    expect(autocommit.filter(Boolean)).toEqual([]);
    const commit = records.find(r => r.sql === 'COMMIT')!;
    const afterCommit = records.find(r => /AS after_commit$/.test(r.sql))!;
    expect(afterCommit.t >= end(commit)).toBe(true);
    for (const [tag, rows] of txns.entries()) {
      expect({ tag, tags: [...new Set(rows.map(r => r.tag))], pids: new Set(rows.map(r => r.pid)).size, xids: new Set(rows.map(r => r.xid)).size })
        .toEqual({ tag, tags: [tag], pids: 1, xids: 1 });
    }
    expect(new Set(txns.map(rows => rows[0]!.xid)).size).toBe(16);
  }, 60_000);

  test('a reserved transaction\'s body waits for BEGIN\'s answer, so a BEGIN the pooler refuses never leaves its writes in autocommit', async () => {
    const records = await traced('txn-reserved', 2, async engine => {
      await engine.withReservedConnection(conn => (conn as unknown as { transaction<R>(run: (tx: PostgresEngine) => Promise<R>): Promise<R> })
        .transaction(tx => Promise.all([tx.executeRaw('SELECT 1 AS reserved_body'), tx.executeRaw('SELECT 2 AS reserved_body')])));
    });
    const begin = records.find(r => /^begin$/i.test(r.sql))!;
    const first = records.find(r => /AS reserved_body$/.test(r.sql))!;
    expect(first.conn).toBe(begin.conn);
    expect(first.t >= end(begin)).toBe(true);
    expect(sentBeforeAnswer(records, /AS reserved_body$/)).toEqual([true]);
  }, 60_000);

  test('GBRAIN_PG_TXN_PIPELINE=0 restores one round trip per statement inside a transaction', async () => {
    const records = await traced('txn-off', 1, async engine => {
      await engine.sql.begin(tx => Promise.all(Array.from({ length: 4 }, (_, n) => tx.unsafe(`SELECT ${n} AS switched_off`))));
    }, { GBRAIN_PG_TXN_PIPELINE: '0' });
    expect(sentBeforeAnswer(records, /AS switched_off$/)).toEqual([false, false, false]);
  }, 60_000);
});
