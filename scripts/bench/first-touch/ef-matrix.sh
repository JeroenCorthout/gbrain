#!/usr/bin/env bash
# scripts/bench/first-touch/ef-matrix.sh — end-to-end hnsw.ef_search sweep on the
# loaded brain (GBRA-156 follow-up, measurement only). For every ef value, the
# cold CLI and the warm socket each start from the same cold state (Postgres
# restart + dropped page cache), run the same queries first touch + repeats,
# with GBRAIN_BENCH_HNSW_EF_SEARCH overriding every vector attempt's ef
# ("code" = no override, what the code picks).
#   bash scripts/bench/first-touch/ef-matrix.sh OUT [EFS=code,40,64,100,200,code] [N=64] [REPEAT=2]
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
OUT=$1; EFS=${2:-code,40,64,100,200,code}; N=${3:-64}; REPEAT=${4:-2}
P="bun scripts/bench/first-touch/probe.ts --work $HOME/soak/work --queries $HOME/queries.json --pgss --embed-ms 150 --set A --limit $N --repeat $REPEAT"
E=scripts/bench/first-touch/env.sh
mkdir -p "$OUT"
i=0
for ef in ${EFS//,/ }; do
  i=$((i + 1)); envs=(); [ "$ef" = code ] || envs=(--env GBRAIN_BENCH_HNSW_EF_SEARCH=$ef)
  for path in cold socket; do
    bash $E pg cold >/dev/null
    echo "[ef-matrix] $i ef=$ef path=$path $(date -u +%T)"
    $P --path $path "${envs[@]}" --out "$OUT/$i-ef-$ef/$path" > "$OUT/$i-ef-$ef-$path.log" 2>&1
  done
done
echo "[ef-matrix] done"
