import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main as _registerCommands } from "../src/cli.mjs"; // importing cli.mjs registers every command module
import { commandLines, commandProblems } from "./skills.helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

for (const f of ["README.md", "INSTALL.md"]) {
  test(`${f}: every sfactory command line uses a registered verb, a defined sub-verb and defined flags`, () => {
    const lines = commandLines(read(f)).filter((l) => !/^sfactory (version|<command>)/.test(l));
    assert.ok(lines.length > 3, `only ${lines.length} command lines`);
    for (const line of lines) assert.deepEqual(commandProblems(line), [], `${f}: ${line}`);
  });
}

test("docs: no company, product or machine-specific words in the shipped examples or the design", () => {
  for (const f of [...readdirSync(join(root, "examples")).filter((n) => n.endsWith(".json")).map((n) => `examples/${n}`), "docs/DESIGN.md", "README.md", "INSTALL.md"]) {
    const t = read(f);
    assert.ok(!/thrive|truworth|C:\/tw-wt/i.test(t), f);
  }
});

test("README: the board as built: no pulsing card, Done collapses, and the log views warn about secrets", () => {
  const t = read("README.md");
  assert.equal(/puls/i.test(t), false, "no card pulses any more");
  assert.match(t, /\*\*Done\*\* shows the newest 8/);
  assert.match(t, /Show all N/);
  assert.match(t, /remembered per viewer|remembers it per viewer/);
  const local = t.split("- **Local only:**")[1].split("\n")[0];
  assert.match(local, /whatever agents printed/);
  assert.match(local, /keep secrets out of agents' output/);
});

test("versions: package.json and the plugin manifest agree", () => {
  assert.equal(JSON.parse(read("package.json")).version, JSON.parse(read(".claude-plugin/plugin.json")).version);
});
