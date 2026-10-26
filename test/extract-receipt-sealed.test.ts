/**
 * #7620: an extraction's receipt page is born sealed, and never lands in the
 * database ahead of Git.
 *
 * The receipt writer used a bare tx.putPage, so every receipt stayed at
 * chunker_version 0 with no chunks: the remote safe-index probe
 * (hasUnsealedPagesInScope, ops/search.ts) then stamped safe_index_pending
 * on every remote search and query in the source until an operator ran
 * gbrain repair safe-chunks --apply, and the next extraction wrote a new
 * unsealed receipt.
 *
 * Pinned here on both engines, through a real extraction (extract_facts
 * reconciling a facts fence):
 *  - database-only source: the receipt is chunked and sealed in its own write,
 *    and a remote search or query afterwards carries no safe_index_pending;
 *  - git-backed source: the receipt is a declared database-only derive page
 *    (extracts/), so the extraction writes no file and commits nothing, and
 *    the checkout stays clean;
 *  - strict (canonical: git) source: the extraction is not refused, and no
 *    receipt row is written ahead of Git.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SOURCE = 'source-a';
const ENTITY = 'people/alice-example';

function entityBody(): string {
  const fence = renderFactsTable([
    { rowNum: 1, claim: 'Alice Example leads the platform team', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: 'Alice Example joined Acme Example in 2024', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'medium', active: true },
  ]);
  return 'Alice Example works at Acme Example.\n\n' + fence + '\n';
}

const entityMarkdown = () => serializeMarkdown({}, entityBody(), '', { type: 'person', title: 'Alice Example', tags: [] });

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

for (const kind of testBackends()) {
  describe('extract receipts are sealed and never ahead of Git (' + kind + ', #7620)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let root: string | undefined;
    let meta: Record<string, unknown> = {};

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('search.mcp_keyword_only', 'true');
      await engine.setConfig('search.crag_escalation', 'false');
    }, 120_000);

    afterAll(async () => { await close?.(); });

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM facts WHERE source_id = $1', [SOURCE]);
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [SOURCE]);
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]);
      meta = {};
    });

    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    const receipts = () => engine.executeRaw<{ slug: string; chunker_version: number; chunks: number }>(
      `SELECT p.slug, p.chunker_version, (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks
         FROM pages p WHERE p.source_id = $1 AND p.type = 'extract_receipt' AND p.deleted_at IS NULL`, [SOURCE]);

    const remote = (): OperationContext => ({
      engine, config: { engine: kind }, dryRun: false, remote: true, sourceId: SOURCE,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
    } as unknown as OperationContext);

    const degradedStages = () => ((meta.retrieval as { degraded?: Array<{ stage: string }> } | undefined)?.degraded ?? []).map(d => d.stage);

    async function remoteReadsAreNotPending(): Promise<void> {
      for (const name of ['search', 'query']) {
        meta = {};
        await operationsByName[name]!.handler(remote(), { query: 'platform team', expand: false, limit: 5 });
        expect(meta.retrieval).toBeDefined();
        expect(degradedStages()).not.toContain('safe_index_pending');
        expect(degradedStages()).not.toContain('projection_pending');
      }
    }

    test('database-only source: the receipt is chunked and sealed, and a remote search or query afterwards is not safe_index_pending', async () => {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SOURCE]);
      expect((await importFromContent(engine, ENTITY, entityMarkdown(), { sourceId: SOURCE, noEmbed: true })).status).toBe('imported');

      const result = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [ENTITY] });
      expect(result.factsInserted).toBe(2);

      const written = await receipts();
      expect(written).toHaveLength(1);
      expect(written[0]!.slug.startsWith('extracts/')).toBe(true);
      expect(written[0]!.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
      expect(written[0]!.chunks).toBeGreaterThan(0);
      await remoteReadsAreNotPending();
    }, 60_000);

    test('git-backed source: the extraction writes no receipt file and commits nothing, so the checkout stays clean', async () => {
      const checkout = root = mkdtempSync(join(tmpdir(), 'gbrain-receipt-git-'));
      git(checkout, ['init', '-q', '-b', 'main']);
      git(checkout, ['config', 'user.email', 'test@example.com']);
      git(checkout, ['config', 'user.name', 'Test Example']);
      mkdirSync(join(checkout, 'people'), { recursive: true });
      writeFileSync(join(checkout, 'people', 'alice-example.md'), entityMarkdown());
      git(checkout, ['add', 'people/alice-example.md']);
      git(checkout, ['commit', '-q', '-m', 'seed']);
      const head = git(checkout, ['rev-parse', 'HEAD']);
      await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [SOURCE, checkout]);
      expect((await importFromContent(engine, ENTITY, entityMarkdown(), { sourceId: SOURCE, noEmbed: true, sourcePath: 'people/alice-example.md', sourceRoot: checkout })).status).toBe('imported');

      const result = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [ENTITY] });
      expect(result.factsInserted).toBe(2);

      const written = await receipts();
      expect(written).toHaveLength(1);
      expect(written[0]!.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
      expect(written[0]!.chunks).toBeGreaterThan(0);
      expect(existsSync(join(checkout, 'extracts'))).toBe(false);
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(checkout, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      await remoteReadsAreNotPending();
    }, 60_000);

    test('strict source: the extraction is not refused and writes no receipt row ahead of Git', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"canonical":"git"}'::jsonb)`, [SOURCE]);
      await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: entityBody(), timeline: '', frontmatter: {} }, { sourceId: SOURCE });
      const stderr = spyOn(console, 'error');
      try {
        const result = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [ENTITY] });
        expect(result.factsInserted).toBe(2);
        expect(stderr.mock.calls.map(call => String(call[0])).filter(line => line.includes('receipt write failed'))).toEqual([]);
      } finally {
        stderr.mockRestore();
      }
      expect(await receipts()).toEqual([]);
    }, 60_000);
  });
}
