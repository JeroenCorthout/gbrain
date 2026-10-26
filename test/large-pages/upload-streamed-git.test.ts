/**
 * Wave B PR 5 lane 5b: a page upload over the single-string ceiling (PAGE_MAX_BYTES) on a Git-backed source writes its
 * canonical file before the database row, as every page write does (persistence/upload-streamed.ts).
 *
 * 1. Protects: (a) on a worktree-backed source the upload's canonical file F (the stored page's canonical render,
 *    streamed from the staged upload, never one string) lands as a split head plus parts: on a strict source in the door
 *    commit before the row commits, otherwise as files before the row and then one Git commit by the Git effect; the
 *    reassembled F is byte for byte the stored page's render. (b) A database-only source (sync.write_through false)
 *    publishes database-only as today: no file, no Git effect; so does, on a strict source, a page under a declared
 *    storage.db_only dir. (An unbound source is test/large-pages/upload-over-ceiling.test.ts.) (c) On a strict source G7a classes the upload from its own
 *    frontmatter (the streamed file carries the page it renders): a private upload publishes database-only as the
 *    declared class `private`, with no file and no commit. The undeclared refusal itself is G7a's suite
 *    (test/git-canonical-declared-g7a.test.ts), which this lane runs unchanged.
 * 2. Fails when: the upload publishes database-only on a bound source (no file, Git is not the parent), F differs from
 *    the render the page reads back as, the files are not in place when publication ends (before the row is applied), or a declared or private upload writes
 *    a file (or a private one is refused instead of classed).
 *    (d) The file is built from the upload's own outputs, never a database apply: the prepared page applies exactly once
 *    (one segmented:flipped), and the file matches the stored page's render byte for byte for a remote writer whose
 *    frontmatter the gate strips and stamps, with a timeline region, and for a replace that keeps a tag frontmatter did
 *    not set, and for a bare ## Timeline section with truth on both sides of it (the regions are not in upload order).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. Production split limits (25 MiB uploads, 8 MiB parts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { unreadPageFile } from '../../src/core/persistence/page-prepare.ts';
import { parseHead, partsDirFor, reassemble, splitScratchPath, verifyParts } from '../../src/core/split-layout/index.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 ** 2;
const PART_CHARS = 3_900_000;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const op = (name: string) => operations.find(o => o.name === name)!;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - cache/\n');
  mkdirSync(join(root, 'cache'));
  durableGitRepo(root, ['.gitignore', 'gbrain.yml']);
};

/** A page of at least \`bytes\` ASCII bytes. */
function bigPage(bytes: number, extra = ''): string {
  const lines: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const line = `Line ${i} of the acme-example field log kept by alice-example, long enough to fill the page quickly.`;
    lines.push(line);
    n += line.length + 1;
  }
  return `---\ntype: note\ntitle: Field log\n${extra}---\n\n${lines.join('\n')}\n`;
}

async function upload(ctx: OperationContext, slug: string, text: string, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const call = async (name: string, params: Record<string, unknown>) => await op(name).handler(ctx, params) as Record<string, any>;
  const session = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: sha(text), request_id: randomUUID(), ...over });
  for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
    const piece = text.slice(at, at + PART_CHARS);
    await call('upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: sha(piece) });
  }
  for (let attempt = 0; ; attempt++) {
    try { return await call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 }); }
    catch (error) { if (!(error instanceof OperationError) || error.code !== 'write_pending' || attempt > 40) throw error; }
  }
}

/** sha256 of the page file a split head stands for, after verifying its parts. */
function headFileSha(path: string): string {
  const parsed = parseHead(readFileSync(path, 'utf8'));
  if (!parsed || 'error' in parsed) throw new Error(`${path} is not a split head`);
  expect(verifyParts(path, parsed)).toMatchObject({ ok: true });
  const scratch = splitScratchPath();
  const verdict = reassemble(path, parsed, scratch);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.sha256;
}

const renderSha = async (engine: BrainEngine, slug: string) => (await unreadPageFile(engine, (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!)).hash;
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ reason: string | null; source_path: string | null }>(
  "SELECT database_only_reason AS reason, source_path FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0] ?? null;
const committedPaths = (root: string, commit: string) => git(root, 'show', '--name-only', '--format=', commit).split('\n').filter(Boolean).sort();

for (const backend of testBackends()) describe(`[${backend}] uploads over the ceiling on a Git-backed source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));

  test('(a) a bound source writes F as head + parts before the row; the Git effect commits them together', () => managedBrain(async ({ engine, ctx, root }) => {
    const text = bigPage(25 * MiB);
    const path = join(root, 'notes/field-log.md');
    const seen: Record<string, { head: boolean; parts: number }> = {};
    installFaultHook(async point => {
      if ((point !== 'publication:before_publication' && point !== 'publication:after_publication') || seen[point]) return;
      const parsed = existsSync(path) ? parseHead(readFileSync(path, 'utf8')) as { manifest: { parts: unknown[] } } | null : null;
      seen[point] = { head: existsSync(path), parts: parsed?.manifest?.parts.length ?? 0 };
    });
    expect(await upload(ctx, 'notes/field-log', text)).toMatchObject({ state: 'committed' });
    expect(seen['publication:before_publication']).toEqual({ head: false, parts: 0 });
    expect(seen['publication:after_publication']!.head).toBe(true);
    expect(seen['publication:after_publication']!.parts).toBeGreaterThan(1);
    const partCount = seen['publication:after_publication']!.parts;
    expect(headFileSha(path)).toBe(await renderSha(engine, 'notes/field-log'));
    expect(await pageRow(engine, 'notes/field-log')).toMatchObject({ reason: null });
    await settleManagedGitEffects(engine);
    const commits = git(root, 'log', '--format=%H', '--', 'notes/field-log.md', 'notes/.field-log.gbparts').split('\n').filter(Boolean);
    expect(commits).toHaveLength(1);
    expect(committedPaths(root, commits[0]!)).toContain('notes/field-log.md');
    expect(committedPaths(root, commits[0]!).filter(rel => rel.startsWith('notes/.field-log.gbparts/'))).toHaveLength(partCount);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 600_000);

  test('(a) not strict: at publication:before_commit, before the row commits, the head and every part are on disk with their planned hashes', () => managedBrain(async ({ engine, ctx, root }) => {
    const text = bigPage(25 * MiB);
    let planned: Array<{ path: string; afterHash: string | null }> = [];
    let atCommit: Array<{ path: string; hash: string | null }> | undefined;
    installFaultHook(async point => {
      if (point === 'publication:prepared' && !planned.length) {
        const [row] = await engine.executeRaw<{ recovery: unknown }>('SELECT recovery FROM persistence_requests WHERE recovery IS NOT NULL');
        const record = (typeof row!.recovery === 'string' ? JSON.parse(row!.recovery) : row!.recovery) as { target?: string; files: typeof planned };
        expect(record.target).toBe('page_split');
        planned = record.files.map(file => ({ path: file.path, afterHash: file.afterHash }));
      }
      if (point === 'publication:before_commit' && !atCommit) atCommit = planned.map(file => ({ path: file.path, hash: existsSync(file.path) ? sha(readFileSync(file.path)) : null }));
    });
    expect(await upload(ctx, 'notes/order-log', text)).toMatchObject({ state: 'committed' });
    expect(planned.length).toBeGreaterThan(2);
    expect(planned[0]!.path).toBe(join(root, 'notes/order-log.md'));
    expect(planned.every(file => file.afterHash !== null)).toBe(true);
    expect(atCommit).toEqual(planned.map(file => ({ path: file.path, hash: file.afterHash })));
    expect(headFileSha(join(root, 'notes/order-log.md'))).toBe(await renderSha(engine, 'notes/order-log'));
  }, { databaseUrl, setup }), 600_000);

  test('(a) a strict source commits head + parts through the door before the row commits', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const text = bigPage(25 * MiB);
    const seen: { head?: string; paths?: string[] } = {};
    installFaultHook(async point => {
      if (point !== 'publication:before_commit' || seen.head) return;
      seen.head = git(root, 'rev-parse', 'HEAD').trim();
      seen.paths = committedPaths(root, 'HEAD');
    });
    const receipt = await upload(ctx, 'notes/strict-log', text);
    expect(receipt).toMatchObject({ state: 'committed' });
    expect(seen.paths).toContain('notes/strict-log.md');
    expect(seen.paths!.filter(rel => rel.startsWith('notes/.strict-log.gbparts/')).length).toBeGreaterThan(1);
    const [done] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
    expect(done!.outcome.persistence).toMatchObject({ git_state: 'committed', git_commit: seen.head });
    expect(headFileSha(join(root, 'notes/strict-log.md'))).toBe(await renderSha(engine, 'notes/strict-log'));
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 600_000);

  test('(d) F is built from the upload, not a database apply: a remote writer\'s stamped page with a timeline region renders byte for byte as the stored page; the apply runs once', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('write_gate.agent_mode', 'off');
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES('upload-remote','fixture-hash','example-client','read write','default')`);
    const remote = { ...ctx, remote: true, transport: 'http', inboundFrameBytes: 4 * MiB,
      auth: { token: 'fixture', clientId: 'upload-remote', principal: { kind: 'oauth_client', id: 'upload-remote' }, scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] } } as unknown as OperationContext;
    const text = bigPage(25 * MiB, 'trust_tier: owner\nsummary: A field log.\ntags: [zeta, alpha]\n') + '\n<!-- timeline -->\n\n- **2026-01-01** | Met alice-example at acme-example.\n';
    let flips = 0;
    installFaultHook(async point => { if (point === 'segmented:flipped') flips++; });
    expect(await upload(remote, 'notes/remote-log', text)).toMatchObject({ state: 'committed' });
    expect(flips).toBe(1);
    const path = join(root, 'notes/remote-log.md');
    const head = readFileSync(path, 'utf8');
    expect(head).not.toContain('trust_tier: owner');
    expect(headFileSha(path)).toBe(await renderSha(engine, 'notes/remote-log'));
    const reassembled = splitScratchPath();
    const parsed = parseHead(head) as Exclude<ReturnType<typeof parseHead>, null | { error: unknown }>;
    expect(reassemble(path, parsed, reassembled)).toMatchObject({ ok: true });
    const tail = readFileSync(reassembled, 'utf8').slice(-200);
    expect(tail).toContain('<!-- timeline -->');
    expect(tail).toContain('Met alice-example at acme-example.');
  }, { databaseUrl, setup }), 600_000);

  test('(d) a middle bare ## Timeline section (truth on both sides of it) renders byte for byte as the stored page', () => managedBrain(async ({ engine, root }) => {
    const lines = (n: number, what: string) => Array.from({ length: n }, (_, i) => `${what} line ${i} of the acme-example field log kept by alice-example, long enough to fill it.`).join('\n');
    const text = `---\ntype: note\ntitle: Field log\n---\n\n# Notes\n\n${lines(200, 'Opening')}\n\n## Timeline\n\n- **2026-01-01** | Met alice-example at acme-example.\n\n## Later material\n\n${lines(Math.ceil(25 * MiB / 90), 'Later')}\n`;
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    expect(await upload(ctx, 'notes/middle-timeline', text)).toMatchObject({ state: 'committed' });
    const path = join(root, 'notes/middle-timeline.md');
    expect(headFileSha(path)).toBe(await renderSha(engine, 'notes/middle-timeline'));
    const reassembled = splitScratchPath();
    expect(reassemble(path, parseHead(readFileSync(path, 'utf8')) as Exclude<ReturnType<typeof parseHead>, null | { error: unknown }>, reassembled)).toMatchObject({ ok: true });
    const file = readFileSync(reassembled, 'utf8');
    expect(file).toContain('Met alice-example at acme-example.');
    expect(file).toContain('Later line 0 of');
  }, { databaseUrl, setup }), 600_000);

  test('(d) a replace keeps the tags frontmatter did not set: F renders byte for byte as the stored page; the apply runs once', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await upload(ctx, 'notes/tagged-log', bigPage(25 * MiB, 'tags: [field]\n'))).toMatchObject({ state: 'committed' });
    const revision = async () => (await engine.readPageSnapshot('notes/tagged-log', { sourceId: 'default' }))!.revision;
    expect(await op('add_tag').handler(ctx, { slug: 'notes/tagged-log', tag: 'manual', request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    let flips = 0;
    installFaultHook(async point => { if (point === 'segmented:flipped') flips++; });
    expect(await upload(ctx, 'notes/tagged-log', bigPage(25 * MiB + 4096, 'tags: [log]\n'), { mode: 'replace', expected_revision: await revision() })).toMatchObject({ state: 'committed' });
    expect(flips).toBe(1);
    expect((await engine.readPageSnapshot('notes/tagged-log', { sourceId: 'default' }))!.tags).toEqual(['log', 'manual']);
    expect(headFileSha(join(root, 'notes/tagged-log.md'))).toBe(await renderSha(engine, 'notes/tagged-log'));
  }, { databaseUrl, setup }), 600_000);

  test('(b) with sync.write_through false the source is database-only: the upload publishes database-only as today', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    const before = git(root, 'rev-parse', 'HEAD').trim();
    const receipt = await upload(ctx, 'notes/field-log', bigPage(25 * MiB));
    expect(receipt).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/field-log.md'))).toBe(false);
    expect(existsSync(partsDirFor(join(root, 'notes/field-log.md')))).toBe(false);
    expect(await pageRow(engine, 'notes/field-log')).toMatchObject({ source_path: null });
    await settleManagedGitEffects(engine);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 600_000);

  test('(b) strict: a page under a storage.db_only dir is declared database-only: no file, no commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const before = git(root, 'rev-parse', 'HEAD').trim();
    expect(await upload(ctx, 'cache/field-log', bigPage(25 * MiB))).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'cache/field-log.md'))).toBe(false);
    expect(existsSync(partsDirFor(join(root, 'cache/field-log.md')))).toBe(false);
    expect(await pageRow(engine, 'cache/field-log')).toMatchObject({ source_path: null });
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
  }, { databaseUrl, setup }), 600_000);

  test('(c) strict: a private upload is G7a\'s declared class, judged from its own frontmatter: database-only, no file, no commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const before = git(root, 'rev-parse', 'HEAD').trim();
    expect(await upload(ctx, 'notes/secret-log', bigPage(25 * MiB, 'visibility: private\n'))).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/secret-log.md'))).toBe(false);
    expect(existsSync(partsDirFor(join(root, 'notes/secret-log.md')))).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(await pageRow(engine, 'notes/secret-log')).toEqual({ reason: 'private', source_path: null });
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 600_000);
});
