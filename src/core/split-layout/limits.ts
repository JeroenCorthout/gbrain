/**
 * Split git layout (Wave B PR 5, spec §9 option B): the size bounds of the format and the `sync.max_file_bytes` key.
 *
 * A page whose canonical file would exceed the threshold is stored as a head file at the page's path plus hidden part
 * files (see head.ts and plan.ts). The production values are constants; `__setSplitLimitsForTests` lets unit tests
 * use KB-sized fixtures and is the only way to change them.
 */
import { PAGE_MAX_BYTES, PUSH_SCAN_MAX_FILE_BYTES } from '../page-size-policy.ts';

/** Config key: canonical files (frontmatter plus body, UTF-8 bytes) above this many bytes are written split. */
export const SPLIT_MAX_FILE_BYTES_KEY = 'sync.max_file_bytes';
export const SPLIT_THRESHOLD_DEFAULT_BYTES = PAGE_MAX_BYTES;
export const SPLIT_THRESHOLD_MIN_BYTES = 1024 ** 2;
/** No canonical file write may exceed the whole-file secret-scan bound, so neither may the threshold. */
export const SPLIT_THRESHOLD_MAX_BYTES = PUSH_SCAN_MAX_FILE_BYTES;
/** A part ends at the last line break at or below this many bytes after its start when there is one. */
export const PART_TARGET_BYTES = 8 * 1024 ** 2;
/** No part is longer than this; a line longer than it is cut at a UTF-8 character boundary. */
export const PART_MAX_BYTES = 16 * 1024 ** 2;
/** The head's body keeps at most this many bytes of the page body (the lead). */
export const LEAD_MAX_BYTES = 64 * 1024;
/** Part names carry a four-digit index, so a page needing more parts is refused. */
export const PART_COUNT_MAX = 9999;

export interface SplitLimits {
  thresholdDefault: number;
  thresholdMin: number;
  thresholdMax: number;
  partTarget: number;
  partMax: number;
  leadMax: number;
  partCountMax: number;
}

const PRODUCTION: Readonly<SplitLimits> = Object.freeze({
  thresholdDefault: SPLIT_THRESHOLD_DEFAULT_BYTES,
  thresholdMin: SPLIT_THRESHOLD_MIN_BYTES,
  thresholdMax: SPLIT_THRESHOLD_MAX_BYTES,
  partTarget: PART_TARGET_BYTES,
  partMax: PART_MAX_BYTES,
  leadMax: LEAD_MAX_BYTES,
  partCountMax: PART_COUNT_MAX,
});
const limits: SplitLimits = { ...PRODUCTION };

/** The limits in effect: the production constants unless a test replaced some of them. */
export const splitLimits: Readonly<SplitLimits> = limits;

/** @internal Test seam: replace some limits (null restores production). Never called by product code. */
export function __setSplitLimitsForTests(overrides: Partial<SplitLimits> | null): void {
  Object.assign(limits, PRODUCTION, overrides ?? {});
}

/** The threshold a stored value puts in effect: unset or not a whole number gives the default; any other value is clamped. */
export function parseSplitThreshold(raw: string | null | undefined): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return limits.thresholdDefault;
  return Math.min(limits.thresholdMax, Math.max(limits.thresholdMin, Number(text)));
}

/** `gbrain config set`'s refusal of a `sync.max_file_bytes` value outside the accepted range (null: valid). */
export function splitThresholdConfigRefusal(value: string): string | null {
  const text = value.trim();
  if (/^\d+$/.test(text) && Number(text) >= limits.thresholdMin && Number(text) <= limits.thresholdMax) return null;
  return `${SPLIT_MAX_FILE_BYTES_KEY} must be a whole number of bytes from ${limits.thresholdMin} (1 MiB) to ${limits.thresholdMax} (25 MiB); nothing was written.`;
}

/** Bytes above which a page's canonical file is written as a head plus part files (`sync.max_file_bytes`). */
export async function splitThresholdBytes(engine: { getConfig(key: string): Promise<string | null> }): Promise<number> {
  return parseSplitThreshold(await engine.getConfig(SPLIT_MAX_FILE_BYTES_KEY));
}
