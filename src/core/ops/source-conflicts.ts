/**
 * Database-canonical memory, wave 5b: open import conflicts as a read surface (docs/designs/database-canonical-w5-contract.md,
 * "MCP read op list_source_conflicts" and "gbrain sources conflicts"). `listSourceConflicts` is the one reader both the MCP op
 * and the CLI use: the caller's source grant bounds it, the slug fences apply to the conflict's page slug (or the slug its
 * path maps to), and a remote caller sees a conflict only when its page is visible to it and gets summaries only, never the
 * stored bytes, the pinned ref, merge field names or detail beyond its screen code.
 */
import type { BrainEngine } from '../engine.ts';
import type { Operation, OperationContext } from './contract.ts';
import { opError } from './contract.ts';
import { readFix } from './op-fix.ts';
import { slugOutsideCallerFence, sourceScopeOpts } from './context.ts';
import { pathToSlug } from '../sync.ts';
import { privatePagesFilterFragment, readHonorAliases } from '../search/private-visibility.ts';

export interface SourceConflictSummary {
  id: number; source_id: string; slug: string | null; path: string; kind: string; state: string; mode: string;
  first_observed_at: string; observed_at: string; age_seconds: number; base_revision: string | null; db_revision: string | null;
  page_id: number | null; lifetime: number | null; screen_code: string | null;
}
export interface SourceConflictDetail extends SourceConflictSummary {
  file_sha256: string | null; file_size: number | null; commit_sha: string | null; file_ref: string | null; merge: unknown; detail: Record<string, unknown>; bytes_base64?: string | null;
}

export interface ListConflictsOptions {
  /** Source scope from the caller's grant: one source, a list, or every source (trusted local only). */
  scope: { sourceId?: string; sourceIds?: string[] };
  sourceId?: string; kind?: string; conflictId?: number; limit?: number;
  remote: boolean;
  /** True when the caller may not read the slug (fences). */
  fenced?: (slug: string) => boolean;
  includeBytes?: boolean;
}

const notFound = (id: number | string) => opError('import_conflict_not_found', `No open import conflict ${id} is visible to this caller.`,
  'List the conflicts again and use an id from that list.', { fix: readFix('Lists the open import conflicts this caller can see, read-only.', { argv: ['gbrain', 'sources', 'list'] }) });

/** The visible conflicts, newest observation last; throws `import_conflict_not_found` for a named id that is not visible. */
export async function listSourceConflicts(engine: BrainEngine, opts: ListConflictsOptions): Promise<SourceConflictDetail[]> {
  const scoped = opts.scope.sourceIds ?? (opts.scope.sourceId ? [opts.scope.sourceId] : null);
  if (opts.sourceId && scoped && !scoped.includes(opts.sourceId)) {
    if (opts.conflictId !== undefined) throw notFound(opts.conflictId);
    return [];
  }
  const sources = opts.sourceId ? [opts.sourceId] : scoped;
  if (opts.remote) await readHonorAliases(engine);
  const rows = await engine.executeRaw<SourceConflictDetail & { page_visible: boolean | null; bytes: Buffer | null }>(
    `SELECT c.id, c.source_id, p.slug, c.path, c.kind, c.state, c.mode, c.first_observed_at::text AS first_observed_at, c.observed_at::text AS observed_at,
       EXTRACT(EPOCH FROM now() - c.first_observed_at)::int AS age_seconds, c.base_revision::text, c.db_revision::text, c.page_id,
       (SELECT l.lifetime FROM export_ledger l WHERE l.source_id=c.source_id AND l.page_id=c.page_id ORDER BY l.lifetime DESC LIMIT 1) AS lifetime,
       c.detail->>'code' AS screen_code, c.file_sha256, c.file_size, c.commit_sha, c.file_ref, c.merge, c.detail,
       CASE WHEN $5::boolean THEN c.file_bytes END AS bytes,
       CASE WHEN p.id IS NULL THEN NULL ELSE ${privatePagesFilterFragment('p')} END AS page_visible
     FROM import_conflicts c LEFT JOIN pages p ON p.id=c.page_id
     WHERE c.state='open' AND c.outcome='conflict' AND ($1::text[] IS NULL OR c.source_id = ANY($1::text[])) AND ($2::text IS NULL OR c.kind=$2)
       AND ($3::bigint IS NULL OR c.id=$3) ORDER BY c.first_observed_at, c.id LIMIT $4`,
    [sources, opts.kind ?? null, opts.conflictId ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200), !!opts.includeBytes && !opts.remote]);
  const out: SourceConflictDetail[] = [];
  for (const row of rows) {
    const slug = row.slug ?? (() => { try { return pathToSlug(row.path); } catch { return null; } })();
    if (slug && opts.fenced?.(slug)) continue;
    if (opts.remote) {
      if (row.page_id !== null && row.page_visible === false) continue;
      if (row.page_id === null && slug) {
        const [held] = await engine.executeRaw<{ visible: boolean }>(`SELECT ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [row.source_id, slug]);
        if (held && !held.visible) continue;
      }
    }
    const summary: SourceConflictSummary = { id: Number(row.id), source_id: row.source_id, slug, path: row.path, kind: row.kind, state: row.state, mode: row.mode,
      first_observed_at: row.first_observed_at, observed_at: row.observed_at, age_seconds: Number(row.age_seconds), base_revision: row.base_revision, db_revision: row.db_revision,
      page_id: row.page_id === null ? null : Number(row.page_id), lifetime: row.lifetime === null ? null : Number(row.lifetime), screen_code: row.screen_code ?? null };
    if (opts.remote) { out.push(summary as SourceConflictDetail); continue; }
    out.push({ ...summary, file_sha256: row.file_sha256, file_size: row.file_size === null ? null : Number(row.file_size), commit_sha: row.commit_sha, file_ref: row.file_ref,
      merge: row.merge, detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail ?? {},
      ...(opts.includeBytes ? { bytes_base64: row.bytes ? Buffer.from(row.bytes).toString('base64') : null } : {}) });
  }
  if (opts.conflictId !== undefined && !out.length) throw notFound(opts.conflictId);
  return out;
}

const list_source_conflicts: Operation = {
  name: 'list_source_conflicts',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'List open database-canonical import conflicts (a page file and the database both changed, or a file the import lane could not take) for the sources this caller can read. Read-only. Remote callers get summaries only. Resolve with gbrain sources conflicts <id> resolve on the brain host.',
  params: {
    source_id: { type: 'string', description: 'Only this source (must be within the caller\'s source grant).' },
    kind: { type: 'string', description: 'Only this conflict kind (for example both_changed).' },
    conflict_id: { type: 'number', description: 'One conflict by id; import_conflict_not_found when it is not visible.' },
    limit: { type: 'number', description: 'At most this many rows (1 to 200, default 50).' },
    include_bytes: { type: 'boolean', description: 'Trusted local callers only: include the stored file bytes (base64).' },
  },
  scope: 'read',
  handler: async (ctx: OperationContext, p) => {
    if (p.include_bytes && ctx.remote !== false) throw opError('invalid_params', 'include_bytes is for trusted local callers only.', 'Call without include_bytes.');
    const conflicts = await listSourceConflicts(ctx.engine, { scope: sourceScopeOpts(ctx), sourceId: p.source_id as string | undefined, kind: p.kind as string | undefined,
      conflictId: p.conflict_id === undefined ? undefined : Number(p.conflict_id), limit: p.limit === undefined ? undefined : Number(p.limit), remote: ctx.remote !== false,
      fenced: slug => slugOutsideCallerFence(ctx, slug), includeBytes: !!p.include_bytes });
    return { conflicts, count: conflicts.length };
  },
};

export const sourceConflictsOperations: Operation[] = [list_source_conflicts];
