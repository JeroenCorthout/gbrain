/**
 * Database-canonical memory, wave 2 (docs/designs/DATABASE_CANONICAL_MEMORY.md, docs/designs/database-canonical-w2-contract.md):
 * the export ledger, the export outbox and its triggers, the per-source shadow flag and the shadow diff tables. Shared by
 * migration v270 and both schema blobs (src/schema.sql region; `bun run build:schema`).
 *
 * Everything is additive and inert until an operator turns shadow on for a source with the preview-bound
 * `gbrain sources canonical <id> --shadow on`: the page and withdrawal triggers first read one singleton row
 * (`database_canonical_brain.active_sources`) and return at once when it is zero or absent, so a brain with no shadowed
 * source pays one primary-key lookup per changed page row and nothing else.
 */

const RLS = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

/** Every shadow diff kind; `EXPECTED_SHADOW_DIFF_KINDS` (canonical-shadow.ts) says which are expected. */
export const SHADOW_DIFF_KINDS = ['equal', 'adopt', 'write', 'create', 'remove', 'absent', 'ineligible', 'file_deleted', 'outside_edit', 'both_changed',
  'unexported_collision', 'unparseable', 'no_checkout', 'render_mismatch', 'ineligible_file', 'unsafe_path', 'path_collision'] as const;

export const OUTBOX_CAUSES = ['created', 'written', 'deleted', 'moved_out', 'purged', 'withdrawal'] as const;

export const LEDGER_ORIGINS = ['sync_provenance', 'shadow_adopt', 'export', 'import_lane', 'adoption'] as const;

const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');

export const DATABASE_CANONICAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS database_canonical_sources (
  source_id          TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL,
  shadow             BOOLEAN NOT NULL DEFAULT false,
  shadow_epoch       BIGINT NOT NULL DEFAULT 0,
  shadow_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
${RLS('database_canonical_sources')}
CREATE TABLE IF NOT EXISTS database_canonical_brain (
  singleton      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  active_sources INTEGER NOT NULL DEFAULT 0 CHECK (active_sources >= 0)
);
${RLS('database_canonical_brain')}
CREATE OR REPLACE FUNCTION gbrain_count_canonical_sources() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO database_canonical_brain(singleton, active_sources)
    VALUES (1, (SELECT count(*) FROM database_canonical_sources WHERE shadow))
    ON CONFLICT (singleton) DO UPDATE SET active_sources = EXCLUDED.active_sources;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS database_canonical_sources_count ON database_canonical_sources;
CREATE TRIGGER database_canonical_sources_count AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON database_canonical_sources
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_count_canonical_sources();
CREATE SEQUENCE IF NOT EXISTS export_outbox_seq;
CREATE TABLE IF NOT EXISTS export_outbox (
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_id           INTEGER NOT NULL,
  slug              TEXT NOT NULL,
  revision          UUID,
  cause             TEXT NOT NULL CHECK (cause IN (${list(OUTBOX_CAUSES)})),
  seq               BIGINT NOT NULL DEFAULT nextval('export_outbox_seq'),
  first_enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, page_id)
);
${RLS('export_outbox')}
CREATE INDEX IF NOT EXISTS export_outbox_source_seq_idx ON export_outbox(source_id, seq);
CREATE OR REPLACE FUNCTION gbrain_export_outbox_put(src TEXT, page INTEGER, page_slug TEXT, rev UUID, why TEXT) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM 1 FROM database_canonical_sources WHERE source_id = src AND shadow;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO export_outbox(source_id, page_id, slug, revision, cause) VALUES (src, page, page_slug, rev, why)
    ON CONFLICT (source_id, page_id) DO UPDATE SET slug = EXCLUDED.slug, revision = EXCLUDED.revision, cause = EXCLUDED.cause,
      seq = nextval('export_outbox_seq'), enqueued_at = now();
END $fn$;
CREATE OR REPLACE FUNCTION gbrain_enqueue_page_export() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM 1 FROM database_canonical_brain WHERE singleton = 1 AND active_sources > 0;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM gbrain_export_outbox_put(OLD.source_id, OLD.id, OLD.slug, NULL, 'purged');
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.source_id IS DISTINCT FROM NEW.source_id THEN
    PERFORM gbrain_export_outbox_put(OLD.source_id, OLD.id, OLD.slug, NULL, 'moved_out');
  END IF;
  PERFORM gbrain_export_outbox_put(NEW.source_id, NEW.id, NEW.slug, NEW.knowledge_revision,
    CASE WHEN TG_OP = 'INSERT' THEN 'created' WHEN NEW.deleted_at IS NOT NULL THEN 'deleted' ELSE 'written' END);
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS pages_export_outbox_insert ON pages;
CREATE TRIGGER pages_export_outbox_insert AFTER INSERT ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_enqueue_page_export();
DROP TRIGGER IF EXISTS pages_export_outbox_update ON pages;
CREATE TRIGGER pages_export_outbox_update AFTER UPDATE ON pages
  FOR EACH ROW WHEN (OLD.knowledge_revision IS DISTINCT FROM NEW.knowledge_revision OR OLD.slug IS DISTINCT FROM NEW.slug
    OR OLD.source_id IS DISTINCT FROM NEW.source_id OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.database_only_reason IS DISTINCT FROM NEW.database_only_reason)
  EXECUTE FUNCTION gbrain_enqueue_page_export();
DROP TRIGGER IF EXISTS pages_export_outbox_delete ON pages;
CREATE TRIGGER pages_export_outbox_delete AFTER DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_enqueue_page_export();
CREATE OR REPLACE FUNCTION gbrain_enqueue_withdrawal_export() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE src TEXT; subj TEXT; vis TEXT; hash TEXT;
BEGIN
  PERFORM 1 FROM database_canonical_brain WHERE singleton = 1 AND active_sources > 0;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN src := OLD.source_id; subj := OLD.subject; vis := OLD.visibility; hash := OLD.fact_hash;
  ELSE src := NEW.source_id; subj := NEW.subject; vis := NEW.visibility; hash := NEW.fact_hash; END IF;
  PERFORM 1 FROM database_canonical_sources WHERE source_id = src AND shadow;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO export_outbox(source_id, page_id, slug, revision, cause)
    SELECT p.source_id, p.id, p.slug, p.knowledge_revision, 'withdrawal' FROM pages p
     WHERE p.source_id = src AND p.deleted_at IS NULL
       AND (p.slug = subj OR p.slug IN (SELECT f.source_markdown_slug FROM facts f
         WHERE f.source_id = src AND f.visibility = vis AND (subj = '*' OR f.entity_slug = subj)
           AND (gbrain_fact_fingerprint(f.fact) = hash OR gbrain_fact_fingerprint_v1(f.fact) = hash)))
    ON CONFLICT (source_id, page_id) DO UPDATE SET slug = EXCLUDED.slug, revision = EXCLUDED.revision, cause = EXCLUDED.cause,
      seq = nextval('export_outbox_seq'), enqueued_at = now();
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS fact_withdrawals_export_outbox ON fact_withdrawals;
CREATE TRIGGER fact_withdrawals_export_outbox AFTER INSERT OR UPDATE OR DELETE ON fact_withdrawals
  FOR EACH ROW EXECUTE FUNCTION gbrain_enqueue_withdrawal_export();
DROP TRIGGER IF EXISTS fact_purges_export_outbox ON fact_purges;
CREATE TRIGGER fact_purges_export_outbox AFTER INSERT OR UPDATE OR DELETE ON fact_purges
  FOR EACH ROW EXECUTE FUNCTION gbrain_enqueue_withdrawal_export();
CREATE TABLE IF NOT EXISTS export_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL,
  page_id            INTEGER NOT NULL,
  lifetime           INTEGER NOT NULL DEFAULT 1 CHECK (lifetime >= 1),
  path               TEXT NOT NULL,
  path_folded        TEXT NOT NULL,
  revision           UUID NOT NULL,
  disk_sha256        TEXT NOT NULL,
  blob_oid           TEXT,
  renderer_fp        TEXT,
  commit_sha         TEXT,
  seeded_from        TEXT NOT NULL CHECK (seeded_from IN (${list(LEDGER_ORIGINS)})),
  exported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at         TIMESTAMPTZ
);
${RLS('export_ledger')}
CREATE UNIQUE INDEX IF NOT EXISTS export_ledger_live_path_idx ON export_ledger(source_id, path_folded) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS export_ledger_live_page_idx ON export_ledger(source_id, page_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS export_ledger_lifetime_idx ON export_ledger(source_id, page_id, lifetime);
CREATE TABLE IF NOT EXISTS export_shadow_batches (
  id           BIGSERIAL PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  shadow_epoch BIGINT NOT NULL,
  outbox_rows  INTEGER NOT NULL,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  unexpected   INTEGER NOT NULL DEFAULT 0,
  renderer_fp  TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
${RLS('export_shadow_batches')}
CREATE INDEX IF NOT EXISTS export_shadow_batches_source_idx ON export_shadow_batches(source_id, finished_at);
CREATE TABLE IF NOT EXISTS export_shadow_diffs (
  source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_id         INTEGER NOT NULL,
  batch_id        BIGINT NOT NULL REFERENCES export_shadow_batches(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  path            TEXT,
  revision        UUID,
  kind            TEXT NOT NULL CHECK (kind IN (${list(SHADOW_DIFF_KINDS)})),
  expected        BOOLEAN NOT NULL,
  ledger_revision UUID,
  disk_sha256     TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, page_id)
);
${RLS('export_shadow_diffs')}
CREATE INDEX IF NOT EXISTS export_shadow_diffs_unexpected_idx ON export_shadow_diffs(source_id, kind) WHERE NOT expected;
CREATE INDEX IF NOT EXISTS export_shadow_diffs_batch_idx ON export_shadow_diffs(batch_id);
`;
