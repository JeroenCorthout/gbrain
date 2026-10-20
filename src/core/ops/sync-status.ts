/**
 * Sync operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `syncStatusOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext, ParamDef } from './contract.ts';
import { opError } from './contract.ts';
import { opTransport, readFix } from './op-fix.ts';
import { assertSourceInCallerScope } from './context.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { REPAIR_BOOLEAN_PARAMS, REPAIR_VALUE_PARAMS } from './mcp-twin.ts';
import type { AgentRepairCaller } from '../../commands/repair-agent.ts';

/** `gbrain sync --source <id>` on the CLI, `source_id: "<id>"` over MCP. */
function sourceRef(ctx: OperationContext, id: string): string {
  return opTransport(ctx) === 'cli' ? `--source ${id}` : `source_id: "${id}"`;
}

const LIST_SOURCES = readFix('Lists the registered, active source ids sync can target.', {
  argv: ['gbrain', 'sources', 'list'], mcp: { tool: 'sources_list', arguments: {} },
});

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Pull and import changes from a source\'s git repository (incremental; dry_run previews). Use when files changed on disk or upstream. Needs admin scope and the local stdio server. On a missing local_path: the error names the sources add command.',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    source_id: { type: 'string', description: 'Explicit source to sync (wins over repo-derived and ambient routing)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { performSync } = await import('../../commands/sync.ts');
    // #3765 routing precedence: explicit source_id param > repo-derived source
    // (dotfile / registered local_path anchored at the REPO dir, #3765) >
    // ctx.sourceId (#2830 ambient thread). Pre-fix, a `repo` pointing at
    // source B's checkout synced under the CALLER's source: wrong anchor,
    // wrong page source_id, wrong `syncLockId(sourceId)` lock key.
    let sourceId = ctx.sourceId;
    const explicit = p.source_id as string | undefined;
    const repo = p.repo as string | undefined;
    if (explicit) {
      const { resolveSourceId, SourceTargetError, ALL_SOURCES } = await import('../source-resolver.ts');
      if (explicit === ALL_SOURCES) {
        throw opError(
          'invalid_params',
          `sync_brain targets exactly one source; '${ALL_SOURCES}' is not valid here.`,
          `Pass one registered source id (for example ${sourceRef(ctx, 'default')}); run it once per source to sync several.`,
          { fix: LIST_SOURCES },
        );
      }
      try {
        // Explicit tier of the canonical resolver: regex-validates AND asserts
        // the source exists + is not archived (no dead-FK writes).
        sourceId = await resolveSourceId(ctx.engine, explicit);
      } catch (e) {
        if (e instanceof SourceTargetError) {
          throw opError('invalid_params', e.message, 'Pick a registered, active source id (fix lists them) and pass it explicitly.', { fix: LIST_SOURCES });
        }
        throw e;
      }
    } else if (repo) {
      const { resolveSourceForRepoPath, SourceTargetError } = await import('../source-resolver.ts');
      let derived: Awaited<ReturnType<typeof resolveSourceForRepoPath>> = null;
      try {
        derived = await resolveSourceForRepoPath(ctx.engine, repo);
      } catch (e) {
        if (e instanceof SourceTargetError) {
          throw opError('invalid_params', e.message, 'Pick a registered, active source id (fix lists them) and pass it explicitly.', { fix: LIST_SOURCES });
        }
        throw e;
      }
      if (derived) {
        // Conflict guard: the caller is PINNED to a non-default source (MCP
        // scope / dotfile context) but `repo` belongs to a different one.
        // Refuse with a structured error instead of silently picking a side.
        if (ctx.sourceId && ctx.sourceId !== 'default' && ctx.sourceId !== derived.source_id) {
          throw opError(
            'invalid_params',
            `repo path resolves to source '${derived.source_id}' (via ${derived.tier}) but the ` +
            `caller is scoped to source '${ctx.sourceId}'. Pass source_id explicitly to pick one.`,
            `Re-run with ${sourceRef(ctx, derived.source_id)} to sync that repo's source, or ` +
            `${sourceRef(ctx, ctx.sourceId)} to force the caller's scope.`,
          );
        }
        sourceId = derived.source_id;
      }
    }
    const sourceOpts = sourceId ? { sourceId } : {};
    return performSync(ctx.engine, {
      repoPath: repo,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      full: (p.full as boolean) || false,
      drainHolder: { kind: 'mcp', id: null },
      ...sourceOpts,
    });
  },
  cliHints: { name: 'sync', hidden: true },
};


// --- GBRA-133 PR 3: sync status, unblock and repair over MCP ---

/** The one source a sync-status or repair op acts on: the named one, else the caller's; confined to the caller's read scope (out of scope reads as unknown). */
async function targetSource(ctx: OperationContext, p: Record<string, unknown>, op: string): Promise<string> {
  const id = typeof p.source_id === 'string' && p.source_id ? p.source_id : ctx.sourceId;
  if (!id || id === ALL_SOURCES) {
    throw opError('invalid_params', `${op} targets exactly one source.`, `Pass one source id (for example ${sourceRef(ctx, 'default')}); sources_list lists them.`, { fix: LIST_SOURCES });
  }
  assertSourceInCallerScope(ctx, id);
  const [row] = await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id=$1 AND archived IS NOT TRUE', [id]);
  if (!row) throw opError('not_found', `Unknown source: ${id}`, 'Pass a source id from sources_list, which lists the sources this connection can read.', { fix: LIST_SOURCES });
  return id;
}

/** The caller as the repair flows see it: surface, render context, privacy predicates and, on the local pipe or CLI, the explicit actor an apply records. */
async function agentCaller(ctx: OperationContext): Promise<AgentRepairCaller> {
  const { opViewer } = await import('../../commands/sync/status-document.ts');
  const viewer = await opViewer(ctx);
  return {
    ...viewer,
    excludePrivate: viewer.excludePrivate === true,
    actor: viewer.transport === 'cli' ? { kind: 'local_cli', transport: 'cli', client: null }
      : viewer.transport === 'stdio' ? { kind: 'local_agent', transport: 'stdio', client: ctx.auth?.clientName ?? ctx.sessionId ?? null } : null,
    reconcileMs: ctx.writeWaitMs ?? 5_000,
  };
}

const SOURCE_PARAM: ParamDef = { type: 'string', description: "The source to act on, as sources_list names it (default: this connection's source)." };

const sync_status: Operation = {
  name: 'sync_status',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: "Where one source's sync stands and what to do next: the MCP twin of `gbrain sync status --json` (identical field names). State and reason, every held "
    + 'file with item_id and preview/apply/verify steps, freshness, the notifier block, autofix (recent, pending, switches) and one next step. Over the local '
    + 'stdio server each step names the tool to call (repair_preview, repair_apply, sync_unblock, sync_brain); a remote connection gets read-only items whose '
    + 'steps name the exact command for the brain host. Held pages this connection cannot read are withheld and counted (holds_withheld).',
  params: {
    source_id: SOURCE_PARAM,
    detail: { type: 'boolean', description: 'Also run the heavy reads (terminal-failure summary, checkpoint blockers, live cursors), as --detail does.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const sourceId = await targetSource(ctx, p, 'sync_status');
    const { buildSyncStatusDocument, opViewer } = await import('../../commands/sync/status-document.ts');
    return buildSyncStatusDocument(ctx.engine, sourceId, { detail: p.detail === true, viewer: await opViewer(ctx) });
  },
};

const sync_unblock: Operation = {
  name: 'sync_unblock',
  mutating: true,
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'The MCP twin of `gbrain sync unblock`: without apply, previews the safe action for every held file of one source (re-screens, content-lane repairs, '
    + 'refusals by name) and returns its preview_hash; with apply, expect (that hash) and yes (the user agreed), performs it and records a receipt naming this '
    + 'agent. A changed preview refuses preview_changed; no yes refuses confirmation_required. Local stdio server only.',
  params: {
    source_id: SOURCE_PARAM,
    apply: { type: 'boolean', description: 'Perform the previewed actions (needs expect and yes).' },
    expect: { type: 'string', description: 'The preview_hash of the unblock preview being applied.' },
    yes: { type: 'boolean', description: 'The user agreed to the previewed actions.' },
    no_llm: { type: 'boolean', description: 'Repairs keep to their free tiers, as --no-llm.' },
    no_repair: { type: 'boolean', description: 'Refuse every repair-class hold instead of repairing it, as --no-repair.' },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const sourceId = await targetSource(ctx, p, 'sync_unblock');
    const { agentSyncUnblock } = await import('../../commands/repair-agent.ts');
    return agentSyncUnblock(ctx.engine, await agentCaller(ctx), p, sourceId);
  },
};

/** `repair_preview` / `repair_apply` params: the CLI's flags under their own names (`--only` is `only`, `--source` is `source_id`). */
const REPAIR_PARAMS: Record<string, ParamDef> = {
  kind: { type: 'string', required: true, description: 'The repair kind, as gbrain repair names it (frontmatter, fences, slug-conflicts, file-drift, ...), or content for the content-repair lane.' },
  source_id: SOURCE_PARAM,
  ...Object.fromEntries(Object.values(REPAIR_VALUE_PARAMS).filter(({ param }) => param !== 'source_id').map(({ param, many, numeric }): [string, ParamDef] => [param, many
    ? { type: 'array', items: { type: 'string' }, description: `Repeatable --${param.replace(/_/g, '-')} values.` }
    : { type: numeric ? 'number' : 'string', description: `--${param.replace(/_/g, '-')}, for the kinds that take it.` }])),
  ...Object.fromEntries(Object.values(REPAIR_BOOLEAN_PARAMS).map((param): [string, ParamDef] => [param, { type: 'boolean', description: `--${param.replace(/_/g, '-')}, for the kinds that take it.` }])),
};

const repair_preview: Operation = {
  name: 'repair_preview',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: "Preview one gbrain repair kind (or the content lane) on one source, read-only, with the CLI's own params (kind, source_id, only, skip, slug, "
    + 'include_ambiguous, ...). Returns counts, items, residuals and the preview_hash repair_apply binds to (the content lane: one hash per kind, comma-joined), '
    + 'plus the apply step. Reconciles an earlier agent apply first. No file diffs (run the kind with --diff on the brain host for those).',
  params: REPAIR_PARAMS,
  scope: 'read',
  handler: async (ctx, p) => {
    const { agentRepairPreview, validateKind } = await import('../../commands/repair-agent.ts');
    validateKind(p, typeof p.source_id === 'string' && p.source_id ? p.source_id : ctx.sourceId);
    const sourceId = await targetSource(ctx, p, 'repair_preview');
    return agentRepairPreview(ctx.engine, await agentCaller(ctx), p, sourceId);
  },
};

const repair_apply: Operation = {
  name: 'repair_apply',
  mutating: true,
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Apply exactly the set a repair_preview returned: same params plus expect (its preview_hash) and yes (the user agreed). A changed preview refuses '
    + 'preview_changed; no yes refuses confirmation_required; a pending earlier apply refuses write_pending. Runs the kind as gbrain repair <kind> --apply '
    + '--expect does and records a receipt naming this agent; next is the sync that imports the repaired files. Local stdio server only.',
  params: {
    ...REPAIR_PARAMS,
    expect: { type: 'string', required: true, description: 'The preview_hash repair_preview returned for this selection.' },
    yes: { type: 'boolean', description: 'The user agreed to the previewed changes.' },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { agentRepairApply, validateKind } = await import('../../commands/repair-agent.ts');
    validateKind(p, typeof p.source_id === 'string' && p.source_id ? p.source_id : ctx.sourceId);
    const sourceId = await targetSource(ctx, p, 'repair_apply');
    return agentRepairApply(ctx.engine, await agentCaller(ctx), p, sourceId);
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const syncStatusOperations: Operation[] = [sync_brain, sync_status, sync_unblock, repair_preview, repair_apply];
