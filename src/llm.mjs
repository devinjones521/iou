/**
 * Model backend, as a provider chain. First one configured wins:
 *
 *   1. ANTHROPIC_API_KEY   → the official Anthropic SDK. The real backend: deployable, cheap,
 *                            and the only one a stranger cloning this repo can use.
 *   2. OPENROUTER_API_KEY  → OpenRouter over plain HTTP, for anyone without an Anthropic key.
 *   3. the `claude` CLI    → local convenience only. Runs on the operator's own Claude Code
 *                            login, so it is neither deployable nor reproducible by anyone else.
 *
 * Why the chain and not just the CLI: the CLI shells out to an interactive-login tool, which
 * cannot be put on a server and cannot be run by a judge cloning this repo. It is also ~25x more
 * expensive per call, because it injects ~22k tokens of its own scaffolding into every request:
 * measured 946 real prompt tokens against 21,863 billed. The API path sends only our prompt.
 *
 * Everything that reads model output goes through `parseJsonObject`, which FAILS CLOSED:
 * garbage → null, and every caller treats null as "no" (not a promise / cannot tell). A bot that
 * invents a promise from a parse error is worse than one that misses a real one.
 */
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

// Opus by default. An earlier draft defaulted to a cheaper model to spend less of the operator's
// quota, which trades the product's accuracy for someone else's budget without telling them and is
// not the author's call to make silently. IOU_MODEL overrides it; the spend ceiling in budget.mjs
// is the safety mechanism, not a quiet downgrade.
// Read at CALL time, not at module-evaluation time. ESM hoists imports, so anything computed at
// module scope here is fixed before `loadDotEnv()` in watch.mjs has run — which meant IOU_MODEL in
// a .env file was silently ignored and the startup banner printed the wrong model. util.mjs warns
// about exactly this coupling one file over. Systemd was unaffected (EnvironmentFile sets real env
// vars); every local user was not.
export const modelId = () => process.env.IOU_MODEL || "claude-opus-5";
const CLI_MODEL = () => process.env.IOU_CLI_MODEL || "opus";
const MAX_TOKENS = 1024; // these are small JSON answers; the ceiling is a guard, not a target

let client = null;
function anthropic() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

/** Which backend is in play. Logged at startup so it is never a mystery which one ran. */
export function backend(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return "anthropic-api";
  if (env.OPENROUTER_API_KEY) return "openrouter";
  return "claude-cli";
}

export async function ask(userText, { system, model = modelId(), timeoutMs = 60_000 } = {}) {
  switch (backend()) {
    case "anthropic-api": return askAnthropic(userText, system, model);
    case "openrouter": return askOpenRouter(userText, system, timeoutMs);
    default: return askCli(userText, system, timeoutMs);
  }
}

async function askAnthropic(userText, system, model) {
  const started = Date.now();
  const res = await anthropic().messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userText }],
  });
  // Guard before reading content: a safety decline returns HTTP 200 with stop_reason "refusal".
  // Treated like any other unusable answer — the caller's fail-closed path turns it into silence.
  if (res.stop_reason === "refusal") {
    return { text: "", ms: Date.now() - started, usage: res.usage, refused: true };
  }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, ms: Date.now() - started, usage: res.usage };
}

async function askOpenRouter(userText, system, timeoutMs) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.IOU_OPENROUTER_MODEL || "anthropic/claude-opus-4.5",
        max_tokens: MAX_TOKENS,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: userText }],
      }),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    return { text: j.choices?.[0]?.message?.content ?? "", ms: Date.now() - started, usage: j.usage };
  } finally {
    clearTimeout(timer);
  }
}

function askCli(userText, system, timeoutMs) {
  const args = ["-p", userText, "--model", CLI_MODEL(), "--output-format", "json", "--max-turns", "1"];
  if (system) args.push("--system-prompt", system);
  const env = { ...process.env };
  delete env.CLAUDECODE; // the CLI refuses to nest inside a Claude Code session otherwise
  // Node sets these inside every `node --test` worker and the live e2e runs there, so the child
  // inherits them. Hygiene, not a fix — measured, and not the cause of the CLI timeouts that
  // LIMITATIONS.md describes.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return new Promise((resolve, reject) => {
    // NEVER shell:true here. On Windows the args are concatenated unescaped and the prompt
    // contains `>>>`, which the shell reads as a redirect. stdio ignore on stdin stops the CLI
    // waiting for piped input that never comes.
    const child = spawn("claude", args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`llm timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Report BOTH streams. The CLI writes usage-limit and auth failures to stdout as JSON and
      // leaves stderr empty, so a stderr-only message reads "claude exited 1:" and says nothing.
      if (code !== 0) {
        const detail = [err.trim(), out.trim()].filter(Boolean).join(" | ").slice(0, 600);
        return reject(new Error(`claude exited ${code}${detail ? `: ${detail}` : " with no output on either stream"}`));
      }
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) return reject(new Error(`claude error: ${String(parsed.result).slice(0, 300)}`));
        resolve({ text: String(parsed.result ?? ""), ms: parsed.duration_api_ms ?? null, cost: parsed.total_cost_usd ?? null });
      } catch {
        reject(new Error(`unparseable claude output: ${out.slice(0, 300)}`));
      }
    });
  });
}

/** Extract the first {...} object from model text. Returns null on anything but a JSON object. */
export function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function askJson(userText, opts) {
  const { text, ms, cost, usage } = await ask(userText, opts);
  return { json: parseJsonObject(text), raw: text, ms, cost, usage };
}
