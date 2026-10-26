/**
 * Wave B PR 5 (option B): a split page is never written or committed where Git would convert its bytes. A head's
 * manifest hashes every part byte for byte, so the door of a git-canonical source refuses, through the one split-unit
 * check (persistence/split-unit-guard.ts assertSplitUnitMutable), a split publication whose head or parts carry a text,
 * eol, crlf, ident, filter or working-tree-encoding attribute or a diff driver with a textconv: split_page_unsupported
 * with reason git_attribute, before anything is written; the door commit checks again, core.autocrlf included
 * (hash-object must equal the raw blob id). Nothing is staged around the attributes. A source that is not git-canonical
 * never lays the page out as a split unit, so the same write there is the one file it always was.
 *
 * 1. Protects: each converting rule on the parts refuses the strict write and leaves the disk and HEAD unchanged; a
 *    strict write under core.autocrlf=true with CRLF parts refuses at its door commit, which commits nothing, and
 *    recovery removes the new files; a plain -text diff driver without textconv still commits the whole unit byte for
 *    byte. On a non-strict source the page is one file with no parts directory.
 * 2. Fails when: an attribute is missed (ident's clean direction leaves an unexpanded token alone, but a checkout expands
 *    it), the door hashes the parts through the clean filter, or a non-strict source writes parts.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { __setSplitLimitsForTests, parseHead, partsDirFor, SPLIT_MAX_FILE_BYTES_KEY } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/probe';
const lines = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of a synthetic acme-example page body long enough to fill parts.`);
const page = (eol: string) => `---\ntype: note\ntitle: CRLF example\n---\n\n${lines.join(eol)}\n`;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => __setSplitLimitsForTests(null));

/** The refusal's code and reason (code:reason), or null when the write committed. */
async function put(ctx: OperationContext, content: string): Promise<string | null> {
  try { await operations.find(op => op.name === 'put_page')!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 }); return null; }
  catch (error) { if (!(error instanceof OperationError)) throw error; return `${error.code}:${error.reason}`; }
}

function state(root: string) {
  const head = join(root, `${SLUG}.md`), dir = partsDirFor(head);
  return { head: existsSync(head), parts: existsSync(dir) ? readdirSync(dir).length : null, commit: git(root, 'rev-parse', 'HEAD').trim(), tracked: git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'notes') };
}

async function source(engine: BrainEngine, root: string, strict: boolean, attributes: string | null, config: string[][] = []) {
  __setSplitLimitsForTests(LIMITS);
  await engine.setConfig(SPLIT_MAX_FILE_BYTES_KEY, '2048');
  if (strict) await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
  for (const [key, value] of config) git(root, 'config', key!, value!);
  if (attributes === null) return;
  writeFileSync(join(root, '.gitattributes'), attributes);
  git(root, 'add', '.gitattributes'); git(root, 'commit', '-qm', 'Synthetic attributes');
}

const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) describe(`[${backend}] split git layout: Git attributes that convert a split page refuse`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const rules: Array<[string, string, string[][]]> = [
    ['*.gbpart text eol=lf', '*.gbpart text eol=lf\n', []],
    ['*.gbpart crlf', '*.gbpart crlf\n', []],
    ['*.gbpart ident', '*.gbpart ident\n', []],
    ['*.gbpart filter=lfs', '*.gbpart filter=lfs\n', []],
    ['*.gbpart working-tree-encoding=UTF-16', '*.gbpart working-tree-encoding=UTF-16\n', []],
    ['*.gbpart diff=example with a textconv', '*.gbpart diff=example\n', [['diff.example.textconv', 'cat']]],
  ];
  for (const [name, attributes, config] of rules) {
    test(`${name} (strict): the write refuses git_attribute before anything is written`, () => managedBrain(async ({ engine, ctx, root }) => {
      await source(engine, root, true, attributes, config);
      const before = state(root);
      expect(await put(ctx, page('\r\n'))).toBe('split_page_unsupported:git_attribute');
      await settleManagedGitEffects(engine);
      expect(state(root)).toEqual({ ...before, head: false, parts: null });
      expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default' })).toBeNull();
    }, { databaseUrl, setup }), 120_000);

    test(`${name} (non-strict): the page is the one file it always was, with no parts`, () => managedBrain(async ({ engine, ctx, root }) => {
      await source(engine, root, false, attributes, config);
      expect(await put(ctx, page('\n'))).toBeNull();
      await settleManagedGitEffects(engine);
      expect(state(root)).toMatchObject({ head: true, parts: null });
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toContain(lines[79]!);
    }, { databaseUrl, setup }), 120_000);
  }

  test('strict, core.autocrlf=true and CRLF parts: the door commit refuses, commits nothing and the new files are removed', () => managedBrain(async ({ engine, ctx, root }) => {
    await source(engine, root, true, null, [['core.autocrlf', 'true']]);
    const before = state(root);
    expect(await put(ctx, page('\r\n'))).toBe('split_page_unsupported:git_attribute');
    expect(state(root)).toEqual({ ...before, head: false, parts: null });
    expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default' })).toBeNull();
  }, { databaseUrl, setup }), 120_000);

  test('a -text diff driver without textconv (strict) commits the whole unit byte for byte', () => managedBrain(async ({ engine, ctx, root }) => {
    await source(engine, root, true, '*.gbpart -text diff=plain\n');
    expect(await put(ctx, page('\r\n'))).toBeNull();
    await settleManagedGitEffects(engine);
    const parsed = parseHead(readFileSync(join(root, `${SLUG}.md`), 'utf8'))!;
    if ('error' in parsed) throw new Error(parsed.error.reason);
    for (const part of parsed.manifest.parts) expect(sha(git(root, 'show', `HEAD:notes/${part.path}`))).toBe(part.sha256);
  }, { databaseUrl, setup }), 120_000);
});
