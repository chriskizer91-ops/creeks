/* Creek Care — Ranch edition. Shared settings; everything you might want to tune lives here.
   Plain scripts (no build step) so the game opens from any simple web host. */
window.Creek = window.Creek || {};
Creek.CONFIG = {
  title: 'Creek Care',            // working title — no name chosen yet
  ranchName: 'Bluestem Ranch',
  creekName: 'Plum Creek',

  // Feature modules to load, in order: each id is a script src/mod-<id>.js (see docs/EXTENSION_API.md).
  // ?mods=a,b in the address replaces this list ("?mods=" means none); ?addmods=c adds to it.
  modules: [],

  // The ranch: 1400 m × 1450 m = 2.03 km² ≈ 502 acres. x runs west→east, y runs north→south (downhill).
  mapW: 1400, mapH: 1450,
  ranchAcres: 500, watershedAcres: 2500,       // the creek drains ~2,500 acres; you own 500 of them

  // Cover types (stored as numbers in the land data)
  COVER: { BARE: 0, PASTURE: 1, PRAIRIE: 2, TREE: 3, ROOF: 4, ROAD: 5, WILLOW: 6, COVERCROP: 7, DAM: 8, CROP: 9, POND: 10 },

  // Per-cover properties, indexed by cover id 0..10
  //            bare  pastr prair tree  roof  road  willw cover dam   crop  pond
  cover: {
    infil:    [0.45, 0.85, 1.60, 1.90, 0.0, 0.0, 1.40, 1.50, 0.20, 0.75, 0.05], // × soil infiltration
    manning:  [0.030,0.050,0.090,0.120,0.015,0.020,0.150,0.070,0.300,0.045,0.025], // water drag
    rootDepth:[0.0,  0.30, 1.8,  3.0,  0.0,  0.0,  2.0,  0.9,  0.0,  0.35, 0.0],  // metres roots reach (when fully grown)
    rootBonus:[0.0,  0.30, 0.90, 1.30, 0.0,  0.0,  1.10, 0.55, 0.0,  0.20, 0.0],  // extra bank steepness roots allow
    surfHold: [0.0,  0.80, 0.88, 0.60, 1.0,  1.0,  0.70, 0.85, 1.0,  0.45, 0.60], // how well the surface resists scour
    residue:  [0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.40, 0.0,  0.0,  0.0],  // protection left even when nothing is growing
    fixed:    [0,    0,    0,    0,    1,    1,    0,    0,    1,    0,    0]       // can't be dug or washed
  },

  // Soils: 0 = black clay, 1 = sandy loam
  soil: {
    infilWet:  [3, 35],     // mm/hr when soaked
    infilDry:  [70, 140],   // mm/hr when dry (clay cracks)
    storage:   [0.03, 0.06],// m of water the top layer holds before it is "full"
    tanDry:    [1.7, 1.2],  // steepest stable bank (rise/run) when dry
    tanWet:    [0.50, 0.45],// ...and when soaked
    erodible:  [0.6, 1.6],  // how easily water picks it up
    critSpeed: [0.5, 0.3]   // m/s before water starts picking soil up
  },
  // Organic matter (0..1) makes soil soak water, hold together and resist washing.
  som: { infil: 1.2, erode: 0.5, stable: 0.25 },

  // Water engine tuning
  sim: {
    gravity: 9.81,
    Ksh: 0.6,               // slope wash too fine for the grid (sheet and rill erosion)
    Kc: 0.0035,             // sediment carrying strength
    morph: 2.5,             // the storm is a short burst of a long real one, so land changes are speeded up
    Ks: 0.45,               // pick-up rate (1/s)
    Kd: 1.2,                // drop-off rate (1/s)
    slumpRate: 0.15,        // how fast over-steep banks fall (1/s)
    slumpEvery: 2,          // slump runs every N water steps
    bankEvery: 16,          // refresh bank-height map every N steps
    bankRadius: 12.0,       // m — how far to look for the creek bed below a bank
    dtPerCell: 0.12,        // time step starts at this × cell size (seconds)...
    dtMin: 0.06, dtMax: 0.16 // ...and shrinks toward dtMin when the flood is violent
  },

  // Levels of detail (cell size, metres). 1 m over 500 acres is about 2 million cells: laptops only.
  // Chosen automatically by timing the device; you can change it from the menu.
  levels: [1.0, 2.0, 3.0, 4.0],
  levelNames: ['Fine · 1 m cells · 2 million', 'Medium · 2 m cells', 'Light · 3 m cells', 'Lightest · 4 m cells'],
  stormSecondsTarget: 100,   // the finest level whose storm should take no longer than this is chosen

  // Storms. Rain depths are APPROXIMATE for Dallas–Fort Worth (NOAA Atlas 14 style), typed from memory
  // because NOAA's server could not be reached when this was built. Please check them against
  // hdsc.nws.noaa.gov (Atlas 14 vol. 11) — see NOTES.md.  depth30 = inches in the storm's 30-minute core.
  storms: {
    1:   { name: 'Small storm',  label: '1-year',   depth30: 1.25 },
    10:  { name: 'Big storm',    label: '10-year',  depth30: 2.40 },
    100: { name: 'Huge storm',   label: '100-year', depth30: 3.80 }
  },
  stormBurst: 1800,         // seconds of rain
  stormTail: 1200,          // seconds of watching it drain

  // The land upstream of the ranch. Watershed ≈ 2,500 acres; the ranch is 500 of them.
  upstream: {
    areaM2: 8.1e6,          // ~2,000 acres upstream
    runoff: { 1: 0.30, 10: 0.42, 100: 0.55 },
    lag: 1200,              // seconds (linear-reservoir lag)
    split: { main: 0.64, top: 0.12, west: 0.12, east: 0.12 }
  },

  // Seasons: how much the plants grow, how wet the ground starts
  seasons: {
    summer: { grow: 0.8, moist: 0.05, cropTill: 0.85, cropCover: 0.9 },
    fall:   { grow: 0.3, moist: 0.30, cropTill: 0.10, cropCover: 0.55 },
    winter: { grow: 0.0, moist: 0.45, cropTill: 0.00, cropCover: 0.45 },
    spring: { grow: 1.0, moist: 0.50, cropTill: 0.25, cropCover: 0.70 }
  },

  // Land uses a field can be switched to. cost = $ per hectare to switch.
  uses: {
    till:         { label: 'Conventional crop',          short: 'Crop',        icon: '🌽', cover: 9,  growth: 0.20, target: null, cost: 0,   rev: 1300, exp: 800, hint: 'Plowed fields sit bare between crops.' },
    notill:       { label: 'No-till + cover crop',       short: 'No-till',     icon: '🌱', cover: 7,  growth: 0.40, target: null, cost: 150, rev: 1250, exp: 520, hint: 'Roots and residue year-round. Builds soil.' },
    prairie:      { label: 'Native prairie',             short: 'Prairie',     icon: '🌾', cover: 2,  growth: 0.12, target: 1.0,  cost: 520, rev: 140,  exp: 25,  hint: 'Deep roots. Slow to establish, then very tough.' },
    pasture_rot:  { label: 'Pasture, rotational grazing',short: 'Rotation',    icon: '🐄', cover: 1,  growth: 0.40, target: 0.9,  cost: 60,  rev: 430,  exp: 95,  hint: 'Cattle move often, grass rests and recovers.' },
    pasture_cont: { label: 'Pasture, continuous grazing',short: 'Overgrazed',  icon: '🐂', cover: 1,  growth: 0.40, target: 0.3,  cost: 0,   rev: 560,  exp: 70,  hint: 'More cattle now, thinner grass every season.' },
    woods:        { label: 'Woodland',                   short: 'Woods',       icon: '🌳', cover: 3,  growth: 0.10, target: 1.0,  cost: 700, rev: 45,   exp: 5,   hint: 'Trees root deepest, but take years.' },
    wild:         { label: 'Weedy and trampled',         short: 'Weedy',       icon: '🌿', cover: 1,  growth: 0.40, target: 0.45, cost: 0,   rev: 60,   exp: 0,   hint: '' }
  },

  // Money (never a way to lose: debt is just a number)
  money: { start: 140000, digPerM3: 4.5, swalePerM: 3, pond: 2500, dam: 380, grassPerM2: 0.12, treePerStamp: 90, willowPerStamp: 40 },

  growth: { grass: 0.45, tree: 0.06, willow: 0.35 }, // growth per full-growth season for planted things (× season grow)
  tools: { digRate: 1.6 }                              // m/s of dig/pile at the centre of the brush
};
