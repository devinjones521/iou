import { existsSync, readFileSync } from "node:fs";

/**
 * Load .env into process.env. Real environment variables always win, so a systemd EnvironmentFile
 * or a CI secret is never overridden by a stray local file.
 *
 * Call this FIRST at every entry point. It used to happen only as a side effect of resolving the
 * GitHub credential, which meant ANTHROPIC_API_KEY was loaded by accident and only if the GitHub
 * auth path happened to run first. That is the kind of ordering coupling that works until the day
 * someone reorders two imports and the bot silently falls back to a different model backend.
 */
export function loadDotEnv(file = ".env", env = process.env) {
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

export function repoFromEnv(env = process.env) {
  // No default. This used to fall back to the author's own playground, which meant anyone who
  // cloned the repo, followed the README and left IOU_REPO blank pointed a bot at someone else's
  // repository under their own GitHub token — silently, and with no error to tell them.
  const full = (env.IOU_REPO || "").trim();
  const [owner, repo] = full.split("/");
  if (!owner || !repo) {
    throw new Error(`IOU_REPO must be set to owner/repo — got ${full ? `"${full}"` : "nothing"}. ` +
      `Set it in .env to the repository you want the bot to watch.`);
  }
  return { owner, repo };
}

export const stamp = () => new Date().toISOString().slice(11, 19);
