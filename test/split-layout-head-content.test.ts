/**
 * Wave B PR 5 lane 5b (review C1): no page publication writes a split page head back as the page. Content whose
 * frontmatter has a top-level `gbrain_parts` key refuses `split_head_content` at the door
 * (persistence/split-files.ts `splitPublicationTargets`, `mayTakeSplitLayout`), whoever submits it.
 *
 * 1. Protects: a managed file repair that reads the head raw and republishes it with a frontmatter edit (bound to the
 *    page file's hash, so it passes the repair's own split-aware check and reaches the door), a put_page of
 *    the head's text at its own page, and a put_page of the head's text at another page path all refuse: the head, every
 *    part and the stored body stay as they were.
 * 2. Fails when: the head is published as the page (the page becomes its lead and notice and every part is removed), or
 *    a head is written as a page file anywhere.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import { __setSplitLimitsForTests, pageFileSha256, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const lines = Array.from({ length: 120 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const content = `---\ntype: note\ntitle: Split example\n---\n\n${lines.join('\n')}\n`;
/** Option B: only a git-canonical source lays a page out as a split unit, so every fixture source is strict (canonical = git). */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const put = (ctx: OperationContext, slug: string, text: string, expectedRevision?: string) => operations.find(o => o.name === 'put_page')!.handler(ctx,
  { slug, content: text, request_id: randomUUID(), wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const refusal = (promise: Promise<unknown>) => promise.then(value => value, (error: unknown) => error) as Promise<Record<string, any>>;

/** The head, every part and the stored body of notes/big. */
async function state(engine: BrainEngine, root: string) {
  const head = join(root, 'notes/big.md');
  const dir = partsDirFor(head);
  const [row] = await engine.executeRaw<{ body: string | null; bytes: string | number | null }>("SELECT content_hash AS body, body_bytes AS bytes FROM pages WHERE source_id='default' AND slug='notes/big'");
  return { head: sha(readFileSync(head)), parts: readdirSync(dir).sort().map(name => [name, sha(readFileSync(join(dir, name)))]), row };
}

async function splitPage(engine: BrainEngine, ctx: OperationContext, root: string) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '4096');
  const first = await put(ctx, 'notes/big', content);
  expect(first).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
  const head = readFileSync(join(root, 'notes/big.md'), 'utf8');
  expect(head).toContain('\ngbrain_parts:\n');
  return { head, revision: first.revision as string, before: await state(engine, root) };
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: a head is never published as a page`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  test('a managed file repair of the head (a frontmatter edit) refuses split_head_content; the head, parts and body stay', () => managedBrain(async ({ engine, ctx, root }) => {
    const { head, before } = await splitPage(engine, ctx, root);
    const repaired = head.replace('title: Split example', 'title: Split example repaired');
    const pageFile = pageFileSha256(join(root, 'notes/big.md'));
    if (pageFile.hold) throw new Error(pageFile.hold.message);
    const snapshot = await engine.readPageSnapshot('notes/big', { sourceId: 'default', includeDeleted: true });
    const prepared = await prepareRepairPublication(engine, { sourceId: 'default', slug: 'notes/big', sourcePath: 'notes/big.md', path: 'notes/big.md', root, content: repaired,
      snapshot, base: snapshot, ...await repairScreenConfig(engine, 'default') });
    expect(prepared.status).toBe('ready');
    const refused = await refusal(submitManagedFileRepair(ctx, { sourceId: 'default', requestId: randomUUID(), slug: 'notes/big', path: 'notes/big.md', sourcePath: 'notes/big.md',
      content: repaired, beforeHash: pageFile.sha256, resultDigest: (prepared as { digest: string }).digest, expected_revision: snapshot!.revision, noEmbed: true }));
    expect(refused).toMatchObject({ code: 'split_head_content' });
    expect(await state(engine, root)).toEqual(before);
  }, { databaseUrl, setup }), 120_000);

  test('a put of the head text at its own page refuses split_head_content; the head, parts and body stay', () => managedBrain(async ({ engine, ctx, root }) => {
    const { head, revision, before } = await splitPage(engine, ctx, root);
    expect(await refusal(put(ctx, 'notes/big', head, revision))).toMatchObject({ code: 'split_head_content' });
    expect(await state(engine, root)).toEqual(before);
  }, { databaseUrl, setup }), 120_000);

  test('a put of the head text at another page path refuses split_head_content and writes no file', () => managedBrain(async ({ engine, ctx, root }) => {
    const { head, before } = await splitPage(engine, ctx, root);
    expect(await refusal(put(ctx, 'notes/copy', head))).toMatchObject({ code: 'split_head_content' });
    expect(existsSync(join(root, 'notes/copy.md'))).toBe(false);
    expect(await state(engine, root)).toEqual(before);
  }, { databaseUrl, setup }), 120_000);
});
