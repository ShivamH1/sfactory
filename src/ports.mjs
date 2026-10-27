import { createServer } from "node:net";
import { fail } from "./errors.mjs";
import { listJobs } from "./store.mjs";

export function isFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}
export async function allocate(c, jobId) {
  const { base, step, names } = c.ports;
  const held = new Set(listJobs(c).filter((j) => j.id !== jobId && j.ports && j.stage !== "merged").map((j) => j.ports.block));
  for (let k = 0; k < 100; k++) {
    const block = base + k * step;
    if (held.has(block)) continue;
    const ports = { block };
    let ok = true;
    for (let i = 0; i < names.length; i++) { ports[names[i]] = block + i; if (!(await isFree(block + i))) { ok = false; break; } }
    if (ok) return ports;
  }
  fail("NO_PORTS", `no free port block from ${base} in steps of ${step}`);
}
export const substitute = (s, ports) => String(s).replace(/\{port\.([a-z0-9_-]+)\}/gi, (_, n) => (ports[n] != null ? String(ports[n]) : `{port.${n}}`));
