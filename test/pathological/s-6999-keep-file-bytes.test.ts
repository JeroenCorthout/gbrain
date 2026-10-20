/**
 * #6999 (supersedes contributor PR #6999): `gbrain repair file-drift --prefer file` keeps the file's bytes. When the
 * reviewed result still differs from the file (a tag only the database holds, a protected key the file lacks, a
 * database-only timeline entry, file-only scan state), the apply edits only those lines: the rest of the file keeps its
 * key order, quoting, list style and whitespace. An edit that would not read back as the reviewed result (CRLF line
 * ends here) falls back to today's full render, and the repair still lands.
 *
 * Red on master (v0.60.320.0): every keep case renders the whole page (keys reordered, quoting and list style changed).
 * PGLite always, Postgres when DATABASE_URL is set (test/e2e/s-6999-keep-file-bytes-postgres.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { liveFileDrift } from '../../src/core/persistence/drift-conflicts.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'notes/alice-example';

const put = (ctx: OperationContext, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content, request_id: randomUUID() } });

async function preferFile(engine: BrainEngine) {
  const scope = await resolveRepairScope(engine, 'default');
  const options = { explicit: true, sourceFlag: 'default', slugs: [SLUG], prefer: 'file' as const };
  const preview = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', scope, options);
  expect(preview.preview_hash).toBeTruthy();
  return (await repairRunner(engine, { apply: true, logger })).run('file-drift', scope, { ...options, expect: preview.preview_hash! });
}

/** The file gbrain wrote, restyled by hand: title first and double-quoted, the stamp lines reversed and quoted, flow aliases, extra blank lines. */
function restyle(written: string, opts: { tags: string; drop?: RegExp; extra?: string }): string {
  const [, head, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(written)!;
  const stamps = head!.split('\n').filter(line => /^(source_kind|ingested_via|ingested_at|trust_tier):/.test(line) && !(opts.drop?.test(line)))
    .reverse().map(line => line.replace(/^(\w+): '?([^']*)'?$/, '$1: "$2"'));
  return ['---', 'title: "Alice Example"', ...stamps, opts.tags, ...(opts.extra ? [opts.extra] : []), 'aliases: [ \'ally\', "a-example" ]', 'type: note', '---', '', '',
    body!.trim().replace('Stored body.', 'Stored body.\n\n\nEdited by hand in the file.'), '', ''].join('\n');
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`repair file-drift --prefer file edits only the lines it must (${backend})`, () => {
    test('a database-only tag joins the block tag list and a missing protected key is added; every other byte is kept', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, '---\ntype: note\ntitle: Alice Example\naliases: [ally, a-example]\ntags: [alpha, beta]\n---\nStored body.\n');
        const file = join(root, `${SLUG}.md`);
        const before = restyle(readFileSync(file, 'utf8'), { tags: 'tags:\n  - "alpha"', drop: /^source_kind:/ });
        writeFileSync(file, before);
        expect((await liveFileDrift(engine, 'default', SLUG)).still_present).toBe(true);
        expect((await preferFile(engine)).outcomes).toEqual({ repaired: 1 });
        const after = readFileSync(file, 'utf8');
        expect(after).toBe(before.replace('  - "alpha"\n', '  - "alpha"\n  - beta\n').replace('type: note\n---', 'type: note\nsource_kind: put_page\n---'));
        expect(await engine.getTags(SLUG, { sourceId: 'default' })).toEqual(['alpha', 'beta']);
        expect((await liveFileDrift(engine, 'default', SLUG)).still_present).toBe(false);
      }, { databaseUrl });
    }, 240_000);

    test('a database-only tag joins a one-line flow tag list in its own style', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, '---\ntype: note\ntitle: Alice Example\naliases: [ally, a-example]\ntags: [alpha, beta, gamma-ray]\n---\nStored body.\n');
        const file = join(root, `${SLUG}.md`);
        const before = restyle(readFileSync(file, 'utf8'), { tags: 'tags: [ alpha ]' });
        writeFileSync(file, before);
        expect((await preferFile(engine)).outcomes).toEqual({ repaired: 1 });
        expect(readFileSync(file, 'utf8')).toBe(before.replace('tags: [ alpha ]', 'tags: [ alpha, beta, gamma-ray ]'));
        expect((await liveFileDrift(engine, 'default', SLUG)).still_present).toBe(false);
      }, { databaseUrl });
    }, 240_000);

    test('a database-only timeline entry is appended in the file\'s timeline section and file-only scan state is dropped', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, '---\ntype: note\ntitle: Alice Example\naliases: [ally, a-example]\n---\nStored body.\n\n<!-- timeline -->\n\n- **2024-01-02** | Stored entry.\n');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.addTimelineEntry(SLUG, { date: '2024-03-04', summary: 'Database-only entry.', source: 'test' }, { sourceId: 'default' });
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const file = join(root, `${SLUG}.md`);
        const before = restyle(readFileSync(file, 'utf8'), { tags: '', extra: 'atoms_scan_hash: "file-only"' }).replace('\n\naliases', '\naliases');
        writeFileSync(file, before);
        expect((await preferFile(engine)).outcomes).toEqual({ repaired: 1 });
        const after = readFileSync(file, 'utf8');
        const kept = before.replace('atoms_scan_hash: "file-only"\n', '').trimEnd();
        expect(after.slice(0, kept.length)).toBe(kept);
        expect(after.slice(kept.length)).toMatch(/^\n<!-- gbrain:materialized v1 [0-9a-f]+ -->\n- \*\*2024-03-04\*\* \| test — Database-only entry\.\n\n$/);
        expect((await liveFileDrift(engine, 'default', SLUG)).still_present).toBe(false);
      }, { databaseUrl });
    }, 240_000);

    test('an edit that cannot be made in place (CRLF line ends) falls back to the full render and the repair still lands', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, '---\ntype: note\ntitle: Alice Example\ntags: [alpha, beta]\n---\nStored body.\n');
        const file = join(root, `${SLUG}.md`);
        const before = restyle(readFileSync(file, 'utf8'), { tags: 'tags:\n  - "alpha"' }).replace(/\n/g, '\r\n');
        writeFileSync(file, before);
        expect((await preferFile(engine)).outcomes).toEqual({ repaired: 1 });
        const after = readFileSync(file, 'utf8');
        expect(after).not.toBe(before);
        expect(after.startsWith('---\ntype: note\ntitle: Alice Example\n')).toBe(true);
        expect(await engine.getTags(SLUG, { sourceId: 'default' })).toEqual(['alpha', 'beta']);
        expect((await liveFileDrift(engine, 'default', SLUG)).still_present).toBe(false);
      }, { databaseUrl });
    }, 240_000);
  });
}
