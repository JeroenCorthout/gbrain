/**
 * GBRA-194: the spring-loaded skill index (the always-loaded half of the
 * resolver) stays inside its byte budget for the real bundled skills tree.
 *
 * Protects: the per-turn cost of `--skill-loading spring`. Every bundled
 * skill keeps a line; trigger phrases are what the line carries; the block
 * names the fetch for the access it was written for.
 * Fails when: a new or longer skill pushes the block past
 * SKILL_INDEX_BUDGET_BYTES, a skill drops out of the index, or the fetch
 * sentence stops naming bundled: true / --bundled.
 */
import { describe, expect, test } from 'bun:test';
import { bundledSkills } from '../src/core/skills/bundled.ts';
import { renderSkillIndexBlock, SKILL_INDEX_BUDGET_BYTES } from '../src/core/skills/spring-index.ts';
import { renderBundledSkillsModule } from '../scripts/generate-bundled-skills.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPT_OUT = 'gbrain setup claude-code --instructions-only --skill-loading off';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('spring-loaded skill index', () => {
  for (const audience of ['owner', 'downstream'] as const) {
    for (const access of [{ kind: 'mcp', server: 'gbrain' }, { kind: 'cli', launcher: '/home/alice-example/.gbrain-agent/bin/gbrain' }] as const) {
      test(`${audience} / ${access.kind}: under budget with every skill on its own line`, () => {
        const skills = bundledSkills(audience);
        const block = renderSkillIndexBlock(skills, access, OPT_OUT);
        expect(bytes(block)).toBeLessThanOrEqual(SKILL_INDEX_BUDGET_BYTES);
        const lines = block.split('\n').filter(l => l.startsWith('- '));
        expect(lines.map(l => l.slice(2, l.indexOf(':')))).toEqual(skills.map(s => s.name));
        expect(block).toContain(access.kind === 'mcp' ? '`bundled: true`' : 'skill <name> --bundled');
      });
    }
  }

  test('the full three-trigger rendering of the owner set fits without the budget guard', () => {
    const skills = bundledSkills('owner');
    const roomy = renderSkillIndexBlock(skills, { kind: 'mcp', server: 'gbrain' }, OPT_OUT, Number.MAX_SAFE_INTEGER);
    expect(renderSkillIndexBlock(skills, { kind: 'mcp', server: 'gbrain' }, OPT_OUT)).toBe(roomy);
  });

  test('over budget, lines drop to fewer triggers but no skill is dropped', () => {
    const skills = bundledSkills('owner');
    const tight = renderSkillIndexBlock(skills, { kind: 'mcp', server: 'gbrain' }, OPT_OUT, 4096);
    expect(tight.split('\n').filter(l => l.startsWith('- '))).toHaveLength(skills.length);
    expect(tight.split('\n').filter(l => l.startsWith('- ')).every(l => !l.includes('; '))).toBe(true);
  });

  test('deterministic and free of quotes that would break the markdown', () => {
    const a = renderSkillIndexBlock(bundledSkills('owner'), { kind: 'mcp', server: 'gbrain' }, OPT_OUT);
    expect(renderSkillIndexBlock(bundledSkills('owner'), { kind: 'mcp', server: 'gbrain' }, OPT_OUT)).toBe(a);
    expect(a.split('\n').filter(l => l.startsWith('- ')).some(l => /["`]/.test(l))).toBe(false);
  });

  test('the embedded bundled-skills module is fresh', () => {
    expect(readFileSync(join(import.meta.dir, '../src/core/skills/bundled-skills.generated.ts'), 'utf8')).toBe(renderBundledSkillsModule());
  });
});
