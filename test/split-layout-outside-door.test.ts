/**
 * Wave B PR 5 lane 5e, round 6 ("refuse rather than reconcile"): outside the publication door a split page is never
 * removed, and a refusal leaves every byte as it was: the head, each part and the page's database row.
 *
 * 1. Protects: deletePageThrough (bound to the page's bytes or not) and the classic Google connector's delete refuse
 *    `split_page_unsupported` on a split page whose head a human edited, the Google route before it deletes its row.
 * 2. Fails when: a remover outside the door unlinks a split head or its parts, or deletes the row of a page whose files it
 *    then refuses to remove.
 * 3. Real PGLite and Postgres engines, the probe shape of the round 6 review (a split head edited by hand).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { deletePageByRelPath } from '../src/core/google/sweep-shared.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, readPageFile } from '../src/core/split-layout/index.ts';
import { _resetWriteThroughCacheForTest, deletePageThrough } from '../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe';
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of synthetic unchanged body long enough to fill parts.`).join('\n');
afterEach(() => { __setSplitLimitsForTests(null); _resetWriteThroughCacheForTest(); });

/** Every file under `root` with its bytes, and every page row: what a refusal must leave as it was. */
async function state(engine: BrainEngine, root: string) {
  const walk = (dir: string): Array<[string, string]> => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(dir, entry.name)) : [[relative(root, join(dir, entry.name)), readFileSync(join(dir, entry.name), 'utf8')] as [string, string]]);
  return { files: Object.fromEntries(walk(root).sort()), rows: await engine.executeRaw('SELECT slug, compiled_truth, source_path, deleted_at FROM pages ORDER BY slug') };
}

/** What a writer returned, or the code it threw. */
const outcomeOf = (run: () => Promise<unknown>) => run().then(value => value, (error: { code?: string }) => ({ thrown: error.code }));

for (const backend of testBackends()) describe(`[${backend}] split git layout: removals outside the door refuse`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  /** A stored page whose file is a split page at its recorded path, its head edited by hand. */
  async function withEditedSplitPage(run: (engine: BrainEngine, root: string) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'split-outside-door-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        __setSplitLimitsForTests(LIMITS);
        _resetWriteThroughCacheForTest();
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const root = join(home, 'brain');
          mkdirSync(root);
          await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
          await engine.putPage(SLUG, { type: 'note', title: 'Example', compiled_truth: body });
          await writeSplitPage(root, `${SLUG}.md`, serializePageToMarkdown((await engine.getPage(SLUG, { sourceId: 'default' }))!, []));
          const head = join(root, `${SLUG}.md`);
          writeFileSync(head, readFileSync(head, 'utf8').replace('Line 0000', 'HUMAN EDIT'));
          expect(readPageFile(head).hold?.code).toBe('split_head_modified');
          await engine.executeRaw("UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2", [`${SLUG}.md`, SLUG]);
          await run(engine, root);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  test('deletePageThrough refuses a split page (split_page_unsupported) and leaves the head, its parts and the row as they were', () => withEditedSplitPage(async (engine, root) => {
    const before = await state(engine, root);
    expect(await deletePageThrough(engine, SLUG)).toEqual({ removed: false, path: join(root, `${SLUG}.md`), skipped: 'split_page_unsupported' });
    expect(await state(engine, root)).toEqual(before);
  }), 120_000);

  test('the classic Google connector refuses a split page delete (split_page_unsupported) before it deletes the row', () => withEditedSplitPage(async (engine, root) => {
    const before = await state(engine, root);
    const summary = { deleted: 0 } as never as Parameters<typeof deletePageByRelPath>[2];
    const deps = { managed: null, engine, sourceId: 'default', cfg: { dir: root, account: 'owner@example.invalid' }, opts: {}, entry: {}, log() {}, tick() {} } as never;
    expect(await outcomeOf(() => deletePageByRelPath(deps, `${SLUG}.md`, summary))).toEqual({ thrown: 'split_page_unsupported' });
    expect(await state(engine, root)).toEqual(before);
    expect(summary.deleted).toBe(0);
  }), 120_000);
});
