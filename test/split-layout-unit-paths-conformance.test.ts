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
