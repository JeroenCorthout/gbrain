# Database-canonical memory, wave 2 contract

Wave 2 of [the database as the source of truth](DATABASE_CANONICAL_MEMORY.md) (Phase 1 in its rollout table):
the export ledger, the export outbox and its triggers, the per-source shadow flag, the shadow consumer and diff,
the ledger seed and the `gbrain sources canonical <id> --shadow` verb. This page is the contract later waves build
on. Everything ships default-off: the migration only adds tables, functions and triggers, nothing is converted or
backfilled on upgrade, and nothing runs until an operator turns shadow on for a source.

## Tables

DDL: `src/core/persistence/canonical-schema.ts` (`DATABASE_CANONICAL_SCHEMA_SQL`), applied by migration v270
(renumbered at merge) and generated into the `src/schema.sql` region of the same name. All six tables have RLS
enabled where the role allows it, cascade with their source, and carry verbatim through engine graduation.

| Table | Key | What it holds |
|---|---|---|
| `database_canonical_sources` | `source_id` | The durable per-source flag: `source_incarnation`, `shadow` (bool), `shadow_epoch` (bumped on every flip), `shadow_changed_at`. One row per source that ever had shadow turned on. W4 adds `mode` and `mode_epoch` columns here. |
| `database_canonical_brain` | singleton | `active_sources`: how many rows have `shadow` true. A statement trigger on `database_canonical_sources` recounts it, so it cannot drift from the flags. W4 counts database-mode sources here too. |
| `export_outbox` | `(source_id, page_id)` | One coalesced row per page with unprocessed changes: `slug`, `revision` (the page's `knowledge_revision`, null when the page left the source), `cause`, `seq` (from `export_outbox_seq`, bumped on every upsert), `first_enqueued_at` (kept across upserts, so its minimum is export lag), `enqueued_at`. |
| `export_ledger` | `id`; live unique on `(source_id, path_folded)` and `(source_id, page_id)`; unique `(source_id, page_id, lifetime)` | What each exported path holds: `page_id`, `lifetime`, `path` (checkout-relative POSIX), `path_folded` (`exportPathKey`: the export stage's NFC plus case fold), `revision`, `disk_sha256` (raw bytes on disk), `blob_oid`, `renderer_fp` (null for bytes gbrain did not render), `commit_sha`, `seeded_from`, `exported_at`, `retired_at` (null = live). |
| `export_shadow_batches` | `id` | One row per consumer batch: `shadow_epoch`, `outbox_rows`, `counts` (diff kind to count), `unexpected`, `renderer_fp`, `started_at`, `finished_at`. |
| `export_shadow_diffs` | `(source_id, page_id)` | The latest would-be export of each page against its file: `batch_id`, `slug`, `path`, `revision`, `kind`, `expected`, `ledger_revision`, `disk_sha256`, `detail` (for example the differing fields). Bounded by the page count. |

`outbox.cause`: `created`, `written`, `deleted` (soft delete), `moved_out` (the page moved to another source),
`purged` (hard delete), `withdrawal`. `ledger.seeded_from`: `sync_provenance` (wave 2 seed), `shadow_adopt`
(wave 2 consumer), `export`, `import_lane`, `adoption` (later waves).

## Trigger semantics

- `pages`: three row-level AFTER triggers. INSERT and DELETE always call the function; UPDATE calls it only when
  `knowledge_revision`, `slug`, `source_id`, `deleted_at` or `database_only_reason` changes, so embedding,
  telemetry and extraction stamps never reach it. Tag, body and frontmatter changes all move `knowledge_revision`.
- `fact_withdrawals` and `fact_purges` (what `readExportWithdrawals` overlays): a row-level AFTER trigger on insert,
  update and delete enqueues the live pages of the source the withdrawal can change without reading any page body:
  the page whose slug is the withdrawal's subject, and every page whose fence holds a matching claim
  (`facts.source_markdown_slug` of the facts rows with that visibility, subject and fingerprint, served by
  `idx_facts_withdrawal_fingerprint`). The writers that withdraw also move the page's revision, so the pages trigger
  covers a fence the facts index has not projected yet.
- Every trigger first reads `database_canonical_brain` and returns when `active_sources` is zero or the row is
  absent. Only then does it check the source's flag. A brain with no shadowed source pays one primary-key lookup per
  changed page row; the test pins that the per-source function is never called.
- Rows are written by the committing transaction, so the outbox is complete regardless of commit order: two requests
  that commit in reverse sequence order both appear, and so does a bare coordinated write with no request. The brain
  gate (`persistence.database_canonical.enabled`) is not read by the triggers; turning a source's shadow off is what
  stops its rows.
- A consumer never keeps a seq watermark. It reads rows in seq order and deletes each only while it still has the seq
  it read (`consumeExportOutbox`), so a write that lands while a batch is processed leaves its row for the next batch.
- A flip runs under `lockExportWriters` (`LOCK TABLE pages, fact_withdrawals, fact_purges IN SHARE MODE`), so every
  write either committed before the flip or runs its trigger after it.

## Store functions

`src/core/persistence/canonical-shadow.ts`, plain SQL over `SqlEngine` like the rest of `persistence/` (not
`BrainEngine` methods: no engine façade grows, and every caller is a trusted local command):

```ts
readSourceCanonicalState(exec, sourceId): Promise<SourceCanonicalState | null>
sourceShadowEnabled(exec, sourceId): Promise<boolean>
listShadowedSources(exec): Promise<string[]>
lockExportWriters(tx): Promise<void>
writeSourceShadow(tx, sourceId, shadow: boolean): Promise<SourceCanonicalState>
readExportOutbox(exec, sourceId, limit): Promise<ExportOutboxRow[]>
consumeExportOutbox(exec, rows): Promise<number>
exportOutboxStats(exec, sourceId): Promise<{ depth; oldest_age_seconds }>
readLiveLedgerRows(exec, sourceId, pageIds): Promise<Map<number, ExportLedgerRow>>
```

Phase B adds, in the same module family: the ledger seed from `SyncImportProvenance`, the shadow consumer
(`drainExportShadow(engine, sourceId, { limit })`, which writes batches, diffs and `shadow_adopt` ledger rows), the
shadow status read the doctor check and the verb share, and the preview-bound verb in
`src/commands/sources-canonical-shadow.ts`.

## Diff kinds

`SHADOW_DIFF_KINDS` (canonical-schema.ts) is the CHECK list; `UNEXPECTED_SHADOW_DIFF_KINDS` (canonical-shadow.ts)
the red ones. "Ledger matches" means the file's raw SHA-256 equals the ledger row; "equal" is wave 1's equality
contract (`compareInlineExportFile`, `compareSegmentedExportFile`).

| Kind | When | Expected |
|---|---|---|
| `equal` | file equal, ledger matches at the current revision | yes |
| `adopt` | file equal, ledger missing or stale: the consumer records the file's hashes (`shadow_adopt`) | yes |
| `write` | file differs, ledger matches at an older revision: the exporter would rewrite it (lag) | yes |
| `create` | eligible page, no file, no ledger row | yes |
| `remove` | page gone or moved out, ledger matches the file: the exporter would remove it | yes |
| `absent` | page gone, no file | yes |
| `ineligible` | page may not be exported (`exportIneligibility`) and has no file, or only an ignored or mirror one | yes |
| `file_deleted` | eligible page with a ledger row, file missing: the import lane's deletion case | yes |
| `outside_edit` | file differs from the ledger, database unchanged since the ledger revision: the lane would import it | yes |
| `both_changed` | file differs from the ledger and the database moved on (or deleted the page) | yes |
| `unexported_collision` | file exists, differs, no ledger row | yes |
| `unparseable` | file fails the equality contract's parse | yes |
| `no_checkout` | the source has no readable checkout | yes |
| `render_mismatch` | ledger matches at the current revision, but the file is not equal to the render: the renderer disagrees with bytes imported at this very revision | **no** |
| `ineligible_file` | a private, alias-private, database-only or `db_only` page has a file in the checkout | **no** |
| `unsafe_path` | the page's slug has no safe file path | **no** |
| `path_collision` | another live ledger row holds the same folded path | **no** |

## What wave 3 may rely on

- **Is shadow on for this source?** `sourceShadowEnabled(exec, sourceId)` or `listShadowedSources(exec)`; both read
  `database_canonical_sources.shadow`. Bind observations to `shadow_epoch` (`readSourceCanonicalState`) when a flip
  should invalidate them. Also require the brain gate (`databaseCanonicalEnabled`, wave 1) before starting work.
- **The base.** `export_ledger` live rows (`readLiveLedgerRows`): `path`, `path_folded`, `revision`,
  `disk_sha256`. In shadow, wave 2's seed and consumer are its only writers; the observe-mode lane reads it and does
  not write it. A page without a live row has no base ("no base" in the shadow report).
- **Paths.** `path_folded` is `exportPathKey(path)` from `src/core/export-stage.ts`; key `import_conflicts` on the
  same fold so conflicts and ledger rows join.
- **Your tables.** Put `import_conflicts` and anything else in a new fragment module
  (`src/core/persistence/import-conflicts-schema.ts`), a new region in `src/schema.sql` after this wave's region, a new
  `FRAGMENTS` entry and your own migration, plus graduation inventory rows. Do not edit `canonical-schema.ts`, so the
  two waves merge without conflicts.
- **Your doctor check.** A new topic file `src/commands/doctor/checks/database-canonical-import.ts`, registered right
  after `databaseCanonicalShadowEntry` in `src/commands/doctor/registry.ts` and named in `doctor-categories.ts`.
- **Your verb.** `src/commands/sources-canonical.ts` keeps parsing and routes each action to its own module
  (`--dry-run` census, `--shadow`, `--purge-shadow`, `--shadow-drain`, `--shadow-status`). Add your action as one more
  route to a module of your own; reuse `requireSourceCanonicalIntent` and the fingerprint helper wave 2 adds for any
  state change.
- **Stable names.** The table and column names above, the diff kind and cause lists, and the store function
  signatures do not change without a note in the wave 2 PR.
