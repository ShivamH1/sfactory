import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validateConfig } from "../src/config.mjs";
const dir = new URL("../examples/", import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith(".config.json")))
  test(`examples: ${f} is valid`, () => assert.deepEqual(validateConfig(JSON.parse(readFileSync(new URL(f, dir), "utf8"))), []));
