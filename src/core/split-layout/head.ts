/**
 * Split git layout (Wave B PR 5): the head file. A head is the page's own frontmatter block with one more top-level
 * key, `gbrain_parts` (the manifest, types.ts), appended last before the closing `---` line, then a body that is the
 * lead (the first bytes of the page body) and one notice line. An older gbrain imports a head as a short page whose
 * frontmatter carries `gbrain_parts` as an ordinary key; a current one reads the manifest and reassembles the page.
 *
 * Reassembly needs the page's frontmatter bytes back exactly, so the key is removed as text: the key's lines run from
 * its `gbrain_parts:` line to the next top-level line, and the removal is accepted only when those lines parse to the
 * same manifest and the remaining block parses to the head's frontmatter without the key. Edits to other keys in the
 * head (a tag, a title) survive; an edit of the body is caught by `lead_sha256` (verify.ts).
 */
import { isDeepStrictEqual } from 'node:util';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { opError } from '../ops/contract.ts';
import { parseMarkdownHead } from '../markdown.ts';
import { splitLimits } from './limits.ts';
import { isPartsDirName, PART_FILE_RE } from './paths.ts';
import { PARTS_KEY, SPLIT_FORMAT, SplitLayoutError, type SplitManifest } from './types.ts';

/** A head that carries a valid manifest; `frontmatterWithoutParts` ends with its closing fence line. */
export interface ParsedHead {
  manifest: SplitManifest;
  frontmatterWithoutParts: string;
  headBody: string;
}
/** A file that declares `gbrain_parts` but cannot be read as a head; sync holds it and never imports it as a short page. */
export interface SplitHeadError {
  error: { code: 'split_page_incomplete'; reason: string };
}
/** null: the file declares no `gbrain_parts` key and is an ordinary page file. */
export type ParseHeadResult = ParsedHead | SplitHeadError | null;

const PARTS_KEY_LINE = /^gbrain_parts[ \t]*:/;
const TOP_LEVEL_LINE = /^[^\s#]/;
const HEX64 = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = ['content_hash', 'format', 'lead_bytes', 'lead_sha256', 'parts', 'total_bytes'];
const PART_KEYS = ['bytes', 'path', 'sha256'];

function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MiB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return bytes + ' B';
}

/** The one notice line a head's body ends with. */
export function splitNotice(partCount: number, bodyBytes: number): string {
  return `> [gbrain] This page continues in ${partCount} part file${partCount === 1 ? '' : 's'} (${humanBytes(bodyBytes)}). Current gbrain versions read them; older versions see only this lead.\n`;
}

/** The head body as written: the lead, a line break when the lead does not end in one, then the notice. */
export function headBodyFor(lead: string, notice: string): string {
  return lead + (lead.endsWith('\n') ? '' : '\n') + notice;
}

/** Frontmatter data as import reads it (parseMarkdownHead), or null when the block does not parse. */
function frontmatterData(text: string): Record<string, unknown> | null {
  try {
    const head = parseMarkdownHead(text, { validate: true });
    return head.errors.some(error => error.code === 'YAML_PARSE' && !error.recoverable) ? null : head.frontmatter;
  } catch {
    return null;
  }
}

interface Fence { opening: string; lines: string[]; closing: string; bodyStart: number }

/** The frontmatter block where parseDataFrontmatter finds it (leading blank lines lifted, a plain `---` fence), as lines that keep their breaks. */
function locateFence(content: string): Fence | null {
  const lifted = /^(?:[\t ]*\r?\n)+(?=---)/.exec(content)?.[0] ?? '';
  const opening = /^---([^\r\n]*)\r?\n/.exec(content.slice(lifted.length));
  if (!opening || opening[1]!.trim() !== '') return null;
  const blockStart = lifted.length + opening[0].length;
  const closing = /^---[\t ]*(?:\r?\n|$)/m.exec(content.slice(blockStart));
  if (!closing) return null;
  const block = content.slice(blockStart, blockStart + closing.index);
  return {
    opening: content.slice(0, blockStart),
    lines: block.split(/(?<=\n)/).filter(line => line !== ''),
    closing: closing[0],
    bodyStart: blockStart + closing.index + closing[0].length,
  };
}

function plainObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && isDeepStrictEqual(Object.keys(value).sort(), keys);
}
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const isHex = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value);

/** The manifest, or the reason it is invalid. Strict: format 1, exact keys, positive sizes, total = sum, names that match. */
export function validateManifest(raw: unknown): SplitManifest | string {
  if (!plainObject(raw, MANIFEST_KEYS)) return 'gbrain_parts must hold exactly format, total_bytes, content_hash, lead_bytes, lead_sha256 and parts';
  if (raw.format !== SPLIT_FORMAT) return `gbrain_parts format ${JSON.stringify(raw.format)} is not one this gbrain reads (format ${SPLIT_FORMAT})`;
  if (!isCount(raw.total_bytes)) return 'gbrain_parts total_bytes must be a positive whole number';
  if (!isHex(raw.content_hash) || !isHex(raw.lead_sha256)) return 'gbrain_parts content_hash and lead_sha256 must be 64 lowercase hex digits';
  if (!isCount(raw.lead_bytes) || raw.lead_bytes > Math.min(raw.total_bytes, splitLimits.leadMax)) {
    return `gbrain_parts lead_bytes must be a positive whole number no larger than total_bytes and ${splitLimits.leadMax}`;
  }
  if (!Array.isArray(raw.parts) || raw.parts.length === 0 || raw.parts.length > splitLimits.partCountMax) {
    return `gbrain_parts parts must list 1 to ${splitLimits.partCountMax} part files`;
  }
  let dir: string | null = null;
  let sum = 0;
  const parts: SplitManifest['parts'] = [];
  for (const [i, part] of raw.parts.entries()) {
    if (!plainObject(part, PART_KEYS) || !isCount(part.bytes) || part.bytes > splitLimits.partMax || !isHex(part.sha256) || typeof part.path !== 'string') {
      return `gbrain_parts part ${i + 1} must hold exactly path, bytes (1 to ${splitLimits.partMax}) and sha256`;
    }
    const slash = part.path.indexOf('/');
    const partDir = part.path.slice(0, Math.max(slash, 0));
    const file = PART_FILE_RE.exec(part.path.slice(slash + 1));
    if (slash < 0 || !isPartsDirName(partDir) || (dir !== null && partDir !== dir) || !file || Number(file[1]) !== i + 1 || file[2] !== part.sha256.slice(0, 8)) {
      return `gbrain_parts part ${i + 1} path is not .<name>.gbparts/${String(i + 1).padStart(4, '0')}-<first 8 hex of its sha256>.gbpart`;
    }
    dir = partDir;
    sum += part.bytes;
    parts.push({ path: part.path, bytes: part.bytes, sha256: part.sha256 });
  }
  if (sum !== raw.total_bytes) return `gbrain_parts total_bytes ${raw.total_bytes} is not the sum of its parts (${sum})`;
  return { format: SPLIT_FORMAT, total_bytes: raw.total_bytes, content_hash: raw.content_hash, lead_bytes: raw.lead_bytes, lead_sha256: raw.lead_sha256, parts };
}

const incomplete = (reason: string): SplitHeadError => ({ error: { code: 'split_page_incomplete', reason } });

/**
 * Reads a head file's text (a leading BOM is dropped, as import drops it). Never throws: null when the file declares
 * no `gbrain_parts` key, an error when it declares one that is not a valid, cleanly removable manifest.
 */
export function parseHead(text: string): ParseHeadResult {
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const fence = locateFence(content);
  const keyLines = fence ? fence.lines.flatMap((line, i) => (PARTS_KEY_LINE.test(line) ? [i] : [])) : [];
  const data = frontmatterData(content);
  const declared = data !== null && Object.prototype.hasOwnProperty.call(data, PARTS_KEY);
  if (!declared && keyLines.length === 0) return null;
  if (!fence || !declared) return incomplete('the head declares gbrain_parts but its frontmatter does not parse to a manifest');
  if (keyLines.length !== 1) return incomplete('the head frontmatter must have exactly one unquoted top-level gbrain_parts: line');
  const at = keyLines[0]!;
  let end = at + 1;
  while (end < fence.lines.length && !TOP_LEVEL_LINE.test(fence.lines[end]!)) end++;
  const frontmatterWithoutParts = fence.opening + fence.lines.slice(0, at).join('') + fence.lines.slice(end).join('') + fence.closing;
  const keyData = frontmatterData('---\n' + fence.lines.slice(at, end).join('') + '---\n');
  if (!isDeepStrictEqual(keyData, { [PARTS_KEY]: data[PARTS_KEY] })) return incomplete('the gbrain_parts key is not one contiguous block of the head frontmatter');
  const { [PARTS_KEY]: _manifest, ...expected } = data;
  if (!isDeepStrictEqual(frontmatterData(frontmatterWithoutParts), expected)) {
    return incomplete('removing the gbrain_parts lines does not leave the rest of the head frontmatter as it parses');
  }
  const manifest = validateManifest(data[PARTS_KEY]);
  if (typeof manifest === 'string') return incomplete(manifest);
  return { manifest, frontmatterWithoutParts, headBody: content.slice(fence.bodyStart) };
}

/**
 * A page write's admission (put_page, capture, edit_page): content whose own frontmatter declares a top-level
 * `gbrain_parts` key is refused, since that key marks a split page head in Git and the page would be read back as one.
 * Sync reads heads through the split read path and never comes here.
 */
export function assertNoReservedPartsKey(content: string, sourceId: string): void {
  if (!content.includes(PARTS_KEY) || parseHead(content) === null) return;
  throw opError('split_head_content', 'The content is a split page head, not a page file, so it was not written.',
    'The content has a top-level gbrain_parts key: it is the head file of a split page (the first bytes of the page and the manifest of its part files), read and written back as if it were the whole page. '
    + 'Nothing was written. Write the whole page instead (gbrain get gives it whole), or rename the key if it is your own data. '
    + `If the key came from the stored page, that copy is the short head an older gbrain imported; ask the user to run gbrain sync --source ${sourceId} --no-pull on the brain host, which rebuilds the whole page.`,
    { docs: 'docs/guides/write-refusals.md#split_head_content' });
}

/** Refuses a page whose own frontmatter already has a top-level `gbrain_parts` key (the head reserves it). */
export function assertNoPartsKey(frontmatter: string): void {
  const data = frontmatterData(frontmatter);
  if ((data && Object.prototype.hasOwnProperty.call(data, PARTS_KEY)) || locateFence(frontmatter)?.lines.some(line => PARTS_KEY_LINE.test(line))) {
    throw new SplitLayoutError('frontmatter_has_parts_key', 'The page frontmatter has its own top-level gbrain_parts key, which a split page head reserves for its manifest; rename that key to store the page.');
  }
}

/**
 * The head file's text: the page's frontmatter block with `gbrain_parts` appended before its closing line, then the
 * head body. Proven reversible before it is returned: parseHead gives back the same frontmatter bytes, manifest and body.
 */
export function renderHead(plan: { frontmatter: string; manifest: SplitManifest; headBody: string }): string {
  assertNoPartsKey(plan.frontmatter);
  const closeStart = plan.frontmatter.lastIndexOf('\n', plan.frontmatter.length - 2) + 1;
  const head = plan.frontmatter.slice(0, closeStart) + dumpFrontmatterYaml({ [PARTS_KEY]: plan.manifest }) + plan.frontmatter.slice(closeStart) + plan.headBody;
  const parsed = parseHead(head);
  if (!parsed || 'error' in parsed || parsed.frontmatterWithoutParts !== plan.frontmatter || parsed.headBody !== plan.headBody
    || !isDeepStrictEqual(parsed.manifest, plan.manifest)) {
    throw new SplitLayoutError('head_not_reversible', 'The split page head does not parse back to the page frontmatter and manifest; nothing was written.');
  }
  return head;
}
