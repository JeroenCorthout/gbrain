/**
 * #7776 on Postgres: an older binary's initSchema replayed its whole schema (CREATE OR REPLACE FUNCTION ...) over a
 * database a newer gbrain migrated, reinstalling superseded writer-fence guard bodies, then applied nothing. initSchema
 * now refuses with client_behind under the schema lock, before anything in the schema runs, and doctor's
 * schema_function_bodies check names bodies an older replay already reverted. PGLite (repo-less default):
 * test/init-schema-client-behind.test.ts and test/doctor-schema-function-bodies.test.ts.
 * Run: DATABASE_URL=... bun test test/e2e/init-schema-client-behind-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { schemaFunctionBodyDrift } from '../../src/commands/doctor/checks/schema-function-bodies.ts';
import { functionBody, installNewerBody, NEWER_BODY_MARKER } from '../helpers/guard-body-drift.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
const GUARDS = ['gbrain_count_git_canonical_sources', 'gbrain_guard_effect_protocol', 'gbrain_guard_protocol_activation',
  'gbrain_guard_request_protocol', 'gbrain_require_managed_writer'];

describeE2E('initSchema on a database newer than the binary (#7776, Postgres)', () => {
  let admin: ReturnType<typeof postgres>;
  let engine: PostgresEngine;
  const name = `gbrain_test_behind_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${name}`;
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString() });
    await engine.initSchema();
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('a fresh database (no config row) initializes, and every function has this binary\'s body', async () => {
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    const drift = await schemaFunctionBodyDrift(engine);
    expect(drift).toMatchObject({ status: 'checked', differing: [] });
    if (drift.status === 'checked') expect(drift.checked).toBeGreaterThanOrEqual(GUARDS.length);
  });

  test('refuses client_behind and leaves the newer guard bodies and the version alone', async () => {
    for (const guard of GUARDS) await installNewerBody(engine, guard);
    await engine.setConfig('version', String(LATEST_VERSION + 1));
    const error = await engine.initSchema().then(() => null, (e: unknown) => e as { code?: string; fix?: { argv?: string[]; actor?: string } });
    for (const guard of GUARDS) expect(await functionBody(engine, guard)).toContain(NEWER_BODY_MARKER);
    expect(error?.code).toBe('client_behind');
    expect(error?.fix).toMatchObject({ argv: ['gbrain', 'upgrade'], actor: 'host_admin' });
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION + 1));
    expect(await schemaFunctionBodyDrift(engine)).toEqual({ status: 'skipped', reason: 'client_behind', version: LATEST_VERSION + 1, latest: LATEST_VERSION });
  }, 60_000);

  test('at head doctor names each drifted body, and the replay of this binary (lock released) clears them', async () => {
    await engine.setConfig('version', String(LATEST_VERSION));
    expect(await schemaFunctionBodyDrift(engine)).toMatchObject({ status: 'checked', differing: GUARDS });
    await engine.initSchema();
    for (const guard of GUARDS) expect(await functionBody(engine, guard)).not.toContain(NEWER_BODY_MARKER);
    expect(await schemaFunctionBodyDrift(engine)).toMatchObject({ status: 'checked', differing: [] });
  }, 120_000);
});
