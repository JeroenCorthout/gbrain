/**
 * Wave B PR 5 (option B), C1: a classic bound write-through reads Git in the repository that holds the target, so a
 * nested repository's split unit held only in its HEAD refuses instead of being overwritten as one file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests } from '../src/core/split-layout/index.ts';
import { _resetWriteThroughCacheForTest, writePageThrough } from '../src/core/write-through.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/example';
afterEach(() => { __setSplitLimitsForTests(null); _resetWriteThroughCacheForTest(); });

for (const backend of testBackends()) describe(`[${backend}] split unit in a nested repository`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('classic bound write-through refuses HEAD-only split parts in a nested repository', async () => {
    const home = mkdtempSync(join(tmpdir(), 'split-unit-nested-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          __setSplitLimitsForTests(LIMITS);
          const root = join(home, 'brain'), nested = join(root, 'nested');
          mkdirSync(nested, { recursive: true });
          for (const repo of [root, nested]) {
            writeFileSync(join(repo, 'seed'), 'seed\n');
            durableGitRepo(repo, ['seed']);
          }
          await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
          await engine.putPage(SLUG, { type: 'note', title: 'First', compiled_truth: 'Synthetic original body line.\n'.repeat(150) });
          await engine.executeRaw("UPDATE pages SET source_path=$1 WHERE slug=$2 AND source_id='default'", ['nested/' + SLUG + '.md', SLUG]);
          const plain = serializePageToMarkdown((await engine.getPage(SLUG, { sourceId: 'default' }))!, []);
          await writeSplitPage(nested, SLUG + '.md', plain);
          git(nested, 'add', 'notes');
          git(nested, 'commit', '-qm', 'Original nested split');
          rmSync(join(nested, 'notes/.example.gbparts'), { recursive: true });
          const head = join(nested, SLUG + '.md');
          writeFileSync(head, plain);
          const result = await writePageThrough(engine, SLUG, { expectedFileBytes: plain, frontmatterOverrides: { title: 'Outside writer' } });
          const preserved = readFileSync(head, 'utf8') === plain;
          expect(result).toEqual({ written: false, skipped: 'split_page_unsupported' });
          expect(preserved).toBe(true);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
