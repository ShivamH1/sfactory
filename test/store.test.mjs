import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { slugify, jobDir, listJobs, readJob, writeJob, nextId, writeJobFile, readJobFile, jobFileExists } from "../src/store.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-state-") });

test("store: slugify", () => {
  assert.equal(slugify("M56 Feed moderation queue!"), "m56-feed-moderation-queue");
  assert.equal(slugify("  --Hello  World-- "), "hello-world");
  assert.equal(slugify("x".repeat(80)).length, 40);
});

test("store: nextId counts per kind", () => {
  const c = cfg();
  assert.equal(nextId(c, "milestone"), "m-1");
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  writeJob(c, { id: "m-7", kind: "milestone", title: "b", stage: "backlog", started: "2026-01-02T00:00:00Z", history: [] });
  assert.equal(nextId(c, "milestone"), "m-8");
  assert.equal(nextId(c, "fix"), "f-1");
});

test("store: writeJob is atomic and stamps updated; readJob round-trips; listJobs sorts by started", () => {
  const c = cfg();
  writeJob(c, { id: "f-2", kind: "fix", title: "later", stage: "backlog", started: "2026-01-03T00:00:00Z", history: [] });
  writeJob(c, { id: "f-1", kind: "fix", title: "earlier", stage: "backlog", started: "2026-01-05T00:00:00Z", history: [] });
  const j = readJob(c, "f-1");
  assert.equal(j.title, "earlier");
  assert.ok(j.updated);
  assert.ok(!existsSync(join(jobDir(c, "f-1"), "job.json.tmp")));
  assert.deepEqual(listJobs(c).map((x) => x.id), ["f-2", "f-1"]);
});

test("store: readJob of a missing id is JOB_NOT_FOUND", () => {
  assert.throws(() => readJob(cfg(), "m-9"), (e) => e.code === "JOB_NOT_FOUND");
});

test("store: job files under the job folder", () => {
  const c = cfg();
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  writeJobFile(c, "m-1", "plan/approval.md", "approved\n");
  assert.equal(jobFileExists(c, "m-1", "plan/approval.md"), true);
  assert.equal(readJobFile(c, "m-1", "plan/approval.md"), "approved\n");
  assert.equal(readJobFile(c, "m-1", "nope.md"), null);
  assert.equal(readFileSync(join(jobDir(c, "m-1"), "plan", "approval.md"), "utf8"), "approved\n");
});

test("store: corrupt job.json is JOB_CORRUPT from readJob and listJobs", () => {
  const c = cfg();
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  const f = join(jobDir(c, "m-1"), "job.json");
  writeFileSync(f, "{not json");
  const bad = (e) => e.code === "JOB_CORRUPT" && e.message.includes("job.json");
  assert.throws(() => readJob(c, "m-1"), bad);
  assert.throws(() => listJobs(c), bad);
});

test("store: ids and relative paths are guarded", () => {
  const c = cfg();
  assert.throws(() => readJob(c, ".."), (e) => e.code === "BAD_ID");
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  assert.throws(() => writeJobFile(c, "m-1", "../x.md", ""), (e) => e.code === "BAD_PATH");
  assert.throws(() => readJobFile(c, "m-1", "../x.md"), (e) => e.code === "BAD_PATH");
  assert.throws(() => jobFileExists(c, "m-1", "../x.md"), (e) => e.code === "BAD_PATH");
});
