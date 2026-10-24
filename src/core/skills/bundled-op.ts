/**
 * skills/bundled-op.ts — the `get_skill` path for gbrain's own bundled skills
 * (`bundled: true`, `intent`, `asset`): the on-demand half of the
 * spring-loaded skill resolver. The always-loaded half is the index the
 * install lanes write (spring-index.ts).
 *
 * Explicit by design: a plain `get_skill {name}` keeps reading this brain's
 * own catalog, so a bundled skill never silently stands in for a published,
 * withheld or withdrawn one of the same name.
 *
 * Checks: read scope (the op's), name-shape validation and embedded-map
 * lookups (no filesystem path is ever built from input). Audience: the local
 * CLI and stdio connections run on the brain host and see every bundled
 * skill. HTTP callers see the downstream set only, and only when the owner
 * publishes skills (`mcp.publish_skills`, the gate get_skill already applies
 * to remote callers): serving gbrain's bundled text over HTTP is the one
 * change to the skill catalog's trust memo (skill-catalog.ts, item 5).
 */
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { invalidParam } from '../ops/op-fix.ts';
import { VERSION } from '../../version.ts';
import { bundledSkillAsset, bundledSkills, bundledSkillText, findBundledSkill, type SkillAudience } from './bundled.ts';

const MAX_INTENT_CHARS = 500;
const INTENT_LIMIT = 5;

export function bundledAudience(ctx: OperationContext): SkillAudience {
  return ctx.remote === false || ctx.transport === 'stdio' ? 'owner' : 'downstream';
}

export async function bundledSkillRequest(ctx: OperationContext, p: Record<string, unknown>): Promise<unknown> {
  if (p.bundled !== undefined && p.bundled !== true) {
    throw invalidParam(ctx, 'get_skill', 'bundled', 'intent and asset read gbrain\'s bundled skills; pass bundled: true, or drop them to read this brain\'s catalog.', { example: true });
  }
  if (p.source_id !== undefined || p.revision !== undefined || p.qualified_id !== undefined) {
    throw opError('invalid_params', 'bundled skills ship with gbrain and have no source or revision.', 'Drop source_id, revision and qualified_id, or drop bundled to read this brain\'s catalog.');
  }
  const sc = await import('../skill-catalog.ts');
  const audience = bundledAudience(ctx);
  if (audience === 'downstream') sc.assertPublishEnabled(ctx, await sc.readMcpPublishSkills(ctx));

  if (p.intent !== undefined) {
    if (typeof p.intent !== 'string' || p.intent.trim() === '' || p.intent.length > MAX_INTENT_CHARS) {
      throw invalidParam(ctx, 'get_skill', 'intent', `intent is the task in your own words, 1-${MAX_INTENT_CHARS} characters.`, { example: 'turn this meeting transcript into brain pages' });
    }
    const intent = p.intent;
    const candidates = bundledSkills(audience)
      .map(s => ({ s, match: sc.scoreSkillMatch(s, intent) }))
      .filter((x): x is { s: typeof x.s; match: NonNullable<typeof x.match> } => x.match !== null)
      .sort((a, b) => b.match.score - a.match.score || a.s.name.localeCompare(b.s.name))
      .slice(0, INTENT_LIMIT)
      .map(({ s, match }) => ({ name: s.name, description: s.description.length > 240 ? `${s.description.slice(0, 239)}…` : s.description, match }));
    return { schema_version: 1, bundled: true, gbrain_version: VERSION, intent, candidates,
      next: candidates.length ? 'Fetch the best fit with get_skill {bundled: true, name}. Word overlap ranks these; skip any that does not fit the task.' : 'No bundled skill matches; continue without one.' };
  }

  const name = p.name;
  if (typeof name !== 'string' || name === '' || name.length > 128 || /[/\\\0]|\.\./.test(name)) {
    throw invalidParam(ctx, 'get_skill', 'name', 'name is a bundled skill name from the gbrain skill index, with no slashes or "..".', { example: 'meeting-ingestion' });
  }
  const skill = findBundledSkill(name, audience);
  if (!skill) {
    throw opError('skill_not_found', `gbrain has no bundled skill named ${name} for this connection.`,
      audience === 'owner' ? 'Pick a name from the gbrain skill index, or call get_skill {bundled: true, intent} to find one.'
        : 'Pick a name from the gbrain skill index, or call get_skill {bundled: true, intent} to find one; skills for maintaining the brain host are offered only on the host.');
  }
  if (p.asset !== undefined) {
    const content = typeof p.asset === 'string' ? bundledSkillAsset(skill, p.asset) : undefined;
    if (content === undefined) {
      throw opError('skill_not_found', `${name} lists no asset ${typeof p.asset === 'string' ? p.asset : ''}.`,
        `Fetch the skill first and pass one of its assets exactly: ${skill.assets.join(', ') || 'it has none'}.`);
    }
    return { schema_version: 1, bundled: true, gbrain_version: VERSION, name, asset: p.asset, content };
  }
  const detail = sc.skillDetailFromText(ctx, name, bundledSkillText(skill), { gateDisabled: await sc.readSkillToolGates(ctx) });
  return { ...detail, bundled: true, gbrain_version: VERSION, assets: skill.assets };
}

/**
 * Rethrow a catalog miss (`skill_not_found`, `page_not_found`, or no host
 * skills dir) on a name gbrain ships as a bundled skill this caller may read,
 * with a fix that names the bundled call. The original error is kept for
 * every other case, and nothing is ever served in its place.
 */
export async function pointAtBundled(ctx: OperationContext, p: Record<string, unknown>, err: unknown): Promise<never> {
  const code = (err as { code?: string })?.code;
  const name = typeof p.name === 'string' ? p.name : undefined;
  if (!name || p.source_id !== undefined || !['skill_not_found', 'page_not_found', 'storage_error'].includes(code ?? '') || !findBundledSkill(name, bundledAudience(ctx))) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw opError(code === 'storage_error' ? 'skill_not_found' : code as 'skill_not_found', `${message} gbrain also ships a bundled skill named ${name}.`,
    `To read gbrain's bundled ${name}, call get_skill {bundled: true, name: "${name}"} (CLI: gbrain skill ${name} --bundled).`);
}
