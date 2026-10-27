/**
 * GBRA-218: the caller-access record of one remote MCP operation. The
 * credential's verifier-derived principal (never a display name or request
 * data) names the token or OAuth client; its bound member, when the member is
 * live, plus that member's groups form the identity readers are checked
 * against. A brain with no member-access restriction skips the lookup.
 * Every failure (pre-migration schema, unreadable row, unknown member) yields
 * an empty identity, which reads no restricted page (fail closed).
 */
import type { BrainEngine } from '../engine.ts';
import type { AuthInfo } from '../ops/contract.ts';
import { accessRestrictionsPresent, remotePrivacyRelaxed, type CallerAccess } from '../search/private-visibility.ts';
import { identityFor, normalizePrincipal } from './principals.ts';

const MEMBER_SQL = (credential: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${credential}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;

/**
 * The member identity bound to `auth`'s principal; empty when unbound, unknown or unreadable. A write's publication
 * passes its stored principal here, so a member disabled or a binding removed after submission takes effect.
 */
export async function memberIdentityFor(engine: Pick<BrainEngine, 'executeRaw'>, auth: { principal?: { kind: string; id: string } } | undefined): Promise<string[]> {
  const principal = auth?.principal;
  if (!principal || (principal.kind !== 'legacy_token' && principal.kind !== 'oauth_client')) return [];
  const credential = principal.kind === 'legacy_token'
    ? 'SELECT member_id FROM access_tokens WHERE id::text = $1'
    : 'SELECT member_id FROM oauth_clients WHERE client_id = $1';
  try {
    const [row] = await engine.executeRaw<{ id: string; groups: string[] }>(MEMBER_SQL(credential), [principal.id]);
    if (!row || normalizePrincipal(`member:${row.id}`) !== `member:${row.id}`) return [];
    const groups = (row.groups ?? []).filter(g => normalizePrincipal(`group:${g}`) === `group:${g}`);
    return identityFor(row.id, groups);
  } catch {
    return [];
  }
}

/** The CallerAccess fields for a remote operation (identity, privacy relaxation and the GBRA-156 private-readable set). */
export async function remoteCallerAccess(engine: BrainEngine, auth: AuthInfo | undefined, privateSources: readonly string[] | undefined): Promise<Partial<CallerAccess>> {
  const [relaxed, restricted] = await Promise.all([remotePrivacyRelaxed(engine), accessRestrictionsPresent(engine)]);
  return {
    identity: restricted ? await memberIdentityFor(engine, auth) : [],
    privateReadableSources: privateSources ?? [],
    hidePrivate: !relaxed,
    applyRemoteReadPolicy: false,
  };
}
