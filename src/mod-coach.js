/* Coach: teaches the player to read the map and use the tools. Module id "coach", exposes Creek.coach.
   1. A short first-run tour (spotlight + caption), shown once per device, replayable from the menu ("Show me around").
   2. Map school: six little lessons the game checks by itself from events (Look taps, strokes, storms). Progress is remembered.
   3. Swale feedback: after every swale it says in one sentence how level the ditch is, with an Undo button.
   4. "How it works": a glossary card in plain words.
   Reads the land only (sim.readTerrain / sim.probe); it never writes to it. Everything it remembers is in
   localStorage "creek.coach" (all access in try/catch) and in game.registerState("coach").
   Address options: ?tour=0 never shows the tour by itself, ?tour=1 shows it even if it was seen before. */
(function () {
  const C = Creek.CONFIG;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const NS = 'creek.coach';
  let game = null, ui = null;
  const coach = Creek.coach = { last: {} };

  // ================================================================ what we remember
  const mem = { tour: 0, lessons: {} };
  function loadMem() {
    try {
      const o = JSON.parse(localStorage.getItem(NS) || 'null');
      if (o && typeof o === 'object') {
        if (o.tour) mem.tour = 1;
        if (o.lessons && typeof o.lessons === 'object') Object.keys(o.lessons).forEach((k) => { if (o.lessons[k]) mem.lessons[k] = 1; });
      }
    } catch (e) { /* no storage: keep going in memory */ }
  }
  function saveMem() { try { localStorage.setItem(NS, JSON.stringify(mem)); } catch (e) { /* ignore */ } }
  const query = new URLSearchParams(location.search);
  const tourParam = query.get('tour');           // "0" = never by itself, "1" = even if seen

  // ================================================================ reading the land (coarse map, cached)
  // Heights averaged into blocks of about 4 m, and the slope of each block. Built from sim.readTerrain only when a lesson needs it,
  // and rebuilt only when the land changed (game.terrainVersion). While a storm or a stroke is going the old copy is good enough.
  let CM = null;
  function coarse() {
    const sim = game && game.sim; if (!sim) return null;
    if (CM && CM.sim === sim && (CM.ver === game.terrainVersion || game.storm || game.stroke)) return CM;
    const nx = sim.nx, ny = sim.ny, dx = sim.dx, T = sim.readTerrain();
    const b = Math.max(1, Math.round(4 / dx)), w = Math.floor(nx / b), h = Math.floor(ny / b), cs = b * dx;
    const H = new Float32Array(w * h), S = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0;
      for (let v = 0; v < b; v++) { const row = ((j * b + v) * nx + i * b) * 4; for (let u = 0; u < b; u++) s += T[row + u * 4]; }
      H[j * w + i] = s / (b * b);
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(w - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(h - 1, j + 1);
      const gx = (H[j * w + i1] - H[j * w + i0]) / ((i1 - i0) * cs), gy = (H[j1 * w + i] - H[j0 * w + i]) / ((j1 - j0) * cs);
      S[j * w + i] = Math.hypot(gx, gy);
    }
    // the steepest tenth of the ranch (leave out the outer ring, where the edge of the map distorts things)
    const m = 3, inner = []; for (let j = m; j < h - m; j++) for (let i = m; i < w - m; i++) inner.push(S[j * w + i]);
    const sorted = Float32Array.from(inner).sort();
    const thr = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 1;
    // the middle of the steepest patch (a 3x3 average, so one odd cell does not win)
    let best = -1, bi = 0, bj = 0;
    for (let j = m; j < h - m; j++) for (let i = m; i < w - m; i++) {
      let s = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += S[(j + dj) * w + i + di];
      if (s > best) { best = s; bi = i; bj = j; }
    }
    CM = { sim, ver: game.terrainVersion, w, h, cs, H, S, thr, steep: { x: (bi + 0.5) * cs, y: (bj + 0.5) * cs } };
    return CM;
  }
  /** What the ground is like at a spot: height, slope (rise per metre run) and how it ranks in the 60 m square around it. */
  function sample(x, y) {
    const cm = coarse(); if (!cm) return null;
    const i = clamp(Math.floor(x / cm.cs), 0, cm.w - 1), j = clamp(Math.floor(y / cm.cs), 0, cm.h - 1), here = cm.H[j * cm.w + i];
    const r = Math.ceil(30 / cm.cs), eps = 0.02; let lower = 0, higher = 0, n = 0, lo = 1e9, hi = -1e9;
    for (let v = Math.max(0, j - r); v <= Math.min(cm.h - 1, j + r); v++) for (let u = Math.max(0, i - r); u <= Math.min(cm.w - 1, i + r); u++) {
      const q = cm.H[v * cm.w + u]; n++; if (q < here - eps) lower++; else if (q > here + eps) higher++;
      if (q < lo) lo = q; if (q > hi) hi = q;
    }
    return { h: here, slope: cm.S[j * cm.w + i], steep: cm.S[j * cm.w + i] >= cm.thr, lowFrac: lower / n, highFrac: higher / n, relief: hi - lo };
  }

  // ================================================================ streams (for the trace and section lessons)
  function streams() { return (game && game.world && game.world.meta && game.world.meta.streams) || []; }
  function distToStreams(x, y) {
    let best = 1e9;
    streams().forEach((s) => {
      const p = s.pts;
      for (let k = 0; k + 1 < p.length; k++) {
        const ax = p[k][0], ay = p[k][1], bx = p[k + 1][0], by = p[k + 1][1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
      }
    });
    return best;
  }
  function crossesStream(a, b) {
    const ccw = (p, q, r) => (r[1] - p[1]) * (q[0] - p[0]) > (q[1] - p[1]) * (r[0] - p[0]);
    const A = [a.x, a.y], B = [b.x, b.y];
    return streams().some((s) => {
      for (let k = 0; k + 1 < s.pts.length; k++) {
        const P = s.pts[k], Q = s.pts[k + 1];
        if (ccw(A, P, Q) !== ccw(B, P, Q) && ccw(A, B, P) !== ccw(A, B, Q)) return true;
      }
      return false;
    });
  }
  const creekMid = (f) => { const s = streams()[0]; if (!s) return { x: C.mapW / 2, y: C.mapH / 2 }; const p = s.pts[Math.floor(s.pts.length * (f == null ? 0.5 : f))]; return { x: p[0], y: p[1] }; };
  const hasTool = (id) => Creek.TOOLS.some((t) => t.id === id);

  // ================================================================ how level is a swale?
  /** Looks at a stroke's path and says how far the ground along it goes up and down: that is how "out of level" the line is.
      A swale is dug to the height where the stroke started, so every metre the line wanders uphill or downhill makes one end deep
      and the other a dam. The ground is read from the undo copy (the land as it was before the stroke); if that is not there the
      floor after the stroke is read instead. Returns {len, err (m), n, pts:[{x,y,h}], source}. */
  function levelScore(path) {
    if (!path || path.length < 2) return { len: 0, err: 0, n: 0, pts: [], source: 'none' };
    const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const len = cum[cum.length - 1], n = Math.max(2, Math.min(30, Math.round(len / 3) + 1)), pts = [];
    for (let k = 0, i = 0; k < n; k++) {
      const d = len * k / (n - 1); while (i < path.length - 2 && cum[i + 1] < d) i++;
      const seg = cum[i + 1] - cum[i], t = seg > 0 ? clamp((d - cum[i]) / seg, 0, 1) : 0;
      pts.push({ x: path[i].x + (path[i + 1].x - path[i].x) * t, y: path[i].y + (path[i + 1].y - path[i].y) * t, h: 0 });
    }
    const sim = game.sim; let source = 'before';
    // heights are blended between the four nearest cells (like sim.sampleLine does), so a line that follows the true contour
    // is not marked down just because the grid cells are 4 m wide
    const blend = (tex, x, y) => {
      const fx = clamp(x / sim.dx - 0.5, 0, sim.nx - 1.001), fy = clamp(y / sim.dx - 0.5, 0, sim.ny - 1.001), i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
      const q = sim._read(tex, i, j, 2, 2);
      return q[0] * (1 - a) * (1 - b) + q[4] * a * (1 - b) + q[8] * (1 - a) * b + q[12] * a * b;
    };
    try {
      if (!(sim.undoOK && sim.tex && sim.tex.U && sim._read)) throw new Error('no undo copy');
      pts.forEach((p) => { p.h = blend(sim.tex.U, p.x, p.y); });
    } catch (e) {
      source = 'after'; pts.forEach((p) => { p.h = sim.sampleLine(p.x, p.y, p.x, p.y, 1).h[0]; });
    }
    let lo = 1e9, hi = -1e9; pts.forEach((p) => { lo = Math.min(lo, p.h); hi = Math.max(hi, p.h); });
    return { len, err: hi - lo, n, pts, source };
  }

  // ================================================================ styles
  const STYLES = [
    '.co-tour{position:absolute;inset:0;z-index:15;pointer-events:none}.co-tour.co-away{display:none}#app.co-touring #hint,#app.co-touring #report{visibility:hidden}',
    '.co-dim{position:absolute;inset:0;background:rgba(40,28,16,.62);pointer-events:auto}',
    '.co-shield{position:absolute;pointer-events:auto;background:transparent}',
    '.co-ring{position:absolute;border:3px solid var(--gold);border-radius:16px;pointer-events:none;animation:co-pulse 1.8s ease-in-out infinite}',
    '.co-ring.co-solo{animation:none;box-shadow:0 0 0 9999px rgba(40,28,16,.62)}',
    '@keyframes co-pulse{50%{box-shadow:0 0 0 7px rgba(233,162,59,.35)}}',
    '@media (prefers-reduced-motion:reduce){.co-ring{animation:none}}',
    '.co-cap{position:absolute;pointer-events:auto;width:min(340px,calc(100% - 20px));background:var(--paper);color:var(--ink);border-radius:18px;box-shadow:var(--shadow);border-left:6px solid var(--gold);padding:10px 14px 8px;font-family:Georgia,serif;font-size:15px;line-height:1.4}',
    '.co-cap .co-n{font:600 11px system-ui,sans-serif;color:var(--ink2);letter-spacing:.04em;text-transform:uppercase;margin-bottom:2px}',
    '.co-cap .co-dots{display:inline-flex;gap:4px;margin-left:8px;vertical-align:1px}.co-dots i{width:7px;height:7px;border-radius:50%;background:#d9ccae}.co-dots i.on{background:var(--gold)}',
    '.co-cap .co-row{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:6px;font-family:system-ui,sans-serif}',
    '.co-cap .co-row button{min-height:40px;font-size:14px}.co-cap .co-row .go{padding:8px 18px}',
    // map school
    '.co-wrap{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13.5px;line-height:1.42}',
    '.co-prog{display:flex;align-items:center;gap:8px;margin:2px 0 8px;color:var(--ink2)}.co-bar{flex:1;height:8px;border-radius:5px;background:#d9ccae;overflow:hidden}.co-bar i{display:block;height:100%;background:var(--moss)}',
    '.co-less{border-top:1px solid #d9ccae}',
    '.co-lh{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:4px 2px;background:transparent;text-align:left;font-size:14px;font-weight:600}',
    '.co-chk{flex:0 0 auto;width:26px;height:26px;border-radius:50%;border:2px solid #cdbf9f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--ink2)}',
    '.co-less.done .co-chk{background:var(--moss);border-color:var(--moss);color:#fff}',
    '.co-det{padding:0 2px 10px 36px}.co-det p{margin:4px 0}.co-det .co-job{color:var(--ink)}.co-det .co-stat{color:var(--ink2);font-size:12.5px}',
    '.co-det .co-cheer{color:var(--moss);font-weight:600}.co-det .go{margin-top:4px;min-height:40px;padding:8px 18px}',
    '.co-allset{margin:8px 0 2px;font-weight:600;color:var(--moss)}',
    // the task bar and the swale toast
    '.co-task{position:absolute;z-index:9;left:10px;width:min(300px,calc(100% - 134px));background:var(--paper);color:var(--ink);border-radius:14px;box-shadow:var(--shadow);border-left:5px solid var(--moss);padding:6px 40px 6px 10px;font-size:12.5px;line-height:1.35;text-align:left;cursor:pointer}',
    '.co-task b{display:block;font-size:12.5px}.co-task.done{border-left-color:var(--gold)}.co-task .co-tx{position:absolute;right:0;top:0;width:40px;height:40px;background:transparent;color:var(--ink2);font-size:15px}',
    '.co-toast{position:absolute;z-index:9;left:50%;transform:translateX(-50%);width:min(520px,calc(100% - 20px));display:flex;align-items:center;gap:8px;background:rgba(59,42,26,.95);color:#fff6e6;border-radius:18px;padding:8px 6px 8px 14px;font-size:14px;line-height:1.35;box-shadow:var(--shadow)}',
    '.co-toast .co-tt{flex:1;min-width:0}.co-toast button{flex:0 0 auto;min-height:40px}.co-toast .go{padding:8px 16px}.co-toast .co-tx{width:40px;background:transparent;color:#e8d9b8;font-size:15px}',
    // the glossary
    '.co-gl{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}.co-gl h3{font-family:Georgia,serif;font-size:16px;margin:12px 4px 2px;color:var(--moss)}.co-gl p{font-family:Georgia,serif;font-size:15px;line-height:1.45;margin:2px 4px 6px}'
  ].join('');

  // ================================================================ the tour
  const T = { root: null, dim: null, cap: null, rings: [], shields: [], active: false, idx: 0, steps: [], sig: '', away: false, probed: false, forced: false, stable: 0, engaged: false, clipOK: true };

  function appRect() { const a = $('app'); return { w: a.clientWidth, h: a.clientHeight }; }
  /** The on-screen box of an element (null if it is missing, hidden or tiny); `within` cuts it to a scrolling strip it lives in. */
  function boxOf(sel, within) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) return null;
    const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return null;
    let b = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    if (within) {
      const s = document.querySelector(within); if (s) { const q = s.getBoundingClientRect(); b = { l: Math.max(b.l, q.left), t: Math.max(b.t, q.top), r: Math.min(b.r, q.right), b: Math.min(b.b, q.bottom) }; }
      if (b.r - b.l < 4 || b.b - b.t < 4) return null;
    }
    return b;
  }
  function mapBox() {
    const a = appRect(); let top = 0;
    ['#topbar', '#topbar2'].forEach((s) => { const b = boxOf(s); if (b) top = Math.max(top, b.b); });
    const tb = boxOf('#toolbar'), bottom = tb ? tb.t - 4 : a.h - 8;
    if (bottom - top < 80) return null;
    return { l: 6, t: top + 4, r: a.w - 6, b: bottom };
  }
  const unionBox = (hs) => hs.reduce((u, h) => (u ? { l: Math.min(u.l, h.b.l), t: Math.min(u.t, h.b.t), r: Math.max(u.r, h.b.r), b: Math.max(u.b, h.b.b) } : { l: h.b.l, t: h.b.t, r: h.b.r, b: h.b.b }), null);

  const rowScrolls = () => { const r = $('topbar2'); return !!r && r.scrollWidth > r.clientWidth + 2; };
  const SPECS = [
    { key: 'map', place: 'map-bottom', holes: () => [{ b: mapBox(), shield: true }],
      enter() { if (!game.contourOn && ui.toggleLines) ui.toggleLines(); },
      text: () => 'This is your ranch from above. The brown lines are contour lines. Every spot on one line is the same height, like the edge of a pond.' },
    { key: 'look', place: 'map-top', holes: () => [{ b: mapBox(), shield: false }, { b: boxOf('.tool[data-id="look"]', '#tools'), shield: false }],
      enter() { const tray = $('tools'), el = document.querySelector('.tool[data-id="look"]'); if (tray && el) tray.scrollLeft = 0; if (game.canUse('look')) game.setTool('look'); T.probed = false; },
      text: () => (T.probed ? 'Nice! The Look tool tells you how high the ground is. Tap a spot on the same brown line and you get the same height.' : 'Try it! Tap the map with the Look tool 👆. It tells you how high the ground is. The brown line through that spot lights up.') },
    { key: 'storm', place: 'below', holes: () => [{ b: boxOf('#stormbar'), shield: true }],
      text: () => 'These buttons send a storm: small, big or huge. Nothing can break for good. Watch where the water goes, then fix what it shows you.' },
    { key: 'tools', place: 'above', holes: () => [{ b: boxOf('#toolbar'), shield: true }],
      text: () => 'These are your tools. Swipe sideways to see them all. Tap a tool, then drag on the map. Undo is on the right if you change your mind.' },
    { key: 'views', place: 'below', holes: () => [{ b: boxOf('#topbar2'), shield: true }],
      text: () => 'Lines turns the brown lines on and off. View switches the picture: soil health, soil moved, flood depth' + (document.getElementById('view3d') ? '. The 3D button tilts the map so you can see the hills.' : '.') + (rowScrolls() ? ' Swipe this row sideways to find more buttons, like Lessons.' : '') },
    { key: 'money', place: 'below', holes: () => [{ b: boxOf('#btnMenu'), shield: true }, { b: boxOf('#btnCash'), shield: true }],
      text: () => 'This is your money. Tap it to open the ranch books. The ☰ menu has Map school, where you learn to read the map, and Show me around to see this again.', last: true }
  ];

  function buildTourDom() {
    if (T.root) return;
    const root = T.root = document.createElement('div'); root.className = 'co-tour co-away';
    T.clipOK = !!(window.CSS && window.CSS.supports && window.CSS.supports('clip-path', 'path(evenodd, "M0 0H1V1Z")'));
    T.dim = document.createElement('div'); T.dim.className = 'co-dim'; root.appendChild(T.dim);
    T.cap = document.createElement('div'); T.cap.className = 'co-cap'; T.cap.setAttribute('role', 'dialog'); T.cap.setAttribute('aria-live', 'polite');
    T.cap.innerHTML = '<div class="co-n"><span class="co-step"></span><span class="co-dots"></span></div><div class="co-t"></div><div class="co-row"><button class="plain co-skip">Skip tour</button><button class="go co-next">Next</button></div>';
    root.appendChild(T.cap);
    T.cap.querySelector('.co-skip').onclick = () => game._guard('coach skip', () => endTour(true));
    T.cap.querySelector('.co-next').onclick = () => game._guard('coach next', nextStep);
    $('app').appendChild(root);
  }

  function rrect(b, r) {
    const w = b.r - b.l, h = b.b - b.t; r = Math.min(r, w / 2, h / 2);
    return 'M' + (b.l + r) + ' ' + b.t + 'h' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'v' + (h - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 -' + r + ' ' + r +
      'h-' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 -' + r + ' -' + r + 'v-' + (h - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r + 'Z';
  }
  const grow = (b, p, a) => ({ l: Math.max(2, b.l - p), t: Math.max(2, b.t - p), r: Math.min(a.w - 2, b.r + p), b: Math.min(a.h - 2, b.b + p) });
  function pool(list, n, make) { while (list.length < n) { const e = make(); T.root.appendChild(e); list.push(e); } list.forEach((e, i) => { e.style.display = i < n ? '' : 'none'; }); }

  /** Put the dim layer, the gold rings, the shields and the caption where they belong. Runs every frame; does nothing unless something moved. */
  function layoutTour(force) {
    const step = T.steps[T.idx]; if (!step) return;
    const a = appRect();
    const holes = step.spec.holes().filter((h) => h.b).map((h) => ({ b: grow(h.b, 5, a), shield: h.shield }));
    const sig = a.w + 'x' + a.h + '|' + holes.map((h) => [h.b.l, h.b.t, h.b.r, h.b.b].map(Math.round).join(',') + (h.shield ? 's' : '')).join(';') + '|' + T.cap.offsetHeight;
    if (!force && sig === T.sig) return; T.sig = sig;
    let d = 'M0 0H' + a.w + 'V' + a.h + 'H0Z'; holes.forEach((h) => { d += rrect(h.b, 16); });
    if (T.clipOK) { T.dim.style.display = ''; T.dim.style.clipPath = T.dim.style.webkitClipPath = 'path(evenodd, "' + d + '")'; } else T.dim.style.display = 'none';
    pool(T.rings, holes.length, () => { const e = document.createElement('div'); e.className = 'co-ring'; return e; });
    holes.forEach((h, i) => { const e = T.rings[i]; e.style.left = h.b.l + 'px'; e.style.top = h.b.t + 'px'; e.style.width = (h.b.r - h.b.l) + 'px'; e.style.height = (h.b.b - h.b.t) + 'px'; e.classList.toggle('co-solo', !T.clipOK && i === 0); });
    const sh = holes.filter((h) => h.shield);
    pool(T.shields, sh.length, () => { const e = document.createElement('div'); e.className = 'co-shield'; return e; });
    sh.forEach((h, i) => { const e = T.shields[i]; e.style.left = h.b.l + 'px'; e.style.top = h.b.t + 'px'; e.style.width = (h.b.r - h.b.l) + 'px'; e.style.height = (h.b.b - h.b.t) + 'px'; });
    T.root.appendChild(T.cap);                                 // the caption always sits on top
    placeCaption(step, holes, a);
  }
  function placeCaption(step, holes, a) {
    const cap = T.cap, cw = cap.offsetWidth, ch = cap.offsetHeight, m = 10, U = unionBox(holes), p = step.spec.place;
    const h0 = holes[0] ? holes[0].b : null;
    let x = clamp(((U ? (U.l + U.r) / 2 : a.w / 2) - cw / 2), m, Math.max(m, a.w - cw - m)), y;
    if (p === 'map-bottom' && h0) { y = h0.b - ch - 12; x = clamp((a.w - cw) / 2, m, a.w); }
    else if (p === 'map-top' && h0) { y = h0.t + 10; x = clamp((a.w - cw) / 2, m, a.w); }
    else if (p === 'above' && U) { y = U.t - ch - 12; if (y < m) y = U.b + 12; }
    else if (U) { y = U.b + 12; if (y + ch > a.h - m) y = U.t - ch - 12; }
    else y = (a.h - ch) / 2;
    cap.style.left = Math.round(x) + 'px'; cap.style.top = Math.round(clamp(y, m, Math.max(m, a.h - ch - m))) + 'px';
  }

  function showStep() {
    const step = T.steps[T.idx]; if (!step) return;
    if (step.spec.enter) { try { step.spec.enter(); } catch (e) { console.warn('[creek] coach step', e); } }
    renderCaption();
  }
  function renderCaption() {
    const step = T.steps[T.idx]; if (!step) return;
    const n = T.steps.length, cap = T.cap;
    cap.querySelector('.co-step').textContent = 'Step ' + (T.idx + 1) + ' of ' + n;
    cap.querySelector('.co-dots').innerHTML = T.steps.map((s, i) => '<i class="' + (i === T.idx ? 'on' : '') + '"></i>').join('');
    cap.querySelector('.co-t').textContent = step.spec.text();
    const last = T.idx === n - 1, nx = cap.querySelector('.co-next'); nx.textContent = last ? 'Let’s go!' : 'Next';
    cap.querySelector('.co-skip').style.display = last ? 'none' : '';
    T.sig = ''; layoutTour(true);
  }
  function nextStep() { if (T.idx >= T.steps.length - 1) endTour(false); else { T.idx++; showStep(); } }

  function modalOpen() { const m = $('modal'), s = $('splash'); return !!(m && !m.classList.contains('hidden')) || !!(s && s.classList.contains('on')); }
  /** Safe moment to talk: a world, no storm (the story's first storm included), no card open, no loading screen. */
  function calm() { return !!(game && game.ready && !game.storm && !modalOpen() && document.visibilityState !== 'hidden'); }

  function startTour() {
    if (T.active) return true;
    buildTourDom();
    const steps = SPECS.map((spec) => ({ spec })).filter((s) => { try { return s.spec.holes().some((h) => h.b); } catch (e) { return false; } });   // a step whose element is missing is skipped
    if (steps.length < 2) return false;
    T.steps = steps; T.idx = 0; T.active = true; T.away = false; T.probed = false; T.forced = false;
    T.root.classList.remove('co-away'); $('app').classList.add('co-touring'); showStep();
    return true;
  }
  function endTour(skipped) {
    if (!T.active) return;
    T.active = false; T.root.classList.add('co-away'); $('app').classList.remove('co-touring');
    mem.tour = 1; saveMem();
    ui.toast(skipped ? 'No problem. Open ☰ and tap “Show me around” to see it later.' : 'That is the tour! Open ☰ and tap “Map school” to learn to read the map.');
    game.emit('tour', { skipped: !!skipped });
  }
  /** Asks for the tour. It starts as soon as nothing else is on screen. */
  function requestTour() {
    if (T.active) return;
    T.forced = true;
    if (!calm()) ui.toast('The tour starts when the storm or the card is finished.');
  }
  function tourTick() {            // every 400 ms: is it a good moment to begin?
    if (T.active || tourParam === '0' && !T.forced) return;
    const want = T.forced || (T.engaged && (!mem.tour || tourParam === '1'));
    if (!want) { T.stable = 0; return; }
    if (calm()) { T.stable += 400; if (T.stable >= 1200) { T.stable = 0; if (!startTour()) { T.forced = false; if (!mem.tour) { mem.tour = 1; saveMem(); } } } } else T.stable = 0;
  }
  function tourFrame() {
    if (!T.active) return;
    const blocked = modalOpen();       // a card opened (menu, picture, story): hide the tour until it is closed
    if (blocked !== T.away) { T.away = blocked; T.root.classList.toggle('co-away', blocked); if (!blocked) layoutTour(true); }
    if (!blocked) layoutTour(false);
  }

  // ================================================================ Map school
  const FOCUS = (wide) => clamp(Math.min(game.cw || 360, game.ch || 640) * 0.9 / wide, 0.8, 8);   // metres across the short side of the screen
  function pickTool(id) {
    if (!hasTool(id)) return false;
    if (!game.canUse(id)) { ui.toast(id === 'swale' ? 'The swale tool opens later in the story. Free play (in the menu) has every tool open.' : 'That tool is not open yet.'); return false; }
    ui.pickTool(id); return true;
  }
  const L = {};          // working progress that is not remembered between visits (spots tapped and so on)
  const fmtM = (m) => (Math.round(m * 10) / 10).toFixed(1) + ' m';

  const LESSONS = [
    { id: 'L1', title: 'Read a contour line',
      body: 'A contour line joins every spot that is the same height, like the shore of a pond where the water sits at one level. Walk along one line and you never go up or down. Walk across the lines and you do.',
      task: () => 'Use the Look tool 👆 on 3 different spots, some high and some low. Watch the height change.',
      stat: () => 'Spots read: ' + (L.spots ? L.spots.length : 0) + ' of 3' + (L.spots && L.spots.length ? ' (' + L.spots.map((s) => fmtM(s.h)).join(', ') + ')' : ''),
      cheer: 'You can read a contour line! Every point on one line is the same height.',
      go() { pickTool('look'); const c = creekMid(0.5); game.focusOn(c.x, c.y, FOCUS(330)); } },
    { id: 'L2', title: 'Close lines mean steep',
      body: 'Where brown lines are squeezed close together, the ground climbs fast: it is steep, and water runs fast. Where the lines are far apart, the ground is gentle and water walks.',
      task: () => 'Find a very steep place and tap it with Look. Hint: the creek banks and gullies are steep.',
      stat: () => L.steepMsg || 'Look for lines packed close together.',
      cheer: 'Steep ground found! Lines close together mean a steep slope.',
      go() { pickTool('look'); const cm = coarse(); const p = cm ? cm.steep : creekMid(0.5); game.focusOn(p.x, p.y, FOCUS(220)); } },
    { id: 'L3', title: 'Valleys point uphill',
      body: 'Lines bend around a valley like a V that points uphill, and water collects at the bottom of it. A ridge is the high back of a hill: rain on one side runs one way, rain on the other side runs the other way.',
      task: () => 'Tap the bottom of a gully or the creek, then tap a ridge, a high spot between two valleys.',
      stat: () => 'Valley bottom: ' + (L.valley ? '✓' : 'not yet') + '  ·  Ridge: ' + (L.ridge ? '✓' : 'not yet'),
      cheer: 'Valley and ridge found! Water always runs from the ridge down into the valley.',
      go() { pickTool('look'); const c = creekMid(0.45); game.focusOn(c.x, c.y, FOCUS(260)); } },
    { id: 'L4', title: 'Follow a contour',
      body: 'A swale is a ditch dug along a contour line. Every spot on the line is the same height, so the ditch is level. Water in a level ditch stops, spreads out and soaks in. A ditch that wanders uphill and downhill does not.',
      task: () => 'Pick the Swale tool and drag along a brown line for at least 30 m. Stay on the line! Zoom in until the lines are close enough to follow.',
      stat: () => (L.swale ? 'Your last swale: ' + Math.round(L.swale.len) + ' m long, ' + Math.round(L.swale.err * 100) + ' cm out of level. Aim for under 25 cm.' : 'No swale yet.'),
      cheer: 'A level swale! It will hold the water and let it soak in.',
      go() {
        pickTool('swale'); const f = game.fields.filter((q) => q.kind === 'field')[0] || { cx: creekMid(0.3).x, cy: creekMid(0.3).y };
        game.focusOn(f.cx, f.cy, Math.max(1.8, FOCUS(160)));
      } },
    { id: 'L5', title: 'Where does water go?',
      body: 'Water runs straight downhill, across the brown lines and never along them. Rain on a whole hillside gathers in the nearest valley, then flows to the creek.',
      task: () => (hasTool('trace') ? 'Pick the Trace tool 🌧️ and tap Plum Creek. Everything that lights up drains to that spot.' : 'Press a storm button, then use the Look tool on deep water in the creek.'),
      stat: () => (hasTool('trace') ? 'Tap the creek with the Trace tool, or watch a storm and Look at deep water.' : (L.stormSeen ? 'Storm sent. Now Look at some deep water.' : 'Send a storm first.')),
      cheer: 'Now you know where the water goes: downhill, into the valley, down to the creek.',
      go() { const c = creekMid(0.5); game.focusOn(c.x, c.y, FOCUS(330)); if (hasTool('trace')) pickTool('trace'); else pickTool('look'); } },
    { id: 'L6', title: 'Cut a cross-section', when: () => hasTool('section'),
      body: 'Imagine slicing the ground with a knife and looking at the cut edge. That side view is a cross-section. It shows how tall the creek banks are and how deep the soil is above the rock.',
      task: () => 'Pick the Section tool ✂️ and drag a line across Plum Creek, from one bank to the other.',
      stat: () => 'Drag from one side of the creek to the other.',
      cheer: 'That side view is a cross-section. Now you can see how tall the banks are!',
      go() { pickTool('section'); const c = creekMid(0.5); game.focusOn(c.x, c.y, FOCUS(200)); } }
  ];
  const lessons = () => LESSONS.filter((q) => !q.when || q.when());
  const isDone = (q) => !!mem.lessons[q.id];
  const lesson = (id) => LESSONS.find((q) => q.id === id);

  let panel = null, lessonsBtn = null, openId = null, activeId = null, taskEl = null, taskTimer = 0;

  function complete(q, msg) {
    if (isDone(q)) return;
    mem.lessons[q.id] = 1; saveMem();
    ui.toast('✓ ' + (msg || q.cheer));
    game.emit('lesson', { id: q.id, title: q.title, done: lessons().filter(isDone).length, total: lessons().length });
    refreshLessons(); refreshTask();
    if (activeId === q.id) { clearTimeout(taskTimer); taskTimer = setTimeout(() => { if (activeId === q.id) { activeId = null; refreshTask(); } }, 9000); }
  }

  function refreshLessons() {
    if (!panel) return;
    const list = lessons(), nDone = list.filter(isDone).length, b = panel.body;
    b.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'co-wrap'; b.appendChild(wrap);
    const pr = document.createElement('div'); pr.className = 'co-prog';
    pr.innerHTML = '<span><b>' + nDone + '</b> of ' + list.length + ' done</span><span class="co-bar"><i style="width:' + Math.round(100 * nDone / Math.max(1, list.length)) + '%"></i></span>';
    wrap.appendChild(pr);
    list.forEach((q, k) => {
      const done = isDone(q), row = document.createElement('div'); row.className = 'co-less' + (done ? ' done' : '');
      const h = document.createElement('button'); h.className = 'co-lh'; h.setAttribute('aria-expanded', openId === q.id ? 'true' : 'false');
      h.innerHTML = '<span class="co-chk">' + (done ? '✓' : (k + 1)) + '</span><span></span>'; h.lastChild.textContent = q.title;
      h.onclick = () => { openId = openId === q.id ? null : q.id; refreshLessons(); };
      row.appendChild(h);
      if (openId === q.id) {
        const det = document.createElement('div'); det.className = 'co-det';
        const p1 = document.createElement('p'); p1.textContent = q.body;
        const p2 = document.createElement('p'); p2.className = 'co-job'; p2.innerHTML = '<b>Your job:</b> '; p2.appendChild(document.createTextNode(q.task()));
        det.appendChild(p1); det.appendChild(p2);
        if (!done) { const p3 = document.createElement('p'); p3.className = 'co-stat'; p3.textContent = q.stat(); det.appendChild(p3); }
        else { const p4 = document.createElement('p'); p4.className = 'co-cheer'; p4.textContent = '✓ ' + q.cheer; det.appendChild(p4); }
        const go = document.createElement('button'); go.className = 'go' + (done ? ' alt' : ''); go.textContent = done ? 'Try it again' : 'Try it';
        go.onclick = () => game._guard('lesson try it', () => tryLesson(q));
        det.appendChild(go); row.appendChild(det);
      }
      wrap.appendChild(row);
    });
    if (nDone === list.length && list.length) { const f = document.createElement('div'); f.className = 'co-allset'; f.textContent = 'You can read the map! Go and shape the land.'; wrap.appendChild(f); }
    panel.setTitle('🎓 Map school');
  }
  function tryLesson(q) {
    activeId = q.id; clearTimeout(taskTimer); L.lastSpotToast = 0;
    panel.hide(); q.go(); refreshTask();
  }
  function ensureTask() {
    if (taskEl) return taskEl;
    taskEl = document.createElement('div'); taskEl.className = 'co-task hidden'; taskEl.setAttribute('role', 'button'); taskEl.title = 'Open Map school';
    taskEl.innerHTML = '<b></b><span></span><button class="co-tx" aria-label="Hide this">✕</button>';
    taskEl.onclick = (e) => { if (e.target.closest('.co-tx')) { activeId = null; refreshTask(); return; } openLessons(activeId); };
    $('app').appendChild(taskEl); return taskEl;
  }
  function refreshTask() {
    const el = ensureTask(), q = activeId && lesson(activeId);
    if (!q || (panel && panel.visible)) { el.classList.add('hidden'); return; }
    const done = isDone(q);
    el.classList.toggle('done', done); el.classList.remove('hidden');
    el.querySelector('b').textContent = (done ? '✓ ' : '') + q.title;
    el.querySelector('span').textContent = done ? q.cheer : q.stat();
    placeTask();
  }
  function placeTask() {
    if (!taskEl || taskEl.classList.contains('hidden')) return;
    const r = $('report'); let top = 126;
    if (r && !r.classList.contains('hidden')) top = Math.max(top, r.getBoundingClientRect().bottom + 6);
    taskEl.style.top = top + 'px';
  }
  function openLessons(id) {
    if (!panel) return;
    const list = lessons(); openId = id || (list.find((q) => !isDone(q)) || list[0] || {}).id || null;
    refreshLessons(); panel.show(); refreshTask();
  }

  // ---- what the player does, turned into lesson progress
  let lastProbe = null;
  function onProbe(info) {
    lastProbe = info;
    if (T.active && T.steps[T.idx] && T.steps[T.idx].spec.key === 'look' && !T.probed) { T.probed = true; renderCaption(); }
    // lesson 5 without the trace tool: deep water seen after a storm
    const q5 = lesson('L5');
    if (q5 && !isDone(q5) && !hasTool('trace') && L.stormSeen && info.depth >= 0.12) complete(q5, 'You found deep water! Water runs downhill into the valley and collects there.');
  }
  function onLookEnd(e) {
    const p = lastProbe; lastProbe = null;
    if (e.cancelled || !p) return;
    // lesson 1: three spots at three different heights
    const q1 = lesson('L1');
    if (q1 && !isDone(q1)) {
      L.spots = L.spots || [];
      if (!L.spots.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 10)) L.spots.push({ x: p.x, y: p.y, h: p.h });
      const hs = L.spots.map((s) => s.h).sort((a, b) => a - b); let kinds = hs.length ? 1 : 0;
      for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] >= 0.5) kinds++;
      if (kinds >= 3) { L.spots.length = Math.max(L.spots.length, 3); complete(q1, 'Three spots, three heights: ' + hs.filter((_, i) => i === 0 || hs[i] - hs[i - 1] >= 0.5).slice(0, 3).map(fmtM).join(', ') + '. Every point on one brown line has the same height.'); }
      else if (activeId === 'L1') {
        ui.toast(L.spots.length >= 3 ? 'Those spots are almost the same height. Try one high and one low.' : 'Spot ' + L.spots.length + ' of 3: the ground here is ' + fmtM(p.h) + ' high.');
        refreshTask();
      }
    }
    // lessons 2 and 3 look at the lie of the land around the tap
    const need2 = lesson('L2'), need3 = lesson('L3');
    if ((need2 && !isDone(need2)) || (need3 && !isDone(need3))) {
      const s = sample(p.x, p.y);
      if (s) {
        if (need2 && !isDone(need2)) {
          if (s.steep) { L.steepMsg = 'Steep for this ranch! The ground drops about ' + Math.round(s.slope * 100) + ' m in every 100 m here.'; complete(need2, L.steepMsg + ' See how close the lines are?'); }
          else if (activeId === 'L2') ui.toast('That ground is gentle: the lines are far apart. Look for lines packed close together.');
        }
        if (need3 && !isDone(need3)) {
          let kind = '';
          if (s.relief >= 1) { if (s.lowFrac <= 0.08) kind = 'valley'; else if (s.highFrac <= 0.08) kind = 'ridge'; }
          const had = kind === 'valley' ? L.valley : kind === 'ridge' ? L.ridge : false;
          if (kind === 'valley') L.valley = true; else if (kind === 'ridge') L.ridge = true;
          if (L.valley && L.ridge) complete(need3);
          else if (activeId === 'L3') {
            if (kind === 'valley') ui.toast(had ? 'More low ground. Now find a ridge: high ground between two valleys.' : 'That is low ground, a valley bottom. Now find a ridge, a high spot.');
            else if (kind === 'ridge') ui.toast(had ? 'More high ground. Now find the bottom of a valley.' : 'That is a ridge, high ground. Now find the bottom of a valley.');
            else ui.toast('That is on a hillside. Look for the very lowest or the very highest ground around.');
          }
          refreshTask();
        }
      }
    }
  }
  function onTrace(e) {
    const q = lesson('L5'); if (!q || isDone(q) || e.cancelled || !e.path.length) return;
    const p = e.path[e.path.length - 1];
    if (distToStreams(p.x, p.y) <= 30) complete(q, 'You traced the creek! All the shaded land drains to it.');
    else if (activeId === 'L5') ui.toast('Tap right on the creek, the wide channel, and see which land feeds it.');
  }
  function onSection(e) {
    const q = lesson('L6'); if (!q || isDone(q) || e.cancelled || e.path.length < 2) return;
    const a = e.path[0], b = e.path[e.path.length - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 15 && crossesStream(a, b)) complete(q);
    else if (activeId === 'L6') ui.toast('Drag a line that crosses the creek, from the bank on one side to the other.');
  }

  // ================================================================ swale feedback
  let toastEl = null, toastTimer = 0;
  function showCoachToast(text, canUndo) {
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.className = 'co-toast hidden'; toastEl.setAttribute('role', 'status');
      toastEl.innerHTML = '<span class="co-tt"></span><button class="go alt co-undo">Undo</button><button class="co-tx" aria-label="Close">✕</button>';
      toastEl.querySelector('.co-tx').onclick = () => toastEl.classList.add('hidden');
      toastEl.querySelector('.co-undo').onclick = () => game._guard('coach undo', () => { toastEl.classList.add('hidden'); if (!game.undo()) ui.toast('Nothing to undo.'); else ui.toast('Undone. The ground is back as it was.'); });
      $('app').appendChild(toastEl);
    }
    toastEl.querySelector('.co-tt').textContent = text;
    toastEl.querySelector('.co-undo').style.display = canUndo ? '' : 'none';
    toastEl.classList.remove('hidden');
    const a = appRect(), tb = boxOf('#toolbar'), hint = $('hint'); let bottom = (tb ? a.h - tb.t : 150) + 50;     // above the tool tray, with a line of room for the game's own toast
    if (hint && !hint.classList.contains('hidden')) bottom += hint.offsetHeight + 8;
    toastEl.style.bottom = bottom + 'px';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 9000);
  }
  function onSwale(e) {
    if (e.cancelled || !e.path || e.path.length < 2) return;
    const s = levelScore(e.path); coach.last.swale = s;
    if (s.len < 8) return;                                  // a tap or a tiny scratch: nothing to say
    const cm = Math.round(s.err * 100);
    let text;
    if (cm <= 12) text = 'Nicely level: only ' + cm + ' cm up and down. Water will spread out and soak in.';
    else if (cm < 25) text = 'Close to level: ' + cm + ' cm up and down. Water will mostly spread out. Stay right on the brown line to do even better.';
    else text = 'That ditch is ' + cm + ' cm out of level: one end is deep and the other is a dam, so water will run to the low end. Follow a brown contour line next time.';
    showCoachToast(text, true);
    L.swale = { len: s.len, err: s.err };
    const q = lesson('L4');
    if (q && !isDone(q) && s.len >= 30 && s.err < 0.25) complete(q, cm <= 12 ? 'A level swale, only ' + cm + ' cm out! It will hold the water and let it soak in.' : q.cheer);
    refreshLessons(); refreshTask();
  }

  // ================================================================ "How it works"
  const GLOSSARY = [
    ['Contour lines', 'A contour line joins every spot on the map that is the same height. Think of the edge of a pond: the water touches the shore at one height all the way around. Lines close together mean steep ground, lines far apart mean gentle ground.'],
    ['Slope', 'Slope is how fast the ground goes up or down. On a steep slope the water runs fast and can pick up soil. On a gentle slope the water walks, and has time to soak in.'],
    ['Runoff', 'Runoff is rain that does not soak in, so it runs over the top of the ground. It picks up soil and carries it away, and it can pile into a flood. Slowing runoff down is most of what this game is about.'],
    ['Soaking in', 'When rain soaks in, it goes down into the ground like water into a sponge. Pasture, prairie and trees soak up far more than bare soil, roofs or roads. A swale, a ditch along a contour line, gives water time to soak in.'],
    ['Organic matter', 'Organic matter is the dark, crumbly part of soil, made from old roots, leaves and tiny living things. It works like a sponge and like glue, so it holds water and holds soil together. Cover crops, no-till and resting the grass all build it.'],
    ['Roots and banks', 'Roots tie soil together, a bit like rebar in concrete. Deep roots hold a creek bank in place, but only as deep as they reach. Bare banks crumble when fast water undercuts them.'],
    ['Check dams and ponds', 'A check dam is a low wall of posts and branches across a gully. It slows the water so the mud settles out and the bed builds back up. A pond catches runoff, holds it, and lets the mud sink to the bottom.'],
    ['Why soaked-in water matters', 'Water that soaks in does not rush down the creek all at once, so there is less flooding and less erosion. It stays in the soil for plants and slowly feeds the creek in dry months. A ranch that soaks up its rain stays green longer.']
  ];
  function showGlossary() {
    const html = '<div class="co-gl">' + GLOSSARY.map((g) => '<h3>' + ui.esc(g[0]) + '</h3><p>' + ui.esc(g[1]) + '</p>').join('') + '</div>';
    return ui.card({ title: 'How it works', html, buttons: [{ label: 'Close' }] });
  }

  // ================================================================ the module
  Creek.registerModule({
    id: 'coach',

    init: function (g, u) {
      game = g; ui = u; loadMem();
      ui.styles(STYLES);
      panel = ui.panel({ id: 'coach-lessons', title: '🎓 Map school', corner: 'tl', closable: true,
        onShow: () => { if (lessonsBtn) lessonsBtn.classList.add('on'); refreshTask(); },
        onHide: () => { if (lessonsBtn) lessonsBtn.classList.remove('on'); refreshTask(); } });
      lessonsBtn = ui.addButton({ slot: 'view', id: 'coachLessons', label: '🎓 Lessons', title: 'Map school: short lessons on reading the map', toggle: true,
        onClick: (on) => { if (on) openLessons(activeId && !isDone(lesson(activeId)) ? activeId : null); else panel.hide(); } });

      ui.addMenuItem({ label: 'Show me around', onClick: () => requestTour() });
      ui.addMenuItem({ label: 'Map school', onClick: () => openLessons() });
      ui.addMenuItem({ label: 'How it works', onClick: () => showGlossary() });
      if (Creek.shortcuts && ui.showShortcuts) ui.addMenuItem({ label: 'Keyboard shortcuts', onClick: () => ui.showShortcuts() });
      if (Creek.shortcuts) Creek.shortcuts.add({ key: 'Escape', hidden: true, desc: 'Skip the tour', fn: () => { if (!T.active) return false; endTour(true); } });

      game.registerState('coach', {
        save: () => ({ tour: mem.tour, lessons: Object.assign({}, mem.lessons) }),
        load: (j) => {            // what you have learned belongs to you, not to one saved ranch: a load only ever adds
          if (!j || typeof j !== 'object') return;
          if (j.tour) mem.tour = 1;
          if (j.lessons && typeof j.lessons === 'object') Object.keys(j.lessons).forEach((k) => { if (j.lessons[k]) mem.lessons[k] = 1; });
          saveMem(); refreshLessons(); refreshTask();
        }
      });

      game.on('reset', () => { T.engaged = true; L.spots = null; L.valley = L.ridge = false; L.stormSeen = false; L.steepMsg = ''; L.swale = null; });
      game.on('strokeStart', () => { T.engaged = true; });
      game.on('stormStart', () => { T.engaged = true; L.stormSeen = true; });
      game.on('probe', onProbe);
      game.on('strokeEnd', (e) => {
        if (e.tool === 'look') onLookEnd(e);
        else if (e.tool === 'swale') onSwale(e);
        else if (e.tool === 'trace') onTrace(e);
        else if (e.tool === 'section') onSection(e);
      });
      game.on('frame', () => { tourFrame(); if (taskEl && !taskEl.classList.contains('hidden')) placeTask(); });
      game.on('ready', () => { CM = null; });
      setInterval(() => { try { tourTick(); } catch (e) { console.error('[creek] coach tick', e); } }, 400);
      window.addEventListener('resize', () => { T.sig = ''; });

      Object.assign(coach, {
        startTour: () => { T.forced = true; return startTour(); }, requestTour, endTour: () => endTour(true), tourActive: () => T.active,
        openLessons, showGlossary, levelScore,
        lessons: () => lessons().map((q) => ({ id: q.id, title: q.title, done: isDone(q) })),
        progress: () => { const l = lessons(); return { done: l.filter(isDone).length, total: l.length }; },
        sample, coarse
      });
    },

    ready: function () {
      refreshLessons();
    }
  });
})();
