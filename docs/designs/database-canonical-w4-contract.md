# Database-canonical memory, wave 4 contract

Wave 4 of [the database as the source of truth](DATABASE_CANONICAL_MEMORY.md) (the first half of Phase 3a in its rollout
table): the source's mode and mode epoch, the per-source protocol fence, the database publication branch, routing every
effect-inserting writer by mode, and `gbrain sources canonical <id> --to database|files` for a provably empty source. It
builds on [the wave 2 contract](database-canonical-w2-contract.md) and [the wave 3 contract](database-canonical-w3-contract.md).

Everything ships default-off. The migration only adds columns, functions, triggers and one constraint; nothing converts or
backfills on upgrade, and every source stays in `files` mode until an operator flips it with the preview-bound verb. A
files-mode source behaves exactly as before: every new check returns at its first statement while the brain has no
database-mode source, and the routing branches are taken only for a source whose durable mode is `database`. In this wave
the exporter is wave 2's shadow consumer: it computes batches and diffs for database-mode sources and commits nothing to
Git.

## Schema

DDL: `src/core/persistence/canonical-mode-schema.ts` (`DATABASE_CANONICAL_MODE_SCHEMA_SQL`), applied by migration v272
(renumbered at merge) and generated into its own `src/schema.sql` region after wave 3's, with its own `FRAGMENTS` entry.
Wave 2's `canonical-schema.ts` is not edited.

| Object | Change | What it holds |
|---|---|---|
| `database_canonical_sources` | add `mode TEXT NOT NULL DEFAULT 'files' CHECK (mode IN ('files','database'))`, `mode_epoch BIGINT NOT NULL DEFAULT 0`, `mode_changed_at TIMESTAMPTZ`, `eligibility_generation BIGINT NOT NULL DEFAULT 0` | The durable mode. `mode_epoch` advances on every flip in either direction (it never goes down, so work bound to an older epoch can never match again). `eligibility_generation` advances on every flip and whenever a page of a database-mode source changes a field that decides export eligibility. A source without a row is in `files` mode at epoch 0. |
| `database_canonical_sources` | add constraint `database_canonical_mode_shadow CHECK (mode <> 'database' OR shadow)` | A database-mode source keeps its shadow flag on, so wave 2's outbox triggers keep capturing its writes and its shadow consumer is its exporter. Wave 2's `--shadow off` on a database-mode source fails this constraint; its verb should refuse first with `canonical_mode_requires_shadow` (a note for the wave 2 PR). |
| `database_canonical_brain` | add `database_sources INTEGER NOT NULL DEFAULT 0 CHECK (database_sources >= 0)` | How many sources are in database mode. A second statement trigger, `database_canonical_sources_mode_count` (function `gbrain_count_database_mode_sources()`), recounts it on every change to `database_canonical_sources`, beside wave 2's `active_sources` trigger. Every fence trigger reads this column first and returns when it is zero. Because database mode implies shadow, `active_sources` already counts every database-mode source, as the wave 2 contract asks. |
| `persistence_requests` | add `canonical_epoch BIGINT` (nullable, no default: a metadata-only change) | The mode epoch a database-mode request was admitted under, stamped by the request fence trigger. Null for every files-mode request. |
| `persistence_consumers` | add `canonical_protocol INTEGER` (nullable) | The canonical protocol a resident process speaks (1 in this wave), written by its heartbeat, the way `segment_reader` was added. Null means a process that predates the mode. |
| function `gbrain_source_publication_epoch(text)` | new | The source's `mode_epoch` when it is in database mode, else null. Used by the fence triggers, the effect routing SQL and the doctor check. |
| triggers | new, below | The protocol fence and the eligibility generation. |

Engine graduation copies the three new columns verbatim (they belong to tables graduation already carries); the inventory
rows that list column sets get the new names.

## The protocol fence

A process that knows the mode declares it in the transaction: `set_config('gbrain.canonical_protocol','1',true)`. The
declaration rides in statements every writer already sends, so it costs no round trip:

- `declarePersistenceProtocol` and `declareDurablePersistence` (`src/core/persistence/protocol.ts`) add it to their
  single `set_config` statement; every request and effect insert runs after one of them.
- `withCoordinatedWrite` (`src/core/persistence/context.ts`) sets it beside `gbrain.write_sources` and restores the
  enclosing value with the others; every direct coordinated write runs inside it.
- `src/core/belief/purge-mirror.ts` sets `gbrain.write_sources` by hand and gets the same declaration next to it.

An old binary never sets it, and neither does a session that sets `gbrain.write_sources` by hand (a bare coordinated
write). The fence is checked at three points.

| # | Point | Where | Rule for a source in database mode | Code |
|---|---|---|---|---|
| 1a | Request inserts | trigger `database_canonical_request_fence`, BEFORE INSERT ON `persistence_requests` (fragment) | refuse without the declaration; refuse a request that names a worktree (files-mode publication); otherwise stamp `NEW.canonical_epoch := mode_epoch` | `canonical_protocol_required`, `canonical_publication_required` |
| 1b | Effect inserts | trigger `database_canonical_effect_fence`, BEFORE INSERT ON `persistence_effects` (fragment) | refuse without the declaration; refuse kinds `git` and `withdrawal-mirror` and any row that names a worktree | `canonical_protocol_required`, `canonical_publication_required` |
| 2 | Canonical mutations (direct coordinated writes) | trigger `database_canonical_fence`, BEFORE INSERT OR UPDATE OR DELETE on every table in `GUARDED_TABLES` (`writer-guard-schema.ts`), beside `managed_writer_guard` | refuse a row change of the source without the declaration. It resolves the row's source the way the managed guard does (the `source_id` column, or the page's for `tags`, `timeline_entries`, `takes`), and for an UPDATE checks the old source too | `canonical_protocol_required` |
| 3a | Publication | trigger `database_canonical_publication_fence`, BEFORE UPDATE ON `persistence_requests` `WHEN` the row reaches `committed` or clears its `recovery` | refuse when `canonical_epoch` differs from `gbrain_source_publication_epoch(source_id)`: a files-mode request on a database-mode source, a database-mode request after the flip back, or a request from an older database epoch. The publication transaction rolls back and the request fails with a typed receipt; nothing was published under the wrong mode | `canonical_mode_changed` |
| 3b | Claims of checkout effects | the `git` and `withdrawal-mirror` claim predicates in `src/core/persistence/effect-journal.ts` (`claimPersistenceEffect` and `claimCoalescedGitEffects`) gain `checkoutEffectClaimable('e')`, which is `gbrain_source_publication_epoch(e.source_id) IS NULL` | a checkout effect of a database-mode source is never claimed. It stays queued and resumes after a flip back to files, the mode it was prepared under. A flip refuses while one is unfinished (`canonical_inflight_work`), so this holds only an effect a crash or a stray writer left | none (held, listed by doctor) |
| 3c | Recovery | covered by 3a: a request recovery that would clear its record under a database-mode source is refused and the record is left as it is | | `canonical_mode_changed` |

Point 2 is a sibling trigger instead of a branch inside `gbrain_require_managed_writer`, so the managed guard function
(owned by the persistence lane and replaced in place by its own migrations) is not touched, and the fence also holds on a
brain whose managed persistence is later deactivated. Triggers fire in name order, so `database_canonical_fence` refuses
before `managed_writer_guard` and the refusal names the fence. 3a uses a `WHEN` clause, so ordinary claims, heartbeats
and state changes never call it, and the function returns at once when `database_sources` is zero and the row has no
`canonical_epoch`. Claims of requests are not fenced in SQL: a refusal inside a claim statement would stall every row
that statement claims, so a request from the wrong epoch is claimed normally and fails alone at 3a.

Point 1b has no exemption. Wave 5's export batches run as their own queue (`export_batches`, with its own claim columns)
and insert no `persistence_requests` or `persistence_effects` rows, so on a database-mode source every `git` and
`withdrawal-mirror` effect insert is refused, whoever makes it, and the exporter is the only checkout writer by
construction rather than by an allowlist.

**The race at the flip.** A writer that read `database_sources = 0` just before the flip committed must not land a
files-mode row after it. The flip takes the source row `FOR UPDATE` and then `lockCanonicalWriters`: `LOCK TABLE ... IN
SHARE MODE` on every table the fence covers. A writer whose statements already ran holds a `ROW EXCLUSIVE` lock on its
table until it commits, so the flip waits for it, and its rows are part of what the flip's preview recomputes; a writer
that moved anything the fingerprint covers makes the apply refuse `preview_changed`. A writer that starts after the
lock waits behind the flip, and its fence trigger runs after the flip commits (a trigger function is volatile, so each of
its statements takes a fresh snapshot) and refuses. Both orders are tested on one Postgres connection each
(`test/database-canonical-mode.test.ts`, the `on one Postgres connection` block), and the declaration's transaction
scope is tested directly and through a transaction-mode PgBouncer
(`test/e2e/database-canonical-fence-pooled-postgres.test.ts`): a session-level `set_config(..., false)` in a forced probe
makes that test fail.

The fast path of every fence trigger is one primary-key read of `database_canonical_brain`. It is not taken `FOR SHARE`:
a flip and an admission already serialize on the source row (admission reads it `FOR SHARE`, the flip locks it
`FOR UPDATE`), and a share lock on the hot path would write a lock on every insert. The soak measures the trigger cost
with database-mode sources present.

### Error codes

New codes, registered in `src/core/error-registry.ts`, in `WRITE_ERROR_CODES` (`src/core/persistence/types.ts`) for the
four the write path can return, and in the generated error-codes doc. A trigger raises `P0001` with the code as the
message prefix and constraint `database_canonical_fence:<point>`; `databaseRefusal`
(`src/core/persistence/publication-failure.ts`) maps that prefix to the typed code, as it does for the managed guard.

| Code | When | Who acts |
|---|---|---|
| `canonical_protocol_required` | a write to a database-mode source from a process that does not declare the mode: an older gbrain, or a session that set `gbrain.write_sources` by hand | upgrade that process (`gbrain upgrade` on its host) or stop it; nothing was written |
| `canonical_publication_required` | a files-mode publication reached a database-mode source: a worktree-bound request, or a `git` or `withdrawal-mirror` effect | report; the write path routes these by mode, so this is a missed writer |
| `canonical_mode_changed` | a request admitted under one mode epoch reached publication or recovery under another (the source flipped in between) | resubmit with a new request id; it is routed under the current mode |
| `source_database_mode` | a file-lane operation targeted a database-mode source: a managed or classic sync import, a file import or repair, a quarantine clear, a canonical reconcile, a segmented mirror repair, `gbrain sources refresh`, or a commit-push that names page paths under the source root | none: the import lane owns outside edits for this source |
| `canonical_mixed_group` | one grouped admission mixed file-lane operations with page writes for a database-mode source | split the group; it is refused whole, never split silently |
| `canonical_source_not_empty` | `--to database` on a source that fails the emptiness test; `detail` names each failed condition. Converting a non-empty source is Phase 3b | empty the source, or wait for the conversion state machine |
| `canonical_inflight_work` | a flip while the source has unfinished requests or effects, a recovery record, or a live process without the canonical protocol | wait for the work to drain or stop the old process, then preview again |
| `canonical_requires_managed` | `--to database` on a brain whose managed persistence is not active (design precondition 1) | activate managed persistence first |
| `canonical_mode_unchanged` | the source is already in the requested mode | none |
| `canonical_mode_requires_shadow` | `--shadow off` for a database-mode source: wave 2's verb calls `assertShadowOffAllowed` at the preview and inside the apply transaction; the `database_canonical_mode_shadow` constraint is the backstop for a raw update | flip the source back to files first |
| `preview_changed` (existing) | the fingerprint moved between `--dry-run` and apply | preview again |
| `database_canonical_disabled` (existing) | the brain gate is off | turn the gate on |

## The database publication branch

**Decision point:** request admission, `admitWriteInTransaction` and `admitWriteGroupInTransaction` in
`src/core/persistence/journal.ts`. It is the one place every request-based writer passes through (page, memory, fact
fence, maintenance, connector and repair writers all compute a worktree id from their source's binding and hand it to
admission; there are about sixty `getWorktreeBinding` callers), so no writer has to know the mode. The source row is
already read `FOR SHARE` there; that statement gains one column, `gbrain_source_publication_epoch($1) AS canonical_epoch`,
so the mode costs no round trip and is read under the lock the flip waits on. For a database-mode source admission then:

1. ignores the worktree's refresh fence and recovering state in `assertWorktreeAdmission` (they fence the checkout, not
   the database);
2. inserts the request with `worktree_id` and `topology_generation` null; the request fence stamps `canonical_epoch`;
3. refuses file-lane operations with `source_database_mode` (managed-sync `submit_job` kinds and the file import,
   repair and rename operations listed in `canonical-mode.ts`), because they read the checkout and in this mode the
   import lane owns outside edits.

`assertWorktreeAdmission` and `assertBackgroundOwner` keep running unchanged; `databaseModeWaives` in `journal.ts`
wraps both and waives only an `OperationError` for a source the `FOR SHARE` read found in database mode, so a files-mode
source takes exactly the old path and pays nothing more. A grouped admission that mixes a file-lane operation with page
writes for a database-mode source refuses `canonical_mixed_group` instead of being split.

Everything after admission already follows from a null worktree:

- no worktree lock and no recovery record (`publish` in `coordinator.ts` takes both only `if (row.worktree_id)`);
- no prepared file, so no `git` effect (`queuePublicationEffects` queues one only for `prepared.file && row.worktree_id`)
  and no file in the receipt;
- the request is claimable by any authorized consumer (`claimableWriteSql`: `r.worktree_id IS NULL OR ...`), so it
  commits while the export owner is stopped, its checkout is missing, or a batch holds the worktree lock;
- no `database_only_reason` stamp: only `unbound_source`, `detached` and the mirror classifications stamp a page, and
  none of them apply (`databaseOnlyPublication` returns nothing for a null worktree);
- no export work enqueued by the writer: wave 2's outbox trigger records the page because the source's shadow flag is on.

Three small follow-ons make the branch explicit instead of incidental:

- `decoratePublicationOutcome` (`coordinator.ts`) reports `write_through: { written: false, skipped: 'database_canonical' }`
  and receipt `persistence.mode: 'database'` for a row with `canonical_epoch`, instead of the `no_repo_configured`
  default;
- `decideUnboundWrite` (`unbound-source.ts`) returns `{ kind: 'database_only', reason: 'database_canonical' }` for a
  database-mode source, so a database-mode source without an owner binding is never refused as unbound nor stamped
  `unbound_source`; `database_canonical` joins the `databaseOnlyReason` union and is never written to a page;
- connector sources never enter database mode in this wave: the verb refuses a connector source kind
  (`canonical_requires_managed`, condition `connector`), so `connector-sync.ts` is not edited.

The unbound-source refusals and stamps are not relaxed for files-mode sources; the branch is reached only through the
durable mode.

## Writer routing

Every writer that inserts `persistence_effects` rows, or that publishes a file through a request, routed by mode. Effect
routing for the three direct inserters is one SQL fragment, `databaseModeEffectRouting('s')` from `canonical-mode.ts`: it
joins `database_canonical_sources`, sets `worktree_id` to null and filters out `git` and `withdrawal-mirror` for a
database-mode source.

| Writer | Files mode (unchanged) | Database mode |
|---|---|---|
| Page writes (`put_page`, `put_pages`, `capture`, `edit_page`, `append_page`, `delete_page`, `restore_page`, `revert_version`) | worktree-bound request; file staged under the native lock with a recovery record; per-request `git` effect | worktree-free request at `canonical_epoch`; no file, lock or recovery; `embedding`, `links` and `facts-backstop` effects only; the outbox trigger records the page |
| Memory and fact fence writes (`remember`, `forget`, fence edits through `fact-write-target.ts`) | as page writes | as page writes |
| Withdrawal (`forget`, `forget_fact`; `src/core/facts/withdrawal.ts`) | `withdrawal-mirror`, `git` and `embedding` effects bound to the worktree | `embedding` only, worktree-free; the withdrawal trigger records every affected page in the outbox |
| Purge (`purge_fact`; `src/core/facts/purge.ts`) | `withdrawal-mirror`, `git`, `embedding` | `embedding` only; the pages' revisions move, so the outbox records them |
| Segmented repair (`gbrain repair segmented-mirror`; `src/core/repair/segmented-mirror.ts`) | `withdrawal-mirror` and `git` for the stale page | refused at admission (`segmented_mirror` is a file-lane kind, `source_database_mode`); a direct effect insert would be refused by point 1b. The module is not edited; the exporter renders from the overlay |
| Visibility changes (a page write that changes `visibility`, `access`, `confidentiality`, `derived_from`, `type` or `database_only_reason`) | request with a file and `git` effect | worktree-free request; trigger `database_canonical_eligibility` on `pages` advances `eligibility_generation` in the same transaction |
| Rename (managed sync rename pairs, `file-repair.ts`, `gbrain repair rename-identity`, sync hold renames) | file-driven slug moves through sync or repair requests | sync renames never start (sync refuses the source) and the file-lane kinds refuse at admission; any other path that would insert a checkout effect is refused by point 1b. Renames from outside edits belong to the import lane |
| Connector checkpoints (`connector-sync.ts`) | page requests bound to the worktree | not reachable: a connector source cannot enter database mode in this wave |
| Managed and classic sync | imports files | `automaticSyncSkip` (`sync-policy.ts`) skips the source with reason `database_canonical`; `gbrain sync` prints the skipped sources; an explicit `gbrain sync --source <id>` (`commands/sync/perform.ts`) and `performManagedSync` (`persistence/sync-run.ts`) refuse `source_database_mode` before reading the checkout; admission refuses a sync request as a backstop |
| Worktree refresh (`gbrain sources refresh`; `worktree-refresh.ts`) | the one sanctioned managed Git writer | refused `source_database_mode` when any source of the worktree is in database mode |
| Commit-push (`gbrain git commit-push`; `src/core/git/commit-push.ts`) | commits the named paths under the commit lock | refuses `source_database_mode` only for named paths under a database-mode source's root that sync would import as pages (`isSyncable`); non-page files on that checkout (an `AGENTS.md`, scripts) commit as before under the normal lock. The database-mode roots are recorded beside the managed filesystem roots (`root-registry.ts`), so the check reads no database |
| Maintenance writers (atoms, facts, loop retirement, relink, proposal supersede, generation retire, grandfather) | worktree-bound requests | worktree-free requests through admission; no code change |
| Direct coordinated writers (about thirty, no request) | rows under `withCoordinatedWrite` | unchanged; the declaration passes the fence and the outbox trigger records the page |
| An old binary or a bare coordinated write | n/a | refused by the fence (points 1 and 2) with `canonical_protocol_required` |

In database mode no writer inserts a `withdrawal-mirror` row or a per-request `git` row; the tests count both after a
put and a forget, and point 1b refuses a direct insert of either.

Operator surfaces say the mode: `gbrain sources set-sync` previews carry a `database_mode` note,
`gbrain sources writer status` marks the checkout `database_mode: true` (owned by the exporter), and source deactivation
refuses with blocker kind `database_canonical_mode`, whose exit is the flip back.

## `gbrain sources canonical <id> --to database|files`

`src/commands/sources-canonical.ts` routes `--to` to a module of its own, `src/commands/sources-canonical-mode.ts`. Trusted
local CLI only (no MCP operation); refuses `database_canonical_disabled` while the brain gate is off.

```
gbrain sources canonical <id> --to database --dry-run [--json]
gbrain sources canonical <id> --to database --admin-intent source_canonical --expected-state <fingerprint> [--json]
gbrain sources canonical <id> --to files --dry-run [--json]
gbrain sources canonical <id> --to files --admin-intent source_canonical --expected-state <fingerprint> [--json]
```

**Fingerprint**: SHA-256 over the source id and incarnation, the target mode, mode, mode epoch, shadow flag and epoch,
eligibility generation, the emptiness evidence (each count below), the in-flight counts, and a digest of the source's
own rows whose change enqueues an export outbox row: each page's id, revision, slug, live or deleted state and
database-only reason, and every withdrawal and purge row. It reads the rows, not the outbox, because `export_outbox_seq`
is one sequence for the whole brain: a high-water mark (its `last_value`, or `max(seq)`) would move on every other
source's write and refuse a correct apply `preview_changed`, and `max(seq)` over the remaining rows also moves when the
exporter drains them. A test drains the outbox and advances the sequence after a preview and checks the fingerprint does
not move; a write to the source after the preview does. Apply binds the intent with wave 2's
`requireSourceCanonicalIntent` (`--admin-intent source_canonical`).

**`--to database` emptiness test**, each a named condition in `canonical_source_not_empty`'s detail:

- zero live pages (`deleted_at IS NULL`) in the source;
- zero holds: Git holds (`countGitHolds`), legacy sync holds, connector item holds and open `import_conflicts` rows;
- no tracked files under the source's page roots in its checkout (hardened `ls-files` from `import-lane-git.ts`; a
  source with no checkout passes);
- no prepared transfer (the bound worktree is `active`).

Plus the drain preconditions, refused as `canonical_inflight_work`: no unfinished request or effect for the source, no
recovery record on its requests or effects, and no live resident process (`persistence_consumers` renewed within its
lease) whose `canonical_protocol` is null. The request part is `UNSETTLED_REQUEST_SQL`, the same predicate fence 3a
reads, so a request the flip waits for is exactly one 3a would judge. `inflightWork` in `canonical-mode.ts` owns this
check; wave 5 adds the count of unfinished export batches to it there. And `canonical_requires_managed` unless managed persistence is active. An owner binding is
not required in this wave (the publication branch needs none); the committing exporter will need one before its first
commit and its wave adds that check.

**Apply** runs in one transaction: declare durable persistence; lock the source row `FOR UPDATE` (admission waits behind
it); `lockCanonicalWriters` (every table the fence covers that exists); recompute the fingerprint (`preview_changed` when it moved) and the emptiness test; upsert
`database_canonical_sources` with `mode='database'`, `mode_epoch + 1`, `shadow = true` (advancing `shadow_epoch` when it
was off, as `writeSourceShadow` does), `eligibility_generation + 1`. The output prints the new epoch.

**`--to files` and the flip-back barrier.** Agent writes made while in database mode exist only in the database. Apply, in
one transaction under the source lock and `lockCanonicalWriters`, bound to the fingerprint (so a write after the preview is
`preview_changed`):

1. require the drain preconditions (`canonical_inflight_work` otherwise);
2. enumerate every live page of the source whose newest revision has no materialized file (no live export ledger row at
   that revision; in this wave the exporter writes none, so that is every live page written in database mode) and keep
   each as an explicit database-ahead hold through `writeGitHold`: code `file_drift`, side `database`, deleted state
   `file_gone`, provenance `never_committed`, with the page id, slug, path and revision. That is the record managed sync
   writes for a page whose file never reached Git, so `gbrain sync status`, doctor and `gbrain repair file-drift` already
   list it and materialize it (one preview-bound batch, Git effects in files mode). A page deleted in database mode with
   no file needs nothing;
3. set `mode='files'`, `mode_epoch + 1`, `eligibility_generation + 1`; the fence lowers because no check fires for a
   files-mode source. The shadow flag stays as it is (turning it off is wave 2's verb).

The alternative the design names, materializing through one export batch, needs the committing exporter and arrives with
wave 5; the barrier then offers it first and keeps the hold for paths it cannot write. A test makes agent writes (create,
edit, delete) in database mode, flips back, checks one hold per unmaterialized live page and none for the deleted one,
then that a write injected after the preview refuses `preview_changed`.

## Doctor `database_canonical_fence`

`src/commands/doctor/checks/database-canonical-fence.ts`, registered after `databaseCanonicalCensusEntry` and named in
`doctor-categories.ts`.

- **Green** while no source is in database mode (the gate on or off), and while every database-mode source is consistent.
- **Red** when, for a database-mode source: `mode_epoch < 1`; shadow is off; `database_sources` disagrees with the rows;
  an unfinished request has a `canonical_epoch` other than the source's (or a worktree); a `git` or `withdrawal-mirror`
  effect is unfinished; or an old-protocol process is seen: a live `persistence_consumers` row without
  `canonical_protocol`. Each finding names the source and the fix.
- **Yellow** when the gate is off while a source is in database mode (the fence still holds, the verb refuses), and when a
  files-mode source still has an unfinished request carrying a `canonical_epoch` from before a flip back.

## Store and helper module

`src/core/persistence/canonical-mode.ts`, plain SQL over `SqlEngine` like wave 2's store:

```ts
CANONICAL_PROTOCOL_DECLARATION            // "set_config('gbrain.canonical_protocol','1',true)": transaction-scoped only
readSourceMode(exec, sourceId): Promise<SourceModeState>   // mode, epochs, shadow; files at 0 without a row
sourceInDatabaseMode(exec, sourceId): Promise<boolean>
listDatabaseModeSources(exec): Promise<string[]>
databaseModeEffectRouting(alias): { join; worktree(expr); filter(kind) }   // withdrawal and purge effect inserts
checkoutEffectClaimable(alias): string                                    // claim predicate, point 3b
isFileLaneAdmission(input): boolean; sourceDatabaseModeError(sourceId, what): OperationError
canonicalFenceRefusal(error) / canonicalFenceError(error)                 // used by databaseRefusal
inflightWork(exec, sourceId): Promise<{ requests; effects; old_processes }>   // wave 5 adds unfinished batches
lockCanonicalWriters(tx): Promise<void>
assertShadowOffAllowed(exec, sourceId): Promise<void>                     // wave 2's --shadow off calls it
```

The flip itself (the mode upsert and the flip-back holds) lives in `src/commands/sources-canonical-mode.ts`, the only
writer of `mode`.

## Files

New (this lane): `docs/designs/database-canonical-w4-contract.md`, `src/core/persistence/canonical-mode-schema.ts`,
`src/core/persistence/canonical-mode.ts`, `src/core/schema-migrations/v272-database-canonical-mode.ts`,
`src/commands/sources-canonical-mode.ts`, `src/commands/doctor/checks/database-canonical-fence.ts`,
`test/database-canonical-mode.test.ts`, `test/database-canonical-checkout.test.ts` and
`test/e2e/database-canonical-fence-pooled-postgres.test.ts`.

Existing files, **persistence/sync lane (GBRA-133)**, each edit behind the mode check:

| File | Edit |
|---|---|
| `src/core/persistence/journal.ts` | the publication branch at admission (single and group): the mode on the source `FOR SHARE` read, `databaseModeWaives` around the worktree and background-owner checks, the null worktree, the file-lane refusal, the mixed-group refusal |
| `src/core/persistence/protocol.ts` | the declaration in `declarePersistenceProtocol` and `declareDurablePersistence` |
| `src/core/persistence/context.ts` | the declaration in `withCoordinatedWrite` (set and restore) |
| `src/core/persistence/effect-journal.ts` | `checkoutEffectClaimable` in the `git` and `withdrawal-mirror` claims (point 3b) |
| `src/core/persistence/coordinator.ts` | `decoratePublicationOutcome` reports `database_canonical` |
| `src/core/persistence/publication-failure.ts` | `databaseRefusal` maps the fence refusals to the typed codes |
| `src/core/persistence/types.ts` | the canonical codes in `WRITE_ERROR_CODES` |
| `src/core/persistence/model.ts` | `database_canonical` in the `databaseOnlyReason` union; `canonical_epoch` on `WriteRequest` |
| `src/core/persistence/unbound-source.ts` | `decideUnboundWrite` returns the database-canonical decision |
| `src/core/persistence/consumer-heartbeat.ts` | writes `canonical_protocol` in the heartbeat upsert |
| `src/core/persistence/deactivation.ts` | the `database_canonical_mode` blocker, whose exit is the flip back |
| `src/core/persistence/sync-run.ts`, `src/core/sync-policy.ts`, `src/commands/sync/perform.ts`, `src/commands/sync/run.ts` | sync skips or refuses a database-mode source |
| `src/core/persistence/worktree-refresh.ts` | refresh refuses a worktree with a database-mode source |
| `src/core/persistence/root-registry.ts`, `src/core/persistence/filesystem-guard.ts`, `src/core/git/commit-push.ts` | the recorded database-mode roots and the page-path commit-push refusal |
| `src/core/persistence/administration.ts`, `src/commands/sources-sync-enabled.ts` | the writer-status mark and the set-sync preview note |
| `src/core/facts/withdrawal.ts`, `src/core/facts/purge.ts` | effect inserts use `databaseModeEffectRouting` |
| `src/core/belief/purge-mirror.ts` | the declaration beside its hand-set `gbrain.write_sources` |

Existing files, **other lanes or shared registries**:

| File | Edit |
|---|---|
| `src/commands/sources-canonical.ts` (waves 1 to 3) | route `--to` to `sources-canonical-mode.ts` |
| `src/commands/sources-canonical-shadow.ts` (wave 2) | `--shadow off` calls `assertShadowOffAllowed` at the preview and in the apply transaction |
| `scripts/build-schema.ts`, `src/schema.sql` | the `FRAGMENTS` entry and its generated region |
| `src/core/persistence/graduation-inventory.ts` | the `database_canonical_sources` note names the mode |
| `src/commands/doctor/registry.ts`, `src/core/doctor-categories.ts` | register `database_canonical_fence` |
| `src/core/error-registry.ts` | the new codes |
| `test/postgres-unit-arms.txt`, `scripts/e2e-backend-matrix.txt` | the new test files |
| `docs/architecture/key-files/core-persistence-continued.md` | the wave 4 entry |
| `scripts/module-size-limits.tsv`, `scripts/page-body-readers-baseline.tsv` | `sync-run.ts` +2; the fence's in-row tuple, the managed-writer guard's own |
| generated artifacts | `bun run regen:all`, schema catalog, migration, export-surface and doctor goldens, error-codes doc |

## Tests

On real PGLite and real Postgres (both unit files are listed in `test/postgres-unit-arms.txt`):

- the fence: an undeclared write (a request, an effect, a page row) and a bare coordinated write refuse
  `canonical_protocol_required`; a `git` or `withdrawal-mirror` effect refuses `canonical_publication_required`; a
  declared write passes; files mode is untouched;
- an agent `put_page` publishes database-only (no worktree, file or checkout effect) and forget inserts no
  `withdrawal-mirror` or `git` row;
- an agent write commits and returns its receipt with no consumer and the checkout removed;
- 100 writes over 10 pages with the exporter stopped: every request settles, no checkout effect exists, the outbox holds
  one row per page; the files-mode control queues at least one `git` effect per write;
- a checkout effect left from files mode is never claimed once the source is in database mode;
- file-lane admissions refuse `source_database_mode`, a mixed group refuses `canonical_mixed_group`;
- the verb: gate off refuses; a live page refuses `canonical_source_not_empty`; a write after the preview refuses
  `preview_changed`; the flip; `--shadow off` refuses at preview and apply;
- the flip back: one `file_drift` hold (side `database`) per unmaterialized live page, none for a deleted page; the
  fingerprint survives an outbox drain and another source's sequence use; a write after the preview refuses;
- a recovery record blocks the flip through the shared predicate;
- the doctor check green, red (an unfinished checkout effect) and yellow (gate off);
- Postgres only: `set_config(..., true)` ends with its transaction; a writer past its fence before the flip commits
  first and the apply refuses `preview_changed`; a writer waiting behind the flip is refused;
- `test/database-canonical-checkout.test.ts`: commit-push refuses page paths and commits a non-page file; refresh and
  managed sync refuse; writer status marks the checkout;
- `test/e2e/database-canonical-fence-pooled-postgres.test.ts`: the declaration through transaction-mode PgBouncer.

## What wave 5 may rely on

- `database_canonical_sources.mode`, `mode_epoch`, `eligibility_generation`, `database_canonical_brain.database_sources`,
  `persistence_requests.canonical_epoch`, `persistence_consumers.canonical_protocol` and
  `gbrain_source_publication_epoch(text)`; the store functions above keep their signatures.
- A database-mode source has no worktree-bound requests and no `git` or `withdrawal-mirror` effects, with no exemption:
  the exporter's batches are their own queue and never `persistence_effects` rows, so the exporter is the only checkout
  writer. It binds each batch to `mode_epoch` and `eligibility_generation`.
- Commit-push refuses only page paths of a database-mode source; the exporter's own commits go through its batch queue.
- `inflightWork` is the flip's in-flight check; wave 5 adds the unfinished-batch count there.
- The flip back keeps unmaterialized pages as `file_drift` holds; single-batch materialization in front of that step
  comes with wave 5's committing exporter.
