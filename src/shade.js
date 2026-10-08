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
vec2 crownAt(vec2 w){                               // distance to the nearest trunk (loose 7 m grid) and that tree's own height 0..1
  vec2 g = w/7., i = floor(g), f = fract(g); vec2 best = vec2(2., 0.);
  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){
    vec2 o2 = vec2(x,y); vec2 pnt = o2 + 0.25 + 0.5*hash2(i+o2); float d = length(f-pnt);
    if (d < best.x) best = vec2(d, hash(i+o2+7.7));
  }
  return best;
}
float canopyCell(ivec2 c){ vec4 t = texelFetch(u_T, cl(c), 0); int ci = int(t.b+.5); return t.a*(ci==3 ? 1. : ci==6 ? 0.3 : 0.); }
float canopyBlend(vec2 w){                          // how wooded the ground is around w (0..1), blended over four cells so woods have sloping edges
  vec2 g = w/u_dx-0.5; ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  return mix(mix(canopyCell(i),canopyCell(i+ivec2(1,0)),f.x), mix(canopyCell(i+ivec2(0,1)),canopyCell(i+ivec2(1,1)),f.x), f.y);
}
float treeExtrude(vec2 w){                          // tree and willow height in metres
  float e = canopyBlend(w);
  if (e < 0.01) return 0.;
  vec2 cr = crownAt(w);
  float dome = sqrt(max(1.-cr.x*cr.x*4., 0.));        // round crowns
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

// ---- seasons: dry golden pasture in summer, orange and gold in fall, dormant tan in winter, fresh green in spring. Kept subtle.
vec3 grassTone(vec3 g, float gr, float k){
  vec3 gold = vec3(0.77,0.66,0.33), amber = vec3(0.80,0.52,0.20), dorm = vec3(0.63,0.57,0.45), fresh = vec3(0.38,0.70,0.24);
  g = mix(g, gold, k*0.34*u_seas.x*(1.-0.45*gr));
  g = mix(g, amber, k*0.30*u_seas.y);
  g = mix(g, dorm, k*0.66*u_seas.z);
  return mix(g, fresh, k*0.34*u_seas.w*(0.35+0.65*gr));
}
vec3 treeTone(vec3 g, float n){
  vec3 fall = mix(vec3(0.80,0.56,0.14), vec3(0.78,0.30,0.10), n), bare = vec3(0.35,0.29,0.23), young = vec3(0.34,0.56,0.17);
  g = mix(g, fall, 0.62*u_seas.y); g = mix(g, bare, 0.78*u_seas.z); g = mix(g, young, 0.46*u_seas.w);
  return g*(1.-0.04*u_seas.x);
}

// ---- the farmstead: roofs with a ridge, crisp edges, and a shadow on the ground beside them
vec4 buildingAt(vec2 w, float fp, float zk){
  vec4 res = vec4(0.);
  for (int k=0;k<3;k++){
    vec4 r = u_rect[k]; if (r.z <= 0.) continue;
    vec2 hs = 0.5*r.zw, q = w-(r.xy+hs); float sd = boxSd(q, hs); if (sd > fp+0.5) continue;
    bool alongX = hs.x >= hs.y;
    float across = alongX ? q.y/hs.y : q.x/hs.x, rd = abs(across)*(alongX ? hs.y : hs.x);          // rd = metres from the ridge
    vec3 base = k==0 ? vec3(0.67,0.34,0.25) : k==1 ? vec3(0.58,0.21,0.16) : vec3(0.62,0.65,0.68);
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

// ---- water, with several taps when zoomed out so thin creeks stay visible. Returns colour (already lit) and how much of it shows.
vec4 waterLayer(vec2 w, float fp, float lit, float zk){
  vec4 wd = bil(u_W,w); float d = wd.r;
  if (fp > u_dx*0.8){ float k = 0.5*fp; d = max(max(d, bil(u_W,w+vec2(k,0.)).r), max(bil(u_W,w-vec2(k,0.)).r, max(bil(u_W,w+vec2(0.,k)).r, bil(u_W,w-vec2(0.,k)).r))); }
  if (d <= 0.003) return vec4(0.);
  vec2 v = wd.ba; float sp = length(v);                              // the current, blended between cells so the ripples have no seams
  float conc = clamp(wd.g/max(wd.r,0.003), 0., 0.2), mud = smoothstep(0.,0.05,conc);
  vec3 wc = mix(vec3(0.33,0.62,0.74), vec3(0.58,0.40,0.25), mud);
  wc *= 1.-0.35*smoothstep(0.1,2.5,d);
  float foam = 0.;
  if (zk > 0.02){                                                    // ripples that travel with the current, and foam
    float ph = fract(u_time*0.6*(1.-u_wx.z)), w0 = 1.-abs(2.*ph-1.);
    float r0 = noise((w*0.35 - v*ph*0.5)*2.), r1 = noise((w*0.35 - v*fract(ph+.5)*0.5)*2.+7.3);
    float rip = r0*w0 + r1*(1.-w0);
    wc += 0.14*(rip-0.5)*(0.35+min(sp,4.)/4.)*zk;
    foam = smoothstep(0.62,0.82,rip)*smoothstep(1.5,3.5,sp)*0.7;
    float shore = (1.-smoothstep(0.008,0.05,d))*smoothstep(0.003,0.014,d);             // foam where deeper water meets the land (a thin sheet of water has no shore)
    if (shore > 0.01){
      float k = max(2.5, 1.5*fp), dn = max(max(bil(u_W,w+vec2(k,0.)).r, bil(u_W,w-vec2(k,0.)).r), max(bil(u_W,w+vec2(0.,k)).r, bil(u_W,w-vec2(0.,k)).r));
      shore *= smoothstep(0.08, 0.3, dn);
      foam = max(foam, shore*smoothstep(0.30,0.65,noise(w*1.7+vec2(u_time*0.12*(1.-u_wx.z),0.)))*0.75);
    }
    wc = mix(wc, vec3(0.97,0.95,0.90), foam*zk*0.8);
  }
  float a = max(smoothstep(0.003,0.06,d)*0.88, mud*0.9);
  return vec4(wc*mix(1.,lit,0.5), max(a, foam*zk*0.8));
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
    col = mix(col, vec3(g)*vec3(0.80,0.88,1.0), 0.32*rain);
    col *= mix(1., 0.80, rain)*(1.-0.11*rain*smoothstep(0.38,0.78,cs));
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
vec3 reliefNormal(vec2 w, float e, float kg, float ke, float ee){
  vec2 g = vec2(hAt(w+vec2(e,0.))-hAt(w-vec2(e,0.)), hAt(w+vec2(0.,e))-hAt(w-vec2(0.,e)))/(2.*e)*kg;
#if EXTR
  if (ke > 0.) g += vec2(extrudeAt(w+vec2(ee,0.))-extrudeAt(w-vec2(ee,0.)), extrudeAt(w+vec2(0.,ee))-extrudeAt(w-vec2(0.,ee)))/(2.*ee)*ke;
#endif
  return normalize(vec3(-g, 1.));
}

// ---- everything the land looks like at world point w (colour, lens, field edges, contour lines, markers). nrm = surface normal.
// fp = metres per pixel at this spot. With WATER on, the water is painted in as well (flat map); the 3D view draws it as its own layer.
vec3 shadeLand(vec2 w, float fp, vec3 nrm, out float litOut){
  float zk = smoothstep(0.7, 3.2, 1./fp);                            // fine detail fades in as you zoom in
  float nl = noise(w*0.011), nm = noise(w*0.07+3.), nh = noise(w*0.7)*zk + 0.5*(1.-zk);
  vec2 wq = w + (vec2(noise(w*(0.9/u_dx)+3.1), noise(w*(0.9/u_dx)+11.7))-0.5)*(0.9*u_dx);   // the data is one value per cell: look it up at a wobbled spot so cell edges are ragged, not stairs
  ivec2 c = cellOf(wq);
  vec4 t = texelFetch(u_T,c,0), m = texelFetch(u_M,c,0), tb = bil(u_T,w);
  int ci = int(t.b+.5); float gr = t.a, soil = m.g, moist = m.r, som = m.b; int fid = int(m.a+.5);
  float h = tb.r, thick = tb.r-tb.g;
#if EXTR
  { float cb = canopyBlend(w); if (cb > 0.2 && ci != 3){ ci = 3; gr = max(gr, cb); } }      // where the ground is lifted into a wood, it looks like wood
#endif
  bool farm = u_ex.w > 0.5;
  vec4 bld = farm ? buildingAt(w, fp, zk) : vec4(0.);

  // --- ground colour
  vec3 clay = vec3(0.30,0.20,0.14), loam = vec3(0.66,0.50,0.33);
  vec3 dirt = mix(clay, loam, soil) * (0.9+0.2*nm) * (1.-0.28*moist);
  vec3 lime = vec3(0.90,0.85,0.72)*(0.94+0.1*nm);
  vec3 col = dirt;
  if (ci==1){ vec3 g1 = grassTone(mix(vec3(0.66,0.60,0.36), vec3(0.47,0.66,0.28), gr), gr, 1.); col = mix(g1, g1*vec3(0.85,0.9,0.7), nl) * (0.92+0.14*nm); col = mix(dirt, col, 0.35+0.65*smoothstep(0.05,0.5,gr)); }
  else if (ci==2){ vec3 g2 = grassTone(mix(vec3(0.72,0.66,0.34), vec3(0.62,0.62,0.26), nl), gr, 0.8); col = mix(dirt, g2*(0.9+0.2*nm), 0.35+0.65*gr); col *= 0.94+0.12*step(0.62,nh); }
  else if (ci==3){
    vec3 g3 = treeTone(mix(vec3(0.15,0.33,0.16), vec3(0.28,0.47,0.20), nm), nm); col = mix(dirt, g3, smoothstep(0.05,0.5,gr));
    col = mix(col, dirt*0.85, 0.30*u_seas.z*smoothstep(0.05,0.5,gr));                    // bare winter trees let the ground show
    if (zk > 0.05){ float cr = crownAt(w).x; col *= mix(1., mix(1.28, 0.72, smoothstep(0.12,0.42,cr)), zk*smoothstep(0.2,0.7,gr)*(1.-0.6*u_seas.z)); }
  }
  else if (ci==4){ col = farm ? vec3(0.80,0.74,0.62)*(0.94+0.1*nm) : (hash(floor(w/20.))>0.5 ? vec3(0.72,0.38,0.27) : vec3(0.62,0.64,0.66)) * (0.92+0.08*sin(w.y*2.)); }
  else if (ci==5){ col = vec3(0.82,0.76,0.64)*(0.95+0.08*nm); }
  else if (ci==6){ col = mix(dirt, grassTone(vec3(0.42,0.60,0.26), gr, 0.5)*(0.85+0.3*nm), 0.35+0.65*gr); }
  else if (ci==7){ vec3 g7 = grassTone(mix(vec3(0.50,0.55,0.30), vec3(0.34,0.60,0.26), gr), gr, 0.5); col = mix(dirt, g7*(0.9+0.2*nl), 0.5+0.5*gr); }
  else if (ci==8){ col = vec3(0.46,0.31,0.19)*(0.85+0.3*step(0.5,fract(w.x*0.8+w.y*0.1))); }
  else if (ci==9){ vec3 g9 = grassTone(mix(vec3(0.53,0.38,0.26), vec3(0.55,0.68,0.26), smoothstep(0.1,0.8,gr)), gr, 0.5); col = g9*(0.9+0.2*nl) * (0.95+0.1*nm); }
  else if (ci==10){ col = mix(vec3(0.12,0.27,0.29), vec3(0.20,0.33,0.30), nm)*(0.9+0.2*nm); }       // pond bed: dark teal
  float rowK = smoothstep(0.83, 0.33, fp);
  if ((ci==7||ci==9) && rowK > 0.){                                  // crop rows
    float ang = hash(vec2(float(fid),1.))*3.14159, s = dot(w, vec2(cos(ang),sin(ang)));
    col *= 1. - 0.13*(0.5+0.5*sin(s*6.2832/3.2))*rowK;
  }
  if (ci!=4 && ci!=5 && ci!=8 && ci!=10){                           // bare limestone, with ledges that follow the height and cracks between blocks
    float rock = 1.-smoothstep(0.015, 0.08, thick);
    if (rock > 0.){
      vec3 lm = lime;
      if (zk > 0.1){ float led = 0.5+0.5*sin(h*9.+5.*noise(w*0.25)); lm *= 0.93+0.09*led; lm *= 1.-0.10*step(0.9, noise(w*vec2(0.8,2.4)))*zk; lm *= 1.+0.05*(noise(w*2.3)-0.5)*zk; }
      col = mix(col, lm, rock);
    }
  }
  if (zk > 0.1){
    if (ci==10){                                                     // pond shore: a pale muddy rim
      float edge = 0.;
      edge = max(edge, float(coverAt(wq+vec2(1.8,0.))!=10)); edge = max(edge, float(coverAt(wq-vec2(1.8,0.))!=10));
      edge = max(edge, float(coverAt(wq+vec2(0.,1.8))!=10)); edge = max(edge, float(coverAt(wq-vec2(0.,1.8))!=10));
      col = mix(col, vec3(0.50,0.46,0.34), 0.65*edge*zk);
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
    vec3 gv = vec3(0.79,0.72,0.58)*(0.94+0.10*noise(w*0.6))*(0.98+0.035*hash(floor(w*3.)*(0.5+zk)));
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
          col = mix(col, vec3(0.13,0.27,0.12)*(0.8+0.5*noise(w*3.)), band*0.85*zk);
        } else {                                                       // a wire fence: thin line with posts
          float line = 1.-smoothstep(0.1, 0.32+0.4*fp, dd);
          float post = line*step(fract((wq.x+wq.y*1.3)/6.), 0.09);
          col = mix(col, vec3(0.26,0.19,0.12), max(line*0.55, post*0.9)*zk);
        }
      }
    }
  }

  // --- shaded relief (sun from the north-west) and the shadows trees and buildings throw
  float sh = dot(nrm,SUN)/SUN.z;
  float lit = clamp(mix(1., sh, 0.9), 0.5, 1.4);
  if (zk > 0.02 && ci!=3 && ci!=4){
    lit *= 1.-0.14*float(coverAt(wq-vec2(4.,4.5))==3)*smoothstep(0.02,0.3,zk);
  }
  if (farm){ lit *= 1.-0.34*buildingShadow(w)*(1.-bld.a); }
  else if (ci==3 || ci==4){ int cs = coverAt(wq - vec2(3.,3.5)); if (cs!=ci && (cs==3||cs==4)) lit *= 0.8; }
  col *= lit;
  if (bld.a > 0.){ col = mix(col, bld.rgb, bld.a); lit = mix(lit, 1., bld.a); }
  litOut = lit;

  // --- views
  if (u_lens==1){                                                    // soil health: dark rich soil = lots of organic matter
    vec3 s = mix(vec3(0.80,0.66,0.42), vec3(0.22,0.14,0.09), clamp(som/0.7,0.,1.));
    s = mix(s, vec3(0.48,0.50,0.52), step(3.5,float(ci))*step(float(ci),5.5));
    col = s*lit*(1.-0.15*moist);
    if (ci==3||ci==2||ci==6) col = mix(col, vec3(0.15,0.45,0.15)*lit, 0.25*gr);
  } else if (u_lens==2){                                             // soil lost (red) / gained (blue) since the start
    float dlt = h - bil(u_I,w).r;
    vec3 base = vec3(0.82,0.80,0.74)*lit;
    col = mix(base, dlt<0. ? vec3(0.86,0.22,0.12) : vec3(0.16,0.45,0.75), smoothstep(0.03,0.9,abs(dlt)));
  } else if (u_lens==3){                                             // how deep the last flood got
    float dd = bil(u_C,w).b;
    vec3 base = mix(vec3(0.86,0.84,0.78)*lit, col, 0.35);
    col = dd>0.04 ? mix(base, mix(vec3(0.60,0.80,0.90), vec3(0.08,0.20,0.45), smoothstep(0.1,3.,dd)), 0.9) : base;
  }

#if WATER
  if (u_lens==0){ vec4 wl = waterLayer(w, fp, lit, zk); col = mix(col, wl.rgb, wl.a); }
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

  // --- field edges
  { float ef = max(0.9*fp, 0.3*u_dx); int f1 = fieldAt(wq+vec2(ef,0.)), f2 = fieldAt(wq+vec2(0.,ef));
    if ((f1!=fid && f1!=0 && fid!=0) || (f2!=fid && f2!=0 && fid!=0)) col = mix(col, vec3(0.27,0.20,0.12), 0.38); }

  // --- contour lines (they fade out instead of smearing when they get denser than the pixels)
  if (u_contour > 0. && ci!=4){
    float a = h/u_contour, fw = clamp(fwidth(a),0.004,0.6);
    float ln = 1.-smoothstep(0.,1.3*fw, abs(fract(a-0.5)-0.5));
    float b = h/(u_contour*5.), fb = clamp(fwidth(b),0.004,0.6);
    float ln5 = 1.-smoothstep(0.,2.0*fb, abs(fract(b-0.5)-0.5));
    float fade = 1.-0.65*smoothstep(0.35, 0.6, fw);
    col = mix(col, vec3(0.42,0.25,0.12), clamp(0.36*ln*fade + 0.5*ln5*(1.-smoothstep(0.1,0.3,fb)), 0., 0.85));
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
  };
  S.dispose = function (gl) { if (gl.__creekDummy) { gl.deleteTexture(gl.__creekDummy); gl.__creekDummy = null; } };
})();
