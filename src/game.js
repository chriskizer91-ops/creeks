/* The game itself: camera, touch/mouse, tools, fields, money, storms, measurements, hints.
   It drives the engine (sim.js) and the map drawing (render.js) and talks to the
   screen furniture (ui.js) only through the small `cbs` callbacks. */
(function () {
  const C = Creek.CONFIG, CV = C.COVER;
  const USES = C.uses;
  const SEASONS = ['summer', 'fall', 'winter', 'spring'];
  const FT = 3.281;

  const useTools = Object.keys(USES).filter(k => k !== 'wild').map(k => ({ id: k, icon: USES[k].icon, label: USES[k].short, long: USES[k].label }));
  Creek.TOOLS = [
    { id: 'look',   icon: '👆', label: 'Look',       kind: 'look',  help: 'Touch the map to read the ground and the water. The contour line through that spot lights up.' },
    { id: 'dig',    icon: '⛏️', label: 'Dig',        kind: 'paint', gl: 0, sizes: [3, 6, 12], help: 'Hold and drag to dig. Lower a bank, dig a ditch, shape a bench.' },
    { id: 'pile',   icon: '⛰️', label: 'Pile',       kind: 'paint', gl: 1, sizes: [3, 6, 12], help: 'Hold and drag to pile soil. Build berms and dams.' },
    { id: 'swale',  icon: '〰️', label: 'Swale',      kind: 'paint', gl: 7, sizes: [2, 3, 4], card: 'swale', help: 'Drag along a contour line. The line you are following lights up. Water stops in a level ditch and soaks in.' },
    { id: 'pond',   icon: '💧', label: 'Pond',       kind: 'stamp', gl: 5, sizes: [8, 14, 22], card: 'pond', help: 'Tap to dig a pond. Tap low ground, where water already wants to go.' },
    { id: 'dam',    icon: '🪵', label: 'Check dam',  kind: 'paint', gl: 6, sizes: [2, 3, 5], card: 'bda', help: 'Drag across a gully or creek to build a post-and-branch dam (BDA).' },
    { id: 'plant',  icon: '🌱', label: 'Plant', card: 'roots', help: 'Pick what to plant.', opts: [
        { id: 'grass', icon: '🌾', label: 'Native grass', kind: 'paint', gl: 2, sizes: [3, 6, 12] },
        { id: 'tree', icon: '🌳', label: 'Trees', kind: 'stamp', gl: 3, sizes: [5] },
        { id: 'willow', icon: '🌿', label: 'Willow stakes', kind: 'paint', gl: 4, sizes: [3] }] },
    { id: 'fields', icon: '🚜', label: 'Fields', kind: 'stamp', card: 'fields', help: 'Pick a land use, then tap a field to switch it.', opts: useTools }
  ];

  function Game(canvas) {
    this.canvas = canvas;
    this.cam = { x: C.mapW / 2, y: C.mapH / 2, scale: 0.3 };
    this.tool = 'look'; this.sizeIdx = 1; this.optIdx = { plant: 0, fields: 0 };
    this.contourOn = true; this.lens = 0; this.contourStep = 2;
    this.pointers = new Map(); this.stroke = null; this.hover = null;
    this.storm = null; this.lastStorm = null; this.baseline = null;
    this.season = 'summer'; this.year = 1; this.baseMoist = 0.05;
    this.cash = C.money.start; this.ledger = []; this.groundwater = 9000;
    this.spf = 2; this.ema = 16; this.turbo = false; this.time = 0; this.last = 0;
    this.hintsShown = {}; this.activeHint = null; this.hiH = null;
    this.upstreamFactor = 1;           // later: neighbours joining in lowers this
    this.allowed = null;               // null = everything
    this.cbs = {}; this.ready = false;
  }
  const G = Game.prototype;

  // ---------------------------------------------------------------- boot
  G.boot = async function (forceLevel) {
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser has no WebGL2.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This device cannot do float graphics.');
    this.renderer = new Creek.Renderer(gl);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => { this.resize(); });
    this.cbs.progress && this.cbs.progress('Timing your graphics chip…', 0);
    await new Promise(r => setTimeout(r, 30));
    const level = forceLevel != null ? forceLevel : this.calibrate();
    await this.loadLevel(level);
    this.fitCamera();
    this.ready = true;
    requestAnimationFrame((t) => { this.last = t; this.frame(t); });
  };

  /** Time a few water steps on an empty map at each detail level; pick the finest that gives a storm in good time. */
  G.calibrate = function () {
    const gl = this.gl, log = [];
    for (let L = 0; L < C.levels.length; L++) {
      const dx = C.levels[L], nx = Math.round(C.mapW / dx), ny = Math.round(C.mapH / dx);
      let sim = null, ms = 1e9;
      try {
        const T = new Float32Array(nx * ny * 4), M = new Float32Array(nx * ny * 4);
        for (let i = 0; i < nx * ny; i++) { T[i * 4] = 10 - i / (nx * ny); T[i * 4 + 1] = 5; }
        sim = new Creek.Sim(gl, { nx, ny, dx, T, M, meta: {} });
        sim.step(2); sim._read(sim._cur('W'), 0, 0, 1, 1);
        const t0 = performance.now(); sim.step(6); sim._read(sim._cur('W'), 0, 0, 1, 1);
        ms = (performance.now() - t0) / 6;
      } catch (e) { ms = 1e9; }
      if (sim) sim.dispose();
      const steps = (C.stormBurst + C.stormTail) / (0.09 * dx);
      const seconds = steps * ms / 1000 / 0.7;
      log.push([dx, ms.toFixed(1) + 'ms', Math.round(seconds) + 's']);
      if (seconds <= C.stormSecondsTarget || L === C.levels.length - 1) { this.calibLog = log; return L; }
    }
    return C.levels.length - 1;
  };

  G.loadLevel = async function (L) {
    this.ready = false;
    if (this.sim) { this.sim.dispose(); this.sim = null; }
    this.level = L;
    const dx = C.levels[L];
    this.cbs.progress && this.cbs.progress('Surveying the ranch (' + Math.round(C.mapW / dx * C.mapH / dx / 1000) + ' thousand cells)…', 0.02);
    this.world = await Creek.generateWorldAsync(dx, (f) => this.cbs.progress && this.cbs.progress('Surveying the ranch…', 0.05 + 0.85 * f));
    this.cbs.progress && this.cbs.progress('Loading the land onto the graphics chip…', 0.95);
    await new Promise(r => setTimeout(r, 20));
    this.sim = new Creek.Sim(this.gl, this.world);
    this.fields = this.world.meta.fields.map(f => Object.assign({}, f));
    this.cash = C.money.start; this.ledger = []; this.groundwater = 9000; this.year = 1; this.season = 'summer'; this.baseMoist = C.seasons.summer.moist;
    this.initialAnalysis = this.analyze(this.world.T);
    this.sim.dryOut(this.baseMoist, 0);
    this.sim.clearRecord();
    this.lastStorm = null; this.analysis = null; this.baseline = null;
    this.cbs.progress && this.cbs.progress(null);
    this.cbs.cash && this.cbs.cash(this.cash);
    this.cbs.fieldsChanged && this.cbs.fieldsChanged();
    this.ready = true;
  };

  G.resize = function () {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr; this.cw = r.width; this.ch = r.height;
    this.fitScale = Math.min(this.cw / C.mapW, this.ch / C.mapH) * 0.96;
  };
  G.fitCamera = function () { this.cam = { x: C.mapW / 2, y: C.mapH / 2, scale: this.fitScale }; };
  G.focusOn = function (x, y, scale) { this.cam.x = x; this.cam.y = y; this.cam.scale = Math.min(Math.max(scale || 3, this.fitScale * 0.8), 30); };
  G.toWorld = function (px, py) { return { x: this.cam.x + (px - this.cw / 2) / this.cam.scale, y: this.cam.y + (py - this.ch / 2) / this.cam.scale }; };
  G.project = function (x, y) { return { x: (x - this.cam.x) * this.cam.scale + this.cw / 2, y: (y - this.cam.y) * this.cam.scale + this.ch / 2 }; };
  G.clampCam = function () {
    const c = this.cam; c.scale = Math.min(Math.max(c.scale, this.fitScale * 0.8), 30);
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
    if (!this.ready) return;
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
      const s = this.stroke; this.stroke = null; this.hiH = null;
      const d = this.cur();
      if (e.type === 'pointerup' && d.kind === 'stamp' && s.moved < 14) this.doStamp(this._pos(e));
      else if (s.cost > 0) this.charge(s.cost, d.label || 'Earthwork');
      if (d.kind === 'look') this.cbs.probe && this.cbs.probe(null);
      this.cbs.changed && this.cbs.changed();
    }
  };

  /** The tool as currently set up (picks the chosen option for tools that have a menu). */
  G.cur = function () {
    const t = Creek.TOOLS.find(x => x.id === this.tool) || Creek.TOOLS[0];
    if (!t.opts) return t;
    const o = t.opts[Math.min(this.optIdx[t.id] || 0, t.opts.length - 1)];
    return Object.assign({}, t, o, { id: t.id, optId: o.id, kind: o.kind || t.kind });
  };
  G.brushRadius = function () { const d = this.cur(); return d.sizes ? d.sizes[Math.min(this.sizeIdx, d.sizes.length - 1)] : 3; };

  G.beginStroke = function (p) {
    const d = this.cur();
    if (d.kind === 'look') { this.stroke = { pos: p, moved: 0 }; this.doLook(p); return; }
    if (!this.canUse(this.tool)) { this.cbs.toast && this.cbs.toast(this.whyLocked(this.tool)); return; }
    if (d.kind === 'paint' && this.cam.scale < 0.8) { this.cbs.toast && this.cbs.toast('Zoom in a little to work here (pinch or scroll).'); return; }
    this.stroke = { pos: p, moved: 0, started: performance.now(), saved: this.snapshotForUndo(), cost: 0, last: null, href: null };
    this.hover = p;
    if (this.tool === 'swale') { const w = this.toWorld(p.x, p.y); this.stroke.href = this.sim.probe(w.x, w.y).h; }
  };
  G.cancelStroke = function (undoIt) {
    const d = this.cur();
    if (this.stroke && undoIt && performance.now() - this.stroke.started < 400 && d.kind !== 'stamp') this.undo();
    this.stroke = null; this.hiH = null;
  };
  G.snapshotForUndo = function () {
    this.sim.saveUndo(); this.undoState = { fields: this.fields.map(f => f.use), cash: this.cash, ledger: this.ledger.length }; return true;
  };
  G.undo = function () {
    if (this.sim.undo()) {
      const u = this.undoState;
      if (u) { this.fields.forEach((f, i) => f.use = u.fields[i]); this.cash = u.cash; this.ledger.length = u.ledger; this.cbs.cash && this.cbs.cash(this.cash); this.cbs.fieldsChanged && this.cbs.fieldsChanged(); }
      this.cbs.changed && this.cbs.changed(); return true;
    }
    return false;
  };

  G.doLook = function (p) {
    const now = performance.now(); if (this._lookT && now - this._lookT < 90) return; this._lookT = now;
    const w = this.toWorld(p.x, p.y);
    if (w.x < 0 || w.y < 0 || w.x > C.mapW || w.y > C.mapH) return;
    const info = this.sim.probe(w.x, w.y); this.hiH = info.h;
    this.cbs.probe && this.cbs.probe({ info, x: p.x, y: p.y });
  };

  G.charge = function (amount, text) {
    amount = Math.round(amount); if (!amount) return;
    this.cash -= amount; this.ledger.push({ y: this.year, s: this.season, amount: -amount, text });
    this.cbs.cash && this.cbs.cash(this.cash);
  };

  G.doStamp = function (p) {
    const d = this.cur(), w = this.toWorld(p.x, p.y);
    if (!this.canUse(this.tool)) return;
    if (w.x < 0 || w.y < 0 || w.x > C.mapW || w.y > C.mapH) return;
    const probe = this.sim.probe(w.x, w.y);
    if (d.id === 'fields') {
      const f = this.fields[probe.field - 1];
      if (!probe.field || !f) { this.cbs.toast && this.cbs.toast('That is not one of your fields. Tap inside a labelled field.'); return; }
      this.setFieldUse(f, d.optId);
      return;
    }
    const r = this.brushRadius();
    if (d.id === 'pond') {
      const depth = 2.4, vol = Math.PI * r * r * depth * 0.5;
      this.sim.applyTool(d.gl, w.x, w.y, r, 0, probe.h, depth);
      this.charge(C.money.pond + vol * C.money.digPerM3, 'Pond'); this.cbs.toast && this.cbs.toast('Pond dug.');
      return;
    }
    // trees
    this.sim.applyTool(d.gl, w.x, w.y, r, 0, 0, 0);
    this.charge(C.money.treePerStamp, 'Trees');
  };

  G.setFieldUse = function (f, useId) {
    const u = USES[useId]; if (!u) return;
    if (f.use === useId) { this.cbs.toast && this.cbs.toast(f.name + ' is already ' + u.label.toLowerCase() + '.'); return; }
    this.snapshotForUndo();
    f.use = useId;
    this.sim.setLandUse(f.id, u.cover, u.growth);
    const ha = f.area / 1e4, cost = ha * u.cost;
    if (cost > 0) this.charge(cost, f.name + ' → ' + u.short);
    this.cbs.toast && this.cbs.toast(f.name + ' is now ' + u.label.toLowerCase() + (cost > 0 ? ' (−$' + Math.round(cost).toLocaleString() + ')' : '') + '.');
    this.cbs.fieldsChanged && this.cbs.fieldsChanged();
  };

  G.applyBrush = function (dt) {
    const s = this.stroke, d = this.cur(); if (!s || d.kind !== 'paint' || !this.canUse(this.tool)) return;
    const w = this.toWorld(s.pos.x, s.pos.y), r = this.brushRadius(), M = C.money;
    if (this.tool === 'swale') this.hiH = s.href;
    const step = s.last ? Math.hypot(w.x - s.last.x, w.y - s.last.y) : 2 * r;
    s.last = w;
    switch (d.id) {
      case 'dig': case 'pile': {
        const amt = C.tools.digRate * Math.min(dt, 0.05);
        this.sim.applyTool(d.gl, w.x, w.y, r, amt, 0, 0);
        s.cost += Math.PI * r * r * 0.5 * amt * M.digPerM3; break;
      }
      case 'swale':
        this.sim.applyTool(7, w.x, w.y, r, 0, s.href, 0.6); s.cost += step * (M.swalePerM + 0.5 * r * 0.6 * M.digPerM3); break;
      case 'dam':
        this.sim.applyTool(6, w.x, w.y, r, 0.9, 0, 0); s.cost += step * M.dam / 10; break;
      case 'plant':
        this.sim.applyTool(d.gl, w.x, w.y, r, 0, 0, 0);
        s.cost += d.optId === 'willow' ? step * M.willowPerStamp / 5 : step * 2 * r * M.grassPerM2; break;
    }
  };

  // ---------------------------------------------------------------- tool access
  G.canUse = function (id) { return !this.allowed || this.allowed.indexOf(id) >= 0; };
  G.whyLocked = function (id) { return id === 'plant' ? 'Planting happens in winter.' : 'Not available right now.'; };
  G.setTool = function (id, opt) {
    if (!this.canUse(id)) { this.cbs.toast && this.cbs.toast(this.whyLocked(id)); return false; }
    this.tool = id;
    if (opt != null) this.optIdx[id] = opt;
    this.sizeIdx = Math.min(this.sizeIdx, (this.cur().sizes || [0]).length - 1);
    this.cbs.toolChanged && this.cbs.toolChanged(id); return true;
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
      this._norm = (S.depth30 * 0.0254) / integ; this._normSize = size;
    }
    return t < B ? this._norm * profile(t / B) : 0;
  };

  G.startStorm = function (size, opts) {
    if (this.storm || !this.ready) return false;
    opts = opts || {};
    this.cancelStroke(false);
    if (opts.moist != null) this.sim.dryOut(opts.moist, 0); else this.sim.dryOut(this.baseMoist, 0.5);
    this.sim.clearRecord();
    this.storm = {
      size, t: 0, Q: 0, tag: opts.tag || null, turbo: !!opts.turbo,
      before: this.sim.readTerrain(), peakOut: 0, volOut: 0, mudVol: 0, rainVol: 0, Qnow: 0
    };
    this.turbo = !!opts.turbo; this.sim.setRain(0);
    this.cbs.stormStart && this.cbs.stormStart(this.storm);
    return true;
  };
  G.stopStorm = function () { if (this.storm) this.finishStorm(); };

  G.stepStorm = function () {
    const st = this.storm, sim = this.sim, B = C.stormBurst, end = B + C.stormTail, meta = this.world.meta;
    sim.setDtFromFlow(Math.max(st.Q, st.Qnow));
    const n = Math.max(1, Math.round(this.spf)), simDt = n * sim.dt;
    const rain = this.rainAt(st.size, st.t + simDt / 2);
    const up = C.upstream, A = up.areaM2 * this.upstreamFactor;
    st.Q += (up.runoff[st.size] * rain * A - st.Q) / up.lag * simDt; st.Q = Math.max(st.Q, 0);
    const base = this.groundwater * 1.5e-6;                     // m³/s of creek baseflow
    const R = meta.sources, sp = up.split, list = [];
    const addRect = (r, q) => list.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, rate: q / Math.max((r.x1 - r.x0) * (r.y1 - r.y0), 0.01) });
    addRect(R.main, st.Q * sp.main + base); addRect(R.top, st.Q * sp.top); addRect(R.west, st.Q * sp.west); addRect(R.east, st.Q * sp.east);
    sim.setSources(list); sim.setRain(rain);
    sim.step(n);
    st.t += simDt; st.rainVol += rain * C.mapW * C.mapH * simDt;
    const out = sim.flowAcross(C.mapH - 0.01, 0, C.mapW);
    st.volOut += out.q * simDt; st.peakOut = Math.max(st.peakOut, out.q); st.mudVol += out.mudQ * simDt; st.Qnow = out.q;
    if (st.t >= end) this.finishStorm();
  };

  G.finishStorm = function () {
    const st = this.storm; this.storm = null; this.turbo = false; this.sim.setRain(0); this.sim.setSources([]);
    const sim = this.sim, dx = sim.dx, n = sim.nx * sim.ny, dx2 = dx * dx;
    const after = sim.readTerrain(), rec = sim.readRecord(), M = sim.readMoisture();
    const per = this.fields.map(() => ({ lost: 0, gain: 0, infil: 0, n: 0, flood: 0 }));
    let lostAll = 0, infilVol = 0, flood = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 4, dh = after[k] - st.before[k], fid = Math.round(M[k + 3]);
      infilVol += rec[k] * dx2;
      if (rec[k + 2] > 0.3) flood += dx2;
      if (dh < -1e-4) { lostAll += -dh * dx2; if (fid) per[fid - 1].lost += -dh * dx2; }
      if (fid) { const p = per[fid - 1]; p.n++; p.infil += rec[k]; if (rec[k + 2] > 0.3) p.flood += dx2; }
    }
    const an = this.analyze(after);
    this.groundwater += 0.12 * infilVol;
    const res = {
      size: st.size, tag: st.tag, peakOut: st.peakOut, volOut: st.volOut, rainVol: st.rainVol,
      mudVol: st.mudVol, mudConc: st.volOut > 0 ? st.mudVol / st.volOut : 0,
      soilLost: lostAll, infilVol, soakShare: st.rainVol > 0 ? infilVol / st.rainVol : 0, floodHa: flood / 1e4,
      fields: per.map((p, i) => ({ id: i + 1, lostPerHa: this.fields[i].area ? p.lost / (this.fields[i].area / 1e4) : 0, infilMm: p.n ? p.infil / p.n * 1000 : 0, floodHa: p.flood / 1e4 })),
      an, somMean: this.meanSom(M), groundwater: this.groundwater
    };
    this.lastStorm = res; this.analysis = an;
    this.cbs.stormEnd && this.cbs.stormEnd(res);
  };

  G.meanSom = function (M) {
    let s = 0, k = 0; const n = this.sim.nx * this.sim.ny;
    for (let i = 0; i < n; i++) { if (M[i * 4 + 3] > 0) { s += M[i * 4 + 2]; k++; } }
    return k ? s / k : 0;
  };

  // ---------------------------------------------------------------- measuring creeks
  /** Reads a terrain array (the CPU copy of the land); reports bank height and bareness along the main creek and each gully. */
  G.analyze = function (T) {
    const dx = this.world.dx, nx = Math.round(C.mapW / dx), meta = this.world.meta;
    const idx = (x, y) => { const i = Math.min(nx - 1, Math.max(0, Math.floor(x / dx))), j = Math.min(Math.round(C.mapH / dx) - 1, Math.max(0, Math.floor(y / dx))); return (j * nx + i) * 4; };
    const acc = meta.streams.map(() => ({ sum: 0, n: 0, max: 0, bare: 0, faces: 0, x: 0, y: 0 }));
    for (const s of meta.samples) {
      const a = acc[s.s]; let bed = 1e9;
      for (let o = -(s.wb + 2); o <= s.wb + 2; o += Math.max(1, dx * 0.5)) bed = Math.min(bed, T[idx(s.x + s.nx * o, s.y + s.ny * o)]);
      const far = s.wb + s.run + (s.s === 0 ? 14 : 7);
      const top = (T[idx(s.x + s.nx * far, s.y + s.ny * far)] + T[idx(s.x - s.nx * far, s.y - s.ny * far)]) / 2;
      const H = Math.max(top - bed, 0); a.sum += H; a.n++; a.max = Math.max(a.max, H);
      const fw = s.wb + s.run + 1;
      for (let o = -fw; o <= fw; o += Math.max(1, dx * 0.75)) {
        const k = idx(s.x + s.nx * o, s.y + s.ny * o);
        if (T[k] - bed > 0.3) { a.faces++; if (Math.round(T[k + 2]) === CV.BARE) a.bare++; }
      }
      a.x += s.x; a.y += s.y;
    }
    const out = acc.map((a, k) => ({ id: meta.streams[k].id, name: meta.streams[k].name, mean: a.n ? a.sum / a.n : 0, max: a.max, bareShare: a.faces ? a.bare / a.faces : 0, x: a.n ? a.x / a.n : 0, y: a.n ? a.y / a.n : 0 }));
    const gul = out.slice(1);
    return { main: out[0], gullies: gul, bankMean: out[0].mean, gullyMean: gul.reduce((q, g) => q + g.mean, 0) / Math.max(1, gul.length) };
  };

  // ---------------------------------------------------------------- the farm: seasons, money
  /** Money earned from the land as it is now: crops, grazing, trees. Returns per-field figures and the season's net. */
  G.computeEconomy = function () {
    const sim = this.sim, T = sim.readTerrain(), M = sim.readMoisture(), n = sim.nx * sim.ny, ha = sim.dx * sim.dx / 1e4;
    const per = this.fields.map(() => ({ rev: 0, exp: 0, n: 0, som: 0, grow: 0 }));
    for (let i = 0; i < n; i++) {
      const k = i * 4, fid = Math.round(M[k + 3]); if (!fid) continue;
      const cover = Math.round(T[k + 2]), g = T[k + 3], som = M[k + 2], depth = T[k] - T[k + 1], p = per[fid - 1], use = USES[this.fields[fid - 1].use];
      p.n++; p.som += som; p.grow += g;
      const Y = Math.min(1.35, Math.max(0.45, 0.5 + 0.8 * som + 0.15 * Math.min(1, depth)));
      const forage = Math.max(0, 0.25 + g * (0.6 + 0.8 * som));
      if (cover === CV.CROP) { p.rev += 1300 * Y * ha; p.exp += 800 * ha; }
      else if (cover === CV.COVERCROP) { p.rev += 1250 * Y * ha; p.exp += 520 * ha; }
      else if (cover === CV.PASTURE || cover === CV.PRAIRIE) { p.rev += use.rev * forage * ha; p.exp += use.exp * ha; }
      else if (cover === CV.TREE) { p.rev += 45 * ha; p.exp += 5 * ha; }
    }
    let net = 0;
    per.forEach((p) => { p.net = (p.rev - p.exp) / 4; p.somMean = p.n ? p.som / p.n : 0; p.growMean = p.n ? p.grow / p.n : 0; net += p.net; });
    return { per, net };
  };

  G.seasonParams = function (passing, next) {
    const tgt1 = new Array(32).fill(0.45), tgt2 = new Array(32).fill(0.7);
    this.fields.forEach(f => {
      const u = USES[f.use];
      tgt1[f.id] = u.target == null ? 0.45 : u.target;
      tgt2[f.id] = f.use === 'pasture_cont' ? 0.5 : f.use === 'wild' ? 0.9 : (u.target == null ? 0.9 : Math.max(u.target, 0.6));
    });
    return { grow: C.seasons[passing].grow, cropTill: C.seasons[next].cropTill, cropCover: C.seasons[next].cropCover, tgt1, tgt2 };
  };

  /** Close the season: collect the farm's income, let things grow, move to the next season. Returns what happened. */
  G.advanceSeason = function () {
    const passing = this.season, i = SEASONS.indexOf(passing), next = SEASONS[(i + 1) % 4];
    const eco = this.computeEconomy(), fixed = 8000;
    const net = eco.net - fixed;
    this.cash += net; this.ledger.push({ y: this.year, s: passing, amount: Math.round(net), text: 'Farm income, after costs and bills', farm: true });
    this.sim.dryOut(C.seasons[next].moist, 0.4);
    this.sim.advanceSeason(this.seasonParams(passing, next));
    this.groundwater *= 0.55;
    if (next === 'summer') this.year++;
    this.season = next; this.baseMoist = C.seasons[next].moist;
    this.analysis = this.analyze(this.sim.readTerrain());
    this.cbs.cash && this.cbs.cash(this.cash);
    this.cbs.seasonChanged && this.cbs.seasonChanged(this.season, this.year);
    return { passing, next, net, eco };
  };

  G.resetMap = function () {
    this.sim.reset(); this.fields = this.world.meta.fields.map(f => Object.assign({}, f));
    this.cash = C.money.start; this.ledger = []; this.groundwater = 9000; this.year = 1; this.season = 'summer'; this.baseMoist = C.seasons.summer.moist;
    this.sim.dryOut(this.baseMoist, 0); this.lastStorm = null; this.analysis = null;
    this.cbs.cash && this.cbs.cash(this.cash); this.cbs.fieldsChanged && this.cbs.fieldsChanged(); this.cbs.changed && this.cbs.changed();
  };

  /** Dry-season creek flow index, in litres per second. */
  G.baseflow = function () { return this.groundwater * 1.5e-3; };

  // ---------------------------------------------------------------- hints (gentle, never blocking)
  G.computeHints = function () {
    const an = this.analysis || this.analyze(this.sim.readTerrain()), ls = this.lastStorm, out = [];
    this.analysis = an;
    const planting = this.canUse('plant');
    const ft = (m) => (m * FT).toFixed(1);
    const g = an.gullies.slice().sort((a, b) => b.mean - a.mean)[0];
    if (g && g.mean > 0.9 && g.bareShare > 0.3) out.push({
      id: 'gully:' + g.id, x: g.x, y: g.y, r: 90, tool: 'dam',
      text: g.name + ' has cut a gully about ' + ft(g.mean) + ' feet deep and the banks are bare. Fast water digs it deeper every storm. A check dam slows the water so it drops its soil and the bed builds back up' + (planting ? ', and willow stakes knit the banks.' : '.')
    });
    if (an.main.mean > 0.9 && an.main.bareShare > 0.3) out.push({
      id: 'main', x: an.main.x, y: an.main.y, r: 140, tool: 'dam',
      text: C.creekName + '’s banks are about ' + ft(an.main.mean) + ' feet tall and mostly bare. With banks that tall, an ordinary storm can’t spill onto the land beside the creek, so all its force stays in the channel and cuts deeper. Raising the bed (check dams) or digging the banks back lets the water spread out.'
    });
    if (ls) {
      const worst = ls.fields.map((f, i) => Object.assign({ fld: this.fields[i] }, f)).filter(f => f.fld.kind === 'field').sort((a, b) => b.lostPerHa - a.lostPerHa)[0];
      if (worst && worst.lostPerHa > 6) {
        const till = worst.fld.use === 'till', cont = worst.fld.use === 'pasture_cont';
        out.push({
          id: 'loss:' + worst.fld.id, x: worst.fld.cx, y: worst.fld.cy, r: 120, tool: 'fields',
          text: worst.fld.name + ' lost about ' + Math.round(worst.lostPerHa * 1.3) + ' tons of soil per hectare in that storm. ' +
            (till ? 'Plowed ground sits bare. No-till with a cover crop keeps roots and residue on it all year.' : cont ? 'The grass is thin from continuous grazing. Rotational grazing lets it recover.' : 'Try a swale along a contour above it, or deeper-rooted cover.')
        });
      }
      if (ls.soakShare < 0.35) out.push({
        id: 'soak', x: C.mapW / 2, y: C.mapH / 2, r: 160, tool: 'swale',
        text: 'Only ' + Math.round(ls.soakShare * 100) + '% of the rain soaked in. The rest ran off. Water that soaks in is water your soil keeps. Swales on the contour and living cover slow it down so it can.'
      });
    }
    this.fields.filter(f => f.use === 'pasture_cont' && f.kind === 'field').slice(0, 1).forEach(f => out.push({
      id: 'graze', x: f.cx, y: f.cy, r: 100, tool: 'fields',
      text: f.name + ' is grazed continuously, so the grass never rests and the soil gets thinner and harder. Cattle that rotate through smaller paddocks let it recover. It earns less at first and more later.'
    }));
    out.push({
      id: 'lines', x: C.mapW / 2, y: C.mapH / 2, r: 140, tool: 'swale',
      text: 'The brown lines are contour lines: every point on a line is the same height. Lines close together mean steep ground. Water runs straight downhill, across the lines. A swale dug along a line holds water level so it can soak in.'
    });
    return out.filter(h => !this.hintsShown[h.id] || this.hintsShown[h.id] < 2);
  };

  // ---------------------------------------------------------------- the loop
  G.frame = function (ts) {
    const dt = Math.min((ts - this.last) / 1000, 0.1); this.last = ts; this.time = ts / 1000;
    this.ema = this.ema * 0.9 + dt * 1000 * 0.1;
    const target = this.turbo ? 50 : 26;
    if (this.ema > target * 1.25) this.spf = Math.max(1, this.spf * 0.88);
    else if (this.ema < target * 0.85) this.spf = Math.min(this.turbo ? 160 : 70, this.spf * 1.08 + 0.2);
    try {
      if (this.ready) {
        this.applyBrush(dt);
        if (this.storm) this.stepStorm();
        this.updateHover();
        this.draw();
      }
    } catch (err) { console.error(err); this.cbs.error && this.cbs.error(err); return; }
    requestAnimationFrame((t) => this.frame(t));
  };

  /** For the swale tool: light up the contour under the cursor before you start. */
  G.updateHover = function () {
    if (this.tool === 'swale' && !this.stroke && this.hover) {
      const now = performance.now(); if (this._hvT && now - this._hvT < 150) return; this._hvT = now;
      const w = this.toWorld(this.hover.x, this.hover.y);
      if (w.x >= 0 && w.y >= 0 && w.x < C.mapW && w.y < C.mapH) this.hiH = this.sim.probe(w.x, w.y).h;
    } else if (this.tool !== 'swale' && this.tool !== 'look') this.hiH = null;
  };

  G.contourInterval = function () {
    const raw = 0.8 / this.cam.scale, steps = [0.25, 0.5, 1, 2, 5, 10, 20];
    for (const s of steps) if (s >= raw) return s; return 20;
  };

  G.draw = function () {
    const d = this.cur();
    let brush = { x: 0, y: 0, r: 0, on: false };
    const bp = this.stroke ? this.stroke.pos : (this.hover && d.kind !== 'look' ? this.hover : null);
    if (bp && d.kind !== 'look') { const w = this.toWorld(bp.x, bp.y); brush = { x: w.x, y: w.y, r: Math.max(this.brushRadius(), 5 / this.cam.scale), on: true }; }
    const tints = { summer: [1, 0.86, 0.5, 0.04], fall: [0.95, 0.5, 0.2, 0.06], winter: [0.65, 0.78, 0.95, 0.08], spring: [0.6, 0.9, 0.6, 0.03] };
    const hints = this.activeHint ? [this.activeHint] : [];
    this.contourStep = this.contourInterval();
    const tint = this.storm ? [0.30, 0.34, 0.42, 0.18] : tints[this.season];
    this.renderer.draw(this.sim.views(), {
      cam: { x: this.cam.x, y: this.cam.y, scale: this.cam.scale * this.dpr }, time: this.time,
      contour: this.contourOn ? this.contourStep : 0, lens: this.lens, hiH: this.hiH, brush: { x: brush.x, y: brush.y, r: brush.r, on: brush.on },
      hints, tint
    }, this.canvas.width, this.canvas.height);
    this.cbs.scale && this.cbs.scale(this.cam.scale);
    this.cbs.labels && this.cbs.labels();
  };

  /** A picture of the whole ranch (no water), used for the before/after page. */
  G.snapshot = function (width) {
    const c = this.canvas, save = { cam: this.cam, w: c.width, h: c.height, dpr: this.dpr, cw: this.cw, ch: this.ch };
    const h = Math.round(width * C.mapH / C.mapW);
    c.width = width; c.height = h; this.cw = width; this.ch = h; this.dpr = 1;
    const sc = Math.min(width / C.mapW, h / C.mapH);
    this.renderer.draw(this.sim.views(), {
      cam: { x: C.mapW / 2, y: C.mapH / 2, scale: sc }, time: 0, contour: 5, lens: 0, hiH: null, brush: { x: 0, y: 0, r: 0, on: false }, hints: [], tint: null
    }, width, h);
    const out = document.createElement('canvas'); out.width = width; out.height = h;
    out.getContext('2d').drawImage(c, 0, 0);
    const url = out.toDataURL('image/jpeg', 0.85);
    c.width = save.w; c.height = save.h; this.cam = save.cam; this.dpr = save.dpr; this.cw = save.cw; this.ch = save.ch;
    return url;
  };

  Creek.Game = Game;
  Creek.SEASONS = SEASONS;
})();
