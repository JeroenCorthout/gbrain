/**
 * Wave B PR 5 lane 5b: a split page head moved together with its parts directory (`git mv` of both, the manifest keeps
 * the old directory name) is read, written and committed at its own parts directory (split-layout/paths.ts
 * `partFilePath`), as verify.ts reads it.
 *
 * 1. Protects: (a) after a committed rename and a managed sync, the next ordinary put_page commits and lays the page out
 *    in the new parts directory; (b) a Git effect at the moved head (head and directory moved, not committed) commits
 *    nothing and refuses split_page_unsupported, since only the strict door commits a split unit (option B); (c) the kept-edit resolution streams the moved head's parts; (d) the
 *    committed page file at HEAD of a renamed split page reassembles from its committed parts; (e) a revision's part blobs
 *    keyed under the moved head's own parts directory (the git-gap census) read as the page file.
 * 2. Fails when: a writer, the Git effect or a reader joins a manifest part path to the head's directory (the old parts
 *    directory): the put refuses source_changed, the effect commits the head without its parts, or the readers miss them.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. KB-sized split limits through __setSplitLimitsForTests.
 */
import type { BrainEngine } from '../src/core/engine.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { publishGitEffect } from '../src/core/persistence/effect-git.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { committedPageFile } from '../src/core/repair/overwritten-edits.ts';
import { __setSplitLimitsForTests, pageFileAtRevision, parseHead, reassemble, splitScratchPath, verifyParts, type ParsedHead } from '../src/core/split-layout/index.ts';
import { writeKeptEdit } from '../src/core/split-layout/resolve-head.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const page = (n = 80) => `---\ntype: note\ntitle: Moved example\n---\n\n${Array.from({ length: n }, (_, i) => `Line ${i} of the acme-example notes, long enough to fill a part.`).join('\n')}\n`;
/** Option B: only a git-canonical source lays a page out as a split unit, so every fixture source is strict (canonical = git). */
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
};
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const head = (path: string) => parseHead(readFileSync(path, 'utf8')) as ParsedHead;
const sync = (engine: Parameters<typeof performManagedSync>[0]) => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, full: true });

/** Writes notes/big.md as a split page and moves the head and its parts directory to notes/moved.md. */
async function movedSplitPage(root: string, commit: boolean) {
  const written = await writeSplitPage(root, 'notes/big.md', page());
  if (commit) {
    git(root, 'add', 'notes'); git(root, 'commit', '-qm', 'Synthetic split fixture');
    git(root, 'mv', 'notes/big.md', 'notes/moved.md'); git(root, 'mv', written.partsDir, 'notes/.moved.gbparts');
    git(root, 'commit', '-qm', 'Synthetic rename');
  } else {
    renameSync(join(root, 'notes/big.md'), join(root, 'notes/moved.md'));
    renameSync(join(root, written.partsDir), join(root, 'notes/.moved.gbparts'));
  }
  return written;
}

for (const backend of testBackends()) describe(`[${backend}] split git layout: a head moved with its parts directory`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => __setSplitLimitsForTests(null));

  test('(a) after a committed rename and a sync, the next put_page commits and lays the page out in the new parts directory', () => managedBrain(async ({ engine, ctx, root }) => {
    __setSplitLimitsForTests(LIMITS);
    await engine.setConfig('sync.max_file_bytes', '2048');
    await movedSplitPage(root, true);
    await sync(engine);
    const snapshot = (await engine.readPageSnapshot('notes/moved', { sourceId: 'default' }))!;
    expect(snapshot.page.compiled_truth).toContain('Line 79');
    const done = await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: 'notes/moved', content: page(81), request_id: randomUUID(), wait_ms: 30_000, expected_revision: snapshot.revision }) as Record<string, unknown>;
    expect(done).toMatchObject({ state: 'committed' });
    const path = join(root, 'notes/moved.md');
    const scratch = splitScratchPath();
    try {
      const verdict = reassemble(path, head(path), scratch);
      expect(verdict.ok).toBe(true);
      expect(readFileSync(scratch, 'utf8')).toContain('Line 80');
    } finally { rmSync(scratch, { force: true }); }
    expect(head(path).manifest.parts.every(part => part.path.startsWith('.moved.gbparts/'))).toBe(true);
    await settleManagedGitEffects(engine);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('(b) a Git effect at a moved head commits neither the head nor any part: only the strict door commits a split unit', () => managedBrain(async ({ root }) => {
    __setSplitLimitsForTests(LIMITS);
    await movedSplitPage(root, false);
    expect(verifyParts(join(root, 'notes/moved.md'), head(join(root, 'notes/moved.md')))).toMatchObject({ ok: true });
    const before = git(root, 'rev-parse', 'HEAD');
    const index = git(root, 'ls-files', '-s');
    await expect(publishGitEffect(root, 'notes/moved.md', undefined, true)).rejects.toMatchObject({ code: 'split_page_unsupported', reason: 'non_strict_source' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(root, 'ls-files', '-s')).toBe(index);
  }, { databaseUrl, setup }), 120_000);

  test('(c) the kept-edit resolution streams the moved head\'s parts', () => managedBrain(async ({ root }) => {
    __setSplitLimitsForTests(LIMITS);
    await movedSplitPage(root, false);
    const dest = join(root, 'kept.tmp');
    try { expect(writeKeptEdit(join(root, 'notes/moved.md'), head(join(root, 'notes/moved.md')), dest)).toMatchObject({ ok: true }); }
    finally { rmSync(dest, { force: true }); }
  }, { databaseUrl, setup }), 120_000);

  test('(d) the committed page file of a renamed split page reassembles from its committed parts', () => managedBrain(async ({ root }) => {
    __setSplitLimitsForTests(LIMITS);
    await movedSplitPage(root, true);
    const read = committedPageFile(root, 'notes/moved.md', readFileSync(join(root, 'notes/moved.md')));
    expect('hold' in read ? read.hold : null).toBeNull();
    expect(sha((read as { bytes: Buffer }).bytes)).toBe(sha(page()));
    expect(existsSync(join(root, 'notes/.big.gbparts'))).toBe(false);
  }, { databaseUrl, setup }), 120_000);

  test('(e) part blobs keyed under the moved head\'s parts directory read as the page file', () => managedBrain(async ({ root }) => {
    __setSplitLimitsForTests(LIMITS);
    await movedSplitPage(root, false);
    const dir = join(root, 'notes/.moved.gbparts');
    const blobs = new Map(readdirSync(dir).map(name => [`.moved.gbparts/${name}`, readFileSync(join(dir, name))]));
    const read = pageFileAtRevision('notes/moved.md', 'HEAD', readFileSync(join(root, 'notes/moved.md')), blobs);
    expect('hold' in read ? read.hold : null).toBeNull();
    expect(sha((read as { bytes: Buffer }).bytes)).toBe(sha(page()));
  }, { databaseUrl, setup }), 120_000);
});
