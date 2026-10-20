/**
 * GBRA-133 PR 3: the receipt of every repair an agent applied through MCP (`repair_apply`, `sync_unblock` with
 * `apply`), so who applied what stays on record and the next preview can reconcile what the last apply left pending.
 *
 * One capped log per source and incarnation in `op_checkpoints` (op `repair-agent-apply`, newest first, at most
 * `AGENT_APPLY_KEEP` entries), the same pattern as the sync conversion log. Each entry names the explicit actor
 * (`local_agent` over the stdio pipe, or the trusted CLI through `gbrain call`), the kind, the preview hash it was
 * bound to, the per-item outcomes and the write requests still pending when the apply returned. Codes, paths, hashes
 * and request ids only, never content or argv.
 *
 * `reconcileAgentApplies` runs before every new preview: it reads the pending requests of the source's recent
 * entries, waits a bounded time for them to turn terminal, records each terminal state on its entry and returns what
 * is still pending, which an apply refuses on (`write_pending`) so a new apply never races the last one.
 */
import type { BrainEngine } from '../engine.ts';
import { isTerminalWriteState } from '../persistence/types.ts';

export const AGENT_APPLY_OP = 'repair-agent-apply';
export const AGENT_APPLY_KEEP = 20;

/** Who applied: an agent on the local stdio pipe (its MCP session or client name when known), or the trusted CLI. */
export interface AgentApplyActor { kind: 'local_agent' | 'local_cli'; transport: 'stdio' | 'cli'; client: string | null }

export interface AgentApplyItem { item: string; outcome: string; reason?: string; request_id?: string }

export interface AgentApplyReceipt {
  receipt_id: string;
  at: string;
  op: 'repair_apply' | 'sync_unblock';
  kind: string;
  source_id: string;
  incarnation: string;
  /** The preview hash the apply was bound to. */
  expect: string;
  actor: AgentApplyActor;
  applied: number;
  skipped: number;
  failed: number;
  stopped: string | null;
  items: AgentApplyItem[];
  /** Write requests still pending when the apply returned; reconciliation moves each to `settled` once terminal. */
  pending: Array<{ item: string; request_id: string }>;
  settled: Array<{ item: string; request_id: string; state: string; error_code: string | null }>;
}

type Exec = Pick<BrainEngine, 'executeRaw'>;

async function readLog(engine: Exec, sourceId: string, incarnation: string): Promise<AgentApplyReceipt[]> {
  const [row] = await engine.executeRaw<{ entries: AgentApplyReceipt[] | null }>(
    "SELECT completed_keys->0->'entries' AS entries FROM op_checkpoints WHERE op=$1 AND fingerprint=$2", [AGENT_APPLY_OP, `${sourceId}:${incarnation}`]);
  return Array.isArray(row?.entries) ? row.entries : [];
}

async function writeLog(engine: Exec, sourceId: string, incarnation: string, entries: AgentApplyReceipt[]): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [AGENT_APPLY_OP, `${sourceId}:${incarnation}`, JSON.stringify([{ source_id: sourceId, incarnation, entries: entries.slice(0, AGENT_APPLY_KEEP) }])]);
}

/** Prepends one receipt to the source's log (bounded). */
export async function recordAgentApply(engine: Exec, receipt: AgentApplyReceipt): Promise<void> {
  await writeLog(engine, receipt.source_id, receipt.incarnation, [receipt, ...await readLog(engine, receipt.source_id, receipt.incarnation)]);
}

/** The source's receipts under its incarnation, newest first. */
export async function readAgentApplies(engine: Exec, sourceId: string, incarnation: string, limit = AGENT_APPLY_KEEP): Promise<AgentApplyReceipt[]> {
  return (await readLog(engine, sourceId, incarnation)).slice(0, limit);
}

export interface AgentApplyReconciliation {
  /** Requests that turned terminal during this reconciliation. */
  settled: Array<{ receipt_id: string; item: string; request_id: string; state: string; error_code: string | null }>;
  /** Requests still pending after the bounded wait. */
  pending: Array<{ receipt_id: string; item: string; request_id: string }>;
}

/** Settles what earlier applies left pending, waiting at most `budgetMs` for progress; writes the outcomes back. */
export async function reconcileAgentApplies(engine: Exec, sourceId: string, incarnation: string, budgetMs: number, now: () => number = Date.now): Promise<AgentApplyReconciliation> {
  const out: AgentApplyReconciliation = { settled: [], pending: [] };
  let entries = await readLog(engine, sourceId, incarnation);
  const open = () => entries.flatMap(entry => entry.pending.map(p => ({ receipt_id: entry.receipt_id, ...p })));
  if (!open().length) return out;
  const deadline = now() + budgetMs;
  let delay = 50;
  for (;;) {
    const waiting = open();
    const rows = await engine.executeRaw<{ request_id: string; state: string; error_code: string | null }>(
      `SELECT DISTINCT ON (request_id) request_id::text AS request_id, state, error_code FROM persistence_requests
       WHERE request_id=ANY($1::uuid[]) ORDER BY request_id, sequence DESC`, [waiting.map(p => p.request_id)]);
    const terminal = new Map(rows.filter(row => isTerminalWriteState(row.state as never)).map(row => [row.request_id, row]));
    if (terminal.size) {
      entries = entries.map(entry => {
        const done = entry.pending.filter(p => terminal.has(p.request_id));
        if (!done.length) return entry;
        const settled = done.map(p => ({ ...p, state: terminal.get(p.request_id)!.state, error_code: terminal.get(p.request_id)!.error_code }));
        out.settled.push(...settled.map(s => ({ receipt_id: entry.receipt_id, ...s })));
        return { ...entry, pending: entry.pending.filter(p => !terminal.has(p.request_id)), settled: [...entry.settled, ...settled] };
      });
      await writeLog(engine, sourceId, incarnation, entries);
    }
    if (!open().length || now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - now()))));
    delay = Math.min(delay * 2, 500);
  }
  out.pending = open();
  return out;
}
