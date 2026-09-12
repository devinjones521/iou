/**
 * The adapter cap, and the failure path against a server that fails on demand.
 *
 * LIMITATIONS.md: GitHub cannot be made to return a 500 when asked, so the retry/degrade tests
 * point the REAL adapter at a local HTTP server. The adapter code path is identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS, github, GitHubError } from "../src/github.mjs";
import { tick } from "../src/tick.mjs";
import { formatEntry } from "../src/ledger.mjs";

test("adapter declares at most 8 operations", () => {
  assert.ok(OPERATIONS.length <= 8, `declared ${OPERATIONS.length} operations, cap is 8`);
});

test("every client method is a declared operation and vice versa", () => {
  const client = github({ owner: "o", repo: "r", token: "t" });
  const methods = Object.keys(client).sort();
  assert.deepEqual(methods, [...OPERATIONS].sort());
  assert.ok(Object.isFrozen(client), "client must be frozen so nothing can add a method at runtime");
});

function failingServer(plan) {
  // plan: array of status codes to return in order; after it is exhausted, 200 with [].
  let i = 0;
  const server = createServer((req, res) => {
    const status = i < plan.length ? plan[i++] : 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? "[]" : JSON.stringify({ message: `forced ${status}` }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test("forced 5xx: retries with backoff, then succeeds", async () => {
  const { server, base } = await failingServer([500, 502]);
  const logs = [];
  try {
    const gh = github({ owner: "o", repo: "r", token: "t", base, backoffMs: 1, log: (m) => logs.push(m) });
    const out = await gh.listIssues();
    assert.deepEqual(out, []);
    assert.equal(logs.filter((l) => l.startsWith("retry")).length, 2, logs.join("\n"));
  } finally {
    server.close();
  }
});

test("forced 5xx beyond the retry budget: throws a typed error, never hangs", async () => {
  const { server, base } = await failingServer([503, 503, 503, 503, 503]);
  try {
    const gh = github({ owner: "o", repo: "r", token: "t", base, retries: 2, backoffMs: 1 });
    await assert.rejects(() => gh.listIssues(), (err) => err instanceof GitHubError && err.status === 503);
  } finally {
    server.close();
  }
});

test("tick degrades gracefully when GitHub is down: no crash, cursor not advanced", async () => {
  const { server, base } = await failingServer([500, 500, 500, 500, 500, 500]);
  const statePath = join(mkdtempSync(join(tmpdir(), "iou-")), "state.json");
  const logs = [];
  try {
    const gh = github({ owner: "o", repo: "r", token: "t", base, retries: 1, backoffMs: 1 });
    const summary = await tick(gh, { log: (m) => logs.push(m), statePath });
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].stage, "ensureLedger");
    assert.ok(logs.some((l) => l.startsWith("DEGRADED")), logs.join("\n"));
  } finally {
    server.close();
  }
});

/**
 * Regression: the ledger is the memory, so it must be consulted before recording.
 *
 * Observed in production 12 Sep 14:52. The deployed service was stopped at 14:49, the e2e ran at
 * 14:50 taking a promise through open -> filed -> settled, and on restart the service — whose
 * state file predated those comments — re-read the source comment and recorded the promise AGAIN,
 * resurrecting a settled IOU. `state.handledComments` structurally cannot catch this: local state
 * is exactly what the repository-resident ledger is supposed to outlive.
 *
 * Driven through the real adapter against a fake GitHub, like the 5xx tests above. The assertion
 * that matters is the negative one: no POST to the ledger, and no model call (classify would throw
 * here, since no model backend is configured — so if the dedupe fails, the test fails loudly).
 */
function ledgerServer({ ledgerNumber = 7, entries = [], prComments = [] }) {
  const posts = [];
  const server = createServer((req, res) => {
    const url = req.url.split("?")[0];
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST") {
      let raw = ""; req.on("data", (d) => (raw += d));
      req.on("end", () => { posts.push({ url, body: JSON.parse(raw || "{}") }); json({ id: 1, html_url: "http://x/c/1" }); });
      return;
    }
    if (url.endsWith("/issues")) return json([{ number: ledgerNumber, title: "IOU ledger", labels: [{ name: "iou-ledger" }], state: "open", html_url: "http://x/i/7" }]);
    if (url.endsWith("/issues/comments")) return json([...entries, ...prComments]);
    if (url.endsWith("/pulls/comments")) return json([]);
    if (url.endsWith("/pulls")) return json([]);
    return json([]);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, posts, base: `http://127.0.0.1:${server.address().port}` })));
}

test("a promise already in the ledger is not recorded again, and costs no model call", async () => {
  const LEDGER = 7, SRC = 424242;
  // The ledger read is author-filtered now: entries not written by the bot are conversation, not
  // memory. So the fixture has to wear the same login the code will check against.
  const BOT = "iou-test[bot]";
  const prevBot = process.env.IOU_BOT_LOGIN;
  process.env.IOU_BOT_LOGIN = BOT;
  const entry = (status) => ({
    id: 900 + status.length, issue_url: `http://x/repos/o/r/issues/${LEDGER}`,
    user: { login: BOT }, created_at: "2026-09-12T14:50:00Z",
    html_url: `http://x/repos/o/r/issues/${LEDGER}#issuecomment-${900 + status.length}`,
    body: formatEntry({ id: `c${SRC}`, status, who: "contributor", what: "Add retry handling to fetchUser", source: "http://x/s" }),
  });
  const { server, posts, base } = await ledgerServer({
    ledgerNumber: LEDGER,
    entries: [entry("open"), entry("filed"), entry("settled")],
    prComments: [{
      id: SRC, issue_url: "http://x/repos/o/r/issues/41", user: { login: "contributor" },
      created_at: "2026-09-12T14:49:00Z", html_url: "http://x/repos/o/r/pull/41#issuecomment-424242",
      body: "I'll add retry handling to fetchUser in a follow-up PR.",
    }],
  });
  const statePath = join(mkdtempSync(join(tmpdir(), "iou-")), "state.json");
  const logs = [];
  try {
    const gh = github({ owner: "o", repo: "r", token: "t", base, backoffMs: 1 });
    const summary = await tick(gh, { log: (m) => logs.push(m), statePath });
    assert.equal(posts.length, 0, `nothing should have been posted, got:\n${JSON.stringify(posts, null, 2)}`);
    assert.equal(summary.recorded.length, 0, "must not re-record a promise the ledger already holds");
    assert.equal(summary.errors.length, 0, `no errors expected, got: ${JSON.stringify(summary.errors)}`);
    assert.ok(summary.skipped.some((s) => s.reason === "already in the ledger"), JSON.stringify(summary.skipped));
    assert.ok(logs.some((l) => l.includes("already in the ledger")), logs.join("\n"));
  } finally {
    server.close();
    if (prevBot === undefined) delete process.env.IOU_BOT_LOGIN; else process.env.IOU_BOT_LOGIN = prevBot;
  }
});

/**
 * Regression: a repo-wide list must be read to the end, not to the end of page one.
 *
 * `listIssueComments` is repo-wide and the ledger is an issue, so ledger entries share the page
 * budget with every pull-request comment in the repository. Measured on the live playground at
 * 105 comments: page one held 14 of the ledger's 16 entries and dropped the two NEWEST — the ones
 * that decide current state. The bot reduced a stale ledger and went silent on a pull request it
 * should have spoken about. Silence is this product's default, so the bug hid in plain sight.
 */
test("listIssueComments reads every page, not just the first", async () => {
  const TOTAL = 105, PER = 100;
  const pagesServed = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const page = Number(u.searchParams.get("page") || 1);
    const per = Number(u.searchParams.get("per_page") || PER);
    pagesServed.push(page);
    const start = (page - 1) * per;
    const body = Array.from({ length: Math.max(0, Math.min(per, TOTAL - start)) },
      (_, i) => ({ id: start + i, body: `c${start + i}`, issue_url: "http://x/repos/o/r/issues/67" }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const gh = github({ owner: "o", repo: "r", token: "t", base: `http://127.0.0.1:${server.address().port}`, backoffMs: 1 });
    const all = await gh.listIssueComments({ since: "2000-01-01T00:00:00Z" });
    assert.equal(all.length, TOTAL, `must return all ${TOTAL}, got ${all.length} — the newest entries are the ones that get dropped`);
    assert.deepEqual(pagesServed, [1, 2], "should stop as soon as a short page comes back");
    assert.equal(all.at(-1).id, TOTAL - 1, "the LAST comment is the one that decides current ledger state");
  } finally {
    server.close();
  }
});
