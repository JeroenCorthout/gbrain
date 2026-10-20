/**
 * #6999: the text a reconcile that keeps the file's bytes (`gbrain repair file-drift --prefer file`, the request's
 * `keep_file_bytes`) writes. A file that already reads as the reviewed result is kept byte for byte (#6643). When the
 * result still differs (a tag only the database holds, a protected key the file lacks, a database-only timeline entry,
 * file-only scan state), only the lines that differ are edited:
 *  - a changed top-level frontmatter key is replaced, added or removed on its own lines (`type` and `title` included);
 *  - tags the result adds are appended to the file's own tag list, in its block or one-line flow style;
 *  - a changed body half (compiled truth or timeline) has its text swapped in place, keeping the whitespace around it.
 * The edit is used only when it reads back, the way `readReconcileState` reads the canonical file, as the reviewed
 * result digest; anything else (CRLF line ends, no `---` block, a duplicated key, a timeline read from a bare
 * `## Timeline` section, or an edit that reads differently) returns null and the caller renders the page as before.
 */
import type { ParsedPage } from '../import-file.ts';
import { findTimelineSplitIndex, parseMarkdown } from '../markdown.ts';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { alignWithStored } from './align-stored.ts';
import { digest, stableJson } from './digest.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { reconcileFileReading, type ReconcileState } from './reconcile-state.ts';

const PARSE_NOTICES = new Set(['MISSING_OPEN', 'EMPTY_FRONTMATTER']);
const FLOW_INDICATORS = /[,[\]{}#]/;

export function keptFileBytes(state: Pick<ReconcileState, 'raw' | 'file' | 'importPath' | 'snapshot' | 'pins'>, result: ParsedPage, resultDigest: string): string | null {
  const raw = state.raw.toString('utf8');
  if (digest(reconcileCanonical(state.file, state.file.tags)) === resultDigest) return raw;
  const edited = editChangedLines(raw, state.file, result);
  return edited !== null && readsAsResult(edited, state, result, resultDigest) ? edited : null;
}

/** The edited text reads, as the reconcile readback reads it after the write, as the reviewed result. */
function readsAsResult(text: string, state: Pick<ReconcileState, 'importPath' | 'snapshot' | 'pins'>, result: ParsedPage, resultDigest: string): boolean {
  const page = { ...state.snapshot.page, type: result.type, frontmatter: { ...(state.snapshot.page.frontmatter ?? {}), ...result.frontmatter } };
  const reading = reconcileFileReading(text, state.importPath, page);
  const slug = state.pins.slug;
  const parsed = parseMarkdown(reading.content, `${slug}.md`, { validate: true, expectedSlug: slug });
  alignWithStored(parsed, page, reading.inferred);
  if (parsed.errors?.some(error => !PARSE_NOTICES.has(error.code)) || parsed.slug !== slug) return false;
  return digest(reconcileCanonical(parsed, parsed.tags)) === resultDigest;
}

function editChangedLines(raw: string, file: ParsedPage, result: ParsedPage): string | null {
  if (raw.includes('\r')) return null;
  const lines = raw.split('\n');
  const close = lines.indexOf('---', 1);
  if (lines[0] !== '---' || close === -1) return null;
  const body = editBody(lines.slice(close + 1).join('\n'), file, result);
  if (body === null) return null;
  let head: string[] | null = lines.slice(1, close);
  const before: Record<string, unknown> = { ...file.frontmatter, type: file.type, title: file.title };
  const after: Record<string, unknown> = { ...result.frontmatter, type: result.type, title: result.title };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.hasOwn(before, key) && Object.hasOwn(after, key) && stableJson(before[key]) === stableJson(after[key])) continue;
    head = replaceKey(head, key, Object.hasOwn(after, key) ? { [key]: after[key] } : null);
    if (!head) return null;
  }
  if (stableJson([...file.tags].sort()) !== stableJson([...result.tags].sort())) {
    head = appendTags(head, file.tags, result.tags) ?? replaceKey(head, 'tags', result.tags.length ? { tags: result.tags } : null);
    if (!head) return null;
  }
  return ['---', ...head, '---', body].join('\n');
}

/** The name of the top-level key a frontmatter line opens, or null for an indented, list, comment or blank line. */
function topLevelKey(line: string): string | null {
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:][^:]*?))[ \t]*:(?:[ \t]|$)/.exec(line);
  if (!match) return null;
  if (match[1] !== undefined) { try { return JSON.parse(`"${match[1]}"`) as string; } catch { return null; } }
  return match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3]!;
}

/** The [start, end) lines of top-level key `key`: its own line and the indented or list lines under it; null when absent, undefined when it appears twice. */
function keyRange(head: string[], key: string): [number, number] | null | undefined {
  const starts = head.flatMap((line, index) => topLevelKey(line) === key ? [index] : []);
  if (starts.length > 1) return undefined;
  if (!starts.length) return null;
  const start = starts[0]!;
  let end = start + 1;
  while (end < head.length && /^([ \t]|-([ \t]|$)|[ \t]*$)/.test(head[end]!)) end++;
  while (end > start + 1 && head[end - 1]!.trim() === '') end--;
  return [start, end];
}

/** The head with `key`'s lines replaced by `value` rendered alone (null removes them; an absent key is added last). */
function replaceKey(head: string[], key: string, value: Record<string, unknown> | null): string[] | null {
  const range = keyRange(head, key);
  if (range === undefined) return null;
  const [start, end] = range ?? [head.length, head.length];
  const rendered = value === null ? [] : dumpFrontmatterYaml(value, { lineWidth: -1 }).replace(/\n$/, '').split('\n');
  return [...head.slice(0, start), ...rendered, ...head.slice(end)];
}

/** The head with the tags only `next` holds appended to the file's own list, or null when that is not an append. */
function appendTags(head: string[], prior: string[], next: string[]): string[] | null {
  const range = keyRange(head, 'tags');
  if (!range || !prior.every(tag => next.includes(tag))) return null;
  const added = next.filter(tag => !prior.includes(tag));
  if (!added.length) return null;
  const [start, end] = range;
  const opener = head[start]!;
  const inline = opener.slice(opener.indexOf(':') + 1).trim();
  if (inline) {
    const flow = /^(.*?\[[ \t]*)(.*?)([ \t]*\][ \t]*)$/.exec(opener);
    if (!flow || end !== start + 1) return null;
    const items = [flow[2]!.replace(/,[ \t]*$/, ''), ...added.map(flowScalar)].filter(Boolean);
    return [...head.slice(0, start), `${flow[1]}${items.join(', ')}${flow[3]}`, ...head.slice(end)];
  }
  const item = head.slice(start + 1, end).reverse().find(line => /^[ \t]*-[ \t]+\S/.test(line));
  const prefix = item ? /^[ \t]*-[ \t]+/.exec(item)![0] : null;
  if (!prefix) return null;
  return [...head.slice(0, end), ...added.map(tag => prefix + blockScalar(tag)), ...head.slice(end)];
}

function blockScalar(tag: string): string {
  return dumpFrontmatterYaml([tag], { lineWidth: -1 }).replace(/\n$/, '').replace(/^- /, '');
}

function flowScalar(tag: string): string {
  const plain = blockScalar(tag);
  return FLOW_INDICATORS.test(plain) && !/^['"]/.test(plain) ? JSON.stringify(tag) : plain;
}

/** The body with each changed half's text swapped in place (its surrounding whitespace kept), or null. */
function editBody(body: string, file: ParsedPage, result: ParsedPage): string | null {
  const priorTimeline = file.timeline ?? '';
  const nextTimeline = result.timeline ?? '';
  if (file.compiled_truth === result.compiled_truth && priorTimeline === nextTimeline) return body;
  const swap = (region: string, prior: string, next: string) => {
    if (prior === next) return region;
    const lead = region.length - region.trimStart().length;
    return region.slice(0, lead) + next + region.slice(Math.max(lead, region.trimEnd().length));
  };
  const lines = body.split('\n');
  const split = findTimelineSplitIndex(lines);
  if (split !== -1) {
    return [swap(lines.slice(0, split).join('\n'), file.compiled_truth, result.compiled_truth), lines[split]!,
      swap(lines.slice(split + 1).join('\n'), priorTimeline, nextTimeline)].join('\n');
  }
  if (priorTimeline) return null;
  const truth = swap(body, file.compiled_truth, result.compiled_truth);
  if (!nextTimeline) return truth;
  return `${truth.replace(/\s+$/, '')}\n\n<!-- timeline -->\n\n${nextTimeline}\n`;
}
