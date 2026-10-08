/* Hydrology lab: learn to read the land by following water.
   Three things, all built on the extension API (docs/EXTENSION_API.md):
     1. The "Water paths" view (lens id "flow"): blue lines show where rain runs. Thicker line = more land draining into it.
     2. The Trace tool (id "trace"): tap a spot and the land that drains to it lights up (its catchment), with the numbers.
     3. The Section tool (id "section"): drag a line across the land and see the side view: soil, limestone, roots, water,
        and how tall the creek banks are where the line crosses Plum Creek.
   This file only READS the land (sim.readTerrain, sim.sampleLine). It owns two small textures for the map drawing code
   (game.extras.flow and game.extras.trace) and a line (game.extras.section). Plain script: no imports, no network.

   How the water paths are worked out (a standard recipe, all on the CPU, in small slices so the screen never freezes):
     a. Squash the surface into a grid of about 4 m cells (average of the finer cells when the level is finer).
     b. Fill the pits (priority-flood with a tiny slope added), so every drop has a way down. The south fence is the only
        open edge, just like in the water engine; the other three edges are walls and water arrives there from upstream.
     c. D8: each cell sends its water to the steepest of its 8 neighbours that is lower.
     d. Walk the cells from high to low adding up how much land drains through each one (flow accumulation).
   The catchment of a spot is found with the same links: cells from low to high, a cell is "in" if its downhill neighbour is. */
(function () {
  const C = Creek.CONFIG;
  const FT = 3.281, ACRE = 4046.856, SQ2 = Math.SQRT2, EPS = 1e-4;
  const COVER_NAMES = ['Bare soil', 'Pasture', 'Native prairie', 'Trees', 'Roof', 'Road', 'Willow', 'Cover crop', 'Check dam', 'Crop field', 'Pond'];
  const COVER_COLORS = ['#c4a574', '#a9c46c', '#d2bc5e', '#3f6b35', '#8a6e5a', '#77736b', '#5f9c6a', '#86c27d', '#8b6a45', '#dcb64c', '#4a8aa3'];
  const ACC_LO = 0.05, ACC_HI = 3000;           // acres: a path starts to show at about 1.4 acres (value 0.3) and the whole creek is nearly 1
  const CHANNEL_ACRES = 2;                      // "this is a stream" when this much land drains through the cell

  const hy = Creek.hydro = { version: 1 };      // also the test hooks
  let game = null, ui = null;

  // ---- numbers in words (acres, feet beside metres)
  const nf = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const mft = (m, d) => { const a = Math.abs(m); if (d == null) d = a >= 100 ? 0 : 1; return nf(m, d) + ' m (' + nf(m * FT, a * FT >= 100 ? 0 : d) + ' ft)'; };
  const cmin = (m) => (Math.abs(m) < 1 ? nf(m * 100) + ' cm (' + nf(m * 39.37) + ' in)' : mft(m, 1));
  const ac = (a) => (a < 0.1 ? 'less than 0.1 acre' : a < 10 ? nf(a, 1) + ' acres' : nf(Math.round(a)) + ' acres');
  const pc = (f) => { const p = f * 100; return p < 1 ? 'less than 1%' : p < 10 ? nf(p, 1) + '%' : nf(Math.round(p)) + '%'; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (t) => (ui && ui.esc ? ui.esc(t) : String(t));

  // ================================================================================================
  //  The model: coarse ground, filled, with downhill links and flow accumulation
  // ================================================================================================
  let model = null, job = null, jobSeq = 0, seenVer = -1, changeT = 0, pumpTimer = 0;

  /** The whole recipe as a generator, so it can run in slices (the driver gives it ~10 ms at a time). */
  function* pipeline(sim, ver, meta) {
    const nx = sim.nx, ny = sim.ny, dx = sim.dx, T = sim.readTerrain();
    const b = Math.max(1, Math.round(3.5 / dx)), cnx = Math.ceil(nx / b), cny = Math.ceil(ny / b), dxc = dx * b, n = cnx * cny;

    // a. the coarse surface
    const z = new Float32Array(n);
    if (b === 1) { for (let k = 0; k < n; k++) z[k] = T[k * 4]; }
    else {
      for (let cj = 0; cj < cny; cj++) {
        const j0 = cj * b, j1 = Math.min(ny, j0 + b);
        for (let ci = 0; ci < cnx; ci++) {
          const i0 = ci * b, i1 = Math.min(nx, i0 + b); let s = 0;
          for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) s += T[(j * nx + i) * 4];
          z[cj * cnx + ci] = s / ((i1 - i0) * (j1 - j0));
        }
        if ((cj & 7) === 7) yield;
      }
    }
    yield;

    // b. fill the pits: priority-flood from the open south edge, each cell at least EPS above the cell it was reached from
    const zf = new Float64Array(n), seen = new Uint8Array(n), order = new Int32Array(n);
    const hk = new Float64Array(n), hi = new Int32Array(n); let hs = 0, on = 0;
    const push = (c, key) => {
      let k = hs++;
      while (k > 0) { const p = (k - 1) >> 1; if (hk[p] <= key) break; hk[k] = hk[p]; hi[k] = hi[p]; k = p; }
      hk[k] = key; hi[k] = c;
    };
    const pop = () => {
      const top = hi[0], key = hk[--hs];
      if (hs > 0) {
        const c = hi[hs]; let k = 0;
        for (;;) {
          let l = 2 * k + 1; if (l >= hs) break;
          if (l + 1 < hs && hk[l + 1] < hk[l]) l++;
          if (hk[l] >= key) break;
          hk[k] = hk[l]; hi[k] = hi[l]; k = l;
        }
        hk[k] = key; hi[k] = c;
      }
      return top;
    };
    for (let i = 0; i < cnx; i++) { const c = (cny - 1) * cnx + i; zf[c] = z[c]; seen[c] = 1; push(c, z[c]); }
    while (hs > 0) {
      const c = pop(); order[on++] = c;
      const ci = c % cnx, cj = (c - ci) / cnx, zc = zf[c] + EPS;
      for (let dj = -1; dj <= 1; dj++) {
        const j = cj + dj; if (j < 0 || j >= cny) continue;
        for (let di = -1; di <= 1; di++) {
          const i = ci + di; if (i < 0 || i >= cnx || (!di && !dj)) continue;
          const q = j * cnx + i; if (seen[q]) continue;
          seen[q] = 1; const v = z[q] > zc ? z[q] : zc; zf[q] = v; push(q, v);
        }
      }
      if ((on & 4095) === 0) yield;
    }
    yield;

    // c. D8: the steepest lower neighbour. The south row is the open edge (-1 = the water leaves the map).
    const rec = new Int32Array(n).fill(-1), pos = new Int32Array(n);
    for (let k = 0; k < n; k++) pos[order[k]] = k;
    for (let cj = 0; cj < cny - 1; cj++) {
      for (let ci = 0; ci < cnx; ci++) {
        const c = cj * cnx + ci, zc = zf[c]; let best = 0, bq = -1;
        for (let dj = -1; dj <= 1; dj++) {
          const j = cj + dj; if (j < 0 || j >= cny) continue;
          for (let di = -1; di <= 1; di++) {
            const i = ci + di; if (i < 0 || i >= cnx || (!di && !dj)) continue;
            const q = j * cnx + i, s = (zc - zf[q]) / (di && dj ? SQ2 : 1);
            if (s > best) { best = s; bq = q; }
          }
        }
        rec[c] = bq;
      }
      if ((cj & 15) === 15) yield;
    }
    yield;

    // d. flow accumulation, from high to low. Every cell is 1 cell of land; the gate where Plum Creek arrives from beyond the fence
    //    carries its share of the upstream acres, so the creek is a thick line from the top of the map.
    const w = new Float64Array(n).fill(1), src = {}, cellAcres = dxc * dxc / ACRE, upAcres = Math.max(0, C.watershedAcres - C.ranchAcres);
    const R = (meta && meta.sources) || {}, split = (C.upstream && C.upstream.split) || {};
    Object.keys(R).forEach((key) => {
      const r = R[key], list = [];
      for (let cj = 0; cj < cny; cj++) {
        const y = (cj + 0.5) * dxc; if (y < r.y0 || y >= r.y1) continue;
        for (let ci = 0; ci < cnx; ci++) { const x = (ci + 0.5) * dxc; if (x >= r.x0 && x < r.x1) list.push(cj * cnx + ci); }
      }
      if (!list.length) list.push(clamp(Math.floor((r.y0 + r.y1) / 2 / dxc), 0, cny - 1) * cnx + clamp(Math.floor((r.x0 + r.x1) / 2 / dxc), 0, cnx - 1));
      src[key] = Int32Array.from(list);
      if (key !== 'main') return;           // only the creek itself arrives as a stream; the rest comes in as thin sheets along the walls, too faint to draw
      const each = (upAcres * (split[key] || 0) / cellAcres) / list.length;
      list.forEach((c) => { w[c] += each; });
    });
    const acc = Float64Array.from(w);
    for (let k = n - 1; k >= 0; k--) { const c = order[k], r = rec[c]; if (r >= 0) acc[r] += acc[c]; }

    return { ver, t: performance.now(), nx: cnx, ny: cny, dx: dxc, b, n, z, zf, rec, order, pos, acc, src, cellAcres, flow: null };
  }

  /** Normalised log of flow accumulation, 0..1 (what the map drawing code reads from game.extras.flow). */
  function flowValues(m) {
    if (m.flow) return m.flow;
    const f = new Float32Array(m.n), l0 = Math.log(ACC_LO), l1 = Math.log(ACC_HI);
    for (let k = 0; k < m.n; k++) f[k] = clamp((Math.log(m.acc[k] * m.cellAcres) - l0) / (l1 - l0), 0, 1);
    return (m.flow = f);
  }

  function pump() {
    const j = job; if (!j) return;
    const t0 = performance.now();
    try {
      while (performance.now() - t0 < 10) {
        const r = j.gen.next();
        if (job !== j) return;
        if (r.done) { job = null; model = r.value; modelReady(); return; }
      }
    } catch (e) { job = null; console.error('[creek] hydro: could not work out the water paths:', e); return; }
    pumpTimer = setTimeout(pump, 0);
  }
  function startBuild() {
    if (job || !game || !game.ready || !game.sim) return;
    const ver = game.terrainVersion;
    let gen; try { gen = pipeline(game.sim, ver, game.world && game.world.meta); } catch (e) { console.error('[creek] hydro:', e); return; }
    job = { gen, token: ++jobSeq, ver };
    clearTimeout(pumpTimer); pumpTimer = setTimeout(pump, 0);
  }
  /** Is anything on the screen using the water paths? Then keep them up to date. */
  function needs() {
    if (!game || !game.ready) return false;
    return flowOn || game.tool === 'trace' || (tr.tap && trPanel && trPanel.visible) || false;
  }

  function modelReady() {
    try {
      if (flowOn) uploadFlow();
      if (tr.tap && trPanel.visible) applyTrace();
      hy.builds = (hy.builds || 0) + 1;
    } catch (e) { console.error('[creek] hydro:', e); }
  }

  /** Called every frame: decide whether the model needs rebuilding (debounced; never mid-storm). */
  function watch(now) {
    if (job) return;
    const v = game.terrainVersion;
    if (v !== seenVer) { seenVer = v; changeT = now; }
    if (model && model.ver === v) return;
    if (!model) startBuild();
    else if (!game.storm && now - changeT >= 400) startBuild();
    else if (game.stroke && !game.storm && now - model.t >= 1500) startBuild();     // while digging, keep up now and then
  }

  // ================================================================================================
  //  GPU textures for the map drawing code (R32F, NEAREST)
  // ================================================================================================
  let flowOn = false, flowTex = null, flowDims = '', traceTex = null, traceDims = '';
  function putTex(old, dims, m, data) {
    const gl = game.gl, key = m.nx + 'x' + m.ny;
    gl.activeTexture(gl.TEXTURE0);
    let t = old;
    if (!t || dims !== key) {
      if (t) gl.deleteTexture(t);
      t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, m.nx, m.ny, 0, gl.RED, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, m.nx, m.ny, gl.RED, gl.FLOAT, data); }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex: t, dims: key };
  }
  function uploadFlow() {
    if (!model || !game.gl) return;
    const r = putTex(flowTex, flowDims, model, flowValues(model)); flowTex = r.tex; flowDims = r.dims;
    game.extras.flow = { tex: flowTex, nx: model.nx, ny: model.ny, dx: model.dx };
  }
  function uploadTrace(mask, x, y) {
    const r = putTex(traceTex, traceDims, model, mask); traceTex = r.tex; traceDims = r.dims;
    game.extras.trace = { tex: traceTex, nx: model.nx, ny: model.ny, dx: model.dx, x, y };
  }
  function freeTextures() {
    const gl = game && game.gl;
    if (gl) { if (flowTex) gl.deleteTexture(flowTex); if (traceTex) gl.deleteTexture(traceTex); }
    flowTex = traceTex = null; flowDims = traceDims = '';
    if (game) { game.extras.flow = null; game.extras.trace = null; }
  }

  // ================================================================================================
  //  Trace: everything that drains to a spot
  // ================================================================================================
  const tr = { tap: null, snapped: false, res: null, dirty: false };
  let trPanel = null, trEls = {};

  /** The cells whose water ends up in cell t, the path from t to the fence, and how much of each gate drains here. */
  function traceCompute(m, t) {
    const n = m.n, mask = new Float32Array(n), order = m.order, rec = m.rec;
    mask[t] = 1; let count = 1;
    for (let k = m.pos[t] + 1; k < n; k++) { const c = order[k], r = rec[c]; if (r >= 0 && mask[r] === 1) { mask[c] = 1; count++; } }
    let c = t, plen = 0;
    while (rec[c] >= 0) {
      const r = rec[c], diag = (r % m.nx) !== (c % m.nx) && Math.floor(r / m.nx) !== Math.floor(c / m.nx);
      plen += diag ? m.dx * SQ2 : m.dx; c = r; mask[c] = 0.5;
    }
    plen += m.dx * 0.5;
    const frac = {};
    Object.keys(m.src).forEach((key) => { const l = m.src[key]; let hit = 0; for (let q = 0; q < l.length; q++) if (mask[l[q]] === 1) hit++; frac[key] = l.length ? hit / l.length : 0; });
    return { t, mask, count, plen, exit: c, frac, drop: m.z[t] - m.z[c], pit: m.zf[t] - m.z[t], area: m.acc[t] * m.cellAcres };
  }

  /** A tap that lands just beside a stream moves onto the stream (fingers are bigger than creeks). */
  function snapCell(m, c) {
    if (m.acc[c] * m.cellAcres >= CHANNEL_ACRES) return c;
    const ci = c % m.nx, cj = (c - ci) / m.nx, R = Math.max(1, Math.round(7 / m.dx)); let best = c, ba = m.acc[c];
    for (let j = Math.max(0, cj - R); j <= Math.min(m.ny - 1, cj + R); j++) for (let i = Math.max(0, ci - R); i <= Math.min(m.nx - 1, ci + R); i++) {
      const q = j * m.nx + i, a = m.acc[q];
      if (Math.hypot(i - ci, j - cj) * m.dx <= 7.5 && a * m.cellAcres >= CHANNEL_ACRES && a > ba && a >= 4 * m.acc[c]) { best = q; ba = a; }
    }
    return best;
  }
  function cellAt(m, x, y) { return clamp(Math.floor(y / m.dx), 0, m.ny - 1) * m.nx + clamp(Math.floor(x / m.dx), 0, m.nx - 1); }

  /** Work out and show the trace for tr.tap. Safe to call at any time; waits for the model if there is none. */
  function applyTrace() {
    tr.dirty = false;
    if (!tr.tap) return;
    if (!model) { traceStatus('Working…'); if (!job) startBuild(); return; }
    const m = model; let c = cellAt(m, tr.tap.x, tr.tap.y);
    const s = tr.snap ? snapCell(m, c) : c; tr.snapped = s !== c; c = s;
    const res = tr.res = traceCompute(m, c);
    const x = tr.snapped ? ((c % m.nx) + 0.5) * m.dx : tr.tap.x, y = tr.snapped ? (Math.floor(c / m.nx) + 0.5) * m.dx : tr.tap.y;
    res.x = x; res.y = y;
    uploadTrace(res.mask, x, y);
    renderTrace();
  }
  /** Public: trace a spot in metres. opts.snap (default false here) moves onto a nearby stream. Returns the result (with .mask). */
  hy.traceAt = function (x, y, opts) {
    opts = opts || {}; tr.tap = { x, y }; tr.snap = !!opts.snap;
    if (isNarrow() && secPanel.visible) secPanel.hide();
    if (!trPanel.visible) trPanel.show();
    if (!model) { traceStatus('Working\u2026'); startBuild(); return null; }
    applyTrace(); return tr.res;
  };

  function traceStatus(text) { if (trEls.body) trEls.body.innerHTML = '<div class="hy-work">' + esc(text) + '</div>' + trEls.how; }
  function renderTrace() {
    if (!trEls.body) return;
    const r = tr.res, m = model; if (!r || !m) return;
    const share = r.count / m.n, acres = r.count * m.cellAcres;
    const up = Math.max(0, C.watershedAcres - C.ranchAcres), sp = C.upstream.split; let beyond = 0;
    Object.keys(r.frac).forEach((k) => { beyond += (sp[k] || 0) * up * r.frac[k]; });
    let h = '<div class="hy-big"><b>' + ac(acres) + '</b> of the ranch drain to this spot <span class="hy-pc">(' + pc(share) + ' of Bluestem Ranch)</span>.</div>';
    if (beyond >= 1) {
      const total = acres + beyond;
      h += '<div class="hy-line hy-up">Water from beyond the fence arrives here too: <b>+' + ac(beyond) + '</b>. All together that is <b>' + ac(total) + '</b>, or <b>' + pc(total / C.watershedAcres) + '</b> of the whole ' + nf(C.watershedAcres) + '-acre watershed.</div>';
    }
    h += '<div class="hy-note">Every drop that lands in the shaded area ends up here.</div>';
    h += '<div class="hy-more">';
    if (tr.snapped) h += '<div class="hy-line">Your tap moved onto the stream beside it.</div>';
    if (r.area >= CHANNEL_ACRES) h += '<div class="hy-line">This is a stream channel: lots of small paths join here.</div>';
    if (r.pit >= 0.15) h += '<div class="hy-line">This spot is a hollow. Water gathers here and fills it about <b>' + mft(r.pit) + '</b> deep before it spills on.</div>';
    h += '<div class="hy-line">From here the water runs about <b>' + mft(r.plen) + '</b> downhill' + (r.drop > 0.05 ? ', dropping <b>' + mft(r.drop) + '</b>,' : '') + ' until it leaves the ranch at the south fence.</div>';
    h += '</div><button class="hy-morebtn" type="button">More \u25BE</button>';
    trEls.body.innerHTML = h + trEls.how;
    trPanel.setTitle('🌧️ Where does the water go?');
    layout();
  }

  // ================================================================================================
  //  Section: a slice through the land
  // ================================================================================================
  const sec = { line: null, prof: null, stat: null, cross: [], ve: 1, veUser: 0, ver: -1, t: 0, hover: -1, drag: null, len: 0, dirty: false, ppx: 1, geom: null };
  let secPanel = null, secEls = {};

  function segHit(ax, ay, bx, by, cx, cy, dx, dy) {          // where does segment a-b cross segment c-d? t along a-b, or -1
    const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy, den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((cx - ax) * s2 - (cy - ay) * s1) / den, u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, sin: Math.abs(den) / (Math.hypot(r1, r2) * Math.hypot(s1, s2) || 1) } : null;
  }
  /** Where the slice crosses a creek, and how tall the banks are on each side. */
  function findCreeks(L, prof, n) {
    const out = [], streams = (game.world && game.world.meta.streams) || [], len = Math.hypot(L.x1 - L.x0, L.y1 - L.y0), sp = len / Math.max(1, n - 1);
    streams.forEach((s, k) => {
      const p = s.pts; let best = null;
      for (let i = 0; i < p.length - 1; i++) {
        const h = segHit(L.x0, L.y0, L.x1, L.y1, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
        if (h && (!best || h.sin > best.sin)) best = h;
      }
      if (!best) return;
      const c = Math.round(best.t * (n - 1)), half = (s.wbed + s.run + (k === 0 ? 16 : 9)) / Math.max(best.sin, 0.3), W = Math.max(2, Math.round(half / sp));
      let bed = c, lo = 1e9;
      for (let i = Math.max(0, c - Math.round(W * 0.4)); i <= Math.min(n - 1, c + Math.round(W * 0.4)); i++) if (prof.h[i] < lo) { lo = prof.h[i]; bed = i; }
      let lt = bed, rt = bed;
      for (let i = Math.max(0, bed - W); i <= bed; i++) if (prof.h[i] > prof.h[lt]) lt = i;
      for (let i = bed; i <= Math.min(n - 1, bed + W); i++) if (prof.h[i] > prof.h[rt]) rt = i;
      out.push({ s: k, name: s.name, bed, lt, rt, left: prof.h[lt] - lo, right: prof.h[rt] - lo, x: best.t * len });
    });
    return out.sort((a, b) => a.x - b.x);
  }

  function analyse(prof, len, n) {
    const sp = len / Math.max(1, n - 1), win = Math.max(1, Math.round(game.sim.dx / Math.max(sp, 1e-6)));
    let hi = -1e9, lo = 1e9, steep = 0, at = 0;
    for (let i = 0; i < n; i++) { hi = Math.max(hi, prof.h[i]); lo = Math.min(lo, prof.h[i]); }
    for (let i = 0; i + win < n; i++) { const s = Math.abs(prof.h[i + win] - prof.h[i]) / (win * sp); if (s > steep) { steep = s; at = i; } }
    return { hi, lo, delta: prof.h[n - 1] - prof.h[0], steep, steepAt: at, deg: Math.atan(steep) * 180 / Math.PI };
  }

  function resample() {
    const L = sec.line; if (!L || !game.ready) return;
    const len = Math.hypot(L.x1 - L.x0, L.y1 - L.y0), n = clamp(Math.round(len / 2.5), 160, 400);
    const prof = game.sim.sampleLine(L.x0, L.y0, L.x1, L.y1, n);
    sec.prof = prof; sec.len = len; sec.n = n; sec.stat = analyse(prof, len, n); sec.cross = findCreeks(L, prof, n);
    sec.ver = game.terrainVersion; sec.t = performance.now(); sec.dirty = false;
    if (!sec.veUser) sec.ve = autoVE();
    renderSection();
  }
  function autoVE() {
    const g = chartGeom(), s = sec.stat; if (!g || !s) return 3;
    const relief = Math.max(s.hi - s.lo, 0.2), avail = g.plotH - 20;
    for (const v of [1, 3, 6]) if (relief * g.ppx * v >= 0.4 * avail) return v;
    return 6;
  }

  function creekText() {
    if (!sec.cross.length) return '';
    let best = sec.cross[0]; sec.cross.forEach((c) => { if (Math.max(c.left, c.right) > Math.max(best.left, best.right)) best = c; });
    const tall = Math.max(best.left, best.right), nm = esc(best.name);
    if (tall < 0.3) return '<div class="hy-creek">\uD83C\uDF0A <b>' + nm + '</b> crosses your line here. Its banks are low, so floods can spread out.</div>';
    const top = best.left >= best.right ? best.lt : best.rt, P = sec.prof, cover = P.cover[top], rd = C.cover.rootDepth[cover] * P.growth[top];
    let roots, short;
    if (rd < 0.05) { roots = 'The top of the bank is bare. No roots hold it, so fast water can dig under it and the bank falls in.'; short = 'The top is bare: nothing holds it, so a flood can dig under it and it falls in.'; }
    else if (rd >= tall * 0.9) { roots = 'Roots reach almost to the bottom of the bank, so they help hold it up.'; short = 'Roots reach almost to the bottom, so they help hold it up.'; }
    else { roots = 'Roots only reach about <b>' + mft(rd) + '</b> down. The rest of the bank has no roots to hold it, so a flood can dig under the top and the bank falls in.'; short = 'Roots reach only <b>' + mft(rd) + '</b>, so a flood can dig under the bank below that.'; }
    return '<div class="hy-creek">\uD83C\uDF0A <b>' + nm + '</b> crosses your line. ' +
      '<span class="hy-long">The bank on the left stands <b>' + mft(best.left) + '</b> above the creek bed and the one on the right <b>' + mft(best.right) + '</b>. ' + roots + '</span>' +
      '<span class="hy-short">Banks: <b>' + mft(best.left) + '</b> left, <b>' + mft(best.right) + '</b> right. ' + short + '</span></div>';
  }

  function renderSection() {
    if (!secEls.stats) return;
    const s = sec.stat, d = s.delta;
    secEls.stats.innerHTML = '<span class="hy-chip">\u2194 <b>' + mft(sec.len) + '</b></span>' +
      '<span class="hy-chip" title="from the start of the line (A) to its end (B)">' + (Math.abs(d) < 0.05 ? '\u2796 level' : (d < 0 ? '\u2198 falls <b>' : '\u2197 rises <b>') + mft(Math.abs(d)) + '</b>') + '</span>' +
      '<span class="hy-chip" title="the steepest bit of the line">\u26F0 <b>' + nf(s.steep * 100, s.steep * 100 < 10 ? 1 : 0) + '%</b> steep (' + nf(s.deg, s.deg < 10 ? 1 : 0) + '\u00B0)</span>';
    secEls.creek.innerHTML = creekText();
    const seen = {}; for (let i = 0; i < sec.n; i++) seen[sec.prof.cover[i]] = 1;
    secEls.legend.innerHTML = Object.keys(seen).map(Number).sort((a, b) => a - b).map((k) => '<span class="hy-sw" style="background:' + COVER_COLORS[k] + '"></span>' + COVER_NAMES[k]).join(' ');
    secEls.ve.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.v === sec.ve));
    if (sec.hover < 0 || sec.hover >= sec.n || !sec.pointing) restRead(); else readAt(sec.hover);
    if (secPanel.visible) layout();
  }

  // ---- the chart
  function chartGeom() {
    const cv = secEls.cv; if (!cv) return null;
    const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return null;
    const padL = 34, padR = 8, padT = 20, padB = 18, plotW = W - padL - padR, plotH = H - padT - padB;
    return { W, H, padL, padR, padT, padB, plotW, plotH, ppx: plotW / Math.max(sec.len || 1, 1) };
  }
  function niceStep(span, want) {
    const raw = span / want, steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (const s of steps) if (s >= raw) return s; return 1000;
  }
  function drawChart() {
    const cv = secEls.cv; if (!cv || !secPanel || !secPanel.visible || secPanel.el.classList.contains('hy-collapsed') || !sec.prof) return;
    const g = chartGeom(); if (!g) return; sec.geom = g;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(g.W * dpr) || cv.height !== Math.round(g.H * dpr)) { cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.H * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, g.W, g.H);
    const P = sec.prof, n = sec.n, len = sec.len, x0 = g.padL, x1 = g.W - g.padR, y0 = g.padT, y1 = g.H - g.padB;
    let zmin = 1e9, zmax = -1e9;
    for (let i = 0; i < n; i++) { zmin = Math.min(zmin, P.bed[i], P.h[i]); zmax = Math.max(zmax, P.h[i] + P.depth[i]); }
    const rel = Math.max(zmax - zmin, 0.3), avail = g.plotH - 18, fit = avail / (rel * g.ppx);
    const ve = Math.min(sec.ve, fit); sec.eff = ve;
    const yOf = (z) => y1 - 12 - (z - zmin) * g.ppx * ve, xOf = (i) => x0 + (n > 1 ? i / (n - 1) : 0) * (x1 - x0);
    sec.yOf = yOf; sec.xOf = xOf;

    // sky
    const sky = ctx.createLinearGradient(0, y0, 0, y1); sky.addColorStop(0, '#d5e6ec'); sky.addColorStop(1, '#f0eee0');
    ctx.fillStyle = sky; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // faint height lines with labels (metres)
    const step = niceStep((y1 - y0 - 12) / (g.ppx * ve), 4), zTop = zmin + (y1 - y0 - 12) / (g.ppx * ve);
    ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (let z = Math.ceil(zmin / step) * step; z <= zTop; z += step) {
      const y = yOf(z); if (y < y0 + 4) break;
      ctx.strokeStyle = 'rgba(59,42,26,.13)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#6b5640'; ctx.fillText(nf(z, step < 1 ? 1 : 0) + ' m', x0 - 3, y);
    }
    // limestone (below the bed line)
    ctx.beginPath(); ctx.moveTo(xOf(0), y1);
    for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(P.bed[i]));
    ctx.lineTo(xOf(n - 1), y1); ctx.closePath(); ctx.fillStyle = '#d9d1bd'; ctx.fill();
    ctx.save(); ctx.clip(); ctx.strokeStyle = 'rgba(120,108,84,.28)'; ctx.lineWidth = 1;
    for (let y = y1 - 4; y > y0; y -= 7) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    ctx.restore();
    // soil (between the surface and the limestone)
    ctx.beginPath(); ctx.moveTo(xOf(0), yOf(P.h[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(P.h[i]));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(P.bed[i]));
    ctx.closePath(); ctx.fillStyle = '#9a7650'; ctx.fill();
    // richer, darker topsoil where there is more organic matter
    for (let i = 0; i < n - 1; i++) {
      const t = Math.min(0.3, Math.max(0, P.h[i] - P.bed[i])); if (t <= 0) continue;
      ctx.fillStyle = 'rgba(50,32,18,' + clamp(P.som[i] * 1.3, 0, 0.85).toFixed(2) + ')';
      ctx.beginPath(); ctx.moveTo(xOf(i), yOf(P.h[i])); ctx.lineTo(xOf(i + 1), yOf(P.h[i + 1])); ctx.lineTo(xOf(i + 1), yOf(P.h[i + 1] - t)); ctx.lineTo(xOf(i), yOf(P.h[i] - t)); ctx.closePath(); ctx.fill();
    }
    // limestone line
    ctx.strokeStyle = '#8f8672'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(P.bed[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
    // roots: how far down the plants reach (root depth when fully grown x how grown they are), never into the rock
    ctx.strokeStyle = 'rgba(38,104,34,.9)'; ctx.lineWidth = 1.3;
    for (let xp = x0 + 1.5; xp < x1; xp += 3) {
      const i = clamp(Math.round((xp - x0) / (x1 - x0) * (n - 1)), 0, n - 1);
      const rd = Math.min(C.cover.rootDepth[P.cover[i]] * P.growth[i], Math.max(0, P.h[i] - P.bed[i]));
      if (rd < 0.02) continue;
      ctx.beginPath(); ctx.moveTo(xp, yOf(P.h[i]) + 1); ctx.lineTo(xp, yOf(P.h[i] - rd)); ctx.stroke();
    }
    // water
    let run = -1;
    for (let i = 0; i <= n; i++) {
      const wet = i < n && P.depth[i] > 0.004;
      if (wet && run < 0) run = i;
      if (!wet && run >= 0) {
        const a = Math.max(0, run - 1), b = Math.min(n - 1, i);
        ctx.beginPath(); ctx.moveTo(xOf(a), yOf(P.h[a]));
        for (let q = a; q <= b; q++) ctx.lineTo(xOf(q), Math.min(yOf(P.h[q] + P.depth[q]), yOf(P.h[q]) - 1.8));       // always a visible sliver
        for (let q = b; q >= a; q--) ctx.lineTo(xOf(q), yOf(P.h[q]));
        ctx.closePath(); ctx.fillStyle = 'rgba(74,138,163,.82)'; ctx.fill(); run = -1;
      }
    }
    // the surface
    ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(P.h[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
    // what covers the ground, as a thin strip along the top
    for (let i = 0; i < n - 1; i++) { ctx.fillStyle = COVER_COLORS[P.cover[i]] || '#999'; ctx.fillRect(xOf(i), 4, xOf(i + 1) - xOf(i) + 0.6, 8); }
    ctx.strokeStyle = 'rgba(59,42,26,.45)'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, 4.5, x1 - x0 - 1, 7);
    // creek crossings
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    sec.cross.forEach((c) => {
      const x = xOf(c.bed); ctx.strokeStyle = 'rgba(36,80,95,.6)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, yOf(P.h[c.bed])); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = 'italic 10px system-ui, sans-serif'; ctx.fillStyle = '#24505f';
      const tw = ctx.measureText(c.name).width; ctx.fillText(c.name, clamp(x, x0 + tw / 2, x1 - tw / 2), 23);
    });
    // distance along the bottom, and the ends
    const ds = niceStep(len, Math.max(2, Math.floor((x1 - x0) / 70)));
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#6b5640'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let d = 0; d <= len + 0.01; d += ds) { const x = x0 + d / len * (x1 - x0); ctx.fillText(nf(d) + (d === 0 ? ' m' : ''), clamp(x, x0 + 6, x1 - 8), g.H - 4); }
    ctx.font = 'bold 11px system-ui, sans-serif'; ctx.fillStyle = '#b5654a'; ctx.textAlign = 'left'; ctx.fillText('A', x0 + 3, y0 + 22); ctx.textAlign = 'right'; ctx.fillText('B', x1 - 3, y0 + 22);
    // the spot being read
    if (sec.hover >= 0 && sec.hover < n) {
      const i = sec.hover, x = xOf(i), y = yOf(P.h[i] + P.depth[i]);
      ctx.strokeStyle = 'rgba(181,101,74,.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#e9a23b'; ctx.strokeStyle = '#3b2a1a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 6.2832); ctx.fill(); ctx.stroke();
    }
    // a note when the chart had to be squeezed to fit
    secEls.vnote.textContent = ve < sec.ve - 0.01 ? '(squeezed to ×' + nf(ve, 1) + ' to fit)' : '';
  }

  function readAt(i) {
    const P = sec.prof; if (!P || i < 0 || i >= sec.n) return;
    sec.hover = i;
    const soil = Math.max(0, P.h[i] - P.bed[i]), cv = P.cover[i], d = P.dist[i];
    const wet = P.depth[i] > 0.01 ? ' · water <b>' + nf(P.depth[i] * 100) + ' cm</b> deep' : '';
    secEls.read.innerHTML = '<b>' + mft(d) + '</b> along · ground <b>' + mft(P.h[i], 1) + '</b> high<br>' + COVER_NAMES[cv] +
      (P.growth[i] > 0 && [1, 2, 3, 6, 7, 9].indexOf(cv) >= 0 ? ' (' + Math.round(P.growth[i] * 100) + '% grown)' : '') + ' · ' + (soil < 0.03 ? 'bare limestone' : 'soil <b>' + cmin(soil) + '</b> deep') + wet;
    // tell the map drawing code where the dot goes
    const L = sec.line, t = sec.n > 1 ? i / (sec.n - 1) : 0;
    if (game.extras.section) game.extras.section.marker = { x: L.x0 + (L.x1 - L.x0) * t, y: L.y0 + (L.y1 - L.y0) * t };
    drawChart();
  }
  /** The spot read when nobody is pointing at the chart: the creek bed if the line crosses a creek, else the middle. */
  function restRead() { readAt(sec.cross.length ? sec.cross[0].bed : Math.floor(sec.n / 2)); }
  function clearRead() { if (sec.prof) restRead(); }

  /** Set the slice line (metres). It shows on the map straight away; the chart follows. */
  function setSection(L, soft) {
    sec.line = { x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y1 }; sec.pointing = false;
    game.extras.section = { x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y1 };
    if (isNarrow() && trPanel.visible) trPanel.hide();
    if (!secPanel.visible) secPanel.show();
    if (soft && sec.prof) sec.dirty = true;          // dragging: the line moves now, the chart follows within a few frames
    else resample();
  }
  hy.setSection = function (x0, y0, x1, y1) { setSection({ x0, y0, x1, y1 }); return sec; };

  // ================================================================================================
  //  Screen layout: the two panels never cover the tool tray or each other
  // ================================================================================================
  let lastTray = 0;
  function layout() {
    if (!game || !trPanel || !secPanel) return;
    const app = document.getElementById('app'), tb = document.getElementById('toolbar'); if (!app || !tb) return;
    const vw = app.clientWidth, vh = app.clientHeight, base = Math.max(110, Math.round(vh - tb.getBoundingClientRect().top + 8));
    const wide = vw >= 900, narrow = vw < 600, tv = trPanel.visible, sv = secPanel.visible, topLimit = narrow ? 200 : 108;
    lastTray = tb.offsetHeight;
    [trPanel, secPanel].forEach((pn) => pn.el.classList.toggle('hy-narrow', narrow));
    secPanel.el.classList.toggle('hy-wide', wide);
    let secH = 0;
    if (sv) {
      const el = secPanel.el, left = wide ? (tv ? 340 : 10) : 10, w = wide ? Math.min(vw - left - 10, 900) : Math.min(vw - 20, 640);
      el.style.left = left + 'px'; el.style.right = 'auto'; el.style.width = w + 'px'; el.style.bottom = base + 'px'; el.style.maxHeight = Math.max(160, vh - base - topLimit) + 'px';
      let ch = wide ? 180 : vw < 420 ? 128 : 160; secEls.cv.style.height = ch + 'px';
      while (narrow && !el.classList.contains('hy-collapsed') && el.scrollHeight > el.clientHeight + 2 && ch > 84) { ch -= 16; secEls.cv.style.height = ch + 'px'; }   // a phone: squeeze the picture rather than scroll
      secH = el.offsetHeight;
    }
    if (tv) {
      const stacked = sv && !wide, el = trPanel.el, bottom = base + (stacked ? secH + 8 : 0), room = vh - bottom - topLimit;
      el.classList.remove('hy-compact', 'hy-autofold');
      el.style.left = '10px'; el.style.right = 'auto'; el.style.bottom = bottom + 'px'; el.style.width = Math.min(320, vw - 20) + 'px'; el.style.maxHeight = Math.max(60, room) + 'px';
      if (stacked && !el.classList.contains('hy-collapsed')) {      // both are open and they do not fit: shrink this one, first to the headline, then to its title
        if (el.scrollHeight > room) el.classList.add('hy-compact');
        if (el.scrollHeight > room) { el.classList.remove('hy-compact'); el.classList.add('hy-autofold'); }
      }
    }
    if (sv) drawChart();
  }

  // ================================================================================================
  //  Building the screen furniture
  // ================================================================================================
  const CSS = [
    '.hy-big{font-size:14.5px;font-family:Georgia,serif;margin:2px 0 4px;line-height:1.35}.hy-big b{color:var(--moss);font-size:17px}.hy-pc{color:var(--ink2);font-size:13px}',
    '.hy-line{margin:3px 0}.hy-line b{color:var(--ink)}',
    '.hy-note{margin:6px 0;padding:6px 9px;border-radius:10px;background:#e3eef2;color:#24505f;font-family:Georgia,serif;font-size:13px}',
    '.hy-work{font-family:Georgia,serif;font-style:italic;color:var(--ink2);padding:6px 0}',
    '.hy-how{margin-top:6px;padding-top:6px;border-top:1px solid #d9ccae;font-size:11.5px;line-height:1.4;color:var(--ink2)}.hy-how b{color:var(--ink)}',
    '.hy-short{display:none}.hy-narrow .hy-short{display:inline}.hy-narrow .hy-long{display:none}.hy-narrow .hy-creek{font-size:12px}.hy-narrow .hy-read{min-height:2.7em;margin:3px 0 1px}.hy-narrow .hy-stats{display:block;line-height:1.45;margin:2px 0}.hy-narrow .hy-chip{font-size:11.5px;padding:0;margin-right:9px;background:none}',
    '.hy-morebtn{display:none;min-height:40px;padding:0 12px;border-radius:999px;background:var(--paper2);font-size:13px}',
    '.hy-narrow .hy-morebtn{display:inline-block}.hy-narrow .hy-more{display:none}.hy-narrow.hy-open .hy-more{display:block}',
    '.panel.hy-compact .hy-more,.panel.hy-compact .hy-how,.panel.hy-compact .hy-note,.panel.hy-compact .hy-morebtn{display:none}',
    '.panel.hy-collapsed .pbody,.panel.hy-autofold .pbody{display:none}',
    '.panel.hy-ghost{opacity:.3;pointer-events:none}',
    '.hy-fold{flex:0 0 auto;margin:-6px 0 -6px auto;width:40px;height:40px;background:transparent;font-size:15px;color:var(--ink2)}',
    '.hy-grid{display:flex;flex-direction:column}.hy-colA,.hy-colB{display:contents}',
    '.hy-wide .hy-grid{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:4px 16px;align-items:start}.hy-wide .hy-colA,.hy-wide .hy-colB{display:block}',
    '.hy-cv{display:block;width:100%;height:150px;touch-action:none;border-radius:10px;background:#eef2e4;cursor:crosshair}',
    '.hy-read{min-height:2.9em;margin:5px 0 2px;font-size:12.5px;line-height:1.45}',
    '.hy-stats{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0}.hy-wide .hy-stats{flex-direction:column;align-items:flex-start}',
    '.hy-chip{display:inline-block;background:var(--paper2);border-radius:999px;padding:3px 9px;font-size:12px}',
    '.hy-creek{margin:4px 0;padding:5px 9px;border-radius:10px;background:#e3eef2;font-size:12.5px;line-height:1.4;color:#24505f}.hy-creek:empty{display:none}.hy-creek b{color:#17414f}',
    '.hy-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:3px 0}',
    '.hy-ve button{min-width:46px;height:40px;border-radius:999px;background:var(--paper2);font-size:14px;font-weight:600}',
    '.hy-ve button.on{background:#fff6dc;outline:2px solid var(--gold)}',
    '.hy-vnote{font-size:11.5px;color:var(--ink2)}',
    '.hy-legend{font-size:11.5px;color:var(--ink2);line-height:1.6}',
    '.hy-sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 3px 0 6px;vertical-align:-1px;border:1px solid rgba(59,42,26,.35)}'
  ].join('');

  const TRACE_HOW = '<div class="hy-how"><b>How to read this:</b> <span class="hy-long">The shaded land is a <i>catchment</i>: all the ground whose rain runs to your spot. Its edge is a ridge, where rain on the other side goes somewhere else. The bright line is where the water goes next.</span><span class="hy-short">Shaded land = a <i>catchment</i>, the ground whose rain runs here. Its edge is a ridge. The bright line is the water\u2019s path.</span></div>';
  const SECTION_HOW = '<b>How to read this:</b> <span class="hy-long">The left side is where your line starts (A). Brown is soil, grey is limestone rock, green lines are roots and blue is water. Slide over the picture to read any spot.</span><span class="hy-short">Left is the start (A). Brown = soil, grey = rock, green = roots, blue = water. Slide to read a spot.</span>';

  function addFold(panel, onChange) {
    const head = panel.el.querySelector('.phead'), x = head.querySelector('.px'), b = document.createElement('button');
    b.className = 'hy-fold'; b.textContent = '▾'; b.title = 'Fold this panel up or down'; b.setAttribute('aria-label', 'Fold this panel up or down');
    b.onclick = () => { const f = panel.el.classList.toggle('hy-collapsed'); b.textContent = f ? '▴' : '▾'; layout(); if (onChange) onChange(f); };
    head.insertBefore(b, x);
  }

  function buildPanels() {
    trPanel = ui.panel({
      id: 'hy-trace', title: '🌧️ Where does the water go?', corner: 'bl', closable: true,
      onShow: () => layout(),
      onHide: () => { tr.tap = null; tr.res = null; game.extras.trace = null; layout(); }
    });
    trEls.how = TRACE_HOW; trEls.body = document.createElement('div'); trPanel.body.appendChild(trEls.body);
    trEls.body.innerHTML = '<div class="hy-work">Tap the map to choose a spot.</div>' + TRACE_HOW;
    addFold(trPanel);

    secPanel = ui.panel({
      id: 'hy-section', title: '✂️ Slice of the land', corner: 'bl', closable: true,
      onShow: () => { layout(); },
      onHide: () => { sec.line = null; sec.prof = null; game.extras.section = null; layout(); }
    });
    const b = secPanel.body;
    b.innerHTML = '<div class="hy-grid"><div class="hy-colA"><canvas class="hy-cv" style="order:1"></canvas><div class="hy-legend" style="order:2"></div><div class="hy-read" style="order:3">Slide your finger or mouse over the picture to read any spot.</div>' +
      '<div class="hy-row" style="order:6"><span class="hy-ve">Stretch: <button data-v="1">×1</button> <button data-v="3">×3</button> <button data-v="6">×6</button></span><span class="hy-vnote"></span></div>' +
      '</div>' +
      '<div class="hy-colB"><div class="hy-stats" style="order:4"></div><div class="hy-creek" style="order:5"></div><div class="hy-how" style="order:7">' + SECTION_HOW + '</div></div></div>';
    secEls = { cv: b.querySelector('canvas'), read: b.querySelector('.hy-read'), stats: b.querySelector('.hy-stats'), creek: b.querySelector('.hy-creek'), ve: b.querySelector('.hy-ve'), vnote: b.querySelector('.hy-vnote'), legend: b.querySelector('.hy-legend') };
    secEls.ve.querySelectorAll('button').forEach((bt) => { bt.onclick = () => { sec.ve = +bt.dataset.v; sec.veUser = sec.ve; renderSection(); }; });
    addFold(secPanel, (folded) => { if (!folded) drawChart(); });
    // reading the chart: mouse hover, or touch and drag
    const idxOf = (e) => { const r = secEls.cv.getBoundingClientRect(), g = sec.geom; if (!g) return -1; const f = (e.clientX - r.left - g.padL) / g.plotW; return clamp(Math.round(f * (sec.n - 1)), 0, sec.n - 1); };
    secEls.cv.addEventListener('pointerdown', (e) => { try { secEls.cv.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } sec.pointing = true; readAt(idxOf(e)); });
    secEls.cv.addEventListener('pointermove', (e) => { sec.pointing = true; readAt(idxOf(e)); });
    secEls.cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { sec.pointing = false; clearRead(); } });
    window.addEventListener('resize', () => { if (secPanel.visible || trPanel.visible) layout(); });
  }

  // ---- the tools
  const isNarrow = () => { const a = document.getElementById('app'); return !!a && a.clientWidth < 600; };
  function trackTrace(world, snap) {
    tr.tap = { x: world.x, y: world.y }; tr.snap = snap;
    if (isNarrow() && secPanel.visible) secPanel.hide();         // a phone has room for one lab panel at a time
    if (!trPanel.visible) trPanel.show();
    if (model) applyTrace(); else { traceStatus('Working…'); startBuild(); }
  }
  const TOOL_TRACE = {
    id: 'trace', icon: '🌧️', label: 'Trace', kind: 'custom', readonly: true, card: 'trace',
    help: 'Tap the land. Everything whose rain runs to that spot lights up.',
    custom: {
      down(g, world) { if (world) trackTrace(world, true); },
      move(g, world) { if (world) { tr.tap = { x: world.x, y: world.y }; tr.snap = true; tr.dirty = true; } },
      up(g, world) { if (world) trackTrace(world, true); else if (tr.tap && model) applyTrace(); },
      cancel() { /* the shading stays; the close button clears it */ }
    }
  };
  const TOOL_SECTION = {
    id: 'section', icon: '✂️', label: 'Section', kind: 'custom', readonly: true, card: 'section',
    help: 'Drag a line across the land to slice it and see the side view.',
    custom: {
      down(g, world, p) {
        sec.drag = null; if (!world) return;
        if (sec.line && secPanel.visible) {                       // grab an end of the line you already have and move just that end
          const a = g.project(sec.line.x0, sec.line.y0), b = g.project(sec.line.x1, sec.line.y1);
          const da = a ? Math.hypot(a.x - p.x, a.y - p.y) : 1e9, db = b ? Math.hypot(b.x - p.x, b.y - p.y) : 1e9;
          if (Math.min(da, db) < 30) { sec.drag = { grab: da <= db ? 0 : 1, p0: p, live: true }; secPanel.el.classList.add('hy-ghost'); return; }
        }
        sec.drag = { start: world, p0: p, live: false };
      },
      move(g, world, p) {
        const d = sec.drag; if (!d || !world) return;
        if (d.grab != null) {
          const L = sec.line; setSection(d.grab === 0 ? { x0: world.x, y0: world.y, x1: L.x1, y1: L.y1 } : { x0: L.x0, y0: L.y0, x1: world.x, y1: world.y }, true); return;
        }
        if (!d.live && Math.hypot(p.x - d.p0.x, p.y - d.p0.y) < 8) return;
        if (Math.hypot(world.x - d.start.x, world.y - d.start.y) < 6) return;
        d.live = true; sec.veUser = 0; secPanel.el.classList.add('hy-ghost'); setSection({ x0: d.start.x, y0: d.start.y, x1: world.x, y1: world.y }, true);
      },
      up(g, world, p, info) {
        const d = sec.drag; sec.drag = null; secPanel.el.classList.remove('hy-ghost');
        if (d && !d.live && info && info.moved < 8) ui.toast('Press and drag to draw a line across the land.');
        else if (d && d.live && sec.line) resample();
      },
      cancel() { sec.drag = null; secPanel.el.classList.remove('hy-ghost'); }
    }
  };

  // ================================================================================================
  //  The module
  // ================================================================================================
  Creek.registerModule({
    id: 'hydro',

    init: function (g, u) {
      game = g; ui = u;
      ui.styles(CSS);
      ui.HOWTO.trace = { title: 'Trace the water', text: 'Tap any spot on the map. The shaded land is everything whose rain runs to that spot, like the hills around a bathtub drain. Its edge is the ridge: rain that falls on the other side goes somewhere else. The bright line shows where the water goes next. Tap Plum Creek and see how much land feeds it!' };
      ui.HOWTO.section = { title: 'Slice the land', text: 'Drag a straight line across the map. You get a side view, as if you cut the ground with a knife and looked at the cut edge: soil on top, limestone rock below, and the roots of the plants. Drag across Plum Creek to see how tall its banks are. Slide your finger over the picture to read any spot. Dig a bank and watch the picture change.' };
      buildPanels();
      ui.addTool(TOOL_TRACE); ui.addTool(TOOL_SECTION);

      // ---- the Water paths view
      g.addLens({
        id: 'flow', label: '💧 Water paths',
        toast: 'Water paths: the blue lines show where rain runs when it hits the ground. A thicker line carries water from more land. Try the Trace tool on one.',
        activate() { flowOn = true; if (model) uploadFlow(); else startBuild(); },
        deactivate() { flowOn = false; g.extras.flow = null; }
      });
      const chip = ui.addButton({ slot: 'view', id: 'hydroPaths', label: '💧 Paths', title: 'Show where the rain runs', toggle: true, onClick: (on) => { g.setLens(on ? 'flow' : 'map'); } });
      g.on('lens', (id) => { if (chip) chip.classList.toggle('on', id === 'flow'); });

      // ---- keys
      const sc = Creek.shortcuts;
      sc.add({ key: 't', desc: 'Trace tool: where does the water from a spot go?', fn: () => { if (!g.ready) return false; ui.pickTool('trace'); } });
      sc.add({ key: 'x', desc: 'Section tool: slice the land and see its side view', fn: () => { if (!g.ready) return false; ui.pickTool('section'); } });
      sc.add({ key: 'w', desc: 'Water paths view on or off', fn: () => { if (!g.ready) return false; g.setLens(g.lensId === 'flow' ? 'map' : 'flow'); } });

      // ---- saved with the ranch: the last trace spot and the slice line
      g.registerState('hydro', {
        save() {
          return { trace: tr.tap ? { x: tr.tap.x, y: tr.tap.y, open: !!trPanel.visible } : null, section: sec.line ? Object.assign({ open: !!secPanel.visible, ve: sec.veUser || 0 }, sec.line) : null };
        },
        load(j) {
          if (!j || !g.ready) return;
          if (j.trace && isFinite(j.trace.x) && isFinite(j.trace.y)) { tr.tap = { x: +j.trace.x, y: +j.trace.y }; tr.snap = true; if (j.trace.open) { trPanel.show(); } applyTrace(); }
          else { if (trPanel.visible) trPanel.hide(); }
          if (j.section && [j.section.x0, j.section.y0, j.section.x1, j.section.y1].every(isFinite) && j.section.open) { sec.veUser = [1, 3, 6].indexOf(j.section.ve) >= 0 ? j.section.ve : 0; if (sec.veUser) sec.ve = sec.veUser; setSection(j.section); }
          else if (secPanel.visible) secPanel.hide();
        }
      });

      // ---- events
      g.on('frame', () => {
        try {
          if (!g.ready) return;
          const now = performance.now(), tp = trPanel.visible, sp = secPanel.visible;
          if (tp || sp) { const th = document.getElementById('toolbar').offsetHeight; if (th !== lastTray) layout(); }
          if (needs()) watch(now);
          if (tr.dirty && model && tp) applyTrace();
          if (sp && sec.line && (sec.dirty || sec.ver !== g.terrainVersion)) {         // the chart follows the line, the land and the water as they change
            if (now - sec.t > (sec.dirty ? 50 : g.storm ? 300 : g.stroke ? 120 : 60)) resample();
          }
        } catch (e) { console.error('[creek] hydro frame:', e); }
      });
      g.on('toolChanged', () => { try { layout(); } catch (e) { /* ignore */ } });
      g.on('reset', () => { try { if (trPanel.visible) trPanel.hide(); if (secPanel.visible) secPanel.hide(); tr.tap = null; sec.line = null; } catch (e) { /* ignore */ } });
    },

    ready: function (g) {
      // a new world (first start, or a new detail level): everything cached from the old one is stale
      clearTimeout(pumpTimer); job = null; model = null; seenVer = -1; freeTextures();
      if (tr.res) { tr.res = null; }
      if (trPanel && trPanel.visible && tr.tap) { traceStatus('Working…'); startBuild(); }
      else if (flowOn) startBuild();
      if (secPanel && secPanel.visible && sec.line) { setSection(sec.line); }
      else if (!secPanel || !secPanel.visible) g.extras.section = null;
    }
  });

  // ---- test hooks
  hy.model = () => model;
  hy.busy = () => !!job;
  hy.lastTrace = () => tr.res;
  hy.rebuild = () => { if (!job) { model = null; startBuild(); } };
  hy.section = () => sec;
  hy.pipeline = pipeline;
})();
