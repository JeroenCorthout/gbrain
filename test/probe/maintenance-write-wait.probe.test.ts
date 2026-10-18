/**
 * GBRA-133 probe (local triage only): test/maintenance-write-wait.test.ts with
 * per-step timings in submitMaintenance, every PGLite exclusive section
 * (queue wait vs held time, caller), synchronous WASM time per call, consumer
 * phases and event-loop gaps over each measured publish. Appends one JSON line
 * per measured publish to $PROBE_OUT (default /tmp/mww-probe.ndjson).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PgliteStatementCache } from '../../src/core/pglite-statements.ts';
import { maintenancePreflight, publishMaintenancePage } from '../../src/core/persistence/prepared-maintenance.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { withEnv } from '../helpers/with-env.ts';

const OUT = process.env.PROBE_OUT ?? '/tmp/mww-probe.ndjson';
const VERBOSE_MS = Number(process.env.PROBE_VERBOSE_MS ?? 150);
type Op = { id: number; label: string; caller: string; enq: number; acq?: number; rel?: number; sync: number; syncCalls: number };
type Ev = { at: number; what: string };
const ops: Op[] = [];
const events: Ev[] = [];
const als = new AsyncLocalStorage<Op>();
let seq = 0;
const now = () => performance.now();
function caller(): string {
  return (new Error().stack ?? '').split('\n').slice(2)
    .filter(l => l.includes('/src/') && !/pglite-engine|pglite-lifecycle|checkpoint-guard|statement-cache|pglite-executor/.test(l))
    .slice(0, 4).map(l => l.trim().replace(/^at /, '').replace(/\(?\/.*\/src\//, '').replace(/\)$/, '')).join(' < ');
}
const sqlLabel = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 110);
function wrapEntry(name: 'query' | 'exec' | 'transaction') {
  const original = (PGlite.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
  (PGlite.prototype as unknown as Record<string, unknown>)[name] = function (this: PGlite, ...args: unknown[]) {
    const op: Op = { id: ++seq, label: name === 'transaction' ? 'TX' : sqlLabel(args[0]), caller: caller(), enq: now(), sync: 0, syncCalls: 0 };
    ops.push(op); if (ops.length > 20000) ops.splice(0, 10000);
    return als.run(op, () => original.apply(this, args));
  };
}
wrapEntry('query'); wrapEntry('exec'); wrapEntry('transaction');
const cacheProto = PgliteStatementCache.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const origCached = cacheProto.query!;
cacheProto.query = function (this: unknown, sql: unknown, params: unknown, inTransaction: unknown, unnamed: unknown) {
  if (inTransaction) return origCached.call(this, sql, params, inTransaction, unnamed);
  const op: Op = { id: ++seq, label: 'cached: ' + sqlLabel(sql), caller: caller(), enq: now(), sync: 0, syncCalls: 0 };
  ops.push(op);
  return als.run(op, () => origCached.call(this, sql, params, inTransaction, unnamed));
};
const proto = PGlite.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const origExclusive = proto._runExclusiveTransaction!;
proto._runExclusiveTransaction = function (this: PGlite, fn: unknown) {
  const op = als.getStore();
  return origExclusive.call(this, async () => {
    if (op) op.acq = now();
    try { return await (fn as () => Promise<unknown>)(); } finally { if (op) op.rel = now(); }
  });
};
const origSync = proto.execProtocolRawSync!;
proto.execProtocolRawSync = function (this: PGlite, ...args: unknown[]) {
  const started = now();
  try { return origSync.apply(this, args); } finally {
    const ms = now() - started; const op = als.getStore();
    if (op) { op.sync += ms; op.syncCalls++; }
    if (ms > 50) events.push({ at: started, what: 'SYNC ' + ms.toFixed(1) + 'ms in ' + (op ? '#' + op.id + ' ' + op.label : '?') + ' [' + (op?.caller ?? caller()) + ']' });
  }
};
const consumerProto = PersistenceConsumer.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const origPhase = consumerProto.phase!;
consumerProto.phase = async function (this: unknown, name: unknown, run: unknown) {
  const started = now(); events.push({ at: started, what: 'phase ' + String(name) + ' start' });
  try { return await origPhase.call(this, name, run); } finally { events.push({ at: now(), what: 'phase ' + String(name) + ' end (' + (now() - started).toFixed(1) + 'ms)' }); }
};
let probeLabel: string | null = null;
(globalThis as { __mwwProbe?: (step: string) => void }).__mwwProbe = step => { if (probeLabel) events.push({ at: now(), what: probeLabel + ': ' + step }); };
let lastTick = now();
const gapTimer = setInterval(() => { const t = now(); if (t - lastTick > 40) events.push({ at: lastTick, what: 'LOOP GAP ' + (t - lastTick).toFixed(1) + 'ms' }); lastTick = t; }, 5);
gapTimer.unref?.();

async function measured(label: string, publish: () => Promise<unknown>): Promise<{ ms: number; code: string | null }> {
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  probeLabel = label;
  const started = now();
  const code = await publish().then(() => null, (error: unknown) => error instanceof OperationError ? error.code : String(error));
  const ended = now();
  probeLabel = null; loop.disable();
  const ms = ended - started;
  const window = ops.filter(o => o.enq <= ended && (o.rel !== undefined ? o.rel >= started : o.enq >= started - 50));
  const held = window.filter(o => o.acq !== undefined).map(o => ({ o, held: Math.min(o.rel ?? ended, ended) - Math.max(o.acq!, started) }))
    .sort((a, b) => b.held - a.held);
  const evs = events.filter(e => e.at >= started - 50 && e.at <= ended);
  const steps = evs.filter(e => e.what.startsWith(label + ':')).map(e => e.what.slice(label.length + 2) + '@' + (e.at - started).toFixed(1));
  const summary = { label, ms: +ms.toFixed(1), code, loop_max_ms: +(loop.max / 1e6).toFixed(1), loop_p99_ms: +(loop.percentile(99) / 1e6).toFixed(1),
    ops: window.length, sync_ms: +window.reduce((a, o) => a + o.sync, 0).toFixed(1), steps,
    top: held.slice(0, 3).map(({ o, held }) => ({ held: +held.toFixed(1), wait: o.acq ? +(o.acq - o.enq).toFixed(1) : null, sync: +o.sync.toFixed(1), label: o.label, caller: o.caller })),
    rss_mb: Math.round(process.memoryUsage().rss / 1e6), pid: process.pid, at: new Date().toISOString() };
  appendFileSync(OUT, JSON.stringify(summary) + '\n');
  if (ms > VERBOSE_MS) {
    console.log('\n=== SLOW ' + label + ' ' + ms.toFixed(1) + 'ms ===');
    for (const e of evs) console.log('  +' + (e.at - started).toFixed(1).padStart(8) + ' ' + e.what);
    for (const o of window) console.log('  #' + o.id + ' enq+' + (o.enq - started).toFixed(1) + ' acq+' + (o.acq === undefined ? '-' : (o.acq - started).toFixed(1)) + ' rel+' + (o.rel === undefined ? '-' : (o.rel - started).toFixed(1)) + ' sync=' + o.sync.toFixed(1) + '/' + o.syncCalls + ' ' + o.label + ' [' + o.caller + ']');
  }
  return { ms, code };
}

const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-wait-db-'));
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  resetGateway(); rmSync(dataDir, { recursive: true, force: true }); clearInterval(gapTimer);
});

async function fixture(run: (engine: BrainEngine, sourceId: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-wait-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = 'wait-' + randomUUID().slice(0, 8);
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId);
      });
    } finally {
      __setMaintenanceWriteWaitForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
const page = (n: number) => '---\ntitle: Maintenance ' + n + '\ntype: note\n---\nMaintenance output ' + n + '.';

if (process.env.PROBE_SKIP_T2 !== '1') test('t2: commits when the writer frees up after 6.5 s', async () => {
  await fixture(async (engine, sourceId) => {
    const authority = (await maintenancePreflight(engine, sourceId))!;
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    const release = setTimeout(() => { void lock.release(); }, 6_500);
    try {
      const receipt = await publishMaintenancePage(engine, authority, 'wiki/maintenance-wait', page(1), { expectedRevision: null });
      expect((receipt.write_request as { state: string }).state).toBe('committed');
    } finally { clearTimeout(release); await lock.release(); }
  });
}, 60_000);

test('t3: after the first pending publish, later publishes do not wait', async () => {
  await fixture(async (engine, sourceId) => {
    __setMaintenanceWriteWaitForTests(600);
    const authority = (await maintenancePreflight(engine, sourceId))!;
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    let first: { ms: number; code: string | null }, second: { ms: number; code: string | null };
    try {
      first = await measured('t3.first', () => publishMaintenancePage(engine, authority, 'wiki/wait-first', page(1), { expectedRevision: null }));
      second = await measured('t3.second', () => publishMaintenancePage(engine, authority, 'wiki/wait-second', page(2), { expectedRevision: null }));
    } finally { await lock.release(); }
    expect(first.code).toBe('write_pending');
    expect(second.code).toBe('write_pending');
    expect(second.ms).toBeLessThan(300);
  });
}, 60_000);

test('t4: a job at its deadline publishes without waiting', async () => {
  await fixture(async (engine, sourceId) => {
    const authority = (await maintenancePreflight(engine, sourceId, undefined, { deadlineAtMs: Date.now() - 1 }))!;
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    let result: { ms: number; code: string | null };
    try {
      result = await measured('t4', () => publishMaintenancePage(engine, authority, 'wiki/wait-deadline', page(3), { expectedRevision: null }));
    } finally { await lock.release(); }
    expect(result.code).toBe('write_pending');
    expect(result.ms).toBeLessThan(300);
  });
}, 60_000);
