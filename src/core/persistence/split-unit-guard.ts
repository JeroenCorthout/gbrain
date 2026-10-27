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
 *   applies to the head or a part, or core.autocrlf=true or core.eol=crlf would convert one that is not -text on checkout.
 * - `unit_diverged`: Git HEAD, the index and the disk hold different versions of the unit.
 * - `recovery_unit_changed`: recovery of a record that is not the strict door's own would change a unit.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../page-body/limits.ts';
import { assertNoPartsKey, isSplitHeadPath, parseHead, partFilePath, partsDirFor, splitPartOf, SplitLayoutError, verifyParts } from '../split-layout/index.ts';
import { git, gitFailure, gitReadOnly, PATHSPEC_FLAGS, rawBlobOid, withSession, type GitSession } from './effect-git.ts';
import { gitChildEnv } from '../git-env.ts';
import { spawnSync } from '../spawn.ts';

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
  /** The door's step: `publish` (before any write) also compares the unit's three states; `commit` checks only flags and conversion. */
  phase?: 'publish' | 'commit';
  /** A remote caller: the refusal names the page, never a path. */
  remote?: boolean;
}

const FRONTMATTER_PREFIX_BYTES = FRONTMATTER_HEAD_MAX_BYTES + 3;
const lenient = new TextDecoder('utf-8');
const toRel = (root: string, path: string) => relative(root, path).split(sep).join('/');
/** `root` resolved through symlinks, as unit paths are (splitUnitOf). */
const physicalRoot = (root: string) => { try { return realpathSync(root); } catch { return resolve(root); } };

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

/**
 * `path` resolved through symlinks: its parent directory (the nearest existing ancestor; the rest as named) and a leaf that
 * is itself a symlink, followed to what a write through it would reach, so an alias of a part names the part.
 */
function physicalPath(path: string, hops = 0): string {
  const abs = resolve(path), tail = [basename(abs)];
  let physical = abs;
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    try { physical = join(realpathSync(dir), ...tail); break; } catch { /* not on disk yet: resolve its parent */ }
    if (dirname(dir) === dir) break;
    tail.unshift(basename(dir));
  }
  return hops < 40 && lstatSync(physical, { throwIfNoEntry: false })?.isSymbolicLink() ? physicalPath(resolve(dirname(physical), readlinkSync(physical)), hops + 1) : physical;
}

/**
 * The split unit a path belongs to (the absolute physical head and parts directory), or null for a path that cannot be
 * in one. Its parent directory is resolved through symlinks, so an alias of a parts directory names the real unit, and a
 * part path is a unit path wherever it lies, inside the source root or not.
 */
export function splitUnitOf(path: string): { head: string; partsDir: string } | null {
  const physical = physicalPath(path), top = parse(physical).root;
  const part = splitPartOf(physical.slice(top.length).split(sep).join('/'));
  const head = part ? join(top, part.head) : physical;
  return isSplitHeadPath(head) ? { head, partsDir: partsDirFor(head) } : null;
}

/** gitReadOnly's environment (effect-git.ts GIT_ENV): no prompts, literal pathspecs, no optional locks, C locale. */
const READ_ONLY_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0',
  GIT_ICASE_PATHSPECS: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

/** gitReadOnly for a caller that cannot await: the same arguments, environment and 20 s deadline, with no session or hooks. */
function gitReadOnlySync(root: string, args: string[], pathspecs: 'literal' | 'icase' = 'literal'): { stdout: string; stderr: string; code: number } {
  const out = spawnSync('git', [...PATHSPEC_FLAGS[pathspecs], '-C', root, '-c', 'commit.gpgsign=false', ...args],
    { timeout: 20_000, maxBuffer: 1024 * 1024, env: gitChildEnv(READ_ONLY_GIT_ENV), encoding: 'utf8' });
  if (out.error || out.status === null) throw gitFailure('Git execution did not finish within its bounded attempt.',
    'A git command in the canonical checkout did not finish within 20 seconds or could not start.');
  return { stdout: out.stdout, stderr: out.stderr, code: out.status };
}

/** A read-only Git step: run at `cwd` by gitReadOnly or gitReadOnlySync; `icase` matches its pathspecs ignoring case, still without globs. */
type GitRead = { cwd: string; args: string[]; icase?: true };
type GitReadResult = { stdout: string; stderr: string; code: number };

/**
 * The work tree toplevel of the repository holding `dir` (physical): the nearest directory at or above it that holds
 * `.git` (a directory, or the gitfile of a linked worktree or submodule), found without spawning Git, or null.
 */
function gitHolder(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * The paths of `paths` in a split unit now: a path inside a parts directory, or a head whose parts directory exists on
 * disk or that declares gbrain_parts on disk, or whose parts directory HEAD or the index hold anything under. Git is read
 * at the toplevel of the repository holding each target (gitHolder), so a nested repository is read as itself, with one
 * read-only ls-files --with-tree=HEAD per repository (an unborn HEAD: the index alone).
 */
function* membersSteps(paths: readonly string[]): Generator<GitRead, Set<string>, GitReadResult> {
  const present = new Set<string>(), byTop = new Map<string, Map<string, string[]>>();
  for (const path of paths) {
    const unit = splitUnitOf(path);
    if (!unit) continue;
    if (splitUnitOnDisk(unit, path)) { present.add(path); continue; }
    const top = gitHolder(dirname(unit.head));
    if (!top) continue;
    const dirs = byTop.get(top) ?? new Map<string, string[]>(), dir = toRel(top, unit.partsDir);
    byTop.set(top, dirs.set(dir, [...dirs.get(dir) ?? [], path]));
  }
  for (const [top, dirs] of byTop) {
    let listed = yield { cwd: top, args: ['ls-files', '-z', '--with-tree=HEAD', '--', ...dirs.keys()], icase: true };
    if (listed.code !== 0 && listed.stderr.includes('tree-ish HEAD not found')) listed = yield { cwd: top, args: ['ls-files', '-z', '--', ...dirs.keys()], icase: true };
    if (listed.code !== 0) {
      if ((yield { cwd: top, args: ['rev-parse', '--is-inside-work-tree'] }).stdout.trim() !== 'true') continue;
      throw gitFailure('Cannot inspect the canonical Git target.', `git ls-files failed for ${[...dirs.keys()][0]}.`);
    }
    const folded: string[][] = [];
    for (const held of listed.stdout.split('\0').filter(Boolean)) {
      for (const [dir, heads] of dirs) {
        if (held.startsWith(`${dir}/`)) for (const path of heads) present.add(path);
        else if (held.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) folded.push(heads);
      }
    }
    if (folded.length && (yield { cwd: top, args: ['config', '--type=bool', '--default=false', 'core.ignorecase'] }).stdout.trim() === 'true') {
      for (const path of folded.flat()) present.add(path);
    }
  }
  return present;
}

async function runAsync<T>(steps: Generator<GitRead, T, GitReadResult>): Promise<T> {
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    step = steps.next(await gitReadOnly(step.value.cwd, step.value.args, step.value.icase ? 'icase' : 'literal'));
  }
}

function runSync<T>(steps: Generator<GitRead, T, GitReadResult>): T {
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    step = steps.next(gitReadOnlySync(step.value.cwd, step.value.args, step.value.icase ? 'icase' : 'literal'));
  }
}

/** The subset of `paths` (absolute) in a split unit now (membersSteps). */
export async function splitUnitMembers(paths: readonly string[]): Promise<Set<string>> {
  return runAsync(membersSteps(paths));
}

/** Whether the disk alone shows `path` in `unit`: it lies inside the parts directory, the parts directory exists, or the head declares gbrain_parts. */
function splitUnitOnDisk(unit: { head: string; partsDir: string }, path: string): boolean {
  return unit.head !== physicalPath(path) || existsSync(unit.partsDir) || headDeclaresParts(unit.head);
}

/** Whether `path` is in a split unit now (splitUnitMembers). */
export async function splitUnitPresent(path: string): Promise<boolean> {
  return (await splitUnitMembers([path])).size > 0;
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
const GIT_TRUE = new Set(['true', 'yes', 'on', '1']);

/**
 * Why Git would store, check out or diff a unit file as other bytes than it holds, or null: a text, eol, crlf, ident,
 * filter or working-tree-encoding attribute (any value but unset/unspecified), a diff driver with a textconv, or
 * core.autocrlf=true or core.eol=crlf, which convert a file on checkout unless it is explicitly -text. ident counts
 * although its clean direction leaves an unexpanded token alone: a checkout expands it.
 */
async function convertingAttribute(session: GitSession, rels: string[]): Promise<string | null> {
  const out = await git(session, ['check-attr', '-z', ...CONVERSION_ATTRIBUTES, '--', ...rels]);
  if (out.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git check-attr failed for the split unit of ${rels[0]}.`);
  const fields = out.stdout.split('\0'), binary = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i]!, attr = fields[i + 1]!, value = fields[i + 2]!;
    if (attr === 'text' && value === 'unset') binary.add(path);
    if (value === 'unspecified' || value === 'unset') continue;
    if (attr === 'diff' && (value === 'set' || (await git(session, ['config', '--get', `diff.${value}.textconv`])).code !== 0)) continue;
    return `${path} has the Git attribute ${attr}${value === 'set' ? '' : `=${value}`}`;
  }
  const [autocrlf, eol] = await Promise.all([git(session, ['config', '--get', 'core.autocrlf']), git(session, ['config', '--get', 'core.eol'])]);
  const config = GIT_TRUE.has(autocrlf.stdout.trim().toLowerCase()) ? 'core.autocrlf=true' : eol.stdout.trim().toLowerCase() === 'crlf' ? 'core.eol=crlf' : null;
  const exposed = config && rels.find(rel => !binary.has(rel));
  return exposed ? `Git would check ${exposed} out converted under ${config} (it is not -text)` : null;
}

/** The unit's head, its planned parts and everything in its parts directory on disk, relative to the physical root. */
function unitRels(root: string, unit: { head: string; partsDir: string }, planned: readonly string[]): string[] {
  const dir = lstatSync(unit.partsDir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(unit.partsDir).map(name => join(unit.partsDir, name)) : [];
  return [...new Set([unit.head, ...planned.map(physicalPath), ...dir].map(path => toRel(root, path)))];
}

/**
 * The one check every route runs before it writes, commits, removes or restores a path that may be in a split unit.
 * A route outside the door, a non-strict source and a recovery that is not the strict door's own refuse as soon as the
 * path is in a split unit (splitUnitPresent) or would lay one out (`planned`). The door of a strict source checks a unit
 * it publishes: no index flag on the head or its parts directory, no conversion attribute; before it writes
 * (`publish`, the default) Git HEAD, the index and the disk hold the same unit. A path that is not in a unit and lays none
 * out passes on every route.
 */
export async function assertSplitUnitMutable(input: SplitUnitGuardInput): Promise<void> {
  const unit = splitUnitOf(input.path);
  if (!unit) return;
  const planned = input.planned ?? [];
  if (input.route !== 'door' || !input.strict) {
    if (planned.length || await splitUnitPresent(input.path)) throw splitPageUnsupported(routeReason(input), input, unit);
    return;
  }
  if (!planned.length && !await splitUnitPresent(input.path)) return;
  const root = physicalRoot(input.root);
  if (toRel(root, unit.head).startsWith('../')) throw splitPageUnsupported('outside_door', input, unit, `${unit.head} resolves outside the source root`);
  await withSession(root, undefined, undefined, false, async session => {
    const rels = unitRels(root, unit, planned);
    const flagged = await flaggedIndexEntry(session, [toRel(root, unit.head), toRel(root, unit.partsDir)]);
    if (flagged) throw splitPageUnsupported('index_flag', input, unit, flagged);
    const attribute = await convertingAttribute(session, rels);
    if (attribute) throw splitPageUnsupported('git_attribute', input, unit, attribute);
    if (input.phase === 'commit') return;
    const diverged = splitUnitDivergence(await readSplitUnitLayers(session, root, unit.head));
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
 * refusal of each path in a split unit, keyed by path; a path absent from the map may be changed. `pages` (by absolute
 * path) names each path's source and page, so the refusal names the page and its fix names the source.
 */
export async function splitUnitRefusals(input: Omit<SplitUnitGuardInput, 'path' | 'planned' | 'phase'> & { paths: readonly string[];
  pages?: ReadonlyMap<string, Pick<SplitUnitGuardInput, 'sourceId' | 'slug'>> }): Promise<Map<string, OperationError>> {
  if (input.route === 'door' && input.strict) throw new Error('splitUnitRefusals is for routes other than the strict door');
  const refusals = new Map<string, OperationError>();
  for (const path of await splitUnitMembers(input.paths)) {
    refusals.set(path, splitPageUnsupported(routeReason(input), { ...input, ...input.pages?.get(path) }, splitUnitOf(path)!));
  }
  return refusals;
}

/**
 * The strict door's pin on every `.gitattributes` from `root` down to the parts directory of the split unit at `path`:
 * each path (absolute) to the SHA-256 of the bytes Git HEAD and the disk hold, or null when neither holds one. The split
 * commit names each as a DoorFile in that state, so a rule committed during the write fails the door's compare-and-swap
 * (git_target_changed). Taken before assertSplitUnitMutable reads the attributes; one that differs between HEAD and the
 * disk refuses `git_attribute` before anything is written.
 */
export async function splitAttributePins(input: Pick<SplitUnitGuardInput, 'root' | 'path' | 'slug' | 'sourceId' | 'remote'>): Promise<Map<string, string | null>> {
  const root = physicalRoot(input.root), unit = splitUnitOf(input.path)!, dirs = toRel(root, unit.partsDir).split('/');
  const rels = Array.from({ length: dirs.length + 1 }, (_, depth) => [...dirs.slice(0, depth), '.gitattributes'].join('/'));
  const [format, tree] = await Promise.all([gitReadOnly(root, ['rev-parse', '--show-object-format']), gitReadOnly(root, ['ls-tree', '-z', 'HEAD', '--', ...rels])]);
  if (format.code !== 0 || (tree.code !== 0 && !tree.stderr.includes('Not a valid object name'))) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-tree failed for the .gitattributes files above ${toRel(root, unit.head)}.`);
  const committed = new Map(tree.stdout.split('\0').filter(Boolean).map(record => [record.slice(record.indexOf('\t') + 1), record.slice(0, record.indexOf('\t')).split(' ')[2]!] as const));
  const pins = new Map<string, string | null>();
  for (const rel of rels) {
    const abs = join(input.root, rel), disk = lstatSync(abs, { throwIfNoEntry: false }) ? rawBlobOid(abs, format.stdout.trim() === 'sha256' ? 'sha256' : 'sha1') ?? 'not_a_file' : null;
    if ((committed.get(rel) ?? null) !== disk) throw splitPageUnsupported('git_attribute', input, unit, `${rel} differs between Git HEAD and the disk`);
    pins.set(abs, disk ? createHash('sha256').update(readFileSync(abs)).digest('hex') : null);
  }
  return pins;
}

/**
 * assertSplitUnitMutable for a route outside the door that must stay synchronous (skill tooling, the generic write
 * helpers, writers with no brain, local storage): refuses `outside_door` when `path` is in a split unit on disk, in the
 * index or in HEAD, read with the same single read-only Git step as the async form (gitReadOnlySync, no session).
 */
export function assertSplitUnitMutableSync(input: Omit<SplitUnitGuardInput, 'route' | 'strict' | 'planned' | 'phase'> & { route: Exclude<SplitUnitRoute, 'door' | 'git_effect' | 'recovery'> }): void {
  const unit = splitUnitOf(input.path);
  if (unit && runSync(membersSteps([input.path])).size) throw splitPageUnsupported('outside_door', input, unit);
}

/**
 * The check of gbrain git commit-push (git/commit-push.ts commitPaths), a route outside the door that commits what is on
 * disk, after `git add` and before the commit of `specs` (pathspecs relative to the checkout root `root`, which commit
 * --only takes from the working tree). A spec that reaches a split unit commits only a whole unit, every changed file of
 * it named: no unit file differs between the index and the disk, every unit file that differs from HEAD is under a spec,
 * and the unit on disk is whole (a head whose manifest parts verify and are exactly the files Git holds under its parts
 * directory, or a one-file head with nothing under it). Anything else refuses `outside_door` before the commit, so no
 * commit holds a head and parts that do not reassemble.
 */
export function assertStagedSplitUnitsWhole(root: string, specs: readonly string[]): Array<{ head: string; partsDir: string }> {
  const real = physicalRoot(root), units = new Map<string, { head: string; partsDir: string }>();
  const staged = gitReadOnlySync(real, ['diff', '--cached', '--no-renames', '--name-only', '-z', '--', ...specs]);
  if (staged.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', 'git diff --cached failed for the paths to commit.');
  for (const path of runSync(membersSteps(staged.stdout.split('\0').filter(Boolean).map(rel => join(real, rel))))) {
    const unit = splitUnitOf(path)!;
    units.set(unit.head, unit);
  }
  const named = (rel: string) => specs.some(spec => rel === spec || rel.startsWith(`${spec.replace(/\/+$/, '')}/`));
  for (const unit of units.values()) {
    const head = toRel(real, unit.head), dir = toRel(real, unit.partsDir);
    const reads = [['diff', '--name-only', '-z'], ['diff', '--cached', '--no-renames', '--name-only', '-z'], ['ls-files', '-z']]
      .map(args => gitReadOnlySync(real, [...args, '--', head, dir]));
    if (reads.some(read => read.code !== 0)) throw gitFailure('Cannot inspect the canonical Git target.', `git diff or git ls-files failed for the split unit of ${head}.`);
    const [unstaged, changed, listed] = reads.map(read => read.stdout.split('\0').filter(Boolean)) as [string[], string[], string[]];
    const held = listed.filter(rel => rel.startsWith(`${dir}/`));
    const left = unstaged[0] ?? changed.find(rel => !named(rel));
    const why = left ? `${left} would not be committed as the disk holds it; name the head and its parts directory together` : wholeUnitGap(real, unit, held);
    if (why) throw splitPageUnsupported('outside_door', { root: real }, unit, why);
  }
  return [...units.values()];
}

/**
 * Why `commit` does not hold each of `units` (from assertStagedSplitUnitsWhole) whole, or null: a split head with exactly
 * its manifest's parts under the parts directory, each blob of the manifest's length and SHA-256, or a one-file or
 * removed head with nothing there. git commit --only stages the paths again from the disk, and a pre-commit hook or a
 * conversion attribute can change what it stores after the check before the commit, so commit-push reads the commit.
 */
export function committedSplitUnitGap(root: string, units: ReadonlyArray<{ head: string; partsDir: string }>, commit: string): { unit: { head: string; partsDir: string }; why: string } | null {
  const real = physicalRoot(root);
  const blob = (oid: string, bytes: number) => {
    const out = spawnSync('git', ['-C', real, 'cat-file', 'blob', oid], { timeout: 120_000, maxBuffer: bytes + 1, env: gitChildEnv(READ_ONLY_GIT_ENV) });
    if (out.error || out.status !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git cat-file failed for blob ${oid} of a split unit in commit ${commit}.`);
    return out.stdout;
  };
  for (const unit of units) {
    const head = toRel(real, unit.head), dir = toRel(real, unit.partsDir);
    const tree = gitReadOnlySync(real, ['ls-tree', '-r', '-z', '-l', commit, '--', head, dir]);
    if (tree.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-tree failed for the split unit of ${head} in commit ${commit}.`);
    const entries = new Map(tree.stdout.split('\0').filter(Boolean).map(record => {
      const [, type, oid, size] = record.slice(0, record.indexOf('\t')).trim().split(/\s+/);
      return [record.slice(record.indexOf('\t') + 1), { type: type!, oid: oid!, bytes: Number(size) }] as const;
    }));
    const committedHead = entries.get(head);
    entries.delete(head);
    const parsed = committedHead?.type === 'blob' ? parseHead(blob(committedHead.oid, committedHead.bytes).toString('utf8')) : null;
    if (parsed && 'error' in parsed) return { unit, why: `${head} in commit ${commit.slice(0, 12)} is not a valid split head (${parsed.error.reason})` };
    const parts = parsed?.manifest.parts ?? [];
    if (entries.size !== parts.length) return { unit, why: `commit ${commit.slice(0, 12)} holds other files under ${dir} than ${head} lists` };
    for (const part of parts) {
      const rel = toRel(real, partFilePath(unit.head, part.path)), entry = entries.get(rel);
      if (entry?.type !== 'blob' || entry.bytes !== part.bytes || createHash('sha256').update(blob(entry.oid, entry.bytes)).digest('hex') !== part.sha256) {
        return { unit, why: `${rel} in commit ${commit.slice(0, 12)} does not hold the bytes the manifest of ${head} lists` };
      }
    }
  }
  return null;
}

/** Why the unit on disk is not whole, given the paths Git holds under its parts directory, or null. */
function wholeUnitGap(root: string, unit: { head: string; partsDir: string }, held: string[]): string | null {
  const parsed = existsSync(unit.head) ? parseHead(readFileSync(unit.head, 'utf8')) : null;
  if (!parsed) return held.length || existsSync(unit.partsDir) ? `${toRel(root, unit.head)} is one file but its parts directory still holds files` : null;
  if ('error' in parsed) return `${toRel(root, unit.head)} is not a valid split head (${parsed.error.reason})`;
  const verified = verifyParts(unit.head, parsed);
  if (!verified.ok) return `${toRel(root, unit.head)}'s parts do not verify (${verified.reason})`;
  const listed = parsed.manifest.parts.map(part => toRel(root, partFilePath(unit.head, part.path))).sort();
  return listed.join('\0') === [...held].sort().join('\0') ? null : `Git would hold other files under ${toRel(root, unit.partsDir)} than the manifest of ${toRel(root, unit.head)} lists`;
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
      suggestion: `Git would convert the bytes of ${page}'s split files${because}, so nothing was written or committed. A split page's head and parts are stored byte for byte (the head's manifest hashes them), so a text, eol, crlf, ident, filter or working-tree-encoding attribute, a diff textconv, core.autocrlf=true or core.eol=crlf on them would commit a page no checkout reassembles. Ask the user to narrow the rule so the head and its .gbparts directory get none of them (for example a later .gitattributes line giving those paths -text -eol -crlf -ident -filter -diff), commit it, then submit the write again with a new request_id.`,
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
  const root = physicalRoot(input.root);
  const paths = local ? [toRel(root, unit.head), toRel(root, unit.partsDir)] : undefined;
  const advice = splitPageUnsupportedAdvice(reason, { slug: input.slug, sourceId: input.sourceId, paths, why: local ? why : undefined });
  const subject = input.slug ? `page ${input.slug}` : local ? toRel(root, unit.head) : 'the page';
  return opError('split_page_unsupported', `split_page_unsupported (${reason}): the split page files of ${subject} cannot be changed by this route, so nothing was written.`,
    advice.suggestion, { reason, fix: advice.fix, docs: advice.docs });
}
