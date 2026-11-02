/** The Activity view's state, kept pure so the browser and the test suite run the same code. */
export const KEEP_EVENTS = 500;

/** One /activity.json answer folded in: events appended (the newest KEEP_EVENTS kept), cursor and running replaced. */
export function foldActivity(state, answer) {
  const events = [...(state?.events ?? []), ...(Array.isArray(answer?.events) ? answer.events : [])];
  return { events: events.slice(-KEEP_EVENTS), cursor: answer?.cursor ?? state?.cursor ?? null, running: Array.isArray(answer?.running) ? answer.running : [] };
}

/** One tail answer folded into a log view: appended when the server read from where we asked, replaced when it restarted (the file was replaced). */
export function foldTail(view, asked, answer) {
  const base = answer.from === asked ? (view?.text ?? "") : "";
  return { text: base + String(answer.text ?? ""), next: answer.next, size: answer.size };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const dur = (ms) => {
  if (!Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const GATE = {
  approve: "Approved", "request-changes": "Changes requested", answer: "Answered", merged: "Marked merged",
  rework: "Sent back to building", start: "Started", external: "Marked as running outside the factory",
};

/** One timeline row's words: a title, a quiet second line, and a tone (live, ok, bad, you, or none). */
export function describe(e) {
  switch (e?.kind) {
    case "stage":
      return e.from == null
        ? { title: `Created in ${e.to}`, sub: e.reason ?? null, tone: null }
        : { title: `Moved to ${e.to}`, sub: [`from ${e.from}`, e.reason].filter(Boolean).join(" · "), tone: null };
    case "gate": {
      const title = e.action === "parallel" ? (e.yes ? "Approved to run in parallel" : "Queued instead of running in parallel") : (GATE[e.action] ?? cap(String(e.action)));
      return { title, sub: e.by ? `by ${e.by}` : null, tone: "you" };
    }
    case "agent": {
      const who = `${cap(e.vendor)} ${e.role}`;
      const on = e.task ? ` on task ${e.task}` : "";
      if (e.phase === "start") return { title: `${who} started${on}`, sub: e.model ?? null, tone: "live" };
      if (e.ok === false) return { title: `${who} failed${on}`, sub: e.model ?? null, tone: "bad" };
      const verdict = e.verdict === "ok" ? ": ✓ Approved" : e.verdict === "fixes" ? ": ✕ Needs fixes" : "";
      return { title: `${who} finished${on}${verdict}`, sub: e.model ?? null, tone: e.verdict === "fixes" ? "bad" : e.verdict === "ok" ? "ok" : null };
    }
    case "suite": {
      if (e.phase === "start") return { title: "Suite started", sub: e.log ?? null, tone: "live" };
      const took = dur(e.durationMs);
      const title = e.ok ? `Suite passed${took ? ` in ${took}` : ""}` : `Suite failed${Number.isInteger(e.exit) ? ` (exit ${e.exit})` : ""}${took ? ` in ${took}` : ""}`;
      return { title, sub: e.log ?? null, tone: e.ok ? "ok" : "bad" };
    }
    case "service": return { title: e.phase === "up" ? `Service ${e.name} up${e.port ? ` on :${e.port}` : ""}` : `Service ${e.name} down`, sub: null, tone: null };
    case "lock": return { title: `${e.phase === "take" ? "Took" : "Released"} the ${e.name} lock`, sub: null, tone: null };
    case "commit": return { title: `Committed ${String(e.sha ?? "").slice(0, 7)}`, sub: Number.isInteger(e.files) ? `${e.files} file${e.files === 1 ? "" : "s"}` : null, tone: null };
    case "note": return { title: String(e.text ?? ""), sub: null, tone: null };
    default: return { title: String(e?.kind ?? "event"), sub: null, tone: null };
  }
}

/** The timeline's kind filters. */
export const GROUPS = { Agents: ["agent"], Gates: ["gate"], Suite: ["suite"], Stages: ["stage"] };

/** Does an event pass the timeline's filters (card: a card id or null; group: a GROUPS key or null)? */
export function matches(e, { card = null, group = null } = {}) {
  if (card && e.id !== card) return false;
  if (group && !(GROUPS[group] ?? []).includes(e.kind)) return false;
  return true;
}
