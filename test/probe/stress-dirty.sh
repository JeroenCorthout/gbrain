#!/usr/bin/env bash
set -u
cd /workspace/gbrain
label=$1; n=$2
out=~/.capy/work/probe-$label.ndjson; log=~/.capy/work/probe-$label.log
: > $out; : > $log
mkdir -p /tmp/ddload
pids=()
for k in 1 2 3; do ( while true; do dd if=/dev/zero of=/tmp/ddload/f$k bs=1M count=4000 status=none; done ) & pids+=($!); done
sleep 8; grep -i '^Dirty\|Writeback:' /proc/meminfo >> $log
for i in $(seq 1 $n); do
  PROBE_OUT=$out PROBE_VERBOSE_MS=150 bun test --timeout=60000 ./test/probe/maintenance-write-wait.probe.test.ts >> $log 2>&1
  echo "iter $i rc=$?" >> $log; grep -i '^Dirty\|Writeback:' /proc/meminfo >> $log
done
for p in "${pids[@]}"; do kill $p 2>/dev/null; done; pkill -x dd; sleep 1; rm -rf /tmp/ddload
python3 - "$out" <<'EOF'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
for lab in ['t3.first','t3.second','t4']:
    v=sorted(r['ms'] for r in rows if r['label']==lab)
    if v: print(lab,'n=',len(v),'min',v[0],'p50',v[len(v)//2],'max',v[-1], 'loopmax', max(r['loop_max_ms'] for r in rows if r['label']==lab))
EOF
