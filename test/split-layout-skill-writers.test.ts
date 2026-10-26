/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): skill writers on a split SKILL.md.
 *
 * 1. Protects: `skills/<name>/SKILL.md` (and the skillopt best.md, proposed.md and version files beside it) are
 *    syncable pages, so an unmanaged brain can hold one as a split head plus parts. The DRY auto-fix and the skillopt
 *    version store write one whole file and have no brain to plan with, so they run the engine-free split preflight
 *    (assertOneFileWritable) on the bytes they would write: a split head (parts directory present or not) or a write
 *    that would grow the page past the split threshold is refused split_page_unsupported and nothing is written.
 * 2. Fails when: either writer rewrites the head of a split page (leaving split_head_modified), writes a page over the
 *    threshold as one file, or writes any of its files before the refusal.
 * 3. No engine; KB-sized limits through __setSplitLimitsForTests.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoFixDryViolations } from '../src/core/dry-fix.ts';
import { acceptCandidate, skilloptDir, writeProposed } from '../src/core/skillopt/version-store.ts';
import { __setSplitLimitsForTests, partsDirFor, readPageFile } from '../src/core/split-layout/index.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { writeSplitPage } from './helpers/split-page.ts';
import { withEnv } from './helpers/with-env.ts';

const LIMITS = { thresholdMin: 1024, thresholdDefault: 2048, partTarget: 512, partMax: 1024, leadMax: 128, partCountMax: 500 };
const body = Array.from({ length: 80 }, (_, i) => `Line ${String(i).padStart(4, '0')} of a long synthetic skill body that fills parts.`).join('\n');
const SKILL = `---\nname: example\ndescription: Synthetic example\n---\n# Example\n\n## Iron Law: Back-Linking (MANDATORY)\n\n${body}\n`;
afterEach(() => __setSplitLimitsForTests(null));

async function withSkills(run: (root: string, skills: string, head: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'split-skill-writers-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      __setSplitLimitsForTests(LIMITS);
      const root = join(home, 'brain'), skills = join(root, 'skills');
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, 'manifest.json'), JSON.stringify({ skills: [{ name: 'example', path: 'example/SKILL.md' }] }));
      await run(root, skills, join(skills, 'example/SKILL.md'));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const refusalOf = (run: () => unknown) => { try { run(); return null; } catch (error) { return (error as { code?: string }).code; } };

for (const parts of ['present', 'missing'] as const) {
  test(`the DRY auto-fix leaves a split SKILL.md whose parts directory is ${parts} as it was (split_page_unsupported)`, () => withSkills(async (root, skills, head) => {
    await writeSplitPage(root, 'skills/example/SKILL.md', SKILL);
    if (parts === 'missing') rmSync(partsDirFor(head), { recursive: true });
    durableGitRepo(root, ['skills']);
    const before = readFileSync(head, 'utf8');
    const report = autoFixDryViolations(skills);
    expect(report.fixed).toEqual([]);
    expect(report.skipped.map(outcome => outcome.reason)).toContain('split_page_unsupported');
    expect(readFileSync(head, 'utf8')).toBe(before);
    if (parts === 'present') expect(readPageFile(head).hold).toBeUndefined();
  }));
}

test('the DRY auto-fix refuses a fix that would grow a one-file SKILL.md past the split threshold (split_page_unsupported)', () => withSkills(async (root, skills, head) => {
  mkdirSync(join(skills, 'example'));
  const near = SKILL.slice(0, 2040) + '\n';
  writeFileSync(head, near);
  durableGitRepo(root, ['skills']);
  const report = autoFixDryViolations(skills);
  expect(report.skipped.map(outcome => outcome.reason)).toContain('split_page_unsupported');
  expect(readFileSync(head, 'utf8')).toBe(near);
  expect(existsSync(partsDirFor(head))).toBe(false);
}));

test('the skillopt version store refuses a candidate for a split SKILL.md, or one over the split threshold, before it writes any file', () => withSkills(async (root, skills, head) => {
  await writeSplitPage(root, 'skills/example/SKILL.md', SKILL);
  const before = readFileSync(head, 'utf8');
  const input = { skillsDir: skills, skillName: 'example', runId: 'synthetic-run', epoch: 1, step: 1, edits: [], candidateText: before.replace('Line 0000', 'Edited line'), selScore: 1, delta: 1 };
  expect(refusalOf(() => acceptCandidate(input))).toBe('split_page_unsupported');
  expect(refusalOf(() => writeProposed(skills, 'example', input.candidateText))).toBe('split_page_unsupported');
  expect(readFileSync(head, 'utf8')).toBe(before);
  rmSync(head); rmSync(partsDirFor(head), { recursive: true });
  writeFileSync(head, 'Short skill.\n');
  expect(refusalOf(() => acceptCandidate({ ...input, candidateText: SKILL }))).toBe('split_page_unsupported');
  expect(readFileSync(head, 'utf8')).toBe('Short skill.\n');
  expect(existsSync(join(skilloptDir(skills, 'example'), 'history.json'))).toBe(false);
  expect(existsSync(join(skilloptDir(skills, 'example'), 'best.md'))).toBe(false);
}));
