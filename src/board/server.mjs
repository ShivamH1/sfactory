import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { buildSnapshot, jobView } from "./snapshot.mjs";
import { actions } from "../job-actions.mjs";
import { readJobFile, readJob } from "../store.mjs";
import { SfactoryError } from "../errors.mjs";

const MAX_BODY = 64 * 1024;
const ROUTES = { approve: "approve", answer: "answer", parallel: "parallel", merged: "merged", stop: "stop", rework: "rework", "request-changes": "requestChanges" };
const STATUS = { ILLEGAL_TRANSITION: 409, ANSWER_REQUIRED: 409, APPROVAL_REQUIRED: 409, BAD_KIND: 400, JOB_BUSY: 409, JOB_NOT_FOUND: 404, BAD_ARGS: 400, BAD_ID: 400, BAD_PATH: 400 };
const PLACEHOLDER = "<!doctype html><html><head><meta charset=\"utf-8\"><title>board</title></head><body><p>The board page is not installed.</p></body></html>";

function loadPage() {
  try { return readFileSync(new URL("../../board/dashboard.html", import.meta.url), "utf8"); } catch { return PLACEHOLDER; }
}

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");

function respondError(res, e) {
  if (e instanceof SfactoryError) {
    const status = STATUS[e.code] ?? 500;
    return sendJson(res, status, status === 500 ? { code: e.code } : { code: e.code, message: e.message });
  }
  if (e && e.code === "TOO_LARGE") return sendJson(res, 413, { code: "TOO_LARGE" });
  return sendJson(res, 500, { code: "INTERNAL" });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { code: "TOO_LARGE" });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new SfactoryError("BAD_ARGS", "the body must be a JSON object");
  let v;
  try { v = JSON.parse(text); } catch { throw new SfactoryError("BAD_ARGS", "the body is not JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SfactoryError("BAD_ARGS", "the body must be a JSON object");
  return v;
}

export function startBoard(c, { port = c.board.port, host = "127.0.0.1", demoDir = null, log = console.error } = {}) {
  const page = loadPage();
  const view = demoDir ? { ...c, stateDir: demoDir } : c;
  let boundPort = null;

  const server = createServer(async (req, res) => {
    try {
      const allowed = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
      if (!allowed.includes(req.headers.host ?? "")) return sendJson(res, 403, { code: "BAD_HOST" });
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { throw new SfactoryError("BAD_ARGS", "malformed encoding in the path"); } });

      if (req.method === "GET" && url.pathname === "/") return send(res, 200, page, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/jobs.json") return sendJson(res, 200, buildSnapshot(view, { demo: !!demoDir }));

      if (req.method === "GET" && parts.length === 3 && parts[0] === "jobs" && parts[2] === "file") {
        const rel = url.searchParams.get("path") ?? "";
        readJob(view, parts[1]);
        if (!/\.(md|log)$/.test(rel)) return sendJson(res, 400, { code: "BAD_PATH" });
        const text = readJobFile(view, parts[1], rel);
        if (text === null) return sendJson(res, 404, { code: "NOT_FOUND" });
        return send(res, 200, text, "text/plain; charset=utf-8");
      }

      if (req.method === "POST" && parts.length === 3 && parts[0] === "jobs" && Object.hasOwn(ROUTES, parts[2])) {
        if (demoDir) return sendJson(res, 403, { code: "DEMO" });
        if (req.headers["x-sfactory-board"] !== "1") return sendJson(res, 403, { code: "NO_HEADER" });
        const body = await readBody(req);
        for (const k of ["text", "notes", "reason", "by"]) if (body[k] !== undefined && typeof body[k] !== "string") throw new SfactoryError("BAD_ARGS", `"${k}" must be a string`);
        if (body.yes !== undefined && typeof body.yes !== "boolean") throw new SfactoryError("BAD_ARGS", '"yes" must be true or false');
        const args = { id: parts[1], by: body.by?.trim() || "board" };
        for (const k of ["text", "notes", "yes", "reason"]) if (body[k] !== undefined) args[k] = body[k];
        // synchronous, under the job lock: nothing is awaited between here and the write
        const job = actions[ROUTES[parts[2]]](view, args);
        return sendJson(res, 200, { job: jobView(view, job) });
      }

      return sendJson(res, 404, { code: "NOT_FOUND" });
    } catch (e) {
      if (!(e instanceof SfactoryError)) log(`board: ${e?.code ?? e?.name ?? "error"}`);
      respondError(res, e);
      if (e && e.code === "TOO_LARGE") req.destroy(); // stop reading what the client is still sending
      return;
    }
  });

  return new Promise((resolve, reject) => {
    const onStartError = (e) => reject(e);
    server.once("error", onStartError);
    server.listen(port, host, () => {
      server.off("error", onStartError);
      server.on("error", (e) => log(`board: ${e?.code ?? "error"}`)); // after startup: log the code only, never crash
      boundPort = server.address().port;
      resolve({
        url: `http://127.0.0.1:${boundPort}/`,
        port: boundPort,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}
