/**
 * `gbrain sources canonical <source-id> --dry-run` (database-canonical memory, wave 1): a read-only census of what the
 * database-canonical mode would export for one source. For every live page it applies the export eligibility predicate
 * and, for an eligible page whose source has a checkout, compares the page's file with its export view under the
 * equality contract (persistence/canonical-export.ts). Nothing is written: each batch reads in its own read-only
 * transaction, so a census of a large source holds no long snapshot. Refuses while the brain gate is off. Trusted local
 * CLI only, not an MCP operation; it prints slugs and paths.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { readExportPage, readExportWithdrawals } from '../core/export-snapshot.ts';
import { RestoreTargetError, restoreFilePath } from '../core/restore-target.ts';
import { readHonorAliases } from '../core/search/private-visibility.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { loadStorageConfig } from '../core/storage-config.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../core/write-through.ts';
import { compareInlineExportFile, compareSegmentedExportFile, DATABASE_CANONICAL_KEY, databaseCanonicalEnabled, exportIneligibility, ignoredPaths,
  type ExportIneligibility } from '../core/persistence/canonical-export.ts';

const USAGE = 'Usage: gbrain sources canonical <source-id> --dry-run [--sample <n>] [--json]';
const DOCS = 'docs/designs/DATABASE_CANONICAL_MEMORY.md';
const BATCH = 256;

type FileState = 'equal' | 'differs' | 'missing' | 'unparseable' | 'unsafe_path';

export interface CanonicalCensus {
  status: 'census';
  source_id: string;
  checkout: string | null;
  pages: number;
  eligible: number;
  ineligible: Record<ExportIneligibility, number>;
  /** Files of eligible pages by comparison with their export view; null when the source has no checkout. */
  files: Record<FileState, number> | null;
  /** `failed`: Git could not say which paths are ignored, so none were counted as `git_ignored`. */
  ignore_check: 'ok' | 'failed' | 'no_checkout';
  sample: Array<{ slug: string; path: string; state: FileState; fields?: string[] }>;
  next: string;
}

export function parseCanonicalArgs(args: string[]): { sourceId: string; json: boolean; sample: number } {
  const positional: string[] = [];
  let sample = 20;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--sample') {
      const raw = args[++i];
      sample = Number(raw);
      if (raw === undefined || !Number.isInteger(sample) || sample < 0 || sample > 1000) {
        throw new OperationError('invalid_params', `--sample needs a whole number from 0 to 1000; got ${raw ?? 'nothing'}.`, USAGE);
      }
      continue;
    }
    if (arg.startsWith('-')) {
      if (!['--dry-run', '--json'].includes(arg)) throw new OperationError('invalid_params', `Unknown sources canonical flag: ${arg}.`, USAGE);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources canonical needs exactly one source id.', USAGE);
  if (!args.includes('--dry-run')) {
    throw new OperationError('invalid_params', 'sources canonical only previews in this release; pass --dry-run.',
      `Run gbrain sources canonical ${positional[0]} --dry-run for the read-only census. Changing a source's mode arrives in a later release (${DOCS}).`);
  }
  return { sourceId: positional[0]!, json: args.includes('--json'), sample };
}

export async function censusSource(engine: BrainEngine, sourceId: string, sampleLimit: number): Promise<CanonicalCensus> {
  if (!await databaseCanonicalEnabled(engine)) {
    throw new OperationError('database_canonical_disabled', 'Database-canonical mode is off for this brain, so there is nothing to preview.',
      `Nothing changed. Turn the gate on with gbrain config set ${DATABASE_CANONICAL_KEY} true (by itself it changes no behavior), then rerun gbrain sources canonical ${sourceId} --dry-run.`, DOCS);
  }
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const [source] = await engine.executeRaw<{ local_path: string | null; mirror: boolean }>(
    `SELECT local_path, COALESCE(config->>'mirror_read_only','false')='true' AS mirror FROM sources WHERE id=$1`, [sourceId]);
  const root = source?.local_path && existsSync(source.local_path) ? source.local_path : null;
  await readHonorAliases(engine);
  const mode = root ? await scannerSlugRootMode(engine, sourceId, root) : null;
  const target = (key: { slug: string; source_path: string | null; source_path_bytes: number }): string | null => {
    try { return restoreFilePath(root!, key.slug, key.source_path, Number(key.source_path_bytes), mode!); }
    catch (error) { if (error instanceof RestoreTargetError) return null; throw error; }
  };
  const posix = (path: string) => relative(root!, path).split(sep).join('/');

  type Key = { id: string; slug: string; source_id: string; source_path: string | null; source_path_bytes: number; database_only_reason: string | null; segmented: boolean };
  const scan = async (visit: (tx: BrainEngine, batch: Key[]) => Promise<void>) => {
    for (let cursor = '0'; ;) {
      const done = await engine.transaction(async tx => {
        await tx.executeRaw('SET TRANSACTION READ ONLY');
        const batch = await tx.executeRaw<Key>(`SELECT id::text, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes,
            database_only_reason, body_storage='segmented' AS segmented
          FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id > $2::bigint ORDER BY id LIMIT ${BATCH}`, [sourceId, cursor]);
        if (batch.length) { await visit(tx, batch); cursor = batch[batch.length - 1]!.id; }
        return batch.length < BATCH;
      });
      if (done) return;
    }
  };

  let ignored: Set<string> | null = new Set();
  if (root) {
    const paths: string[] = [];
    await scan(async (_tx, batch) => { for (const key of batch) { const path = target(key); if (path) paths.push(posix(path)); } });
    ignored = await ignoredPaths(root, paths);
  }
  const policy = { mirror: source?.mirror === true, storage: root ? loadStorageConfig(root) : null, ignored: ignored ?? new Set<string>() };
  const ineligible: Record<ExportIneligibility, number> = { mirror_source: 0, private: 0, alias_private: 0, database_only: 0, db_only_prefix: 0, git_ignored: 0 };
  const files: Record<FileState, number> = { equal: 0, differs: 0, missing: 0, unparseable: 0, unsafe_path: 0 };
  const sample: CanonicalCensus['sample'] = [];
  let pages = 0, eligible = 0;
  await scan(async (tx, batch) => {
    const withdrawals = await readExportWithdrawals(tx, sourceId);
    for (const key of batch) {
      pages++;
      const snapshot = await readExportPage(tx, key, withdrawals);
      const path = root ? target(key) : null;
      const reason = exportIneligibility({ ...snapshot.page, database_only_reason: key.database_only_reason }, path ? posix(path) : null, policy);
      if (reason) { ineligible[reason]++; continue; }
      eligible++;
      if (!root) continue;
      let state: FileState, fields: string[] | undefined;
      if (!path) state = 'unsafe_path';
      else if (!existsSync(path)) state = 'missing';
      else {
        const compared = key.segmented ? await compareSegmentedExportFile(tx, path, snapshot, withdrawals)
          : compareInlineExportFile(readFileSync(path), scannerSourcePath(root, path, mode!), snapshot);
        state = compared.state;
        if (compared.state === 'differs') fields = compared.paths;
      }
      files[state]++;
      if (state !== 'equal' && state !== 'missing' && sample.length < sampleLimit) {
        sample.push({ slug: key.slug, path: path ? posix(path) : key.source_path ?? '', state, ...(fields ? { fields } : {}) });
      }
    }
  });
  return { status: 'census', source_id: sourceId, checkout: root, pages, eligible, ineligible, files: root ? files : null,
    ignore_check: root ? (ignored ? 'ok' : 'failed') : 'no_checkout', sample,
    next: `Nothing changed. This release ships the census only; switching a source to database-canonical arrives in a later release (${DOCS}).` };
}

function describe(census: CanonicalCensus): string {
  const counts = (record: Record<string, number>) => Object.entries(record).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const lines = [`Census of source ${census.source_id} (read-only): ${census.pages} live page(s), ${census.eligible} eligible for export.`,
    `Ineligible: ${counts(census.ineligible)}.`];
  if (census.files) lines.push(`Files of eligible pages, compared with their export view: ${counts(census.files)}.`);
  else lines.push('The source has no checkout, so no file was compared.');
  if (census.ignore_check === 'failed') lines.push('Git could not say which paths it ignores, so no page was counted as git_ignored.');
  for (const item of census.sample) lines.push(`  ${item.state}: ${item.slug} (${item.path})${item.fields ? ` fields ${item.fields.join(', ')}` : ''}`);
  lines.push(census.next);
  return lines.join('\n');
}

export async function runSourcesCanonical(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const parsed = parseCanonicalArgs(args);
    const census = await censusSource(engine, parsed.sourceId, parsed.sample);
    console.log(json ? JSON.stringify(census) : describe(census));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Census refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(1);
  }
}
