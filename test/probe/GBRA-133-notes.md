# GBRA-133 maintenance-write-wait flake triage (local probe branch, not for shipping)

- Gate failure (run 2026-10-17T23-06-51-820Z-65b2cae6, VM ci04565c slot 5): line 116, second publish 3,444 ms; file ran alone in its own bun process ("running 1 files").
- Same VM, same moment: every concurrent slot's item gained about the same time vs the rerun
  (s1 +3659, s2 +4137, s3 +3413, s4 +3466, s5 +3487 (this file), s6 +3559, s7 +1281, s8 +2274 ms);
  neighbouring items on the same slots are within about +-1.5 s. A VM-wide stall, not an in-process one.
- Local probe (maintenance-write-wait.probe.test.ts): second publish p50 10.6-13.4 ms, max 31.7 ms over n=55
  (10 idle, 30 under 7 concurrent gate-neighbour test files, 15 under 2.2 GB dirty-page writeback); event-loop max 0 ms in the window.
- Forced probe: bun test --preload ./test/probe/freeze-preload.ts ./test/maintenance-write-wait.test.ts
  freezes the thread 3,444 ms inside the bounded publishes: old assertions fail (3,469 / 3,455 ms), new work-count assertions pass.
