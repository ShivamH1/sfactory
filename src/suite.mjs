import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquire } from "./lock.mjs";

/**
 * Kill the child and everything under it, only while the child has not exited: once it has, its pid
 * (and on POSIX its group id) can belong to an unrelated process, so nothing is killed.
 * On Windows the tree is killed first: once p.kill() has ended the shell, taskkill /T can no longer
 * find its children and the real command runs on.
 */
export function killTree(p) {
  if (!p) return;
  // == null, not === null: a child that never reports these (a test double) counts as running.
  if (p.exitCode != null || p.signalCode != null) return;
  if (process.platform === "win32" && p.pid) {
    try { spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
  }
  if (process.platform !== "win32" && p.pid) {
    // POSIX: a child spawned detached leads its own process group, and -pid reaches its descendants.
    // A child that is not a group leader makes this throw, and p.kill() below ends the child alone.
    try { process.kill(-p.pid, "SIGKILL"); return; } catch { /* not a group leader: fall back */ }
  }
  try { p.kill(); } catch { /* best effort */ }
}

const FOLLOWED = ["SIGINT", "SIGTERM", "SIGHUP"];
/** The signal's default action, unless someone else in this process has taken the signal over. */
function reraiseSignal(sig) {
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}
/**
 * A detached child does not get the terminal's Ctrl+C, SIGHUP or a signal sent to our group, so it
 * would outlive us. While it runs, SIGINT, SIGTERM and SIGHUP kill its tree and are then re-raised;
 * the handlers go when the child closes or errors, or when the returned function is called.
 * `kill` and `reraise` are injectable for tests only.
 */
export function followSignals(child, { kill = killTree, reraise = reraiseSignal } = {}) {
  const handlers = new Map();
  const off = () => {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    handlers.clear();
    child.removeListener("close", off);
    child.removeListener("error", off);
  };
  for (const sig of FOLLOWED) {
    const h = () => { off(); kill(child); reraise(sig); };
    handlers.set(sig, h);
    process.once(sig, h);
  }
  child.once("close", off);
  child.once("error", off);
  return off;
}

function spawnToLog(command, cwd, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = createWriteStream(logPath, { flags: "a" });
  let child = null;
  let ending = false;
  let settledEarly = null; // set by a log-stream error before the child finished
  out.on("error", (e) => { if (settledEarly) settledEarly(e); });
  out.write(`=== ${new Date().toISOString()} ${command} ===\n`);
  const lines = [];
  const keep = (chunk) => { for (const l of String(chunk).split(/\r?\n/)) if (l) { lines.push(l); if (lines.length > 40) lines.shift(); } };
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const result = (ok, code, signal) => ({ ok, code, signal, durationMs: Date.now() - started, tail: lines.join("\n") });
    const settle = (r) => { if (settled) return; settled = true; resolve(r); };
    settledEarly = (e) => {
      if (ending) return;
      ending = true;
      keep(`log write failed: ${e.message}`);
      killTree(child);
      settle(result(false, null, null));
    };
    // shell: true is deliberate: the command is the user's own, from config.
    // Detached off win32 so a kill reaches the whole group; followSignals makes up for the lost terminal signals.
    const detached = process.platform !== "win32";
    const p = child = spawn(command, { cwd, shell: true, detached, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    if (detached) followSignals(p);
    p.stdout.on("data", (d) => { out.write(d); keep(d); });
    p.stderr.on("data", (d) => { out.write(d); keep(d); });
    const done = (code, signal, note) => {
      if (ending || settled) return;
      ending = true;
      if (note) { keep(note); out.write(`${note}
`); }
      const r = result(code === 0, code, signal ?? null);
      const trailer = signal ? `=== exit ${code} signal ${signal} ===\n` : `=== exit ${code} ===\n`;
      out.end(trailer, () => settle(r));
    };
    p.on("error", (e) => done(null, null, `spawn failed: ${e.message}`));
    p.on("close", (code, signal) => done(code, signal));
  });
}

export async function runSuite(c, { cwd, jobId, logPath, command = c.commands.suite }) {
  if (c.commands.suiteSerial === false) return spawnToLog(command, cwd, logPath);
  const lock = await acquire(c, "suite", { holder: jobId, waitMs: c.limits.suiteWaitMs, pollMs: 100 });
  try { return await spawnToLog(command, cwd, logPath); }
  finally {
    try { lock.release(); } catch (e) { console.error(`sfactory: suite lock release failed: ${e.message}`); }
  }
}
