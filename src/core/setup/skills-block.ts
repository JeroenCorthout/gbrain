/**
 * setup/skills-block.ts — the managed `gbrain:skills` block: the always-loaded
 * half of the spring-loaded skill resolver, written beside the brain-first
 * block (brain-first.ts) in the same harness instruction file.
 *
 * Selectable: `--skill-loading spring` (or GBRAIN_SKILL_LOADING=spring) writes
 * it; `off`, the default, writes nothing and strips a block an earlier run
 * wrote. `--no-instructions` strips it with the brain-first block. The block
 * is a compact index of gbrain's bundled skills plus one sentence on loading a
 * skill on demand with `<launcher> bundled-skill <name>` (spring-index.ts);
 * the skill bodies stay out of the context until a task matches. The launcher
 * is the same absolute gbrain the install registered, so the index and the
 * text it loads come from one binary, whatever MCP server or brain the
 * harness is connected to.
 *
 * Ownership is by markers (managed-block.ts): the interior is gbrain's, text
 * outside the markers is never touched. Decisions live in their own ledger,
 * <configDir>/skill-loading.json, keyed on (harness, path), so brain-first's
 * ledger stays as it is. created_file is true when gbrain created the file,
 * through either block, so whichever block is removed last deletes a file
 * nothing else was written into.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { resolveGbrainBin } from '../gbrain-bin.ts';
import { addPermissionsAllowEntry, removePermissionsAllowEntry } from '../bootstrap/hooks.ts';
import { claudeUserSettingsPath } from '../bootstrap/host-specs.ts';
import { spawnSync } from '../spawn.ts';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { configDir } from '../config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { ensureGitExcluded } from '../context/compiled-core.ts';
import { bundledCatalogId, bundledSkills, type SkillAudience } from '../skills/bundled.ts';
import { renderSkillIndexBlock, shellWord, SKILL_INDEX_VERSION, SkillIndexTooLarge, skillIndexCatalog } from '../skills/spring-index.ts';
import { BRAIN_FIRST_END, brainFirstTargetAt, CURSOR_HEAD, direntExists, readBrainFirstLedger, writeUnlessChanged, type BrainFirstHarness, type BrainFirstTarget } from './brain-first.ts';

export const SKILLS_BLOCK_BEGIN = '<!-- gbrain:skills:begin -->';
export const SKILLS_BLOCK_END = '<!-- gbrain:skills:end -->';
export const SKILL_LOADING_ENV = 'GBRAIN_SKILL_LOADING';
export const SKILL_LOADING_MODES = ['off', 'spring'] as const;
export type SkillLoading = (typeof SKILL_LOADING_MODES)[number];
const MARKERS: BlockMarkers = { begin: SKILLS_BLOCK_BEGIN, end: SKILLS_BLOCK_END, label: 'skills', rerun: 'gbrain setup <harness> --skills-index-only' };
const LEDGER_FILE = 'skill-loading.json';

export function isSkillLoading(v: unknown): v is SkillLoading {
  return (SKILL_LOADING_MODES as readonly unknown[]).includes(v);
}

/**
 * The command that refreshes every index recorded for a harness after an
 * upgrade: it rewrites only the skills block, at the recorded file, with the
 * recorded launcher and audience, and never touches brain-first.
 */
export function skillsRefreshCommand(harness: string): string {
  return `gbrain setup ${harness} --skills-index-only`;
}

/** The absolute gbrain an index should name when no --gbrain-bin is given: this compiled binary, else the one on PATH. */
export function indexLauncher(): string | null {
  if (basename(process.execPath).startsWith('gbrain')) return process.execPath;
  return resolveGbrainBin();
}

/**
 * The catalog identity the launcher actually serves (`<launcher> bundled-skill
 * --json`), so an index is never written naming a gbrain whose skills differ
 * from the ones indexed (another install earlier on PATH, a stale
 * --gbrain-bin). Engine-free and read-only on the launcher's side.
 */
export function launcherCatalog(launcher: string): { catalog: string } | { error: string } {
  if (!isAbsolute(launcher)) return { error: `${launcher} is not an absolute path (GUI-launched harnesses inherit no PATH)` };
  const r = spawnSync(launcher, ['bundled-skill', '--json'], { encoding: 'utf8', timeout: 20_000 }) as { status: number | null; stdout?: string; stderr?: string; error?: Error };
  if (r.status !== 0) return { error: `${launcher} bundled-skill --json failed: ${(r.error?.message ?? r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`}` };
  try {
    const catalog = (JSON.parse(r.stdout ?? '') as { catalog?: unknown }).catalog;
    return typeof catalog === 'string' ? { catalog } : { error: `${launcher} reported no skill catalog (a gbrain without bundled-skill)` };
  } catch {
    return { error: `${launcher} bundled-skill --json printed no JSON` };
  }
}

/**
 * The block interior for a harness. `owner` (an install on the brain host)
 * indexes every bundled skill; `downstream` (a thin client) leaves out the
 * host-only ones, as `gbrain bundled-skill` does there. Throws
 * SkillIndexTooLarge rather than return a block over budget.
 */
export function renderSkillsBlock(harness: string, launcher: string, audience: SkillAudience = 'owner', how?: { refresh: string; optOut: string }): string {
  return renderSkillIndexBlock(bundledSkills(audience), launcher, how ?? { refresh: skillsRefreshCommand(harness), optOut: `${skillsRefreshCommand(harness)} --skill-loading off` });
}

/** The block with its markers, for a file gbrain writes whole (the thin-client GBRAIN-INSTRUCTIONS.md). */
export function renderSkillsSnippet(harness: string, launcher: string, audience: SkillAudience, how: { refresh: string; optOut: string }): string {
  return `${SKILLS_BLOCK_BEGIN}\n${renderSkillsBlock(harness, launcher, audience, how)}\n${SKILLS_BLOCK_END}\n`;
}

// ── Ledger ────────────────────────────────────────────────────────────────

export interface SkillLoadingLedgerEntry {
  harness: string;
  path: string;
  mode: SkillLoading;
  block_version: number;
  /** The catalog the written block indexes (bundledCatalogId). */
  catalog?: string;
  launcher?: string;
  audience?: SkillAudience;
  /** Claude Code: the permissions.allow rule that lets sessions run the loader, and whether gbrain added it. */
  allow_rule?: string;
  allow_owned?: boolean;
  writer: string;
  created_file: boolean;
  updated_at: string;
}

export function skillLoadingLedgerPath(): string { return join(configDir(), LEDGER_FILE); }

/** A ledger gbrain cannot read: ownership is unknown, so nothing that depends on it is changed. */
export class SkillLedgerUnreadable extends Error {
  constructor(readonly path: string, why: string) {
    super(`${path} is unreadable (${why}); gbrain will not guess which skills indexes and permission rules it owns. Fix the JSON or move the file aside, then re-run`);
  }
}

/** The recorded choices; [] when there is no ledger. Throws SkillLedgerUnreadable for a file it cannot parse. */
export function readSkillLoadingLedger(): SkillLoadingLedgerEntry[] {
  const path = skillLoadingLedgerPath();
  if (!existsSync(path)) return [];
  let raw: { version?: unknown; entries?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as typeof raw;
  } catch (e) {
    throw new SkillLedgerUnreadable(path, e instanceof Error ? e.message : String(e));
  }
  if (raw?.version !== 1 || !Array.isArray(raw.entries)) throw new SkillLedgerUnreadable(path, 'not a version-1 ledger');
  return (raw.entries as SkillLoadingLedgerEntry[]).filter((e) => e && typeof e.path === 'string' && typeof e.harness === 'string' && isSkillLoading(e.mode));
}

function writeLedger(entries: SkillLoadingLedgerEntry[]): void {
  atomicWriteTextFile(skillLoadingLedgerPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { freshMode: 0o600 });
}

function upsertLedger(entry: SkillLoadingLedgerEntry): void {
  writeLedger([...readSkillLoadingLedger().filter((e) => !(e.harness === entry.harness && e.path === entry.path)), entry]);
}

function dropLedger(harness: string, path: string): void {
  const all = readSkillLoadingLedger();
  const rest = all.filter((e) => !(e.harness === harness && e.path === path));
  if (rest.length !== all.length) writeLedger(rest);
}

export function priorSkillLoading(harness: string, path: string): SkillLoadingLedgerEntry | undefined {
  return readSkillLoadingLedger().find((e) => e.harness === harness && e.path === path);
}

// ── Loader permission (Claude Code) ───────────────────────────────────────

/**
 * Claude Code asks before every Bash call it has no rule for, and headless
 * runs deny it, so a spring index on Claude Code comes with one narrow rule
 * in the user settings: the recorded launcher's `bundled-skill` subcommand
 * only, written exactly as the index writes the command. Ownership lives in
 * the ledger (allow_owned): gbrain removes the rule only when it added it and
 * no other recorded index still uses it.
 */
export function loaderAllowRule(launcher: string): string {
  return `Bash(${shellWord(launcher)} bundled-skill:*)`;
}

type Grant = Pick<SkillLoadingLedgerEntry, 'allow_rule' | 'allow_owned'>;

/** Add the rule after the block is in place; returns the ownership to record. Throws when settings cannot be updated. */
function grantLoader(harness: string, launcher: string, prior: SkillLoadingLedgerEntry | undefined): Grant {
  if (harness !== 'claude-code') return {};
  const rule = loaderAllowRule(launcher);
  const added = addPermissionsAllowEntry(claudeUserSettingsPath(), rule).added === true;
  return { allow_rule: rule, allow_owned: added || (prior?.allow_rule === rule && prior.allow_owned === true) };
}

/** Remove a rule gbrain owns once nothing else uses it. Returns why it could not, or undefined when done (or nothing to do). */
function revokeLoader(entry: SkillLoadingLedgerEntry | undefined, keepRule?: string): string | undefined {
  if (!entry?.allow_rule || entry.allow_owned !== true || entry.allow_rule === keepRule) return undefined;
  const stillUsed = readSkillLoadingLedger().some((e) => e.mode === 'spring' && e.allow_rule === entry.allow_rule && !(e.harness === entry.harness && e.path === entry.path));
  if (stillUsed) return undefined;
  const settings = claudeUserSettingsPath();
  const r = removePermissionsAllowEntry(settings, entry.allow_rule);
  const warning = r.notes.find((n) => n.startsWith('WARNING'));
  return warning ? `the Claude Code permission rule ${entry.allow_rule} that gbrain added is still in ${settings}: ${warning}` : undefined;
}

// ── Decision, inspection, sync, removal ───────────────────────────────────

export type SkillLoadingSource = 'flag' | 'env' | 'prior' | 'default' | 'instructions_off';
export interface SkillLoadingDecision { value: SkillLoading; source: SkillLoadingSource }

/** GBRAIN_SKILL_LOADING holds something other than off or spring. */
export class InvalidSkillLoadingEnv extends Error {
  constructor(readonly value: string) {
    super(`${SKILL_LOADING_ENV}='${value}' is not a skill-loading mode; set it to off or spring, or unset it`);
  }
}

/** --skill-loading wins, then GBRAIN_SKILL_LOADING, then the recorded choice, then off. An invalid env value throws. */
export function resolveSkillLoading(flag: SkillLoading | undefined, prior: Pick<SkillLoadingLedgerEntry, 'mode'> | undefined): SkillLoadingDecision {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  const env = process.env[SKILL_LOADING_ENV]?.trim();
  if (env) {
    if (!isSkillLoading(env)) throw new InvalidSkillLoadingEnv(env);
    return { value: env, source: 'env' };
  }
  if (prior) return { value: prior.mode, source: 'prior' };
  return { value: 'off', source: 'default' };
}

export type SkillsBlockState = 'no_file' | 'absent' | 'current' | 'stale' | 'damaged';

/**
 * The block's state. With `expected` (the interior this run would write),
 * current means identical; without it, current means the block indexes this
 * gbrain's catalog (same index version and catalog identity).
 */
export function inspectSkillsBlock(path: string, expected?: string): { state: SkillsBlockState; version?: number; catalog?: string } {
  if (!existsSync(path)) return { state: 'no_file' };
  const probe = probeBlock(MARKERS, readFileSync(path, 'utf8'));
  if (probe.state !== 'present') return { state: probe.state };
  const interior = probe.interior ?? '';
  const version = Number(/gbrain skills v(\d+)/.exec(interior)?.[1] ?? 0);
  const catalog = skillIndexCatalog(interior);
  const current = expected !== undefined ? interior === expected : version === SKILL_INDEX_VERSION && catalog === bundledCatalogId();
  return { state: current ? 'current' : 'stale', version, ...(catalog ? { catalog } : {}) };
}

/** Why an outcome is `preserve` (or a skip that needs the user), stable for JSON consumers. */
export type SkillsBlockReason = 'damaged_markers' | 'index_too_large' | 'launcher_unusable' | 'launcher_catalog_mismatch'
  | 'ledger_unreadable' | 'invalid_env' | 'permission_update_failed' | 'write_failed' | 'recorded_partially' | 'hermes_soul_missing';

export interface SkillsBlockOutcome {
  harness: string;
  path: string;
  decision: SkillLoadingDecision;
  action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve';
  state_before: SkillsBlockState;
  detail: string;
  reason?: SkillsBlockReason;
  /** Claude Code: the loader rule this run added to (or removed from) the user settings. */
  permission?: { rule: string; settings: string; change: 'added' | 'removed' };
}

/** A spring request (or an explicit off) that left the surface unchanged: the install did not do what was asked. */
export const skillsOutcomeFailed = (o: SkillsBlockOutcome | null | undefined): boolean =>
  !!o && o.action === 'preserve' && (o.decision.value === 'spring' || o.decision.source !== 'default');

function ownedEmptyFile(createdFile: boolean, path: string, stripped: string): boolean {
  return createdFile && !lstatSync(path).isSymbolicLink() && (stripped.trim() === '' || stripped === CURSOR_HEAD);
}

/** Splice the block in place; a new block goes right after the brain-first block when there is one, else at the end. */
export function placeSkillsBlock(existing: string, body: string): string {
  if (probeBlock(MARKERS, existing).state === 'present') return spliceBlock(MARKERS, existing, body);
  const lines = existing.split('\n');
  const at = lines.findIndex((l) => l.replace(/\r$/, '') === BRAIN_FIRST_END);
  if (at < 0) return spliceBlock(MARKERS, existing, body);
  const block = spliceBlock(MARKERS, '', body).replace(/\n$/, '').split('\n');
  return [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)].join('\n');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Make the surface match the decision: write or refresh the block for
 * `spring`, strip it for `off`. Never throws: every refusal is a `preserve`
 * outcome with a reason, and the file is left as it was unless the detail
 * says otherwise.
 */
export function syncSkillsBlock(opts: { target: BrainFirstTarget; launcher: string; decision: SkillLoadingDecision; writer: string; dryRun: boolean; audience?: SkillAudience; verifyLauncher?: boolean }): SkillsBlockOutcome {
  const { target, launcher, decision } = opts;
  const audience = opts.audience ?? 'owner';
  let body: string | undefined;
  let tooLarge: SkillIndexTooLarge | undefined;
  try {
    body = renderSkillsBlock(target.harness, launcher, audience);
  } catch (e) {
    if (!(e instanceof SkillIndexTooLarge)) throw e;
    tooLarge = e;
  }
  const before = inspectSkillsBlock(target.path, body);
  const out = (action: SkillsBlockOutcome['action'], detail: string, extra: Partial<SkillsBlockOutcome> = {}): SkillsBlockOutcome =>
    ({ harness: target.harness, path: target.path, decision, action, state_before: before.state, detail, ...extra });
  let prior: SkillLoadingLedgerEntry | undefined;
  try {
    prior = priorSkillLoading(target.harness, target.path);
  } catch (e) {
    return out('preserve', `${message(e)}; ${target.path} was left as it was`, { reason: 'ledger_unreadable' });
  }
  const record = (mode: SkillLoading, created: boolean, grant: Grant = {}) => {
    if (opts.dryRun) return;
    if (mode === 'off' && decision.source === 'default' && !prior) return;
    upsertLedger({ harness: target.harness, path: target.path, mode, block_version: SKILL_INDEX_VERSION, ...(mode === 'spring' ? { catalog: bundledCatalogId(), launcher, audience, ...grant } : {}), writer: opts.writer, created_file: created, updated_at: new Date().toISOString() });
  };
  const revoked = (rule: string | undefined): Partial<SkillsBlockOutcome> =>
    rule ? { permission: { rule, settings: claudeUserSettingsPath(), change: 'removed' } } : {};

  if (before.state === 'damaged') {
    return out('preserve', `the skills markers in ${target.path} were hand-edited (duplicate, orphan or out of order); fix or delete them, then re-run`, { reason: 'damaged_markers' });
  }
  if (decision.value === 'off') {
    if (!opts.dryRun) {
      const stuck = revokeLoader(prior);
      if (stuck) return out('preserve', `${stuck}; remove it by hand, then re-run. ${target.path} was left as it was`, { reason: 'permission_update_failed' });
    }
    const ownedRule = prior?.allow_owned ? prior.allow_rule : undefined;
    if (before.state === 'no_file' || before.state === 'absent') {
      try { record('off', false); } catch (e) { return out('preserve', `recording the opt-out failed: ${message(e)}`, { reason: 'write_failed' }); }
      return out('skip', `skill loading off: no skills index in ${target.path}`, revoked(ownedRule));
    }
    try {
      const existing = readFileSync(target.path, 'utf8');
      if (!opts.dryRun) {
        const stripped = removeBlock(MARKERS, existing).text;
        if (ownedEmptyFile(prior?.created_file ?? false, target.path, stripped)) unlinkSync(target.path);
        else writeUnlessChanged(target.path, existing, false, stripped);
      }
    } catch (e) {
      return out('preserve', `${target.path} could not be updated (${message(e)}); the skills index is still there`, { reason: 'write_failed' });
    }
    try { record('off', false); } catch (e) {
      return out('preserve', `the skills index was removed from ${target.path}, but recording the opt-out in ${skillLoadingLedgerPath()} failed (${message(e)}); re-run to record it`, { reason: 'recorded_partially' });
    }
    return out('remove', `skills index from ${target.path}`, revoked(ownedRule));
  }

  if (body === undefined) return out('preserve', `${tooLarge!.message}; ${target.path} was left as it was`, { reason: 'index_too_large' });
  if (opts.verifyLauncher !== false) {
    const served = launcherCatalog(launcher);
    if ('error' in served) return out('preserve', `${served.error}; ${target.path} was left as it was. Pass --gbrain-bin <absolute path of this gbrain>`, { reason: 'launcher_unusable' });
    if (served.catalog !== bundledCatalogId()) {
      return out('preserve', `${launcher} serves skill catalog ${served.catalog}, not this gbrain's ${bundledCatalogId()}, so the index would load other text than it lists; ${target.path} was left as it was. Pass --gbrain-bin <absolute path of this gbrain>, or upgrade that install`, { reason: 'launcher_catalog_mismatch' });
    }
  }
  if (target.harness === 'hermes' && (before.state === 'no_file' || readFileSync(target.path, 'utf8').trim() === '')) {
    return out('skip', `${target.path} is missing or empty, and Hermes uses a non-empty SOUL.md instead of its default identity; start Hermes once (it seeds SOUL.md) or write your identity there, then re-run`, { reason: 'hermes_soul_missing' });
  }
  const brainFirstCreated = readBrainFirstLedger().find((e) => e.harness === target.harness && e.path === target.path)?.created_file ?? false;
  const created = before.state === 'no_file' && !direntExists(target.path);
  const createdFile = created || (prior?.created_file ?? false) || brainFirstCreated;
  if (before.state !== 'current' && !opts.dryRun) {
    try {
      const existing = before.state === 'no_file' ? (created && target.harness === 'cursor' ? CURSOR_HEAD : '') : readFileSync(target.path, 'utf8');
      writeUnlessChanged(target.path, existing, before.state === 'no_file', placeSkillsBlock(existing, body));
      if (created && target.project) {
        try { ensureGitExcluded(target.path); } catch { /* a project file outside git stays as written */ }
      }
    } catch (e) {
      return out('preserve', `${target.path} could not be updated (${message(e)}); nothing was changed`, { reason: 'write_failed' });
    }
  }
  const done = before.state === 'current'
    ? out('keep', `skills index in ${target.path} is current`)
    : out('write', `skills index ${before.state === 'stale' ? 'refreshed in' : created ? 'in new file' : 'added to'} ${target.path}`);
  if (opts.dryRun) return done;
  let grant: Grant = {};
  let permissionProblem: string | undefined;
  try {
    grant = grantLoader(target.harness, launcher, prior);
    permissionProblem = revokeLoader(prior, grant.allow_rule);
  } catch (e) {
    permissionProblem = `the Claude Code permission rule ${loaderAllowRule(launcher)} could not be added to ${claudeUserSettingsPath()} (${message(e)}), so Claude Code will ask before each skill load`;
  }
  try {
    record('spring', createdFile, grant);
  } catch (e) {
    return out('preserve', `the skills index is in ${target.path}, but recording it in ${skillLoadingLedgerPath()} failed (${message(e)}); re-run to record it${grant.allow_owned ? ` (gbrain also added ${grant.allow_rule} to ${claudeUserSettingsPath()})` : ''}`, { reason: 'recorded_partially' });
  }
  if (permissionProblem) return { ...done, action: 'preserve', detail: `${done.detail}; ${permissionProblem}`, reason: 'permission_update_failed' };
  const added = grant.allow_rule && grant.allow_owned && prior?.allow_rule !== grant.allow_rule;
  return added ? { ...done, detail: `${done.detail}; Claude Code may now run ${grant.allow_rule}`, permission: { rule: grant.allow_rule!, settings: claudeUserSettingsPath(), change: 'added' } } : done;
}

/** The uninstall path: strip the block, delete the file only when gbrain created it and nothing else is left, forget the record. */
export function removeSkillsBlock(opts: { harness: string; path: string; dryRun: boolean }): SkillsBlockOutcome {
  const before = inspectSkillsBlock(opts.path);
  const decision: SkillLoadingDecision = { value: 'off', source: 'flag' };
  const out = (action: SkillsBlockOutcome['action'], detail: string, extra: Partial<SkillsBlockOutcome> = {}): SkillsBlockOutcome =>
    ({ harness: opts.harness, path: opts.path, decision, action, state_before: before.state, detail, ...extra });
  let prior: SkillLoadingLedgerEntry | undefined;
  try {
    prior = priorSkillLoading(opts.harness, opts.path);
  } catch (e) {
    return out('preserve', `${message(e)}; ${opts.path} was left as it was`, { reason: 'ledger_unreadable' });
  }
  if (before.state === 'damaged') return out('preserve', `the skills markers in ${opts.path} were hand-edited; remove the block by hand`, { reason: 'damaged_markers' });
  if (opts.dryRun) return before.state === 'no_file' || before.state === 'absent' ? out('skip', `no skills index in ${opts.path}`) : out('remove', `skills index from ${opts.path}`);
  const stuck = revokeLoader(prior);
  if (stuck) return out('preserve', `${stuck}; remove it by hand, then re-run. ${opts.path} was left as it was`, { reason: 'permission_update_failed' });
  const permission: Partial<SkillsBlockOutcome> = prior?.allow_owned && prior.allow_rule ? { permission: { rule: prior.allow_rule, settings: claudeUserSettingsPath(), change: 'removed' } } : {};
  let deleteFile = false;
  if (before.state !== 'no_file' && before.state !== 'absent') {
    try {
      const existing = readFileSync(opts.path, 'utf8');
      const stripped = removeBlock(MARKERS, existing).text;
      deleteFile = ownedEmptyFile(prior?.created_file ?? false, opts.path, stripped);
      if (deleteFile) unlinkSync(opts.path);
      else writeUnlessChanged(opts.path, existing, false, stripped);
    } catch (e) {
      return out('preserve', `${opts.path} could not be updated (${message(e)}); the skills index is still there`, { reason: 'write_failed' });
    }
  }
  try { dropLedger(opts.harness, opts.path); } catch (e) {
    return out('preserve', `the skills index was removed from ${opts.path}, but ${skillLoadingLedgerPath()} could not be updated (${message(e)}); re-run to finish`, { reason: 'recorded_partially' });
  }
  return before.state === 'no_file' || before.state === 'absent'
    ? out('skip', `no skills index in ${opts.path}`, permission)
    : out('remove', `skills index from ${opts.path}${deleteFile ? ' (file removed: gbrain created it and nothing else was in it)' : ''}`, permission);
}

/** One human line per outcome, matching setup's step lines. */
export function describeSkillsBlockOutcome(o: SkillsBlockOutcome, dryRun: boolean): string {
  const how = o.decision.value === 'spring' ? 'turn off with --skill-loading off' : 'turn on with --skill-loading spring';
  return `  ${(dryRun && o.action !== 'keep' && o.action !== 'skip' ? `would ${o.action}` : o.action).padEnd(8)} ${'skills'.padEnd(7)} ${o.detail} [${o.decision.source}; ${how}]`;
}

/**
 * The installer lanes (`gbrain connect --install`, `gbrain connect --harness`,
 * `gbrain bootstrap harness`): the same decision as setup (flag, then
 * GBRAIN_SKILL_LOADING, then the recorded choice, then off), with the
 * brain-first outcome deciding `--no-instructions`. Never throws.
 */
export function installerSkillsBlock(opts: {
  target: BrainFirstTarget; launcher: string; writer: string; brainFirstDeclined: boolean;
  skillLoading?: SkillLoading; audience?: SkillAudience; remove?: boolean; dryRun?: boolean;
}): SkillsBlockOutcome {
  if (opts.remove) return removeSkillsBlock({ harness: opts.target.harness, path: opts.target.path, dryRun: opts.dryRun ?? false });
  let decision: SkillLoadingDecision;
  try {
    decision = opts.brainFirstDeclined
      ? { value: 'off', source: 'instructions_off' }
      : resolveSkillLoading(opts.skillLoading, priorSkillLoading(opts.target.harness, opts.target.path));
  } catch (e) {
    const reason: SkillsBlockReason = e instanceof InvalidSkillLoadingEnv ? 'invalid_env' : 'ledger_unreadable';
    return { harness: opts.target.harness, path: opts.target.path, decision: { value: 'off', source: 'flag' }, action: 'preserve', state_before: inspectSkillsBlock(opts.target.path).state, detail: `${message(e)}; ${opts.target.path} was left as it was`, reason };
  }
  return syncSkillsBlock({ target: opts.target, launcher: opts.launcher, decision, writer: opts.writer, dryRun: opts.dryRun ?? false, audience: opts.audience });
}

/** A preserve outcome when the ledger cannot be read, else undefined. */
function ledgerProblem(): SkillsBlockOutcome | undefined {
  try {
    readSkillLoadingLedger();
    return undefined;
  } catch (e) {
    return { harness: '*', path: skillLoadingLedgerPath(), decision: { value: 'off', source: 'flag' }, action: 'preserve', state_before: 'damaged', detail: message(e), reason: 'ledger_unreadable' };
  }
}

/** Removal for a lane that records its writer: strip every index that writer wrote. */
export function removeSkillsBlocksBy(writer: string, dryRun = false): SkillsBlockOutcome[] {
  const unreadable = ledgerProblem();
  if (unreadable) return [unreadable];
  return readSkillLoadingLedger().filter((e) => e.writer === writer && e.mode === 'spring').map((e) => removeSkillsBlock({ harness: e.harness, path: e.path, dryRun }));
}

export interface SkillsIndexView { harness: string; path: string; state: SkillsBlockState; refresh: string }

/**
 * Doctor's read of every index the ledger says is on: current, stale (an
 * upgrade changed the catalog), absent (the block was deleted by hand),
 * damaged or no_file. Informational only: a stale index still loads skills
 * by name, so doctor names the refresh command and never warns on it.
 */
export function skillsIndexViews(): SkillsIndexView[] {
  if (ledgerProblem()) return [{ harness: '*', path: skillLoadingLedgerPath(), state: 'damaged', refresh: `fix the JSON in ${skillLoadingLedgerPath()} or move it aside, then re-run gbrain setup <harness> --skill-loading spring` }];
  return readSkillLoadingLedger().filter((e) => e.mode === 'spring').map((e) => ({
    harness: e.harness, path: e.path, state: inspectSkillsBlock(e.path).state, refresh: skillsRefreshCommand(e.harness),
  }));
}


/**
 * `gbrain setup <harness> --skills-index-only` (the refresh the block header
 * and doctor name): re-render every index the ledger records for the
 * harness, in its recorded file, with its recorded launcher (or
 * --gbrain-bin), audience and writer. Brain-first and every other file are
 * left alone. `off` strips them all and records the opt-out.
 */
export function refreshSkillsIndexes(harness: BrainFirstHarness, opts: { off: boolean; launcher?: string; dryRun: boolean }): SkillsBlockOutcome[] {
  const unreadable = ledgerProblem();
  if (unreadable) return [unreadable];
  return readSkillLoadingLedger().filter((e) => e.harness === harness && (opts.off || e.mode === 'spring')).map((e) => syncSkillsBlock({
    target: brainFirstTargetAt(harness, e.path),
    launcher: opts.launcher ?? e.launcher ?? indexLauncher() ?? 'gbrain',
    audience: e.audience ?? 'owner',
    decision: opts.off ? { value: 'off', source: 'flag' } : { value: 'spring', source: 'prior' },
    writer: e.writer,
    dryRun: opts.dryRun,
  }));
}
