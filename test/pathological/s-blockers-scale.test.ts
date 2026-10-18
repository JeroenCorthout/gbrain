/**
 * GBRA-133 lane B: huge diffs and rename storms. Opt-in (GBRAIN_TEST_S_SCALE=1; sizes via
 * GBRAIN_TEST_S_SCALE_N, default 5000) because each arm writes thousands of pages.
 * Measures one sync of N added files, then one sync of N renames (git mv of every file),
 * then a one-file commit on top, and reports wall time, status and whether the cursor
 * reached HEAD. A stall shows as the probe timeout.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathologicalArms } from './harness.ts';
import { md, observe, record, withProbeEngine, withProbeRepo, type SyncMode } from './s-blockers-fixture.ts';

const enabled = process.env.GBRAIN_TEST_S_SCALE === '1';
const N = Number(process.env.GBRAIN_TEST_S_SCALE_N ?? 5000);
const modes = (process.env.GBRAIN_TEST_S_MODE ? [process.env.GBRAIN_TEST_S_MODE] : ['classic', 'managed']) as SyncMode[];

for (const mode of modes) {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    describe('S scale: ' + mode + ' sync (' + backend + ')', () => {
      test.skipIf(!enabled)('S-54/S-55 ' + N + ' added files, then ' + N + ' renames, then one more commit: each sync returns and reaches HEAD', () => withProbeEngine(databaseUrl, async (engine, home) => {
        await withProbeRepo(engine, mode, home, async r => {
          expect((await observe(r, 'seed')).status).toBe('first_sync');
          mkdirSync(join(r.root, 'bulk'), { recursive: true });
          for (let i = 0; i < N; i++) writeFileSync(join(r.root, 'bulk', 'n' + i + '.md'), md('bulk ' + i + ' ' + 'filler '.repeat(20)));
          r.write('ok/healthy-1.md', md('healthy one'));
          r.commitAll('bulk add');
          const added = await observe(r, 'ok/healthy-1', { timeoutMs: 3_000_000 });
          r.git('mv', 'bulk', 'moved');
          r.write('ok/healthy-2.md', md('healthy two'));
          r.commitAll('bulk rename');
          const renamed = await observe(r, 'ok/healthy-2', { timeoutMs: 3_000_000 });
          const live = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'moved/%'", [r.sourceId]);
          const stale = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'bulk/%'", [r.sourceId]);
          r.write('ok/healthy-3.md', md('healthy three'));
          r.commitAll('one more');
          const after = await observe(r, 'ok/healthy-3', { timeoutMs: 600_000 });
          const strip = (o: typeof added) => ({ thrown: o.thrown, status: o.status, reason: o.reason, cursorAtHead: o.cursorAtHead, healthy: o.healthy, ms: o.ms, ledger: o.ledger.length, refusals: o.refusals.length, holds: o.holds?.length, status_state: o.status_state });
          record({ id: 'S-54/S-55', mode, backend, N, added: strip(added), renamed: strip(renamed), moved_live: live[0]!.n, bulk_live: stale[0]!.n, after: strip(after) });
          expect({ added: [added.thrown, added.cursorAtHead, added.healthy], renamed: [renamed.thrown, renamed.cursorAtHead, renamed.healthy], moved: live[0]!.n, bulk: stale[0]!.n, after: [after.thrown, after.cursorAtHead, after.healthy] })
            .toEqual({ added: [null, true, true], renamed: [null, true, true], moved: N, bulk: 0, after: [null, true, true] });
        });
      }), 7_200_000);
    });
  }
}
