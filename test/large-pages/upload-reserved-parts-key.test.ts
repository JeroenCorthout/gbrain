/**
 * Wave B PR 5 lane 5b: commit_page_upload refuses page content with a top-level `gbrain_parts` key (split_head_content),
 * as put_page admission does (persistence/split-head-admission.ts): the key marks a split page head in Git.
 *
 * 1. Protects: an upload of a split head's text, within the single-string ceiling (read back whole) and over it
 *    (streamed, only its leading bytes read), is refused at the commit preparation, before the staged upload is
 *    consumed: nothing is stored and no file is written, on a source bound to a worktree and on an unbound source, where
 *    nothing else stands between the key and the database (sync then reads a stored page with the key as an older
 *    gbrain's import of a split head). On a bound source the preparation itself refuses (consumer:prepared never fires);
 *    the publication door's own split_head_content check in split-files.ts is the second line.
 * 2. Fails when: an upload with the key is stored, its staging is marked committed, the refusal carries another code,
 *    or a bound source's upload is prepared and left to the publication door.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 ** 2;
const PART_CHARS = 3_900_000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const op = (name: string) => operations.find(o => o.name === name)!;
const HEAD = '---\ntitle: Field log\ngbrain_parts:\n  format: 1\n  parts: []\n---\n\n';

function headText(bytes: number): string {
  const lines: string[] = [];
  for (let i = 0, n = HEAD.length; n < bytes; i++) {
    const line = `Line ${i} of the acme-example field log kept by alice-example, long enough to fill the page quickly.`;
    lines.push(line);
    n += line.length + 1;
  }
  return `${HEAD}${lines.join('\n')}\n`;
}

const SIZES = [['within the ceiling', 64 * 1024], ['over the ceiling (streamed)', PAGE_MAX_BYTES + MiB]] as const;

async function refusedUpload(engine: BrainEngine, ctx: OperationContext, slug: string, text: string): Promise<void> {
  const call = async (name: string, params: Record<string, unknown>) => await op(name).handler(ctx, params) as Record<string, any>;
  const session = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: sha(text), request_id: randomUUID() });
  for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
    const piece = text.slice(at, at + PART_CHARS);
    await call('upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: sha(piece) });
  }
  let refusal: unknown;
  for (let attempt = 0; ; attempt++) {
    try { await call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 }); break; }
    catch (error) {
      if (error instanceof OperationError && error.code === 'write_pending' && attempt <= 40) continue;
      refusal = error;
      break;
    }
  }
  expect(refusal).toBeInstanceOf(OperationError);
  expect((refusal as OperationError).code).toBe('split_head_content');
  const [staging] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [session.upload_id]);
  expect(staging?.state).not.toBe('committed');
  expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug])).toEqual([]);
  expect(await engine.executeRaw("SELECT slug FROM pages WHERE frontmatter ? 'gbrain_parts'")).toEqual([]);
}

for (const backend of testBackends()) describe(`[${backend}] commit_page_upload refuses a top-level gbrain_parts key`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let pglite: PGLiteEngine | undefined;
  beforeAll(async () => {
    if (databaseUrl) return;
    pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema();
  });
  afterAll(async () => { await pglite?.disconnect(); });

  for (const [label, bytes] of SIZES) {
    test(`unbound source, ${label}: refused split_head_content, nothing stored`, async () => {
      const { engine, close } = databaseUrl ? await isolatedPersistencePostgres(databaseUrl) : { engine: pglite! as BrainEngine, close: async () => {} };
      try {
        const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
        await refusedUpload(engine, ctx, 'notes/field-log', headText(bytes));
      } finally { await close(); }
    }, 600_000);

    test(`bound source, ${label}: refused split_head_content at preparation, no file written`, () => managedBrain(async ({ engine, ctx, root }) => {
      const points = new Set<string>();
      installFaultHook(async point => { points.add(point); });
      try { await refusedUpload(engine, ctx, 'notes/field-log', headText(bytes)); } finally { installFaultHook(undefined); }
      expect(points.has('consumer:prepared')).toBe(false);
      expect(existsSync(join(root, 'notes/field-log.md'))).toBe(false);
      expect(existsSync(join(root, 'notes/.field-log.gbparts'))).toBe(false);
    }, { databaseUrl, setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); } }), 600_000);
  }
});
