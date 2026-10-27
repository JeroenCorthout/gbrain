/**
 * Wave B PR 5 lane 5e (split git layout, spec §9 option B): skill writers on a split SKILL.md.
 *
 * 1. Protects: `skills/<name>/SKILL.md` (and the skillopt best.md, proposed.md and version files beside it) are
 *    syncable pages, so a brain can hold one as a split head plus parts, and only the publication door of a
 *    git-canonical source writes a split page. The DRY auto-fix and the skillopt version store are outside the door and
 *    run the engine-free check (assertOneFileWritable) before they write: a SKILL.md in a split unit (its parts directory
 *    present, or a head declaring gbrain_parts whose parts directory is missing) is refused split_page_unsupported
 *    (outside_door) and none of the writer's files is written. A page in no split unit is written as one file at any
 *    size, as master writes it: a fix or a candidate that grows a one-file SKILL.md past the split threshold leaves one
 *    file and no parts directory.
 * 2. Fails when: either writer rewrites the head of a split page, writes any of its files before the refusal, lays a
 *    page out as a head plus parts, or refuses a one-file page for its size.
 * 3. No engine; KB-sized limits through __setSplitLimitsForTests.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The code (and reason) a writer threw, or null when it wrote. */
const refusalOf = (run: () => unknown) => { try { run(); return null; } catch (error) {
  const { code, reason } = error as { code?: string; reason?: string };
  return reason ? `${code} (${reason})` : code;
} };

/** The head and every part file, by name, as they are on disk (null when gone). */
const layout = (head: string) => ({ head: existsSync(head) ? readFileSync(head, 'utf8') : null,
  parts: existsSync(partsDirFor(head)) ? Object.fromEntries(readdirSync(partsDirFor(head)).sort().map(name => [name, readFileSync(join(partsDirFor(head), name), 'utf8')])) : null });

for (const parts of ['present', 'missing'] as const) {
  test(`the DRY auto-fix leaves a split SKILL.md whose parts directory is ${parts} as it was (split_page_unsupported)`, () => withSkills(async (root, skills, head) => {
    await writeSplitPage(root, 'skills/example/SKILL.md', SKILL);
    if (parts === 'missing') rmSync(partsDirFor(head), { recursive: true });
    durableGitRepo(root, ['skills']);
    const before = layout(head);
    const report = autoFixDryViolations(skills);
    expect(report.fixed).toEqual([]);
    expect(report.skipped.map(outcome => outcome.reason)).toContain('split_page_unsupported');
    expect(layout(head)).toEqual(before);
    if (parts === 'present') expect(readPageFile(head).hold).toBeUndefined();
  }));
}

test('the DRY auto-fix writes a fix that grows a one-file SKILL.md past the split threshold as one file, as master does', () => withSkills(async (root, skills, head) => {
  mkdirSync(join(skills, 'example'));
  const near = SKILL.slice(0, 2040) + '\n';
  writeFileSync(head, near);
  durableGitRepo(root, ['skills']);
  const report = autoFixDryViolations(skills);
  expect(report.skipped).toEqual([]);
  expect(report.fixed.map(outcome => outcome.skill)).toEqual(['example']);
  const after = readFileSync(head, 'utf8');
  expect(after).not.toBe(near);
  expect(Buffer.byteLength(after)).toBeGreaterThan(LIMITS.thresholdDefault);
  expect(readPageFile(head).split).toBe(false);
  expect(existsSync(partsDirFor(head))).toBe(false);
}));

test('the skillopt version store refuses to accept a candidate for a split SKILL.md before it writes any file (split_page_unsupported); a proposal beside it is one file', () => withSkills(async (root, skills, head) => {
  await writeSplitPage(root, 'skills/example/SKILL.md', SKILL);
  const before = layout(head);
  const input = { skillsDir: skills, skillName: 'example', runId: 'synthetic-run', epoch: 1, step: 1, edits: [], candidateText: SKILL.replace('Line 0000', 'Edited line'), selScore: 1, delta: 1 };
  expect(refusalOf(() => acceptCandidate(input))).toBe('split_page_unsupported (outside_door)');
  expect(layout(head)).toEqual(before);
  for (const name of ['history.json', 'best.md', 'proposed.md']) expect(existsSync(join(skilloptDir(skills, 'example'), name))).toBe(false);
  expect(existsSync(join(skilloptDir(skills, 'example'), 'versions')) ? readdirSync(join(skilloptDir(skills, 'example'), 'versions')) : []).toEqual([]);
  writeProposed(skills, 'example', input.candidateText);
  for (const name of ['best.md', 'proposed.md']) {
    const path = join(skilloptDir(skills, 'example'), name);
    expect(readFileSync(path, 'utf8')).toBe(input.candidateText);
    expect(existsSync(partsDirFor(path))).toBe(false);
  }
  expect(layout(head)).toEqual(before);
}));

test('the skillopt version store accepts a candidate that grows a one-file SKILL.md past the split threshold as one file, as master does', () => withSkills(async (_root, skills, head) => {
  mkdirSync(join(skills, 'example'));
  writeFileSync(head, 'Short skill.\n');
  expect(Buffer.byteLength(SKILL)).toBeGreaterThan(LIMITS.thresholdDefault);
  acceptCandidate({ skillsDir: skills, skillName: 'example', runId: 'synthetic-run', epoch: 1, step: 1, edits: [], candidateText: SKILL, selScore: 1, delta: 1 });
  expect(readFileSync(head, 'utf8')).toBe(SKILL);
  expect(readFileSync(join(skilloptDir(skills, 'example'), 'best.md'), 'utf8')).toBe(SKILL);
  expect(existsSync(join(skilloptDir(skills, 'example'), 'history.json'))).toBe(true);
  for (const path of [head, join(skilloptDir(skills, 'example'), 'best.md')]) expect(existsSync(partsDirFor(path))).toBe(false);
}));
