/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the file-side writer census.
 *
 * 1. Protects: every source file that writes a file is reviewed in docs/architecture/split-layout-writers.tsv with a
 *    ceiling, a class (door, split_aware, refuse_before_write, not_page_path) and a rationale. A write is a file write
 *    primitive (writeFile/writeFileSync, rename/renameSync, createWriteStream, copyFile/copyFileSync/cpSync, open with a
 *    write flag or O_CREAT, Bun/fs write, the atomic-write helpers) or a call to one of the repo's exported write helpers
 *    (docs/architecture/split-layout-write-helpers.tsv: every exported function whose body calls a primitive). A
 *    split_aware or refuse_before_write writer calls the one split preflight (assertSplitWritable or a wrapper of it; a
 *    split_aware one may name the planner instead) unless its row says why it cannot ("no helper: ...") or names the
 *    classified helper modules that run it for every write it makes ("via <path>[, <path>]: ..."). Only the split
 *    layout modules and the helper module test for a parts directory; any other file that does
 *    (docs/architecture/split-layout-parts-dir-readers.tsv) is a reviewed reader. A not_page_path writer that names a
 *    .md file says why that file is never a syncable page ("md: ...").
 * 2. Fails when: a write (direct or through a helper) appears in an unreviewed file or over its ceiling, a new exported
 *    wrapper of a primitive is not listed as a helper, a classified writer stops naming the preflight, a file outside the
 *    split modules checks for a parts directory without a reviewed row, a not_page_path writer names a .md file without
 *    saying why, or a canonical database writer (canonical-writers.tsv) that also writes files has no row.
 * 3. Source-text tripwire, no engine.
 */
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const CLASSES = ['door', 'split_aware', 'refuse_before_write', 'not_page_path'];
const pattern = /(?<![\w.])(?:(?:fs\.|fsp\.|promises\.)?(?:writeFileSync|writeFile|renameSync|rename|createWriteStream|copyFileSync|copyFile|cpSync|atomicWriteFileSync|atomicWriteFile)|(?:fs|fsp|promises|Bun)\.write)\s*\(|\bopen(?:Sync)?\s*\([^)\n]*(?:'[wa]x?\+?'|"[wa]x?\+?"|O_CREAT)/g;
const PREFLIGHT = /\b(?:assertSplitWritable|splitWriteRefusal|oneFileWriteRefusal|assertOneFileWritable|assertPageThroughWritable)\b/;
const PLANNER = /\b(?:writeSplitPageFile|splitPublicationTargets|planSplit)\b/;
const SHORTCUT = /\bpartsDir(?:For|Name)\s*\(|\.gbparts\//g;
const MD_NAME = /\.mdx?\b["'`]|["'`]SKILL\.md\b/;
const SPLIT_MODULES = (path: string) => path.startsWith('src/core/split-layout/') || path === 'src/core/split-write-through.ts';
const DECLARATION = /^export (?:async )?function\s+(\w+)|^export const (\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>/gm;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [join(directory, entry.name)] : []);
}
const rowsOf = (file: string) => readFileSync(join(root, 'docs/architecture', file), 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
type Row = { ceiling: number; klass: string; reason: string };
type Census = { inventory: Map<string, Row>; helpers: Map<string, string>; readers: Map<string, number> };
function loadCensus(): Census {
  return {
    inventory: new Map(rowsOf('split-layout-writers.tsv').map(([path, ceiling, klass, reason]) => [path!, { ceiling: Number(ceiling), klass: klass!, reason: reason ?? '' }])),
    helpers: new Map(rowsOf('split-layout-write-helpers.tsv').map(([path, name, kind]) => [`${path}#${name}`, kind!])),
    readers: new Map(rowsOf('split-layout-parts-dir-readers.tsv').map(([path, ceiling]) => [path!, Number(ceiling)])),
  };
}
/** `body` without its comment lines, so a comment that names a write is not one. */
const codeOf = (body: string) => body.split('\n').filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
/** The exported functions of `source` whose own body calls a write primitive: the repo's write helpers. */
function wrappersIn(source: string): string[] {
  const body = codeOf(source);
  return [...body.matchAll(DECLARATION)].filter(match => {
    const newline = body.indexOf('\n', match.index);
    const line = body.slice(match.index, newline < 0 ? body.length : newline);
    const balanced = (line.match(/\{/g) ?? []).length === (line.match(/\}/g) ?? []).length && /[}\w)'"`];?\s*$/.test(line);
    const end = balanced ? match.index + line.length : [body.indexOf('\n}', match.index), body.indexOf('\n};', match.index)].filter(at => at > 0).reduce((a, b) => Math.min(a, b), body.length);
    return [...body.slice(match.index, end).matchAll(pattern)].length > 0;
  }).map(match => (match[1] ?? match[2])!);
}
/** Write primitives plus calls to a listed write helper (an entry point's callers are CLI dispatch and are not counted). */
function count(body: string, census: Census): number {
  const code = codeOf(body);
  const names = [...new Set([...census.helpers].filter(([, kind]) => kind === 'helper').map(([key]) => key.split('#')[1]!))]
    .filter(name => !new RegExp(pattern.source).test(`${name}(`));
  const calls = new RegExp(`(?<![\\w.$])(?:${names.join('|')})\\s*\\(`, 'g');
  const declarations = new RegExp(`function\\s+(?:${names.join('|')})\\s*\\(`, 'g');
  return [...code.matchAll(pattern)].length + [...code.matchAll(calls)].length - [...code.matchAll(declarations)].length;
}
/** Every census gap in `sources`. */
function gapsFor(sources: Array<[string, string]>, census: Census): string[] {
  const gaps: string[] = [];
  const bodies = new Map(sources);
  for (const [path, body] of sources) {
    const sites = count(body, census), row = census.inventory.get(path);
    if (sites > 0 && (!row || sites > row.ceiling)) gaps.push(`${path}: ${sites} file writes; reviewed ceiling ${row?.ceiling ?? 0}`);
    for (const name of wrappersIn(body)) if (!census.helpers.has(`${path}#${name}`)) gaps.push(`${path}: ${name} wraps a file write and is not a listed write helper`);
    const shortcuts = SPLIT_MODULES(path) ? 0 : [...body.matchAll(SHORTCUT)].length;
    if (shortcuts > (census.readers.get(path) ?? 0)) gaps.push(`${path}: ${shortcuts} parts-directory checks outside the split helper; reviewed readers ${census.readers.get(path) ?? 0}`);
    if (!row) continue;
    if (row.klass === 'not_page_path' && MD_NAME.test(body) && !row.reason.startsWith('md:')) gaps.push(`${path}: not_page_path names a .md file without saying why it is never a page`);
    if (row.reason.startsWith('no helper:')) continue;
    const via = /^via ([^:]+):/.exec(row.reason);
    if (via) {
      for (const helper of via[1]!.split(', ')) {
        const helperRow = census.inventory.get(helper);
        const helperBody = bodies.get(helper) ?? readFileSync(join(root, helper), 'utf8');
        if (!helperRow || !['refuse_before_write', 'split_aware', 'door'].includes(helperRow.klass) || !(PREFLIGHT.test(helperBody) || PLANNER.test(helperBody))) {
          gaps.push(`${path}: its split preflight lives in ${helper}, which is not a classified writer naming the preflight`);
        }
      }
      continue;
    }
    if (row.klass === 'refuse_before_write' && !PREFLIGHT.test(body)) gaps.push(`${path}: refuse_before_write without the split preflight`);
    if (row.klass === 'split_aware' && !PREFLIGHT.test(body) && !PLANNER.test(body)) gaps.push(`${path}: split_aware without the split preflight or the planner`);
  }
  return gaps;
}
const source = (path: string): [string, string] => [path, readFileSync(join(root, path), 'utf8')];

test('every file writer in src is reviewed with a ceiling, a class and its split preflight', () => {
  const census = loadCensus();
  for (const [path, row] of census.inventory) {
    expect(CLASSES).toContain(row.klass);
    expect(row.reason.length).toBeGreaterThan(20);
    expect(existsSync(join(root, path))).toBe(true);
  }
  for (const [key, kind] of census.helpers) {
    expect(['helper', 'entry']).toContain(kind);
    const [path, name] = key.split('#') as [string, string];
    expect(wrappersIn(readFileSync(join(root, path), 'utf8'))).toContain(name);
  }
  const sources = files(join(root, 'src')).map(file => source(relative(root, file)));
  const scanned = new Set(sources.map(([path]) => path));
  const gaps = gapsFor([...sources, ...[...census.inventory.keys()].filter(path => !scanned.has(path)).map(source)], census);
  expect(gaps, 'Classify each file write in split-layout-writers.tsv after checking whether it can reach a page path and how it treats a split page.').toEqual([]);
});

test('a planted bypass fails the census: a new writer, an over-ceiling or indirect write, an unlisted helper, a dropped preflight (direct or in a helper), a parts-directory shortcut, a not_page_path .md write', () => {
  const census = loadCensus();
  // test-reads-source-ok[structural]: the census is a source-text tripwire by design; the planted copies prove it flags a bypass.
  const [, demo] = source('src/commands/sources-demo.ts');
  const [, lint] = source('src/commands/lint.ts');
  const [, repair] = source('src/core/repair/frontmatter.ts');
  const [, config] = source('src/core/config.ts');
  const demoRow = census.inventory.get('src/commands/sources-demo.ts')!;
  expect(gapsFor([['src/commands/sources-demo.ts', demo], ['src/commands/lint.ts', lint], ['src/core/repair/frontmatter.ts', repair], ['src/core/config.ts', config]], census)).toEqual([]);
  expect(gapsFor([
    ['src/core/cycle/new-writer.ts', "writeFileSync(join(root, 'notes/example.md'), page);"],
    ['src/core/cycle/new-indirect-writer.ts', "atomicWrite(join(root, 'notes/example.md'), page);"],
    ['src/core/cycle/new-helper.ts', "export function saveExamplePage(path: string, page: string): void {\n  renameSync(path + '.tmp', path);\n}\n"],
    ['src/commands/sources-demo.ts', `${demo}\nwriteFileSync(path, page);`],
    ['src/commands/lint.ts', lint.replace(/writeSplitPageFile|assertSplitWritable|assertOneFileWritable/g, 'writeEditedPage')],
    ['src/core/repair/frontmatter.ts', repair.replace(/oneFileWriteRefusal/g, 'repairWriteCheck')],
  ], census)).toEqual([
    'src/core/cycle/new-writer.ts: 1 file writes; reviewed ceiling 0',
    'src/core/cycle/new-indirect-writer.ts: 1 file writes; reviewed ceiling 0',
    'src/core/cycle/new-helper.ts: 1 file writes; reviewed ceiling 0',
    'src/core/cycle/new-helper.ts: saveExamplePage wraps a file write and is not a listed write helper',
    `src/commands/sources-demo.ts: ${demoRow.ceiling + 1} file writes; reviewed ceiling ${demoRow.ceiling}`,
    'src/commands/lint.ts: split_aware without the split preflight or the planner',
    'src/core/repair/frontmatter.ts: refuse_before_write without the split preflight',
  ]);
  expect(gapsFor([['src/commands/report.ts', source('src/commands/report.ts')[1].replace(/import \{ assertOneFileWritable \}[^\n]*\n/, '').replace('assertOneFileWritable(filepath, page);', 'if (existsSync(partsDirFor(filepath))) throw new Error(filepath);')]], census))
    .toEqual(['src/commands/report.ts: 1 parts-directory checks outside the split helper; reviewed readers 0', 'src/commands/report.ts: refuse_before_write without the split preflight']);
  const [, atomic] = source('src/core/bootstrap/atomic-write.ts');
  expect(gapsFor([['src/core/bootstrap/atomic-write.ts', atomic.replace(/assertOneFileWritable/g, 'writeCheck')], source('src/commands/compile-context.ts')], census)).toEqual([
    'src/core/bootstrap/atomic-write.ts: refuse_before_write without the split preflight',
    'src/commands/compile-context.ts: its split preflight lives in src/core/bootstrap/atomic-write.ts, which is not a classified writer naming the preflight',
  ]);
  const configRow = census.inventory.get('src/core/config.ts')!;
  expect(configRow.klass).toBe('not_page_path');
  expect(gapsFor([['src/core/config.ts', config.replace(/^(export function saveConfig)/m, "function seedNote(dir: string) { return join(dir, 'SKILL.md'); }\n$1")]], census))
    .toEqual(['src/core/config.ts: not_page_path names a .md file without saying why it is never a page']);
});

test('every canonical database writer that also writes files has a row', () => {
  const census = loadCensus();
  const canonical = rowsOf('canonical-writers.tsv').map(([path]) => path!);
  const missing = canonical.filter(path => existsSync(join(root, path)) && count(readFileSync(join(root, path), 'utf8'), census) > 0 && !census.inventory.has(path));
  expect(missing).toEqual([]);
});

test('the census counts every write primitive and helper call and no read', () => {
  const census = loadCensus();
  expect(count("writeFileSync(a, b); await fsp.writeFile(a, b); renameSync(a, b); await rename(a, b); createWriteStream(a); copyFileSync(a, b); await Bun.write(a, b); atomicWriteFileSync(a, b); openSync(a, 'wx', 0o600); await open(a, 'w'); openSync(a, constants.O_WRONLY | constants.O_CREAT); atomicWrite(a, b); writePageTemp(a, b, c)", census)).toBe(13);
  expect(count("readFileSync(a); openSync(a, 'r'); this.rename(a); stream.write(b); existsSync(a); x.atomicWrite(a)", census)).toBe(0);
  expect(wrappersIn("export function a() {\n  return 1;\n}\nexport async function b(p: string) {\n  await writeFile(p, '');\n}\n")).toEqual(['b']);
  expect(wrappersIn("export function home(): string { return join(dir, 'x'); }\nfunction write(p: string) {\n  writeFileSync(p, '');\n}\n// renameSync(a, b) in a comment\nexport const c = () => 1;\n")).toEqual([]);
});
