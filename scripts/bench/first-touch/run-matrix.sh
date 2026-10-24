#!/usr/bin/env bash
# scripts/bench/first-touch/run-matrix.sh — one measurement matrix on the loaded
# brain (GBRA-156): cold CLI from a cold database, warm socket, and cold CLI with a
# Postgres restart before every query. Writes <out>/<cell>/calls.jsonl.
#   bash scripts/bench/first-touch/run-matrix.sh OUT [--env K=V ...]
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
OUT=$1; shift
P="bun scripts/bench/first-touch/probe.ts --work $HOME/soak/work --queries $HOME/queries.json --pgss --embed-ms 150 $*"
E=scripts/bench/first-touch/env.sh
mkdir -p "$OUT"
bash $E pg cold
$P --path cold --set A --limit 40 --repeat 2 --out "$OUT/cold-A" > "$OUT/cold-A.log" 2>&1
$P --path socket --set B --limit 40 --repeat 2 --out "$OUT/socket-B" > "$OUT/socket-B.log" 2>&1
$P --path cold --set D --offset 4 --limit 10 --repeat 1 --restart-each --out "$OUT/restart-D" > "$OUT/restart-D.log" 2>&1
echo "[matrix] done"
