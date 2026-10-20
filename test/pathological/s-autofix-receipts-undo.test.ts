/**
 * GBRA-133 PR 3 items 3 and 4 on a real managed brain: every automatic repair leaves a `sync-autofix` receipt, the
 * receipt's undo is rendered when it is read, and the undo really reverts the repair; the umbrella kill switch stops it.
 *
 * Protects:
 *  - the post-sync slug-line heal records one receipt (kind, admission, codes, path, preimage and postimage hashes, the
 *    write's request id, its disabling key) and never stores the file's content or a command line;
 *  - once the repair commit lands, the next sync settles the receipt to that exact commit (isolated: one path, preimage
 *    to postimage), and `readAutofixState` renders `gbrain sync undo` from it; a remote reader gets no path and no host path;
 *  - `gbrain sync undo` previews, then commits the original bytes as a new commit (the repair commit stays an ancestor,
 *    nothing is rewritten) and records an `undone` receipt; the next sync holds the file again and the heal does not
 *    reapply itself to those bytes; an unknown commit and a file edited after its repair are refused by name;
 *  - with `sync.autofix.enabled` false the heal does not run, says so, and the file stays held.
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { readAutofixReceipts } from '../../src/core/autofix/receipts.ts';
import { readAutofixState } from '../../src/core/autofix/state.ts';
import { undoAutofixCommit } from '../../src/core/autofix/undo.ts';
import { AUTOFIX_ENABLED_KEY } from '../../src/core/autofix/switches.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const STRAY = 'investors/fund-a.md';
const STRAY_BYTES = '---\ntitle: "Fund A"\ntype: company\nslug: fund-a\naliases: ["Fund A"]\n---\nFund A invests in example companies.\n';
const sync = (engine: BrainEngine) => performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true } as never);
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).map(h => [h.path, h.code]);

async function gitEffectsSettled(engine: BrainEngine) {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id='default' AND kind='git' AND state<>'committed'");
    if (!open.length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

const plant = ({ root }: { root: string }) => {
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  mkdirSync(join(root, 'investors'), { recursive: true });
  writeFileSync(join(root, STRAY), STRAY_BYTES);
  writeFileSync(join(root, 'notes.md'), '---\ntitle: Notes\n---\nA synthetic note.\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
};

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); return undefined; } catch (error) { return (error as { code?: string }).code; }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`autofix receipts and undo (${backend})`, () => {
    test('a heal is receipted, settled to its commit, rendered with its undo, and the undo reverts it for good', async () => {
      await managedBrain(async ({ engine, root }) => {
        const first = await sync(engine);
        expect(first.slug_lines_removed).toMatchObject({ removed: 1 });
        const healed = readFileSync(join(root, STRAY));
        expect(healed.toString()).not.toContain('slug: fund-a');
        const [receipt, ...more] = await readAutofixReceipts(engine, 'default');
        expect(more).toEqual([]);
        expect(receipt).toMatchObject({ kind: 'slug_line_heal', admission: 'automatic', outcome: 'applied', code: 'frontmatter_slug_conflict', path: STRAY,
          disabling_key: 'sync.slug_conflicts.auto_remove', preimage: { sha256: sha256(Buffer.from(STRAY_BYTES)) }, postimage_sha256: sha256(healed), commit: { state: 'pending', sha: null } });
        expect(typeof receipt!.request_id).toBe('string');
        const stored = JSON.stringify(await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='sync-autofix'"));
        expect(stored).not.toContain('invests in example');
        expect(stored).not.toContain('gbrain ');
        const pending = await readAutofixState(engine, 'default', { remote: false });
        expect(pending.recent[0]!.undo).toMatchObject({ available: false });
        expect((pending.recent[0]!.undo as { reason: string }).reason).toStartWith('commit_pending');

        await gitEffectsSettled(engine);
        const repairCommit = git(root, 'log', '-n1', '--format=%H', '--', STRAY);
        expect(git(root, 'show', '--name-only', '--format=', repairCommit)).toBe(STRAY);
        await sync(engine);
        expect((await readAutofixReceipts(engine, 'default'))[0]!.commit).toEqual({ state: 'landed', sha: repairCommit });
        const local = await readAutofixState(engine, 'default', { remote: false });
        expect(local.recent[0]!.path).toBe(STRAY);
        expect(local.recent[0]!.undo).toEqual({ available: true, how: 'git_revert', sha: repairCommit,
          preview: ['gbrain', 'sync', 'undo', '--source', 'default', '--commit', repairCommit],
          argv: ['gbrain', 'sync', 'undo', '--source', 'default', '--commit', repairCommit, '--apply', '--json'],
          then: ['gbrain', 'sync', '--source', 'default', '--no-pull'] });
        const remote = await readAutofixState(engine, 'default', { remote: true });
        expect(remote.recent[0]!.path).toBeNull();
        expect(JSON.stringify(remote)).not.toContain(root);
        expect(JSON.stringify(remote)).not.toContain(STRAY);

        expect(await codeOf(() => undoAutofixCommit(engine, { sourceId: 'default', sha: 'f'.repeat(40), apply: false }))).toBe('autofix_undo_unavailable');
        const preview = await undoAutofixCommit(engine, { sourceId: 'default', sha: repairCommit, apply: false });
        expect(preview).toMatchObject({ status: 'would_revert', path: STRAY, restores_sha256: sha256(Buffer.from(STRAY_BYTES)), undo_commit: null,
          opt_out: ['gbrain', 'config', 'set', 'sync.slug_conflicts.auto_remove', 'false'] });
        expect(readFileSync(join(root, STRAY))).toEqual(healed);
        const headBefore = git(root, 'rev-parse', 'HEAD');
        const applied = await undoAutofixCommit(engine, { sourceId: 'default', sha: repairCommit, apply: true });
        expect(applied.status).toBe('reverted');
        expect(readFileSync(join(root, STRAY), 'utf8')).toBe(STRAY_BYTES);
        expect(applied.undo_commit).toBe(git(root, 'rev-parse', 'HEAD'));
        expect(git(root, 'rev-parse', 'HEAD^')).toBe(headBefore);
        expect(git(root, 'show', '--name-only', '--format=', applied.undo_commit!)).toBe(STRAY);
        execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', repairCommit, 'HEAD']);
        expect(git(root, 'status', '--porcelain')).toBe('');
        expect((await readAutofixReceipts(engine, 'default'))[0]).toMatchObject({ kind: 'slug_line_heal', admission: 'operator', outcome: 'undone', path: STRAY,
          commit: { state: 'landed', sha: applied.undo_commit } });

        const after = await sync(engine);
        expect(await holds(engine)).toEqual([[STRAY, 'frontmatter_slug_conflict']]);
        expect(after.slug_lines_removed?.removed ?? 0).toBe(0);
        expect(readFileSync(join(root, STRAY), 'utf8')).toBe(STRAY_BYTES);
        expect(await codeOf(() => undoAutofixCommit(engine, { sourceId: 'default', sha: repairCommit, apply: true }))).toBe('autofix_undo_conflict');
      }, { databaseUrl, setup: plant });
    }, 240_000);

    test('sync.autofix.enabled false: the heal does not run, says which switch, and the file stays held', async () => {
      await managedBrain(async ({ engine, root }) => {
        await engine.setConfig(AUTOFIX_ENABLED_KEY, 'false');
        const result = await sync(engine);
        expect(result.slug_lines_removed).toMatchObject({ skipped: 'autofix_disabled', removed: 0, pending: 1 });
        expect(readFileSync(join(root, STRAY), 'utf8')).toBe(STRAY_BYTES);
        expect(await holds(engine)).toEqual([[STRAY, 'frontmatter_slug_conflict']]);
        expect(await readAutofixReceipts(engine, 'default')).toEqual([]);
        const state = await readAutofixState(engine, 'default', { remote: false });
        expect(state.pending).toContainEqual(expect.objectContaining({ kind: 'slug_line_heal', code: 'frontmatter_slug_conflict', count: 1, held_by_switch: AUTOFIX_ENABLED_KEY }));
        await engine.setConfig(AUTOFIX_ENABLED_KEY, 'true');
        expect((await sync(engine)).slug_lines_removed).toMatchObject({ removed: 1 });
      }, { databaseUrl, setup: plant });
    }, 240_000);
  });
}
