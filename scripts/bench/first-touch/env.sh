#!/usr/bin/env bash
# scripts/bench/first-touch/env.sh — the production-shaped environment for the
# first-touch lane (GBRA-156) around the loaded soak brain.
#
#   env.sh net on [ONE_WAY_MS=0.75] | net off   # tc netem on loopback for the two pooler lanes (toxiproxy ports), RTT = 2 x ONE_WAY
#   env.sh pg prod                              # Postgres like the production database: 8 vCPU, 32 GB (page cache included),
#                                               # shared_buffers 8GB, track_io_timing, pg_stat_statements.track_planning
#   env.sh pg cold                              # restart Postgres and the bouncers, drop the page cache
#   env.sh explain on [MIN_MS=0] | explain off  # auto_explain (ANALYZE, BUFFERS, TIMING) for new sessions on soak_brain
#   env.sh disk READ_MS                         # read latency of the Postgres data disk (vm-disk.sh delay)
set -euo pipefail
DB=${SOAK_DB:-soak_brain}
psqlc() { docker exec -i soak-pg psql -U postgres -d "${2:-postgres}" -Atc "$1"; }
case "${1:-} ${2:-}" in
  "net on")
    d=${3:-0.75}
    sudo tc qdisc del dev lo root 2>/dev/null || true
    sudo tc qdisc add dev lo root handle 1: prio bands 4 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
    sudo tc qdisc add dev lo parent 1:4 handle 40: netem delay "${d}ms" limit 100000
    for port in 15432 16543; do
      sudo tc filter add dev lo parent 1: protocol ip prio 1 u32 match ip dport $port 0xffff flowid 1:4
      sudo tc filter add dev lo parent 1: protocol ip prio 1 u32 match ip sport $port 0xffff flowid 1:4
    done
    sudo tc qdisc show dev lo ;;
  "net off") sudo tc qdisc del dev lo root 2>/dev/null || true; echo off ;;
  "pg prod")
    docker update --cpus 8 --memory 32g --memory-swap 32g soak-pg >/dev/null
    psqlc "ALTER SYSTEM SET track_io_timing = on"
    psqlc "ALTER SYSTEM SET pg_stat_statements.track_planning = on"
    psqlc "ALTER SYSTEM SET effective_cache_size = '24GB'"
    psqlc "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" "$DB"
    psqlc "CREATE EXTENSION IF NOT EXISTS pg_prewarm" "$DB"
    docker restart soak-pg >/dev/null; sleep 3
    psqlc "SHOW shared_buffers"; psqlc "SHOW track_io_timing"
    docker inspect soak-pg --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' ;;
  "pg cold")
    docker restart soak-pg >/dev/null
    sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
    for i in $(seq 1 60); do psqlc "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
    docker restart soak-bouncer-session soak-bouncer-txn >/dev/null; sleep 1; echo cold ;;
  "explain on")
    m=${3:-0}
    psqlc "ALTER DATABASE $DB SET session_preload_libraries = 'auto_explain'"
    for kv in "log_min_duration=$m" log_analyze=on log_buffers=on log_timing=on log_nested_statements=on log_format=text log_verbose=off log_settings=on; do
      psqlc "ALTER DATABASE $DB SET auto_explain.${kv%%=*} = '${kv#*=}'"
    done
    docker restart soak-bouncer-session soak-bouncer-txn >/dev/null; echo "explain on ($m ms)" ;;
  "explain off")
    psqlc "ALTER DATABASE $DB RESET session_preload_libraries"
    docker restart soak-bouncer-session soak-bouncer-txn >/dev/null; echo "explain off" ;;
  "disk "*) bash "$(dirname "$0")/vm-disk.sh" delay "$2" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
