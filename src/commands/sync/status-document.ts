/**
 * GBRA-133 PR 3: the one `sync status` document, shared by `gbrain sync status --json` and the MCP `sync_status` op so
 * both carry identical field names. `readSyncStatus` plus the capacity picture, freshness, the notifier block and the
 * autofix block (`autofix.recent`, `autofix.pending`, `autofix.switches`), with every action rendered for the caller's
 * surface. Each hold also carries `item_id` and three actions an agent can follow without a person typing a command:
 * `preview` (read-only; returns the hash an apply binds to), `apply` (bound to that hash, consent destructive, null when
 * a person decides) and `verify` (this status again). Every action gets its `mcp` twin (`withMcpTwins`), so over the
 * local stdio pipe `deriveNext` renders `run` (`ask_user` for an apply); on the CLI the twins are dropped at render.
 *
 * Caller-safe projection for an agent-facing caller (`viewer.transport` stdio or http): holds naming a page the caller
 * may not read (a private page under the brain's remote-visibility policy, a slug outside the client's bound prefixes)
 * are withheld before anything else is projected and counted in `holds_withheld`; any other string naming a withheld
 * path or slug is replaced. An http caller additionally gets read-only items: every action keeps its exact local
 * command and renders `ask_user` with a relay to the brain host operator (no MCP twin), and the notifier block is the
 * remote projection (no trace path, pid or host id).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { cliRenderContext, renderAction, renderNotice, shellQuote, type Action, type RenderContext, type RenderedAction, type RenderedNotice, type Transport } from '../../core/agent-output.ts';
import { readSyncStatus, type SyncStatus, type SyncStatusHold } from '../../core/persistence/sync-status.ts';
import { withMcpTwins } from '../../core/ops/mcp-twin.ts';
import type { OperationContext } from '../../core/ops/contract.ts';
import { opTransport, readFix } from '../../core/ops/op-fix.ts';
import { readAutofixState, type AutofixState } from '../../core/autofix/state.ts';
import { readSyncFile } from '../../core/persistence/sync-discovery.ts';
import { isPrivatePage, privatePagesFilterFragment } from '../../core/search/private-visibility.ts';
import { repairKindFlags } from '../repair.ts';
import type { SourceFreshness } from '../../core/persistence/sync-freshness.ts';
import type { NotifierBlock } from '../../core/notifier/status.ts';

/** Who reads the document, and what of the brain they may see (unset predicates: everything, the trusted CLI). */
export interface SyncStatusViewer {
  transport: Transport;
  render: RenderContext;
  /** Private pages are withheld (`resolveExcludePrivatePages`). */
  excludePrivate?: boolean;
  /** A slug outside the caller's slug grant (`slugOutsideCallerFence`). */
  outsideFence?: (slug: string) => boolean;
}

export type SyncStatusDocumentHold = Omit<SyncStatusHold, 'fix'> & {
  fix: RenderedAction; preview: RenderedAction | null; apply: RenderedAction | null; verify: RenderedAction;
};

export type SyncStatusDocument = Omit<SyncStatus, 'holds' | 'git_push_holds' | 'next' | 'checkpoint_blockers_read' | 'cursors_read' | 'terminal_failures_read'> & {
  holds: SyncStatusDocumentHold[];
  /** Holds this caller may not see, counted only (always 0 for the trusted CLI). */
  holds_withheld: number;
  git_push_holds: Array<Omit<SyncStatus['git_push_holds'][number], 'fix'> & { fix: RenderedAction }>;
  next: RenderedAction | null;
  checkpoint_blockers_read: { status: 'read' } | { status: 'not_read'; fix: RenderedAction };
  cursors_read: { status: 'read' } | { status: 'not_read'; fix: RenderedAction };
  terminal_failures_read: { status: 'read' } | { status: 'not_read'; fix: RenderedAction };
  capacity: { status: string; pause_pct: number | null; low: unknown; paused: unknown };
  freshness: SourceFreshness | null;
  notifier: (Omit<NotifierBlock, 'fix'> & { fix: RenderedAction | null }) | null;
  autofix: AutofixState;
  notices?: RenderedNotice[];
};

const WITHHELD = 'withheld: names a page this connection cannot read';

/** The frontmatter keys `isPrivatePage` reads, scanned from a held file's first block without parsing it (it may not parse). */
function heldFilePrivate(bytes: Buffer): boolean {
  const text = bytes.subarray(0, 65_536).toString('utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return false;
  const value = (key: string) => new RegExp(`^${key}:[ \\t]*['"]?([^'"\\r\\n#]*?)['"]?[ \\t]*$`, 'm').exec(block)?.[1]?.trim();
  const frontmatter: Record<string, unknown> = {};
  for (const key of ['visibility', 'pinned_question', 'synthesized_by']) { const v = value(key); if (v !== undefined && v !== '') frontmatter[key] = v; }
  return isPrivatePage({ type: value('type') ?? null, frontmatter });
}

/** Paths of the holds this viewer may not see: private pages (by the page row, else the held file's own frontmatter) and slugs outside the grant. */
export async function withheldHoldPaths(engine: BrainEngine, sourceId: string, holds: ReadonlyArray<Pick<SyncStatusHold, 'path' | 'slug'>>, viewer: Omit<SyncStatusViewer, 'render'>): Promise<Set<string>> {
  const out = new Set<string>();
  if (!holds.length) return out;
  for (const hold of holds) if (hold.slug && viewer.outsideFence?.(hold.slug)) out.add(hold.path);
  if (!viewer.excludePrivate) return out;
  const slugs = [...new Set(holds.flatMap(hold => hold.slug ? [hold.slug] : []))];
  const pages = slugs.length ? await engine.executeRaw<{ slug: string; private: boolean }>(
    `SELECT p.slug, NOT ${privatePagesFilterFragment('p')} AS private FROM pages p WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL`, [sourceId, slugs]) : [];
  const bySlug = new Map(pages.map(page => [page.slug, page.private === true]));
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  for (const hold of holds) {
    const known = hold.slug ? bySlug.get(hold.slug) : undefined;
    if (known === true) { out.add(hold.path); continue; }
    if (known === false || !source?.local_path) continue;
    try { const bytes = readSyncFile(source.local_path, hold.path); if (bytes && heldFilePrivate(bytes)) out.add(hold.path); } catch { out.add(hold.path); }
  }
  return out;
}

/** Replaces every string that names a withheld path or slug (the safety net behind removing the withheld holds). */
export function scrub<T>(value: T, needles: readonly string[]): T {
  if (!needles.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return needles.some(needle => v.includes(needle)) ? WITHHELD : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    return v;
  };
  return walk(value) as T;
}

/** An http caller's form of an action: the exact local command, relayed to the brain host operator; never an MCP call. */
export function hostRelay(action: Action): Action {
  const { mcp: _mcp, then, ...rest } = action;
  const command = action.argv?.length ? shellQuote(action.argv) : null;
  return { ...rest, ask_user: true,
    user_message: command ? `This step runs on the brain host: please ask whoever runs this gbrain server to run ${command}.` : (action.user_message ?? 'This step runs on the brain host; please ask whoever runs this gbrain server.'),
    ...(then ? { then: hostRelay(then) } : {}) };
}

/** An action rendered for the viewer: with its MCP twins, relayed to the brain host for an http caller. */
export function renderFor(action: Action, viewer: Pick<SyncStatusViewer, 'transport' | 'render'>): RenderedAction {
  const twinned = withMcpTwins(action);
  return renderAction(viewer.transport === 'http' ? hostRelay(twinned) : twinned, viewer.render);
}

/** The viewer an MCP op's caller is: its surface, render context and (for an agent-facing caller) the privacy predicates. */
export async function opViewer(ctx: OperationContext): Promise<SyncStatusViewer> {
  const transport = opTransport(ctx);
  const { resolveExcludePrivatePages } = await import('../../core/search/private-visibility.ts');
  const { slugOutsideCallerFence } = await import('../../core/ops/context.ts');
  return { transport,
    render: transport === 'cli' ? cliRenderContext() : { transport, isCallable: ctx.isCallable ?? (() => false), preapproved: () => false },
    excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote),
    ...(ctx.remote === false ? {} : { outsideFence: (slug: string) => slugOutsideCallerFence(ctx, slug) }) };
}

/** The step that reads one source's sync status (sources_status and get_status_snapshot point at it). */
export function syncStatusPointer(sourceId: string, viewer: Pick<SyncStatusViewer, 'transport' | 'render'>): RenderedAction {
  return renderFor(readFix("Reads this source's sync status: every held file with its preview, apply and verify steps, freshness, the notifier and autofix blocks, and the next step.",
    { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], mcp: { tool: 'sync_status', arguments: { source_id: sourceId } } }), viewer);
}

/** The preview / apply / verify triple of one hold (unrendered). */
export function holdItemActions(hold: SyncStatusHold, sourceId: string): { preview: Action | null; apply: Action | null; verify: Action } {
  const verify: Action = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `Reads this source's sync status again; the hold (${hold.path}) is gone once its file imports.` };
  const fix = hold.fix.argv ?? [];
  const repairKind = fix[0] === 'gbrain' && fix[1] === 'repair' && fix[2] && !fix[2].startsWith('-') ? fix[2] : null;
  if (repairKind) {
    const base = fix.filter(arg => arg !== '--json' && arg !== '--apply' && arg !== '--yes');
    const only = repairKindFlags(repairKind).includes('--only') && !base.includes('--only') ? ['--only', hold.path] : [];
    const preview: Action = { argv: [...base, ...only], consent: [], actor: 'agent', requires_exclusive: false, verify: verify,
      why: `Previews the ${repairKind} repair of ${hold.path}; writes nothing and returns the preview hash the apply binds to.` };
    const apply: Action | null = hold.needs_human ? null : { argv: [...base, ...only, '--apply', '--expect', '<preview_hash>', '--yes'], consent: ['destructive'], actor: 'agent', requires_exclusive: false,
      inputs: [{ name: 'preview_hash', how: 'the preview_hash the preview returned for this item' }], verify,
      why: `Applies exactly the previewed ${repairKind} repair of ${hold.path}; a file that changed since the preview refuses preview_changed.`,
      user_message: `Apply the previewed ${repairKind} repair of ${hold.path}? The file is rewritten exactly as the preview showed and imported again (undo: git revert of the repair commit).` };
    return { preview, apply, verify };
  }
  if (hold.safe_actions[0] === 'retry' || hold.safe_actions[0] === 'retry_when_clean') {
    const preview: Action = { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `Previews what unblock would do for ${hold.path} (a re-screen) and returns the preview hash the apply binds to; writes nothing.` };
    const apply: Action | null = hold.needs_human ? null : { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: ['destructive'], actor: 'agent', requires_exclusive: false, verify,
      why: `Schedules ${hold.path} for a re-screen (and repairs what the content-repair lane clears), bound to the unblock preview.`,
      user_message: `Run the previewed sync unblock for source ${sourceId}? It schedules the held files it named for a re-screen.` };
    return { preview, apply, verify };
  }
  return { preview: null, apply: null, verify };
}

/** The document for one source, projected for `viewer`. */
export async function buildSyncStatusDocument(engine: BrainEngine, sourceId: string, opts: { detail: boolean; viewer: SyncStatusViewer }): Promise<SyncStatusDocument> {
  const { viewer } = opts;
  const status = await readSyncStatus(engine, sourceId, { detail: opts.detail });
  const withheld = viewer.transport === 'cli' ? new Set<string>() : await withheldHoldPaths(engine, sourceId, status.holds, viewer);
  const needles = [...new Set(status.holds.filter(hold => withheld.has(hold.path)).flatMap(hold => [hold.path, ...(hold.slug ? [hold.slug] : [])]))];
  const visible = status.holds.filter(hold => !withheld.has(hold.path));
  const { capacitySnapshotWithin, capacityNotices, CAPACITY_READ_WAIT_MS } = await import('../../core/persistence/capacity-snapshot.ts');
  const snapshot = await capacitySnapshotWithin(engine, Date.now() + CAPACITY_READ_WAIT_MS);
  const notices = (await capacityNotices(engine, { throttle: false, snapshot })).map(notice => renderNotice(viewer.transport === 'http' && notice.fix ? { ...notice, fix: hostRelay(notice.fix) } : notice, viewer.render));
  const { readSyncFreshness } = await import('../../core/persistence/sync-freshness.ts');
  const [freshness = null] = await readSyncFreshness(engine, { sourceIds: [sourceId] }).catch(() => []);
  const { readNotifierBlock } = await import('../../core/notifier/status.ts');
  const notifierBlock = await readNotifierBlock(engine, sourceId, viewer.transport === 'http' ? { remote: true } : {}).catch(() => null);
  const autofix = await readAutofixState(engine, sourceId, { remote: viewer.transport !== 'cli', withhold: withheld });
  const read = (r: SyncStatus['cursors_read']) => r.status === 'read' ? r : { ...r, fix: renderFor(r.fix, viewer) };
  const holds = visible.map((hold): SyncStatusDocumentHold => {
    const actions = holdItemActions(hold, sourceId);
    return { ...hold, fix: renderFor(hold.fix, viewer), preview: actions.preview && renderFor(actions.preview, viewer), apply: actions.apply && renderFor(actions.apply, viewer), verify: renderFor(actions.verify, viewer) };
  });
  const doc: SyncStatusDocument = { ...status, holds, holds_withheld: status.holds.length - visible.length,
    git_push_holds: status.git_push_holds.map(hold => ({ ...hold, fix: renderFor(hold.fix, viewer) })), next: status.next ? renderFor(status.next, viewer) : null,
    checkpoint_blockers_read: read(status.checkpoint_blockers_read), cursors_read: read(status.cursors_read), terminal_failures_read: read(status.terminal_failures_read),
    capacity: { status: snapshot.status, pause_pct: snapshot.pause_pct, low: snapshot.low, paused: snapshot.paused }, freshness,
    notifier: notifierBlock && { ...notifierBlock, fix: notifierBlock.fix ? renderFor(notifierBlock.fix, viewer) : null },
    autofix,
    ...(notices.length ? { notices } : {}) };
  return scrub(doc, needles);
}
