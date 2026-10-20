/**
 * GBRA-133 PR 3 (#7098): `gbrain sources mirror-readonly <id>` must stop every gbrain write into that source's checkout, not
 * only the managed publication path. The legacy file writers (page write-through, the facts fence writer, forget's fence
 * withdrawal, the timeline splice, the brainstorm save, the dream page writer and the delete write-through) resolve their
 * file through one resolver, `resolvePageWriteTarget`, which never consulted the flag, so on an unmanaged brain only the
 * global `sync.write_through=false` kept them out of a mirror. Each now stores its write database-only (skip reason
 * `mirror_read_only`) and the checkout stays exactly the committed bytes.
 * Unmanaged (classic) brain on PGLite, and on Postgres through test/e2e/s-7098-mirror-readonly-legacy-writers-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistSavedIdea } from '../../src/commands/brainstorm.ts';
import { writeDreamPageFile } from '../../src/core/cycle/derived-write-through.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { writeTimelineEntryThrough } from '../../src/core/timeline-write-through.ts';
import { _resetWriteThroughCacheForTest, deletePageThrough, writePageThrough } from '../../src/core/write-through.ts';
import { pathologicalArms } from './harness.ts';
import { withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const ALICE = 'people/alice-example';
const alice = '---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\nAlice Example runs the example lab.\n';
const rowNum = async (r: ProbeRepo, id: number) =>
  (await r.engine.executeRaw<{ row_num: number | null; expired: boolean }>('SELECT row_num, expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [id]))[0];
const fact = (r: ProbeRepo, text: string) =>
  writeSingleFact(r.engine, r.sourceId, { fact: text, provenance: 'test:7098', entity: ALICE, visibility: 'world', remote: false });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#7098 legacy writers honor mirror-readonly (${backend})`, () => {
    test('#7098 every legacy file writer keeps a read-only mirror checkout at its committed bytes', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      _resetWriteThroughCacheForTest();
      r.write(`${ALICE}.md`, alice);
      r.commitAll('alice');
      await r.sync({ timeoutMs: 120_000 });
      const fenced = await fact(r, 'Alice Example founded the example lab.');
      expect((await rowNum(r, fenced.id!))?.row_num).not.toBeNull();
      r.commitAll('fence');
      const committed = readFileSync(join(r.root, `${ALICE}.md`), 'utf8');

      await engine.executeRaw(`UPDATE sources SET config = '{"mirror_read_only":true}'::jsonb WHERE id=$1`, [r.sourceId]);
      const later = await fact(r, 'Alice Example moved the example lab to a new campus.');
      const forgotten = await forgetFactInFence(engine, fenced.id!, { sourceId: r.sourceId });
      const timeline = await writeTimelineEntryThrough(engine, ALICE, r.sourceId, { date: '2026-10-01', summary: 'Alice Example opened the new campus.' });
      const idea = await persistSavedIdea(engine, { slug: 'ideas/campus-example', content: '# Campus\n\nA new campus idea.\n', sourceId: r.sourceId, provenanceVia: 'test' });
      const page = await writePageThrough(engine, ALICE, { sourceId: r.sourceId });
      const dream = await writeDreamPageFile(engine, r.root, 'dream/campus-example', r.sourceId, { nativeSourceId: r.sourceId, markdown: '# Dream\n' });
      const removed = await deletePageThrough(engine, ALICE, { sourceId: r.sourceId });

      expect({
        laterRowNum: (await rowNum(r, later.id!))?.row_num,
        forgottenExpired: (await rowNum(r, fenced.id!))?.expired,
        forgotten: forgotten.path,
        timeline: { handled: timeline.handled, skipped: timeline.skipped },
        idea: { dbSaved: idea.dbSaved, skipped: idea.writeThrough.skipped },
        page: { written: page.written, skipped: page.skipped },
        dream: { written: dream.written, skipped: 'skipped' in dream ? dream.skipped : undefined },
        removed: { removed: removed.removed, skipped: removed.skipped },
        dirty: r.git('status', '--porcelain'),
        file: existsSync(join(r.root, `${ALICE}.md`)) ? readFileSync(join(r.root, `${ALICE}.md`), 'utf8') : 'deleted',
        ideaFile: existsSync(join(r.root, 'ideas/campus-example.md')),
        dreamFile: existsSync(join(r.root, 'dream/campus-example.md')),
      }).toEqual({
        laterRowNum: null,
        forgottenExpired: true,
        forgotten: 'legacy_db',
        timeline: { handled: false, skipped: 'mirror_read_only' },
        idea: { dbSaved: true, skipped: 'mirror_read_only' },
        page: { written: false, skipped: 'mirror_read_only' },
        dream: { written: false, skipped: 'mirror_read_only' },
        removed: { removed: false, skipped: 'mirror_read_only' },
        dirty: '',
        file: committed,
        ideaFile: false,
        dreamFile: false,
      });
    })), 180_000);
  });
}
