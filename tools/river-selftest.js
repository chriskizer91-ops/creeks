/* Checks for the river-scale model (src/river-core.js), in plain Node. Usage:  node tools/river-selftest.js
   It runs the model for decades under different conditions and checks that it behaves the way streams do:
   healthy creeks stay put, a weir fills in above itself, planting slows bank loss, straightening makes a creek dig, and so on.
   Each check prints PASS or FAIL with the numbers. The exit code is the number of failures. Takes about a minute. */
'use strict';
const { R } = require('./river-test.js');
let fails = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  (' + info + ')' : '')); if (!ok) fails++; };
const valley = R.buildValley({ seed: 11 });
const mk = (opts, params) => new R.Model(valley, Object.assign({ seed: 7 }, opts, { params: params }));
const ranchOf = (m) => m.main.nodes.filter((n) => n.ranch);
const topW = (n) => R.topWidth(n);
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
const finite = (m) => m.nodes.every((n) => ['bed', 'fp', 'wb', 'x', 'y', 'bw', 'tAll', 'tSoil', 'veg', 'D50', 'm'].every((k) => Number.isFinite(n[k])));
const topology = (m) => { let bad = 0; m.nodes.forEach((n) => { if (n.down && !n.down.ups.includes(n)) bad++; n.ups.forEach((u) => { if (u.down !== n) bad++; }); if (!m.byId.has(n.id)) bad++; }); return bad; };

// ---- 1. basics
{
  const a = mk(), b = mk();
  a.runYears(8); b.runYears(8);
  check('same seed, same years', a.nodes.every((n, i) => n.bed === b.nodes[i].bed && n.x === b.nodes[i].x), 'identical beds and positions');
  const c = mk({ seed: 8 }); c.runYears(8);
  check('different seed, different floods', c.nodes.some((n, i) => Math.abs(n.bed - a.nodes[i].bed) > 1e-4));
}
// ---- 2. a long run stays sane
{
  const m = mk(); const t0 = Date.now(); m.runYears(100);
  check('100 years: no broken numbers', finite(m));
  check('100 years: network still joined up', topology(m) === 0, topology(m) + ' broken links');
  let rising = 0; m.nodes.forEach((n) => { if (n.down && n.down.reach === n.reach && n.bed < n.down.bed - 0.5) rising++; });
  check('100 years: no creek runs uphill by more than 1.5 ft', rising === 0, rising + ' nodes');
  check('100 years: widths and bank heights sensible', m.nodes.every((n) => n.wb >= 0.3 && n.wb < 120 && R.trench(n) < 15 && R.trench(n) > 0.1 && topW(n) < 400));
  console.log('      100 years took ' + (Date.now() - t0) + ' ms');
}
// ---- 3. healthy creeks stay put
{
  const m = mk({ natural: true }); const b0 = new Map(m.nodes.map((n) => [n.id, n.bed])); m.runYears(40);
  const big = m.nodes.filter((n) => n.A > 2 && !n.ranch);
  const drift = mean(big.filter((n) => b0.has(n.id)).map((n) => Math.abs(n.bed - b0.get(n.id))));
  check('a natural valley holds still (mean bed change over 40 years below 0.65 ft for streams over 500 acres)', drift < 0.2, (drift * 3.281).toFixed(2) + ' ft');
  const st = {}; m.main.nodes.forEach((n) => { st[n.stage] = (st[n.stage] || 0) + 1; });
  check('a natural main creek is mostly steady (stage I or V)', ((st.I || 0) + (st.V || 0)) / m.main.nodes.length > 0.6, JSON.stringify(st));
}
// ---- 4. save and load
{
  const a = mk(); a.runYears(12);
  const json = JSON.parse(JSON.stringify(a.toJSON()));
  const b = R.Model.fromJSON(valley, json);
  check('load: same year and node count', b.year === a.year && b.nodes.length === a.nodes.length, 'year ' + b.year + ', nodes ' + b.nodes.length);
  check('load: network joined up', topology(b) === 0);
  a.runYears(6); b.runYears(6);
  const dBed = Math.max(...a.main.nodes.map((n) => { const o = b.byId.get(n.id); return o ? Math.abs(o.bed - n.bed) : 9; }));
  check('load: a saved valley carries on the same way (beds within 4 in after 6 more years)', dBed < 0.1, 'largest difference ' + (dBed * 39.37).toFixed(1) + ' in');
}
// ---- 5. tools
const AFTER = 40;
{
  const base = mk(); base.runYears(AFTER);
  // weir: gravel piles up above it
  const w = mk(); const rn = ranchOf(w), wn = rn[24]; w.addStructure(wn, 'weir'); w.runYears(AFTER);
  const bn = base.byId.get(wn.id), upN = (m, id) => { let n = m.byId.get(id); for (let i = 0; i < 3 && n.ups[0]; i++) n = n.ups[0]; return n; };
  const dUp = upN(w, wn.id).bed - upN(base, wn.id).bed;
  check('a rock weir raises the bed above it', dUp > 0.1, '+' + (dUp * 3.281).toFixed(1) + ' ft three nodes up');
  // planting: roots hold the banks and start a bench, so the creek heals sooner
  const p = mk(); p.plant(ranchOf(p), 1); p.runYears(AFTER + 10);
  const b2 = mk(); b2.runYears(AFTER + 10);
  const healed = (m) => ranchOf(m).filter((n) => n.stage === 'V').length / ranchOf(m).length;
  check('planting heals the ranch stretch sooner than leaving it alone', healed(p) > healed(b2), 'healed share after ' + (AFTER + 10) + ' years: planted ' + healed(p).toFixed(2) + ', alone ' + healed(b2).toFixed(2));
  check('planting raises plant cover', mean(ranchOf(p).map((n) => n.veg)) > mean(ranchOf(b2).map((n) => n.veg)) + 0.05);
  // benching: the trench is lowered
  const bq = mk(); const stretch = ranchOf(bq).slice(4, 30); const h0 = mean(stretch.map(R.trench)); bq.lowerBanks(stretch); bq.runYears(20);
  check('benching lowers the banks', mean(stretch.map(R.trench)) < h0 - 0.5, (h0 * 3.281).toFixed(1) + ' ft -> ' + (mean(stretch.map(R.trench)) * 3.281).toFixed(1) + ' ft');
  check('a benched stretch is no longer cut down', stretch.every((n) => !['II', 'III'].includes(n.stage)) || mean(stretch.map((n) => (n.stage === 'II' || n.stage === 'III' ? 1 : 0))) < 0.5, stretch.map((n) => n.stage).join(''));
  // straightening makes it steeper and it digs
  const sg = mk(); let st = null; for (const q of sg.main.nodes) { if (q.y < 9000 || q.ranchArc >= 0) continue; const c = sg.clearStretch(q, 14); if (sg.canReshape(c)) { st = c; break; } }
  if (st) {
    const ids = st.map((n) => n.id), len0 = st.reduce((s, n) => s + n.len, 0), S0 = mean(st.map((n) => n._S));
    sg.straighten(st); const len1 = st.reduce((s, n) => s + n.len, 0);
    check('straightening shortens the creek', len1 < len0 - 5, Math.round(len0) + ' m -> ' + Math.round(len1) + ' m');
    check('straightening makes it steeper', mean(st.map((n) => n._S)) > S0 * 1.001, (S0 * 100).toFixed(3) + '% -> ' + (mean(st.map((n) => n._S)) * 100).toFixed(3) + '%');
    sg.runYears(30); check('after straightening the model still runs clean', finite(sg) && topology(sg) === 0);
    // new bends: longer and gentler
    const nb = mk(); let st2 = null; for (const q of nb.main.nodes) { if (q.y < 9000 || q.ranchArc >= 0) continue; const c = nb.clearStretch(q, 14); if (nb.canReshape(c)) { st2 = c; break; } }
    const l0 = st2.reduce((s, n) => s + n.len, 0); const gained = nb.reMeander(st2, 1.45);
    check('new bends make the creek longer', gained > 20, '+' + Math.round(gained) + ' m of channel');
    nb.runYears(20); check('after new bends the model still runs clean', finite(nb) && topology(nb) === 0);
  } else check('found a clear stretch to reshape', false);
  // the ranch's own course cannot be reshaped (it is on the ranch map)
  check('the ranch creek cannot be reshaped from the valley view', !mk().canReshape(ranchOf(mk())));
}
// ---- 6. the big river cuts down: a wave of digging runs upstream
{
  const base = mk(), drop = mk(); drop.baseLevel(1.2); base.runYears(40); drop.runYears(40);
  const near = (m) => { const ns = m.main.nodes; return ns[ns.length - 6]; }, far = (m) => { const ns = m.main.nodes; return ns[ns.length - 80]; };
  const dNear = near(drop).bed - near(base).bed, dFar = far(drop).bed - far(base).bed;
  check('a drop at the valley mouth is felt near the mouth', dNear < -0.15, (dNear * 3.281).toFixed(1) + ' ft');
  check('...and less far upstream (the wave fades)', dFar > dNear, 'far ' + (dFar * 3.281).toFixed(1) + ' ft');
}
// ---- 7. weather and the ranch
{
  const dry = mk({}, { climate: 0.8 }), wet = mk({}, { climate: 1.25 }); dry.runYears(25); wet.runYears(25);
  const ex = (m) => m.series.reduce((s, r) => s + r.exportFines, 0);
  check('wetter years move more mud', ex(wet) > ex(dry), Math.round(ex(dry)) + ' vs ' + Math.round(ex(wet)) + ' m3');
  const a = mk(), b = mk(); b.setRanchInputs({ peakCut: 0.25 });
  const peakBelow = (m) => { const n = m.main.nodes.find((q) => q.belowRanch && q.A > 12); m._flowFactors(); return n.qf; };
  check('peak cuts on the ranch lower the flow below it', peakBelow(b) < peakBelow(a) - 0.005, peakBelow(a).toFixed(3) + ' -> ' + peakBelow(b).toFixed(3));
}
// ---- 8. bends and cutoffs
{
  const m = mk(); const s0 = (ns) => { let L = 0; for (let i = 0; i < ns.length - 1; i++) L += ns[i].len; return L / Math.hypot(ns[0].x - ns[ns.length - 1].x, ns[0].y - ns[ns.length - 1].y); };
  const dn = (mm) => mm.main.nodes.slice(Math.floor(mm.main.nodes.length * 0.7));
  const a = s0(dn(m)); m.runYears(120); const b = s0(dn(m));
  check('the winding lower creek gets more winding over 120 years', b > a + 0.03, a.toFixed(3) + ' -> ' + b.toFixed(3));
  // a hairpin that nearly closes is cut off and becomes an oxbow
  const q = mk(); const ns = q.main.nodes; let i0 = 100; for (let c = ns.length - 60; c > 60; c--) { let ok = true; for (let k = -2; k < 30; k++) if (ns[c + k].ups.length > 1) ok = false; if (ok) { i0 = c; break; } }
  const base = ns[i0], w = topW(base);
  for (let k = 0; k < 24; k++) { const n = ns[i0 + k]; if (k < 12) { n.x = base.x + k * 40; n.y = base.y; } else { n.x = base.x + (23 - k) * 40; n.y = base.y + 0.4 * w; } }
  q.nodes.forEach((n) => { n.len = n.down ? Math.hypot(n.down.x - n.x, n.down.y - n.y) : n.len; });
  const n0 = q.nodes.length, rep = { cutoffs: [], notes: [], bankErosion: 0 }; q._cutoffs(rep);
  check('a pinched-off loop becomes an oxbow lake', rep.cutoffs.length === 1 && q.oxbows.length === 1 && q.nodes.length < n0 - 10, q.nodes.length + ' nodes left of ' + n0);
  check('...and the network is still joined up', topology(q) === 0); q.runYears(5); check('...and still runs', finite(q));
}
// ---- 9. the ranch reach heals the way the textbook says, and faster with help
{
  const base = mk(); base.runYears(80);
  const help = mk(); const rn = ranchOf(help); help.plant(rn, 1); help.lowerBanks(rn); help.runYears(80);
  const share = (m, stages) => ranchOf(m).filter((n) => stages.includes(n.stage)).length / ranchOf(m).length;
  check('left alone, the ranch stretch is not worse after 80 years', share(base, ['III', 'II']) <= share(mk(), ['III', 'II']) + 0.05, 'cut-down share ' + share(base, ['II', 'III']).toFixed(2));
  check('with benching and planting, the ranch stretch is healthier', share(help, ['I', 'V', 'IV']) >= share(base, ['I', 'V', 'IV']), 'helped ' + share(help, ['I', 'IV', 'V']).toFixed(2) + ' vs alone ' + share(base, ['I', 'IV', 'V']).toFixed(2));
}
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails);
