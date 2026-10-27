/**
 * Wave B PR 5 lane 5b: conformance. Every commit or landed-commit check of a split page in the door modules takes its
 * paths from effect-git.ts `splitUnitPaths` (the head, every manifest part, the removal of anything else in the parts
 * directory); none assembles its own list.
 *
 * 1. Protects: in coordinator.ts, effect-git.ts, git-door.ts and split-files.ts, a function that commits
 *    (`commitThroughDoor`, `commitGitTargets`) or reads a landed commit (`rev-list`, `ls-tree`) and handles a split page
 *    also calls `splitUnitPaths`.
 * 2. Fails when: such a function builds a split page's paths itself (the written files only, or the manifest joined by
 *    hand), as the planted bypasses below do, so a kept part Git never had can stay out of a commit.
 * 3. Static: TypeScript AST over the source, no database.
 *
 * Option B widens it to every door, effect and recovery route: in coordinator.ts, group-publish.ts and effect-git.ts, a
 * function that writes, restores, removes or commits a page file (publishFile, publishPersistenceFile,
 * restoreBeforeStage, commitThroughDoor, a git commit) runs the one split-unit check (split-unit-guard.ts
 * assertSplitUnitMutable, its many-path form splitUnitRefusals, or the group's deferral through splitUnitMembers); one
 * that restores files also decides a strict door record through splitLandedCommit, which searches the whole unit in
 * HEAD. It fails when a route mutates without them, as the planted bypasses below do. The landed-commit search itself
 * (rev-list) must name the parts directory (partsDirFor), not only the record paths.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const DOOR_FILES = ['src/core/persistence/coordinator.ts', 'src/core/persistence/effect-git.ts', 'src/core/persistence/git-door.ts', 'src/core/persistence/split-files.ts'];
const SINKS = ['commitThroughDoor', 'commitGitTargets'];
const COMMIT = new RegExp(`\\b(${SINKS.join('|')})\\s*\\(|'rev-list'|'ls-tree'`);
const SPLIT = /split|gbparts|partsDir|manifest\.parts/i;

/** Named top-level functions (declarations, arrow or function constants, class methods) of a source text. */
function functions(file: string, text: string): Array<{ name: string; body: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Array<{ name: string; body: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) out.push({ name: node.name.text, body: node.body.getText(source) });
    else if (ts.isMethodDeclaration(node) && node.body) out.push({ name: node.name.getText(source), body: node.body.getText(source) });
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      out.push({ name: node.name.text, body: node.initializer.body.getText(source) });
      return;
    } else if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The functions of `text` that commit or read a landed commit for a split page without splitUnitPaths. */
export function splitUnitBypasses(file: string, text: string): string[] {
  return functions(file, text)
    .filter(fn => fn.name !== 'splitUnitPaths' && !SINKS.includes(fn.name))
    .filter(fn => COMMIT.test(fn.body) && SPLIT.test(fn.body) && !/\bsplitUnitPaths\s*\(/.test(fn.body))
    .map(fn => `${file}:${fn.name}`);
}

describe('split git layout: every split commit path set comes from splitUnitPaths', () => {
  test('the door modules have no bypass', () => {
    expect(DOOR_FILES.flatMap(file => splitUnitBypasses(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('the check finds every function that commits or checks a landed commit for a split page', () => {
    const found = DOOR_FILES.flatMap(file => functions(file, readFileSync(file, 'utf8')).filter(fn => COMMIT.test(fn.body) && SPLIT.test(fn.body)).map(fn => fn.name));
    expect(found).toEqual(expect.arrayContaining(['publishMutation', 'splitLandedCommit']));
  });

  test('planted bypasses are caught: a door commit of the written files, a hand-joined manifest, a landed check without the unit', () => {
    const planted = `
      async function publish(row, files, recovery) {
        const splitDoor = isSplitRecoveryRecord(recovery) ? recovery.door : undefined;
        if (splitDoor) await commitThroughDoor(splitDoor.root, files.map(file => ({ path: file.path })));
      }
      const effect = async (root, head, parsed) => commitGitTargets(root, [head, ...parsed.manifest.parts.map(part => join(root, part.path))]);
      export async function landed(root, doorHead, files) {
        const split = files.filter(Boolean);
        return git(session, ['rev-list', '-1', doorHead + '..HEAD', '--', ...split.map(file => file.path)]);
      }
      async function fine(root, head) { const unit = await splitUnitPaths(session, root, head); return commitGitTargets(root, [unit.head, ...unit.parts]); }
      async function unrelated(root, path) { return commitThroughDoor(root, [{ path }]); }`;
    expect(splitUnitBypasses('planted.ts', planted)).toEqual(['planted.ts:publish', 'planted.ts:effect', 'planted.ts:landed']);
  });
});

const MUTATION_FILES = ['src/core/persistence/coordinator.ts', 'src/core/persistence/group-publish.ts', 'src/core/persistence/effect-git.ts'];
const MUTATES = /\b(publishFile|publishPersistenceFile|restoreBeforeStage|commitThroughDoor)\s*\(|\['commit'|'commit',/;
const GUARDED = /\b(assertSplitUnitMutable|splitUnitRefusals|splitUnitMembers)\s*\(/;
const RESTORES = /before_restore|restoreBeforeStage\s*\(/;

/**
 * The door, effect and recovery routes of `text` that write, restore, remove or commit a page file without the one
 * split-unit check (assertSplitUnitMutable, splitUnitRefusals, or the group's deferral through splitUnitMembers), and
 * the restoring routes that do not also decide a strict door record through splitLandedCommit.
 */
export function unitGuardBypasses(file: string, text: string): string[] {
  return functions(file, text)
    .filter(fn => fn.name !== 'publishFile' && MUTATES.test(fn.body))
    .filter(fn => !GUARDED.test(fn.body) || (RESTORES.test(fn.body) && !/\bsplitLandedCommit\s*\(/.test(fn.body)))
    .map(fn => `${file}:${fn.name}`);
}

describe('split git layout: every door, effect and recovery route runs the one split-unit check', () => {
  test('the mutation modules have no bypass', () => {
    expect(MUTATION_FILES.flatMap(file => unitGuardBypasses(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('the check sees the single, group, recovery and Git effect routes', () => {
    const found = MUTATION_FILES.flatMap(file => functions(file, readFileSync(file, 'utf8')).filter(fn => fn.name !== 'publishFile' && MUTATES.test(fn.body)).map(fn => fn.name));
    expect(found).toEqual(expect.arrayContaining(['publishMutation', 'publishGroup', 'recoverPublication', 'commitGitTargets']));
  });

  test('planted bypasses are caught: a publication, a group, a restore, a Git effect commit and a restore without the door search', () => {
    const planted = `
      export async function publishMutation(engine, row, prepared, binding) {
        const split = await splitPublicationTargets(engine, prepared.file);
        publishFile(prepared.file, undefined);
      }
      export async function publishGroup(engine, rows, prepared, binding) {
        for (const member of prepared) publishPersistenceFile(member.file);
      }
      export async function recoverPublication(engine, id) {
        hooks.fileBoundary?.('before_restore', current, 0);
        publishFile(file, record.staging?.restoration?.path);
      }
      export async function commitGitTargets(root, paths) {
        await git(session, ['add', '--', ...paths]);
        await git(session, ['commit', '--only', '-m', 'x', '--', ...paths]);
      }
      async function restoreWithoutDoorSearch(record) { await assertSplitUnitMutable({ root: record.root, path: record.path, route: 'recovery', strict: false }); restoreBeforeStage(record); }
      async function checked(prepared) { await assertSplitUnitMutable({ root: prepared.file.root, path: prepared.file.path, route: 'door', strict: true }); publishFile(prepared.file); }
      async function deferred(root, files) { if ((await splitUnitMembers(files)).size) return; publishPersistenceFile(files[0]); }
      async function effect(root, paths) { const refused = await splitUnitRefusals({ root, paths, route: 'git_effect', strict: false }); await git(session, ['commit', '--only', '--', ...paths]); }
      async function recovered(record) { await assertSplitUnitMutable({ root: record.root, path: record.path, route: 'recovery', strict: false }); await splitLandedCommit(record.root, null, [record]); restoreBeforeStage(record); }`;
    expect(unitGuardBypasses('planted.ts', planted)).toEqual(['planted.ts:publishMutation', 'planted.ts:publishGroup', 'planted.ts:recoverPublication', 'planted.ts:commitGitTargets', 'planted.ts:restoreWithoutDoorSearch']);
  });
});

/** Round 6: the landed-commit search of a split page (rev-list) runs over the whole unit, its parts directory included. */
export function partialUnitSearches(file: string, text: string): string[] {
  return functions(file, text)
    .filter(fn => /'rev-list'/.test(fn.body) && SPLIT.test(fn.body) && !/\bpartsDirFor\s*\(/.test(fn.body))
    .map(fn => `${file}:${fn.name}`);
}

describe('split git layout: the landed-commit search covers the whole unit in HEAD', () => {
  test('the door modules search the head and its parts directory', () => {
    expect(DOOR_FILES.flatMap(file => partialUnitSearches(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('a planted search over the record paths only is caught', () => {
    const planted = `
      export async function splitLandedCommit(root, doorHead, files) {
        const listed = await git(session, ['rev-list', '-1', doorHead + '..HEAD', '--', ...files.map(file => file.path)]);
        const unit = await splitUnitPaths(session, root, files[0].path);
        return listed.stdout.trim();
      }
      export async function whole(root, doorHead, files) {
        return git(session, ['rev-list', '--reverse', doorHead + '..HEAD', '--', files[0].path, partsDirFor(files[0].path)]);
      }`;
    expect(partialUnitSearches('planted.ts', planted)).toEqual(['planted.ts:splitLandedCommit']);
  });
});
