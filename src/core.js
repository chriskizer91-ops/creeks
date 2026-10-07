/* Core helpers shared by the game and by feature modules. Loaded right after config.js.
   Gives: an event mixin (on / off / once / emit), saved settings, keyboard shortcuts, and the module registry.
   Nothing in here knows about the map, the water or the screen furniture.
   The full description of everything is in docs/EXTENSION_API.md. */
(function () {
  window.Creek = window.Creek || {};
  const Creek = window.Creek;

  // ---------------------------------------------------------------- events
  // Mixed into the game (game.on / game.off / game.emit). A listener that throws is reported and skipped:
  // one broken module must never stop the others or the game.
  const EV = {
    /** Listen for an event. Returns a function that stops listening. */
    on: function (name, fn) {
      if (typeof fn !== 'function') return function () {};
      const h = this._ev || (this._ev = {});
      (h[name] || (h[name] = [])).push(fn);
      return () => this.off(name, fn);
    },
    /** Like on, but only the first time. */
    once: function (name, fn) {
      const wrap = (...a) => { this.off(name, wrap); fn.apply(this, a); };
      return this.on(name, wrap);
    },
    off: function (name, fn) {
      const l = this._ev && this._ev[name]; if (!l) return;
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    emit: function (name, ...args) {
      const l = this._ev && this._ev[name]; if (!l || !l.length) return;
      for (const fn of l.slice()) {
        try { fn.apply(this, args); } catch (e) { console.error('[creek] a "' + name + '" listener threw:', e); }
      }
    }
  };
  Creek.mixinEvents = function (target) { Object.keys(EV).forEach((k) => { target[k] = EV[k]; }); return target; };

  // ---------------------------------------------------------------- settings (remembered between visits)
  // Creek.settings.get(key, default) / set(key, value) / on(key, fn). Stored in localStorage under "creek.settings";
  // if the browser refuses (private window, blocked storage) the values still work until the page closes.
  Creek.settings = (function () {
    const KEY = 'creek.settings', cache = {}, subs = {};
    let loaded = false;
    const has = (k) => Object.prototype.hasOwnProperty.call(cache, k);
    function load() {
      if (loaded) return; loaded = true;
      try {
        const raw = localStorage.getItem(KEY), o = raw ? JSON.parse(raw) : null;
        if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (!has(k)) cache[k] = o[k]; });
      } catch (e) { /* storage not available: keep going in memory */ }
    }
    function persist() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ } }
    function fire(key, value) {
      [].concat(subs[key] || [], subs['*'] || []).forEach((fn) => {
        try { fn(value, key); } catch (e) { console.error('[creek] a settings listener threw:', e); }
      });
    }
    return {
      get: function (key, def) { load(); return has(key) ? cache[key] : def; },
      /** value === undefined removes the key. Listeners run only when the value really changed. */
      set: function (key, value) {
        load();
        const old = has(key) ? cache[key] : undefined;
        if (value === undefined) delete cache[key]; else cache[key] = value;
        if (old === value) return;
        persist(); fire(key, value);
      },
      has: function (key) { load(); return has(key); },
      all: function () { load(); return Object.assign({}, cache); },
      /** fn(value, key). Use key "*" to hear every setting. Returns a function that stops listening. */
      on: function (key, fn) {
        (subs[key] || (subs[key] = [])).push(fn);
        return () => { const l = subs[key], i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); };
      }
    };
  })();

  // ---------------------------------------------------------------- keyboard shortcuts
  // Creek.shortcuts.add({key, desc, fn, hidden, repeat}) -> remove function.
  // key: a single character ("z", "?", "1"), a key name ("ArrowLeft", "Escape", "Space"), optionally with
  // "shift+", "ctrl+" or "alt+" in front. Letters ignore case; shift is ignored for plain keys (so "?" works).
  // The newest shortcut for a key wins; if its fn returns false the next older one gets a turn.
  // Keystrokes are ignored while typing in a text box and while a modal card is open.
  Creek.shortcuts = (function () {
    const items = [];
    function parse(spec) {
      let s = String(spec); const m = { ctrl: false, shift: false, alt: false };
      for (;;) {
        const r = /^(ctrl|cmd|meta|shift|alt)\+(.+)$/i.exec(s); if (!r) break;
        const k = r[1].toLowerCase(); m[k === 'cmd' || k === 'meta' ? 'ctrl' : k] = true; s = r[2];
      }
      return { key: s.toLowerCase(), mods: m };
    }
    function matches(sc, e) {
      const k = (e.key || '').toLowerCase();
      if (k !== sc.key && !(sc.key === 'space' && e.key === ' ')) return false;
      if (sc.mods.ctrl !== !!(e.ctrlKey || e.metaKey) || sc.mods.alt !== !!e.altKey) return false;
      if (sc.mods.shift && !e.shiftKey) return false;
      return true;
    }
    function typing(e) {
      const t = e.target; if (!t || !t.tagName) return false;
      return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.isContentEditable;
    }
    const api = {
      /** Replace to change what counts as "a card is in the way". Default: the #modal card is showing. */
      isBlocked: function () { const m = document.getElementById('modal'); return !!(m && !m.classList.contains('hidden')); },
      add: function (o) {
        if (!o || !o.key || typeof o.fn !== 'function') { console.warn('[creek] shortcuts.add needs {key, fn}'); return function () {}; }
        const sc = Object.assign({ desc: '', hidden: false, repeat: false }, o, parse(o.key));
        sc.spec = String(o.key); items.push(sc);
        return () => { const i = items.indexOf(sc); if (i >= 0) items.splice(i, 1); };
      },
      /** What to show in the help card: [{key, label, desc}] in the order they were added (hidden ones left out). */
      list: function () {
        return items.filter((s) => !s.hidden).map((s) => ({
          key: s.spec, desc: s.desc,
          label: s.spec.split('+').map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join('+')
        }));
      }
    };
    function onKey(e) {
      if (e.defaultPrevented || e.isComposing || typing(e)) return;
      try { if (api.isBlocked()) return; } catch (err) { /* ignore */ }
      for (let i = items.length - 1; i >= 0; i--) {
        const sc = items[i]; if (!matches(sc, e)) continue;
        if (e.repeat && !sc.repeat) return;
        let r; try { r = sc.fn(e); } catch (err) { console.error('[creek] shortcut "' + sc.spec + '" threw:', err); return; }
        if (r !== false) { e.preventDefault(); return; }
      }
    }
    document.addEventListener('keydown', onKey);
    api._dispatch = onKey;   // for tests
    return api;
  })();

  // ---------------------------------------------------------------- modules
  // A module is one script, src/mod-<id>.js, that calls Creek.registerModule({id, init(game, ui), ready(game, ui)}).
  // main.js loads the scripts, then calls init for every enabled module (after ui.init, before game.boot);
  // ready runs when the world is loaded and again after every level reload.
  // A module that throws is reported on the console and skipped for that hook; the game carries on.
  Creek.modules = {};          // id -> definition, for every module whose script has run
  Creek.moduleOrder = [];      // ids in the order they registered
  Creek.enabledModules = [];   // ids main.js decided to run, in order
  Creek.moduleErrors = [];     // [{id, hook, error}] for anything that threw
  Creek.phase = 'loading';     // 'loading' -> 'running' (set by main.js after init)

  Creek.registerModule = function (def) {
    if (!def || typeof def.id !== 'string' || !/^[\w-]+$/.test(def.id)) { console.error('[creek] registerModule needs an id made of letters, digits, - or _'); return null; }
    if (Creek.modules[def.id]) { console.warn('[creek] module "' + def.id + '" is already registered; ignoring the second copy'); return Creek.modules[def.id]; }
    Creek.modules[def.id] = def; Creek.moduleOrder.push(def.id);
    if (Creek.phase === 'running') {            // registered late (for example from the console): start it right away
      Creek.enabledModules.push(def.id);
      Creek.runModuleHook(def, 'init');
      if (Creek.game && Creek.game.ready) Creek.runModuleHook(def, 'ready');
    }
    return def;
  };
  Creek.runModuleHook = function (def, hook) {
    if (!def || typeof def[hook] !== 'function') return;
    try { def[hook](Creek.game, Creek.ui); }
    catch (e) { Creek.moduleErrors.push({ id: def.id, hook, error: e }); console.error('[creek] module "' + def.id + '" ' + hook + ' failed:', e); }
  };
  Creek.runModuleHooks = function (hook) {
    Creek.enabledModules.forEach((id) => Creek.runModuleHook(Creek.modules[id], hook));
  };
})();
