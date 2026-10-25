/**
 * `gbrain pages split-storage <slug> [--source <id>] [--apply] [--json] [--resolve-head keep-edit|discard]` (Wave B
 * PR 5, spec §9 option B): show, and on `--apply` change, how a page's canonical file is laid out in Git. A page whose
 * canonical file F (`serializePageToMarkdown`, streamed from the segments for a segmented page) is over
 * `sync.max_file_bytes` is stored as a head file plus hidden part files (src/core/split-layout/); at or under it, as
 * one file.
 *
 * The preview (default) reads the stored page and the files at its canonical path on this host (the source's owner
 * host) and reports the current layout (missing, one file, or a head with its parts and their verdict), the threshold
 * and what `--apply` would write: the head and each part with its name and size, the parts left as they are and the
 * removals. It writes nothing: the split plan's private staged copy is removed before it returns, and no request,
 * row or file is created.
 *
 * `--apply` republishes the page's file through the ordinary write door (the `managed_maintenance_split_relayout`
 * intent, split-layout/relayout.ts: the coordinator publishes the stored page's file with the page row untouched, bound
 * to the revision the preview read), so the write path lays the file out; it then reads the files back and reports
 * whether they are in the planned layout.
 *
 * A head whose body was edited (`split_head_modified`) is resolved with `--resolve-head`: `keep-edit` publishes, as a
 * replacement of the page at its revision, the head frontmatter without `gbrain_parts` + the edited head body without
 * the notice line + the page body from the parts after the lead (B[lead_bytes:]); `discard` republishes the stored
 * page over the head. Both preview first. Trusted local CLI only (the `pages` command refuses on a thin client); never
 * an MCP operation and never run by an upgrade or migration.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { PageSnapshot } from '../core/page-state/types.ts';
import { opError, type OperationContext } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { FileBytes } from '../core/persistence/large-file.ts';
import { canonicalPath, sourceContext } from '../core/ghost-pages.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { loadConfig } from '../core/config.ts';
import { partsDirFor } from '../core/split-layout/paths.ts';
import { planSplit, splitScratchPath } from '../core/split-layout/plan.ts';
import { SPLIT_MAX_FILE_BYTES_KEY, splitThresholdBytes } from '../core/split-layout/limits.ts';
import { SplitLayoutError } from '../core/split-layout/types.ts';
import { readCanonicalLayout, type CanonicalLayout } from '../core/split-layout/disk-layout.ts';
import { writeKeptEdit } from '../core/split-layout/resolve-head.ts';
import { renderedPageFile } from '../core/split-layout/relayout.ts';

export const SPLIT_STORAGE_USAGE = 'Usage: gbrain pages split-storage <slug> [--source <id>] [--apply] [--json] [--resolve-head keep-edit|discard]';
const DOCS = 'docs/guides/memory-boundaries.md#large-pages-in-git';

export type ResolveHeadMode = 'keep-edit' | 'discard';
export interface SplitStorageArgs { slug: string; source: string | null; apply: boolean; json: boolean; resolveHead: ResolveHeadMode | null }

/** One positional slug, `--source <id>`, `--resolve-head keep-edit|discard` (also `--flag=value`), `--apply`, `--json`; anything else is `invalid_params`. */
export function parseSplitStorageArgs(args: readonly string[]): SplitStorageArgs {
  const parsed: SplitStorageArgs = { slug: '', source: null, apply: false, json: false, resolveHead: null };
  const refuse = (message: string) => opError('invalid_params', message, SPLIT_STORAGE_USAGE);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--apply') { parsed.apply = true; continue; }
    if (arg === '--json') { parsed.json = true; continue; }
    const flag = ['--source', '--resolve-head'].find(name => arg === name || arg.startsWith(name + '='));
    if (flag) {
      const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
      if (!value || value.startsWith('-')) throw refuse(`${flag} needs a value.`);
      if (flag === '--source') {
        if (parsed.source !== null) throw refuse('--source was given more than once.');
        parsed.source = value;
      } else {
        if (parsed.resolveHead !== null) throw refuse('--resolve-head was given more than once.');
        if (value !== 'keep-edit' && value !== 'discard') throw refuse(`--resolve-head takes keep-edit or discard, not ${value}.`);
        parsed.resolveHead = value;
      }
      continue;
    }
    if (arg.startsWith('-')) throw refuse(`Unknown option: ${arg}.`);
    if (parsed.slug) throw refuse('Name exactly one page slug.');
    parsed.slug = arg;
  }
  if (!parsed.slug) throw refuse('Name the page slug.');
  return parsed;
}

/** Bytes of a page file and where to read them again. */
interface FileSource { bytes: number; sha256: string; pieces(): AsyncIterable<Uint8Array> }

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The stored page's canonical file, as the write path renders it. */
async function renderedSource(engine: BrainEngine, snapshot: PageSnapshot): Promise<FileSource> {
  const content = await renderedPageFile(engine, snapshot);
  if (typeof content !== 'string') return { bytes: content.bytes, sha256: content.hash, pieces: () => content.pieces(engine) };
  const text = Buffer.from(content, 'utf8');
  return { bytes: text.length, sha256: sha256(text), pieces: async function* () { yield text; } };
}

function fileSha256(path: string): string {
  const bytes = FileBytes.open(path);
  try { return bytes.hash(); } finally { bytes.close(); }
}

export interface PartView { name: string; path: string; bytes: number; sha256: string; unchanged?: boolean }
export interface CurrentLayout {
  kind: 'missing' | 'single' | 'split' | 'unknown';
  /** Source-relative path of the canonical file (the head when split). */
  path: string | null;
  bytes?: number;
  parts?: PartView[];
  verdict?: { ok: boolean; code?: string; reason?: string; missing?: string[]; extra?: string[]; mismatched?: string[] };
  /** Entries of the parts directory beside the file, source-relative. */
  parts_dir?: string[];
  reason?: string;
}
export interface TargetLayout {
  layout: 'single' | 'split';
  file_bytes: number;
  file_sha256: string;
  head: { path: string; bytes: number } | null;
  parts: PartView[];
  writes: string[];
  removals: string[];
  changes: boolean;
}
export interface SplitStorageReport {
  slug: string;
  source_id: string;
  revision: string;
  mode: 'layout' | ResolveHeadMode;
  threshold_bytes: number;
  threshold_key: typeof SPLIT_MAX_FILE_BYTES_KEY;
  /** The stored page's canonical file as the write path renders it. */
  canonical: { bytes: number; sha256: string };
  current: CurrentLayout;
  /** Whether the file on disk (reassembled when split) is byte-identical to the render; null when it cannot be read whole. */
  matches_render: boolean | null;
  /** keep-edit: the page file that keeps the head's edit. */
  kept_edit?: { file_bytes: number; file_sha256: string; kept_lead_bytes: number; replaced_lead_bytes: number };
  target: TargetLayout | null;
  blocked: { code: string; message: string } | null;
  apply_command: string[] | null;
  applied?: { request_id: string | null; status: string | null; laid_out: boolean };
  docs: string;
}

interface Located { root: string; path: string }

const toRel = (root: string, abs: string) => relative(root, abs).split(sep).join('/');

function currentLayout(at: Located, layout: CanonicalLayout): CurrentLayout {
  const partsRel = toRel(at.root, partsDirFor(at.path));
  const base = { path: toRel(at.root, at.path), parts_dir: layout.partsDirEntries.map(name => `${partsRel}/${name}`) };
  if (layout.kind !== 'split') return { ...base, kind: layout.kind, ...(layout.kind === 'single' ? { bytes: layout.bytes } : {}) };
  const headDir = posix.dirname(base.path);
  const verdict = layout.verdict.ok ? { ok: true } : { ok: false, code: layout.verdict.code, reason: layout.verdict.reason,
    ...(layout.verdict.code === 'split_page_incomplete' ? { missing: layout.verdict.missing, extra: layout.verdict.extra, mismatched: layout.verdict.mismatched } : {}) };
  return { ...base, kind: 'split', bytes: layout.headBytes, verdict,
    parts: (layout.parsed?.manifest.parts ?? []).map(part => ({ name: part.path.slice(part.path.indexOf('/') + 1), path: posix.join(headDir, part.path), bytes: part.bytes, sha256: part.sha256 })) };
}

function matchesRender(at: Located, layout: CanonicalLayout, source: FileSource): boolean | null {
  if (layout.kind === 'missing') return false;
  if (layout.kind === 'single') return layout.bytes === source.bytes && fileSha256(at.path) === source.sha256;
  return layout.verdict.ok ? layout.verdict.sha256 === source.sha256 : null;
}

/** What publishing `source` at `at.path` lays out, against what is there now. The split plan's staged copy is removed before it returns. */
async function planTarget(source: FileSource, at: Located, threshold: number, layout: CanonicalLayout): Promise<TargetLayout> {
  const headRel = toRel(at.root, at.path);
  const partsRel = toRel(at.root, partsDirFor(at.path));
  const target = { file_bytes: source.bytes, file_sha256: source.sha256 };
  if (source.bytes <= threshold) {
    const same = layout.kind === 'single';
    const removals = layout.partsDirEntries.map(name => `${partsRel}/${name}`);
    return { layout: 'single', ...target, head: null, parts: [], writes: same ? [] : [headRel], removals, changes: !same || removals.length > 0 };
  }
  const plan = await planSplit(source.pieces(), { headPath: at.path });
  try {
    const head = plan.head();
    const listed = new Map(layout.kind === 'split' ? (layout.parsed?.manifest.parts ?? []).map(part => [part.path, part]) : []);
    const faulty = new Set(layout.kind === 'split' && !layout.verdict.ok && layout.verdict.code === 'split_page_incomplete'
      ? [...layout.verdict.missing, ...layout.verdict.mismatched] : []);
    const parts = plan.parts.map(part => {
      const prior = listed.get(part.path);
      return { name: part.name, path: posix.join(posix.dirname(headRel), part.path), bytes: part.bytes, sha256: part.sha256,
        unchanged: !!prior && prior.bytes === part.bytes && prior.sha256 === part.sha256 && !faulty.has(part.path) };
    });
    const wanted = new Set(plan.parts.map(part => part.name));
    const headSame = layout.kind === 'split' && readFileSync(at.path, 'utf8') === head;
    const writes = [...(headSame ? [] : [headRel]), ...parts.filter(part => !part.unchanged).map(part => part.path)];
    const removals = layout.partsDirEntries.filter(name => !wanted.has(name)).map(name => `${partsRel}/${name}`);
    return { layout: 'split', ...target, head: { path: headRel, bytes: Buffer.byteLength(head, 'utf8') }, parts, writes, removals, changes: writes.length + removals.length > 0 };
  } finally {
    plan.dispose();
  }
}

/** Why the files cannot be laid out as asked (preview reports it; apply refuses with it), or null. */
function layoutBlock(mode: SplitStorageReport['mode'], layout: CanonicalLayout, slug: string, sourceId: string): SplitStorageReport['blocked'] {
  const resolve = `gbrain pages split-storage ${slug} --source ${sourceId} --resolve-head keep-edit|discard`;
  if (mode !== 'layout') {
    if (layout.kind === 'split' && !layout.verdict.ok && layout.verdict.code === 'split_head_modified') return null;
    return { code: 'nothing_to_resolve', message: `The canonical file of ${slug} is not a split page head whose body was edited (split_head_modified), so there is no head edit to keep or discard.` };
  }
  if (layout.kind === 'missing') {
    return { code: 'canonical_file_missing', message: `The canonical file of ${slug} is missing on this host, so it cannot be republished in place. Restore the file and sync, or preview the ghost page removal with gbrain repair ghost-pages --source ${sourceId}.` };
  }
  if (layout.kind !== 'split' || layout.verdict.ok) return null;
  if (layout.verdict.code === 'split_head_modified') {
    return { code: 'split_head_modified', message: `The head of ${slug} was edited after it was written (${layout.verdict.reason}). Keep the edit or discard it first: ${resolve}` };
  }
  return { code: 'split_page_incomplete', message: `The split page ${slug} is incomplete on disk (${layout.verdict.reason}). Restore its part files from Git (git checkout -- <parts dir>) and run gbrain sync; nothing here rewrites a page whose parts are missing.` };
}

/** keep-edit: the page file that keeps the head's edit, staged privately; the caller removes it. */
function stageKeptEdit(at: Located, layout: CanonicalLayout): { path: string; kept: Extract<ReturnType<typeof writeKeptEdit>, { ok: true }> } {
  if (layout.kind !== 'split' || !layout.parsed) throw new Error('stageKeptEdit: not a parsed split head');
  const path = splitScratchPath();
  const kept = writeKeptEdit(at.path, layout.parsed, path);
  if (!kept.ok) throw opError('source_changed', `The parts of the split page changed while the head edit was being kept (${kept.reason}).`,
    'Nothing was written. Run the preview again.', { detail: 'split_page_incomplete' });
  return { path, kept };
}

export interface SplitStoragePreview { report: SplitStorageReport; at: Located | null; dispose(): void; publishSource: FileSource | null }

/** The read-only preview: the report, and what `--apply` publishes. Call `dispose` when done (it removes a staged keep-edit file). */
export async function previewSplitStorage(engine: BrainEngine, sourceId: string, slug: string, mode: SplitStorageReport['mode'] = 'layout'): Promise<SplitStoragePreview> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) throw opError('page_not_found', `Page not found: ${slug} in source ${sourceId}.`, `Check the slug and the source (gbrain pages status ${slug} --source ${sourceId}).`);
  const threshold = await splitThresholdBytes(engine);
  const rendered = await renderedSource(engine, snapshot);
  const report: SplitStorageReport = { slug, source_id: sourceId, revision: snapshot.revision, mode, threshold_bytes: threshold, threshold_key: SPLIT_MAX_FILE_BYTES_KEY,
    canonical: { bytes: rendered.bytes, sha256: rendered.sha256 }, current: { kind: 'unknown', path: null }, matches_render: null,
    target: null, blocked: null, apply_command: null, docs: DOCS };
  const context = await sourceContext(engine, sourceId);
  if (!context.ok) {
    report.current.reason = context.reason;
    report.blocked = { code: 'not_owner_host', message: `This host does not hold source ${sourceId}'s canonical checkout (${context.reason}), so the page's files were not read. Run this on the source's owner host (gbrain sources writer status --source ${sourceId}).` };
    return { report, at: null, publishSource: null, dispose() {} };
  }
  const at = { root: context.root, path: canonicalPath(context, { slug: snapshot.page.slug, source_path: snapshot.page.source_path ?? null, source_uri: snapshot.page.source_uri ?? null }) };
  const layout = readCanonicalLayout(at.path);
  report.current = currentLayout(at, layout);
  report.matches_render = matchesRender(at, layout, rendered);
  report.blocked = layoutBlock(mode, layout, slug, sourceId);
  if (report.blocked) return { report, at, publishSource: null, dispose() {} };
  let staged: string | null = null;
  const dispose = () => { if (staged) rmSync(staged, { force: true }); staged = null; };
  try {
    let publish = rendered;
    if (mode === 'keep-edit') {
      const kept = stageKeptEdit(at, layout);
      staged = kept.path;
      const stagedPath = kept.path;
      publish = { bytes: kept.kept.bytes, sha256: kept.kept.sha256, pieces: () => createReadStream(stagedPath) as AsyncIterable<Uint8Array> };
      report.kept_edit = { file_bytes: kept.kept.bytes, file_sha256: kept.kept.sha256, kept_lead_bytes: kept.kept.leadBytes,
        replaced_lead_bytes: layout.kind === 'split' ? layout.parsed!.manifest.lead_bytes : 0 };
    }
    report.target = await planTarget(publish, at, threshold, layout);
    if (mode !== 'layout') report.target.changes = true;
    if (report.target.changes) report.apply_command = ['gbrain', 'pages', 'split-storage', slug, '--source', sourceId, ...(mode === 'layout' ? [] : ['--resolve-head', mode]), '--apply'];
    return { report, at, publishSource: publish, dispose };
  } catch (error) {
    dispose();
    if (!(error instanceof SplitLayoutError)) throw error;
    report.blocked = { code: error.code, message: error.message };
    return { report, at, publishSource: null, dispose() {} };
  }
}

function applyRefusal(report: SplitStorageReport) {
  const blocked = report.blocked!;
  const preview = readFix('Previews the layout of the page\'s canonical file again; writes nothing.',
    { argv: ['gbrain', 'pages', 'split-storage', report.slug, '--source', report.source_id, '--json'] });
  if (blocked.code === 'not_owner_host') return opError('owner_unavailable', 'The canonical worktree is unavailable on this host.', blocked.message, { reason: report.current.reason, fix: preview, docs: DOCS });
  if (blocked.code === 'nothing_to_resolve' || blocked.code.startsWith('frontmatter_') || blocked.code === 'body_empty' || blocked.code === 'not_utf8' || blocked.code === 'too_many_parts' || blocked.code === 'not_a_page_file' || blocked.code === 'not_a_markdown_head') {
    return opError('invalid_params', blocked.message, 'Nothing was written. Run the preview for what the layout would be.', { detail: blocked.code, fix: preview, docs: DOCS });
  }
  return opError('source_changed', blocked.message, 'Nothing was written.', { detail: blocked.code, fix: preview, docs: DOCS });
}

/** A file read again as UTF-8 text from a byte offset (always a code-point boundary in an upload). */
function fileUploadBody(source: FileSource) {
  return { bytes: source.bytes, sha256: source.sha256, async *text(fromByte: number) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let skip = fromByte;
    for await (const piece of source.pieces()) {
      const rest = skip >= piece.length ? null : piece.subarray(skip);
      skip = Math.max(0, skip - piece.length);
      const text = rest ? decoder.decode(rest, { stream: true }) : '';
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } };
}

/** Publishes through the ordinary write door: keep-edit as a replacement of the page at its revision, otherwise the relayout intent of the live page. */
async function publish(engine: BrainEngine, report: SplitStorageReport, source: FileSource): Promise<Record<string, unknown>> {
  const config = loadConfig() ?? { engine: engine.kind };
  const { resolveCliWriteWaitMs } = await import('../core/persistence/write-wait.ts');
  const ctx = { engine, config, remote: false, dryRun: false, sourceId: report.source_id, writeWaitMs: resolveCliWriteWaitMs({ config }),
    logger: { info: () => {}, warn: (m: string) => console.error(m), error: (m: string) => console.error(m) } } as unknown as OperationContext;
  const { initializeLocalPersistence } = await import('../core/persistence/page-mutations.ts');
  await initializeLocalPersistence(ctx);
  const request_id = randomUUID();
  if (report.mode !== 'keep-edit') {
    const { maintenancePreflight, submitMaintenanceIntent } = await import('../core/persistence/prepared-maintenance.ts');
    const authority = await maintenancePreflight(engine, report.source_id);
    if (!authority) throw opError('owner_unavailable', 'Laying out a page file needs the managed write path.',
      `Managed persistence is off for this brain, so the file of ${report.slug} was not written. Check the source with gbrain sources status ${report.source_id} --json.`, { docs: DOCS });
    const { SPLIT_RELAYOUT_INTENT } = await import('../core/split-layout/relayout.ts');
    return submitMaintenanceIntent(engine, authority, report.slug, { kind: SPLIT_RELAYOUT_INTENT, expected_revision: report.revision, ...(report.mode === 'discard' ? { resolve_head: 'discard' } : {}) }, request_id);
  }
  const [{ operationsByName }, { uploadPageBody }] = await Promise.all([import('../core/operations.ts'), import('../core/mcp-client.ts')]);
  const call = async (tool: string, args: Record<string, unknown>) => await operationsByName[tool]!.handler(ctx, args) as Record<string, unknown>;
  return uploadPageBody(call, { slug: report.slug, source_id: report.source_id, mode: 'replace', expected_revision: report.revision, request_id }, fileUploadBody(source));
}

/** Whether the files at the canonical path are now in the planned layout. */
function laidOut(at: Located, target: TargetLayout): boolean {
  const after = readCanonicalLayout(at.path);
  if (target.layout === 'single') return after.kind === 'single' && after.partsDirEntries.length === 0 && after.bytes === target.file_bytes && fileSha256(at.path) === target.file_sha256;
  return after.kind === 'split' && after.verdict.ok && after.verdict.sha256 === target.file_sha256
    && after.parsed!.manifest.parts.map(part => part.path.slice(part.path.indexOf('/') + 1)).join('\n') === target.parts.map(part => part.name).join('\n');
}

const size = (bytes: number) => `${bytes} bytes`;

function printReport(report: SplitStorageReport): void {
  const c = report.current;
  console.log(`Page ${report.slug} in source ${report.source_id} (revision ${report.revision}); ${report.threshold_key} = ${report.threshold_bytes} bytes.`);
  console.log(`  Rendered canonical file: ${size(report.canonical.bytes)}.`);
  if (c.kind === 'unknown') console.log(`  On disk: unknown (${c.reason}).`);
  else if (c.kind === 'missing') console.log(`  On disk: ${c.path} is missing.`);
  else if (c.kind === 'single') console.log(`  On disk: one file, ${c.path} (${size(c.bytes!)}).`);
  else {
    console.log(`  On disk: split, head ${c.path} (${size(c.bytes!)}) and ${c.parts!.length} part file(s)${c.verdict!.ok ? '' : `; ${c.verdict!.code}: ${c.verdict!.reason}`}.`);
    for (const part of c.parts!) console.log(`    ${part.path} (${size(part.bytes)})`);
  }
  if (c.parts_dir?.length && c.kind !== 'split') console.log(`  Parts directory entries beside it: ${c.parts_dir.join(', ')}`);
  if (report.kept_edit) console.log(`  Keeping the head edit: ${report.kept_edit.kept_lead_bytes} edited lead bytes replace ${report.kept_edit.replaced_lead_bytes}; the page file becomes ${size(report.kept_edit.file_bytes)}.`);
  if (report.blocked) { console.log(`  Cannot apply (${report.blocked.code}): ${report.blocked.message}`); return; }
  const t = report.target!;
  if (!t.changes) { console.log('  Already in its layout; --apply has nothing to write.'); return; }
  const verb = report.applied ? 'Wrote' : 'Would write';
  if (t.layout === 'single') console.log(`  ${verb} one file: ${t.writes[0] ?? '(unchanged)'} (${size(t.file_bytes)}).`);
  else {
    console.log(`  ${verb} a split page: head ${t.head!.path} (${size(t.head!.bytes)})${t.writes.includes(t.head!.path) ? '' : ' (unchanged)'} and ${t.parts.length} part file(s):`);
    for (const part of t.parts) console.log(`    ${part.path} (${size(part.bytes)})${part.unchanged ? ' unchanged' : ''}`);
  }
  for (const path of t.removals) console.log(`  ${report.applied ? 'Removed' : 'Would remove'}: ${path}`);
  if (!report.applied) console.log(`  Nothing was written. Apply: ${report.apply_command!.join(' ')}`);
}

export async function runPagesSplitStorage(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseSplitStorageArgs(args);
  const sourceId = await resolveSourceId(engine, parsed.source);
  const preview = await previewSplitStorage(engine, sourceId, parsed.slug, parsed.resolveHead ?? 'layout');
  try {
    const { report } = preview;
    if (parsed.apply && report.blocked) throw applyRefusal(report);
    if (parsed.apply && report.target?.changes) {
      let receipt: Record<string, unknown>;
      try {
        receipt = await publish(engine, report, preview.publishSource!);
      } catch (error) {
        const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
        if (await reportPersistenceCliError(error, parsed.json)) return;
        throw error;
      }
      // keep-edit is a page write, whose file the write path renders (frontmatter keys and stamps as it writes them), so
      // it is laid out when the files are in the planned layout and a head's parts verify, not byte for byte the planned F.
      const placed = report.mode !== 'keep-edit' ? laidOut(preview.at!, report.target) : (() => {
        const after = readCanonicalLayout(preview.at!.path);
        return after.kind === report.target!.layout && (after.kind !== 'split' || after.verdict.ok);
      })();
      report.applied = { request_id: typeof receipt.request_id === 'string' ? receipt.request_id : null, status: typeof receipt.status === 'string' ? receipt.status : null, laid_out: placed };
      if (!placed) setCliExitVerdict(1);
    }
    if (parsed.json) { console.log(JSON.stringify(report, null, 2)); return; }
    printReport(report);
    if (report.applied && !report.applied.laid_out) {
      console.error(`The write committed (request ${report.applied.request_id ?? 'unknown'}), but the files at ${report.current.path} are not in the planned layout: the write path on this host did not lay them out. Check gbrain sources status ${sourceId}.`);
    }
  } finally {
    preview.dispose();
  }
}

