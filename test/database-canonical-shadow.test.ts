import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { consumeExportOutbox, exportOutboxStats, listShadowedSources, lockExportWriters, readExportOutbox, readSourceCanonicalState,
  sourceShadowEnabled, writeSourceShadow } from '../src/core/persistence/canonical-shadow.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const fact = (claim: string) => ({ rowNum: 1, claim, kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const, active: true, context: '' });

for (const backend of testBackends()) describe(`database-canonical wave 2 outbox triggers: ${backend}`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM database_canonical_sources');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id IN ('default','source-b')");
    await engine.executeRaw("DELETE FROM fact_purges WHERE source_id IN ('default','source-b')");
    await engine.executeRaw("DELETE FROM facts WHERE source='fixture'");
    await engine.executeRaw('DELETE FROM export_outbox');
    await engine.executeRaw("DELETE FROM sources WHERE id='source-b'");
  });

  const shadow = (sourceId: string, on: boolean) => engine.transaction(async tx => { await lockExportWriters(tx); return writeSourceShadow(tx, sourceId, on); });
  const outbox = async () => (await readExportOutbox(engine, 'default', 100)).map(r => ({ slug: r.slug, cause: r.cause, revision: r.revision }));
  const revisionOf = async (slug: string) => (await engine.executeRaw<{ r: string }>("SELECT knowledge_revision::text AS r FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.r;

  test('with no shadowed source a page write calls no outbox code past the brain-level check and leaves no row', async () => {
    expect(await listShadowedSources(engine)).toEqual([]);
    await engine.putPage('cost/page', { type: 'note', title: 'Cost', compiled_truth: 'Body.', timeline: '' });
    const calls = await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL track_functions = 'pl'");
      await tx.executeRaw("UPDATE pages SET compiled_truth='Edited body.' WHERE source_id='default' AND slug='cost/page'");
      const [row] = await tx.executeRaw<{ trigger: number; put: number }>(`SELECT
        COALESCE(pg_stat_get_xact_function_calls('gbrain_enqueue_page_export'::regproc),0)::int AS trigger,
        COALESCE(pg_stat_get_xact_function_calls('gbrain_export_outbox_put'::regproc),0)::int AS put`);
      return row!;
    });
    expect(calls).toEqual({ trigger: 1, put: 0 });
    const [count] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM export_outbox');
    expect(Number(count!.n)).toBe(0);
    const [brain] = await engine.executeRaw<{ active: number }>('SELECT COALESCE((SELECT active_sources FROM database_canonical_brain WHERE singleton=1),0)::int AS active');
    expect(Number(brain!.active)).toBe(0);
  });

  test('the export triggers depend on no table column and the recount trigger has no TRUNCATE event', async () => {
    const columnDeps = await engine.executeRaw<{ tgname: string }>(`SELECT t.tgname FROM pg_trigger t
      JOIN pg_depend d ON d.classid = 'pg_trigger'::regclass AND d.objid = t.oid AND d.refobjsubid > 0
      WHERE t.tgname IN ('pages_export_outbox_insert','pages_export_outbox_update','pages_export_outbox_delete',
        'fact_withdrawals_export_outbox','fact_purges_export_outbox','database_canonical_sources_count')`);
    expect(columnDeps).toEqual([]);
    const [count] = await engine.executeRaw<{ truncate: boolean }>(
      "SELECT (tgtype::int & 32) <> 0 AS truncate FROM pg_trigger WHERE tgname = 'database_canonical_sources_count'");
    expect(count).toEqual({ truncate: false });
  });

  test('a shadowed source gets one coalesced row per page at its newest revision; other sources get none', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('source-b','source-b')");
    const state = await shadow('default', true);
    expect(state).toMatchObject({ source_id: 'default', shadow: true, shadow_epoch: 1 });
    expect(await sourceShadowEnabled(engine, 'default')).toBe(true);
    expect(await sourceShadowEnabled(engine, 'source-b')).toBe(false);
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'One.', timeline: '' });
    await engine.putPage('notes/other', { type: 'note', title: 'Other', compiled_truth: 'Other.', timeline: '' }, { sourceId: 'source-b' });
    const [first] = await readExportOutbox(engine, 'default', 10);
    expect(first).toMatchObject({ slug: 'notes/a', cause: 'created', revision: await revisionOf('notes/a') });
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Two.', timeline: '' });
    const rows = await readExportOutbox(engine, 'default', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'notes/a', cause: 'written', revision: await revisionOf('notes/a'), first_enqueued_at: first!.first_enqueued_at });
    expect(BigInt(rows[0]!.seq)).toBeGreaterThan(BigInt(first!.seq));
    expect(await readExportOutbox(engine, 'source-b', 10)).toEqual([]);
    // A write that changes no knowledge (an embedding stamp) does not enqueue.
    await consumeExportOutbox(engine, rows);
    await engine.executeRaw("UPDATE pages SET links_extracted_at=now() WHERE source_id='default' AND slug='notes/a'");
    expect(await outbox()).toEqual([]);
  });

  test('a bare coordinated write with no request appears, and so do soft deletes, purges and moves out', async () => {
    await shadow('default', true);
    await engine.putPage('bare/page', { type: 'note', title: 'Bare', compiled_truth: 'Before.', timeline: '' });
    await consumeExportOutbox(engine, await readExportOutbox(engine, 'default', 10));
    await engine.executeRaw("UPDATE pages SET compiled_truth='After.' WHERE source_id='default' AND slug='bare/page'");
    expect(await outbox()).toEqual([{ slug: 'bare/page', cause: 'written', revision: await revisionOf('bare/page') }]);
    await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='bare/page'");
    expect(await outbox()).toEqual([{ slug: 'bare/page', cause: 'deleted', revision: await revisionOf('bare/page') }]);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='bare/page'");
    expect(await outbox()).toEqual([{ slug: 'bare/page', cause: 'purged', revision: null }]);
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('source-b','source-b')");
    await engine.putPage('moved/page', { type: 'note', title: 'Moved', compiled_truth: 'Body.', timeline: '' });
    await engine.executeRaw("UPDATE pages SET source_id='source-b' WHERE source_id='default' AND slug='moved/page'");
    expect((await outbox()).find(r => r.slug === 'moved/page')).toEqual({ slug: 'moved/page', cause: 'moved_out', revision: null });
  });

  test('a fact withdrawal enqueues the pages whose fence holds the claim, and the subject page', async () => {
    await shadow('default', true);
    await engine.putPage('facts/page', { type: 'note', title: 'Facts', compiled_truth: renderFactsTable([fact('A synthetic claim')]), timeline: '' });
    await engine.putPage('plain/page', { type: 'note', title: 'Plain', compiled_truth: renderFactsTable([fact('Another synthetic claim')]), timeline: '' });
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Notes.', timeline: '' });
    for (const [slug, claim] of [['facts/page', 'A synthetic claim'], ['plain/page', 'Another synthetic claim']]) {
      await engine.executeRaw("INSERT INTO facts(fact, source, source_id, visibility, source_markdown_slug, row_num) VALUES ($1,'fixture','default','world',$2,1)", [claim, slug]);
    }
    await consumeExportOutbox(engine, await readExportOutbox(engine, 'default', 10));
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['A synthetic claim']);
    expect(await outbox()).toEqual([{ slug: 'facts/page', cause: 'withdrawal', revision: await revisionOf('facts/page') }]);
    await consumeExportOutbox(engine, await readExportOutbox(engine, 'default', 10));
    await engine.executeRaw("INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ('default','world','people/alice-example',gbrain_fact_fingerprint($1))", ['Unrelated claim']);
    expect(await outbox()).toEqual([{ slug: 'people/alice-example', cause: 'withdrawal', revision: await revisionOf('people/alice-example') }]);
  });

  test('two writes that commit in reverse order both appear, and the consumer never drops a row upserted after it read it', async () => {
    await shadow('default', true);
    await engine.putPage('rev/a', { type: 'note', title: 'A', compiled_truth: 'A0.', timeline: '' });
    await engine.putPage('rev/b', { type: 'note', title: 'B', compiled_truth: 'B0.', timeline: '' });
    await consumeExportOutbox(engine, await readExportOutbox(engine, 'default', 10));
    if (backend === 'postgres') {
      // A takes its outbox seq first and commits last; a consumer that drained between the commits still sees A.
      const other = new PostgresEngine();
      await other.connect({ database_url: requirePostgresTestDatabase(), poolSize: 2 });
      try {
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(r => { release = r; }), inside = new Promise<void>(r => { entered = r; });
        const writerA = engine.transaction(async tx => {
          await tx.executeRaw("UPDATE pages SET compiled_truth='A1.' WHERE source_id='default' AND slug='rev/a'");
          entered();
          await gate;
        });
        await inside;
        await other.executeRaw("UPDATE pages SET compiled_truth='B1.' WHERE source_id='default' AND slug='rev/b'");
        const drained = await readExportOutbox(other, 'default', 10);
        expect(drained.map(r => r.slug)).toEqual(['rev/b']);
        expect(await consumeExportOutbox(other, drained)).toBe(1);
        release();
        await writerA;
        const after = await readExportOutbox(engine, 'default', 10);
        expect(after.map(r => r.slug)).toEqual(['rev/a']);
        expect(BigInt(after[0]!.seq)).toBeLessThan(BigInt(drained[0]!.seq));
      } finally { await other.disconnect(); }
    } else {
      await engine.executeRaw("UPDATE pages SET compiled_truth='B1.' WHERE source_id='default' AND slug='rev/b'");
      const drained = await readExportOutbox(engine, 'default', 10);
      expect(await consumeExportOutbox(engine, drained)).toBe(1);
      await engine.executeRaw("UPDATE pages SET compiled_truth='A1.' WHERE source_id='default' AND slug='rev/a'");
      expect((await outbox()).map(r => r.slug)).toEqual(['rev/a']);
    }
    const read = await readExportOutbox(engine, 'default', 10);
    await engine.executeRaw("UPDATE pages SET compiled_truth='A2.' WHERE source_id='default' AND slug='rev/a'");
    expect(await consumeExportOutbox(engine, read)).toBe(0);
    expect(await outbox()).toEqual([{ slug: 'rev/a', cause: 'written', revision: await revisionOf('rev/a') }]);
  });

  test('shadow off stops new rows and keeps the existing ones; the brain count follows the flag', async () => {
    await shadow('default', true);
    await engine.putPage('off/kept', { type: 'note', title: 'Kept', compiled_truth: 'Body.', timeline: '' });
    const off = await shadow('default', false);
    expect(off).toMatchObject({ shadow: false, shadow_epoch: 2 });
    await engine.putPage('off/new', { type: 'note', title: 'New', compiled_truth: 'Body.', timeline: '' });
    await engine.putPage('off/kept', { type: 'note', title: 'Kept', compiled_truth: 'Edited.', timeline: '' });
    expect((await outbox()).map(r => [r.slug, r.cause])).toEqual([['off/kept', 'created']]);
    expect((await exportOutboxStats(engine, 'default')).depth).toBe(1);
    const [brain] = await engine.executeRaw<{ active: number }>('SELECT active_sources::int AS active FROM database_canonical_brain WHERE singleton=1');
    expect(Number(brain!.active)).toBe(0);
    expect(await readSourceCanonicalState(engine, 'default')).toMatchObject({ shadow: false, shadow_epoch: 2 });
  });
});
