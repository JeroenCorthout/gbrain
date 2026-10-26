/**
 * Wave B PR 5 (option B): the one refusal predicate for any write, commit, removal or restoration of a split page's
 * files. A split page is a head file plus part files in `.<name>.gbparts/` beside it (split-layout/). Only the
 * strict publication door of a git-canonical source creates or changes one; every other route refuses outright on
 * any path in a split unit, and the door itself refuses a unit Git would not store byte for byte. Every refusal is
 * `split_page_unsupported` with one reason of SPLIT_UNSUPPORTED_REASONS, each with its own fix:
 *
 * - `non_strict_source`: the source is not git-canonical (a non-strict publication or its Git effect).
 * - `outside_door`: a writer, remover, connector, mirror or repair outside the publication door.
 * - `index_flag`: a unit path carries skip-worktree, assume-unchanged or intent-to-add in the index.
 * - `git_attribute`: a conversion attribute (text, eol, crlf, ident, filter, working-tree-encoding, a diff textconv)
 *   or core.autocrlf applies to the head or a part.
 * - `unit_diverged`: Git HEAD, the index and the disk hold different versions of the unit.
 * - `recovery_unit_changed`: recovery of a record that is not the strict door's own would change a unit.
 */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../page-body/limits.ts';
import { assertNoPartsKey, isSplitHeadPath, partsDirFor, splitPartOf, SplitLayoutError } from '../split-layout/index.ts';
import { git, gitFailure, rawBlobOid, withSession, type GitSession } from './effect-git.ts';

export const SPLIT_UNSUPPORTED_REASONS = ['non_strict_source', 'outside_door', 'index_flag', 'git_attribute', 'unit_diverged', 'recovery_unit_changed'] as const;
export type SplitUnsupportedReason = typeof SPLIT_UNSUPPORTED_REASONS[number];
export const isSplitUnsupportedReason = (value: unknown): value is SplitUnsupportedReason => (SPLIT_UNSUPPORTED_REASONS as readonly unknown[]).includes(value);

/** Who is about to change a unit path: the publication door, or a named route outside it. */
export type SplitUnitRoute = 'door' | 'git_effect' | 'recovery' | 'write_through' | 'remover' | 'connector' | 'mirror' | 'file_repair' | 'raw_writer';

export interface SplitUnitGuardInput {
  /** The canonical root (a Git worktree for the door; any directory for a route outside it). */
  root: string;
  /** Absolute path being written or removed: a head, a part, or anything inside a parts directory. */
  path: string;
  route: SplitUnitRoute;
  /** The source is git-canonical (binding.canonical_git === true). */
  strict: boolean;
  sourceId?: string;
  slug?: string;
  /** The door's planned part paths (absolute) for a publication that lays the page out as a split unit. */
  planned?: readonly string[];
  /** The door's step: `publish` (before any write) also compares the unit's three states; `commit` checks what it commits. */
  phase?: 'publish' | 'commit';
  /** A remote caller: the refusal names the page, never a path. */
  remote?: boolean;
}

const FRONTMATTER_PREFIX_BYTES = FRONTMATTER_HEAD_MAX_BYTES + 3;
const lenient = new TextDecoder('utf-8');
const toRel = (root: string, path: string) => relative(root, path).split(sep).join('/');

/** Whether leading bytes of a file declare a top-level `gbrain_parts` key: the head of a split page. */
export function declaresPartsKey(prefix: Uint8Array): boolean {
  const text = lenient.decode(prefix);
  try { assertNoPartsKey(text.startsWith('\uFEFF') ? text.slice(1) : text); return false; }
  catch (error) { if (error instanceof SplitLayoutError) return true; throw error; }
}

function headDeclaresParts(path: string): boolean {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
  const fd = openSync(path, 'r'), prefix = Buffer.alloc(FRONTMATTER_PREFIX_BYTES);
  try { return declaresPartsKey(prefix.subarray(0, readSync(fd, prefix, 0, prefix.length, 0))); } finally { closeSync(fd); }
}

/** The split unit a path belongs to (absolute head and parts directory), or null for a path that cannot be in one. */
export function splitUnitOf(root: string, path: string): { head: string; partsDir: string } | null {
  const rel = toRel(root, path);
  const part = rel && !rel.startsWith('..') ? splitPartOf(rel) : null;
  const head = part ? join(root, part.head) : path;
  return isSplitHeadPath(head) ? { head, partsDir: partsDirFor(head) } : null;
}

async function insideWorkTree(session: GitSession): Promise<boolean> {
  const out = await git(session, ['rev-parse', '--is-inside-work-tree']);
  return out.code === 0 && out.stdout.trim() === 'true';
}

/**
 * The subset of `paths` (absolute) in a split unit now: a path inside a parts directory, or a head whose parts directory
 * exists on disk or that declares gbrain_parts on disk, or (in a Git worktree, one ls-files and one ls-tree for all of
 * them) whose parts directory HEAD or the index hold anything under.
 */
export async function splitUnitMembers(root: string, paths: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>(), byDir = new Map<string, string[]>();
  for (const path of paths) {
    const unit = splitUnitOf(root, path);
    if (!unit) continue;
    if (unit.head !== path || existsSync(unit.partsDir) || headDeclaresParts(unit.head)) { present.add(path); continue; }
    const dir = toRel(root, unit.partsDir);
    byDir.set(dir, [...byDir.get(dir) ?? [], path]);
  }
  if (!byDir.size || !existsSync(root)) return present;
  await withSession(root, undefined, undefined, false, async session => {
    if (!await insideWorkTree(session)) return;
    const dirs = [...byDir.keys()];
    const born = (await git(session, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).code === 0;
    const [index, tree] = await Promise.all([git(session, ['ls-files', '-z', '--', ...dirs]),
      born ? git(session, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...dirs]) : Promise.resolve({ code: 0, stdout: '', stderr: '' })]);
    if (index.code !== 0 || tree.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-files or git ls-tree failed for ${dirs[0]}.`);
    for (const held of [...index.stdout.split('\0'), ...tree.stdout.split('\0')].filter(Boolean)) {
      for (const [dir, heads] of byDir) if (held.startsWith(`${dir}/`)) for (const path of heads) present.add(path);
    }
  });
  return present;
}

/** Whether `path` is in a split unit now (splitUnitMembers). */
export async function splitUnitPresent(root: string, path: string): Promise<boolean> {
  return (await splitUnitMembers(root, [path])).size > 0;
}

/** A split page's unit in its three states: path (relative, `/`-separated) to blob id, raw bytes on disk. */
export interface SplitUnitLayers { head: string; partsDir: string; committed: Map<string, string>; staged: Map<string, string>; disk: Map<string, string>; unmerged: string[] }

/** The unit at `head` (absolute) as Git HEAD, the index and the disk hold it; the disk is hashed raw (rawBlobOid), so a clean filter never hides a change. */
export async function readSplitUnitLayers(session: GitSession, root: string, head: string): Promise<SplitUnitLayers> {
  const headRel = toRel(root, head), partsDir = toRel(root, partsDirFor(head));
  const [format, born] = await Promise.all([git(session, ['rev-parse', '--show-object-format']), git(session, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])]);
  const [tree, index] = await Promise.all([born.code === 0 ? git(session, ['ls-tree', '-r', '-z', 'HEAD', '--', headRel, partsDir]) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    git(session, ['ls-files', '-s', '-z', '--', headRel, partsDir])]);
  if (format.code !== 0 || tree.code !== 0 || index.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-tree or git ls-files failed for the split unit of ${headRel}.`);
  const layers: SplitUnitLayers = { head: headRel, partsDir, committed: new Map(), staged: new Map(), disk: new Map(), unmerged: [] };
  for (const record of tree.stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), [, type, oid] = record.slice(0, tab).split(' ');
    layers.committed.set(record.slice(tab + 1), type === 'blob' ? oid! : `${type}:${oid}`);
  }
  for (const record of index.stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), [, oid, stage] = record.slice(0, tab).split(' '), path = record.slice(tab + 1);
    if (stage === '0') layers.staged.set(path, oid!); else layers.unmerged.push(path);
  }
  const algorithm = format.stdout.trim() === 'sha256' ? 'sha256' : 'sha1';
  const headOid = rawBlobOid(head, algorithm);
  if (headOid) layers.disk.set(headRel, headOid);
  const dir = join(root, partsDir);
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const name of readdirSync(dir)) layers.disk.set(`${partsDir}/${name}`, rawBlobOid(join(dir, name), algorithm) ?? 'not_a_file');
  }
  return layers;
}

/**
 * Why HEAD, the index and the disk do not hold the same split unit, or null when they do. Every path under the parts
 * directory must be the same blob in all three (present in all or in none); the head must be too once any of the three
 * holds a part. A plain page (no part in any state) is not compared.
 */
export function splitUnitDivergence(layers: SplitUnitLayers): string | null {
  if (layers.unmerged.length) return `${layers.unmerged[0]} has unmerged entries in the index`;
  const paths = [...new Set([...layers.committed.keys(), ...layers.staged.keys(), ...layers.disk.keys()])].sort();
  if (!paths.some(path => path !== layers.head)) return null;
  const state = (oid: string | null, committed: string | null) => oid === null ? 'does not hold it' : oid === committed ? 'holds the committed bytes' : 'holds other bytes';
  for (const path of paths) {
    const committed = layers.committed.get(path) ?? null, staged = layers.staged.get(path) ?? null, disk = layers.disk.get(path) ?? null;
    if (committed === staged && staged === disk) continue;
    return `${path}: Git HEAD ${committed === null ? 'does not hold it' : 'holds it'}, the index ${state(staged, committed)}, the disk ${disk === 'not_a_file' ? 'holds something that is not a file' : state(disk, committed)}`;
  }
  return null;
}

const SKIP_WORKTREE = 0x40000000, INTENT_TO_ADD = 0x20000000, ASSUME_UNCHANGED = 0x8000;

/** Why a unit path's index entry is skip-worktree, assume-unchanged or intent-to-add (ls-files --debug flags), or null. */
async function flaggedIndexEntry(session: GitSession, rels: string[]): Promise<string | null> {
  const out = await git(session, ['ls-files', '--debug', '-z', '--', ...rels]);
  if (out.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-files failed for the split unit of ${rels[0]}.`);
  const tokens = out.stdout.split('\0');
  let path = tokens[0] ?? '';
  for (const token of tokens.slice(1)) {
    const lines = token.split('\n'), flags = Number.parseInt(/flags: ([0-9a-f]+)/.exec(lines.slice(0, 5).join('\n'))?.[1] ?? '0', 16);
    const flag = flags & SKIP_WORKTREE ? 'skip-worktree' : flags & ASSUME_UNCHANGED ? 'assume-unchanged' : flags & INTENT_TO_ADD ? 'intent-to-add' : null;
    if (flag) return `${path} is marked ${flag} in the index`;
    path = lines.slice(5).join('\n');
  }
  return null;
}

const CONVERSION_ATTRIBUTES = ['text', 'eol', 'crlf', 'ident', 'filter', 'working-tree-encoding', 'diff'];

/**
 * Why Git would store, check out or diff a unit file as other bytes than it holds, or null: a text, eol, crlf, ident,
 * filter or working-tree-encoding attribute (any value but unset/unspecified), or a diff driver with a textconv.
 * ident counts although its clean direction leaves an unexpanded token alone: a checkout expands it.
 */
async function convertingAttribute(session: GitSession, rels: string[]): Promise<string | null> {
  const out = await git(session, ['check-attr', '-z', ...CONVERSION_ATTRIBUTES, '--', ...rels]);
  if (out.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git check-attr failed for the split unit of ${rels[0]}.`);
  const fields = out.stdout.split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i]!, attr = fields[i + 1]!, value = fields[i + 2]!;
    if (value === 'unspecified' || value === 'unset') continue;
    if (attr === 'diff' && (value === 'set' || (await git(session, ['config', '--get', `diff.${value}.textconv`])).code !== 0)) continue;
    return `${path} has the Git attribute ${attr}${value === 'set' ? '' : `=${value}`}`;
  }
  return null;
}

/** What Git's clean path does without an attribute (core.autocrlf): `hash-object` must be each file's raw blob id. */
async function convertedOnCommit(session: GitSession, root: string, rels: string[]): Promise<string | null> {
  const present = rels.filter(rel => lstatSync(join(root, rel), { throwIfNoEntry: false })?.isFile());
  if (!present.length) return null;
  const [format, hashed] = await Promise.all([git(session, ['rev-parse', '--show-object-format']), git(session, ['hash-object', '--', ...present])]);
  const oids = hashed.stdout.split('\n').filter(Boolean);
  if (format.code !== 0 || hashed.code !== 0 || oids.length !== present.length) throw gitFailure('Cannot hash the canonical Git target.', `git hash-object failed for the split unit of ${present[0]}.`);
  const algorithm = format.stdout.trim() === 'sha256' ? 'sha256' : 'sha1';
  const converted = present.find((rel, index) => rawBlobOid(join(root, rel), algorithm) !== oids[index]);
  return converted ? `Git would store ${converted} as other bytes than the file holds (core.autocrlf or another conversion)` : null;
}

/** The unit's head, its planned parts and everything in its parts directory on disk, relative to the root. */
function unitRels(root: string, unit: { head: string; partsDir: string }, planned: readonly string[]): string[] {
  const dir = lstatSync(unit.partsDir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(unit.partsDir).map(name => join(unit.partsDir, name)) : [];
  return [...new Set([unit.head, ...planned, ...dir].map(path => toRel(root, path)))];
}

/**
 * The one check every route runs before it writes, commits, removes or restores a path that may be in a split unit.
 * A route outside the door, a non-strict source and a recovery that is not the strict door's own refuse as soon as the
 * path is in a split unit (splitUnitPresent) or would lay one out (`planned`). The door of a strict source checks a unit
 * it publishes: no index flag on the head or its parts directory, no conversion attribute; before it writes
 * (`publish`, the default) Git HEAD, the index and the disk hold the same unit; when it commits (`commit`) every file
 * hashes to its raw bytes. A path that is not in a unit and lays none out passes on every route.
 */
export async function assertSplitUnitMutable(input: SplitUnitGuardInput): Promise<void> {
  const unit = splitUnitOf(input.root, input.path);
  if (!unit) return;
  const planned = input.planned ?? [];
  if (input.route !== 'door' || !input.strict) {
    if (planned.length || await splitUnitPresent(input.root, input.path)) throw splitPageUnsupported(routeReason(input), input, unit);
    return;
  }
  if (!planned.length && !await splitUnitPresent(input.root, input.path)) return;
  await withSession(input.root, undefined, undefined, false, async session => {
    const rels = unitRels(input.root, unit, planned);
    const flagged = await flaggedIndexEntry(session, [toRel(input.root, unit.head), toRel(input.root, unit.partsDir)]);
    if (flagged) throw splitPageUnsupported('index_flag', input, unit, flagged);
    const attribute = await convertingAttribute(session, rels) ?? (input.phase === 'commit' ? await convertedOnCommit(session, input.root, rels) : null);
    if (attribute) throw splitPageUnsupported('git_attribute', input, unit, attribute);
    if (input.phase === 'commit') return;
    const diverged = splitUnitDivergence(await readSplitUnitLayers(session, input.root, unit.head));
    if (diverged) throw splitPageUnsupported('unit_diverged', input, unit, diverged);
  });
}

/** Why a route other than the strict door refuses a unit path: recovery, a non-strict source (its door or Git effect), or outside the door. */
function routeReason(input: Pick<SplitUnitGuardInput, 'route' | 'strict'>): SplitUnsupportedReason {
  if (input.route === 'recovery') return 'recovery_unit_changed';
  return (input.route === 'door' || input.route === 'git_effect') && !input.strict ? 'non_strict_source' : 'outside_door';
}

/**
 * assertSplitUnitMutable for many paths of one root on a route other than the strict door (a Git effect group): the
 * refusal of each path in a split unit, keyed by path; a path absent from the map may be changed.
 */
export async function splitUnitRefusals(input: Omit<SplitUnitGuardInput, 'path' | 'planned' | 'phase'> & { paths: readonly string[] }): Promise<Map<string, OperationError>> {
  if (input.route === 'door' && input.strict) throw new Error('splitUnitRefusals is for routes other than the strict door');
  const refusals = new Map<string, OperationError>();
  for (const path of await splitUnitMembers(input.root, input.paths)) refusals.set(path, splitPageUnsupported(routeReason(input), input, splitUnitOf(input.root, path)!));
  return refusals;
}

const DOCS = 'docs/guides/write-refusals.md#split_page_unsupported';
const statusArgv = (sourceId?: string) => ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'];

/**
 * What to do about a split_page_unsupported refusal with `reason`: its suggestion, fix and docs, for the refusal and for a
 * receipt's envelope (service.ts writeResponse). `paths` (the head and its parts directory) only for a local caller.
 */
export function splitPageUnsupportedAdvice(reason: SplitUnsupportedReason, ctx: { slug?: string; sourceId?: string; paths?: string[]; why?: string }): { suggestion: string; fix: Action; docs: string } {
  const page = ctx.slug ? `page ${ctx.slug}` : 'the page';
  const where = ctx.paths?.join(' ') ?? `the head file of ${page} and its .gbparts directory`;
  const because = ctx.why ? ` (${ctx.why})` : '';
  const userFix = (why: string, user_message: string): Action => ({ ask_user: true, actor: 'user', consent: [], requires_exclusive: false, why, user_message, verify: { argv: statusArgv(ctx.sourceId) } });
  const statusFix = (why: string): Action => readFix(why, { argv: statusArgv(ctx.sourceId) });
  switch (reason) {
    case 'non_strict_source': return { docs: DOCS,
      suggestion: `${page} is a split page (a head plus part files), and only the publication door of a git-canonical source (canonical: git) writes, commits or removes a split page's files; this source is not git-canonical, so nothing was written${because}. Ask the user whether to make the source git-canonical, or to restore the page to one file by hand and commit it with gbrain git commit-push; then submit the write again with a new request_id.`,
      fix: userFix('Only a git-canonical source writes split pages; whether this source becomes git-canonical, or the page goes back to one file, is the user\'s decision.',
        `${page} is stored as a split page, which only a git-canonical source can write. Should the source get canonical: git in its gbrain.yml, or should the page be restored to one file by hand and committed?`) };
    case 'outside_door': return { docs: DOCS,
      suggestion: `${page} is a split page (a head plus part files), and only the publication door writes, commits or removes its files; this writer is outside the door, so nothing changed in the files or the database${because}. Write or delete the page with put_page or delete_page on its git-canonical source, or change how it is stored with gbrain pages split-storage, which previews before --apply.`,
      fix: ctx.slug ? readFix('Previews how the page is stored on disk (one file, or a head plus part files) and what --apply would write, read-only.',
        { argv: ['gbrain', 'pages', 'split-storage', ctx.slug, ...(ctx.sourceId ? ['--source', ctx.sourceId] : []), '--json'] })
        : statusFix('Shows the source\'s canonical owner, whose publication door writes split pages, read-only.') };
    case 'index_flag': return { docs: DOCS,
      suggestion: `A file of ${page}'s split unit carries an index flag (skip-worktree, assume-unchanged or intent-to-add)${because}, so Git would not commit what the disk holds and nothing was written. Ask the user to clear it (git update-index --no-skip-worktree --no-assume-unchanged -- ${where}, or git rm --cached for an intent-to-add entry), then submit the write again with a new request_id.`,
      fix: userFix('A flagged index entry makes Git commit or skip other bytes than the disk holds; clearing it changes the user\'s checkout.',
        `A file of ${page}'s split unit is flagged in the Git index (skip-worktree, assume-unchanged or intent-to-add). May the flag be cleared with git update-index --no-skip-worktree --no-assume-unchanged on ${where}?`) };
    case 'git_attribute': return { docs: DOCS,
      suggestion: `Git would convert the bytes of ${page}'s split files${because}, so nothing was written or committed. A split page's head and parts are stored byte for byte (the head's manifest hashes them), so a text, eol, crlf, ident, filter or working-tree-encoding attribute, a diff textconv or core.autocrlf on them would commit a page no checkout reassembles. Ask the user to narrow the rule so the head and its .gbparts directory get none of them (for example a later .gitattributes line giving those paths -text -eol -crlf -ident -filter -diff), commit it, then submit the write again with a new request_id.`,
      fix: statusFix('Shows the source\'s canonical owner with its pending, failed and parked writes, read-only.') };
    case 'unit_diverged': return { docs: DOCS,
      suggestion: `The split page files of ${page} were changed outside gbrain and not committed${because}, so Git HEAD, the index and the disk hold different versions of the page and nothing was written. Ask the user which version is right: commit the hand edit with gbrain git commit-push -m "Commit the split page edit" -- ${where}, or restore the head and its parts from HEAD (git restore --staged --worktree --source=HEAD -- ${where}); then run gbrain sync${ctx.sourceId ? ` --source ${ctx.sourceId}` : ''} --no-pull and submit the write again with a new request_id.`,
      fix: statusFix('Shows the source\'s canonical owner with its pending and failed write requests, read-only.') };
    case 'recovery_unit_changed': return { docs: DOCS,
      suggestion: `Recovery of a write to ${page} would change its split unit, which only the strict door's own recovery record may do${because}, so recovery stopped without touching any file and the request stays recovering. Tell the user; the files stay as they are until they decide how the page should look.`,
      fix: statusFix('Shows the recovering request with its blocked reason, read-only.') };
  }
}

/** The split_page_unsupported refusal with `reason` for `unit`; a remote caller's names the page, never a path. */
export function splitPageUnsupported(reason: SplitUnsupportedReason, input: Pick<SplitUnitGuardInput, 'root' | 'slug' | 'sourceId' | 'remote'>,
  unit: { head: string; partsDir: string }, why?: string): OperationError {
  const local = !input.remote;
  const paths = local ? [toRel(input.root, unit.head), toRel(input.root, unit.partsDir)] : undefined;
  const advice = splitPageUnsupportedAdvice(reason, { slug: input.slug, sourceId: input.sourceId, paths, why: local ? why : undefined });
  const subject = input.slug ? `page ${input.slug}` : local ? toRel(input.root, unit.head) : 'the page';
  return opError('split_page_unsupported', `split_page_unsupported (${reason}): the split page files of ${subject} cannot be changed by this route, so nothing was written.`,
    advice.suggestion, { reason, fix: advice.fix, docs: advice.docs });
}
