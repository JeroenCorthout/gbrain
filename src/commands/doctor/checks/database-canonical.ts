/**
 * database_canonical (database-canonical memory, wave 1): the state of the brain gate
 * `persistence.database_canonical.enabled`. Off is the default and green. On is green too in this release, because no
 * source can be switched to the mode yet; later waves report sources in the mode, their shadow and export health here.
 * Read-only; one config read.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { DATABASE_CANONICAL_KEY, databaseCanonicalEnabled } from '../../../core/persistence/canonical-export.ts';

const DOCS = 'docs/designs/DATABASE_CANONICAL_MEMORY.md';

async function runDatabaseCanonical(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  if (!await databaseCanonicalEnabled(connectedEngine(ctx))) {
    checks.push({ name: 'database_canonical', status: 'ok', details: { enabled: false, key: DATABASE_CANONICAL_KEY, docs: DOCS },
      message: 'Database-canonical mode is off for this brain (the default), so every source keeps its files as the copy of record.' });
    return checks;
  }
  checks.push({ name: 'database_canonical', status: 'ok', details: { enabled: true, key: DATABASE_CANONICAL_KEY, sources_in_mode: 0, docs: DOCS },
    message: 'The database-canonical gate is on, and no source uses the mode: this release ships only the read-only census, gbrain sources canonical <source-id> --dry-run.' });
  return checks;
}

export const databaseCanonicalEntry: DoctorEntry = { name: 'database_canonical', emits: ['database_canonical'], run: runDatabaseCanonical };
