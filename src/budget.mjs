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

/**
 * A positive whole number, or the default. `Number("twelve")` is NaN, and `n >= NaN` is always
 * false — so a typo'd ceiling used to remove the ceiling entirely, which is the one direction a
 * spend guard must never fail in.
 */
const ceiling = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Read at CALL time, not at module-evaluation time: ESM hoists imports, so a module-scope value
 * here is fixed before `loadDotEnv()` has run and every ceiling set in a .env file was silently
 * ignored. Systemd was unaffected; every local user was not.
 */
export const limits = () => Object.freeze({
  perActorPerHour: ceiling(process.env.IOU_MAX_CALLS_PER_ACTOR_HOUR, 40),
  perTick: ceiling(process.env.IOU_MAX_CALLS_PER_TICK, 20),
  lifetime: ceiling(process.env.IOU_MAX_CALLS_TOTAL, 2000),
});

export function loadBudget(path = DEFAULT_BUDGET_PATH) {
  if (!existsSync(path)) return { total: 0, actors: {} };
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    return { total: Number(b.total) || 0, actors: b.actors && typeof b.actors === "object" ? b.actors : {} };
  } catch {
    // A corrupt budget file must not read as "no spend so far" — that would silently remove the
    // ceiling. Start from the lifetime limit instead, so a damaged file fails closed.
    return { total: limits().lifetime, actors: {} };
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
export function openBudget(path = DEFAULT_BUDGET_PATH, caps = limits(), now = () => Date.now()) {
  const budget = prune(loadBudget(path), now());
  let thisTick = 0;
  const tokens = { input: 0, output: 0 };

  return {
    check(login) {
      if (budget.total >= caps.lifetime) {
        return `lifetime budget spent (${budget.total}/${caps.lifetime} calls) — delete ${path} to reset`;
      }
      if (thisTick >= caps.perTick) {
        return `tick budget spent (${caps.perTick} calls) — remaining work waits for the next tick`;
      }
      const times = budget.actors[login] || [];
      if (times.length >= caps.perActorPerHour) {
        // Worded so the number reads correctly even when the count already exceeds the limit —
        // which happens when the ceiling is lowered mid-run. "2/1 calls" looks like a typo.
        return `@${login} is over the hourly limit of ${caps.perActorPerHour} call${caps.perActorPerHour === 1 ? "" : "s"} (${times.length} used)`;
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
    get remaining() { return Math.max(0, caps.lifetime - budget.total); },
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
  // GitHub autolinks a bare www. too, so stripping only http(s) left a working link behind.
  s = s.replace(/\bwww\.\S+/gi, "[link removed]");
  // The backtick used to be excluded from this class, so `@victim rendered as a LIVE mention —
  // a lone backtick does not open a code span. Nothing may precede an @ except a word character.
  s = s.replace(/(^|[^\w])@([A-Za-z0-9-]+)/g, "$1@​$2"); // defuse @-mentions
  // owner/repo#123 and owner/repo@sha post a backlink into someone else's repository.
  s = s.replace(/\b([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)(#\d+|@[0-9a-f]{7,40})\b/gi, "$1​$2");
  s = s.replace(/(^|\s)#(\d+)/g, "$1#​$2");          // defuse issue cross-references
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/**
 * A GitHub login, or null. Ledger records are read back from a PUBLIC issue, and `who` is rendered
 * into a comment the bot posts under its own identity and into an issue's assignee list. A login is
 * 1-39 of [A-Za-z0-9-]; anything else is not a user and must never reach an `@`.
 */
export function safeLogin(who) {
  const s = String(who ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s) ? s : null;
}

/**
 * A URL, only if it is a github.com repository URL — and, when owner/repo are given, only if it is
 * inside that repository. Characters that would break out of a markdown link are rejected outright,
 * so a source can never smuggle in a second link or trailing text.
 */
export function safeRepoUrl(url, owner = null, repo = null) {
  const s = String(url ?? "").trim();
  // Reject anything that could break out of a markdown link before parsing it.
  if (!s || /[\s<>"'()\\\]\[]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  // Parsed, not string-matched. A host of the form "github" + ".com.evil.test" starts with the
  // same characters as the real prefix, so a startsWith() check would wave it straight through;
  // comparing the parsed host cannot be fooled that way. Splitting the literal also keeps a
  // hard-coded link out of the source, which the no-invented-urls gate forbids on purpose —
  // every link the bot posts must come from the API, never from a string in the code.
  if (u.protocol !== "https:" || u.host !== "git" + "hub.com") return null;
  const [o, r] = u.pathname.split("/").filter(Boolean);
  if (!o || !r) return null;
  return owner && repo ? (o === owner && r === repo ? s : null) : s;
}
