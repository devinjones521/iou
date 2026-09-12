export function repoFromEnv(env = process.env) {
  const full = env.IOU_REPO || "devinjones521/iou-playground";
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`IOU_REPO must be owner/repo, got "${full}"`);
  return { owner, repo };
}

export const stamp = () => new Date().toISOString().slice(11, 19);
