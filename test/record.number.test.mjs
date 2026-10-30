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

test("record: a brief pattern without {n} never holds a number", () => {
  const c = { record: { brief: "docs/sfactory/{id}/brief.md", plan: "docs/sfactory/{id}/plan.md", log: "docs/sfactory/{id}/log.md", stories: null, numbering: "job-id" } };
  const d = tmpDir("sf-rn-");
  mkdirSync(join(d, "docs", "sfactory", "m-1"), { recursive: true });
  writeFileSync(join(d, "docs", "sfactory", "m-1", "brief.md"), "# b\n");
  assert.equal(resolveRecord(c, card({ id: "m-7", number: "14" }), d, []).n, 14);
});

test("record: a zero-padded brief holds its number by value", () => {
  assert.throws(() => resolveRecord(cfg("next-milestone-number"), card({ number: "1" }), wt("01-a.md"), []),
    (e) => e.code === "NUMBER_TAKEN" && /spec\/01-a\.md/.test(e.message));
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

test("record: a planned number is reserved under next-milestone-number, merged or not", () => {
  const c = cfg("next-milestone-number");
  const planned = { id: "m-9", kind: "milestone", stage: "roadmap", number: "57", record: null };
  assert.equal(resolveRecord(c, card({}), wt("55-a.md", "56-b.md"), [planned]).n, 58);
  const merged = { id: "m-8", kind: "milestone", stage: "merged", number: "70", record: null };
  assert.equal(resolveRecord(c, card({}), wt("55-a.md"), [merged]).n, 71);
  // a fix card's number never counts, nor does a decimal one
  assert.equal(resolveRecord(c, card({}), wt("55-a.md"), [{ id: "f-1", kind: "fix", stage: "backlog", number: "90" }, { id: "m-7", kind: "milestone", stage: "merged", number: "29.1" }]).n, 56);
});

test("record: an unnumbered card whose id number is another card's planned number is refused", () => {
  const c = cfg("job-id");
  const other = { id: "m-9", kind: "milestone", stage: "roadmap", number: "3", record: null, title: "Later" };
  assert.throws(() => resolveRecord(c, card({}), wt(), [other]), (e) => e.code === "NUMBER_TAKEN" && /m-9/.test(e.message) && /--number/.test(e.message));
  // no collision: unchanged
  assert.equal(resolveRecord(c, card({}), wt(), [{ ...other, number: "4" }]).n, 3);
});
