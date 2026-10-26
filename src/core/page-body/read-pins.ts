/**
 * Wave C 1E (large pages, spec §5 and §10 1E): short-lived read pins of segmented pages.
 *
 * A paged read (get_page windows, the thin client's markdown download) or an export of a segmented page holds a row
 * in page_read_pins for the body generation it reads. A live pin is a GC root for that generation, like a retained
 * version (engine-sql/page-body.ts sweepSegments), so an append that moves the page to a new generation mid-read never
 * collects the rows and texts being paged. A read pin also records the rendered view it is bound to: `view_key`, the
 * identity of everything the view renders besides the body generation (the markdown head, so the page's metadata and
 * tags, the withdrawal overlay and the fence overlay of held, demoted or flagged facts rows), and the view's size and sha256, so a continued read is verified against the
 * bytes it started on. Access is not part of the pin: every window is authorized again by get_page before the pin is
 * used, so a delete, a privacy change or a revoked grant stops the read whatever the pin says.
 *
 * Pins hold hashes and sizes only, never page text. They expire READ_PIN_TTL_MS after their last use, and a page holds
 * at most READ_PINS_PER_PAGE live ones; a pin that cannot be written (a read-only database, the per-page cap) leaves
 * the read revision-bound, as it was before pins.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { BodyLedger } from './segment-ledger.ts';
import { activationSuppressedSql } from '../eligibility/sql.ts';

export const READ_PIN_TTL_MS = 15 * 60 * 1000;
export const READ_PINS_PER_PAGE = 64;

export type ReadPinAudience = 'trusted' | 'remote';

export interface ReadPin {
  token: string;
  pageId: number;
  generation: number;
  purpose: 'read' | 'export';
  audience: ReadPinAudience;
  view: 'read' | 'markdown' | null;
  viewKey: string | null;
  principal: string | null;
  revision: string;
  totalBytes: number | null;
  totalLines: number | null;
  sha256: string | null;
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Who may continue a remote read: the token's principal (or client); null for a trusted local caller. */
export function readPinPrincipal(ctx: Pick<OperationContext, 'remote' | 'auth'>): string | null {
  if (ctx.remote === false) return null;
  const auth = ctx.auth;
  return auth?.principal ? `${auth.principal.kind}:${auth.principal.id}` : auth?.clientId ? `client:${auth.clientId}` : 'anonymous';
}

/** Identity of the withdrawal overlay a read applies: every withdrawal and purge tombstone, and the global purge marker. */
export function overlayIdentity(ledger: BodyLedger): string {
  const rows = ledger.withdrawals.map(w => [w.visibility, w.fact_hash, w.withdrawn_at, w.purged === true ? 1 : 0]).sort((a, b) => {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const g = ledger.globalPurges;
  return sha256Hex(JSON.stringify([rows, g ? [g.count, g.latest, g.world_only] : null]));
}

const FENCE_IDENTITY_SQL = `SELECT md5(concat_ws('|',
    coalesce((SELECT p.trust_tier FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL LIMIT 1), ''),
    coalesce((SELECT string_agg(concat_ws(':', f.row_num, f.id, f.trust_tier, (${activationSuppressedSql('facts', 'f')})::text), ',' ORDER BY f.id)
      FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2), ''),
    coalesce((SELECT string_agg(h.fingerprint, ',' ORDER BY h.fingerprint) FROM write_gate_holds h
      WHERE h.kind='fact' AND h.source_id=$1 AND h.slug=$2 AND h.status='held'), ''),
    coalesce((SELECT string_agg(concat_ws(':', fp.visibility, fp.subject, fp.fact_hash), ',' ORDER BY fp.visibility, fp.subject, fp.fact_hash)
      FROM fact_purges fp WHERE fp.source_id=$1 AND (fp.subject='*' OR fp.subject=$2)), ''))) AS id`;

/**
 * Identity of the fence overlay a read applies to the page's facts rows (eligibility/fence-overlay.ts
 * loadFenceChunkOverlay): the page's trust tier, each facts row's tier and activation suppression, the held fact rows
 * and the purges that reach the page. A hold, tier or flag change can swap equal-length rows without moving the body
 * generation, the head or the withdrawal ledger.
 */
export async function fenceOverlayIdentity(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ id: string }>(FENCE_IDENTITY_SQL, [sourceId, slug]);
  return String(row?.id ?? '');
}

/**
 * The rendered view's identity apart from its body generation: view, audience, the exact markdown head (metadata and
 * tags; the read view has none), the withdrawal overlay and the fence overlay (`fence`, fenceOverlayIdentity). Two
 * reads with the same key and generation render the same bytes.
 */
export function renderKey(view: 'read' | 'markdown', audience: ReadPinAudience, head: string | null, ledger: BodyLedger, fence: string): string {
  return `v3:${sha256Hex(JSON.stringify([view, audience, head === null ? null : sha256Hex(head), overlayIdentity(ledger), fence]))}`;
}

/** page_view_digests key of a rendered view: its render key plus the body generation. */
export function digestKey(key: string, generation: number): string {
  return `${key}:${generation}`;
}

/** A new pin, or null when none could be written (read-only database, or the page already holds READ_PINS_PER_PAGE live pins). */
export async function createReadPin(engine: BrainEngine, pin: Omit<ReadPin, 'token'>): Promise<string | null> {
  const token = randomBytes(16).toString('hex');
  try {
    await engine.executeRaw('DELETE FROM page_read_pins WHERE page_id=$1 AND expires_at <= now()', [pin.pageId]);
    const rows = await engine.executeRaw<{ token: string }>(`INSERT INTO page_read_pins (token, page_id, body_generation, purpose, audience, view, view_key,
        principal, revision, total_bytes, total_lines, sha256, expires_at)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + ($13::bigint * interval '1 millisecond')
      WHERE (SELECT count(*) FROM page_read_pins WHERE page_id=$2 AND expires_at > now()) < $14
      RETURNING token`,
    [token, pin.pageId, pin.generation, pin.purpose, pin.audience, pin.view, pin.viewKey, pin.principal, pin.revision, pin.totalBytes, pin.totalLines,
      pin.sha256, READ_PIN_TTL_MS, READ_PINS_PER_PAGE]);
    return rows.length ? token : null;
  } catch {
    return null;
  }
}

/**
 * The live read pin `token` names, its expiry pushed out by READ_PIN_TTL_MS, when it was taken on page `pageId` at
 * `revision` for this view, audience and principal; null otherwise (expired, released, another page's or another
 * caller's: a cursor is not a credential, so a pin only ever continues the read of the caller that took it).
 */
export async function useReadPin(engine: BrainEngine, want: { token: string; pageId: number; revision: string; view: 'read' | 'markdown';
  audience: ReadPinAudience; principal: string | null }): Promise<ReadPin | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`UPDATE page_read_pins SET expires_at = now() + ($7::bigint * interval '1 millisecond')
    WHERE token=$1 AND page_id=$2 AND revision=$3 AND view=$4 AND audience=$5 AND principal IS NOT DISTINCT FROM $6 AND purpose='read'
      AND expires_at > now()
    RETURNING token, page_id, body_generation, purpose, audience, view, view_key, principal, revision, total_bytes, total_lines, sha256`,
  [want.token, want.pageId, want.revision, want.view, want.audience, want.principal, READ_PIN_TTL_MS]).catch(() => [] as Record<string, unknown>[]);
  if (!row) return null;
  const num = (v: unknown) => v == null ? null : Number(v);
  return {
    token: String(row.token), pageId: Number(row.page_id), generation: Number(row.body_generation), purpose: row.purpose as ReadPin['purpose'],
    audience: row.audience as ReadPinAudience, view: (row.view ?? null) as ReadPin['view'], viewKey: (row.view_key ?? null) as string | null,
    principal: (row.principal ?? null) as string | null, revision: String(row.revision), totalBytes: num(row.total_bytes), totalLines: num(row.total_lines),
    sha256: (row.sha256 ?? null) as string | null,
  };
}

/** Push a live pin's expiry out by READ_PIN_TTL_MS; false when it has expired or was released. */
export async function renewReadPin(engine: BrainEngine, token: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ token: string }>(`UPDATE page_read_pins SET expires_at = now() + ($2::bigint * interval '1 millisecond')
    WHERE token=$1 AND expires_at > now() RETURNING token`, [token, READ_PIN_TTL_MS]).catch(() => [] as { token: string }[]);
  return rows.length > 0;
}

export async function releaseReadPin(engine: BrainEngine, token: string): Promise<void> {
  await engine.executeRaw('DELETE FROM page_read_pins WHERE token=$1', [token]).catch(() => undefined);
}
