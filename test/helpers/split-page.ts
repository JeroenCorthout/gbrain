/**
 * Split git layout fixtures (Wave B PR 5): writes a canonical page file as a head plus part files where publication
 * would put them, through the real planner (planSplit). Call it with GBRAIN_HOME set (the planner stages under the
 * persistence home) and the KB-sized limits the test set with __setSplitLimitsForTests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { partsDirFor, planSplit, type SplitPart } from '../../src/core/split-layout/index.ts';

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const piece of source) out.push(piece);
  return Buffer.concat(out);
}

export interface WrittenSplitPage {
  /** The head file's text. */
  head: string;
  /** Each part with `rel`, its path relative to `root`, and `bytes` of content. */
  parts: Array<SplitPart & { rel: string; content: Buffer }>;
  /** The parts directory relative to `root`. */
  partsDir: string;
}

/** Writes `file` at `root/rel` as a split page (head at `rel`, parts in its parts directory). */
export async function writeSplitPage(root: string, rel: string, file: string | Uint8Array): Promise<WrittenSplitPage> {
  const plan = await planSplit((async function* () { yield Buffer.from(file); })(), { headPath: rel });
  try {
    const headPath = join(root, rel);
    mkdirSync(partsDirFor(headPath), { recursive: true });
    const head = plan.head();
    writeFileSync(headPath, head);
    const parts: WrittenSplitPage['parts'] = [];
    for (const part of plan.parts) {
      const content = await collect(plan.range(part.start, part.end));
      writeFileSync(join(dirname(headPath), part.path), content);
      parts.push({ ...part, rel: join(dirname(rel), part.path), content });
    }
    return { head, parts, partsDir: partsDirFor(rel) };
  } finally {
    plan.dispose();
  }
}
