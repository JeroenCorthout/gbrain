/**
 * GBRA-194: `--skill-loading spring` writes the spring-loaded skill index
 * (src/core/setup/skills-block.ts) beside the brain-first block in each
 * writable harness's instruction file; `off` (the default) writes nothing.
 * Per harness this pins:
 *  - placement: the index lands right after the brain-first block, text
 *    outside both blocks is byte-identical;
 *  - default off: a plain install writes no index;
 *  - idempotence and remembered choice: a re-run without the flag keeps the
 *    recorded mode; `off` strips the index and is remembered;
 *  - --no-instructions strips both blocks; --remove strips both and deletes a
 *    file only gbrain created once nothing else is in it, in either order;
 *  - Hermes: SOUL.md is never created;
 *  - dry-run writes nothing; GBRAIN_SKILL_LOADING selects the mode; a bad
 *    value is refused.
 * Spawns `bun src/cli.ts setup` against a temp HOME / GBRAIN_HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { BRAIN_FIRST_BEGIN, BRAIN_FIRST_END } from '../src/core/setup/brain-first.ts';
import { inspectSkillsBlock, renderSkillsBlock, SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END } from '../src/core/setup/skills-block.ts';
import { bundledCatalogId } from '../src/core/skills/bundled.ts';

const LAUNCHER = '/opt/alice-example/bin/gbrain';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { home: string; project: string; env: Record<string, string | undefined> }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-loading-'));
  roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { home, project, env: {
    HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SKILL_LOADING: undefined,
  } };
}
async function setup(b: Box, args: string[], env: Record<string, string | undefined> = {}) {
  const r = await runCli(['setup', ...args, '--json'], { env: { ...b.env, ...env }, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const read = (p: string) => readFileSync(p, 'utf8');
const count = (text: string, line: string) => text.split('\n').filter((l) => l === line).length;
const outside = (text: string) => text
  .replace(new RegExp(`${BRAIN_FIRST_BEGIN}[\\s\\S]*?${BRAIN_FIRST_END}\\n`), '')
  .replace(new RegExp(`${SKILLS_BLOCK_BEGIN}[\\s\\S]*?${SKILLS_BLOCK_END}\\n`), '');

interface Lane { harness: string; file: (b: Box) => string; existing: string; refusesCreate?: boolean }
const LANES: Lane[] = [
  { harness: 'claude-code', file: (b) => join(b.home, '.claude', 'CLAUDE.md'), existing: '# My rules\n\nAlways answer in French.\n' },
  { harness: 'codex', file: (b) => join(b.home, '.codex', 'AGENTS.md'), existing: '# Codex house rules\n- run the tests\n' },
  { harness: 'opencode', file: (b) => join(b.home, '.config', 'opencode', 'AGENTS.md'), existing: 'Prefer small diffs.\n' },
  { harness: 'openclaw', file: (b) => join(b.home, '.openclaw', 'workspace', 'AGENTS.md'), existing: '# AGENTS.md\n\n## Tools\nUse the calendar skill.\n' },
  { harness: 'hermes', file: (b) => join(b.home, '.hermes', 'SOUL.md'), existing: 'You are Hermes, a careful assistant named alice-example.\n', refusesCreate: true },
  { harness: 'cursor', file: (b) => join(b.project, '.cursor', 'rules', 'gbrain-brain-first.mdc'), existing: '---\ndescription: team rule\nalwaysApply: true\n---\nUse tabs.\n' },
];

for (const lane of LANES) {
  describe(`skill loading: ${lane.harness}`, () => {
    const run = (b: Box, extra: string[] = [], env: Record<string, string | undefined> = {}) => setup(b, [lane.harness, '--instructions-only', '--gbrain-bin', LAUNCHER, ...extra], env);
    const seed = (b: Box) => { mkdirSync(dirname(lane.file(b)), { recursive: true }); writeFileSync(lane.file(b), lane.existing); };

    test('default off writes no index; spring places it right after brain-first and keeps outside text', async () => {
      const b = box(); seed(b);
      const plain = await run(b);
      expect(plain.exitCode).toBe(0);
      expect(read(lane.file(b))).not.toContain(SKILLS_BLOCK_BEGIN);
      expect(plain.doc.skills.decision).toEqual({ value: 'off', source: 'default' });
      expect(existsSync(join(b.home, '.gbrain', 'skill-loading.json'))).toBe(false);

      const r = await run(b, ['--skill-loading', 'spring']);
      expect(r.exitCode).toBe(0);
      expect(r.doc.skills.action).toBe('write');
      const text = read(lane.file(b));
      expect(count(text, SKILLS_BLOCK_BEGIN)).toBe(1);
      const lines = text.split('\n');
      expect(lines.indexOf(SKILLS_BLOCK_BEGIN)).toBe(lines.indexOf(BRAIN_FIRST_END) + 1);
      expect(text).toContain(renderSkillsBlock(lane.harness, LAUNCHER));
      expect(outside(text)).toBe(lane.existing);
    });

    test('the choice is remembered; off strips and is remembered; a re-run is byte-identical', async () => {
      const b = box(); seed(b);
      await run(b, ['--skill-loading', 'spring']);
      const once = read(lane.file(b));
      const again = await run(b);
      expect(again.doc.skills).toMatchObject({ action: 'keep', decision: { value: 'spring', source: 'prior' } });
      expect(read(lane.file(b))).toBe(once);
      const off = await run(b, ['--skill-loading', 'off']);
      expect(off.doc.skills.action).toBe('remove');
      expect(read(lane.file(b))).not.toContain(SKILLS_BLOCK_BEGIN);
      expect(read(lane.file(b))).toContain(BRAIN_FIRST_BEGIN);
      expect((await run(b)).doc.skills.decision).toEqual({ value: 'off', source: 'prior' });
      expect(read(lane.file(b))).not.toContain(SKILLS_BLOCK_BEGIN);
    });

    test('--no-instructions strips both blocks; --dry-run writes nothing', async () => {
      const b = box(); seed(b);
      const dry = await run(b, ['--skill-loading', 'spring', '--dry-run']);
      expect(dry.exitCode).toBe(0);
      expect(read(lane.file(b))).toBe(lane.existing);
      expect(existsSync(join(b.home, '.gbrain', 'skill-loading.json'))).toBe(false);
      await run(b, ['--skill-loading', 'spring']);
      const r = await run(b, ['--no-instructions']);
      expect(r.doc.skills).toMatchObject({ action: 'remove', decision: { value: 'off', source: 'instructions_off' } });
      expect(read(lane.file(b))).toBe(lane.existing);
    });

    test(lane.refusesCreate ? 'a missing SOUL.md is never created' : 'a file gbrain created goes away only when both blocks are removed, in either order', async () => {
      const b = box();
      const r = await run(b, ['--skill-loading', 'spring']);
      if (lane.refusesCreate) {
        expect(existsSync(lane.file(b))).toBe(false);
        expect(r.doc.skills.action).toBe('skip');
        return;
      }
      expect(read(lane.file(b))).toContain(SKILLS_BLOCK_BEGIN);
      await run(b, ['--skill-loading', 'off']);
      expect(existsSync(lane.file(b))).toBe(true);
      await run(b, ['--skill-loading', 'spring']);
      const removed = await run(b, ['--remove']);
      expect(removed.exitCode).toBe(0);
      expect(existsSync(lane.file(b))).toBe(false);

      const c = box();
      await run(c, ['--skill-loading', 'spring']);
      await run(c, ['--no-instructions']);
      expect(existsSync(lane.file(c))).toBe(false);
    });
  });
}

describe('skill loading: selection', () => {
  test('GBRAIN_SKILL_LOADING=spring selects it; the flag wins over the env', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only'], { GBRAIN_SKILL_LOADING: 'spring' });
    expect(r.doc.skills.decision).toEqual({ value: 'spring', source: 'env' });
    const off = await setup(b, ['claude-code', '--instructions-only', '--skill-loading', 'off'], { GBRAIN_SKILL_LOADING: 'spring' });
    expect(off.doc.skills.decision).toEqual({ value: 'off', source: 'flag' });
  });

  test('an unknown --skill-loading value is refused before anything is written', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only', '--skill-loading', 'lazy']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('--skill-loading');
    expect(existsSync(join(b.home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  test('the index names the absolute launcher the install recorded, whatever the MCP surface', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring', '--surface', 'verbs']);
    expect(r.exitCode).toBe(0);
    const text = read(join(b.home, '.claude', 'CLAUDE.md'));
    expect(text).toContain('`' + LAUNCHER + ' bundled-skill <name>`');
    expect(text).not.toContain('get_skill');
    const ledger = JSON.parse(read(join(b.home, '.gbrain', 'skill-loading.json')));
    expect(ledger.entries[0]).toMatchObject({ harness: 'claude-code', mode: 'spring', launcher: LAUNCHER, audience: 'owner', catalog: bundledCatalogId() });
  });

  test('an index an upgrade left behind (older catalog) is reported stale and a bare re-run refreshes it', async () => {
    const b = box();
    const file = join(b.home, '.claude', 'CLAUDE.md');
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER, '--skill-loading', 'spring']);
    const current = read(file);
    const older = current.replace('catalog ' + bundledCatalogId(), 'catalog 000000000000').replace(/^- brain-ops:.*$/m, '- brain-ops: an older trigger');
    expect(older).not.toBe(current);
    writeFileSync(file, older);
    expect(inspectSkillsBlock(file).state).toBe('stale');
    const r = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', LAUNCHER]);
    expect(r.doc.skills).toMatchObject({ action: 'write', state_before: 'stale', decision: { value: 'spring', source: 'prior' } });
    expect(read(file)).toBe(current);
    expect(inspectSkillsBlock(file).state).toBe('current');
  });
});
