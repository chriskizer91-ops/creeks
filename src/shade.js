/* Shared drawing code: the GLSL that colours the land, the water, the contour lines and the markers, plus small helpers to
   compile it and feed it. The flat map (render.js) and the 3D view (mod-view3d.js) both build their shaders from these
   strings, so the two always look the same and cannot drift apart. Draws only: it reads the land and water textures
   (sim.views()) and never writes them.

   Texture units (the same everywhere):  0 T land · 1 W water · 2 M ground · 3 C record · 4 I start · 5 flow lines · 6 trace

   Creek.GLSL  the shader pieces:  head(defs) · core · shade · weather  (see the bottom of this file for how they fit together)
   Creek.Shade the helpers:        Program · bind(gl, prog, state, views) · season(state) · dispose(gl) */
(function () {
  const GL = Creek.GLSL = {};

  /** Version line, precision and the #defines a shader wants. defs: {extr: 1 = tree crowns and buildings are lifted off the ground (3D), water: 1 = water is drawn inside the land shader (flat map)}. */
  GL.head = function (defs) {
    defs = defs || {};
    return '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n' +
      '#define EXTR ' + (defs.extr ? 1 : 0) + '\n#define WATER ' + (defs.water ? 1 : 0) + '\n';
  };

  // ------------------------------------------------------------------------------------------------ uniforms + helpers used by every shader
  GL.core = `
uniform sampler2D u_T, u_W, u_M, u_C, u_I, u_flow, u_trace;   // land · water · ground · record · start · flow lines · trace (the last two are 1x1 dummies when unused)
uniform ivec2 u_n; uniform float u_dx, u_time, u_contour, u_hiH;
uniform vec2 u_mapSize; uniform int u_lens;
uniform vec4 u_brush;                              // x, y, radius (m), on
uniform vec4 u_hints[4]; uniform int u_nHints;
uniform vec4 u_tint;                               // rgb, amount
uniform vec4 u_seas;                               // how much summer, fall, winter, spring (they add up to 1)
uniform vec4 u_wx;                                 // rain 0..1, lightning 0..1, calm (1 = keep it still), pixel ratio
uniform vec4 u_ex;                                 // flow lines on, trace on, section on, farmstead known
uniform vec4 u_flowG, u_traceG, u_traceP, u_section;   // flow / trace grids (nx, ny, cell m), tapped point, section line
uniform vec4 u_rect[3];                            // house, barn, shed: x, y, width, height (m)
uniform vec4 u_farm;                               // gravel yard: x, y, half width, half height (m)
uniform vec4 u_ext;                                // 3D only: crown detail 0..1
uniform int u_hiField;                             // a field to light up (the Fields tool's hover), 0 = none

const vec3 SUN = vec3(-0.49062, -0.55393, 0.67262);   // sun from the north-west (x east, y south, z up)

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
vec2 hash2(vec2 p){ return vec2(hash(p), hash(p+vec2(17.3,5.1))); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ return noise(p)*0.57 + noise(p*2.07+5.3)*0.29 + noise(p*4.3+1.7)*0.14; }
ivec2 cl(ivec2 c){ return clamp(c, ivec2(0), u_n-ivec2(1)); }
ivec2 cellOf(vec2 w){ return cl(ivec2(floor(w/u_dx))); }
vec4 bil(sampler2D s, vec2 w){                      // smooth blend of the four nearest cells (the textures are not filtered)
  vec2 g = w/u_dx-0.5; ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  return mix(mix(texelFetch(s,cl(i),0), texelFetch(s,cl(i+ivec2(1,0)),0), f.x),
             mix(texelFetch(s,cl(i+ivec2(0,1)),0), texelFetch(s,cl(i+ivec2(1,1)),0), f.x), f.y);
}
float hAt(vec2 w){ return bil(u_T,w).r; }
float boxSd(vec2 p, vec2 b){ vec2 d = abs(p)-b; return length(max(d,vec2(0.)))+min(max(d.x,d.y),0.); }

// ---- things that stand on the ground. The flat map does not lift them; the 3D view does ("extrusion"), and its lighting uses the same function.
// The nearest tree crown, trees scattered on a loose 6 m grid with crowns 2.3 to 3.8 m across the radius.
// x: distance from the trunk / crown radius (under 1 = under that crown), y: that tree's own random number 0..1, zw: offset from its trunk (m)
vec4 crownN(vec2 w){
  vec2 g = w/6., i = floor(g), f = fract(g); vec4 best = vec4(9., 0., 0., 0.);
  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){
    vec2 o2 = vec2(x,y), id = i+o2;
    vec2 d = (f - o2 - 0.15 - 0.7*hash2(id))*6.;
    float q = length(d)/(2.3 + 1.5*hash(id+3.3));
    if (q < best.x) best = vec4(q, hash(id+7.7), d);
  }
  return best;
}
vec2 crownAt(vec2 w){ vec4 c = crownN(w); return vec2(0.5*c.x, c.y); }    // older form: distance in half-crowns, and the tree's random number
float canopyCell(ivec2 c){ vec4 t = texelFetch(u_T, cl(c), 0); int ci = int(t.b+.5); return t.a*(ci==3 ? 1. : ci==6 ? 0.3 : 0.); }
float canopyBlend(vec2 w){                          // how wooded the ground is around w (0..1), blended over four cells so woods have sloping edges
  vec2 g = w/u_dx-0.5; ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  return mix(mix(canopyCell(i),canopyCell(i+ivec2(1,0)),f.x), mix(canopyCell(i+ivec2(0,1)),canopyCell(i+ivec2(1,1)),f.x), f.y);
}
float treeExtrude(vec2 w){                          // tree and willow height in metres
  float e = canopyBlend(w);
  if (e < 0.01) return 0.;
  vec4 cr = crownN(w);
  float dome = sqrt(max(1.-cr.x*cr.x, 0.));           // round crowns
  return e*(5.+4.*cr.y)*mix(0.8, mix(0.68, 1., dome), u_ext.x);   // crowns rise out of a lower leafy mat
}
float buildingExtrude(vec2 w){                      // house, barn and shed: about 4 m, with a ridge
  float h = 0.;
  for (int k=0;k<3;k++){
    vec4 r = u_rect[k]; if (r.z <= 0.) continue;
    vec2 hs = 0.5*r.zw, q = w-(r.xy+hs); float sd = boxSd(q, hs); if (sd > 1.2) continue;
    float across = hs.x >= hs.y ? q.y/hs.y : q.x/hs.x;
    h = max(h, (4.+1.3*(1.-abs(clamp(across,-1.,1.))))*(1.-smoothstep(-0.8,0.8,sd)));
  }
  return h;
}
float extrudeAt(vec2 w){ return treeExtrude(w) + buildingExtrude(w); }
`;

  // ------------------------------------------------------------------------------------------------ land, water, overlays (fragment shaders only)
  GL.shade = `
float ring(vec2 w, vec2 c, float r, float px, float fp){ return 1.-smoothstep(0., px*fp, abs(length(w-c)-r)); }
int fieldAt(vec2 w){ return int(texelFetch(u_M, cellOf(w), 0).a+.5); }
int coverAt(vec2 w){ return int(texelFetch(u_T, cellOf(w), 0).b+.5); }
float g_curv; vec2 g_grad;                          // set by reliefNormal: how hollow the ground is (+ = a hollow, - = a crest) and its true slope (not stretched)

// ---- seasons. u_seas = how much summer, fall, winter, spring (they add up to 1). Colours are those of North Texas seen from the air:
// summer pasture goes olive and straw, prairie turns copper in fall, most trees drop their leaves in winter but live oak and cedar stay green.
vec3 seas(vec3 su, vec3 fa, vec3 wi, vec3 sp){ return su*u_seas.x + fa*u_seas.y + wi*u_seas.z + sp*u_seas.w; }

// ---- the land at w. Smooth things (height, rock, wetness, organic matter, soil kind) are blended between the four nearest cells.
// What grows there is put to a vote of the four cells, each kind with its own wobble, so the edge between a wood and a field is ragged and
// round instead of a staircase of cells; under a tree crown the vote leans to the trees, so a wood ends in whole crowns.
struct Land { vec4 t; vec4 m; float h, bed, moist, som, soil, gr; int k; };
float edgeJit(vec2 q, float kind){ return (noise(q*1.15 + kind*7.31)*0.62 + noise(q*2.9 + kind*3.17)*0.38 - 0.5)*0.62; }
Land landAt(vec2 w, out vec4 cr){
  vec2 g = w/u_dx-0.5; ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  vec4 T0 = texelFetch(u_T,cl(i),0), T1 = texelFetch(u_T,cl(i+ivec2(1,0)),0), T2 = texelFetch(u_T,cl(i+ivec2(0,1)),0), T3 = texelFetch(u_T,cl(i+ivec2(1,1)),0);
  vec4 M0 = texelFetch(u_M,cl(i),0), M1 = texelFetch(u_M,cl(i+ivec2(1,0)),0), M2 = texelFetch(u_M,cl(i+ivec2(0,1)),0), M3 = texelFetch(u_M,cl(i+ivec2(1,1)),0);
  vec4 wt = vec4((1.-f.x)*(1.-f.y), f.x*(1.-f.y), (1.-f.x)*f.y, f.x*f.y);
  Land L;
  L.h = dot(wt, vec4(T0.r,T1.r,T2.r,T3.r)); L.bed = dot(wt, vec4(T0.g,T1.g,T2.g,T3.g));
  L.moist = dot(wt, vec4(M0.r,M1.r,M2.r,M3.r)); L.soil = dot(wt, vec4(M0.g,M1.g,M2.g,M3.g)); L.som = dot(wt, vec4(M0.b,M1.b,M2.b,M3.b));
  vec4 cv = floor(vec4(T0.b,T1.b,T2.b,T3.b)+0.5);
  bvec4 tr = equal(cv, vec4(3.));
  cr = any(tr) ? crownN(w) : vec4(9.);
  int k = 0; vec4 sel = vec4(1.);
  if (!all(equal(cv, vec4(cv.x)))){
    vec4 s0 = vec4(equal(cv, vec4(cv.x))), s1 = vec4(equal(cv, vec4(cv.y))), s2 = vec4(equal(cv, vec4(cv.z))), s3 = vec4(equal(cv, vec4(cv.w)));
    vec2 q = w/u_dx;
    vec4 sc = vec4(dot(wt,s0), dot(wt,s1), dot(wt,s2), dot(wt,s3)) + vec4(edgeJit(q,cv.x), edgeJit(q,cv.y), edgeJit(q,cv.z), edgeJit(q,cv.w));
    sc += vec4(tr)*(0.5*(1.-smoothstep(0.75, 1.1, cr.x)) - 0.22);
    float best = sc.x;
    if (sc.y > best){ k = 1; best = sc.y; }
    if (sc.z > best){ k = 2; best = sc.z; }
    if (sc.w > best){ k = 3; }
    sel = k==0 ? s0 : k==1 ? s1 : k==2 ? s2 : s3;
  }
  L.t = k==0 ? T0 : k==1 ? T1 : k==2 ? T2 : T3;
  L.m = k==0 ? M0 : k==1 ? M1 : k==2 ? M2 : M3;
  L.k = int(k==0 ? cv.x : k==1 ? cv.y : k==2 ? cv.z : cv.w);
  L.gr = dot(wt*sel, vec4(T0.a,T1.a,T2.a,T3.a))/max(dot(wt,sel), 1e-4);
  return L;
}

// ---- ground and plants
vec3 soilColor(float soil, float moist, float som, float n){        // bare ground: Blackland clay is dark grey, sandy loam reddish tan; both darken when wet
  vec3 c = mix(vec3(0.46,0.42,0.37), vec3(0.74,0.60,0.44), smoothstep(0.2, 0.8, soil));
  c *= (1.-0.28*smoothstep(0.2, 0.7, som))*(0.92+0.16*n);
  return c*(1.-0.45*pow(clamp(moist, 0., 1.), 0.8));
}
vec3 subsoilColor(float soil){ return mix(vec3(0.49,0.45,0.39), vec3(0.76,0.59,0.41), smoothstep(0.2, 0.8, soil)); }
float cracks(vec2 w){                                // dried clay splits into plates about half a metre across: 0 on a crack
  vec2 g = w/0.55, i = floor(g), f = fract(g); float d1 = 9., d2 = 9.;
  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){ vec2 o2 = vec2(x,y); float d = length(f-o2-hash2(i+o2)); if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return d2-d1;
}
vec3 crownColor(float id){                           // live oak and cedar stay green; post oak, elm and pecan turn gold and rust, then go bare
  vec3 c = id < 0.3 ? vec3(0.20,0.27,0.13) : id < 0.5 ? vec3(0.15,0.22,0.14) : vec3(0.27,0.35,0.15);
  c *= 0.80 + 0.40*fract(id*13.7);
  if (id < 0.5) return c*(1.-0.10*u_seas.z);
  float f = fract(id*7.3);                           // post oak goes russet-brown, elm and pecan yellow, a few turn red; some are still green
  vec3 fall = f < 0.45 ? vec3(0.50,0.38,0.20) : f < 0.75 ? vec3(0.60,0.50,0.22) : f < 0.9 ? vec3(0.54,0.27,0.14) : c;
  return seas(c*0.96, mix(fall, c, 0.15)*(0.85+0.3*fract(id*5.1)), vec3(0.45,0.41,0.36), c*vec3(1.18,1.28,1.0));
}
vec3 willowColor(float id){
  vec3 c = vec3(0.42,0.53,0.21)*(0.88+0.24*fract(id*11.3));
  return seas(c, vec3(0.68,0.62,0.27), vec3(0.58,0.45,0.27), c*vec3(1.08,1.16,1.0));
}
vec3 pastureColor(float gr, vec2 w, float zk){
  vec3 full = seas(vec3(0.55,0.54,0.31), vec3(0.61,0.56,0.36), vec3(0.68,0.62,0.46), vec3(0.36,0.51,0.21));
  vec3 thin = seas(vec3(0.70,0.62,0.43), vec3(0.69,0.61,0.44), vec3(0.71,0.64,0.51), vec3(0.53,0.57,0.35));
  vec3 c = mix(thin, full, smoothstep(0.15, 0.85, gr));
  c *= 0.88 + 0.12*noise(w*0.21) + 0.10*(noise(w*0.9)-0.5)*zk;
  return mix(c, c*vec3(1.04,0.98,0.88), smoothstep(0.35, 0.75, fbm(w*0.03))*0.6);       // drier and greener patches across a field
}
vec3 prairieColor(float gr, vec2 w, float zk, float fp){
  vec3 c = seas(vec3(0.56,0.55,0.33), vec3(0.62,0.48,0.32), vec3(0.63,0.52,0.39), vec3(0.41,0.52,0.25));
  c *= (0.86+0.16*noise(w*0.17))*(1.+0.16*(noise(w*2.3)-0.5)*zk);                         // bunchgrass clumps
  c = mix(c, c*vec3(0.92,1.02,1.08), smoothstep(0.55, 0.8, noise(w*0.05))*0.4);           // bluish swaths of little bluestem
  float fk = (1.-smoothstep(0.07, 0.18, fp))*(u_seas.x + u_seas.w)*smoothstep(0.3, 0.8, gr);
  if (fk > 0.01){                                                                         // wildflowers when you look closely
    vec2 cell = floor(w*2.); float hh = hash(cell);
    if (hh > 0.92){
      float fl = 1.-smoothstep(0.10, 0.17, length(w*2.-cell-0.5-0.5*(hash2(cell)-0.5)));
      vec3 fc = u_seas.w > u_seas.x ? (hh > 0.96 ? vec3(0.30,0.40,0.88) : vec3(0.90,0.36,0.22)) : (hh > 0.97 ? vec3(0.62,0.38,0.70) : vec3(0.95,0.78,0.22));
      c = mix(c, fc, fl*fk);
    }
  }
  return c;
}

// ---- the farmstead: roofs with a ridge, crisp edges, and a shadow on the ground beside them
vec4 buildingAt(vec2 w, float fp, float zk){
  vec4 res = vec4(0.);
  for (int k=0;k<3;k++){
    vec4 r = u_rect[k]; if (r.z <= 0.) continue;
    vec2 hs = 0.5*r.zw, q = w-(r.xy+hs); float sd = boxSd(q, hs); if (sd > fp+0.5) continue;
    bool alongX = hs.x >= hs.y;
    float across = alongX ? q.y/hs.y : q.x/hs.x, rd = abs(across)*(alongX ? hs.y : hs.x);          // rd = metres from the ridge
    vec3 base = k==0 ? vec3(0.55,0.33,0.26) : k==1 ? vec3(0.56,0.22,0.17) : vec3(0.66,0.68,0.70);
    vec2 slope = alongX ? vec2(0., across < 0. ? -1. : 1.) : vec2(across < 0. ? -1. : 1., 0.);
    float ls = clamp(dot(normalize(vec3(-slope*0.6, 1.)), SUN)/SUN.z, 0.55, 1.22);                    // the plane facing the sun is brighter
    vec3 c = base*ls;
    c = mix(c, base*1.25+0.05, (1.-smoothstep(0.12, 0.4+fp*0.5, rd))*0.8);                            // ridge cap
    c *= 1.-0.30*smoothstep(-0.7, -0.15, sd);                                                         // dark under the eaves
    c *= 1.-0.07*zk*sin(dot(q, alongX ? vec2(0.,1.) : vec2(1.,0.))*(k==1 ? 7. : 4.) + 1.);           // panel seams
    res = vec4(c, 1.-smoothstep(-0.5*fp, 0.5*fp+0.02, sd));
  }
  return res;
}
float buildingShadow(vec2 w){
  float s = 0.;
  for (int k=0;k<3;k++){
    vec4 r = u_rect[k]; if (r.z <= 0.) continue;
    vec2 hs = 0.5*r.zw; s = max(s, 1.-smoothstep(-0.6, 1.4, boxSd(w-(r.xy+hs)-vec2(4.2,4.8), hs)));
  }
  return s;
}

// ---- water: colour (lit) and how much of it shows. Clear creek water is jade green and lets the bed show through until it gets deep
// (light fades exponentially with depth); muddy flood water is tan and hides the ground within a few centimetres. A thin sheet of runoff
// only makes the ground look wet and glint. Ripples travel with the current, and white water appears where the flow outruns its own
// surface waves (Froude number above about 1), as it does over a riffle, a ledge or a dam. Several taps when zoomed out keep thin creeks visible.
vec4 waterLayer(vec2 w, float fp, float lit, float zk){
  vec4 wd = bil(u_W,w); float d = wd.r;
  if (fp > u_dx*0.8){ float k = 0.5*fp; d = max(max(d, bil(u_W,w+vec2(k,0.)).r), max(bil(u_W,w-vec2(k,0.)).r, max(bil(u_W,w+vec2(0.,k)).r, bil(u_W,w-vec2(0.,k)).r))); }
  if (d <= 0.002) return vec4(0.);
  vec2 v = wd.ba; float sp = length(v);
  float conc = clamp(wd.g/max(wd.r,0.003), 0., 0.3), mud = smoothstep(0.004, 0.05, conc);
  mud = max(mud, max(0.6*smoothstep(0.15, 0.8, d)*smoothstep(0.4, 1.4, sp), 0.8*smoothstep(0.03, 0.4, d)));   // flood water is never clear: fine clay stays up long after the sand has dropped
  vec3 deep = mix(vec3(0.11,0.25,0.21), vec3(0.05,0.15,0.16), smoothstep(0.5, 3., d));
  vec3 brown = mix(vec3(0.60,0.48,0.32), vec3(0.46,0.35,0.23), smoothstep(0.3, 3., d));
  vec3 body = mix(deep, brown, mud);
  float a = 1.-exp(-mix(3.2, 30., mud)*d);                           // how much of the bed is hidden
  vec3 col = mix(vec3(0.10,0.09,0.07), body, clamp(smoothstep(0.02, 0.35, d) + mud*smoothstep(0.003, 0.02, d), 0., 1.));
  float alpha = max(0.26*smoothstep(0.002, 0.008, d), a);
  col = mix(col, vec3(0.62,0.70,0.76), 0.10*smoothstep(0.02, 0.3, d));           // a little sky in the surface
  if (zk > 0.02){
    float calm = 1.-u_wx.z, ph = fract(u_time*0.3*calm), wA = 1.-abs(2.*ph-1.);   // two layers that drift with the flow, crossfaded so they never stretch
    vec2 pA = (w - v*ph*3.)*0.8, pB = (w - v*fract(ph+0.5)*3.)*0.8 + 7.3;
    const float e = 0.35;
    float r0 = noise(pA)*wA + noise(pB)*(1.-wA);
    float rx = noise(pA+vec2(e,0.))*wA + noise(pB+vec2(e,0.))*(1.-wA), ry = noise(pA+vec2(0.,e))*wA + noise(pB+vec2(0.,e))*(1.-wA);
    float amp = (0.30 + 0.35*min(sp, 3.) + 0.7*u_wx.x)*smoothstep(0.004, 0.04, d);
    vec3 N = normalize(vec3(-(rx-r0)/e*amp, -(ry-r0)/e*amp, 1.));
    float glint = pow(max(dot(N, normalize(SUN + vec3(0.,0.,1.))), 0.), 120.)*(1.-0.85*u_wx.x)*zk*smoothstep(0.03, 0.3, d);
    col *= 1.+0.16*(r0-0.5)*zk*smoothstep(0.02, 0.2, d);
    col += vec3(1.,0.95,0.84)*glint*0.35; alpha = max(alpha, glint*0.3);
    // white water: streaks drawn out along the current where the flow is shooting
    float Fr = sp/sqrt(9.81*max(d, 0.02));
    vec2 vd = sp > 1e-3 ? v/sp : vec2(1.,0.), vn = vec2(-vd.y, vd.x);
    float st = noise(vec2(dot(pA,vd)*0.25, dot(pA,vn)*1.2))*wA + noise(vec2(dot(pB,vd)*0.25, dot(pB,vn)*1.2))*(1.-wA);
    float foam = smoothstep(0.75, 1.5, Fr)*smoothstep(0.5, 1.6, sp)*smoothstep(0.06, 0.2, d)*smoothstep(0.45, 0.75, st);
    float shore = (1.-smoothstep(0.008,0.05,d))*smoothstep(0.003,0.014,d);       // a lace of foam where deeper water laps the land
    if (shore > 0.01){
      float k = max(2.5, 1.5*fp), dn = max(max(bil(u_W,w+vec2(k,0.)).r, bil(u_W,w-vec2(k,0.)).r), max(bil(u_W,w+vec2(0.,k)).r, bil(u_W,w-vec2(0.,k)).r));
      shore *= smoothstep(0.10, 0.4, dn);
      foam = max(foam, shore*smoothstep(0.35,0.7,noise(w*1.7+vec2(u_time*0.12*calm,0.)))*0.6);
    }
    foam *= zk;
    col = mix(col, mix(vec3(0.95,0.94,0.90), vec3(0.86,0.80,0.68), mud), foam*0.65);
    alpha = max(alpha, foam*0.65);
  }
  return vec4(col*mix(1., lit, 0.25), alpha);
}

// ---- extras handed over by other modules: blue flow lines, the trace, the cross-section line
float flowAt(vec2 w){
  vec2 g = w/u_flowG.z-0.5; ivec2 i = ivec2(floor(g)), mx = ivec2(u_flowG.xy)-ivec2(1); vec2 f = fract(g);
  float a = texelFetch(u_flow,clamp(i,ivec2(0),mx),0).r, b = texelFetch(u_flow,clamp(i+ivec2(1,0),ivec2(0),mx),0).r;
  float c = texelFetch(u_flow,clamp(i+ivec2(0,1),ivec2(0),mx),0).r, d = texelFetch(u_flow,clamp(i+ivec2(1,1),ivec2(0),mx),0).r;
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
vec2 traceAt(vec2 w){                               // x: smooth "drains to the tapped point" 0..1,  y: smooth "downhill path" 0..1
  vec2 g = w/u_traceG.z-0.5; ivec2 i = ivec2(floor(g)), mx = ivec2(u_traceG.xy)-ivec2(1); vec2 f = fract(g);
  vec2 acc = vec2(0.);
  for (int k=0;k<4;k++){
    float v = texelFetch(u_trace, clamp(i+ivec2(k&1, k>>1), ivec2(0), mx), 0).r;
    float wt = ((k&1)==0 ? 1.-f.x : f.x)*((k>>1)==0 ? 1.-f.y : f.y);
    acc += wt*vec2(step(0.75,v), step(0.25,v)*(1.-step(0.75,v)));
  }
  return acc;
}

// ---- storm light: cool grey-blue, slow cloud shadows, and a lightning flash that lifts everything
vec3 weatherGrade(vec3 col, vec2 w){
  float rain = u_wx.x, fl = u_wx.y;
  if (rain > 0.002){
    float cs = fbm(w*0.0021 + vec2(u_time*0.010*(1.-u_wx.z), u_time*0.005*(1.-u_wx.z)));
    float g = dot(col, vec3(0.30,0.59,0.11));
    col = mix(col, vec3(g)*vec3(0.80,0.88,1.0), 0.24*rain);
    col *= mix(1., 0.86, rain)*(1.-0.10*rain*smoothstep(0.38,0.78,cs));
  }
  return mix(col, vec3(0.93,0.95,1.0), fl*0.34) + col*fl*0.22;
}
float rainLayer(vec2 p, float cw, float speed, float seed, float dens){
  p.x += p.y*0.16;
  float cx = floor(p.x/cw), fx = fract(p.x/cw), h = hash(vec2(cx, seed));
  if (h > dens) return 0.;
  float h2 = hash(vec2(cx, seed+3.1)), len = 0.10+0.12*h2;
  float fy = fract(p.y/(cw*11.) - u_time*speed*(0.8+0.4*h2) + h2*17.);
  return (1.-smoothstep(0.04,0.13,abs(fx-0.5)))*smoothstep(0.,len,fy)*(1.-step(len,fy));
}
vec4 rainOverlay(vec2 fc, vec2 par){                // screen-space streaks, three depths. par = how far the camera has turned (3D parallax)
  float rain = u_wx.x*(1.-u_wx.z); if (rain < 0.01) return vec4(0.);
  float s = max(u_wx.w, 1.);
  float a = rainLayer(fc+par, 10.*s, 3.0, 1.3, 0.62*rain)*0.42 + rainLayer(fc+par*0.6, 6.5*s, 2.2, 4.7, 0.74*rain)*0.32 + rainLayer(fc+par*0.3, 4.2*s, 1.6, 8.1, 0.86*rain)*0.24;
  return vec4(0.80,0.86,0.96, clamp(a,0.,0.75));
}

// ---- surface normal for the sun. kg stretches the ground heights (so gentle slopes read), ke the extrusions (3D only).
// Also leaves the true slope in g_grad and the hollowness in g_curv (from a wider ring, so valleys read as soft shade, not noise).
vec3 reliefNormal(vec2 w, float e, float kg, float ke, float ee){
  float h0 = hAt(w), hx1 = hAt(w+vec2(e,0.)), hx0 = hAt(w-vec2(e,0.)), hy1 = hAt(w+vec2(0.,e)), hy0 = hAt(w-vec2(0.,e));
  vec2 g = vec2(hx1-hx0, hy1-hy0)/(2.*e);
  float E = max(2.5*e, 4.);
  g_curv = (hAt(w+vec2(E,0.)) + hAt(w-vec2(E,0.)) + hAt(w+vec2(0.,E)) + hAt(w-vec2(0.,E)) - 4.*h0)/(E*E);
  g_grad = g; g *= kg;
#if EXTR
  if (ke > 0.) g += vec2(extrudeAt(w+vec2(ee,0.))-extrudeAt(w-vec2(ee,0.)), extrudeAt(w+vec2(0.,ee))-extrudeAt(w-vec2(0.,ee)))/(2.*ee)*ke;
#endif
  return normalize(vec3(-g, 1.));
}

// ---- everything the land looks like at world point w (colour, lens, field edges, contour lines, markers). nrm = surface normal.
// fp = metres per pixel at this spot. With WATER on, the water is painted in as well (flat map); the 3D view draws it as its own layer.
vec3 shadeLand(vec2 w, float fp, vec3 nrm, out float litOut){
  float zk = smoothstep(0.7, 3.2, 1./fp);                            // fine detail fades in as you zoom in
  float kd = 1.-smoothstep(0.55, 1.9, fp);                          // tree crowns are drawn one by one once they are a few pixels across
  float nl = noise(w*0.011), nm = noise(w*0.07+3.), nh = noise(w*0.7)*zk + 0.5*(1.-zk);
  vec2 wq = w + (vec2(noise(w*(0.9/u_dx)+3.1), noise(w*(0.9/u_dx)+11.7))-0.5)*(0.9*u_dx);   // a wobbled spot for the edge tests (hedges, roads, ponds)
  vec4 cr; Land L = landAt(w, cr);
  int ci = L.k; float gr = L.gr, moist = L.moist, som = L.som; int fid = int(L.m.a+.5);
  float h = L.h, thick = L.h-L.bed;
#if EXTR
  { float cb = canopyBlend(w); if (cb > 0.2 && ci != 3 && ci != 6){ ci = 3; gr = max(gr, cb); if (cr.x > 8.) cr = crownN(w); } }   // where the ground is lifted into a wood, it looks like wood
#endif
  bool farm = u_ex.w > 0.5;
  vec4 bld = farm ? buildingAt(w, fp, zk) : vec4(0.);
  float sl = length(g_grad), h0 = bil(u_I,w).r, dlt = h - h0;

  // --- ground colour
  vec3 dirt = soilColor(L.soil, moist, som, nm);
  if (zk > 0.3 && L.soil < 0.5 && moist < 0.3){                     // dry black clay cracks into plates
    float ck = (1.-smoothstep(0.015, 0.05+0.6*fp, cracks(w)))*(1.-smoothstep(0.04, 0.1, fp));
    dirt *= 1.-0.35*ck*(1.-L.soil*2.)*smoothstep(0.3, 0.1, moist)*smoothstep(0.3, 0.8, zk);
  }
  vec3 lime = vec3(0.86,0.83,0.73)*(0.92+0.1*nm);
  vec3 col = dirt;
  float treeK = 0., crownCov = 0.;                                   // treeK 1 = a tree crown or the floor under one (lit by its own sun); crownCov = how much crown is in this pixel
  if (ci==1){
    col = pastureColor(gr, w, zk);
    float dens = 0.35+0.85*gr, nb = noise(w*0.19)*0.6 + (noise(w*0.75)*zk + 0.5*(1.-zk))*0.4;
    float bare = mix(smoothstep(-0.08, 0.08, nb - dens), clamp((0.74-dens)*1.6, 0., 1.), smoothstep(0.6, 2.5, fp));   // far away: just how much shows
    col = mix(col, mix(dirt, col, 0.25), 0.85*bare);                  // thin grass lets bare patches show, with dead grass in them
    if (sl > 0.035 && zk > 0.15){                                     // cattle trails follow the contour on grazed slopes
      float tq = h/0.55 + 0.7*noise(w*0.05), fw = max(fwidth(tq), 1e-4), wd = 0.35*sl/0.55;
      float ln = (1.-smoothstep(wd, wd+fw, abs(fract(tq+0.5)-0.5)))*smoothstep(0.3, 1.2, wd/fw)*step(0.42, noise(w*0.07+9.1));
      col = mix(col, dirt*1.08, ln*0.55*(1.-smoothstep(0.35, 0.8, gr))*smoothstep(0.035, 0.08, sl)*zk);
    }
  }
  else if (ci==2){
    col = mix(dirt, prairieColor(gr, w, zk, fp), 0.3+0.7*smoothstep(0.03, 0.5, gr + 0.25*(nh-0.5)));
  }
  else if (ci==3 || ci==6){
    bool wil = ci==6;
    vec4 c2 = wil ? crownN(w*1.8 + 31.7) : (cr.x > 8. ? crownN(w) : cr);
    float size = wil ? mix(0.22, 1., smoothstep(0.05, 0.9, gr)) : mix(0.28, 1., smoothstep(0.05, 0.8, gr));
    float rad = (wil ? 1.7 : 3.0)*size, q = c2.x/size, aw = max(1.4*fp/rad, 0.05);
    float inC = 1.-smoothstep(1.-aw, 1.+aw, q);
    bool dec = wil || c2.y >= 0.5;
    if (dec) inC *= 1.-u_seas.z*(0.45 + 0.2*noise(w*5.3));                            // bare winter crowns are a see-through tangle of twigs
    vec3 cc = wil ? willowColor(c2.y) : crownColor(c2.y);
    vec2 dir = c2.zw/max(length(c2.zw), 1e-4); float qq = min(q, 1.);
    vec3 n = normalize(vec3(dir*qq*0.9 + (vec2(noise(w*1.6), noise(w*1.6+5.2))-0.5)*0.8*zk, sqrt(1.-qq*qq)+0.15));
    vec3 crownLit = cc*mix(0.50 + 0.80*max(dot(n, SUN), 0.), 0.85 + 0.25*max(dot(n, SUN), 0.), dec ? u_seas.z : 0.)*(0.9+0.2*noise(w*3.1)*zk);   // leafless crowns barely shade themselves
    vec3 floorC = mix(mix(pastureColor(0.5, w, zk), dirt, 0.4), vec3(0.15,0.16,0.09), smoothstep(0.3, 0.9, gr));   // grass under young trees, deep shade in a wood
    vec4 c3 = wil ? crownN((w-vec2(1.6,1.8))*1.8 + 31.7) : crownN(w-vec2(3.3,3.7));       // the crown to the north-west throws its shadow here
    floorC *= 1.-0.45*(1.-smoothstep(0.85, 1.1, c3.x/size));
    vec3 near = mix(floorC, crownLit, inC);
    vec3 far = mix(floorC, cc*(0.82+0.15*nm), 0.80*(dec ? 1.-0.45*u_seas.z : 1.)*smoothstep(0.05, 0.6, gr+0.2));
    col = mix(far, near, kd); treeK = 1.;
    crownCov = mix(0.8*smoothstep(0.05, 0.6, gr+0.2), inC, kd)*(dec ? 1.-0.45*u_seas.z : 1.);
  }
  else if (ci==4){ col = farm ? vec3(0.78,0.73,0.62)*(0.94+0.1*nm) : (hash(floor(w/20.))>0.5 ? vec3(0.66,0.38,0.29) : vec3(0.62,0.64,0.66)) * (0.92+0.08*sin(w.y*2.)); }
  else if (ci==5){ col = vec3(0.80,0.75,0.65)*(0.93+0.08*nm)*(1.-0.06*(noise(w*2.6)-0.5)*zk); }        // caliche ranch road
  else if (ci==7 || ci==9){                                          // crops: rows one way per field, wide machine passes, soil or stubble between
    float an = (hash(vec2(float(fid),1.)) > 0.5 ? 1.5708 : 0.) + 0.06*(hash(vec2(float(fid),2.))-0.5);
    vec2 rd = vec2(cos(an), sin(an)); float s = dot(w, rd);
    float pass = 0.5+0.5*sin(s*6.2832/(ci==9 ? 12. : 9.) + 2.*noise(vec2(s*0.01, float(fid))));
    float row = 0.5+0.5*cos(s*6.2832/0.76), rowK = 1.-smoothstep(0.07, 0.2, fp);
    vec3 tilled = dirt*(0.96 + 0.10*row*rowK);
    if (ci==9){
      float can = smoothstep(0.08, 0.95, gr);
      vec3 green = seas(vec3(0.42,0.50,0.23), vec3(0.60,0.55,0.33), vec3(0.58,0.53,0.38), vec3(0.36,0.50,0.20));
      vec3 stub = mix(tilled, vec3(0.70,0.63,0.46)*(0.92+0.1*nm), 0.55*u_seas.y);        // after harvest: straw stubble
      float cov = mix(can, smoothstep(1.-can-0.15, 1.-can+0.15, row), rowK);
      col = mix(stub, green*(0.92+0.12*nl), cov);
    } else {
      float can = 0.35 + 0.65*gr;
      vec3 green = seas(vec3(0.42,0.50,0.25), vec3(0.40,0.51,0.24), vec3(0.36,0.48,0.24), vec3(0.34,0.50,0.20));
      vec3 resid = mix(dirt, vec3(0.70,0.62,0.45)*(0.92+0.1*nm), 0.7);                   // last crop's straw left on top
      col = mix(resid, green*(0.92+0.12*nl), smoothstep(-0.12, 0.12, can - (noise(w*1.7)*zk + 0.5*(1.-zk))));
    }
    col *= 0.95 + 0.08*pass;
  }
  else if (ci==8){                                                   // check dam: posts, rock and woven brush
    float st = noise(w*vec2(3.1, 0.9))*0.6 + noise(w*5.7)*0.4;
    col = mix(vec3(0.36,0.26,0.16), vec3(0.58,0.55,0.50), smoothstep(0.45, 0.7, st))*(0.85+0.3*nm);
  }
  else if (ci==10){ col = mix(vec3(0.33,0.31,0.26), vec3(0.42,0.40,0.33), nm)*(1.-0.3*moist); if (zk > 0.3) col *= 1.-0.25*(1.-smoothstep(0.015, 0.06, cracks(w*0.8)))*(1.-moist); }   // pond bed: mud, cracked when dry
  else if (ci==0){
    float flat_ = 1.-smoothstep(0.12, 0.3, sl);
    if (zk > 0.4) col *= 0.94 + 0.12*noise(w*4.1);                   // clods and pebbles
    col = mix(col, pastureColor(0.2, w, zk), flat_*(0.35*smoothstep(0.5, 0.8, noise(w*0.8+4.4))*zk + 0.45*smoothstep(0.7, 2.5, fp)));   // weedy tufts; far away a bare patch melts into the grass around it
  }

  if (ci!=4 && ci!=5 && ci!=8 && ci!=10){
    float face = smoothstep(0.5, 1.1, sl)*(ci==0 ? 1. : 0.5*(1.-gr))*(1.-treeK);   // a raw cut bank: pale subsoil in layers
    if (face > 0.){
      vec3 sub = subsoilColor(L.soil)*(0.88+0.12*(0.5+0.5*sin(h*13.+3.*noise(w*0.4))))*(1.-0.3*moist);
      col = mix(col, sub, face*0.7);
    }
    float rock = 1.-smoothstep(0.015, 0.08, thick);                  // bare limestone, with ledges that follow the height and cracks between blocks
    if (rock > 0.){
      vec3 lm = lime;
      if (zk > 0.1){ float led = 0.5+0.5*sin(h*9.+5.*noise(w*0.25)); lm *= 0.93+0.09*led; lm *= 1.-0.12*step(0.9, noise(w*vec2(0.8,2.4)))*zk; lm *= 1.+0.06*(noise(w*2.3)-0.5)*zk; lm = mix(lm, vec3(0.64,0.63,0.58), 0.35*smoothstep(0.55,0.8,noise(w*0.6))); }
      col = mix(col, lm*(1.-0.25*moist), rock);
    }
    float dep = smoothstep(0.015, 0.25, dlt)*(1.-0.75*treeK);        // fresh mud and sand the water left behind
    if (dep > 0.){
      vec3 silt = mix(vec3(0.63,0.59,0.50), vec3(0.78,0.69,0.54), L.soil)*(0.93+0.1*nm)*(1.+0.08*(noise(w*3.7)-0.5)*zk)*(1.-0.35*moist);
      col = mix(col, silt, dep*0.85);
    }
    float scour = smoothstep(0.05, 0.4, -dlt)*float(ci!=0)*(1.-treeK);  // scoured: the subsoil shows through the plants
    if (scour > 0.) col = mix(col, subsoilColor(L.soil)*(1.-0.3*moist), scour*0.6);
  }
  if (zk > 0.1){
    if (ci==10){                                                     // pond shore: a pale muddy rim
      float edge = 0.;
      edge = max(edge, float(coverAt(wq+vec2(1.8,0.))!=10)); edge = max(edge, float(coverAt(wq-vec2(1.8,0.))!=10));
      edge = max(edge, float(coverAt(wq+vec2(0.,1.8))!=10)); edge = max(edge, float(coverAt(wq-vec2(0.,1.8))!=10));
      col = mix(col, vec3(0.55,0.51,0.42), 0.65*edge*zk);
    } else if (ci==5){                                               // road edges: a darker shoulder where the road stops
      float edge = 0.;
      edge = max(edge, float(coverAt(wq+vec2(1.5,0.))!=5)); edge = max(edge, float(coverAt(wq-vec2(1.5,0.))!=5));
      edge = max(edge, float(coverAt(wq+vec2(0.,1.5))!=5)); edge = max(edge, float(coverAt(wq-vec2(0.,1.5))!=5));
      col *= 1.-0.16*edge*zk;
    }
  }
  if (farm){                                                         // gravel yard around the buildings, with a firm edge
    float ysd = boxSd(w-u_farm.xy, u_farm.zw);
    float pad = (1.-smoothstep(-1.5, 1.5, ysd))*(ci==5||ci==1||ci==0||ci==4 ? 1. : 0.);
    vec3 gv = vec3(0.78,0.72,0.60)*(0.94+0.10*noise(w*0.6))*(0.98+0.035*hash(floor(w*3.)*(0.5+zk)));
    col = mix(col, gv, pad*0.85);
    col *= 1.-0.12*(1.-smoothstep(0., 0.5+fp, abs(ysd+0.3)))*zk;
  }
  // hedgerows and fences along the field boundaries (zoomed in only). A ring of samples tells how far the boundary is, and which field is on the other side.
  if (zk > 0.3 && fid != 0 && u_lens==0){
    const float R = 2.2;
    int q0 = fieldAt(wq+vec2(R,0.)), q1 = fieldAt(wq+vec2(0.,R)), q2 = fieldAt(wq-vec2(R,0.)), q3 = fieldAt(wq-vec2(0.,R));
    if (q0!=fid || q1!=fid || q2!=fid || q3!=fid){
      int fo = 0; float cnt = 0.;
      for (int k=0;k<16;k++){ float a = float(k)*0.3926991; int q = fieldAt(wq+vec2(cos(a),sin(a))*R); if (q!=fid && q!=0){ cnt += 1.; fo = q; } }
      if (fo != 0){
        float dd = R*cos(3.14159265*min(cnt/16., 0.5));                // metres to the boundary
        float pr = hash(vec2(float(min(fid,fo)), float(max(fid,fo))));
        if (pr > 0.62){                                                // a hedgerow: ragged dark green band
          float band = (1.-smoothstep(0.5, 1.5+0.7*noise(wq*0.45), dd))*smoothstep(0.25,0.55,noise(w*1.3)+0.3);
          col = mix(col, seas(vec3(0.17,0.26,0.12), vec3(0.42,0.32,0.14), vec3(0.30,0.27,0.21), vec3(0.20,0.34,0.13))*(0.8+0.5*noise(w*3.)), band*0.85*zk);
        } else {                                                       // a wire fence: thin line with posts, and a strip of taller grass the mower missed
          float line = 1.-smoothstep(0.1, 0.32+0.4*fp, dd);
          float post = line*step(fract((wq.x+wq.y*1.3)/6.), 0.09);
          col = mix(col, col*vec3(0.86,0.90,0.78), (1.-smoothstep(0.3, 1.1, dd))*0.6*zk);
          col = mix(col, vec3(0.26,0.19,0.12), max(line*0.5, post*0.9)*zk);
        }
      }
    }
  }

  // --- light: the sun from the north-west on the stretched relief, soft shade in hollows, and the shadows trees and buildings throw
  float sh = dot(nrm,SUN)/SUN.z;
  float lit = clamp(mix(1., sh, 0.85), 0.45, 1.38);
  lit *= 1.-0.20*smoothstep(0.004, 0.10, g_curv) + 0.05*smoothstep(0.004, 0.10, -g_curv);
  lit = mix(lit, 1.+0.35*(lit-1.), treeK);                          // crowns carry their own light; the slope under them shows a little
  if (treeK < 0.5 && ci!=4){
    vec2 ws = w-vec2(3.3,3.7), gs = ws/u_dx-0.5; ivec2 is = ivec2(floor(gs)); vec2 fs = fract(gs);     // the shadow of crowns standing to the north-west
    vec4 a0 = texelFetch(u_T,cl(is),0), a1 = texelFetch(u_T,cl(is+ivec2(1,0)),0), a2 = texelFetch(u_T,cl(is+ivec2(0,1)),0), a3 = texelFetch(u_T,cl(is+ivec2(1,1)),0);
    vec4 cs = floor(vec4(a0.b,a1.b,a2.b,a3.b)+0.5), ws4 = vec4((1.-fs.x)*(1.-fs.y), fs.x*(1.-fs.y), (1.-fs.x)*fs.y, fs.x*fs.y);
    vec4 isT = vec4(equal(cs, vec4(3.))), isW = vec4(equal(cs, vec4(6.)));
    float ft = dot(ws4, isT), fwl = dot(ws4, isW);
    if (ft + fwl > 0.){
      bool wl = fwl > ft;
      float g4 = dot(ws4*(isT+isW), vec4(a0.a,a1.a,a2.a,a3.a))/(ft+fwl);
      float sz = wl ? mix(0.22, 1., smoothstep(0.05, 0.9, g4)) : mix(0.28, 1., smoothstep(0.05, 0.8, g4));
      vec4 c4 = wl ? crownN(ws*1.8 + 31.7) : crownN(ws);
      float inS = (1.-smoothstep(0.85, 1.1, c4.x/sz))*smoothstep(0.4, 0.6, ft + fwl + (wl ? 0. : 0.5*(1.-smoothstep(0.75, 1.1, c4.x)) - 0.22) + 0.5*edgeJit(ws/u_dx, 3.));
      lit *= 1.-mix(0.30*(ft+fwl), 0.40*inS, kd)*(wl || c4.y >= 0.5 ? 1.-0.5*u_seas.z : 1.);
    }
  }
  if (farm){ lit *= 1.-0.34*buildingShadow(w)*(1.-bld.a); }
  col *= lit;
  if (bld.a > 0.){ col = mix(col, bld.rgb, bld.a); lit = mix(lit, 1., bld.a); }
  litOut = lit;

  // --- views
  if (u_lens==1){                                                    // soil health: dark rich soil = lots of organic matter
    vec3 s = mix(vec3(0.84,0.72,0.48), vec3(0.22,0.14,0.09), clamp(som/0.7,0.,1.));
    s = mix(s, vec3(0.50,0.52,0.54), step(3.5,float(ci))*step(float(ci),5.5));
    col = s*lit*(1.-0.15*moist);
    if (ci==3||ci==2||ci==6) col = mix(col, vec3(0.15,0.45,0.15)*lit, 0.25*gr);
  } else if (u_lens==2){                                             // soil lost (red) / gained (blue) since the start
    vec3 base = vec3(0.86,0.84,0.79)*lit;
    vec3 tone = dlt < 0. ? mix(vec3(0.95,0.60,0.30), vec3(0.75,0.12,0.08), smoothstep(0.2, 1.2, -dlt)) : mix(vec3(0.45,0.70,0.90), vec3(0.08,0.30,0.70), smoothstep(0.2, 1.2, dlt));
    col = mix(base, tone*mix(1., lit, 0.5), smoothstep(0.02, 0.25, abs(dlt)));
  } else if (u_lens==3){                                             // how deep the last flood got
    float dd = bil(u_C,w).b;
    vec3 base = mix(vec3(0.88,0.86,0.80)*lit, col, 0.35);
    col = dd>0.04 ? mix(base, mix(vec3(0.62,0.82,0.92), vec3(0.06,0.18,0.45), smoothstep(0.1,3.,dd))*mix(1., lit, 0.4), 0.9) : base;
  }

#if WATER
  if (u_lens==0){ vec4 wl = waterLayer(w, fp, lit, zk); col = mix(col, wl.rgb, wl.a*(1.-crownCov*(1.-smoothstep(3., 6., bil(u_W,w).r)))); }   // crowns stand above a flood until it is deeper than the trees are tall
#endif

  // --- flow lines and the trace (from the hydro module)
  if (u_ex.x > 0.5){
    float v = flowAt(w);
    float on = smoothstep(0.30, 0.36, v)*(0.35+0.65*smoothstep(0.30, 0.95, v));
    on *= 0.9+0.1*sin(v*60.-u_time*3.*(1.-u_wx.z));                  // the bands drift downstream
    col = mix(col, vec3(0.14,0.40,0.80), on*0.85);
  }
  if (u_ex.y > 0.5){
    vec2 tr = traceAt(w);
    float fw = max(fwidth(tr.x), 0.002);
    col = mix(col, vec3(0.95,0.78,0.25), smoothstep(0.45,0.55,tr.x)*0.20);                          // the land that drains here
    col = mix(col, vec3(0.45,0.28,0.05), (1.-smoothstep(0., 1.6*fw+0.02, abs(tr.x-0.5)))*step(0.02,tr.x)*0.85);
    col = mix(col, vec3(1.0,0.82,0.30), smoothstep(0.22,0.5,tr.y)*0.55);                           // the downhill path: soft halo...
    col = mix(col, vec3(1.0,0.98,0.75), smoothstep(0.55,0.85,tr.y)*0.95);                          // ...and a bright core
    float pl = 0.5+0.5*sin(u_time*4.*(1.-u_wx.z)), pr = (6.+2.*pl)*fp*2.;
    float d0 = length(w-u_traceP.xy);
    col = mix(col, vec3(0.2,0.12,0.05), ring(w, u_traceP.xy, pr, 2.5, fp)*0.9);
    col = mix(col, vec3(1.,0.98,0.85), 1.-smoothstep(pr*0.45, pr*0.55+fp, d0));
  }

  // --- field edges (a faint line; up close the hedges and fences show the boundary), and the field the Fields tool points at
  { float ef = max(0.9*fp, 0.3*u_dx); int f1 = fieldAt(wq+vec2(ef,0.)), f2 = fieldAt(wq+vec2(0.,ef));
    bool edge = (f1!=fid && f1!=0 && fid!=0) || (f2!=fid && f2!=0 && fid!=0);
    if (edge) col = mix(col, vec3(0.27,0.20,0.12), 0.30*(1.-0.6*zk));
    if (u_hiField > 0 && (fid == u_hiField || (edge && (f1 == u_hiField || f2 == u_hiField)))){
      col = mix(col, vec3(1.0,0.86,0.45), fid == u_hiField ? 0.16 + 0.06*sin(u_time*4.*(1.-u_wx.z)) : 0.);
      if (edge) col = mix(col, vec3(1.0,0.75,0.2), 0.9);
    }
  }

  // --- contour lines (they fade out instead of smearing when they get denser than the pixels)
  if (u_contour > 0. && ci!=4){
    float a = h/u_contour, fw = clamp(fwidth(a),0.004,0.6);
    float ln = 1.-smoothstep(0.,1.3*fw, abs(fract(a-0.5)-0.5));
    float b = h/(u_contour*5.), fb = clamp(fwidth(b),0.004,0.6);
    float ln5 = 1.-smoothstep(0.,2.0*fb, abs(fract(b-0.5)-0.5));
    float fade = 1.-0.85*smoothstep(0.2, 0.5, fw);
    col = mix(col, vec3(0.46,0.27,0.12), clamp(0.26*ln*fade + 0.42*ln5*(1.-smoothstep(0.1,0.3,fb)), 0., 0.8));
  }
  if (u_hiH > -100.){                                                // the contour you are following
    float fh = max(fwidth(h),1e-5), hi = 1.-smoothstep(1.2*fh, 2.6*fh, abs(h-u_hiH));
    col = mix(col, vec3(1.0,0.55,0.1), hi*(0.7+0.3*sin(u_time*5.)));
  }
  if (u_ex.z > 0.5){                                                 // the cross-section line, with a handle at each end
    vec2 a = u_section.xy, b = u_section.zw, ab = b-a; float L2 = max(dot(ab,ab), 1e-3);
    float tt = clamp(dot(w-a,ab)/L2, 0., 1.), dl = length(w-a-ab*tt);
    float dash = step(0.35, fract(tt*sqrt(L2)/(14.*fp)));
    col = mix(col, vec3(1.,1.,1.), (1.-smoothstep(1.4*fp, 3.2*fp, dl))*0.55);
    col = mix(col, vec3(0.20,0.12,0.06), (1.-smoothstep(0.7*fp, 1.5*fp, dl))*mix(0.55, 1., dash));
    float ha = length(w-a), hb = length(w-b), hr = 8.*fp;
    float hd = min(ha, hb);
    col = mix(col, vec3(1.,0.98,0.9), 1.-smoothstep(hr-1.2*fp, hr, hd));
    col = mix(col, vec3(0.20,0.12,0.06), (1.-smoothstep(0., 1.4*fp, abs(hd-hr)))*0.95);
    col = mix(col, vec3(0.86,0.40,0.12), (1.-smoothstep(hr*0.35, hr*0.35+fp, hd)));
  }

  // --- hints, brush
  for (int i=0;i<4;i++){ if (i>=u_nHints) break;
    float pul = 0.5+0.5*sin(u_time*3.); float R = u_hints[i].z*(0.92+0.08*pul);
    col = mix(col, vec3(1.0,0.62,0.18), ring(w,u_hints[i].xy,R,3.5,fp)*0.95);
    col = mix(col, vec3(1.0,0.78,0.35), (1.-smoothstep(0.,R,length(w-u_hints[i].xy)))*0.10); }
  if (u_brush.w > 0.5){
    float r = ring(w,u_brush.xy,u_brush.z,2.2,fp), r2 = ring(w,u_brush.xy,u_brush.z+1.8*fp,1.6,fp);
    col = mix(col, vec3(0.2,0.12,0.05), r2*0.55); col = mix(col, vec3(1.,0.98,0.9), r); }
  return col;
}
`;

  // ------------------------------------------------------------------------------------------------ JS helpers
  const S = Creek.Shade = {};
  const UNITS = [['u_T', 'T'], ['u_W', 'W'], ['u_M', 'M'], ['u_C', 'C'], ['u_I', 'I']];

  /** A compiled, linked shader program with cached uniform locations. Throws (with the compiler's message) when it will not build. */
  function Program(gl, vs, fs, name) {
    this.gl = gl; this.name = name || 'shader'; this.locs = {};
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(name + (type === gl.VERTEX_SHADER ? ' vertex' : ' fragment') + ' shader: ' + log); }
      return s;
    };
    const a = mk(gl.VERTEX_SHADER, vs), b = mk(gl.FRAGMENT_SHADER, fs), p = this.p = gl.createProgram();
    gl.attachShader(p, a); gl.attachShader(p, b); gl.linkProgram(p);
    gl.deleteShader(a); gl.deleteShader(b);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ' link: ' + gl.getProgramInfoLog(p));
  }
  Program.prototype.use = function () { this.gl.useProgram(this.p); return this; };
  Program.prototype.u = function (n) { const l = this.locs; return n in l ? l[n] : (l[n] = this.gl.getUniformLocation(this.p, n)); };
  Program.prototype.dispose = function () { this.gl.deleteProgram(this.p); this.p = null; };
  S.Program = Program;

  /** A 1x1 float texture that stands in for the extras nobody provided. One per GL context. */
  function dummy(gl) {
    if (gl.__creekDummy && gl.isTexture(gl.__creekDummy)) return gl.__creekDummy;     // (a lost and restored graphics context makes the old one invalid)
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return (gl.__creekDummy = t);
  }

  // season weights, eased so the colours drift from one season to the next instead of jumping
  const seasW = new Float32Array(4); let phase = -1, tPrev = 0;
  /** [summer, fall, winter, spring] weights for this frame. state.seasonIdx (0..3) wins; otherwise the game's season is used. */
  S.season = function (s) {
    let idx = s && typeof s.seasonIdx === 'number' ? s.seasonIdx : -1;
    if (idx < 0) { const g = Creek.game; idx = g && Creek.SEASONS ? Math.max(0, Creek.SEASONS.indexOf(g.season)) : 0; }
    const now = (s && s.time) || 0;
    if (phase < 0 || now <= 0 || now < tPrev) phase = idx;
    else {
      let d = idx - phase; d = ((d + 2) % 4 + 4) % 4 - 2;             // the short way round the year
      phase += d * (1 - Math.exp(-Math.min(now - tPrev, 0.1) / 0.7));
      phase = (phase % 4 + 4) % 4;
    }
    tPrev = now;
    const i0 = Math.floor(phase) % 4; let f = phase - Math.floor(phase); f = f * f * (3 - 2 * f);
    seasW[0] = seasW[1] = seasW[2] = seasW[3] = 0; seasW[i0] = 1 - f; seasW[(i0 + 1) % 4] += f;
    return seasW;
  };

  const hintBuf = new Float32Array(16), tintBuf = new Float32Array(4), rectBuf = new Float32Array(12), farmBuf = new Float32Array(4);
  let rectMeta = null;
  function farmstead() {                                              // the buildings, from the world data (read only)
    const g = Creek.game, meta = g && g.world && g.world.meta;
    if (meta !== rectMeta) {
      rectMeta = meta; rectBuf.fill(0); farmBuf.fill(0);
      if (meta && meta.rects && meta.farm) {
        ['house', 'barn', 'shed'].forEach((k, i) => { const r = meta.rects[k]; if (r) { rectBuf[i * 4] = r[0]; rectBuf[i * 4 + 1] = r[1]; rectBuf[i * 4 + 2] = r[2]; rectBuf[i * 4 + 3] = r[3]; } });
        farmBuf[0] = meta.farm.x; farmBuf[1] = meta.farm.y; farmBuf[2] = 55; farmBuf[3] = 34;
      }
    }
    return rectBuf[2] > 0;
  }

  /** Just the land: bind the five land textures (units 0..4) and the grid size. For passes that only read heights (the 3D picking pass). */
  S.bindLand = function (gl, P, v) {
    P.use();
    for (let i = 0; i < UNITS.length; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, v[UNITS[i][1]]); gl.uniform1i(P.u(UNITS[i][0]), i); }
    gl.uniform2i(P.u('u_n'), v.nx, v.ny); gl.uniform1f(P.u('u_dx'), v.dx);
    gl.uniform2f(P.u('u_mapSize'), Creek.CONFIG.mapW, Creek.CONFIG.mapH);
    farmstead(); gl.uniform4fv(P.u('u_rect'), rectBuf); gl.uniform4fv(P.u('u_farm'), farmBuf);      // the buildings stand up in 3D picking too
  };

  /** Bind the land textures (units 0..6) and set every shared uniform for program P. state = what game.draw hands over; views = sim.views(). */
  S.bind = function (gl, P, s, v) {
    const X = s.extras || {}, dm = dummy(gl);
    S.bindLand(gl, P, v);
    const fl = X.flow && X.flow.tex ? X.flow : null, tr = X.trace && X.trace.tex ? X.trace : null;
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, fl ? fl.tex : dm); gl.uniform1i(P.u('u_flow'), 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, tr ? tr.tex : dm); gl.uniform1i(P.u('u_trace'), 6);
    gl.uniform1f(P.u('u_time'), s.time || 0); gl.uniform1f(P.u('u_contour'), s.contour || 0);
    gl.uniform1i(P.u('u_lens'), s.lens | 0); gl.uniform1f(P.u('u_hiH'), s.hiH == null ? -999 : s.hiH);
    const b = s.brush || { x: 0, y: 0, r: 0, on: false };
    gl.uniform4f(P.u('u_brush'), b.x, b.y, b.r, b.on ? 1 : 0);
    const hl = s.hints || [], nh = Math.min(4, hl.length); hintBuf.fill(0);
    for (let k = 0; k < nh; k++) { hintBuf[k * 4] = hl[k].x; hintBuf[k * 4 + 1] = hl[k].y; hintBuf[k * 4 + 2] = hl[k].r; }
    gl.uniform4fv(P.u('u_hints'), hintBuf); gl.uniform1i(P.u('u_nHints'), nh);
    const t = s.tint || tintBuf; gl.uniform4f(P.u('u_tint'), t[0] || 0, t[1] || 0, t[2] || 0, t[3] || 0);
    const sw = S.season(s); gl.uniform4f(P.u('u_seas'), sw[0], sw[1], sw[2], sw[3]);
    const wx = X.weather || { rain: 0, flash: 0 }, calm = Creek.settings && Creek.settings.get('reduceMotion', false) ? 1 : 0;
    gl.uniform4f(P.u('u_wx'), wx.rain || 0, (wx.flash || 0) * (calm ? 0.35 : 1), calm, s.dpr || Math.min(window.devicePixelRatio || 1, 2));
    gl.uniform4f(P.u('u_ex'), fl ? 1 : 0, tr ? 1 : 0, X.section ? 1 : 0, farmstead() ? 1 : 0);
    gl.uniform4f(P.u('u_flowG'), fl ? fl.nx : 1, fl ? fl.ny : 1, fl ? fl.dx : 1, 0);
    gl.uniform4f(P.u('u_traceG'), tr ? tr.nx : 1, tr ? tr.ny : 1, tr ? tr.dx : 1, 0);
    gl.uniform4f(P.u('u_traceP'), tr ? tr.x : 0, tr ? tr.y : 0, 0, 0);
    const sc = X.section; gl.uniform4f(P.u('u_section'), sc ? sc.x0 : 0, sc ? sc.y0 : 0, sc ? sc.x1 : 0, sc ? sc.y1 : 0);
    gl.uniform4fv(P.u('u_rect'), rectBuf); gl.uniform4fv(P.u('u_farm'), farmBuf);
    gl.uniform4f(P.u('u_ext'), s.crown == null ? 1 : s.crown, 0, 0, 0);
    gl.uniform1i(P.u('u_hiField'), s.hiField | 0);
  };
  S.dispose = function (gl) { if (gl.__creekDummy) { gl.deleteTexture(gl.__creekDummy); gl.__creekDummy = null; } };
})();
