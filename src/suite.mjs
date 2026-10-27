import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquire } from "./lock.mjs";

function spawnToLog(command, cwd, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = createWriteStream(logPath, { flags: "a" });
  out.write(`=== ${new Date().toISOString()} ${command} ===\n`);
  const lines = [];
  const keep = (chunk) => { for (const l of String(chunk).split(/\r?\n/)) if (l) { lines.push(l); if (lines.length > 40) lines.shift(); } };
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const result = (ok, code, signal) => ({ ok, code, signal, durationMs: Date.now() - started, tail: lines.join("\n") });
    const settle = (r) => { if (settled) return; settled = true; resolve(r); };
    out.on("error", (e) => {
      keep(`log write failed: ${e.message}`);
      settle(result(false, null, null));
    });
    // shell: true is deliberate: the command is the user's own, from config.
    const p = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    p.stdout.on("data", (d) => { out.write(d); keep(d); });
    p.stderr.on("data", (d) => { out.write(d); keep(d); });
    const done = (code, signal, note) => {
      if (settled) return;
      if (note) keep(note);
      const r = result(code === 0, code, signal ?? null);
      const trailer = signal ? `=== exit ${code} signal ${signal} ===\n` : `=== exit ${code} ===\n`;
      out.end(trailer, () => settle(r));
    };
    p.on("error", (e) => done(null, null, `spawn failed: ${e.message}`));
    p.on("close", (code, signal) => done(code, signal));
  });
}

export async function runSuite(c, { cwd, jobId, logPath, command = c.commands.suite }) {
  if (!c.commands.suiteSerial) return spawnToLog(command, cwd, logPath);
  const lock = await acquire(c, "suite", { holder: jobId, waitMs: c.limits.suiteWaitMs, pollMs: 100 });
  try { return await spawnToLog(command, cwd, logPath); }
  finally {
    try { lock.release(); } catch (e) { console.error(`sfactory: suite lock release failed: ${e.message}`); }
  }
}
