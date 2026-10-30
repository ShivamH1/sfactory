import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { resolveRecord } from "../src/record.mjs";

const cfg = (numbering) => ({ record: { brief: "spec/{n}-{slug}.md", plan: "plans/{n}-{slug}.md", log: "log/{n}-{slug}.md", stories: null, numbering } });
const card = (extra) => ({ id: "m-3", kind: "milestone", slug: "audit-log", stage: "planning", ...extra });
const wt = (...briefs) => { const d = tmpDir("sf-rn-"); mkdirSync(join(d, "spec"), { recursive: true }); for (const b of briefs) writeFileSync(join(d, "spec", b), "# b\n"); return d; };

test("record: a numbered card takes its own number under either numbering", () => {
  for (const numbering of ["next-milestone-number", "job-id"]) {
    const r = resolveRecord(cfg(numbering), card({ number: "14" }), wt("01-a.md", "02-b.md"), []);
    assert.equal(r.n, 14, numbering);
    assert.equal(r.brief, "spec/14-audit-log.md");
  }
});

test("record: an unnumbered card keeps today's rule", () => {
  assert.equal(resolveRecord(cfg("next-milestone-number"), card({}), wt("01-a.md", "02-b.md"), []).n, 3);
});

test("record: refusals for a numbered card", () => {
  const c = cfg("next-milestone-number");
  assert.throws(() => resolveRecord(c, card({ number: "29.1" }), wt(), []), (e) => e.code === "BAD_NUMBER");
  assert.throws(() => resolveRecord(c, card({ number: "14" }), wt(), [{ id: "m-9", kind: "milestone", stage: "building", record: { n: 14 } }]),
    (e) => e.code === "NUMBER_TAKEN" && /m-9/.test(e.message));
  assert.throws(() => resolveRecord(c, card({ number: "14" }), wt("14-other.md"), []),
    (e) => e.code === "NUMBER_TAKEN" && /spec\/14-other\.md/.test(e.message));
  // a merged card's record does not hold the number
  assert.equal(resolveRecord(c, card({ number: "14" }), wt(), [{ id: "m-9", kind: "milestone", stage: "merged", record: { n: 14 } }]).n, 14);
});
