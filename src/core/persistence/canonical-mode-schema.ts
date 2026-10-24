/**
 * Database-canonical memory, wave 4 (docs/designs/DATABASE_CANONICAL_MEMORY.md, docs/designs/database-canonical-w4-contract.md):
 * the source's mode, mode epoch and eligibility generation, and the per-source protocol fence. Shared by migration v272 and
 * both schema blobs (src/schema.sql region; `bun run build:schema`). Wave 2's canonical-schema.ts is not edited.
 *
 * Everything is additive and inert until an operator flips a source with `gbrain sources canonical <id> --to database`:
 * every fence trigger first reads `database_canonical_brain.database_sources` and returns while it is zero.
 *
 * A process that knows the mode declares `gbrain.canonical_protocol` = 1 in its transaction (`set_config(..., true)`,
 * never a session setting). For a source in database mode the fence refuses, with a typed message prefix and constraint
 * `database_canonical_fence:<point>` (canonical-mode.ts maps both):
 *  - 1a, a request insert without the declaration, or one that names a worktree; otherwise it stamps `canonical_epoch`;
 *  - 1b, an effect insert without the declaration, a checkout effect (`git`, `withdrawal-mirror`) or one naming a worktree;
 *  - 2, a content change to a guarded table without the declaration (the managed writer guard's tables and exemptions);
 *  - 3a, a request reaching `committed` or clearing its recovery record under another mode epoch than it was admitted at.
 */
import { GUARDED_TABLES } from './writer-guard-schema.ts';

const fence = (point: string, code: string, text: string) =>
  `RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='${code}: ${text}', TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='database_canonical_fence:${point}';`;

/** The flip's drain check and the 3a publication fence read this one predicate (contract, "Recovery"). */
export const UNSETTLED_REQUEST_SQL = (alias: string) => `(${alias}.state IN ('queued','running','recovering') OR ${alias}.recovery IS NOT NULL)`;

const FAST_PATH = 'PERFORM 1 FROM database_canonical_brain WHERE singleton=1 AND database_sources>0;';
const PROTOCOL_MISSING = 'this source is in database mode and the writer does not declare the canonical protocol';
const STAMP_COLUMNS = `ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at','embedding_model','embedded_text_hash','write_origin',
      'write_request_id','write_principal_kind','write_principal_id','last_write_request_id','last_write_principal_kind','last_write_principal_id','last_written_at']`;

export const DATABASE_CANONICAL_MODE_SCHEMA_SQL = `
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'files' CHECK (mode IN ('files','database'));
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS mode_epoch BIGINT NOT NULL DEFAULT 0 CHECK (mode_epoch >= 0);
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ;
ALTER TABLE database_canonical_sources ADD COLUMN IF NOT EXISTS eligibility_generation BIGINT NOT NULL DEFAULT 0 CHECK (eligibility_generation >= 0);
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='database_canonical_mode_shadow' AND conrelid='database_canonical_sources'::regclass) THEN
    ALTER TABLE database_canonical_sources ADD CONSTRAINT database_canonical_mode_shadow CHECK (mode <> 'database' OR shadow);
  END IF;
END $c$;
ALTER TABLE database_canonical_brain ADD COLUMN IF NOT EXISTS database_sources INTEGER NOT NULL DEFAULT 0 CHECK (database_sources >= 0);
CREATE OR REPLACE FUNCTION gbrain_count_database_mode_sources() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO database_canonical_brain(singleton, database_sources)
    VALUES (1, (SELECT count(*) FROM database_canonical_sources WHERE mode='database'))
    ON CONFLICT (singleton) DO UPDATE SET database_sources = EXCLUDED.database_sources;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS database_canonical_sources_mode_count ON database_canonical_sources;
CREATE TRIGGER database_canonical_sources_mode_count AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON database_canonical_sources
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_count_database_mode_sources();
ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS canonical_epoch BIGINT;
ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS canonical_protocol INTEGER;
CREATE OR REPLACE FUNCTION gbrain_source_publication_epoch(src TEXT) RETURNS BIGINT LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT mode_epoch FROM database_canonical_sources WHERE source_id = src AND mode = 'database'
$fn$;
CREATE OR REPLACE FUNCTION gbrain_canonical_request_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE epoch BIGINT;
BEGIN
  ${FAST_PATH}
  IF NOT FOUND THEN RETURN NEW; END IF;
  epoch := gbrain_source_publication_epoch(NEW.source_id);
  IF epoch IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('gbrain.canonical_protocol', true), '') <> '1' THEN
    ${fence('request', 'canonical_protocol_required', PROTOCOL_MISSING)}
  END IF;
  IF NEW.worktree_id IS NOT NULL THEN
    ${fence('request', 'canonical_publication_required', 'a worktree-bound request reached a source in database mode')}
  END IF;
  NEW.canonical_epoch := epoch;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS database_canonical_request_fence ON persistence_requests;
CREATE TRIGGER database_canonical_request_fence BEFORE INSERT ON persistence_requests
  FOR EACH ROW EXECUTE FUNCTION gbrain_canonical_request_fence();
CREATE OR REPLACE FUNCTION gbrain_canonical_effect_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  ${FAST_PATH}
  IF NOT FOUND OR NEW.source_id IS NULL OR gbrain_source_publication_epoch(NEW.source_id) IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('gbrain.canonical_protocol', true), '') <> '1' THEN
    ${fence('effect', 'canonical_protocol_required', PROTOCOL_MISSING)}
  END IF;
  IF NEW.kind IN ('git', 'withdrawal-mirror') OR NEW.worktree_id IS NOT NULL THEN
    ${fence('effect', 'canonical_publication_required', 'a checkout effect reached a source in database mode')}
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS database_canonical_effect_fence ON persistence_effects;
CREATE TRIGGER database_canonical_effect_fence BEFORE INSERT ON persistence_effects
  FOR EACH ROW EXECUTE FUNCTION gbrain_canonical_effect_fence();
CREATE OR REPLACE FUNCTION gbrain_canonical_mutation_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE target_source TEXT; old_source TEXT;
BEGIN
  ${FAST_PATH}
  IF NOT FOUND OR COALESCE(current_setting('gbrain.canonical_protocol', true), '') = '1' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- The managed writer guard's exemptions (writer-guard-schema.ts): stamps that change no rendered content pass.
  IF TG_TABLE_NAME = 'pages' AND TG_OP = 'UPDATE' THEN
    IF (NEW.source_id,NEW.slug,NEW.type,NEW.page_kind,NEW.title,NEW.compiled_truth,NEW.timeline,NEW.frontmatter,NEW.deleted_at,NEW.knowledge_revision)
      IS NOT DISTINCT FROM
       (OLD.source_id,OLD.slug,OLD.type,OLD.page_kind,OLD.title,OLD.compiled_truth,OLD.timeline,OLD.frontmatter,OLD.deleted_at,OLD.knowledge_revision)
      AND to_jsonb(NEW)->'trust_tier' IS NOT DISTINCT FROM to_jsonb(OLD)->'trust_tier'
      AND to_jsonb(NEW)->'body_generation' IS NOT DISTINCT FROM to_jsonb(OLD)->'body_generation' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME IN ('facts', 'takes') AND TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) - ${STAMP_COLUMNS} = to_jsonb(OLD) - ${STAMP_COLUMNS} THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'sources' AND TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.incarnation, NEW.local_path, NEW.archived) IS NOT DISTINCT FROM (OLD.id, OLD.incarnation, OLD.local_path, OLD.archived)
      AND (NEW.last_commit, NEW.last_sync_at, NEW.newest_content_at) IS NOT DISTINCT FROM (OLD.last_commit, OLD.last_sync_at, OLD.newest_content_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'sources' THEN
    IF TG_OP <> 'DELETE' THEN target_source := NEW.id; END IF;
    IF TG_OP <> 'INSERT' THEN old_source := OLD.id; END IF;
  ELSIF TG_TABLE_NAME IN ('tags', 'timeline_entries', 'takes') THEN
    IF TG_OP <> 'DELETE' THEN SELECT source_id INTO target_source FROM pages WHERE id = NEW.page_id; END IF;
    IF TG_OP <> 'INSERT' THEN SELECT source_id INTO old_source FROM pages WHERE id = OLD.page_id; END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN target_source := NEW.source_id; END IF;
    IF TG_OP <> 'INSERT' THEN old_source := OLD.source_id; END IF;
  END IF;
  IF (target_source IS NOT NULL AND gbrain_source_publication_epoch(target_source) IS NOT NULL)
    OR (old_source IS NOT NULL AND gbrain_source_publication_epoch(old_source) IS NOT NULL) THEN
    ${fence('mutation', 'canonical_protocol_required', PROTOCOL_MISSING)}
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;
DO $body$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[${GUARDED_TABLES.map(t => "'" + t + "'").join(',')}] LOOP
    IF to_regclass(target) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS database_canonical_fence ON %I', target);
      EXECUTE format('CREATE TRIGGER database_canonical_fence BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gbrain_canonical_mutation_fence()', target);
    END IF;
  END LOOP;
END $body$;
CREATE OR REPLACE FUNCTION gbrain_canonical_publication_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.canonical_epoch IS NULL THEN
    ${FAST_PATH}
    IF NOT FOUND THEN RETURN NEW; END IF;
  END IF;
  IF NEW.canonical_epoch IS DISTINCT FROM gbrain_source_publication_epoch(NEW.source_id) THEN
    ${fence('publication', 'canonical_mode_changed', 'the request was admitted under another mode of its source')}
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS database_canonical_publication_fence ON persistence_requests;
CREATE TRIGGER database_canonical_publication_fence BEFORE UPDATE ON persistence_requests
  FOR EACH ROW WHEN ((NEW.state = 'committed' AND OLD.state IS DISTINCT FROM 'committed') OR (OLD.recovery IS NOT NULL AND NEW.recovery IS NULL))
  EXECUTE FUNCTION gbrain_canonical_publication_fence();
CREATE OR REPLACE FUNCTION gbrain_canonical_eligibility() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  ${FAST_PATH}
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE database_canonical_sources SET eligibility_generation = eligibility_generation + 1
    WHERE mode = 'database' AND (source_id = NEW.source_id OR (TG_OP = 'UPDATE' AND source_id = OLD.source_id));
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS database_canonical_eligibility_insert ON pages;
CREATE TRIGGER database_canonical_eligibility_insert AFTER INSERT ON pages
  FOR EACH ROW WHEN (NEW.frontmatter ?| ARRAY['visibility','access','confidentiality','derived_from'] OR NEW.database_only_reason IS NOT NULL)
  EXECUTE FUNCTION gbrain_canonical_eligibility();
DROP TRIGGER IF EXISTS database_canonical_eligibility_update ON pages;
CREATE TRIGGER database_canonical_eligibility_update AFTER UPDATE ON pages
  FOR EACH ROW WHEN (OLD.frontmatter->'visibility' IS DISTINCT FROM NEW.frontmatter->'visibility'
    OR OLD.frontmatter->'access' IS DISTINCT FROM NEW.frontmatter->'access'
    OR OLD.frontmatter->'confidentiality' IS DISTINCT FROM NEW.frontmatter->'confidentiality'
    OR OLD.frontmatter->'derived_from' IS DISTINCT FROM NEW.frontmatter->'derived_from'
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.source_id IS DISTINCT FROM NEW.source_id
    OR OLD.database_only_reason IS DISTINCT FROM NEW.database_only_reason)
  EXECUTE FUNCTION gbrain_canonical_eligibility();
`;
