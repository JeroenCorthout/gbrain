/**
 * Split git layout secret scan (Wave B PR 5 lane 5c, design §3): `scanFiles` and the pre-push gate over split pages.
 *
 * Protects: a split head brings its part files into `scanFiles` (each scanned whole) so a secret inside one part is
 * found and attributed to that part; a secret cut across a part boundary (a forced cut inside a long line), which no
 * part shows whole, is found by the seam scan (the last 64 KiB of part k joined with the first 64 KiB of part k+1) and
 * reported against part k with the next part and the match's byte offset; a part over the per-file scan cap follows
 * the cap rules: `scanFiles` skips it whole (as it skips any file over SCAN_MAX_FILE_BYTES), and the push gate streams
 * it whole and refuses its seams as unscannable (fail closed).
 * Regression it catches: a scan that sees only the files a caller listed (the head) or only whole parts, or a push
 * gate that commits a split page whose seam hides a secret.
 * Seam: __setSplitLimitsForTests (256 KiB parts, so a 64 KiB seam window is a strict part of each part).
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCAN_MAX_FILE_BYTES, scanFiles } from '../src/core/secret-scan.ts';
import { SPLIT_SEAM_SCAN_BYTES } from '../src/core/secret-scan-split.ts';
import { __setSplitLimitsForTests } from '../src/core/split-layout/index.ts';
import { PUSH_MAX_SCAN_BYTES, workspacePush } from '../src/core/workspace-push.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { withEnv } from './helpers/with-env.ts';

const T = 120_000;
const LIMITS = { thresholdMin: 1, partTarget: 128 * 1024, partMax: 256 * 1024, leadMax: 1024, partCountMax: 500 };
const GITHUB = 'gh' + 'p_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const OPENAI = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4P5q6R7s8';
const HEAD = 'notes/big-page.md';
const FRONTMATTER = '---\ntitle: Big page\ntype: note\n---\n';
const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-split-scan-')); });
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => __setSplitLimitsForTests(null));

/** A body of short lines with `secretLine` at line `at`. */
function linesBody(lines: number, secretLine?: { at: number; text: string }): string {
  return Array.from({ length: lines }, (_, i) => (i === secretLine?.at ? secretLine.text : `${i} ${FILLER}`)).join('\n') + '\n';
}

/** One line longer than a part, so the planner cuts it at exactly 256 KiB of the body, with `token` across that cut. */
function cutLineBody(token: string, before = 20): string {
  const cut = LIMITS.partMax, start = cut - before;
  let line = '';
  while (line.length < 3 * cut) line += FILLER + ' ';
  return line.slice(0, start - 1) + ' ' + token + ' ' + line.slice(start + token.length + 1) + '\n';
}

async function splitPage(body: string, root = mkdtempSync(join(home, 'repo-'))) {
  __setSplitLimitsForTests(LIMITS);
  const written = await withEnv({ GBRAIN_HOME: home }, () => writeSplitPage(root, HEAD, FRONTMATTER + body));
  return { root, ...written, abs: (rel: string) => join(root, rel) };
}

test('scanFiles on a split head scans its parts whole: a secret inside one part is found and attributed to that part', async () => {
  const page = await splitPage(linesBody(12_000, { at: 6_000, text: `deploy token ${GITHUB} for the acme-example bot` }));
  const holder = page.parts.find(part => part.content.includes(GITHUB));
  expect(page.parts.length).toBeGreaterThan(3);
  expect(holder).toBeDefined();
  const findings = scanFiles([page.abs(HEAD)]);
  expect(findings.map(f => [f.pattern, f.file])).toEqual([['github_token', page.abs(holder!.rel)]]);
  expect(findings[0]!.line).toBe(holder!.content.subarray(0, holder!.content.indexOf(GITHUB)).toString().split('\n').length);
  expect(JSON.stringify(findings)).not.toContain(GITHUB);
});

test('a secret spanning a part boundary is found by the seam scan, reported against the part where it starts', async () => {
  const page = await splitPage(cutLineBody(GITHUB));
  const [first, second] = page.parts;
  expect(first!.content.length).toBe(LIMITS.partMax);
  expect(first!.content.includes(GITHUB) || second!.content.includes(GITHUB)).toBe(false);
  for (const listed of [[page.abs(HEAD)], [page.abs(HEAD), ...page.parts.map(part => page.abs(part.rel))]]) {
    const findings = scanFiles(listed);
    expect(findings.map(f => ({ pattern: f.pattern, file: f.file, line: f.line, seam: (f as { seam?: unknown }).seam }))).toEqual([{
      pattern: 'github_token', file: page.abs(first!.rel), line: 1,
      seam: { next: page.abs(second!.rel), offset: first!.content.indexOf(GITHUB.slice(0, 10)) - 1 },
    }]);
  }
  expect(SPLIT_SEAM_SCAN_BYTES).toBe(65536);
});

test('scanFiles skips a part over the per-file scan cap, as it skips any file over it, and still scans the other parts', async () => {
  const page = await splitPage(linesBody(12_000, { at: 11_800, text: `second key ${OPENAI} in a later part` }));
  const [oversize] = page.parts;
  writeFileSync(page.abs(oversize!.rel), Buffer.alloc(SCAN_MAX_FILE_BYTES + 1, 0x20));
  appendFileSync(page.abs(oversize!.rel), `\nkey ${GITHUB}\n`);
  expect(scanFiles([page.abs(oversize!.rel)])).toEqual([]);
  const findings = scanFiles([page.abs(HEAD)]);
  expect(findings.map(f => f.pattern)).toEqual(['openai']);
  expect(findings[0]!.file).toBe(page.abs(page.parts.find(part => part.content.includes(OPENAI))!.rel));
});

/** A clone of a local bare remote with one pushed commit; the push gate runs against it. */
function pushWorkspace(): { work: string; env: Record<string, string> } {
  const root = mkdtempSync(join(home, 'push-'));
  const env = { HOME: mkdtempSync(join(root, 'home-')), GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' };
  const run = (cwd: string | null, ...args: string[]) => execFileSync('git', [...(cwd ? ['-C', cwd] : []), '-c', 'protocol.file.allow=always', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, GBRAIN_HOME: env.HOME } });
  const bare = join(root, 'origin.git'), work = join(root, 'work');
  run(null, 'init', '-q', '--bare', '-b', 'main', bare);
  run(null, 'clone', '-q', bare, work);
  run(work, 'config', 'user.email', 't@t.t'); run(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  run(work, 'add', 'README.md'); run(work, 'commit', '-qm', 'init'); run(work, 'push', '-q', 'origin', 'main');
  return { work, env: { ...env, GBRAIN_HOME: env.HOME } };
}

test('the push gate blocks a split page whose secret spans a part boundary, naming the part, the next part and the offset', async () => {
  const { work, env } = pushWorkspace();
  const page = await splitPage(cutLineBody(GITHUB), work);
  const result = await withEnv(env, () => workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true }));
  expect(result.status).toBe('blocked_secrets');
  const [first, second] = page.parts;
  expect(result.findings?.map(f => ({ pattern: f.pattern, file: f.file, seam: (f as { seam?: unknown }).seam }))).toEqual([{
    pattern: 'github_token', file: first!.rel, seam: { next: second!.rel, offset: first!.content.indexOf(GITHUB.slice(0, 10)) - 1 },
  }]);
  expect(execFileSync('git', ['-C', work, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toBe('');
}, T);

test('the push gate streams a part over the whole-read cap and refuses its seams as unscannable (fail closed)', async () => {
  for (const secret of [true, false]) {
    const { work, env } = pushWorkspace();
    const page = await splitPage(linesBody(12_000), work);
    const oversize = page.parts[1]!;
    writeFileSync(page.abs(oversize.rel), Buffer.alloc(PUSH_MAX_SCAN_BYTES + 1, 0x20));
    if (secret) appendFileSync(page.abs(oversize.rel), `\nkey ${GITHUB}\n`);
    const result = await withEnv(env, () => workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true }));
    if (secret) {
      expect(result.status).toBe('blocked_secrets');
      expect(result.findings?.map(f => [f.pattern, f.file])).toEqual([['github_token', oversize.rel]]);
    } else {
      expect(result.status).toBe('blocked_unscannable');
      expect(result.unscannable).toEqual([`${oversize.rel} (split page seam: ${PUSH_MAX_SCAN_BYTES + 1}B exceeds the ${PUSH_MAX_SCAN_BYTES}B whole-read cap)`]);
    }
  }
}, T);
