# Creek Care — Ranch edition (working title)

You inherit **Bluestem Ranch**: 500 acres, a big incised creek (Plum Creek) and five headwater gullies,
about 15 fields. The creek drains ~2,500 acres; you own 500 of them. You make regenerative-agriculture
and stormwater decisions, then a storm shows you what they did.

Open `index.html` through any web host (or `python3 -m http.server`, then `localhost:8000`).
Needs WebGL2 (recent Chrome, Safari 15+, Firefox) and a decent graphics chip.
The first version (a suburban yard) is kept in git: `git checkout yard-v1`.

## Detail levels
1 m cells (≈2.03 million cells over the ranch) · 2 m · 3 m · 4 m. The game times your graphics chip and picks
the finest level that runs a storm in ~100 s. Change it from the ☰ menu (it restarts the ranch).
`?level=0..3` in the address forces one. Terrain is built by background threads (web workers).

## Folder map
- `src/config.js`  every tunable number: soils, covers, land uses, money, storms, engine strengths
- `src/world.js`   the land as plain numbers (no drawing, no GPU). A 3D view can read the same arrays.
- `src/worker.js`  lets several CPU cores build the terrain
- `src/sim.js`     the water / erosion / soil engine on the GPU. Owns the data.
- `src/render.js`  the flat map drawing. Only reads the data.
- `src/game.js`    camera, touch, tools, fields, money, storms, measurements, hints
- `src/ui.js`, `src/story.js`, `src/main.js`  screens, the three-year story, start-up
- `tools/bundle.py` packs everything into one html file if a host needs that
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
- Not built yet: saving, neighbours joining in (hook: `upstreamFactor`), skipping years, wildlife, 3D view.
