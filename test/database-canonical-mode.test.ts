/**
 * Database-canonical wave 4 (docs/designs/database-canonical-w4-contract.md): the per-source mode, its protocol fence, the
 * publication branch and the preview-bound flip of an empty source. Real PGLite and real Postgres (`testBackends`).
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { DATABASE_CANONICAL_KEY } from '../src/core/persistence/canonical-export.ts';
import { CANONICAL_PROTOCOL_DECLARATION, canonicalFenceRefusal, inflightWork, readSourceMode } from '../src/core/persistence/canonical-mode.ts';
import { admitWriteGroupInTransaction, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declareDurablePersistence } from '../src/core/persistence/protocol.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { flipSourceMode } from '../src/commands/sources-canonical-mode.ts';
import { databaseCanonicalFenceEntry } from '../src/commands/doctor/checks/database-canonical-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import type { Check } from '../src/commands/doctor.ts';
import { consumeExportOutbox, exportOutboxStats, readExportOutbox } from '../src/core/persistence/canonical-shadow.ts';
import { applyShadowChange, previewShadowChange } from '../src/commands/sources-canonical-shadow.ts';
import { sourceCanonicalAdminState } from '../src/core/persistence/canonical-admin.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { UNSETTLED_REQUEST_SQL } from '../src/core/persistence/canonical-mode-schema.ts';

const op = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx, params) as Promise<any>;
const note = (title: string, body = 'A synthetic note.') => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;
/** Database mode set directly (the fence tests); the verb is tested on its own below. */
const toDatabase = (engine: BrainEngine, sourceId = 'default') => engine.executeRaw(`INSERT INTO database_canonical_sources(source_id,source_incarnation,shadow,shadow_epoch,mode,mode_epoch)
    SELECT id,incarnation,true,1,'database',1 FROM sources WHERE id=$1
  ON CONFLICT (source_id) DO UPDATE SET mode='database',shadow=true,mode_epoch=database_canonical_sources.mode_epoch+1`, [sourceId]);
async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; fence?: string; error: unknown }> {
  try { await run(); } catch (error) {
    return { error, code: error instanceof OperationError ? error.code : (error as { code?: string }).code, fence: canonicalFenceRefusal(error)?.code };
  }
  throw new Error('expected a refusal');
}
/** A hand-rolled coordinated write: the managed guard's `gbrain.write_sources`, with or without the canonical declaration. */
const handWrite = <T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>, declare: boolean) => engine.transaction(async tx => {
  await tx.executeRaw(`SELECT set_config('gbrain.write_sources', $1, true)${declare ? `,${CANONICAL_PROTOCOL_DECLARATION}` : ''}`, [JSON.stringify(['default'])]);
  return run(tx);
});
/** Persistence-protocol administration of fixture rows (effects, requests), as the coordinator's own statements run. */
const administer = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(async tx => {
  await declareDurablePersistence(tx);
  await tx.executeRaw(`SELECT set_config('gbrain.write_sources', $1, true)`, [JSON.stringify(['default'])]);
  return tx.executeRaw(sql, params);
});
/**
 * Marks the source's effects committed, as their runs would, leaving a claimed one to the in-process consumer running it
 * (on Postgres its completion lands after the put returns) and marking it once that run releases it.
 */
async function settleEffects(engine: BrainEngine): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    await administer(engine, "UPDATE persistence_effects SET state='committed' WHERE source_id='default' AND state<>'committed' AND execution_token IS NULL");
    if (!(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id='default' AND state<>'committed'")).length) return;
    if (performance.now() > deadline) throw new Error('effects of default still open after the wait');
    await Bun.sleep(50);
  }
}
const effectKinds = async (engine: BrainEngine, requestRowId: string) =>
  (await engine.executeRaw<{ kind: string; worktree_id: string | null }>('SELECT kind, worktree_id FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind', [requestRowId]));
const latestRequest = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: string; worktree_id: string | null; canonical_epoch: string | null; state: string; outcome: any }>(
  'SELECT id, worktree_id, canonical_epoch::text AS canonical_epoch, state, outcome FROM persistence_requests WHERE slug=$1 ORDER BY sequence DESC LIMIT 1', [slug]))[0]!;

for (const backend of testBackends()) describe(`database-canonical wave 4 mode and fence: ${backend}`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { databaseUrl });

  test('the fence refuses an undeclared write and a checkout effect for a database-mode source, admits a declared one, and leaves files mode alone', async () => {
    await brain(async ({ engine }) => {
      // Files mode: an undeclared coordinated write passes exactly as before, and the brain-level counter is zero.
      await handWrite(engine, tx => tx.putPage('notes/files-mode', { type: 'note', title: 'Files', compiled_truth: 'Before.', timeline: '' }), false);
      expect(Number((await engine.executeRaw<{ n: number }>('SELECT COALESCE((SELECT database_sources FROM database_canonical_brain WHERE singleton=1),0)::int AS n'))[0]!.n)).toBe(0);
      await toDatabase(engine);
      expect(Number((await engine.executeRaw<{ n: number }>('SELECT database_sources AS n FROM database_canonical_brain WHERE singleton=1'))[0]!.n)).toBe(1);
      // An older binary, or a session that set gbrain.write_sources by hand: no declaration.
      const bare = await refusal(() => handWrite(engine, tx => tx.putPage('notes/bare', { type: 'note', title: 'Bare', compiled_truth: 'Bare.', timeline: '' }), false));
      expect(bare.fence).toBe('canonical_protocol_required');
      expect(String((bare.error as Error).message)).toStartWith('canonical_protocol_required:');
      // The same write with the transaction-local declaration commits.
      await handWrite(engine, tx => tx.putPage('notes/declared', { type: 'note', title: 'Declared', compiled_truth: 'Declared.', timeline: '' }), true);
      expect(await engine.getPage('notes/declared', { sourceId: 'default' })).not.toBeNull();
      // The declaration does not outlive its transaction: the next undeclared write is refused again.
      expect((await refusal(() => handWrite(engine, tx => tx.executeRaw("UPDATE pages SET compiled_truth='Edited.' WHERE source_id='default' AND slug='notes/declared'"), false))).fence)
        .toBe('canonical_protocol_required');
      // A declared writer still cannot insert a checkout effect or a worktree-bound request for the source.
      const [binding] = await engine.executeRaw<{ worktree_id: string; incarnation: string }>("SELECT b.worktree_id, s.incarnation FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id WHERE b.source_id='default'");
      // A declared, worktree-free request is admitted and stamped with the mode epoch.
      const [request] = await administer(engine, `INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation)
        VALUES('local_cli','cli:example',gen_random_uuid(),'put_page','default',$1::uuid,'notes/request','d','{}'::jsonb,1,16384) RETURNING id, canonical_epoch::text AS canonical_epoch`, [binding!.incarnation]) as Array<{ id: string; canonical_epoch: string }>;
      expect(request!.canonical_epoch).toBe('1');
      for (const kind of ['git', 'withdrawal-mirror']) {
        const refused = await refusal(() => administer(engine, `INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
          VALUES($1::uuid,$2,'{}'::jsonb,'default',$3::uuid,NULL)`, [request!.id, kind, binding!.incarnation]));
        expect(refused.fence).toBe('canonical_publication_required');
      }
      await administer(engine, `INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id) VALUES($1::uuid,'embedding','{}'::jsonb,'default',$2::uuid,NULL)`,
        [request!.id, binding!.incarnation]);
      const worktreeBound = await refusal(() => engine.transaction(async tx => {
        await declareDurablePersistence(tx);
        await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,worktree_id)
          VALUES('local_cli','cli:example',gen_random_uuid(),'put_page','default',$1::uuid,'notes/bound','d','{}'::jsonb,1,16384,$2::uuid)`, [binding!.incarnation, binding!.worktree_id]);
      }));
      expect(worktreeBound.fence).toBe('canonical_publication_required');
    });
  }, 120_000);

  test('agent writes publish database-only with no worktree, file or checkout effect; forget inserts no withdrawal-mirror or git row', async () => {
    await brain(async ({ engine, ctx, root }) => {
      await toDatabase(engine);
      const facts = '## Facts\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
        + '|---|---|---|---|---|---|---|---|---|---|\n| 1 | Alder Example likes example tea | preference | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->\n';
      const receipt = await op(ctx, 'put_page', { slug: 'people/alder-example', content: note('Alder Example', `Alder Example is a fictional engineer.\n\n${facts}`) });
      expect(receipt.write_through).toMatchObject({ written: false, skipped: 'database_canonical' });
      const row = await latestRequest(engine, 'people/alder-example');
      expect(row).toMatchObject({ worktree_id: null, canonical_epoch: '1', state: 'committed' });
      expect((await effectKinds(engine, row.id)).filter(e => e.kind === 'git' || e.kind === 'withdrawal-mirror')).toEqual([]);
      expect(existsSync(join(root, 'people', 'alder-example.md'))).toBe(false);
      const page = await engine.readPageSnapshot('people/alder-example', { sourceId: 'default' });
      expect(page?.page.source_path ?? null).toBeNull();
      const [fact] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source_id='default' AND entity_slug='people/alder-example' LIMIT 1");
      expect(fact).toBeDefined();
      await op(ctx, 'forget_fact', { id: Number(fact!.id) });
      const forget = (await engine.executeRaw<{ id: string }>("SELECT id FROM persistence_requests WHERE operation='forget_fact' ORDER BY sequence DESC LIMIT 1"))[0]!;
      const kinds = await effectKinds(engine, forget.id);
      expect(kinds.map(k => k.kind)).not.toContain('git');
      expect(kinds.map(k => k.kind)).not.toContain('withdrawal-mirror');
      expect(kinds.every(k => k.worktree_id === null)).toBe(true);
      expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE source_id='default' AND kind IN ('git','withdrawal-mirror')"))[0]!.n)).toBe(0);
    });
  }, 120_000);

  test('an agent write commits and returns its receipt while the export owner is down: no consumer, no checkout', async () => {
    await brain(async ({ engine, ctx, root }) => {
      await toDatabase(engine);
      await disposePersistenceConsumer(engine);
      rmSync(root, { recursive: true, force: true });
      const receipt = await op(ctx, 'put_page', { slug: 'notes/owner-down', content: note('Owner down') });
      expect(receipt.write_through).toMatchObject({ written: false, skipped: 'database_canonical' });
      expect(await latestRequest(engine, 'notes/owner-down')).toMatchObject({ worktree_id: null, canonical_epoch: '1', state: 'committed' });
      expect((await engine.readPageSnapshot('notes/owner-down', { sourceId: 'default' }))?.page.title).toBe('Owner down');
      expect(existsSync(root)).toBe(false);
    });
  }, 120_000);

  test('many writes with the exporter stopped: no checkout work accumulates, and the outbox keeps one row per page (files-mode control queues Git)', async () => {
    const WRITES = 100, PAGES = 10;
    const writeMany = async (ctx: OperationContext, engine: BrainEngine) => {
      for (let i = 0; i < WRITES; i++) {
        const slug = `notes/bulk-${i % PAGES}`;
        const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        await op(ctx, 'put_page', { slug, content: note(`Bulk ${i % PAGES}`, `Revision ${i}.`), ...(current ? { expected_revision: current.revision } : {}) });
      }
    };
    const counts = (engine: BrainEngine) => engine.executeRaw<{ requests: number; unsettled: number; checkout: number; outbox: number }>(`SELECT
      (SELECT count(*)::int FROM persistence_requests WHERE source_id='default' AND operation='put_page') AS requests,
      (SELECT count(*)::int FROM persistence_requests r WHERE r.source_id='default' AND ${UNSETTLED_REQUEST_SQL('r')}) AS unsettled,
      (SELECT count(*)::int FROM persistence_effects WHERE source_id='default' AND kind IN ('git','withdrawal-mirror')) AS checkout,
      (SELECT count(*)::int FROM export_outbox WHERE source_id='default') AS outbox`).then(rows => rows[0]!);
    await brain(async ({ engine, ctx }) => {
      await toDatabase(engine);
      await disposePersistenceConsumer(engine);
      await writeMany(ctx, engine);
      expect(await counts(engine)).toEqual({ requests: WRITES, unsettled: 0, checkout: 0, outbox: PAGES });
    });
    await brain(async ({ engine, ctx }) => {
      await writeMany(ctx, engine);
      const control = await counts(engine);
      expect(control.requests).toBe(WRITES);
      expect(control.checkout).toBeGreaterThanOrEqual(WRITES);
      expect(control.outbox).toBe(0);
    });
  }, 300_000);

  test('a checkout effect left from files mode is never claimed once the source is in database mode', async () => {
    await brain(async ({ engine, ctx }) => {
      await op(ctx, 'put_page', { slug: 'notes/before-flip', content: note('Before flip') });
      const git = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_effects WHERE source_id='default' AND kind='git'");
      expect(git.length).toBeGreaterThan(0);
      await administer(engine, "UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,next_attempt_at=now() WHERE source_id='default' AND kind='git'");
      await toDatabase(engine);
      for (let i = 0; i < 10; i++) {
        const claimed = await claimPersistenceEffect(engine, localHostId());
        if (!claimed) break;
        expect(claimed.kind).not.toBe('git');
      }
    });
  }, 120_000);

  test('file-lane admissions refuse source_database_mode, and a group mixing them with page writes refuses canonical_mixed_group', async () => {
    await brain(async ({ engine, ctx }) => {
      await toDatabase(engine);
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const [binding] = await engine.executeRaw<{ worktree_id: string; topology_generation: string }>("SELECT worktree_id, topology_generation::text AS topology_generation FROM persistence_source_bindings WHERE source_id='default'");
      const admission = async (slug: string, kind?: string): Promise<WriteAdmission> => {
        const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
        const intent = { slug, content: note(slug), ...(kind ? { kind } : {}) };
        return { principal: authority.principal, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation, slug, pageId: null, requestId: randomUUID(),
          callerIntent: intent, intent, authority, worktreeId: binding!.worktree_id, topologyGeneration: binding!.topology_generation };
      };
      const write = (inputs: WriteAdmission[]) => engine.transaction(async tx => { await declareDurablePersistence(tx); return admitWriteGroupInTransaction(tx, inputs); });
      expect((await refusal(async () => write([await admission('notes/imported', 'managed_file_import')]))).code).toBe('source_database_mode');
      expect((await refusal(async () => write([await admission('notes/page-a'), await admission('notes/imported-b', 'managed_file_import')]))).code).toBe('canonical_mixed_group');
      // A group of page writes alone is admitted with no worktree.
      const rows = await write([await admission('notes/page-c'), await admission('notes/page-d')]);
      expect(rows.map(r => r.worktree_id)).toEqual([null, null]);
      expect(rows.map(r => String(r.canonical_epoch))).toEqual(['1', '1']);
    });
  }, 120_000);

  test('the verb flips only an empty managed source, bound to its preview, and refuses while the gate is off', async () => {
    await brain(async ({ engine, ctx }) => {
      const args = (to: 'database' | 'files', expectedState?: string) => ({ sourceId: 'default', to, dryRun: expectedState === undefined, json: true, ...(expectedState ? { expectedState } : {}) });
      expect((await refusal(() => flipSourceMode(engine, args('database')))).code).toBe('database_canonical_disabled');
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
      // Not empty: a live page refuses with the condition named.
      await op(ctx, 'put_page', { slug: 'notes/existing', content: note('Existing') });
      const busy = await flipSourceMode(engine, args('database'));
      expect(busy.preview!.apply).toBeNull();
      expect(busy.preview!.refusals.map(r => [r.code, r.condition])).toContainEqual(['canonical_source_not_empty', 'live_pages']);
      await administer(engine, "DELETE FROM pages WHERE source_id='default'");
      await settleEffects(engine);
      const shown = await flipSourceMode(engine, args('database'));
      expect(shown.preview!.refusals).toEqual([]);
      expect(shown.preview!.apply).toEqual(['gbrain', 'sources', 'canonical', 'default', '--to', 'database', '--admin-intent', 'source_canonical', '--expected-state', shown.preview!.fingerprint]);
      // A write after the preview moves the fingerprint.
      await handWrite(engine, tx => tx.putPage('notes/late', { type: 'note', title: 'Late', compiled_truth: 'Late.', timeline: '' }), true);
      expect((await refusal(() => flipSourceMode(engine, args('database', shown.preview!.fingerprint)))).code).toBe('preview_changed');
      await administer(engine, "DELETE FROM pages WHERE source_id='default'");
      const again = await flipSourceMode(engine, args('database'));
      const flipped = await flipSourceMode(engine, args('database', again.preview!.fingerprint));
      expect(flipped).toMatchObject({ status: 'flipped', mode: 'database', mode_epoch: 1 });
      expect(await readSourceMode(engine, 'default')).toMatchObject({ mode: 'database', mode_epoch: 1, shadow: true, eligibility_generation: 1 });
      const unchanged = await flipSourceMode(engine, args('database'));
      expect(unchanged.preview!.refusals.map(r => r.code)).toEqual(['canonical_mode_unchanged']);
      // Wave 2's shadow-off is refused while the source is in database mode, at the preview and at the apply; the
      // constraint is the backstop for a raw update.
      expect((await refusal(() => previewShadowChange(engine, 'default', 'shadow_off', 0))).code).toBe('canonical_mode_requires_shadow');
      const offState = await sourceCanonicalAdminState(engine, 'default', 'shadow_off');
      expect((await refusal(() => applyShadowChange(engine, 'default', 'shadow_off', { admin_intent: 'source_canonical', expected_state: offState }))).code)
        .toBe('canonical_mode_requires_shadow');
      expect(await readSourceMode(engine, 'default')).toMatchObject({ mode: 'database', shadow: true });
      expect((await refusal(() => engine.executeRaw("UPDATE database_canonical_sources SET shadow=false WHERE source_id='default'")))).toBeDefined();
    });
  }, 120_000);

  test('the flip back keeps one database-ahead hold per page written in database mode, none for a deleted page, and refuses a write after the preview', async () => {
    await brain(async ({ engine, ctx }) => {
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
      const preview = await flipSourceMode(engine, { sourceId: 'default', to: 'database', dryRun: true, json: true });
      await flipSourceMode(engine, { sourceId: 'default', to: 'database', dryRun: false, json: true, expectedState: preview.preview!.fingerprint });
      await op(ctx, 'put_page', { slug: 'notes/created', content: note('Created') });
      await op(ctx, 'put_page', { slug: 'notes/edited', content: note('Edited', 'First.') });
      const edited = await engine.readPageSnapshot('notes/edited', { sourceId: 'default' });
      await op(ctx, 'put_page', { slug: 'notes/edited', content: note('Edited', 'Second.'), expected_revision: edited!.revision });
      await op(ctx, 'put_page', { slug: 'notes/deleted', content: note('Deleted') });
      await op(ctx, 'delete_page', { slug: 'notes/deleted', expected_revision: (await engine.readPageSnapshot('notes/deleted', { sourceId: 'default' }))!.revision });
      await settleEffects(engine);
      const back = await flipSourceMode(engine, { sourceId: 'default', to: 'files', dryRun: true, json: true });
      expect(back.preview!.refusals).toEqual([]);
      expect(back.preview!.holds_to_write).toBe(2);
      // The exporter draining the outbox and another source's write advancing the shared sequence leave the fingerprint.
      const drained = await engine.transaction(async tx => {
        await declareDurablePersistence(tx);
        return consumeExportOutbox(tx, await readExportOutbox(tx, 'default', 100));
      });
      expect(drained).toBeGreaterThan(0);
      expect(await exportOutboxStats(engine, 'default')).toMatchObject({ depth: 0 });
      await engine.executeRaw("SELECT nextval('export_outbox_seq')");
      expect((await flipSourceMode(engine, { sourceId: 'default', to: 'files', dryRun: true, json: true })).preview!.fingerprint).toBe(back.preview!.fingerprint);
      // A write after the preview: preview_changed, nothing flipped.
      await op(ctx, 'put_page', { slug: 'notes/after-preview', content: note('After preview') });
      await settleEffects(engine);
      expect((await refusal(() => flipSourceMode(engine, { sourceId: 'default', to: 'files', dryRun: false, json: true, expectedState: back.preview!.fingerprint }))).code).toBe('preview_changed');
      expect((await readSourceMode(engine, 'default')).mode).toBe('database');
      const fresh = await flipSourceMode(engine, { sourceId: 'default', to: 'files', dryRun: true, json: true });
      const done = await flipSourceMode(engine, { sourceId: 'default', to: 'files', dryRun: false, json: true, expectedState: fresh.preview!.fingerprint });
      expect(done).toMatchObject({ status: 'flipped', mode: 'files', mode_epoch: 2, holds_written: 3 });
      const holds = (await readGitSourceHolds(engine, { sourceIds: ['default'] })).flatMap(h => h.holds);
      expect(holds.map(h => [h.slug, h.code, h.meta.sides]).sort()).toEqual([
        ['notes/after-preview', 'file_drift', 'database'], ['notes/created', 'file_drift', 'database'], ['notes/edited', 'file_drift', 'database']]);
      expect(await readSourceMode(engine, 'default')).toMatchObject({ mode: 'files', mode_epoch: 2, shadow: true });
    });
  }, 120_000);

  test('a request holding a recovery record blocks the flip with the predicate fence 3a reads', async () => {
    await brain(async ({ engine }) => {
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
      await engine.transaction(async tx => { await declareDurablePersistence(tx); await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,state,recovery)
        SELECT 'local_cli','cli:example',gen_random_uuid(),'put_page','default',incarnation,'notes/recovering','d','{}'::jsonb,1,16384,'committed','{"version":1}'::jsonb FROM sources WHERE id='default'`); });
      expect((await inflightWork(engine, 'default')).requests).toBe(1);
      const blocked = await flipSourceMode(engine, { sourceId: 'default', to: 'database', dryRun: true, json: true });
      expect(blocked.preview!.refusals.map(r => [r.code, r.condition])).toContainEqual(['canonical_inflight_work', 'requests']);
    });
  }, 120_000);

  test('doctor database_canonical_fence: green with no database-mode source, red on an unfinished checkout effect, yellow with the gate off', async () => {
    await brain(async ({ engine, ctx }) => {
      const run = async () => (await databaseCanonicalFenceEntry.run({ engine } as never) as Check[])[0]!;
      expect(await run()).toMatchObject({ name: 'database_canonical_fence', status: 'ok' });
      await op(ctx, 'put_page', { slug: 'notes/before-flip', content: note('Before flip') });
      await administer(engine, "UPDATE persistence_effects SET state='queued',execution_token=NULL WHERE source_id='default' AND kind='git'");
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
      await toDatabase(engine);
      const red = await run();
      expect(red.status).toBe('fail');
      expect(red.message).toContain('unfinished checkout effect(s)');
      await administer(engine, "UPDATE persistence_effects SET state='committed' WHERE source_id='default' AND kind='git'");
      expect((await run()).status).toBe('ok');
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'false');
      expect(await run()).toMatchObject({ status: 'warn' });
      expect((await run()).message).toContain('is off while 1 source(s) are in database mode');
    });
  }, 120_000);
});

/**
 * Postgres only: the declaration is transaction-local on one server connection (a transaction-mode pooler hands that
 * connection to another client next), and the flip closes the race of a writer that passed its fence before the flip.
 */
if (process.env.DATABASE_URL) describe('database-canonical wave 4 on one Postgres connection', () => {
  const databaseUrl = requirePostgresTestDatabase();
  const connect = async (engine: BrainEngine) => {
    const [db] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    const url = new URL(databaseUrl); url.pathname = `/${db!.name}`;
    return postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  };

  test('set_config(..., true) ends with its transaction on the same connection', async () => {
    await managedBrain(async ({ engine }) => {
      const sql = await connect(engine);
      try {
        const [inside] = await sql.begin(async tx => tx.unsafe(`SELECT ${CANONICAL_PROTOCOL_DECLARATION} AS v, pg_backend_pid() AS pid`));
        const [after] = await sql.unsafe("SELECT current_setting('gbrain.canonical_protocol', true) AS v, pg_backend_pid() AS pid");
        expect(after!.pid).toBe(inside!.pid);
        expect(inside!.v).toBe('1');
        expect(after!.v ?? '').toBe('');
      } finally { await sql.end(); }
    }, { databaseUrl });
  }, 120_000);

  test('a writer that passed its fence before the flip commits first, and the flip then refuses preview_changed', async () => {
    await managedBrain(async ({ engine }) => {
      await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
      const shown = await flipSourceMode(engine, { sourceId: 'default', to: 'database', dryRun: true, json: true });
      const writer = await connect(engine);
      try {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const done = writer.begin(async tx => {
          await tx.unsafe("SELECT set_config('gbrain.write_sources', '[\"default\"]', true)");
          await tx.unsafe("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline) VALUES ('default','notes/racer','note','Racer','Raced.','')");
          await gate;
        });
        await Bun.sleep(200);
        const flip = flipSourceMode(engine, { sourceId: 'default', to: 'database', dryRun: false, json: true, expectedState: shown.preview!.fingerprint }).then(() => null, error => error);
        await Bun.sleep(300);
        release(); await done;
        const error = await flip;
        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).code).toBe('preview_changed');
        expect((await readSourceMode(engine, 'default')).mode).toBe('files');
      } finally { await writer.end(); }
    }, { databaseUrl });
  }, 120_000);

  test('a writer that waits behind the flip runs its fence after the flip commits and is refused', async () => {
    await managedBrain(async ({ engine }) => {
      const flip = await connect(engine), writer = await connect(engine);
      try {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const flipped = flip.begin(async tx => {
          await tx.unsafe("SELECT id FROM sources WHERE id='default' FOR UPDATE");
          await tx.unsafe('LOCK TABLE pages IN SHARE MODE');
          await tx.unsafe(`INSERT INTO database_canonical_sources(source_id,source_incarnation,shadow,shadow_epoch,mode,mode_epoch)
            SELECT id,incarnation,true,1,'database',1 FROM sources WHERE id='default'`);
          await gate;
        });
        await Bun.sleep(200);
        const write = writer.begin(async tx => {
          await tx.unsafe("SELECT set_config('gbrain.write_sources', '[\"default\"]', true)");
          await tx.unsafe("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline) VALUES ('default','notes/late','note','Late','Late.','')");
        }).then(() => null, error => error);
        await Bun.sleep(300);
        release(); await flipped;
        const error = await write;
        expect(canonicalFenceRefusal(error)?.code).toBe('canonical_protocol_required');
        expect((await engine.executeRaw("SELECT 1 FROM pages WHERE slug='notes/late'")).length).toBe(0);
      } finally { await flip.end(); await writer.end(); }
    }, { databaseUrl });
  }, 120_000);
});
