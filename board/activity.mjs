/**
 * The Activity view (layout A, the split): the agents running now as tiles, a timeline across every card, and the
 * selected agent's output, a Codex stream rendered as messages, commands and file changes. Everything is built when
 * the view is mounted, never at import: the test suite imports this file in node, where there is no document.
 * Every string reaches the page through textContent.
 */
import { renderCodexStream, splitOutput } from "./codex-render.mjs";
import { foldActivity, foldTail, describe, GROUPS, matches } from "./activity-state.mjs";

const PAGE = 200;                    // the server's page size: a full page means more is waiting
const TAIL_MS = 1000;                // the open log is asked for every second
const MAX_WAIT_MS = 30000;           // the longest back-off after failed requests
const MAX_LOG_CHARS = 1024 * 1024;   // a longer log keeps its last three quarters of this
const DAY_MS = 24 * 60 * 60 * 1000;
const NEAR_BOTTOM_PX = 24;
const CHANGE = { add: "added", update: "updated", delete: "deleted" };
const TABS = [["live", "Live output"], ["brief", "Brief"], ["report", "Report"], ["raw", "Raw log"]];

const has = (v) => v !== undefined && v !== null && v !== "";
const enc = encodeURIComponent;
const pad = (n) => String(n).padStart(2, "0");
const vendorName = (v) => (v === "codex" ? "Codex" : v === "claude" ? "Claude" : has(v) ? String(v) : "Agent");
const taskOf = (v) => (has(v) ? String(v) : null);

function elapsed(ms) {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), hr = Math.floor(m / 60);
  if (hr >= 48) return Math.floor(hr / 24) + "d " + (hr % 24) + "h";
  if (hr > 0) return hr + "h " + (m % 60) + "m";
  if (m > 0) return m + "m " + (s % 60) + "s";
  return s + "s";
}
function clock(t) { const d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function dayLabel(t, now) {
  if (Number.isNaN(t)) return "Undated";
  const k = dayKey(t);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(now - DAY_MS)) return "Yesterday";
  const d = new Date(t);
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}
const count = (n) => (Number.isFinite(n) ? n.toLocaleString() : "");

/** A review file belongs to an agent's task (`<k>-task-<n>-…`), or, with no task, to its role (`<k>-judge`). */
function reviewFor(name, task, role) {
  const parts = name.replace(/\.md$/, "").split("-");
  if (task !== null) return parts.some((p, i) => p === "task" && parts[i + 1] === task);
  const slug = String(role ?? "").trim().toLowerCase().split(/\s+/).join("-");
  const rest = parts.slice(1).join("-");
  return slug !== "" && (rest === slug || rest.startsWith(slug + "-"));
}

/**
 * The file the Report tab shows: the newest review of the agent's task (reviews are numbered in order) or the
 * task's report.md. A reviewer's own work is the review, so it comes first for a reviewer; the report for anyone else.
 */
function reportPath(sel, job) {
  const files = job && Array.isArray(job.files) ? job.files : [];
  const task = taskOf(sel.task);
  const num = (f) => parseInt(f.slice("reviews/".length), 10) || 0;
  const reviews = files.filter((f) => /^reviews\/[^/]+\.md$/.test(f) && reviewFor(f.slice("reviews/".length), task, sel.role))
    .sort((a, b) => num(a) - num(b));
  // a spec reviewer's own file is the task's spec review, a code reviewer's the code review: the role's other words pick it
  const words = String(sel.role ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== "review" && w !== "reviewer");
  const own = reviews.filter((f) => f.slice("reviews/".length).replace(/\.md$/, "").split("-").some((p) => words.includes(p)));
  const pick = own.length ? own : reviews;
  const review = pick.length ? pick[pick.length - 1] : null;
  const report = task !== null && files.includes("tasks/" + task + "/report.md") ? "tasks/" + task + "/report.md" : null;
  return /review|judge|hunt/i.test(String(sel.role ?? "")) ? review || report : report || review;
}

/** Mount the view on `root` (the #activity section); nothing is fetched until start(). */
export function mountActivity(root, { getSnapshot } = {}) {
  const snapshot = () => { try { return (getSnapshot && getSnapshot()) || null; } catch { return null; } };
  const part = (name) => root.querySelector('[data-act="' + name + '"]');
  const ui = { running: part("running"), status: part("status"), chips: part("chips"), feed: part("feed"), head: part("head"), tabs: part("tabs"), follow: part("follow"), out: part("out") };

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function button(cls, text) { const b = h("button", cls, text); b.type = "button"; return b; }
  function dot(cls) { const d = h("i", "act-dot" + (cls ? " " + cls : "")); d.setAttribute("aria-hidden", "true"); return d; }
  function refocus(parent, key) {
    if (key === null) return;
    for (const el of parent.querySelectorAll("[data-key]")) if (el.dataset.key === key) { el.focus(); return; }
  }
  const focusedKey = (parent) => (parent.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key ?? null : null);

  // ---- state ----
  let feed = { events: [], cursor: null, running: [] }, loaded = false, dropped = 0, failures = 0;
  let live = false, pollTimer = null, pollCtl = null, tickTimer = null, tickBusy = false, tickSoon = false;
  let skew = 0, skewFrom = null;
  const filter = { card: null, group: null };
  let sel = null, tab = "live", following = true, prevTop = 0;
  let log = null, logPath = null, tailCtl = null, tailGen = 0, tailFails = 0, tailNote = "", tailStopped = false;
  let doc = null, reportShown = false;
  let blockNodes = [], expanded = new Set(), outKey = "", outMode = "";
  let tileSig = "", chipSig = "", feedSig = "", headSig = "";
  const rows = new Map();   // a timeline event's key -> its row
  const days = new Map();   // a day's key -> its label
  const feedEmpty = h("p", "act-quiet act-feed-empty");

  // ---- the snapshot: card names, the suite lock, the demo's clock ----
  function updateSkew() {
    const s = snapshot();
    if (!s || !s.demo) { skew = 0; skewFrom = null; return; }
    if (s.generatedAt === skewFrom) return;
    skewFrom = s.generatedAt;
    const t = Date.parse(s.generatedAt);
    skew = Number.isNaN(t) ? 0 : t - Date.now();
  }
  const nowMs = () => Date.now() + skew;
  const jobOf = (id) => { const s = snapshot(); return (s && Array.isArray(s.jobs) && s.jobs.find((j) => j.id === id)) || null; };
  const pillOf = (id) => { const j = jobOf(id); return j && j.number ? "M" + j.number : has(id) ? String(id) : "suite"; };
  const titleOf = (id) => { const j = jobOf(id); return j && has(j.title) ? String(j.title) : ""; };
  const pollMs = () => { const s = snapshot(); const n = s && s.board ? Number(s.board.pollMs) : NaN; return n > 0 ? n : 2000; };
  function setStatus(text) { ui.status.textContent = text; ui.status.hidden = !text; }

  // ---- the agents running now ----
  function tilesNow() {
    if (!loaded) return [];
    const out = (Array.isArray(feed.running) ? feed.running : []).map((r) => ({
      key: ["agent", r.id, r.vendor, r.role, r.task ?? "", r.startedAt].join("|"), tile: true, suite: false,
      id: r.id, vendor: r.vendor, role: r.role, task: taskOf(r.task), model: has(r.model) ? r.model : null, startedAt: r.startedAt, log: has(r.log) ? r.log : null,
    }));
    const s = snapshot();
    const lock = s && s.locks && s.locks.suite;
    if (lock && lock.held) out.push({ key: "suite|" + (lock.holder ?? "") + "|" + (lock.since ?? ""), tile: true, suite: true, id: lock.holder ?? "", startedAt: lock.since ?? null, log: null });
    return out;
  }
  /** The log an agent writes: its own, or for the suite, the latest suite run's log on the holder's card. */
  function logOf(s) {
    if (!s) return null;
    if (has(s.log)) return s.log;
    if (s.suite) {
      for (let i = feed.events.length - 1; i >= 0; i--) {
        const e = feed.events[i];
        if (e.kind === "suite" && e.id === s.id && e.phase === "start" && typeof e.log === "string" && e.log) return e.log;
      }
    }
    return null;
  }
  const sameRun = (t, s) => t.key === s.key || (has(logOf(s)) && t.id === s.id && logOf(t) === logOf(s));
  function finishOf(s) {
    const since = String(s.startedAt ?? "");
    for (let i = feed.events.length - 1; i >= 0; i--) {
      const e = feed.events[i];
      if (e.id !== s.id || e.phase !== "finish" || String(e.at) < since) continue;
      if (s.suite ? e.kind === "suite" : e.kind === "agent" && e.vendor === s.vendor && e.role === s.role && taskOf(e.task) === taskOf(s.task)) return e;
    }
    return null;
  }
  function whoOf(s) {
    if (s.suite) return "Suite";
    const job = jobOf(s.id);
    const total = job && job.tasks && typeof job.tasks.total === "number" && job.tasks.total > 0 && /^\d+$/.test(String(s.task)) ? " of " + job.tasks.total : "";
    return [vendorName(s.vendor), s.role, s.task !== null ? "task " + s.task + total : null].filter(has).join(" · ");
  }
  function metaOf(s) {
    const el = elapsed(nowMs() - Date.parse(s.startedAt));
    return (s.suite ? ["holds the suite lock", el] : [s.model, el]).filter(has).join(" · ");
  }
  const waitingOn = () => { const s = snapshot(); return s && Array.isArray(s.jobs) ? s.jobs.filter((j) => j.needsYou).length : 0; };

  function paintTiles(tiles) {
    const sig = !loaded ? "loading" : tiles.length ? JSON.stringify(tiles.map((t) => [t.key, pillOf(t.id), titleOf(t.id), whoOf(t)])) : "none|" + waitingOn();
    if (sig !== tileSig) {
      tileSig = sig;
      const focus = focusedKey(ui.running);
      ui.running.textContent = "";
      if (!loaded) ui.running.appendChild(h("p", "act-quiet", "Loading activity…"));
      else if (!tiles.length) ui.running.appendChild(h("p", "act-quiet", "Nothing running. Cards waiting on you: " + waitingOn() + "."));
      for (const t of tiles) {
        const b = button("act-tile" + (t.suite ? " suite" : ""));
        b.dataset.key = t.key;
        const top = h("span", "act-row");
        top.appendChild(dot(t.suite ? "you on" : "on"));
        top.appendChild(h("span", "num", pillOf(t.id)));
        const name = titleOf(t.id);
        if (name) top.appendChild(h("span", "act-name", name));
        b.appendChild(top);
        b.appendChild(h("span", "act-who", whoOf(t)));
        b.appendChild(h("span", "act-meta"));
        if (name) b.title = name;
        b.addEventListener("click", () => choose(t, true));
        ui.running.appendChild(b);
      }
      refocus(ui.running, focus);
    }
    for (const b of ui.running.querySelectorAll(".act-tile")) {
      const t = tiles.find((x) => x.key === b.dataset.key);
      b.setAttribute("aria-pressed", sel && sel.key === b.dataset.key ? "true" : "false");
      const m = b.querySelector(".act-meta");
      if (t && m) { const text = metaOf(t); if (m.textContent !== text) m.textContent = text; }
    }
  }

  // ---- the timeline ----
  function paintChips() {
    const now = nowMs();
    const ids = [];
    for (const e of feed.events) {
      const t = Date.parse(e.at);
      if (!Number.isNaN(t) && now - t <= DAY_MS && has(e.id) && !ids.includes(e.id)) ids.push(e.id);
    }
    if (filter.card !== null && !ids.includes(filter.card)) ids.push(filter.card);
    ids.sort((a, b) => pillOf(a).localeCompare(pillOf(b), "en", { numeric: true }));
    const chips = [{ key: "all", label: "All cards", on: filter.card === null }]
      .concat(ids.map((id) => ({ key: "card:" + id, label: pillOf(id), on: filter.card === id, card: id, title: titleOf(id) })))
      .concat([{ key: "sep" }])
      .concat(Object.keys(GROUPS).map((g) => ({ key: "group:" + g, label: g, on: filter.group === g, group: g })));
    const sig = JSON.stringify(chips);
    if (sig === chipSig) return;
    chipSig = sig;
    const focus = focusedKey(ui.chips);
    ui.chips.textContent = "";
    for (const c of chips) {
      if (c.key === "sep") { const s = h("span", "act-sep"); s.setAttribute("aria-hidden", "true"); ui.chips.appendChild(s); continue; }
      const b = button("act-chip" + (c.card !== undefined ? " mono" : ""), c.label);
      b.dataset.key = c.key;
      b.setAttribute("aria-pressed", c.on ? "true" : "false");
      if (c.title) { b.title = c.title; b.setAttribute("aria-label", c.label + " · " + c.title); }
      b.addEventListener("click", () => {
        if (c.key === "all") filter.card = null;
        else if (c.card !== undefined) filter.card = filter.card === c.card ? null : c.card;
        else filter.group = filter.group === c.group ? null : c.group;
        render();
      });
      ui.chips.appendChild(b);
    }
    refocus(ui.chips, focus);
  }

  function paintTitle(el, title, tone) {
    const i = title.search(/[✓✕]/);
    if (i < 0 || (tone !== "ok" && tone !== "bad")) { el.textContent = title; return; }
    el.textContent = title.slice(0, i);
    el.appendChild(h("span", tone === "ok" ? "act-ok" : "act-bad", title.slice(i)));
  }
  const openable = (e) => (e.kind === "agent" || e.kind === "suite") && typeof e.log === "string" && e.log !== "";
  function rowNode(key, e) {
    let n = rows.get(key);
    if (n) return n;
    const d = describe(e);
    n = openable(e) ? button("act-ev act-open") : h("div", "act-ev");
    const t = Date.parse(e.at);
    const tm = h("span", "act-tm", Number.isNaN(t) ? "" : clock(t));
    if (!Number.isNaN(t)) tm.title = new Date(t).toLocaleString();
    n.appendChild(tm);
    n.appendChild(h("span", "num"));
    const tx = h("span", "act-tx");
    const title = h("span", "act-title");
    paintTitle(title, d.title, d.tone);
    tx.appendChild(title);
    if (has(d.sub)) tx.appendChild(h("span", "act-sub", d.sub));
    n.appendChild(tx);
    if (openable(e)) {
      n.setAttribute("aria-pressed", "false");
      n.addEventListener("click", () => openRow(e));
    }
    n.act = e;
    rows.set(key, n);
    return n;
  }
  function dayNode(key, t, now) {
    let n = days.get(key);
    if (!n) { n = h("h3", "act-day"); days.set(key, n); }
    const label = dayLabel(t, now);
    if (n.textContent !== label) n.textContent = label;
    return n;
  }
  /** Put `nodes` in `parent` in order, moving only what is out of place (a moved node loses focus). */
  function reconcile(parent, nodes) {
    let cur = parent.firstChild;
    for (const n of nodes) {
      if (cur === n) { cur = cur.nextSibling; continue; }
      parent.insertBefore(n, cur);
    }
    while (cur) { const next = cur.nextSibling; parent.removeChild(cur); cur = next; }
  }
  function paintFeed() {
    const now = nowMs();
    const s = snapshot();
    const names = s && Array.isArray(s.jobs) ? s.jobs.map((j) => j.id + ":" + (j.number ?? "")).join(",") : "";
    const sig = [loaded, dropped, feed.events.length, filter.card, filter.group, dayKey(now), names].join("|");
    if (sig !== feedSig) {
      feedSig = sig;
      const want = [], keep = new Set(), keepDays = new Set();
      let day = null;
      for (let i = feed.events.length - 1; i >= 0; i--) {
        const e = feed.events[i];
        if (!matches(e, filter)) continue;
        const t = Date.parse(e.at);
        const dk = Number.isNaN(t) ? "undated" : dayKey(t);
        if (dk !== day) { day = dk; keepDays.add(dk); want.push(dayNode(dk, t, now)); }
        const key = "e" + (dropped + i);
        const row = rowNode(key, e);
        const pill = row.querySelector(".num");
        const text = pillOf(e.id);
        if (pill.textContent !== text) pill.textContent = text;
        keep.add(key);
        want.push(row);
      }
      if (!want.length) {
        feedEmpty.textContent = !loaded ? "Loading the timeline…" : filter.card !== null || filter.group !== null ? "No events match these filters." : "No events yet.";
        want.push(feedEmpty);
      }
      reconcile(ui.feed, want);
      for (const k of [...rows.keys()]) if (!keep.has(k)) rows.delete(k);
      for (const k of [...days.keys()]) if (!keepDays.has(k)) days.delete(k);
    }
    const path = logOf(sel);
    for (const n of rows.values()) {
      if (n.tagName !== "BUTTON") continue;
      const on = !!sel && n.act.id === sel.id && n.act.log === path;
      n.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  function openRow(e) {
    const t = tilesNow().find((x) => x.id === e.id && logOf(x) === e.log);
    if (t) { choose(t, true); return; }
    let start = e.phase === "start" ? e : null;
    if (!start) {
      for (let i = feed.events.length - 1; i >= 0; i--) {
        const x = feed.events[i];
        if (x.id === e.id && x.kind === e.kind && x.phase === "start" && x.log === e.log && String(x.at) <= String(e.at)) { start = x; break; }
      }
    }
    const at = start ? start.at : e.at;
    choose({ key: "log|" + e.id + "|" + e.log + "|" + at, tile: false, suite: e.kind === "suite", id: e.id, vendor: e.kind === "suite" ? null : e.vendor, role: e.kind === "suite" ? null : e.role, task: taskOf(e.task), model: has(e.model) ? e.model : null, startedAt: at, log: e.log }, true);
  }

  // ---- the selection and the output pane ----
  function resetBlocks() { blockNodes = []; expanded = new Set(); outMode = ""; outKey = ""; }
  function choose(next, byPerson) {
    if (sel && next && sel.key === next.key) return;
    sel = next;
    tailGen += 1;
    if (tailCtl) { tailCtl.abort(); tailCtl = null; }
    log = null; logPath = null; tailFails = 0; tailNote = ""; tailStopped = false;
    doc = null; reportShown = false; tab = "live"; following = true;
    resetBlocks();
    if (byPerson) { render(); kick(); }
  }
  const isClaude = (s) => !!s && !s.suite && !has(logOf(s)) && s.vendor === "claude";

  function paintHead(tiles, fin) {
    const running = !!sel && tiles.some((t) => sameRun(t, sel));
    const sig = sel ? [sel.key, pillOf(sel.id), titleOf(sel.id), whoOf(sel), running, fin ? fin.at : ""].join("|") : "none";
    if (sig !== headSig) {
      headSig = sig;
      ui.head.textContent = "";
      if (!sel) ui.head.appendChild(h("span", "act-head-t quiet", "No agent selected"));
      else {
        ui.head.appendChild(dot(sel.suite ? (running ? "you on" : "idle") : running ? "on" : "idle"));
        const t = h("span", "act-head-t", pillOf(sel.id) + " · " + (sel.suite ? "Suite" : [vendorName(sel.vendor), sel.role].filter(has).join(" ") + (sel.task !== null ? " · task " + sel.task : "")));
        const name = titleOf(sel.id);
        if (name) t.title = name;
        ui.head.appendChild(t);
        const st = h("span", "act-head-s");
        st.dataset.el = "1";
        if (!running && fin) {
          const at = Date.parse(fin.at);
          const failed = fin.ok === false;
          st.textContent = (failed ? "failed" : "finished") + (Number.isNaN(at) ? "" : " " + clock(at));
          if (failed) st.classList.add("act-bad");
        } else if (!running) st.textContent = "not running";
        ui.head.appendChild(st);
      }
    }
    const st = ui.head.querySelector("[data-el]");
    if (st && running) { const text = elapsed(nowMs() - Date.parse(sel.startedAt)); if (st.textContent !== text) st.textContent = text; }
    return running;
  }

  const tabButtons = {};
  for (const [key, label] of TABS) {
    const b = button("act-tab", label);
    b.setAttribute("aria-pressed", key === tab ? "true" : "false");
    b.addEventListener("click", () => {
      if (tab === key && key !== "brief" && key !== "report") return;
      tab = key;
      if (key === "brief" || key === "report") doc = null; // a press reads the file again
      following = true;
      render();
    });
    ui.tabs.appendChild(b);
    tabButtons[key] = b;
  }
  const followable = () => !!sel && (tab === "live" || tab === "raw") && has(logOf(sel));
  function paintTabs() {
    const path = logOf(sel);
    const shown = { live: true, brief: !!sel && !sel.suite && sel.task !== null, report: !!sel && !sel.suite, raw: has(path) };
    if (!shown[tab]) tab = "live";
    ui.tabs.hidden = !sel;
    for (const [key, b] of Object.entries(tabButtons)) {
      b.hidden = !shown[key];
      b.setAttribute("aria-pressed", key === tab ? "true" : "false");
    }
    ui.follow.hidden = !sel;
    ui.follow.style.visibility = followable() ? "" : "hidden"; // keeps its place, so the tabs do not move
    paintFollow();
  }
  function paintFollow() {
    ui.follow.setAttribute("aria-pressed", following ? "true" : "false");
    ui.follow.title = following ? "Keeping to the newest output; scroll up to stop" : "Jump to the newest output and keep to it";
  }
  ui.follow.textContent = "";
  ui.follow.appendChild(dot());
  ui.follow.appendChild(document.createTextNode("Following"));
  ui.follow.addEventListener("click", () => { following = !following; paintFollow(); if (following) toBottom(); });
  ui.out.addEventListener("scroll", () => {
    const top = ui.out.scrollTop;
    const atBottom = ui.out.scrollHeight - top - ui.out.clientHeight < NEAR_BOTTOM_PX;
    if (followable()) {
      if (following && !atBottom && top < prevTop - 1) { following = false; paintFollow(); }
      else if (!following && atBottom) { following = true; paintFollow(); }
    }
    prevTop = top;
  });
  function toBottom() { ui.out.scrollTop = ui.out.scrollHeight; prevTop = ui.out.scrollTop; }

  function docPath() {
    if (!sel) return null;
    if (tab === "brief") return sel.task !== null ? "tasks/" + sel.task + "/brief.md" : null;
    return reportPath(sel, jobOf(sel.id));
  }
  function ensureDoc() {
    const path = docPath();
    const key = (sel ? sel.key : "") + "|" + tab + "|" + (path ?? "");
    if (doc && doc.key === key) return;
    if (!path) { doc = { key, path: null, state: "none", text: "" }; return; }
    doc = { key, path, state: "loading", text: "" };
    const id = sel.id;
    fetch("/jobs/" + enc(id) + "/file?path=" + enc(path), { cache: "no-store" })
      .then((r) => r.text().then((t) => ({ ok: r.ok, status: r.status, t })))
      .then((res) => {
        if (!doc || doc.key !== key) return;
        doc = res.ok ? { key, path, state: "ok", text: res.t } : { key, path, state: res.status === 404 ? "missing" : "error", text: "" };
        paintOut();
      })
      .catch(() => { if (doc && doc.key === key) { doc = { key, path, state: "error", text: "" }; paintOut(); } });
  }

  function commandNode(b, i) {
    const box = h("div", "act-cmd");
    const line = h("div", "act-cmdline");
    const dollar = h("span", "act-dollar", "$");
    dollar.setAttribute("aria-hidden", "true");
    line.appendChild(dollar);
    line.appendChild(h("code", "act-cmdtext", b.command));
    const [word, tone] = b.status === "running" ? ["running", "you"]
      : Number.isInteger(b.exit) ? ["exit " + b.exit, b.exit === 0 ? "ok" : "bad"]
      : b.status === "failed" ? ["failed", "bad"] : ["done", "ok"];
    line.appendChild(h("span", "act-exit act-" + tone, word));
    box.appendChild(line);
    if (b.output) {
      const open = expanded.has(i);
      const cut = splitOutput(b.output, 12);
      box.appendChild(h("pre", "act-cmdout", open ? b.output.replace(/\r?\n$/, "") : cut.shown));
      if (cut.hidden > 0) {
        const more = button("act-more", open ? "Show fewer" : "Show " + cut.hidden + " more");
        more.setAttribute("aria-expanded", open ? "true" : "false");
        more.addEventListener("click", () => {
          if (expanded.has(i)) expanded.delete(i); else expanded.add(i);
          outKey = "";
          paintOut();
        });
        box.appendChild(more);
      }
    }
    return box;
  }
  function filesNode(b) {
    const box = h("div", "act-files");
    if (!b.changes.length) box.appendChild(h("p", "act-usage", "File changes, none listed"));
    for (const c of b.changes) {
      const row = h("div", "act-file");
      row.appendChild(h("span", "act-path", c.path));
      const word = Object.hasOwn(CHANGE, c.change) ? CHANGE[c.change] : c.change;
      const tone = b.status === "failed" ? "act-bad" : c.change === "add" ? "act-ok" : c.change === "delete" ? "act-bad" : "";
      row.appendChild(h("span", "act-change" + (tone ? " " + tone : ""), b.status === "failed" ? word + " · failed" : word));
      box.appendChild(row);
    }
    return box;
  }
  function blockNode(b, i) {
    if (b.kind === "message") return h("p", "act-msg", b.text);
    if (b.kind === "reasoning") return h("p", "act-think", b.text);
    if (b.kind === "command") return commandNode(b, i);
    if (b.kind === "files") return filesNode(b);
    if (b.kind === "usage") {
      const parts = [];
      if (b.input !== null) parts.push(count(b.input) + " tokens in" + (b.cached !== null ? " (" + count(b.cached) + " cached)" : ""));
      if (b.output !== null) parts.push(count(b.output) + " out");
      return h("p", "act-usage", ["Turn done"].concat(parts).join(" · "));
    }
    return h("pre", "act-raw", b.text);
  }
  function paintBlocks(wrap, blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const sig = JSON.stringify(blocks[i]) + (expanded.has(i) ? "+" : "");
      const cur = blockNodes[i];
      if (cur && cur.sig === sig) continue;
      const node = blockNode(blocks[i], i);
      if (cur) {
        const hadFocus = cur.node.contains(document.activeElement);
        cur.node.replaceWith(node);
        if (hadFocus) { const m = node.querySelector(".act-more"); if (m) m.focus(); }
      } else wrap.appendChild(node);
      blockNodes[i] = { sig, node };
    }
    while (blockNodes.length > blocks.length) blockNodes.pop().node.remove();
  }
  /** One quiet line under a log: loading, a problem, or that the agent is still at work. */
  function waitLine(running, fin, empty) {
    if (tailNote) return h("p", "act-wait", tailNote);
    if (!log) return h("p", "act-wait", "Loading the log…");
    if (running) { const p = h("p", "act-wait live"); p.appendChild(dot("on")); p.appendChild(document.createTextNode("Waiting for output…")); return p; }
    if (empty) return h("p", "act-wait", "The log is empty.");
    if (fin) return h("p", "act-wait", "Finished.");
    return null;
  }

  function paintOut() {
    const tiles = tilesNow();
    const running = !!sel && tiles.some((t) => sameRun(t, sel));
    const fin = sel ? finishOf(sel) : null;
    const path = logOf(sel);
    const mode = !sel ? "none" : tab === "live" ? (path ? (sel.vendor === "codex" || /\.jsonl$/i.test(path) ? "codex" : "plain") : "nolog") : tab;
    if (mode === "brief" || mode === "report") ensureDoc();
    const modeKey = mode + "|" + (sel ? sel.key : "") + "|" + (path ?? "");
    const key = [modeKey, log ? log.text.length + ":" + log.next : "-", tailNote, doc ? doc.key + doc.state : "", running, fin ? fin.at : "", isClaude(sel), loaded].join("|");
    if (key === outKey) return;
    outKey = key;
    if (modeKey !== outMode) { outMode = modeKey; ui.out.textContent = ""; blockNodes = []; prevTop = 0; }
    const out = ui.out;
    out.classList.toggle("is-empty", mode === "none");
    if (mode === "none") {
      out.textContent = "";
      out.appendChild(h("p", "act-empty", loaded ? "Pick a running agent, or a timeline row with a log, to see its output." : "Loading activity…"));
    } else if (mode === "codex") {
      let wrap = out.querySelector(".act-blocks");
      if (!wrap) { wrap = h("div", "act-blocks"); out.appendChild(wrap); }
      const blocks = log ? renderCodexStream(log.text) : [];
      paintBlocks(wrap, blocks);
      for (const w of out.querySelectorAll(".act-wait")) w.remove();
      const w = waitLine(running, fin, !!log && !blocks.length);
      if (w) out.appendChild(w);
    } else if (mode === "plain" || mode === "raw") {
      out.textContent = "";
      if (log && log.text) out.appendChild(h("pre", "act-plain", log.text));
      const w = waitLine(running, fin, !!log && !log.text);
      if (w) out.appendChild(w);
    } else if (mode === "nolog") {
      out.textContent = "";
      if (isClaude(sel)) {
        out.appendChild(h("p", "act-note", "Claude subagents report when they finish."));
        const at = Date.parse(sel.startedAt);
        const parts = [];
        if (!Number.isNaN(at)) parts.push("Started " + clock(at));
        if (fin && !Number.isNaN(Date.parse(fin.at))) parts.push("finished " + clock(Date.parse(fin.at)) + "; its report is under Report");
        if (parts.length) out.appendChild(h("p", "act-cap", parts.join(" · ") + "."));
      } else out.appendChild(h("p", "act-empty", sel.suite ? "The suite's log is not known yet." : "This agent writes no log in the card's folder."));
    } else {
      out.textContent = "";
      if (!doc || doc.state === "none") out.appendChild(h("p", "act-empty", tab === "brief" ? "This agent has no task brief." : "No report for this agent yet."));
      else {
        out.appendChild(h("p", "act-cap", doc.path));
        if (doc.state === "loading") out.appendChild(h("p", "act-wait", "Loading…"));
        else if (doc.state === "missing") out.appendChild(h("p", "act-wait", "Not written yet."));
        else if (doc.state === "error") out.appendChild(h("p", "act-wait act-bad", "Could not read this file."));
        else out.appendChild(h("pre", "act-plain act-doc", doc.text));
      }
    }
    if (followable() && following) toBottom();
  }

  // ---- polling: the feed every pollMs, the open log every second; never two of either in flight ----
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(pollActivity, ms); }
  async function pollActivity() {
    pollTimer = null;
    if (!live || pollCtl || document.hidden) return; // a hidden tab picks up again on visibilitychange
    const ctl = new AbortController();
    pollCtl = ctl;
    let body = null, code = null;
    try {
      const r = await fetch("/activity.json" + (feed.cursor ? "?cursor=" + enc(feed.cursor) : ""), { cache: "no-store", signal: ctl.signal });
      const j = await r.json().catch(() => null);
      if (r.ok && j && typeof j === "object") body = j; else code = (j && typeof j.code === "string" && j.code) || "HTTP " + r.status;
    } catch { code = null; }
    if (pollCtl !== ctl) return; // stopped, or started again, while it was out
    pollCtl = null;
    let wait = pollMs();
    if (body) {
      const before = feed.events.length;
      const n = Array.isArray(body.events) ? body.events.length : 0;
      feed = foldActivity(feed, body);
      dropped += before + n - feed.events.length;
      loaded = true;
      failures = 0;
      setStatus("");
      if (n >= PAGE) wait = 0;
    } else {
      if (code === "BAD_ARGS" && feed.cursor) { feed = { events: [], cursor: null, running: [] }; dropped = 0; feedSig = ""; rows.clear(); } // a cursor this board no longer takes: start again
      failures += 1;
      wait = Math.min(MAX_WAIT_MS, pollMs() * 2 ** failures);
      setStatus((code ? "Activity error " + code : "Activity unreachable") + ", retrying in " + Math.ceil(wait / 1000) + "s");
    }
    if (live) schedulePoll(wait);
    if (body) render();
  }

  function scheduleTick(ms) { clearTimeout(tickTimer); tickTimer = setTimeout(tick, ms); }
  function kick() { if (tickBusy) tickSoon = true; else if (live) scheduleTick(0); }
  async function tick() {
    tickTimer = null;
    if (!live || tickBusy || document.hidden) return;
    tickBusy = true;
    let wait = TAIL_MS;
    try {
      render();
      wait = await tailOnce();
    } finally {
      tickBusy = false;
      if (live) scheduleTick(tickSoon ? 0 : wait);
      tickSoon = false;
    }
  }
  async function tailOnce() {
    const s = sel, path = logOf(s);
    if (!s || !path || tailStopped || tailCtl) return TAIL_MS;
    if (logPath !== path) { log = null; logPath = path; resetBlocks(); }
    const gen = tailGen;
    const asked = log && Number.isInteger(log.next) ? log.next : 0;
    const ctl = new AbortController();
    tailCtl = ctl;
    let body = null, code = null;
    try {
      const r = await fetch("/jobs/" + enc(s.id) + "/tail?path=" + enc(path) + "&from=" + asked, { cache: "no-store", signal: ctl.signal });
      const j = await r.json().catch(() => null);
      if (r.ok && j && typeof j === "object") body = j; else code = (j && typeof j.code === "string" && j.code) || "HTTP " + r.status;
    } catch { code = "UNREACHABLE"; }
    if (tailCtl === ctl) tailCtl = null;
    if (gen !== tailGen || ctl.signal.aborted || !live) return TAIL_MS; // the selection changed, or the view stopped
    if (!body) {
      tailFails += 1;
      if (code === "FORBIDDEN_FILE") { tailStopped = true; tailNote = "This log cannot be shown here."; }
      else if (code === "FILE_NOT_FOUND") tailNote = "Waiting for the log to appear.";
      else tailNote = "The log could not be read; retrying.";
      paintOut();
      return Math.min(10000, TAIL_MS * 2 ** Math.min(tailFails, 4));
    }
    tailFails = 0;
    tailNote = "";
    const restarted = log !== null && body.from !== asked;
    log = foldTail(log, asked, body);
    if (restarted) resetBlocks(); // the file was replaced: its text starts again
    if (log.text.length > MAX_LOG_CHARS) {
      const from = log.text.length - Math.floor(MAX_LOG_CHARS * 0.75);
      const nl = log.text.indexOf("\n", from);
      log = { ...log, text: nl >= 0 ? log.text.slice(nl + 1) : log.text.slice(from) };
      resetBlocks();
    }
    paintOut();
    return Number.isInteger(body.next) && Number.isInteger(body.size) && body.next < body.size ? 0 : TAIL_MS;
  }

  function render() {
    updateSkew();
    const tiles = tilesNow();
    if (!sel && tiles.length) choose(tiles[0], false);
    const fin = sel ? finishOf(sel) : null;
    if (fin && isClaude(sel) && !reportShown) { reportShown = true; if (tab === "live") { tab = "report"; doc = null; } }
    paintTiles(tiles);
    paintChips();
    paintFeed();
    paintHead(tiles, fin);
    paintTabs();
    paintOut();
  }

  const onVisibility = () => { if (live && !document.hidden) { schedulePoll(0); kick(); } };
  function start() {
    if (live) return;
    live = true;
    document.addEventListener("visibilitychange", onVisibility);
    render();
    schedulePoll(0);
    kick();
  }
  function stop() {
    if (!live) return;
    live = false;
    document.removeEventListener("visibilitychange", onVisibility);
    clearTimeout(pollTimer); clearTimeout(tickTimer);
    pollTimer = null; tickTimer = null;
    if (pollCtl) { pollCtl.abort(); pollCtl = null; }
    if (tailCtl) { tailCtl.abort(); tailCtl = null; }
  }
  return { start, stop };
}
