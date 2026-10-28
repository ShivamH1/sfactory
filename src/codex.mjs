import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fail } from "./errors.mjs";
import { killTree, followSignals } from "./suite.mjs";

const SECRETISH = /(_SECRET|_TOKEN|_KEY)$/i;
const ALLOWED_PREFIX = /^(CODEX_|OPENAI_)/i;

/** Config resolves every secrets entry to an absolute path, so an env var name arrives as a path; its basename is the name. Entries that are not env-name shaped (files like .env) are skipped. */
export function secretNames(c) {
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

/** Quote for cmd.exe: backslashes before a quote are doubled, and so are trailing ones, so a path ending in a backslash cannot escape the closing quote. */
export const quoteWin = (a) => (/[\s"&|<>^%()]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"` : a);
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
const shape = (u, source) => ({ inputTokens: Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens)), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cached_input_tokens), source });
/**
 * Lenient usage read from one JSONL event; null when the event carries none. `source` says where it came from
 * ("usage" on a turn event, "token_count" on a per-call counter) so a stream carrying both is counted from one.
 * input_tokens includes the cached part, so the cached tokens are split out into cacheReadTokens.
 */
export function usageOf(ev) {
  const has = (u) => u && typeof u === "object" && (u.input_tokens != null || u.output_tokens != null);
  if (has(ev?.usage)) return shape(ev.usage, "usage");
  const t = ev?.payload?.info?.last_token_usage ?? ev?.msg?.info?.last_token_usage;
  if (has(t)) return shape(t, "token_count");
  if (has(ev)) return shape(ev, "usage");
  return null;
}

/** The model named in a profile file, or null. */
export function profileModel(name, home = codexHomeDir()) {
  try { return (() => { const m = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(readFileSync(profileFile(name, home), "utf8")); return m?.[1] ?? m?.[2] ?? null; })(); } catch { return null; }
}

async function runExecLike(c, { args, cwd, prompt, outDir, logName, timeoutMs, spawn, env }) {
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, logName), lastMessagePath = join(outDir, "last-message.md");
  rmSync(lastMessagePath, { force: true }); // never read a previous run's answer
  const started = Date.now();
  const log = createWriteStream(logPath, { flags: "w" });
  return new Promise((resolve) => {
    let settled = false, timedOut = false, buf = "", child = null, unfollow = NOOP;
    const sums = { usage: null, token_count: null };
    const take = (line) => {
      if (!line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const u = usageOf(ev);
      if (!u) return;
      const cur = sums[u.source] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      sums[u.source] = { inputTokens: cur.inputTokens + u.inputTokens, outputTokens: cur.outputTokens + u.outputTokens, cacheReadTokens: cur.cacheReadTokens + u.cacheReadTokens };
    };
    const finish = (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer); unfollow();
      if (buf) take(buf);
      const usage = sums.usage ?? sums.token_count;
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

export async function runCodexExec(c, { cwd, profile, prompt, sandbox = "workspace-write", outDir, timeoutMs = 3_600_000, spawn = nodeSpawn, which = () => codexOnPath(), codexHome = codexHomeDir(), env = process.env }) {
  preflight({ profile, which, home: codexHome, requireProfile: true });
  const args = ["exec", "-C", cwd, "-p", profile, "-s", sandbox, "--json", "-o", join(outDir, "last-message.md")];
  return runExecLike(c, { args, cwd, prompt, outDir, logName: "codex.jsonl", timeoutMs, spawn, env });
}

/**
 * `codex exec -C <cwd> -p <profile> -s read-only review --json -o <file> -`: exec's own flags carry the profile and sandbox,
 * which plain `codex review` lacks. A custom prompt cannot be combined with --base/--commit, so the target is the first
 * line of the prompt instead.
 */
export async function runCodexReview(c, { cwd, base, commit, prompt, profile, outDir, timeoutMs = 3_600_000, spawn = nodeSpawn, which = () => codexOnPath(), codexHome = codexHomeDir(), env = process.env }) {
  if ((base == null) === (commit == null)) fail("BAD_ARGS", "codex review needs exactly one of base or commit");
  preflight({ profile, which, home: codexHome, requireProfile: true });
  const args = ["exec", "-C", cwd, "-p", profile, "-s", "read-only", "review", "--json", "-o", join(outDir, "last-message.md"), "-"];
  const target = base != null ? `Review the changes on this branch against ${base}: run \`git diff ${base}...HEAD\` to see them.` : `Review commit ${commit}: run \`git show ${commit}\` to see it.`;
  const r = await runExecLike(c, { args, cwd, prompt: `${target}\n\n${prompt}`, outDir, logName: "codex-review.jsonl", timeoutMs, spawn, env });
  return { ...r, text: r.lastMessage };
}
