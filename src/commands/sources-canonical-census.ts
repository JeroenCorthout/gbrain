/**
 * `gbrain sources canonical <source-id> --census` (database-canonical memory, wave 3): what the observe-mode import lane
 * recorded for one source. The would-be conflicts a conversion would adopt, by kind, how many two-sided ones a base-aware
 * merge would have resolved, and the writers still committing page files (grouped by author and process hint) that would
 * need moving to put_page. Read-only.
 *
 * `--observe` runs one lane pass (`--watch` keeps the lane running with a file watch and a polling fallback until the
 * source's shadow flag turns off or the process is stopped). The lane writes only its own tables (import_conflicts,
 * import_foreign_writes, import_lane_passes): no page, ledger row or checkout file changes.
 *
 * Both refuse while the brain gate is off; `--observe` also refuses while the source's shadow flag is off. Trusted local
 * CLI only, not an MCP operation; the output names paths and commit authors.
 */
import { existsSync, realpathSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { DATABASE_CANONICAL_KEY, databaseCanonicalEnabled } from '../core/persistence/canonical-export.ts';
import { readSourceCanonicalState } from '../core/persistence/canonical-shadow.ts';
import { readImportCensus, type ImportCensus } from '../core/persistence/import-census.ts';
import { observeImportLane, type ObservePassResult } from '../core/persistence/import-lane.ts';
import { watchImportLane } from '../core/persistence/import-lane-watch.ts';

const USAGE = 'Usage: gbrain sources canonical <source-id> --census [--sample <n>] [--json] | --observe [--watch] [--json]';
const DOCS = 'docs/designs/DATABASE_CANONICAL_MEMORY.md';

export interface CensusArgs { sourceId: string; action: 'census' | 'observe'; watch: boolean; json: boolean; sample: number }

export function parseCensusArgs(args: string[]): CensusArgs {
  const positional: string[] = [];
  let sample = 10;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--sample') {
      const raw = args[++i];
      sample = Number(raw);
      if (raw === undefined || !Number.isInteger(sample) || sample < 0 || sample > 1000) {
        throw new OperationError('invalid_params', `--sample needs a whole number from 0 to 1000; got ${raw ?? 'nothing'}.`, USAGE);
      }
      continue;
    }
    if (arg.startsWith('-')) {
      if (!['--census', '--observe', '--watch', '--json'].includes(arg)) throw new OperationError('invalid_params', `Unknown sources canonical flag: ${arg}.`, USAGE);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources canonical needs exactly one source id.', USAGE);
  const census = args.includes('--census'), observe = args.includes('--observe');
  if (census === observe) throw new OperationError('invalid_params', 'Pass exactly one of --census or --observe.', USAGE);
  if (args.includes('--watch') && !observe) throw new OperationError('invalid_params', '--watch goes with --observe.', USAGE);
  return { sourceId: positional[0]!, action: census ? 'census' : 'observe', watch: args.includes('--watch'), json: args.includes('--json'), sample };
}

async function requireGate(engine: BrainEngine, retry: string): Promise<void> {
  if (await databaseCanonicalEnabled(engine)) return;
  throw new OperationError('database_canonical_disabled', 'Database-canonical mode is off for this brain, so the import lane does not run.',
    `Nothing changed. Turn the gate on with gbrain config set ${DATABASE_CANONICAL_KEY} true (by itself it changes no behavior), then rerun ${retry}.`, DOCS);
}

export interface CensusReport extends ImportCensus {
  status: 'census';
  shadow: boolean;
  shadow_epoch: number | null;
  next: string;
}

export async function censusImportLane(engine: BrainEngine, sourceId: string, sample: number): Promise<CensusReport> {
  await requireGate(engine, `gbrain sources canonical ${sourceId} --census`);
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const state = await readSourceCanonicalState(engine, sourceId);
  const census = await readImportCensus(engine, sourceId, sample);
  const moving = census.writers.filter(w => !w.gbrain_owned);
  const next = !state?.shadow ? `Shadow is off for ${sourceId}, so the import lane is not running and these rows are inert. Turn it on with gbrain sources canonical ${sourceId} --shadow on.`
    : !census.last_pass ? `The lane has not run for ${sourceId} yet. Run gbrain sources canonical ${sourceId} --observe (one pass, writes only the lane's own tables).`
    : moving.length ? `Nothing changed. ${moving.length} writer(s) still commit page files; move each to put_page (or remember) before converting ${sourceId}.`
    : `Nothing changed. No writer other than gbrain's own Git effect commits page files of ${sourceId}.`;
  return { status: 'census', shadow: state?.shadow ?? false, shadow_epoch: state?.shadow_epoch ?? null, ...census, next };
}

export async function observeOnce(engine: BrainEngine, sourceId: string): Promise<ObservePassResult> {
  await requireGate(engine, `gbrain sources canonical ${sourceId} --observe`);
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const result = await observeImportLane(engine, sourceId);
  if (result.status === 'skipped' && result.reason === 'shadow_off') {
    throw new OperationError('import_lane_shadow_off', `Shadow is off for source ${sourceId}, so the import lane does not observe it.`,
      `Nothing changed. Turn shadow on with gbrain sources canonical ${sourceId} --shadow on, then rerun gbrain sources canonical ${sourceId} --observe.`, DOCS);
  }
  return result;
}

function counts(record: Record<string, number | undefined>): string {
  return Object.entries(record).filter(([, n]) => (n ?? 0) > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
}

function describeCensus(report: CensusReport): string {
  const lines = [`Import lane census of source ${report.source_id} (read-only; shadow ${report.shadow ? `on, epoch ${report.shadow_epoch}` : 'off'}).`];
  lines.push(report.last_pass ? `Last pass ${report.last_pass.finished_at}: ${report.last_pass.scanned} path(s) scanned, ${report.last_pass.unstable} deferred as unstable, ${report.last_pass.commits} commit(s) read.`
    : 'No lane pass yet.');
  lines.push(`Would-have outcomes of open outside changes: ${counts(report.outcomes)}.`);
  if (report.conflicts.length) lines.push('Conflicts a conversion would adopt:');
  for (const c of report.conflicts) {
    lines.push(`  ${c.kind}: ${c.count} (oldest ${c.oldest_observed_at})`);
    for (const s of c.sample) lines.push(`    ${s.path}${s.reason ? ` (${s.reason})` : ''}`);
  }
  if (report.merge.two_sided) lines.push(`Two-sided changes: ${report.merge.two_sided}; a base-aware field merge would have resolved ${report.merge.resolvable}, ${report.merge.no_base} had no base to merge from.`);
  const moving = report.writers.filter(w => !w.gbrain_owned);
  lines.push(moving.length ? 'Writers that would need moving to put_page:' : 'No writer other than gbrain\'s own Git effect commits page files.');
  for (const w of moving) lines.push(`  ${w.author_name ?? 'unknown'} <${w.author_email ?? 'unknown'}>${w.process_hint ? ` [${w.process_hint}]` : ''}: ${w.commits} commit(s), ${w.paths} path(s), ${w.commits_7d} in the last 7 days, last ${w.last_committed_at ?? 'unknown'}`);
  if (report.uncommitted.changes) lines.push(`Uncommitted worktree edits: ${report.uncommitted.changes} change(s) across ${report.uncommitted.paths} path(s).`);
  lines.push(report.next);
  return lines.join('\n');
}

function describePass(result: ObservePassResult): string {
  if (result.status === 'skipped') return `Import lane pass skipped for ${result.source_id} (${result.reason}); nothing was recorded.`;
  return `Import lane pass ${result.pass_id} observed ${result.source_id} (epoch ${result.shadow_epoch}): ${result.scanned} path(s) scanned, ${result.unstable} deferred as unstable, `
    + `${result.commits} commit(s) read. Would-have outcomes: ${counts(result.outcomes)}. Nothing outside the lane's own tables was written.`;
}

export async function runSourcesCanonicalCensus(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const parsed = parseCensusArgs(args);
    if (parsed.action === 'census') {
      const report = await censusImportLane(engine, parsed.sourceId, parsed.sample);
      console.log(json ? JSON.stringify(report) : describeCensus(report));
      return;
    }
    const first = await observeOnce(engine, parsed.sourceId);
    console.log(json ? JSON.stringify(first) : describePass(first));
    if (!parsed.watch || first.status === 'skipped') return;
    const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [parsed.sourceId]);
    if (!source?.local_path || !existsSync(source.local_path)) return;
    const lane = watchImportLane(engine, parsed.sourceId, realpathSync(source.local_path), { onPass: r => console.log(json ? JSON.stringify(r) : describePass(r)) });
    const interrupt = () => lane.stop();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try { await lane.done; } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(1);
  }
}
