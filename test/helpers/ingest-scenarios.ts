/**
 * GBRA-215 L3: ingest and ingest_undo as scenarios both engines run on a repository-backed source and on a repo-less
 * one (test/ingest.serial.test.ts on PGLite, test/e2e/ingest-postgres.test.ts on Postgres). The chat model is a stub:
 * no real provider call is made.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { reviewCtx, committedFile, type ReviewDoorFixture } from './review-door-scenarios.ts';

export type Report = Record<string, any>;

export async function drain(engine: BrainEngine): Promise<void> {
  for (let i = 0; i < 4; i++) await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 32 });
}

const FILLER = 'The conversation drifted through scheduling, travel and the weather before returning to the main thread of the call. ';

/** A speakerless document of about 60k characters: two claims early, one acronym slip and one claim in the last window. */
export function goldenDocument(): string {
  const parts = [
    'Alice Example opened the call. Zentrix signed its first enterprise customer last week. ',
    FILLER.repeat(150),
    'ACMX announced a new product line for small offices. ',
    FILLER.repeat(320),
    'Alice Example moved to Lisbon in March. ',
  ];
  return parts.join('');
}

interface StubRow { marker: string; entities: Array<{ name: string; type: string; context: string }>; facts: Array<{ fact: string; kind: string; entities: string[] }> }
const GOLDEN_ROWS: StubRow[] = [
  { marker: 'Zentrix signed', entities: [{ name: 'Alice Example', type: 'person', context: 'Alice Example opened the call.' }, { name: 'Zentrix', type: 'company', context: 'Zentrix signed its first enterprise customer last week.' }],
    facts: [{ fact: 'Zentrix signed its first enterprise customer.', kind: 'event', entities: ['Zentrix'] }] },
  { marker: 'ACMX announced', entities: [{ name: 'ACMX', type: 'company', context: 'ACMX announced a new product line for small offices.' }],
    facts: [{ fact: 'ACMX announced a new product line for small offices.', kind: 'event', entities: ['ACMX'] }] },
  { marker: 'moved to Lisbon', entities: [{ name: 'Alice Example', type: 'person', context: 'Alice Example moved to Lisbon in March.' }],
    facts: [{ fact: 'Alice Example moved to Lisbon in March.', kind: 'event', entities: ['Alice Example'] }] },
];

export interface ChatStub { calls: number; restore: () => void }

/** The ingest extractor's stub: each window gets the entities and claims whose marker sentence it contains. */
export function stubChat(opts: { rows?: StubRow[]; usage?: number; onCall?: (n: number) => Promise<void> | void } = {}): ChatStub {
  const rows = opts.rows ?? GOLDEN_ROWS;
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5', env: { ANTHROPIC_API_KEY: 'test-key' } } as never);
  const stub: ChatStub = { calls: 0, restore: () => { __setChatTransportForTests(null); resetGateway(); } };
  __setChatTransportForTests(async (req: unknown) => {
    stub.calls++;
    await opts.onCall?.(stub.calls);
    const text = JSON.stringify(req);
    const hit = rows.filter(r => text.includes(r.marker));
    return {
      text: JSON.stringify({ entities: hit.flatMap(r => r.entities), facts: hit.flatMap(r => r.facts.map(f => ({ ...f, notability: 'high' }))) }),
      blocks: [], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      usage: { input_tokens: opts.usage ?? 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    } as never;
  });
  return stub;
}

export async function seedEntities(engine: BrainEngine): Promise<void> {
  const put = operationsByName.put_page!;
  await put.handler(reviewCtx(engine), { slug: 'people/alice-example', content: '---\ntype: person\ntitle: Alice Example\n---\n\nAlice Example is a founder.\n' });
  await put.handler(reviewCtx(engine), { slug: 'companies/acme', content: '---\ntype: company\ntitle: ACME\n---\n\nACME makes office furniture.\n' });
  await drain(engine);
}

export async function ingest(engine: BrainEngine, params: Record<string, unknown>, over: Partial<OperationContext> = {}): Promise<Report> {
  const out = await operationsByName.ingest!.handler(reviewCtx(engine, over), params) as Report;
  await drain(engine);
  return out;
}

export async function undo(engine: BrainEngine, params: Record<string, unknown>, over: Partial<OperationContext> = {}): Promise<Report> {
  const out = await operationsByName.ingest_undo!.handler(reviewCtx(engine, over), params) as Report;
  await drain(engine);
  return out;
}

/** HEAD's file for a slug once the queued Git commit lands (effects drain between polls), or null. */
export async function settledFile(engine: BrainEngine, repo: string, slug: string, ready: (file: string | null) => boolean): Promise<string | null> {
  let file = committedFile(repo, slug);
  for (let i = 0; i < 40 && !ready(file); i++) {
    await drain(engine);
    await new Promise(resolve => setTimeout(resolve, 100));
    file = committedFile(repo, slug);
  }
  return file;
}

export async function pageCount(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL');
  return Number(row!.n);
}

export async function factsOn(engine: BrainEngine, slug: string): Promise<Array<{ id: number; fact: string; valid_until: unknown; expired_at: unknown; source: string }>> {
  return engine.executeRaw('SELECT id, fact, valid_until, expired_at, source FROM facts WHERE entity_slug = $1 ORDER BY id', [slug]);
}

/** Golden keyed run: the company proposed with content and its fact in its fence, the acronym flagged, the tail claim saved. */
export async function goldenScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<Report> {
  await seedEntities(engine);
  const stub = stubChat();
  try {
    const report = await ingest(engine, { content: goldenDocument(), title: 'Call notes' });
    expect(report.status).toBe('complete');
    expect(report.complete).toBe(true);
    expect(report.storage).toBe(fx.storage);
    expect(report.coverage.windows_total).toBeGreaterThan(1);
    expect(report.coverage.windows_done).toBe(report.coverage.windows_total);
    expect(report.coverage.chars_read).toBe(report.coverage.chars_total);
    expect(stub.calls).toBe(report.coverage.windows_total);
    const zentrix = report.pages.find((p: Report) => p.name === 'Zentrix');
    expect(zentrix).toMatchObject({ slug: 'companies/zentrix', status: 'proposed', type: 'company' });
    const acmx = report.pages.find((p: Report) => p.name === 'ACMX');
    expect(acmx.status).toBe('proposed');
    expect(acmx.near_names.map((n: Report) => n.slug)).toContain('companies/acme');
    expect(report.pages.find((p: Report) => p.name === 'Alice Example')).toMatchObject({ slug: 'people/alice-example', status: 'existing' });
    const page = await engine.getPage('companies/zentrix');
    expect(page!.type).toBe('company');
    expect(page!.frontmatter).toMatchObject({ provenance: 'auto-extracted', status: 'unverified' });
    expect(page!.compiled_truth).toContain('Zentrix signed its first enterprise customer last week.');
    expect((await factsOn(engine, 'companies/zentrix')).map(f => f.fact)).toEqual(['Zentrix signed its first enterprise customer.']);
    expect((await factsOn(engine, 'people/alice-example')).map(f => f.fact)).toContain('Alice Example moved to Lisbon in March.');
    const source = await engine.getPage(report.source_page.slug);
    expect(source!.frontmatter.facts_backstop).toBe(false);
    const reportPage = await engine.getPage(report.report_page);
    expect(reportPage!.type).toBe('ingest-report');
    expect((reportPage!.frontmatter.ingest as Report).created_facts.length).toBeGreaterThanOrEqual(3);
    if (fx.repo) {
      const file = (await settledFile(engine, fx.repo, 'companies/zentrix', f => !!f?.includes('Zentrix signed its first enterprise customer.')))!;
      expect(file).toContain('Zentrix signed its first enterprise customer.');
      expect(parseMarkdown(file, 'companies/zentrix.md').frontmatter.status).toBe('unverified');
      expect(await settledFile(engine, fx.repo, report.report_page, f => f !== null)).not.toBeNull();
    }
    // A completed repeat returns the stored report: no provider call, nothing written.
    const before = stub.calls;
    const again = await ingest(engine, { content: goldenDocument(), title: 'Call notes' });
    expect(again.attempt_id).toBe(report.attempt_id);
    expect(again.repeated).toBe(true);
    expect(stub.calls).toBe(before);
    // Status is read-only and provider-free.
    const status = await ingest(engine, { attempt_id: report.attempt_id });
    expect(status.attempt_id).toBe(report.attempt_id);
    expect(stub.calls).toBe(before);
    return report;
  } finally {
    stub.restore();
  }
}

/** Undo: preview writes nothing, a wrong hash refuses, apply strikes the attempt's rows and soft-deletes its pages through the door. */
export async function undoScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<void> {
  const report = await goldenScenario(engine, fx);
  const id = report.attempt_id;
  const before = await pageCount(engine);
  const preview = await undo(engine, { attempt_id: id });
  expect(preview.status).toBe('preview');
  expect(preview.consent).toEqual(['destructive']);
  expect(preview.plan_hash).toMatch(/^[0-9a-f]{32}$/);
  expect(preview.retract.length).toBeGreaterThanOrEqual(3);
  expect(preview.delete.map((d: Report) => d.slug)).toEqual(expect.arrayContaining(['companies/zentrix', report.source_page.slug]));
  expect(await pageCount(engine)).toBe(before);
  expect((await factsOn(engine, 'companies/zentrix'))[0]!.valid_until).toBeNull();
  const wrong = await undo(engine, { attempt_id: id, yes: true, expect: '0'.repeat(32) }).catch(e => e);
  expect(wrong).toBeInstanceOf(OperationError);
  expect((wrong as OperationError).code).toBe('preview_changed');
  const applied = await undo(engine, { attempt_id: id, yes: true, expect: preview.plan_hash });
  expect(applied.status).toBe('undone');
  expect(applied.retracted).toBe(preview.retract.length);
  expect(applied.deleted).toBe(preview.delete.length);
  expect(await engine.getPage('companies/zentrix')).toBeNull();
  const alice = await factsOn(engine, 'people/alice-example');
  const lisbon = alice.find(f => f.fact === 'Alice Example moved to Lisbon in March.')!;
  expect(lisbon.valid_until).not.toBeNull();
  expect(await engine.getPage('people/alice-example')).not.toBeNull();
  // The struck row lives in the page's own fence (Git file or database page body), so a later write never re-projects it.
  const body = (await engine.getPage('people/alice-example'))!.compiled_truth;
  expect(body).toMatch(/~~Alice Example moved to Lisbon in March\.~~/);
  if (fx.repo) {
    expect(await settledFile(engine, fx.repo, 'people/alice-example', f => !!f?.includes('~~Alice Example moved to Lisbon in March.~~'))).toMatch(/~~Alice Example moved to Lisbon in March\.~~/);
    expect(await settledFile(engine, fx.repo, 'companies/zentrix', f => f === null)).toBeNull();
  }
  // Round-4 item 2: an edit of the page afterwards keeps the claim retracted.
  const { serializePageToMarkdown } = await import('../../src/core/markdown.ts');
  const snap = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
  const edited = serializePageToMarkdown({ ...snap!.page, compiled_truth: snap!.page.compiled_truth.replace('Alice Example is a founder.', 'Alice Example is a founder and investor.') } as never, snap!.tags);
  await operationsByName.put_page!.handler(reviewCtx(engine), { slug: 'people/alice-example', content: edited, expected_revision: snap!.revision });
  await drain(engine);
  const afterEdit = (await factsOn(engine, 'people/alice-example')).filter(f => f.fact === 'Alice Example moved to Lisbon in March.');
  expect(afterEdit.every(f => f.valid_until !== null || f.expired_at !== null)).toBe(true);
  // A repeat is a no-op.
  expect((await undo(engine, { attempt_id: id })).status).toBe('already_undone');
  // Re-ingest after undo is a new attempt and saves the claims again.
  const stub = stubChat();
  try {
    const again = await ingest(engine, { content: goldenDocument(), title: 'Call notes' });
    expect(again.attempt_id).not.toBe(id);
    expect(again.status).toBe('complete');
    const live = (await factsOn(engine, 'people/alice-example')).filter(f => f.fact === 'Alice Example moved to Lisbon in March.' && f.valid_until === null && f.expired_at === null);
    expect(live.length).toBe(1);
  } finally { stub.restore(); }
}

/** Keyless: candidate names (acronyms, one-word companies) proposed, facts skipped with the missing capability named. */
export async function keylessScenario(engine: BrainEngine, fx: ReviewDoorFixture): Promise<void> {
  await seedEntities(engine);
  resetGateway();
  configureGateway({ env: {} } as never);
  try {
    const report = await ingest(engine, { content: 'We met the team at ACMX on Tuesday. Later Zentrix Inc. joined the call to talk about pricing.' });
    expect(report.status).toBe('complete');
    expect(report.storage).toBe(fx.storage);
    expect(report.plan_basis).toBe('keyless_candidates');
    expect(report.missing_capability.check).toEqual(['gbrain', 'models', '--json']);
    const acmx = report.pages.find((p: Report) => p.name === 'ACMX');
    expect(acmx.status).toBe('proposed');
    expect(report.pages.every((p: Report) => p.status !== 'created')).toBe(true);
    expect(report.facts.every((f: Report) => f.status === 'skipped')).toBe(true);
    expect(report.coverage.chars_read).toBe(report.coverage.chars_total);
  } finally { resetGateway(); }
}

/** Dry run: no provider call, nothing written, and the basis is stated. */
export async function dryRunScenario(engine: BrainEngine): Promise<void> {
  await seedEntities(engine);
  const stub = stubChat();
  try {
    const before = await pageCount(engine);
    const out = await ingest(engine, { content: goldenDocument(), dry_run: true });
    expect(out.dry_run).toBe(true);
    expect(out.plan_basis).toBe('keyless_candidates');
    expect(out.windows_total).toBeGreaterThan(1);
    expect(out.pages.every((p: Report) => ['proposed', 'existing', 'skipped'].includes(p.status))).toBe(true);
    expect(out.pages.find((p: Report) => p.name === 'ACMX').status).toBe('proposed');
    expect(stub.calls).toBe(0);
    expect(await pageCount(engine)).toBe(before);
    const [cp] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op LIKE 'ingest-%'");
    expect(Number(cp!.n)).toBe(0);
  } finally { stub.restore(); }
}

/** --trusted-extraction creates real pages only for model-typed names; near-name and regex-only names stay proposed. */
export async function trustedScenario(engine: BrainEngine): Promise<void> {
  await seedEntities(engine);
  const stub = stubChat();
  try {
    const report = await ingest(engine, { content: goldenDocument(), trusted_extraction: true });
    expect(report.pages.find((p: Report) => p.name === 'Zentrix').status).toBe('created');
    expect(report.pages.find((p: Report) => p.name === 'ACMX').status).toBe('proposed');
    const page = await engine.getPage('companies/zentrix');
    expect(page!.frontmatter.status).toBeUndefined();
    const remote = await ingest(engine, { content: goldenDocument() + ' More.', trusted_extraction: true }, { remote: true } as never).catch(e => e);
    expect((remote as OperationError).code).toBe('ingest_option_invalid');
  } finally { stub.restore(); }
}

/** A budget stop leaves the attempt resumable; resume finishes without paying for finished windows again. */
export async function budgetResumeScenario(engine: BrainEngine): Promise<void> {
  await seedEntities(engine);
  const stub = stubChat({ usage: 200_000 });
  try {
    const first = await ingest(engine, { content: goldenDocument(), max_usd: 0.25 });
    expect(first.status).toBe('incomplete');
    expect(first.complete).toBe(false);
    expect(first.stop).toBe('budget');
    expect(first.actions.map((a: Report) => a.kind)).toContain('resume');
    const done = first.coverage.windows_done;
    expect(done).toBeLessThan(first.coverage.windows_total);
    expect(await engine.getPage('companies/zentrix')).toBeNull();
    // A plain repeat does not resume; it returns the stored report.
    const repeat = await ingest(engine, { content: goldenDocument(), max_usd: 0.25 });
    expect(repeat.resumable).toBe(true);
    expect(stub.calls).toBe(done);
    const resumed = await ingest(engine, { content: goldenDocument(), attempt_id: first.attempt_id, resume: true, max_usd: 100 });
    expect(resumed.status).toBe('complete');
    expect(resumed.attempt_id).toBe(first.attempt_id);
    expect(stub.calls).toBe(resumed.coverage.windows_total);
  } finally { stub.restore(); }
}

/** The extraction kill switch flipped mid-run stops before the next window. */
export async function killSwitchScenario(engine: BrainEngine): Promise<void> {
  await seedEntities(engine);
  const stub = stubChat({ onCall: async n => { if (n === 1) await engine.setConfig('facts.extraction_enabled', 'false'); } });
  try {
    const out = await ingest(engine, { content: goldenDocument() });
    expect(out.stop).toBe('kill_switch');
    expect(out.status).toBe('incomplete');
    expect(stub.calls).toBe(1);
  } finally { stub.restore(); await engine.unsetConfig('facts.extraction_enabled'); }
}

/** Every input and option is validated before anything is written. */
export async function validationScenario(engine: BrainEngine): Promise<void> {
  const before = await pageCount(engine);
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{}, 'ingest_input_invalid', 'missing'],
    [{ content: '   ' }, 'ingest_input_invalid', 'empty'],
    [{ content: 'a\u0000b' }, 'ingest_input_invalid', 'binary'],
    [{ content: 'x'.repeat(200_001) }, 'ingest_input_invalid', 'too_large'],
    [{ content: 'Hello.', valid_from: 'yesterday' }, 'ingest_option_invalid', 'valid_from'],
    [{ content: 'Hello.', visibility: 'team' }, 'ingest_option_invalid', 'visibility'],
    [{ content: 'Hello.', max_usd: -1 }, 'ingest_option_invalid', 'max_usd'],
    [{ content: 'Hello.', slug: 'ingest/mine' }, 'ingest_option_invalid', 'slug'],
  ];
  for (const [params, code, reason] of cases) {
    const err = await ingest(engine, params).catch(e => e) as OperationError;
    expect(err).toBeInstanceOf(OperationError);
    expect([err.code, err.reason]).toEqual([code, reason]);
  }
  expect(await pageCount(engine)).toBe(before);
}

/** Report pages are reserved: no generic page write reaches one, and none may declare the type. */
export async function namespaceScenario(engine: BrainEngine): Promise<void> {
  await seedEntities(engine);
  resetGateway();
  configureGateway({ env: {} } as never);
  const report = await ingest(engine, { content: 'ACMX met Zentrix Inc. on Tuesday.' });
  resetGateway();
  const put = operationsByName.put_page!;
  for (const ctx of [{ remote: true }, { remote: false }]) {
    const err = await put.handler(reviewCtx(engine, ctx as never), { slug: report.report_page, content: '---\ntype: note\ntitle: x\n---\n\nmine\n' }).catch(e => e) as OperationError;
    expect(err.code).toBe('ingest_namespace_reserved');
  }
  const typed = await put.handler(reviewCtx(engine), { slug: 'notes/fake-report', content: '---\ntype: ingest-report\ntitle: x\n---\n\nmine\n' }).catch(e => e) as OperationError;
  expect(typed.code).toBe('ingest_namespace_reserved');
  const del = await operationsByName.delete_page!.handler(reviewCtx(engine, { remote: true } as never), { slug: report.report_page }).catch(e => e) as OperationError;
  expect(del.code).toBe('ingest_namespace_reserved');
  // Other slugs under ingest/ stay ordinary pages unless the owner reserves the namespace.
  await put.handler(reviewCtx(engine), { slug: 'ingest/notes', content: '---\ntype: note\ntitle: x\n---\n\nmine\n' });
  await engine.setConfig('ingest.reserve_namespace', 'true');
  const reserved = await put.handler(reviewCtx(engine), { slug: 'ingest/other', content: '---\ntype: note\ntitle: x\n---\n\nmine\n' }).catch(e => e) as OperationError;
  expect(reserved.code).toBe('ingest_namespace_reserved');
  await engine.unsetConfig('ingest.reserve_namespace');
}

/** Round-4 item 3: a repository-backed source with write-through disabled refuses before writing anything. */
export async function storageUnavailableScenario(engine: BrainEngine): Promise<void> {
  const before = await pageCount(engine);
  await engine.setConfig('sync.write_through', 'false');
  try {
    const err = await ingest(engine, { content: 'ACMX met Zentrix Inc. on Tuesday.' }).catch(e => e) as OperationError;
    expect(err.code).toBe('ingest_storage_unavailable');
    expect(err.reason).toBe('disabled_by_config');
    expect(await pageCount(engine)).toBe(before);
  } finally { await engine.unsetConfig('sync.write_through'); }
}

/** D3: a claim naming two entities lands on both pages, first mention first, at most two. */
export async function twoEntityScenario(engine: BrainEngine): Promise<Array<{ from_slug: string; to_slug: string; link_type: string }>> {
  await seedEntities(engine);
  const rows: StubRow[] = [{ marker: 'joined Zentrix', entities: [{ name: 'Alice Example', type: 'person', context: 'Alice Example joined Zentrix as an advisor.' }, { name: 'Zentrix', type: 'company', context: 'Alice Example joined Zentrix as an advisor.' }],
    facts: [{ fact: 'Alice Example joined Zentrix as an advisor.', kind: 'event', entities: ['Zentrix', 'Alice Example'] }] }];
  const stub = stubChat({ rows });
  try {
    const report = await ingest(engine, { content: 'Alice Example joined Zentrix as an advisor in May.' });
    expect(report.status).toBe('complete');
    const fact = report.facts.find((f: Report) => f.fact === 'Alice Example joined Zentrix as an advisor.');
    expect(fact.copies.map((c: Report) => [c.entity_slug, c.status])).toEqual([['people/alice-example', 'created'], ['companies/zentrix', 'created']]);
    expect((await factsOn(engine, 'people/alice-example')).map(f => f.fact)).toContain('Alice Example joined Zentrix as an advisor.');
    expect((await factsOn(engine, 'companies/zentrix')).map(f => f.fact)).toContain('Alice Example joined Zentrix as an advisor.');
    const edges = await engine.executeRaw<{ from_slug: string; to_slug: string; link_type: string }>("SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug IN ('people/alice-example','companies/zentrix') AND t.slug IN ('people/alice-example','companies/zentrix')");
    // Round-4 item 11: exactly one mentions edge between the two copies (the links effect derives none from fence rows).
    expect(edges).toEqual([{ from_slug: 'companies/zentrix', to_slug: 'people/alice-example', link_type: 'mentions' }]);
    return edges;
  } finally { stub.restore(); }
}
