/* Saving and loading the ranch. Module id "save", exposes Creek.save (described in docs/EXTENSION_API.md, "Cross-module ids").
   Where it lives: IndexedDB database "creek-care", two stores. "meta" holds a tiny record per slot (date, year, cash, a small
   picture) so the Load card opens fast. "data" holds the heavy part (the land as two raw number arrays, plus the game state as JSON).
   Slots: "auto" (kept up to date by the game), "slot1", "slot2", "slot3" (the player's own).
   If IndexedDB is missing or blocked the game works exactly as before; saving then says so in plain words.
   Other code can add its own progress to a save with Creek.save.extraState (see the bottom). */
(function () {
  const C = Creek.CONFIG;
  const VERSION = 1, DB_NAME = 'creek-care', IDX_KEY = 'creek.save.index';
  const SLOTS = ['auto', 'slot1', 'slot2', 'slot3'];
  const LABEL = { auto: 'Autosave', slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3' };
  const SEASON_NAME = { summer: 'Summer', fall: 'Fall', winter: 'Winter', spring: 'Spring' };
  const MSG = {
    nodb: 'Saving does not work in this browser right now (a private window can block it). The game still works.',
    quota: 'There is not enough room on this device to save. Delete an old save, or free up some space.',
    storm: 'A storm is going. Do this when it is over, or press Skip.',
    notready: 'The ranch is still getting ready. Try again in a moment.',
    damaged: 'That save looks broken, so it was not opened. Your ranch is just as you left it.',
    version: 'That save is from a different version of the game, so it cannot be opened here.',
    empty: 'There is nothing saved there yet.',
    generic: 'Something went wrong while saving. The game is fine. Try again in a moment.'
  };
  let game = null, ui = null;

  // ---------------------------------------------------------------- small helpers
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 20 : ms));
  /** An error whose message is already kid-friendly. */
  function fe(code, message) { const e = new Error(message); e.code = code; e.friendly = true; return e; }
  /** Any thrown thing -> {code, message} in plain words. */
  function explain(e) {
    if (e && e.friendly) return { code: e.code, message: e.message };
    const name = e && e.name, text = String(e && e.message || '');
    if (name === 'QuotaExceededError' || /quota/i.test(text)) return { code: 'quota', message: MSG.quota };
    if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') return { code: 'nodb', message: MSG.nodb };
    return { code: 'error', message: MSG.generic };
  }
  const warn = (what, e) => { try { console.warn('[creek] save: ' + what, e); } catch (x) { /* ignore */ } };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  /** A JSON copy with every typed array left out (the land never goes into the JSON part). */
  function plain(o) {
    if (o === undefined || o === null) return null;
    try { return JSON.parse(JSON.stringify(o, (k, v) => (ArrayBuffer.isView(v) || v instanceof ArrayBuffer ? undefined : v))); } catch (e) { return null; }
  }
  function lastSlot() { const s = Creek.settings.get('save.lastSlot', 'slot1'); return SLOTS.indexOf(s) > 0 ? s : 'slot1'; }

  // ---------------------------------------------------------------- the quick index (so hasAuto() can answer without waiting)
  // localStorage holds a tiny copy of each slot's meta (no picture). IndexedDB is the truth; refresh() fixes the copy.
  const index = {};
  function readIndex() {
    try { const o = JSON.parse(localStorage.getItem(IDX_KEY) || '{}'); SLOTS.forEach((s) => { if (o && o[s] && typeof o[s] === 'object') index[s] = o[s]; }); } catch (e) { /* no storage: start empty */ }
  }
  function writeIndex() { try { localStorage.setItem(IDX_KEY, JSON.stringify(index)); } catch (e) { /* ignore */ } }
  function small(m) { return { version: m.version, time: m.time, level: m.level, year: m.year, season: m.season, cash: m.cash, mode: m.mode, bytes: m.bytes }; }
  function validMeta(m) {
    return !!m && typeof m === 'object' && typeof m.version === 'number' && typeof m.time === 'number' && typeof m.level === 'number' &&
      typeof m.year === 'number' && typeof m.season === 'string' && typeof m.cash === 'number';
  }
  readIndex();

  // ---------------------------------------------------------------- IndexedDB, every call wrapped
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    const p = dbp = new Promise((resolve, reject) => {
      let req;
      try {
        if (!window.indexedDB) throw fe('nodb', MSG.nodb);
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) { reject(e.friendly ? e : fe('nodb', MSG.nodb)); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } dbp = null; };
        db.onclose = () => { dbp = null; };
        resolve(db);
      };
      req.onerror = () => reject(fe('nodb', MSG.nodb));
      req.onblocked = () => reject(fe('nodb', MSG.nodb));
    });
    p.catch(() => { if (dbp === p) dbp = null; });      // a failed open is tried again next time
    return p;
  }
  /** Run work(tx, set) inside one transaction; resolves with whatever work gave to set() once the transaction has committed. */
  function withStores(names, mode, work) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      let tx, out;
      try { tx = db.transaction(names, mode); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(tx.error || new Error('The save was stopped.'));
      try { work(tx, (v) => { out = v; }); } catch (e) { try { tx.abort(); } catch (e2) { /* ignore */ } reject(e); }
    }));
  }
  const idbWrite = (slot, meta, data) => withStores(['meta', 'data'], 'readwrite', (tx) => { tx.objectStore('data').put(data, slot); tx.objectStore('meta').put(meta, slot); });
  const idbRead = (slot) => withStores(['meta', 'data'], 'readonly', (tx, set) => {
    const r = {}; set(r);
    tx.objectStore('meta').get(slot).onsuccess = (e) => { r.meta = e.target.result; };
    tx.objectStore('data').get(slot).onsuccess = (e) => { r.data = e.target.result; };
  });
  const idbDelete = (slot) => withStores(['meta', 'data'], 'readwrite', (tx) => { tx.objectStore('meta').delete(slot); tx.objectStore('data').delete(slot); });
  const idbAllMeta = () => withStores(['meta'], 'readonly', (tx, set) => {
    const out = {}; set(out);
    const cur = tx.objectStore('meta').openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } };
  });
  /** Is there probably room for `bytes` more? (Only says no when the browser reports a quota and it is clearly too small.) */
  async function roomFor(bytes, oldBytes) {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        if (e && e.quota > 0) return e.quota - (e.usage || 0) + (oldBytes || 0) > bytes * 1.05;
      }
    } catch (e) { /* unknown: let the write try */ }
    return true;
  }

  // ---------------------------------------------------------------- extra state from other code (story progress, ...)
  const extras = [];
  /** Creek.save.extraState(fn, {id}) or extraState({id, save(), load(json, info)}).
      fn('save') must return json (or undefined to save nothing). fn('load', json, info) gets that json back after the ranch is restored
      (json is null if the save has none) and returns true if it has taken over setting up the game mode (e.g. resumes the story);
      if nobody returns true the game carries on in free play. info = {slot, meta}. Returns a function that removes the hook. */
  function extraState(fn, opts) {
    let h;
    if (typeof fn === 'function') h = { id: (opts && opts.id) || fn.id || ('x' + extras.length), save: () => fn('save'), load: (j, info) => fn('load', j, info) };
    else if (fn && typeof fn.save === 'function' && typeof fn.load === 'function') h = { id: fn.id || (opts && opts.id) || ('x' + extras.length), save: () => fn.save(), load: (j, info) => fn.load(j, info) };
    else { warn('extraState needs a function or {save, load}'); return function () {}; }
    extras.push(h);
    return () => { const i = extras.indexOf(h); if (i >= 0) extras.splice(i, 1); };
  }
  function collectExtra() {
    const o = {};
    extras.forEach((h) => { try { const v = h.save(); if (v !== undefined) o[h.id] = plain(v); } catch (e) { warn('an extraState hook failed', e); } });
    return o;
  }
  function runExtraLoad(saved, info) {
    let handled = false;
    extras.forEach((h) => { try { if (h.load(saved && saved[h.id] !== undefined ? saved[h.id] : null, info) === true) handled = true; } catch (e) { warn('an extraState hook failed', e); } });
    return handled;
  }

  // ---------------------------------------------------------------- building a save
  function buildState() {
    return {
      uses: game.fields.map((f) => f.use), mapW: C.mapW, mapH: C.mapH,
      cash: game.cash, ledger: plain(game.ledger) || [], groundwater: game.groundwater, year: game.year, season: game.season, baseMoist: game.baseMoist,
      hintsShown: plain(game.hintsShown) || {}, lastStorm: plain(game.lastStorm), baseline: plain(game.baseline), stormHistory: plain(game.stormHistory) || [],
      upstreamFactor: game.upstreamFactor, tool: game.tool, sizeIdx: game.sizeIdx, optIdx: plain(game.optIdx) || {}, mode: ui.mode,
      modules: plain(game.collectState()) || {}, extra: collectExtra()
    };
  }
  let busy = 0, tail = Promise.resolve(), loading = false;
  /** One save or load at a time. */
  function exclusive(fn) {
    busy++;
    const run = tail.then(fn, fn);
    tail = run.then(() => { busy--; }, () => { busy--; });
    return run;
  }
  /** Progress helper: the caller's own, or the full-screen "loading" bar (not for quiet saves). */
  function reporter(o) {
    const r = { shown: false };
    r.say = (m, f) => { if (o.onProgress) { try { o.onProgress(m, f); } catch (e) { /* ignore */ } } else if (!o.quiet && ui) { r.shown = true; ui.splash(m, f); } };
    r.done = () => { if (r.shown && ui) ui.splash(null); };
    return r;
  }
  function say(o, ok, message) { if (!o.silent && ui && message) ui.toast(message); }

  function save(slot, opts) {
    opts = opts || {};
    if (SLOTS.indexOf(slot) < 0) return Promise.resolve({ ok: false, code: 'error', message: MSG.generic });
    if (opts.quiet && busy) return Promise.resolve({ ok: false, code: 'busy', message: '' });      // an autosave never queues up
    return exclusive(() => doSave(slot, opts));
  }
  async function doSave(slot, o) {
    const rep = reporter(o);
    try {
      const stop = () => { if (!game || !game.ready || !game.sim) throw fe('notready', MSG.notready); if (game.storm) throw fe('storm', MSG.storm); };
      stop();
      rep.say('Getting ready to save…', 0.05); if (!o.fast) await tick();
      stop(); rep.say('Reading the land…', 0.15); if (!o.fast) await tick();
      stop();
      // everything that reads the graphics chip happens together, with nothing in between, so the pieces belong to the same moment
      let thumb = null; try { thumb = game.snapshot(240); } catch (e) { /* a save without a picture is still a save */ }
      const T = game.sim.readTerrain(), M = game.sim.readMoisture(), state = buildState();
      const meta = { version: VERSION, time: Date.now(), level: game.level, year: game.year, season: game.season, cash: Math.round(game.cash), mode: ui.mode, thumb, bytes: T.byteLength + M.byteLength };
      rep.say('Checking there is room…', 0.3); if (!o.fast) await tick();
      const old = index[slot];
      if (!(await roomFor(meta.bytes, old && old.bytes))) throw fe('quota', MSG.quota);
      rep.say('Writing to this device…', 0.5); if (!o.fast) await tick();
      await idbWrite(slot, meta, { T: T.buffer, M: M.buffer, state });
      index[slot] = small(meta); writeIndex();
      if (slot !== 'auto') Creek.settings.set('save.lastSlot', slot);
      const message = 'Saved to ' + LABEL[slot] + '.';
      say(o, true, message);
      game.emit('saved', { slot, meta });
      return { ok: true, slot, message };
    } catch (e) {
      const x = explain(e); if (!e || !e.friendly) warn('saving failed', e);
      say(o, false, x.message);
      return { ok: false, code: x.code, message: x.message };
    } finally { rep.done(); }
  }

  // ---------------------------------------------------------------- opening a save
  /** Check a record from the database. Returns what load needs; throws a friendly error if anything is off. */
  function validate(rec) {
    const m = rec && rec.meta, d = rec && rec.data;
    if (!m && !d) throw fe('empty', MSG.empty);
    if (!validMeta(m) || !d || typeof d !== 'object') throw fe('damaged', MSG.damaged);
    if (m.version !== VERSION) throw fe(m.version > VERSION ? 'version' : 'damaged', m.version > VERSION ? MSG.version : MSG.damaged);
    if (m.level < 0 || m.level >= C.levels.length || m.level % 1 !== 0) throw fe('damaged', MSG.damaged);
    const dx = C.levels[m.level], bytes = Math.round(C.mapW / dx) * Math.round(C.mapH / dx) * 16;
    if (!(d.T instanceof ArrayBuffer) || !(d.M instanceof ArrayBuffer) || d.T.byteLength !== bytes || d.M.byteLength !== bytes) throw fe('damaged', MSG.damaged);
    const s = d.state;
    if (!s || typeof s !== 'object' || !Array.isArray(s.uses) || Creek.SEASONS.indexOf(s.season) < 0) throw fe('damaged', MSG.damaged);
    if (s.mapW !== undefined && (s.mapW !== C.mapW || s.mapH !== C.mapH)) throw fe('version', MSG.version);
    if (game.fields && s.uses.length !== game.fields.length) throw fe('version', MSG.version);
    if (!isFinite(s.cash) || !isFinite(s.year) || s.year < 1) throw fe('damaged', MSG.damaged);
    return { meta: m, T: d.T, M: d.M, s };
  }

  function load(slot, opts) {
    opts = opts || {};
    if (SLOTS.indexOf(slot) < 0) return Promise.resolve({ ok: false, code: 'error', message: MSG.generic });
    return exclusive(() => doLoad(slot, opts));
  }
  async function doLoad(slot, o) {
    const rep = reporter(o);
    loading = true;
    try {
      if (!game || !game.ready || !game.sim) throw fe('notready', MSG.notready);
      if (game.storm) throw fe('storm', MSG.storm);
      rep.say('Opening your save…', 0.05); await tick();
      const rec = validate(await idbRead(slot));
      const m = rec.meta;
      if (Creek.perf && Creek.perf.levelOk && !Creek.perf.levelOk(m.level)) throw fe('memory', 'That save needs more memory than this device can spare. Try loading it on a bigger computer.');
      if (m.level !== game.level) {
        rep.say('Surveying the ranch…', 0.15);
        await game.loadLevel(m.level);                                    // the land is rebuilt the same way every time, then the saved land goes on top
        if (game.level !== m.level) { freePlay(); throw fe('level', 'This device could not open that save’s detail level, so it started a fresh ranch instead.'); }
      }
      rep.say('Putting the land back…', 0.7); await tick();
      const note = apply(rec, slot);
      if (slot !== 'auto') Creek.settings.set('save.lastSlot', slot);
      const message = 'Loaded ' + LABEL[slot] + '.' + (note ? ' ' + note : '');
      say(o, true, message);
      return { ok: true, slot, message, meta: m };
    } catch (e) {
      const x = explain(e); if (!e || !e.friendly) warn('loading failed', e);
      say(o, false, x.message);
      return { ok: false, code: x.code, message: x.message };
    } finally { loading = false; rep.done(); }
  }

  /** Free-play furniture without resetting the ranch (what Creek.story.free() sets up, minus the reset). Also stops a running story. */
  function freePlay() {
    if (Creek.story) Creek.story.token++;
    ui.mode = 'free'; game.allowed = null; ui.stormEndHook = null; ui.advanceLabel = null;
    ui.onStorm = (size) => game.startStorm(size);
    ui.seasonBar(null, () => {
      const r = game.advanceSeason();
      ui.toast((r.net >= 0 ? 'The season earned ' : 'The season cost ') + ui.money(Math.abs(r.net)) + '.'); ui.refreshSeasonBar(); ui.refreshHints();
    });
  }
  /** Put a validated record into the running game. */
  function apply(rec, slot) {
    const s = rec.s, sim = game.sim;
    if (game.stroke) game.cancelStroke(false);
    game.paused = false; game.fast = false;
    // water and mud on the ground go first (this changes the land a little); the saved land then replaces it exactly
    sim.dryOut(num(s.baseMoist, C.seasons[s.season].moist), 0); sim.clearRecord();
    game.fields.forEach((f, i) => { if (C.uses[s.uses[i]]) f.use = s.uses[i]; });
    game.cash = s.cash; game.ledger = Array.isArray(s.ledger) ? s.ledger : []; game.groundwater = num(s.groundwater, 9000);
    game.year = Math.round(s.year); game.season = s.season; game.baseMoist = num(s.baseMoist, C.seasons[s.season].moist);
    game.hintsShown = s.hintsShown && typeof s.hintsShown === 'object' ? s.hintsShown : {};
    game.lastStorm = s.lastStorm || null; game.baseline = s.baseline || null; game.stormHistory = Array.isArray(s.stormHistory) ? s.stormHistory : [];
    game.analysis = null; game.undoState = null; game.upstreamFactor = num(s.upstreamFactor, 1);
    const onR = sim.onRestore; sim.onRestore = null;                       // one "terrain" event at the very end instead of one now
    try { sim.restore(new Float32Array(rec.T), new Float32Array(rec.M)); } finally { sim.onRestore = onR; }
    game.applyState(s.modules);                                              // module state registered with game.registerState
    const handled = runExtraLoad(s.extra, { slot, meta: rec.meta });
    let note = '';
    if (!handled) {
      freePlay();
      if (rec.meta.mode === 'story') note = 'The story is not remembered yet, so you carry on in free play.';
    }
    // tool choices (after the game mode is set up, because a story step can lock tools)
    if (s.optIdx && typeof s.optIdx === 'object') Object.keys(s.optIdx).forEach((k) => { if (typeof s.optIdx[k] === 'number') game.optIdx[k] = s.optIdx[k]; });
    if (typeof s.sizeIdx === 'number') game.sizeIdx = s.sizeIdx;
    game._guard('restore tool', () => { if (Creek.TOOLS.some((t) => t.id === s.tool) && game.canUse(s.tool)) game.setTool(s.tool); });
    const rep = document.getElementById('report'); if (rep) rep.classList.add('hidden');            // the last storm's card belongs to the old ranch
    game.cashChanged(); ui.buildLabels(); ui.refreshSeasonBar(); ui.updateTools();
    game.terrainChanged();
    game._guard('refresh hints', () => ui.refreshHints());
    pristine = false; dirty = false; clearTimeout(timer); timer = null; timerDue = 0;
    game.emit('loaded', { slot, meta: rec.meta });
    return note;
  }

  // ---------------------------------------------------------------- list / remove / refresh
  async function list() {
    let metas = {}, bad = false;
    try { metas = await idbAllMeta(); } catch (e) { bad = true; if (!(e && e.friendly)) warn('listing failed', e); }
    const out = SLOTS.map((slot) => {
      const m = metas[slot];
      if (!m) return { slot, label: LABEL[slot], meta: null, empty: true };
      if (!validMeta(m)) return { slot, label: LABEL[slot], meta: null, damaged: true };
      return { slot, label: LABEL[slot], meta: m, newer: m.version > VERSION };
    });
    out.unavailable = bad;
    if (!bad) { SLOTS.forEach((s) => { if (out.find((x) => x.slot === s).meta) index[s] = small(metas[s]); else delete index[s]; }); writeIndex(); }
    return out;
  }
  async function remove(slot) {
    if (SLOTS.indexOf(slot) < 0) return false;
    try { await idbDelete(slot); delete index[slot]; writeIndex(); return true; } catch (e) { warn('deleting failed', e); return false; }
  }
  let resolveReady; const readyP = new Promise((r) => { resolveReady = r; });
  function refresh() { return list().then(() => { resolveReady(); return true; }, () => { resolveReady(); return false; }); }

  // ---------------------------------------------------------------- autosave
  const delays = { event: 1500, idle: 45000 };     // after a season / storm; after the player's last edit (changeable for tests)
  let pristine = true, dirty = false, timer = null, timerDue = 0, autoOff = false, quotaToldAt = 0;
  function schedule(ms) {
    const due = Date.now() + ms;
    if (timer && timerDue <= due) return;
    clearTimeout(timer); timerDue = due; timer = setTimeout(() => { timer = null; timerDue = 0; autosave('timer'); }, ms);
  }
  function markChange(ms) { if (loading || !game || !game.ready) return; pristine = false; dirty = true; schedule(ms); }
  async function autosave(why) {
    if (!game || !game.ready || loading || autoOff || !dirty || pristine) return;
    if (game.storm) return;                                                   // never during a storm; the end of the storm saves
    if (why !== 'hidden' && (game.stroke || (game.pointers && game.pointers.size))) { schedule(3000); return; }
    const r = await save('auto', { quiet: true, silent: true, fast: why === 'hidden' });
    if (r.ok) dirty = false;
    else if (r.code === 'nodb') autoOff = true;
    else if (r.code === 'quota' && Date.now() - quotaToldAt > 600000) { quotaToldAt = Date.now(); ui.toast('The ranch could not be saved automatically: this device is full.'); }
  }

  // ---------------------------------------------------------------- the Save / Load card
  function css() {
    ui.styles(
      '.svlist{display:flex;flex-direction:column;gap:8px;margin:8px 0 4px;max-height:56vh;overflow:auto;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      '.svrow{display:flex;gap:10px;align-items:flex-start;background:var(--paper2);border-radius:14px;padding:8px}' +
      '.svthumb{flex:0 0 84px;width:84px;height:87px;border-radius:10px;background:#d9ccae;object-fit:cover;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;color:var(--ink2);overflow:hidden}' +
      '.svinfo{flex:1;min-width:0}.svname{font-family:Georgia,serif;font-weight:700;font-size:16px}' +
      '.svline{font-size:13px;color:var(--ink2);line-height:1.35}.svline b{color:var(--ink)}' +
      '.svbtns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
      '.svbtns button{min-height:40px;padding:8px 14px;border-radius:999px;font-size:14px;font-weight:600}' +
      '.svbtns .plain{background:transparent;outline:1.5px solid #cdbf9f;padding:8px 12px}.svbtns .armed{background:var(--clay);color:#fff;outline:0}' +
      '.svbtns button:disabled{opacity:.5}.svstatus{min-height:22px;font-size:13.5px;margin:6px 4px 0;color:var(--ink2);font-family:system-ui,sans-serif}' +
      '.svstatus.bad{color:var(--clay)}');
  }
  async function openCard(mode) {
    const saving = mode === 'save';
    let box = null, status = null, cardEl = null, working = false;
    const setStatus = (t, bad) => { if (status) { status.textContent = t || ''; status.classList.toggle('bad', !!bad); } };
    const closeCard = () => { const b = cardEl && cardEl.querySelector('.btns .go'); if (b) b.click(); else ui.closeCard(); };
    function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    /** Two taps for anything that throws something away: the first tap asks "Sure?", the second does it. */
    function confirmTap(btn, ask, go) {
      btn.onclick = () => {
        const label = btn.textContent;
        btn.textContent = ask; btn.classList.add('armed');
        const t = setTimeout(() => { btn.textContent = label; btn.classList.remove('armed'); btn.onclick = () => confirmTap(btn, ask, go); }, 3000);
        btn.onclick = () => { clearTimeout(t); go(); };
      };
      btn.onclick();
    }
    function row(it) {
      const r = el('div', 'svrow'), m = it.meta, info = el('div', 'svinfo');
      const th = m && typeof m.thumb === 'string' && m.thumb.indexOf('data:image/') === 0 ? el('img', 'svthumb') : el('div', 'svthumb', m ? 'No picture' : it.damaged ? 'Broken' : 'Empty');
      if (th.tagName === 'IMG') { th.src = m.thumb; th.alt = ''; }
      r.appendChild(th); r.appendChild(info);
      info.appendChild(el('div', 'svname', it.label));
      if (m) {
        const L = el('div', 'svline'); L.innerHTML = '<b>Year ' + ui.esc(m.year) + ' · ' + ui.esc(SEASON_NAME[m.season] || m.season) + '</b> · ' + ui.esc(ui.money(m.cash)); info.appendChild(L);
        info.appendChild(el('div', 'svline', when(m.time) + ' · ' + (m.mode === 'story' ? 'Story' : 'Free play') + ' · ' + (C.levelNames[m.level] || '').split(' · ')[0] + ' detail'));
      } else info.appendChild(el('div', 'svline', it.damaged ? 'This one is broken. You can delete it.' : it.newer ? 'Made by a newer game.' : 'Nothing saved here yet.'));
      const bt = el('div', 'svbtns'); info.appendChild(bt);
      const mk = (label, cls, fn) => { const b = el('button', cls, label); b.onclick = fn; bt.appendChild(b); return b; };
      const loadBtn = () => {
        const b = mk('Load', saving ? 'go alt' : 'go', null);
        const go = () => { closeCard(); load(it.slot); };
        b.onclick = () => (dirty && !pristine ? confirmTap(b, 'Replace this ranch?', go) : go());
      };
      const saveBtn = () => {
        const b = mk('Save here', saving ? 'go' : 'go alt', null);
        const go = async () => {
          if (working) return; working = true; list_busy(true);
          const res = await save(it.slot, { silent: true, onProgress: (t, f) => setStatus(t + ' ' + Math.round((f || 0) * 100) + '%') });
          working = false; setStatus(res.message, !res.ok); await render(true);
        };
        b.onclick = () => (m ? confirmTap(b, 'Replace it?', go) : go());
      };
      const delBtn = () => {
        const b = mk('Delete', 'plain', null);
        b.onclick = () => confirmTap(b, 'Sure?', async () => { await remove(it.slot); setStatus(it.label + ' deleted.'); await render(true); });
      };
      if (it.slot === 'auto') { if (m && !it.newer) loadBtn(); if (m || it.damaged) delBtn(); }
      else if (saving) { saveBtn(); if (m && !it.newer) loadBtn(); if (m || it.damaged) delBtn(); }
      else { if (m && !it.newer) loadBtn(); saveBtn(); if (m || it.damaged) delBtn(); }
      return r;
    }
    function list_busy(on) { if (box) box.style.pointerEvents = on ? 'none' : ''; }
    async function render(keepStatus) {
      const items = await list();
      if (!box || !box.isConnected) return;
      list_busy(false); box.innerHTML = '';
      if (items.unavailable) { box.appendChild(el('div', 'svline', MSG.nodb)); return; }
      items.forEach((it) => box.appendChild(row(it)));
      if (!keepStatus) setStatus('');
    }
    await ui.card({
      title: saving ? 'Save the ranch' : 'Load a saved ranch',
      text: saving ? 'Pick a slot to keep this ranch in. The game also saves by itself after each season and each storm.' : 'Pick a saved ranch to go back to. The game saves by itself after each season and each storm.',
      html: '<div class="svlist"><div class="svline">Looking…</div></div><div class="svstatus" role="status" aria-live="polite"></div>',
      buttons: [{ label: 'Close' }],
      onShow: (card) => { cardEl = card; box = card.querySelector('.svlist'); status = card.querySelector('.svstatus'); render(); }
    });
  }
  function when(t) {
    try {
      const d = new Date(t), now = new Date(), day = d.toDateString();
      const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const name = day === now.toDateString() ? 'Today' : day === new Date(now - 864e5).toDateString() ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return name + ' at ' + time;
    } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------- the module
  Creek.save = {
    VERSION, SLOTS,
    /** True if an autosave is known to exist. Answers at once (from a tiny copy kept in localStorage; the first refresh() corrects it). */
    hasAuto: () => !!index.auto,
    /** What the Continue button can show: {time, level, year, season, cash, mode} of the autosave, or null. */
    autoInfo: () => (index.auto ? Object.assign({}, index.auto) : null),
    /** Can saving work here at all? (false when IndexedDB is missing; a blocked one is only found out when you try.) */
    available: () => !!window.indexedDB,
    /** Promise that resolves once the first look at the database is done (hasAuto() is then reliable). */
    ready: readyP, refresh,
    /** Promise of [{slot, label, meta|null, empty?, damaged?}] for auto, slot1..3. meta.thumb is a small JPEG data URL. */
    list,
    /** save(slot, opts) -> Promise<{ok, code, message}>; never rejects. opts: {silent (no toast), onProgress(text, 0..1)}. */
    save,
    /** load(slot, opts) -> Promise<{ok, code, message, meta}>; never rejects. Rebuilds the level first if the save was made at another one. */
    load,
    remove, extraState,
    /** Save into the slot used last (the S key). */
    quickSave: () => save(lastSlot()),
    openCard, lastSlot, delays,
    isBusy: () => busy > 0 || loading
  };

  Creek.registerModule({
    id: 'save',
    init: function (g, u) {
      game = g; ui = u; css();
      ui.addMenuItem({ label: 'Save game', onClick: () => openCard('save') });
      ui.addMenuItem({ label: 'Load game', onClick: () => openCard('load') });
      // changes that are worth keeping: a season, a storm (soon), the player's own edits (after a quiet spell)
      game.on('season', () => markChange(delays.event));
      game.on('stormEnd', () => markChange(delays.event));
      game.on('fieldUse', () => markChange(delays.idle));
      game.on('strokeEnd', (e) => {
        if (!e || e.cancelled) return;
        const def = Creek.TOOLS.find((t) => t.id === e.tool);
        if (!def || def.kind === 'look' || def.readonly) return;           // looking never changes the ranch
        markChange(delays.idle);
      });
      game.on('terrain', () => { if (!pristine && !loading) { dirty = true; schedule(delays.idle); } });
      const fresh = () => { pristine = true; dirty = false; clearTimeout(timer); timer = null; timerDue = 0; };
      game.on('reset', fresh); game.on('ready', () => { if (!loading) fresh(); });
      // leaving the page: save right away if there is anything new
      const away = () => { if (document.visibilityState === 'hidden') autosave('hidden'); };
      document.addEventListener('visibilitychange', away); window.addEventListener('pagehide', () => autosave('hidden'));
      refresh();
    }
  });
})();
