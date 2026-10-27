/**
 * Wave B PR 5 (option B), C1 D5: the door refuses a split publication Git would convert on checkout (core.autocrlf=true
 * or core.eol=crlf on a head or part that is not -text) with git_attribute before any write, and an explicit -text rule
 * lets the same page publish byte for byte and reassemble after a forced checkout.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { __setSplitLimitsForTests, parseHead, verifyParts } from '../src/core/split-layout/index.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 1024, partMax: 2048, leadMax: 128, partCountMax: 500 };
const SLUG = 'notes/example', HEAD = SLUG + '.md';
const content = '---\ntype: note\ntitle: LF page\n---\n' + 'Synthetic LF paragraph for the split page.\n'.repeat(150);
const setupWith = (attributes: string) => ({ root }: { root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  writeFileSync(join(root, '.gitattributes'), attributes);
  durableGitRepo(root, ['.gitignore', '.gitattributes']);
};
afterEach(() => __setSplitLimitsForTests(null));

async function publish(engine: { executeRaw: (sql: string) => Promise<unknown> }, ctx: OperationContext) {
  __setSplitLimitsForTests(LIMITS);
  await engine.executeRaw('UPDATE sources SET config=config || \'{"canonical":"git"}\'::jsonb WHERE id=\'default\'');
  return operations.find(x => x.name === 'put_page')!.handler(ctx, { slug: SLUG, content, request_id: randomUUID(), wait_ms: 30_000 })
    .then(result => ({ result: result as { state?: string }, error: null }), error => ({ result: null, error: { code: error.code, reason: error.reason } }));
}

for (const backend of testBackends()) describe('[' + backend + '] split publication under checkout conversion', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const [key, value] of [['core.autocrlf', 'true'], ['core.eol', 'crlf']] as const) {
    test(key + '=' + value + ' refuses git_attribute before any write', () => managedBrain(async ({ engine, ctx, root }) => {
      git(root, 'config', key, value);
      const before = git(root, 'rev-parse', 'HEAD').trim();
      expect(await publish(engine, ctx)).toEqual({ result: null, error: { code: 'split_page_unsupported', reason: 'git_attribute' } });
      expect(existsSync(join(root, HEAD))).toBe(false);
      expect(existsSync(join(root, 'notes/.example.gbparts'))).toBe(false);
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
    }, { databaseUrl, setup: setupWith('\n') }), 120_000);
  }

  test('an explicit -text rule publishes under core.autocrlf=true and still reassembles after checkout', () => managedBrain(async ({ engine, ctx, root }) => {
    git(root, 'config', 'core.autocrlf', 'true');
    expect(await publish(engine, ctx)).toMatchObject({ result: { state: 'committed' }, error: null });
    await settleManagedGitEffects(engine);
    git(root, 'checkout-index', '--force', '--all');
    const head = join(root, HEAD), parsed = parseHead(readFileSync(head, 'utf8'));
    if (!parsed || 'error' in parsed) throw new Error('Expected a split head');
    expect(readFileSync(head, 'utf8')).not.toContain('\r\n');
    expect(verifyParts(head, parsed)).toMatchObject({ ok: true });
  }, { databaseUrl, setup: setupWith('*.md -text\n*.gbpart -text\n') }), 120_000);
});
