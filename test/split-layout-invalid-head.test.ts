/**
 * Wave B PR 5 lane 5b: a split page head whose parts do not verify is never written over as an ordinary file.
 * persistence/split-files.ts `readSplitHead` tells three readings apart: an ordinary file, a verified split page, and a
 * declared split head that failed verification (`split_invalid`); prepareFileTarget refuses the last, its split code as
 * the reason, before any comparison or removal planning.
 *
 * 1. Protects: an older gbrain imported the short head as the page (C3); then one part goes missing, or a part or the
 *    head body is edited by hand. A write of the stored (short) page refuses as drift (`source_changed`, the receipt's
 *    `error_detail.origin` naming `split_page_incomplete` or `split_head_modified`) and changes nothing: the head, every surviving part and the human edit stay. A sync after the
 *    refusal deletes nothing either, and once the part is restored sync rebuilds the whole page (the C3 self-heal).
 * 2. Fails when: the raw head is compared with the stored head and matches, so the write commits, turns the head into an
 *    ordinary short file and removes every part (the human edit included), which also ends the self-heal.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor } from '../src/core/split-layout/index.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { writeSplitPage, type WrittenSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of a synthetic acme-example page body, long enough to fill a part.`).join('\n');
const page = `---\ntype: note\ntitle: Split example\n---\n\n${body}\n`;
const SLUG = 'notes/probe';
const HUMAN = 'UNCOMMITTED HUMAN EDIT\n';
type Fault = 'missing part' | 'edited part' | 'edited head';

/** Every file of the layout: the head and each part in the parts directory, by name. */
function layout(root: string): Record<string, string> {
  const head = join(root, `${SLUG}.md`), dir = partsDirFor(head);
  return { head: readFileSync(head, 'utf8'), ...Object.fromEntries((existsSync(dir) ? readdirSync(dir) : []).map(name => [name, readFileSync(join(dir, name), 'utf8')])) };
}

async function write(engine: BrainEngine, ctx: OperationContext, content: string, expected_revision: string): Promise<{ code: string | null; origin: unknown }> {
  const request_id = randomUUID();
  let code: string | null = null;
  try { await operations.find(op => op.name === 'put_page')!.handler(ctx, { slug: SLUG, content, expected_revision, request_id, wait_ms: 30_000 }); }
  catch (error) { if (!(error instanceof OperationError)) throw error; code = error.code; }
  const [row] = await engine.executeRaw<{ error_detail: unknown }>('SELECT error_detail FROM persistence_requests WHERE request_id::text = $1 OR client_request_id::text = $1', [request_id]);
  const detail = typeof row?.error_detail === 'string' ? JSON.parse(row.error_detail) : row?.error_detail;
  return { code, origin: (detail as { origin?: unknown } | null)?.origin ?? null };
}

const sync = (engine: BrainEngine) => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, full: true });

for (const backend of testBackends()) describe(`[${backend}] split git layout: a declared head that fails verification is refused, never rewritten`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  for (const fault of ['missing part', 'edited part', 'edited head'] as Fault[]) {
    let written: WrittenSplitPage;
    test(`older-binary head import, then ${fault}: the write refuses and changes nothing; sync deletes nothing${fault === 'edited head' ? '' : ' and heals once the part is restored'}`, () => managedBrain(async ({ engine, ctx, root }) => {
      const head = join(root, `${SLUG}.md`);
      const before = layout(root);
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      const parsed = parseHead(readFileSync(head, 'utf8'));
      if (!parsed || 'error' in parsed) throw new Error('fixture head does not parse');
      const retitled = parsed.frontmatterWithoutParts.replace('title: Split example', 'title: Retitled example') + parsed.headBody;
      expect(await write(engine, ctx, retitled, snapshot.revision)).toEqual({ code: 'source_changed', origin: fault === 'edited head' ? 'split_head_modified' : 'split_page_incomplete' });
      expect(layout(root)).toEqual(before);
      if (fault === 'edited part') expect(Object.values(layout(root)).some(text => text.endsWith(HUMAN))).toBe(true);

      await sync(engine);
      expect(layout(root)).toEqual(before);
      if (fault === 'edited head') return;

      const part = written.parts[2]!;
      writeFileSync(join(root, part.rel), part.content);
      await sync(engine);
      const healed = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      expect(healed.page.compiled_truth).toContain('Line 0079');
      expect(Object.keys(healed.page.frontmatter ?? {})).not.toContain('gbrain_parts');
      expect(layout(root).head).toBe(before.head);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      __setSplitLimitsForTests(LIMITS);
      await engine.setConfig('sync.max_file_bytes', '2048');
      written = await writeSplitPage(root, `${SLUG}.md`, page);
      writeFileSync(join(root, '.gitignore'), '\n');
      durableGitRepo(root, ['.gitignore', 'notes']);
      const head = join(root, `${SLUG}.md`);
      if (fault === 'edited head') writeFileSync(head, readFileSync(head, 'utf8').replace('Line 0000', 'Line 0000 edited by hand'));
      await importFromContent(engine, SLUG, readFileSync(head, 'utf8'), { sourceId: 'default', sourcePath: `${SLUG}.md`, noEmbed: true });
      const part = join(root, written.parts[2]!.rel);
      if (fault === 'missing part') rmSync(part);
      if (fault === 'edited part') writeFileSync(part, `${readFileSync(part, 'utf8')}${HUMAN}`);
    } }), 120_000);
  }

  test('a remote (MCP) write over a split head with a missing part refuses with the split reason on its envelope', () => managedBrain(async ({ engine, root }) => {
    const before = layout(root);
    const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
    const parsed = parseHead(readFileSync(join(root, `${SLUG}.md`), 'utf8'));
    if (!parsed || 'error' in parsed) throw new Error('fixture head does not parse');
    const content = parsed.frontmatterWithoutParts.replace('title: Split example', 'title: Retitled example') + parsed.headBody;
    const result = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content, expected_revision: snapshot.revision, request_id: randomUUID(), wait_ms: 30_000 },
      { remote: true, transport: 'stdio', sourceId: 'default' });
    const envelope = JSON.parse(result.content.map(item => item.text).join('')) as { code: string; reason?: string; detail?: string; suggestion: string };
    expect(result.isError).toBe(true);
    expect({ code: envelope.code, reason: envelope.reason, detail: envelope.detail }).toEqual({ code: 'source_changed', reason: 'split_page_incomplete', detail: 'file_database_drift' });
    expect(envelope.suggestion).toContain('Restore the part files');
    expect(layout(root)).toEqual(before);
  }, { databaseUrl, setup: async ({ engine, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig('sync.max_file_bytes', '2048');
    const written = await writeSplitPage(root, `${SLUG}.md`, page);
    writeFileSync(join(root, '.gitignore'), '\n');
    durableGitRepo(root, ['.gitignore', 'notes']);
    await importFromContent(engine, SLUG, readFileSync(join(root, `${SLUG}.md`), 'utf8'), { sourceId: 'default', sourcePath: `${SLUG}.md`, noEmbed: true });
    rmSync(join(root, written.parts[2]!.rel));
  } }), 120_000);
});
