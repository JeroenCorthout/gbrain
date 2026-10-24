/**
 * Database-canonical memory, wave 3: the import lane in observe mode (docs/designs/DATABASE_CANONICAL_MEMORY.md, "The import
 * lane"). For a source whose shadow flag is on, while the brain gate is on, a pass finds outside changes to page files,
 * classifies each with the design's decision table against the export ledger (the merge base wave 2 seeds), and records the
 * outcome it would have taken in `import_conflicts`, the writers behind the changes in `import_foreign_writes` and the
 * pass itself in `import_lane_passes`. It never imports, writes a page, touches the ledger or touches the checkout.
 *
 * Detection reads files and hardened Git plumbing only (import-lane-git.ts). A file counts once its bytes are stable: a
 * pass hashes every candidate, waits `stableMs`, hashes again and defers any whose bytes moved. Unchanged means the raw
 * bytes still hash to the ledger's `disk_sha256`, so an autocrlf or LFS checkout whose working-tree bytes differ from the
 * committed blob does not look edited. The writes run in one transaction that re-reads the shadow flag and epoch first: a
 * pass whose source flipped meanwhile records nothing.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { exportPathKey } from '../export-stage.ts';
import { readExportPage, readExportWithdrawals } from '../export-snapshot.ts';
import { screenImportContent } from '../import-screen.ts';
import { parseMarkdown } from '../markdown.ts';
import { isSyncable, pathToSlug } from '../sync.ts';
import { readSyncDeleteCaps, syncDeleteTrip } from '../sync-reconcile.ts';
import { hardenedGitStream, hardenedPathDirty, NulRecordSplitter } from '../hardened-git.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { alignWithStored } from './align-stored.ts';
import { compareInlineExportFile, compareSegmentedExportFile, databaseCanonicalEnabled } from './canonical-export.ts';
import { readSourceCanonicalState } from './canonical-shadow.ts';
import { digest } from './digest.ts';
import type { ImportConflictKind } from './import-conflict-mapping.ts';
import { IMPORT_CONFLICT_INLINE_BYTES, type IMPORT_LANE_OUTCOMES } from './import-conflicts-schema.ts';
import { messagePrefix, processHint, readGitCheckout, treeHoldsPath, walkCommits, writerKey, type CommitWalk, type GitCheckout } from './import-lane-git.ts';
import { protectedReconcileKey, reconcileCanonical } from './reconcile-merge.ts';
import { reconcileFileReading } from './reconcile-state.ts';
import { readBlobs } from './sync-git-stream.ts';

export type ImportLaneOutcome = typeof IMPORT_LANE_OUTCOMES[number];

/** What the decision table reads about one changed path; everything I/O is resolved before it runs. */
export interface ImportCaseFacts {
  /** The live ledger row of the path: the revision it rendered and its raw hash. Null: never exported (no base). */
  base: { revision: string; disk_sha256: string } | null;
  /** The page the path belongs to (by the ledger, else by origin or slug), or null when there is none. */
  page: { live: boolean; revision: string; segmented: boolean } | null;
  /** The stable file: gone, or present with what the screens and the equality contract said. */
  file: { state: 'missing'; evidence: 'at_head' | 'removed_by_commit' | 'none' }
    | { state: 'present'; tooLarge: boolean; screen: string | null; equal: boolean; protectedChanged: boolean };
}

export interface ImportCaseDecision { outcome: ImportLaneOutcome; kind?: ImportConflictKind; reason: string }

/**
 * The design's decision table for one outside change. Rows, in order:
 * gone and still committed at HEAD -> `deleted_uncommitted`; gone with no live page -> nothing (both sides deleted);
 * gone with no commit removing it -> nothing (absence is not deletion); gone and the database unchanged -> delete;
 * gone and the database changed -> `deleted_vs_edited`; over the request cap -> streamed import when the database is
 * unchanged, else `too_large_for_lane`; failing a content screen -> `unparseable`; equal to the page -> adopt; no
 * ledger row and a page -> `unexported_collision`; no ledger row and no page -> create; the page deleted since export ->
 * `both_changed`; the database unchanged -> import, or `protected_metadata` when the file changes a protected key;
 * otherwise `both_changed` (a segmented page is never compared partially).
 */
export function decideImportCase(facts: ImportCaseFacts): ImportCaseDecision {
  const { base, page, file } = facts;
  const unchanged = !!base && !!page?.live && page.revision === base.revision;
  if (file.state === 'missing') {
    if (!base) return { outcome: 'none', reason: 'never_exported_missing' };
    if (file.evidence === 'at_head') return { outcome: 'conflict', kind: 'deleted_uncommitted', reason: 'gone_from_worktree_committed_at_head' };
    if (!page?.live) return { outcome: 'none', reason: 'both_deleted' };
    if (file.evidence === 'none') return { outcome: 'none', reason: 'deletion_unproven' };
    return unchanged ? { outcome: 'delete', reason: 'deleted_by_commit' } : { outcome: 'conflict', kind: 'deleted_vs_edited', reason: 'deleted_by_commit_database_changed' };
  }
  if (file.tooLarge) return unchanged ? { outcome: 'streamed_import', reason: 'over_request_cap' } : { outcome: 'conflict', kind: 'too_large_for_lane', reason: 'over_request_cap' };
  if (file.screen) return { outcome: 'conflict', kind: 'unparseable', reason: file.screen };
  if (page?.live && file.equal) return { outcome: 'adopt', reason: 'equal_to_page' };
  if (!base) return page?.live ? { outcome: 'conflict', kind: 'unexported_collision', reason: 'page_without_ledger' } : { outcome: 'create', reason: 'no_page' };
  if (!page?.live) return { outcome: 'conflict', kind: 'both_changed', reason: 'page_deleted_since_export' };
  if (unchanged) return file.protectedChanged ? { outcome: 'conflict', kind: 'protected_metadata', reason: 'protected_key_changed' } : { outcome: 'import', reason: 'database_unchanged' };
  return { outcome: 'conflict', kind: 'both_changed', reason: page.segmented ? 'segmented_both_changed' : 'both_changed' };
}

/** A three-way field count for a two-sided change: which fields a base-aware merge would have resolved. */
export interface MergeCounts { file_only: number; database_only: number; both_same: number; both_differ: number; resolvable: boolean; differ_fields: string[] }

type Canonical = ReturnType<typeof reconcileCanonical>;

/** Fields compared one by one: every top-level field of the comparison form, the tag set as one field, and each frontmatter key (delete-aware: absent is a value). */
export function mergeCounts(base: Canonical, file: Canonical, database: Canonical): MergeCounts {
  const fields = (page: Canonical): Map<string, string> => {
    const map = new Map<string, string>();
    for (const [field, value] of Object.entries(page)) {
      if (field !== 'frontmatter') map.set(`/${field}`, digest(field === 'tags' ? [...(value as string[])].sort() : value ?? ''));
    }
    for (const [key, value] of Object.entries(page.frontmatter ?? {})) map.set(`/frontmatter/${key}`, digest(value));
    return map;
  };
  const b = fields(base), f = fields(file), d = fields(database);
  const counts: MergeCounts = { file_only: 0, database_only: 0, both_same: 0, both_differ: 0, resolvable: true, differ_fields: [] };
  for (const path of [...new Set([...b.keys(), ...f.keys(), ...d.keys()])].sort()) {
    const fileMoved = f.get(path) !== b.get(path), dbMoved = d.get(path) !== b.get(path);
    if (fileMoved && dbMoved) {
      if (f.get(path) === d.get(path)) counts.both_same++;
      else { counts.both_differ++; if (counts.differ_fields.length < 20) counts.differ_fields.push(path); }
    } else if (fileMoved) counts.file_only++;
    else if (dbMoved) counts.database_only++;
  }
  counts.resolvable = counts.both_differ === 0;
  return counts;
}

/** A file's comparison form, parsed the way the equality contract parses it (compareInlineExportFile), or null when it does not parse. */
function fileCanonical(raw: Buffer, importPath: string, page: { slug: string; type: string; frontmatter?: Record<string, unknown> | null }): Canonical | null {
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) return null;
  const reading = reconcileFileReading(text, importPath, page);
  const parsed = parseMarkdown(reading.content, `${page.slug}.md`, { validate: true, expectedSlug: page.slug });
  if (parsed.errors?.some(e => !['MISSING_OPEN', 'EMPTY_FRONTMATTER'].includes(e.code))) return null;
  alignWithStored(parsed, page as Parameters<typeof alignWithStored>[1], reading.inferred);
  return reconcileCanonical(parsed, parsed.tags);
}

interface LedgerRow { page_id: number; path: string; path_folded: string; revision: string; disk_sha256: string; blob_oid: string | null; commit_sha: string | null }

async function readLedger(engine: BrainEngine, sourceId: string): Promise<Map<string, LedgerRow>> {
  const rows = await engine.executeRaw<LedgerRow>(`SELECT page_id, path, path_folded, revision::text, disk_sha256, blob_oid, commit_sha
    FROM export_ledger WHERE source_id=$1 AND retired_at IS NULL`, [sourceId]);
  return new Map(rows.map(row => [row.path_folded, { ...row, page_id: Number(row.page_id) }]));
}

type Read = { state: 'missing' } | { state: 'present'; sha256: string; size: number } | { state: 'unreadable'; reason: string };

async function readStable(abs: string): Promise<Read> {
  let stat;
  try { stat = lstatSync(abs); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: 'stat_failed' }; }
  if (!stat.isFile()) return { state: 'unreadable', reason: stat.isSymbolicLink() ? 'symlink' : 'not_regular_file' };
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer); } catch { return { state: 'unreadable', reason: 'read_failed' }; }
  return { state: 'present', sha256: hash.digest('hex'), size: stat.size };
}

const sameRead = (a: Read, b: Read) => a.state === b.state && (a.state !== 'present' || b.state === 'present' && a.sha256 === b.sha256);

/** Source-relative page file paths Git sees in the worktree: tracked ones and untracked ones it does not ignore. */
async function listWorktreeFiles(root: string): Promise<string[] | null> {
  const files: string[] = [];
  for (const args of [['ls-files', '-z', '--cached'], ['ls-files', '-z', '--others', '--exclude-standard']]) {
    const splitter = new NulRecordSplitter();
    const result = await hardenedGitStream(root, args, { timeoutMs: 120_000, maxBytes: 512 * 1024 * 1024,
      onChunk: chunk => { for (const record of splitter.push(chunk)) files.push(record.toString('utf8')); } });
    if (!result.ok || !splitter.atRecordBoundary) return null;
  }
  return [...new Set(files)];
}

export interface ObservePassOptions {
  /** Restrict the pass to these source-relative paths (a file watch's events); default: a full scan of the ledger and the worktree. */
  paths?: readonly string[];
  /** How long bytes must stay the same between the two reads. Default 2000 ms. */
  stableMs?: number;
  /** Commits a pass walks at most. Default 500. */
  maxCommits?: number;
  /** How far back the first pass of an epoch walks the history. Default 90 days. */
  horizonDays?: number;
  /** @internal test seam: what runs between the two reads (default: wait `stableMs`). */
  betweenReads?: () => Promise<void>;
}

export interface ObservePassResult {
  status: 'observed' | 'skipped';
  reason?: 'gate_off' | 'shadow_off' | 'no_checkout' | 'epoch_moved';
  source_id: string;
  shadow_epoch: number | null;
  pass_id: number | null;
  scanned: number;
  unstable: number;
  commits: number;
  head_commit: string | null;
  outcomes: Partial<Record<ImportLaneOutcome, number>>;
  kinds: Partial<Record<ImportConflictKind, number>>;
}

interface Observation {
  path: string; path_folded: string; page_id: number | null; decision: ImportCaseDecision; base: LedgerRow | null; db_revision: string | null;
  read: Read; bytes: Buffer | null; commit_sha: string | null; merge: MergeCounts | null; detail: Record<string, unknown>;
}

const skipped = (sourceId: string, reason: NonNullable<ObservePassResult['reason']>, epoch: number | null = null): ObservePassResult =>
  ({ status: 'skipped', reason, source_id: sourceId, shadow_epoch: epoch, pass_id: null, scanned: 0, unstable: 0, commits: 0, head_commit: null, outcomes: {}, kinds: {} });

/** One observe-mode pass over a shadowed source. Writes only import_conflicts, import_foreign_writes and import_lane_passes. */
export async function observeImportLane(engine: BrainEngine, sourceId: string, opts: ObservePassOptions = {}): Promise<ObservePassResult> {
  const startedAt = new Date().toISOString();
  if (!await databaseCanonicalEnabled(engine)) return skipped(sourceId, 'gate_off');
  const state = await readSourceCanonicalState(engine, sourceId);
  if (!state?.shadow) return skipped(sourceId, 'shadow_off', state?.shadow_epoch ?? null);
  const epoch = state.shadow_epoch;
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  const root = source?.local_path && existsSync(source.local_path) ? realpathSync(source.local_path) : null;
  const checkout = root ? readGitCheckout(root) : null;
  if (!root || !checkout) return skipped(sourceId, 'no_checkout', epoch);

  const ledger = await readLedger(engine, sourceId);
  const pagePath = (path: string) => isSyncable(path);
  let candidates: string[];
  if (opts.paths) candidates = opts.paths.filter(path => pagePath(path) || ledger.has(safeKey(path) ?? ''));
  else {
    const listed = await listWorktreeFiles(root);
    if (!listed) return skipped(sourceId, 'no_checkout', epoch);
    candidates = [...new Set([...[...ledger.values()].map(row => row.path), ...listed.filter(pagePath)])];
  }

  const first = new Map<string, Read>();
  const cleared: string[] = [];
  for (const path of candidates) {
    const key = safeKey(path);
    if (key === null) continue;
    const read = await readStable(join(root, ...path.split('/')));
    const base = ledger.get(key);
    if (base && read.state === 'present' && read.sha256 === base.disk_sha256) { cleared.push(key); continue; }
    if (!base && read.state === 'missing') continue;
    first.set(path, read);
  }
  await (opts.betweenReads ?? (() => new Promise<void>(resolve => setTimeout(resolve, opts.stableMs ?? 2000))))();
  let unstable = 0;
  const stable = new Map<string, Read>();
  for (const [path, read] of first) {
    const again = await readStable(join(root, ...path.split('/')));
    if (sameRead(read, again)) stable.set(path, again); else unstable++;
  }

  const [last] = await engine.executeRaw<{ head_commit: string | null }>(`SELECT head_commit FROM import_lane_passes WHERE source_id=$1 AND shadow_epoch=$2
    ORDER BY id DESC LIMIT 1`, [sourceId, epoch]);
  const walk = await walkCommits(checkout, { stopAt: last?.head_commit ?? null, horizonMs: Date.now() - (opts.horizonDays ?? 90) * 86_400_000, maxCommits: opts.maxCommits ?? 500 });
  const newest = new Map<string, { sha: string; deleted: boolean }>();
  for (const commit of walk.commits) for (const change of walk.changes.get(commit.sha) ?? []) if (!newest.has(change.path)) newest.set(change.path, { sha: commit.sha, deleted: change.deleted });

  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const observations: Observation[] = [];
  for (const [path, read] of stable) observations.push(await observePath(engine, sourceId, root, checkout, mode, ledger, path, read, newest));

  const deletes = observations.filter(o => o.decision.outcome === 'delete');
  if (deletes.length && syncDeleteTrip(deletes.length, ledger.size, await readSyncDeleteCaps(engine, sourceId))) {
    for (const o of deletes) { o.decision = { outcome: 'conflict', kind: 'bulk_delete', reason: 'over_mass_delete_valve' }; o.detail.batch_size = deletes.length; }
  }
  const deferred = [...first.keys()].filter(path => !stable.has(path)).map(exportPathKey);
  return recordPass(engine, { sourceId, epoch, startedAt, root, checkout, observations, cleared, deferred, unstable, scanned: candidates.length, walk, full: !opts.paths });
}

function safeKey(path: string): string | null {
  try { return exportPathKey(path); } catch { return null; }
}

async function observePath(engine: BrainEngine, sourceId: string, root: string, checkout: GitCheckout, mode: Awaited<ReturnType<typeof scannerSlugRootMode>>,
  ledger: Map<string, LedgerRow>, path: string, read: Read, newest: Map<string, { sha: string; deleted: boolean }>): Promise<Observation> {
  const key = exportPathKey(path);
  const base = ledger.get(key) ?? null;
  const abs = join(root, ...path.split('/'));
  const importPath = scannerSourcePath(root, abs, mode);
  const [row] = base
    ? await engine.executeRaw<PageRow>(`${PAGE_SELECT} WHERE id=$1`, [base.page_id])
    : await engine.executeRaw<PageRow>(`${PAGE_SELECT} WHERE source_id=$1 AND deleted_at IS NULL AND (source_path=$2 OR slug=$3) ORDER BY (source_path=$2) DESC LIMIT 1`,
      [sourceId, importPath, pathToSlug(path)]);
  const live = !!row && row.source_id === sourceId && row.deleted_at === null;
  const page = row ? { live, revision: row.revision, segmented: row.segmented } : null;
  const observation: Observation = { path, path_folded: key, page_id: row ? Number(row.id) : base?.page_id ?? null, base, db_revision: row?.revision ?? null,
    read, bytes: null, commit_sha: null, merge: null, detail: {}, decision: { outcome: 'none', reason: 'unclassified' } };

  if (read.state === 'missing') {
    const atHead = checkout.head ? treeHoldsPath(checkout, checkout.head, path) : false;
    const removal = newest.get(path);
    const committed = removal?.deleted || (!!base?.commit_sha && treeHoldsPath(checkout, base.commit_sha, path) === true);
    const evidence = atHead ? 'at_head' : committed ? 'removed_by_commit' : 'none';
    if (removal?.deleted) observation.commit_sha = removal.sha;
    observation.decision = decideImportCase({ base, page, file: { state: 'missing', evidence } });
    return observation;
  }
  if (read.state === 'unreadable') {
    observation.decision = { outcome: 'conflict', kind: 'unparseable', reason: 'file_unreadable' };
    observation.detail = { code: 'file_unreadable', reason: read.reason };
    return observation;
  }
  const commit = newest.get(path);
  if (commit && !commit.deleted && hardenedPathDirty(root, path) === false) observation.commit_sha = commit.sha;
  const tooLarge = read.size > IMPORT_CONFLICT_INLINE_BYTES;
  let screen: string | null = null, equal = false, protectedChanged = false;
  if (!tooLarge) {
    const raw = readFileSync(abs);
    observation.bytes = raw;
    const text = raw.toString('utf8');
    const screened = Buffer.from(text).equals(raw) ? screenImportContent({ content: text, path, expectedSlug: row?.slug ?? null, fences: 'coordinated' })
      : { status: 'refused' as const, refusal: { code: 'not_utf8', message: 'The file is not valid UTF-8.' } };
    if (screened.status === 'refused') {
      screen = screened.refusal.code;
      observation.detail = { code: screened.refusal.code, message: screened.refusal.message };
    } else if (row && live) {
      const compared = await engine.transaction(async tx => {
        await tx.executeRaw('SET TRANSACTION READ ONLY');
        const withdrawals = await readExportWithdrawals(tx, sourceId);
        const snapshot = await readExportPage(tx, { id: String(row.id), source_id: sourceId, slug: row.slug }, withdrawals);
        const result = row.segmented ? await compareSegmentedExportFile(tx, abs, snapshot, withdrawals) : compareInlineExportFile(raw, importPath, snapshot);
        return { result, database: row.segmented ? null : reconcileCanonical(snapshot.page, snapshot.tags), page: snapshot.page };
      });
      if (compared.result.state === 'unparseable') { screen = 'unparseable'; observation.detail = { code: 'unparseable' }; }
      equal = compared.result.state === 'equal';
      if (compared.result.state === 'differs') {
        observation.detail = { fields: compared.result.paths };
        protectedChanged = compared.result.paths.some(p => p.startsWith('/frontmatter/') && protectedReconcileKey(p.slice(13).replace(/~1/g, '/').replace(/~0/g, '~')));
      }
      observation.decision = decideImportCase({ base, page, file: { state: 'present', tooLarge, screen, equal, protectedChanged } });
      if (observation.decision.kind === 'both_changed' && compared.database && base?.blob_oid) {
        const blob = (await readBlobs(checkout.top, [base.blob_oid], IMPORT_CONFLICT_INLINE_BYTES).catch(() => new Map<string, Buffer>())).get(base.blob_oid);
        const baseCanonical = blob ? fileCanonical(blob, importPath, compared.page) : null;
        const fileC = fileCanonical(raw, importPath, compared.page);
        observation.merge = baseCanonical && fileC ? mergeCounts(baseCanonical, fileC, compared.database) : null;
      }
      return observation;
    }
  }
  observation.decision = decideImportCase({ base, page, file: { state: 'present', tooLarge, screen, equal, protectedChanged } });
  return observation;
}

interface PageRow { id: number; slug: string; source_id: string; revision: string; deleted_at: string | null; segmented: boolean }
const PAGE_SELECT = `SELECT id, slug, source_id, knowledge_revision::text AS revision, deleted_at::text AS deleted_at, body_storage='segmented' AS segmented FROM pages`;

/** The private ref a live lane pins bytes above the inline limit under; observe mode names it and never creates it. */
export function conflictRef(sourceId: string, sha256: string): string {
  return `refs/gbrain/import-conflicts/${encodeURIComponent(sourceId)}/${sha256}`;
}

async function recordPass(engine: BrainEngine, run: { sourceId: string; epoch: number; startedAt: string; root: string; checkout: GitCheckout; observations: Observation[];
  cleared: string[]; deferred: string[]; unstable: number; scanned: number; walk: CommitWalk; full: boolean }): Promise<ObservePassResult> {
  const { sourceId, epoch, observations } = run;
  const outcomes: ObservePassResult['outcomes'] = {}, kinds: ObservePassResult['kinds'] = {};
  for (const o of observations) {
    outcomes[o.decision.outcome] = (outcomes[o.decision.outcome] ?? 0) + 1;
    if (o.decision.kind) kinds[o.decision.kind] = (kinds[o.decision.kind] ?? 0) + 1;
  }
  const pagePaths = new Set(observations.map(o => o.path));
  const writes: Array<Record<string, unknown>> = [];
  for (const commit of run.walk.commits) {
    const hint = processHint(commit);
    for (const change of run.walk.changes.get(commit.sha) ?? []) {
      if (!isSyncable(change.path) && !pagePaths.has(change.path)) continue;
      const key = safeKey(change.path);
      if (key === null) continue;
      writes.push({ path: change.path, path_folded: key, change_key: commit.sha, commit_sha: commit.sha, author_name: commit.author?.name ?? null,
        author_email: commit.author?.email ?? null, committer_name: commit.committer?.name ?? null, committer_email: commit.committer?.email ?? null,
        committed_at: commit.committer?.at ?? null, message_prefix: messagePrefix(commit.subject), process_hint: hint, writer_key: writerKey(commit.author, hint) });
    }
  }
  for (const o of observations) {
    if (o.commit_sha || o.read.state !== 'present') continue;
    writes.push({ path: o.path, path_folded: o.path_folded, change_key: `worktree:${o.read.sha256}`, commit_sha: null, author_name: null, author_email: null,
      committer_name: null, committer_email: null, committed_at: null, message_prefix: null, process_hint: 'uncommitted_worktree', writer_key: 'worktree|uncommitted_worktree' });
  }

  return engine.transaction(async tx => {
    const [flag] = await tx.executeRaw<{ shadow: boolean; shadow_epoch: number }>('SELECT shadow, shadow_epoch::int AS shadow_epoch FROM database_canonical_sources WHERE source_id=$1 FOR SHARE', [sourceId]);
    if (!flag?.shadow || Number(flag.shadow_epoch) !== epoch || !await databaseCanonicalEnabled(tx as BrainEngine)) return skipped(sourceId, 'epoch_moved', epoch);
    await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='epoch_changed'
      WHERE source_id=$1 AND state='open' AND shadow_epoch<>$2`, [sourceId, epoch]);
    if (run.cleared.length) {
      await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='cleared'
        WHERE source_id=$1 AND state='open' AND path_folded = ANY($2::text[])`, [sourceId, run.cleared]);
    }
    if (run.full) {
      await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='cleared'
        WHERE source_id=$1 AND state='open' AND NOT (path_folded = ANY($2::text[]))`, [sourceId, [...observations.map(o => o.path_folded), ...run.deferred]]);
    }
    for (const o of observations) {
      const present = o.read.state === 'present' ? o.read : null;
      const conflict = o.decision.outcome === 'conflict';
      const inline = conflict && o.bytes && o.bytes.length <= IMPORT_CONFLICT_INLINE_BYTES ? o.bytes : null;
      const ref = conflict && present && !inline ? conflictRef(sourceId, present.sha256) : null;
      const detail = { ...o.detail, reason: o.decision.reason, ...(ref ? { ref_pinned: false } : {}) };
      const [open] = await tx.executeRaw<{ id: number; same: boolean }>(`SELECT id, (outcome=$3 AND kind IS NOT DISTINCT FROM $4 AND file_sha256 IS NOT DISTINCT FROM $5
          AND db_revision IS NOT DISTINCT FROM $6::uuid) AS same FROM import_conflicts WHERE source_id=$1 AND path_folded=$2 AND state='open'`,
        [sourceId, o.path_folded, o.decision.outcome, o.decision.kind ?? null, present?.sha256 ?? null, o.db_revision]);
      if (open?.same) {
        await tx.executeRaw('UPDATE import_conflicts SET observed_at=now(), commit_sha=COALESCE($2, commit_sha) WHERE id=$1', [open.id, o.commit_sha]);
        continue;
      }
      if (open) await tx.executeRaw(`UPDATE import_conflicts SET state='resolved', resolved_at=now(), resolution='superseded' WHERE id=$1`, [open.id]);
      await tx.executeRaw(`INSERT INTO import_conflicts(source_id, path, path_folded, page_id, outcome, kind, shadow_epoch, base_revision, db_revision, base_sha256,
          file_sha256, file_size, file_bytes, file_ref, commit_sha, merge, detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9::uuid,$10,$11,$12,$13,$14,$15,$16::text::jsonb,$17::text::jsonb)`,
        [sourceId, o.path, o.path_folded, o.page_id, o.decision.outcome, o.decision.kind ?? null, epoch, o.base?.revision ?? null, o.db_revision,
          o.base?.disk_sha256 ?? null, present?.sha256 ?? null, present?.size ?? null, inline, ref, o.commit_sha,
          o.merge ? JSON.stringify(o.merge) : null, JSON.stringify(detail)]);
    }
    if (writes.length) {
      await tx.executeRaw(`INSERT INTO import_foreign_writes(source_id, path, path_folded, change_key, commit_sha, author_name, author_email, committer_name,
          committer_email, committed_at, message_prefix, process_hint, writer_key, shadow_epoch)
        SELECT $1, w.path, w.path_folded, w.change_key, w.commit_sha, w.author_name, w.author_email, w.committer_name, w.committer_email,
          w.committed_at::timestamptz, w.message_prefix, w.process_hint, w.writer_key, $2
        FROM jsonb_to_recordset($3::text::jsonb) AS w(path text, path_folded text, change_key text, commit_sha text, author_name text, author_email text,
          committer_name text, committer_email text, committed_at text, message_prefix text, process_hint text, writer_key text)
        ON CONFLICT (source_id, path_folded, change_key) DO NOTHING`, [sourceId, epoch, JSON.stringify(writes)]);
    }
    const [pass] = await tx.executeRaw<{ id: number }>(`INSERT INTO import_lane_passes(source_id, shadow_epoch, head_commit, commits, scanned, unstable, outcomes, kinds, started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9::timestamptz) RETURNING id`,
      [sourceId, epoch, run.checkout.head, run.walk.commits.length, run.scanned, run.unstable, JSON.stringify(outcomes), JSON.stringify(kinds), run.startedAt]);
    return { status: 'observed', source_id: sourceId, shadow_epoch: epoch, pass_id: Number(pass!.id), scanned: run.scanned, unstable: run.unstable,
      commits: run.walk.commits.length, head_commit: run.checkout.head, outcomes, kinds } satisfies ObservePassResult;
  });
}
