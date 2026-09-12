/**
 * Model backend: the Claude Code CLI in headless mode.
 *
 * Why (see DECISIONS.md): no API key was available on the build machine, and `claude -p` is a real
 * model call rather than a mock — measured at roughly 3–7 s per call. To undo: set
 * ANTHROPIC_API_KEY and replace `ask` with the SDK.
 *
 * Everything that reads model output goes through `parseJsonObject`, which FAILS CLOSED:
 * garbage → null, and callers treat null as "no" (not a promise / not touched). Why: the
 * rubric rewards restraint, and a bot that invents a promise from a parse error is worse than
 * one that stays silent.
 */
import { spawn } from "node:child_process";

// Opus by default. An earlier draft defaulted to a cheaper model to spend less of the operator's
// quota — which trades the product's accuracy for someone else's budget without telling them, and
// is not the author's call to make silently. IOU_MODEL=haiku exists for iterating.
export const MODEL = process.env.IOU_MODEL || "opus";

export function ask(userText, { system, model = MODEL, timeoutMs = 60_000 } = {}) {
  const args = ["-p", userText, "--model", model, "--output-format", "json", "--max-turns", "1"];
  if (system) args.push("--system-prompt", system);
  const env = { ...process.env };
  delete env.CLAUDECODE; // the CLI refuses to nest inside a Claude Code session otherwise
  // Hygiene, NOT a fix: Node sets these inside every `node --test` worker and the live e2e runs
  // there, so the CLI child inherits them. I theorised this caused the 10:08 60s timeouts and
  // TESTED IT — it does not. A/B against the real CLI: clean env 6015ms, with both variables set
  // 5122ms, both exit 0. Theory dead. Stripping them stays because a test-runner variable has no
  // business in an unrelated child, but the timeout cause is still unknown (see BLOCKED.md).
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return new Promise((resolve, reject) => {
    // NEVER shell:true here. On Windows the args are concatenated unescaped, and the classify
    // prompt contains `>>>` — the shell reads that as a redirect and the call hangs until the
    // timeout. That cost the 10:08 e2e every classification. stdio ignore on stdin stops the
    // CLI waiting 3 s for piped input that never comes.
    const child = spawn("claude", args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`llm timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Report BOTH streams. The CLI writes its most useful failures (usage limits, auth) to
      // stdout as JSON and leaves stderr empty, so a stderr-only message reads "claude exited 1:"
      // and tells you nothing — which is exactly what it did on the first settle-beat run.
      if (code !== 0) {
        const detail = [err.trim(), out.trim()].filter(Boolean).join(" | ").slice(0, 600);
        return reject(new Error(`claude exited ${code}${detail ? `: ${detail}` : " with no output on either stream"}`));
      }
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) return reject(new Error(`claude error: ${String(parsed.result).slice(0, 300)}`));
        resolve({ text: String(parsed.result ?? ""), ms: parsed.duration_api_ms ?? null, cost: parsed.total_cost_usd ?? null });
      } catch (e) {
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
  const { text, ms, cost } = await ask(userText, opts);
  return { json: parseJsonObject(text), raw: text, ms, cost };
}
