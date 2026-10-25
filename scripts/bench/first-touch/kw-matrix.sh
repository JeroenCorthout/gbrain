#!/usr/bin/env bash
# scripts/bench/first-touch/kw-matrix.sh — keyword caps (GBRA-156 fix 5) with
# matched cache states: ROUNDS rounds, each running both arms (order alternates
# per round), every arm from a Postgres restart + dropped page cache, cold CLI,
# each query first touch (cold) then REPEAT warm repeats.
#   bash scripts/bench/first-touch/kw-matrix.sh OUT [ROUNDS=5] [N=64] [REPEAT=1]
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
OUT=$1; ROUNDS=${2:-5}; N=${3:-64}; REPEAT=${4:-1}
P="bun scripts/bench/first-touch/probe.ts --work $HOME/soak/work --queries $HOME/queries.json --pgss --embed-ms 150 --set A --limit $N --repeat $REPEAT --path cold"
E=scripts/bench/first-touch/env.sh
CAPS=(--env GBRAIN_BENCH_KEYWORD_RANK_CANDIDATES=10000 --env GBRAIN_BENCH_OR_FALLBACK_MATCH_CAP=5000)
mkdir -p "$OUT"
for r in $(seq 1 "$ROUNDS"); do
  arms="base caps"; [ $((r % 2)) -eq 0 ] && arms="caps base"
  for arm in $arms; do
    bash $E pg cold >/dev/null
    echo "[kw-matrix] round=$r arm=$arm $(date -u +%T)"
    if [ $arm = caps ]; then $P "${CAPS[@]}" --out "$OUT/r$r/$arm" > "$OUT/r$r-$arm.log" 2>&1
    else $P --out "$OUT/r$r/$arm" > "$OUT/r$r-$arm.log" 2>&1; fi
  done
done
echo "[kw-matrix] done"
