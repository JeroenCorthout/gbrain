#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
mkdir -p bench-out
nproc; uptime
for i in 1 2 3 4 5 6 7 8; do
  if [ $((i % 2)) -eq 1 ]; then order="b parent"; else order="parent b"; fi
  for side in $order; do
    dir=.; [ "$side" = parent ] && dir=../parent
    (cd "$dir" && bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0,0.2,0.8 --json 2>>"$OLDPWD/bench-out/$side-$i.err" | tail -1) > "bench-out/$side-$i.json"
    echo "run $i $side done $(date -u +%H:%M:%S)"
  done
done
uptime
