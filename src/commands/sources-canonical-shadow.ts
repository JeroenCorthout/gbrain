/**
 * `gbrain sources canonical <source-id> --shadow on|off | --purge-shadow | --shadow-drain | --shadow-status`
 * (database-canonical memory, wave 2; contract: docs/designs/database-canonical-w2-contract.md).
 *
 * `--shadow on` starts the export outbox for one source: after it, every committed change to the source's pages and
 * withdrawals leaves an outbox row, and `--shadow-drain` turns those rows into shadow batches with their diff against
 * the files on disk. Nothing is exported and the checkout is never written. `--shadow off` stops new rows and keeps the
 * existing ones; only `--purge-shadow` (with shadow off) deletes them. Every state change is preview-bound: `--dry-run`
 * prints what would change and a fingerprint, and the apply needs `--admin-intent source_canonical --expected-state`.
 * Trusted local CLI only, not an MCP operation.
 */
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { DATABASE_CANONICAL_KEY, databaseCanonicalEnabled } from '../core/persistence/canonical-export.ts';
import { assertSourceCanonicalState, requireSourceCanonicalIntent, SOURCE_CANONICAL_INTENT, sourceCanonicalAdminState } from '../core/persistence/canonical-admin.ts';
import { lockExportWriters, readSourceCanonicalState, writeSourceShadow, type SourceCanonicalState } from '../core/persistence/canonical-shadow.ts';
import { drainExportShadow, readShadowStatus, seedExportLedger, type LedgerSeedReport, type ShadowBatchReport, type ShadowStatus } from '../core/persistence/canonical-shadow-consumer.ts';
import { censusSource, type CanonicalCensus } from './sources-canonical.ts';

const USAGE = 'Usage: gbrain sources canonical <source-id> (--shadow on|off | --purge-shadow) (--dry-run | --admin-intent source_canonical --expected-state <fingerprint>) [--json]\n'
  + '       gbrain sources canonical <source-id> --shadow-drain [--limit <n>] [--json]\n'
  + '       gbrain sources canonical <source-id> --shadow-status [--json]';
const DOCS = 'docs/designs/database-canonical-w2-contract.md';

/** The flags that route `gbrain sources canonical` here instead of the wave 1 census. */
export const SHADOW_ACTION_FLAGS = ['--shadow', '--purge-shadow', '--shadow-drain', '--shadow-status'] as const;

export type ShadowAction = 'shadow_on' | 'shadow_off' | 'purge_shadow' | 'drain' | 'status';

export interface ShadowArgs {
  sourceId: string;
  action: ShadowAction;
  dryRun: boolean;
  json: boolean;
  sample: number;
  limit: number;
  admin_intent?: string;
  expected_state?: string;
}

export function parseShadowArgs(args: string[]): ShadowArgs {
  const positional: string[] = [];
  const actions: ShadowAction[] = [];
  const parsed: Omit<ShadowArgs, 'sourceId' | 'action'> = { dryRun: false, json: false, sample: 20, limit: 200 };
  const value = (flag: string, raw: string | undefined) => {
    if (raw === undefined || raw.startsWith('--')) throw new OperationError('invalid_params', `${flag} needs a value.`, USAGE);
    return raw;
  };
  const count = (flag: string, raw: string, max: number) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new OperationError('invalid_params', `${flag} needs a whole number from 1 to ${max}; got ${raw}.`, USAGE);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--shadow') {
      const raw = value(arg, args[++i]);
      if (raw !== 'on' && raw !== 'off') throw new OperationError('invalid_params', `--shadow takes on or off; got ${raw}.`, USAGE);
      actions.push(raw === 'on' ? 'shadow_on' : 'shadow_off');
    } else if (arg === '--purge-shadow') actions.push('purge_shadow');
    else if (arg === '--shadow-drain') actions.push('drain');
    else if (arg === '--shadow-status') actions.push('status');
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--limit') parsed.limit = count(arg, value(arg, args[++i]), 5000);
    else if (arg === '--sample') parsed.sample = count(arg, value(arg, args[++i]), 1000);
    else if (arg === '--admin-intent') parsed.admin_intent = value(arg, args[++i]);
    else if (arg === '--expected-state') parsed.expected_state = value(arg, args[++i]);
    else if (arg.startsWith('-')) throw new OperationError('invalid_params', `Unknown sources canonical flag: ${arg}.`, USAGE);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources canonical needs exactly one source id.', USAGE);
  if (actions.length !== 1) throw new OperationError('invalid_params', 'Pass exactly one of --shadow on|off, --purge-shadow, --shadow-drain or --shadow-status.', USAGE);
  const action = actions[0]!;
  const changes = action === 'shadow_on' || action === 'shadow_off' || action === 'purge_shadow';
  if (!changes && (parsed.dryRun || parsed.admin_intent !== undefined || parsed.expected_state !== undefined)) {
    throw new OperationError('invalid_params', `--${action === 'drain' ? 'shadow-drain' : 'shadow-status'} takes no --dry-run, --admin-intent or --expected-state.`, USAGE);
  }
  if (changes && parsed.dryRun && (parsed.admin_intent !== undefined || parsed.expected_state !== undefined)) {
    throw new OperationError('invalid_params', 'A preview takes no --admin-intent or --expected-state; drop --dry-run to apply.', USAGE);
  }
  return { sourceId: positional[0]!, action, ...parsed };
}

function flagOf(action: 'shadow_on' | 'shadow_off' | 'purge_shadow'): string {
  return action === 'purge_shadow' ? '--purge-shadow' : `--shadow ${action === 'shadow_on' ? 'on' : 'off'}`;
}

function previewCommand(sourceId: string, action: 'shadow_on' | 'shadow_off' | 'purge_shadow'): string {
  return `gbrain sources canonical ${sourceId} ${flagOf(action)} --dry-run`;
}

async function requireGate(engine: BrainEngine, sourceId: string, retry: string): Promise<void> {
  if (await databaseCanonicalEnabled(engine)) return;
  throw new OperationError('database_canonical_disabled', 'Database-canonical mode is off for this brain, so a source cannot start a shadow export.',
    `Nothing changed. Turn the gate on with gbrain config set ${DATABASE_CANONICAL_KEY} true (by itself it changes no behavior), then rerun ${retry}.`, DOCS);
}

function shadowActive(sourceId: string): OperationError {
  return new OperationError('database_canonical_shadow_active', `Source ${sourceId} still has shadow on, so its outbox is still filling; nothing was purged.`,
    `Turn shadow off first: gbrain sources canonical ${sourceId} --shadow off --dry-run, apply it, then preview the purge again.`, DOCS);
}

export interface TriggerCost {
  pages_changed_last_day: number;
  pages_changed_last_week: number;
  /** The outbox coalesces to one row per page, so it never holds more rows than the source has pages. */
  outbox_ceiling: number;
  per_write: string;
  other_sources: string;
}

async function triggerCost(engine: BrainEngine, sourceId: string): Promise<TriggerCost> {
  const [row] = await engine.executeRaw<{ day: number; week: number; pages: number }>(`SELECT
      count(*) FILTER (WHERE updated_at > now() - interval '1 day')::int AS day, count(*) FILTER (WHERE updated_at > now() - interval '7 days')::int AS week,
      count(*)::int AS pages FROM pages WHERE source_id=$1`, [sourceId]);
  return { pages_changed_last_day: Number(row?.day ?? 0), pages_changed_last_week: Number(row?.week ?? 0), outbox_ceiling: Number(row?.pages ?? 0),
    per_write: 'each changed page row of this source: one brain-count read, one flag read and one outbox upsert in the writing transaction',
    other_sources: 'each changed page row of another source: one brain-count read and one flag read' };
}

export interface ShadowPreview {
  status: 'preview';
  action: 'shadow_on' | 'shadow_off' | 'purge_shadow';
  source_id: string;
  current: SourceCanonicalState | null;
  change: 'enable' | 'disable' | 'purge' | 'none';
  census?: CanonicalCensus;
  seed?: LedgerSeedReport;
  trigger_cost?: TriggerCost;
  purge?: { outbox: number; batches: number; diffs: number };
  expected_state: string;
  apply_command: string | null;
}

export interface ShadowApplied {
  status: 'applied' | 'unchanged';
  action: 'shadow_on' | 'shadow_off' | 'purge_shadow';
  source_id: string;
  state: SourceCanonicalState | null;
  seed?: LedgerSeedReport;
  purged?: { outbox: number; batches: number; diffs: number };
  next: string;
}

async function shadowRows(engine: BrainEngine, sourceId: string): Promise<{ outbox: number; batches: number; diffs: number }> {
  const [row] = await engine.executeRaw<{ outbox: number; batches: number; diffs: number }>(`SELECT
    (SELECT count(*) FROM export_outbox WHERE source_id=$1)::int AS outbox, (SELECT count(*) FROM export_shadow_batches WHERE source_id=$1)::int AS batches,
    (SELECT count(*) FROM export_shadow_diffs WHERE source_id=$1)::int AS diffs`, [sourceId]);
  return { outbox: Number(row!.outbox), batches: Number(row!.batches), diffs: Number(row!.diffs) };
}

export async function previewShadowChange(engine: BrainEngine, sourceId: string, action: 'shadow_on' | 'shadow_off' | 'purge_shadow', sample: number): Promise<ShadowPreview> {
  if (action === 'shadow_on') await requireGate(engine, sourceId, previewCommand(sourceId, action));
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const current = await readSourceCanonicalState(engine, sourceId);
  const expected_state = await sourceCanonicalAdminState(engine, sourceId, action);
  const apply = `gbrain sources canonical ${sourceId} ${flagOf(action)} --admin-intent ${SOURCE_CANONICAL_INTENT} --expected-state ${expected_state}`;
  const base = { status: 'preview' as const, action, source_id: sourceId, current, expected_state };
  if (action === 'shadow_on') {
    if (current?.shadow) return { ...base, change: 'none', apply_command: null };
    return { ...base, change: 'enable', census: await censusSource(engine, sourceId, sample), seed: await seedExportLedger(engine, sourceId, { apply: false }),
      trigger_cost: await triggerCost(engine, sourceId), apply_command: apply };
  }
  if (action === 'shadow_off') return { ...base, change: current?.shadow ? 'disable' : 'none', apply_command: current?.shadow ? apply : null };
  if (current?.shadow) throw shadowActive(sourceId);
  const purge = await shadowRows(engine, sourceId);
  return { ...base, change: purge.outbox + purge.batches + purge.diffs ? 'purge' : 'none', purge, apply_command: purge.outbox + purge.batches + purge.diffs ? apply : null };
}

export async function applyShadowChange(engine: BrainEngine, sourceId: string, action: 'shadow_on' | 'shadow_off' | 'purge_shadow',
  params: { admin_intent?: string; expected_state?: string }): Promise<ShadowApplied> {
  const preview = previewCommand(sourceId, action);
  if (action === 'shadow_on') await requireGate(engine, sourceId, preview);
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const expected = requireSourceCanonicalIntent(params, preview);
  await assertSourceCanonicalState(engine, sourceId, action, expected, preview);
  const current = await readSourceCanonicalState(engine, sourceId);
  if (action === 'purge_shadow') {
    if (current?.shadow) throw shadowActive(sourceId);
    const purged = await engine.transaction(async tx => {
      await tx.executeRaw('LOCK TABLE database_canonical_sources IN SHARE ROW EXCLUSIVE MODE');
      await assertSourceCanonicalState(tx, sourceId, action, expected, preview);
      const outbox = await tx.executeRaw('DELETE FROM export_outbox WHERE source_id=$1 RETURNING page_id', [sourceId]);
      const diffs = await tx.executeRaw('DELETE FROM export_shadow_diffs WHERE source_id=$1 RETURNING page_id', [sourceId]);
      const batches = await tx.executeRaw('DELETE FROM export_shadow_batches WHERE source_id=$1 RETURNING id', [sourceId]);
      return { outbox: outbox.length, batches: batches.length, diffs: diffs.length };
    });
    return { status: 'applied', action, source_id: sourceId, state: current, purged,
      next: `Purged the shadow rows of ${sourceId}; the export ledger is kept. Turn shadow on again with gbrain sources canonical ${sourceId} --shadow on --dry-run.` };
  }
  const on = action === 'shadow_on';
  if ((current?.shadow === true) === on) {
    return { status: 'unchanged', action, source_id: sourceId, state: current, next: `Shadow is already ${on ? 'on' : 'off'} for ${sourceId}; nothing changed.` };
  }
  const seed = on ? await seedExportLedger(engine, sourceId, { apply: true }) : undefined;
  const state = await engine.transaction(async tx => {
    await tx.executeRaw('LOCK TABLE database_canonical_sources IN SHARE ROW EXCLUSIVE MODE');
    await lockExportWriters(tx);
    await assertSourceCanonicalState(tx, sourceId, action, expected, preview);
    return writeSourceShadow(tx, sourceId, on);
  });
  return { status: 'applied', action, source_id: sourceId, state, ...(seed ? { seed } : {}),
    next: on ? `Shadow is on for ${sourceId}: page changes now fill its export outbox. Run gbrain sources canonical ${sourceId} --shadow-drain to record would-be batches, and gbrain doctor --only database_canonical_shadow to watch them.`
      : `Shadow is off for ${sourceId}: no new outbox rows. Existing rows stay until gbrain sources canonical ${sourceId} --purge-shadow --dry-run and its apply.` };
}

export async function drainShadow(engine: BrainEngine, sourceId: string, limit: number): Promise<ShadowBatchReport & { remaining: number }> {
  await requireGate(engine, sourceId, `gbrain sources canonical ${sourceId} --shadow-drain`);
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const report = await drainExportShadow(engine, sourceId, { limit });
  return { ...report, remaining: (await shadowRows(engine, sourceId)).outbox };
}

export async function shadowStatus(engine: BrainEngine, sourceId: string): Promise<ShadowStatus> {
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  return readShadowStatus(engine, sourceId);
}

const counts = (record: Record<string, number | undefined>) => Object.entries(record).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

function describePreview(p: ShadowPreview): string {
  const lines = [`Preview of ${flagOf(p.action)} for source ${p.source_id} (nothing changed). Shadow is ${p.current?.shadow ? 'on' : 'off'} now.`];
  if (p.change === 'none') lines.push('Nothing to change.');
  if (p.census) lines.push(`Census: ${p.census.pages} live page(s), ${p.census.eligible} eligible; files ${p.census.files ? counts(p.census.files) : 'not compared (no checkout)'}.`);
  if (p.seed) {
    lines.push(`Ledger seed from sync import provenance: ${p.seed.records} record(s), ${p.seed.seeded} to seed, ${p.seed.existing} already in the ledger; `
      + `no base: ${counts(p.seed.no_base)}; skipped: ${counts(p.seed.skipped)}. Coverage: ${counts(p.seed.coverage)}.`);
  }
  if (p.trigger_cost) {
    lines.push(`Expected trigger cost: ${p.trigger_cost.pages_changed_last_day} page(s) of this source changed in the last day (${p.trigger_cost.pages_changed_last_week} in 7 days); `
      + `${p.trigger_cost.per_write}. The outbox never exceeds ${p.trigger_cost.outbox_ceiling} row(s). Other sources: ${p.trigger_cost.other_sources}.`);
  }
  if (p.purge) lines.push(`Would delete: ${p.purge.outbox} outbox row(s), ${p.purge.batches} batch(es), ${p.purge.diffs} diff row(s). The export ledger is kept.`);
  lines.push(`Fingerprint: ${p.expected_state}`);
  if (p.apply_command) lines.push(`Apply: ${p.apply_command}`);
  return lines.join('\n');
}

function describeStatus(s: ShadowStatus): string {
  return [`Shadow of source ${s.source_id}: ${s.shadow ? 'on' : 'off'} (epoch ${s.shadow_epoch}).`,
    `Outbox: ${s.outbox.depth} row(s)${s.outbox.oldest_age_seconds === null ? '' : `, oldest ${s.outbox.oldest_age_seconds}s`}. Batches: ${s.batches.last_hour} in the last hour, ${s.batches.last_day} in the last day.`,
    `Latest diffs: ${counts(s.diffs)}. Unexpected: ${counts(s.unexpected)}.`,
    ...s.unexpected_sample.map(d => `  ${d.kind}: ${d.slug} (${d.path ?? 'no path'})`),
    `Ledger: ${s.ledger.live} live row(s) (${counts(s.ledger.by_origin)}); ${s.pages_without_base} live page(s) without a base.`].join('\n');
}

function describeDrain(r: ShadowBatchReport & { remaining: number }): string {
  if (!r.outbox_rows) return `The export outbox of ${r.source_id} is empty; nothing to drain.`;
  return [`Shadow batch ${r.batch_id} of ${r.source_id}: ${r.outbox_rows} outbox row(s), ${r.consumed} consumed, ${r.remaining} left. Diffs: ${counts(r.counts)}. Adopted ${r.adopted} file hash(es).`,
    ...r.unexpected.map(d => `  unexpected ${d.kind}: ${d.slug} (${d.path ?? 'no path'})`)].join('\n');
}

export async function runSourcesCanonicalShadow(engine: BrainEngine, args: string[]): Promise<{ text: string; json: unknown }> {
  const parsed = parseShadowArgs(args);
  const { sourceId, action } = parsed;
  if (action === 'status') { const s = await shadowStatus(engine, sourceId); return { text: describeStatus(s), json: { status: 'shadow_status', ...s } }; }
  if (action === 'drain') { const r = await drainShadow(engine, sourceId, parsed.limit); return { text: describeDrain(r), json: { status: 'shadow_batch', ...r } }; }
  if (parsed.dryRun) { const p = await previewShadowChange(engine, sourceId, action, parsed.sample); return { text: describePreview(p), json: p }; }
  const applied = await applyShadowChange(engine, sourceId, action, parsed);
  return { text: `${applied.status === 'applied' ? 'Applied' : 'Unchanged'}: ${flagOf(action)} for ${sourceId}. ${applied.next}`, json: applied };
}
