#!/usr/bin/env bash
# scripts/bench/first-touch/vm-pipeline.sh — one Ubicloud VM end to end for the
# GBRA-156 follow-up: bootstrap (Bun 1.4.4), delayed data disk, 600k soak brain,
# production-shaped Postgres, then the measurements for its role.
#   nofit: shared_buffers 8 GB (the 11 GB HNSW index does not fit); ef sweep,
#          keyword caps rerun, recall against an exact scan.
#   fit:   shared_buffers 26 GB in a 48 GB container; stops once the brain is
#          ready (the prewarm measurement runs from the prewarm branch).
#   setsid -f bash scripts/bench/first-touch/vm-pipeline.sh nofit|fit > ~/pipeline.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROLE=${1:?nofit|fit}
F=scripts/bench/first-touch
export PATH="$HOME/.bun/bin:$PATH"
psqlc() { docker exec -i soak-pg psql -h 127.0.0.1 -p 5434 -U postgres -d "${2:-postgres}" -Atc "$1"; }
t0=$(date +%s); step() { echo "[pipeline +$(( $(date +%s) - t0 ))s] $*"; }
step setup; BUN_VERSION=1.4.4 bash scripts/bench/production-soak/vm-setup.sh
step "bun $(bun --version)"
step disk; bash $F/vm-disk.sh create 400
step build; bash $F/build.sh --pages 600000
step "pg prod"; bash $F/env.sh pg prod
if [ "$ROLE" = fit ]; then
  psqlc "ALTER SYSTEM SET shared_buffers = '26GB'"
  docker update --memory 48g --memory-swap 48g soak-pg >/dev/null
  docker restart soak-pg >/dev/null; sleep 5
fi
psqlc "SHOW shared_buffers"
bash $F/env.sh net on 0.75
bash $F/env.sh disk 1
step queries; bun $F/queries.ts --work "$HOME/soak/work" --out "$HOME/queries.json"
psqlc "SELECT pg_size_pretty(pg_relation_size('idx_chunks_embedding')), pg_relation_size('idx_chunks_embedding')" soak_brain || true
step ready
[ "$ROLE" = nofit ] || exit 0
O=$HOME/bench-out; mkdir -p "$O"
step "ef code check"; bash $F/env.sh pg cold >/dev/null
bun $F/probe.ts --work "$HOME/soak/work" --queries "$HOME/queries.json" --embed-ms 150 --set B --limit 2 --repeat 0 --path cold --env GBRAIN_BENCH_EF_LOG=1 --out "$O/ef-code-check" > "$O/ef-code-check.log" 2>&1
step "ef matrix"; bash $F/ef-matrix.sh "$O/ef"
step "kw matrix"; bash $F/kw-matrix.sh "$O/kw"
step recall; bun $F/ef-recall.ts --work "$HOME/soak/work" --queries "$HOME/queries.json" --set A --n 64 --efs 40,64,100,200,250,500 --walk-limit 500 --max-scan-tuples 2000 --out "$O/ef-recall.json" > "$O/ef-recall.log" 2>&1
step done
