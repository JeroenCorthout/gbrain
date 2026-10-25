/**
 * The per-turn brain-first rule (src/core/setup/brain-first.ts): one line a
 * harness's per-turn hook puts beside every user turn. Pins who gets it and
 * when it is off: Claude Code / Codex UserPromptSubmit (only while a block is
 * installed for that harness), Hermes `gbrain hook turn-rule` and the
 * config.yaml hook setup writes for it, OpenClaw's context engine (on unless
 * declined), and the opt-out for all of them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { withEnv } from './helpers/with-env.ts';
import { brainFirstTurnRule, renderBrainFirstTurnRule, type BrainFirstAccess } from '../src/core/setup/brain-first.ts';
import { runHook } from '../src/commands/hook.ts';
import { createGBrainContextEngine } from '../src/core/context-engine.ts';
import { removeHermesTurnHook, syncHermesTurnHook } from '../src/core/setup/hermes-turn-hook.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function home(entries: Array<{ harness: string; status: 'installed' | 'declined'; access?: BrainFirstAccess }> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-turn-rule-'));
  roots.push(root);
  if (entries) {
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(join(root, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: entries.map((e, i) => ({
      path: join(root, `file-${i}.md`), block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: false,
      updated_at: new Date(Date.UTC(2026, 9, 25, 0, i)).toISOString(), ...e,
    })) }));
  }
  return root;
}

const env = (root: string, extra: Record<string, string | undefined> = {}) => ({ GBRAIN_HOME: root, GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_HOOKS: undefined, ...extra });

async function userPrompt(root: string, harness?: string, extra: Record<string, string | undefined> = {}): Promise<string> {
  let out = '';
  await withEnv(env(root, extra), async () => {
    const code = await runHook(['user-prompt', ...(harness ? ['--harness', harness] : [])], {
      stdin: JSON.stringify({ prompt: 'what did alice-example decide about the launch?', session_id: 's1' }),
      write: (s) => { out += s; }, cwd: root, configOverride: null, disablePushBanner: true, disableTelemetry: true,
    });
    expect(code).toBe(0);
  });
  return out;
}

describe('per-turn rule: text and decision', () => {
  test('names the tools of the recorded access', () => {
    expect(renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' })).toContain('before answering this turn, check GBrain first (`search` or `query` on the `gbrain` MCP server)');
    expect(renderBrainFirstTurnRule({ kind: 'mcp', server: 'brain', surface: 'verbs' })).toContain('`recall` or `entity` on the `brain` MCP server');
    expect(renderBrainFirstTurnRule({ kind: 'cli', launcher: '/opt/gbrain' })).toContain('`/opt/gbrain search "<names>"`');
  });

  test('a recorded install turns it on with its access; a decline or the opt-out turns it off, fallback or not', async () => {
    const fallback: BrainFirstAccess = { kind: 'mcp', server: 'gbrain' };
    await withEnv(env(home(null)), async () => {
      expect(brainFirstTurnRule('claude-code')).toBeNull();
      expect(brainFirstTurnRule('openclaw', fallback)).toBe(renderBrainFirstTurnRule(fallback));
    });
    await withEnv(env(home([{ harness: 'claude-code', status: 'installed', access: { kind: 'mcp', server: 'brain', surface: 'verbs' } }])), async () => {
      expect(brainFirstTurnRule('claude-code')).toBe(renderBrainFirstTurnRule({ kind: 'mcp', server: 'brain', surface: 'verbs' }));
      expect(brainFirstTurnRule('codex')).toBeNull();
    });
    await withEnv(env(home([{ harness: 'openclaw', status: 'declined' }])), async () => {
      expect(brainFirstTurnRule('openclaw', fallback)).toBeNull();
    });
    await withEnv(env(home([{ harness: 'claude-code', status: 'installed' }]), { GBRAIN_AGENT_INSTRUCTIONS: '0' }), async () => {
      expect(brainFirstTurnRule('claude-code')).toBeNull();
      expect(brainFirstTurnRule('openclaw', fallback)).toBeNull();
    });
  });
});

describe('per-turn rule: Claude Code and Codex user-prompt hook', () => {
  test('with a block installed, every turn carries the rule even when serve has no context to add', async () => {
    const out = await userPrompt(home([{ harness: 'claude-code', status: 'installed' }]));
    const doc = JSON.parse(out.trim());
    expect(doc.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' }) });
    expect(doc.systemMessage).toBeUndefined();
  });

  test('codex reads its own ledger entry', async () => {
    const root = home([{ harness: 'codex', status: 'installed' }]);
    expect(await userPrompt(root, 'codex')).toContain('check GBrain first');
    expect(await userPrompt(root)).toBe('');
  });

  test('no block, a declined block, GBRAIN_AGENT_INSTRUCTIONS=0 or the null seam: stdout stays empty', async () => {
    expect(await userPrompt(home(null))).toBe('');
    expect(await userPrompt(home([{ harness: 'claude-code', status: 'declined' }]))).toBe('');
    expect(await userPrompt(home([{ harness: 'claude-code', status: 'installed' }]), undefined, { GBRAIN_AGENT_INSTRUCTIONS: '0' })).toBe('');
    let out = '';
    await withEnv(env(home([{ harness: 'claude-code', status: 'installed' }])), async () => {
      await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: 'hi' }), write: (s) => { out += s; }, configOverride: null, disablePushBanner: true, disableTelemetry: true, turnRule: null });
    });
    expect(out).toBe('');
  });
});

describe('per-turn rule: Hermes turn-rule hook', () => {
  async function turnRule(root: string, extra: Record<string, string | undefined> = {}): Promise<string> {
    let out = '';
    await withEnv(env(root, extra), async () => {
      expect(await runHook(['turn-rule'], { write: (s) => { out += s; } })).toBe(0);
    });
    return out;
  }

  test('prints Hermes\'s {"context": ...} wire shape by default and with an installed block', async () => {
    expect(JSON.parse(await turnRule(home(null)))).toEqual({ context: renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' }) });
    expect(JSON.parse(await turnRule(home([{ harness: 'hermes', status: 'installed', access: { kind: 'mcp', server: 'brain' } }])))).toEqual({ context: renderBrainFirstTurnRule({ kind: 'mcp', server: 'brain' }) });
  });

  test('prints nothing after a decline, under the opt-out or with hooks off', async () => {
    expect(await turnRule(home([{ harness: 'hermes', status: 'declined' }]))).toBe('');
    expect(await turnRule(home(null), { GBRAIN_AGENT_INSTRUCTIONS: '0' })).toBe('');
    expect(await turnRule(home(null), { GBRAIN_HOOKS: '0' })).toBe('');
  });
});

describe('per-turn rule: OpenClaw context engine', () => {
  async function addition(root: string, extra: Record<string, string | undefined> = {}): Promise<string> {
    const ws = mkdtempSync(join(tmpdir(), 'gbrain-turn-rule-ws-'));
    roots.push(ws);
    let text = '';
    await withEnv(env(root, extra), async () => {
      const result = await createGBrainContextEngine({ workspaceDir: ws }).assemble({ sessionId: 's1', messages: [], tokenBudget: 100000 });
      text = result.systemPromptAddition ?? '';
    });
    return text;
  }

  test('every assemble carries the rule unless OpenClaw\'s block was declined or the opt-out is set', async () => {
    const rule = renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' });
    expect(await addition(home(null))).toContain(rule);
    expect(await addition(home([{ harness: 'openclaw', status: 'declined' }]))).not.toContain('check GBrain first');
    expect(await addition(home(null), { GBRAIN_AGENT_INSTRUCTIONS: '0' })).not.toContain('check GBrain first');
  });
});

describe('per-turn rule: Hermes pre_llm_call hook in config.yaml', () => {
  const launcher = '/opt/gbrain/bin/gbrain';
  const cmd = `${launcher} hook turn-rule`;
  function hermes(config?: string, approvals: unknown[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hermes-home-'));
    roots.push(dir);
    if (config !== undefined) writeFileSync(join(dir, 'config.yaml'), config);
    if (approvals.length) writeFileSync(join(dir, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals }));
    return dir;
  }
  const cfg = (d: string) => readFileSync(join(d, 'config.yaml'), 'utf8');
  const approvals = (d: string) => JSON.parse(readFileSync(join(d, 'shell-hooks-allowlist.json'), 'utf8')).approvals as Array<Record<string, unknown>>;

  test('appends a marked hook after the user\'s text, approves exactly that command, keeps on a re-run, and removal undoes both', () => {
    const mine = '# my config\nmodel:\n  default: alice-example-model\n';
    const other = { event: 'pre_tool_call', command: '/usr/bin/true', approved_at: 'x', script_mtime_at_approval: null };
    const d = hermes(mine, [other]);
    expect(syncHermesTurnHook({ hermesHome: d, launcher, dryRun: false }).action).toBe('write');
    const text = cfg(d);
    expect(text.startsWith(mine)).toBe(true);
    expect(load(text)).toEqual({ model: { default: 'alice-example-model' }, hooks: { pre_llm_call: [{ command: cmd, timeout: 10 }] } });
    expect(approvals(d)).toEqual([other, expect.objectContaining({ event: 'pre_llm_call', command: cmd })]);
    expect(syncHermesTurnHook({ hermesHome: d, launcher, dryRun: false }).action).toBe('keep');
    expect(cfg(d)).toBe(text);
    expect(approvals(d)).toHaveLength(2);
    expect(removeHermesTurnHook({ hermesHome: d, dryRun: false }).action).toBe('remove');
    expect(cfg(d)).toBe(mine);
    expect(approvals(d)).toEqual([other]);
  });

  test('a new launcher path rewrites the block in place', () => {
    const d = hermes('');
    syncHermesTurnHook({ hermesHome: d, launcher, dryRun: false });
    expect(syncHermesTurnHook({ hermesHome: d, launcher: '/usr/local/bin/gbrain', dryRun: false }).action).toBe('write');
    expect(load(cfg(d))).toEqual({ hooks: { pre_llm_call: [{ command: '/usr/local/bin/gbrain hook turn-rule', timeout: 10 }] } });
  });

  test('prints the entry instead of editing: a hooks: section of the user\'s, no absolute launcher, no Hermes home, damaged markers', () => {
    const theirs = 'hooks:\n  pre_tool_call:\n    - command: /usr/bin/true\n';
    const d = hermes(theirs);
    const o = syncHermesTurnHook({ hermesHome: d, launcher, dryRun: false });
    expect(o.action).toBe('print');
    expect(o.snippet).toContain(`- command: "${cmd}"`);
    expect(cfg(d)).toBe(theirs);
    expect(existsSync(join(d, 'shell-hooks-allowlist.json'))).toBe(false);
    expect(syncHermesTurnHook({ hermesHome: hermes(''), launcher: null, dryRun: false }).action).toBe('print');
    expect(syncHermesTurnHook({ hermesHome: hermes(''), launcher: 'gbrain', dryRun: false }).action).toBe('print');
    expect(syncHermesTurnHook({ hermesHome: join(tmpdir(), 'gbrain-no-such-hermes-home'), launcher, dryRun: false }).action).toBe('print');
    const damaged = hermes('# gbrain:turn-rule:begin\nmodel: x\n');
    expect(syncHermesTurnHook({ hermesHome: damaged, launcher, dryRun: false }).action).toBe('print');
    expect(cfg(damaged)).toBe('# gbrain:turn-rule:begin\nmodel: x\n');
  });

  test('dry-run writes nothing', () => {
    const d = hermes('model: x\n');
    expect(syncHermesTurnHook({ hermesHome: d, launcher, dryRun: true }).action).toBe('write');
    expect(cfg(d)).toBe('model: x\n');
    expect(existsSync(join(d, 'shell-hooks-allowlist.json'))).toBe(false);
  });
});
