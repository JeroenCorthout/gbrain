/**
 * GBRA-133 PR 3: the MCP tool call that does what a `gbrain` sync or repair command does, so a hold's fix carries an
 * `mcp` twin and `deriveNext` renders `run` for an agent on the local stdio pipe (the fix keeps its argv for the CLI).
 * Only commands whose every flag the tool takes are mapped; anything else has no twin and stays a command.
 * `gbrain sync unblock --apply` maps to the unblock preview and `gbrain repair <kind> --apply` without a hash to the
 * repair preview: an MCP apply binds to the preview's hash (`expect`), which the preview returns.
 */
import type { Action, McpCall } from '../agent-output.ts';

/** `gbrain repair` value flags and the `repair_preview` / `repair_apply` param each maps to (repeatable flags take arrays). */
export const REPAIR_VALUE_PARAMS: Readonly<Record<string, { param: string; many?: true; numeric?: true }>> = {
  '--source': { param: 'source_id' }, '--only': { param: 'only', many: true }, '--skip': { param: 'skip', many: true }, '--slug': { param: 'slug', many: true },
  '--max-usd': { param: 'max_usd', numeric: true }, '--prefer': { param: 'prefer' }, '--request': { param: 'request', many: true }, '--class': { param: 'class' },
  '--since': { param: 'since' }, '--side': { param: 'side' }, '--state': { param: 'state' }, '--keep': { param: 'keep' }, '--request-id': { param: 'request_id' },
  '--older-than': { param: 'older_than' }, '--from': { param: 'from' }, '--limit': { param: 'limit', numeric: true },
};

/** `gbrain repair` boolean flags and their params. */
export const REPAIR_BOOLEAN_PARAMS: Readonly<Record<string, string>> = {
  '--include-ambiguous': 'include_ambiguous', '--no-llm': 'no_llm', '--all-drifted': 'all_drifted', '--held': 'held', '--include-failures': 'include_failures',
  '--force': 'force', '--close': 'close', '--no-embed': 'no_embed',
};

/** Flags that only shape terminal output; a twin ignores them. */
const OUTPUT_FLAGS = new Set(['--json', '--diff']);

function repairTwin(args: readonly string[]): McpCall | undefined {
  const [kind, ...rest] = args;
  if (!kind || kind.startsWith('-')) return undefined;
  const params: Record<string, unknown> = { kind };
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (OUTPUT_FLAGS.has(flag) || flag === '--yes') continue;
    if (flag === '--apply') { apply = true; continue; }
    if (flag === '--expect') { const value = rest[++i]; if (!value) return undefined; params.expect = value; continue; }
    const bool = REPAIR_BOOLEAN_PARAMS[flag];
    if (bool) { params[bool] = true; continue; }
    const value = REPAIR_VALUE_PARAMS[flag];
    const next = rest[i + 1];
    if (!value || next === undefined) return undefined;
    i++;
    if (value.many) params[value.param] = [...((params[value.param] as string[] | undefined) ?? []), next];
    else params[value.param] = value.numeric ? Number(next) : next;
  }
  if (apply && typeof params.expect === 'string') return { tool: 'repair_apply', arguments: { ...params, yes: true } };
  delete params.expect;
  return { tool: 'repair_preview', arguments: params };
}

const SYNC_BRAIN_FLAGS = new Set(['--no-pull', '--no-embed', '--full', '--dry-run']);

function syncTwin(args: readonly string[]): McpCall | undefined {
  const verb = args[0] === 'status' || args[0] === 'unblock' ? args[0] : null;
  const params: Record<string, unknown> = {};
  const flags = verb ? args.slice(1) : args;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === '--json') continue;
    if (flag === '--source') { const value = flags[++i]; if (!value) return undefined; params.source_id = value; continue; }
    if (verb === 'status' && flag === '--detail') { params.detail = true; continue; }
    if (verb === 'unblock' && flag === '--apply') continue;
    if (verb === 'unblock' && (flag === '--no-llm' || flag === '--no-repair')) { params[flag.slice(2).replace(/-/g, '_')] = true; continue; }
    if (!verb && SYNC_BRAIN_FLAGS.has(flag)) { params[flag.slice(2).replace(/-/g, '_')] = true; continue; }
    return undefined;
  }
  if (verb === 'status') return { tool: 'sync_status', arguments: params };
  if (verb === 'unblock') return { tool: 'sync_unblock', arguments: params };
  return typeof params.source_id === 'string' ? { tool: 'sync_brain', arguments: params } : undefined;
}

/** The MCP call that does what `argv` does, or undefined when no tool takes every flag it passes. */
export function mcpTwin(argv: readonly string[] | undefined): McpCall | undefined {
  if (!argv || argv[0] !== 'gbrain') return undefined;
  const [, command, ...rest] = argv;
  if (command === 'repair') return repairTwin(rest);
  if (command === 'sync') return syncTwin(rest);
  if (command === 'sources' && rest[0] === 'status' && rest[1] && !rest[1].startsWith('-') && rest.slice(2).every(arg => arg === '--json')) {
    return { tool: 'sources_status', arguments: { id: rest[1] } };
  }
  if (command === 'write-request' && rest.length === 2 && rest[0] === '--' && !rest[1]!.startsWith('<')) return { tool: 'get_write_request', arguments: { request_id: rest[1] } };
  return undefined;
}

/** `action` with an `mcp` twin on itself, its verify and every `then` step that has none yet. */
export function withMcpTwins(action: Action): Action {
  const mcp = action.mcp ?? mcpTwin(action.argv);
  const verifyMcp = action.verify && !action.verify.mcp ? mcpTwin(action.verify.argv) : undefined;
  return { ...action, ...(mcp ? { mcp } : {}), ...(action.verify ? { verify: { ...action.verify, ...(verifyMcp ? { mcp: verifyMcp } : {}) } } : {}),
    ...(action.then ? { then: withMcpTwins(action.then) } : {}) };
}
