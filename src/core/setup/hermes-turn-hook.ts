/**
 * hermes-turn-hook.ts — Hermes's native per-turn hook for the brain-first
 * rule: a marked `hooks.pre_llm_call` shell hook in $HERMES_HOME/config.yaml
 * running `<gbrain> hook turn-rule`, whose `{"context": ...}` output Hermes
 * appends to every user message. The block in SOUL.md reaches the system
 * prompt only; this puts the same rule next to each turn.
 *
 * Ownership is by YAML comment markers; text outside them is never touched.
 * gbrain appends its block only when config.yaml has no top-level `hooks:`
 * key (a second one would be invalid YAML) and prints the entry to add by
 * hand otherwise. Hermes runs a shell hook only after approval, so setup
 * records the approval for this exact command in Hermes's own allowlist, the
 * way `gbrain setup codex` writes its hook trust entries. Removal strips the
 * block and that approval.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { load } from 'js-yaml';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { writeUnlessChanged } from './brain-first.ts';

const MARKERS: BlockMarkers = { begin: '# gbrain:turn-rule:begin', end: '# gbrain:turn-rule:end', label: 'turn-rule', rerun: 'gbrain setup hermes --instructions-only' };
const EVENT = 'pre_llm_call';
const ALLOWLIST = 'shell-hooks-allowlist.json';

export interface HermesTurnHookOutcome { action: 'write' | 'keep' | 'print' | 'remove' | 'skip'; path: string; detail: string; snippet?: string }

export const hermesTurnHookCommand = (launcher: string): string => `${launcher} hook turn-rule`;

function hookYaml(command: string): string {
  return `hooks:\n  ${EVENT}:\n    - command: ${JSON.stringify(command)}\n      timeout: 10\n`;
}

interface Allowlist { approvals: Array<Record<string, unknown>> }

function readAllowlist(path: string): Allowlist {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Allowlist;
    return raw && Array.isArray(raw.approvals) ? raw : { ...raw, approvals: [] };
  } catch {
    return { approvals: [] };
  }
}

const approves = (e: Record<string, unknown>, command: string) => e.event === EVENT && e.command === command;

function approve(hermesHome: string, command: string): void {
  const path = join(hermesHome, ALLOWLIST);
  const list = readAllowlist(path);
  if (list.approvals.some((e) => approves(e, command))) return;
  let mtime: string | null = null;
  try { mtime = statSync(command.split(' ')[0]!).mtime.toISOString(); } catch { /* Hermes records null for a missing script too */ }
  list.approvals.push({ event: EVENT, command, approved_at: new Date().toISOString(), script_mtime_at_approval: mtime });
  atomicWriteTextFile(path, `${JSON.stringify(list, null, 2)}\n`, { freshMode: 0o600 });
}

function revoke(hermesHome: string, command: string): void {
  const path = join(hermesHome, ALLOWLIST);
  if (!existsSync(path)) return;
  const list = readAllowlist(path);
  const kept = list.approvals.filter((e) => !approves(e, command));
  if (kept.length !== list.approvals.length) atomicWriteTextFile(path, `${JSON.stringify({ ...list, approvals: kept }, null, 2)}\n`, { freshMode: 0o600 });
}

/** Write or update the hook (accepted decision). Never throws: anything gbrain cannot edit safely is printed to add by hand. */
export function syncHermesTurnHook(opts: { hermesHome: string; launcher: string | null; dryRun: boolean }): HermesTurnHookOutcome {
  const path = join(opts.hermesHome, 'config.yaml');
  const command = hermesTurnHookCommand(opts.launcher ?? 'gbrain');
  const print = (why: string): HermesTurnHookOutcome => ({ action: 'print', path, detail: `${why}; add this to ${path} and approve it when Hermes asks (non-interactive runs: HERMES_ACCEPT_HOOKS=1)`, snippet: hookYaml(command) });
  if (!opts.launcher || !isAbsolute(opts.launcher)) return print('no absolute gbrain launcher (pass --gbrain-bin)');
  if (!existsSync(opts.hermesHome)) return print(`${opts.hermesHome} does not exist yet`);
  try {
    const missing = !existsSync(path);
    const text = missing ? '' : readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    if (probe.state === 'damaged') return print('the gbrain turn-rule markers in config.yaml are damaged');
    if (probe.state === 'absent') {
      const doc = load(text) as Record<string, unknown> | null | undefined;
      if (doc !== null && doc !== undefined && typeof doc !== 'object') return print('config.yaml is not a YAML mapping');
      if (doc && 'hooks' in doc) return print('config.yaml already has a hooks: section, which gbrain does not edit');
    }
    const next = spliceBlock(MARKERS, text, hookYaml(command));
    if (next === text) {
      if (!opts.dryRun) approve(opts.hermesHome, command);
      return { action: 'keep', path, detail: `per-turn rule hook (${EVENT}) in ${path}` };
    }
    if (!opts.dryRun) {
      writeUnlessChanged(path, text, missing, next);
      approve(opts.hermesHome, command);
    }
    return { action: 'write', path, detail: `per-turn rule hook (${EVENT}) in ${path}, approved in ${ALLOWLIST}` };
  } catch (e) {
    return print(`config.yaml could not be updated (${(e as Error).message})`);
  }
}

/** Strip the hook and its approval (decline or --remove). Never throws. */
export function removeHermesTurnHook(opts: { hermesHome: string; dryRun: boolean }): HermesTurnHookOutcome {
  const path = join(opts.hermesHome, 'config.yaml');
  try {
    if (!existsSync(path)) return { action: 'skip', path, detail: `no per-turn rule hook in ${path}` };
    const text = readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    if (probe.state !== 'present') return { action: 'skip', path, detail: `no per-turn rule hook in ${path}` };
    const quoted = /command: (".*")/.exec(probe.interior ?? '')?.[1];
    if (!opts.dryRun) {
      writeUnlessChanged(path, text, false, removeBlock(MARKERS, text).text);
      if (quoted) revoke(opts.hermesHome, JSON.parse(quoted) as string);
    }
    return { action: 'remove', path, detail: `per-turn rule hook removed from ${path}` };
  } catch (e) {
    return { action: 'skip', path, detail: `per-turn rule hook in ${path} left as it is (${(e as Error).message})` };
  }
}
