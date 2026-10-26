#!/usr/bin/env bash
# CI guard: fail if any non-serial unit test file violates intra-process
# isolation rules. The v0.26.4 parallel runner loads multiple test files
# into one bun process per shard; module-level state (env vars, PGLite
# engines, mock.module overrides) leaks across files in that process and
# silently flakes other tests.
#
# Rules enforced (non-serial unit test files only):
#  R1: no `process.env.X = ...`, `process.env['X'] = ...`,
#      `delete process.env.X`, `Object.assign(process.env, ...)`,
#      `Reflect.set(process.env, ...)` mutations. Use withEnv() helper or
#      rename the file to `*.serial.test.ts`.
#  R2: no `mock.module(...)` anywhere. Top-level module mocks affect every
#      other file in the same shard process. Rename to `*.serial.test.ts`.
#  R3: `new PGLiteEngine(` may only appear within ~50 lines following a
#      `beforeAll(` line. Engines created at module scope (or in describe
#      bodies) leak across files in the shard process.
#  R4: any file that creates `new PGLiteEngine(` must call `.disconnect(`
#      inside an `afterAll(` block. Without disconnect, engines leak across
#      file boundaries within a shard process.
#  R5: a file whose code calls `configureGateway(` must also call
#      `resetGateway(` in its code (normally from afterAll/afterEach). The
#      AI gateway is one object per process, so whatever a file configures
#      (embedding model and width, keys, base URLs) is still in force for
#      the next file the shard loads, and that file's PGLite schema is sized
#      from it: eval-canary once failed "expected 1280 dimensions, not 1536"
#      after a reshuffle ran a LiteLLM-configuring file first. Comments do
#      not count either way. A file whose only calls run inside a spawned
#      child's script string carries `isolation-lint: R5-subprocess-only`.
#  R6: a file whose code reads the CLI exit verdict (`currentExitCode(`)
#      must set its own baseline outside an after-hook: a
#      `_resetCliExitVerdictForTests(` or `setCliExitVerdict(0)` call in a
#      before-hook or before its run. The verdict is one value per process
#      and any command a test drives can leave it at 1 (doctor, remediate,
#      connectors sync), so a reset only in afterEach still reads the
#      previous file's verdict in its first test: edge-proposals-json-bigint
#      failed this way three times after a shard reshuffle.
#  R7: a file whose code calls `__unconfigureGatewayForTests(` or
#      `_clearGatewayForTests(` must call `resetGateway(` from an
#      afterEach/afterAll hook (or pass it as the hook: `afterEach(resetGateway)`).
#      An unconfigured gateway is process-global too: the next file's
#      beforeAll then sizes its PGLite schema from nothing, and a `-t`
#      filtered run or a throw before an inline restore leaves it empty.
#      Comments do not count either way (#6514).
#  R8: no scratch directory inside the source tree
#      (`join(import.meta.dir, '.tmp-...')`). Guards such as
#      test-reads-source-smell walk test/ in the same lane, and a scratch
#      directory created and removed by another file mid-walk fails them with
#      ENOENT (import-file.test.ts did this to test-reads-source-smell).
#      Use mkdtempSync(join(tmpdir(), '...')).
#  R9: a file that installs one of the process-global hooks below must undo
#      it from an afterEach/afterAll hook (an inline undo does not survive a
#      throw or a -t filter). Each installer patches console, stderr, signal
#      listeners or a module scope for the rest of the shard process: the
#      cli-socket output capture left by cli-socket.test.ts failed
#      cli-socket-context.test.ts in a shared shard (#7494), and the stdio
#      redirect left console.log bound to stderr. Comments do not count.
#        installOutputCapture( / startCliSocketServer(  -> _uninstallOutputCaptureForTests
#        redirectStdoutLoggingToStderr( / _resetStdoutRedirectForTests(  -> _resetStdoutRedirectForTests
#        installSigchldHandler(  -> _uninstallSigchldHandlerForTests
#
# Scope:
#  - Recursively scans `test/**/*.test.ts`.
#  - Skips `*.serial.test.ts` entirely (the quarantine escape hatch).
#  - Skips `test/e2e/**` (E2E runs sequentially in its own runner; not in
#    the parallel pool).
#
# Allow-list:
#  Files in `scripts/check-test-isolation.allowlist` (one filename per
#  line, # comments allowed) are skipped. This exists because v0.26.7
#  ships the lint as a foundation; v0.26.8 (env sweep) and v0.26.9
#  (PGLite sweep) remove entries as files get fixed. New files MUST NOT
#  be added — the allow-list shrinks over time, never grows.
#
# Usage: scripts/check-test-isolation.sh [TARGET_DIR]
#        scripts/check-test-isolation.sh --as-parallel FILE...
#   --as-parallel lints the named files (serial ones included) as if they
#   ran in the parallel pool: the check a *.serial.test.ts file must pass
#   before it rejoins the unit lane (scripts/serial-files.tsv).
# Exit:  0 when clean, 1 when un-allow-listed violations found.

set -euo pipefail

. "$(dirname "$0")/lib/guard-candidates.sh"

# GBRAIN_GUARD_ROOT (guard self-test): lint a fixture tree, whose unit files
# end in .test.fixture.ts so the real lint and `bun test` never collect them.
ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"
TEST_SUFFIX='.test.ts'
[ -n "${GBRAIN_GUARD_ROOT:-}" ] && TEST_SUFFIX='.test.fixture.ts'

AS_PARALLEL=0
if [ "${1:-}" = "--as-parallel" ]; then
  AS_PARALLEL=1
  shift
  [ "$#" -gt 0 ] || { echo "Usage: scripts/check-test-isolation.sh --as-parallel FILE..." >&2; exit 2; }
fi
TARGET_DIR="${1:-test}"
# When scanning the default root, also lint evals/**/*.test.ts — those files
# are collected into the CI matrix (scripts/test-shard.sh) and must obey the
# same isolation rules as everything else CI executes. An explicit TARGET_DIR
# argument (guard self-test fixtures) scans only itself.
EXTRA_DIRS=""
if [ "$TARGET_DIR" = "test" ] && [ -d evals ]; then
  EXTRA_DIRS="evals"
fi
ALLOWLIST_FILE="$ROOT/scripts/check-test-isolation.allowlist"

# Read allowlist (one filename per line, # comments allowed). Empty file
# is fine — every violation will fail. The scan below skips these exact
# paths.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

# Find non-serial unit test files (excluding test/e2e). Portable across
# bash 3.2 (macOS default) and bash 4+; no mapfile.
if [ "$AS_PARALLEL" = 1 ]; then
  FILE_LIST="$(printf '%s\n' "$@")"
else
FILE_LIST="$(find "$TARGET_DIR" $EXTRA_DIRS -name "*$TEST_SUFFIX" \
  -not -name "*.serial$TEST_SUFFIX" \
  -not -path "*/e2e/*" \
  -type f 2>/dev/null | sort)"
fi

ENV_MUTATION_PATTERN='process\.env\.[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=[^=]|process\.env\[[^]]+\][[:space:]]*=[^=]|delete[[:space:]]+process\.env\.|delete[[:space:]]+process\.env\[|Object\.assign[[:space:]]*\([[:space:]]*process\.env|Reflect\.set[[:space:]]*\([[:space:]]*process\.env'
MODULE_MOCK_PATTERN='mock\.module[[:space:]]*\('
ENGINE_PATTERN='new PGLiteEngine[[:space:]]*\('
GATEWAY_PATTERN='configureGateway[[:space:]]*\('
GATEWAY_OPT_OUT='isolation-lint: R5-subprocess-only'
VERDICT_PATTERN='currentExitCode[[:space:]]*\('
UNCONFIGURE_PATTERN='(__unconfigureGatewayForTests|_clearGatewayForTests)[[:space:]]*\('
# R8: a scratch path joined onto this file's own directory.
SOURCE_TREE_SCRATCH_PATTERN="(import\\.meta\\.dir(name)?|__dirname)[[:space:]]*,[[:space:]]*['\"\`]\\.?tmp[-_./'\"\`]"
# R9: installer pattern|restorer name, one pair per line.
PAIRED_RULES='installOutputCapture[[:space:]]*[(]|startCliSocketServer[[:space:]]*[(]|_uninstallOutputCaptureForTests
redirectStdoutLoggingToStderr[[:space:]]*[(]|_resetStdoutRedirectForTests[[:space:]]*[(]|_resetStdoutRedirectForTests
installSigchldHandler[[:space:]]*[(]|_uninstallSigchldHandlerForTests'
PAIRED_PATTERN='installOutputCapture[[:space:]]*[(]|startCliSocketServer[[:space:]]*[(]|redirectStdoutLoggingToStderr[[:space:]]*[(]|_resetStdoutRedirectForTests[[:space:]]*[(]|installSigchldHandler[[:space:]]*[(]'

# One awk process lints every candidate file: the patterns arrive through
# ENVIRON (never -v, which would rewrite their backslashes), the file names
# on stdin. Starting ten grep/awk processes per candidate and matching each
# path against the whole candidate list in bash took about 240 s for 2,000
# candidates under macOS bash 3.2, the verify cap (GBRA-135).
#
# R1, R2, R3, R4 and R8 read raw lines. R5 to R7 and R9 read code with
# comments removed: a block comment that opens at the start of a line (JSDoc
# included) is dropped through its closing */, and a // comment is dropped
# from the // to the end of the line when it follows the line start,
# whitespace or punctuation (so a URL's :// survives). Block comments opening
# mid-line are left alone: a glob such as 'test/*.ts' would otherwise swallow
# the rest of the file. R6, R7 and R9 track afterEach/afterAll blocks by brace
# depth from the hook's line: a reset there is no baseline for R6, and only a
# restore there (or on the hook line) counts for R7 and R9.
#
# Output: "V<TAB>rule<TAB>file<TAB>restorer" per violation, followed by up to
# three "L<TAB>line" records naming the offending lines.
ISOLATION_SCAN='
function emit(f, rule, extra, lines,   n, i, l) {
  printf "V\t%s\t%s\t%s\n", rule, f, extra
  n = split(lines, l, "\n")
  for (i = 1; i <= n && i <= 3; i++) if (l[i] != "") printf "L\t%s\n", l[i]
}
BEGIN {
  n = split(ENVIRON["ALLOWLIST"], a, "\n")
  for (i = 1; i <= n; i++) allow[a[i]] = 1
  npairs = split(ENVIRON["PAIRED_RULES"], rows, "\n")
  for (k = 1; k <= npairs; k++) {
    j = length(rows[k])
    while (j > 0 && substr(rows[k], j, 1) != "|") j--
    trig[k] = substr(rows[k], 1, j - 1)
    rest[k] = substr(rows[k], j + 1)
  }
  env_re = ENVIRON["ENV_MUTATION_PATTERN"]
  mock_re = ENVIRON["MODULE_MOCK_PATTERN"]
  engine_re = ENVIRON["ENGINE_PATTERN"]
  gateway_re = ENVIRON["GATEWAY_PATTERN"]
  opt_out = ENVIRON["GATEWAY_OPT_OUT"]
  verdict_re = ENVIRON["VERDICT_PATTERN"]
  unconfigure_re = ENVIRON["UNCONFIGURE_PATTERN"]
  scratch_re = ENVIRON["SOURCE_TREE_SCRATCH_PATTERN"]
}
{
  f = $0
  if (f == "" || (f in allow)) next
  env = mock = r3 = scratch = gw_calls = reads = un_calls = ""
  engine = after_all = disconnect = has_opt_out = 0
  gw_restored = baseline = un_restored = 0
  for (k = 1; k <= npairs; k++) { p_calls[k] = ""; p_restored[k] = 0 }
  last_before_all = -1000
  in_block = in_after = depth = 0
  nr = 0
  while ((getline line < f) > 0) {
    nr++
    if (line ~ env_re) env = env nr ":" line "\n"
    if (line ~ mock_re) mock = mock nr ":" line "\n"
    if (line ~ /beforeAll[[:space:]]*\(/) last_before_all = nr
    if (line ~ engine_re) {
      engine = 1
      if (nr - last_before_all > 50) r3 = r3 nr ":" line "\n"
    }
    if (line ~ /afterAll[[:space:]]*\(/) after_all = 1
    if (line ~ /\.disconnect[[:space:]]*\(/) disconnect = 1
    if (index(line, opt_out)) has_opt_out = 1
    if (line ~ scratch_re) scratch = scratch nr ":" line "\n"

    if (in_block) {
      if (index(line, "*/")) in_block = 0
      continue
    }
    if (line ~ /^[[:space:]]*\/\*/) {
      if (index(substr(line, index(line, "/*") + 2), "*/") == 0) in_block = 1
      continue
    }
    code = line
    sub(/(^|[[:space:];,(){}])\/\/.*$/, "", code)
    if (code ~ /resetGateway[[:space:]]*\(/) gw_restored = 1
    if (code ~ gateway_re) gw_calls = gw_calls nr ":" line "\n"
    opens = gsub(/\{/, "{", code); closes = gsub(/\}/, "}", code)
    if (in_after) {
      depth += opens - closes
      if (code ~ /resetGateway[[:space:]]*\(/) un_restored = 1
      for (k = 1; k <= npairs; k++) if (code ~ rest[k]) p_restored[k] = 1
      if (depth <= 0) in_after = 0
      continue
    }
    if (code ~ /after(Each|All)[[:space:]]*\(/) {
      if (code ~ /resetGateway/) un_restored = 1
      for (k = 1; k <= npairs; k++) if (code ~ rest[k]) p_restored[k] = 1
      depth = opens - closes
      if (depth > 0) in_after = 1
      continue
    }
    if (code ~ /_resetCliExitVerdictForTests[[:space:]]*\(|setCliExitVerdict[[:space:]]*\([[:space:]]*0[[:space:]]*\)/) baseline = 1
    if (code ~ /import/) continue
    if (code ~ verdict_re) reads = reads nr ":" line "\n"
    if (code ~ unconfigure_re) un_calls = un_calls nr ":" line "\n"
    for (k = 1; k <= npairs; k++) if (code ~ trig[k]) p_calls[k] = p_calls[k] nr ":" line "\n"
  }
  close(f)
  if (env != "") emit(f, "R1", "", env)
  if (mock != "") emit(f, "R2", "", mock)
  if (r3 != "") emit(f, "R3", "", r3)
  if (engine && !(after_all && disconnect)) emit(f, "R4", "", "")
  if (gw_calls != "" && !gw_restored && !has_opt_out) emit(f, "R5", "", gw_calls)
  if (reads != "" && !baseline) emit(f, "R6", "", reads)
  if (un_calls != "" && !un_restored) emit(f, "R7", "", un_calls)
  if (scratch != "") emit(f, "R8", "", scratch)
  for (k = 1; k <= npairs; k++) if (p_calls[k] != "" && !p_restored[k]) emit(f, "R9", rest[k], p_calls[k])
}
'
CANDIDATES="$(guard_candidates -E -e "$ENV_MUTATION_PATTERN" -e "$MODULE_MOCK_PATTERN" -e "$ENGINE_PATTERN" -e "$GATEWAY_PATTERN" -e "$VERDICT_PATTERN" -e "$UNCONFIGURE_PATTERN" -e "$SOURCE_TREE_SCRATCH_PATTERN" -e "$PAIRED_PATTERN" <<< "$FILE_LIST")"
file_count="$(printf '%s\n' "$FILE_LIST" | grep -c . || true)"
FINDINGS="$(printf '%s\n' "$CANDIDATES" | ALLOWLIST="$ALLOWLIST" PAIRED_RULES="$PAIRED_RULES" \
  ENV_MUTATION_PATTERN="$ENV_MUTATION_PATTERN" MODULE_MOCK_PATTERN="$MODULE_MOCK_PATTERN" \
  ENGINE_PATTERN="$ENGINE_PATTERN" GATEWAY_PATTERN="$GATEWAY_PATTERN" GATEWAY_OPT_OUT="$GATEWAY_OPT_OUT" \
  VERDICT_PATTERN="$VERDICT_PATTERN" UNCONFIGURE_PATTERN="$UNCONFIGURE_PATTERN" \
  SOURCE_TREE_SCRATCH_PATTERN="$SOURCE_TREE_SCRATCH_PATTERN" awk "$ISOLATION_SCAN")"

violations=0
TAB="$(printf '\t')"
while IFS= read -r record; do
  case "$record" in
    "L$TAB"*)
      printf '         %s\n' "${record#L$TAB}"
      continue
      ;;
    "V$TAB"*) ;;
    *) continue ;;
  esac
  record="${record#V$TAB}"
  rule="${record%%$TAB*}"
  record="${record#*$TAB}"
  f="${record%%$TAB*}"
  rest="${record#*$TAB}"
  case "$rule" in
    R1) detail="process.env mutation; use withEnv() or rename to *.serial.test.ts" ;;
    R2) detail="mock.module() leaks across files in the shard process; rename to *.serial.test.ts" ;;
    R3) detail="new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll" ;;
    R4) detail="creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process" ;;
    R5) detail="configureGateway() with no resetGateway(); the gateway is process-global, so this config reaches every later file in the shard. Add afterAll(() => resetGateway()) or rename to *.serial.test.ts" ;;
    R6) detail="currentExitCode() read with no baseline; the verdict is process-global, so the first test reads whatever the previous file in the shard left. Call _resetCliExitVerdictForTests() in beforeEach (or before the run it checks), not only in afterEach" ;;
    R7) detail="__unconfigureGatewayForTests()/_clearGatewayForTests() with no resetGateway() in an afterEach/afterAll hook; an empty gateway is process-global, so the next file's beforeAll sizes its schema from nothing. Add afterEach(() => resetGateway()) (an inline restore does not survive a throw or a -t filter) or rename to *.serial.test.ts" ;;
    R8) detail="scratch directory inside the source tree; tree walkers in the same lane (test-reads-source-smell) fail with ENOENT when it is created or removed mid-walk. Use mkdtempSync(join(tmpdir(), '...'))" ;;
    R9) detail="process-global hook installed with no $rest() in an afterEach/afterAll hook; it stays installed for every later file in the shard. Add afterEach(() => $rest()) or rename to *.serial.test.ts" ;;
  esac
  echo "ERROR: $f"
  echo "       rule $rule: $detail"
  violations=$((violations + 1))
done <<EOF
$FINDINGS
EOF

if [ $violations -gt 0 ]; then
  echo
  echo "check-test-isolation: FAIL ($violations violation(s))"
  echo
  echo "Fix:"
  echo "  - For env mutations, use withEnv() from test/helpers/with-env.ts"
  echo "  - For mock.module(), rename to *.serial.test.ts (quarantine)"
  echo "  - For PGLiteEngine, follow the canonical pattern in"
  echo "    test/helpers/reset-pglite.ts JSDoc and CLAUDE.md."
  echo "  - For configureGateway(), call resetGateway() in afterAll; it"
  echo "    puts back the preload's baseline gateway for the next file."
  echo "  - For currentExitCode(), reset the verdict in beforeEach (or right"
  echo "    before the run it checks) with _resetCliExitVerdictForTests()."
  echo "  - For __unconfigureGatewayForTests(), call resetGateway() in"
  echo "    afterEach or afterAll; it puts back the preload's baseline gateway."
  echo "  - For a scratch directory, use mkdtempSync(join(tmpdir(), '...'))."
  echo "  - For a process-global hook (R9), call its named undo from afterEach"
  echo "    or afterAll."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
