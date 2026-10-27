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
    // shell: true is deliberate: the command is the user's own, from config.
    const p = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    p.stdout.on("data", (d) => { out.write(d); keep(d); });
    p.stderr.on("data", (d) => { out.write(d); keep(d); });
    const done = (code, note) => {
      if (note) keep(note);
      out.end(`=== exit ${code} ===\n`, () => resolve({ ok: code === 0, code, durationMs: Date.now() - started, tail: lines.join("\n") }));
    };
    p.on("error", (e) => done(null, `spawn failed: ${e.message}`));
    p.on("close", (code) => done(code));
  });
}

export async function runSuite(c, { cwd, jobId, logPath, command = c.commands.suite }) {
  if (!c.commands.suiteSerial) return spawnToLog(command, cwd, logPath);
  const lock = await acquire(c, "suite", { holder: jobId, waitMs: c.limits.suiteWaitMs, pollMs: 100 });
  try { return await spawnToLog(command, cwd, logPath); } finally { lock.release(); }
}
