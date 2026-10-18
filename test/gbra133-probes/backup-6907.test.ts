/**
 * GBRA-133 lane D probe for #6907 (backup check). Desired behavior, so each
 * assertion is red on master c8354664 and should go green with the fix:
 *  1. a dirty repo whose `git status --porcelain` output exceeds 1 MiB is
 *     reported `dirty`, not `unknown / probe_failed` (repository.ts:47-51 maxBuffer);
 *  2. a remote that answers in ~3 s is `verified` when the remote timeout allows it
 *     (repository.ts:13 BACKUP_REMOTE_TIMEOUT_MS = 2_000).
 * It also prints how long the synchronous git probes block the event loop
 * (repository.ts `git()` is execFileSync; a stdio serve runs it in-process
 * through maybeRefreshBackupStatusInProcess, coverage.ts:511-535).
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { assessBackupRepository } from '../../src/core/backup/repository.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function pushedRepo(origin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbra133-backup-')); dirs.push(dir);
  const root = join(dir, 'brain'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.md'), '# a\n');
  git(root, 'add', '-A'); git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'a');
  git(root, 'remote', 'add', 'origin', origin);
  return root;
}

test('#6907: a dirty repo with more than 1 MiB of porcelain output reads dirty, not probe_failed', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'gbra133-bare-')); dirs.push(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const root = pushedRepo(bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const name = 'x'.repeat(90);
  for (let d = 0; d < 120; d++) {
    mkdirSync(join(root, `inbox-${d}`));
    for (let i = 0; i < 100; i++) writeFileSync(join(root, `inbox-${d}`, `${name}-${i}.md`), 'v1\n');
  }
  git(root, 'add', '-A'); git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'bulk');
  git(root, 'push', '-q', 'origin', 'main');
  for (let d = 0; d < 120; d++) for (let i = 0; i < 100; i++) writeFileSync(join(root, `inbox-${d}`, `${name}-${i}.md`), 'v2\n');
  const porcelainBytes = execFileSync('git', ['-C', root, 'status', '--porcelain'], { maxBuffer: 64 << 20 }).length;
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const started = performance.now();
  const verdict = await assessBackupRepository(root, 'source_repo', 'probe', new Date());
  const ms = performance.now() - started; lag.disable();
  console.log(`[gbra133 #6907] porcelain=${porcelainBytes}B state=${verdict.state} detail=${verdict.detail} assess_ms=${ms.toFixed(0)} loop_max_ms=${(lag.max / 1e6).toFixed(0)}`);
  expect(verdict.state).toBe('dirty');
}, 120_000);

test('#6907: a remote that answers in about 3 s can still be verified', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'gbra133-bare-')); dirs.push(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = pushedRepo(bare);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await Bun.sleep(Number(process.env.GBRA133_REMOTE_DELAY_MS ?? 3_000));
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/info/refs')) return new Response('not found', { status: 404 });
      const out = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare]);
      const head = Buffer.from('001e# service=git-upload-pack\n0000');
      return new Response(Buffer.concat([head, out]), { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    },
  });
  try {
    git(seed, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.port}/repo.git`);
    const started = performance.now();
    const verdict = await assessBackupRepository(seed, 'source_repo', 'probe', new Date(), { remaining: 1 });
    console.log(`[gbra133 #6907] slow remote (3 s) ms=${(performance.now() - started).toFixed(0)} verification=${JSON.stringify(verdict.verification)}`);
    expect(verdict.verification.state).toBe('verified');
  } finally { server.stop(true); }
}, 60_000);
