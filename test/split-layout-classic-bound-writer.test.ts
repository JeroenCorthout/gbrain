/**
 * Wave B PR 5 lane 5e (option B, GBRA-108), F3 of the round 7 review: the classic unmanaged write-through bound to the
 * bytes it compared is outside the publication door, so it refuses a split page outright instead of rewriting its head.
 *
 * 1. Protects: writePageThrough with expectedFileBytes (the binding concept publication, brainstorm and lsd saves use)
 *    on a split page returns skipped split_page_unsupported before it writes or commits anything, also when Git would
 *    convert the head on commit (a clean filter) and when the unit on disk is not the unit HEAD holds (an uncommitted
 *    re-layout): HEAD, the head and every part stay byte for byte.
 * 2. Fails when: a bound head-only rewrite lands (the round 7 probe at dcf982fbd: a head committed through a clean filter,
 *    or a new head committed beside parts HEAD does not hold, so a checkout no longer reassembles the page).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests; a durable Git checkout with no remote.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, readPageFile } from '../src/core/split-layout/index.ts';
import { _resetWriteThroughCacheForTest, writePageThrough } from '../src/core/write-through.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe';
const body = Array.from({ length: 50 }, (_, i) => 'Line ' + i + ': original synthetic material filling this test page with enough data for part files.').join('\n') + '\n';
afterEach(() => { __setSplitLimitsForTests(null); _resetWriteThroughCacheForTest(); });

/** The head and every part file with their bytes. */
function unit(root: string) {
  const dir = join(root, 'notes/.probe.gbparts');
  const parts = existsSync(dir) ? readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]) : [];
  return { head: readFileSync(join(root, SLUG + '.md'), 'utf8'), parts };
}

for (const backend of testBackends()) describe('[' + backend + '] split git layout: the classic bound write-through outside the door', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const problem of ['clean-filter', 'uncommitted-unit'] as const) test('writePageThrough bound to the page file refuses a split page (' + problem + '): split_page_unsupported, HEAD, the head and every part stay', async () => {
    const home = mkdtempSync(join(tmpdir(), 'split-classic-bound-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          __setSplitLimitsForTests(LIMITS);
          const root = join(home, 'brain');
          mkdirSync(root);
          writeFileSync(join(root, '.gitignore'), '\n');
          durableGitRepo(root, ['.gitignore']);
          await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
          await engine.putPage(SLUG, { type: 'note', title: 'First', compiled_truth: body });
          await engine.executeRaw("UPDATE pages SET source_path=$1 WHERE slug=$2 AND source_id='default'", [SLUG + '.md', SLUG]);
          await writeSplitPage(root, SLUG + '.md', serializePageToMarkdown((await engine.getPage(SLUG, { sourceId: 'default' }))!, []));
          git(root, 'add', 'notes');
          git(root, 'commit', '-qm', 'Synthetic original split');
          const head = join(root, SLUG + '.md');
          if (problem === 'uncommitted-unit') {
            await engine.putPage(SLUG, { type: 'note', title: 'First', compiled_truth: body.replaceAll('original', 'replacement') });
            rmSync(join(root, 'notes/.probe.gbparts'), { recursive: true });
            await writeSplitPage(root, SLUG + '.md', serializePageToMarkdown((await engine.getPage(SLUG, { sourceId: 'default' }))!, []));
          }
          if (problem === 'clean-filter') {
            writeFileSync(join(root, '.gitattributes'), '*.md filter=example\n');
            git(root, 'config', 'filter.example.clean', 'sed s/Line/ALTERED/g');
            git(root, 'add', '.gitattributes');
            git(root, 'commit', '-qm', 'Synthetic clean conversion');
          }
          const file = readPageFile(head);
          if (file.hold) throw new Error(file.hold.code);
          const before = { head: git(root, 'rev-parse', 'HEAD'), unit: unit(root), status: git(root, 'status', '--porcelain', '--untracked-files=all') };
          const result = await writePageThrough(engine, SLUG, { expectedFileBytes: file.bytes.toString('utf8'), frontmatterOverrides: { title: 'Second' } });
          expect(result).toEqual({ written: false, skipped: 'split_page_unsupported' });
          expect({ head: git(root, 'rev-parse', 'HEAD'), unit: unit(root), status: git(root, 'status', '--porcelain', '--untracked-files=all') }).toEqual(before);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
