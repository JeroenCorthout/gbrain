/**
 * database_canonical_fence (database-canonical memory, wave 4; docs/designs/database-canonical-w4-contract.md): whether
 * every source in database mode is fenced as the mode promises. Green while no source is in database mode and while each
 * one is consistent. Red when a database-mode source has no epoch or no shadow flag, the brain-level count disagrees with
 * the rows, an unfinished request carries another epoch or a worktree, a checkout effect (`git`, `withdrawal-mirror`) is
 * unfinished, or a live gbrain process does not speak the canonical protocol. Yellow while the brain gate is off with a
 * source in database mode, and for a files-mode source's unfinished request admitted under database mode. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { DATABASE_CANONICAL_KEY, databaseCanonicalEnabled } from '../../../core/persistence/canonical-export.ts';
import { DATABASE_CANONICAL_DOCS } from '../../../core/persistence/canonical-mode.ts';
import { UNSETTLED_REQUEST_SQL } from '../../../core/persistence/canonical-mode-schema.ts';

interface Finding { source_id: string | null; problem: string; count?: number; fix: string }

async function runDatabaseCanonicalFence(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const sources = await engine.executeRaw<{ source_id: string; mode_epoch: string; shadow: boolean }>(
    "SELECT source_id, mode_epoch::text AS mode_epoch, shadow FROM database_canonical_sources WHERE mode='database' ORDER BY source_id");
  const [brain] = await engine.executeRaw<{ n: number }>('SELECT COALESCE((SELECT database_sources FROM database_canonical_brain WHERE singleton=1),0)::int AS n');
  const stale = await engine.executeRaw<{ source_id: string; n: number }>(`SELECT r.source_id, count(*)::int AS n FROM persistence_requests r
      WHERE r.canonical_epoch IS NOT NULL AND ${UNSETTLED_REQUEST_SQL('r')} AND gbrain_source_publication_epoch(r.source_id) IS NULL GROUP BY r.source_id ORDER BY r.source_id`);
  const red: Finding[] = [], yellow: Finding[] = [];
  if (Number(brain?.n ?? 0) !== sources.length) {
    red.push({ source_id: null, problem: `database_canonical_brain counts ${brain?.n ?? 0} database-mode source(s) but ${sources.length} row(s) are in database mode`,
      fix: 'Report it: run gbrain doctor --json and include this finding; the count trigger keeps the two equal.' });
  }
  if (sources.length) {
    const ids = sources.map(s => s.source_id);
    const [requests, effects, processes] = await Promise.all([
      engine.executeRaw<{ source_id: string; n: number }>(`SELECT r.source_id, count(*)::int AS n FROM persistence_requests r
          WHERE r.source_id=ANY($1::text[]) AND ${UNSETTLED_REQUEST_SQL('r')}
            AND (r.worktree_id IS NOT NULL OR r.canonical_epoch IS DISTINCT FROM gbrain_source_publication_epoch(r.source_id)) GROUP BY r.source_id`, [ids]),
      engine.executeRaw<{ source_id: string; n: number }>(`SELECT source_id, count(*)::int AS n FROM persistence_effects WHERE source_id=ANY($1::text[])
          AND kind IN ('git','withdrawal-mirror') AND (state IN ('queued','running') OR recovery IS NOT NULL OR (state='failed' AND NOT (data ? 'settled'))) GROUP BY source_id`, [ids]),
      engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_consumers WHERE renewed_at > now() - interval '5 minutes' AND canonical_protocol IS NULL"),
    ]);
    for (const s of sources) {
      if (Number(s.mode_epoch) < 1) red.push({ source_id: s.source_id, problem: 'mode epoch is 0', fix: 'Report it: a flip always advances the epoch.' });
      if (!s.shadow) red.push({ source_id: s.source_id, problem: 'shadow is off', fix: 'Report it: the database_canonical_mode_shadow constraint keeps shadow on in database mode.' });
    }
    for (const r of requests) red.push({ source_id: r.source_id, count: Number(r.n), problem: `${r.n} unfinished request(s) carry a worktree or another mode epoch`,
      fix: `gbrain sources writer status ${r.source_id} --json names them; cancel a queued one with gbrain cancel-write-request <request_id>.` });
    for (const e of effects) red.push({ source_id: e.source_id, count: Number(e.n), problem: `${e.n} unfinished checkout effect(s) (git or withdrawal-mirror)`,
      fix: `gbrain sources writer status ${e.source_id} --json lists them (blocking_effects); claims never run them for a database-mode source.` });
    if (Number(processes[0]?.n ?? 0)) red.push({ source_id: null, count: Number(processes[0]!.n), problem: `${processes[0]!.n} live gbrain process(es) do not speak the canonical protocol`,
      fix: 'Upgrade or restart them (gbrain upgrade on their host); the fence refuses their writes to database-mode sources.' });
    if (!await databaseCanonicalEnabled(engine)) yellow.push({ source_id: null, problem: `the brain gate ${DATABASE_CANONICAL_KEY} is off while ${sources.length} source(s) are in database mode`,
      fix: `The fence still holds and the verb refuses; turn the gate on with gbrain config set ${DATABASE_CANONICAL_KEY} true to change modes again.` });
  }
  for (const r of stale) yellow.push({ source_id: r.source_id, count: Number(r.n), problem: `${r.n} unfinished request(s) were admitted under database mode before the source returned to files`,
    fix: `They refuse canonical_mode_changed when they publish; gbrain sources writer status ${r.source_id} --json names them.` });
  const details = { database_sources: sources.map(s => ({ source_id: s.source_id, mode_epoch: Number(s.mode_epoch) })), findings: [...red, ...yellow], docs: DATABASE_CANONICAL_DOCS };
  const list = (findings: Finding[]) => findings.map(f => `${f.source_id ? `${f.source_id}: ` : ''}${f.problem}`).join('; ');
  const status = red.length ? 'fail' : yellow.length ? 'warn' : 'ok';
  const checks: Check[] = [];
  checks.push({ name: 'database_canonical_fence', status, details,
    message: red.length ? `Database-canonical fence inconsistent: ${list(red)}. ${red[0]!.fix}`
      : yellow.length ? `Database-canonical fence: ${list(yellow)}. ${yellow[0]!.fix}`
        : sources.length ? `${sources.length} source(s) in database mode, each fenced: no worktree-bound or stale-epoch request, no checkout effect, no old-protocol process.`
          : 'No source is in database mode, so the canonical fence is inert.' });
  return checks;
}

export const databaseCanonicalFenceEntry: DoctorEntry = { name: 'database_canonical_fence', emits: ['database_canonical_fence'], run: runDatabaseCanonicalFence };
