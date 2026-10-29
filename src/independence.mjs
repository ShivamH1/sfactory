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

/** Greedy batches in dependency order (Kahn, ties by plan order); a batch holds tasks with overlap-free files, at most `max`. */
export function taskBatches(plan, max = 4) {
  if (!Number.isInteger(max) || max < 1) fail("BAD_ARGS", "max must be an integer >= 1");
  const byN = new Map(plan.tasks.map((t) => [t.n, t]));
  for (const t of plan.tasks) for (const d of t.dependsOn) if (!byN.has(d)) fail("PLAN_BAD_DEPENDENCY", `Task ${t.n} depends on Task ${d} which does not exist`);
  const order = [];
  const done = new Set();
  while (order.length < plan.tasks.length) {
    const next = plan.tasks.find((t) => !done.has(t.n) && t.dependsOn.every((d) => done.has(d)));
    if (!next) fail("PLAN_DEPENDENCY_CYCLE", `dependency cycle among Tasks ${plan.tasks.filter((t) => !done.has(t.n)).map((t) => t.n).join(", ")}`);
    done.add(next.n); order.push(next);
  }
  const batches = [];
  const placed = new Map();   // n -> batch index
  for (const t of order) {
    let i = t.dependsOn.length ? Math.max(...t.dependsOn.map((d) => placed.get(d))) + 1 : 0;
    for (; ; i++) {
      if (!batches[i]) batches[i] = [];
      const b = batches[i];
      const disjoint = b.every((n) => !touched(byN.get(n)).some((f) => touched(t).some((g) => overlaps(norm(f.path), norm(g.path)))));
      if (b.length < max && disjoint) { b.push(t.n); placed.set(t.n, i); break; }
    }
  }
  return batches.filter((b) => b.length);
}
