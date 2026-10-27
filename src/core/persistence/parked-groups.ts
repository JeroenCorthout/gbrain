import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { GIT_PUSH_CODES } from './git-push-holds.ts';
import { isSplitUnsupportedReason, splitPageUnsupportedAdvice } from './split-unit-guard.ts';

/** GBRA-133: one source's parked Git targets of one error code, with the one command for them all. */
export interface ParkedGroup { source_id: string; code: string; effects: number; targets: number; rule?: string; reason?: string; fix?: Action; command: string[]; next: string }

/**
 * Parked Git targets per source and error code (doctor `parked_effects`, `sources writer status`). Each group names its
 * bulk retry (`--parked-pushes` for push codes, `--parked-code <code>` otherwise) as a preview. A `git_target_ignored`
 * group names the .gitignore rule and says the rule has to change first: a retry while it stands parks again. A
 * `split_page_unsupported` group (one per reason) has no bulk retry, since the refusal repeats until the user acts: it
 * carries the parked target's fix (else the reason's advice, split-unit-guard.ts) and names that fix's command.
 */
export async function readParkedGroups(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<ParkedGroup[]> {
  const rows = await engine.executeRaw<{ source_id: string; code: string; reason: string | null; effects: number; targets: number; rule: string | null; fix: string | null }>(
    `SELECT e.source_id, p->>'error_code' AS code, p->>'reason' AS reason, count(DISTINCT e.id)::int AS effects, count(*)::int AS targets,
            min(p->>'rule') AS rule, min((p->'fix')::text) AS fix
       FROM persistence_effects e CROSS JOIN LATERAL jsonb_array_elements(e.data->'parked') p
      WHERE e.kind='git' AND e.state='failed' AND e.error_code='targets_parked' AND jsonb_typeof(e.data->'parked')='array'
        AND ($1::text[] IS NULL OR e.source_id=ANY($1::text[]))
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [sourceIds ?? null]);
  return rows.map(({ rule, reason, fix, ...row }) => {
    if (row.code === 'split_page_unsupported' && isSplitUnsupportedReason(reason)) {
      const advice = splitPageUnsupportedAdvice(reason, { sourceId: row.source_id });
      const action: Action = fix ? JSON.parse(fix) as Action : advice.fix;
      const command = action.argv ?? action.verify?.argv ?? ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'];
      return { ...row, reason, fix: action, command,
        next: `These Git targets are split page files a Git effect may not commit (split_page_unsupported, ${reason}); a retry refuses and parks them again until the user acts, so there is no bulk retry. ${advice.suggestion}` };
    }
    const push = (GIT_PUSH_CODES as readonly string[]).includes(row.code);
    const command = ['gbrain', 'sources', 'writer', 'retry-effects', row.source_id, ...(push ? ['--parked-pushes'] : ['--parked-code', row.code]), '--dry-run'];
    const askFirst = row.code === 'git_push_secret_found' || row.code === 'git_push_pack_too_large';
    const next = row.code === 'git_target_ignored'
      ? `Git ignores these files${rule ? ` (${rule})` : ''}, so a retry parks them again while the rule stands. Change the rule and commit it, then preview ${command.join(' ')} and rerun it without --dry-run; or keep the files out of Git and leave them parked (their pages are committed in the database).`
      : askFirst ? `A retry holds again until the user acts: gbrain sync status --source ${row.source_id} --json names the commit and the fix in git_push_holds (rotate and allowlist a secret, or raise git.push_max_pack_bytes). Then preview ${command.join(' ')} and rerun it without --dry-run.`
        : `Fix the cause, then preview ${command.join(' ')} and rerun it without --dry-run to authorize one more attempt per target.`;
    return { ...row, ...(rule && !askFirst ? { rule } : {}), command, next };
  });
}
