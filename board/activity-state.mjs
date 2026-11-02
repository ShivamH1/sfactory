/** The Activity view's state, kept pure so the browser and the test suite run the same code. */
export const KEEP_EVENTS = 500;

/** One /activity.json answer folded in: events appended (the newest KEEP_EVENTS kept), cursor and running replaced. */
export function foldActivity(state, answer) {
  const events = [...(state?.events ?? []), ...(Array.isArray(answer?.events) ? answer.events : [])];
  return { events: events.slice(-KEEP_EVENTS), cursor: answer?.cursor ?? state?.cursor ?? null, running: Array.isArray(answer?.running) ? answer.running : [] };
}

/** One tail answer folded into a log view: appended when the server read from where we asked, replaced when it restarted (the file was replaced). */
export function foldTail(view, asked, answer) {
  if (answer == null || typeof answer !== "object") return view ?? { text: "", next: asked, size: 0 };
  const base = answer.from === asked ? (view?.text ?? "") : "";
  return { text: base + String(answer.text ?? ""), next: answer.next, size: answer.size };
}

/** A field as display text: strings as they are, finite numbers as text, anything else empty; never throws. */
const txt = (v) => (typeof v === "string" ? v : Number.isFinite(v) ? String(v) : "");
const cap = (v) => { const s = txt(v); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
const dur = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return null;
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
    case "stage": {
      const to = txt(e.to), from = txt(e.from), reason = txt(e.reason);
      return !from
        ? { title: `Created${to ? ` in ${to}` : ""}`, sub: reason || null, tone: null }
        : { title: `Moved${to ? ` to ${to}` : ""}`, sub: [`from ${from}`, reason].filter(Boolean).join(" · "), tone: null };
    }
    case "gate": {
      const action = txt(e.action);
      const title = action === "parallel" ? (e.yes ? "Approved to run in parallel" : "Queued instead of running in parallel")
        : (Object.hasOwn(GATE, action) ? GATE[action] : cap(action) || "Gate");
      return { title, sub: txt(e.by) ? `by ${txt(e.by)}` : null, tone: "you" };
    }
    case "agent": {
      const who = [cap(e.vendor), txt(e.role)].filter(Boolean).join(" ") || "Agent";
      const on = txt(e.task) ? ` on task ${txt(e.task)}` : "";
      const sub = txt(e.log) || txt(e.model) || null;
      if (e.phase === "start") return { title: `${who} started${on}`, sub, tone: "live" };
      if (e.ok === false) return { title: `${who} failed${on}${Number.isInteger(e.exit) ? ` (exit ${e.exit})` : ""}`, sub, tone: "bad" };
      const verdict = e.verdict === "ok" ? ": ✓ Approved" : e.verdict === "fixes" ? ": ✕ Needs fixes" : "";
      return { title: `${who} finished${on}${verdict}`, sub, tone: e.verdict === "fixes" ? "bad" : e.verdict === "ok" ? "ok" : null };
    }
    case "suite": {
      const log = txt(e.log) || null;
      if (e.phase === "start") return { title: "Suite started", sub: log, tone: "live" };
      const took = dur(e.durationMs);
      const signal = txt(e.signal);
      const inTime = took ? ` in ${took}` : "";
      const title = e.ok ? `Suite passed${inTime}`
        : !Number.isInteger(e.exit) && signal ? `Suite stopped by ${signal}${inTime}`
        : `Suite failed${Number.isInteger(e.exit) ? ` (exit ${e.exit})` : ""}${inTime}`;
      return { title, sub: log, tone: e.ok ? "ok" : "bad" };
    }
    case "service": {
      const name = txt(e.name), port = txt(e.port);
      return { title: `Service${name ? ` ${name}` : ""} ${e.phase === "up" ? `up${port ? ` on :${port}` : ""}` : "down"}`, sub: null, tone: null };
    }
    case "lock": {
      const name = txt(e.name);
      return { title: `${e.phase === "take" ? "Took" : "Released"} ${name ? `the ${name}` : "a"} lock`, sub: null, tone: null };
    }
    case "commit": {
      const sha = txt(e.sha).slice(0, 7);
      return { title: `Committed${sha ? ` ${sha}` : ""}`, sub: Number.isInteger(e.files) ? `${e.files} file${e.files === 1 ? "" : "s"}` : null, tone: null };
    }
    case "note": return { title: txt(e.text), sub: null, tone: null };
    default: return { title: txt(e?.kind) || "Event", sub: null, tone: null };
  }
}

/** The timeline's kind filters. */
export const GROUPS = { Agents: ["agent"], Gates: ["gate"], Suite: ["suite"], Stages: ["stage"] };

/** Does an event pass the timeline's filters (card: a card id or null; group: a GROUPS key or null)? */
export function matches(e, { card = null, group = null } = {}) {
  if (card && e.id !== card) return false;
  if (group && !(Object.hasOwn(GROUPS, group) && GROUPS[group].includes(e.kind))) return false;
  return true;
}
