/**
 * The default worktree recovery budget leaves room for a page at the ceiling (Wave B PR 2, fix lane M, item 4).
 *
 * 1. Protects: with `pages.segmented_storage on`, an unset `persistence.limits.worktree_recovery_bytes` reads as twice
 *    the effective `pages.max_bytes` (the engine ceiling when unset) plus headroom per copy, never below 256 MiB, so
 *    a restore of a page at the ceiling (which reserves its file twice) fits; with the switch off it stays 256 MiB. A
 *    configured value is kept as the user's choice, and the 1 GiB brain budget already holds the largest default.
 * 2. Fails when: the default stays a flat 256 MiB under a 256 MiB (Postgres) or 128 MiB (PGLite) ceiling, follows a
 *    `pages.max_bytes` above the ceiling, drops below 256 MiB for a lowered `pages.max_bytes`, or overrides a configured
 *    value.
 * 3. Existing coverage: segmented-delete-restore-file.slow.test.ts deletes and restores 27 and 90 MiB pages within the
 *    old budget; recovery-budget-ceiling.slow.test.ts deletes and restores a page the old budget refused.
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { RECOVERY_FILE_HEADROOM_BYTES, SEGMENTED_PAGE_CEILING_BYTES } from '../../src/core/page-body/limits.ts';
import { readJournalLimits } from '../../src/core/persistence/limits.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 * 1024;
const OLD_DEFAULT = 256 * MiB;

for (const kind of testBackends()) describe(`worktree recovery default follows the page ceiling (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const ceiling = SEGMENTED_PAGE_CEILING_BYTES[kind];
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%' OR key IN ('pages.segmented_storage','pages.max_bytes')");
  });
  const worktree = async () => (await readJournalLimits(engine)).worktreeRecoveryBytes;

  test('switch off or unset: 256 MiB', async () => {
    expect(await worktree()).toBe(OLD_DEFAULT);
    await engine.setConfig('pages.segmented_storage', 'off');
    await engine.setConfig('pages.max_bytes', String(ceiling));
    expect(await worktree()).toBe(OLD_DEFAULT);
  });

  test('switch on: twice the ceiling plus headroom, so a restore of a page at the ceiling fits', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    const expected = 2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES);
    expect(await worktree()).toBe(expected);
    expect(expected).toBeGreaterThan(OLD_DEFAULT);
    // A restore reserves its file twice plus the record's 4 KiB (coordinator.ts pageRecoveryRecord); a file at the ceiling
    // with a 64 KiB frontmatter fits, which the old default refused on both engines.
    const restoreOfCeilingPage = 2 * (ceiling + 64 * 1024) + 4096;
    expect(restoreOfCeilingPage).toBeLessThanOrEqual(expected);
    expect(restoreOfCeilingPage).toBeGreaterThan(OLD_DEFAULT);
    // The brain-wide budget already holds the largest default, so it is left as it is.
    expect((await readJournalLimits(engine)).brainRecoveryBytes).toBeGreaterThanOrEqual(expected);
  });

  test('pages.max_bytes: a lowered value never drops below 256 MiB, a value above the ceiling clamps to it', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('pages.max_bytes', String(64 * MiB));
    expect(await worktree()).toBe(OLD_DEFAULT);
    await engine.setConfig('pages.max_bytes', String(200 * MiB));
    expect(await worktree()).toBe(Math.max(OLD_DEFAULT, 2 * (Math.min(200 * MiB, ceiling) + RECOVERY_FILE_HEADROOM_BYTES)));
    await engine.setConfig('pages.max_bytes', String(4 * ceiling));
    expect(await worktree()).toBe(2 * (ceiling + RECOVERY_FILE_HEADROOM_BYTES));
  });

  test('a configured worktree_recovery_bytes is the user\'s choice', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('persistence.limits.worktree_recovery_bytes', String(OLD_DEFAULT));
    expect(await worktree()).toBe(OLD_DEFAULT);
    await engine.setConfig('persistence.limits.worktree_recovery_bytes', '1048576');
    expect(await worktree()).toBe(1048576);
  });
});
