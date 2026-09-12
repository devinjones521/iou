#!/usr/bin/env node
/**
 * Stages the video. Read VIDEO.md first — this is the hands, that is the script.
 *
 *   node scripts/record.mjs setup    reset, drop the server poll to 5s, stage the promise
 *   node scripts/record.mjs go       THE TAKE: opens the PR the bot will answer. Hit record first.
 *   node scripts/record.mjs quiet    opens an unrelated PR — the restraint beat
 *   node scripts/record.mjs keep     opens a PR that keeps the promise — the settle beat
 *   node scripts/record.mjs limit    the alternative failure beat: hit the per-actor ceiling
 *   node scripts/record.mjs restore  put the server back to a 20s poll and normal ceilings
 *
 * Why a script: on camera you cannot be typing git commands. Each command here does one human
 * action and then gets out of the way, so the only thing moving on screen is the bot.
 */
import { execFileSync } from "node:child_process";
import { human } from "../tests/helpers/gh.mjs";
import { github, resolveAuth } from "../src/github.mjs";
import { loadDotEnv, repoFromEnv } from "../src/util.mjs";

loadDotEnv();
const { owner, repo } = repoFromEnv();
const SSH_HOST = process.env.IOU_SSH_HOST || "betting";
const auth = await resolveAuth();
const gh = github({ owner, repo, token: auth.token });
const you = human({ owner, repo, token: execFileSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" }).trim() });

const BR = { promise: "video-promise", quiet: "video-unrelated", answer: "video-touches-it", keep: "video-keeps-it" };
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const say = (s) => console.log(`\n${bold(s)}\n`);

function ssh(cmd) {
  // NEVER shell:true here. On Windows that routes through cmd.exe, which parses the `&&` inside
  // the remote command as its own operator and tears the line in half before ssh ever sees it.
  // Without a shell, execFileSync hands the whole string to ssh as one argument, which is right.
  return execFileSync("ssh", ["-o", "BatchMode=yes", SSH_HOST, cmd], { encoding: "utf8" }).trim();
}
/** Change one setting in the server's env file and restart. Used only for recording pace. */
function setServer(kv) {
  const sed = Object.entries(kv).map(([k, v]) => `sed -i 's|^${k}=.*|${k}=${v}|' /etc/iou/iou.env`).join(" && ");
  ssh(`${sed} && systemctl restart iou && sleep 4 && systemctl is-active iou`);
  return Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(", ");
}

async function countdown(seconds, label) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r  ${label} in ${i}... `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");
}

const cmd = process.argv[2];

switch (cmd) {
  case "setup": {
    say("SETUP — clearing the stage. Do this BEFORE you open OBS.");
    for (const p of await gh.listPulls({ state: "open" })) { await you.closePull(p.number); console.log(`  closed PR #${p.number}`); }
    for (const b of Object.values(BR)) await you.deleteBranch(b);
    const ledger = (await gh.listIssues({ labels: "iou-ledger", state: "all" }))[0];
    if (ledger) {
      for (const c of await you.commentsOn(ledger.number)) {
        await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${c.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${execFileSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" }).trim()}`, Accept: "application/vnd.github+json", "User-Agent": "iou-video" },
        });
      }
      await you.reopenIssue(ledger.number);
      console.log(`  ledger #${ledger.number} emptied`);
    }
    for (const i of await you.issues("iou")) { await you.closeIssue(i.number); console.log(`  closed tracking issue #${i.number}`); }

    console.log(`  server: ${setServer({ IOU_INTERVAL_S: 5 })}`);
    ssh("rm -f /opt/iou/.iou/state.json /opt/iou/.iou/budget.json && systemctl restart iou");
    console.log("  server state cleared");

    // The promise itself is staged BEFORE the take, because the video starts weeks later.
    const users = await you.getFile("src/users.js");
    await you.createBranch(BR.promise);
    await you.putFile(BR.promise, "src/users.js", users.replace("Demo service", "Demo service — tidied"), "Tidy the header");
    const pr = await you.openPull(BR.promise, "Tidy users.js header");
    const c = await you.comment(pr.number, "Good catch on the error path. I'll add retry handling to fetchUser in a follow-up PR rather than here.");
    console.log(`  staged the promise: ${c.html_url}`);
    await countdown(12, "waiting for the bot to record it");
    const led = (await gh.listIssues({ labels: "iou-ledger", state: "all" }))[0];

    say("STAGE IS SET.");
    console.log(`  The promise      ${c.html_url}`);
    console.log(`  The ledger       ${led.html_url}`);
    console.log(`
  Now:
    1. open the ledger in Chrome and check it shows ONE "Open" line
    2. arrange Chrome (left, ~65%) and a terminal (right) running:
         ssh ${SSH_HOST} 'journalctl -u iou -f -o cat'
    3. start OBS, hit record, wait 3 seconds of stillness
    4. run:  node scripts/record.mjs go`);
    break;
  }

  case "go": {
    say("TAKE — opening the PR the bot will answer. Say nothing for ~8 seconds.");
    const users = await you.getFile("src/users.js");
    await you.createBranch(BR.answer);
    await you.putFile(BR.answer, "src/users.js", users.replace("return res.json();", "const data = await res.json();\n  return data;"), "Refactor fetchUser return");
    const pr = await you.openPull(BR.answer, "Refactor fetchUser return");
    console.log(`\n  >>> OPEN THIS IN CHROME NOW:  ${pr.html_url}\n`);
    await countdown(10, "the bot answers");
    const c = (await you.commentsOn(pr.number)).find((x) => x.body.startsWith("<!-- iou:resurface"));
    say(c ? "The comment is up. Refresh Chrome." : "No comment yet — give it one more poll and refresh.");
    if (c) console.log(`  ${c.html_url}\n\n  Next: react 👍 in the browser yourself (on camera), then wait ~8s for the issue.`);
    break;
  }

  case "quiet": {
    say("RESTRAINT BEAT — an unrelated PR. The bot will say nothing.");
    const billing = await you.getFile("src/billing.js");
    await you.createBranch(BR.quiet);
    await you.putFile(BR.quiet, "src/billing.js", billing + "\nexport const VAT = 0.2;\n", "Add VAT constant");
    const pr = await you.openPull(BR.quiet, "Add VAT constant");
    console.log(`\n  >>> OPEN IN CHROME:  ${pr.html_url}\n`);
    await countdown(10, "the bot decides");
    const n = (await you.commentsOn(pr.number)).length;
    say(n === 0 ? "Zero comments. Point at the terminal: 'touches none … silent'." : `Unexpected: ${n} comments.`);
    break;
  }

  case "keep": {
    say("SETTLE BEAT — a PR that actually keeps the promise.");
    const users = await you.getFile("src/users.js");
    const withRetry = users.replace(/export async function fetchUser\(id\) \{[\s\S]*?\n\}/,
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
    if (withRetry === users) { say("Could not patch fetchUser — has src/users.js drifted?"); break; }
    await you.createBranch(BR.keep);
    await you.putFile(BR.keep, "src/users.js", withRetry, "Add retry handling to fetchUser");
    const pr = await you.openPull(BR.keep, "Add retry handling to fetchUser");
    console.log(`\n  >>> OPEN IN CHROME:  ${pr.html_url}\n`);
    await countdown(12, "the bot reads the diff and settles it");
    const c = (await you.commentsOn(pr.number)).find((x) => x.body.startsWith("<!-- iou:settle"));
    say(c ? "Settled. Now show the ledger: Open → Filed → Settled." : "Not settled yet — one more poll, then refresh.");
    break;
  }

  case "limit": {
    say("FAILURE BEAT — the spend ceiling. First comment goes through. Second is refused.");
    // Clear the spend history first, or the actor is already over the new ceiling and BOTH
    // comments get refused — which shows the ceiling working but not the contrast that makes
    // it land on camera.
    ssh("rm -f /opt/iou/.iou/budget.json");
    console.log(`  server: ${setServer({ IOU_MAX_CALLS_PER_ACTOR_HOUR: 1 })} (spend history cleared)`);
    const pr = (await gh.listPulls({ state: "open" }))[0];
    if (!pr) { say("No open PR to comment on — run setup first."); break; }
    const a = await you.comment(pr.number, "I'll add input validation to formatName in a follow-up.");
    console.log(`  comment 1: ${a.html_url}`);
    await countdown(12, "comment 1 — watch it get CLASSIFIED");
    const b = await you.comment(pr.number, "I'll also add JSDoc to formatName later this week.");
    console.log(`  comment 2: ${b.html_url}`);
    await countdown(12, "comment 2 — watch it get REFUSED");
    say("Terminal shows one 'promise recorded' then one 'SKIPPED without spending'.");
    console.log("  Nothing was billed for the second, and nothing was posted.");
    console.log("  Remember to run: node scripts/record.mjs restore");
    break;
  }

  case "restore": {
    say("RESTORE — putting the server back to normal.");
    console.log(`  server: ${setServer({ IOU_INTERVAL_S: 20, IOU_MAX_CALLS_PER_ACTOR_HOUR: 12 })}`);
    say("Done. Poll is 20s again and the per-actor ceiling is back to 12.");
    break;
  }

  default:
    console.log(`usage: node scripts/record.mjs setup|go|quiet|keep|limit|restore
  Read VIDEO.md first — that has the shot list and what to say over each beat.`);
    process.exit(1);
}
