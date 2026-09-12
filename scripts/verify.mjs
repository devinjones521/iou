#!/usr/bin/env node
/**
 * The only oracle. One command, one exit code, target under 30 seconds.
 *
 * Why one command: if "green" is a judgement call, it will be judged generously.
 * Why fast: this is called by the Stop hook, which Claude Code kills at 60s.
 *
 * Exit 0 = green. Any non-zero = red. Failures print RAW, never summarised —
 * a summary is the thing that lets a red run get narrated as amber.
 *
 * Every step must report one of: green / RED / a visible "not applicable" note.
 * Why: a step that silently returns null when it cannot run is indistinguishable
 * from a step that ran and passed, and that is how a gate ends up doing nothing
 * while everyone believes it is on. Both of the bugs found in this file on day
 * one were exactly that.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// A floor, not a target: if the suite shrinks below this, discovery broke or tests were deleted.
//
// This counts IOU's OWN tests only. It was 15 while bare `node --test` was also discovering
// archive/invite-idea/tests/adapter.test.mjs — the ABANDONED idea's 9 tests. IOU's real suite was
// 11, BELOW that floor: four IOU tests could have been deleted and this gate would still have read
// green off a dead project's suite. Discovery is now scoped to tests/ explicitly.
//
// The floor then sat at 11 while 31 tests actually ran, which is the same hole a size smaller —
// twenty could have gone missing unnoticed. A floor that trails the real count by 3x is decoration.
const MIN_TESTS = 28;

function step(name, fn) {
  const started = Date.now();
  try {
    const problem = fn();
    const ms = Date.now() - started;
    if (problem) {
      failures.push(`${name}: ${problem}`);
      console.log(`  RED   ${name} (${ms}ms)`);
    } else {
      console.log(`  green ${name} (${ms}ms)`);
    }
  } catch (err) {
    failures.push(`${name}: ${err.stack || err.message}`);
    console.log(`  RED   ${name} (threw)`);
  }
}

function note(msg) {
  console.log(`        ${msg}`);
}

/** Recursively collect source files under a directory. */
function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(mjs|cjs|js|ts|tsx|jsx)$/.test(entry)) out.push(p);
  }
  return out;
}

console.log("verify");

// --- 1. Scoreboard invariants ------------------------------------------------
// Enforced by the gate itself, because the scoreboard is the thing a pressured
// agent is most tempted to edit.
step("scoreboard", () => {
  const p = resolve(root, "feature_list.json");
  if (!existsSync(p)) return "feature_list.json is missing";
  const data = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(data.items)) return "feature_list.json has no items array";
  if (!data._contract) return "the _contract block was removed";
  const cheats = data.items.filter((i) => i.passes === true && !i.evidence);
  if (cheats.length) {
    return `items marked passes:true with no evidence: ${cheats.map((i) => i.id).join(", ")}`;
  }
  // Evidence must be checkable: a URL, or a file that actually exists on disk.
  const ghosts = data.items.filter((i) => i.passes === true && typeof i.evidence === "string"
    && !/^https?:\/\//.test(i.evidence) && !existsSync(resolve(root, i.evidence.split("#")[0])));
  if (ghosts.length) {
    return `items whose evidence file does not exist: ${ghosts.map((i) => `${i.id} (${i.evidence})`).join(", ")}`;
  }
  const bad = data.items.filter((i) => !["demo-path", "held-open"].includes(i.state));
  if (bad.length) return `items with an invalid state: ${bad.map((i) => i.id).join(", ")}`;
  return null;
});

// --- 2. Typecheck ------------------------------------------------------------
step("typecheck", () => {
  if (!existsSync(resolve(root, "tsconfig.json"))) {
    note("not applicable: no tsconfig.json (plain JS project)");
    return null;
  }
  const r = spawnSync("npx", ["--yes", "tsc", "--noEmit"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) return (r.stdout || "") + (r.stderr || "");
  return null;
});

// --- 3. Tests ----------------------------------------------------------------
step("tests", () => {
  const hasTests = existsSync(resolve(root, "tests"));
  const hasSrc = existsSync(resolve(root, "src"));
  // Held-open, not dead. Before any source exists there is nothing to prove, and a gate
  // that is RED at birth collapses "unproven" and "dead" into one state — which trains
  // the operator to wave it through, and that is how a real block gets ignored.
  if (!hasTests && !hasSrc) {
    note("held-open: no src/ yet, nothing to prove");
    return null;
  }
  if (!hasTests) return "src/ exists but there is no tests/ directory — nothing has been proven";
  // Two traps, both of which produced a GREEN run on zero tests before they were found:
  //
  // 1. `node --test tests/` — passed through a Windows shell the directory is parsed as a test
  //    FILE named "tests", so every run fails regardless of the actual tests. Use bare
  //    `node --test` and Node's own discovery, which already skips node_modules.
  // 2. NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID leaking in from the parent environment. Node
  //    sets these inside a test worker; if the shell that launches verify already has them
  //    (this agent's own session does), the child decides it is a recursive run, prints
  //    "skipping running files", runs NOTHING and exits 0. Strip them.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  // 3. Bare `node --test` discovers archive/invite-idea/tests too, inflating the count with the
  //    abandoned idea's suite. Pass IOU's test files explicitly so the number means IOU.
  const testFiles = sourceFiles(resolve(root, "tests")).filter((f) => /.test.mjs$/.test(f));
  if (testFiles.length === 0) return "tests/ exists but contains no *.test.mjs files";
  const r = spawnSync("node", ["--test", "--test-reporter=tap", ...testFiles], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) return out;
  // Exit 0 is NOT proof the tests ran. Demand a count. A run that discovered nothing, or was
  // skipped wholesale, reports "# pass 0" (or no plan at all) and must be RED — otherwise
  // "unproven" is indistinguishable from "proven", which is how this gate spent its first
  // hours reporting green while executing zero assertions.
  const passed = Number((out.match(/^# pass (\d+)\s*$/m) || [])[1] ?? -1);
  const failed = Number((out.match(/^# fail (\d+)\s*$/m) || [])[1] ?? -1);
  if (passed < 0 || failed < 0) return `the test runner produced no TAP summary — it ran nothing
${out.slice(0, 1500)}`;
  if (failed > 0) return out;
  if (passed < MIN_TESTS) return `only ${passed} tests ran; at least ${MIN_TESTS} are expected (did discovery silently skip?)`;
  note(`${passed} tests passed (IOU only; archive/ excluded)`);
  return null;
});

// --- 4. No invented record URLs ---------------------------------------------
// Every link the bot posts must be one the GitHub API returned. A fabricated URL in a
// demo is the most damaging thing a judge can catch. So: no `github.com` literals in
// src/ at all — the only allowed host literal is the API base in the adapter.
//
// Scoped to SOURCE FILES ONLY, never markdown or tests. Why: a guard that cries wolf on
// prose trains the operator to wave it through; tests legitimately hold example URLs.
step("no-invented-urls", () => {
  const files = sourceFiles(resolve(root, "src"));
  if (files.length === 0) {
    note("held-open: no source files yet");
    return null;
  }
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]*github\.com[^\s"'`)]*/gi)) {
      if (m[0] === "https://api.github.com") continue;
      offenders.push(`${relative(root, file)}: ${m[0]}`);
    }
  }
  if (offenders.length) {
    return `hard-coded github.com URL in source (links must come from the API)\n  ` + offenders.join("\n  ");
  }
  note(`scanned ${files.length} source file${files.length === 1 ? "" : "s"}`);
  return null;
});

// --- 5. Adapter cap, statically ----------------------------------------------
// The test asserts it too, but a static count here means the cap is checked even if
// someone deletes the test.
step("adapter-cap", () => {
  const p = resolve(root, "src", "github.mjs");
  if (!existsSync(p)) { note("held-open: no adapter yet"); return null; }
  const text = readFileSync(p, "utf8");
  const block = text.match(/OPERATIONS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!block) return "could not find the OPERATIONS declaration in src/github.mjs";
  const count = (block[1].match(/^\s*"[a-zA-Z]+"/gm) || []).length;
  if (count > 8) return `adapter declares ${count} operations; cap is 8`;
  note(`${count} operations declared`);
  return null;
});

// --- 6. The live end-to-end -------------------------------------------------
// MISSION: the live e2e is part of this one command and must report green / RED / a visible
// held-open note — never silently skip. Until this step existed, `npm run verify` printed
// "green" while items 3-8 (the ENTIRE demo path) had never been exercised. That is the third
// instance of this project's own anti-pattern, after the zero-tests gate and the 10:08 run.
//
// It is opt-in (IOU_LIVE=1) for two reasons, both recorded in DECISIONS.md: it takes minutes,
// well past the Stop hook's 60s budget; and while several agent sessions share the one
// playground repo, concurrent runs interleave their PRs and issues and poison each other's
// evidence. Opt-out is LOUD — never a silent pass.
// The "last live run" line used to be HARDCODED PROSE naming the 10:28:43 run. After a genuine
// 14:50 run it still announced 10:28 — a gate reporting something not derived from reality, which
// is the same anti-pattern its own comment above names. Read it off evidence/latest.json, and say
// plainly when there is nothing to read rather than implying a run that never happened.
function lastLiveRun() {
  try {
    const e = JSON.parse(readFileSync(resolve(root, "evidence/latest.json"), "utf8"));
    const when = e.finished || e.started;
    const items = Object.keys(e.items || {}).length;
    if (!when || !items) return null;
    return { when, items, repo: e.repo, run: e.run };
  } catch { return null; }
}

step("live-e2e", () => {
  if (process.env.IOU_LIVE !== "1") {
    note("HELD-OPEN: live e2e NOT RUN in THIS invocation (set IOU_LIVE=1 to run it).");
    note("HELD-OPEN: green below means the FAST checks passed. It is not a claim about the demo");
    note("HELD-OPEN: path, which only a live run can make.");
    const last = lastLiveRun();
    if (last) {
      note(`HELD-OPEN: last live run ${last.when}: ${last.items} demo-path items evidenced`);
      note(`HELD-OPEN: against the real ${last.repo} API; see evidence/latest.json (${last.run}).`);
      note("HELD-OPEN: that is history, not a statement about the code in front of you now.");
    } else {
      note("HELD-OPEN: NO readable evidence/latest.json -- there is no record of ANY live run.");
    }
    return null;
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const r = spawnSync("node", ["--test", "--test-reporter=tap", "tests/live.e2e.mjs"], {
    cwd: root, encoding: "utf8", env, timeout: 15 * 60 * 1000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) return out;
  // The backslashes matter: `(d+)s*` matches a literal "d" and NEVER a number, so a live run
  // that genuinely passed reports -1 and this step calls it RED. Found by session 5e, proven
  // against real TAP output before the fix. Fails shut, not open — but it would have sent the
  // first good serial run hunting a failure that was not there.
  const passed = Number((out.match(/^# pass (\d+)\s*$/m) || [])[1] ?? -1);
  const failed = Number((out.match(/^# fail (\d+)\s*$/m) || [])[1] ?? -1);
  if (failed > 0) return out;
  if (passed < 1) return `the live e2e produced no passing TAP assertions — it proved nothing
${out.slice(0, 1500)}`;
  note(`${passed} live assertions passed against the real GitHub API`);
  return null;
});

// --- Honest closing summary --------------------------------------------------
// "green" must never be mistaken for "the product works". Report what is still unproven.
function scoreboardSummary() {
  try {
    const data = JSON.parse(readFileSync(resolve(root, "feature_list.json"), "utf8"));
    const demo = data.items.filter((i) => i.state === "demo-path");
    const unproven = demo.filter((i) => i.passes !== true);
    return { total: demo.length, unproven: unproven.map((i) => i.id) };
  } catch { return null; }
}

if (failures.length) {
  console.error("\n--- RED ---");
  for (const f of failures) console.error(f);
  process.exit(1);
}
const sum = scoreboardSummary();
if (sum && sum.unproven.length) {
  console.log(`\ngreen (gate) — but ${sum.unproven.length}/${sum.total} demo-path items are still UNPROVEN: ${sum.unproven.join(", ")}`);
  console.log("green here means the fast checks passed. It is NOT a claim that the product works.");
} else {
  console.log("\ngreen");
}
