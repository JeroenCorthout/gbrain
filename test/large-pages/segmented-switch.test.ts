/**
 * Wave B PR 2 switch-on (spec 1.1 activation gate, 13 PR 2): `pages.segmented_storage` follows
 * SEGMENTED_STORAGE_DEFAULT when unset and is gated by the writer versions recorded on committed persistence requests.
 *
 * 1. Protects: with no configuration a page over 1 MiB is stored segmented and `pages.max_bytes` is the engine
 *    ceiling; a writer older than SEGMENTED_WRITER_FLOOR (or unstamped) seen in the last seven days keeps writes
 *    inline, even with an explicit `on`, and doctor `segmented_storage` names it with an upgrade fix; once that
 *    observation is gone the next write promotes; an explicit `off` keeps pages inline and reports it as a choice;
 *    a stored segmented page over 32 MiB still exports while the switch is off.
 * 2. Fails when: the default stays off, the gate ignores old or unstamped writers, an explicit `on` overrides the
 *    gate, a cleared gate keeps writes inline, or export sizes stored segmented pages by the write limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { _resetSegmentedWriterGateForTests, readPageBodyPolicy, segmentedPageCeiling } from '../../src/core/page-body/limits.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { compareWriterVersions, SEGMENTED_WRITER_FLOOR } from '../../src/core/persistence/writer-versions.ts';
import { BEHAVIOR_CHANGES } from '../../src/core/behavior-change-notice.ts';
import { VERSION } from '../../src/version.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { segmentedStorageCheck } from '../../src/commands/doctor/checks/segmented-storage.ts';
import { runExport } from '../../src/commands/export.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { editRequest, freshBrainFactory, requestFixture } from '../helpers/persistence-request-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const content = conversationPage(2 * 1024 * 1024, { seed: 61 });

async function quietExport(engine: BrainEngine, out: string): Promise<void> {
  const { log, error } = console;
  const exit = process.exit;
  const messages: string[] = [];
  console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  process.exit = ((code: number) => { throw new Error(`EXIT:${code} ${messages.join('\n')}`); }) as never;
  try { await runExport(engine, ['--dir', out]); } finally { console.log = log; console.error = error; process.exit = exit; }
}

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

    test('default on: a page over 1 MiB is stored segmented and pages.max_bytes is the engine ceiling', async () => {
      expect(await engine.getConfig('pages.segmented_storage')).toBeNull();
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: true, maxBytes: segmentedPageCeiling(engine.kind) });
      expect((await importFromContent(engine, 'notes/default-on', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/default-on')).toBe('segmented');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', details: { configured: 'unset', effective: 'on', blockers: [] } });
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

    test('a stored segmented page over the 32 MiB inline export limit still exports while the switch is off', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      expect((await importFromContent(engine, 'notes/stored', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/stored')).toBe('segmented');
      await engine.executeRaw('UPDATE pages SET body_bytes=$2 WHERE slug=$1', ['notes/stored', 40 * 1024 * 1024]);
      await engine.setConfig('pages.segmented_storage', 'off');
      const out = join(home, `export-${kind}`);
      await quietExport(engine, out);
      expect(readFileSync(join(out, 'notes/stored.md'), 'utf8')).toContain(content.trimEnd().slice(-120));
    }, 120_000);

    test('explicit off keeps pages inline and doctor reports it as a choice', async () => {
      await engine.setConfig('pages.segmented_storage', 'off');
      expect((await importFromContent(engine, 'notes/off', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/off')).toBe('inline');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice',
        details: { configured: 'off', effective: 'off' }, fix: { argv: ['gbrain', 'config', 'set', 'pages.segmented_storage', 'on'] } });
    }, 120_000);
  });
}
