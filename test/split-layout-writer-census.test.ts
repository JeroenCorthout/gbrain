/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the file-side writer census.
 *
 * 1. Protects: every source file that calls a file write primitive (writeFile/writeFileSync, rename/renameSync,
 *    createWriteStream, copyFile/copyFileSync/cpSync, open with a write flag or O_CREAT, Bun/fs write, the atomic-write
 *    helpers) is reviewed in docs/architecture/split-layout-writers.tsv with a ceiling, a class (door, split_aware,
 *    refuse_before_write, not_page_path) and a rationale. A split_aware or refuse_before_write writer calls the one split
 *    preflight (assertSplitWritable or a wrapper of it), a split_aware one may name the planner instead, unless its row
 *    says why it cannot ("no helper: ...").
 * 2. Fails when: a write appears in an unreviewed file or over its ceiling, a classified writer stops naming the
 *    preflight, or a canonical database writer (canonical-writers.tsv) that also writes files has no row.
 * 3. Source-text tripwire, no engine.
 */
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const CLASSES = ['door', 'split_aware', 'refuse_before_write', 'not_page_path'];
const pattern = /(?<![\w.])(?:(?:fs\.|fsp\.|promises\.)?(?:writeFileSync|writeFile|renameSync|rename|createWriteStream|copyFileSync|copyFile|cpSync|atomicWriteFileSync|atomicWriteFile)|(?:fs|fsp|promises|Bun)\.write)\s*\(|\bopen(?:Sync)?\s*\([^)\n]*(?:'[wa]x?\+?'|"[wa]x?\+?"|O_CREAT)/g;
const PREFLIGHT = /\b(?:assertSplitWritable|splitWriteRefusal|oneFileWriteRefusal|assertPageThroughWritable)\b/;
const PLANNER = /\b(?:writeSplitPageFile|splitPublicationTargets|planSplit)\b/;
const count = (body: string) => [...body.matchAll(pattern)].length;
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [join(directory, entry.name)] : []);
}
type Row = { ceiling: number; klass: string; reason: string };
function loadInventory(): Map<string, Row> {
  const rows = readFileSync(join(root, 'docs/architecture/split-layout-writers.tsv'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  return new Map(rows.map(([path, ceiling, klass, reason]) => [path!, { ceiling: Number(ceiling), klass: klass!, reason: reason ?? '' }]));
}
/** Every unreviewed or over-ceiling writer, and every classified writer that no longer names its preflight. */
function gapsFor(sources: Iterable<[string, string]>, inventory: Map<string, Row>): string[] {
  const gaps: string[] = [];
  for (const [path, body] of sources) {
    const sites = count(body), row = inventory.get(path);
    if (sites && (!row || sites > row.ceiling)) gaps.push(`${path}: ${sites} file writes; reviewed ceiling ${row?.ceiling ?? 0}`);
    if (!row || row.reason.startsWith('no helper:')) continue;
    if (row.klass === 'refuse_before_write' && !PREFLIGHT.test(body)) gaps.push(`${path}: refuse_before_write without the split preflight`);
    if (row.klass === 'split_aware' && !PREFLIGHT.test(body) && !PLANNER.test(body)) gaps.push(`${path}: split_aware without the split preflight or the planner`);
  }
  return gaps;
}
const source = (path: string): [string, string] => [path, readFileSync(join(root, path), 'utf8')];

test('every file writer in src is reviewed with a ceiling, a class and its split preflight', () => {
  const inventory = loadInventory();
  for (const [path, row] of inventory) {
    expect(CLASSES).toContain(row.klass);
    expect(row.reason.length).toBeGreaterThan(20);
    expect(existsSync(join(root, path))).toBe(true);
  }
  const sources = files(join(root, 'src')).map(file => source(relative(root, file)));
  const inventoried = new Set(sources.map(([path]) => path));
  const gaps = gapsFor([...sources, ...[...inventory.keys()].filter(path => !inventoried.has(path)).map(source)], inventory);
  expect(gaps, 'Classify each file write in split-layout-writers.tsv after checking whether it can reach a page path and how it treats a split page.').toEqual([]);
});

test('a planted bypass fails the census: a new writer, a write over a ceiling, a writer that drops its preflight', () => {
  const inventory = loadInventory();
  // test-reads-source-ok[structural]: the census is a source-text tripwire by design; the planted copies prove it flags a bypass.
  const [, demo] = source('src/commands/sources-demo.ts');
  const [, lint] = source('src/commands/lint.ts');
  const demoRow = inventory.get('src/commands/sources-demo.ts')!;
  expect(gapsFor([['src/commands/sources-demo.ts', demo], ['src/commands/lint.ts', lint]], inventory)).toEqual([]);
  expect(gapsFor([
    ['src/core/cycle/new-writer.ts', "writeFileSync(join(root, 'notes/example.md'), page);"],
    ['src/commands/sources-demo.ts', `${demo}\nwriteFileSync(path, page);`],
    ['src/commands/lint.ts', lint.replace(/writeSplitPageFile|assertSplitWritable/g, 'writeEditedPage')],
  ], inventory)).toEqual([
    'src/core/cycle/new-writer.ts: 1 file writes; reviewed ceiling 0',
    `src/commands/sources-demo.ts: ${demoRow.ceiling + 1} file writes; reviewed ceiling ${demoRow.ceiling}`,
    'src/commands/lint.ts: split_aware without the split preflight or the planner',
  ]);
  expect(gapsFor([['src/commands/sources-demo.ts', demo.replace(/oneFileWriteRefusal/g, 'demoWriteCheck')]], inventory))
    .toEqual(['src/commands/sources-demo.ts: refuse_before_write without the split preflight']);
});

test('every canonical database writer that also writes files has a row', () => {
  const inventory = loadInventory();
  const canonical = readFileSync(join(root, 'docs/architecture/canonical-writers.tsv'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t')[0]!);
  const missing = canonical.filter(path => existsSync(join(root, path)) && count(readFileSync(join(root, path), 'utf8')) > 0 && !inventory.has(path));
  expect(missing).toEqual([]);
});

test('the census counts every write primitive and no read', () => {
  expect(count("writeFileSync(a, b); await fsp.writeFile(a, b); renameSync(a, b); await rename(a, b); createWriteStream(a); copyFileSync(a, b); await Bun.write(a, b); atomicWriteFileSync(a, b); openSync(a, 'wx', 0o600); await open(a, 'w'); openSync(a, constants.O_WRONLY | constants.O_CREAT)")).toBe(11);
  expect(count("readFileSync(a); openSync(a, 'r'); this.rename(a); stream.write(b); existsSync(a)")).toBe(0);
});
