/**
 * `gbrain sources canonical <id> --export-commits on|off` and `--export-retry` (database-canonical wave 5a,
 * docs/designs/database-canonical-w5-contract.md). Trusted local CLI only, and preview-bound: `--dry-run` prints what the
 * change would do and a fingerprint; the apply needs `--admin-intent source_canonical --expected-state <fingerprint>` and
 * refuses `preview_changed` when anything the fingerprint covers moved. Turning export commits on never converts anything:
 * the source exports only while it is in database mode, on its owner host, with the brain gate on.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { databaseCanonicalEnabled } from '../core/persistence/canonical-export.ts';
import { abandonBatchInTx, readExportBinding, readExportMode, readExportSource, readUnfinishedBatch, unparkBatch, writeExportSwitch } from '../core/persistence/canonical-export-store.ts';
import { exportOutboxStats } from '../core/persistence/canonical-shadow.ts';
import { digest } from '../core/persistence/digest.ts';
import { gitRun, readExportUpstream } from '../core/persistence/export-core.ts';
import { localHostId } from '../core/persistence/identity.ts';

const USAGE = [
  'gbrain sources canonical <id> --export-commits on|off (--dry-run | --admin-intent source_canonical --expected-state <fingerprint>) [--json]',
  'gbrain sources canonical <id> --export-retry (--dry-run | --admin-intent source_canonical --expected-state <fingerprint>) [--json]',
].join('\n');
const INTENT = 'source_canonical';

export interface ExportArgs { sourceId: string; verb: 'switch' | 'retry'; target?: 'on' | 'off'; dryRun: boolean; expectedState?: string; hostId?: string }

export function parseExportArgs(args: string[]): ExportArgs {
  const positional: string[] = [];
  let target: string | undefined, retry = false, dryRun = false, intent: string | undefined, expectedState: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--export-commits') { target = args[++i]; continue; }
    if (arg === '--export-retry') { retry = true; continue; }
    if (arg === '--admin-intent') { intent = args[++i]; continue; }
    if (arg === '--expected-state') { expectedState = args[++i]; continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, USAGE);
    positional.push(arg);
  }
  if (positional.length !== 1) throw opError('invalid_params', 'Name exactly one source.', USAGE);
  if (retry === (target !== undefined)) throw opError('invalid_params', 'Pass either --export-commits on|off or --export-retry.', USAGE);
  if (target !== undefined && target !== 'on' && target !== 'off') throw opError('invalid_params', '--export-commits takes on or off.', USAGE);
  if (!dryRun && (intent !== INTENT || !expectedState)) {
    throw opError('invalid_params', `Changing the export state needs --admin-intent ${INTENT} and the --expected-state a --dry-run printed.`, USAGE);
  }
  return { sourceId: positional[0]!, verb: retry ? 'retry' : 'switch', ...(target ? { target: target as 'on' | 'off' } : {}), dryRun, ...(expectedState ? { expectedState } : {}) };
}

export interface ExportSwitchReport {
  source_id: string; dry_run: boolean; verb: 'export_commits'; current: 'on' | 'off'; target: 'on' | 'off'; changed: boolean;
  mode: 'files' | 'database'; mode_epoch: number; export_epoch: number;
  binding: { worktree_id: string; owner_host_id: string | null; this_host_owns: boolean; local_path: string | null; checkout_present: boolean } | null;
  upstream: { branch: string; remote: string | null; merge_ref: string | null } | null;
  split_index: 'already' | 'will_set' | 'n/a'; filter_roots: string[]; shared_with: string[]; outbox_depth: number; unexported_pages: number;
  refusals: Array<{ code: string; detail: string }>; fingerprint: string; apply?: string[];
}

async function filterRoots(top: string, prefix: string, root: string): Promise<string[]> {
  const dirs = ['', ...readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => `${d.name}/`)];
  const probes = dirs.map(d => `${prefix}${d}gbrain-probe.md`);
  const result = await gitRun(top, ['check-attr', '-z', '--stdin', 'filter'], { input: probes.map(p => `${p}\0`).join('') });
  if (result.code !== 0) return [];
  const fields = result.stdout.toString('utf8').split('\0');
  const found: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) if (!['unspecified', 'unset', ''].includes(fields[i + 2]!)) found.push(dirs[probes.indexOf(fields[i]!)] || '/');
  return found;
}

async function switchReport(engine: BrainEngine, opts: ExportArgs): Promise<ExportSwitchReport> {
  const { sourceId } = opts;
  const hostId = opts.hostId ?? localHostId();
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean | null }>('SELECT incarnation::text, archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw opError('invalid_params', `No active source ${sourceId}.`, 'Name an active source; gbrain sources list prints them.');
  const mode = await readExportMode(engine, sourceId);
  const exp = await readExportSource(engine, sourceId);
  const binding = await readExportBinding(engine, sourceId, hostId);
  const current = exp?.export_commits ? 'on' : 'off';
  const target = opts.target!;
  const sourceRoot = binding?.local_path ? join(binding.local_path, ...binding.relative_path.split('/').filter(Boolean)) : null;
  const present = !!sourceRoot && existsSync(sourceRoot);
  let upstream: ExportSwitchReport['upstream'] = null, split: ExportSwitchReport['split_index'] = 'n/a', filters: string[] = [];
  if (present) {
    const root = realpathSync(sourceRoot!);
    const top = (await gitRun(root, ['rev-parse', '--show-toplevel'])).stdout.toString('utf8').trim();
    if (top) {
      const prefix = (await gitRun(root, ['rev-parse', '--show-prefix'])).stdout.toString('utf8').trim();
      const up = await readExportUpstream(top);
      upstream = up ? { branch: up.branch, remote: up.remote, merge_ref: up.mergeRef } : null;
      split = (await gitRun(top, ['config', '--get', 'core.splitIndex'])).stdout.toString('utf8').trim() === 'true' ? 'already' : 'will_set';
      filters = await filterRoots(top, prefix, root);
    }
  }
  const shared = binding ? (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid AND source_id<>$2 ORDER BY source_id',
    [binding.worktree_id, sourceId])).map(r => r.source_id) : [];
  const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL AND NOT EXISTS
    (SELECT 1 FROM export_ledger l WHERE l.source_id=p.source_id AND l.page_id=p.id AND l.retired_at IS NULL AND l.revision=p.knowledge_revision)`, [sourceId]);
  const refusals: ExportSwitchReport['refusals'] = [];
  if (target === 'on') {
    if (mode.mode !== 'database') refusals.push({ code: 'export_commits_requires_database_mode', detail: `source ${sourceId} is in ${mode.mode} mode` });
    if (!binding || !present) refusals.push({ code: 'export_target_missing', detail: binding ? `no checkout at ${sourceRoot ?? 'an unbound path'} on this host` : 'no worktree binding' });
    if (filters.length) refusals.push({ code: 'export_filter_driver', detail: `filter driver on ${filters.join(', ')}` });
    if (shared.length) refusals.push({ code: 'export_worktree_shared', detail: `shared with ${shared.join(', ')}` });
  }
  const facts = { sourceId, incarnation: source.incarnation, mode: mode.mode, mode_epoch: mode.mode_epoch, current, export_epoch: exp?.export_epoch ?? 0,
    worktree: binding?.worktree_id ?? null, topology: binding?.topology_generation ?? null, owner_epoch: binding?.owner_epoch ?? null, refusals };
  const fingerprint = digest(facts);
  return { source_id: sourceId, dry_run: opts.dryRun, verb: 'export_commits', current, target, changed: current !== target, mode: mode.mode, mode_epoch: mode.mode_epoch,
    export_epoch: exp?.export_epoch ?? 0,
    binding: binding ? { worktree_id: binding.worktree_id, owner_host_id: binding.owner_host_id, this_host_owns: binding.owner_host_id === hostId, local_path: binding.local_path,
      checkout_present: present } : null,
    upstream, split_index: split, filter_roots: filters, shared_with: shared, outbox_depth: (await exportOutboxStats(engine, sourceId)).depth, unexported_pages: Number(n),
    refusals, fingerprint };
}

const previewArgv = (o: ExportArgs) => ['gbrain', 'sources', 'canonical', o.sourceId, ...(o.verb === 'retry' ? ['--export-retry'] : ['--export-commits', o.target!]), '--dry-run', '--json'];
const applyArgv = (o: ExportArgs, fingerprint: string) => ['gbrain', 'sources', 'canonical', o.sourceId, ...(o.verb === 'retry' ? ['--export-retry'] : ['--export-commits', o.target!]),
  '--admin-intent', INTENT, '--expected-state', fingerprint];
const previewChanged = (o: ExportArgs) => opError('preview_changed', `The export state of source ${o.sourceId} changed since the preview; nothing changed.`,
  `Preview again with ${previewArgv(o).join(' ')} and apply the command it prints.`,
  { fix: { argv: previewArgv(o), consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current export state and the apply command for it; changes nothing.' } });

/** `--export-commits on|off`: preview, or apply bound to the preview's fingerprint. */
export async function setExportCommits(engine: BrainEngine, opts: ExportArgs): Promise<ExportSwitchReport> {
  if (!await databaseCanonicalEnabled(engine)) throw opError('database_canonical_disabled', 'Database-canonical mode is off for this brain; export commits cannot be changed.',
    'Turn the brain gate on first (persistence.database_canonical.enabled); see docs/designs/DATABASE_CANONICAL_MEMORY.md.');
  const report = await switchReport(engine, opts);
  if (opts.dryRun) return { ...report, apply: applyArgv(opts, report.fingerprint) };
  if (opts.expectedState !== report.fingerprint) throw previewChanged(opts);
  const refusal = report.refusals[0];
  if (refusal) throw opError(refusal.code as Parameters<typeof opError>[0], `Export commits stay off for source ${opts.sourceId}: ${refusal.detail}.`, 'Fix what the preview lists, then preview again.');
  if (!report.changed) throw opError('export_commits_unchanged', `Export commits are already ${report.current} for source ${opts.sourceId}; nothing changed.`, 'Nothing to do.');
  await engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [opts.sourceId]);
    const mode = await readExportMode(tx, opts.sourceId, true);
    const exp = await readExportSource(tx, opts.sourceId);
    if (mode.mode_epoch !== report.mode_epoch || (exp?.export_epoch ?? 0) !== report.export_epoch || (exp?.export_commits ? 'on' : 'off') !== report.current) throw previewChanged(opts);
    await writeExportSwitch(tx, opts.sourceId, opts.target === 'on');
    if (opts.target === 'off') {
      const [idle] = await tx.executeRaw<{ id: string }>(`SELECT id::text FROM export_batches WHERE source_id=$1 AND state IN ('prepared','built')
        AND (claim_token IS NULL OR claim_expires_at < now()) FOR UPDATE`, [opts.sourceId]);
      if (idle) await abandonBatchInTx(tx, idle.id, 'export_commits_off');
    }
  });
  return { ...report, dry_run: false, current: opts.target!, changed: true };
}

export interface ExportRetryReport { source_id: string; dry_run: boolean; verb: 'export_retry'; batch: { id: string; state: string; error_code: string | null; attempts: number; parked_at: string | null } | null;
  retried: boolean; fingerprint: string | null; apply?: string[] }

/** `--export-retry`: lists the parked batch; the apply clears its parking and attempts so the owner claims it again. */
export async function retryExport(engine: BrainEngine, opts: ExportArgs): Promise<ExportRetryReport> {
  const batch = await readUnfinishedBatch(engine, opts.sourceId);
  if (!batch?.parked_at) throw opError('export_retry_nothing_parked', `Source ${opts.sourceId} has no parked export batch; nothing to retry.`, `Nothing to do; gbrain sync status --source ${opts.sourceId} --json shows the exporter.`);
  const view = { id: batch.id, state: batch.state, error_code: batch.error_code, attempts: batch.attempts, parked_at: batch.parked_at };
  const fingerprint = digest(view);
  if (opts.dryRun) return { source_id: opts.sourceId, dry_run: true, verb: 'export_retry', batch: view, retried: false, fingerprint, apply: applyArgv(opts, fingerprint) };
  if (opts.expectedState !== fingerprint) throw previewChanged(opts);
  const retried = await engine.transaction(tx => unparkBatch(tx, batch.id));
  if (!retried) throw previewChanged(opts);
  return { source_id: opts.sourceId, dry_run: false, verb: 'export_retry', batch: view, retried, fingerprint };
}

function describe(r: ExportSwitchReport | ExportRetryReport): string {
  if (r.verb === 'export_retry') {
    const b = r.batch!;
    return r.dry_run ? `Parked export batch ${b.id} of ${r.source_id}: ${b.state}, ${b.error_code ?? 'no code'}, ${b.attempts} attempt(s), parked at ${b.parked_at}.\nApply: ${r.apply!.join(' ')}`
      : `Export batch ${b.id} of ${r.source_id} is unparked; its owner claims it on the next tick.`;
  }
  const lines = [`Source ${r.source_id}: export commits ${r.current}${r.dry_run ? `, would be ${r.target}` : ''} (${r.mode} mode, epoch ${r.mode_epoch}).`];
  if (r.binding) lines.push(`Worktree ${r.binding.worktree_id}, owner ${r.binding.this_host_owns ? 'this host' : r.binding.owner_host_id ?? 'none'}, checkout ${r.binding.checkout_present ? r.binding.local_path : 'not on this host'}.`);
  lines.push(r.upstream?.remote ? `Pushes ${r.upstream.branch} to ${r.upstream.remote} (${r.upstream.merge_ref}).` : 'No tracking remote: exports stay local commits.');
  if (r.split_index === 'will_set') lines.push('Sets core.splitIndex=true in the checkout before the first export commit.');
  lines.push(`Outbox depth ${r.outbox_depth}; ${r.unexported_pages} live page(s) without a ledger row at their revision.`);
  for (const refusal of r.refusals) lines.push(`Refused: ${refusal.code} (${refusal.detail}).`);
  if (r.apply && !r.refusals.length && r.changed) lines.push(`Apply: ${r.apply.join(' ')}`);
  return lines.join('\n');
}

export async function runSourcesCanonicalExport(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const opts = parseExportArgs(args);
    const result = opts.verb === 'retry' ? await retryExport(engine, opts) : await setExportCommits(engine, opts);
    console.log(json ? JSON.stringify(result) : describe(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}
