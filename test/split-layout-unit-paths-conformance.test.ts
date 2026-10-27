/**
 * Wave B PR 5 lane 5b (C1): conformance. Every commit or landed-commit check of a split page in the door modules builds
 * its path set from the planned list: the recovery record's planned states (`afterHash`), the manifest's sha256 for a
 * kept part, and `planned: null` for what HEAD or the index hold beyond it (`splitPartsHeld`); none derives it from the
 * disk.
 *
 * 1. Protects: in coordinator.ts, effect-git.ts, git-door.ts and split-files.ts, a function that commits
 *    (`commitThroughDoor`, `commitGitTargets`) or reads a landed commit (`rev-list`, `ls-tree`) and handles a split page
 *    reads the record's planned states and does not list, verify or hash the parts directory on disk to choose its paths.
 * 2. Fails when: such a function builds a split page's paths itself (the written files only, the manifest joined by
 *    hand, or each path hashed from disk), as the planted bypasses below do, so a part edited, added or kept outside
 *    the plan can enter or stay out of a commit.
 * 3. Static: TypeScript AST over the source, no database. The door's own implementation (doorCommit) is a sink.
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
const SINKS = ['commitThroughDoor', 'doorCommit', 'commitGitTargets'];
const COMMIT = new RegExp(`\\b(${SINKS.join('|')})\\s*\\(|'rev-list'|'ls-tree'`);
const SPLIT = /split(?!\s*\()|gbparts|partsDir|manifest\.parts/i;
/** The planned list: the recovery record's planned state of each file. */
const PLANNED = /\bafterHash\b/;
/** A path set or planned state derived from the disk: listing, verifying or hashing the parts directory's files. */
const DISK_SET = /\b(readdirSync|verifyParts|currentParts|partFilesOnly|preparedParts)\s*\(|\bhashFile\(\s*join\(|staged:\s*true/;

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

/** The functions of `text` that commit or read a landed commit for a split page from anything but the planned list. */
export function splitUnitBypasses(file: string, text: string): string[] {
  return functions(file, text)
    .filter(fn => !SINKS.includes(fn.name))
    .filter(fn => COMMIT.test(fn.body) && SPLIT.test(fn.body) && (!PLANNED.test(fn.body) || DISK_SET.test(fn.body)))
    .map(fn => `${file}:${fn.name}`);
}

describe('split git layout: every split commit path set comes from the planned list', () => {
  test('the door modules have no bypass', () => {
    expect(DOOR_FILES.flatMap(file => splitUnitBypasses(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('the check finds every function that commits or checks a landed commit for a split page', () => {
    const found = DOOR_FILES.flatMap(file => functions(file, readFileSync(file, 'utf8')).filter(fn => COMMIT.test(fn.body) && SPLIT.test(fn.body)).map(fn => fn.name));
    expect(found).toEqual(expect.arrayContaining(['publishMutation', 'splitLandedCommit']));
  });

  test('planted bypasses are caught: the written files, a hand-joined manifest, a landed check without the plan, a disk-hashed plan', () => {
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
      async function interim(splitDoor, recovery, unit) {
        const kept = recovery.files.map(file => file.afterHash);
        return commitThroughDoor(splitDoor.root, unit.parts.map(rel => ({ path: join(splitDoor.root, rel), planned: hashFile(join(splitDoor.root, rel)) })));
      }
      async function listed(splitDoor, recovery) {
        const parts = readdirSync(partsDirFor(recovery.files[0].path));
        return commitThroughDoor(splitDoor.root, recovery.files.map(file => ({ path: file.path, planned: file.afterHash })).concat(parts));
      }
      async function fine(splitDoor, recovery, kept) {
        const planned = new Map([...recovery.files.map(file => [file.path, file.afterHash]), ...Object.entries(kept)]);
        for (const rel of await splitPartsHeld(splitDoor.root, recovery.files[0].path)) if (!planned.has(rel)) planned.set(rel, null);
        return commitThroughDoor(splitDoor.root, [...planned].map(([path, planned]) => ({ path, planned })), lock, undefined, [partsDirFor(recovery.files[0].path)]);
      }
      async function unrelated(root, path) { return commitThroughDoor(root, [{ path }]); }
      async function lister(session, commit) { return (await git(session, ['ls-tree', '-r', '-z', commit])).stdout.split('\\0'); }`;
    expect(splitUnitBypasses('planted.ts', planted)).toEqual(['planted.ts:publish', 'planted.ts:effect', 'planted.ts:landed', 'planted.ts:interim', 'planted.ts:listed']);
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
      async function deferred(root, files) { if ((await splitUnitMembers(root, files)).size) return; publishPersistenceFile(files[0]); }
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
        const parts = parseHead(readFileSync(files[0].path, 'utf8')).manifest.parts;
        return listed.stdout.trim();
      }
      export async function whole(root, doorHead, files) {
        return git(session, ['rev-list', '--reverse', doorHead + '..HEAD', '--', files[0].path, partsDirFor(files[0].path)]);
      }`;
    expect(partialUnitSearches('planted.ts', planted)).toEqual(['planted.ts:splitLandedCommit']);
  });
});
