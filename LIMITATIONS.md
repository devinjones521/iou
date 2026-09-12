# Limitations

Written as each shortcut was taken, not reconstructed afterwards. Naming a weakness is more useful
than claiming nothing breaks.

### The forced-5xx failure path is tested against a local server, not GitHub

GitHub cannot be made to return a 500 on request. `tests/adapter.test.mjs` points the **real**
adapter — same code path, same retry and backoff — at a local HTTP server that fails on demand.
Nothing on the demo path uses that server.

### The model backend is the Claude Code CLI, not the API

The bot shells out to `claude -p --output-format json`. It is a real model call with real latency
(roughly 3–7 seconds), not a mock, but it runs on a personal subscription rather than an API key.

**Consequence, observed live:** when that subscription hits its usage limit the CLI exits non-zero
and IOU treats it like any other model failure — it logs the error and **says nothing**. That
happened once during the build: a judgement call failed and the bot stayed silent rather than
guessing. That is the right failure mode, but throughput is bounded by whatever quota the backend
has. Setting `ANTHROPIC_API_KEY` and swapping the single `ask` function removes the limit.

### One repository, one page of results

The bot watches a single repository (`IOU_REPO`) and reads at most 100 comments and 50 pull
requests per call. Pagination is not implemented. For a repository busier than that, the cursor
would need to page rather than take the first response.

### The judgement is a model's opinion, and it can be wrong

Deciding whether a diff keeps a promise is genuinely hard. IOU mitigates this rather than solving
it: a deterministic filter rules out unrelated pull requests before any model call, "cannot tell"
is treated as silence, the bot posts at most one comment per pull request, and nothing is filed
without a human reacting 👍. So a wrong judgement costs one comment that a 👎 dismisses — it never
files anything, and it never edits code.

### The playground repository's code is ours

The repository the demo runs against was seeded with two small modules so the pull requests have
real diffs. The pull requests, comments, reactions and issues in the demo are all real GitHub
objects created through the API, not fixtures.
