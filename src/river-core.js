/* River scale: the numbers behind the valley view. No drawing and no GPU in here (it runs in Node for tests too).

   WHAT IT IS. A reduced-complexity model of a whole stream system (a 6 x 15 km valley, about 26 km2 of land drained)
   that can be run for decades in a blink. Each stream is a chain of nodes (about every 40 m). A node knows its place
   on the map, its channel (bottom width, bank slope, floodplain level, an inset bench), its bed layers (gravel over
   soft soil over limestone), its bank plants, and its flow. Every simulated year it meets a handful of random floods:
     1. FLOW      peak flow from the drained area (Q = k(T) * A^0.8, fitted to the ranch storm model), then the depth
                  from Manning's equation in a compound channel (channel + bench + floodplain).
     2. BANKS     near-bank shear against soil cohesion and plant roots gives bank retreat (more on the outside of a bend);
                  banks taller than they can stand slump (this is what "incised" means).
     3. BEDLOAD   gravel moves when the shear is above a threshold (Meyer-Peter and Muller); the load adapts to the
                  carrying capacity over an adaptation length, and the bed rises or falls by mass balance (Exner).
                  When the gravel is gone the soft soil and then the limestone are cut, slowly.
     4. FINES     mud is carried through and settles on the floodplain when the water goes overbank.
     5. PLANFORM  the outside of a bend retreats and the inside builds a point bar, so bends migrate; a loop whose
                  neck gets pinched off becomes an oxbow lake.
     6. PLANTS, BENCHES, STAGES  roots grow; slumped soil builds an inset bench; each reach is classed on the
                  Schumm and Harvey channel-evolution stages (I to V) and a simplified Rosgen stream type.
   It is not a flood-mapping tool: it is a toy with real physics in it, tuned to behave the way real streams do.

   Units are SI (metres, seconds, Pa). Coordinates: x east, y south (the same way the ranch map runs).
   Public pieces:  Creek.River.buildValley(opts)  Creek.River.Model  Creek.River.buildDem(valley)  Creek.River.kOfT(T)  */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const Creek = root.Creek = root.Creek || {};
  const R = Creek.River = Creek.River || {};

  const G = 9.81, RHO = 1000, SREL = 1.65, POR = 0.35, HOUR = 3600;
  /** Where things are. The ranch (1400 x 1450 m) sits inside the valley at (RX, RY). */
  const GEO = R.GEO = { W: 6000, H: 15000, RX: 2200, RY: 6600, RW: 1400, RH: 1450, DS: 40 };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /** Small seeded random numbers (state can be saved and restored). */
  function Rng(seed) { this.s = (seed >>> 0) || 1; }
  Rng.prototype.next = function () {
    let t = (this.s += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  R.Rng = Rng;

  // ------------------------------------------------------------------------------------------------
  // Floods. Peak flow per km2^0.8 as a function of the return period T (years). The anchors are the flows the
  // ranch storm model gives for its 1-, 10- and 100-year storms (about 34, 110 and 190 m3/s at 10 km2).
  function kOfT(T) {
    if (T <= 1) return 5.4 * Math.max(T, 0.05);
    const lt = Math.log10(T);
    return lt <= 1 ? 5.4 + 10.4 * lt : 15.8 + 14.2 * (lt - 1);
  }
  R.kOfT = kOfT;
  /** How long a flood of this size keeps its peak "working" on the bed, in hours. */
  const durH = (T) => (T < 1 ? 12 : T < 2 ? 10 : T < 10 ? 8 : 6);
  R.peakQ = (A, T) => kOfT(T) * Math.pow(A, 0.8);
  /** The natural bankfull channel for a drained area (the 1.5-year flood): width and depth in metres. */
  R.natural = function (A, qf) {
    const Q = kOfT(1.5) * Math.pow(Math.max(A, 0.01), 0.8) * (qf || 1);
    return { Q, w: 2.7 * Math.sqrt(Q), d: 0.3 * Math.cbrt(Q) };
  };

  /** Soils (banks and soft beds). tauC = shear needed to start eroding (Pa), kd = bank erodibility (m per Pa per s),
      ks = soft-bed erodibility, Hc = how tall a bare bank can stand (m). */
  const SOIL = [
    { name: 'clay', tauC: 15, kd: 1.5e-7, ks: 2.0e-8, Hc: 1.9 },
    { name: 'loam', tauC: 6, kd: 4.0e-7, ks: 5.0e-8, Hc: 1.5 }
  ];
  R.SOIL = SOIL;
  const KR = 3.4e-10, TAU_ROCK = 60;    // limestone abrasion: m per (Pa^1.5 s), and the shear it needs

  // ------------------------------------------------------------------------------------------------
  // Little geometry helpers
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
  function arcOf(pts) { const a = [0]; for (let i = 1; i < pts.length; i++) a.push(a[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return a; }
  /** Points every `ds` metres along a line (first and last point kept). */
  function resample(pts, ds) {
    const a = arcOf(pts), L = a[a.length - 1], n = Math.max(2, Math.round(L / ds)), out = [];
    let j = 0;
    for (let i = 0; i <= n; i++) {
      const s = L * i / n;
      while (j < pts.length - 2 && a[j + 1] < s) j++;
      const t = (s - a[j]) / Math.max(a[j + 1] - a[j], 1e-9);
      out.push([lerp(pts[j][0], pts[j + 1][0], t), lerp(pts[j][1], pts[j + 1][1], t)]);
    }
    return out;
  }
  function nearestOnLine(pts, arc, x, y) {
    let bd = 1e18, ba = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], ay = pts[i][1], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay, l2 = dx * dx + dy * dy || 1e-9;
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1), qx = ax + t * dx - x, qy = ay + t * dy - y, d2 = qx * qx + qy * qy;
      if (d2 < bd) { bd = d2; ba = arc[i] + t * Math.sqrt(l2); }
    }
    return { d: Math.sqrt(bd), arc: ba };
  }

  // ------------------------------------------------------------------------------------------------
  // Nodes and reaches
  let NODE_ID = 0;
  function mkNode(o) {
    return Object.assign({
      id: ++NODE_ID, reach: null, x: 0, y: 0, down: null, ups: [], len: 40, A: 0.1, aLat: 0, lam: 0.5,
      bed: 0, tAll: 0.3, tSoil: 0.3, fp: 3, wb: 8, m: 1.5, bw: 0, bz: -1e9, Wv: 150,
      D50: 0.03, soil: 0, veg: 0.3, vegT: 0.3, ledge: 1, struct: null, ranch: false, ranchArc: -1,
      supG: 0, supF: 0, landF: 1, qf: 1, ax: 0, ay: 0, anx: 0, any: 1, sin: 1, kap: 0, belowRanch: false,
      S: 0.004, tau: 0, yMax: 0, tauMax: 0, qgOut: 0, qfOut: 0, stage: 'I', type: 'C', ema: { bed: 0, wid: 0 }, hist: [],
      acc: null, _S: 0.004, nC: 0.035, nB: 0.06, nF: 0.1, D50nat: 0.03,
      // working values the flood routine keeps on every node (declared here so all nodes have the same shape, which keeps the model fast)
      _h: null, _S0: 0.004, _dzEv: 0, _fb: 0, _qgLat: 0, _qfLat: 0, _dz: 0, _cut: 0, _cutSoil: false, _shift: 0, _Din: 0, _landMul: 1, _dug: 0, _slumpMud: 0, supFLateral: 0, tau10: 0, _Sw: 0.004, _arr: 0
    }, o);
  }
  /** Depth of the trench below the floodplain (the bank height), at least a little. */
  const trench = (n) => Math.max(n.fp - n.bed, 0.15);
  /** Depth of the inset bench above the bed, or 0 when there is no bench. */
  const benchDepth = (n) => (n.bw > 0.05 ? clamp(n.bz - n.bed, 0, trench(n) - 0.05) : 0);
  /** Top width of the trench (bankfull in a cut-down creek). */
  const topWidth = (n) => n.wb + 2 * n.m * trench(n) + n.bw;

  /** Width of the water surface when the water is `y` deep (trench, bench, then the valley floor). */
  function widthAt(n, y) {
    const Ht = trench(n), Hz = benchDepth(n), m = n.m;
    const yy = Math.min(y, Ht);
    let w = n.wb + 2 * m * yy;
    if (n.bw > 0.05 && yy > Hz) w += n.bw;
    if (y > Ht) w = Math.max(n.Wv, topWidth(n));
    return w;
  }

  /** Flow for a depth y (m) at slope S in the compound channel. Returns {Q, A, P, Qb, Qf, share} (share = fraction of the flow on the floodplain). */
  function conveyance(n, y, S, o) {
    const Ht = trench(n), Hz = benchDepth(n), m = n.m, sq = Math.sqrt(1 + m * m), sS = Math.sqrt(S);
    const y1 = Math.min(y, Ht), nC = n.nC, nB = n.nB, nF = n.nF;
    let A, P, Qb = 0, Qf = 0;
    if (Hz > 0) {
      const wch = n.wb + 2 * m * Hz, yb = Math.min(y1, Hz);
      A = n.wb * yb + m * yb * yb + (y1 > Hz ? wch * (y1 - Hz) : 0);
      P = n.wb + 2 * yb * sq;
      if (y1 > Hz) { const Ab = n.bw * (y1 - Hz), Pb = n.bw + (y1 - Hz); Qb = Ab * Math.pow(Ab / Pb, 2 / 3) * sS / nB; }
    } else { A = n.wb * y1 + m * y1 * y1; P = n.wb + 2 * y1 * sq; }
    if (y > Ht) {
      const yo = y - Ht, wt = topWidth(n);
      A += wt * yo;
      const Wf = Math.max(n.Wv - wt, 4);
      Qf = Math.pow(yo, 5 / 3) * Wf * Math.sqrt(S / Math.max(n.sin, 1)) / nF;
    }
    const Qc = A * Math.cbrt(A * A) / Math.cbrt(P * P) * sS / nC;
    const Q = Qc + Qb + Qf;
    if (o) { o.A = A; o.P = P; o.Qc = Qc; o.Qb = Qb; o.Qf = Qf; }
    return Q;
  }
  /** Water depth for a flow Q: the rating curve always rises, so a safeguarded Newton search (bisection when a step would leave the bracket). */
  function solveDepth(n, Q, S) {
    let lo = 0.002, hi = 0;
    let y = Math.pow(Q * n.nC / (Math.max(n.wb, 0.5) * Math.sqrt(S)), 0.6);        // depth of a wide rectangular channel
    y = clamp(y, 0.01, 50);
    for (let it = 0; it < 40; it++) {
      const f = conveyance(n, y, S) - Q;
      if (f < 0) lo = y; else hi = y;
      if (Math.abs(f) < 1e-4 * Q) return y;
      const dy = Math.max(1e-3 * y, 1e-4), d = (conveyance(n, y + dy, S) - Q - f) / dy;
      let yn = d > 1e-9 ? y - f / d : (hi ? 0.5 * (lo + hi) : y * 1.6);
      if (yn <= lo || (hi && yn >= hi) || !(yn > 0)) yn = hi ? 0.5 * (lo + hi) : Math.max(y * 1.6, lo * 2);
      if (Math.abs(yn - y) < 2e-5) return yn;
      y = yn;
    }
    return y;
  }
  /** Everything about one flow at one node. */
  function hydraulics(n, Q, S) {
    const o = {}, y = solveDepth(n, Q, S);
    conveyance(n, y, S, o);
    const Ht = trench(n);
    const Rch = o.A / Math.max(o.P, 0.1);
    const shareF = o.Qf / Math.max(o.Qc + o.Qb + o.Qf, 1e-9);
    const share = Math.max(shareF, 0);
    // the channel carries less of the flow once the water spills onto the valley floor, so the bed feels less shear
    const tau = RHO * G * Math.min(Rch, y) * S * Math.sqrt(Math.max(1 - 0.8 * share, 0.2));
    const A = o.A, U = Q * (1 - share) / Math.max(A, 0.1);
    return { y, yo: Math.max(y - Ht, 0), U, tau, R: Rch, share, Qover: o.Qf, wTop: widthAt(n, y), Hz: benchDepth(n) };
  }
  R.hydraulics = hydraulics; R.solveDepth = solveDepth; R.conveyance = conveyance;

  /** Roughness from bed gravel and plants. */
  function setRoughness(n) {
    n.nC = 0.026 * Math.pow(n.D50 / 0.03, 1 / 6) + 0.006 * n.veg;
    n.nB = 0.04 + 0.05 * n.veg;
    n.nF = 0.05 + 0.07 * n.veg;
    return n;
  }
  const rockOf = (n) => n.bed - n.tAll - n.tSoil;
  R.rockOf = rockOf; R.trench = trench; R.benchDepth = benchDepth; R.topWidth = topWidth; R.widthAt = widthAt;

  // ------------------------------------------------------------------------------------------------
  // THE VALLEY
  // The ranch creek and its five gullies are the real ones from the ranch map (src/world.js), moved to where the ranch
  // sits in the valley. Upstream and downstream of the ranch the creek and eleven side streams are made here.
  function reachNoise(rng) {
    const p1 = rng.next() * 6.28, p2 = rng.next() * 6.28, p3 = rng.next() * 6.28;
    return (s) => clamp(0.55 + 0.28 * Math.sin(s / 1900 + p1) + 0.2 * Math.sin(s / 700 + p2) + 0.12 * Math.sin(s / 260 + p3), 0.15, 1.2);
  }

  R.buildValley = function (opts) {
    opts = opts || {};
    const rng = new Rng(opts.seed || 11), DS = GEO.DS;
    const rs = Creek.ranchStreams ? Creek.ranchStreams() : null;
    if (!rs) throw new Error('river-core needs src/world.js (Creek.ranchStreams) to be loaded first');
    const toV = (p) => [p[0] + GEO.RX, p[1] + GEO.RY];
    const rMain = rs.streams[0].line.pts.map(toV), rMainArc = arcOf(rMain);

    // ---- main stem: head -> ranch (made here) -> ranch (real) -> confluence (made here)
    const meander = (pts, phase, amp, taper) => pts.map((p, i) => {
      const tp = taper ? taper(i, pts.length) : 1;
      return [p[0] + amp * tp * Math.sin(p[1] / 110 + phase), p[1]];
    });
    const upCtl = [[3250, 250], [2850, 1400], [3300, 2700], [2900, 4000], [3250, 5200], rMain[0]];
    let up = meander(catmull(upCtl, 25), 0.4, 34, (i, n) => sstep(0, 40, n - 1 - i));
    up[up.length - 1] = rMain[0].slice();
    const dnCtl = [rMain[rMain.length - 1], [3350, 9600], [3050, 11200], [3400, 12800], [3200, 14200], [3300, 15000]];
    let dn = meander(catmull(dnCtl, 25), 1.3, 34, (i) => sstep(0, 40, i));
    dn[0] = rMain[rMain.length - 1].slice();
    const mainPts = resample(up.concat(rMain.slice(1)).concat(dn.slice(1)), DS);

    // ---- side streams. Ranch gullies come from the ranch map; the others are made here (head, mouth y, drained-area rate).
    const mainArc = arcOf(mainPts);
    const mainXAt = (y) => { let b = 0, bd = 1e9; for (let i = 0; i < mainPts.length; i++) { const d = Math.abs(mainPts[i][1] - y); if (d < bd) { bd = d; b = i; } } return mainPts[b]; };
    const tribs = [];
    rs.streams.slice(1).forEach((s) => tribs.push({ id: s.id, name: s.name, pts: s.line.pts.map(toV), ranch: true, lam: 0.5, soil: 0 }));
    const made = [
      ['willow', 'Willow Branch', [600, 1200], 2500, 0.55, 1], ['sandy', 'Sandy Creek', [5600, 1800], 3600, 0.55, 0],
      ['cedar', 'Cedar Fork', [500, 3600], 4700, 0.5, 1], ['dry', 'Dry Branch', [5500, 4800], 5700, 0.5, 0],
      ['hackberry', 'Hackberry Draw', [700, 8800], 9700, 0.55, 1], ['bigsandy', 'Big Sandy', [5700, 9200], 10900, 1.0, 0],
      ['mill', 'Mill Branch', [400, 12000], 13100, 0.6, 1]
    ];
    made.forEach(([id, name, head, my, lam, soil], k) => {
      const mp = mainXAt(my), a = head, b = mp;
      const ctl = [a, [lerp(a[0], b[0], 0.35) + (k % 2 ? 90 : -90), lerp(a[1], b[1], 0.35) - 60], [lerp(a[0], b[0], 0.7) + (k % 2 ? -70 : 70), lerp(a[1], b[1], 0.7) + 40], b.slice()];
      tribs.push({ id, name, pts: resample(catmull(ctl, 30), DS), ranch: false, lam, soil });
    });

    // ---- build nodes
    const reaches = [], nodes = [];
    const makeReach = (id, name, pts, props) => {
      const r = Object.assign({ id, name, nodes: [], parent: null, mouth: null, order: 1 }, props);
      pts.forEach((p) => { const n = mkNode({ x: p[0], y: p[1], reach: r }); r.nodes.push(n); nodes.push(n); });
      for (let i = 0; i < r.nodes.length - 1; i++) { r.nodes[i].down = r.nodes[i + 1]; r.nodes[i + 1].ups.push(r.nodes[i]); }
      reaches.push(r); return r;
    };
    const main = makeReach('main', Creek.CONFIG ? Creek.CONFIG.creekName : 'Plum Creek', mainPts, { lam: 0.5, soil: 0, main: true });
    tribs.forEach((t) => {
      const pts = t.ranch ? resample(t.pts, DS) : t.pts;
      // the last point of a tributary sits on the main stem: link to the nearest main node
      let mn = main.nodes[0], bd = 1e18;
      main.nodes.forEach((m) => { const d = (m.x - pts[pts.length - 1][0]) ** 2 + (m.y - pts[pts.length - 1][1]) ** 2; if (d < bd) { bd = d; mn = m; } });
      const body = pts.slice(0, -1);
      const r = makeReach(t.id, t.name, body, { lam: t.lam, soil: t.soil, ranch: !!t.ranch, order: 2 });
      const last = r.nodes[r.nodes.length - 1]; last.down = mn; mn.ups.push(last); r.parent = main; r.mouth = mn;
    });

    // ---- topology: order (upstream first), drained area, lengths
    const outlet = main.nodes[main.nodes.length - 1];
    const order = [], stack = [outlet];
    while (stack.length) { const n = stack.pop(); order.push(n); n.ups.forEach((u) => stack.push(u)); }
    order.reverse();
    const relen = (n) => { n.len = n.down ? Math.hypot(n.down.x - n.x, n.down.y - n.y) : (n.ups[0] ? n.ups[0].len : DS); };
    nodes.forEach(relen);
    order.forEach((n) => { n.aLat = (n.reach.lam || 0.5) * n.len / 1000; n.A = n.aLat + n.ups.reduce((s, u) => s + u.A, 0); });

    // ---- the valley's long, smooth axis (used to keep bends inside the valley floor)
    reaches.forEach((r) => {
      const ns = r.nodes, K = 12;
      ns.forEach((n, i) => {
        // a window that is the same on both sides, so the ends of a stream stay where they are
        const k = Math.min(K, i, ns.length - 1 - i);
        let sx = 0, sy = 0, c = 0;
        for (let j = i - k; j <= i + k; j++) { sx += ns[j].x; sy += ns[j].y; c++; }
        n.ax = sx / c; n.ay = sy / c;
      });
      ns.forEach((n, i) => {
        const a = ns[Math.max(0, i - 3)], b = ns[Math.min(ns.length - 1, i + 3)];
        const tx = b.ax - a.ax, ty = b.ay - a.ay, l = Math.hypot(tx, ty) || 1; n.anx = -ty / l; n.any = tx / l;
      });
    });

    // ---- natural meanders upstream and downstream; the ranch reach keeps its real, nearly straight course
    const frameDist = (n) => (n.y < GEO.RY - 160 ? GEO.RY - 160 - n.y : n.y > GEO.RY + 1620 ? n.y - (GEO.RY + 1620) : 0);
    reaches.forEach((r, ri) => {
      if (r.ranch) return;
      const ph = rng.next() * 6.28; let arc = 0;
      r.nodes.forEach((n, i) => {
        if (i > 0) arc += r.nodes[i - 1].len;
        const nat = R.natural(n.A), lam = clamp(16 * nat.w, 170, 420);
        const Wv0 = clamp(52 * Math.sqrt(n.A) * 0.75, 25, 500), amp = clamp(0.3 * Wv0, 3, 55);
        const w = r.id === 'main' ? sstep(0, 900, frameDist(n)) : sstep(0, 150, arc) * sstep(0, 2, r.nodes.length - 1 - i);
        const off = amp * w * Math.sin(2 * Math.PI * arc / lam + ph);
        n.x = n.ax + n.anx * off; n.y = n.ay + n.any * off;
      });
    });
    nodes.forEach(relen);
    order.forEach((n) => { n.aLat = (n.reach.lam || 0.5) * n.len / 1000; n.A = n.aLat + n.ups.reduce((s, u) => s + u.A, 0); });

    // ---- ranch geometry (real creek) for nodes inside the ranch frame
    const rMainStream = rs.streams[0];
    const inRanchFrame = (n) => n.reach.id === 'main' && n.y >= GEO.RY - 160 && n.y <= GEO.RY + 1620;
    main.nodes.forEach((n) => {
      if (!inRanchFrame(n)) return;
      const o = nearestOnLine(rMain, rMainArc, n.x, n.y);
      n.ranchArc = o.arc; n.ranch = n.y >= GEO.RY && n.y <= GEO.RY + GEO.RH;
    });
    reaches.forEach((r) => { if (r.ranch) r.nodes.forEach((n) => { n.ranch = true; }); });

    // ---- bed profile: slope from drained area (steeper at the heads), integrated up from the outlet, then pinned to the ranch creek
    const slopeOf = (A) => 0.0042 * Math.pow(Math.max(A, 0.05) / 10, -0.4);
    const rel = new Map(); rel.set(outlet, 0);
    for (let i = order.length - 1; i >= 0; i--) {       // downstream first
      const n = order[i]; if (!n.down) { rel.set(n, 0); continue; }
      rel.set(n, rel.get(n.down) + slopeOf((n.A + n.down.A) / 2 * 0.8 + 0.1) * n.len);
    }
    // pin: the real ranch creek has bed z = zs(arc) in ranch heights; match the node at the ranch's top edge
    const topNode = main.nodes.find((n) => n.ranchArc >= 0), arcTop = topNode.ranchArc;
    const zRanch = (arc) => rMainStream.zs(arc);
    const offset = zRanch(arcTop) - rel.get(topNode);
    order.forEach((n) => { n.bed = rel.get(n) + offset; });
    main.nodes.forEach((n) => {
      if (n.ranchArc < 0) return;
      // blend toward the exact ranch profile inside the ranch frame
      const w = sstep(0, 400, Math.min(n.y - (GEO.RY - 160), GEO.RY + 1620 - n.y));
      n.bed = lerp(n.bed, zRanch(n.ranchArc), w);
    });
    // make sure the bed always falls downstream
    for (let i = order.length - 1; i >= 0; i--) { const n = order[i]; if (n.down && n.bed < n.down.bed + 0.0003 * n.len) n.bed = n.down.bed + 0.0003 * n.len; }

    // ---- channel and valley properties
    const noiseBy = {};
    reaches.forEach((r) => { noiseBy[r.id] = reachNoise(rng); });
    const mainNoise = noiseBy.main;
    const arcMain = {}; main.nodes.forEach((n, i) => { arcMain[n.id] = mainArc[i]; });
    const arcRanchTop = arcMain[topNode.id];
    order.forEach((n) => {
      const r = n.reach, isMain = r.id === 'main', nat = R.natural(n.A);
      const s = isMain ? arcMain[n.id] : 0;
      // trench depth D: the creek is cut down in the middle of the valley (the ranch reach worst), healthier at both ends
      let D;
      if (isMain) {
        const dkm = (s - arcRanchTop) / 1000;
        if (n.ranchArc >= 0) {
          const ry = n.y - GEO.RY;
          D = rMainStream.D(clamp(ry, 0, GEO.RH));
        } else if (dkm < 0) D = lerp(nat.d * 1.15, 2.4, sstep(-3.5, 0, dkm));
        else D = lerp(2.9, Math.max(1.3 * nat.d, 1.2), sstep(1.5, 9.5, dkm));
      } else if (r.ranch) D = 1.7 * sstep(0, 90, n.ranchArc >= 0 ? 90 : (r.nodes.indexOf(n) * DS)) + 0.05;
      else D = Math.max(1.1 * nat.d, 0.35);
      if (!isMain && r.ranch) D = Math.max(0.3, 1.7 * sstep(15, 90, r.nodes.indexOf(n) * DS));
      D = Math.max(D, 0.35);
      n.fp = n.bed + D;
      const incised = D > 1.5 * nat.d;
      n.m = isMain && n.ranchArc >= 0 ? 4.5 / D : incised ? 1.7 : 1.4;
      if (!isMain && r.ranch) n.m = 2.8 / Math.max(D, 1);
      const wtop = isMain && n.ranchArc >= 0 ? 19 : incised ? 1.05 * nat.w : nat.w;
      n.wb = isMain && n.ranchArc >= 0 ? 10 : (!isMain && r.ranch ? 2.8 : Math.max(0.4 * nat.w, wtop - 2 * n.m * D));
      if (!isMain && r.ranch) n.wb = 2.8;
      n.Wv = clamp(52 * Math.sqrt(n.A) * (isMain ? 0.45 + 0.9 * mainNoise(s) : 0.7 * noiseBy[r.id](n.id * 7)), 22, 700);
      n.Wv = Math.max(n.Wv, wtop + 8);
      // bed layers: gravel over soft soil over limestone
      if (isMain && n.ranchArc >= 0) { n.tAll = 0.12; n.tSoil = 0; }
      else if (isMain) { n.tAll = 0.25 + 0.55 * sstep(0.8, 2.5, n.A); n.tSoil = 0.5 * sstep(1.0, 3.0, n.A); }
      else if (r.ranch) { n.tAll = 0.1; n.tSoil = 1.2; }
      else { n.tAll = 0.2 + 0.1 * sstep(0.3, 1.0, n.A); n.tSoil = 0.8 * sstep(0.4, 1.8, n.A); }       // a smooth change, so there is no step in the bed to start a headcut
      n.D50 = isMain ? (n.ranchArc >= 0 ? 0.035 : s < arcRanchTop ? 0.06 * Math.exp(-0.00009 * (arcRanchTop - s) * 0) : 0.035 * Math.exp(-0.00006 * (s - arcRanchTop))) : 0.04;
      n.D50 = clamp(n.D50, 0.012, 0.09);
      n.soil = isMain ? (n.x < 3000 ? 1 : 0) : r.soil;
      if (r.ranch) n.soil = 0;
      n.veg = isMain ? (n.ranchArc >= 0 ? 0.25 : s < arcRanchTop ? 0.7 : 0.4) : (r.ranch ? 0.2 : 0.7);
      n.vegT = n.veg;
      n.landF = 1; n.qf = 1;
      setRoughness(n);
    });
    // limestone ledges: hard shelves that hold the bed up (bedrock-controlled knickpoints)
    [0.25, 0.62, 0.8].forEach((f) => {
      const c = Math.round(f * (main.nodes.length - 1));
      for (let i = c - 2; i <= c + 2; i++) { const n = main.nodes[i]; if (!n) continue; n.ledge = 0.12; n.tAll = Math.min(n.tAll, 0.05); n.tSoil = 0; }
    });
    // a plain-spoken name for the ranch nodes' mapping
    const ranchMain = main.nodes.filter((n) => n.ranch);

    return {
      GEO, reaches, nodes, order, outlet, main, ranchMain, topNode, seed: opts.seed || 11,
      ranch: { x: GEO.RX, y: GEO.RY, w: GEO.RW, h: GEO.RH, area: 2.03, exit: ranchMain[ranchMain.length - 1], entry: ranchMain[0] }
    };
  };

  // ------------------------------------------------------------------------------------------------
  // A background picture of the valley's hills (a coarse height grid). The creeks carve themselves in it; the hills are
  // simply "the lowest of the valley floors the nodes make, plus a rise away from them".
  R.buildDem = function (valley, cell) {
    cell = cell || 40;
    const W = GEO.W, H = GEO.H, nx = Math.ceil(W / cell), ny = Math.ceil(H / cell), z = new Float32Array(nx * ny), floor = new Float32Array(nx * ny);
    const per = valley.reaches.map((r) => r.nodes.filter((n, i) => i % 3 === 0 || i === r.nodes.length - 1));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      let best = 1e9, bf = 0;
      for (let r = 0; r < per.length; r++) {
        const ns = per[r]; let bd = 1e18, bn = null;
        for (let k = 0; k < ns.length; k++) { const n = ns[k], d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; bn = n; } }
        const d = Math.sqrt(bd), half = 0.5 * bn.Wv;
        const rise = d > half ? 42 * (1 - Math.exp(-(d - half) / 420)) : 0;
        const v = bn.fp + rise + (d > half ? 0.0015 * (d - half) : 0);
        if (v < best) { best = v; bf = d <= half ? 1 : Math.max(0, 1 - (d - half) / 70); }
      }
      z[j * nx + i] = best + 2.0 * (Math.sin(x / 310) * Math.cos(y / 270)) * (best > 0 ? 1 : 0);
      floor[j * nx + i] = bf;
    }
    return { nx, ny, cell, z, floor };
  };

  // ------------------------------------------------------------------------------------------------
  // THE MODEL
  const STAGES = {
    I: { name: 'Stage I: steady', text: 'The creek is in balance. It can reach its floodplain, so floods spread out and lose their punch.' },
    II: { name: 'Stage II: cutting down', text: 'The bed is dropping. The creek is digging itself into a trench, and the banks are getting taller.' },
    III: { name: 'Stage III: banks falling in', text: 'The banks are too tall to stand, so they slump and the creek gets wider. Mud and gravel go downstream.' },
    IV: { name: 'Stage IV: refilling', text: 'Gravel and mud pile up, the bed rises, and a new floodplain begins to grow inside the old trench.' },
    V: { name: 'Stage V: healed', text: 'A new floodplain has built up inside the trench and plants hold it. Floods can spread out again.' }
  };
  const TYPES = {
    A: 'Steep, rocky and narrow, like a mountain stream.',
    B: 'Moderate slope, a little room for floods, fairly stable.',
    C: 'Winding, with a wide floodplain. Floods spread out. This is a healthy valley creek.',
    E: 'Narrow, deep and very windy, with a wet floodplain. Very productive and very delicate.',
    F: 'Cut down and wide and flat, with no floodplain access. A creek in trouble.',
    G: 'A gully: deep, narrow and cut down. Water is trapped in it.'
  };
  R.STAGES = STAGES; R.TYPES = TYPES;

  /** The 12 kinds of event a typical year is made of, with the expected number per year (used to set the "natural" gravel supply). */
  const REF_EDGES = [0.25, 0.5, 0.8, 1.25, 2, 3.5, 7, 15, 35, 70, 200];

  function cloneNetwork(v) {
    const map = new Map(), reaches = [];
    v.reaches.forEach((r) => { const c = Object.assign({}, r, { nodes: [], parent: null, mouth: null }); reaches.push(c); map.set(r, c); });
    const nodes = [];
    v.nodes.forEach((n) => { const c = Object.assign({}, n, { ema: Object.assign({}, n.ema), hist: n.hist.slice(), struct: n.struct ? Object.assign({}, n.struct) : null, ups: [], down: null, acc: null }); map.set(n, c); nodes.push(c); });
    v.reaches.forEach((r) => { const c = map.get(r); c.nodes = r.nodes.map((n) => map.get(n)); c.parent = r.parent ? map.get(r.parent) : null; c.mouth = r.mouth ? map.get(r.mouth) : null; });
    v.nodes.forEach((n) => { const c = map.get(n); c.reach = map.get(n.reach); c.down = n.down ? map.get(n.down) : null; c.ups = n.ups.map((u) => map.get(u)); });
    return { reaches, nodes, map };
  }

  function Model(valley, opts) {
    opts = opts || {};
    this.valley = valley;
    const net = cloneNetwork(valley);
    this.reaches = net.reaches; this.nodes = net.nodes;
    this.main = net.map.get(valley.main); this.outlet = net.map.get(valley.outlet);
    this.ranchExit = net.map.get(valley.ranch.exit); this.ranchEntry = net.map.get(valley.ranch.entry);
    this.byId = new Map(); this.nodes.forEach((n) => this.byId.set(n.id, n));
    this.rng = new Rng(opts.seed || valley.seed || 11);
    this.year = 0; this.oxbows = []; this.log = []; this.series = [];
    this.p = Object.assign({
      climate: 1,            // wetter (above 1) or drier (below 1) floods
      ranchRed: 0,           // how much the ranch's work lowers peak flows (0..0.3)
      neighborRed: 0,        // how much upstream neighbours' work lowers flows and mud (0..0.3)
      gravelScale: 1, fineScale: 1, kMig: 2.5, kBank: 1, grazing: 0, bedOnly: false
    }, opts.params || {});
    if (opts.natural) this.nodes.forEach((n) => { const nat = R.natural(n.A); if (trench(n) > 1.5 * nat.d) { n.wb = 0.7 * nat.w; n.m = 1.5; n.fp = n.bed + nat.d; n.bw = 0; n.bz = -1e9; n.veg = 0.7; n.vegT = 0.7; n.Wv = Math.max(n.Wv, topWidth(n) + 10); } });
    this._initDerived();
    if (opts.d50) this.nodes.forEach((n) => { if (opts.d50[n.id] != null) n.D50 = opts.d50[n.id]; });
    this.calibrateSupply(opts.d50 ? true : false);
    if (!opts.noCalib) this.applyCalib();
    this.nodes.forEach((n) => { const c = this.classify(n); n.stage = c.stage; n.type = c.type; });
    this.initial = this.snapshotProfile();
  }
  R.Model = Model;
  const P = Model.prototype;

  P._initDerived = function () {
    this._rebuild();
    this.nodes.forEach((n) => { setRoughness(n); });
    this._markBelowRanch();
    this._slopes();
  };
  P._rebuild = function () {
    const order = [], stack = [this.outlet];
    while (stack.length) { const n = stack.pop(); order.push(n); n.ups.forEach((u) => stack.push(u)); }
    order.reverse(); this.order = order;
    this.nodes = order.slice();
    this.nodes.forEach((n) => { this.byId.set(n.id, n); });
    this.reaches.forEach((r) => { r.nodes = r.nodes.filter((n) => this.byId.has(n.id) && n.reach === r); });
  };
  P._markBelowRanch = function () {
    this.nodes.forEach((n) => { n.belowRanch = false; });
    let n = this.ranchExit ? this.ranchExit.down : null;
    while (n) { n.belowRanch = true; n = n.down; }
    this.ranchArea = this.ranchExit ? this.ranchExit.A : 10;
  };
  P._flowFactors = function () {
    const Ar = 2.03, rr = this.p.ranchRed, nr = this.p.neighborRed;
    this.nodes.forEach((n) => { n.qf = clamp(1 - nr - (n.belowRanch ? rr * Ar / Math.max(n.A, Ar) : 0), 0.5, 1.4); n._landMul = n.landF * (1 - 0.6 * nr); });
  };
  /** Bed slope of each node, smoothed over about five nodes so tiny steps do not make wild shear. */
  P._slopes = function (quick) {
    this.reaches.forEach((r) => {
      const ns = r.nodes, raw = ns.map((n) => (n.down ? (n.bed - n.down.bed) / Math.max(n.len, 5) : 0));
      ns.forEach((n, i) => {
        let s = 0, c = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(ns.length - 1, i + 3); j++) { s += raw[j]; c++; }
        const wide = Math.max(s / c, 2e-4);
        // the slope just downstream of this node (so a bump raises its own slope and the flow wears it down: that keeps the bed
        // from forming a saw-tooth), but not wilder than 2.5x the wider slope
        const loc = raw[i];
        n._S = clamp(Number.isFinite(loc) ? loc : wide, 0.4 * wide, 2.5 * wide); n._Sw = wide;
      });
    });
    if (this.outlet.down === null && this.outlet._S < 3e-4 && this.outlet.ups[0]) this.outlet._S = Math.max(this.outlet.ups[0]._S, 3e-4);
    if (!quick) this._sinuosity();
  };
  P._sinuosity = function () {
    this.reaches.forEach((r) => {
      const ns = r.nodes, K = 6;
      ns.forEach((n, i) => {
        const a = ns[Math.max(0, i - K)], b = ns[Math.min(ns.length - 1, i + K)];
        let L = 0; for (let j = Math.max(0, i - K); j < Math.min(ns.length - 1, i + K); j++) L += ns[j].len;
        n.sin = clamp(L / Math.max(Math.hypot(a.x - b.x, a.y - b.y), 10), 1, 4);
      });
    });
  };
  /** Signed curvature of each node (1/m). Smoothed. */
  P._curvature = function () {
    this.reaches.forEach((r) => {
      const ns = r.nodes, k = new Array(ns.length).fill(0);
      for (let i = 1; i < ns.length - 1; i++) {
        const a = ns[i - 1], b = ns[i], c = ns[i + 1];
        const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y, wx = c.x - a.x, wy = c.y - a.y;
        const cr = ux * vy - uy * vx, d = Math.hypot(ux, uy) * Math.hypot(vx, vy) * Math.hypot(wx, wy);
        k[i] = d > 1e-6 ? 2 * cr / d : 0;
      }
      const sm = k.slice();
      for (let pass = 0; pass < 2; pass++) for (let i = 1; i < ns.length - 1; i++) sm[i] = 0.25 * k[i - 1] + 0.5 * k[i] + 0.25 * k[i + 1];
      ns.forEach((n, i) => { n.kap = sm[i]; });
    });
  };

  // ---- the natural gravel supply -------------------------------------------------------------------
  /** A year's worth of floods as 12 classes: low flows plus bins of return period, with the expected number of events per year. */
  function refEvents() {
    const ev = [{ k: 0.4, n: 1, d: 200 }, { k: 1.0, n: 1, d: 80 }];
    for (let i = 0; i < REF_EDGES.length - 1; i++) {
      const T = Math.sqrt(REF_EDGES[i] * REF_EDGES[i + 1]);
      ev.push({ k: kOfT(T), n: 1 / REF_EDGES[i] - 1 / REF_EDGES[i + 1], d: durH(T) });
    }
    return ev;
  }
  const REF_EV = refEvents();
  /** Bed shear (Pa) in each of the reference events for a channel geometry g at slope S. */
  function refTaus(g, A, S) { return REF_EV.map((e) => hydraulics(g, e.k * Math.pow(A, 0.8), S).tau); }
  /** Gravel carrying capacity over an average year (m3, solid) for grain size D, given the event shears. */
  function capYear(taus, wb, D) {
    let vol = 0;
    for (let i = 0; i < taus.length; i++) {
      const th = taus[i] / (SREL * RHO * G * D);
      if (th > 0.045) vol += 8 * Math.pow(th - 0.045, 1.5) * Math.sqrt(SREL * G * D * D * D) * wb * REF_EV[i].d * HOUR * REF_EV[i].n;
    }
    return vol;
  }
  /** Pick each node's gravel supply and grain size so that a natural channel would be exactly in balance:
      the supply is a fixed yield per drained area, and the grain size is the one whose carrying capacity matches the load
      (so the streams get finer downstream, as real ones do). A channel that is cut down is then too strong for its
      supply, which is what makes it dig. */
  P.calibrateSupply = function (keepD50) {
    const Yg = this.p.gravelYield || 18, load = new Map();
    this.order.forEach((n) => {
      n.supG = Yg * n.aLat; n.supF = 100 * n.aLat;
      load.set(n, n.supG + n.ups.reduce((s, u) => s + load.get(u), 0));
    });
    this.order.forEach((n) => {
      const nat = R.natural(n.A), incised = trench(n) > 1.5 * nat.d;
      const g = incised ? setRoughness({ wb: 0.7 * nat.w, m: 1.5, fp: n.bed + nat.d, bed: n.bed, bw: 0, bz: -1e9, Wv: n.Wv, D50: 0.03, veg: 0.7, sin: Math.max(n.sin, 1.1) }) : n;
      const taus = refTaus(g, n.A, n._S), wb = incised ? 0.7 * nat.w : n.wb, L = load.get(n);
      let lo = 0.006, hi = n.A < 1.5 ? 0.3 : 0.15;
      for (let i = 0; i < 24; i++) { const mid = Math.sqrt(lo * hi); if (capYear(taus, wb, mid) > L) lo = mid; else hi = mid; }
      if (!keepD50) n.D50 = Math.sqrt(lo * hi);
      n.D50nat = n.D50;
    });
    this.nodes.forEach(setRoughness);
  };

  /** The standard valley comes with a settled long profile (found by tools/river-calibrate.js): the streams start in balance with their gravel supply. */
  P.applyCalib = function () {
    const C = R.CALIB; if (!C || !C.bed) return;
    this.reaches.forEach((r) => r.nodes.forEach((n, i) => {
      const dz = C.bed[r.id + ':' + i];
      if (dz != null) { n.bed += dz; n.fp += dz; if (n.bz > -1e8) n.bz += dz; }
    }));
    this._slopes();
  };

  // ---- one year ------------------------------------------------------------------------------------
  P._events = function (force) {
    const ev = [{ T: 0.2, k: 0.4, durH: 200 }, { T: 0.5, k: 1.0, durH: 80 }];
    const clim = this.p.climate;
    for (let i = 0; i < 4; i++) {
      const u = Math.max(this.rng.next(), 1e-4), T = Math.min(250, 1 / (4 * u));
      ev.push({ T, k: kOfT(T) * clim, durH: durH(T) });
    }
    if (force) (Array.isArray(force) ? force : [force]).forEach((f) => ev.push({ T: f.T, k: kOfT(f.T) * clim, durH: durH(f.T), forced: true }));
    ev.sort((a, b) => a.k - b.k);
    const tot = ev.reduce((s, e) => s + Math.pow(e.k, 1.5) * e.durH, 0);
    ev.forEach((e) => { e.w = Math.pow(e.k, 1.5) * e.durH / tot; });
    return ev;
  };

  /** Run one year. opts: {force: {T}|[{T}], climate}. Returns a report. */
  P.stepYear = function (opts) {
    opts = opts || {};
    this.year++;
    this._flowFactors(); this._slopes(); this._curvature();
    const ev = this._events(opts.force);
    const rep = { year: this.year, events: ev.map((e) => ({ T: e.T, k: e.k, durH: e.durH, forced: !!e.forced })), peakRanch: 0, peakT: 0, exportGravel: 0, exportFines: 0,
      bankErosion: 0, bedChange: 0, bedErosion: 0, floodplainDep: 0, trapped: 0, failures: [], cutoffs: [], notes: [] };
    this.nodes.forEach((n) => { n.acc = { bed: 0, Eo: 0, Ei: 0, fp: 0, fail: 0, tauMax: 0, yMax: 0, qs: 0, bar: 0, over: 0 }; n.hist.length > 400 && n.hist.shift(); });
    const budget = rep;
    ev.forEach((e) => this._runEvent(e, rep));
    this._yearEnd(rep);
    rep.peakRanch = rep.peakRanch || 0;
    const hh = this.health();
    this.series.push({ year: this.year, peak: rep.peakRanch, exportFines: rep.exportFines, exportGravel: rep.exportGravel, bankErosion: rep.bankErosion, bedErosion: rep.bedErosion, floodplainDep: rep.floodplainDep, trapped: rep.trapped, health: hh.main, ranchHealth: hh.ranch });
    if (this.series.length > 600) this.series.shift();
    return rep;
  };
  P.runYears = function (n, opts, cb) {
    const out = [];
    for (let i = 0; i < n; i++) { const r = this.stepYear(opts); out.push(r); if (cb) cb(r, i); }
    return out;
  };

  /** One flood (or low-flow spell). First every node's flow, depth, shear and bank erosion are worked out (they do not depend on
      the small bed changes during the flood); then the gravel is routed in several short steps, so a scour pit or a bump can
      feed back on the slope before it runs away; then the mud is routed down the system and settles on floodplains. */
  P._runEvent = function (e, rep) {
    const durS = e.durH * HOUR, order = this.order, bedOnly = this.p.bedOnly;
    const landGlobal = this.p.landGlobal || 1;
    // ---- A. flow, shear and banks
    for (let oi = 0; oi < order.length; oi++) {
      const n = order[oi], a = n.acc;
      const Q = e.k * Math.pow(n.A, 0.8) * n.qf;
      const h = hydraulics(n, Q, n._S);
      n._h = h; n._S0 = Math.max(n._S, 1e-5); n._dzEv = 0; n._fb = 0;
      if (n === this.ranchExit && Q > rep.peakRanch) { rep.peakRanch = Q; rep.peakT = e.T; }
      if (h.tau > a.tauMax) a.tauMax = h.tau;
      if (h.y > a.yMax) a.yMax = h.y;
      if (h.share > 0.02) a.over += e.durH;
      n.tau = h.tau;
      const land = n._landMul * landGlobal * Math.pow(this.p.climate, 1.5);
      let qgLat = n.supG * land * this.p.gravelScale * e.w / durS;
      let qfLat = n.supF * land * this.p.fineScale * e.w / durS;
      // ---- banks
      const Ht = trench(n), Hz = benchDepth(n), sc = SOIL[n.soil];
      // a bank holds until the shear passes what its soil and roots can take; where the foot of the bank is lined with the
      // stream's own gravel, that gravel armours it as long as the gravel itself holds still
      const tauC = Math.max(sc.tauC * (1 + 4 * n.veg), 0.9 * 728 * n.D50);
      const curv = Math.min(Math.abs(n.kap) * topWidth(n), 1.2);
      const wallWet = h.y > Hz + 0.05;
      let Eo = 0, Ei = 0;
      if (wallWet && h.tau > 0 && !bedOnly) {
        const tauNB = 0.8 * h.tau;
        const kd = sc.kd * this.p.kBank * (1 + 0.8 * this.p.grazing * (1 - n.veg));
        Eo = Math.min(kd * Math.max(0, tauNB * (1 + 1.6 * curv) - tauC) * durS, 0.6);
        Ei = Math.min(kd * Math.max(0, tauNB * (1 - 0.6 * curv) - tauC) * durS, 0.6);
      }
      a.Eo += Eo; a.Ei += Ei;
      const wallH = Math.max(Ht - Hz, 0.1), bankVol = (Eo + Ei) * wallH * n.len * (1 - POR);
      qfLat += 0.88 * bankVol / durS; qgLat += 0.12 * bankVol / durS;
      rep.bankErosion += bankVol / (1 - POR);
      n._qgLat = qgLat; n._qfLat = qfLat;
    }
    // ---- B. gravel, in short steps
    const nsub = clamp(Math.ceil(e.durH / 1.5), 2, 8), dts = durS / nsub;
    for (let s = 0; s < nsub; s++) {
      if (s > 0) this._slopes(true);
      for (let oi = 0; oi < order.length; oi++) {
        const n = order[oi], a = n.acc, h = n._h, sc = SOIL[n.soil];
        let qgIn = n._qgLat;
        for (let u = 0; u < n.ups.length; u++) qgIn += n.ups[u].qgOut;
        const tau = h.tau * Math.pow(Math.max(n._S, 1e-5) / n._S0, 0.8);
        const th = tau / (SREL * RHO * G * n.D50);
        const qb = th > 0.045 ? 8 * Math.pow(th - 0.045, 1.5) * Math.sqrt(SREL * G * Math.pow(n.D50, 3)) : 0;
        const cap = qb * Math.max(n.wb, 1);
        const f = 1 - Math.exp(-n.len / Math.max(200, 20 * n.wb));      // gravel adapts to the flow over a few hundred metres
        let qgOut = cap * f + qgIn * (1 - f);
        const st = n.struct;
        if (st && st.type === 'pond') {
          const eff = 0.9 * Math.max(0, 1 - st.fill / st.cap);
          const trapped = qgIn * eff; qgOut = qgIn - trapped; st.fill += trapped * dts; rep.trapped += trapped * dts;
        }
        const lock = st && (st.type === 'weir' || st.type === 'bda' || st.type === 'plug');
        const area = (1 - POR) * Math.max(n.wb, 1) * n.len;
        let dz = (qgIn - qgOut) * dts / area;
        if (dz < 0) {
          if (lock) { dz = 0; qgOut = qgIn; }
          else if (-dz > n.tAll) { dz = -n.tAll; qgOut = qgIn + n.tAll * area / dts; }
        }
        // only a thin active layer of gravel moves in one flood
        dz = clamp(dz, -Math.max(0, Math.max(0.04, 1.2 * n.D50) + n._dzEv), Math.max(0, 0.3 - n._dzEv));
        qgOut = Math.max(qgIn - dz * area / dts, 0);
        n._dz = dz;
        // ---- no gravel left to move and the water still has spare strength: cut the soft soil, then the limestone
        n._cut = 0;
        if (n.tAll + dz < 0.03 && cap > qgIn && !lock && !bedOnly) {
          if (n.tSoil > 0.001) {
            const ex = Math.max(0, tau - sc.tauC * 0.8);
            n._cut = Math.min(sc.ks * ex * dts, n.tSoil, 0.3 / nsub); n._cutSoil = true;
          } else {
            n._cut = Math.min(KR * n.ledge * Math.pow(Math.max(0, tau - TAU_ROCK), 1.5) * dts, 0.05 / nsub); n._cutSoil = false;
          }
          qgOut += 0.2 * n._cut * area / dts;
        }
        n.qgOut = qgOut;
        a.qs += qgOut * dts;
        if (n === this.outlet) rep.exportGravel += qgOut * dts;
      }
      // the bed changes for the whole stream at once, then the next step sees the new slopes
      for (let oi = 0; oi < order.length; oi++) {
        const n = order[oi], a = n.acc, area = (1 - POR) * Math.max(n.wb, 1) * n.len;
        n.bed += n._dz; n.tAll = Math.max(n.tAll + n._dz, 0); a.bed += n._dz; n._dzEv += n._dz; rep.bedChange += n._dz * area;
        if (n._cut > 0) {
          n.bed -= n._cut; a.bed -= n._cut;
          if (n._cutSoil) n.tSoil -= n._cut;
          const vol = n._cut * area; n._fb += vol; rep.bedErosion += vol / (1 - POR);
        }
      }
    }
    // ---- C. mud: carried through, and left on the floodplain when the water goes overbank
    for (let oi = 0; oi < order.length; oi++) {
      const n = order[oi], a = n.acc, h = n._h, st = n.struct;
      let qfIn = n._qfLat + 0.8 * n._fb / durS;
      for (let u = 0; u < n.ups.length; u++) qfIn += n.ups[u].qfOut;
      let eps = 0;
      if (h.share > 0.01) eps = clamp(0.25 * h.share, 0, 0.3);
      const dep = eps * qfIn * durS;
      if (dep > 0) {
        const thick = dep / (Math.max(n.Wv - topWidth(n), 8) * n.len * (1 - POR));
        a.fp += thick; rep.floodplainDep += dep;
      }
      let qfOut = qfIn - dep / durS;
      if (st && st.type === 'pond') { const t2 = 0.5 * qfOut * Math.max(0, 1 - st.fill / st.cap); qfOut -= t2; st.fill += t2 * durS; rep.trapped += t2 * durS; }
      n.qfOut = Math.max(qfOut, 0);
      if (n === this.outlet) rep.exportFines += n.qfOut * durS;
    }
  };

  P._yearEnd = function (rep) {
    const p = this.p;
    if (p.bedOnly) { this.nodes.forEach((n) => { n.hist.length = 0; }); return; }
    // ---- walls: mass failure of banks too tall to stand, then width and bench changes
    this.nodes.forEach((n) => {
      const a = n.acc, sc = SOIL[n.soil];
      const Ht = trench(n), Hz = benchDepth(n), wallH = Math.max(Ht - Hz, 0.1);
      const Hc = sc.Hc * (1 + 1.2 * n.veg) * (this.p.wet ? 0.75 : 0.85);
      let fail = 0;
      if (wallH > Hc && a.tauMax > 0.4 * sc.tauC) {
        fail = clamp(0.3 * (wallH - Hc), 0, 0.5) * Math.min(1, a.tauMax / (1.5 * sc.tauC));
        a.fail = fail;
        const V = 0.5 * wallH * fail * 2 * n.len * (1 - POR);       // both banks
        rep.bankErosion += V / (1 - POR);
        // 70% goes off as mud, 30% stays as a wedge at the toe: that is how a bench starts
        const wedge = 0.3 * 0.5 * wallH * fail * 2;                  // m2 of cross-section
        const Hb = Math.max(Hz, 0.35);
        if (n.bw < 0.05) { n.bz = n.bed + Hb; }
        n.bw = Math.min(n.bw + wedge / Hb, 3 * Math.max(n.wb, 4));
        // the rest of the slump widens the trench
        a.Eo += fail; a.Ei += fail;
        n.supFLateral = (n.supFLateral || 0);
        n._slumpMud = 0.7 * V / n.len;                                // (not routed again: it is already in the year's mud budget)
        if (fail > 0.25) rep.failures.push(n.id);
      }
      // ---- width change from bank retreat and point-bar deposition
      let Eo = a.Eo, Ei = a.Ei;
      const curv = Math.min(Math.abs(n.kap) * topWidth(n), 1.2);
      // the outside of the bend retreats by Eo; the inside builds a point bar (Din) that offsets the inside erosion Ei.
      // Both banks moving the same way is a bend migrating; moving apart is the channel widening.
      const eta = 0.95 * (1 - Math.exp(-curv / 0.15)) * (a.bed >= -0.02 ? 1 : 0.5);
      const Din = eta * Eo;
      let dW = Eo - Din + Ei;
      const shift = (Eo + Din - Ei) / 2;
      n._shift = shift * p.kMig; n._Din = Din;
      // point bars take gravel from the bed (a little lowering) when they grow
      if (Din > 0 && n.tAll > 0.05) { const lower = Math.min(0.5 * n.tAll, Din * 0.7 * Math.max(Ht, 0.5) / Math.max(n.wb, 4)); n.bed -= lower; n.tAll -= lower; }
      // plants creep out over the bars of a creek that is not cut down and is quiet: it narrows back toward its natural width
      if (!(Ht > 1.5 * R.natural(n.A).d) && Eo + Ei < 0.04 && n.bw < 0.05) { const wn = R.natural(n.A, n.qf).w; dW -= clamp(0.04 * (topWidth(n) - 1.05 * wn) * n.veg, 0, 0.4); }
      dW = clamp(dW, -0.5, 3);
      if (n.bw > 0.05 && Hz > 0) n.bw = Math.max(0, n.bw + dW); else n.wb = Math.max(0.3 * R.natural(n.A).w, n.wb + dW);
      a.dW = dW;
      // ---- floodplain growth (mud settling on the valley floor)
      n.fp += a.fp;
      // ---- plants on a quiet, cut-down creek trap mud along its edges and start a bench (a "vegetated bar"), so planting heals the creek even when the banks never slump
      if (Ht > Math.max(1.2 * R.natural(n.A).d, R.natural(n.A).d + 0.35) && n.veg > 0.45 && Eo + Ei < 0.05 && !fail && Ht > 0.9) {
        const Hb = clamp(0.3 * Ht, 0.35, 0.9);
        if (n.bw < 0.05) { n.bz = n.bed + Hb; n.bw = 0.5; } else n.bw = Math.min(n.bw + 0.4 * (n.veg - 0.3), 3 * Math.max(n.wb, 4));
      }
      // ---- bench growth: mud settles on a bench inside the trench and it builds up toward the natural bankfull height
      if (n.bw > 0.05) {
        const nat = R.natural(n.A, n.qf), Hzn = benchDepth(n);
        if (Hzn < nat.d * 0.95 && Ht - Hzn > 0.2) { n.bz += (nat.d - Hzn) * (0.03 + 0.05 * n.veg) * Math.min(1, 0.5 + a.over / 40); }
        n.bz = Math.min(n.bz, n.fp - 0.1);
        if (n.bz <= n.bed + 0.05) { n.bw = 0; }          // the bench was buried by bed filling
      }
      // ---- plants grow back where the banks are quiet, and die back where they are being torn up
      const quiet = (a.Eo + a.Ei) < 0.08 && !fail;
      const target = Math.max(n.vegT, quiet ? 0.7 * (1 - 0.5 * p.grazing) : 0.15);
      n.veg = clamp(n.veg + (target - n.veg) * 0.18 - 0.4 * (a.Eo + a.Ei + fail) / Math.max(topWidth(n), 8), 0.02, 1);
      setRoughness(n);
    });
    this.nodes.forEach((n) => { if (n.acc.bed !== undefined) { n.fp = Math.max(n.fp, n.bed + 0.2); } });
    // ---- bed rise and fall: the floodplain level stays; new fines raise it
    // ---- planform
    this._migrate(rep);
    this._cutoffs(rep);
    this._respace();
    this._slopes();
    // ---- structures
    this.nodes.forEach((n) => {
      const st = n.struct; if (!st) return;
      st.age = (st.age || 0) + 1;
      const big = n.acc.tauMax * Math.min(1, n._Sw / Math.max(n._S, 1e-6));        // the step a weir makes steepens its own slope; judge it by the stream's slope
      if (st.type === 'bda' && st.age > st.life) { n.struct = null; rep.notes.push('A beaver dam analog wore out.'); }
      else if ((st.type === 'bda' || st.type === 'weir') && big > st.design) { st.health = (st.health || 1) - 0.5; if (st.health <= 0) { n.struct = null; rep.notes.push('A flood washed out a ' + (st.type === 'bda' ? 'beaver dam analog' : 'rock weir') + '.'); } }
    });
    // ---- stages, types and history
    this.nodes.forEach((n) => {
      const a = n.acc;
      n.ema.bed = 0.7 * n.ema.bed + 0.3 * a.bed;
      n.ema.wid = 0.7 * n.ema.wid + 0.3 * (a.dW || 0);
      n.yMax = a.yMax; n.tauMax = a.tauMax;
      const c = this.classify(n); n.stage = c.stage; n.type = c.type;
      n.hist.push({ y: this.year, bed: n.bed, fp: n.fp, wb: n.wb, bw: n.bw, bz: n.bz, w: topWidth(n), x: n.x, yy: n.y });
    });
  };

  // ---- planform: bends move, loops pinch off, the node spacing is kept even ---------------------------
  /** Bends migrate. The push on the outer bank comes from the curvature of the bend and of the stretch just upstream of it
      (the water arrives still leaning toward last bend's outside), so bends grow and slide downstream, and loops end up
      pinched off. The rate is about 5% of a channel width a year at the most active bend, less where the banks are stiff,
      planted, held by rock or by a structure, and more when the floods are strong. The soil that goes from one bank is laid
      on the other, so this moves the channel without making or losing sediment. */
  P._migrate = function (rep) {
    const kM = this.p.kMig;
    this.reaches.forEach((r) => {
      const ns = r.nodes, N = ns.length; if (N < 6 || r.ranch) return;
      const keff = new Array(N).fill(0); let acc = 0;
      for (let i = 0; i < N; i++) {
        const n = ns[i], W = Math.max(topWidth(n), 4), ds = i > 0 ? ns[i - 1].len : 0, dec = Math.exp(-ds / (5 * W));
        acc = i === 0 ? n.kap : dec * acc + (1 - dec) * n.kap;
        keff[i] = 0.35 * n.kap + 0.65 * acc;
      }
      const rate = new Array(N).fill(0);
      for (let i = 1; i < N - 1; i++) {
        const n = ns[i]; if (n.ups.length > 1 || n.ups.some((u) => u.reach !== r) || n.ranchArc >= 0) continue;       // junctions and the real ranch course stay put
        const W = Math.max(topWidth(n), 4), x = Math.min(Math.abs(keff[i]) * W, 1.5);
        const g = Math.min(x / 0.25, 1) * (1 - 0.5 * sstep(0.25, 1.2, x));
        const psi = clamp((n.acc ? n.acc.tauMax : 0) / (1.2 * 728 * n.D50), 0.2, 1.5);
        const hold = (n.soil === 1 ? 0.7 : 1) * (1 - 0.5 * n.veg) * (n.ledge < 0.5 ? 0.15 : 1) * (n.struct ? 0.2 : 1);
        rate[i] = Math.sign(keff[i]) * Math.min(kM * 0.05 * W * g * psi * hold, 0.15 * W);
      }
      const sm = rate.slice();
      for (let pass = 0; pass < 2; pass++) for (let i = 1; i < N - 1; i++) sm[i] = 0.25 * rate[i - 1] + 0.5 * rate[i] + 0.25 * rate[i + 1];
      const dx = new Array(N).fill(0), dy = new Array(N).fill(0);
      for (let i = 1; i < N - 1; i++) {
        const a = ns[i - 1], c = ns[i + 1], tx = c.x - a.x, ty = c.y - a.y, l = Math.hypot(tx, ty) || 1;
        dx[i] = (ty / l) * sm[i]; dy[i] = (-tx / l) * sm[i];           // toward the outside of the bend (the right-hand side when the bend turns left)
      }
      for (let i = 1; i < N - 1; i++) {
        const n = ns[i];
        if (n.ranchArc >= 0 || n.ups.length > 1) continue;
        n.x += dx[i]; n.y += dy[i];
        // stay on the valley floor
        const off = (n.x - n.ax) * n.anx + (n.y - n.ay) * n.any, lim = Math.max(0.5 * n.Wv - 0.5 * topWidth(n) - 4, 6);
        if (Math.abs(off) > lim) { const k = (Math.abs(off) - lim) * Math.sign(off); n.x -= k * n.anx; n.y -= k * n.any; }
      }
      // a very light smoothing takes out any saw-tooth
      const px = ns.map((n) => n.x), py = ns.map((n) => n.y);
      for (let i = 1; i < N - 1; i++) {
        const n = ns[i]; if (n.ups.length > 1 || n.ranchArc >= 0) continue;
        n.x += 0.004 * ((px[i - 1] + px[i + 1]) / 2 - px[i]); n.y += 0.004 * ((py[i - 1] + py[i + 1]) / 2 - py[i]);
      }
    });
    this.nodes.forEach((n) => { n.len = n.down ? Math.hypot(n.down.x - n.x, n.down.y - n.y) : n.len; });
  };
  P._cutoffs = function (rep) {
    this.reaches.forEach((r) => {
      const ns = r.nodes;
      for (let i = 2; i < ns.length - 8; i++) {
        const a = ns[i], w = Math.max(topWidth(a), 6);
        for (let j = i + 6; j < Math.min(ns.length - 1, i + 70); j++) {
          const b = ns[j];
          if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (1.1 * w) ** 2) {
            let ok = true; for (let k = i + 1; k < j; k++) if (ns[k].ups.length > 1 || ns[k].ups.some((u) => u.reach !== r) || ns[k].struct) ok = false;
            if (!ok) continue;
            const loop = ns.slice(i, j + 1).map((n) => [n.x, n.y]);
            this.oxbows.push({ pts: loop, year: this.year, reach: r.id, fill: 0, w });
            ns.slice(i + 1, j).forEach((n) => { this.byId.delete(n.id); });
            ns.splice(i + 1, j - i - 1); a.down = b; b.ups = b.ups.filter((u) => u.reach !== r || u === a); if (!b.ups.includes(a)) b.ups.push(a);
            a.len = Math.hypot(b.x - a.x, b.y - a.y);
            rep.cutoffs.push({ reach: r.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, nodes: loop.length });
            rep.notes.push('A bend on ' + r.name + ' was cut off and became an oxbow lake.');
            break;
          }
        }
      }
    });
    this.oxbows.forEach((o) => { o.fill = Math.min(1, o.fill + 0.02); });
    if (rep.cutoffs.length) this._rebuild();
  };
  P._respace = function () {
    const DS = GEO.DS;
    this.reaches.forEach((r) => {
      for (let i = 0; i < r.nodes.length - 1; i++) {
        const a = r.nodes[i], b = a.down;
        if (!b || b.reach !== r) continue;
        if (a.len > 1.7 * DS) {
          const mid = mkNode(Object.assign({}, a, { id: ++NODE_ID, ups: [a], down: b, ema: Object.assign({}, a.ema), hist: [], struct: null, acc: a.acc ? Object.assign({}, a.acc) : null }));
          ['bed', 'fp', 'wb', 'm', 'Wv', 'D50', 'veg', 'vegT', 'tAll', 'tSoil', 'x', 'y', 'A', 'bw', 'ax', 'ay', 'anx', 'any', 'kap'].forEach((k) => { mid[k] = 0.5 * (a[k] + b[k]); });
          mid.bz = a.bw > 0.05 && b.bw > 0.05 ? 0.5 * (a.bz + b.bz) : (a.bw > 0.05 ? a.bz : b.bz);
          mid.aLat = 0; mid.supG = 0; mid.supF = 0; mid.len = a.len / 2; a.len = a.len / 2;
          a.supG *= 0.5; a.supF *= 0.5; a.aLat *= 0.5; mid.supG = a.supG; mid.supF = a.supF; mid.aLat = a.aLat;
          setRoughness(mid);
          a.down = mid; b.ups = b.ups.map((u) => (u === a ? mid : u));
          r.nodes.splice(i + 1, 0, mid); this.byId.set(mid.id, mid);
        }
      }
      for (let i = 2; i < r.nodes.length - 2; i++) {
        const a = r.nodes[i];
        if (a.len < 0.4 * DS && a.ups.length === 1 && !a.struct && a.down && a.down.reach === r) {
          const up = a.ups[0], b = a.down; up.down = b; b.ups = b.ups.map((u) => (u === a ? up : u));
          up.len = Math.hypot(b.x - up.x, b.y - up.y); up.supG += a.supG; up.supF += a.supF; up.aLat += a.aLat;
          this.byId.delete(a.id); r.nodes.splice(i, 1); i--;
        }
      }
    });
    this._rebuild();
    this.nodes.forEach((n) => { n.len = n.down ? Math.hypot(n.down.x - n.x, n.down.y - n.y) : n.len; });
  };

  // ---- classification --------------------------------------------------------------------------------
  P.classify = function (n) {
    const nat = R.natural(n.A, n.qf), Ht = trench(n), Hz = benchDepth(n);
    const incised = Ht > Math.max(1.5 * nat.d, nat.d + 0.5);
    const Hbf = Hz > 0.1 ? Hz : Ht, wbf = Math.max(widthAt(n, Hbf), 1), fpw = widthAt(n, Math.min(2 * Hbf, Ht * 1.001 + (2 * Hbf > Ht ? 0.01 : 0)));
    const fpw2 = 2 * Hbf > Ht ? Math.max(n.Wv, topWidth(n)) : widthAt(n, 2 * Hbf);
    const ER = fpw2 / wbf, WD = wbf / Math.max(Hbf, 0.1);
    let type;
    if (n._S > 0.04) type = 'A';
    else if (ER < 1.4) type = WD < 12 ? 'G' : 'F';
    else if (ER < 2.2) type = 'B';
    else type = (n.sin > 1.5 && WD < 12) ? 'E' : 'C';
    const benchOK = n.bw > 0.8 * n.wb && Hz > 0.5 * nat.d;
    let stage;
    if (!incised) stage = n.ema.bed < -0.06 ? 'II' : 'I';                   // a creek that is not cut down is steady unless its bed is dropping fast
    else if (benchOK && Math.abs(n.ema.bed) < 0.02 && Math.abs(n.ema.wid) < 0.15 && n.veg > 0.45) stage = 'V';
    else if (n.ema.bed > 0.015 || n.bw > 0.3 * n.wb) stage = 'IV';
    else if (n.ema.wid > 0.12) stage = 'III';
    else if (n.ema.bed < -0.02 || (n.tAll < 0.05 && Ht > 1.8 * nat.d)) stage = 'II';
    else stage = 'III';
    return { stage, type, ER, WD, Ht, Hnat: nat.d, incision: Ht / nat.d, wnat: nat.w };
  };

  /** What a person looking at a node wants to know, in numbers. */
  P.describe = function (n) {
    const nat = R.natural(n.A, n.qf), c = this.classify(n);
    const Qbf = kOfT(1.5) * Math.pow(n.A, 0.8) * n.qf, S = n._S;
    const rate = {};
    [1, 10, 100].forEach((T) => { const Q = kOfT(T) * Math.pow(n.A, 0.8) * n.qf, h = hydraulics(n, Q, S); rate[T] = { Q, y: h.y, over: h.yo, tau: h.tau, U: h.U }; });
    const th = rate[10].tau / (SREL * RHO * G * n.D50);
    return Object.assign({}, c, {
      A: n.A, areaAcres: n.A * 247.1, bankHeight: trench(n), benchDepth: benchDepth(n), benchWidth: n.bw, topWidth: topWidth(n), bottomWidth: n.wb, slope: S, sinuosity: n.sin,
      bed: n.bed, floodplain: n.fp, rock: rockOf(n), alluvium: n.tAll, soft: n.tSoil, D50mm: n.D50 * 1000, veg: n.veg, soil: SOIL[n.soil].name, valleyWidth: n.Wv,
      Qbf, floods: rate, shields: th, ledge: n.ledge < 0.5, struct: n.struct ? n.struct.type : null, stageInfo: STAGES[c.stage], typeInfo: TYPES[c.type],
      yearBed: n.acc ? n.acc.bed : 0, yearWiden: n.acc ? n.acc.dW || 0 : 0, trendBed: n.ema.bed, trendWiden: n.ema.wid,
      // Lane's balance: sediment supply times grain size against flow power
      balance: { power: RHO * G * Qbf * S, load: (n.qgOut || 0) * n.D50 }
    });
  };

  // ---- profiles --------------------------------------------------------------------------------------
  P.mainPath = function () { return this.main.nodes.slice(); };
  /** Nodes from `node` down to the outlet. */
  P.pathDown = function (node) { const out = []; for (let n = node; n; n = n.down) out.push(n); return out; };
  P.snapshotProfile = function () {
    const out = new Map();
    this.nodes.forEach((n) => { out.set(n.id, { bed: n.bed, fp: n.fp, wb: n.wb, w: topWidth(n), x: n.x, y: n.y, bw: n.bw, bz: n.bz, m: n.m, Wv: n.Wv, veg: n.veg }); });
    return out;
  };
  /** Nearest node to a point on the valley map (within `max` metres), or null. */
  P.nearestNode = function (x, y, max) {
    let b = null, bd = (max || 1e9) ** 2;
    for (const n of this.nodes) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; b = n; } }
    return b;
  };
  /** Nodes between two nodes along the same stream (inclusive), upstream to downstream. */
  P.between = function (a, b) {
    if (a.reach !== b.reach) return [a];
    const ns = a.reach.nodes, i = ns.indexOf(a), j = ns.indexOf(b);
    return ns.slice(Math.min(i, j), Math.max(i, j) + 1);
  };

  // ---- the player's tools ----------------------------------------------------------------------------
  /** Rock weir, beaver dam analog (wood, wears out), headcut plug, or sediment pond. Returns false if the node cannot take one. */
  P.addStructure = function (node, type, opts) {
    opts = opts || {};
    if (!node || node.struct) return false;
    const nat = R.natural(node.A);
    const tauT = (T) => hydraulics(node, kOfT(T) * Math.pow(node.A, 0.8) * node.qf, node._S).tau;
    if (type === 'weir') node.struct = { type, crest: node.bed + (opts.height || 0.8), height: opts.height || 0.8, design: 1.15 * tauT(50), health: 1, age: 0 };           // a rock weir is built to take about a 50-year flood
    else if (type === 'bda') node.struct = { type, crest: node.bed + (opts.height || 0.5), height: opts.height || 0.5, design: 1.1 * tauT(5), health: 1, age: 0, life: 10 };   // posts and brush: a 5-year flood washes them out
    else if (type === 'plug') node.struct = { type, crest: node.bed, height: 0, design: 1e9, health: 1, age: 0 };
    else if (type === 'pond') node.struct = { type, crest: node.bed, height: 0, design: 1e9, health: 1, age: 0, fill: 0, cap: opts.capacity || (node.wb * 120 * 2) };
    else return false;
    if (node.struct.crest > node.bed) { const up = node.struct.crest - node.bed; node.bed = node.struct.crest; node.tAll += up; }
    node.ledge = Math.min(node.ledge, type === 'plug' ? 0.01 : 1);
    this._slopes(); return true;
  };
  P.removeStructure = function (node) { if (node && node.struct) { node.struct = null; return true; } return false; };
  /** Lower the banks: the trench becomes a gentle slope with a wide bench at about the natural bankfull height. */
  P.lowerBanks = function (nodes, opts) {
    opts = opts || {};
    nodes.forEach((n) => {
      const nat = R.natural(n.A, n.qf);
      if (trench(n) <= nat.d * 1.2) return;
      const old = trench(n); n.fp = n.bed + nat.d * 1.2; n.m = Math.max(n.m, 2.8);
      n.bw = Math.max(n.bw, 1.5 * nat.w); n.bz = n.bed + nat.d * 0.9;
      n.Wv = Math.max(n.Wv, topWidth(n) + 10);
      n._dug = (n._dug || 0) + (old - nat.d * 1.2) * n.len * (0.5 * (topWidth(n)));
    });
  };
  /** Plant a streamside buffer: the riparian roots grow over the next years. */
  P.plant = function (nodes, target) { nodes.forEach((n) => { n.vegT = Math.max(n.vegT, target == null ? 1 : target); }); };
  /** Can the player re-shape this stretch? The ranch's own creek and gullies are drawn on the ranch map, so they are changed there. */
  P.canReshape = function (nodes) {
    return nodes.length >= 8 && !nodes.some((n, i) => n.ranchArc >= 0 || n.reach.ranch || n.struct || (i > 0 && i < nodes.length - 1 && n.ups.length > 1));
  };
  /** The longest clear stretch of the same stream around a node (no side stream joining inside it), at most `k` nodes each way. */
  P.clearStretch = function (node, k) {
    const ns = node.reach.nodes, i = ns.indexOf(node); let a = i, b = i;
    while (a > 0 && i - a < k && !(ns[a].ups.length > 1 && a !== i)) a--;
    while (b < ns.length - 1 && b - i < k && !(ns[b].ups.length > 1)) b++;
    return ns.slice(a, b + 1);
  };
  const pathLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
  /** Put bends back: lay the channel in a sine curve about the straight line between the ends of the stretch (ends stay put).
      Returns metres of channel gained (0 if the stretch cannot be changed). */
  P.reMeander = function (nodes, sinTarget) {
    sinTarget = clamp(sinTarget || 1.4, 1.05, 2);
    if (!this.canReshape(nodes)) return 0;
    const N = nodes.length, a = nodes[0], b = nodes[N - 1], cx = b.x - a.x, cy = b.y - a.y, chord = Math.hypot(cx, cy);
    if (chord < 200) return 0;
    const ux = cx / chord, uy = cy / chord, vx = -uy, vy = ux;
    const mid = nodes[N >> 1], nat = R.natural(mid.A), lam = clamp(11 * nat.w, 120, chord / 1.5);
    const s0 = nodes.map((n, i) => (i < N - 1 ? n.len : 0)); let s = 0; const arc = s0.map((l) => { const v = s; s += l; return v; });
    const L0 = s;
    const build = (amp) => nodes.map((n, i) => {
      const t = arc[i] / L0, w = sstep(0, 0.1, t) * sstep(0, 0.1, 1 - t), off = amp * w * Math.sin(2 * Math.PI * t * chord / lam);
      return [a.x + ux * chord * t + vx * off, a.y + uy * chord * t + vy * off];
    });
    const maxAmp = 0.5 * Math.min(...nodes.map((n) => n.Wv)) - 12;
    if (maxAmp < 8) return 0;                       // the valley floor is too narrow for bends
    let lo = 0, hi = maxAmp;
    for (let it = 0; it < 14; it++) { const mid2 = 0.5 * (lo + hi); if (pathLen(build(mid2)) / chord < sinTarget) lo = mid2; else hi = mid2; }
    const pts = build(0.5 * (lo + hi));
    nodes.forEach((n, i) => { n.x = pts[i][0]; n.y = pts[i][1]; });
    this.nodes.forEach((n) => { n.len = n.down ? Math.hypot(n.down.x - n.x, n.down.y - n.y) : n.len; });
    const gained = pathLen(pts) - L0;
    this._respace(); this._slopes(); this._curvature();
    return gained;
  };
  /** Straighten a stretch (what engineers once did to creeks). A sandbox "what if". Returns metres of channel lost. */
  P.straighten = function (nodes) {
    if (!this.canReshape(nodes)) return 0;
    const a = nodes[0], b = nodes[nodes.length - 1], L0 = nodes.reduce((q, n) => q + n.len, 0);
    nodes.forEach((n, i) => { if (i === 0 || i === nodes.length - 1) return; const t = i / (nodes.length - 1); n.x = lerp(a.x, b.x, t); n.y = lerp(a.y, b.y, t); });
    this.nodes.forEach((n) => { n.len = n.down ? Math.hypot(n.down.x - n.x, n.down.y - n.y) : n.len; });
    this._respace(); this._slopes(); this._curvature();
    return L0 - nodes.reduce((q, n) => q + n.len, 0);
  };
  /** The big river at the bottom cuts down (or fills up): a wave of incision runs up the creek. */
  P.baseLevel = function (dz) { this.outlet.bed -= dz; this.outlet.fp -= dz; this.outlet.tAll = 0; this.outlet.tSoil = 0; this._slopes(); };

  // ---- what the screen asks for ----------------------------------------------------------------------
  /** The shape of the valley floor across the creek at a node, as [offset from the middle (m), height (m)] points, left bank to right bank,
      plus the heights of the water in floods. */
  P.section = function (n, opt) {
    opt = opt || {};
    const Ht = trench(n), Hz = benchDepth(n), m = n.m, hw = n.wb / 2, top = topWidth(n), half = Math.max(n.Wv / 2, top / 2 + 6);
    const pts = [], bed = n.bed, fp = n.fp;
    const right = [[hw, bed]];
    if (Hz > 0 && n.bw > 0.05) { const x1 = hw + m * Hz; right.push([x1, bed + Hz], [x1 + n.bw / 2, bed + Hz]); right.push([x1 + n.bw / 2 + m * (Ht - Hz), fp]); }
    else right.push([hw + m * Ht, fp]);
    const xe = right[right.length - 1][0];
    right.push([Math.max(half, xe + 8), fp + 0.05 * (Math.max(half, xe + 8) - xe) / 8]);
    for (let i = right.length - 1; i >= 0; i--) pts.push([-right[i][0], right[i][1]]);
    for (let i = 0; i < right.length; i++) pts.push([right[i][0], right[i][1]]);
    const levels = {}, S = n._S;
    [1, 10, 100].forEach((T) => { const h = hydraulics(n, kOfT(T) * Math.pow(n.A, 0.8) * n.qf, S); levels[T] = bed + h.y; });
    return { pts, bed, fp, half, levels, bankHeight: Ht, benchDepth: Hz };
  };
  /** Lane's balance for a node: what the floods could carry in an average year against what actually went through this year (m3 of gravel). */
  P.balance = function (n) {
    const cap = capYear(refTaus(n, n.A, n._S), Math.max(n.wb, 1), n.D50), load = n.acc ? n.acc.qs : 0;
    return { cap, load, ratio: cap / Math.max(load, 1e-6) };
  };
  /** A 0..1 score for the whole valley: how much of the main creek is steady or healed (by length), and how little mud is leaving. */
  P.health = function () {
    const w = { I: 1, V: 1, IV: 0.7, III: 0.35, II: 0.2 };
    let L = 0, sc = 0, ranchL = 0, ranchSc = 0, cut = 0;
    this.main.nodes.forEach((n) => {
      const v = w[n.stage] != null ? w[n.stage] : 0.5; L += n.len; sc += v * n.len;
      if (n.ranch) { ranchL += n.len; ranchSc += v * n.len; }
      if (trench(n) > Math.max(1.5 * R.natural(n.A).d, R.natural(n.A).d + 0.5)) cut += n.len;
    });
    const rec = this.series.slice(-5), fines = rec.length ? rec.reduce((q, r) => q + r.exportFines, 0) / rec.length : 0;
    return { main: L ? sc / L : 0, ranch: ranchL ? ranchSc / ranchL : 0, cutShare: L ? cut / L : 0, finesPerYear: fines, lengthKm: L / 1000 };
  };
  /** What the ranch map tells the valley: bank plant cover on the ranch creek and gullies (0..1 bare share), the share by which the ranch's storm
      peaks are cut, and how much more or less soil leaves the ranch land. */
  P.setRanchInputs = function (o) {
    o = o || {};
    if (o.peakCut != null) this.p.ranchRed = clamp(o.peakCut, 0, 0.3);
    if (o.landFactor != null) this.nodes.forEach((n) => { if (n.ranch) n.landF = clamp(o.landFactor, 0.2, 2); });
    if (o.mainBare != null) this.nodes.forEach((n) => { if (n.ranch && n.reach.main) n.vegT = clamp(0.8 - 0.65 * o.mainBare, 0.15, 0.8); });
    if (o.gullyBare != null) this.nodes.forEach((n) => { if (n.reach.ranch) n.vegT = clamp(0.8 - 0.65 * o.gullyBare, 0.1, 0.8); });
  };

  // ---- save and load ---------------------------------------------------------------------------------
  const NODE_KEYS = ['id', 'x', 'y', 'len', 'A', 'aLat', 'bed', 'tAll', 'tSoil', 'fp', 'wb', 'm', 'bw', 'bz', 'Wv', 'D50', 'soil', 'veg', 'vegT', 'ledge', 'ranch', 'ranchArc', 'supG', 'supF', 'landF', 'ax', 'ay', 'anx', 'any', 'stage', 'type'];
  P.toJSON = function () {
    return {
      v: 1, year: this.year, rng: this.rng.s, p: this.p, oxbows: this.oxbows, series: this.series.slice(-300), seed: this.valley.seed,
      reaches: this.reaches.map((r) => ({ id: r.id, nodes: r.nodes.map((n) => n.id) })),
      nodes: this.nodes.map((n) => { const o = {}; NODE_KEYS.forEach((k) => { o[k] = n[k]; }); o.down = n.down ? n.down.id : 0; o.reach = n.reach.id; o.struct = n.struct; o.ema = n.ema; o.hist = n.hist.slice(-120); return o; })
    };
  };
  Model.fromJSON = function (valley, j) {
    const m = new Model(valley, { seed: j.seed, params: j.p });
    const byId = new Map(); m.nodes.forEach((n) => byId.set(n.id, n));
    // rebuild the network from the saved nodes (ids may differ from the fresh valley, so rebuild everything from the save)
    const nodes = new Map(); const reachBy = new Map(m.reaches.map((r) => [r.id, r]));
    m.reaches.forEach((r) => { r.nodes = []; });
    j.nodes.forEach((o) => { const n = mkNode(Object.assign({}, o, { reach: reachBy.get(o.reach), ups: [], down: null, hist: o.hist || [], ema: o.ema || { bed: 0, wid: 0 }, acc: null })); nodes.set(o.id, n); });
    j.nodes.forEach((o) => { const n = nodes.get(o.id); n.down = o.down ? nodes.get(o.down) : null; if (n.down) n.down.ups.push(n); });
    j.reaches.forEach((r) => { reachBy.get(r.id).nodes = r.nodes.map((id) => nodes.get(id)).filter(Boolean); });
    m.reaches.forEach((r) => { r.mouth = r.nodes.length ? r.nodes[r.nodes.length - 1].down : null; });
    m.nodes = Array.from(nodes.values()); m.byId = nodes;
    m.outlet = m.main.nodes[m.main.nodes.length - 1];
    m.year = j.year; m.rng.s = j.rng; m.oxbows = j.oxbows || []; m.series = j.series || [];
    m._rebuild(); m.nodes.forEach(setRoughness); m._markBelowRanch(); m._slopes();
    const exit = m.main.nodes.filter((n) => n.ranch); m.ranchExit = exit[exit.length - 1] || m.ranchExit; m.ranchEntry = exit[0] || m.ranchEntry; m._markBelowRanch();
    return m;
  };
})();
