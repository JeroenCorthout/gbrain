/**
 * GBRA-162: `search.reranker.fuse` and `search.reranker.document`, pure.
 * Fusion order, replace mode unchanged, fail-open unchanged under rrf, the
 * titled document, rank priors and the score contract on fused values, and
 * what autocut does in rrf mode.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyReranker, type RerankerOpts } from '../../src/core/search/rerank.ts';
import { RERANK_FUSE_K, fuseRerankedHead, normalizeRerankDocument, normalizeRerankFuse, rerankDocument, rerankOrderScore } from '../../src/core/search/rerank-fuse.ts';
import { applyRankPriors, PERSON_PRIOR } from '../../src/core/search/rank-priors.ts';
import { scoresFollowRank } from '../../src/core/search/score-contract.ts';
import { applyAutocut } from '../../src/core/search/autocut.ts';
import { buildScoreDetails, formatResultExplain } from '../../src/core/search/explain-formatter.ts';
import { knobsHash, loadOverridesFromConfig, resolveSearchMode, MODE_BUNDLES, KNOB_CONFIG_KEY } from '../../src/core/search/mode.ts';
import { RerankError, type RerankInput, type RerankResult } from '../../src/core/ai/gateway.ts';
import type { SearchResult } from '../../src/core/types.ts';

const row = (slug: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  slug, page_id: 1, title: slug.toUpperCase(), type: 'note', chunk_text: `text of ${slug}`, chunk_source: 'compiled_truth',
  chunk_id: 1, chunk_index: 0, score: 0.5, stale: false, source_id: 'default', ...extra,
});
const rows = (...slugs: string[]) => slugs.map((s, i) => row(s, { score: 1 - i * 0.1 }));
const fixed = (order: Array<[number, number]>) => async (): Promise<RerankResult[]> => order.map(([index, relevanceScore]) => ({ index, relevanceScore }));
const opts = (rerankerFn: RerankerOpts['rerankerFn'], extra: Partial<RerankerOpts> = {}): RerankerOpts => ({ enabled: true, topNIn: 30, topNOut: null, rerankerFn, ...extra });
const rrf = (rerankRank: number, firstPassRank: number) => 1 / (RERANK_FUSE_K + rerankRank) + 1 / (RERANK_FUSE_K + firstPassRank);
// First-pass a..e; the reranker says e, d, a, c, b.
const REVERSEISH = fixed([[4, 0.9], [3, 0.8], [0, 0.7], [2, 0.6], [1, 0.5]]);

beforeAll(async () => {
  const { configureGateway } = await import('../../src/core/ai/gateway.ts');
  configureGateway({ env: { VOYAGE_API_KEY: 'test-key' } });
});
afterAll(async () => {
  const { resetGateway } = await import('../../src/core/ai/gateway.ts');
  resetGateway();
});

describe('knobs', () => {
  test('parse, defaults, config keys', () => {
    expect(normalizeRerankFuse(' RRF ')).toBe('rrf');
    expect(normalizeRerankFuse('borda')).toBeUndefined();
    expect(normalizeRerankDocument('titled')).toBe('titled');
    expect(normalizeRerankDocument('page')).toBeUndefined();
    for (const b of Object.values(MODE_BUNDLES)) expect([b.reranker_fuse, b.reranker_document]).toEqual(['replace', 'chunk']);
    expect([KNOB_CONFIG_KEY.reranker_fuse, KNOB_CONFIG_KEY.reranker_document]).toEqual(['search.reranker.fuse', 'search.reranker.document']);
    expect(loadOverridesFromConfig({ 'search.reranker.fuse': 'rrf', 'search.reranker.document': 'titled' })).toMatchObject({ reranker_fuse: 'rrf', reranker_document: 'titled' });
    expect(loadOverridesFromConfig({ 'search.reranker.fuse': 'nope' }).reranker_fuse).toBeUndefined();
  });
  test('the defaults hash like master; each non-default value re-keys the cache', () => {
    const base = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    expect(knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { reranker_fuse: 'replace', reranker_document: 'chunk' } }))).toBe(base);
    const fused = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { reranker_fuse: 'rrf' } }));
    const titled = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { reranker_document: 'titled' } }));
    expect(new Set([base, fused, titled]).size).toBe(3);
  });
});

describe('fuse rrf order', () => {
  test('RRF of reranker order and first-pass order, k=60, 1-based ranks', async () => {
    const out = await applyReranker('q', rows('a', 'b', 'c', 'd', 'e'), opts(REVERSEISH, { fuse: 'rrf' }));
    expect(out.map(r => r.slug)).toEqual(['a', 'e', 'd', 'b', 'c']);
    expect(out.map(r => [r.rerank_fuse!.rerank_rank, r.rerank_fuse!.first_pass_rank])).toEqual([[3, 1], [1, 5], [2, 4], [5, 2], [4, 3]]);
    expect(out.map(r => r.rerank_fuse!.score)).toEqual([rrf(3, 1), rrf(1, 5), rrf(2, 4), rrf(5, 2), rrf(4, 3)]);
    expect(out.map(r => r.rerank_score)).toEqual([0.7, 0.9, 0.8, 0.5, 0.6]);
    expect(out.map(r => r.reranker_delta)).toEqual([0, 3, 1, -2, -2]);
    expect(Math.max(...out.map(r => r.rerank_fuse!.score))).toBeLessThanOrEqual(2 / 61);
  });
  test('ties keep the incoming (first-pass) order', async () => {
    const out = await applyReranker('q', rows('x', 'y'), opts(fixed([[1, 0.9], [0, 0.1]]), { fuse: 'rrf' }));
    expect(out[0].rerank_fuse!.score).toBe(out[1].rerank_fuse!.score);
    expect(out.map(r => r.slug)).toEqual(['x', 'y']);
  });
  test('the unreranked tail and rows the reranker dropped keep their places after the fused head', async () => {
    const out = await applyReranker('q', rows('a', 'b', 'c', 'd'), opts(fixed([[1, 0.9]]), { fuse: 'rrf', topNIn: 3 }));
    expect(out.map(r => r.slug)).toEqual(['b', 'a', 'c', 'd']);
    expect(out.slice(1).every(r => r.rerank_fuse === undefined && r.rerank_score === undefined)).toBe(true);
  });
  test('each head row is ranked once (a collapsed pool fuses over its own positions)', () => {
    const head = rows('a', 'b', 'c');
    const fused = fuseRerankedHead([head[2], head[0], head[1]], new Map(head.map((r, i) => [r, i])));
    expect(fused.map(r => r.rerank_fuse!.first_pass_rank).sort()).toEqual([1, 2, 3]);
    expect(fused.map(r => r.rerank_fuse!.rerank_rank).sort()).toEqual([1, 2, 3]);
  });
});

describe('fuse replace is unchanged', () => {
  test('omitted and replace give the same rows and the same documents as before the knob', async () => {
    const docs: string[][] = [];
    const fn = async (input: RerankInput) => { docs.push(input.documents); return REVERSEISH(); };
    const a = await applyReranker('q', rows('a', 'b', 'c', 'd', 'e'), opts(fn));
    const b = await applyReranker('q', rows('a', 'b', 'c', 'd', 'e'), opts(fn, { fuse: 'replace', document: 'chunk' }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.map(r => [r.slug, r.rerank_score, r.reranker_delta])).toEqual([['e', 0.9, 4], ['d', 0.8, 2], ['a', 0.7, -2], ['c', 0.6, -1], ['b', 0.5, -3]]);
    expect(a.some(r => 'rerank_fuse' in r)).toBe(false);
    expect(docs[1]).toEqual(docs[0]);
    expect(docs[0]).toEqual(['text of a', 'text of b', 'text of c', 'text of d', 'text of e']);
  });
});

describe('fail-open is unchanged under rrf', () => {
  for (const [name, fn] of [
    ['provider error', async () => { throw new RerankError('boom', 'network'); }],
    ['timeout', async () => { throw new RerankError('slow', 'timeout'); }],
    ['no key (skipped)', async () => { throw new RerankError('no key', 'no_key'); }],
    ['empty result set', async () => []],
  ] as Array<[string, RerankerOpts['rerankerFn']]>) {
    test(name, async () => {
      const input = rows('a', 'b', 'c');
      const before = JSON.stringify(input);
      const out = await applyReranker('q', input, opts(fn, { fuse: 'rrf', onFailure: () => {}, onSkip: () => {}, onPassThrough: () => {} }));
      expect(out).toBe(input);
      expect(JSON.stringify(out)).toBe(before);
    });
  }
});

describe('document titled', () => {
  test('"<title>\\n<chunk>", with the document date when the row carries one', async () => {
    const docs: string[] = [];
    const input = [
      row('a', { title: 'Alpha Page', chunk_text: 'alpha body' }),
      row('b', { title: 'Beta Page', chunk_text: 'beta body', effective_date: '2024-03-05', effective_date_source: 'date' }),
      row('c', { title: 'Gamma Page', chunk_text: 'gamma body', effective_date: '2024-01-01', effective_date_source: 'created' }),
      row('d', { title: 'Delta Page', chunk_text: '' }),
    ];
    await applyReranker('q', input, opts(async (i: RerankInput) => { docs.push(...i.documents); return [{ index: 0, relevanceScore: 1 }]; }, { document: 'titled' }));
    expect(docs).toEqual(['Alpha Page\nalpha body', 'Beta Page (2024-03-05)\nbeta body', 'Gamma Page\ngamma body', 'Delta Page']);
  });
  test('still capped like a chunk document', async () => {
    let doc = '';
    await applyReranker('q', [row('a', { title: 'T', chunk_text: 'x'.repeat(20_000) })], opts(async (i: RerankInput) => { doc = i.documents[0]; return [{ index: 0, relevanceScore: 1 }]; }, { document: 'titled' }));
    expect(doc.startsWith('T\nxxx')).toBe(true);
    expect(doc.length).toBeLessThanOrEqual(6000);
  });
  test('chunk mode is the old expression', () => {
    expect(rerankDocument(row('a', { chunk_text: '' }), 'chunk')).toBe('A');
    expect(rerankDocument(row('a'), undefined)).toBe('text of a');
  });
});

describe('rank priors and the score contract on fused values', () => {
  const query = 'API startup that automates freight invoices';
  async function fusedList() {
    // First-pass: person, company, note, company2, person2; the reranker agrees.
    const input = [
      row('people/mara-example', { type: 'person', title: 'Mara Example' }),
      row('companies/acme-example', { type: 'company' }),
      row('notes/freight', { type: 'note' }),
      row('companies/beta-example', { type: 'company' }),
      row('people/ola-example', { type: 'person', title: 'Ola Example' }),
    ];
    return applyReranker(query, input, opts(fixed([[0, 0.9], [1, 0.8], [2, 0.7], [3, 0.6], [4, 0.5]]), { fuse: 'rrf' }));
  }
  test('priors multiply the fused value, demote only, and score is that value, non-increasing', async () => {
    const fused = await fusedList();
    const before = fused.map(r => r.slug);
    const out = applyRankPriors(fused, query);
    for (const r of out.filter(x => x.rank_prior)) expect(r.rank_score).toBe(r.rerank_fuse!.score * PERSON_PRIOR);
    for (const r of out) {
      const moved = out.indexOf(r) - before.indexOf(r.slug);
      if (r.rank_prior) expect(moved).toBeGreaterThanOrEqual(0); else expect(moved).toBeLessThanOrEqual(0);
    }
    expect(out[0].slug).toBe('companies/acme-example');
    const values = out.map(r => r.rank_score ?? rerankOrderScore(r)!);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    const scored = scoresFollowRank(out);
    expect(scored.map(r => r.score)).toEqual(values);
    expect(scored.map(r => r.rerank_score)).toEqual(out.map(r => r.rerank_score));
    expect(scored.map(r => r.fused_score)).toEqual(out.map(r => r.score));
  });
  test('relational pins and rows without a rerank score keep their slots', async () => {
    const fused = await fusedList();
    const pinned = { ...fused[0], relational_pinned: true as const };
    const alias = row('people/zed-example', { type: 'person', alias_hit: true });
    const out = applyRankPriors([pinned, alias, ...fused.slice(1)], query);
    expect(out[0].slug).toBe(pinned.slug);
    expect(out[1].slug).toBe('people/zed-example');
    const scored = scoresFollowRank(out);
    for (let i = 1; i < scored.length; i++) expect(scored[i].score).toBeLessThanOrEqual(scored[i - 1].score);
  });
});

describe('autocut in rrf mode', () => {
  // First-pass a, b, c, d. Provider: c 0.95, d 0.9, then a cliff to a 0.2, b 0.1.
  const provider = fixed([[2, 0.95], [3, 0.9], [0, 0.2], [1, 0.1]]);
  const cut = (list: SearchResult[]) => applyAutocut(list, x => x.rerank_score, { enabled: true, jumpRatio: 0.2, minKeep: 1, minTopScore: 0.35 }).kept;
  test('cuts on the provider rerank_score: the same rows survive as in replace mode, in fused order', async () => {
    const replaced = await applyReranker('q', rows('a', 'b', 'c', 'd'), opts(provider));
    const fused = await applyReranker('q', rows('a', 'b', 'c', 'd'), opts(provider, { fuse: 'rrf' }));
    expect(replaced.map(r => r.slug)).toEqual(['c', 'd', 'a', 'b']);
    expect(fused.map(r => r.slug)).toEqual(['a', 'c', 'b', 'd']);
    expect(cut(replaced).map(r => r.slug)).toEqual(['c', 'd']);
    // The fusion lifted `a` to rank 1, but its provider score is below the cliff, so autocut drops it.
    expect(cut(fused).map(r => r.slug)).toEqual(['c', 'd']);
  });
});

describe('explain', () => {
  test('score_details and the explain line name the fuse mode; replace rows carry no fuse entry', async () => {
    const fused = await applyReranker('q', rows('a', 'b'), opts(fixed([[1, 0.9], [0, 0.4]]), { fuse: 'rrf' }));
    expect(buildScoreDetails(fused[0]).rerank).toEqual({ state: 'applied', score: 0.4, delta: 0, pinned: false, fuse: { mode: 'rrf', k: 60, score: rrf(2, 1), rerank_rank: 2, first_pass_rank: 1 } });
    expect(formatResultExplain(fused[0], 1)).toContain('fused (rrf, k=60) score=0.0325 from rerank #2 + first-pass #1');
    const replaced = await applyReranker('q', rows('a', 'b'), opts(fixed([[1, 0.9], [0, 0.4]])));
    expect(buildScoreDetails(replaced[0]).rerank).toEqual({ state: 'applied', score: 0.9, delta: 1, pinned: false });
  });
});
