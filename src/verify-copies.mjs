import { existsSync, copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { jobDir, readJobFile, writeJobFile } from "./store.mjs";
import { worktreeOfBranch } from "./git.mjs";

/**
 * worktrees.copyForVerify: untracked files (an .env, say) a card's services need, copied into its worktree by
 * `services up` and removed again by `services down`, `job stop` and `worktree remove`. Unlike copyFromBase they
 * are never in the worktree while an agent works there (planning, building, fixing): the verify stage is the
 * session's own. Only the files this copy put there are recorded and removed; a path already in the worktree is
 * left alone (it may be tracked, or the person's own).
 */
const RECORD = "verify/copies.json";

/** Where the copies come from, in order: the checkout of the card's base branch, then the main checkout. */
function sourceDirs(c, job) {
  const dirs = [];
  if (job.base?.branch && c.repoRoot) {
    try { const d = worktreeOfBranch(c.repoRoot, job.base.branch); if (d) dirs.push(d); } catch { /* git unreadable: the main checkout */ }
  }
  if (c.repoRoot && !dirs.includes(c.repoRoot)) dirs.push(c.repoRoot);
  return dirs;
}
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function readRecord(c, job) {
  const text = readJobFile(c, job.id, RECORD);
  if (text === null) return [];
  try { const r = JSON.parse(text); if (Array.isArray(r?.copied)) return r.copied.filter((x) => typeof x === "string"); } catch { /* fall through */ }
  return [];
}
function writeRecord(c, job, copied) {
  if (copied.length) writeJobFile(c, job.id, RECORD, JSON.stringify({ copied }, null, 2) + "\n");
  else rmSync(join(jobDir(c, job.id), RECORD), { force: true });
}

/** Copies every copyForVerify entry that is not yet in the worktree. Returns { copied, missing } (relative paths). */
export function copyForVerify(c, job, { log = () => {} } = {}) {
  const list = c.worktrees?.copyForVerify ?? [];
  const out = { copied: [], missing: [] };
  if (!list.length || !job.worktree) return out;
  const from = sourceDirs(c, job);
  const copied = readRecord(c, job);
  for (const rel of list) {
    const src = from.map((d) => join(d, rel)).find(isFile);
    const dst = join(job.worktree, rel);
    if (!src) { out.missing.push(rel); log(`copyForVerify: ${rel} not found in ${from.join(" or ") || "(no source checkout)"}`); continue; }
    if (existsSync(dst)) continue; // already there: ours from an earlier up (recorded), or not ours to touch
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    if (!copied.includes(rel)) copied.push(rel);
    // Recorded as each lands, so a failure midway still leaves every copy findable for removal.
    writeRecord(c, job, copied);
    out.copied.push(rel);
  }
  return out;
}

/** Removes the copies `copyForVerify` recorded for this card. Returns { removed, left } (relative paths); a path that could not be removed stays recorded. */
export function removeVerifyCopies(c, job) {
  const copied = readRecord(c, job);
  const out = { removed: [], left: [] };
  if (!copied.length) return out;
  for (const rel of copied) {
    if (!job.worktree) { out.left.push(rel); continue; }
    try { rmSync(join(job.worktree, rel), { force: true }); out.removed.push(rel); } catch { out.left.push(rel); }
  }
  writeRecord(c, job, out.left);
  return out;
}
