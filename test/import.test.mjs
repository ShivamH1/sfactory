import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { validateImport, importCards } from "../src/import.mjs";
import { readJob, readJobFile, listJobs } from "../src/store.mjs";
import { actions } from "../src/job-actions.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-im-"), limits: { lockStaleMs: 60_000 } });
const bad = (doc, re) => assert.throws(() => validateImport(doc), (e) => e.code === "BAD_IMPORT" && re.test(e.message), String(re));
const DOC = { cards: [
  { number: "12", kind: "milestone", title: "Saved searches", stage: "merged", branch: "feature/saved-searches", pr: 31, started: "2026-09-02", ended: "2026-09-09" },
  { number: "13", kind: "milestone", title: "CSV export", stage: "external", branch: "feature/csv-export", pr: 34, prUrl: "https://example.com/pr/34", externalNote: "pairing session", started: "2026-09-10" },
  { number: "14", kind: "milestone", title: "Audit log", stage: "roadmap", after: "M13", note: "Needs the export first." },
  { kind: "fix", title: "Typo on the login page", stage: "backlog" },
  { number: "11", kind: "milestone", title: "Search page", stage: "pushed", branch: "feature/search", pr: 30 },
] };

test("import: validation refuses the whole file, naming the card and the field", () => {
  bad(null, /cards/);
  bad({ cards: "x" }, /cards/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "building" }] }, /cards\[0\]\.stage/);
  bad({ cards: [{ kind: "chore", title: "t", stage: "backlog" }] }, /cards\[0\]\.kind/);
  bad({ cards: [{ kind: "milestone", title: "", stage: "backlog" }] }, /cards\[0\]\.title/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "backlog", number: "1.2.3" }] }, /cards\[0\]\.number/);
  bad({ cards: [{ kind: "fix", title: "t", stage: "backlog", number: "3" }] }, /cards\[0\]\.number/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", pr: 0 }] }, /cards\[0\]\.pr/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", prUrl: "javascript:x" }] }, /cards\[0\]\.prUrl/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", started: "not a date" }] }, /cards\[0\]\.started/);
  for (const v of ["1", "March 5", "12/31", "2026-02-30", "2026-09-02T10:00"]) bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", started: v }] }, /cards\[0\]\.started/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", ended: "2026-13-01" }] }, /cards\[0\]\.ended/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "backlog", ended: "2026-01-01" }] }, /cards\[0\]\.ended/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "backlog", externalNote: "x" }] }, /cards\[0\]\.externalNote/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "roadmap", after: "x".repeat(81) }] }, /cards\[0\]\.after/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "roadmap", note: "x".repeat(2001) }] }, /cards\[0\]\.note/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "roadmap", colour: "red" }] }, /cards\[0\]\.colour/);
  bad({ cards: [{ kind: "milestone", title: "a", stage: "roadmap", number: "4" }, { kind: "milestone", title: "b", stage: "roadmap", number: "4" }] }, /cards\[1\]\.number/);
});

test("import: writes every card in its stage with its fields, history and files", () => {
  const c = cfg();
  const r = importCards(c, DOC, { now: "2026-10-30T10:00:00.000Z" });
  assert.deepEqual(r.created.map((x) => [x.id, x.stage]), [["m-1", "merged"], ["m-2", "external"], ["m-3", "roadmap"], ["f-1", "backlog"], ["m-4", "pushed"]]);
  assert.deepEqual(r.skipped, []);
  const m1 = readJob(c, "m-1");
  assert.equal(m1.number, "12"); assert.equal(m1.branch, "feature/saved-searches"); assert.equal(m1.pr, 31);
  assert.equal(m1.started, "2026-09-02T00:00:00.000Z"); assert.equal(m1.ended, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(m1.history, [{ at: "2026-09-02T00:00:00.000Z", from: null, to: "merged", by: "import", reason: "imported" }]);
  assert.equal(readJobFile(c, "m-1", "pr.md"), "PR #31 · feature/saved-searches\n");
  const m2 = readJob(c, "m-2");
  assert.equal(m2.externalNote, "pairing session"); assert.equal(m2.prUrl, "https://example.com/pr/34");
  assert.equal(readJobFile(c, "m-2", "pr.md"), "PR #34 · feature/csv-export\nhttps://example.com/pr/34\n");
  const m3 = readJob(c, "m-3");
  assert.equal(m3.after, "M13"); assert.equal(m3.started, "2026-10-30T10:00:00.000Z"); assert.equal(m3.ended, null);
  assert.equal(readJobFile(c, "m-3", "notes.md"), "Needs the export first.\n");
  assert.equal(readJobFile(c, "f-1", "pr.md"), null);
  // a merged card with no ended date is ended at the import
  const c2 = cfg();
  importCards(c2, { cards: [{ kind: "milestone", title: "t", stage: "merged" }] }, { now: "2026-10-30T10:00:00.000Z" });
  assert.equal(readJob(c2, "m-1").ended, "2026-10-30T10:00:00.000Z");
});

test("import: running it again skips what is already on the board", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "Something else", number: "14" });
  const r1 = importCards(c, DOC, { now: "2026-10-30T10:00:00.000Z" });
  assert.deepEqual(r1.skipped, [{ index: 2, reason: "M14 is m-1" }]);
  const r2 = importCards(c, DOC, { now: "2026-10-30T11:00:00.000Z" });
  assert.equal(r2.created.length, 0);
  assert.equal(r2.skipped.length, 5);
  assert.match(r2.skipped[3].reason, /^a fix titled "Typo on the login page" is f-1$/);
  assert.equal(listJobs(c).length, 5);
});

test("import: a date-time with an offset is normalised to UTC", () => {
  const c = cfg();
  importCards(c, { cards: [{ kind: "milestone", title: "t", stage: "merged", started: "2026-09-02T10:00:00+05:30", ended: "2026-09-03T00:00:00Z" }] }, { now: "2026-10-30T10:00:00.000Z" });
  const j = readJob(c, "m-1");
  assert.equal(j.started, "2026-09-02T04:30:00.000Z"); assert.equal(j.ended, "2026-09-03T00:00:00.000Z");
});

test("import: one bad card writes nothing", () => {
  const c = cfg();
  assert.throws(() => importCards(c, { cards: [DOC.cards[0], { kind: "milestone", title: "t", stage: "building" }] }), (e) => e.code === "BAD_IMPORT");
  assert.equal(listJobs(c).length, 0);
});
