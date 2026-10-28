import { spawnSync } from "node:child_process";
import { mkdirSync, accessSync, constants, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexHomeDir } from "./codex.mjs";

const which = (exec, cmd) => {
  // On Windows an npm-installed shim is a .cmd, which needs a shell; pass one string so no args are concatenated.
  const r = process.platform === "win32" ? exec(`${cmd} --version`, { encoding: "utf8", shell: true }) : exec(cmd, ["--version"], { encoding: "utf8" });
  return r && r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null;
};

export function runDoctor(c, { exec = spawnSync, codexHome = codexHomeDir() } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `node ${process.versions.node}${major >= 20 ? "" : " (need >= 20)"}`);
  const gitV = which(exec, "git"); add("git", !!gitV, gitV ?? "git not on PATH");
  if (!c) { add("config", false, "sfactory.config.json missing or invalid; run sfactory init"); return { ok: false, checks }; }
  add("config", true, `${c.project}, mode ${c.agents.mode}`);
  try { mkdirSync(c.stateDir, { recursive: true }); accessSync(c.stateDir, constants.W_OK); add("stateDir", true, c.stateDir); } catch (e) { add("stateDir", false, `${c.stateDir}: ${e.message}`); }
  if (resolve(c.worktrees.dir) === resolve(c.repoRoot)) add("worktrees.dir", false, "must not be the main checkout");
  else { try { mkdirSync(c.worktrees.dir, { recursive: true }); add("worktrees.dir", true, c.worktrees.dir); } catch (e) { add("worktrees.dir", false, e.message); } }
  add("commands.suite", !!c.commands.suite?.trim(), c.commands.suite || "empty");
  const mode = c.agents.mode;
  if (mode !== "codex") { const v = which(exec, "claude"); add("claude", !!v, v ?? "claude not on PATH (needed for claude and mixed modes)"); }
  if (mode !== "claude") {
    const v = which(exec, "codex"); add("codex", !!v, v ?? "codex not on PATH (needed for codex and mixed modes)");
    for (const p of [c.agents.codex.implement, c.agents.codex.review]) {
      const f = join(codexHome, `${p}.config.toml`);
      const has = existsSync(f);
      add(`codex profile ${p}`, has, has ? f : `${f} not found (see the Codex section of the README)`);
    }
  }
  if (c.rules.length > 1) {
    const bodies = c.rules.map((r) => { const f = join(c.repoRoot, r); return existsSync(f) ? readFileSync(f, "utf8").replace(/\r\n/g, "\n") : null; });
    const same = bodies.every((b) => b !== null && b === bodies[0]);
    add("rules", same, same ? `${c.rules.join(" = ")}` : `${c.rules.join(", ")} differ or are missing; run sfactory sync-rules`);
  }
  return { ok: checks.every((x) => x.ok), checks };
}
