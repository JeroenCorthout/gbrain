# Database-canonical memory, wave 5 contract

Wave 5 of [the database as the source of truth](DATABASE_CANONICAL_MEMORY.md) (the second half of Phase 3a in its rollout
table): the exporter that commits and pushes, the live import lane it needs, conflict resolution, and the status, doctor and
MCP surfaces. It builds on the [wave 2](database-canonical-w2-contract.md), [wave 3](database-canonical-w3-contract.md) and
[wave 4](database-canonical-w4-contract.md) contracts and ships as two stacked pull requests:

- **W5a, the exporter** (`capy/db-canonical-w5a`): the export batch manifest and queue with its owner-only claim,
  the split-index commit, the push and integrate loop, the live import lane the loop needs, the bare-repository export core,
  the PGLite one-shot attempt, the flip-back materialization, and `gbrain sources canonical <id> --export-commits on|off`.
- **W5b, surfaces and integration** (`capy/db-canonical-w5b`, on W5a): lag and coverage in `gbrain sync status` and
  `get_brain_health`, `gbrain sources conflicts <id> list|show|resolve`, the `list_source_conflicts` MCP read op,
  `put_page resolves_conflict`, the doctor checks `database_canonical_backup`, `export_lag`, `import_conflicts` and a
  mode-aware `git_convergence`, the mode-aware `gbrain sources refresh` refusal, and the `put_page` hint on
  `gbrain git commit-push`.

Everything ships default-off. The migrations only add tables, columns, functions and indexes; nothing converts or backfills
on upgrade. A source exports only while all of these hold: the brain gate `persistence.database_canonical.enabled` is on,
the source is in database mode (wave 4), and an operator turned export commits on for it with the preview-bound verb. With
export commits off, a database-mode source behaves exactly as wave 4 leaves it (the shadow consumer is its exporter and
nothing reaches Git). A files-mode source is never touched by anything in this wave: every new branch reads the source's
durable mode first, and every new SQL predicate is either keyed on an export batch marker no files-mode row carries or reads
`database_canonical_brain.database_sources` first and returns when it is zero.

## Schema (W5a)

DDL: `src/core/persistence/canonical-export-schema.ts` (`DATABASE_CANONICAL_EXPORT_SCHEMA_SQL`), applied by migration v273
(renumbered at merge) and generated into its own `src/schema.sql` region after wave 4's, with its own `FRAGMENTS` entry. No
earlier wave's fragment is edited. RLS is enabled where the role allows it, every table cascades with its source, and
engine graduation carries all three tables verbatim (a `carry` row for each in `graduation-inventory.ts`, which the inventory completeness test requires).

| Table | Key | What it holds |
|---|---|---|
| `canonical_export_sources` | `source_id` | The per-source export switch and watermarks: `export_commits` (bool, default false), `export_epoch` (bumped by every `--export-commits` flip; a batch carries it), `export_changed_at`; `committed_commit`, `committed_at` (newest batch commit in the checkout), `pushed_commit`, `pushed_at` (newest commit the remote acknowledged); `remote_tip`, `remote_tip_seen_at` (the fetched tip and when a fetch first saw it unlaned), `laned_through` (the newest fetched commit the live lane classified), `import_pending_since` (the oldest outside change the lane saw but has not classified: an unstable path or an unlaned fetched tip; null when none); `checkout_state` (`current`, `lagging`, `unbound`) with `checkout_reason`; `oneshot_outcome`, `oneshot_at` (the PGLite one-shot attempt's typed result); `last_error_code`, `last_error_at`. One row per source that ever had export commits turned on. |
| `export_batches` | `id` (uuid); partial unique `(source_id)` over unfinished states | The durable batch manifest. Binding: `source_incarnation`, `mode_epoch`, `export_epoch`, `eligibility_generation` (the one the render saw), `target` (`worktree` or `bare`), `worktree_id`, `topology_generation` (the source binding's generation), `owner_epoch`, `host_id`. Claim: `claim_token`, `claim_owner` (the `claimOwner()` stamp of the holder), `claim_expires_at` (a 2-minute lease renewed between steps), `attempts`, `next_attempt_at` (backoff), `parked_at` (set after repeated failures; a parked batch is claimed again only after `--export-retry`). Git facts: `parent_commit`, `tree_oid`, `commit_sha` (recorded before the commit lock is taken), `pushed_commit` (the commit the remote accepted; differs from `commit_sha` after integration), `remote_tip` (the tip the last push was pinned to), `push_attempts` (at most 8 per claim). Lag: `oldest_enqueued_at` (the minimum outbox `first_enqueued_at` it consumed). `state`: `prepared`, `built`, `committed`, `pushed`, `completed`, `abandoned`. `renderer_fp`, `error_code`, `detail`, timestamps per state. |
| `export_batch_entries` | `(batch_id, path_folded)` | One row per path in a batch: `path`, `page_id`, `lifetime`, `op` (`write`, `remove`, `adopt`), `revision` (pinned `knowledge_revision`), `prior_disk_sha256` and `prior_blob_oid` (what the ledger said the path held; null for a path with no ledger row and no file), `disk_sha256` and `blob_oid` (the rendered bytes; null for a removal), `outbox_seq` and `first_enqueued_at` (the outbox row it consumed), `state` (`pending`, `committed`, `skipped`), `skip_reason` (`outside_edit`, `parked`, `ineligible`, `remote_imported`, `remote_conflict`, `filter_driver`). |

Unfinished states are `prepared`, `built`, `committed` and `pushed`; one unfinished batch per source keeps the ordering
argument simple (each batch's parent is the previous batch's commit or a commit the integrate step built on it).

The live import lane widens two of wave 3's CHECK lists: `IMPORT_LANE_MODES` gains `live` and
`IMPORT_CONFLICT_RESOLUTIONS` gains `taken_file`, `taken_database` and `written` (W5b). **Preferred:** wave 3 adds these
values to its own lists before it merges, so no later migration touches its constraints. **Fallback** if wave 3 has merged:
migration v273 replaces each of the two unnamed column CHECKs with a superset (`DROP CONSTRAINT IF EXISTS` on the
generated name, `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE`), which changes no row.

## The batch queue and its claim

### Why a queue of its own, not a Git effect

The design's big decision 9 picks "one Git effect per batch" so every checkout consumer that already knows the Git effect
sees export work, and names its own fallback: "flips if batching cannot fit the Git effect's model; then a new kind ships".
Batching does not fit. `persistence_effects.request_id` is a non-null foreign key, so each batch would need a carrier row in
`persistence_requests`, and about 100 modules read that table (464 references, mostly in the persistence and sync lane) with
no shared predicate to exclude it; a committed carrier looks like a real write to capacity, watermarks, diagnostics,
terminal-failure counters, `gbrain write-request`, receipt listing, retention and compaction. The carrier would also need a
wave 4 effect-fence exemption, a claim exclusion in `effect-journal.ts` and settle rules. So `export_batches` is its own work
queue with its own claim columns, and no export row is ever written to `persistence_requests` or `persistence_effects`.
Wave 4's fence keeps refusing every `git` and `withdrawal-mirror` effect on a database-mode source without exception, and
the exporter inserts none.

The consumers the Git effect would have reached are told directly instead:

| Consumer | How it learns about export work |
|---|---|
| `gbrain sources refresh` | refuses a database-mode source's worktree (`source_export_owned`, W5b): the exporter owns its fetches and fast-forwards |
| doctor `git_convergence` | mode-aware (W5b): a database-mode checkout points at `gbrain sync status` |
| wave 4's flip back (`--to files`) | its in-flight check counts unfinished batches (W5a edit in `sources-canonical-mode.ts`) |
| engine graduation | `graduation-drain.ts` refuses while a batch is unfinished (one predicate; the persistence lane is told) |
| persistence deactivation | `deactivation.ts` refuses while a batch is unfinished, beside wave 4's database-mode refusal, so no batch is stranded without an owner |
| `retry-effects` and the parked-effects listing | not reached. Their place is taken by the exporter's own backoff and parking, shown with the batch's error code and the retry command in `gbrain sync status` and doctor `export_lag`, and by `gbrain sources canonical <id> --export-retry` |

### Claims

`claimExportBatch(engine, hostId, sourceId, deadOwners)` (`export-claim.ts`) is the only way to hold a batch. It claims the
source's unfinished batch, or lets the exporter create the next one, only when: this host is
`persistence_worktrees.owner_host_id` of the source binding's worktree; a host binding with a `local_path` exists for this
host; the batch's `topology_generation` equals the binding's and its `mode_epoch` equals
`gbrain_source_publication_epoch(source_id)`; `export_commits` is on at the batch's `export_epoch`; the refresh fence is
clear (`refreshFenceClear`); no recovery record blocks the worktree; the batch is not parked; and the lease rules hold
(unclaimed, expired, or held by an owner the consumer proved dead, the rule effects use). The claim mints a new
`claim_token` and rewrites `owner_epoch` to the worktree's current one: an owner transfer re-binds the batch at its next
claim instead of failing it.

- A missing owner, host binding or checkout leaves the batch unclaimed and pending; there is no skipped outcome. Status
  reports `checkout_state='unbound'` with the reason.
- Failures back off (`next_attempt_at`) and, after `export_max_attempts` (default 8) consecutive failed claims, park the
  batch (`parked_at`, `error_code`). A parked batch is claimed again only after
  `gbrain sources canonical <id> --export-retry` (preview-bound; it clears `parked_at` and `attempts`).
- After a bound mode or binding change (the batch's `mode_epoch`, `topology_generation` or `export_epoch` no longer
  current) the exporter or the `--export-commits off` apply closes the batch: an uncommitted batch is `abandoned` (its
  entries' pages go back into the outbox); a committed, unpushed one stays unfinished and blocks the flip back, graduation
  and deactivation until an owner pushes it.

**Completing.** Every state transition is one short transaction that compare-and-sets the batch's `claim_token` and `state`
and the binding (`owner_epoch` of the worktree, `topology_generation` of the binding, the source's `mode_epoch` and
`export_epoch`). A stale claimant gets `write_claim_lost` at its next transition and stops. A non-owner effect worker never
touches an export: no effect row exists for it to claim, and a former owner whose claim moved cannot pass a transition. The
push is the one step outside a transaction; the exporter re-reads its token and binding immediately before it, so a
transfer that committed earlier stops the push, and a transfer that commits during it linearizes after a push the old
owner was entitled to make. The new owner's recovery then finds the commit on the remote and finishes forward.

## The batch

The exporter (`src/core/persistence/exporter.ts`, `runExportBatch(engine, sourceId, ctx)`) runs inside the resident owner
under the owner's worktree lease and its native worktree lock (`GitEffectOwner`), one batch per source at a time. Batching
targets start at 200 paths or 30 s (design open question 5), configurable as
`persistence.database_canonical.export_batch_paths` and `export_batch_window_ms`.

1. **Render, no lock.** Read up to the batch size of outbox rows in `seq` order. For each page: the canonical export view
   (`readExportPage` plus `readExportWithdrawals` inline; the segmented export reader for segmented pages), `exportEligible`
   (wave 1), the path from the slug (`exportPathKey` fold), the ledger row. Decide the op: `write`, `remove` (page gone,
   ineligible, or moved out, with a ledger row whose file is still there), `adopt` (the file already equals the render under
   the equality contract: only the ledger changes). Compare before replace: a path whose raw bytes differ from the ledger's
   `disk_sha256` (or that has a file and no ledger row) is not written; it goes to the live lane and is skipped
   (`outside_edit`). A path with an open `import_conflicts` row is skipped (`parked`). A page path whose `.gitattributes`
   names a `filter` driver is skipped (`filter_driver`) and reported; its bytes are never smudged or cleaned. Rendered bytes
   become blobs with `git hash-object -w --no-filters --stdin` (object writes need no lock).
2. **Manifest, one transaction.** Lock the source's `database_canonical_sources` row `FOR SHARE`; require the mode, epoch,
   export switch and binding the render started under, and the same `eligibility_generation` (else re-render). Insert
   `export_batches` (`prepared`, claimed by this exporter) and its entries. Consume the outbox rows
   with wave 2's seq compare (`consumeExportOutbox`); a row whose seq moved is dropped from the batch and stays for the
   next. Fault point `export:prepared`.
3. **Build, no lock.** In a private index file (`GIT_INDEX_FILE` under the persistence home): `read-tree` the parent (HEAD),
   `update-index --index-info` with the entries, `write-tree`, `commit-tree -p <parent>` with subject
   `gbrain: export <n> page(s) from <source>` and a `gbrain-export-batch: <id>` trailer. Record `parent_commit`, `tree_oid`,
   `commit_sha`, state `built`. Fault point `export:built`. This is the bare-repository core (below); the checkout only adds
   step 4.
4. **Commit, under the commit lock.** `acquireCommitLockAsync` (`brain-commit.lock`, the lock `gbrain git commit-push` takes).
   Inside it, and nothing else: re-check `HEAD == parent_commit` (if an operator commit moved it, rebuild the tree on the new
   HEAD with the same entries: page entries are ours, every other path is theirs); re-check each entry's raw bytes against
   its prior hash (a mismatch drops the entry as `outside_edit` and rebuilds); write each file (temp file, fsync, rename) or
   unlink it; update the real index for exactly those paths (`update-index --index-info`, then
   `update-index --refresh -q --` the same paths so their stat data matches); `update-ref HEAD <commit> <parent>`. Release.
   The checkout must have `core.splitIndex=true`; the exporter sets it before its first commit (the preview of
   `--export-commits on` lists that change), so each index write rewrites only the split delta. After the lock: one
   transaction records `committed`, the ledger rows (compare-and-set on each live ledger row's prior `disk_sha256`;
   `seeded_from='export'`, `commit_sha`, `renderer_fp`) and `canonical_export_sources.committed_commit`. Fault points
   `export:files_written`, `export:index_updated`, `export:ref_updated`, `export:committed`. Afterwards
   `git diff-index --cached HEAD` is empty and no exported path is dirty, so a person's plain `git commit` never reverts an
   export.
5. **Privacy gate, after commit and immediately before every push.** Read the source's `eligibility_generation`. When it
   moved since the manifest, collect the page paths changed in every commit the push would publish
   (`rev-list <remote tip>..<candidate>`), map them to pages through the ledger, and evaluate `exportEligible` now. When a
   path is no longer eligible, the exporter rewrites the unpushed range before pushing: one replacement commit on the remote
   tip whose tree is the candidate's tree with those paths removed (and every other page entry re-rendered at its current
   revision), recorded as the manifest's new commit, and the branch is moved to it under the commit lock with a
   compare-and-set from the old HEAD (worktree and index follow with `read-tree -m -u`). Operator commits in that
   unpushed range are kept as content in the replacement and listed in its body (`gbrain-squashed: <sha> <subject>`).
   Otherwise (nothing in the range became ineligible) the manifest's generation is advanced and the push proceeds. The
   same gate runs in recovery. So a page that turns private after render, between commit and push, or during recovery never
   reaches the remote; a visibility change that commits while a push is already in flight is ordered after that push, and
   its file is removed in the next batch (earlier commits keep the old copy, as the design states).
6. **Push, under the publish lock.** `brain-publish.lock`, taken only after the commit lock is released (commit-push's own
   order). Plain `git push <remote> <candidate>:<merge ref>`. Accepted: one transaction records `pushed` and then
   `completed` and `canonical_export_sources.pushed_commit`. A remote that refuses for another reason is
   `git_push_unavailable` (the batch backs off and parks after repeated failures). No tracking remote: the batch completes with
   committed coverage only (`push: skipped, reason: no_tracking_remote`). Fault points `export:before_push`,
   `export:pushed`. Publishers that left a publish request while the exporter held the lock are honored by pushing HEAD
   once more, as commit-push does.
7. **Integrate a moved remote.** A non-fast-forward rejection releases the publish lock and then, with no Git lock held:
   `fetch` the merge ref into the tracking ref; run the live lane over the page paths the fetched commits changed
   (`diff-tree -r -z --no-renames <merge base> <tip>`); build the next candidate as a merge commit with parents
   `[HEAD, tip]`: non-page paths merged in memory exactly as commit-push merges them (a two-sided change to a non-page file is
   the only `integrate_conflict` this loop can raise), and every page path taken from the tip unless this batch renders it
   and the lane did not park it. A path the lane imported or adopted at the tip's blob is re-rendered at its new revision
   (equal to the tip, so nothing changes); a path the lane parked keeps the tip's blob. Then steps 5 and 6 again, at most 8
   rejected pushes per claim; the 9th releases the claim with `export_push_contended` and the next tick resumes from the
   manifest. After an accepted push, the branch and worktree fast-forward to the pushed commit under the commit lock. Inside
   the lock the exporter reads HEAD and the branch ref again and compares both with the commit the merge was built from;
   if either moved (an operator commit, another clone's fast-forward), it drops this fast-forward and the next tick merges
   again from the new HEAD. Otherwise `read-tree -m -u HEAD <pushed>` and `update-ref refs/heads/<branch> <pushed> <built
   from>` (compare-and-set). A local edit that blocks the update records the checkout `lagging`. This is how non-page
   commits from other clones (an `AGENTS.md` edit) reach the owner checkout and why an imported page edit never surfaces as
   `integrate_conflict`. Fault points `export:fetched`, `export:laned`, `export:fast_forwarded`.
8. **Idle ticks.** Without outbox rows the exporter still fetches on its schedule (`export_fetch_interval_ms`, default 60 s),
   lanes the fetched range and fast-forwards the checkout through step 7's tail. The exporter is the only process that
   moves a database-mode source's checkout.

**Recovery** walks forward from the manifest, never backward: `prepared` rebuilds the commit; `built` checks whether HEAD
is or descends from `commit_sha` (then records `committed`), otherwise re-checks each entry on disk (prior bytes, new bytes,
or an outside edit that drops the entry), redoes the writes, the index entries and the ref update; `committed` re-runs the
privacy gate and pushes (a push of a commit the remote already has succeeds as up to date); `pushed` records completion. On a
new owner whose checkout lacks `commit_sha`, a batch whose commit the fetched remote contains is completed, and one it does
not contain is re-built on the new checkout from its entries (the old local commit is abandoned). While a batch is
unfinished, the live lane treats a path whose raw bytes equal the batch entry's `disk_sha256` as the exporter's own write,
never as an outside edit, so a crash between the file write and the ledger write is finished rather than imported.

### Lock windows

| Lock | Held for | Never held while |
|---|---|---|
| owner worktree lease | the exporter's lifetime on that host; losing it stops the exporter (no takeover on a stale heartbeat) | |
| native worktree lock (`GitEffectOwner`) | one batch's checkout steps; lets the exporter reclaim a provably abandoned `index.lock` | a database transaction is open |
| commit lock `brain-commit.lock` | step 4 (verify, write, index, ref), the privacy rewrite's branch move, the fast-forward | rendering, building, fetching, pushing, laning, waiting for the publish lock, any database call |
| publish lock `brain-publish.lock` | one push attempt (and honoring publish requests) | fetching, laning, the commit lock |
| database transactions | each manifest transition, with compare-and-set on token, state and binding | any git subprocess or filesystem write |

An operator's `gbrain git commit-push` of a non-page file during a batch waits at most the length of step 4's window on
the commit lock (bounded by the batch size), so it finishes without `commit_lock_busy`; its publish either waits for the
exporter's push or leaves a publish request the exporter honors.

### Bare-repository core

`src/core/persistence/export-core.ts`: `buildExportCommit(gitDir, { parent, entries, message })` and
`pushExportCommit(gitDir, ...)` take only a Git directory (a bare repository or a checkout's `.git`), use a private index
file and plumbing (`hash-object -w --no-filters`, `read-tree`, `update-index --index-info`, `write-tree`, `commit-tree`,
`update-ref` with an expected old value, `push`), and never touch a worktree. The checkout exporter is this core plus step
4. This is the seam a hosted brain uses (a bare mirror with no worktree binding); this wave ships no configuration that
selects a bare target, only the core and its test (`target='bare'` exists in the manifest for that seam).

### The live import lane

`src/core/persistence/import-lane-live.ts` applies wave 3's decisions for a database-mode source with export commits on.
It reuses wave 3's scan, hardened plumbing, stable-bytes rule and `decideImportCase`, and executes the outcome instead of
only recording it:

| Outcome | Live action |
|---|---|
| `adopt` | ledger row takes the file's raw hash and blob (compare-and-set) |
| `import` | a page write through the publication branch (worktree-free request, principal `application`/`gbrain-import-lane`, `expected_revision` = the ledger revision, protected keys kept from the database, provenance naming the commit or `worktree`), then the ledger row takes the file's hashes at the new revision (`seeded_from='import_lane'`) |
| `create` | a create-only page write, then a new ledger lifetime |
| `delete` | a soft delete through the delete path with `expected_revision`; ledger row retired |
| `streamed_import` | the streamed expected-revision entry when the write path offers it; until then a `too_large_for_lane` conflict with `detail.reason='streamed_import_unavailable'` |
| `conflict`, `bulk_delete` | an open `import_conflicts` row with `mode='live'` (bytes inline up to 24 MiB, above that a SHA-256 plus a pinned private ref `refs/gbrain/conflicts/<id>`); the path is parked |

A revision-checked write that loses its race (the page moved) is re-decided once and otherwise recorded as
`both_changed`. The lane runs on a path the exporter skipped as `outside_edit`, over a fetched range in step 7, and on
the exporter's idle schedule over the worktree (wave 3's watch, live mode). It skips paths of an unfinished batch whose
bytes match that batch's entry.

### PGLite one-shot attempt

On PGLite with no resident owner, the one-shot command whose write committed makes one bounded, best-effort attempt after
the write is acknowledged (the one-shot consumer's shutdown tick, `export_oneshot_deadline_ms`, default 15 s): one batch and
one push try for each exporting source this process can own. Any failure (no checkout, no remote, a lock held, the
deadline) is swallowed; it never fails the write or holds the datastore, and the outbox keeps the rows for the next command or
resident. The attempt records a typed outcome in `canonical_export_sources` (`oneshot_outcome` with `oneshot_at`:
`exported`, `skipped_no_checkout`, `skipped_no_remote` (committed, not pushed), `skipped_lock_busy`,
`skipped_deadline`, `skipped_not_owner`), and status shows it as a skip with its reason, never as an exporter stall: on
PGLite without a resident, export lag is expected until the next command.

### Flip-back materialization

Wave 4's `--to files` apply keeps every unmaterialized live page as a `file_drift` hold. W5a puts one export batch in
front of that step: the preview reports how many pages one batch would materialize and how many would stay holds; when
export commits are on and this process holds the owner lease, the apply first drains the outbox through export batches
(bounded by `export_flipback_deadline_ms`, default 120 s; ordinary exporting, no mode change), then runs wave 4's
transaction, which now finds ledger rows for the pages the batch committed and writes holds only for the rest (parked,
ineligible or unwritten paths). A host that is not the owner, or a source with export commits off, gets wave 4's barrier
unchanged. Wave 4's `--to files` fingerprint covers page ids and revisions and the outbox sequence high-water, none of
which a batch moves, so the drain does not cause `preview_changed` (a note for wave 4: the outbox term must be the
sequence's high-water, not `max(seq)` over the remaining rows).

### `gbrain sources canonical <id> --export-commits on|off`

Routed by `src/commands/sources-canonical.ts` to `src/commands/sources-canonical-export.ts`. Trusted local CLI only;
refuses `database_canonical_disabled` while the brain gate is off.

```
gbrain sources canonical <id> --export-commits on|off --dry-run [--json]
gbrain sources canonical <id> --export-commits on|off --admin-intent source_canonical --expected-state <fingerprint> [--json]
```

The preview names everything `on` will do: the binding (worktree, owner host, local path present on this host), the
branch and tracking remote (or that there is none and exports stay local), whether `core.splitIndex` will be set, page
roots with a `filter` driver (refused), other sources sharing the worktree (refused), outbox depth and eligible pages
without a ledger row at their revision. The fingerprint covers the source id and incarnation, mode and mode epoch, export
switch and epoch, binding (worktree, topology generation, owner epoch), and the refusal evidence. Apply locks the source row
`FOR UPDATE`, recomputes the fingerprint (`preview_changed`), and upserts `canonical_export_sources` with the new switch
and `export_epoch + 1`. `off` stops new batches; the apply abandons an uncommitted batch directly when no owner is running,
and a committed, unpushed batch stays for the owner to push.

`gbrain sources canonical <id> --export-retry --dry-run` lists the source's parked batch with its error code, attempts and
age; `--export-retry --admin-intent source_canonical --expected-state <fingerprint>` clears `parked_at` and `attempts` so the
owner claims it again. The fingerprint covers the batch id, state, error code and `parked_at`. It refuses
`export_retry_nothing_parked` when no batch is parked.

## Surfaces (W5b)

**Status store.** `src/core/persistence/canonical-status.ts`, `readDatabaseCanonicalStatus(exec, { sourceIds, detail })`:
per database-mode source, `export_commits`; `export_lag_seconds` (age of the oldest `first_enqueued_at` among the outbox
rows and unfinished batch entries of eligible, unparked pages; null when none) and `export_pending`; `import_lag_seconds`
(from `import_pending_since`); coverage `processed` (live eligible pages whose ledger revision or unfinished batch entry is
at the page's revision), `committed` (ledger revision current and its batch at least `committed`), `pushed` (current and
pushed), each with the eligible total; `checkout_state`; parked paths whose newest revision exists only in the database,
with age (detail mode, bounded); open conflicts by kind with count and oldest age; the unfinished batch with its state,
attempts, `error_code` and, when parked, `parked_at` and the retry command
(`gbrain sources canonical <id> --export-retry --dry-run`); the one-shot outcome.

- **`gbrain sync status`** (`src/commands/sync/operator.ts`): a `database_canonical` block per database-mode source in text
  and `--json`, with parked paths under `--detail` (the `*_read: not_read` convention for the bounded read).
- **`get_brain_health`** (`src/core/ops/admin.ts`): bands only, no slugs or paths, for the sources the caller can read:
  export lag band, import lag band, coverage band, open conflict count band.

**`gbrain sources conflicts <id> list|show|resolve`** (`src/commands/sources-conflicts.ts`, routed from `sources.ts`;
trusted local CLI):

```
gbrain sources conflicts <id> list [--kind <k>] [--json]
gbrain sources conflicts <id> show <conflict-id> [--bytes] [--json]
gbrain sources conflicts <id> resolve <conflict-id> --take file|database --dry-run [--json]
gbrain sources conflicts <id> resolve <conflict-id> --take file|database --expect <plan_hash> [--json]
```

The plan hash (`computePlanHash`) binds the conflict id, its state, `file_sha256`, `db_revision`, the page id and its
lifetime, and the take. Per kind:

| Kind | `--take file` | `--take database` |
|---|---|---|
| `both_changed`, `protected_metadata`, `unexported_collision` | page write from the stored bytes with `expected_revision` = the current revision | unpark; the ledger base takes the stored `file_sha256`, so the exporter replaces the file with the render |
| `deleted_vs_edited` | soft delete with `expected_revision` | unpark; the exporter recreates the file |
| `deleted_uncommitted` | refused `conflict_take_unavailable` (commit the removal; the lane then decides) | unpark; the exporter restores the file |
| `bulk_delete` | every row sharing its `detail.batch_id` is applied as deletions in one plan | unpark all of them; files are recreated |
| `too_large_for_lane` | streamed import when available, else `conflict_take_unavailable` | unpark; the exporter replaces the file |
| `unparseable` | `conflict_take_unavailable` (fix the file; the lane reads it again) | unpark; the exporter replaces the file (the bytes stay in the conflict row) |
| `never_exported`, `identity` | `conflict_take_unavailable` until Phase 3b (adoption kinds) | same |

A resolved row gets `state='resolved'` with `resolution` `taken_file` or `taken_database`.

**MCP read op `list_source_conflicts`** (`src/core/ops/source-conflicts.ts`, scope `read`, not mutating). Params:
`source_id`, `kind`, `conflict_id`, `limit`. Trust and visibility rules:

- Sources: the caller's source grant (`sourceScopeOpts`); a conflict of another source does not exist for the caller
  (`import_conflict_not_found`, never "forbidden").
- Slug fence: the client and subagent slug fences apply to the conflict's page slug, or to the slug its path maps to when
  it has no page.
- Visibility: a remote caller (`ctx.remote !== false`) sees a conflict only when its page is visible to it under the same
  visibility filter as `get_page` (private and alias-private pages are filtered out); a conflict without a page is shown to
  a remote caller only when its derived slug passes the fences and no live private page holds that slug.
- Shape: remote callers get summaries only: id, source, slug, path, kind, state, ages, `base_revision`, `db_revision`, and
  the page id and lifetime the id is bound to. Never `file_bytes`, `file_ref`, `merge` field names or `detail` beyond its
  screen code. Trusted local callers may pass `include_bytes` (refused `invalid_params` for remote callers).

**`put_page resolves_conflict`** (`src/core/ops/pages.ts`): `resolves_conflict: <conflict id>` with `expected_revision`
required. Admission refuses unless the conflict is open, belongs to the page's source and the page id and lifetime being
written, and its kind is one of `both_changed`, `unexported_collision`, `protected_metadata`
(`import_conflict_not_writable` for every other kind, so an agent write can never make the exporter recreate a deliberately
deleted file). Publication closes the row in the page's own publication transaction with a compare-and-set
(`state='open'`, same `file_sha256`), sets the ledger base to the stored `file_sha256` so the exporter may replace the file,
and records `resolution='written'`; when the compare fails the write fails with `import_conflict_stale` and nothing is
published. Remote callers obey the same rules plus the visibility above; the op ledger and contract goldens are updated.

**Doctor** (`src/commands/doctor/checks/database-canonical-export.ts`, three entries registered after wave 4's
`database_canonical_fence`, each green while no source is in database mode):

- `database_canonical_backup`: which verified backup it saw for a brain with a database-mode source: a `gbrain backup check`
  verdict (`src/core/backup/status-file.ts`) that is verified recoverable and younger than
  `persistence.database_canonical.backup_max_age_days` (default 7), or an operator attestation
  `persistence.database_canonical.backup_attestation` (`{ kind: 'pitr', provider, expires_at }`) that has not expired.
  Yellow when the newest is older or the attestation expired, red when neither exists; names `gbrain backup check`.
- `export_lag`: yellow above 300 s, red above 3600 s, red for a parked batch (its error code and the retry command
  `gbrain sources canonical <id> --export-retry --dry-run`), and red when export commits are on with outbox rows and no
  owner exporting. On PGLite, lag whose newest one-shot outcome is a typed skip is yellow with that reason, never red; names
  `gbrain sync status --source <id>`.
- `import_conflicts`: yellow while a source has open live conflicts, by kind with oldest age; names
  `gbrain sources conflicts <id> list`.
- `git_convergence` learns the mode: for a database-mode checkout it stops advising plain-git commits and the
  `--keep-checkout` push and points at `gbrain sync status --source <id>`. A database-mode checkout that diverges from its
  upstream while export commits are off is expected (nothing exports it) and is not a finding. Files-mode output is
  unchanged (golden-pinned).

**`gbrain sources refresh`** for a worktree bound to a database-mode source refuses `source_export_owned` (the exporter
owns fetches and fast-forwards there) with a read-only fix naming `gbrain sync status --source <id>`, before anything is
fetched or drained. It sits in front of wave 4's database-mode handling in worktree refresh.

**`gbrain git commit-push`** keeps refusing managed worktrees. Wave 4 adds the `source_database_mode` refusal for page
paths of a database-mode source; W5b adds the agent route (`put_page` / `remember`) to that refusal's suggestion and fix,
and keeps non-page paths of a database-mode worktree committable under the commit lock (the operator row of the design's
"who writes where" table).

## Error codes

Registered in `src/core/error-registry.ts` and the generated error-codes doc. Only the two `put_page` can return join
`WRITE_ERROR_CODES`.

| Code | Wave | When | Who acts |
|---|---|---|---|
| `export_commits_requires_database_mode` | 5a | `--export-commits on` for a files-mode source | flip the source to database mode first |
| `export_commits_unchanged` | 5a | the switch is already in the requested state | none |
| `export_target_missing` | 5a | `--export-commits on` for a source with no worktree binding | bind the source's checkout (`gbrain sources writer status`) |
| `export_filter_driver` | 5a | a page root has a Git `filter` driver: refused at enable time; one added later skips the path | remove the attribute for page paths |
| `export_worktree_shared` | 5a | another source shares the worktree (Phase 3a exports a worktree that holds one source) | give the source its own checkout |
| `export_retry_nothing_parked` | 5a | `--export-retry` with no parked batch | none |
| `export_push_contended` | 5a | 8 rejected pushes in one claim while the remote kept moving | none; the next tick resumes |
| `source_export_owned` | 5b | `gbrain sources refresh` on a database-mode source's worktree | none; read `gbrain sync status --source <id>` |
| `import_conflict_not_found` | 5b | unknown or out-of-scope conflict id | list the conflicts again |
| `import_conflict_not_writable` | 5b | `put_page resolves_conflict` for a kind outside the three allowed | resolve with `gbrain sources conflicts <id> resolve` |
| `import_conflict_stale` | 5b | the conflict closed or changed, or the page lifetime differs | read the conflict again and retry |
| `conflict_take_unavailable` | 5b | the requested take is not possible for the kind (table above) | the other take, or fix the file |

Reused: `preview_changed`, `database_canonical_disabled`, `write_claim_lost`, `git_push_unavailable`, `integrate_conflict`
(non-page files only), `source_database_mode` (wave 4).

## Files

New in W5a: this contract; `src/core/persistence/canonical-export-schema.ts`,
`src/core/schema-migrations/v273-database-canonical-export.ts`, `src/core/persistence/canonical-export-store.ts` (switch and
manifest reads and transitions), `export-claim.ts`, `export-core.ts`, `exporter.ts`, `export-runner.ts` (the resident loop
and the one-shot attempt), `import-lane-live.ts`, `src/commands/sources-canonical-export.ts`; tests
`test/database-canonical-exporter.test.ts` (batch, claim, transfer, privacy, crash points, bare core),
`test/database-canonical-export-clones.test.ts` (two real clones, the `AGENTS.md` race, operator commit-push during a batch,
`diff-index` clean) and `test/database-canonical-live-lane.test.ts`.

New in W5b: `src/core/persistence/canonical-status.ts`, `src/commands/sources-conflicts.ts`,
`src/core/ops/source-conflicts.ts`, `src/commands/doctor/checks/database-canonical-export.ts`; tests
`test/database-canonical-surfaces.test.ts`, `test/database-canonical-conflicts.test.ts` (verb, MCP op with `remote=true`,
`put_page resolves_conflict`) and `test/doctor-database-canonical-export.test.ts`.

No file reading `persistence_requests` or `persistence_effects` changes: no export row is written to either table.

Existing files, **persistence/sync lane (GBRA-133)**, each edit behind the mode check or keyed on export tables:

| File | Wave | Edit |
|---|---|---|
| `src/core/persistence/consumer.ts` | 5a | the resident owner starts and stops the export runner for exporting sources whose worktree it owns; the one-shot shutdown tick makes the PGLite attempt (both return at once while no source exports) |
| `src/core/git/commit-push.ts` | 5a | export the in-memory non-page merge (`integrate` / `mergeTrees`) and the publish-request helpers for the exporter; no behavior change for commit-push |
| `src/core/persistence/fault-points.ts` | 5a | the `export:*` fault point names |
| `src/core/persistence/graduation-drain.ts` | 5a | refuse while an export batch is unfinished (one predicate) |
| `src/core/persistence/deactivation.ts` | 5a | refuse while an export batch is unfinished, beside wave 4's database-mode refusal |
| `src/commands/sync/operator.ts` | 5b | the `database_canonical` block in `gbrain sync status` |
| `src/core/persistence/page-mutations.ts`, `page-input.ts`, `journal.ts` | 5b | `resolves_conflict` carried in the intent and checked at admission |
| `src/core/persistence/coordinator.ts` | 5b | the conflict compare-and-set close in the publication transaction |
| `src/core/persistence/types.ts` | 5b | `import_conflict_not_writable` and `import_conflict_stale` in `WRITE_ERROR_CODES` |
| `src/commands/sources-refresh.ts` | 5b | the `source_export_owned` refusal before delegation |
| `src/commands/git.ts`, `src/core/git/commit-push.ts` | 5b | the `put_page` hint on wave 4's `source_database_mode` page-path refusal |
| `src/commands/doctor/checks/git-convergence.ts` | 5b | the database-mode branch (also edited by wave 4 and by #7487) |

Existing files, **database-canonical lane (waves 1 to 4)**:

| File | Wave | Edit |
|---|---|---|
| `src/core/persistence/import-conflicts-schema.ts` (wave 3) | 5a | `live` mode and the three resolutions, preferably made by wave 3 before it merges |
| `src/core/persistence/import-lane.ts`, `import-lane-watch.ts` (wave 3) | 5a | export the scan pieces the live lane reuses; the watch runs live for exporting sources |
| `src/commands/sources-canonical.ts` | 5a | route `--export-commits` |
| `src/commands/sources-canonical-mode.ts` (wave 4) | 5a | the export batch in front of the flip-back holds; preview counts |

Existing files, **shared registries and other lanes**:

| File | Wave | Edit |
|---|---|---|
| `scripts/build-schema.ts`, `src/schema.sql` | 5a | the `FRAGMENTS` entry and the generated region |
| `src/core/schema-migrations/registry.generated.ts` | 5a | generated |
| `src/core/persistence/graduation-inventory.ts` | 5a | rows for the three tables |
| `src/core/error-registry.ts` | 5a, 5b | the codes above |
| `src/core/ops/admin.ts` | 5b | `get_brain_health` bands |
| `src/core/ops/pages.ts` | 5b | the `resolves_conflict` param |
| `src/commands/sources.ts` | 5b | route `conflicts` |
| `src/commands/doctor/registry.ts`, `src/core/doctor-categories.ts` | 5b | the three doctor entries |
| `src/core/operation-manifest.generated.ts`, `operation-loaders.generated.ts`, `cli-flag-registry.generated.ts` | 5b | generated |
| `test/postgres-unit-arms.txt` | 5a, 5b | the new test files |
| `docs/architecture/KEY_FILES.md` and its `key-files/` pages, the error-codes doc, `llms.txt` / `llms-full.txt`, goldens (schema catalog, migrations, doctor JSON and registry, MCP surface, op ledger, CLI) | 5a, 5b | regenerated |

## Tests

Each on real PGLite and real Postgres (every new test file is in `test/postgres-unit-arms.txt`), with real Git
repositories:

- W5a: a non-owner's effect worker and a non-owner exporter never claim or complete a batch, before and after a flip back;
  no export row ever appears in `persistence_requests` or `persistence_effects`; across an owner transfer the former
  owner's transition fails `write_claim_lost` and the new owner finishes the batch forward; a
  missing binding leaves the batch pending, never skipped; repeated failures park the batch and `--export-retry` releases it;
  graduation drain and deactivation refuse while a batch is unfinished; every new table has a graduation-inventory row;
  the fast-forward drops itself when HEAD or the branch moves between building the merge and taking the commit lock (a
  forced ref move in that window); the PGLite one-shot attempt records each typed skip; in two real clones a remote commit to page Q and `AGENTS.md`
  races a database write to page P (no `integrate_conflict`, the remote holds P's render and Q's edit, the database holds
  Q's edit, `AGENTS.md` reaches the owner checkout), and the same race on one page records one `both_changed` conflict and
  leaves the remote's bytes; `git diff-index --cached HEAD` is empty after a batch; a page turned private after render,
  between commit and push, and during recovery is in no pushed commit; a crash (SIGKILL through the fault hook) at every
  `export:*` point finishes forward with one commit per batch and correct ledger rows; an operator
  `gbrain git commit-push` of a non-page file during a batch finishes without `commit_lock_busy`; at most 8 push attempts
  per claim; PGLite one-shot with no remote does not fail the write and leaves the outbox; the bare core exports to a bare
  repository with no worktree binding; flip back after agent writes materializes through one batch and holds only the
  rest; `--export-commits` preview, apply, `preview_changed`, gate off; files-mode controls unchanged.
- W5b: lag and coverage numbers in `gbrain sync status` and `get_brain_health` (bands, no slugs); conflicts list, show and
  resolve per kind with plan hashes; `list_source_conflicts` with `remote=true` never shows a private page's conflict, a
  conflict outside the grant or fence, or bytes; `put_page resolves_conflict` for the three kinds, refused for deletion
  kinds, stale on a moved conflict; the doctor checks green, yellow and red, including a parked batch with its retry command and a database-mode
  checkout diverged with export commits off reporting nothing; `gbrain sources refresh` refuses
  `source_export_owned` for a database-mode source and is unchanged for files mode; commit-push names `put_page` for a page
  path and commits a non-page path.

## Open questions

1. **Shared worktrees.** Phase 3a exports only a worktree that holds one source (`export_worktree_shared`). Mixed worktrees
   (a database-mode and a files-mode source in one checkout) need refresh and managed sync to coexist with the exporter;
   proposed for Phase 3b.
2. **Filter drivers.** Page paths with a `filter` attribute are skipped rather than exported with filters disabled; the
   census can say whether any agent source needs them.
3. **Privacy rewrite of operator commits.** Unpushed operator commits in a range that must be rewritten are kept as content
   and listed in the replacement commit's body, not replayed one by one.
4. **Streamed import entry.** Wave 4's contract does not include the streamed expected-revision entry the design lists for
   Phase 3a; until it exists the live lane records `too_large_for_lane` for one-sided outside edits above 24 MiB.
5. **Non-page commits in a database-mode worktree.** W5b relies on wave 4's commit-push gate refusing only page paths of a
   database-mode source; if wave 4 refuses the whole worktree, the operator row of the design's table (and the
   commit-push-during-a-batch test) needs that gate narrowed.
