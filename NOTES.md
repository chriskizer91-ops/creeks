# Creek Care — Ranch edition (working title)

You inherit **Bluestem Ranch**: 500 acres, a big incised creek (Plum Creek) and five headwater gullies,
about 15 fields. The creek drains ~2,500 acres; you own 500 of them. You make regenerative-agriculture
and stormwater decisions, then a storm shows you what they did. Zoom out to the **valley view** and decades go by:
banks wear back, bends slide downstream, cut-down creeks heal or get worse (a reduced-complexity fluvial geomorphology model).

Open `index.html` through any web host (or `python3 -m http.server`, then `localhost:8000`).
Needs WebGL2 (recent Chrome, Safari 15+, Firefox) and a decent graphics chip.
The first version (a suburban yard) is kept in git: `git checkout yard-v1`.

## How to play (the short version)
- **☰** menu: story, free play, save and load, settings, map school, the picture book.
- **View ▾** (top left) picks what the map shows: the ranch from the air, soil health, where soil moved, how deep the last flood got,
  where rain runs. Views that need it show a colour key. **Lines** turns the contour lines on and off. **⤢** (or 0) shows the whole ranch.
- **Send a storm** (top right): 1-, 10- or 100-year rain. Pause or fast-forward it in the storm box (Space, F).
- **Tools** (bottom): the line under them says what the picked tool does and what it costs. Undo (Z) goes back several steps.
- **🏞️ Valley** opens the river-scale view; **3D** (D) tilts the ranch; **📈 Graph** (G) shows the storm's hydrograph.
- Press **?** for every key.

## Detail levels
1 m cells (≈2.03 million cells over the ranch) · 2 m · 3 m · 4 m. The game times your graphics chip and picks
the finest level that runs a storm in ~100 s. Change it from the ☰ menu (it restarts the ranch).
`?level=0..3` in the address forces one. Terrain is built by background threads (web workers).

## What the map shows (src/shade.js)
The flat map and the 3D view share one shader, made to look like an aerial photo of North Texas: land kinds blend at ragged,
organic edges (a noisy vote of the four nearest cells), trees are drawn crown by crown with their shadows and turn with the seasons
(live oak and cedar stay green), pasture, prairie and crops have their own textures, dry black clay cracks, cattle trails follow
the contour on grazed slopes, fresh flood deposits and scoured ground show. Water: clear water is jade and fades with depth, flood
water is tan, a thin sheet of runoff only darkens the ground, ripples drift with the current and white water appears where the flow
is supercritical (Froude number above 1).

## Folder map
- `src/config.js`  every tunable number: soils, covers, land uses, money, storms, engine strengths, the modules to load
- `src/world.js`   the land as plain numbers (no drawing, no GPU). A 3D view can read the same arrays.
- `src/worker.js`  lets several CPU cores build the terrain
- `src/sim.js`     the water / erosion / soil engine on the GPU. Owns the data (and the undo snapshots).
- `src/shade.js`, `src/render.js`  the map drawing (shade.js is shared with the 3D view). Only reads the data.
- `src/river-core.js`, `src/river-calib.js`, `src/mod-river.js`  **River scale**: the whole valley, decades at a time (see `docs/RIVER_SCALE.md`)
- `src/game.js`    camera, touch, tools, fields, money, storms, measurements, hints
- `src/ui.js`, `src/story.js`, `src/main.js`, `style.css`, `index.html`  screens, the three-year story, start-up
- `src/mod-*.js`   feature modules (see `docs/EXTENSION_API.md`): `settings` (pause, fast-forward, sharpness, resting, graphics-loss recovery),
  `save` (save slots and autosave), `view3d` (3D view), `hydro` (water paths, trace, cross-section), `stormgraph` (hydrograph), `life`
  (ranch health, postcards, neighbours), `audio` (rain, water and nature sounds), `coach` (tour and map school), `river` (valley view).
  `example` is a reference module that is not loaded by default (`?addmods=example`).
- `tools/bundle.py` packs everything into one html file if a host needs that
- `tools/smoke.js`, `tools/testlib.js`  the browser smoke test (headless Chromium, software GL)
- `tools/river-test.js`, `tools/river-calibrate.js`, `tools/river-selftest.js`  run the river model in Node (see `docs/RIVER_SCALE.md`)
- `assets/pictures/`, `assets/extras/`  the painted pictures

## Picture slots (ranch)
Each slot falls back to a picture from the first set until a ranch painting exists. Drop JPEGs with these names in `assets/pictures/`:
`ranch-01-title` (3:2) · `ranch-02-inherit` · `ranch-03-dry-creek` · `ranch-04-storm` · `ranch-05-field-gully` · `ranch-06-cattle` ·
`ranch-07-neighbors` · `ranch-08-years-later` · `ranch-09-winter` · `ranch-10-first-flow` (all 3:2) and the square how-to cards
`ranch-card-swale` · `ranch-card-pond` · `ranch-card-roots` · `ranch-card-bda` · `ranch-card-willow` · `ranch-card-fields`.

## To check / tune
- Rain depths in `config.js` (`storms`, 30-minute core) are approximate DFW values typed from memory. NOAA's server was not
  reachable. Check them against NOAA Atlas 14 vol. 11 for your spot and edit.
- Erosion strength (`sim.Kc`, `sim.morph`, `slumpRate`), money numbers and crop yields are first guesses.
- River scale: after changing the river model's physics or valley, re-run `node tools/river-calibrate.js 600` and commit `src/river-calib.js`; `node tools/river-selftest.js` checks the behaviour.
- The map shader is about 1.7 times the work of the first version (measured in software GL). On a slow phone, lower **Sharpness** in Settings.
- Not built yet: skipping years on the ranch map, wildlife.
