/**
 * #5053 — `frontmatter validate --fix` passed the ABSOLUTE file path to the
 * fixer, whose slug check then saw every declared `slug:` as a mismatch and
 * deleted it (re-keying the page on the next import). validate now passes
 * `autoFixFrontmatter` the path the slug derives from: the brain-root-relative
 * path, or the basename outside a brain.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A NESTED_QUOTES error gives --fix something to repair, so the fixer runs.
const page = (slug: string) => `---\ntype: note\ntitle: "a "quoted" title"\nslug: ${slug}\n---\n\nbody\n`;

let scratch: string;
let brain: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fm-5053-'));
  brain = join(scratch, 'brain');
  mkdirSync(join(brain, '.git'), { recursive: true });
  mkdirSync(join(brain, 'notes'), { recursive: true });
});

afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function validateFix(target: string): string {
  const result = spawnSync(process.execPath, ['run', 'src/cli.ts', 'frontmatter', 'validate', target, '--fix'], {
    encoding: 'utf8', cwd: process.cwd(),
    env: { ...process.env, GBRAIN_HOME: join(scratch, 'home'), DATABASE_URL: '', GBRAIN_DATABASE_URL: '' },
  });
  return (result.stdout ?? '') + (result.stderr ?? '');
}

describe('#5053 frontmatter validate --fix', () => {
  test('a correct slug survives --fix while the real error is repaired', () => {
    const file = join(brain, 'notes', 'foo-bar.md');
    writeFileSync(file, page('notes/foo-bar'));
    const output = validateFix(file);
    const fixed = readFileSync(file, 'utf8');
    expect(fixed).toContain('slug: notes/foo-bar');
    expect(fixed).not.toContain('"a "quoted" title"');
    expect(output).not.toContain('Removed mismatched slug');
  }, 60_000);

  test('a legacy-identity slug whose slugified spelling matches the path survives (#3772)', () => {
    const file = join(brain, 'notes', 'foo-bar.md');
    writeFileSync(file, page('Notes/Foo Bar'));
    validateFix(file);
    expect(readFileSync(file, 'utf8')).toContain('slug: Notes/Foo Bar');
  }, 60_000);

  test('a truly mismatched slug is still removed', () => {
    const file = join(brain, 'notes', 'foo-bar.md');
    writeFileSync(file, page('other/thing'));
    validateFix(file);
    expect(readFileSync(file, 'utf8')).not.toContain('slug:');
  }, 60_000);

  test('a file outside any brain root keeps a slug that matches its basename', () => {
    const loose = join(scratch, 'loose');
    mkdirSync(loose);
    const file = join(loose, 'note.md');
    writeFileSync(file, page('note'));
    validateFix(file);
    expect(readFileSync(file, 'utf8')).toContain('slug: note');
  }, 60_000);
});
