#!/usr/bin/env node
/** Long-running loop: one tick every IOU_INTERVAL_S seconds (default 15). Ctrl-C to stop. */
import { github, resolveAuth } from "./github.mjs";
import { tick } from "./tick.mjs";
import { repoFromEnv, stamp } from "./util.mjs";

const { owner, repo } = repoFromEnv();
const interval = Number(process.env.IOU_INTERVAL_S || 15) * 1000;
const log = (m) => console.log(`${stamp()} ${m}`);

const auth = await resolveAuth();
const gh = github({ owner, repo, token: auth.token, log });
log(`iou watching ${owner}/${repo} as ${auth.kind} credential, every ${interval / 1000}s`);

for (;;) {
  try {
    await tick(gh, { log });
  } catch (err) {
    log(`tick crashed (should not happen — tick degrades internally): ${err.stack}`);
  }
  await new Promise((r) => setTimeout(r, interval));
}
