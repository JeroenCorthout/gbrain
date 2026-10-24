/**
 * GBRA-194: the spring-loaded skills index on the installer lanes beside
 * setup: `gbrain connect --harness … --install` (native config files and the
 * thin-client GBRAIN-INSTRUCTIONS.md), `gbrain bootstrap harness`, the
 * shared installer decision, and doctor's informational report.
 *
 * Protects: every lane writes the index right after the brain-first block
 * only when spring is selected, a hosted or thin connection lists only the
 * skills that are not host-only, opt-outs and removal take the index out,
 * and doctor names a stale index's refresh command without changing status.
 * Fails when: a lane writes an index by default, indexes host-only skills
 * for a remote connection, leaves an index after --remove or
 * --no-instructions, or doctor warns on (or hides) a stale index.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { BRAIN_FIRST_END, brainFirstTargetAt } from '../src/core/setup/brain-first.ts';
import { installerSkillsBlock, loaderAllowRule, readSkillLoadingLedger, SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END } from '../src/core/setup/skills-block.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { removeHarnessSkillsIndex, writeHarnessSkillsIndex } from '../src/core/bootstrap/harness-skills-index.ts';
import { withSkillsIndex } from '../src/commands/doctor/checks/harness-wiring.ts';
import { bundledSkills } from '../src/core/skills/bundled.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const BIN_DIR = mkdtempSync(join(tmpdir(), 'gbrain-skill-bin-'));
const LAUNCHER = join(BIN_DIR, 'gbrain');
writeFileSync(LAUNCHER, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + CLI + '\' "$@"\n');
chmodSync(LAUNCHER, 0o755);
const roots: string[] = [];
afterAll(() => { for (const r of [...roots, BIN_DIR]) rmSync(r, { recursive: true, force: true }); });
function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-lanes-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home, env: {
    HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SKILL_LOADING: undefined, GBRAIN_SURFACE: undefined,
  } };
}
const read = (p: string) => readFileSync(p, 'utf8');
const lines = (t: string) => t.split('\n');
const hostOnly = bundledSkills('owner').filter(s => s.audience === 'owner').map(s => s.name);
const indexed = (t: string) => lines(t.slice(t.indexOf(SKILLS_BLOCK_BEGIN), t.indexOf(SKILLS_BLOCK_END))).filter(l => l.startsWith('- ')).map(l => l.slice(2).split(':')[0]);
const credentials: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_fixture', client_secret: 'fixture-secret-not-real', access_token: 'fixture-token-not-real' };

describe('connect --harness --install', () => {
  for (const [harness, config, instructions] of [
    ['claude-code', '.claude.json', join('.claude', 'CLAUDE.md')],
    ['codex', join('.codex', 'config.toml'), join('.codex', 'AGENTS.md')],
    ['opencode', join('.config', 'opencode', 'opencode.jsonc'), join('.config', 'opencode', 'AGENTS.md')],
  ] as const) {
    test(`${harness}: off by default; spring indexes the non-host skills after brain-first; opt-out and --remove take it out`, async () => {
      const b = box();
      await withEnv(b.env, async () => {
        const configPath = join(b.home, config);
        const file = join(b.home, instructions);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'house rules\n');
        const plain = await installHarnessConnection(credentials, { harness, configPath });
        expect((plain as any).skills.decision).toEqual({ value: 'off', source: 'default' });
        expect(read(file)).not.toContain(SKILLS_BLOCK_BEGIN);

        const spring = await installHarnessConnection(credentials, { harness, configPath, skillLoading: 'spring', gbrainBin: LAUNCHER });
        expect((spring as any).skills.action).toBe('write');
        const text = read(file);
        expect(lines(text).indexOf(SKILLS_BLOCK_BEGIN)).toBe(lines(text).indexOf(BRAIN_FIRST_END) + 1);
        expect(indexed(text)).toEqual(bundledSkills('downstream').map(s => s.name));
        expect(indexed(text).filter(n => hostOnly.includes(n))).toEqual([]);

        expect(((await installHarnessConnection(credentials, { harness, configPath, gbrainBin: LAUNCHER })) as any).skills).toMatchObject({ action: 'keep', decision: { source: 'prior' } });
        const optedOut = await installHarnessConnection(credentials, { harness, configPath, instructions: false });
        expect((optedOut as any).skills).toMatchObject({ action: 'remove', decision: { source: 'instructions_off' } });
        expect(read(file)).toBe('house rules\n');

        await installHarnessConnection(credentials, { harness, configPath, instructions: true, skillLoading: 'spring', gbrainBin: LAUNCHER });
        expect(read(file)).toContain(SKILLS_BLOCK_BEGIN);
        const removed = await installHarnessConnection(credentials, { harness, configPath, remove: true });
        expect((removed as any).skills.action).toBe('remove');
        expect(read(file)).toBe('house rules\n');
      });
    });
  }

  test('thin client: GBRAIN-INSTRUCTIONS.md carries the index after brain-first with the root launcher; the choice is kept', async () => {
    const b = box();
    const root = join(b.root, 'thin');
    await withEnv(b.env, async () => {
      const off = await installHarnessConnection(credentials, { harness: 'openclaw', root });
      expect((off as any).skill_loading).toBe('off');
      expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).not.toContain(SKILLS_BLOCK_BEGIN);
      const on = await installHarnessConnection(credentials, { harness: 'openclaw', root, skillLoading: 'spring' });
      expect((on as any).skill_loading).toBe('spring');
      const text = read(join(root, 'GBRAIN-INSTRUCTIONS.md'));
      expect(lines(text).indexOf(SKILLS_BLOCK_BEGIN)).toBe(lines(text).indexOf(BRAIN_FIRST_END) + 1);
      expect(text).toContain('\`' + join(root, 'bin', 'gbrain') + ' bundled-skill <name>\`');
      expect(indexed(text)).toEqual(bundledSkills('downstream').map(s => s.name));
      await installHarnessConnection(credentials, { harness: 'openclaw', root });
      expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).toBe(text);
      await installHarnessConnection(credentials, { harness: 'openclaw', root, instructions: false });
      expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).not.toContain(SKILLS_BLOCK_BEGIN);
    });
  });
});

describe('bootstrap harness', () => {
  test('spring writes a host index (every bundled skill) beside each confirmed host; removal strips only this lane\'s (deleting a file only the index was in)', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const paths = { claudeMemoryPath: join(b.home, '.claude', 'CLAUDE.md'), codexAgentsPath: join(b.home, '.codex', 'AGENTS.md'),
        codexAgentsOverride: join(b.home, '.codex', 'AGENTS.override.md'), opencodeAgentsPath: join(b.home, '.config', 'opencode', 'AGENTS.md') };
      const log: string[] = [];
      const off = writeHarnessSkillsIndex({ hosts: ['claude-code'], launcher: LAUNCHER, optOut: false, paths, log: (l) => log.push(l) });
      expect(off[0].action).toBe('skip');
      expect(log).toEqual([]);
      const on = writeHarnessSkillsIndex({ hosts: ['claude-code', 'codex'], launcher: LAUNCHER, optOut: false, skillLoading: 'spring', paths, log: (l) => log.push(l) });
      expect(on.map(o => o.action)).toEqual(['write', 'write']);
      expect(indexed(read(paths.claudeMemoryPath))).toEqual(bundledSkills('owner').map(s => s.name));
      expect(read(paths.codexAgentsPath)).toContain('\`' + LAUNCHER + ' bundled-skill <name>\`');

      const other = join(b.home, 'other', 'AGENTS.md');
      installerSkillsBlock({ target: brainFirstTargetAt('opencode', other), launcher: LAUNCHER, writer: 'gbrain setup opencode', brainFirstDeclined: false, skillLoading: 'spring' });
      removeHarnessSkillsIndex(() => {});
      expect(existsSync(paths.claudeMemoryPath)).toBe(false);
      expect(read(other)).toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger().map(e => e.writer)).toEqual(['gbrain setup opencode']);
    });
  });
});

describe('installer decision', () => {
  test('flag, then GBRAIN_SKILL_LOADING, then the recorded choice; a declined brain-first block forces off', async () => {
    const b = box();
    const target = brainFirstTargetAt('opencode', join(b.home, 'agents', 'AGENTS.md'));
    const base = { target, launcher: LAUNCHER, writer: 'test' };
    await withEnv({ ...b.env, GBRAIN_SKILL_LOADING: 'spring' }, async () => {
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: false }).decision).toEqual({ value: 'spring', source: 'env' });
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: false, skillLoading: 'off' }).decision).toEqual({ value: 'off', source: 'flag' });
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: true, skillLoading: 'spring' }).decision).toEqual({ value: 'off', source: 'instructions_off' });
    });
    await withEnv(b.env, async () => {
      installerSkillsBlock({ ...base, brainFirstDeclined: false, skillLoading: 'spring' });
      expect(installerSkillsBlock({ ...base, brainFirstDeclined: false }).decision).toEqual({ value: 'spring', source: 'prior' });
    });
  });
});

describe('doctor: skills index', () => {
  const check = { name: 'harness_wiring', status: 'ok' as const, message: 'Claude Code is wired.' };
  test('a stale or missing index is named with its refresh command and never changes the status', () => {
    const out = withSkillsIndex(check, [
      { harness: 'claude-code', path: '/home/alice-example/.claude/CLAUDE.md', state: 'stale', refresh: 'gbrain setup claude-code --skills-index-only' },
      { harness: 'codex', path: '/home/alice-example/.codex/AGENTS.md', state: 'current', refresh: 'gbrain setup codex --skills-index-only' },
    ]);
    expect(out.status).toBe('ok');
    expect(out.message).toContain('claude-code skills index');
    expect(out.message).toContain('`gbrain setup claude-code --skills-index-only`');
    expect(out.message).not.toContain('codex skills index');
    expect((out.details as any).skills_index).toHaveLength(2);
    const warn = withSkillsIndex({ ...check, status: 'warn' as any }, [{ harness: 'cursor', path: '/p/.cursor/rules/x.mdc', state: 'absent', refresh: 'gbrain setup cursor --instructions-only' }]);
    expect(warn.status).toBe('warn');
  });
  test('no index on: the check is returned unchanged; all current: only details are added', () => {
    expect(withSkillsIndex(check, [])).toBe(check);
    const cur = withSkillsIndex(check, [{ harness: 'codex', path: '/x', state: 'current', refresh: 'r' }]);
    expect(cur.message).toBe(check.message);
  });
});

describe('refusals keep everything as it was', () => {
  test('an invalid GBRAIN_SKILL_LOADING is refused with the allowed values, before any write', async () => {
    const b = box();
    const target = brainFirstTargetAt('opencode', join(b.home, 'agents', 'AGENTS.md'));
    await withEnv({ ...b.env, GBRAIN_SKILL_LOADING: 'lazy' }, async () => {
      const o = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false });
      expect(o).toMatchObject({ action: 'preserve', reason: 'invalid_env' });
      expect(o.detail).toContain('off or spring');
      expect(existsSync(target.path)).toBe(false);
    });
  });

  test('an unreadable ledger is never treated as no record', async () => {
    const b = box();
    const file = join(b.home, 'agents', 'AGENTS.md');
    const target = brainFirstTargetAt('opencode', file);
    await withEnv(b.env, async () => {
      installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      const written = read(file);
      writeFileSync(join(b.home, '.gbrain', 'skill-loading.json'), '{not json');
      const off = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'off' });
      expect(off).toMatchObject({ action: 'preserve', reason: 'ledger_unreadable' });
      expect(read(file)).toBe(written);
      expect(read(join(b.home, '.gbrain', 'skill-loading.json'))).toBe('{not json');
    });
  });

  test('Claude Code: a permission rule gbrain added but cannot remove fails the opt-out and keeps the record', async () => {
    const b = box();
    const file = join(b.home, '.claude', 'CLAUDE.md');
    const settings = join(b.home, '.claude', 'settings.json');
    const target = brainFirstTargetAt('claude-code', file);
    await withEnv(b.env, async () => {
      const on = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'spring' });
      expect(on.permission).toMatchObject({ change: 'added', rule: loaderAllowRule(LAUNCHER) });
      writeFileSync(settings, '{broken');
      const off = installerSkillsBlock({ target, launcher: LAUNCHER, writer: 'test', brainFirstDeclined: false, skillLoading: 'off' });
      expect(off).toMatchObject({ action: 'preserve', reason: 'permission_update_failed' });
      expect(off.detail).toContain(loaderAllowRule(LAUNCHER));
      expect(read(file)).toContain(SKILLS_BLOCK_BEGIN);
      expect(readSkillLoadingLedger()[0]).toMatchObject({ mode: 'spring', allow_owned: true });
    });
  });
});
