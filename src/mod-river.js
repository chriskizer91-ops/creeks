/* River scale: the whole valley, decades at a time.

   The ranch map shows one storm on 500 acres. This view zooms out to the whole valley the creek runs through (about 6,000 acres
   of it drains to the bottom edge) and lets years go by: floods come, banks wear back, bends slide downstream and sometimes pinch
   off, mud builds new floodplain, cut-down stretches heal or get worse. The numbers come from src/river-core.js (no drawing in there).
   This file is the screen for it: a topographic map, lenses, an inspector, tools, and the two-way link with the ranch map.

   Camera rule is the same as the ranch map: one finger or the mouse is the tool; two fingers, the wheel, or a right-drag move the map.
   With the Look tool a one-finger drag also moves the map, because there is nothing else to do with it. */
(function () {
  'use strict';
  const R = Creek.River;
  if (!R || !R.Model) { console.warn('[creek] river scale needs src/river-core.js'); return; }
  const C = Creek.CONFIG, GEO = R.GEO;
  const FT = 3.281, ACRE = 247.105, CFS = 35.315;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const fmt = (v, d) => (+v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: d == null ? 0 : d });
  const money = (v) => (v < 0 ? '−$' : '$') + fmt(Math.abs(v));
  const ftS = (m, d) => fmt(m * FT, d == null ? 1 : d) + ' ft';
  const rgb = (c) => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const ramp = (stops, t) => {
    t = clamp(t, 0, 1) * (stops.length - 1); const i = Math.min(Math.floor(t), stops.length - 2);
    return mix(stops[i], stops[i + 1], t - i);
  };

  // ------------------------------------------------------------------------------------------------
  // What the lenses show. color(node, model) gives [r,g,b].
  const STAGE_COL = { I: [98, 163, 74], II: [226, 124, 52], III: [196, 56, 46], IV: [236, 184, 52], V: [38, 142, 158] };
  const TYPE_COL = { A: [150, 110, 80], B: [214, 168, 40], C: [92, 155, 78], E: [38, 142, 158], F: [196, 56, 46], G: [120, 40, 38] };
  const TYPE_NAME = { A: 'A · steep and rocky', B: 'B · moderate', C: 'C · winding, wide floodplain', E: 'E · narrow, deep, windy', F: 'F · cut down and wide', G: 'G · gully' };
  const STAGE_NAME = { I: 'I · steady', II: 'II · cutting down', III: 'III · banks falling in', IV: 'IV · refilling', V: 'V · healed' };
  const LENSES = [
    { id: 'stage', label: '🩺 Health', toast: 'Colours show how each stretch of creek is doing. Green is steady, orange is cutting down, red is banks falling in, yellow is refilling, blue-green is healed.',
      color: (n) => STAGE_COL[n.stage] || [120, 120, 120], legend: Object.keys(STAGE_COL).map((k) => [STAGE_COL[k], STAGE_NAME[k]]) },
    { id: 'change', label: '📉 Bed up or down', toast: 'How far the creek bed has moved since you started. Red: it has dug down. Blue: it has filled up.',
      color: (n, m) => { const i0 = m.initial.get(n.id), d = i0 ? n.bed - i0.bed : 0; return d < 0 ? mix([235, 235, 225], [200, 40, 40], clamp(-d / 1.5, 0, 1)) : mix([235, 235, 225], [40, 100, 200], clamp(d / 1.5, 0, 1)); },
      legend: [[[200, 40, 40], 'dug down 5 ft'], [[235, 235, 225], 'same'], [[40, 100, 200], 'filled up 5 ft']] },
    { id: 'banks', label: '🧱 Bank height', toast: 'How tall the creek banks are. Tall banks keep a flood trapped in the channel, where it digs.',
      color: (n) => ramp([[240, 230, 150], [230, 160, 60], [190, 60, 40], [90, 20, 40]], (n.fp - n.bed - 0.3) / 3.5),
      legend: [[[240, 230, 150], 'low (1 ft)'], [[230, 160, 60], 'middle'], [[190, 60, 40], 'tall (8 ft)'], [[90, 20, 40], 'very tall']] },
    { id: 'power', label: '💪 Flood force', toast: 'How hard a 10-year flood pushes on the creek bed. Strong force carries gravel away; weak force lets it settle.',
      color: (n, m) => ramp([[210, 225, 235], [110, 160, 210], [150, 80, 170], [220, 60, 60]], (n.tau10 != null ? n.tau10 : 0) / 160),
      legend: [[[210, 225, 235], 'gentle'], [[110, 160, 210], 'moderate'], [[150, 80, 170], 'strong'], [[220, 60, 60], 'very strong']] },
    { id: 'plants', label: '🌿 Plants', toast: 'How well streamside plants hold the banks. Roots make soil much harder to wash away.',
      color: (n) => ramp([[200, 170, 120], [180, 190, 90], [60, 140, 60]], n.veg),
      legend: [[[200, 170, 120], 'bare'], [[180, 190, 90], 'some'], [[60, 140, 60], 'thick']] },
    { id: 'type', label: '🧬 Stream type', toast: 'Streams come in families. Winding C and E streams with room to flood are the healthy valley kind. F and G are cut down.',
      color: (n) => TYPE_COL[n.type] || [120, 120, 120], legend: Object.keys(TYPE_COL).map((k) => [TYPE_COL[k], TYPE_NAME[k]]) },
    { id: 'mud', label: '🟤 Gravel moving', toast: 'How much gravel passed through each stretch in the last year. Bright means a lot.',
      color: (n) => ramp([[225, 220, 205], [215, 170, 90], [160, 80, 40], [90, 30, 20]], Math.log10(1 + (n.acc ? n.acc.qs : 0)) / 3.4),
      legend: [[[225, 220, 205], 'little'], [[215, 170, 90], 'some'], [[160, 80, 40], 'lots'], [[90, 30, 20], 'huge']] },
    { id: 'flood', label: '🌊 Last flood', toast: 'The blue shows how wide the water spread in the biggest flood of the last year.', color: () => [70, 100, 130], legend: [[[110, 170, 220], 'flood water']] }
  ];

  // The player's tools. kind: look | point | stretch. Costs are in dollars.
  const TOOLS = [
    { id: 'look', icon: '🔍', label: 'Look', kind: 'look', help: 'Tap the creek to read it. Drag to move the map.' },
    { id: 'plant', icon: '🌿', label: 'Plant', kind: 'stretch', per: 6, span: 7, help: 'Drag along the creek to plant trees and grasses on both banks. Roots take a few years to grow.' },
    { id: 'bench', icon: '⛏️', label: 'Bench', kind: 'stretch', per: 32, span: 7, help: 'Drag along a cut-down creek to dig the banks back into a flat bench. Floods can spread out onto it.' },
    { id: 'weir', icon: '🪨', label: 'Rock weir', kind: 'point', cost: 900, help: 'Tap the creek to build a rock step. It holds the bed up and traps gravel above it.' },
    { id: 'bda', icon: '🦫', label: 'Dam analog', kind: 'point', cost: 250, help: 'Tap the creek for a beaver dam analog: posts and brush that slow water. They wear out in about ten years.' },
    { id: 'plug', icon: '🧱', label: 'Plug headcut', kind: 'point', cost: 600, help: 'Tap a steep step in the bed to lock it so it cannot cut upstream.' },
    { id: 'pond', icon: '🏞️', label: 'Silt pond', kind: 'point', cost: 3000, help: 'Tap the creek to dig a pond beside it that catches mud and gravel until it fills.' },
    { id: 'bend', icon: '〰️', label: 'New bends', kind: 'stretch', per: 30, span: 14, help: 'Drag along a long, straight stretch in a wide valley to dig new bends. The creek gets longer and gentler.' },
    { id: 'straight', icon: '📏', label: 'Straighten', kind: 'stretch', per: 12, span: 14, help: 'What if the creek were straightened? Try it and watch what happens.' },
    { id: 'remove', icon: '🗑️', label: 'Remove', kind: 'point', cost: 0, help: 'Tap a weir, dam or plug to take it out.' }
  ];

  // ------------------------------------------------------------------------------------------------
  const S = {
    open: false, built: false, model: null, valley: null, dem: null, backdrop: null, contours: null, ghost: null,
    lens: 'stage', tool: 'look', sel: null, cam: { x: GEO.W / 2, y: GEO.H / 2, scale: 0.05 }, w: 0, h: 0, dpr: 1, dirty: true,
    play: false, speed: 1, busy: false, cancel: false, journal: [], spent: 0, badges: {}, applied: null, force: null, floodYear: -9,
    settings: { bend: 'Normal', climate: 'Normal' }, pointers: new Map(), stroke: null, hover: null, toastT: 0, infoOpen: true, el: {}
  };
  let game = null, ui = null, prevGate = null, drawQueued = false;

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------------------------------------
  // The model
  function newModel() {
    S.valley = R.buildValley({ seed: 11 });
    S.model = new R.Model(S.valley, { seed: (Date.now() & 0xffff) || 7 });
    applySettings();
    S.ghost = S.valley.reaches.map((r) => r.nodes.map((n) => [n.x, n.y]));
    S.journal = []; S.spent = 0; S.sel = null; S.applied = S.model.snapshotProfile(); S.badges = {};
    S.model.nodes.forEach(markPower);
  }
  function applySettings() {
    const m = S.model; if (!m) return;
    m.p.kMig = { Slow: 1, Normal: 2.5, Fast: 5 }[S.settings.bend] || 2.5;
    m.p.climate = { Drier: 0.85, Normal: 1, Wetter: 1.2 }[S.settings.climate] || 1;
  }
  /** The 10-year flood shear at a node (for the Flood force lens). */
  function markPower(n) { try { n.tau10 = R.hydraulics(n, R.kOfT(10) * Math.pow(n.A, 0.8) * n.qf, n._S).tau; } catch (e) { n.tau10 = 0; } }

  /** What the ranch map says about the creek and the land around it. */
  function ranchInputs() {
    const o = {}, an = game.analysis, base = game.baseline, hist = game.stormHistory || [];
    if (an && an.main) o.mainBare = an.main.bareShare;
    if (an && an.gullies && an.gullies.length) o.gullyBare = an.gullies.reduce((q, g) => q + g.bareShare, 0) / an.gullies.length;
    if (base && base.peakOut > 0) {
      const last = hist.slice().reverse().find((s) => s.size === base.size);
      if (last) { o.peakCut = clamp(1 - last.peakOut / base.peakOut, 0, 0.3); if (base.soilLost > 0) o.landFactor = clamp(last.soilLost / base.soilLost, 0.2, 1.6); }
    }
    return o;
  }

  // ------------------------------------------------------------------------------------------------
  // Years go by. Each year is one trip through the model; between years the browser gets a turn, so the screen stays alive.
  function runYears(n, opts) {
    opts = opts || {};
    if (S.busy || !S.model) return Promise.resolve();
    S.busy = true; S.cancel = false; setBusy(0, n);
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (i >= n || S.cancel || !S.open) { S.busy = false; setBusy(); finishRun(); resolve(); return; }
        const m = S.model;
        const rep = m.stepYear(i === 0 && S.force ? { force: S.force } : undefined);
        S.force = null; i++;
        afterYear(rep);
        setBusy(i, n);
        S.dirty = true;
        setTimeout(step, 0);
      };
      step();
    });
  }
  function finishRun() { S.model.nodes.forEach(markPower); renderAll(); }

  function afterYear(rep) {
    const m = S.model, big = rep.events.reduce((q, e) => (e.T > q.T ? e : q), { T: 0 });
    if (big.T >= 10) { journal('A ' + (big.T >= 100 ? '100' : big.T >= 50 ? '50' : big.T >= 25 ? '25' : '10') + '-year flood came through' + (big.forced ? ' (you called it)' : '') + '. Peak flow at the ranch: ' + fmt(rep.peakRanch * CFS) + ' cubic feet a second.'); S.floodYear = m.year; }
    rep.notes.forEach((t) => { journal(t); });
    if (rep.failures.length > 10) journal('Banks fell in along ' + rep.failures.length + ' stretches this year.');
    checkBadges(rep);
  }
  function journal(text) { S.journal.push({ year: S.model.year, text }); if (S.journal.length > 80) S.journal.shift(); S.lastNote = text; showToast(text, 3600); }
  function checkBadges(rep) {
    const m = S.model, h = m.health();
    const grant = (id, text) => { if (!S.badges[id]) { S.badges[id] = m.year; journal('🏅 ' + text); } };
    if (m.oxbows.length) grant('oxbow', 'A bend was cut off and made an oxbow lake.');
    if (h.ranch > 0.85 && m.year > 3) grant('ranch', 'Your ranch stretch of the creek has healed.');
    if (h.main > 0.8 && m.year > 3) grant('valley', 'More than four fifths of the creek is steady or healed.');
    if (rep.events.some((e) => e.T >= 50) && rep.failures.length < 4) grant('flood', 'A big flood passed and almost no banks fell in.');
  }

  // ------------------------------------------------------------------------------------------------
  // Working out what is under a finger
  const w2sx = (x) => (x - S.cam.x) * S.cam.scale + S.w / 2, w2sy = (y) => (y - S.cam.y) * S.cam.scale + S.h / 2;
  const s2wx = (px) => (px - S.w / 2) / S.cam.scale + S.cam.x, s2wy = (py) => (py - S.h / 2) / S.cam.scale + S.cam.y;
  function pickNode(px, py, maxPx) {
    const m = S.model; if (!m) return null;
    const wx = s2wx(px), wy = s2wy(py), maxM = maxPx / S.cam.scale; let best = null, bd = maxM * maxM;
    for (const n of m.nodes) { const dx = n.x - wx, dy = n.y - wy, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function stretchFrom(a, b) { return S.model.between(a, b); }

  // ------------------------------------------------------------------------------------------------
  // Tools
  function toolDef(id) { return TOOLS.find((t) => t.id === id); }
  function stretchCost(t, nodes) { const L = nodes.reduce((q, n) => q + n.len, 0); return Math.round(L * t.per); }
  function charge(amount, text) {
    if (amount > 0) { game.charge(amount, text); S.spent += amount; if (game.cash < 0) showToast('Money is tight, so the bank has lent you the difference.', 3200); }
  }
  /** Do a tool at a node (point tools) or on a stretch. Returns true if something was done. */
  function useTool(t, nodes, node) {
    const m = S.model;
    if (t.kind === 'point') {
      const n = node;
      if (t.id === 'remove') { if (!n.struct) { showToast('There is nothing to remove here.'); return false; } m.removeStructure(n); showToast('Taken out.'); afterWork(); return true; }
      if (n.struct) { showToast('There is already something built here.'); return false; }
      if (n.ranch && n.reach.main && (t.id === 'pond')) { showToast('A pond on the ranch creek is a job for the ranch map.'); return false; }
      const ok = m.addStructure(n, t.id === 'weir' ? 'weir' : t.id === 'bda' ? 'bda' : t.id === 'plug' ? 'plug' : 'pond');
      if (!ok) { showToast('That cannot be built here.'); return false; }
      charge(t.cost, t.label);
      showToast({ weir: 'Rock weir built. Gravel will pile up behind it.', bda: 'Beaver dam analog built. It will slow water for about ten years.', plug: 'Headcut plugged.', pond: 'Silt pond dug.' }[t.id]);
      afterWork(); return true;
    }
    if (!nodes || nodes.length < 2) return false;
    const L = nodes.reduce((q, n) => q + n.len, 0);
    if (t.id === 'plant') { m.plant(nodes, 1); charge(stretchCost(t, nodes), 'Streamside planting'); showToast('Planted ' + fmt(L * FT) + ' ft of streamside. Roots will grow over the next few years.'); afterWork(); return true; }
    if (t.id === 'bench') {
      const cutNodes = nodes.filter((n) => R.trench(n) > R.natural(n.A).d * 1.2);
      if (!cutNodes.length) { showToast('This stretch is not cut down, so there is nothing to bench.'); return false; }
      m.lowerBanks(cutNodes); const l2 = cutNodes.reduce((q, n) => q + n.len, 0);
      charge(Math.round(l2 * t.per), 'Bench digging'); showToast('Dug a bench along ' + fmt(l2 * FT) + ' ft. Floods can spread out onto it now.'); afterWork(); return true;
    }
    if (t.id === 'bend' || t.id === 'straight') {
      if (!m.canReshape(nodes)) { showToast(nodes.length < 8 ? 'Drag along a longer stretch (at least a quarter mile).' : 'That stretch has a side stream, a structure, or part of the ranch map in it. Pick a clear one.'); return false; }
      if (t.id === 'bend') {
        const gained = m.reMeander(nodes, 1.45);
        if (gained <= 5) { showToast('The valley floor is too narrow here for bends. Try a wider part of the valley.'); return false; }
        charge(stretchCost(t, nodes), 'New bends'); showToast('Dug new bends. The creek is ' + fmt(gained * FT) + ' ft longer, so it is gentler.');
      } else {
        const lost = m.straighten(nodes); charge(stretchCost(t, nodes), 'Straightening'); showToast('Straightened: ' + fmt(lost * FT) + ' ft shorter and steeper. Watch what the creek does.');
      }
      afterWork(); return true;
    }
    return false;
  }
  function afterWork() { S.model.nodes.forEach(markPower); S.dirty = true; renderAll(); }

  // ------------------------------------------------------------------------------------------------
  // The ranch map follows what happened in the valley
  /** The height of the ground at distance d from the middle of a channel with geometry g (bed, banks, bench, floodplain). */
  function secH(g, d) {
    const Ht = Math.max(g.fp - g.bed, 0.15), hw = g.wb / 2, m = g.m;
    if (d <= hw) return g.bed;
    const Hz = g.bw > 0.05 ? clamp(g.bz - g.bed, 0, Ht - 0.05) : 0;
    let x2 = hw, base = g.bed;
    if (Hz > 0) {
      const x1 = hw + m * Hz;
      if (d <= x1) return g.bed + (d - hw) / m;
      if (d <= x1 + g.bw / 2) return g.bed + Hz;
      x2 = x1 + g.bw / 2; base = g.bed + Hz;
    }
    const run = m * (Ht - Hz);
    return d <= x2 + run ? base + (d - x2) / m : g.fp;
  }
  function geom(n) { return { bed: n.bed, fp: n.fp, wb: n.wb, m: n.m, bw: n.bw, bz: n.bz, Wv: n.Wv }; }
  function topHalf(g) { const Ht = Math.max(g.fp - g.bed, 0.15); return g.wb / 2 + g.m * Ht + (g.bw > 0.05 ? g.bw / 2 : 0); }

  /** Re-carve the ranch map's creek and gullies by how far the valley model has moved them since the last time (or since the start). */
  function applyToRanch() {
    const m = S.model, sim = game.sim; if (!m || !sim) return 0;
    const T = sim.readTerrain(), nx = sim.nx, ny = sim.ny, dx = sim.dx;
    const ref = S.applied;
    let touched = 0;
    const reaches = m.reaches.filter((r) => r.ranch || r.main);
    reaches.forEach((r) => {
      const ns = r.nodes.filter((n) => n.ranch || r.ranch);
      if (ns.length < 2) return;
      const pts = ns.map((n) => [n.x - GEO.RX, n.y - GEO.RY]);
      const pair = ns.map((n) => ({ a: ref.get(n.id) || geom(n), b: geom(n), reachVeg: n.veg }));
      const reach = Math.max(...ns.map((n) => n.Wv / 2), 20);
      // bounding box of the band around this reach
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; pts.forEach((p) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
      const i0 = Math.max(0, Math.floor((x0 - reach) / dx)), i1 = Math.min(nx - 1, Math.ceil((x1 + reach) / dx)), j0 = Math.max(0, Math.floor((y0 - reach) / dx)), j1 = Math.min(ny - 1, Math.ceil((y1 + reach) / dx));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * dx, cy = (j + 0.5) * dx;
        let bd = 1e18, bi = 0, bt = 0;
        for (let q = 0; q < pts.length - 1; q++) {
          const ax = pts[q][0], ay = pts[q][1], ex = pts[q + 1][0] - ax, ey = pts[q + 1][1] - ay, l2 = ex * ex + ey * ey || 1e-9;
          const t = clamp(((cx - ax) * ex + (cy - ay) * ey) / l2, 0, 1), qx = ax + t * ex - cx, qy = ay + t * ey - cy, d2 = qx * qx + qy * qy;
          if (d2 < bd) { bd = d2; bi = q; bt = t; }
        }
        const d = Math.sqrt(bd), A = pair[bi], B = pair[bi + 1];
        const ga = {}, gb = {};
        ['bed', 'fp', 'wb', 'm', 'bw', 'bz', 'Wv'].forEach((k) => { ga[k] = lerp(A.a[k], B.a[k], bt); gb[k] = lerp(A.b[k], B.b[k], bt); });
        if (A.a.bw <= 0.05 || B.a.bw <= 0.05) { ga.bw = Math.max(A.a.bw, B.a.bw) > 0.05 ? (A.a.bw > 0.05 ? A.a.bw : B.a.bw) : 0; ga.bz = A.a.bw > 0.05 ? A.a.bz : B.a.bz; }
        if (A.b.bw <= 0.05 || B.b.bw <= 0.05) { gb.bw = Math.max(A.b.bw, B.b.bw) > 0.05 ? (A.b.bw > 0.05 ? A.b.bw : B.b.bw) : 0; gb.bz = A.b.bw > 0.05 ? A.b.bz : B.b.bz; }
        const edge = Math.max(topHalf(ga), topHalf(gb)), far = Math.max(gb.Wv / 2, edge + 6);
        if (d > far) continue;
        let dz = secH(gb, d) - secH(ga, d);
        if (d > edge) dz *= 1 - sstep(edge + 2, far, d);                // fines laid on the valley floor fade out toward the hills
        if (Math.abs(dz) < 0.015) continue;
        const k = (j * nx + i) * 4;
        T[k] += dz; if (T[k + 1] > T[k]) T[k + 1] = T[k];
        // plants on the banks and bench of a creek the valley says is well planted
        if (d > gb.wb / 2 && d <= topHalf(gb) && Math.round(T[k + 2]) === C.COVER.BARE) {
          const veg = lerp(A.reachVeg, B.reachVeg, bt);
          if (veg > 0.5) { T[k + 2] = C.COVER.WILLOW; T[k + 3] = Math.max(T[k + 3], 0.5); } else if (veg > 0.3) { T[k + 2] = C.COVER.PASTURE; T[k + 3] = Math.max(T[k + 3], 0.3); }
        }
        touched++;
      }
    });
    if (!touched) return 0;
    game.snapshotForUndo && game.snapshotForUndo();
    sim.restore(T, null);
    S.applied = m.snapshotProfile();
    return touched;
  }

  // ------------------------------------------------------------------------------------------------
  // Drawing the map
  function makeBackdrop() {
    const dem = S.dem = R.buildDem(S.valley, 40), nx = dem.nx, ny = dem.ny, z = dem.z;
    const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny;
    const g = cv.getContext('2d'), img = g.createImageData(nx, ny), d = img.data;
    let zmin = 1e9, zmax = -1e9; for (let i = 0; i < z.length; i++) { zmin = Math.min(zmin, z[i]); zmax = Math.max(zmax, z[i]); }
    const lx = -0.55, ly = -0.65, lz = 0.52, ll = Math.hypot(lx, ly, lz), L = [lx / ll, ly / ll, lz / ll], ex = 5;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const il = Math.max(i - 1, 0), ir = Math.min(i + 1, nx - 1), jt = Math.max(j - 1, 0), jb = Math.min(j + 1, ny - 1);
      const gx = (z[j * nx + ir] - z[j * nx + il]) / ((ir - il) * dem.cell) * ex, gy = (z[jb * nx + i] - z[jt * nx + i]) / ((jb - jt) * dem.cell) * ex;
      const nl = Math.hypot(gx, gy, 1), sh = clamp((-gx * L[0] - gy * L[1] + L[2]) / nl, 0, 1.2);
      const k = j * nx + i, e = (z[k] - zmin) / (zmax - zmin), fl = dem.floor[k];
      const hill = mix([216, 203, 156], [182, 164, 124], clamp(e * 1.4, 0, 1)), meadow = [186, 206, 138];
      const col = mix(hill, meadow, fl), lum = 0.55 + 0.62 * sh;
      d[k * 4] = clamp(col[0] * lum, 0, 255); d[k * 4 + 1] = clamp(col[1] * lum, 0, 255); d[k * 4 + 2] = clamp(col[2] * lum, 0, 255); d[k * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    S.backdrop = cv;
    S.contours = contourPaths(z, nx, ny, dem.cell, 20 / FT, 100 / FT, 70);
  }

  /** Contour lines of a height grid (marching squares). Heights in metres; a thin line every `step`, a thick one every `majorStep`.
      Returns Path2D objects in the grid's own metres, plus a few labels (height in feet) along the thick lines. */
  function contourPaths(z, nx, ny, cell, step, majorStep, labelEvery) {
    const minor = new Path2D(), major = new Path2D(), labels = [];
    let cnt = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = z[j * nx + i], b = z[j * nx + i + 1], c = z[(j + 1) * nx + i + 1], d = z[(j + 1) * nx + i];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      if (hi - lo < 1e-6) continue;
      const x0 = (i + 0.5) * cell, y0 = (j + 0.5) * cell, x1 = x0 + cell, y1 = y0 + cell;
      for (let lv = Math.ceil(lo / step) * step; lv <= hi; lv += step) {
        const pts = [];
        const edge = (vp, vq, px, py, qx, qy) => { if ((vp < lv) !== (vq < lv)) { const t = (lv - vp) / (vq - vp); pts.push([px + (qx - px) * t, py + (qy - py) * t]); } };
        edge(a, b, x0, y0, x1, y0); edge(b, c, x1, y0, x1, y1); edge(c, d, x1, y1, x0, y1); edge(d, a, x0, y1, x0, y0);
        if (pts.length >= 2) {
          const isMajor = Math.abs(Math.round(lv / majorStep) * majorStep - lv) < step * 0.5, P = isMajor ? major : minor;
          P.moveTo(pts[0][0], pts[0][1]); P.lineTo(pts[1][0], pts[1][1]);
          if (pts.length === 4) { P.moveTo(pts[2][0], pts[2][1]); P.lineTo(pts[3][0], pts[3][1]); }
          if (isMajor && (cnt++ % labelEvery) === 0) labels.push({ x: pts[0][0], y: pts[0][1], t: fmt(Math.round(lv * FT / 5) * 5) });
        }
      }
    }
    return { minor, major, labels };
  }

  /** A picture of your ranch's own ground (the real map from the ranch game), laid inside the dashed box: land use colours, shading, and finer contour lines. */
  function makeRanchTile() {
    const sim = game.sim; if (!sim || !sim.readTerrain) return;
    const T = sim.readTerrain(), nx0 = sim.nx, ny0 = sim.ny, dx0 = sim.dx, st = Math.max(1, Math.ceil(nx0 / 520)), nx = Math.floor(nx0 / st), ny = Math.floor(ny0 / st), dx = dx0 * st;
    const z = new Float32Array(nx * ny), cvr = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = ((j * st) * nx0 + i * st) * 4; z[j * nx + i] = T[k]; cvr[j * nx + i] = Math.round(T[k + 2]); }
    const CV = C.COVER;
    const pal = {}; pal[CV.BARE] = [204, 184, 140]; pal[CV.PASTURE] = [170, 190, 108]; pal[CV.PRAIRIE] = [188, 186, 104]; pal[CV.TREE] = [92, 128, 76]; pal[CV.ROOF] = [150, 140, 130]; pal[CV.ROAD] = [170, 160, 140];
    pal[CV.WILLOW] = [102, 142, 86]; pal[CV.COVERCROP] = [138, 176, 96]; pal[CV.DAM] = [140, 120, 100]; pal[CV.CROP] = [210, 186, 120]; pal[CV.POND] = [96, 150, 178];
    const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny;
    const g = cv.getContext('2d'), img = g.createImageData(nx, ny), d = img.data;
    const lx = -0.55, ly = -0.65, lz = 0.52, ll = Math.hypot(lx, ly, lz), L = [lx / ll, ly / ll, lz / ll], ex = 4;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const il = Math.max(i - 1, 0), ir = Math.min(i + 1, nx - 1), jt = Math.max(j - 1, 0), jb = Math.min(j + 1, ny - 1);
      const gx = (z[j * nx + ir] - z[j * nx + il]) / ((ir - il) * dx) * ex, gy = (z[jb * nx + i] - z[jt * nx + i]) / ((jb - jt) * dx) * ex;
      const sh = clamp((-gx * L[0] - gy * L[1] + L[2]) / Math.hypot(gx, gy, 1), 0, 1.2), col = pal[cvr[j * nx + i]] || pal[CV.PASTURE], lum = 0.6 + 0.55 * sh, k = (j * nx + i) * 4;
      d[k] = clamp(col[0] * lum, 0, 255); d[k + 1] = clamp(col[1] * lum, 0, 255); d[k + 2] = clamp(col[2] * lum, 0, 255); d[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    S.tile = Object.assign({ cv, z, nx, ny, dx }, contourPaths(z, nx, ny, dx, 5 / FT, 25 / FT, 60)); S.tileStale = false;
  }

  /** Height of the ground (m) at a valley point: the ranch's own map inside the dashed box, the valley picture elsewhere. */
  function groundH(x, y) {
    const t = S.tile, rx = x - GEO.RX, ry = y - GEO.RY;
    if (t && rx >= 0 && ry >= 0 && rx < GEO.RW && ry < GEO.RH) {
      const fx = clamp(rx / t.dx - 0.5, 0, t.nx - 1.001), fy = clamp(ry / t.dx - 0.5, 0, t.ny - 1.001), i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      return lerp(lerp(t.z[j * t.nx + i], t.z[j * t.nx + i + 1], u), lerp(t.z[(j + 1) * t.nx + i], t.z[(j + 1) * t.nx + i + 1], u), v);
    }
    const d = S.dem; if (!d) return 0;
    const fx = clamp(x / d.cell - 0.5, 0, d.nx - 1.001), fy = clamp(y / d.cell - 0.5, 0, d.ny - 1.001), i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    return lerp(lerp(d.z[j * d.nx + i], d.z[j * d.nx + i + 1], u), lerp(d.z[(j + 1) * d.nx + i], d.z[(j + 1) * d.nx + i + 1], u), v);
  }
  function probeGround(px, py) {
    const x = s2wx(px), y = s2wy(py);
    if (x < 0 || y < 0 || x > GEO.W || y > GEO.H) return;
    const h = groundH(x, y), step = 25, gx = (groundH(x + step, y) - groundH(x - step, y)) / (2 * step), gy = (groundH(x, y + step) - groundH(x, y - step)) / (2 * step);
    const slope = Math.hypot(gx, gy) * 100, up = (h - S.valley.outlet.bed) * FT;
    S.probe = { x, y, t: performance.now() };
    const word = slope < 1.5 ? 'nearly flat. The contour lines are far apart.' : slope < 6 ? 'gently sloping.' : slope < 15 ? 'a real slope. The contour lines are close together.' : 'steep. The contour lines are packed together.';
    showToast('Ground here: ' + fmt(up) + ' feet above the valley mouth. The slope is ' + slope.toFixed(1) + '%, ' + word, 5200); redraw(); setTimeout(redraw, 4000);
  }
  async function readingTheMap() {
    await ui.card({
      title: 'Reading the map', html:
        '<p>Every thin brown line joins points of the <b>same height</b>. Walk along one and you never go up or down. The thick lines are every 100 feet (every 25 on the ranch) and carry a number.</p>' +
        '<p><b>Close together</b> means steep. <b>Far apart</b> means flat, like the valley floor beside the creek.</p>' +
        '<p>Where a line crosses a creek it bends into a <b>V that points upstream</b>, because the creek has carved a little valley and the lines have to follow it up.</p>' +
        '<p>Tap bare ground with the Look tool and the map tells you the height and the slope there. Then check it against the lines.</p>',
      buttons: [{ label: 'Got it' }]
    });
  }

  function widthPx(n, isMain) { return clamp(R.topWidth(n) * S.cam.scale, isMain ? 2.4 : 1.7, 46); }

  function draw() {
    drawQueued = false;
    const cv = S.el.map; if (!cv || !S.open) return;
    const ctx = cv.getContext('2d'), dpr = S.dpr, sc = S.cam.scale, m = S.model;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e8dfc6'; ctx.fillRect(0, 0, S.w, S.h);
    if (!m || !S.backdrop) { ctx.fillStyle = '#6b5640'; ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Building the valley…', S.w / 2, S.h / 2); return; }
    const tx = S.w / 2 - S.cam.x * sc, ty = S.h / 2 - S.cam.y * sc;
    // hills
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * tx, dpr * ty);
    ctx.drawImage(S.backdrop, 0, 0, GEO.W, GEO.H);
    // contour lines
    if (Creek.settings && Creek.settings.get('contours', true) !== false) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(120,80,40,0.30)'; ctx.lineWidth = 0.9 / sc; ctx.stroke(S.contours.minor);
      ctx.strokeStyle = 'rgba(110,70,30,0.62)'; ctx.lineWidth = 1.5 / sc; ctx.stroke(S.contours.major);
    }
    // the ranch's own map, inside the dashed box
    if (S.tile) {
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (tx + GEO.RX * sc), dpr * (ty + GEO.RY * sc));
      ctx.imageSmoothingEnabled = true; ctx.drawImage(S.tile.cv, 0, 0, GEO.RW, GEO.RH);
      if (sc > 0.12 && Creek.settings && Creek.settings.get('contours', true) !== false) {
        ctx.strokeStyle = 'rgba(110,70,30,0.34)'; ctx.lineWidth = 0.8 / sc; ctx.stroke(S.tile.minor);
        ctx.strokeStyle = 'rgba(100,60,25,0.7)'; ctx.lineWidth = 1.4 / sc; ctx.stroke(S.tile.major);
      }
    }
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sc > 0.08 && Creek.settings && Creek.settings.get('contours', true) !== false) {
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      S.contours.labels.forEach((l) => { const x = w2sx(l.x), y = w2sy(l.y); if (x < -20 || y < -20 || x > S.w + 20 || y > S.h + 20) return; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(232,223,198,0.85)'; ctx.strokeText(l.t, x, y); ctx.fillStyle = 'rgba(100,60,25,0.9)'; ctx.fillText(l.t, x, y); });
    }
    if (S.tile && sc > 0.3) {
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      S.tile.labels.forEach((l) => { const x = w2sx(GEO.RX + l.x), y = w2sy(GEO.RY + l.y); if (x < -20 || y < -20 || x > S.w + 20 || y > S.h + 20) return; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(232,223,198,0.85)'; ctx.strokeText(l.t, x, y); ctx.fillStyle = 'rgba(100,60,25,0.9)'; ctx.fillText(l.t, x, y); });
    }
    // old loops (oxbow lakes)
    m.oxbows.forEach((o) => {
      ctx.beginPath(); o.pts.forEach((p, i) => { const x = w2sx(p[0]), y = w2sy(p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(80,140,170,' + (0.75 - 0.5 * o.fill).toFixed(2) + ')'; ctx.lineWidth = clamp(o.w * sc * (1 - 0.5 * o.fill), 2, 30); ctx.stroke();
    });
    // where the creeks used to run
    if (S.ghostOn && S.ghost) {
      ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(70,60,50,0.5)'; ctx.lineWidth = 1.2;
      S.ghost.forEach((pts) => { ctx.beginPath(); pts.forEach((p, i) => { const x = w2sx(p[0]), y = w2sy(p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    // flood water spreading over the valley floor
    if (S.lens === 'flood') {
      ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(80,150,215,0.55)';
      m.nodes.forEach((n) => {
        if (!n.down || !n.yMax) return;
        const wfl = Math.min(R.widthAt(n, n.yMax), Math.max(n.Wv, R.topWidth(n)));
        ctx.lineWidth = Math.max(wfl * sc, 2); ctx.beginPath(); ctx.moveTo(w2sx(n.x), w2sy(n.y)); ctx.lineTo(w2sx(n.down.x), w2sy(n.down.y)); ctx.stroke();
      });
    }
    // the ranch
    const rx = w2sx(GEO.RX), ry = w2sy(GEO.RY), rw = GEO.RW * sc, rh = GEO.RH * sc;
    ctx.fillStyle = 'rgba(233,162,59,0.10)'; ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = 'rgba(200,120,20,0.95)'; ctx.lineWidth = 2; ctx.setLineDash([8, 4]); ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
    if (game.fields && sc > 0.22) {
      ctx.font = 'italic 11px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3;
      game.fields.forEach((f) => { if (f.kind !== 'field' || !f.name) return; const x = w2sx(GEO.RX + f.cx), y = w2sy(GEO.RY + f.cy); ctx.strokeStyle = 'rgba(244,236,216,0.85)'; ctx.strokeText(f.name, x, y); ctx.fillStyle = '#4a5a2a'; ctx.fillText(f.name, x, y); });
    }
    ctx.font = '600 12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 3;
    const lab = '🏠 ' + (C.ranchName || 'Your ranch'); ctx.strokeStyle = 'rgba(244,236,216,0.9)'; ctx.strokeText(lab, rx + 4, ry - 5); ctx.fillStyle = '#7a4a05'; ctx.fillText(lab, rx + 4, ry - 5);
    // creeks: side streams first, then the main creek on top
    const lens = LENSES.find((l) => l.id === S.lens) || LENSES[0];
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const reaches = m.reaches.slice().sort((a, b) => (a.main ? 1 : 0) - (b.main ? 1 : 0));
    reaches.forEach((r) => {
      const ns = r.nodes, isMain = !!r.main;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < ns.length; i++) {
          const n = ns[i], d = n.down; if (!d) continue;
          const x0 = w2sx(n.x), y0 = w2sy(n.y), x1 = w2sx(d.x), y1 = w2sy(d.y);
          if ((x0 < -50 && x1 < -50) || (x0 > S.w + 50 && x1 > S.w + 50) || (y0 < -50 && y1 < -50) || (y0 > S.h + 50 && y1 > S.h + 50)) continue;
          const wpx = widthPx(n, isMain);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          if (pass === 0) { ctx.strokeStyle = 'rgba(40,30,20,0.55)'; ctx.lineWidth = wpx + 2; }
          else { ctx.strokeStyle = rgb(lens.color(n, m)); ctx.lineWidth = wpx; }
          ctx.stroke();
        }
      }
    });
    // failures, structures, selection
    if (sc > 0.12) m.nodes.forEach((n) => {
      if (n.acc && n.acc.fail > 0.25) { ctx.fillStyle = 'rgba(190,40,30,0.9)'; ctx.beginPath(); ctx.arc(w2sx(n.x), w2sy(n.y), 3, 0, 6.283); ctx.fill(); }
      if (n.struct) { ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText({ weir: '🪨', bda: '🦫', plug: '🧱', pond: '🏞️' }[n.struct.type] || '•', w2sx(n.x), w2sy(n.y) - 10); }
    });
    if (S.stroke && S.stroke.nodes) {
      ctx.strokeStyle = 'rgba(255,196,60,0.85)'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath();
      S.stroke.nodes.forEach((n, i) => { const x = w2sx(n.x), y = w2sy(n.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
    }
    const sel = S.sel && m.byId.get(S.sel.id) ? S.sel : null;
    if (sel) {
      const x = w2sx(sel.x), y = w2sy(sel.y);
      // the path from here to the valley's mouth
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); m.pathDown(sel).forEach((n, i) => { const px = w2sx(n.x), py = w2sy(n.y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, 11, 0, 6.283); ctx.stroke();
      ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 11, 0, 6.283); ctx.stroke();
    }
    if (S.hover && S.tool !== 'look') { ctx.strokeStyle = 'rgba(59,42,26,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(w2sx(S.hover.x), w2sy(S.hover.y), 9, 0, 6.283); ctx.stroke(); }
    if (S.probe && performance.now() - S.probe.t < 4500) {
      const x = w2sx(S.probe.x), y = w2sy(S.probe.y); ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.283); ctx.stroke();
    }
    // creek names
    if (sc > 0.045) {
      ctx.font = 'italic 12px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 3;
      m.reaches.forEach((r) => {
        if (!r.nodes.length) return;
        const n = r.nodes[Math.floor(r.nodes.length * (r.main ? 0.18 : 0.5))], x = w2sx(n.x), y = w2sy(n.y);
        if (x < 0 || y < 0 || x > S.w || y > S.h || (!r.main && sc < 0.09) || (r.ranch && sc < 0.3)) return;
        ctx.strokeStyle = 'rgba(244,236,216,0.9)'; ctx.strokeText(r.name, x + 14, y); ctx.fillStyle = '#2f4f66'; ctx.fillText(r.name, x + 14, y);
      });
    }
    // scale bar
    const nice = [50, 100, 250, 500, 1000, 2000, 5000].find((v) => v * sc >= 60) || 5000, sbx = 14, sby = S.h - (S.tray || 100) - 18;
    ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sbx, sby - 5); ctx.lineTo(sbx, sby); ctx.lineTo(sbx + nice * sc, sby); ctx.lineTo(sbx + nice * sc, sby - 5); ctx.stroke();
    ctx.fillStyle = '#3b2a1a'; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.fillText(nice >= 1000 ? (nice / 1609.3).toFixed(nice >= 1609 ? 1 : 2) + ' mile' : fmt(nice * FT) + ' ft', sbx + 4, sby - 8);
  }
  function redraw() { S.dirty = true; if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }

  // ------------------------------------------------------------------------------------------------
  // Small charts for the inspector
  function setupCanvas(cv, w, h) { const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return g; }

  function drawSection(cv, n, w, h) {
    const g = setupCanvas(cv, w, h), m = S.model, sec = m.section(n), init = S.model.initial.get(n.id);
    const topH = Math.max(R.topWidth(n) / 2, 8), xr = clamp(topH * 2.3 + 6, 24, Math.max(n.Wv / 2, 24)), z0 = sec.bed - 0.5, z1 = Math.max(sec.fp, sec.levels[100]) + 1.2;
    const X = (x) => 8 + (x + xr) / (2 * xr) * (w - 16), Y = (z) => h - 20 - (z - z0) / (z1 - z0) * (h - 34);
    g.fillStyle = '#eef3f4'; g.fillRect(0, 0, w, h);
    // the three flood levels as light bands
    [[100, '#cfe0ec'], [10, '#b6d2e6'], [1, '#98c0dc']].forEach(([T, col]) => { const y = Y(sec.levels[T]); g.fillStyle = col; g.fillRect(0, y, w, h - y); });
    // earlier ground (where the creek started)
    if (init) {
      const gi = Object.assign({}, n, init), s0 = m.section(gi);
      g.beginPath(); s0.pts.forEach((p, i) => { const x = X(clamp(p[0], -xr, xr)), y = Y(p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.setLineDash([4, 3]); g.strokeStyle = 'rgba(70,50,30,0.7)'; g.lineWidth = 1.4; g.stroke(); g.setLineDash([]);
    }
    // the ground now
    g.beginPath(); g.moveTo(X(-xr), h);
    sec.pts.forEach((p) => g.lineTo(X(clamp(p[0], -xr, xr)), Y(p[1])));
    g.lineTo(X(xr), h); g.closePath(); g.fillStyle = '#a78660'; g.fill();
    g.beginPath(); sec.pts.forEach((p, i) => { const x = X(clamp(p[0], -xr, xr)), y = Y(p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.strokeStyle = '#5a4128'; g.lineWidth = 2; g.stroke();
    // plant cover on the banks
    g.fillStyle = 'rgba(70,140,60,' + (0.25 + 0.6 * n.veg).toFixed(2) + ')';
    sec.pts.forEach((p) => { if (p[1] > sec.bed + 0.1) g.fillRect(X(clamp(p[0], -xr, xr)) - 1.5, Y(p[1]) - 3, 3, 3); });
    g.font = '10px system-ui'; g.fillStyle = '#2f4f66'; g.textAlign = 'right';
    let lastY = 1e9;
    [[100, '100-yr flood'], [10, '10-yr'], [1, '1-yr']].forEach(([T, t]) => { const y = Y(sec.levels[T]); g.strokeStyle = 'rgba(40,90,140,0.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); const ly = Math.min(y - 2, lastY - 11); g.fillText(t, w - 4, ly); lastY = ly; });
    g.textAlign = 'left'; g.fillStyle = '#5a4128'; g.fillText('bank ' + ftS(sec.bankHeight, 1) + ' tall', 6, 12);
    g.fillStyle = '#6b5640'; g.fillText(fmt(2 * xr * FT) + ' ft across', 6, h - 5);
  }

  function pathFor(node) {
    const m = S.model, r = node.reach, out = r.nodes.slice(), last = r.nodes[r.nodes.length - 1];
    for (let n = last && last.down; n; n = n.down) out.push(n);
    return out;
  }
  function drawProfile(cv, node, w, h) {
    const g = setupCanvas(cv, w, h), m = S.model, path = pathFor(node);
    g.fillStyle = '#f2ecdd'; g.fillRect(0, 0, w, h);
    if (path.length < 2) return;
    let L = 0; const xs = path.map((n, i) => { if (i) L += path[i - 1].len; return L; });
    let zmin = 1e9, zmax = -1e9; path.forEach((n) => { zmin = Math.min(zmin, n.bed); zmax = Math.max(zmax, n.fp + 0.5); });
    const X = (x) => 6 + x / L * (w - 12), Y = (z) => h - 14 - (z - zmin) / (zmax - zmin) * (h - 24);
    // the ranch stretch and structures
    path.forEach((n, i) => { if (n.ranch && n.reach.main) { g.fillStyle = 'rgba(233,162,59,0.22)'; g.fillRect(X(xs[i]) - 0.6, 0, X(Math.min(L, xs[i] + n.len)) - X(xs[i]) + 1.2, h - 14); } });
    // floodplain and bed, filled between
    g.beginPath(); path.forEach((n, i) => { const x = X(xs[i]), y = Y(n.fp); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    for (let i = path.length - 1; i >= 0; i--) g.lineTo(X(xs[i]), Y(path[i].bed));
    g.closePath(); g.fillStyle = 'rgba(160,110,70,0.35)'; g.fill();
    g.beginPath(); path.forEach((n, i) => { const x = X(xs[i]), y = Y(n.fp); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.strokeStyle = '#5d8a3a'; g.lineWidth = 1.6; g.stroke();
    g.setLineDash([3, 3]); g.beginPath(); let started = false;
    path.forEach((n, i) => { const i0 = m.initial.get(n.id); if (!i0) return; const x = X(xs[i]), y = Y(i0.bed); if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; } }); g.strokeStyle = 'rgba(70,50,30,0.7)'; g.lineWidth = 1.2; g.stroke(); g.setLineDash([]);
    g.beginPath(); path.forEach((n, i) => { const x = X(xs[i]), y = Y(n.bed); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.strokeStyle = '#2f5f86'; g.lineWidth = 2; g.stroke();
    path.forEach((n, i) => { if (n.struct) { g.fillStyle = '#3b2a1a'; g.fillRect(X(xs[i]) - 2, Y(n.bed) - 8, 4, 8); } });
    const si = path.indexOf(node); if (si >= 0) { g.fillStyle = '#fff'; g.strokeStyle = '#3b2a1a'; g.lineWidth = 2; g.beginPath(); g.arc(X(xs[si]), Y(node.bed), 4.5, 0, 6.283); g.fill(); g.stroke(); }
    g.font = '10px system-ui'; g.fillStyle = '#6b5640'; g.textAlign = 'left'; g.fillText(fmt(zmax * FT - 0) + ' ft', 6, 10); g.fillText(fmt(zmin * FT) + ' ft', 6, h - 4); g.textAlign = 'right'; g.fillText((L / 1609.3).toFixed(1) + ' miles to the valley mouth →', w - 6, h - 4);
  }
  function drawHistory(cv, n, w, h) {
    const g = setupCanvas(cv, w, h); g.fillStyle = '#f2ecdd'; g.fillRect(0, 0, w, h);
    const hs = n.hist; g.font = '10px system-ui';
    if (!hs || hs.length < 2) { g.fillStyle = '#6b5640'; g.textAlign = 'center'; g.fillText('Let a few years go by to see its history.', w / 2, h / 2); return; }
    const y0 = hs[0].y, y1 = hs[hs.length - 1].y, X = (y) => 8 + (y - y0) / Math.max(1, y1 - y0) * (w - 16);
    const series = [[hs.map((q) => q.bed - hs[0].bed), '#2f5f86', 'bed'], [hs.map((q) => q.w - hs[0].w), '#b5654a', 'width']];
    let lo = 0, hi = 0; series.forEach(([s]) => s.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); })); if (hi - lo < 0.5) { hi += 0.25; lo -= 0.25; }
    const Y = (v) => h - 14 - (v - lo) / (hi - lo) * (h - 26);
    g.strokeStyle = '#cdbf9f'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(w, Y(0)); g.stroke();
    series.forEach(([s, col]) => { g.beginPath(); s.forEach((v, i) => { const x = X(hs[i].y), y = Y(v); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.strokeStyle = col; g.lineWidth = 2; g.stroke(); });
    g.fillStyle = '#2f5f86'; g.textAlign = 'left'; g.fillText('bed ' + (hs[hs.length - 1].bed - hs[0].bed >= 0 ? '+' : '') + ftS(hs[hs.length - 1].bed - hs[0].bed), 6, 11);
    g.fillStyle = '#b5654a'; g.textAlign = 'right'; g.fillText('width ' + (hs[hs.length - 1].w - hs[0].w >= 0 ? '+' : '') + ftS(hs[hs.length - 1].w - hs[0].w, 0), w - 6, 11);
    g.fillStyle = '#6b5640'; g.textAlign = 'left'; g.fillText('year ' + y0, 6, h - 3); g.textAlign = 'right'; g.fillText('year ' + y1, w - 6, h - 3);
  }

  // ------------------------------------------------------------------------------------------------
  // The inspector
  const SAY = {
    I: 'This creek can still reach its floodplain, so a flood spreads out and loses its punch.',
    II: 'The bed is dropping. The creek is digging itself a trench, and its banks are getting taller.',
    III: 'The banks are too tall to stand, so they slump and the creek gets wider. Mud and gravel head downstream.',
    IV: 'Gravel and mud are piling up and the bed is rising. A new floodplain is starting to grow inside the old trench.',
    V: 'A new floodplain has built up inside the trench and plants hold it. Floods can spread out again.'
  };
  function renderInfo() {
    const el = S.el.info; if (!el) return;
    const m = S.model, n = S.sel && m && m.byId.get(S.sel.id) ? S.sel : null;
    if (!n) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const d = m.describe(n), bal = m.balance(n), i0 = m.initial.get(n.id), dBed = i0 ? n.bed - i0.bed : 0;
    const ratio = bal.ratio, tilt = clamp(Math.log2(clamp(ratio, 0.25, 4)) / 2, -1, 1);
    const lane = ratio > 1.6 ? 'The floods could carry much more gravel than arrives, so this stretch tends to <b>dig</b>.' : ratio < 0.65 ? 'More gravel arrives than the floods can carry, so this stretch tends to <b>fill</b>.' : 'Water strength and gravel supply are about even, so the bed holds steady.';
    const f10 = d.floods[10], f100 = d.floods[100];
    const structNote = n.struct ? '<div class="rvnote">Built here: <b>' + ({ weir: 'a rock weir', bda: 'a beaver dam analog', plug: 'a headcut plug', pond: 'a silt pond' }[n.struct.type]) + '</b>' + (n.struct.type === 'bda' ? ' (about ' + Math.max(0, (n.struct.life || 10) - (n.struct.age || 0)) + ' years left)' : '') + '</div>' : '';
    const here = n.ranch && n.reach.main ? ' · on your ranch' : n.reach.ranch ? ' · your gully' : '';
    const mile = (() => { let L = 0; const ns = n.reach.nodes; for (let i = 0; i < ns.length && ns[i] !== n; i++) L += ns[i].len; return L / 1609.3; })();
    el.innerHTML =
      '<div class="rvhead" id="rvInfoHead"><div><div class="rvtitle">' + ui.esc(n.reach.name) + '<span>' + ui.esc(here) + '</span></div>' +
      '<div class="rvsub">' + mile.toFixed(1) + ' miles from its start · drains ' + fmt(d.areaAcres) + ' acres</div></div>' +
      '<div class="rvbadge" style="background:' + rgb(STAGE_COL[d.stage]) + '">' + ui.esc(STAGE_NAME[d.stage]) + '</div>' +
      '<button class="plain rvx" id="rvInfoX" aria-label="Close">✕</button></div>' +
      '<p class="rvsay">' + ui.esc(SAY[d.stage]) + '</p><div class="rvbody">' + structNote +
      '<div class="rvgrid">' +
      '<div><b>' + ftS(d.bankHeight) + '</b><small>bank height</small></div>' +
      '<div><b>' + ftS(d.topWidth, 0) + '</b><small>wide at the top</small></div>' +
      '<div><b>' + (dBed < 0 ? '↓ ' : dBed > 0.01 ? '↑ ' : '') + ftS(Math.abs(dBed)) + '</b><small>bed since start</small></div>' +
      '<div><b>' + (d.slope * 100).toFixed(2) + '%</b><small>slope</small></div>' +
      '<div><b>' + fmt(d.D50mm) + ' mm</b><small>gravel size</small></div>' +
      '<div><b>' + Math.round(d.veg * 100) + '%</b><small>plants on banks</small></div>' +
      '<div><b>' + fmt(f10.Q * CFS) + '</b><small>cfs, 10-yr flood</small></div>' +
      '<div><b>' + (f100.over > 0.02 ? 'spills ' + ftS(f100.over) : 'stays in') + '</b><small>100-yr flood</small></div></div>' +
      '<h4>Across the creek</h4><canvas id="rvSec"></canvas><div class="rvcap">Brown is the ground now; the dashed line is where it was. Blue lines are how high 1-, 10- and 100-year floods reach.</div>' +
      '<h4>Down the valley</h4><canvas id="rvProf"></canvas><div class="rvcap">Blue is the creek bed, green the floodplain, dashed the bed at the start, orange the ranch.</div>' +
      '<h4>Over the years</h4><canvas id="rvHist"></canvas>' +
      '<h4>Water against gravel</h4><div class="rvlane"><div class="rvbeam"><div class="rvtilt" style="transform:rotate(' + (tilt * 14).toFixed(1) + 'deg)"><span>💧 water strength</span><span>gravel 🪨</span></div></div></div><p class="rvcap">' + lane + '</p>' +
      '<details><summary>' + ui.esc(R.TYPES[d.type] ? 'Stream type ' + d.type : 'Stream type') + '</summary><p class="rvcap">' + ui.esc(R.TYPES[d.type] || '') + '</p></details>' +
      '<details><summary>More numbers</summary><table class="res small">' +
      '<tr><td>Bed height</td><td class="n">' + ftS(d.bed) + '</td></tr><tr><td>Floodplain height</td><td class="n">' + ftS(d.floodplain) + '</td></tr>' +
      '<tr><td>Gravel on the bed</td><td class="n">' + ftS(d.alluvium, 2) + '</td></tr><tr><td>Soft soil under it</td><td class="n">' + ftS(d.soft, 2) + '</td></tr>' +
      '<tr><td>Bank soil</td><td class="n">' + ui.esc(d.soil) + '</td></tr><tr><td>Bottom width</td><td class="n">' + ftS(d.bottomWidth, 0) + '</td></tr>' +
      '<tr><td>Bench width</td><td class="n">' + ftS(d.benchWidth, 0) + '</td></tr><tr><td>Bend ratio (sinuosity)</td><td class="n">' + d.sinuosity.toFixed(2) + '</td></tr>' +
      '<tr><td>Valley floor width</td><td class="n">' + ftS(d.valleyWidth, 0) + '</td></tr><tr><td>Bed shear, 10-yr flood</td><td class="n">' + fmt(f10.tau) + ' Pa</td></tr>' +
      '<tr><td>Bedrock ledge</td><td class="n">' + (d.ledge ? 'yes' : 'no') + '</td></tr></table></details>' +
      '</div>';
    const wdt = Math.min(el.clientWidth - 24, 420) || 300;
    drawSection($('rvSec'), n, wdt, 150); drawProfile($('rvProf'), n, wdt, 110); drawHistory($('rvHist'), n, wdt, 80);
    $('rvInfoX').onclick = () => { S.sel = null; renderInfo(); redraw(); };
    $('rvInfoHead').onclick = (e) => { if (e.target.id !== 'rvInfoX') { el.classList.toggle('collapsed'); } };
  }

  function renderTop() {
    const m = S.model, e = S.el; if (!m || !e.year) return;
    e.year.textContent = 'Year ' + m.year;
    const h = m.health();
    e.health.innerHTML = '<div class="rvh1">Valley health ' + Math.round(h.main * 100) + '%</div><div class="rvbar"><div style="width:' + Math.round(h.main * 100) + '%"></div></div><div class="rvh2">' + Math.round(h.main * 100) + '% of ' + (h.lengthKm * 0.6214).toFixed(1) + ' miles · ranch ' + Math.round(h.ranch * 100) + '%</div>';
    e.play.textContent = S.play ? '⏸' : '▶';
    e.play.classList.toggle('on', S.play);
    const L = LENSES.find((l) => l.id === S.lens);
    e.legend.innerHTML = L.legend.map(([c, t]) => '<span><i style="background:' + rgb(c) + '"></i>' + ui.esc(t) + '</span>').join('');
    e.cash.textContent = money(game.cash);
    e.cash.classList.toggle('neg', game.cash < 0);
  }
  function renderAll() { renderTop(); renderInfo(); redraw(); }

  function showToast(text, ms) {
    const t = S.el.toast; if (!t) { ui.toast && ui.toast(text); return; }
    t.textContent = text; t.classList.remove('hidden'); clearTimeout(S.toastT); S.toastT = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }
  function setBusy(i, n) {
    const b = S.el.busy; if (!b) return;
    if (i == null) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden'); b.firstChild.textContent = n > 1 ? 'Letting ' + (n - i) + ' year' + (n - i === 1 ? '' : 's') + ' go by…' : 'A year goes by…'; b.children[1].firstChild.style.width = Math.round(100 * i / n) + '%';
  }

  // ------------------------------------------------------------------------------------------------
  // Building the screen
  const CSS = `
#rv { position: absolute; inset: 0; z-index: 9; background: #e8dfc6; touch-action: none; }
#rv.hidden { display: none; }
#rvMap { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
#rv .rvrow { position: absolute; left: 10px; right: 10px; display: flex; gap: 6px; align-items: center; overflow-x: auto; scrollbar-width: none; padding: 2px; }
#rv .rvrow::-webkit-scrollbar { display: none; }
#rvTop { top: calc(8px + var(--safe-t)); }
#rvLens { top: calc(54px + var(--safe-t)); }
#rv .chip { flex: 0 0 auto; min-height: 38px; }
#rvYear { font-family: Georgia, serif; font-weight: 600; }
#rvHealth { position: absolute; left: 10px; top: calc(100px + var(--safe-t)); background: rgba(244,236,216,.94); border-radius: 14px; padding: 6px 10px; box-shadow: var(--shadow); width: 158px; font-size: 11px; line-height: 1.25; }
#rvHealth .rvh1 { font-weight: 600; font-size: 12px; } #rvHealth .rvh2 { color: var(--ink2); }
.rvbar { height: 7px; border-radius: 5px; background: #d9ccae; overflow: hidden; margin: 3px 0; } .rvbar div { height: 100%; background: linear-gradient(90deg, #d9a23b, #5d8a3a); }
#rvLegend { position: absolute; left: 10px; top: calc(168px + var(--safe-t)); display: flex; flex-direction: column; gap: 2px; background: rgba(244,236,216,.9); border-radius: 12px; padding: 6px 10px; font-size: 11px; box-shadow: var(--shadow); max-width: 190px; }
#rvLegend i { display: inline-block; width: 18px; height: 6px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
#rvTray { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 8px calc(8px + var(--safe-b)); background: rgba(244,236,216,.95); box-shadow: 0 -3px 12px rgba(59,42,26,.2); border-radius: 18px 18px 0 0; }
#rvTools { display: flex; gap: 6px; overflow-x: auto; padding: 2px 2px 4px; scrollbar-width: none; }
#rvTools::-webkit-scrollbar { display: none; }
#rvTools .tool small { display: block; font-size: 9.5px; color: var(--ink2); }
#rvHelp { font-size: 12.5px; color: var(--ink2); padding: 2px 6px 0; min-height: 18px; font-family: Georgia, serif; }
#rvInfo { position: absolute; left: 8px; right: 8px; bottom: calc(var(--rvtray, 100px) + var(--safe-b)); max-height: 56vh; overflow: auto; background: var(--paper); border-radius: 18px; box-shadow: var(--shadow); font-size: 13.5px; }
#rvInfo.hidden { display: none; }
#rvInfo.collapsed .rvbody { display: none; }
#rvInfo .rvsay { padding: 0 12px; }
#rvInfo .rvhead { position: sticky; top: 0; background: var(--paper); display: flex; align-items: center; gap: 8px; padding: 8px 4px 8px 12px; border-bottom: 1px solid #d9ccae; z-index: 1; cursor: pointer; }
#rvInfo .rvhead > div:first-child { flex: 1; min-width: 0; }
.rvtitle { font-family: Georgia, serif; font-size: 16px; font-weight: 700; } .rvtitle span { font-weight: 400; color: #b0640a; font-size: 12px; }
.rvsub { font-size: 11.5px; color: var(--ink2); }
.rvbadge { color: #fff; font-size: 11.5px; font-weight: 600; padding: 4px 9px; border-radius: 999px; white-space: nowrap; }
.rvx { width: 34px; height: 34px; padding: 0 !important; }
#rvInfo .rvbody { padding: 4px 12px 12px; }
.rvsay { font-family: Georgia, serif; font-size: 14.5px; line-height: 1.4; margin: 6px 0; }
.rvnote { background: #fff6dc; border-radius: 10px; padding: 6px 10px; margin: 4px 0; font-size: 13px; }
.rvgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 8px 0; }
.rvgrid div { background: #ebdfc3; border-radius: 10px; padding: 5px 4px; text-align: center; line-height: 1.15; }
.rvgrid b { display: block; font-size: 13px; } .rvgrid small { font-size: 9.5px; color: var(--ink2); }
#rvInfo h4 { margin: 12px 0 4px; font-family: Georgia, serif; font-size: 14px; }
#rvInfo canvas { display: block; border-radius: 10px; width: 100%; }
.rvcap { font-size: 11.5px; color: var(--ink2); margin: 3px 0 0; line-height: 1.35; }
.rvlane .rvbeam { height: 54px; display: flex; align-items: center; justify-content: center; }
.rvtilt { width: 92%; height: 10px; background: var(--clay); border-radius: 5px; position: relative; transition: transform .4s; }
.rvtilt span { position: absolute; top: -22px; font-size: 11px; white-space: nowrap; } .rvtilt span:first-child { left: 0; } .rvtilt span:last-child { right: 0; }
#rvInfo details { margin-top: 8px; } #rvInfo summary { cursor: pointer; font-weight: 600; font-size: 13px; }
#rvToast { position: absolute; left: 50%; transform: translateX(-50%); top: calc(104px + var(--safe-t)); background: rgba(59,42,26,.93); color: #fff6e6; padding: 8px 16px; border-radius: 16px; font-size: 13.5px; max-width: min(92vw, 520px); text-align: center; pointer-events: none; z-index: 3; }
#rvToast.hidden { display: none; }
#rvBusy { position: absolute; left: 50%; top: 42%; transform: translateX(-50%); background: rgba(244,236,216,.96); border-radius: 16px; padding: 12px 16px; box-shadow: var(--shadow); font-size: 14px; width: 230px; text-align: center; z-index: 4; }
#rvBusy.hidden { display: none; } #rvBusy .bar { height: 8px; border-radius: 6px; background: #d9ccae; overflow: hidden; margin: 8px 0 6px; } #rvBusy .bar div { height: 100%; background: var(--water); width: 0; }
#rvBusy button { padding: 4px 12px; font-size: 12px; }
.rvmenu { position: absolute; right: 10px; top: calc(52px + var(--safe-t)); background: var(--paper); border-radius: 14px; box-shadow: var(--shadow); padding: 6px; display: flex; flex-direction: column; gap: 4px; z-index: 6; min-width: 200px; }
.rvmenu.hidden { display: none; }
.rvmenu button { background: var(--paper2); border-radius: 10px; padding: 9px 12px; text-align: left; font-size: 14px; }
.rvmenu button:active { background: #fff6dc; }
.river-on #topbar, .river-on #topbar2, .river-on #stormbar, .river-on #toolbar, .river-on #hint, .river-on #report, .river-on #probe, .river-on #scalebar, .river-on #labels, .river-on #toast { display: none !important; }
@media (max-width: 899px) {
  #rvHealth { width: auto; display: flex; align-items: center; gap: 8px; padding: 4px 10px; top: calc(98px + var(--safe-t)); }
  #rvHealth .rvh1 { font-size: 11px; white-space: nowrap; } #rvHealth .rvbar { width: 64px; margin: 0; } #rvHealth .rvh2 { display: none; }
  #rvLegend { top: calc(130px + var(--safe-t)); flex-direction: row; flex-wrap: wrap; max-width: calc(100vw - 20px); gap: 2px 10px; padding: 4px 8px; font-size: 10px; }
  #rvLegend i { width: 12px; }
}
@media (min-width: 900px) {
  #rvInfo { left: auto; right: 10px; width: 380px; top: calc(100px + var(--safe-t)); bottom: calc(var(--rvtray, 100px) + 8px); max-height: none; }
  #rvTray { left: 50%; right: auto; transform: translateX(-50%); width: min(760px, calc(100vw - 16px)); bottom: 8px; border-radius: 18px; }
}
`;

  function build() {
    if (S.built) return;
    S.built = true;
    ui.styles(CSS);
    const root = document.createElement('div'); root.id = 'rv'; root.className = 'hidden';
    root.innerHTML =
      '<canvas id="rvMap"></canvas>' +
      '<div id="rvTop" class="rvrow"><button class="chip" id="rvHome" title="Back to the ranch map">🏠 Ranch</button><div class="chip" id="rvYear">Year 0</div>' +
      '<button class="chip" id="rvPlay" title="Let years go by">▶</button><button class="chip" id="rvPlus10">+10 yr</button>' +
      '<button class="chip" id="rvFlood">🌊 Flood</button><button class="chip" id="rvMore">⋯</button><button class="chip" id="rvCash" title="Ranch money">$0</button></div>' +
      '<div id="rvLens" class="rvrow"></div><div id="rvHealth"></div><div id="rvLegend"></div>' +
      '<aside id="rvInfo" class="hidden"></aside>' +
      '<div id="rvMenu" class="rvmenu hidden"></div><div id="rvToast" class="hidden"></div>' +
      '<div id="rvBusy" class="hidden"><div>Working…</div><div class="bar"><div></div></div><button class="plain" id="rvStop">Stop</button></div>' +
      '<div id="rvTray"><div id="rvTools"></div><div id="rvHelp"></div></div>';
    $('app').appendChild(root);
    const e = S.el = { root, map: $('rvMap'), top: $('rvTop'), year: $('rvYear'), play: $('rvPlay'), health: $('rvHealth'), legend: $('rvLegend'), info: $('rvInfo'), toast: $('rvToast'), busy: $('rvBusy'), menu: $('rvMenu'), tray: $('rvTray'), cash: $('rvCash'), help: $('rvHelp') };
    // lenses
    const lensRow = $('rvLens');
    LENSES.forEach((l) => { const b = document.createElement('button'); b.className = 'chip' + (l.id === S.lens ? ' on' : ''); b.textContent = l.label; b.dataset.id = l.id; b.onclick = () => setLens(l.id, true); lensRow.appendChild(b); });
    // tools
    const toolsRow = $('rvTools');
    TOOLS.forEach((t) => { const b = document.createElement('button'); b.className = 'tool' + (t.id === S.tool ? ' sel' : ''); b.dataset.id = t.id; b.innerHTML = '<span class="ic">' + t.icon + '</span>' + ui.esc(t.label) + '<small>' + (t.cost != null ? (t.cost ? money(t.cost) : 'free') : t.kind === 'stretch' ? '$' + t.per + '/m' : '') + '</small>'; b.onclick = () => setTool(t.id); toolsRow.appendChild(b); });
    $('rvHelp').textContent = toolDef(S.tool).help;
    // buttons
    $('rvHome').onclick = () => close();
    $('rvPlay').onclick = () => { S.play = !S.play; renderTop(); if (S.play) playLoop(); };
    $('rvPlus10').onclick = () => { S.play = false; runYears(10); };
    $('rvStop').onclick = () => { S.cancel = true; S.play = false; };
    $('rvFlood').onclick = () => toggleMenu('flood');
    $('rvMore').onclick = () => toggleMenu('more');
    $('rvCash').onclick = () => { if (game.cbs && game.cbs.books) game.cbs.books(); else showToast('Ranch money: ' + money(game.cash)); };
    // map input
    wireInput(e.map);
    window.addEventListener('resize', () => { if (S.open) resize(); });
    new ResizeObserver(() => { if (S.open) resize(); }).observe(root);
  }

  function toggleMenu(kind) {
    const mnu = S.el.menu;
    if (!mnu.classList.contains('hidden') && mnu.dataset.kind === kind) { mnu.classList.add('hidden'); return; }
    mnu.dataset.kind = kind; mnu.innerHTML = '';
    const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { mnu.classList.add('hidden'); fn(); }; mnu.appendChild(b); };
    if (kind === 'flood') {
      add('🌧️ A 10-year flood', () => callFlood(10)); add('⛈️ A 50-year flood', () => callFlood(50)); add('🌊 A 100-year flood', () => callFlood(100));
      add('☀️ A dry year', () => { S.play = false; const was = S.model.p.climate; S.model.p.climate = 0.6; runYears(1).then(() => { S.model.p.climate = was; applySettings(); }); });
      add('🏞️ The big river drops 3 ft', () => { S.model.baseLevel(0.9); journal('The big river at the valley’s mouth cut down 3 feet. A wave of digging will work its way up the creek.'); S.model.nodes.forEach(markPower); redraw(); });
    } else {
      add(S.ghostOn ? '👻 Hide where the creek used to run' : '👻 Show where the creek used to run', () => { S.ghostOn = !S.ghostOn; redraw(); });
      add('📓 Valley journal' + (Object.keys(S.badges).length ? ' · 🏅' + Object.keys(S.badges).length : ''), () => showJournal());
      add('⏩ One year', () => { S.play = false; runYears(1); });
      add('🏠 Show me my ranch', () => goRanch());
      add('🧭 Fit the whole valley', () => { fitAll(); });
      add('🔄 Bring the changes to my ranch map', () => confirmApply());
      add('🔁 Start the valley over', () => { S.play = false; newModel(); fitAll(); renderAll(); showToast('A fresh valley.'); });
      add('🧭 Reading the map', () => readingTheMap());
      add('ℹ️ What is this?', () => explain());
    }
    mnu.classList.remove('hidden');
  }
  function callFlood(T) { S.play = false; S.force = { T }; return runYears(1).then(() => { setLens('flood'); showToast('A ' + T + '-year flood roared through. Switch the view to see what it did.', 5200); }); }

  function setLens(id, byUser) {
    S.lens = id; document.querySelectorAll('#rvLens .chip').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    renderTop(); redraw();
    const l = LENSES.find((q) => q.id === id); if (byUser && l) showToast(l.toast, 5200);
  }
  function setTool(id) {
    S.tool = id; document.querySelectorAll('#rvTools .tool').forEach((b) => b.classList.toggle('sel', b.dataset.id === id));
    S.el.help.textContent = toolDef(id).help; S.el.map.style.cursor = id === 'look' ? 'grab' : 'crosshair';
  }

  // ------------------------------------------------------------------------------------------------
  // Input: one finger is the tool, two fingers (or the wheel, or a right drag) move the map
  function wireInput(cv) {
    const P = S.pointers;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* a pointer that is already gone */ }
      S.el.menu.classList.add('hidden');
      const p = pos(e); P.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, btn: e.button, t: performance.now(), moved: 0 });
      if (P.size === 1) { S.multi = false; beginOne(e.pointerId, p, e); } else { S.multi = true; cancelStroke(); }
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const q = P.get(e.pointerId), p = pos(e);
      if (!q) { S.hover = S.tool !== 'look' ? pickNode(p.x, p.y, 18) : null; if (S.tool !== 'look') redraw(); return; }
      const dx = p.x - q.x, dy = p.y - q.y; q.moved = Math.max(q.moved, Math.hypot(p.x - q.sx, p.y - q.sy));
      if (P.size >= 2) {
        const others = [...P.entries()].filter(([id]) => id !== e.pointerId); const o = others[0][1];
        const d0 = Math.hypot(q.x - o.x, q.y - o.y), d1 = Math.hypot(p.x - o.x, p.y - o.y), cx0 = (q.x + o.x) / 2, cy0 = (q.y + o.y) / 2, cx1 = (p.x + o.x) / 2, cy1 = (p.y + o.y) / 2;
        if (d0 > 8) zoomAt(cx1, cy1, d1 / d0);
        S.cam.x -= (cx1 - cx0) / S.cam.scale; S.cam.y -= (cy1 - cy0) / S.cam.scale; clampCam(); q.x = p.x; q.y = p.y; redraw(); return;
      }
      q.x = p.x; q.y = p.y;
      if (q.btn === 1 || q.btn === 2) { S.cam.x -= dx / S.cam.scale; S.cam.y -= dy / S.cam.scale; clampCam(); redraw(); return; }
      moveOne(q, p);
    });
    const end = (e) => {
      const q = P.get(e.pointerId); if (!q) return; const p = pos(e);
      P.delete(e.pointerId);
      if (P.size === 0 && q) endOne(q, p, e.type === 'pointercancel');
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))); redraw(); }, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  function zoomAt(px, py, f) {
    const wx = s2wx(px), wy = s2wy(py); S.cam.scale = clamp(S.cam.scale * f, minScale(), 4);
    S.cam.x = wx - (px - S.w / 2) / S.cam.scale; S.cam.y = wy - (py - S.h / 2) / S.cam.scale; clampCam();
  }
  const minScale = () => Math.min(S.w / (GEO.W * 1.15), S.h / (GEO.H * 1.05));
  function clampCam() { S.cam.x = clamp(S.cam.x, -300, GEO.W + 300); S.cam.y = clamp(S.cam.y, -300, GEO.H + 300); }

  function beginOne(id, p, e) {
    const q = S.pointers.get(id), t = toolDef(S.tool);
    q.pan = false; q.node = null; q.lastX = p.x; q.lastY = p.y;
    if (e.button === 1 || e.button === 2) return;
    if (t.kind === 'look') { q.pan = true; return; }
    const n = pickNode(p.x, p.y, e.pointerType === 'touch' ? 32 : 18);
    if (!n) { q.pan = true; return; }
    q.node = n; S.stroke = { tool: t, start: n, nodes: t.kind === 'point' ? [n] : [n], cost: t.kind === 'point' ? t.cost : 0 };
    S.hover = n; redraw();
  }
  function moveOne(q, p) {
    if (q.pan) {
      const dx = p.x - q.lastX, dy = p.y - q.lastY;
      q.lastX = p.x; q.lastY = p.y;
      S.cam.x -= dx / S.cam.scale; S.cam.y -= dy / S.cam.scale; clampCam(); redraw(); return;
    }
    const st = S.stroke; if (!st || st.tool.kind !== 'stretch') return;
    const n = pickNode(p.x, p.y, 44);
    if (n && n.reach === st.start.reach) { st.nodes = stretchFrom(st.start, n); st.cost = stretchCost(st.tool, st.nodes); S.hover = n; showToast(fmt(st.nodes.reduce((a, b) => a + b.len, 0) * FT) + ' ft · ' + money(st.cost), 900); redraw(); }
  }
  function endOne(q, p, cancelled) {
    const st = S.stroke; S.stroke = null; S.hover = null;
    const tapped = q.moved < 8 && !S.multi;
    if (q.pan) {
      if (tapped && !cancelled) { const n = pickNode(p.x, p.y, 'ontouchstart' in window ? 30 : 16); selectNode(n); if (!n) probeGround(p.x, p.y); }
      redraw(); return;
    }
    if (!st || cancelled || !S.model) { redraw(); return; }
    const t = st.tool;
    if (t.kind === 'point') { useTool(t, null, st.start); }
    else {
      let nodes = st.nodes;
      if (tapped || nodes.length < 2) {
        const k = t.span || 7;
        nodes = (t.id === 'bend' || t.id === 'straight') ? S.model.clearStretch(st.start, k) : st.start.reach.nodes.slice(Math.max(0, st.start.reach.nodes.indexOf(st.start) - k), st.start.reach.nodes.indexOf(st.start) + k + 1);
      }
      useTool(t, nodes, st.start);
    }
    redraw();
  }
  function cancelStroke() { S.stroke = null; S.hover = null; S.pointers.forEach((q) => { q.pan = true; }); redraw(); }

  function selectNode(n) {
    S.sel = n || null; renderInfo(); redraw();
    if (n) S.el.info.classList.toggle('collapsed', window.innerWidth < 900);
  }

  // ------------------------------------------------------------------------------------------------
  // Views, dialogs, open and close
  function resize() {
    const e = S.el, r = e.root.getBoundingClientRect(); S.w = Math.max(1, r.width); S.h = Math.max(1, r.height); S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    e.map.width = Math.round(S.w * S.dpr); e.map.height = Math.round(S.h * S.dpr); e.map.style.width = S.w + 'px'; e.map.style.height = S.h + 'px';
    S.tray = e.tray.offsetHeight; e.root.style.setProperty('--rvtray', S.tray + 'px');
    S.cam.scale = Math.max(S.cam.scale, minScale());
    renderInfo(); redraw();
  }
  function fitAll() { S.cam.x = GEO.W / 2; S.cam.y = GEO.H / 2; S.cam.scale = minScale() * 1.02; redraw(); }
  function goRanch() { S.cam.x = GEO.RX + GEO.RW / 2; S.cam.y = GEO.RY + GEO.RH / 2; S.cam.scale = Math.min(S.w / (GEO.RW * 1.3), (S.h - 260) / (GEO.RH * 1.15)); clampCam(); redraw(); }

  function playLoop() {
    if (!S.play || !S.open) return;
    runYears(1).then(() => { if (S.play && S.open) setTimeout(playLoop, S.speed > 1 ? 0 : 450); });
  }
  async function explain() {
    await ui.card({
      title: 'River scale', html:
        '<p>This is the whole valley your creek runs through, drawn like a map with contour lines every 20 feet. Your ranch is the dashed orange box.</p>' +
        '<p>Press <b>▶</b> or <b>+10 yr</b> and years go by. Floods come, banks wear back, bends slide downstream, and mud builds new floodplain. Tap any stretch of creek to read it.</p>' +
        '<p>The colours (the buttons under the top bar) show health, how far the bed moved, bank height, flood force, plants, stream type, and gravel. Use the tools to plant banks, build rock steps and beaver dam analogs, dig benches, or try new bends. Work you do on the ranch map changes how the creek behaves, and <b>⋯ → Bring the changes to my ranch map</b> carries what happened in the valley back onto your ranch.</p>' +
        '<p><small>It is a toy with real physics in it: tuned to behave the way streams do, not a flood-mapping tool.</small></p>',
      buttons: [{ label: 'Got it' }]
    });
  }
  async function showJournal() {
    const m = S.model, h = m.health();
    const badgeText = { oxbow: 'First oxbow lake', ranch: 'Ranch stretch healed', valley: 'Valley mostly steady or healed', flood: 'A big flood and almost no banks fell' };
    const rows = S.journal.slice().reverse().map((j) => '<tr><td class="n">Yr ' + j.year + '</td><td>' + ui.esc(j.text) + '</td></tr>').join('') || '<tr><td>Nothing yet. Let some years go by.</td></tr>';
    const b = Object.keys(badgeText).map((k) => '<span class="chip' + (S.badges[k] ? ' on' : '') + '" style="margin:2px;display:inline-block">' + (S.badges[k] ? '🏅 ' : '🔒 ') + badgeText[k] + '</span>').join('');
    await ui.card({
      title: 'Valley journal · year ' + m.year,
      html: '<p>' + (m.p.ranchRed > 0.005 ? 'What you do on the ranch reaches the valley: your ranch is cutting flood peaks below it by about ' + Math.round(m.p.ranchRed * 100) + '%. ' : 'Work on the ranch map (swales, ponds, cover, check dams) lowers the flood peaks the creek below your ranch sees. Run a storm there and come back to see it here. ') +
        Math.round(h.main * 100) + '% of the creek is steady or healed. The ranch stretch is at ' + Math.round(h.ranch * 100) + '%. About ' + Math.round(h.cutShare * 100) + '% is still cut down. ' + fmt(h.finesPerYear * 1.3) + ' tons of mud leave the valley in a typical year. You have spent ' + money(S.spent) + ' on creek work.</p><div>' + b + '</div><table class="res small">' + rows + '</table>',
      buttons: [{ label: 'Close' }]
    });
  }
  async function confirmApply() {
    const v = await ui.card({
      title: 'Bring the valley to my ranch map?', text: 'This re-shapes your ranch map’s creek and gullies to match what the valley model did: where the bed dug down or filled, where banks washed back or benches grew, and the mud laid on the floodplain. You can undo it right after.',
      buttons: [{ label: 'Do it', value: 'go' }, { label: 'Not now', value: 'no', alt: true }]
    });
    if (v !== 'go') return;
    const n = applyToRanch();
    showToast(n ? 'Your ranch map now matches. (' + fmt(n) + ' patches of ground changed. Undo is on the ranch map.)' : 'Nothing has changed enough to carry over yet.', 5200);
  }

  async function open() {
    if (!game || !game.ready) return;
    build();
    if (S.open) return;
    S.open = true; S.el.root.classList.remove('hidden'); $('app').classList.add('river-on');
    prevGate = game.frameGate; game.frameGate = (g, dt) => { if (prevGate && prevGate(g, dt) === false) return false; return false; };
    resize();
    if (!S.model) {
      setBusyText('Building the valley…'); await new Promise((r) => setTimeout(r, 30));
      newModel(); S.model.setRanchInputs(ranchInputs()); S.ranchStale = false; makeBackdrop(); fitAll(); setBusyText();
      const firstTime = !Creek.settings || !Creek.settings.get('river.seen', false);
      renderAll(); redraw();
      if (firstTime) { Creek.settings && Creek.settings.set('river.seen', true); explain(); }
    } else { if (S.ranchStale) { S.model.setRanchInputs(ranchInputs()); S.ranchStale = false; } renderAll(); }
    if (!S.backdrop) makeBackdrop();
    if (!S.tile || S.tileStale) { try { makeRanchTile(); } catch (e) { console.warn('[creek] ranch tile', e); } redraw(); }
    game.emit && game.emit('river', true);
  }
  function setBusyText(t) { const b = S.el.busy; if (!b) return; if (t) { b.classList.remove('hidden'); b.firstChild.textContent = t; b.children[1].firstChild.style.width = '0'; } else b.classList.add('hidden'); }
  function close() {
    if (!S.open) return;
    S.open = false; S.play = false; S.cancel = true; S.el.root.classList.add('hidden'); $('app').classList.remove('river-on');
    game.frameGate = prevGate; prevGate = null;
    game.emit && game.emit('river', false);
    game.resize && game.resize();
  }

  // ------------------------------------------------------------------------------------------------
  Creek.registerModule({
    id: 'river',
    init(g, u) {
      game = g; ui = u;
      ui.addButton({ slot: 'view', id: 'btnRiver', label: '🏞️ Valley', title: 'River scale: the whole valley, decades at a time', onClick: () => open() });
      ui.addMenuItem({ label: '🏞️ River scale (the whole valley)', onClick: () => open(), alt: false });
      ui.addSetting({ id: 'river.bend', label: 'How fast bends move', help: 'In the valley view. Real bends take centuries, so the default is sped up.', type: 'choice', options: ['Slow', 'Normal', 'Fast'], default: 'Normal',
        get: () => S.settings.bend, set: (v) => { S.settings.bend = v; Creek.settings && Creek.settings.set('river.bend', v); applySettings(); } });
      ui.addSetting({ id: 'river.climate', label: 'Valley weather', help: 'Wetter years bring bigger floods.', type: 'choice', options: ['Drier', 'Normal', 'Wetter'], default: 'Normal',
        get: () => S.settings.climate, set: (v) => { S.settings.climate = v; Creek.settings && Creek.settings.set('river.climate', v); applySettings(); } });
      if (Creek.settings) { S.settings.bend = Creek.settings.get('river.bend', 'Normal'); S.settings.climate = Creek.settings.get('river.climate', 'Normal'); }
      if (Creek.shortcuts) {
        Creek.shortcuts.add({ key: 'r', desc: 'Open the valley view (River scale)', fn() { if (S.open) close(); else open(); } });
        Creek.shortcuts.add({ key: 'Escape', desc: 'Back to the ranch map', hidden: true, fn() { if (!S.open) return false; close(); } });
      }
      game.on('reset', () => { if (S.open) close(); S.model = null; S.sel = null; S.ranchStale = true; S.tileStale = true; });
      game.on('terrain', () => { S.ranchStale = true; S.tileStale = true; });
      game.on('stormEnd', () => { S.ranchStale = true; });
      game.registerState && game.registerState('river', {
        save() { return S.model ? { model: S.model.toJSON(), journal: S.journal, spent: S.spent, badges: S.badges } : null; },
        load(j) {
          if (!j || !j.model) return;
          try {
            if (!S.valley) S.valley = R.buildValley({ seed: 11 });
            S.model = R.Model.fromJSON(S.valley, j.model); S.journal = j.journal || []; S.spent = j.spent || 0; S.badges = j.badges || {}; S.applied = S.model.snapshotProfile();
            S.ghost = S.valley.reaches.map((r) => r.nodes.map((n) => [n.x, n.y])); applySettings(); S.model.nodes.forEach(markPower); if (S.open) renderAll();
          } catch (e) { console.warn('[creek] could not restore the river model', e); }
        }
      });
      game.on('cash', () => { if (S.open) renderTop(); });
      Creek.river = {
        open, close, isOpen: () => S.open, state: S, model: () => S.model, run: (n) => runYears(n), select: (id) => { const nn = S.model && S.model.byId.get(id); selectNode(nn); return !!nn; },
        setLens, setTool, applyToRanch, fitAll, goRanch, useTool, pickNode, groundH, LENSES, TOOLS, callFlood, render: () => { renderAll(); draw(); }
      };
    },
    ready() { if (S.open) renderTop(); }
  });
})();
