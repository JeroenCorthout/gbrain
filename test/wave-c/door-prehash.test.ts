/**
 * Wave C 1H-a (spec §3.5): a strict file publication hashes its bytes into Git before it takes the writer lock, and the
 * door turn hashes nothing. Under the lock the door rechecks what the pre-hash stood for: the file must still hold the
 * planned bytes (git_target_changed otherwise, as before) and the path's attributes must be the ones the blob was hashed
 * under; a changed plan or changed attributes (an ident attribute added meanwhile) make the door hash the file in place.
 * A path with a clean filter is never pre-hashed. GIT_TRACE shows which hash-object calls ran.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { gitChildEnv } from '../../src/core/git-env.ts';
import { operations } from '../../src/core/operations.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { commitThroughDoor, prehashDoorFile } from '../../src/core/persistence/git-door.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(dir); return dir; };
/** The hash-object command lines a GIT_TRACE file recorded. */
const hashCalls = (trace: string) => existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(line => /trace: (built-in|exec): git hash-object/.test(line)).map(line => line.replace(/^.*?git hash-object/, 'hash-object')) : [];

function repo(): string {
  const root = scratch('gbrain-prehash-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'seed.md'), 'seed\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  return root;
}
const put = (root: string, path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };

describe('door pre-hash: rechecks under the lock', () => {
  test('a blob hashed before the lock is committed as is; the door turn runs no hash-object of the file', async () => {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    const body = 'pre-hashed body\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/a.md'), body);
    expect(prehashed).toMatchObject({ planned: sha256(body) });
    put(root, 'notes/a.md', body);
    await withEnv({ GIT_TRACE: trace }, () => commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256(body), prehashed }]));
    expect(git(root, 'rev-parse', 'HEAD:notes/a.md')).toBe(prehashed!.oid);
    expect(hashCalls(trace).filter(call => !call.includes('-t tree'))).toEqual([]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('attributes that changed after the pre-hash make the door hash the file in place', async () => {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    const body = 'Revision $Id: stale-expansion $ of the page.\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/b.md'), body);
    writeFileSync(join(root, '.gitattributes'), '*.md ident\n');
    put(root, 'notes/b.md', body);
    await withEnv({ GIT_TRACE: trace }, () => commitThroughDoor(root, [{ path: join(root, 'notes/b.md'), planned: sha256(body), prehashed }]));
    expect(git(root, 'rev-parse', 'HEAD:notes/b.md')).not.toBe(prehashed!.oid);
    expect(git(root, 'cat-file', '-p', 'HEAD:notes/b.md')).toContain('$Id$');
    expect(hashCalls(trace).some(call => call.includes('notes/b.md') && !call.includes('--path'))).toBe(true);
  });

  test('a pre-hash of other bytes than the plan is not used', async () => {
    const root = repo();
    const prehashed = await prehashDoorFile(root, join(root, 'notes/c.md'), 'an earlier draft\n');
    put(root, 'notes/c.md', 'the planned body\n');
    await commitThroughDoor(root, [{ path: join(root, 'notes/c.md'), planned: sha256('the planned body\n'), prehashed }]);
    expect(git(root, 'show', 'HEAD:notes/c.md')).toBe('the planned body');
  });

  test('a file rewritten after the pre-hash still refuses git_target_changed', async () => {
    const root = repo();
    const body = 'planned\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/d.md'), body);
    put(root, 'notes/d.md', 'edited on disk\n');
    const refused = await commitThroughDoor(root, [{ path: join(root, 'notes/d.md'), planned: sha256(body), prehashed }]).then(() => null, (error: { code?: string }) => error);
    expect(refused?.code).toBe('git_target_changed');
    expect(() => git(root, 'rev-parse', 'HEAD:notes/d.md')).toThrow();
  });

  test('a path with a clean filter is not pre-hashed', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitattributes'), '*.md filter=example\n');
    expect(await prehashDoorFile(root, join(root, 'notes/e.md'), 'body\n')).toBeNull();
  });
});

const strict = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config = config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) describe('[' + backend + '] a strict put pre-hashes before the writer lock', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('the committed blob is the pre-hashed one and the door hashes no file', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const trace = join(scratch('gbrain-trace-'), 'trace');
    const content = '---\ntype: note\ntitle: Prehash\n---\n\nA page whose blob is stored before the writer lock.\n';
    const result = await withEnv({ GIT_TRACE: trace }, () => operations.find(op => op.name === 'put_page')!.handler(ctx,
      { slug: 'notes/prehash', content, request_id: randomUUID(), wait_ms: 30_000 })) as Record<string, unknown>;
    expect(result).toMatchObject({ state: 'committed' });
    const calls = hashCalls(trace);
    expect(calls.filter(call => call.includes('-w') && call.includes('--path=notes/prehash.md')).length).toBe(1);
    expect(calls.filter(call => /-w -- notes\/prehash\.md/.test(call))).toEqual([]);
    expect(git(root, 'show', 'HEAD:notes/prehash.md')).toContain('stored before the writer lock');
  }, { databaseUrl, setup }), 120_000);
});
