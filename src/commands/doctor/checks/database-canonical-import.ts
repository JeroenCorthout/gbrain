/**
 * database_canonical_census (database-canonical memory, wave 3): who still commits page files of the sources whose shadow
 * flag is on, from the observe-mode import lane's foreign-writer census. Green while the brain gate is off, while no source
 * is shadowed, and while no writer other than gbrain's own Git effect committed a page file in the last 7 days; yellow
 * otherwise, listing the writers and naming the census verb. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { DATABASE_CANONICAL_KEY, databaseCanonicalEnabled } from '../../../core/persistence/canonical-export.ts';
import { listShadowedSources } from '../../../core/persistence/canonical-shadow.ts';
import { recentPageWriters } from '../../../core/persistence/import-census.ts';

const DOCS = 'docs/designs/DATABASE_CANONICAL_MEMORY.md';
const DAYS = 7;

async function runDatabaseCanonicalCensus(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  if (!await databaseCanonicalEnabled(engine)) {
    checks.push({ name: 'database_canonical_census', status: 'ok', details: { enabled: false, key: DATABASE_CANONICAL_KEY, docs: DOCS },
      message: 'Database-canonical mode is off for this brain, so the import lane does not run and no writer census is kept.' });
    return checks;
  }
  const sources = await listShadowedSources(engine);
  const writers = await recentPageWriters(engine, sources, DAYS);
  if (!writers.length) {
    checks.push({ name: 'database_canonical_census', status: 'ok', details: { enabled: true, shadowed_sources: sources, writers: [], days: DAYS, docs: DOCS },
      message: sources.length ? `No writer other than gbrain's own Git effect committed page files of a shadowed source in the last ${DAYS} days.`
        : 'No source has shadow on, so the import lane observes nothing.' });
    return checks;
  }
  const first = writers[0]!.source_id;
  checks.push({ name: 'database_canonical_census', status: 'warn',
    details: { enabled: true, shadowed_sources: sources, days: DAYS, docs: DOCS, next: `gbrain sources canonical ${first} --census`,
      writers: writers.map(w => ({ source_id: w.source_id, writer: w.author_name ?? w.writer_key.split('|')[0], process_hint: w.process_hint, commits: w.commits, last_committed_at: w.last_committed_at })) },
    message: `${writers.length} writer(s) committed page files of a shadowed source in the last ${DAYS} days: `
      + writers.slice(0, 5).map(w => `${w.author_name ?? w.writer_key.split('|')[0]}${w.process_hint ? ` [${w.process_hint}]` : ''} on ${w.source_id} (${w.commits} commit(s))`).join('; ')
      + `. Database-canonical mode would turn their edits into imports or conflicts; move them to put_page. See gbrain sources canonical ${first} --census.` });
  return checks;
}

export const databaseCanonicalCensusEntry: DoctorEntry = { name: 'database_canonical_census', emits: ['database_canonical_census'], run: runDatabaseCanonicalCensus };
