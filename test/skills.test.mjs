import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_PLACEHOLDERS } from "../src/placeholders.mjs";
import { READ_ONLY_TOOLS, checkCommon, selfTest } from "./skills.helpers.mjs";
import { main as _registerCommands } from "../src/cli.mjs"; // importing cli.mjs registers every command module
import { commands } from "../src/registry.mjs";
import { actions } from "../src/job-actions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Task 7 extends the folders. agents/ are static (Claude Code renders no placeholders); prompts/ are rendered by the script.
const READ_ONLY_AGENTS = new Set(["spec-reviewer", "code-reviewer", "judge", "triage"]);

const FOLDERS = ["agents", "prompts"];
function files(dir) {
  const p = join(root, dir);
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".md") && f !== "ATTRIBUTION.md").map((f) => ({ dir, f, path: join(p, f) })) : [];
}
function split(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { fm: null, body: text };
  const fm = {};
  for (const l of m[1].split("\n")) { const i = l.indexOf(":"); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { fm, body: m[2] };
}

for (const dir of FOLDERS) {
  for (const { f, path } of files(dir)) {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const { fm } = split(text);
    const label = `${dir}/${f}`;
    checkCommon(label, text);
    if (dir === "agents") {
      test(`${label}: static - no placeholders, frontmatter has no model`, () => {
        assert.ok(!/\{\{/.test(text), "agents are never rendered");
        assert.ok(fm, "frontmatter present");
        for (const k of ["name", "description", "tools"]) assert.ok(fm[k], `key ${k}`);
        assert.ok(!("model" in fm), "the orchestrator passes the model at dispatch");
        assert.equal(fm.name, f.replace(/\.md$/, ""));
      });
      const name = f.replace(/\.md$/, "");
      if (READ_ONLY_AGENTS.has(name)) {
        test(`${label}: read-only tools, final-message report, gate rule`, () => {
          for (const t of fm.tools.split(",").map((s) => s.trim())) assert.ok(READ_ONLY_TOOLS.has(t), `tool ${t} is not read-only`);
          assert.match(text, /final message IS the report/);
          assert.match(text, /✅ Approved/);
          assert.match(text, /❌ Needs fixes/);
          assert.match(text, /Critical or Important/);
        });
      }
      if (name === "implementer") {
        test(`${label}: commit rule, files rule, TDD evidence, fix round`, () => {
          assert.match(text, /sfactory commit --cwd <WORKTREE> --holder <JOB> --m /);
          assert.match(text, /Never `git commit`/);
          assert.match(text, /Touch only those files/);
          assert.match(text, /RED/); assert.match(text, /GREEN/);
          assert.match(text, /After review findings/);
        });
      }
    } else {
      test(`${label}: placeholders are known`, () => {
        for (const m of text.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(KNOWN_PLACEHOLDERS.has(m[1]), `unknown placeholder {{${m[1]}}}`);
      });
      test(`${label}: Codex never commits and reports by final message`, () => {
        assert.ok(!/sfactory commit --cwd/.test(text), "no commit command");
        assert.ok(!/standard output|stdout/i.test(text), "report is the final message");
        assert.match(text, /final message/);
      });
      test(`${label}: inlined inputs sit in a fenced data block after the rules`, () => {
        const i = text.indexOf("## Rules of the factory");
        const j = text.indexOf("````text");
        assert.ok(i > 0 && j > i, "fence after the rules");
        for (const m of text.matchAll(/\{\{(\w+_text)\}\}/g)) {
          const at = m.index;
          const open = text.lastIndexOf("````text\n", at);
          const close = text.indexOf("\n````", at);
          assert.ok(open > i && open < at && close > at && !text.slice(open + 9, at).includes("\n````"), `{{${m[1]}}} is inside a fence`);
        }
      });
    }
  }
}

test("secrets: example configs' neverHandToAgents entries are not named in any file", () => {
  const dir = join(root, "examples");
  const entries = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
    entries.push(...(c.secrets?.neverHandToAgents ?? []));
  }
  assert.ok(entries.length > 0);
  for (const d of FOLDERS) for (const { f, path } of files(d)) {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    for (const e of entries) assert.ok(!text.includes(e), `${d}/${f} names ${e}`);
  }
});

test("all expected Task 6 files exist", () => {
  for (const f of ["agents/implementer.md", "agents/spec-reviewer.md", "agents/code-reviewer.md", "agents/judge.md", "agents/triage.md", "prompts/codex-implement.md", "prompts/codex-review.md", "prompts/codex-judge.md", "agents/ATTRIBUTION.md", "prompts/ATTRIBUTION.md"])
    assert.ok(existsSync(join(root, f)), f);
});

test("the Rules of the factory block is identical across agents/ and across prompts/", () => {
  const rules = (text) => /## Rules of the factory[\s\S]*?(?=\n## )/.exec(text)?.[0];
  for (const dir of FOLDERS) {
    const blocks = files(dir).map(({ f, path }) => [f, rules(readFileSync(path, "utf8"))]);
    assert.ok(blocks.length > 0);
    for (const [f, b] of blocks) { assert.ok(b, `${dir}/${f} has the block`); assert.equal(b, blocks[0][1], `${dir}/${f} differs from ${blocks[0][0]}`); }
  }
});

selfTest();

test("no tracked text file contains control bytes (a raw backspace once replaced every \b)", () => {
  const out = execFileSync("git", ["ls-files", "-z", "--", "src", "test", "board", "agents", "prompts", "skills", "examples", "bin"], { cwd: root, encoding: "utf8" });
  const bad = [];
  for (const f of out.split("\0").filter(Boolean)) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip)$/i.test(f)) continue;
    const p = join(root, f);
    if (!existsSync(p)) continue;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(readFileSync(p, "latin1"))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

// Task 7: the three adapted skills (skills/<name>/), copied from superpowers with ATTRIBUTION.md and CHANGES.md.
const SKILLS = ["brainstorming", "writing-plans", "sdd"];
const skillsRoot = join(root, "skills");
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p) => p.slice(root.length + 1).split("\\").join("/");
/** The agent-facing Markdown of a skill: everything but the attribution and the changelog. */
const skillDocs = (s) => walk(join(skillsRoot, s)).filter((p) => p.endsWith(".md") && !/(ATTRIBUTION|CHANGES)\.md$/.test(p));

test("all expected Task 7 skill files exist", () => {
  for (const s of SKILLS) for (const f of ["SKILL.md", "ATTRIBUTION.md", "CHANGES.md"]) assert.ok(existsSync(join(skillsRoot, s, f)), `skills/${s}/${f}`);
  assert.ok(existsSync(join(skillsRoot, "sdd", "scripts", "task-brief")), "skills/sdd/scripts/task-brief");
  assert.ok(!existsSync(join(skillsRoot, "brainstorming", "visual-companion.md")), "the visual companion is removed");
  assert.ok(!existsSync(join(skillsRoot, "brainstorming", "scripts")), "the visual companion's scripts are removed");
});

for (const s of SKILLS) {
  const dir = join(skillsRoot, s);
  test(`skills/${s}/SKILL.md: frontmatter names the skill and describes it`, () => {
    const { fm } = split(read(join(dir, "SKILL.md")));
    assert.ok(fm, "frontmatter present");
    assert.equal(fm.name, s);
    assert.ok(fm.description && fm.description.length > 40, "a description");
    assert.ok(!("model" in fm), "the orchestrator passes the model at dispatch");
  });
  test(`skills/${s}/ATTRIBUTION.md: MIT, the copyright line, the full permission notice and the source path`, () => {
    const t = read(join(dir, "ATTRIBUTION.md"));
    assert.match(t, /MIT License/);
    assert.ok(t.includes("Copyright (c) 2025 Jesse Vincent"), "copyright line");
    assert.ok(t.includes("Permission is hereby granted, free of charge, to any person obtaining a copy of this software"), "grant");
    assert.ok(t.includes("The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."), "condition");
    assert.ok(t.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'), "warranty disclaimer");
    assert.ok(t.includes("IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE"), "liability disclaimer");
    const upstream = s === "sdd" ? "subagent-driven-development" : s;
    assert.ok(t.includes(`skills/${upstream}/`), "source path");
  });
  test(`skills/${s}/CHANGES.md: names the upstream skill and lists numbered edits`, () => {
    const t = read(join(dir, "CHANGES.md"));
    assert.match(t, /^# Changes from the upstream /);
    assert.ok((t.match(/^\d+\. /gm) ?? []).length >= 5, "numbered edits");
    assert.match(t, /SKILL\.md/);
  });
  for (const p of skillDocs(s)) {
    const label = rel(p);
    const text = read(p);
    checkCommon(label, text);
    test(`${label}: every {{placeholder}} it names is known`, () => {
      for (const m of text.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(KNOWN_PLACEHOLDERS.has(m[1]), `unknown placeholder {{${m[1]}}}`);
    });
  }
}

test("skills: no upstream specs or plans folder path remains anywhere", () => {
  const needle = ["docs", "superpowers"].join("/");
  for (const p of walk(skillsRoot)) assert.ok(!read(p).includes(needle), `${rel(p)} names ${needle}`);
});

test("skills: example configs' neverHandToAgents entries are not named in any skill file", () => {
  const entries = [];
  for (const f of readdirSync(join(root, "examples")).filter((x) => x.endsWith(".json"))) entries.push(...(JSON.parse(readFileSync(join(root, "examples", f), "utf8")).secrets?.neverHandToAgents ?? []));
  assert.ok(entries.length > 0);
  for (const p of walk(skillsRoot)) for (const e of entries) assert.ok(!read(p).includes(e), `${rel(p)} names ${e}`);
});

test("writing-plans: every task carries a Depends on line and a Files block, the parser's refusals are named", () => {
  const t = read(join(skillsRoot, "writing-plans", "SKILL.md"));
  assert.match(t, /Depends on/);
  assert.match(t, /every task MUST carry a `\*\*Depends on:\*\*` line/i);
  assert.match(t, /\*\*Depends on:\*\* none/);
  assert.match(t, /`\*\*Files:\*\*` block/);
  assert.match(t, /Backticked paths only/);
  assert.match(t, /REQUIRED SUB-SKILL: [^\n]*sfactory:sdd/);
  assert.ok(!/executing-plans|Which approach\?/.test(t), "the execution handoff offers nothing");
  assert.match(t, /sfactory independence tasks <record\.plan>/);
  assert.match(t, /sfactory job set <JOB> awaiting-approval/);
  assert.match(t, /inside code/);
});

test("brainstorming: the brief goes to record.brief, stories first, questionnaire, no visual companion", () => {
  const t = read(join(skillsRoot, "brainstorming", "SKILL.md"));
  assert.match(t, /record\.brief/);
  assert.match(t, /record\.stories/);
  assert.match(t, /plan\/questionnaire\.md/);
  assert.match(t, /sfactory commit --cwd <checkout> --holder <JOB>/);
  assert.match(t, /sfactory job set <JOB> awaiting-approval/);
  assert.match(t, /sfactory:writing-plans/);
  assert.ok(!/visual companion|visual-companion|start-server/i.test(t), "the visual companion is removed");
});

test("sdd: roles by mode, the job folder, the cap, the judge, and every Codex placeholder rendered", () => {
  const t = read(join(skillsRoot, "sdd", "SKILL.md"));
  for (const s of ["sfactory codex exec", "sfactory codex review", "sfactory:implementer", "sfactory:spec-reviewer", "sfactory:code-reviewer", "sfactory:judge", "sfactory:triage",
    "limits.taskRounds", "tasks/<n>/brief.md", "tasks/<n>/report.md", "tasks/<n>/review.md", "reviews/<k>-<stage>.md", "git -C <WORKTREE> status --porcelain", "task wrote outside its declared files",
    "sfactory independence tasks <PLAN>", "sfactory suite --cwd <WORKTREE> --job <JOB>", "sfactory commit --cwd <WORKTREE> --holder <JOB>", "per-dispatch effort cannot be set"])
    assert.ok(t.includes(s), `names ${s}`);
  for (const p of KNOWN_PLACEHOLDERS) assert.ok(t.includes(`{{${p}}}`), `renders {{${p}}}`);
  assert.ok(!/requesting-code-review|finishing-a-development-branch|sdd-workspace|review-package/.test(t), "upstream skills and scripts are not referenced");
  // Every field a static agent's body says the dispatch message supplies is named in the skill.
  for (const a of ["implementer", "spec-reviewer", "code-reviewer", "judge", "triage"]) {
    const fields = /supplies these fields: ([^\n]*?)\. /.exec(read(join(root, "agents", `${a}.md`)))?.[1] ?? "";
    const names = fields.split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean);
    assert.ok(names.length >= 6, `${a}: fields read`);
    for (const f of names) assert.ok(t.includes(f), `${a}: field ${f}`);
  }
});

/** Sub-verbs and flags the CLI defines (src/commands/*); a skill may name only these. */
const SUBS = {
  job: Object.keys(actions).filter((k) => k !== "requestChanges"),
  codex: ["exec", "review"], independence: ["milestones", "tasks"], worktree: ["cut", "remove", "base"],
  lock: ["acquire", "release", "status", "clear"], services: ["up", "down", "status"], ports: ["allocate", "free"], cost: ["add", "show"],
};
const FLAGS = {
  commit: ["cwd", "holder", "m", "message"], suite: ["cwd", "job", "log"], push: ["cwd"], fixcard: [], doctor: [], board: ["port", "demo", "once"],
  codex: ["cwd", "profile", "out", "sandbox", "job", "stage", "model", "base", "commit"], independence: ["max", "allow-undeclared"],
  job: ["reason", "by", "json", "pending", "yes", "no", "notes"], cost: ["stage", "agent", "model", "in", "out", "cache-read", "usd"],
  worktree: ["slug", "force", "no-fetch"], lock: ["holder", "token", "wait", "pid", "stale-ms", "durable", "guard"], services: [], ports: [],
};

test("skills: every sfactory command line uses a registered verb, a defined sub-verb and defined flags", () => {
  let seen = 0;
  for (const s of SKILLS) for (const p of skillDocs(s)) {
    for (const m of read(p).matchAll(/`(sfactory [^`]+)`/g)) {
      const words = m[1].split(/\s+/);
      const verb = words[1];
      assert.ok(commands.has(verb), `${rel(p)}: unknown command "sfactory ${verb}"`);
      if (SUBS[verb] && words[2] && /^[a-z]/.test(words[2])) assert.ok(SUBS[verb].includes(words[2]), `${rel(p)}: unknown "sfactory ${verb} ${words[2]}"`);
      for (const w of words) {
        const f = /^--([a-z-]+)/.exec(w)?.[1];
        if (f) assert.ok((FLAGS[verb] ?? []).includes(f), `${rel(p)}: "sfactory ${verb}" has no --${f}`);
      }
      seen++;
    }
  }
  assert.ok(seen > 20, `only ${seen} command lines found`);
});

const hasBash = (() => { try { execFileSync("bash", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
test("sdd/scripts/task-brief: one task, up to the next heading of its level, fences honoured, exact ids", { skip: !hasBash && "bash not found" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-brief-"));
  try {
    const plan = join(dir, "plan.md");
    writeFileSync(plan, ["# P", "", "### Task 1: one", "", "````md", "```", "### Task 2: fake", "```", "````", "end one", "", "### Task 2: two", "two", "", "### Task 3a: three-a", "x", "", "## Self-review", "tail", ""].join("\n"));
    const run = (n, out) => execFileSync("bash", [join(skillsRoot, "sdd", "scripts", "task-brief"), plan, n, out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    run("1", join(dir, "t", "1", "brief.md"));
    assert.equal(read(join(dir, "t", "1", "brief.md")), ["### Task 1: one", "", "````md", "```", "### Task 2: fake", "```", "````", "end one", "", ""].join("\n"));
    run("3a", join(dir, "3a.md"));
    assert.equal(read(join(dir, "3a.md")), ["### Task 3a: three-a", "x", "", ""].join("\n"));
    assert.throws(() => run("3", join(dir, "3.md")), "Task 3 is not Task 3a");
    assert.throws(() => run("1; rm", join(dir, "bad.md")), "a bad task id is refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
