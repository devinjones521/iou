# Build log

IOU was built on 12 September 2026 during the AI Tinkerers *Agents, Everywhere* hackathon window.
This is what actually happened, including the parts that went wrong.

---

## Choosing the idea (10:45 – 11:00)

A previous idea had been abandoned earlier that morning after discovering the platform it was built
on already shipped the exact mechanic. The lesson taken from that — *before committing to an idea
that lives inside someone's product, check what that product already ships* — became step zero for
every replacement candidate.

Five candidates were checked against what vendors had already shipped, and five died:

| Candidate | Killed by |
|---|---|
| Page-aware browser co-pilot filling long forms | Chrome's Gemini Auto Browse fills forms from your uploaded documents |
| Group-chat decision maker | Telegram assistants already track group decisions and action items |
| Slack thread closer | Slack's own AI summarises threads into decisions and action items |
| Slack commitment tracker | Several shipping products do exactly this |
| Calendar agenda bouncer | Multiple scheduling assistants already decline agenda-less invites |

IOU survived the same check. The closest existing things are bots that scan *source code* for
`TODO` comments, and one that files an issue when a pull request merges without a review. Nothing
found tracks promises made in review *threads*.

## The walking skeleton (11:00 – 11:35)

Target was a real promise on a real pull request resurfacing as a real comment on a second pull
request, by 12:45. It landed at 11:35.

## Three gates that were green while doing nothing

All three were found by deliberately feeding them broken input, which is the only way any of them
would have been found.

1. **`node --test tests/`** on Windows parses the directory as a test *file*, so every run fails
   regardless of the tests. Fixed by using bare `node --test`.
2. **`NODE_TEST_CONTEXT` leaking from the parent shell** makes the test child decide it is a
   recursive run, skip every file, and exit 0. The gate trusted the exit code and reported green on
   zero tests. Fixed by stripping the variable and demanding a TAP pass count.
3. **The live end-to-end step did not exist.** `npm run verify` printed green while the entire demo
   path had never been exercised. Fixed by adding the step and making its opt-out loud rather than
   silent.

A fourth, smaller one: the live step's TAP parser had its backslashes eaten when it was written, so
`(\d+)` became `(d+)` and matched a literal "d". It would have called a fully passing live run a
failure. It failed shut rather than open, so it could never have manufactured a false green.

## A failure that was never explained

The first two live runs recorded zero promises: every classification timed out at 60 seconds. Five
theories were raised and **all five were measured and disproved** — shell quoting on Windows,
contention from parallel processes, inherited stdin, test-runner environment variables, and prompt
shape. The classifier was then proven correct standalone on three fixtures, and the fault has not
recurred across six subsequent runs.

It is written up in `BLOCKED.md` rather than quietly dropped. Every failure mode is fail-closed —
the bot stays silent rather than guessing — so the worst case is a quiet bot, never a wrong one.

## Running out of quota, live

At 11:50 the model backend hit its subscription usage limit mid-run. The bot logged the error and
said nothing, which is exactly the designed behaviour. The fix was to the diagnostics rather than
the symptom: the CLI reports that class of failure on stdout and leaves stderr empty, so the error
message had been reporting nothing useful.

## Final state

Eight of eight live assertions green against the real GitHub API, every scoreboard item proven by a
test that created real objects and wrote an evidence file naming their URLs. Nothing was marked
passing from reading code.

The full scoreboard is `feature_list.json`; the evidence files are in `evidence/`.

## Pre-existing building blocks

The loop harness — the Stop hook in `.claude/hooks/`, the scoreboard contract, and the
`npm run verify` pattern — is carried from the author's earlier projects and was not written during
the window. Everything in `src/`, `tests/`, `scripts/`, and the playground repository was.
No starter kit or template was used.
