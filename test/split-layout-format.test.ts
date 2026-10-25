/**
 * Split git layout format core (Wave B PR 5 lane 5a, spec `9 option B): plan, render, parse, verify, reassemble.
 *
 * Protects: a page stored as a head file plus part files reassembles byte for byte to its canonical file F; the head
 * imports as an ordinary short page for an older gbrain; the `gbrain_parts` key is removed as text without touching
 * the page's own frontmatter bytes; greedy cuts are stable under append; strict head validation never throws; part
 * files are read only as regular files inside the head's parts directory; `sync.max_file_bytes` parses and clamps.
 * Regression it catches: any cut, lead or strip rule that loses or reorders a byte (CRLF, missing final newline,
 * multi-byte characters at a cut, a line longer than a part), a manifest the reader accepts loosely, a symlinked
 * or stray part, an append that renames earlier parts.
 * Existing coverage: none; the module is new and other lanes wire it into publication and sync.
 * Seam: __setSplitLimitsForTests (KB-sized limits); no production caller needs it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { dumpFrontmatterYaml } from '../src/core/data-frontmatter.ts';
import { parseMarkdown, parseMarkdownHead, serializePageToMarkdown } from '../src/core/markdown.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { SYNC_TUNABLE_KEYS } from '../src/core/sync-config-keys.ts';
import type { Page } from '../src/core/types.ts';
import {
  __setSplitLimitsForTests, headPathForPartsDir, isPartPath, LEAD_MAX_BYTES, PART_COUNT_MAX, PART_MAX_BYTES, PART_TARGET_BYTES,
  parseHead, parseSplitThreshold, partsDirFor, partsDirName, planSplit, reassemble, renderHead, SPLIT_MAX_FILE_BYTES_KEY,
  splitLimits, splitScratchPath, splitStagingDir, splitThresholdBytes, splitThresholdConfigRefusal, sweepSplitStaging, verifyParts,
  type ParsedHead, type SplitManifest, type SplitPlan,
} from '../src/core/split-layout/index.ts';
import { withEnv } from './helpers/with-env.ts';
import { atomicStagingPath } from '../src/core/atomic-write.ts';
import { screenSplitHead } from '../src/core/split-layout/read.ts';
import { gitHoldFix } from '../src/core/persistence/sync-holds.ts';

const SMALL = { thresholdMin: 1, partTarget: 64, partMax: 128, leadMax: 32, partCountMax: 500 };
const HEAD_REL = 'notes/big-page.md';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const engine = {} as BrainEngine;

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-split-layout-')); });
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => __setSplitLimitsForTests(null));

const inHome = <T>(fn: () => Promise<T> | T) => withEnv({ GBRAIN_HOME: home }, fn);

async function* chunked(bytes: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const n = sizes[i % sizes.length]!;
    yield bytes.subarray(at, at + n);
    at += n;
  }
}

function pageFile(body: string, frontmatter: Record<string, unknown> = { source: 'fixture' }, title = 'Big page'): string {
  const page = { id: 1, slug: 'notes/big-page', type: 'note', title, compiled_truth: body, timeline: '', frontmatter,
    created_at: new Date(0), updated_at: new Date(0) } as Page;
  return serializePageToMarkdown(page, ['alpha', 'beta']);
}

/** A deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const piece of source) out.push(piece);
  return Buffer.concat(out);
}

/** Writes the head and every part where publication would put them. */
async function publish(plan: SplitPlan, headPath: string): Promise<void> {
  mkdirSync(partsDirFor(headPath), { recursive: true });
  writeFileSync(headPath, plan.head());
  for (const part of plan.parts) writeFileSync(join(dirname(headPath), part.path), await collect(plan.range(part.start, part.end)));
}

interface Published { plan: SplitPlan; headPath: string; parsed: ParsedHead; dir: string }

async function publishFile(file: string | Uint8Array, sizes: number[] = [7]): Promise<Published> {
  const dir = mkdtempSync(join(home, 'repo-'));
  const headPath = join(dir, HEAD_REL);
  mkdirSync(dirname(headPath), { recursive: true });
  const plan = await inHome(() => planSplit(chunked(Buffer.from(file), sizes), { headPath: HEAD_REL }));
  await publish(plan, headPath);
  const parsed = parseHead(readFileSync(headPath, 'utf8'));
  if (!parsed || 'error' in parsed) throw new Error('head did not parse: ' + JSON.stringify(parsed));
  return { plan, headPath, parsed, dir };
}

async function reassembled(headPath: string, parsed: ParsedHead): Promise<Buffer> {
  const dest = await inHome(() => splitScratchPath());
  const verdict = reassemble(headPath, parsed, dest);
  expect(verdict).toMatchObject({ ok: true });
  const bytes = readFileSync(dest);
  rmSync(dest);
  if (verdict.ok) expect({ bytes: verdict.bytes, sha256: verdict.sha256 }).toEqual({ bytes: bytes.length, sha256: sha(bytes) });
  return bytes;
}

async function roundTrip(file: string | Uint8Array, sizes?: number[]): Promise<Published> {
  const published = await publishFile(file, sizes);
  const expected = Buffer.from(file);
  const withoutBom = expected[0] === 0xef && expected[1] === 0xbb && expected[2] === 0xbf ? expected.subarray(3) : expected;
  expect(verifyParts(published.headPath, published.parsed)).toEqual({ ok: true, bytes: withoutBom.length, sha256: sha(withoutBom) });
  expect((await reassembled(published.headPath, published.parsed)).equals(withoutBom)).toBe(true);
  for (const part of published.plan.parts) {
    expect(part.bytes).toBeLessThanOrEqual(splitLimits.partMax);
    utf8.decode(readFileSync(join(published.dir, 'notes', part.path)));
  }
  published.plan.dispose();
  return published;
}

function mixedText(seed: number, bytes: number): string {
  const next = rng(seed);
  const alphabet = ['a', 'b', ' ', 'é', '€', '𝄞', '\n', '\r\n', 'z'];
  let out = '';
  while (Buffer.byteLength(out) < bytes) out += alphabet[Math.floor(next() * alphabet.length)]!.repeat(1 + Math.floor(next() * 9));
  return out;
}

describe('round trip: reassemble(render(plan(F))) is F', () => {
  test('a serializer page in any chunking', async () => {
    __setSplitLimitsForTests(SMALL);
    const file = pageFile(Array.from({ length: 60 }, (_, i) => `Line ${i} of the page body, long enough to matter.`).join('\n'));
    for (const sizes of [[1], [7], [1000], [3, 1, 4, 1, 5, 9, 26]]) await roundTrip(file, sizes);
  });

  test('CRLF bodies, a body without a final newline, and multi-byte text at every cut', async () => {
    __setSplitLimitsForTests(SMALL);
    await roundTrip(pageFile('first\r\nsecond line\r\n'.repeat(40)));
    await roundTrip('---\ntype: note\ntitle: x\n---\n' + 'no final newline '.repeat(50));
    for (let seed = 1; seed <= 25; seed++) await roundTrip(pageFile(mixedText(seed, 600 + seed * 37)), [5, 64, 1]);
  });

  test('a lead with no line break is cut at a character boundary', async () => {
    __setSplitLimitsForTests(SMALL);
    for (const ch of ['é', '€', '𝄞']) {
      for (let shift = 0; shift < 4; shift++) {
        const body = 'x'.repeat(shift) + ch.repeat(40) + '\n' + 'tail\n'.repeat(30);
        const { plan } = await roundTrip('---\ntitle: x\n---\n' + body);
        expect(plan.manifest.lead_bytes).toBeLessThanOrEqual(32);
        expect(Buffer.from(body).subarray(0, plan.manifest.lead_bytes).toString('utf8')).toBe(plan.lead);
        expect(plan.headBody).toBe(plan.lead + '\n' + plan.notice);
      }
    }
  });

  test('a line longer than a part is cut at a character boundary', async () => {
    __setSplitLimitsForTests(SMALL);
    for (const ch of ['é', '€', '𝄞']) {
      for (let shift = 0; shift < 4; shift++) {
        const { plan, dir } = await roundTrip(pageFile('y'.repeat(shift) + ch.repeat(300) + '\nend\n'));
        expect(plan.parts[0]!.bytes).toBe(1);
        const forced = plan.parts.slice(0, -1).filter(part => readFileSync(join(dir, 'notes', part.path)).at(-1) !== 0x0a);
        expect(forced.length).toBeGreaterThanOrEqual(4);
        for (const part of forced) expect(part.bytes).toBeGreaterThan(124);
      }
    }
  });

  test('an empty frontmatter block (the serializer never writes one) and a BOM (dropped, as import drops it)', async () => {
    __setSplitLimitsForTests(SMALL);
    expect(pageFile('body', {}, '')).toStartWith('---\ntype: note\ntitle: \'\'\n');
    const { plan } = await roundTrip('---\n---\n' + 'empty frontmatter page\n'.repeat(20));
    expect(plan.frontmatter).toBe('---\n---\n');
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pageFile('bom page line\n'.repeat(20)))]);
    const bom = await roundTrip(withBom, [1, 2]);
    expect(bom.plan.fileBytes).toBe(withBom.length - 3);
    const headWithBom = '\uFEFF' + readFileSync(bom.headPath, 'utf8');
    expect(parseHead(headWithBom)).toEqual(bom.parsed);
  });

  test('production limits: a 30 MiB file streams into parts of at most 16 MiB', async () => {
    const line = 'A production-sized line of page text, with some € and 𝄞 in it.\n';
    const lines = Math.ceil((30 * 1024 ** 2) / Buffer.byteLength(line));
    const frontmatter = '---\ntype: note\ntitle: Huge\n---\n';
    async function* source() { yield Buffer.from(frontmatter); for (let i = 0; i < lines; i += 4096) yield Buffer.from(line.repeat(Math.min(4096, lines - i))); }
    const plan = await inHome(() => planSplit(source(), { headPath: 'huge.md' }));
    try {
      expect(plan.parts.map(part => part.bytes).every(bytes => bytes <= PART_TARGET_BYTES)).toBe(true);
      expect(plan.parts.length).toBe(4);
      expect(plan.manifest.lead_bytes).toBeLessThanOrEqual(LEAD_MAX_BYTES);
      const hash = createHash('sha256');
      for (const part of plan.parts) hash.update(await collect(plan.range(part.start, part.end)));
      expect(hash.digest('hex')).toBe(plan.bodyHash);
    } finally { plan.dispose(); }
  });
});

describe('head file', () => {
  test('imports as an ordinary short page: lead plus notice, gbrain_parts an ordinary key, the page frontmatter intact', async () => {
    __setSplitLimitsForTests(SMALL);
    const file = pageFile(Array.from({ length: 30 }, (_, i) => `Paragraph ${i} body text.`).join('\n'));
    const { plan, headPath } = await publishFile(file);
    const head = readFileSync(headPath, 'utf8');
    const read = parseMarkdownHead(head);
    expect(read.body).toBe(plan.headBody);
    expect(read.frontmatter.gbrain_parts).toEqual(plan.manifest);
    const page = parseMarkdown(head, HEAD_REL);
    expect(page.title).toBe('Big page');
    expect(page.tags).toEqual(['alpha', 'beta']);
    expect(page.compiled_truth).toBe(plan.headBody.trim());
    expect(page.frontmatter.gbrain_parts).toEqual(plan.manifest);
    expect(plan.notice).toBe(`> [gbrain] This page continues in ${plan.parts.length} part files (${plan.bodyBytes} B). Current gbrain versions read them; older versions see only this lead.\n`);
    expect(plan.headBody).toBe(plan.lead + plan.notice);
    expect(file.startsWith(plan.frontmatter)).toBe(true);
    expect(Buffer.from(file).subarray(Buffer.byteLength(plan.frontmatter), Buffer.byteLength(plan.frontmatter) + plan.manifest.lead_bytes).toString()).toBe(plan.lead);
    const lines = head.split('\n');
    const keyLine = lines.indexOf('gbrain_parts:');
    expect(lines.slice(keyLine + 1).findIndex(line => /^\S/.test(line))).toBe(lines.slice(keyLine + 1).indexOf('---'));
    expect(head.slice(0, head.indexOf('gbrain_parts:'))).toBe(plan.frontmatter.slice(0, -4));
    plan.dispose();
  });

  test('render refuses a page whose own frontmatter has gbrain_parts; a nested key of that name is fine', async () => {
    __setSplitLimitsForTests(SMALL);
    const own = pageFile('text\n'.repeat(50), { gbrain_parts: 'mine' });
    const staged = () => inHome(() => readdirSync(splitStagingDir()).filter(name => name.startsWith(`${process.pid}-`)));
    const before = await staged();
    await expect(inHome(() => planSplit(chunked(Buffer.from(own), [9]), { headPath: HEAD_REL }))).rejects.toMatchObject({ name: 'SplitLayoutError', code: 'frontmatter_has_parts_key' });
    expect(await staged()).toEqual(before);
    const { plan } = await publishFile(pageFile('text\n'.repeat(50)));
    expect(() => renderHead({ ...plan, frontmatter: '---\ngbrain_parts: 1\n---\n' })).toThrow(expect.objectContaining({ code: 'frontmatter_has_parts_key' }));
    plan.dispose();
    await roundTrip(pageFile('text\n'.repeat(50), { meta: { gbrain_parts: 'nested' } }));
  });

  test('parse reads a plain page that has a gbrain_parts key as a (broken) manifest, never as an ordinary page', () => {
    expect(parseHead('---\ntitle: x\ngbrain_parts: hello\n---\nbody\n')).toEqual({ error: { code: 'split_page_incomplete', reason: expect.any(String) } });
    expect(parseHead('---\ntitle: x\n"gbrain_parts": {}\n---\nbody\n')).toMatchObject({ error: { code: 'split_page_incomplete' } });
    expect(parseHead('---\ntitle: [unclosed\ngbrain_parts:\n  format: 1\n---\nbody\n')).toMatchObject({ error: { code: 'split_page_incomplete' } });
  });

  test('a frontmatter edit in the head survives reassembly; a key added after gbrain_parts is kept', async () => {
    __setSplitLimitsForTests(SMALL);
    const { plan, headPath } = await publishFile(pageFile('kept body line\n'.repeat(30)));
    const B = (await collect(plan.range(Buffer.byteLength(plan.frontmatter), Buffer.byteLength(plan.frontmatter) + plan.bodyBytes)));
    const edited = readFileSync(headPath, 'utf8').replace('title: Big page', 'title: Renamed page').replace(/\n---\n/, '\nadded_later: true\n---\n');
    writeFileSync(headPath, edited);
    const parsed = parseHead(edited) as ParsedHead;
    expect(parsed.frontmatterWithoutParts).toBe(plan.frontmatter.replace('title: Big page', 'title: Renamed page').replace(/---\n$/, 'added_later: true\n---\n'));
    const bytes = await reassembled(headPath, parsed);
    expect(bytes.equals(Buffer.concat([Buffer.from(parsed.frontmatterWithoutParts), B]))).toBe(true);
    expect(parseMarkdown(bytes.toString('utf8'), HEAD_REL).title).toBe('Renamed page');
    plan.dispose();
  });

  test('a body edit in the head is split_head_modified, and reassemble leaves no file', async () => {
    __setSplitLimitsForTests(SMALL);
    const { plan, headPath } = await publishFile(pageFile('body line\n'.repeat(30)));
    const parsed = parseHead(readFileSync(headPath, 'utf8').replace('body line', 'BODY LINE')) as ParsedHead;
    expect(verifyParts(headPath, parsed)).toMatchObject({ ok: false, code: 'split_head_modified' });
    const dest = await inHome(() => splitScratchPath());
    expect(reassemble(headPath, parsed, dest)).toMatchObject({ ok: false, code: 'split_head_modified' });
    expect(existsSync(dest)).toBe(false);
    plan.dispose();
  });

  test('parse is null for ordinary files and never throws', async () => {
    __setSplitLimitsForTests(SMALL);
    expect(parseHead(pageFile('plain\n'))).toBeNull();
    expect(parseHead('no frontmatter at all\n')).toBeNull();
    expect(parseHead('')).toBeNull();
    const { plan, headPath } = await publishFile(pageFile('fuzz line\n'.repeat(20)));
    const head = readFileSync(headPath, 'utf8');
    plan.dispose();
    const next = rng(7);
    for (let i = 0; i < 400; i++) {
      const a = Math.floor(next() * head.length), b = Math.floor(next() * head.length);
      const mutated = head.slice(0, Math.min(a, b)) + ['', ':', '\n', '- ', '"', '---\n', '  '][i % 7] + head.slice(Math.max(a, b));
      const result = parseHead(mutated);
      expect(result === null || 'error' in result || 'manifest' in result).toBe(true);
    }
  });

  const valid = (): SplitManifest => ({
    format: 1, total_bytes: 30, content_hash: 'a'.repeat(64), lead_bytes: 10, lead_sha256: 'b'.repeat(64),
    parts: [{ path: '.big-page.gbparts/0001-cccccccc.gbpart', bytes: 20, sha256: 'c'.repeat(64) },
      { path: '.big-page.gbparts/0002-dddddddd.gbpart', bytes: 10, sha256: 'd'.repeat(64) }],
  });
  const headOf = (manifest: unknown) => '---\ntitle: x\n' + dumpFrontmatterYaml({ gbrain_parts: manifest }) + '---\nlead\n';
  const broken: Array<[string, (m: Record<string, any>) => unknown]> = [
    ['format 2', m => ({ ...m, format: 2 })],
    ['a missing key', ({ lead_sha256: _, ...m }) => m],
    ['an unknown key', m => ({ ...m, extra: 1 })],
    ['total not the sum', m => ({ ...m, total_bytes: 31 })],
    ['a zero-byte part', m => ({ ...m, total_bytes: 20, parts: [m.parts[0], { ...m.parts[1], bytes: 0 }] })],
    ['a part over the max', m => ({ ...m, total_bytes: 20 + PART_MAX_BYTES + 1, parts: [m.parts[0], { ...m.parts[1], bytes: PART_MAX_BYTES + 1 }] })],
    ['an uppercase hash', m => ({ ...m, content_hash: 'A'.repeat(64) })],
    ['a short hash', m => ({ ...m, lead_sha256: 'b'.repeat(63) })],
    ['a wrong index', m => ({ ...m, parts: [m.parts[0], { ...m.parts[1], path: '.big-page.gbparts/0003-dddddddd.gbpart' }] })],
    ['a name that does not match the hash', m => ({ ...m, parts: [m.parts[0], { ...m.parts[1], path: '.big-page.gbparts/0002-eeeeeeee.gbpart' }] })],
    ['parts in two directories', m => ({ ...m, parts: [m.parts[0], { ...m.parts[1], path: '.other.gbparts/0002-dddddddd.gbpart' }] })],
    ['a path escaping the directory', m => ({ ...m, parts: [m.parts[0], { ...m.parts[1], path: '../.x.gbparts/0002-dddddddd.gbpart' }] })],
    ['an absolute path', m => ({ ...m, parts: [m.parts[0], { ...m.parts[1], path: '/tmp/.x.gbparts/0002-dddddddd.gbpart' }] })],
    ['a nested path', m => ({ ...m, parts: [m.parts[0], { ...m.parts[1], path: '.big-page.gbparts/sub/0002-dddddddd.gbpart' }] })],
    ['lead_bytes 0', m => ({ ...m, lead_bytes: 0 })],
    ['lead_bytes over total', m => ({ ...m, lead_bytes: 31 })],
    ['lead_bytes over the lead max', m => ({ ...m, total_bytes: LEAD_MAX_BYTES + 21, lead_bytes: LEAD_MAX_BYTES + 1, parts: [m.parts[0], { ...m.parts[1], bytes: LEAD_MAX_BYTES + 1 }] })],
    ['no parts', m => ({ ...m, parts: [] })],
    ['a fractional size', m => ({ ...m, total_bytes: 30.5 })],
    ['a scalar', () => 'hello'],
    ['a list', () => [1, 2]],
  ];
  test('the valid baseline parses', () => {
    expect(parseHead(headOf(valid()))).toEqual({ manifest: valid(), frontmatterWithoutParts: '---\ntitle: x\n---\n', headBody: 'lead\n' });
  });
  test.each(broken)('strict validation: %s is split_page_incomplete', (_name, mutate) => {
    expect(parseHead(headOf(mutate(valid() as Record<string, any>)))).toEqual({ error: { code: 'split_page_incomplete', reason: expect.any(String) } });
  });
  test('strict validation: more parts than the count limit', () => {
    __setSplitLimitsForTests({ partCountMax: 1 });
    expect(parseHead(headOf(valid()))).toMatchObject({ error: { code: 'split_page_incomplete' } });
  });
});

describe('verifyParts and reassemble read only the listed regular files', () => {
  async function fresh() {
    __setSplitLimitsForTests(SMALL);
    const published = await publishFile(pageFile('verified body line\n'.repeat(40)));
    published.plan.dispose();
    const partsDir = partsDirFor(published.headPath);
    return { ...published, partsDir, first: join(dirname(published.headPath), published.parsed.manifest.parts[0]!.path) };
  }
  const incomplete = (sets: { missing?: string[]; extra?: string[]; mismatched?: string[] }) =>
    ({ ok: false as const, code: 'split_page_incomplete' as const, missing: sets.missing ?? [], extra: sets.extra ?? [], mismatched: sets.mismatched ?? [], reason: expect.any(String) as string });

  test('missing, mismatched, truncated and unlisted parts', async () => {
    const a = await fresh();
    const listed = a.parsed.manifest.parts.map(part => part.path);
    rmSync(a.first);
    expect(verifyParts(a.headPath, a.parsed)).toEqual(incomplete({ missing: [listed[0]!] }));
    const b = await fresh();
    writeFileSync(b.first, Buffer.from(readFileSync(b.first).toString('utf8').replace('v', 'V')));
    expect(verifyParts(b.headPath, b.parsed)).toEqual(incomplete({ mismatched: [listed[0]!] }));
    writeFileSync(b.first, readFileSync(b.first).subarray(1));
    expect(verifyParts(b.headPath, b.parsed)).toEqual(incomplete({ mismatched: [listed[0]!] }));
    const c = await fresh();
    writeFileSync(join(c.partsDir, 'stray.txt'), 'x');
    mkdirSync(join(c.partsDir, 'subdir'));
    expect(verifyParts(c.headPath, c.parsed)).toEqual(incomplete({ extra: ['.big-page.gbparts/stray.txt', '.big-page.gbparts/subdir'] }));
    const dest = await inHome(() => splitScratchPath());
    expect(reassemble(c.headPath, c.parsed, dest)).toMatchObject({ ok: false, code: 'split_page_incomplete' });
    expect(existsSync(dest)).toBe(false);
  });

  test('an in-flight atomic write stage in the parts directory is not extra; every other unlisted entry is, and the refusal names it', async () => {
    const a = await fresh();
    writeFileSync(atomicStagingPath(join(a.partsDir, '0099-deadbeef.gbpart')), 'the next version of a part');
    expect(verifyParts(a.headPath, a.parsed)).toMatchObject({ ok: true });
    const stagedDir = atomicStagingPath(join(a.partsDir, '0098-deadbeef.gbpart'));
    mkdirSync(stagedDir);
    writeFileSync(join(a.partsDir, '.not-a-stage.tmp.1234'), 'x');
    writeFileSync(join(a.partsDir, 'notes.txt'), 'x');
    const extra = ['.big-page.gbparts/.not-a-stage.tmp.1234', `.big-page.gbparts/${stagedDir.slice(a.partsDir.length + 1)}`, '.big-page.gbparts/notes.txt'].sort();
    expect(verifyParts(a.headPath, a.parsed)).toEqual(incomplete({ extra }));
    const refusal = screenSplitHead(a.headPath, 'notes/big-page.md', readFileSync(a.headPath, 'utf8'));
    expect(refusal?.message).toContain(`Move or delete the files the manifest does not list (${extra.join(', ')}), which git checkout leaves in place, and restore the listed parts from Git`);
    expect(gitHoldFix({ source_id: 'source-a', path: 'notes/big-page.md', code: 'split_page_incomplete', meta: {} as never }).user_message)
      .toContain('Move or delete any file in notes/.big-page.gbparts the manifest does not list');
  });

  test('a symlinked part, a part that is a directory and a symlinked parts directory are refused', async () => {
    const a = await fresh();
    const listed = a.parsed.manifest.parts.map(part => part.path);
    const copy = join(a.dir, 'copy.gbpart');
    writeFileSync(copy, readFileSync(a.first));
    rmSync(a.first);
    symlinkSync(copy, a.first);
    expect(verifyParts(a.headPath, a.parsed)).toEqual(incomplete({ mismatched: [listed[0]!] }));
    rmSync(a.first);
    mkdirSync(a.first);
    expect(verifyParts(a.headPath, a.parsed)).toEqual(incomplete({ mismatched: [listed[0]!] }));
    const b = await fresh();
    const moved = join(b.dir, 'elsewhere');
    rmSync(moved, { recursive: true, force: true });
    renameSync(b.partsDir, moved);
    symlinkSync(moved, b.partsDir);
    expect(verifyParts(b.headPath, b.parsed)).toEqual(incomplete({ mismatched: b.parsed.manifest.parts.map(part => part.path) }));
  });

  test('a missing parts directory, or a head renamed away from its parts, lists every part as missing', async () => {
    const a = await fresh();
    const listed = a.parsed.manifest.parts.map(part => part.path);
    rmSync(a.partsDir, { recursive: true });
    expect(verifyParts(a.headPath, a.parsed)).toEqual(incomplete({ missing: listed }));
    const b = await fresh();
    // Parts are looked for in the renamed head's own parts directory, by file name (paths.ts partPathFor).
    expect(verifyParts(join(dirname(b.headPath), 'renamed.md'), b.parsed)).toEqual(incomplete({ missing: listed.map(path => path.replace('.big-page.gbparts/', '.renamed.gbparts/')) }));
  });
});

describe('greedy cuts', () => {
  test('the documented cut rules', async () => {
    __setSplitLimitsForTests(SMALL);
    const line = (n: number) => 'w'.repeat(n - 1) + '\n';
    const cases: Array<[string, number[]]> = [
      [line(30).repeat(4) + 'end', [60, 63]],
      [line(30).repeat(5) + 'end', [60, 60, 33]],
      [line(100) + line(30) + 'x'.repeat(70), [100, 30, 70]],
      ['z'.repeat(300) + '\n', [128, 128, 45]],
      [line(64) + 'q'.repeat(65), [64, 65]],
    ];
    for (const [body, sizes] of cases) {
      const plan = await inHome(() => planSplit(chunked(Buffer.from('---\ntitle: x\n---\n' + body), [11]), { headPath: 'a.md' }));
      expect(plan.parts.map(part => part.bytes)).toEqual(sizes);
      plan.dispose();
    }
  });

  test('an append changes only the last part and may add parts; earlier names never change', async () => {
    __setSplitLimitsForTests(SMALL);
    const next = rng(42);
    for (let round = 0; round < 30; round++) {
      const base = pageFile(mixedText(round + 100, 300 + Math.floor(next() * 600))).slice(0, -1);
      const appended = base + mixedText(round + 900, 1 + Math.floor(next() * 400));
      const [before, after] = await inHome(() => Promise.all([planSplit(chunked(Buffer.from(base), [13]), { headPath: HEAD_REL }), planSplit(chunked(Buffer.from(appended), [5]), { headPath: HEAD_REL })]));
      const kept = before.manifest.parts.slice(0, -1);
      expect(after.manifest.parts.slice(0, kept.length)).toEqual(kept);
      expect(after.manifest.parts.length).toBeGreaterThanOrEqual(before.manifest.parts.length);
      before.dispose();
      after.dispose();
    }
  });

  test('names are deterministic: the same page plans the same head and parts', async () => {
    __setSplitLimitsForTests(SMALL);
    const file = Buffer.from(pageFile(mixedText(3, 900)));
    const [a, b] = await inHome(() => Promise.all([planSplit(chunked(file, [1]), { headPath: HEAD_REL }), planSplit(chunked(file, [500]), { headPath: '/elsewhere/big-page.md' })]));
    expect(a.head()).toBe(b.head());
    expect(a.manifest.parts.every((part, i) => part.path === `.big-page.gbparts/${String(i + 1).padStart(4, '0')}-${part.sha256.slice(0, 8)}.gbpart`)).toBe(true);
    a.dispose();
    b.dispose();
  });

  test('more parts than the limit is refused and leaves no staged copy', async () => {
    __setSplitLimitsForTests({ ...SMALL, partCountMax: 3 });
    const staged = () => readdirSync(splitStagingDir()).filter(name => name.startsWith(`${process.pid}-`));
    await inHome(async () => {
      const before = staged();
      await expect(planSplit(chunked(Buffer.from(pageFile('x'.repeat(60) + '\n'.repeat(1) + 'y\n'.repeat(200))), [64]), { headPath: HEAD_REL })).rejects.toMatchObject({ code: 'too_many_parts' });
      expect(staged()).toEqual(before);
    });
  });

  test('files the layout cannot hold', async () => {
    __setSplitLimitsForTests(SMALL);
    const plan = (text: string) => inHome(() => planSplit(chunked(Buffer.from(text), [4]), { headPath: HEAD_REL }));
    await expect(plan('no frontmatter\n'.repeat(10))).rejects.toMatchObject({ code: 'not_a_page_file' });
    await expect(plan('---\ntitle: x\n' + 'never closes\n'.repeat(10))).rejects.toMatchObject({ code: 'not_a_page_file' });
    await expect(plan('---\ntitle: x\n---\n')).rejects.toMatchObject({ code: 'body_empty' });
    await expect(plan('---\n' + 'k: v\n'.repeat(60_000) + '---\nbody\n')).rejects.toMatchObject({ code: 'frontmatter_too_large' });
    await expect(inHome(() => planSplit(chunked(Buffer.from(pageFile('x\n')), [4]), { headPath: 'notes/page.txt' }))).rejects.toMatchObject({ code: 'not_a_markdown_head' });
  });
});

describe('staged copy', () => {
  test('lives privately under the persistence home, serves part ranges, and dispose removes it', async () => {
    __setSplitLimitsForTests(SMALL);
    const file = Buffer.from(pageFile('staged body line\n'.repeat(30)));
    const plan = await inHome(() => planSplit(chunked(file, [9]), { headPath: HEAD_REL }));
    expect(dirname(plan.stagedPath)).toBe(join(home, '.gbrain', 'persistence', 'split-staging'));
    expect(plan.stagedPath).toMatch(new RegExp(`/${process.pid}-[0-9a-f-]{36}\\.page$`));
    expect(statSync(plan.stagedPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(plan.stagedPath)).mode & 0o777).toBe(0o700);
    const fm = Buffer.byteLength(plan.frontmatter);
    const parts = [];
    for (const part of plan.parts) {
      const content = await plan.partContent(engine, part);
      expect({ bytes: content.bytes, hash: content.hash }).toEqual({ bytes: part.bytes, hash: part.sha256 });
      parts.push(await collect(content.pieces(engine)));
    }
    expect(Buffer.concat(parts).equals(file.subarray(fm))).toBe(true);
    expect(sha(file.subarray(fm))).toBe(plan.manifest.content_hash);
    plan.dispose();
    plan.dispose();
    expect(existsSync(plan.stagedPath)).toBe(false);
  });

  test('the sweep removes leftovers of a gone process and old files, and keeps a live one', async () => {
    await inHome(() => {
      const dir = splitStagingDir();
      const gone = Bun.spawnSync(['true']).pid;
      const dead = join(dir, `${gone}-00000000-0000-4000-8000-000000000001.page`);
      const old = join(dir, `${process.pid}-00000000-0000-4000-8000-000000000002.reassembled`);
      const live = join(dir, `${process.pid}-00000000-0000-4000-8000-000000000003.page`);
      const other = join(dir, 'not-ours.txt');
      for (const path of [dead, old, live, other]) writeFileSync(path, 'x');
      utimesSync(old, new Date(0), new Date(0));
      expect(sweepSplitStaging()).toBeGreaterThanOrEqual(2);
      expect([dead, old, live, other].map(existsSync)).toEqual([false, false, true, true]);
      rmSync(live);
      rmSync(other);
    });
  });
});

describe('paths', () => {
  test('parts directory naming and its inverse', () => {
    expect(partsDirName('big-page.md')).toBe('.big-page.gbparts');
    expect(partsDirFor('notes/big-page.md')).toBe('notes/.big-page.gbparts');
    expect(partsDirFor('/abs/notes/big-page.md')).toBe('/abs/notes/.big-page.gbparts');
    expect(partsDirFor('top.md')).toBe('.top.gbparts');
    expect(() => partsDirName('page.txt')).toThrow(expect.objectContaining({ code: 'not_a_markdown_head' }));
    expect(() => partsDirName('.md')).toThrow(expect.objectContaining({ code: 'not_a_markdown_head' }));
    expect(headPathForPartsDir('notes/.big-page.gbparts')).toBe('notes/big-page.md');
    expect(headPathForPartsDir('notes/.big-page.gbparts/')).toBe('notes/big-page.md');
    expect(headPathForPartsDir('.top.gbparts')).toBe('top.md');
    expect(headPathForPartsDir('notes/big-page')).toBeNull();
    expect(headPathForPartsDir('notes/.gbparts')).toBeNull();
  });

  test('isPartPath: anything inside a parts directory, never a page', () => {
    expect(isPartPath('notes/.big-page.gbparts/0001-abcdef12.gbpart')).toBe(true);
    expect(isPartPath('.top.gbparts/0001-abcdef12.gbpart')).toBe(true);
    expect(isPartPath('notes/.big-page.gbparts/sub/x.md')).toBe(true);
    expect(isPartPath('notes/.big-page.gbparts')).toBe(false);
    expect(isPartPath('notes/big-page.md')).toBe(false);
    expect(isPartPath('notes/.gbparts/x.md')).toBe(false);
    expect(isPartPath('notes/big.gbparts/x.md')).toBe(false);
  });
});

describe('sync.max_file_bytes', () => {
  test('is a registered sync tunable', () => {
    expect(SPLIT_MAX_FILE_BYTES_KEY).toBe('sync.max_file_bytes');
    expect(KNOWN_CONFIG_KEYS).toContain('sync.max_file_bytes');
    expect(SYNC_TUNABLE_KEYS as readonly string[]).toContain('sync.max_file_bytes');
  });

  test('production limits', () => {
    expect([PART_TARGET_BYTES, PART_MAX_BYTES, LEAD_MAX_BYTES, PART_COUNT_MAX]).toEqual([8 * 1024 ** 2, 16 * 1024 ** 2, 64 * 1024, 9999]);
  });

  test.each([
    [null, 25_165_824], ['', 25_165_824], ['abc', 25_165_824], ['-5', 25_165_824], ['1.5', 25_165_824], ['1e7', 25_165_824],
    ['0', 1_048_576], ['1048575', 1_048_576], ['2097152', 2_097_152], [' 2097152 ', 2_097_152], ['26214400', 26_214_400],
    ['26214401', 26_214_400], ['99999999999999999999999', 26_214_400],
  ])('stored %p puts %p in effect', async (raw, expected) => {
    expect(parseSplitThreshold(raw)).toBe(expected);
    expect(await splitThresholdBytes({ getConfig: async key => (key === 'sync.max_file_bytes' ? raw : null) })).toBe(expected);
  });

  test('config set refuses a value outside 1 MiB to 25 MiB', () => {
    for (const ok of ['1048576', '2097152', '26214400']) expect(splitThresholdConfigRefusal(ok)).toBeNull();
    for (const bad of ['1048575', '26214401', 'abc', '-1', '2.5', '']) expect(splitThresholdConfigRefusal(bad)).toContain('nothing was written');
  });
});
