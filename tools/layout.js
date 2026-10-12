#!/usr/bin/env node
/* Layout check for Creek Care: opens the game at many screen sizes, walks through the screens that change the HUD, and lists every
   button or box that runs off the screen or that something else covers.
   Usage:  node tools/layout.js [sizes] [states]
     sizes   comma list like 1280x800,390x844 (default: fifteen sizes from a big laptop to a small phone, and phones on their side;
             touch for anything 820 px wide or narrower, or 460 px high or lower)
     states  comma list of state names to run (default: all; see STATES below)
   Set SHOTS=1 to save a screenshot of every state to /tmp/creek-work/layout/ (look at them with an image viewer).
   What counts:
     off screen  the part of an element you can see (after any scrolling or clipping box it sits in) goes past the edge of the window.
                 Chips in a sideways-scrolling row are fine as long as the row itself fits.
     covered     the middle of a button is under another box (so a tap would hit that box instead).
   Exit code 1 if anything was found. Uses tools/testlib.js (level 3, short storms). */
'use strict';
const T = require('./testlib.js');

const SIZES = (process.argv[2] || '1440x900,1366x768,1280x800,1280x600,1180x820,1024x768,900x700,820x1180,768x1024,600x960,430x932,390x844,360x740,932x430,844x390')
  .split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { width: w, height: h }; });
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const SHOTS = !!process.env.SHOTS, DIR = '/tmp/creek-work/layout';

/** Runs in the page: what runs off the screen, and which buttons are covered. scope = a selector to look inside (default #app). */
function audit(scope) {
  const W = innerWidth, H = innerHeight, offs = [], covered = [];
  const root = document.querySelector(scope || '#app');
  const name = (el) => {
    let s = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    const p = el.closest('[id]'); if (p && p !== el) s = '#' + p.id + ' ' + s;
    const tx = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24); return s + (tx ? ' "' + tx + '"' : '');
  };
  const vis = new Map();
  /** The part of an element you can see: its box clipped by every scrolling or clipping box it sits in. */
  function seen(el) {
    if (vis.has(el)) return vis.get(el);
    let out = null;
    const cs = getComputedStyle(el);
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length) {
      const r = el.getBoundingClientRect();
      let L = r.left, R = r.right, Tp = r.top, B = r.bottom;
      for (let a = el.parentElement; a && a !== document.body && a.id !== 'app'; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.position === 'fixed') break;
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          const q = a.getBoundingClientRect();
          if (s.overflowX !== 'visible') { L = Math.max(L, q.left); R = Math.min(R, q.right); }
          if (s.overflowY !== 'visible') { Tp = Math.max(Tp, q.top); B = Math.min(B, q.bottom); }
        }
      }
      if (R - L >= 1 && B - Tp >= 1 && r.width >= 1 && r.height >= 1) out = { L, R, T: Tp, B };
    }
    vis.set(el, out); return out;
  }
  const bad = new Set();
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('#labels')) continue;                               // map labels follow the map and may sit past the edge
    const v = seen(el); if (!v) continue;
    const why = [];
    if (v.R > W + 1) why.push('right +' + Math.round(v.R - W));
    if (v.L < -1) why.push('left ' + Math.round(v.L));
    if (v.B > H + 1) why.push('bottom +' + Math.round(v.B - H));
    if (v.T < -1) why.push('top ' + Math.round(v.T));
    if (why.length) { bad.add(el); if (!bad.has(el.parentElement)) offs.push(name(el) + '  ' + why.join(' ')); }
  }
  // buttons whose middle is under something else
  for (const el of root.querySelectorAll('button, input, select, .chip, [role=button]')) {
    const v = seen(el); if (!v) continue;
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    const x = (Math.max(v.L, 0) + Math.min(v.R, W)) / 2, y = (Math.max(v.T, 0) + Math.min(v.B, H)) / 2;
    if (x < 0 || y < 0 || x > W || y > H) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    if (hit.closest('#viewMenu, .rvmenu')) continue;                   // an open drop-down menu covers things on purpose
    covered.push(name(el) + '  under ' + name(hit));
  }
  return { offs, covered };
}

const pageAudit = (t) => t.eval(() => {
  const m = document.getElementById('modal'), rv = document.getElementById('rv');
  const scope = m && !m.classList.contains('hidden') ? '#modal' : rv && !rv.classList.contains('hidden') ? '#rv' : '#app';
  return window.__audit(scope);
});
const closeCard = (t) => t.eval(() => { if (Creek.ui._resolveCard) Creek.ui._resolveCard('x'); Creek.ui.closeCard(); });
const frames = (t, n) => t.frames(n || 3);

// Each state: setup (and undo) inside the page. They run in this order on one page per size.
const STATES = [
  { name: 'start' },
  { name: 'story-banner', setup: (t) => t.eval(() => { window.__adv = [Creek.ui.note, Creek.ui.onAdvance]; Creek.ui.advanceLabel = 'Finish: the final test ✓'; Creek.ui.seasonBar('storms test what you built.', () => {}); }),
    undo: (t) => t.eval(() => { Creek.ui.advanceLabel = null; Creek.ui.seasonBar(window.__adv[0], window.__adv[1]); }) },
  { name: 'viewmenu', setup: (t) => t.eval(() => Creek.ui.viewMenu()), undo: (t) => t.eval(() => document.getElementById('viewMenu').classList.add('hidden')) },
  { name: 'menu', setup: (t) => t.eval(() => { Creek.ui.menu(); }), undo: closeCard },
  { name: 'settings', setup: (t) => t.eval(() => { Creek.ui.settings(); }), undo: closeCard },
  { name: 'stormbox-open', setup: (t) => t.eval(() => document.getElementById('stormbar').classList.add('open')), undo: (t) => t.eval(() => document.getElementById('stormbar').classList.remove('open')) },
  { name: 'plant', setup: (t) => t.eval(() => { game.setTool('plant', 0); Creek.ui.updateTools(); }), undo: (t) => t.eval(() => { game.setTool('look'); Creek.ui.updateTools(); }) },
  { name: 'fields', setup: (t) => t.eval(() => { game.setTool('fields', 0); Creek.ui.updateTools(); }), undo: (t) => t.eval(() => { game.setTool('look'); Creek.ui.updateTools(); }) },
  { name: 'health', setup: (t) => t.eval(() => Creek.ui.panels.health.show()), undo: (t) => t.eval(() => Creek.ui.panels.health.hide()) },
  { name: 'trace', setup: (t) => t.eval(() => { const s = game.world.meta.streams[0], p = s.pts[Math.floor(s.pts.length * 0.5)]; Creek.hydro.traceAt(p[0], p[1], { snap: true }); }),
    wait: 1500, undo: (t) => t.eval(() => Creek.ui.panels['hy-trace'].hide()) },
  { name: 'section', setup: (t) => t.eval(() => { const s = game.world.meta.streams[0], p = s.pts[Math.floor(s.pts.length * 0.5)]; Creek.hydro.setSection(p[0] - 120, p[1] - 60, p[0] + 120, p[1] + 60); }),
    wait: 800, undo: (t) => t.eval(() => Creek.ui.panels['hy-section'].hide()) },
  { name: 'health+section', setup: (t) => t.eval(() => { Creek.ui.panels.health.show(); const s = game.world.meta.streams[0], p = s.pts[Math.floor(s.pts.length * 0.5)]; Creek.hydro.setSection(p[0] - 120, p[1] - 60, p[0] + 120, p[1] + 60); }),
    wait: 800, undo: (t) => t.eval(() => { Creek.ui.panels.health.hide(); Creek.ui.panels['hy-section'].hide(); }) },
  { name: 'storm', setup: async (t) => {
    await t.eval(() => { game.frameGate = () => false; game.startStorm(10, { turbo: true }); });
    await t.sleep(2500);
    await t.eval(() => { game.paused = true; game.frameGate = null; });
  } },
  { name: 'storm+3d', setup: (t) => t.eval(() => { Creek.view3d.enter(); }), wait: 600, undo: (t) => t.eval(() => { Creek.view3d.exit(); }) },
  { name: 'storm-report', setup: (t) => t.eval(() => { game.paused = false; game.stopStorm(); }), wait: 600 },
  { name: '3d', setup: (t) => t.eval(() => { Creek.view3d.enter(); }), wait: 600 },
  { name: '3d+plant', setup: (t) => t.eval(() => { game.setTool('plant', 0); Creek.ui.updateTools(); }), undo: (t) => t.eval(() => { game.setTool('look'); Creek.ui.updateTools(); Creek.view3d.exit(); document.getElementById('report').classList.add('hidden'); }) },
  { name: 'valley', setup: async (t) => {
    await t.eval(() => Creek.river.open()); await t.sleep(2500);
    await closeCard(t);                                                      // the first visit explains the valley in a card
  } },
  { name: 'valley-more', setup: (t) => t.eval(() => document.getElementById('rvMore').click()), undo: (t) => t.eval(() => document.getElementById('rvMenu').classList.add('hidden')) },
  { name: 'valley-flood', setup: (t) => t.eval(() => document.getElementById('rvFlood').click()), undo: (t) => t.eval(() => document.getElementById('rvMenu').classList.add('hidden')) },
  { name: 'valley-info', setup: (t) => t.eval(() => { const m = Creek.river.model(); const n = m.nodes[Math.floor(m.nodes.length / 3)]; Creek.river.select(n.id); document.getElementById('rvInfo').classList.remove('collapsed'); }), wait: 300 },
  { name: 'valley-tool', setup: (t) => t.eval(() => { Creek.river.select(null); Creek.river.setTool(Creek.river.TOOLS[Creek.river.TOOLS.length - 1].id); }), undo: (t) => t.eval(() => Creek.river.close()) }
];

(async () => {
  let found = 0;
  for (const vp of SIZES) {
    const touch = vp.width <= 820 || vp.height <= 460, tag = vp.width + 'x' + vp.height;
    const t = await T.open({ viewport: vp, touch, dir: DIR, query: 'level=3&quick=1&free=1' });
    try {
      await t.page.addScriptTag({ content: 'window.__audit = ' + audit.toString() + ';' });
      await t.sleep(400);
      for (const st of STATES) {
        if (ONLY && !ONLY.includes(st.name)) {             // not asked for: a state that undoes itself is skipped, one that leads to the next is still set up
          if (st.setup && !st.undo) { await st.setup(t); await frames(t, 2); if (st.wait) await t.sleep(st.wait); }
          continue;
        }
        if (st.setup) await st.setup(t);
        await frames(t, 3); if (st.wait) await t.sleep(st.wait);
        const r = await pageAudit(t);
        const n = r.offs.length + r.covered.length; found += n;
        console.log((n ? 'BAD  ' : 'ok   ') + tag + (touch ? ' touch' : '') + '  ' + st.name + (n ? '' : ''));
        r.offs.forEach((s) => console.log('       off: ' + s));
        r.covered.forEach((s) => console.log('       covered: ' + s));
        if (SHOTS) {                                       // the picture on the canvas stays as it is while the shot is taken (software GL is slow)
          await t.eval(() => { window.__gate = game.frameGate; game.frameGate = () => false; });
          await t.shot(tag + '-' + st.name.replace(/\+/g, '_'));
          await t.eval(() => { game.frameGate = window.__gate; });
        }
        if (st.undo) { await st.undo(t); await frames(t, 2); }
      }
      if (t.errors.length) console.log('ERRORS ' + tag + ': ' + t.errors.join(' | '));
    } catch (e) { console.log('FAIL ' + tag + ': ' + (e && e.stack || e)); found++; }
    finally { await t.close(); }
  }
  console.log(found ? found + ' problems' : 'all clear');
  process.exit(found ? 1 : 0);
})();
