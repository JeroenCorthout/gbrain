#!/usr/bin/env bun
/**
 * HNSW ef_search vs recall@10 and pages touched on the loaded brain (GBRA-156).
 * Query vectors come from the soak's mock embedder for the probe's query texts
 * (in-distribution). Exact top-10 is a sequential scan with index scans off;
 * each ef is an index scan with LIMIT = max(ef, 10), as gbrain asks for its window.
 * Pages touched (shared hit + read) is the first-touch read count on a cold cache.
 *
 *   bun scripts/bench/first-touch/ef-recall.ts --work ~/soak/work --queries q.json --set A --n 30 --out ef.json [--efs 40,100,200,300,500]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { startMockProviders } from '../retrieval-scale/mock-providers.ts';

const argv = process.argv.slice(2);
const flag = (n: string, f = '') => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1]! : f; };
const WORK = resolve(flag('work')), N = Number(flag('n', '30'));
const EFS = flag('efs', '40,100,200,300,500').split(',').map(Number);
const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(WORK, '..', 'fixture', 'manifest.json'), 'utf8'));
const qs = (JSON.parse(readFileSync(resolve(flag('queries')), 'utf8'))[flag('set', 'A')] as Array<{ q: string }>).slice(0, N);
const mock = startMockProviders({ manifest: { seed: manifest.options.seed, chunks: manifest.pages * 4, pages: manifest.pages, dims: 1536 } });
const emb = await (await fetch(mock.url + '/v1/embeddings', { method: 'POST', body: JSON.stringify({ input: qs.map(q => q.q), model: 'text-embedding-3-small' }) })).json() as any;
mock.stop();
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5434/' + ready.db, { max: 1, onnotice: () => {} });
const WHERE = `embedding IS NOT NULL AND modality = 'text' AND model = 'openai:text-embedding-3-small'`;
const out: any[] = [];
for (let i = 0; i < qs.length; i++) {
  const v = '[' + emb.data[i].embedding.join(',') + ']';
  const exact = await sql.begin(async tx => {
    await tx.unsafe("SET LOCAL enable_indexscan = off; SET LOCAL jit = off; SET LOCAL max_parallel_workers_per_gather = 4");
    return (await tx.unsafe(`SELECT id FROM content_chunks WHERE ${WHERE} ORDER BY embedding <=> $1::vector LIMIT 10`, [v])).map((r: any) => Number(r.id));
  });
  const row: any = { q: qs[i]!.q, exact, ef: {} };
  for (const ef of EFS) {
    const r = await sql.begin(async tx => {
      await tx.unsafe(`SET LOCAL hnsw.ef_search = ${ef}; SET LOCAL jit = off`);
      const plan = (await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM content_chunks WHERE ${WHERE} ORDER BY embedding <=> $1::vector LIMIT ${Math.max(ef, 10)}`, [v]))[0]['QUERY PLAN'][0];
      const ids = (await tx.unsafe(`SELECT id FROM content_chunks WHERE ${WHERE} ORDER BY embedding <=> $1::vector LIMIT ${Math.max(ef, 10)}`, [v])).map((x: any) => Number(x.id));
      return { touched: plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'], ms: plan['Execution Time'], ids };
    });
    const top = new Set(r.ids.slice(0, 10));
    row.ef[ef] = { recall10: exact.filter((id: number) => top.has(id)).length / 10, touched: r.touched, ms: Math.round(r.ms * 10) / 10 };
  }
  out.push(row);
  console.log(i, Object.entries(row.ef).map(([ef, x]: any) => ef + ':' + x.recall10 + '/' + x.touched).join(' '));
}
await sql.end();
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 1000) / 1000;
const summary = Object.fromEntries(EFS.map(ef => [ef, { recall10: mean(out.map(r => r.ef[ef].recall10)), touched: mean(out.map(r => r.ef[ef].touched)), ms_warm: mean(out.map(r => r.ef[ef].ms)) }]));
writeFileSync(resolve(flag('out')), JSON.stringify({ summary, rows: out }, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
