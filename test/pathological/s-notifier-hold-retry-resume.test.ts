/**
 * GBRA-133 PR 3 item 5, on a real brain: a re-screen `gbrain sources retry-held` schedules (a `sync-hold-retry` row) is
 * picked up by the resident notifier within seconds, with HEAD unchanged, no wanted marker and sync.on_commit off. The
 * notifier records `hold_retry_due`, starts one managed sync that consumes the request, then converges and starts
 * nothing more. Before PR 3 the request waited for the next commit, autopilot or a manual sync (the case times out).
 * Real git, real store, real delegated runner. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { retryHeld } from '../../src/commands/sources-retry-held.ts';
import { startServeHeadWatcher } from '../../src/core/serve-head-watcher.ts';
import { __resetDelegatedSyncForTests, isDelegatedSyncRunning } from '../../src/core/serve-sync-runner.ts';
import { readGitHoldRetryPaths, readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function until(what: string, fn: () => Promise<boolean>, lines: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${JSON.stringify(lines)}`);
    await Bun.sleep(100);
  }
}
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!.incarnation;
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]?.last_commit ?? null;

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`the notifier resumes a scheduled re-screen by itself (${backend})`, () => {
    test('retry-held with HEAD unchanged: hold_retry_due, one managed sync consumes the request, then nothing more', async () => {
      await managedBrain(async ({ engine, root }) => {
        __resetDelegatedSyncForTests();
        await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true });
        const head = git(root, 'rev-parse', 'HEAD');
        expect(await lastCommit(engine)).toBe(head);
        const held = (await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? [];
        expect(held.map(h => [h.path, h.code])).toEqual([['notes/standup-example.md', 'invalid_frontmatter']]);
        await engine.setConfig('sync.on_commit', 'false');
        const retry = await retryHeld(engine, 'default');
        expect(retry.items.map(item => item.key)).toEqual(['notes/standup-example.md']);
        expect(await readGitHoldRetryPaths(engine, 'default', await incarnation(engine))).toEqual(['notes/standup-example.md']);

        const lines: string[] = [];
        const watcher = startServeHeadWatcher(engine, { log: line => lines.push(line), pollMs: 1000, debounceMs: 100 });
        try {
          await until('the scheduled re-screen to be consumed', async () => (await readGitHoldRetryPaths(engine, 'default', await incarnation(engine))).length === 0
            && watcher.decisions.some(d => d.decision === 'start') && !isDelegatedSyncRunning(), lines, 30_000);
          await until('the notifier to converge', async () => watcher.decisions.some(d => d.decision === 'converged'), lines, 15_000);
          await Bun.sleep(3000);
          const decisions = watcher.decisions.filter(d => d.source === 'default');
          expect(decisions.filter(d => d.decision === 'hold_retry_due').length).toBe(1);
          expect(decisions.filter(d => d.decision === 'start').length).toBe(1);
          expect(decisions.filter(d => d.decision === 'retry')).toEqual([]);
          expect(decisions.findIndex(d => d.decision === 'hold_retry_due')).toBeLessThan(decisions.findIndex(d => d.decision === 'start'));
          expect(lines.some(line => line.includes('held files wait for a scheduled re-screen'))).toBe(true);
        } finally {
          await watcher.stop();
          await until('the runner to idle', async () => !isDelegatedSyncRunning(), [], 60_000).catch(() => undefined);
          __resetDelegatedSyncForTests();
        }
        expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
        const after = (await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? [];
        expect(after.map(h => [h.path, h.code])).toEqual([['notes/standup-example.md', 'invalid_frontmatter']]);
      }, { databaseUrl, setup: ({ root }) => {
        git(root, 'init', '-q');
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, 'notes/clean-example.md'), '---\ntitle: Clean Example\n---\nA synthetic note.\n');
        writeFileSync(join(root, 'notes/standup-example.md'), '---\ntitle: Standup with acme-example\nthe team agreed to ship on Friday\n---\nDaily standup notes.\n');
        git(root, 'add', '-A');
        git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'init');
      } });
    }, 180_000);
  });
}
