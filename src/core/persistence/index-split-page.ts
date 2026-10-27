/**
 * Wave C 1I-a (spec §3.6, unsplit pages): the `index-split-page` consumer. A strict git-first write of a page up to
 * PAGE_MAX_BYTES committed its file through the door and left the page's rows to this step (git-first.ts). The consumer
 * derives them from the committed file, never from the request's payload:
 *
 * 1. Token check: the page's `page_pending_heads` row must still name this request and revision. A newer commit of the
 *    page replaced it (that request indexes the newer head), and a delete, rename or private transition removed it; either
 *    way this request ends `committed` with `index.state: superseded`.
 * 2. The committed blob: HEAD's blob at the path must be the head the door committed, and the file on disk must hash to
 *    the committed size and sha256. A missing object or a mismatch is a content cause: the request ends `committed` with
 *    `index.state: held` and the hold code (index_held; the bytes are in Git, nothing is resent).
 * 3. Derive: a managed import of the canonical file (the owner's ordinary import of a committed file, which stages the
 *    segmented body from it and queues the post-content effects once, against this generation).
 * 4. Flip: under the pending head's row lock the token is checked again; the head is deleted, `pages.indexed_commit`
 *    records the commit and the request becomes `committed` with `index.state: indexed`.
 *
 * The per-page index lease: a job is claimed only while no other index job of its page holds a live claim
 * (effect-journal.ts), and it renews its claim while it runs, so a long import keeps the page; a lost claim stops the job
 * before it holds or flips anything. Split pages (over PAGE_MAX_BYTES) and incremental re-segmentation are PR 5's.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import type { PersistenceEffect } from './effect-model.ts';
import { completeEffect, effectClaimKeeper } from './effect-journal.ts';
import { registerBuiltInIndexSplitPageConsumer, type IndexSplitPageConsumer } from './git-first-gate.ts';
import { readPendingHead, type IndexReceipt } from './git-first.ts';
import { importManagedFile } from './import-mutations.ts';
import { getWorktreeBinding } from './ownership.ts';
import { headBlob } from './pending-import.ts';
import { declarePersistenceProtocol } from './protocol.ts';

/** @internal How often a running index job renews its claim (the lease); tests shorten it. */
export const _indexLeaseTiming = { renewMs: 30_000 };

interface IndexEffectData { slug: string; commit: string; head_oid: string; path: string; pending_revision: string }

async function fileSha256(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: hash.digest('hex'), bytes };
}

/** Ends the claimed effect with the index object, and an indexing request `committed` with it; a request no longer indexing is left as it is. */
async function finishIndex(engine: BrainEngine, effect: PersistenceEffect, index: IndexReceipt, searchable?: unknown): Promise<void> {
  await completeEffect(engine, effect, { index });
  await engine.executeRaw(`UPDATE persistence_requests SET state = 'committed', updated_at = now(),
      outcome = COALESCE(outcome, '{}'::jsonb) || jsonb_build_object('index', $2::text::jsonb)
        || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('searchable', $3::text::jsonb) END
    WHERE id = $1::uuid AND state = 'indexing'`, [effect.request_id, JSON.stringify(index), searchable === undefined ? null : JSON.stringify(searchable)]);
}

/** A content cause: the head stays (with its hold code) for the repair verbs, and the request ends held. */
async function hold(engine: BrainEngine, effect: PersistenceEffect, data: IndexEffectData, code: string): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw('UPDATE page_pending_heads SET hold_code = $3 WHERE source_id = $1 AND slug = $2 AND request_id = $4::uuid', [effect.source_id, data.slug, code, effect.request_id]);
    await finishIndex(tx, effect, { state: 'held', commit: data.commit, hold_code: code });
  });
}

export const indexSplitPage: IndexSplitPageConsumer = {
  async run(engine: BrainEngine, _config: GBrainConfig, effect: PersistenceEffect, hostId: string): Promise<void> {
    const keep = effectClaimKeeper(engine, effect, _indexLeaseTiming.renewMs);
    let lost: unknown = null, renewing = false;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      keep().catch(error => { lost = error; }).finally(() => { renewing = false; });
    }, Math.max(1, _indexLeaseTiming.renewMs));
    try { await indexCommitted(engine, effect, hostId, () => { if (lost) throw lost; }); }
    finally { clearInterval(timer); }
  },
};

async function indexCommitted(engine: BrainEngine, effect: PersistenceEffect, hostId: string, holdsLease: () => void): Promise<void> {
  const data = effect.data as unknown as IndexEffectData;
  const superseded = async (tx: BrainEngine, by: string | null) => finishIndex(tx, effect, { state: 'superseded', commit: data.commit, ...(by ? { superseded_by: by } : {}) });
  const head = await readPendingHead(engine, effect.source_id, data.slug);
  if (!head || head.request_id !== effect.request_id || head.revision !== data.pending_revision) return engine.transaction(async tx => { await declarePersistenceProtocol(tx); await superseded(tx, head?.request_id ?? null); });
  const binding = await getWorktreeBinding(engine, effect.source_id, hostId);
  if (!binding?.local_path) throw new Error(`Source ${effect.source_id} has no canonical checkout on this host; the index effect stays queued for its owner.`);
  const file = join(binding.local_path, data.path);
  if (await headBlob(binding.local_path, file) !== data.head_oid) { holdsLease(); return hold(engine, effect, data, 'git_object_missing'); }
  const onDisk = existsSync(file) ? await fileSha256(file) : null;
  if (!onDisk || onDisk.sha256 !== head.body_sha256 || onDisk.bytes !== head.body_bytes) { holdsLease(); return hold(engine, effect, data, 'hash_mismatch'); }
  const imported = await importManagedFile(engine, file, data.path, { sourceId: effect.source_id });
  holdsLease();
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const current = await readPendingHead(tx, effect.source_id, data.slug, { lock: true });
    if (!current || current.request_id !== effect.request_id || current.revision !== data.pending_revision) {
      await finishIndex(tx, effect, { state: 'superseded', commit: data.commit, ...(current ? { superseded_by: current.request_id } : {}) });
      return;
    }
    await tx.executeRaw('DELETE FROM page_pending_heads WHERE source_id = $1 AND slug = $2 AND request_id = $3::uuid', [effect.source_id, data.slug, effect.request_id]);
    await tx.executeRaw('UPDATE pages SET indexed_commit = $3 WHERE source_id = $1 AND slug = $2', [effect.source_id, data.slug, data.commit]);
    await finishIndex(tx, effect, { state: 'indexed', commit: data.commit }, imported.searchable ?? true);
  });
}

registerBuiltInIndexSplitPageConsumer(indexSplitPage);
