#!/usr/bin/env bun
/**
 * First-touch vs repeat search latency on a loaded production-soak brain
 * (GBRA-156). The real CLI (`gbrain search --json --timings`), either cold (no
 * serve, every call a fresh process) or over a warm `gbrain serve --cli-socket`.
 * For each query: one first touch, then --repeat repeats. Per call it records
 * the wall time, the CLI's stage timings (stages, parts, overlapped) and, with
 * --pgss, the pg_stat_statements delta of the call (reset before it, read after
 * it over the direct, unproxied lane): per statement exec and plan time, shared
 * buffer hits and reads and read I/O time.
 *
 *   bun scripts/bench/first-touch/probe.ts --work ~/soak/work --queries q.json --set A --out DIR
 *     [--path cold|socket] [--repeat 2] [--limit 40] [--embed-ms 0] [--rerank-ms 0] [--pgss] [--trace]
 *     [--restart-each] [--env K=V ...]
 *
 * Latency to the database comes from tc netem (first-touch/env.sh net), not toxiproxy.
 * --restart-each restarts Postgres and drops the page cache before each query's first touch (cold path only).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';
import { spawnChild } from '../sync-freshness-lib.ts';
import { childEnv, now, REPO, sleep, startTopology, writeConfig } from '../production-soak/lib.ts';

const argv = process.argv.slice(2);
const flag = (n: string, f = '') => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1]! : f; };
const WORK = resolve(flag('work')), OUT = resolve(flag('out')), PATH = flag('path', 'cold'), SET = flag('set', 'A');
const REPEAT = Number(flag('repeat', '2')), LIMIT = Number(flag('limit', '40'));
const EMBED = Number(flag('embed-ms', '0')), RERANK = Number(flag('rerank-ms', '0'));
const PGSS = argv.includes('--pgss'), TRACE = argv.includes('--trace'), RESTART_EACH = argv.includes('--restart-each');
const EXTRA_ENV = Object.fromEntries(argv.flatMap((a, i) => a === '--env' ? [argv[i + 1]!.split(/=(.*)/s).slice(0, 2)] : []));
const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(WORK, '..', 'fixture', 'manifest.json'), 'utf8'));
const queries = (JSON.parse(readFileSync(resolve(flag('queries')), 'utf8'))[SET] as Array<{ cls: string; q: string }>).slice(Number(flag('offset', '0'))).slice(0, LIMIT);
const HOME = join(WORK, 'home'), CLI = join(REPO, 'src', 'cli.ts');
mkdirSync(OUT, { recursive: true });

const topo = await startTopology(WORK, undefined, undefined, true);
await topo.setRtt(0);
const directUrl = topo.direct(ready.db);
let direct = postgres(directUrl, { max: 1, onnotice: () => {} });
const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 }, embedMs: EMBED, rerankMs: RERANK });
writeConfig(HOME, topo.txn(ready.db), mock.url);
const base = childEnv(HOME, mock.url, { GBRAIN_DIRECT_DATABASE_URL: topo.session(ready.db), ...EXTRA_ENV });

async function restartPostgres() {
  await direct.end();
  spawnSync('docker', ['restart', 'soak-pg']);
  spawnSync('sudo', ['sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches']);
  for (let i = 0; ; i++) { try { direct = postgres(directUrl, { max: 1, onnotice: () => {}, connect_timeout: 2 }); await direct`SELECT 1`; break; } catch (e) { if (i > 120) throw e; await sleep(500); } }
  spawnSync('docker', ['restart', 'soak-bouncer-session', 'soak-bouncer-txn']);
  await sleep(1500);
}

async function pgssReset() { if (PGSS) await direct.unsafe('SELECT pg_stat_statements_reset()'); }
async function pgssRead() {
  if (!PGSS) return undefined;
  const rows = await direct.unsafe(`SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS q, calls::int, round(total_exec_time::numeric, 1)::float AS exec_ms, round(total_plan_time::numeric, 1)::float AS plan_ms,
    shared_blks_hit::int AS hit, shared_blks_read::int AS read, round(blk_read_time::numeric, 1)::float AS read_ms, temp_blks_written::int AS temp
    FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC`) as any[];
  const sum = (k: string) => Math.round(rows.reduce((a, r) => a + Number(r[k] ?? 0), 0) * 10) / 10;
  return { statements: rows.reduce((a, r) => a + r.calls, 0), exec_ms: sum('exec_ms'), plan_ms: sum('plan_ms'), hit: sum('hit'), read: sum('read'), read_ms: sum('read_ms'), top: rows.slice(0, 12) };
}

let serve: ReturnType<typeof spawnChild> | null = null;
if (PATH === 'socket') {
  let log = '';
  serve = spawnChild([process.execPath, CLI, 'serve', '--cli-socket'], { cwd: HOME, env: { ...base, GBRAIN_SWEEP: '0' }, logFile: join(OUT, 'serve.log'), stdin: true });
  serve.onLine(l => { if (l.stream === 'err') log += l.text + '\n'; });
  for (let i = 0; i < 720 && !/cli-socket: listening/.test(log); i++) await sleep(250);
  if (!/cli-socket: listening/.test(log)) throw new Error('serve did not open the CLI socket:\n' + log.slice(-2000));
  await sleep(Number(flag('settle-s', '20')) * 1000);
}

async function call(qi: number, rep: number, q: { cls: string; q: string }) {
  await pgssReset();
  const env = { ...base, GBRAIN_DEBUG: PATH === 'socket' ? '1' : base.GBRAIN_DEBUG ?? '', ...(TRACE ? { GBRAIN_SQL_TRACE: join(OUT, `trace-${qi}-${rep}.jsonl`) } : {}) };
  const t0 = now();
  const p = Bun.spawn([process.execPath, CLI, 'search', q.q, '--json', '--timings'], { cwd: HOME, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const ms = Math.round(now() - t0);
  await sleep(300);
  const pgss = await pgssRead();
  let j: any = null; try { j = JSON.parse(stdout); } catch { /* not JSON */ }
  const t = j?.timings_ms ?? null;
  const warm = PATH === 'socket' ? /\[cli-socket\] warm/.test(stderr) : false;
  const row = { set: SET, path: PATH, qi, rep, cls: q.cls, q: q.q, ms, code, warm, rows: Array.isArray(j?.results) ? j.results.length : null,
    top: Array.isArray(j?.results) ? j.results.slice(0, 10).map((r: any) => r.slug) : null, timings: t, pgss, stderr_tail: code === 0 ? undefined : stderr.slice(-400) };
  appendFileSync(join(OUT, 'calls.jsonl'), JSON.stringify(row) + '\n');
  console.log(`${SET} ${PATH} q${qi} r${rep} ${q.cls.padEnd(10)} ${String(ms).padStart(5)} ms op=${t?.op ?? '?'} lex=${t?.stages?.lexical ?? '-'} vec=${t?.stages?.vector ?? '-'} resp=${t?.stages?.response ?? '-'} meta=${t?.parts?.response?.meta ?? '-'} reads=${pgss?.read ?? '-'} ${warm ? 'warm' : ''} ${code}`);
}

for (let qi = 0; qi < queries.length; qi++) {
  if (RESTART_EACH) await restartPostgres();
  for (let rep = 0; rep <= REPEAT; rep++) await call(qi, rep, queries[qi]!);
}
serve?.kill();
mock.stop();
await direct.end();
process.exit(0);
