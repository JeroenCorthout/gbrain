/**
 * GBRA-194: `get_skill {bundled: true}` serves gbrain's own bundled skills
 * (the spring-loaded resolver's on-demand fetch), independent of this
 * brain's catalog.
 *
 * Protects: a fresh brain (shared catalog active, 3 memory skills) can still
 * load meeting-ingestion and the rest by name; remote callers pass the same
 * gates as get_skill (publish gate, name shape) and HTTP callers see only the
 * downstream set; assets are exact lookups; intent ranks candidates.
 * Fails when: bundled requests fall through to the shared catalog, the
 * publish gate is skipped for remote callers, an owner-only skill reaches an
 * HTTP caller, or an asset outside a skill's list is served.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { skillsCatalogOperations } from '../src/core/ops/skills-catalog.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { BUNDLED_SKILLS, BUNDLED_SKILL_FILES } from '../src/core/skills/bundled-skills.generated.ts';

const getSkill = skillsCatalogOperations.find(op => op.name === 'get_skill')!;

/** A brain whose shared catalog is active (a fresh `gbrain init`); any catalog read fails the test. */
function ctx(o: { remote: boolean; transport?: 'stdio' | 'http'; publish?: boolean }): OperationContext {
  const engine = {
    getConfig: async (key: string) => (key === 'mcp.publish_skills' ? String(o.publish ?? true) : null),
    executeRaw: async (sql: string) => {
      if (sql.includes('FROM persistence_brain')) return [{ skill_bundles_enabled: true }];
      throw new Error(`bundled request read the catalog: ${sql}`);
    },
  };
  return {
    engine: engine as never, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false,
    remote: o.remote, sourceId: 'default', ...(o.transport ? { transport: o.transport } : {}),
    ...(o.remote ? { auth: { token: 't', clientId: 'c', scopes: ['read'] } as never } : {}),
  } as OperationContext;
}

const call = (c: OperationContext, p: Record<string, unknown>) => getSkill.handler(c, p) as Promise<Record<string, unknown>>;
const err = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e: { code?: string }) => e);

describe('get_skill bundled: true', () => {
  test('a fresh brain serves a bundled skill by name without reading its catalog', async () => {
    const r = await call(ctx({ remote: false }), { name: 'meeting-ingestion', bundled: true });
    expect(r.bundled).toBe(true);
    expect(r.name).toBe('meeting-ingestion');
    expect(String(r.body)).toContain('# ');
    expect(String(r.body)).not.toStartWith('---');
    expect(r.assets).toContain('conventions/brain-first.md');
    expect(typeof r.gbrain_version).toBe('string');
  });

  test('remote=true over stdio (the owner\'s local harness) sees every bundled skill, owner-only included', async () => {
    const r = await call(ctx({ remote: true, transport: 'stdio' }), { name: 'db-repair', bundled: true });
    expect(r.name).toBe('db-repair');
  });

  test('remote=true over HTTP sees the downstream set only; an owner-only skill is not found', async () => {
    const ok = await call(ctx({ remote: true, transport: 'http' }), { name: 'meeting-ingestion', bundled: true });
    expect(ok.name).toBe('meeting-ingestion');
    const ownerOnly = BUNDLED_SKILLS.filter(s => s.audience === 'owner').map(s => s.name);
    expect(ownerOnly).toContain('db-repair');
    for (const name of ownerOnly) {
      expect(await err(call(ctx({ remote: true, transport: 'http' }), { name, bundled: true }))).toMatchObject({ code: 'skill_not_found' });
    }
  });

  test('HTTP callers need mcp.publish_skills; the local CLI and the owner\'s stdio harness do not', async () => {
    expect(await err(call(ctx({ remote: true, transport: 'http', publish: false }), { name: 'query', bundled: true }))).toMatchObject({ code: 'permission_denied' });
    expect(await err(call(ctx({ remote: true, transport: 'http', publish: false }), { bundled: true, intent: 'meeting notes' }))).toMatchObject({ code: 'permission_denied' });
    expect(await err(call(ctx({ remote: true, transport: 'http', publish: false }), { name: 'query', bundled: true, asset: 'conventions/brain-first.md' }))).toMatchObject({ code: 'permission_denied' });
    expect((await call(ctx({ remote: true, transport: 'stdio', publish: false }), { name: 'query', bundled: true })).name).toBe('query');
    expect((await call(ctx({ remote: false, publish: false }), { name: 'query', bundled: true })).name).toBe('query');
  });

  test('remote=true with no transport recorded is treated as HTTP (downstream, gated)', async () => {
    expect(await err(call(ctx({ remote: true, publish: false }), { name: 'query', bundled: true }))).toMatchObject({ code: 'permission_denied' });
    expect(await err(call(ctx({ remote: true }), { name: 'db-repair', bundled: true }))).toMatchObject({ code: 'skill_not_found' });
  });

  test('names are lookup keys: paths, traversal and unknown names are refused', async () => {
    for (const name of ['../query', 'query/SKILL.md', '..', '', 'x'.repeat(129)]) {
      expect(await err(call(ctx({ remote: true, transport: 'http' }), { name, bundled: true }))).toMatchObject({ code: 'invalid_params' });
    }
    expect(await err(call(ctx({ remote: false }), { name: 'testing', bundled: true }))).toMatchObject({ code: 'skill_not_found' });
    expect(await err(call(ctx({ remote: false }), { name: 'no-such-skill', bundled: true }))).toMatchObject({ code: 'skill_not_found' });
  });

  test('assets: only files the skill lists are served, JSON as text', async () => {
    const c = ctx({ remote: true, transport: 'http' });
    const a = await call(c, { name: 'meeting-ingestion', bundled: true, asset: 'conventions/brain-first.md' });
    expect(a.content).toBe(BUNDLED_SKILL_FILES['conventions/brain-first.md']);
    for (const asset of ['../../../etc/passwd', 'meeting-ingestion/SKILL.md', 'conventions/', 'query/SKILL.md', 'conventions/../RESOLVER.md']) {
      expect(await err(call(c, { name: 'meeting-ingestion', bundled: true, asset }))).toMatchObject({ code: 'skill_not_found' });
    }
    const json = BUNDLED_SKILLS.find(s => s.assets.some(p => p.endsWith('.json')));
    if (json) {
      const path = json.assets.find(p => p.endsWith('.json'))!;
      const r = await call(c.transport === 'http' && json.audience === 'owner' ? ctx({ remote: false }) : c, { name: json.name, bundled: true, asset: path });
      expect(typeof r.content).toBe('string');
      expect(() => JSON.parse(String(r.content))).not.toThrow();
    }
  });

  test('intent ranks bundled candidates (names, no bodies); no match returns an empty list', async () => {
    const r = await call(ctx({ remote: false }), { bundled: true, intent: 'ingest this meeting transcript into the brain' });
    const candidates = r.candidates as Array<{ name: string; body?: string }>;
    expect(candidates[0]!.name).toBe('meeting-ingestion');
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates.every(c => c.body === undefined)).toBe(true);
    expect((await call(ctx({ remote: false }), { intent: 'zxqv plorth' })).candidates).toEqual([]);
    expect(await err(call(ctx({ remote: false }), { bundled: true, intent: '  ' }))).toMatchObject({ code: 'invalid_params' });
  });

  test('bundled is explicit and has no source or revision', async () => {
    expect(await err(call(ctx({ remote: false }), { bundled: false, intent: 'meeting' }))).toMatchObject({ code: 'invalid_params' });
    expect(await err(call(ctx({ remote: false }), { bundled: true, name: 'query', source_id: 'default' }))).toMatchObject({ code: 'invalid_params' });
    expect(await err(call(ctx({ remote: false }), { bundled: true, name: 'query', revision: 'abc' }))).toMatchObject({ code: 'invalid_params' });
  });

  test('a plain get_skill miss on a bundled name names the bundled call and serves nothing in its place', async () => {
    const hostCatalog = (name: string) => ({
      engine: {
        getConfig: async (key: string) => (key === 'mcp.publish_skills' ? 'true' : key === 'mcp.skills_dir' ? join(import.meta.dir, 'fixtures', 'skill-catalog-query', 'skills') : null),
        executeRaw: async (sql: string) => (sql.includes('FROM persistence_brain') ? [{ skill_bundles_enabled: false }] : []),
      } as never,
      config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: true, transport: 'http' as const,
      auth: { token: 't', clientId: 'c', scopes: ['read'] } as never, sourceId: 'default',
    }) as OperationContext;
    const miss = await err(call(hostCatalog('meeting-ingestion'), { name: 'meeting-ingestion' })) as { code?: string; suggestion?: string; message?: string };
    expect(miss.code).toBe('page_not_found');
    expect(String(miss.message)).toContain('bundled skill named meeting-ingestion');
    expect(JSON.stringify(miss)).toContain('bundled: true');
    const ownerOnly = await err(call(hostCatalog('db-repair'), { name: 'db-repair' })) as { message?: string };
    expect(String(ownerOnly.message)).not.toContain('bundled');
    const unknown = await err(call(hostCatalog('no-such-skill'), { name: 'no-such-skill' })) as { message?: string };
    expect(String(unknown.message)).not.toContain('bundled');
  });

  test('the bundled set is the plugin lane: repo-development skills never ship', () => {
    const names = BUNDLED_SKILLS.map(s => s.name);
    for (const dev of ['testing', 'skillify', 'skill-autobench', 'skillpack-harvest']) expect(names).not.toContain(dev);
    expect(names.length).toBeGreaterThan(60);
  });
});
