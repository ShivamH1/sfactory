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

/** Where to read a log of `size` bytes so that at most `capBytes` of its end are fetched (0 when it is shorter). */
export const startNearEnd = (size, capBytes) => (Number.isInteger(size) && size > capBytes ? size - capBytes : 0);

/** Text read from the middle of a log, from after its first newline (null while no newline has arrived yet). */
export function dropPartialLine(text) {
  const s = String(text ?? "");
  const nl = s.indexOf("\n");
  return nl < 0 ? null : s.slice(nl + 1);
}

/** Does an event pass the timeline's filters (card: a card id or null; group: a GROUPS key or null)? */
export function matches(e, { card = null, group = null } = {}) {
  if (card && e.id !== card) return false;
  if (group && !(Object.hasOwn(GROUPS, group) && GROUPS[group].includes(e.kind))) return false;
  return true;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** A duration as "12s", "4m 12s", "1h 4m" or "2d 3h"; empty for anything that is not a duration. */
export function fmtElapsed(ms) {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), hr = Math.floor(m / 60);
  if (hr >= 48) return Math.floor(hr / 24) + "d " + (hr % 24) + "h";
  if (hr > 0) return hr + "h " + (m % 60) + "m";
  if (m > 0) return m + "m " + (s % 60) + "s";
  return s + "s";
}

/** An agent's vendor as a name. */
export const vendorName = (v) => (v === "codex" ? "Codex" : v === "claude" ? "Claude" : txt(v) || "Agent");

/** "task 3 of 9" when the card knows its task count and the task is a number, "task 3" otherwise, null with no task. */
export function taskLabel(task, job) {
  const t = txt(task);
  if (!t) return null;
  const total = job?.tasks?.total;
  return "task " + t + (typeof total === "number" && total > 0 && /^\d+$/.test(t) ? " of " + total : "");
}

/** A moment's local calendar day, as YYYY-MM-DD. */
export function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

/** A day header: Today, Yesterday, else a short date (with the year when it is not this year); Undated for no time. */
export function dayLabel(t, now) {
  if (!Number.isFinite(t)) return "Undated";
  const k = dayKey(t);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(now - DAY_MS)) return "Yesterday";
  const d = new Date(t);
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

/**
 * The timeline: the events passing `filter`, newest `at` first, grouped by local day (one group per day). Events
 * with the same time keep the list's direction, the later arrival above; an `at` that does not parse sorts last,
 * under "Undated". Each row's key is its arrival position (`offset` plus its index), so it never changes.
 */
export function timelineGroups(events, filter = {}, now = Date.now(), offset = 0) {
  const rows = [];
  (Array.isArray(events) ? events : []).forEach((e, i) => {
    if (e && typeof e === "object" && matches(e, filter)) rows.push({ key: "e" + (offset + i), e, t: Date.parse(e.at), i });
  });
  rows.sort((a, b) => {
    const an = Number.isNaN(a.t), bn = Number.isNaN(b.t);
    if (an !== bn) return an ? 1 : -1;
    if (!an && a.t !== b.t) return b.t - a.t;
    return b.i - a.i;
  });
  const groups = [];
  for (const r of rows) {
    const day = Number.isNaN(r.t) ? "undated" : dayKey(r.t);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) { g = { day, label: dayLabel(r.t, now), rows: [] }; groups.push(g); }
    g.rows.push({ key: r.key, e: r.e });
  }
  return groups;
}

/** A review file belongs to an agent's task (`<k>-task-<n>-…`), or, with no task, to its role (`<k>-judge`). */
export function reviewFor(name, task, role) {
  const parts = String(name).replace(/\.md$/, "").split("-");
  const t = txt(task);
  if (t) return parts.some((p, i) => p === "task" && parts[i + 1] === t);
  const slug = txt(role).trim().toLowerCase().split(/\s+/).join("-");
  const rest = parts.slice(1).join("-");
  return slug !== "" && (rest === slug || rest.startsWith(slug + "-"));
}

/**
 * The file the Report tab shows, from the card's file list (null when there is none yet): the newest review of the
 * agent's task (reviews are numbered in order) or the task's report.md. A reviewer's own work is the review, so it
 * comes first for a reviewer, the report for anyone else. A role that names spec or code takes only a review of
 * that kind, never another reviewer's file.
 */
export function reportPath(sel, job) {
  const files = Array.isArray(job?.files) ? job.files : [];
  const task = txt(sel?.task) || null;
  const role = txt(sel?.role);
  const base = (f) => f.slice("reviews/".length);
  const num = (f) => parseInt(base(f), 10) || 0;
  const reviews = files.filter((f) => typeof f === "string" && /^reviews\/[^/]+\.md$/.test(f) && reviewFor(base(f), task, role))
    .sort((a, b) => num(a) - num(b));
  const words = role.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== "review" && w !== "reviewer");
  const own = reviews.filter((f) => base(f).replace(/\.md$/, "").split("-").some((p) => words.includes(p)));
  const strict = words.includes("spec") || words.includes("code");
  const pick = own.length || strict ? own : reviews;
  const review = pick.length ? pick[pick.length - 1] : null;
  const report = task !== null && files.includes("tasks/" + task + "/report.md") ? "tasks/" + task + "/report.md" : null;
  if (strict) return review;
  return /review|judge|hunt/i.test(role) ? review || report : report || review;
}
