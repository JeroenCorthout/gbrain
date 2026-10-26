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
 * Round 6 widens it to the publication routes: in coordinator.ts and group-publish.ts, a function that writes a page
 * file (publishFile, publishPersistenceFile) runs the unit-state check (split-files.ts assertSplitUnitIntact, or the
 * group's deferral to it, splitUnitTracked); one that restores files decides through splitLandedCommit, which searches
 * the whole unit in HEAD. It fails when a route writes without it, as the planted bypasses below do.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const DOOR_FILES = ['src/core/persistence/coordinator.ts', 'src/core/persistence/effect-git.ts', 'src/core/persistence/git-door.ts', 'src/core/persistence/split-files.ts'];
const SINKS = ['commitThroughDoor', 'commitGitTargets'];
const COMMIT = new RegExp(`\\b(${SINKS.join('|')})\\s*\\(|'rev-list'|'ls-tree'`);
const SPLIT = /split|gbparts|partsDir|manifest\.parts/i;
/** Round 6 unit-state readers: they list HEAD and the index to compare them with the disk, and commit nothing. */
const STATE_READERS = ['readSplitUnitLayers', 'splitUnitTracked'];

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
    .filter(fn => fn.name !== 'splitUnitPaths' && !SINKS.includes(fn.name) && !STATE_READERS.includes(fn.name))
    .filter(fn => COMMIT.test(fn.body) && SPLIT.test(fn.body) && !/\bsplitUnitPaths\s*\(/.test(fn.body))
    .map(fn => `${file}:${fn.name}`);
}

describe('split git layout: every split commit path set comes from splitUnitPaths', () => {
  test('the door modules have no bypass', () => {
    expect(DOOR_FILES.flatMap(file => splitUnitBypasses(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('the check finds every function that commits or checks a landed commit for a split page', () => {
    const found = DOOR_FILES.flatMap(file => functions(file, readFileSync(file, 'utf8')).filter(fn => COMMIT.test(fn.body) && SPLIT.test(fn.body)).map(fn => fn.name));
    expect(found).toEqual(expect.arrayContaining(['publishSplitGitEffect', 'splitLandedCommit']));
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

const PUBLICATION_FILES = ['src/core/persistence/coordinator.ts', 'src/core/persistence/group-publish.ts'];
const WRITES_PAGE_FILE = /\b(publishFile|publishPersistenceFile)\s*\(/;
const RESTORES = /before_restore|restoreBeforeStage/;

/**
 * The page publication routes of `text` that write a page file without the round 6 unit-state check: a publication
 * (publishMutation, publishGroup) calls assertSplitUnitIntact or defers to it through splitUnitTracked; a recovery that
 * restores files (recoverPublication) decides through splitLandedCommit, which searches the whole unit in HEAD.
 */
export function unitStateBypasses(file: string, text: string): string[] {
  return functions(file, text)
    .filter(fn => fn.name !== 'publishFile' && WRITES_PAGE_FILE.test(fn.body))
    .filter(fn => !(RESTORES.test(fn.body) ? /\bsplitLandedCommit\s*\(/ : /\b(assertSplitUnitIntact|splitUnitTracked)\s*\(/).test(fn.body))
    .map(fn => `${file}:${fn.name}`);
}

describe('split git layout: every page publication route checks the unit HEAD, the index and the disk hold', () => {
  test('the publication modules have no bypass', () => {
    expect(PUBLICATION_FILES.flatMap(file => unitStateBypasses(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('the check sees the single, group and recovery routes', () => {
    const found = PUBLICATION_FILES.flatMap(file => functions(file, readFileSync(file, 'utf8')).filter(fn => fn.name !== 'publishFile' && WRITES_PAGE_FILE.test(fn.body)).map(fn => fn.name));
    expect(found).toEqual(expect.arrayContaining(['publishMutation', 'publishGroup', 'recoverPublication']));
  });

  test('planted bypasses are caught: a publication without the check, a group without the deferral, a restore without the unit search', () => {
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
      async function checked(engine, row, prepared, binding) { await assertSplitUnitIntact(engine, row, prepared.file, binding); publishFile(prepared.file); }
      async function deferred(binding, prepared) { if (await splitUnitTracked(binding, prepared)) return; publishPersistenceFile(prepared[0]); }
      async function recovered(root, record) { await splitLandedCommit(root, null, [record]); restoreBeforeStage(record); publishFile(record); }`;
    expect(unitStateBypasses('planted.ts', planted)).toEqual(['planted.ts:publishMutation', 'planted.ts:publishGroup', 'planted.ts:recoverPublication']);
  });
});
