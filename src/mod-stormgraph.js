/* Storm graph: "how fast does water leave the ranch, and did my work change it?"
   A small chart panel (a hydrograph) that fills in while a storm runs and stays after it, plus a plain-words summary,
   a "where did the rain go?" bar and a list of the last storms to look at or compare.

   It only LISTENS: the numbers come from the game's storm events ("stormStart", "stormStep", "stormEnd") and the
   storm result (game.lastStorm, game.baseline). It keeps its own small arrays and never reads the GPU.
   Everything it draws is in its own canvas; it never touches the map drawing.
   Public bits: Creek.stormgraph (see the end of this file). Described in docs/EXTENSION_API.md (cross-module ids). */
(function () {
  'use strict';
  const C = Creek.CONFIG;
  const BATH = 0.3, POOL = 2500, CFS = 35.3147, MMH = 3.6e6;   // m3 in a bathtub, m3 in a big pool, cfs per m3/s, mm/hour per m/s
  const MAXHIST = 12, CAP = 720, SAVEPTS = 160, LIVE_MS = 100, SCRUB_MS = 33;
  const SEASON = { summer: 'Summer', fall: 'Fall', winter: 'Winter', spring: 'Spring' };
  const mod = Creek.stormgraph = { drawCount: 0, version: 1 };

  // ---------------------------------------------------------------- small helpers
  function safe(what, fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { console.error('[stormgraph] ' + what + ' failed:', e); } }; }
  const fin = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const sig3 = (v) => { v = fin(v); return v === 0 ? 0 : +v.toPrecision(3); };
  const num = (v) => sig3(v).toLocaleString('en-US');                       // 3 significant figures: 85.3, 853, 1,230
  const sizeLabel = (s) => (C.storms[s] ? C.storms[s].label : s + '-year');
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hex(h) { h = String(h || '').trim(); const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h); if (!m) return null; let s = m[1]; if (s.length === 3) s = s.replace(/./g, '$&$&'); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4), 16)]; }
  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  const mix = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

  /** "40 seconds" / "12 minutes": plain words for a length of time. */
  function words(sec) {
    sec = Math.abs(sec);
    if (sec < 90) return plural(Math.round(sec), 'second');
    const m = sec / 60; return plural(m < 10 ? +m.toPrecision(2) : Math.round(m), 'minute');
  }
  /** Short clock-ish label for the chart: "47 s" / "31 min". */
  function shortT(sec) { return sec < 90 ? Math.round(sec) + ' s' : (sec / 60 < 10 ? +(sec / 60).toPrecision(2) : Math.round(sec / 60)) + ' min'; }
  /** A "round" count for talking: 370, 4,200, 7.5. */
  function about(n) {
    if (n < 10) return String(+n.toPrecision(2));
    if (n < 100) return String(Math.round(n));
    if (n < 1000) return String(Math.round(n / 10) * 10);
    return (Math.round(n / 100) * 100).toLocaleString('en-US');
  }
  function niceStep(max, n) {
    const raw = Math.max(max, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  // ---------------------------------------------------------------- records
  // One storm = {t, rain, Qin, Qout, n, ...numbers}. Live records use typed arrays with a count `n`; finished ones plain arrays.
  let uid = 0;
  const hist = [];                    // finished storms, oldest first (at most 12)
  const cache = new WeakMap();        // storm result -> record (for game.baseline and adopted history)
  let game = null, ui = null;

  function stats(r) {
    const t = r.t, qo = r.Qout, qi = r.Qin, n = r.n;
    let pk = 0, pt = 0, up = 0, vol = 0, mq = 0, mr = 0;
    for (let i = 0; i < n; i++) {
      if (qo[i] > pk) { pk = qo[i]; pt = t[i]; }
      if (qi[i] > mq) mq = qi[i];
      if (r.rain[i] > mr) mr = r.rain[i];
      if (i) { const dt = t[i] - t[i - 1]; up += 0.5 * (qi[i] + qi[i - 1]) * dt; vol += 0.5 * (qo[i] + qo[i - 1]) * dt; }
    }
    r.seriesPeak = pk; r.peakT = pt; r.up = up; r.volSeries = vol; r.maxQin = mq; r.maxRain = mr;
    r.lastT = n ? t[n - 1] : 0;
    return r;
  }
  /** Make a record from a storm result (game.lastStorm, game.baseline...). Returns null if it has no usable series. */
  function fromResult(res) {
    if (!res || !res.series || !res.series.t || res.series.t.length < 2) return null;
    const c = cache.get(res); if (c) return c;
    const s = res.series, n = Math.min(s.t.length, s.Qout.length, (s.Qin || s.Qout).length, (s.rain || s.Qout).length);
    const r = { id: ++uid, src: res, live: false, size: res.size, tag: res.tag || null, t: s.t, rain: s.rain || [], Qin: s.Qin || [], Qout: s.Qout, n: n,
      year: res.year || 0, season: res.season || '', rainVol: fin(res.rainVol), soak: fin(res.soakShare), vol: fin(res.volOut), peak: fin(res.peakOut) };
    stats(r);
    r.peak = Math.max(r.peak, r.seriesPeak); if (!(r.vol > 0)) r.vol = r.volSeries;
    r.partial = r.lastT < 0.97 * (C.stormBurst + C.stormTail);
    cache.set(res, r); return r;
  }
  const r3 = (v) => sig3(v);
  function pack(r) {
    const k = Math.min(r.n, SAVEPTS), o = { size: r.size, tag: r.tag, year: r.year, season: r.season, peak: r3(r.peak), vol: r3(r.vol), rainVol: r3(r.rainVol), soak: +fin(r.soak).toFixed(4), partial: r.partial ? 1 : 0, t: [], rain: [], Qin: [], Qout: [] };
    for (let i = 0; i < k; i++) {
      const j = k > 1 ? Math.round(i * (r.n - 1) / (k - 1)) : 0;
      o.t.push(+fin(r.t[j]).toFixed(1)); o.rain.push(r3(r.rain[j])); o.Qin.push(r3(r.Qin[j])); o.Qout.push(r3(r.Qout[j]));
    }
    return o;
  }
  function unpack(o) {
    if (!o || !Array.isArray(o.t) || o.t.length < 2 || !Array.isArray(o.Qout)) return null;
    const r = { id: ++uid, src: null, live: false, size: o.size, tag: o.tag || null, t: o.t, rain: o.rain || [], Qin: o.Qin || [], Qout: o.Qout, n: Math.min(o.t.length, o.Qout.length),
      year: o.year | 0, season: o.season || '', rainVol: fin(o.rainVol), soak: fin(o.soak), vol: fin(o.vol), peak: fin(o.peak) };
    for (let i = 0; i < r.n; i++) { if (r.rain[i] == null) r.rain[i] = 0; if (r.Qin[i] == null) r.Qin[i] = 0; }
    stats(r); r.peak = Math.max(r.peak, r.seriesPeak); if (!(r.vol > 0)) r.vol = r.volSeries; r.partial = !!o.partial;
    return r;
  }

  // The live storm: typed arrays written by "stormStep" (no allocation while the storm runs)
  const live = { live: true, active: false, t: new Float32Array(CAP), rain: new Float32Array(CAP), Qin: new Float32Array(CAP), Qout: new Float32Array(CAP), n: 0,
    size: 10, tag: null, year: 0, season: '', peak: 0, peakT: 0, vol: 0, up: 0, maxQin: 0, maxRain: 0, nextRec: 0, every: 7, lt: 0, lr: 0, lqi: 0, lqo: 0, rainVol: 0, soak: 0, partial: false, lastT: 0 };

  // ---------------------------------------------------------------- what is shown
  let shown = null, cmp = null, armed = false;   // shown: finished record on view; cmp: record picked for comparing; armed: next history tap compares
  let A = null, G = null, gName = '';            // set by refreshModel(): what is drawn now
  const label = (r) => r.tag === 'baseline' ? 'Before you started' : r.tag === 'final' ? 'Final test' : (r.year ? 'Year ' + r.year + ' ' + (SEASON[r.season] || '') : '').trim();
  const nameOf = (r) => 'the ' + sizeLabel(r.size) + ' storm' + (label(r) ? ' (' + label(r) + ')' : '');

  function pickGhost(a) {
    G = null; gName = '';
    if (cmp && cmp !== a && cmp.n > 1) { G = cmp; gName = nameOf(cmp); return; }
    const b = game && game.baseline;
    if (b && b.size === a.size && a.src !== b && a.tag !== 'baseline') { const br = fromResult(b); if (br && br !== a) { G = br; gName = 'the storm from before you started'; return; } }
    let idx = a.live ? hist.length : hist.indexOf(a);
    for (let i = idx - 1; i >= 0; i--) if (hist[i].size === a.size && hist[i] !== a) { G = hist[i]; gName = 'your last ' + sizeLabel(a.size) + ' storm'; return; }
  }
  function refreshModel() {
    A = live.active ? live : shown;
    if (A) pickGhost(A); else { G = null; gName = ''; }
  }

  // ---------------------------------------------------------------- the comparison in words
  /** Peak and timing against the ghost. cls: good (lower and/or later), bad (higher and/or earlier), mix, same. */
  function compare(a, g) {
    const dp = g.peak > 0 ? (a.peak - g.peak) / g.peak * 100 : 0;
    const dt = a.peakT - g.peakT, tEnd = Math.max(a.lastT, g.lastT, 60), tol = Math.max(5, 0.008 * tEnd);
    const pk = Math.abs(dp) < 5 ? 0 : (dp < 0 ? 1 : -1);      // 1 = better (lower)
    const tm = Math.abs(dt) < tol ? 0 : (dt > 0 ? 1 : -1);    // 1 = better (later)
    const dv = g.vol > 0 ? (a.vol - g.vol) / g.vol * 100 : 0;
    let cls = 'same';
    if (pk > 0 && tm >= 0 || pk === 0 && tm > 0) cls = 'good'; else if (pk < 0 && tm <= 0 || pk === 0 && tm < 0) cls = 'bad'; else if (pk !== 0 && tm !== 0) cls = 'mix';
    const p1 = pk === 0 ? 'Peak about the same' : 'Peak ' + Math.round(Math.abs(dp)) + '% ' + (dp < 0 ? 'lower' : 'higher');
    const p2 = tm === 0 ? 'at about the same time' : words(dt) + (dt > 0 ? ' later' : ' earlier');
    return { cls: cls, dp: dp, dt: dt, dv: dv, text: p1 + ', ' + p2, icon: pk > 0 ? '▼' : pk < 0 ? '▲' : '＝' };
  }
  mod._compare = compare;

  /** Where the rain on the ranch went. Counts rain that fell ON the ranch (volOut also holds water that came from upstream).
      Soaked in = the game's own soak share. The rain that did not soak in is shared between "left" and "held" in the same
      proportion as ALL the water that did not soak in (rain plus upstream water): we guess the two kinds of water behaved alike. */
  function split(r) {
    const R = r.rainVol; if (!(R > 0)) return null;
    const soaked = Math.min(R, Math.max(0, r.soak * R)), rest = R - soaked;
    const out = Math.max(0, r.vol), kept = Math.max(0, R + r.up - soaked - out);   // kept: still on the land (ponds, puddles, in the creek) or not counted
    const share = out + kept > 0 ? out / (out + kept) : 0;
    const left = rest * share, held = rest - left;
    let a = Math.round(soaked / R * 100), b = Math.round(left / R * 100); if (a + b > 100) b = 100 - a;
    return { R: R, soaked: soaked, left: left, held: held, a: a, b: b, c: 100 - a - b };
  }
  mod._split = split;

  // ---------------------------------------------------------------- state: units, panel, canvas
  const set = Creek.settings;
  const useCfs = () => !!set.get('stormgraph.cfs', false);
  const unitName = () => (useCfs() ? 'cfs' : 'm³/s');
  const fq = (q) => q * (useCfs() ? CFS : 1);

  let panel = null, btn = null, root = null, cv = null, ctx = null, wrap = null;
  let cw = 0, ch = 0, dpr = 1, dirty = true, lastDraw = 0, cursorT = null, autoOpened = false, scrubTimer = 0, scrubPending = false, liveY = 0;
  const pal = {};
  const D = {};                       // cached DOM bits
  const cached = (e, v) => { if (e._v !== v) { e._v = v; e.textContent = v; } };

  function readPalette() {
    const cs = getComputedStyle(document.documentElement), g = (n, d) => hex(cs.getPropertyValue(n)) || hex(d);
    const ink = g('--ink', '#3b2a1a'), ink2 = g('--ink2', '#6b5640'), water = g('--water', '#4a8aa3'), moss = g('--moss', '#5d7f3b'), clay = g('--clay', '#b5654a'), gold = g('--gold', '#e9a23b'), paper = g('--paper', '#f4ecd8');
    const out = mix(water, ink, 0.28);
    Object.assign(pal, {
      ink: rgba(ink, 1), ink2: rgba(ink2, 1), grid: rgba(ink, 0.12), axis: rgba(ink, 0.45), text: rgba(ink2, 1), plot: 'rgba(255,255,255,0.45)', paper: rgba(paper, 0.92),
      rain: rgba(mix(water, [255, 255, 255], 0.15), 0.55), rainText: rgba(mix(water, ink, 0.35), 1), out: rgba(out, 1), outFill: rgba(water, 0.34), qin: rgba(ink2, 1), ghost: rgba(ink, 0.34),
      gold: rgba(gold, 1), moss: rgba(moss, 1), clay: rgba(clay, 1), outHex: out, water: rgba(water, 1)
    });
    if (D.sw) { D.sw.rain.style.background = pal.rain; D.sw.out.style.background = pal.out; D.sw.ghost.style.background = pal.ghost; D.sw.qin.style.borderTopColor = pal.qin; D.sw.rain.style.borderColor = rgba(mix(water, ink, 0.2), 0.7); }
    if (D.seg) { D.seg[0].style.background = pal.moss; D.seg[1].style.background = pal.out; D.seg[2].style.background = pal.gold; }
  }

  // ---------------------------------------------------------------- drawing the chart
  const PL = 40, PR = 10, PT = 18, PB = 22;
  function interp(t, v, n, x) {
    if (n < 1) return 0; if (x <= t[0]) return v[0]; if (x >= t[n - 1]) return v[n - 1];
    let i = 1; while (i < n - 1 && t[i] < x) i++;
    const f = (x - t[i - 1]) / Math.max(1e-9, t[i] - t[i - 1]); return v[i - 1] + (v[i] - v[i - 1]) * f;
  }
  /** Series length to draw: for the live storm the newest sample is written one slot past the stored points. */
  function count(r) {
    if (!r.live) return r.n;
    if (r.n > 0 && r.lt > r.t[r.n - 1] && r.n < CAP) { r.t[r.n] = r.lt; r.rain[r.n] = r.lr; r.Qin[r.n] = r.lqi; r.Qout[r.n] = r.lqo; return r.n + 1; }
    return r.n;
  }
  function halo(c, text, x, y) { c.lineWidth = 3; c.strokeStyle = pal.paper; c.strokeText(text, x, y); c.fillText(text, x, y); }

  /** Length of the time axis in seconds: the whole storm while it runs, else as long as the longest curve shown. */
  function tEndNow() {
    if (!A) return C.stormBurst + C.stormTail;
    let t = Math.max(60, A.lastT, G ? G.lastT : 0); if (A.live) t = Math.max(t, C.stormBurst + C.stormTail);
    return t;
  }
  function draw() {
    lastDraw = performance.now(); dirty = false;
    if (!ctx || cw < 60 || ch < 40) return;
    mod.drawCount++;
    refreshModel();
    const c = ctx, x0 = PL, x1 = cw - PR, y0 = PT, y1 = ch - PB, pw = x1 - x0, ph = y1 - y0;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
    c.fillStyle = pal.plot; c.fillRect(x0, y0, pw, ph);
    c.font = '10.5px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'; c.textBaseline = 'alphabetic';

    // ranges
    const na = A ? count(A) : 0, ng = G ? count(G) : 0;
    const tEnd = tEndNow(); let qmax = 0;
    if (A) qmax = Math.max(A.peak, A.maxQin, A.lqo || 0);
    if (G) qmax = Math.max(qmax, G.peak);
    const f = useCfs() ? CFS : 1;
    let top = fq(Math.max(qmax, 0.02)) * 1.08;
    const step = niceStep(top, 4); let ymax = Math.ceil(top / step - 1e-9) * step;
    if (A && A.live) { if (ymax > liveY) liveY = ymax; ymax = liveY; } else liveY = 0;
    const X = (t) => x0 + t / tEnd * pw, Y = (q) => y1 - Math.min(q * f / ymax, 1.02) * ph;

    // grid + y labels
    c.textAlign = 'right'; c.fillStyle = pal.text; c.strokeStyle = pal.grid; c.lineWidth = 1;
    const dec = Math.abs(step - Math.round(step)) < 1e-9 ? 0 : (Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2);
    c.beginPath();
    for (let v = 0; v <= ymax + step * 0.01; v += step) {
      const y = Math.round(y1 - v / ymax * ph) + 0.5; c.moveTo(x0, y); c.lineTo(x1, y);
      const s = v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v >= 1000 && dec === 0 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : v.toFixed(dec);
      if (A) c.fillText(s, x0 - 5, y + 3.5);
    }
    c.stroke();
    c.textAlign = 'left'; c.fillText(unitName(), 2, 10);
    // x ticks (minutes)
    const mins = tEnd / 60, steps = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 60]; let sm = 60;
    for (let i = 0; i < steps.length; i++) if (mins / steps[i] <= Math.max(3, pw / 52)) { sm = steps[i]; break; }
    c.textAlign = 'center'; c.strokeStyle = pal.axis; c.beginPath();
    for (let m = 0; m <= mins + 1e-6; m += sm) {
      const x = Math.round(X(m * 60)) + 0.5; c.moveTo(x, y1); c.lineTo(x, y1 + 3);
      if (x < x1 - 46) c.fillText(String(+m.toFixed(2)), Math.max(x, x0 + 4), y1 + 14);
    }
    c.moveTo(x0, y1 + 0.5); c.lineTo(x1, y1 + 0.5); c.stroke();
    c.textAlign = 'right'; c.fillText('minutes', x1, y1 + 14);

    if (!A) { drawEmpty(c, x0, x1, y0, y1, pw, ph); return; }

    // rain: bars hanging from the top
    const tLast = na ? A.t[na - 1] : 0, rmax = Math.max(A.maxRain, A.live && game.storm ? fin(game.storm.rainPeak) : 0, A.lr || 0);
    if (rmax > 0) {
      const nb = Math.max(8, Math.min(90, Math.floor(pw / 3.2))), bw = pw / nb, band = ph * 0.3;
      c.fillStyle = pal.rain; c.beginPath();
      for (let b = 0; b < nb; b++) {
        const tc = (b + 0.5) / nb * tEnd; if (tc > tLast) break;
        const v = interp(A.t, A.rain, na, tc); if (v <= rmax * 0.01) continue;
        c.rect(x0 + b * bw + 0.4, y0, Math.max(1, bw - 0.8), Math.max(1, v / rmax * band));
      }
      c.fill();
      c.textAlign = 'left'; c.fillStyle = pal.rainText; c.fillText('rain', x0 + 4, y0 + 11);
    }
    // the ghost (earlier storm)
    if (G && ng > 1) {
      c.strokeStyle = pal.ghost; c.lineWidth = 2.2; c.lineJoin = 'round'; c.beginPath();
      for (let i = 0; i < ng; i++) { const x = X(G.t[i]), y = Y(G.Qout[i]); if (i) c.lineTo(x, y); else c.moveTo(x, y); }
      c.stroke();
      const gx = X(G.peakT), gy = Y(G.seriesPeak);
      c.beginPath(); c.arc(gx, gy, 3.5, 0, 6.2832); c.fillStyle = pal.paper; c.fill(); c.lineWidth = 1.6; c.stroke();
    }
    // upstream water (thin dashed) and water leaving (bold, filled)
    if (na > 1) {
      c.lineWidth = 1.4; c.strokeStyle = pal.qin; c.setLineDash([5, 3]); c.beginPath();
      for (let i = 0; i < na; i++) { const x = X(A.t[i]), y = Y(A.Qin[i]); if (i) c.lineTo(x, y); else c.moveTo(x, y); }
      c.stroke(); c.setLineDash([]);
      c.beginPath(); c.moveTo(X(A.t[0]), y1);
      for (let i = 0; i < na; i++) c.lineTo(X(A.t[i]), Y(A.Qout[i]));
      c.lineTo(X(A.t[na - 1]), y1); c.closePath(); c.fillStyle = pal.outFill; c.fill();
      c.lineWidth = 2.6; c.strokeStyle = pal.out; c.lineJoin = 'round'; c.beginPath();
      for (let i = 0; i < na; i++) { const x = X(A.t[i]), y = Y(A.Qout[i]); if (i) c.lineTo(x, y); else c.moveTo(x, y); }
      c.stroke();
    }
    // the peak
    if (A.peak > 0 && na > 1) {
      const px = X(A.peakT), py = Y(A.seriesPeak);
      c.beginPath(); c.arc(px, py, 5, 0, 6.2832); c.fillStyle = pal.gold; c.fill(); c.lineWidth = 1.6; c.strokeStyle = pal.ink; c.stroke();
      const txt = (A.live ? 'peak so far, ' : 'peak at ') + shortT(A.peakT), tw = c.measureText(txt).width;
      c.fillStyle = pal.ink; c.textAlign = px > x1 - tw / 2 - 4 ? 'right' : px < x0 + tw / 2 + 4 ? 'left' : 'center';
      const lx = c.textAlign === 'right' ? Math.min(px + 6, x1) : c.textAlign === 'left' ? Math.max(px - 6, x0) : px;
      halo(c, txt, lx, py - y0 > 26 ? py - 9 : py + 17);
    }
    if (A.live && na > 0) {          // where the storm is now
      const nx = X(A.t[na - 1]), ny = Y(A.Qout[na - 1]);
      c.beginPath(); c.arc(nx, ny, 3.5, 0, 6.2832); c.fillStyle = pal.out; c.fill();
      c.strokeStyle = pal.axis; c.lineWidth = 1; c.beginPath(); c.moveTo(Math.round(nx) + 0.5, y0); c.lineTo(Math.round(nx) + 0.5, y1); c.stroke();
    }
    // finger / mouse readout
    if (cursorT != null && na > 1) {
      const t = Math.max(0, Math.min(cursorT, tEnd)), x = Math.round(X(t)) + 0.5, q = interp(A.t, A.Qout, na, t);
      c.strokeStyle = pal.ink; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
      c.beginPath(); c.arc(x, Y(q), 4, 0, 6.2832); c.fillStyle = pal.paper; c.fill(); c.lineWidth = 2; c.strokeStyle = pal.out; c.stroke();
      let txt = shortT(t) + ': ' + num(fq(q)) + ' ' + unitName() + ' leaving';
      if (G && ng > 1) txt += ' (before: ' + num(fq(interp(G.t, G.Qout, ng, t))) + ')';
      c.fillStyle = pal.ink; c.textAlign = 'right'; c.fillText(txt, x1, 11);       // in the strip above the plot, clear of the curves
    }
  }
  function drawEmpty(c, x0, x1, y0, y1, pw, ph) {
    // a faint dotted example hump, so the chart does not look broken
    c.save(); c.setLineDash([2, 5]); c.lineCap = 'round'; c.strokeStyle = pal.ghost; c.lineWidth = 2.4; c.beginPath();
    for (let i = 0; i <= 40; i++) { const u = i / 40, v = Math.exp(-Math.pow((u - 0.38) / 0.17, 2)) * 0.62 + 0.03 * u, x = x0 + u * pw * 0.92 + pw * 0.04, y = y1 - v * ph * 0.9; if (i) c.lineTo(x, y); else c.moveTo(x, y); }
    c.stroke(); c.restore();
    c.textAlign = 'center'; c.fillStyle = pal.ink; c.font = '600 13px Georgia, serif'; c.fillText('Your storm will draw itself here', x0 + pw / 2, y0 + ph * 0.3);
    c.font = '11.5px system-ui, sans-serif'; c.fillStyle = pal.text; c.fillText('Tap a ☔ storm button to send one', x0 + pw / 2, y0 + ph * 0.3 + 17);
  }

  /** Redraw soon, but not more than about 10 times a second while a storm runs. */
  function want(ms) {
    dirty = true; if (!panel || !panel.visible || scrubPending) return;
    const wait = Math.max(0, (ms == null ? 0 : ms) - (performance.now() - lastDraw));
    if (wait <= 0) { scrubPending = true; requestAnimationFrame(() => { scrubPending = false; if (dirty) tickDraw(); }); }
    else { scrubPending = true; setTimeout(() => { scrubPending = false; if (dirty) tickDraw(); }, wait); }
  }
  const tickDraw = safe('draw', function () { draw(); refreshLive(); });

  // ---------------------------------------------------------------- the words under the chart
  function buildDom(body) {
    root = el('div', 'sg'); body.appendChild(root);
    wrap = el('div', 'sg-chart'); cv = el('canvas', 'sg-cv'); cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Storm graph'); wrap.appendChild(cv); root.appendChild(wrap);
    ctx = cv.getContext('2d');
    // legend
    const lg = el('div', 'sg-legend'); root.appendChild(lg); D.sw = {};
    [['rain', 'Rain', 'sg-sw rain'], ['qin', 'From upstream', 'sg-sw qin'], ['out', 'Leaving the ranch', 'sg-sw out'], ['ghost', 'Earlier storm', 'sg-sw ghost']].forEach((a) => {
      const it = el('span', 'sg-lg'); const sw = el('i', a[2]); it.appendChild(sw); it.appendChild(document.createTextNode(a[1])); lg.appendChild(it); D.sw[a[0]] = sw;
    });
    D.ghostLg = D.sw.ghost.parentNode; D.ghostTxt = D.ghostLg.lastChild;
    D.badge = el('div', 'sg-badge same'); root.appendChild(D.badge);
    D.badgeMain = el('div', 'sg-bm'); D.badgeSub = el('div', 'sg-bs'); D.badge.appendChild(D.badgeMain); D.badge.appendChild(D.badgeSub);
    // three number cards
    const cards = el('div', 'sg-cards'); root.appendChild(cards); D.card = [];
    for (let i = 0; i < 3; i++) {
      const cd = el('div', 'sg-card'), k = el('div', 'sg-k'), v = el('div', 'sg-v'), cc = el('div', 'sg-c'), vn = el('b'), vu = el('small');
      v.appendChild(vn); v.appendChild(vu); cd.appendChild(k); cd.appendChild(v); cd.appendChild(cc); cards.appendChild(cd); D.card.push({ k: k, vn: vn, vu: vu, c: cc });
    }
    D.note = el('div', 'sg-note'); root.appendChild(D.note);
    // where did the rain go
    D.rain = el('div', 'sg-rain'); root.appendChild(D.rain);
    D.rain.appendChild(el('h4', null, 'Where did the rain go?'));
    D.rainWhen = el('div', 'sg-rw'); D.rain.appendChild(D.rainWhen);
    D.bar = el('div', 'sg-bar'); D.rain.appendChild(D.bar); D.seg = [];
    for (let i = 0; i < 3; i++) { const s = el('span'); D.bar.appendChild(s); D.seg.push(s); }
    D.rl = []; const names = ['Soaked into the ground', 'Ran off and left the ranch', 'Held back (ponds, puddles) or not counted'];
    names.forEach((n, i) => { const row = el('div', 'sg-rl'), sw = el('i', 'sg-dot'), tx = el('span', null, n), pc = el('b'); sw.style.background = ''; row.appendChild(sw); row.appendChild(tx); row.appendChild(pc); D.rain.appendChild(row); D.rl.push({ sw: sw, pc: pc, row: row }); });
    D.rainNote = el('div', 'sg-rn', 'This counts only the rain that fell on your ranch. Water from upstream is left out, and we guess it acted the same way. It is a rough guess.'); D.rain.appendChild(D.rainNote);
    // history
    D.histBox = el('div', 'sg-hist'); root.appendChild(D.histBox);
    D.histBox.appendChild(el('h4', null, 'Your storms'));
    D.histHint = el('div', 'sg-hh'); D.histBox.appendChild(D.histHint);
    D.histList = el('div', 'sg-hl'); D.histBox.appendChild(D.histList);
    // empty state
    D.empty = el('div', 'sg-empty'); root.appendChild(D.empty);
    D.empty.appendChild(el('p', null, 'This graph shows how fast water runs out of your ranch, and whether your work slowed it down.'));
    const ul = el('ul'); ['A blue line for the water leaving your ranch', 'How many bathtubs of water leave every second at the peak', 'How much of the rain soaked into the ground', 'A faint line for an earlier storm, so you can compare'].forEach((t) => ul.appendChild(el('li', null, t)));
    D.empty.appendChild(ul);
    D.empty.appendChild(el('p', 'sg-em', 'Send a storm with a ☔ button on the right. Then change something and send the same size again.'));
  }

  /** Cards, comparison and header line: cheap enough to run while the storm runs (text is only written when it changed). */
  function refreshLive() {
    if (!root) return;
    const a = A, g = G;
    if (!a) return;
    const f = useCfs() ? CFS : 1, lv = !!a.live;
    const c0 = D.card[0], c1 = D.card[1], c2 = D.card[2];
    cached(c0.k, lv ? 'Biggest flow so far' : 'Biggest flow'); cached(c0.vn, num(a.peak * f)); cached(c0.vu, ' ' + unitName());
    const tubs = a.peak / BATH;
    cached(c0.c, tubs < 1 ? 'less than one bathtub of water a second' : 'about ' + about(tubs) + ' bathtubs of water every second');
    const pt = a.peakT; const mins = pt >= 90;
    cached(c1.k, lv ? 'Peak so far at' : 'Peak came at'); cached(c1.vn, mins ? String(pt / 60 < 10 ? +(pt / 60).toPrecision(2) : Math.round(pt / 60)) : String(Math.round(pt))); cached(c1.vu, mins ? ' min' : ' sec');
    cached(c1.c, 'after the rain began');
    const vol = lv ? a.vol : a.vol;
    cached(c2.k, lv ? 'Water out so far' : 'Water that left'); const pools = vol / POOL;
    cached(c2.vn, pools < 0.05 ? '0' : String(pools < 10 ? +pools.toPrecision(2) : Math.round(pools).toLocaleString('en-US'))); cached(c2.vu, ' big pools');
    cached(c2.c, num(vol) + ' m³, including water from upstream');
    // the badge
    const b = D.badge;
    let cls = 'same', main = '', sub = '';
    if (lv) {
      if (g) { main = 'Watching the storm…'; sub = 'The faint line is ' + gName + '.'; } else { main = 'Watching the storm…'; sub = 'When it ends, we count where the rain went.'; }
    } else if (g) {
      const d = compare(a, g); cls = d.cls; main = d.icon + ' ' + d.text;
      sub = 'Compared with ' + gName + '.' + (Math.abs(d.dv) >= 5 ? ' Total water out: ' + Math.round(Math.abs(d.dv)) + '% ' + (d.dv < 0 ? 'less' : 'more') + '.' : '');
    } else { main = 'Nothing to compare yet'; sub = 'After you change something, send the same size of storm again. The faint line will show the earlier one.'; }
    if (b._c !== cls) { b._c = cls; b.className = 'sg-badge ' + cls; }
    cached(D.badgeMain, main); cached(D.badgeSub, sub);
    cached(D.note, !lv && a.partial ? 'You skipped ahead, so this graph shows only part of the storm.' : '');
    D.note.style.display = D.note._v ? '' : 'none';
    D.ghostLg.style.display = g ? '' : 'none'; if (D.ghostTxt._v !== !!cmp) { D.ghostTxt._v = !!cmp; D.ghostTxt.nodeValue = cmp ? 'Compared storm' : 'Earlier storm'; }
    // header line (shown when the panel is rolled up)
    cached(D.stat, lv ? 'Storm running: ' + num(a.lqo * f) + ' ' + unitName() + ' out' : 'Peak ' + num(a.peak * f) + ' ' + unitName() + ' at ' + shortT(a.peakT));
  }

  function updateRain() {
    const a = A; if (!a) return;
    if (a.live) {
      D.rainWhen.textContent = 'We count it when the storm ends.'; D.bar.style.display = 'none'; D.rl.forEach((r) => { r.row.style.display = 'none'; }); D.rainNote.style.display = 'none'; return;
    }
    const s = split(a);
    D.bar.style.display = s ? '' : 'none'; D.rainNote.style.display = s ? '' : 'none';
    if (!s) { D.rainWhen.textContent = 'No rain numbers for this storm.'; D.rl.forEach((r) => { r.row.style.display = 'none'; }); return; }
    const mm = s.R / (C.mapW * C.mapH) * 1000;
    D.rainWhen.textContent = 'The ranch got ' + num(mm) + ' mm (' + num(mm / 25.4) + ' in) of rain: about ' + about(s.R / POOL) + ' big swimming pools of water.';
    const vals = [s.a, s.b, s.c];
    D.seg.forEach((e, i) => { e.style.width = vals[i] + '%'; e.textContent = vals[i] >= 14 ? vals[i] + '%' : ''; e.style.color = i === 2 ? 'var(--ink)' : '#fff'; });
    D.rl.forEach((r, i) => { r.row.style.display = ''; r.sw.style.background = [pal.moss, pal.out, pal.gold][i]; r.pc.textContent = vals[i] + '%'; });
    const g = G;
    if (g && g !== a) { const sg = split(g); if (sg) D.rainWhen.textContent += ' Earlier storm: ' + sg.a + '% soaked in.'; }
  }

  function buildHist() {
    const box = D.histList; box.textContent = '';
    if (!hist.length) { D.histBox.style.display = 'none'; return; }
    D.histBox.style.display = '';
    D.histHint.textContent = cmp ? 'Comparing two storms. Tap one again to stop comparing.' : armed ? 'Now tap a second storm to compare it.' : 'Tap a storm to look at it.';
    for (let i = hist.length - 1; i >= 0; i--) {
      const r = hist[i], b = el('button', 'sg-h' + (r === shown && !live.active ? ' sel' : '') + (r === cmp ? ' cmp' : ''));
      b.type = 'button'; b.dataset.i = String(i);
      b.appendChild(el('span', 'sg-pill', sizeLabel(r.size)));
      b.appendChild(el('span', 'sg-hw', label(r) || 'Storm ' + (i + 1)));
      b.appendChild(el('b', 'sg-hp', num(fq(r.peak)) + ' ' + unitName()));
      if (r === cmp) b.appendChild(el('span', 'sg-tag', 'compare')); else if (r === shown && !live.active) b.appendChild(el('span', 'sg-tag', 'showing'));
      b.onclick = safe('history tap', () => tapHist(r));
      box.appendChild(b);
    }
  }
  function tapHist(r) {
    if (live.active) return;
    if (cmp && (r === cmp || r === shown)) cmp = null;                                   // tap a compared storm again: stop comparing
    else if (armed && r !== shown && !cmp) { cmp = r; armed = false; }                  // second tap: compare
    else { shown = r; cmp = null; armed = true; }                                        // first tap: show it
    renderAll();
  }

  /** Everything that follows the choice of storm (not the live updates). */
  function renderAll() {
    if (!root) return;
    const has = !!(live.active || shown);
    D.empty.style.display = has ? 'none' : '';
    D.badge.style.display = D.rain.style.display = has ? '' : 'none';
    root.querySelector('.sg-cards').style.display = has ? '' : 'none';
    D.ghostLg.style.display = 'none';
    refreshModel(); refreshLive(); updateRain(); buildHist();
    if (!has) cached(D.stat, 'No storms yet');
    cv.setAttribute('aria-label', A ? (A.live ? 'Storm graph, storm running' : 'Storm graph: ' + sizeLabel(A.size) + ' storm, peak ' + num(fq(A.peak)) + ' ' + unitName() + ' at ' + shortT(A.peakT)) : 'Storm graph, no storms yet');
    dirty = true; if (panel.visible) { draw(); }
  }

  // ---------------------------------------------------------------- storm events
  function onStart(storm) {
    const L = live;
    L.active = true; L.size = storm.size; L.tag = storm.tag || null; L.year = game.year; L.season = game.season;
    L.n = 1; L.t[0] = 0; L.rain[0] = 0; L.Qin[0] = 0; L.Qout[0] = 0;
    L.peak = L.peakT = L.vol = L.up = L.maxQin = L.maxRain = L.lt = L.lr = L.lqi = L.lqo = L.lastT = 0;
    L.every = (C.stormBurst + C.stormTail) / 450; L.nextRec = L.every; liveY = 0; cursorT = null;
    if (set.get('stormgraph.auto', true) && !panel.visible) { panel.show(); autoOpened = true; }
    renderAll();
  }
  function onStep(s) {
    const L = live; if (!L.active) return;
    if (s.t >= L.nextRec && L.n < CAP - 2) { const k = L.n++; L.t[k] = s.t; L.rain[k] = s.rain; L.Qin[k] = s.Qin; L.Qout[k] = s.Qout; L.nextRec = s.t + L.every; }
    L.lt = s.t; L.lr = s.rain; L.lqi = s.Qin; L.lqo = s.Qout; L.lastT = s.t;
    L.vol += s.Qout * s.dt; L.up += s.Qin * s.dt;
    if (s.Qout > L.peak) { L.peak = s.Qout; L.peakT = s.t; }
    if (s.Qin > L.maxQin) L.maxQin = s.Qin;
    if (s.rain > L.maxRain) L.maxRain = s.rain;
    dirty = true;
  }
  function onEnd(res) {
    live.active = false;
    const r = fromResult(res);
    if (r) {
      r.year = game.year; r.season = game.season;
      if (hist.indexOf(r) < 0) { hist.push(r); while (hist.length > MAXHIST) hist.shift(); }
      shown = r; cmp = null; armed = false;
    }
    renderAll();
  }
  function onFrame() {
    if (!dirty || !panel.visible || !live.active) return;
    if (performance.now() - lastDraw >= LIVE_MS) tickDraw();
  }
  function onReset() {
    hist.length = 0; shown = null; cmp = null; armed = false; live.active = false; liveY = 0; cursorT = null;
    if (autoOpened && panel.visible) panel.hide();
    autoOpened = false; renderAll();
  }
  function adopt() {
    // storms the game already holds that we have not seen (the module was switched on late)
    (game.stormHistory || []).forEach((res) => { const r = fromResult(res); if (r && hist.indexOf(r) < 0) { r.year = r.year || game.year; r.season = r.season || game.season; hist.push(r); } });
    while (hist.length > MAXHIST) hist.shift();
    if (!shown && hist.length) shown = hist[hist.length - 1];
  }

  // ---------------------------------------------------------------- scrubbing the chart with a finger or mouse
  function scrubFrom(e) {
    if (!A) return;
    const x0 = PL, pw = cw - PL - PR, tEnd = tEndNow();
    cursorT = Math.max(0, Math.min(1, (e.offsetX - x0) / pw)) * tEnd; clearTimeout(scrubTimer);
    dirty = true; if (!scrubPending) { scrubPending = true; setTimeout(() => { scrubPending = false; if (dirty) tickDraw(); }, Math.max(0, SCRUB_MS - (performance.now() - lastDraw))); }
  }
  function scrubEnd(delay) { clearTimeout(scrubTimer); scrubTimer = setTimeout(() => { cursorT = null; dirty = true; want(0); }, delay); }

  // ---------------------------------------------------------------- set-up
  function resize(rect) {
    const w = Math.round(rect.width), h = Math.round(rect.height), d = Math.min(3, window.devicePixelRatio || 1);
    if (w === cw && h === ch && d === dpr) return;
    cw = w; ch = h; dpr = d;
    if (cw > 0 && ch > 0) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
    dirty = true; if (panel.visible && cw > 0) want(0);
  }

  Creek.registerModule({
    id: 'stormgraph',

    init: function (g, u) {
      game = g; ui = u;
      ui.styles(CSS());
      panel = ui.panel({
        id: 'stormgraph', title: '📈 Storm graph', corner: 'tr', closable: true,
        onShow: () => { if (btn) btn.classList.add('on'); readPalette(); if (wrap) resize(wrap.getBoundingClientRect()); dirty = true; if (cw > 0) tickDraw(); },
        onHide: () => { if (btn) btn.classList.remove('on'); autoOpened = false; }
      });
      buildDom(panel.body);
      // header: a line that shows when rolled up, the unit switch and the roll-up button
      const head = panel.el.querySelector('.phead'), x = head.querySelector('.px');
      D.stat = el('span', 'sg-stat'); head.insertBefore(D.stat, x);
      const unit = el('button', 'sg-unit'); unit.type = 'button'; unit.title = 'Switch between cubic metres per second and cubic feet per second';
      const u1 = el('span', null, 'm³/s'), u2 = el('span', null, 'cfs'); unit.appendChild(u1); unit.appendChild(u2);
      const showUnit = () => { u1.className = useCfs() ? '' : 'on'; u2.className = useCfs() ? 'on' : ''; };
      unit.onclick = safe('unit switch', () => set.set('stormgraph.cfs', !useCfs())); head.insertBefore(unit, x);
      const fold = el('button', 'sg-hb'); fold.type = 'button'; fold.setAttribute('aria-label', 'Roll the graph up or down');
      const showFold = () => { const m = !!set.get('stormgraph.min', false); panel.el.classList.toggle('sg-min', m); fold.textContent = m ? '▾' : '▴'; fold.title = m ? 'Open the graph' : 'Roll the graph up'; };
      fold.onclick = safe('roll up', () => { set.set('stormgraph.min', !set.get('stormgraph.min', false)); });
      head.insertBefore(fold, x);
      set.on('stormgraph.cfs', safe('units', () => { showUnit(); if (root) { renderAll(); } }));
      set.on('stormgraph.min', safe('roll', () => { showFold(); want(0); }));
      showUnit(); showFold(); readPalette(); cached(D.stat, 'No storms yet');

      btn = ui.addButton({ slot: 'view', id: 'stormgraphBtn', label: '📈 Graph', title: 'Show or hide the storm graph', toggle: true,
        onClick: (on) => { if (on) { if (set.get('stormgraph.min', false) && !live.active) set.set('stormgraph.min', false); panel.show(); } else panel.hide(); autoOpened = false; } });
      ui.addMenuItem({ label: '📈 Storm graph', onClick: () => { if (set.get('stormgraph.min', false)) set.set('stormgraph.min', false); panel.show(); autoOpened = false; } });
      Creek.shortcuts.add({ key: 'g', desc: 'Show or hide the storm graph', fn: () => { if (!game.ready) return false; panel.toggle(); autoOpened = false; } });
      ui.addSetting({ id: 'stormgraph.auto', label: 'Open the storm graph when a storm starts', help: 'You can always open it with the Graph button.', type: 'toggle', default: true });
      ui.addSetting({ id: 'stormgraph.cfs', label: 'Graph in cubic feet per second (cfs)', help: 'Off shows cubic metres per second (m³/s).', type: 'toggle', default: false });

      if (window.ResizeObserver) { new ResizeObserver(safe('resize', (es) => { resize(es[es.length - 1].contentRect); })).observe(wrap); }
      window.addEventListener('resize', safe('window resize', () => { const r = wrap.getBoundingClientRect(); resize(r); }));
      cv.addEventListener('pointerdown', safe('scrub', (e) => { try { cv.setPointerCapture(e.pointerId); } catch (_) { /* fine */ } scrubFrom(e); }));
      cv.addEventListener('pointermove', safe('scrub', (e) => { if (e.pointerType === 'mouse' || e.buttons) scrubFrom(e); }));
      cv.addEventListener('pointerup', safe('scrub', (e) => scrubEnd(e.pointerType === 'mouse' ? 0 : 1800)));
      cv.addEventListener('pointercancel', safe('scrub', () => scrubEnd(0)));
      cv.addEventListener('pointerleave', safe('scrub', (e) => { if (e.pointerType === 'mouse' && !e.buttons) scrubEnd(0); }));

      game.on('stormStart', safe('stormStart', onStart));
      game.on('stormStep', safe('stormStep', onStep));
      game.on('stormEnd', safe('stormEnd', onEnd));
      game.on('frame', safe('frame', onFrame));
      game.on('reset', safe('reset', onReset));
      game.registerState('stormgraph', {
        save: () => ({ v: 1, hist: hist.map(pack) }),
        load: safe('load', (j) => {
          hist.length = 0; cmp = null; armed = false; shown = null;
          if (j && Array.isArray(j.hist)) j.hist.slice(-MAXHIST).forEach((o) => { const r = unpack(o); if (r) hist.push(r); });
          shown = hist.length ? hist[hist.length - 1] : null; renderAll();
        })
      });
      renderAll();
    },

    // A new world (first start, or after a detail-level change): the old storms belong to the old ranch.
    ready: function () {
      if (live.active) return;
      hist.length = 0; shown = null; cmp = null; armed = false; adopt(); renderAll();
    }
  });

  // ---------------------------------------------------------------- public bits (for other modules and tests)
  Object.assign(mod, {
    show: function () { if (panel) panel.show(); return mod; }, hide: function () { if (panel) panel.hide(); return mod; }, toggle: function () { if (panel) panel.toggle(); return mod; },
    isOpen: function () { return !!(panel && panel.visible); },
    /** The storms on file, oldest first: [{size, label, peak (m3/s), peakT (s), volume (m3), soaked (0..1), points}] */
    history: function () { return hist.map((r) => ({ size: r.size, label: label(r), peak: r.peak, peakT: r.peakT, volume: r.vol, soaked: r.soak, points: r.n })); },
    /** What is on the chart now (numbers in m3/s, seconds, m3), or null. */
    current: function () { refreshModel(); if (!A) return null; return { live: !!A.live, size: A.size, peak: A.peak, peakT: A.peakT, volume: A.vol, upstreamVolume: A.up, points: A.live ? A.n : A.n, ghost: G ? { name: gName, peak: G.peak, peakT: G.peakT, volume: G.vol } : null, delta: A.live || !G ? null : compare(A, G), split: A.live ? null : split(A) }; },
    /** Show the i-th storm of history() (0 = oldest, -1 = newest). */
    select: function (i) { const r = hist[i < 0 ? hist.length + i : i]; if (r && !live.active) { shown = r; cmp = null; armed = true; renderAll(); } return !!r; },
    /** Compare the shown storm with the i-th of history() (null stops comparing). */
    compareWith: function (i) { if (i == null) cmp = null; else { const r = hist[i < 0 ? hist.length + i : i]; if (!r || r === shown) return false; cmp = r; armed = false; } renderAll(); return true; },
    setUnits: function (u) { set.set('stormgraph.cfs', u === 'cfs'); },
    redraw: function () { dirty = true; if (panel && panel.visible) tickDraw(); },
    stats: function () { return { draws: mod.drawCount, canvas: [cw, ch, dpr], history: hist.length, liveN: live.n }; }
  });

  // ---------------------------------------------------------------- look
  function CSS() { return [
    // where the panel sits: below the storm buttons on a phone (it must not cover the tool tray), at the left on a wide screen
    '.panel.corner-tr[data-panel="stormgraph"]{left:10px;right:10px;width:auto;top:calc(280px + var(--safe-t));max-height:max(150px,calc(100% - 280px - 150px - var(--safe-b)));display:flex;flex-direction:column}',
    '.panel[data-panel="stormgraph"].hidden{display:none}',
    '@media (min-width:600px){.panel.corner-tr[data-panel="stormgraph"]{left:10px;right:auto;width:410px;top:calc(130px + var(--safe-t));max-height:max(180px,calc(100% - 130px - 160px))}}',
    '.panel[data-panel="stormgraph"] .phead{flex:0 0 auto;gap:4px}',
    '.panel[data-panel="stormgraph"] .pbody{min-height:0;overflow:auto;overscroll-behavior:contain;padding:2px 10px 10px;-webkit-overflow-scrolling:touch}',
    '.panel[data-panel="stormgraph"].sg-min{max-height:none}',
    '.sg-stat{display:none;flex:1;min-width:0;font:12px system-ui,sans-serif;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
    '.sg-min .sg-stat{display:block}',
    '.sg-min .pbody{display:none}',
    '.sg-min .sg-unit{display:none}',
    '.panel[data-panel="stormgraph"] .phead b{white-space:nowrap}',
    '.sg-hb{flex:0 0 auto;background:transparent;color:var(--ink2);width:40px;height:40px;margin:-6px 0;font-size:16px}',
    '.sg-unit{flex:0 0 auto;margin:-6px 0 -6px auto;height:40px;min-width:48px;background:transparent;display:flex;align-items:center;gap:0;padding:0 2px}',
    '.sg-unit span{font:600 11px system-ui,sans-serif;padding:4px 7px;background:var(--paper2);color:var(--ink2)}',
    '.sg-unit span:first-child{border-radius:999px 0 0 999px}.sg-unit span:last-child{border-radius:0 999px 999px 0}',
    '.sg-unit span.on{background:var(--water);color:#fff}',
    '.sg-chart{position:relative;height:150px;margin:0 -2px}',
    '@media (min-width:600px){.sg-chart{height:190px}}',
    '.sg-cv{position:absolute;left:0;top:0;width:100%;height:100%;display:block;touch-action:pan-y;cursor:crosshair}',
    '.sg-legend{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:11px;color:var(--ink2);padding:2px 2px 6px}',
    '.sg-lg{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
    '.sg-sw{display:inline-block;width:16px;height:8px;border-radius:2px}',
    '.sg-sw.rain{border:1px solid}.sg-sw.out{height:5px;border-radius:3px}.sg-sw.ghost{height:3px;border-radius:2px}.sg-sw.qin{height:0;border-top:2px dashed;border-radius:0}',
    '.sg-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}',
    '.sg-card{background:var(--paper2);border-radius:10px;padding:6px 8px;min-width:0}',
    '.sg-k{font-size:10.5px;color:var(--ink2);line-height:1.2}',
    '.sg-v{font-family:Georgia,serif;line-height:1.25;margin:1px 0 2px;color:var(--ink)}.sg-v b{font-size:19px}.sg-v small{font:11px system-ui,sans-serif;color:var(--ink2)}',
    '.sg-c{font-size:10.5px;line-height:1.25;color:var(--ink2)}',
    '.sg-badge{margin-top:8px;border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.3}',
    '.sg-bm{font-weight:700}.sg-bs{font-size:11.5px;margin-top:2px;opacity:.85}',
    '.sg-badge.good{background:#e1ebcc;color:#38501f}.sg-badge.bad{background:#f2dccf;color:#80381f}.sg-badge.mix{background:#f7e6bd;color:#6f4c10}.sg-badge.same{background:var(--paper2);color:var(--ink2)}',
    '.sg-note{margin-top:6px;font-size:11.5px;color:var(--ink2);font-style:italic}',
    '.sg h4{font-family:Georgia,serif;font-size:14px;margin:12px 0 4px;color:var(--ink)}',
    '.sg-rw{font-size:11.5px;color:var(--ink2);margin-bottom:6px;line-height:1.3}',
    '.sg-bar{display:flex;height:24px;border-radius:12px;overflow:hidden;background:var(--paper2)}',
    '.sg-bar span{display:flex;align-items:center;justify-content:center;font:700 12px system-ui,sans-serif;min-width:0;transition:width .3s}',
    '.sg-rl{display:flex;align-items:center;gap:7px;font-size:12px;margin-top:4px;color:var(--ink)}',
    '.sg-rl span{flex:1;min-width:0}',
    '.sg-dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%}',
    '.sg-rn{font-size:11px;color:var(--ink2);margin-top:6px;line-height:1.3}',
    '.sg-hh{font-size:11.5px;color:var(--ink2);margin-bottom:2px}',
    '.sg-h{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;margin-top:4px;padding:4px 10px;background:var(--paper2);border-radius:10px;text-align:left;font-size:12.5px;color:var(--ink);position:relative}',
    '.sg-h.sel{background:#fff6dc;outline:2px solid var(--gold)}',
    '.sg-h.cmp{outline:2px dashed var(--ink2)}',
    '.sg-pill{flex:0 0 auto;background:var(--paper);border-radius:999px;padding:2px 8px;font-size:11.5px;font-weight:600}',
    '.sg-hw{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sg-hp{flex:0 0 auto;font-weight:600}',
    '.sg-tag{position:absolute;right:8px;top:2px;font-size:9.5px;color:var(--ink2);text-transform:uppercase;letter-spacing:.04em}',
    '.sg-empty{font-size:12.5px;line-height:1.4;color:var(--ink);padding:2px 2px 4px}.sg-empty p{margin:6px 0}.sg-empty ul{margin:4px 0 6px;padding-left:18px;color:var(--ink2)}.sg-empty li{margin:2px 0}.sg-em{color:var(--moss);font-weight:600}'
  ].join('\n'); }
})();
