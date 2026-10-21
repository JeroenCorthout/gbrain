/**
 * Relative dates in delivered conversation evidence
 * (`search.evidence_resolve_dates`, default off): "about a month ago" in a
 * user turn becomes "about a month ago [≈2023-04-28]", resolved against the
 * day the conversation was written (the block's observation date), never
 * against today.
 *
 * Only relative phrases the shared temporal grammar resolves without guessing
 * a direction (src/core/temporal-grammar.ts) are annotated: a bare month or
 * weekday whose year or week was picked by direction is left alone, except
 * after "last" / "this past". Absolute dates are already dates. Assistant and
 * system turns use relative phrases generically and are never touched; text
 * with no recognizable turn label is not a conversation and is returned
 * unchanged. The original phrase is always kept; the bracket sits beside it.
 */
import { findTimeMentions, type TimeMention } from '../temporal-grammar.ts';
import { FENCE_LINE, SPEAKER_LINE, speakerName } from './speaker-line.ts';

export const EVIDENCE_RESOLVE_DATES_KEY = 'search.evidence_resolve_dates';

/** Set-time check: the flag reads true/on/1/yes as on and anything else as off, so only those and their opposites are accepted. */
export function resolveDatesValueProblem(value: string): string | null {
  return /^(?:true|false|on|off|1|0|yes|no)$/i.test(value.trim()) ? null : `${EVIDENCE_RESOLVE_DATES_KEY} must be true or false (got "${value}")`;
}

export interface DateInsertion {
  /** UTF-16 offset in the input where `text` is inserted (just after the phrase). */
  at: number;
  text: string;
}

const APPROXIMATE = /\b(?:about|around|roughly|approximately|almost|nearly|over|a few|a couple of|couple of|several|few)\s+$/i;
const ALREADY_RESOLVED = /^\s?\[[≈~]?\d{4}/;
/** "today" and "this morning" name the session day the reader already sees, and are often generic ("still true today"). */
const SESSION_DAY = /^(?:today|tonight|this morning|this afternoon|this evening)$/i;
/** "for the next month" is a span from now, not the next calendar month. */
const SPAN_FROM_NOW = /\bthe\s+$/i;
/** Labels that name the assistant or the system: their turns are never annotated. */
const NON_HUMAN = /^(?:assistant|ai|bot|system|model|claude|chatgpt|gpt|gemini|copilot|agent)$/;
/** A line that starts with its own date stamp: turns carry their own times, so one page date can't anchor them. */
const DATED_LINE = /^\s{0,3}\[?\d{4}-\d{2}-\d{2}/m;

/** The [start, end) spans of human speaker turns, by the same speaker-line rule evidence delivery uses. */
function humanTurnSpans(text: string): { turns: Array<[number, number]>; fenced: Array<[number, number]> } {
  const labels: Array<{ at: number; bodyAt: number; human: boolean }> = [];
  const fenced: Array<[number, number]> = [];
  let inFence = false;
  let at = 0;
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) {
      if (inFence) fenced[fenced.length - 1][1] = at + line.length;
      else fenced.push([at, text.length]);
      inFence = !inFence;
    } else if (inFence) {
      // inside a code fence: no labels, no dates
    } else {
      const m = SPEAKER_LINE.exec(line);
      if (m) labels.push({ at, bodyAt: at + m[0].length, human: !NON_HUMAN.test(speakerName(m)) });
    }
    at += line.length + 1;
  }
  const turns: Array<[number, number]> = [];
  labels.forEach((l, i) => { if (l.human) turns.push([l.bodyAt, labels[i + 1]?.at ?? text.length]); });
  return { turns, fenced };
}

const wholeMonth = (m: TimeMention) => m.start.slice(8) === '01' && m.start.slice(0, 7) === m.end.slice(0, 7)
  && new Date(Date.UTC(+m.end.slice(0, 4), +m.end.slice(5, 7), 0)).toISOString().slice(0, 10) === m.end;
const wholeYear = (m: TimeMention) => m.start.endsWith('-01-01') && m.end.endsWith('-12-31') && m.start.slice(0, 4) === m.end.slice(0, 4);

function midpoint(start: string, end: string): string {
  const a = Date.parse(`${start}T00:00:00Z`); const b = Date.parse(`${end}T00:00:00Z`);
  return new Date(a + Math.round((b - a) / 2 / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

/** The bracket for one mention: a day, a month, a year, a day range, or an approximate day for "N units ago". */
export function dateBracket(m: TimeMention, approximate: boolean): string {
  if (/\bago\b/i.test(m.cue)) {
    if (wholeYear(m)) return `[${m.start.slice(0, 4)}]`;
    const fuzzy = approximate || !/\bdays?\s+ago\b/i.test(m.cue) || /few|couple|several/i.test(m.cue);
    return `[${fuzzy ? '≈' : ''}${midpoint(m.start, m.end)}]`;
  }
  const prefix = approximate ? '≈' : '';
  if (m.start === m.end) return `[${prefix}${m.start}]`;
  if (wholeYear(m)) return `[${prefix}${m.start.slice(0, 4)}]`;
  if (wholeMonth(m)) return `[${prefix}${m.start.slice(0, 7)}]`;
  return `[${prefix}${m.start}/${m.end}]`;
}

/**
 * Bracketed absolute dates for the relative phrases in user turns of
 * `text`, resolved against `observedDay` (YYYY-MM-DD). No observation day,
 * no turns, or no resolvable phrase returns the text unchanged with no
 * insertions. Idempotent: a phrase already followed by a bracketed date is
 * skipped.
 */
export function resolveRelativeDatesInTurns(text: string, observedDay: string | null | undefined): { text: string; insertions: DateInsertion[] } {
  if (!observedDay || !/^\d{4}-\d{2}-\d{2}$/.test(observedDay) || DATED_LINE.test(text)) return { text, insertions: [] };
  const insertions: DateInsertion[] = [];
  const { turns, fenced } = humanTurnSpans(text);
  for (const [from, to] of turns) {
    const turn = text.slice(from, to);
    for (const m of findTimeMentions(turn, observedDay, 'past')) {
      if (m.kind !== 'relative' || fenced.some(([a, b]) => from + m.index >= a && from + m.index < b)) continue;
      if (m.qualified || SESSION_DAY.test(m.cue) || (/^next\b/i.test(m.cue) && SPAN_FROM_NOW.test(turn.slice(Math.max(0, m.index - 8), m.index)))) continue;
      const end = from + m.index + m.cue.length;
      if (ALREADY_RESOLVED.test(text.slice(end, end + 8))) continue;
      const approximate = APPROXIMATE.test(text.slice(Math.max(from, from + m.index - 24), from + m.index));
      insertions.push({ at: end, text: ` ${dateBracket(m, approximate)}` });
    }
  }
  if (insertions.length === 0) return { text, insertions };
  let out = '';
  let last = 0;
  for (const ins of insertions) { out += text.slice(last, ins.at) + ins.text; last = ins.at; }
  return { text: out + text.slice(last), insertions };
}

/** A span offset in the original text, moved past every insertion before it (`inclusive`: also one at the offset itself). */
export function shiftOffset(offset: number, insertions: readonly DateInsertion[], inclusive: boolean): number {
  let shift = 0;
  for (const ins of insertions) if (ins.at < offset || (inclusive && ins.at === offset)) shift += ins.text.length;
  return offset + shift;
}

type DatedResult = { page_id: number; slug: string; type?: string | null; chunk_text: string; delivered: { tokens: number; match_spans: Array<{ start: number; end: number }> } };
type Delivered<R> = { results: R[]; delivery: { budget_tokens: number; budget_used: number; tokens_delivered: number; fallbacks: string[]; relative_dates?: { insertions: number } } };

/** Annotate the conversation blocks of one delivery; spans move past the brackets and tokens are recounted. */
function annotate<R extends DatedResult>(d: Delivered<R>, days: Map<number, string | null>, isConversation: (r: R) => boolean, count: (s: string) => number): Delivered<R> {
  let insertions = 0;
  let added = 0;
  const results = d.results.map(r => {
    if (!isConversation(r)) return r;
    const out = resolveRelativeDatesInTurns(r.chunk_text, days.get(r.page_id));
    if (out.insertions.length === 0) return r;
    insertions += out.insertions.length;
    const tokens = count(out.text);
    added += Math.max(0, tokens - r.delivered.tokens);
    const spans = r.delivered.match_spans.map(s => ({ ...s, start: shiftOffset(s.start, out.insertions, true), end: shiftOffset(s.end, out.insertions, false) }));
    return { ...r, chunk_text: out.text, delivered: { ...r.delivered, tokens, match_spans: spans } };
  });
  return { results, delivery: { ...d.delivery, budget_used: d.delivery.budget_used + added, tokens_delivered: d.delivery.tokens_delivered + added, relative_dates: { insertions } } };
}

/**
 * The delivery with relative dates resolved, inside the same budget: when the
 * brackets push a delivery past its budget, it is assembled once more with
 * the budget lowered by the overflow; if that still does not fit, the
 * unannotated delivery is returned with fallback `relative_dates_over_budget`.
 */
export async function withRelativeDates<R extends DatedResult, D extends Delivered<R>>(
  first: D,
  reassemble: (budgetTokens: number) => Promise<D>,
  observationDays: (pageIds: number[]) => Promise<Map<number, string | null>>,
  isConversation: (r: R) => boolean,
  count: (s: string) => number,
): Promise<D> {
  const daysFor = async (d: D) => observationDays([...new Set(d.results.filter(isConversation).map(r => r.page_id))]).catch(() => null);
  const limit = Math.max(first.delivery.budget_tokens, first.delivery.budget_used);
  const days = await daysFor(first);
  if (!days) return { ...first, delivery: { ...first.delivery, fallbacks: [...new Set([...first.delivery.fallbacks, 'relative_dates_unavailable'])].sort() } };
  const annotated = annotate(first, days, isConversation, count);
  if (annotated.delivery.budget_used <= limit) return annotated as D;
  const retry = await reassemble(first.delivery.budget_tokens - (annotated.delivery.budget_used - limit));
  const retryDays = await daysFor(retry);
  const second = retryDays ? annotate(retry, retryDays, isConversation, count) : null;
  if (second && second.delivery.budget_used <= limit) return { ...second, delivery: { ...second.delivery, budget_tokens: first.delivery.budget_tokens } } as D;
  return { ...first, delivery: { ...first.delivery, fallbacks: [...new Set([...first.delivery.fallbacks, 'relative_dates_over_budget'])].sort() } };
}
