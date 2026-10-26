/**
 * `git_repo_health` (Wave C 1C, G7): for each strict source (`config.canonical = "git"`) with a checkout on this host, the
 * Git object store gbrain maintains (`src/core/git/maintenance.ts`): loose bytes, pack count, packed size and the last
 * recorded maintenance run (automatic or `gbrain git maintenance --apply`). Warns above 256 MiB loose or 50 packs, on a
 * failed last run, and at 2 GB packed when a remote is on github.com (GitHub's soft repository limits); says when the
 * user scheduled git's own maintenance there (the cycle skips it) or `git.maintenance` is off. The fix previews and
 * then runs the maintenance, which runs without the writer lock. Counts and sizes only, never a path.
 */
import { existsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix } from '../check-fix.ts';
import { isGitCheckout } from '../../../core/persistence/git-gap.ts';
import { gitAsync } from '../../../core/sync-git.ts';
import { GIT_MAINTENANCE_KEY, GITHUB_PACKED_WARN_BYTES, LOOSE_REPACK_BYTES, PACK_COUNT_WARN, gitCommonDir, readMaintenanceRecord, repoStats,
  userScheduledMaintenance, type MaintenanceRecord, type RepoStats, type UserScheduled } from '../../../core/git/maintenance.ts';

const DOCS = 'docs/guides/shared-checkout-git.md#git-maintenance';

interface SourceHealth {
  source_id: string; stats: RepoStats; github: boolean; user_scheduled: UserScheduled | null;
  last_run: Pick<MaintenanceRecord, 'at' | 'kind' | 'result' | 'error' | 'pruned_objects'> | null; problems: string[];
}

async function runGitRepoHealth(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('git_repo_health');
  const checks: Check[] = [];
  try {
    const disabled = (await engine.getConfig(GIT_MAINTENANCE_KEY))?.trim().toLowerCase() === 'off';
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>(
      "SELECT id, local_path FROM sources WHERE NOT archived AND COALESCE(config->>'canonical','')='git' ORDER BY id");
    const sources: SourceHealth[] = [];
    for (const row of rows) {
      if (!row.local_path || !existsSync(row.local_path) || !isGitCheckout(row.local_path)) continue;
      const commonDir = await gitCommonDir(row.local_path);
      const [stats, userScheduled, remotes] = await Promise.all([repoStats(row.local_path), userScheduledMaintenance(row.local_path, commonDir),
        gitAsync(row.local_path, ['remote', '-v'], { silenceStderr: true }).catch(() => '')]);
      const last = readMaintenanceRecord(commonDir);
      const github = /github\.com[:/]/i.test(remotes);
      const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
      const problems = [
        stats.loose_bytes > LOOSE_REPACK_BYTES ? `${mib(stats.loose_bytes)} of loose objects (over ${mib(LOOSE_REPACK_BYTES)})` : '',
        stats.packs > PACK_COUNT_WARN ? `${stats.packs} packs (over ${PACK_COUNT_WARN})` : '',
        last?.result === 'failed' ? `the last maintenance run (${last.at}) failed: ${last.error ?? 'unknown error'}` : '',
        github && stats.packed_bytes > GITHUB_PACKED_WARN_BYTES ? `${(stats.packed_bytes / 1000 ** 3).toFixed(1)} GB packed with a github.com remote, past GitHub's soft repository limits` : '',
      ].filter(Boolean);
      sources.push({ source_id: row.id, stats, github, user_scheduled: userScheduled,
        last_run: last ? { at: last.at, kind: last.kind, result: last.result, ...(last.error ? { error: last.error } : {}), pruned_objects: last.pruned_objects } : null, problems });
    }
    const details = { sources, maintenance: disabled ? 'off' : 'auto', docs: DOCS };
    const notes = [
      disabled ? `${GIT_MAINTENANCE_KEY} is off, so the maintenance cycle packs and prunes no repository.` : '',
      ...sources.filter(s => s.user_scheduled).map(s => `${s.source_id}: the user scheduled git's own maintenance (${s.user_scheduled}), so gbrain skips it.`),
    ].filter(Boolean);
    const unhealthy = sources.filter(s => s.problems.length);
    if (!unhealthy.length) {
      const summary = sources.map(s => `${s.source_id}: ${s.stats.loose_objects} loose, ${s.stats.packs} pack(s), last run ${s.last_run ? `${s.last_run.at} (${s.last_run.result})` : 'none'}`);
      checks.push({ name: 'git_repo_health', status: 'ok', details,
        message: [sources.length ? `Every strict source's Git object store is within bounds: ${summary.join('; ')}.` : 'No strict source has a Git checkout on this host.', ...notes].join(' ') });
      return checks;
    }
    const first = unhealthy[0]!.source_id;
    checks.push({ name: 'git_repo_health', status: 'warn', details,
      message: [`The Git object store of ${unhealthy.length} strict source(s) needs maintenance: ${unhealthy.map(s => `${s.source_id}: ${s.problems.join('; ')}`).join('. ')}.`, ...notes].join(' '),
      fix: agentFix(['gbrain', 'git', 'maintenance', '--source', first, '--apply'],
        `Packs ${first}'s loose objects and prunes unreachable objects older than git's two-week grace (one-way, approved as G7), without the writer lock; the preview shows the sizes and steps first. A repository past GitHub's size limits needs fewer large pages there, which maintenance does not change.`,
        'git_repo_health', { preview_argv: ['gbrain', 'git', 'maintenance', '--source', first, '--dry-run', '--json'], docs: DOCS }) });
  } catch (error) {
    checks.push({ name: 'git_repo_health', status: 'ok', details: { health: 'unknown', docs: DOCS },
      message: `Could not read the Git object stores of strict sources (${error instanceof Error ? error.message : String(error)}); gbrain git maintenance --source <id> --dry-run shows one.` });
  }
  return checks;
}

export const gitRepoHealthEntry: DoctorEntry = { name: 'git_repo_health', emits: ['git_repo_health'], run: runGitRepoHealth };
