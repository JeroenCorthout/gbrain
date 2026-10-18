#!/usr/bin/env bun
// GBRA-135 pilot only (capy/gbra135-pilot, never merged): run PostgreSQL-arm files two at a
// time, each worker against its own database, output buffered per file and printed in list order.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const urls = [process.env.PILOT_DB_URL_1, process.env.PILOT_DB_URL_2].filter((u): u is string => !!u);
const receiptDir = process.env.PILOT_RECEIPT_DIR ?? '';
const weights: Record<string, number> = JSON.parse(readFileSync('scripts/postgres-arm-weights.json', 'utf8'));
const files = process.argv.slice(2).sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
if (urls.length !== 2 || files.length === 0) {
  console.error('usage: PILOT_DB_URL_1=… PILOT_DB_URL_2=… bun scripts/zz-gbra135-pair-runner.ts <file>…');
  process.exit(2);
}

interface Result { file: string; worker: number; ms: number; rc: number; out: string }
const results: Array<Result | undefined> = new Array(files.length);
const busy = [0, 0];
let next = 0;
let printed = 0;
const started = Date.now();

function flush() {
  while (printed < files.length && results[printed]) {
    const r = results[printed]!;
    process.stdout.write(`::group::${r.file}\n`);
    process.stdout.write(r.out);
    process.stdout.write(`PILOT_FILE file=${r.file} worker=${r.worker} ms=${r.ms} rc=${r.rc}\n::endgroup::\n`);
    printed++;
  }
}

function runFile(file: string, worker: number): Promise<Result> {
  const id = `pair-w${worker}-${basename(file, '.ts')}`;
  const args = ['--no-env-file', 'test', '--timeout=120000'];
  if (receiptDir) args.push('--reporter=junit', `--reporter-outfile=${receiptDir}/${id}.junit.xml`);
  args.push(file);
  const t0 = Date.now();
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    const child = spawn('bun', args, { env: { ...process.env, DATABASE_URL: urls[worker] }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => chunks.push(c));
    child.on('close', code => resolve({ file, worker, ms: Date.now() - t0, rc: code ?? 1, out: Buffer.concat(chunks).toString('utf8') }));
  });
}

async function worker(w: number) {
  while (next < files.length) {
    const i = next++;
    const r = await runFile(files[i], w);
    busy[w] += r.ms;
    results[i] = r;
    flush();
  }
}

await Promise.all([worker(0), worker(1)]);
const failed = results.filter(r => r && r.rc !== 0).map(r => r!.file);
for (const f of failed) console.log(`::error file=${f}::PostgreSQL arm failed (pilot pair runner)`);
console.log(`PILOT_PAIR files=${files.length} wall_ms=${Date.now() - started} busy_w0_ms=${busy[0]} busy_w1_ms=${busy[1]} failed=${failed.length}`);
process.exit(failed.length ? 1 : 0);
