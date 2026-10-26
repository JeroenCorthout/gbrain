/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): the managed readers that compare or import a canonical file
 * outside the publication door.
 * 1. Protects: sources reconcile (readReconcileState) refuses a split page head with a typed refusal
 *    (detail split_page_unsupported, or the head's hold code) that routes to gbrain pages split-storage, instead of
 *    reconciling the head (lead + notice + gbrain_parts) against the whole stored page; the drift audit and the conflict
 *    pile classify such a page split_page_unsupported with the split-storage route (--resolve-head for an edited head);
 *    a managed gbrain import of a healthy split head passes it by (sync owns it) and writes nothing.
 * 2. Fails when: the head is parsed as the page file (false drift, a dead-end reconcile, a review_required verdict) or
 *    the import publishes the head as the page.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). KB-sized limits through
 *    __setSplitLimitsForTests; managed brains through managedBrain on a git-canonical source (canonical: git, the only
 *    kind whose door lays out a split page) + put_page over the threshold.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { readReconcileState } from '../src/core/persistence/reconcile-state.ts';
import { auditCanonicalSource } from '../src/core/persistence/reconcile-audit.ts';
import { driftClass } from '../src/core/persistence/drift-conflicts.ts';
import { importManagedFile } from '../src/core/persistence/import-mutations.ts';
import { __setSplitLimitsForTests, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/big-example';
const op = (name: string) => operations.find(o => o.name === name)!;
const lines = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of the split page body, long enough to fill a part.`);
const content = `---\ntype: note\ntitle: Split example\n---\n\n${lines.join('\n')}\n`;
/** A git-canonical source (canonical: git): its door lays out a page over the threshold as a head plus parts. */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};

/** A committed split page at SLUG; returns the head path. */
async function splitPage(engine: BrainEngine, ctx: OperationContext, root: string): Promise<string> {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  expect(await op('put_page').handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
  const head = join(root, `${SLUG}.md`);
  expect(readdirSync(partsDirFor(head)).length).toBeGreaterThan(1);
  return head;
}
/** The head and every part file, by name, as they are on disk. */
const layout = (head: string) => ({ head: readFileSync(head, 'utf8'),
  parts: Object.fromEntries(readdirSync(partsDirFor(head)).sort().map(name => [name, readFileSync(join(partsDirFor(head), name), 'utf8')])) });
/** Edits the head's lead (its body), which its manifest hashes: the hold split_head_modified. */
const editLead = (head: string) => writeFileSync(head, readFileSync(head, 'utf8').replace('Line 0000 of the split page body', 'Line 0000 of the edited split page body'));

for (const backend of testBackends()) describe(`[${backend}] split git layout: managed readers of the canonical file`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { __setSplitLimitsForTests(null); });

  test('sources reconcile refuses a split head with a typed refusal that routes to pages split-storage', () => managedBrain(async ({ engine, ctx, root }) => {
    const head = await splitPage(engine, ctx, root);
    await expect(readReconcileState(engine, 'default', SLUG)).rejects.toMatchObject({ code: 'source_changed', detail: 'split_page_unsupported',
      suggestion: expect.stringContaining(`gbrain pages split-storage ${SLUG} --source default`),
      fix: { argv: ['gbrain', 'pages', 'split-storage', SLUG, '--source', 'default', '--json'] } });
    editLead(head);
    await expect(readReconcileState(engine, 'default', SLUG)).rejects.toMatchObject({ code: 'source_changed', detail: 'split_head_modified',
      suggestion: expect.stringContaining(`gbrain pages split-storage ${SLUG} --source default --resolve-head keep-edit|discard`) });
  }, { databaseUrl, setup }), 120_000);

  test('the drift audit and the conflict class name a split head split_page_unsupported with the split-storage route', () => managedBrain(async ({ engine, ctx, root }) => {
    const head = await splitPage(engine, ctx, root);
    expect(await driftClass(engine, 'default', SLUG)).toBe('split_page_unsupported');
    editLead(head);
    const audit = await auditCanonicalSource(engine, 'default', { classify: true });
    expect(audit.findings).toEqual([expect.objectContaining({ slug: SLUG, reason: 'source_changed', classification: 'split_page_unsupported',
      suggestion: expect.stringContaining(`gbrain pages split-storage ${SLUG} --source default --resolve-head keep-edit|discard`) })]);
    expect(audit.findings[0]!.drift_paths).toBeUndefined();
    expect(audit.classified).toMatchObject({ split_page_unsupported: 1, review_required: 0, error: 0 });
    expect(await driftClass(engine, 'default', SLUG)).toBe('split_page_unsupported');
  }, { databaseUrl, setup }), 120_000);

  test('a managed import of a healthy split head passes it by; the head, its parts and the page row are unchanged', () => managedBrain(async ({ engine, ctx, root }) => {
    const head = await splitPage(engine, ctx, root);
    const before = layout(head);
    const row = async () => (await engine.executeRaw<{ compiled_truth: string; revision: string }>(
      "SELECT compiled_truth, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1", [SLUG]))[0];
    const stored = await row();
    expect(await importManagedFile(engine, head, `${SLUG}.md`, { sourceId: 'default', noEmbed: true })).toMatchObject({ slug: SLUG, status: 'skipped' });
    expect(layout(head)).toEqual(before);
    expect(await row()).toEqual(stored);
    editLead(head);
    await expect(importManagedFile(engine, head, `${SLUG}.md`, { sourceId: 'default', noEmbed: true })).rejects.toMatchObject({ code: 'split_head_modified' });
    expect(await row()).toEqual(stored);
  }, { databaseUrl, setup }), 120_000);
});
