import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
// writeJob is called here with fields produced by cut/remove, not by job.mjs. This is the one
// sanctioned exception to "only job.mjs writes": cut and remove change no stage and append no
// history, and the branch/base/worktree/slug/lockToken fields belong to them. The job is re-read
// after the git work and only those fields are patched, so a stage change made meanwhile survives.
import { readJob, writeJob, withJobLock, listJobs } from "../store.mjs";
import { resolveRecord } from "../record.mjs";
import { cut, remove, resolveBase } from "../worktree.mjs";
import { fail } from "../errors.mjs";
import { git, branchExists, isClean } from "../git.mjs";
import { release, assertHolder, status, withLock } from "../lock.mjs";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CUT_FIELDS = ["branch", "base", "worktree", "slug", "lockToken", "record"];

/** A partner is active while it has a worktree and is not pushed, merged or stopped. */
const ACTIVE_EXCLUDED = ["pushed", "merged", "stopped"];

/**
 * The base a parallel card is cut from: its partner's recorded base (same branch, same head), so the two cards
 * start side by side. Only for a card whose parallel proposal was approved, with a partner that is still active.
 */
export function partnerBase(c, id, partnerId) {
  if (typeof partnerId !== "string" || !partnerId || partnerId === id) fail("BAD_ARGS", "--base-of needs another card's id");
  const job = readJob(c, id);
  if (job.parallel !== "approved") fail("NOT_PARALLEL", `${id} is not an approved parallel card (parallel: ${job.parallel ?? "none"}); answer its proposal first`);
  const p = readJob(c, partnerId);
  if (!p.worktree || !p.base?.head || ACTIVE_EXCLUDED.includes(p.stage)) fail("PARTNER_NOT_ACTIVE", `${partnerId} is ${p.stage}${p.worktree ? "" : " with no worktree"}; a parallel card is cut beside an active partner only`);
  return { branch: p.base.branch, ref: p.base.head, head: p.base.head };
}

/** Cut a job's worktree and record it. `afterAdd` is the TEST-ONLY hook passed through to cut(). */
export function cutJob(c, id, { slug, afterAdd, fetch = true, baseOf, warn = (m) => process.stderr.write(m) } = {}) {
  const base = baseOf === undefined ? null : partnerBase(c, id, baseOf);
  const made = cut(c, readJob(c, id), { slug, afterAdd, fetch, base });
  // Only the re-read, patch and write hold the job lock; the cut above (its fetch included) can take minutes.
  // Any failure after the cut undoes it (worktree, branch, durable lock) and rethrows, so nothing is orphaned.
  // Order: worktree, then branch, then the durable lock last, so a crash midway leaves the lock held (the
  // name stays reserved) rather than a free name with a branch still on it. Anything not removed is named.
  const undo = () => {
    const left = [];
    try { if (existsSync(made.worktree)) git(["worktree", "remove", "--force", made.worktree], { cwd: c.repoRoot }); } catch { left.push(`worktree ${made.worktree}`); }
    // Unconditional here (unlike cut()'s own rollback): this undo runs only after cut() returned, so the worktree
    // was added. Before branch -D, a registered worktree whose folder is gone still holds the branch, and only a
    // prune frees it. `git worktree prune` is repo-wide: it drops every entry whose folder is gone, as git's own
    // gc would, and touches no folder that exists.
    try { git(["worktree", "prune"], { cwd: c.repoRoot }); } catch { /* best effort: branch -D names what is left */ }
    try { if (branchExists(c.repoRoot, made.branch)) git(["branch", "-D", made.branch], { cwd: c.repoRoot }); } catch { left.push(`branch ${made.branch}`); }
    try { release(c, `worktree:${made.slug}`, { holder: made.id, token: made.lockToken }); } catch { left.push(`lock worktree:${made.slug}`); }
    if (left.length) warn(`cut undone for ${made.id}, but could not remove: ${left.join(", ")}
`);
  };
  try {
    return withJobLock(c, id, () => {
      const fresh = readJob(c, id);
      if (fresh.worktree) fail("WORKTREE_EXISTS", `${id} already has a worktree (${fresh.worktree}); this cut was undone`);
      for (const k of CUT_FIELDS) if (k !== "record") fresh[k] = made[k];
      // The record paths are resolved here, under the job lock, from the new worktree and the other cards' records;
      // a fix whose --log names no single log is LOG_NOT_FOUND, and the cut is undone below.
      fresh.record = resolveRecord(c, fresh, made.worktree, listJobs(c));
      return writeJob(c, fresh);
    });
  } catch (e) { undo(); throw e; }
}

export function removeJob(c, id, { force = false } = {}) {
  const left = remove(c, readJob(c, id), { force });
  return withJobLock(c, id, () => {
    const fresh = readJob(c, id);
    for (const k of CUT_FIELDS) if (k in left) fresh[k] = left[k]; else delete fresh[k];
    return writeJob(c, fresh);
  });
}

/**
 * The one merge the factory makes: a pushed parallel partner's branch into this card's branch, before this card
 * pushes (design §6: cards cut from the same head merge the earlier one; never a rebase). A merge commit always
 * (--no-ff), a fixed message, no trailer, under the commit lock. A conflict is aborted and named, never resolved.
 */
export async function mergePartner(c, id, partnerId) {
  if (typeof partnerId !== "string" || !partnerId || partnerId === id) fail("BAD_ARGS", "merge needs --from <the partner card's id>");
  const job = readJob(c, id), p = readJob(c, partnerId);
  if (job.parallel !== "approved" && p.parallel !== "approved") fail("NOT_PARALLEL", `${id} and ${partnerId} are not an approved parallel pair`);
  if (!["pushed", "merged"].includes(p.stage)) fail("PARTNER_NOT_PUSHED", `${partnerId} is ${p.stage}; merge it in once it has pushed`);
  if (job.stage !== "pushing") fail("NOT_PUSHING", `${id} is ${job.stage}; the partner is merged in at pushing, before the push`);
  if (!job.worktree || !existsSync(job.worktree)) fail("BAD_ARGS", `${id} has no worktree`);
  const lockName = `worktree:${job.slug}`;
  if (!status(c, lockName).held) fail("NOT_HOLDER", `${lockName} is not held; ${id} does not own its worktree`);
  assertHolder(c, lockName, { holder: id, token: job.lockToken });
  const prefix = c.worktrees.branchPrefix;
  if (!p.branch || !prefix || !p.branch.startsWith(prefix)) fail("BRANCH_REFUSED", `${partnerId}'s branch "${p.branch}" is outside ${prefix}*`);
  if (!isClean(job.worktree)) fail("DIRTY_TREE", `uncommitted changes in ${job.worktree}`);
  const message = `merge: ${p.branch} into ${job.branch} (parallel milestones)`;
  return withLock(c, "commit", { holder: id, waitMs: 60_000 }, async () => {
    const r = spawnSync("git", ["merge", "--no-ff", "--no-edit", "-m", message, p.branch], { cwd: job.worktree, encoding: "utf8" });
    if (r.error) fail("GIT_FAILED", `git not runnable: ${r.error.message}`);
    if (r.status !== 0) {
      const files = git(["diff", "--name-only", "--diff-filter=U"], { cwd: job.worktree, allowFail: true }).split(/\r?\n/).filter(Boolean);
      git(["merge", "--abort"], { cwd: job.worktree, allowFail: true });
      if (files.length) fail("MERGE_CONFLICT", `${p.branch} conflicts with ${job.branch} in: ${files.join(", ")}; the merge was aborted`);
      fail("GIT_FAILED", `git merge ${p.branch} (in ${job.worktree}): ${(r.stderr || r.stdout).trim()}`);
    }
    return { branch: p.branch, head: git(["rev-parse", "HEAD"], { cwd: job.worktree }) };
  });
}

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: ["cut", "remove", "base", "merge"], flags: ["slug", "force", "no-fetch", "base-of", "from"] };

register("worktree", async ({ positional: [verb, id], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "base") { const b = resolveBase(c, { fetch: flags["no-fetch"] !== true }); io.stdout(`${b.branch} ${b.head}\n`); return 0; }
  if (!id) fail("BAD_ARGS", "usage: sfactory worktree cut <id> [--slug s] [--base-of <partner id>] | sfactory worktree remove <id> [--force] | sfactory worktree merge <id> --from <partner id> | sfactory worktree base");
  if (verb === "cut") {
    const j = cutJob(c, id, { slug: flags.slug, fetch: flags["no-fetch"] !== true, warn: io.stderr, ...(flags["base-of"] !== undefined ? { baseOf: flags["base-of"] } : {}) });
    io.stdout(`${j.id} ${j.branch} ${j.worktree} (base ${j.base.branch} ${j.base.head.slice(0, 7)}) lock token ${j.lockToken}\n`);
    return 0;
  }
  if (verb === "remove") { removeJob(c, id, { force: flags.force === true }); io.stdout(`${id} worktree removed\n`); return 0; }
  if (verb === "merge") { const m = await mergePartner(c, id, flags.from); io.stdout(`${id} merged ${m.branch} at ${m.head}\n`); return 0; }
  fail("UNKNOWN_COMMAND", `worktree ${verb}`);
}, ACCEPTS);
