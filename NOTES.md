# Creek Care (working title)

A top-down sandbox: dig, shape and plant, then it rains and you watch where the water goes.
Open `index.html` through any web host (or `python3 -m http.server` and visit `localhost:8000`).
Needs a browser with WebGL2 (recent Chrome, Safari 15+, Firefox).

## Folder map
- `src/config.js`  every tunable number (soils, covers, storms, engine strengths)
- `src/world.js`   the land as plain numbers (no drawing, no GPU). A 3D view can read the same arrays.
- `src/sim.js`     the water/erosion engine on the GPU. Owns the data.
- `src/render.js`  the flat map drawing. Only reads the data.
- `src/game.js`    camera, touch, tools, storms, measurements, hints
- `src/ui.js`, `src/story.js`, `src/main.js`  screens, the one-year story, start-up
- `assets/pictures/` the 10 painted pictures (slots); `assets/extras/` the companion pictures

## To check / tune
- Rainfall depths in `config.js` (`storms`) are approximate DFW values typed from memory.
  NOAA's server was not reachable when this was built. Please check against NOAA Atlas 14 (Dallas) and edit.
- Erosion strength (`sim.Kc`, `sim.Ks`, `slumpRate`) was only tuned by one test storm.
