import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-218: per-member read access inside one source. Members and groups name
// people; a token or OAuth client may be bound to one member (member_id) and,
// for shared agents, list whom it may act for (may_act_for). A page names its
// readers in frontmatter `readable_by`; gbrain_access_readers() is the one SQL
// normalization of that value (src/core/access/principals.ts is its row twin,
// and test/access-principals.test.ts holds them equal). It reads the live
// frontmatter, so no writer, rename or backfill can leave a stale copy. Nothing
// is rewritten on upgrade. A trigger sets config access.restrictions_present
// once any page names readers or any member exists (sticky), so a brain with no
// restriction keeps every pre-GBRA-218 read path and escape hatch exactly.
// No schema.sql mirror: like v273, these exist only
// through migrations. Provisional number: renumbered at the merge slot.
export const v274: Migration = {
  version: 274,
  name: 'member_read_access',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS access_members (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  display_name TEXT,
  disabled_at TIMESTAMPTZ,
  tombstoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_groups (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_group_members (
  group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES access_members(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX IF NOT EXISTS access_group_members_member_idx ON access_group_members (member_id);
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS member_id TEXT;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS may_act_for TEXT[];
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS member_id TEXT;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS may_act_for TEXT[];
CREATE OR REPLACE FUNCTION gbrain_access_norm_readers(vals TEXT[]) RETURNS TEXT[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN count(*) > 0 AND bool_and(n IS NOT NULL) THEN array_agg(DISTINCT n COLLATE "C" ORDER BY n COLLATE "C") ELSE ARRAY['!nobody'] END
  FROM (
    SELECT CASE
      WHEN v ~ '^(member:)?[a-z0-9][a-z0-9._-]{0,63}$' THEN 'member:' || regexp_replace(v, '^member:', '')
      WHEN v ~ '^group:[a-z0-9][a-z0-9._-]{0,63}$' THEN v
      ELSE NULL END AS n
    FROM (SELECT translate(btrim(x, ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS v FROM unnest(vals) AS x) AS raw
  ) AS normalized
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_readers(fm JSONB) RETURNS TEXT[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN fm IS NULL OR jsonb_typeof(fm) <> 'object' OR NOT (fm ? 'readable_by') THEN NULL
    WHEN jsonb_typeof(fm->'readable_by') = 'string' THEN gbrain_access_norm_readers(ARRAY[fm->>'readable_by'])
    WHEN jsonb_typeof(fm->'readable_by') = 'array'
      AND jsonb_array_length(fm->'readable_by') BETWEEN 1 AND 256
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(fm->'readable_by') AS e WHERE jsonb_typeof(e) <> 'string')
      THEN gbrain_access_norm_readers(ARRAY(SELECT jsonb_array_elements_text(fm->'readable_by')))
    ELSE ARRAY['!nobody'] END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_mark_restricted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM config WHERE key = 'access.restrictions_present' AND value = '1') THEN
    INSERT INTO config (key, value) VALUES ('access.restrictions_present', '1')
      ON CONFLICT (key) DO UPDATE SET value = '1';
  END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS pages_access_mark_restricted ON pages;
CREATE TRIGGER pages_access_mark_restricted AFTER INSERT OR UPDATE OF frontmatter ON pages
  FOR EACH ROW WHEN (NEW.frontmatter ? 'readable_by') EXECUTE FUNCTION gbrain_access_mark_restricted();
DROP TRIGGER IF EXISTS access_members_mark_restricted ON access_members;
CREATE TRIGGER access_members_mark_restricted AFTER INSERT ON access_members
  FOR EACH ROW EXECUTE FUNCTION gbrain_access_mark_restricted();
INSERT INTO config (key, value)
  SELECT 'access.restrictions_present', '1'
  WHERE EXISTS (SELECT 1 FROM pages WHERE frontmatter ? 'readable_by') OR EXISTS (SELECT 1 FROM access_members)
  ON CONFLICT (key) DO UPDATE SET value = '1';
`,
};
