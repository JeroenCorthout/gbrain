/**
 * Wave B PR 5 (split git layout, spec §9 option B) doctor checks, both warn at most, never red:
 *
 * - `split_layout`: stray parts directories in a source checkout on this host (a `.<name>.gbparts` directory whose
 *   head `<name>.md` is missing or is not a split page head, or whose head's manifest names another directory) and
 *   held split pages (sync holds with code `split_page_incomplete` or `split_head_modified` in each source's current
 *   incarnation), with counts, a sample and the fix: `gbrain pages split-storage <slug> --source <id>` for a held page
 *   (preview first; `--resolve-head keep-edit|discard` for an edited head), restoring the parts from Git for an
 *   incomplete one, and removing a stray directory (the user's call) for the rest.
 * - `oversize_canonical_file`: a single canonical `.md` larger than `sync.max_file_bytes`, which the split layout would
 *   store as a head plus parts; fix: `gbrain pages split-storage <slug> --source <id>` (preview, then `--apply`).
 *
 * Cheap and bounded: one walk per source checkout on its owner host (`sourceContext`, as ghost_pages), at most
 * `SPLIT_WALK_ENTRY_LIMIT` directory entries in total and stopping at the entry deadline; dot directories, `.git` and
 * `node_modules` are not descended (sync never imports from them); only a `.md` over the threshold has its head read,
 * and only a parts directory's head is parsed (no part is read). The held rows are two indexed reads. A remote caller
 * (run_doctor) gets counts without paths or slugs.
 */
import type { Dirent } from 'node:fs';
import { readdirSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Action } from '../../../core/agent-output.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { sourceContext } from '../../../core/ghost-pages.ts';
import { GIT_HOLD_OP } from '../../../core/persistence/sync-holds.ts';
import { headPathForPartsDir, isPartsDirName } from '../../../core/split-layout/paths.ts';
import { splitThresholdBytes, SPLIT_MAX_FILE_BYTES_KEY } from '../../../core/split-layout/limits.ts';
import { readHead } from '../../../core/split-layout/disk-layout.ts';

const DOCS = 'docs/guides/memory-boundaries.md#large-pages-in-git';
/** Directory entries one doctor run reads across every source checkout. */
export const SPLIT_WALK_ENTRY_LIMIT = 100_000;
let walkLimit = SPLIT_WALK_ENTRY_LIMIT;
/** Tests only: a smaller walk bound (null restores the default). */
export function __setSplitWalkLimitForTests(limit: number | null): void { walkLimit = limit ?? SPLIT_WALK_ENTRY_LIMIT; }
const SAMPLE = 5;
export const SPLIT_HOLD_CODES = ['split_page_incomplete', 'split_head_modified'] as const;

export interface StrayPartsDir { source_id: string; path: string; reason: 'no_head' | 'head_not_split' | 'not_in_manifest' }
export interface OversizeFile { source_id: string; path: string; bytes: number; slug: string }
export interface HeldSplitPage { source_id: string; path: string; slug: string | null; code: string }
interface Walk { stray: StrayPartsDir[]; oversize: OversizeFile[]; sources: string[]; entries: number; truncated: boolean }

function strayReason(root: string, rel: string): StrayPartsDir['reason'] | null {
  const head = readHead(join(root, headPathForPartsDir(rel)!));
  if (head.kind === 'missing') return 'no_head';
  if (head.kind === 'single') return 'head_not_split';
  if (head.kind === 'invalid_head') return null;
  const dir = head.parsed.manifest.parts[0]!.path.split('/')[0];
  return dir === basename(rel) ? null : 'not_in_manifest';
}

/** One source checkout: stray parts directories and oversize single files, within the shared entry budget. */
function walkSource(walk: Walk, sourceId: string, root: string, threshold: number, deadline: number | undefined): Array<{ path: string; bytes: number }> {
  const big: Array<{ path: string; bytes: number }> = [];
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop()!;
    let entries: Dirent[];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) as unknown as Dirent[]; } catch { continue; }
    for (const entry of entries) {
      if (walk.entries >= walkLimit || (deadline !== undefined && Date.now() >= deadline)) { walk.truncated = true; return big; }
      walk.entries++;
      const child = rel ? posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (isPartsDirName(entry.name)) {
          const reason = strayReason(root, child);
          if (reason) walk.stray.push({ source_id: sourceId, path: child, reason });
        } else if (!entry.name.startsWith('.') && entry.name !== 'node_modules') pending.push(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const head = readHead(join(root, child));
      if (head.kind === 'single' && head.bytes > threshold) big.push({ path: child, bytes: head.bytes });
    }
  }
  return big;
}

async function walkSources(engine: BrainEngine, sourceIds: string[], threshold: number, deadline: number | undefined): Promise<Walk> {
  const walk: Walk = { stray: [], oversize: [], sources: [], entries: 0, truncated: false };
  for (const sourceId of sourceIds) {
    if (walk.truncated) break;
    const context = await sourceContext(engine, sourceId);
    if (!context.ok) continue;
    walk.sources.push(sourceId);
    const big = walkSource(walk, sourceId, context.root, threshold, deadline);
    if (!big.length) continue;
    const rows = await engine.executeRaw<{ slug: string; source_path: string }>(
      'SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path = ANY($2::text[])', [sourceId, big.map(file => file.path)]);
    const slugs = new Map(rows.map(row => [row.source_path, row.slug]));
    for (const file of big) walk.oversize.push({ source_id: sourceId, ...file, slug: slugs.get(file.path) ?? file.path.slice(0, -'.md'.length) });
  }
  return walk;
}

/** Held split pages of each source's current incarnation: the count and the first rows in path order. */
async function readHeldSplitPages(engine: BrainEngine, sourceIds: string[]): Promise<{ count: number; sample: HeldSplitPage[] }> {
  const from = `FROM op_checkpoints h JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND h.completed_keys->0->>'code' = ANY($2::text[]) AND s.id = ANY($3::text[])`;
  const params = [GIT_HOLD_OP, [...SPLIT_HOLD_CODES], sourceIds];
  const [counted] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n ${from}`, params);
  const sample = await engine.executeRaw<HeldSplitPage>(`SELECT s.id AS source_id, h.completed_keys->0->>'path' AS path, h.completed_keys->0->>'slug' AS slug,
    h.completed_keys->0->>'code' AS code ${from} ORDER BY s.id, h.fingerprint LIMIT ${SAMPLE}`, params);
  return { count: Number(counted?.n ?? 0), sample };
}

function heldFix(first: HeldSplitPage) {
  const slug = first.slug ?? first.path.replace(/\.md$/, '');
  return first.code === 'split_head_modified'
    ? agentFix(['gbrain', 'pages', 'split-storage', slug, '--source', first.source_id, '--resolve-head', 'keep-edit', '--json'],
      'Read-only preview of keeping the edit made to the split page head (keep-edit), or run it with discard; apply only after the user chooses which.', 'split_layout', { docs: DOCS })
    : agentFix(['gbrain', 'sources', 'status', first.source_id, '--json'],
      'Read-only: lists the held split page with its missing, extra or mismatched part files; restore them from Git (git checkout -- <parts dir>) and sync.', 'split_layout', { docs: DOCS });
}

async function runSplitLayout(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const sourceIds = doctorSourceIds(ctx) ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const threshold = await splitThresholdBytes(engine);
    const [walk, held] = [await walkSources(engine, sourceIds, threshold, ctx.entryDeadlineAt), await readHeldSplitPages(engine, sourceIds)];
    const shown = <T>(rows: T[]) => (ctx.remote ? [] : rows.slice(0, SAMPLE));
    const bound = walk.truncated ? { truncated: true, limit: walkLimit, exact: false } : { truncated: false, exact: true };
    const layoutDetails = { stray_parts_dirs: walk.stray.length, held_split_pages: held.count, stray_sample: shown(walk.stray), held_sample: shown(held.sample),
      sources_walked: walk.sources, entries_read: walk.entries, ...bound, docs: DOCS };
    if (!walk.sources.length && !held.count) {
      checks.push(infoCheck('split_layout', 'Not applicable: no source has a canonical checkout on this host and no split page is held.', 'not_applicable', undefined, layoutDetails));
    } else if (walk.stray.length || held.count) {
      const parts = [
        ...(held.count ? [`${held.count} split page(s) held by sync (${SPLIT_HOLD_CODES.join(' / ')})${ctx.remote ? '' : `, e.g. ${held.sample.map(row => `${row.source_id}:${row.path} (${row.code})`).join(', ')}`}`] : []),
        ...(walk.stray.length ? [`${walk.stray.length}${walk.truncated ? '+' : ''} stray parts director${walk.stray.length === 1 ? 'y' : 'ies'} with no split head naming them${ctx.remote ? '' : `, e.g. ${walk.stray.slice(0, SAMPLE).map(row => `${row.source_id}:${row.path} (${row.reason})`).join(', ')}`}`] : []),
      ];
      const fix: Action = held.count ? heldFix(held.sample[0]!)
        : { consent: [], actor: 'agent', ask_user: true, requires_exclusive: false, docs: DOCS,
          why: 'A parts directory no head names holds bytes no page reads; whether to remove it (git rm -r <dir>, then commit) or restore its head from Git is the user\'s call.',
          user_message: `${walk.stray.length} hidden part-file director${walk.stray.length === 1 ? 'y has' : 'ies have'} no page head that names ${walk.stray.length === 1 ? 'it' : 'them'}. Remove ${walk.stray.length === 1 ? 'it' : 'them'}, or restore the head from Git?` };
      checks.push({ name: 'split_layout', status: 'warn', details: layoutDetails, fix,
        message: `${parts.join('; ')}. A held page keeps its last imported content until it is resolved: preview with gbrain pages split-storage <slug> --source <id> (--resolve-head keep-edit|discard for an edited head), or restore missing part files from Git and sync.` });
    } else {
      checks.push({ name: 'split_layout', status: 'ok', details: layoutDetails,
        message: `No stray parts directory and no held split page (${walk.entries} entries read in ${walk.sources.length} checkout(s)${walk.truncated ? `; the walk stopped at its bound of ${walkLimit} entries` : ''}).` });
    }
    const oversizeDetails = { count: walk.oversize.length, threshold_bytes: threshold, threshold_key: SPLIT_MAX_FILE_BYTES_KEY, sample: shown(walk.oversize), ...bound, docs: DOCS };
    if (!walk.sources.length) {
      checks.push(infoCheck('oversize_canonical_file', 'Not applicable: no source has a canonical checkout on this host.', 'not_applicable', undefined, oversizeDetails));
    } else if (walk.oversize.length) {
      const first = walk.oversize[0]!;
      checks.push({ name: 'oversize_canonical_file', status: 'warn', details: oversizeDetails,
        message: `${walk.oversize.length}${walk.truncated ? '+' : ''} canonical file(s) are single files over ${SPLIT_MAX_FILE_BYTES_KEY} (${threshold} bytes)${ctx.remote ? '' : `, e.g. ${walk.oversize.slice(0, SAMPLE).map(row => `${row.source_id}:${row.path} (${row.bytes} bytes)`).join(', ')}`}. `
          + 'The split git layout stores such a page as a head file plus hidden part files; preview the change with gbrain pages split-storage <slug> --source <id>, then --apply.',
        fix: agentFix(['gbrain', 'pages', 'split-storage', first.slug, '--source', first.source_id, '--json'],
          'Read-only preview: the head and part files the split layout would write for this page; nothing is written until --apply.', 'oversize_canonical_file', { docs: DOCS }) });
    } else {
      checks.push({ name: 'oversize_canonical_file', status: 'ok', details: oversizeDetails,
        message: `No single canonical file is over ${SPLIT_MAX_FILE_BYTES_KEY} (${threshold} bytes)${walk.truncated ? ` among the ${walk.entries} entries read (the walk stopped at its bound)` : ''}.` });
    }
  } catch (error) {
    checks.push(checkError('split_layout', 'check split page layouts in the source checkouts', error, { status: 'warn', details: { docs: DOCS } }));
  }
  return checks;
}

export const splitLayoutEntry: DoctorEntry = { name: 'split_layout', emits: ['split_layout', 'oversize_canonical_file'], run: runSplitLayout };
