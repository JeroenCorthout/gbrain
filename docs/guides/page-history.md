# Page history

<!-- GBRA-217: PR A owns the reasons section; PR B wrote the valid-time section. -->

## Reasons

A page write (`put_page`, `edit_page`, `revert_version`, `put_pages`) can carry
a one-line `reason` (at most 500 characters; a reason that looks like it holds
a secret is refused `change_reason_rejected`). gbrain keeps it on the version the
write replaced, and `get_versions` shows it as `replaced_because`. On a page
whose file is committed, the commit also carries the trailer
`gbrain-reason: <path>: <text>`.

## Valid time

A page can say when its text takes effect. Put `valid_from` (and, if the text
stops applying, `valid_until`) in its frontmatter:

```yaml
---
title: Refund policy
valid_from: '2026-07-01'
valid_until: '2027-01-01'
---
```

The dates are part of the page, so on a brain with a Git repository they live
in the file and in every commit, and gbrain keeps them on each retained version.
The interval is half-open: the text is in force from `valid_from` up to, but
not including, `valid_until`, the same rule links use. Write the dates quoted.
An unquoted YAML date also works; a partial date (`2026-07`), a time of day or
another zone does not, and the write result warns `valid_from_unparsed`.

**Say to your agent:** *"What did our refund policy say on March 1?"* The agent
reads the page with `get_page {slug, as_of: '2026-03-01'}` (CLI:
`gbrain get <slug> --as-of 2026-03-01`).

Nothing changes until a page carries `valid_from` or a caller passes `as_of`.
There is no config key.

### Which tool records a change in effect

| The change | Record it as | as_of reads |
|---|---|---|
| The text of the page changes from a date on (a new edition) | edit the page in place and set `valid_from` to that date (keep the old date for a plain correction) | the edition whose `valid_from` is the latest on or before the date |
| A separate document changes part of it (an addendum, a rider) | an amendment record: its own page with an `amends` link to this page, dated by its `since` | the page's own edition; amendments dated after that edition and on or before the date are listed in `valid_time.amendments_not_applied`, not merged into the text |
| A new page replaces this one | a `supersedes` link from the new page | this page's editions only; follow the link for the new page |

### How the edition is chosen

The candidates are the current page and its retained versions. The answer is
the edition with the greatest `valid_from` on or before the date; when two
share that date, the one recorded last wins, as a correction of that edition.
Nothing is excluded by guesswork.

Some histories look alike: a corrected date, a renewal of unchanged text, a
backfilled old edition and a withdrawn scheduled edition all leave the same
shape. When the versions around the date have that shape (the same body under
another `valid_from`, or a version recorded later with an earlier
`valid_from`), the answer is still the rule's pick, and it says so:
`valid_time.uncertain: true`, `why: ambiguous_edition_dates`, with
`competing_version_ids`. Its `fix` asks the user which date the edition took
effect, then offers an `edit_page` that sets `valid_from`.

If the chosen edition is private (or below the caller's `min_trust`), a remote
caller gets the answer a private page gets: not found. It never falls back to an
older edition it may see. Reasons follow the same rule as `get_versions`.

### The answer

`valid_time` is in every answer:

| Field | Meaning |
|---|---|
| `as_of` | the date asked about, echoed |
| `status` | `in_force`, `not_in_force` (its `valid_until` has passed), `not_yet_in_force` (every edition starts later, and gbrain holds the page's whole history), `before_recorded_history` (every known edition starts later, but earlier editions may exist outside gbrain) |
| `chosen_version_id`, `chosen_is_current` | which edition was picked (`null` id for the current page) |
| `valid_from`, `valid_until` | the chosen edition's dates |
| `introduced_because`, `replaced_because` | the reasons given for the write that produced the edition and the one that replaced it |
| `history` | `retained`, `incomplete` or `unknown` |
| `uncertain`, `why` | whether to trust the pick, and the one reason not to |
| `undated_versions` | versions with no readable `valid_from`; they are never picked |
| `amendments_not_applied` | amendment records in force on the date that the text does not include |
| `recorded_since` | when gbrain recorded the chosen edition |

Only `in_force` returns the text at the top level. Any other status puts the
edition under `last_in_force` or `earliest_known`, so a reader that ignores
the status cannot quote expired or future text as current.

A large edition is returned in windows. Each `next` call carries the slug,
source, date and a cursor pinned to that edition, so the read stays on it even
if the page changes meanwhile.

On the CLI, `gbrain get --as-of` prints a `[gbrain] valid_time` line on
stderr. An `in_force` answer prints the page on stdout and exits 0. Any other
status prints `status:` and `why:` on stdout, no page, and exits 15
([exit codes](exit-codes.md)).

A plain read (`get_page`, `gbrain get`) of a page whose own `valid_from` is
after today, or whose `valid_until` has passed, also carries `valid_time`
(`status`, `as_of` today and both dates), and the CLI prints it on stderr.

### When history is incomplete

gbrain can only answer from the versions it kept. The answer says when that is
not enough, and only when it matters for the date asked about:

- `history_pruned` or `history_gap`: versions were pruned, or a sync imported
  several commits of the file at once, inside the chosen edition's span (or the
  date is before every retained edition). Dates the retained editions cover
  after the gap stay certain.
- `history_unknown`: the page has enough large or segmented versions that a
  prune may have run before gbrain recorded prunes.
- `before_recorded_history`: the page came from a file, so editions before
  its first gbrain version may exist in Git.
- `edition_pruned`: the edition a window cursor pinned is no longer retained;
  no text is returned.

The `fix` depends on where the missing history lives. For a page whose file
sits in a Git checkout, it is `git log --follow -p -- <path>` (a remote caller
gets it as a command to relay). For a private, database-only or unfiled page,
and on a brain with no Git repository, it asks the user for a retained copy or
a backup; retrying the read unchanged gives the same answer.

### Brains with no Git repository

The default keyless install has no Git repository, and valid time works the
same there: the dates are in the stored frontmatter of each version, the pick
and every status come from the database, and the recovery asks for a backup
instead of naming a Git command.

### Writes that keep or change the date

A write result can carry a `valid_time` advisory:

- `valid_time_correction`: the body changed and `valid_from` did not, so
  the change is read as a correction of the edition in force since that date.
  Set `valid_from` if the change takes effect later.
- `valid_time_date_only`: only `valid_from` changed. That is a question, not
  an error: is this a correction of the earlier date, or a renewal of unchanged
  text? as_of reads around those dates are marked `ambiguous_edition_dates`.
- `valid_from_unparsed`: `valid_from` is not a date gbrain can read.

### valid_time_undeclared

No retained version of the page has a readable `valid_from`. gbrain does not
invent one. The `fix` asks the user when the text took effect, then offers an
`edit_page` that adds a quoted `valid_from`. To ask what the brain had
recorded at a moment instead, read with `known_as_of` (recorded time).

### Refusals

`as_of` takes a calendar date. An instant is refused `clock_mismatch` with
reason `instant_for_date` ([clock mismatch](repair.md#clock-mismatch)). It does
not combine with `known_as_of`, or with `include_content` or
`content_only`: writing an old edition back would silently revert the page.
A slug that exists in two sources you can read is refused until you pass
`source_id`.

### host_upgrade_required

The gbrain CLI or an MCP client asked a host for `as_of`, and the reply did
not echo `valid_time.as_of`. An older host ignores the parameter and returns
the current page, so the client prints nothing and exits 16. The error names
the client version, the host version and the minimum host version. Run
`gbrain upgrade` on the brain host, or ask whoever runs it. Without
`valid_time` in a reply, the reply is the current page.
