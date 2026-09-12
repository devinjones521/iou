/** Fail-closed parsing and deterministic matching. No network, no model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonObject } from "../src/llm.mjs";
import { verdictFrom } from "../src/classify.mjs";
import { fulfilmentFrom, touchedIous } from "../src/judge.mjs";
import { formatEntry, parseEntry, reduceLedger, openIous } from "../src/ledger.mjs";
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
  const open = { id: "c1", status: "open", who: "dev", what: "add retries", paths: [], symbols: [], source: "https://x/pull/1#issuecomment-1", pr: 1 };
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
  const b = resurfaceBody([{ iou: { who: "dev", what: "add retries", source: "https://x/pull/1#issuecomment-1", pr: 1, id: "c1" }, reason: "diff only renames" }], { number: 2 });
  assert.ok(b.startsWith("<!-- iou:resurface"));
  assert.ok(b.includes("https://x/pull/1#issuecomment-1"));
  assert.ok(b.includes("👍") && b.includes("👎"));
});

test("comment bodies never double-punctuate the model's reason (it is on camera)", () => {
  const iou = { who: "dev", what: "add retries", source: "https://x/pull/1#issuecomment-1", pr: 1, id: "c1" };
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
    source: "https://x/pull/1#issuecomment-1", pr: 1, id: "c1",
  };
  for (const body of [
    resurfaceBody([{ iou, reason: "Also see http://evil.example/2 <img src=x>" }], { number: 2 }),
    settleBody([{ iou, reason: "Also see http://evil.example/2 <img src=x>" }]),
  ]) {
    assert.ok(!/evil\.example/.test(body), `attacker URL reached a bot comment:\n${body}`);
    assert.ok(!/<script|<img/i.test(body), `HTML reached a bot comment:\n${body}`);
    assert.ok(!/(^|[^\w​])@maintainer/m.test(body), `live @-mention reached a bot comment:\n${body}`);
    // The legitimate source link, which the API gave us, must still be there.
    assert.ok(body.includes("https://x/pull/1#issuecomment-1"), `the real source link was stripped:\n${body}`);
  }
});

test("settleBody: marks the PR that kept the promise and asks for nothing", () => {
  const s = settleBody([{ iou: { who: "dev", what: "add retries", source: "https://x/pull/1#issuecomment-1", pr: 1, id: "c1" }, reason: "adds a retry loop" }]);
  assert.ok(s.startsWith("<!-- iou:settle"));
  assert.ok(s.includes("https://x/pull/1#issuecomment-1"));
  assert.ok(!s.includes("👍"), "a settled IOU needs no human decision");
});

test("ledger: a settled entry reads as kept, not as filed", () => {
  const body = formatEntry({ id: "c1", status: "settled", who: "dev", what: "add retries", settled_by: "PR #9" });
  assert.ok(body.includes("kept by PR #9"), body);
  assert.equal(parseEntry(body).status, "settled");
  assert.equal(openIous(reduceLedger([{ body }])).length, 0, "settled is not open");
});
