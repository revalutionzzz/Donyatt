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
  const SHORT_NAMES = { "a358-donyatt": "A358" };
  const RANK = { open: 0, caution: 1, unknown: 2, avoid: 3 };
  const STATUS_VAR = { open: "--st-open", caution: "--st-caution", avoid: "--st-avoid", unknown: "--st-unknown" };

  function icon(status) {
    const s = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    s.append(svg("circle", { cx: 12, cy: 12, r: 11, fill: "currentColor", opacity: 0.18 }));
    s.append(svg("path", { d: ICONS[status], fill: "none", stroke: "currentColor", "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return s;
  }

  let lastStatus = null;

  function renderSummary(roads) {
    const worst = roads.reduce((w, r) => (RANK[r.status] > RANK[w] ? r.status : w), "open");
    const same = roads.every((r) => r.status === roads[0].status);
    let text;
    if (roads.length === 1) {
      const name = SHORT_NAMES[roads[0].id] || roads[0].name;
      text = { open: `${name} open`, caution: `Caution on the ${name}`, avoid: `Avoid the ${name}`, unknown: "Status unknown: no recent river data" }[worst];
    } else if (same) {
      text = { open: "All roads open", caution: "Caution on all roads", avoid: "Avoid all roads", unknown: "Status unknown: no recent river data" }[worst];
    } else {
      const names = roads.filter((r) => r.status === worst).map((r) => SHORT_NAMES[r.id] || r.name);
      text = `${LABELS[worst][0]}${LABELS[worst].slice(1).toLowerCase()}: ${names.join(", ")}`;
    }
    $("summary").textContent = text;
    $("summary-dot").style.background = `var(${STATUS_VAR[worst]})`;
    // The header tints for Caution and Avoid, so the state registers before anyone reads it.
    document.querySelector(".hero").dataset.status = worst;
  }

  // Road cards are updated in place (not rebuilt), so a status change can fade between colours.
  const cards = new Map();
  function buildCard(road) {
    const card = el("article", "road");
    const chip = el("div", "chip");
    const chipIcon = el("span", "chip-icon");
    const chipText = el("span");
    chip.append(chipIcon, chipText);
    const headline = el("p", "headline");
    const ul = el("ul");
    const extras = el("div", "extras");
    card.append(el("h2", null, road.name), el("p", "where", road.where), chip, headline, ul, extras);
    const parts = { card, chip, chipIcon, chipText, headline, ul, extras, status: null, road };
    cards.set(road.id, parts);
    return parts;
  }

  function renderRoads(roads) {
    const host = $("roads");
    roads.forEach((road, i) => {
      const p = cards.get(road.id) || buildCard(road);
      p.road = road;
      if (host.children[i] !== p.card) host.insertBefore(p.card, host.children[i] || null);
      if (p.status !== road.status) {
        p.card.className = `road s-${road.status}`;
        p.chipIcon.replaceChildren(icon(road.status));
        p.chipText.textContent = LABELS[road.status] || road.status.toUpperCase();
        // A change after the first render gets a brief highlight.
        if (p.status !== null && !reducedMotion) {
          p.card.classList.add("changed");
          setTimeout(() => p.card.classList.remove("changed"), 1600);
        }
        p.status = road.status;
      }
      p.headline.textContent = road.headline.replace(/^[A-Za-z]+: (.)/, (_, c) => c.toUpperCase());
      const reasons = road.reasons.map((reason) => el("li", null, reason));
      p.ul.replaceChildren(...reasons);

      const extras = [];
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
        extras.push(list);
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
          extras.push(a);
        }
      }
      if (!recent.length && config.reportsEnabled) extras.push(el("p", "no-reports", "No driver reports in the last 3 hours."));
      if (config.reportsEnabled) {
        const btn = el("button", "report-btn", "Report conditions");
        btn.type = "button";
        btn.addEventListener("click", () => openReport(p.road));
        extras.push(btn);
      }
      p.extras.replaceChildren(...extras);
    });
    // Drop anything else (an old error message, or a road no longer listed).
    const keep = new Set(roads.map((r) => cards.get(r.id).card));
    for (const child of [...host.children]) if (!keep.has(child)) child.remove();
  }

  // ---- Numbers that glide to their new value.
  const easeOut = (t) => 1 - (1 - t) ** 3;
  function countTo(node, to, { decimals = 2, suffix = null, duration = 900 } = {}) {
    const from = Number.isFinite(node._value) ? node._value : 0;
    node._value = to;
    const paint = (v) => {
      if (suffix) node.replaceChildren(document.createTextNode(v.toFixed(decimals)), el("small", null, suffix));
      else node.textContent = v.toFixed(decimals);
    };
    if (reducedMotion || from === to) return paint(to);
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / duration);
      paint(from + (to - from) * easeOut(k));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- River gauge: water that rises on a spring and sloshes.
  // Scale 0..2.8 m. The surface is redrawn each frame from a damped "slosh" (tilt) plus two
  // travelling ripples; level changes and taps kick the slosh. Runs only while on screen.
  // floor: 0 m sits above the tube's rounded bottom, so a normal low river still shows water.
  const TANK = { w: 110, h: 260, top: 10, bottom: 250, floor: 26, max: 2.8, inset: 3 };
  const tankY = (m) => TANK.bottom - TANK.floor - (Math.min(Math.max(m, 0), TANK.max) / TANK.max) * (TANK.bottom - TANK.floor - TANK.top);
  const water = {
    built: false, y: TANK.bottom, vy: 0, target: TANK.bottom, tilt: 0, vtilt: 0, t: 0,
    rising: false, bubbles: [], running: false, onScreen: true, last: 0, nextNudge: 0,
    // Phone motion: the surface's resting tilt follows gravity; shakes push the slosh.
    eq: 0, gravityTilt: 0, shake: 0, motion: "off",
    front: null, back: null, bubbleLayer: null,
  };

  function buildTank() {
    const host = $("tank");
    const { w, top, bottom, inset } = TANK;
    const s = svg("svg", { viewBox: `0 0 ${w} ${TANK.h}` });
    const defs = svg("defs");
    const grad = svg("linearGradient", { id: "water-grad", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svg("stop", { offset: "0", "stop-color": "var(--water-1)" }), svg("stop", { offset: "1", "stop-color": "var(--water-2)" }));
    const glass = svg("linearGradient", { id: "glass-grad", x1: 0, y1: 0, x2: 1, y2: 0 });
    glass.append(svg("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": 0 }), svg("stop", { offset: "0.25", "stop-color": "#fff", "stop-opacity": 0.22 }), svg("stop", { offset: "0.45", "stop-color": "#fff", "stop-opacity": 0 }));
    const clip = svg("clipPath", { id: "tank-clip" });
    clip.append(svg("rect", { x: inset, y: top, width: w - 2 * inset, height: bottom - top, rx: 16 }));
    defs.append(grad, glass, clip);
    s.append(defs, svg("rect", { x: inset, y: top, width: w - 2 * inset, height: bottom - top, rx: 16, fill: "var(--surface-2)" }));
    const g = svg("g", { "clip-path": "url(#tank-clip)" });
    water.back = svg("path", { fill: "url(#water-grad)", opacity: 0.45 });
    water.front = svg("path", { fill: "url(#water-grad)" });
    water.bubbleLayer = svg("g", { fill: "#fff", "fill-opacity": 0.55 });
    g.append(water.back, water.front, water.bubbleLayer, svg("rect", { x: inset, y: top, width: w - 2 * inset, height: bottom - top, fill: "url(#glass-grad)" }));
    s.append(g, svg("rect", { x: inset, y: top, width: w - 2 * inset, height: bottom - top, rx: 16, fill: "none", stroke: "var(--axis)" }));
    // Faint scale ticks on the left (1 and 2 m), so the column reads as a measure.
    for (const m of [1, 2]) {
      s.append(svg("line", { x1: inset, x2: inset + 10, y1: tankY(m), y2: tankY(m), stroke: "var(--axis)", "stroke-width": 1.5 }));
      s.append(svg("text", { x: inset + 13, y: tankY(m) + 3.5, "font-size": 9, fill: "var(--muted)", "paint-order": "stroke", stroke: "var(--surface-2)", "stroke-width": 2 }, `${m} m`));
    }
    for (const [m, cls, label] of [[1.2, "--st-caution", "1.2 m"], [1.8, "--st-avoid", "1.8 m"]]) {
      s.append(svg("line", { x1: inset, x2: w - inset, y1: tankY(m), y2: tankY(m), stroke: `var(${cls})`, "stroke-width": 1.5, "stroke-dasharray": "4 3" }));
      s.append(svg("text", { x: w - 9, y: tankY(m) - 5, "text-anchor": "end", "font-size": 10, "font-weight": 700, fill: "var(--ink-2)", "paint-order": "stroke", stroke: "var(--surface)", "stroke-width": 3 }, label));
    }
    host.replaceChildren(s);
    host.tabIndex = 0;
    const splash = () => slosh(9);
    host.addEventListener("pointerdown", splash);
    // iPhones only allow motion access after a tap, so ask on the first click.
    host.addEventListener("click", () => enableMotion(true));
    enableMotion(false);
    host.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); splash(); } });
    new IntersectionObserver((entries) => {
      water.onScreen = entries.some((e) => e.isIntersecting);
      startWater();
    }).observe(host);
    document.addEventListener("visibilitychange", startWater);
    water.built = true;
  }

  function slosh(strength) {
    water.vtilt += strength * (water.vtilt >= 0 ? 1 : -1) * (0.8 + Math.random() * 0.4);
    startWater();
  }

  function drawWater() {
    const { w, inset } = TANK;
    const left = inset - 2;
    const right = w - inset + 2;
    const n = 22;
    const surface = (phase, amp) => {
      let d = "";
      for (let i = 0; i <= n; i++) {
        const x = left + ((right - left) * i) / n;
        const rel = (x - w / 2) / (w / 2);
        const y = water.y + water.tilt * rel
          + amp * (2.2 * Math.sin(x * 0.085 + water.t * 2.1 + phase) + 1.3 * Math.sin(x * 0.19 - water.t * 3.4 + phase * 1.7));
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(2)}`;
      }
      return `${d}L${right} ${TANK.h + 20}L${left} ${TANK.h + 20}Z`;
    };
    water.front.setAttribute("d", surface(0, 1));
    water.back.setAttribute("d", surface(2.4, 1.3));
    // Bubbles while the river is rising.
    const kids = water.bubbleLayer.children;
    water.bubbles.forEach((b, i) => {
      let c = kids[i];
      if (!c) { c = svg("circle"); water.bubbleLayer.append(c); }
      c.setAttribute("cx", b.x.toFixed(1));
      c.setAttribute("cy", b.y.toFixed(1));
      c.setAttribute("r", b.r);
    });
    while (kids.length > water.bubbles.length) kids[kids.length - 1].remove();
  }

  function stepWater(now) {
    const dt = Math.min(0.05, (now - water.last) / 1000 || 0.016);
    water.last = now;
    // Level: a slightly under-damped spring towards the target, so it settles with a gentle bob.
    const k = 9;
    const ay = k * (water.target - water.y) - 2 * Math.sqrt(k) * 0.75 * water.vy;
    water.vy += ay * dt;
    water.y += water.vy * dt;
    // Slosh: a damped oscillator; moving water sets it going too.
    const omega = 3.4;
    // The resting tilt eases towards where gravity says the surface should lie.
    water.eq += (water.gravityTilt - water.eq) * Math.min(1, dt * 6);
    water.vtilt += water.shake * dt;
    water.shake *= Math.exp(-dt * 10);
    const at = -omega * omega * (water.tilt - water.eq) - 2 * 0.09 * omega * water.vtilt + water.vy * 0.6;
    water.vtilt += at * dt;
    water.tilt += water.vtilt * dt;
    water.t += dt;
    // An occasional small nudge so it always looks like water, not a still image.
    if (now > water.nextNudge) {
      water.vtilt += (Math.random() - 0.5) * 6;
      water.nextNudge = now + 4000 + Math.random() * 5000;
    }
    if (water.rising && water.bubbles.length < 7 && Math.random() < dt * 2.2) {
      water.bubbles.push({ x: 12 + Math.random() * (TANK.w - 24), y: TANK.bottom - 4, r: 1.2 + Math.random() * 2, v: 18 + Math.random() * 22, wob: Math.random() * 6 });
    }
    for (const b of water.bubbles) {
      b.y -= b.v * dt;
      b.x += Math.sin(water.t * 3 + b.wob) * 0.25;
    }
    water.bubbles = water.bubbles.filter((b) => b.y > water.y + 4);
    drawWater();
    if (water.onScreen && !document.hidden) requestAnimationFrame(stepWater);
    else water.running = false;
  }

  // ---- Accelerometer: tilt the phone and the water stays level with the world; shake it to splash.
  const MAX_TILT_DEG = 35;
  function screenAngle() {
    const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    return ((a % 360) + 360) % 360;
  }
  function onOrientation(e) {
    if (e.gamma == null || e.beta == null) return;
    // Sideways tilt relative to the screen as currently held.
    const angle = screenAngle();
    const sideways = angle === 90 ? e.beta : angle === 270 ? -e.beta : angle === 180 ? -e.gamma : e.gamma;
    const deg = Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, sideways));
    // Tilted right (right edge down): water piles up on the right, which is a smaller y in SVG.
    water.gravityTilt = -Math.tan((deg * Math.PI) / 180) * (TANK.w / 2);
    if (water.motion !== "on") { water.motion = "on"; startWater(); }
  }
  function onMotion(e) {
    const a = e.acceleration;
    if (!a || a.x == null) return;
    const angle = screenAngle();
    const sideways = angle === 90 ? -a.y : angle === 270 ? a.y : angle === 180 ? -a.x : a.x;
    // Ignore sensor noise; a real shake is a few m/s².
    if (Math.abs(sideways) > 1.2) water.shake += -sideways * 14;
  }
  function listenForMotion() {
    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
  }
  function enableMotion(fromTap) {
    if (reducedMotion || water.motion !== "off" || !("DeviceOrientationEvent" in window)) return;
    const needsPermission = typeof DeviceOrientationEvent.requestPermission === "function";
    if (!needsPermission) {
      water.motion = "listening";
      listenForMotion();
      return;
    }
    // iOS: permission can only be requested from a tap, so never ask on page load.
    if (!fromTap) return;
    water.motion = "asking";
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === "granted") {
          listenForMotion();
          if (typeof DeviceMotionEvent?.requestPermission === "function") DeviceMotionEvent.requestPermission().catch(() => {});
          water.motion = "listening";
        } else {
          water.motion = "denied";
        }
      })
      .catch(() => { water.motion = "off"; });
  }

  function startWater() {
    if (!water.built) return;
    if (reducedMotion) {
      water.y = water.target;
      water.tilt = 0;
      water.bubbles = [];
      drawWater();
      return;
    }
    if (water.running || !water.onScreen || document.hidden) return;
    water.running = true;
    water.last = performance.now();
    requestAnimationFrame(stepWater);
  }

  function renderTank(level, trend) {
    if (!water.built) buildTank();
    const host = $("tank");
    host.setAttribute("aria-label", level == null ? "River level unavailable" : `River level ${level.toFixed(2)} metres. Tap to make the water slosh.`);
    const target = level == null ? TANK.bottom : tankY(level) - 3;
    const change = Math.abs(target - water.target);
    water.target = target;
    water.rising = trend === "rising";
    // A new level makes a splash in proportion to the change.
    if (change > 0.5) slosh(Math.min(14, 4 + change * 0.6));
    startWater();
  }

  function renderRiver(river) {
    const fig = $("level-figure");
    if (river.levelM == null) {
      fig._value = undefined;
      fig.textContent = "–";
    } else {
      countTo(fig, river.levelM, { decimals: 2, suffix: "m" });
    }
    const arrows = { rising: "↑ Rising", falling: "↓ Falling", steady: "→ Steady" };
    let trend = arrows[river.trend] || "";
    if (river.risePerHourM != null && river.trend && river.trend !== "steady") {
      trend += ` ${river.risePerHourM > 0 ? "+" : ""}${river.risePerHourM.toFixed(2)} m per hour`;
    }
    $("trend").textContent = trend;
    // When it's high and rising, say when it would reach road-flooding level at this rate.
    const eta = $("eta");
    let etaText = "";
    if (river.levelM != null && river.trend === "rising" && river.risePerHourM > 0 && river.readingAt) {
      if (river.levelM >= 1.8) {
        etaText = "Above road-flooding level (1.80 m) and still rising.";
      } else if (river.levelM >= 1.0) {
        const hours = (1.8 - river.levelM) / river.risePerHourM;
        if (hours <= 12) etaText = `At this rate: road-flooding level (1.80 m) around ${fmtTime(parseTime(river.readingAt) + hours * 3_600_000)}. It could be sooner.`;
      }
    }
    eta.textContent = etaText;
    eta.hidden = !etaText;
    $("reading-age").textContent = river.readingAt ? `Environment Agency reading from ${ago(river.readingAt)} (${fmtTime(parseTime(river.readingAt))})` : "No reading available";
    renderTank(river.levelM, river.trend);
  }

  // Swap only the band class, keeping any animation classes on the panel.
  function setBand(panel, band) {
    for (const b of ["none", "low", "elevated", "high"]) panel.classList.toggle(`b-${b}`, b === band);
  }

  function renderOutlook(r) {
    const o = r.outlook;
    const panel = $("outlook");
    const pct = (p) => (p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`);
    if (!o) {
      setBand(panel, "none");
      $("outlook-band").textContent = "Unavailable";
      $("outlook-detail").textContent = "Not enough recent river or rain data to make a prediction.";
      $("outlook-meter-fill").style.width = "0%";
      $("outlook-by6").textContent = $("outlook-by3").textContent = "";
      return;
    }
    setBand(panel, o.band);
    $("outlook-band").textContent = { low: "Low", elevated: "Elevated", high: "High" }[o.band];
    $("outlook-p6").textContent = pct(o.p6h);
    // Clock times for the school run and commute: the windows run from the reading the outlook used.
    const base = parseTime(o.asOf);
    $("outlook-by6").textContent = `by ${fmtTime(base + 6 * 3_600_000)}`;
    $("outlook-by3").textContent = `by ${fmtTime(base + 3 * 3_600_000)}`;
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
  function drawNow(s, x, now, t1, width, top, bottom, label, label2) {
    if (t1 <= now + 60_000) return;
    const nx = x(now);
    s.append(svg("rect", { class: "future", x: nx, y: top, width: width - M.r - nx, height: bottom - top }));
    s.append(svg("line", { class: "now-line", x1: nx, x2: nx, y1: top - 4, y2: bottom }));
    // Right-aligned so it never runs off the edge of a narrow chart.
    if (label) s.append(svg("text", { class: "label", x: width - M.r - 2, y: top + 10, "text-anchor": "end" }, label));
    if (label2) s.append(svg("text", { class: "label", x: width - M.r - 2, y: top + 24, "text-anchor": "end" }, label2));
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

    // Shaded to line up with the rain forecast below; there's no river level forecast.
    drawNow(s, x, Date.parse(history.to), t1, width, top, bottom, null);
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
    const chance = maxChance();
    drawNow(s, x, Date.parse(history.to), t1, width, top, bottom,
      fcBars.length ? (fcTotal >= 0.05 ? `Forecast ${fcTotal.toFixed(1)} mm` : "Forecast: dry") : null,
      chance == null ? null : `Up to ${chance}% chance of rain`);
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
    if (!bars.some((b) => b[1] > 0)) {
      // Centred on the past part of the chart, so it never runs into the forecast zone.
      const pastEnd = fcBars.length ? x(Date.parse(history.to)) : width - M.r;
      const text = fcBars.length ? "No rain recorded" : "No rain recorded or forecast";
      s.append(svg("text", { class: "label", x: (M.l + pastEnd) / 2, y: (top + bottom) / 2 + 4, "text-anchor": "middle" }, text));
    }

    // Shared time axis: day boundaries (midnight UK time) plus a few hour ticks.
    const span = t1 - t0;
    const tickEvery = span <= 86_400_000 * 1.1 ? 6 : span <= 86_400_000 * 2.1 ? 12 : 24;
    // Narrow charts (7 days on a phone) get short day labels ("Thu 1"), and any label that
    // would run into the previous one is skipped, so labels never overlap.
    const dayPx = x(t0 + 86_400_000) - x(t0);
    const shortDay = (t) => new Date(t).toLocaleDateString("en-GB", { ...tz, weekday: "short", day: "numeric" }).replace(",", "");
    const dayLabel = dayPx < 80 ? shortDay : fmtDay;
    const textW = (str) => str.length * 6.2; // 11px label font, roughly
    let lastRight = -Infinity;
    for (let t = Math.ceil(t0 / 3_600_000) * 3_600_000; t <= t1; t += 3_600_000) {
      const hour = Number(new Date(t).toLocaleString("en-GB", { ...tz, hour: "2-digit", hourCycle: "h23" }));
      if (hour % tickEvery !== 0) continue;
      const tx = x(t);
      if (tx < M.l + 10 || tx > width - M.r - 10) continue;
      s.append(svg("line", { class: "baseline", x1: tx, x2: tx, y1: bottom, y2: bottom + 4 }));
      const label = hour === 0 ? dayLabel(t) : fmtTime(t);
      const half = textW(label) / 2;
      if (tx - half < lastRight + 6 || tx + half > width) continue;
      s.append(svg("text", { class: "label", x: tx, y: bottom + 17, "text-anchor": "middle" }, label));
      lastRight = tx + half;
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
    for (const [ts, mm, prob] of [...(history.rainForecast || [])].reverse()) {
      const t = parseTime(ts);
      const tr = el("tr");
      tr.append(el("td", null, `${fmtDay(t)} ${fmtTime(t)} (forecast)`), el("td", null, "–"), el("td", null, `${mm.toFixed(1)} mm forecast${mm < 0.05 && typeof prob === "number" ? ` (${prob}% chance of rain)` : ""}`));
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

  /** Forecast rain over the next `hours`, counting the current hour pro rata. */
  function forecastRain(hours) {
    const now = Date.parse(history.to);
    const end = now + hours * 3_600_000;
    let total = 0;
    for (const [ts, mm] of history.rainForecast || []) {
      const start = parseTime(ts);
      total += mm * Math.max(0, Math.min(start + 3_600_000, end) - Math.max(start, now)) / 3_600_000;
    }
    return total;
  }

  /**
   * Highest forecast chance of rain (%) over the next 12 h, or null. Only used when the forecast
   * amount is dry: the amount and the chance come from different Open-Meteo models, so showing
   * "1.4 mm" beside "2% chance" reads as a contradiction.
   */
  function maxChance() {
    const fc = history.rainForecast || [];
    if (fc.some((h) => h[1] >= 0.05)) return null;
    const probs = fc.map((h) => h[2]).filter((p) => typeof p === "number");
    return probs.length ? Math.max(...probs) : null;
  }

  /** Numbers for the forecast, so it reads even when the bars are empty (a dry forecast). */
  function renderForecastSummary() {
    const box = $("forecast-summary");
    const fc = history.rainForecast || [];
    if (!fc.length) {
      box.textContent = "No rain forecast available right now.";
      return;
    }
    const mm = (v) => `${v.toFixed(1)} mm`;
    const parts = [3, 6, 12].map((h) => {
      const span = el("span", null, `Next ${h} h `);
      span.append(el("b", null, mm(forecastRain(h))));
      return span;
    });
    const chance = maxChance();
    if (chance != null) {
      const span = el("span", null, "Chance of any rain up to ");
      span.append(el("b", null, `${chance}%`));
      parts.push(span);
    }
    const wettest = fc.reduce((a, b) => (b[1] > a[1] ? b : a));
    const note = wettest[1] >= 0.1
      ? `Wettest hour ${fmtTime(parseTime(wettest[0]))}–${fmtTime(parseTime(wettest[0]) + 3_600_000)}, ${mm(wettest[1])}.`
      : chance != null && chance >= 20
        ? "Mostly dry: showers possible but no measurable amount forecast."
        : "Dry: no rain forecast for the next 12 hours.";
    const updated = history.forecastFetchedAt ? ` Forecast updated ${fmtTime(Date.parse(history.forecastFetchedAt))}.` : "";
    const title = el("span", "fc-title", "Forecast rain at Chard");
    box.replaceChildren(title, ...parts, el("span", "fc-note", note + updated));
  }

  /** Last 24 h low/high under the gauge, from the chart data. */
  function renderRange() {
    const fact = $("range-fact");
    const since = Date.parse(history.to) - 86_400_000;
    const vals = history.level.filter(([ts]) => parseTime(ts) >= since).map(([, v]) => v);
    fact.hidden = vals.length < 2;
    if (fact.hidden) return;
    fact.replaceChildren(document.createTextNode("Last 24 h "), el("b", null, `${Math.min(...vals).toFixed(2)}–${Math.max(...vals).toFixed(2)} m`));
  }

  function drawTrend() {
    if (!history) return;
    renderRange();
    drawLevelChart();
    drawRainChart();
    renderForecastSummary();
    renderTrendTable();
    if (hoverIndex != null) setHover(hoverIndex);
  }

  async function loadHistory() {
    const charts = [$("level-chart"), $("rain-chart")];
    charts.forEach((c) => c.classList.add("loading"));
    try {
      const res = await fetch(`/api/history?days=${days}`, { cache: "no-store" });
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
  function toggle(buttonId, wrapId, render, labels = ["Show as table", "Hide table"]) {
    $(buttonId).addEventListener("click", (e) => {
      const wrap = $(wrapId);
      wrap.hidden = !wrap.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!wrap.hidden));
      e.currentTarget.textContent = wrap.hidden ? labels[0] : labels[1];
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
    const marks = new Map();
    host._marks = marks;
    years.forEach((yr, i) => {
      const v = peaks.get(yr);
      const bx = xc(i) - bw / 2;
      let mark;
      if (v == null) {
        mark = svg("rect", { class: "missing", x: bx, y: bottom - 3, width: bw, height: 3, rx: 1 });
      } else {
        const by = y(v);
        const r = Math.min(4, bw / 2);
        mark = svg("path", { class: v >= past.roadFloodM ? "bar-level over" : "bar-level", d: `M${bx} ${bottom}V${by + r}q0 -${r} ${r} -${r}h${bw - 2 * r}q${r} 0 ${r} ${r}V${bottom}Z` });
        if (!pastAnimated && !reducedMotion) {
          mark.classList.add("grow");
          mark.style.animationDelay = `${i * 18}ms`;
        }
      }
      s.append(mark);
      marks.set(yr, mark);
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
      // Label every Nth year, plus the last year if it's at least half a step past the previous label.
      const isLast = i === years.length - 1;
      if (yr % labelEvery === 0 || (isLast && yr % labelEvery >= Math.ceil(labelEvery / 2))) {
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
    // Say why the bars start later than the flood count, and name years with no full record.
    const gaps = years.filter((yr) => !peaks.has(yr));
    const firstEvent = Number(past.events[0].date.slice(0, 4));
    const notes = [];
    if (firstEvent < y0) notes.push(`Bars start in ${y0}, the first full year of the EA's records; the flood count includes floods back to ${firstEvent}.`);
    if (gaps.length) notes.push(`No full record for ${gaps.join(", ")} (shown as a grey stub).`);
    let note = $("past-note");
    if (!note) { note = el("p", "meta"); note.id = "past-note"; host.after(note); }
    note.textContent = notes.join(" ");
    note.hidden = !notes.length;
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

  // ---- Flood log: every time the river reached road-flooding level.
  const PROPERTY_M = 2.03;
  const LOG_PREVIEW = 12;
  let logSort = "newest";
  let logExpanded = false;
  const fmtLogDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  function highlightYear(year, on) {
    const host = $("past-chart");
    const mark = host._marks?.get(year);
    if (!mark) return;
    host.classList.toggle("focusing", on);
    mark.classList.toggle("picked", on);
  }

  function renderPastTable() {
    const wrap = $("past-table");
    if (wrap.hidden || !past) return;
    const events = past.events.map((e) => ({ ...e, year: Number(e.date.slice(0, 4)) }));
    const record = events.reduce((a, b) => (b.peakM > a.peakM ? b : a));
    const sorted = logSort === "highest"
      ? [...events].sort((a, b) => b.peakM - a.peakM || b.date.localeCompare(a.date))
      : [...events].sort((a, b) => b.date.localeCompare(a.date));
    const shown = logExpanded ? sorted : sorted.slice(0, LOG_PREVIEW);
    // Bars run from road-flooding level (1.80 m) to the record.
    const span = Math.max(0.1, record.peakM - past.roadFloodM);
    const perYear = new Map();
    for (const e of events) perYear.set(e.year, (perYear.get(e.year) || 0) + 1);

    const controls = el("div", "log-controls");
    const seg = el("div", "seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Sort floods");
    for (const [key, label] of [["newest", "Newest first"], ["highest", "Highest first"]]) {
      const b = el("button", null, label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(logSort === key));
      b.addEventListener("click", () => { if (logSort !== key) { logSort = key; renderPastTable(); } });
      seg.append(b);
    }
    controls.append(seg, el("span", "meta", `${events.length} floods since ${Math.min(...events.map((e) => e.year))}`));

    const table = el("table", "floods");
    const caption = el("caption", "sr-only", `Every time the River Isle at Donyatt reached road-flooding level (${past.roadFloodM.toFixed(2)} m), ${logSort === "highest" ? "highest first" : "newest first"}.`);
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["Date", "Peak level"]) { const th = el("th", null, h); th.scope = "col"; hr.append(th); }
    thead.append(hr);
    const tbody = el("tbody");
    let lastYear = null;
    shown.forEach((e, i) => {
      if (logSort === "newest" && e.year !== lastYear) {
        const yr = el("tr", "year");
        const th = el("th", null, String(e.year));
        th.colSpan = 2;
        th.scope = "rowgroup";
        const n = perYear.get(e.year);
        th.append(el("span", "year-count", `${n} ${n === 1 ? "flood" : "floods"}`));
        yr.append(th);
        tbody.append(yr);
        lastYear = e.year;
      }
      const tr = el("tr", "flood");
      tr.style.setProperty("--i", String(Math.min(i, 20)));
      const date = el("td", "when");
      date.append(el("span", "date", logSort === "newest" ? fmtLogDate(e.date) : fmtDate(e.date)));
      if (e === record) date.append(el("span", "tag tag-record", "Record"));
      const peak = el("td", "peak");
      const bar = el("span", "peak-bar");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("span", "peak-fill");
      fill.style.setProperty("--w", `${Math.max(4, ((e.peakM - past.roadFloodM) / span) * 100)}%`);
      // Tick at 2.03 m, where the EA says property flooding is possible.
      const tick = el("span", "peak-tick");
      tick.style.left = `${((PROPERTY_M - past.roadFloodM) / span) * 100}%`;
      bar.append(fill, tick);
      peak.append(bar, el("span", "peak-value", `${e.peakM.toFixed(2)} m`));
      tr.append(date, peak);
      tr.addEventListener("pointerenter", () => highlightYear(e.year, true));
      tr.addEventListener("pointerleave", () => highlightYear(e.year, false));
      tbody.append(tr);
    });
    table.append(caption, thead, tbody);

    const parts = [controls, table];
    if (sorted.length > LOG_PREVIEW) {
      const more = el("button", "show-more", logExpanded ? "Show fewer" : `Show all ${sorted.length} floods`);
      more.type = "button";
      more.setAttribute("aria-expanded", String(logExpanded));
      more.addEventListener("click", () => { logExpanded = !logExpanded; renderPastTable(); });
      parts.push(more);
    }
    parts.push(el("p", "meta", `Bars show how far above road-flooding level (${past.roadFloodM.toFixed(2)} m) the river peaked, up to the record ${record.peakM.toFixed(2)} m. The tick marks ${PROPERTY_M.toFixed(2)} m, where the EA says property flooding is possible. Hover a flood to find its year on the chart.`));
    wrap.replaceChildren(...parts);
  }
  toggle("past-table-toggle", "past-table", renderPastTable, ["Show every flood", "Hide the list"]);

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

  // No scroll fade-in: on a safety tool every panel is fully visible straight away.

  // ---------------------------------------------------------------- stay up to date
  // Telegram channel link (from /api/config) and "add to home screen". The browser's own install
  // prompt is used where it exists (Android, desktop Chrome/Edge); iOS gets instructions instead.
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const touch = matchMedia("(pointer: coarse)").matches;
  const BANNER_KEY = "dfw-install-dismissed";
  let installPrompt = null;

  function renderStay() {
    const tg = config?.telegramUrl;
    $("tg-item").hidden = !tg;
    if (tg) $("tg-link").href = tg;

    const canPrompt = Boolean(installPrompt);
    const showInstall = !standalone() && (canPrompt || isIOS || touch);
    $("install-item").hidden = !showInstall;
    $("install-btn").hidden = !canPrompt;
    $("install-ios").hidden = canPrompt || !isIOS;
    $("install-other").hidden = canPrompt || isIOS;
    $("stay").hidden = $("tg-item").hidden && $("install-item").hidden;
  }

  async function install() {
    if (!installPrompt) {
      hideBanner();
      $("install-item").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      return;
    }
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
    installPrompt = null;
    hideBanner(outcome !== "accepted");
    renderStay();
  }

  function bannerDismissedRecently() {
    try {
      return Date.now() - Number(localStorage.getItem(BANNER_KEY) || 0) < 30 * 86_400_000;
    } catch {
      return false;
    }
  }

  function hideBanner(remember = true) {
    $("install-banner").hidden = true;
    document.body.classList.remove("has-banner");
    if (remember) try { localStorage.setItem(BANNER_KEY, String(Date.now())); } catch {}
  }

  // Count visits (once per browser session), so the banner waits for a second visit.
  let visits = 1;
  try {
    if (!sessionStorage.getItem("dfw-session")) {
      sessionStorage.setItem("dfw-session", "1");
      localStorage.setItem("dfw-visits", String(Number(localStorage.getItem("dfw-visits") || 0) + 1));
    }
    visits = Number(localStorage.getItem("dfw-visits") || 1);
  } catch {}

  function maybeShowBanner() {
    // Phones only (the panel lower down covers desktops), and not on someone's first visit.
    if (!touch || visits < 2) return;
    if (standalone() || bannerDismissedRecently() || !(installPrompt || isIOS)) return;
    if ($("report-dialog").open) return;
    $("install-banner-sub").textContent = installPrompt ? "Check the A358 in one tap." : "Tap Share, then Add to Home Screen.";
    $("install-banner-go").textContent = installPrompt ? "Add" : "How";
    $("install-banner").hidden = false;
    document.body.classList.add("has-banner");
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    renderStay();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    hideBanner();
    renderStay();
  });
  $("install-btn").addEventListener("click", install);
  $("install-banner-go").addEventListener("click", install);
  $("install-banner-close").addEventListener("click", () => hideBanner());
  // Offer it once people have had a moment with the page, not the instant it opens.
  setTimeout(maybeShowBanner, 15_000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
  }

  renderStay();
  loadConfig().then(() => { renderStay(); if (lastStatus) renderRoads(lastStatus.roads); });
  loadStatus();
  loadHistory();
  loadPast();
  // Keep the page current. Status is checked every minute (cheap: it's cached on the server);
  // the charts reload as soon as the status shows a newer river reading, and every 5 minutes anyway.
  // Phones pause timers in the background, so also catch up whenever the page comes back.
  let lastRefresh = Date.now();
  let lastHistoryLoad = Date.now();
  async function refresh(force = false) {
    if (document.hidden && !force) return;
    lastRefresh = Date.now();
    await loadStatus();
    const latest = lastStatus?.river?.readingAt;
    const charted = history?.level?.at(-1)?.[0];
    const newReading = latest && charted && parseTime(latest) > parseTime(charted);
    if (newReading || Date.now() - lastHistoryLoad > 5 * 60 * 1000) {
      lastHistoryLoad = Date.now();
      loadHistory();
    }
  }
  setInterval(refresh, 60 * 1000);
  const catchUp = () => { if (!document.hidden && Date.now() - lastRefresh > 20 * 1000) refresh(); };
  document.addEventListener("visibilitychange", catchUp);
  window.addEventListener("focus", catchUp);
  window.addEventListener("online", catchUp);
  window.addEventListener("pageshow", (e) => { if (e.persisted) refresh(true); });
  // Relative times ("5 min ago") tick on their own between refreshes.
  setInterval(() => {
    if (document.hidden || !lastStatus) return;
    const r = lastStatus;
    $("updated").textContent = `Status worked out ${ago(r.generatedAt)} (${fmtTime(Date.parse(r.generatedAt))}). Refreshes automatically.`;
    if (r.river.readingAt) $("reading-age").textContent = `Environment Agency reading from ${ago(r.river.readingAt)} (${fmtTime(parseTime(r.river.readingAt))})`;
  }, 30 * 1000);
})();
