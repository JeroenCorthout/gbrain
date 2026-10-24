import type { Migration } from './types.ts';
import { DATABASE_CANONICAL_MODE_SCHEMA_SQL } from '../persistence/canonical-mode-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Database-canonical memory, wave 4 (docs/designs/database-canonical-w4-contract.md):
// the source's mode, mode epoch and eligibility generation on
// database_canonical_sources, the database-mode count on database_canonical_brain,
// persistence_requests.canonical_epoch, persistence_consumers.canonical_protocol
// and the per-source protocol fence triggers
// (src/core/persistence/canonical-mode-schema.ts, also in both blobs).
// Additive: every source stays in files mode, nothing is converted or
// backfilled, and every fence trigger returns at its first statement until an
// operator flips a source with gbrain sources canonical <id> --to database.
export const v272: Migration = {
  version: 272,
  name: 'database_canonical_mode',
  idempotent: true,
  sql: DATABASE_CANONICAL_MODE_SCHEMA_SQL,
};
