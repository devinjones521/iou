/**
 * Local bookkeeping only — NOT the ledger. Cursor and handled ids stop double-handling
 * (item 3); everything a judge can see lives in GitHub.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_STATE_PATH = ".iou/state.json";

export function loadState(path = DEFAULT_STATE_PATH) {
  if (!existsSync(path)) return fresh();
  try {
    return { ...fresh(), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return fresh();
  }
}

export function saveState(state, path = DEFAULT_STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function fresh() {
  return {
    cursor: new Date(Date.now() - 60_000).toISOString(), // first run: only the last minute
    handledComments: [],   // comment ids already classified
    commentedPRs: {},      // prNumber -> [iou ids] already resurfaced there
    pending: [],           // { commentId, prNumber, iouIds } awaiting a reaction
    decided: [],           // reaction-handled comment ids
  };
}

export function remember(list, id, cap = 2000) {
  if (!list.includes(id)) list.push(id);
  if (list.length > cap) list.splice(0, list.length - cap);
}
