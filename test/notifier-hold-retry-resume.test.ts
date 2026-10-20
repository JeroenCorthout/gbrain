/**
 * GBRA-133 PR 3 item 5: the commit notifier resumes a source that has unconsumed `sync-hold-retry` paths (a re-screen
 * `gbrain sources retry-held`, `gbrain sync unblock` or a post-sync heal scheduled), not only one whose HEAD moved or
 * that has a wanted marker. Driven through the notifier's seams with a fake clock; every case asserts the recorded
 * decisions. Before PR 3 a scheduled re-screen waited for the next commit, autopilot or a manual sync.
 *   - a source whose HEAD equals the last synced commit but has retry paths is recorded `hold_retry_due` and started once,
 *     with sync.on_commit off; once the run consumed the paths it converges and starts nothing more;
 *   - a run that leaves the paths unconsumed (no progress) is retried on the capped failure backoff
 *     (`hold_retry_unconsumed`), never in a tight loop;
 *   - a store without the read (an older adapter) keeps the old behavior.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { startServeHeadWatcher, type OnCommitJobStatus, type ServeHeadWatcherOptions } from '../src/core/serve-head-watcher.ts';
import { RETRY_BACKOFF_MS } from '../src/core/commit-notifier.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';

const A = 'a'.repeat(40);
const QUIET = 400;

function harness(init: { flag?: boolean; holdRetries?: boolean } = {}) {
  const s = { t: 1_000_000, head: A, dbCommit: A as string | null, flag: init.flag ?? true, retry: new Set<string>(), reads: 0,
    starts: [] as Array<{ id: string; jobId: string; intent: string }>, jobs: new Map<string, OnCommitJobStatus>(), lines: [] as string[] };
  const store = memoryNotifierStore({ lastCommit: () => s.dbCommit });
  if (init.holdRetries !== false) Object.assign(store, { holdRetries: async (ids: string[]) => { s.reads++; return new Set(ids.filter(id => s.retry.has(id))); } });
  const w = startServeHeadWatcher({} as BrainEngine, {
    log: line => s.lines.push(line), pollMs: 3000, debounceMs: QUIET, hostId: 'host-example', store,
    now: () => s.t, setInterval: () => 'interval', clearInterval: () => {}, setTimeout: () => 'timer', clearTimeout: () => {},
    readFlag: async () => s.flag,
    listSources: async () => [{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: null, lastCommit: s.dbCommit }],
    lastCommit: async () => s.dbCommit,
    revParse: async () => s.head,
    syncRunning: () => false,
    drainHeld: async () => false,
    startSync: async (id, req) => { const jobId = `job-${s.starts.length + 1}`; s.starts.push({ id, jobId, intent: req.intent }); s.jobs.set(jobId, { state: 'running' }); return { jobId }; },
    jobStatus: (jobId) => s.jobs.get(jobId) ?? null,
  } as ServeHeadWatcherOptions);
  const decisions = (kind?: string) => w.decisions.filter(d => !kind || d.decision === kind);
  return { w, s, decisions, advance: (ms: number) => { s.t += ms; } };
}

describe('the notifier resumes on scheduled re-screens (GBRA-133 PR 3 item 5)', () => {
  test('retry paths with HEAD at the last synced commit start one sync with sync.on_commit off; consumed, the source converges', async () => {
    const h = harness({ flag: false });
    await h.w.tick();
    expect(h.s.starts).toEqual([]);
    h.s.retry.add('acme-example');
    h.advance(3000); await h.w.tick();
    expect(h.decisions('hold_retry_due').map(d => [d.source, d.detail])).toEqual([['acme-example', 'sync-hold-retry paths']]);
    expect(h.s.starts.map(x => [x.id, x.intent])).toEqual([['acme-example', 'freshness']]);
    expect(h.s.lines.some(l => l.includes('held files wait for a scheduled re-screen'))).toBe(true);
    h.s.retry.delete('acme-example');
    h.s.jobs.set('job-1', { state: 'done', outcome: 'synced' });
    h.advance(3000); await h.w.tick();
    expect(h.decisions('converged').length).toBe(1);
    for (let i = 0; i < 4; i++) { h.advance(3000); await h.w.tick(); }
    expect(h.s.starts.length).toBe(1);
    expect(h.decisions('retry')).toEqual([]);
  });

  test('a run that leaves the retry paths unconsumed backs off (5 s first) instead of looping', async () => {
    const h = harness();
    h.s.retry.add('acme-example');
    await h.w.tick();
    expect(h.s.starts.length).toBe(1);
    h.s.jobs.set('job-1', { state: 'done', outcome: 'synced' });
    h.advance(1000); await h.w.tick();
    const retry = h.decisions('retry');
    expect(retry.map(d => [d.detail, d.waitMs])).toEqual([['hold_retry_unconsumed', RETRY_BACKOFF_MS[0]]]);
    expect(h.s.starts.length).toBe(1);
    h.advance(1000); await h.w.tick();
    expect(h.s.starts.length).toBe(1);
    expect(h.decisions('defer_retry').length).toBeGreaterThan(0);
    h.advance(RETRY_BACKOFF_MS[0]!); await h.w.tick();
    expect(h.s.starts.length).toBe(2);
  });

  test('a store without the retry read keeps the old behavior: nothing starts', async () => {
    const h = harness({ holdRetries: false });
    h.s.retry.add('acme-example');
    for (let i = 0; i < 3; i++) { await h.w.tick(); h.advance(3000); }
    expect(h.s.starts).toEqual([]);
    expect(h.decisions('hold_retry_due')).toEqual([]);
  });
});
