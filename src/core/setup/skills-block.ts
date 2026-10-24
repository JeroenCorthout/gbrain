/**
 * setup/skills-block.ts — the managed `gbrain:skills` block: the always-loaded
 * half of the spring-loaded skill resolver, written beside the brain-first
 * block (brain-first.ts) in the same harness instruction file.
 *
 * Selectable: `--skill-loading spring` (or GBRAIN_SKILL_LOADING=spring) writes
 * it; `off`, the default, writes nothing and strips a block an earlier run
 * wrote. `--no-instructions` strips it with the brain-first block. The block
 * is a compact index of gbrain's bundled skills plus one sentence on loading a
 * skill on demand (spring-index.ts); the skill bodies stay out of the context
 * until a task matches.
 *
 * Ownership is by markers (managed-block.ts): the interior is gbrain's, text
 * outside the markers is never touched. Decisions live in their own ledger,
 * <configDir>/skill-loading.json, keyed on (harness, path), so brain-first's
 * ledger stays as it is. created_file is true when gbrain created the file,
 * through either block, so whichever block is removed last deletes a file
 * nothing else was written into.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { configDir } from '../config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { ensureGitExcluded } from '../context/compiled-core.ts';
import { bundledSkills, type SkillAudience } from '../skills/bundled.ts';
import { renderSkillIndexBlock, SKILL_INDEX_VERSION, type SkillIndexAccess } from '../skills/spring-index.ts';
import { BRAIN_FIRST_END, CURSOR_HEAD, direntExists, readBrainFirstLedger, writeUnlessChanged, type BrainFirstAccess, type BrainFirstTarget } from './brain-first.ts';

export const SKILLS_BLOCK_BEGIN = '<!-- gbrain:skills:begin -->';
export const SKILLS_BLOCK_END = '<!-- gbrain:skills:end -->';
export const SKILL_LOADING_ENV = 'GBRAIN_SKILL_LOADING';
export const SKILL_LOADING_MODES = ['off', 'spring'] as const;
export type SkillLoading = (typeof SKILL_LOADING_MODES)[number];
const MARKERS: BlockMarkers = { begin: SKILLS_BLOCK_BEGIN, end: SKILLS_BLOCK_END, label: 'skills', rerun: 'gbrain setup <harness> --instructions-only --skill-loading spring' };
const LEDGER_FILE = 'skill-loading.json';

export function isSkillLoading(v: unknown): v is SkillLoading {
  return (SKILL_LOADING_MODES as readonly unknown[]).includes(v);
}

/** The access the block names. A verbs-only MCP surface has no get_skill, so it gets the CLI form. */
export function skillIndexAccess(access: BrainFirstAccess): SkillIndexAccess {
  if (access.kind === 'cli') return access;
  return access.surface === 'verbs' ? { kind: 'cli', launcher: 'gbrain' } : { kind: 'mcp', server: access.server };
}

/** The block interior for a harness. Local installs run on the brain host and index every bundled skill. */
export function renderSkillsBlock(harness: string, access: BrainFirstAccess, audience: SkillAudience = 'owner'): string {
  return renderSkillIndexBlock(bundledSkills(audience), skillIndexAccess(access), `gbrain setup ${harness} --instructions-only --skill-loading off`);
}

// ── Ledger ────────────────────────────────────────────────────────────────

export interface SkillLoadingLedgerEntry {
  harness: string;
  path: string;
  mode: SkillLoading;
  block_version: number;
  access: BrainFirstAccess;
  writer: string;
  created_file: boolean;
  updated_at: string;
}

export function skillLoadingLedgerPath(): string { return join(configDir(), LEDGER_FILE); }

export function readSkillLoadingLedger(): SkillLoadingLedgerEntry[] {
  const path = skillLoadingLedgerPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: SkillLoadingLedgerEntry[] };
    return Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e.path === 'string' && typeof e.harness === 'string' && isSkillLoading(e.mode)) : [];
  } catch {
    return [];
  }
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

// ── Decision, inspection, sync, removal ───────────────────────────────────

export type SkillLoadingSource = 'flag' | 'env' | 'prior' | 'default' | 'instructions_off';
export interface SkillLoadingDecision { value: SkillLoading; source: SkillLoadingSource }

/** --skill-loading wins, then GBRAIN_SKILL_LOADING, then the recorded choice, then off. */
export function resolveSkillLoading(flag: SkillLoading | undefined, prior: Pick<SkillLoadingLedgerEntry, 'mode'> | undefined): SkillLoadingDecision {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  const env = process.env[SKILL_LOADING_ENV]?.trim();
  if (isSkillLoading(env)) return { value: env, source: 'env' };
  if (prior) return { value: prior.mode, source: 'prior' };
  return { value: 'off', source: 'default' };
}

export type SkillsBlockState = 'no_file' | 'absent' | 'current' | 'stale' | 'damaged';

export function inspectSkillsBlock(path: string, expected?: string): { state: SkillsBlockState; version?: number } {
  if (!existsSync(path)) return { state: 'no_file' };
  const probe = probeBlock(MARKERS, readFileSync(path, 'utf8'));
  if (probe.state !== 'present') return { state: probe.state };
  const version = Number(/gbrain skills v(\d+)/.exec(probe.interior ?? '')?.[1] ?? 0);
  const current = expected !== undefined ? probe.interior === expected : version === SKILL_INDEX_VERSION;
  return { state: current ? 'current' : 'stale', version };
}

export interface SkillsBlockOutcome {
  harness: string;
  path: string;
  decision: SkillLoadingDecision;
  action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve';
  state_before: SkillsBlockState;
  detail: string;
}

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

/**
 * Make the surface match the decision: write or refresh the block for
 * `spring`, strip it for `off`. Never throws: a damaged block or an
 * unwritable file is reported as `preserve` and the install carries on.
 */
export function syncSkillsBlock(opts: { target: BrainFirstTarget; access: BrainFirstAccess; decision: SkillLoadingDecision; writer: string; dryRun: boolean; audience?: SkillAudience }): SkillsBlockOutcome {
  const { target, access, decision } = opts;
  const body = renderSkillsBlock(target.harness, access, opts.audience);
  const before = inspectSkillsBlock(target.path, body);
  const out = (action: SkillsBlockOutcome['action'], detail: string): SkillsBlockOutcome =>
    ({ harness: target.harness, path: target.path, decision, action, state_before: before.state, detail });
  const prior = priorSkillLoading(target.harness, target.path);
  const record = (mode: SkillLoading, created: boolean) => {
    if (opts.dryRun) return;
    if (mode === 'off' && decision.source === 'default' && !prior) return;
    upsertLedger({ harness: target.harness, path: target.path, mode, block_version: SKILL_INDEX_VERSION, access, writer: opts.writer, created_file: created, updated_at: new Date().toISOString() });
  };
  try {
    if (before.state === 'damaged') {
      return out('preserve', `the skills markers in ${target.path} were hand-edited (duplicate, orphan or out of order); fix or delete them, then re-run`);
    }
    if (decision.value === 'off') {
      if (before.state === 'no_file' || before.state === 'absent') {
        record('off', false);
        return out('skip', `skill loading off: no skills index in ${target.path}`);
      }
      const existing = readFileSync(target.path, 'utf8');
      if (!opts.dryRun) {
        const stripped = removeBlock(MARKERS, existing).text;
        if (ownedEmptyFile(prior?.created_file ?? false, target.path, stripped)) unlinkSync(target.path);
        else writeUnlessChanged(target.path, existing, false, stripped);
      }
      record('off', false);
      return out('remove', `skills index from ${target.path}`);
    }
    const brainFirstCreated = readBrainFirstLedger().find((e) => e.harness === target.harness && e.path === target.path)?.created_file ?? false;
    if (before.state === 'current') {
      record('spring', (prior?.created_file ?? false) || brainFirstCreated);
      return out('keep', `skills index in ${target.path} is current`);
    }
    if (target.harness === 'hermes' && (before.state === 'no_file' || readFileSync(target.path, 'utf8').trim() === '')) {
      return out('skip', `${target.path} is missing or empty, and Hermes uses a non-empty SOUL.md instead of its default identity; start Hermes once (it seeds SOUL.md) or write your identity there, then re-run`);
    }
    const created = before.state === 'no_file' && !direntExists(target.path);
    if (!opts.dryRun) {
      const existing = before.state === 'no_file' ? (created && target.harness === 'cursor' ? CURSOR_HEAD : '') : readFileSync(target.path, 'utf8');
      writeUnlessChanged(target.path, existing, before.state === 'no_file', placeSkillsBlock(existing, body));
      if (created && target.project) {
        try { ensureGitExcluded(target.path); } catch { /* a project file outside git stays as written */ }
      }
    }
    record('spring', created || (prior?.created_file ?? false) || brainFirstCreated);
    return out('write', `skills index ${before.state === 'stale' ? 'refreshed in' : created ? 'in new file' : 'added to'} ${target.path}`);
  } catch (e) {
    return out('preserve', `${target.path} could not be updated (${e instanceof Error ? e.message : String(e)}); nothing else was changed`);
  }
}

/** The uninstall path: strip the block, delete the file only when gbrain created it and nothing else is left, forget the record. */
export function removeSkillsBlock(opts: { harness: string; path: string; dryRun: boolean }): SkillsBlockOutcome {
  const prior = priorSkillLoading(opts.harness, opts.path);
  const before = inspectSkillsBlock(opts.path);
  const decision: SkillLoadingDecision = { value: 'off', source: 'flag' };
  const out = (action: SkillsBlockOutcome['action'], detail: string): SkillsBlockOutcome =>
    ({ harness: opts.harness, path: opts.path, decision, action, state_before: before.state, detail });
  try {
    if (before.state === 'damaged') return out('preserve', `the skills markers in ${opts.path} were hand-edited; remove the block by hand`);
    if (before.state === 'no_file' || before.state === 'absent') {
      if (!opts.dryRun) dropLedger(opts.harness, opts.path);
      return out('skip', `no skills index in ${opts.path}`);
    }
    if (!opts.dryRun) {
      const existing = readFileSync(opts.path, 'utf8');
      const stripped = removeBlock(MARKERS, existing).text;
      const deleteFile = ownedEmptyFile(prior?.created_file ?? false, opts.path, stripped);
      if (deleteFile) unlinkSync(opts.path);
      else writeUnlessChanged(opts.path, existing, false, stripped);
      dropLedger(opts.harness, opts.path);
      return out('remove', `skills index from ${opts.path}${deleteFile ? ' (file removed: gbrain created it and nothing else was in it)' : ''}`);
    }
    return out('remove', `skills index from ${opts.path}`);
  } catch (e) {
    return out('preserve', `${opts.path} could not be updated (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** One human line per outcome, matching setup's step lines. */
export function describeSkillsBlockOutcome(o: SkillsBlockOutcome, dryRun: boolean): string {
  const how = o.decision.value === 'spring' ? 'turn off with --skill-loading off' : 'turn on with --skill-loading spring';
  return `  ${(dryRun && o.action !== 'keep' && o.action !== 'skip' ? `would ${o.action}` : o.action).padEnd(8)} ${'skills'.padEnd(7)} ${o.detail} [${o.decision.source}; ${how}]`;
}
