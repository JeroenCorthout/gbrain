# Database-canonical memory, wave 3 contract

Wave 3 of [the database as the source of truth](DATABASE_CANONICAL_MEMORY.md) (Phase 2 in its rollout table): the import
lane in observe mode, the `import_conflicts` table, the hold-code to conflict-kind mapping and the foreign-writer census.
It builds on [the wave 2 contract](database-canonical-w2-contract.md). Everything ships default-off: the migration only adds
three empty tables, nothing converts or backfills on upgrade, and the lane runs only for a source whose shadow flag is on
while the brain gate (`persistence.database_canonical.enabled`) is on. In observe mode it writes nothing but its own tables:
no page, no ledger row, no file, ref or index entry in the checkout.

## Tables

DDL: `src/core/persistence/import-conflicts-schema.ts` (`IMPORT_CONFLICTS_SCHEMA_SQL`), applied by migration v271
(renumbered at merge) and generated into its own `src/schema.sql` region after wave 2's.

| Table | Key | What it holds |
|---|---|---|
| `import_conflicts` | `id`; unique `(source_id, path_folded)` over open rows | What the lane would do with each outside change to a page path: `outcome` (the would-have action), `kind` (set exactly when the outcome is `conflict`), `state` (`open`, `resolved`), `resolution` (`superseded`, `cleared`, `epoch_changed`), `mode` (`observe`), `shadow_epoch` it was observed under, `base_revision` and `base_sha256` (the ledger row), `db_revision`, `file_sha256`, `file_size`, `file_bytes` (a would-be conflict's bytes, inline up to 24 MiB), `file_ref` (above 24 MiB: the private ref a live lane would pin; observe mode names it and never creates it), `commit_sha`, `merge` (would-have-merged field counts), `detail` (the decision's reason, a screen's code). |
| `import_foreign_writes` | unique `(source_id, path_folded, change_key)` | The foreign-writer census: one row per commit that changed a page path (`change_key` = the commit) or per uncommitted worktree bytes (`worktree:<sha256>`), with author, committer, the commit message's first line (at most 72 characters), a process hint and the `writer_key` the census groups by. |
| `import_lane_passes` | `id` | One row per pass: epoch, HEAD it scanned up to (the next pass walks back to it), commits read, paths scanned, paths deferred as unstable, outcome and kind counts. |

## The lane

`src/core/persistence/import-lane.ts` (`observeImportLane(engine, sourceId, opts)`), scheduled by
`import-lane-watch.ts` (a full pass at start, a pass over the paths a recursive file watch reports, and a full pass every
minute as the polling fallback). Git is read with hardened plumbing only (`import-lane-git.ts`: `rev-parse`, `ls-files`,
`ls-tree`, `cat-file --batch`, `diff-tree -r -z --no-renames`), so no filter driver, textconv or hook ever runs.

- **Unchanged** means the file's raw bytes still hash to the ledger's `disk_sha256`: an autocrlf or LFS checkout whose
  bytes differ from the committed blob does not look edited.
- **Stable bytes:** every candidate is hashed, the pass waits `stableMs` (2 s), hashes again and defers a path whose
  bytes moved; it is counted in `unstable` and read again by the next pass.
- **Binding:** the writes run in one transaction that re-reads the shadow flag, its epoch and the brain gate under
  `FOR SHARE`; a pass whose source flipped meanwhile records nothing. The first pass of a new epoch resolves the older
  epoch's open rows (`epoch_changed`). Shadow off stops the watch lane; its tables then stay inert.
- **Deletion evidence (#7130):** a missing exported file is a deletion only when a walked commit deleted it, or the ledger's
  `commit_sha` held the path and HEAD does not. Deletions above the sync mass-delete valve (`syncDeleteTrip` with the
  source's caps) become `bulk_delete` conflicts sharing one `detail.batch_size`.

## Decision table

`decideImportCase` (pure), rows in order, for a changed path with ledger row (revision r0), page revision r1 and file F:

| Case | Outcome |
|---|---|
| F gone, no ledger row | `none` (never exported) |
| F gone, still committed at HEAD | conflict `deleted_uncommitted` |
| F gone, page deleted in the database too | `none` (both deleted) |
| F gone, no commit removed it | `none` (`deletion_unproven`: absence is not deletion) |
| F gone by a commit, r1 = r0 | `delete` (or `bulk_delete` above the valve) |
| F gone by a commit, r1 ≠ r0 | conflict `deleted_vs_edited` |
| F over 24 MiB, r1 = r0 | `streamed_import` |
| F over 24 MiB otherwise | conflict `too_large_for_lane` |
| F fails a content screen (UTF-8, size, frontmatter, slug, fences, purge, gates) or is not a regular file | conflict `unparseable` with the screen's code |
| F equal to the live page (the equality contract) | `adopt` |
| no ledger row, a live page | conflict `unexported_collision` |
| no ledger row, no page | `create` |
| ledger row, page deleted since export | conflict `both_changed` |
| r1 = r0, a protected key changed | conflict `protected_metadata` |
| r1 = r0 | `import` |
| otherwise (segmented pages included, never compared partially) | conflict `both_changed` |

For every `both_changed` row on an inline page with a base blob, `merge` counts fields (title, type, body, timeline, the
tag set, each frontmatter key; absent counts as a value) by side: `file_only`, `database_only`, `both_same`,
`both_differ`, and `resolvable` when no field differs on both sides. A row without a base blob or on a segmented page has
`merge` null.

## Hold-code to conflict-kind mapping

`HOLD_CONFLICT_KINDS` (`src/core/persistence/import-conflict-mapping.ts`) is keyed by every `GitHoldCode`, so a new hold
code does not compile without a row. `reclassify`: the hold is about the writer, not the file, and the lane reads the path
again. `out_of_lane`: not a page file. `holdConflictKind(code, meta, provenance)` applies the refinements. The table below
is pinned to the data by `test/database-canonical-import-lane.test.ts`.

<!-- hold-conflict-kinds:begin -->
| Hold code | Conflict kind | Refinements |
|---|---|---|
| `absent_from_worktree` | `deleted_uncommitted` | |
| `concurrent_write` | `both_changed` | |
| `content_null_bytes` | `unparseable` | |
| `content_rejected` | `unparseable` | |
| `file_drift` | `both_changed` | deleted `file_gone`: `deleted_by_commit` → `deleted_vs_edited`, `deletion_uncommitted` → `deleted_uncommitted`, `never_committed` or ignored → `never_exported`, otherwise `deleted_vs_edited`; `tombstone_edited`, `purged_differs` → `both_changed` |
| `file_too_large` | `too_large_for_lane` | |
| `file_unreadable` | `unparseable` | |
| `frontmatter_alias_limit` | `unparseable` | |
| `frontmatter_slug_conflict` | `unparseable` | |
| `git_object_missing` | `unparseable` | |
| `invalid_fence` | `unparseable` | |
| `invalid_frontmatter` | `unparseable` | |
| `legacy_slug_conflict` | `identity` | |
| `managed_image_sync_unsupported` | `out_of_lane` | |
| `origin_conflict` | `identity` | |
| `page_identity_changed` | `identity` | |
| `page_write_failed` | `reclassify` | |
| `parser_regression` | `unparseable` | |
| `path_not_utf8` | `unparseable` | |
| `preparation_stalled` | `reclassify` | |
| `purged_content` | `unparseable` | |
| `rename_held` | `unparseable` | |
| `rename_identity_unreadable` | `identity` | |
| `rename_reconcile_failed` | `identity` | |
| `settle_mismatch` | `reclassify` | |
| `unsupported_path` | `out_of_lane` | |
| `worktree_dirty` | `reclassify` | reason `deleted_locally` → `deleted_uncommitted` |
| `write_gate_rejected` | `unparseable` | |
| `write_interrupted` | `reclassify` | |
<!-- hold-conflict-kinds:end -->

## Foreign-writer census

`PROCESS_HINTS` (`import-lane-git.ts`) is data, first match wins: `gbrain_git_effect` (the managed Git effect's
`gbrain: persist ... canonical memory update` subject; gbrain-owned, the exporter replaces it, never a writer to move),
`gbrain_commit_push`, `gbrain_sources_push`, `agent_session` (a co-author trailer naming an agent, assistant or bot),
`automation` (a bot or cron identity), `auto_commit_message`; no hint otherwise. Writers group by author address and hint.

## Surfaces

- `gbrain sources canonical <id> --census [--sample <n>] [--json]`: read-only; the would-be conflicts by kind with samples,
  open outcomes, the merge counts, writers that would need moving (gbrain's own Git effect left out) and uncommitted edits.
- `gbrain sources canonical <id> --observe [--watch] [--json]`: one lane pass (or the watch lane until shadow turns off or
  the process stops). It writes only the lane's own tables; it refuses `import_lane_shadow_off` while shadow is off.
- Both refuse `database_canonical_disabled` while the brain gate is off. Trusted local CLI only; no MCP operation.
- Doctor `database_canonical_census`: green while the gate is off, while no source is shadowed and while no writer other
  than gbrain's own Git effect committed a page file of a shadowed source in the last 7 days; yellow otherwise, listing
  the writers and naming `gbrain sources canonical <id> --census`.

## What wave 4 may rely on

- The table, column, outcome, kind, state and resolution names above, and `decideImportCase`, `mergeCounts`,
  `holdConflictKind` and `HOLD_CONFLICT_KINDS`. Adoption writes `mode` values a live lane adds to the CHECK list.
- One open row per source and folded path is the parking key: a path with an open conflict row is the path the exporter
  must skip once the lane is live.
