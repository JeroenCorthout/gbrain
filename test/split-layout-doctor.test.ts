/**
 * Wave B PR 5 lane 5d: doctor `split_layout` and `oversize_canonical_file`.
 *
 * 1. Protects: `split_layout` warns (never fails) on stray parts directories (no head, a head that is not a split
 *    head) and on split pages sync holds (`split_page_incomplete`, `split_head_modified` in the source's current
 *    incarnation only), with counts, a sample and a fix; a valid split head with its parts is not stray and its head is
 *    not an oversize file. `oversize_canonical_file` warns on a single canonical `.md` over `sync.max_file_bytes` and
 *    names `gbrain pages split-storage <slug> --source <id>`. A remote caller gets counts without paths; the walk stops
 *    at its bound and says so.
 * 2. Fails when: the checks are not registered (red before this lane), a stray directory or a held split page is
 *    missed, another hold code or a stale incarnation is counted, a head counts as oversize, or a check goes red.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized threshold through __setSplitLimitsForTests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { __setSplitWalkLimitForTests, splitLayoutEntry } from '../src/commands/doctor/checks/split-layout.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { writeGitHold, type GitHoldCode } from '../src/core/persistence/sync-holds.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, planSplit, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const THRESHOLD = 4096;
const LIMITS = { thresholdMin: 1024, thresholdDefault: THRESHOLD, leadMax: 512, partTarget: 2048, partMax: 3072 };
const body = (lines: number) => Array.from({ length: lines }, (_, i) => `Row ${i} of the acme-example ledger kept by alice-example.`).join('\n') + '\n';
const page = (title: string, lines: number) => `---\ntitle: ${title}\ntype: note\n---\n${body(lines)}`;

async function run(brain: ManagedBrain, extra: Partial<DoctorContext> = {}): Promise<Record<string, Check>> {
  const ctx = { engine: brain.engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined, tier: 'standard', ...extra } as unknown as DoctorContext;
  const checks = await splitLayoutEntry.run(ctx) as Check[];
  return Object.fromEntries(checks.map(check => [check.name, check]));
}

async function put(brain: ManagedBrain, slug: string, content: string): Promise<void> {
  await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
}

/** The stored page laid out on disk as a split head + parts (what the lane 5b write path produces). */
async function writeSplit(brain: ManagedBrain, slug: string): Promise<void> {
  const snapshot = (await brain.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const path = join(brain.root, slug + '.md');
  const plan = await planSplit((async function* () { yield Buffer.from(serializePageToMarkdown(snapshot.page, snapshot.tags)); })(), { headPath: path });
  try {
    mkdirSync(partsDirFor(path), { recursive: true });
    for (const part of plan.parts) {
      const chunks: Uint8Array[] = [];
      for await (const piece of plan.range(part.start, part.end)) chunks.push(piece);
      writeFileSync(join(dirname(path), part.path), Buffer.concat(chunks));
    }
    writeFileSync(path, plan.head());
  } finally { plan.dispose(); }
}

async function hold(brain: ManagedBrain, path: string, code: string, incarnation?: string): Promise<void> {
  const [source] = await brain.engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  await brain.engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: incarnation ?? source!.incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''),
    page_id: null, code: code as GitHoldCode, message: `held ${code}`, upstream_version: 'v1', observed_at: new Date().toISOString(), run_id: 'run-1', mode: 'managed',
    meta: { recovery_version: 1 } }));
}

describe('split layout doctor registration', () => {
  test('one entry emits both checks, placed before search_mode, both brain checks', () => {
    expect(splitLayoutEntry.emits).toEqual(['split_layout', 'oversize_canonical_file']);
    const names = DOCTOR_CHECK_REGISTRY.map(entry => entry.name);
    expect(names.indexOf('split_layout')).toBe(names.length - 2);
    expect(categorizeCheck('split_layout')).toBe('brain');
    expect(categorizeCheck('oversize_canonical_file')).toBe('brain');
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const inBrain = (fn: (brain: ManagedBrain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(THRESHOLD));
    await fn(brain);
  }, { databaseUrl });

  describe(`${backend}: doctor split_layout and oversize_canonical_file`, () => {
    beforeAll(() => { __setSplitLimitsForTests(LIMITS); });
    afterAll(() => { __setSplitLimitsForTests(null); __setSplitWalkLimitForTests(null); });

    test('a checkout with small pages and a valid split page is ok on both checks', async () => {
      await inBrain(async brain => {
        await put(brain, 'notes/small-example', page('Small', 3));
        await put(brain, 'notes/split-example', page('Split', 120));
        await writeSplit(brain, 'notes/split-example');
        const checks = await run(brain);
        expect(checks.split_layout).toMatchObject({ status: 'ok', details: { stray_parts_dirs: 0, held_split_pages: 0, sources_walked: ['default'], truncated: false } });
        expect(checks.oversize_canonical_file).toMatchObject({ status: 'ok', details: { count: 0, threshold_bytes: THRESHOLD } });
      });
    });

    test('stray parts directories warn with their reason; an oversize single file warns with the split-storage preview', async () => {
      await inBrain(async brain => {
        await put(brain, 'notes/plain-example', page('Plain', 3));
        // Written under a raised threshold, so it stays one oversize file; the write path (lane 5b) would split it.
        await brain.engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(1024 ** 2));
        await put(brain, 'notes/big-example', page('Big', 120));
        await brain.engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(THRESHOLD));
        await put(brain, 'notes/split-example', page('Split', 120));
        await writeSplit(brain, 'notes/split-example');
        mkdirSync(join(brain.root, 'notes/.orphan-example.gbparts'), { recursive: true });
        writeFileSync(join(brain.root, 'notes/.orphan-example.gbparts/0001-deadbeef.gbpart'), 'left behind\n');
        mkdirSync(join(brain.root, 'notes/.plain-example.gbparts'), { recursive: true });
        const checks = await run(brain);
        expect(checks.split_layout!.status).toBe('warn');
        expect(checks.split_layout!.details).toMatchObject({ stray_parts_dirs: 2, held_split_pages: 0 });
        expect((checks.split_layout!.details as any).stray_sample).toEqual(expect.arrayContaining([
          { source_id: 'default', path: 'notes/.orphan-example.gbparts', reason: 'no_head' },
          { source_id: 'default', path: 'notes/.plain-example.gbparts', reason: 'head_not_split' },
        ]));
        expect(checks.split_layout!.fix).toMatchObject({ ask_user: true });
        expect(checks.oversize_canonical_file).toMatchObject({ status: 'warn', details: { count: 1 } });
        expect((checks.oversize_canonical_file!.details as any).sample).toEqual([{ source_id: 'default', path: 'notes/big-example.md', bytes: expect.any(Number), slug: 'notes/big-example' }]);
        expect(checks.oversize_canonical_file!.fix?.argv).toEqual(['gbrain', 'pages', 'split-storage', 'notes/big-example', '--source', 'default', '--json']);

        const remote = await run(brain, { remote: true });
        expect(remote.split_layout!.details).toMatchObject({ stray_parts_dirs: 2, stray_sample: [] });
        expect(remote.split_layout!.message).not.toContain('orphan-example');
        expect((remote.oversize_canonical_file!.details as any).sample).toEqual([]);

        __setSplitWalkLimitForTests(1);
        try {
          const bounded = await run(brain);
          expect(bounded.split_layout!.details).toMatchObject({ truncated: true, exact: false, limit: 1 });
          expect(['ok', 'warn']).toContain(bounded.oversize_canonical_file!.status);
        } finally { __setSplitWalkLimitForTests(null); }
      });
    });

    test('held split pages of the current incarnation warn with a count, a sample and a fix; other holds are not counted', async () => {
      await inBrain(async brain => {
        await hold(brain, 'notes/edited-example.md', 'split_head_modified');
        await hold(brain, 'notes/short-example.md', 'split_page_incomplete');
        await hold(brain, 'notes/frontmatter-example.md', 'invalid_frontmatter');
        await hold(brain, 'notes/old-example.md', 'split_page_incomplete', randomUUID());
        const checks = await run(brain);
        const layout = checks.split_layout!;
        expect(layout.status).toBe('warn');
        expect(layout.details).toMatchObject({ held_split_pages: 2, stray_parts_dirs: 0 });
        const sample = (layout.details as any).held_sample as Array<{ path: string; code: string; slug: string }>;
        expect(sample.map(row => row.path).sort()).toEqual(['notes/edited-example.md', 'notes/short-example.md']);
        expect(sample.find(row => row.path === 'notes/edited-example.md')).toMatchObject({ code: 'split_head_modified', slug: 'notes/edited-example' });
        expect(layout.fix?.argv).toEqual(sample[0]!.code === 'split_head_modified'
          ? ['gbrain', 'pages', 'split-storage', 'notes/edited-example', '--source', 'default', '--resolve-head', 'keep-edit', '--json']
          : ['gbrain', 'sources', 'status', 'default', '--json']);
        expect(layout.message).toContain('2 split page(s) held by sync');
      });
    });
  });
}
