/**
 * Database-canonical memory, wave 3: the import lane in observe mode, its conflicts table, the hold-code mapping and the
 * foreign-writer census, on real PGLite and Postgres with real Git checkouts. Names and addresses are placeholders.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { exportBodyLedger, inlineExportMarkdown, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown } from '../src/core/export-snapshot.ts';
import { exportPathKey } from '../src/core/export-stage.ts';
import { DATABASE_CANONICAL_KEY } from '../src/core/persistence/canonical-export.ts';
import { lockExportWriters, writeSourceShadow } from '../src/core/persistence/canonical-shadow.ts';
import { decideImportCase, mergeCounts, observeImportLane } from '../src/core/persistence/import-lane.ts';
import { HOLD_CONFLICT_KINDS, holdConflictKind } from '../src/core/persistence/import-conflict-mapping.ts';
import { IMPORT_CONFLICT_KINDS } from '../src/core/persistence/import-conflicts-schema.ts';
import { watchImportLane } from '../src/core/persistence/import-lane-watch.ts';
import { readImportCensus } from '../src/core/persistence/import-census.ts';
import { censusImportLane, observeOnce, parseCensusArgs } from '../src/commands/sources-canonical-census.ts';
import { databaseCanonicalCensusEntry } from '../src/commands/doctor/checks/database-canonical-import.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { Check } from '../src/commands/doctor.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ALICE = { name: 'Alice Example', email: 'alice@example.com' };
const CRON = { name: 'notes-cron', email: 'cron@example.com' };
const GBRAIN = { name: 'gbrain', email: 'gbrain@example.com' };

function git(root: string, args: string[], who = ALICE): string {
  return execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } }).toString().trim();
}

/** A labeled case: the outcome a person would choose for the outside change, and what managed sync does with it today. */
interface LabeledCase { path: string; label: string; managed: string }

for (const backend of testBackends()) describe(`database-canonical wave 3 import lane: ${backend}`, () => {
  let engine: BrainEngine;
  let root: string;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    for (const table of ['import_conflicts', 'import_foreign_writes', 'import_lane_passes', 'export_ledger', 'export_outbox', 'database_canonical_sources', 'pages']) {
      await engine.executeRaw(`DELETE FROM ${table}`);
    }
    await engine.unsetConfig(DATABASE_CANONICAL_KEY);
    await engine.unsetConfig('sync.max_deletes.source.default');
    root = realpathSync(mkdtempSync(join(tmpdir(), 'import-lane-')));
    git(root, ['init', '-q', '-b', 'main']);
    await engine.executeRaw("UPDATE sources SET local_path=$1, config='{}'::jsonb WHERE id='default'", [root]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const shadow = (on: boolean) => engine.transaction(async tx => { await lockExportWriters(tx); return writeSourceShadow(tx, 'default', on); });
  const enable = async () => { await engine.setConfig(DATABASE_CANONICAL_KEY, 'true'); await shadow(true); };
  const keyOf = async (slug: string) => (await engine.executeRaw<{ id: string; source_id: string; slug: string }>(
    "SELECT id::text, source_id, slug FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
  const render = async (slug: string) => { const key = await keyOf(slug); return engine.transaction(async tx => inlineExportMarkdown(await readExportPage(tx, key, await readExportWithdrawals(tx, 'default')))); };
  const revisionOf = async (slug: string) => (await engine.executeRaw<{ r: string }>("SELECT knowledge_revision::text AS r FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.r;
  const file = (path: string) => join(root, ...path.split('/'));
  const write = (path: string, content: string | Buffer) => { mkdirSync(dirname(file(path)), { recursive: true }); writeFileSync(file(path), content); };
  const put = (slug: string, body: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: 'note', title: slug.split('/').pop()!, compiled_truth: body, timeline: '', frontmatter });
  /** The export ledger row wave 2 would hold for a committed file (tests seed it; the lane only reads it). */
  const ledger = async (slug: string, committed = true) => {
    const path = `${slug}.md`;
    const disk = existsSync(file(path)) ? sha(readFileSync(file(path))) : sha(await render(slug));
    const blob = committed ? git(root, ['rev-parse', `HEAD:${path}`]) : null;
    const commit = committed ? git(root, ['rev-parse', 'HEAD']) : null;
    await engine.executeRaw(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, path, path_folded, revision, disk_sha256, blob_oid, commit_sha, seeded_from)
      SELECT 'default', s.incarnation, p.id, $2, $3, p.knowledge_revision, $4, $5, $6, 'sync_provenance' FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.source_id='default' AND p.slug=$1`, [slug, path, exportPathKey(path), disk, blob, commit]);
  };
  const pass = (opts: Parameters<typeof observeImportLane>[2] = {}) => observeImportLane(engine, 'default', { stableMs: 0, ...opts });
  const open = () => engine.executeRaw<{ id: number; path: string; outcome: string; kind: string | null; reason: string; merge: Record<string, unknown> | null; inline: boolean;
    file_ref: string | null; commit_sha: string | null; shadow_epoch: number }>(`SELECT id, path, outcome, kind, detail->>'reason' AS reason, merge, file_bytes IS NOT NULL AS inline,
    file_ref, commit_sha, shadow_epoch::int AS shadow_epoch FROM import_conflicts WHERE source_id='default' AND state='open' ORDER BY path`);
  const state = async () => ({
    pages: await engine.executeRaw("SELECT id, knowledge_revision::text AS r, deleted_at IS NULL AS live FROM pages ORDER BY id"),
    ledger: await engine.executeRaw('SELECT id, revision::text AS r, disk_sha256, retired_at IS NULL AS live FROM export_ledger ORDER BY id'),
    head: git(root, ['rev-parse', 'HEAD']), index: sha(readFileSync(join(root, '.git', 'index'))), staged: git(root, ['ls-files', '-s']),
    files: git(root, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean).sort().map(p => [p, existsSync(file(p)) ? sha(readFileSync(file(p))) : null]),
  });

  test('the labeled fixture set: every decision-table row, against the outcome a person would choose', async () => {
    await enable();
    const slugs = ['lane/unchanged', 'lane/reformatted', 'lane/edited', 'lane/protected', 'lane/both', 'lane/both-differ', 'lane/deleted', 'lane/deleted-edited',
      'lane/deleted-worktree', 'lane/page-deleted', 'lane/broken', 'lane/huge', 'lane/huge-both'];
    for (const slug of slugs) await put(slug, `Body of ${slug}.`, slug === 'lane/reformatted' ? { validate: false } : {});
    await createSegmentedPage(engine, { slug: 'lane/segmented', truth: 'Segmented filler line.\n'.repeat(40), timeline: '' });
    for (const slug of slugs) write(`${slug}.md`, await render(slug));
    const segmentedKey = await keyOf('lane/segmented');
    await engine.transaction(async tx => {
      const snapshot = await readExportPage(tx, segmentedKey, []);
      const parts: Buffer[] = [];
      for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger('lane/segmented', []), segmentedExportHead(snapshot))) parts.push(Buffer.from(piece));
      write('lane/segmented.md', Buffer.concat(parts));
    });
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `gbrain: persist ${slugs.length + 1} canonical memory updates`], GBRAIN);
    for (const slug of [...slugs, 'lane/segmented']) await ledger(slug);
    await put('lane/unproven', 'Never committed.');
    await ledger('lane/unproven', false);
    await put('lane/collision', 'Database body.');
    await put('lane/collision-equal', 'Same body.');

    write('lane/reformatted.md', (await render('lane/reformatted')).replace('validate: false\n', ''));
    write('lane/edited.md', (await render('lane/edited')).replace('Body of lane/edited.', 'Edited outside.'));
    write('lane/protected.md', (await render('lane/protected')).replace('---\n', '---\ntrust_level: owner\n'));
    write('lane/both.md', (await render('lane/both')).replace('Body of lane/both.', 'File side.'));
    await engine.putPage('lane/both', { type: 'note', title: 'both', compiled_truth: 'Body of lane/both.', timeline: '- 2026-01-02: database side' });
    write('lane/both-differ.md', (await render('lane/both-differ')).replace('Body of lane/both-differ.', 'File wording.'));
    await put('lane/both-differ', 'Database wording.');
    git(root, ['rm', '-q', 'lane/deleted.md', 'lane/deleted-edited.md']);
    git(root, ['commit', '-qm', 'Remove two notes']);
    await put('lane/deleted-edited', 'Edited in the database.');
    unlinkSync(file('lane/deleted-worktree.md'));
    write('lane/page-deleted.md', (await render('lane/page-deleted')).replace('Body of lane/page-deleted.', 'Edited after the delete.'));
    await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='lane/page-deleted'");
    write('lane/broken.md', '---\ntitle: [unclosed\n---\nBody\n');
    write('lane/new.md', '---\ntitle: New\ntype: note\n---\nA new note.\n');
    write('lane/collision.md', '---\ntitle: collision\ntype: note\n---\nFile body.\n');
    write('lane/collision-equal.md', await render('lane/collision-equal'));
    git(root, ['add', 'lane/new.md', 'lane/collision.md', 'lane/collision-equal.md']);
    git(root, ['commit', '-qm', 'auto-commit: notes'], CRON);
    const huge = Buffer.alloc(25 * 1024 * 1024, 'x');
    write('lane/huge.md', huge);
    write('lane/huge-both.md', huge);
    await put('lane/huge-both', 'Changed in the database.');
    write('lane/segmented.md', Buffer.concat([readFileSync(file('lane/segmented.md')), Buffer.from('Outside line.\n')]));
    await engine.executeRaw("UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug='lane/segmented'");

    const cases: LabeledCase[] = [
      { path: 'lane/reformatted.md', label: 'adopt', managed: 'import' },
      { path: 'lane/edited.md', label: 'import', managed: 'import' },
      { path: 'lane/protected.md', label: 'conflict:protected_metadata', managed: 'import' },
      { path: 'lane/both.md', label: 'conflict:both_changed', managed: 'hold' },
      { path: 'lane/both-differ.md', label: 'conflict:both_changed', managed: 'hold' },
      { path: 'lane/deleted.md', label: 'delete', managed: 'delete' },
      { path: 'lane/deleted-edited.md', label: 'conflict:deleted_vs_edited', managed: 'hold' },
      { path: 'lane/deleted-worktree.md', label: 'conflict:deleted_uncommitted', managed: 'hold' },
      { path: 'lane/page-deleted.md', label: 'conflict:both_changed', managed: 'hold' },
      { path: 'lane/broken.md', label: 'conflict:unparseable', managed: 'hold' },
      { path: 'lane/huge.md', label: 'streamed_import', managed: 'hold' },
      { path: 'lane/huge-both.md', label: 'conflict:too_large_for_lane', managed: 'hold' },
      { path: 'lane/segmented.md', label: 'conflict:both_changed', managed: 'hold' },
      { path: 'lane/unproven.md', label: 'none', managed: 'hold' },
      { path: 'lane/new.md', label: 'create', managed: 'create' },
      { path: 'lane/collision.md', label: 'conflict:unexported_collision', managed: 'import' },
      { path: 'lane/collision-equal.md', label: 'adopt', managed: 'import' },
    ];
    const before = await state();
    const result = await pass();
    expect(result).toMatchObject({ status: 'observed', unstable: 0 });
    expect(await state()).toEqual(before);
    const rows = await open();
    const lane = new Map(rows.map(r => [r.path, r.kind ? `conflict:${r.kind}` : r.outcome]));
    expect(lane.has('lane/unchanged.md')).toBe(false);
    const agreement = cases.filter(c => lane.get(c.path) === c.label);
    expect(cases.map(c => [c.path, lane.get(c.path)])).toEqual(cases.map(c => [c.path, c.label]));
    expect(agreement.length).toBe(cases.length);
    // The cases where managed sync's action differs from the person's choice: the lane agrees with the person on every one.
    expect(cases.filter(c => c.managed !== c.label.split(':')[0]).map(c => c.path)).toContain('lane/collision.md');

    const by = new Map(rows.map(r => [r.path, r]));
    expect(by.get('lane/both.md')!.merge).toMatchObject({ file_only: 1, database_only: 1, both_differ: 0, resolvable: true });
    expect(by.get('lane/both-differ.md')!.merge).toMatchObject({ both_differ: 1, resolvable: false, differ_fields: ['/compiled_truth'] });
    expect(by.get('lane/segmented.md')).toMatchObject({ merge: null, reason: 'segmented_both_changed' });
    expect(by.get('lane/unproven.md')!.reason).toBe('deletion_unproven');
    expect(by.get('lane/huge-both.md')).toMatchObject({ inline: false, file_ref: `refs/gbrain/import-conflicts/default/${sha(huge)}` });
    expect(by.get('lane/both.md')!.inline).toBe(true);
    expect(by.get('lane/deleted.md')!.commit_sha).toBe(git(root, ['rev-parse', 'HEAD~1']));
    expect(git(root, ['for-each-ref', 'refs/gbrain'])).toBe('');

    const census = await readImportCensus(engine, 'default');
    expect(census.outcomes).toMatchObject({ adopt: 2, import: 1, delete: 1, create: 1, streamed_import: 1, none: 1 });
    expect(census.conflicts.find(c => c.kind === 'both_changed')!.count).toBe(4);
    expect(census.merge).toEqual({ two_sided: 4, resolvable: 1, no_base: 2 });
    expect(census.writers.map(w => [w.author_email, w.process_hint, w.gbrain_owned, w.commits]).sort()).toEqual([
      ['alice@example.com', null, false, 1], ['cron@example.com', 'automation', false, 1], ['gbrain@example.com', 'gbrain_git_effect', true, 1]]);
    expect(census.uncommitted.paths).toBeGreaterThan(0);
  }, 120000);

  test('a file counts only once its bytes are stable across two reads; a second pass keeps one open row and a revert clears it', async () => {
    await enable();
    await put('notes/a', 'Original.');
    write('notes/a.md', await render('notes/a'));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'seed'], GBRAIN);
    await ledger('notes/a');
    const original = readFileSync(file('notes/a.md'));
    write('notes/a.md', original.toString().replace('Original.', 'First edit.'));
    const moving = await pass({ betweenReads: async () => write('notes/a.md', original.toString().replace('Original.', 'Still typing.')) });
    expect(moving).toMatchObject({ status: 'observed', unstable: 1, outcomes: {} });
    expect(await open()).toEqual([]);
    const settled = await pass();
    expect(settled.outcomes).toEqual({ import: 1 });
    const [row] = await open();
    expect(row).toMatchObject({ path: 'notes/a.md', outcome: 'import' });
    await pass();
    expect((await open()).map(r => r.id)).toEqual([row!.id]);
    write('notes/a.md', original);
    await pass();
    expect(await open()).toEqual([]);
    const [closed] = await engine.executeRaw<{ resolution: string }>('SELECT resolution FROM import_conflicts WHERE id=$1', [row!.id]);
    expect(closed!.resolution).toBe('cleared');
  });

  test('deletions above the mass-delete valve become bulk_delete conflicts that share one batch', async () => {
    await enable();
    for (const slug of ['bulk/a', 'bulk/b', 'bulk/c']) { await put(slug, `Body ${slug}.`); write(`${slug}.md`, await render(slug)); }
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'seed'], GBRAIN);
    for (const slug of ['bulk/a', 'bulk/b', 'bulk/c']) await ledger(slug);
    git(root, ['rm', '-q', 'bulk/a.md', 'bulk/b.md']); git(root, ['commit', '-qm', 'Cull']);
    await engine.setConfig('sync.max_deletes.source.default', '1');
    await pass();
    const rows = await engine.executeRaw<{ path: string; kind: string; batch: number }>(`SELECT path, kind, (detail->>'batch_size')::int AS batch FROM import_conflicts
      WHERE state='open' ORDER BY path`);
    expect(rows.map(r => ({ ...r, batch: Number(r.batch) }))).toEqual([{ path: 'bulk/a.md', kind: 'bulk_delete', batch: 2 }, { path: 'bulk/b.md', kind: 'bulk_delete', batch: 2 }]);
  });

  test('a configured filter driver never runs, and autocrlf and LFS checkouts do not look edited', async () => {
    await enable();
    await put('crlf/page', 'Line one.');
    await put('lfs/page', 'Large body.');
    await put('filter/page', 'Filtered.');
    const crlf = (await render('crlf/page'));
    write('crlf/page.md', crlf);
    write('lfs/page.md', 'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 11\n');
    write('filter/page.md', await render('filter/page'));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'seed'], GBRAIN);
    // The checkout holds converted bytes: CRLF line ends and a smudged LFS object; the ledger records those raw bytes.
    write('crlf/page.md', crlf.replace(/\n/g, '\r\n'));
    write('lfs/page.md', await render('lfs/page'));
    const marker = join(root, '..', `${root.split('/').pop()}-filter-ran`);
    const script = join(root, '..', `${root.split('/').pop()}-filter.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    for (const driver of ['evil', 'lfs']) {
      git(root, ['config', `filter.${driver}.clean`, script]);
      git(root, ['config', `filter.${driver}.smudge`, script]);
      git(root, ['config', `filter.${driver}.process`, script]);
      git(root, ['config', `diff.${driver}.textconv`, script]);
    }
    git(root, ['config', 'core.autocrlf', 'true']);
    git(root, ['config', 'core.hooksPath', join(root, 'hooks')]);
    write('.gitattributes', 'filter/*.md filter=evil diff=evil\nlfs/*.md filter=lfs diff=lfs\n');
    for (const slug of ['crlf/page', 'lfs/page', 'filter/page']) await ledger(slug);
    write('filter/page.md', (await render('filter/page')).replace('Filtered.', 'Edited behind a filter.'));
    unlinkSync(file('crlf/page.md'));
    write('crlf/page.md', crlf.replace(/\n/g, '\r\n'));
    try {
      const result = await pass();
      expect(result.status).toBe('observed');
      expect((await open()).map(r => [r.path, r.outcome])).toEqual([['filter/page.md', 'import']]);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(marker, { force: true }); rmSync(script, { force: true }); }
  });

  test('the shadow epoch binds observations: shadow off records nothing, and turning it back on retires the old rows', async () => {
    await enable();
    await put('notes/a', 'Original.');
    write('notes/a.md', await render('notes/a'));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'seed'], GBRAIN);
    await ledger('notes/a');
    write('notes/a.md', (await render('notes/a')).replace('Original.', 'Edited.'));
    await pass();
    const [first] = await open();
    expect(first!.shadow_epoch).toBe(1);
    await shadow(false);
    expect(await pass()).toMatchObject({ status: 'skipped', reason: 'shadow_off' });
    const [passes] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM import_lane_passes');
    expect(Number(passes!.n)).toBe(1);
    await shadow(true);
    await pass();
    const rows = await engine.executeRaw<{ state: string; resolution: string | null; shadow_epoch: number }>(
      'SELECT state, resolution, shadow_epoch::int AS shadow_epoch FROM import_conflicts ORDER BY id');
    expect(rows.map(r => [r.state, r.resolution, Number(r.shadow_epoch)])).toEqual([['resolved', 'epoch_changed', 1], ['open', null, 3]]);
  });

  test('the watch lane observes an edit and stops by itself when shadow turns off', async () => {
    await enable();
    await put('notes/w', 'Original.');
    write('notes/w.md', await render('notes/w'));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'seed'], GBRAIN);
    await ledger('notes/w');
    const seen: string[] = [];
    const lane = watchImportLane(engine, 'default', root, { pollMs: 200, debounceMs: 50, stableMs: 0, onPass: r => seen.push(r.status === 'observed' ? JSON.stringify(r.outcomes) : r.reason!) });
    write('notes/w.md', (await render('notes/w')).replace('Original.', 'Edited while watched.'));
    for (let i = 0; i < 50 && !seen.includes('{"import":1}'); i++) await new Promise(r => setTimeout(r, 100));
    expect(seen).toContain('{"import":1}');
    await shadow(false);
    const last = await lane.done;
    expect(last).toMatchObject({ status: 'skipped', reason: 'shadow_off' });
  }, 30000);

  test('the gate and the shadow flag refuse, the census groups writers, and the doctor check reports them', async () => {
    const ctx = { engine } as never;
    await expect(censusImportLane(engine, 'default', 10)).rejects.toMatchObject({ code: 'database_canonical_disabled' });
    await expect(observeOnce(engine, 'default')).rejects.toMatchObject({ code: 'database_canonical_disabled' });
    expect(await pass()).toMatchObject({ status: 'skipped', reason: 'gate_off' });
    expect(await databaseCanonicalCensusEntry.run(ctx)).toMatchObject([{ name: 'database_canonical_census', status: 'ok', details: { enabled: false } }]);
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
    await expect(observeOnce(engine, 'default')).rejects.toMatchObject({ code: 'import_lane_shadow_off' });
    expect(await databaseCanonicalCensusEntry.run(ctx)).toMatchObject([{ status: 'ok', details: { shadowed_sources: [] } }]);
    expect((await censusImportLane(engine, 'default', 10)).next).toContain('--shadow on');
    await shadow(true);
    await put('notes/a', 'Seed.');
    write('notes/a.md', await render('notes/a'));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'gbrain: persist canonical memory update'], GBRAIN);
    await ledger('notes/a');
    await observeOnce(engine, 'default');
    expect(await databaseCanonicalCensusEntry.run(ctx)).toMatchObject([{ status: 'ok', details: { writers: [] } }]);
    write('notes/a.md', (await render('notes/a')).replace('Seed.', 'Alice edit.'));
    git(root, ['commit', '-qam', 'Edit a note']);
    write('notes/b.md', '---\ntitle: B\ntype: note\n---\nCron note.\n');
    git(root, ['add', 'notes/b.md']); git(root, ['commit', '-qm', 'sync: hourly'], CRON);
    write('notes/a.md', (await render('notes/a')).replace('Seed.', 'Alice again.'));
    git(root, ['commit', '-qam', 'Edit it again']);
    await observeOnce(engine, 'default');
    const census = await censusImportLane(engine, 'default', 10);
    expect(census.writers.filter(w => !w.gbrain_owned).map(w => [w.author_email, w.commits, w.commits_7d, w.paths]).sort()).toEqual([
      ['alice@example.com', 2, 2, 1], ['cron@example.com', 1, 1, 1]]);
    expect(census.next).toContain('2 writer(s) still commit page files');
    const [check] = await databaseCanonicalCensusEntry.run(ctx) as Check[];
    expect(check).toMatchObject({ name: 'database_canonical_census', status: 'warn', details: { next: 'gbrain sources canonical default --census' } });
    expect((check!.details as { writers: Array<{ writer: string }> }).writers.map(w => w.writer).sort()).toEqual(['Alice Example', 'notes-cron']);
    expect(check!.message).not.toContain('gbrain_git_effect');
  });
});

describe('sources canonical --census arguments', () => {
  test('exactly one action, --watch only with --observe', () => {
    expect(parseCensusArgs(['default', '--census', '--json'])).toEqual({ sourceId: 'default', action: 'census', watch: false, json: true, sample: 10 });
    expect(parseCensusArgs(['default', '--observe', '--watch'])).toMatchObject({ action: 'observe', watch: true });
    for (const args of [['default'], ['default', '--census', '--observe'], ['default', '--census', '--watch'], ['--census'], ['default', '--census', '--apply']]) {
      expect(() => parseCensusArgs(args)).toThrow(OperationError);
    }
  });
});

describe('the import lane decision table (pure)', () => {
  const base = { revision: 'r0', disk_sha256: 'h0' };
  const same = { live: true, revision: 'r0', segmented: false };
  const moved = { live: true, revision: 'r1', segmented: false };
  const present = (over: Partial<{ tooLarge: boolean; screen: string | null; equal: boolean; protectedChanged: boolean }> = {}) =>
    ({ state: 'present' as const, tooLarge: false, screen: null, equal: false, protectedChanged: false, ...over });
  const gone = (evidence: 'at_head' | 'removed_by_commit' | 'none') => ({ state: 'missing' as const, evidence });
  test('every row', () => {
    const rows: Array<[string, Parameters<typeof decideImportCase>[0], string]> = [
      ['never exported, missing', { base: null, page: same, file: gone('none') }, 'none'],
      ['gone, committed at HEAD', { base, page: moved, file: gone('at_head') }, 'conflict:deleted_uncommitted'],
      ['gone, both deleted', { base, page: { ...same, live: false }, file: gone('removed_by_commit') }, 'none'],
      ['gone, unproven', { base, page: same, file: gone('none') }, 'none'],
      ['gone by commit, unchanged', { base, page: same, file: gone('removed_by_commit') }, 'delete'],
      ['gone by commit, database moved', { base, page: moved, file: gone('removed_by_commit') }, 'conflict:deleted_vs_edited'],
      ['too large, unchanged', { base, page: same, file: present({ tooLarge: true }) }, 'streamed_import'],
      ['too large, database moved', { base, page: moved, file: present({ tooLarge: true }) }, 'conflict:too_large_for_lane'],
      ['too large, no base', { base: null, page: null, file: present({ tooLarge: true }) }, 'conflict:too_large_for_lane'],
      ['screen refused', { base, page: same, file: present({ screen: 'invalid_frontmatter' }) }, 'conflict:unparseable'],
      ['equal, database moved', { base, page: moved, file: present({ equal: true }) }, 'adopt'],
      ['equal, no base', { base: null, page: same, file: present({ equal: true }) }, 'adopt'],
      ['no base, page differs', { base: null, page: same, file: present() }, 'conflict:unexported_collision'],
      ['no base, no page', { base: null, page: null, file: present() }, 'create'],
      ['no base, deleted page', { base: null, page: { ...same, live: false }, file: present() }, 'create'],
      ['page deleted since export', { base, page: { ...same, live: false }, file: present() }, 'conflict:both_changed'],
      ['unchanged, protected key', { base, page: same, file: present({ protectedChanged: true }) }, 'conflict:protected_metadata'],
      ['unchanged', { base, page: same, file: present() }, 'import'],
      ['both changed', { base, page: moved, file: present() }, 'conflict:both_changed'],
      ['segmented, both changed', { base, page: { ...moved, segmented: true }, file: present() }, 'conflict:both_changed'],
    ];
    expect(rows.map(([name, facts]) => { const d = decideImportCase(facts); return [name, d.kind ? `conflict:${d.kind}` : d.outcome]; }))
      .toEqual(rows.map(([name, , expected]) => [name, expected]));
  });

  test('merge counts are three-way and delete-aware', () => {
    const page = (over: Record<string, unknown> = {}) => ({ type: 'note', title: 'T', compiled_truth: 'Body.', timeline: '', frontmatter: { a: 1, b: 2 }, tags: ['x'], ...over }) as never;
    expect(mergeCounts(page(), page({ compiled_truth: 'File.' }), page({ frontmatter: { a: 1 } })))
      .toEqual({ file_only: 1, database_only: 1, both_same: 0, both_differ: 0, resolvable: true, differ_fields: [] });
    expect(mergeCounts(page(), page({ tags: ['y'] }), page({ tags: ['z'] }))).toMatchObject({ both_differ: 1, resolvable: false, differ_fields: ['/tags'] });
    expect(mergeCounts(page(), page({ title: 'Same' }), page({ title: 'Same' }))).toMatchObject({ both_same: 1, resolvable: true });
  });
});

describe('the hold-code to conflict-kind mapping', () => {
  test('every row names a known kind, and refinements narrow file_drift and worktree_dirty', () => {
    const allowed = new Set<string>([...IMPORT_CONFLICT_KINDS, 'reclassify', 'out_of_lane']);
    for (const [code, row] of Object.entries(HOLD_CONFLICT_KINDS)) {
      expect([code, allowed.has(row.kind), (row.refinements ?? []).every(r => allowed.has(r.kind))]).toEqual([code, true, true]);
    }
    expect(holdConflictKind('file_drift', { side: 'both' })).toBe('both_changed');
    expect(holdConflictKind('file_drift', { sides: 'unknown' })).toBe('both_changed');
    expect(holdConflictKind('file_drift', { side: 'deleted', state: 'file_gone' }, 'deleted_by_commit')).toBe('deleted_vs_edited');
    expect(holdConflictKind('file_drift', { side: 'deleted', state: 'file_gone' }, 'deletion_uncommitted')).toBe('deleted_uncommitted');
    expect(holdConflictKind('file_drift', { side: 'deleted', state: 'file_gone' }, 'never_committed')).toBe('never_exported');
    expect(holdConflictKind('file_drift', { side: 'deleted', state: 'file_gone', reason: 'ignored' })).toBe('never_exported');
    expect(holdConflictKind('file_drift', { side: 'deleted', state: 'file_gone' })).toBe('deleted_vs_edited');
    expect(holdConflictKind('file_drift', { side: 'deleted', state: 'tombstone_edited' })).toBe('both_changed');
    expect(holdConflictKind('worktree_dirty', { reason: 'deleted_locally' })).toBe('deleted_uncommitted');
    expect(holdConflictKind('worktree_dirty')).toBe('reclassify');
    expect(holdConflictKind('invalid_fence')).toBe('unparseable');
    expect(holdConflictKind('origin_conflict')).toBe('identity');
  });

  test('the table published in the wave 3 contract matches the data', () => {
    const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'designs', 'database-canonical-w3-contract.md'), 'utf8');
    const table = doc.split('<!-- hold-conflict-kinds:begin -->')[1]!.split('<!-- hold-conflict-kinds:end -->')[0]!;
    const published = Object.fromEntries(table.split('\n').filter(line => line.startsWith('| `')).map(line => {
      const [, code, kind] = line.split('|').map(cell => cell.trim().replace(/`/g, ''));
      return [code, kind];
    }));
    expect(published).toEqual(Object.fromEntries(Object.entries(HOLD_CONFLICT_KINDS).map(([code, row]) => [code, row.kind]).sort(([a], [b]) => a!.localeCompare(b!))));
  });
});
