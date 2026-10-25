/**
 * Wave B PR 5 lane 5b: a write over a split page refuses `split_parts_unexpected` before publication when its parts
 * directory holds anything that is not a part file (persistence/split-files.ts `currentParts`).
 *
 * 1. Protects: a file not named NNNN-<sha8>.gbpart, or a subdirectory, in `.<name>.gbparts/` is nobody's part. An append
 *    (which would rewrite parts and remove every unlisted file) and a shrink back to one file (which would remove the
 *    whole directory), and a rewrite of a one-file page beside such a directory (which would empty it), all refuse with that typed code, whose registry fix is read-only (`gbrain doctor --only split_layout --json`):
 *    the head, every part and the entry stay as they were, and the page row keeps its revision.
 * 2. Fails when: the publication deletes the entry as an unlisted part, writes around it, or refuses with an untyped
 *    storage error.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { CODES } from '../src/core/error-registry.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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
const sha = (path: string) => statSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'dir';
const unit = (root: string) => {
  const dir = partsDirFor(join(root, 'notes/big.md'));
  return { head: sha(join(root, 'notes/big.md')), dir: Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(join(dir, name))])) };
};

async function splitPageWith(engine: BrainEngine, ctx: OperationContext, root: string, entry: (dir: string) => void): Promise<string> {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  const first = await put(ctx, 'notes/big', page(lines(0, 80)));
  expect(first).toMatchObject({ state: 'committed' });
  entry(partsDirFor(join(root, 'notes/big.md')));
  return first.revision;
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: a parts directory holding a non-part entry`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  const cases: Array<[string, (dir: string) => void, string[]]> = [
    ['a stray file, then an append', dir => writeFileSync(join(dir, 'notes.txt'), 'kept by hand\n'), lines(0, 84)],
    ['a stray file, then a shrink back to one file', dir => writeFileSync(join(dir, 'notes.txt'), 'kept by hand\n'), lines(0, 4)],
    ['a subdirectory, then an append', dir => mkdirSync(join(dir, 'extra')), lines(0, 84)],
  ];
  for (const [name, entry, body] of cases) {
    test(`${name}: refuses split_parts_unexpected with the split_layout fix; nothing is written or removed`, () => managedBrain(async ({ engine, ctx, root }) => {
      const revision = await splitPageWith(engine, ctx, root, entry);
      const before = unit(root);
      const refused = await put(ctx, 'notes/big', page(body), revision).then(receipt => receipt, (error: unknown) => error) as Record<string, any>;
      expect(refused).toMatchObject({ code: 'split_parts_unexpected' });
      expect(CODES.split_parts_unexpected.fix.argv).toEqual(['gbrain', 'doctor', '--only', 'split_layout', '--json']);
      expect(unit(root)).toEqual(before);
      expect(existsSync(join(partsDirFor(join(root, 'notes/big.md')), name.includes('subdirectory') ? 'extra' : 'notes.txt'))).toBe(true);
      expect((await engine.readPageSnapshot('notes/big', { sourceId: 'default' }))!.revision).toBe(revision);
    }, { databaseUrl, setup }), 120_000);
  }

  test('a one-file page beside a parts directory holding a stray file: a rewrite refuses split_parts_unexpected and the stray file stays', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
    const first = await put(ctx, 'notes/big', page(lines(0, 4)));
    expect(first).toMatchObject({ state: 'committed' });
    const dir = partsDirFor(join(root, 'notes/big.md'));
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'kept by hand\n');
    const before = unit(root);
    const refused = await put(ctx, 'notes/big', page(lines(0, 6)), first.revision).then(receipt => receipt, (error: unknown) => error) as Record<string, any>;
    expect(refused).toMatchObject({ code: 'split_parts_unexpected' });
    expect(unit(root)).toEqual(before);
  }, { databaseUrl, setup }), 120_000);
});
