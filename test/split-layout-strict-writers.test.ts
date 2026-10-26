/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the generic file write helpers and the skill and bootstrap
 * writers that write a .md a sync could import.
 *
 * 1. Protects: only the publication door of a git-canonical source writes a split page. privateWrite,
 *    atomicWriteTextFile, the skillopt atomicWrite, copyArtifacts, applyWritePlan, applyScaffold and the template
 *    renderer are outside the door and run the engine-free check (assertOneFileWritable) before they write: a path in a
 *    split unit (a head with its parts directory, a head declaring gbrain_parts whose parts directory is missing, or a
 *    head path beside an orphaned parts directory) is refused split_page_unsupported (outside_door) and nothing is
 *    written. A page in no split unit is written as one file at any size, as master writes it, and a path that can never
 *    be a split head (a .json) is not refused, so the helpers keep writing configuration and receipts.
 * 2. Fails when: any of these writers changes a split head, writes a page beside an orphaned parts directory, lays a
 *    page out as a head plus parts, or refuses a page in no split unit for its size.
 * 3. No engine; KB-sized limits through __setSplitLimitsForTests.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const refusalOf = (run: () => unknown) => { try { run(); return null; } catch (error) {
  const { code, reason } = error as { code?: string; reason?: string };
  return code ? (reason ? `${code} (${reason})` : code) : (error as Error).message;
} };
/** copyArtifacts reports any failed write as write_failed and keeps the refusal in its message. */
const copyRefusal = (run: () => unknown) => { try { run(); return null; } catch (error) { return /split_page_unsupported \(outside_door\)/.test((error as Error).message) ? 'split_page_unsupported (outside_door)' : (error as Error).message; } };

/** The head and every part file, by name, as they are on disk (null when gone). */
const layout = (head: string) => ({ head: existsSync(head) ? readFileSync(head, 'utf8') : null,
  parts: existsSync(partsDirFor(head)) ? Object.fromEntries(readdirSync(partsDirFor(head)).sort().map(name => [name, readFileSync(join(partsDirFor(head), name), 'utf8')])) : null });

const overwriters: Array<[string, (path: string, text: string) => void]> = [
  ['privateWrite', (path, text) => privateWrite(path, text)],
  ['atomicWriteTextFile', (path, text) => atomicWriteTextFile(path, text)],
  ['the skillopt atomicWrite', (path, text) => atomicWrite(path, text)],
  ['applyScaffold', (path, text) => applyScaffold({ files: [{ path, kind: 'overwrite', content: text }], resolverFile: null, resolverAppend: null })],
];

for (const [name, write] of overwriters) {
  test(`${name} leaves a split head as it was, with or without its parts directory (split_page_unsupported, outside_door), and writes a page over the threshold as one file`, () => withBrain(async (root) => {
    await writeSplitPage(root, 'notes/example.md', PAGE);
    const head = join(root, 'notes/example.md');
    const before = layout(head);
    expect(refusalOf(() => write(head, 'Short page.\n'))).toBe('split_page_unsupported (outside_door)');
    expect(layout(head)).toEqual(before);
    rmSync(partsDirFor(head), { recursive: true });
    expect(refusalOf(() => write(head, 'Short page.\n'))).toBe('split_page_unsupported (outside_door)');
    expect(layout(head)).toEqual({ ...before, parts: null });
    const fresh = join(root, 'notes/fresh.md');
    expect(Buffer.byteLength(PAGE)).toBeGreaterThan(LIMITS.thresholdDefault);
    expect(refusalOf(() => write(fresh, PAGE))).toBeNull();
    expect(layout(fresh)).toEqual({ head: PAGE, parts: null });
    const config = join(root, 'notes/config.json');
    write(config, JSON.stringify({ text: PAGE }));
    expect(JSON.parse(readFileSync(config, 'utf8')).text).toBe(PAGE);
  }));
}

test('copyArtifacts and applyWritePlan refuse a new page beside an orphaned parts directory (split_page_unsupported, outside_door), writing nothing, and write a page over the threshold as one file', () => withBrain(async (root) => {
  await writeSplitPage(root, 'skills/example/SKILL.md', PAGE);
  const head = join(root, 'skills/example/SKILL.md');
  rmSync(head);
  const orphaned = layout(head);
  const source = join(root, 'source.md');
  writeFileSync(source, 'Short skill.\n');
  expect(copyRefusal(() => copyArtifacts([{ source, target: head }]))).toBe('split_page_unsupported (outside_door)');
  expect(refusalOf(() => applyWritePlan([{ path: head, content: 'Short skill.\n' }]))).toBe('split_page_unsupported (outside_door)');
  expect(layout(head)).toEqual(orphaned);
  expect(orphaned.head).toBeNull();
  for (const [name, write] of [['copied', (target: string) => copyArtifacts([{ source, target, content: PAGE }])], ['planned', (path: string) => applyWritePlan([{ path, content: PAGE }])]] as const) {
    const fresh = join(root, `skills/${name}/SKILL.md`);
    expect(refusalOf(() => write(fresh))).toBeNull();
    expect(layout(fresh)).toEqual({ head: PAGE, parts: null });
  }
}));

test('the bootstrap renderer leaves a split workspace page as it was (split_page_unsupported)', () => withBrain(async (root) => {
  await writeSplitPage(root, 'AGENTS.md', PAGE);
  const head = join(root, 'AGENTS.md');
  const before = layout(head);
  expect(refusalOf(() => renderWorkspace(root, { force: true, minimal: true, only: ['AGENTS.md'] }))).toBe('split_page_unsupported (outside_door)');
  expect(layout(head)).toEqual(before);
}));
