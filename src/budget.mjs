/**
 * Spend control for an always-on bot whose triggers come from strangers.
 *
 * The threat is not the price of a call — one classification is about $0.003 on Opus and $0.0007
 * on Haiku. The threat is UNBOUNDED calls: anyone with a GitHub account can comment on a public
 * repository, and every comment is a model call unless something stops it.
 *
 * Three ceilings, cheapest check first, all of them FAIL CLOSED. When a ceiling is hit the bot
 * does what it always does when it cannot be sure: nothing, with a log line.
 *
 *   1. per-actor  — one GitHub login may cause at most N calls per hour. A judge trying the bot
 *                   needs a handful. Someone hammering it gets N and then silence.
 *   2. per-tick   — no single tick may exceed N calls, so one enormous pull request or a backlog
 *                   cannot drain the budget in one pass.
 *   3. lifetime   — a hard total for the deployment, so the worst case is a known number of
 *                   pennies rather than an open-ended bill. Reset by deleting the state file.
 *
 * This is deliberately NOT an allowlist. An allowlist would keep judges out, and the whole point
 * of hosting the bot is that a judge can open a pull request and watch it answer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_BUDGET_PATH = ".iou/budget.json";

export const LIMITS = Object.freeze({
  perActorPerHour: Number(process.env.IOU_MAX_CALLS_PER_ACTOR_HOUR || 12),
  perTick: Number(process.env.IOU_MAX_CALLS_PER_TICK || 20),
  lifetime: Number(process.env.IOU_MAX_CALLS_TOTAL || 2000),
});

export function loadBudget(path = DEFAULT_BUDGET_PATH) {
  if (!existsSync(path)) return { total: 0, actors: {} };
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    return { total: Number(b.total) || 0, actors: b.actors && typeof b.actors === "object" ? b.actors : {} };
  } catch {
    // A corrupt budget file must not read as "no spend so far" — that would silently remove the
    // ceiling. Start from the lifetime limit instead, so a damaged file fails closed.
    return { total: LIMITS.lifetime, actors: {} };
  }
}

export function saveBudget(b, path = DEFAULT_BUDGET_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(b, null, 2));
}

/** Drop per-actor records older than an hour so the file cannot grow without bound. */
export function prune(budget, now = Date.now()) {
  for (const [login, times] of Object.entries(budget.actors)) {
    const recent = times.filter((t) => now - t < 3_600_000);
    if (recent.length) budget.actors[login] = recent;
    else delete budget.actors[login];
  }
  return budget;
}

/**
 * A ledger of what this tick is allowed to spend. `check(login)` returns null when a call is
 * permitted, or a human-readable reason when it is not.
 */
export function openBudget(path = DEFAULT_BUDGET_PATH, limits = LIMITS, now = () => Date.now()) {
  const budget = prune(loadBudget(path), now());
  let thisTick = 0;
  const tokens = { input: 0, output: 0 };

  return {
    check(login) {
      if (budget.total >= limits.lifetime) {
        return `lifetime budget spent (${budget.total}/${limits.lifetime} calls) — delete ${path} to reset`;
      }
      if (thisTick >= limits.perTick) {
        return `tick budget spent (${limits.perTick} calls) — remaining work waits for the next tick`;
      }
      const times = budget.actors[login] || [];
      if (times.length >= limits.perActorPerHour) {
        return `@${login} has used ${times.length}/${limits.perActorPerHour} calls this hour`;
      }
      return null;
    },
    /**
     * Record a call that was actually made. Call this AFTER the model call, not before — a call
     * that failed (no credit, a refusal, a network error) must not consume the operator's budget.
     * `usage` is the provider's own token counts when it supplies them, so the reported cost is
     * measured rather than estimated.
     */
    spend(login, usage) {
      thisTick += 1;
      budget.total += 1;
      (budget.actors[login] ||= []).push(now());
      if (usage) {
        tokens.input += usage.input_tokens ?? usage.prompt_tokens ?? 0;
        tokens.output += usage.output_tokens ?? usage.completion_tokens ?? 0;
      }
    },
    get spentThisTick() { return thisTick; },
    get spentTotal() { return budget.total; },
    get remaining() { return Math.max(0, limits.lifetime - budget.total); },
    get tokens() { return { ...tokens }; },
    save() { saveBudget(budget, path); },
  };
}

/**
 * Text that came out of a model, which came from a stranger's comment, and is about to be posted
 * under the bot's own name. Strip anything that could turn the bot into someone else's megaphone:
 * links, images, @-mentions, issue cross-references, HTML, and fenced blocks. Then cap it.
 *
 * Without this, a comment crafted to make the classifier echo it back gives an attacker
 * bot-authored content — which reads as trustworthy precisely because the bot wrote it.
 */
export function sanitise(text, max = 180) {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/<[^>]*>/g, " ");
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");       // markdown links/images → their text
  s = s.replace(/\bhttps?:\/\/\S+/gi, "[link removed]");  // bare URLs
  s = s.replace(/(^|[^\w`])@([A-Za-z0-9-]+)/g, "$1@​$2"); // defuse @-mentions
  s = s.replace(/(^|\s)#(\d+)/g, "$1#​$2");          // defuse issue cross-references
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
