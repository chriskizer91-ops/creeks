# Creek Care extension API (v1)

This is the authoritative description of what feature modules can rely on. It describes the code as it is, including the places where it
differs a little from the first plan (those are listed in [Notes and gotchas](#notes-and-gotchas)).

- [Modules](#modules): how a feature is added, and in which order things run
- [Game state](#game-state)
- [Events](#events): every event, with its exact payload
- [Settings and shortcuts](#settings-and-shortcuts)
- [UI helpers](#ui-helpers)
- [Custom tools](#custom-tools)
- [Lenses (views)](#lenses-views)
- [Render extras and weather](#render-extras-and-weather)
- [The view provider (3D view)](#the-view-provider-3d-view)
- [Simulation helpers](#simulation-helpers)
- [Cross-module ids](#cross-module-ids)
- [Pause, fast-forward, frame gate](#pause-fast-forward-frame-gate)
- [Testing](#testing)
- [Bundling](#bundling)

Rules that never change: plain browser scripts (no bundler, no modules, no frameworks), WebGL2 only, no network, works on a phone
(touch) and a laptop (mouse), works from `file://`. Drawing code only **reads** the land and water data (`game.sim`); the data is
changed only by the engine and by tools. Words on screen are short and kid-friendly.

---

## Modules

A module is **one script**, `src/mod-<id>.js`, that registers itself:

```js
Creek.registerModule({
  id: 'hydro',                        // letters, digits, - and _ only
  init(game, ui)  { /* build buttons, tools, lenses, panels, listeners */ },
  ready(game, ui) { /* the world is loaded: (re)build anything that depends on it */ },
});
```

`src/mod-example.js` is a working reference that uses every hook (`index.html?mods=example`).

**Loading** (`src/main.js`):

1. The ids come from `Creek.CONFIG.modules` (default `[]`, in `src/config.js`).
   `?mods=a,b` in the address **replaces** the list (`?mods=` means none); `?addmods=c` **appends**. Duplicates are dropped. Only plain ids
   (`[A-Za-z0-9_-]`) are accepted, so an address cannot load an arbitrary path.
2. Each id is loaded as `<script src="src/mod-ID.js">`. Scripts run in list order. A missing file logs
   `console.warn('[creek] module "x" could not be loaded ...')` (the browser also prints its own 404 line) and is skipped. A script that loads but
   does not register the id logs a warning too. A module that is already registered (the single-file bundle has them built in) is not loaded again.
3. The game and UI are created and `ui.init(game)` runs.
4. `init(game, ui)` runs for every enabled module, in list order. The world does **not** exist yet (`game.sim`, `game.gl`, `game.world` are not set).
5. `game.boot()` loads the world. When the world is loaded the game event `"ready"` fires and each module's `ready(game, ui)` runs.
   This happens **again after every detail-level change** (the menu's "Change detail level"): `game.sim`, `game.gl` textures, `game.world` and
   `game.fields` are then brand-new objects. Rebuild anything cached from the old ones in `ready`, and delete GPU objects you created.

A module that throws in `init` or `ready` is caught: the error goes to `console.error('[creek] module "id" init failed:', e)` and is pushed to
`Creek.moduleErrors` (`[{id, hook, error}]`); the game carries on and the other modules still run. Listeners, tool callbacks, menu/button callbacks,
lens hooks, settings callbacks and the view provider are guarded the same way.

Useful globals: `Creek.modules` (id to definition, everything registered), `Creek.enabledModules` (ids running), `Creek.moduleErrors`,
`Creek.game`, `Creek.ui`, `window.game`.
A module registered late (after start-up, for example from the console) gets `init` immediately and `ready` if the world is already loaded.

Build UI in `init`, not in `ready`: `ready` runs again and again. The `add...` helpers ignore a second call with the same id (the first wins), so
a repeated call is harmless, but listeners added with `game.on` would pile up.

---

## Game state

| name | meaning |
|---|---|
| `game.terrainVersion` | integer that goes up on **every** change to the land or cover, including mid-stroke and mid-storm (see [terrain](#terrain)) |
| `game.stormHistory` | the last 12 storm results (`game.lastStorm` objects), newest last. Cleared by "reset" and by a level load |
| `game.lastStorm` | the newest storm result, or `null` |
| `game.baseline` | the story's starting ("before") storm result, or `null`. Cleared by a reset, so it exists only while the story is being played |
| `game.paused` | `true` stops storm stepping; drawing and input continue |
| `game.fast` | `true` is fast-forward (see [Pause, fast-forward, frame gate](#pause-fast-forward-frame-gate)) |
| `game.frameGate` | optional `fn(game, dt)`; returning `false` skips drawing this frame |
| `game.settings` | the same object as `Creek.settings` |
| `game.weather` | `{rain, flash}` for visuals (same object as `game.extras.weather`) |
| `game.extras` | `{flow, trace, section, weather}` handed to the renderer every frame |
| `game.lenses`, `game.lens`, `game.lensIdx`, `game.lensId` | see [Lenses](#lenses-views) |
| `game.viewProvider` | the registered view provider or `null` |
| `game.ready` | `true` once a world is loaded (false while a level is loading) |
| `game.storm` | the running storm object or `null` |
| `game.tool`, `game.optIdx`, `game.sizeIdx`, `game.cur()` | the current tool; `cur()` merges the chosen option into the tool definition |
| `game.fields` | the fields (`{id, name, kind, use, area, cx, cy}`), `game.cash`, `game.season`, `game.year`, `game.cam` as before |
| `game.stroke` | the stroke in progress (or `null`) |

`game.registerState(id, {save(){return json}, load(json){}})` registers module state for the save system; returns `true`.
`game.collectState()` returns `{id: json}` for everything registered (a handler that throws is skipped); `game.applyState({id: json})` hands saved
json back to the handlers. The save module (`Creek.save`) is expected to call these.

Helpers on `game`: `game.inMap(w)` (true if `{x,y}` is on the ranch), `game.toWorld(px, py)`, `game.project(x, y)`, `game.focusOn(x, y, scale)`,
`game.snapshotForUndo()`, `game.terrainChanged()`, `game.bumpTerrain()`, `game.cashChanged()`, `game.setTool(id, opt?)`, `game.setLens(idOrIndex)`,
`game.nextLens()`, `game.addLens(def)`, `game.setViewProvider(p)`, `game.provider()`, `game.worldOrNull(p)`.

### Terrain

`game.terrainVersion` is bumped every time the land might have changed:

- every frame of a paint stroke (dig, pile, swale, check dam, plant) and every step of a storm (quietly: no event);
- when a change **settles**, the game bumps it again **and emits `"terrain"`**: end of a stroke, a stamp (pond, trees), a field change, undo,
  a season step, end of a storm, `sim.restore`, a reset. A custom tool that edits the land calls `game.terrainChanged()` when it is done.

Cache derived data against `terrainVersion`, recompute on `"terrain"`, and treat the land as "still changing" while `game.stroke` or `game.storm` is non-null.
A level load bumps the version without an event (`"ready"` follows).

---

## Events

`game.on(name, fn)` returns a function that removes the listener. Also `game.once(name, fn)`, `game.off(name, fn)`, `game.emit(name, ...args)`.
A listener that throws is logged (`[creek] a "name" listener threw`) and skipped; the others still run. The existing `game.cbs` callbacks
(used by the UI) are untouched and keep working.

| event | payload | when |
|---|---|---|
| `"ready"` | none | the world is loaded, first start and after each level change |
| `"frame"` | `dt` (seconds, at most 0.1) | once per animation frame while a world is loaded, before drawing; fires even if drawing is skipped |
| `"stormStart"` | `storm` (the `game.storm` object: `{size, t, Q, tag, turbo, before, peakOut, volOut, mudVol, rainVol, ...}`) | a storm begins |
| `"stormStep"` | `sample = {t, dt, rain, Qin, Qout, mudQ, size}` | after each batch of water steps in a storm (once per frame, not while paused) |
| `"stormEnd"` | `res` (`game.lastStorm`) | the storm is over, before the report card shows |
| `"season"` | `{season, year, net, passing}` | after `advanceSeason`; `season` is the **new** season, `passing` the one that just ended, `net` the money earned or lost |
| `"strokeStart"` | `{tool, opt}` | a finger or mouse goes down with a tool (including Look and custom tools) |
| `"strokeEnd"` | `{tool, opt, path, cost, cancelled}` | the stroke ends |
| `"toolChanged"` | `id` | `game.setTool` succeeded (also when only the option changed) |
| `"probe"` | `info` | the Look tool read a spot |
| `"terrain"` | none | the land or cover changed and settled (see above) |
| `"fieldUse"` | `field, useId` | a field's land use changed (tool or undo) |
| `"reset"` | none | "Start the ranch over", or free play / story starting (`game.resetMap`); a `"terrain"` event follows |
| `"cash"` | `amount` | money changed (a new balance, in dollars) |
| `"lens"` | `id` | the view changed |

### Payload details

- **`stormStep` sample**: `t` storm time in simulated seconds after this step; `dt` simulated seconds this step covered; `rain` rain intensity on
  the map in m/s; `Qin` water arriving from upstream in m3/s (creek base flow included); `Qout` flow leaving the ranch at the bottom edge in m3/s;
  `mudQ` soil carried out in m3/s; `size` the storm size (1, 10 or 100). A storm lasts `Creek.CONFIG.stormBurst + stormTail` simulated seconds
  (1800 + 1200, or 150 + 90 with `?quick=1`).
- **`stormEnd` result** (`game.lastStorm`): `size, tag, peakOut (m3/s), volOut (m3), rainVol (m3), mudVol, mudConc, soilLost (m3), infilVol (m3),
  soakShare (0..1), floodHa, fields[{id, lostPerHa, infilMm, floodHa}], an (bank analysis: {main, gullies, bankMean, gullyMean}), somMean,
  groundwater` and **`series = {t, rain, Qin, Qout, mudQ}`**: five arrays of equal length, **at most 400 points** (thinned evenly, first and last point
  kept). `t[0]` is 0; times rise; units as in the sample. `mudQ` is an addition to the planned four arrays.
- **`strokeStart` / `strokeEnd`**: `tool` is the tool id (`"dig"`, `"plant"`, a custom id...); `opt` is the chosen option id for tools with a menu
  (`"grass"`, `"tree"`, `"notill"`...) or `null`. `path` is an array of `{x, y}` in **metres**, one point about every 2 m of distance, **at most
  400** (when it would pass 400 every other point is dropped and the spacing doubles). The first point is where the stroke started and the last is
  where it ended. `cost` is the money charged for the stroke in dollars (0 for Look and for custom tools unless they call `game.charge`).
  `cancelled` is true when a second finger came down, the browser cancelled the pointer, or the tool was switched mid-stroke. `"terrain"` fires
  (for paint tools) **before** `"strokeEnd"`, so `terrainVersion` is already new. A stroke that is refused (locked tool, not zoomed in) sends nothing.
- **`probe` info**: everything `sim.probe` returns, plus the place: `{x, y (world metres), px, py (CSS pixels), h, bed, cover, growth, depth, mud,
  speed, moist, soil, som, field}`. `h` is ground height (m), `bed` the limestone height, `cover` the cover id (see `Creek.CONFIG.COVER`),
  `growth` 0..1, `depth` water depth (m), `som` organic matter 0..1, `soil` 0 clay or 1 loam, `field` the field number (0 = none).
- **`fieldUse`**: `field` is the object in `game.fields` (it already has the new `use`); `useId` is a key of `Creek.CONFIG.uses`.
  Undo sends one event per field it changed.

---

## Settings and shortcuts

### `Creek.settings`

Stored in `localStorage` under `"creek.settings"` (every access is in try/catch; without storage values live in memory until the page closes).

```js
Creek.settings.get(key, default)   // current value, or default
Creek.settings.set(key, value)     // value undefined removes the key; listeners run only if the value changed
Creek.settings.on(key, fn)         // fn(value, key); key "*" hears every setting; returns an off function
Creek.settings.has(key); Creek.settings.all();
```

Name your keys `modid.thing` (for example `audio.volume`).

### `Creek.shortcuts`

```js
const remove = Creek.shortcuts.add({ key: 'g', desc: 'Show the graph', fn(e) { ... }, hidden: false, repeat: false });
Creek.shortcuts.list();   // [{key, label, desc}] of the non-hidden ones, in the order added (the "?" card shows this)
```

- `key`: one character (`"z"`, `"?"`, `"1"`), a key name (`"ArrowLeft"`, `"Escape"`, `"Space"`), optionally prefixed with `shift+`, `ctrl+` or `alt+`.
  Letters ignore case. For plain keys Shift is ignored (so `"?"` works) and Ctrl/Alt/Cmd must not be held.
- The **newest** shortcut for a key wins, so a module can override a built-in; if its `fn` returns `false` the next older one is tried.
  Otherwise the key press is consumed (`preventDefault`).
- One global `keydown` listener dispatches. It ignores key presses while typing in an `input`, `textarea`, `select` or editable element, while the modal
  card is open (`Creek.shortcuts.isBlocked()`), and auto-repeats unless `repeat: true`.
- Built in: **1 to 9** pick the 1st to 9th tool in the tray (`Creek.TOOLS` order, so module tools count), **Z** undo, **L** contour lines, **V** next view,
  **?** the shortcut list.

---

## UI helpers

All on `Creek.ui` (`ui` below). Safe to call again with the same `id`/label (the first one wins).

```js
ui.styles(css)                 // injects a <style>; returns the element. Use the game's palette:
                               // --paper #f4ecd8, --ink #3b2a1a, --ink2, --moss #5d7f3b, --clay #b5654a, --gold #e9a23b, water #4a8aa3
ui.addButton({ slot, id, label, title, onClick, toggle, on })   // returns the <button class="chip">
ui.addMenuItem({ label, onClick, alt })
ui.addSetting({ id, label, help, type, options, min, max, step, default, get, set })
ui.panel({ id, title, corner, closable, onShow, onHide })        // returns {el, body, show(), hide(), toggle(), setTitle(t), visible}
ui.addTool(def)                // appends to Creek.TOOLS and rebuilds the tray; returns the tool
ui.toast(text); ui.card({title, text, html, img, buttons, onShow}) // existing: show a message / a modal card (returns a promise of the pressed value)
ui.esc(text)                   // escapes text for use inside html strings
ui.HOWTO[key] = {title, text, img, square}   // a first-use card for a tool that has card: key
```

- **`addButton`**: `slot: "view"` is the chip row under the menu button, next to "Lines" and the view button; it is only as wide as its chips and **scrolls
  sideways** when crowded (it stops left of the storm buttons, also at 360 px). `slot: "top"` is the row at the top right, beside the cash chip (keep these to a
  single emoji: the top bar is tight on a phone). `label` is plain text (an emoji plus a word is fine). `toggle: true` flips the `on` look on click;
  `onClick(on, el, event)` gets the new state (`undefined` for a plain button). `el.classList.toggle('on', v)` changes the look later. The element gets
  `id` unless that id is already used in the page. 40 px touch targets are kept by the stylesheet.
- **`addMenuItem`**: a button in the menu card, between "Settings" and "Start the ranch over". `onClick(game, ui)` runs after the card closes.
  `alt` (default `true`) is the quieter clay-coloured button; `alt: false` is green.
- **`addSetting`**: a row in the Settings card (menu, "Settings"; built in). `type: "toggle"` (boolean), `"slider"` (`min`, `max`, `step`, number) or
  `"choice"` (`options`: `["a","b"]` or `[{value, label}]`). `help` is a small line under the label. Without `get`/`set` the value lives in
  `Creek.settings` under `id` (read it with `Creek.settings.get(id, default)` and listen with `Creek.settings.on(id, fn)`). With `get()`/`set(v)` you handle it yourself.
  A built-in row "Contour lines on the map" is always there.
- **`panel`**: a floating box inside `#app`, hidden at first. Put content in `body`. `corner`: `"tl"`, `"tr"` (default; below the storm buttons), `"bl"`, `"br"`
  (above the tool tray) or `"center"`. Width is at most 320 px (and always fits the screen); it scrolls if tall. `closable` (default true) adds a 40 px close
  button; `onHide` also runs when the player closes it that way. Panels sit above the map and labels and below the modal cards.
- **`addTool`**: see [Custom tools](#custom-tools). Tool buttons scroll sideways in the tray.

The UI also exposes (existing, handy): `ui.mode` (`"free"` or `"story"`), `ui.pickTool(id)`, `ui.updateTools()`, `ui.labelEls`, `ui.closeCard()`.

---

## Custom tools

```js
ui.addTool({
  id: 'trace', icon: '💧', label: 'Trace', kind: 'custom',
  help: 'Tap the land to see where its water goes.',   // shown as a toast when picked
  card: 'trace',               // optional: key in ui.HOWTO for a first-use card
  readonly: true,              // never changes the land: stays available in the story (see below)
  custom: {
    down(game, world, p)            {},   // finger / mouse button down
    move(game, world, p)            {},   // while it is down
    up(game, world, p, { moved })   {},   // released (moved = largest distance from the start, in CSS px)
    cancel(game)                    {},   // a second finger arrived, or the browser cancelled, or the tool was switched
  },
});
```

- `world` is `{x, y}` in **metres**, or `null` if the pointer is off the map (flat map) or not over the land (3D view). `p` is `{x, y}` in CSS pixels
  relative to the map canvas.
- Custom tools get **one pointer**. A second finger calls `cancel(game)`; `up` is then not called. `cancel` is also called on `pointercancel`
  and when another tool is picked mid-stroke. Right and middle mouse buttons never reach tools (they drag the camera).
- `strokeStart` / `strokeEnd` fire for custom tools too (cost 0).
- The game does **not** take an undo snapshot for custom tools (that would wipe the player's last undo every time they use a read-only tool).
  **A custom tool that edits the land must call `game.snapshotForUndo()` first** (before the first change) and `game.terrainChanged()` after the last
  one. Charge money with `game.charge(amount, text)`.
- **Story**: the story locks tools it has not opened (`game.allowed`). A custom tool is unlocked only if it has `readonly: true`. Tools that edit the
  land are locked/unlocked like the built-in edit tools, and must be listed in `game.allowed` by whoever unlocks them.
- No brush circle is drawn for custom tools. Draw your own feedback through `game.extras` or your own panel.
- Use `game.sim.probe(x, y)` / `game.sim.sampleLine(...)` to read data.

Built-in tool kinds (for reference): `look`, `paint` (drag), `stamp` (tap), `custom`. Tools can have `opts` (a row of choices) and `sizes`.

---

## Lenses (views)

The view button (and the V key) cycles through `game.lenses`.

```js
game.lenses            // [{id, label, toast, lens, activate, deactivate}] built-ins first: "map", "soil", "moved", "flood"
game.addLens({ id, label, toast, activate(game), deactivate(game) })   // appends; returns the lens (an existing id is refused with a warning)
game.setLens(idOrIndex)   // returns false if unknown; emits "lens"(id)
game.nextLens()
game.lensIdx, game.lensId // current lens position and id;  game.lens = the number the map renderer gets
```

- The built-in lenses keep the renderer indexes `game.lens = 0..3` (map, soil health, soil moved, flood depth). **Module lenses keep `game.lens` at
  0** and do their work through `game.extras` (for example the hydro lens sets `game.extras.flow`).
- Order of events when the view changes: the old lens's `deactivate(game)`, the new `game.lens`, the new lens's `activate(game)`, then the `"lens"` event
  (the button label and highlight update from it, and the lens's `toast` is shown).
- `label` is what the button shows (emoji + one or two words). `toast` is one or two short kid-friendly sentences explaining what the colours mean.

---

## Render extras and weather

`game.extras = {flow: null, trace: null, section: null, weather: {rain, flash}}` is passed to the map renderer **and** to the view provider every frame
as `state.extras`. The renderer's owner consumes it; until then it is ignored. Textures are created by the module that owns them, using `game.gl`;
delete the old one when replacing it (and when the level reloads: `ready`).

| key | shape | meaning |
|---|---|---|
| `flow` | `{tex, nx, ny, dx}` | R32F texture, NEAREST, 0..1 = normalised log of flow accumulation; drawn as blue flow lines above about 0.3 |
| `trace` | `{tex, nx, ny, dx, x, y}` | R32F mask: 1 = water from here drains to the tapped point `(x, y)`, 0.5 = the downhill path from the tapped point, 0 = nothing |
| `section` | `{x0, y0, x1, y1}` | a line with end handles |
| `weather` | `{rain, flash}` | see below |

Coarse textures cover the whole map: cell `(i, j)` covers world `[i*dx, (i+1)*dx) x [j*dx, (j+1)*dx)`.

**Weather** (`game.weather`, the same object as `game.extras.weather`; never replaced, only its fields change): during a storm `rain` is the current rain
divided by the peak rain of this storm (0..1), smoothed in real time (about half a second); `flash` is a lightning flash 0..1 that spikes at random (about once every
2 s in the heaviest rain, rarely in light rain) and fades out in about 0.4 s of real time. **Between storms both are exactly 0.** While `game.paused`
rain is held and no new flashes start.

The state object given to the renderer / provider each frame:
`{cam: {x, y, scale}, time, contour, lens, hiH, brush: {x, y, r, on}, hints, tint, extras}`. `cam.scale` is device pixels per metre. For a provider it also has
`width`, `height` (canvas pixels) and `views` (`game.sim.views()`: textures `T, W, M, C, I`, `nx, ny, dx`).

---

## The view provider (3D view)

`game.setViewProvider(p)` registers an object that can take over the map. Pass `null` to remove it.

```js
game.setViewProvider({
  active: false,                       // you flip this; everything below only applies while it is true
  draw(game, state) {},                // draws instead of the map renderer (same state object, plus width, height, views)
  pick(px, py) { return {x, y} },      // CSS px -> world metres on the terrain, or null (not over the land)
  project(x, y) { return {x, y, visible} },   // world metres -> CSS px; null if it cannot be placed
  onWheel(e, px, py) { return true },  // mouse wheel; true = used, false = let the 2D camera zoom
  onGesture(kind, data) { return true }, // true = used
  focus(x, y, scale) {},               // game.focusOn: move the view to this spot (scale = the 2D zoom: pixels per metre)
  resize() {},                         // the canvas size changed (also called when the provider is set while active)
});
```

While `p.active` is true:

- `game.draw` calls `p.draw(game, state)` instead of `renderer.draw`. After it returns the game puts the GL switches back (depth/blend/cull/scissor off, VAO and
  framebuffer unbound, texture unit 0), so a provider may change them freely. **If `draw` throws, the provider is switched off** (`p.active = false`, an
  error is logged, a toast says so) and the flat map comes back next frame; calling `game.setViewProvider(p)` again re-arms it.
- `game.toWorld(px, py)` returns `p.pick(px, py)` (possibly `null`!) and `game.project(x, y)` returns `p.project(x, y)` with `visible` set (a `null` result passes
  through). All tools use these, so they work through the 3D view. **On the flat map `toWorld` can return a point outside the ranch** (use `game.inMap(w)`).
- The **mouse wheel** is offered as `p.onWheel(e, px, py)` first (`e` is the WheelEvent). If it returns a falsy value the 2D camera zooms.
- **Gestures** are offered through `p.onGesture(kind, data)` and fall back to the 2D camera only when it returns false:
  - `"orbit"`: right mouse button drag; `data = {dx, dy, x, y}` (CSS px moved since the last event, current position)
  - `"pan"`: middle mouse button drag; `data = {dx, dy, x, y}`
  - `"pinch"`: two fingers; `data = {factor, dist, cx, cy}` (`factor` = finger distance now / before, `cx, cy` = midpoint)
  - `"drag2"`: two fingers, offered right after `"pinch"` in the same event; `data = {dx, dy, rot, cx, cy}` (midpoint movement in px, change in the angle between the
    fingers in radians)
  One finger (or the left mouse button) is always the tool. The first move of a two-finger touch only records the starting position; `"pinch"` and `"drag2"` are
  offered from the second move on (the same as the flat map's own zoom and pan).
- `game.focusOn(x, y, scale)` calls `p.focus(x, y, scale)` (the 2D camera only moves if `focus` is missing or returns `false`).
- `game.resize()` calls `p.resize()`.
- Map labels (field names, creek names) are placed with `game.project`; they hide when it returns `null` or `visible: false`. The zoom limits that hide labels on the flat map do not apply
  in 3D. The scale bar is hidden in 3D.
- Frames: `"frame"` still fires, `frameGate` still applies, the weather still updates. Brush rings are not drawn by the game: `state.brush` carries the brush position and radius
  in metres (`on: true` while a paint tool has one) for the provider to draw.
- Detail-level changes (`ready`) replace `game.sim` and its textures: re-fetch `game.sim.views()` each frame (the state has them) rather than caching.

The flat map's own camera (`game.cam`) keeps working underneath; `game.fitCamera()` resets it.

---

## Simulation helpers

On `game.sim` (the engine; read its data, never write to textures directly):

- **`sim.restore(T, M)`**: upload `Float32Array`s of length `nx*ny*4` into the current terrain and ground textures (`null` leaves one alone), then refresh the
  bank map. Layout is the same as `sim.readTerrain()` (height, limestone height, cover, growth) and `sim.readMoisture()` (moisture, soil, organic matter, field).
  It clears the undo snapshot and, in the game, emits `"terrain"` and bumps `terrainVersion`. Water on the ground is left as it is; call `sim.dryOut(base, keep)` if
  you want it drained. Throws if a length is wrong.
- **`sim.sampleLine(x0, y0, x1, y1, n)`**: one tiny GPU pass reading `n` points (1 to 512; more is capped) evenly along a straight line, in metres. Returns an object of
  `Float32Array(n)`: `dist` (metres along the line), `h` (ground height), `bed` (limestone height), `cover` (cover id), `growth` (0..1), `depth` (water depth, m),
  `som` (organic matter 0..1), `soil` (0 clay / 1 loam) and `inside` (1 if the point is on the map). Heights, depth and organic matter are blended between the four
  nearest cells; cover, growth and soil come from the cell itself. Points off the map are read from the nearest edge cell, so check `inside`.
  It reads the textures as they are right now, so it can be called every frame while a storm runs (it costs one sync read-back).
- Existing: `sim.probe(x, y)`, `sim.readTerrain()`, `sim.readWater()`, `sim.readMoisture()`, `sim.readRecord()`, `sim.flowAcross(...)`, `sim.views()`, `sim.nx`, `sim.ny`, `sim.dx`.
  Read-back calls (`read*`, `probe`, `sampleLine`) stall the GPU: use them on events, not for whole grids every frame.

**Restoring a saved ranch** (for the save module). The game keeps its plain numbers on `game`; set them back, then tell the screen:

```js
game.sim.restore(T, M);                                   // land and cover (emits "terrain")
game.sim.dryOut(game.baseMoist, 0);                       // optional: drain leftover water
game.fields.forEach((f, i) => { f.use = saved.uses[i]; }); // field land uses (the land itself came back with T)
Object.assign(game, { cash, ledger, season, year, groundwater, baseMoist });
game.cashChanged(); ui.buildLabels(); ui.refreshSeasonBar(); ui.updateTools();
game.applyState(saved.modules);                           // module state registered with game.registerState
```

Things the game keeps: `game.cash`, `game.ledger`, `game.season`, `game.year`, `game.groundwater`, `game.baseMoist`, `game.fields[i].use`,
`game.hintsShown`. Call `game.snapshotForUndo()` first if the player should be able to undo a load.

---

## Cross-module ids

So modules can use each other **optionally**: always feature-detect, never require.

- tools `"trace"` and `"section"`, lens `"flow"`: hydro
- `Creek.view3d = {isActive(), enter(), exit(), toggle()}`: view3d
- `Creek.save = {hasAuto(), save(slot), load(slot), list(), extraState(fn)}`: save
- `Creek.stormgraph`: stormgraph
- `Creek.audio`: audio
- `Creek.life = {score(), check(), postcards()}` and `Creek.neighbors = {state(), factor()}`: life
- `Creek.coach`: coach

Example: `if (Creek.view3d && Creek.view3d.isActive()) { ... }`; `if (game.lenses.some(l => l.id === 'flow')) { ... }`.

---

## Pause, fast-forward, frame gate

- `game.paused = true` stops storm stepping (no `"stormStep"`; the storm clock holds; weather rain is held) but the map keeps drawing, tools keep working and
  `"frame"` keeps firing. The storm progress label reads "Paused".
- `game.fast = true` is fast-forward: the per-frame step budget is bigger (the adaptive steps-per-frame cap rises from 70 to 220 and it aims for a longer frame, like a turbo storm),
  and **during a storm only every 3rd frame is drawn**. The existing adaptive steps-per-frame behaviour is otherwise unchanged.
- `game.frameGate = (game, dt) => boolean`: return `false` to skip drawing this frame (for example to throttle a heavy view). `undefined`/`true` draw. A throw is logged and treated as "draw".
- `?quick=1` makes storms short for testing: `Creek.CONFIG.stormBurst = 150`, `stormTail = 90` (instead of 1800 and 1200), applied at start-up.

---

## Testing

Headless Chromium with **software GL** (no GPU: about 100x slower than a real one, so judge by correctness and by looking at screenshots).

```js
const T = require('/home/user/creeks/tools/testlib.js');
const t = await T.open({ root, query: 'level=3&quick=1&free=1', viewport: {width: 360, height: 740}, touch: true, dir: '/tmp/creek-work/mine' });
t.errors; await t.shot('name'); await t.eval(() => game.tool); await t.quickStorm(10); await t.close();
```

The full list of calls is at the top of `tools/testlib.js`. `node tools/smoke.js [root] [extra-query]` runs the standard checks (and the API checks) and prints PASS/FAIL
(`ONLY=api` runs one section; `node tools/smoke.js . mods=example` also loads the example module).

- Always use `?level=3` (4 m cells) and `?quick=1`; never run storms at level 0 or 1 in software GL.
- `?free=1` skips the title card. `?mods=a,b` / `?addmods=c` choose modules.
- Expected console noise: 404s for missing `ranch-*.jpg` pictures (`testlib` ignores them). Any other console or page error is a bug.
- `window.game` is the game; `Creek.ui` the UI. `t.quickStorm` switches `game.draw` off while the storm runs.

---

## Bundling

`python3 tools/bundle.py OUT.html` writes one HTML file (plus the `assets/` folder is still needed for pictures). Every module id in `Creek.CONFIG.modules` is inlined from
`src/mod-<id>.js`, and the loader skips modules that are already registered, so no request for `src/mod-*.js` is made for them. Modules not in the config can still be loaded
from `src/` with `?mods=` / `?addmods=` if the folder is hosted next to the page. The web-worker terrain builder is bundled as before.

---

## Notes and gotchas

Differences from the first plan, and things that are easy to trip over:

1. **`"terrain"` fires when a change settles; `terrainVersion` moves on every edit.** During a dig stroke the version rises each frame but the event comes at the end of the stroke.
2. **`"stormEnd"` fires before the report card is shown**, and `terrain` fires just before it. `game.lastStorm` and `game.stormHistory` are already updated.
3. **`series` has a fifth array, `mudQ`**, and `"probe"` carries `x, y, px, py` on top of the probe reading.
4. **Custom tools are unlocked in the story only with `readonly: true`.** Tools that edit the land are subject to `game.allowed` like the built-in ones.
5. **The "view" gestures**: right-drag is `"orbit"`, middle-drag is `"pan"`; two fingers produce `"pinch"` and `"drag2"` (the plan listed the four names without saying which is which).
6. **`game.toWorld` can return `null`** while a provider is active (and in no other case); on the flat map it can return points outside the ranch. `game.inMap(w)` checks both.
7. **`game.baseline` and `game.stormHistory` are cleared on a reset** (free play and the story both reset the ranch when they start); the story sets `baseline` after its own reset.
8. **`ready` also runs after "Change detail level".** The old `game.sim` is disposed; GPU objects you built on the old one are gone.
9. **A crash in one frame no longer stops the game loop**: the error is reported (at most once every 3 s per message) and the next frame runs.
10. `sim.sampleLine` returns an extra `inside` array; `sim.restore` accepts `null` for either array.
11. On a 360 px phone the cash chip and banner were wider than the screen; they now shrink (banner text is cut with an ellipsis) and the view chip row scrolls.
12. The Settings card, the `?` shortcut card and module menu items are modal cards: the shortcut dispatcher ignores keys while any card is open.
13. `ui.addButton`/`ui.panel` ids: if an element with that id already exists the button gets no `id` attribute (a warning is logged) but is still returned.
