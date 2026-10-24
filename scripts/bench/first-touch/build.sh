#!/usr/bin/env bash
# scripts/bench/first-touch/build.sh — build the production-shaped soak brain
# (GBRA-174 fixture + load) on the delayed data disk, without running a soak.
#   bash scripts/bench/first-touch/build.sh [--pages 600000] [--extract-budget-s 600]
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
PAGES=600000 EXTRACT=600
while [ $# -gt 0 ]; do
  case $1 in
    --pages) PAGES=$2; shift 2 ;;
    --extract-budget-s) EXTRACT=$2; shift 2 ;;
    *) echo "unknown $1" >&2; exit 2 ;;
  esac
done
ROOT=$HOME/soak
mkdir -p "$ROOT/out"
export SOAK_PG_VOLUME=/pgdata/pg
export SOAK_PG_SHARED_BUFFERS=8GB
t0=$(date +%s)
echo "[build] fixture $PAGES"
bun scripts/bench/production-soak/fixture.ts --out "$ROOT/fixture" --pages "$PAGES" --seed 7 > "$ROOT/out/fixture.log" 2>&1
echo "[build] load (+$(( $(date +%s) - t0 ))s)"
bun scripts/bench/production-soak/load.ts --fixture "$ROOT/fixture" --work "$ROOT/work" --extract-budget-s "$EXTRACT" > "$ROOT/out/load.log" 2>&1
echo "[build] done in $(( $(date +%s) - t0 ))s"
