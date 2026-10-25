/**
 * Split git layout read path (Wave B PR 5 lane 5c, design §3): which paths sync may import, and what an older gbrain
 * makes of a head. File-only.
 *
 * Protects: no path inside a parts directory is ever syncable, whatever the strategy and with or without
 * --include-hidden (the pre-Wave-B rules already reject every part file by extension and dot directory; the explicit
 * isPartPath guard stops --include-hidden from admitting a Markdown file placed there); the import parser of a
 * pre-PR-5 binary reads a head as an ordinary short page whose body is the lead plus the notice line and whose
 * frontmatter carries gbrain_parts as a plain key, which is why the notice line says older versions see only the lead.
 * Regression it catches: an include-hidden glob that imports a file inside a .gbparts directory; a head format change
 * that an older binary would import as something other than the lead and notice.
 * Seam: __setSplitLimitsForTests (KB-sized parts and lead).
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, parseHead } from '../src/core/split-layout/index.ts';
import { isSyncable } from '../src/core/sync.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { withEnv } from './helpers/with-env.ts';

const SMALL = { thresholdMin: 1, partTarget: 256, partMax: 512, leadMax: 128, partCountMax: 500 };
const FILE = '---\ntitle: Big page\ntype: note\n---\n\n' + Array.from({ length: 30 }, (_, i) => `Line ${i} of a synthetic acme-example page body.`).join('\n') + '\n';
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-split-paths-')); });
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => __setSplitLimitsForTests(null));

const written = () => withEnv({ GBRAIN_HOME: home }, () => writeSplitPage(mkdtempSync(join(home, 'repo-')), 'notes/big-page.md', FILE));

test('no path inside a parts directory is syncable, with or without --include-hidden', async () => {
  __setSplitLimitsForTests(SMALL);
  const { parts } = await written();
  const partFiles = parts.map(part => part.rel);
  expect(partFiles.length).toBeGreaterThan(2);
  const strays = ['notes/.big-page.gbparts/stray.md', 'notes/.big-page.gbparts/nested/deeper.md', '.top.gbparts/0001-deadbeef.gbpart', 'a/b/.c.gbparts/x.ts'];
  const waivers = [undefined, ['**'], ['notes/**'], ['**/.*/**', '.*/**']];
  for (const path of [...partFiles, ...strays]) {
    for (const strategy of ['markdown', 'code', 'auto'] as const) {
      for (const includeHidden of waivers) expect({ path, strategy, includeHidden, syncable: isSyncable(path, { strategy, includeHidden }) }).toEqual({ path, strategy, includeHidden, syncable: false });
    }
  }
  // The head itself is an ordinary syncable page path, and a dot directory that is not a parts directory keeps its waiver.
  expect(isSyncable('notes/big-page.md')).toBe(true);
  expect(isSyncable('notes/.drafts/page.md', { includeHidden: ['notes/**'] })).toBe(true);
});

test('the pre-Wave-B rules reject every part file: a .gbpart is never a Markdown or code file, and its directory is a dot directory', async () => {
  __setSplitLimitsForTests(SMALL);
  const { parts } = await written();
  for (const part of parts) {
    expect(part.rel).toMatch(/\/\.big-page\.gbparts\/\d{4}-[0-9a-f]{8}\.gbpart$/);
    for (const strategy of ['markdown', 'code', 'auto'] as const) expect(isSyncable(part.rel, { strategy })).toBe(false);
  }
});

test('an older gbrain imports a head as a short page: the lead and notice as its body, gbrain_parts as a plain frontmatter key', async () => {
  __setSplitLimitsForTests(SMALL);
  const { head } = await written();
  const parsed = parseHead(head);
  if (!parsed || 'error' in parsed) throw new Error('fixture head did not parse');
  // parseMarkdown is the parser every import path runs; a binary without the split read path runs only this.
  const asPlainPage = parseMarkdown(head, 'notes/big-page.md', { validate: true });
  expect(asPlainPage.errors ?? []).toEqual([]);
  expect(asPlainPage.title).toBe('Big page');
  expect(asPlainPage.frontmatter.gbrain_parts).toEqual(parsed.manifest);
  expect(asPlainPage.compiled_truth.trim()).toBe(parsed.headBody.trim());
  expect(asPlainPage.compiled_truth).toMatch(/^Line 0 of a synthetic acme-example page body\.\n/);
  expect(asPlainPage.compiled_truth).toContain('> [gbrain] This page continues in');
  expect(asPlainPage.compiled_truth).toContain('older versions see only this lead.');
  expect(asPlainPage.compiled_truth).not.toContain('Line 29');
});
