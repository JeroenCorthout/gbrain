/**
 * Split git layout (Wave B PR 5 lane 5e, option B, GBRA-108): the file-repair lanes over a split page.
 *
 * Protects: only the publication door of a git-canonical source writes a split page (a head plus part files in
 * .<name>.gbparts/), and every file-repair lane is outside it (split-write-through.ts assertOutsideDoorWritable,
 * route file_repair). So a managed file repair of a split page refuses split_page_unsupported (outside_door) when it
 * binds the page file F' its head and parts reassemble to or the raw head (the split unit is checked before the
 * content), before it writes anything; a head that no longer reassembles (a missing part, an edited head body) refuses the same
 * way and is never reported with its hold code; a split unit that appears after the repair was submitted refuses
 * (outside_door) at validation. The frontmatter, fence and slug-conflict repairs and file-drift preview a split page as
 * split_page_unsupported and apply nothing, on a managed brain and on one with no canonical owner; the fence census,
 * a reader, still finds a malformed fence that lives in a part. In every refusal the head, every part, Git HEAD and the
 * page row stay byte for byte. A repair that grows a one-file page past the split threshold writes ONE file, as master
 * does: no parts directory, no head.
 * Regression it catches: any lane that reads the head raw and republishes it as the whole page (one file holding only
 * the head, every part deleted, the stored body truncated), or that rewrites a split page outside the door.
 * Engines: PGLite always; Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt). The source is git-canonical
 * (canonical: git), the only kind whose door lays out a split page.
 * Seam: __setSplitLimitsForTests (KB-sized parts and lead).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { listFenceCandidates, runFenceCensus } from '../src/core/fence-repair/census.ts';
import { __setSplitLimitsForTests, pageFileSha256, partsDirFor, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
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
const FB = '<!--- gbrain:facts:begin -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
/** Tier 1: a missing end marker and an invented kind, at the end of the page (in its last part). */
const fixableFence = `${FB}\n${FH}\n| 1 | Synthetic vendor partnership | partnership | 0.9 | private | high | 2026-01-01 |  | chat |  |\n`;
/** A git-canonical source (canonical: git): its door lays out a page over the threshold as a head plus parts. */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};
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
/** Every file of the split page at `rel` with its bytes, and Git HEAD, to prove nothing was written or committed. */
const snapshotFiles = (root: string, rel: string) => {
  const dir = partsDirFor(join(root, rel));
  return { head: readFileSync(join(root, rel)), parts: partsOf(root, rel).map(name => [name, readFileSync(join(dir, name))] as const), commit: git(root, 'rev-parse', 'HEAD') };
};
const commitAll = (root: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture'); };
const stored = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string; title: string; frontmatter: Record<string, unknown>; revision: string }>(
  "SELECT compiled_truth, title, frontmatter, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0];
const put = (ctx: OperationContext, slug: string, content: string) =>
  op('put_page').handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, unknown>>;
const quiet = { info() {}, warn() {}, error() {} };
const run = async (engine: BrainEngine, kind: 'frontmatter' | 'fences' | 'slug-conflicts' | 'file-drift', opts: Record<string, unknown> = {}) => {
  const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
  return runner.run(kind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', noLlm: true, ...opts });
};
const listed = (result: RepairResult) => Object.fromEntries((result.listing ?? []).map(entry => [entry.item.replace(/^default:/, ''), entry.class]));
const needsReview = (result: RepairResult) => (result.details as { needs_review: Array<{ path: string; code: string }> }).needs_review;
async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}
/** The outside-door refusal of a file repair of the split page notes/big: no hold code, the split-storage route. */
const outsideDoor = (slug: string) => ({ code: 'split_page_unsupported', reason: 'outside_door',
  fix: expect.objectContaining({ argv: ['gbrain', 'pages', 'split-storage', slug, '--source', 'default', '--json'] }) });

/** Sets the 4 KiB split threshold and lays a 120-line page (about 7.4 KiB) out through put_page (the door) as a split page. */
async function splitBrain(engine: BrainEngine, ctx: OperationContext, root: string) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
  expect(await put(ctx, 'notes/big', page('type: note\ntitle: Split example\n'))).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
  expect(partsOf(root, 'notes/big.md').length).toBeGreaterThan(1);
  expect(git(root, 'status', '--porcelain')).toBe('');
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

/** Prepares and submits a managed file repair of `slug` (path `${slug}.md`) to `content`, bound to `beforeHash`. */
async function submitRepair(engine: BrainEngine, ctx: OperationContext, root: string, slug: string, content: string, beforeHash: string) {
  const path = `${slug}.md`;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  const pub = await prepareRepairPublication(engine, { sourceId: 'default', slug, sourcePath: path, path, root, content, snapshot, base: snapshot, ...await repairScreenConfig(engine, 'default') });
  if (pub.status !== 'ready') throw new Error(`publication is ${pub.status}`);
  return submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug, path, sourcePath: path, content,
    beforeHash, resultDigest: pub.digest, expected_revision: snapshot!.revision, noEmbed: true });
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

  test('a managed file repair of a split page refuses split_page_unsupported (outside_door) bound to F\' or to the raw head; nothing is written', () => brain(async ({ engine, ctx, root }) => {
    const { head, file, before } = await splitBrain(engine, ctx, root);
    expect(pageFileSha256(join(root, 'notes/big.md'))).toMatchObject({ split: true, sha256: sha256(file), headSha256: sha256(head) });
    const untouched = snapshotFiles(root, 'notes/big.md');
    const rawHead = await refusal(() => submitRepair(engine, ctx, root, 'notes/big', head.replace('title: Split example', 'title: Split example repaired'), sha256(head)));
    expect(rawHead).toMatchObject(outsideDoor('notes/big'));
    const onFile = await refusal(() => submitRepair(engine, ctx, root, 'notes/big', file.replace('title: Split example', 'title: Split example repaired'), sha256(file)));
    expect(onFile).toMatchObject(outsideDoor('notes/big'));
    await settleManagedGitEffects(engine);
    expect(snapshotFiles(root, 'notes/big.md')).toEqual(untouched);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(await stored(engine, 'notes/big')).toEqual(before);
  }), 180_000);

  for (const importOnly of [false, true]) {
    test(`${importOnly ? 'an import-only file repair (the file already holds the repaired page)' : 'a managed file repair'} of a one-file page refuses split_page_unsupported at validation when a split unit appears after its submission; the file and the stored page stay`, () => brain(async ({ engine, ctx, root }) => {
      expect(await put(ctx, 'notes/plain', page('type: note\ntitle: Plain example\n', lines(4).join('\n') + '\n'))).toMatchObject({ state: 'committed' });
      await settleManagedGitEffects(engine);
      const target = join(root, 'notes/plain.md');
      expect(partsOf(root, 'notes/plain.md')).toEqual([]);
      if (importOnly) writeFileSync(target, readFileSync(target, 'utf8').replace('title: Plain example', 'title: Plain example repaired by hand'));
      const disk = readFileSync(target, 'utf8');
      const content = importOnly ? disk : disk.replace('title: Plain example', 'title: Plain example repaired');
      const before = await stored(engine, 'notes/plain');
      const stray = join(partsDirFor(target), '0001-0123abcd.gbpart');
      const read = engine.readPageSnapshot;
      let appeared = false;
      // The preparation reads the page snapshot after its first split check; the publication's validation checks again.
      engine.readPageSnapshot = function (this: BrainEngine, ...args: Parameters<BrainEngine['readPageSnapshot']>) {
        const fromPreparation = new Error().stack?.includes('prepareManagedFileRepairMutation');
        return read.apply(this, args).then(value => {
          if (fromPreparation && !appeared) { appeared = true; mkdirSync(partsDirFor(target), { recursive: true }); writeFileSync(stray, 'A part laid out by alice-example\n'); }
          return value;
        });
      };
      let outcome: unknown;
      try { outcome = await submitRepair(engine, ctx, root, 'notes/plain', content, sha256(disk)); }
      catch (error) { outcome = error; } finally { engine.readPageSnapshot = read; }
      expect(appeared).toBe(true);
      expect(outcome).toMatchObject(outsideDoor('notes/plain'));
      expect(readFileSync(target, 'utf8')).toBe(disk);
      expect(readFileSync(stray, 'utf8')).toBe('A part laid out by alice-example\n');
      expect(await stored(engine, 'notes/plain')).toEqual(before);
    }), 180_000);
  }

  test('a managed file repair that grows a one-file page past the split threshold writes ONE file, as master does: no parts directory, the head is the page', () => brain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    expect(await put(ctx, 'notes/plain', page('type: note\ntitle: Plain example\n', lines(4).join('\n') + '\n'))).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    const target = join(root, 'notes/plain.md');
    const disk = readFileSync(target, 'utf8');
    const grown = disk + lines(120).slice(4).join('\n') + '\n';
    expect(Buffer.byteLength(grown)).toBeGreaterThan(4096);
    expect(await submitRepair(engine, ctx, root, 'notes/plain', grown, sha256(disk))).toMatchObject({ file_repaired: true });
    await settleManagedGitEffects(engine);
    expect(readFileSync(target, 'utf8')).toBe(grown);
    expect(existsSync(partsDirFor(target))).toBe(false);
    expect(git(root, 'ls-files', 'notes').trim()).toBe('notes/plain.md');
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
    const row = await stored(engine, 'notes/plain');
    expect(row?.compiled_truth).toContain(lines(120).at(-1)!);
    expect(row?.frontmatter).not.toHaveProperty('gbrain_parts');
  }), 180_000);

  for (const breaking of breakings) {
    test(`a managed file repair of a head that does not reassemble (${breaking.code}) refuses before its hold, whatever hash it binds, and writes nothing`, () => brain(async ({ engine, ctx, root }) => {
      const { file, before } = await splitBrain(engine, ctx, root);
      breaking.apply(root, 'notes/big.md');
      const broken = readFileSync(join(root, 'notes/big.md'), 'utf8');
      const untouched = snapshotFiles(root, 'notes/big.md');
      const onHead = await refusal(() => submitRepair(engine, ctx, root, 'notes/big', broken.replace('title: Split example', 'title: Repaired'), sha256(broken)));
      expect(onHead).toMatchObject(outsideDoor('notes/big'));
      const onFile = await refusal(() => submitRepair(engine, ctx, root, 'notes/big', file.replace('title: Split example', 'title: Repaired'), sha256(file)));
      expect(onFile).toMatchObject(outsideDoor('notes/big'));
      for (const refused of [onHead, onFile]) expect(refused.message).not.toContain(breaking.code);
      expect(snapshotFiles(root, 'notes/big.md')).toEqual(untouched);
      expect(await stored(engine, 'notes/big')).toEqual(before);
    }), 180_000);
  }

  test('the frontmatter repair previews a split page as split_page_unsupported and applies nothing: no page row, the head and parts stay', () => brain(async ({ engine, root }) => {
    await committedSplitPage(engine, root, 'notes/fm.md', page(`title: Payments roundup\n${QUOTABLE}`));
    const untouched = snapshotFiles(root, 'notes/fm.md');
    const preview = await run(engine, 'frontmatter', { only: ['notes/fm.md'] });
    expect((preview.details as { counts: Record<string, number> }).counts).toMatchObject({ safe: 0, needs_review: 1 });
    expect(needsReview(preview)).toEqual([expect.objectContaining({ path: 'notes/fm.md', code: 'split_page_unsupported', resolution: expect.stringContaining('split_page_unsupported (outside_door)') })]);
    expect(preview.affected).toBe(0);
    await settleManagedGitEffects(engine);
    expect(snapshotFiles(root, 'notes/fm.md')).toEqual(untouched);
    expect(await stored(engine, 'notes/fm')).toBeUndefined();
  }), 180_000);

  for (const breaking of breakings) {
    test(`the frontmatter, fence and slug-conflict repairs and the census pass a head that does not reassemble (${breaking.code}) by as split_page_unsupported and write nothing`, () => brain(async ({ engine, root }) => {
      const content = page(`title: Payments roundup\n${QUOTABLE}slug: elsewhere/absent-example\n`, lines(120).join('\n') + '\n\n' + fixableFence);
      await committedSplitPage(engine, root, 'notes/held.md', content);
      breaking.apply(root, 'notes/held.md');
      const untouched = snapshotFiles(root, 'notes/held.md');
      const fm = await run(engine, 'frontmatter', { only: ['notes/held.md'] });
      expect(needsReview(fm)).toEqual([expect.objectContaining({ path: 'notes/held.md', code: 'split_page_unsupported' })]);
      expect(fm.affected).toBe(0);
      const fences = await run(engine, 'fences', { only: ['notes/held.md'] });
      expect(listed(fences)).toEqual({ 'notes/held.md': 'split_page_unsupported' });
      const slugs = await run(engine, 'slug-conflicts', { only: ['notes/held.md'] });
      expect(listed(slugs)).toEqual({ 'notes/held.md': 'split_page_unsupported' });
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
    expect(needsReview(preview)).toEqual([expect.objectContaining({ path: 'notes/fm.md', code: 'split_page_unsupported' })]);
    expect(preview.affected).toBe(0);
    expect(snapshotFiles(root, 'notes/fm.md')).toEqual(untouched);
  }), 180_000);

  test('the fence census finds a malformed fence in a part; the fence repair passes the split page by as split_page_unsupported and writes nothing', () => brain(async ({ engine, root }) => {
    const content = page('title: Fenced example\n', lines(120).join('\n') + '\n\n' + fixableFence);
    await committedSplitPage(engine, root, 'notes/fence.md', content);
    expect(readFileSync(join(root, 'notes/fence.md'), 'utf8')).not.toContain(FB);
    const untouched = snapshotFiles(root, 'notes/fence.md');
    await runFenceCensus(engine, { sourceIds: ['default'], deadline: Date.now() + 60_000 });
    expect((await listFenceCandidates(engine, ['default'])).filter(cand => cand.path === 'notes/fence.md')).toEqual([expect.objectContaining({ tier: 'deterministic' })]);
    const preview = await run(engine, 'fences', { only: ['notes/fence.md'] });
    expect(listed(preview)).toEqual({ 'notes/fence.md': 'split_page_unsupported' });
    expect(preview.affected).toBe(0);
    await settleManagedGitEffects(engine);
    expect(snapshotFiles(root, 'notes/fence.md')).toEqual(untouched);
    expect(await stored(engine, 'notes/fence')).toBeUndefined();
  }), 180_000);

  test('the slug-conflict repair passes a split page with a slug: line by as split_page_unsupported and writes nothing', () => brain(async ({ engine, root }) => {
    await committedSplitPage(engine, root, 'notes/slugged.md', page('title: Slugged example\nslug: elsewhere/absent-example\n'));
    const untouched = snapshotFiles(root, 'notes/slugged.md');
    const preview = await run(engine, 'slug-conflicts', { only: ['notes/slugged.md'] });
    expect(listed(preview)).toEqual({ 'notes/slugged.md': 'split_page_unsupported' });
    expect(preview.affected).toBe(0);
    await settleManagedGitEffects(engine);
    expect(snapshotFiles(root, 'notes/slugged.md')).toEqual(untouched);
    expect(await stored(engine, 'notes/slugged')).toBeUndefined();
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
