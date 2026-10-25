/**
 * GBRA-95: the streamed importer's fence pass (page-body/streamed-fences.ts) on its own.
 *
 * 1. Protects: over any chunking of the input stream the rewrite equals the whole-section transforms on each region
 *    (`preserveWithdrawnFenceRows` strikes a withdrawn row, Tier 1 normalizes a fixable fence) and leaves every byte
 *    outside the regions as it was; a fence region over FENCE_MAX_BYTES, closed or unclosed, refuses
 *    (`FenceRegionTooLarge`) holding no more than the bound plus one input chunk; marker text outside a closed fence
 *    refuses (`FenceMarkerOutsideFence`); a coordinated import's residual fence refuses typed invalid_fence
 *    (`FenceRegionRefused`) while a lenient one is kept as written with its warnings, at the section's line numbers;
 *    `assertNoHiddenFenceRows` (the guard of a remote write over an unread segmented body) refuses a body holding a
 *    takes fence or a non-world facts row and admits a world-only facts fence.
 * 2. Fails when: a region split across chunks is missed or rewritten twice, bytes between regions change, an oversized
 *    region is read whole before refusing, or a residual fence is stored in a coordinated import.
 * 3. PGLite (the transforms read the withdrawal ledger); no provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { preserveWithdrawnFenceRows } from '../../src/core/facts/withdrawal.ts';
import { fenceStep } from '../../src/core/fence-repair/tier1.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { FENCE_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { assertNoHiddenFenceRows, FenceMarkerOutsideFence, FenceRegionRefused, FenceRegionTooLarge, streamedFences, streamedFenceWork } from '../../src/core/page-body/streamed-fences.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const WITHDRAWN = 'Prefers the aisle seat';
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const facts = (rows: string[]) => `${FACTS_FENCE_BEGIN}\n${HEADER}${rows.join('\n')}\n${FACTS_FENCE_END}`;
const row = (n: number, claim: string, confidence = '1.0') => `| ${n} | ${claim} | preference | ${confidence} | world | medium | 2026-01-01 |  | chat |  |`;
const takes = `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | Widgets will sell | take | brain | 0.5 | 2026-07 | notes |\n${TAKES_FENCE_END}`;
const prose = (tag: string) => Array.from({ length: 40 }, (_, i) => `Paragraph ${tag} ${i}: notes on the launch plan, pricing and the review café.\n\n`).join('');
const ctx = { pageVisibility: 'world' as const };

let engine: BrainEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    `INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [WITHDRAWN]), TEST_WRITE_ATTRIBUTION));
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function* chunks(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, Math.min(at + size, bytes.length));
}
async function rewritten(text: string, size: number, mode: 'coordinated' | 'lenient' = 'lenient', region: 'truth' | 'timeline' = 'truth') {
  const fences = streamedFences(engine, { sourceId: 'default', slug: 'notes/streamed', pageId: null, mode, ctx });
  const parts: Buffer[] = [];
  for await (const part of fences.rewrite(chunks(Buffer.from(text, 'utf8'), size), region, true)) parts.push(Buffer.from(part));
  return { text: Buffer.concat(parts).toString('utf8'), fields: fences.fields() };
}
async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  throw new Error('the rewrite did not refuse');
}

describe('streamed fence pass', () => {
  test('equals the whole-section transforms over any chunking, bytes outside the regions untouched', async () => {
    const fixable = facts([row(1, 'Walks to work', '90%')]);
    const body = `# Notes\n\n${prose('a')}${facts([row(1, WITHDRAWN), row(2, 'Drinks tea')])}\n\n${prose('b')}${takes}\n\n\`inline code\` and a code block:\n\n\`\`\`\nconst x = 1;\n\`\`\`\n${prose('c')}`;
    const struck = await preserveWithdrawnFenceRows(engine, 'default', body, 'notes/streamed');
    expect(struck).not.toBe(body);
    expect(struck).toContain(`~~${WITHDRAWN}~~`);
    for (const size of [1, 2, 3, 7, 13, 64, 1000, 4096, body.length]) {
      expect({ size, text: (await rewritten(body, size)).text }).toEqual({ size, text: struck });
    }
    const normalized = fenceStep({ compiled_truth: fixable, timeline: '' }, ctx, { normalize: true });
    expect(normalized.status).toBe('normalized');
    const expected = normalized.status === 'normalized' ? normalized.page.compiled_truth : '';
    for (const size of [5, 333]) {
      const out = await rewritten(`${prose('d')}${fixable}\n${prose('e')}`, size);
      expect(out.text).toBe(`${prose('d')}${expected}\n${prose('e')}`);
      expect(out.fields.fences_normalized?.length).toBeGreaterThan(0);
    }
  }, 120_000);

  test('a residual fence refuses a coordinated import and is kept, with warnings at section lines, by a lenient one', async () => {
    const broken = facts([row(1, 'Drinks tea') + ' extra | cells | here |']);
    const body = `${prose('f')}${broken}\n`;
    const lines = prose('f').split('\n').length - 1;
    const refused = await refusalOf(() => rewritten(body, 97, 'coordinated'));
    expect(refused).toBeInstanceOf(FenceRegionRefused);
    expect((refused as FenceRegionRefused).refusal.code).toBe('invalid_fence');
    const kept = await rewritten(body, 97, 'lenient');
    expect(kept.text).toBe(body);
    expect(kept.fields.fence_issues?.length).toBeGreaterThan(0);
    for (const issue of kept.fields.fence_issues ?? []) if (issue.line !== null) expect(issue.line).toBeGreaterThan(lines);
  }, 60_000);

  test('marker text outside a closed fence refuses', async () => {
    for (const body of [`${prose('g')}<!-- gbrain:takes:begin -->\n| 1 | x |\n<!-- gbrain:takes:end -->\n`, `${prose('h')}${FACTS_FENCE_END}\n${prose('i')}`]) {
      expect(await refusalOf(() => rewritten(body, 11))).toBeInstanceOf(FenceMarkerOutsideFence);
    }
  }, 60_000);

  test('a remote write over a segmented page refuses while its body holds a takes fence or a non-world facts row', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    const filler = prose('j').repeat(400);
    const pages = {
      'notes/world-only': facts([row(1, 'Drinks tea')]),
      'notes/private-row': facts([row(1, 'Drinks tea').replace('| world |', '| private |')]),
      'notes/with-takes': takes,
    };
    for (const [slug, fence] of Object.entries(pages)) {
      await importFromContent(engine, slug, `---\ntitle: Remote merge\ntype: note\n---\n\n${filler}\n\n${fence}\n\n${filler}`, { noEmbed: true, sourceId: 'default' });
      const [page] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE slug=$1', [slug]);
      expect(page!.body_storage).toBe('segmented');
      const outcome = await assertNoHiddenFenceRows(engine, { id: Number(page!.id), slug, source_id: 'default' }).then(() => 'kept', (error: { code?: string }) => error.code);
      expect([slug, outcome]).toEqual([slug, slug === 'notes/world-only' ? 'kept' : 'page_body_segmented']);
    }
  }, 120_000);

  test('a fence over FENCE_MAX_BYTES, closed or unclosed, refuses holding at most the bound plus one chunk', async () => {
    const CHUNK = 1024 * 1024;
    const line = `| 1 | ${'x'.repeat(1000)} | fact | 1.0 | world | medium |  |  | chat |  |\n`;
    const filler = line.repeat(Math.ceil((FENCE_MAX_BYTES + 1) / line.length));
    for (const body of [`intro\n${FACTS_FENCE_BEGIN}\n${HEADER}${filler}${FACTS_FENCE_END}\nafter\n`, `intro\n${FACTS_FENCE_BEGIN}\n${HEADER}${filler}after\n`]) {
      streamedFenceWork.held = 0;
      const refused = await refusalOf(() => rewritten(body, CHUNK));
      expect(refused).toBeInstanceOf(FenceRegionTooLarge);
      expect(streamedFenceWork.held).toBeGreaterThan(FENCE_MAX_BYTES);
      expect(streamedFenceWork.held).toBeLessThanOrEqual(FENCE_MAX_BYTES + CHUNK);
    }
  }, 120_000);
});
