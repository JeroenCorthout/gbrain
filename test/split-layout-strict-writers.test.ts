/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the generic file write helpers and the skill and bootstrap
 * writers that write a .md a sync could import.
 *
 * 1. Protects: privateWrite, atomicWriteTextFile, the skillopt atomicWrite, copyArtifacts, applyWritePlan, applyScaffold
 *    and the template renderer run the engine-free split preflight (assertOneFileWritable) on the bytes they write, so a
 *    split head (parts directory present or not) is never rewritten as one file, a parts directory with no head never
 *    gets a one-file page beside it, and a page over the split threshold is never written as one file. A path that can
 *    never be a split head (a .json) is not refused, so the helpers keep writing configuration and receipts.
 * 2. Fails when: any of these writers changes a split head or writes a refused page.
 * 3. No engine; KB-sized limits through __setSplitLimitsForTests.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { atomicWriteTextFile } from '../src/core/bootstrap/atomic-write.ts';
import { atomicWrite } from '../src/core/skillopt/apply-edits.ts';
import { copyArtifacts } from '../src/core/skillpack/copy.ts';
import { applyWritePlan } from '../src/core/skillpack/init-scaffold.ts';
import { applyScaffold } from '../src/core/skillify/generator.ts';
import { renderWorkspace } from '../src/core/bootstrap/render.ts';
import { __setSplitLimitsForTests, partsDirFor } from '../src/core/split-layout/index.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of a long synthetic page body that fills parts.`).join('\n');
const PAGE = `---\ntitle: Example\n---\n# Example\n\n${body}\n`;
afterEach(() => __setSplitLimitsForTests(null));

async function withBrain(run: (root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'split-strict-writers-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      __setSplitLimitsForTests(LIMITS);
      const root = join(home, 'brain');
      mkdirSync(root, { recursive: true });
      await run(root);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const refusalOf = (run: () => unknown) => { try { run(); return null; } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } };
/** copyArtifacts reports any failed write as write_failed and keeps the refusal in its message. */
const copyRefusal = (run: () => unknown) => { try { run(); return null; } catch (error) { return /split_page_unsupported/.test((error as Error).message) ? 'split_page_unsupported' : (error as Error).message; } };

const overwriters: Array<[string, (path: string, text: string) => void]> = [
  ['privateWrite', (path, text) => privateWrite(path, text)],
  ['atomicWriteTextFile', (path, text) => atomicWriteTextFile(path, text)],
  ['the skillopt atomicWrite', (path, text) => atomicWrite(path, text)],
  ['applyScaffold', (path, text) => applyScaffold({ files: [{ path, kind: 'overwrite', content: text }], resolverFile: null, resolverAppend: null })],
];

for (const [name, write] of overwriters) {
  test(`${name} leaves a split head as it was, with or without its parts directory, and refuses a page over the threshold (split_page_unsupported)`, () => withBrain(async (root) => {
    await writeSplitPage(root, 'notes/example.md', PAGE);
    const head = join(root, 'notes/example.md');
    const before = readFileSync(head, 'utf8');
    expect(refusalOf(() => write(head, 'Short page.\n'))).toBe('split_page_unsupported');
    rmSync(partsDirFor(head), { recursive: true });
    expect(refusalOf(() => write(head, 'Short page.\n'))).toBe('split_page_unsupported');
    expect(readFileSync(head, 'utf8')).toBe(before);
    const fresh = join(root, 'notes/fresh.md');
    expect(refusalOf(() => write(fresh, PAGE))).toBe('split_page_unsupported');
    expect(existsSync(fresh)).toBe(false);
    const config = join(root, 'notes/config.json');
    write(config, JSON.stringify({ text: PAGE }));
    expect(JSON.parse(readFileSync(config, 'utf8')).text).toBe(PAGE);
  }));
}

test('copyArtifacts and applyWritePlan refuse a new page beside an orphaned parts directory or over the threshold, writing nothing', () => withBrain(async (root) => {
  await writeSplitPage(root, 'skills/example/SKILL.md', PAGE);
  const head = join(root, 'skills/example/SKILL.md');
  rmSync(head);
  const source = join(root, 'source.md');
  writeFileSync(source, 'Short skill.\n');
  expect(copyRefusal(() => copyArtifacts([{ source, target: head }]))).toBe('split_page_unsupported');
  expect(refusalOf(() => applyWritePlan([{ path: head, content: 'Short skill.\n' }]))).toBe('split_page_unsupported');
  const fresh = join(root, 'skills/fresh/SKILL.md');
  expect(copyRefusal(() => copyArtifacts([{ source, target: fresh, content: PAGE }]))).toBe('split_page_unsupported');
  expect(refusalOf(() => applyWritePlan([{ path: fresh, content: PAGE }]))).toBe('split_page_unsupported');
  expect(existsSync(head)).toBe(false);
  expect(existsSync(fresh)).toBe(false);
}));

test('the bootstrap renderer leaves a split workspace page as it was (split_page_unsupported)', () => withBrain(async (root) => {
  await writeSplitPage(root, 'AGENTS.md', PAGE);
  const head = join(root, 'AGENTS.md');
  const before = readFileSync(head, 'utf8');
  expect(refusalOf(() => renderWorkspace(root, { force: true, minimal: true, only: ['AGENTS.md'] }))).toBe('split_page_unsupported');
  expect(readFileSync(head, 'utf8')).toBe(before);
}));
