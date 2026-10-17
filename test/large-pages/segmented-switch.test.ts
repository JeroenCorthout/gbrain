/**
 * Wave B PR 2 switch-on (spec 1.1 activation gate, 13 PR 2): `pages.segmented_storage` follows
 * SEGMENTED_STORAGE_DEFAULT when unset and is gated by the writer versions recorded on committed persistence requests.
 *
 * 1. Protects: with no configuration a page over 1 MiB is stored inline under the 24 MiB limit while the default is
 *    off, and doctor offers the switch; a writer older than SEGMENTED_WRITER_FLOOR (or unstamped) seen in the last seven days keeps writes
 *    inline, even with an explicit `on`, and doctor `segmented_storage` names it with an upgrade fix; once that
 *    observation is gone the next write promotes; an explicit `off` keeps pages inline and reports it as a choice;
 *    (a stored segmented page over 32 MiB exporting while the switch is off is in segmented-real-size.slow.test.ts). Every write the gate sees must carry the
 *    segment-reader mark (v254): a release at exactly the floor version without it, an older binary's import or sync
 *    run (ingest_log), its resident heartbeat and its uncommitted requests all block; this build's do not. An
 *    unreadable gate blocks, an unparsable stamp blocks, the 7-day window ends between day 6 and day 8, and the gate is
 *    read once per TTL (work counter) while doctor reads through.
 * 2. Fails when: the default turns on before the release flips it, the gate ignores old or unstamped writers, an explicit `on` overrides the
 *    gate, a cleared gate keeps writes inline, export sizes stored segmented pages by the write limit, a writer without
 *    the mark passes on its version, a write path of this build stops marking, or the gate's error, window, parse or
 *    cache handling changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { _resetSegmentedWriterGateForTests, readPageBodyPolicy, SEGMENTED_WRITER_GATE_TTL_MS, segmentedPageCeiling, segmentedWriterGateWork } from '../../src/core/page-body/limits.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { compareWriterVersions, SEGMENTED_WRITER_FLOOR, UNSTAMPED_WRITER } from '../../src/core/persistence/writer-versions.ts';
import { BEHAVIOR_CHANGES } from '../../src/core/behavior-change-notice.ts';
import { VERSION } from '../../src/version.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { segmentedStorageCheck } from '../../src/commands/doctor/checks/segmented-storage.ts';
import { startConsumerHeartbeat } from '../../src/core/persistence/consumer-heartbeat.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { editRequest, freshBrainFactory, requestFixture } from '../helpers/persistence-request-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const content = conversationPage(2 * 1024 * 1024, { seed: 61 });

async function storage(engine: BrainEngine, slug: string): Promise<string | undefined> {
  return (await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [slug]))[0]?.body_storage;
}

test('SEGMENTED_WRITER_FLOOR is the release of the writer-gate BEHAVIOR_CHANGES row once stamped, and never above this build', () => {
  const row = BEHAVIOR_CHANGES.find(c => typeof c.text === 'string' && c.text.startsWith('Segmented page storage stays off while an older gbrain'));
  expect(row).toBeDefined();
  if (row!.since !== 'TBD') expect(row!.since).toBe(SEGMENTED_WRITER_FLOOR);
  expect(compareWriterVersions(SEGMENTED_WRITER_FLOOR, VERSION)).toBeLessThanOrEqual(0);
});

for (const kind of testBackends()) {
  describe(`segmented storage switch: ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let engine: BrainEngine;
    let home: string;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-switch-'));
      factory = await freshBrainFactory(kind, process.env.DATABASE_URL);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      rmSync(home, { recursive: true, force: true });
    });
    beforeEach(async () => {
      engine = await factory.fresh();
      _resetSegmentedWriterGateForTests();
    });
    const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);

    test('default off: unset keeps a page over 1 MiB inline under the 24 MiB limit, and doctor offers the switch', async () => {
      expect(await engine.getConfig('pages.segmented_storage')).toBeNull();
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
      expect((await importFromContent(engine, 'notes/default-off', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/default-off')).toBe('inline');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice',
        details: { configured: 'unset', effective: 'off', blockers: [] }, fix: { argv: ['gbrain', 'config', 'set', 'pages.segmented_storage', 'on'] } });
      await engine.setConfig('pages.segmented_storage', 'on');
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: true, maxBytes: segmentedPageCeiling(engine.kind) });
    }, 120_000);

    test('a recent writer below the floor keeps writes inline, even with an explicit on; once it is gone the next write promotes', async () => inHome(async () => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      await editRequest(engine, published.id, "admitter_version='0.60.200.0',consumer_version='0.60.200.0'");
      for (const setting of [null, 'on']) {
        if (setting) await engine.setConfig('pages.segmented_storage', setting);
        _resetSegmentedWriterGateForTests();
        expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
        const slug = `notes/held-${setting ?? 'default'}`;
        expect((await importFromContent(engine, slug, content, { noEmbed: true })).status).toBe('imported');
        expect(await storage(engine, slug)).toBe('inline');
      }
      const check = await segmentedStorageCheck(engine);
      expect(check).toMatchObject({ status: 'warn', details: { configured: 'on', effective: 'off' }, fix: { argv: ['gbrain', 'upgrade'], actor: 'host_admin' } });
      expect((check.details!.blockers as Array<{ host_id: string; version: string }>).map(row => [row.host_id, row.version]))
        .toContainEqual([localHostId(), '0.60.200.0']);
      expect(check.message).toContain('0.60.200.0');

      await editRequest(engine, published.id, 'admitter_version=NULL,consumer_version=NULL');
      _resetSegmentedWriterGateForTests();
      expect((await readPageBodyPolicy(engine)).segmented).toBe(false);

      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [published.id]);
        await tx.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [published.id]);
      });
      _resetSegmentedWriterGateForTests();
      expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
      expect((await importFromContent(engine, 'notes/held-on', `${content}\n\nOne more turn.\n`, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/held-on')).toBe('segmented');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', details: { effective: 'on' } });
    }), 120_000);

    /** The gate as a write reads it, after the per-engine cache is dropped. */
    const segmentedNow = async (e: BrainEngine = engine) => { _resetSegmentedWriterGateForTests(); return (await readPageBodyPolicy(e)).segmented; };
    const blockersNow = async () => (await segmentedStorageCheck(engine)).details!.blockers as Array<{ role: string; principal: string; version: string; segment_reader: boolean }>;
    /** What a binary older than v254 leaves on a request it admitted and published: its version stamp, and no segment-reader mark. */
    const asOlderBinary = (id: string, version: string | null) =>
      editRequest(engine, id, 'admitter_version=$2,consumer_version=$2,admitter_segment_reader=NULL,consumer_segment_reader=NULL', [version]);

    test('B6: a writer at exactly the floor passes only with the segment-reader mark; the same version from a release without segment readers blocks', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      await editRequest(engine, published.id, 'admitter_version=$2,consumer_version=$2', [SEGMENTED_WRITER_FLOOR]);
      expect(await segmentedNow()).toBe(true);
      await asOlderBinary(published.id, SEGMENTED_WRITER_FLOOR);
      expect(await segmentedNow()).toBe(false);
      expect((await blockersNow()).map(b => [b.role, b.version, b.segment_reader]).sort())
        .toEqual([['admitter', SEGMENTED_WRITER_FLOOR, false], ['consumer', SEGMENTED_WRITER_FLOOR, false]]);
      expect((await importFromContent(engine, 'notes/floor', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/floor')).toBe('inline');
    }), 120_000);

    test('B3: an import or sync run an older binary logged (an unmarked ingest_log row) blocks for 7 days; this build\'s runs do not', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.logIngest({ source_type: 'import', source_ref: 'this-build', pages_updated: [], summary: 'this build' });
      expect(await segmentedNow()).toBe(true);
      // The statement every older binary's logIngest runs.
      await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary) VALUES ('default', 'sync', 'older-binary', '[]'::jsonb, 'older binary run')`);
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'importer', principal: 'ingest:sync', version: UNSTAMPED_WRITER, segment_reader: false })]);
      expect((await importFromContent(engine, 'notes/after-old-sync', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/after-old-sync')).toBe('inline');
      await engine.executeRaw(`UPDATE ingest_log SET created_at = now() - interval '8 days' WHERE source_ref = 'older-binary'`);
      expect(await segmentedNow()).toBe(true);
    }, 120_000);

    test('B3: a resident process of an older binary (an unmarked consumer heartbeat) blocks while its row is recent', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      // The heartbeat an older serve writes: no segment_reader column.
      await engine.executeRaw(`INSERT INTO persistence_consumers (host_id, pid, nonce, kind, mode, host_json_path, persistence_home, version)
        VALUES ($1::uuid, 4242, 'older-nonce', 'serve', 'full', '/tmp/host.json', '/tmp', '0.60.262.0')`, [randomUUID()]);
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'resident', principal: 'process:serve', version: '0.60.262.0', segment_reader: false })]);
      await engine.executeRaw(`UPDATE persistence_consumers SET renewed_at = now() - interval '8 days' WHERE nonce = 'older-nonce'`);
      expect(await segmentedNow()).toBe(true);
      if (kind !== 'postgres') return;
      // This build's heartbeat carries the mark (PGLite admits one process and writes no heartbeat).
      const heartbeat = startConsumerHeartbeat(engine, randomUUID(), { kind: 'serve', mode: 'full', everyMs: 3_600_000,
        report: () => ({ restart_required: false, root_barrier_age_ms: null }), paths: { host_json_path: '/tmp/host.json', persistence_home: '/tmp', minted_under: null } });
      try {
        await heartbeat.renew();
        expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_consumers WHERE segment_reader'))[0]!.n)).toBe(1);
        expect(await segmentedNow()).toBe(true);
      } finally { await heartbeat.stop(); }
    }, 120_000);

    test('B3: a request an older binary admitted counts in any state, not only once committed', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const queued = await requests.admit('queued-page');
      expect(queued.state).not.toBe('committed');
      expect(await segmentedNow()).toBe(true);
      await editRequest(engine, queued.id, "admitter_version='0.60.262.0',admitter_segment_reader=NULL");
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'admitter', version: '0.60.262.0', segment_reader: false })]);
    }), 120_000);

    test('B4: an unreadable gate keeps the switch off, and doctor reports the gate as unreadable', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const denied = Object.create(engine, { executeRaw: { value: (sql: string, ...rest: unknown[]) => /persistence_requests/.test(sql)
        ? Promise.reject(Object.assign(new Error('permission denied for table persistence_requests'), { code: '42501' }))
        : (engine.executeRaw as (...a: unknown[]) => Promise<unknown>)(sql, ...rest) } }) as BrainEngine;
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: true });
      expect(await segmentedNow(denied)).toBe(false);
      expect(await readPageBodyPolicy(denied)).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
      expect(await segmentedStorageCheck(denied)).toMatchObject({ details: { effective: 'unknown' } });
    }, 120_000);

    test('B4: the gate is read once per TTL per engine; a blocker that appears is seen when the entry expires, and doctor reads through', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      _resetSegmentedWriterGateForTests();
      const start = Date.now();
      try {
        setSystemTime(new Date(start));
        const reads = segmentedWriterGateWork.reads;
        expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
        expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
        expect(segmentedWriterGateWork.reads - reads).toBe(1);
        await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary) VALUES ('default', 'import', 'older-binary', '[]'::jsonb, 'older binary run')`);
        setSystemTime(new Date(start + SEGMENTED_WRITER_GATE_TTL_MS - 1_000));
        expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
        expect(segmentedWriterGateWork.reads - reads).toBe(1);
        setSystemTime(new Date(start + SEGMENTED_WRITER_GATE_TTL_MS + 1_000));
        expect((await readPageBodyPolicy(engine)).segmented).toBe(false);
        expect(segmentedWriterGateWork.reads - reads).toBe(2);
        expect((await segmentedStorageCheck(engine)).details).toMatchObject({ effective: 'off', blockers: [expect.objectContaining({ role: 'importer' })] });
        expect(segmentedWriterGateWork.reads - reads).toBe(3);
      } finally {
        setSystemTime();
      }
    }, 120_000);

    test('B4: a managed writer below the floor blocks 6 days after its last write and not 8 days after', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      await editRequest(engine, published.id, "admitter_version='0.60.200.0',consumer_version='0.60.200.0'");
      for (const [days, segmented] of [[6, false], [8, true]] as const) {
        await editRequest(engine, published.id, `created_at=now()-interval '${days} days',published_at=now()-interval '${days} days',completed_at=now()-interval '${days} days'`);
        expect({ days, segmented: await segmentedNow() }).toEqual({ days, segmented });
      }
    }), 120_000);

    test('B4: a stamped version the gate cannot parse blocks, even with the segment-reader mark', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      expect(await segmentedNow()).toBe(true);
      await editRequest(engine, published.id, "admitter_version='nightly-build'");
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'admitter', version: 'nightly-build', segment_reader: true })]);
    }), 120_000);

    test('explicit off keeps pages inline and doctor reports it as a choice', async () => {
      await engine.setConfig('pages.segmented_storage', 'off');
      expect((await importFromContent(engine, 'notes/off', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/off')).toBe('inline');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice',
        details: { configured: 'off', effective: 'off' }, fix: { argv: ['gbrain', 'config', 'set', 'pages.segmented_storage', 'on'] } });
    }, 120_000);
  });
}
