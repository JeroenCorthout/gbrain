/**
 * Wave B (spec 6.2): the preparation of a committed upload over the single-string ceiling (PAGE_MAX_BYTES). The sealed
 * parts are spooled, one part at a time, into a private file that the segmented streamed import reads in its two
 * passes (page-body/streamed-import.ts, the reader `put --file` and managed imports use); the import verifies the
 * admitted sha256, stages the segments, and the spool is removed before publication, which reads only the staged rows.
 * No step holds the body as one string.
 *
 * Trust follows put_page: a remote writer's frontmatter and channel name the tier the write gate assesses and the tier
 * the page row ends with (min of writer and stored), and its gate-owned markers are stripped. The write gate scans a
 * whole body, so where it applies to that tier this refuses (`file_too_large`) as a put_page over the ceiling would;
 * a trusted local writer takes the source owner's tier, as a local `put --file` streamed on an unmanaged brain does. An
 * always-loaded core page (before or after) refuses: the core guard renders the page whole.
 *
 * Git is the parent: on a source bound to a worktree the upload publishes its canonical file before its row, as put_page
 * does (`prepareFileTarget`). The file is the stored page's render (`uploadPageFile`), streamed from the staged
 * segments; over the split threshold the publication lays it out as a head and parts (split-files.ts), which a strict
 * source's door commits before the row commits and a durable source's Git effect commits after. A page the source
 * declares database-only (a `storage.db_only` path, a privacy class, an ignored target) and an unbound source publish
 * database-only as before, and a strict source refuses an undeclared database-only row (G7a, git-declared.ts).
 */
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { importStreamedMarkdownFile, type StreamedPreparedImport } from '../page-body/streamed-import.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { contentRefusalError, PAGE_OVER_LIMIT_SUGGESTION } from '../import-screen.ts';
import { pageGateTrust, pageWriteTrust, stampPageTrustMarker, storedPageTier } from '../trust/page-write.ts';
import type { WriteTrust } from '../trust/tier.ts';
import { sizeStateField } from '../page-embedding-budget.ts';
import { coreMarking } from '../core-memory.ts';
import { TAKES_FENCE_BEGIN } from '../takes-fence.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { inlineRegions } from '../page-body/tail-digest.ts';
import { segmentedFactsFenceView } from '../page-body/segment-facts.ts';
import { parseFactsFence, type FactsFenceParseResult } from '../facts-fence.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { bodyStagingGoneError } from '../engine-sql/page-body.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { withoutBody } from '../page-body/page-shape.ts';
import type { BodyRegion } from '../page-body/types.ts';
import { TIMELINE_SEPARATOR } from '../page-window/document.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { readSlugRootMode } from '../sync-anchor.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { ownerSourceGateInput, publicationAttribution, writeTrustOfGate } from './attribution.ts';
import { withCoordinatedWrite } from './context.ts';
import { StreamedFileContent } from './large-file.ts';
import { bindOrigin } from './origin-guard.ts';
import { pageDatabaseOnlyPublication, prepareFileTarget } from './page-prepare.ts';
import { pageIdentityError } from './page-identity.ts';
import { remoteLinkHint } from './page-advisories.ts';
import { stagedUploadParts, stagedUploadWork, type StagingBodyRef } from './page-upload.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * put_page keeps, for a remote writer, the takes fence and the non-world facts rows remote reads hide
 * (preserveProtectedTakes, mergeHiddenFactRowsIntoBody) and refuses to drop timeline rows its content omits
 * (assertTimelineNotOmitted); all compare whole bodies. Streamed, this refuses instead: a remote replace over the
 * ceiling of a page holding a takes fence, a facts fence with a non-world row (or one that does not parse), or timeline
 * rows (unless drop_timeline), is `upload_protected_content`. Bounded: one probe of the live manifest and of
 * timeline_entries, and the facts fence alone (segmentedFactsFenceView reads only the runs holding a fence marker).
 */
async function assertNothingHiddenDropped(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, p: Record<string, unknown>): Promise<void> {
  const [found] = await engine.executeRaw<{ has_takes: boolean; has_timeline: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM page_body_manifest m JOIN pages pg ON pg.id = m.page_id WHERE m.page_id = $1 AND m.staging_id IS NULL
        AND m.gen_from <= pg.body_generation AND (m.gen_to IS NULL OR m.gen_to > pg.body_generation)
        AND m.protected_regions @> '[{"kind":"takes"}]'::jsonb) AS has_takes,
      EXISTS (SELECT 1 FROM timeline_entries WHERE page_id = $1) AS has_timeline`, [Number(snapshot.page.id)]);
  const segmented = isSegmentedPage(snapshot.page);
  const inline = segmented ? null : await inlineRegions(engine, Number(snapshot.page.id));
  const fences = inline ? Object.values(inline).map(region => parseFactsFence(region))
    : Object.values(await segmentedFactsFenceView(engine, { id: Number(snapshot.page.id), slug: row.slug, source_id: row.source_id }))
      .filter((value): value is FactsFenceParseResult => typeof value === 'object' && value !== null && 'facts' in value);
  const hiddenFacts = fences.some(fence => fence.warnings.length > 0 || fence.facts.some(fact => fact.visibility !== 'world'));
  const reason = found?.has_takes || (inline && Object.values(inline).some(region => region.includes(TAKES_FENCE_BEGIN))) ? 'takes'
    : hiddenFacts ? 'facts'
    : found?.has_timeline && p.drop_timeline !== true ? 'timeline' : null;
  if (!reason) return;
  throw opError('upload_protected_content', reason === 'takes'
    ? `Page ${row.slug} holds a takes fence that remote reads hide, and a remote replace over ${PAGE_MAX_BYTES} bytes cannot carry it over, so nothing was written.`
    : reason === 'facts'
      ? `Page ${row.slug} holds facts rows that remote reads hide, and a remote replace over ${PAGE_MAX_BYTES} bytes cannot carry them over, so nothing was written.`
      : `Page ${row.slug} has timeline rows, and a remote replace over ${PAGE_MAX_BYTES} bytes cannot check which of them its content keeps, so nothing was written.`,
    reason === 'takes' || reason === 'facts'
      ? `Replace the page with content of at most ${PAGE_MAX_BYTES} bytes (put_page keeps the hidden ${reason === 'takes' ? 'takes fence' : 'facts rows'}), or ask the user to write it locally on the brain host.`
      : `Upload the page again and commit it with drop_timeline: true only if deleting every timeline entry of the page is intended; otherwise replace it with content of at most ${PAGE_MAX_BYTES} bytes, which put_page checks entry by entry.`,
    { reason, docs: 'docs/guides/write-refusals.md#upload_protected_content' });
}

/**
 * The upload's canonical file: the page as it will be stored, rendered as `unreadPageFile` reads it back after commit
 * (export's serializer: the head, the truth, TIMELINE_SEPARATOR before the first timeline byte, the timeline, a final
 * newline). The import staged the body, which turns live only in the publication transaction, so the page's head and
 * its new generation's manifest rows are read in a transaction that applies the staged import and rolls back: nothing
 * it writes commits and the staging stays live. The file is produced from those rows each time it is read, one segment
 * text at a time by sha256 (staged texts are kept until publication), never as one string. The import holds an upload
 * carrying a facts or takes fence, so no withdrawal overlay rewrites these texts.
 */
async function uploadPageFile(engine: BrainEngine, row: WriteRequest, ref: StagingBodyRef, snapshot: PageSnapshot | null,
  prepared: StreamedPreparedImport, trust: WriteTrust | undefined): Promise<StreamedFileContent> {
  const rollback = new Error('upload render rollback');
  const box: { head?: string; rows?: Array<{ region: BodyRegion; sha256: Uint8Array }>; page?: { type: string | null; frontmatter: unknown } } = {};
  await engine.transaction(tx => withCoordinatedWrite(tx, [row.source_id], async () => {
    await prepared.apply(tx, snapshot);
    const final = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
    if (final) Object.assign(box, { head: serializePageToMarkdown({ ...withoutBody(final.page), compiled_truth: '', timeline: '' }, final.tags).slice(0, -1),
      rows: (await tx.readManifest(Number(final.page.id))).map(r => ({ region: r.region, sha256: r.sha256 })), page: { type: final.page.type ?? null, frontmatter: final.page.frontmatter } });
    throw rollback;
  }, publicationAttribution(row, trust))).catch(error => { if (error !== rollback) throw error; });
  const { head, rows } = box;
  if (head === undefined || !rows) throw bodyStagingGoneError(row.slug, ref.staging_id, null);
  return StreamedFileContent.measure(engine, async function* (exec) {
    yield head;
    let separated = false;
    for (const r of rows) {
      const text = (await exec.readSegmentTexts(row.source_id, [r.sha256])).get(Buffer.from(r.sha256).toString('hex'));
      if (text === undefined) throw bodyStagingGoneError(row.slug, ref.staging_id, null);
      if (!text.length) continue;
      if (r.region === 'timeline' && !separated) { yield TIMELINE_SEPARATOR; separated = true; }
      yield text;
    }
    yield '\n';
  }, box.page);
}

/**
 * The upload's file target on a bound source (none on an unbound one, or where `prepareFileTarget` publishes
 * database-only) and, as put_page does, the origin a new file binds in the publication (with the slug-root mode an
 * inferred source pins with its first origin, #5610).
 */
async function uploadFileTarget(engine: BrainEngine, row: WriteRequest, ref: StagingBodyRef, snapshot: PageSnapshot | null,
  prepared: StreamedPreparedImport, trust: WriteTrust | undefined): Promise<{ file: PreparedMutation['file']; bind(tx: BrainEngine): Promise<void> }> {
  const file = row.worktree_id ? await prepareFileTarget(engine, row, snapshot, await uploadPageFile(engine, row, ref, snapshot, prepared, trust), undefined,
    { remote: row.authority.remote, newPageIgnoredDatabaseOnly: true }) : undefined;
  const mintMode = file && !snapshot?.page.source_path ? await scannerSlugRootMode(engine, row.source_id, file.root) : undefined;
  const sourcePath = file && mintMode ? scannerSourcePath(file.root, file.path, mintMode) : undefined;
  const pinMode = file && sourcePath && mintMode && scannerSourcePath(file.root, file.root) && !await readSlugRootMode(engine, row.source_id) ? mintMode : undefined;
  return { file, bind: async tx => {
    if (sourcePath) await bindOrigin(tx, { sourceId: row.source_id, slug: row.slug, sourcePath, onlyIfUnset: true });
    if (!pinMode) return;
    const [pinned] = await tx.executeRaw<{ mode: string | null }>(`UPDATE sources SET config=CASE WHEN config->>'slug_root_mode' IS NULL
      THEN jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb($2::text)) ELSE config END WHERE id=$1 RETURNING config->>'slug_root_mode' AS mode`, [row.source_id, pinMode]);
    if (pinned?.mode !== pinMode) throw opError('revision_conflict', 'The source slug-root mode changed during preparation.',
      `Another write pinned source ${row.source_id}'s slug-root mode while ${row.slug} was being prepared, so this upload rolled back. Once the request is final, upload the page again; it is prepared under the pinned mode.`);
  } };
}

export async function prepareStreamedUpload(engine: BrainEngine, row: WriteRequest, ref: StagingBodyRef): Promise<PreparedMutation> {
  const p = row.intent as Record<string, unknown>;
  const policy = await readPageBodyPolicy(engine);
  if (!policy.segmented || ref.bytes > policy.maxBytes) {
    throw contentRefusalError({ code: 'file_too_large', message: `Page too large (${ref.bytes} bytes): segmented page storage (pages.segmented_storage) is off or the page is over pages.max_bytes (${policy.maxBytes}).` },
      PAGE_OVER_LIMIT_SUGGESTION, { legacy_error: 'request_too_large' });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  assertPageRevision(snapshot, { expectedRevision: text(p.expected_revision) });
  if ((snapshot?.page.id ?? null) !== row.page_id) throw pageIdentityError(!!snapshot, 'The accepted page was deleted or recreated.');
  const remote = row.authority.remote === true;
  if (remote && snapshot && !snapshot.page.deleted_at) await assertNothingHiddenDropped(engine, row, snapshot, p);
  const storedTier = remote && snapshot ? await storedPageTier(engine, row.source_id, row.slug) : null;
  let trust: WriteTrust | undefined;
  const dir = await mkdtemp(join(tmpdir(), 'gbrain-upload-'));
  let ready: StreamedPreparedImport | undefined;
  let result: Awaited<ReturnType<typeof importStreamedMarkdownFile>>;
  try {
    const path = join(dir, 'page.md');
    const spool = await open(path, 'wx', 0o600);
    try {
      for await (const part of stagedUploadParts(engine, ref)) {
        if (!part) throw bodyStagingGoneError(row.slug, ref.staging_id, null);
        await spool.write(part);
      }
    } finally { await spool.close(); }
    const stat = await lstat(path);
    if (stat.size !== ref.bytes) throw bodyStagingGoneError(row.slug, ref.staging_id, null);
    stagedUploadWork.streamed++;
    result = await importStreamedMarkdownFile(engine, path, `${row.slug}.md`, { sourceId: row.source_id, noEmbed: true, inferFrontmatter: false,
      content: { provenance: { source_kind: text(p.source_kind), source_uri: text(p.source_uri), ingested_via: text(p.ingested_via) },
        ...(remote ? { writer: {
          gate: async (frontmatter: Record<string, unknown>) => {
            trust = pageWriteTrust(row, frontmatter);
            const gate = pageGateTrust(row, trust, storedTier);
            return gate ? { tier: gate.tier, origin: { channel: gate.origin?.channel ?? row.operation }, requestId: null } : ownerSourceGateInput(engine, row.source_id, frontmatter);
          },
          stamp: (frontmatter: Record<string, unknown>) => stampPageTrustMarker(row, frontmatter, trust, storedTier),
        } } : {}) },
      coordinated: { snapshot, sha256: ref.sha256, slug: row.slug, prepare: async value => { ready = value; return value.result; },
        owner: { kind: 'put', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: snapshot?.revision ?? null } } }, stat, policy)
      .catch(error => { throw error instanceof OperationError && error.code === 'source_changed' ? bodyStagingGoneError(row.slug, ref.staging_id, null) : error; });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!ready) {
    if (result.refusal?.code === 'file_too_large') throw contentRefusalError(result.refusal, PAGE_OVER_LIMIT_SUGGESTION, { legacy_error: 'request_too_large' });
    if (result.refusal) throw contentRefusalError(result.refusal, 'Correct the content as the message says, then upload it again with a new request_id.', { legacy_error: 'invalid_params' });
    throw opError('invalid_params', result.error ?? 'The uploaded page could not be prepared.', `Page ${row.slug} was not written. Fix what the message names, then upload it again with a new request_id.`);
  }
  const prepared: StreamedPreparedImport = ready;
  if (coreMarking(snapshot?.page.frontmatter).core || coreMarking(prepared.frontmatter).core) {
    throw opError('page_body_segmented', `Page ${row.slug} is (or would become) always-loaded core memory, whose budget renders the page whole, and this upload is over ${PAGE_MAX_BYTES} bytes. Nothing was written.`,
      'Write a core page within the single-string ceiling, or drop always_load from its frontmatter.');
  }
  if (prepared.observedRevision !== (snapshot?.revision ?? null)) {
    throw opError('revision_conflict', 'The page changed during upload preparation.', `Page ${row.slug} changed while this upload was prepared, so nothing was written. Read the page and upload again against its current revision.`);
  }
  const pageTrust = remote ? trust : writeTrustOfGate(await ownerSourceGateInput(engine, row.source_id, prepared.frontmatter));
  const target = await uploadFileTarget(engine, row, ref, snapshot, prepared, pageTrust);
  const mutation: PreparedMutation = { observedRevision: prepared.observedRevision, noop: prepared.noop, ...(pageTrust ? { trust: pageTrust } : {}),
    file: target.file, ...await pageDatabaseOnlyPublication(engine, row, target.file),
    ...(prepared.afterCommit ? { afterCommit: prepared.afterCommit } : {}),
    apply: async (tx, preimage) => {
      await prepared.apply(tx, preimage);
      if (!prepared.noop) await target.bind(tx);
      const final = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      mutation.postimage = final;
      return { ...remoteLinkHint(row), status: prepared.noop ? 'skipped' : 'created_or_updated', slug: row.slug, source_id: row.source_id, noop: prepared.noop,
        chunks: result.chunks, ...(prepared.noop ? {} : await sizeStateField(tx, row.source_id, row.slug, final?.page)) };
    } };
  return mutation;
}
