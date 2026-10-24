/**
 * Database-canonical memory, wave 5a (docs/designs/database-canonical-w5-contract.md): the exporter's tables. Shared by its
 * migration and both schema blobs (src/schema.sql region; `bun run build:schema`).
 *
 * - `canonical_export_sources`: the per-source export switch (`gbrain sources canonical <id> --export-commits on|off`, off by
 *   default) and the watermarks status reads: the newest committed and pushed commits, the fetched remote tip and how far
 *   the live import lane classified it, the checkout's state and the PGLite one-shot attempt's typed outcome.
 * - `export_batches`: the durable batch manifest and the exporter's own work queue (claim token, lease, backoff, parking).
 *   No export row is ever written to `persistence_requests` or `persistence_effects`; one unfinished batch per source.
 * - `export_batch_entries`: one row per path of a batch, with the hash it expects on disk and the bytes it writes.
 *
 * - Wave 4's mode columns on `database_canonical_sources` (`mode`, `mode_epoch`, `mode_changed_at`,
 *   `eligibility_generation`), with wave 4's definitions and `ADD COLUMN IF NOT EXISTS`, so the exporter can read the mode
 *   whichever wave lands first. Wave 4 owns their constraint, triggers and the flip verb; nothing here writes them.
 *
 * Everything is additive and empty: a source exports only after an operator turns export commits on for it, while it is in
 * database mode and the brain gate is on.
 */

const RLS = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

export const EXPORT_BATCH_STATES = ['prepared', 'built', 'committed', 'pushed', 'completed', 'abandoned'] as const;
/** The states of a batch that still owes work; at most one per source (a partial unique index). */
export const UNFINISHED_EXPORT_BATCH_STATES = ['prepared', 'built', 'committed', 'pushed'] as const;
export const EXPORT_ENTRY_OPS = ['write', 'remove', 'adopt'] as const;
export const EXPORT_ENTRY_STATES = ['pending', 'committed', 'skipped'] as const;
export const EXPORT_SKIP_REASONS = ['outside_edit', 'parked', 'ineligible', 'remote_imported', 'remote_conflict', 'filter_driver', 'superseded'] as const;
export const EXPORT_CHECKOUT_STATES = ['current', 'lagging', 'unbound'] as const;
/** What the PGLite one-shot attempt did: exported, or a typed skip that status shows as a skip, never as a stall. */
export const EXPORT_ONESHOT_OUTCOMES = ['exported', 'skipped_no_checkout', 'skipped_no_remote', 'skipped_lock_busy', 'skipped_deadline',
  'skipped_not_owner', 'skipped_failed'] as const;

const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');

export const UNFINISHED_EXPORT_BATCH_STATES_SQL = `(${list(UNFINISHED_EXPORT_BATCH_STATES)})`;

export const DATABASE_CANONICAL_EXPORT_SCHEMA_SQL = `
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'files' CHECK (mode IN ('files','database'));
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS mode_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ;
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS eligibility_generation BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS canonical_export_sources (
  source_id            TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation   UUID NOT NULL,
  export_commits       BOOLEAN NOT NULL DEFAULT false,
  export_epoch         BIGINT NOT NULL DEFAULT 0,
  export_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_commit     TEXT,
  committed_at         TIMESTAMPTZ,
  pushed_commit        TEXT,
  pushed_at            TIMESTAMPTZ,
  remote_tip           TEXT,
  remote_tip_seen_at   TIMESTAMPTZ,
  laned_through        TEXT,
  import_pending_since TIMESTAMPTZ,
  checkout_state       TEXT NOT NULL DEFAULT 'current' CHECK (checkout_state IN (${list(EXPORT_CHECKOUT_STATES)})),
  checkout_reason      TEXT,
  oneshot_outcome      TEXT CHECK (oneshot_outcome IN (${list(EXPORT_ONESHOT_OUTCOMES)})),
  oneshot_at           TIMESTAMPTZ,
  last_error_code      TEXT,
  last_error_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
${RLS('canonical_export_sources')}
CREATE TABLE IF NOT EXISTS export_batches (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id              TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation     UUID NOT NULL,
  mode_epoch             BIGINT NOT NULL,
  export_epoch           BIGINT NOT NULL,
  eligibility_generation BIGINT NOT NULL,
  target                 TEXT NOT NULL DEFAULT 'worktree' CHECK (target IN ('worktree','bare')),
  worktree_id            UUID,
  topology_generation    BIGINT,
  owner_epoch            BIGINT,
  host_id                UUID,
  state                  TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN (${list(EXPORT_BATCH_STATES)})),
  claim_token            UUID,
  claim_owner            JSONB,
  claim_expires_at       TIMESTAMPTZ,
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  parked_at              TIMESTAMPTZ,
  parent_commit          TEXT,
  tree_oid               TEXT,
  commit_sha             TEXT,
  pushed_commit          TEXT,
  remote_tip             TEXT,
  push_attempts          INTEGER NOT NULL DEFAULT 0 CHECK (push_attempts >= 0),
  oldest_enqueued_at     TIMESTAMPTZ,
  renderer_fp            TEXT,
  error_code             TEXT,
  detail                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  built_at               TIMESTAMPTZ,
  committed_at           TIMESTAMPTZ,
  pushed_at              TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((parked_at IS NULL) OR error_code IS NOT NULL)
);
${RLS('export_batches')}
CREATE UNIQUE INDEX IF NOT EXISTS export_batches_unfinished_idx ON export_batches(source_id) WHERE state IN ${UNFINISHED_EXPORT_BATCH_STATES_SQL};
CREATE INDEX IF NOT EXISTS export_batches_source_idx ON export_batches(source_id, created_at);
CREATE TABLE IF NOT EXISTS export_batch_entries (
  batch_id          UUID NOT NULL REFERENCES export_batches(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  path_folded       TEXT NOT NULL,
  page_id           INTEGER,
  lifetime          INTEGER,
  op                TEXT NOT NULL CHECK (op IN (${list(EXPORT_ENTRY_OPS)})),
  revision          UUID,
  prior_disk_sha256 TEXT,
  prior_blob_oid    TEXT,
  disk_sha256       TEXT,
  blob_oid          TEXT,
  outbox_seq        BIGINT,
  first_enqueued_at TIMESTAMPTZ,
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (${list(EXPORT_ENTRY_STATES)})),
  skip_reason       TEXT CHECK (skip_reason IN (${list(EXPORT_SKIP_REASONS)})),
  PRIMARY KEY (batch_id, path_folded),
  CHECK ((state = 'skipped') = (skip_reason IS NOT NULL))
);
${RLS('export_batch_entries')}
`;
