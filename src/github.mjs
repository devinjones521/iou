/**
 * The narrow GitHub adapter. These are the ONLY operations the bot may perform.
 *
 * Why a hand-written adapter with a cap: a large tool surface wrecks tool selection and hides
 * what the bot can actually do. Eight operations cover the whole demo path. The cap is enforced
 * by tests/adapter.test.mjs — a rule that is not executed is not a rule.
 *
 * Test-only helpers (creating branches, commits, PRs, human comments and reactions) live in
 * tests/helpers/ and are NOT bot operations.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";

export const OPERATIONS = Object.freeze([
  "listIssues",          // GET  /repos/{o}/{r}/issues?labels=&state=
  "listPulls",           // GET  /repos/{o}/{r}/pulls?state=open&sort=updated
  "listPullFiles",       // GET  /repos/{o}/{r}/pulls/{n}/files
  "listIssueComments",   // GET  /repos/{o}/{r}/issues/comments?since=   (PR conversation + ledger)
  "listReviewComments",  // GET  /repos/{o}/{r}/pulls/comments?since=    (inline review comments)
  "createComment",       // POST /repos/{o}/{r}/issues/{n}/comments
  "listReactions",       // GET  /repos/{o}/{r}/issues/comments/{id}/reactions
  "createIssue",         // POST /repos/{o}/{r}/issues
]);

export const API = "https://api.github.com";
const RETRYABLE = new Set([500, 502, 503, 504, 429]);

/** Token precedence: explicit → env → GitHub App (.env) → `gh auth token`. Never logged. */
export async function resolveAuth(env = process.env) {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, kind: "token" };
  loadDotEnv(env);
  if (env.IOU_APP_ID && env.IOU_INSTALLATION_ID && env.IOU_APP_PEM && existsSync(env.IOU_APP_PEM)) {
    const token = await installationToken(env.IOU_APP_ID, env.IOU_INSTALLATION_ID, readFileSync(env.IOU_APP_PEM, "utf8"));
    return { token, kind: "app" };
  }
  const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  if (!out) throw new Error("no GitHub credential: set GITHUB_TOKEN, an IOU_APP_* .env, or `gh auth login`");
  return { token: out, kind: "gh" };
}

function loadDotEnv(env) {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** Mint a short-lived installation token from a GitHub App private key (RS256 JWT). */
async function installationToken(appId, installationId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url");
  const jwt = `${unsigned}.${sig}`;
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`installation token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

/**
 * Build the adapter. `base` is overridable ONLY so the retry test can point it at a local
 * server that fails on demand — GitHub cannot be made to return a 500 when asked.
 */
export function github({ owner, repo, token, base = API, log = () => {}, retries = 3, backoffMs = 400 }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "iou-bot",
  };
  const R = `${base}/repos/${owner}/${repo}`;

  async function call(method, url, body) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (err) {
        if (attempt++ >= retries) throw new GitHubError(`network: ${err.message}`, 0, { method, url });
        log(`retry ${attempt}/${retries} after network error: ${err.message}`);
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      const text = await res.text();
      if (RETRYABLE.has(res.status) && attempt++ < retries) {
        log(`retry ${attempt}/${retries} after HTTP ${res.status} on ${method} ${url}`);
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      throw new GitHubError(`HTTP ${res.status} on ${method} ${url}: ${text.slice(0, 300)}`, res.status, { method, url });
    }
  }
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();

  const client = {
    listIssues: ({ labels, state = "all", per_page = 100 } = {}) => call("GET", `${R}/issues?${q({ labels, state, per_page })}`),
    listPulls: ({ state = "open", per_page = 50 } = {}) => call("GET", `${R}/pulls?${q({ state, sort: "updated", direction: "desc", per_page })}`),
    listPullFiles: (number) => call("GET", `${R}/pulls/${number}/files?per_page=100`),
    listIssueComments: ({ since, per_page = 100 } = {}) => call("GET", `${R}/issues/comments?${q({ since, sort: "created", direction: "asc", per_page })}`),
    listReviewComments: ({ since, per_page = 100 } = {}) => call("GET", `${R}/pulls/comments?${q({ since, sort: "created", direction: "asc", per_page })}`),
    createComment: (number, body) => call("POST", `${R}/issues/${number}/comments`, { body }),
    listReactions: (commentId) => call("GET", `${R}/issues/comments/${commentId}/reactions?per_page=100`),
    createIssue: ({ title, body, labels, assignees }) => call("POST", `${R}/issues`, { title, body, labels, assignees }),
  };
  return Object.freeze(client);
}

export class GitHubError extends Error {
  constructor(message, status, meta) { super(message); this.status = status; this.meta = meta; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
