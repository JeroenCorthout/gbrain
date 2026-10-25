#!/usr/bin/env bash
# scripts/bench/first-touch/prewarm-measure.sh — GBRA-156 opt-in vector prewarm on the
# loaded soak brain, run with the prewarm branch's CLI checked out at PREWARM_REPO.
#   fit:   cold CLI first touch + repeat before, then a cold restart, the prewarm
#          (timed), and the same queries again; index buffers counted throughout.
#   nofit: the command must refuse; index buffers and index block reads before/after.
#   bash scripts/bench/first-touch/prewarm-measure.sh fit|nofit OUT [PREWARM_REPO=~/work/gbrain-prewarm]
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
ROLE=$1 O=$2 R=${3:-$HOME/work/gbrain-prewarm}
F=scripts/bench/first-touch
mkdir -p "$O"
psqlc() { docker exec -i soak-pg psql -h 127.0.0.1 -p 5434 -U postgres -d soak_brain -Atc "$1"; }
pw() { env -u DATABASE_URL -u GBRAIN_DATABASE_URL GBRAIN_HOME="$HOME/soak/work/home" GBRAIN_NO_UPDATE_CHECK=1 GBRAIN_TELEMETRY=0 GBRAIN_NO_BANNER=1 bun "$R/src/cli.ts" embeddings prewarm "$@"; }
idx() { psqlc "SELECT (SELECT count(*) FROM pg_buffercache b WHERE b.reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND b.relfilenode = pg_relation_filenode('idx_chunks_embedding')) AS buffers, (SELECT idx_blks_read + idx_blks_hit FROM pg_statio_user_indexes WHERE indexrelname = 'idx_chunks_embedding') AS blocks_touched, current_setting('shared_buffers') AS shared_buffers"; }
P="bun $F/probe.ts --work $HOME/soak/work --queries $HOME/queries.json --pgss --embed-ms 150 --set A --limit 64 --repeat 1 --path cold"
psqlc "CREATE EXTENSION IF NOT EXISTS pg_buffercache" >/dev/null
psqlc "CREATE EXTENSION IF NOT EXISTS pg_prewarm" >/dev/null
if [ "$ROLE" = nofit ]; then
  idx > "$O/index-before.txt"
  set +e; /usr/bin/time -f '%e s' -o "$O/refusal.time" bash -c "$(declare -f pw); R=$R; pw --json" > "$O/refusal.json" 2> "$O/refusal.stderr"; echo "exit=$?" > "$O/refusal.exit"; set -e
  sleep 2; idx > "$O/index-after.txt"
  pw --dry-run --json > "$O/dry-run.json" 2>&1 || true
  exit 0
fi
bash $F/env.sh pg cold >/dev/null
pw --dry-run --json > "$O/dry-run.json"
$P --out "$O/before" > "$O/before.log" 2>&1
bash $F/env.sh pg cold >/dev/null
idx > "$O/index-before-prewarm.txt"
/usr/bin/time -f '%e s wall' -o "$O/prewarm.time" bash -c "$(declare -f pw); R=$R; pw --json" > "$O/prewarm.json"
idx > "$O/index-after-prewarm.txt"
$P --out "$O/after" > "$O/after.log" 2>&1
idx > "$O/index-after-probe.txt"
echo "[prewarm-measure] done"
