/**
 * Wave B PR 5 (option B): persistence/split-unit-guard.ts assertSplitUnitMutable is the one refusal every route runs
 * before it changes a path that may be in a split page's unit (a head plus .<name>.gbparts/).
 *
 * 1. Protects: a route outside the door, a non-strict source and a recovery that is not the strict door's own refuse
 *    split_page_unsupported (outside_door, non_strict_source, recovery_unit_changed) on any path of a unit present on
 *    disk, in the index or in HEAD, or one a write would lay out; the strict door refuses index_flag (skip-worktree,
 *    assume-unchanged, intent-to-add), git_attribute (text, eol, crlf, ident, filter, working-tree-encoding, diff
 *    textconv, and core.autocrlf at commit) and unit_diverged; a plain page passes on every route.
 * 2. Fails when: a route skips a reason, or the door lets a flagged, converted or diverged unit through.
 * 3. No database: a Git fixture per test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError } from '../src/core/operations.ts';
import { assertSplitUnitMutable, splitUnitPresent, splitUnitRefusals, type SplitUnitGuardInput } from '../src/core/persistence/split-unit-guard.ts';
import { git, gitFixture, type GitFixture } from './helpers/git-publication.ts';

let fixture: GitFixture | null = null;
afterEach(() => { fixture?.cleanup(); fixture = null; });

const HEAD = 'Notes/page.md', DIR = 'Notes/.page.gbparts', PART = DIR + '/0001-00000000.gbpart';

/** A committed unit: a head declaring gbrain_parts and one part (the guard reads presence, never the manifest). */
function unit(): GitFixture {
  fixture = gitFixture();
  const { root } = fixture;
  mkdirSync(join(root, DIR));
  writeFileSync(join(root, HEAD), '---\ntitle: Example\ngbrain_parts:\n  version: 1\n---\nLead.\n');
  writeFileSync(join(root, PART), 'Part bytes of an acme-example page.\n');
  git(root, 'add', HEAD, PART); git(root, 'commit', '-qm', 'Unit');
  return fixture;
}

async function refusal(input: Partial<SplitUnitGuardInput> & { root: string }): Promise<{ reason?: string; message: string; next?: boolean } | null> {
  try { await assertSplitUnitMutable({ path: join(input.root, HEAD), route: 'door', strict: true, sourceId: 'source-a', ...input }); return null; }
  catch (error) {
    if (!(error instanceof OperationError) || error.code !== 'split_page_unsupported') throw error;
    expect(error.fix).toBeDefined();
    return { reason: error.reason, message: error.message, next: error.fix?.ask_user };
  }
}

describe('routes outside the strict door', () => {
  test('refuse on every unit path, with the reason of the route', async () => {
    const { root } = unit();
    for (const path of [join(root, HEAD), join(root, PART), join(root, DIR, 'stray')]) {
      expect((await refusal({ root, path, route: 'write_through' }))?.reason).toBe('outside_door');
      expect((await refusal({ root, path, route: 'connector' }))?.reason).toBe('outside_door');
      expect((await refusal({ root, path, route: 'git_effect', strict: false }))?.reason).toBe('non_strict_source');
      expect((await refusal({ root, path, route: 'git_effect', strict: true }))?.reason).toBe('outside_door');
      expect((await refusal({ root, path, strict: false }))?.reason).toBe('non_strict_source');
      expect((await refusal({ root, path, route: 'recovery' }))?.reason).toBe('recovery_unit_changed');
    }
  });

  test('a unit only Git holds (parts gone from disk) and a planned layout are units too', async () => {
    const { root } = unit();
    rmSync(join(root, DIR), { recursive: true });
    writeFileSync(join(root, HEAD), 'Plain now.\n');
    expect(await splitUnitPresent(root, join(root, HEAD))).toBe(true);
    expect((await refusal({ root, route: 'mirror' }))?.reason).toBe('outside_door');
    fixture!.cleanup(); fixture = gitFixture();
    const fresh = fixture.root;
    expect(await refusal({ root: fresh, route: 'write_through' })).toBeNull();
    expect((await refusal({ root: fresh, strict: false, planned: [join(fresh, PART)] }))?.reason).toBe('non_strict_source');
  });

  test('a Git effect group gets one refusal per unit path and none for a plain page', async () => {
    const { root } = unit();
    writeFileSync(join(root, 'Notes/plain.md'), 'One file.\n');
    rmSync(join(root, DIR), { recursive: true });
    writeFileSync(join(root, 'Notes/other.md'), 'Other.\n');
    const refused = await splitUnitRefusals({ root, paths: [join(root, HEAD), join(root, 'Notes/plain.md'), join(root, 'Notes/other.md')], route: 'git_effect', strict: false });
    expect([...refused.keys()]).toEqual([join(root, HEAD)]);
    expect(refused.get(join(root, HEAD))!.reason).toBe('non_strict_source');
  });

  test('a plain page and a path that cannot be a head pass on every route', async () => {
    fixture = gitFixture();
    const { root } = fixture;
    writeFileSync(join(root, HEAD), 'One file.\n');
    for (const route of ['door', 'git_effect', 'recovery', 'write_through', 'remover'] as const) {
      expect(await refusal({ root, route, strict: false })).toBeNull();
      expect(await refusal({ root, route, path: join(root, 'Notes/data.txt') })).toBeNull();
    }
  });
});

describe('the strict door', () => {
  test('a clean committed unit passes', async () => {
    const { root } = unit();
    expect(await refusal({ root })).toBeNull();
    expect(await refusal({ root, phase: 'commit' })).toBeNull();
  });

  for (const [name, flag] of [['skip-worktree', ['update-index', '--skip-worktree', HEAD]], ['assume-unchanged', ['update-index', '--assume-unchanged', PART]]] as const) {
    test(name + ' refuses index_flag', async () => {
      const { root } = unit();
      git(root, ...flag);
      const refused = await refusal({ root });
      expect(refused).toMatchObject({ reason: 'index_flag', next: true });
      expect((await refusal({ root, phase: 'commit' }))?.reason).toBe('index_flag');
    });
  }

  test('intent-to-add refuses index_flag', async () => {
    const { root } = unit();
    writeFileSync(join(root, DIR, '0002-11111111.gbpart'), 'New part.\n');
    git(root, 'add', '-N', DIR + '/0002-11111111.gbpart');
    expect((await refusal({ root }))?.reason).toBe('index_flag');
  });

  for (const rule of ['*.gbpart text', '*.gbpart eol=lf', '*.gbpart crlf', '*.gbpart ident', '*.gbpart filter=example', '*.md working-tree-encoding=UTF-16', '*.gbpart diff=conv']) {
    test(rule + ' refuses git_attribute', async () => {
      const { root } = unit();
      git(root, 'config', 'diff.conv.textconv', 'cat');
      writeFileSync(join(root, '.gitattributes'), rule + '\n');
      expect((await refusal({ root }))?.reason).toBe('git_attribute');
      expect((await refusal({ root, phase: 'commit' }))?.reason).toBe('git_attribute');
    });
  }

  test('a diff driver without textconv and unset attributes pass', async () => {
    const { root } = unit();
    writeFileSync(join(root, '.gitattributes'), '*.gbpart -text diff=plain\n');
    expect(await refusal({ root })).toBeNull();
  });

  test('a planned part path is checked for attributes before it exists', async () => {
    fixture = gitFixture();
    const { root } = fixture;
    writeFileSync(join(root, '.gitattributes'), '*.gbpart ident\n');
    expect((await refusal({ root, planned: [join(root, PART)] }))?.reason).toBe('git_attribute');
  });

  test('core.autocrlf refuses at commit when Git would store other bytes', async () => {
    const { root } = unit();
    git(root, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(root, PART), 'Line one\r\nLine two\r\n');
    expect((await refusal({ root, phase: 'commit' }))?.reason).toBe('git_attribute');
  });

  test('a unit HEAD, the index and the disk disagree on refuses unit_diverged before the write, never at commit', async () => {
    const { root } = unit();
    writeFileSync(join(root, PART), 'Edited by hand.\n');
    expect((await refusal({ root }))?.reason).toBe('unit_diverged');
    expect(await refusal({ root, phase: 'commit' })).toBeNull();
    git(root, 'add', PART);
    expect((await refusal({ root }))?.reason).toBe('unit_diverged');
  });

  test('a remote caller is told the page, never a path', async () => {
    const { root } = unit();
    writeFileSync(join(root, PART), 'Edited by hand.\n');
    const refused = await refusal({ root, remote: true, slug: 'notes/page' });
    expect(refused?.reason).toBe('unit_diverged');
    expect(refused!.message).not.toContain('Notes/');
  });
});
