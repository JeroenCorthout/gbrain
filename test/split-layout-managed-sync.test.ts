/**
 * Wave B PR 5 (split git layout), the managed read path: a managed sync imports a committed split page as the page its
 * parts reassemble to, reading the head and every part at the commit it is pinned to (never the working tree), and
 * holds a head whose parts are missing, unlisted or changed (`split_page_incomplete`) or whose body was edited
 * (`split_head_modified`); the stored page keeps its last good version. Managed persistence is on (managedBrain).
 * Postgres with GBRAIN_TEST_BACKEND=postgres (test/postgres-unit-arms.txt).
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setSplitLimitsForTests } from '../src/core/split-layout/index.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { screeningRequest } from '../src/core/persistence/noop-kernel.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { proveFenceRowsOnly } from '../src/core/repair/url-clone-fences.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../src/core/facts-fence.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { reconstructedPage } from './helpers/segmented-page-checks.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { performSync } from '../src/commands/sync.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { splitLayoutEntry } from '../src/commands/doctor/checks/split-layout.ts';

const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const HEAD = 'notes/big.md';
const page = (version: string) => '---\ntype: note\ntitle: Split fixture\n---\n\n'
  + Array.from({ length: 80 }, (_, i) => `Line ${i} of ${version} is synthetic fixture content long enough to fill a part.`).join('\n') + '\n';

function setup({ root }: { root: string }): void {
  writeFileSync(join(root, '.gitignore'), '\n');
  git(root, 'init', '-q'); git(root, 'add', '.gitignore'); git(root, 'commit', '-qm', 'Synthetic fixture base');
  const hook = join(root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(hook, 0o755);
}
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(async b => { __setSplitLimitsForTests(LIMITS); await run(b); }, { databaseUrl, setup });
afterEach(() => __setSplitLimitsForTests(null));

const commit = (root: string, message: string) => { git(root, 'add', '-A', '--', 'notes'); git(root, 'commit', '-qm', message); };
const sync = (engine: BrainEngine) => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
async function stored(engine: BrainEngine) {
  return (await engine.readPageSnapshot('notes/big', { sourceId: 'default' }))?.page ?? null;
}
async function hold(engine: BrainEngine) {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  return readGitHold(engine, 'default', source!.incarnation, HEAD);
}
async function syncedV1({ engine, root }: ManagedBrain) {
  const written = await writeSplitPage(root, HEAD, page('v1'));
  commit(root, 'Synthetic split page v1');
  await sync(engine);
  expect((await stored(engine))?.compiled_truth).toContain('Line 79 of v1');
  return written;
}

test('a committed split page imports as the page its parts reassemble to, without gbrain_parts', () => brain(async ({ engine, root }) => {
  await writeSplitPage(root, HEAD, page('v1'));
  commit(root, 'Synthetic split page v1');
  await sync(engine);
  const imported = await stored(engine);
  expect(imported?.compiled_truth).toContain('Line 0 of v1');
  expect(imported?.compiled_truth).toContain('Line 79 of v1');
  expect(imported?.compiled_truth).not.toContain('[gbrain] This page continues');
  expect(imported?.title).toBe('Split fixture');
  expect(imported?.frontmatter).not.toHaveProperty('gbrain_parts');
  expect(await hold(engine)).toBeNull();
}), 120_000);

test('the parts are read from the pinned commit, never the working tree', () => brain(async ({ engine, root }) => {
  const written = await writeSplitPage(root, HEAD, page('v1'));
  commit(root, 'Synthetic split page v1');
  rmSync(join(root, written.parts[3]!.rel));
  writeFileSync(join(root, written.parts[4]!.rel), 'UNCOMMITTED LOCAL BYTES\n');
  await sync(engine);
  const imported = await stored(engine);
  expect(imported?.compiled_truth).toContain('Line 79 of v1');
  expect(imported?.compiled_truth).not.toContain('UNCOMMITTED LOCAL BYTES');
  expect(await hold(engine)).toBeNull();
}), 120_000);

test('a committed missing part holds the head split_page_incomplete; the page keeps v1 until the part is restored', () => brain(async b => {
  const { engine, root } = b;
  const written = await syncedV1(b);
  git(root, 'rm', '-q', '--', written.parts[2]!.rel);
  git(root, 'commit', '-qm', 'Synthetic missing part');
  await sync(engine);
  expect((await hold(engine))?.code).toBe('split_page_incomplete');
  expect((await stored(engine))?.compiled_truth).toContain('Line 79 of v1');
  writeFileSync(join(root, written.parts[2]!.rel), written.parts[2]!.content);
  commit(root, 'Synthetic restored part');
  await sync(engine);
  expect(await hold(engine)).toBeNull();
  expect((await stored(engine))?.compiled_truth).toContain('Line 79 of v1');
}), 120_000);

test('a committed edit of the head body holds it split_head_modified; the short head is never imported', () => brain(async b => {
  const { engine, root } = b;
  await syncedV1(b);
  const head = readFileSync(join(root, HEAD), 'utf8');
  writeFileSync(join(root, HEAD), head.replace('Line 0 of v1', 'Line 0 of v1, edited by hand'));
  commit(root, 'Synthetic head edit');
  await sync(engine);
  expect((await hold(engine))?.code).toBe('split_head_modified');
  const kept = await stored(engine);
  expect(kept?.compiled_truth).toContain('Line 79 of v1');
  expect(kept?.compiled_truth).not.toContain('edited by hand');
}), 120_000);

test('a part changed in a later commit, the head untouched, is held; a consistent v2 then imports', () => brain(async b => {
  const { engine, root } = b;
  const written = await syncedV1(b);
  writeFileSync(join(root, written.parts[5]!.rel), written.parts[5]!.content.toString('utf8').replace('of v1', 'of vX'));
  commit(root, 'Synthetic part edit');
  await sync(engine);
  expect((await hold(engine))?.code).toBe('split_page_incomplete');
  expect((await stored(engine))?.compiled_truth).not.toContain('of vX');
  rmSync(join(root, written.partsDir), { recursive: true });
  await writeSplitPage(root, HEAD, page('v2'));
  commit(root, 'Synthetic split page v2');
  await sync(engine);
  expect(await hold(engine)).toBeNull();
  expect((await stored(engine))?.compiled_truth).toContain('Line 79 of v2');
}), 120_000);

test('a split page over the read bound is frozen by reference and streamed from its pinned commit', () => brain(async ({ engine, root }) => {
  __setSplitLimitsForTests({ ...LIMITS, partTarget: 1024 ** 2, partMax: 2 * 1024 ** 2 });
  await engine.setConfig('pages.segmented_storage', 'on');
  const content = conversationPage(PAGE_MAX_BYTES + 2 * 1024 * 1024, { seed: 52 });
  const written = await writeSplitPage(root, HEAD, content);
  commit(root, 'Synthetic split page over the read bound');
  rmSync(join(root, written.parts[1]!.rel));
  await sync(engine);
  expect(await hold(engine)).toBeNull();
  const { page, body, hash } = await reconstructedPage(engine, 'notes/big', 'default');
  expect(page.body_storage).toBe('segmented');
  expect(body.compiled_truth).toBe(parseMarkdown(content, HEAD).compiled_truth);
  expect(page.content_hash).toBe(hash);
  const [request] = await engine.executeRaw<{ intent: Record<string, unknown> }>(
    "SELECT intent FROM persistence_requests WHERE slug='notes/big' AND intent->>'kind'='managed_sync_import' ORDER BY sequence DESC LIMIT 1");
  expect(request!.intent.content ?? null).toBeNull();
  expect(request!.intent.body_ref).toMatchObject({ kind: 'split_page', sha256: sha256(content), bytes: Buffer.byteLength(content) });
}), 600_000);

test('reconcile never reads a split head as the file side', () => brain(async b => {
  const { engine } = b;
  await syncedV1(b);
  const registration = await registerLocalWriter(engine, 'cli');
  await withVerifiedLocalRegistration(engine, registration, async () => {
    const preview = runReconcilePreview(engine, { source_id: 'default', slug: 'notes/big' });
    await expect(preview).rejects.toMatchObject({ code: 'invalid_params', message: 'Reconcile does not read split page heads.' });
  });
  expect((await stored(engine))?.compiled_truth).toContain('Line 79 of v1');
}), 120_000);

// A facts fence the import corrects (kind `partnership` maps to `fact`): an ordinary page's correction is written back to its file.
const FENCE = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|---|---|---|---|---|---|---|---|---|\n| 1 | A synthetic claim about an example vendor | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n';

test('a split page the import corrects is never written back over its head', () => brain(async b => {
  const { engine, root } = b;
  const written = await syncedV1(b);
  rmSync(join(root, written.partsDir), { recursive: true });
  const v2 = await writeSplitPage(root, HEAD, page('v2') + '\n' + FENCE);
  commit(root, 'Synthetic split page v2 with a facts fence');
  await sync(engine);
  expect(await hold(engine)).toBeNull();
  expect(readFileSync(join(root, HEAD), 'utf8')).toBe(v2.head);
  expect(git(root, 'status', '--porcelain', '--', 'notes')).toBe('');
  expect((await stored(engine))?.compiled_truth).toContain('Line 79 of v2');
}), 120_000);

test('an import request that froze a split head alone is refused at preparation', () => brain(async b => {
  const { engine, root } = b;
  await syncedV1(b);
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    "SELECT * FROM persistence_requests WHERE slug='notes/big' AND intent->>'kind'='managed_sync_import' AND intent ? 'split' ORDER BY sequence DESC LIMIT 1");
  expect(row).toBeDefined();
  const snapshot = (await engine.readPageSnapshot('notes/big', { sourceId: 'default' }))!;
  const head = readFileSync(join(root, HEAD), 'utf8');
  const { split: _split, ...intent } = row!.intent as SyncIntent;
  const request = screeningRequest({ ...(row as unknown as WriteRequest), page_id: snapshot.page.id,
    intent: { ...intent, content: head, rawHash: sha256(head), expected_revision: snapshot.revision } });
  await expect(prepareManagedSyncMutation(engine, request, { engine: engine.kind } as never, undefined, { unsaved: true }))
    .rejects.toMatchObject({ code: 'split_page_incomplete' });
}), 120_000);


test('the URL-clone fence repair never restores a split head as its page', () => {
  const appended = (text: string) => {
    const rows = parseFactsFence(text).facts;
    return replaceOrInsertFactsFence(text, renderFactsTable([...rows, { ...rows[0]!, rowNum: 2, claim: 'A second synthetic claim' }]));
  };
  const ordinary = '---\ntitle: Split fixture\n---\n\nA synthetic lead.\n\n' + FENCE.replace('partnership', 'fact');
  expect(proveFenceRowsOnly(ordinary, appended(ordinary))).toMatchObject({ ok: true });
  const head = ordinary.replace('title: Split fixture\n', 'title: Split fixture\ngbrain_parts:\n  version: 1\n');
  expect(proveFenceRowsOnly(head, appended(head))).toMatchObject({ ok: false, class: 'split_page_head' });
});

async function heldAt(engine: BrainEngine, path: string) {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  return readGitHold(engine, 'default', source!.incarnation, path);
}
const livePaths = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string; source_path: string | null }>(
  "SELECT slug, source_path FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => `${row.slug}=${row.source_path}`);

test('a split page renamed with its parts directory (git mv) is found whole at its new path and nothing is left at the old one', () => brain(async b => {
  const { engine, root } = b;
  const written = await syncedV1(b);
  const before = await stored(engine);
  git(root, 'mv', HEAD, 'notes/moved.md');
  git(root, 'mv', written.partsDir, 'notes/.moved.gbparts');
  git(root, 'commit', '-qm', 'Synthetic move of a split page');
  await sync(engine);
  expect(await heldAt(engine, 'notes/moved.md')).toBeNull();
  const moved = (await engine.readPageSnapshot('notes/moved', { sourceId: 'default' }))?.page;
  expect(moved?.compiled_truth).toBe(before!.compiled_truth);
  expect(moved?.compiled_truth).toContain('Line 79 of v1');
  expect(moved?.frontmatter).not.toHaveProperty('gbrain_parts');
  expect(await livePaths(engine)).toEqual(['notes/moved=notes/moved.md']);
  expect(await stored(engine)).toBeNull();
  expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'notes').trim().split('\n').filter(path => path === HEAD || path.startsWith(written.partsDir + '/'))).toEqual([]);
}), 120_000);

test('a rename that moves only the head, without its parts directory, is held split_page_incomplete', () => brain(async b => {
  const { engine, root } = b;
  await syncedV1(b);
  const before = await stored(engine);
  git(root, 'mv', HEAD, 'notes/moved.md');
  git(root, 'commit', '-qm', 'Synthetic move of a split head alone');
  await sync(engine);
  const held = await heldAt(engine, 'notes/moved.md');
  expect(held).toMatchObject({ code: 'split_page_incomplete', page_id: null, meta: { rename_from: { slug: 'notes/big', sourcePath: HEAD } } });
  expect(held!.message).toContain('parts directory notes/.moved.gbparts does not exist');
  expect(held!.message).toContain('move its parts directory with it (git mv');
  expect(await livePaths(engine)).toEqual(['notes/big=notes/big.md']);
  expect((await stored(engine))?.compiled_truth).toBe(before!.compiled_truth);
  expect(await engine.readPageSnapshot('notes/moved', { sourceId: 'default' })).toBeNull();
}), 120_000);

/** What a gbrain before the split read path did with a committed split head: imported the head itself as the short page. */
async function olderGbrainImport(engine: BrainEngine, root: string, head: string): Promise<void> {
  expect((await importFromContent(engine, 'notes/big', head, { sourceId: 'default', sourcePath: HEAD, noEmbed: true })).status).toBe('imported');
  await engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", [git(root, 'rev-parse', 'HEAD').trim()]);
}
const brainAfter = (older: (b: { engine: BrainEngine; root: string }) => Promise<void>, run: (b: ManagedBrain) => Promise<void>) => managedBrain(async b => {
  __setSplitLimitsForTests(LIMITS); await run(b);
}, { databaseUrl, setup: async b => { setup(b); __setSplitLimitsForTests(LIMITS); await older(b); } });
async function splitDoctor(engine: BrainEngine, remote = false): Promise<Check> {
  const ctx = { engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', tier: 'standard', remote } as unknown as DoctorContext;
  return (await splitLayoutEntry.run(ctx) as Check[]).find(check => check.name === 'split_layout')!;
}
const whole = parseMarkdown(page('v1'), HEAD);
/** The sync entry point (gbrain sync), which reports the pages it rebuilt. */
const syncCommand = (engine: BrainEngine) => performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });

test('a page an older gbrain stored as its split head is rebuilt whole by the next sync; doctor reports it until then', () => brainAfter(async ({ engine, root }) => {
  await writeSplitPage(root, HEAD, page('v1'));
  commit(root, 'Synthetic split page v1');
  await olderGbrainImport(engine, root, readFileSync(join(root, HEAD), 'utf8'));
}, async ({ engine, root }) => {
  expect((await stored(engine))?.frontmatter).toHaveProperty('gbrain_parts');
  const before = await splitDoctor(engine);
  expect(before).toMatchObject({ status: 'warn', details: { stale_split_imports: 1, stale_sample: [{ source_id: 'default', slug: 'notes/big' }] },
    fix: { argv: ['gbrain', 'sync', '--source', 'default', '--no-pull'] } });
  expect(before.message).toContain('gbrain sync --source default --no-pull');
  const remote = await splitDoctor(engine, true);
  expect(remote.details).toMatchObject({ stale_split_imports: 1, stale_sample: [] });
  expect(JSON.stringify(remote)).not.toContain('notes/big');
  const result = await syncCommand(engine);
  expect(result.split_pages_rebuilt).toEqual({ count: 1, slugs: ['notes/big'] });
  const rebuilt = await stored(engine);
  expect(rebuilt?.compiled_truth).toBe(whole.compiled_truth);
  expect(rebuilt?.frontmatter).toEqual(whole.frontmatter);
  expect(rebuilt?.title).toBe(whole.title);
  expect(await hold(engine)).toBeNull();
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(await splitDoctor(engine)).toMatchObject({ status: 'ok', details: { stale_split_imports: 0 } });
  expect((await syncCommand(engine)).split_pages_rebuilt).toBeUndefined();
}), 120_000);

test('a converged source whose stored page an older gbrain host replaced with the split head rebuilds it', () => brain(async b => {
  const { engine, root } = b;
  const written = await syncedV1(b);
  const good = await stored(engine);
  // The older host's import, written while the pass state stays converged (an idle tick reads nothing).
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await importFromContent(engine, 'notes/big', written.head, { sourceId: 'default', sourcePath: HEAD, noEmbed: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await stored(engine))?.compiled_truth).not.toContain('Line 79 of v1');
  const result = await syncCommand(engine);
  expect(result.split_pages_rebuilt).toEqual({ count: 1, slugs: ['notes/big'] });
  expect((await stored(engine))?.compiled_truth).toBe(good!.compiled_truth);
  expect(git(root, 'status', '--porcelain')).toBe('');
}), 120_000);

test('a page an older gbrain stored as its split head stays as stored while a part is missing, then rebuilds', () => brainAfter(async ({ engine, root }) => {
  const written = await writeSplitPage(root, HEAD, page('v1'));
  commit(root, 'Synthetic split page v1');
  git(root, 'rm', '-q', written.parts[2]!.rel);
  git(root, 'commit', '-qm', 'Synthetic lost part');
  await olderGbrainImport(engine, root, written.head);
}, async ({ engine, root }) => {
  const short = await stored(engine);
  const headBytes = readFileSync(join(root, HEAD));
  const result = await syncCommand(engine);
  expect(result.split_pages_rebuilt).toBeUndefined();
  expect(await hold(engine)).toMatchObject({ code: 'split_page_incomplete' });
  expect(await stored(engine)).toMatchObject({ compiled_truth: short!.compiled_truth, frontmatter: short!.frontmatter });
  expect(readFileSync(join(root, HEAD)).equals(headBytes)).toBe(true);
  expect(git(root, 'status', '--porcelain')).toBe('');
  git(root, 'revert', '--no-edit', 'HEAD');
  expect((await syncCommand(engine)).split_pages_rebuilt).toEqual({ count: 1, slugs: ['notes/big'] });
  expect((await stored(engine))?.compiled_truth).toBe(whole.compiled_truth);
  expect(await hold(engine)).toBeNull();
}), 120_000);
