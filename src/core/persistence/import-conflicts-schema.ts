/**
 * Database-canonical memory, wave 3 (docs/designs/DATABASE_CANONICAL_MEMORY.md, "The import lane"): the tables of the
 * import lane in observe mode. Shared by its migration and both schema blobs (src/schema.sql region; `bun run build:schema`).
 *
 * - `import_conflicts`: what the lane would do with each outside change to a page path, one open row per source and folded
 *   path (`exportPathKey`, the fold `export_ledger.path_folded` uses, so the two join). `outcome` is the lane's would-have
 *   action and `kind` names the conflict when that action is one. Bytes of a would-be conflict are kept inline up to
 *   24 MiB; above that only their SHA-256 and the private Git ref a live lane would pin. Rows are bound to the shadow epoch
 *   they were observed under; resolved rows are kept by id.
 * - `import_foreign_writes`: the foreign-writer census, one row per outside change to a page path (a commit, or
 *   uncommitted bytes in the worktree), with author, committer, the commit message's first line and a process hint.
 * - `import_lane_passes`: one row per lane pass, with its outcome counts and the commit it scanned up to.
 *
 * Everything is additive and empty: the lane runs only for a source whose shadow flag an operator turned on, while the
 * brain gate is on, and writes nothing but these three tables.
 */

const RLS = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

/** The conflict kinds of the design's decision table and of hold adoption (import-conflict-mapping.ts). */
export const IMPORT_CONFLICT_KINDS = ['both_changed', 'protected_metadata', 'deleted_vs_edited', 'deleted_uncommitted', 'bulk_delete',
  'too_large_for_lane', 'unexported_collision', 'unparseable', 'never_exported', 'identity'] as const;

/**
 * What the lane would do with an outside change: adopt the file's hashes (it equals the page), import it as a revision
 * (`streamed_import` above the request cap), create the page, soft-delete it, record a conflict, or nothing (a missing
 * file the history does not show deleted is export pending, not a deletion).
 */
export const IMPORT_LANE_OUTCOMES = ['adopt', 'import', 'streamed_import', 'create', 'delete', 'conflict', 'none'] as const;

export const IMPORT_CONFLICT_STATES = ['open', 'resolved'] as const;

/**
 * Why an open row closed: a later pass saw another outcome, the file went back to its ledger bytes, or the shadow epoch moved.
 * taken_file, taken_database and written are reserved for the live lane (wave 5); this wave never writes them.
 */
export const IMPORT_CONFLICT_RESOLUTIONS = ['superseded', 'cleared', 'epoch_changed', 'taken_file', 'taken_database', 'written'] as const;

/** observe is the only mode this wave runs; live is reserved for the live lane (wave 5) so its rows need no constraint change. */
export const IMPORT_LANE_MODES = ['observe', 'live'] as const;

/** Conflict bytes up to this size are kept in the row; larger ones as a SHA-256 plus a private Git ref (the request cap). */
export const IMPORT_CONFLICT_INLINE_BYTES = 24 * 1024 * 1024;

const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');

export const IMPORT_CONFLICTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS import_conflicts (
  id                BIGSERIAL PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  path_folded       TEXT NOT NULL,
  page_id           INTEGER,
  mode              TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN (${list(IMPORT_LANE_MODES)})),
  outcome           TEXT NOT NULL CHECK (outcome IN (${list(IMPORT_LANE_OUTCOMES)})),
  kind              TEXT CHECK (kind IN (${list(IMPORT_CONFLICT_KINDS)})),
  state             TEXT NOT NULL DEFAULT 'open' CHECK (state IN (${list(IMPORT_CONFLICT_STATES)})),
  shadow_epoch      BIGINT NOT NULL,
  base_revision     UUID,
  db_revision       UUID,
  base_sha256       TEXT,
  file_sha256       TEXT,
  file_size         BIGINT,
  file_bytes        BYTEA,
  file_ref          TEXT,
  commit_sha        TEXT,
  merge             JSONB,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolution        TEXT CHECK (resolution IN (${list(IMPORT_CONFLICT_RESOLUTIONS)})),
  CHECK ((outcome = 'conflict') = (kind IS NOT NULL)),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL)),
  CHECK (file_bytes IS NULL OR octet_length(file_bytes) <= ${IMPORT_CONFLICT_INLINE_BYTES})
);
${RLS('import_conflicts')}
CREATE UNIQUE INDEX IF NOT EXISTS import_conflicts_open_path_idx ON import_conflicts(source_id, path_folded) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS import_conflicts_open_kind_idx ON import_conflicts(source_id, kind) WHERE state = 'open';
CREATE TABLE IF NOT EXISTS import_foreign_writes (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  path_folded     TEXT NOT NULL,
  change_key      TEXT NOT NULL,
  commit_sha      TEXT,
  author_name     TEXT,
  author_email    TEXT,
  committer_name  TEXT,
  committer_email TEXT,
  committed_at    TIMESTAMPTZ,
  message_prefix  TEXT,
  process_hint    TEXT,
  writer_key      TEXT NOT NULL,
  shadow_epoch    BIGINT NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
${RLS('import_foreign_writes')}
CREATE UNIQUE INDEX IF NOT EXISTS import_foreign_writes_change_idx ON import_foreign_writes(source_id, path_folded, change_key);
CREATE INDEX IF NOT EXISTS import_foreign_writes_writer_idx ON import_foreign_writes(source_id, committed_at);
CREATE TABLE IF NOT EXISTS import_lane_passes (
  id           BIGSERIAL PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  shadow_epoch BIGINT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN (${list(IMPORT_LANE_MODES)})),
  head_commit  TEXT,
  commits      INTEGER NOT NULL DEFAULT 0,
  scanned      INTEGER NOT NULL DEFAULT 0,
  unstable     INTEGER NOT NULL DEFAULT 0,
  outcomes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  kinds        JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
${RLS('import_lane_passes')}
CREATE INDEX IF NOT EXISTS import_lane_passes_source_idx ON import_lane_passes(source_id, finished_at);
`;
