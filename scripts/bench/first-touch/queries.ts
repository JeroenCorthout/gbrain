#!/usr/bin/env bun
/**
 * First-touch latency lane (GBRA-156): realistic, distinct search queries drawn
 * from a loaded production-soak brain, in four classes (names, topics,
 * identifiers, questions), split into disjoint sets so each run can meet
 * queries Postgres has never seen.
 *
 *   bun scripts/bench/first-touch/queries.ts --work ~/soak/work --out queries.json [--per-class 40]
 *
 * Every word comes from the synthetic fixture; nothing comes from a real brain.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { startTopology } from '../production-soak/lib.ts';

const argv = process.argv.slice(2);
const flag = (n: string, f = '') => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1]! : f; };
const WORK = resolve(flag('work')), OUT = resolve(flag('out')), PER = Number(flag('per-class', '40'));
const ready = JSON.parse(readFileSync(join(WORK, 'ready.json'), 'utf8'));
const topo = await startTopology(WORK, undefined, undefined, true);
const sql = postgres(topo.direct(ready.db), { max: 1, onnotice: () => {} });
const pick = async (where: string, n: number) => sql.unsafe(`SELECT p.id, p.slug, p.title, p.type, left(c.chunk_text, 800) AS text FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0
  WHERE p.deleted_at IS NULL AND p.frontmatter->>'visibility' IS NULL AND p.frontmatter->>'access' IS NULL AND p.frontmatter->>'confidentiality' IS NULL AND ${where}
  ORDER BY md5(p.id::text || 'gbra156') LIMIT ${n}`) as Promise<Array<{ id: number; slug: string; title: string; type: string; text: string }>>;
const words = (t: string) => t.replace(/[^a-z\s]/gi, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 4 && !/example|meeting|transcript|timeline/.test(w));
const n = PER * 4;
const people = await pick(`p.type = 'person'`, n);
const companies = await pick(`p.type = 'company'`, n);
const notes = await pick(`p.type IN ('note','concept','meeting','transcript','original')`, n * 2);
const tokens = await sql.unsafe(`SELECT substring(c.chunk_text from 'zqpg[0-9a-z]+') AS tok, p.slug FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0
  WHERE p.deleted_at IS NULL AND p.frontmatter->>'visibility' IS NULL AND c.chunk_text ~ 'zqpg[0-9a-z]+' ORDER BY md5(p.id::text || 'tok') LIMIT ${n}`) as Array<{ tok: string; slug: string }>;
await sql.end();
const strip = (t: string) => t.replace(/-example$/i, '').replace(/ Example$/, '');
const out: Array<{ cls: string; q: string }> = [];
for (let i = 0; i < n; i++) {
  const nm = i % 2 ? strip(companies[i]!.title) : strip(people[i]!.title);
  out.push({ cls: 'name', q: nm });
  const w = words(notes[i]!.text); const k = 2 + (i % 2); const at = (i * 7919) % Math.max(1, w.length - k);
  out.push({ cls: 'topic', q: w.slice(at, at + k).join(' ') || notes[i]!.title });
  out.push({ cls: 'identifier', q: i % 3 === 2 ? tokens[i]!.slug.split('/').pop()! : tokens[i]!.tok });
  const w2 = words(notes[n + i]!.text); const at2 = (i * 104729) % Math.max(1, w2.length - 2);
  const person = strip(people[(i + 7) % n]!.title);
  const forms = [`what did ${person} say about ${w2[at2]}?`, `when did we last discuss ${w2[at2]} ${w2[at2 + 1]}?`, `who is working on ${w2[at2]} with ${person}?`, `notes about ${w2[at2]} ${w2[at2 + 1]} decisions`];
  out.push({ cls: 'question', q: forms[i % 4]! });
}
const seen = new Set<string>();
const uniq = out.filter(x => x.q && !seen.has(x.q.toLowerCase()) && seen.add(x.q.toLowerCase()));
const sets: Record<string, Array<{ cls: string; q: string }>> = {};
const names = ['A', 'B', 'C', 'D'];
uniq.forEach((x, i) => { const s = names[Math.floor(i / 4) % 4]!; (sets[s] ??= []).push(x); });
writeFileSync(OUT, JSON.stringify(sets, null, 1));
console.log(Object.entries(sets).map(([k, v]) => k + ':' + v.length).join(' '));
process.exit(0);
