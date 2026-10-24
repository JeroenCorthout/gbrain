import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { inlineExportMarkdown, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown, exportBodyLedger, type ExportSnapshot } from '../src/core/export-snapshot.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { compareInlineExportFile, compareSegmentedExportFile, DATABASE_CANONICAL_KEY, exportIneligibility, ignoredPaths } from '../src/core/persistence/canonical-export.ts';
import { censusSource, parseCanonicalArgs } from '../src/commands/sources-canonical.ts';
import { databaseCanonicalEntry } from '../src/commands/doctor/checks/database-canonical.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const policy = { mirror: false, storage: null, ignored: new Set<string>() };
const fact = (claim: string) => ({ rowNum: 1, claim, kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const, active: true, context: '' });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString();
}

for (const backend of testBackends()) describe(`database-canonical wave 1: ${backend}`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
    await engine.executeRaw("UPDATE sources SET local_path=NULL, config='{}'::jsonb WHERE id='default'");
    await engine.unsetConfig(DATABASE_CANONICAL_KEY);
  });

  const snapshotOf = (slug: string) => engine.transaction(async tx => {
    const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text, source_id, slug FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    return readExportPage(tx, key!, await readExportWithdrawals(tx, 'default'));
  });

  test('the export rendering of every page shape compares equal to its export view (the equality contract)', async () => {
    const shapes: Array<[string, Parameters<BrainEngine['putPage']>[1], string[]]> = [
      ['eq/empty', { type: 'note', title: 'Empty fields', compiled_truth: '', timeline: '' }, []],
      ['eq/body-and-timeline', { type: 'concept', title: 'Synthetic concept', compiled_truth: 'Body line one.\n\nBody line two.', timeline: '- 2026-01-02: an event' }, ['alpha', 'beta']],
      ['eq/rich-frontmatter', { type: 'person', title: 'Alice Example', compiled_truth: 'Notes.', timeline: '',
        frontmatter: { aliases: ['A. Example'], score: 3, nested: { a: [1, 'two', { three: true }] }, empty: '', validate: false } }, ['people']],
      ['eq/double--hyphen', { type: 'note', title: 'Stamped slug', compiled_truth: 'Needs a slug stamp.', timeline: '' }, []],
      ['eq/facts', { type: 'note', title: 'Facts', compiled_truth: renderFactsTable([fact('A synthetic claim')]), timeline: '' }, []],
    ];
    for (const [slug, page, tags] of shapes) {
      await engine.putPage(slug, page);
      for (const tag of tags) await engine.addTag(slug, tag);
      const snapshot = await snapshotOf(slug);
      const rendered = Buffer.from(inlineExportMarkdown(snapshot));
      expect([slug, compareInlineExportFile(rendered, `${slug}.md`, snapshot)]).toEqual([slug, { state: 'equal' }]);
    }
  });

  test('an empty database title cannot survive a file round trip (the parse derives one from the slug), so it compares as differing', async () => {
    await engine.putPage('eq/untitled', { type: 'note', title: '', compiled_truth: 'Body.', timeline: '' });
    const snapshot = await snapshotOf('eq/untitled');
    expect(compareInlineExportFile(Buffer.from(inlineExportMarkdown(snapshot)), 'eq/untitled.md', snapshot)).toEqual({ state: 'differs', paths: ['/title'] });
  });

  test('an edited, a broken and a stamp-less file compare as the contract says', async () => {
    await engine.putPage('cmp/page', { type: 'note', title: 'Compared', compiled_truth: 'Original body.', timeline: '', frontmatter: { validate: false } });
    const snapshot = await snapshotOf('cmp/page');
    const rendered = inlineExportMarkdown(snapshot);
    expect(compareInlineExportFile(Buffer.from(rendered.replace('Original body.', 'Edited body.')), 'cmp/page.md', snapshot))
      .toEqual({ state: 'differs', paths: ['/compiled_truth'] });
    expect(compareInlineExportFile(Buffer.from('---\ntitle: [unclosed\n---\nBody\n'), 'cmp/page.md', snapshot)).toEqual({ state: 'unparseable' });
    expect(compareInlineExportFile(Buffer.from([0xff, 0xfe, 0x00]), 'cmp/page.md', snapshot)).toEqual({ state: 'unparseable' });
    // #6429: the grandfather stamp lives only in the database; a file without it is not an edit.
    expect(rendered).toContain('validate: false');
    expect(compareInlineExportFile(Buffer.from(rendered.replace('validate: false\n', '')), 'cmp/page.md', snapshot)).toEqual({ state: 'equal' });
  });

  test('a forgotten fact renders withdrawn, and a file still showing it active differs', async () => {
    const body = renderFactsTable([fact('Forgotten synthetic claim')]);
    await engine.putPage('forget/inline', { type: 'note', title: 'Inline', compiled_truth: body, timeline: '' });
    const before = inlineExportMarkdown(await snapshotOf('forget/inline'));
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['Forgotten synthetic claim']);
    const after = await snapshotOf('forget/inline');
    const rendered = inlineExportMarkdown(after);
    expect(parseFactsFence(before).facts[0]!.active).toBe(true);
    expect(parseFactsFence(rendered).facts[0]!.active).toBe(false);
    expect(compareInlineExportFile(Buffer.from(rendered), 'forget/inline.md', after)).toEqual({ state: 'equal' });
    expect(compareInlineExportFile(Buffer.from(before), 'forget/inline.md', after).state).toBe('differs');
  });

  test('a segmented page compares by the streamed digest of its export, withdrawals included', async () => {
    const truth = renderFactsTable([fact('Segmented synthetic claim')]) + '\n' + 'Segmented filler line.\n'.repeat(50);
    await createSegmentedPage(engine, { slug: 'seg/page', truth, timeline: '- 2026-01-02: segmented event\n' });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-seg-')));
    try {
      const write = async (name: string, snapshot: ExportSnapshot) => {
        const chunks: Buffer[] = [];
        await engine.transaction(async tx => {
          for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(snapshot.page.slug, await readExportWithdrawals(tx, 'default')), segmentedExportHead(snapshot))) {
            chunks.push(Buffer.from(piece));
          }
        });
        writeFileSync(join(dir, name), Buffer.concat(chunks));
        return join(dir, name);
      };
      const compare = (path: string, snapshot: ExportSnapshot) => engine.transaction(async tx => compareSegmentedExportFile(tx, path, snapshot, await readExportWithdrawals(tx, 'default')));
      const beforeFile = await write('before.md', await snapshotOf('seg/page'));
      expect(await compare(beforeFile, await snapshotOf('seg/page'))).toEqual({ state: 'equal' });
      await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))", ['Segmented synthetic claim']);
      const after = await snapshotOf('seg/page');
      expect(await compare(beforeFile, after)).toEqual({ state: 'differs', paths: ['/body'] });
      expect(await compare(await write('after.md', after), after)).toEqual({ state: 'equal' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('eligibility: mirrors, private and alias-private pages, database-only pages, db_only prefixes and ignored paths never export', () => {
    const page = (frontmatter: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ slug: 'notes/x', type: 'note', frontmatter, ...extra });
    expect(exportIneligibility(page(), 'notes/x.md', policy)).toBeNull();
    expect(exportIneligibility(page(), 'notes/x.md', { ...policy, mirror: true })).toBe('mirror_source');
    expect(exportIneligibility(page({ visibility: 'private' }), 'notes/x.md', policy)).toBe('private');
    expect(exportIneligibility(page({ access: 'private' }), 'notes/x.md', policy)).not.toBeNull();
    expect(exportIneligibility(page({}, { database_only_reason: 'detached' }), 'notes/x.md', policy)).toBe('database_only');
    expect(exportIneligibility(page(), 'notes/x.md', { ...policy, storage: { db_tracked: [], db_only: ['notes/'] } })).toBe('db_only_prefix');
    expect(exportIneligibility(page(), 'notes/x.md', { ...policy, ignored: new Set(['notes/x.md']) })).toBe('git_ignored');
  });

  test('ignoredPaths reports untracked ignored paths only, and an empty answer is not a failure', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-ignore-')));
    try {
      git(root, 'init', '-q');
      writeFileSync(join(root, '.gitignore'), 'images/\n');
      mkdirSync(join(root, 'images'));
      writeFileSync(join(root, 'images', 'tracked.md'), 'x');
      git(root, 'add', '-f', '.gitignore', 'images/tracked.md');
      git(root, 'commit', '-qm', 'init');
      expect(await ignoredPaths(root, ['images/a.md', 'images/tracked.md', 'notes/b.md'])).toEqual(new Set(['images/a.md']));
      expect(await ignoredPaths(root, ['notes/b.md'])).toEqual(new Set());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the census refuses while the gate is off and counts eligibility and file states when it is on', async () => {
    await expect(censusSource(engine, 'default', 20)).rejects.toMatchObject({ code: 'database_canonical_disabled' });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-census-')));
    try {
      git(root, 'init', '-q');
      writeFileSync(join(root, '.gitignore'), 'images/\n');
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
      await engine.putPage('notes/equal', { type: 'note', title: 'Equal', compiled_truth: 'Same body.', timeline: '' });
      await engine.putPage('notes/edited', { type: 'note', title: 'Edited', compiled_truth: 'Database body.', timeline: '' });
      await engine.putPage('notes/missing', { type: 'note', title: 'Missing', compiled_truth: 'No file.', timeline: '' });
      await engine.putPage('notes/private', { type: 'note', title: 'Private', compiled_truth: 'Secret.', timeline: '', frontmatter: { visibility: 'private' } });
      await engine.putPage('images/scan', { type: 'note', title: 'Ignored', compiled_truth: 'Image note.', timeline: '' });
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, 'notes', 'equal.md'), inlineExportMarkdown(await snapshotOf('notes/equal')));
      writeFileSync(join(root, 'notes', 'edited.md'), inlineExportMarkdown(await snapshotOf('notes/edited')).replace('Database body.', 'File body.'));
      const census = await censusSource(engine, 'default', 20);
      expect(census).toMatchObject({ status: 'census', source_id: 'default', checkout: root, pages: 5, eligible: 3, ignore_check: 'ok',
        ineligible: { private: 1, git_ignored: 1, mirror_source: 0, alias_private: 0, database_only: 0, db_only_prefix: 0 },
        files: { equal: 1, differs: 1, missing: 1, unparseable: 0, unsafe_path: 0 } });
      expect(census.sample).toEqual([{ slug: 'notes/edited', path: 'notes/edited.md', state: 'differs', fields: ['/compiled_truth'] }]);
      await engine.executeRaw("UPDATE sources SET config=jsonb_build_object('mirror_read_only',true) WHERE id='default'");
      expect((await censusSource(engine, 'default', 20)).ineligible.mirror_source).toBe(5);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the doctor check is green with the gate off and on', async () => {
    const ctx = { engine } as never;
    expect(await databaseCanonicalEntry.run(ctx)).toMatchObject([{ name: 'database_canonical', status: 'ok', details: { enabled: false } }]);
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
    expect(await databaseCanonicalEntry.run(ctx)).toMatchObject([{ name: 'database_canonical', status: 'ok', details: { enabled: true, sources_in_mode: 0 } }]);
  });
});

describe('sources canonical arguments', () => {
  test('only the read-only preview is accepted', () => {
    expect(parseCanonicalArgs(['default', '--dry-run', '--json', '--sample', '5'])).toEqual({ sourceId: 'default', json: true, sample: 5 });
    for (const args of [['default'], ['--dry-run'], ['default', '--dry-run', '--apply'], ['default', '--dry-run', '--sample', '-1']]) {
      expect(() => parseCanonicalArgs(args)).toThrow(OperationError);
    }
  });
});
