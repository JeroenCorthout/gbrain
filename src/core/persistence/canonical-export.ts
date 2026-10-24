/**
 * Database-canonical memory, wave 1 (docs/designs/DATABASE_CANONICAL_MEMORY.md): the read-only pieces every later wave
 * builds on. The brain gate, the one predicate that decides which pages may ever reach a tracked file, and the equality
 * contract between a page's file and its export view (readExportPage, so fact withdrawals are overlaid). Nothing here
 * writes; `gbrain sources canonical <id> --dry-run` (commands/sources-canonical.ts) is its only caller so far.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitStream, NulRecordSplitter } from '../hardened-git.ts';
import { exportBodyLedger, segmentedExportHead, segmentedExportMarkdown, type ExportSnapshot, type ExportWithdrawal } from '../export-snapshot.ts';
import { parseMarkdown } from '../markdown.ts';
import { isDerivationPrivate, isPrivatePage } from '../search/private-visibility.ts';
import { alignWithStored } from './align-stored.ts';
import { digest } from './digest.ts';
import { classifyDrift } from './reconcile-additive.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { reconcileFileReading } from './reconcile-state.ts';

/** The brain gate: off unless set to true/1/on/yes. Every database-canonical surface refuses while it is off. */
export const DATABASE_CANONICAL_KEY = 'persistence.database_canonical.enabled';

export async function databaseCanonicalEnabled(engine: BrainEngine): Promise<boolean> {
  return ['true', '1', 'on', 'yes'].includes((await engine.getConfig(DATABASE_CANONICAL_KEY))?.trim().toLowerCase() ?? '');
}

export type ExportIneligibility = 'mirror_source' | 'private' | 'alias_private' | 'lineage_private' | 'database_only' | 'db_only_prefix' | 'git_ignored';

/**
 * What decides eligibility beyond the page itself: whether the source is read-only (sourceMirrorReadOnly), whether a slug
 * sits under a declared `storage.db_only` dir (isSourceDbOnlySlug, which refuses an invalid gbrain.yml) and the paths the
 * checkout's Git ignores.
 */
export interface ExportPolicy { mirror: boolean; dbOnly: (slug: string) => boolean; ignored: ReadonlySet<string> }

/**
 * Why a page may not reach a tracked file, or null when it may. A read-only mirror is never exported (#5409), private
 * and alias-private pages never reach a remote, a page the database keeps on purpose (`database_only_reason`: detached,
 * mirror, never committed) or under a `storage.db_only` prefix stays there, and a path the checkout's Git ignores stays
 * database-only (it could never be committed). `lineage_private` is what privatePagesFilterFragment adds over the row's
 * own fields (an explicitly private `derived_from` input, a private derivation origin); the caller computes it in SQL.
 * Callers load `visibility.honor_aliases` (readHonorAliases) first.
 */
export function exportIneligibility(page: { slug: string; type?: string | null; frontmatter?: unknown; database_only_reason?: string | null;
  lineage_private?: boolean }, relativePath: string | null, policy: ExportPolicy): ExportIneligibility | null {
  if (policy.mirror) return 'mirror_source';
  if (isPrivatePage(page)) return 'private';
  if (isDerivationPrivate(page)) return 'alias_private';
  if (page.lineage_private) return 'lineage_private';
  if (page.database_only_reason) return 'database_only';
  if (policy.dbOnly(page.slug)) return 'db_only_prefix';
  if (relativePath !== null && policy.ignored.has(relativePath)) return 'git_ignored';
  return null;
}

/**
 * The paths among `relativePaths` (relative to `root`) that the checkout's ignore rules exclude, read with filter-free
 * `git check-ignore --stdin -z`; tracked files are never reported (Git commits them whatever the rules say). Exit 1
 * means none matched. Null when Git could not answer, so a caller never reads a failed check as "nothing ignored".
 */
export async function ignoredPaths(root: string, relativePaths: string[]): Promise<Set<string> | null> {
  const ignored = new Set<string>();
  if (!relativePaths.length) return ignored;
  const splitter = new NulRecordSplitter();
  const result = await hardenedGitStream(root, ['check-ignore', '-z', '--stdin'], {
    stdin: relativePaths.map(path => path + '\0'), timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024,
    onChunk: chunk => { for (const record of splitter.push(chunk)) ignored.add(record.toString('utf8')); } });
  if (result.ok) return result.endsWithNul || result.bytes === 0 ? ignored : null;
  return result.reason === 'exit' && result.status === 1 && ignored.size === 0 ? ignored : null;
}

export type ExportFileComparison = { state: 'equal' } | { state: 'differs'; paths: string[] } | { state: 'unparseable' };

/**
 * The equality contract for an inline page: the file, parsed the way reconcile parses a canonical file (aligned with the
 * stored type, subtype and the #6429 grandfather stamp), carries the same canonical fields as the page's export view.
 * `importPath` is the file's path as sync keys it (scannerSourcePath).
 */
export function compareInlineExportFile(raw: Buffer, importPath: string, snapshot: ExportSnapshot): ExportFileComparison {
  const { page, tags } = snapshot;
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) return { state: 'unparseable' };
  const reading = reconcileFileReading(text, importPath, page);
  const parsed = parseMarkdown(reading.content, `${page.slug}.md`, { validate: true, expectedSlug: page.slug });
  if (parsed.errors?.some(e => !['MISSING_OPEN', 'EMPTY_FRONTMATTER'].includes(e.code))) return { state: 'unparseable' };
  if (parsed.slug !== page.slug) return { state: 'differs', paths: ['/slug'] };
  alignWithStored(parsed, page, reading.inferred);
  const file = reconcileCanonical(parsed, parsed.tags), database = reconcileCanonical(page, tags);
  if (digest(file) === digest(database)) return { state: 'equal' };
  return { state: 'differs', paths: classifyDrift(file, database).paths.map(p => p.path) };
}

/** A segmented page's body cannot be read whole (page-body/page-shape.ts), so its file compares by the streamed SHA-256 of its export. */
export async function compareSegmentedExportFile(tx: BrainEngine, filePath: string, snapshot: ExportSnapshot, withdrawals: ExportWithdrawal[]): Promise<ExportFileComparison> {
  const exported = createHash('sha256');
  for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(snapshot.page.slug, withdrawals), segmentedExportHead(snapshot))) exported.update(piece);
  const file = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) file.update(chunk as Buffer);
  return exported.digest('hex') === file.digest('hex') ? { state: 'equal' } : { state: 'differs', paths: ['/body'] };
}
