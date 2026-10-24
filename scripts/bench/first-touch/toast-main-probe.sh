#!/usr/bin/env bash
# GBRA-156: first-touch cost of the keyword candidate ranking (ts_rank over up to
# 50,000 matches) with search_vector out of line (cc_ext, the default EXTENDED
# storage) against in the main heap (cc_main, STORAGE MAIN). Each statement runs
# on a cold cache (Postgres restart + dropped page cache).
#   bash scripts/bench/first-touch/toast-main-probe.sh QUERIES_FILE OUT
set -euo pipefail
cd "$(dirname "$0")/../../.."
Q=$1 OUT=$2
P="docker exec -i soak-pg psql -h 127.0.0.1 -p 5434 -U postgres -d soak_brain -At"
: > "$OUT"
exec 3< "$Q"
while IFS= read -r -u 3 q; do
  for t in cc_ext cc_main; do
    bash scripts/bench/first-touch/env.sh pg cold >/dev/null
    res=$(printf "SET track_io_timing=on; SET jit=off; SET work_mem='32MB';\nEXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*), max(ts_rank(search_vector, websearch_to_tsquery('english', \$\$%s\$\$))) FROM (SELECT search_vector FROM %s WHERE search_vector @@ websearch_to_tsquery('english', \$\$%s\$\$) AND modality = 'text' LIMIT 50000) s;\n" "$q" "$t" "$q" | $P | grep -v "^SET$" | tr -d '\n')
    echo "$res" | python3 -c "import json,sys; p=json.load(sys.stdin)[0]; pl=p['Plan']; print(json.dumps({'table':'$t','q':sys.argv[1],'ms':p['Execution Time'],'read':pl['Shared Read Blocks'],'hit':pl['Shared Hit Blocks'],'read_ms':pl.get('I/O Read Time')}))" "$q" >> "$OUT"
  done
done
python3 - "$OUT" <<'EOF'
import json,sys,statistics as st
rows=[json.loads(l) for l in open(sys.argv[1])]
for t in ['cc_ext','cc_main']:
    xs=[r for r in rows if r['table']==t]
    print(t,'n',len(xs),'ms p50',round(st.median([r['ms'] for r in xs])),'max',round(max(r['ms'] for r in xs)),'reads p50',st.median([r['read'] for r in xs]))
EOF
