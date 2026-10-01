// Donyatt Flood Watch page. No dependencies. All text from the API is inserted with textContent.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = (tag, attrs = {}, text) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      // CSS variables only work through style, not presentation attributes.
      if (typeof v === "string" && v.startsWith("var(")) e.style.setProperty(k, v);
      else e.setAttribute(k, String(v));
    }
    if (text != null) e.textContent = text;
    return e;
  };
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // EA timestamps without a zone are UTC.
  const parseTime = (iso) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  const tz = { timeZone: "Europe/London" };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-GB", { ...tz, hour: "2-digit", minute: "2-digit" });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { ...tz, weekday: "short", day: "numeric", month: "short" });
  const fmtDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  function ago(iso) {
    if (!iso) return "unknown";
    const min = Math.round((Date.now() - parseTime(iso)) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    return h < 48 ? `${h} h ${min % 60} min ago` : `${Math.floor(h / 24)} days ago`;
  }

  // ---------------------------------------------------------------- status
  const LABELS = { avoid: "AVOID", caution: "CAUTION", open: "OPEN", unknown: "UNKNOWN" };
  const ICONS = {
    open: "M5 12.5l4.5 4.5L19 7.5",
    caution: "M12 6v7M12 17.5v.01",
    avoid: "M6 12h12",
    unknown: "M9.2 9a3 3 0 1 1 4.3 2.7c-.9.4-1.5 1.1-1.5 2.1v.4M12 17.5v.01",
  };
  const SHORT_NAMES = { "a358-donyatt": "A358", "b3168-ilford-bridges": "B3168", "isle-brewers-fivehead": "Isle Brewers road" };
  const RANK = { open: 0, caution: 1, unknown: 2, avoid: 3 };
  const STATUS_VAR = { open: "--st-open", caution: "--st-caution", avoid: "--st-avoid", unknown: "--st-unknown" };

  function icon(status) {
    const s = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    s.append(svg("circle", { cx: 12, cy: 12, r: 11, fill: "currentColor", opacity: 0.18 }));
    s.append(svg("path", { d: ICONS[status], fill: "none", stroke: "currentColor", "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return s;
  }

  let lastStatus = null;
  let firstStatusRender = true;

  function renderSummary(roads) {
    const worst = roads.reduce((w, r) => (RANK[r.status] > RANK[w] ? r.status : w), "open");
    const same = roads.every((r) => r.status === roads[0].status);
    let text;
    if (same) {
      text = { open: "All three roads open", caution: "Caution on all three roads", avoid: "Avoid all three roads", unknown: "Status unknown: no recent river data" }[worst];
    } else {
      const names = roads.filter((r) => r.status === worst).map((r) => SHORT_NAMES[r.id] || r.name);
      text = `${LABELS[worst][0]}${LABELS[worst].slice(1).toLowerCase()}: ${names.join(", ")}`;
    }
    $("summary").textContent = text;
    $("summary-dot").style.background = `var(${STATUS_VAR[worst]})`;
  }

  function renderRoads(roads) {
    const cards = roads.map((road) => {
      const card = el("article", `road s-${road.status}`);
      if (!firstStatusRender) card.style.animation = "none";
      const chip = el("div", "chip");
      chip.append(icon(road.status), document.createTextNode(LABELS[road.status] || road.status.toUpperCase()));
      const headline = road.headline.replace(/^[A-Za-z]+: (.)/, (_, c) => c.toUpperCase());
      const ul = el("ul");
      for (const reason of road.reasons) ul.append(el("li", null, reason));
      card.append(el("h2", null, road.name), el("p", "where", road.where), chip, el("p", "headline", headline), ul);
      // Every report shows its age.
      const recent = (road.reports?.recent || []).slice(0, 3);
      if (recent.length) {
        const list = el("div", "reports");
        list.append(el("span", "reports-label", "Driver reports"));
        for (const r of recent) {
          const pill = el("span", `pill k-${r.kind}`);
          pill.append(el("span", "pill-dot"), document.createTextNode(`${REPORT_LABELS[r.kind]} · ${r.ageMinutes < 1 ? "just now" : `${r.ageMinutes} min ago`}`));
          list.append(pill);
        }
        card.append(list);
        const withPhoto = (road.reports?.recent || []).find((r) => r.photoId != null);
        if (withPhoto) {
          const a = el("a", "road-photo");
          a.href = `/api/photos/${withPhoto.photoId}`;
          a.target = "_blank";
          a.rel = "noopener";
          const img = el("img");
          img.src = a.href;
          img.loading = "lazy";
          img.alt = `Photo from a driver: ${REPORT_LABELS[withPhoto.kind]}`;
          a.append(img, el("span", null, `Driver photo · ${withPhoto.ageMinutes < 1 ? "just now" : `${withPhoto.ageMinutes} min ago`}`));
          card.append(a);
        }
      }
      if (config.reportsEnabled) {
        const btn = el("button", "report-btn", "Report conditions");
        btn.type = "button";
        btn.addEventListener("click", () => openReport(road));
        card.append(btn);
      }
      return card;
    });
    $("roads").replaceChildren(...cards);
  }

  // Animated water column. Scale 0..2.8 m.
  const TANK = { w: 92, h: 240, top: 10, bottom: 230, max: 2.8 };
  const tankY = (m) => TANK.bottom - (Math.min(Math.max(m, 0), TANK.max) / TANK.max) * (TANK.bottom - TANK.top);
  let tankBuilt = false;
  function renderTank(level) {
    const host = $("tank");
    if (!tankBuilt) {
      const s = svg("svg", { viewBox: `0 0 ${TANK.w} ${TANK.h}` });
      const defs = svg("defs");
      const grad = svg("linearGradient", { id: "water-grad", x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(svg("stop", { offset: "0", "stop-color": "var(--water-1)" }), svg("stop", { offset: "1", "stop-color": "var(--water-2)" }));
      const clip = svg("clipPath", { id: "tank-clip" });
      clip.append(svg("rect", { x: 2, y: TANK.top, width: TANK.w - 4, height: TANK.bottom - TANK.top, rx: 14 }));
      defs.append(grad, clip);
      s.append(defs, svg("rect", { x: 2, y: TANK.top, width: TANK.w - 4, height: TANK.bottom - TANK.top, rx: 14, fill: "var(--surface-2)", stroke: "var(--axis)" }));
      const water = svg("g", { class: "water", "clip-path": "url(#tank-clip)" });
      const wave = (cls, amp, opacity) =>
        svg("path", { class: cls, fill: "url(#water-grad)", opacity, d: `M-40 ${amp} q20 -${amp} 40 0 t40 0 t40 0 t40 0 t40 0 V400 H-40 z` });
      water.append(wave("wave-b", 6, 0.5), wave("wave-a", 4, 1));
      water.id = "tank-water";
      s.append(water);
      for (const [m, cls, label] of [[1.2, "--st-caution", "1.2"], [1.8, "--st-avoid", "1.8"]]) {
        s.append(svg("line", { x1: 2, x2: TANK.w - 2, y1: tankY(m), y2: tankY(m), stroke: `var(${cls})`, "stroke-width": 1.5, "stroke-dasharray": "4 3" }));
        s.append(svg("text", { x: TANK.w - 8, y: tankY(m) - 4, "text-anchor": "end", "font-size": 10, "font-weight": 700, fill: "var(--ink-2)", "paint-order": "stroke", stroke: "var(--surface)", "stroke-width": 3 }, label));
      }
      host.replaceChildren(s);
      // Start empty so the first reading fills up.
      $("tank-water").style.transform = `translateY(${TANK.bottom}px)`;
      tankBuilt = true;
    }
    host.setAttribute("aria-label", level == null ? "River level unavailable" : `River level ${level.toFixed(2)} metres`);
    const y = level == null ? TANK.bottom : tankY(level) - 4;
    requestAnimationFrame(() => requestAnimationFrame(() => { $("tank-water").style.transform = `translateY(${y}px)`; }));
  }

  function renderRiver(river) {
    const fig = $("level-figure");
    if (river.levelM == null) {
      fig.textContent = "–";
    } else {
      fig.replaceChildren(document.createTextNode(river.levelM.toFixed(2)), el("small", null, "m"));
    }
    const arrows = { rising: "↑ Rising", falling: "↓ Falling", steady: "→ Steady" };
    let trend = arrows[river.trend] || "";
    if (river.risePerHourM != null && river.trend && river.trend !== "steady") {
      trend += ` ${river.risePerHourM > 0 ? "+" : ""}${river.risePerHourM.toFixed(2)} m per hour`;
    }
    $("trend").textContent = trend;
    $("reading-age").textContent = river.readingAt ? `Environment Agency reading from ${ago(river.readingAt)} (${fmtTime(parseTime(river.readingAt))})` : "No reading available";
    renderTank(river.levelM);
  }

  function renderOutlook(r) {
    const o = r.outlook;
    const panel = $("outlook");
    const pct = (p) => (p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`);
    if (!o) {
      panel.className = "panel outlook b-none";
      $("outlook-band").textContent = "Unavailable";
      $("outlook-detail").textContent = "Not enough recent river or rain data to make a prediction.";
      $("outlook-meter-fill").style.width = "0%";
      return;
    }
    panel.className = `panel outlook b-${o.band}`;
    $("outlook-band").textContent = { low: "Low", elevated: "Elevated", high: "High" }[o.band];
    $("outlook-p6").textContent = pct(o.p6h);
    $("outlook-p3").textContent = pct(o.p3h);
    $("outlook-meter-fill").style.width = `${Math.max(2, Math.min(100, o.p6h * 100))}%`;
    $("outlook-meter").setAttribute("aria-valuenow", String(Math.round(o.p6h * 100)));
    const basis = o.variant === "forecast"
      ? `Based on the river level, recent rain at Chard and ${o.forecastRain6hMm.toFixed(1)} mm of rain forecast for the next 6 hours.`
      : "Based on the river level and recent rain at Chard (no fresh rain forecast right now).";
    $("outlook-detail").textContent = basis;
  }

  function renderStatus(r) {
    lastStatus = r;
    $("advice").textContent = r.advice;
    $("updated").textContent = `Status worked out ${ago(r.generatedAt)} (${fmtTime(Date.parse(r.generatedAt))}). Refreshes automatically.`;
    renderSummary(r.roads);
    renderRoads(r.roads);
    renderRiver(r.river);
    renderOutlook(r);

    const w = $("warnings");
    if (r.warnings.length) {
      w.replaceChildren(...r.warnings.map((x) => el("p", null, `${x.severity}${x.timeRaised ? ` (raised ${ago(x.timeRaised)})` : ""}`)));
    } else {
      w.textContent = r.warningsCheckedAt ? `No flood alerts or warnings for this area (checked ${ago(r.warningsCheckedAt)}).` : "Not checked yet.";
    }
    const problems = $("problems");
    problems.hidden = !r.dataProblems.length;
    problems.textContent = r.dataProblems.join(" ");
    firstStatusRender = false;
  }

  async function loadStatus() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.roads) throw new Error(body.error || "Status unavailable");
      renderStatus(body);
    } catch {
      if (!lastStatus) {
        $("summary").textContent = "Status unavailable";
        $("roads").replaceChildren(el("div", "error", "The status is unavailable right now. Check conditions yourself, and never drive into floodwater."));
      } else {
        $("updated").textContent = `Couldn't refresh. Showing the status from ${ago(lastStatus.generatedAt)}.`;
      }
    }
  }

  // ---------------------------------------------------------------- tooltip
  const tip = $("tooltip");
  function showTip(host, x, y, title, rows) {
    const t = el("div", "t", title);
    const lines = rows.map(([key, value, label]) => {
      const row = el("div", "row");
      if (key) row.append(el("span", `key ${key}`));
      row.append(el("b", null, value), el("span", null, label));
      return row;
    });
    tip.replaceChildren(t, ...lines);
    const box = host.getBoundingClientRect();
    tip.classList.add("show");
    const tw = tip.offsetWidth;
    let left = box.left + window.scrollX + x + 14;
    if (left + tw > window.scrollX + document.documentElement.clientWidth - 8) left = box.left + window.scrollX + x - tw - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${box.top + window.scrollY + y - 10}px`;
  }
  const hideTip = () => tip.classList.remove("show");

  // ---------------------------------------------------------------- trend charts
  const M = { l: 38, r: 14 };
  let history = null;
  let days = 2;
  let animateCharts = !reducedMotion;
  let hoverIndex = null;

  function niceStep(max, target) {
    const raw = max / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  }

  function timeScale(width) {
    const t0 = Date.parse(history.from);
    const now = Date.parse(history.to);
    // Extend into the future when there's a rain forecast to show.
    const fc = history.rainForecast || [];
    const t1 = fc.length ? Math.max(now, parseTime(fc.at(-1)[0]) + 3_600_000) : now;
    return { t0, t1, now, x: (t) => M.l + ((t - t0) / (t1 - t0)) * (width - M.l - M.r) };
  }

  /** "Now" divider and a shaded forecast zone, when the chart extends into the future. */
  function drawNow(s, x, now, t1, width, top, bottom, label) {
    if (t1 <= now + 60_000) return;
    const nx = x(now);
    s.append(svg("rect", { class: "future", x: nx, y: top, width: width - M.r - nx, height: bottom - top }));
    s.append(svg("line", { class: "now-line", x1: nx, x2: nx, y1: top - 4, y2: bottom }));
    // Right-aligned so it never runs off the edge of a narrow chart.
    if (label) s.append(svg("text", { class: "label", x: width - M.r - 2, y: top + 10, "text-anchor": "end" }, label));
  }

  function drawLevelChart() {
    const host = $("level-chart");
    const width = Math.max(280, host.clientWidth);
    const H = 210, top = 22, bottom = 196;
    const { t0, t1, x } = timeScale(width);
    const pts = history.level.map(([ts, v]) => [parseTime(ts), v]);
    const maxV = Math.max(2.0, ...pts.map((p) => p[1] + 0.15));
    const y = (v) => bottom - (v / maxV) * (bottom - top);
    const s = svg("svg", { viewBox: `0 0 ${width} ${H}`, height: H, role: "img", "aria-label": levelSummary() });

    s.append(svg("text", { class: "title", x: 0, y: 12 }, "Level (m)"));
    const step = niceStep(maxV, 4);
    for (let v = 0; v <= maxV + 1e-9; v += step) {
      s.append(svg("line", { class: v === 0 ? "baseline" : "gridline", x1: M.l, x2: width - M.r, y1: y(v), y2: y(v) }));
      s.append(svg("text", { class: "label", x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(1)));
    }
    for (const [v, cls, label] of [[1.2, "ref-normal", "Top of normal 1.20 m"], [1.8, "ref-flood", "Roads flood 1.80 m"]]) {
      s.append(svg("line", { class: `ref ${cls}`, x1: M.l, x2: width - M.r, y1: y(v), y2: y(v) }));
      // Left end: the latest reading and its label sit at the right.
      s.append(svg("text", { class: "ref-text", x: M.l + 6, y: y(v) - 5 }, label));
    }

    drawNow(s, x, Date.parse(history.to), t1, width, top, bottom, "Forecast");
    if (pts.length) {
      // Break the line across gaps longer than an hour.
      const segs = [];
      let cur = [];
      pts.forEach((p, i) => {
        if (i && p[0] - pts[i - 1][0] > 3_600_000) { segs.push(cur); cur = []; }
        cur.push(p);
      });
      segs.push(cur);
      for (const seg of segs) {
        const d = seg.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join("");
        s.append(svg("path", { class: "area", d: `${d}L${x(seg.at(-1)[0]).toFixed(1)} ${bottom}L${x(seg[0][0]).toFixed(1)} ${bottom}Z` }));
        const line = svg("path", { class: "line", d });
        s.append(line);
        if (animateCharts) {
          line.classList.add("draw");
          requestAnimationFrame(() => line.style.setProperty("--len", String(Math.ceil(line.getTotalLength()))));
        }
      }
      const last = pts.at(-1);
      s.append(svg("circle", { class: "end-dot", cx: x(last[0]), cy: y(last[1]), r: 4.5 }));
      s.append(svg("text", { class: "ref-text", x: x(last[0]) - 8, y: y(last[1]) - 9, "text-anchor": "end" }, `${last[1].toFixed(2)} m`));
    } else {
      s.append(svg("text", { class: "label", x: width / 2, y: (top + bottom) / 2, "text-anchor": "middle" }, "No readings for this period yet"));
    }

    const cross = svg("g", { visibility: "hidden" });
    cross.append(svg("line", { class: "cross", y1: top, y2: bottom }), svg("circle", { class: "hover-dot", r: 5 }));
    s.append(cross);
    host.replaceChildren(s);
    host._chart = { width, x, y, pts, cross, t0, t1 };
  }

  function drawRainChart() {
    const host = $("rain-chart");
    const width = Math.max(280, host.clientWidth);
    const H = 132, top = 20, bottom = 98;
    const { t0, t1, x } = timeScale(width);
    const bars = history.rainHourly.map(([ts, mm]) => [parseTime(ts), mm]);
    const fcBars = (history.rainForecast || []).map(([ts, mm]) => [parseTime(ts), mm]);
    const rawMax = Math.max(2, ...bars.map((b) => b[1]), ...fcBars.map((b) => b[1]));
    const rainStep = niceStep(rawMax, 2);
    const maxV = Math.ceil(rawMax / rainStep) * rainStep;
    const y = (v) => bottom - (v / maxV) * (bottom - top);
    const s = svg("svg", { viewBox: `0 0 ${width} ${H}`, height: H });

    s.append(svg("text", { class: "title", x: 0, y: 12 }, "Rain at Chard (mm per hour)"));
    for (let v = 0; v <= maxV + 1e-9; v += rainStep) {
      s.append(svg("line", { class: v === 0 ? "baseline" : "gridline", x1: M.l, x2: width - M.r, y1: y(v), y2: y(v) }));
      s.append(svg("text", { class: "label", x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, String(Math.round(v * 10) / 10)));
    }
    const slot = x(t0 + 3_600_000) - x(t0);
    const bw = Math.max(1, Math.min(24, slot - 2));
    const fcTotal = fcBars.reduce((sum, b) => sum + b[1], 0);
    drawNow(s, x, Date.parse(history.to), t1, width, top, bottom, fcBars.length ? `Forecast ${fcTotal.toFixed(1)} mm` : null);
    const g = svg("g");
    for (const [list, cls] of [[bars, "bar"], [fcBars, "bar bar-forecast"]]) {
      for (const [t, mm] of list) {
        if (mm <= 0) continue;
        const bx = x(t + 1_800_000) - bw / 2;
        const by = y(mm);
        const r = Math.min(4, bw / 2, bottom - by);
        const d = `M${bx} ${bottom}V${by + r}q0 -${r} ${r} -${r}h${bw - 2 * r}q${r} 0 ${r} ${r}V${bottom}Z`;
        const bar = svg("path", { class: cls, d });
        if (animateCharts) bar.classList.add("grow");
        g.append(bar);
      }
    }
    s.append(g);
    if (!bars.some((b) => b[1] > 0) && !fcBars.some((b) => b[1] > 0)) {
      s.append(svg("text", { class: "label", x: (M.l + width - M.r) / 2, y: (top + bottom) / 2 + 4, "text-anchor": "middle" }, "No rain recorded or forecast"));
    }

    // Shared time axis: day boundaries (midnight UK time) plus a few hour ticks.
    const span = t1 - t0;
    const tickEvery = span <= 86_400_000 * 1.1 ? 6 : span <= 86_400_000 * 2.1 ? 12 : 24;
    for (let t = Math.ceil(t0 / 3_600_000) * 3_600_000; t <= t1; t += 3_600_000) {
      const hour = Number(new Date(t).toLocaleString("en-GB", { ...tz, hour: "2-digit", hourCycle: "h23" }));
      if (hour % tickEvery !== 0) continue;
      const tx = x(t);
      if (tx < M.l + 10 || tx > width - M.r - 10) continue;
      s.append(svg("line", { class: "baseline", x1: tx, x2: tx, y1: bottom, y2: bottom + 4 }));
      s.append(svg("text", { class: "label", x: tx, y: bottom + 17, "text-anchor": "middle" }, hour === 0 ? fmtDay(t) : fmtTime(t)));
    }
    const cross = svg("line", { class: "cross", y1: top, y2: bottom, visibility: "hidden" });
    s.append(cross);
    host.replaceChildren(s);
    host._chart = { x, cross, bars };
  }

  function rainAt(t) {
    const hourStart = Math.floor(t / 3_600_000) * 3_600_000;
    const hit = history.rainHourly.find(([ts]) => parseTime(ts) === hourStart);
    return hit ? hit[1] : null;
  }

  function setHover(i) {
    const lc = $("level-chart")._chart;
    const rc = $("rain-chart")._chart;
    if (!lc || !lc.pts.length || i == null) {
      hoverIndex = null;
      lc?.cross.setAttribute("visibility", "hidden");
      rc?.cross.setAttribute("visibility", "hidden");
      hideTip();
      return;
    }
    hoverIndex = Math.max(0, Math.min(lc.pts.length - 1, i));
    const [t, v] = lc.pts[hoverIndex];
    const cx = lc.x(t);
    lc.cross.setAttribute("visibility", "visible");
    lc.cross.firstChild.setAttribute("x1", cx);
    lc.cross.firstChild.setAttribute("x2", cx);
    lc.cross.lastChild.setAttribute("cx", cx);
    lc.cross.lastChild.setAttribute("cy", lc.y(v));
    rc.cross.setAttribute("visibility", "visible");
    rc.cross.setAttribute("x1", cx);
    rc.cross.setAttribute("x2", cx);
    const rain = rainAt(t);
    showTip($("level-chart"), cx, lc.y(v), `${fmtDay(t)}, ${fmtTime(t)}`, [
      ["level", `${v.toFixed(2)} m`, "river level"],
      ["rain", rain == null ? "–" : `${rain.toFixed(1)} mm`, "rain that hour"],
    ]);
  }

  function nearestIndex(clientX, host) {
    const c = $("level-chart")._chart;
    if (!c || !c.pts.length) return null;
    const box = host.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * c.width;
    let best = 0;
    for (let i = 1; i < c.pts.length; i++) {
      if (Math.abs(c.x(c.pts[i][0]) - px) < Math.abs(c.x(c.pts[best][0]) - px)) best = i;
    }
    return best;
  }

  for (const id of ["level-chart", "rain-chart"]) {
    const host = $(id);
    host.addEventListener("pointermove", (e) => setHover(nearestIndex(e.clientX, host)));
    host.addEventListener("pointerleave", () => setHover(null));
  }
  $("level-chart").addEventListener("keydown", (e) => {
    const c = $("level-chart")._chart;
    if (!c || !c.pts.length) return;
    const stepBy = e.shiftKey ? 4 : 1;
    if (e.key === "ArrowLeft") setHover((hoverIndex ?? c.pts.length) - stepBy);
    else if (e.key === "ArrowRight") setHover((hoverIndex ?? c.pts.length - 2) + stepBy);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  });
  $("level-chart").addEventListener("blur", () => setHover(null));

  function levelSummary() {
    const pts = history.level;
    if (!pts.length) return "River level chart: no readings for this period yet.";
    const vals = pts.map((p) => p[1]);
    return `River level over the last ${days === 7 ? "7 days" : `${days * 24} hours`}: from ${Math.min(...vals).toFixed(2)} to ${Math.max(...vals).toFixed(2)} metres, now ${vals.at(-1).toFixed(2)} metres.`;
  }

  function renderTrendTable() {
    const wrap = $("trend-table");
    if (wrap.hidden || !history) return;
    const table = el("table", "data");
    const head = el("tr");
    head.append(el("th", null, "Time"), el("th", null, "River level"), el("th", null, "Rain that hour"));
    table.append(head);
    for (const [ts, mm] of [...(history.rainForecast || [])].reverse()) {
      const t = parseTime(ts);
      const tr = el("tr");
      tr.append(el("td", null, `${fmtDay(t)} ${fmtTime(t)} (forecast)`), el("td", null, "–"), el("td", null, `${mm.toFixed(1)} mm forecast`));
      table.append(tr);
    }
    // One row per hour (the reading on the hour), newest first.
    const rows = history.level.filter(([ts]) => ts.slice(14, 16) === "00").reverse();
    for (const [ts, v] of rows) {
      const t = parseTime(ts);
      const tr = el("tr");
      const rain = rainAt(t);
      tr.append(el("td", null, `${fmtDay(t)} ${fmtTime(t)}`), el("td", null, `${v.toFixed(2)} m`), el("td", null, rain == null ? "–" : `${rain.toFixed(1)} mm`));
      table.append(tr);
    }
    wrap.replaceChildren(table);
  }

  function drawTrend() {
    if (!history) return;
    drawLevelChart();
    drawRainChart();
    renderTrendTable();
    if (hoverIndex != null) setHover(hoverIndex);
  }

  async function loadHistory() {
    const charts = [$("level-chart"), $("rain-chart")];
    charts.forEach((c) => c.classList.add("loading"));
    try {
      const res = await fetch(`/api/history?days=${days}`);
      const body = await res.json();
      if (!res.ok || !body.level) throw new Error(body.error || "History unavailable");
      history = body;
      hoverIndex = null;
      drawTrend();
      animateCharts = false;
    } catch {
      if (!history) $("level-chart").replaceChildren(el("p", "meta", "The chart is unavailable right now."));
    } finally {
      charts.forEach((c) => c.classList.remove("loading"));
    }
  }

  for (const b of document.querySelectorAll(".seg button")) {
    b.addEventListener("click", () => {
      days = Number(b.dataset.days);
      for (const o of document.querySelectorAll(".seg button")) o.setAttribute("aria-pressed", String(o === b));
      animateCharts = !reducedMotion;
      loadHistory();
    });
  }
  function toggle(buttonId, wrapId, render) {
    $(buttonId).addEventListener("click", (e) => {
      const wrap = $(wrapId);
      wrap.hidden = !wrap.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!wrap.hidden));
      e.currentTarget.textContent = wrap.hidden ? "Show as table" : "Hide table";
      render();
    });
  }
  toggle("table-toggle", "trend-table", renderTrendTable);

  // ---------------------------------------------------------------- past floods
  let past = null;
  let pastAnimated = false;

  function drawPast() {
    if (!past) return;
    const host = $("past-chart");
    const width = Math.max(280, host.clientWidth);
    const H = 214, top = 24, bottom = 184;
    const peaks = new Map(past.annualPeaks.map((p) => [p.year, p.peakM]));
    const eventsByYear = new Map();
    for (const e of past.events) {
      const yr = Number(e.date.slice(0, 4));
      eventsByYear.set(yr, (eventsByYear.get(yr) || 0) + 1);
    }
    const y0 = past.annualPeaks[0].year;
    const y1 = past.annualPeaks.at(-1).year;
    const years = [];
    for (let yr = y0; yr <= y1; yr++) years.push(yr);
    const maxV = 3;
    const y = (v) => bottom - (v / maxV) * (bottom - top);
    const slot = (width - M.l - M.r) / years.length;
    const bw = Math.max(3, Math.min(24, slot - 2));
    const xc = (i) => M.l + slot * (i + 0.5);
    const s = svg("svg", {
      viewBox: `0 0 ${width} ${H}`, height: H, role: "img",
      "aria-label": `Highest river level each year from ${y0} to ${y1}. Roads flooded in ${[...eventsByYear.keys()].filter((k) => k >= y0).length} of these years. Use the table for the values.`,
    });
    for (const v of [0, 1, 2, 3]) {
      s.append(svg("line", { class: v === 0 ? "baseline" : "gridline", x1: M.l, x2: width - M.r, y1: y(v), y2: y(v) }));
      s.append(svg("text", { class: "label", x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, `${v} m`));
    }
    const record = past.annualPeaks.reduce((a, b) => (b.peakM > a.peakM ? b : a));
    years.forEach((yr, i) => {
      const v = peaks.get(yr);
      const bx = xc(i) - bw / 2;
      let mark;
      if (v == null) {
        mark = svg("rect", { class: "missing", x: bx, y: bottom - 3, width: bw, height: 3, rx: 1 });
      } else {
        const by = y(v);
        const r = Math.min(4, bw / 2);
        mark = svg("path", { class: "bar-level", d: `M${bx} ${bottom}V${by + r}q0 -${r} ${r} -${r}h${bw - 2 * r}q${r} 0 ${r} ${r}V${bottom}Z` });
        if (!pastAnimated && !reducedMotion) {
          mark.classList.add("grow");
          mark.style.animationDelay = `${i * 18}ms`;
        }
      }
      s.append(mark);
      // Bigger-than-the-mark hit area.
      const hit = svg("rect", { x: M.l + slot * i, y: top, width: slot, height: bottom - top, fill: "transparent" });
      const show = () => {
        mark.classList.add("hot");
        const n = eventsByYear.get(yr) || 0;
        showTip(host, xc(i), v == null ? bottom : y(v), String(yr), v == null
          ? [[null, "No full record", ""]]
          : [["level", `${v.toFixed(2)} m`, "highest level"], [null, String(n), n === 1 ? "time roads flooded" : "times roads flooded"]]);
      };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("pointermove", show);
      hit.addEventListener("pointerleave", () => { mark.classList.remove("hot"); hideTip(); });
      s.append(hit);
      const labelEvery = slot < 22 ? 5 : slot < 40 ? 2 : 1;
      if (yr % labelEvery === 0 || i === years.length - 1) {
        s.append(svg("text", { class: "label", x: xc(i), y: bottom + 16, "text-anchor": "middle" }, slot < 30 ? `'${String(yr).slice(2)}` : String(yr)));
      }
    });
    const flood = svg("line", { class: "ref ref-flood", x1: M.l, x2: width - M.r, y1: y(past.roadFloodM), y2: y(past.roadFloodM), "pointer-events": "none" });
    s.insertBefore(flood, s.querySelector(".bar-level, .missing"));
    // Key for the reference line, above the plot so it never sits on top of the bars.
    s.append(svg("line", { class: "ref ref-flood", x1: M.l, x2: M.l + 22, y1: 6, y2: 6 }));
    s.append(svg("text", { class: "label", x: M.l + 28, y: 10 }, `Roads flood (${past.roadFloodM.toFixed(2)} m)`));
    const ri = years.indexOf(record.year);
    s.append(svg("text", { class: "ref-text", x: xc(ri), y: y(record.peakM) - 6, "text-anchor": "middle", "pointer-events": "none" }, `${record.peakM.toFixed(2)} m`));
    host.replaceChildren(s);
    pastAnimated = true;
  }

  function renderPastStats() {
    const events = past.events;
    const latest = events.at(-1);
    const first = Number(events[0].date.slice(0, 4));
    const yearsSpan = Number(past.generated.slice(0, 4)) - first + 1;
    const stat = (v, k) => { const d = el("div", "stat"); d.append(el("div", "v", v), el("div", "k", k)); return d; };
    $("past-stats").replaceChildren(
      stat(String(events.length), `times roads flooded since ${first}`),
      stat(`≈${(events.length / yearsSpan).toFixed(1)}`, "times a year on average"),
      stat(new Date(latest.date + "T12:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric" }), `most recent: ${fmtDate(latest.date)}, ${latest.peakM.toFixed(2)} m`),
    );
    const record = events.reduce((a, b) => (b.peakM > a.peakM ? b : a));
    const fact = $("record-fact");
    fact.replaceChildren(document.createTextNode("Highest on record "), el("b", null, `${record.peakM.toFixed(2)} m`), document.createTextNode(` (${fmtDate(record.date)})`));
  }

  function renderPastTable() {
    const wrap = $("past-table");
    if (wrap.hidden || !past) return;
    const table = el("table", "data");
    const head = el("tr");
    head.append(el("th", null, "Date"), el("th", null, "Peak level"));
    table.append(head);
    for (const e of [...past.events].reverse()) {
      const tr = el("tr");
      tr.append(el("td", null, fmtDate(e.date)), el("td", null, `${e.peakM.toFixed(2)} m`));
      table.append(tr);
    }
    wrap.replaceChildren(el("p", "meta", "Every time the river reached road-flooding level (1.80 m), newest first."), table);
  }
  toggle("past-table-toggle", "past-table", renderPastTable);

  async function loadPast() {
    try {
      const res = await fetch("/data/flood-history.json");
      past = await res.json();
      renderPastStats();
      // Animate when scrolled into view.
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { drawPast(); io.disconnect(); }
      }, { rootMargin: "0px 0px -60px 0px" });
      io.observe($("past-chart"));
    } catch {
      $("past-chart").replaceChildren(el("p", "meta", "Flood history is unavailable right now."));
    }
  }

  // ---------------------------------------------------------------- driver reports
  const REPORT_LABELS = { clear: "Clear", care: "Passable with care", do_not_attempt: "Do not attempt" };
  let config = { reportsEnabled: false, photosEnabled: false, turnstileSiteKey: null };
  let reportRoad = null;
  let turnstileToken = null;
  let turnstileWidget = null;
  let pendingKind = null;

  function deviceId() {
    // A random code for rate limiting only; the server never stores it as-is.
    try {
      let id = localStorage.getItem("dfw-device");
      if (!id) { id = crypto.randomUUID(); localStorage.setItem("dfw-device", id); }
      return id;
    } catch {
      return (deviceId.fallback ||= crypto.randomUUID());
    }
  }

  function loadTurnstile() {
    // Check for the API itself: an element with id "turnstile" would also appear as window.turnstile.
    if (typeof window.turnstile?.render === "function") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      sc.async = true;
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error("Spam check failed to load"));
      document.head.append(sc);
    });
  }

  function setReportMessage(text, kind = "") {
    const msg = $("report-msg");
    msg.textContent = text;
    msg.className = `report-msg ${kind}`;
  }

  // ---- optional photo: shrunk and re-drawn on the phone, which also drops location data
  let photoBlob = null;
  async function decodeImage(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Some formats only decode through an <img> (e.g. HEIC on Safari).
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  }
  async function preparePhoto(file) {
    const img = await decodeImage(file);
    const w0 = img.width || img.naturalWidth;
    const h0 = img.height || img.naturalHeight;
    const scale = Math.min(1, 1600 / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const encode = (q) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    let blob = await encode(0.8);
    if (blob && blob.size > 1_400_000) blob = await encode(0.6);
    if (!blob || blob.size > 1_400_000) throw new Error("That photo is too large.");
    return blob;
  }
  function clearPhoto() {
    photoBlob = null;
    $("photo-input").value = "";
    $("photo-preview").hidden = true;
    const thumb = $("photo-thumb");
    if (thumb.src.startsWith("blob:")) URL.revokeObjectURL(thumb.src);
    thumb.removeAttribute("src");
  }
  $("photo-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setReportMessage("Preparing photo…");
    try {
      photoBlob = await preparePhoto(file);
      $("photo-thumb").src = URL.createObjectURL(photoBlob);
      $("photo-preview").hidden = false;
      setReportMessage("Photo ready. Now choose what the road is like.");
    } catch (err) {
      clearPhoto();
      setReportMessage(err.message || "That photo couldn't be used.", "error");
    }
  });
  $("photo-remove").addEventListener("click", () => { clearPhoto(); setReportMessage(""); });

  async function openReport(road) {
    reportRoad = road;
    clearPhoto();
    $("photo-field").hidden = !config.photosEnabled;
    pendingKind = null;
    turnstileToken = null;
    $("report-title").textContent = `What's the ${road.name} like right now?`;
    setReportMessage("");
    for (const b of document.querySelectorAll(".choice")) b.disabled = false;
    $("report-dialog").showModal();
    try {
      await loadTurnstile();
      if (turnstileWidget != null) window.turnstile.remove(turnstileWidget);
      turnstileWidget = window.turnstile.render("#turnstile-box", {
        sitekey: config.turnstileSiteKey,
        action: "report",
        callback: (token) => { turnstileToken = token; if (pendingKind) submitReport(pendingKind); },
        "expired-callback": () => { turnstileToken = null; },
        "error-callback": () => setReportMessage("The spam check couldn't run. Please try again.", "error"),
      });
    } catch {
      setReportMessage("The spam check couldn't load, so reports can't be sent right now.", "error");
    }
  }

  async function submitReport(kind) {
    pendingKind = kind;
    for (const b of document.querySelectorAll(".choice")) b.disabled = true;
    if (!turnstileToken) { setReportMessage("Checking you're human…"); return; }
    setReportMessage("Sending…");
    try {
      const fields = { roadId: reportRoad.id, kind, token: turnstileToken, deviceId: deviceId() };
      let init;
      if (photoBlob) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        form.append("photo", photoBlob, "photo.jpg");
        init = { method: "POST", body: form };
      } else {
        init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) };
      }
      const res = await fetch("/api/reports", init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't send your report.");
      setReportMessage(`Thanks, your report is counted.${body.photoNote ? ` ${body.photoNote}` : ""} Never drive into floodwater.`, "ok");
      clearPhoto();
      loadStatus();
      setTimeout(() => $("report-dialog").open && $("report-dialog").close(), 4000);
    } catch (err) {
      setReportMessage(err.message, "error");
      for (const b of document.querySelectorAll(".choice")) b.disabled = false;
    } finally {
      // Tokens are single-use.
      turnstileToken = null;
      pendingKind = null;
      if (turnstileWidget != null && window.turnstile) window.turnstile.reset(turnstileWidget);
    }
  }

  for (const b of document.querySelectorAll(".choice")) b.addEventListener("click", () => submitReport(b.dataset.kind));
  $("report-close").addEventListener("click", () => $("report-dialog").close());

  async function loadConfig() {
    try {
      config = await (await fetch("/api/config")).json();
    } catch {
      config = { reportsEnabled: false, photosEnabled: false };
    }
  }

  // ---------------------------------------------------------------- wiring
  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { drawTrend(); if (pastAnimated) drawPast(); }, 150);
  });

  loadConfig().then(() => { if (lastStatus) renderRoads(lastStatus.roads); });
  loadStatus();
  loadHistory();
  loadPast();
  setInterval(loadStatus, 2 * 60 * 1000);
  setInterval(loadHistory, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadStatus(); loadHistory(); } });
})();
