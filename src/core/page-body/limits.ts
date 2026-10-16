/**
 * Segmented page storage (Wave B): every size class bound, ceiling, retention
 * number and config key in one place. The product numbers (ceilings, version
 * retention) are open product calls; change them here and nowhere else.
 *
 * `pages.segmented_storage` defaults to `on`, and is effectively on only while
 * no recent writer predates segmented pages (`segmentedWriterBlockers`). While
 * it is off no page is newly segmented, every page stays inline up to
 * `PAGE_MAX_BYTES` (Wave A) and no code path below the inline threshold changes.
 */
import type { BrainEngine } from '../engine.ts';
import { PAGE_INLINE_MAX_BYTES, PAGE_MAX_BYTES } from '../page-size-policy.ts';
import type { RecentWriterVersion } from '../persistence/writer-versions.ts';

export { PAGE_INLINE_MAX_BYTES };

/** Config keys this module reads (registered in `KNOWN_CONFIG_KEYS`). */
export const PAGE_BODY_CONFIG_KEYS = {
  segmentedStorage: 'pages.segmented_storage',
  maxBytes: 'pages.max_bytes',
  flipRetireMaxRows: 'pages.flip_retire_max_rows',
  versionsMaxPerPage: 'versions.segmented_max_per_page',
  versionsMaxPinnedBytes: 'versions.segmented_max_pinned_bytes',
} as const;

/** A page is promoted to segmented storage when its body grows past this many UTF-8 bytes (`body_bytes > 1 MiB`). */
export const SEGMENTED_PROMOTE_ABOVE_BYTES = PAGE_INLINE_MAX_BYTES;
/** A segmented page is demoted to inline only when a write leaves its body at or under this many bytes (hysteresis). */
export const SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES = 512 * 1024;

/** Segmenter size bounds (UTF-8 bytes of the stored stream). */
export const SEGMENT_MIN_BYTES = 64 * 1024;
export const SEGMENT_TARGET_BYTES = 256 * 1024;
/** Rank-4 candidates (level-3+ headings, paragraph-ending blank lines) count once a segment passes this. */
export const SEGMENT_RANK4_BYTES = 384 * 1024;
/** Hard bound, matched by the `page_segment_texts.byte_len` CHECK. */
export const SEGMENT_MAX_BYTES = 1024 * 1024;

/** Raw prefix of each region kept on the page row (`truth_lead`, `timeline_lead`), equal to Wave A's bounded prefix. */
export const BODY_LEAD_BYTES = 64 * 1024;
/** Frontmatter of a streamed page must close within this many bytes of the file head. */
export const FRONTMATTER_HEAD_MAX_BYTES = 256 * 1024;
/** Pass 1 holds a line whole up to this many bytes; a longer line is read in slices of this size into bounded summaries. */
export const SCAN_LINE_BUFFER_BYTES = 64 * 1024;

/** Default segmented page ceiling per engine (`pages.max_bytes` when the switch is on). */
export const SEGMENTED_PAGE_CEILING_BYTES: Readonly<Record<'postgres' | 'pglite', number>> = {
  postgres: 256 * 1024 ** 2,
  pglite: 128 * 1024 ** 2,
};

/**
 * Rows one staging statement may carry, by payload bytes. A statement's transient memory is many times its payload
 * (driver hex text, protocol buffers, decoded texts, chunk strings): at 16 MiB a 100 MiB Postgres import peaked
 * ~400 MB above one at 4 MiB (scripts/bench-large-pages.ts), for 3% more ingest time.
 */
export const STAGE_BATCH_BYTES: Readonly<Record<'postgres' | 'pglite', number>> = {
  postgres: 4 * 1024 ** 2,
  pglite: 4 * 1024 ** 2,
};

/**
 * Chunk rows the generation flip deletes inside the publication transaction; above it the page publishes unsealed and a
 * projection job deletes the rest, this many rows per statement. Deleting leaves `idx_chunks_embedding` (HNSW) alone
 * (marking rows retired rewrote each entry: 20,000 embedded rows took 129 s on PGLite). `scripts/bench-large-pages.ts
 * --flip-only` measured 20,000 embedded rows at 0.88 s on PGLite and 0.51 s on Postgres, 40,000 at 1.83 s and 1.47 s,
 * under the publication's 5 s statement timeout.
 */
export const DEFAULT_FLIP_RETIRE_MAX_ROWS = 20_000;

/**
 * Snapshots of an inline page over the inline cap kept per page (Wave A). Each
 * one is a full copy of the body, so an append-heavy 24 MiB page would otherwise
 * grow history by 24 MiB per write. Snapshots at or under the inline cap, and
 * every snapshot of a small page, are never pruned.
 */
export const LARGE_PAGE_VERSIONS_KEPT = 5;

/** Segmented version retention: newest N kept, then oldest-first pruning while pinned bytes exceed max(floor, body_bytes). */
export const DEFAULT_SEGMENTED_VERSIONS_MAX_PER_PAGE = 50;
export const DEFAULT_SEGMENTED_VERSIONS_MAX_PINNED_BYTES = 64 * 1024 ** 2;

/** Unreferenced segment texts older than this are swept (insert-reference-before-GC grace). */
export const SEGMENT_TEXT_GC_GRACE_MS = 60 * 60 * 1000;
/** Body stagings expire after this long idle, and always after the hard limit. */
export const BODY_STAGING_IDLE_MS = 60 * 60 * 1000;
export const BODY_STAGING_HARD_MS = 24 * 60 * 60 * 1000;

/** A writer below `SEGMENTED_WRITER_FLOOR` keeps the switch off until this many days after its last committed request. */
export const SEGMENTED_WRITER_WINDOW_DAYS = 7;
/** The writer-version gate is read at most once per this many ms per engine (a transaction engine shares its root's entry). */
export const SEGMENTED_WRITER_GATE_TTL_MS = 60_000;

export interface PageBodyPolicy {
  /** The effective switch: `pages.segmented_storage` is not `off` and no recent writer predates segmented pages. */
  segmented: boolean;
  /** Largest page body admitted: `PAGE_MAX_BYTES` while the switch is off, else `pages.max_bytes` or the engine ceiling. */
  maxBytes: number;
  flipRetireMaxRows: number;
  versionsMaxPerPage: number;
  versionsMaxPinnedBytes: number;
}

type PolicyEngine = Pick<BrainEngine, 'getConfig' | 'kind' | 'executeRaw'>;

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The effective `pages.segmented_storage` when it is not configured. */
export const SEGMENTED_STORAGE_DEFAULT: 'on' | 'off' = 'on';

/** The configured `pages.segmented_storage`: unset means SEGMENTED_STORAGE_DEFAULT; an unrecognized value counts as `off`. */
export function parseSegmentedStorage(raw: string | null): 'on' | 'off' | 'unset' | 'invalid' {
  const value = (raw ?? '').trim();
  if (!value) return 'unset';
  if (/^(on|true|1|yes)$/i.test(value)) return 'on';
  return /^(off|false|0|no)$/i.test(value) ? 'off' : 'invalid';
}

let writerGate = new WeakMap<object, { at: number; blockers: RecentWriterVersion[] }>();

/**
 * Writers that committed a request in the last `SEGMENTED_WRITER_WINDOW_DAYS` days with a version below
 * `SEGMENTED_WRITER_FLOOR` or no stamp. Any one keeps segmented storage off. Cached per engine for
 * `SEGMENTED_WRITER_GATE_TTL_MS`; `fresh` (doctor) reads through.
 */
export async function segmentedWriterBlockers(engine: Pick<BrainEngine, 'executeRaw'>, opts: { fresh?: boolean } = {}): Promise<RecentWriterVersion[]> {
  let root: object = engine;
  for (let proto = Object.getPrototypeOf(root); proto && !Object.hasOwn(proto, 'constructor'); proto = Object.getPrototypeOf(proto)) root = proto;
  const cached = writerGate.get(root);
  if (!opts.fresh && cached && Date.now() - cached.at < SEGMENTED_WRITER_GATE_TTL_MS) return cached.blockers;
  const { recentWriterVersions, SEGMENTED_WRITER_FLOOR, writerVersionBelowFloor } = await import('../persistence/writer-versions.ts');
  const blockers = (await recentWriterVersions(engine, SEGMENTED_WRITER_WINDOW_DAYS)).filter(row => writerVersionBelowFloor(row.version, SEGMENTED_WRITER_FLOOR));
  writerGate.set(root, { at: Date.now(), blockers });
  return blockers;
}

/** Whether the configured switch asks for segmented storage, before the writer gate. */
export function segmentedStorageRequested(setting: ReturnType<typeof parseSegmentedStorage>): boolean {
  return setting === 'on' || (setting === 'unset' && SEGMENTED_STORAGE_DEFAULT === 'on');
}

/** Test seam: forget cached writer-gate reads. */
export function _resetSegmentedWriterGateForTests(): void {
  writerGate = new WeakMap();
}

/** The engine's default segmented ceiling. */
export function segmentedPageCeiling(kind: BrainEngine['kind']): number {
  return kind === 'pglite' ? SEGMENTED_PAGE_CEILING_BYTES.pglite : SEGMENTED_PAGE_CEILING_BYTES.postgres;
}

/**
 * Read the segmented-storage policy once per write. The switch is effectively on when it is configured `on`
 * (or unset while SEGMENTED_STORAGE_DEFAULT is `on`) and no recent writer predates segmented pages; an
 * unreadable gate counts as blocked. A configured `pages.max_bytes` never exceeds the engine ceiling.
 */
export async function readPageBodyPolicy(engine: PolicyEngine): Promise<PageBodyPolicy> {
  const read = (key: string) => engine.getConfig(key).catch(() => null);
  const [switchRaw, maxRaw, retireRaw, versionsRaw, pinnedRaw] = await Promise.all([
    read(PAGE_BODY_CONFIG_KEYS.segmentedStorage), read(PAGE_BODY_CONFIG_KEYS.maxBytes), read(PAGE_BODY_CONFIG_KEYS.flipRetireMaxRows),
    read(PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage), read(PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes),
  ]);
  const setting = parseSegmentedStorage(switchRaw);
  const segmented = segmentedStorageRequested(setting) && (await segmentedWriterBlockers(engine).catch(() => null))?.length === 0;
  const ceiling = segmentedPageCeiling(engine.kind);
  return {
    segmented,
    maxBytes: segmented ? Math.min(positiveInt(maxRaw, ceiling), ceiling) : PAGE_MAX_BYTES,
    flipRetireMaxRows: positiveInt(retireRaw, DEFAULT_FLIP_RETIRE_MAX_ROWS),
    versionsMaxPerPage: positiveInt(versionsRaw, DEFAULT_SEGMENTED_VERSIONS_MAX_PER_PAGE),
    versionsMaxPinnedBytes: positiveInt(pinnedRaw, DEFAULT_SEGMENTED_VERSIONS_MAX_PINNED_BYTES),
  };
}

/**
 * The storage class a write produces: segmented above the promote bound, inline
 * at or under the demote bound, and the current class in between (hysteresis).
 * Always inline while the switch is off, and for code and image pages.
 */
export function chooseBodyStorage(input: { policy: Pick<PageBodyPolicy, 'segmented'>; bodyBytes: number;
  current: 'inline' | 'segmented' | null; pageKind?: string | null }): 'inline' | 'segmented' {
  if (!input.policy.segmented || (input.pageKind && input.pageKind !== 'markdown')) return 'inline';
  if (input.bodyBytes > SEGMENTED_PROMOTE_ABOVE_BYTES) return 'segmented';
  if (input.bodyBytes <= SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES) return 'inline';
  return input.current === 'segmented' ? 'segmented' : 'inline';
}
