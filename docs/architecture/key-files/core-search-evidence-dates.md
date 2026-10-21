# Key files: Core Search (evidence relative dates)

[Subsystem index](../KEY_FILES.md) · [Core Search (2/2)](core-search-2.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `src/core/search/evidence-relative-dates.ts` — `search.evidence_resolve_dates` (default off): `resolveRelativeDatesInTurns` brackets relative phrases in positively identified user turns with the absolute date resolved from `temporal-grammar.ts` against the block's observation day (skips direction-qualified, session-day, midweek next-weekday, 'X of Y', possessive, fenced and turn-stamped text); `dateBracket` (day / month / year / range, `≈` for ago-midpoints and weeks); `withRelativeDates` wraps `deliverEvidence` after redaction: annotate, re-pack once under a lowered budget on overflow, else return the unannotated delivery with `relative_dates_over_budget` (`relative_dates_unavailable` on a day-lookup error); `delivery.relative_dates.insertions`. Tests: `test/evidence-relative-dates.test.ts`.
- `src/core/search/speaker-line.ts` — the speaker-label grammar (`SPEAKER_LINE`, `FENCE_LINE`, `speakerName`) shared by evidence delivery's conversation-round cuts and the relative-date resolver, so both detect turns the same way.
