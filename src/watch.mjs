#!/usr/bin/env node
/** Long-running loop: one tick every IOU_INTERVAL_S seconds (default 15). Ctrl-C to stop. */
import { github, resolveAuth } from "./github.mjs";
import { tick } from "./tick.mjs";
import { loadDotEnv, repoFromEnv, stamp } from "./util.mjs";
import { backend, modelId } from "./llm.mjs";

loadDotEnv(); // FIRST: which key is present decides the model backend

const { owner, repo } = repoFromEnv();
const interval = Number(process.env.IOU_INTERVAL_S || 15) * 1000;
const log = (m) => console.log(`${stamp()} ${m}`);

const auth = await resolveAuth();
const gh = github({ owner, repo, token: auth.token, log });
log(`iou watching ${owner}/${repo}`);
log(`  github: ${auth.kind} credential${process.env.IOU_BOT_LOGIN ? ` as ${process.env.IOU_BOT_LOGIN}` : ""}`);
log(`  model:  ${backend()} (${modelId()})`);
log(`  poll:   every ${interval / 1000}s`);

for (;;) {
  try {
    await tick(gh, { log });
  } catch (err) {
    log(`tick crashed (should not happen — tick degrades internally): ${err.stack}`);
  }
  await new Promise((r) => setTimeout(r, interval));
}
