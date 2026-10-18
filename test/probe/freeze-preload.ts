/**
 * GBRA-133 forced probe: freezes this process for PROBE_FREEZE_MS (default
 * 3444, the gate's reading) inside the publishes the maintenance-write-wait
 * test bounds by wall clock, the way a VM-wide stall freezes every test
 * process on the box. Atomics.wait blocks the thread like SIGSTOP would.
 */
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
const freezeMs = Number(process.env.PROBE_FREEZE_MS ?? 3444);
const slugs = new Set(['wiki/wait-second', 'wiki/wait-deadline']);
const frozen = new Set<string>();
const original = PGLiteEngine.prototype.readPageSnapshot;
PGLiteEngine.prototype.readPageSnapshot = function (slug, opts) {
  if (slugs.has(slug) && !frozen.has(slug)) {
    frozen.add(slug);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, freezeMs);
  }
  return original.call(this, slug, opts);
};
