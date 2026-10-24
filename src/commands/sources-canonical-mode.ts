/**
 * `gbrain sources canonical <id> --to database|files` (database-canonical memory, wave 4; the contract in
 * docs/designs/database-canonical-w4-contract.md): flips one source's mode. Trusted local CLI only (no MCP operation);
 * refuses `database_canonical_disabled` while the brain gate is off. Every flip is preview-bound: `--dry-run` prints
 * the evidence and its fingerprint, and the apply carries `--admin-intent source_canonical --expected-state <fingerprint>`
 * and refuses `preview_changed` when anything the preview showed moved.
 *
 * `--to database` only for a provably empty source (`canonical_source_not_empty` names each failed condition).
 * `--to files` keeps every live page written in database mode as an explicit database-ahead `file_drift` hold, the
 * record `gbrain repair file-drift` materializes; single-batch materialization arrives with the committing exporter.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from '../core/spawn.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { isSyncable } from '../core/sync.ts';
import { DATABASE_CANONICAL_KEY, databaseCanonicalEnabled } from '../core/persistence/canonical-export.ts';
import { DATABASE_CANONICAL_DOCS, inflightWork, lockCanonicalWriters, readSourceMode, type CanonicalMode } from '../core/persistence/canonical-mode.ts';
import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { localHostId } from '../core/persistence/identity.ts';
import { countGitHolds, FILE_DRIFT_VERSION, writeGitHold } from '../core/persistence/sync-holds.ts';
import { RECOVERY_VERSION } from '../core/markdown.ts';
import { isConnectorSourceKind } from '../core/persistence/connector-identity.ts';
import { refreshManagedFilesystemRoots } from '../core/persistence/filesystem-guard.ts';
import type { SqlEngine } from '../core/persistence/model.ts';
import { requireSourceCanonicalIntent, SOURCE_CANONICAL_INTENT } from '../core/persistence/canonical-admin.ts';

const USAGE = 'Usage: gbrain sources canonical <source-id> --to database|files (--dry-run | --admin-intent source_canonical --expected-state <fingerprint>) [--json]';

export interface ModeFlipArgs { sourceId: string; to: CanonicalMode; dryRun: boolean; expectedState?: string; json: boolean }

export function parseModeFlipArgs(args: string[]): ModeFlipArgs {
  const positional: string[] = [];
  let to: string | undefined, intent: string | undefined, expectedState: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--to') { to = args[++i]; continue; }
    if (arg === '--admin-intent') { intent = args[++i]; continue; }
    if (arg === '--expected-state') { expectedState = args[++i]; continue; }
    if (arg === '--dry-run' || arg === '--json') continue;
    if (arg.startsWith('-')) throw new OperationError('invalid_params', `Unknown sources canonical flag: ${arg}.`, USAGE);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources canonical needs exactly one source id.', USAGE);
  if (to !== 'database' && to !== 'files') throw new OperationError('invalid_params', `--to needs database or files; got ${to ?? 'nothing'}.`, USAGE);
  const dryRun = args.includes('--dry-run');
  if (dryRun) return { sourceId: positional[0]!, to, dryRun, json: args.includes('--json') };
  const expected = requireSourceCanonicalIntent({ admin_intent: intent, expected_state: expectedState }, `gbrain sources canonical ${positional[0]} --to ${to} --dry-run`);
  return { sourceId: positional[0]!, to, dryRun, expectedState: expected, json: args.includes('--json') };
}

/** What the preview shows; the fingerprint is SHA-256 over all of it. */
export interface ModeFlipEvidence {
  source_id: string;
  incarnation: string;
  to: CanonicalMode;
  mode: CanonicalMode;
  mode_epoch: number;
  shadow: boolean;
  shadow_epoch: number;
  eligibility_generation: number;
  live_pages: number;
  holds: { git: number; import_conflicts: number };
  tracked_page_files: number | null;
  worktree_state: string | null;
  inflight: { requests: number; effects: number; old_processes: number; export_batches: number };
  /**
   * Digest of the columns whose change enqueues an export outbox row (each page's id, revision, slug, live or deleted
   * state and database-only reason, and every withdrawal and purge row of the source), read from the rows themselves,
   * so draining the outbox does not move it and a write to another source does not either.
   */
  content: string;
}
export type FlipRefusalCode = 'canonical_mode_unchanged' | 'canonical_inflight_work' | 'canonical_requires_managed' | 'canonical_source_not_empty';
export interface ModeFlipPreview extends ModeFlipEvidence { fingerprint: string; refusals: Array<{ code: FlipRefusalCode; condition: string; detail: string }>; apply: string[] | null; holds_to_write?: number;
  /** Database-canonical wave 5a: with export commits on, the apply first drains this many outbox pages through export batches on the owner host. */
  export_drain?: { export_commits: boolean; pending: number } }

const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readEvidence(exec: SqlEngine, sourceId: string, to: CanonicalMode): Promise<{ evidence: ModeFlipEvidence; kind: string | null; managed: boolean; bound: boolean }> {
  const [source] = await exec.executeRaw<{ incarnation: string; kind: string | null }>("SELECT incarnation::text AS incarnation, config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source) throw new OperationError('invalid_params', `No source ${sourceId}.`, 'Name an active source; gbrain sources list prints them.');
  const [state, [counts], [binding], inflight, git, managed] = await Promise.all([
    readSourceMode(exec, sourceId),
    exec.executeRaw<{ live: number; content: string; withdrawals: string }>(`SELECT
        (SELECT count(*)::int FROM pages WHERE source_id=$1 AND deleted_at IS NULL) AS live,
        (SELECT md5(COALESCE(string_agg(concat_ws(':', id, knowledge_revision, slug, deleted_at IS NULL, database_only_reason), ',' ORDER BY id),'')) FROM pages WHERE source_id=$1) AS content,
        (SELECT md5(COALESCE(string_agg(w, ',' ORDER BY w),'')) FROM (
          SELECT 'w:'||r::text AS w FROM fact_withdrawals r WHERE source_id=$1
          UNION ALL SELECT 'p:'||r::text FROM fact_purges r WHERE source_id=$1) t) AS withdrawals`, [sourceId]),
    exec.executeRaw<{ state: string; local_path: string | null; relative_path: string }>(`SELECT w.state, h.local_path, b.relative_path FROM persistence_source_bindings b
        JOIN persistence_worktrees w ON w.id=b.worktree_id LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$2::uuid
        WHERE b.source_id=$1`, [sourceId, localHostId()]),
    inflightWork(exec, sourceId),
    countGitHolds(exec, sourceId, source.incarnation),
    managedPersistenceEnabled(exec),
  ]);
  const [conflicts] = await exec.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM import_conflicts WHERE source_id=$1 AND state='open'", [sourceId]);
  const checkout = binding?.local_path ? join(binding.local_path, binding.relative_path) : null;
  return { kind: source.kind, managed, bound: !!binding, evidence: {
    source_id: sourceId, incarnation: source.incarnation, to, mode: state.mode, mode_epoch: state.mode_epoch, shadow: state.shadow, shadow_epoch: state.shadow_epoch,
    eligibility_generation: state.eligibility_generation, live_pages: Number(counts!.live), holds: { git, import_conflicts: Number(conflicts!.n) },
    tracked_page_files: checkout && existsSync(checkout) ? trackedPageFiles(checkout) : null, worktree_state: binding?.state ?? null, inflight,
    content: digestOf([counts!.content, counts!.withdrawals]) } };
}

/** Tracked files under the source root that sync would import as pages (`ls-files` with no pathspec magic). */
function trackedPageFiles(root: string): number | null {
  let out: string;
  try {
    out = execFileSync('git', ['-C', root, '--literal-pathspecs', 'ls-files', '-z', '--cached', '--', '.'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // A source root that is not a Git checkout tracks nothing.
    if (/not a git repository/.test(String((error as { stderr?: unknown }).stderr ?? ''))) return null;
    throw error;
  }
  return out.split('\0').filter(path => path && isSyncable(path)).length;
}

function refusalsFor(evidence: ModeFlipEvidence, context: { kind: string | null; managed: boolean; bound: boolean }): ModeFlipPreview['refusals'] {
  const refusals: ModeFlipPreview['refusals'] = [];
  if (evidence.mode === evidence.to) refusals.push({ code: 'canonical_mode_unchanged', condition: 'mode', detail: `the source is already in ${evidence.to} mode` });
  const { requests, effects, old_processes, export_batches } = evidence.inflight;
  if (requests) refusals.push({ code: 'canonical_inflight_work', condition: 'requests', detail: `${requests} unfinished write request(s) or recovery record(s)` });
  if (effects) refusals.push({ code: 'canonical_inflight_work', condition: 'effects', detail: `${effects} unfinished or retryable effect(s)` });
  if (export_batches) refusals.push({ code: 'canonical_inflight_work', condition: 'export_batches', detail: `${export_batches} unfinished export batch(es) (gbrain sync status --source ${evidence.source_id} names a parked one and its retry command)` });
  if (old_processes) refusals.push({ code: 'canonical_inflight_work', condition: 'old_processes', detail: `${old_processes} live gbrain process(es) that do not speak the canonical protocol` });
  if (evidence.to === 'files') return refusals;
  if (!context.managed || !context.bound) refusals.push({ code: 'canonical_requires_managed', condition: 'managed', detail: 'managed persistence is not active for this source (no worktree binding)' });
  if (isConnectorSourceKind(context.kind)) refusals.push({ code: 'canonical_requires_managed', condition: 'connector', detail: `a ${context.kind} connector source writes through its connector, not as a database-canonical source` });
  if (evidence.live_pages) refusals.push({ code: 'canonical_source_not_empty', condition: 'live_pages', detail: `${evidence.live_pages} live page(s)` });
  if (evidence.holds.git) refusals.push({ code: 'canonical_source_not_empty', condition: 'git_holds', detail: `${evidence.holds.git} sync hold(s)` });
  if (evidence.holds.import_conflicts) refusals.push({ code: 'canonical_source_not_empty', condition: 'import_conflicts', detail: `${evidence.holds.import_conflicts} open import conflict(s)` });
  if (evidence.tracked_page_files) refusals.push({ code: 'canonical_source_not_empty', condition: 'tracked_page_files', detail: `${evidence.tracked_page_files} tracked page file(s) in the checkout` });
  if (evidence.worktree_state && evidence.worktree_state !== 'active') refusals.push({ code: 'canonical_source_not_empty', condition: 'transfer', detail: `the worktree is ${evidence.worktree_state} (a prepared transfer or recovery)` });
  return refusals;
}

async function unmaterializedPages(exec: SqlEngine, sourceId: string): Promise<Array<{ id: number; slug: string; source_path: string | null; revision: string }>> {
  // No export ledger row at the page's revision means no file holds it; in this wave the exporter writes none.
  return exec.executeRaw(`SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision FROM pages p
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM export_ledger l WHERE l.source_id=p.source_id AND l.page_id=p.id
        AND l.revision=p.knowledge_revision AND l.retired_at IS NULL) ORDER BY p.slug`, [sourceId]);
}

async function preview(exec: SqlEngine, sourceId: string, to: CanonicalMode): Promise<ModeFlipPreview> {
  const read = await readEvidence(exec, sourceId, to);
  const fingerprint = digestOf(read.evidence);
  const refusals = refusalsFor(read.evidence, read);
  const holds = to === 'files' && read.evidence.mode === 'database' ? (await unmaterializedPages(exec, sourceId)).length : undefined;
  const drain = holds !== undefined ? await exportDrainPreview(exec, sourceId) : undefined;
  return { ...read.evidence, fingerprint, refusals, ...(holds !== undefined ? { holds_to_write: holds } : {}), ...(drain ? { export_drain: drain } : {}),
    apply: refusals.length ? null : ['gbrain', 'sources', 'canonical', sourceId, '--to', to, '--admin-intent', SOURCE_CANONICAL_INTENT, '--expected-state', fingerprint] };
}

function refusalError(sourceId: string, to: CanonicalMode, refusals: ModeFlipPreview['refusals']): OperationError {
  const code = refusals[0]!.code;
  const error = opError(code, `Source ${sourceId} cannot move to ${to} mode: ${refusals.map(r => r.detail).join('; ')}.`,
    code === 'canonical_inflight_work' ? 'Nothing changed. Wait for the work to finish (gbrain sources writer status names it), then preview again.'
      : code === 'canonical_mode_unchanged' ? 'Nothing changed.'
        : `Nothing changed. Only a provably empty, managed source moves to database mode in this release; converting a source with pages arrives later (${DATABASE_CANONICAL_DOCS}).`);
  error.docs = DATABASE_CANONICAL_DOCS;
  error.detail = JSON.stringify({ conditions: refusals.map(r => r.condition) });
  return error;
}

export interface ModeFlipResult { status: 'preview' | 'flipped'; source_id: string; mode: CanonicalMode; mode_epoch: number; preview?: ModeFlipPreview; holds_written?: number }

async function exportDrainPreview(exec: SqlEngine, sourceId: string): Promise<{ export_commits: boolean; pending: number }> {
  const [row] = await exec.executeRaw<{ export_commits: boolean | null; pending: number }>(`SELECT (SELECT export_commits FROM canonical_export_sources WHERE source_id=$1) AS export_commits,
      (SELECT count(*)::int FROM export_outbox WHERE source_id=$1) AS pending`, [sourceId]);
  return { export_commits: !!row?.export_commits, pending: Number(row?.pending ?? 0) };
}

/**
 * Database-canonical wave 5a (docs/designs/database-canonical-w5-contract.md, "Flip-back materialization"): with export
 * commits on, the flip back first drains the outbox through ordinary export batches, bounded by EXPORT_FLIPBACK_DEADLINE_MS,
 * so the transaction below finds ledger rows for what the batches committed and keeps holds only for the rest. A host that
 * is not the owner gets a skipped tick and wave 4's barrier unchanged. No page row moves, so the fingerprint holds.
 */
async function drainExportBeforeFlipBack(engine: BrainEngine, sourceId: string, hostId: string): Promise<void> {
  if (!(await exportDrainPreview(engine, sourceId)).export_commits) return;
  const [{ runExportTick }, { EXPORT_FLIPBACK_DEADLINE_MS }] = await Promise.all([import('../core/persistence/exporter.ts'), import('../core/persistence/export-runner.ts')]);
  const deadline = Date.now() + EXPORT_FLIPBACK_DEADLINE_MS;
  while (Date.now() < deadline) {
    const tick = await runExportTick(engine, sourceId, { hostId, lockWaitMs: 5000 });
    if (tick.status !== 'exported') return;
  }
}

export async function flipSourceMode(engine: BrainEngine, args: ModeFlipArgs, hooks: { afterPreview?: () => Promise<void>; exportHostId?: string } = {}): Promise<ModeFlipResult> {
  if (!await databaseCanonicalEnabled(engine)) {
    throw new OperationError('database_canonical_disabled', 'Database-canonical mode is off for this brain, so no source can change mode.',
      `Nothing changed. Turn the gate on with gbrain config set ${DATABASE_CANONICAL_KEY} true (by itself it changes no behavior), then preview again.`, DATABASE_CANONICAL_DOCS);
  }
  await resolveSourceId(engine, args.sourceId, undefined, { skipLocalSignals: true });
  if (args.dryRun) {
    const shown = await preview(engine, args.sourceId, args.to);
    return { status: 'preview', source_id: args.sourceId, mode: shown.mode, mode_epoch: shown.mode_epoch, preview: shown };
  }
  await hooks.afterPreview?.();
  if (args.to === 'files') await drainExportBeforeFlipBack(engine, args.sourceId, hooks.exportHostId ?? localHostId());
  const result = await engine.transaction(async tx => {
    await declareDurablePersistence(tx, '5000ms', '30000ms');
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [args.sourceId]);
    // After the source row: writers already past their fence commit first, later ones wait and then see the new mode.
    await lockCanonicalWriters(tx);
    const current = await preview(tx, args.sourceId, args.to);
    if (current.fingerprint !== args.expectedState) {
      throw opError('preview_changed', `Source ${args.sourceId} changed since the preview (fingerprint ${args.expectedState}); nothing changed.`,
        `Preview again with gbrain sources canonical ${args.sourceId} --to ${args.to} --dry-run and apply the command it prints.`,
        { fix: { argv: ['gbrain', 'sources', 'canonical', args.sourceId, '--to', args.to, '--dry-run', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Shows the current evidence and the apply command bound to it; changes nothing.' } });
    }
    if (current.refusals.length) throw refusalError(args.sourceId, args.to, current.refusals);
    let holds = 0;
    if (args.to === 'files') {
      const observedAt = new Date().toISOString();
      for (const page of await unmaterializedPages(tx, args.sourceId)) {
        const path = page.source_path ?? `${page.slug}.md`;
        await writeGitHold(tx, { source_id: args.sourceId, incarnation: current.incarnation, path, source_path: path, slug: page.slug, page_id: Number(page.id),
          code: 'file_drift', upstream_version: null, observed_at: observedAt, run_id: null, mode: 'managed',
          message: `${path}: page ${page.slug} was written in database mode and no file holds its current revision, so it was kept as a database-ahead hold when the source returned to files.`,
          meta: { recovery_version: RECOVERY_VERSION, sides: 'database', drift_version: FILE_DRIFT_VERSION, page_revision: page.revision } });
        holds++;
      }
    }
    const [row] = await tx.executeRaw<{ mode: CanonicalMode; mode_epoch: string }>(`INSERT INTO database_canonical_sources(source_id, source_incarnation, shadow, shadow_epoch, mode, mode_epoch, mode_changed_at, eligibility_generation)
        SELECT id, incarnation, $2 = 'database', CASE WHEN $2 = 'database' THEN 1 ELSE 0 END, $2, 1, now(), 1 FROM sources WHERE id=$1
      ON CONFLICT (source_id) DO UPDATE SET mode=EXCLUDED.mode, mode_epoch=database_canonical_sources.mode_epoch+1, mode_changed_at=now(),
        eligibility_generation=database_canonical_sources.eligibility_generation+1,
        shadow=database_canonical_sources.shadow OR EXCLUDED.mode='database',
        shadow_epoch=database_canonical_sources.shadow_epoch + CASE WHEN EXCLUDED.mode='database' AND NOT database_canonical_sources.shadow THEN 1 ELSE 0 END,
        shadow_changed_at=CASE WHEN EXCLUDED.mode='database' AND NOT database_canonical_sources.shadow THEN now() ELSE database_canonical_sources.shadow_changed_at END
      RETURNING mode, mode_epoch::text AS mode_epoch`, [args.sourceId, args.to]);
    return { status: 'flipped' as const, source_id: args.sourceId, mode: row!.mode, mode_epoch: Number(row!.mode_epoch), ...(args.to === 'files' ? { holds_written: holds } : {}) };
  });
  await refreshManagedFilesystemRoots(engine).catch(() => undefined);
  return result;
}

function describe(result: ModeFlipResult): string {
  if (result.status === 'flipped') return `Source ${result.source_id} is now in ${result.mode} mode (mode epoch ${result.mode_epoch}).${result.holds_written ? ` ${result.holds_written} page(s) written in database mode are kept as file_drift holds; gbrain repair file-drift --held --source ${result.source_id} lists and materializes them.` : ''}`;
  const p = result.preview!;
  const lines = [`Source ${p.source_id}: ${p.mode} mode (epoch ${p.mode_epoch}), shadow ${p.shadow ? 'on' : 'off'}; preview of --to ${p.to}.`,
    `Live pages ${p.live_pages}, sync holds ${p.holds.git}, open import conflicts ${p.holds.import_conflicts}, tracked page files ${p.tracked_page_files ?? 'no checkout on this host'}, worktree ${p.worktree_state ?? 'unbound'}.`,
    `In flight: ${p.inflight.requests} request(s), ${p.inflight.effects} effect(s), ${p.inflight.old_processes} old-protocol process(es), ${p.inflight.export_batches} export batch(es).`];
  if (p.export_drain?.export_commits) lines.push(`Export commits are on: the apply first exports up to ${p.export_drain.pending} pending page(s) through export batches on the owner host; only what stays unwritten becomes a hold.`);
  if (p.holds_to_write !== undefined) lines.push(`${p.holds_to_write} live page(s) have no file at their revision and would be kept as file_drift holds.`);
  for (const refusal of p.refusals) lines.push(`  refused (${refusal.code}): ${refusal.detail}`);
  lines.push(p.apply ? `Apply: ${p.apply.join(' ')}` : 'Nothing can be applied until the refusals above clear.');
  return lines.join('\n');
}

export async function runSourcesCanonicalMode(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const result = await flipSourceMode(engine, parseModeFlipArgs(args));
    console.log(json ? JSON.stringify(result) : describe(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Mode change refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(1);
  }
}
