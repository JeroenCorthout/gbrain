/**
 * Wave B PR 5 (option B): assertSplitUnitMutableSync, the synchronous form of the split unit predicate for a route outside
 * the publication door that cannot await (skill tooling, the generic write helpers, writers with no brain).
 *
 * 1. Protects: it refuses split_page_unsupported (outside_door) on a head whose parts directory exists, on a head that
 *    declares gbrain_parts with no parts directory, and on any path inside a parts directory; a plain page and a path that
 *    cannot be in a unit pass; a remote caller's refusal names no path.
 * 2. Fails when: the sync form misses a unit the disk shows, or refuses a plain page.
 * 3. Disk only, no Git and no database.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from '../src/core/operations.ts';
import { assertSplitUnitMutableSync } from '../src/core/persistence/split-unit-guard.ts';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

function refusal(path: string, remote = false): { reason?: string; message: string } | null {
  try { assertSplitUnitMutableSync({ root, path: join(root, path), route: 'raw_writer', remote }); return null; }
  catch (error) {
    if (!(error instanceof OperationError) || error.code !== 'split_page_unsupported') throw error;
    return { reason: error.reason, message: error.message };
  }
}

test('the sync predicate refuses every path of a split unit on disk (outside_door) and passes a plain page', () => {
  root = mkdtempSync(join(tmpdir(), 'split-unit-guard-sync-'));
  mkdirSync(join(root, 'notes/.unit.gbparts'), { recursive: true });
  writeFileSync(join(root, 'notes/unit.md'), 'Lead of an acme-example page.\n');
  writeFileSync(join(root, 'notes/.unit.gbparts/0001-00000000.gbpart'), 'Part bytes.\n');
  writeFileSync(join(root, 'notes/head-only.md'), '---\ntitle: Example\ngbrain_parts:\n  version: 1\n---\nLead.\n');
  writeFileSync(join(root, 'notes/plain.md'), '---\ntitle: Plain\n---\nBody.\n');
  for (const path of ['notes/unit.md', 'notes/.unit.gbparts/0001-00000000.gbpart', 'notes/.unit.gbparts/stray.txt', 'notes/head-only.md']) {
    expect(refusal(path)?.reason).toBe('outside_door');
  }
  expect(refusal('notes/unit.md')!.message).toContain('notes/unit.md');
  expect(refusal('notes/unit.md', true)!.message).not.toContain('notes/unit.md');
  expect(refusal('notes/plain.md')).toBeNull();
  expect(refusal('notes/new.md')).toBeNull();
  expect(refusal('notes/data.json')).toBeNull();
});
