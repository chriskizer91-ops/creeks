# River scale (the valley view)

A second way to play: zoom out from the 500-acre ranch to the whole valley it sits in (6 km x 15 km, about 6,000 acres drain to the bottom edge)
and let **decades** go by in seconds. It is a reduced-complexity fluvial geomorphology model with real physics in it, tuned to behave the way
streams do. It is a toy, not a flood-mapping tool.

Open it from the **🏞️ Valley** chip on the ranch map, the menu, or the **R** key. **Esc**, **🏠 Ranch** or **R** takes you back.

## What is in the model (`src/river-core.js`)

No drawing and no GPU in this file; it runs in Node too (see the tests below). Public pieces: `Creek.River.buildValley(opts)`,
`Creek.River.Model`, `Creek.River.buildDem(valley)`, `Creek.River.kOfT(T)`, `Creek.River.hydraulics`, `Creek.River.GEO`.

**The valley.** The ranch's creek and five gullies are the real ones from `src/world.js` (`Creek.ranchStreams()`), moved to where the ranch
sits in the valley. Upstream and downstream of it the main creek (Plum Creek, 18 km) and seven side streams are made here, with natural
meanders. Every stream is a chain of nodes about every 40 m. A node holds: its place on the map, bed height, bottom width, bank slope,
floodplain height, an optional inset bench, bed layers (gravel over soft soil over limestone), bank soil, plant cover, drained area, and flow.

**One year** (`model.stepYear({force, climate})`) meets six events: two low flows and four random floods (return period `T = 1/(4u)`,
`u` uniform, so about one flood a year above `T = 1`). A flood of the 1-, 10- and 100-year size gives the peak flow
`Q = k(T) * A^0.8 * qf` where `k(T)` is fitted to the ranch storm model (about 34, 110 and 190 m3/s at 10 km2). For every event:

1. **Flow and depth**: Manning's equation in a compound channel (channel, bench, floodplain), solved with a safeguarded Newton search.
   Bed shear drops once water spills onto the floodplain, which is what makes a cut-down creek keep its force.
2. **Banks**: excess shear on the bank (soil strength with a root factor `1 + 4*veg`, or the armour of the stream's own gravel at the foot of the
   bank, whichever is larger) retreats the bank, more on the outside of a bend. Banks taller than they can stand slump at the end of the year
   (mass failure, `Hc`); 70% of the slump leaves as mud and 30% stays as a wedge that starts a **bench**.
3. **Gravel (bedload)**: Meyer-Peter and Muller above a Shields stress of 0.045; the load relaxes toward the carrying capacity over an adaptation
   length (`max(200 m, 20 bottom widths)`), and the bed moves by mass balance (Exner). **Each event is cut into short steps (2 to 8)** and the
   slopes are refreshed between steps: one big step per flood let scour pits run away. When the gravel is gone the soft soil and then the limestone
   are cut, slowly (headcuts stall on limestone ledges).
4. **Mud**: carried through; a share settles on the valley floor when the water goes overbank (floodplain building).
5. **Planform** (once a year): bends migrate by the **upstream-weighted curvature** (the push on a bank comes from its own bend and the stretch
   just above it), so bends grow and slide downstream. A loop whose neck closes to about a channel width is **cut off** and becomes an oxbow lake.
   The bend speed is sped up on purpose (setting "How fast bends move").
6. **Plants, benches, stages**: roots grow back where banks are quiet and die back where they are torn up. On a quiet cut-down creek plants trap mud
   along the edge and grow a bench. Every node is classed on the Schumm and Harvey channel-evolution stages (I steady, II cutting down, III banks
   falling in, IV refilling, V healed) and a simplified Rosgen type (A, B, C, E, F, G).

**Supply and the settled profile.** Each node gets a gravel yield per unit of drained area, and its grain size is the one for which the
carrying capacity of a *natural* channel equals that load (so streams get finer downstream). A cut-down channel is then too strong for its
supply, which is what makes it dig. `src/river-calib.js` (generated; do not edit by hand) holds the bed adjustments from a 600-year spin-up, so
healthy streams start in balance and hold still. **After any change to the physics or the valley, run `node tools/river-calibrate.js 600`**
(about 3 minutes) and commit the new `river-calib.js`.

## Player tools (`src/mod-river.js`)

| tool | what it does in the model | price |
|---|---|---|
| 🔍 Look | select a node; drag pans | |
| 🌿 Plant | `model.plant(nodes)`: target plant cover 1 | $6 per metre |
| ⛏️ Bench | `lowerBanks(nodes)`: banks cut back to a flat bench at about bankfull height | $32 per metre |
| 🪨 Rock weir | `addStructure(n, 'weir')`: holds the bed up, built for about a 50-year flood | $900 |
| 🦫 Dam analog | `'bda'`: slows water, washes out in a 5-year flood or after 10 years | $250 |
| 🧱 Plug headcut | `'plug'`: that node can never cut down | $600 |
| 🏞️ Silt pond | `'pond'`: traps gravel and mud until it fills | $3,000 |
| 〰️ New bends | `reMeander(nodes)`: lays the channel in a sine curve in a wide valley | $30 per metre |
| 📏 Straighten | `straighten(nodes)`: a sandbox "what if" | $12 per metre |
| 🗑️ Remove | takes a structure out | free |

The ranch's own creek and gullies cannot be re-shaped from the valley (`canReshape` is false): they are drawn on the ranch map. Everything else
that is vertical (plant, bench, structures) works there too. Money comes out of the ranch's cash; it can go negative (there is no losing).

**Reading and checking** (⋯ menu): a **valley journal** (what happened, badges), **charts** of the mud budget (banks and bed on one side, floodplain, ponds and
export on the other), the flood peaks at the bottom of the ranch and the health of the creek, **Reading the map** (how contour lines work), and a ghost
line showing where each creek used to run. Tapping bare ground with the Look tool reads its height above the valley mouth and its slope.

**Events** (🌊 menu): 10-, 50- and 100-year floods for the next year, a dry year, and the big river at the valley mouth cutting down 3 ft
(`baseLevel`): a wave of digging runs up the creek. A called flood also plays a short flood-wave animation down the creeks.

**Lenses**: Health (stage), Bed up or down since the start, Bank height, Flood force (10-year shear), Plants, Stream type, Gravel moving, Last flood.

## The two-way link with the ranch map

**Ranch to valley** (`ranchInputs()` in `mod-river.js`, applied with `model.setRanchInputs`): the ranch creek's bank bareness sets the plant cover its
banks grow toward; the ranch's storm peak (from `game.baseline` and `game.stormHistory`) lowers peak flows below the ranch (up to 30%); the soil lost
in the latest storm against the baseline scales the ranch's own mud supply. It is read when the view opens and after the ranch changes.

**Valley to ranch** (**⋯ then Bring the changes to my ranch map**, `applyToRanch()`): for every cell near the ranch's creek and gullies the difference
between the channel the valley model has now and the one at the last sync (or the start) is added to the ranch terrain (bed digging or filling, banks
washing back, benches, mud on the floodplain), plants on new benches start as willows, and `sim.restore` puts it on the GPU. It takes one undo snapshot.

## Files

- `src/river-core.js`: the model (this document). `src/river-calib.js`: generated settled profile.
- `src/mod-river.js`: the screen (Canvas 2D map with hillshade and contours, the ranch's own map laid inside the dashed box, lenses, inspector with
  a cross-section, a long profile, a history chart and Lane's balance, tools, journal, badges).
- `src/world.js`: one added line, `Creek.ranchStreams = buildStreams`.
- `tools/river-test.js` (a Node harness; `node tools/river-test.js [years] [seed]` prints a run), `tools/river-calibrate.js`,
  `tools/river-selftest.js` (30 checks of how streams should behave, about 2.5 minutes).

## Extension points

`Creek.river` (set when the module starts): `{open, close, isOpen, model(), run(n), select(nodeId), setLens(id), setTool(id), applyToRanch(), fitAll(),
goRanch(), useTool(tool, nodes, node), callFlood(T), LENSES, TOOLS, state}`. The game emits `"river"` (`true` or `false`) when the view opens or closes.
State is registered with `game.registerState('river', ...)` for the save module.

## Honest limits

- It is not calibrated to any real river. The units (SI inside, feet and acres on screen) and the physics are real; the numbers are tuned.
- One reach of valley is one fixed geometry (the 6 x 15 km box); the hills in the background do not erode.
- Bends move faster than real ones, and floods are drawn at random (set the weather in Settings: drier, normal, wetter).
- Checked in headless software-GL Chromium and Node only; not tried on a real GPU or phone.
