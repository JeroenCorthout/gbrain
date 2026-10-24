import type { Migration } from './types.ts';
import { DATABASE_CANONICAL_SCHEMA_SQL } from '../persistence/canonical-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Database-canonical memory, wave 2 (docs/designs/database-canonical-w2-contract.md):
// the export ledger, the per-source shadow flag with its brain-level count, the
// export outbox with its AFTER triggers on pages, fact_withdrawals and
// fact_purges, and the shadow diff tables (src/core/persistence/canonical-schema.ts,
// also in both blobs). Additive and empty: nothing is converted or backfilled,
// and every trigger returns after one singleton lookup until an operator turns
// shadow on for a source with gbrain sources canonical <id> --shadow on.
export const v270: Migration = {
  version: 270,
  name: 'database_canonical_shadow',
  idempotent: true,
  sql: DATABASE_CANONICAL_SCHEMA_SQL,
};
