/**
 * Database-canonical memory, wave 2: the admin-intent binding every source-canonical state change uses (contract:
 * docs/designs/database-canonical-w2-contract.md). A preview prints `sourceCanonicalAdminState`; the apply needs
 * `--admin-intent source_canonical --expected-state <that fingerprint>` and refuses `preview_changed` when the state
 * moved, the way writer administration binds to its admin_state (admin-intent.ts).
 */
import { OperationError } from '../ops/contract.ts';
import { DATABASE_CANONICAL_KEY } from './canonical-export.ts';
import { digest } from './digest.ts';
import type { SqlEngine } from './model.ts';
import { previewChangedError } from './preview-approval.ts';

export const SOURCE_CANONICAL_INTENT = 'source_canonical';

/**
 * The state a source-canonical action is bound to: the source's identity, checkout and mirror flag, the brain gate, the
 * source's canonical row, and for a purge the shadow rows it would delete. `action` is part of the digest, so a
 * fingerprint for one action never authorizes another. Later waves pass their own action names.
 */
export async function sourceCanonicalAdminState(exec: SqlEngine, sourceId: string, action: string): Promise<string> {
  const [row] = await exec.executeRaw<{ state: unknown }>(`SELECT jsonb_build_object(
      'source', (SELECT jsonb_build_array(id, incarnation, archived, local_path, config->>'mirror_read_only') FROM sources WHERE id=$1),
      'gate', (SELECT value FROM config WHERE key=$2),
      'canonical', (SELECT jsonb_build_array(shadow, shadow_epoch::text) FROM database_canonical_sources WHERE source_id=$1),
      'shadow_rows', CASE WHEN $3 = 'purge_shadow' THEN jsonb_build_array(
        (SELECT count(*) FROM export_outbox WHERE source_id=$1), (SELECT count(*) FROM export_shadow_batches WHERE source_id=$1),
        (SELECT count(*) FROM export_shadow_diffs WHERE source_id=$1)) END
    ) AS state`, [sourceId, DATABASE_CANONICAL_KEY, action]);
  return digest({ action, state: row?.state ?? null });
}

/** The apply's fingerprint, or `database_canonical_intent_required` when the intent or a well-formed fingerprint is missing. */
export function requireSourceCanonicalIntent(params: { admin_intent?: string; expected_state?: string }, previewCommand: string): string {
  if (params.admin_intent !== SOURCE_CANONICAL_INTENT || typeof params.expected_state !== 'string' || !/^[a-f0-9]{64}$/.test(params.expected_state)) {
    throw new OperationError('database_canonical_intent_required',
      'Changing a source\'s database-canonical state needs --admin-intent source_canonical and the --expected-state its preview printed; nothing was changed.',
      `Run ${previewCommand}, review it, then rerun with the apply command it prints.`);
  }
  return params.expected_state;
}

/** Refuses `preview_changed` unless the state still has the fingerprint the operator reviewed. */
export async function assertSourceCanonicalState(exec: SqlEngine, sourceId: string, action: string, expected: string, previewCommand: string): Promise<void> {
  if (await sourceCanonicalAdminState(exec, sourceId, action) !== expected) throw previewChangedError(expected, previewCommand);
}
