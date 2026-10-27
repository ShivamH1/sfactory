// Plain script, not a test (it exits at once with no arguments).
//   node lock-child.mjs <stateDir> <holder> <startMs> [loop]
// Waits for startMs so children race together, acquires with its own pid, holds 1.5 s, prints GOT or HELD and logs `<token> <begin> <end>` to <stateDir>/intervals.log.
// With "loop": acquires and releases repeatedly for 1.5 s, checking that no other holder is inside at the same time,
// and prints "GOT <n> OVERLAP <m>".
import { mkdirSync, writeFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { acquire } from "../../src/lock.mjs";
const [stateDir, holder, start, mode] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (stateDir) {
  const c = { stateDir, limits: { lockStaleMs: 3_600_000 } };
  while (Date.now() < Number(start)) await sleep(1);
  if (mode === "loop") {
    const dir = join(stateDir, "inside");
    mkdirSync(dir, { recursive: true });
    let got = 0, overlap = 0;
    while (Date.now() < Number(start) + 1500) {
      let l;
      try { l = await acquire(c, "race", { holder, waitMs: 0 }); } catch (e) { if (e.code !== "LOCK_HELD") throw e; await sleep(1); continue; }
      got++;
      writeFileSync(join(dir, holder), "");
      await sleep(5);
      if (readdirSync(dir).length > 1) overlap++;
      rmSync(join(dir, holder));
      l.release();
    }
    console.log(`GOT ${got} OVERLAP ${overlap}`);
  } else {
    try {
      const l = await acquire(c, "race", { holder, waitMs: 0 });
      const at = () => performance.timeOrigin + performance.now();
      const began = at();
      await sleep(1500);
      appendFileSync(join(stateDir, "intervals.log"), `${l.token} ${began} ${at()}
`);
      console.log("GOT");
    }
    catch (e) { console.log(e.code === "LOCK_HELD" ? "HELD" : `ERR ${e.code} ${e.message}`); }
  }
}
