import { fileURLToPath } from "node:url";
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { startBoard } from "../board/server.mjs";
import { fail } from "../errors.mjs";

// examples/jobs holds the demo folders, so the demo's state dir is examples/ (the snapshot reads <stateDir>/jobs).
const DEMO_STATE_DIR = fileURLToPath(new URL("../../examples/", import.meta.url));

function parsePort(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) fail("BAD_ARGS", "--port must be a whole number from 0 to 65535");
  return n;
}

register("board", async ({ flags }, io) => {
  if (flags.port !== undefined && flags.port === true) fail("BAD_ARGS", "--port needs a number");
  const demo = flags.demo === true;
  const c = demo ? { project: "demo", stateDir: DEMO_STATE_DIR, board: { port: 5900, pollMs: 2000 } } : loadConfig(findRepoRoot(io.cwd));
  const port = flags.port !== undefined ? parsePort(flags.port) : c.board.port;
  const { url, close } = await startBoard(c, { port, host: "127.0.0.1", demoDir: demo ? DEMO_STATE_DIR : null, log: (s) => io.stderr(`${s}\n`) });
  io.stdout(`board${demo ? " (demo, read-only)" : ""} at ${url}\n`);
  if (flags.once === true) { await close(); return 0; }
  await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  await close();
  return 0;
});
