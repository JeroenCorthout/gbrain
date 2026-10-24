/**
 * skills/spring-index.ts — the spring-loaded skill resolver's always-loaded
 * half: a compact index of gbrain's bundled skills, one line per skill with
 * its trigger phrases, plus the one sentence that says how to load a skill
 * on demand. The full SKILL.md is fetched only when a task matches
 * (get_skill over MCP, `gbrain skill <name>` on the CLI).
 *
 * Generated from each skill's frontmatter `triggers:` (the canonical routing
 * signal; skills/RESOLVER.md is the human map of the same data), so there is
 * no second list to keep in sync. The rendered block is held under
 * SKILL_INDEX_BUDGET_BYTES: lines keep up to three triggers, and when the
 * whole block would exceed the budget every line drops to two, then one.
 * A skill is never dropped. test/spring-skill-index.test.ts pins the budget
 * against the real skills tree.
 */
import type { BundledSkill } from './bundled.ts';

export const SKILL_INDEX_VERSION = 1;
/** Upper bound for the whole managed block interior: it is loaded on every turn. */
export const SKILL_INDEX_BUDGET_BYTES = 6144;
const MAX_TRIGGER_CHARS = 60;

/** How the agent reaches the brain; mirrors BrainFirstAccess in setup/brain-first.ts. */
export type SkillIndexAccess = { kind: 'mcp'; server: string } | { kind: 'cli'; launcher: string };

function cleanTrigger(t: string): string {
  const s = t.replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_TRIGGER_CHARS ? `${s.slice(0, MAX_TRIGGER_CHARS - 1).trimEnd()}…` : s;
}

function indexLine(skill: BundledSkill, perSkill: number): string {
  const seen = new Set<string>();
  const triggers: string[] = [];
  for (const t of skill.triggers) {
    const c = cleanTrigger(t);
    const words = c.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length === 0 || words.every((w) => seen.has(w))) continue;
    for (const w of words) seen.add(w);
    triggers.push(c);
    if (triggers.length === perSkill) break;
  }
  const when = triggers.length ? triggers.join('; ') : cleanTrigger(skill.description);
  return `- ${skill.name}: ${when}`;
}

function header(access: SkillIndexAccess, optOut: string): string[] {
  const load = access.kind === 'mcp'
    ? `call \`get_skill\` on ${access.server} with \`bundled: true\` and the skill's \`name\``
    : `run \`${access.launcher} skill <name> --bundled\``;
  const asset = access.kind === 'mcp'
    ? 'the same way with `asset` added'
    : `with \`${access.launcher} skill <name> --bundled --asset <path>\``;
  return [
    `<!-- gbrain skills v${SKILL_INDEX_VERSION}: managed by gbrain and replaced on upgrade; edit outside these markers. Opt out: ${optOut} -->`,
    '## GBrain skills: load on demand',
    '',
    `GBrain ships step-by-step procedures for brain work. When a task matches a line below, ${load}, then follow it before acting. Load files a skill names ${asset}. Load nothing for a task no line matches.`,
    '',
  ];
}

/** The block interior (without markers). */
export function renderSkillIndexBlock(skills: readonly BundledSkill[], access: SkillIndexAccess, optOut: string, budget = SKILL_INDEX_BUDGET_BYTES): string {
  const head = header(access, optOut);
  let text = '';
  for (const perSkill of [3, 2, 1]) {
    text = [...head, ...skills.map(s => indexLine(s, perSkill))].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= budget) return text;
  }
  return text;
}
