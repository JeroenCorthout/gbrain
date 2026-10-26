/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): facts maintenance on a split page.
 *
 * 1. Protects: every facts and takes maintenance step that reads a page's canonical file outside the publication door
 *    reads the page file F' a split head and its parts reassemble to, never the head alone. The facts reconcile finds
 *    an inline or segmented split page fresh, derives the rows that live in its parts and detaches a stray row; a
 *    split head whose parts do not verify holds the destructive reconcile with its hold code. An unmanaged writer
 *    (writeFactsToFence, forget's fence mirror, the unfenced-row fence step) never plans on or rewrites a head: it
 *    takes its database-only fallback with the typed reason split_page (or the hold code), leaving the head and every
 *    part as they are. On a managed brain an append publishes through the door and keeps the split layout. Takes
 *    extraction from the checkout and a purge preview read F' too.
 * 2. Fails when: a reader compares or parses the head (a FACTS_PAGE_CACHE_STALE skip, rows in the parts never derived,
 *    a file_database_drift label for a page that has no drift), a writer rewrites the head or writes the whole page
 *    over it, or a hold is reported as anything but its code.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests. Unmanaged split heads are written with planSplit, as a pull of another host's
 *    publication leaves them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractTakesFromFs } from '../src/core/cycle/extract-takes.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { extractFactsFromFenceText } from '../src/core/facts/extract-from-fence.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { applyProposalAction } from '../src/core/facts/proposal-supersede.ts';
import { auditUnadoptableFacts, fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { insertProposal } from '../src/core/ai/decide/proposals-store.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, planSplit, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
/** A page stored in segments is over 1 MiB: parts of about 64 KB keep the part count bounded. */
const SEGMENTED_LIMITS = { ...LIMITS, partTarget: 65_536, partMax: 131_072 };
const SLUG = 'people/alice-example';
const CLAIM = 'Alice Example keeps the locker code 4471';
const SECOND = 'Alice Example rides to work on a red bicycle';
const STRAY = 'Alice Example once lived in source-a';
const NL = String.fromCharCode(10);
const HEADER = ['| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|'].join(NL);
const row = (n: number, claim: string) => '| ' + n + ' | ' + claim + ' | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |';
const facts = (...claims: string[]) => ['## Facts', '', FACTS_FENCE_BEGIN, HEADER, ...claims.map((c, i) => row(i + 1, c)), FACTS_FENCE_END].join(NL);
const prose = (lines: number) => Array.from({ length: lines }, (_, i) => 'Line ' + String(i).padStart(5, '0') + ' of a page long enough to be stored as a head and parts.').join(NL);
const page = (body: string) => ['---', 'type: person', 'title: Alice Example', '---', '', '# Alice Example', '', body, ''].join(NL);
/** The facts fence after the prose, so its rows live in the parts and never in the head's lead. */
const fenceInParts = (lines: number, ...claims: string[]) => page(prose(lines) + NL + NL + facts(...claims));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fact = (claim: string): FenceInputFact => ({ fact: claim, kind: 'fact', notability: 'medium', source: 'test', visibility: 'world', embedding: null, sessionId: null });

/** The head, every part (by digest) and whether a .tmp sits beside the head: a write over any of them changes this. */
function disk(path: string) {
  const dir = partsDirFor(path);
  return { head: readFileSync(path, 'utf8'), parts: existsSync(dir) ? readdirSync(dir).sort().map(name => [name, sha(readFileSync(join(dir, name)))]) : [], tmp: existsSync(path + '.tmp') };
}

/** Writes content at path as a head plus parts, the layout another host's publication commits. */
async function writeSplit(path: string, content: string) {
  const plan = await planSplit((async function* () { yield Buffer.from(content); })(), { headPath: path });
  try {
    mkdirSync(partsDirFor(path), { recursive: true });
    writeFileSync(path, plan.head());
    for (const part of plan.parts) {
      const pieces: Uint8Array[] = [];
      for await (const piece of plan.range(part.start, part.end)) pieces.push(piece);
      writeFileSync(join(dirname(path), part.path), Buffer.concat(pieces));
    }
  } finally { plan.dispose(); }
  expect(parseHead(readFileSync(path, 'utf8'))).not.toBeNull();
  const file = readPageFile(path);
  expect(file.hold).toBeUndefined();
  if (!file.hold) expect(file.bytes.toString('utf8')).toBe(content);
}

interface SplitBrain { engine: BrainEngine; root: string; file: string }

/**
 * An unmanaged brain whose default source checkout holds SLUG as a split head of content, and whose page row was
 * imported from the same content (what sync imports from the reassembled page file). segmented stores it in segments.
 */
async function withSplitBrain(databaseUrl: string | undefined, content: string, run: (b: SplitBrain) => Promise<void>, opts: { segmented?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'split-facts-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        const file = join(root, SLUG + '.md');
        mkdirSync(dirname(file), { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        if (opts.segmented) await engine.setConfig('pages.segmented_storage', 'on');
        expect(await importFromContent(engine, SLUG, content, { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
        await writeSplit(file, content);
        await run({ engine, root, file });
      } finally { await close(); _resetWriteThroughCacheForTest(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Indexes the fence rows of content (the first count of them) as fence-owned fact rows, as a reconcile would. */
async function indexFence(engine: BrainEngine, content: string, count = Infinity) {
  const rows = extractFactsFromFenceText(parseFactsFence(content).facts.slice(0, count), SLUG, 'default');
  return (await engine.insertFacts(rows, { source_id: 'default' })).ids;
}

/** A fence-owned row whose fence row is not on the page: the reconcile detaches it. */
async function strayRow(engine: BrainEngine) {
  const [stray] = extractFactsFromFenceText(parseFactsFence(facts(STRAY)).facts, SLUG, 'default');
  await engine.insertFacts([{ ...stray!, row_num: 99 }], { source_id: 'default' });
}

/** A fact row with no fence row: what the inline writer's database-only fallback leaves for the fence step. */
function unfenced<T extends { row_num?: unknown; source_markdown_slug?: unknown }>(row: T) {
  const { row_num: _row, source_markdown_slug: _page, ...rest } = row;
  return rest;
}

const activeRows = (engine: BrainEngine) => engine.executeRaw<{ row_num: number | null; fact: string }>(
  "SELECT row_num, fact FROM facts WHERE source_id='default' AND (source_markdown_slug=$1 OR entity_slug=$1) AND expired_at IS NULL ORDER BY row_num NULLS LAST, fact", [SLUG]);
const storedBody = async (engine: BrainEngine) => (await engine.executeRaw<{ compiled_truth: string; content_hash: string }>(
  "SELECT compiled_truth, content_hash FROM pages WHERE source_id='default' AND slug=$1", [SLUG]))[0];
const target = (root: string) => ({ sourceId: 'default', localPath: root, slug: SLUG, resolutionSource: 'exact_page' as const });
const missingPart = (file: string) => { const dir = partsDirFor(file); rmSync(join(dir, readdirSync(dir).sort()[1]!)); };
const op = (name: string) => operations.find(o => o.name === name)!;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), NL); durableGitRepo(root, ['.gitignore']); };

/** A put_page replayed with its request_id until it commits. */
async function put(ctx: OperationContext, content: string) {
  const request_id = randomUUID();
  for (let replay = 0; replay < 20; replay++) {
    const out = await op('put_page').handler(ctx, { slug: SLUG, content, request_id, wait_ms: 30_000 }) as Record<string, any>;
    if (out.state !== 'pending' && out.code !== 'write_pending') { expect(out.state).toBe('committed'); return; }
  }
  throw new Error('put_page did not commit');
}

/** Runs effect passes until the source's mirror and Git effects have settled. */
async function settle(engine: BrainEngine) {
  await waitFor(async () => {
    const [open] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind IN ('withdrawal-mirror','git') AND (state <> 'committed' OR recovery IS NOT NULL)");
    if (!open!.n) return true;
    await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE state='queued'"); });
    await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 }).catch(() => undefined);
    return false;
  }, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror and Git effects settled' });
}

const unexpected = (warnings: string[]) => warnings.filter(w => w.includes('FACTS_PAGE_CACHE_STALE') || w.includes('split_page'));

for (const backend of testBackends()) describe('[' + backend + '] split git layout: facts maintenance', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  test('the facts reconcile reads an inline split page whole: rows in its parts are kept and derived, a stray row detached', async () => {
    __setSplitLimitsForTests(LIMITS);
    const content = fenceInParts(60, CLAIM, SECOND);
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      expect(readFileSync(file, 'utf8')).not.toContain(CLAIM);
      await indexFence(engine, content, 1);
      await strayRow(engine);
      const before = disk(file);
      const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });
      expect(unexpected(result.warnings)).toEqual([]);
      expect(await activeRows(engine)).toEqual([{ row_num: 1, fact: CLAIM }, { row_num: 2, fact: SECOND }]);
      expect(result.factsDeleted).toBe(1);
      expect(disk(file)).toEqual(before);
    });
  }, 180_000);

  test("the facts reconcile reads a segmented split page whole: the stored regions match F', not the head", async () => {
    __setSplitLimitsForTests(SEGMENTED_LIMITS);
    const content = fenceInParts(17_000, CLAIM, SECOND);
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      expect(await engine.executeRaw('SELECT body_storage FROM pages WHERE slug=$1', [SLUG])).toEqual([{ body_storage: 'segmented' }]);
      await indexFence(engine, content, 1);
      await strayRow(engine);
      const before = disk(file);
      const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });
      expect(unexpected(result.warnings)).toEqual([]);
      expect(await activeRows(engine)).toEqual([{ row_num: 1, fact: CLAIM }, { row_num: 2, fact: SECOND }]);
      expect(disk(file)).toEqual(before);
    }, { segmented: true });
  }, 300_000);

  test('a split head with a missing part holds the destructive reconcile with its hold code; nothing is detached or written', async () => {
    __setSplitLimitsForTests(LIMITS);
    const content = fenceInParts(60, CLAIM);
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      await indexFence(engine, content);
      await strayRow(engine);
      missingPart(file);
      const before = disk(file);
      const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });
      expect(result.warnings.some(w => w.includes(SLUG + ': FACTS_PAGE_FILE_HELD: split_page_incomplete'))).toBe(true);
      expect(result.warnings.filter(w => w.includes('FACTS_PAGE_CACHE_STALE'))).toEqual([]);
      expect(await activeRows(engine)).toEqual([{ row_num: 1, fact: CLAIM }, { row_num: 99, fact: STRAY }]);
      expect(disk(file)).toEqual(before);
    });
  }, 180_000);

  test('writeFactsToFence on an unmanaged split page falls back database-only with reason split_page; the head and parts stay', async () => {
    __setSplitLimitsForTests(LIMITS);
    await withSplitBrain(databaseUrl, fenceInParts(60, CLAIM), async ({ engine, root, file }) => {
      const before = { disk: disk(file), body: await storedBody(engine) };
      const result = await writeFactsToFence(engine, target(root), [fact(SECOND)]);
      expect(result).toMatchObject({ inserted: 0, legacyFallback: true, databaseOnlyReason: 'split_page' });
      expect(result.warning).toContain(SLUG + ' (split_page:');
      expect({ disk: disk(file), body: await storedBody(engine) }).toEqual(before);
      expect(await engine.executeRaw('SELECT id FROM facts')).toEqual([]);
    });
  }, 180_000);

  test('writeFactsToFence on an unmanaged split head with a missing part names the hold and writes nothing', async () => {
    __setSplitLimitsForTests(LIMITS);
    await withSplitBrain(databaseUrl, fenceInParts(60, CLAIM), async ({ engine, root, file }) => {
      missingPart(file);
      const before = { disk: disk(file), body: await storedBody(engine) };
      const result = await writeFactsToFence(engine, target(root), [fact(SECOND)]);
      expect(result).toMatchObject({ inserted: 0, legacyFallback: true, databaseOnlyReason: 'split_page' });
      expect(result.warning).toContain(SLUG + ' (split_page_incomplete:');
      expect({ disk: disk(file), body: await storedBody(engine) }).toEqual(before);
    });
  }, 180_000);

  test('forget on an unmanaged split page expires the row database-only with reason split_page; the head and parts stay', async () => {
    __setSplitLimitsForTests(LIMITS);
    const content = fenceInParts(60, CLAIM);
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      const [id] = await indexFence(engine, content);
      const before = disk(file);
      const result = await forgetFactInFence(engine, id!);
      expect(result).toMatchObject({ ok: true, path: 'legacy_db' });
      expect(result.warning).toContain(SLUG + ' (split_page:');
      expect(disk(file)).toEqual(before);
      expect(await activeRows(engine)).toEqual([]);
    });
  }, 180_000);

  test("forget on an unmanaged segmented split page whose fence is in the head's lead never rewrites the head", async () => {
    __setSplitLimitsForTests({ ...SEGMENTED_LIMITS, leadMax: 4096 });
    const content = page(facts(CLAIM) + NL + NL + prose(17_000));
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      expect(readFileSync(file, 'utf8')).toContain(CLAIM);
      const [id] = await indexFence(engine, content);
      const before = disk(file);
      const result = await forgetFactInFence(engine, id!);
      expect(result).toMatchObject({ ok: true, path: 'legacy_db' });
      expect(result.warning).toContain(SLUG + ' (split_page:');
      expect(disk(file)).toEqual(before);
      expect(readPageFile(file).hold).toBeUndefined();
      expect(await activeRows(engine)).toEqual([]);
    }, { segmented: true });
  }, 300_000);

  test('the unfenced-row fence step passes an unmanaged split page by with reason split_page', async () => {
    __setSplitLimitsForTests(LIMITS);
    const content = fenceInParts(60, CLAIM);
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      await indexFence(engine, content);
      const [loose] = extractFactsFromFenceText(parseFactsFence(facts(SECOND)).facts, SLUG, 'default');
      await engine.insertFact(unfenced(loose!), { source_id: 'default' });
      const before = disk(file);
      const outcome = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default' }));
      expect(outcome.failed_pages.filter(p => p.startsWith(SLUG + ' (split_page:'))).toHaveLength(1);
      expect(outcome.fenced).toBe(0);
      expect(disk(file)).toEqual(before);
    });
  }, 180_000);

  test("the unadoptable-row audit plans on the split page's whole fence: a loose row repeating a fence row in a part is a duplicate", async () => {
    __setSplitLimitsForTests(LIMITS);
    const content = fenceInParts(60, CLAIM);
    await withSplitBrain(databaseUrl, content, async ({ engine }) => {
      await indexFence(engine, content);
      const [loose] = extractFactsFromFenceText(parseFactsFence(facts(CLAIM)).facts, SLUG, 'default');
      await engine.insertFact(unfenced(loose!), { source_id: 'default' });
      const audit = await auditUnadoptableFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default' }));
      expect(audit.records.map(r => ({ slug: r.slug, reason: r.reason }))).toEqual([{ slug: SLUG, reason: 'duplicate_claim' }]);
    });
  }, 180_000);

  test('a proposal accept on an unmanaged split page is refused with reason split_page; facts, head and parts stay', async () => {
    __setSplitLimitsForTests(LIMITS);
    const content = fenceInParts(60, CLAIM, SECOND);
    await withSplitBrain(databaseUrl, content, async ({ engine, file }) => {
      const [old, replacement] = await indexFence(engine, content);
      const id = (await insertProposal(engine, { source_id: 'default', sweep_id: 'sweep-default', pair_index: 0, new_fact_id: replacement, old_fact_id: old,
        direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: null } as never))!;
      const before = disk(file);
      const result = await applyProposalAction(engine, id, 'accept');
      expect(result).toMatchObject({ action: 'accept', status: 'refused' });
      expect((result as { reason?: string }).reason).toContain(SLUG + ' (split_page:');
      expect(disk(file)).toEqual(before);
      expect(await activeRows(engine)).toEqual([{ row_num: 1, fact: CLAIM }, { row_num: 2, fact: SECOND }]);
    });
  }, 180_000);

  test('takes extraction from the checkout reads a split page whole: a takes fence in its parts is projected', async () => {
    __setSplitLimitsForTests(LIMITS);
    const takes = [TAKES_FENCE_BEGIN, '| # | claim | kind | who | weight | since | source |', '|---|-------|------|-----|--------|-------|--------|', '| 1 | acme-example will ship in May | take | brain | 0.5 | 2026-07 | notes |', TAKES_FENCE_END].join(NL);
    await withSplitBrain(databaseUrl, page(prose(60) + NL + NL + '## Takes' + NL + NL + takes), async ({ engine, root, file }) => {
      await engine.executeRaw('DELETE FROM takes');
      const before = disk(file);
      const result = await extractTakesFromFs(engine, { repoPath: root, sourceId: 'default' });
      expect(result.warnings).toEqual([]);
      expect(result.takesUpserted).toBe(1);
      expect(await engine.executeRaw('SELECT row_num, claim FROM takes')).toEqual([{ row_num: 1, claim: 'acme-example will ship in May' }]);
      expect(disk(file)).toEqual(before);
    });
  }, 180_000);

  test('a managed append to a split page publishes through the door and keeps the split layout', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    await put(ctx, page(prose(120)));
    const file = join(root, SLUG + '.md');
    expect(parseHead(readFileSync(file, 'utf8'))).not.toBeNull();
    const result = await writeFactsToFence(engine, target(root), [fact(CLAIM)]);
    expect(result).toMatchObject({ inserted: 1 });
    await settle(engine);
    expect(parseHead(readFileSync(file, 'utf8'))).not.toBeNull();
    expect(readFileSync(file, 'utf8')).not.toContain(CLAIM);
    const whole = readPageFile(file);
    expect(whole.hold).toBeUndefined();
    if (!whole.hold) expect(parseFactsFence(whole.bytes.toString('utf8')).facts.map(f => f.claim)).toEqual([CLAIM]);
    expect(await activeRows(engine)).toEqual([{ row_num: 1, fact: CLAIM }]);
  }, { databaseUrl, setup }), 240_000);

  test("a purge preview of a claim in a split page's part reports the canonical file and its Git history as carrying it", () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    await put(ctx, page(prose(120)));
    await op('remember').handler(ctx, { fact: CLAIM, entity: SLUG, provenance: 'test', visibility: 'world' });
    await settle(engine);
    const file = join(root, SLUG + '.md');
    expect(readFileSync(file, 'utf8')).not.toContain(CLAIM);
    const [found] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [CLAIM]);
    const dry = await op('purge_fact').handler(ctx, { id: Number(found!.id), dry_run: true }) as Record<string, Array<{ store: string; status: string; remaining?: number }> | undefined>;
    expect(dry.stores?.find(s => s.store === 'canonical_markdown')).toMatchObject({ status: 'would_remove' });
    expect(dry.residuals?.find(s => s.store === 'git_history')?.remaining).toBeGreaterThanOrEqual(1);
  }, { databaseUrl, setup }), 240_000);
});
