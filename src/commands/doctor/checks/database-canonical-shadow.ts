/**
 * database_canonical_shadow (database-canonical memory, wave 2): the health of each source's shadow export. Green when no
 * source has shadow on (the default). With shadow on it reports, per source, the export outbox depth and the age of its
 * oldest row, the would-be batch rate, and the latest diff of each page by kind; red while any page's latest diff is an
 * unexpected kind (the exporter would do something wrong today), yellow when the outbox has waited over an hour for a
 * drain or the brain gate was turned off under a shadowed source. Read-only; names the next command.
 */
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { databaseCanonicalEnabled } from '../../../core/persistence/canonical-export.ts';
import { listShadowedSources } from '../../../core/persistence/canonical-shadow.ts';
import { readShadowStatus } from '../../../core/persistence/canonical-shadow-consumer.ts';

const DOCS = 'docs/designs/database-canonical-w2-contract.md';
const STALE_OUTBOX_SECONDS = 3600;

async function runDatabaseCanonicalShadow(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  const enabled = await databaseCanonicalEnabled(engine);
  const shadowed = await listShadowedSources(engine);
  if (!shadowed.length) {
    checks.push({ name: 'database_canonical_shadow', status: 'ok', details: { enabled, sources: [], docs: DOCS },
      message: 'No source has a database-canonical shadow export on (the default), so the export outbox triggers do nothing.' });
    return checks;
  }
  const sources = await Promise.all(shadowed.map(id => readShadowStatus(engine, id)));
  const unexpected = sources.filter(s => Object.keys(s.unexpected).length);
  const stale = sources.filter(s => (s.outbox.oldest_age_seconds ?? 0) > STALE_OUTBOX_SECONDS);
  const summary = sources.map(s => {
    const kinds = Object.entries(s.unexpected).map(([k, n]) => `${k} ${n}`).join(', ');
    return `${s.source_id}: outbox ${s.outbox.depth}${s.outbox.oldest_age_seconds === null ? '' : ` (oldest ${s.outbox.oldest_age_seconds}s)`}, `
      + `${s.batches.last_hour} batch(es) in the last hour, ${kinds ? `unexpected ${kinds}` : 'no unexpected diff'}`;
  }).join('; ');
  const details = { enabled, sources, docs: DOCS };
  const first = unexpected[0] ?? stale[0];
  if (!enabled) {
    checks.push({ name: 'database_canonical_shadow', status: 'warn', details,
      message: `The database-canonical gate is off, but ${shadowed.join(', ')} still have shadow on, so their page writes keep filling the export outbox. ${summary}.`,
      fix: agentFix(['gbrain', 'sources', 'canonical', shadowed[0]!, '--shadow', 'off', '--dry-run'],
        'Previews turning the shadow off (its apply needs the fingerprint it prints); nothing changes until then.', 'database_canonical_shadow') });
    return checks;
  }
  if (unexpected.length) {
    checks.push({ name: 'database_canonical_shadow', status: 'fail', details,
      message: `The shadow export of ${unexpected.map(s => s.source_id).join(', ')} found unexpected diffs: the exporter would get these pages wrong today. ${summary}.`,
      fix: agentFix(['gbrain', 'sources', 'canonical', first!.source_id, '--shadow-status', '--json'],
        'Read-only: lists the pages whose latest shadow diff is unexpected, with their paths and kinds.', 'database_canonical_shadow') });
    return checks;
  }
  if (stale.length) {
    checks.push({ name: 'database_canonical_shadow', status: 'warn', details,
      message: `The export outbox of ${stale.map(s => s.source_id).join(', ')} has waited over an hour for a shadow batch. ${summary}.`,
      fix: agentFix(['gbrain', 'sources', 'canonical', first!.source_id, '--shadow-drain'],
        'Records the next would-be export batch and its diffs; it writes only shadow tables, never the checkout.', 'database_canonical_shadow') });
    return checks;
  }
  checks.push({ name: 'database_canonical_shadow', status: 'ok', details, message: `Shadow export on for ${shadowed.length} source(s). ${summary}.` });
  return checks;
}

export const databaseCanonicalShadowEntry: DoctorEntry = { name: 'database_canonical_shadow', emits: ['database_canonical_shadow'], run: runDatabaseCanonicalShadow };
