(function () {
  "use strict";
  
  const RULES = JSON.parse(document.getElementById("rules").textContent);
  const CP = window.CodingPlan;
  const M = CP.compile(RULES);
  const QS = RULES.questions;
  const N = QS.length;
  const SRC_KEYS = Object.keys(RULES.sources);
  
  const main = document.getElementById("main");
  const live = document.getElementById("announce");
  
  let S = { view: "intro", step: 0, ans: {}, check: null, shared: false, jevSource: null };
  
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pc = (x) => Math.round(x * 100);
  const fmtW = (w) => (Math.round(w * 100) / 100).toString();
  const money = (p) => (p == null ? "Pay per token" : "$" + p + " a month");
  const byId = (id) => M.byId[id];
  
  function refs(keys) {
    return '<span class="refs">' + (keys || []).map((k) => {
      const n = SRC_KEYS.indexOf(k) + 1;
      return n ? '<a href="#src-' + n + '" aria-label="Source ' + n + ": " + esc(RULES.sources[k].label) + '">[' + n + "]</a>" : "";
    }).join(" ") + "</span>";
  }
  
  function evHtml(ev) {
    if (!ev) return "";
    return esc(ev.t) + " " + refs(ev.s) + (ev.u ? ' <span class="unv">Unverified</span><span class="unv-why">' + esc(ev.u) + "</span>" : "");
  }
  
  function say(t) {
    live.textContent = "";
    setTimeout(() => { live.textContent = t; }, 30);
  }
  
  function focusTop() {
    const el = main.querySelector("[data-focus]");
    if (el) el.focus({ preventScroll: false });
    window.scrollTo(0, 0);
  }
  
  function readCode() {
    try {
      return new URLSearchParams(location.search).get("a");
    } catch (e) {
      return null;
    }
  }
  
  function baseUrl() {
    return location.href.split(/[?#]/)[0];
  }
  
  function writeCode(code) {
    try {
      history.replaceState(null, "", code ? "?a=" + code : baseUrl());
    } catch (e) {
      // Ignore
    }
  }
  
  const matches = (cond) => !!cond && Object.keys(cond).every((k) => cond[k].indexOf(String(S.ans[k])) >= 0);
  
  // Call live Jev API
  async function callLiveJev(answers) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch("/api/decide", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ answers }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const result = await response.json();
      return result;
      
    } catch (err) {
      console.warn("Live Jev failed, using local rules:", err.message);
      return null;
    }
  }
  
  // Decide with live Jev or fall back to local
  async function decide(answers) {
    const liveResult = await callLiveJev(answers);
    
    if (liveResult && liveResult.decision && liveResult.output) {
      S.jevSource = liveResult.source;
      return {
        schema_id: "choose_coding_plan",
        output: liveResult.output,
        confidence: liveResult.confidence,
        model: liveResult.model || "jev",
        source: liveResult.source,
        ts: new Date().toISOString()
      };
    }
    
    // Fall back to local rules
    S.jevSource = "offline";
    return CP.decideOffline(M, { answers });
  }
  
  // Question screens
  function opts(name, options, type, value, cls, max) {
    const picks = type === "checkbox" ? (value || []) : [];
    return '<div class="opts ' + (cls || "") + '">' + options.map((o) => {
      const on = type === "checkbox" ? picks.indexOf(o.v) >= 0 : value === o.v;
      const dis = type === "checkbox" && !on && max && picks.length >= max;
      const id = "o-" + name + "-" + o.v;
      return '<label class="opt' + (on ? " on" : "") + (dis ? " dis" : "") + '" for="' + id + '"><input type="' + type + '" id="' + id + '" name="' + name + '" value="' + esc(o.v) + '"' + (on ? " checked" : "") + (dis ? ' disabled aria-disabled="true"' : "") + '><span class="ind ' + type + '" aria-hidden="true"></span><span class="o-t">' + esc(o.t) + "</span>" + (o.d ? '<span class="o-d">' + esc(o.d) + "</span>" : "") + "</label>";
    }).join("") + "</div>";
  }
  
  function answered(q) {
    const a = S.ans;
    if (q.parts) return q.parts.every((p) => a[p.id] != null);
    if (q.multi) return (a[q.id] || []).length > 0;
    if (a[q.id] == null) return false;
    if (q.follow && !matches(q.follow.unless) && a[q.follow.id] == null) return false;
    return true;
  }
  
  function questionScreen() {
    const q = QS[S.step];
    const a = S.ans;
    const segs = QS.map((_, i) => '<i class="' + (i < S.step ? "done" : i === S.step ? "now" : "") + '"></i>').join("");
    
    let body;
    if (q.parts) {
      body = q.parts.map((p) => '<fieldset class="part"><legend class="part-l">' + esc(p.label) + "</legend>" + opts(p.id, p.options, "radio", a[p.id], "chips") + "</fieldset>").join("");
    } else {
      body = '<fieldset><legend class="sr-only">' + esc(q.q) + "</legend>" + opts(q.id, q.options, q.multi ? "checkbox" : "radio", a[q.id], q.options.length > 4 || q.id === "eco" ? "two" : "", q.multi) + "</fieldset>";
    }
    
    if (q.follow && a[q.id] != null && !matches(q.follow.unless)) {
      body += '<fieldset class="follow"><legend class="part-l">' + esc(q.follow.q) + "</legend>" + opts(q.follow.id, q.follow.options, "radio", a[q.follow.id], "two") + "</fieldset>";
    }
    
    const last = S.step === N - 1;
    return '<section class="q" aria-labelledby="qh"><div class="progress" aria-hidden="true">' + segs + "</div>" +
      '<div class="q-meta"><span class="kicker">' + esc(q.kicker) + '</span><span class="count">Question ' + (S.step + 1) + " of " + N + "</span></div>" +
      '<h1 class="q-h" id="qh" data-focus tabindex="-1">' + esc(q.q) + "</h1>" + (q.sub ? '<p class="q-sub">' + esc(q.sub) + "</p>" : "") + body +
      '<nav class="q-nav" aria-label="Quiz navigation"><button class="btn ghost" type="button" data-act="back">&larr; Back</button>' +
      '<button class="btn primary" type="button" data-act="next"' + (answered(q) ? "" : " disabled") + ">" + (last ? "See my pick" : "Next") + ' <span aria-hidden="true">&rarr;</span></button></nav></section>';
  }
  
  function checkScreen() {
    const c = S.check;
    return '<section class="q"><div class="progress" aria-hidden="true">' + QS.map(() => '<i class="done"></i>').join("") + "</div>" +
      '<div class="check-box"><p class="kicker">' + esc(c.kicker) + '</p><h1 class="q-h" data-focus tabindex="-1">' + esc(c.q) + '</h1><p class="q-sub">' + esc(c.sub) + "</p>" +
      '<fieldset><legend class="sr-only">' + esc(c.q) + "</legend>" + opts(c.id, c.options, "radio", S.ans[c.id], "two") + "</fieldset></div>" +
      '<nav class="q-nav" aria-label="Quiz navigation"><button class="btn ghost" type="button" data-act="back">&larr; Back</button><button class="btn primary" type="button" data-act="checked"' + (S.ans[c.id] ? "" : " disabled") + '>See my pick <span aria-hidden="true">&rarr;</span></button></nav></section>';
  }
  
  function introScreen() {
    const list = M.outcomes.map((o) => "<li><b>" + esc(o.name) + "</b>" + esc(money(o.price)) + " &middot; " + esc(o.blurb) + "</li>").join("");
    return '<section class="intro"><p class="kicker">Cursor &middot; Claude Code &middot; Codex &middot; API keys</p>' +
      '<h1 class="display" data-focus tabindex="-1">Which AI coding tool and plan fits you?</h1>' +
      '<p class="dek">Nine questions about your work, how you like to work, and your budget. You get a primary tool and plan, a model routing tip, an optional add-on that fits your budget, and every point of the working. Decisions powered by Jev.</p>' +
      '<div class="cta"><button class="btn primary" type="button" data-act="start">Start the quiz <span aria-hidden="true">&rarr;</span></button><span class="meta">9 questions &middot; about 2 minutes &middot; runs offline, nothing is sent anywhere</span></div>' +
      '<ol class="how"><li><b>1. Answer nine questions</b>Your home base, the job, where you work, stakes, budget and a few practical things.</li>' +
      "<li><b>2. Jev scores 15 options</b>Each answer adds weighted points. Each plan or stack scores 0 to 1 on each thing you asked for, backed by a cited fact. Jev makes the final call live.</li>" +
      "<li><b>3. You see the working</b>Points per answer, close calls, answers that pull in different directions, and what would change the pick.</li></ol>" +
      '<div class="sec-label"><span>The 15 options</span><i></i></div><ul class="field">' + list + "</ul></section>";
  }
  
  // Result screen
  const sec = (label, inner, id) => '<section class="r-sec"' + (id ? ' id="' + id + '"' : "") + '><h2 class="sec-label"><span>' + label + "</span><i></i></h2>" + inner + "</section>";
  const li = (cls, ico, title, body) => '<li class="' + cls + '"><span class="ico" aria-hidden="true">' + ico + "</span><span><b>" + title + "</b>" + (body ? '<span class="ev">' + body + "</span>" : "") + "</span></li>";
  
  function bandOf(c) {
    const POL_MIN = 0.65;
    return c >= 0.85 ? "high" : c >= POL_MIN ? "mid" : "low";
  }
  
  const BAND_TEXT = {
    decisive: "clear lead",
    clear: "a lead of 3 to 6 points",
    close: "close call: check the runner-up",
    weak: "weak match",
    none: "no plan passes your hard constraints"
  };
  
  const SOURCE_TEXT = {
    live: "Live Jev",
    rules: "Rules engine",
    rules_no_key: "Rules engine",
    rules_fallback: "Rules engine",
    offline: "Rules engine",
    stub: "Rules engine"
  };
  
  function jevStrip(d) {
    const o = d.output;
    const b = bandOf(d.confidence);
    const source = SOURCE_TEXT[d.source] || d.source;
    const isLive = d.source === "live";
    
    return '<div class="jev" role="group" aria-label="Jev decision">' +
      '<div class="jev-row"><span class="c-lbl" style="margin:0">Jev decision</span><code>' + esc(d.schema_id) + "</code> <span aria-hidden=\"true\">&rarr;</span> <code>" + esc(o.decision) + "</code></div>" +
      '<div class="jev-row"><span>Confidence <span class="pill ' + b + '">' + d.confidence.toFixed(2) + " " + b + "</span></span><span>" + esc(BAND_TEXT[o.band] || o.band) + "</span></div>" +
      '<div class="jev-row"><span>Source <span class="pill' + (isLive ? " high" : "") + '">' + esc(source) + '</span></span><span class="mono">rules ' + esc(o.rules_version) + "</span></div>" +
      '<p class="fine">Decision ' + (isLive ? "made live by Jev, our decision engine, which" : "computed in your browser using the same rules engine Jev uses, which") + " scores weighted answers against sourced data. Confidence is a rules band, not a probability.</p></div>";
  }
  
  function heroCard(r, d) {
    if (!r.top) {
      return '<article class="card"><div class="card-top"><span>Your pick</span></div><h1 class="r-name" data-focus tabindex="-1">No single plan</h1>' +
        '<p class="r-blurb">Nothing in our list meets all of your hard requirements at once. See what would change that below.</p>' + jevStrip(d) + "</article>";
    }
    
    const o = byId(r.top.id);
    return '<article class="card" aria-labelledby="rname"><div class="card-top"><span>Your pick' + (o.kind === "combo" ? " (a stack)" : "") + "</span><span>" + esc(money(o.price)) + "</span></div>" +
      '<h1 class="r-name" id="rname" data-focus tabindex="-1">' + esc(o.name) + "</h1>" +
      '<p class="r-blurb">' + esc(o.blurb) + "</p>" +
      '<div class="fit"><span class="fit-n">' + pc(r.top.fit) + '% fit</span><span class="bar" role="img" aria-label="' + pc(r.top.fit) + ' percent fit"><i style="width:' + pc(r.top.fit) + '%"></i></span></div>' +
      jevStrip(d) + "</article>";
  }
  
  function shareRow() {
    return '<div class="share" role="group" aria-label="Share your result"><button class="btn primary small" type="button" data-act="copy">Copy share link</button>' +
      '<label class="sr-only" for="share-url">Share link</label><input id="share-url" class="mono" readonly style="flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text)" value="' + esc(baseUrl() + "?a=" + CP.encode(M, S.ans)) + '">' +
      '<output id="copied" aria-live="polite"></output></div>';
  }
  
  function tensionBlocks(ts) {
    return ts.map((t, i) => {
      const side = CP.sideOf(M, S.ans, t);
      const text = side ? "You said this matters more, so it now counts double and the other answer counts half. <button class=\"linkbtn\" type=\"button\" data-tension=\"" + i + "\" data-side=\"reset\">Go back to the default weights</button>" : "With the default weights the pick is " + esc(byId(t.a).name) + ". Tell us which answer matters more and we will weight it double and the other half.";
      
      return '<section class="tension" aria-label="Two answers pulling in different directions"><p class="c-lbl">' + (i ? "Another pull" : "Your answers pull in two directions") + "</p>" +
        '<div class="t-sides"><div class="t-side"><span class="t-ans">&ldquo;' + esc(t.labelA) + '&rdquo;</span><span>points to <b>' + esc(t.nameA) + "</b></span><span class=\"fine\">weight " + fmtW(t.wa) + "</span></div>" +
        '<div class="t-vs" aria-hidden="true">vs</div><div class="t-side"><span class="t-ans">&ldquo;' + esc(t.labelB) + '&rdquo;</span><span>points to <b>' + esc(t.nameB) + "</b></span><span class=\"fine\">weight " + fmtW(t.wb) + "</span></div></div>" +
        '<p class="fine">' + text + '</p><p class="part-l">Which matters more?</p><div class="t-choice">' +
        '<button type="button" data-tension="' + i + '" data-side="a" aria-pressed="' + (side === "a") + '">&ldquo;' + esc(t.labelA) + "&rdquo; &rarr; " + esc(t.nameA) + "</button>" +
        '<button type="button" data-tension="' + i + '" data-side="b" aria-pressed="' + (side === "b") + '">&ldquo;' + esc(t.labelB) + "&rdquo; &rarr; " + esc(t.nameB) + "</button></div></section>";
    }).join("");
  }
  
  function scorecard(r) {
    const cols = r.live.slice(0, 4).map((x) => x.id);
    const units = CP.receipt(M, r, cols);
    const rowOf = {};
    r.live.forEach((x) => { rowOf[x.id] = x; });
    
    let h = '<div class="scroll"><table class="score"><caption class="sr-only">Points each answer gave to the top four options</caption><thead><tr><th scope="col">Your answer</th><th scope="col">Weight</th>' + cols.map((id, i) => '<th scope="col" class="' + (i ? "" : "win") + '">' + esc(byId(id).name) + "</th>").join("") + "</tr></thead><tbody>";
    
    units.forEach((u) => {
      const label = CP.unitLabel(M, u.k, S.ans);
      const changed = Math.abs(u.w - u.base) > 1e-9;
      h += '<tr><th scope="row">' + esc(label) + '</th><td class="num">' + (changed ? '<span class="chg">' + fmtW(u.base) + " &rarr; " + fmtW(u.w) + "</span>" : fmtW(u.w)) + "</td>" + cols.map((id, i) => {
        const b = u.by[id];
        const f = u.feats[0];
        const ev = byId(id).ev[f];
        return '<td class="' + (i ? "" : "win") + '"><button type="button" class="cellbtn" data-ev-o="' + esc(id) + '" data-ev-f="' + esc(f) + '" data-ev-l="' + esc(label) + '" aria-label="' + esc(byId(id).name + ", " + label + ": " + b.pts.toFixed(1) + " of " + fmtW(u.w) + " points. Show the fact behind it.") + '"><span class="mini" aria-hidden="true"><i style="width:' + pc(b.fit) + '%"></i></span>' + b.pts.toFixed(1) + "</button></td>";
      }).join("") + "</tr>";
    });
    
    h += '</tbody><tfoot><tr><th scope="row">Total fit</th><td class="num">' + fmtW(r.total) + "</td>" + cols.map((id, i) => {
      const x = rowOf[id];
      return '<td class="num ' + (i ? "" : "win") + '">' + pc(x.fit) + "%" + (x.factor < 1 ? " (&times;" + fmtW(x.factor) + ")" : "") + "</td>";
    }).join("") + "</tr></tfoot></table></div>";
    
    h += '<p class="ev-out" id="ev-out" aria-live="polite">Select any score to see the fact behind it.</p>';
    h += '<p class="fine">Points = weight &times; how well that option delivers (0 to 1). Total fit = points &divide; ' + fmtW(r.total) + ", times any penalty shown in brackets.</p>";
    return h;
  }
  
  function ranking(r) {
    return '<div class="rank">' + r.live.map((x, i) => '<div class="rk' + (i ? "" : " win") + '"><span class="rk-name">' + esc(x.name) + '</span><span class="bar" aria-hidden="true"><i style="width:' + pc(x.fit) + '%"></i></span><span class="rk-v">' + pc(x.fit) + "%</span></div>").join("") +
      r.ruledOut.map((x) => '<div class="rk out"><span class="rk-name">' + esc(x.name) + "</span><span>Ruled out: " + esc(x.out[0].why) + "</span></div>").join("") + "</div>";
  }
  
  async function resultScreen() {
    const a = S.ans;
    const r = CP.evaluate(M, a);
    
    // Show loading state
    main.innerHTML = '<section class="result"><div class="card"><p class="kicker">Computing your result...</p><h1 class="r-name" data-focus tabindex="-1">Just a moment</h1><p class="r-blurb">Asking Jev to make your decision...</p></div></section>';
    focusTop();
    
    const d = await decide(a);
    const un = CP.unlocks(M, a, r);
    
    let h = "";
    if (S.shared) h += '<div class="banner"><span>Someone shared this result with you.</span><button class="btn small" type="button" data-act="restart">Take the quiz yourself</button></div>';
    
    h += heroCard(r, d) + shareRow();
    
    const unlockList = un.length ? sec(r.top ? "What would change your pick" : "What would change that", '<ul class="r-list">' + un.map((u) => li("tip", "&rarr;", "If you " + esc(u.label) + ": " + esc(u.name), pc(u.fit) + "% fit")).join("") + "</ul>") : "";
    
    if (!r.top) return '<section class="result">' + h + unlockList + sec("Where all 15 landed", ranking(r)) + actions() + "</section>";
    
    const top = r.top;
    const second = r.second;
    const ex = CP.explain(M, top, second);
    const o = byId(top.id);
    const ts = CP.tensions(M, a);
    
    if (r.weak) {
      h += '<div class="callout"><p class="c-lbl">Nothing fits well</p><p>No option reaches 50% on your answers. This is the closest; the breakdown below shows where it falls short.</p></div>';
    } else if (r.tie && second) {
      const gap = Math.max(1, pc(top.fit) - pc(second.fit));
      h += '<div class="callout"><p class="c-lbl">Close call</p><p><b>' + esc(second.name) + "</b> is " + gap + " point" + (gap === 1 ? "" : "s") + " behind" + (ex.edge ? ", and stronger on &ldquo;" + esc(ex.edge.label) + "&rdquo;: " + evHtml(ex.edge.ev) : "") + ".</p></div>";
    }
    
    h += tensionBlocks(ts);
    
    if (ex.fits.length) h += sec("Why " + esc(o.name), '<ul class="r-list">' + ex.fits.map((f) => li("ok", "&check;", esc(f.label), evHtml(f.ev))).join("") + "</ul>");
    
    const cautions = ex.gaps.map((g) => li("no", "&times;", esc(g.label), evHtml(g.ev))).concat(top.limits.concat(top.warns).map((g) => li("warn", "!", esc(g.why), g.ev ? evHtml(g.ev) : "")));
    if (cautions.length) h += sec("Tradeoffs to know", '<ul class="r-list">' + cautions.join("") + "</ul>");
    
    h += sec("Model routing tip", '<ul class="r-list">' + li("tip", "&#9881;", "How to use it", esc(o.routing)) + "</ul>");
    
    const ad = CP.addon(M, a, r);
    if (ad) {
      h += sec("Optional add-on", '<ul class="r-list">' + (ad.kind === "stack" ? li("tip", "+", "Within your budget: " + esc(ad.name) + " (+$" + ad.extra + " a month)", pc(ad.fit) + "% fit on your answers. " + esc(byId(ad.id).routing)) : li("tip", "+", "A capped API key for bots", evHtml(ad.ev))) + "</ul>");
    }
    
    if (second) {
      const e2 = CP.explain(M, top, second).edge;
      h += sec("Runner-up", '<ul class="r-list">' + li("tip", "2", esc(second.name) + " &middot; " + pc(second.fit) + "% fit &middot; " + esc(money(second.price)), esc(byId(second.id).blurb) + (e2 ? " <br>What it does better: <b>" + esc(e2.label) + "</b>. " + evHtml(e2.ev) : " It does nothing better on what you asked for.")) + "</ul>");
    }
    
    h += unlockList;
    h += sec("How every answer scored", scorecard(r));
    h += sec("Where all 15 landed", ranking(r));
    
    return '<section class="result">' + h + actions() + "</section>";
  }
  
  function actions() {
    return '<div class="actions"><button class="btn" type="button" data-act="edit">Change my answers</button><button class="btn ghost" type="button" data-act="restart">Start over</button></div>';
  }
  
  // Footer
  function footer() {
    const f = document.getElementById("foot");
    f.innerHTML = '<p class="asof-note">Data as of Oct 5-6, 2026. Prices are USD per month before tax. These products change monthly; check the pricing pages before you buy.</p>' +
      "<p>Only facts from our research are used. Fit values (0 to 1) are our editorial judgments, each tied to the fact shown with it. Items marked <span class=\"unv\">Unverified</span> could not be confirmed from a primary source.</p>" +
      '<details><summary>What we could not verify</summary><ul class="unv-list">' + RULES.unverified_general.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul></details>" +
      "<details><summary>How Jev decides</summary><p>Each answer adds weighted wants (for example, lock-in 7 if all in, 2.5 if open; the main job 4, split 2 and 2 for two picks; where you work 2 per pick; must-have 3; budget fit 2). Fit = points from all wants divided by the total weight, times any penalty (0.8 for API-key setup if you want it to just work; 0.9 over a flexible budget, a further 0.8 over double it). Hard limits rule options out. A gap under 3 points is a close call; under 50% means nothing fits well. Weights adapted from the AI Daily Brief's Choose Your Agent quiz (<a href=\"https://aidailybrief.ai/play/choose-your-agent\" rel=\"noopener\" target=\"_blank\">aidailybrief.ai/play/choose-your-agent</a>). Jev makes the final call among the remaining candidates.</p></details>" +
      '<h2>Sources</h2><ol>' + SRC_KEYS.map((k, i) => {
        const s = RULES.sources[k];
        return '<li id="src-' + (i + 1) + '">' + (s.url ? '<a href="' + esc(s.url) + '" rel="noopener" target="_blank">' + esc(s.label) + "</a>" : esc(s.label)) + "</li>";
      }).join("") + '</ol><div class="made-by">Made by <a href="https://techtropic.io" rel="noopener" target="_blank">Techtropic</a></div>';
  }
  
  // Render and events
  let firstRender = true;
  
  function render(keepFocusId) {
    if (main.parentElement) {
      main.className = "wrap" + (S.view === "result" ? " wide" : "");
    }
    
    main.innerHTML = S.view === "intro" ? introScreen() : S.view === "q" ? questionScreen() : S.view === "check" ? checkScreen() : "";
    
    if (S.view === "result") {
      resultScreen().then((html) => {
        main.innerHTML = html;
        if (keepFocusId) {
          const el = document.getElementById(keepFocusId);
          if (el && !el.disabled) {
            el.focus();
            return;
          }
        }
        focusTop();
      });
      return;
    }
    
    if (keepFocusId) {
      const el = document.getElementById(keepFocusId);
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
    
    if (firstRender) {
      firstRender = false;
      return;
    }
    
    focusTop();
  }
  
  async function goResult() {
    const c = CP.pendingCheck(M, S.ans);
    if (c) {
      S.check = c;
      S.view = "check";
      render();
      say(c.q);
      return;
    }
    
    S.view = "result";
    writeCode(CP.encode(M, S.ans));
    render();
    
    const r = CP.evaluate(M, S.ans);
    say(r.top ? "Your pick: " + r.top.name + ", " + pc(r.top.fit) + " percent fit." : "No single plan fits your hard requirements.");
  }
  
  main.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.name) return;
    
    const q = QS[S.step];
    if (t.type === "checkbox") {
      let cur = (S.ans[t.name] || []).slice();
      const i = cur.indexOf(t.value);
      if (t.checked && i < 0) cur.push(t.value);
      if (!t.checked && i >= 0) cur.splice(i, 1);
      if (cur.length > (q.multi || 99)) cur = cur.slice(-q.multi);
      S.ans[t.name] = cur;
    } else {
      S.ans[t.name] = t.value;
      if (q && q.follow && t.name === q.id && matches(q.follow.unless)) {
        delete S.ans[q.follow.id];
      }
    }
    
    delete S.ans.priority;
    render(t.id);
  });
  
  main.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    
    const act = b.getAttribute("data-act");
    
    if (act === "start") {
      S.view = "q";
      S.step = 0;
      render();
    } else if (act === "next") {
      if (S.step < N - 1) {
        S.step++;
        render();
      } else {
        goResult();
      }
    } else if (act === "back") {
      if (S.view === "check") {
        S.view = "q";
        S.step = N - 1;
      } else if (S.step > 0) {
        S.step--;
      } else {
        S.view = "intro";
      }
      render();
    } else if (act === "checked") {
      goResult();
    } else if (act === "edit") {
      S.view = "q";
      S.step = N - 1;
      S.shared = false;
      render();
    } else if (act === "restart") {
      S = { view: "intro", step: 0, ans: {}, check: null, shared: false, jevSource: null };
      writeCode(null);
      render();
    } else if (act === "copy") {
      const inp = document.getElementById("share-url");
      const out = document.getElementById("copied");
      const done = () => { out.textContent = "Link copied"; };
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(inp.value).then(done, () => {
          inp.select();
          out.textContent = "Press Ctrl+C or Cmd+C to copy";
        });
      } else {
        inp.select();
        try {
          document.execCommand("copy");
          done();
        } catch (err) {
          out.textContent = "Press Ctrl+C or Cmd+C to copy";
        }
      }
    } else if (b.hasAttribute("data-tension")) {
      const ts = CP.tensions(M, S.ans);
      const t = ts[Number(b.getAttribute("data-tension"))];
      if (t) {
        S.ans = CP.prioritize(M, S.ans, t, b.getAttribute("data-side"));
        writeCode(CP.encode(M, S.ans));
        render();
        const r = CP.evaluate(M, S.ans);
        say("Updated. Your pick: " + (r.top ? r.top.name : "none"));
      }
    } else if (b.hasAttribute("data-ev-o")) {
      const o = byId(b.getAttribute("data-ev-o"));
      const f = b.getAttribute("data-ev-f");
      document.getElementById("ev-out").innerHTML = "<b>" + esc(o.name) + "</b> on &ldquo;" + esc(b.getAttribute("data-ev-l")) + "&rdquo; (" + esc(M.features[f].label) + "): " + evHtml(o.ev[f]);
    }
  });
  
  footer();
  
  const code = readCode();
  const dec = code ? CP.decode(M, code) : null;
  
  if (dec && CP.isComplete(M, dec)) {
    S.ans = dec;
    S.shared = true;
    S.view = "result";
    const pend = CP.pendingCheck(M, dec);
    if (pend) {
      S.check = pend;
      S.view = "check";
      S.shared = false;
    }
    render();
  } else {
    render();
  }
})();
