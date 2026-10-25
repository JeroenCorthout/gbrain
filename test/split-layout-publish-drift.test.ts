/**
 * Wave B PR 5 lane 5b: a split page publication refuses as drift when the parts directory is not the one the write was
 * prepared against (persistence/split-files.ts `expectedParts`, `splitFilesChanged`, `splitKeptPartsChanged`).
 *
 * 1. Protects: a write carries the verified manifest of the head it read (every part with its SHA-256) from preparation
 *    to publication. A part edited by hand after preparation, whether the write would rewrite it or keep it, refuses
 *    `source_changed` as an edited single file does: nothing is written, and the edit stays on disk. A part the
 *    publication keeps unwritten is rechecked under the lock, in the publication transaction, like every file it writes.
 * 2. Fails when: the publication plans against the directory as it finds it at publication (so a hand edit to a part
 *    is overwritten, or a kept part that changed is left under a head that no longer describes it).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests. The part
 *    is edited at consumer:prepared (after preparation, before publication) and at publication:prepared (after the
 *    recovery record, before the publication transaction).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { installFaultHook, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { __setSplitLimitsForTests, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `Line ${String(from + i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const page = (body: string[]) => `---\ntype: note\ntitle: Split example\n---\n\n${body.join('\n')}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, slug: string, content: string, expectedRevision?: string) => operations.find(o => o.name === 'put_page')!.handler(ctx,
  { slug, content, request_id: randomUUID(), wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Every file of the unit (head, then parts) with its SHA-256. */
const unit = (root: string, rel: string) => {
  const dir = partsDirFor(join(root, rel));
  return { head: sha(join(root, rel)), parts: Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(join(dir, name))])) };
};

/** Writes a split page, then appends to it with the first part (which the append keeps) edited by hand at `point`. */
async function appendWithEditedPart(engine: BrainEngine, ctx: OperationContext, root: string, point: FaultPoint) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  const first = await put(ctx, 'notes/big', page(lines(0, 80)));
  expect(first).toMatchObject({ state: 'committed' });
  const dir = partsDirFor(join(root, 'notes/big.md'));
  const firstPart = join(dir, readdirSync(dir).sort()[0]!);
  let edited: string | undefined;
  installFaultHook(async at => {
    if (at !== point || edited !== undefined) return;
    edited = readFileSync(firstPart, 'utf8').replace('Line 0000', 'Line ZERO');
    writeFileSync(firstPart, edited);
  });
  const before = unit(root, 'notes/big.md');
  const refused = await put(ctx, 'notes/big', page(lines(0, 84)), first.revision).then(receipt => receipt, (error: unknown) => error) as Record<string, any>;
  installFaultHook(undefined);
  expect(edited).toBeDefined();
  return { refused, before, firstPart, edited: edited! };
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: parts drift between preparation and publication`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { installFaultHook(undefined); __setSplitLimitsForTests(null); });

  for (const point of ['consumer:prepared', 'publication:prepared'] as const) {
    test(`a part the write keeps, edited at ${point}, refuses source_changed: nothing is written and the edit stays`, () => managedBrain(async ({ engine, ctx, root }) => {
      const { refused, before, firstPart, edited } = await appendWithEditedPart(engine, ctx, root, point);
      expect(refused).toMatchObject({ code: 'source_changed' });
      expect(readFileSync(firstPart, 'utf8')).toBe(edited);
      const after = unit(root, 'notes/big.md');
      expect(after.head).toBe(before.head);
      expect(Object.keys(after.parts)).toEqual(Object.keys(before.parts));
      const name = firstPart.slice(firstPart.lastIndexOf('/') + 1);
      for (const [part, hash] of Object.entries(before.parts)) expect(after.parts[part]).toBe(part === name ? sha(firstPart) : hash);
    }, { databaseUrl, setup }), 120_000);
  }
});
