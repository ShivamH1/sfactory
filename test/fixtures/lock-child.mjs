// Acquires with pid null like the CLI (a winner that exits must not look dead to the others). Plain script, not a test: `node lock-child.mjs <stateDir> <holder>` prints GOT or HELD. With no arguments it exits at once.
import { acquire } from "../../src/lock.mjs";
const [stateDir, holder] = process.argv.slice(2);
if (stateDir) {
  try { await acquire({ stateDir, limits: { lockStaleMs: 3_600_000 } }, "race", { holder, waitMs: 0, pid: null }); console.log("GOT"); }
  catch (e) { console.log(e.code === "LOCK_HELD" ? "HELD" : `ERR ${e.code} ${e.message}`); }
}
