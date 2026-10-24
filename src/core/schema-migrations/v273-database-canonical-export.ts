import type { Migration } from './types.ts';
import { DATABASE_CANONICAL_EXPORT_SCHEMA_SQL } from '../persistence/canonical-export-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Database-canonical memory, wave 5a (docs/designs/database-canonical-w5-contract.md):
// the exporter's tables, canonical_export_sources (the per-source export switch,
// off by default, and its watermarks), export_batches (the batch manifest and the
// exporter's own work queue) and export_batch_entries
// (src/core/persistence/canonical-export-schema.ts, also in both blobs).
// Additive and empty: nothing is converted or backfilled, and a source exports
// only after an operator turns export commits on for it.
export const v273: Migration = {
  version: 273,
  name: 'database_canonical_export',
  idempotent: true,
  sql: DATABASE_CANONICAL_EXPORT_SCHEMA_SQL,
};
