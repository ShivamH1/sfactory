import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { tmpDir } from "./helpers.mjs";
import { addJob, readJob, readJobFile, writeJobFile } from "../src/store.mjs";
import { actions } from "../src/job-actions.mjs";
import { startBoard } from "../src/board/server.mjs";

const H = { "X-Sfactory-Board": "1", "Content-Type": "application/json" };
const mk = () => ({ stateDir: tmpDir("sf-srv-"), project: "proj", board: { pollMs: 1500, port: 0 } });
const post = (b, path, body, headers = H) => fetch(`${b.url}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
async function withBoard(c, opts, fn) {
  const b = await startBoard(c, { port: 0, log: () => {}, ...opts });
  try { return await fn(b); } finally { await b.close(); }
}
function toApproval(c, id) { for (const s of ["planning", "awaiting-approval"]) actions.set(c, { id, to: s }); }

test("server: page, snapshot and file route", async () => {
  const c = mk();
  const j = addJob(c, "milestone", "One");
  writeJobFile(c, j.id, "plan/questionnaire.md", "# Q\n");
  await withBoard(c, {}, async (b) => {
    const r = await fetch(b.url);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const s = await (await fetch(`${b.url}jobs.json`)).json();
    assert.equal(s.jobs[0].id, j.id);
    const f = await fetch(`${b.url}jobs/${j.id}/file?path=plan/questionnaire.md`);
    assert.equal(await f.text(), "# Q\n");
    assert.match(f.headers.get("content-type"), /text\/plain/);
    assert.equal((await fetch(`${b.url}jobs/${j.id}/file?path=../x`)).status, 400);
    assert.equal((await fetch(`${b.url}jobs/${j.id}/file?path=..%2Fx.md`)).status, 400);
    assert.equal((await fetch(`${b.url}jobs/${j.id}/file?path=job.json`)).status, 400);
    assert.equal((await fetch(`${b.url}jobs/${j.id}/file?path=plan/none.md`)).status, 404);
    assert.equal((await fetch(`${b.url}nope`)).status, 404);
  });
});

test("server: approve needs the header, the right stage, then writes the approval", async () => {
  const c = mk();
  const j = addJob(c, "milestone", "Gate");
  await withBoard(c, {}, async (b) => {
    assert.equal((await post(b, `jobs/${j.id}/approve`, {}, { "Content-Type": "application/json" })).status, 403);
    const r = await post(b, `jobs/${j.id}/approve`);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, "ILLEGAL_TRANSITION");
    toApproval(c, j.id);
    const ok = await post(b, `jobs/${j.id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).job.stage, "building");
    assert.match(readJobFile(c, j.id, "plan/approval.md"), /approved by board/);
    assert.equal((await post(b, `jobs/${j.id}/bogus`)).status, 404);
    assert.equal((await post(b, "jobs/m-99/approve")).status, 404);
    assert.equal((await post(b, "jobs/x/approve")).status, 400);
  });
});

test("server: answer releases a parked job; parallel no queues; request-changes", async () => {
  const c = mk();
  const f = addJob(c, "fix", "Parked");
  for (const s of ["planning", "building"]) actions.set(c, { id: f.id, to: s });
  actions.park(c, { id: f.id, reason: "which?" });
  const m = addJob(c, "milestone", "Par");
  actions.park(c, { id: m.id, reason: "ok?", pending: "parallel" });
  const a = addJob(c, "milestone", "Plan");
  toApproval(c, a.id);
  await withBoard(c, {}, async (b) => {
    assert.equal((await post(b, `jobs/${f.id}/answer`, {})).status, 409);
    const r = await post(b, `jobs/${f.id}/answer`, { text: "B" });
    assert.equal(r.status, 200);
    assert.equal(readJob(c, f.id).stage, "building");
    const p = await post(b, `jobs/${m.id}/parallel`, { yes: false });
    const pj = (await p.json()).job;
    assert.equal(pj.stage, "backlog");
    assert.equal(pj.parallel, "queued");
    assert.equal((await post(b, `jobs/${a.id}/request-changes`, { notes: "tweak" })).status, 200);
    assert.match(readJobFile(c, a.id, "plan/changes-1.md"), /tweak/);
  });
});

test("server: demo mode refuses POST and reads the demo dir; bad host and big body", async () => {
  const c = mk(), demo = tmpDir("sf-demo-");
  const dj = addJob({ ...c, stateDir: demo }, "fix", "Demo job");
  await withBoard(c, { demoDir: demo }, async (b) => {
    const s = await (await fetch(`${b.url}jobs.json`)).json();
    assert.equal(s.jobs[0].id, dj.id);
    const r = await post(b, `jobs/${dj.id}/approve`);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "DEMO");
  });
  const j = addJob(c, "fix", "Real");
  await withBoard(c, {}, async (b) => {
    assert.equal((await post(b, `jobs/${j.id}/stop`, { reason: "x".repeat(70000) })).status, 413);
    const code = await new Promise((res, rej) => {
      const q = request({ host: "127.0.0.1", port: b.port, path: "/", headers: { Host: "evil.example" } }, (r) => { r.resume(); res(r.statusCode); });
      q.on("error", rej);
      q.end();
    });
    assert.equal(code, 403);
  });
});

test("server: close frees the port", async () => {
  const c = mk();
  const b = await startBoard(c, { port: 0, log: () => {} });
  const port = b.port;
  await b.close();
  const b2 = await startBoard(c, { port, log: () => {} });
  assert.equal(b2.port, port);
  await b2.close();
});

const raw = (b, path, body, headers = H) => fetch(`${b.url}${path}`, { method: "POST", headers, body });

test("server: malformed bodies and fields are 400 BAD_ARGS", async () => {
  const c = mk();
  const j = addJob(c, "milestone", "Bad input");
  toApproval(c, j.id);
  await withBoard(c, {}, async (b) => {
    for (const body of ["{not json", "[1,2]", "", "   ", "null", "7"]) {
      const r = await raw(b, `jobs/${j.id}/approve`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal((await r.json()).code, "BAD_ARGS");
    }
    for (const [route, body] of [
      ["answer", { text: 5 }], ["request-changes", { notes: 5 }], ["rework", { notes: {} }], ["stop", { reason: 1 }],
      ["approve", { by: 5 }], ["parallel", { yes: "no" }],
    ]) {
      const r = await post(b, `jobs/${j.id}/${route}`, body);
      assert.equal(r.status, 400, route);
      assert.equal((await r.json()).code, "BAD_ARGS");
    }
    assert.equal(readJob(c, j.id).stage, "awaiting-approval");
    const m = await fetch(`${b.url}jobs/%E0/approve`, { method: "POST", headers: H, body: "{}" });
    assert.equal(m.status, 400);
    assert.equal((await m.json()).code, "BAD_ARGS");
  });
});

test("server: by is used when given, blank falls back to board", async () => {
  const c = mk();
  const a = addJob(c, "milestone", "By one"), z = addJob(c, "milestone", "By two");
  toApproval(c, a.id); toApproval(c, z.id);
  await withBoard(c, {}, async (b) => {
    assert.equal((await post(b, `jobs/${a.id}/approve`, { by: " ana " })).status, 200);
    assert.equal(readJob(c, a.id).history.at(-1).by, "ana");
    assert.equal((await post(b, `jobs/${z.id}/approve`, { by: "  " })).status, 200);
    assert.equal(readJob(c, z.id).history.at(-1).by, "board");
  });
});

test("server: a 500 answers the code and no message", async () => {
  const c = mk();
  const j = addJob(c, "milestone", "Corrupt");
  writeJobFile(c, j.id, "job.json", "{ broken");
  await withBoard(c, {}, async (b) => {
    const r = await post(b, `jobs/${j.id}/approve`);
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { code: "JOB_CORRUPT" });
  });
});
