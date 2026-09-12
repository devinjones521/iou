# IOU

**A GitHub bot that remembers the promises people make in pull-request threads, and speaks only
when a later PR touches that code without keeping them.**

> "I'll add retry handling in a follow-up PR."
>
> Every engineer has written that. Every reviewer has approved on the strength of it. Nobody tracks
> them. IOU does — and then stays quiet until the moment it matters.

---

## What it does

1. Someone makes a promise in a review thread on PR #41. **Nobody addresses the bot.**
2. IOU wakes on the comment, decides whether it is really a commitment to later work, and records
   it in a ledger **that lives in the repository** — an issue, so the memory is visible and
   survives a refresh.
3. Weeks later PR #58 opens. IOU reads the diff, sees it touches `fetchUser`, and checks whether
   this PR keeps the promise.
4. If it doesn't, IOU leaves **one** comment linking the original promise. If it does, or if the PR
   is unrelated, IOU says nothing at all and logs why.
5. A human reacts 👍 and IOU files a tracking issue assigned to whoever made the promise.
   **Nothing is filed without that reaction.**

## Why this can't be a chatbox

- **The trigger is not a prompt.** The interaction starts when a human writes a code review to
  another human. Nobody types anything at the bot, ever.
- **The context exists only here.** The promise is buried in a review thread nobody would paste
  into a chat window; the judgement needs the diff, the changed-file list and the repository's
  review history.
- **The output is an action in the environment.** A comment on the pull request, a reaction as the
  approval UI, an issue in the tracker — not a message about them.

## Restraint is the product

A bot that comments on every PR gets muted in a week. IOU's default is silence, and that is
enforced structurally, not by prompting:

| Situation | What IOU does |
|---|---|
| Comment isn't a promise | Nothing. Logs `not a promise` |
| Model output unparseable or low-confidence | Nothing. Fails **closed** — never invents a promise |
| PR touches no open IOU | Nothing. Deterministic pre-filter runs before any model call |
| PR touches one and doesn't keep it | **One** comment, once per PR, ever |
| PR touches one that was already filed | Nothing. An issue exists; saying it again is nagging |
| Nobody reacts | Nothing is filed |
| PR **keeps** the promise | One comment closing the loop, and the ledger entry settles. Asks nothing |

The last row is the one that makes the rest trustworthy. A bot that only ever nags gets muted; IOU
also notices when you do the thing, says so once, and marks the ledger. It tells the tracking issue
too — but it does **not** close it, because closing someone's issue is a judgement about their work,
and the bot never takes an outward action nobody asked for.

The negative fixtures are part of the test suite, including the one that matters most — *"I'll
never do that"*, which contains every surface feature of a promise and is not one.

## Architecture

```
  human writes a review comment
            │
            ▼
   poll (no webhook, no tunnel)  ──►  classify ──► fail closed ──► silence
            │                                           │
            │                                     promise? ▼
            │                          ledger issue in the repo  ◄── the memory
            ▼
     a later PR opens
            │
            ▼
   deterministic filter: does the diff touch it?  ──► no ──► silence + log line
            │ yes
            ▼
   does the diff keep the promise?  ──► yes / can't tell ──► silence
            │ no
            ▼
   ONE comment on the PR  ──►  👍 ──► tracking issue, assigned
                           └──►  👎 ──► IOU dropped
```

**Eight GitHub operations, total.** They are declared in one frozen list in `src/github.mjs` and
the cap is enforced by a test, not by convention. A rule that isn't executed isn't a rule.

## Setup

```bash
npm install                 # no dependencies — Node 22+ only
cp .env.example .env        # then fill in the values below
npm run verify              # the fast gate: scoreboard, tests, adapter cap
IOU_LIVE=1 npm run verify   # the same gate plus the full live end-to-end
npm run watch               # run the bot against your repo
```

To watch the whole story happen against a real repository, one beat at a time:

```bash
node scripts/demo.mjs reset
node scripts/demo.mjs beat1   # a human promises something in a review thread
node scripts/demo.mjs beat2   # the bot records it in the ledger
node scripts/demo.mjs beat3   # an unrelated PR — the bot says nothing
node scripts/demo.mjs beat4   # a PR that touches it — one comment
node scripts/demo.mjs beat5   # 👍 — a tracking issue appears
node scripts/demo.mjs beat6   # a PR that keeps the promise — settled
```

`.env`:

```
IOU_APP_ID=<your GitHub App id>
IOU_INSTALLATION_ID=<the installation id>
IOU_APP_PEM=./iou-app.pem
IOU_REPO=owner/repo
IOU_BOT_LOGIN=your-app-slug[bot]
```

The App needs **Contents: read**, **Issues: write**, **Pull requests: write**. Note it cannot push
code — by design.

## Verification

`npm run verify` is the only oracle: one command, one exit code. It refuses to lie in ways this
project learned the hard way:

- The scoreboard step rejects any feature marked passing whose evidence file doesn't exist.
- The tests step demands a TAP pass count. Exit 0 is not proof — a runner that skipped every file
  also exits 0, and did, for the first two hours of this build.
- The live step is **loudly** held open when it hasn't run, rather than silently skipped.
- Every gate was tested against deliberately broken input before being trusted.

## Known limitations

See [`LIMITATIONS.md`](LIMITATIONS.md) — written as each shortcut was taken, not afterwards. The
short version: one repository, one page of results, the model runs through the Claude Code CLI
rather than the API, and the forced-5xx failure path is tested against a local server because
GitHub won't return a 500 on request.

An unexplained failure is documented in [`BLOCKED.md`](BLOCKED.md) rather than hidden: an early
live run timed out on every model call. Five theories were raised and all five were measured and
disproved. It is written down because a build log that only records the wins is not a build log.

## How it was built

[`BUILD-LOG.md`](BUILD-LOG.md) is the honest account, including the three gates that were green
while doing nothing and the failure nobody could explain. [`DECISIONS.md`](DECISIONS.md) records
every non-obvious choice with its reasoning and how to reverse it.

Everything in `src/`, `tests/`, `scripts/` and the playground repository was written during the
hackathon window on 12 September 2026. The one pre-existing building block is the loop harness —
the Stop hook in `.claude/hooks/`, the scoreboard contract, and the `npm run verify` pattern —
carried from the author's earlier projects. No starter kit or template was used.
