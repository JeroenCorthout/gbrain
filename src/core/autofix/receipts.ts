/**
 * GBRA-133 PR 3: the receipt log of gbrain's automatic repairs, one op_checkpoints row per source incarnation
 * (op `sync-autofix`, fingerprint `<source>:<incarnation>`, newest first, bounded by `AUTOFIX_RECEIPTS_KEPT`; the
 * maintenance purge keeps it while its incarnation is current).
 *
 * A receipt stores codes, paths, hashes, the write's request id and, once it has landed, the repair commit's sha;
 * never file content, a frontmatter value or a command line. The commit is found after the fact
 * (`settleAutofixCommits`): a commit on the path whose bytes hash to the receipt's postimage, whose parent's bytes hash
 * to its preimage, and which touches that path alone. The undo is rendered when the receipt is read
 * (`renderAutofixUndo`), from that validated sha, as `gbrain sync undo --source <id> --commit <sha>` (autofix/undo.ts: the
 * inverse write through the source's persistence owner, whose Git effect lands a new commit under the writer lock; a
 * managed worktree refuses `gbrain git commit-push`); a receipt with no landed commit says plainly that no Git undo exists (yet).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { sha256 } from '../persistence/digest.ts';
import { AUTOFIX_KINDS, admissionRow, type AutofixKind } from './admission.ts';

export const AUTOFIX_RECEIPT_OP = 'sync-autofix';
export const AUTOFIX_RECEIPTS_KEPT = 50;
/** How many recent commits on a path the settle step examines for a receipt's repair commit. */
const SETTLE_LOG_DEPTH = 20;
const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const KEY = /^[a-z][a-z0-9_.]{0,127}$/;

type Exec = Pick<BrainEngine, 'executeRaw'>;

export interface AutofixReceipt {
  id: string;
  at: string;
  kind: AutofixKind;
  /** `automatic`: admitted by gbrain itself; `operator`: an explicit apply someone ran. */
  admission: 'automatic' | 'operator';
  outcome: 'applied' | 'scheduled' | 'failed';
  reason: string | null;
  code: string | null;
  path: string | null;
  /** The switch that turns this kind off (the kind's own; the umbrella sync.autofix.enabled stops every kind). */
  disabling_key: string;
  /** Recovery material kept before the write: the preimage's sha256 and the Git blob that holds its bytes. */
  preimage: { sha256: string; blob_oid: string | null } | null;
  postimage_sha256: string | null;
  request_id: string | null;
  commit: { state: 'none' | 'pending' | 'landed'; sha: string | null };
  /** origin_twin_merge: the soft-deleted twin page, restorable for 72 h. */
  restore: { slug: string; until: string } | null;
}

export type AutofixReceiptInput = Omit<AutofixReceipt, 'id' | 'at' | 'commit' | 'restore' | 'preimage' | 'postimage_sha256' | 'request_id' | 'reason' | 'code' | 'path'>
  & Partial<Pick<AutofixReceipt, 'commit' | 'restore' | 'preimage' | 'postimage_sha256' | 'request_id' | 'reason' | 'code' | 'path'>>;

const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

/** A receipt as stored: every field checked, so a damaged row or a forged value never reaches a reader or an undo. */
export function parseAutofixReceipt(value: unknown): AutofixReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!AUTOFIX_KINDS.includes(r.kind as AutofixKind) || (r.admission !== 'automatic' && r.admission !== 'operator')) return null;
  if (!['applied', 'scheduled', 'failed'].includes(String(r.outcome)) || typeof r.disabling_key !== 'string' || !KEY.test(r.disabling_key)) return null;
  const id = text(r.id, 64), at = text(r.at, 40);
  if (!id || !at || !Number.isFinite(Date.parse(at))) return null;
  const pre = r.preimage as Record<string, unknown> | null | undefined;
  const preimage = pre && typeof pre.sha256 === 'string' && SHA256.test(pre.sha256)
    ? { sha256: pre.sha256, blob_oid: typeof pre.blob_oid === 'string' && OID.test(pre.blob_oid) ? pre.blob_oid : null } : null;
  const c = r.commit as Record<string, unknown> | undefined;
  const sha = typeof c?.sha === 'string' && OID.test(c.sha) ? c.sha : null;
  const commit = c?.state === 'landed' && sha ? { state: 'landed' as const, sha } : c?.state === 'pending' ? { state: 'pending' as const, sha: null } : { state: 'none' as const, sha: null };
  const rest = r.restore as Record<string, unknown> | null | undefined;
  const restore = rest && text(rest.slug, 512) && text(rest.until, 40) ? { slug: rest.slug as string, until: rest.until as string } : null;
  return { id, at, kind: r.kind as AutofixKind, admission: r.admission, outcome: r.outcome as AutofixReceipt['outcome'],
    reason: typeof r.reason === 'string' && CODE.test(r.reason) ? r.reason : null, code: typeof r.code === 'string' && CODE.test(r.code) ? r.code : null,
    path: text(r.path, 4096), disabling_key: r.disabling_key, preimage,
    postimage_sha256: typeof r.postimage_sha256 === 'string' && SHA256.test(r.postimage_sha256) ? r.postimage_sha256 : null,
    request_id: text(r.request_id, 200), commit, restore };
}

/** Appends receipts to the source's log (newest first, bounded); nothing is written for an empty list or a missing source. */
export async function recordAutofixReceipts(engine: Exec, sourceId: string, receipts: AutofixReceiptInput[]): Promise<AutofixReceipt[]> {
  if (!receipts.length) return [];
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) return [];
  const now = new Date().toISOString();
  const full = receipts.map(input => parseAutofixReceipt({ code: null, path: null, reason: null, preimage: null, postimage_sha256: null, request_id: null, restore: null,
    commit: { state: 'none', sha: null }, ...input, id: randomUUID(), at: now })).filter((r): r is AutofixReceipt => r !== null);
  if (!full.length) return [];
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'receipts',$5::text::jsonb)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)||jsonb_build_object('receipts',
      (SELECT COALESCE(jsonb_agg(r ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements($5::text::jsonb||COALESCE(op_checkpoints.completed_keys->0->'receipts','[]'::jsonb))
        WITH ORDINALITY AS e(r,n) WHERE n<=$6))),updated_at=now()`,
  [AUTOFIX_RECEIPT_OP, `${sourceId}:${source.incarnation}`, sourceId, source.incarnation, JSON.stringify([...full].reverse()), AUTOFIX_RECEIPTS_KEPT]);
  return full;
}

/**
 * Records one receipt per managed file rewrite a maintenance repair run applied (the run's sampled outcome items: the
 * path, the preimage and postimage hashes and the write's request id; the commit is pending until the Git effect lands it).
 */
export async function recordRepairRunReceipts(engine: Exec, kind: AutofixKind, items: ReadonlyArray<{ item: string; outcome: string; detail?: Record<string, unknown> }> | undefined): Promise<number> {
  const bySource = new Map<string, AutofixReceiptInput[]>();
  const disabling = admissionRow(kind).switches[0] ?? 'sync.autofix.enabled';
  for (const { item, outcome, detail } of items ?? []) {
    if (outcome !== 'repaired' || detail?.mode !== 'managed' || typeof detail.slug !== 'string' || !item.endsWith(`:${detail.slug}`)) continue;
    const sourceId = item.slice(0, item.length - detail.slug.length - 1);
    const list = bySource.get(sourceId) ?? [];
    list.push({ kind, admission: 'automatic', outcome: 'applied', code: admissionRow(kind).codes[0] ?? null, path: typeof detail.path === 'string' ? detail.path : null, disabling_key: disabling,
      preimage: typeof detail.before_sha256 === 'string' ? { sha256: detail.before_sha256, blob_oid: null } : null,
      postimage_sha256: typeof detail.after_sha256 === 'string' ? detail.after_sha256 : null, request_id: typeof detail.request_id === 'string' ? detail.request_id : null,
      commit: { state: 'pending', sha: null } });
    bySource.set(sourceId, list);
  }
  let recorded = 0;
  for (const [sourceId, receipts] of bySource) recorded += (await recordAutofixReceipts(engine, sourceId, receipts)).length;
  return recorded;
}

/** The current incarnation's receipts of a source, newest first. */
export async function readAutofixReceipts(engine: Exec, sourceId: string, limit = AUTOFIX_RECEIPTS_KEPT): Promise<AutofixReceipt[]> {
  const [row] = await engine.executeRaw<{ receipts: unknown }>(`SELECT c.completed_keys->0->'receipts' AS receipts
    FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text WHERE s.id=$2`, [AUTOFIX_RECEIPT_OP, sourceId]);
  const list = typeof row?.receipts === 'string' ? JSON.parse(row.receipts) as unknown : row?.receipts;
  return (Array.isArray(list) ? list : []).map(parseAutofixReceipt).filter((r): r is AutofixReceipt => r !== null).slice(0, Math.max(0, limit));
}

const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args],
  { env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();

function blobHash(root: string, rev: string, path: string): string | null {
  try { return sha256(execFileSync('git', ['-C', root, 'cat-file', 'blob', `${rev}:./${path}`], { env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })); }
  catch { return null; }
}

/** The commit that made exactly this repair: on the path, preimage → postimage, touching that path alone; null when none (yet). */
export function findRepairCommit(root: string, receipt: Pick<AutofixReceipt, 'path' | 'preimage' | 'postimage_sha256'>): string | null {
  if (!receipt.path || !receipt.preimage || !receipt.postimage_sha256) return null;
  let shas: string[];
  try { shas = git(root, ['log', `-n${SETTLE_LOG_DEPTH}`, '--format=%H', '--no-renames', '--', receipt.path]).split('\n').filter(sha => OID.test(sha)); } catch { return null; }
  for (const sha of shas) {
    if (blobHash(root, sha, receipt.path) !== receipt.postimage_sha256 || blobHash(root, `${sha}^`, receipt.path) !== receipt.preimage.sha256) continue;
    try {
      const touched = git(root, ['diff-tree', '--no-commit-id', '--name-only', '--relative', '-r', '-z', '--no-renames', sha]).split('\0').filter(Boolean);
      if (touched.length === 1 && touched[0] === receipt.path) return sha;
    } catch { /* not readable: not this one */ }
  }
  return null;
}

/** Records the landed commit of every pending receipt whose repair commit is now in the checkout; returns how many landed. */
export async function settleAutofixCommits(engine: Exec, sourceId: string, root: string): Promise<number> {
  const receipts = await readAutofixReceipts(engine, sourceId);
  const landed = new Map<string, string>();
  for (const receipt of receipts) {
    if (receipt.commit.state !== 'pending') continue;
    const sha = findRepairCommit(root, receipt);
    if (sha) landed.set(receipt.id, sha);
  }
  if (!landed.size) return 0;
  await engine.executeRaw(`UPDATE op_checkpoints c SET completed_keys=jsonb_build_array((c.completed_keys->0)||jsonb_build_object('receipts',
      (SELECT COALESCE(jsonb_agg(CASE WHEN m.sha IS NULL THEN r ELSE r||jsonb_build_object('commit',jsonb_build_object('state','landed','sha',m.sha)) END ORDER BY n),'[]'::jsonb)
         FROM jsonb_array_elements(c.completed_keys->0->'receipts') WITH ORDINALITY AS e(r,n)
         LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS m(id text, sha text) ON m.id=r->>'id'))),updated_at=now()
    FROM sources s WHERE c.op=$1 AND s.id=$2 AND c.fingerprint=s.id||':'||s.incarnation::text`,
  [AUTOFIX_RECEIPT_OP, sourceId, JSON.stringify([...landed].map(([id, sha]) => ({ id, sha })))]);
  return landed.size;
}

export type AutofixUndoRendering =
  | { available: true; how: 'git_revert'; sha: string; preview: string[]; argv: string[]; then: string[] }
  | { available: true; how: 'restore'; slug: string; until: string; argv: string[] }
  | { available: false; reason: string };

/**
 * The undo of one receipt, rendered when it is read. A landed repair commit (sha validated: a full hex object id, and a
 * commit in the checkout when `root` is given) reverts through `gbrain sync undo` (preview, then `--apply`: the owner
 * writes the preimage back and lands a new commit; never a force push), then a sync confirms the file. The command names
 * no host path, so a remote caller gets it as is. Anything else says why no Git undo exists.
 */
export function renderAutofixUndo(receipt: AutofixReceipt, opts: { sourceId: string; root?: string | null; remote: boolean }): AutofixUndoRendering {
  const row = admissionRow(receipt.kind);
  const sync = ['gbrain', 'sync', '--source', opts.sourceId, '--no-pull'];
  if (row.undo === 'restore_72h') {
    if (!receipt.restore) return { available: false, reason: 'no_restore_target: the receipt names no soft-deleted page' };
    if (Date.parse(receipt.restore.until) <= Date.now()) return { available: false, reason: `restore_expired: the page could be restored until ${receipt.restore.until}` };
    if (opts.remote) return { available: false, reason: `host_only: the restore names a page, so it is shown on the brain host only (gbrain sync status --source ${opts.sourceId} --json there; restorable until ${receipt.restore.until})` };
    return { available: true, how: 'restore', slug: receipt.restore.slug, until: receipt.restore.until, argv: ['gbrain', 'restore', receipt.restore.slug, '--source-id', opts.sourceId] };
  }
  if (row.undo === 'not_needed') return { available: false, reason: 'nothing_to_undo: this repair changes no file and no page' };
  if (row.undo !== 'git_revert' || receipt.outcome !== 'applied') return { available: false, reason: 'no_git_undo: this receipt records no repair commit' };
  if (receipt.commit.state === 'pending') return { available: false, reason: 'commit_pending: the repair commit has not landed in the checkout yet (gbrain sources writer status shows its Git effect)' };
  const sha = receipt.commit.sha;
  if (receipt.commit.state !== 'landed' || !sha || !OID.test(sha)) return { available: false, reason: 'no_git_undo: no repair commit was recorded for this receipt' };
  if (opts.root) {
    try { if (git(opts.root, ['cat-file', '-t', sha]).trim() !== 'commit') return { available: false, reason: 'commit_missing: the recorded repair commit is not a commit in this checkout' }; }
    catch { return { available: false, reason: 'commit_missing: the recorded repair commit is not in this checkout (history rewritten or another clone)' }; }
  }
  const preview = ['gbrain', 'sync', 'undo', '--source', opts.sourceId, '--commit', sha];
  return { available: true, how: 'git_revert', sha, preview, argv: [...preview, '--apply', '--json'], then: sync };
}
