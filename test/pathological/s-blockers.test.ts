/**
 * GBRA-133 lane B: every way one odd input can block or stall the rest of a
 * source's sync, on classic and managed sync, PGLite and Postgres
 * (DATABASE_URL-gated). Each case commits one odd input beside a healthy file
 * and asserts the goal-2 contract: the run returns, the healthy sibling lands,
 * the cursor reaches HEAD, a later commit still syncs, and the odd item is
 * imported or held/refused with a typed reason. Cases that fail on master are
 * Phase 2's red tests; the inventory is ~/.capy/work/gbra133/blockers.md.
 *
 * Filters (for running arms in parallel): GBRAIN_TEST_S_MODE=classic|managed,
 * GBRAIN_TEST_S_CASES=S-1,S-7. GBRAIN_TEST_S_PROBE_OUT=<file> appends each observation as JSON.
 */
import { describe, expect, test } from 'bun:test';
import { pathologicalArms } from './harness.ts';
import { CASES } from './s-blockers-cases.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitIn, md, observe, record, withProbeEngine, withProbeRepo, type Observation, type SyncMode } from './s-blockers-fixture.ts';

const modes = (process.env.GBRAIN_TEST_S_MODE ? [process.env.GBRAIN_TEST_S_MODE] : ['classic', 'managed']) as SyncMode[];
const only = process.env.GBRAIN_TEST_S_CASES ? new Set(process.env.GBRAIN_TEST_S_CASES.split(',')) : null;

const mentions = (o: Observation, odd: string[]) => {
  const named = [...o.ledger.map(x => x.path), ...o.refusals.map(x => x.path), ...o.failures.map(x => x.path ?? x.slug ?? ''), ...(o.holds ?? []).map(x => x.path ?? ''), ...o.gitHolds.map(x => x.path)];
  return (o.malformedSkipped ?? 0) > 0 || odd.some(p => named.some(n => n && (n.includes(p) || p.includes(n))));
};

for (const mode of modes) {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    describe('S blockers: ' + mode + ' sync (' + backend + ')', () => {
      for (const c of CASES) {
        if (only && !only.has(c.id)) continue;
        const skip = c.skip?.(mode);
        test.skipIf(!!skip)(c.id + ' ' + c.name + ': the rest of the source syncs and the odd item is imported or held', () => withProbeEngine(databaseUrl, async (engine, home) => {
          const root = c.makeRoot?.(home);
          await withProbeRepo(engine, mode, home, async r => {
            await c.prepare?.(r);
            const first = await observe(r, 'seed', { pull: c.pull });
            r.write('ok/healthy-1.md', md('healthy one'));
            let mutateError: string | null = null;
            try { await c.mutate(r); } catch (e) { mutateError = String(e).slice(0, 300); }
            const second = await observe(r, 'ok/healthy-1', { pull: c.pull });
            const skipFailed = c.pull ? await observe(r, 'ok/healthy-1', { pull: c.pull, skipFailed: true }) : null;
            let third: Observation | null = null; let thirdSkipped: string | null = null;
            try {
              if (c.upstream) {
                const up = c.upstream(r);
                mkdirSync(join(up, 'ok'), { recursive: true }); writeFileSync(join(up, 'ok/healthy-2.md'), md('healthy two'));
                gitIn(up, 'add', '--', 'ok/healthy-2.md'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'healthy two');
              } else {
                r.write('ok/healthy-2.md', md('healthy two'));
                r.git('add', '--', 'ok/healthy-2.md'); r.git('commit', '-qm', 'healthy two');
              }
              third = await observe(r, 'ok/healthy-2', { pull: c.pull });
            } catch (e) { thirdSkipped = String(e).split('\n')[0]!.slice(0, 200); }
            const extra: Observation[] = [];
            for (let i = 0; i < Number(process.env.GBRAIN_TEST_S_EXTRA_RUNS ?? 0); i++) extra.push(await observe(r, 'ok/healthy-2', { pull: c.pull }));
            const pages = await engine.executeRaw<{ slug: string; source_path: string | null }>('SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [r.sourceId]);
            const oddImported = pages.some(p => (c.oddSlug !== undefined && p.slug === c.oddSlug) || (p.source_path !== null && c.odd.includes(p.source_path)) || c.odd.some(o => o.endsWith('/') && p.slug.startsWith(o)));
            const accounted = !!oddImported || c.odd.length === 0 || mentions(second, c.odd) || (third ? mentions(third, c.odd) : false);
            record({ id: c.id, name: c.name, mode, backend, mutateError, first, second, skipFailed, third, thirdSkipped, oddImported, accounted, pages, extra });
            expect({
              id: c.id,
              mutateError,
              first: { aborted: first.thrown, status: first.status },
              second: { aborted: second.thrown, healthy: second.healthy, cursorAtHead: second.cursorAtHead },
              third: third ? { aborted: third.thrown, healthy: third.healthy, cursorAtHead: third.cursorAtHead } : thirdSkipped,
              odd: c.importNotRequired ? { accounted } : { imported: oddImported },
            }).toEqual({
              id: c.id,
              mutateError: null,
              first: { aborted: null, status: 'first_sync' },
              second: { aborted: null, healthy: true, cursorAtHead: true },
              third: third ? { aborted: null, healthy: true, cursorAtHead: true } : thirdSkipped,
              odd: c.importNotRequired ? { accounted: true } : { imported: true },
            });
          }, root ? { root, initRepo: false, seed: false } : {});
        }), 300_000);
      }
    });
  }
}
