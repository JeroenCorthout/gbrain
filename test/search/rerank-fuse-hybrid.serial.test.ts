/**
 * GBRA-162: `search.reranker.fuse` / `search.reranker.document` through bare
 * hybridSearch on PGLite with a stub reranker (the main RRF path, not the
 * keyword-only fallback): replace is byte-identical to the unset default, rrf
 * returns the fused head order with the fused value as the returned score,
 * fail-open is unchanged, titled documents reach the reranker, and autocut
 * keeps cutting on the provider score.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests, RerankError, type RerankInput, type RerankResult } from '../../src/core/ai/gateway.ts';
import { scoresFollowRank } from '../../src/core/search/score-contract.ts';
import { buildScoreDetails } from '../../src/core/search/explain-formatter.ts';
import { RERANK_FUSE_K } from '../../src/core/search/rerank-fuse.ts';
import type { HybridSearchMeta, SearchOpts, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;
let prevHome: string | undefined;
let home: string;
const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));
const rrf = (a: number, b: number) => 1 / (RERANK_FUSE_K + a) + 1 / (RERANK_FUSE_K + b);

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-rerank-fuse-home-'));
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages: Array<[string, string, string, Record<string, unknown>]> = [
    ['notes/alpha', 'Alpha Note', 'alpha keyword content one', {}],
    ['notes/beta', 'Beta Note', 'alpha keyword content two', {}],
    ['notes/gamma', 'Gamma Note', 'alpha keyword content three', {}],
    ['notes/delta', 'Delta Note', 'alpha keyword content four', {}],
  ];
  for (const [slug, title, text, frontmatter] of pages) {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: text, frontmatter });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${text} chunk`, chunk_source: 'compiled_truth' }]);
  }
  // putPage leaves effective_date to the import pipeline; stamp the document date the row will carry.
  await engine.executeRaw("UPDATE pages SET effective_date = '2024-03-05', effective_date_source = 'date' WHERE slug = 'notes/beta'");
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => FAKE_EMB) }) as any);
});

afterEach(async () => {
  await engine.unsetConfig('search.reranker.fuse');
  await engine.unsetConfig('search.reranker.document');
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** Reverse the incoming order; scores by reranker rank. */
const reverse = (scores: number[]) => async (input: RerankInput): Promise<RerankResult[]> =>
  input.documents.map((_, i) => ({ index: input.documents.length - 1 - i, relevanceScore: scores[i] ?? 0.05 }));
const search = (rerankerFn: (i: RerankInput) => Promise<RerankResult[]>, extra: SearchOpts = {}) =>
  hybridSearch(engine, 'alpha keyword', { limit: 10, autocut: false, reranker: { enabled: true, topNIn: 30, topNOut: null, rerankerFn }, ...extra });
const firstPass = async () => (await hybridSearch(engine, 'alpha keyword', { limit: 10, autocut: false })).map(r => r.slug);
const strip = (rows: SearchResult[]) => JSON.stringify(rows);

describe('fuse replace', () => {
  test('setting replace and chunk is byte-identical to leaving them unset', async () => {
    const unset = await search(reverse([0.9, 0.8, 0.7, 0.6]));
    await engine.setConfig('search.reranker.fuse', 'replace');
    await engine.setConfig('search.reranker.document', 'chunk');
    const replace = await search(reverse([0.9, 0.8, 0.7, 0.6]));
    expect(strip(replace)).toBe(strip(unset));
    expect(unset.some(r => r.rerank_fuse !== undefined)).toBe(false);
    expect(unset.map(r => r.slug)).toEqual([...(await firstPass())].reverse());
  });
});

describe('fuse rrf', () => {
  test('the final order is RRF of the reranker order and the first-pass order; score is the fused value', async () => {
    const fp = await firstPass();
    expect(fp.length).toBe(4);
    await engine.setConfig('search.reranker.fuse', 'rrf');
    const out = await search(reverse([0.9, 0.8, 0.7, 0.6]));
    // Reversed: fp[3] is reranker #1 ... fp[0] is #4. Ties (#4+#1 vs #1+#4) keep first-pass order.
    expect(out.map(r => r.slug)).toEqual([fp[0], fp[3], fp[1], fp[2]]);
    expect(out.map(r => [r.rerank_fuse!.rerank_rank, r.rerank_fuse!.first_pass_rank])).toEqual([[4, 1], [1, 4], [3, 2], [2, 3]]);
    expect(out.map(r => r.rerank_score)).toEqual([0.6, 0.9, 0.7, 0.8]);
    const returned = scoresFollowRank(out);
    expect(returned.map(r => r.score)).toEqual([rrf(4, 1), rrf(1, 4), rrf(3, 2), rrf(2, 3)]);
    for (let i = 1; i < returned.length; i++) expect(returned[i].score).toBeLessThanOrEqual(returned[i - 1].score);
    expect(buildScoreDetails(out[0]).rerank).toMatchObject({ state: 'applied', score: 0.6, fuse: { mode: 'rrf', k: 60, rerank_rank: 4, first_pass_rank: 1 } });
  });

  test('a failing reranker fails open exactly as in replace mode (first-pass order, rerank_failed, no fuse stamps)', async () => {
    const fp = await firstPass();
    await engine.setConfig('search.reranker.fuse', 'rrf');
    let meta: HybridSearchMeta | undefined;
    const out = await search(async () => { throw new RerankError('boom', 'network'); }, { onMeta: (m) => { meta = m; } });
    expect(out.map(r => r.slug)).toEqual(fp);
    expect(out.some(r => r.rerank_fuse !== undefined || r.rerank_score !== undefined)).toBe(false);
    expect(meta?.degraded?.some(d => d.stage === 'rerank_failed')).toBe(true);
  });

  test('autocut still cuts on the provider score: the same rows survive as in replace mode', async () => {
    const cliff = reverse([0.95, 0.9, 0.2, 0.1]);
    const replaced = await search(cliff, { autocut: true });
    await engine.setConfig('search.reranker.fuse', 'rrf');
    const fused = await search(cliff, { autocut: true });
    expect(replaced.length).toBe(2);
    expect(fused.map(r => r.slug)).toEqual(replaced.map(r => r.slug));
    expect(fused.every(r => r.rerank_score! >= 0.9)).toBe(true);
  });
});

describe('document titled', () => {
  test('the reranker reads "<title>\\n<chunk>", dated when the page carries a document date', async () => {
    await engine.setConfig('search.reranker.document', 'titled');
    let docs: string[] = [];
    await search(async (input) => { docs = input.documents; return input.documents.map((_, i) => ({ index: i, relevanceScore: 0.9 - i * 0.1 })); });
    expect(docs.length).toBe(4);
    expect(docs).toContain('Alpha Note\nalpha keyword content one chunk');
    expect(docs).toContain('Beta Note (2024-03-05)\nalpha keyword content two chunk');
  });
});
