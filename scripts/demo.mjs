#!/usr/bin/env node
/**
 * Stages the 2-minute demo against the real repository, one beat at a time.
 *
 *   node scripts/demo.mjs reset     wipe the playground back to a clean slate
 *   node scripts/demo.mjs beat1     human opens PR A and writes the promise (no bot yet)
 *   node scripts/demo.mjs beat2     run one tick — the promise is recorded in the ledger
 *   node scripts/demo.mjs beat3     human opens PR C (unrelated) -> tick -> SILENCE
 *   node scripts/demo.mjs beat4     human opens PR B (touches it) -> tick -> ONE comment
 *   node scripts/demo.mjs beat5     human reacts 👍 -> tick -> tracking issue, assigned
 *   node scripts/demo.mjs beat6     a PR that KEEPS the promise -> tick -> settled, ledger closed
 *
 * Why a script and not the e2e: on camera you want to pause between beats, talk over them, and
 * re-shoot one without re-running the others. Each beat prints the URL to put on screen.
 */
import { execFileSync } from "node:child_process";
import { github, resolveAuth } from "../src/github.mjs";
import { tick } from "../src/tick.mjs";
import { human } from "../tests/helpers/gh.mjs";
import { loadDotEnv, repoFromEnv, stamp } from "../src/util.mjs";
import { retireLedger } from "../src/ledger.mjs";

loadDotEnv();

const { owner, repo } = repoFromEnv();
const log = (m) => console.log(`${stamp()} ${m}`);
const auth = await resolveAuth();
const gh = github({ owner, repo, token: auth.token, log });
const humanToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const you = human({ owner, repo, token: humanToken });
const botLogin = process.env.IOU_BOT_LOGIN || null;
const STATE = ".iou/demo-state.json";
const BR = { a: "demo-promise", b: "demo-touches-it", c: "demo-unrelated", d: "demo-keeps-it" };

const beat = process.argv[2];
const runTick = () => tick(gh, { log, statePath: STATE, botLogin });
const banner = (s) => console.log(`\n\x1b[1m${s}\x1b[0m\n`);

async function findPr(branch) {
  const pulls = await gh.listPulls({ state: "open" });
  return pulls.find((p) => p.head.ref === branch);
}

switch (beat) {
  case "reset": {
    banner("RESET — putting the playground back to a clean slate");
    for (const p of await gh.listPulls({ state: "open" })) {
      await you.closePull(p.number); log(`closed PR #${p.number}`);
    }
    for (const b of Object.values(BR)) await you.deleteBranch(b);
    const ledger = (await gh.listIssues({ labels: "iou-ledger", state: "all" }))[0];
    if (ledger) {
      // Retire it rather than empty it — see retireLedger in src/ledger.mjs.
      await retireLedger(you, ledger.number);
      log(`ledger #${ledger.number} retired — closed and unlabelled, comments intact: ${ledger.html_url}`);
    }
    for (const i of await you.issues("iou")) { await you.closeIssue(i.number); log(`closed tracking issue #${i.number}`); }
    try { (await import("node:fs")).rmSync(STATE, { force: true }); } catch {}
    banner("Clean. Run beat1 next.");
    break;
  }

  case "beat1": {
    banner("BEAT 1 — a human reviews a human. Nothing is addressed to the bot.");
    const users = await you.getFile("src/users.js");
    await you.createBranch(BR.a);
    await you.putFile(BR.a, "src/users.js", users.replace("Demo service", "Demo service — tidied"), "Tidy the header");
    const pr = await you.openPull(BR.a, "Tidy users.js header");
    const c = await you.comment(pr.number, "Good catch on the error path. I'll add retry handling to fetchUser in a follow-up PR rather than here.");
    banner(`PR:      ${pr.html_url}\nPROMISE: ${c.html_url}`);
    break;
  }

  case "beat2": {
    banner("BEAT 2 — one tick. The bot wakes on the comment and remembers it, in the repo.");
    const s = await runTick();
    const ledger = (await gh.listIssues({ labels: "iou-ledger", state: "all" }))[0];
    banner(s.recorded.length
      ? `RECORDED: "${s.recorded[0].what}"\nLEDGER:   ${s.recorded[0].ledger_comment}\nISSUE:    ${ledger.html_url}`
      : "Nothing recorded — check the log above.");
    break;
  }

  case "beat3": {
    banner("BEAT 3 — an unrelated PR. THE BOT SAYS NOTHING. This is the point.");
    const billing = await you.getFile("src/billing.js");
    await you.createBranch(BR.c);
    await you.putFile(BR.c, "src/billing.js", billing + "\nexport const VAT = 0.2;\n", "Add VAT constant");
    const pr = await you.openPull(BR.c, "Add VAT constant");
    const before = (await you.commentsOn(pr.number)).length;
    await runTick();
    const after = (await you.commentsOn(pr.number)).length;
    banner(`PR:       ${pr.html_url}\nCOMMENTS: ${before} before, ${after} after. Silence, with the reason in the log.`);
    break;
  }

  case "beat4": {
    banner("BEAT 4 — a PR that touches the promised code without keeping the promise.");
    const users = await you.getFile("src/users.js");
    await you.createBranch(BR.b);
    await you.putFile(BR.b, "src/users.js", users.replace("return res.json();", "const data = await res.json();\n  return data;"), "Refactor fetchUser return");
    const pr = await you.openPull(BR.b, "Refactor fetchUser return");
    const s = await runTick();
    banner(s.resurfaced.length
      ? `PR:      ${pr.html_url}\nCOMMENT: ${s.resurfaced[0].comment}\n\nPut the comment on screen. Note the author is the App, not a person.`
      : `PR: ${pr.html_url}\nNo comment — check the log.`);
    break;
  }

  case "beat5": {
    banner("BEAT 5 — the human decides. Nothing is filed without the reaction.");
    const pr = await findPr(BR.b);
    const c = (await you.commentsOn(pr.number)).find((x) => x.body.startsWith("<!-- iou:resurface"));
    if (!c) { banner("No resurface comment found — run beat4 first."); break; }
    await you.react(c.id, "+1");
    log("human reacted 👍");
    const s = await runTick();
    banner(s.filed.length
      ? `FILED: ${s.filed[0].issue}\n\nOpen it: assigned to the promiser, titled with the promise, authored by the bot.`
      : "Nothing filed — check the log.");
    break;
  }

  case "beat6": {
    banner("BEAT 6 — someone finally keeps the promise. The bot closes the loop and shuts up.");
    const users = await you.getFile("src/users.js");
    const withRetry = users.replace(
      /export async function fetchUser\(id\) \{[\s\S]*?\n\}/,
      `export async function fetchUser(id, { retries = 3, backoffMs = 200 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(\`https://api.example.com/users/\${id}\`);
      if (res.status >= 500 && attempt < retries) throw new Error(\`retryable \${res.status}\`);
      if (!res.ok) throw new Error(\`fetchUser failed: \${res.status}\`);
      return res.json();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  throw lastError;
}`);
    if (withRetry === users) { banner("Could not patch fetchUser — has src/users.js drifted?"); break; }
    await you.createBranch(BR.d);
    await you.putFile(BR.d, "src/users.js", withRetry, "Add retry handling to fetchUser");
    const pr = await you.openPull(BR.d, "Add retry handling to fetchUser");
    const s = await runTick();
    banner(s.settled.length
      ? `PR:      ${pr.html_url}\nCOMMENT: ${s.settled[0].comment}\n\nThe ledger entry is now settled, and the tracking issue was told.\nNo 👍 needed — nothing is being asked of anyone.`
      : `PR: ${pr.html_url}\nNot settled — check the log.`);
    break;
  }

  default:
    console.log(`usage: node scripts/demo.mjs reset|beat1|beat2|beat3|beat4|beat5|beat6`);
    process.exit(1);
}
