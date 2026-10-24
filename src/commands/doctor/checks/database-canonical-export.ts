/**
 * Database-canonical memory, wave 5b (docs/designs/database-canonical-w5-contract.md, "Doctor"): three checks, each green
 * while no source is in database mode. `database_canonical_backup`: a fresh verified backup or an unexpired operator
 * attestation for a brain whose canonical copy is the database. `export_lag`: the exporter keeps up (yellow above 300 s, red
 * above 3600 s, red for a parked batch with its retry command; a PGLite brain whose newest one-shot outcome is a typed skip
 * is yellow with that reason). `import_conflicts`: open live conflicts by kind. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { databaseCanonicalEnabled } from '../../../core/persistence/canonical-export.ts';
import { readDatabaseCanonicalStatus, type CanonicalSourceStatus } from '../../../core/persistence/canonical-status.ts';
import { loadBackupStatus } from '../../../core/backup/status-file.ts';

const DOCS = 'docs/designs/database-canonical-w5-contract.md';
export const EXPORT_LAG_WARN_SECONDS = 300;
export const EXPORT_LAG_FAIL_SECONDS = 3600;
export const BACKUP_MAX_AGE_KEY = 'persistence.database_canonical.backup_max_age_days';
export const BACKUP_ATTESTATION_KEY = 'persistence.database_canonical.backup_attestation';

async function databaseSources(ctx: DoctorContext): Promise<CanonicalSourceStatus[] | null> {
  const engine = connectedEngine(ctx);
  if (!await databaseCanonicalEnabled(engine)) return null;
  return (await readDatabaseCanonicalStatus(engine)).filter(s => s.mode === 'database');
}

const IDLE = { database_sources: 0, docs: DOCS };

async function runBackup(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const sources = await databaseSources(ctx);
  if (!sources?.length) { checks.push({ name: 'database_canonical_backup', status: 'ok', message: 'No source is in database mode, so the files remain a full copy of memory.', details: IDLE }); return checks; }
  const engine = connectedEngine(ctx);
  const maxDays = Number(await engine.getConfig(BACKUP_MAX_AGE_KEY)) || 7;
  const status = loadBackupStatus();
  const age = status ? (Date.now() - Date.parse(status.checked_at)) / 86_400_000 : null;
  const verified = !!status && status.overall === 'ok' && !status.degraded;
  let attestation: { kind?: string; provider?: string; expires_at?: string } | null = null;
  try { attestation = JSON.parse((await engine.getConfig(BACKUP_ATTESTATION_KEY)) ?? 'null'); } catch { attestation = null; }
  const attested = !!attestation?.expires_at && Date.parse(attestation.expires_at) > Date.now();
  const details = { database_sources: sources.map(s => s.source_id), backup_checked_at: status?.checked_at ?? null, backup_overall: status?.overall ?? null, max_age_days: maxDays,
    attestation, next: 'gbrain backup check', docs: DOCS };
  if ((verified && age !== null && age <= maxDays) || attested) {
    checks.push({ name: 'database_canonical_backup', status: 'ok', details, message: verified && age !== null && age <= maxDays
      ? `A verified backup check from ${status!.checked_at} covers the database-mode source(s).` : `An operator attestation (${attestation!.kind ?? 'backup'} by ${attestation!.provider ?? 'unknown'}) is valid until ${attestation!.expires_at}.` });
    return checks;
  }
  if (status || attestation) {
    checks.push({ name: 'database_canonical_backup', status: 'warn', details, message: `The newest backup evidence is stale or unverified (${status ? `check from ${status.checked_at}, ${status.overall}` : 'attestation expired'}); the database is the canonical copy of ${sources.length} source(s). Run gbrain backup check.` });
    return checks;
  }
  checks.push({ name: 'database_canonical_backup', status: 'fail', details, message: `No backup check or attestation exists while ${sources.length} source(s) keep their canonical copy in the database. Run gbrain backup check.` });
  return checks;
}

async function runExportLag(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const sources = await databaseSources(ctx);
  if (!sources?.length) { checks.push({ name: 'export_lag', status: 'ok', message: 'No source is in database mode, so nothing is exported.', details: IDLE }); return checks; }
  const pglite = connectedEngine(ctx).kind === 'pglite';
  const findings: Array<{ source_id: string; level: 'warn' | 'fail'; reason: string; next: string }> = [];
  for (const s of sources) {
    const next = `gbrain sync status --source ${s.source_id}`;
    if (s.batch?.parked_at) { findings.push({ source_id: s.source_id, level: 'fail', reason: `export batch parked (${s.batch.error_code ?? 'no code'}); retry with ${s.batch.retry!.join(' ')}`, next: s.batch.retry!.join(' ') }); continue; }
    if (!s.export_commits || s.export_lag_seconds === null) continue;
    if (pglite && s.oneshot?.outcome.startsWith('skipped')) {
      if (s.export_lag_seconds > EXPORT_LAG_WARN_SECONDS) findings.push({ source_id: s.source_id, level: 'warn', reason: `${s.export_lag_seconds}s behind; the last one-shot attempt was ${s.oneshot.outcome} (PGLite has no resident; the next command exports)`, next });
      continue;
    }
    if (s.export_lag_seconds > EXPORT_LAG_FAIL_SECONDS) findings.push({ source_id: s.source_id, level: 'fail', reason: `${s.export_lag_seconds}s behind (${s.export_pending} pending); no owner is exporting`, next });
    else if (s.export_lag_seconds > EXPORT_LAG_WARN_SECONDS) findings.push({ source_id: s.source_id, level: 'warn', reason: `${s.export_lag_seconds}s behind (${s.export_pending} pending)`, next });
  }
  const details = { sources: sources.map(s => ({ source_id: s.source_id, export_commits: s.export_commits, export_lag_seconds: s.export_lag_seconds, export_pending: s.export_pending,
    batch: s.batch, oneshot: s.oneshot })), findings, warn_seconds: EXPORT_LAG_WARN_SECONDS, fail_seconds: EXPORT_LAG_FAIL_SECONDS, docs: DOCS };
  if (!findings.length) { checks.push({ name: 'export_lag', status: 'ok', details, message: `The exporter is keeping up for ${sources.length} database-mode source(s).` }); return checks; }
  checks.push({ name: 'export_lag', status: findings.some(f => f.level === 'fail') ? 'fail' : 'warn', details,
    message: findings.map(f => `${f.source_id}: ${f.reason}. See ${f.next}.`).join(' ') });
  return checks;
}

async function runImportConflicts(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const sources = await databaseSources(ctx);
  if (!sources?.length) { checks.push({ name: 'import_conflicts', status: 'ok', message: 'No source is in database mode, so no live import conflict can exist.', details: IDLE }); return checks; }
  const open = sources.filter(s => s.conflicts_open > 0);
  const details = { sources: open.map(s => ({ source_id: s.source_id, conflicts: s.conflicts, next: `gbrain sources conflicts ${s.source_id} list` })), docs: DOCS };
  if (!open.length) { checks.push({ name: 'import_conflicts', status: 'ok', details, message: 'No open live import conflict.' }); return checks; }
  checks.push({ name: 'import_conflicts', status: 'warn', details, message: open.map(s => `${s.source_id}: ${s.conflicts.map(c => `${c.count} ${c.kind} (oldest ${c.oldest_age_seconds}s)`).join(', ')}; see gbrain sources conflicts ${s.source_id} list.`).join(' ') });
  return checks;
}

export const databaseCanonicalBackupEntry: DoctorEntry = { name: 'database_canonical_backup', emits: ['database_canonical_backup'], run: runBackup };
export const exportLagEntry: DoctorEntry = { name: 'export_lag', emits: ['export_lag'], run: runExportLag };
export const importConflictsEntry: DoctorEntry = { name: 'import_conflicts', emits: ['import_conflicts'], run: runImportConflicts };
