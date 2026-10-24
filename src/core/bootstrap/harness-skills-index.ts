/**
 * `gbrain bootstrap harness` lane of the spring-loaded skills index
 * (src/core/setup/skills-block.ts), beside the brain-first block that
 * harness-brain-first.ts writes for each confirmed host. Selected like
 * setup's: --skill-loading, GBRAIN_SKILL_LOADING, the recorded choice, off.
 * A bootstrap install runs on the brain host, so the index lists every
 * bundled skill. Removal strips only the indexes this lane recorded.
 */
import { brainFirstTargetAt, codexInstructionFile, readBrainFirstLedger } from '../setup/brain-first.ts';
import { describeSkillsBlockOutcome, installerSkillsBlock, removeSkillsBlocksBy, skillsOutcomeFailed, type SkillLoading, type SkillsBlockOutcome } from '../setup/skills-block.ts';
import { setCliExitVerdict } from '../cli-force-exit.ts';
import type { BrainFirstHost, HarnessInstructionPaths } from './harness-brain-first.ts';

const WRITER = 'gbrain bootstrap harness';

export function writeHarnessSkillsIndex(opts: { hosts: readonly BrainFirstHost[]; launcher: string; optOut: boolean; skillLoading?: SkillLoading; paths: HarnessInstructionPaths; log: (line: string) => void }): SkillsBlockOutcome[] {
  const { paths } = opts;
  return opts.hosts.map((host) => {
    const path = host === 'claude-code' ? paths.claudeMemoryPath
      : host === 'codex' ? codexInstructionFile(paths.codexAgentsOverride, paths.codexAgentsPath)
        : paths.opencodeAgentsPath;
    const declined = opts.optOut || readBrainFirstLedger().find((e) => e.harness === host && e.path === path)?.status === 'declined';
    const o = installerSkillsBlock({ target: brainFirstTargetAt(host, path), launcher: opts.launcher, writer: WRITER, brainFirstDeclined: declined, skillLoading: opts.skillLoading, audience: 'owner' });
    if (o.decision.value === 'spring' || o.action !== 'skip') opts.log(describeSkillsBlockOutcome(o, false).trim());
    if (skillsOutcomeFailed(o)) setCliExitVerdict(1);
    return o;
  });
}

export function removeHarnessSkillsIndex(log: (line: string) => void): void {
  for (const o of removeSkillsBlocksBy(WRITER)) {
    log(describeSkillsBlockOutcome(o, false).trim());
    if (skillsOutcomeFailed(o)) setCliExitVerdict(1);
  }
}
