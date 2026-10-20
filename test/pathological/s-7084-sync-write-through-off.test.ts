/**
 * GBRA-133 PR 3 (#7084): with `sync.write_through=false`, a managed sync must not write canonical frontmatter back into
 * the checkout. When the stored page keeps metadata its committed file no longer states (#1035: a file edit that drops
 * `type:` keeps the stored type), the import used to serialize the merged page and rewrite the file in place (the
 * "overlay" writeback in sync-prepare.ts), although the brain was configured to write no files. The page now keeps that
 * metadata in the database only (receipt `write_through.skipped: disabled_by_config`), the file stays the committed
 * bytes, and the difference stays as drift that later syncs leave alone.
 * Managed sync on PGLite, and on Postgres through test/e2e/s-7084-sync-write-through-off-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { pathologicalArms } from './harness.ts';
import { withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const typed = '---\ntitle: Alice Example\ntype: person\n---\nAlice Example runs the example lab.\n';
const untyped = '---\ntitle: Alice Example\n---\nAlice Example runs the example lab, edited.\n';
const read = (r: ProbeRepo) => readFileSync(join(r.root, 'notes/alice-example.md'), 'utf8');
const writeThrough = async (r: ProbeRepo, on: boolean | null) => {
  if (on !== null) await r.engine.setConfig('sync.write_through', String(on));
  _resetWriteThroughCacheForTest();
};

/** A typed first commit, then a committed edit that drops `type:` (the stored type survives the import, #1035). */
async function typedThenUntyped(r: ProbeRepo) {
  r.write('notes/alice-example.md', typed);
  r.commitAll('typed');
  await r.sync({ timeoutMs: 120_000 });
  r.write('notes/alice-example.md', untyped);
  r.commitAll('drop type');
  return r.sync({ timeoutMs: 120_000 });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#7084 managed sync with sync.write_through=false (${backend})`, () => {
    test('#7084 canonical frontmatter is never written back into the committed file', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'managed', home, async r => {
      await writeThrough(r, false);
      const result = await typedThenUntyped(r);
      expect({ held: result.held ?? [], file: read(r), dirty: r.git('status', '--porcelain'), cursorAtHead: await r.lastCommit() === r.head() })
        .toEqual({ held: [], file: untyped, dirty: '', cursorAtHead: true });
      const [page] = await engine.executeRaw<{ type: string; body: string }>("SELECT type,compiled_truth AS body FROM pages WHERE source_id=$1 AND slug='notes/alice-example'", [r.sourceId]);
      expect({ type: page?.type, edited: page?.body.includes('edited') }).toEqual({ type: 'person', edited: true });
      const receipts = await engine.executeRaw<{ written: boolean | null; skipped: string | null }>(
        `SELECT (outcome->'write_through'->>'written')::boolean AS written, outcome->'write_through'->>'skipped' AS skipped FROM persistence_requests
          WHERE source_id=$1 AND slug='notes/alice-example' AND state='committed' ORDER BY created_at DESC LIMIT 1`, [r.sourceId]);
      expect(receipts).toEqual([{ written: false, skipped: 'disabled_by_config' }]);
      // The database/file difference stays as drift: the next commit syncs and still leaves the file alone.
      r.write('notes/other.md', '---\ntitle: Other\ntype: note\n---\nAnother note.\n');
      r.commitAll('another');
      const next = await r.sync({ timeoutMs: 120_000 });
      expect({ held: next.held ?? [], file: read(r), dirty: r.git('status', '--porcelain'), cursorAtHead: await r.lastCommit() === r.head() })
        .toEqual({ held: [], file: untyped, dirty: '', cursorAtHead: true });
    })), 240_000);

    test('#7084 with sync.write_through on (the default) the canonical writeback still happens', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'managed', home, async r => {
      await writeThrough(r, null);
      await typedThenUntyped(r);
      expect(read(r)).toContain('type: person');
    })), 240_000);
  });
}
