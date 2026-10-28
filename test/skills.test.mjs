import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_PLACEHOLDERS, PLACEHOLDERS } from "../src/placeholders.mjs";
import { READ_ONLY_TOOLS, checkCommon, selfTest } from "./skills.helpers.mjs";
import { main as _registerCommands } from "../src/cli.mjs"; // importing cli.mjs registers every command module
import { commands } from "../src/registry.mjs";
import { usages } from "../src/registry.mjs";

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
  assert.match(t, /sfactory:writing-plans/);
  assert.ok(!/visual companion|visual-companion|start-server/i.test(t), "the visual companion is removed");
});

test("planning happens in the card's worktree: brainstorming and writing-plans write and commit with --cwd <WORKTREE>", () => {
  for (const s of ["brainstorming", "writing-plans"]) {
    const t = read(join(skillsRoot, s, "SKILL.md"));
    assert.match(t, /\*\*WORKTREE\*\*/, `${s}: WORKTREE is an input`);
    assert.match(t, /sfactory commit --cwd <WORKTREE> --holder <JOB>/, `${s}: commits in the worktree`);
    assert.ok(!t.includes("<checkout>"), `${s}: no other checkout`);
    assert.match(t, /cut when the card enters `planning`/, `${s}: the worktree exists from planning`);
  }
  assert.match(read(join(skillsRoot, "brainstorming", "SKILL.md")), /sfactory job set <JOB> awaiting-approval/);
  assert.match(read(join(skillsRoot, "sdd", "SKILL.md")), /cut when the card entered `planning`/);
});

test("every agent start and finish is a job touch; no agents.log", () => {
  const t = read(join(skillsRoot, "sdd", "SKILL.md"));
  assert.match(t, /sfactory job touch <JOB> --note "<start\|finish> <role> task <n> <alias\|profile>"/);
  assert.ok(!t.includes("agents.log"), "the agents.log stand-in is gone");
  for (const s of ["brainstorming", "writing-plans"]) assert.match(read(join(skillsRoot, s, "SKILL.md")), /sfactory job touch <JOB> --note/, `${s}: touches the job`);
});

test("sdd: the branch fixer is chosen per design §3 and the branch cap has one rule", () => {
  const t = read(join(skillsRoot, "sdd", "SKILL.md"));
  const fixing = t.slice(t.indexOf("**Fixing.**"));
  assert.ok(t.indexOf("**Fixing.**") > 0, "a Fixing paragraph");
  assert.match(fixing, /`claude` and `mixed`: a fresh `sfactory:implementer`/);
  assert.match(fixing, /`codex`: `sfactory codex exec`/);
  assert.match(t, /Never move the card to `verifying` while the latest judge verdict is ❌/);
  assert.match(t, /FIX_ROUNDS_EXHAUSTED[^\n]*sfactory job park <JOB>/);
  assert.ok(!/Residual findings at the cap are adjudicated/.test(t), "no second rule at the branch cap");
  assert.match(t, /The judge — the vendor that did not write the code, except in `codex` mode/);
  for (const m of t.matchAll(/`(sfactory codex review [^`]*)`/g)) assert.match(m[1], /--stage /, `codex review records its stage: ${m[1]}`);
  for (const m of t.matchAll(/`(sfactory codex exec [^`]*)`/g)) assert.match(m[1], /--stage /, `codex exec records its stage: ${m[1]}`);
  assert.match(t, /P=\(/, "the task paths are a bash array");
  assert.match(t, /"\$\{P\[@\]\}"/, "and expanded quoted");
  assert.match(t, /suite-<r>\.log/);
  assert.ok(!t.includes("suite-0.log"), "one suite log name pattern");
  assert.match(t, /untracked artefacts? (?:the|a) suite leaves/i);
  assert.match(t, /BLOCKED[^\n]*Codex/);
});

test("sdd: roles by mode, the job folder, the cap, the judge, and every Codex placeholder rendered", () => {
  const t = read(join(skillsRoot, "sdd", "SKILL.md"));
  for (const s of ["sfactory codex exec", "sfactory codex review", "sfactory:implementer", "sfactory:spec-reviewer", "sfactory:code-reviewer", "sfactory:judge", "sfactory:triage",
    "limits.taskRounds", "tasks/<n>/brief.md", "tasks/<n>/report.md", "tasks/<n>/review.md", "reviews/<k>-<stage>.md", "git -C <WORKTREE> status --porcelain", "task wrote outside its declared files",
    "sfactory independence tasks <PLAN>", "sfactory suite --cwd <WORKTREE> --job <JOB>", "sfactory commit --cwd <WORKTREE> --holder <JOB>", "per-dispatch effort cannot be set"])
    assert.ok(t.includes(s), `names ${s}`);
  for (const p of KNOWN_PLACEHOLDERS) assert.ok(t.includes(`{{${p}}}`), `renders {{${p}}}`);
  assert.ok(!/requesting-code-review|finishing-a-development-branch|sdd-workspace|review-package/.test(t), "upstream skills and scripts are not referenced");
});

/** The field names an agent's body says the dispatch message supplies (parentheticals dropped). */
const agentFields = (a) => (/supplies these fields: ([^\n]*?)\. /.exec(read(join(root, "agents", `${a}.md`)))?.[1] ?? "")
  .replace(/\([^)]*\)/g, "").split(",").map((x) => x.trim()).filter(Boolean);

test("sdd: every dispatch block carries its agent's full field set", () => {
  const t = read(join(skillsRoot, "sdd", "SKILL.md"));
  // A dispatch block may sit inside a list item, indented: "   ```" / "   # sfactory:judge" / … / "   ```".
  const blocks = [...t.matchAll(/^( *)```\n\1# (sfactory:[a-z-]+)( re-review)?\n([\s\S]*?)^\1```/gm)].map((m) => [m[0], m[2], m[3], m[4]]);
  const byAgent = new Map();
  for (const [, agent, rereview, body] of blocks) {
    const name = agent.slice("sfactory:".length);
    const fields = agentFields(name);
    assert.ok(fields.length >= 6, `${name}: fields read`);
    const present = new Set([...body.matchAll(/^ *([A-Z_]+): /gm)].map((m) => m[1]));
    for (const f of fields) {
      if (f === "FINDINGS" && !rereview) continue; // a re-review only
      assert.ok(present.has(f), `${agent}${rereview ?? ""}: field ${f}`);
    }
    byAgent.set(name, (byAgent.get(name) ?? 0) + 1);
  }
  for (const a of ["implementer", "spec-reviewer", "code-reviewer", "judge", "triage"]) assert.ok(byAgent.get(a) > 0, `a dispatch block for sfactory:${a}`);
  assert.ok(blocks.some((b) => b[1] === "sfactory:code-reviewer" && b[2]), "a code-reviewer re-review block");
});

/** The `sfactory …` command lines of a Markdown text: single-backtick spans, and lines inside fenced code that start with "sfactory ". */
function commandLines(text) {
  const out = [];
  for (const m of text.matchAll(/(?<!`)`(sfactory [^`\n]+)`(?!`)/g)) out.push(m[1]);
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
      else if (/^\s*sfactory /.test(line)) out.push(line.trim());
    } else if (f) fence = f;
  }
  return out;
}

/** Problems of one command line against the CLI's own usage tables (src/commands/*, registered with each command). */
function commandProblems(line) {
  const words = line.split(/\s+/);
  const verb = words[1];
  if (!commands.has(verb)) return [`unknown command "sfactory ${verb}"`];
  const u = usages.get(verb);
  if (!u) return [`"sfactory ${verb}" has no usage table`];
  const out = [];
  if (u.verbs && words[2] && /^[a-z]/.test(words[2]) && !u.verbs.includes(words[2])) out.push(`unknown "sfactory ${verb} ${words[2]}"`);
  for (const w of words) {
    if (w === "--") break; // the rest are paths (sfactory commit … -- <paths>)
    const f = /^--([a-z-]+)/.exec(w)?.[1];
    if (f && !u.flags.includes(f)) out.push(`"sfactory ${verb}" has no --${f}`);
  }
  return out;
}

test("commandLines: backtick spans and fenced lines are read; problems name bad verbs, sub-verbs and flags", () => {
  const t = ["Run `sfactory job show <JOB>` first.", "", "```bash", "sfactory job bogus m-1", "  sfactory commit --cwd a --m \"x\" -- --not-a-flag.txt", "```", "", "sfactory job set outside a fence"].join("\n");
  assert.deepEqual(commandLines(t), ["sfactory job show <JOB>", "sfactory job bogus m-1", "sfactory commit --cwd a --m \"x\" -- --not-a-flag.txt"]);
  assert.deepEqual(commandProblems("sfactory job bogus m-1"), ['unknown "sfactory job bogus"']);
  assert.deepEqual(commandProblems("sfactory suite --cwd a --nope"), ['"sfactory suite" has no --nope']);
  assert.deepEqual(commandProblems("sfactory commit --cwd a --m \"x\" -- --not-a-flag.txt"), []);
  assert.deepEqual(commandProblems("sfactory nosuch"), ['unknown command "sfactory nosuch"']);
});

test("skills: every sfactory command line, in backticks or in a fence, uses a registered verb, a defined sub-verb and defined flags", () => {
  let seen = 0, fenced = 0;
  for (const s of [...SKILLS, "sfactory"]) for (const p of skillDocs(s)) {
    const text = read(p);
    for (const line of commandLines(text)) {
      assert.deepEqual(commandProblems(line), [], `${rel(p)}: ${line}`);
      seen++;
      if (!text.includes("`" + line + "`")) fenced++;
    }
  }
  assert.ok(seen > 20, `only ${seen} command lines found`);
  assert.ok(fenced > 0, "no fenced command line was read");
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
    // A plan saved with CRLF line ends: the task is found and the brief carries no carriage returns.
    const crlf = join(dir, "crlf.md");
    writeFileSync(crlf, ["# P", "", "### Task 1: one", "body", "", "### Task 2: two", "x", ""].join("\r\n"));
    execFileSync("bash", [join(skillsRoot, "sdd", "scripts", "task-brief"), crlf, "1", join(dir, "c1.md")], { stdio: ["ignore", "pipe", "pipe"] });
    const c1 = readFileSync(join(dir, "c1.md"), "latin1");
    assert.equal(c1, ["### Task 1: one", "body", "", ""].join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex-implement: Codex runs focused tests only; the full suite and its count are the orchestrator's", () => {
  const t = read(join(root, "prompts", "codex-implement.md"));
  assert.ok(!t.includes("run the full suite once before committing"), "Codex never runs the full suite");
  assert.match(t, /run only the focused tests \(\{\{test_command\}\}\)/i);
  assert.match(t, /the orchestrator runs the full suite and adds its count/);
  assert.match(PLACEHOLDERS.test_command.doc, /focused tests/);
  assert.match(PLACEHOLDERS.test_command.doc, /orchestrator runs the full suite/);
});

// Task 8: the orchestrator skill (skills/sfactory/SKILL.md) - original to sfactory, so no ATTRIBUTION or CHANGES.
const ORCH = join(skillsRoot, "sfactory", "SKILL.md");
const orch = existsSync(ORCH) ? read(ORCH) : "";
checkCommon("skills/sfactory/SKILL.md", orch);

test("skills/sfactory/SKILL.md: exists, frontmatter names the skill, describes it and lists its tools", () => {
  assert.ok(existsSync(ORCH), "skills/sfactory/SKILL.md");
  const { fm } = split(orch);
  assert.ok(fm, "frontmatter present");
  assert.equal(fm.name, "sfactory");
  assert.ok(fm.description && /\/sfactory/.test(fm.description) && fm.description.length > 80, "a description naming /sfactory");
  assert.ok(!("model" in fm), "no model in the frontmatter");
  for (const t of ["Bash(sfactory *)", "Bash(sfactory-* *)", "Bash(git *)", "Bash(bash *)", "Read", "Write", "Agent"])
    assert.ok(fm["allowed-tools"].split(",").map((x) => x.trim()).includes(t), `allowed-tools has ${t}`);
  for (const m of orch.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(KNOWN_PLACEHOLDERS.has(m[1]), `unknown placeholder {{${m[1]}}}`);
});

/** Design §10's eleven commands (stop and clean share a row there), plus merged, each with the CLI line its row runs. */
const ORCH_COMMANDS = {
  init: ["sfactory init"], doctor: ["sfactory doctor"],
  add: ['sfactory job add milestone "<title>"', 'sfactory job add fix "<title>"'],
  run: ["sfactory job list --json", "sfactory job resume <id>"],
  approve: ["sfactory job approve <id>"], answer: ["sfactory job answer <id>"],
  parallel: ["sfactory job parallel <id> --yes", "sfactory job parallel <id> --no"],
  status: ["sfactory job list"], board: ["sfactory board"],
  rework: ['sfactory job rework <id> --notes "<notes>"'],
  stop: ["sfactory job stop <id>"], clean: ["sfactory worktree remove <id>"],
  merged: ["sfactory job merged <id>"],
};

test("skills/sfactory: every design §10 command has a row naming the CLI line it runs", () => {
  const rows = orch.split("\n").filter((l) => /^\| `\/sfactory /.test(l));
  for (const [cmd, lines] of Object.entries(ORCH_COMMANDS)) {
    const row = rows.filter((r) => r.startsWith("| `/sfactory " + cmd + "`") || r.startsWith("| `/sfactory " + cmd + " "));
    assert.ok(row.length > 0, `a row for /sfactory ${cmd}`);
    for (const l of lines) assert.ok(row.some((r) => r.includes("`" + l)), `/sfactory ${cmd} runs \`${l}\``);
  }
  // design §10's own list, read from the design: every command it names has a row here.
  const design = read(join(root, "docs", "DESIGN.md"));
  const sec = design.slice(design.indexOf("## 10. Commands"), design.indexOf("## 11."));
  const named = new Set([...sec.matchAll(/`\/sfactory ([a-z]+)/g)].map((m) => m[1]));
  assert.equal(named.size, 12, "design §10 names eleven rows' twelve verbs");
  for (const c of named) assert.ok(c in ORCH_COMMANDS, `design §10's ${c} is mapped`);
});

test("skills/sfactory: design §12 is quoted verbatim", () => {
  const design = read(join(root, "docs", "DESIGN.md"));
  const sec = design.slice(design.indexOf("## 12. Guardrails"), design.indexOf("## 13."));
  const bullets = sec.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 8);
  for (const b of bullets) assert.ok(orch.includes(b), `quotes: ${b}`);
});

test("skills/sfactory: every stage it moves a card to is a stage the state machine can reach", async () => {
  const { STAGES, TRANSITIONS } = await import("../src/job.mjs");
  const reachable = new Set(Object.values(TRANSITIONS).flat());
  const targets = [...orch.matchAll(/sfactory job set <[a-z]+> ([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(targets.length >= 6, "the skill scripts its moves");
  for (const t of targets) { assert.ok(STAGES.includes(t), `stage ${t}`); assert.ok(reachable.has(t), `${t} is the target of some edge`); }
  for (const t of ["planning", "awaiting-approval", "building", "verifying", "fixing", "pushing", "pushed"]) assert.ok(targets.includes(t), `moves to ${t}`);
});

test("skills/sfactory: the rulings, the stops and the amendment's rules are stated", () => {
  for (const s of ["never merges", "limits.parallelMilestones", "--pending parallel", "sfactory independence milestones", "Parallel tasks need no ask",
    "main checkout", "Request changes", "plan/changes-<k>.md", "`sfactory job touch <id> --note \"<start|finish> <role> <alias|profile>\"`",
    "Per-dispatch effort cannot be set", "Codex never commits", "git -C <WORKTREE> status --porcelain", "task wrote outside its declared files",
    "reviews/<k>-<stage>.md", "FIX_ROUNDS_EXHAUSTED", "NOT ADDRESSED", "sfactory lock acquire live --holder <id>", "sfactory services up <id>",
    "sfactory services down <id>", "sfactory push --cwd <WORKTREE>", "pr.md", "sfactory fixcard <WORKTREE>/<record.plan>",
    "sfactory independence tasks <WORKTREE>/<record.plan> --max <limits.parallelTasks>", "sfactory cost add", "`stops`", "not available yet",
    "sfactory:sdd", "sfactory:brainstorming", "writing-plans"])
    assert.ok(orch.includes(s), `names ${s}`);
  // The worktree is cut on entering planning, before brainstorming.
  const backlog = orch.indexOf("**backlog**"), cutAt = orch.indexOf("sfactory worktree cut <id>"), brainstorm = orch.indexOf("**planning**");
  assert.ok(backlog > 0 && cutAt > backlog && cutAt < brainstorm, "the cut is in the backlog -> planning step");
  for (const s of ["awaiting-approval", "decision-needed", "verifying", "pushing"]) assert.match(orch.slice(orch.indexOf("## 8. Stops")), new RegExp(s));
});

/** The shell programs a Markdown text runs: backtick spans and fenced lines that start with a known program. */
const PROGRAMS = ["sfactory", "git", "bash", "sh", "sleep", "agent-browser", "node", "npm", "npx", "pnpm", "codex", "gh", "curl"];
function programsRun(text) {
  const out = new Set();
  const first = (s) => /^([a-z][a-z-]*)(?=\s|$)/.exec(s.trim())?.[1];
  // A one-word span (`codex`, the mode) is a name, not a command line.
  for (const m of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) { const w = /\s\S/.test(m[1].trim()) ? first(m[1]) : null; if (PROGRAMS.includes(w)) out.add(w); }
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null; else { const w = first(line); if (PROGRAMS.includes(w)) out.add(w); } }
    else if (f) fence = f;
  }
  return out;
}

test("skills/sfactory: allowed-tools covers every program the orchestrator and the skills it runs call", () => {
  const allowed = split(orch).fm["allowed-tools"].split(",").map((x) => x.trim());
  const used = new Set();
  for (const p of [ORCH, ...SKILLS.flatMap(skillDocs)]) for (const w of programsRun(read(p))) used.add(w);
  for (const w of ["sfactory", "git", "bash"]) assert.ok(used.has(w), `${w} is read from the skills`);
  for (const w of used) assert.ok(allowed.includes(`Bash(${w} *)`), `allowed-tools covers ${w}`);
  assert.deepEqual([...programsRun("Run `git -C x status`, `sfactory doctor`, not `sfactory:sdd` or the `codex` mode; `codex exec x` counts.\n```bash\nbash run.sh\n```")].sort(), ["bash", "codex", "git", "sfactory"]);
});
