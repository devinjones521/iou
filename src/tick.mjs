/**
 * One tick of the IOU bot. Pure orchestration; every side effect goes through the adapter.
 *
 *   1. new human comments since cursor  → classify → record promise in the ledger
 *   2. open PRs updated since cursor    → touched? → fulfils? → ONE comment, or silence + log
 *   3. bot comments awaiting a reaction → 👍 file an issue · 👎 drop the IOU
 *
 * Restraint is structural: a PR gets at most one resurface comment ever, unrelated PRs are
 * filtered deterministically before any model call, and every "nothing to do" writes a log line.
 */
import { classifyComment } from "./classify.mjs";
import { judgeFulfilment, touchedIous } from "./judge.mjs";
import { ensureLedger, formatEntry, openIous, outstandingIous, reduceLedger } from "./ledger.mjs";
import { loadState, remember, saveState } from "./state.mjs";
import { GitHubError } from "./github.mjs";
import { openBudget, sanitise } from "./budget.mjs";

export const MARK_RESURFACE = "<!-- iou:resurface";

export async function tick(gh, { log = console.log, botLogin = process.env.IOU_BOT_LOGIN || null, statePath, budgetPath, now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const state = loadState(statePath);
  // Every model call in this tick passes through here first. Triggers come from strangers on a
  // public repository, so the ceilings are the difference between a demo and an open bill.
  const budget = openBudget(budgetPath);
  const summary = { recorded: [], resurfaced: [], settled: [], silent: [], filed: [], dropped: [], skipped: [], errors: [] };
  const isBot = (login) => botLogin ? login === botLogin : false;
  // Recognise our own output by its marker as well as by author. IOU_BOT_LOGIN may be unset
  // (no GitHub App), and without this the bot reads its own comments back as human promises.
  const isBotBody = (body) => {
    const b = String(body || "");
    return b.startsWith(MARK_RESURFACE) || b.startsWith(MARK_SETTLE) || /<!--\s*iou[:\s]/.test(b);
  };

  let ledger;
  try {
    ledger = await ensureLedger(gh, log);
  } catch (err) {
    return degrade(err, "ensureLedger", summary, log, state, statePath);
  }

  // ---- 1. wake on new comments ---------------------------------------------------------
  let issueComments = [], reviewComments = [];
  try {
    [issueComments, reviewComments] = await Promise.all([
      gh.listIssueComments({ since: state.cursor }),
      gh.listReviewComments({ since: state.cursor }),
    ]);
  } catch (err) {
    return degrade(err, "listComments", summary, log, state, statePath);
  }
  const fresh = [
    ...issueComments.filter((c) => c.html_url.includes("/pull/")).map((c) => ({ ...c, kind: "issue", prNumber: numberFromUrl(c.html_url) })),
    ...reviewComments.map((c) => ({ ...c, kind: "review", prNumber: numberFromUrl(c.html_url) })),
  ]
    .filter((c) => !state.handledComments.includes(c.id))
    .filter((c) => !isBot(c.user?.login) && !isBotBody(c.body))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (fresh.length === 0) log(`wake: no new comments since ${state.cursor}`);
  for (const c of fresh) {
    log(`wake: comment ${c.id} on PR #${c.prNumber} by @${c.user.login} (${c.kind})`);
    const denied = budget.check(c.user.login);
    if (denied) {
      // Deliberately NOT marked handled: the comment is skipped for now, not judged and dismissed.
      // When the hour rolls over or the operator raises the ceiling, it gets its fair look.
      log(`  SKIPPED without spending: ${denied}`);
      summary.skipped.push({ comment: c.id, actor: c.user.login, reason: denied });
      continue;
    }
    remember(state.handledComments, c.id);
    try {
      const { verdict, ms, usage } = await classifyComment({ body: c.body, author: c.user.login, path: c.path || null });
      budget.spend(c.user.login, usage);
      if (!verdict) { log(`  not a promise (${ms} ms)`); continue; }
      const record = {
        id: `c${c.id}`, status: "open", who: c.user.login, what: sanitise(verdict.what),
        paths: verdict.paths, symbols: verdict.symbols, confidence: verdict.confidence,
        source: c.html_url, pr: c.prNumber, recorded_at: startedAt,
      };
      const posted = await gh.createComment(ledger.number, formatEntry(record));
      log(`  promise recorded: "${record.what}" → ${posted.html_url} (${ms} ms)`);
      summary.recorded.push({ id: record.id, what: record.what, ledger_comment: posted.html_url, source: c.html_url });
    } catch (err) {
      summary.errors.push({ stage: "classify", comment: c.id, error: err.message });
      log(`  ERROR classifying ${c.id}: ${err.message} — leaving it unrecorded (fail closed)`);
    }
  }

  // ---- 2. resurface on PRs ---------------------------------------------------------------
  let ious = [], stillOwed = [];
  try {
    const all = await gh.listIssueComments({ since: "2000-01-01T00:00:00Z" });
    const ledgerState = reduceLedger(all.filter((c) => c.issue_url.endsWith(`/issues/${ledger.number}`)));
    ious = openIous(ledgerState);        // candidates to resurface
    stillOwed = outstandingIous(ledgerState); // candidates to settle (open OR already filed)
  } catch (err) {
    return degrade(err, "readLedger", summary, log, state, statePath);
  }
  let pulls = [];
  try {
    pulls = (await gh.listPulls({ state: "open" })).filter((p) => p.updated_at >= state.cursor || p.created_at >= state.cursor);
  } catch (err) {
    return degrade(err, "listPulls", summary, log, state, statePath);
  }
  for (const pr of pulls) {
    const already = state.commentedPRs[pr.number] || [];
    if (already.length) { log(`PR #${pr.number}: already commented here — silent`); continue; }
    const candidates = stillOwed.filter((i) => i.pr !== pr.number);
    if (candidates.length === 0) { log(`PR #${pr.number}: no outstanding IOUs — silent`); summary.silent.push({ pr: pr.number, reason: "no outstanding IOUs" }); continue; }
    let files;
    try { files = await gh.listPullFiles(pr.number); } catch (err) { summary.errors.push({ stage: "files", pr: pr.number, error: err.message }); log(`PR #${pr.number}: ERROR listing files: ${err.message}`); continue; }
    const touched = touchedIous(candidates, files);
    if (touched.length === 0) {
      log(`PR #${pr.number}: touches none of ${candidates.length} outstanding IOU(s) — silent`);
      summary.silent.push({ pr: pr.number, reason: `touches none of ${candidates.length} outstanding IOUs` });
      continue;
    }
    const unkept = [];
    const kept = [];
    for (const iou of touched) {
      const denied = budget.check(pr.user?.login || "unknown");
      if (denied) { log(`PR #${pr.number}: SKIPPED without spending: ${denied}`); summary.skipped.push({ pr: pr.number, reason: denied }); continue; }
      try {
        const { verdict, ms, usage } = await judgeFulfilment(iou, files);
        budget.spend(pr.user?.login || "unknown", usage);
        if (!verdict) { log(`PR #${pr.number}: cannot tell whether "${iou.what}" is kept — silent (${ms} ms)`); continue; }
        if (verdict.fulfils) {
          log(`PR #${pr.number}: KEEPS "${iou.what}" — ${verdict.reason} (${ms} ms)`);
          kept.push({ iou, reason: verdict.reason });
          continue;
        }
        unkept.push({ iou, reason: verdict.reason });
      } catch (err) {
        summary.errors.push({ stage: "judge", pr: pr.number, iou: iou.id, error: err.message });
        log(`PR #${pr.number}: ERROR judging ${iou.id}: ${err.message} — silent`);
      }
    }

    // The settle beat. A bot that only ever nags is a bot people mute; closing the loop is what
    // makes the ledger trustworthy. Still exactly one comment per PR, and the ledger entry closes
    // so the promise can never be raised again.
    if (kept.length) {
      try {
        const posted = await gh.createComment(pr.number, settleBody(kept));
        for (const { iou, reason } of kept) {
          await gh.createComment(ledger.number, formatEntry({ ...iou, status: "settled", settled_by: `PR #${pr.number}`, reason }));
          // If a tracking issue was filed for this promise, say so there too — but do NOT close
          // it. Closing is a judgement about someone else's work; the bot reports, the human
          // closes. It also keeps the adapter at eight operations. See DECISIONS.md.
          if (iou.issue_url) {
            const n = Number(iou.issue_url.split("/").pop());
            if (Number.isInteger(n)) {
              await gh.createComment(n, `Kept by ${posted.html_url} — the diff does the work this issue was filed for. Closing it is your call.`);
              log(`  told tracking issue #${n} that the promise was kept`);
            }
          }
        }
        state.commentedPRs[pr.number] = kept.map((k) => k.iou.id);
        log(`PR #${pr.number}: settled ${kept.length} IOU(s) → ${posted.html_url}`);
        summary.settled.push({ pr: pr.number, comment: posted.html_url, ious: kept.map((k) => k.iou.id) });
        continue; // one comment per PR: never nag and settle in the same breath
      } catch (err) {
        summary.errors.push({ stage: "settle", pr: pr.number, error: err.message });
        log(`PR #${pr.number}: ERROR settling: ${err.message}`);
      }
    }

    // Only nag about promises with no tracking issue yet. Once one is filed, saying it again on
    // every future PR is exactly the behaviour that gets a bot muted.
    const toNag = unkept.filter(({ iou }) => iou.status === "open");
    if (unkept.length && !toNag.length) {
      log(`PR #${pr.number}: ${unkept.length} touched IOU(s) already filed — silent`);
      summary.silent.push({ pr: pr.number, reason: "touched IOUs are already filed" });
      continue;
    }
    if (toNag.length === 0) { summary.silent.push({ pr: pr.number, reason: "touched IOUs are kept or undecidable" }); continue; }
    const unkeptList = toNag;
    const body = resurfaceBody(unkeptList, pr);
    try {
      const posted = await gh.createComment(pr.number, body);
      state.commentedPRs[pr.number] = unkeptList.map((u) => u.iou.id);
      state.pending.push({ commentId: posted.id, prNumber: pr.number, iouIds: unkeptList.map((u) => u.iou.id) });
      log(`PR #${pr.number}: resurfaced ${unkeptList.length} IOU(s) → ${posted.html_url}`);
      summary.resurfaced.push({ pr: pr.number, comment: posted.html_url, ious: unkeptList.map((u) => u.iou.id) });
    } catch (err) {
      summary.errors.push({ stage: "comment", pr: pr.number, error: err.message });
      log(`PR #${pr.number}: ERROR posting comment: ${err.message}`);
    }
  }

  // ---- 3. reactions = the human's decision -------------------------------------------------
  for (const p of [...state.pending]) {
    let reactions;
    try { reactions = await gh.listReactions(p.commentId); } catch (err) { summary.errors.push({ stage: "reactions", comment: p.commentId, error: err.message }); continue; }
    const human = reactions.filter((r) => !isBot(r.user?.login));
    const up = human.find((r) => r.content === "+1");
    const down = human.find((r) => r.content === "-1");
    if (!up && !down) continue;
    const decided = up ? "+1" : "-1";
    const by = (up || down).user.login;
    for (const id of p.iouIds) {
      const iou = ious.find((i) => i.id === id);
      if (!iou) continue;
      try {
        if (decided === "+1") {
          const issue = await gh.createIssue({
            title: `IOU: ${sanitise(iou.what, 120)}`,
            labels: ["iou"],
            assignees: [iou.who],
            body: [
              `@${iou.who} promised this in ${iou.source} and PR #${p.prNumber} touched the same code without doing it.`,
              "",
              `Filed by the IOU bot after @${by} reacted 👍 on the reminder.`,
            ].join("\n"),
          });
          await gh.createComment(ledger.number, formatEntry({ ...iou, status: "filed", issue_url: issue.html_url, by }));
          log(`👍 by @${by}: filed ${issue.html_url} for "${iou.what}"`);
          summary.filed.push({ iou: iou.id, issue: issue.html_url, by });
        } else {
          await gh.createComment(ledger.number, formatEntry({ ...iou, status: "dropped", by }));
          log(`👎 by @${by}: dropped "${iou.what}"`);
          summary.dropped.push({ iou: iou.id, by });
        }
      } catch (err) {
        summary.errors.push({ stage: "decide", iou: id, error: err.message });
        log(`ERROR acting on reaction for ${id}: ${err.message}`);
      }
    }
    state.pending = state.pending.filter((x) => x.commentId !== p.commentId);
    remember(state.decided, p.commentId);
  }

  state.cursor = startedAt;
  saveState(state, statePath);
  budget.save();
  if (budget.spentThisTick) log(`tick spent ${budget.spentThisTick} model call(s); ${budget.remaining} left of the lifetime budget`);
  summary.budget = { spentThisTick: budget.spentThisTick, spentTotal: budget.spentTotal, remaining: budget.remaining, tokens: budget.tokens };
  return summary;
}

function degrade(err, stage, summary, log, state, statePath) {
  const status = err instanceof GitHubError ? err.status : "?";
  summary.errors.push({ stage, error: err.message, status });
  log(`DEGRADED at ${stage}: ${err.message} — cursor NOT advanced, will retry next tick`);
  saveState(state, statePath);
  return summary;
}

/**
 * The judge's reason is model output derived from a stranger's diff and is about to be posted
 * under the bot's name, so it is sanitised like any other untrusted text. It also arrives
 * capitalised and end-stopped, and gets spliced mid-sentence — this text is on camera.
 */
function tidyReason(reason) {
  const r = sanitise(reason, 240).replace(/\s*\.\s*$/, "");
  if (!r) return "";
  return r[0].toLowerCase() + r.slice(1);
}

export function resurfaceBody(unkept, pr) {
  const lines = unkept.map(({ iou, reason }) => {
    const why = tidyReason(reason);
    return `- **@${iou.who} promised:** ${sanitise(iou.what)} ([where](${iou.source}), PR #${iou.pr}).\n  This PR touches that code but doesn't do it${why ? ` — ${why}` : ""}.`;
  });
  return [
    `${MARK_RESURFACE} ${JSON.stringify({ pr: pr.number, ious: unkept.map((u) => u.iou.id) })} -->`,
    `**IOU** — ${unkept.length === 1 ? "an open promise touches this PR" : `${unkept.length} open promises touch this PR`}:`,
    "",
    ...lines,
    "",
    "React 👍 to file a tracking issue, 👎 to drop the IOU. I won't file anything without you.",
  ].join("\n");
}

export const MARK_SETTLE = "<!-- iou:settle";

export function settleBody(kept) {
  const lines = kept.map(({ iou, reason }) => {
    const why = tidyReason(reason);
    return `- **@${iou.who} promised:** ${sanitise(iou.what)} ([where](${iou.source}), PR #${iou.pr}).\n  This PR does it${why ? ` — ${why}` : ""}. Closed.`;
  });
  return [
    `${MARK_SETTLE} ${JSON.stringify({ ious: kept.map((k) => k.iou.id) })} -->`,
    `**IOU settled** — ${kept.length === 1 ? "this PR keeps a promise made earlier" : `this PR keeps ${kept.length} promises made earlier`}:`,
    "",
    ...lines,
    "",
    "Nothing for you to do. The ledger is updated.",
  ].join("\n");
}

const numberFromUrl = (url) => Number((String(url).match(/\/(?:pull|issues)\/(\d+)/) || [])[1]);
