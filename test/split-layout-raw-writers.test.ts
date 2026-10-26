/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): writers that edit a canonical file outside the publication
 * door, on a split page.
 *
 * 1. Protects: git stays the parent, and only the publication door of a git-canonical source (canonical: git) creates,
 *    changes or removes a split page (a head plus part files in `.<name>.gbparts/`). A raw writer outside the door (the
 *    takes fence writers, `gbrain think --take`, the timeline write-through, the derived and dream page files, the
 *    phantom redirect, the offline GitHub demo, the classic GitHub and Google connectors, lint --fix, check-backlinks fix,
 *    takes revisit, frontmatter validate --fix) refuses `split_page_unsupported` (reason `outside_door`) on any path of a
 *    split unit (a head, a part, a head declaring gbrain_parts whose parts directory is missing, a page path beside an
 *    orphaned parts directory) before its first file or database write, so the head, every part and the rows stay byte
 *    for byte, no temporary copy is left and no file gets a wider mode. A page in no split unit is written as one file at
 *    any size, as master writes it (the brainstorm save, the classic concept publication, the phantom redirect into a
 *    database-only canonical page, a long GitHub item, a backlink that grows a page): no parts directory, no head. A
 *    managed lint fix on a git-canonical source publishes through the door, which keeps the page a head plus parts.
 *    Scans (lint, the backlink scan) read the whole page; lint's scan still holds a split head whose parts directory is
 *    missing (split_page_incomplete) and never fixes it.
 * 2. Fails when: a writer outside the door writes, renames or removes any file of a split unit, lets the database take
 *    an edit the files refused, leaves a temporary copy, refuses with another code than split_page_unsupported, lays a
 *    page out as a head plus parts, refuses a page in no split unit for its size, or a scan reads only the head's lead.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt) for every case that uses an
 *    engine. KB-sized limits through __setSplitLimitsForTests (thresholdDefault 1024). Split pages outside a door are
 *    laid out by test/helpers/split-page.ts; the managed door case makes its source git-canonical.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { findBacklinkGaps, fixBacklinkGaps } from '../src/commands/backlinks.ts';
import { formatSaveOutcome, persistSavedIdea } from '../src/commands/brainstorm.ts';
import { runFrontmatter } from '../src/commands/frontmatter.ts';
import { publishClassicConcept } from '../src/core/cycle/concept-publication.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runLintCore } from '../src/commands/lint.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runSourcesDemo } from '../src/commands/sources-demo.ts';
import { runTakes } from '../src/commands/takes.ts';
import { removeDreamPageFile, writeDerivedPageThrough, writeDreamPageFile } from '../src/core/cycle/derived-write-through.ts';
import { runPhantomRedirectPass } from '../src/core/cycle/phantom-redirect.ts';
import { gitHubStateFile, itemPagePath, parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { deletePageByRelPath, importRendered, type GoogleSyncDeps, type GoogleSyncSummary } from '../src/core/google/sweep-shared.ts';
import { DEMO_ITEMS } from '../src/fixtures/github-demo.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { assertOutsideDoorWritable } from '../src/core/split-write-through.ts';
import { parseTakesFence, upsertTakeRow } from '../src/core/takes-fence.ts';
import { addTakeToPage, appendTakesToPageMdFirst, updateTakeOnPage } from '../src/core/takes-write.ts';
import { persistTakeFromSynthesis } from '../src/core/think/persist-take.ts';
import { writeTimelineEntryThrough } from '../src/core/timeline-write-through.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdDefault: 1024, thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/big-example';
const lines = (tag: string) => Array.from({ length: 80 }, (_, i) => `${tag} line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const body = lines('Body').join('\n');
const file = `---\ntype: note\ntitle: Split example\n---\n\n${body}\n`;
const PREAMBLE = 'Of course. Here is a detailed brain page for Alice Example.';
const take = { claim: 'Acme-example ships weekly', kind: 'take' as const, holder: 'world' };
/** The page body with a takes fence at its end, so the fence sits in the part files of the split layout. */
const takesBody = upsertTakeRow(body, { claim: 'Acme-example hires slowly', kind: 'take', holder: 'world', weight: 0.5, active: true }).body;

/** The head and every part file, by name, as they are on disk (null when gone). */
const layout = (path: string) => {
  const dir = partsDirFor(path);
  return {
    head: existsSync(path) ? readFileSync(path, 'utf8') : null,
    parts: existsSync(dir) ? Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')])) : null,
  };
};

/** The page file at `path`: F' for a split head, whose parts directory must hold exactly its manifest. */
const pageFile = (path: string): { split: boolean; text: string } => {
  const read = readPageFile(path);
  if (read.hold) throw new Error(`${path}: ${read.hold.code}`);
  if (read.split) {
    const parsed = parseHead(read.head.toString('utf8'));
    if (!parsed || 'error' in parsed) throw new Error(`${path} does not parse as a head`);
    expect(readdirSync(partsDirFor(path)).sort()).toEqual(parsed.manifest.parts.map(part => part.path.split('/').pop()!).sort());
  }
  return { split: read.split, text: read.bytes.toString('utf8') };
};

/** The page's stored body and timeline. */
const stored = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string; timeline: string }>(
  "SELECT compiled_truth, timeline FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))[0];

/** The page's files and every database row a raw writer could change, compared around a refused write. */
const snapshot = async (engine: BrainEngine, head: string) => ({ files: layout(head),
  pages: await engine.executeRaw('SELECT slug, compiled_truth, timeline, frontmatter FROM pages ORDER BY slug'),
  takes: await engine.executeRaw('SELECT row_num, claim, weight, active FROM takes ORDER BY row_num'),
  timeline: await engine.executeRaw('SELECT * FROM timeline_entries ORDER BY id') });

/** What a writer returned, or the code and message it threw, as JSON: where it reports a refusal code. */
const outcomeOf = async (run: () => Promise<unknown>) => JSON.stringify(await run().then(value => value, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message })));

/** `gbrain frontmatter validate <path> <args>` in-process: its output and exit verdict (reset afterwards). */
async function validateFix(path: string, args = ['--fix']): Promise<{ out: string; verdict: number }> {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const prevExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
  try {
    await runFrontmatter(['validate', path, ...args]);
    return { out: out.join('\n'), verdict: currentExitCode() };
  } finally {
    log.mockRestore();
    _resetCliExitVerdictForTests();
    process.exitCode = prevExitCode ?? 0;
  }
}

/** A GBRAIN_HOME with the split limits set and an empty checkout root. */
async function withHome(run: (home: string, root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'split-raw-writers-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      __setSplitLimitsForTests(LIMITS);
      const root = join(home, 'brain');
      mkdirSync(root, { recursive: true });
      await run(home, root);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** An unmanaged brain whose default source is `root`, with SLUG stored as `compiledTruth` and laid out as a split head of the same page. */
async function withSplitPage(databaseUrl: string | undefined, run: (engine: BrainEngine, root: string, head: string, home: string) => Promise<void>, compiledTruth = body) {
  await withHome(async (home, root) => {
    _resetWriteThroughCacheForTest();
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
      await engine.setConfig('sync.repo_path', root);
      await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: compiledTruth });
      const written = await writeSplitPage(root, `${SLUG}.md`, `---\ntype: note\ntitle: Split example\n---\n\n${compiledTruth}\n`);
      expect(written.parts.length).toBeGreaterThan(2);
      await run(engine, root, join(root, `${SLUG}.md`), home);
    } finally { await close(); _resetWriteThroughCacheForTest(); }
  });
}

const PHANTOM_BODY = '# alice\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Founded acme-example | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |\n<!--- gbrain:facts:end -->\n';

for (const backend of testBackends()) describe(`[${backend}] split git layout: raw writers outside the door`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });

  test('the takes fence writers refuse a split page (split_page_unsupported, outside_door); files and takes rows stay', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const target = { engine, slug: SLUG, brainDir: root, sourceId: 'default' };
    const before = await snapshot(engine, head);
    for (const write of [() => addTakeToPage(target, take), () => appendTakesToPageMdFirst(target, [{ ...take, claim: 'Acme-example opens a second office' }]), () => updateTakeOnPage(target, 1, { weight: 0.9 })]) {
      expect(await outcomeOf(write)).toContain('split_page_unsupported (outside_door)');
      expect(await snapshot(engine, head)).toEqual(before);
    }
  }, takesBody), 120_000);

  test('think --take on a split anchor refuses (split_page_unsupported, outside_door); files and takes rows stay', () => withSplitPage(databaseUrl, async (engine, _root, head) => {
    const before = await snapshot(engine, head);
    expect(await outcomeOf(() => persistTakeFromSynthesis(engine, { answer: 'Acme-example ships weekly.', synthesisOk: true }, { anchor: SLUG }))).toContain('split_page_unsupported (outside_door)');
    expect(await snapshot(engine, head)).toEqual(before);
  }, takesBody), 120_000);

  test('the timeline write-through refuses an entry on a split page (split_page_unsupported); files and timeline rows stay', () => withSplitPage(databaseUrl, async (engine, _root, head) => {
    const before = await snapshot(engine, head);
    expect(await outcomeOf(() => writeTimelineEntryThrough(engine, SLUG, 'default', { date: '2026-01-02', summary: 'Acme-example shipped' }))).toContain('split_page_unsupported');
    expect(await snapshot(engine, head)).toEqual(before);
  }), 120_000);

  test('a raw writer refuses any path of a split unit (split_page_unsupported, outside_door), even an edit whose parts would all stay: the head and every part stay', () => withSplitPage(databaseUrl, async (_engine, root, head) => {
    const before = layout(head);
    const retitled = file.replace('title: Split example', 'title: Split example retitled');
    const part = join(partsDirFor(head), readdirSync(partsDirFor(head))[0]!);
    for (const [path, content] of [[head, retitled], [head, '---\ntype: note\ntitle: Split example\n---\n\nShort again.\n'], [part, 'part bytes\n']] as const) {
      const refused = await assertOutsideDoorWritable({ root, path, route: 'raw_writer', sourceId: 'default', slug: SLUG }, content).then(() => null, error => error);
      expect(refused?.code).toBe('split_page_unsupported');
      expect(refused?.reason).toBe('outside_door');
      expect(layout(head)).toEqual(before);
    }
    expect(readdirSync(join(root, 'notes')).filter(name => name.includes('.tmp'))).toEqual([]);
  }), 120_000);

  test('a page in no split unit passes the check outside the door at any size: a raw writer writes it as one file, as master does', () => withSplitPage(databaseUrl, async (_engine, root) => {
    const grown = join(root, 'notes/grown-example.md');
    writeFileSync(grown, '---\ntype: note\ntitle: Grown example\n---\n\nShort.\n');
    expect(Buffer.byteLength(file)).toBeGreaterThan(LIMITS.thresholdDefault);
    await assertOutsideDoorWritable({ root, path: grown, route: 'raw_writer', sourceId: 'default', slug: 'notes/grown-example' }, file);
    expect(existsSync(partsDirFor(grown))).toBe(false);
  }), 120_000);

  test('on a private (0600) split page the timeline, derived and dream page writers refuse before any temporary copy (split_page_unsupported): nothing is left beside the head and no file is wider than 0600', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const unit = [head, ...readdirSync(partsDirFor(head)).map(name => join(partsDirFor(head), name))];
    for (const path of unit) chmodSync(path, 0o600);
    const listed = readdirSync(join(root, 'notes')).sort();
    const umask = process.umask(0o022);
    try {
      expect(await outcomeOf(() => writeTimelineEntryThrough(engine, SLUG, 'default', { date: '2026-01-02', summary: 'Acme-example shipped' }))).toContain('split_page_unsupported');
      await engine.createVersion(SLUG);
      await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: `${body}\n\nA derived edit.\n` });
      expect(await outcomeOf(() => writeDerivedPageThrough(engine, SLUG, 'default'))).toContain('split_page_unsupported');
      const dream = `${pageFile(head).text.trimEnd()}\n\nA dream edit.\n`;
      expect(await outcomeOf(() => writeDreamPageFile(engine, root, SLUG, 'default', { nativeSourceId: 'default', markdown: dream }))).toContain('split_page_unsupported');
    } finally { process.umask(umask); }
    expect(readdirSync(join(root, 'notes')).sort()).toEqual(listed);
    expect(readdirSync(partsDirFor(head)).map(name => join(partsDirFor(head), name)).concat(head).sort()).toEqual([...unit].sort());
    for (const path of unit) expect(statSync(path).mode & 0o777).toBe(0o600);
  }), 120_000);

  test('on a private (0600) one-file page the timeline and dream page writers write through a temporary copy with its mode: the page keeps 0600 and no copy is left', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    rmSync(partsDirFor(head), { recursive: true });
    await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: 'Short.' });
    writeFileSync(head, '---\ntype: note\ntitle: Split example\n---\n\nShort.\n');
    chmodSync(head, 0o600);
    const umask = process.umask(0o022);
    try {
      await writeTimelineEntryThrough(engine, SLUG, 'default', { date: '2026-01-02', summary: 'Acme-example shipped' });
      expect(pageFile(head)).toMatchObject({ split: false, text: expect.stringContaining('Acme-example shipped') });
      expect(statSync(head).mode & 0o777).toBe(0o600);
      const dream = `${pageFile(head).text.trimEnd()}\n\nA dream edit.\n`;
      expect(await writeDreamPageFile(engine, root, SLUG, 'default', { nativeSourceId: 'default', markdown: dream })).toMatchObject({ written: true });
      expect(pageFile(head).text).toBe(dream);
      expect(statSync(head).mode & 0o777).toBe(0o600);
    } finally { process.umask(umask); }
    expect(readdirSync(join(root, 'notes')).filter(name => name !== 'big-example.md')).toEqual([]);
  }), 120_000);

  test('a derived page and a dream page file on a split page are refused (split_page_unsupported, outside_door); the files stay', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    await engine.createVersion(SLUG);
    await engine.putPage(SLUG, { type: 'note', title: 'Split example', compiled_truth: `${body}\n\nA derived edit.\n` });
    const files = layout(head);
    expect(await outcomeOf(() => writeDerivedPageThrough(engine, SLUG, 'default'))).toContain('split_page_unsupported');
    expect(layout(head)).toEqual(files);
    const dream = `${pageFile(head).text.trimEnd()}\n\nA dream edit.\n`;
    expect(await outcomeOf(() => writeDreamPageFile(engine, root, SLUG, 'default', { nativeSourceId: 'default', markdown: dream }))).toContain('split_page_unsupported');
    expect(layout(head)).toEqual(files);
    expect(await removeDreamPageFile(engine, root, SLUG, 'default', 'default')).toMatchObject({ removed: false, held: expect.stringContaining('split_page_unsupported') });
    expect(layout(head)).toEqual(files);
  }), 120_000);

  test('the phantom redirect refuses to merge rows into a split canonical page (split_page_unsupported, outside_door); files and pages stay', () => withHome(async (home, root) => {
    _resetWriteThroughCacheForTest();
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const canonicalBody = `# Alice Example\n\n${lines('Alice').join('\n')}\n`;
        for (const [slug, title, text] of [['people/alice-example', 'Alice Example', canonicalBody], ['alice', 'alice', PHANTOM_BODY]] as const) {
          const page = await engine.putPage(slug, { type: 'person', title, compiled_truth: text, timeline: '', frontmatter: {} });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
        }
        mkdirSync(join(root, 'people'), { recursive: true });
        await writeSplitPage(root, 'people/alice-example.md', `---\ntype: person\ntitle: Alice Example\n---\n\n${canonicalBody}`);
        writeFileSync(join(root, 'alice.md'), PHANTOM_BODY);
        const head = join(root, 'people/alice-example.md');
        const before = await snapshot(engine, head);
        const phantom = readFileSync(join(root, 'alice.md'), 'utf8');
        const result = await runPhantomRedirectPass(engine, root, 'default', false);
        expect(JSON.stringify(result)).toContain('split_page_unsupported');
        expect(await snapshot(engine, head)).toEqual(before);
        expect(readFileSync(join(root, 'alice.md'), 'utf8')).toBe(phantom);
      });
    } finally { await close(); _resetWriteThroughCacheForTest(); }
  }), 120_000);

  test('a brainstorm save of a page over the split threshold on a source that is not git-canonical writes one file, as master does: the row and one page file, no parts directory, exit 0', () => withHome(async (_home, root) => {
    _resetWriteThroughCacheForTest();
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
      await engine.setConfig('sync.repo_path', root);
      const slug = 'ideas/large-example';
      const outcome = await persistSavedIdea(engine, { slug, content: `---\ntype: note\ntitle: Saved idea example\n---\n\n${body}\n`, provenanceVia: 'brainstorm' });
      const message = formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug });
      expect(message.exitCode).toBe(0);
      expect(message.stderr.join('\n')).not.toContain('split_page_unsupported');
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain(lines('Body')[79]);
      const page = join(root, `${slug}.md`);
      expect(Buffer.byteLength(readFileSync(page))).toBeGreaterThan(LIMITS.thresholdDefault);
      expect(pageFile(page)).toMatchObject({ split: false, text: expect.stringContaining(lines('Body')[79]) });
      expect(existsSync(partsDirFor(page))).toBe(false);
    } finally { await close(); _resetWriteThroughCacheForTest(); }
  }), 120_000);

  test('a classic concept publication over the split threshold on a source that is not git-canonical writes one file, as master does, then imports', () => withHome(async (_home, root) => {
    _resetWriteThroughCacheForTest();
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
      const slug = 'concepts/big-example';
      let imported = false;
      const publish = publishClassicConcept(engine, slug, 'default', { synthesized_by: 'synthesize_concepts' }, body, '',
        { writeThrough: true, importPage: async markdown => { imported = true; return importFromContent(engine, slug, markdown, { noEmbed: true }); } });
      await publish;
      expect(imported).toBe(true);
      const page = join(root, `${slug}.md`);
      expect(Buffer.byteLength(readFileSync(page))).toBeGreaterThan(LIMITS.thresholdDefault);
      expect(pageFile(page)).toMatchObject({ split: false, text: expect.stringContaining(lines('Body')[79]) });
      expect(existsSync(partsDirFor(page))).toBe(false);
    } finally { await close(); _resetWriteThroughCacheForTest(); }
  }), 120_000);

  for (const layout of ['split', 'one file'] as const) {
    test(`the phantom redirect on a private ${layout} canonical page leaves no temporary copy and keeps the page file's 0600 mode${layout === 'split' ? ' (split_page_unsupported)' : ''}`, () => withHome(async (home, root) => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      const umask = process.umask(0o022);
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
          await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
          const canonicalBody = layout === 'split' ? `# Alice Example\n\n${lines('Alice').join('\n')}\n` : '# Alice Example\n\nA short page.\n';
          for (const [slug, title, text] of [['people/alice-example', 'Alice Example', canonicalBody], ['alice', 'alice', PHANTOM_BODY]] as const) {
            const page = await engine.putPage(slug, { type: 'person', title, compiled_truth: text, timeline: '', frontmatter: {} });
            await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
          }
          mkdirSync(join(root, 'people'), { recursive: true });
          const head = join(root, 'people/alice-example.md');
          const canonical = `---\ntype: person\ntitle: Alice Example\n---\n\n${canonicalBody}`;
          if (layout === 'split') await writeSplitPage(root, 'people/alice-example.md', canonical);
          else writeFileSync(head, canonical);
          for (const path of [head, ...(existsSync(partsDirFor(head)) ? readdirSync(partsDirFor(head)).map(name => join(partsDirFor(head), name)) : [])]) chmodSync(path, 0o600);
          writeFileSync(join(root, 'alice.md'), PHANTOM_BODY);
          const result = await runPhantomRedirectPass(engine, root, 'default', false);
          if (layout === 'split') expect(JSON.stringify(result)).toContain('split_page_unsupported');
          else expect(readFileSync(head, 'utf8')).toContain('Founded acme-example');
          expect(readdirSync(join(root, 'people')).filter(name => name.includes('.tmp'))).toEqual([]);
          expect(statSync(head).mode & 0o777).toBe(0o600);
        });
      } finally { process.umask(umask); await close(); _resetWriteThroughCacheForTest(); }
    }), 120_000);
  }

  test('the phantom redirect into a database-only canonical page over the split threshold writes the canonical file as one file, as master does: no parts directory', () => withHome(async (home, root) => {
    _resetWriteThroughCacheForTest();
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        for (const [slug, title, text] of [['people/alice-example', 'Alice Example', `# Alice Example\n\n${lines('Alice').join('\n')}\n`], ['alice', 'alice', PHANTOM_BODY]] as const) {
          const page = await engine.putPage(slug, { type: 'person', title, compiled_truth: text, timeline: '', frontmatter: {} });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
        }
        writeFileSync(join(root, 'alice.md'), PHANTOM_BODY);
        const result = await runPhantomRedirectPass(engine, root, 'default', false);
        expect(result).toMatchObject({ redirected: 1, failures: [], touched_canonicals: ['people/alice-example'] });
        const canonical = join(root, 'people/alice-example.md');
        expect(Buffer.byteLength(readFileSync(canonical))).toBeGreaterThan(LIMITS.thresholdDefault);
        expect(pageFile(canonical)).toMatchObject({ split: false, text: expect.stringContaining('Founded acme-example') });
        expect(pageFile(canonical).text).toContain(lines('Alice')[79]);
        expect(readdirSync(join(root, 'people'))).toEqual(['alice-example.md']);
      });
    } finally { await close(); _resetWriteThroughCacheForTest(); }
  }), 120_000);

  test('the offline GitHub demo refuses (split_page_unsupported) before it writes any page when a demo page path is a split head: the head, its parts and the other pages stay', () => withSplitPage(databaseUrl, async (engine, root) => {
    const item = DEMO_ITEMS[0]!;
    const head = itemPagePath(root, item.repo, item.number);
    const big = `---\ntype: note\ntitle: Demo example\n---\n\n${lines('Demo').join('\n')}\n`;
    await writeSplitPage(root, head.slice(root.length + 1), big);
    const before = layout(head);
    const listed = readdirSync(join(root, 'gh'), { recursive: true }).map(String).sort();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect((await runSourcesDemo(engine, ['github', '--dir', root]).then(() => null, error => error))?.code).toBe('split_page_unsupported');
    } finally { log.mockRestore(); }
    expect(layout(head)).toEqual(before);
    expect(readdirSync(join(root, 'gh'), { recursive: true }).map(String).sort()).toEqual(listed);
  }), 120_000);

  test('the classic Google connector refuses an edit of a split page (split_page_unsupported, outside_door) before its import, and refuses a delete of the split page before its row goes', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], threadsSeen: 0, attachmentInspection: {} } as unknown as GoogleSyncSummary;
    const deps = { managed: null, engine, sourceId: 'default', cfg: { dir: root, account: 'owner@example.invalid' }, opts: {}, entry: {}, log() {}, tick() {} } as unknown as GoogleSyncDeps;
    const before = await snapshot(engine, head);
    expect(await outcomeOf(() => importRendered(deps, `${SLUG}.md`, file.replace('Body line 0001', 'Edited line 0001'), null as never, summary, new Set()))).toContain('split_page_unsupported');
    expect(await snapshot(engine, head)).toEqual(before);
    await engine.executeRaw("UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2", [`${SLUG}.md`, SLUG]);
    const stored = await snapshot(engine, head);
    expect(await outcomeOf(() => deletePageByRelPath(deps, `${SLUG}.md`, summary))).toContain('split_page_unsupported');
    expect(await snapshot(engine, head)).toEqual(stored);
    expect(await engine.getPage(SLUG, { sourceId: 'default' })).not.toBeNull();
    expect(summary.deleted).toBe(0);
  }), 120_000);

  test('the classic GitHub connector refuses to reconcile away a split item page (split_page_unsupported) before its row goes: row and files stay, the sweep is partial', () => withHome(async (_home, root) => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await withEnv({ CONNECTOR_TEST_TOKEN: 'fixture-token' }, async () => {
        const repo = 'acme-example/app';
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
        const fetcher = async (url: string) => {
          const path = new URL(url).pathname;
          if (path.endsWith('/issues') || path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
          if (path === `/repos/${repo}`) return json({ full_name: repo, private: true, default_branch: 'main' });
          throw new Error(`Unexpected fixture route ${path}`);
        };
        const cfg = parseGitHubSourceConfig({ kind: 'github', gh_scope: 'repos', gh_repos: repo, gh_token_env: 'CONNECTOR_TEST_TOKEN' }, root);
        const slug = `gh/${repo}/1`, head = itemPagePath(root, repo, 1);
        await engine.putPage(slug, { type: 'note', title: 'Split example', compiled_truth: body });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE slug = $2', [`${slug}.md`, slug]);
        await writeSplitPage(root, `${slug}.md`, file);
        const item = async () => ({ files: layout(head), row: await engine.executeRaw('SELECT compiled_truth, source_path, deleted_at FROM pages WHERE slug = $1', [slug]) });
        const before = await item();
        expect(await runGitHubSync(engine, 'default', cfg, { noPull: true, noEmbed: true, full: true } as never, fetcher)).toMatchObject({ status: 'partial', deleted: 0, failedFiles: 1 });
        expect(await item()).toEqual(before);
      });
    } finally { await close(); }
  }), 120_000);

  test('the phantom redirect refuses a phantom page file with a parts directory (split_page_unsupported) before it merges a row: files and pages stay', () => withHome(async (home, root) => {
    _resetWriteThroughCacheForTest();
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const canonicalBody = '# Alice Example\n\nA short synthetic canonical page.\n';
        for (const [slug, title, text] of [['people/alice-example', 'Alice Example', canonicalBody], ['alice', 'alice', PHANTOM_BODY]] as const) {
          const page = await engine.putPage(slug, { type: 'person', title, compiled_truth: text, timeline: '', frontmatter: {} });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
        }
        mkdirSync(join(root, 'people'), { recursive: true });
        writeFileSync(join(root, 'people/alice-example.md'), `---\ntype: person\ntitle: Alice Example\n---\n\n${canonicalBody}`);
        const phantom = join(root, 'alice.md');
        writeFileSync(phantom, PHANTOM_BODY);
        mkdirSync(partsDirFor(phantom));
        writeFileSync(join(partsDirFor(phantom), '0001-00000000.gbpart'), 'A part file of an earlier split layout.\n');
        const before = { ...(await snapshot(engine, phantom)), canonical: readFileSync(join(root, 'people/alice-example.md'), 'utf8') };
        expect(JSON.stringify(await runPhantomRedirectPass(engine, root, 'default', false))).toContain('split_page_unsupported');
        expect({ ...(await snapshot(engine, phantom)), canonical: readFileSync(join(root, 'people/alice-example.md'), 'utf8') }).toEqual(before);
      });
    } finally { await close(); _resetWriteThroughCacheForTest(); }
  }), 120_000);

  test('the classic GitHub connector writes an item over the split threshold as one file, as master does: a long item, a short edit and a long edit again are each one page file, and a delete removes it', () => withHome(async (_home, root) => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await withEnv({ CONNECTOR_TEST_TOKEN: 'fixture-token' }, async () => {
        const repo = 'acme-example/app';
        const issue = { number: 1, title: 'Example issue', state: 'open', body: 'A synthetic issue body.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: [], assignees: [], user: { login: 'example-user' }, html_url: `https://github.com/${repo}/issues/1` };
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
        const fetcher = async (url: string) => {
          const path = new URL(url).pathname;
          if (path.endsWith('/issues')) return json([issue]);
          if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
          if (path.endsWith('/issues/1')) return json(issue);
          if (path === `/repos/${repo}`) return json({ full_name: repo, private: true, default_branch: 'main' });
          throw new Error(`Unexpected fixture route ${path}`);
        };
        const cfg = parseGitHubSourceConfig({ kind: 'github', gh_scope: 'repos', gh_repos: repo, gh_token_env: 'CONNECTOR_TEST_TOKEN' }, root);
        const big = Array.from({ length: 60 }, (_, i) => `Issue line ${String(i).padStart(4, '0')} of a long synthetic issue body that fills parts.`).join('\n');
        const head = itemPagePath(root, repo, 1);
        const sync = (opts: Record<string, unknown> = {}) => runGitHubSync(engine, 'default', cfg, { noPull: true, noEmbed: true, full: true, ...opts } as never, fetcher);
        const held = () => JSON.stringify(JSON.parse(readFileSync(gitHubStateFile(root), 'utf8')).item_holds?.items?.[repo + '#1'] ?? null);
        const oneFile = async (text: string) => {
          expect(held()).toBe('null');
          expect(pageFile(head)).toMatchObject({ split: false, text: expect.stringContaining(text) });
          expect(existsSync(partsDirFor(head))).toBe(false);
          expect((await engine.getPage('gh/' + repo + '/1', { sourceId: 'default' }))?.compiled_truth).toContain(text);
        };
        const lastLine = big.split('\n').pop()!;
        issue.body = big;
        expect((await sync()).status).not.toBe('partial');
        expect(Buffer.byteLength(readFileSync(head))).toBeGreaterThan(LIMITS.thresholdDefault);
        await oneFile(lastLine);
        issue.updated_at = '2026-01-03T00:00:00Z';
        issue.body = 'A short synthetic issue body.';
        expect((await sync()).status).not.toBe('partial');
        await oneFile('A short synthetic issue body.');
        expect(readFileSync(head, 'utf8')).not.toContain(lastLine);
        issue.updated_at = '2026-01-04T00:00:00Z';
        issue.body = big;
        expect((await sync()).status).not.toBe('partial');
        await oneFile(lastLine);
        await sync({ githubItem: { repo, number: 1, kind: 'issue', deleted: true } });
        expect(layout(head)).toEqual({ head: null, parts: null });
        expect(await engine.getPage('gh/' + repo + '/1', { sourceId: 'default' })).toBeNull();
      });
    } finally { await close(); }
  }), 120_000);

  test('the classic Google connector refuses a page beside an orphaned parts directory (split_page_unsupported, outside_door) before its database import: nothing is stored and no file is written', () => withSplitPage(databaseUrl, async (engine, root) => {
    const summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], threadsSeen: 0, attachmentInspection: {} } as unknown as GoogleSyncSummary;
    const deps = { managed: null, engine, sourceId: 'default', cfg: { dir: root, account: 'owner@example.invalid' }, opts: {}, entry: {}, log() {}, tick() {} } as unknown as GoogleSyncDeps;
    const head = join(root, 'notes/connector-example.md');
    mkdirSync(partsDirFor(head), { recursive: true });
    writeFileSync(join(partsDirFor(head), 'README.txt'), 'Unrelated local data\n');
    const refused = await importRendered(deps, 'notes/connector-example.md', file, null as never, summary, new Set()).then(() => null, error => error);
    expect([refused?.code, refused?.reason]).toEqual(['split_page_unsupported', 'outside_door']);
    expect(await engine.getPage('notes/connector-example', { sourceId: 'default' })).toBeNull();
    expect(layout(head)).toEqual({ head: null, parts: { 'README.txt': 'Unrelated local data\n' } });
    expect(readdirSync(join(root, 'notes')).filter(name => name.startsWith('connector-example.md'))).toEqual([]);
  }), 120_000);

  test('the classic GitHub connector refuses a split write before its database import: nothing is stored and no file is written', () => withHome(async (_home, root) => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await withEnv({ CONNECTOR_TEST_TOKEN: 'fixture-token' }, async () => {
        const repo = 'acme-example/app';
        const big = Array.from({ length: 60 }, (_, i) => `Issue line ${String(i).padStart(4, '0')} of a long synthetic issue body that fills parts.`).join('\n');
        const issue = { number: 1, title: 'Example issue', state: 'open', body: big, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: [], assignees: [], user: { login: 'example-user' }, html_url: `https://github.com/${repo}/issues/1` };
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
        const fetcher = async (url: string) => {
          const path = new URL(url).pathname;
          if (path.endsWith('/issues')) return json([issue]);
          if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
          if (path.endsWith('/issues/1')) return json(issue);
          if (path === `/repos/${repo}`) return json({ full_name: repo, private: true, default_branch: 'main' });
          throw new Error(`Unexpected fixture route ${path}`);
        };
        const cfg = parseGitHubSourceConfig({ kind: 'github', gh_scope: 'repos', gh_repos: repo, gh_token_env: 'CONNECTOR_TEST_TOKEN' }, root);
        const head = itemPagePath(root, repo, 1);
        mkdirSync(partsDirFor(head), { recursive: true });
        writeFileSync(join(partsDirFor(head), 'README.txt'), 'Unrelated local data\n');
        await runGitHubSync(engine, 'default', cfg, { noPull: true, noEmbed: true } as never, fetcher).catch(() => undefined);
        expect(await engine.getPage(`gh/${repo}/1`, { sourceId: 'default' })).toBeNull();
        expect(layout(head)).toEqual({ head: null, parts: { 'README.txt': 'Unrelated local data\n' } });
      });
    } finally { await close(); }
  }), 120_000);

  test('an unmanaged lint --fix refuses a fix of a split page (split_page_unsupported, outside_door) and leaves the page as it was', () => withSplitPage(databaseUrl, async (engine, root, head) => {
    const content = '---\ntype: note\ntitle: Split example\ncreated: 2026-01-01\n---\n' + PREAMBLE + '\n\n' + body + '\n';
    rmSync(head); rmSync(partsDirFor(head), { recursive: true });
    await writeSplitPage(root, SLUG + '.md', content);
    const before = await snapshot(engine, head);
    const result = await runLintCore({ target: root, fix: true, engine, contentSanity: undefined, typePack: null });
    expect(result.pending_issues.map(issue => issue.code)).toContain('split_page_unsupported');
    expect(await snapshot(engine, head)).toEqual(before);
  }), 120_000);

  for (const brain of ['with', 'without'] as const) {
    test(`lint --fix ${brain} a brain holds a split head whose whole parts directory is missing (split_page_incomplete) and never rewrites the head`, () => withSplitPage(databaseUrl, async (engine, root, head) => {
      const content = '---\ntype: note\ntitle: Split example\ncreated: 2026-01-01\n---\n' + PREAMBLE + '\n\n' + body + '\n';
      rmSync(head); rmSync(partsDirFor(head), { recursive: true });
      await writeSplitPage(root, SLUG + '.md', content);
      rmSync(partsDirFor(head), { recursive: true });
      const before = readFileSync(head, 'utf8');
      const codes: string[] = [];
      const result = await runLintCore({ target: root, fix: true, ...(brain === 'with' ? { engine } : {}), contentSanity: undefined, typePack: null,
        onPageIssues: (_rel, found) => { codes.push(...found.map(issue => issue.code ?? issue.rule)); } });
      expect(result.total_fixed).toBe(0);
      expect(codes).toContain('split_page_incomplete');
      expect(readFileSync(head, 'utf8')).toBe(before);
      expect(existsSync(partsDirFor(head))).toBe(false);
    }), 120_000);
  }

  test('a managed lint fix on a git-canonical source publishes the whole page file through the door; the page stays a head plus parts', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    const content = `---\ntype: note\ntitle: Split example\n---\n${PREAMBLE}\n\n${body}\n`;
    const put = operations.find(o => o.name === 'put_page')!;
    expect(await put.handler(ctx as OperationContext, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    const head = join(root, `${SLUG}.md`);
    expect(pageFile(head)).toMatchObject({ split: true, text: expect.stringContaining(PREAMBLE) });
    const result = await runLintCore({ target: root, fix: true, engine, sourceId: 'default' });
    expect(result.pending_issues).toEqual([]);
    expect(result.fix_pending).toBe(0);
    expect(result.total_fixed).toBeGreaterThan(0);
    const page = pageFile(head);
    expect(page.split).toBe(true);
    expect(page.text).not.toContain(PREAMBLE);
    expect(page.text).toContain(lines('Body')[79]);
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).not.toContain(PREAMBLE);
  }, { databaseUrl, setup: async ({ engine, root }) => {
    writeFileSync(join(root, '.gitignore'), '\n');
    durableGitRepo(root, ['.gitignore']);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
  } }), 120_000);
});

describe('split git layout: filesystem scans and writers on an unmanaged checkout', () => {
  afterEach(() => { __setSplitLimitsForTests(null); });

  test('lint with no brain reads the page a split head stands for and refuses to fix it (split_page_unsupported)', () => withHome(async (_home, root) => {
    const page = `---\ntype: note\ntitle: Split example\ncreated: 2026-01-01\n---\n${PREAMBLE}\n\n${body}\nMet again on YYYY-MM-DD at the end of the page.\n`;
    await writeSplitPage(root, `${SLUG}.md`, page);
    const head = join(root, `${SLUG}.md`);
    const before = layout(head);
    const result = await runLintCore({ target: root, fix: true, contentSanity: undefined, typePack: null });
    expect(layout(head)).toEqual(before);
    expect(result.total_fixed).toBe(0);
    expect(result.pending_issues).toEqual([expect.objectContaining({ file: `${SLUG}.md`, code: 'split_page_unsupported', rule: 'split-page-unsupported', fixable: false,
      message: expect.stringContaining('split_page_unsupported (outside_door)') })]);
    const rules: string[] = [];
    await runLintCore({ target: root, contentSanity: undefined, typePack: null, onPageIssues: (_rel, found) => { rules.push(...found.map(i => i.rule)); } });
    expect(rules).toContain('placeholder-date');
  }), 120_000);

  test('check-backlinks fix writes a backlink that grows a one-file page past the split threshold as one file, as master does, and refuses a split head whose parts directory is missing (split_page_unsupported, outside_door): it stays as it was', () => withHome(async (_home, root) => {
    mkdirSync(join(root, 'people'), { recursive: true });
    const gap = (target: string) => ({ sourcePage: 'notes/meeting.md', targetPage: target, entityName: 'Alice Example', sourceTitle: 'Meeting' });
    const near = join(root, 'people/alice-example.md');
    const before = ('---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n' + 'Synthetic text.\n'.repeat(80)).slice(0, 1020) + '\n';
    writeFileSync(near, before);
    const headless = join(root, 'people/bob-example.md');
    await writeSplitPage(root, 'people/bob-example.md', `---\ntype: person\ntitle: Bob Example\n---\n\n# Bob Example\n\n${lines('Bob').join('\n')}\n`);
    rmSync(partsDirFor(headless), { recursive: true });
    const headBefore = readFileSync(headless, 'utf8');
    const result = await fixBacklinkGaps(root, [gap('people/alice-example.md'), gap('people/bob-example.md')], false, { lockRoot: root });
    expect(result.fixed).toBe(1);
    expect(result.skipped.map(skip => [skip.page, skip.reason.startsWith('split_page_unsupported (outside_door)')])).toEqual([['people/bob-example.md', true]]);
    const grown = readFileSync(near, 'utf8');
    expect(grown.startsWith(before.trimEnd())).toBe(true);
    expect(grown).toContain('notes/meeting');
    expect(Buffer.byteLength(grown)).toBeGreaterThan(LIMITS.thresholdDefault);
    expect(pageFile(near).split).toBe(false);
    expect(readFileSync(headless, 'utf8')).toBe(headBefore);
    expect([existsSync(partsDirFor(near)), existsSync(partsDirFor(headless))]).toEqual([false, false]);
  }), 120_000);

  test('the backlink scan reads split pages whole and check-backlinks fix refuses a split target (split_page_unsupported)', () => withHome(async (_home, root) => {
    mkdirSync(join(root, 'people'), { recursive: true });
    mkdirSync(join(root, 'notes'), { recursive: true });
    await writeSplitPage(root, 'people/alice-example.md', `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${lines('Alice').join('\n')}\n\n- [Meeting](../notes/meeting.md)\n`);
    writeFileSync(join(root, 'notes/meeting.md'), '---\ntype: note\ntitle: Meeting\n---\n\n# Meeting\n\nMet [Alice Example](../people/alice-example.md).\n');
    await writeSplitPage(root, 'notes/big.md', `---\ntype: note\ntitle: Big notes\n---\n\n# Big notes\n\n${lines('Notes').join('\n')}\n\nAlso met [Bob Example](../people/bob-example.md).\n`);
    writeFileSync(join(root, 'people/bob-example.md'), '---\ntype: person\ntitle: Bob Example\n---\n\n# Bob Example\n\nNo backlinks yet.\n');
    expect(findBacklinkGaps(root).map(g => `${g.sourcePage} -> ${g.targetPage}`)).toEqual(['notes/big.md -> people/bob-example.md']);
    const head = join(root, 'people/alice-example.md');
    const before = layout(head);
    const outcome = await fixBacklinkGaps(root, [{ sourcePage: 'notes/other.md', targetPage: 'people/alice-example.md', entityName: 'Alice Example', sourceTitle: 'Other' }], false, { lockRoot: root });
    expect(outcome).toEqual({ fixed: 0, skipped: [{ page: 'people/alice-example.md', reason: expect.stringMatching(/^split_page_unsupported \(outside_door\)/) }] });
    expect(layout(head)).toEqual(before);
  }), 120_000);

  test('takes revisit refuses a split head with split_page_unsupported and opens no editor', () => withHome(async (home, root) => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', sync: { repo_path: root } }));
    await writeSplitPage(root, `${SLUG}.md`, file);
    const head = join(root, `${SLUG}.md`);
    const before = layout(head);
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true; }) as never);
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    try {
      await withEnv({ EDITOR: 'true', VISUAL: undefined }, async () => {
        await expect(runTakes(null as unknown as BrainEngine, ['revisit', SLUG])).rejects.toThrow('exit 1');
      });
    } finally { write.mockRestore(); exit.mockRestore(); }
    expect(stderr.join('')).toContain('split_page_unsupported (outside_door)');
    expect(stderr.join('')).not.toContain('Opening');
    expect(layout(head)).toEqual(before);
  }), 120_000);

  test('frontmatter validate --fix refuses a frontmatter fix on a split head (split_page_unsupported, outside_door): the head and every part stay byte for byte', () => withHome(async (_home, root) => {
    await writeSplitPage(root, `${SLUG}.md`, `---\ntype: note\ntitle: "a "quoted" title"\n---\n\n${body}\n`);
    const head = join(root, `${SLUG}.md`);
    const before = layout(head);
    const run = await validateFix(head);
    expect(run.verdict).toBe(1);
    expect(run.out).toContain('split_page_unsupported (outside_door)');
    expect(layout(head)).toEqual(before);
    expect(pageFile(head)).toEqual({ split: true, text: `---\ntype: note\ntitle: "a "quoted" title"\n---\n\n${body}\n` });
  }), 120_000);

  test('frontmatter validate --fix refuses a fix that would change a split head\'s body (split_page_unsupported, outside_door) and writes nothing', () => withHome(async (_home, root) => {
    await writeSplitPage(root, `${SLUG}.md`, `---\ntype: note\ntitle: "a "quoted" title"\n---\n\nLead\u0000 line.\n${body}\n`);
    const head = join(root, `${SLUG}.md`);
    const before = layout(head);
    expect(before.head).toContain('\u0000');
    for (const args of [['--fix'], ['--fix', '--json']]) {
      const run = await validateFix(head, args);
      expect(run.verdict).toBe(1);
      expect(run.out).toContain('split_page_unsupported (outside_door)');
      expect(layout(head)).toEqual(before);
    }
    expect(readPageFile(head).hold).toBeUndefined();
  }), 120_000);
});
