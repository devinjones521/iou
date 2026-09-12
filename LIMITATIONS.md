# Limitations

Written as each shortcut was taken, not reconstructed afterwards. Naming a weakness is more useful
than claiming nothing breaks.

### The forced-5xx failure path is tested against a local server, not GitHub

GitHub cannot be made to return a 500 on request. `tests/adapter.test.mjs` points the **real**
adapter — same code path, same retry and backoff — at a local HTTP server that fails on demand.
Nothing on the demo path uses that server.

### The Claude Code CLI fallback is not deployable, and it costs 23x more per call

The bot picks a model backend in this order: `ANTHROPIC_API_KEY` (the Anthropic API, which is what
the deployed bot runs on), then `OPENROUTER_API_KEY`, then shelling out to
`claude -p --output-format json`.

That last fallback exists so the project runs on a machine with no API key at all, and it makes a
real model call rather than a mock. But it is local convenience only. It uses the operator's own
interactive login, so it cannot run on a server, and it costs roughly **23x more per call** because
the CLI injects about 22,000 tokens of its own scaffolding into every request: 946 real prompt
tokens against 21,863 billed, measured.

It also inherits that subscription's quota. When the quota runs out the CLI exits non-zero, IOU
treats it as it treats any model failure — logs the error and **says nothing**. That is the right
failure mode, and it is the reason the deployment uses the API.

The OpenRouter branch is complete code that has **never been exercised**: no key has ever been set
for it, and not one call has been made through it.

**One failure on that path was never explained.** Two early runs recorded zero promises because
every classification failed with `llm timeout after 60000ms`. Four causes were tested and all four
ruled out: Windows shell quoting mangling the prompt (exits in 9.5s with a wrong answer, never
hangs), contention between concurrent processes (five calls at peak load, 2.8–7.3s), an inherited
unclosed stdin (about 3s), and Node's test-runner variables leaking into the child (6.0s clean
against 5.1s with them set, both exit 0). The classifier itself was then proven correct standalone
on three fixtures, so it is neither a prompt nor a parsing problem.

Investigation stopped there rather than continuing without new evidence. The fault has not recurred
across the runs since, and it has never appeared on the API path the deployment uses. It is
recorded because the alternative is pretending every failure got an answer. The blast radius is
bounded by design: the timeout is per call, every failure is fail-closed, so the worst case is a
bot that says nothing rather than one that invents a promise.

### One repository, and bounded reads inside it

The bot watches a single repository, named by `IOU_REPO`.

Inside it, the shape of the GitHub API works against the design. The ledger is an issue, but the
only way to read comments across a repository in one call is `GET /issues/comments`, which is
repo-wide — so ledger entries share a page budget with every pull-request comment in the repo. The
adapter pages that list to exhaustion, capped at 10 pages (about 1000 comments) per tick, and takes
the first 50 open pull requests. Hitting the comment cap logs a warning rather than truncating in
silence, because a ledger read that stops early is a wrong answer rather than a slow one.

This matters more than a scale limit sounds, because the failure is invisible. A ledger read that
misses the newest entries makes the bot believe an old state and stay quiet — and staying quiet is
this product's normal output, so there is nothing to see. Past those bounds the ledger needs
fetching by issue number instead, which costs a ninth adapter operation against a cap of eight that
a test enforces. That is a deliberate decision, not a tweak.

### The judgement is a model's opinion, and it can be wrong

Deciding whether a diff keeps a promise is genuinely hard. IOU mitigates this rather than solving
it: a deterministic filter rules out unrelated pull requests before any model call, "cannot tell"
is treated as silence, the bot posts at most one comment per pull request, and nothing is filed
without a human reacting 👍. A wrong judgement therefore costs one comment that a 👎 dismisses. It
never files anything and it never edits code.

### Staging a demo deletes ledger comments that older evidence files cite

Every evidence file records real GitHub objects created by a real run; none of it is fabricated. But
five comment URLs in the older files return 404, and the cause is this project's own tooling:
`scripts/record.mjs setup` and `scripts/demo.mjs reset` empty the ledger by `DELETE`-ing every
comment on it, which is how the repository is staged to hold exactly one open promise before a
recording. The end-to-end test's own teardown does not do this — it closes pull requests and
branches and leaves its evidence intact — so the loss comes from staging a recording after the fact.

`feature_list.json` cites `evidence/live-2026-09-12T16-37-30-134Z.json`, whose every URL and
`#issuecomment-` anchor resolves anonymously against the public playground. The older files are kept
exactly as written rather than quietly repaired; the dead anchors in them are 5645317842,
5645328113, 5645360039, 5645465704 and 5645724654.

This is a live bug, not a historical one: staging another recording would delete the current
evidence too. The fix is for staging to close and relabel the old ledger rather than empty it.

### The playground repository's code is ours

The repository the demo runs against was seeded with two small modules so the pull requests have
real diffs to reason about. The pull requests, comments, reactions and issues in the demo are all
real GitHub objects created through the API, not fixtures.
