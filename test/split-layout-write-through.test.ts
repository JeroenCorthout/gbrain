/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the unmanaged write-through on a split page head.
 *
 * 1. Protects: `writePageThrough` and `deletePageThrough` (write-through.ts), the direct writers of an unmanaged brain
 *    (brainstorm --save, the cycle's derived pages, sync's re-export), never write the page's whole file over a split
 *    head nor unlink the head alone: they pass it by (`skipped: 'split_page_unsupported'`), and the head and every part
 *    keep their bytes. Only the publication door lays a page out as a head plus parts.
 * 2. Fails when: the write-through renders the page over the head (the parts are orphaned and the head stops being a
 *    split head) or removes the head and leaves its parts.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests, partsDirFor } from '../src/core/split-layout/index.ts';
import { _resetWriteThroughCacheForTest, deletePageThrough, writePageThrough } from '../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/big-example';
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`).join('\n');
const file = `---\ntype: note\ntitle: Split example\n---\n\n${body}\n`;

/** The head and every part file, by name, as they are on disk. */
const layout = (root: string) => {
  const head = join(root, SLUG + '.md');
  const dir = partsDirFor(head);
  return { head: readFileSync(head, 'utf8'), parts: Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')])) };
};

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
        await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: body + '\n\nAn edit only the database holds.\n' });
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

  for (const expected of ['head', 'unbound'] as const) test(`writePageThrough passes a split head by (${expected} preimage); head and parts keep their bytes`, () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const before = layout(root);
    const result = await writePageThrough(engine, SLUG, expected === 'head' ? { expectedFileBytes: head } : {});
    expect(result).toMatchObject({ written: false, skipped: 'split_page_unsupported' });
    expect(layout(root)).toEqual(before);
  }), 120_000);

  test('deletePageThrough never unlinks a split head alone', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const before = layout(root);
    expect(await deletePageThrough(engine, SLUG, { expectedFileBytes: head })).toMatchObject({ removed: false, skipped: 'split_page_unsupported' });
    expect(layout(root)).toEqual(before);
  }), 120_000);
});
