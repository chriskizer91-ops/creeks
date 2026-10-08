/* The 3D view: the same ranch as the flat map, seen from above at an angle, with the same colours, contour lines, views and markers.
   Raw WebGL2 on the same canvas and the same graphics-chip textures as the map (nothing is copied back to the CPU):
   - the land is a grid of triangles drawn with no vertex data at all; the vertex shader reads the height from the land texture
   - colours come from shade.js (Creek.GLSL), the very code the flat map uses, so the two cannot drift apart
   - trees and buildings are lifted off the ground a little (visual only; the engine never sees it)
   - water is the same grid drawn at ground + depth, see-through, with the same ripples and mud colours
   - a "diorama" skirt around the edge shows dark soil over pale limestone, so bank height and soil depth read at a glance
   - touching the 3D land works because the land is drawn once more into a 1-pixel target that writes the world position under your finger
   One finger / the left mouse button stays the current tool, exactly as on the flat map.
   Everything a module may call is on Creek.view3d (isActive, enter, exit, toggle) plus a few helpers for tests. */
(function () {
  'use strict';
  const C = Creek.CONFIG, GL = Creek.GLSL, DEG = Math.PI / 180;
  const TILE = 128;                                  // metres per tile side; each tile is drawn at its own level of detail
  const FOV = 42 * DEG, TANH = Math.tan(FOV / 2);    // vertical field of view
  const DMIN = 12, DMAX = 3600;                      // closest and farthest the camera may be from what it looks at (m)

  // ------------------------------------------------------------------------------------------------ shaders
  // The land is a triangle strip per tile: gl_VertexID says which grid point, the land texture says how high.
  const VS_LAND = (water) => GL.head({ extr: 1 }) + '#define WPASS ' + (water ? 1 : 0) + '\n' + GL.core + `
uniform vec4 u_tile;      // tile corner x, y (m), metres per quad, quads per side
uniform vec4 u_snap;      // how many times coarser the neighbouring tile is: west, east, north, south (1 = same)
uniform vec4 u_view;      // height stretch, tree/roof stretch, reference height (m), water lift
uniform mat4 u_vp;
out vec3 v_p;
float surfZ(vec2 w){
#if WPASS
  return (hAt(w) - u_view.z + bil(u_W,w).r)*u_view.x + u_view.w;
#else
  return (hAt(w) - u_view.z)*u_view.x + extrudeAt(w)*u_view.y;
#endif
}
void main(){
  int Q = int(u_tile.w), L = 2*Q+4;
  int r = gl_VertexID/L, k = gl_VertexID - r*L, i, j;
  if (k < 2*Q+2){ i = k>>1; j = r + (k&1); } else if (k == 2*Q+2){ i = Q; j = r+1; } else { i = 0; j = r+1; }
  j = min(j, Q);
  float st = u_tile.z, fi = float(i), fj = float(j), fQ = float(Q);
  vec2 o0 = u_tile.xy, w = o0 + vec2(fi, fj)*st, wa = w, wb = w; float fr = 0.;
  // next to a coarser tile the edge points slide onto its straight edge, so there are no cracks
  if (i == 0 && u_snap.x > 1.5){ float s = u_snap.x, j0 = floor(fj/s)*s; fr = (fj-j0)/s; wa = o0 + vec2(0., j0)*st; wb = o0 + vec2(0., j0+s)*st; }
  else if (i == Q && u_snap.y > 1.5){ float s = u_snap.y, j0 = floor(fj/s)*s; fr = (fj-j0)/s; wa = o0 + vec2(fQ, j0)*st; wb = o0 + vec2(fQ, j0+s)*st; }
  else if (j == 0 && u_snap.z > 1.5){ float s = u_snap.z, i0 = floor(fi/s)*s; fr = (fi-i0)/s; wa = o0 + vec2(i0, 0.)*st; wb = o0 + vec2(i0+s, 0.)*st; }
  else if (j == Q && u_snap.w > 1.5){ float s = u_snap.w, i0 = floor(fi/s)*s; fr = (fi-i0)/s; wa = o0 + vec2(i0, fQ)*st; wb = o0 + vec2(i0+s, fQ)*st; }
  w = min(w, u_mapSize);
  float z = fr > 0. ? mix(surfZ(min(wa,u_mapSize)), surfZ(min(wb,u_mapSize)), fr) : surfZ(w);
  v_p = vec3(w, z);
  gl_Position = u_vp*vec4(v_p, 1.);
}`;

  // sky, haze and the water's mirror; used by several fragment shaders
  const SKY = `
uniform vec4 u_eye;       // eye x, y, z, haze density
vec3 hazeColor(vec3 d){
  float rain = u_wx.x;
  vec3 hor = mix(vec3(0.95,0.89,0.77), vec3(0.62,0.66,0.72), rain);
  hor += vec3(0.07,0.04,0.0)*pow(max(dot(normalize(d.xy+vec2(1e-5)), normalize(SUN.xy)), 0.), 3.)*(1.-rain);
  return mix(hor, vec3(0.93,0.95,1.0), u_wx.y*0.5);
}
vec3 skyColor(vec3 d){
  float rain = u_wx.x, e = d.z;
  vec3 hor = hazeColor(d), zen = mix(vec3(0.33,0.55,0.84), vec3(0.30,0.34,0.42), rain);
  vec3 c = mix(hor, zen, pow(clamp(e,0.,1.), 0.5));
  float s = max(dot(d, SUN), 0.);
  c += vec3(1.0,0.82,0.55)*(pow(s,18.)*0.20 + pow(s,260.)*0.9)*(1.-rain);
  if (e > 0.){
    vec2 cp = d.xy/(e+0.25)*1.6 + vec2(u_time*0.004*(1.-u_wx.z), 0.);
    c = mix(c, mix(vec3(1.), vec3(0.42,0.45,0.52), rain), smoothstep(0.45,0.8,fbm(cp*1.5))*mix(0.35,0.75,rain)*smoothstep(0.,0.25,e));
  }
  c = mix(c, hor*0.85, smoothstep(0.,-0.4,e));
  return mix(c, vec3(0.93,0.95,1.0), u_wx.y*0.4);
}
vec3 haze(vec3 col, vec3 dir, float dist){
  float f = 1.-exp(-pow(dist*u_eye.w, 1.4));
  return mix(col, hazeColor(dir), clamp(f, 0., 0.88));
}
float footprint(vec2 w){ return max(sqrt(length(dFdx(w))*length(dFdy(w))), 0.03); }   // metres per pixel here
`;

  const FS_LAND = GL.head({ extr: 1 }) + GL.core + GL.shade + SKY + `
uniform vec4 u_view;
in vec3 v_p; out vec4 o;
void main(){
  vec2 w = v_p.xy; float fp = footprint(w);
  vec3 nrm = reliefNormal(w, max(u_dx, 0.9*fp), 1.5*u_view.x, 1.5*u_view.y*(1.-smoothstep(2.5, 6., fp)), max(0.6, 0.8*fp));   // heights stretched like the picture, trees and roofs included (far away they are too small to matter)
  float lit; vec3 col = shadeLand(w, fp, nrm, lit);
  col = mix(col, u_tint.rgb, u_tint.a);
  col = weatherGrade(col, w);
  vec3 d = v_p - u_eye.xyz; float dist = length(d);
  o = vec4(haze(col, d/dist, dist), 1.);
}`;

  const FS_WATER = GL.head({ extr: 1 }) + GL.core + GL.shade + SKY + `
in vec3 v_p; out vec4 o;
void main(){
  vec2 w = v_p.xy;
  if (bil(u_W,w).r < 0.004) discard;
  float fp = footprint(w), zk = smoothstep(0.7, 3.2, 1./fp);
  vec4 wl = waterLayer(w, fp, 1., zk);
  if (wl.a < 0.01) discard;
  vec3 d = v_p - u_eye.xyz; float dist = length(d); d /= dist;
  vec2 q = w*0.8 + vec2(u_time*0.35*(1.-u_wx.z), 0.);                   // little waves that catch the sky and the sun (they smooth out with distance)
  float n0 = noise(q), nx = noise(q+vec2(0.4,0.)), ny = noise(q+vec2(0.,0.4)), amp = (1.-smoothstep(0.15, 1.2, fp))*0.9;
  vec3 N = normalize(vec3(-(nx-n0)*amp, -(ny-n0)*amp, 1.));
  vec3 R = reflect(d, N);
  float fres = pow(1.-max(dot(N,-d), 0.), 4.)*0.55;
  vec3 col = mix(wl.rgb, skyColor(vec3(R.xy, abs(R.z))), fres);
  col += vec3(1.0,0.93,0.78)*pow(max(dot(R,SUN), 0.), 90.)*0.9*(1.-u_wx.x);
  col = mix(col, u_tint.rgb, u_tint.a);
  col = weatherGrade(col, w);
  o = vec4(haze(col, d, dist), wl.a);
}`;

  // the cut-away sides: soil over limestone, using the real soil depth under each edge
  const VS_WALL = GL.head({ extr: 1 }) + GL.core + `
uniform vec4 u_wallA;     // start x, y (m), direction x, y (unit)
uniform vec4 u_wallB;     // length (m), number of steps, base height (stretched), 0
uniform vec4 u_view;
uniform mat4 u_vp;
out vec3 v_p;
void main(){
  int s = gl_VertexID>>1;
  vec2 w = clamp(u_wallA.xy + u_wallA.zw*(float(s)/u_wallB.y*u_wallB.x), vec2(0.), u_mapSize);
  float z = (gl_VertexID&1)==1 ? u_wallB.z : (hAt(w)-u_view.z)*u_view.x + 0.6;
  v_p = vec3(w, z); gl_Position = u_vp*vec4(v_p, 1.);
}`;
  const FS_WALL = GL.head({ extr: 1 }) + GL.core + GL.shade + SKY + `
uniform vec4 u_view; uniform vec4 u_wallN;
in vec3 v_p; out vec4 o;
void main(){
  vec2 w = clamp(v_p.xy, vec2(0.01), u_mapSize-vec2(0.01));
  vec4 tb = bil(u_T, w);
  if (v_p.z > (tb.r-u_view.z)*u_view.x + 0.02) discard;
  float hh = v_p.z/u_view.x + u_view.z, below = tb.r-hh, along = w.x+w.y;
  vec3 col;
  if (hh > tb.g){                                                       // soil: dark and rich on top, paler and sandier below, clay or loam
    vec4 m = texelFetch(u_M, cellOf(w), 0);
    vec3 sc = mix(vec3(0.27,0.18,0.12), vec3(0.52,0.39,0.25), m.g);
    sc = mix(sc, sc*vec3(0.62,0.58,0.55), (1.-smoothstep(0.,0.45,below))*(0.4+m.b));
    sc *= 0.88+0.24*noise(vec2(along*0.9, hh*6.)) + 0.06*(noise(vec2(along*5., hh*20.))-0.5);
    col = sc;
  } else {                                                              // limestone: pale beds with thin darker seams
    float bed = hh*2.2 + 0.7*noise(vec2(along*0.04, hh*0.3));
    float seam = 1.-smoothstep(0.02, 0.1, abs(fract(bed)-0.5)), band = floor(bed);
    col = mix(vec3(0.96,0.92,0.78), vec3(0.84,0.78,0.63), hash(vec2(band, 3.1)))*(0.92+0.10*noise(vec2(along*0.5, hh*3.)));
    col = mix(col, vec3(0.52,0.46,0.36), 0.55*seam);
    col *= 1.-0.30*smoothstep(0., 8., tb.g-hh);
  }
  col *= 0.80+0.40*max(dot(u_wallN.xyz, SUN), 0.);
  col = mix(col, u_tint.rgb, u_tint.a*0.5);
  col = weatherGrade(col, w);
  vec3 d = v_p - u_eye.xyz; float dist = length(d);
  o = vec4(haze(col, d/dist, dist), 1.);
}`;

  const VS_SCREEN = GL.head({}) + `
out vec2 v_ndc;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_ndc = p*2.-1.; gl_Position = vec4(v_ndc, 0.99999, 1.); }`;
  const FS_SKY = GL.head({ extr: 1 }) + GL.core + SKY + `
uniform vec4 u_right, u_up, u_fwd, u_lens3;   // camera axes; u_lens3 = tan(fov/2) * aspect, tan(fov/2)
in vec2 v_ndc; out vec4 o;
void main(){ o = vec4(skyColor(normalize(u_fwd.xyz + v_ndc.x*u_lens3.x*u_right.xyz + v_ndc.y*u_lens3.y*u_up.xyz)), 1.); }`;
  const FS_RAIN = GL.head({ extr: 1 }) + GL.core + GL.shade + `
uniform vec4 u_par; uniform vec2 u_res;
out vec4 o;
void main(){ o = rainOverlay(vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y), u_par.xy); }`;
  const FS_COPY = GL.head({}) + `
uniform sampler2D u_src; out vec4 o;
void main(){ o = vec4(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 1.); }`;
  const FS_PICK = GL.head({ extr: 1 }) + GL.core + `
in vec3 v_p; out vec4 o;
void main(){ o = vec4(v_p.xy, hAt(v_p.xy), 1.); }`;

  // ------------------------------------------------------------------------------------------------ small maths (matrices are column-major arrays, reused every frame)
  const mat = { vp: new Float32Array(16), vpPick: new Float32Array(16), proj: new Float32Array(16), view: new Float32Array(16) };
  function mul(o, a, b) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ------------------------------------------------------------------------------------------------ the module
  const V = {          // the camera: where it looks, which way, how far (angles in radians)
    tx: C.mapW / 2, ty: C.mapH / 2, tz: 30, tzGoal: 30, az: 0, pitch: 55 * DEG, dist: 1800, azT: 0, pitchT: 55 * DEG, vex: 3,
    eye: [0, 0, 0], fwd: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], near: 2, far: 6000,
    stamp: 1, prepared: 0, pw: 0, ph: 0, movedT: 0, tzDirty: true, tzT: 0
  };
  const L = { lost: false, glReady: false, progs: null, pickFbo: null, pickTex: null, pickDepth: null, pickOK: true, pickBuf: new Float32Array(4), aa: null, aaOK: true };
  const H = { h0: 30, hMin: 0, hMax: 60, nx: 0, ny: 0, dx: 0, T: null, tiles: null };   // the land as it was at the start (CPU copy, for the camera and labels only)
  const T = { n: 0, nx: 0, ny: 0, lod: null, cull: null, dist: null, order: null, nVis: 0, count: 0, tris: 0 };    // tiles
  let game = null, ui = null, panel = null, btn = null, elVex = null, elVexLabel = null, elCompass = null, compassAz = 99;
  let hasWater = false, lastStep = -1, lastPick = { px: -1, py: -1, stamp: -1, t: 0, res: null }, shiftPan = null, shownHelp = false;

  const P = {
    active: false,
    draw(g, s) { drawFrame(g, s); },
    pick(px, py) { return pickAt(px, py); },
    project(x, y) { return projectPoint(x, y); },
    onWheel(e, px, py) { return wheel(e, px, py); },
    onGesture(kind, d) { return gesture(kind, d); },
    focus(x, y, scale) { focusOn(x, y, scale); return true; },
    resize() { V.stamp++; }
  };

  // ---- the CPU copy of the starting land (never used for drawing; only so the camera and the labels know roughly how high the ground is)
  function loadHeights() {
    const w = game && game.world; if (!w || !w.T) return;
    H.T = w.T; H.nx = w.nx; H.ny = w.ny; H.dx = w.dx;
    let mn = 1e9, mx = -1e9; const T0 = w.T;
    const tx = Math.ceil(C.mapW / TILE), ty = Math.ceil(C.mapH / TILE);
    T.nx = tx; T.ny = ty; T.n = tx * ty;
    const lo = new Float32Array(T.n).fill(1e9), hi = new Float32Array(T.n).fill(-1e9);
    for (let j = 0; j < w.ny; j++) {
      const ty0 = Math.min(ty - 1, Math.floor((j + 0.5) * w.dx / TILE));
      for (let i = 0; i < w.nx; i++) {
        const h = T0[(j * w.nx + i) * 4], k = ty0 * tx + Math.min(tx - 1, Math.floor((i + 0.5) * w.dx / TILE));
        if (h < mn) mn = h; if (h > mx) mx = h; if (h < lo[k]) lo[k] = h; if (h > hi[k]) hi[k] = h;
      }
    }
    H.hMin = mn; H.hMax = mx; H.h0 = (mn + mx) / 2; H.tiles = { lo, hi };
    T.lod = new Int8Array(T.n); T.cull = new Uint8Array(T.n); T.dist = new Float32Array(T.n); T.order = new Int32Array(T.n);
  }
  /** Ground height from the CPU copy (bilinear). Good to about a metre once the land has been reshaped. */
  function heightAt(x, y) {
    if (!H.T) return H.h0;
    const gx = clamp(x / H.dx - 0.5, 0, H.nx - 1.001), gy = clamp(y / H.dx - 0.5, 0, H.ny - 1.001);
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, T0 = H.T, nx = H.nx;
    const a = T0[(j * nx + i) * 4], b = T0[(j * nx + i + 1) * 4], c = T0[((j + 1) * nx + i) * 4], d = T0[((j + 1) * nx + i + 1) * 4];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  const scaleFromDist = (d) => game.ch / (2 * d * TANH);
  const distFromScale = (s) => game.ch / Math.max(s, 1e-4) / (2 * TANH);

  // ---------------------------------------------------------------- camera
  /** Work out the matrices, the eye and which tiles to draw. Does nothing when nothing changed since last time. */
  function prep(W, Hh) {
    if (V.prepared === V.stamp && V.pw === W && V.ph === Hh) return;
    V.prepared = V.stamp; V.pw = W; V.ph = Hh;
    const vex = V.vex, z0 = (V.tz - H.h0) * vex, D = V.dist;
    let sp = Math.sin(V.pitch), cp = Math.cos(V.pitch);
    const fx = Math.sin(V.az), fy = -Math.cos(V.az);
    // keep the eye above the ground it hangs over (lowering the camera into a hill would hide everything)
    const ex0 = V.tx - fx * cp * D, ey0 = V.ty - fy * cp * D;
    const minZ = (heightAt(clamp(ex0, 0, C.mapW), clamp(ey0, 0, C.mapH)) - H.h0) * vex + 4;
    if (z0 + sp * D < minZ) { sp = clamp((minZ - z0) / D, 0.05, 0.998); cp = Math.sqrt(1 - sp * sp); }
    const eye = V.eye; eye[0] = V.tx - fx * cp * D; eye[1] = V.ty - fy * cp * D; eye[2] = z0 + sp * D;
    const f = V.fwd; f[0] = fx * cp; f[1] = fy * cp; f[2] = -sp;
    const r = V.right; r[0] = -fy; r[1] = fx; r[2] = 0;
    const u = V.up; u[0] = f[1] * r[2] - f[2] * r[1]; u[1] = f[2] * r[0] - f[0] * r[2]; u[2] = f[0] * r[1] - f[1] * r[0];
    // near and far planes: close to the camera when zoomed in, far enough to reach the far corner of the ranch
    let far = 0;
    for (let k = 0; k < 4; k++) { const cx = (k & 1) ? C.mapW : 0, cy = (k & 2) ? C.mapH : 0; far = Math.max(far, Math.hypot(cx - eye[0], cy - eye[1], z0 - eye[2])); }
    V.near = clamp(0.03 * D, 2, 90); V.far = far * 1.1 + 300;
    const nr = V.near, fr = V.far, asp = W / Hh, fo = 1 / TANH, m = mat.view, p = mat.proj;
    m[0] = r[0]; m[1] = u[0]; m[2] = -f[0]; m[3] = 0; m[4] = r[1]; m[5] = u[1]; m[6] = -f[1]; m[7] = 0; m[8] = r[2]; m[9] = u[2]; m[10] = -f[2]; m[11] = 0;
    m[12] = -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]); m[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]); m[14] = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]; m[15] = 1;
    p.fill(0); p[0] = fo / asp; p[5] = fo; p[10] = (fr + nr) / (nr - fr); p[11] = -1; p[14] = 2 * fr * nr / (nr - fr);
    mul(mat.vp, p, m);
    planTiles(W, Hh);
  }

  /** Which tiles are on screen, and how finely each is drawn (a tile is drawn with just enough triangles that each is a few pixels wide). */
  function planTiles(W, Hh) {
    if (!T.lod) return;
    const vp = mat.vp, e = V.eye, vex = V.vex, exs = extrusionScale(), step0 = lodStep(0), tgt = Creek.settings.get('view3d.quad', 5) * (W / Math.max(game.cw, 1));
    const lo = H.tiles.lo, hi = H.tiles.hi; let cnt = 0;
    for (let ty = 0; ty < T.ny; ty++) for (let tx = 0; tx < T.nx; tx++) {
      const k = ty * T.nx + tx, x0 = tx * TILE, y0 = ty * TILE, x1 = Math.min(x0 + TILE, C.mapW), y1 = Math.min(y0 + TILE, C.mapH);
      const z0 = (lo[k] - 8 - H.h0) * vex, z1 = (hi[k] + 8 - H.h0) * vex + 12 * exs;
      // frustum test: if all eight corners are outside one plane, the tile cannot be seen
      let out = 0x3f;
      for (let c = 0; c < 8; c++) {
        const x = (c & 1) ? x1 : x0, y = (c & 2) ? y1 : y0, z = (c & 4) ? z1 : z0;
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13], cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        let m = 0; if (cx < -cw) m |= 1; if (cx > cw) m |= 2; if (cy < -cw) m |= 4; if (cy > cw) m |= 8; if (cz < -cw) m |= 16; if (cz > cw) m |= 32;
        out &= m; if (!out) break;
      }
      T.cull[k] = out ? 1 : 0;
      // distance from the eye to the tile's box
      const dxx = Math.max(x0 - e[0], 0, e[0] - x1), dyy = Math.max(y0 - e[1], 0, e[1] - y1), dzz = Math.max(z0 - e[2], 0, e[2] - z1);
      const dist = Math.max(Math.hypot(dxx, dyy, dzz), 1), ppm = (Hh / 2) / (dist * TANH);          // pixels per metre at that distance
      T.dist[k] = dist; if (!out) T.order[cnt++] = k;
      const need = step0 * ppm;                                                                       // pixels per quad at the finest level
      T.lod[k] = need >= tgt ? 0 : clamp(Math.ceil(Math.log2(tgt / need)), 0, 3);
    }
    T.nVis = cnt; T.order.subarray(0, cnt).sort(byDistance);                                       // nearest first, so hidden land is never shaded (the depth test throws it out early)
  }
  const byDistance = (a, b) => T.dist[a] - T.dist[b];
  function lodStep(l) { const s = Math.max(0.5, +Creek.settings.get('mesh', 2) || 2), q0 = Math.max(4, Math.round(TILE / s)); return TILE / Math.max(2, q0 >> l); }
  const extrusionScale = () => 0.4 + 0.3 * V.vex;

  // ---------------------------------------------------------------- GL objects
  /** Make the programs and targets for this graphics context (again, if the context is a new one). */
  function ensureGL(gl) {
    if (L.glReady && L.gl === gl) return;
    if (L.gl && L.gl !== gl) freeGL();
    build(gl);
  }
  function build(gl) {
    const S = Creek.Shade, mk = (v, f, n) => new S.Program(gl, v, f, n);
    L.progs = {
      land: mk(VS_LAND(false), FS_LAND, '3d land'), water: mk(VS_LAND(true), FS_WATER, '3d water'), pick: mk(VS_LAND(false), FS_PICK, '3d pick'),
      wall: mk(VS_WALL, FS_WALL, '3d wall'), sky: mk(VS_SCREEN, FS_SKY, '3d sky'), rain: mk(VS_SCREEN, FS_RAIN, '3d rain'), copy: mk(VS_SCREEN, FS_COPY, '3d copy')
    };
    try {                                                           // a 1-pixel float target that the picking pass draws into
      L.pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, L.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      L.pickDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, L.pickDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
      L.pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, L.pickFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, L.pickTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, L.pickDepth);
      L.pickOK = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } catch (e) { L.pickOK = false; }
    L.glReady = true; L.gl = gl;
  }
  function freeGL() {
    const gl = L.gl; if (!gl || gl.isContextLost()) { L.progs = null; L.glReady = false; return; }
    if (L.progs) Object.keys(L.progs).forEach((k) => L.progs[k].dispose());
    if (L.pickTex) gl.deleteTexture(L.pickTex); if (L.pickDepth) gl.deleteRenderbuffer(L.pickDepth); if (L.pickFbo) gl.deleteFramebuffer(L.pickFbo);
    dropAA(gl);
    L.progs = null; L.pickTex = L.pickDepth = L.pickFbo = null; L.glReady = false;
  }

  // ---------------------------------------------------------------- smooth edges: draw into a multisampled target, then copy it to the screen
  function dropAA(gl) {
    const a = L.aa; if (!a) return;
    if (a.fbo) gl.deleteFramebuffer(a.fbo); if (a.rfbo) gl.deleteFramebuffer(a.rfbo); if (a.col) gl.deleteRenderbuffer(a.col); if (a.dep) gl.deleteRenderbuffer(a.dep); if (a.tex) gl.deleteTexture(a.tex);
    L.aa = null;
  }
  /** The target to draw the 3D picture into (null = draw straight to the screen, with no smoothing). */
  function aaTarget(gl, W, Hh) {
    if (!L.aaOK || !Creek.settings.get('view3d.smooth', true)) { if (L.aa) dropAA(gl); return null; }
    const a = L.aa;
    if (a && a.w === W && a.h === Hh) return a;
    dropAA(gl);
    try {
      const n = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0); if (n < 2) { L.aaOK = false; return null; }
      const col = gl.createRenderbuffer(), dep = gl.createRenderbuffer(), fbo = gl.createFramebuffer(), tex = gl.createTexture(), rfbo = gl.createFramebuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, col); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.RGBA8, W, Hh);
      gl.bindRenderbuffer(gl.RENDERBUFFER, dep); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.DEPTH_COMPONENT24, W, Hh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, col);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, dep);
      let ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, Hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);       // where the multisampled picture is resolved to
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rfbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      ok = ok && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      L.aa = { fbo, rfbo, col, dep, tex, w: W, h: Hh };
      if (!ok) { dropAA(gl); L.aaOK = false; return null; }
      return L.aa;
    } catch (e) { dropAA(gl); L.aaOK = false; return null; }
  }

  // ---------------------------------------------------------------- drawing
  const clearColor = new Float32Array(4);
  const ratio = (n, lod) => (T.lod[n] > lod ? (1 << (T.lod[n] - lod)) : 1);     // how many times coarser a neighbour is (1 = not coarser)
  function drawTiles(gl, prog, pickMode, farFirst) {
    const nx = T.nx, ny = T.ny, nv = T.nVis; let tris = 0, cnt = 0;
    const uTile = prog.u('u_tile'), uSnap = prog.u('u_snap'), uExt = prog.u('u_ext');
    for (let n = 0; n < nv; n++) {
      const k = T.order[farFirst ? nv - 1 - n : n], tx = k % nx, ty = (k - tx) / nx;
      const lod = T.lod[k], st = lodStep(lod), Q = Math.round(TILE / st);
      gl.uniform4f(uTile, tx * TILE, ty * TILE, st, Q);
      gl.uniform4f(uSnap, tx > 0 ? ratio(k - 1, lod) : 1, tx < nx - 1 ? ratio(k + 1, lod) : 1, ty > 0 ? ratio(k - nx, lod) : 1, ty < ny - 1 ? ratio(k + nx, lod) : 1);
      gl.uniform4f(uExt, lod === 0 ? 1 : lod === 1 ? 0.7 : lod === 2 ? 0.3 : 0, 0, 0, 0);
      const c = Q * (2 * Q + 4) - 2; gl.drawArrays(gl.TRIANGLE_STRIP, 0, c); tris += c - 2; cnt++;
    }
    if (!pickMode) { T.tris = tris; T.count = cnt; }
  }
  const WALLS = [[0, 0, 0, 1, C.mapH, -1, 0], [C.mapW, 0, 0, 1, C.mapH, 1, 0], [0, 0, 1, 0, C.mapW, 0, -1], [0, C.mapH, 1, 0, C.mapW, 0, 1]];

  /** Does any water lie on the land? True after a storm starts and until the ground is dried out (new season, reset, new land). */
  function waterExists() {
    const sim = game.sim; if (!sim) return false;
    if (game.storm) hasWater = true;
    if (sim.stepCount !== lastStep) { if (lastStep >= 0) hasWater = true; lastStep = sim.stepCount; }
    return hasWater;
  }

  function drawFrame(g, s) {
    const gl = g.gl; if (gl.isContextLost() || L.lost || !T.lod) return;
    ensureGL(gl);
    const W = s.width, Hh = s.height, vex = V.vex, exs = extrusionScale(), pr = L.progs, S = Creek.Shade;
    prep(W, Hh);
    const e = V.eye, wx = (s.extras && s.extras.weather) || { rain: 0, flash: 0 };
    const fog = 1 / (V.dist * 2.4 + 1600);
    const aa = aaTarget(gl, W, Hh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, aa ? aa.fbo : null); gl.viewport(0, 0, W, Hh);
    gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);

    // sky
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    S.bind(gl, pr.sky, s, s.views);
    gl.uniform4f(pr.sky.u('u_eye'), e[0], e[1], e[2], fog);
    gl.uniform4f(pr.sky.u('u_right'), V.right[0], V.right[1], V.right[2], 0); gl.uniform4f(pr.sky.u('u_up'), V.up[0], V.up[1], V.up[2], 0); gl.uniform4f(pr.sky.u('u_fwd'), V.fwd[0], V.fwd[1], V.fwd[2], 0);
    gl.uniform4f(pr.sky.u('u_lens3'), TANH * W / Hh, TANH, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // land
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    const land = pr.land; s.crown = 1; S.bind(gl, land, s, s.views);
    gl.uniformMatrix4fv(land.u('u_vp'), false, mat.vp); gl.uniform4f(land.u('u_view'), vex, exs, H.h0, 0); gl.uniform4f(land.u('u_eye'), e[0], e[1], e[2], fog);
    drawTiles(gl, land, false);

    // the cut-away sides
    const wall = pr.wall; S.bind(gl, wall, s, s.views);
    gl.uniformMatrix4fv(wall.u('u_vp'), false, mat.vp); gl.uniform4f(wall.u('u_view'), vex, exs, H.h0, 0); gl.uniform4f(wall.u('u_eye'), e[0], e[1], e[2], fog);
    const baseZ = (H.hMin - 8 - H.h0) * vex;
    for (let k = 0; k < 4; k++) {
      const w = WALLS[k], n = Math.max(2, Math.round(w[4] / 2));
      gl.uniform4f(wall.u('u_wallA'), w[0], w[1], w[2], w[3]); gl.uniform4f(wall.u('u_wallB'), w[4], n, baseZ, 0); gl.uniform4f(wall.u('u_wallN'), w[5], w[6], 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 2 * (n + 1));
    }

    // water: the same grid, lifted to the water surface, see-through
    if (g.lens === 0 && waterExists()) {
      const wt = pr.water; S.bind(gl, wt, s, s.views);
      gl.uniformMatrix4fv(wt.u('u_vp'), false, mat.vp); gl.uniform4f(wt.u('u_eye'), e[0], e[1], e[2], fog);
      const dist = V.dist, lift = 0.01 + (dist * dist) * 1.2e-7 * vex;                    // a hair above the ground, a little more when far away (depth gets coarse)
      gl.uniform4f(wt.u('u_view'), vex, exs, H.h0, lift);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -2);
      drawTiles(gl, wt, true, true);                                                    // see-through layers go far to near
      gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true);
    }

    // rain on the lens, with a little parallax when the camera turns
    if (wx.rain > 0.01) {
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      S.bind(gl, pr.rain, s, s.views);
      gl.uniform2f(pr.rain.u('u_res'), W, Hh);
      gl.uniform4f(pr.rain.u('u_par'), -V.az * 900 * (W / 1000), V.pitch * 500 * (W / 1000), 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    }
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    if (aa) {                                                       // resolve the smoothed picture, then copy it onto the screen
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, aa.fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, aa.rfbo);
      gl.blitFramebuffer(0, 0, W, Hh, 0, 0, W, Hh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const cp = pr.copy.use(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, aa.tex); gl.uniform1i(cp.u('u_src'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // ---------------------------------------------------------------- picking: where on the ranch is this screen pixel?
  function pickAt(px, py) {
    if (!P.active || !game || !game.ready) return null;
    const now = performance.now();
    if (lastPick.stamp === V.stamp && lastPick.px === px && lastPick.py === py && now - lastPick.t < 250) return lastPick.res;
    const cv = game.canvas, W = cv.width, Hh = cv.height; prep(W, Hh);
    let res = null;
    if (L.pickOK) { try { res = gpuPick(px, py, W, Hh); } catch (e) { console.warn('[creek] 3D picking on the graphics chip failed, using the slow way:', e); L.pickOK = false; } }
    if (!L.pickOK) res = cpuPick(px, py);
    lastPick.px = px; lastPick.py = py; lastPick.stamp = V.stamp; lastPick.t = now; lastPick.res = res;
    return res;
  }
  function gpuPick(px, py, W, Hh) {
    const gl = game.gl; if (gl.isContextLost() || L.lost) return null;
    ensureGL(gl); if (!L.progs) return null;
    const ndcx = 2 * (px * W / game.cw + 0.5) / W - 1, ndcy = 1 - 2 * (py * Hh / game.ch + 0.5) / Hh, m = mat.vp, q = mat.vpPick;
    q.set(m);
    for (let c = 0; c < 4; c++) { q[c * 4] = W * (m[c * 4] - ndcx * m[c * 4 + 3]); q[c * 4 + 1] = Hh * (m[c * 4 + 1] - ndcy * m[c * 4 + 3]); }   // squeeze the whole view down to this one pixel
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.pickFbo); gl.viewport(0, 0, 1, 1);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clearBufferfv(gl.COLOR, 0, clearColor); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    const pk = L.progs.pick; Creek.Shade.bindLand(gl, pk, game.sim.views());
    gl.uniformMatrix4fv(pk.u('u_vp'), false, q); gl.uniform4f(pk.u('u_view'), V.vex, extrusionScale(), H.h0, 0);
    drawTiles(gl, pk, true);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, L.pickBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.DEPTH_TEST);
    const b = L.pickBuf; return b[3] > 0.5 ? { x: b[0], y: b[1], h: b[2] } : null;
  }

  /** The ray under a screen pixel: {o: eye, d: unit direction} in world units (height already stretched). */
  function ray(px, py, out) {
    const nx = 2 * px / game.cw - 1, ny = 1 - 2 * py / game.ch, a = game.cw / game.ch, o = out || { o: [0, 0, 0], d: [0, 0, 0] };
    const d = o.d, f = V.fwd, r = V.right, u = V.up, kx = nx * a * TANH, ky = ny * TANH;
    d[0] = f[0] + kx * r[0] + ky * u[0]; d[1] = f[1] + kx * r[1] + ky * u[1]; d[2] = f[2] + kx * r[2] + ky * u[2];
    const l = Math.hypot(d[0], d[1], d[2]); d[0] /= l; d[1] /= l; d[2] /= l;
    o.o[0] = V.eye[0]; o.o[1] = V.eye[1]; o.o[2] = V.eye[2]; return o;
  }
  const rayTmp = { o: [0, 0, 0], d: [0, 0, 0] }, gp = { x: 0, y: 0 };
  /** Where the ray under a pixel meets the flat plane through the camera's target (for zooming and panning). */
  function groundPoint(px, py) {
    prep(game.canvas.width, game.canvas.height);
    const r = ray(px, py, rayTmp), z0 = (V.tz - H.h0) * V.vex;
    if (r.d[2] > -1e-4) return null;
    const t = (z0 - r.o[2]) / r.d[2]; gp.x = r.o[0] + r.d[0] * t; gp.y = r.o[1] + r.d[1] * t; return gp;
  }
  /** The slow way to pick: march along the ray and read heights from the engine one by one. Only used if the float target is missing; also handy as a cross-check in tests. */
  function cpuPick(px, py) {
    prep(game.canvas.width, game.canvas.height);
    const r = ray(px, py, { o: [0, 0, 0], d: [0, 0, 0] }), sim = game.sim, vex = V.vex;
    const surf = (t) => { const x = r.o[0] + r.d[0] * t, y = r.o[1] + r.d[1] * t; if (x < 0 || y < 0 || x > C.mapW || y > C.mapH) return { above: true, out: true }; const h = sim.probe(x, y).h; return { above: r.o[2] + r.d[2] * t > (h - H.h0) * vex, x, y, h }; };
    let t = V.near, prev = t, hit = null; const tMax = V.far, stepL = Math.max(2, V.dist / 60);
    for (; t < tMax; prev = t, t += stepL) { const s = surf(t); if (!s.above) { hit = s; break; } }
    if (!hit) return null;
    let a = prev, b = t;                                           // the ground is somewhere between a and b: halve the gap
    for (let k = 0; k < 14; k++) { const m = (a + b) / 2, s = surf(m); if (s.above) a = m; else { b = m; hit = s; } }
    return hit && hit.x != null ? { x: hit.x, y: hit.y, h: hit.h } : null;
  }

  const projOut = { x: 0, y: 0, visible: false };
  /** World metres -> CSS pixels. `visible` is false behind the camera or outside the picture. */
  function projectPoint(x, y) {
    if (!game || !H.T) return null;
    prep(game.canvas.width, game.canvas.height);
    const z = (heightAt(x, y) - H.h0) * V.vex + 2 * extrusionScale(), m = mat.vp;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cz = m[2] * x + m[6] * y + m[10] * z + m[14], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const o = projOut; o.visible = false;
    if (cw <= 1e-6) { o.x = -1e4; o.y = -1e4; return o; }
    const nx = cx / cw, ny = cy / cw;
    o.x = (nx * 0.5 + 0.5) * game.cw; o.y = (0.5 - ny * 0.5) * game.ch;
    o.visible = Math.abs(nx) <= 1.02 && Math.abs(ny) <= 1.02 && Math.abs(cz / cw) <= 1;
    return o;
  }

  // ---------------------------------------------------------------- moving the camera
  function touch() { V.stamp++; V.movedT = performance.now(); }
  function clampTarget() { V.tx = clamp(V.tx, 0, C.mapW); V.ty = clamp(V.ty, 0, C.mapH); }
  function zoomAt(px, py, factor) {
    const g = groundPoint(px, py), D = clamp(V.dist * factor, DMIN, DMAX), k = D / V.dist;
    if (g) { V.tx = g.x + (V.tx - g.x) * k; V.ty = g.y + (V.ty - g.y) * k; clampTarget(); }
    V.dist = D; touch(); return true;
  }
  function panBy(px, py, dx, dy) {                                 // the ground that was under (px-dx, py-dy) follows the finger to (px, py)
    const a = groundPoint(px - dx, py - dy); if (!a) return false;
    const ax = a.x, ay = a.y, b = groundPoint(px, py); if (!b) return false;
    V.tx += ax - b.x; V.ty += ay - b.y; clampTarget(); touch(); return true;
  }
  function turn(d) { V.azT += d; }
  function tilt(d) { V.pitchT = clamp(V.pitchT + d, 8 * DEG, 88 * DEG); }
  function wheel(e, px, py) {
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    return zoomAt(px, py, Math.exp(clamp(dy, -400, 400) * 0.0015));
  }
  function gesture(kind, d) {
    if (kind === 'orbit') { V.az += d.dx * 0.008; V.azT = V.az; V.pitch = clamp(V.pitch + d.dy * 0.005, 8 * DEG, 88 * DEG); V.pitchT = V.pitch; touch(); return true; }
    if (kind === 'pan') { panBy(d.x, d.y, d.dx, d.dy); return true; }
    if (kind === 'pinch') { zoomAt(d.cx, d.cy, 1 / Math.max(d.factor, 0.05)); return true; }
    if (kind === 'drag2') {
      panBy(d.cx, d.cy, d.dx, d.dy);
      if (d.rot) { V.az -= d.rot; V.azT = V.az; touch(); }       // twist the fingers clockwise and the land turns clockwise with them
      return true;
    }
    return false;
  }
  function focusOn(x, y, scale) {
    V.tx = x; V.ty = y; clampTarget(); if (scale) V.dist = clamp(distFromScale(scale), DMIN, DMAX);
    V.tz = V.tzGoal = heightAt(V.tx, V.ty); V.tzDirty = true; touch();
  }
  function resetView() {
    V.az = V.azT = 0; V.pitch = V.pitchT = 55 * DEG; setVex(3);
    V.tx = C.mapW / 2; V.ty = C.mapH / 2; V.dist = clamp(distFromScale(game.fitScale), DMIN, DMAX); V.tz = V.tzGoal = heightAt(V.tx, V.ty); V.tzDirty = true; touch();
  }
  function setVex(v) {
    V.vex = clamp(+v || 3, 1, 8); Creek.settings.set('view3d.vex', V.vex);
    if (elVex) { elVex.value = V.vex; elVexLabel.textContent = '×' + (+V.vex).toFixed(V.vex % 1 ? 1 : 0); }
    touch();
  }

  /** Every frame, before drawing: ease the camera, follow the ground height, keep the flat map's camera in step (so the contour spacing and brush follow the zoom). */
  function frame(dt) {
    if (!P.active) { if (panel && panel.visible) { panel.hide(); sync(); } return; }       // switched off by the game (a crash): tidy up
    if (!game.ready) return;
    const ka = 1 - Math.exp(-dt / 0.1);
    if (V.azT !== V.az) { const d = V.azT - V.az; V.az = Math.abs(d) < 1e-3 ? V.azT : V.az + d * ka; touch(); }
    if (V.pitchT !== V.pitch) { const d = V.pitchT - V.pitch; V.pitch = Math.abs(d) < 1e-3 ? V.pitchT : V.pitch + d * ka; touch(); }
    const now = performance.now();
    if (now - V.movedT < 250) { V.tzGoal = heightAt(V.tx, V.ty); V.tzDirty = true; }                 // moving: the starting land is close enough
    else if (V.tzDirty && now - V.tzT > 150) { V.tzDirty = false; V.tzT = now; try { V.tzGoal = game.sim.probe(V.tx, V.ty).h; } catch (e) { /* keep the estimate */ } }   // settled: ask the engine for the real height
    if (Math.abs(V.tzGoal - V.tz) > 1e-3) { V.tz += (V.tzGoal - V.tz) * (1 - Math.exp(-dt / 0.12)); V.stamp++; }
    if (elCompass && compassAz !== V.az) { compassAz = V.az; elCompass.firstChild.style.transform = 'rotate(' + (-V.az * 180 / Math.PI).toFixed(1) + 'deg)'; }
    game.cam.x = V.tx; game.cam.y = V.ty; game.cam.scale = clamp(scaleFromDist(V.dist), game.fitScale * 0.8, 30);
  }

  // ---------------------------------------------------------------- entering and leaving
  function enter() {
    if (P.active) return true;
    if (!game || !game.ready || !T.lod) return false;
    V.tx = game.cam.x; V.ty = game.cam.y; clampTarget(); V.dist = clamp(distFromScale(game.cam.scale), DMIN, DMAX);
    V.tz = V.tzGoal = heightAt(V.tx, V.ty); V.tzDirty = true; V.az = V.azT; V.pitch = V.pitchT;
    P.active = true; game.setViewProvider(P);                       // (also clears a "crashed" mark from an earlier try)
    if (panel) panel.show(); sync();
    touch();
    if (!shownHelp) { shownHelp = true; ui.toast('3D view: drag with two fingers (or the right mouse button) to look around. One finger still uses your tool.'); }
    return true;
  }
  function exit() {
    if (!P.active) return true;
    P.active = false;                                               // the flat map's camera was kept in step every frame, so it is already where we were looking
    if (game && game.clampCam) game.clampCam();
    if (L.gl && !L.gl.isContextLost()) dropAA(L.gl);               // the smoothing target is big: give it back
    if (panel) panel.hide(); sync();
    return true;
  }
  function toggle() { return P.active ? exit() : enter(); }
  function sync() { if (btn) btn.classList.toggle('on', P.active); }

  // ---------------------------------------------------------------- the module
  Creek.view3d = {
    isActive() { return !!P.active && game && game.provider() === P; }, enter, exit, toggle,
    // for tests and tools
    camera() { return { x: V.tx, y: V.ty, z: V.tz, az: V.az, pitch: V.pitch, dist: V.dist, vex: V.vex, eye: V.eye.slice(), near: V.near, far: V.far }; },
    setCamera(o) {
      if (o.x != null) V.tx = o.x; if (o.y != null) V.ty = o.y; clampTarget();
      if (o.az != null) V.az = V.azT = o.az * DEG; if (o.pitch != null) V.pitch = V.pitchT = clamp(o.pitch * DEG, 5 * DEG, 89 * DEG);
      if (o.dist != null) V.dist = clamp(o.dist, DMIN, DMAX); if (o.vex != null) setVex(o.vex);
      V.tz = V.tzGoal = heightAt(V.tx, V.ty); V.tzDirty = true; touch(); return true;
    },
    refreshHeight() { V.tzGoal = game.sim.probe(V.tx, V.ty).h; V.tz = V.tzGoal; touch(); return V.tz; },
    pick: (px, py) => pickAt(px, py), cpuPick, ray(px, py) { prep(game.canvas.width, game.canvas.height); const r = ray(px, py, { o: [0, 0, 0], d: [0, 0, 0] }); return { o: r.o, d: r.d, h0: H.h0, vex: V.vex }; },
    stats() { return { tiles: T.count, triangles: T.tris, hasWater, pickOK: L.pickOK, h0: H.h0, hMin: H.hMin, hMax: H.hMax }; },
    markWater(v) { hasWater = v !== false; }
  };

  Creek.registerModule({
    id: 'view3d',

    init(g, u) {
      game = g; ui = u;
      V.vex = clamp(+Creek.settings.get('view3d.vex', 3) || 3, 1, 8);
      ui.styles(`
.v3-row { display:flex; gap:6px; align-items:center; justify-content:space-between; }
.v3-b { flex:1 1 0; min-width:40px; height:40px; background:var(--paper2); border-radius:12px; font-size:18px; line-height:1; box-shadow:0 1px 3px rgba(59,42,26,.2); }
.v3-b:active { background:#fff6dc; outline:2px solid var(--gold); }
.v3-b.wide { flex:0 0 auto; padding:0 10px; font-size:13px; }
.v3-compass { flex:0 0 auto; position:relative; width:40px; height:40px; border-radius:50%; background:var(--paper2); box-shadow:0 1px 3px rgba(59,42,26,.2); }
.v3-compass i { position:absolute; left:50%; top:50%; width:0; height:0; margin:-15px 0 0 -6px; border:6px solid transparent; border-bottom:15px solid var(--clay); border-top:0; transform-origin:50% 100%; }
.v3-compass b { position:absolute; left:0; right:0; bottom:2px; font-size:10px; text-align:center; color:var(--ink2); }
.v3-row + .v3-row { margin-top:6px; }
.v3-slide { font-size:13px; }
.v3-slide input { flex:1; min-width:0; height:36px; accent-color:var(--moss); }
.v3-slide b { min-width:30px; text-align:right; font-variant-numeric:tabular-nums; }
`);
      panel = ui.panel({ id: 'view3d', title: '3D view', corner: 'br', closable: false });
      const guarded = (label, fn) => () => g._guard('3D button ' + label, fn);
      const row1 = document.createElement('div'); row1.className = 'v3-row';
      elCompass = document.createElement('button'); elCompass.className = 'v3-compass'; elCompass.title = 'North. Tap to face north.'; elCompass.setAttribute('aria-label', 'Face north');
      elCompass.innerHTML = '<i></i><b>N</b>'; elCompass.onclick = guarded('compass', () => { V.azT = Math.round(V.az / (2 * Math.PI)) * 2 * Math.PI; });
      row1.appendChild(elCompass);
      const mkb = (txt, label, fn, cls) => { const b = document.createElement('button'); b.className = 'v3-b' + (cls ? ' ' + cls : ''); b.textContent = txt; b.title = label; b.setAttribute('aria-label', label); b.onclick = guarded(label, fn); return b; };
      row1.appendChild(mkb('⟲', 'Turn left', () => turn(-15 * DEG))); row1.appendChild(mkb('⟳', 'Turn right', () => turn(15 * DEG)));
      row1.appendChild(mkb('⤒', 'Tilt up (look from higher)', () => tilt(8 * DEG))); row1.appendChild(mkb('⤓', 'Tilt down (look from lower)', () => tilt(-8 * DEG)));
      const row2 = document.createElement('div'); row2.className = 'v3-row v3-slide'; row2.title = 'Higher numbers make hills and banks look taller.';
      const lab = document.createElement('span'); lab.textContent = 'Heights';
      elVex = document.createElement('input'); elVex.type = 'range'; elVex.min = 1; elVex.max = 8; elVex.step = 0.5; elVex.value = V.vex; elVex.setAttribute('aria-label', 'Heights: how much taller the hills are drawn');
      elVexLabel = document.createElement('b'); elVexLabel.textContent = '×' + V.vex;
      elVex.oninput = () => g._guard('3D heights', () => setVex(+elVex.value));
      row2.appendChild(lab); row2.appendChild(elVex); row2.appendChild(elVexLabel); row2.appendChild(mkb('Reset view', 'Reset the view', resetView, 'wide'));
      panel.body.appendChild(row1); panel.body.appendChild(row2);

      btn = ui.addButton({ slot: 'view', id: 'view3d', label: '3D', title: 'Look at the ranch in 3D (G)', toggle: true, onClick: (on) => { if (on) { if (!enter()) sync(); } else exit(); } });
      const kb = (key, desc, fn) => Creek.shortcuts.add({ key, desc, repeat: key !== 'g', fn: () => { if (key !== 'g' && !P.active) return false; if (!game.ready) return false; fn(); } });
      kb('g', 'Flat map or 3D view', toggle);
      kb('q', 'Turn the 3D view left', () => turn(-12 * DEG)); kb('e', 'Turn the 3D view right', () => turn(12 * DEG));
      kb('r', 'Tilt the 3D view up (look from higher)', () => tilt(6 * DEG)); kb('f', 'Tilt the 3D view down (look from lower)', () => tilt(-6 * DEG));
      ui.addSetting({ id: 'mesh', label: '3D detail', help: 'Finer 3D land looks smoother but needs a stronger graphics chip.', type: 'choice', default: 2, options: [{ value: 4, label: 'Light' }, { value: 2, label: 'Normal' }, { value: 1, label: 'Fine' }] });
      Creek.settings.on('mesh', () => { V.stamp++; });

      g.setViewProvider(P);
      g.on('frame', (dt) => frame(dt));
      g.on('terrain', () => { V.tzDirty = true; V.tzT = 0; });
      g.on('stormStart', () => { hasWater = true; });
      const dry = () => { hasWater = false; lastStep = g.sim ? g.sim.stepCount : -1; };
      g.on('season', dry); g.on('reset', dry);
      // shift + left button drags the land around (the game itself only pans with the middle button)
      const cv = g.canvas;
      cv.addEventListener('pointerdown', (e) => {
        if (!P.active || e.pointerType !== 'mouse' || e.button !== 0 || !e.shiftKey || g.pointers.size) return;
        e.stopImmediatePropagation(); e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const r = cv.getBoundingClientRect(); shiftPan = { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top };
      });
      cv.addEventListener('pointermove', (e) => {
        if (!shiftPan || e.pointerId !== shiftPan.id) return;
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        g._guard('3D drag', () => panBy(x, y, x - shiftPan.x, y - shiftPan.y)); shiftPan.x = x; shiftPan.y = y;
      });
      const end = (e) => { if (shiftPan && e.pointerId === shiftPan.id) shiftPan = null; };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      // if the graphics context is lost, stop drawing until it is back (the game itself decides what to do about its own textures)
      cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); L.lost = true; L.glReady = false; L.progs = null; L.aa = null; L.pickFbo = L.pickTex = L.pickDepth = null; });
      cv.addEventListener('webglcontextrestored', () => { L.lost = false; L.glReady = false; V.stamp++; });
    },

    ready(g) {
      game = g; loadHeights(); hasWater = false; lastStep = g.sim ? g.sim.stepCount : -1;
      V.tx = clamp(V.tx, 0, C.mapW); V.ty = clamp(V.ty, 0, C.mapH); V.tz = V.tzGoal = heightAt(V.tx, V.ty); V.tzDirty = true; V.stamp++;
      lastPick.stamp = -1;
    }
  });
})();
