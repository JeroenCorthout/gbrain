/**
 * Wave B PR 5 lane 5d: `gbrain pages split-storage <slug> [--apply] [--resolve-head keep-edit|discard]`.
 *
 * 1. Protects: the preview reads the stored page and the files at its canonical path and reports the current layout
 *    (one file, or a head with its parts and their verdict), the threshold (`sync.max_file_bytes`) and what --apply
 *    would write (head, parts with names and sizes, unchanged parts, removals) from the page's canonical render, and it
 *    writes nothing: no file in the source, no request or page row change, no staged copy left behind. A head whose body
 *    was edited blocks the plain apply and is resolved with keep-edit (head frontmatter + edited lead without the notice
 *    + B[lead_bytes:]) or discard (the stored page). --apply republishes through the ordinary write door (the
 *    `managed_maintenance_split_relayout` intent, page row untouched; an unchanged page write would be a no-op that
 *    publishes no file) and reads the files back.
 * 2. Fails when: the subcommand does not exist (red before this lane), the preview writes anything, misreports a layout
 *    or plans different parts than planSplit, the keep-edit page differs from head frontmatter + edited lead + rest of
 *    the body, a blocked state applies, or --apply on an unchanged page publishes nothing (a no-op page write).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized fixtures through __setSplitLimitsForTests.
 *    The --apply cases depend on lane 5b (the write path laying out head + parts in the publication): until 5b is
 *    merged they are `test.failing`; the integrator flips them to `test`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { __setSplitLimitsForTests, planSplit, parseHead, partsDirFor, splitStagingDir, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { parseSplitStorageArgs, previewSplitStorage, runPagesSplitStorage, type SplitStorageReport } from '../src/commands/pages-split-storage.ts';
import { runPages } from '../src/commands/pages.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'notes/large-example';
const THRESHOLD = 4096;
const LIMITS = { thresholdMin: 1024, thresholdDefault: THRESHOLD, leadMax: 512, partTarget: 2048, partMax: 3072 };
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function body(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `Line ${String(i).padStart(4, '0')} of the acme-example field notes by alice-example.`).join('\n') + '\n';
}
const pageText = (lines: number) => `---\ntitle: Large example\ntype: note\n---\n${body(lines)}`;

/** Every file under the root (source-relative), with its sha256, for a no-write proof. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path).split(sep).join('/')] = sha(readFileSync(path));
    }
  };
  walk(root);
  return out;
}

async function dbState(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ requests: number; pages: number; revision: string | null; effects: number }>(
    `SELECT (SELECT count(*)::int FROM persistence_requests) AS requests, (SELECT count(*)::int FROM pages) AS pages,
            (SELECT count(*)::int FROM persistence_effects) AS effects,
            (SELECT updated_at::text FROM pages WHERE slug=$1) AS revision`, [SLUG]);
  return row;
}

async function stored(brain: ManagedBrain): Promise<string> {
  const snapshot = (await brain.engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  return serializePageToMarkdown(snapshot.page, snapshot.tags);
}

/** Lays the stored page's render out on disk as a split page (what the lane 5b write path produces). */
async function writeSplit(brain: ManagedBrain, text: string): Promise<{ head: string; parts: string[] }> {
  const path = join(brain.root, SLUG + '.md');
  const plan = await planSplit((async function* () { yield Buffer.from(text, 'utf8'); })(), { headPath: path });
  try {
    rmSync(partsDirFor(path), { recursive: true, force: true });
    mkdirSync(partsDirFor(path), { recursive: true });
    for (const part of plan.parts) {
      const chunks: Uint8Array[] = [];
      for await (const piece of plan.range(part.start, part.end)) chunks.push(piece);
      writeFileSync(join(dirname(path), part.path), Buffer.concat(chunks));
    }
    writeFileSync(path, plan.head());
    return { head: plan.head(), parts: plan.parts.map(part => part.name) };
  } finally { plan.dispose(); }
}

async function captureJson(run: () => Promise<void>): Promise<SplitStorageReport> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await run(); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as SplitStorageReport;
}

describe('parseSplitStorageArgs', () => {
  test('one slug, --source, --apply, --json and --resolve-head keep-edit|discard', () => {
    expect(parseSplitStorageArgs(['notes/a', '--source', 'source-a', '--apply', '--json', '--resolve-head=discard']))
      .toEqual({ slug: 'notes/a', source: 'source-a', apply: true, json: true, resolveHead: 'discard' });
    for (const bad of [[], ['a', 'b'], ['a', '--resolve-head', 'keep'], ['a', '--source'], ['a', '--purge'], ['a', '--source', 'x', '--source', 'y']]) {
      expect(() => parseSplitStorageArgs(bad)).toThrow();
    }
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const inBrain = (fn: (brain: ManagedBrain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(THRESHOLD));
    await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug: SLUG, content: pageText(120), request_id: randomUUID() } });
    await fn(brain);
  }, { databaseUrl });

  describe(`${backend}: gbrain pages split-storage`, () => {
    beforeAll(() => { __setSplitLimitsForTests(LIMITS); });
    afterAll(() => { __setSplitLimitsForTests(null); });
    beforeEach(() => { _resetCliExitVerdictForTests(); });
    afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

    test('the preview of an oversize single file plans head + parts from the canonical render and writes nothing', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        expect(Buffer.byteLength(render)).toBeGreaterThan(THRESHOLD);
        const filesBefore = tree(brain.root);
        const dbBefore = await dbState(brain.engine);
        const report = await captureJson(() => runPages(brain.engine, ['split-storage', SLUG, '--source', 'default', '--json']));
        expect(report.current).toMatchObject({ kind: 'single', path: SLUG + '.md', bytes: Buffer.byteLength(render), parts_dir: [] });
        // The file put_page wrote has the caller's frontmatter key order; the render has the stored order.
        expect(report.matches_render).toBe(false);
        expect(report.threshold_bytes).toBe(THRESHOLD);
        expect(report.canonical).toEqual({ bytes: Buffer.byteLength(render), sha256: sha(render) });
        const plan = await planSplit((async function* () { yield Buffer.from(render); })(), { headPath: join(brain.root, SLUG + '.md') });
        try {
          expect(report.target).toMatchObject({ layout: 'split', file_bytes: Buffer.byteLength(render), head: { path: SLUG + '.md', bytes: Buffer.byteLength(plan.head()) }, removals: [], changes: true });
          expect(report.target!.parts).toEqual(plan.parts.map(part => ({ name: part.name, path: `notes/${part.path}`, bytes: part.bytes, sha256: part.sha256, unchanged: false })));
          expect(report.target!.parts.length).toBeGreaterThan(1);
          expect(report.target!.writes).toEqual([SLUG + '.md', ...plan.parts.map(part => `notes/${part.path}`)]);
        } finally { plan.dispose(); }
        expect(report.apply_command).toEqual(['gbrain', 'pages', 'split-storage', SLUG, '--source', 'default', '--apply']);
        expect(report.blocked).toBeNull();
        expect(tree(brain.root)).toEqual(filesBefore);
        expect(await dbState(brain.engine)).toEqual(dbBefore);
        expect(readdirSync(splitStagingDir())).toEqual([]);
      });
    });

    test('a split page in its layout has nothing to write; a raised threshold plans the conversion back to one file', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        const split = await writeSplit(brain, render);
        const quiet = (await previewSplitStorage(brain.engine, 'default', SLUG)).report;
        expect(quiet.current).toMatchObject({ kind: 'split', verdict: { ok: true } });
        expect(quiet.current.parts!.map(part => part.name)).toEqual(split.parts);
        expect(quiet.matches_render).toBe(true);
        expect(quiet.target).toMatchObject({ layout: 'split', writes: [], removals: [], changes: false });
        expect(quiet.target!.parts.every(part => part.unchanged)).toBe(true);
        expect(quiet.apply_command).toBeNull();

        await brain.engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, String(Buffer.byteLength(render) + 10));
        const filesBefore = tree(brain.root);
        const back = (await previewSplitStorage(brain.engine, 'default', SLUG)).report;
        expect(back.target).toMatchObject({ layout: 'single', head: null, parts: [], writes: [SLUG + '.md'], changes: true,
          removals: split.parts.map(name => `notes/.large-example.gbparts/${name}`) });
        expect(tree(brain.root)).toEqual(filesBefore);
      });
    });

    test('an edited head blocks the plain apply; keep-edit plans head frontmatter + edited lead + B[lead_bytes:], discard plans the stored page', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        await writeSplit(brain, render);
        const headPath = join(brain.root, SLUG + '.md');
        const parsed = parseHead(readFileSync(headPath, 'utf8'));
        if (!parsed || 'error' in parsed) throw new Error('fixture head does not parse');
        const editedHead = readFileSync(headPath, 'utf8').replace('title: Large example', 'title: Large example (edited)').replace('Line 0000', 'Line ZERO');
        writeFileSync(headPath, editedHead);
        const filesBefore = tree(brain.root);
        const dbBefore = await dbState(brain.engine);

        const plain = (await previewSplitStorage(brain.engine, 'default', SLUG)).report;
        expect(plain.current.verdict).toMatchObject({ ok: false, code: 'split_head_modified' });
        expect(plain.blocked?.code).toBe('split_head_modified');
        expect(plain.apply_command).toBeNull();
        await expect(runPages(brain.engine, ['split-storage', SLUG, '--source', 'default', '--apply', '--json'])).rejects.toMatchObject({ detail: 'split_head_modified' });

        const bodyStart = render.indexOf('\n---\n') + 5;
        const lead = render.slice(bodyStart, bodyStart + parsed.manifest.lead_bytes);
        const expected = render.slice(0, bodyStart).replace('title: Large example', 'title: Large example (edited)')
          + lead.replace('Line 0000', 'Line ZERO') + render.slice(bodyStart + parsed.manifest.lead_bytes);
        const keep = await previewSplitStorage(brain.engine, 'default', SLUG, 'keep-edit');
        try {
          expect(keep.report.blocked).toBeNull();
          expect(keep.report.kept_edit).toEqual({ file_bytes: Buffer.byteLength(expected), file_sha256: sha(expected),
            kept_lead_bytes: Buffer.byteLength(lead), replaced_lead_bytes: parsed.manifest.lead_bytes });
          expect(keep.report.target).toMatchObject({ layout: 'split', file_sha256: sha(expected), changes: true });
          expect(keep.report.apply_command).toEqual(['gbrain', 'pages', 'split-storage', SLUG, '--source', 'default', '--resolve-head', 'keep-edit', '--apply']);
        } finally { keep.dispose(); }

        const discard = (await previewSplitStorage(brain.engine, 'default', SLUG, 'discard')).report;
        expect(discard.target).toMatchObject({ layout: 'split', file_sha256: sha(render), changes: true });
        expect(discard.target!.writes).toEqual([SLUG + '.md']);

        expect(tree(brain.root)).toEqual(filesBefore);
        expect(await dbState(brain.engine)).toEqual(dbBefore);
        expect(readdirSync(splitStagingDir())).toEqual([]);
      });
    });

    test('resolve-head on a page whose head was not edited, and a missing part, are refused before anything is written', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        const split = await writeSplit(brain, render);
        expect((await previewSplitStorage(brain.engine, 'default', SLUG, 'keep-edit')).report.blocked?.code).toBe('nothing_to_resolve');
        rmSync(join(brain.root, 'notes/.large-example.gbparts', split.parts[1]!));
        const filesBefore = tree(brain.root);
        const report = (await previewSplitStorage(brain.engine, 'default', SLUG)).report;
        expect(report.current.verdict).toMatchObject({ ok: false, code: 'split_page_incomplete', missing: [`.large-example.gbparts/${split.parts[1]}`] });
        expect(report.blocked?.code).toBe('split_page_incomplete');
        await expect(runPagesSplitStorage(brain.engine, [SLUG, '--source', 'default', '--apply'])).rejects.toMatchObject({ detail: 'split_page_incomplete' });
        expect(tree(brain.root)).toEqual(filesBefore);
      });
    });

    test('--apply publishes the stored page\'s file through the relayout intent with the page row untouched', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        const revision = (await brain.engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
        const report = await captureJson(() => runPagesSplitStorage(brain.engine, [SLUG, '--source', 'default', '--apply', '--json']));
        expect(report.applied?.status).toBe('relaid_out');
        const [request] = await brain.engine.executeRaw<{ kind: string }>(
          "SELECT intent->>'kind' AS kind FROM persistence_requests WHERE request_id=$1", [report.applied!.request_id]);
        expect(request).toMatchObject({ kind: 'managed_maintenance_split_relayout' });
        expect(await stored(brain)).toBe(render);
        expect((await brain.engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision).toBe(revision);
        expect(currentExitCode()).toBe(report.applied!.laid_out ? 0 : 1);
      });
    });

    // Lane 5b (write path) lays out head + parts in the publication. Until it is merged these fail; flip to `test`.
    test.failing('--apply converts an oversize single file to head + parts through the write door', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        const revision = (await brain.engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
        const report = await captureJson(() => runPagesSplitStorage(brain.engine, [SLUG, '--source', 'default', '--apply', '--json']));
        expect(report.applied?.laid_out).toBe(true);
        const after = (await previewSplitStorage(brain.engine, 'default', SLUG)).report;
        expect(after.current).toMatchObject({ kind: 'split', verdict: { ok: true } });
        expect(after.matches_render).toBe(true);
        expect(after.current.parts!.map(part => part.name)).toEqual(report.target!.parts.map(part => part.name));
        expect(await stored(brain)).toBe(render);
        expect((await brain.engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision).toBe(revision);
      });
    });

    test.failing('--resolve-head keep-edit --apply publishes the edit; discard --apply rewrites the head from the stored page', async () => {
      await inBrain(async brain => {
        const render = await stored(brain);
        await writeSplit(brain, render);
        const headPath = join(brain.root, SLUG + '.md');
        writeFileSync(headPath, readFileSync(headPath, 'utf8').replace('Line 0000', 'Line ZERO'));
        const discard = await captureJson(() => runPagesSplitStorage(brain.engine, [SLUG, '--source', 'default', '--resolve-head', 'discard', '--apply', '--json']));
        expect(discard.applied?.laid_out).toBe(true);
        expect(await stored(brain)).toBe(render);

        writeFileSync(headPath, readFileSync(headPath, 'utf8').replace('Line 0000', 'Line ZERO'));
        const keep = await captureJson(() => runPagesSplitStorage(brain.engine, [SLUG, '--source', 'default', '--resolve-head', 'keep-edit', '--apply', '--json']));
        expect(keep.applied?.laid_out).toBe(true);
        expect(await stored(brain)).toBe(render.replace('Line 0000', 'Line ZERO'));
        expect(existsSync(headPath) && statSync(headPath).size < THRESHOLD).toBe(true);
      });
    });
  });
}
