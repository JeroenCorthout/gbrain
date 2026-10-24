#!/usr/bin/env bun
/**
 * Summarize first-touch probe runs (GBRA-156): per run directory, p50/p95 of
 * wall, op and each stage for first touch (rep 0) and repeats (rep >= 1), plus
 * shared-buffer reads and read I/O time from the pg_stat_statements deltas.
 *
 *   bun scripts/bench/first-touch/summarize.ts DIR [DIR ...] [--skip-first N]
 */
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const skipAt = argv.indexOf('--skip-first');
const SKIP = skipAt >= 0 ? Number(argv[skipAt + 1]) : 0;
const dirs = argv.filter((a, i) => !a.startsWith('--') && (skipAt < 0 || i !== skipAt + 1));
const pct = (xs: number[], p: number) => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const r = (p / 100) * (s.length - 1); const lo = Math.floor(r), hi = Math.ceil(r); return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (r - lo)); };
const cell = (xs: number[]) => { const a = pct(xs, 50), b = pct(xs, 95); return a === null ? '-' : a + ' / ' + b; };
for (const dir of dirs) {
  const rows = readFileSync(dir + '/calls.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((r: any) => r.qi >= SKIP);
  const groups: Record<string, any[]> = { first: rows.filter((r: any) => r.rep === 0), repeat: rows.filter((r: any) => r.rep >= 1) };
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.timings ?? {})) if (typeof r.timings[k] === 'number') keys.add(k);
    for (const k of Object.keys(r.timings?.stages ?? {})) keys.add('stage.' + k);
    for (const [s, ps] of Object.entries(r.timings?.parts ?? {})) for (const k of Object.keys(ps as object)) keys.add('part.' + s + '.' + k);
    for (const k of Object.keys(r.timings?.overlapped ?? {})) keys.add('overlap.' + k);
  }
  const val = (r: any, k: string): number => {
    if (k === 'wall') return r.ms;
    if (k.startsWith('pgss.')) return r.pgss?.[k.slice(5)] ?? NaN;
    if (k.startsWith('stage.')) return r.timings?.stages?.[k.slice(6)] ?? NaN;
    if (k.startsWith('overlap.')) return r.timings?.overlapped?.[k.slice(8)] ?? NaN;
    if (k.startsWith('part.')) { const [, s, p] = k.split('.'); return r.timings?.parts?.[s!]?.[p!] ?? NaN; }
    return r.timings?.[k] ?? NaN;
  };
  const order = ['wall', ...['startup', 'connect', 'context', 'op', 'cli_other', 'total'].filter(k => keys.has(k)), ...[...keys].filter(k => k.startsWith('stage.')).sort(), ...[...keys].filter(k => k.startsWith('part.')).sort(), ...[...keys].filter(k => k.startsWith('overlap.')).sort(), 'pgss.exec_ms', 'pgss.plan_ms', 'pgss.hit', 'pgss.read', 'pgss.read_ms', 'pgss.statements'];
  const errors = rows.filter((r: any) => r.code !== 0).length, warm = rows.filter((r: any) => r.warm).length;
  console.log('\n## ' + dir + '  (n first ' + groups.first!.length + ', repeat ' + groups.repeat!.length + ', errors ' + errors + ', warm ' + warm + ')');
  console.log('| metric (p50 / p95 ms) | first touch | repeat |');
  console.log('|---|---|---|');
  for (const k of order) {
    const f = groups.first!.map(r => val(r, k)), rp = groups.repeat!.map(r => val(r, k));
    if (!f.some(Number.isFinite) && !rp.some(Number.isFinite)) continue;
    console.log('| ' + k + ' | ' + cell(f) + ' | ' + cell(rp) + ' |');
  }
}
