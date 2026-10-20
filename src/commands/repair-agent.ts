/**
 * GBRA-133 PR 3: the repair and unblock flows behind the MCP ops `repair_preview`, `repair_apply` and `sync_unblock`
 * (src/core/ops/sync-status.ts). Each takes its parameters under the CLI's names, turns them into the exact
 * `gbrain repair <kind> ...` argv (validated by `parseRepairArgs`, the CLI's own grammar) and runs the same runner
 * `gbrain repair` and `gbrain sync unblock` use, so every refusal, cap, receipt and consent rule is the kind's own.
 *
 * - Preview (read-only): reconciles what an earlier agent apply left pending, then runs the dry run and returns its
 *   `preview_hash` (a preview-bound kind's own hash; the content lane's per-kind hashes joined in lane order; for any
 *   other kind a digest of the dry run's affected count, sample and residuals) and the apply step bound to it.
 * - Apply: refused on any transport but the local stdio pipe or the trusted CLI (remote apply is not built). It
 *   reconciles the last apply (still pending: `write_pending`), recomputes the preview and refuses `preview_changed`
 *   unless `expect` equals it, refuses `confirmation_required` (an `ask_user` step) without `yes`, applies bound to the
 *   hash, and records a receipt naming the explicit actor (`agent-apply-receipts.ts`).
 * - Caller-safe output: no stored text (the per-file diffs stay with `gbrain repair <kind> --diff` on the host); items
 *   naming a page the caller cannot read are withheld and counted, and an apply whose set includes one is refused.
 */
import type { BrainEngine } from '../core/engine.ts';
import { randomUUID } from 'node:crypto';
import { opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import type { Action, RenderContext, Transport } from '../core/agent-output.ts';
import { digest } from '../core/persistence/digest.ts';
import { REPAIR_KINDS, resolveRepairScope, type RepairKind, type RepairResult } from '../core/repair/core.ts';
import { repairRunner, repairSpec } from '../core/repair/registry.ts';
import { CONTENT_REPAIR_KINDS, runContentLane } from '../core/repair/content-lane.ts';
import { readSyncFile } from '../core/persistence/sync-discovery.ts';
import { privatePagesFilterFragment } from '../core/search/private-visibility.ts';
import { readGitSourceHolds } from '../core/persistence/sync-holds.ts';
import { unblockSync, type UnblockOutcome } from '../core/persistence/sync-status.ts';
import { reconcileAgentApplies, recordAgentApply, type AgentApplyActor, type AgentApplyReceipt, type AgentApplyReconciliation } from '../core/repair/agent-apply-receipts.ts';
import { REPAIR_BOOLEAN_PARAMS, REPAIR_VALUE_PARAMS } from '../core/ops/mcp-twin.ts';
import { CONTENT_LANE, namedKindRunOptions, parseRepairArgs } from './repair.ts';
import { hostRelay, renderFor, scrub, withheldHoldPaths } from './sync/status-document.ts';

/** Who calls, on which surface, and what of the brain they may see. */
export interface AgentRepairCaller {
  transport: Transport;
  render: RenderContext;
  /** The explicit actor an apply records; null for a preview. */
  actor: AgentApplyActor | null;
  excludePrivate: boolean;
  outsideFence?: (slug: string) => boolean;
  /** How long reconciliation waits for an earlier apply's pending writes. */
  reconcileMs: number;
}

const quiet = { info() {}, warn() {}, error() {} };
const WITHHELD = 'withheld: names a page this connection cannot read';

/** The `gbrain repair <kind> ...` argv for MCP params (CLI names, `source_id` → `--source`); `expect` and `yes` excluded. */
export function repairArgvFromParams(params: Record<string, unknown>, sourceId: string): string[] {
  const argv = ['gbrain', 'repair', String(params.kind ?? ''), '--source', sourceId];
  for (const [flag, { param, many }] of Object.entries(REPAIR_VALUE_PARAMS)) {
    if (flag === '--source') continue;
    const value = params[param];
    if (value === undefined || value === null) continue;
    for (const v of many && Array.isArray(value) ? value : [value]) argv.push(flag, String(v));
  }
  for (const [flag, param] of Object.entries(REPAIR_BOOLEAN_PARAMS)) if (params[param] === true) argv.push(flag);
  return argv;
}

/** The MCP arguments that name the same selection again (for the next step), with `source_id` explicit. */
function selectionParams(params: Record<string, unknown>, sourceId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: params.kind, source_id: sourceId };
  for (const { param } of Object.values(REPAIR_VALUE_PARAMS)) if (param !== 'source_id' && params[param] !== undefined && params[param] !== null) out[param] = params[param];
  for (const param of Object.values(REPAIR_BOOLEAN_PARAMS)) if (params[param] === true) out[param] = true;
  return out;
}

/** What a preview or apply of one kind (or the content lane) produced, as the ops report it. */
interface RepairRun { results: RepairResult[]; preview_hash: string; bound: boolean; preview_hashes?: Partial<Record<RepairKind, string | null>>; apply_command: string }

/** A stable digest of a dry run for a kind that prints no hash of its own: what it would touch, counted and sampled. */
function dryRunDigest(result: RepairResult, sourceId: string): string {
  return digest(['repair-agent-preview-v1', result.kind, sourceId, result.affected, result.sample, result.residuals, result.listing ?? []]);
}

async function runSelection(engine: BrainEngine, params: Record<string, unknown>, sourceId: string, mode: { apply: boolean; expect?: string }): Promise<RepairRun> {
  const argv = repairArgvFromParams(params, sourceId);
  const parsed = parseRepairArgs(argv.slice(2));
  const kind = parsed.kind!;
  const scope = await resolveRepairScope(engine, sourceId);
  const limit = parsed.limit === undefined ? undefined : Number(parsed.limit);
  if (kind === CONTENT_LANE) {
    const kinds = [...CONTENT_REPAIR_KINDS];
    const expect = mode.expect?.split(',');
    const lane = await runContentLane(engine, scope, { apply: mode.apply, kinds, only: parsed.only, skip: parsed.skip, noLlm: parsed.noLlm, maxLlmUsd: parsed.maxUsd, limit,
      noEmbed: parsed.noEmbed, sourceFlag: sourceId, logger: quiet, ...(expect && expect.every(hash => hash !== 'none') ? { expect } : {}) });
    const hashes = kinds.map(k => lane.preview_hashes[k] ?? 'none');
    return { results: lane.results, preview_hash: hashes.join(','), bound: hashes.every(hash => hash !== 'none'), preview_hashes: lane.preview_hashes, apply_command: lane.apply_command };
  }
  const runner = await repairRunner(engine, { apply: mode.apply, noEmbed: parsed.noEmbed, logger: quiet });
  const result = await runner.run(kind as RepairKind, scope, { limit, sourceFlag: sourceId, explicit: true, includeAmbiguous: parsed.includeAmbiguous,
    ...(mode.expect ? { expect: mode.expect } : {}), ...namedKindRunOptions(kind as RepairKind, parsed) });
  return { results: [result], preview_hash: result.preview_hash ?? dryRunDigest(result, sourceId), bound: result.preview_hash !== undefined, apply_command: result.apply_command };
}

/** The items of a run that name a page this caller cannot read (private, or outside its slug grant), as `<source>:<rest>` strings. */
async function withheldItems(engine: BrainEngine, sourceId: string, run: RepairRun, caller: AgentRepairCaller): Promise<{ items: Set<string>; needles: string[]; count: number }> {
  const items = new Set<string>();
  if (caller.transport === 'cli') return { items, needles: [], count: 0 };
  const names = [...new Set(run.results.flatMap(result => [...result.sample, ...(result.listing ?? []).map(entry => entry.item), ...(result.outcome_items ?? []).map(entry => entry.item),
    ...result.failed.map(entry => entry.item)]))].filter(item => item.startsWith(`${sourceId}:`));
  if (!names.length) return { items, needles: [], count: 0 };
  const rests = names.map(item => item.slice(sourceId.length + 1));
  const pages = await engine.executeRaw<{ slug: string; source_path: string | null; private: boolean }>(
    `SELECT p.slug, p.source_path, NOT ${privatePagesFilterFragment('p')} AS private FROM pages p
      WHERE p.source_id=$1 AND (p.slug=ANY($2::text[]) OR p.source_path=ANY($2::text[])) AND p.deleted_at IS NULL`, [sourceId, rests]);
  const needles = new Set<string>();
  const files = new Set<string>();
  const hidden = (rest: string): boolean => {
    const matches = pages.filter(page => page.slug === rest || page.source_path === rest);
    if (matches.some(page => caller.outsideFence?.(page.slug))) return true;
    if (!caller.excludePrivate) return false;
    return matches.some(page => page.private === true);
  };
  const unmatched: string[] = [];
  for (const rest of rests) {
    if (hidden(rest)) { items.add(`${sourceId}:${rest}`); needles.add(rest); for (const page of pages) if (page.slug === rest || page.source_path === rest) { files.add(page.slug); needles.add(page.slug); if (page.source_path) needles.add(page.source_path); } }
    else if (!pages.some(page => page.slug === rest || page.source_path === rest)) unmatched.push(rest);
  }
  if (!unmatched.length) return { items, needles: [...needles], count: files.size };
  // An item with no page row names a held file (by path, or by the slug the kind derived from it): judged by the hold's own file.
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => unmatched.includes(hold.path) || (hold.slug !== null && unmatched.includes(hold.slug)));
  const loose = unmatched.filter(rest => /\.mdx?$/i.test(rest) && !holds.some(hold => hold.path === rest)).map(path => ({ path, slug: null }));
  const held = await withheldHoldPaths(engine, sourceId, [...holds.map(hold => ({ path: hold.path, slug: hold.slug })), ...loose], caller);
  for (const rest of unmatched) {
    const hold = holds.find(h => h.path === rest || h.slug === rest);
    if (!held.has(hold?.path ?? rest)) continue;
    items.add(`${sourceId}:${rest}`);
    needles.add(rest);
    files.add(hold?.path ?? rest);
    if (hold) { needles.add(hold.path); if (hold.slug) needles.add(hold.slug); }
  }
  return { items, needles: [...needles], count: files.size };
}

/** A repair result as the ops report it: counts, codes, paths and hashes; no kind `details` (they carry the diffs). */
function projectResult(result: RepairResult, caller: AgentRepairCaller, withheld: Set<string>) {
  const keep = (item: string) => !withheld.has(item);
  const { details: _details, warnings, ...rest } = result;
  return { ...rest, sample: result.sample.filter(keep), ...(result.listing ? { listing: result.listing.filter(entry => keep(entry.item)) } : {}),
    ...(result.outcome_items ? { outcome_items: result.outcome_items.filter(entry => keep(entry.item)).map(entry => ({ ...entry, ...(entry.detail ? { detail: locationOnly(entry.detail) } : {}) })) } : {}),
    failed: result.failed.filter(entry => keep(entry.item)).map(entry => ({ ...entry, ...(entry.fix ? { fix: renderFor(entry.fix, caller) } : {}) })),
    ...(result.stopped ? { stopped: { ...result.stopped, ...(result.stopped.fix ? { fix: renderFor(result.stopped.fix, caller) } : {}) } } : {}),
    ...(warnings?.length && caller.transport !== 'http' ? { warnings } : {}) };
}

/** A kind outcome's detail without its prose (message, commit step, why, fix): codes, paths, tiers and hashes. */
function locationOnly(detail: Record<string, unknown>): Record<string, unknown> {
  const { message: _m, commit_step: _c, why: _w, fix: _f, diff: _d, ...rest } = detail;
  return rest;
}

function applyStep(params: Record<string, unknown>, sourceId: string, run: RepairRun, kindLabel: string): Action {
  const argv = [...repairArgvFromParams(params, sourceId), '--apply', ...(run.bound ? ['--expect', run.preview_hash] : []),
    ...(String(params.kind) === CONTENT_LANE || repairSpec(String(params.kind) as RepairKind)?.consent === 'destructive' ? ['--yes'] : [])].filter((arg, i, all) => !(arg === '--yes' && all.indexOf('--yes') !== i));
  return { argv, mcp: { tool: 'repair_apply', arguments: { ...selectionParams(params, sourceId), expect: run.preview_hash, yes: true } }, consent: ['destructive'], actor: 'agent',
    ask_user: true, requires_exclusive: false, plan_hash: run.preview_hash, preview_argv: repairArgvFromParams(params, sourceId),
    why: `Applies exactly the previewed ${kindLabel} set (preview ${run.preview_hash.slice(0, 12)}); an item that changed since the preview is skipped or refuses preview_changed.`,
    user_message: `Apply the previewed ${kindLabel} repair of source ${sourceId} (preview ${run.preview_hash.slice(0, 12)})? Each listed file or page changes exactly as the preview showed; managed sources commit through the Git effect (undo with git revert).`,
    verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] } };
}

function previewStep(params: Record<string, unknown>, sourceId: string, why: string): Action {
  return readFix(why, { argv: [...repairArgvFromParams(params, sourceId), '--json'], mcp: { tool: 'repair_preview', arguments: selectionParams(params, sourceId) } });
}

async function incarnationOf(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!row) throw opError('not_found', `Unknown source: ${sourceId}`, 'Pass a source id from sources_list, which lists the sources this connection can read.');
  return row.incarnation;
}

function priorApply(reconciled: AgentApplyReconciliation) {
  return { settled: reconciled.settled.length, pending: reconciled.pending.length,
    ...(reconciled.settled.length ? { settled_requests: reconciled.settled.map(s => ({ request_id: s.request_id, state: s.state, error_code: s.error_code })) } : {}),
    ...(reconciled.pending.length ? { pending_requests: reconciled.pending.map(p => p.request_id) } : {}) };
}

/** Kinds pinned CLI-only (ENG-O13): they retire stored facts and atoms, so no MCP connection reaches them, local or remote. */
const CLI_ONLY_KINDS: ReadonlySet<string> = new Set(['stale-atoms', 'extractor-facts']);

/** The kind an agent may run: CLI-only kinds refuse `trusted_local_only`, unknown kinds `invalid_params` (checked before any read). */
export function validateKind(params: Record<string, unknown>, sourceId: string): string {
  const kind = typeof params.kind === 'string' ? params.kind : '';
  if (CLI_ONLY_KINDS.has(kind)) {
    throw opError('trusted_local_only', `The ${kind} repair runs only from the trusted local CLI on the brain host, not over MCP.`,
      `Ask the user to run \`gbrain repair ${kind} --source ${sourceId}\` on the brain host.`,
      { legacy_error: 'permission_denied', fix: { argv: ['gbrain', 'repair', kind, '--source', sourceId], consent: [], actor: 'user', requires_exclusive: false,
        why: `${kind} retires stored rows the user reviews from the preview, so it is CLI-only (ENG-O13).` } });
  }
  if (kind !== CONTENT_LANE && !REPAIR_KINDS.includes(kind as RepairKind)) {
    throw opError('invalid_params', `Unknown repair kind '${kind}'.`, `Pass kind as one of: ${REPAIR_KINDS.filter(k => !CLI_ONLY_KINDS.has(k)).join(', ')}, or ${CONTENT_LANE} (the content-repair lane).`);
  }
  return kind;
}

export async function agentRepairPreview(engine: BrainEngine, caller: AgentRepairCaller, params: Record<string, unknown>, sourceId: string) {
  const kind = validateKind(params, sourceId);
  const incarnation = await incarnationOf(engine, sourceId);
  const reconciled = await reconcileAgentApplies(engine, sourceId, incarnation, caller.reconcileMs);
  const run = await runSelection(engine, params, sourceId, { apply: false });
  const withheld = await withheldItems(engine, sourceId, run, caller);
  const affected = run.results.reduce((sum, result) => sum + result.affected, 0);
  const next: Action = withheld.count
    ? previewStep({ ...params, only: undefined }, sourceId, `${withheld.count} item(s) of this preview name a page this connection cannot read, so an agent apply of the set is refused; narrow it with only (source-relative paths of the items listed here) and preview again, or ask the user to run the repair on the brain host.`)
    : affected
      ? applyStep(params, sourceId, run, kind)
      : readFix('Nothing to repair in this selection; reads the source\'s sync status.', { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], mcp: { tool: 'sync_status', arguments: { source_id: sourceId } } });
  return scrub({ kind, source_id: sourceId, mode: 'dry_run' as const, preview_hash: run.preview_hash, ...(run.preview_hashes ? { preview_hashes: run.preview_hashes } : {}),
    hash_bound: run.bound, affected, withheld: withheld.count, prior_apply: priorApply(reconciled),
    results: run.results.map(result => projectResult(result, caller, withheld.items)), apply_command: caller.transport === 'http' || !withheld.count ? run.apply_command : WITHHELD,
    next: renderFor(next, caller) }, withheld.needles);
}

export async function agentRepairApply(engine: BrainEngine, caller: AgentRepairCaller, params: Record<string, unknown>, sourceId: string) {
  const kind = validateKind(params, sourceId);
  if (caller.transport === 'http' || !caller.actor) throw remoteApplyRefusal(caller, repairArgvFromParams(params, sourceId), 'repair_apply');
  const expect = typeof params.expect === 'string' ? params.expect : '';
  const incarnation = await incarnationOf(engine, sourceId);
  const reconciled = await reconcileAgentApplies(engine, sourceId, incarnation, caller.reconcileMs);
  if (reconciled.pending.length) throw pendingRefusal(reconciled);
  const current = await runSelection(engine, params, sourceId, { apply: false });
  if (!expect || expect !== current.preview_hash) {
    throw opError('preview_changed', `The ${kind} preview of source ${sourceId} now hashes ${current.preview_hash.slice(0, 12)}, not the expect value ${expect ? expect.slice(0, 12) : '(none)'}; nothing was changed.`,
      'Preview again (repair_preview with the same selection), show the user the new set and apply with its preview_hash.',
      { fix: previewStep(params, sourceId, 'Previews the same selection again (read-only) and returns the current preview_hash.') });
  }
  const withheld = await withheldItems(engine, sourceId, current, caller);
  if (withheld.count) {
    throw opError('permission_denied', `${withheld.count} item(s) of this repair name a page this connection cannot read, so it will not apply them; nothing was changed.`,
      'Narrow the selection with only to the items the preview lists, or ask the user to run the repair on the brain host.',
      { reason: 'withheld_items', fix: hostRelay({ argv: repairArgvFromParams(params, sourceId), consent: [], actor: 'user', requires_exclusive: false, why: 'Previews the whole selection on the brain host, where the user can see every item.' }) });
  }
  if (params.yes !== true) throw consentRefusal(applyStep(params, sourceId, current, kind), `repair_apply ${kind}`);
  const run = await runSelection(engine, params, sourceId, { apply: true, ...(current.bound ? { expect } : {}) });
  (await import('../core/health-memo.ts')).clearHealthMemo(engine);
  const receipt = await recordReceipt(engine, { op: 'repair_apply', kind, sourceId, incarnation, expect, actor: caller.actor, results: run.results });
  const resync: Action = { argv: ['gbrain', 'sync', '--source', sourceId, '--no-pull'], mcp: { tool: 'sync_brain', arguments: { source_id: sourceId, no_pull: true } }, consent: [], actor: 'agent',
    requires_exclusive: false, verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], mcp: { tool: 'sync_status', arguments: { source_id: sourceId } } },
    why: 'Imports the repaired files and re-screens their holds; sync_status then shows the holds that remain.' };
  return { kind, source_id: sourceId, mode: 'apply' as const, expect, receipt: projectReceipt(receipt), prior_apply: priorApply(reconciled),
    results: run.results.map(result => projectResult(result, caller, new Set())), next: renderFor(resync, caller) };
}

/** The unblock preview's hash: what it would do and refuse, bound to each held file's upstream version. */
async function unblockHash(engine: BrainEngine, sourceId: string, incarnation: string, preview: UnblockOutcome): Promise<string> {
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
  return digest(['sync-unblock-v1', sourceId, incarnation, holds.map(hold => [hold.path, hold.code, hold.upstream_version]).sort(),
    preview.applied.map(entry => [entry.path, entry.code, entry.action, entry.action === 'repair' ? entry.repair.kind : null]),
    preview.refused.map(entry => [entry.path, entry.code, entry.reason])]);
}

function projectUnblock(outcome: UnblockOutcome, caller: AgentRepairCaller, withheld: Set<string>) {
  return { applied: outcome.applied.filter(entry => !withheld.has(entry.path)).map(entry => entry.action === 'repair'
    ? { ...entry, repair: { ...entry.repair, next: renderFor(entry.repair.next, caller) } } : entry),
  refused: outcome.refused.filter(entry => !withheld.has(entry.path)).map(entry => ({ ...entry, fix: renderFor(entry.fix, caller) })),
  next: outcome.next ? renderFor(outcome.next, caller) : null };
}

export async function agentSyncUnblock(engine: BrainEngine, caller: AgentRepairCaller, params: Record<string, unknown>, sourceId: string) {
  const apply = params.apply === true;
  const options = { noLlm: params.no_llm === true, noRepair: params.no_repair === true };
  const cliArgv = ['gbrain', 'sync', 'unblock', '--source', sourceId, ...(options.noLlm ? ['--no-llm'] : []), ...(options.noRepair ? ['--no-repair'] : [])];
  if (apply && (caller.transport === 'http' || !caller.actor)) throw remoteApplyRefusal(caller, cliArgv, 'sync_unblock');
  const incarnation = await incarnationOf(engine, sourceId);
  const reconciled = await reconcileAgentApplies(engine, sourceId, incarnation, caller.reconcileMs);
  if (apply && reconciled.pending.length) throw pendingRefusal(reconciled);
  const preview = await unblockSync(engine, sourceId, { apply: false, ...options });
  const hash = await unblockHash(engine, sourceId, incarnation, preview);
  const entries = [...preview.applied, ...preview.refused].map(entry => ({ path: entry.path, slug: entry.slug }));
  const withheld = caller.transport === 'cli' ? new Set<string>() : await withheldHoldPaths(engine, sourceId, entries, caller);
  const needles = [...new Set(entries.filter(entry => withheld.has(entry.path)).flatMap(entry => [entry.path, ...(entry.slug ? [entry.slug] : [])]))];
  const step: Action = { argv: [...cliArgv, '--apply', '--json'], mcp: { tool: 'sync_unblock', arguments: { source_id: sourceId, ...(options.noLlm ? { no_llm: true } : {}), ...(options.noRepair ? { no_repair: true } : {}), apply: true, expect: hash, yes: true } },
    consent: ['destructive'], actor: 'agent', ask_user: true, requires_exclusive: false, plan_hash: hash,
    why: `Runs the previewed unblock (preview ${hash.slice(0, 12)}): re-screens the held files it named and repairs what the content-repair lane clears, each with its receipt.`,
    user_message: `Run the previewed sync unblock for source ${sourceId}? It schedules ${preview.applied.length} held file(s) for a re-screen or a hash-bound repair.`,
    verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], mcp: { tool: 'sync_status', arguments: { source_id: sourceId } } } };
  if (!apply) {
    return scrub({ source_id: sourceId, apply: false, preview_hash: hash, withheld: withheld.size, prior_apply: priorApply(reconciled), ...projectUnblock(preview, caller, withheld),
      next: preview.applied.length ? renderFor(withheld.size && preview.applied.some(entry => withheld.has(entry.path)) ? hostRelay({ ...step, mcp: undefined }) : step, caller) : null }, needles);
  }
  const expect = typeof params.expect === 'string' ? params.expect : '';
  if (expect !== hash) {
    throw opError('preview_changed', `The unblock preview of source ${sourceId} now hashes ${hash.slice(0, 12)}, not the expect value ${expect ? expect.slice(0, 12) : '(none)'}; nothing was changed.`,
      'Preview again (sync_unblock without apply) and apply with its preview_hash.',
      { fix: readFix('Previews the unblock again (read-only) and returns the current preview_hash.', { argv: [...cliArgv, '--json'], mcp: { tool: 'sync_unblock', arguments: { source_id: sourceId } } }) });
  }
  if (preview.applied.some(entry => withheld.has(entry.path))) {
    throw opError('permission_denied', 'This unblock would act on a held file whose page this connection cannot read, so it will not run; nothing was changed.',
      'Ask the user to run the unblock on the brain host, where every held file is visible.', { reason: 'withheld_items', fix: hostRelay({ argv: [...cliArgv, '--json'], consent: [], actor: 'user', requires_exclusive: false, why: 'Previews the unblock on the brain host.' }) });
  }
  if (params.yes !== true) throw consentRefusal(step, 'sync_unblock');
  const outcome = await unblockSync(engine, sourceId, { apply: true, ...options });
  await (await import('../core/persistence/soak-counters.ts')).recordSoakEvent(engine, 'unblock_apply');
  const receipt = await recordReceipt(engine, { op: 'sync_unblock', kind: 'unblock', sourceId, incarnation, expect, actor: caller.actor!, unblock: outcome });
  return scrub({ source_id: sourceId, apply: true, expect, receipt: projectReceipt(receipt), prior_apply: priorApply(reconciled), ...projectUnblock(outcome, caller, withheld) }, needles);
}

async function recordReceipt(engine: BrainEngine, r: { op: AgentApplyReceipt['op']; kind: string; sourceId: string; incarnation: string; expect: string; actor: AgentApplyActor;
  results?: RepairResult[]; unblock?: UnblockOutcome }): Promise<AgentApplyReceipt> {
  const results = r.results ?? [];
  const items = r.unblock
    ? r.unblock.applied.map(entry => ({ item: `${r.sourceId}:${entry.path}`, outcome: entry.action === 'repair' ? entry.repair.outcome : entry.action, ...(entry.action === 'repair' && entry.repair.reason ? { reason: entry.repair.reason } : {}) }))
    : results.flatMap(result => [...(result.outcome_items ?? []).map(entry => ({ item: entry.item, outcome: entry.outcome, ...(entry.reason ? { reason: entry.reason } : {}) })),
      ...result.failed.map(entry => ({ item: entry.item, outcome: 'failed', reason: entry.reason }))]);
  const receipt: AgentApplyReceipt = { receipt_id: randomUUID(), at: new Date().toISOString(), op: r.op, kind: r.kind, source_id: r.sourceId, incarnation: r.incarnation, expect: r.expect, actor: r.actor,
    applied: r.unblock ? r.unblock.applied.length : results.reduce((sum, result) => sum + result.applied, 0), skipped: results.reduce((sum, result) => sum + result.skipped, 0),
    failed: results.reduce((sum, result) => sum + result.failed.length, 0), stopped: results.find(result => result.stopped)?.stopped?.reason ?? null, items: items.slice(0, 200),
    pending: results.flatMap(result => result.pending ?? []), settled: [] };
  await recordAgentApply(engine, receipt);
  return receipt;
}

function projectReceipt(receipt: AgentApplyReceipt) {
  const { items: _items, settled: _settled, incarnation: _incarnation, ...rest } = receipt;
  return rest;
}

function pendingRefusal(reconciled: AgentApplyReconciliation) {
  const first = reconciled.pending[0]!;
  return opError('write_pending', `${reconciled.pending.length} write(s) of an earlier agent apply on this source are still pending publication (first: ${first.request_id}); a new apply waits until they settle.`,
    'Check the pending write (fix), then preview again once it settled.',
    { fix: readFix('Reads the pending write request; it is still pending, committed or failed.', { argv: ['gbrain', 'write-request', '--', first.request_id], mcp: { tool: 'get_write_request', arguments: { request_id: first.request_id } } }) });
}

function consentRefusal(step: Action, what: string) {
  return opError('confirmation_required', `${what} changes files or stored rows, so it runs only with the user's agreement (yes: true); nothing was changed.`,
    'Show the user what the preview listed and ask; with their agreement call the same tool again with yes: true (the fix carries the exact call).',
    { reason: 'yes_required', fix: step });
}

function remoteApplyRefusal(caller: AgentRepairCaller, argv: string[], op: string) {
  return opError('permission_denied', `${op} runs only over the brain host's local stdio MCP server or the gbrain CLI; this ${caller.transport} connection cannot apply repairs (remote apply is not built).`,
    'Ask the brain host operator to run the repair there (the fix carries the exact command).',
    { reason: 'remote_apply_unsupported', fix: hostRelay({ argv: [...argv, '--json'], consent: [], actor: 'host_admin', requires_exclusive: false, why: 'Previews the repair on the brain host; the operator applies it there.' }) });
}
