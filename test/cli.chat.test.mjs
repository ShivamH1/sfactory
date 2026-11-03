import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadConfig } from "../src/config.mjs";
import { postMessage, messages } from "../src/chat.mjs";

const repo = () => { const r = tmpRepo(); writeConfig(r, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }); return r; };
async function run(cwd, args) {
  const out = [], err = [];
  const code = await main(args, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

test("cli chat: unread prints and marks, reply answers, list shows statuses", async () => {
  const r0 = repo();
  const c = loadConfig(r0);
  const m = postMessage(c, { text: "Why is m-1 parked?", card: "m-1", now: "2026-11-02T12:00:00.000Z" });
  let r = await run(r0, ["chat", "unread"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${m.id}  m-1  2026-11-02T12:00:00.000Z\nWhy is m-1 parked?\n\n`);
  assert.equal((await run(r0, ["chat", "unread"])).out, "No new messages.\n");
  r = await run(r0, ["chat", "reply", m.id, "It is waiting for your answer on decision 2."]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^msg-/);
  assert.equal(messages(c)[0].status, "answered");
  r = await run(r0, ["chat", "list"]);
  assert.match(r.out, new RegExp(`^${m.id}  m-1  answered\\nWhy is m-1 parked\\?\\n  ↳ It is waiting for your answer on decision 2\\.\\n`));
});

test("cli chat: --card filters, --json prints objects, refusals exit non-zero", async () => {
  const r0 = repo();
  const c = loadConfig(r0);
  postMessage(c, { text: "general" });
  const b = postMessage(c, { text: "about m-2", card: "m-2" });
  const r = await run(r0, ["chat", "unread", "--card", "m-2", "--json"]);
  assert.deepEqual(JSON.parse(r.out).map((x) => x.id), [b.id]);
  assert.notEqual((await run(r0, ["chat", "reply", "msg-none", "hi"])).code, 0);
  assert.notEqual((await run(r0, ["chat", "reply", b.id])).code, 0);
  assert.notEqual((await run(r0, ["chat", "shout"])).code, 0);
});

test("cli chat: --card without a value is refused; reply does not resolve --card", async () => {
  const r0 = repo();
  const c = loadConfig(r0);
  const m = postMessage(c, { text: "q" });
  for (const args of [["chat", "unread", "--card"], ["chat", "unread", "--card="], ["chat", "list", "--card"], ["chat", "list", "--card="]]) {
    const r = await run(r0, args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.err, "error BAD_ARGS: --card needs a card id\n", args.join(" "));
  }
  assert.equal(messages(c)[0].status, "sent", "a refused unread marks nothing");
  // M99 names no card: unread and list resolve it and fail, reply never looks
  assert.match((await run(r0, ["chat", "list", "--card", "M99"])).err, /JOB_NOT_FOUND/);
  const r = await run(r0, ["chat", "reply", m.id, "fine", "--card", "M99"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(messages(c)[0].replies[0].text, "fine");
});

test("cli chat: reply takes the text after -- as it is, so a reply may start with dashes", async () => {
  const r0 = repo();
  const c = loadConfig(r0);
  const m = postMessage(c, { text: "q" });
  let r = await run(r0, ["chat", "reply", m.id, "--", "--force is not needed"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(messages(c)[0].replies.at(-1).text, "--force is not needed");
  r = await run(r0, ["chat", "reply", m.id, "use", "--", "--json", "here"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(messages(c)[0].replies.at(-1).text, "use --json here");
  assert.equal((await run(r0, ["chat", "reply", m.id, "--"])).code, 2, "nothing after -- is no text");
  assert.match((await run(r0, ["chat"])).err, /reply <id> \[--\] "<text>"/);
});
