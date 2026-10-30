import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { actions } from "../job-actions.mjs";
import { fail } from "../errors.mjs";
import { WORKING } from "../job.mjs";
import { jobDir, resolveId } from "../store.mjs";
import { assertNotSecret } from "../commit.mjs";

/**
 * The person's notes for request-changes: exactly one of --notes "<text>" and --notes-file <path> (read relative to
 * the cwd). A path covered by secrets.neverHandToAgents is refused before it is read (SECRET_PATH), as commit refuses it.
 */
function changeNotes(c, flags, cwd) {
  const file = flags["notes-file"];
  if ((flags.notes !== undefined) === (file !== undefined)) fail("BAD_ARGS", 'usage: sfactory job request-changes <id> (--notes "<text>" | --notes-file <path>)');
  if (file === undefined) return flags.notes;
  if (typeof file !== "string") fail("BAD_ARGS", "--notes-file needs a path");
  assertNotSecret(c, [file], { cwd });
  try { return readFileSync(resolve(cwd, file), "utf8"); } catch (e) { fail("BAD_ARGS", `--notes-file ${file}: ${e.code ?? e.message}`); }
}

const done = (io, job, flags) => { io.stdout(flags.json ? JSON.stringify(job, null, 2) + "\n" : `${job.id} ${job.stage}\n`); return 0; };
const str = (v) => (typeof v === "string" ? v : undefined);

/** Flag parsing only: positional + flags -> the args object of the action of the same name. */
const sub = {
  add: (p, f) => ({
    kind: p[0], title: p.slice(1).join(" "),
    ...(f.log !== undefined ? { logOf: f.log } : {}),
    ...(f.number !== undefined ? { number: f.number } : {}),
    ...(f.roadmap === true ? { roadmap: true } : {}),
    ...(f.after !== undefined ? { after: f.after } : {}),
  }),
  set: (p, f) => ({ id: p[0], to: p[1], reason: str(f.reason) ?? null }),
  approve: (p) => ({ id: p[0] }),
  park: (p, f) => ({ id: p[0], reason: f.reason, pending: f.pending, ...(f.with !== undefined ? { with: f.with } : {}) }),
  answer: (p) => ({ id: p[0] }),
  parallel: (p, f) => ({ id: p[0], yes: f.yes === f.no ? undefined : Boolean(f.yes) }),
  stop: (p, f) => ({ id: p[0], reason: str(f.reason) }),
  resume: (p) => ({ id: p[0] }),
  merged: (p) => ({ id: p[0] }),
  rework: (p, f) => ({ id: p[0], notes: f.notes }),
  "request-changes": (p, f) => ({ id: p[0], notes: f.notes }),
  touch: (p, f) => { if (f.note === true) fail("BAD_ARGS", '--note needs a value: sfactory job touch <id> --note "<text>"'); return { id: p[0], note: str(f.note) }; },
  show: (p) => ({ id: p[0] }),
  list: () => ({}),
};

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: Object.keys(sub), flags: ["by", "json", "reason", "pending", "yes", "no", "notes", "notes-file", "note", "log", "with", "number", "roadmap", "after"] };

register("job", async ({ positional, flags }, io) => {
  const [name, ...rest] = positional;
  if (!Object.hasOwn(sub, name ?? "")) fail("UNKNOWN_COMMAND", `job ${name ?? ""}; one of ${Object.keys(sub).join(", ")}`);
  const c = loadConfig(findRepoRoot(io.cwd));
  const args = { ...sub[name](rest, flags), ...(typeof flags.by === "string" ? { by: flags.by } : {}) };
  if (typeof args.id === "string") args.id = resolveId(c, args.id);
  if (name === "add" && (!args.kind || !rest.slice(1).length)) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>" [--log <n>, fix only]');
  if (name === "request-changes") args.notes = changeNotes(c, flags, io.cwd);
  const out = actions[name === "request-changes" ? "requestChanges" : name](c, args);
  if (name === "request-changes") { io.stdout(`${out.id} ${out.stage} ${join(jobDir(c, out.id), out.history.at(-1).file)}\n`); return 0; }
  if (name === "list") {
    io.stdout(flags.json ? JSON.stringify(out, null, 2) + "\n" : out.map((j) => `${j.id.padEnd(6)} ${j.stage.padEnd(18)} ${j.kind.padEnd(9)} ${j.title}\n`).join(""));
    return 0;
  }
  if (name === "touch" && !WORKING.includes(out.stage) && !flags.json) { io.stdout(`${out.id} ${out.stage} (not touched)\n`); return 0; }
  return done(io, out, name === "show" ? { json: true } : flags);
}, ACCEPTS);
