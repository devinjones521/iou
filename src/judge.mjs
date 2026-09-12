/**
 * Does this PR touch a promised area, and does it keep the promise? Two stages:
 *
 *  1. Deterministic pre-filter (no model): an IOU is a candidate only if one of its paths or
 *     symbols appears in the PR's changed files or patches. Why: the bot must be silent on
 *     unrelated PRs without spending a model call, and a deterministic gate cannot hallucinate.
 *  2. Model judgement on candidates only: does the diff FULFIL the promise? Fail closed:
 *     garbage → "not fulfilled" is NOT assumed either way — we treat unparseable output as
 *     "cannot tell" and stay silent. Silence is the safe default.
 */
import { askJson } from "./llm.mjs";

export function touchedIous(ious, files) {
  const changed = files.map((f) => ({ path: f.filename, patch: f.patch || "" }));
  return ious.filter((iou) => {
    const byPath = iou.paths.some((p) => changed.some((c) => c.path === p || c.path.endsWith("/" + p) || p.endsWith("/" + c.path)));
    const bySymbol = iou.symbols.some((s) => changed.some((c) => c.patch.includes(s)));
    return byPath || bySymbol;
  });
}

const SYSTEM = `You review a pull-request diff against a promise someone made earlier.
Answer ONLY a JSON object, no prose, no code fence:
{"fulfils": true|false, "reason": "<one sentence>"}
"fulfils" is true only if the diff clearly does the promised work. If the diff merely touches
the same code without doing that work, answer false. If you cannot tell, answer false with the
reason "cannot tell".`;

export async function judgeFulfilment(iou, files) {
  const patches = files
    .map((f) => `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${(f.patch || "").slice(0, 3000)}`)
    .join("\n\n")
    .slice(0, 12000);
  const user = `Promise by @${iou.who}: ${iou.what}\nMentioned paths: ${iou.paths.join(", ") || "none"}; symbols: ${iou.symbols.join(", ") || "none"}\n\nDiff:\n${patches}`;
  const { json, raw, ms, cost } = await askJson(user, { system: SYSTEM });
  return { verdict: fulfilmentFrom(json), raw, ms, cost };
}

/** Pure, testable. Returns {fulfils, reason} or null when the model output is unusable. */
export function fulfilmentFrom(json) {
  if (!json || typeof json.fulfils !== "boolean") return null;
  return { fulfils: json.fulfils, reason: typeof json.reason === "string" ? json.reason.slice(0, 300) : "" };
}
