import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { inlineExportMarkdown, readExportPage, readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { DATABASE_CANONICAL_KEY } from '../src/core/persistence/canonical-export.ts';
import { readExportOutbox, readSourceCanonicalState } from '../src/core/persistence/canonical-shadow.ts';
import { drainExportShadow, readShadowStatus, seedExportLedger } from '../src/core/persistence/canonical-shadow-consumer.ts';
import { recordSyncImportProvenance } from '../src/core/persistence/sync-holds.ts';
import { applyShadowChange, parseShadowArgs, previewShadowChange } from '../src/commands/sources-canonical-shadow.ts';
import { databaseCanonicalShadowEntry } from '../src/commands/doctor/checks/database-canonical-shadow.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { Check } from '../src/commands/doctor.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const INTENT = 'source_canonical';

for (const backend of testBackends()) describe(`database-canonical wave 2 shadow verb, seed, consumer and doctor: ${backend}`, () => {
  let engine: BrainEngine;
  let root: string;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    for (const table of ['database_canonical_sources', 'pages', 'export_outbox', 'export_ledger', 'export_shadow_diffs', 'export_shadow_batches']) await engine.executeRaw(`DELETE FROM ${table}`);
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-shadow-')));
    execFileSync('git', ['-C', root, 'init', '-q'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    await engine.executeRaw("UPDATE sources SET local_path=$1, config='{}'::jsonb WHERE id='default'", [root]);
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
  });

  const page = (slug: string, body: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter });
  const render = (slug: string) => engine.transaction(async tx => {
    const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text, source_id, slug FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    return inlineExportMarkdown(await readExportPage(tx, key!, await readExportWithdrawals(tx, 'default')));
  });
  const file = (slug: string, text: string) => { const path = join(root, `${slug}.md`); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return text; };
  const pageRow = async (slug: string) => (await engine.executeRaw<{ id: number; revision: string }>(
    "SELECT id::int AS id, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
  const ledger = async (slug: string, revision: string, diskSha: string) => {
    const { id } = await pageRow(slug);
    await engine.executeRaw(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, path, path_folded, revision, disk_sha256, seeded_from)
      SELECT 'default', incarnation, $1, $2, lower($2), $3::uuid, $4, 'sync_provenance' FROM sources WHERE id='default'`, [Number(id), `${slug}.md`, revision, diskSha]);
  };
  const turnOn = async () => {
    const preview = await previewShadowChange(engine, 'default', 'shadow_on', 5);
    return applyShadowChange(engine, 'default', 'shadow_on', { admin_intent: INTENT, expected_state: preview.expected_state });
  };
  const doctor = async () => (await databaseCanonicalShadowEntry.run({ engine } as never) as Check[])[0]!;
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  test('gate off: shadow on and drain refuse database_canonical_disabled; shadow off still previews', async () => {
    try {
      await engine.unsetConfig(DATABASE_CANONICAL_KEY);
      await expect(previewShadowChange(engine, 'default', 'shadow_on', 5)).rejects.toMatchObject({ code: 'database_canonical_disabled' });
      await expect(applyShadowChange(engine, 'default', 'shadow_on', { admin_intent: INTENT, expected_state: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'database_canonical_disabled' });
      expect(await previewShadowChange(engine, 'default', 'shadow_off', 5)).toMatchObject({ change: 'none', apply_command: null });
      expect(await readSourceCanonicalState(engine, 'default')).toBeNull();
      expect(await doctor()).toMatchObject({ name: 'database_canonical_shadow', status: 'ok', details: { enabled: false, sources: [] } });
    } finally { cleanup(); }
  });

  test('the apply needs the intent and the previewed fingerprint, and refuses preview_changed when the state moved', async () => {
    try {
      await page('notes/one', 'Body.');
      const preview = await previewShadowChange(engine, 'default', 'shadow_on', 5);
      expect(preview).toMatchObject({ status: 'preview', change: 'enable', current: null, census: { pages: 1 }, trigger_cost: { pages_changed_last_day: 1, outbox_ceiling: 1 } });
      expect(preview.apply_command).toBe(`gbrain sources canonical default --shadow on --admin-intent source_canonical --expected-state ${preview.expected_state}`);
      await expect(applyShadowChange(engine, 'default', 'shadow_on', {})).rejects.toMatchObject({ code: 'database_canonical_intent_required' });
      await expect(applyShadowChange(engine, 'default', 'shadow_on', { admin_intent: 'writer_claim', expected_state: preview.expected_state }))
        .rejects.toMatchObject({ code: 'database_canonical_intent_required' });
      const off = await previewShadowChange(engine, 'default', 'shadow_off', 5);
      await expect(applyShadowChange(engine, 'default', 'shadow_on', { admin_intent: INTENT, expected_state: off.expected_state })).rejects.toMatchObject({ code: 'preview_changed' });
      await engine.executeRaw("UPDATE sources SET config=jsonb_build_object('note','moved') WHERE id='default'");
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [join(root, 'elsewhere')]);
      await expect(applyShadowChange(engine, 'default', 'shadow_on', { admin_intent: INTENT, expected_state: preview.expected_state })).rejects.toMatchObject({ code: 'preview_changed' });
      expect(await readSourceCanonicalState(engine, 'default')).toBeNull();
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      const applied = await applyShadowChange(engine, 'default', 'shadow_on', { admin_intent: INTENT, expected_state: (await previewShadowChange(engine, 'default', 'shadow_on', 5)).expected_state });
      expect(applied).toMatchObject({ status: 'applied', state: { shadow: true, shadow_epoch: 1 } });
      await page('notes/one', 'Edited.');
      expect((await readExportOutbox(engine, 'default', 10)).map(r => r.slug)).toEqual(['notes/one']);
      expect(await previewShadowChange(engine, 'default', 'shadow_on', 5)).toMatchObject({ change: 'none', apply_command: null });
    } finally { cleanup(); }
  });

  test('seed: a record with a revision and a disk hash becomes a renderer-less row; anything else is no base', async () => {
    try {
      for (const slug of ['seed/based', 'seed/no-revision', 'seed/no-disk', 'seed/gone']) await page(slug, 'Body.');
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'");
      const record = async (slug: string, fields: { revision?: string; disk_sha256?: string | null }) => recordSyncImportProvenance(engine, {
        source_id: 'default', incarnation, page_id: (await pageRow(slug)).id, origin: `${slug}.md`, raw_sha256: sha(slug), gbrain_version: 'test', ...fields });
      await record('seed/based', { revision: (await pageRow('seed/based')).revision, disk_sha256: sha('based bytes') });
      await record('seed/no-revision', { disk_sha256: sha('x') });
      await record('seed/no-disk', { revision: (await pageRow('seed/no-disk')).revision, disk_sha256: null });
      await record('seed/gone', { revision: (await pageRow('seed/gone')).revision, disk_sha256: sha('gone') });
      await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='seed/gone'");
      const expected = { records: 4, coverage: { revision: 3, raw_sha256: 4, disk_sha256: 3 }, no_base: { no_revision: 1, no_disk_hash: 1 },
        skipped: { page_gone: 1, unsafe_path: 0, path_collision: 0, no_checkout: 0 }, seeded: 1, existing: 0 };
      expect(await seedExportLedger(engine, 'default', { apply: false })).toEqual(expected);
      expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM export_ledger'))[0]!.n)).toBe(0);
      expect((await turnOn()).seed).toEqual(expected);
      const rows = await engine.executeRaw<Record<string, unknown>>('SELECT path, path_folded, revision::text AS revision, disk_sha256, renderer_fp, seeded_from, lifetime FROM export_ledger');
      expect(rows).toEqual([{ path: 'seed/based.md', path_folded: 'seed/based.md', revision: (await pageRow('seed/based')).revision, disk_sha256: sha('based bytes'),
        renderer_fp: null, seeded_from: 'sync_provenance', lifetime: 1 }]);
      expect(await seedExportLedger(engine, 'default', { apply: true })).toMatchObject({ seeded: 0, existing: 1 });
    } finally { cleanup(); }
  });

  test('the consumer classifies each page against its file and ledger base, adopts equal files, and doctor turns red on an unexpected kind', async () => {
    try {
      await turnOn();
      await page('k/adopt', 'Adopt me.');
      file('k/adopt', await render('k/adopt'));
      await page('k/write', 'Old.');
      const oldWrite = file('k/write', await render('k/write'));
      await ledger('k/write', (await pageRow('k/write')).revision, sha(oldWrite));
      await page('k/write', 'New.');
      await page('k/mismatch', 'Database body.');
      const mismatch = file('k/mismatch', (await render('k/mismatch')).replace('Database body.', 'Other body.'));
      await ledger('k/mismatch', (await pageRow('k/mismatch')).revision, sha(mismatch));
      await page('k/outside', 'Exported.');
      const exported = await render('k/outside');
      file('k/outside', exported.replace('Exported.', 'Edited outside.'));
      await ledger('k/outside', (await pageRow('k/outside')).revision, sha(exported));
      await page('k/create', 'No file yet.');
      await page('k/deleted-file', 'File removed.');
      await ledger('k/deleted-file', (await pageRow('k/deleted-file')).revision, sha('whatever'));
      await page('k/collision', 'Database copy.');
      file('k/collision', (await render('k/collision')).replace('Database copy.', 'Unrelated file.'));
      await page('k/private', 'Secret.', { visibility: 'private' });
      file('k/private', 'a private file');
      await page('k/remove', 'Going away.');
      const removed = file('k/remove', await render('k/remove'));
      await ledger('k/remove', (await pageRow('k/remove')).revision, sha(removed));
      await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='k/remove'");

      const batch = await drainExportShadow(engine, 'default', { limit: 100 });
      expect(batch).toMatchObject({ outbox_rows: 9, consumed: 9, adopted: 1 });
      const kinds = Object.fromEntries((await engine.executeRaw<{ slug: string; kind: string; expected: boolean }>(
        "SELECT slug, kind, expected FROM export_shadow_diffs WHERE source_id='default' ORDER BY slug")).map(d => [d.slug, [d.kind, d.expected]]));
      expect(kinds).toEqual({ 'k/adopt': ['adopt', true], 'k/write': ['write', true], 'k/mismatch': ['render_mismatch', false], 'k/outside': ['outside_edit', true],
        'k/create': ['create', true], 'k/deleted-file': ['file_deleted', true], 'k/collision': ['unexported_collision', true],
        'k/private': ['ineligible_file', false], 'k/remove': ['remove', true] });
      expect(batch.unexpected.map(d => d.kind).sort()).toEqual(['ineligible_file', 'render_mismatch']);
      const [adopted] = await engine.executeRaw<{ seeded_from: string; renderer_fp: string | null; revision: string }>(
        "SELECT l.seeded_from, l.renderer_fp, l.revision::text AS revision FROM export_ledger l JOIN pages p ON p.id=l.page_id WHERE p.slug='k/adopt'");
      expect(adopted).toEqual({ seeded_from: 'shadow_adopt', renderer_fp: null, revision: (await pageRow('k/adopt')).revision });
      expect(await readExportOutbox(engine, 'default', 10)).toEqual([]);

      const red = await doctor();
      expect(red).toMatchObject({ status: 'fail', details: { enabled: true, sources: [{ source_id: 'default', unexpected: { render_mismatch: 1, ineligible_file: 1 } }] } });
      expect((red.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sources', 'canonical', 'default', '--shadow-status', '--json']);

      // The adopted page drains as equal next time; fixing the mismatched file clears its unexpected diff.
      const { id } = await pageRow('k/adopt');
      await engine.executeRaw("INSERT INTO export_outbox(source_id,page_id,slug,revision,cause) VALUES ('default',$1,'k/adopt',NULL,'written')", [id]);
      file('k/mismatch', await render('k/mismatch'));
      await engine.executeRaw("UPDATE export_ledger SET disk_sha256=$1 WHERE page_id=$2", [sha(await render('k/mismatch')), (await pageRow('k/mismatch')).id]);
      await engine.executeRaw("INSERT INTO export_outbox(source_id,page_id,slug,revision,cause) VALUES ('default',$1,'k/mismatch',NULL,'written')", [(await pageRow('k/mismatch')).id]);
      await engine.executeRaw("UPDATE pages SET frontmatter='{}'::jsonb WHERE source_id='default' AND slug='k/private'");
      await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='k/private'");
      unlinkSync(join(root, 'k/private.md'));
      const second = await drainExportShadow(engine, 'default', { limit: 100 });
      expect(second.counts).toMatchObject({ equal: 2, absent: 1 });
      const status = await readShadowStatus(engine, 'default');
      expect(status.unexpected).toEqual({});
      expect(status.batches.last_hour).toBe(2);
      expect((await doctor()).status).toBe('ok');
    } finally { cleanup(); }
  });

  test('doctor warns on a stale outbox and on a shadowed source under a gate that was turned off', async () => {
    try {
      await turnOn();
      await page('stale/page', 'Body.');
      await engine.executeRaw("UPDATE export_outbox SET first_enqueued_at=now() - interval '2 hours'");
      const stale = await doctor();
      expect(stale).toMatchObject({ status: 'warn', details: { sources: [{ source_id: 'default', outbox: { depth: 1 } }] } });
      expect((stale.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sources', 'canonical', 'default', '--shadow-drain']);
      await engine.unsetConfig(DATABASE_CANONICAL_KEY);
      const gateOff = await doctor();
      expect(gateOff).toMatchObject({ status: 'warn', details: { enabled: false } });
      expect((gateOff.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sources', 'canonical', 'default', '--shadow', 'off', '--dry-run']);
    } finally { cleanup(); }
  });

  test('shadow off stops new rows; the purge refuses while shadow is on and is bound to the rows it previewed', async () => {
    try {
      await turnOn();
      await page('purge/kept', 'Body.');
      await expect(previewShadowChange(engine, 'default', 'purge_shadow', 5)).rejects.toMatchObject({ code: 'database_canonical_shadow_active' });
      const off = await previewShadowChange(engine, 'default', 'shadow_off', 5);
      expect(off).toMatchObject({ change: 'disable' });
      expect(await applyShadowChange(engine, 'default', 'shadow_off', { admin_intent: INTENT, expected_state: off.expected_state }))
        .toMatchObject({ status: 'applied', state: { shadow: false, shadow_epoch: 2 } });
      await page('purge/new', 'Body.');
      expect((await readExportOutbox(engine, 'default', 10)).map(r => r.slug)).toEqual(['purge/kept']);
      const purge = await previewShadowChange(engine, 'default', 'purge_shadow', 5);
      expect(purge).toMatchObject({ change: 'purge', purge: { outbox: 1, batches: 0, diffs: 0 } });
      const { id } = await pageRow('purge/new');
      await engine.executeRaw("INSERT INTO export_outbox(source_id,page_id,slug,revision,cause) VALUES ('default',$1,'purge/new',NULL,'written')", [id]);
      await expect(applyShadowChange(engine, 'default', 'purge_shadow', { admin_intent: INTENT, expected_state: purge.expected_state })).rejects.toMatchObject({ code: 'preview_changed' });
      const again = await previewShadowChange(engine, 'default', 'purge_shadow', 5);
      expect(await applyShadowChange(engine, 'default', 'purge_shadow', { admin_intent: INTENT, expected_state: again.expected_state }))
        .toMatchObject({ status: 'applied', purged: { outbox: 2, batches: 0, diffs: 0 } });
      expect(await readExportOutbox(engine, 'default', 10)).toEqual([]);
    } finally { cleanup(); }
  });
});

describe('sources canonical shadow arguments', () => {
  test('one action per call; changes take a preview or the intent pair, reads take neither', () => {
    expect(parseShadowArgs(['default', '--shadow', 'on', '--dry-run'])).toMatchObject({ sourceId: 'default', action: 'shadow_on', dryRun: true });
    expect(parseShadowArgs(['default', '--shadow', 'off', '--admin-intent', INTENT, '--expected-state', 'f'.repeat(64)]))
      .toMatchObject({ action: 'shadow_off', admin_intent: INTENT, expected_state: 'f'.repeat(64) });
    expect(parseShadowArgs(['default', '--shadow-drain', '--limit', '50', '--json'])).toMatchObject({ action: 'drain', limit: 50, json: true });
    for (const args of [['default', '--shadow', 'maybe'], ['default', '--shadow', 'on', '--purge-shadow'], ['default', '--shadow-status', '--dry-run'],
      ['default', '--shadow', 'on', '--dry-run', '--admin-intent', INTENT], ['--shadow-drain'], ['default', '--shadow-drain', '--limit', '0']]) {
      expect(() => parseShadowArgs(args)).toThrow(OperationError);
    }
  });
});
