# Decisions

Every non-obvious choice, with what was chosen, why, and how to undo it. Written as each decision
was taken, not reconstructed afterwards.

---

### The ledger is consulted before recording, not just the local state file

**What:** how the bot avoids recording the same promise twice.
**Chose:** read the ledger's existing entry ids at the start of every tick and skip any source
comment already in it, before the budget check so re-reading our own memory never costs a call.
**Why:** deduplication used to rely on `state.handledComments` in a local file. Observed in
production: the service was stopped, an end-to-end run took a promise through open → filed →
settled, and on restart the service — whose state file predated those comments — re-read the source
comment and recorded the promise again, resurrecting a settled IOU. Local state is exactly what a
repository-resident ledger is supposed to outlive, so the ledger has to be the authority.
**Cost:** one extra read per tick. No extra model calls.
**How to undo:** delete the `alreadyInLedger` block in `src/tick.mjs` and its guard in the comment
loop. `tests/adapter.test.mjs` covers it and was confirmed to fail without the fix.

### The gate reads the last live run from evidence instead of reciting a date

**What:** the held-open note `npm run verify` prints when the live end-to-end test is not run.
**Chose:** derive the run, timestamp and item count from `evidence/latest.json`.
**Why:** the note was hardcoded prose naming one run and kept announcing it after newer runs had
completed. A gate that reports something not derived from reality is the failure this project keeps
finding in itself.
**Cost:** none.
**How to undo:** replace `lastLiveRun()` in `scripts/verify.mjs` with fixed strings.

### Model backend is the Claude Code CLI, not the API

**What:** how the bot calls a model.
**Chose:** spawn `claude -p --output-format json` from `src/llm.mjs`.
**Why:** no API key was available on the build machine, and this is a real model call rather than a
mock. Measured at roughly 3–7 seconds per call. The demo path makes at most three calls per tick.
**Cost:** throughput is bounded by the subscription's quota, and when that quota runs out the bot
goes quiet. That happened once during the build and is recorded in `LIMITATIONS.md`.
**How to undo:** set `ANTHROPIC_API_KEY` and replace the single `ask` function with the SDK.

### Default model is Opus, not a cheaper one

**What:** which model the bot's own classification and judgement calls use.
**Chose:** `opus`, overridable with `IOU_MODEL`.
**Why:** the first draft defaulted to Haiku to spend less of the operator's quota. That is not a
decision the bot's author should make silently on someone else's behalf — it trades the product's
accuracy for someone else's budget without telling them. `IOU_MODEL=haiku` exists for iterating.
Opus also turned out to be *faster* on these prompts in practice.
**How to undo:** `MODEL` in `src/llm.mjs`.

### Wake by polling, not webhooks or GitHub Actions

**What:** how the bot learns that a comment or pull request happened.
**Chose:** poll the REST API with a `since` cursor persisted locally.
**Why:** no tunnel, no public URL, no repository secrets. A judge sees the same thing either way —
a comment from the bot. Actions was also ruled out because the model backend is a local CLI.
**How to undo:** a workflow on `pull_request` / `issue_comment` calling the same `src/tick.mjs`.

### The ledger is a GitHub issue; entries are its comments

**What:** where remembered promises live.
**Chose:** one issue labelled `iou-ledger`; each event is a comment carrying a machine-readable
record in an HTML comment plus a human-readable line. The latest event per promise wins.
**Why:** the memory lives in the environment rather than in a database only the bot can see. It is
visible to anyone with repository access, survives a refresh, and reuses `createComment`, which
keeps the adapter inside its eight-operation cap.
**How to undo:** replace `src/ledger.mjs` with a file- or database-backed store.

### Exactly eight GitHub operations, enforced by a test

**What:** the bot's entire capability surface.
**Chose:** list issues, list pull requests, list pull request files, list issue comments since, list
review comments since, create comment, list reactions, create issue. Eight, with none spare.
**Why:** a wide tool surface makes it impossible to say what a bot can actually do, and impossible
for a reviewer to check. The cap is asserted in `tests/adapter.test.mjs` and counted statically in
`scripts/verify.mjs`, so it survives someone deleting the test. A rule that is not executed is not
a rule. Test-only helpers that create branches and pull requests live in `tests/` and are not bot
operations — the bot cannot push code, and the GitHub App is granted only `contents: read`.
**How to undo:** the cap permits eight; add one only by removing one.

### Settling a promise comments on the tracking issue but does not close it

**What:** what happens to a filed tracking issue when a later pull request keeps the promise.
**Chose:** comment saying which pull request kept it, and leave it open.
**Why:** two reasons pointing the same way. Closing someone's issue is a judgement about their
work, and the whole product rests on never taking an outward action nobody asked for — it already
refuses to file anything without a 👍, so closing silently would contradict that. It also keeps the
adapter at eight operations, since closing needs a ninth.
**How to undo:** add an update-issue operation (drop one first) and patch the state in the settle
branch of `src/tick.mjs`.

### A filed promise can still be settled, but is never raised again

**What:** which ledger states each path considers.
**Chose:** resurfacing looks only at `open`; settling looks at `open` and `filed`.
**Why:** a promise with a tracking issue against it is still owed, so a pull request that keeps it
should close the loop. But repeating the reminder on every future pull request, when an issue
already exists, is exactly the behaviour that gets a bot muted.
**How to undo:** `openIous` and `outstandingIous` in `src/ledger.mjs` are the two filters.

### Ambiguity always fails closed

**What:** what happens when the model returns something unparseable, low-confidence, or undecided.
**Chose:** treat it as "not a promise" / "cannot tell", and stay silent.
**Why:** a bot that invents a promise from a parse error is worse than one that misses a real one.
Silence costs nothing; a wrong accusation costs the reviewer's trust, and they mute it.
**Where:** `parseJsonObject`, `verdictFrom` and `fulfilmentFrom`, each tested against garbage.

### The verify gate demands a test count, not an exit code

**What:** how `npm run verify` decides the suite actually ran.
**Chose:** parse the TAP summary and require a minimum number of passing assertions and zero
failures. No summary means nothing ran, which is RED.
**Why:** this was found the hard way. `NODE_TEST_CONTEXT` leaking from a parent shell makes
`node --test` decide it is a recursive run, skip every file, and **exit 0**. The gate reported
green while executing zero assertions. Exit 0 is not proof that anything happened.
**How to undo:** the `tests` step in `scripts/verify.mjs`.

### Evidence must be a URL or a file that exists

**What:** what the scoreboard will accept as proof that a feature works.
**Chose:** `scripts/verify.mjs` rejects any item marked passing whose evidence is neither a URL nor
a path present on disk.
**Why:** an agent that can mark its own homework will. Every passing item names a real comment or
issue URL created during a live run, or a test file and the assertion inside it. The gate was
itself tested by planting a pass with a nonexistent evidence file, which correctly turned it red.
**How to undo:** the `scoreboard` step in `scripts/verify.mjs`.
