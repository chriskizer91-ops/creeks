/* The land, as plain numbers. No drawing and no GPU in here.
   generateWorld(cellSize) returns flat arrays (one RGBA group per cell):
     T = [ surface height (m), limestone height (m), cover type, growth 0..1 ]
     M = [ soil moisture, soil type (0 clay / 1 loam), organic matter 0..1, field number (0 = none) ]
   plus `meta`: the creeks, the fields, the farmstead, where upstream water arrives.
   Any renderer (the flat map now, a 3D view later) can read the same arrays.

   How the land is made: every creek is a line with a height that falls downstream. Each creek
   "claims" the ground around it (an incised channel, a flat floodplain, then rising hillsides).
   The ground is the lowest of all those claims, so hills, ridges and valleys appear by themselves. */
(function () {
  const C = Creek.CONFIG, CV = C.COVER, W = C.mapW, H = C.mapH;

  function hash(ix, iy) {
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // ---- creek lines ------------------------------------------------------------------------------
  function catmull(ctrl, step) {
    const out = [];
    for (let i = 0; i < ctrl.length - 1; i++) {
      const p0 = ctrl[Math.max(i - 1, 0)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(i + 2, ctrl.length - 1)];
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), n = Math.max(2, Math.round(len / step));
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                  0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
      }
    }
    out.push(ctrl[ctrl.length - 1].slice());
    return out;
  }
  function finishLine(pts) {   // arc length + flat segment arrays for fast nearest-point search
    const n = pts.length, arc = new Float64Array(n), seg = new Float64Array((n - 1) * 5);
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      seg[i * 5] = pts[i][0]; seg[i * 5 + 1] = pts[i][1]; seg[i * 5 + 2] = dx; seg[i * 5 + 3] = dy; seg[i * 5 + 4] = dx * dx + dy * dy || 1e-9;
    }
    return { pts, arc, seg, len: arc[n - 1] };
  }
  function nearest(L, px, py, out) {
    const s = L.seg, n = L.pts.length - 1; let bd = 1e18, ba = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 5, ax = s[o], ay = s[o + 1], dx = s[o + 2], dy = s[o + 3];
      let t = ((px - ax) * dx + (py - ay) * dy) / s[o + 4]; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx - px, qy = ay + t * dy - py, d2 = qx * qx + qy * qy;
      if (d2 < bd) { bd = d2; ba = L.arc[i] + t * Math.sqrt(s[o + 4]); }
    }
    out.d = Math.sqrt(bd); out.arc = ba;
  }

  function buildStreams() {
    // Main creek (flows north → south), with a gentle meander added.
    let main = catmull([[840, -160], [820, 100], [780, 330], [790, 560], [850, 780], [880, 1000], [820, 1220], [780, 1400], [800, 1620]], 22);
    main = main.map(p => [p[0] + 26 * Math.sin(p[1] / 115 + 0.7), p[1]]);
    const M = finishLine(main);
    const mainX = (y) => { let best = 0, bd = 1e9; for (let i = 0; i < main.length; i++) { const d = Math.abs(main[i][1] - y); if (d < bd) { bd = d; best = i; } } return main[best][0]; };
    const o = {}; nearest(M, mainX(0), 0, o); const arc0 = o.arc, slopeMain = 0.0042, zMain = (a) => 32 - slopeMain * (a - arc0);
    const streams = [{
      id: 'main', name: C.creekName, line: M, lineFar: finishLine(main.filter((p, i) => i % 4 === 0 || i === main.length - 1)),
      D: (y) => 2.4 + 0.5 * clamp(y / H, 0, 1), wbed: 5, run: 4.5, fp: 70, Rmax: 16, L: 280, headcut: false, bedSoil: 0, zs: zMain, corr: 60, order: 1
    }];
    const tribs = [
      ['North Draw',      [[330, 120], [450, 200], [560, 290], [680, 350]], 382],
      ['Cedar Draw',      [[240, 640], [380, 690], [520, 730], [660, 765]], 785],
      ['Cottonwood Gully',[[200, 1050], [340, 1110], [500, 1150], [680, 1185]], 1205],
      ['Stock Pond Draw', [[1280, 330], [1150, 380], [1030, 440], [930, 500]], 525],
      ['East Rivulet',    [[1300, 860], [1180, 880], [1080, 910], [970, 950]], 990]
    ];
    tribs.forEach(([name, ctrl, my], k) => {
      const mp = [mainX(my), my], c = ctrl.concat([mp]);
      const pts = catmull(c, 20).map((p, i, a) => [p[0] + (i > 0 && i < a.length - 1 ? 9 * Math.sin(p[0] / 55 + k) : 0), p[1] + (i > 0 && i < a.length - 1 ? 9 * Math.cos(p[1] / 60 + k) : 0)]);
      const L = finishLine(pts), oo = {}; nearest(M, mp[0], mp[1], oo); const zm = zMain(oo.arc), st = 0.018;
      streams.push({
        id: 'trib' + k, name, line: L, lineFar: finishLine(pts.filter((p, i) => i % 4 === 0 || i === pts.length - 1)),
        D: () => 1.7, wbed: 1.4, run: 2.8, fp: 8, Rmax: 11, L: 230, headcut: true, bedSoil: 1.2, zs: (a) => zm + st * (L.len - a), corr: 16, order: 2
      });
    });
    return { streams, mainX };
  }

  // ---- fields ------------------------------------------------------------------------------------
  const FIELD_SEEDS = [
    // name,               x,    y,    starting land use
    ['North Pasture',      380,  200,  'pasture_cont'],
    ['River Bottom West',  690,  230,  'till'],
    ['River Bottom East',  950,  320,  'till'],
    ['Home Pasture',       1050, 120,  'pasture_cont'],
    ['Cedar Hill',         300,  480,  'prairie'],
    ['Cedar Brake',        560,  640,  'woods'],
    ['Oak Motte',          1260, 520,  'woods'],
    ['East Ridge Field',   1130, 700,  'till'],
    ['West Pasture',       400,  880,  'pasture_cont'],
    ['Bottom South West',  700,  1000, 'till'],
    ['Bottom South East',  980,  1110, 'till'],
    ['Southwest Range',    320,  1260, 'prairie'],
    ['South Pasture',      680,  1360, 'pasture_cont'],
    ['SE Field',           1170, 1200, 'till'],
    ['East Pasture',       1200, 330,  'pasture_cont']
  ];

  // ---- everything below can be run on a slab of rows, so web workers can share the job --------------
  function prepare(dx) {
    const nx = Math.round(W / dx), ny = Math.round(H / dx);
    const { streams, mainX } = buildStreams(), nS = streams.length;
    const farm = { x: 1050, y: 230 };
    const padW = 110, padH = 80;
    const rects = { house: [farm.x - 38, farm.y - 28, 24, 13], barn: [farm.x + 8, farm.y - 8, 34, 20], shed: [farm.x - 30, farm.y + 10, 16, 10] };
    const fields = FIELD_SEEDS.map((f, k) => ({ id: k + 1, name: f[0], cx: f[1], cy: f[2], use: f[3], kind: 'field' }));
    const corrMainId = fields.length + 1;
    fields.push({ id: corrMainId, name: C.creekName + ' corridor', cx: 0, cy: 0, use: 'wild', kind: 'corridor' });
    const corrTribIds = {};
    streams.forEach((s, k) => { if (k > 0) { corrTribIds[k] = fields.length + 1; fields.push({ id: fields.length + 1, name: s.name + ' gully', cx: 0, cy: 0, use: 'wild', kind: 'corridor' }); } });
    const o = {}, o2 = {};

    // Stream claims at one point. Fills r = {z, bk, bd, arc, carve, bz, dMain, tn}.
    const evalPoint = (x, y, r) => {
      let best = 1e9, tn = 0, tdb = 1e9;
      for (let k = 0; k < nS; k++) {
        const s = streams[k];
        nearest(s.lineFar, x, y, o);
        let d = o.d, arc = o.arc;
        if (d < 70) { nearest(s.line, x, y, o2); d = o2.d; arc = o2.arc; }
        const zs = s.zs(arc);
        const Deff = s.D(y) * (s.headcut ? sstep(18, 90, arc) : 1);
        let f, carve = 0;
        if (d < s.wbed) { f = 0; carve = Deff; }
        else if (d < s.wbed + s.run) { const t = (d - s.wbed) / s.run; f = Deff * (t * t * (3 - 2 * t)); carve = Deff - f; }
        else {
          f = Deff + 0.004 * (d - s.wbed - s.run);
          if (d > s.fp) f += s.Rmax * (1 - Math.exp(-(d - s.fp) / s.L));
        }
        const z = zs + f;
        if (z < best) { best = z; r.bk = k; r.bd = d; r.arc = arc; r.carve = carve; r.bz = zs; }
        if (k === 0) r.dMain = d; else if (d < s.corr && d < tdb) { tn = k; tdb = d; }
      }
      r.z = best; r.tn = tn;
    };
    // Away from the channels the ground is smooth, so work it out on a coarse grid and blend.
    const CS = 12, cnx = Math.ceil(W / CS) + 2, cny = Math.ceil(H / CS) + 2;
    const cz = new Float32Array(cnx * cny), cbz = new Float32Array(cnx * cny), cbd = new Float32Array(cnx * cny), cdm = new Float32Array(cnx * cny), cbk = new Uint8Array(cnx * cny);
    const rr = {};
    for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
      evalPoint((i - 0.5) * CS, (j - 0.5) * CS, rr); const q = j * cnx + i;
      cz[q] = rr.z; cbz[q] = rr.bz; cbd[q] = rr.bd; cdm[q] = rr.dMain; cbk[q] = rr.bk;
    }
    const bil = (arr, gx, gy, i0, j0) => { const fx = gx - i0, fy = gy - j0, q = j0 * cnx + i0; return (arr[q] * (1 - fx) + arr[q + 1] * fx) * (1 - fy) + (arr[q + cnx] * (1 - fx) + arr[q + cnx + 1] * fx) * fy; };

    // pass 1 for one cell: the raw ground height and facts about the nearest creek
    const R1 = {};
    const cellStream = (i, j) => {
      const x = (i + 0.5) * dx, y = (j + 0.5) * dx;
      const gx = x / CS + 0.5, gy = y / CS + 0.5, i0 = Math.floor(gx), j0 = Math.floor(gy);
      const qd = Math.min(cbd[j0 * cnx + i0], cbd[j0 * cnx + i0 + 1], cbd[(j0 + 1) * cnx + i0], cbd[(j0 + 1) * cnx + i0 + 1]);
      let z, bz, bk, bd, carve, dm, tn;
      if (qd > 26) {
        z = bil(cz, gx, gy, i0, j0); bz = bil(cbz, gx, gy, i0, j0); bd = bil(cbd, gx, gy, i0, j0); dm = bil(cdm, gx, gy, i0, j0);
        bk = cbk[Math.round(gy) * cnx + Math.round(gx)]; carve = 0; tn = 0;
      } else { evalPoint(x, y, rr); z = rr.z; bz = rr.bz; bk = rr.bk; bd = rr.bd; carve = rr.carve; dm = rr.dMain; tn = rr.tn; }
      const damp = clamp((bd - 25) / 60, 0, 1);
      R1.z = z + (vnoise(x / 150, y / 150) - 0.5) * 1.6 * damp + (vnoise(x / 9, y / 9) - 0.5) * 0.16;
      R1.dm = dm; R1.tn = tn; R1.bz = bz; R1.bk = bk; R1.bd = bd; R1.carve = carve;
      R1.wgt = sstep(streams[bk].fp, streams[bk].fp + 160, bd);
    };
    const fz0 = (() => { cellStream(Math.floor(farm.x / dx), Math.floor(farm.y / dx)); return R1.z; })();
    return { nx, ny, dx, streams, mainX, nS, farm, padW, padH, rects, fields, corrMainId, corrTribIds, cellStream, R1, fz0 };
  }

  const SEED_X = Float64Array.from(FIELD_SEEDS.map(f => f[1])), SEED_Y = Float64Array.from(FIELD_SEEDS.map(f => f[2]));
  const SOM_BASE = { till: 0.20, notill: 0.35, prairie: 0.55, pasture_cont: 0.25, pasture_rot: 0.4, woods: 0.6, wild: 0.30 };

  /** Build rows j0..j1-1 of the world. Returns slabs of T and M plus per-field sums. */
  function generateSlab(dx, j0, j1) {
    const P = prepare(dx), { nx, ny, streams, farm, padW, padH, rects, fields, corrMainId, corrTribIds, cellStream, R1, fz0 } = P;
    const hj0 = Math.max(0, j0 - 1), hj1 = Math.min(ny, j1 + 1), hrows = hj1 - hj0;
    const zA = new Float32Array(hrows * nx), zb = new Float32Array(hrows * nx), wg = new Float32Array(hrows * nx), dm = new Float32Array(hrows * nx), bdA = new Float32Array(hrows * nx);
    const carveA = new Float32Array(hrows * nx), bkA = new Uint8Array(hrows * nx), tnA = new Uint8Array(hrows * nx);
    for (let j = hj0; j < hj1; j++) for (let i = 0; i < nx; i++) {
      cellStream(i, j); const c = (j - hj0) * nx + i;
      zA[c] = R1.z; zb[c] = R1.bz; wg[c] = R1.wgt; dm[c] = R1.dm; bdA[c] = R1.bd; carveA[c] = R1.carve; bkA[c] = R1.bk; tnA[c] = R1.tn;
    }
    const rows = j1 - j0, T = new Float32Array(rows * nx * 4), M = new Float32Array(rows * nx * 4);
    const sums = fields.map(() => ({ n: 0, x: 0, y: 0 }));
    const inRect = (r, x, y) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
    const nSeeds = SEED_X.length;
    for (let j = j0; j < j1; j++) for (let i = 0; i < nx; i++) {
      const c = (j - hj0) * nx + i, x = (i + 0.5) * dx, y = (j + 0.5) * dx, k4 = ((j - j0) * nx + i) * 4;
      let z = zA[c];
      const pdx = Math.abs(x - farm.x) - padW / 2, pdy = Math.abs(y - farm.y) - padH / 2;
      if (pdx < 18 && pdy < 18) { const pad = 1 - sstep(0, 18, Math.max(pdx, pdy, 0)); z = z + (fz0 - z) * pad; }
      const jn = Math.max(j - 1, hj0), js = Math.min(j + 1, hj1 - 1);
      const gx = (zA[(j - hj0) * nx + Math.min(nx - 1, i + 1)] - zA[(j - hj0) * nx + Math.max(0, i - 1)]) / (2 * dx);
      const gy = (zA[(js - hj0) * nx + i] - zA[(jn - hj0) * nx + i]) / ((js - jn || 1) * dx);
      const slope = Math.sqrt(gx * gx + gy * gy);
      const st = streams[bkA[c]], bd = bdA[c];
      let sdUp = 1.4 + (vnoise(x / 200, y / 200) - 0.5) - 12 * Math.max(slope - 0.07, 0);
      if (slope > 0.05 && vnoise(x / 45, y / 45) > 0.74) sdUp = 0.05;
      sdUp = clamp(sdUp, 0.05, 2.2);
      const zbd = zb[c] - st.bedSoil;
      let B = zbd + wg[c] * ((z - sdUp) - zbd);
      if (st.id !== 'main' && bd < st.wbed + st.run) B = zbd;
      if (B > z - 0.05 && !(bd < st.wbed + 0.5)) B = z - 0.05;
      if (B > z) B = z;

      const wl = 560 + 130 * (vnoise(y / 260, 3.3) - 0.5) * 2 + 60 * (vnoise(x / 70, y / 70) - 0.5);
      const soil = (x < wl || vnoise(x / 60 + 9, y / 60) > 0.84) ? 1 : 0;

      let fid = 0;
      if (dm[c] < streams[0].corr) fid = corrMainId;
      else if (tnA[c]) fid = corrTribIds[tnA[c]];
      else { let bdist = 1e18; for (let q = 0; q < nSeeds; q++) { const ex = x - SEED_X[q], ey = y - SEED_Y[q], d2 = ex * ex + ey * ey; if (d2 < bdist) { bdist = d2; fid = q + 1; } } }
      if (Math.abs(x - farm.x) < padW / 2 + 20 && Math.abs(y - farm.y) < padH / 2 + 20) fid = 0;

      const f = fid ? fields[fid - 1] : null, use = f ? f.use : 'wild';
      const nz = vnoise(x / 25, y / 25), nz2 = vnoise(x / 8 + 5, y / 8);
      let cover = CV.PASTURE, growth = 0.5, som = f ? SOM_BASE[use] : 0.3;
      if (use === 'till') { cover = CV.CROP; growth = 0.85; }
      else if (use === 'pasture_cont') { cover = CV.PASTURE; growth = 0.35 + 0.15 * nz; if (nz2 > 0.78) { cover = CV.BARE; growth = 0; } }
      else if (use === 'prairie') { cover = CV.PRAIRIE; growth = 0.7 + 0.2 * nz; }
      else if (use === 'woods') { cover = nz2 > 0.86 ? CV.PASTURE : CV.TREE; growth = 0.95; }
      else if (use === 'wild') {
        if (fid === corrMainId && bd > st.wbed + st.run) { cover = nz > 0.45 ? CV.TREE : CV.PASTURE; growth = nz > 0.45 ? 1 : 0.4; }
        else { cover = CV.PASTURE; growth = 0.4; }
      }
      const inChan = bd < st.wbed + st.run + 0.5 && carveA[c] > 0.05;
      if (inChan) { cover = CV.BARE; growth = 0; som = 0.12; }
      let rect = null;
      if (inRect(rects.house, x, y)) rect = 'house'; else if (inRect(rects.barn, x, y)) rect = 'barn'; else if (inRect(rects.shed, x, y)) rect = 'shed';
      if (rect) { cover = CV.ROOF; z = fz0 + 0.6; B = z - 1; growth = 1; }
      else if (Math.abs(x - farm.x) < padW / 2 && Math.abs(y - farm.y) < padH / 2 - 6) { cover = (nz2 > 0.5) ? CV.ROAD : CV.PASTURE; growth = 0.4; }
      const onR1 = Math.abs(x - 1050) < 2.6 && y < farm.y - padH / 2 + 4;
      const onR2 = Math.abs(y - (farm.y + 6)) < 2.6 && x > farm.x + padW / 2 - 4;
      if ((onR1 || onR2) && !inChan) { cover = CV.ROAD; growth = 1; }
      if (!rect && cover !== CV.ROAD) { const wx = x - (farm.x + 62), wy = y - (farm.y - 5); if (wx * wx + wy * wy < 400 && nz2 > 0.3) { cover = CV.TREE; growth = 1; som = 0.5; } }

      T[k4] = z; T[k4 + 1] = Math.min(B, z); T[k4 + 2] = cover; T[k4 + 3] = growth;
      M[k4] = 0.1; M[k4 + 1] = soil; M[k4 + 2] = clamp(som + (nz - 0.5) * 0.1, 0.03, 0.9); M[k4 + 3] = (cover === CV.ROOF || cover === CV.ROAD) ? 0 : fid;
      if (fid && cover !== CV.ROOF && cover !== CV.ROAD) { const s = sums[fid - 1]; s.n++; s.x += x; s.y += y; }
    }
    return { j0, j1, nx, T, M, sums };
  }

  /** The facts about the land that are not per-cell numbers. `sumsList` = per-field sums from every slab. */
  function buildMeta(dx, sumsList) {
    const P = prepare(dx), { streams, mainX, farm, rects, corrTribIds, corrMainId } = P, fields = P.fields;
    fields.forEach((f, k) => {
      let n = 0, sx = 0, sy = 0; sumsList.forEach(s => { n += s[k].n; sx += s[k].x; sy += s[k].y; });
      f.area = n * dx * dx; if (n) { f.cx = sx / n; f.cy = sy / n; }
    });
    fields[corrMainId - 1].cx = mainX(900); fields[corrMainId - 1].cy = 900;
    streams.forEach((s, k) => { if (k > 0) { const m = s.line.pts[Math.floor(s.line.pts.length * 0.4)]; fields[corrTribIds[k] - 1].cx = m[0]; fields[corrTribIds[k] - 1].cy = m[1]; } });
    const samples = [];
    streams.forEach((s, k) => {
      const pts = s.line.pts, step = k === 0 ? 3 : 2;
      for (let i = 2; i < pts.length - 2; i += step) {
        const p = pts[i], a = pts[i - 1], b = pts[i + 1], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
        if (p[1] < 20 || p[1] > H - 20 || p[0] < 20 || p[0] > W - 20) continue;
        if (k > 0 && s.line.arc[i] < 100) continue;
        samples.push({ s: k, x: p[0], y: p[1], nx: -ty / l, ny: tx / l, wb: s.wbed, run: s.run });
      }
    });
    const mainTop = nearestPt(streams[0].line.pts, 4), e2 = Math.max(6, dx * 2);
    return {
      mapW: W, mapH: H, streams: streams.map(s => ({ id: s.id, name: s.name, pts: s.line.pts, wbed: s.wbed, run: s.run })),
      fields, farm, samples, rects,
      sources: {
        main: { x0: mainTop.x - 14, x1: mainTop.x + 14, y0: 0, y1: Math.max(8, dx * 3) },
        top: { x0: 0, x1: W, y0: 0, y1: e2 }, west: { x0: 0, x1: e2, y0: 40, y1: 520 }, east: { x0: W - e2, x1: W, y0: 40, y1: 520 }
      }
    };
  }

  function joinSlabs(dx, slabs) {
    const nx = Math.round(W / dx), ny = Math.round(H / dx);
    slabs.sort((a, b) => a.j0 - b.j0);
    let T, M;
    if (slabs.length === 1) { T = slabs[0].T; M = slabs[0].M; }
    else {
      T = new Float32Array(nx * ny * 4); M = new Float32Array(nx * ny * 4);
      slabs.forEach(s => { T.set(s.T, s.j0 * nx * 4); M.set(s.M, s.j0 * nx * 4); });
    }
    return { nx, ny, dx, T, M, meta: buildMeta(dx, slabs.map(s => s.sums)) };
  }

  function generateWorld(dx) {
    const ny = Math.round(H / dx);
    return joinSlabs(dx, [generateSlab(dx, 0, ny)]);
  }

  /** Same result, built by several web workers at once (falls back to doing it here). */
  function generateWorldAsync(dx, onProgress) {
    const ny = Math.round(H / dx);
    return new Promise((resolve) => {
      const fallback = () => setTimeout(() => resolve(generateWorld(dx)), 20);
      let url = null;
      try {
        const emb = document.getElementById('worker-src');
        url = emb ? URL.createObjectURL(new Blob([emb.textContent], { type: 'text/javascript' })) : 'src/worker.js';
      } catch (e) { return fallback(); }
      const nW = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)), cuts = [];
      for (let k = 0; k <= nW * 2; k++) cuts.push(Math.round(ny * k / (nW * 2)));    // twice as many jobs as workers
      const jobs = []; for (let k = 0; k < nW * 2; k++) jobs.push([cuts[k], cuts[k + 1]]);
      const slabs = [], workers = []; let next = 0, failed = false;
      const done = () => { workers.forEach(w => w.terminate()); if (slabs.length === jobs.length) resolve(joinSlabs(dx, slabs)); };
      try {
        for (let w = 0; w < nW; w++) {
          const wk = new Worker(url); workers.push(wk);
          const feed = () => { if (next < jobs.length) { const j = jobs[next++]; wk.postMessage({ dx, j0: j[0], j1: j[1] }); } };
          wk.onmessage = (e) => { slabs.push(e.data); onProgress && onProgress(slabs.length / jobs.length); if (slabs.length === jobs.length) done(); else feed(); };
          wk.onerror = () => { if (!failed) { failed = true; workers.forEach(x => x.terminate()); fallback(); } };
          feed();
        }
      } catch (e) { failed = true; fallback(); }
    });
  }

  function nearestPt(pts, y) { let b = pts[0], bd = 1e9; pts.forEach(p => { const d = Math.abs(p[1] - y); if (d < bd) { bd = d; b = p; } }); return { x: b[0], y: b[1] }; }

  Creek.generateWorld = generateWorld;
  Creek.generateSlab = generateSlab;
  Creek.generateWorldAsync = generateWorldAsync;
  Creek.sstep = sstep;
})();
