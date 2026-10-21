/**
 * #6712 PR 4b flake: the loop-lag bounds (test/sync-pass-shared-budget-6712.test.ts, test/sync-pass-loop-lag-6712.test.ts)
 * read wall time between timer runs, so a loaded CI VM that kept the thread off the CPU counted as code holding the loop:
 * a forced 60 ms stretch read 133 ms against the 100 ms bound on a 4-vCPU shard. Pinned to one core with three CPU hogs,
 * the shared-budget test read 156-257 ms; per-gap schedstat showed the excess as run-queue wait plus sleeps behind a
 * spawned Git that had not reached exec, with the thread's own CPU at 61-69 ms. `watchLoopLag` reads the thread's CPU.
 *
 * Forced probe (deterministic): the thread blocks 150 ms in a synchronous child process with a timer due, as it does
 * behind a spawned Git that has not reached exec. The wall clock reads it as 150 ms of lag; the thread's CPU clock, read
 * on both sides of the call, does not move (nothing else can run on the thread during a synchronous call, so work left
 * over from an earlier test file in the same process cannot land in the reading). The CPU clock still sees a stretch of
 * work, and two stretches in one turn, the regression the bounds exist to catch.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { threadCpuNow } from './helpers/cpu-time.ts';

/** The bound the loop-lag tests hold. */
const MAX_LAG_MS = 100;
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 20));
/** Blocks the thread off the CPU for `ms` in a synchronous child; returns the thread CPU the call itself cost. */
const offCpu = (ms: number) => { const start = threadCpuNow(); execFileSync('sleep', [String(ms / 1000)]); return threadCpuNow() - start; };

test('a thread kept off the CPU with a timer due is not lag; the wall clock reads it as lag', async () => {
  let last = performance.now(), wallLag = 0;
  const wall = setInterval(() => { const now = performance.now(); wallLag = Math.max(wallLag, now - last - 5); last = now; }, 5);
  await turn();
  const cpu = offCpu(150);
  await turn();
  clearInterval(wall);
  expect(Math.round(wallLag)).toBeGreaterThanOrEqual(MAX_LAG_MS + 40);
  // The spawn itself costs a few ms of the thread's CPU (fork, pipes); the 150 ms off the CPU cost none.
  expect(Math.round(cpu)).toBeLessThan(MAX_LAG_MS / 4);
});

test('a stretch of work is lag on the CPU clock, and two stretches in one turn add up', () => {
  // In a fresh process: the reading covers every task on the thread between two timer runs, and in a shared shard
  // process work an earlier test file left running lands there too (a 60 ms stretch read 106 ms on a GitHub shard).
  const helper = JSON.stringify(join(import.meta.dir, 'helpers', 'cpu-time.ts'));
  const probe = `import { spinCpuMs, watchLoopLag } from ${helper};
    const turn = () => new Promise(resolve => setTimeout(resolve, 20));
    const one = watchLoopLag();
    await turn(); spinCpuMs(60); await turn();
    const single = one.stop();
    const two = watchLoopLag();
    await turn(); spinCpuMs(60); spinCpuMs(60); await turn();
    console.log(JSON.stringify({ single, two: two.stop() }));`;
  const { single, two } = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim().split('\n').pop()!) as Record<'single' | 'two', { maxLag: number; ticks: number }>;
  expect(single.ticks).toBeGreaterThan(0);
  expect(Math.round(single.maxLag)).toBeGreaterThanOrEqual(60);
  expect(Math.round(single.maxLag)).toBeLessThan(MAX_LAG_MS);
  expect(Math.round(two.maxLag)).toBeGreaterThanOrEqual(120);
});
