/**
 * Wave B PR 5 (split git layout): a top-level `gbrain_parts` frontmatter key is reserved for a split page head's
 * manifest, so every page-content write admission refuses it (put_page, put_pages, capture, edit_page) with
 * invalid_params and nothing is stored; a nested key of the same name is ordinary data. Managed persistence on.
 * Postgres with GBRAIN_TEST_BACKEND=postgres (test/postgres-unit-arms.txt).
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const remoteAuth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
const RESERVED = 'gbrain_parts is a reserved frontmatter key.';
const reserved = (title: string) => `---\ntitle: ${title}\ngbrain_parts:\n  format: 1\n  parts: []\n---\n\nA synthetic body.\n`;

type Call = (name: string, params: Record<string, unknown>, remote: boolean) => Promise<{ isError: boolean; body: Record<string, any> }>;
const brain = (run: (b: { engine: BrainEngine; call: Call }) => Promise<void>) => managedBrain(async ({ engine }) => {
  const registrations = {
    remote: await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] }),
    local: await registerLocalWriter(engine, 'cli'),
  };
  const call: Call = async (name, params, remote) => {
    const response = await withVerifiedLocalRegistration(engine, remote ? registrations.remote : registrations.local, () => dispatchToolCall(engine, name, params, {
      remote, config: { engine: engine.kind }, sourceId: 'default', ...(remote ? { auth: remoteAuth } : {}), logger: { info() {}, warn() {}, error() {} } }));
    return { isError: response.isError === true, body: JSON.parse((response.content[0] as { text: string }).text) };
  };
  await run({ engine, call });
}, { databaseUrl });
const stored = (engine: BrainEngine, slug: string) => engine.getPage(slug, { sourceId: 'default' });

test('put_page, put_pages and capture refuse a top-level gbrain_parts key, local and remote; nothing is stored', () => brain(async ({ engine, call }) => {
  for (const remote of [false, true]) {
    const slug = `notes/reserved-${remote ? 'remote' : 'local'}`;
    const put = await call('put_page', { slug, content: reserved('Reserved'), request_id: randomUUID() }, remote);
    expect(put).toMatchObject({ isError: true, body: { error: 'invalid_params', message: RESERVED } });
    expect(await stored(engine, slug)).toBeNull();
    const batch = await call('put_pages', { pages: [{ slug: `${slug}-batch`, content: reserved('Batch') }], request_id: randomUUID() }, remote);
    expect(JSON.stringify(batch.body)).toContain(RESERVED);
    expect(await stored(engine, `${slug}-batch`)).toBeNull();
    const capture = await call('capture', { slug: `${slug}-capture`, content: reserved('Capture'), request_id: randomUUID() }, remote);
    expect(capture).toMatchObject({ isError: true, body: { error: 'invalid_params', message: RESERVED } });
    expect(await stored(engine, `${slug}-capture`)).toBeNull();
  }
  const nested = await call('put_page', { slug: 'notes/nested', content: '---\ntitle: Nested\nmeta:\n  gbrain_parts: 1\n---\n\nBody.\n', request_id: randomUUID() }, true);
  expect(nested.isError).toBe(false);
  expect((await stored(engine, 'notes/nested'))?.frontmatter).toMatchObject({ meta: { gbrain_parts: 1 } });
}), 120_000);

test('edit_page refuses an edit that adds a top-level gbrain_parts key; the page keeps its revision', () => brain(async ({ engine, call }) => {
  expect((await call('put_page', { slug: 'notes/edited', content: '---\ntitle: Edited\n---\n\nA synthetic body.\n', request_id: randomUUID() }, false)).isError).toBe(false);
  for (const remote of [false, true]) {
    const before = await call('get_page', { slug: 'notes/edited', include_content: true }, remote);
    const edit = await call('edit_page', { slug: 'notes/edited', expected_revision: before.body.revision, request_id: randomUUID(),
      edits: [{ old_text: 'title: Edited\n', new_text: 'title: Edited\ngbrain_parts:\n  format: 1\n' }] }, remote);
    expect(edit).toMatchObject({ isError: true, body: { error: 'invalid_params', message: RESERVED } });
    const after = await call('get_page', { slug: 'notes/edited', include_content: true }, remote);
    expect(after.body.revision).toBe(before.body.revision);
  }
  expect((await stored(engine, 'notes/edited'))?.frontmatter).not.toHaveProperty('gbrain_parts');
}), 120_000);
