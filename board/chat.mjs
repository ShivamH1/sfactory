/**
 * The composer: a bar fixed to the bottom of both views where the person writes to the orchestrator session, the
 * thread of their messages and the session's replies above it, and how messages travel right now. Everything is
 * built when the composer is mounted, never at import: the test suite imports this file in node, where there is no
 * document. Every string reaches the page through textContent.
 */

const MAX_TEXT = 4000;               // the server's limit, src/chat.mjs MAX_TEXT
const COUNT_FROM = 3600;             // the character count shows from here
const MAX_WAIT_MS = 30000;           // the longest back-off after failed polls
const REQUEST_TIMEOUT_MS = 15000;    // a request still out after this is abandoned, so a stuck one never stops the polling
const NEAR_BOTTOM_PX = 24;
const SEEN_KEY = "board-chat-seen";  // the newest reply this viewer has seen, per browser
const CARD_RE = /^[mf]-\d+$/;
const STATUS = { sent: "sent", pushed: "handed to the session", seen: "seen", answered: "answered" };
const CHANNEL_ON = "Channel running";
const CHANNEL_OFF = "Read at the factory's next step";
const CHANNEL_ON_TITLE = "The channel hands each message to the session as you send it. Without it, the session reads messages at the factory's next step.";
const CHANNEL_OFF_TITLE = "The session reads messages at the factory's next step. With the channel running, each message reaches the session as you send it.";
const DEMO_NOTE = "Messages are off in the demo";

const has = (v) => v !== undefined && v !== null && v !== "";
const pad = (n) => String(n).padStart(2, "0");
function readSeen() { try { const v = localStorage.getItem(SEEN_KEY); const t = v === null ? NaN : Date.parse(v); return Number.isNaN(t) ? null : t; } catch { return null; } }
function writeSeen(t) { try { localStorage.setItem(SEEN_KEY, new Date(t).toISOString()); } catch { /* storage may be blocked */ } }

/** Mount the composer on `root` (the #chat section); nothing is fetched until start(). */
export function mountChat(root, { getSnapshot, getContextCard } = {}) {
  const snapshot = () => { try { return (getSnapshot && getSnapshot()) || null; } catch { return null; } };
  const part = (name) => root.querySelector('[data-chat="' + name + '"]');
  const ui = {
    toggle: part("toggle"), fresh: part("new"), thread: part("thread"), announce: part("announce"), form: part("form"),
    scope: part("scope"), text: part("text"), send: part("send"), note: part("note"), count: part("count"), channel: part("channel"),
  };

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  // ---- state ----
  let live = false, pollTimer = null, pollCtl = null, failures = 0, loaded = false;
  let thread = { messages: [], channel: { connected: false, at: null } };
  let open = false, sending = false, scrollNext = false, threadSig = "", noteText = "";
  let seenAt = readSeen(), prevTotal = null, announceTimer = null;
  let ctxCard = null, general = false;
  let resizeObs = null, scopeFrame = null, chanSig = "";

  // ---- the snapshot: card pills, the demo flag, the pace ----
  const jobOf = (id) => { const s = snapshot(); return (s && Array.isArray(s.jobs) && s.jobs.find((j) => j.id === id)) || null; };
  const pillOf = (id) => { const j = jobOf(id); return j && j.number ? "M" + j.number : String(id); };
  const titleOf = (id) => { const j = jobOf(id); return j && has(j.title) ? String(j.title) : ""; };
  const pollMs = () => { const s = snapshot(); const n = s && s.board ? Number(s.board.pollMs) : NaN; return n > 0 ? n : 2000; };
  const isDemo = () => { const s = snapshot(); return !!(s && s.demo); };
  function clock(at) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return "";
    const d = new Date(t), now = new Date();
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + hm;
  }

  // ---- the scope: the context card (the drawer's card, or the agent selected in Activity), or General ----
  function contextCard() {
    let id = null;
    try { id = getContextCard ? getContextCard() : null; } catch { id = null; }
    return has(id) && CARD_RE.test(String(id)) && jobOf(String(id)) ? String(id) : null;
  }
  const scopeCard = () => (ctxCard && !general ? ctxCard : null);
  function paintScope() {
    const c = contextCard();
    if (c !== ctxCard) { ctxCard = c; general = false; } // a new context card is the default scope again
    const card = scopeCard();
    const label = card ? pillOf(card) : "General";
    if (ui.scope.textContent !== label) ui.scope.textContent = label;
    ui.scope.classList.toggle("mono", !!card);
    ui.scope.setAttribute("aria-pressed", card ? "true" : "false");
    const name = ctxCard ? pillOf(ctxCard) + (titleOf(ctxCard) ? " · " + titleOf(ctxCard) : "") : "";
    ui.scope.title = !ctxCard ? "About the whole factory. Open a card, or pick an agent in Activity, to write about it."
      : card ? "About " + name + ". Press to write about the whole factory instead."
      : "About the whole factory. Press to write about " + name + ".";
    if (!ctxCard || isDemo()) ui.scope.setAttribute("aria-disabled", "true"); else ui.scope.removeAttribute("aria-disabled");
  }
  function scopeSoon() {
    if (scopeFrame !== null) return;
    scopeFrame = setTimeout(() => { scopeFrame = null; if (live) paintScope(); }, 0); // after the click has opened, closed or chosen
  }
  ui.scope.addEventListener("click", () => {
    if (ui.scope.getAttribute("aria-disabled") === "true") return;
    general = !general;
    paintScope();
  });

  // ---- the box: auto-growing, Enter sends, the count from 3,600 ----
  function grow() {
    const t = ui.text;
    t.style.height = "auto";
    const max = parseFloat(getComputedStyle(t).maxHeight);
    const want = t.scrollHeight + (t.offsetHeight - t.clientHeight); // the borders
    const capped = Number.isFinite(max) ? Math.min(want, max) : want;
    t.style.height = capped + "px";
    t.style.overflowY = Number.isFinite(max) && want > max ? "auto" : "hidden";
  }
  function setNote(text, bad) {
    noteText = text;
    ui.note.textContent = text;
    ui.note.classList.toggle("bad", !!bad);
  }
  function paintBar() {
    const demo = isDemo();
    const n = ui.text.value.length;
    const over = n > MAX_TEXT;
    ui.count.hidden = n < COUNT_FROM;
    ui.count.textContent = n.toLocaleString("en-US") + " / " + MAX_TEXT.toLocaleString("en-US");
    ui.count.classList.toggle("bad", over);
    ui.count.title = over ? "Too long to send: at most " + MAX_TEXT.toLocaleString("en-US") + " characters" : "";
    ui.text.disabled = demo;
    ui.send.disabled = demo || sending || !ui.text.value.trim() || over;
    root.classList.toggle("demo", demo);
    if (demo) setNote(DEMO_NOTE, false);
    else if (noteText === DEMO_NOTE) setNote("", false);
    if (ui.text.getAttribute("aria-invalid") !== String(over)) ui.text.setAttribute("aria-invalid", over ? "true" : "false");
    paintChannel(demo);
  }
  function paintChannel(demo) {
    const on = !!(thread.channel && thread.channel.connected);
    ui.channel.hidden = demo || !loaded;
    if (chanSig === String(on)) return;
    chanSig = String(on);
    ui.channel.textContent = "";
    const dot = h("i", "chat-dot" + (on ? "" : " idle"));
    dot.setAttribute("aria-hidden", "true");
    ui.channel.appendChild(dot);
    ui.channel.appendChild(document.createTextNode(on ? CHANNEL_ON : CHANNEL_OFF));
    ui.channel.title = on ? CHANNEL_ON_TITLE : CHANNEL_OFF_TITLE;
  }
  ui.text.addEventListener("input", () => {
    grow();
    if (noteText && noteText !== DEMO_NOTE) setNote("", false); // the last failure no longer describes this text
    paintBar();
  });
  ui.text.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  });
  ui.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });

  // ---- sending ----
  async function send() {
    const text = ui.text.value;
    if (isDemo() || sending || !text.trim() || text.length > MAX_TEXT) return;
    const card = scopeCard();
    sending = true;
    setNote("", false);
    paintBar();
    let failed = null;
    try {
      const r = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sfactory-Board": "1" },
        body: JSON.stringify(card ? { text, card } : { text }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const code = j && typeof j.code === "string" ? j.code : null;
        failed = code === "DEMO" ? DEMO_NOTE : (j && typeof j.message === "string" && j.message) || "The message was not sent (" + (code || "status " + r.status) + ").";
      }
    } catch { failed = "The board could not be reached; the message was not sent."; }
    sending = false;
    if (failed) { setNote(failed, true); paintBar(); return; }
    if (ui.text.value === text) ui.text.value = ""; // what was typed while it was out stays
    grow();
    scrollNext = true;
    if (!open) setOpen(true);
    paintBar();
    pollNow();
  }

  // ---- the thread ----
  function replies() {
    const out = [];
    for (const m of thread.messages) for (const r of Array.isArray(m.replies) ? m.replies : []) out.push(r);
    return out;
  }
  function newestReplyAt() {
    let t = null;
    for (const r of replies()) { const x = Date.parse(r.at); if (!Number.isNaN(x) && (t === null || x > t)) t = x; }
    return t;
  }
  function newCount() {
    let n = 0;
    for (const r of replies()) { const x = Date.parse(r.at); if (!Number.isNaN(x) && (seenAt === null || x > seenAt)) n += 1; }
    return n;
  }
  function markSeen() {
    const t = newestReplyAt();
    if (t !== null && (seenAt === null || t > seenAt)) { seenAt = t; writeSeen(t); }
  }
  function announce(text) {
    clearTimeout(announceTimer);
    ui.announce.textContent = "";
    announceTimer = setTimeout(() => { ui.announce.textContent = text; }, 60); // cleared first, so the same words twice are read twice
  }
  function setOpen(v) {
    open = v;
    ui.thread.hidden = !open;
    ui.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { markSeen(); scrollNext = true; paintThread(); }
    paintToggle();
  }
  ui.toggle.addEventListener("click", () => setOpen(!open));
  function paintToggle() {
    const n = open ? 0 : newCount();
    const text = n > 0 ? " · " + n + " new" : "";
    if (ui.fresh.textContent !== text) ui.fresh.textContent = text;
  }
  function pillNode(card) {
    if (has(card)) {
      const p = h("span", "num", pillOf(card));
      if (titleOf(card)) p.title = titleOf(card);
      return p;
    }
    return h("span", "chat-general", "General");
  }
  function timeNode(at) {
    const tm = h("span", "chat-tm", clock(at));
    const t = Date.parse(at);
    if (!Number.isNaN(t)) tm.title = new Date(t).toLocaleString();
    return tm;
  }
  function messageNode(m) {
    const li = h("li", "chat-msg");
    const top = h("div", "chat-row");
    top.appendChild(pillNode(m.card));
    top.appendChild(timeNode(m.at));
    top.appendChild(h("span", "chat-status" + (m.status === "answered" ? " done" : ""), Object.hasOwn(STATUS, m.status) ? STATUS[m.status] : String(m.status ?? "")));
    li.appendChild(top);
    li.appendChild(h("p", "chat-text", m.text));
    const rs = Array.isArray(m.replies) ? m.replies : [];
    if (rs.length) {
      const box = h("ul", "chat-replies");
      box.setAttribute("aria-label", "Replies from the session");
      for (const r of rs) {
        const ri = h("li", "chat-reply");
        const rt = h("div", "chat-row");
        rt.appendChild(h("span", "chat-who", "Session"));
        rt.appendChild(timeNode(r.at));
        ri.appendChild(rt);
        ri.appendChild(h("p", "chat-text", r.text));
        box.appendChild(ri);
      }
      li.appendChild(box);
    }
    return li;
  }
  function paintThread() {
    if (!open) return;
    const cards = thread.messages.map((m) => (has(m.card) ? m.card + ":" + pillOf(m.card) : "")).join(",");
    const sig = JSON.stringify([loaded, thread.messages, cards, new Date().toDateString()]);
    const box = ui.thread;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    if (sig !== threadSig) {
      threadSig = sig;
      box.textContent = "";
      if (!thread.messages.length) box.appendChild(h("p", "chat-empty", loaded ? "No messages yet. What you send appears here, and the session's replies under it." : "Loading the conversation…"));
      else {
        const list = h("ol", "chat-list");
        for (const m of thread.messages) list.appendChild(messageNode(m));
        box.appendChild(list);
      }
      if (atBottom) scrollNext = true; // reading the newest: keep to it
    }
    if (scrollNext) { box.scrollTop = box.scrollHeight; scrollNext = false; }
  }

  // ---- polling: /chat.json every pollMs, one request in flight, paused while hidden or stopped ----
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  function pollNow() { if (live) { if (pollCtl) { pollCtl.abort(); pollCtl = null; } schedulePoll(0); } }
  async function poll() {
    pollTimer = null;
    if (!live || pollCtl || document.hidden) return; // a hidden tab picks up again on visibilitychange
    const ctl = new AbortController();
    pollCtl = ctl;
    let body = null;
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch("/chat.json", { cache: "no-store", signal: ctl.signal });
      const j = await r.json().catch(() => null);
      if (r.ok && j && typeof j === "object" && Array.isArray(j.messages)) body = j;
    } catch { body = null; }
    clearTimeout(timer);
    if (pollCtl !== ctl) return; // stopped, or asked again, while it was out
    pollCtl = null;
    let wait = pollMs();
    if (body) { // a failed poll shows nothing and keeps the last thread
      thread = { messages: body.messages, channel: body.channel && typeof body.channel === "object" ? body.channel : { connected: false, at: null } };
      loaded = true;
      failures = 0;
      render();
    } else {
      failures += 1;
      wait = Math.min(MAX_WAIT_MS, pollMs() * 2 ** failures);
    }
    if (live) schedulePoll(wait);
  }
  function render() {
    const total = replies().length;
    if (loaded && prevTotal !== null && total > prevTotal) {
      const n = total - prevTotal;
      announce(n === 1 ? "1 new reply from the session" : n + " new replies from the session");
    }
    if (loaded) prevTotal = total;
    if (open) markSeen();
    paintScope();
    paintBar();
    paintToggle();
    paintThread();
  }

  // ---- the page's bottom padding follows the composer's height, so it never covers a card ----
  // --chat-h is the room from the composer's top edge to the bottom of the window, plus a gap
  function padPage() {
    const r = root.getBoundingClientRect();
    const room = root.hidden ? 0 : Math.max(0, Math.ceil(window.innerHeight - r.top)) + 8;
    document.documentElement.style.setProperty("--chat-h", room + "px");
  }

  const onVisibility = () => { if (live && !document.hidden) schedulePoll(0); };
  function start() {
    if (live) return;
    live = true;
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("click", scopeSoon);
    document.addEventListener("keyup", scopeSoon);
    if (typeof ResizeObserver === "function") { resizeObs = new ResizeObserver(padPage); resizeObs.observe(root); }
    root.hidden = false;
    grow();
    render();
    padPage();
    schedulePoll(0);
  }
  function stop() {
    if (!live) return;
    live = false;
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("click", scopeSoon);
    document.removeEventListener("keyup", scopeSoon);
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    clearTimeout(pollTimer); clearTimeout(scopeFrame); clearTimeout(announceTimer);
    pollTimer = null; scopeFrame = null; announceTimer = null;
    if (pollCtl) { pollCtl.abort(); pollCtl = null; }
  }
  return { start, stop };
}
