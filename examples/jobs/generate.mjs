// Regenerates the demo jobs: `node examples/jobs/generate.mjs [outDir]` (default: this folder).
// Every job.json is built through src/job.mjs, with fixed timestamps, so the output is the same everywhere.
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newJob, transition, park, stop } from "../../src/job.mjs";
import { priceOf, totalUsd } from "../../src/cost.mjs";

const T = (h, m = 0) => `2026-01-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const BASE = { branch: "main", ref: "main", head: "0123456789abcdef0123456789abcdef01234567" };
const PRICES = { "demo-model": { input: 3, output: 15, cacheRead: 0.3 } };

function walk(job, steps) {
  let j = job;
  for (const [to, at] of steps) j = transition(j, to, { now: at });
  return j;
}
const start = (id, kind, title, at) => newJob({ id, kind, title, now: at });
const finish = (j, extra) => ({ ...j, updated: j.history[j.history.length - 1].at, ...extra });

function costFile(entries) {
  const list = entries.map(([at, stage, agent, inputTokens, outputTokens, cacheReadTokens]) => {
    const usd = priceOf(PRICES, "demo-model", { inputTokens, outputTokens, cacheReadTokens });
    return { at, stage, agent, model: "demo-model", inputTokens, outputTokens, cacheReadTokens, usd, priced: usd != null };
  });
  return JSON.stringify({ entries: list, total: totalUsd(list) }, null, 2) + "\n";
}

export function jobs() {
  const out = [];

  let m1 = start("m-1", "milestone", "Add a search box to the catalogue", T(8));
  m1 = walk(m1, [["planning", T(8, 5)], ["awaiting-approval", T(8, 30)], ["building", T(9)], ["reviewing", T(11)], ["verifying", T(11, 30)], ["pushing", T(11, 45)], ["pushed", T(12)], ["merged", T(14)]]);
  out.push({ job: finish(m1, { branch: "feature/catalogue-search", base: BASE, tasks: { total: 3, done: 3, parallel: [] } }), files: {} });

  let m2 = start("m-2", "milestone", "Export the orders list as CSV", T(8, 10));
  m2 = walk(m2, [["planning", T(8, 15)], ["awaiting-approval", T(8, 40)], ["building", T(9, 10)], ["reviewing", T(11, 10)], ["verifying", T(11, 40)], ["pushing", T(11, 55)], ["pushed", T(12, 10)]]);
  out.push({
    job: finish(m2, { branch: "feature/orders-csv", base: BASE, tasks: { total: 4, done: 4, parallel: [] } }),
    files: {
      "reviews/task-1.md": "✅ Approved\n\nThe route streams rows and quotes fields correctly.\n",
      "reviews/task-2.md": "✅ Approved\n\nThe button is wired to the route.\n",
      "pr.md": "# Export the orders list as CSV\n\nAdds a download button to the orders list and a server route that streams the rows as CSV.\n\n- Columns follow the table, in the same order.\n- Dates are written as ISO calendar days.\n- Tests cover quoting of commas and newlines.\n" },
  });

  let m3 = start("m-3", "milestone", "Rework the settings page", T(8, 20));
  m3 = walk(m3, [["planning", T(8, 25)], ["awaiting-approval", T(8, 50)], ["building", T(9, 20)]]);
  out.push({
    job: finish(m3, { branch: "feature/settings-rework", base: BASE, worktree: "../wt/settings-rework", tasks: { total: 5, done: 2, parallel: [] }, updated: T(14) }),
    files: {
      "cost.json": costFile([[T(8, 25), "planning", "claude", 42000, 6000, 12000], [T(9, 30), "building", "codex", 88000, 21000, 30000], [T(10), "building", "claude", 64000, 15000, 20000]]),
      "reviews/task-1.md": "✅ Approved\n\nThe sections are split cleanly.\n",
      "reviews/task-2.md": "❌ Needs fixes\n\nThe hook resets the form on every render.\n",
      "plan/tasks.md": "# Tasks\n\n- [x] 1. Split the page into sections\n- [x] 2. Move the form state into one hook\n- [ ] 3. Validate each field on blur\n- [ ] 4. Save with an optimistic update\n- [ ] 5. Write the section tests\n",
    },
  });

  let m4 = start("m-4", "milestone", "Add two-step sign-in", T(8, 30));
  m4 = walk(m4, [["planning", T(8, 35)], ["awaiting-approval", T(9)]]);
  out.push({
    job: finish(m4, { tasks: { total: 6, done: 0, parallel: [] } }),
    files: { "plan/questionnaire.md": "# Questions before building\n\n1. Should a trusted device skip the second step? If so, for how many days?\n2. Which second factor comes first: a code by email or an authenticator app?\n3. May an admin turn the second step off for one account?\n" },
  });

  const m5 = newJob({ id: "m-5", kind: "milestone", title: "Notifications digest", now: T(8, 5), stage: "roadmap", number: "5", after: "M4" });
  out.push({ job: finish(m5, {}), files: {} });

  let m6 = start("m-6", "milestone", "Billing export", T(8, 6));
  m6 = walk(m6, [["external", T(8, 7)]]);
  out.push({ job: finish(m6, { number: "4", externalNote: "pairing session", pr: 12 }), files: {} });

  let f1 = start("f-1", "fix", "Fix the date shown on the receipt", T(8, 40));
  f1 = walk(f1, [["planning", T(8, 45)], ["building", T(9)]]);
  f1 = park(f1, { by: "session", reason: "two readings of the bug are possible", now: T(9, 20) });
  out.push({
    job: finish(f1, { branch: "fix/receipt-date", base: BASE, tasks: { total: 1, done: 0, parallel: [] } }),
    files: { "decisions/1.md": "# Decision needed\n\nThe receipt shows the date the order was placed in the server's time zone, not the customer's.\n\nA. Show the placement date in the customer's own time zone.\nB. Keep the server's time zone and add the zone's name beside the date.\n\nWhich one should the fix follow?\n" },
  });

  let f2 = start("f-2", "fix", "Stop the retry loop on a 404", T(8, 50));
  f2 = walk(f2, [["planning", T(8, 55)], ["building", T(9, 10)]]);
  f2 = stop(f2, { by: "user", reason: "superseded by a larger change", now: T(10, 10) });
  out.push({ job: finish(f2, { branch: "fix/retry-404", base: BASE, tasks: { total: 2, done: 1, parallel: [] } }), files: {} });

  return out;
}

export function generate(outDir) {
  for (const { job, files } of jobs()) {
    const dir = join(outDir, job.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2) + "\n");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  generate(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
}
