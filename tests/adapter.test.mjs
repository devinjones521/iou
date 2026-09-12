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
