# Page history: why a page changed

**Say to your agent:** *"Update the refund policy to a 30-day window, and record that the client asked for it."*

Every page write in gbrain keeps the text it replaced as a version. A write can
also carry a short human reason, so the history says why the text changed, not
only that it did. This guide covers how to give a reason, where it is stored,
who can read it, and what happens on a brain with no Git repository.

## Reasons

Pass `reason` on `put_page`, `edit_page`, `revert_version` or on any item of
`put_pages`:

```json
{ "slug": "policies/refunds", "expected_revision": "…", "content": "…",
  "reason": "Client asked for the 30-day window." }
```

The parameter is listed on the full MCP tool surface. The starter surface leaves
it out of the tool schemas to keep them small, but still accepts it, so an agent
on the starter surface can pass it too. On the CLI the same parameter is `--reason`, for example
`gbrain put policies/refunds --reason "Client asked for the 30-day window." < refunds.md`.

A reason is one line of at most 500 characters. Tabs and line breaks become
spaces, other control characters are removed, and an empty reason counts as
none. It is checked before the write is accepted, so a refused reason leaves no
copy anywhere:

- longer than 500 characters: `change_reason_rejected` with reason
  `reason_too_long` (the wire `error` is `invalid_params`), naming the length
  and the limit;
- it looks like it holds a credential: `change_reason_rejected` with reason
  `reason_contains_secret`, naming the detector and the character position,
  never the value.

Shorten the reason or remove the secret, then send the write again. The reason
is part of the request's identity: replaying a `request_id` with the same
reason replays the write, and replaying it with a different reason is a
conflict. In `put_pages`, one refused reason refuses the whole batch and names
the item; two copies of a page with the same reason are written once, and two
copies with different reasons are refused.

### Where the reason is stored

A version is the page as it was before a write. So the reason is stored on the
version that write archived, and `get_versions` shows it on that version as
`replaced_because`. The newest version's `replaced_because` explains the text
you read now. `gbrain history <slug>` prints it as `changed because: …` under
each version.

A page's first write archives nothing, so its reason has no version to sit on.
Every write result says where its reason went in `reason_recorded`:

| Field | Meaning |
|---|---|
| `reason` | The reason as stored, after the cleanup above. |
| `version` | `true` when a version carries it. |
| `version_why` | Why no version carries it: `page_created` (first write) or `no_change` (the write changed nothing). |
| `git` | Where Git stands, below. |

`git` is one of:

- `committed`: on a git-canonical source the commit landed with the write.
- `queued`: the file's commit is queued and will carry the reason.
- `superseded`: a newer write to the same file committed first (shown on the
  receipt, `get_write_request`, with a `reason_not_committed` notice). The
  reason stays in gbrain's history but is in no commit. Nothing needs fixing,
  and retrying the write would be wrong.
- `private`: the page is private, so its reason stays out of every commit
  message, group commits for other pages included.
- `not_file_backed`: the page has no file (database-only), so the reason is in
  gbrain's history only.
- `no_repository`: the brain has no Git repository (below).
- `none`: the write changed nothing.

### In Git

When the page's file reaches Git, its commit carries the reason as a trailer
naming the file:

```
gbrain-reason: policies/refunds.md: Client asked for the 30-day window.
```

There is one trailer per file, in the same trailer block as any
`gbrain-repair:` trailer, so `git interpret-trailers --parse` lists them all.
A write without a reason commits exactly the message it did before. A commit
you make yourself can give a reason the same way:

```bash
git commit --trailer "gbrain-reason: policies/refunds.md: Client asked for the 30-day window."
```

A pushed commit message cannot be changed, so treat a reason like any other
text you push. There is no operation to add a reason to a past write.

### Repo-less brains

A brain without a Git repository, such as the default keyless install, gets the
same feature. The database is the record there: the reason is stored on the
version by the same write, `get_versions` shows it the same way, and
`reason_recorded.git` is `no_repository`. Nothing is refused because there is no
repository. If you connect a repository later, the reasons already stored stay
where they are; old versions are not rewritten into commits.

### Who can read a reason

A trusted local caller sees every stored reason. A remote caller (an MCP client)
sees a version's reason only when both that version and the version that
replaced it are world-visible. The reason for turning a page private, or for
any change made while it was private, is therefore never shown remotely. When
the replacing version was later pruned (large pages keep a few versions), its
visibility can no longer be checked and the reason is withheld from remote
callers. Remote reasons go through the same text sanitizer as version bodies.

## Choosing how to record a change

A reason explains an edit to one document. Pick the shape that matches what
happened:

| What happened | Do this |
|---|---|
| The same document changed (a new edition, a correction) | Edit the page in place with `expected_revision` and a `reason`. |
| A separate document amends part of it | Write the amendment as its own page with an `amends` link (`since` the date it applies). |
| A different document replaces it entirely | Keep both pages and add a `supersedes` link from the new one. |

Do not create a second page for a new edition of the same document: the
history of one page, with reasons, is what readers and agents follow.
