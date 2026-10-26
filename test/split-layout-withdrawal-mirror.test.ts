/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): a withdrawal mirror of a split page.
 *
 * 1. Protects: forget and purge_fact of a claim in a split page's facts fence rewrite the page as one unit through the
 *    split layout the publication door uses (persistence/split-mirror.ts): the head and the parts that changed are
 *    written, parts the new manifest drops are removed, the head reassembles to the page with the claim withdrawn, and
 *    the withdrawal's Git effect commits the head with its parts. A page the withdrawal brings under the threshold is
 *    one file again, with every part and the parts directory removed. A page stored in segments is mirrored the same way.
 *    A mirror interrupted mid-staging, once every stage is written, or once every file is renamed recovers forward:
 *    one unit on disk and in Git, no stage left, no live row.
 * 2. Fails when: the mirror writes the page's whole file over the head (the head stops being a split head and the parts
 *    are orphaned), a part keeps the withdrawn claim, the Git effect commits the head without its parts, or recovery
 *    leaves a stage or publishes a head without its parts.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests; interruptions are a fault hook that throws once at a seam (fault-points.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
/** A page stored in segments is over 1 MiB: parts of about 64 KB keep its head under the threshold. */
const SEGMENTED_LIMITS = { ...LIMITS, partTarget: 65_536, partMax: 131_072 };
const SLUG = 'people/alice-example';
const CLAIM = 'Alice Example keeps the locker code 4471';
const LIVE_ROW = new RegExp(`\\|\\s*${CLAIM}\\s*\\|`);
const op = (name: string) => operations.find(o => o.name === name)!;
const pageOf = (lines: number) => `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${Array.from({ length: lines },
  (_, i) => `Line ${String(i).padStart(5, '0')} of a page long enough to be stored as a head and parts.`).join('\n')}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

function pageFiles(root: string) {
  const head = join(root, SLUG + '.md');
  const dir = partsDirFor(head);
  const rel = (path: string) => relative(root, path).split('\\').join('/');
  const parts = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.gbpart')).sort().map(name => join(dir, name)) : [];
  return { head, dir, rel, tracked: [head, ...parts].map(rel) };
}
const commitPaths = (root: string, commit: string) => git(root, 'show', '--name-only', '--format=', commit).split('\n').filter(Boolean).sort();

/** The page as its head and parts stand for it on disk (the head must be a split head whose parts verify). */
function splitPage(root: string): string {
  const { head } = pageFiles(root);
  const file = readPageFile(head);
  expect(file.hold).toBeUndefined();
  expect(file.split).toBe(true);
  return file.hold ? '' : file.bytes.toString('utf8');
}

/** The head is a split head, its parts verify, and HEAD's tree holds exactly the head and the parts on disk. */
function expectCommittedSplit(root: string) {
  const { head, dir, rel } = pageFiles(root);
  expect(parseHead(readFileSync(head, 'utf8')) !== null).toBe(true);
  splitPage(root);
  expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  const tracked = git(root, 'ls-files', '--', rel(head), rel(dir)).split('\n').filter(Boolean).sort();
  expect(tracked).toEqual(pageFiles(root).tracked.sort());
}

/** Neither the page on disk nor the page HEAD commits holds the pattern. */
function expectWithdrawnEverywhere(root: string, gone: RegExp) {
  const { head } = pageFiles(root);
  const file = readPageFile(head);
  expect(file.hold).toBeUndefined();
  if (!file.hold) expect(file.bytes.toString('utf8')).not.toMatch(gone);
  for (const path of pageFiles(root).tracked) expect(git(root, 'show', `HEAD:${path}`)).not.toMatch(gone);
}

/** Runs effect passes until the source's mirror and Git effects have settled (committed, no recovery left). */
async function settle(engine: BrainEngine) {
  await waitFor(async () => {
    const [open] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
      WHERE kind IN ('withdrawal-mirror','git') AND (state <> 'committed' OR recovery IS NOT NULL)`);
    if (!open!.n) return true;
    await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE state='queued'`); });
    await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 }).catch(() => undefined);
    return false;
  }, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror and Git effects settled' });
}

/** A put_page replayed with its request_id until it commits (a large page can still be pending after the wait). */
async function put(ctx: OperationContext, content: string) {
  const request_id = randomUUID();
  for (let replay = 0; replay < 20; replay++) {
    const out = await op('put_page').handler(ctx, { slug: SLUG, content, request_id, wait_ms: 30_000 }) as Record<string, any>;
    if (out.state !== 'pending' && out.code !== 'write_pending') { expect(out.state).toBe('committed'); return; }
  }
  throw new Error('put_page did not commit');
}

/** Remembers CLAIM about the page; the row lands in a part of the split page. Returns the fact's protocol id. */
async function remember(ctx: OperationContext, engine: BrainEngine, root: string): Promise<string> {
  const out = await op('remember').handler(ctx, { fact: CLAIM, entity: SLUG, provenance: 'test', visibility: 'world' }) as Record<string, any>;
  await settle(engine);
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [CLAIM]);
  expect(row).toBeDefined();
  expect(splitPage(root)).toMatch(LIVE_ROW);
  expect(readFileSync(pageFiles(root).head, 'utf8')).not.toContain(CLAIM);
  expectCommittedSplit(root);
  return String(out.fact_id ?? out.id ?? row!.id);
}

async function purge(ctx: OperationContext, engine: BrainEngine) {
  const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [CLAIM]);
  const dry = await op('purge_fact').handler(ctx, { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
  const done = await op('purge_fact').handler(ctx, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
  expect(done.state).toBe('committed');
}

const forget = (ctx: OperationContext, id: string) => op('forget').handler(ctx, { id, request_id: randomUUID() });
const mirrorEffects = (engine: BrainEngine) => engine.executeRaw(`SELECT kind,state,error_code,recovery IS NULL AS clear FROM persistence_effects WHERE kind='withdrawal-mirror'`);

for (const backend of testBackends()) describe(`[${backend}] split git layout: a withdrawal mirror`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { installFaultHook(undefined); __setSplitLimitsForTests(null); });

  test('forget rewrites the split page as one unit: head and changed parts, committed together', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    await put(ctx, pageOf(120));
    const id = await remember(ctx, engine, root);
    await forget(ctx, id);
    await settle(engine);
    expect(await mirrorEffects(engine)).toEqual([{ kind: 'withdrawal-mirror', state: 'committed', error_code: null, clear: true }]);
    expectCommittedSplit(root);
    expectWithdrawnEverywhere(root, LIVE_ROW);
    expect(splitPage(root)).toContain(`~~${CLAIM}~~`);
    const { head, rel } = pageFiles(root);
    expect(commitPaths(root, 'HEAD')).toContain(rel(head));
  }, { databaseUrl, setup }), 240_000);

  test('purge_fact removes the claim from every part and commits the unit', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    await put(ctx, pageOf(120));
    await remember(ctx, engine, root);
    await purge(ctx, engine);
    await settle(engine);
    expect(await mirrorEffects(engine)).toEqual([{ kind: 'withdrawal-mirror', state: 'committed', error_code: null, clear: true }]);
    expectCommittedSplit(root);
    expectWithdrawnEverywhere(root, new RegExp(CLAIM));
  }, { databaseUrl, setup }), 240_000);

  test('a purge that brings the page under the threshold converts it back to one file and removes every part', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
    await put(ctx, pageOf(120));
    await remember(ctx, engine, root);
    const { head, rel } = pageFiles(root);
    const partsBefore = pageFiles(root).tracked.slice(1);
    const whole = readPageFile(head);
    expect(whole.hold).toBeUndefined();
    // The page is just over the threshold now; without the purged row it is under it.
    if (!whole.hold) await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(whole.bytes.length - 1));
    await purge(ctx, engine);
    await settle(engine);
    expect(parseHead(readFileSync(head, 'utf8'))).toBeNull();
    expect(existsSync(partsDirFor(head))).toBe(false);
    expect(pageFiles(root).tracked).toEqual([rel(head)]);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(commitPaths(root, 'HEAD')).toEqual([rel(head), ...partsBefore].sort());
    expectWithdrawnEverywhere(root, new RegExp(CLAIM));
  }, { databaseUrl, setup }), 240_000);

  test('forget on a split page stored in segments mirrors the streamed page as one unit', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(SEGMENTED_LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '131072');
    await engine.setConfig('pages.segmented_storage', 'on');
    await put(ctx, pageOf(17_000));
    expect(await engine.executeRaw('SELECT body_storage FROM pages WHERE slug=$1', [SLUG])).toEqual([{ body_storage: 'segmented' }]);
    const id = await remember(ctx, engine, root);
    await forget(ctx, id);
    await settle(engine);
    expect(await mirrorEffects(engine)).toEqual([{ kind: 'withdrawal-mirror', state: 'committed', error_code: null, clear: true }]);
    expectCommittedSplit(root);
    expectWithdrawnEverywhere(root, LIVE_ROW);
  }, { databaseUrl, setup }), 240_000);

  /** Where the mirror stops once: mid-staging (a stage cut short), once every stage is written (no file renamed), and once every file is renamed (its transaction rolled back). */
  const SEAMS = { staging: 'large_file:stage_streaming', staged: 'effect_recovery:split_staged', published: 'effect_recovery:before_clear' } as const;
  for (const interruption of Object.keys(SEAMS) as (keyof typeof SEAMS)[]) {
    test(`a split mirror interrupted ${interruption} recovers forward: one unit, no stage left, no live row`, () => managedBrain(async ({ engine, ctx, root }) => {
      __setSplitLimitsForTests(LIMITS);
      await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
      await put(ctx, pageOf(120));
      const id = await remember(ctx, engine, root);
      let thrown = 0;
      let staged = 0;
      const interrupt = () => { thrown++; throw new Error(`interrupted at ${interruption}`); };
      installFaultHook(async point => { if (point === SEAMS[interruption] && !thrown && (interruption !== 'staging' || ++staged === 2)) interrupt(); });
      try {
        await forget(ctx, id);
        await settle(engine);
      } finally { installFaultHook(undefined); }
      expect(thrown).toBe(1);
      expect(await mirrorEffects(engine)).toEqual([{ kind: 'withdrawal-mirror', state: 'committed', error_code: null, clear: true }]);
      expectCommittedSplit(root);
      expectWithdrawnEverywhere(root, LIVE_ROW);
      const { head, dir } = pageFiles(root);
      expect([...readdirSync(join(head, '..')), ...readdirSync(dir)].filter(name => name.includes('.tmp.'))).toEqual([]);
    }, { databaseUrl, setup }), 240_000);
  }
});
