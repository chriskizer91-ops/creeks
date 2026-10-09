/* Runs the river model on its own (no browser) and prints what it did. Usage: node tools/river-test.js [years] [seed] */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const ctx = { console, Math, Float32Array, Float64Array, Map, Set, Object, Array, JSON, Number, String };
ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['config', 'world', 'river-core', 'river-calib']) vm.runInContext(fs.readFileSync(path.join(root, 'src', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
const R = ctx.Creek.River;
exports.R = R; exports.ctx = ctx;
if (require.main === module) {
  const years = +process.argv[2] || 60, seed = +process.argv[3] || 11;
  let t = Date.now();
  const v = R.buildValley({ seed });
  console.log('valley built', Date.now() - t, 'ms; nodes', v.nodes.length, 'reaches', v.reaches.length);
  v.reaches.forEach((r) => console.log(' ', r.id.padEnd(10), r.name.padEnd(18), 'nodes', String(r.nodes.length).padStart(4), 'A at mouth', r.nodes[r.nodes.length - 1].A.toFixed(2), 'km2  bed', r.nodes[0].bed.toFixed(1), '->', r.nodes[r.nodes.length - 1].bed.toFixed(1)));
  console.log('outlet A', v.outlet.A.toFixed(1), 'km2; ranch exit A', v.ranch.exit.A.toFixed(2), 'km2 (', (v.ranch.exit.A * 247).toFixed(0), 'acres)');
  t = Date.now(); const m = new R.Model(v); console.log('model', Date.now() - t, 'ms');
  const show = (label) => {
    const rm = m.main.nodes.filter((n) => n.ranch), mid = rm[Math.floor(rm.length / 2)];
    const d = m.describe(mid), st = {}; m.nodes.forEach((n) => { st[n.stage] = (st[n.stage] || 0) + 1; });
    console.log(label, 'year', m.year, '| ranch mid: bank', d.bankHeight.toFixed(2), 'bench', d.benchWidth.toFixed(1) + '/' + d.benchDepth.toFixed(2), 'wb', d.bottomWidth.toFixed(1), 'top', d.topWidth.toFixed(1), 'bed', d.bed.toFixed(2), 'alluv', d.alluvium.toFixed(2), 'veg', d.veg.toFixed(2), 'stage', d.stage, 'type', d.type, 'sin', d.sinuosity.toFixed(2), '| stages', JSON.stringify(st), '| oxbows', m.oxbows.length, '| nodes', m.nodes.length);
  };
  show('start');
  t = Date.now();
  let bad = 0, exportF = 0, exportG = 0;
  for (let y = 0; y < years; y++) {
    const rep = m.stepYear();
    exportF += rep.exportFines; exportG += rep.exportGravel;
    m.nodes.forEach((n) => { for (const k of ['bed', 'fp', 'wb', 'x', 'y', 'bw', 'tAll', 'tSoil', 'veg', 'D50']) if (!Number.isFinite(n[k])) { bad++; } });
    if (bad) { console.log('NaN at year', y, 'stopping'); break; }
    if ((y + 1) % 10 === 0 || y === 0) show('  ');
    if (rep.cutoffs.length) console.log('   cutoffs', JSON.stringify(rep.cutoffs.map((c) => c.reach)));
  }
  console.log('ran', years, 'years in', Date.now() - t, 'ms; non-finite values', bad, '; exported fines', Math.round(exportF), 'm3, gravel', Math.round(exportG), 'm3');
  // bed change along the main stem
  const prof = m.main.nodes.filter((n, i) => i % 25 === 0).map((n) => { const i0 = m.initial.get(n.id); return (n.ranch ? '*' : ' ') + (n.bed - (i0 ? i0.bed : n.bed)).toFixed(2); });
  console.log('bed change along main (every 25th node, * = ranch):', prof.join(' '));
}
