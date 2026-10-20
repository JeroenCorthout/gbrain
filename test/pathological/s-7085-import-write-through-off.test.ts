/**
 * GBRA-133 PR 3 (#7085): on a managed brain with `sync.write_through=false`, `gbrain import --source <id>` failed every
 * file with `owner_unavailable`: the admission dropped the worktree (page-mutations.ts) while the managed import
 * preparer requires it (import-prepare.ts), so each file took a write request that could only fail, spending write
 * capacity per file. A file already inside the source's checkout now imports database-only under the owner's fence
 * (the file is never rewritten; receipt `write_through.skipped: disabled_by_config`). A file from outside the checkout
 * would have to be copied in, which write_through off forbids, so the import refuses once, before any request is
 * admitted, with `write_through_disabled` and its fix.
 * Managed import on PGLite, and on Postgres through test/e2e/s-7085-import-write-through-off-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { runImport } from '../../src/commands/import.ts';
import { importManagedFiles } from '../../src/core/persistence/import-mutations.ts';
import { pathologicalArms } from './harness.ts';
import { withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const note = (title: string) => `---\ntitle: ${title}\n---\nThe ${title} note, with no type line so the import infers one.\n`;
const requests = async (r: ProbeRepo) => r.engine.executeRaw<{ slug: string; state: string; code: string | null; skipped: string | null }>(
  `SELECT slug,state,error_code AS code,outcome->'write_through'->>'skipped' AS skipped FROM persistence_requests
    WHERE source_id=$1 AND operation='put_page' ORDER BY slug`, [r.sourceId]);
const writeThroughOff = async (r: ProbeRepo) => { await r.engine.setConfig('sync.write_through', 'false'); _resetWriteThroughCacheForTest(); };

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#7085 managed import with sync.write_through=false (${backend})`, () => {
    test('#7085 files inside the checkout import database-only and are never rewritten', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'managed', home, async r => {
      await r.sync({ timeoutMs: 120_000 });
      await writeThroughOff(r);
      r.write('inbox/one.md', note('One'));
      r.write('inbox/two.md', note('Two'));
      const result = await runImport(engine, [join(r.root, 'inbox'), '--no-embed'], { sourceId: r.sourceId, slugRoot: r.root });
      expect({ imported: result.imported, errors: result.errors, failures: result.failures ?? [] }).toEqual({ imported: 2, errors: 0, failures: [] });
      expect({ one: readFileSync(join(r.root, 'inbox/one.md'), 'utf8'), two: readFileSync(join(r.root, 'inbox/two.md'), 'utf8') })
        .toEqual({ one: note('One'), two: note('Two') });
      expect(await requests(r)).toEqual([
        { slug: 'inbox/one', state: 'committed', code: null, skipped: 'disabled_by_config' },
        { slug: 'inbox/two', state: 'committed', code: null, skipped: 'disabled_by_config' },
      ]);
      const pages = await engine.executeRaw<{ slug: string; source_path: string | null }>(
        "SELECT slug,source_path FROM pages WHERE source_id=$1 AND slug LIKE 'inbox/%' AND deleted_at IS NULL ORDER BY slug", [r.sourceId]);
      expect(pages).toEqual([{ slug: 'inbox/one', source_path: 'inbox/one.md' }, { slug: 'inbox/two', source_path: 'inbox/two.md' }]);
    })), 240_000);

    test('#7085 a file from outside the checkout refuses once, before any write request is admitted', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'managed', home, async r => {
      await r.sync({ timeoutMs: 120_000 });
      await writeThroughOff(r);
      const outside = join(home, 'outside-' + r.sourceId);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'a.md'), note('Outside A'));
      writeFileSync(join(outside, 'b.md'), note('Outside B'));
      const settled = await importManagedFiles(engine, [{ filePath: join(outside, 'a.md'), sourcePath: 'a.md' }, { filePath: join(outside, 'b.md'), sourcePath: 'b.md' }],
        { sourceId: r.sourceId, noEmbed: true });
      const codes = settled.map(s => s.status === 'rejected' ? (s.reason as { code?: string }).code : 'fulfilled');
      expect(codes).toEqual(['write_through_disabled', 'write_through_disabled']);
      const fix = settled[0]!.status === 'rejected' ? (settled[0]!.reason as { fix?: { argv?: string[]; actor?: string } }).fix : undefined;
      expect({ argv: fix?.argv, actor: fix?.actor }).toEqual({ argv: ['gbrain', 'import', join(r.root, 'a.md'), '--source', r.sourceId], actor: 'user' });
      expect(await requests(r)).toEqual([]);
      // `gbrain import <dir> --source <id>` stops once, before reading a file, naming the same refusal.
      const aborted = await runImport(engine, [outside, '--no-embed'], { sourceId: r.sourceId }).then(() => null, (error: unknown) => error as { name?: string; cause?: { code?: string } });
      expect({ name: aborted?.name, code: aborted?.cause?.code }).toEqual({ name: 'ImportAbortError', code: 'write_through_disabled' });
      expect(await requests(r)).toEqual([]);
    })), 240_000);
  });
}
