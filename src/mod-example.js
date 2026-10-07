/* Example module: a small reference for how to build a feature on the extension API.
   NOT switched on by default. Try it with  index.html?mods=example  (or  ?addmods=example  to add it to the others).
   To make your own: copy this file to src/mod-<yourid>.js, change the id, delete what you do not need, and list the id
   in Creek.CONFIG.modules (src/config.js) when it should always load. Everything used here is described in
   docs/EXTENSION_API.md.

   The rules a module follows:
   - It is one plain script that calls Creek.registerModule({id, init, ready}). No imports, no bundler.
   - init(game, ui) runs once, after the screen furniture exists and before the world is loaded. Build buttons,
     panels, tools, lenses, settings and event listeners here.
   - ready(game, ui) runs when the world is loaded, and again after every detail-level change. The land, the GPU
     textures (game.sim, game.gl) and the fields are NEW then, so rebuild anything that depended on the old ones.
   - Only READ the engine's data (game.sim.sampleLine, game.sim.probe, game.sim.readTerrain...). Land changes go through
     the tools; if a custom tool really edits the land, call game.snapshotForUndo() first and game.terrainChanged() after.
   - Words on screen are short and kid-friendly. Guard event handlers that could throw; the game also catches them. */
(function () {
  // What the test reads to prove each hook ran.
  const mod = Creek.example = { counts: {}, readyCount: 0, taps: 0, profile: null, chatty: false };

  Creek.registerModule({
    id: 'example',

    init: function (game, ui) {
      // ---- 1. Styles: ui.styles(css) puts a <style> in the page. Use the game's colours: --paper, --ink, --moss, --clay, --gold.
      ui.styles('.ex-line{margin:2px 0}.ex-line b{color:var(--moss)}.ex-small{color:var(--ink2);font-size:12px}');

      // ---- 2. A floating panel: ui.panel({id, title, corner, closable}) -> {el, body, show, hide, toggle}.
      //         Corners: tl, tr, bl, br, center. It starts hidden. onHide also runs when the player taps its X.
      let btn = null;
      const panel = mod.panel = ui.panel({
        id: 'example', title: '🧪 Example module', corner: 'tr', closable: true,
        onShow: function () { if (btn) btn.classList.add('on'); }, onHide: function () { if (btn) btn.classList.remove('on'); }
      });
      const lines = {};
      ['ready', 'tool', 'storm', 'probe', 'profile', 'last'].forEach(function (k) {
        const d = document.createElement('div'); d.className = 'ex-line'; panel.body.appendChild(d); lines[k] = d;
      });
      const say = function (k, html) { lines[k].innerHTML = html; };   // only ever put numbers and our own words in here
      mod.say = say;
      say('tool', 'Pick the <b>Profile</b> tool and drag a line across the land.');
      const bump = function (name) { mod.counts[name] = (mod.counts[name] || 0) + 1; };

      // ---- 3. A button in the "view" chip row (under the menu button). toggle:true flips the "on" look and hands you the new state.
      //         slot "top" would put it at the top right, next to the cash chip.
      btn = ui.addButton({
        slot: 'view', id: 'exampleBtn', label: '🧪 Example', title: 'Show or hide the example panel', toggle: true,
        onClick: function (on) { if (on) panel.show(); else panel.hide(); bump('button'); }
      });
      ui.addButton({
        slot: 'top', id: 'examplePause', label: '⏸', title: 'Pause or resume the storm', toggle: true,
        onClick: function (on) { game.paused = on; bump('pauseButton'); }        // game.paused stops the storm but the map keeps drawing
      });

      // ---- 4. A lens (a "view"): joins the view button's cycle after the built-in ones.
      //         Module lenses keep the map renderer on its normal map, so a real one draws through game.extras
      //         (for example game.extras.flow, game.extras.trace). This one only reports that it is on.
      game.addLens({
        id: 'example', label: '🧪 Example view', toast: 'Example view: a module added this one to the view button.',
        activate: function () { say('last', 'Example view is <b>on</b>.'); bump('lensOn'); },
        deactivate: function () { say('last', 'Example view is off.'); bump('lensOff'); }
      });

      // ---- 5. A custom tool: ui.addTool({... kind: 'custom', custom: {down, move, up, cancel}}).
      //         world = {x, y} in metres, or null when the finger is off the map. p = {x, y} in screen pixels.
      //         It gets ONE finger; a second finger calls cancel. readonly:true because it never changes the land,
      //         so the story does not lock it. A tool that edits the land must call game.snapshotForUndo() first.
      ui.HOWTO.exprofile = { title: 'Profile', text: 'Drag a line across the land. The game reads the height along it, like slicing the ground and looking at the cut edge.' };
      let start = null;
      ui.addTool({
        id: 'exprofile', icon: '📏', label: 'Profile', kind: 'custom', readonly: true, card: 'exprofile',
        help: 'Drag a line across the land to see how high and low it is.',
        custom: {
          down: function (g, world) { start = world; },
          move: function (g, world) { if (start && world) say('profile', 'Measuring… ' + Math.round(Math.hypot(world.x - start.x, world.y - start.y)) + ' m'); },
          up: function (g, world, p, info) {
            bump('toolUp');
            if (start && world && info.moved > 8) {
              // sim.sampleLine: one tiny GPU pass; up to 512 points of height, bed, cover, growth, depth, som, soil, inside.
              const prof = g.sim.sampleLine(start.x, start.y, world.x, world.y, 64);
              let lo = 1e9, hi = -1e9; for (let i = 0; i < prof.h.length; i++) { lo = Math.min(lo, prof.h[i]); hi = Math.max(hi, prof.h[i]); }
              mod.profile = { lo: lo, hi: hi, n: prof.h.length, length: prof.dist[prof.dist.length - 1] };
              say('profile', 'Along that line the ground drops <b>' + (hi - lo).toFixed(1) + ' m</b> from top to bottom.');
            } else if (world) { mod.taps++; say('profile', 'Taps so far: <b>' + mod.taps + '</b> (this count is saved with the ranch).'); }
            start = null;
          },
          cancel: function () { start = null; bump('toolCancel'); }
        }
      });

      // ---- 6. A keyboard shortcut. Creek.shortcuts.add({key, desc, fn}); the list shows up on the "?" card.
      Creek.shortcuts.add({ key: 'e', desc: 'Show or hide the example panel (example module)', fn: function () { panel.toggle(); } });

      // ---- 7. A setting (the menu has a Settings card). Without get/set it is stored in Creek.settings under the id.
      mod.chatty = !!Creek.settings.get('example.chatty', false);
      ui.addSetting({ id: 'example.chatty', label: 'Example module is chatty', help: 'Shows a note after every dig or plant.', type: 'toggle', default: false });
      Creek.settings.on('example.chatty', function (v) { mod.chatty = !!v; });

      // ---- 8. A menu item (a button in the menu card).
      ui.addMenuItem({ label: 'Say hello (example module)', onClick: function () { ui.toast('Hello from the example module!'); } });

      // ---- 9. Save state: whatever you register is collected with game.collectState() for the save system.
      game.registerState('example', { save: function () { return { taps: mod.taps }; }, load: function (j) { mod.taps = (j && j.taps) | 0; } });

      // ---- 10. Events. game.on(name, fn) returns a function that stops listening. All of them are listed in the docs.
      game.on('ready', function () { bump('ready'); });
      game.on('frame', function () { bump('frame'); });                       // every frame, before drawing: keep it tiny
      game.on('stormStart', function (storm) { bump('stormStart'); say('last', 'A ' + Creek.CONFIG.storms[storm.size].label + ' storm is starting.'); });
      game.on('stormStep', function (s) {                                       // s = {t, dt, rain, Qin, Qout, mudQ, size}
        bump('stormStep');
        if (mod.counts.stormStep % 10 === 1) say('storm', 'Water leaving the ranch: <b>' + s.Qout.toFixed(1) + ' m³/s</b> (storm time ' + Math.round(s.t) + ' s)');
      });
      game.on('stormEnd', function (res) {                                      // res = game.lastStorm; res.series is the graph record
        bump('stormEnd');
        say('last', 'Storm over: peak ' + Math.round(res.peakOut) + ' m³/s, ' + res.series.t.length + ' points recorded.');
      });
      game.on('season', function (e) { bump('season'); say('last', 'Now ' + e.season + ', year ' + e.year + '.'); });
      game.on('strokeStart', function () { bump('strokeStart'); });
      game.on('strokeEnd', function (e) {                                       // e = {tool, opt, path:[{x,y}], cost, cancelled}
        bump('strokeEnd'); mod.lastStroke = e;
        if (mod.chatty && !e.cancelled && e.tool !== 'look') ui.toast(e.tool + ': ' + e.path.length + ' points, $' + Math.round(e.cost));
      });
      game.on('toolChanged', function (id) { bump('toolChanged'); say('tool', 'Tool: <b>' + id + '</b>'); });
      game.on('probe', function (info) { bump('probe'); say('probe', 'Looking at (' + Math.round(info.x) + ', ' + Math.round(info.y) + ') m: ground ' + info.h.toFixed(1) + ' m high.'); });
      game.on('terrain', function () { bump('terrain'); });                     // the land changed and settled; game.terrainVersion went up
      game.on('fieldUse', function (field, useId) { bump('fieldUse'); say('last', field.name + ' is now ' + useId + '.'); });
      game.on('reset', function () { bump('reset'); });
      game.on('cash', function () { bump('cash'); });
      game.on('lens', function () { bump('lens'); });
    },

    ready: function (game, ui) {
      mod.readyCount++;
      // Anything built from the world (textures, field lists, cached data) is rebuilt here. This one just says hello.
      mod.say('ready', 'World ready: ' + game.sim.nx + ' × ' + game.sim.ny + ' cells of ' + game.sim.dx + ' m. (loaded ' + mod.readyCount + 'x)');
    }
  });
})();
