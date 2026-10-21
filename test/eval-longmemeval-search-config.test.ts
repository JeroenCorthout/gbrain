import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

describe('runEvalLongMemEval — injected search config snapshot', () => {
  test('copies live search-mode/reranker config into the isolated benchmark brain', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-'));
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--retrieval-only',
          '--no-trajectory',
          '--limit',
          '1',
          '--output',
          join(tmp, 'out.jsonl'),
          '--mode',
          'tokenmax',
        ],
        {
          engine,
          searchConfigSnapshot: {
            'search.mode': 'balanced',
            'search.reranker.enabled': 'false',
            'search.reranker.model': 'llama-server-reranker:qwen3-reranker-4b',
            'search.reranker.timeout_ms': '30000',
          },
        },
      );

      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
      expect(await engine.getConfig('search.reranker.model'))
        .toBe('llama-server-reranker:qwen3-reranker-4b');
      expect(await engine.getConfig('search.reranker.timeout_ms')).toBe('30000');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('explicit --reranker off / --autocut off / --expansion-variant-budget beat a snapshot that turned them on', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-pins-'));
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only', '--retrieval-only', '--no-trajectory', '--by-type',
          '--limit', '1',
          '--output', join(tmp, 'out.jsonl'),
          '--reranker', 'off',
          '--autocut', 'off',
          '--expansion-variant-budget', '0.5',
        ],
        {
          engine,
          searchConfigSnapshot: {
            'search.reranker.enabled': 'true',
            'search.autocut': 'true',
            'search.expansion_variant_budget': 'legacy',
          },
        },
      );
      expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
      expect(await engine.getConfig('search.autocut')).toBe('false');
      expect(await engine.getConfig('search.expansion_variant_budget')).toBe('0.5');
      // The summary's run_config reports the PINNED values, not the snapshot's.
      const lines = readFileSync(join(tmp, 'out.jsonl'), 'utf8').split('\n').filter(l => l.trim());
      const summary = JSON.parse(lines[lines.length - 1]);
      expect(summary.kind).toBe('by_type_summary');
      expect(summary.run_config.reranker.enabled).toBe(false);
      expect(summary.run_config.autocut).toBe(false);
      expect(summary.run_config.expansion_variant_budget).toBe(0.5);
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('--reranker-fuse / --reranker-document land in the benchmark brain, the receipt and a distinct retrieval_config_hash', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-fuse-'));
    const run = async (name: string, extra: string[], snapshot: Record<string, string> = {}) => {
      const engine = await createBenchmarkBrain();
      try {
        await runEvalLongMemEval([FIXTURE_PATH, '--keyword-only', '--retrieval-only', '--no-trajectory', '--by-type', '--limit', '1', '--output', join(tmp, name), ...extra],
          { engine, searchConfigSnapshot: snapshot });
        const lines = readFileSync(join(tmp, name), 'utf8').split('\n').filter(l => l.trim());
        return { fuse: await engine.getConfig('search.reranker.fuse'), document: await engine.getConfig('search.reranker.document'), summary: JSON.parse(lines[lines.length - 1]) };
      } finally {
        await engine.disconnect();
      }
    };
    try {
      const base = await run('base.jsonl', []);
      const both = await run('both.jsonl', ['--reranker-fuse', 'rrf', '--reranker-document', 'titled'], { 'search.reranker.fuse': 'replace' });
      const fuse = await run('fuse.jsonl', ['--reranker-fuse', 'rrf']);
      expect([both.fuse, both.document]).toEqual(['rrf', 'titled']);
      expect(base.fuse).toBeNull();
      expect(base.summary.run_config.reranker_stage).toBeUndefined();
      expect(both.summary.run_config.reranker_stage).toEqual({ fuse: 'rrf', document: 'titled' });
      expect(new Set([base, both, fuse].map(r => r.summary.run_config.retrieval_config_hash)).size).toBe(3);
      await expect(runEvalLongMemEval([FIXTURE_PATH, '--reranker-fuse', 'borda'], { exitOnError: false })).rejects.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
