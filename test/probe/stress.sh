#!/usr/bin/env bash
# usage: stress.sh <label> <iterations> <loaders(0/1)>
set -u
cd /workspace/gbrain
label=$1; n=$2; load=$3
out=~/.capy/work/probe-$label.ndjson; log=~/.capy/work/probe-$label.log
: > $out; : > $log
pids=()
if [ "$load" = 1 ]; then
  for f in test/large-pages/segmented-create-searchable.test.ts test/memory-verbs-conformance.test.ts test/belief-ledger-page-at-time.test.ts test/managed-sync-pinned-reads.test.ts test/large-pages/streamed-import-drift.test.ts test/fix-wave-3-integration.test.ts test/scripts/ci-bounded-run.test.ts; do
    ( while true; do bun test --timeout=120000 ./$f > /dev/null 2>&1; done ) &
    pids+=($!)
  done
  sleep 5
fi
for i in $(seq 1 $n); do
  PROBE_OUT=$out PROBE_VERBOSE_MS=150 bun test --timeout=60000 ./test/probe/maintenance-write-wait.probe.test.ts >> $log 2>&1
  echo "iter $i rc=$?" >> $log
done
for p in "${pids[@]}"; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done
pkill -f 'bun test --timeout=120000' 2>/dev/null
python3 - "$out" <<'EOF'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
for lab in ['t3.first','t3.second','t4']:
    v=sorted(r['ms'] for r in rows if r['label']==lab)
    if v: print(lab,'n=',len(v),'min',v[0],'p50',v[len(v)//2],'max',v[-1], 'loopmax', max(r['loop_max_ms'] for r in rows if r['label']==lab))
EOF
