/* The game itself: camera, touch/mouse, tools, storms, measurements, hints.
   It drives the engine (sim.js) and the map drawing (render.js) and talks to the
   screen furniture (ui.js) only through the small `Creek.ui` object. */
(function () {
  const C = Creek.CONFIG, CV = C.COVER, meta = Creek.worldMeta;

  Creek.TOOLS = [
    { id: 'look',   icon: '👆', label: 'Look',        help: 'Touch the map to read the ground and the water.' },
    { id: 'dig',    icon: '⛏️', label: 'Dig',         help: 'Hold and drag to dig. Makes swales, basins, gentler banks.', sizes: [0.6, 1.2, 2.4] },
    { id: 'pile',   icon: '⛰️', label: 'Pile',        help: 'Hold and drag to pile soil. Makes berms and dams.', sizes: [0.6, 1.2, 2.4] },
    { id: 'barrel', icon: '🛢️', label: 'Rain barrel', help: 'Tap near a corner of the house to put a barrel under the downspout.', card: 'barrel' },
    { id: 'garden', icon: '🌸', label: 'Rain garden', help: 'Tap the ground to dig a planted basin that holds water while it soaks in.', sizes: [1.2, 2.0, 3.0], card: 'garden' },
    { id: 'bda',    icon: '🪵', label: 'BDA',         help: 'Drag across the creek to build a post-and-branch weir.', sizes: [0.5, 0.7, 1.0], card: 'bda' },
    { id: 'grass',  icon: '🌾', label: 'Native grass',help: 'Hold and drag to plant deep-rooted native grasses.', sizes: [0.6, 1.2, 2.4], card: 'roots', plant: true },
    { id: 'tree',   icon: '🌳', label: 'Tree',        help: 'Tap to plant a tree. Trees grow slowly but root deepest.', card: 'roots', plant: true },
    { id: 'willow', icon: '🌿', label: 'Willow stake',help: 'Tap or drag along a creek bank to push in willow stakes.', card: 'willow', plant: true }
  ];
  const TOOL_NUM = { dig: 0, pile: 1, grass: 2, tree: 3, willow: 4, garden: 5, bda: 6 };
  const STAMP = { barrel: 1, garden: 1, tree: 1 };    // tools that act once per tap
  const SEASONS = ['summer', 'fall', 'winter', 'spring'];

  function Game(canvas) {
    this.canvas = canvas;
    this.cam = { x: 50, y: 75, scale: 4 };
    this.tool = 'look'; this.sizeIdx = 1;
    this.contour = 0.25; this.contourOn = true; this.lens = 0;
    this.pointers = new Map(); this.stroke = null; this.hover = null;
    this.barrels = [0, 1, 2, 3].map(() => ({ count: 0, vol: 0 }));
    this.storm = null; this.lastStorm = null; this.baseMoist = 0.15; this.season = null;
    this.spf = 3; this.ema = 16; this.turbo = false; this.time = 0; this.last = 0;
    this.hints = []; this.hintsShown = {}; this.activeHint = null;
    this.upstreamFactor = 1;           // later: neighbours joining in lowers this
    this.allowed = null;               // null = everything
    this.cbs = {};
  }
  const G = Game.prototype;

  // ---------------------------------------------------------------- boot
  G.boot = function (forceLevel) {
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser has no WebGL2.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This device cannot do float graphics.');
    this.renderer = new Creek.Renderer(gl);
    this.level = forceLevel != null ? forceLevel : this.calibrate();
    this.loadLevel(this.level);
    this.bindInput();
    this.resize(); this.fitCamera();
    window.addEventListener('resize', () => { this.resize(); this.fitScale = Math.min(this.cw / C.mapW, this.ch / C.mapH) * 0.96; });
    requestAnimationFrame((t) => { this.last = t; this.frame(t); });
  };

  G.calibrate = function () {
    const gl = this.gl;
    for (let L = 0; L < C.levels.length; L++) {
      const dx = C.levels[L];
      const world = Creek.generateWorld(dx), sim = new Creek.Sim(gl, world);
      sim.step(2); sim._read(sim._cur('W'), 0, 0, 1, 1);
      const t0 = performance.now(); sim.step(8); sim._read(sim._cur('W'), 0, 0, 1, 1);
      const ms = (performance.now() - t0) / 8;
      sim.dispose();
      const stepsNeeded = (C.stormBurst + C.stormTail) / (C.sim.dtPerCell * dx);
      const realSeconds = stepsNeeded * ms / 1000 / 0.65;
      if (realSeconds <= 55 || L === C.levels.length - 1) return L;
    }
    return C.levels.length - 1;
  };

  G.loadLevel = function (L) {
    if (this.sim) this.sim.dispose();
    this.level = L;
    this.world = Creek.generateWorld(C.levels[L]);
    this.sim = new Creek.Sim(this.gl, this.world);
    this.initialAnalysis = this.analyze(this.world.T);
    this.barrels.forEach(b => { b.count = 0; b.vol = 0; });
    this.sim.setSources([]);
    this.sim.dryOut(this.baseMoist, 0);
  };

  G.resize = function () {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr; this.cw = r.width; this.ch = r.height;
  };
  G.fitCamera = function () {
    const s = Math.min(this.cw / C.mapW, this.ch / C.mapH) * 0.96;
    this.fitScale = s; this.cam = { x: C.mapW / 2, y: C.mapH / 2, scale: s };
  };
  G.focusOn = function (x, y, scale) {
    this.cam.x = x; this.cam.y = y; this.cam.scale = Math.min(Math.max(scale || 9, this.fitScale * 0.8), 60);
  };
  G.toWorld = function (px, py) {
    return { x: this.cam.x + (px - this.cw / 2) / this.cam.scale, y: this.cam.y + (py - this.ch / 2) / this.cam.scale };
  };
  G.clampCam = function () {
    const c = this.cam; c.scale = Math.min(Math.max(c.scale, this.fitScale * 0.8), 60);
    c.x = Math.min(Math.max(c.x, 0), C.mapW); c.y = Math.min(Math.max(c.y, 0), C.mapH);
  };

  // ---------------------------------------------------------------- input
  G.bindInput = function () {
    const cv = this.canvas;
    cv.style.touchAction = 'none';
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, before = this.toWorld(px, py);
      this.cam.scale *= Math.exp(-e.deltaY * 0.0015); this.clampCam();
      const after = this.toWorld(px, py); this.cam.x += before.x - after.x; this.cam.y += before.y - after.y; this.clampCam();
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    const up = (e) => this.onUp(e);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.pointers.size) this.hover = null; });
  };
  G._pos = function (e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  G.onDown = function (e) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._pos(e);
    const panBtn = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, pan: panBtn, t: performance.now() });
    if (this.pointers.size >= 2) { this.cancelStroke(true); this.gesture = null; return; }
    if (panBtn) return;
    this.beginStroke(p);
  };
  G.onMove = function (e) {
    const p = this._pos(e), ptr = this.pointers.get(e.pointerId);
    if (e.pointerType === 'mouse') this.hover = p;
    if (!ptr) return;
    const px = ptr.x, py = ptr.y; ptr.x = p.x; ptr.y = p.y;
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.gesture) {
        const before = this.toWorld(this.gesture.cx, this.gesture.cy);
        this.cam.scale *= dist / Math.max(this.gesture.dist, 1); this.clampCam();
        const after = this.toWorld(cx, cy); this.cam.x += before.x - after.x; this.cam.y += before.y - after.y; this.clampCam();
      }
      this.gesture = { cx, cy, dist }; return;
    }
    if (ptr.pan) { this.cam.x -= (p.x - px) / this.cam.scale; this.cam.y -= (p.y - py) / this.cam.scale; this.clampCam(); return; }
    if (this.stroke) { this.stroke.pos = p; this.stroke.moved = Math.max(this.stroke.moved, Math.hypot(p.x - ptr.sx, p.y - ptr.sy)); if (this.tool === 'look') this.doLook(p); }
  };
  G.onUp = function (e) {
    const ptr = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.gesture = null;
    if (e.pointerType !== 'mouse') this.hover = null;
    if (!ptr || ptr.pan) return;
    if (this.stroke && this.pointers.size === 0) {
      const s = this.stroke; this.stroke = null;
      if (e.type === 'pointerup' && STAMP[this.tool] && s.moved < 14) this.doStamp(this._pos(e));
      if (this.tool === 'look') this.cbs.probe && this.cbs.probe(null);
      this.cbs.changed && this.cbs.changed();
    }
  };
  G.beginStroke = function (p) {
    if (this.tool === 'look') { this.stroke = { pos: p, moved: 0 }; this.doLook(p); return; }
    if (!this.canUse(this.tool)) { this.cbs.toast && this.cbs.toast(this.whyLocked(this.tool)); return; }
    this.stroke = { pos: p, moved: 0, started: performance.now(), saved: this.snapshotForUndo() };
    this.hover = p;
  };
  G.cancelStroke = function (undoIt) {
    if (this.stroke && undoIt && performance.now() - this.stroke.started < 400 && !STAMP[this.tool]) this.undo();
    this.stroke = null;
  };
  G.snapshotForUndo = function () {
    this.sim.saveUndo(); this.undoBarrels = this.barrels.map(b => ({ count: b.count, vol: b.vol })); return true;
  };
  G.undo = function () {
    if (this.sim.undo()) { if (this.undoBarrels) this.barrels.forEach((b, i) => Object.assign(b, this.undoBarrels[i])); this.cbs.changed && this.cbs.changed(); return true; }
    return false;
  };

  G.brushRadius = function () {
    const t = Creek.TOOLS.find(x => x.id === this.tool);
    if (this.tool === 'tree') return 1.0;
    if (this.tool === 'willow') return 0.45;
    return t && t.sizes ? t.sizes[this.sizeIdx] : 0.8;
  };

  G.doLook = function (p) {
    const now = performance.now(); if (this._lookT && now - this._lookT < 90) return; this._lookT = now;
    const w = this.toWorld(p.x, p.y);
    if (w.x < 0 || w.y < 0 || w.x > C.mapW || w.y > C.mapH) return;
    this.cbs.probe && this.cbs.probe({ info: this.sim.probe(w.x, w.y), x: p.x, y: p.y });
  };

  G.doStamp = function (p) {
    const w = this.toWorld(p.x, p.y);
    if (!this.canUse(this.tool)) return;
    if (this.tool === 'barrel') {
      let best = -1, bd = 1e9;
      meta.downspouts.forEach((d, i) => { const dd = Math.hypot(d.x - w.x, d.y - w.y); if (dd < bd) { bd = dd; best = i; } });
      if (bd > 7) { this.cbs.toast && this.cbs.toast('Tap near a corner of the house.'); return; }
      const b = this.barrels[best];
      if (b.count >= C.barrelMax) { this.cbs.toast && this.cbs.toast('That corner already has three barrels.'); return; }
      this.snapshotForUndo(); b.count++; this.cbs.toast && this.cbs.toast('Rain barrel added.'); return;
    }
    const probe = this.sim.probe(w.x, w.y);
    this.sim.applyTool(TOOL_NUM[this.tool], w.x, w.y, this.brushRadius(), 0, probe.h, 0.3);
  };

  G.applyBrush = function (dt) {
    const s = this.stroke; if (!s || this.tool === 'look' || STAMP[this.tool]) return;
    if (!this.canUse(this.tool)) return;
    const w = this.toWorld(s.pos.x, s.pos.y);
    const amt = (this.tool === 'dig' || this.tool === 'pile') ? 1.1 * Math.min(dt, 0.05) : 0;
    this.sim.applyTool(TOOL_NUM[this.tool], w.x, w.y, this.brushRadius(), amt, 0, 0);
  };

  // ---------------------------------------------------------------- tool access
  G.canUse = function (id) {
    if (!this.allowed) return true;
    return this.allowed.indexOf(id) >= 0;
  };
  G.whyLocked = function (id) {
    return Creek.TOOLS.find(t => t.id === id).plant ? 'Planting happens in winter.' : 'Not available right now.';
  };
  G.setTool = function (id) {
    if (!this.canUse(id)) { this.cbs.toast && this.cbs.toast(this.whyLocked(id)); return false; }
    this.tool = id; this.cbs.toolChanged && this.cbs.toolChanged(id); return true;
  };

  // ---------------------------------------------------------------- storms
  function profile(u) {
    if (u < 0.2) { const t = u / 0.2; return t * t * (3 - 2 * t); }
    if (u < 0.7) return 1;
    return 1 - 0.75 * (u - 0.7) / 0.3;
  }
  G.rainAt = function (size, t) {
    const S = C.storms[size], B = C.stormBurst;
    if (!this._norm || this._normSize !== size) {
      let integ = 0; for (let k = 0; k < 400; k++) integ += profile((k + 0.5) / 400) * B / 400;
      this._norm = (S.depth15 * 0.0254) / integ; this._normSize = size;
    }
    return t < B ? this._norm * profile(t / B) : 0;
  };

  G.startStorm = function (size, opts) {
    if (this.storm) return false;
    opts = opts || {};
    this.cancelStroke(false);
    this.sim.dryOut(this.baseMoist, 0.5);
    this.storm = {
      size, t: 0, Q: 0, tag: opts.tag || null, turbo: !!opts.turbo,
      before: this.sim.readTerrain(), pool: 0, poolAt: null,
      peakFence: 0, volFence: 0, peakOut: 0, volOut: 0, mudVol: 0, rainVol: 0, poolDone: false
    };
    this.turbo = !!opts.turbo; this.sim.setRain(0);
    this.cbs.stormStart && this.cbs.stormStart(this.storm);
    return true;
  };
  G.stopStorm = function () { if (this.storm) this.finishStorm(); };

  G.stepStorm = function () {
    const st = this.storm, sim = this.sim, B = C.stormBurst, end = B + C.stormTail;
    const n = Math.max(1, Math.round(this.spf)), simDt = n * sim.dt;
    const rain = this.rainAt(st.size, st.t + simDt / 2);
    const up = C.upstream, A = up.areaM2 * this.upstreamFactor;
    st.Q += (up.runoff[st.size] * rain * A - st.Q) / up.lag * simDt; st.Q = Math.max(st.Q, 0);
    const R = meta.sources, sp = up.split, list = [];
    const addRect = (r, q) => list.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, rate: q / Math.max((r.x1 - r.x0) * (r.y1 - r.y0), 0.01) });
    addRect(R.street, st.Q * sp.street); addRect(R.left, st.Q * sp.left); addRect(R.right, st.Q * sp.right); addRect(R.outfall, st.Q * sp.outfall);
    meta.downspouts.forEach((d, k) => {
      const b = this.barrels[k]; let q = rain * meta.roofArea[k];
      if (b.count > 0) {
        const cap = b.count * C.barrelLiters / 1000;
        if (rain > 0) { const take = Math.min(q * simDt, Math.max(cap - b.vol, 0)); b.vol += take; q -= take / simDt; }
        else if (b.vol > 0) { const out = Math.min(b.vol, C.barrelDrain * b.count * simDt); b.vol -= out; q += out / simDt; }
      }
      addRect({ x0: d.x - 0.5, x1: d.x + 0.5, y0: d.y - 0.5, y1: d.y + 0.5 }, q);
    });
    sim.setSources(list); sim.setRain(rain);
    sim.step(n);
    st.t += simDt; st.rainVol += rain * C.mapW * C.mapH * simDt;

    const fence = sim.flowAcross(meta.fenceY - 0.6, meta.yard.x0, meta.yard.x1), out = sim.flowAcross(C.mapH - 0.01, 0, C.mapW);
    st.volFence += fence.q * simDt; st.peakFence = Math.max(st.peakFence, fence.q);
    st.volOut += out.q * simDt; st.peakOut = Math.max(st.peakOut, out.q); st.mudVol += out.mudQ * simDt;
    st.Qnow = out.q;
    if (!st.poolDone && st.t >= B * 0.8) { st.poolDone = true; this.measurePool(st); }
    if (st.t >= end) this.finishStorm();
  };

  G.measurePool = function (st) {
    const W = this.sim.readWater(), nx = this.sim.nx, dx = this.sim.dx, H = meta.house, pad = 3;
    let best = 0, bx = 0, by = 0, n = 0;
    const i0 = Math.floor((H.x0 - pad) / dx), i1 = Math.ceil((H.x1 + pad) / dx), j0 = Math.floor((H.y0 - pad) / dx), j1 = Math.ceil((H.y1 + pad) / dx);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const x = (i + 0.5) * dx, y = (j + 0.5) * dx;
      if (x > H.x0 - 0.1 && x < H.x1 + 0.1 && y > H.y0 - 0.1 && y < H.y1 + 0.1) continue;
      const d = W[(j * nx + i) * 4]; if (d > best) { best = d; bx = x; by = y; } if (d > 0.04) n++;
    }
    if (best > st.pool) { st.pool = best; st.poolAt = { x: bx, y: by }; st.poolArea = n * dx * dx; }
  };

  G.finishStorm = function () {
    const st = this.storm; this.storm = null; this.turbo = false; this.sim.setRain(0); this.sim.setSources([]);
    const after = this.sim.readTerrain(), dx = this.sim.dx, nx = this.sim.nx, ny = this.sim.ny, Y = meta.yard;
    let lost = 0, washN = 0, wx = 0, wy = 0, creekLost = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 4, dh = after[k] - st.before[k]; if (dh >= -1e-4) continue;
      const x = (i + 0.5) * dx, y = (j + 0.5) * dx, cov = Math.round(st.before[k + 2]);
      if (y > meta.creekHeadY) { creekLost += -dh * dx * dx; continue; }
      if (x > Y.x0 && x < Y.x1 && y > Y.y0 && y < Y.y1) { lost += -dh * dx * dx; if (dh < -0.015 && cov !== CV.PAVE) { washN++; wx += x; wy += y; } }
    }
    const an = this.analyze(after);
    const res = {
      size: st.size, tag: st.tag, peakFence: st.peakFence, volFence: st.volFence, peakOut: st.peakOut, volOut: st.volOut,
      mudVol: st.mudVol, mudConc: st.volOut > 0 ? st.mudVol / st.volOut : 0, yardSoilLost: lost, creekSoilLost: creekLost,
      pool: st.pool, poolAt: st.poolAt, poolArea: st.poolArea || 0, wash: washN * dx * dx, washAt: washN ? { x: wx / washN, y: wy / washN } : null,
      bank: an.bankMean, bankMax: an.bankMax, bareShare: an.bareShare, barrels: this.barrels.reduce((a, b) => a + b.count, 0)
    };
    this.lastStorm = res; this.analysis = an;
    this.cbs.stormEnd && this.cbs.stormEnd(res);
  };

  // ---------------------------------------------------------------- measuring the creek
  /** Reads a terrain array (the CPU copy of the land) and reports how tall the creek banks are. */
  G.analyze = function (T) {
    const nx = Math.round(C.mapW / this.world.dx), dx = this.world.dx;
    const at = (x, y) => { const i = Math.min(nx - 1, Math.max(0, Math.floor(x / dx))), j = Math.floor(y / dx); return (j * nx + i) * 4; };
    let sum = 0, n = 0, mx = 0, bare = 0, faces = 0;
    for (let y = 72; y < 148; y += 2) {
      const xc = meta.creekX(y); let bed = 1e9;
      for (let x = xc - 2; x <= xc + 2; x += dx) bed = Math.min(bed, T[at(x, y)]);
      const top = (T[at(xc - 5.5, y)] + T[at(xc + 5.5, y)]) / 2, H = Math.max(top - bed, 0);
      sum += H; n++; mx = Math.max(mx, H);
      for (let x = xc - 5; x <= xc + 5; x += Math.max(dx, 0.5)) {
        const k = at(x, y); if (T[k] - bed > 0.3) { faces++; if (Math.round(T[k + 2]) === CV.BARE) bare++; }
      }
    }
    return { bankMean: sum / n, bankMax: mx, bareShare: faces ? bare / faces : 0 };
  };

  // ---------------------------------------------------------------- seasons, growth
  G.setSeason = function (name) {
    this.season = name;
    this.baseMoist = { summer: 0.05, fall: 0.3, winter: 0.45, spring: 0.5 }[name] || 0.15;
    this.sim.dryOut(this.baseMoist, 0.4);
  };
  G.growSeason = function () { this.sim.grow(C.growth); this.analysis = this.analyze(this.sim.readTerrain()); };
  G.resetMap = function () {
    this.sim.reset(); this.barrels.forEach(b => { b.count = 0; b.vol = 0; });
    this.sim.dryOut(this.baseMoist, 0); this.lastStorm = null; this.analysis = null; this.cbs.changed && this.cbs.changed();
  };

  // ---------------------------------------------------------------- hints (gentle, never blocking)
  G.computeHints = function () {
    const an = this.analysis || this.analyze(this.sim.readTerrain()), ls = this.lastStorm, out = [];
    this.analysis = an;
    const planting = this.canUse('grass');
    if (an.bankMean > 0.9 && an.bareShare > 0.35) out.push({
      id: 'bank', x: meta.creekX(80), y: 80, r: 7, tool: planting ? 'grass' : 'dig',
      text: 'The bank behind your fence is taller than 3 feet and bare. Roots only protect a bank as deep as they reach, and the water can’t spill out, so every storm digs at it. ' +
        (planting ? 'Native grasses and willows reach deep.' : 'Try digging the top of the bank back into a gentler slope.')
    });
    if (ls && ls.pool > 0.05 && ls.poolAt) out.push({
      id: 'pool', x: ls.poolAt.x, y: ls.poolAt.y, r: 4, tool: 'garden',
      text: 'Water pooled against the house here (about ' + Math.round(ls.pool * 100) + ' cm deep). A rain garden or a swale could give it somewhere else to go.'
    });
    if (ls && ls.wash > 6 && ls.washAt) out.push({
      id: 'wash', x: ls.washAt.x, y: ls.washAt.y, r: 6, tool: planting ? 'grass' : 'dig',
      text: 'Bare ground here washed toward the creek. Bare soil holds nothing. Something growing on it would.'
    });
    if (this.barrels.every(b => b.count === 0)) out.push({
      id: 'roof', x: meta.house.x0 - 0.8, y: meta.house.y0 - 0.8, r: 3, tool: 'barrel',
      text: 'Every drop on the roof leaves through four downspouts at the corners. A rain barrel under one holds some back and lets it out after the storm.'
    });
    out.push({
      id: 'lines', x: 50, y: 40, r: 5, tool: 'look',
      text: 'The brown lines are contour lines: every point on a line is the same height. Lines close together mean steep ground. Water runs downhill, straight across the lines.'
    });
    return out.filter(h => !this.hintsShown[h.id] || this.hintsShown[h.id] < 2);
  };

  // ---------------------------------------------------------------- the loop
  G.frame = function (ts) {
    const dt = Math.min((ts - this.last) / 1000, 0.1); this.last = ts; this.time = ts / 1000;
    this.ema = this.ema * 0.9 + dt * 1000 * 0.1;
    const target = this.turbo ? 45 : 24;
    if (this.ema > target * 1.25) this.spf = Math.max(1, this.spf * 0.88);
    else if (this.ema < target * 0.85) this.spf = Math.min(this.turbo ? 160 : 70, this.spf * 1.08 + 0.2);
    try {
      this.applyBrush(dt);
      if (this.storm) this.stepStorm();
      this.draw();
    } catch (err) { console.error(err); this.cbs.error && this.cbs.error(err); return; }
    requestAnimationFrame((t) => this.frame(t));
  };

  G.draw = function () {
    const meta2 = meta;
    let brush = { x: 0, y: 0, r: 0, on: false };
    const bp = this.stroke ? this.stroke.pos : (this.hover && this.tool !== 'look' ? this.hover : null);
    if (bp && this.tool !== 'look' && this.tool !== 'barrel') { const w = this.toWorld(bp.x, bp.y); brush = { x: w.x, y: w.y, r: this.brushRadius(), on: true }; }
    const tints = { summer: [1, 0.86, 0.5, 0.05], fall: [0.95, 0.5, 0.2, 0.07], winter: [0.65, 0.78, 0.95, 0.09], spring: [0.6, 0.9, 0.6, 0.04] };
    const hints = this.activeHint ? [this.activeHint] : [];
    this.renderer.draw(this.sim.views(), {
      cam: { x: this.cam.x, y: this.cam.y, scale: this.cam.scale * this.dpr }, time: this.time,
      contour: this.contourOn ? this.contour : 0, lens: this.lens, brush: { x: brush.x, y: brush.y, r: brush.r, on: brush.on },
      hints, tint: this.season ? tints[this.season] : null,
      spouts: this.tool === 'barrel', spoutPos: meta2.downspouts,
      barrels: meta2.downspouts.map((d, k) => ({ x: d.x + (d.x < 40 ? -0.6 : 0.6), y: d.y + (d.y < 25 ? -0.6 : 0.6), count: this.barrels[k].count, fill: this.barrels[k].count ? this.barrels[k].vol / (this.barrels[k].count * C.barrelLiters / 1000) : 0 }))
    }, this.canvas.width, this.canvas.height);
    this.cbs.scale && this.cbs.scale(this.cam.scale);
  };

  /** A picture of the whole map (no water), used for the before/after page. */
  G.snapshot = function (width) {
    const c = this.canvas, save = { cam: this.cam, w: c.width, h: c.height, dpr: this.dpr, cw: this.cw, ch: this.ch };
    const h = Math.round(width * C.mapH / C.mapW);
    c.width = width; c.height = h; this.cw = width; this.ch = h; this.dpr = 1;
    const sc = Math.min(width / C.mapW, h / C.mapH);
    this.renderer.draw(this.sim.views(), {
      cam: { x: C.mapW / 2, y: C.mapH / 2, scale: sc }, time: 0, contour: 0.25, lens: 0, brush: { x: 0, y: 0, r: 0, on: false }, hints: [], tint: null, spouts: false, spoutPos: [], barrels: []
    }, width, h);
    const out = document.createElement('canvas'); out.width = width; out.height = h;
    out.getContext('2d').drawImage(c, 0, 0);
    const url = out.toDataURL('image/jpeg', 0.85);
    c.width = save.w; c.height = save.h; this.cam = save.cam; this.dpr = save.dpr; this.cw = save.cw; this.ch = save.ch;
    return url;
  };

  Creek.Game = Game;
})();
