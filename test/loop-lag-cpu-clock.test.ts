/**
 * #6712 PR 4b flake: the loop-lag bounds (test/sync-pass-shared-budget-6712.test.ts, test/sync-pass-loop-lag-6712.test.ts)
 * read wall time between timer runs, so a loaded CI VM that kept the thread off the CPU counted as code holding the loop:
 * a forced 60 ms stretch read 133 ms against the 100 ms bound on a 4-vCPU shard. Pinned to one core with three CPU hogs,
 * the shared-budget test read 156-257 ms; per-gap schedstat showed the excess as run-queue wait plus sleeps behind a
 * spawned Git that had not reached exec, with the thread's own CPU at 61-69 ms. `watchLoopLag` reads the thread's CPU.
 *
 * Forced probe (deterministic): the thread sleeps 150 ms with a timer due (`Atomics.wait`, as it does on a run queue
 * or behind a child's exec). The wall clock reads it as 150 ms of lag; the CPU clock does not. The CPU clock still sees a
 * stretch of work, and two stretches in one turn, the regression the bounds exist to catch.
 */
import { expect, test } from 'bun:test';
import { spinCpuMs, watchLoopLag } from './helpers/cpu-time.ts';

/** The bound the loop-lag tests hold. */
const MAX_LAG_MS = 100;
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const offCpu = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a thread kept off the CPU with a timer due is not lag; the wall clock reads it as lag', async () => {
  const lag = watchLoopLag();
  let last = performance.now(), wallLag = 0;
  const wall = setInterval(() => { const now = performance.now(); wallLag = Math.max(wallLag, now - last - 5); last = now; }, 5);
  await turn();
  offCpu(150);
  await turn();
  clearInterval(wall);
  expect(Math.round(wallLag)).toBeGreaterThanOrEqual(MAX_LAG_MS + 40);
  expect(Math.round(lag.stop().maxLag)).toBeLessThan(MAX_LAG_MS);
});

test('a stretch of work is lag on the CPU clock, and two stretches in one turn add up', async () => {
  const one = watchLoopLag();
  await turn(); spinCpuMs(60); await turn();
  const single = one.stop();
  expect(single.ticks).toBeGreaterThan(0);
  expect(Math.round(single.maxLag)).toBeGreaterThanOrEqual(60);
  expect(Math.round(single.maxLag)).toBeLessThan(MAX_LAG_MS);
  const two = watchLoopLag();
  await turn(); spinCpuMs(60); spinCpuMs(60); await turn();
  expect(Math.round(two.stop().maxLag)).toBeGreaterThanOrEqual(120);
});
