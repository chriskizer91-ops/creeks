/* The flat map view. Draws only — it reads the land/water data from the engine
   (sim.views()) and never changes it. A 3D view can be added later as another
   file that reads the same data and drapes the same contour lines over it. */
(function () {
  const C = Creek.CONFIG;
  const f = (a) => 'float[' + a.length + '](' + a.map(v => Number(v).toFixed(5)).join(',') + ')';

  const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.-1., 0., 1.); }`;

  const FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_T, u_W, u_M;
uniform ivec2 u_n; uniform float u_dx, u_time, u_scale, u_contour;
uniform vec2 u_res, u_cam, u_mapSize; uniform int u_lens;
uniform vec4 u_brush;            // x, y, radius (m), on
uniform vec4 u_hints[4]; uniform int u_nHints;
uniform vec4 u_barrels[4];       // x, y, count, fill
uniform int u_spouts; uniform vec2 u_spoutPos[4];
uniform vec4 u_tint;
const float ROOTD[10] = ${f(C.cover.rootDepth)};
out vec4 o;

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
ivec2 cl(ivec2 c){ return clamp(c, ivec2(0), u_n-ivec2(1)); }
vec4 bil(sampler2D s, vec2 w){
  vec2 g = w/u_dx-0.5; ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  return mix(mix(texelFetch(s,cl(i),0), texelFetch(s,cl(i+ivec2(1,0)),0), f.x),
             mix(texelFetch(s,cl(i+ivec2(0,1)),0), texelFetch(s,cl(i+ivec2(1,1)),0), f.x), f.y);
}
float hAt(vec2 w){ return bil(u_T,w).r; }
int coverAt(vec2 w){ return int(texelFetch(u_T, cl(ivec2(floor(w/u_dx))),0).b+.5); }
float ring(vec2 w, vec2 c, float r, float px){ return 1.-smoothstep(0.,px/u_scale, abs(length(w-c)-r)); }

void main(){
  vec2 fc = vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y);
  vec2 w = u_cam + (fc-0.5*u_res)/u_scale;
  vec3 paper = vec3(0.925,0.885,0.80)*(0.96+0.06*noise(fc*0.7));
  if (w.x<0.||w.y<0.||w.x>=u_mapSize.x||w.y>=u_mapSize.y){
    vec2 q = max(vec2(-w.x,-w.y), max(w-u_mapSize, 0.)); float sh = exp(-max(max(q.x,q.y),0.)*0.5/ (u_scale*0.06));
    o = vec4(paper*(1.-0.18*sh), 1.); return; }
  ivec2 c = cl(ivec2(floor(w/u_dx)));
  vec4 t = texelFetch(u_T,c,0), m = texelFetch(u_M,c,0);
  int ci = int(t.b+.5); float gr = t.a, soil = m.g, moist = m.r;
  float h = hAt(w);
  float n1 = noise(w*2.3), n2 = noise(w*9.), n3 = noise(w*31.);
  float thick = t.r - t.g;

  // --- ground colour
  vec3 clay = vec3(0.30,0.20,0.14), loam = vec3(0.66,0.50,0.33);
  vec3 dirt = mix(clay, loam, soil) * (0.88+0.24*n2) * (1.-0.30*moist);
  float rock = 1.-smoothstep(0.015, 0.08, thick);
  vec3 lime = vec3(0.90,0.85,0.72)*(0.92+0.12*n2) * (1.-0.06*step(0.78,n3));
  vec3 col = dirt;
  if (ci==1) col = mix(vec3(0.52,0.68,0.31), vec3(0.64,0.77,0.38), n1) * (0.94+0.10*n3);
  else if (ci==2){ vec3 g = mix(vec3(0.68,0.66,0.30), vec3(0.50,0.66,0.28), n1) * (0.9+0.2*step(0.6,n3)); col = mix(dirt, g, 0.3+0.7*gr); }
  else if (ci==3){ vec3 g = mix(vec3(0.17,0.36,0.17), vec3(0.30,0.50,0.22), n2) * (0.8+0.35*n3); col = mix(dirt, g, smoothstep(0.05,0.55,gr)); }
  else if (ci==4){ col = vec3(0.72,0.38,0.27)*(0.9+0.12*sin(w.y*7.)) ; }
  else if (ci==5){ col = vec3(0.79,0.75,0.69)*(0.95+0.08*n2); }
  else if (ci==6){ col = mix(dirt, vec3(0.45,0.62,0.28)*(0.85+0.3*n2), 0.35+0.65*gr); }
  else if (ci==7){ vec3 g = mix(vec3(0.48,0.62,0.30), vec3(0.38,0.55,0.26), n1);
    float fl = step(0.80, n3)*gr; g = mix(g, mix(vec3(0.62,0.42,0.72), vec3(0.97,0.82,0.30), step(0.5,hash(floor(w*9.)))), fl);
    col = mix(dirt*0.8, g, 0.3+0.7*gr); }
  else if (ci==8){ col = vec3(0.46,0.31,0.19)*(0.8+0.3*step(0.5,fract(w.x*3.5+w.y*0.4))); }
  else if (ci==9){ col = vec3(0.42,0.29,0.18); }
  if (ci!=4 && ci!=5 && ci!=8 && ci!=9) col = mix(col, lime, rock);

  // --- shaded relief (sun from the north-west, heights stretched so gentle slopes read)
  float e = u_dx;
  float hE=hAt(w+vec2(e,0.)), hW=hAt(w-vec2(e,0.)), hS=hAt(w+vec2(0.,e)), hN=hAt(w-vec2(0.,e));
  vec3 nrm = normalize(vec3(-(hE-hW)/(2.*e)*2.2, -(hS-hN)/(2.*e)*2.2, 1.));
  vec3 L = normalize(vec3(-0.62,-0.70,0.85));
  float sh = dot(nrm,L)/L.z;
  float lit = clamp(mix(1., sh, 0.8), 0.42, 1.45);
  // cast shadows from house and trees (towards the south-east)
  int cs = coverAt(w - vec2(1.3,1.5));
  if ((cs==4 && ci!=4) || (cs==3 && ci!=3)) lit *= 0.76;
  col *= lit;
  if (ci==4){ float edge = 1.-smoothstep(0.,0.5, min(min(abs(fract(w.x/1.0)-0.5),0.5), 0.5)); }

  if (u_lens==1){   // ground lens: soil type, wetness, and how deep roots reach
    vec3 s = mix(vec3(0.27,0.18,0.13), vec3(0.80,0.63,0.40), soil)*(1.-0.35*moist)*lit;
    float rd = ROOTD[ci]*gr; col = mix(s, vec3(0.20,0.50,0.18)*lit, clamp(rd/3.,0.,1.)*0.7);
    if (ci==4||ci==5) col = vec3(0.7)*lit;
  }

  // --- water
  vec4 wd = bil(u_W,w); float d = wd.r;
  if (d > 0.003){
    vec4 wn = texelFetch(u_W,c,0); vec2 v = wn.ba; float sp = length(v);
    float conc = clamp(wd.g/max(d,0.003), 0., 0.2), mud = smoothstep(0.,0.06,conc);
    vec3 wc = mix(vec3(0.33,0.62,0.74), vec3(0.58,0.40,0.25), mud);
    wc *= 1.-0.35*smoothstep(0.1,1.2,d);
    float ph = fract(u_time*0.6), w0 = 1.-abs(2.*ph-1.);
    float r0 = noise((w*2.4 - v*ph*0.8)*3.), r1 = noise((w*2.4 - v*fract(ph+.5)*0.8)*3.+7.3);
    float rip = r0*w0 + r1*(1.-w0);
    wc += 0.14*(rip-0.5)*(0.35+min(sp,3.)/3.);
    wc = mix(wc, vec3(0.97,0.95,0.90), smoothstep(0.62,0.82,rip)*smoothstep(1.2,2.8,sp)*0.8);
    float a = max(smoothstep(0.003,0.05,d)*0.86, mud*0.9);
    col = mix(col, wc*mix(1.,lit,0.5), a);
  }

  // --- contour lines
  if (u_contour > 0. && ci!=4){
    float a = h/u_contour, fw = clamp(fwidth(a),0.003,0.6);
    float ln = 1.-smoothstep(0.,1.4*fw, abs(fract(a-0.5)-0.5));
    float b = h/(u_contour*4.), fb = clamp(fwidth(b),0.003,0.6);
    float ln4 = 1.-smoothstep(0.,2.2*fb, abs(fract(b-0.5)-0.5));
    col = mix(col, vec3(0.42,0.25,0.12), clamp(0.40*ln + 0.45*ln4, 0., 0.85));
  }

  // --- things drawn on top: barrels, hints, brush
  for (int i=0;i<4;i++){ if (u_barrels[i].z > 0.){
      float dd = length(w-u_barrels[i].xy); float fill = u_barrels[i].w;
      if (dd < 0.55){ col = mix(vec3(0.12,0.28,0.22), vec3(0.30,0.60,0.78), step(dd/0.55, fill)*0.85); }
      if (dd < 0.62 && dd > 0.5) col = vec3(0.08,0.18,0.14); } }
  if (u_spouts==1) for (int i=0;i<4;i++){ float r = ring(w,u_spoutPos[i],0.9+0.1*sin(u_time*4.),2.5); col = mix(col, vec3(1.,0.85,0.3), r); }
  for (int i=0;i<4;i++){ if (i>=u_nHints) break;
    float pul = 0.5+0.5*sin(u_time*3.); float R = u_hints[i].z*(0.9+0.1*pul);
    col = mix(col, vec3(1.0,0.62,0.18), ring(w,u_hints[i].xy,R,3.)*0.95);
    col = mix(col, vec3(1.0,0.78,0.35), (1.-smoothstep(0.,R,length(w-u_hints[i].xy)))*0.10); }
  if (u_brush.w > 0.5){
    float r = ring(w,u_brush.xy,u_brush.z,2.2); float r2 = ring(w,u_brush.xy,u_brush.z+0.04+1.8/u_scale,1.6);
    col = mix(col, vec3(0.2,0.12,0.05), r2*0.55); col = mix(col, vec3(1.,0.98,0.9), r); }

  col = mix(col, u_tint.rgb, u_tint.a);
  col *= 0.975+0.05*noise(fc*0.9);
  o = vec4(col,1.);
}`;

  function Renderer(gl) {
    this.gl = gl;
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('render shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = this.p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('render link: ' + gl.getProgramInfoLog(p));
    this.u = {};
  }
  Renderer.prototype.draw = function (v, s, w, h) {
    const gl = this.gl, p = this.p;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h); gl.useProgram(p);
    const u = (n) => (n in this.u ? this.u[n] : (this.u[n] = gl.getUniformLocation(p, n)));
    [['u_T', v.T], ['u_W', v.W], ['u_M', v.M]].forEach(([n, t], k) => {
      gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u(n), k);
    });
    gl.uniform2i(u('u_n'), v.nx, v.ny); gl.uniform1f(u('u_dx'), v.dx);
    gl.uniform1f(u('u_time'), s.time); gl.uniform1f(u('u_scale'), s.cam.scale);
    gl.uniform1f(u('u_contour'), s.contour); gl.uniform2f(u('u_res'), w, h);
    gl.uniform2f(u('u_cam'), s.cam.x, s.cam.y); gl.uniform2f(u('u_mapSize'), C.mapW, C.mapH);
    gl.uniform1i(u('u_lens'), s.lens);
    gl.uniform4f(u('u_brush'), s.brush.x, s.brush.y, s.brush.r, s.brush.on ? 1 : 0);
    const hs = new Float32Array(16); (s.hints || []).slice(0, 4).forEach((q, k) => { hs[k * 4] = q.x; hs[k * 4 + 1] = q.y; hs[k * 4 + 2] = q.r; });
    gl.uniform4fv(u('u_hints'), hs); gl.uniform1i(u('u_nHints'), Math.min(4, (s.hints || []).length));
    const bs = new Float32Array(16); (s.barrels || []).slice(0, 4).forEach((q, k) => { bs[k * 4] = q.x; bs[k * 4 + 1] = q.y; bs[k * 4 + 2] = q.count; bs[k * 4 + 3] = q.fill; });
    gl.uniform4fv(u('u_barrels'), bs);
    gl.uniform1i(u('u_spouts'), s.spouts ? 1 : 0);
    const sp = new Float32Array(8); (s.spoutPos || []).forEach((q, k) => { sp[k * 2] = q.x; sp[k * 2 + 1] = q.y; });
    gl.uniform2fv(u('u_spoutPos'), sp);
    gl.uniform4fv(u('u_tint'), new Float32Array(s.tint || [0, 0, 0, 0]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  Creek.Renderer = Renderer;
})();
