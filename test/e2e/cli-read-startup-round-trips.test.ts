/**
 * #7147: a one-shot read verb through a transaction-mode pooler pays one
 * network round trip per statement, so startup statements are the wall clock
 * of every `gbrain entity` / `gbrain get` call. This pins the statements a cold
 * read spends on the config table and on managed-writer maintenance, counted
 * at the socket by the wire trace (`GBRAIN_SQL_TRACE`), never in milliseconds.
 *
 * Protects: a read verb reads the config table through one snapshot per phase
 * (startup, then the context build and the operation) instead of one
 * statement per key, skips the
 * retired-marker cleanup a read never depends on, and shows the pooler banner
 * once per database. Regressions it catches: a new per-key `getConfig` on the
 * read path outside a snapshot, the cleanup running for reads again, or the
 * banner printing on every call. Existing budget tests cover page writes and
 * imports, not CLI read startup.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';
import { readSqlTrace, type StatementRecord } from '../helpers/statement-counter.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeDatabase = hasDatabase() ? describe : describe.skip;
const BANNER = 'Prepared statements and statement pipelining disabled';

function poolerUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('prepare', 'false');
  return url.toString();
}

let home: string;

async function tracedRead(args: string[], name: string): Promise<{ stderr: string; statements: StatementRecord[] }> {
  const trace = join(home, `${name}.ndjson`);
  const r = await runCli(args, { home, cwd: home, timeoutMs: 90_000, env: { GBRAIN_SQL_TRACE: trace } });
  expect(r.exitCode, r.stderr).toBe(0);
  return { stderr: r.stderr, statements: readSqlTrace(trace).filter(s => s.kind === 'execute' || s.kind === 'simple' || s.kind === 'describe') };
}

/** Config-table statements, leaving out the pool's connection check (db.ts checkPoolAndLoadSharedTypes reads the schema version with it). */
const configStatements = (statements: StatementRecord[]) =>
  statements.filter(s => /\bFROM\s+config\b/i.test(s.sql) && !s.sql.includes('server_version_num'));

describeDatabase('cold read verb startup through a transaction pooler (#7147)', () => {
  beforeAll(async () => {
    await setupDB();
    await getEngine().putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example works at Acme Example.', timeline: '',
    });
    home = mkdtempSync(join(tmpdir(), 'gbrain-cold-read-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: poolerUrl(), embedding_disabled: true }));
  });
  afterAll(async () => {
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('the pooler banner prints on the first call only', async () => {
    const first = await tracedRead(['entity', 'Alice Example'], 'banner-1');
    expect(first.stderr).toContain(BANNER);
    const second = await tracedRead(['entity', 'Alice Example'], 'banner-2');
    expect(second.stderr).not.toContain(BANNER);
  }, 180_000);

  for (const args of [['entity', 'Alice Example'], ['get', 'people/alice-example']]) {
    test(`gbrain ${args[0]}: config reads come from snapshots, and no retired-marker cleanup runs`, async () => {
      const { statements } = await tracedRead(args, `budget-${args[0]}`);
      const config = configStatements(statements);
      expect(config.length, config.map(s => s.sql).join('\n')).toBeLessThanOrEqual(2);
      expect(statements.filter(s => s.sql.includes('persistence_topology_changes'))).toEqual([]);
    }, 120_000);
  }
});
