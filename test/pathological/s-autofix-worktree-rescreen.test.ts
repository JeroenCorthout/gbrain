/**
 * GBRA-133 PR 3 item 4: the automatic `worktree_dirty` re-screen and its switch, on a real managed brain.
 *
 * A sync holds a file `worktree_dirty` when a commit moved under an uncommitted edit. Master's next sync already imports
 * the file once the edit is committed (the case below checks that, so the re-screen never doubles it). What the
 * post-sync re-screen adds: a hold still standing while its bytes are committed at HEAD (a hold an older release left,
 * or a commit that landed after the sync froze its manifest) is scheduled for a re-screen with a `scheduled` receipt,
 * and the notifier (item 5) picks the request up. `sync.autofix.worktree_dirty_rescreen` false (or the umbrella)
 * schedules nothing. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { gitHoldItem, readGitHoldRetryPaths, readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { readAutofixReceipts } from '../../src/core/autofix/receipts.ts';
import { rescreenAfterManagedSync } from '../../src/core/autofix/rescreen.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const sync = (engine: BrainEngine) => performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true } as never);
const listed = async (engine: BrainEngine) => (await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? [];
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ i: string }>("SELECT incarnation::text i FROM sources WHERE id='default'"))[0]!.i;
const body = (v: string) => `---\ntitle: Note Example\n---\nVersion ${v} of the note.\n`;
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/a.md'), body('one'));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'one');
};

/** Holds notes/a.md worktree_dirty: an uncommitted edit (two) under a commit that moved the file (three). */
async function dirtyHold(engine: BrainEngine, root: string) {
  await sync(engine);
  writeFileSync(join(root, 'notes/a.md'), body('two'));
  const oid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: body('three'), encoding: 'utf8' }).trim();
  git(root, 'update-index', '--cacheinfo', `100644,${oid},notes/a.md`);
  git(root, 'commit', '-qm', 'three');
  const held = await sync(engine);
  expect((await listed(engine)).map(h => [h.path, h.code])).toEqual([['notes/a.md', 'worktree_dirty']]);
  return held;
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`the worktree_dirty re-screen (${backend})`, () => {
    test('committing the edit: the next sync imports it by itself and the re-screen schedules nothing extra', async () => {
      await managedBrain(async ({ engine, root }) => {
        await dirtyHold(engine, root);
        git(root, 'add', 'notes/a.md'); git(root, 'commit', '-qm', 'two');
        await sync(engine);
        expect(await listed(engine)).toEqual([]);
        expect((await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/a'"))[0]!.compiled_truth).toContain('Version two');
        expect(await readGitHoldRetryPaths(engine, 'default', await incarnation(engine))).toEqual([]);
        expect((await readAutofixReceipts(engine, 'default')).filter(r => r.kind === 'worktree_dirty_rescreen')).toEqual([]);
      }, { databaseUrl, setup });
    }, 180_000);

    test('a hold left standing while its bytes are committed at HEAD is scheduled and receipted; the switch or the umbrella off schedules nothing', async () => {
      await managedBrain(async ({ engine, root }) => {
        const held = await dirtyHold(engine, root);
        git(root, 'add', 'notes/a.md'); git(root, 'commit', '-qm', 'two');
        const hold = (await listed(engine))[0]!;
        const result = { ...held, held: [gitHoldItem(hold)] } as SyncResult;
        const outer = { sourceId: 'default', noPull: true } as never;
        for (const key of ['sync.autofix.worktree_dirty_rescreen', 'sync.autofix.enabled']) {
          await engine.setConfig(key, 'false');
          await rescreenAfterManagedSync(engine, outer, result);
          expect(await readGitHoldRetryPaths(engine, 'default', await incarnation(engine))).toEqual([]);
          expect(await readAutofixReceipts(engine, 'default')).toEqual([]);
          await engine.setConfig(key, 'true');
        }
        await rescreenAfterManagedSync(engine, outer, result);
        expect(await readGitHoldRetryPaths(engine, 'default', await incarnation(engine))).toEqual(['notes/a.md']);
        expect((await readAutofixReceipts(engine, 'default')).map(r => [r.kind, r.admission, r.outcome, r.code, r.path, r.disabling_key]))
          .toEqual([['worktree_dirty_rescreen', 'automatic', 'scheduled', 'worktree_dirty', 'notes/a.md', 'sync.autofix.worktree_dirty_rescreen']]);
        await rescreenAfterManagedSync(engine, outer, result);
        expect((await readAutofixReceipts(engine, 'default')).length).toBe(1);
        await sync(engine);
        expect(await listed(engine)).toEqual([]);
        expect(await readGitHoldRetryPaths(engine, 'default', await incarnation(engine))).toEqual([]);
      }, { databaseUrl, setup });
    }, 180_000);
  });
}
