/**
 * Wave B PR 5 lane 5e (split git layout, option B, GBRA-108): a withdrawal mirror of a split page.
 *
 * 1. Protects: the withdrawal mirror is a route outside the publication door, so on a git-canonical source it passes a
 *    split page by (split-write-through.ts outsideDoorRefusal, route 'mirror'): forget and purge_fact withdraw the claim
 *    in the database, the mirror and its Git effect settle with the page recorded as skipped (split_page_unsupported),
 *    and the head, every part and Git HEAD stay byte for byte. A one-file page on the same source is still mirrored and
 *    committed with the claim gone from its file.
 * 2. Fails when: the mirror or its Git effect writes, commits or removes a file of the split unit, or the effects never
 *    settle (the round 7 timeout on a strict source: the mirror wrote the unit and its Git effect then refused every
 *    split-unit path, a failure with no terminal outcome, until the 120 s bound).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests; the source is git-canonical (canonical: git), the only kind whose door lays out a split page.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, readPageFile, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'people/alice-example';
const SMALL = 'people/bob-example';
const CLAIM = 'Alice Example keeps the locker code 4471';
const SMALL_CLAIM = 'Bob Example keeps the locker code 5582';
const liveRow = (claim: string) => new RegExp('\\|\\s*' + claim + '\\s*\\|');
const op = (name: string) => operations.find(o => o.name === name)!;
const pageOf = (title: string, lines: number) => '---\ntype: person\ntitle: ' + title + '\n---\n\n# ' + title + '\n\n'
  + Array.from({ length: lines }, (_, i) => 'Line ' + String(i).padStart(5, '0') + ' of a page long enough to be stored as a head and parts.').join('\n') + '\n';

/** A git-canonical source (canonical: git): its door lays out a page over the threshold as a head plus parts. */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw("UPDATE sources SET config = config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
};

/** Every file of the split unit with its bytes, and HEAD: what a mirror outside the door must leave as it was. */
function unitState(root: string) {
  const head = join(root, SLUG + '.md');
  const dir = partsDirFor(head);
  const files = [head, ...(existsSync(dir) ? readdirSync(dir).sort().map(name => join(dir, name)) : [])];
  return { files: Object.fromEntries(files.map(path => [relative(root, path), readFileSync(path, 'utf8')])), head: git(root, 'rev-parse', 'HEAD') };
}

/** Runs effect passes until the source's mirror and Git effects have settled (committed, no recovery left). */
async function settle(engine: BrainEngine) {
  await waitFor(async () => {
    const [open] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind IN ('withdrawal-mirror','git') AND (state <> 'committed' OR recovery IS NOT NULL)");
    if (!open!.n) return true;
    await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE state='queued'"); });
    await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 }).catch(() => undefined);
    return false;
  }, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror and Git effects settled' });
}

/** A put_page replayed with its request_id until it commits (a large page can still be pending after the wait). */
async function put(ctx: OperationContext, slug: string, content: string) {
  const request_id = randomUUID();
  for (let replay = 0; replay < 20; replay++) {
    const out = await op('put_page').handler(ctx, { slug, content, request_id, wait_ms: 30_000 }) as Record<string, any>;
    if (out.state !== 'pending' && out.code !== 'write_pending') { expect(out.state).toBe('committed'); return; }
  }
  throw new Error('put_page did not commit');
}

/** Remembers the claim about the page through the door; returns the fact's protocol id. */
async function remember(ctx: OperationContext, engine: BrainEngine, slug: string, claim: string): Promise<string> {
  const out = await op('remember').handler(ctx, { fact: claim, entity: slug, provenance: 'test', visibility: 'world' }) as Record<string, any>;
  await settle(engine);
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [claim]);
  expect(row).toBeDefined();
  return String(out.fact_id ?? out.id ?? row!.id);
}

/** A git-canonical brain with a split page carrying CLAIM in its parts and a one-file page carrying SMALL_CLAIM, all committed. */
async function seeded(ctx: OperationContext, engine: BrainEngine, root: string) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
  await put(ctx, SLUG, pageOf('Alice Example', 120));
  await put(ctx, SMALL, pageOf('Bob Example', 3));
  const ids = { split: await remember(ctx, engine, SLUG, CLAIM), small: await remember(ctx, engine, SMALL, SMALL_CLAIM) };
  const head = join(root, SLUG + '.md');
  expect(parseHead(readFileSync(head, 'utf8')) !== null).toBe(true);
  expect(readFileSync(head, 'utf8')).not.toContain(CLAIM);
  const file = readPageFile(head);
  expect(file.hold).toBeUndefined();
  if (!file.hold) expect(file.bytes.toString('utf8')).toMatch(liveRow(CLAIM));
  expect(readFileSync(join(root, SMALL + '.md'), 'utf8')).toMatch(liveRow(SMALL_CLAIM));
  expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  return ids;
}

const mirrorEffects = (engine: BrainEngine) => engine.executeRaw<{ state: string; error_code: string | null; clear: boolean; skipped: unknown }>(
  "SELECT state, error_code, recovery IS NULL AS clear, data->'skipped' AS skipped FROM persistence_effects WHERE kind='withdrawal-mirror' ORDER BY id");

/** Withdraws the claim with forget or purge_fact. */
async function withdraw(ctx: OperationContext, engine: BrainEngine, how: 'forget' | 'purge_fact', id: string, claim: string) {
  if (how === 'forget') { await op('forget').handler(ctx, { id, request_id: randomUUID() }); return; }
  const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1', [claim]);
  const dry = await op('purge_fact').handler(ctx, { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
  const done = await op('purge_fact').handler(ctx, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
  expect(done.state).toBe('committed');
}

for (const backend of testBackends()) describe('[' + backend + '] split git layout: a withdrawal mirror (outside the door)', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });

  for (const how of ['forget', 'purge_fact'] as const) {
    test(how + ' on a git-canonical source passes a split page by (split_page_unsupported): the effects settle, the head, every part and HEAD stay; a one-file page is mirrored and committed', () => managedBrain(async ({ engine, ctx, root }) => {
      const ids = await seeded(ctx, engine, root);
      const before = unitState(root);
      await withdraw(ctx, engine, how, ids.split, CLAIM);
      await settle(engine);
      expect(unitState(root)).toEqual(before);
      await withdraw(ctx, engine, how, ids.small, SMALL_CLAIM);
      await settle(engine);
      expect(await engine.executeRaw('SELECT fact FROM facts WHERE fact = ANY($1::text[]) AND expired_at IS NULL', [[CLAIM, SMALL_CLAIM]])).toEqual([]);
      expect(unitState(root).files).toEqual(before.files);
      const rows = await mirrorEffects(engine);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatchObject({ state: 'committed', error_code: null, clear: true });
      expect(rows.flatMap(row => (row.skipped as Array<{ slug: string; reason: string }> | null) ?? [])).toContainEqual({ slug: SLUG, reason: 'split_page_unsupported' });
      const small = readFileSync(join(root, SMALL + '.md'), 'utf8');
      expect(small).not.toMatch(liveRow(SMALL_CLAIM));
      expect(git(root, 'show', 'HEAD:' + SMALL + '.md')).toBe(small);
      expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    }, { databaseUrl, setup }), 300_000);
  }
});
