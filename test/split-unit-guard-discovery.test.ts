/**
 * Wave B PR 5 (option B), C1: the split-unit predicate finds a unit held only in Git wherever the target physically lies:
 * through a linked worktree's gitfile, a source subdirectory, a symlinked root or subdirectory, inside a nested
 * repository (read as itself, not as its enclosing root), behind a symlinked parts directory, and for a part path outside
 * the source root. The synchronous form reads the same Git state as the async form.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSplitUnitMutable, assertSplitUnitMutableSync } from '../src/core/persistence/split-unit-guard.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'split-unit-discovery-'));
  homes.push(home);
  const root = join(home, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'seed'), 'seed\n');
  durableGitRepo(root, ['seed']);
  return { root, home };
}
/** Commits notes/example.md with one part, then removes the parts directory from disk: the unit is held only in HEAD. */
function gitOnly(root: string) {
  mkdirSync(join(root, 'notes/.example.gbparts'), { recursive: true });
  writeFileSync(join(root, 'notes/example.md'), 'One file on disk\n');
  writeFileSync(join(root, 'notes/.example.gbparts/0001-deadbeef.gbpart'), 'Part\n');
  git(root, 'add', 'notes');
  git(root, 'commit', '-qm', 'Unit');
  rmSync(join(root, 'notes/.example.gbparts'), { recursive: true });
}
async function checked(root: string, path: string) {
  const async = await assertSplitUnitMutable({ root, path, route: 'raw_writer', strict: false }).then(() => null, error => ({ code: error.code, reason: error.reason }));
  let sync: unknown = null;
  try { assertSplitUnitMutableSync({ root, path, route: 'raw_writer' }); } catch (error: any) { sync = { code: error.code, reason: error.reason }; }
  expect(sync).toEqual(async);
  return async;
}
const refused = { code: 'split_page_unsupported', reason: 'outside_door' };

describe('split unit discovery by physical path and owning repository', () => {
  test('a page in no unit passes both forms', async () => {
    const { root } = fixture();
    writeFileSync(join(root, 'plain.md'), 'Plain\n');
    expect(await checked(root, join(root, 'plain.md'))).toBeNull();
  });
  test('HEAD-only parts are detected through a linked worktree gitfile', async () => {
    const { root, home } = fixture();
    gitOnly(root);
    const linked = join(home, 'linked');
    git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    rmSync(join(linked, 'notes/.example.gbparts'), { recursive: true });
    expect(await checked(linked, join(linked, 'notes/example.md'))).toEqual(refused);
  });
  test('HEAD-only parts are detected from a source subdirectory', async () => {
    const { root } = fixture();
    gitOnly(root);
    expect(await checked(join(root, 'notes'), join(root, 'notes/example.md'))).toEqual(refused);
  });
  test('HEAD-only parts are detected through a symlink to the repository root', async () => {
    const { root, home } = fixture();
    gitOnly(root);
    symlinkSync(root, join(home, 'alias'));
    expect(await checked(join(home, 'alias'), join(home, 'alias/notes/example.md'))).toEqual(refused);
  });
  test('HEAD-only parts are detected through a symlink to a source subdirectory', async () => {
    const { root, home } = fixture();
    gitOnly(root);
    symlinkSync(join(root, 'notes'), join(home, 'alias'));
    expect(await checked(join(home, 'alias'), join(home, 'alias/example.md'))).toEqual(refused);
  });
  test('a nested repository is inspected rather than its enclosing root', async () => {
    const { root } = fixture();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'seed'), 'seed\n');
    durableGitRepo(nested, ['seed']);
    gitOnly(nested);
    expect(await checked(root, join(nested, 'notes/example.md'))).toEqual(refused);
    expect(await checked(nested, join(nested, 'notes/example.md'))).toEqual(refused);
  });
  test('a literal symlinked parts directory is still refused', async () => {
    const { root, home } = fixture();
    gitOnly(root);
    mkdirSync(join(home, 'parts'));
    symlinkSync(join(home, 'parts'), join(root, 'notes/.example.gbparts'));
    expect(await checked(root, join(root, 'notes/example.md'))).toEqual(refused);
  });
  test('an outside-root part path cannot pass the split guard', async () => {
    const { root, home } = fixture();
    gitOnly(root);
    mkdirSync(join(home, '.outside.gbparts'));
    writeFileSync(join(home, '.outside.gbparts/0001-deadbeef.gbpart'), 'Part\n');
    expect(await checked(root, join(home, '.outside.gbparts/0001-deadbeef.gbpart'))).toEqual(refused);
  });
});
