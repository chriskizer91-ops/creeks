/* The land, as plain numbers. No drawing and no GPU in here.
   generateWorld(cellSize) returns flat arrays (one RGBA group per cell):
     T = [ surface height (m), limestone height (m), cover type, growth 0..1 ]
     M = [ soil moisture, soil type (0 clay / 1 loam), roof zone (1-4 or 0), spare ]
   plus `meta`, a list of named places (house, driveway, creek line, water sources...).
   Any renderer (the flat map now, a 3D view later) can read the same arrays. */
(function () {
  const C = Creek.CONFIG, CV = C.COVER;

  function hash(ix, iy) {
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // Everything below is in metres.
  const meta = {
    mapW: C.mapW, mapH: C.mapH,
    yard: { x0: 25, x1: 75, y0: 13.5, y1: 62 },
    house: { x0: 30, x1: 50, y0: 19, y1: 31 },
    drive: { x0: 44.5, x1: 49.5, y0: 11, y1: 19 },
    street: { y0: 2, y1: 11 },
    sidewalk: { y0: 12, y1: 13.5 },
    fenceY: 62,
    creekHeadY: 64,
    outfall: { x: 50, y: 66.2 },
    creekX: function (y) { return 50 + 7 * Math.sin((y - 64) / 16) * sstep(64, 95, y); },
    downspouts: [
      { x: 29.2, y: 18.2 }, { x: 50.8, y: 18.2 }, { x: 29.2, y: 31.8 }, { x: 50.8, y: 31.8 }
    ],
    trees: [
      { x: 30, y: 15, r: 4.5 }, { x: 68, y: 45, r: 4 }, { x: 28, y: 52, r: 3.5 },
      { x: 36, y: 73, r: 3 }, { x: 63, y: 97, r: 3.2 }, { x: 38, y: 122, r: 3 }, { x: 60, y: 137, r: 3.2 }
    ],
    // where the other 99 yards' water arrives (rect in metres)
    sources: {
      street: { x0: 0, x1: 100, y0: 2, y1: 4 },
      left: { x0: 0, x1: 1.5, y0: 14, y1: 60 },
      right: { x0: 98.5, x1: 100, y0: 14, y1: 60 },
      outfall: { x0: 49.2, x1: 50.8, y0: 65.4, y1: 67 }
    },
    gutterLowX: 47
  };
  meta.roofArea = [0, 0, 0, 0]; // m² per downspout, filled below

  function surface(x, y) {
    const n = (vnoise(x / 6, y / 6) - 0.5) * 0.10 + (vnoise(x / 2, y / 2) - 0.5) * 0.03;
    return 5.0 - 0.02 * y + 0.0004 * (x - 50) * (x - 50) + n;
  }

  function generateWorld(dx) {
    const nx = Math.round(C.mapW / dx), ny = Math.round(C.mapH / dx);
    const T = new Float32Array(nx * ny * 4), M = new Float32Array(nx * ny * 4);
    const H = meta.house;
    // flat house top: highest ground under the house + rise
    let top = -1e9;
    for (let y = H.y0; y <= H.y1; y += 1) for (let x = H.x0; x <= H.x1; x += 1) top = Math.max(top, surface(x, y));
    top += C.sim.houseRise;
    const roofCells = [0, 0, 0, 0];

    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx, y = (j + 0.5) * dx, k = (j * nx + i) * 4;
      let zs = surface(x, y), cover = CV.LAWN, growth = 1, soilDepth = 1.2 + (vnoise(x / 9, y / 9) - 0.5) * 0.5;
      let bed;
      // soil type: clay on the west, loam on the east, patchy in between
      let loam = sstep(0.0, 1.0, (x - 50) / 9 + (vnoise(x / 5, y / 5) - 0.5) * 1.6) > 0.5 ? 1 : 0;
      let zone = 0;

      // the creek
      let carve = 0, shape = 0;
      if (y > meta.creekHeadY) {
        const depth = 1.3 * sstep(64, 76, y);
        const d = Math.abs(x - meta.creekX(y));
        const t = Math.min(1, Math.max(0, (d - 1.2) / 1.6));
        shape = 1 - sstep(0, 1, t);
        carve = depth * shape;
        zs -= carve + 0.06 * Math.sin(y / 4) * (shape > 0.9 ? 1 : 0);
        if (carve > 0.04) { cover = CV.BARE; growth = 0; }
      }
      if (y > 62) { growth = Math.min(growth, 0.85); }
      bed = Math.min(surface(x, y) - soilDepth, zs);

      // street, sidewalk, curb, driveway
      const inX = (a, b) => x >= a && x <= b, inY = (a, b) => y >= a && y <= b;
      if (inY(meta.street.y0 - 2, meta.street.y1)) { cover = CV.PAVE; }
      if (inY(11, 11.45) && !inX(meta.drive.x0 - 1, meta.drive.x1 + 1)) { cover = CV.PAVE; zs += 0.15; }
      if (inY(meta.sidewalk.y0, meta.sidewalk.y1)) cover = CV.PAVE;
      if (inX(meta.drive.x0, meta.drive.x1) && inY(meta.drive.y0, meta.drive.y1)) cover = CV.PAVE;
      if (cover === CV.PAVE) bed = zs - 0.3;

      // fence (a thin line around the yard's back and sides)
      const Y = meta.yard, fw = Math.max(dx, 0.3) * 0.5;
      if ((Math.abs(y - meta.fenceY) < fw && inX(Y.x0, Y.x1)) ||
          ((Math.abs(x - Y.x0) < fw || Math.abs(x - Y.x1) < fw) && inY(Y.y0 + 2, meta.fenceY))) { cover = CV.FENCE; }

      // trees
      for (const t of meta.trees) {
        const r = Math.hypot(x - t.x, y - t.y);
        if (r < t.r * (0.8 + 0.25 * vnoise(x * 1.7, y * 1.7)) && cover !== CV.PAVE && cover !== CV.FENCE) { cover = CV.TREE; growth = 1; }
      }

      // a bare, worn corner of the yard (washes into the creek in a storm)
      if (Math.pow((x - 66) / 7, 2) + Math.pow((y - 55) / 5, 2) < 1 + 0.25 * (vnoise(x, y) - 0.5) && cover === CV.LAWN) { cover = CV.BARE; growth = 0; loam = 1; }

      // the house
      if (inX(H.x0, H.x1) && inY(H.y0, H.y1)) {
        cover = CV.ROOF; zs = top; bed = top - 1;
        zone = (x < (H.x0 + H.x1) / 2 ? 1 : 2) + (y < (H.y0 + H.y1) / 2 ? 0 : 2);
        roofCells[zone - 1]++;
      }
      T[k] = zs; T[k + 1] = Math.min(bed, zs); T[k + 2] = cover; T[k + 3] = growth;
      M[k] = 0.12; M[k + 1] = loam; M[k + 2] = zone; M[k + 3] = 0;
    }
    for (let q = 0; q < 4; q++) meta.roofArea[q] = roofCells[q] * dx * dx;
    return { nx, ny, dx, T, M, meta };
  }

  Creek.generateWorld = generateWorld;
  Creek.worldMeta = meta;
  Creek.sstep = sstep;
})();
