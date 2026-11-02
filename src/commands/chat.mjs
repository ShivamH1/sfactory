import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { resolveId } from "../store.mjs";
import { unread, reply, messages } from "../chat.mjs";
import { fail } from "../errors.mjs";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: ["unread", "reply", "list"], flags: ["card", "json"] };

const REPLY_USAGE = "reply <id> [--] \"<text>\" (after --, the text is taken as it is, dashes and all)";
const USAGE = `usage: sfactory chat unread [--card <id>] [--json] | ${REPLY_USAGE} | list [--card <id>] [--json]`;

register("chat", async ({ positional, flags }, io) => {
  const verb = positional[0];
  if (!verb) fail("BAD_ARGS", USAGE);
  if (!ACCEPTS.verbs.includes(verb)) fail("UNKNOWN_COMMAND", `${verb} (${USAGE})`);
  if (flags.card !== undefined && (typeof flags.card !== "string" || !flags.card)) fail("BAD_ARGS", "--card needs a card id");
  const c = loadConfig(findRepoRoot(io.cwd));

  if (verb === "reply") {
    const id = positional[1];
    const text = [...positional.slice(2), ...(Array.isArray(flags.rest) ? flags.rest : [])].join(" ");
    if (!id || !text.trim()) fail("BAD_ARGS", `usage: sfactory chat ${REPLY_USAGE}`);
    io.stdout(`${reply(c, { replyTo: id, text }).id}\n`);
    return 0;
  }

  const card = flags.card ? resolveId(c, flags.card) : null;

  if (verb === "unread") {
    const list = unread(c, { card });
    if (flags.json) io.stdout(`${JSON.stringify(list, null, 2)}\n`);
    else if (!list.length) io.stdout("No new messages.\n");
    else for (const m of list) io.stdout(`${m.id}  ${m.card ?? "general"}  ${m.at}\n${m.text}\n\n`);
    return 0;
  }

  const list = messages(c).filter((m) => !card || m.card === card);
  if (flags.json) io.stdout(`${JSON.stringify(list, null, 2)}\n`);
  else for (const m of list) {
    io.stdout(`${m.id}  ${m.card ?? "general"}  ${m.status}\n${m.text}\n`);
    for (const r of m.replies) io.stdout(`  ↳ ${r.text}\n`);
  }
  return 0;
}, ACCEPTS);
