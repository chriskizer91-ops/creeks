/* The game itself: camera, touch/mouse, tools, fields, money, storms, measurements, hints.
   It drives the engine (sim.js) and the map drawing (render.js) and talks to the
   screen furniture (ui.js) through the small `cbs` callbacks. Feature modules listen to its events
   (game.on / game.emit) and may swap the map drawing for a 3D one (game.setViewProvider).
   Everything modules can rely on is described in docs/EXTENSION_API.md. */
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

  // The views the Look / view button cycles through. `lens` is the number the map renderer understands.
  // Lenses added by modules (game.addLens) keep the renderer on lens 0 and draw through game.extras instead.
  const BUILTIN_LENSES = [
    { id: 'map',   label: '🗺️ Map',          lens: 0, toast: 'Back to the map.' },
    { id: 'soil',  label: '🟤 Soil health',  lens: 1, toast: 'Soil health: dark = rich in organic matter, pale = tired soil. Rich soil soaks up water.' },
    { id: 'moved', label: '🔴 Soil moved',   lens: 2, toast: 'Soil moved since the start: red = washed away, blue = piled up. This is where the land is changing.' },
    { id: 'flood', label: '🔵 Flood depth',  lens: 3, toast: 'How deep the water got in the last storm. Dark blue is deepest.' }
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
    // --- for feature modules (docs/EXTENSION_API.md)
    this.settings = Creek.settings;
    this.terrainVersion = 0;           // goes up on every change to the land (even while a stroke or storm is still going)
    this.stormHistory = [];            // the last 12 storm results, newest last
    this.paused = false; this.fast = false; this.frameGate = null;
    this.weather = { rain: 0, flash: 0 };      // for visuals only: rain 0..1 (this storm's peak = 1), flash 0..1 (lightning)
    this.extras = { flow: null, trace: null, section: null, weather: this.weather };   // handed to the drawing code every frame
    this.lenses = BUILTIN_LENSES.map(l => Object.assign({}, l)); this.lensIdx = 0; this.lensId = 'map';
    this.viewProvider = null; this._vpBroken = null; this._states = {}; this._charged = 0; this._fr = 0;
  }
  const G = Game.prototype;
  Creek.mixinEvents(G);              // game.on / once / off / emit

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
    this.sim.onRestore = () => this.terrainChanged();     // sim.restore(...) announces itself as a terrain change
    this.fields = this.world.meta.fields.map(f => Object.assign({}, f));
    this.cash = C.money.start; this.ledger = []; this.groundwater = 9000; this.year = 1; this.season = 'summer'; this.baseMoist = C.seasons.summer.moist;
    this.initialAnalysis = this.analyze(this.world.T);
    this.sim.dryOut(this.baseMoist, 0);
    this.sim.clearRecord();
    this.lastStorm = null; this.analysis = null; this.baseline = null; this.stormHistory = [];
    this.weather.rain = 0; this.weather.flash = 0;
    this.terrainVersion++;                                // a brand new land: anything cached from the old one is stale
    this.cbs.progress && this.cbs.progress(null);
    this.cashChanged();
    this.cbs.fieldsChanged && this.cbs.fieldsChanged();
    this.fitCamera();
    this.ready = true;
    this.emit('ready');
  };

  G.resize = function () {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr; this.cw = r.width; this.ch = r.height;
    this.fitScale = Math.min(this.cw / C.mapW, this.ch / C.mapH) * 0.96;
    const vp = this.provider(); if (vp && vp.resize) this._guard('view provider resize', () => vp.resize());
  };
  G.fitCamera = function () { this.cam = { x: C.mapW / 2, y: C.mapH / 2, scale: this.fitScale }; };

  // ---- the view provider: a module (the 3D view) can take over drawing, picking and projecting while p.active is true
  /** The provider to use right now (set, active, and not thrown out for crashing), or null for the flat map. */
  G.provider = function () {
    const p = this.viewProvider; if (!p) return null;
    if (!p.active) { if (this._vpBroken === p) this._vpBroken = null; return null; }
    return p === this._vpBroken ? null : p;
  };
  G.setViewProvider = function (p) {
    this.viewProvider = p || null; this._vpBroken = null;
    const vp = this.provider(); if (vp && vp.resize) this._guard('view provider resize', () => vp.resize());
  };
  /** Run fn; a throw is logged (never rethrown) and gives undefined. */
  G._guard = function (what, fn) { try { return fn(); } catch (e) { console.error('[creek] ' + what + ' threw:', e); } };
  /** Offer a gesture to the provider. true = it used it. kinds: pan, pinch, drag2, orbit. */
  G._offer = function (kind, data) {
    const vp = this.provider(); if (!vp || !vp.onGesture) return false;
    return !!this._guard('view provider gesture', () => vp.onGesture(kind, data));
  };

  G.focusOn = function (x, y, scale) {
    const vp = this.provider();
    if (vp && vp.focus && this._guard('view provider focus', () => vp.focus(x, y, scale)) !== false) return;
    this.cam.x = x; this.cam.y = y; this.cam.scale = Math.min(Math.max(scale || 3, this.fitScale * 0.8), 30);
  };
  G._toWorld2d = function (px, py) { return { x: this.cam.x + (px - this.cw / 2) / this.cam.scale, y: this.cam.y + (py - this.ch / 2) / this.cam.scale }; };
  /** Screen position (CSS px) -> {x, y} in metres. With a 3D provider active it asks the provider, which gives null when the
      pointer is not over the land. On the flat map the point can lie outside the ranch, so check game.inMap(). */
  G.toWorld = function (px, py) {
    const vp = this.provider();
    if (vp && vp.pick) { const w = this._guard('view provider pick', () => vp.pick(px, py)); return w ? { x: w.x, y: w.y } : null; }
    return this._toWorld2d(px, py);
  };
  /** World metres -> {x, y, visible} in CSS px (null if the provider cannot place it). */
  G.project = function (x, y) {
    const vp = this.provider();
    if (vp && vp.project) { const r = this._guard('view provider project', () => vp.project(x, y)); return r ? { x: r.x, y: r.y, visible: r.visible !== false } : null; }
    return { x: (x - this.cam.x) * this.cam.scale + this.cw / 2, y: (y - this.cam.y) * this.cam.scale + this.ch / 2, visible: true };
  };
  G.inMap = function (w) { return !!w && w.x >= 0 && w.y >= 0 && w.x <= C.mapW && w.y <= C.mapH; };
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
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const vp = this.provider();
      if (vp && vp.onWheel && this._guard('view provider wheel', () => vp.onWheel(e, px, py))) return;     // the 3D view used it
      const before = this._toWorld2d(px, py);
      this.cam.scale *= Math.exp(-e.deltaY * 0.0015); this.clampCam();
      const after = this._toWorld2d(px, py); this.cam.x += before.x - after.x; this.cam.y += before.y - after.y; this.clampCam();
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
    const btn = e.pointerType === 'mouse' ? e.button : 0, panBtn = btn === 1 || btn === 2;
    // a middle-button drag is offered to a 3D view as "pan", a right-button drag as "orbit"; on the flat map both pan
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, pan: panBtn, kind: btn === 2 ? 'orbit' : 'pan', t: performance.now() });
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
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const g0 = this.gesture;
      if (g0) {
        // two fingers: offer a 3D view the pinch (distance ratio) and the two-finger drag (centre movement, twist) first
        let rot = ang - g0.ang; if (rot > Math.PI) rot -= 2 * Math.PI; else if (rot < -Math.PI) rot += 2 * Math.PI;
        const factor = dist / Math.max(g0.dist, 1);
        const usedPinch = this._offer('pinch', { factor, dist, cx, cy });
        const usedDrag = this._offer('drag2', { dx: cx - g0.cx, dy: cy - g0.cy, rot, cx, cy });
        if (!usedPinch && !usedDrag) {                         // the flat map: zoom and pan together, so the spot under your fingers stays put
          const before = this._toWorld2d(g0.cx, g0.cy);
          this.cam.scale *= factor; this.clampCam();
          const after = this._toWorld2d(cx, cy); this.cam.x += before.x - after.x; this.cam.y += before.y - after.y; this.clampCam();
        } else {
          if (!usedPinch) { const before = this._toWorld2d(cx, cy); this.cam.scale *= factor; this.clampCam(); const after = this._toWorld2d(cx, cy); this.cam.x += before.x - after.x; this.cam.y += before.y - after.y; this.clampCam(); }
          if (!usedDrag) { this.cam.x -= (cx - g0.cx) / this.cam.scale; this.cam.y -= (cy - g0.cy) / this.cam.scale; this.clampCam(); }
        }
      }
      this.gesture = { cx, cy, dist, ang }; return;
    }
    if (ptr.pan) {
      if (!this._offer(ptr.kind, { dx: p.x - px, dy: p.y - py, x: p.x, y: p.y })) { this.cam.x -= (p.x - px) / this.cam.scale; this.cam.y -= (p.y - py) / this.cam.scale; this.clampCam(); }
      return;
    }
    const s = this.stroke;
    if (s) {
      s.pos = p; s.moved = Math.max(s.moved, Math.hypot(p.x - ptr.sx, p.y - ptr.sy));
      if (this.tool === 'look') this.doLook(p);
      this.trackPath(s, p);
      if (s.custom) this.callCustom('move', s.def, this.worldOrNull(p), p);
    }
  };
  G.onUp = function (e) {
    const ptr = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.gesture = null;
    if (e.pointerType !== 'mouse') this.hover = null;
    if (!ptr || ptr.pan) return;
    if (this.stroke && this.pointers.size === 0) {
      const s = this.stroke; this.stroke = null; this.hiH = null;
      const d = this.cur(), cancelled = e.type === 'pointercancel', p = this._pos(e);
      if (s.custom) {
        this.trackPath(s, p, true);
        if (cancelled) this.callCustom('cancel', s.def); else this.callCustom('up', s.def, this.worldOrNull(p), p, { moved: s.moved });
      } else {
        if (!cancelled && d.kind === 'stamp' && s.moved < 14) this.doStamp(p);
        else if (s.cost > 0) this.charge(s.cost, d.label || 'Earthwork');
        if (d.kind === 'look') this.cbs.probe && this.cbs.probe(null);
        if (d.kind === 'paint') this.terrainChanged();
        this.trackPath(s, p, true);
        this.cbs.changed && this.cbs.changed();
      }
      this.emit('strokeEnd', this.strokeInfo(s, cancelled));
    }
  };

  /** Point on the land under a screen position, or null when it is off the map (or off the 3D land). */
  G.worldOrNull = function (p) { const w = this.toWorld(p.x, p.y); return this.inMap(w) ? w : null; };
  /** Remember the finger's path in metres, about one point every 2 m, never more than 400 points. */
  G.trackPath = function (s, p, force) {
    const w = this.toWorld(p.x, p.y); if (!w) return;
    const path = s.path, last = path[path.length - 1];
    if (last && Math.hypot(w.x - last.x, w.y - last.y) < (force ? 0.01 : s.gap)) return;
    path.push({ x: w.x, y: w.y });
    if (path.length > 400) { s.path = path.filter((_, i) => i % 2 === 0); s.gap *= 2; }    // too long: keep every other point
  };
  G.strokeInfo = function (s, cancelled) {
    return { tool: s.tool, opt: s.opt, path: s.path, cost: this._charged - s.chargeMark, cancelled: !!cancelled };
  };
  /** Call one of a custom tool's functions (down / move / up / cancel); a throw is logged, never rethrown. */
  G.callCustom = function (fn, def, ...args) {
    const c = def && def.custom; if (!c || typeof c[fn] !== 'function') return;
    this._guard('tool "' + def.id + '" ' + fn, () => c[fn](this, ...args));
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
    const base = () => ({ pos: p, moved: 0, tool: this.tool, opt: d.optId || null, path: [], gap: 2, chargeMark: this._charged });
    if (d.kind === 'look') { this.stroke = base(); this.trackPath(this.stroke, p); this.emit('strokeStart', { tool: this.tool, opt: d.optId || null }); this.doLook(p); return; }
    if (!this.canUse(this.tool)) { this.cbs.toast && this.cbs.toast(this.whyLocked(this.tool)); return; }
    if (d.kind === 'custom') {      // a module's own tool: it gets one finger only, and takes its own undo snapshot if it edits the land
      const s = this.stroke = Object.assign(base(), { custom: true, def: d, started: performance.now() });
      this.trackPath(s, p); this.emit('strokeStart', { tool: this.tool, opt: d.optId || null });
      this.callCustom('down', d, this.worldOrNull(p), p);
      return;
    }
    if (d.kind === 'paint' && this.cam.scale < 0.8 && !this.provider()) { this.cbs.toast && this.cbs.toast('Zoom in a little to work here (pinch or scroll).'); return; }
    this.stroke = Object.assign(base(), { started: performance.now(), saved: this.snapshotForUndo(), cost: 0, last: null, href: null });
    this.hover = p;
    if (this.tool === 'swale') { const w = this.toWorld(p.x, p.y); if (w) this.stroke.href = this.sim.probe(w.x, w.y).h; }
    this.trackPath(this.stroke, p); this.emit('strokeStart', { tool: this.tool, opt: d.optId || null });
  };
  G.cancelStroke = function (undoIt) {
    const s = this.stroke; if (!s) return;
    const d = this.cur();
    this.stroke = null; this.hiH = null;
    if (s.custom) this.callCustom('cancel', s.def);
    else if (undoIt && performance.now() - s.started < 400 && d.kind !== 'stamp') this.undo();
    else if (d.kind === 'paint') this.terrainChanged();
    this.emit('strokeEnd', this.strokeInfo(s, true));
  };
  /** Take the one-step undo snapshot. A custom tool that edits the land must call this first. */
  G.snapshotForUndo = function () {
    this.sim.saveUndo(); this.undoState = { fields: this.fields.map(f => f.use), cash: this.cash, ledger: this.ledger.length }; return true;
  };
  G.undo = function () {
    if (this.sim.undo()) {
      const u = this.undoState;
      if (u) {
        const changed = []; this.fields.forEach((f, i) => { if (f.use !== u.fields[i]) changed.push(f); f.use = u.fields[i]; });
        this.cash = u.cash; this.ledger.length = u.ledger; this.cashChanged(); this.cbs.fieldsChanged && this.cbs.fieldsChanged();
        changed.forEach(f => this.emit('fieldUse', f, f.use));
      }
      this.cbs.changed && this.cbs.changed();
      this.terrainChanged();
      return true;
    }
    return false;
  };

  /** The land changed and has settled (a stroke ended, undo, season, storm over...): bump the version and tell listeners. */
  G.terrainChanged = function () { this.terrainVersion++; this.emit('terrain'); };
  /** The land is changing right now (mid-stroke, mid-storm): bump the version quietly. */
  G.bumpTerrain = function () { this.terrainVersion++; };
  /** Called whenever cash changes. */
  G.cashChanged = function () { this.cbs.cash && this.cbs.cash(this.cash); this.emit('cash', this.cash); };

  G.doLook = function (p) {
    const now = performance.now(); if (this._lookT && now - this._lookT < 90) return; this._lookT = now;
    const w = this.toWorld(p.x, p.y);
    if (!this.inMap(w)) return;
    const info = this.sim.probe(w.x, w.y); this.hiH = info.h;
    this.cbs.probe && this.cbs.probe({ info, x: p.x, y: p.y });
    this.emit('probe', Object.assign({ x: w.x, y: w.y, px: p.x, py: p.y }, info));
  };

  G.charge = function (amount, text) {
    amount = Math.round(amount); if (!amount) return;
    this.cash -= amount; this._charged += amount; this.ledger.push({ y: this.year, s: this.season, amount: -amount, text });
    this.cashChanged();
  };

  G.doStamp = function (p) {
    const d = this.cur(), w = this.toWorld(p.x, p.y);
    if (!this.canUse(this.tool)) return;
    if (!this.inMap(w)) return;
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
      this.terrainChanged();
      return;
    }
    // trees
    this.sim.applyTool(d.gl, w.x, w.y, r, 0, 0, 0);
    this.charge(C.money.treePerStamp, 'Trees');
    this.terrainChanged();
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
    this.emit('fieldUse', f, useId);
    this.terrainChanged();
  };

  G.applyBrush = function (dt) {
    const s = this.stroke, d = this.cur(); if (!s || d.kind !== 'paint' || !this.canUse(this.tool)) return;
    const w = this.toWorld(s.pos.x, s.pos.y); if (!w) return;
    const r = this.brushRadius(), M = C.money;
    if (this.tool === 'swale') this.hiH = s.href;
    const step = s.last ? Math.hypot(w.x - s.last.x, w.y - s.last.y) : 2 * r;
    s.last = w;
    this.bumpTerrain();
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
  /** Tools a story step has not opened are locked, except tools that never change the land and say so (`readonly: true`). */
  G.canUse = function (id) {
    if (!this.allowed || this.allowed.indexOf(id) >= 0) return true;
    const t = Creek.TOOLS.find(x => x.id === id); return !!(t && t.readonly);
  };
  G.whyLocked = function (id) { return id === 'plant' ? 'Planting happens in winter.' : 'Not available right now.'; };
  G.setTool = function (id, opt) {
    if (!this.canUse(id)) { this.cbs.toast && this.cbs.toast(this.whyLocked(id)); return false; }
    if (this.stroke && id !== this.tool) this.cancelStroke(false);      // switching tools mid-stroke ends the stroke
    this.tool = id;
    if (opt != null) this.optIdx[id] = opt;
    this.sizeIdx = Math.min(this.sizeIdx, (this.cur().sizes || [0]).length - 1);
    this.cbs.toolChanged && this.cbs.toolChanged(id);
    this.emit('toolChanged', id);
    return true;
  };

  // ---------------------------------------------------------------- views (lenses)
  /** Add a view to the view button's cycle: {id, label, toast, activate(game), deactivate(game)}. Module lenses keep the
      map renderer on lens 0 and draw their own thing through game.extras. Returns the lens (or the existing one with that id). */
  G.addLens = function (def) {
    if (!def || typeof def.id !== 'string' || !def.id) { console.error('[creek] addLens needs {id, label}'); return null; }
    const old = this.lenses.find(l => l.id === def.id); if (old) { console.warn('[creek] lens "' + def.id + '" already exists'); return old; }
    const l = { id: def.id, label: def.label || def.id, toast: def.toast || '', lens: 0, activate: def.activate, deactivate: def.deactivate };
    this.lenses.push(l); return l;
  };
  /** Switch to a lens by id or by position in game.lenses. Emits "lens" (id). */
  G.setLens = function (which) {
    const i = typeof which === 'number' ? which : this.lenses.findIndex(l => l.id === which);
    if (i < 0 || i >= this.lenses.length) return false;
    const old = this.lenses[this.lensIdx], nu = this.lenses[i];
    if (old && old.deactivate) this._guard('lens "' + old.id + '" deactivate', () => old.deactivate(this));
    this.lensIdx = i; this.lensId = nu.id; this.lens = nu.lens || 0;
    if (nu.activate) this._guard('lens "' + nu.id + '" activate', () => nu.activate(this));
    this.emit('lens', nu.id);
    return true;
  };
  G.nextLens = function () { return this.setLens((this.lensIdx + 1) % this.lenses.length); };

  // ---------------------------------------------------------------- module state (for the save system)
  /** Register something to be saved with the ranch: handler = {save() -> json, load(json)}. */
  G.registerState = function (id, handler) {
    if (!id || !handler || typeof handler.save !== 'function' || typeof handler.load !== 'function') { console.warn('[creek] registerState needs (id, {save, load})'); return false; }
    this._states[id] = handler; return true;
  };
  /** {id: json} for everything registered with registerState. */
  G.collectState = function () { const o = {}; Object.keys(this._states).forEach(id => { const v = this._guard('state "' + id + '" save', () => this._states[id].save()); if (v !== undefined) o[id] = v; }); return o; };
  /** Hand saved json back to the handlers that registered for those ids. */
  G.applyState = function (o) { Object.keys(o || {}).forEach(id => { const h = this._states[id]; if (h) this._guard('state "' + id + '" load', () => h.load(o[id])); }); };

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
      before: this.sim.readTerrain(), peakOut: 0, volOut: 0, mudVol: 0, rainVol: 0, Qnow: 0,
      rainNow: 0, rainPeak: this.rainAt(size, C.stormBurst * 0.5),                 // the weather visuals compare the rain now with the storm's peak
      rec: { t: [0], rain: [0], Qin: [0], Qout: [0], mudQ: [0] }, recEvery: (C.stormBurst + C.stormTail) / 380, nextRec: 0, last: null   // the graph record, thinned as it goes
    };
    this.turbo = !!opts.turbo; this.sim.setRain(0);
    this.bumpTerrain();
    this.cbs.stormStart && this.cbs.stormStart(this.storm);
    this.emit('stormStart', this.storm);
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
    // what modules hear: rain in m/s on the map, water arriving from upstream and leaving the ranch in m³/s
    const sample = { t: st.t, dt: simDt, rain, Qin: st.Q + base, Qout: out.q, mudQ: out.mudQ, size: st.size };
    st.rainNow = rain; st.last = sample;
    if (st.t >= st.nextRec) { this.recordSample(st, sample); st.nextRec = st.t + st.recEvery; }
    this.bumpTerrain();
    this.emit('stormStep', sample);
    if (st.t >= end) this.finishStorm();
  };
  G.recordSample = function (st, s) {
    const r = st.rec; r.t.push(s.t); r.rain.push(s.rain); r.Qin.push(s.Qin); r.Qout.push(s.Qout); r.mudQ.push(s.mudQ);
  };
  /** Even thinning that keeps the first and last points: at most `max` points out of each array. */
  function thin(rec, max) {
    const n = rec.t.length; if (n <= max) return rec;
    const idx = []; for (let i = 0; i < max; i++) idx.push(Math.round(i * (n - 1) / (max - 1)));
    const out = {}; Object.keys(rec).forEach(k => { out[k] = idx.map(i => rec[k][i]); }); return out;
  }

  G.finishStorm = function () {
    const st = this.storm; this.storm = null; this.turbo = false; this.sim.setRain(0); this.sim.setSources([]);
    this.weather.rain = 0; this.weather.flash = 0;
    if (st.last && st.rec.t[st.rec.t.length - 1] < st.last.t) this.recordSample(st, st.last);       // always keep the very last point
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
      an, somMean: this.meanSom(M), groundwater: this.groundwater,
      series: thin(st.rec, 400)      // {t, rain, Qin, Qout, mudQ}: at most 400 points each, for graphs
    };
    this.lastStorm = res; this.analysis = an;
    this.stormHistory.push(res); if (this.stormHistory.length > 12) this.stormHistory.shift();
    this.terrainChanged();
    this.emit('stormEnd', res);
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
    this.cashChanged();
    this.cbs.seasonChanged && this.cbs.seasonChanged(this.season, this.year);
    this.terrainChanged();
    this.emit('season', { season: this.season, year: this.year, net, passing });
    return { passing, next, net, eco };
  };

  G.resetMap = function () {
    this.sim.reset(); this.fields = this.world.meta.fields.map(f => Object.assign({}, f));
    this.cash = C.money.start; this.ledger = []; this.groundwater = 9000; this.year = 1; this.season = 'summer'; this.baseMoist = C.seasons.summer.moist;
    this.sim.dryOut(this.baseMoist, 0); this.lastStorm = null; this.analysis = null; this.baseline = null; this.stormHistory = [];
    this.weather.rain = 0; this.weather.flash = 0;
    this.cashChanged(); this.cbs.fieldsChanged && this.cbs.fieldsChanged(); this.cbs.changed && this.cbs.changed();
    this.emit('reset');
    this.terrainChanged();
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
    // fast-forward gets the same bigger budget as a turbo storm, and a little more
    const hurry = this.turbo || this.fast, target = hurry ? 50 : 26, cap = this.fast ? 220 : this.turbo ? 160 : 70;
    if (this.ema > target * 1.25) this.spf = Math.max(1, this.spf * 0.88);
    else if (this.ema < target * 0.85) this.spf = Math.min(cap, this.spf * 1.08 + 0.2);
    try {
      if (this.ready) {
        this.applyBrush(dt);
        if (this.storm && !this.paused) this.stepStorm();
        this.updateWeather(dt);
        this.updateHover();
        this.emit('frame', dt);
        let skip = false;
        if (this.fast && this.storm && ++this._fr % 3 !== 0) skip = true;                        // fast-forward: draw every 3rd frame
        if (!skip && this.frameGate && this._guard('frameGate', () => this.frameGate(this, dt)) === false) skip = true;
        if (!skip) this.draw();
      }
    } catch (err) { this.reportError(err); }       // a crash in one frame must not stop the game
    requestAnimationFrame((t) => this.frame(t));
  };
  /** Show an error once in a while instead of every frame. */
  G.reportError = function (err) {
    const now = performance.now(), msg = String(err && err.message || err);
    if (this._errMsg === msg && now - this._errT < 3000) return;
    this._errMsg = msg; this._errT = now;
    console.error(err);
    if (!this._errCard || now - this._errCard > 10000) { this._errCard = now; this.cbs.error && this.cbs.error(err); }
  };

  /** Rain 0..1 against this storm's peak, and lightning flashes, for the drawing code (game.weather = game.extras.weather).
      Smoothed in real time. Between storms both are 0. */
  G.updateWeather = function (dt) {
    const w = this.weather, st = this.storm;
    if (!st) { w.rain = 0; w.flash = 0; return; }
    w.flash = Math.max(0, w.flash - dt / 0.4);                                           // a flash fades out in about 0.4 s
    if (this.paused) return;
    const target = st.rainPeak > 0 ? Math.min(1, st.rainNow / st.rainPeak) : 0;
    w.rain += (target - w.rain) * (1 - Math.exp(-dt / 0.5));
    const rate = w.rain > 0.6 ? 0.5 : w.rain > 0.2 ? 0.12 : 0;                           // flashes per second: more in the heaviest rain
    if (rate && Math.random() < 1 - Math.exp(-rate * dt)) w.flash = 0.7 + 0.3 * Math.random();
  };

  /** For the swale tool: light up the contour under the cursor before you start. */
  G.updateHover = function () {
    if (this.tool === 'swale' && !this.stroke && this.hover) {
      const now = performance.now(); if (this._hvT && now - this._hvT < 150) return; this._hvT = now;
      const w = this.toWorld(this.hover.x, this.hover.y);
      if (this.inMap(w) && w.x < C.mapW && w.y < C.mapH) this.hiH = this.sim.probe(w.x, w.y).h;
    } else if (this.tool !== 'swale' && this.tool !== 'look') this.hiH = null;
  };

  G.contourInterval = function () {
    const raw = 0.8 / this.cam.scale, steps = [0.25, 0.5, 1, 2, 5, 10, 20];
    for (const s of steps) if (s >= raw) return s; return 20;
  };

  G.draw = function () {
    const d = this.cur(), vp = this.provider();
    let brush = { x: 0, y: 0, r: 0, on: false };
    const bp = this.stroke ? this.stroke.pos : (this.hover && d.kind !== 'look' ? this.hover : null);
    if (bp && d.kind !== 'look' && d.kind !== 'custom') { const w = this.toWorld(bp.x, bp.y); if (w) brush = { x: w.x, y: w.y, r: Math.max(this.brushRadius(), 5 / this.cam.scale), on: true }; }
    const tints = { summer: [1, 0.86, 0.5, 0.04], fall: [0.95, 0.5, 0.2, 0.06], winter: [0.65, 0.78, 0.95, 0.08], spring: [0.6, 0.9, 0.6, 0.03] };
    const hints = this.activeHint ? [this.activeHint] : [];
    this.contourStep = this.contourInterval();
    const tint = this.storm ? [0.30, 0.34, 0.42, 0.18] : tints[this.season];
    const state = {
      cam: { x: this.cam.x, y: this.cam.y, scale: this.cam.scale * this.dpr }, time: this.time,
      contour: this.contourOn ? this.contourStep : 0, lens: this.lens, hiH: this.hiH, brush: { x: brush.x, y: brush.y, r: brush.r, on: brush.on },
      hints, tint, extras: this.extras
    };
    if (vp) {
      state.width = this.canvas.width; state.height = this.canvas.height; state.views = this.sim.views();
      try { vp.draw(this, state); }
      catch (err) {          // a crashing 3D view is switched off, so the flat map comes back instead of a frozen screen
        console.error('[creek] the view provider crashed and was switched off:', err);
        this._vpBroken = vp; try { vp.active = false; } catch (e2) { /* a read-only flag: _vpBroken is enough */ }
        this.cbs.toast && this.cbs.toast('The 3D view had a problem, so you are back on the map.');
      }
      this.resetGLState();
    } else this.renderer.draw(this.sim.views(), state, this.canvas.width, this.canvas.height);
    this.cbs.scale && this.cbs.scale(vp ? 0 : this.cam.scale);      // 0 = no scale bar (it means nothing in 3D)
    this.cbs.labels && this.cbs.labels();
  };
  /** Put the GL switches back the way the engine and the map renderer expect, in case a provider changed them. */
  G.resetGLState = function () {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true); gl.colorMask(true, true, true, true); gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
  };

  /** A picture of the whole ranch (no water), used for the before/after page. */
  G.snapshot = function (width) {
    const c = this.canvas, save = { cam: this.cam, w: c.width, h: c.height, dpr: this.dpr, cw: this.cw, ch: this.ch };
    const h = Math.round(width * C.mapH / C.mapW);
    c.width = width; c.height = h; this.cw = width; this.ch = h; this.dpr = 1;
    const sc = Math.min(width / C.mapW, h / C.mapH);
    this.renderer.draw(this.sim.views(), {
      cam: { x: C.mapW / 2, y: C.mapH / 2, scale: sc }, time: 0, contour: 5, lens: 0, hiH: null, brush: { x: 0, y: 0, r: 0, on: false }, hints: [], tint: null,
      extras: { flow: null, trace: null, section: null, weather: { rain: 0, flash: 0 } }
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
