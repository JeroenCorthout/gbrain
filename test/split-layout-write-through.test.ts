/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the unmanaged write-through on a split page.
 *
 * 1. Protects: `writePageThrough` and `deletePageThrough` (write-through.ts), the direct writers of an unmanaged brain
 *    (brainstorm --save, the cycle's derived pages, sync's re-export), are routes outside the publication door, and
 *    only the strict door of a git-canonical source changes a split page (option B). So both skip a split page outright
 *    with `split_page_unsupported` (reason `outside_door`) before any file or row is written or bound, whatever the
 *    write would change (the parts, the head alone, or a page back under the threshold), whatever `expectedFileBytes`
 *    holds (the page file F', the raw head, nothing), and also when the head's parts no longer verify (no file_changed or
 *    hold code first): the head, every part and the page row stay byte for byte, and no temporary copy is left.
 * 2. Fails when: the write-through renders the page over the head as one file (orphaning the parts), rewrites the head,
 *    writes or removes a part, unlinks the head, binds or changes the row, or reports file_changed instead of the
 *    split refusal.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests, partsDirFor } from '../src/core/split-layout/index.ts';
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

/** The page row as stored (every column), so a refused write that bound or changed it shows. */
const pageRow = (engine: BrainEngine) => engine.executeRaw("SELECT * FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]);

/** Every file and the row, and no temporary copy beside the head: what a refused write-through leaves as it was. */
async function state(engine: BrainEngine, root: string) {
  return { files: layout(root), row: await pageRow(engine), tmp: readdirSync(join(root, 'notes')).filter(name => name.includes('.tmp')) };
}

/** A logger that keeps the warnings: the refusal names its reason. */
const warnings = () => { const lines: string[] = []; return { lines, logger: { info() {}, warn(line: string) { lines.push(line); }, error() {} } }; };

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

  for (const expected of ['page file', 'unbound'] as const) test(`writePageThrough refuses a page whose part files the write would change (split_page_unsupported, outside_door, ${expected} preimage): every file and the row are kept`, () => withSplitPage(databaseUrl, async (engine, root) => {
    const before = await state(engine, root);
    const warned = warnings();
    expect(await writePageThrough(engine, SLUG, { ...(expected === 'page file' ? { expectedFileBytes: file } : {}), logger: warned.logger })).toMatchObject({ written: false, skipped: 'split_page_unsupported' });
    expect(warned.lines.some(line => line.includes('split_page_unsupported (outside_door)'))).toBe(true);
    expect(await state(engine, root)).toEqual(before);
  }), 120_000);

  test('writePageThrough refuses a frontmatter-only edit whose parts would all stay (split_page_unsupported, outside_door): the head, every part and the row stay byte for byte', () => withSplitPage(databaseUrl, async (engine, root) => {
    await engine.putPage(SLUG, { type: 'note', title: 'Split example retitled', compiled_truth: body });
    const before = await state(engine, root);
    const warned = warnings();
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: file, logger: warned.logger })).toMatchObject({ written: false, skipped: 'split_page_unsupported' });
    expect(warned.lines.some(line => line.includes('split_page_unsupported (outside_door)'))).toBe(true);
    expect(await state(engine, root)).toEqual(before);
  }), 120_000);

  test('a page back under the threshold is refused (split_page_unsupported, outside_door): the head, its parts and the row are kept', () => withSplitPage(databaseUrl, async (engine, root) => {
    await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: `A short page now. ${DB_EDIT}\n` });
    const before = await state(engine, root);
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: file })).toMatchObject({ written: false, skipped: 'split_page_unsupported' });
    expect(await state(engine, root)).toEqual(before);
  }), 120_000);

  test('a preimage of the raw head, or a head whose parts no longer verify, refuses split_page_unsupported (outside_door) before any file_changed check, with every file and the row kept', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const before = await state(engine, root);
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: head })).toMatchObject({ written: false, skipped: 'split_page_unsupported' });
    expect(await deletePageThrough(engine, SLUG, { expectedFileBytes: head })).toMatchObject({ removed: false, skipped: 'split_page_unsupported' });
    expect(await state(engine, root)).toEqual(before);
    const dir = partsDirFor(join(root, SLUG + '.md'));
    unlinkSync(join(dir, readdirSync(dir).sort()[0]!));
    const broken = await state(engine, root);
    const warned = warnings();
    expect(await writePageThrough(engine, SLUG, { expectedFileBytes: file, logger: warned.logger })).toMatchObject({ written: false, skipped: 'split_page_unsupported' });
    expect(await deletePageThrough(engine, SLUG, { expectedFileBytes: file, logger: warned.logger })).toMatchObject({ removed: false, skipped: 'split_page_unsupported' });
    expect(warned.lines.filter(line => line.includes('split_page_unsupported (outside_door)'))).toHaveLength(2);
    expect(await state(engine, root)).toEqual(broken);
  }), 120_000);

  test('deletePageThrough refuses a split page (split_page_unsupported, outside_door), even bound to its bytes: the head, every part and the row stay', () => withSplitPage(databaseUrl, async (engine, root) => {
    const before = await state(engine, root);
    expect(await deletePageThrough(engine, SLUG, { expectedFileBytes: file })).toEqual({ removed: false, path: join(root, SLUG + '.md'), skipped: 'split_page_unsupported' });
    expect(await state(engine, root)).toEqual(before);
  }), 120_000);
});
