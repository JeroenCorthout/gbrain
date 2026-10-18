#!/usr/bin/env bun
/**
 * GBRA-133 lane A: commit-to-searchable latency bench. Opt-in, never run in CI.
 *
 *   bun scripts/bench/sync-freshness.ts --engine pglite|postgres --mode classic|managed --pages N
 *     --commit single|batch|backlog --trigger serve|autopilot|jobs|watch|manual --reps N [--json]
 *     [--rtt MS] [--interval S] [--timeout S] [--scenario during-sync] [--gbrain-root <checkout>]
 *     [--work-dir <dir>] [--label <name>] [--rebuild] [--probe-ms 100]
 *   bun scripts/bench/sync-freshness.ts --report <results dir>   # markdown table of every cell JSON
 *
 * Builds (once, then reuses) a synthetic git brain of N pages for the engine,
 * mode and gbrain checkout: classic import first, then for managed the real
 * "gbrain sources writer claim/activate" CLI (a managed brain of the same size
 * is cloned from the classic one). Per rep it commits a change with a fresh
 * token, fires or waits for the trigger, and polls until get_page returns the
 * new content and a keyword search returns every changed page.
 *
 * Probes: Postgres reads through an in-process engine on a direct (un-proxied)
 * connection every --probe-ms; PGLite with a serve reads through that serve's
 * own MCP stdio (get_page, search); PGLite without a serve cannot be read while
 * the syncing process holds the single-writer lock, so a manual sync is timed
 * to its completion line and verified after exit, and resident pollers are
 * derived (see the report). Every child line is timestamped on arrival, which
 * gives the phase breakdown (boot, discovery/freeze, publish, tail).
 * Postgres runs in Docker (gbrain-bench-pg) with toxiproxy for --rtt, the same
 * harness as scripts/bench/managed-sync-catchup.ts. Keyless: provider keys are
 * stripped from every child.
 */
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import postgres from '#postgres';
import { startHarness, measureRtt, startEmbeddingStub, readTrace, groupStatements, classify, type Harness } from './managed-sync-catchup-lib.ts';
import {
  copyDir, engineProber, existsSync, git, machineInfo, makeChange, mcpProber, McpClient, mkdirSync, now, pollVisible, readFileSync, rmSync, round1,
  sleep, spawnChild, stats, waitLine, writeCorpus, writeFileSync, writeState, getTargets, slugOf, expectedHits,
  type Change, type Child, type CommitKind, type Prober, type Line, type Stats,
} from './sync-freshness-lib.ts';

const REPO = resolve(import.meta.dir, '../..');
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
const has = (name: string) => argv.includes('--' + name);

if (has('report')) { report(flag('report', '.').split(',').map(d => resolve(d)).join(',')); process.exit(0); }

const ENGINE = flag('engine', 'pglite') as 'pglite' | 'postgres';
const MODE = flag('mode', 'classic') as 'classic' | 'managed';
const PAGES = Number(flag('pages', '1000'));
const COMMIT = flag('commit', 'single') as CommitKind | 'noop';
const TRIGGER = flag('trigger', 'manual') as 'serve' | 'autopilot' | 'jobs' | 'watch' | 'manual';
const REPS = Number(flag('reps', '10'));
const RTT = Number(flag('rtt', '0'));
const SCENARIO = flag('scenario', 'plain');
const PROBE_MS = Number(flag('probe-ms', '100'));
const GROOT = resolve(flag('gbrain-root', REPO));
const WORK = resolve(flag('work-dir', join(REPO, '.context/bench/sync-freshness')));
const CLI = join(GROOT, 'src/cli.ts');
/** The product revision (last commit touching src/), so bench-only commits keep reusing the same brains. */
const REV = git(GROOT, 'log', '-1', '--format=%h', '--abbrev=8', '--', 'src', 'package.json');
const LABEL = flag('label', git(GROOT, 'rev-parse', '--abbrev-ref', 'HEAD') + '@' + REV);
const INTERVAL = Number(flag('interval', TRIGGER === 'autopilot' ? '300' : '60'));
const TIMEOUT_S = Number(flag('timeout', String(TRIGGER === 'autopilot' ? INTERVAL * 2 + 600 : TRIGGER === 'watch' ? INTERVAL + 300 : COMMIT === 'backlog' ? 3600 : 300)));
const JSON_OUT = has('json');
const EMBED = flag('embed', 'off') as 'off' | 'stub';
const EMBED_LATENCY_MS = Number(flag('embed-latency-ms', '200'));
let stubUrl = '';
const TRACE = has('trace');
if (COMMIT === 'noop' && TRIGGER !== 'manual') { console.error('--commit noop measures a manual sync with nothing to do; use --trigger manual'); process.exit(2); }
if (!['pglite', 'postgres'].includes(ENGINE) || !['classic', 'managed'].includes(MODE) || !['single', 'batch', 'backlog', 'noop'].includes(COMMIT)
  || !['serve', 'autopilot', 'jobs', 'watch', 'manual'].includes(TRIGGER) || !(PAGES > 0) || !(REPS > 0)) {
  console.error('usage: see the header of scripts/bench/sync-freshness.ts'); process.exit(2);
}
if (RTT && ENGINE !== 'postgres') { console.error('--rtt applies to --engine postgres'); process.exit(2); }
const log = (m: string) => console.error('[freshness ' + new Date().toISOString().slice(11, 19) + '] ' + m);

const brainKey = (mode: string) => ENGINE + '-' + mode + '-' + PAGES + (EMBED === 'stub' ? '-embed' : '') + '-' + REV;
const brainDir = (mode: string) => join(WORK, 'brains', brainKey(mode));
const dbName = (mode: string) => ('gbf_' + brainKey(mode)).replace(/\W/g, '_').toLowerCase();
const DIR = brainDir(MODE);
const HOME = join(DIR, 'home');
const ROOT = join(DIR, 'repo');

let harness: Harness | null = null;
const directUrl = (mode = MODE) => harness!.directUrl(dbName(mode));

function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^OPENAI_BASE_URL$|^GBRAIN_HOME$/.test(k)) delete env[k];
  return { ...env, GBRAIN_HOME: HOME, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKILLS_DIR: join(HOME, 'skills'), NO_COLOR: '1',
    ...(EMBED === 'stub' ? { OPENAI_API_KEY: 'sk-bench-stub-not-a-key', OPENAI_BASE_URL: stubUrl } : {}), ...extra };
}
/** Async on purpose: the embedding stub answers from this process's event loop. */
async function gb(args: string[], opts: { home?: string; allowFail?: boolean; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: opts.home ?? HOME, env: childEnv(opts.home ? { GBRAIN_HOME: opts.home, GBRAIN_SKILLS_DIR: join(opts.home, 'skills') } : {}) as Record<string, string>,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs ?? 4 * 3600_000 });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const r = { exitCode };
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { const last = stdout.trim().split('\n').reverse().find(l => l.startsWith('{')); try { json = last ? JSON.parse(last) : null; } catch { json = null; } }
  if (r.exitCode !== 0 && !opts.allowFail) throw new Error('gbrain ' + args.join(' ') + ' exited ' + r.exitCode + '\n' + stdout.slice(-1500) + '\n' + stderr.slice(-1500));
  return { code: r.exitCode ?? -1, stdout, stderr, json };
}
function writeConfig(home: string, mode: string, url?: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'skills'), { recursive: true });
  if (!existsSync(join(home, 'skills', 'RESOLVER.md'))) writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Bench fixture skills\n');
  const file = join(home, '.gbrain', 'config.json');
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const base = ENGINE === 'postgres' ? { engine: 'postgres', database_url: url ?? harness!.directUrl(dbName(mode)) } : { engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') };
  const embedding = EMBED === 'stub' ? { embedding_disabled: false, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 } : { embedding_disabled: true };
  writeFileSync(file, JSON.stringify({ ...prior, ...base, ...embedding, self_upgrade: { mode: 'off' } }, null, 2) + '\n');
}
async function admin<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>, db = 'postgres'): Promise<T> {
  const sql = postgres(harness!.directUrl(db), { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}
async function dbExists(db: string): Promise<boolean> { return admin(async sql => (await sql.unsafe('SELECT 1 FROM pg_database WHERE datname=$1', [db])).length > 0); }

async function syncUntilDone(home: string, label: string): Promise<{ ms: number; runs: number }> {
  const t = now();
  for (let i = 0; ; i++) {
    const r = await gb(['sync', '--source', 'bench', '--no-pull', ...(EMBED === 'stub' ? [] : ['--no-embed']), '--json'], { home, allowFail: true });
    const status = r.json?.sync_status ?? r.json?.outcome;
    log(label + ' sync pass ' + (i + 1) + ': ' + status + ' (' + round1((now() - t) / 1000) + ' s)');
    if (['synced', 'first_sync', 'up_to_date'].includes(status)) return { ms: now() - t, runs: i + 1 };
    if (i > 200 || (r.code !== 0 && status !== 'partial')) throw new Error(label + ' sync did not converge: ' + r.stdout.slice(-1500) + r.stderr.slice(-1500));
  }
}

/**
 * A full import leaves the mention-link pass to later (links_extraction_lag), and a managed sync then spends its tail on
 * that backlog. Cells measure steady state, so the build clears it the way the sync's own hint says.
 */
async function settleLinks(home: string): Promise<{ ms: number; runs: number; last: string }> {
  const t = now();
  let last = '';
  for (let i = 0; i < 20; i++) {
    const r = await gb(['extract', '--stale', '--catch-up', '--source-id', 'bench', '--brain', 'host'], { home, allowFail: true });
    last = (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    log('links settle pass ' + (i + 1) + ' (' + round1((now() - t) / 1000) + ' s): ' + last);
    if (r.code !== 0 || !/Actionable: [1-9]\d* page\(s\) still need|[1-9]\d* page\(s\) due for the mention pass/.test(r.stdout + r.stderr)) return { ms: round1(now() - t), runs: i + 1, last };
  }
  return { ms: round1(now() - t), runs: 20, last };
}

async function activate(home: string): Promise<number> {
  const t = now();
  let state = (await gb(['sources', 'writer', 'status', '--json'], { home })).json.admin_state as string;
  await gb(['sources', 'writer', 'claim', 'bench', '--path', join(home, '..', 'repo'), '--admin-intent', 'writer_claim', '--expected-state', state, '--json'], { home });
  state = (await gb(['sources', 'writer', 'status', '--json'], { home })).json.admin_state as string;
  const a = await gb(['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json'], { home });
  if (a.json?.enabled !== true) throw new Error('activation did not enable managed persistence: ' + a.stdout.slice(-1500));
  return now() - t;
}

/** Builds the brain for (engine, mode, pages, checkout) unless it is already built. */
async function ensureBrain(mode: 'classic' | 'managed'): Promise<Record<string, unknown>> {
  const dir = brainDir(mode), home = join(dir, 'home'), root = join(dir, 'repo');
  const ready = join(dir, 'ready.json');
  if (existsSync(ready) && !has('rebuild')) {
    const prior = JSON.parse(readFileSync(ready, 'utf8'));
    if (prior.links_settled) return prior;
    writeConfig(home, mode);
    prior.links_settled = await settleLinks(home);
    writeFileSync(ready, JSON.stringify(prior, null, 2));
    return prior;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const build: Record<string, unknown> = { engine: ENGINE, mode, pages: PAGES, rev: REV, built_at: new Date().toISOString() };
  const classicReady = join(brainDir('classic'), 'ready.json');
  if (mode === 'managed' && existsSync(classicReady)) {
    log('cloning classic ' + brainKey('classic') + ' for managed');
    const t = now();
    copyDir(join(brainDir('classic'), 'repo'), root);
    writeFileSync(join(dir, 'corpus-state.json'), readFileSync(join(brainDir('classic'), 'corpus-state.json')));
    if (ENGINE === 'postgres') {
      await admin(sql => sql.unsafe('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [dbName('classic')]));
      if (await dbExists(dbName(mode))) await admin(sql => sql.unsafe('DROP DATABASE ' + dbName(mode) + ' WITH (FORCE)'));
      await admin(sql => sql.unsafe('CREATE DATABASE ' + dbName(mode) + ' TEMPLATE ' + dbName('classic')));
      writeConfig(home, mode);
      await admin(sql => sql.unsafe("UPDATE sources SET local_path=$1 WHERE id='bench'", [root]), dbName(mode));
    } else {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      for (const f of readdirSync(join(brainDir('classic'), 'home', '.gbrain'))) if (f.startsWith('brain.pglite') && !f.includes('owner')) copyDir(join(brainDir('classic'), 'home', '.gbrain', f), join(home, '.gbrain', f));
      writeConfig(home, mode);
      await withPglite(home, e => e.executeRaw("UPDATE sources SET local_path=$1 WHERE id='bench'", [root]));
    }
    build.cloned_from = brainKey('classic');
    build.clone_ms = round1(now() - t);
  } else {
    log('building ' + brainKey(mode) + ': writing ' + PAGES + ' pages');
    let t = now();
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    writeCorpus(root, PAGES);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'corpus');
    writeState(dir, { pages: PAGES, deleted: [], added: [], nextAdd: 0, cursor: 0 });
    build.corpus_ms = round1(now() - t);
    if (ENGINE === 'postgres') {
      if (await dbExists(dbName(mode))) await admin(sql => sql.unsafe('DROP DATABASE ' + dbName(mode) + ' WITH (FORCE)'));
      await admin(sql => sql.unsafe('CREATE DATABASE ' + dbName(mode)));
    }
    writeConfig(home, mode);
    t = now();
    await gb(['sources', 'add', 'bench', '--path', root, '--no-federated'], { home });
    build.sources_add_ms = round1(now() - t);
    const s = await syncUntilDone(home, 'initial import');
    build.initial_import_ms = round1(s.ms);
    build.initial_import_pages_per_s = round1(PAGES / (s.ms / 1000));
  }
  if (mode === 'classic') build.links_settled = await settleLinks(home);
  if (mode === 'managed') {
    build.activate_ms = round1(await activate(home));
    build.first_managed_sync = await syncUntilDone(home, 'post-activation');
    build.links_settled = await settleLinks(home);
  }
  writeFileSync(ready, JSON.stringify(build, null, 2));
  return build;
}

async function withPglite<T>(home: string, fn: (engine: any) => Promise<T>): Promise<T> {
  const prior = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  const { PGLiteEngine } = await import(join(GROOT, 'src/core/pglite-engine.ts'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); if (prior === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prior; }
}
async function pgliteVerify(c: Change): Promise<{ getOk: boolean; searchOk: boolean; hits: number }> {
  return withPglite(HOME, async engine => {
    const { present, gone } = getTargets(c);
    let getOk = true;
    for (const p of present) { const page = await engine.getPage(slugOf(p), { sourceId: 'bench' }); if (!page || !String(page.compiled_truth).includes(c.token)) getOk = false; }
    for (const p of gone) if (await engine.getPage(slugOf(p), { sourceId: 'bench' })) getOk = false;
    const hits = new Set((await engine.searchKeyword(c.token, { limit: 100, sourceId: 'bench' })).map((h: { slug: string }) => h.slug)).size;
    const [{ n }] = await engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE source_id='bench' AND deleted_at IS NULL AND compiled_truth LIKE $1", ['%' + c.token + '%']);
    return { getOk, searchOk: hits >= Math.min(100, expectedHits(c)) && n >= expectedHits(c), hits, pages_with_token: n };
  });
}

// ---------------------------------------------------------------------------
// Phase extraction from timestamped child lines.
// ---------------------------------------------------------------------------
const PHASE_RES: Array<[string, RegExp]> = [
  ['first_line', /./],
  ['frozen', /entries frozen|managed catch-up:/],
  ['first_progress', /\d+\/\d+ processed/],
  ['done', /^Synced [0-9a-f]+\.\.|^First sync complete|Managed sync synced|^\[\d\d:\d\d:\d\d\] Synced:|Already up to date|up to date/],
  ['serve_job_started', /on-commit: .*started managed sync job/],
  ['serve_resuming', /on-commit: .*resuming/],
  ['cycle', /\[cycle\]|"event":"cycle"/],
];
function phaseMarks(lines: Line[], from: number, to: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (l.t < from || l.t > to) continue;
    const gp = /\[gbrain phase\] (\S+) done (\d+)ms/.exec(l.text);
    if (gp && out['gp:' + gp[1]] === undefined) out['gp:' + gp[1]] = Number(gp[2]);
    for (const [name, re] of PHASE_RES) if (out[name] === undefined && (name !== 'first_line' || l.stream === 'err') && re.test(l.text.replace(/^\[\d\d:\d\d:\d\d\] (?=\[)/, ''))) out[name] = round1(l.t - from);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One cell.
// ---------------------------------------------------------------------------
interface Rep { rep: number; sha: string; token: string; files: number; get_ms: number | null; search_ms: number | null; first_hit_ms: number | null; commit_git_ms: number;
  source: string; phases: Record<string, number>; probes?: number; probe_ms_mean?: number; exit_ms?: number | null; verified?: unknown; note?: string; error?: string }

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  if (ENGINE === 'postgres') harness = await startHarness({ pgPort: 55432, proxyPort: Number(flag('proxy-port', String(56000 + (process.pid % 1000)))), apiPort: 58474, keep: true });
  const stub = EMBED === 'stub' ? await startEmbeddingStub({ latencyMs: EMBED_LATENCY_MS, maxConcurrent: 8, dims: 1536 }) : null;
  if (stub) stubUrl = stub.url;
  if (MODE === 'managed' && !existsSync(join(brainDir('classic'), 'ready.json')) && PAGES >= 10000) await ensureBrain('classic');
  const build = await ensureBrain(MODE);
  const brainUrl = ENGINE === 'postgres' ? (RTT ? harness!.proxyUrl(dbName(MODE)) : directUrl()) : undefined;
  writeConfig(HOME, MODE, brainUrl);
  let measuredRtt: number | null = null;
  if (ENGINE === 'postgres') { await harness!.setRtt(RTT); measuredRtt = await measureRtt(brainUrl!); }
  const cellId = [ENGINE, MODE, PAGES, COMMIT, TRIGGER, RTT ? 'rtt' + RTT : '', SCENARIO !== 'plain' ? SCENARIO : '', EMBED === 'stub' ? 'embed' + EMBED_LATENCY_MS : '', LABEL.replace(/[^\w.-]/g, '_')].filter(Boolean).join('-');
  const outDir = join(WORK, 'results');
  mkdirSync(join(outDir, 'logs'), { recursive: true });
  const logFile = join(outDir, 'logs', cellId + '-' + Date.now() + '.log');
  log('cell ' + cellId + ' (' + REPS + ' reps)');

  const reps: Rep[] = [];
  const notes: string[] = [];
  let resident: Child | null = null;
  let prober: Prober | null = ENGINE === 'postgres' ? await engineProber(GROOT, directUrl(), EMBED === 'stub') : null;

  if (TRIGGER === 'serve') {
    await gb(['config', 'set', 'sync.on_commit', 'true']);
    resident = spawnChild([process.execPath, CLI, 'serve'], { cwd: HOME, env: childEnv(), logFile, stdin: true });
    const mcp = new McpClient(resident);
    await mcp.init();
    if (!prober) prober = mcpProber(mcp);
    const enabled = await waitLine(resident, /on-commit: enabled/, 45_000);
    notes.push(enabled ? 'serve on-commit watcher enabled ' + round1(enabled.t - resident.startedAt) + ' ms after spawn' : 'serve printed no on-commit enabled line within 45 s');
    await sleep(4000);
  } else if (TRIGGER === 'watch') {
    resident = spawnChild([process.execPath, CLI, 'sync', '--watch', '--interval', String(INTERVAL), '--source', 'bench', '--no-pull'], { cwd: HOME, env: childEnv(), logFile });
    await waitLine(resident, /Watching for changes/, 120_000);
    if (ENGINE === 'pglite') notes.push('PGLite: the watch process holds the single-writer lock, so nothing else can read the brain; probes cannot run (derive from interval + manual sync cost).');
  } else if (TRIGGER === 'autopilot') {
    resident = spawnChild([process.execPath, CLI, 'autopilot', '--repo', ROOT, '--interval', String(INTERVAL), '--json'], { cwd: HOME, env: childEnv(), logFile });
    await waitLine(resident, /cycle|Autopilot starting/, 120_000);
  } else if (TRIGGER === 'jobs') {
    if (ENGINE !== 'postgres') { notes.push('PGLite has no resident jobs worker ("gbrain jobs work" drains the queue and exits).'); }
    else {
      resident = spawnChild([process.execPath, CLI, 'jobs', 'work'], { cwd: HOME, env: childEnv(), logFile });
      await sleep(5000);
    }
  }

  if (TRIGGER === 'jobs' && prober && resident) {
    const c = makeChange(ROOT, DIR, 'single');
    const v = await pollVisible(prober, c, now() + 30_000, 500);
    notes.push('jobs worker alone (no submit): ' + (v.t_search === null ? 'nothing synced a single-file commit within 30 s; the worker has no autonomous sync trigger' : 'the commit became visible after ' + round1(v.t_search - c.t_commit) + ' ms without a submit'));
    await gb(['jobs', 'submit', 'sync', '--params', JSON.stringify({ sourceId: 'bench', noPull: true })], { allowFail: true });
    await pollVisible(prober, c, now() + 120_000, 200);
  }

  if (COMMIT === 'noop') {
    await gb(['sync', '--source', 'bench', '--no-pull', '--json'], { allowFail: true });
    notes.push('noop: HEAD equals the last synced commit (one unrecorded sync converged it first); each rep is one manual sync with nothing to do, timed spawn to exit');
    for (let rep = 0; rep < REPS; rep++) {
      await sleep(300);
      const trace = TRACE && ENGINE === 'postgres' ? join(outDir, 'logs', cellId + '-rep' + rep + '-sql.jsonl') : undefined;
      if (trace) rmSync(trace, { force: true });
      const child = spawnChild([process.execPath, CLI, 'sync', '--source', 'bench', '--no-pull', '--json'], { cwd: HOME, env: childEnv(trace ? { GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'noop-sync' } : {}), logFile });
      const code = await child.exited;
      const r: Rep = { rep, sha: git(ROOT, 'rev-parse', '--short=12', 'HEAD'), token: '', files: 0, get_ms: null, search_ms: null, first_hit_ms: null, commit_git_ms: 0, source: 'exit', phases: {} };
      r.exit_ms = round1(child.exitAt! - child.startedAt);
      for (const [k, v] of Object.entries(phaseMarks(child.lines, child.startedAt, now()))) r.phases[k] = v;
      const out = child.stdoutRaw();
      try { const j = JSON.parse(out.slice(out.indexOf('{'))); r.phases.sync_status = j.sync_status; } catch { /* not json */ }
      if (code !== 0) r.error = 'sync exited ' + code;
      if (trace && existsSync(trace)) {
        const recs = readTrace(trace);
        const byClass: Record<string, { n: number; ms: number }> = {};
        for (const x of recs) { const c = byClass[classify(x.sql)] ??= { n: 0, ms: 0 }; c.n++; c.ms += x.ms; }
        r.phases.db_round_trips = recs.length;
        r.phases.db_ms = round1(recs.reduce((a, x) => a + x.ms, 0));
        if (recs.length) r.phases.db_span_ms = round1(Math.max(...recs.map(x => x.t + x.ms)) - Math.min(...recs.map(x => x.t)));
        (r as Rep & { sql?: unknown }).sql = { by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { n: v.n, ms: round1(v.ms) }])), top: groupStatements(recs, 1, 100000).sort((a, b) => b.total_ms - a.total_ms).slice(0, 12).map(g => ({ sql: g.sql, count: g.count, total_ms: g.total_ms })) };
      }
      reps.push(r);
      log('noop rep ' + (rep + 1) + '/' + REPS + ': exit ' + r.exit_ms + ' ms ' + JSON.stringify(r.phases) + (r.error ? ' ERROR ' + r.error : ''));
    }
  }

  try {
    for (let rep = 0; rep < (COMMIT === 'noop' ? 0 : REPS); rep++) {
      if (TRIGGER === 'watch' || TRIGGER === 'autopilot') await sleep(Math.random() * INTERVAL * 1000);
      else await sleep(TRIGGER === 'serve' ? 3500 : 300);
      let pre: Change | null = null;
      if (SCENARIO === 'during-sync') {
        pre = makeChange(ROOT, DIR, 'batch');
        if (TRIGGER === 'serve' && resident) await waitLine(resident, /started managed sync job/, 60_000, pre.t_commit);
        await sleep(Number(flag('during-delay-ms', '500')));
      }
      const c = makeChange(ROOT, DIR, COMMIT as CommitKind);
      const deadline = c.t_commit + TIMEOUT_S * 1000;
      const r: Rep = { rep, sha: c.sha.slice(0, 12), token: c.token, files: c.edited.length + c.added.length + c.deleted.length, get_ms: null, search_ms: null, first_hit_ms: null,
        commit_git_ms: round1(c.t_commit - c.t_commit_start), source: '', phases: {} };
      let child: Child | null = resident;
      if (TRIGGER === 'manual') {
        child = spawnChild([process.execPath, CLI, 'sync', '--source', 'bench', '--no-pull', '--json'], { cwd: HOME, env: childEnv(), logFile });
      } else if (TRIGGER === 'jobs' && ENGINE === 'postgres') {
        const t = now();
        const sub = await gb(['jobs', 'submit', 'sync', '--params', JSON.stringify({ sourceId: 'bench', noPull: true })], { allowFail: true });
        r.phases.submit_cli_ms = round1(now() - t);
        r.phases.submit_after_commit_ms = round1(t - c.t_commit);
        if (sub.code !== 0) r.error = 'jobs submit failed: ' + (sub.stdout + sub.stderr).slice(-400);
      }
      if (prober) {
        const v = await pollVisible(prober, c, deadline, PROBE_MS);
        r.source = prober.kind;
        r.get_ms = v.t_get === null ? null : round1(v.t_get - c.t_commit);
        r.search_ms = v.t_search === null ? null : round1(v.t_search - c.t_commit);
        r.first_hit_ms = v.t_first_hit === null ? null : round1(v.t_first_hit - c.t_commit);
        r.probes = v.probes; r.probe_ms_mean = v.probe_ms_mean;
        if (EMBED === 'stub') r.phases.embedded_ms = v.t_embedded == null ? -1 : round1(v.t_embedded - c.t_commit);
        if (TRIGGER === 'manual' && child) { await child.exited; r.exit_ms = round1(child.exitAt! - c.t_commit); }
      } else if (TRIGGER === 'manual' && child) {
        await child.exited;
        r.exit_ms = round1(child.exitAt! - c.t_commit);
        const done = child.lines.find(l => PHASE_RES[3]![1].test(l.text));
        r.source = 'done-line';
        r.get_ms = r.search_ms = done ? round1(done.t - c.t_commit) : null;
        const total = expectedHits(c) + c.deleted.length;
        const processed = child.lines.find(l => new RegExp('\\b' + total + '/' + total + ' processed').test(l.text));
        if (processed) r.phases.all_processed_line_ms = round1(processed.t - c.t_commit);
        r.verified = await pgliteVerify(c);
        if (!(r.verified as { getOk: boolean }).getOk) r.error = 'PGLite verification after exit did not see the change';
      } else {
        r.source = 'none';
        r.note = 'no reader available while the trigger process holds the PGLite lock';
        if (resident) await waitLine(resident, PHASE_RES[3]![1], TIMEOUT_S * 1000, c.t_commit).then(l => { if (l) r.phases.done_line_ms = round1(l.t - c.t_commit); });
      }
      if (child && child === resident && r.search_ms !== null) await waitLine(child, PHASE_RES[3]![1], 5000, c.t_commit);
      if (child) {
        const base = TRIGGER === 'manual' ? child.startedAt : c.t_commit;
        const marks = phaseMarks(child.lines, base, now());
        for (const [k, v] of Object.entries(marks)) r.phases[k] = v;
        if (TRIGGER === 'manual') r.phases.spawn_after_commit_ms = round1(child.startedAt - c.t_commit);
        if (TRIGGER === 'manual') { const out = child.stdoutRaw(); try { const j = JSON.parse(out.slice(out.indexOf('{'))); r.phases.sync_status = j.sync_status; r.phases.written = j.drain?.written ?? j.added + j.modified; } catch { /* not json */ } }
      }
      if (pre) r.note = 'committed while the sync of a 60-file batch (' + pre.sha.slice(0, 8) + ') was running';
      reps.push(r);
      log('rep ' + (rep + 1) + '/' + REPS + ': get ' + r.get_ms + ' ms, search ' + r.search_ms + ' ms' + (r.exit_ms ? ', exit ' + r.exit_ms + ' ms' : '') + ' ' + JSON.stringify(r.phases) + (r.error ? ' ERROR ' + r.error : ''));
      if (r.search_ms === null && r.get_ms === null && r.source !== 'none' && TRIGGER !== 'serve') { notes.push('rep ' + rep + ' never became visible within ' + TIMEOUT_S + ' s'); }
      if (r.search_ms === null && MODE === 'classic' && TRIGGER === 'serve') { notes.push('classic brain: serve never synced the commit within ' + TIMEOUT_S + ' s (the on-commit watcher lists managed sources only)'); break; }
    }
  } finally {
    if (resident) { resident.kill('SIGTERM'); await Promise.race([resident.exited, sleep(40_000)]); resident.kill('SIGKILL'); }
    if (TRIGGER === 'serve') await gb(['config', 'set', 'sync.on_commit', 'false'], { allowFail: true });
    await prober?.close();
    if (harness) { await harness.setRtt(0); harness.stop(); }
    if (stub) { notes.push('embedding stub: ' + JSON.stringify(stub.stats) + ', ' + EMBED_LATENCY_MS + ' ms per call'); stub.close(); }
  }

  const ok = (k: 'get_ms' | 'search_ms') => reps.map(r => r[k]).filter((x): x is number => typeof x === 'number');
  const phaseKeys = [...new Set(reps.flatMap(r => Object.keys(r.phases)))].filter(k => reps.some(r => typeof r.phases[k] === 'number'));
  const phaseStats: Record<string, Stats> = {};
  for (const k of phaseKeys) phaseStats[k] = stats(reps.map(r => r.phases[k]).filter((x): x is number => typeof x === 'number'));
  const result = {
    schema: 'gbrain-sync-freshness/1', cell: cellId, label: LABEL, gbrain_rev: REV, gbrain_root: GROOT, at: new Date().toISOString(),
    params: { engine: ENGINE, mode: MODE, pages: PAGES, commit: COMMIT, trigger: TRIGGER, reps: REPS, rtt_ms: RTT, measured_rtt_ms: measuredRtt, interval_s: ['watch', 'autopilot'].includes(TRIGGER) ? INTERVAL : null,
      scenario: SCENARIO, probe_ms: PROBE_MS, timeout_s: TIMEOUT_S, keyless: EMBED === 'off', embed: EMBED === 'stub' ? { provider: 'loopback OpenAI stub', latency_ms: EMBED_LATENCY_MS } : null },
    machine: machineInfo(), build, notes: [...new Set(notes)],
    get_page: stats(ok('get_ms')), search: stats(ok('search_ms')), exit: stats(reps.map(r => r.exit_ms).filter((x): x is number => typeof x === 'number')),
    phases: phaseStats, failures: reps.filter(r => r.error || (r.source !== 'none' && r.source !== 'exit' && r.search_ms === null)).length, reps, log: logFile,
  };
  const file = join(outDir, cellId + '.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  if (JSON_OUT) console.log(JSON.stringify(result));
  log('wrote ' + file + ': search p50 ' + result.search.p50 + ' p95 ' + result.search.p95 + ' max ' + result.search.max + ' cv ' + result.search.cv + ' (n=' + result.search.n + ')');
}

function report(dirs: string): void {
  const rows = dirs.split(',').flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))).filter(r => r.schema === 'gbrain-sync-freshness/1')
    .sort((a, b) => a.cell.localeCompare(b.cell));
  const s = (x: Stats | undefined) => x && x.n ? (x.p50 !== null ? (x.p50 / 1000).toFixed(2) : '-') + ' / ' + (x.p95 !== null ? (x.p95 / 1000).toFixed(2) : '-') + ' / ' + (x.max !== null ? (x.max / 1000).toFixed(2) : '-') : '-';
  const ph = (r: any) => Object.entries(r.phases as Record<string, Stats>).filter(([k, v]) => v.n && v.p50 !== null && !['written', 'spawn_after_commit_ms', 'submit_cli_ms'].includes(k)).map(([k, v]) => k + ' ' + (v.p50! / 1000).toFixed(2)).join(', ');
  console.log('| cell | engine | mode | pages | commit | trigger | rtt | n | get_page p50/p95/max s | search p50/p95/max s | search cv | exit p50/p95/max s | phases (p50 s) | gbrain |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const p = r.params;
    console.log('| ' + [r.cell, p.engine, p.mode, p.pages, p.commit + (p.scenario !== 'plain' ? ' (' + p.scenario + ')' : ''), p.trigger + (p.interval_s ? ' ' + p.interval_s + 's' : ''), p.rtt_ms ? p.rtt_ms + ' ms' : '0',
      r.search.n + '/' + p.reps, s(r.get_page), s(r.search), r.search.cv ?? '-', s(r.exit), ph(r), r.gbrain_rev].join(' | ') + ' |');
  }
}

await main();
process.exit(0);
