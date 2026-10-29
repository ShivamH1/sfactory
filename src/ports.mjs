import { createServer } from "node:net";
import { fail } from "./errors.mjs";
import { listJobs } from "./store.mjs";
import { withLock } from "./lock.mjs";

/** Binds port on host and resolves "free", "busy" (EADDRINUSE/EACCES/other) or "unavailable" (address family absent). */
export function tryBind(port, host) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", (e) => res(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT" ? "unavailable" : "busy"));
    s.listen(port, host, () => s.close(() => res("free")));
  });
}

/**
 * Free means free on 127.0.0.1, ::1, :: and 0.0.0.0. A family the machine lacks is skipped, not busy.
 * All four are tried: on Windows a wildcard holder does not stop a bind on :: or on a loopback address.
 */
export async function isFree(port) {
  for (const host of ["127.0.0.1", "::1", "::", "0.0.0.0"]) if ((await tryBind(port, host)) === "busy") return false;
  return true;
}

/** `persist(ports)` runs inside the lock, so the block is recorded before the next allocator reads the held set. */
export function allocate(c, jobId, persist) {
  return withLock(c, "ports", { holder: `ports:${process.pid}`, waitMs: 10_000 }, async () => {
    const ports = await allocateUnlocked(c, jobId);
    if (persist) await persist(ports);
    return ports;
  });
}
async function allocateUnlocked(c, jobId) {
  const { base, step, names } = c.ports;
  if (names.length > step) fail("INVALID_CONFIG", `ports.names has ${names.length} names but ports.step is ${step}; blocks would overlap`);
  const held = new Set();
  for (const j of listJobs(c)) {
    if (j.id === jobId || !j.ports || j.stage === "merged") continue;
    for (const [k, v] of Object.entries(j.ports)) if (k !== "block" && Number.isInteger(v)) held.add(v);
    if (Number.isInteger(j.ports.block)) held.add(j.ports.block);
  }
  for (let k = 0; k < 100; k++) {
    const block = base + k * step;
    if (block + names.length - 1 > 65535) break;
    const ports = { block };
    let ok = true;
    for (let i = 0; i < names.length; i++) {
      ports[names[i]] = block + i;
      if (held.has(block + i) || !(await isFree(block + i))) { ok = false; break; }
    }
    if (ok) return ports;
  }
  fail("NO_PORTS", `no free port block from ${base} in steps of ${step}`);
}
export const substitute = (s, ports) => String(s).replace(/\{port\.([a-z0-9_-]+)\}/gi, (_, n) => (Object.hasOwn(ports, n) && ports[n] != null ? String(ports[n]) : `{port.${n}}`));
