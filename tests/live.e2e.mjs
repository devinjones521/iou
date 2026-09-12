/**
 * The demo path, driven end to end through the REAL GitHub API on the real playground repo.
 * `npm run live`. Writes evidence/live-<stamp>.json and evidence/latest.json.
 *
 * Not part of the Stop-hook fast suite (it makes ~4 model calls and ~40 API calls, ~60 s).
 * It is the only thing allowed to flip an item to passes:true.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { github, resolveAuth } from "../src/github.mjs";
import { tick } from "../src/tick.mjs";
import { LEDGER_LABEL, reduceLedger } from "../src/ledger.mjs";
import { human } from "./helpers/gh.mjs";
import { loadDotEnv, repoFromEnv } from "../src/util.mjs";

loadDotEnv();

const { owner, repo } = repoFromEnv();
const stampId = new Date().toISOString().replace(/[:.]/g, "-");
const run = `iou-e2e-${stampId.slice(0, 19)}`;
const evidence = { run, repo: `${owner}/${repo}`, started: new Date().toISOString(), items: {} };
const logs = [];
const log = (m) => { logs.push(m); console.log("   " + m); };
const statePath = join(mkdtempSync(join(tmpdir(), "iou-live-")), "state.json");

// TWO credentials, deliberately: the bot acts as the GitHub App, the human acts as the operator.
// The App has contents:read only — it cannot push branches, which is the point.
const auth = await resolveAuth();
const gh = github({ owner, repo, token: auth.token, log });
const humanToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const you = human({ owner, repo, token: humanToken });
const me = (await you.me()).login;
const botLogin = process.env.IOU_BOT_LOGIN || null;
log(`bot credential: ${auth.kind}${botLogin ? ` as ${botLogin}` : " (no IOU_BOT_LOGIN — see LIMITATIONS.md)"}; human: @${me}`);

const branches = [], pulls = [], issuesToClose = [];
after(async () => {
  for (const n of pulls) await you.closePull(n).catch(() => {});
  for (const b of branches) await you.deleteBranch(b);
  for (const n of issuesToClose) await you.closeIssue(n).catch(() => {});
  evidence.finished = new Date().toISOString();
  evidence.log = logs;
  mkdirSync("evidence", { recursive: true });
  const file = `evidence/live-${stampId}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  writeFileSync("evidence/latest.json", JSON.stringify(evidence, null, 2));
  console.log(`   evidence → ${file}`);
});

async function openPr(name, path, content, title) {
  await you.createBranch(name);
  branches.push(name);
  await you.putFile(name, path, content, `${title} (${run})`);
  const pr = await you.openPull(name, `${title} [${run}]`);
  pulls.push(pr.number);
  return pr;
}

test("1. auth + playground repo reachable through the adapter", async () => {
  const issues = await gh.listIssues({ state: "all" });
  assert.ok(Array.isArray(issues));
  evidence.items[1] = { credential: auth.kind, repo: `${owner}/${repo}`, issues_seen: issues.length };
});

let ledger, prA, promiseComment, iouId;

test("3+4+5. a real promise comment wakes the bot, is classified, and lands in the ledger issue", async () => {
  const users = await you.getFile("src/users.js");
  prA = await openPr(`${run}-a`, "src/users.js", users.replace("Demo service", "Demo service (touched by PR A)"), "Tidy users.js header");
  promiseComment = await you.comment(prA.number, "Good catch on the error path. I'll add retry handling to fetchUser in a follow-up PR rather than here.");
  log(`human: promise comment ${promiseComment.html_url}`);

  const s1 = await tick(gh, { log, statePath, botLogin });
  assert.equal(s1.recorded.length, 1, `expected exactly one recorded promise, got ${JSON.stringify(s1)}`);
  assert.equal(s1.recorded[0].source, promiseComment.html_url);
  iouId = s1.recorded[0].id;

  const ledgerIssue = (await gh.listIssues({ labels: LEDGER_LABEL, state: "all" }))[0];
  ledger = ledgerIssue;
  const entries = reduceLedger(await you.commentsOn(ledgerIssue.number));
  const mine = entries.find((e) => e.id === iouId);
  assert.ok(mine, "ledger entry re-fetched from the issue");
  assert.equal(mine.status, "open");
  assert.equal(mine.source, promiseComment.html_url);
  assert.ok(logs.some((l) => l.includes(`comment ${promiseComment.id}`)), "log line names the real comment id");

  const s2 = await tick(gh, { log, statePath, botLogin });
  assert.equal(s2.recorded.length, 0, "second tick must not re-handle the same comment");

  evidence.items[3] = { woke_on_comment: promiseComment.html_url, comment_id: promiseComment.id, second_tick_recorded: s2.recorded.length };
  evidence.items[4] = { positive: { comment: promiseComment.html_url, what: mine.what, confidence: mine.confidence } };
  evidence.items[5] = { ledger_issue: ledgerIssue.html_url, entry: s1.recorded[0].ledger_comment };
});

test("4. negative fixtures are not recorded", async () => {
  const negs = ["LGTM, thanks for the quick fix!", "I'll never do that, retries belong in the client."];
  const posted = [];
  for (const n of negs) posted.push(await you.comment(prA.number, n));
  const s = await tick(gh, { log, statePath, botLogin });
  assert.equal(s.recorded.length, 0, `negatives were recorded: ${JSON.stringify(s.recorded)}`);
  evidence.items[4].negatives = posted.map((p) => p.html_url);
  evidence.items[4].negatives_recorded = s.recorded.length;
});

test("7. a PR touching nothing promised gets silence and a log line", async () => {
  const billing = await you.getFile("src/billing.js");
  const prC = await openPr(`${run}-c`, "src/billing.js", billing + "\nexport const VAT = 0.2;\n", "Add VAT constant");
  const before = (await you.commentsOn(prC.number)).length;
  const s = await tick(gh, { log, statePath, botLogin });
  const after_ = (await you.commentsOn(prC.number)).length;
  assert.equal(after_, before, "no comment on the unrelated PR");
  const line = logs.find((l) => l.includes(`PR #${prC.number}: touches none`));
  assert.ok(line, `expected a silence log line for PR #${prC.number}\n${logs.slice(-15).join("\n")}`);
  evidence.items[7] = { pr: prC.html_url, comments_before: before, comments_after: after_, log_line: line };
});

let resurface;
test("6. a PR touching the promised code gets exactly one resurface comment linking the source", async () => {
  const users = await you.getFile("src/users.js");
  const prB = await openPr(`${run}-b`, "src/users.js", users.replace("return res.json();", "const data = await res.json();\n  return data;"), "Refactor fetchUser return");
  const s = await tick(gh, { log, statePath, botLogin });
  const comments = (await you.commentsOn(prB.number)).filter((c) => c.body.startsWith("<!-- iou:resurface"));
  assert.equal(comments.length, 1, `expected one resurface comment on PR #${prB.number}, got ${comments.length}; summary ${JSON.stringify(s)}`);
  resurface = comments[0];
  assert.ok(resurface.body.includes(promiseComment.html_url), "comment links the source promise");
  const again = await tick(gh, { log, statePath, botLogin });
  assert.equal((await you.commentsOn(prB.number)).filter((c) => c.body.startsWith("<!-- iou:resurface")).length, 1, "still exactly one after another tick");
  evidence.items[6] = { pr: prB.html_url, comment: resurface.html_url, author: resurface.user.login, links_source: true, second_tick_resurfaced: again.resurfaced.length };
});

test("8. nothing is filed until a human reacts 👍; then a tracking issue appears, assigned", async () => {
  const openBefore = (await you.issues("iou")).filter((i) => i.title.includes("retry"));
  const sBefore = await tick(gh, { log, statePath, botLogin });
  assert.equal(sBefore.filed.length, 0, "no issue before the reaction");
  await you.react(resurface.id, "+1");
  const s = await tick(gh, { log, statePath, botLogin });
  assert.equal(s.filed.length, 1, `expected one filed issue, got ${JSON.stringify(s)}`);
  // By number, not by listing — see tests/helpers/gh.mjs getIssue.
  const number = Number(s.filed[0].issue.split("/").pop());
  const issue = await you.getIssue(number);
  assert.equal(issue.html_url, s.filed[0].issue, "filed issue is fetchable at the URL the bot reported");
  assert.ok(issue.assignees.some((a) => a.login === me), `assigned to the promiser; got ${JSON.stringify(issue.assignees.map((a) => a.login))}`);
  assert.ok(issue.title.includes("retry"), `issue title names the promise; got "${issue.title}"`);
  issuesToClose.push(issue.number);
  const entries = reduceLedger(await you.commentsOn(ledger.number));
  assert.equal(entries.find((e) => e.id === iouId).status, "filed");
  evidence.items[8] = { issues_before: openBefore.length, filed: issue.html_url, title: issue.title, assignee: me, author: issue.user.login, ledger_status: "filed" };
});

test("11. a PR that KEEPS the promise settles it: one comment, ledger closed, no approval asked", async () => {
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
  assert.notEqual(withRetry, users, "the fixture must actually change, or this proves nothing");
  const prD = await openPr(`${run}-d`, "src/users.js", withRetry, "Add retry handling to fetchUser");
  const s = await tick(gh, { log, statePath, botLogin });
  assert.equal(s.settled.length, 1, `expected one settled IOU, got ${JSON.stringify(s)}`);
  assert.equal(s.resurfaced.length, 0, "a PR that keeps the promise must not also be nagged");
  const comments = (await you.commentsOn(prD.number)).filter((c) => c.body.startsWith("<!-- iou:settle"));
  assert.equal(comments.length, 1, "exactly one settle comment");
  assert.ok(!comments[0].body.includes("👍"), "a settled IOU asks nothing of anyone");
  const entries = reduceLedger(await you.commentsOn(ledger.number));
  assert.equal(entries.find((e) => e.id === iouId).status, "settled", "the ledger entry closes");
  evidence.items[11] = { pr: prD.html_url, comment: comments[0].html_url, author: comments[0].user.login, ledger_status: "settled", asked_for_approval: false };
});

test("10. every comment and issue the bot created was authored by the App, not a person", async () => {
  const ledgerComments = await you.commentsOn(ledger.number);
  const authors = new Set([
    ...ledgerComments.filter((c) => /<!--\s*iou[:\s]/.test(c.body)).map((c) => c.user.login),
    resurface.user.login,
  ]);
  assert.equal(authors.size, 1, `expected one bot author, got ${[...authors].join(", ")}`);
  const [author] = [...authors];
  assert.ok(author.endsWith("[bot]"), `bot comments must be authored by a GitHub App; got "${author}"`);
  assert.notEqual(author, me, "the bot must not be the human");
  evidence.items[10] = { author, human: me, ledger_entries: ledgerComments.length, resurface_author: resurface.user.login };
});
