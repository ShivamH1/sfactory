#!/usr/bin/env node
// Parse every plan (*.md) in a directory and print one row per file:
// "file | tasks | code", where code is "ok" or the parser's error code, then a
// summary line. Exits 0 when the directory was read, whatever the plans say.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePlan } from "../src/plan.mjs";
import { SfactoryError } from "../src/errors.mjs";

export function acceptancePlans(dir) {
  const rows = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((file) => {
    try {
      const p = parsePlan(readFileSync(join(dir, file), "utf8"));
      return { file, tasks: p.tasks.length, code: "ok" };
    } catch (e) {
      if (!(e instanceof SfactoryError)) throw e;
      return { file, tasks: "-", code: e.code };
    }
  });
  const ok = rows.filter((r) => r.code === "ok").length;
  const byCode = {};
  for (const r of rows) if (r.code !== "ok") byCode[r.code] = (byCode[r.code] ?? 0) + 1;
  const detail = Object.entries(byCode).sort().map(([c, n]) => `${n} ${c}`).join(", ");
  const lines = ["file | tasks | code", ...rows.map((r) => `${r.file} | ${r.tasks} | ${r.code}`), `${rows.length} plans: ${ok} parse / ${rows.length - ok} fail${detail ? ` (${detail})` : ""}`];
  return { rows, ok, fail: rows.length - ok, text: lines.join("\n") + "\n" };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write("usage: node scripts/acceptance-plans.mjs <dir>\n"); process.exit(2); }
  process.stdout.write(acceptancePlans(resolve(dir)).text);
}
