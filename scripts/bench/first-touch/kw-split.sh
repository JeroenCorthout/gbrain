#!/usr/bin/env bash
# scripts/bench/first-touch/kw-split.sh — the two keyword caps of GBRA-156 fix 5 measured
# separately: base, rank bound only (GBRAIN_BENCH_KEYWORD_RANK_CANDIDATES=10000) and
# OR-fallback cap only (GBRAIN_BENCH_OR_FALLBACK_MATCH_CAP=5000). ROUNDS rounds, arm order
# rotated each round, every arm from a Postgres restart + dropped page cache, cold CLI,
# each query first touch then REPEAT repeats.
#   bash scripts/bench/first-touch/kw-split.sh OUT [ROUNDS=5] [N=64] [REPEAT=1]
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
OUT=$1; ROUNDS=${2:-5}; N=${3:-64}; REPEAT=${4:-1}
P="bun scripts/bench/first-touch/probe.ts --work $HOME/soak/work --queries $HOME/queries.json --pgss --embed-ms 150 --set A --limit $N --repeat $REPEAT --path cold"
E=scripts/bench/first-touch/env.sh
ARMS=(base rank orcap)
envs_for() {
  case $1 in
    base) ;;
    rank) echo "--env GBRAIN_BENCH_KEYWORD_RANK_CANDIDATES=10000" ;;
    orcap) echo "--env GBRAIN_BENCH_OR_FALLBACK_MATCH_CAP=5000" ;;
  esac
}
mkdir -p "$OUT"
for r in $(seq 1 "$ROUNDS"); do
  for k in 0 1 2; do
    arm=${ARMS[$(( (k + r - 1) % 3 ))]}
    bash $E pg cold >/dev/null
    echo "[kw-split] round=$r arm=$arm $(date -u +%T)"
    # shellcheck disable=SC2046
    $P $(envs_for $arm) --out "$OUT/r$r/$arm" > "$OUT/r$r-$arm.log" 2>&1
  done
done
echo "[kw-split] done"
