import { relative, isAbsolute } from "node:path";

const paths = (plan) => new Set(plan.tasks.flatMap((t) => t.files.map((f) => f.path)));
const under = (p, dir) => p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");
const toRel = (c, dir) => (isAbsolute(dir) ? relative(c.repoRoot, dir).replace(/\\/g, "/") : dir);

export function checkMilestones(c, a, b, { nameA = "A", nameB = "B" } = {}) {
  const pa = [...paths(a)], pb = [...paths(b)];
  const checks = [];
  const shared = pa.filter((x) => pb.some((y) => x === y || under(x, y) || under(y, x)));
  checks.push({ name: "disjoint-files", ok: shared.length === 0, detail: shared.length ? `both touch: ${shared.join(", ")}` : "no file in common" });
  const hot = c.hotspots ?? [];
  const hits = (ps) => hot.flatMap((h) => ps.filter((p) => under(p, h)).map((p) => ({ h, p })));
  const ha = hits(pa), hb = hits(pb);
  const sameHot = ha.filter((x) => hb.some((y) => y.p === x.p)).map((x) => x.p);
  const tooMany = [ha, hb].flatMap((hs, i) => hot.filter((h) => hs.filter((x) => x.h === h).length > 1).map((h) => `${i ? nameB : nameA} edits ${h} more than once`));
  const hotOk = sameHot.length === 0 && tooMany.length === 0;
  checks.push({ name: "hotspots", ok: hotOk, detail: hotOk ? "at most one small edit per hotspot, none shared" : [...sameHot.map((p) => `both edit hotspot ${p}`), ...tooMany].join("; ") });
  if (c.migrations?.dir) {
    const dir = toRel(c, c.migrations.dir);
    const ma = pa.some((p) => under(p, dir)), mb = pb.some((p) => under(p, dir));
    checks.push({ name: "migrations", ok: !(ma && mb), detail: ma && mb ? `both add migrations under ${dir}; one applied list on the dev database` : ma || mb ? `only ${ma ? nameA : nameB} adds a migration` : "neither adds a migration" });
  } else checks.push({ name: "migrations", ok: true, detail: "no migrations dir" });
  if (c.record?.carriedForward) {
    const cf = c.record.carriedForward.replace(/\\/g, "/");
    const na = pa.includes(cf), nb = pb.includes(cf);
    checks.push({ name: "numbering", ok: !(na && nb), detail: na && nb ? `both edit ${cf}; ${nameB} waits for ${nameA} to close before taking an entry number` : "no shared entry numbering" });
  } else checks.push({ name: "numbering", ok: true, detail: "no carried-forward list configured" });
  return { ok: checks.every((x) => x.ok), checks };
}

export function taskBatches(plan, max = 4) {
  const batches = [];
  const placed = new Map();   // n -> batch index
  for (const t of plan.tasks) {
    const depsDone = t.dependsOn.every((d) => placed.has(d));
    const minBatch = t.dependsOn.length ? Math.max(...t.dependsOn.map((d) => placed.get(d) ?? Infinity)) + 1 : 0;
    let i = depsDone ? Math.max(minBatch, 0) : batches.length;
    for (; ; i++) {
      if (!batches[i]) { batches[i] = []; }
      const b = batches[i];
      const disjoint = b.every((n) => { const o = plan.tasks.find((x) => x.n === n); return !o.files.some((f) => t.files.some((g) => g.path === f.path)); });
      if (b.length < max && disjoint) { b.push(t.n); placed.set(t.n, i); break; }
    }
  }
  return batches.filter((b) => b.length);
}
