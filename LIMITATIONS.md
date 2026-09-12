# Limitations

Written as each shortcut was taken, not reconstructed afterwards. Naming a weakness is more useful
than claiming nothing breaks.

### The forced-5xx failure path is tested against a local server, not GitHub

GitHub cannot be made to return a 500 on request. `tests/adapter.test.mjs` points the **real**
adapter — same code path, same retry and backoff — at a local HTTP server that fails on demand.
Nothing on the demo path uses that server.

### The Claude Code CLI fallback is not deployable, and it is 23x more expensive

The bot picks a model backend in this order: `ANTHROPIC_API_KEY` (the Anthropic API, and what the
deployed bot actually runs on), then `OPENROUTER_API_KEY`, then shelling out to
`claude -p --output-format json`.

That last fallback exists so the project runs on a machine with no API key at all, and it is a real
model call rather than a mock. But it is **local convenience only**: it uses the operator's own
interactive login, so it cannot be deployed to a server, and it is roughly **23x more expensive per
call** because the CLI injects about 22,000 tokens of its own scaffolding into every request — 946
real tokens against 21,863 billed, measured.

**Consequence, observed live during the build:** when that personal subscription hit its usage
limit the CLI exited non-zero and IOU treated it like any other model failure — it logged the error
and **said nothing**. A judgement call failed and the bot stayed silent rather than guessing. That
is the right failure mode, but it is also the reason the deployment uses the API and not the CLI.

The OpenRouter branch is complete code that has **never been exercised**: no key has ever been set
for it, locally or on the server, and not one call has been made through it.

### The repo-wide comment list is paged to exhaustion, and that was a correctness fix

This entry used to say the bot reads one page of results, framed as a scale limit. Measured on the
live playground it is a correctness bug, and the repository crossed the threshold during the build:
105 issue comments against a page size of 100.

`listIssueComments` is repo-wide and the ledger is an issue, so ledger entries compete for page
space with every pull-request comment in the repository. Page one held 14 of the ledger's 16
entries and dropped the two **newest** — the ones that decide current state. The bot reduced a
stale ledger, concluded a promise was "already filed" when the ledger said open, and stayed silent
on a pull request it should have spoken about.

Silence is this product's default. That is exactly why a bug whose only symptom is silence sat
unnoticed behind a line in this file. The list is now paged to exhaustion, capped at 10 pages, with
the cap logged rather than swallowed. The remaining limit is genuinely scale: past 1000 issue
comments the ledger needs fetching by issue number, which costs a ninth adapter operation and so
requires a decision about the cap.

### One repository, and bounded reads within it

The bot watches a single repository (`IOU_REPO`). Within it, the repo-wide comment list is paged to
exhaustion but capped at 10 pages (~1000 comments) per tick, and the open-pull-request list takes
the first 50. Hitting the comment cap logs a warning rather than truncating silently, because a
truncated ledger is a wrong answer and not merely a slow one.

Past those bounds the ledger would need fetching by issue number instead of filtering a repo-wide
list — which costs a ninth adapter operation, and the cap of eight is enforced by a test, so it is
a decision rather than a tweak.

### The judgement is a model's opinion, and it can be wrong

Deciding whether a diff keeps a promise is genuinely hard. IOU mitigates this rather than solving
it: a deterministic filter rules out unrelated pull requests before any model call, "cannot tell"
is treated as silence, the bot posts at most one comment per pull request, and nothing is filed
without a human reacting 👍. So a wrong judgement costs one comment that a 👎 dismisses — it never
files anything, and it never edits code.

### Evidence files older than 16:37 cite ledger comments that no longer exist

Every evidence file records real GitHub objects created by a real run; none of it was fabricated.
But five of the comment URLs the older files cite now 404, because the project deletes them itself:
`scripts/record.mjs setup` and `scripts/demo.mjs reset` empty the ledger by `DELETE`-ing every
comment on it, which is how a demo is staged with exactly one open promise. The end-to-end test's
own teardown does not do this — it closes pull requests and branches and leaves its evidence
intact — so the loss came from staging a recording hours after those runs.

`feature_list.json` cites `evidence/live-2026-09-12T16-37-30-134Z.json`, whose every URL and
`#issuecomment-` anchor was checked anonymously against the public playground and returns 200. The
older files are kept unedited as the historical record rather than quietly rewritten; the dead
anchors in them are 5645317842, 5645328113, 5645360039, 5645465704 and 5645724654.

The underlying bug is unfixed: stage another recording and it will delete the current evidence too.
The fix is for staging to close and relabel the old ledger rather than empty it.

### The playground repository's code is ours

The repository the demo runs against was seeded with two small modules so the pull requests have
real diffs. The pull requests, comments, reactions and issues in the demo are all real GitHub
objects created through the API, not fixtures.
