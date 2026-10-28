import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fail } from "./errors.mjs";
import { killTree, followSignals } from "./suite.mjs";

const SECRETISH = /(_SECRET|_TOKEN|_KEY)$/i;
const ALLOWED_PREFIX = /^(CODEX_|OPENAI_)/i;

/** Config resolves every secrets entry to an absolute path, so an env var name arrives as a path; its basename is the name. Entries that are not env-name shaped (files like .env) are skipped. */
function secretNames(c) {
  return (c?.secrets?.neverHandToAgents ?? []).map((s) => basename(s)).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}

/** The environment a Codex child gets: nothing named in secrets, and no *_SECRET/*_TOKEN/*_KEY unless CODEX_* or OPENAI_*. */
export function filterEnv(c, env = process.env) {
  const drop = new Set(secretNames(c).map((s) => s.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (drop.has(k.toUpperCase())) continue;
    if (SECRETISH.test(k) && !ALLOWED_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function codexOnPath(env = process.env, platform = process.platform) {
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const x of exts) {
      try { if (statSync(join(dir, "codex" + x)).isFile()) return true; } catch { /* next */ }
    }
  }
  return false;
}

export const codexHomeDir = (env = process.env) => env.CODEX_HOME || join(homedir(), ".codex");
export const profileFile = (name, home = codexHomeDir()) => join(home, `${name}.config.toml`);

const quoteWin = (a) => (/[\s"&|<>^%()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const NOOP = () => {};
/**
 * Returns the child and the function that stops following the parent's signals. Off win32 the child is
 * detached (its own process group, so a timeout's killTree reaches everything codex started), and so
 * SIGINT, SIGTERM and SIGHUP are passed on to it while it runs.
 */
function launch(spawn, args, cwd, env) {
  // An npm-installed codex on Windows is a .cmd shim, which needs a shell; arguments are quoted by hand.
  if (process.platform === "win32") return { child: spawn(["codex", ...args.map(quoteWin)].join(" "), { cwd, env, shell: true, stdio: ["pipe", "pipe", "pipe"] }), unfollow: NOOP };
  const child = spawn("codex", args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  return { child, unfollow: followSignals(child) };
}

function preflight({ profile, which, home, requireProfile }) {
  if (!which()) fail("CODEX_MISSING", "codex is not on PATH");
  if (requireProfile && !existsSync(profileFile(profile, home))) fail("CODEX_PROFILE_MISSING", `${profileFile(profile, home)} not found (see the Codex section of the README)`);
}

const num = (v) => (Number.isFinite(v) ? v : 0);
/** Lenient usage read from one JSONL event; null when the event carries none. */
export function usageOf(ev) {
  const u = ev?.usage ?? ev?.payload?.info?.last_token_usage ?? ev?.msg?.info?.last_token_usage;
  if (u && typeof u === "object" && (u.input_tokens != null || u.output_tokens != null)) return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  if (ev && (ev.input_tokens != null || ev.output_tokens != null)) return { inputTokens: num(ev.input_tokens), outputTokens: num(ev.output_tokens) };
  return null;
}

export async function runCodexExec(c, { cwd, profile, prompt, sandbox = "workspace-write", outDir, timeoutMs = 3_600_000, spawn = nodeSpawn, which = () => codexOnPath(), codexHome = codexHomeDir(), env = process.env }) {
  preflight({ profile, which, home: codexHome, requireProfile: true });
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, "codex.jsonl"), lastMessagePath = join(outDir, "last-message.md");
  const args = ["exec", "-C", cwd, "-p", profile, "-s", sandbox, "--json", "-o", lastMessagePath];
  const started = Date.now();
  const log = createWriteStream(logPath, { flags: "w" });
  return new Promise((resolve) => {
    let settled = false, timedOut = false, buf = "", usage = null, child = null, unfollow = NOOP;
    const take = (line) => {
      if (!line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const u = usageOf(ev);
      if (u) usage = { inputTokens: (usage?.inputTokens ?? 0) + u.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens };
    };
    const finish = (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer); unfollow();
      if (buf) take(buf);
      log.end(() => {
        let lastMessage = "";
        try { lastMessage = readFileSync(lastMessagePath, "utf8"); } catch { /* none written */ }
        resolve({ ok: exitCode === 0 && !timedOut, exitCode, lastMessage, usage, logPath, lastMessagePath, durationMs: Date.now() - started, ...(timedOut ? { timedOut: true } : {}) });
      });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); setTimeout(() => finish(null), 50); }, timeoutMs);
    try { ({ child, unfollow } = launch(spawn, args, cwd, filterEnv(c, env))); } catch (e) { log.write(`spawn failed: ${e.message}\n`); return finish(null); }
    child.stdout.on("data", (d) => { log.write(d); buf += String(d); const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(take); });
    child.stderr.on("data", (d) => log.write(d));
    child.stdin.on("error", () => { /* child exited before reading the prompt */ });
    child.on("error", (e) => { log.write(`spawn failed: ${e.message}\n`); finish(null); });
    child.on("close", (code) => finish(code));
    child.stdin.end(prompt);
  });
}

export async function runCodexReview(c, { cwd, base, commit, prompt, profile, outDir, timeoutMs = 3_600_000, spawn = nodeSpawn, which = () => codexOnPath(), codexHome = codexHomeDir(), env = process.env }) {
  if ((base == null) === (commit == null)) fail("BAD_ARGS", "codex review needs exactly one of base or commit");
  // codex review has no --profile flag; a given profile is still checked so a misconfigured setup fails early.
  preflight({ profile, which, home: codexHome, requireProfile: profile != null });
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, "codex-review.log");
  const args = ["review", ...(base != null ? ["--base", base] : ["--commit", commit]), "-"];
  const log = createWriteStream(logPath, { flags: "w" });
  return new Promise((resolve) => {
    let settled = false, text = "", child = null, unfollow = NOOP;
    const finish = (code) => { if (settled) return; settled = true; clearTimeout(timer); unfollow(); log.end(() => resolve({ ok: code === 0, text, logPath })); };
    const timer = setTimeout(() => { killTree(child); setTimeout(() => finish(null), 50); }, timeoutMs);
    try { ({ child, unfollow } = launch(spawn, args, cwd, filterEnv(c, env))); } catch (e) { log.write(`spawn failed: ${e.message}\n`); return finish(null); }
    child.stdout.on("data", (d) => { text += String(d); log.write(d); });
    child.stderr.on("data", (d) => log.write(d));
    child.stdin.on("error", () => {});
    child.on("error", (e) => { log.write(`spawn failed: ${e.message}\n`); finish(null); });
    child.on("close", (code) => finish(code));
    child.stdin.end(prompt);
  });
}
