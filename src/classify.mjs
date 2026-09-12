/**
 * Is this PR comment a promise of follow-up work? Fail closed.
 *
 * A promise = the commenter commits to doing further work LATER (a follow-up, a next PR,
 * "I'll ..."). Not a promise: praise, questions, refusals, sarcasm, things done in this PR.
 */
import { askJson } from "./llm.mjs";

const SYSTEM = `You classify comments from GitHub pull-request threads.
Decide whether the COMMENTER is committing to do further work LATER, outside this pull request
(a follow-up PR, "I'll add X", "will handle in a separate change", "next PR I'll ...").
NOT a promise: praise, questions, refusals ("I'll never do that"), jokes, requests aimed at
someone else, or work already done in this PR.
Output ONLY a JSON object, no prose, no code fence:
{"promise": true|false, "what": "<the concrete work promised, imperative, one line>" | null,
 "paths": ["<file paths mentioned or implied>"], "symbols": ["<function/class/identifier names mentioned>"],
 "confidence": 0.0-1.0}
When unsure, answer {"promise": false, ...}.`;

export async function classifyComment({ body, author, path = null }) {
  const user = [
    `Author: @${author}`,
    path ? `Inline on file: ${path}` : "PR conversation comment",
    "Comment:",
    "<<<",
    String(body).slice(0, 4000),
    ">>>",
  ].join("\n");
  const { json, raw, ms, cost } = await askJson(user, { system: SYSTEM });
  return { verdict: verdictFrom(json, path), raw, ms, cost };
}

/** Pure, testable: turns model JSON (or garbage) into a verdict. Null = not a promise. */
export function verdictFrom(json, inlinePath = null) {
  if (!json || json.promise !== true) return null;
  const what = typeof json.what === "string" ? json.what.trim() : "";
  if (!what) return null;
  const confidence = typeof json.confidence === "number" ? json.confidence : 0;
  if (confidence < 0.6) return null;
  const strs = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : []);
  const paths = strs(json.paths);
  if (inlinePath && !paths.includes(inlinePath)) paths.push(inlinePath);
  return { what, paths, symbols: strs(json.symbols), confidence };
}
