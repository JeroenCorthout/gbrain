/**
 * #6930: the vendored driver's shared array types and transaction pipelining ship in all three runtime copies
 * (ESM, CommonJS, workerd). The behaviour is proven on the ESM copy by test/pathological/pg-round-trips-6930.test.ts
 * and test/e2e/pgbouncer-transaction-pipeline-6930.test.ts; this pins that every copy carries the same patch.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('vendored Postgres driver #6930 patch', () => {
  test('all three shipped copies carry the shared array types and transaction pipelining (offline)', () => {
    for (const path of ['src', 'cjs/src', 'cf/src']) {
      const connection = readFileSync(new URL('../vendor/postgres/' + path + '/connection.js', import.meta.url), 'utf8');
      expect(connection).toContain('needsTypes && options.array_types && options.array_types.rows');
      expect(connection).toContain('options.array_types && (options.array_types.rows = types.map(');
      expect(connection).toMatch(/noteBudget\(q\)\n\s+noteTransaction\(q\)/);
      expect(connection).toMatch(/&& sent\.length < pipelineLimit\(\)\n\s+&& mayPipeline/);
      expect(connection).toContain('return transaction_pipeline > max_pipeline && inTransactionAfterSent && connection.reserved');
      const index = readFileSync(new URL('../vendor/postgres/' + path + '/index.js', import.meta.url), 'utf8');
      expect(index).toContain("'max_pipeline', 'transaction_pipeline', 'backoff'");
      expect(index).toContain('array_types     : o.array_types || null,');
    }
    const types = readFileSync(new URL('../vendor/postgres/types/index.d.ts', import.meta.url), 'utf8');
    expect(types).toContain('transaction_pipeline: number;');
    expect(types).toContain('array_types: { rows: Array<[number, number]> | null } | null;');
  });
});
