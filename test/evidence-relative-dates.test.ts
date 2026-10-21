/**
 * `search.evidence_resolve_dates`: relative dates in human speaker turns of
 * delivered conversation blocks get an absolute bracket resolved against the
 * page's observation day. Pinned output strings, the eligibility rules
 * (human turns only, no direction guesses, no turn-stamped transcripts, never
 * today), idempotence, span and token accounting, the hard budget, and the
 * default-off byte identity.
 */
import { describe, expect, test } from 'bun:test';
import type { SearchResult } from '../src/core/types.ts';
import { countEvidenceTokens, DEFAULT_AUTO_PACKING, deliverEvidence, resolveEvidencePlan, type EvidencePlan } from '../src/core/search/evidence-delivery.ts';
import { resolveRelativeDatesInTurns, shiftOffset, withRelativeDates } from '../src/core/search/evidence-relative-dates.ts';
import { searchConfigValueRefusal } from '../src/core/search/config-values.ts';

const DAY = '2023-05-28'; // a Sunday
const r = (s: string, day: string | null = DAY) => resolveRelativeDatesInTurns(s, day).text;

describe('resolveRelativeDatesInTurns', () => {
  test('N units ago renders the window centre; days are exact unless fuzzy', () => {
    expect(r('**user:** I started about a month ago.')).toBe('**user:** I started about a month ago [≈2023-04-28].');
    expect(r('**user:** I bought it three weeks ago.')).toBe('**user:** I bought it three weeks ago [≈2023-05-07].');
    expect(r('**user:** I met her 2 days ago.')).toBe('**user:** I met her 2 days ago [2023-05-26].');
    expect(r('**user:** I met her a couple of days ago.')).toBe('**user:** I met her a couple of days ago [≈2023-05-26].');
    expect(r('**user:** We moved two years ago.')).toBe('**user:** We moved two years ago [2021].');
  });

  test('named periods render as a day, a week range, a month or a year', () => {
    expect(r('**user:** Yesterday I ran 5k.')).toBe('**user:** Yesterday [2023-05-27] I ran 5k.');
    expect(r('**user:** I started today and it is still true today.')).toBe('**user:** I started today and it is still true today.');
    expect(r('**user:** Plan my shows for the next month.')).toBe('**user:** Plan my shows for the next month.');
    expect(r('**user:** I fly out next month.')).toBe('**user:** I fly out next month [2023-06].');
    for (const s of ['**user:** It was the last week of April.', '**user:** That was the last year of college.', '**user:** It was the past month of training.']) expect(r(s)).toBe(s);
    expect(r('**user:** I went hiking last weekend.')).toBe('**user:** I went hiking last weekend [2023-05-20/2023-05-21].');
    expect(r('**user:** Last month I did 3k.')).toBe('**user:** Last month [2023-04] I did 3k.');
    expect(r('**user:** Last year I started.')).toBe('**user:** Last year [2022] I started.');
    expect(r('**user:** I moved last Saturday.')).toBe('**user:** I moved last Saturday [2023-05-27].');
    expect(r('**user:** I fly out next week.')).toBe('**user:** I fly out next week [≈2023-05-29/2023-06-04].');
    expect(r('**user:** Last week I was sick.')).toBe('**user:** Last week [≈2023-05-15/2023-05-21] I was sick.');
  });

  test('direction guesses are left alone: future plans keep their words', () => {
    for (const s of ['**user:** I am visiting in June.', '**user:** I leave on Friday.', '**user:** The June deadline is close.', '**user:** It ships March 15.', '**user:** I will go this Friday.']) expect(r(s)).toBe(s);
  });

  test('only user/human turns are annotated; assistant, system, named and heading-role turns are not', () => {
    const s = '**user:** I started yesterday.\n\n**assistant:** Starting yesterday is great.\n\n**Grok:** Yesterday was good.\n\n**Alice-example:** I joined last month.';
    expect(r(s)).toBe('**user:** I started yesterday [2023-05-27].\n\n**assistant:** Starting yesterday is great.\n\n**Grok:** Yesterday was good.\n\n**Alice-example:** I joined last month.');
    expect(r('## User\nI moved yesterday.\n## Assistant\nTry yesterday as an example.')).toBe('## User\nI moved yesterday [2023-05-27].\n## Assistant\nTry yesterday as an example.');
    expect(r('user: I started yesterday.\n## Assistant\nTry yesterday as an example.')).toBe('user: I started yesterday [2023-05-27].\n## Assistant\nTry yesterday as an example.');
  });

  test('a delivery omission marker resets the speaker: a continuation of unknown role is left alone', () => {
    const s = '**user:** I renewed yesterday.\n\n[…]\n\nThis assistant sample mentions yesterday.';
    expect(r(s)).toBe('**user:** I renewed yesterday [2023-05-27].\n\n[…]\n\nThis assistant sample mentions yesterday.');
    expect(r('**user:** I renewed yesterday.\n\n<!-- timeline -->\n\n- moved yesterday')).toBe('**user:** I renewed yesterday [2023-05-27].\n\n<!-- timeline -->\n\n- moved yesterday');
  });

  test('calendar-invalid observation days are refused, leap days accepted', () => {
    for (const day of ['2023-02-29', '2023-13-01', '2023-04-31']) expect(r('**user:** I started yesterday.', day)).toBe('**user:** I started yesterday.');
    expect(r('**user:** I started yesterday.', '2024-03-01')).toBe('**user:** I started yesterday [2024-02-29].');
  });

  test('an existing bracket after extra whitespace is not annotated again', () => {
    expect(r('**user:** I started yesterday   [2023-05-27] for sure.')).toBe('**user:** I started yesterday   [2023-05-27] for sure.');
  });

  test('not a conversation, no observation day, or turn-stamped lines: unchanged', () => {
    expect(r('A note: about a month ago we shipped.')).toBe('A note: about a month ago we shipped.');
    expect(r('**user:** I started yesterday.', null)).toBe('**user:** I started yesterday.');
    expect(r('**user:** I started yesterday.', 'garbage')).toBe('**user:** I started yesterday.');
    const stamped = '[2023-05-20 10:00] **user:** I started yesterday.\n[2023-05-27 09:00] **user:** And last week.';
    expect(r(stamped)).toBe(stamped);
    const rendered = '**User** (2023-05-20 10:00 AM): I started yesterday.\n\n**Assistant** (2023-05-20 10:01 AM): Noted.';
    expect(r(rendered)).toBe(rendered);
  });

  test('absolute dates, quoted text and code fences are untouched', () => {
    for (const s of ['**user:** On 2023-05-01 I started.', '**user:** The show "Last Week Tonight" is good.', '**user:** see\n```\nuser: yesterday\n```']) expect(r(s)).toBe(s);
  });

  test('idempotent: an annotated phrase is not annotated again', () => {
    const once = r('**user:** I started about a month ago and ran yesterday.');
    expect(r(once)).toBe(once);
  });

  test('insertions report where text was added; offsets shift past them', () => {
    const out = resolveRelativeDatesInTurns('**user:** yesterday and last month', DAY);
    expect(out.insertions).toEqual([{ at: 19, text: ' [2023-05-27]' }, { at: 34, text: ' [2023-04]' }]);
    expect(shiftOffset(10, out.insertions, true)).toBe(10);
    expect(shiftOffset(19, out.insertions, false)).toBe(19);
    expect(shiftOffset(19, out.insertions, true)).toBe(32);
    expect(shiftOffset(34, out.insertions, false)).toBe(47);
  });
});

describe('config set validation', () => {
  test('only boolean words are accepted; a value the reader would ignore is refused', () => {
    for (const v of ['true', 'false', 'on', 'off', '1', '0', 'yes', 'no', 'TRUE']) expect(searchConfigValueRefusal('search.evidence_resolve_dates', v)).toBeNull();
    for (const v of ['enabled', 'disable', '', '2']) expect(searchConfigValueRefusal('search.evidence_resolve_dates', v)?.example).toBe('true');
  });
});

describe('deliverEvidence with search.evidence_resolve_dates', () => {
  const body = Array.from({ length: 30 }, (_, i) => i % 2 ? `**assistant:** reply ${i}, yesterday is fine.` : `**user:** turn ${i}, I renewed it last month and again yesterday.`).join('\n\n');
  const chunks = [body.slice(0, body.length / 2).trim(), body.slice(body.length / 2).trim()];
  function stub(frontmatter: Record<string, unknown>) {
    return {
      async getConfig(key: string) { return key === 'brain.timezone' ? 'UTC' : null; },
      async executeRaw() { return [{ id: 1, slug: 'chat/s', frontmatter, import_filename: null }]; },
      async getChunkWindows() {
        return [{ page_id: 1, slug: 'chat/s', source_id: 'default', type: 'conversation', revision: 'r1', sealed: true, max_chunk_index: 1, row_limited: false,
          compiled_truth: body, timeline: '', chunks: chunks.map((t, i) => ({ id: 1000 + i, chunk_index: i, chunk_text: t, chunk_source: 'compiled_truth' })) }];
      },
    } as never;
  }
  const hit: SearchResult = { slug: 'chat/s', page_id: 1, title: 'S', type: 'conversation', chunk_text: chunks[1], chunk_source: 'compiled_truth', chunk_id: 1001, chunk_index: 1, score: 1, stale: false, source_id: 'default' };
  const plan = (budget: number, resolveDates: boolean): EvidencePlan => ({ requestedUnit: 'auto', unit: 'auto', window: 1, budgetTokens: budget, explicitUnit: true,
    budgetExplicit: false, packing: DEFAULT_AUTO_PACKING, ...(resolveDates ? { resolveDates: true as const } : {}) });

  test('flag on equals the resolver applied to the flag-off block; spans and tokens follow', async () => {
    const off = await deliverEvidence(stub({ date: DAY }), [hit], plan(32000, false), {});
    const on = await deliverEvidence(stub({ date: DAY }), [hit], plan(32000, true), {});
    const expected = resolveRelativeDatesInTurns(off.results[0].chunk_text, DAY);
    expect(expected.insertions.length).toBeGreaterThan(0);
    expect(on.results[0].chunk_text).toBe(expected.text);
    expect(on.results[0].delivered.tokens).toBe(countEvidenceTokens(expected.text));
    expect(on.delivery.relative_dates).toEqual({ insertions: expected.insertions.length });
    expect(off.delivery.relative_dates).toBeUndefined();
    for (const [i, sp] of on.results[0].delivered.match_spans.entries()) {
      const before = off.results[0].delivered.match_spans[i];
      expect(sp.start).toBe(shiftOffset(before.start, expected.insertions, true));
      expect(sp.end).toBe(shiftOffset(before.end, expected.insertions, false));
    }
    expect(on.delivery.tokens_delivered).toBe(on.results.reduce((n, x) => n + x.delivered.tokens, 0));
  });

  test('the budget stays a hard cap: brackets that overflow it re-pack the block smaller', async () => {
    const off = await deliverEvidence(stub({ date: DAY }), [hit], plan(32000, false), {});
    const tight = off.delivery.budget_used;
    const on = await deliverEvidence(stub({ date: DAY }), [hit], plan(tight, true), {});
    expect(on.delivery.budget_used).toBeLessThanOrEqual(tight);
    expect(on.delivery.budget_tokens).toBe(tight);
    const ok = on.delivery.relative_dates !== undefined || on.delivery.fallbacks.includes('relative_dates_over_budget');
    expect(ok).toBe(true);
  });

  test('no observation date: unchanged text, no fabricated date', async () => {
    const off = await deliverEvidence(stub({}), [hit], plan(32000, false), {});
    const on = await deliverEvidence(stub({}), [hit], plan(32000, true), {});
    expect(on.results[0].chunk_text).toBe(off.results[0].chunk_text);
    expect(on.delivery.relative_dates).toEqual({ insertions: 0 });
  });

  test('flag off delivers the source turns verbatim, with no bracket and no meta', async () => {
    const off = await deliverEvidence(stub({ date: DAY }), [hit], plan(32000, false), {});
    expect(body).toContain(off.results[0].chunk_text);
    expect(off.results[0].chunk_text).toContain('last month and again yesterday.');
    expect(off.delivery.relative_dates).toBeUndefined();
  });

  test('resolveEvidencePlan sets resolveDates only when the config key is on', async () => {
    const engine = (value: string | null) => ({ async getConfig(key: string) { return key === 'search.evidence_resolve_dates' ? value : null; } }) as never;
    const resolve = (value: string | null) => resolveEvidencePlan(engine(value), { remote: false, returnUnit: 'auto', returnWindow: undefined, budget: undefined, snippetChars: undefined, snippetCap: 0, op: 'search' });
    expect((await resolve('true'))?.resolveDates).toBe(true);
    expect((await resolve('off'))?.resolveDates).toBeUndefined();
    expect((await resolve(null))?.resolveDates).toBeUndefined();
  });
});

describe('withRelativeDates budget and fallbacks', () => {
  type R = { page_id: number; slug: string; chunk_text: string; delivered: { tokens: number; match_spans: Array<{ start: number; end: number }> } };
  const count = (s: string) => s.length;
  const block = (text: string): R => ({ page_id: 1, slug: 'chat/s', chunk_text: text, delivered: { tokens: text.length, match_spans: [] } });
  const delivery = (text: string, budget: number) => ({ results: [block(text)], delivery: { budget_tokens: budget, budget_used: text.length, tokens_delivered: text.length, fallbacks: [] as string[] } as { budget_tokens: number; budget_used: number; tokens_delivered: number; fallbacks: string[]; relative_dates?: { insertions: number } } });
  const long = '**user:** I renewed it yesterday and that was all.';
  const short = '**user:** yesterday.';
  const days = async () => new Map([[1, DAY]]);
  const all = () => true;

  test('a retry that fits returns the re-packed, annotated delivery inside the budget', async () => {
    const budgets: number[] = [];
    const out = await withRelativeDates(delivery(long, long.length), async b => { budgets.push(b); return delivery(short, b); }, days, all, count);
    expect(budgets).toEqual([long.length - ' [2023-05-27]'.length]);
    expect(out.results[0].chunk_text).toBe('**user:** yesterday [2023-05-27].');
    expect(out.delivery.budget_used).toBeLessThanOrEqual(long.length);
    expect(out.delivery.budget_tokens).toBe(long.length);
    expect(out.delivery.relative_dates).toEqual({ insertions: 1 });
    expect(out.delivery.fallbacks).toEqual([]);
  });

  test('a retry that still overflows returns the unannotated first delivery with relative_dates_over_budget', async () => {
    const out = await withRelativeDates(delivery(long, long.length), async b => delivery(long, b), days, all, count);
    expect(out.results[0].chunk_text).toBe(long);
    expect(out.delivery.fallbacks).toEqual(['relative_dates_over_budget']);
    expect(out.delivery.relative_dates).toBeUndefined();
  });

  test('an observation-day read error returns the first delivery with relative_dates_unavailable', async () => {
    let retried = false;
    const out = await withRelativeDates(delivery(long, 10_000), async b => { retried = true; return delivery(long, b); }, async () => { throw new Error('db down'); }, all, count);
    expect(retried).toBe(false);
    expect(out.results[0].chunk_text).toBe(long);
    expect(out.delivery.fallbacks).toEqual(['relative_dates_unavailable']);
  });
});
