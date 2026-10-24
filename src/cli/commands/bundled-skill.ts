/**
 * `gbrain bundled-skill [<name>] [--asset <path>] [--json]`: print one of
 * gbrain's bundled skills (or one file it names) from the binary itself.
 * The on-demand half of the spring-loaded skill resolver: the skills index
 * that `gbrain setup <harness> --skill-loading spring` writes names this
 * command, so the index and the text it loads always come from the same
 * gbrain. Engine-free: it opens no brain, needs no MCP server or skill
 * publication, and works on a thin client and from a compiled binary.
 *
 * Audience: on a thin-client install (not the brain host) the host-only
 * skills (db-repair, migrations, …) are not offered, matching the index the
 * thin-client install writes.
 */
import { writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { loadConfig, isThinClient } from '../../core/config.ts';
import { opError } from '../../core/ops/contract.ts';
import { suggestNearest } from '../../core/levenshtein.ts';
import { bundledCatalogId, bundledSkillAsset, bundledSkillDescription, bundledSkills, bundledSkillText, findBundledSkill, type SkillAudience } from '../../core/skills/bundled.ts';
import { VERSION } from '../../version.ts';
import { exitCliError, usageError } from '../cli-error.ts';

const HELP = `Usage: gbrain bundled-skill [<name>] [--asset <path>] [--json]

Print a skill gbrain ships (the procedure an agent follows for a task), read
from this gbrain itself. No brain connection is needed.

  gbrain bundled-skill                      every bundled skill, one line each
  gbrain bundled-skill <name>               the skill's SKILL.md, then the files it names
  gbrain bundled-skill <name> --asset <p>   one file the skill names (as listed)
  --json                                    machine-readable output

The skills index written by \`gbrain setup <harness> --skill-loading spring\`
tells agents to run this command when a task matches a skill.
`;

export function bundledSkillAudience(): SkillAudience {
  return isThinClient(loadConfig()) ? 'downstream' : 'owner';
}

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(HELP);
    return;
  }
  const json = args.includes('--json');
  const assetAt = args.findIndex(a => a === '--asset' || a.startsWith('--asset='));
  const asset = assetAt < 0 ? undefined : args[assetAt].startsWith('--asset=') ? args[assetAt].slice('--asset='.length) : args[assetAt + 1];
  if (assetAt >= 0 && (asset === undefined || asset === '' || asset.startsWith('--'))) {
    exitCliError(usageError('--asset requires a file path the skill lists.', 'Run `gbrain bundled-skill <name>` to see the files it names.'), 'bundled-skill');
  }
  const name = args.filter((a, i) => !a.startsWith('-') && !(assetAt >= 0 && i === assetAt + 1))[0];
  const audience = bundledSkillAudience();

  if (name === undefined) {
    if (asset !== undefined) exitCliError(usageError('--asset needs a skill name.', 'Usage: gbrain bundled-skill <name> --asset <path>'), 'bundled-skill');
    const skills = await Promise.all(bundledSkills(audience).map(async s => ({ name: s.name, description: await bundledSkillDescription(s) })));
    await writeStdoutFinal(json
      ? `${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, catalog: bundledCatalogId(), skills }, null, 2)}\n`
      : `${skills.map(s => `${s.name.padEnd(28)} ${s.description}`).join('\n')}\n`);
    return;
  }

  const skill = findBundledSkill(name, audience);
  if (!skill) {
    const nearest = suggestNearest(name, bundledSkills(audience).map(s => s.name));
    exitCliError(opError('skill_not_found', `gbrain ${VERSION} has no bundled skill named ${name}${audience === 'downstream' ? ' for this thin-client install' : ''}.${nearest ? ` Did you mean "${nearest}"?` : ''}`,
      'Run `gbrain bundled-skill` to list them. A skills index from another gbrain version may name a renamed skill; refresh it with `gbrain setup <harness> --instructions-only`.'), 'bundled-skill');
  }

  if (asset !== undefined) {
    const content = bundledSkillAsset(skill, asset);
    if (content === undefined) {
      exitCliError(opError('skill_not_found', `${name} names no file ${asset}.`,
        skill.assets.length ? `Pass one of its files exactly: ${skill.assets.join(', ')}.` : `${name} names no files; its SKILL.md is the whole procedure.`), 'bundled-skill');
    }
    await writeStdoutFinal(json ? `${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, name, asset, content }, null, 2)}\n` : content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  const content = bundledSkillText(skill);
  if (json) {
    await writeStdoutFinal(`${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, catalog: bundledCatalogId(), name, description: await bundledSkillDescription(skill), assets: skill.assets, content }, null, 2)}\n`);
    return;
  }
  const files = skill.assets.length
    ? `\n---\nFiles this skill names (print one with \`gbrain bundled-skill ${name} --asset <path>\`):\n${skill.assets.map(a => `- ${a}`).join('\n')}\n`
    : '';
  await writeStdoutFinal(`${content.endsWith('\n') ? content : `${content}\n`}${files}`);
}
