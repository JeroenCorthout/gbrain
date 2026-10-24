/**
 * Database-canonical memory, wave 5a: when the exporter runs (docs/designs/database-canonical-w5-contract.md). The resident
 * owner's consumer starts `runExportPass` beside its other workers: one tick per exporting source on this host, with an idle
 * fetch every `EXPORT_FETCH_INTERVAL_MS`. On PGLite with no resident, a one-shot command's shutdown makes one bounded
 * attempt (`runOneShotExport`) and records a typed outcome, so status shows a skip with its reason, never a stall.
 */
import type { BrainEngine } from '../engine.ts';
import { databaseCanonicalEnabled } from './canonical-export.ts';
import { listExportingSources, recordExportSource, type ExportOneshotOutcome } from './canonical-export-store.ts';
import { runExportTick, type ExportTickResult } from './exporter.ts';

export const EXPORT_FETCH_INTERVAL_MS = 60_000;
export const EXPORT_ONESHOT_DEADLINE_MS = 15_000;
/** How long a flip back to files spends draining the outbox through export batches before wave 4 keeps the rest as holds. */
export const EXPORT_FLIPBACK_DEADLINE_MS = 120_000;

const lastFetch = new Map<string, number>();

/** One pass over this host's exporting sources; never throws for one source's failure (the batch records it). */
export async function runExportPass(engine: BrainEngine, hostId: string, opts: { signal?: AbortSignal; now?: () => number } = {}): Promise<ExportTickResult[]> {
  if (!await databaseCanonicalEnabled(engine)) return [];
  const now = opts.now ?? Date.now;
  const results: ExportTickResult[] = [];
  for (const sourceId of await listExportingSources(engine)) {
    if (opts.signal?.aborted) break;
    const fetchIdle = now() - (lastFetch.get(sourceId) ?? -Infinity) >= EXPORT_FETCH_INTERVAL_MS;
    const result = await runExportTick(engine, sourceId, { hostId, signal: opts.signal, fetchIdle });
    if (fetchIdle && result.status === 'idle') lastFetch.set(sourceId, now());
    results.push(result);
  }
  return results;
}

/** The typed outcome of one one-shot tick, or null when it attempted nothing (idle, or not an exporting source). */
export function oneshotOutcome(result: ExportTickResult | 'deadline'): ExportOneshotOutcome | null {
  if (result === 'deadline') return 'skipped_deadline';
  switch (result.status) {
    case 'exported': return result.pushed ? 'exported' : 'skipped_no_remote';
    case 'idle': return null;
    case 'contended': return 'skipped_lock_busy';
    case 'failed': return result.code === 'commit_lock_busy' ? 'skipped_lock_busy' : 'skipped_failed';
    case 'skipped':
      if (result.reason === 'not_owner') return 'skipped_not_owner';
      if (['unbound', 'no_checkout', 'detached_head'].includes(result.reason)) return 'skipped_no_checkout';
      if (result.reason === 'held') return 'skipped_lock_busy';
      return null;
  }
}

/**
 * The PGLite one-shot attempt: after the command's write is acknowledged, one tick (one batch, one push try) per exporting
 * source, bounded by `deadlineMs` in total. Every failure is swallowed and recorded as a typed outcome; the outbox keeps
 * its rows for the next command or resident.
 */
export async function runOneShotExport(engine: BrainEngine, hostId: string, deadlineMs = EXPORT_ONESHOT_DEADLINE_MS): Promise<void> {
  try {
    if (engine.kind !== 'pglite' || !await databaseCanonicalEnabled(engine)) return;
    const signal = AbortSignal.timeout(deadlineMs);
    for (const sourceId of await listExportingSources(engine)) {
      const result: ExportTickResult | 'deadline' = signal.aborted ? 'deadline'
        : await runExportTick(engine, sourceId, { hostId, signal, lockWaitMs: 0 }).then(r => signal.aborted && r.status === 'failed' ? 'deadline' as const : r)
          .catch(() => signal.aborted ? 'deadline' as const : { status: 'failed', batch_id: '', code: 'export_failed', parked: false } as const);
      const outcome = oneshotOutcome(result);
      if (outcome) await recordExportSource(engine, sourceId, { oneshot_outcome: outcome }).catch(() => undefined);
    }
  } catch { /* best effort: never fails the command */ }
}
