import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { actions } from "../job-actions.mjs";
import { fail } from "../errors.mjs";

const done = (io, job, flags) => { io.stdout(flags.json ? JSON.stringify(job, null, 2) + "\n" : `${job.id} ${job.stage}\n`); return 0; };
const str = (v) => (typeof v === "string" ? v : undefined);

/** Flag parsing only: positional + flags -> the args object of the action of the same name. */
const sub = {
  add: (p) => ({ kind: p[0], title: p.slice(1).join(" ") }),
  set: (p, f) => ({ id: p[0], to: p[1], reason: str(f.reason) ?? null }),
  approve: (p) => ({ id: p[0] }),
  park: (p, f) => ({ id: p[0], reason: f.reason, pending: f.pending }),
  answer: (p) => ({ id: p[0] }),
  parallel: (p, f) => ({ id: p[0], yes: f.yes === f.no ? undefined : Boolean(f.yes) }),
  stop: (p, f) => ({ id: p[0], reason: str(f.reason) }),
  resume: (p) => ({ id: p[0] }),
  merged: (p) => ({ id: p[0] }),
  rework: (p, f) => ({ id: p[0], notes: f.notes }),
  touch: (p, f) => ({ id: p[0], note: str(f.note) }),
  show: (p) => ({ id: p[0] }),
  list: () => ({}),
};

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: Object.keys(sub), flags: ["by", "json", "reason", "pending", "yes", "no", "notes", "note"] };

register("job", async ({ positional, flags }, io) => {
  const [name, ...rest] = positional;
  if (!Object.hasOwn(sub, name ?? "")) fail("UNKNOWN_COMMAND", `job ${name ?? ""}; one of ${Object.keys(sub).join(", ")}`);
  const c = loadConfig(findRepoRoot(io.cwd));
  const args = { ...sub[name](rest, flags), ...(typeof flags.by === "string" ? { by: flags.by } : {}) };
  if (name === "add" && (!args.kind || !rest.slice(1).length)) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>"');
  const out = actions[name](c, args);
  if (name === "list") {
    io.stdout(flags.json ? JSON.stringify(out, null, 2) + "\n" : out.map((j) => `${j.id.padEnd(6)} ${j.stage.padEnd(18)} ${j.kind.padEnd(9)} ${j.title}\n`).join(""));
    return 0;
  }
  return done(io, out, name === "show" ? { json: true } : flags);
}, ACCEPTS);
