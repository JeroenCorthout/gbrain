/**
 * Database-canonical memory, wave 5b: open live import conflicts as a read surface (list_source_conflicts and the
 * \`gbrain sources conflicts\` verb) and \`put_page resolves_conflict\`, on real PGLite and Postgres. Names are placeholders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { DATABASE_CANONICAL_KEY } from '../src/core/persistence/canonical-export.ts';
import { lockExportWriters, writeSourceShadow } from '../src/core/persistence/canonical-shadow.ts';
import { listSourceConflicts } from '../src/core/ops/source-conflicts.ts';
import { closeResolvedConflict } from '../src/core/persistence/conflict-write.ts';
import { parseConflictsArgs, resolveConflict } from '../src/commands/sources-conflicts.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const page = (title: string, body: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra}---\n\n${body}\n`;
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); } catch (error) { return error instanceof OperationError ? error.code : String(error); }
  return 'no error';
};

for (const backend of testBackends()) describe(`database-canonical wave 5b conflicts: ${backend}`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
  }, 120000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); await close?.(); });

  const put = async (slug: string, content: string, extra: Record<string, unknown> = {}) => {
    const r = await dispatchToolCall(engine, 'put_page', { slug, content, wait_ms: 30000, ...extra }, { remote: false, sourceId: 'default' });
    return { error: !!r.isError, body: payload(r as never) };
  };
  const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
  const pageId = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.id;
  const conflict = async (slug: string, kind: string, bytes = 'file side\n') => {
    const id = slug ? await pageId(slug) : null;
    const rev = slug ? await revision(slug) : null;
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO import_conflicts(source_id, path, path_folded, page_id, mode, outcome, kind, shadow_epoch, file_sha256, file_size, file_bytes, detail, db_revision)
      VALUES ('default', $1, $1, $2, 'live', 'conflict', $3, 1, $4, $5, $6, '{"code":"screen_a"}'::jsonb, $7::uuid) RETURNING id`, [`${slug}.md`, id, kind, sha(bytes), bytes.length, Buffer.from(bytes), rev]);
    return Number(row!.id);
  };

  beforeEach(async () => {
    for (const table of ['import_conflicts', 'export_ledger', 'export_outbox']) await engine.executeRaw(`DELETE FROM ${table}`);
    await engine.setConfig(DATABASE_CANONICAL_KEY, 'true');
    await engine.transaction(async tx => { await lockExportWriters(tx); await writeSourceShadow(tx, 'default', true); });
    await engine.executeRaw("UPDATE database_canonical_sources SET mode='database', mode_epoch=1 WHERE source_id='default'");
  });

  test('remote callers get summaries of visible conflicts only; trusted local callers get the detail', async () => {
    expect((await put('notes/alpha-example', page('Alpha', 'Database side.'))).error).toBe(false);
    expect((await put('notes/hidden-example', page('Hidden', 'Private side.', 'visibility: private\n'))).error).toBe(false);
    const open = await conflict('notes/alpha-example', 'both_changed');
    const hidden = await conflict('notes/hidden-example', 'both_changed');
    const remote = await listSourceConflicts(engine, { scope: { sourceIds: ['default'] }, remote: true });
    expect(remote.map(c => c.id)).toEqual([open]);
    expect(Object.keys(remote[0]!).sort()).toEqual(['age_seconds', 'base_revision', 'db_revision', 'first_observed_at', 'id', 'kind', 'lifetime', 'mode', 'observed_at',
      'page_id', 'path', 'screen_code', 'slug', 'source_id', 'state']);
    expect(JSON.stringify(remote)).not.toContain(sha('file side\n'));
    expect(remote[0]!.screen_code).toBe('screen_a');
    const local = await listSourceConflicts(engine, { scope: {}, remote: false, includeBytes: true });
    expect(local.map(c => c.id)).toEqual([open, hidden]);
    expect(Buffer.from(local[0]!.bytes_base64!, 'base64').toString()).toBe('file side\n');
    expect(await listSourceConflicts(engine, { scope: { sourceIds: ['other-source'] }, remote: true })).toEqual([]);
    expect(await listSourceConflicts(engine, { scope: { sourceIds: ['default'] }, remote: true, fenced: slug => slug.startsWith('notes/') })).toEqual([]);
    expect(await codeOf(() => listSourceConflicts(engine, { scope: { sourceIds: ['default'] }, remote: true, conflictId: hidden }))).toBe('import_conflict_not_found');
    const op = operations.find(o => o.name === 'list_source_conflicts')!;
    expect(await codeOf(() => op.handler({ engine, remote: true, sourceId: 'default' } as never, { include_bytes: true }))).toBe('invalid_params');
    const viaOp = await op.handler({ engine, remote: true, sourceId: 'default' } as never, {}) as { conflicts: unknown[]; count: number };
    expect(viaOp.count).toBe(1);
  });

  test('put_page resolves_conflict settles a both_changed conflict in the page publication', async () => {
    await put('notes/beta-example', page('Beta', 'Database side.'));
    const id = await conflict('notes/beta-example', 'both_changed');
    const pid = await pageId('notes/beta-example');
    await engine.executeRaw(`INSERT INTO export_ledger(source_id, source_incarnation, page_id, path, path_folded, revision, lifetime, disk_sha256, seeded_from)
      SELECT 'default', incarnation, $1, 'notes/beta-example.md', 'notes/beta-example.md', $2::uuid, 1, 'old', 'export' FROM sources WHERE id='default'`, [pid, await revision('notes/beta-example')]);
    const written = await put('notes/beta-example', page('Beta', 'Merged by the agent.'), { expected_revision: await revision('notes/beta-example'), resolves_conflict: id });
    expect(written.error).toBe(false);
    const [row] = await engine.executeRaw<{ state: string; resolution: string }>('SELECT state, resolution FROM import_conflicts WHERE id=$1', [id]);
    expect(row).toEqual({ state: 'resolved', resolution: 'written' });
    const snapshot = await engine.readPageSnapshot('notes/beta-example', { sourceId: 'default' });
    expect(snapshot!.page.compiled_truth).toContain('Merged by the agent.');
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM export_outbox WHERE source_id='default' AND page_id=$1", [pid]))[0]!.n).toBe(1);
    const ledger = await engine.executeRaw<{ disk_sha256: string }>("SELECT disk_sha256 FROM export_ledger WHERE source_id='default' AND page_id=$1", [pid]);
    expect(ledger).toEqual([{ disk_sha256: sha('file side\n') }]);
  });

  test('put_page resolves_conflict refuses deletion kinds, closed conflicts and a missing revision, and writes nothing', async () => {
    await put('notes/gamma-example', page('Gamma', 'Database side.'));
    const before = await revision('notes/gamma-example');
    const deleted = await conflict('notes/gamma-example', 'deleted_vs_edited');
    const refused = await put('notes/gamma-example', page('Gamma', 'Agent write.'), { expected_revision: before, resolves_conflict: deleted });
    expect(refused.error).toBe(true);
    expect(JSON.stringify(refused.body)).toContain('import_conflict_not_writable');
    await engine.executeRaw("UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='taken_database' WHERE id=$1", [deleted]);
    const both = await conflict('notes/gamma-example', 'both_changed');
    await engine.executeRaw("UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='taken_database' WHERE id=$1", [both]);
    const stale = await put('notes/gamma-example', page('Gamma', 'Agent write.'), { expected_revision: before, resolves_conflict: both });
    expect(JSON.stringify(stale.body)).toContain('import_conflict_stale');
    const open = await conflict('notes/gamma-example', 'both_changed');
    const unbound = await put('notes/gamma-example', page('Gamma', 'Agent write.'), { resolves_conflict: open });
    expect(JSON.stringify(unbound.body)).toContain('revision_required');
    expect(await revision('notes/gamma-example')).toBe(before);
    const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM import_conflicts WHERE id=$1', [open]);
    expect(row!.state).toBe('open');
  });

  test('the publication compare-and-set fails when the conflict file moved after admission', async () => {
    await put('notes/delta-example', page('Delta', 'Database side.'));
    const id = await conflict('notes/delta-example', 'both_changed');
    const pid = await pageId('notes/delta-example');
    expect(await codeOf(() => engine.transaction(tx => closeResolvedConflict(tx as BrainEngine, { sourceId: 'default', slug: 'notes/delta-example', pageId: pid,
      conflictId: id, fileSha256: sha('an older file\n') })))).toBe('import_conflict_stale');
    const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM import_conflicts WHERE id=$1', [id]);
    expect(row!.state).toBe('open');
  });

  test('sources conflicts resolve is preview-bound: a stale plan is refused, both takes apply', async () => {
    await put('notes/epsilon-example', page('Epsilon', 'Database side.'));
    const id = await conflict('notes/epsilon-example', 'both_changed', page('Epsilon', 'File side.'));
    const preview = await resolveConflict(engine, parseConflictsArgs(['default', 'resolve', String(id), '--take', 'file', '--dry-run']));
    expect(preview.apply).toEqual(['gbrain', 'sources', 'conflicts', 'default', 'resolve', String(id), '--take', 'file', '--expect', preview.plan_hash]);
    expect(await codeOf(() => resolveConflict(engine, parseConflictsArgs(['default', 'resolve', String(id), '--take', 'file', '--expect', 'f'.repeat(64)])))).toBe('import_conflict_stale');
    await resolveConflict(engine, parseConflictsArgs(['default', 'resolve', String(id), '--take', 'file', '--expect', preview.plan_hash]));
    expect((await engine.readPageSnapshot('notes/epsilon-example', { sourceId: 'default' }))!.page.compiled_truth).toContain('File side.');
    expect((await engine.executeRaw<{ resolution: string }>('SELECT resolution FROM import_conflicts WHERE id=$1', [id]))[0]!.resolution).toBe('taken_file');
    expect(await codeOf(() => resolveConflict(engine, parseConflictsArgs(['default', 'resolve', String(id), '--take', 'file', '--expect', preview.plan_hash])))).toBe('import_conflict_not_found');

    const db = await conflict('notes/epsilon-example', 'both_changed');
    const dbPreview = await resolveConflict(engine, parseConflictsArgs(['default', 'resolve', String(db), '--take', 'database', '--dry-run']));
    await resolveConflict(engine, parseConflictsArgs(['default', 'resolve', String(db), '--take', 'database', '--expect', dbPreview.plan_hash]));
    expect((await engine.executeRaw<{ resolution: string }>('SELECT resolution FROM import_conflicts WHERE id=$1', [db]))[0]!.resolution).toBe('taken_database');
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM export_outbox WHERE source_id='default'"))[0]!.n).toBeGreaterThan(0);
  });
});
