import type { Migration } from './types.ts';
import { IMPORT_CONFLICTS_SCHEMA_SQL } from '../persistence/import-conflicts-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Database-canonical memory, wave 3 (docs/designs/DATABASE_CANONICAL_MEMORY.md,
// "The import lane"): the observe-mode import lane's tables, import_conflicts
// (one open row per source and folded path), import_foreign_writes (the
// foreign-writer census) and import_lane_passes
// (src/core/persistence/import-conflicts-schema.ts, also in both blobs).
// Additive and empty: nothing is converted or backfilled, and the lane writes
// them only for a source whose shadow flag an operator turned on.
export const v271: Migration = {
  version: 271,
  name: 'database_canonical_import_lane',
  idempotent: true,
  sql: IMPORT_CONFLICTS_SCHEMA_SQL,
};
