/**
 * Split git layout (Wave B PR 5 lane 5e, C1): the file-repair lanes over a split page head.
 *
 * Protects: a managed file repair binds and edits the page file F' a split head and its parts reassemble to, never the
 * head: the door lays the repaired page out as head plus parts again (both tracked at HEAD), the stored body keeps the
 * whole page and the stored frontmatter never gains `gbrain_parts`; a repair bound to the raw head's hash, or one whose
 * head no longer reassembles (a missing part, an edited head body), publishes nothing. The frontmatter, fence and
 * slug-conflict repairs preview and apply on F' and pass a held head by with its typed reason; a non-managed brain
 * passes a split head by (`split_page_unsupported`) instead of writing the page over it; the fence census finds a
 * malformed fence that lives in a part; file-drift passes a drifted split head by instead of reconciling its head.
 * Regression it catches: any lane that reads the head raw and republishes it as the whole page, which converts the page
 * back to one file holding only the head, deletes every part and truncates the stored body.
 * Engines: PGLite always; Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 * Seam: __setSplitLimitsForTests (KB-sized parts and lead).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import { readSyncImportProvenances } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { listFenceCandidates, runFenceCensus } from '../src/core/fence-repair/census.ts';
import { __setSplitLimitsForTests, pageFileSha256, parseHead, partsDirFor, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const op = (name: string) => operations.find(o => o.name === name)!;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const page = (frontmatter: string, body = lines(120).join('\n') + '\n') => `---\n${frontmatter}---\n\n${body}`;
const QUOTABLE = 'author: alice-example (citing acme-example) (original: https://example.invalid/a)\n';
const QUOTED = 'author: "alice-example (citing acme-example) (original: https://example.invalid/a)"\n';
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
/** Tier 1: a missing end marker and an invented kind, at the end of the page (in its last part). */
const fixableFence = `${FB}\n${FH}\n| 1 | Synthetic vendor partnership | partnership | 0.9 | private | high | 2026-01-01 |  | chat |  |\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const env = { OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_FENCE_REPAIR_SCAN_MS: '60000' };

const partsOf = (root: string, rel: string) => {
  const dir = partsDirFor(join(root, rel));
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
/** The page file the head at `rel` and its parts reassemble to (throws when it is not a split page whose parts verify). */
const pageFile = (root: string, rel: string): string => {
  const read = readPageFile(join(root, rel));
  if (!read.split || read.hold) throw new Error(`${rel} is not a readable split page: ${read.hold?.code ?? 'one file'}`);
  return read.bytes.toString('utf8');
};
/** Every file of the split page at `rel` with its bytes, to prove nothing was written. */
const snapshotFiles = (root: string, rel: string) => {
  const dir = partsDirFor(join(root, rel));
  return { head: readFileSync(join(root, rel)), parts: partsOf(root, rel).map(name => [name, readFileSync(join(dir, name))] as const) };
};
const tracked = (root: string, rel: string) => git(root, 'ls-files', rel, partsDirFor(rel)).split('\n').filter(Boolean).sort();
const layout = (root: string, rel: string) => [rel, ...partsOf(root, rel).map(name => `${partsDirFor(rel)}/${name}`)].sort();
const commitAll = (root: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture'); };
const stored = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string; title: string; frontmatter: Record<string, unknown> }>(
  "SELECT compiled_truth, title, frontmatter FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0];
const put = (ctx: OperationContext, slug: string, content: string) =>
  op('put_page').handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, unknown>>;
const quiet = { info() {}, warn() {}, error() {} };
const run = async (engine: BrainEngine, kind: 'frontmatter' | 'fences' | 'slug-conflicts' | 'file-drift', opts: Record<string, unknown> = {}) => {
  const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
  return runner.run(kind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', noLlm: true, ...opts });
};
const hashOf = (result: RepairResult) => result.apply_command.split('--expect ')[1]!.split(' ')[0]!;
const listed = (result: RepairResult) => Object.fromEntries((result.listing ?? []).map(entry => [entry.item.replace(/^default:/, ''), entry.class]));
async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

/** Sets the 4 KiB split threshold and lays a 120-line page (about 7.4 KiB) out through put_page as a split page. */
async function splitBrain(engine: BrainEngine, ctx: OperationContext, root: string) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
  expect(await put(ctx, 'notes/big', page('type: note\ntitle: Split example\n'))).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
  expect(partsOf(root, 'notes/big.md').length).toBeGreaterThan(1);
  return { head: readFileSync(join(root, 'notes/big.md'), 'utf8'), file: pageFile(root, 'notes/big.md'), before: await stored(engine, 'notes/big') };
}

/** A split page written straight into the checkout (no page row yet) and committed. */
async function committedSplitPage(engine: BrainEngine, root: string, rel: string, content: string) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
  await writeSplitPage(root, rel, content);
  commitAll(root);
  expect(pageFile(root, rel)).toBe(content);
  expect(partsOf(root, rel).length).toBeGreaterThan(1);
}

/** The two ways a head stops reassembling: one part file gone, or the head's body edited. */
const breakings = [
  { code: 'split_page_incomplete', apply: (root: string, rel: string) => rmSync(join(partsDirFor(join(root, rel)), partsOf(root, rel)[1]!)) },
  { code: 'split_head_modified', apply: (root: string, rel: string) => writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8').replace('Line 0000', 'Line 000x')) },
] as const;

for (const backend of testBackends()) describe(`[${backend}] split git layout: file-repair lanes`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });
  const brain = (fn: Parameters<typeof managedBrain>[0]) => withEnv(env, () => managedBrain(fn, { databaseUrl, setup }));

  test('a managed file repair edits F\', keeps the split layout and the whole stored body; a raw-head binding publishes nothing', () => brain(async ({ engine, ctx, root }) => {
    const { head, file, before } = await splitBrain(engine, ctx, root);
    const snapshot = await engine.readPageSnapshot('notes/big', { sourceId: 'default', includeDeleted: true });
    const cfg = await repairScreenConfig(engine, 'default');
    const submit = async (content: string, beforeHash: string) => {
      const pub = await prepareRepairPublication(engine, { sourceId: 'default', slug: 'notes/big', sourcePath: 'notes/big.md', path: 'notes/big.md', root, content, snapshot, base: snapshot, ...cfg });
      if (pub.status !== 'ready') throw new Error(`publication is ${pub.status}`);
      return submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug: 'notes/big', path: 'notes/big.md', sourcePath: 'notes/big.md', content,
        beforeHash, resultDigest: pub.digest, expected_revision: snapshot!.revision, noEmbed: true });
    };
    const untouched = snapshotFiles(root, 'notes/big.md');
    const rawHead = await refusal(() => submit(head.replace('title: Split example', 'title: Split example repaired'), sha256(head)));
    expect(rawHead.code).toBe('changed_since_preview');
    expect(snapshotFiles(root, 'notes/big.md')).toEqual(untouched);
    expect(await stored(engine, 'notes/big')).toEqual(before);

    expect(pageFileSha256(join(root, 'notes/big.md'))).toMatchObject({ split: true, sha256: sha256(file), headSha256: sha256(head) });
    const repaired = file.replace('title: Split example', 'title: Split example repaired');
    expect(await submit(repaired, sha256(file))).toMatchObject({ file_repaired: true });
    await settleManagedGitEffects(engine);
    const newHead = readFileSync(join(root, 'notes/big.md'));
    expect(parseHead(newHead.toString('utf8'))).toMatchObject({ manifest: expect.any(Object) });
    expect(pageFile(root, 'notes/big.md')).toBe(repaired);
    expect(tracked(root, 'notes/big.md')).toEqual(layout(root, 'notes/big.md'));
    expect(git(root, 'status', '--porcelain')).toBe('');
    const after = await stored(engine, 'notes/big');
    expect(after?.title).toBe('Split example repaired');
    expect(after?.compiled_truth).toBe(before!.compiled_truth);
    expect(after?.frontmatter).not.toHaveProperty('gbrain_parts');
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const pageId = Number((await engine.readPageSnapshot('notes/big', { sourceId: 'default' }))!.page.id);
    const record = (await readSyncImportProvenances(engine, 'default', source!.incarnation, [pageId])).get(pageId);
    expect(record).toMatchObject({ raw_sha256: sha256(repaired), disk_sha256: sha256(newHead) });
  }), 180_000);

  test('a managed file repair refuses a part edited after its preparation compared the page file; the edit and the stored page stay', () => brain(async ({ engine, ctx, root }) => {
    const { file, before } = await splitBrain(engine, ctx, root);
    const snapshot = await engine.readPageSnapshot('notes/big', { sourceId: 'default', includeDeleted: true });
    const repaired = file.replace('title: Split example', 'title: Split example repaired');
    const pub = await prepareRepairPublication(engine, { sourceId: 'default', slug: 'notes/big', sourcePath: 'notes/big.md', path: 'notes/big.md', root, content: repaired, snapshot, base: snapshot, ...await repairScreenConfig(engine, 'default') });
    if (pub.status !== 'ready') throw new Error(`publication is ${pub.status}`);
    const part = join(partsDirFor(join(root, 'notes/big.md')), partsOf(root, 'notes/big.md')[0]!);
    const getConfig = engine.getConfig;
    let edited = false;
    // The door reads the split threshold when it plans the unit, after preparation compared the page file.
    engine.getConfig = function (this: BrainEngine, key: string) {
      if (key !== SPLIT_MAX_FILE_BYTES_KEY || edited) return getConfig.call(this, key);
      return getConfig.call(this, key).then(value => { edited = true; writeFileSync(part, 'An uncommitted edit by alice-example\n'); return value; });
    };
    let outcome: unknown;
    try {
      outcome = await submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug: 'notes/big', path: 'notes/big.md', sourcePath: 'notes/big.md', content: repaired,
        beforeHash: sha256(file), resultDigest: pub.digest, expected_revision: snapshot!.revision, noEmbed: true });
    } catch (error) { outcome = error; } finally { engine.getConfig = getConfig; }
    expect(edited).toBe(true);
    expect(outcome).not.toMatchObject({ file_repaired: true });
    expect(readFileSync(part, 'utf8')).toBe('An uncommitted edit by alice-example\n');
    expect(await stored(engine, 'notes/big')).toEqual(before);
  }), 180_000);

  test('an import-only file repair (the file already holds the repaired page) refuses a part edited after its preparation compared the page file; the edit and the stored page stay', () => brain(async ({ engine, ctx, root }) => {
    await splitBrain(engine, ctx, root);
    const head = join(root, 'notes/big.md');
    writeFileSync(head, readFileSync(head, 'utf8').replace('title: Split example', 'title: Split example repaired by hand'));
    const file = pageFile(root, 'notes/big.md');
    const snapshot = await engine.readPageSnapshot('notes/big', { sourceId: 'default', includeDeleted: true });
    const before = await stored(engine, 'notes/big');
    const pub = await prepareRepairPublication(engine, { sourceId: 'default', slug: 'notes/big', sourcePath: 'notes/big.md', path: 'notes/big.md', root, content: file, snapshot, base: snapshot, ...await repairScreenConfig(engine, 'default') });
    if (pub.status !== 'ready') throw new Error(`publication is ${pub.status}`);
    const part = join(partsDirFor(head), partsOf(root, 'notes/big.md')[0]!);
    const read = engine.readPageSnapshot;
    let edited = false;
    // The preparation reads the page snapshot after it compared the page file and read the parts directory.
    engine.readPageSnapshot = function (this: BrainEngine, ...args: Parameters<BrainEngine['readPageSnapshot']>) {
      const fromPreparation = new Error().stack?.includes('prepareManagedFileRepairMutation');
      return read.apply(this, args).then(value => { if (fromPreparation && !edited) { edited = true; writeFileSync(part, 'An uncommitted edit by alice-example\n'); } return value; });
    };
    let outcome: unknown;
    try {
      outcome = await submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug: 'notes/big', path: 'notes/big.md', sourcePath: 'notes/big.md', content: file,
        beforeHash: sha256(file), resultDigest: pub.digest, expected_revision: snapshot!.revision, noEmbed: true });
    } catch (error) { outcome = error; } finally { engine.readPageSnapshot = read; }
    expect(edited).toBe(true);
    expect(outcome).toMatchObject({ code: 'changed_since_preview' });
    expect(readFileSync(part, 'utf8')).toBe('An uncommitted edit by alice-example\n');
    expect(await stored(engine, 'notes/big')).toEqual(before);
  }), 180_000);

  for (const breaking of breakings) {
    test(`a managed file repair of a head that does not reassemble (${breaking.code}) publishes nothing, whatever hash it binds`, () => brain(async ({ engine, ctx, root }) => {
      const { file, before } = await splitBrain(engine, ctx, root);
      const snapshot = await engine.readPageSnapshot('notes/big', { sourceId: 'default', includeDeleted: true });
      breaking.apply(root, 'notes/big.md');
      const broken = readFileSync(join(root, 'notes/big.md'), 'utf8');
      const untouched = snapshotFiles(root, 'notes/big.md');
      for (const [content, beforeHash] of [[broken.replace('title: Split example', 'title: Repaired'), sha256(broken)], [file.replace('title: Split example', 'title: Repaired'), sha256(file)]] as const) {
        const pub = await prepareRepairPublication(engine, { sourceId: 'default', slug: 'notes/big', sourcePath: 'notes/big.md', path: 'notes/big.md', root, content, snapshot, base: snapshot,
          ...await repairScreenConfig(engine, 'default') });
        if (pub.status !== 'ready') throw new Error(`publication is ${pub.status}`);
        const refused = await refusal(() => submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug: 'notes/big', path: 'notes/big.md', sourcePath: 'notes/big.md',
          content, beforeHash, resultDigest: pub.digest, expected_revision: snapshot!.revision, noEmbed: true }));
        expect(refused.code).toBe('changed_since_preview');
        expect(refused.message).toContain(breaking.code);
      }
      expect(snapshotFiles(root, 'notes/big.md')).toEqual(untouched);
      expect(await stored(engine, 'notes/big')).toEqual(before);
    }), 180_000);
  }

  test('the frontmatter repair previews and applies on F\'; the page is created whole and keeps the split layout', () => brain(async ({ engine, root }) => {
    const content = page(`title: Payments roundup\n${QUOTABLE}`);
    await committedSplitPage(engine, root, 'notes/fm.md', content);
    const preview = await run(engine, 'frontmatter', { only: ['notes/fm.md'] });
    const details = preview.details as { counts: Record<string, number>; diffs: Array<{ diff: string }> };
    expect(details.counts).toMatchObject({ safe: 1, needs_review: 0 });
    expect(details.diffs[0]!.diff).toContain(`+${QUOTED.trimEnd()}`);
    expect(details.diffs[0]!.diff).not.toContain('gbrain_parts');
    expect(await run(engine, 'frontmatter', { only: ['notes/fm.md'], apply: true, expect: hashOf(preview) })).toMatchObject({ applied: 1 });
    await settleManagedGitEffects(engine);
    expect(pageFile(root, 'notes/fm.md')).toBe(content.replace(QUOTABLE, QUOTED));
    expect(tracked(root, 'notes/fm.md')).toEqual(layout(root, 'notes/fm.md'));
    const row = await stored(engine, 'notes/fm');
    expect(row?.compiled_truth).toContain(lines(120).at(-1)!);
    expect(row?.frontmatter).toMatchObject({ author: 'alice-example (citing acme-example) (original: https://example.invalid/a)' });
    expect(row?.frontmatter).not.toHaveProperty('gbrain_parts');
  }), 180_000);

  for (const breaking of breakings) {
    test(`the frontmatter, fence and slug-conflict repairs and the census pass a head that does not reassemble by (${breaking.code}) and write nothing`, () => brain(async ({ engine, root }) => {
      const content = page(`title: Payments roundup\n${QUOTABLE}slug: elsewhere/absent-example\n`, lines(120).join('\n') + '\n\n' + fixableFence);
      await committedSplitPage(engine, root, 'notes/held.md', content);
      breaking.apply(root, 'notes/held.md');
      const untouched = snapshotFiles(root, 'notes/held.md');
      const fm = await run(engine, 'frontmatter', { only: ['notes/held.md'] });
      expect((fm.details as { needs_review: Array<{ path: string; code: string }> }).needs_review).toEqual([expect.objectContaining({ path: 'notes/held.md', code: breaking.code })]);
      expect(fm.affected).toBe(0);
      const fences = await run(engine, 'fences', { only: ['notes/held.md'] });
      expect(listed(fences)).toEqual({ 'notes/held.md': breaking.code });
      const slugs = await run(engine, 'slug-conflicts', { only: ['notes/held.md'] });
      expect(listed(slugs)).toEqual({ 'notes/held.md': breaking.code });
      await runFenceCensus(engine, { sourceIds: ['default'], deadline: Date.now() + 60_000 });
      expect((await listFenceCandidates(engine, ['default'])).filter(cand => cand.path === 'notes/held.md')).toEqual([]);
      expect(snapshotFiles(root, 'notes/held.md')).toEqual(untouched);
      expect(await stored(engine, 'notes/held')).toBeUndefined();
    }), 180_000);
  }

  test('on a brain with no canonical owner, the frontmatter repair passes a split head by instead of writing the page over it', () => brain(async ({ engine, root }) => {
    await committedSplitPage(engine, root, 'notes/fm.md', page(`title: Payments roundup\n${QUOTABLE}`));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const untouched = snapshotFiles(root, 'notes/fm.md');
    const preview = await run(engine, 'frontmatter', { only: ['notes/fm.md'] });
    expect((preview.details as { needs_review: Array<{ path: string; code: string }> }).needs_review).toEqual([expect.objectContaining({ path: 'notes/fm.md', code: 'split_page_unsupported' })]);
    expect(preview.affected).toBe(0);
    expect(snapshotFiles(root, 'notes/fm.md')).toEqual(untouched);
  }), 180_000);

  test('the fence census finds a malformed fence in a part, and the fence repair fixes it on F\' keeping the split layout', () => brain(async ({ engine, root }) => {
    const content = page('title: Fenced example\n', lines(120).join('\n') + '\n\n' + fixableFence);
    await committedSplitPage(engine, root, 'notes/fence.md', content);
    expect(readFileSync(join(root, 'notes/fence.md'), 'utf8')).not.toContain(FB);
    await runFenceCensus(engine, { sourceIds: ['default'], deadline: Date.now() + 60_000 });
    expect((await listFenceCandidates(engine, ['default'])).filter(cand => cand.path === 'notes/fence.md')).toEqual([expect.objectContaining({ tier: 'deterministic' })]);
    const preview = await run(engine, 'fences', { only: ['notes/fence.md'] });
    expect(listed(preview)).toEqual({ 'notes/fence.md': 'deterministic' });
    expect(await run(engine, 'fences', { only: ['notes/fence.md'], apply: true, expect: hashOf(preview) })).toMatchObject({ applied: 1 });
    await settleManagedGitEffects(engine);
    const repaired = pageFile(root, 'notes/fence.md');
    expect(repaired.startsWith(content.slice(0, content.indexOf(FB)))).toBe(true);
    expect(repaired).toContain(FBE);
    expect(tracked(root, 'notes/fence.md')).toEqual(layout(root, 'notes/fence.md'));
    expect(partsOf(root, 'notes/fence.md').length).toBeGreaterThan(1);
    const row = await stored(engine, 'notes/fence');
    expect(row?.compiled_truth).toContain(lines(120).at(-1)!);
    expect(row?.frontmatter).not.toHaveProperty('gbrain_parts');
  }), 180_000);

  test('the slug-conflict repair removes the slug: line from F\' and keeps the split layout', () => brain(async ({ engine, root }) => {
    const content = page('title: Slugged example\nslug: elsewhere/absent-example\n');
    await committedSplitPage(engine, root, 'notes/slugged.md', content);
    const preview = await run(engine, 'slug-conflicts', { only: ['notes/slugged.md'] });
    expect(listed(preview)).toEqual({ 'notes/slugged.md': 'deterministic' });
    expect((preview.details as { diffs: Array<{ diff: string }> }).diffs[0]!.diff).toContain('-slug: elsewhere/absent-example');
    expect(await run(engine, 'slug-conflicts', { only: ['notes/slugged.md'], apply: true, expect: hashOf(preview) })).toMatchObject({ applied: 1 });
    await settleManagedGitEffects(engine);
    expect(pageFile(root, 'notes/slugged.md')).toBe(content.replace('slug: elsewhere/absent-example\n', ''));
    expect(tracked(root, 'notes/slugged.md')).toEqual(layout(root, 'notes/slugged.md'));
    const row = await stored(engine, 'notes/slugged');
    expect(row?.compiled_truth).toContain(lines(120).at(-1)!);
    expect(row?.frontmatter).not.toHaveProperty('gbrain_parts');
  }), 180_000);

  test('file-drift passes a drifted split head by instead of reconciling the head as the page', () => brain(async ({ engine, ctx, root }) => {
    const { head, before } = await splitBrain(engine, ctx, root);
    writeFileSync(join(root, 'notes/big.md'), head.replace('title: Split example', 'title: Split example edited'));
    const untouched = snapshotFiles(root, 'notes/big.md');
    const preview = await run(engine, 'file-drift', { slugs: ['notes/big'], prefer: 'file' });
    expect(listed(preview)).toEqual({ 'notes/big': 'split_page_unsupported' });
    expect(preview.affected).toBe(0);
    expect(snapshotFiles(root, 'notes/big.md')).toEqual(untouched);
    expect(await stored(engine, 'notes/big')).toEqual(before);
  }), 180_000);
});
