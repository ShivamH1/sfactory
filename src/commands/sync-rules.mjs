import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { syncRules } from "../rules.mjs";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["check"] };

register("sync-rules", (args, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  const check = args.flags.check === true;
  const r = syncRules(c.repoRoot, c.rules, { check });
  if (!r.differs.length) { io.stdout(`in sync: ${c.rules.join(", ")}\n`); return 0; }
  if (check) { io.stdout(`differs from ${r.source}: ${r.differs.join(", ")}\n`); return 1; }
  io.stdout(`wrote ${r.written.join(", ")} from ${r.source}\n`);
  return 0;
}, ACCEPTS);
