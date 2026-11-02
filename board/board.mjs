
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
  function buildCard(job, demo) {
    var card = h("article", "card" + (job.needsYou ? " needs" : "") + (job.stage === "stopped" ? " stopped" : "") + (job.active ? " active" : ""));
    card.setAttribute("data-id", job.id);
    var top = h("div", "row");
    var idEl = h("span", "id", job.number ? "M" + job.number : job.id);
    if (job.number) idEl.title = job.id;
    top.appendChild(idEl);
    top.appendChild(h("span", "tag", job.kind));
    top.appendChild(h("span", job.stage === "stopped" ? "tag danger" : "tag", job.stage));
    if (job.needsYou) top.appendChild(h("span", "tag you", "needs you"));
    else if (job.pending) top.appendChild(h("span", "tag you", job.pending));
    if (job.parallel) top.appendChild(h("span", "tag", "parallel: " + job.parallel));
    card.appendChild(top);
    var title = h("button", "title", job.title);
    title.type = "button";
    title.addEventListener("click", function () { openDrawer(job.id); });
    card.appendChild(title);
    if (job.after) card.appendChild(h("div", "hint", "after " + job.after));
    if (job.externalNote) card.appendChild(h("span", "tag ext", job.externalNote + (job.pr ? " · PR #" + job.pr : "")));
    if (job.activity && job.activity.note) card.appendChild(h("div", "branch", job.activity.note));
    if (job.branch) card.appendChild(h("div", "branch", job.branch));
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
  function sigOf(job, demo) {
    var o = Object.assign({}, job); delete o.elapsedMs; delete o.updated;
    return JSON.stringify([o, demo]);
  }
  function renderCards(s) {
    var demo = !!s.demo, seen = {}, counts = {};
    s.jobs.forEach(function (job) {
      var col = cols[job.column] || cols["Stopped"];
      var name = col.getAttribute("data-column");
      seen[job.id] = true;
      counts[name] = (counts[name] || 0) + 1;
      var sig = sigOf(job, demo), cur = cards[job.id];
      if (!cur || cur.sig !== sig) {
        var fresh = buildCard(job, demo);
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
      var box = col.querySelector(".cards");
      if (cur.el.parentNode !== box) box.appendChild(cur.el);
    });
    Object.keys(cards).forEach(function (id) { if (!seen[id]) { cards[id].el.remove(); delete cards[id]; } });
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
  function renderFooter(s) {
    var f = $("footer");
    f.textContent = "";
    ["live", "suite", "commit"].forEach(function (name) {
      var l = s.locks && s.locks[name];
      var d = h("div");
      d.appendChild(h("span", "k", name + " lock"));
      d.appendChild(h("b", null, l && l.held ? (l.holder || "held") : "free"));
      f.appendChild(d);
    });
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
  function setConn(ok, text) { var c = $("conn"); c.textContent = text; c.className = "conn" + (ok ? "" : " bad"); }
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

  // ---- theme ----
  function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
  try { applyTheme(localStorage.getItem("board-theme")); } catch (e) { /* storage may be blocked */ }
  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var light = cur ? cur === "light" : window.matchMedia("(prefers-color-scheme: light)").matches;
    var next = light ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem("board-theme", next); } catch (e) { /* ignore */ }
  });

  poll().then(schedule);
})();
