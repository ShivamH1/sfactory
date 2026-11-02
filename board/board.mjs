
(function () {
  "use strict";
  var VERDICT = /✅|❌|\b(?:Approved|Needs fixes|ok|red)\b/i;
  var cols = {};
  document.querySelectorAll("[data-column]").forEach(function (el) { cols[el.getAttribute("data-column")] = el; });
  var cards = {};          // id -> { el, sig }
  var snap = null, pollTimer = null, pollMs = 2000, drawerJob = null, drawerFile = null;
  var $ = function (id) { return document.getElementById(id); };

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function fmtElapsed(ms) {
    if (!(ms >= 0)) return "";
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), hr = Math.floor(m / 60);
    if (hr >= 48) return Math.floor(hr / 24) + "d " + (hr % 24) + "h";
    if (hr > 0) return hr + "h " + (m % 60) + "m";
    if (m > 0) return m + "m " + (s % 60) + "s";
    return s + "s";
  }
  function usd(n) { return "$" + (Number(n) || 0).toFixed(2); }

  // ---- POST helper ----
  function post(id, action, body) {
    var headers = { "Content-Type": "application/json" };
    headers["X-Sfactory-Board"] = "1";
    return fetch("/jobs/" + encodeURIComponent(id) + "/" + action, { method: "POST", headers: headers, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.message || j.code || ("request failed (" + r.status + ")"));
          return j;
        });
      });
  }

  // ---- controls ----
  function field(card, name) { var t = card.querySelector('textarea[data-field="' + name + '"]'); return t ? t.value : ""; }
  function required(card, name, what) { var v = field(card, name); if (!v.trim()) throw new Error(what + " needs some text first."); return v; }
  function textarea(name, placeholder) {
    var t = h("textarea");
    t.setAttribute("data-field", name);
    t.placeholder = placeholder;
    t.setAttribute("aria-label", placeholder);
    return t;
  }
  function actionButton(card, job, label, cls, action, collect) {
    var b = h("button", "btn " + cls, label);
    b.type = "button";
    b.addEventListener("click", function () {
      if (b.getAttribute("aria-disabled") === "true") return;
      var err = card.querySelector(".err");
      var body;
      try { body = collect ? collect(card) : {}; } catch (e) { err.textContent = e.message; return; }
      err.textContent = "";
      b.disabled = true;
      post(job.id, action, body).then(function () { return poll(); })
        .catch(function (e) { err.textContent = e.message; })
        .then(function () { b.disabled = false; });
    });
    return b;
  }

  function gateFor(card, job) {
    var g = h("div", "gate");
    var btns = h("div", "btns");
    var n = job.needsYou;
    if (job.stage === "awaiting-approval") {
      g.appendChild(textarea("notes", "What should change in the plan?"));
      var ap = actionButton(card, job, "Approve", "go", "approve");
      ap.setAttribute("data-approve", "1");
      btns.appendChild(ap);
      var hint = h("div", "hint");
      hint.id = "hint-" + job.id;
      ap.setAttribute("aria-describedby", hint.id);
      g.appendChild(hint);
      btns.appendChild(actionButton(card, job, "Request changes", "", "request-changes", function (c) { return { notes: required(c, "notes", "Request changes") }; }));
    } else if (n && n.action === "answer") {
      g.appendChild(h("div", "q", n.question || ""));
      g.appendChild(textarea("text", "Your answer"));
      btns.appendChild(actionButton(card, job, "Answer", "go", "answer", function (c) { return { text: required(c, "text", "Answer") }; }));
    } else if (n && n.action === "parallel") {
      g.appendChild(h("div", "q", n.reason || ""));
      btns.appendChild(actionButton(card, job, "Run in parallel", "go", "parallel", function () { return { yes: true }; }));
      btns.appendChild(actionButton(card, job, "Queue it", "", "parallel", function () { return { yes: false }; }));
    } else if (job.stage === "pushed") {
      var copy = h("button", "btn", "Copy PR text");
      copy.type = "button";
      copy.addEventListener("click", function () {
        var err = card.querySelector(".err");
        var text = job.prText || "";
        if (!text) { err.textContent = "No PR text has been written yet."; return; }
        err.textContent = "";
        var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy PR text"; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { err.textContent = "The browser refused the clipboard."; });
        else err.textContent = "The clipboard is not available here.";
      });
      btns.appendChild(copy);
      btns.appendChild(actionButton(card, job, "Mark merged", "go", "merged"));
    } else if (job.stage === "roadmap") {
      btns.appendChild(actionButton(card, job, "Start", "go", "start"));
      g.appendChild(h("div", "hint", "Starts on the next /sfactory run"));
    } else if (job.stage === "external") {
      btns.appendChild(actionButton(card, job, "Mark merged", "go", "merged"));
    }
    if (job.stage === "reviewing" || job.stage === "pushed") {
      g.appendChild(textarea("rework", "What should change?"));
      btns.appendChild(actionButton(card, job, "Rework", "", "rework", function (c) { return { notes: required(c, "rework", "Rework") }; }));
    }
    if (["planning", "building", "reviewing", "fixing", "verifying", "pushing"].indexOf(job.stage) >= 0) {
      btns.appendChild(actionButton(card, job, "Stop", "stop", "stop", function () { return { reason: "stopped from the board" }; }));
    }
    if (!btns.childNodes.length && !g.childNodes.length) return null;
    if (btns.childNodes.length) g.appendChild(btns);
    g.appendChild(h("div", "err"));
    return g;
  }

  // ---- approve only after viewing: page state, never storage ----
  var viewed = {};         // job id -> { updated, files: { path: true } }
  function planFiles(job) { return (job.files || []).filter(function (f) { return /^plan\/[^/]+\.md$/.test(f); }); }
  function unseenPlan(job) {
    var v = viewed[job.id];
    return planFiles(job).filter(function (f) { return !(v && v.files[f]); });
  }
  function refreshApprove(job) {
    var c = cards[job.id];
    var b = c && c.el.querySelector("[data-approve]");
    if (!b) return;
    var gated = unseenPlan(job).length > 0;
    if (gated) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
    var hint = c.el.querySelector(".hint");
    if (hint) hint.textContent = gated ? "Open the plan files first" : "";
  }
  function noteViewed(id, rel, updated) {
    var job = snap && snap.jobs.filter(function (j) { return j.id === id; })[0];
    if (!job || job.updated !== updated || !/^plan\/[^/]+\.md$/.test(rel)) return;
    var v = viewed[id];
    if (!v || v.updated !== job.updated) v = viewed[id] = { updated: job.updated, files: {} };
    v.files[rel] = true;
    refreshApprove(job);
  }

  // ---- cards ----
  function tasksText(t) {
    if (t === null || t === undefined) return "";
    if (typeof t === "number") return t + " tasks";
    if (typeof t === "object" && typeof t.total === "number" && t.total > 0) return (typeof t.done === "number" ? t.done : 0) + "/" + t.total + " tasks";
    return "";
  }
  // stages the column's name does not already say, so the card names them
  var LABELLED_STAGES = ["awaiting-approval", "decision-needed", "fixing", "verifying", "pushing", "pushed", "stopped"];
  function vendorName(v) { return v === "codex" ? "Codex" : v === "claude" ? "Claude" : String(v || "agent"); }
  function fmtShort(ms) {
    if (!(ms >= 0)) return "";
    var m = Math.floor(ms / 60000);
    if (m < 1) return Math.floor(ms / 1000) + "s";
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function runLine(r, job, genAt) {
    var parts = [vendorName(r.vendor), r.role];
    if (r.task !== null && r.task !== undefined && r.task !== "") {
      var total = job.tasks && typeof job.tasks.total === "number" && job.tasks.total > 0 && /^\d+$/.test(String(r.task)) ? " of " + job.tasks.total : "";
      parts.push("task " + r.task + total);
    }
    var el = fmtShort(genAt - Date.parse(r.startedAt));
    if (el) parts.push(el);
    return parts.join(" · ");
  }
  function buildCard(job, demo, runs, genAt) {
    var ext = job.stage === "external";
    var card = h("article", "card" + (job.needsYou ? " needs" : "") + (job.stage === "stopped" ? " stopped" : "") + (ext ? " ext" : "") + (runs.length ? " run" : "") + (job.active ? " active" : ""));
    card.setAttribute("data-id", job.id);
    var top = h("div", "row");
    var idEl = h("span", "num", job.number ? "M" + job.number : job.id);
    if (job.number) idEl.title = job.id;
    top.appendChild(idEl);
    top.appendChild(h("span", "kind", job.kind));
    if (LABELLED_STAGES.indexOf(job.stage) >= 0) top.appendChild(h("span", job.stage === "stopped" ? "tag danger" : "tag", job.stage));
    if (job.needsYou) { if (job.column !== "Needs you") top.appendChild(h("span", "tag you", "needs you")); }
    else if (job.pending) top.appendChild(h("span", "tag you", job.pending));
    if (job.parallel) top.appendChild(h("span", "tag", "parallel: " + job.parallel));
    card.appendChild(top);
    var title = h("button", "title", job.title);
    title.type = "button";
    title.addEventListener("click", function () { openDrawer(job.id); });
    card.appendChild(title);
    var where = job.branch || (job.after ? "after " + job.after : "");
    if (where) { var m = h("div", "m", where); m.title = where; card.appendChild(m); }
    if (job.activity && job.activity.note) card.appendChild(h("div", "note", job.activity.note));
    var t = job.tasks;
    if (job.column === "In process" && t && typeof t === "object" && typeof t.total === "number" && t.total > 0) {
      var bar = h("div", "bar");
      bar.setAttribute("aria-hidden", "true");
      var fill = h("b");
      fill.style.width = Math.max(0, Math.min(100, Math.round(100 * (Number(t.done) || 0) / t.total))) + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    runs.forEach(function (r, i) {
      var line = h("div", "live");
      var dot = h("i");
      dot.setAttribute("aria-hidden", "true");
      line.appendChild(dot);
      var txt = h("span", null, runLine(r, job, genAt));
      txt.setAttribute("data-run", String(i));
      line.appendChild(txt);
      card.appendChild(line);
    });
    var prPart = job.pr ? "PR #" + job.pr : "";
    if (ext) {
      var extText = [job.externalNote, prPart].filter(Boolean).join(" · ");
      if (extText) card.appendChild(h("span", "tag ext", extText));
    } else if (prPart && ["pushing", "pushed", "merged"].indexOf(job.stage) >= 0) card.appendChild(h("span", "tag pr", prPart));
    if (job.reviews && job.reviews.length) {
      var chips = h("div", "row");
      job.reviews.forEach(function (r) {
        var base = r.file.split("/").pop().replace(/\.md$/, "");
        var ch = h("button", "chip " + (r.verdict === "bad" ? "bad" : "good"), (r.verdict === "bad" ? "✗ " : "✓ ") + base);
        ch.type = "button";
        ch.setAttribute("aria-label", "Open review " + base);
        ch.addEventListener("click", function () { openDrawer(job.id, r.file); });
        chips.appendChild(ch);
      });
      card.appendChild(chips);
    }
    var meta = h("div", "meta");
    var el = h("span", null, fmtElapsed(job.elapsedMs));
    el.setAttribute("data-elapsed", "1");
    meta.appendChild(el);
    var tt = tasksText(job.tasks);
    if (tt) meta.appendChild(h("span", null, tt));
    if (job.round) meta.appendChild(h("span", null, "round " + job.round));
    if (job.rework) meta.appendChild(h("span", null, "rework " + job.rework));
    if (job.cost && job.cost.usd) meta.appendChild(h("span", null, usd(job.cost.usd)));
    card.appendChild(meta);
    if (!demo) { var g = gateFor(card, job); if (g) card.appendChild(g); }
    return card;
  }
  // ---- Done: the newest eight by `ended`, the rest behind "Show all N" (a per-viewer choice) ----
  var DONE_SHOWN = 8, doneAll = false;
  try { doneAll = localStorage.getItem("board-done-all") === "1"; } catch (e) { /* storage may be blocked */ }
  function renderDone(list) {
    var box = cols["Done"].querySelector(".cards");
    var sorted = list.slice().sort(function (a, b) { return String(b.ended || "").localeCompare(String(a.ended || "")); });
    var want = sorted.map(function (j) { return cards[j.id].el; });
    want.forEach(function (el, i) { var hide = !doneAll && i >= DONE_SHOWN; if (el.hidden !== hide) el.hidden = hide; });
    var have = [].filter.call(box.children, function (e) { return e.classList.contains("card"); });
    // reorder only when the order differs, so a focused card is not moved
    if (want.length !== have.length || want.some(function (el, i) { return have[i] !== el; })) want.forEach(function (el) { box.appendChild(el); });
    var more = box.querySelector(".more");
    if (sorted.length > DONE_SHOWN) {
      if (!more) {
        more = h("button", "more");
        more.type = "button";
        more.addEventListener("click", function () {
          doneAll = !doneAll;
          try { localStorage.setItem("board-done-all", doneAll ? "1" : "0"); } catch (e) { /* ignore */ }
          if (snap) renderDone(snap.jobs.filter(function (j) { return (cols[j.column] ? j.column : "Stopped") === "Done"; }));
        });
      }
      more.textContent = doneAll ? "Show fewer" : "Show all " + sorted.length;
      more.setAttribute("aria-expanded", doneAll ? "true" : "false");
      if (box.lastElementChild !== more) box.appendChild(more);
    } else if (more) more.remove();
  }
  function sigOf(job, demo, runs) {
    var o = Object.assign({}, job); delete o.elapsedMs; delete o.updated;
    return JSON.stringify([o, demo, runs.map(function (r) { return [r.vendor, r.role, r.task, r.startedAt]; })]);
  }
  function renderCards(s) {
    var demo = !!s.demo, seen = {}, counts = {}, runsBy = {}, done = [];
    var genAt = Date.parse(s.generatedAt);
    (s.running || []).forEach(function (r) { (runsBy[r.id] = runsBy[r.id] || []).push(r); });
    s.jobs.forEach(function (job) {
      var col = cols[job.column] || cols["Stopped"];
      var name = col.getAttribute("data-column");
      var runs = runsBy[job.id] || [];
      seen[job.id] = true;
      counts[name] = (counts[name] || 0) + 1;
      if (name === "Done") done.push(job);
      var sig = sigOf(job, demo, runs), cur = cards[job.id];
      if (!cur || cur.sig !== sig) {
        var fresh = buildCard(job, demo, runs, genAt);
        var focus = null;
        if (cur) { // keep what the person has typed, and where they were typing
          var ae = document.activeElement;
          if (ae && ae.tagName === "TEXTAREA" && cur.el.contains(ae)) focus = { f: ae.getAttribute("data-field"), a: ae.selectionStart, b: ae.selectionEnd };
          cur.el.querySelectorAll("textarea[data-field]").forEach(function (t) {
            var n = fresh.querySelector('textarea[data-field="' + t.getAttribute("data-field") + '"]');
            if (n) n.value = t.value;
          });
          if (cur.el.parentNode === col.querySelector(".cards")) cur.el.replaceWith(fresh); else cur.el.remove();
        }
        cur = cards[job.id] = { el: fresh, sig: sig };
        var box0 = col.querySelector(".cards");
        if (fresh.parentNode !== box0) box0.appendChild(fresh);
        if (focus) {
          var nt = fresh.querySelector('textarea[data-field="' + focus.f + '"]');
          if (nt) { nt.focus(); try { nt.setSelectionRange(focus.a, focus.b); } catch (e) { /* ignore */ } }
        }
      }
      var span = cur.el.querySelector("[data-elapsed]");
      if (span) span.textContent = fmtElapsed(job.elapsedMs);
      cur.el.querySelectorAll("[data-run]").forEach(function (sp) {
        var r = runs[Number(sp.getAttribute("data-run"))];
        if (r) sp.textContent = runLine(r, job, genAt);
      });
      var box = col.querySelector(".cards");
      if (cur.el.parentNode !== box) box.appendChild(cur.el);
      if (name !== "Done" && cur.el.hidden) cur.el.hidden = false;
    });
    Object.keys(cards).forEach(function (id) { if (!seen[id]) { cards[id].el.remove(); delete cards[id]; } });
    renderDone(done);
    s.jobs.forEach(function (job) {
      var v = viewed[job.id];
      if (v && v.updated !== job.updated) delete viewed[job.id];
      refreshApprove(job);
    });
    Object.keys(viewed).forEach(function (id) { if (!seen[id]) delete viewed[id]; });
    $("board").classList.toggle("has-cards", s.jobs.length > 0);
    Object.keys(cols).forEach(function (name) {
      var col = cols[name], n = counts[name] || 0, box = col.querySelector(".cards");
      col.querySelector(".n").textContent = n;
      var empty = box.querySelector(".empty");
      if (n === 0 && !empty) box.appendChild(h("div", "empty", "Nothing here"));
      if (n > 0 && empty) empty.remove();
      if (name === "Stopped") col.hidden = n === 0;
      col.classList.toggle("is-empty", n === 0);
    });
  }

  // ---- footer ----
  function portsText(p) {
    if (Array.isArray(p)) return p.join(", ");
    if (p && typeof p === "object") return Object.keys(p).filter(function (k) { return k !== "block"; }).map(function (k) { return k + " " + p[k]; }).join(" · ");
    return String(p);
  }
  function renderLocks(s) {
    var box = $("locks");
    box.textContent = "";
    ["live", "suite", "commit"].forEach(function (name) {
      var l = s.locks && s.locks[name];
      var held = !!(l && l.held);
      var item = h("span", held ? "lock held-by" : "lock");
      var dot = h("i", held ? "held" : null);
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);
      item.appendChild(document.createTextNode(held ? name + " · " + (l.holder || "held") : name + " free"));
      if (held && l.since) item.title = name + " lock held since " + new Date(l.since).toLocaleTimeString();
      box.appendChild(item);
    });
  }
  function renderFooter(s) {
    var f = $("footer");
    f.textContent = "";
    var pd = h("div");
    pd.appendChild(h("span", "k", "ports"));
    var list = (s.ports || []).map(function (p) { return p.id + ": " + portsText(p.ports); });
    pd.appendChild(h("b", null, list.length ? list.join(" · ") : "none in use"));
    f.appendChild(pd);
    var total = 0, unpriced = 0;
    s.jobs.forEach(function (j) { if (j.cost) { total += Number(j.cost.usd) || 0; unpriced += Number(j.cost.unpriced) || 0; } });
    if (total > 0 || unpriced > 0) {
      var cd = h("div");
      cd.appendChild(h("span", "k", "cost"));
      if (total > 0) { cd.appendChild(h("b", null, usd(total))); cd.appendChild(h("span", "k", " API-equivalent")); }
      if (unpriced > 0) cd.appendChild(h("span", "k", (total > 0 ? " · " : "") + unpriced + " unpriced"));
      f.appendChild(cd);
    }
  }

  // ---- drawer ----
  function openDrawer(id, file) {
    drawerJob = id; drawerFile = file || null;
    $("drawer").classList.add("open");
    renderDrawer();
    if (file) loadFile(file);
  }
  function closeDrawer() { $("drawer").classList.remove("open"); drawerJob = null; drawerFile = null; }
  function renderDrawer() {
    if (!drawerJob || !snap) return;
    var job = snap.jobs.filter(function (j) { return j.id === drawerJob; })[0];
    if (!job) { closeDrawer(); return; }
    $("dtitle").textContent = job.id + " · " + job.title;
    var box = $("files");
    box.textContent = "";
    if (!job.files.length) { box.appendChild(h("span", "empty", "No files yet")); $("content").textContent = ""; $("verdict").className = "tag"; return; }
    job.files.forEach(function (f) {
      var b = h("button", "btn" + (f === drawerFile ? " on" : ""), f);
      b.type = "button";
      b.addEventListener("click", function () { loadFile(f); });
      box.appendChild(b);
    });
    if (!drawerFile) loadFile(job.files[0]);
  }
  function loadFile(rel) {
    drawerFile = rel;
    var id = drawerJob;
    var started = snap && snap.jobs.filter(function (j) { return j.id === id; })[0];
    var updatedAtStart = started ? started.updated : null;
    document.querySelectorAll("#files .btn").forEach(function (b) { b.classList.toggle("on", b.textContent === rel); });
    fetch("/jobs/" + encodeURIComponent(id) + "/file?path=" + encodeURIComponent(rel))
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
      .then(function (res) {
        if (drawerJob !== id || drawerFile !== rel) return;
        var v = $("verdict");
        if (!res.ok) { $("content").textContent = "Could not read this file."; v.className = "tag"; return; }
        $("content").textContent = res.t;
        noteViewed(id, rel, updatedAtStart);
        var first = (res.t.split("\n")[0] || "").trim();
        var vm = VERDICT.exec(first);
        if (vm) {
          v.textContent = first.slice(0, 120);
          v.className = "tag on " + (/^(?:❌|needs fixes|red)$/i.test(vm[0]) ? "bad" : "ok");
        } else v.className = "tag";
      })
      .catch(function () { if (drawerJob === id) $("content").textContent = "Could not read this file."; });
  }
  $("dclose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !/^(TEXTAREA|INPUT)$/.test((e.target && e.target.tagName) || "")) closeDrawer(); });

  // ---- poll ----
  function setConn(ok, text) { var c = $("conn"); c.textContent = text; c.className = "conn" + (ok ? " ok" : " bad"); }
  function refreshDrawer() {
    var job = snap.jobs.filter(function (j) { return j.id === drawerJob; })[0];
    if (!job) { closeDrawer(); return; }
    var have = [].map.call(document.querySelectorAll("#files .btn"), function (b) { return b.textContent; }).join("\n");
    if (have !== job.files.join("\n")) renderDrawer();
  }
  function poll() {
    return fetch("/jobs.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) { var err = new Error("status " + r.status); err.code = b && typeof b.code === "string" ? b.code : null; throw err; }); return r.json(); })
      .then(function (s) {
        snap = s;
        pollMs = (s.board && Number(s.board.pollMs) > 0) ? Number(s.board.pollMs) : 2000;
        $("project").textContent = s.project || "";
        $("demo").classList.toggle("on", !!s.demo);
        renderCards(s);
        renderLocks(s);
        renderFooter(s);
        if (drawerJob) refreshDrawer();
        setConn(true, "updated " + new Date(s.generatedAt).toLocaleTimeString());
      })
      .catch(function (e) { setConn(false, e && e.code ? "board error " + e.code + ", retrying" : "board unreachable, retrying"); });
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (document.hidden) { schedule(); return; }
      poll().then(schedule);
    }, pollMs);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });

  // ---- theme: smoked glass unless the viewer chose porcelain ----
  var theme = "dark";
  function applyTheme(t) {
    var dark = t !== "light";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("theme").textContent = dark ? "Light" : "Dark";
    $("theme").setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
  }
  try { theme = localStorage.getItem("board-theme") === "light" ? "light" : "dark"; } catch (e) { /* storage may be blocked */ }
  applyTheme(theme);
  $("theme").addEventListener("click", function () {
    theme = theme === "light" ? "dark" : "light";
    applyTheme(theme);
    try { localStorage.setItem("board-theme", theme); } catch (e) { /* ignore */ }
  });

  // ---- views: Board and Activity ----
  function viewFromUrl() {
    try {
      var v = new URLSearchParams(location.search).get("view");
      return v === null ? null : v === "activity" ? "activity" : "board";
    } catch (e) { return null; }
  }
  function showView(v, remember) {
    $("board").hidden = v !== "board";
    $("activity").hidden = v !== "activity";
    document.querySelectorAll("#tabs [data-view]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-view") === v ? "true" : "false"); });
    try {
      var u = new URL(location.href);
      if (v === "activity") u.searchParams.set("view", "activity"); else u.searchParams.delete("view");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) { /* ignore */ }
    if (remember) { try { localStorage.setItem("board-view", v); } catch (e) { /* ignore */ } }
  }
  var startView = viewFromUrl();
  if (startView === null) {
    startView = "board";
    try { if (localStorage.getItem("board-view") === "activity") startView = "activity"; } catch (e) { /* storage may be blocked */ }
  }
  showView(startView, false);
  document.querySelectorAll("#tabs [data-view]").forEach(function (b) {
    b.addEventListener("click", function () { showView(b.getAttribute("data-view"), true); });
  });

  poll().then(schedule);
})();
