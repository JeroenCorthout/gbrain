/**
 * GBRA-218 member read access: remote search latency and recall benchmark.
 *
 * Seeds a synthetic one-source brain on in-process PGLite (repo-less), with a
 * share of pages naming readers, then runs remote search calls through MCP
 * dispatch as serve --http does, for an unbound token and a member token.
 * Reports p50/p95 per cell and hit@10 against an oracle (the local caller's
 * ranking filtered to the pages that caller may read). PGLite is in-process, so
 * runs on two revisions are directly comparable; on a revision without member
 * tables only the 0% cell runs.
 *
 * Usage: bun scripts/bench-member-access.ts [--pages 5000] [--queries 60] [--json]
 */
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const arg = (name: string, def: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const PAGES = arg('--pages', 5000);
const QUERIES = arg('--queries', 60);
const JSON_MODE = process.argv.includes('--json');
const DIMS = 1536;
const SRC = 'bench-src';
const WORDS = 'harbor ledger quarry beacon orchard summit lantern canyon meadow glacier river forest delta prairie island coral'.split(' ');

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
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function runCell(share: number) {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const hasMembers = (await engine.executeRaw<{ t: string | null }>("SELECT to_regclass('access_members')::text AS t"))[0]?.t != null;
  if (share > 0 && !hasMembers) { await engine.disconnect(); return null; }
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  const aliceReads = new Set<string>();
  const restrictedEvery = share > 0 ? Math.round(1 / share) : 0;
  for (let i = 0; i < PAGES; i++) {
    const slug = `notes/page-${i}`;
    const words = [WORDS[i % WORDS.length], WORDS[(i * 7) % WORDS.length], WORDS[(i * 13 + 3) % WORDS.length]];
    const restricted = share > 0 && (share >= 0.5 ? i % 5 !== 0 : i % restrictedEvery === 0);
    const readers = restricted ? (i % 2 === 0 ? '[alice-example]' : '[group:team-b]') : null;
    if (!restricted || i % 2 === 0) aliceReads.add(slug);
    const fm = ['---', 'type: note', `title: Page ${i}`, ...(readers ? [`readable_by: ${readers}`] : []), '---'].join('\n');
    await importFromContent(engine, slug, `${fm}\n# Page ${i}\n\nNotes about the ${words.join(' ')} for item ${i}.`, { sourceId: SRC });
  }
  if (hasMembers) await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example') ON CONFLICT DO NOTHING");
  const mint = async (name: string) => mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
  const unbound = await mint('bench-unbound');
  const alice = await mint('bench-alice');
  if (hasMembers) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [alice.id, 'alice-example']);
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

  async function remote(token: string, params: Record<string, unknown>) {
    const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
    const sourceId = auth.sourceId ?? 'default';
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const t0 = performance.now();
    const out = await dispatchToolCall(engine, 'search', params, { remote: true, transport: 'http', auth, sourceId,
      takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    return { ms: performance.now() - t0, text: out.content.map(c => c.text).join('\n') };
  }
  const slugsIn = (text: string) => [...new Set(text.match(/notes\/page-\d+/g) ?? [])];

  const cells: Record<string, unknown>[] = [];
  for (const [who, token, readable] of [['unbound', unbound.token, null], ['member', alice.token, aliceReads]] as const) {
    for (const match of ['keyword', 'hybrid'] as const) {
      const times: number[] = [];
      let hits = 0, possible = 0;
      for (let q = 0; q < QUERIES; q++) {
        const query = `${WORDS[q % WORDS.length]} ${WORDS[(q * 5 + 1) % WORDS.length]}`;
        const params = { query, limit: 10, ...(match === 'keyword' ? { match: 'keyword' } : {}) };
        const { ms, text } = await remote(token, params);
        if (q >= 5) times.push(ms);
        if (readable && share > 0) {
          const local = await dispatchToolCall(engine, 'search', { ...params, limit: 200 }, { remote: false, sourceId: SRC });
          const oracle = slugsIn(local.content.map(c => c.text).join('\n')).filter(s => readable.has(s)).slice(0, 10);
          const got = new Set(slugsIn(text));
          hits += oracle.filter(s => got.has(s)).length;
          possible += oracle.length;
        }
      }
      cells.push({ share, who, match, p50: +pct(times, 0.5).toFixed(2), p95: +pct(times, 0.95).toFixed(2), ...(possible ? { hit_at_10: +(hits / possible).toFixed(3) } : {}) });
    }
  }
  await engine.disconnect();
  return cells;
}

configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'bench' } });
__setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
const all: Record<string, unknown>[] = [];
for (const share of [0, 0.2, 0.8]) {
  const cells = await runCell(share);
  if (cells) all.push(...cells);
}
if (JSON_MODE) console.log(JSON.stringify({ pages: PAGES, queries: QUERIES, cells: all }));
else console.table(all);
process.exit(0);
