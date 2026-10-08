/* Settings, speed and safety nets. Module id "settings". Exposes Creek.perf.
   - Settings card rows: Detail level, Sharpness, Reduce motion, Show frame rate, Fast storms.
   - Pause and fast-forward buttons that appear inside the storm box while a storm runs (keys Space and F; S is quick save).
   - Resting: with nothing happening the map is drawn about 8 times a second instead of 60, and not at all while the page is hidden.
   - If the graphics chip is taken away (WebGL context lost) the ranch is rebuilt and the last autosave is put back.
   - A memory guard that picks a lighter detail level when a device cannot hold the finest one.
   - One calm, dismissible card when the game hits an unexpected error, at most once a minute, with a "Copy details" button.
   Other code can use: Creek.perf.wake(ms) (keep drawing at full speed for a while), Creek.perf.reduceMotion(),
   Creek.perf.notice({...}) (a small card that does not block the game), Creek.perf.levelOk(level). */
(function () {
  const C = Creek.CONFIG;
  const LAST = C.levels.length - 1;
  let game = null, ui = null;
  const $ = (id) => document.getElementById(id);
  const S = () => Creek.settings;
  const guard = (what, fn) => { try { return fn(); } catch (e) { try { console.warn('[creek] settings module: ' + what, e); } catch (x) { /* ignore */ } } };

  // ---------------------------------------------------------------- Creek.perf (usable before init)
  let wakeUntil = 0;
  const perf = Creek.perf = {
    errors: [],
    /** Keep drawing at full speed for the next `ms` milliseconds (default 1500). */
    wake: function (ms) { wakeUntil = Math.max(wakeUntil, performance.now() + (ms == null ? 1500 : ms)); },
    reduceMotion: function () { return !!S().get('reduceMotion', false); },
    /** Rough texture memory for a detail level, in MB: cells x 16 bytes x about 14 textures. */
    memoryMB: function (level) {
      const dx = C.levels[level]; if (!dx) return 0;
      return Math.round(C.mapW / dx) * Math.round(C.mapH / dx) * 16 * 14 / 1e6;
    },
    /** How much texture memory this device is trusted with, in MB (about 700; less when the browser says it has little memory). */
    limitMB: function () {
      const set = +S().get('perf.memoryLimit', 0); if (set > 0) return set;
      const dm = +navigator.deviceMemory;             // GB, Chrome only, rounded down to a power of two
      return dm > 0 ? Math.min(700, dm * 128) : 700;
    },
    levelOk: function (level) { return perf.memoryMB(level) <= perf.limitMB(); },
    notice: function (o) { return notice(o); }
  };

  // ---------------------------------------------------------------- the small non-blocking card (errors, graphics loss, memory note)
  let noteEl = null, noteCur = null;
  function notice(o) {
    o = o || {};
    if (!noteEl) {
      noteEl = document.createElement('div'); noteEl.id = 'creekNotice'; noteEl.setAttribute('role', 'status'); noteEl.className = 'hidden';
      ($('app') || document.body).appendChild(noteEl);
    }
    noteEl.innerHTML = '';
    const h = document.createElement('b'); h.textContent = o.title || ''; noteEl.appendChild(h);
    if (o.text) { const p = document.createElement('p'); p.textContent = o.text; noteEl.appendChild(p); }
    let box = null;
    if (o.detail) { box = document.createElement('div'); box.className = 'cn-detail'; box.textContent = o.detail; noteEl.appendChild(box); }
    const row = document.createElement('div'); row.className = 'cn-row'; noteEl.appendChild(row);
    const me = { el: noteEl, detailEl: box, close: function () { if (noteCur === me) { noteEl.classList.add('hidden'); noteCur = null; } } };
    (o.buttons || []).forEach((b) => {
      const el = document.createElement('button'); el.className = b.primary ? 'go' : 'plain'; el.textContent = b.label;
      el.onclick = () => guard('notice button', () => b.onClick && b.onClick(me, el));
      row.appendChild(el);
    });
    if (!o.sticky) {
      const x = document.createElement('button'); x.className = 'plain'; x.textContent = o.closeLabel || 'Close'; x.onclick = me.close; row.appendChild(x);
    }
    noteEl.classList.remove('hidden'); noteCur = me;
    return me;
  }

  // ---------------------------------------------------------------- error reporting
  let lastErrCard = 0;
  function describe(extra) {
    const g = game, lines = [];
    lines.push('Creek Care problem report', 'time: ' + new Date().toISOString(), 'page: ' + location.href.slice(0, 200), 'browser: ' + navigator.userAgent);
    if (g) {
      lines.push('level: ' + g.level + ' · year ' + g.year + ' ' + g.season + ' · mode ' + (ui && ui.mode) + ' · storm ' + (g.storm ? 'running' : 'no') + ' · modules ' + (Creek.enabledModules || []).join(','));
      guard('gl info', () => { const gl = g.gl, d = gl.getExtension('WEBGL_debug_renderer_info'); lines.push('graphics: ' + (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown')); });
    }
    perf.errors.slice(-5).forEach((e, i) => { lines.push('', 'error ' + (perf.errors.length - Math.min(5, perf.errors.length) + i + 1) + ': ' + e.msg, e.stack || ''); });
    if (extra) lines.push('', String(extra));
    return lines.join('\n');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* try the old way */ }
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-999px;top:0'; document.body.appendChild(ta);
      ta.select(); const ok = document.execCommand && document.execCommand('copy'); ta.remove(); return !!ok;
    } catch (e) { return false; }
  }
  const IGNORE = /ResizeObserver loop|^Script error\.?$/i;
  function onProblem(msg, stack) {
    msg = String(msg || '').replace(/^Uncaught /, '').slice(0, 400); if (!msg || IGNORE.test(msg)) return;
    perf.errors.push({ t: Date.now(), msg, stack: String(stack || '').slice(0, 1500) }); if (perf.errors.length > 20) perf.errors.shift();
    const now = Date.now(); if (now - lastErrCard < 60000) return;         // one card a minute at most
    lastErrCard = now;
    guard('error card', () => notice({
      title: 'Oops, the game tripped over something', text: 'It is still running. If it keeps happening, tap Copy details and send them to the person who made the game.',
      detail: msg.slice(0, 160),
      buttons: [{ label: 'Copy details', primary: true, onClick: async (me, el) => {
        const text = describe(), ok = await copyText(text);
        el.textContent = ok ? 'Copied!' : 'Could not copy';
        if (!ok && me.detailEl) { me.detailEl.textContent = text; me.detailEl.classList.add('open'); }
      } }]
    }));
  }
  window.addEventListener('error', (e) => { if (e.target && e.target !== window) return; onProblem(e.message || (e.error && e.error.message), e.error && e.error.stack); });
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; onProblem(r && r.message ? r.message : r, r && r.stack); });
  perf.report = onProblem;

  // ---------------------------------------------------------------- the module
  Creek.registerModule({
    id: 'settings',
    ready: function (g) { guard('renderer pixel ratio', () => patchRenderer(g)); },
    init: function (g, u) {
      game = g; ui = u;
      styles();
      guard('memory guard', memoryGuard);
      guard('sharpness', sharpness);
      guard('rows', rows);
      guard('motion', motion);
      guard('storm controls', stormControls);
      guard('resting', resting);
      guard('fps', fpsBox);
      guard('graphics loss', contextLoss);
      guard('shortcuts', shortcuts);
    }
  });

  function styles() {
    ui.styles(
      '#creekNotice{position:absolute;z-index:31;left:50%;top:calc(66px + var(--safe-t));transform:translateX(-50%);width:min(420px,calc(100vw - 20px));background:var(--paper);color:var(--ink);' +
      'border-radius:18px;box-shadow:var(--shadow);padding:12px 14px 8px;border-left:6px solid var(--water);font-size:14px;line-height:1.4}' +
      '#creekNotice b{font-family:Georgia,serif;font-size:16px}#creekNotice p{margin:4px 0 6px;font-family:Georgia,serif;font-size:14.5px}' +
      '#creekNotice .cn-detail{font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;background:var(--paper2);border-radius:10px;padding:6px 8px;margin:4px 0;color:var(--ink2);' +
      'max-height:54px;overflow:hidden;word-break:break-word;-webkit-user-select:text;user-select:text}#creekNotice .cn-detail.open{max-height:30vh;overflow:auto}' +
      '#creekNotice .cn-row{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin-top:4px}#creekNotice .cn-row button{min-height:40px;padding:8px 14px;border-radius:999px;font-weight:600;font-size:14px}' +
      '#creekNotice .plain{background:transparent;outline:1.5px solid #cdbf9f}' +
      '#stormProg .ctl{display:flex;gap:6px;margin-top:6px}#stormProg .ctl button{flex:1;min-height:40px;border-radius:999px;background:var(--paper2);font-size:13px;font-weight:600;padding:0 6px;white-space:nowrap}' +
      '#stormProg .ctl button.on{background:#fff6dc;outline:2px solid var(--gold)}' +
      '#fpsBox{position:absolute;z-index:9;left:10px;bottom:calc(136px + var(--safe-b));background:rgba(59,42,26,.82);color:#fff6e6;border-radius:999px;padding:3px 10px;' +
      'font:12px/1.3 ui-monospace,Menlo,Consolas,monospace;pointer-events:none}' +
      '.reduce-motion *,.reduce-motion *::before,.reduce-motion *::after{transition:none !important;animation:none !important}');
  }

  // ---------------------------------------------------------------- memory guard (a lighter detail level when the finest does not fit)
  function memoryGuard() {
    const origLoad = game.loadLevel, origCal = game.calibrate;
    let told = 0;
    const explain = (from, to) => {
      if (Date.now() - told < 5000) return; told = Date.now();
      notice({ title: 'Using a lighter detail level', text: 'This device is short on memory for ' + C.levels[from] + ' m cells, so the ranch is drawn with ' + C.levels[to] + ' m cells instead. Everything still works the same.' });
    };
    game.loadLevel = async function (L) {
      let lvl = L;
      while (lvl < LAST && !perf.levelOk(lvl)) lvl++;
      for (;;) {
        try {
          await origLoad.call(this, lvl);
          const gl = this.gl; if (gl && gl.getError && gl.getError() === gl.OUT_OF_MEMORY) throw new Error('The graphics chip ran out of memory.');
          break;
        } catch (e) {
          if (lvl >= LAST) throw e;
          console.warn('[creek] level ' + lvl + ' did not fit in memory, trying a lighter one:', e && e.message || e);
          lvl++;
        }
      }
      if (lvl !== L) explain(L, lvl);
      return undefined;
    };
    // the automatic pick at start-up must not choose a level the guard would refuse
    game.calibrate = function () { let L = origCal.apply(this, arguments); while (L < LAST && !perf.levelOk(L)) L++; return L; };
  }

  // ---------------------------------------------------------------- sharpness (render scale)
  const sharp = () => Math.min(1, Math.max(0.5, +S().get('perf.sharpness', 1) || 1));
  function sharpness() {
    const origResize = game.resize;
    game.resize = function () {
      origResize.apply(this, arguments);
      perf.wake();
      const s = sharp(); if (s >= 0.999 || !this.cw) return;
      const dpr = this.dpr * s, w = Math.max(2, Math.round(this.cw * dpr)), h = Math.max(2, Math.round(this.ch * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.dpr = dpr;                                                       // the drawing code multiplies the zoom by game.dpr, so the picture stays the same size
      const vp = this.provider && this.provider(); if (vp && vp.resize) this._guard('view provider resize', () => vp.resize());
    };
    let t = null;
    S().on('perf.sharpness', () => { clearTimeout(t); t = setTimeout(() => { if (game.cw) game.resize(); }, 150); });
  }

  /** The map drawing wants to know the real pixel ratio (it is lower than the screen's when Sharpness is below 1). Add it to the state it is given. */
  function patchRenderer(g) {
    const r = g.renderer; if (!r || r._dprPatched || typeof r.draw !== 'function') return;
    const draw = r.draw; r._dprPatched = true;
    r.draw = function (v, s, w, h) { if (s && s.dpr == null) s.dpr = g.dpr; return draw.call(this, v, s, w, h); };
  }

  // ---------------------------------------------------------------- the rows in the Settings card
  function rows() {
    const lvlName = () => (C.levelNames[game.level] || '').split(' · ')[0] + ' (' + C.levels[game.level] + ' m cells)';
    ui.addSetting({
      id: 'perf.level', label: 'Detail level', type: 'choice',
      get help() { return 'Now: ' + lvlName() + '. Finer looks nicer but storms run slower. Changing it starts the ranch over.'; },
      options: [{ value: 'pick', label: 'Change…' }],
      get: () => null,
      set: () => {
        const b = document.querySelector('#card .btns .go'); if (b) b.click(); else ui.closeCard();
        setTimeout(() => guard('level picker', () => ui.levelPicker()), 0);
      }
    });
    ui.addSetting({ id: 'perf.sharpness', label: 'Sharpness', help: 'Lower is a little blurrier but much faster on a slow phone. 1 is the sharpest.', type: 'slider', min: 0.5, max: 1, step: 0.05, default: 1 });
    ui.addSetting({ id: 'reduceMotion', label: 'Reduce motion', help: 'Calmer water, softer lightning, no sliding movements.', type: 'toggle', default: false });
    ui.addSetting({ id: 'perf.showFps', label: 'Show frame rate', help: 'A small number in the corner: how many pictures the game draws each second.', type: 'toggle', default: false });
    ui.addSetting({ id: 'perf.fastStorms', label: 'Fast storms', help: 'Storms start in fast-forward. You can still pause or slow them.', type: 'toggle', default: false });
  }

  // ---------------------------------------------------------------- reduce motion
  function motion() {
    // the computer or phone may already ask for less movement
    try { if (!S().has('reduceMotion') && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) S().set('reduceMotion', true); } catch (e) { /* ignore */ }
    const apply = () => document.documentElement.classList.toggle('reduce-motion', perf.reduceMotion());
    S().on('reduceMotion', () => { apply(); perf.wake(); }); apply();
  }

  // ---------------------------------------------------------------- pause and fast-forward (inside the storm box)
  let syncChips = () => {};
  function stormControls() {
    const prog = $('stormProg'); if (!prog) return;
    const row = document.createElement('span'); row.className = 'ctl';
    const pause = document.createElement('button'), fast = document.createElement('button');
    pause.id = 'btnPause'; fast.id = 'btnFast';
    pause.setAttribute('aria-label', 'Pause or play the storm'); fast.setAttribute('aria-label', 'Fast-forward the storm');
    row.appendChild(pause); row.appendChild(fast); prog.appendChild(row);
    const sync = syncChips = () => {
      const p = !!game.paused, f = !!game.fast;
      const pt = p ? '▶ Play' : '⏸ Pause', ft = '⏩ Fast';
      if (pause.textContent !== pt) pause.textContent = pt;
      if (fast.textContent !== ft) fast.textContent = ft;
      fast.classList.toggle('on', f); pause.classList.toggle('on', p);
    };
    pause.onclick = () => guard('pause', () => { togglePause(); });
    fast.onclick = () => guard('fast', () => { toggleFast(); });
    game.on('stormStart', () => { game.paused = false; game.fast = !!S().get('perf.fastStorms', false); sync(); });
    game.on('stormEnd', () => { game.paused = false; game.fast = false; sync(); });
    S().on('perf.fastStorms', (v) => { if (game.storm) { game.fast = !!v; sync(); } });
    sync();
  }
  function togglePause() { if (!game.storm) return false; game.paused = !game.paused; syncChips(); perf.wake(); return true; }
  function toggleFast() { if (!game.storm) return false; game.fast = !game.fast; syncChips(); perf.wake(); return true; }

  // ---------------------------------------------------------------- keys
  function shortcuts() {
    const blurButton = () => { const a = document.activeElement; if (a && a !== document.body && a.blur && /^(BUTTON|CANVAS)$/.test(a.tagName)) a.blur(); };   // so Space does not also "press" a focused button
    Creek.shortcuts.add({ key: 'space', desc: 'Pause or play the storm', fn: () => { blurButton(); return togglePause() ? undefined : false; } });
    Creek.shortcuts.add({ key: 'f', desc: 'Fast-forward the storm', fn: () => (toggleFast() ? undefined : false) });
    Creek.shortcuts.add({ key: 's', desc: 'Quick save', fn: () => {
      if (!Creek.save || !game.ready) return false;
      Creek.save.quickSave(); return undefined;
    } });
  }

  // ---------------------------------------------------------------- resting (fewer pictures when nothing moves)
  let lastActive = 0, lastDraw = 0, inGate = false, other = null, draws = 0, camSig = '';
  function busy(g, now) {
    if (g.storm || g.stroke || g.activeHint || g.pointers.size || !g.ready) return true;
    if (now - lastActive < 1000 || now < wakeUntil) return true;
    const vp = g.provider && g.provider();
    if (vp && !(Creek.view3d && Creek.view3d.isIdle && Creek.view3d.isIdle())) return true;     // a 3D view may be moving on its own
    return false;
  }
  function resting() {
    const touch = () => { lastActive = performance.now(); };
    ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'touchstart', 'touchmove', 'resize', 'orientationchange'].forEach((n) => window.addEventListener(n, touch, { capture: true, passive: true }));
    ['terrain', 'lens', 'toolChanged', 'ready', 'cash', 'reset', 'stormStart', 'stormEnd', 'season', 'fieldUse'].forEach((n) => game.on(n, touch));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });
    game.on('frame', () => {                                                    // the camera moving on its own (zoom to a hint, focus on a spot)
      const c = game.cam, sig = c.x.toFixed(1) + ',' + c.y.toFixed(1) + ',' + c.scale.toFixed(4) + ',' + game.terrainVersion;
      if (sig !== camSig) { camSig = sig; touch(); }
    });
    const mine = (g) => {
      if (document.hidden) return false;
      const now = performance.now();
      if (busy(g, now)) { lastDraw = now; return true; }
      if (now - lastDraw < 110) return false;                                     // about 8 pictures a second
      lastDraw = now; return true;
    };
    // game.frameGate is one slot; other modules may set it too. Whatever they set is asked after mine, so both rules apply.
    const combined = function (g, dt) {
      if (inGate) return true;
      inGate = true;
      try {
        if (!mine(g)) return false;
        if (other && other(g, dt) === false) return false;
        draws++; return true;
      } finally { inGate = false; }
    };
    Object.defineProperty(game, 'frameGate', { configurable: true, enumerable: true, get: () => combined, set: (fn) => { other = typeof fn === 'function' && fn !== combined ? fn : null; } });
    perf.isResting = () => !busy(game, performance.now());
    perf.drawCount = () => draws;                                                   // pictures drawn so far (for the frame-rate readout and tests)
  }

  // ---------------------------------------------------------------- frame rate readout
  function fpsBox() {
    const el = document.createElement('div'); el.id = 'fpsBox'; el.className = 'hidden'; ($('app') || document.body).appendChild(el);
    let t0 = performance.now(), n0 = 0, timer = null;
    const show = () => {
      const on = !!S().get('perf.showFps', false); el.classList.toggle('hidden', !on);
      clearInterval(timer); timer = null;
      if (!on) return;
      t0 = performance.now(); n0 = draws;
      timer = setInterval(() => {
        const now = performance.now(), fps = (draws - n0) * 1000 / Math.max(now - t0, 1); t0 = now; n0 = draws;
        el.textContent = Math.round(fps) + ' fps' + (perf.isResting && perf.isResting() ? ' · resting' : '') + (game.fast && game.storm ? ' · fast' : '');
      }, 500);
      el.textContent = '… fps';
    };
    S().on('perf.showFps', show); show();
  }

  // ---------------------------------------------------------------- the graphics chip goes away and comes back
  function contextLoss() {
    const cv = game.canvas; let lost = false, recovering = false, note = null, timer = null;
    /** The chip is gone: freeze the game, drop any storm, say so calmly. Safe to call more than once. */
    function markLost() {
      if (lost) return;
      lost = true; game.ready = false;
      if (game.storm) {                                                        // the storm cannot go on: drop it quietly
        game.storm = null; game.turbo = false; game.paused = false; game.fast = false;
        guard('hide storm box', () => { $('stormProg').classList.add('hidden'); ui.lockStorms(false); });
      }
      note = notice({ title: 'The picture went to sleep', text: 'Your graphics chip needed a break. Hold on while the ranch is put back.', sticky: true });
      clearTimeout(timer);
      timer = setTimeout(() => { if (lost) notice({ title: 'Still waiting for the picture', text: 'It is taking a while. You can reload the game; your last autosave will still be there.', buttons: [{ label: 'Reload', primary: true, onClick: () => location.reload() }] }); }, 8000);
    }
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); markLost(); });     // preventDefault says "yes, please give it back"
    // the browser tells us a moment after the loss; a frame in between would fail and show a scary "something went wrong": catch that here
    const origReport = game.reportError;
    game.reportError = function (err) {
      if (this.gl && this.gl.isContextLost && this.gl.isContextLost()) { markLost(); return; }
      return origReport.apply(this, arguments);
    };
    cv.addEventListener('webglcontextrestored', () => { clearTimeout(timer); recover(); });
    async function recover() {
      if (recovering) return; recovering = true;
      try {
        const gl = game.gl;
        gl.getExtension('EXT_color_buffer_float');
        if (Creek.Sim) Creek.Sim._shared = null;                               // the compiled shader programs died with the old context
        game.renderer = new Creek.Renderer(gl); patchRenderer(game);
        if (game.resetGLState) game.resetGLState();
        await game.loadLevel(game.level);
        let back = false;
        if (Creek.save && Creek.save.hasAuto()) { const r = await Creek.save.load('auto', { silent: true, quiet: true }); back = !!r.ok; }
        if (!back && Creek.story && Creek.story.free) Creek.story.free();
        lost = false;
        if (note) note.close();
        const hi = notice({ title: 'The picture is back', text: back ? 'Your ranch was put back from the last autosave.' : 'The ranch was started fresh, because there was no autosave yet.' });
        setTimeout(() => hi.close(), 6000);
      } catch (e) {
        console.warn('[creek] could not rebuild after losing the graphics chip:', e);
        notice({ title: 'The picture did not come back', text: 'Please reload the game. Your last autosave will still be there.', buttons: [{ label: 'Reload', primary: true, onClick: () => location.reload() }] });
      } finally { recovering = false; }
    }
  }
})();
