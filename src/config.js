/* Creek Care — shared settings. Everything you might want to tune lives here.
   Plain scripts (no build step) so the game opens from any simple web host. */
window.Creek = window.Creek || {};
Creek.CONFIG = {
  title: 'Creek Care',            // working title — no name chosen yet

  // Map size in metres (x runs west→east, y runs north→south = downhill)
  mapW: 100, mapH: 150,

  // Cover types (stored as numbers in the land data)
  COVER: { BARE: 0, LAWN: 1, GRASS: 2, TREE: 3, ROOF: 4, PAVE: 5, WILLOW: 6, GARDEN: 7, BDA: 8, FENCE: 9 },

  // Per-cover properties, indexed by cover id 0..9
  //            bare  lawn  grass tree  roof  pave  willow garden bda   fence
  cover: {
    infil:    [0.45, 0.80, 1.50, 1.90, 0.0, 0.0, 1.40, 3.00, 0.20, 0.45], // × soil infiltration
    manning:  [0.030,0.045,0.090,0.120,0.015,0.013,0.150,0.100,0.300,0.060], // water drag
    rootDepth:[0.0,  0.12, 1.6,  3.0,  0.0,  0.0,  2.0,  1.2,  0.0,  0.0],  // metres roots reach
    rootBonus:[0.0,  0.25, 0.90, 1.30, 0.0,  0.0,  1.10, 0.60, 0.0,  0.0],  // extra bank steepness roots allow
    surfHold: [0.0,  0.75, 0.85, 0.60, 1.0,  1.0,  0.70, 0.80, 1.0,  1.0],  // how well the surface resists scour
    fixed:    [0,    0,    0,    0,    1,    1,    0,    0,    1,    1]      // can't be dug or washed
  },

  // Soils: 0 = black clay, 1 = sandy loam
  soil: {
    infilWet:  [3, 35],     // mm/hr when soaked
    infilDry:  [70, 140],   // mm/hr when dry (clay cracks)
    storage:   [0.03, 0.06],// m of water the top layer holds before it is "full"
    tanDry:    [1.7, 1.1],  // steepest stable bank (rise/run) when dry
    tanWet:    [0.50, 0.45],// ...and when soaked
    erodible:  [0.6, 1.6],  // how easily water picks it up
    critSpeed: [0.5, 0.3]   // m/s before water starts picking soil up
  },

  // Water engine tuning
  sim: {
    gravity: 9.81,
    Kc: 0.004,              // sediment carrying strength
    Ks: 0.45,               // pick-up rate (1/s)
    Kd: 1.2,                // drop-off rate (1/s)
    slumpRate: 0.15,        // how fast over-steep banks fall (1/s)
    slumpEvery: 2,          // slump runs every N water steps
    bankEvery: 12,          // refresh bank-height map every N steps
    bankRadius: 2.0,        // m — how far to look for the bed below a bank
    houseRise: 0.5,         // m the house stands above ground
    dtPerCell: 0.18         // time step = this × cell size (seconds)
  },

  // Levels of detail (cell size, metres). Chosen automatically; finest = 25 cm.
  levels: [0.25, 0.5, 1.0],

  // Storms. Rain depths are APPROXIMATE for Dallas–Fort Worth (NOAA Atlas 14 style),
  // typed from memory because the NOAA server could not be reached when this was built.
  // Please check them against hdsc.nws.noaa.gov (Dallas, Atlas 14 vol. 11) — see NOTES.md.
  // depth15 = inches that fall in the storm's 15-minute burst.
  storms: {
    1:   { name: 'Small storm',  label: '1-year',   depth15: 0.85, tail: 'Happens most years.' },
    10:  { name: 'Big storm',    label: '10-year',  depth15: 1.55, tail: 'A 1-in-10 chance every year.' },
    100: { name: 'Huge storm',   label: '100-year', depth15: 2.30, tail: 'A 1-in-100 chance every year.' }
  },
  stormBurst: 900,          // seconds of rain
  stormTail: 360,           // seconds of watching it drain
  peakFactor: 1.9,          // peak intensity ÷ average within the burst

  // The other ~99 yards. Watershed ≈ 25 ha; the map covers ~1.5 ha of it.
  upstream: {
    areaM2: 235000,
    runoff: { 1: 0.38, 10: 0.5, 100: 0.6 },
    lag: 300,               // seconds (linear-reservoir lag)
    split: { street: 0.30, left: 0.15, right: 0.15, outfall: 0.40 }
  },

  growth: {                 // growth gained per season
    grass: 0.55, tree: 0.22, willow: 0.5, garden: 0.4
  },

  barrelLiters: 208, barrelMax: 3, barrelDrain: 0.0005  // m³/s once rain stops
};
