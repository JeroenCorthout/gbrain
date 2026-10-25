/**
 * Facts and takes fences of a streamed import (streamed-import.ts), one fence region at a time (GBRA-95). A body over
 * the single-string ceiling is never one string, so the import cannot normalize its fences or check them against
 * withdrawals over the whole body as `importFromContent` does. Instead each stored region's byte stream passes through
 * `rewrite`: the protected-region scan the segmenter stores (`protectedRegionScan`, region-scan.ts: the same markers,
 * pairing, `read` rule and truncated tail as `protectedRegions`) finds each facts or takes region; the bytes between
 * regions pass through unchanged, and each region is held whole, up to FENCE_MAX_BYTES, and replaced by its rewrite:
 *
 * 1. Tier 1 (`settleFenceRegion`) on a reader-visible region, with the region alone as its section;
 * 2. the purge and withdrawal overlay (`preserveWithdrawnFenceRows`: purged rows dropped, withdrawn rows struck), the
 *    transform forget and purge apply to a segmented page's stored regions (segment-rewrite.ts);
 * 3. the malformed-fence check (`assertFenceRegionWithdrawals`).
 *
 * A region over the bound, or an unclosed fence's tail over it, throws `FenceRegionTooLarge` once the bytes read past
 * its start exceed the bound; marker text between regions throws `FenceMarkerOutsideFence`; a coordinated import's
 * residual fence throws `FenceRegionRefused`. The import turns each into its result. Rewritten table rows start with `|`, so a rewrite never adds or removes a code-fence line and
 * the pass-1 fence trust stands (segment-rewrite.ts keeps the page's flags on the same grounds).
 */
import type { BrainEngine } from '../engine.ts';
import type { ContentRefusal } from '../import-screen.ts';
import type { FenceIssueWire } from '../fence-repair/tier1.ts';
import type { FenceCtx, FenceFix } from '../fence-repair/types.ts';
import { settleFenceRegion } from '../fence-repair/import-step.ts';
import { assertFenceRegionWithdrawals, preserveWithdrawnFenceRows } from '../facts/withdrawal.ts';
import { initialRegionScan, protectedRegionScan, utf8Len, type RegionScanState } from './region-scan.ts';
import { FENCE_MAX_BYTES } from './limits.ts';
import type { BodyRegion } from './types.ts';
import { segmentedFactsFenceView } from './segment-facts.ts';
import { opError } from '../ops/contract.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';

/** A fence region (or an unclosed fence's tail) longer than FENCE_MAX_BYTES: `bytes` is how much of it was read. */
export class FenceRegionTooLarge extends Error {
  constructor(readonly region: BodyRegion, readonly bytes: number) {
    super(`a fence in the ${region === 'truth' ? 'body' : 'timeline'} is at least ${bytes} bytes, over the ${FENCE_MAX_BYTES}-byte bound one fence is normalized and checked against withdrawals within`);
  }
}

/**
 * Fence marker text outside every closed facts or takes region (a two-dash near miss, a stray end marker, a mention):
 * Tier 1 judges it against the whole section (marker_form, missing_begin, marker_near_miss), so the import holds the
 * file as it did before fences were streamed.
 */
export class FenceMarkerOutsideFence extends Error {
  constructor(readonly region: BodyRegion) {
    super(`the ${region === 'truth' ? 'body' : 'timeline'} has facts or takes marker text outside a closed fence, which Tier 1 checks over the whole section`);
  }
}

/** A coordinated import's residual fence: the refusal `importFromContent` returns for the same fence. */
export class FenceRegionRefused extends Error {
  constructor(readonly refusal: ContentRefusal) { super(refusal.message); }
}

/**
 * Since streamed imports keep fences, a segmented body over the single-string ceiling (`bodyUnread`) can hold a takes
 * fence or non-world facts rows, which a remote write must carry over (`preserveProtectedTakes`,
 * `mergeHiddenFactRowsIntoBody`) and `fenceBody` reads as empty. A remote write over such a page therefore refuses
 * `page_body_segmented` when its live body holds a takes region or a facts fence with a non-world row (or one that does
 * not parse), as upload-streamed.ts refuses a remote upload replace: one manifest probe and the facts fence runs alone.
 */
export async function assertNoHiddenFenceRows(engine: BrainEngine, page: { id: number; slug: string; source_id: string }): Promise<void> {
  const [found] = await engine.executeRaw<{ takes: boolean }>(`SELECT EXISTS (SELECT 1 FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
    WHERE m.page_id = $1 AND m.staging_id IS NULL AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)
      AND m.protected_regions @> '[{"kind":"takes"}]'::jsonb) AS takes`, [page.id]);
  const view = found?.takes ? null : await segmentedFactsFenceView(engine, page);
  const hidden = found?.takes ? 'a takes fence'
    : view && [view.body, view.timeline].some(fence => fence.warnings.length > 0 || fence.facts.some(fact => fact.visibility !== 'world')) ? 'facts rows' : null;
  if (!hidden) return;
  throw opError('page_body_segmented', `Page ${page.slug} (source ${page.source_id}) stores a body over ${PAGE_MAX_BYTES} bytes holding ${hidden} that remote reads hide, and a remote write cannot carry them over, so nothing was written.`,
    'Ask the user to write this page locally on the brain host, where the hidden rows are kept.');
}

/** @internal For the bound tests: the most bytes the queue held past a region's start, and the regions rewritten. */
export const streamedFenceWork = { held: 0, regions: 0 };

const NEWLINE = 0x0a;
const MARKER_TEXT = /gbrain:(facts|takes):/;
const MARKER_CARRY = 'gbrain:takes:'.length - 1;

/** One stored region's bytes from `head` to `end`, taken in order. */
class ByteQueue {
  private parts: Uint8Array[] = [];
  head = 0;
  end = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.end += bytes.length;
  }

  /** Bytes `[head, to)`, removed from the queue. */
  take(to: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    while (this.head < to) {
      const part = this.parts[0]!;
      const n = Math.min(part.length, to - this.head);
      out.push(part.subarray(0, n));
      if (n === part.length) this.parts.shift(); else this.parts[0] = part.subarray(n);
      this.head += n;
    }
    return out;
  }
}

function newlines(parts: readonly Uint8Array[]): number {
  let n = 0;
  for (const part of parts) for (let at = part.indexOf(NEWLINE); at !== -1; at = part.indexOf(NEWLINE, at + 1)) n++;
  return n;
}

export interface StreamedFences {
  /** `stream` (one stored region, valid UTF-8) with each facts and takes region rewritten. */
  rewrite(stream: AsyncIterable<Uint8Array>, region: BodyRegion, trusted: boolean): AsyncIterable<Uint8Array>;
  /** The Tier 1 fixes and lenient warnings, for the import's result (`fences_normalized`, `fence_issues`). */
  fields(): { fences_normalized?: FenceFix[]; fence_issues?: FenceIssueWire[] };
}

export function streamedFences(engine: BrainEngine, input: { sourceId: string; slug: string; pageId: number | null; mode: 'coordinated' | 'lenient'; ctx: FenceCtx }): StreamedFences {
  const fixes: FenceFix[] = [];
  const warnings: FenceIssueWire[] = [];

  async function transform(text: string, region: BodyRegion, read: boolean, lineOffset: number): Promise<string> {
    const section = region === 'truth' ? 'body' : 'timeline';
    streamedFenceWork.regions++;
    let fence = text;
    if (read) {
      const settled = await settleFenceRegion(engine, { ...input, section, text, lineOffset });
      if (settled.refusal) throw new FenceRegionRefused(settled.refusal);
      fixes.push(...settled.fixes);
      warnings.push(...settled.warnings);
      fence = settled.text;
    }
    fence = await preserveWithdrawnFenceRows(engine, input.sourceId, fence, input.slug);
    await assertFenceRegionWithdrawals(engine, input.sourceId, fence, section, input.slug);
    return fence;
  }

  async function* rewrite(stream: AsyncIterable<Uint8Array>, region: BodyRegion, trusted: boolean): AsyncIterable<Uint8Array> {
    const queue = new ByteQueue();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let state: RegionScanState = initialRegionScan(trusted);
    let lines = 0;
    let carry = '';
    const pass = (to: number) => {
      const parts = queue.take(to);
      lines += newlines(parts);
      for (const part of parts) {
        const text = carry + Buffer.from(part).toString('latin1');
        if (MARKER_TEXT.test(text)) throw new FenceMarkerOutsideFence(region);
        carry = text.slice(-MARKER_CARRY);
      }
      return parts;
    };
    const bound = (start: number) => {
      streamedFenceWork.held = Math.max(streamedFenceWork.held, queue.end - start);
      if (queue.end - start > FENCE_MAX_BYTES) throw new FenceRegionTooLarge(region, queue.end - start);
    };
    async function* fence(start: number, end: number, read: boolean): AsyncIterable<Uint8Array> {
      yield* pass(start);
      const parts = queue.take(end);
      carry = '';
      const offset = lines;
      lines += newlines(parts);
      yield Buffer.from(await transform(Buffer.concat(parts).toString('utf8'), region, read, offset), 'utf8');
    }
    async function* scanned(chunk: string, final: boolean): AsyncIterable<Uint8Array> {
      const out = protectedRegionScan(state, chunk, final);
      state = out.state;
      for (const r of out.regions) {
        streamedFenceWork.held = Math.max(streamedFenceWork.held, r.end - r.start);
        if (r.end - r.start > FENCE_MAX_BYTES) throw new FenceRegionTooLarge(region, r.end - r.start);
        yield* fence(r.start, r.end, r.read);
      }
      const open = state.track.open?.start ?? state.track.truncatedAt;
      if (open !== null) {
        bound(open);
        yield* pass(open);
        return;
      }
      yield* pass(state.split.pos - (state.track.long ? utf8Len(state.track.long.carry) : 0));
    }
    for await (const bytes of stream) {
      queue.push(bytes);
      yield* scanned(decoder.decode(bytes, { stream: true }), false);
    }
    yield* scanned(decoder.decode(), true);
    if (state.track.truncatedAt !== null) yield* fence(state.track.truncatedAt, queue.end, true);
    yield* pass(queue.end);
  }

  return {
    rewrite,
    fields: () => ({ ...(fixes.length ? { fences_normalized: fixes } : {}), ...(warnings.length ? { fence_issues: warnings } : {}) }),
  };
}
