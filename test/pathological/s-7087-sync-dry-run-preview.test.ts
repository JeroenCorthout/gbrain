/**
 * GBRA-133 PR 3 (#7087): a managed `gbrain sync --source <id> --dry-run` previewed nothing about the changes it found:
 * the result carried zero counts and no paths (only holds and fence normalizations), so it could not show which pages a
 * real sync would import or which files it would rewrite with canonical frontmatter (#7084). The dry run now lists the
 * imports (`would_import`, with add/modify/rename), the deletions (`would_delete`), the files a real run would rewrite
 * (`would_rewrite`, found by the preparer's own read-only screening preparation) and, with `sync.write_through` off or a
 * read-only mirror, the files whose canonical metadata stays database-only (`would_keep_database_only`), with counts. It
 * stays read-only: no request, no cursor step, no file write.
 * Managed sync on PGLite, and on Postgres through test/e2e/s-7087-sync-dry-run-preview-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performSync } from '../../src/commands/sync/perform.ts';
import { printHoldNotes } from '../../src/commands/sync-diagnostics.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { pathologicalArms } from './harness.ts';
import { md, withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const typed = '---\ntitle: Alice Example\ntype: person\n---\nAlice Example runs the example lab.\n';
const untyped = '---\ntitle: Alice Example\n---\nAlice Example runs the example lab, edited.\n';

/** A first sync of seed.md and a typed people page, then one commit that edits it (dropping `type:`), adds a page and deletes seed.md. */
async function pendingChanges(r: ProbeRepo): Promise<void> {
  r.write('notes/alice-example.md', typed);
  r.commitAll('typed');
  await r.sync({ timeoutMs: 120_000 });
  r.write('notes/alice-example.md', untyped);
  r.write('notes/new-page.md', md('new page'));
  r.git('rm', '-q', 'seed.md');
  r.commitAll('changes');
}
const state = async (r: ProbeRepo) => ({
  lastCommit: await r.lastCommit(),
  requests: Number((await r.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [r.sourceId]))[0]?.n),
  file: readFileSync(join(r.root, 'notes/alice-example.md'), 'utf8'),
  dirty: r.git('status', '--porcelain'),
});
const dryRun = (r: ProbeRepo) => performSync(r.engine, { repoPath: r.root, sourceId: r.sourceId, noPull: true, noEmbed: true, noExtract: true, dryRun: true });
type Preview = { would_import?: unknown; would_import_count?: number; would_delete?: unknown; would_delete_count?: number; would_rewrite?: unknown; would_rewrite_count?: number;
  would_keep_database_only?: unknown; would_keep_database_only_count?: number };

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#7087 managed sync --dry-run previews its changes (${backend})`, () => {
    test('#7087 lists the pages it would import and delete and the file it would rewrite, read-only', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'managed', home, async r => {
      _resetWriteThroughCacheForTest();
      await pendingChanges(r);
      const before = await state(r);
      const result = await dryRun(r);
      const preview = result as typeof result & Preview;
      expect({ status: result.status, added: result.added, modified: result.modified, deleted: result.deleted }).toEqual({ status: 'dry_run', added: 1, modified: 1, deleted: 1 });
      expect({ would_import: preview.would_import, would_import_count: preview.would_import_count, would_delete: preview.would_delete, would_delete_count: preview.would_delete_count,
        would_rewrite: preview.would_rewrite, would_rewrite_count: preview.would_rewrite_count, would_keep_database_only: preview.would_keep_database_only }).toEqual({
        would_import: [{ path: 'notes/alice-example.md', slug: 'notes/alice-example', change: 'modify' }, { path: 'notes/new-page.md', slug: 'notes/new-page', change: 'add' }],
        would_import_count: 2,
        would_delete: [{ path: 'seed.md', slug: 'seed' }], would_delete_count: 1,
        would_rewrite: [{ path: 'notes/alice-example.md', slug: 'notes/alice-example' }], would_rewrite_count: 1,
        would_keep_database_only: undefined,
      });
      const lines: string[] = [];
      printHoldNotes(result, line => lines.push(line));
      expect(lines.filter(line => /Would (import|delete|rewrite)/.test(line))).toEqual([
        '  Would import notes/alice-example.md (modify)',
        '  Would import notes/new-page.md (add)',
        '  Would delete seed.md',
        '  Would rewrite notes/alice-example.md with its canonical frontmatter (the stored page keeps metadata the file does not state).',
      ]);
      expect(await state(r)).toEqual(before);
      // The preview matches what the real run then does.
      await r.sync({ timeoutMs: 120_000 });
      expect(readFileSync(join(r.root, 'notes/alice-example.md'), 'utf8')).toContain('type: person');
    })), 240_000);

    test('#7087 with sync.write_through off the dry run names the file whose metadata stays database-only, and rewrites nothing', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'managed', home, async r => {
      await engine.setConfig('sync.write_through', 'false');
      _resetWriteThroughCacheForTest();
      await pendingChanges(r);
      const before = await state(r);
      const preview = await dryRun(r) as Awaited<ReturnType<typeof dryRun>> & Preview;
      expect({ would_rewrite: preview.would_rewrite, would_keep_database_only: preview.would_keep_database_only, would_keep_database_only_count: preview.would_keep_database_only_count }).toEqual({
        would_rewrite: undefined,
        would_keep_database_only: [{ path: 'notes/alice-example.md', slug: 'notes/alice-example', reason: 'disabled_by_config' }],
        would_keep_database_only_count: 1,
      });
      expect(await state(r)).toEqual(before);
    })), 240_000);
  });
}
