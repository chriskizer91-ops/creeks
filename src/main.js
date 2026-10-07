/* Start-up: load the feature modules, make the game, survey the ranch, show the title picture, wait for a choice.
   Address options:  ?free=1 skips the title card · ?level=0..3 forces a detail level · ?quick=1 makes storms short (testing)
                     ?mods=a,b loads only those modules (?mods= loads none) · ?addmods=c loads those as well  */
(function () {
  const q = new URLSearchParams(location.search);
  if (q.has('quick') && q.get('quick') !== '0') { Creek.CONFIG.stormBurst = 150; Creek.CONFIG.stormTail = 90; }

  /** The module ids to run: CONFIG.modules, unless ?mods= replaces them; ?addmods= adds more. Only plain ids (no paths). */
  function moduleIds() {
    const clean = (list) => list.map((s) => String(s).trim()).filter((s) => {
      if (/^[\w-]+$/.test(s)) return true;
      if (s) console.warn('[creek] ignoring the module id "' + s + '" (ids are letters, digits, - and _)');
      return false;
    });
    let ids = clean((Creek.CONFIG.modules || []).slice());
    if (q.has('mods')) ids = clean(q.get('mods').split(','));
    if (q.has('addmods')) ids = ids.concat(clean(q.get('addmods').split(',')));
    return ids.filter((id, i) => ids.indexOf(id) === i);
  }

  /** Load src/mod-<id>.js for each id, in order (scripts run in the order listed). A module already registered (the single-file
      bundle has them built in) is not loaded again; a file that is missing is reported and skipped. */
  function loadScripts(ids) {
    return Promise.all(ids.map((id) => new Promise((resolve) => {
      if (Creek.modules[id]) return resolve();
      const s = document.createElement('script');
      s.src = 'src/mod-' + id + '.js'; s.async = false;        // async=false keeps the scripts running in list order
      s.onload = () => { if (!Creek.modules[id]) console.warn('[creek] src/mod-' + id + '.js loaded but did not register a module called "' + id + '"'); resolve(); };
      s.onerror = () => { console.warn('[creek] module "' + id + '" could not be loaded (src/mod-' + id + '.js is missing?). Skipping it.'); resolve(); };
      document.head.appendChild(s);
    })));
  }

  async function main() {
    const ids = moduleIds();
    await loadScripts(ids);
    const ui = Creek.ui, game = Creek.game = new Creek.Game(document.getElementById('gl'));
    window.game = game;   // handy for poking around in the browser console (and for tests)
    ui.init(game);
    Creek.enabledModules = ids.filter((id) => Creek.modules[id]);
    Creek.runModuleHooks('init');                              // after ui.init, before the world exists
    Creek.phase = 'running';
    game.on('ready', () => Creek.runModuleHooks('ready'));     // the world is loaded: first start, and after every detail-level change
    try {
      await game.boot(q.has('level') ? +q.get('level') : null);
    } catch (e) {
      ui.splash(null);
      await ui.card({ title: 'This device can’t run the game yet', text: String(e.message || e) + ' It needs a browser with WebGL2 (recent Chrome, Safari 15+ or Firefox) and a decent graphics chip.', buttons: [{ label: 'OK' }] });
      return;
    }
    if (q.has('free')) { Creek.story.free(); return; }
    const v = await ui.card({
      cls: 'title', img: ui.PICS.title, title: Creek.CONFIG.title, text: 'You have inherited a 500-acre ranch and the creek that runs through it. Dig, plant and farm differently, then watch what the storm does.',
      buttons: [{ label: 'Story: the first years', value: 'story' }, { label: 'Free play', value: 'free', alt: true }, { label: 'Picture book', value: 'book', alt: true }]
    });
    if (v === 'story') Creek.story.start(); else if (v === 'book') { Creek.story.free(); ui.book(); } else Creek.story.free();
  }
  main();
})();
