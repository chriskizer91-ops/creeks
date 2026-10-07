#!/usr/bin/env node
/* Smoke test for Creek Care: loads the game in headless Chromium (software GL) and checks the standard things.
   Usage:  node tools/smoke.js [root] [extra query, e.g. "mods=example"]
     root   folder to serve (default: the repo root). Point it at a git worktree or an export of any commit.
   Prints one PASS or FAIL line per check, then a total. Exit code 1 if anything failed.
   Set ONLY=<word> to run just the sections whose name contains it (free play, extension API, storm controls, story opening, missing module).
   Screenshots go to /tmp/creek-work/smoke/. Uses tools/testlib.js (level 3, short storms, never level 0/1).
   Checks that rely on the extension API (events, series...) are skipped with a note when the API is not there. */
'use strict';
const path = require('path');
const T = require('./testlib.js');

const root = path.resolve(process.argv[2] || T.REPO);
const extra = process.argv[3] ? '&' + process.argv[3].replace(/^[?&]/, '') : '';
const DIR = '/tmp/creek-work/smoke';
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && detail !== '' ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : ''));
  return ok;
}
function note(text) { console.log('NOTE ' + text); }
const clean = (t) => t.errors.slice();
/** Remove console errors that a test caused on purpose (so they do not count as failures). Returns how many were removed. */
function dropErrors(t, re) { const n = t.errors.length; t.errors = t.errors.filter((e) => !re.test(e)); return n - t.errors.length; }

async function freePlay() {
  const t = await T.open({ root, query: 'level=3&quick=1&free=1' + extra, dir: DIR });
  try {
    await t.sleep(800);
    const info = await t.eval(() => ({
      level: game.level, nx: game.sim.nx, ny: game.sim.ny, fields: game.fields.length, ready: game.ready, mode: Creek.ui.mode,
      burst: Creek.CONFIG.stormBurst, tail: Creek.CONFIG.stormTail, hasApi: typeof game.on === 'function',
      mods: Creek.enabledModules || [], modErrors: (Creek.moduleErrors || []).length, tools: Creek.TOOLS.map(x => x.id)
    }));
    check('free play loads at level 3', info.ready && info.level === 3 && info.nx === 350 && info.fields > 5 && info.mode === 'free', info);
    check('?quick=1 shortens storms', info.burst === 150 && info.tail === 90, { burst: info.burst, tail: info.tail });
    check('no console or page errors after loading', t.errors.length === 0, clean(t));
    if (info.mods.length) check('modules started without errors (' + info.mods.join(', ') + ')', info.modErrors === 0);
    await t.shot('01-free-play');
    const api = info.hasApi;

    // ---- every tool, through the real mouse. Each tool is tried at a different spot near Plum Creek.
    const centre = await t.eval(() => { const s = game.world.meta.streams[0], p = s.pts[Math.floor(s.pts.length * 0.45)]; return { x: p[0], y: p[1] }; });
    const toolList = await t.eval(() => Creek.TOOLS.map(x => ({ id: x.id, kind: x.kind, opts: x.opts ? x.opts.map(o => ({ id: o.id, kind: o.kind || x.kind })) : null })));
    let k = 0;
    for (const tool of toolList) {
      const variants = tool.opts ? tool.opts.map((o, i) => ({ opt: i, kind: o.kind, name: tool.id + '/' + o.id })) : [{ opt: null, kind: tool.kind, name: tool.id }];
      for (const v of variants) {
        k++;
        const before = await t.eval(([id, opt, c, k]) => {
          const g = window.game; g.allowed = null;
          const ok = g.setTool(id, opt);
          let target = { x: c.x + (k % 5) * 30 - 60, y: c.y + Math.floor(k / 5) * 30 - 30 };
          if (id === 'fields') {                                  // a field that is not already using this land use
            const optId = Creek.TOOLS.find(x => x.id === id).opts[opt].id, f = g.fields.filter(f => f.kind === 'field' && f.use !== optId)[k % 3];
            target = { x: f.cx, y: f.cy };
          }
          g.focusOn(target.x, target.y, 3);
          return { ok, version: g.terrainVersion, cash: g.cash, target, fieldUse: g.fields.map(f => f.use).join() };
        }, [tool.id, v.opt, centre, k]);
        await t.frames(2);
        const px = await t.world(before.target.x, before.target.y);
        const gesture = v.kind === 'paint' || v.kind === 'custom' ? 'drag' : 'tap';
        if (gesture === 'drag') await t.drag([{ x: px.x - 40, y: px.y }, { x: px.x + 40, y: px.y + 10 }], { steps: 6 });
        else await t.tap(px.x, px.y);
        await t.frames(2);
        const after = await t.eval(() => { const g = window.game; if (Creek.ui && !document.getElementById('modal').classList.contains('hidden')) Creek.ui.closeCard(); return { stroke: !!g.stroke, version: g.terrainVersion, cash: g.cash, fieldUse: g.fields.map(f => f.use).join(), tool: g.tool }; });
        const changes = v.kind === 'paint' || v.kind === 'stamp';
        const good = before.ok && !after.stroke && after.tool === tool.id && (!changes || !api || after.version > before.version || after.fieldUse !== before.fieldUse);
        check('tool ' + v.name + ' works', good, good ? '' : { before, after });
      }
    }
    check('no errors while using the tools', t.errors.length === 0, clean(t));
    check('undo works', await t.eval(() => { game.snapshotForUndo(); game.sim.applyTool(1, 700, 700, 6, 1, 0, 0); return game.undo() === true; }));

    // ---- a season passes
    const s0 = await t.eval(() => ({ season: game.season, year: game.year }));
    const sres = await t.eval(() => { let ev = null; if (game.on) game.on('season', (e) => { ev = e; }); const r = game.advanceSeason(); return { next: r.next, passing: r.passing, net: r.net, season: game.season, year: game.year, ev }; });
    check('advanceSeason moves summer to fall', s0.season === 'summer' && sres.passing === 'summer' && sres.next === 'fall' && sres.season === 'fall', sres);
    if (api) check('"season" event fires with its details', !!sres.ev && sres.ev.season === 'fall' && sres.ev.passing === 'summer' && typeof sres.ev.net === 'number', sres.ev);

    // ---- a storm
    const v0 = await t.eval(() => game.terrainVersion);
    if (api) await t.eval(() => {      // listen to the storm, and watch the weather numbers while it runs
      const w = window.__storm = { start: 0, steps: 0, first: null, last: null, end: null, maxRain: 0, maxFlash: 0, bad: 0, same: game.extras.weather === game.weather, frames: 0 };
      game.on('stormStart', () => { w.start++; });
      game.on('stormStep', (s) => { w.steps++; if (!w.first) w.first = s; w.last = s; });
      game.on('stormEnd', (r) => { w.end = { size: r.size, series: r.series, histLen: game.stormHistory.length, last: game.lastStorm === r }; });
      game.on('frame', () => { w.frames++; const x = game.weather; w.maxRain = Math.max(w.maxRain, x.rain); w.maxFlash = Math.max(w.maxFlash, x.flash); if (!(x.rain >= 0 && x.rain <= 1 && x.flash >= 0 && x.flash <= 1)) w.bad++; });
    });
    let storm = null;
    try { storm = await t.quickStorm(10, { timeout: 240000 }); } catch (e) { check('quick storm finishes', false, String(e.message || e)); }
    if (storm) {
      check('quick storm finishes with sensible numbers', storm.peakOut > 0 && storm.rainVol > 0 && storm.soakShare > 0 && storm.soakShare < 1, storm);
      if (api) {
        check('storm result carries a thinned series', storm.seriesPoints >= 3 && storm.seriesPoints <= 400 && storm.lastT > 200, { points: storm.seriesPoints, lastT: storm.lastT });
        const h = await t.eval((v) => ({ hist: game.stormHistory.length, version: game.terrainVersion > v, weather: JSON.stringify(game.weather) }), v0);
        check('stormHistory and terrainVersion updated', h.hist === 1 && h.version, h);
        check('weather is 0 between storms', h.weather === '{"rain":0,"flash":0}', h.weather);
        const w = await t.eval(() => window.__storm), ser = w.end && w.end.series, nums = (o) => ['t', 'dt', 'rain', 'Qin', 'Qout', 'mudQ', 'size'].every((k) => typeof o[k] === 'number' && isFinite(o[k]));
        check('stormStart and stormEnd events fire once each', w.start === 1 && !!w.end && w.end.size === 10 && w.end.last && w.end.histLen === 1, { start: w.start, end: !!w.end });
        check('stormStep carries t, dt, rain, Qin, Qout, mudQ, size', w.steps > 10 && !!w.first && nums(w.first) && nums(w.last) && w.last.t > w.first.t && w.last.size === 10 && w.first.Qin > 0, { steps: w.steps, first: w.first });
        check('series has t, rain, Qin, Qout of equal length, rising time', !!ser && ['t', 'rain', 'Qin', 'Qout'].every((k) => Array.isArray(ser[k]) && ser[k].length === ser.t.length) && ser.t[0] === 0 && ser.t.every((x, i) => i === 0 || x > ser.t[i - 1]) && Math.max.apply(null, ser.rain) > 0, ser && { n: ser.t.length });
        check('weather rises to 1 in the storm, stays within 0..1, shares game.extras', w.maxRain > 0.5 && w.bad === 0 && w.same, { maxRain: w.maxRain, maxFlash: w.maxFlash, bad: w.bad, same: w.same });
      }
      await t.sleep(300);
      await t.shot('02-after-storm');
    }
    check('no errors after the storm', t.errors.length === 0, clean(t));
  } finally { await t.close(); }
}

/** The extension API (events, settings, shortcuts, lenses, custom tools, view provider, sim helpers, UI helpers).
    Runs on a phone-sized touch page. Skipped when the root has no extension API. */
async function apiChecks() {
  const t = await T.open({ root, query: 'level=3&quick=1&free=1' + extra, viewport: { width: 360, height: 740 }, touch: true, dir: DIR });
  try {
    if (!(await t.eval(() => typeof window.game.on === 'function'))) { note('no extension API in this root: skipping the API checks'); return; }
    await t.sleep(500);
    const cdp = await t.page.context().newCDPSession(t.page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });

    // ---- events, settings
    const ev = await t.eval(() => {
      const g = window.game, o = {}; let n = 0; const f = () => n++;
      const off = g.on('x1', f); g.emit('x1'); const a = n; off(); g.emit('x1'); o.onOff = a === 1 && n === 1;
      g.once('x2', f); g.emit('x2'); g.emit('x2'); o.once = n === 2;
      const seen = []; g.on('x3', () => { throw new Error('boom'); }); g.on('x3', (v) => seen.push(v)); g.emit('x3', 7); o.isolated = seen[0] === 7;
      const S = Creek.settings; let heard = null; const so = S.on('smoke.k', (v, k) => { heard = [v, k]; });
      S.set('smoke.k', 5); o.got = S.get('smoke.k', 0); S.set('smoke.k', 5); S.set('smoke.k', 6); so(); S.set('smoke.k', 7);
      o.heard = heard; o.stored = JSON.parse(localStorage.getItem('creek.settings'))['smoke.k']; o.dflt = S.get('smoke.none', 'dflt'); S.set('smoke.k', undefined); o.gone = !S.has('smoke.k');
      return o;
    });
    check('game.on / off / once / emit work and a throwing listener does not stop the others', ev.onOff && ev.once && ev.isolated, ev);
    dropErrors(t, /listener threw/);
    check('Creek.settings get / set / on persist to localStorage', ev.got === 5 && ev.heard && ev.heard[0] === 6 && ev.heard[1] === 'smoke.k' && ev.stored === 7 && ev.dflt === 'dflt' && ev.gone, ev);

    // ---- module state for the save system
    const st = await t.eval(() => { let loaded = null; game.registerState('smoke', { save: () => ({ a: 1 }), load: (j) => { loaded = j; } }); const c = game.collectState(); game.applyState({ smoke: { a: 2 } }); return { c: c.smoke, loaded }; });
    check('registerState / collectState / applyState', st.c && st.c.a === 1 && st.loaded && st.loaded.a === 2, st);

    // ---- keyboard shortcuts
    await t.eval(() => { window.__q = 0; Creek.shortcuts.add({ key: 'q', desc: 'Smoke test key', fn: () => { window.__q++; } }); });
    await t.press('q'); await t.press('Q');
    await t.eval(() => { const i = document.createElement('input'); i.id = 'smokeInput'; document.body.appendChild(i); i.focus(); });
    await t.press('q');
    await t.eval(() => { document.getElementById('smokeInput').remove(); Creek.ui.card({ title: 'Smoke card', buttons: [{ label: 'ok' }] }); });
    await t.press('q'); await t.press('2');
    await t.eval(() => Creek.ui.closeCard());
    const q1 = await t.eval(() => ({ q: window.__q, tool: game.tool }));
    check('shortcuts fire, but not while typing or while a card is open', q1.q === 2 && q1.tool === 'look', q1);
    await t.press('2');
    const k2 = await t.eval(() => { const was = game.contourOn; return { tool: game.tool, was }; });
    await t.press('l'); await t.press('l'); await t.press('v');
    const k3 = await t.eval(() => ({ lines: game.contourOn, lens: game.lensIdx }));
    await t.press('?');
    const help = await t.eval(() => ({ title: (document.querySelector('#card h2') || {}).textContent, text: document.getElementById('card').textContent }));
    await t.eval(() => { Creek.ui.closeCard(); game.setLens('map'); game.setTool('look'); });
    check('built-in keys: 2 picks the second tool, L toggles lines, V cycles views, ? lists the keys', k2.tool === 'dig' && k3.lines === k2.was && k3.lens === 1 && help.title === 'Keyboard shortcuts' && /Smoke test key/.test(help.text) && /Undo/.test(help.text), { k2, k3, help: help.title });

    // ---- lenses
    const ln = await t.eval(() => {
      const g = window.game, log = [], evs = []; g.on('lens', (id) => evs.push(id));
      g.addLens({ id: 'smokelens', label: 'Smoke lens', toast: 'hi', activate: () => log.push('on'), deactivate: () => log.push('off') });
      const ids = g.lenses.map((l) => l.id), btn = document.getElementById('btnLens');
      g.setLens('smokelens'); const a = { lens: g.lens, idx: g.lensIdx, label: btn.textContent, on: btn.classList.contains('on') };
      g.setLens('soil'); const b = { lens: g.lens, label: btn.textContent }; g.setLens('map');
      const log0 = log.slice(), evs0 = evs.slice();
      let n = 0; do { g.nextLens(); n++; } while (g.lensIdx !== 0 && n < 20);
      return { ids, log: log0, evs: evs0, a, b, cycle: n, btn: btn.textContent };
    });
    check('lens registry: built-ins first, module lens keeps renderer lens 0, button follows, "lens" event fires', ln.ids.slice(0, 4).join() === 'map,soil,moved,flood' && ln.ids[ln.ids.length - 1] === 'smokelens' && ln.log.join() === 'on,off' && ln.evs.slice(0, 3).join() === 'smokelens,soil,map' && ln.a.lens === 0 && ln.a.idx === ln.ids.length - 1 && ln.a.label === 'Smoke lens' && ln.a.on && ln.b.lens === 1 && ln.b.label.indexOf('Soil') >= 0 && ln.cycle === ln.ids.length && ln.btn.indexOf('Map') >= 0, ln);

    // ---- UI helpers
    const ui1 = await t.eval(() => {
      const ui = Creek.ui, o = {};
      const b1 = ui.addButton({ slot: 'view', id: 'smokeView', label: '🧪 View', toggle: true, onClick: (on) => { window.__tg = on; } });
      const b2 = ui.addButton({ slot: 'top', id: 'smokeTop', label: '⏯', title: 'Smoke top', onClick: () => { window.__top = (window.__top || 0) + 1; } });
      b1.click(); b2.click(); o.viewParent = b1.parentNode.id; o.topParent = b2.parentNode.id; o.toggled = window.__tg === true && b1.classList.contains('on'); o.top = window.__top === 1;
      o.again = ui.addButton({ slot: 'view', id: 'smokeView', label: 'x' }) === b1;
      const p = ui.panel({ id: 'smokePanel', title: 'Smoke panel', corner: 'bl', closable: true }); p.body.textContent = 'hello'; p.show();
      o.panel = p.visible && !p.el.classList.contains('hidden') && ui.panel({ id: 'smokePanel' }) === p;
      p.el.querySelector('.px').click(); o.panelClosed = !p.visible && p.el.classList.contains('hidden');
      for (let i = 0; i < 6; i++) ui.addButton({ slot: 'view', id: 'smokeV' + i, label: '🧪 Chip number ' + i });
      const row = document.getElementById('topbar2'), rr = row.getBoundingClientRect(), sb = document.getElementById('stormbar').getBoundingClientRect();
      o.scrolls = row.scrollWidth > row.clientWidth; o.rowRight = Math.round(rr.right); o.stormLeft = Math.round(sb.left); o.noOverflowX = document.documentElement.scrollWidth <= innerWidth;
      return o;
    });
    check('ui.addButton (view + top slots, toggle), ui.panel, repeat ids give the same element', ui1.viewParent === 'topbar2' && ui1.topParent === 'topRight' && ui1.toggled && ui1.top && ui1.again && ui1.panel && ui1.panelClosed, ui1);
    check('view chip row scrolls sideways at 360 px instead of running under the storm buttons', ui1.scrolls && ui1.rowRight <= ui1.stormLeft && ui1.noOverflowX, ui1);
    await t.shot('06-phone-crowded-chips');
    await t.eval(() => { for (let i = 0; i < 6; i++) document.getElementById('smokeV' + i).remove(); document.querySelector('[data-panel="smokePanel"]').remove(); });

    const set = await t.eval(() => {
      const ui = Creek.ui; window.__mi = 0;
      ui.addMenuItem({ label: 'Smoke menu item', onClick: () => { window.__mi++; } });
      ui.addSetting({ id: 'smoke.toggle', label: 'Smoke toggle', type: 'toggle', default: false });
      ui.addSetting({ id: 'smoke.slider', label: 'Smoke slider', type: 'slider', min: 0, max: 10, step: 1, default: 3 });
      ui.addSetting({ id: 'smoke.choice', label: 'Smoke choice', type: 'choice', options: ['one', 'two', { value: 3, label: 'three' }], default: 'one' });
      ui.menu(); return true;
    });
    await t.page.waitForSelector('#card .btns button:has-text("Smoke menu item")');
    const menuLabels = await t.eval(() => [...document.querySelectorAll('#card .btns button')].map((b) => b.textContent));
    await t.page.click('#card .btns button:has-text("Smoke menu item")');
    await t.eval(() => { Creek.ui.menu(); });                       // (not returned: it resolves only when the card is closed)
    await t.page.click('#card .btns button:has-text("Settings")');
    await t.page.waitForSelector('#card .srow');
    await t.page.click('#card .srow:has-text("Smoke toggle") .sw');
    await t.page.click('#card .srow:has-text("Smoke choice") .schoice button:has-text("two")');
    await t.eval(() => { const r = [...document.querySelectorAll('#card .srow')].find((x) => /Smoke slider/.test(x.textContent)).querySelector('input'); r.value = 7; r.dispatchEvent(new Event('input')); });
    const sv = await t.eval(() => ({ rows: document.querySelectorAll('#card .srow').length, mi: window.__mi, toggle: Creek.settings.get('smoke.toggle'), choice: Creek.settings.get('smoke.choice'), slider: Creek.settings.get('smoke.slider'), contours: document.querySelector('#card .srow').textContent }));
    await t.shot('07-phone-settings');
    await t.eval(() => Creek.ui.closeCard());
    const order = menuLabels.indexOf('Settings') < menuLabels.indexOf('Smoke menu item') && menuLabels.indexOf('Smoke menu item') < menuLabels.indexOf('Start the ranch over');
    check('menu has Settings and module items (in order) and the module item runs', order && sv.mi === 1, { menuLabels, mi: sv.mi });
    check('Settings card lists built-in and module settings and stores changes', sv.rows >= 4 && sv.toggle === true && sv.choice === 'two' && sv.slider === 7 && /Contour/.test(sv.contours), sv);

    // ---- custom tools (one finger; a second finger cancels). Tapping at y=150 is off the map at this size.
    await t.eval(() => {
      const calls = window.__calls = [];
      const mk = (id, readonly) => ({ id, icon: '🧪', label: id, kind: 'custom', readonly, help: 'smoke', custom: {
        down: (g, w, p) => calls.push(['down', id, w && Math.round(w.x), w && Math.round(w.y), Math.round(p.x), Math.round(p.y), g === window.game]),
        move: (g, w, p) => calls.push(['move', id, !!w]),
        up: (g, w, p, i) => calls.push(['up', id, w ? 'world' : null, Math.round(i.moved)]),
        cancel: (g) => calls.push(['cancel', id, g === window.game]) } });
      Creek.ui.addTool(mk('smoketool', true)); Creek.ui.addTool(mk('smoketool2', false));
    });
    const trayCount = await t.eval(() => [document.querySelectorAll('#tools .tool').length, Creek.TOOLS.length, !!document.querySelector('#tools .tool[data-id="smoketool"]')]);
    check('ui.addTool puts the tool in the tray', trayCount[0] === trayCount[1] && trayCount[2], trayCount);
    const locked = await t.eval(() => { game.allowed = ['look']; const r = { ro: game.canUse('smoketool'), rw: game.canUse('smoketool2'), dig: game.canUse('dig') }; game.allowed = null; return r; });
    check('story locks custom tools unless they say readonly:true', locked.ro && !locked.rw && !locked.dig, locked);
    const v0 = await t.eval(() => { game.setTool('smoketool'); game.fitCamera(); return { version: game.terrainVersion, cash: game.cash }; });
    await t.frames(2);
    const sev = await t.eval(() => { window.__se = []; game.on('strokeStart', (e) => window.__se.push(['start', e.tool, e.opt])); game.on('strokeEnd', (e) => window.__se.push(['end', e.tool, e.cancelled, e.path.length, e.cost])); return true; });
    await t.page.mouse.move(180, 370); await t.page.mouse.down(); await t.page.mouse.move(220, 400, { steps: 5 }); await t.page.mouse.up();
    await t.page.mouse.move(60, 150); await t.page.mouse.down(); await t.page.mouse.move(70, 165, { steps: 3 }); await t.page.mouse.up();
    await t.frames(1);
    let cc = await t.eval(() => ({ calls: window.__calls.slice(), se: window.__se.slice(), stroke: !!game.stroke }));
    const c1 = cc.calls.filter((c) => c[1] === 'smoketool');
    check('custom tool gets down / move / up with world metres and screen pixels, world null off the map', c1[0][0] === 'down' && c1[0][2] > 0 && c1[0][4] === 180 && c1[0][5] === 370 && c1[0][6] === true && c1.filter((c) => c[0] === 'move').length >= 3 && c1.some((c) => c[0] === 'up' && c[2] === 'world' && c[3] > 20) && c1.some((c) => c[0] === 'down' && c[2] === null) && c1.some((c) => c[0] === 'up' && c[2] === null), c1.slice(0, 12));
    check('custom tool strokes send strokeStart / strokeEnd with tool, path, cost', cc.se.length === 4 && cc.se[0][0] === 'start' && cc.se[0][1] === 'smoketool' && cc.se[1][0] === 'end' && cc.se[1][2] === false && cc.se[1][3] >= 2 && cc.se[1][4] === 0, cc.se);
    await t.eval(() => { window.__calls.length = 0; window.__se.length = 0; });
    await touch('touchStart', [{ x: 180, y: 370 }]); await touch('touchMove', [{ x: 190, y: 380 }]);
    await touch('touchStart', [{ x: 190, y: 380 }, { x: 250, y: 380 }]); await touch('touchEnd', []);
    await t.frames(1);
    cc = await t.eval(() => ({ calls: window.__calls.slice(), se: window.__se.slice(), stroke: !!game.stroke, v: game.terrainVersion, cash: game.cash }));
    check('a second finger cancels a custom tool (cancel called, no up, strokeEnd cancelled:true, nothing undone)', cc.calls.some((c) => c[0] === 'cancel' && c[2] === true) && !cc.calls.some((c) => c[0] === 'up') && cc.se.some((e) => e[0] === 'end' && e[2] === true) && !cc.stroke && cc.v === v0.version && cc.cash === v0.cash, cc);

    // path sampling: about every 2 m, never more than 400 points. Driven through the game's own pointer handlers with
    // plain event objects (Chrome merges real mouse moves into one per frame, which is slow and lossy in software GL).
    const drive = (tool, pts, pxPerM) => t.eval(([tool, pts, scale]) => {
      const g = window.game; g.canvas.setPointerCapture = () => {}; g.setTool(tool); g.focusOn(700, 725, scale);
      const out = []; const off = g.on('strokeEnd', (e) => out.push(e)); const id = 91, mk = (p, type) => ({ pointerId: id, pointerType: 'mouse', button: 0, type, clientX: p.x, clientY: p.y });
      g.onDown(mk(pts[0], 'pointerdown')); for (let i = 1; i < pts.length; i++) { g.onMove(mk(pts[i], 'pointermove')); g.applyBrush(0.02); } g.onUp(mk(pts[pts.length - 1], 'pointerup')); off();
      const e = out[0]; return e && { n: e.path.length, path: e.path.slice(0, 400), cancelled: e.cancelled, cost: e.cost };
    }, [tool, pts, pxPerM]);
    const zig = []; for (let k = 0; k < 3; k++) for (let x = 10; x <= 350; x++) zig.push({ x: k % 2 ? 360 - x : x, y: 300 + k * 30 });
    await t.frames(1);
    const lp = await drive('smoketool', zig, 0.5);
    check('stroke path is thinned to at most 400 points', lp && lp.n > 100 && lp.n <= 400, lp && lp.n);
    const sh = []; for (let x = 100; x <= 260; x += 2) sh.push({ x, y: 370 });
    const dg = await drive('dig', sh, 1);
    const sp = dg && (() => { const p = dg.path; let min = 1e9; for (let i = 1; i < p.length - 1; i++) min = Math.min(min, Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)); return { n: p.length, min: Math.round(min * 10) / 10, len: Math.round(Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].y - p[0].y)), cost: dg.cost }; })();
    check('stroke path is sampled about every 2 m and a dig stroke reports its cost', sp && sp.n > 20 && sp.min >= 2 && sp.len > 100 && sp.len < 200 && sp.cost > 0, sp);
    await t.eval(() => { game.undo(); game.setTool('look'); game.fitCamera(); });

    // ---- the Look tool: "probe" event
    await t.eval(() => { game.setTool('look'); game.fitCamera(); });
    await t.frames(2);
    const pinfo = await t.eval(() => { let got = null; game.on('probe', (i) => { got = i; }); const c = game.project(700, 725); game.doLook({ x: c.x, y: c.y }); return got; });
    check('"probe" event carries world x, y and the ground reading', pinfo && Math.abs(pinfo.x - 700) < 1 && Math.abs(pinfo.y - 725) < 1 && ['h', 'bed', 'cover', 'growth', 'depth', 'som', 'soil', 'field', 'px', 'py'].every((k) => typeof pinfo[k] === 'number'), pinfo);

    // ---- the view provider hooks (a tiny fake provider)
    await t.eval(() => {
      const g = window.game, fake = window.__fake = { active: true, drawn: 0, gestures: [], wheel: 0, wheelReturn: true, focused: null, resized: 0, last: null, projectMode: 'ok', picked: 0 };
      fake.draw = (game, st) => { fake.drawn++; fake.last = { same: game === g, keys: Object.keys(st).sort().join(), w: st.width, h: st.height, extras: st.extras === g.extras, lens: st.lens, scale: st.cam.scale }; };
      fake.pick = (x, y) => { fake.picked++; return y < 100 ? null : { x: 500 + x, y: 600 + y }; };
      fake.project = (x, y) => (fake.projectMode === 'null' ? null : { x: x / 10, y: y / 10, visible: fake.projectMode === 'ok' });
      fake.onWheel = (e, x, y) => { fake.wheel++; fake.wheelArgs = [e.deltaY !== undefined, Math.round(x), Math.round(y)]; return fake.wheelReturn; };
      fake.onGesture = (kind, d) => { fake.gestures.push([kind, d]); return true; };
      fake.focus = (x, y, s) => { fake.focused = [x, y, s]; };
      fake.resize = () => { fake.resized++; };
      window.__rd = 0; const r = g.renderer, orig = r.draw; r.draw = function () { window.__rd++; return orig.apply(this, arguments); };
      g.setViewProvider(fake);
    });
    await t.frames(3);
    const f1 = await t.eval(() => { const f = window.__fake, g = window.game; const rd0 = window.__rd; return { drawn: f.drawn, last: f.last, resized: f.resized, rd: rd0, w1: g.toWorld(10, 50), w2: g.toWorld(10, 200), p: g.project(1000, 2000), cw: g.canvas.width, ch: g.canvas.height }; });
    check('provider active: game.draw calls provider.draw(game, state) instead of the map renderer', f1.drawn >= 2 && f1.last.same && f1.last.extras && f1.last.w === f1.cw && f1.last.h === f1.ch && /cam/.test(f1.last.keys) && /extras/.test(f1.last.keys) && f1.rd === 0 && f1.resized >= 1, f1);
    check('provider active: toWorld uses pick (null passes through), project uses project', f1.w1 === null && f1.w2 && f1.w2.x === 510 && f1.w2.y === 800 && f1.p.x === 100 && f1.p.y === 200 && f1.p.visible === true, { w1: f1.w1, w2: f1.w2, p: f1.p });
    // wheel, mouse drags, two fingers
    const sc00 = await t.eval(() => game.cam.scale);
    await t.page.mouse.move(180, 400); await t.page.mouse.wheel(0, 120); await t.frames(1);
    const sc0 = await t.eval(() => ({ scale: game.cam.scale, wheel: window.__fake.wheel, args: window.__fake.wheelArgs }));
    await t.eval(() => { window.__fake.wheelReturn = false; }); await t.page.mouse.wheel(0, -300); await t.frames(1);
    const sc1 = await t.eval(() => ({ scale: game.cam.scale, wheel: window.__fake.wheel }));
    check('wheel is offered to the provider first (onWheel(e, px, py)) and falls back to the 2D camera when it says no', sc0.wheel === 1 && sc0.args[0] && sc0.args[1] === 180 && sc0.args[2] === 400 && sc0.scale === sc00 && sc1.wheel === 2 && sc1.scale > sc0.scale, { sc00, sc0, sc1 });
    await t.eval(() => { window.__fake.gestures.length = 0; });
    await t.drag([{ x: 150, y: 300 }, { x: 170, y: 310 }, { x: 190, y: 330 }], { steps: 3, button: 'right' });
    await t.drag([{ x: 150, y: 300 }, { x: 140, y: 290 }], { steps: 3, button: 'middle' });
    const gs1 = await t.eval(() => window.__fake.gestures.map((g) => [g[0], g[1].dx, g[1].dy]));
    check('right-drag is offered as "orbit" and middle-drag as "pan" (dx, dy in pixels)', gs1.filter((g) => g[0] === 'orbit').length >= 4 && gs1.filter((g) => g[0] === 'orbit').every((g) => g[1] > 0) && gs1.filter((g) => g[0] === 'pan').length >= 2 && gs1.filter((g) => g[0] === 'pan').every((g) => g[1] < 0 && g[2] < 0), gs1.slice(0, 12));
    await t.eval(() => { window.__fake.gestures.length = 0; });
    await touch('touchStart', [{ x: 150, y: 400 }, { x: 210, y: 400 }]); await touch('touchMove', [{ x: 150, y: 400 }, { x: 210, y: 400 }]);
    await touch('touchMove', [{ x: 140, y: 410 }, { x: 230, y: 410 }]); await touch('touchEnd', []);
    const gs2 = await t.eval(() => ({ g: window.__fake.gestures.map((g) => [g[0], g[1]]), scale: game.cam.scale }));
    const pinch = gs2.g.find((g) => g[0] === 'pinch'), drag2 = gs2.g.find((g) => g[0] === 'drag2');
    check('two fingers are offered as "pinch" (factor) and "drag2" (dx, dy, rot)', pinch && drag2 && pinch[1].factor > 1.05 && pinch[1].dist > 60 && drag2[1].dy > 0 && typeof drag2[1].rot === 'number' && pinch[1].cx === drag2[1].cx && pinch[1].cy === drag2[1].cy, gs2);
    await t.eval(() => { const g = window.game; g.focusOn(300, 400, 4); g.resize(); const el = Creek.ui.labelEls.find((x) => x.f); window.__lab = el; window.__fake.projectMode = 'hidden'; });
    await t.frames(3);
    const lab1 = await t.eval(() => ({ focused: window.__fake.focused, resized: window.__fake.resized, hiddenDisplay: window.__lab.el.style.display }));
    await t.eval(() => { window.__fake.projectMode = 'ok'; }); await t.frames(3);
    const lab2 = await t.eval(() => ({ display: window.__lab.el.style.display, tr: window.__lab.el.style.transform }));
    await t.eval(() => { window.__fake.projectMode = 'null'; }); await t.frames(3);
    const lab3 = await t.eval(() => window.__lab.el.style.display);
    check('focusOn goes to provider.focus; resize goes to provider.resize; labels hide when project says visible:false or null', lab1.focused && lab1.focused[0] === 300 && lab1.focused[2] === 4 && lab1.resized >= 2 && lab1.hiddenDisplay === 'none' && lab2.display === '' && /translate/.test(lab2.tr) && lab3 === 'none', { lab1, lab2, lab3 });
    await t.eval(() => { window.__fake.projectMode = 'ok'; window.__fake.active = false; }); await t.frames(3);
    const back = await t.eval(() => ({ rd: window.__rd, w: game.toWorld(180, 370), same: Math.abs(game.toWorld(180, 370).x - game._toWorld2d(180, 370).x) < 1e-9, hasVis: game.project(10, 10).visible }));
    check('provider inactive: the map renderer draws again and the 2D camera is used', back.rd >= 2 && back.same && back.hasVis === true, back);
    // a provider that crashes is switched off and the map comes back
    await t.eval(() => { const g = window.game, bad = window.__bad = { active: true, draw() { throw new Error('provider boom'); } }; g.setViewProvider(bad); });
    await t.frames(4);
    const bd = await t.eval(() => ({ active: window.__bad.active, rd: window.__rd, toast: document.getElementById('toast').textContent, ready: game.ready }));
    dropErrors(t, /view provider crashed/);
    check('a crashing provider is switched off, the map comes back, the game keeps running', bd.active === false && bd.rd > back.rd && /3D view had a problem/.test(bd.toast) && bd.ready, bd);
    await t.eval(() => { window.game.setViewProvider(null); delete window.game.renderer.draw; });

    // ---- sim.sampleLine and sim.restore
    const sl = await t.eval(() => {
      const sim = game.sim, o = {}; const a = sim.sampleLine(100, 200, 1300, 1100, 11);
      o.keys = Object.keys(a).sort().join(); o.len = a.h.length; o.dist = [a.dist[0], Math.round(a.dist[10])]; o.finite = [...a.h, ...a.bed, ...a.som, ...a.depth].every(isFinite);
      let worst = 0, cov = 0, soil = 0;
      for (let i = 0; i < 11; i++) { const x = 100 + 1200 * i / 10, y = 200 + 900 * i / 10, p = sim.probe(x, y); worst = Math.max(worst, Math.abs(p.h - a.h[i])); cov += p.cover === a.cover[i] ? 1 : 0; soil += p.soil === a.soil[i] ? 1 : 0; }
      o.worst = Math.round(worst * 100) / 100; o.cov = cov; o.soil = soil; o.inside = a.inside.every((v) => v === 1);
      const b = sim.sampleLine(-200, -200, 200, 200, 8); o.out = [...b.inside].join('');
      const c = sim.sampleLine(0, 700, 1399, 700, 5000); o.cap = c.h.length;
      const d = sim.sampleLine(600, 600, 600, 600, 1); o.one = d.h.length === 1 && isFinite(d.h[0]);
      return o;
    });
    check('sim.sampleLine returns n samples with dist, h, bed, cover, growth, depth, som, soil, inside', /bed,cover,depth,dist,growth,h,inside,soil,som/.test(sl.keys) && sl.len === 11 && sl.dist[0] === 0 && sl.dist[1] === 1500 && sl.finite && sl.inside && sl.cap === 512 && sl.one, sl);
    check('sim.sampleLine agrees with sim.probe on heights, cover and soil; points off the map are flagged', sl.worst < 1.5 && sl.cov >= 10 && sl.soil >= 10 && sl.out === '00001111', sl);
    const rs = await t.eval(() => {
      const sim = game.sim, T0 = sim.readTerrain(), M0 = sim.readMoisture(), o = {}; let heard = 0, v0 = game.terrainVersion; game.on('terrain', () => { heard++; });
      const T1 = Float32Array.from(T0); for (let i = 0; i < T1.length; i += 4) T1[i] += 2; sim.restore(T1, null);
      const T2 = sim.readTerrain(); o.up = Math.abs(T2[4000] - T0[4000] - 2) < 1e-4 && Math.abs(T2[100000] - T0[100000] - 2) < 1e-4;
      sim.restore(T0, M0); const T3 = sim.readTerrain(); o.back = T3[4000] === T0[4000] && T3[100000] === T0[100000];
      o.heard = heard; o.version = game.terrainVersion - v0;
      try { sim.restore(new Float32Array(10), null); o.threw = false; } catch (e) { o.threw = true; }
      return o;
    });
    check('sim.restore puts terrain back, tells listeners (terrain event, terrainVersion) and rejects wrong sizes', rs.up && rs.back && rs.heard === 2 && rs.version === 2 && rs.threw, rs);
    check('no console errors in the API checks', t.errors.length === 0, clean(t));
  } finally { await t.close(); }
}

/** Pause, fast-forward, frame gate and the frame event, on a real (not turbo) storm. */
async function stormControls() {
  const t = await T.open({ root, query: 'level=3&quick=1&free=1' + extra, viewport: { width: 360, height: 640 }, dir: DIR });
  try {
    if (!(await t.eval(() => typeof window.game.on === 'function'))) return;
    const r0 = await t.eval(() => {
      const g = window.game; window.__fr = 0; window.__dts = []; window.__dr = 0;
      g.on('frame', (dt) => { window.__fr++; window.__dts.push(dt); });
      const od = g.draw; g.draw = function () { window.__dr++; return od.apply(this, arguments); };
      return g.startStorm(1) === true;
    });
    check('a normal (not turbo) storm starts', r0);
    await t.frames(6);
    const s1 = await t.eval(() => ({ t: game.storm.t, fr: window.__fr, ok: window.__dts.every((d) => typeof d === 'number' && d >= 0 && d <= 0.1) }));
    await t.eval(() => { game.paused = true; });
    await t.frames(2); const a = await t.eval(() => ({ t: game.storm.t, rain: game.weather.rain, dr: window.__dr }));
    await t.frames(5); const b = await t.eval(() => ({ t: game.storm.t, rain: game.weather.rain, dr: window.__dr, fr: window.__fr }));
    check('game.paused stops the storm but keeps drawing and sending "frame"', s1.t > 0 && s1.ok && a.t === b.t && b.dr > a.dr && b.fr > s1.fr, { s1, a, b });
    await t.eval(() => { game.paused = false; });
    await t.frames(4); const c = await t.eval(() => game.storm.t);
    check('storm continues after pause', c > b.t, { b: b.t, c });
    const f = await t.eval(async () => {
      const g = window.game; g.fast = true; const fr0 = window.__fr, dr0 = window.__dr;
      await new Promise((res) => { let n = 0; const k = () => { if (++n >= 18 || !g.storm) res(); else requestAnimationFrame(k); }; requestAnimationFrame(k); });
      const o = { frames: window.__fr - fr0, draws: window.__dr - dr0 }; g.fast = false; return o;
    });
    check('game.fast draws only every 3rd frame during a storm', f.frames >= 9 && f.draws >= 2 && f.draws <= Math.ceil(f.frames / 3) + 1, f);
    const gt = await t.eval(async () => {
      const g = window.game; let gated = 0; g.frameGate = (game, dt) => { gated++; return false; }; const dr0 = window.__dr, fr0 = window.__fr;
      await new Promise((res) => { let n = 0; const k = () => { if (++n >= 6) res(); else requestAnimationFrame(k); }; requestAnimationFrame(k); });
      const o1 = { gated, draws: window.__dr - dr0, frames: window.__fr - fr0 };
      g.frameGate = (game, dt) => true; const d1 = window.__dr;
      await new Promise((res) => { let n = 0; const k = () => { if (++n >= 4) res(); else requestAnimationFrame(k); }; requestAnimationFrame(k); });
      o1.after = window.__dr - d1; g.frameGate = null; return o1;
    });
    check('game.frameGate returning false skips drawing; true or null draws', gt.gated >= 4 && gt.draws === 0 && gt.frames >= 4 && gt.after >= 2, gt);
    await t.eval(() => { game.stopStorm(); delete game.draw; });
    check('no console errors while pausing and fast-forwarding', t.errors.length === 0, clean(t));
  } finally { await t.close(); }
}

/** Proves each hook of the example module (src/mod-example.js) works. Runs only when it is loaded:  node tools/smoke.js . mods=example */
async function exampleChecks() {
  if (!/example/.test(extra)) return;
  const t = await T.open({ root, query: 'level=3&quick=1&free=1' + extra, viewport: { width: 1100, height: 760 }, dir: DIR });
  try {
    const ex = (fn, arg) => t.eval(fn, arg);
    const st0 = await ex(() => ({ mods: Creek.enabledModules.slice(), errs: Creek.moduleErrors.length, ready: Creek.example && Creek.example.readyCount, ev: Creek.example && Creek.example.counts.ready }));
    check('example: registered, init and ready ran once, no module errors', st0.mods.indexOf('example') >= 0 && st0.errs === 0 && st0.ready === 1 && st0.ev === 1, st0);

    // view button + panel (+ onHide keeps the button in step), top button + game.paused
    const b = await ex(() => {
      const btn = document.getElementById('exampleBtn'), panel = Creek.example.panel, o = { inRow: btn.parentNode.id };
      btn.click(); o.shown = panel.visible && btn.classList.contains('on');
      panel.el.querySelector('.px').click(); o.hidden = !panel.visible && !btn.classList.contains('on');
      const top = document.getElementById('examplePause'); o.topIn = top.parentNode.id; top.click(); o.paused = game.paused === true; top.click(); o.resumed = game.paused === false;
      return o;
    });
    check('example: view button toggles the panel, the panel X unticks it, the top button pauses', b.inRow === 'topbar2' && b.shown && b.hidden && b.topIn === 'topRight' && b.paused && b.resumed, b);

    // lens
    const l = await ex(() => { game.setLens('example'); const a = Creek.example.counts.lensOn; game.setLens('map'); return { on: a, off: Creek.example.counts.lensOff, ids: game.lenses.map((x) => x.id).join(), lens: game.lens }; });
    check('example: its lens joins the view button and runs activate / deactivate', l.on === 1 && l.off === 1 && /map,soil,moved,flood,example/.test(l.ids) && l.lens === 0, l);

    // custom tool: a drag measures a profile with sim.sampleLine, a tap counts (saved state)
    await ex(() => { const s = game.world.meta.streams[0], p = s.pts[Math.floor(s.pts.length * 0.45)]; game.setTool('exprofile'); game.focusOn(p[0], p[1], 2); Creek.ui.closeCard(); window.__c = { x: p[0], y: p[1] }; });
    await t.frames(2);
    const c = await t.world(await ex(() => window.__c.x), await ex(() => window.__c.y));
    await t.drag([{ x: c.x - 80, y: c.y }, { x: c.x + 80, y: c.y + 20 }], { steps: 6 });
    await t.tap(c.x, c.y + 60);
    await t.frames(2);
    const p = await ex(() => ({ profile: Creek.example.profile, taps: Creek.example.taps, saved: game.collectState().example, calls: Creek.example.counts.toolUp, text: Creek.example.panel.body.textContent }));
    check('example: the Profile tool reads a line (sampleLine) and a tap counts; state is saved', p.profile && p.profile.n === 64 && p.profile.length > 20 && p.profile.hi >= p.profile.lo && p.taps === 1 && p.saved.taps === 1 && p.calls === 2, p);
    await ex(() => { game.applyState({ example: { taps: 5 } }); }); check('example: saved state loads back', await ex(() => Creek.example.taps === 5));

    // events from a dig stroke, probe, a field change and undo
    await ex(() => { game.setTool('dig'); });
    const c0 = await ex(() => Object.assign({}, Creek.example.counts));
    await t.drag([{ x: c.x - 40, y: c.y - 40 }, { x: c.x + 40, y: c.y - 30 }], { steps: 5 });
    await ex(() => { game.setTool('look'); }); await t.tap(c.x + 5, c.y + 5);
    await ex(() => { const f = game.fields.find((x) => x.kind === 'field' && x.use !== 'prairie'); game.setTool('fields', 2); game.focusOn(f.cx, f.cy, 2); window.__f = f; });
    await t.frames(2); const fp = await t.world(await ex(() => window.__f.cx), await ex(() => window.__f.cy)); await t.tap(fp.x, fp.y);
    await t.frames(2);
    await ex(() => { game.undo(); });
    const c1 = await ex(() => Object.assign({}, Creek.example.counts));
    const d = (k) => (c1[k] || 0) - (c0[k] || 0);
    check('example: strokeStart/strokeEnd/terrain/cash/probe/toolChanged/fieldUse events arrive', d('strokeStart') >= 3 && d('strokeEnd') >= 3 && d('terrain') >= 3 && d('cash') >= 1 && d('probe') >= 1 && d('toolChanged') >= 2 && d('fieldUse') >= 2, { d: Object.keys(c1).map((k) => k + ':' + d(k)).join(' ') });

    // season, reset, shortcut, setting, menu item
    await ex(() => { game.advanceSeason(); game.resetMap(); });
    await t.press('e'); const sh1 = await ex(() => Creek.example.panel.visible); await t.press('e'); const sh2 = await ex(() => Creek.example.panel.visible);
    check('example: season and reset events, and the E shortcut shows/hides the panel', (await ex(() => Creek.example.counts.season >= 1 && Creek.example.counts.reset >= 1)) && sh1 === true && sh2 === false);
    await ex(() => { Creek.ui.menu(); });
    await t.page.waitForSelector('#card .btns button:has-text("Say hello")');
    await t.page.click('#card .btns button:has-text("Say hello")'); await t.sleep(200);
    check('example: the menu item runs', /Hello from the example module/.test(await ex(() => document.getElementById('toast').textContent)));
    await ex(() => { Creek.ui.menu(); }); await t.page.click('#card .btns button:has-text("Settings")'); await t.page.waitForSelector('#card .srow:has-text("chatty")');
    await t.page.click('#card .srow:has-text("chatty") .sw'); await ex(() => Creek.ui.closeCard());
    check('example: its setting is in the Settings card and changes Creek.settings', (await ex(() => Creek.settings.get('example.chatty') === true && Creek.example.chatty === true)));
    await ex(() => { game.setTool('dig'); game.focusOn(window.__c.x, window.__c.y, 2); }); await t.frames(2);
    await t.drag([{ x: c.x - 30, y: c.y + 80 }, { x: c.x + 30, y: c.y + 80 }], { steps: 4 }); await t.frames(2);
    check('example: chatty setting shows a note after a dig', /dig: \d+ points/.test(await ex(() => document.getElementById('toast').textContent)), await ex(() => document.getElementById('toast').textContent));
    await ex(() => { Creek.example.panel.show(); game.setTool('exprofile'); game.setLens('map'); });
    await t.shot('08-example-desktop');

    // a quick storm: stormStart / stormStep / stormEnd
    const s0 = await ex(() => Object.assign({}, Creek.example.counts));
    let ok = true; try { await t.quickStorm(1, { timeout: 240000 }); } catch (e) { ok = String(e.message); }
    const s1 = await ex(() => ({ c: Object.assign({}, Creek.example.counts), text: Creek.example.panel.body.textContent }));
    check('example: stormStart / stormStep / stormEnd events and the panel report', ok === true && s1.c.stormStart - (s0.stormStart || 0) === 1 && s1.c.stormEnd - (s0.stormEnd || 0) === 1 && s1.c.stormStep - (s0.stormStep || 0) > 5 && /Storm over/.test(s1.text) && s1.c.frame > 20, { ok, text: s1.text.slice(0, 160) });

    // a detail-level reload runs ready again
    await ex(() => { window.__ready0 = Creek.example.readyCount; window.__rl = game.loadLevel(3).then(() => 'done'); });
    await t.page.waitForFunction(() => Creek.example.readyCount === window.__ready0 + 1 && game.ready, null, { timeout: 120000 });
    check('example: ready runs again after a level reload', await ex(() => Creek.example.readyCount === 2 && /World ready/.test(Creek.example.panel.body.textContent)));
    check('example: no console errors', t.errors.length === 0, clean(t));
  } finally { await t.close(); }
}

async function storyOpening() {
  const t = await T.open({ root, query: 'level=3&quick=1' + extra, viewport: { width: 900, height: 600 }, dir: DIR });
  const click = (sel) => t.page.click(sel, { timeout: 20000 });
  const cardTitle = () => t.eval(() => { const c = document.querySelector('#card h1, #card h2'); return c ? c.textContent : null; });
  const waitTitle = (txt) => t.page.waitForFunction((x) => { const c = document.querySelector('#card h1, #card h2'); return c && c.textContent.indexOf(x) >= 0 && !document.getElementById('modal').classList.contains('hidden'); }, txt, { timeout: 30000 });
  try {
    await waitTitle('Creek Care');
    check('title card shows', true, await cardTitle());
    await t.shot('03-title');
    await click('#card .btns button:has-text("Story")');
    await waitTitle('Bluestem Ranch');
    await click('#card .btns button');
    await waitTitle('The creek');
    await t.shot('04-story-creek');
    await t.eval(() => { window.game.draw = function () {}; });          // the "before" storm runs without drawing (software GL is slow)
    await click('#card .btns button');
    await t.page.waitForFunction(() => window.game.baseline !== null, null, { timeout: 240000, polling: 200 });
    await t.eval(() => { delete window.game.draw; });
    await t.sleep(500);
    const s = await t.eval(() => ({ mode: Creek.ui.mode, banner: document.getElementById('banner').textContent, season: game.season, year: game.year,
      peak: game.baseline.peakOut, history: game.stormHistory ? game.stormHistory.length : -1, lookOk: game.canUse('look'), digOpen: game.canUse('dig'), plantLocked: !game.canUse('plant'), cash: game.cash }));
    check('story opening: the "before" storm runs and the first summer starts', s.mode === 'story' && /Year 1/.test(s.banner) && s.season === 'summer' && s.peak > 0, s);
    check('story: digging is open and planting is locked in summer', s.lookOk && s.digOpen && s.plantLocked, s);
    await t.shot('05-story-summer');
    check('no errors in the story opening', t.errors.length === 0, clean(t));
  } finally { await t.close(); }
}

async function missingModule() {
  const t = await T.open({ root, query: 'level=3&quick=1&free=1&mods=nosuchmodule', dir: DIR, ignore: [/nosuchmodule/] });
  try {
    const r = await t.eval(() => ({ ready: game.ready, enabled: (Creek.enabledModules || []).length }));
    check('a missing module file is skipped with a warning', r.ready && r.enabled === 0 && t.warnings.some(w => /nosuchmodule/.test(w)), { r, warnings: t.warnings });
    check('no other errors with a missing module', t.errors.length === 0, clean(t));
  } finally { await t.close(); }
}

(async () => {
  console.log('Smoke test: ' + root + (extra ? '  (query +' + extra + ')' : ''));
  const only = process.env.ONLY ? process.env.ONLY.toLowerCase() : '';      // ONLY=api runs just the sections whose name contains "api"
  for (const [name, fn] of [['free play', freePlay], ['extension API', apiChecks], ['storm controls', stormControls], ['example module', exampleChecks], ['story opening', storyOpening], ['missing module', missingModule]]) {
    if (only && name.toLowerCase().indexOf(only) < 0) continue;
    try { await fn(); } catch (e) { check(name + ' ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
