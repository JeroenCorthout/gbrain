/**
 * GBRA-133 PR 3 items 1 and 6: an agent fixes held files over MCP with no human command.
 *
 * Protects:
 *  - sync_status is the MCP twin of gbrain sync status --json: every hold carries item_id and preview/apply/verify
 *    actions whose MCP twins render run (preview) and ask_user (apply) over the local stdio pipe;
 *  - the end-to-end loop over real stdio dispatch (remote:true, transport stdio) takes an invalid_frontmatter hold and
 *    an invalid_fence hold from sync_status to repair_preview to repair_apply to sync_brain to a cleared hold; apply
 *    refuses confirmation_required without yes and preview_changed on a stale hash, records a receipt naming the
 *    local agent, and reconciles it before the next preview;
 *  - http: repair_apply and sync_unblock are not callable (localOnly), and every sync_status step renders ask_user with
 *    the exact local command and no MCP twin (the remote projection);
 *  - a held private page is withheld (counted, never named) from an agent-facing caller, and a caller bound to one
 *    source asking for another gets not_found with nothing of the other source.
 * Known gap (plan, PR 3 item 6): remote apply is not built; http callers relay the command to the brain host.
 * On v0.60.320.0 none of these tools existed (unknown_tool). PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall, type DispatchOpts } from '../../src/mcp/dispatch.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const SOURCE = 'acme-example', OTHER = 'fund-a';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const fence = (holder: string) => `${T}\n${TH}\n| 1 | Synthetic take | take | ${holder} | 0.7 | 2026-01 | chat |\n${TE}\n`;
const PRIVATE_PATH = 'notes/zz-private-sentinel-q81.md', OTHER_PATH = 'notes/zz-other-sentinel-q81.md';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };

interface Brain { engine: BrainEngine; root: string }

async function managedSource(engine: BrainEngine, home: string, id: string, files: Record<string, string>): Promise<string> {
  const root = join(home, id);
  for (const path of Object.keys(files)) mkdirSync(join(root, path, '..'), { recursive: true });
  git(home, 'init', '-q', root);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return root;
}

async function brain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>, opts: { private?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-agent-repair-loop-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_FENCE_REPAIR_SCAN_MS: '60000',
      OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_REMOTE_PRIVATE_PAGES: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = await managedSource(engine, home, SOURCE, {
          'notes/clean.md': '---\ntitle: Clean\n---\nA synthetic note.\n',
          'people/alice-example.md': '---\ntitle: Alice Example\ntype: person\n---\nA synthetic person.\n',
        });
        await managedSource(engine, home, OTHER, { 'notes/other-clean.md': '---\ntitle: Other\n---\nAnother synthetic note.\n',
          [OTHER_PATH]: '---\ntitle: Other held\nan unquoted line of the other source\n---\nAnother synthetic note.\n' });
        expect((await performManagedSync(engine, { sourceId: OTHER, noPull: true, noEmbed: true, noExtract: true })).held?.map(hold => hold.path)).toEqual([OTHER_PATH]);
        expect((await performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
        writeFileSync(join(root, 'notes/frontmatter.md'), '---\ntitle: Standup with acme-example\nthe team agreed to ship on Friday\n---\nDaily standup notes.\n');
        writeFileSync(join(root, 'people/holder.md'), `---\ntitle: Holder\n---\nA synthetic page.\n\n${fence('Alice Example')}`);
        if (opts.private !== false) writeFileSync(join(root, PRIVATE_PATH), `---\ntitle: Private\nvisibility: private\n---\nA private synthetic page.\n\n${fence('Alice Example')}`);
        commit(root, 'held files');
        const synced = await performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true });
        expect(synced.held?.map(hold => [hold.path, hold.code]).sort()).toEqual([['notes/frontmatter.md', 'invalid_frontmatter'], ...(opts.private !== false ? [[PRIVATE_PATH, 'invalid_fence']] : []), ['people/holder.md', 'invalid_fence']]);
        await run({ engine, root });
      } finally {
        await disposePersistenceConsumer(engine).catch(() => undefined);
        await close();
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const STDIO: DispatchOpts = { remote: true, transport: 'stdio', sourceId: SOURCE };
const HTTP: DispatchOpts = { remote: true, transport: 'http', sourceId: SOURCE };
async function call(engine: BrainEngine, tool: string, args: Record<string, unknown>, opts: DispatchOpts = STDIO) {
  const res = await dispatchToolCall(engine, tool, args, opts);
  const text = res.content.map(c => c.text).join('\n');
  let body: any;
  try { body = JSON.parse(res.content[0]!.text); } catch { body = undefined; }
  return { isError: res.isError === true, body, text };
}

const SENTINELS = ['zz-private-sentinel-q81', 'zz-other-sentinel-q81'];
const expectNoSentinel = (value: unknown) => { const s = typeof value === 'string' ? value : JSON.stringify(value); for (const n of SENTINELS) expect(s).not.toContain(n); };
const holdPaths = (body: any) => (body.holds as Array<{ path: string }>).map(hold => hold.path).sort();

async function printed(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}

for (const arm of pathologicalArms()) {
  describe(`agent repair loop over MCP [${arm.backend}]`, () => {
    test('stdio: sync_status -> repair_preview -> repair_apply -> sync_brain clears a frontmatter hold and a fence hold with no human command', () => brain(arm.databaseUrl, async ({ engine, root }) => {
      const status = await call(engine, 'sync_status', {});
      expect(status.isError).toBe(false);
      expect(holdPaths(status.body)).toEqual(['notes/frontmatter.md', 'people/holder.md']);
      expect(status.body.holds_withheld).toBe(1);
      expectNoSentinel(status.text);
      // autofix (src/core/autofix/state.ts, the agent projection): no receipts yet, pending repairs as counts with no path,
      // and each kind's switches with the key that turns it off and where its value came from.
      expect(status.body.autofix.recent).toEqual([]);
      expect(status.body.autofix.pending.every((item: { paths?: unknown }) => item.paths === undefined)).toBe(true);
      type Kind = { kind: string; effective: boolean; disabling_key: string | null; switches: Array<{ key: string; enabled: boolean; source: string }> };
      const fence = (body: { autofix: { switches: Kind[] } }) => body.autofix.switches.find(item => item.kind === 'fence_repair')!;
      expect(fence(status.body)).toMatchObject({ effective: true });
      await engine.setConfig('fences.repair.enabled', 'false');
      const off = fence((await call(engine, 'sync_status', {})).body);
      expect(off).toMatchObject({ effective: false, disabling_key: 'fences.repair.enabled' });
      expect(off.switches).toContainEqual({ key: 'fences.repair.enabled', enabled: false, source: 'config' });
      await engine.executeRaw("DELETE FROM config WHERE key='fences.repair.enabled'");
      // Identical field names: the CLI's sync status --json document carries exactly the MCP document's keys.
      const { runSyncStatus } = await import('../../src/commands/sync/operator.ts');
      const cli = JSON.parse(await printed(() => runSyncStatus(engine, ['--source', SOURCE, '--json'])));
      expect(Object.keys(cli).sort()).toEqual(Object.keys(status.body).sort());
      expect(Object.keys(cli.holds[0]).sort()).toEqual(Object.keys(status.body.holds[0]).sort());
      expect(cli.holds_withheld).toBe(0);
      // sources_status and get_status_snapshot point at it.
      const sourceStatus = await call(engine, 'sources_status', { id: SOURCE });
      expect(sourceStatus.body.sync_status).toMatchObject({ next: 'run', mcp: { tool: 'sync_status', arguments: { source_id: SOURCE } } });
      const snapshot = await call(engine, 'get_status_snapshot', {});
      expect(snapshot.body.sync_status).toContainEqual(expect.objectContaining({ source_id: SOURCE, status: expect.objectContaining({ next: 'run', mcp: { tool: 'sync_status', arguments: { source_id: SOURCE } } }) }));

      for (const hold of status.body.holds) {
        expect(hold.item_id.startsWith(`${SOURCE}:${hold.path}:${hold.code}:`)).toBe(true);
        expect(hold.preview).toMatchObject({ next: 'run', mcp: { tool: 'repair_preview' } });
        expect(hold.apply).toMatchObject({ next: 'ask_user', mcp: { tool: 'repair_apply' }, consent: ['destructive'] });
        expect(hold.verify).toMatchObject({ next: 'run', mcp: { tool: 'sync_status', arguments: { source_id: SOURCE } } });
        expect(hold.fix.next).toBe('run');
        const before = readFileSync(join(root, hold.path), 'utf8');

        const preview = await call(engine, hold.preview.mcp.tool, hold.preview.mcp.arguments);
        expect(preview.isError).toBe(false);
        expect(preview.body).toMatchObject({ mode: 'dry_run', source_id: SOURCE, withheld: 0, prior_apply: { pending: 0 } });
        expect(preview.body.affected).toBeGreaterThanOrEqual(1);
        expect(preview.body.preview_hash).toMatch(/^[0-9a-f]{64}$/);
        const step = preview.body.next;
        expect(step).toMatchObject({ next: 'ask_user', mcp: { tool: 'repair_apply', arguments: { expect: preview.body.preview_hash, yes: true } } });
        expect(step.user_message).toContain(SOURCE);

        // No yes: confirmation_required with the exact call as the fix; nothing written.
        const { yes: _yes, ...unconfirmed } = step.mcp.arguments;
        const refused = await call(engine, 'repair_apply', unconfirmed);
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain('confirmation_required');
        // A stale hash: preview_changed; nothing written.
        const stale = await call(engine, 'repair_apply', { ...step.mcp.arguments, expect: 'f'.repeat(64) });
        expect(stale.isError).toBe(true);
        expect(stale.text).toContain('preview_changed');
        expect(readFileSync(join(root, hold.path), 'utf8')).toBe(before);

        const applied = await call(engine, step.mcp.tool, step.mcp.arguments);
        expect(applied.isError).toBe(false);
        expect(applied.body).toMatchObject({ mode: 'apply', expect: preview.body.preview_hash, receipt: { op: 'repair_apply', source_id: SOURCE, actor: { kind: 'local_agent', transport: 'stdio' } } });
        expect(applied.body.receipt.applied).toBeGreaterThanOrEqual(1);
        expect(applied.body.next).toMatchObject({ next: 'run', mcp: { tool: 'sync_brain', arguments: { source_id: SOURCE, no_pull: true } } });
        expect(readFileSync(join(root, hold.path), 'utf8')).not.toBe(before);

        const resynced = await call(engine, applied.body.next.mcp.tool, applied.body.next.mcp.arguments);
        expect(resynced.isError).toBe(false);
        const after = await call(engine, 'sync_status', {});
        expect(holdPaths(after.body)).not.toContain(hold.path);
      }

      const cleared = await call(engine, 'sync_status', {});
      expect(cleared.body.holds).toEqual([]);
      expect(cleared.body.holds_withheld).toBe(1);
      expect(readFileSync(join(root, 'people/holder.md'), 'utf8')).toContain('people/alice-example');
      // The next preview reconciles both earlier applies: nothing pending.
      const again = await call(engine, 'repair_preview', { kind: 'frontmatter', include_ambiguous: true });
      expect(again.body.prior_apply.pending).toBe(0);
      expectNoSentinel(again.text);
    }), 240_000);

    test('http: repair_apply and sync_unblock are refused; every sync_status step relays the exact local command to the brain host', () => brain(arm.databaseUrl, async ({ engine, root }) => {
      const status = await call(engine, 'sync_status', {}, HTTP);
      expect(status.isError).toBe(false);
      expect(holdPaths(status.body)).toEqual(['notes/frontmatter.md', 'people/holder.md']);
      expectNoSentinel(status.text);
      for (const hold of status.body.holds) {
        for (const step of [hold.fix, hold.preview, hold.apply]) {
          expect(step.next).toBe('ask_user');
          expect(step.mcp).toBeUndefined();
          expect(step.user_message).toContain(`please ask whoever runs this gbrain server to run gbrain repair`);
        }
      }
      expect(JSON.stringify(status.body.notifier ?? {})).not.toContain(root);
      const before = readFileSync(join(root, 'people/holder.md'), 'utf8');
      for (const [tool, args] of [['repair_apply', { kind: 'fences', only: ['people/holder.md'], expect: 'f'.repeat(64), yes: true }], ['sync_unblock', { apply: true, expect: 'f'.repeat(64), yes: true }]] as const) {
        const refused = await call(engine, tool, args, HTTP);
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain('unknown_tool');
      }
      // Defense in depth: the handler itself refuses an http caller even if a transport ever listed it.
      const { operations } = await import('../../src/core/operations.ts');
      const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, transport: 'http', sourceId: SOURCE } as never;
      for (const name of ['repair_apply', 'sync_unblock']) {
        const err = await operations.find(op => op.name === name)!.handler(ctx, { kind: 'fences', apply: true, expect: 'f'.repeat(64), yes: true }).then(() => null, e => e);
        expect(err).toMatchObject({ code: 'permission_denied', reason: 'remote_apply_unsupported' });
      }
      expect(readFileSync(join(root, 'people/holder.md'), 'utf8')).toBe(before);
    }), 240_000);

    test('content lane: one content preview binds every kind\'s hash and its apply clears the fence hold', () => brain(arm.databaseUrl, async ({ engine, root }) => {
      const preview = await call(engine, 'repair_preview', { kind: 'content', only: ['people/holder.md'] });
      expect(preview.isError).toBe(false);
      expect(preview.body.preview_hash.split(',').length).toBe(Object.keys(preview.body.preview_hashes).length);
      expect(preview.body.next).toMatchObject({ next: 'ask_user', mcp: { tool: 'repair_apply', arguments: { kind: 'content', expect: preview.body.preview_hash } } });
      const applied = await call(engine, 'repair_apply', preview.body.next.mcp.arguments);
      expect(applied.isError).toBe(false);
      expect(applied.body.receipt).toMatchObject({ kind: 'content', actor: { kind: 'local_agent', transport: 'stdio' } });
      expect(readFileSync(join(root, 'people/holder.md'), 'utf8')).toContain('people/alice-example');
      await call(engine, applied.body.next.mcp.tool, applied.body.next.mcp.arguments);
      expect(holdPaths((await call(engine, 'sync_status', {})).body)).toEqual(['notes/frontmatter.md']);
    }, { private: false }), 240_000);

    test('sync_unblock: the preview names its hash and an ask_user apply step; no yes asks, a stale hash refuses, the apply repairs the fence hold under the local agent', () => brain(arm.databaseUrl, async ({ engine, root }) => {
      const before = readFileSync(join(root, 'people/holder.md'), 'utf8');
      const unblock = await call(engine, 'sync_unblock', {});
      expect(unblock.isError).toBe(false);
      expect(unblock.body).toMatchObject({ apply: false, withheld: 0 });
      expect(unblock.body.applied.map((entry: { path: string; action: string }) => [entry.path, entry.action])).toEqual([['people/holder.md', 'repair']]);
      expect(unblock.body.next).toMatchObject({ next: 'ask_user', mcp: { tool: 'sync_unblock', arguments: { source_id: SOURCE, apply: true, expect: unblock.body.preview_hash, yes: true } } });
      const noYes = await call(engine, 'sync_unblock', { apply: true, expect: unblock.body.preview_hash });
      expect(noYes.isError).toBe(true);
      expect(noYes.text).toContain('confirmation_required');
      const stale = await call(engine, 'sync_unblock', { apply: true, expect: '0'.repeat(64), yes: true });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain('preview_changed');
      expect(readFileSync(join(root, 'people/holder.md'), 'utf8')).toBe(before);
      const unblocked = await call(engine, unblock.body.next.mcp.tool, unblock.body.next.mcp.arguments);
      expect(unblocked.isError).toBe(false);
      expect(unblocked.body).toMatchObject({ apply: true, receipt: { op: 'sync_unblock', kind: 'unblock', actor: { kind: 'local_agent', transport: 'stdio' } } });
      expect(unblocked.body.applied).toMatchObject([{ path: 'people/holder.md', action: 'repair', repair: { kind: 'fences', outcome: 'repaired' } }]);
      expect(readFileSync(join(root, 'people/holder.md'), 'utf8')).toContain('people/alice-example');
    }, { private: false }), 240_000);

    test('privacy: a held private page is withheld and never applied by an agent; another source answers not_found with nothing of it', () => brain(arm.databaseUrl, async ({ engine, root }) => {
      // Control: the trusted CLI sees the private hold (so the withheld count is not vacuous).
      const local = await call(engine, 'sync_status', {}, { remote: false, sourceId: SOURCE });
      expect(holdPaths(local.body)).toContain(PRIVATE_PATH);
      // A preview of the whole fences kind counts the private item and names none of it; its next step narrows, never applies.
      const preview = await call(engine, 'repair_preview', { kind: 'fences' });
      expect(preview.isError).toBe(false);
      expect(preview.body.withheld).toBe(1);
      expect(preview.body.next.mcp?.tool).not.toBe('repair_apply');
      expectNoSentinel(preview.text);
      const before = readFileSync(join(root, PRIVATE_PATH), 'utf8');
      const applied = await call(engine, 'repair_apply', { kind: 'fences', expect: preview.body.preview_hash, yes: true });
      expect(applied.isError).toBe(true);
      expect(applied.text).toContain('withheld_items');
      expectNoSentinel(applied.text);
      expect(readFileSync(join(root, PRIVATE_PATH), 'utf8')).toBe(before);
      const unblock = await call(engine, 'sync_unblock', {});
      expect(unblock.isError).toBe(false);
      expectNoSentinel(unblock.text);
      // Cross-source: a caller bound to SOURCE asking for OTHER gets not_found on every tool, and nothing of OTHER.
      for (const [tool, args] of [['sync_status', {}], ['repair_preview', { kind: 'frontmatter' }], ['sync_unblock', {}], ['repair_apply', { kind: 'frontmatter', expect: 'f'.repeat(64), yes: true }]] as const) {
        for (const opts of [STDIO, HTTP]) {
          if (opts === HTTP && (tool === 'sync_unblock' || tool === 'repair_apply')) continue;
          const res = await call(engine, tool, { ...args, source_id: OTHER }, opts);
          expect(res.isError).toBe(true);
          expect(res.text).toContain('not_found');
          expectNoSentinel(res.text);
        }
      }
    }), 240_000);
  });
}
