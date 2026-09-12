# Decisions

Every non-obvious choice, with what was chosen, why, and how to undo it. Written as each decision
was taken, not reconstructed afterwards.

---

### The ledger, not local state, decides whether a promise is already recorded

**What:** how the bot avoids recording the same promise twice.
**Chose:** read the ledger's entry ids at the start of every tick and skip any source comment
already in it — before the budget check, so re-reading its own memory never costs a model call.
**Why:** the obvious approach is a list of handled comment ids in the local state file, and it is
wrong for this product. The whole claim is that the memory lives in the repository and outlives any
one machine. A state file that is lost, reset, or simply older than the comments it is meant to
cover leads the bot to re-read a source comment and record a promise the ledger already carried
through open → filed → settled — resurrecting a promise that was already kept. The ledger has to be
the authority, because the ledger is the thing that survives.
**Cost:** one extra read per tick. No extra model calls.
**How to undo:** delete the `alreadyInLedger` block in `src/tick.mjs` and its guard in the comment
loop. `tests/adapter.test.mjs` covers it, and that test fails when the guard is removed.

### The gate reads the last live run from evidence, never from a literal

**What:** the held-open note `npm run verify` prints when the live end-to-end test has not run.
**Chose:** derive the run id, timestamp and item count from `evidence/latest.json`, and say plainly
that there is no record of any live run when that file is missing, malformed, or empty.
**Why:** a note like this is a claim about reality, and a claim hardcoded as prose goes stale the
moment the next run completes — announcing an old result with total confidence. A gate that reports
something it did not derive is the exact failure this project keeps finding in itself.
**Cost:** none.
**How to undo:** replace `lastLiveRun()` in `scripts/verify.mjs` with fixed strings.

### The model backend is a provider chain, API first

**What:** how the bot calls a model.
**Chose:** a chain in `src/llm.mjs`, first configured wins — `ANTHROPIC_API_KEY` (the Anthropic
API), then `OPENROUTER_API_KEY`, then shelling out to `claude -p --output-format json`.
**Why:** the deployment needs a backend that runs on a server with no interactive login, and anyone
cloning this repo needs one they can actually use. The CLI stays last because it is genuinely
useful on a machine with no key at all, and it is a real model call rather than a mock.
**Cost:** three code paths instead of one. The CLI path is not deployable and costs about 23x more
per call; `LIMITATIONS.md` measures it. The OpenRouter path has never been exercised.
**How to undo:** delete `askOpenRouter` and `askCli` and call the SDK directly from `ask`.

### The default model is Opus, not a cheaper one

**What:** which model the bot's own classification and judgement calls use.
**Chose:** `claude-opus-5`, overridable with `IOU_MODEL`.
**Why:** an earlier draft defaulted to a cheaper model to spend less of the operator's quota. That
trades the product's accuracy for someone else's budget without telling them, which is not a
decision to take silently. The spend ceilings are the safety mechanism; a quiet downgrade is not.
**Cost:** about $0.004 per classification and $0.011 per diff judgement, against roughly a fifth of
that on Haiku. `IOU_MODEL` must be a full API model id — the bare aliases `opus` and `haiku` are
Claude Code CLI names and return a 404 from the API, which, because the bot fails closed, looks
exactly like the bot choosing to stay quiet.
**How to undo:** set `IOU_MODEL` to a cheaper model id.

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
