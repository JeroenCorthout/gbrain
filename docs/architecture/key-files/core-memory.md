# Always-loaded core memory (key files cluster)

[Subsystem index](../KEY_FILES.md).

Owner-designated pages (`always_load: true`) rendered into every session,
held to a brain-wide character budget on the write path, plus the
save-before-compaction path (`remember` with `items`, the context-pressure
notice). User guide: [core memory](../../guides/core-memory.md).

- `src/core/core-memory.ts`: marking and priority normalization, settings
  (`memory.core.*`), page rendering and budget accounting, `listCorePages`
  (withdrawal-aware; a page stored in segments is read back whole up to 24 MiB,
  through `materializedSnapshot` when withdrawn, and a larger one is left out
  unread and counted by doctor `core_memory` as `skipped_segmented`,
  `test/large-pages/segmented-core-list.test.ts`), `renderCoreBlock` (whole-page truncation, notice lines,
  withheld lines), `coreRevision`, the delivery sensitivity policy
  (`applyCoreSensitivity`: credential-like hits withhold, contact details and
  private paths redact) and `loadCoreBlock`, which every delivery lane uses.
- `src/core/persistence/core-guard.ts`: the write-path guard run from
  `preparePageMutation`: owner-only marking (`core_mark_owner_only`,
  `core_delete_owner_only`), the budget (`core_budget_exceeded`, re-checked in
  the publish transaction), the remote-edit policy and `core_edit_notices`
  rows, and `lockCoreSources`.
- Lock order for a core-touching publish (`coordinator.ts`): worktree native
  lock, then the protocol declaration takes the brain row first
  (`declareDurablePersistence` in `protocol.ts`, `persistence_brain` FOR
  SHARE), then `guardOwnership` (`persistence_worktrees` FOR SHARE), then
  `lockCoreSources` (`sources` rows FOR UPDATE, `ORDER BY id`, own source plus
  `default`) in the source-exclusive slot, then `authorizeStoredRequest`
  (`sources` FOR SHARE), then `lockCounters`: the global order `protocol.ts`
  documents. `put_pages` batch groups skip the per-request source lock, so
  `groupable()` excludes core-locked writes.
  `test/e2e/core-memory-locks-postgres.test.ts` races core writes against
  topology changes and a claim-shaped transaction on Postgres.
- `scripts/check-core-guard-coverage.mjs` (`bun run check:core-guard-coverage`,
  in `verify`): every PreparedMutation builder routes through the guard or is
  on its reviewed exemption list, and wrappers forward `exclusiveSources`.
- Delivery: `src/commands/hook.ts` session-start (core first via
  `src/core/context/session-start-output.ts`), `context_pack`
  (`src/core/ops/facts.ts`, `src/mcp/context-pack-handler.ts`, including the
  read-only `coreOnly` IPC arm), OpenClaw `assemble()` in
  `src/core/context-engine.ts` through `src/core/context/openclaw-core.ts`
  (60 s memo keyed on the trust cache identity from
  `src/core/eligibility/generation.ts`, revalidated on every delivery: the
  `coreOnly` arm answers `coreTrust.unchanged` for a matching
  `coreIdentity`; a failed or timed-out refresh delivers no core block,
  never the memo), and `gbrain compile-context
  --include-core` (`src/core/context/compile-view.ts`,
  `src/core/context/compiled-core.ts` for git safety and the record doctor
  reads).
- Pressure notice: `src/core/context/pressure.ts` (gate read by serve, transcript
  scan, window detection, once-per-segment state); wired in the user-prompt
  hook and OpenClaw `assemble()`.
- `src/core/remember-batch.ts`: `remember` with `items[]` (all-or-none
  validation, deterministic child request ids, per-item status; #7248: an
  item still publishing is `pending` with its `target`, not `failed`; #7432:
  every item field but `fact` and `replaces`, `entity`, `content_origin` and
  `valid_from` included, is also a top-level default an item's own value overrides).
- `src/commands/core.ts` (`gbrain core`), `src/commands/doctor/checks/core-memory.ts`
  (`core_memory`), schema `src/core/core-memory-schema.ts` + migration v213.
- Tests: `test/core-memory.test.ts`, `test/core-guard.test.ts`,
  `test/core-cli.test.ts`, `test/compile-context-core.serial.test.ts`,
  `test/context-pressure.test.ts`, `test/remember-batch.test.ts`,
  `test/remember-batch-entity-7432.test.ts`,
  `test/trust-cache-invalidation.test.ts` (core lane after trust transitions),
  `test/e2e/core-memory-locks-postgres.test.ts`.
- `src/core/entities/near-name.ts` — Flag-only near-name matcher for #2942 (never merges, never writes `entity_identities`; `entity-identity.ts` stays manual-only). `classifyNearName` returns `same` (normalized-equal after corporate suffixes, or a strong `name-variants.ts` shape), `typo` (Damerau distance 1 on 3–64 normalized characters) or `acronym` (one word equals a multi-word name's initials, at most one letter different). Candidates come from symmetric one-deletion keys plus initials keys, so recall is complete for those kinds; past `NEAR_NAME_MAX_KEYS_PER_SHARD` the index splits into shards by key hash (a pair shares a key, so it lands whole in one shard). `loadEntityNames` reads one source's fact-entity pages plus the source pack's linkable types, leaving out private pages for callers that exclude them. Pinned by `test/review-lists.test.ts`.
- `src/core/review-lists.ts` — The two lists `extraction_pending` adds beside `pending`: `unattributed` (active facts with no entity, newest first, world-only for remote callers, each with a `remember` + `entity` + `replaces` relink action, never a forget) and opt-in `possible_duplicates` (entity pages created in the last `since_days` whose name is near another entity's name or alias; pairs in `aliases` or `distinct_from` are skipped). The duplicates cursor walks recent pages within a shard, then the next shard, and reports `complete` only after the last shard; index builds are serialized per process. Pinned by `test/review-lists.test.ts` and the Postgres parity file.
