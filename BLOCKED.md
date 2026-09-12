# Blocked — what stopped me, and what a human would need to do

### OPEN — the 10:08 live run's three `llm timeout after 60000ms` are still unexplained

**Symptom.** The first live e2e (`evidence/live-2026-09-12T10-08-40-426Z.json`, and again at 10:12)
recorded zero promises. Every classification failed with `llm timeout after 60000ms`, so the bot
correctly stayed silent and items 3–8 proved nothing.

**Four theories raised across four sessions. All four tested. All four dead.**

| Theory | Tested by | Result |
|---|---|---|
| `shell: true` on Windows mangles the `>>>` in the prompt into a redirect | e8 | shell:true → exit 0 in 9549 ms with unparseable output; shell:false → exit 0 in 9104 ms. Yields a wrong answer, never a hang |
| Six concurrent agent sessions contending for the CLI | fb | Five real calls at peak load: 2825 / 4454 / 4458 / 7254 / 7257 ms. Nothing near 60 s |
| Inherited, never-closed stdin makes the CLI wait for input | fb | ~3 s, not 60 |
| `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID` leak into the CLI child under `node --test` | this session, 11:52 | Clean env 6015 ms, both variables set 5122 ms, both exit 0. **Dead** |

**What IS proven.** The classifier itself works. Standalone, post-fix, three fixtures, three
correct answers: the promise classified as `Add retry handling to fetchUser` at confidence 1.0,
plain praise rejected, and the hard negative *"I'll never do that"* rejected. ~6 s of model time
each. So this is not a prompt problem and not a parsing problem.

**Disposition.** Not grinding further — that is theory five with no new evidence, and the rule is
three honest attempts. The next serial live run is the experiment: it either reproduces, in which
case there is a live repro to bisect, or it does not, in which case the cause is recorded as never
isolated and the risk is that it returns on camera. The 60 s ceiling is per call, every failure is
fail-closed (silence, never an invented promise), and the bot degrades without crashing — so the
worst case is a quiet bot, not a wrong one.

**What a human could do that I cannot:** watch a hung `claude -p` in Task Manager / Process Explorer
while the e2e runs and see whether it is waiting on stdin, on the network, or on a lock.
