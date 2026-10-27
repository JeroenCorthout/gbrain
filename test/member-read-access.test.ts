/**
 * GBRA-218: per-member read access inside one source (frontmatter readable_by).
 *
 * 1. Protects: a page that names readers is read remotely only by a credential
 *    bound to a live member those readers name (directly or through a group);
 *    every other remote caller (unbound tokens, other members, granted_sources
 *    bots) gets nothing from it on any read path, and no operator switch
 *    (GBRAIN_REMOTE_PRIVATE_PAGES=1, search.remote_private_pages=visible) or
 *    private_pages grant relaxes that. Readers never relax visibility: private.
 * 2. Fails when: a restricted page, its timeline, chunks, versions or links leak
 *    to an unlisted caller on a read path, under a hatch or through a grant; a
 *    malformed readers value reads as open; a disabled member keeps access; or
 *    a listed member cannot read their own page on the core read paths.
 * 3. Existing coverage (private-pages-grant) pins visibility: private only.
 * 4. Real seams: tokens minted by the token service and bound with SQL until
 *    the member CLI lands, verified by the serve --http verifier, dispatched
 *    through MCP dispatch as serve-http-mcp does; a repo-less brain (no git
 *    checkout, the default keyless install); embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const SRC = 'mr-team';
const PAGES = {
  alice: { slug: 'notes/alice-plan', readers: '[alice-example]', canary: 'canarymralice' },
  team: { slug: 'notes/team-plan', readers: '[group:team-a]', canary: 'canarymrteam' },
  malformed: { slug: 'notes/odd-plan', readers: '[alice-example, not valid]', canary: 'canarymrodd' },
  privateAlice: { slug: 'notes/quiet-plan', readers: 'alice-example', canary: 'canarymrquiet', extra: 'visibility: private' },
} as const;
type PageKey = keyof typeof PAGES;
const OPEN = { slug: 'notes/open-plan', canary: 'canarymropen' };
const TARGET = 'notes/shared-roadmap';

function page(key: PageKey): string {
  const p = PAGES[key];
  return ['---', 'type: note', `title: ${key} plan`, `readable_by: ${p.readers}`, ...('extra' in p ? [p.extra] : []), '---',
    `# ${key} plan`, '', `Harbor ledger planning notes ${p.canary} for the roadmap.`].join('\n');
}

/** Every remote read path, with arguments a restricted page in SRC answers. */
function reads(slug: string): Array<[string, string, Record<string, unknown>]> {
  return [
    ['search hybrid', 'search', { query: 'harbor ledger planning notes', fields: 'full', limit: 20 }],
    ['search keyword', 'search', { query: 'planning notes', match: 'keyword', fields: 'full', limit: 20 }],
    ['query', 'query', { query: 'harbor ledger planning notes', expand: false, fields: 'full', limit: 20 }],
    ['recall', 'recall', { query: 'harbor ledger planning notes' }],
    ['get_page', 'get_page', { slug }],
    ['list_pages', 'list_pages', { slug_prefix: 'notes/' }],
    ['get_chunks', 'get_chunks', { slug }],
    ['get_versions', 'get_versions', { slug, include_body: true }],
    ['get_timeline', 'get_timeline', { slug }],
    ['get_links', 'get_links', { slug }],
    ['get_backlinks', 'get_backlinks', { slug: TARGET }],
    ['traverse_graph', 'traverse_graph', { slug, depth: 1 }],
    ['resolve_slugs', 'resolve_slugs', { partial: slug.slice('notes/'.length) }],
  ];
}
const ECHOES_SLUG = new Set(['get_page', 'get_chunks', 'get_versions', 'get_timeline', 'get_links', 'traverse_graph']);
const LINK_PATHS = new Set(['get_links', 'traverse_graph']);
const CORE = new Set(['search hybrid', 'search keyword', 'get_page', 'list_pages', 'get_chunks', 'get_timeline']);

for (const kind of testBackends()) {
  describe(`member read access (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const tokenIds: Record<string, string> = {};

    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }
    /** Did a read reveal the page? A path given the slug may echo it in a not-found error, so those count its content or its outgoing link. */
    const seen = (text: string, key: PageKey, label = 'search hybrid') => text.includes(PAGES[key].canary)
      || (ECHOES_SLUG.has(label) ? (LINK_PATHS.has(label) && text.includes(TARGET)) : text.includes(PAGES[key].slug));

    /** Which restricted pages `who` sees on each read path. */
    async function visibleTo(who: string, keys: readonly PageKey[]): Promise<Record<string, PageKey[]>> {
      const out: Record<string, PageKey[]> = {};
      for (const key of keys) {
        for (const [label, op, params] of reads(PAGES[key].slug)) {
          const { text } = await call(who, op, params);
          if (seen(text, key, label)) (out[label] ??= []).push(key);
        }
      }
      return out;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, TARGET, '---\ntype: note\ntitle: Shared roadmap\n---\n# Shared roadmap\n\nThe shared roadmap.', { sourceId: SRC });
      await importFromContent(engine, OPEN.slug, `---\ntype: note\ntitle: Open plan\n---\n# Open plan\n\nHarbor ledger planning notes ${OPEN.canary}.`, { sourceId: SRC });
      for (const key of Object.keys(PAGES) as PageKey[]) {
        const { slug, canary } = PAGES[key];
        await importFromContent(engine, slug, page(key), { sourceId: SRC });
        await importFromContent(engine, slug, page(key) + '\n\nSecond draft.', { sourceId: SRC });
        await engine.addLink(slug, TARGET, 'roadmap', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
        await engine.addTimelineEntry(slug, { date: '2026-09-01', summary: `Planning call ${canary}` }, { sourceId: SRC });
        await engine.createVersion(slug, { sourceId: SRC });
      }
      for (const id of ['alice-example', 'bob-example', 'dan-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a')");
      await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', 'bob-example')");
      const mint = async (name: string, member?: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        tokenIds[name] = minted.id;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      };
      await mint('alice', 'alice-example');
      await mint('bob', 'bob-example');
      await mint('dan', 'dan-example');
      await mint('unbound');
      await mint('bot');
      await mint('alice-granted', 'alice-example');
      await mint('ghost', 'nobody-example');
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['bot', '--private-pages', 'granted-sources']));
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['alice-granted', '--private-pages', 'granted-sources']));
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('the brain records that it holds restrictions', async () => {
      const [row] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'access.restrictions_present'");
      expect(row?.value).toBe('1');
    });

    test('fixture control: a trusted local caller reads every restricted page', async () => {
      for (const key of Object.keys(PAGES) as PageKey[]) {
        const out = await dispatchToolCall(engine, 'get_page', { slug: PAGES[key].slug }, { remote: false, sourceId: SRC });
        expect({ key, seen: seen(out.content.map(c => c.text).join('\n'), key) }).toEqual({ key, seen: true });
      }
    });

    test('an unbound token, a bot with granted_sources, an unknown member and an unlisted member see no restricted page on any path', async () => {
      for (const who of ['unbound', 'bot', 'ghost', 'dan']) {
        expect({ who, visible: await visibleTo(who, Object.keys(PAGES) as PageKey[]) }).toEqual({ who, visible: {} });
      }
    }, 240_000);

    test('a listed member reads their page on the core paths, and only theirs', async () => {
      const alice = await visibleTo('alice', ['alice', 'team', 'malformed', 'privateAlice']);
      for (const [label, keys] of Object.entries(alice)) expect({ label, keys }).toEqual({ label, keys: ['alice'] });
      for (const label of CORE) expect({ label, keys: alice[label] }).toEqual({ label, keys: ['alice'] });
      const bob = await visibleTo('bob', ['alice', 'team', 'malformed', 'privateAlice']);
      for (const [label, keys] of Object.entries(bob)) expect({ label, keys }).toEqual({ label, keys: ['team'] });
      for (const label of CORE) expect({ label, keys: bob[label] }).toEqual({ label, keys: ['team'] });
    }, 240_000);

    test('readers never relax visibility: private; a private_pages grant opens it to a listed member only', async () => {
      expect(Object.values(await visibleTo('alice', ['privateAlice'])).flat()).toEqual([]);
      const granted = await visibleTo('alice-granted', ['privateAlice']);
      expect(granted['get_page']).toEqual(['privateAlice']);
      expect(Object.values(await visibleTo('bot', ['privateAlice'])).flat()).toEqual([]);
    }, 240_000);

    for (const [hatch, run] of [
      ['GBRAIN_REMOTE_PRIVATE_PAGES=1', <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, fn)],
      ['search.remote_private_pages=visible', async <T>(fn: () => Promise<T>) => {
        await engine.setConfig('search.remote_private_pages', 'visible');
        __resetPrivateVisibilityCacheForTests();
        try { return await fn(); } finally { await engine.setConfig('search.remote_private_pages', 'hidden'); __resetPrivateVisibilityCacheForTests(); }
      }],
    ] as const) {
      test(`${hatch} relaxes visibility only: restricted pages stay with their readers`, async () => {
        await run(async () => {
          for (const who of ['unbound', 'bot', 'dan']) {
            expect({ who, visible: await visibleTo(who, Object.keys(PAGES) as PageKey[]) }).toEqual({ who, visible: {} });
          }
          const alice = await visibleTo('alice', ['alice', 'team', 'malformed', 'privateAlice']);
          for (const [label, keys] of Object.entries(alice)) expect({ label, keys: keys.filter(k => k !== 'privateAlice') }).toEqual({ label, keys: ['alice'] });
          expect(alice['get_page']).toEqual(['alice', 'privateAlice']);
          const open = await call('unbound', 'get_page', { slug: OPEN.slug });
          expect(open.text).toContain(OPEN.canary);
        });
      }, 240_000);
    }

    test('a disabled member loses access on the next request', async () => {
      await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id = 'alice-example'");
      try {
        expect(await visibleTo('alice', ['alice'])).toEqual({});
      } finally {
        await engine.executeRaw("UPDATE access_members SET disabled_at = NULL WHERE id = 'alice-example'");
      }
      expect((await visibleTo('alice', ['alice']))['get_page']).toEqual(['alice']);
    }, 120_000);
  });
}
