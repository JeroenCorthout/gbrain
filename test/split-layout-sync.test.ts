/**
 * Split git layout read path (Wave B PR 5 lane 5c, design §3): classic sync over a split page head.
 *
 * Protects: a head whose parts verify imports as exactly the page its reassembled file F' is (slug, source_path and
 * content hash as if F' sat at the head's path), and the private scratch file is removed; a head whose parts are
 * missing, unlisted or changed is held `split_page_incomplete`, and one whose body was edited `split_head_modified`;
 * a held head never imports the short head as the page and never changes the stored page; restoring the parts clears
 * the hold on the next sync without touching the head; a part changed with no head change is caught by the next full
 * pass; a stray parts directory imports nothing, even with --include-hidden.
 * Regression it catches: any reader that imports the head as an ordinary short page (what a pre-PR-5 binary does),
 * imports a partial reassembly, or lets --include-hidden import a file inside a parts directory.
 * Engines: PGLite always; Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 * Seam: __setSplitLimitsForTests (KB-sized parts and lead).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { __setSplitLimitsForTests, splitStagingDir } from '../src/core/split-layout/index.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const T = 120_000;
const SMALL = { thresholdMin: 1, partTarget: 256, partMax: 512, leadMax: 128, partCountMax: 500 };
const HEAD = 'notes/big-page.md';
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let engine: BrainEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-split-sync-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

/** A canonical page file F: frontmatter, then a multi-part body that names its version. */
function pageFile(version: string, lines = 40): string {
  const body = Array.from({ length: lines }, (_, i) => `Line ${i} of the ${version} synthetic acme-example roadmap page, long enough to fill parts.`).join('\n');
  return `---\ntitle: Big page\ntype: note\ntags:\n  - roadmap\n---\n\n${body}\n`;
}

beforeAll(async () => {
  __setSplitLimitsForTests(SMALL);
  if (backends.includes('pglite')) {
    const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const each of engines) await each.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);

afterAll(async () => {
  __setSplitLimitsForTests(null);
  for (const each of engines) if (each.kind === 'pglite') await each.disconnect();
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const eachEngine = (fn: () => Promise<void>) => withEnv(env, async () => {
  for (const each of engines) { engine = each; await fn(); }
});

async function source(): Promise<{ id: string; root: string }> {
  const id = `ss-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); await makeGitFixture(root);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  return { id, root };
}

const commitAll = (root: string, message = 'fixture') => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const sync = (s: { id: string; root: string }, extra: { full?: boolean; includeHidden?: string[] } = {}) =>
  performSync(engine, { repoPath: s.root, sourceId: s.id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, ...extra });

async function page(sourceId: string, slug = 'notes/big-page') {
  const [row] = await engine.executeRaw<{ compiled_truth: string; timeline: string; title: string; type: string; frontmatter: unknown; content_hash: string; source_path: string }>(
    'SELECT compiled_truth, timeline, title, type, frontmatter, content_hash, source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return row;
}

async function holds(sourceId: string) {
  return ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: hold.code }));
}

/** A source whose split head (version v1) imported. */
async function importedSplit(version = 'v1') {
  const s = await source();
  const written = await writeSplitPage(s.root, HEAD, pageFile(version));
  expect(written.parts.length).toBeGreaterThan(3);
  commitAll(s.root);
  await sync(s);
  expect((await page(s.id))?.compiled_truth).toContain(`Line 39 of the ${version}`);
  return { ...s, written };
}

const scratchFiles = () => readdirSync(splitStagingDir()).filter(name => name.endsWith('.reassembled'));

test('a verified split head imports as the page F is, under the head path; the scratch file is removed', () => eachEngine(async () => {
  const split = await importedSplit();
  const control = await source();
  writeFileSync(join(control.root, HEAD), pageFile('v1'));
  commitAll(control.root);
  await sync(control);
  const [got, want] = [await page(split.id), await page(control.id)];
  expect(got).toEqual(want);
  expect(got!.source_path).toBe(HEAD);
  expect(got!.compiled_truth).not.toContain('[gbrain]');
  expect(got!.frontmatter).not.toHaveProperty('gbrain_parts');
  expect(await holds(split.id)).toEqual([]);
  expect(scratchFiles()).toEqual([]);
}), T);

test('missing, unlisted and changed parts hold the head split_page_incomplete; the page keeps v1 until the parts are restored', () => eachEngine(async () => {
  const breakages: Array<[string, (root: string, written: Awaited<ReturnType<typeof writeSplitPage>>) => void]> = [
    ['missing', (root, written) => unlinkSync(join(root, written.parts[2]!.rel))],
    ['unlisted', (root, written) => writeFileSync(join(root, written.partsDir, '9999-deadbeef.gbpart'), 'stray\n')],
    ['changed', (root, written) => appendFileSync(join(root, written.parts[1]!.rel), 'tampered\n')],
  ];
  for (const [label, breakIt] of breakages) {
    const s = await importedSplit();
    const before = await page(s.id);
    rmSync(join(s.root, s.written.partsDir), { recursive: true });
    const v2 = await writeSplitPage(s.root, HEAD, pageFile('v2'));
    breakIt(s.root, v2);
    commitAll(s.root, `v2 with a ${label} part`);
    const result = await sync(s);
    expect({ label, held: result.held?.map(hold => [hold.path, hold.code]) }).toEqual({ label, held: [[HEAD, 'split_page_incomplete']] });
    expect(await holds(s.id)).toEqual([{ path: HEAD, code: 'split_page_incomplete' }]);
    expect(await page(s.id)).toEqual(before);
    // Restoring the parts (the head unchanged) clears the hold on the next sync.
    rmSync(join(s.root, v2.partsDir), { recursive: true });
    await writeSplitPage(s.root, HEAD, pageFile('v2'));
    commitAll(s.root, 'restore the parts');
    await sync(s);
    expect(await holds(s.id)).toEqual([]);
    expect((await page(s.id))?.compiled_truth).toContain('Line 39 of the v2');
  }
}), T);

test('an edited head body is held split_head_modified and never imported as the short head', () => eachEngine(async () => {
  const s = await importedSplit();
  const before = await page(s.id);
  writeFileSync(join(s.root, HEAD), s.written.head.replace('Line 0 of the v1', 'Line 0 of the edited'));
  commitAll(s.root, 'edit the lead');
  await sync(s);
  expect(await holds(s.id)).toEqual([{ path: HEAD, code: 'split_head_modified' }]);
  expect(await page(s.id)).toEqual(before);
}), T);

test('a part changed without a head change is caught by the next full pass', () => eachEngine(async () => {
  const s = await importedSplit();
  const before = await page(s.id);
  appendFileSync(join(s.root, s.written.parts[0]!.rel), 'tampered\n');
  commitAll(s.root, 'edit a part only');
  await sync(s, { full: true });
  expect(await holds(s.id)).toEqual([{ path: HEAD, code: 'split_page_incomplete' }]);
  expect(await page(s.id)).toEqual(before);
}), T);

test('a stray parts directory with no head imports nothing, with or without --include-hidden', () => eachEngine(async () => {
  const s = await source();
  writeFileSync(join(s.root, 'notes', 'plain.md'), '---\ntitle: Plain\n---\nAn ordinary page.\n');
  commitAll(s.root);
  await sync(s);
  const stray = join(s.root, 'notes', '.orphan.gbparts');
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, '0001-deadbeef.gbpart'), 'a part with no head\n');
  writeFileSync(join(stray, 'stray-page.md'), '---\ntitle: Stray\n---\nA page file inside a parts directory.\n');
  commitAll(s.root, 'a stray parts directory');
  for (const extra of [{}, { includeHidden: ['notes/**'] }, { includeHidden: ['notes/**'], full: true }]) {
    await sync(s, extra);
    const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [s.id]);
    expect({ extra, slugs: rows.map(row => row.slug) }).toEqual({ extra, slugs: ['notes/plain'] });
    expect(await holds(s.id)).toEqual([]);
  }
}), T);
