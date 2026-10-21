/**
 * Reranker stage options (default off): how the reranked head is ordered
 * (`search.reranker.fuse`) and what document the reranker reads
 * (`search.reranker.document`). applyReranker (rerank.ts) calls both.
 *
 * fuse = `replace` (default): the reranker's order replaces the first-pass
 * order, exactly as before these knobs existed.
 *
 * fuse = `rrf`: the head's order is the reciprocal-rank fusion of the
 * reranker's order and the first-pass order the reranker received (the
 * fused hybrid order), equal weights, k = 60:
 *
 *   fused = 1/(60 + rerank_rank) + 1/(60 + first_pass_rank)   (1-based ranks)
 *
 * Ties keep the first-pass order. The value is stamped as `rerank_fuse.score`
 * and `rerank_score` keeps the provider's raw score. Units: a rank-fusion
 * value in (0, 2/61 ≈ 0.0328], spaced by rank alone and never a relevance
 * probability, so thresholds tuned on provider rerank scores (autocut jump
 * and floor, CRAG floors, an agent's "ignore below 0.8") do not transfer to
 * it. Rank priors multiply it (rank-priors.ts) and score-contract.ts returns
 * it, times the prior, as `score`. Autocut keeps reading `rerank_score`.
 *
 * document = `chunk` (default): the chunk text (the title when it is empty).
 * document = `titled`: "<title>\n<chunk>", or "<title> (<YYYY-MM-DD>)\n<chunk>"
 * when the row already carries a document or event date (no extra query).
 */
import type { SearchResult } from '../types.ts';

export const RERANK_FUSE_MODES = ['replace', 'rrf'] as const;
export type RerankFuseMode = typeof RERANK_FUSE_MODES[number];
export const DEFAULT_RERANK_FUSE: RerankFuseMode = 'replace';

export const RERANK_DOCUMENT_MODES = ['chunk', 'titled'] as const;
export type RerankDocumentMode = typeof RERANK_DOCUMENT_MODES[number];
export const DEFAULT_RERANK_DOCUMENT: RerankDocumentMode = 'chunk';

/** The fusion constant: the same k as first-pass RRF (hybrid.ts RRF_K). */
export const RERANK_FUSE_K = 60;

/** Dates that say when the document was written or the event happened; created/fallback are import times. */
const DOCUMENT_DATE_SOURCES = new Set(['date', 'published', 'filename', 'event_date']);

/** The ONE parse contract for `search.reranker.fuse`; anything else falls through to the bundle. */
export function normalizeRerankFuse(v: unknown): RerankFuseMode | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (RERANK_FUSE_MODES as readonly string[]).includes(s) ? (s as RerankFuseMode) : undefined;
}

/** The ONE parse contract for `search.reranker.document`; anything else falls through to the bundle. */
export function normalizeRerankDocument(v: unknown): RerankDocumentMode | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (RERANK_DOCUMENT_MODES as readonly string[]).includes(s) ? (s as RerankDocumentMode) : undefined;
}

export const RERANK_FUSE_KEY = 'search.reranker.fuse';
export const RERANK_DOCUMENT_KEY = 'search.reranker.document';

/** The `gbrain config set` refusal for an unknown `search.reranker.fuse` value, or null (search/config-values.ts). */
export function rerankFuseValueProblem(value: string): string | null {
  return normalizeRerankFuse(value) ? null : `${RERANK_FUSE_KEY} must be one of ${RERANK_FUSE_MODES.join(' | ')} (got '${value}'). Nothing was written.`;
}

/** The `gbrain config set` refusal for an unknown `search.reranker.document` value, or null (search/config-values.ts). */
export function rerankDocumentValueProblem(value: string): string | null {
  return normalizeRerankDocument(value) ? null : `${RERANK_DOCUMENT_KEY} must be one of ${RERANK_DOCUMENT_MODES.join(' | ')} (got '${value}'). Nothing was written.`;
}

/** The uncapped reranker document for one row (the caller caps it with capRerankDoc). */
export function rerankDocument(r: SearchResult, mode: RerankDocumentMode | undefined): string {
  if (mode !== 'titled') return r.chunk_text || r.title || '';
  const title = r.title ?? '';
  const day = DOCUMENT_DATE_SOURCES.has(r.effective_date_source ?? '') && /^\d{4}-\d{2}-\d{2}/.test(r.effective_date ?? '')
    ? r.effective_date!.slice(0, 10) : undefined;
  const head = day ? `${title} (${day})` : title;
  return r.chunk_text ? `${head}\n${r.chunk_text}` : head;
}

/** The value a reranked row is ordered by before priors: the fused value in rrf mode, else the provider score. */
export function rerankOrderScore(r: Pick<SearchResult, 'rerank_score' | 'rerank_fuse'>): number | undefined {
  return r.rerank_fuse && Number.isFinite(r.rerank_fuse.score) ? r.rerank_fuse.score : r.rerank_score;
}

/**
 * Reorder the reranker-scored rows (given in the reranker's order) by RRF of
 * that order and their first-pass position (`firstPass`: 0-based index in the
 * head the reranker received). Stamps `rerank_fuse` and the final
 * `reranker_delta` on each row.
 */
export function fuseRerankedHead(byReranker: SearchResult[], firstPass: Map<SearchResult, number>): SearchResult[] {
  const keyed = byReranker.map((r, i) => {
    const rerankRank = i + 1;
    const firstPassRank = firstPass.get(r)! + 1;
    return { r, rerankRank, firstPassRank, score: 1 / (RERANK_FUSE_K + rerankRank) + 1 / (RERANK_FUSE_K + firstPassRank) };
  });
  keyed.sort((a, b) => (b.score - a.score) || (a.firstPassRank - b.firstPassRank));
  return keyed.map((k, i) => {
    k.r.rerank_fuse = { mode: 'rrf', score: k.score, rerank_rank: k.rerankRank, first_pass_rank: k.firstPassRank };
    k.r.reranker_delta = k.firstPassRank - 1 - i;
    return k.r;
  });
}
