/** Fail-closed parsing and deterministic matching. No network, no model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonObject } from "../src/llm.mjs";
import { verdictFrom } from "../src/classify.mjs";
import { fulfilmentFrom, touchedIous } from "../src/judge.mjs";
import { formatEntry, parseEntry, reduceLedger, openIous, ensureLedger, retireLedger, LEDGER_LABEL } from "../src/ledger.mjs";
import { resurfaceBody, settleBody } from "../src/tick.mjs";

test("parseJsonObject: garbage, arrays, prose and fences all fail closed", () => {
  for (const bad of ["", "not json", "[1,2]", "{", "{'promise': true}", null, undefined, 42]) {
    assert.equal(parseJsonObject(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Sure! {"promise": false, "what": null} hope that helps'), { promise: false, what: null });
});

test("verdictFrom: only a confident, concrete promise survives", () => {
  assert.equal(verdictFrom(null), null);
  assert.equal(verdictFrom({ promise: false, what: "x", confidence: 0.99 }), null);
  assert.equal(verdictFrom({ promise: "true", what: "x", confidence: 0.99 }), null, "string true is not true");
  assert.equal(verdictFrom({ promise: true, what: "", confidence: 0.99 }), null, "empty what");
  assert.equal(verdictFrom({ promise: true, what: "add retries", confidence: 0.3 }), null, "low confidence");
  assert.equal(verdictFrom({ promise: true, what: "add retries" }), null, "missing confidence");
  const v = verdictFrom({ promise: true, what: " add retries ", paths: ["src/users.js", 3], symbols: ["fetchUser"], confidence: 0.9 }, "src/users.js");
  assert.deepEqual(v, { what: "add retries", paths: ["src/users.js"], symbols: ["fetchUser"], confidence: 0.9 });
  const inline = verdictFrom({ promise: true, what: "x", confidence: 0.8 }, "src/a.js");
  assert.deepEqual(inline.paths, ["src/a.js"], "inline comment path is attached");
});

test("fulfilmentFrom: anything but a boolean is 'cannot tell'", () => {
  assert.equal(fulfilmentFrom(null), null);
  assert.equal(fulfilmentFrom({ fulfils: "yes" }), null);
  assert.deepEqual(fulfilmentFrom({ fulfils: false, reason: "only touches" }), { fulfils: false, reason: "only touches" });
});

test("touchedIous: deterministic path and symbol matching", () => {
  const ious = [
    { id: "a", paths: ["src/users.js"], symbols: [] },
    { id: "b", paths: [], symbols: ["invoiceTotal"] },
    { id: "c", paths: ["docs/x.md"], symbols: ["nothingHere"] },
  ];
  const files = [
    { filename: "src/users.js", patch: "@@ -1 +1 @@\n-x\n+y" },
    { filename: "src/billing.js", patch: "+export function invoiceTotal(lines) {" },
  ];
  assert.deepEqual(touchedIous(ious, files).map((i) => i.id), ["a", "b"]);
  assert.deepEqual(touchedIous(ious, [{ filename: "README.md", patch: "+hello" }]), []);
});

test("ledger: entries round-trip and the latest status wins", () => {
  const open = { id: "c1", status: "open", who: "dev", what: "add retries", paths: [], symbols: [], source: "https://github.com/o/r/pull/1#issuecomment-1", pr: 1 };
  const body = formatEntry(open);
  assert.deepEqual(parseEntry(body), open);
  assert.equal(parseEntry("no marker here"), null);
  assert.equal(parseEntry("<!-- iou {not json} -->"), null);
  const filed = formatEntry({ ...open, status: "filed", issue_url: "https://x/issues/9" });
  const state = reduceLedger([{ body }, { body: filed }, { body: "unrelated comment" }]);
  assert.equal(state.length, 1);
  assert.equal(state[0].status, "filed");
  assert.equal(openIous(state).length, 0);
});

test("resurfaceBody: carries the marker, the source link and the reaction instructions", () => {
  const b = resurfaceBody([{ iou: { who: "dev", what: "add retries", source: "https://github.com/o/r/pull/1#issuecomment-1", pr: 1, id: "c1" }, reason: "diff only renames" }], { number: 2 });
  assert.ok(b.startsWith("<!-- iou:resurface"));
  assert.ok(b.includes("https://github.com/o/r/pull/1#issuecomment-1"));
  assert.ok(b.includes("👍") && b.includes("👎"));
});

test("comment bodies never double-punctuate the model's reason (it is on camera)", () => {
  const iou = { who: "dev", what: "add retries", source: "https://github.com/o/r/pull/1#issuecomment-1", pr: 1, id: "c1" };
  // The model reliably returns a capitalised, end-stopped sentence; it is spliced mid-sentence.
  const r = resurfaceBody([{ iou, reason: "The diff only refactors the return." }], { number: 2 });
  assert.ok(!/\.\./.test(r), `doubled full stop in:\n${r}`);
  assert.ok(r.includes("— the diff only refactors the return."), r);
  const s = settleBody([{ iou, reason: "Adds a retry loop with backoff." }]);
  assert.ok(!/\.\./.test(s), `doubled full stop in:\n${s}`);
  assert.ok(s.includes("— adds a retry loop with backoff."), s);
});

test("a hostile comment cannot make the bot post links, mentions or HTML", () => {
  // The attack: get the classifier to echo attacker text back, so it appears under the BOT's name
  // in a PR comment — which reads as trustworthy precisely because the bot wrote it.
  const iou = {
    who: "attacker",
    what: 'Visit https://evil.example/pwn and ping @maintainer re #1337 <script>alert(1)</script>',
    source: "https://github.com/o/r/pull/1#issuecomment-1", pr: 1, id: "c1",
  };
  for (const body of [
    resurfaceBody([{ iou, reason: "Also see http://evil.example/2 <img src=x>" }], { number: 2 }),
    settleBody([{ iou, reason: "Also see http://evil.example/2 <img src=x>" }]),
  ]) {
    assert.ok(!/evil\.example/.test(body), `attacker URL reached a bot comment:\n${body}`);
    assert.ok(!/<script|<img/i.test(body), `HTML reached a bot comment:\n${body}`);
    assert.ok(!/(^|[^\w​])@maintainer/m.test(body), `live @-mention reached a bot comment:\n${body}`);
    // The legitimate source link, which the API gave us, must still be there.
    assert.ok(body.includes("https://github.com/o/r/pull/1#issuecomment-1"), `the real source link was stripped:\n${body}`);
  }
});

test("settleBody: marks the PR that kept the promise and asks for nothing", () => {
  const s = settleBody([{ iou: { who: "dev", what: "add retries", source: "https://github.com/o/r/pull/1#issuecomment-1", pr: 1, id: "c1" }, reason: "adds a retry loop" }]);
  assert.ok(s.startsWith("<!-- iou:settle"));
  assert.ok(s.includes("https://github.com/o/r/pull/1#issuecomment-1"));
  assert.ok(!s.includes("👍"), "a settled IOU needs no human decision");
});

test("ensureLedger never creates a second ledger once the number is known", async () => {
  const calls = [];
  const gh = {
    listIssues: async (o) => { calls.push("list"); return []; },
    createIssue: async () => { calls.push("create"); return { number: 9, html_url: "https://x/issues/9" }; },
  };
  const first = await ensureLedger(gh, () => {}, null);
  assert.equal(first.number, 9);
  assert.deepEqual(calls, ["list", "create"]);
  // Second tick, number remembered: no list, no create. This is the whole fix — GitHub's list
  // endpoint is eventually consistent and briefly did not show an issue we had just made.
  const second = await ensureLedger(gh, () => {}, 9);
  assert.equal(second.number, 9);
  assert.deepEqual(calls, ["list", "create"], "a remembered ledger must cause NO further API calls");
});

test("ensureLedger picks the ledger with the ENTRIES, not the oldest, and says so", async () => {
  // These are the real numbers from the race. #50 was created first and stayed EMPTY; the tick
  // that created #51 is the one that then wrote to it. "Use the oldest" is the obvious rule and
  // it would silently adopt the empty one and abandon every promise in the other.
  const warnings = [];
  const gh = {
    listIssues: async () => ([
      { number: 51, created_at: "2026-09-12T12:51:24Z", comments: 3 },
      { number: 50, created_at: "2026-09-12T12:51:17Z", comments: 0 },
    ]),
    createIssue: async () => { throw new Error("must not create when ledgers already exist"); },
  };
  const led = await ensureLedger(gh, (m) => warnings.push(m), null);
  assert.equal(led.number, 51, "the ledger with entries holds the history, regardless of age");
  assert.match(warnings.join("\n"), /2 issues labelled iou-ledger/);
  assert.match(warnings.join("\n"), /#50/, "it must name the strays so a human can close them");
});

test("ensureLedger falls back to age only when entry counts tie", async () => {
  const gh = {
    listIssues: async () => ([
      { number: 9, created_at: "2026-09-12T13:00:00Z", comments: 0 },
      { number: 7, created_at: "2026-09-12T12:00:00Z", comments: 0 },
    ]),
    createIssue: async () => { throw new Error("must not create"); },
  };
  assert.equal((await ensureLedger(gh, () => {}, null)).number, 7);
});

test("ledger: a settled entry reads as kept, not as filed", () => {
  const body = formatEntry({ id: "c1", status: "settled", who: "dev", what: "add retries", settled_by: "PR #9" });
  assert.ok(body.includes("kept by PR #9"), body);
  assert.equal(parseEntry(body).status, "settled");
  assert.equal(openIous(reduceLedger([{ body }])).length, 0, "settled is not open");
});

/**
 * Security regression: the ledger is a PUBLIC issue, so anyone can comment on it.
 *
 * Before this was closed, a stranger could post `<!-- iou {...} -->` on the ledger and the bot
 * parsed it as one of its own memory records — then rendered `who` and `source` RAW into a comment
 * it posted under its own bot identity. That is an arbitrary @-mention and arbitrary-link
 * primitive, and on 👍 an arbitrary issue assignee, all wearing the bot's face.
 *
 * Two independent controls now stand between a stranger and that comment. This covers the second:
 * even handed a poisoned record directly, nothing that is not a real login reaches an `@`, and
 * nothing that is not a URL inside github.com gets linked.
 */
test("a poisoned ledger record cannot make the bot mention or link anything", () => {
  const poisoned = {
    id: "cX", status: "open", pr: "9999 malicious",
    who: 'nobody**  @torvalds @gvanrossum ROTATE YOUR KEYS NOW at promised:**',
    what: "do the thing",
    source: "https://evil.example/phish",
  };
  const body = resurfaceBody([{ iou: poisoned, reason: "" }], { number: 1 });

  assert.ok(!body.includes("@torvalds"), `leaked a mention:\n${body}`);
  assert.ok(!body.includes("@gvanrossum"), `leaked a mention:\n${body}`);
  assert.ok(!body.includes("evil.example"), `leaked a link:\n${body}`);
  assert.ok(body.includes("**Someone promised:**"), `should fall back to an anonymous form:\n${body}`);
  assert.ok(!/\(\[where\]/.test(body), `should not render a link at all for a rejected source:\n${body}`);
});

test("a legitimate ledger record still renders the mention and the link", () => {
  const real = {
    id: "c1", status: "open", pr: 70, who: "devinjones521",
    what: "Add retry handling to fetchUser",
    source: "https://github.com/devinjones521/iou-playground/pull/68#issuecomment-1",
  };
  const body = resurfaceBody([{ iou: real, reason: "no retry logic" }], { number: 70 });
  assert.ok(body.includes("**@devinjones521 promised:**"), body);
  assert.ok(body.includes("https://github.com/devinjones521/iou-playground/pull/68#issuecomment-1"), body);
  assert.ok(body.includes("PR #70"), body);
});


/**
 * Staging a demo needs the ledger empty. Deleting its comments achieves that and destroys the
 * record: evidence files cite individual ledger comments by URL, so a delete turns someone else's
 * proof into a 404 hours later. Five URLs were lost that way before this existed.
 *
 * Retiring closes the issue and strips the label, so ensureLedger opens a fresh one and every old
 * comment stays readable at its original URL.
 */
test("retiring a ledger closes and unlabels it, and deletes nothing", async () => {
  const calls = [];
  const you = {
    updateIssue: (number, patch) => { calls.push({ op: "updateIssue", number, patch }); return {}; },
    // Present so that a reintroduced delete would be recorded rather than throwing.
    deleteComment: (id) => { calls.push({ op: "deleteComment", id }); return {}; },
    commentsOn: () => { calls.push({ op: "commentsOn" }); return []; },
  };

  await retireLedger(you, 67);

  assert.ok(!calls.some((c) => c.op === "deleteComment"), `must not delete a ledger comment: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((c) => c.op === "commentsOn"), `must not even enumerate comments to delete them: ${JSON.stringify(calls)}`);
  const patch = calls.find((c) => c.op === "updateIssue");
  assert.ok(patch, `expected the ledger to be updated, got ${JSON.stringify(calls)}`);
  assert.equal(patch.number, 67);
  assert.equal(patch.patch.state, "closed", "a retired ledger is closed");
  assert.deepEqual(patch.patch.labels, [], "the label is stripped so ensureLedger opens a fresh one");
});

test("a retired ledger is invisible to ensureLedger, which opens a fresh one", async () => {
  // After retirement the label is gone, so the labelled-issue lookup returns nothing.
  const created = [];
  const gh = {
    listIssues: async () => [],
    createIssue: async (spec) => { created.push(spec); return { number: 99, html_url: "https://github.com/o/r/issues/99" }; },
  };
  const ledger = await ensureLedger(gh, () => {}, null);
  assert.equal(ledger.number, 99, "a fresh ledger is opened");
  assert.equal(created.length, 1);
  assert.ok(created[0].labels.includes(LEDGER_LABEL), `the new ledger carries the label: ${JSON.stringify(created[0].labels)}`);
});
