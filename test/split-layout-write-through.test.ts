/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the unmanaged write-through on a split page.
 *
 * 1. Protects: `writePageThrough` and `deletePageThrough` (write-through.ts), the direct writers of an unmanaged brain
 *    (brainstorm --save, the cycle's derived pages, sync's re-export), stay file-first on a split page: the write lays
 *    the database's page out as a head plus parts (split-write-through.ts, the door's split unit), so the reassembled
 *    page file F' is the page the database holds; a page back under the threshold becomes one file with its parts
 *    removed; a delete removes the head and every part. `expectedFileBytes` is the page file F', so a caller that
 *    compared the raw head, or a head whose parts no longer verify, is refused as `file_changed` with every file kept.
 * 2. Fails when: the write-through passes a split page by (the database then holds an edit git never gets), renders
 *    the page over the head as one file (orphaning the parts), or unlinks the head alone.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor } from '../src/core/split-layout/index.ts';
import { readPageFile } from '../src/core/split-layout/page-file.ts';
import { _resetWriteThroughCacheForTest, deletePageThrough, writePageThrough } from '../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdDefault: 1024, thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/big-example';
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`).join('\n');
const file = `---\ntype: note\ntitle: Split example\n---\n\n${body}\n`;
const DB_EDIT = 'An edit only the database holds.';

/** The head and every part file, by name, as they are on disk (null parts: no parts directory). */
const layout = (root: string) => {
  const head = join(root, SLUG + '.md');
  const dir = partsDirFor(head);
  return { head: existsSync(head) ? readFileSync(head, 'utf8') : null,
    parts: existsSync(dir) ? Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')])) : null };
};

/** The page file at the head path as text (F' for a split head). */
const readPageFileText = (path: string) => {
  const page = readPageFile(path);
  return page.hold ? page : { split: page.split, text: page.bytes.toString('utf8') };
};

/** The page file the database's row renders to: what write-through writes. */
async function rendered(engine: BrainEngine): Promise<string> {
  const page = await engine.getPage(SLUG);
  return serializePageToMarkdown(page!, await engine.getTags(SLUG));
}

/** The files agree with the database: the page file reassembles to its render, and the parts directory holds exactly the head's manifest. */
async function expectSplitAgrees(engine: BrainEngine, root: string): Promise<void> {
  const headPath = join(root, SLUG + '.md');
  const page = readPageFileText(headPath);
  expect(page).toMatchObject({ split: true, text: await rendered(engine) });
  const parsed = parseHead(readFileSync(headPath, 'utf8'));
  if (!parsed || 'error' in parsed) throw new Error('the head does not parse');
  expect(readdirSync(partsDirFor(headPath)).sort()).toEqual(parsed.manifest.parts.map(part => part.path.split('/').pop()!).sort());
}

async function withSplitPage(databaseUrl: string | undefined, run: (engine: BrainEngine, root: string, head: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'split-write-through-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      __setSplitLimitsForTests(LIMITS);
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        mkdirSync(join(root, 'notes'), { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: body + `\n\n${DB_EDIT}\n` });
        const written = await writeSplitPage(root, SLUG + '.md', file);
        expect(written.parts.length).toBeGreaterThan(2);
        await run(engine, root, written.head);
      } finally { await close(); _resetWriteThroughCacheForTest(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: the unmanaged write-through`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });

  for (const expected of ['page file', 'unbound'] as const) test(`writePageThrough lays the database's page out as a head plus parts (${expected} preimage)`, () => withSplitPage(databaseUrl, async (engine, root) => {
    const result = await writePageThrough(engine, SLUG, expected === 'page file' ? { expectedFileBytes: file } : {});
    expect(result).toMatchObject({ written: true, path: join(root, SLUG + '.md') });
    await expectSplitAgrees(engine, root);
    expect(readPageFileText(join(root, SLUG + '.md'))).toMatchObject({ text: expect.stringContaining(DB_EDIT) });
  }), 120_000);

  test('a page back under the threshold is written as one file and its parts are removed', () => withSplitPage(databaseUrl, async (engine, root) => {
    await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: `A short page now. ${DB_EDIT}\n` });
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: file })).toMatchObject({ written: true });
    expect(layout(root)).toEqual({ head: await rendered(engine), parts: null });
  }), 120_000);

  test('a preimage that is not the page file, or a head whose parts no longer verify, refuses with every file kept', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const before = layout(root);
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: head })).toMatchObject({ written: false, skipped: 'file_changed' });
    expect(layout(root)).toEqual(before);
    const dir = partsDirFor(join(root, SLUG + '.md'));
    unlinkSync(join(dir, readdirSync(dir).sort()[0]!));
    const broken = layout(root);
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: file })).toMatchObject({ written: false, skipped: 'file_changed' });
    expect(await deletePageThrough(engine, SLUG, { expectedFileBytes: file })).toMatchObject({ removed: false, skipped: 'file_changed' });
    expect(layout(root)).toEqual(broken);
  }), 120_000);

  test('deletePageThrough removes the head and every part', () => withSplitPage(databaseUrl, async (engine, root) => {
    expect(await deletePageThrough(engine, SLUG, { expectedFileBytes: file })).toMatchObject({ removed: true, path: join(root, SLUG + '.md') });
    expect(layout(root)).toEqual({ head: null, parts: null });
  }), 120_000);
});
