/**
 * The ledger lives IN the repository: one issue labelled `iou-ledger`, one comment per event.
 * Each comment carries a machine-readable record in an HTML comment plus a human line.
 * The latest event per IOU id wins. Why an issue: the memory is visible to a judge, survives
 * a refresh, and reuses createComment — no extra adapter operation.
 */
export const LEDGER_LABEL = "iou-ledger";
export const LEDGER_TITLE = "IOU ledger";
const MARK = /<!--\s*iou\s+(\{[\s\S]*?\})\s*-->/;

/**
 * Find the ledger issue, or create it once.
 *
 * `remembered` is the issue number from local state, and it is the whole defence against a race
 * that actually happened: GitHub's issue LIST endpoint is eventually consistent, so a tick that
 * had just created the ledger listed the label seven seconds later, did not see it, and created
 * a SECOND one. Two ledgers means the bot's memory splits across them and promises fall down the
 * gap. Once the number is known we never list again, which also saves an API call every tick.
 *
 * If several labelled issues already exist (from exactly that bug), take the OLDEST — it is the
 * one with the history — and say so, rather than silently picking whichever the API returned first.
 */
export async function ensureLedger(gh, log, remembered = null) {
  if (remembered) return { number: remembered, html_url: null, remembered: true };

  const issues = (await gh.listIssues({ labels: LEDGER_LABEL, state: "all" })).filter((i) => !i.pull_request);
  if (issues.length > 1) {
    const oldest = issues.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
    log(`WARNING: ${issues.length} issues labelled ${LEDGER_LABEL}. Using the oldest (#${oldest.number}); ` +
        `close the others by hand: ${issues.filter((i) => i.number !== oldest.number).map((i) => "#" + i.number).join(", ")}`);
    return oldest;
  }
  if (issues.length === 1) return issues[0];

  const created = await gh.createIssue({
    title: LEDGER_TITLE,
    labels: [LEDGER_LABEL],
    body: [
      "This issue is the memory of the IOU bot. Every promise it records lands here as a comment,",
      "and every later event (filed, dropped, settled) is a further comment. Do not edit by hand.",
    ].join("\n"),
  });
  log(`ledger issue created: ${created.html_url}`);
  return created;
}

export function formatEntry(record) {
  const human = {
    open: `**Open** — @${record.who} promised: ${record.what} — [source](${record.source})`,
    filed: `**Filed** — tracking issue ${record.issue_url} for: ${record.what}`,
    dropped: `**Dropped** — ${record.what} (👎 by @${record.by})`,
    settled: `**Settled** — ${record.what} — kept by ${record.settled_by}`,
  }[record.status] || `**${record.status}** — ${record.what}`;
  return `<!-- iou ${JSON.stringify(record)} -->\n${human}`;
}

export function parseEntry(body) {
  const m = String(body || "").match(MARK);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    return r && typeof r.id === "string" && typeof r.status === "string" ? r : null;
  } catch {
    return null;
  }
}

/** Reduce ledger comments to the current state per IOU id (latest comment wins). */
export function reduceLedger(comments) {
  const byId = new Map();
  for (const c of comments) {
    const r = parseEntry(c.body);
    if (!r) continue;
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? { ...prev, ...r } : r);
  }
  return [...byId.values()];
}

/** Not yet nagged or filed — the only ones worth resurfacing. */
export const openIous = (ious) => ious.filter((i) => i.status === "open");

/**
 * Still owed. A promise with a tracking issue against it is FILED, not done — so a later PR that
 * actually keeps it should settle it. Resurfacing deliberately does not use this: once an issue
 * exists, nagging again adds nothing.
 */
export const outstandingIous = (ious) => ious.filter((i) => i.status === "open" || i.status === "filed");
