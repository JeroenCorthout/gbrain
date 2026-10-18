#!/usr/bin/env bash
# GBRA-133 lane C probe (Phase 1, not shipped): one held file on a synthetic PGLite brain, walked through
# sync -> sync status -> sync unblock -> repair preview -> hash-bound apply -> next commit, printing what each step tells
# an agent to do next and whether the checkout is left dirty. Synthetic data only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${1:-$(mktemp -d)}"
export HOME="$WORK" GBRAIN_HOME="$WORK/.gbrain"
G=(bun run "$ROOT/src/cli.ts")
mkdir -p "$WORK/repo/people"
cd "$WORK/repo"
git init -q && git config user.email probe@example.com && git config user.name probe
printf -- '---\ntitle: Alice Example\n---\nAlice works at acme-example.\n' > people/alice-example.md
printf -- '---\ntitle: "unterminated\nfoo: [1, 2\n---\nBad file.\n' > people/bad.md
git add -A && git commit -qm init
cd "$ROOT"
"${G[@]}" init --pglite --no-embedding >/dev/null 2>&1
"${G[@]}" sources add probe --path "$WORK/repo" >/dev/null 2>&1
last() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=s.trim();let j;try{j=JSON.parse(t)}catch{j=JSON.parse(t.split("\n").pop())};console.log(JSON.stringify(new Function("j","return "+process.argv[1])(j)))})' "$1"; }
echo "sync:    $("${G[@]}" sync --source probe --no-pull --json 2>/dev/null | last '({outcome:j.outcome,held:j.held.map(h=>h.code),fix_has_next:"next" in (j.held[0]?.fix??{})})')"
echo "status:  $("${G[@]}" sync status --source probe --json 2>/dev/null | last '({state:j.state,reason:j.reason,next:j.next?.command,hold_fix:j.holds[0]?.fix?.command,hold_mcp:j.holds[0]?.fix?.mcp??null})')"
echo "unblock: $("${G[@]}" sync unblock --source probe --json 2>/dev/null | last '({applied:j.applied.length,refused:j.refused.map(r=>r.reason)})')"
HASH="$("${G[@]}" repair frontmatter --source probe --include-ambiguous --json 2>/dev/null | last 'j.results[0].preview_hash' | tr -d '"')"
echo "preview: hash=$HASH"
echo "apply:   $("${G[@]}" repair frontmatter --source probe --include-ambiguous --apply --expect "$HASH" --yes --json 2>/dev/null | last 'j.results[0].outcome_items?.[0]?.detail??null')"
echo "after apply, git status: $(git -C "$WORK/repo" status --short | tr '\n' ' ')"
printf -- '---\ntitle: Acme Example\n---\nacme-example is a company.\n' > "$WORK/repo/acme-example.md"
git -C "$WORK/repo" add acme-example.md && git -C "$WORK/repo" commit -qm acme
S=$(date +%s%N)
"${G[@]}" sync --source probe --no-pull --json >/dev/null 2>&1
echo "next commit: sync_ms=$(( ($(date +%s%N)-S)/1000000 )); git status: $(git -C "$WORK/repo" status --short | tr '\n' ' ')"
