/**
 * Database-canonical memory, wave 3: the import lane's schedule in observe mode. A full pass at start (the bounded scan on
 * restart), then a pass over the paths a recursive file watch reports, debounced, plus a full pass every `pollMs` as the
 * polling fallback (a watch can miss events, or the platform may not support a recursive one). Passes run one at a time.
 * The lane stops by itself when the source's shadow flag or the brain gate turns off, or the checkout goes away; its
 * tables then stay as they are and nothing reads them for behavior.
 */
import { watch, type FSWatcher } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { observeImportLane, type ObservePassOptions, type ObservePassResult } from './import-lane.ts';

export interface ImportLaneWatchOptions extends Omit<ObservePassOptions, 'paths'> {
  /** Full-scan interval, the polling fallback. Default 60 s. */
  pollMs?: number;
  /** How long watch events gather before a pass. Default 1 s. */
  debounceMs?: number;
  onPass?: (result: ObservePassResult) => void;
}

export interface ImportLaneWatch { stop(): void; done: Promise<ObservePassResult | null> }

const STOPS: ReadonlySet<string> = new Set(['gate_off', 'shadow_off', 'no_checkout']);

export function watchImportLane(engine: BrainEngine, sourceId: string, root: string, opts: ImportLaneWatchOptions = {}): ImportLaneWatch {
  const { pollMs = 60_000, debounceMs = 1_000, onPass, ...pass } = opts;
  let stopped = false, last: ObservePassResult | null = null, watcher: FSWatcher | null = null;
  let finish!: (result: ObservePassResult | null) => void, fail!: (error: unknown) => void, failure: { error: unknown } | null = null;
  const done = new Promise<ObservePassResult | null>((resolve, reject) => { finish = resolve; fail = reject; });
  const events = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(debounce); clearInterval(poll); watcher?.close();
    void queue.then(() => failure ? fail(failure.error) : finish(last));
  };
  const run = (paths?: string[]) => {
    queue = queue.then(async () => {
      if (stopped) return;
      last = await observeImportLane(engine, sourceId, { ...pass, ...(paths ? { paths } : {}) });
      onPass?.(last);
      if (last.status === 'skipped' && STOPS.has(last.reason!)) stop();
    }).catch(error => { failure = { error }; stop(); });
  };
  run();
  const poll = setInterval(() => run(), pollMs);
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = relative(root, `${root}${sep}${name}`).split(sep).join('/');
      if (path.startsWith('.git/') || path === '.git' || path.startsWith('..')) return;
      events.add(path);
      clearTimeout(debounce);
      debounce = setTimeout(() => { const paths = [...events]; events.clear(); run(paths); }, debounceMs);
    });
    watcher.on('error', () => { watcher?.close(); watcher = null; });
  } catch { watcher = null; }
  return { stop, done };
}
