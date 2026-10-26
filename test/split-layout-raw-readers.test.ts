/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the readers outside the publication door that derive
 * database rows from a canonical file.
 * 1. Protects: a split page head (head file + parts in .<name>.gbparts/) is read as the page file F' its parts reassemble
 *    to (readPageFile), never as the head: gbrain extract (incremental, full walk and the per-slug sync hooks) keeps the
 *    links and timeline rows whose text lives in the parts; the v0.32.2 verify reads a facts fence in the parts; capture
 *    --source markdown-greenfield emits F'; gbrain publish renders F'; repair rename-identity sees the new file's facts
 *    fence in the parts; repair url-clone-fences, a route outside the publication door, passes a split head by instead
 *    of importing the head as the page (split_page_unsupported: split-write-through.ts outsideDoorRefusal finds the
 *    split unit before it checks the HEAD bytes it would restore). A head whose parts do not verify
 *    is skipped with its hold code and leaves the page stale.
 * 2. Fails when: a reader parses the raw head (lead + notice), so rows whose text is past the lead are dropped, retracted
 *    or reported missing, or the head is emitted or rendered as the page.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests; unmanaged brains (the managed readers are in split-layout-managed-readers.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractLinksForSlugs, extractTimelineForSlugs, runExtractCore } from '../src/commands/extract.ts';
import { importFile } from '../src/core/import-file.ts';
import { renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../src/core/facts-fence.ts';
import { performSync } from '../src/commands/sync.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { __testing as v0_32_2 } from '../src/commands/migrations/v0_32_2.ts';
import { MarkdownGreenfieldSource } from '../src/core/ingestion/sources/markdown-greenfield.ts';
import type { IngestionEvent, IngestionSourceContext } from '../src/core/ingestion/types.ts';
import { runPublish } from '../src/commands/publish.ts';
import { __setSplitLimitsForTests, partsDirFor } from '../src/core/split-layout/index.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const BIG = 'notes/big-example';
const ALICE = 'people/alice-example';
const filler = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`).join('\n');
const page = (body: string) => `---\ntype: note\ntitle: Big example\n---\n\n# Big example\n\n${filler('Opening', 30)}\n\n${body}\n`;
const bigFile = page(`Met [Alice Example](../people/alice-example.md) at the acme-example offsite.\n\n${filler('Closing', 30)}\n\n## Timeline\n\n- **2024-01-15** | meeting — Planning session with Alice Example`);
const aliceFile = '---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\nAlice Example works at acme-example.\n';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const fact = (rowNum: number, claim: string): ParsedFact => ({ rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true });

/** Every part file of the split page at `rel`, in order. */
const partFiles = (root: string, rel: string) => readdirSync(partsDirFor(join(root, rel))).sort().map(name => join(partsDirFor(join(root, rel)), name));
/** Makes the split page at `rel` unreadable as its page file: its last part no longer matches the manifest. */
const breakLastPart = (root: string, rel: string) => { const last = partFiles(root, rel).at(-1)!; writeFileSync(last, readFileSync(last, 'utf8') + 'tampered\n'); };

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine, root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'split-raw-readers-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      __setSplitLimitsForTests(LIMITS);
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        mkdirSync(join(root, 'notes'), { recursive: true });
        mkdirSync(join(root, 'people'), { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await run(engine, root);
      } finally { await close(); _resetWriteThroughCacheForTest(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Alice as one file and BIG as a split page, both imported (the import reassembles BIG into its page row), with no derived rows yet. */
async function seedSplitPages(engine: BrainEngine, root: string, file = bigFile) {
  writeFileSync(join(root, `${ALICE}.md`), aliceFile);
  const written = await writeSplitPage(root, `${BIG}.md`, file);
  expect(written.parts.length).toBeGreaterThan(1);
  for (const slug of [ALICE, BIG]) expect((await importFile(engine, join(root, `${slug}.md`), `${slug}.md`, { noEmbed: true })).status).toBe('imported');
  for (const table of ['links', 'timeline_entries']) {
    await engine.executeRaw(`DELETE FROM ${table} WHERE ${table === 'links' ? 'from_page_id' : 'page_id'} = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`, [BIG]);
  }
}

const linkTargets = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ slug: string }>(
  "SELECT t.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.slug = $1 AND f.source_id = 'default' ORDER BY t.slug", [slug])).map(r => r.slug);
const timelineSummaries = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ summary: string }>(
  "SELECT te.summary FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = $1 AND p.source_id = 'default' ORDER BY te.summary", [slug])).map(r => r.summary);

for (const backend of testBackends()) describe(`[${backend}] split git layout: raw readers that feed the database`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });

  test('incremental extract (--slugs) reads the page file: links and timeline rows in the parts are kept', () => withBrain(databaseUrl, async (engine, root) => {
    await seedSplitPages(engine, root);
    await runExtractCore(engine, { mode: 'all', dir: root, slugs: [BIG], quiet: true });
    expect(await linkTargets(engine, BIG)).toEqual([ALICE]);
    expect(await timelineSummaries(engine, BIG)).toEqual(['Planning session with Alice Example']);
  }), 120_000);

  test('full-walk extract reads the page file: links and timeline rows in the parts are kept', () => withBrain(databaseUrl, async (engine, root) => {
    await seedSplitPages(engine, root);
    await runExtractCore(engine, { mode: 'all', dir: root, quiet: true });
    expect(await linkTargets(engine, BIG)).toEqual([ALICE]);
    expect(await timelineSummaries(engine, BIG)).toEqual(['Planning session with Alice Example']);
  }), 120_000);

  test('the per-slug sync hooks read the page file; a head whose parts do not verify is not processed and stays stale', () => withBrain(databaseUrl, async (engine, root) => {
    await seedSplitPages(engine, root);
    const links = await extractLinksForSlugs(engine, root, [BIG]);
    const timeline = await extractTimelineForSlugs(engine, root, [BIG]);
    expect([links.processed, timeline.processed]).toEqual([[BIG], [BIG]]);
    expect(await linkTargets(engine, BIG)).toEqual([ALICE]);
    expect(await timelineSummaries(engine, BIG)).toEqual(['Planning session with Alice Example']);
    breakLastPart(root, `${BIG}.md`);
    const heldLinks = await extractLinksForSlugs(engine, root, [BIG]);
    const heldTimeline = await extractTimelineForSlugs(engine, root, [BIG]);
    expect([heldLinks.processed, heldTimeline.processed]).toEqual([[], []]);
    expect(heldLinks.errors).toEqual([{ slug: BIG, error: expect.stringContaining('split page head') }]);
    expect(heldTimeline.errors).toEqual([{ slug: BIG, error: expect.stringContaining('split page head') }]);
    expect(await linkTargets(engine, BIG)).toEqual([ALICE]);
    expect(await timelineSummaries(engine, BIG)).toEqual(['Planning session with Alice Example']);
  }), 120_000);

  test('the v0.32.2 verify reads a facts fence in the parts; a held head is reported split_page_unsupported, not as drift', () => withBrain(databaseUrl, async (engine, root) => {
    await seedSplitPages(engine, root, page(`${filler('Closing', 10)}\n\n## Facts\n\n${renderFactsTable([fact(1, 'acme-example ships payments'), fact(2, 'acme-example opens an office')])}`));
    await engine.executeRaw('DELETE FROM facts');
    await engine.insertFacts([1, 2].map(row => ({ fact: `claim ${row}`, kind: 'fact' as const, visibility: 'world' as const, notability: 'medium' as const, source: 'fence:reconcile',
      entity_slug: BIG, row_num: row, source_markdown_slug: BIG })), { source_id: 'default' });
    const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
    expect(await v0_32_2.phaseCVerify(engine, OPTS)).toEqual({ name: 'verify', status: 'complete', detail: 'pages_checked=1' });
    breakLastPart(root, `${BIG}.md`);
    const held = await v0_32_2.phaseCVerify(engine, OPTS);
    expect(held).toMatchObject({ name: 'verify', status: 'complete' });
    expect(held.detail).toContain(`split_page_unsupported=1 (${BIG}: split_page_incomplete)`);
  }), 120_000);

  test('repair url-clone-fences passes a split head by (split_page_unsupported): the head is never imported as the page', () => withBrain(databaseUrl, async (engine, root) => {
    const upstream = join(root, '..', 'upstream'), clone = join(root, '..', 'clones', 'source-a');
    mkdirSync(join(upstream, 'notes'), { recursive: true });
    git(upstream, 'init', '-q', '-b', 'main');
    await writeSplitPage(upstream, `${BIG}.md`, bigFile);
    commit(upstream, 'a split page');
    execFileSync('git', ['clone', '-q', `file://${upstream}`, clone], { stdio: 'pipe' });
    await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
      ['source-a', clone, JSON.stringify({ remote_url: `file://${upstream}`, managed_clone: true })]);
    await performSync(engine, { sourceId: 'source-a', repoPath: clone, noPull: true, noEmbed: true, noExtract: true });
    const body = async () => (await engine.executeRaw<{ compiled_truth: string; frontmatter: unknown }>(
      "SELECT compiled_truth, frontmatter FROM pages WHERE source_id = 'source-a' AND slug = $1", [BIG]))[0]!;
    expect((await body()).compiled_truth).toContain('Closing line 0029');
    const head = join(clone, `${BIG}.md`);
    const withRows = replaceOrInsertFactsFence(readFileSync(head, 'utf8'), renderFactsTable([fact(1, 'acme-example ships payments')]));
    writeFileSync(head, withRows);
    const scope = await resolveRepairScope(engine, 'source-a');
    const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } as never }))
      .run('url-clone-fences' as RepairKind, scope, { explicit: true, sourceFlag: 'source-a' });
    expect(preview.listing!.map(entry => [entry.item, entry.class])).toEqual([[`source-a:${BIG}.md`, 'split_page_unsupported']]);
    expect(preview.preview_hash).toBeUndefined();
    expect(readFileSync(head, 'utf8')).toBe(withRows);
    const stored = await body();
    expect(stored.compiled_truth).toContain('Closing line 0029');
    expect(JSON.stringify(stored.frontmatter)).not.toContain('gbrain_parts');
  }), 120_000);

  test('repair rename-identity reads the new file as its page file: a facts fence in the parts is not a collision', () => withBrain(databaseUrl, async (engine, root) => {
    const id = 'source-a', src = join(root, '..', id);
    const doc = (tail: string) => `---\ntype: note\n---\n\n${filler('Shared meeting', 30)}\n${tail}\n## Facts\n\n${renderFactsTable([fact(1, 'acme-example ships payments')])}\n`;
    mkdirSync(join(src, 'notes'), { recursive: true });
    git(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, 'notes/plan.md'), doc(''));
    writeFileSync(join(src, 'notes/peer.md'), '---\ntype: note\ntitle: Peer\n---\n\nA different page.\n');
    commit(src, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, src]);
    const sync = () => performSync(engine, { repoPath: src, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    await sync();
    const fenceFact = (slug: string) => engine.insertFacts([{ fact: 'acme-example ships payments', kind: 'fact', visibility: 'world', notability: 'medium', source: 'fence:reconcile',
      entity_slug: slug, row_num: 1, source_markdown_slug: slug }], { source_id: id });
    await fenceFact('notes/plan');
    git(src, 'mv', 'notes/plan.md', 'notes/roadmap.md');
    writeFileSync(join(src, 'notes/roadmap.md'), doc('An added paragraph.\n'));
    commit(src, 'move and edit');
    expect((await sync()).identityDowngrades?.map(entry => [entry.from, entry.to])).toEqual([['notes/plan.md', 'notes/roadmap.md']]);
    await fenceFact('notes/roadmap');
    await writeSplitPage(src, 'notes/roadmap.md', doc('An added paragraph.\n'));
    const { runRepairCommand } = await import('../src/commands/repair.ts');
    let printed = '';
    const original = console.log;
    console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' ') + '\n'; };
    try { await runRepairCommand(engine, ['rename-identity', '--source', id, '--slug', 'notes/roadmap', '--json']); } finally { console.log = original; }
    expect(JSON.parse(printed).results[0]).toMatchObject({ kind: 'rename-identity', mode: 'dry_run', affected: 1, details: { disposition: 'carry' } });
  }), 120_000);
});

describe('split git layout: file readers with no database', () => {
  afterEach(() => { __setSplitLimitsForTests(null); });
  const withHome = async (run: (root: string, home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), 'split-raw-readers-files-'));
    try { await withEnv({ GBRAIN_HOME: home }, async () => { __setSplitLimitsForTests(LIMITS); mkdirSync(join(home, 'brain'), { recursive: true }); await run(join(home, 'brain'), home); }); }
    finally { rmSync(home, { recursive: true, force: true }); }
  };
  const capture = async (repoPath: string, auditDir: string) => {
    const emitted: IngestionEvent[] = [];
    const ctx = { emit: (event: IngestionEvent) => { emitted.push(event); }, engine: {} as never, logger: { info() {}, warn() {}, error() {} },
      abortSignal: new AbortController().signal, config: {} } as unknown as IngestionSourceContext;
    const source = new MarkdownGreenfieldSource({ repoPath, auditDir });
    await source.start(ctx);
    return { emitted, stats: source.stats };
  };

  test('capture --source markdown-greenfield emits the page file of a split head, never the head; a held head is skipped', () => withHome(async (root, home) => {
    await writeSplitPage(root, 'concepts/big-example.md', bigFile);
    const { emitted } = await capture(root, join(home, 'audit'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.content).toContain('Planning session with Alice Example');
    expect(emitted[0]!.content).not.toContain('gbrain_parts');
    breakLastPart(root, 'concepts/big-example.md');
    const held = await capture(root, join(home, 'audit'));
    expect(held.emitted).toEqual([]);
    expect(held.stats.skipped_invalid).toBe(1);
  }));

  test('gbrain publish renders the page file of a split head', () => withHome(async (root, home) => {
    await writeSplitPage(root, 'notes/big-example.md', bigFile);
    const out = join(home, 'out', 'big.html');
    await runPublish([join(root, 'notes/big-example.md'), '--out', out]);
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('Closing line 0029');
    expect(html).not.toContain('gbrain_parts');
  }));
});
