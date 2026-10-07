/* The land-and-water engine. Runs on the graphics chip (WebGL2).
   It owns the data (textures) and knows nothing about how the map is drawn.
   The drawing code only ever reads sim.views().

   Method: "virtual pipes" shallow water (Mei, Decaudin & Hu 2007) with
   Manning-style drag, soil picked up/dropped by speed, and slumping of
   over-steep banks. Limestone is a floor that never erodes.

   Textures (all RGBA32F, one texel per cell):
     T  terrain:  surface height | limestone height | cover type | plant growth
     W  water:    depth | soil carried (m, as depth of soil) | velocity x | velocity y
     F  flux:     water leaving to west | east | north | south   (m³/s)
     M  ground:   moisture | soil type | roof zone | spare
     B  bank map: lowest ground within ~2 m (so a cell knows how tall its bank is)  */
(function () {
  const C = Creek.CONFIG, S = C.sim;
  const MMHR = 2.7778e-7;

  const f = (a) => 'float[' + a.length + '](' + a.map(v => Number(v).toFixed(7)).join(',') + ')';
  const CONSTS = `
const float G = ${S.gravity.toFixed(3)};
const float INFIL[10] = ${f(C.cover.infil)};
const float MAN[10] = ${f(C.cover.manning)};
const float ROOTD[10] = ${f(C.cover.rootDepth)};
const float ROOTB[10] = ${f(C.cover.rootBonus)};
const float SURF[10] = ${f(C.cover.surfHold)};
const float FIXED[10] = ${f(C.cover.fixed)};
const float I_WET[2] = ${f(C.soil.infilWet.map(v => v * MMHR))};
const float I_DRY[2] = ${f(C.soil.infilDry.map(v => v * MMHR))};
const float STORE[2] = ${f(C.soil.storage)};
const float TAN_DRY[2] = ${f(C.soil.tanDry)};
const float TAN_WET[2] = ${f(C.soil.tanWet)};
const float ERODE[2] = ${f(C.soil.erodible)};
const float CRIT[2] = ${f(C.soil.critSpeed)};
const float KC = ${S.Kc.toFixed(6)}, KS = ${S.Ks.toFixed(5)}, KD = ${S.Kd.toFixed(5)};
`;
  const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform ivec2 u_n; uniform float u_dx, u_dt;
` + CONSTS;
  const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.-1., 0., 1.); }`;

  const FS = {};
  FS.flux = HEAD + `
uniform sampler2D u_T, u_W, u_F; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(u_T,p,0), w = texelFetch(u_W,p,0), f0 = texelFetch(u_F,p,0);
  float H = t.r + w.r, n0 = MAN[int(t.b+.5)];
  ivec2 off[4] = ivec2[4](ivec2(-1,0), ivec2(1,0), ivec2(0,-1), ivec2(0,1));
  vec4 fl = vec4(0.); float sum = 0.;
  for (int k=0;k<4;k++){
    ivec2 q = p + off[k]; float hn, Hn, nn;
    if (q.x>=0 && q.y>=0 && q.x<u_n.x && q.y<u_n.y){
      vec4 tn = texelFetch(u_T,q,0); vec4 wn = texelFetch(u_W,q,0);
      hn = tn.r; Hn = hn + wn.r; nn = MAN[int(tn.b+.5)];
    } else if (k==3){ hn = t.r; Hn = t.r; nn = n0; }   // open edge at the bottom: water leaves the map
    else continue;                                       // other edges are walls
    float dEff = max(max(H,Hn) - max(t.r,hn), 0.);
    float fp = f0[k] + u_dt*G*dEff*(H-Hn);
    if (dEff < 1e-5 || fp <= 0.) continue;
    float nm = 0.5*(n0+nn);
    fp /= 1. + u_dt*G*nm*nm*fp/(u_dx*pow(max(dEff,1e-3),2.3333));
    fl[k] = fp; sum += fp;
  }
  float K = min(1., w.r*u_dx*u_dx/(sum*u_dt+1e-9));
  o = fl*K;
}`;

  FS.water = HEAD + `
uniform sampler2D u_T, u_W, u_F, u_M;
uniform float u_rain; uniform vec4 u_src[8]; uniform float u_srcRate[8];
layout(location=0) out vec4 oW; layout(location=1) out vec4 oM;
float conc(vec4 w){ return min(w.g/max(w.r,1e-4), 0.3); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(u_T,p,0), w = texelFetch(u_W,p,0), fo = texelFetch(u_F,p,0), m = texelFetch(u_M,p,0);
  float inL=0.,inR=0.,inU=0.,inD=0., cL=0.,cR=0.,cU=0.,cD=0.;
  if (p.x>0)       { inL = texelFetch(u_F,p+ivec2(-1,0),0).g; cL = conc(texelFetch(u_W,p+ivec2(-1,0),0)); }
  if (p.x<u_n.x-1) { inR = texelFetch(u_F,p+ivec2(1,0),0).r;  cR = conc(texelFetch(u_W,p+ivec2(1,0),0)); }
  if (p.y>0)       { inU = texelFetch(u_F,p+ivec2(0,-1),0).a; cU = conc(texelFetch(u_W,p+ivec2(0,-1),0)); }
  if (p.y<u_n.y-1) { inD = texelFetch(u_F,p+ivec2(0,1),0).b;  cD = conc(texelFetch(u_W,p+ivec2(0,1),0)); }
  float out_ = fo.r+fo.g+fo.b+fo.a, k = u_dt/(u_dx*u_dx);
  float d = w.r, d1 = d + (inL+inR+inU+inD-out_)*k;
  float s1 = w.g + (inL*cL+inR*cR+inU*cU+inD*cD - out_*conc(w))*k;
  float qx = 0.5*((inL-fo.r)+(fo.g-inR)), qy = 0.5*((inU-fo.b)+(fo.a-inD));
  float dm = 0.5*(d+max(d1,0.));
  vec2 vel = dm>2e-3 ? vec2(qx,qy)/(u_dx*dm) : vec2(0.);
  float sp = length(vel); if (sp>8.) vel *= 8./sp;
  int ci = int(t.b+.5);
  if (ci != 4) d1 += u_rain*u_dt;                       // rain (roofs send theirs to the downspouts)
  vec2 c = vec2(p)+0.5;
  for (int i=0;i<8;i++){ vec4 r=u_src[i]; if (c.x>=r.x && c.x<r.z && c.y>=r.y && c.y<r.w) d1 += u_srcRate[i]*u_dt; }
  // soaking in
  float soil = m.g, moist = m.r;
  float fcap = mix(mix(I_WET[0],I_WET[1],soil), mix(I_DRY[0],I_DRY[1],soil), pow(1.-moist,2.)) * INFIL[ci];
  if (t.r - t.g < 0.02) fcap = 0.;                       // bare limestone sheds water
  float inf = min(max(d1,0.), fcap*u_dt);
  d1 -= inf; moist = clamp(moist + inf/mix(STORE[0],STORE[1],soil), 0., 1.);
  oW = vec4(max(d1,0.), max(s1,0.), vel);
  oM = vec4(moist, m.gba);
}`;

  FS.erode = HEAD + `
uniform sampler2D u_T, u_W, u_M, u_B;
layout(location=0) out vec4 oT; layout(location=1) out vec4 oW;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(u_T,p,0), w = texelFetch(u_W,p,0), m = texelFetch(u_M,p,0);
  int ci = int(t.b+.5); bool fixd = FIXED[ci] > .5; bool bda = ci==8;
  if (fixd && !bda){ oT = t; oW = vec4(w.r, 0., w.ba); return; }
  ivec2 mx = u_n-ivec2(1);
  float hL = texelFetch(u_T,clamp(p+ivec2(-1,0),ivec2(0),mx),0).r, hR = texelFetch(u_T,clamp(p+ivec2(1,0),ivec2(0),mx),0).r;
  float hU = texelFetch(u_T,clamp(p+ivec2(0,-1),ivec2(0),mx),0).r, hD = texelFetch(u_T,clamp(p+ivec2(0,1),ivec2(0),mx),0).r;
  float slope = length(vec2(hR-hL, hD-hU))/(2.*u_dx); float sinA = slope/sqrt(1.+slope*slope);
  float d = w.r, Sd = w.g; vec2 vel = w.ba; float sp = length(vel); int soil = int(m.g+.5);
  if (d < 0.002){ t.r += Sd; Sd = 0.; }
  else {
    float excess = max(sp - CRIT[soil], 0.);
    float cap = min(KC*excess*excess*(0.4+4.*sinA), 0.25) * d;
    float hb = max(t.r - texelFetch(u_B,p,0).r, 0.12), g = t.a;
    float protect = SURF[ci]*g*clamp(ROOTD[ci]*g/hb, 0., 1.);
    if (Sd < cap && !bda){
      float avail = max(t.r - t.g, 0.);
      float dS = min(min(KS*u_dt,1.)*ERODE[soil]*(1.-protect)*(cap-Sd), avail);
      t.r -= dS; Sd += dS;
    } else if (Sd > cap){
      float dS = min(KD*u_dt,1.)*(Sd-cap); t.r += dS; Sd -= dS;
    }
  }
  oT = t; oW = vec4(w.r, Sd, vel);
}`;

  FS.slump = HEAD + `
uniform sampler2D u_T, u_M, u_B; uniform float u_rate;
float tanPhi(vec4 t, vec4 m, float hmin){
  int s = int(m.g+.5); float wet = pow(m.r, 0.7);
  float base = mix(mix(TAN_DRY[0],TAN_DRY[1],m.g), mix(TAN_WET[0],TAN_WET[1],m.g), wet);
  int ci = int(t.b+.5); float hb = max(t.r-hmin, 0.12), g = t.a;
  return base + ROOTB[ci]*g*clamp(ROOTD[ci]*g/hb, 0., 1.);
}
float give(vec4 a, vec4 b, vec4 ma, float hmina){   // soil height moving from cell a down to cell b
  if (FIXED[int(a.b+.5)]>.5 || FIXED[int(b.b+.5)]>.5) return 0.;
  float ex = (a.r - b.r) - tanPhi(a,ma,hmina)*u_dx;
  if (ex <= 0.) return 0.;
  return min(0.25*max(a.r-a.g,0.), 0.25*ex*u_rate);
}
out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(u_T,p,0), m = texelFetch(u_M,p,0); float hm = texelFetch(u_B,p,0).r;
  if (FIXED[int(t.b+.5)] > .5){ o = t; return; }
  ivec2 off[4] = ivec2[4](ivec2(-1,0), ivec2(1,0), ivec2(0,-1), ivec2(0,1));
  float dh = 0.;
  for (int k=0;k<4;k++){
    ivec2 q = p+off[k]; if (q.x<0||q.y<0||q.x>=u_n.x||q.y>=u_n.y) continue;
    vec4 tn = texelFetch(u_T,q,0); vec4 mn = texelFetch(u_M,q,0); float hn = texelFetch(u_B,q,0).r;
    dh -= give(t, tn, m, hm);
    dh += give(tn, t, mn, hn);
  }
  t.r += dh; o = t;
}`;

  FS.bank = HEAD + `
uniform sampler2D u_T; uniform ivec2 u_dir; uniform int u_R; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); float mn = 1e9;
  for (int i=-16;i<=16;i++){ if (i<-u_R||i>u_R) continue;
    ivec2 q = clamp(p+u_dir*i, ivec2(0), u_n-ivec2(1)); mn = min(mn, texelFetch(u_T,q,0).r); }
  o = vec4(mn,0.,0.,1.);
}`;

  FS.tool = HEAD + `
uniform sampler2D u_T; uniform int u_tool; uniform vec2 u_center; uniform float u_radius, u_amount, u_href, u_depth; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); vec4 t = texelFetch(u_T,p,0);
  vec2 pos = (vec2(p)+0.5)*u_dx; float r = length(pos-u_center);
  int ci = int(t.b+.5);
  if (r > u_radius || FIXED[ci] > .5){ o = t; return; }
  float fall = 1.-smoothstep(0., u_radius, r); bool soil = t.r-t.g > 0.03;
  if (u_tool==0){ float nh = max(t.r - u_amount*fall, t.g); if (nh < t.r-1e-5){ t.r = nh; t.b = 0.; t.a = 0.; } }
  else if (u_tool==1){ t.r += u_amount*fall; if (u_amount*fall>1e-5){ t.b = 0.; t.a = 0.; } }
  else if (u_tool==2){ if (ci!=2 && soil){ t.b = 2.; t.a = 0.08; } }
  else if (u_tool==3){ if (ci!=3 && soil){ t.b = 3.; t.a = 0.10; } }
  else if (u_tool==4){ if (ci!=6 && soil){ t.b = 6.; t.a = 0.10; } }
  else if (u_tool==5){
    float fl = u_href - u_depth*(1.-pow(r/u_radius,2.));
    t.r = max(fl, t.g); if (soil || ci!=7){ t.b = 7.; t.a = max(t.a, 0.3); }
  }
  else if (u_tool==6){ if (ci!=8){ t.r += 0.55; t.b = 8.; t.a = 1.; } }
  o = t;
}`;

  FS.grow = HEAD + `
uniform sampler2D u_T; uniform vec4 u_g; out vec4 o;   // u_g = grass, tree, willow, garden
void main(){
  vec4 t = texelFetch(u_T, ivec2(gl_FragCoord.xy), 0); int ci = int(t.b+.5);
  if (ci==2) t.a = min(1., t.a+u_g.x); else if (ci==3) t.a = min(1., t.a+u_g.y);
  else if (ci==6) t.a = min(1., t.a+u_g.z); else if (ci==7) t.a = min(1., t.a+u_g.w);
  o = t;
}`;

  FS.dry = HEAD + `
uniform sampler2D u_T, u_W; layout(location=0) out vec4 oT; layout(location=1) out vec4 oW;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); vec4 t = texelFetch(u_T,p,0), w = texelFetch(u_W,p,0);
  if (FIXED[int(t.b+.5)] < .5) t.r += w.g;       // mud settles where the water was
  oT = t; oW = vec4(0.);
}`;

  FS.moist = HEAD + `
uniform sampler2D u_M; uniform float u_base, u_keep; out vec4 o;
void main(){ vec4 m = texelFetch(u_M, ivec2(gl_FragCoord.xy), 0); m.r = u_base + (m.r-u_base)*u_keep; o = m; }`;

  FS.copy = HEAD + `
uniform sampler2D u_src; out vec4 o;
void main(){ o = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

  // ---------------------------------------------------------------------------------------------
  function Sim(gl, world) {
    this.gl = gl;
    this.nx = world.nx; this.ny = world.ny; this.dx = world.dx; this.meta = world.meta;
    this.dt = S.dtPerCell * this.dx;
    this.stepCount = 0;
    this.progs = Sim._shared || (Sim._shared = {});
    this._fbos = {};
    const mk = (data) => this._tex(data);
    const n = this.nx * this.ny * 4, z = () => new Float32Array(n);
    this.tex = {
      T: [mk(world.T), mk(null)], W: [mk(z()), mk(z())], F: [mk(z()), mk(z())],
      M: [mk(world.M), mk(null)], A: mk(null), B: mk(null), U: mk(null)
    };
    this.i = { T: 0, W: 0, F: 0, M: 0 };
    this.initialT = world.T; this.initialM = world.M;
    this.rain = 0; this.sources = [];
    this.undoOK = false;
    this.bankRadius = Math.max(1, Math.min(16, Math.round(S.bankRadius / this.dx)));
    this.refreshBank();
  }
  const P = Sim.prototype;

  P._tex = function (data) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.nx, this.ny, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  P._fbo = function (texs) {
    const gl = this.gl;
    const key = texs.map(t => this._id(t)).join('-');
    if (this._fbos[key]) return this._fbos[key];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    texs.forEach((t, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
    return (this._fbos[key] = fb);
  };
  P._id = function (t) { if (!t.__id) t.__id = ++Sim._ids; return t.__id; };
  Sim._ids = 0;
  P._prog = function (name) {
    if (this.progs[name]) return this.progs[name];
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(name + ' shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS[name]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ' link: ' + gl.getProgramInfoLog(p));
    return (this.progs[name] = { p, u: {} });
  };
  // draw a full-grid pass: reads = {uniformName: texture}, writes = [textures], extra = fn(setters)
  P._pass = function (name, reads, writes, set) {
    const gl = this.gl, pr = this._prog(name);
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo(writes));
    gl.viewport(0, 0, this.nx, this.ny);
    const loc = (n) => (n in pr.u ? pr.u[n] : (pr.u[n] = gl.getUniformLocation(pr.p, n)));
    gl.uniform2i(loc('u_n'), this.nx, this.ny); gl.uniform1f(loc('u_dx'), this.dx); gl.uniform1f(loc('u_dt'), this.dt);
    let unit = 0;
    for (const k in reads) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, reads[k]); gl.uniform1i(loc(k), unit++);
    }
    if (set) set({
      f: (n, v) => gl.uniform1f(loc(n), v), i: (n, v) => gl.uniform1i(loc(n), v),
      v2: (n, a, b) => gl.uniform2f(loc(n), a, b), v2i: (n, a, b) => gl.uniform2i(loc(n), a, b),
      v4: (n, a, b, c, d) => gl.uniform4f(loc(n), a, b, c, d),
      f1v: (n, arr) => gl.uniform1fv(loc(n), arr), f4v: (n, arr) => gl.uniform4fv(loc(n), arr)
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  P.dispose = function () {
    const gl = this.gl;
    for (const k in this.tex) [].concat(this.tex[k]).forEach(t => gl.deleteTexture(t));
    for (const k in this._fbos) gl.deleteFramebuffer(this._fbos[k]);
    this._fbos = {};
  };

  P._cur = function (k) { return this.tex[k][this.i[k]]; };
  P._nxt = function (k) { return this.tex[k][1 - this.i[k]]; };
  P._flip = function (k) { this.i[k] = 1 - this.i[k]; };

  /** Where the other 99 yards' water (and the downspouts') arrives. rects in metres, rates in m/s of depth. */
  P.setSources = function (list) { this.sources = list.slice(0, 8); };
  P.setRain = function (mps) { this.rain = mps; };

  P.refreshBank = function () {
    const R = this.bankRadius;
    this._pass('bank', { u_T: this._cur('T') }, [this.tex.A], (s) => { s.v2i('u_dir', 1, 0); s.i('u_R', R); });
    this._pass('bank', { u_T: this.tex.A }, [this.tex.B], (s) => { s.v2i('u_dir', 0, 1); s.i('u_R', R); });
  };

  /** Advance the water n steps. */
  P.step = function (n) {
    const dx = this.dx, src = new Float32Array(32), rate = new Float32Array(8);
    this.sources.forEach((s, k) => {
      src[k * 4] = s.x0 / dx; src[k * 4 + 1] = s.y0 / dx; src[k * 4 + 2] = s.x1 / dx; src[k * 4 + 3] = s.y1 / dx; rate[k] = s.rate;
    });
    for (let q = 0; q < n; q++) {
      this._pass('flux', { u_T: this._cur('T'), u_W: this._cur('W'), u_F: this._cur('F') }, [this._nxt('F')]);
      this._flip('F');
      this._pass('water', { u_T: this._cur('T'), u_W: this._cur('W'), u_F: this._cur('F'), u_M: this._cur('M') },
        [this._nxt('W'), this._nxt('M')], (s) => { s.f('u_rain', this.rain); s.f4v('u_src', src); s.f1v('u_srcRate', rate); });
      this._flip('W'); this._flip('M');
      this._pass('erode', { u_T: this._cur('T'), u_W: this._cur('W'), u_M: this._cur('M'), u_B: this.tex.B },
        [this._nxt('T'), this._nxt('W')]);
      this._flip('T'); this._flip('W');
      this.stepCount++;
      if (this.stepCount % S.slumpEvery === 0) {
        this._pass('slump', { u_T: this._cur('T'), u_M: this._cur('M'), u_B: this.tex.B }, [this._nxt('T')],
          (s) => s.f('u_rate', Math.min(1, S.slumpRate * this.dt * S.slumpEvery)));
        this._flip('T');
      }
      if (this.stepCount % S.bankEvery === 0) this.refreshBank();
    }
  };

  /** Dig / pile / plant. tool: 0 dig 1 pile 2 grass 3 tree 4 willow 5 rain garden 6 BDA */
  P.applyTool = function (tool, x, y, radius, amount, href, depth) {
    this._pass('tool', { u_T: this._cur('T') }, [this._nxt('T')], (s) => {
      s.i('u_tool', tool); s.v2('u_center', x, y); s.f('u_radius', radius); s.f('u_amount', amount);
      s.f('u_href', href || 0); s.f('u_depth', depth || 0.3);
    });
    this._flip('T'); this.refreshBank();
  };

  P.grow = function (g) {
    this._pass('grow', { u_T: this._cur('T') }, [this._nxt('T')], (s) => s.v4('u_g', g.grass, g.tree, g.willow, g.garden));
    this._flip('T'); this.refreshBank();
  };

  /** Between storms: mud settles, water drains away, ground partly dries toward `base` moisture. */
  P.dryOut = function (base, keep) {
    this._pass('dry', { u_T: this._cur('T'), u_W: this._cur('W') }, [this._nxt('T'), this._nxt('W')]);
    this._flip('T'); this._flip('W');
    const gl = this.gl, z = new Float32Array(this.nx * this.ny * 4);
    for (const t of this.tex.F) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RGBA, gl.FLOAT, z); }
    if (base !== undefined) {
      this._pass('moist', { u_M: this._cur('M') }, [this._nxt('M')], (s) => { s.f('u_base', base); s.f('u_keep', keep); });
      this._flip('M');
    }
    this.refreshBank();
  };

  P._copy = function (src, dst) { this._pass('copy', { u_src: src }, [dst]); };
  P.saveUndo = function () { this._copy(this._cur('T'), this.tex.U); this.undoOK = true; };
  P.undo = function () {
    if (!this.undoOK) return false;
    this._copy(this.tex.U, this._nxt('T')); this._flip('T'); this.refreshBank(); this.undoOK = false; return true;
  };

  P.reset = function () {
    const gl = this.gl, z = new Float32Array(this.nx * this.ny * 4);
    const up = (t, d) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RGBA, gl.FLOAT, d); };
    up(this.tex.T[0], this.initialT); this.i.T = 0; up(this.tex.M[0], this.initialM); this.i.M = 0;
    this.tex.W.forEach(t => up(t, z)); this.tex.F.forEach(t => up(t, z));
    this.i.W = 0; this.i.F = 0; this.undoOK = false; this.refreshBank();
  };

  // ---- reading data back (for numbers, hints and the end-of-year page) -------------------------
  P._read = function (tex, x, y, w, h) {
    const gl = this.gl, out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo([tex]));
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    return out;
  };
  P.readTerrain = function () { return this._read(this._cur('T'), 0, 0, this.nx, this.ny); };
  P.readWater = function () { return this._read(this._cur('W'), 0, 0, this.nx, this.ny); };
  P.readMoisture = function () { return this._read(this._cur('M'), 0, 0, this.nx, this.ny); };
  P.probe = function (mx, my) {
    const x = Math.min(this.nx - 1, Math.max(0, Math.floor(mx / this.dx))), y = Math.min(this.ny - 1, Math.max(0, Math.floor(my / this.dx)));
    const t = this._read(this._cur('T'), x, y, 1, 1), w = this._read(this._cur('W'), x, y, 1, 1), m = this._read(this._cur('M'), x, y, 1, 1);
    return { h: t[0], bed: t[1], cover: Math.round(t[2]), growth: t[3], depth: w[0], mud: w[1], speed: Math.hypot(w[2], w[3]), moist: m[0], soil: Math.round(m[1]) };
  };
  /** Flow (m³/s) and mud crossing the line between rows y and y+1, for columns x0..x1 (metres). */
  P.flowAcross = function (yMeters, x0, x1) {
    const j = Math.min(this.ny - 1, Math.floor(yMeters / this.dx)), i0 = Math.floor(x0 / this.dx), i1 = Math.min(this.nx, Math.ceil(x1 / this.dx));
    const F = this._read(this._cur('F'), i0, j, i1 - i0, 1), W = this._read(this._cur('W'), i0, j, i1 - i0, 1);
    let q = 0, mud = 0;
    for (let k = 0; k < i1 - i0; k++) {
      const fd = F[k * 4 + 3]; q += fd;
      const d = W[k * 4]; mud += fd * (d > 1e-4 ? Math.min(W[k * 4 + 1] / d, 0.3) : 0);
    }
    return { q, mudQ: mud };   // mudQ = m³/s of soil being carried
  };
  P.views = function () { return { T: this._cur('T'), W: this._cur('W'), M: this._cur('M'), nx: this.nx, ny: this.ny, dx: this.dx }; };

  Creek.Sim = Sim;
})();
