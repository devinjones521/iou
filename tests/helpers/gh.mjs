/**
 * TEST-ONLY GitHub helpers: the things a HUMAN does in the demo (open PRs, write comments,
 * react) plus cleanup. These are not bot operations and do not count toward the adapter cap.
 */
import { API } from "../../src/github.mjs";

export function human({ owner, repo, token }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "iou-tests" };
  const R = `${API}/repos/${owner}/${repo}`;
  async function call(method, url, body) {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`test helper ${method} ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }
  return {
    async createBranch(name, from = "main") {
      const ref = await call("GET", `${R}/git/ref/heads/${from}`);
      return call("POST", `${R}/git/refs`, { ref: `refs/heads/${name}`, sha: ref.object.sha });
    },
    async putFile(branch, path, content, message) {
      let sha;
      try { sha = (await call("GET", `${R}/contents/${path}?ref=${branch}`)).sha; } catch { sha = undefined; }
      return call("PUT", `${R}/contents/${path}`, { message, content: Buffer.from(content).toString("base64"), branch, sha });
    },
    getFile: (path, ref = "main") => call("GET", `${R}/contents/${path}?ref=${ref}`).then((f) => Buffer.from(f.content, "base64").toString("utf8")),
    openPull: (head, title, body = "") => call("POST", `${R}/pulls`, { head, base: "main", title, body }),
    comment: (number, body) => call("POST", `${R}/issues/${number}/comments`, { body }),
    react: (commentId, content) => call("POST", `${R}/issues/comments/${commentId}/reactions`, { content }),
    commentsOn: (number) => call("GET", `${R}/issues/${number}/comments?per_page=100`),
    issues: (labels, state = "open") => call("GET", `${R}/issues?labels=${labels}&state=${state}&per_page=100`),
    // Fetch by number, never by listing. GitHub's issue LIST endpoint is eventually consistent:
    // an issue created a second earlier is reliably readable at /issues/{n} while still absent
    // from /issues?labels=... That lag failed item 8 once on a run where the bot had done
    // everything right, which is the worst kind of red.
    getIssue: (number) => call("GET", `${R}/issues/${number}`),
    reopenIssue: (number) => call("PATCH", `${R}/issues/${number}`, { state: "open" }),
    closePull: (number) => call("PATCH", `${R}/pulls/${number}`, { state: "closed" }),
    closeIssue: (number) => call("PATCH", `${R}/issues/${number}`, { state: "closed" }),
    deleteBranch: (name) => call("DELETE", `${R}/git/refs/heads/${name}`).catch(() => null),
    me: () => call("GET", `${API}/user`),
  };
}
