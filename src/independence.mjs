import { relative, isAbsolute } from "node:path";
import { fail } from "./errors.mjs";

const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
/** Files a task touches: a "read" line touches nothing, so it never conflicts. */
const touched = (t) => t.files.filter((f) => f.op !== "read");
const paths = (plan) => new Set(plan.tasks.flatMap((t) => touched(t).map((f) => norm(f.path))));
const under = (p, dir) => p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");
const overlaps = (x, y) => under(x, y) || under(y, x);
const toRel = (c, dir) => norm(isAbsolute(dir) ? relative(c.repoRoot, dir) : dir);

/**
 * Four checks. Hotspot rule as implemented: at most one distinct file under a
 * hotspot per plan, and never the same file in both plans (the brief's reading;
 * the design's "one small edit" cannot be measured by a script).
 */
export function checkMilestones(c, a, b, { nameA = "A", nameB = "B" } = {}) {
  const pa = [...paths(a)], pb = [...paths(b)];
  const checks = [];
  const shared = pa.filter((x) => pb.some((y) => overlaps(x, y)));
  checks.push({ name: "disjoint-files", ok: shared.length === 0, detail: shared.length ? `both touch: ${shared.join(", ")}` : "no file in common" });
  const hot = (c.hotspots ?? []).map(norm);
  const hits = (ps) => hot.flatMap((h) => ps.filter((p) => under(p, h)).map((p) => ({ h, p })));
  const ha = hits(pa), hb = hits(pb);
  const sameHot = [...new Set(ha.filter((x) => hb.some((y) => y.h === x.h && overlaps(x.p, y.p))).map((x) => x.p))];
  const tooMany = [ha, hb].flatMap((hs, i) => hot.filter((h) => hs.filter((x) => x.h === h).length > 1).map((h) => `${i ? nameB : nameA} edits ${h} more than once`));
  const hotOk = sameHot.length === 0 && tooMany.length === 0;
  checks.push({ name: "hotspots", ok: hotOk, detail: hotOk ? "at most one file per hotspot, none shared" : [...sameHot.map((p) => `both edit hotspot ${p}`), ...tooMany].join("; ") });
  if (c.migrations?.dir) {
    const dir = toRel(c, c.migrations.dir);
    const ma = pa.some((p) => overlaps(p, dir)), mb = pb.some((p) => overlaps(p, dir));
    checks.push({ name: "migrations", ok: !(ma && mb), detail: ma && mb ? `both add migrations under ${dir}; one applied list on the dev database` : ma || mb ? `only ${ma ? nameA : nameB} adds a migration` : "neither adds a migration" });
  } else checks.push({ name: "migrations", ok: true, detail: "no migrations dir" });
  if (c.record?.carriedForward) {
    const cf = norm(c.record.carriedForward);
    const na = pa.some((p) => overlaps(p, cf)), nb = pb.some((p) => overlaps(p, cf));
    checks.push({ name: "numbering", ok: !(na && nb), detail: na && nb ? `both edit ${cf}; ${nameB} waits for ${nameA} to close before taking an entry number` : "no shared entry numbering" });
  } else checks.push({ name: "numbering", ok: true, detail: "no carried-forward list configured" });
  return { ok: checks.every((x) => x.ok), checks };
}

/** The project's migrations directory relative to the repo root, as checkMilestones reads it; null when it has none. */
export const migrationsDirOf = (c) => (c?.migrations?.dir ? toRel(c, c.migrations.dir) : null);

/**
 * Greedy batches in dependency order (Kahn, ties by plan order); a batch holds
 * tasks with overlap-free files, at most `max`, and at most one task that adds
 * or changes anything under `migrationsDir` (one applied list on a shared
 * database). A plan whose `dependencyInfo` is not "declared" - no task says
 * what it waits for - runs one task per batch in plan order unless
 * `allowUndeclared`: absent dependencies are not proof of independence.
 *
 * A file a task shares with an earlier task (plan order) is an implicit
 * ordering edge: the later task waits for the earlier one. The edge is left
 * out only when the earlier task already waits, by the edges so far, for the
 * later one (an explicit forward "Depends on"), so it never makes a cycle.
 * Two tasks that each touch `migrationsDir` are ordered the same way, since
 * migration folders are numbered in creation order.
 */
export function taskBatches(plan, max = 4, { allowUndeclared = false, migrationsDir = null } = {}) {
  if (!Number.isInteger(max) || max < 1) fail("BAD_ARGS", "max must be an integer >= 1");
  const byN = new Map(plan.tasks.map((t) => [t.n, t]));
  for (const t of plan.tasks) for (const d of t.dependsOn) if (!byN.has(d)) fail("PLAN_BAD_DEPENDENCY", `Task ${t.n} depends on Task ${d} which does not exist`);
  const declared = plan.dependencyInfo === "declared" || plan.tasks.some((t) => t.dependsOn.length);
  if (!declared && !allowUndeclared) return plan.tasks.map((t) => [t.n]);
  const mig = migrationsDir ? norm(migrationsDir) : null;
  const migrates = (t) => !!mig && touched(t).some((f) => overlaps(norm(f.path), mig));
  const shares = (a, b) => touched(a).some((f) => touched(b).some((g) => overlaps(norm(f.path), norm(g.path))));
  const waits = new Map(plan.tasks.map((t) => [t.n, [...t.dependsOn]]));
  const reaches = (from, to) => {
    const seen = new Set(), stack = [from];
    while (stack.length) { const n = stack.pop(); if (n === to) return true; if (!seen.has(n)) { seen.add(n); stack.push(...waits.get(n)); } }
    return false;
  };
  plan.tasks.forEach((t, k) => {
    for (const u of plan.tasks.slice(0, k)) if ((shares(u, t) || (migrates(u) && migrates(t))) && !reaches(u.n, t.n) && !waits.get(t.n).includes(u.n)) waits.get(t.n).push(u.n);
  });
  const order = [];
  const done = new Set();
  while (order.length < plan.tasks.length) {
    const next = plan.tasks.find((t) => !done.has(t.n) && waits.get(t.n).every((d) => done.has(d)));
    if (!next) fail("PLAN_DEPENDENCY_CYCLE", `dependency cycle among Tasks ${plan.tasks.filter((t) => !done.has(t.n)).map((t) => t.n).join(", ")}`);
    done.add(next.n); order.push(next);
  }
  const batches = [];
  const placed = new Map();   // n -> batch index
  for (const t of order) {
    const w = waits.get(t.n);
    let i = w.length ? Math.max(...w.map((d) => placed.get(d))) + 1 : 0;
    for (; ; i++) {
      if (!batches[i]) batches[i] = [];
      const b = batches[i];
      const disjoint = b.every((n) => !shares(byN.get(n), t));
      const oneMigration = !migrates(t) || !b.some((n) => migrates(byN.get(n)));
      if (b.length < max && disjoint && oneMigration) { b.push(t.n); placed.set(t.n, i); break; }
    }
  }
  return batches.filter((b) => b.length);
}
