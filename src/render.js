/* The flat map view. Draws only — it reads the land/water data from the engine
   (sim.views()) and never changes it. A 3D view can be added later as another
   file that reads the same data and drapes the same contour lines over it.

   Views (lens): 0 map · 1 soil health · 2 soil lost / gained since the start · 3 how deep the last flood got */
(function () {
  const C = Creek.CONFIG;

  const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.-1., 0., 1.); }`;

  const FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_T, u_W, u_M, u_C, u_I;
uniform ivec2 u_n; uniform float u_dx, u_time, u_scale, u_contour, u_hiH;
uniform vec2 u_res, u_cam, u_mapSize; uniform int u_lens;
uniform vec4 u_brush;            // x, y, radius (m), on
uniform vec4 u_hints[4]; uniform int u_nHints;
uniform vec4 u_tint;
out vec4 o;

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
vec2 hash2(vec2 p){ return vec2(hash(p), hash(p+vec2(17.3,5.1))); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
ivec2 cl(ivec2 c){ return clamp(c, ivec2(0), u_n-ivec2(1)); }
vec4 bil(sampler2D s, vec2 w){
  vec2 g = w/u_dx-0.5; ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
  return mix(mix(texelFetch(s,cl(i),0), texelFetch(s,cl(i+ivec2(1,0)),0), f.x),
             mix(texelFetch(s,cl(i+ivec2(0,1)),0), texelFetch(s,cl(i+ivec2(1,1)),0), f.x), f.y);
}
float hAt(vec2 w){ return bil(u_T,w).r; }
ivec2 cellOf(vec2 w){ return cl(ivec2(floor(w/u_dx))); }
float ring(vec2 w, vec2 c, float r, float px){ return 1.-smoothstep(0.,px/u_scale, abs(length(w-c)-r)); }
float crowns(vec2 w){            // distance to the nearest tree trunk, on a loose grid
  vec2 g = w/7., i = floor(g), f = fract(g); float md = 2.;
  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){ vec2 o2 = vec2(x,y); vec2 pnt = o2 + 0.25 + 0.5*hash2(i+o2); md = min(md, length(f-pnt)); }
  return md;
}

void main(){
  vec2 fc = vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y);
  vec2 w = u_cam + (fc-0.5*u_res)/u_scale;
  float fp = 1./u_scale;                                         // metres per pixel
  vec3 paper = vec3(0.925,0.885,0.80)*(0.96+0.06*noise(fc*0.7));
  if (w.x<0.||w.y<0.||w.x>=u_mapSize.x||w.y>=u_mapSize.y){
    vec2 q = max(vec2(-w.x,-w.y), max(w-u_mapSize, 0.)); float sh = exp(-max(max(q.x,q.y),0.)*u_scale*0.25);
    o = vec4(paper*(1.-0.20*sh), 1.); return; }
  ivec2 c = cellOf(w);
  vec4 t = texelFetch(u_T,c,0), m = texelFetch(u_M,c,0);
  int ci = int(t.b+.5); float gr = t.a, soil = m.g, moist = m.r, som = m.b; int fid = int(m.a+.5);
  float h = hAt(w);
  float zk = smoothstep(0.7, 3.2, u_scale);                      // fine detail fades in as you zoom in
  float nl = noise(w*0.011), nm = noise(w*0.07+3.), nh = noise(w*0.7)*zk + 0.5*(1.-zk);
  float thick = t.r - t.g;

  // --- ground colour
  vec3 clay = vec3(0.30,0.20,0.14), loam = vec3(0.66,0.50,0.33);
  vec3 dirt = mix(clay, loam, soil) * (0.9+0.2*nm) * (1.-0.28*moist);
  vec3 lime = vec3(0.90,0.85,0.72)*(0.94+0.1*nm);
  vec3 col = dirt;
  if (ci==1){ vec3 g1 = mix(vec3(0.66,0.60,0.36), vec3(0.47,0.66,0.28), gr); col = mix(g1, g1*vec3(0.85,0.9,0.7), nl) * (0.92+0.14*nm); col = mix(dirt, col, 0.35+0.65*smoothstep(0.05,0.5,gr)); }
  else if (ci==2){ vec3 g2 = mix(vec3(0.72,0.66,0.34), vec3(0.62,0.62,0.26), nl); col = mix(dirt, g2*(0.9+0.2*nm), 0.35+0.65*gr); col *= 0.94+0.12*step(0.62,nh); }
  else if (ci==3){ vec3 g3 = mix(vec3(0.15,0.33,0.16), vec3(0.28,0.47,0.20), nm) ; col = mix(dirt, g3, smoothstep(0.05,0.5,gr));
    if (zk > 0.05){ float cr = crowns(w); col *= mix(1., mix(1.28, 0.72, smoothstep(0.12,0.42,cr)), zk*smoothstep(0.2,0.7,gr)); } }
  else if (ci==4){ col = (hash(floor(w/20.))>0.5 ? vec3(0.72,0.38,0.27) : vec3(0.62,0.64,0.66)) * (0.92+0.08*sin(w.y*2.)); }
  else if (ci==5){ col = vec3(0.82,0.76,0.64)*(0.95+0.08*nm); }
  else if (ci==6){ col = mix(dirt, vec3(0.42,0.60,0.26)*(0.85+0.3*nm), 0.35+0.65*gr); }
  else if (ci==7){ vec3 g7 = mix(vec3(0.50,0.55,0.30), vec3(0.34,0.60,0.26), gr); col = mix(dirt, g7*(0.9+0.2*nl), 0.5+0.5*gr); }
  else if (ci==8){ col = vec3(0.46,0.31,0.19)*(0.85+0.3*step(0.5,fract(w.x*0.8+w.y*0.1))); }
  else if (ci==9){ vec3 g9 = mix(vec3(0.53,0.38,0.26), vec3(0.55,0.68,0.26), smoothstep(0.1,0.8,gr)); col = g9*(0.9+0.2*nl) * (0.95+0.1*nm); }
  else if (ci==10){ col = vec3(0.30,0.34,0.30)*(0.9+0.2*nm); }
  if ((ci==7||ci==9) && u_scale > 1.2){      // crop rows
    float ang = hash(vec2(float(fid),1.))*3.14159, s = dot(w, vec2(cos(ang),sin(ang)));
    float st = 0.5+0.5*sin(s*6.2832/3.2); col *= 1. - 0.13*st*smoothstep(1.2,3.,u_scale);
  }
  if (ci!=4 && ci!=5 && ci!=8) col = mix(col, lime, 1.-smoothstep(0.015, 0.08, thick));   // bare limestone

  // --- shaded relief (sun from the north-west; heights stretched so gentle slopes read)
  float e = max(u_dx, 0.9*fp);
  float hE=hAt(w+vec2(e,0.)), hW=hAt(w-vec2(e,0.)), hS=hAt(w+vec2(0.,e)), hN=hAt(w-vec2(0.,e));
  vec3 nrm = normalize(vec3(-(hE-hW)/(2.*e)*5., -(hS-hN)/(2.*e)*5., 1.));
  vec3 L = normalize(vec3(-0.62,-0.70,0.85));
  float sh = dot(nrm,L)/L.z;
  float lit = clamp(mix(1., sh, 0.9), 0.5, 1.4);
  if (ci==3 || ci==4){ int cs = int(texelFetch(u_T, cellOf(w - vec2(3.,3.5)),0).b+.5); if (cs!=ci && (cs==3||cs==4)) lit *= 0.8; }
  col *= lit;

  // --- views
  if (u_lens==1){                                                   // soil health: dark rich soil = lots of organic matter
    vec3 s = mix(vec3(0.80,0.66,0.42), vec3(0.22,0.14,0.09), clamp(som/0.7,0.,1.));
    s = mix(s, vec3(0.48,0.50,0.52), step(3.5,float(ci))*step(float(ci),5.5)*step(float(ci),5.5));
    col = s*lit*(1.-0.15*moist);
    if (ci==3||ci==2||ci==6) col = mix(col, vec3(0.15,0.45,0.15)*lit, 0.25*gr);
  } else if (u_lens==2){                                            // soil lost (red) / gained (blue) since the start
    float dlt = t.r - texelFetch(u_I,c,0).r;
    vec3 base = vec3(0.82,0.80,0.74)*lit;
    vec3 lost = vec3(0.86,0.22,0.12), gain = vec3(0.16,0.45,0.75);
    float a = smoothstep(0.03,0.9,abs(dlt));
    col = mix(base, dlt<0.?lost:gain, a);
  } else if (u_lens==3){                                            // how deep the last flood got
    vec4 cc = texelFetch(u_C,c,0); float dd = cc.b;
    vec3 base = mix(vec3(0.86,0.84,0.78)*lit, col, 0.35);
    vec3 shallow = vec3(0.60,0.80,0.90), deep = vec3(0.08,0.20,0.45);
    col = dd>0.05 ? mix(base, mix(shallow,deep,smoothstep(0.1,3.,dd)), 0.9) : base;
  }

  // --- water (several taps when zoomed out so thin creeks stay visible)
  if (u_lens==0){
    vec4 wd = bil(u_W,w); float d = wd.r;
    if (fp > u_dx*0.8){ float k = 0.5*fp; d = max(max(d, bil(u_W,w+vec2(k,0.)).r), max(bil(u_W,w-vec2(k,0.)).r, max(bil(u_W,w+vec2(0.,k)).r, bil(u_W,w-vec2(0.,k)).r))); }
    if (d > 0.003){
      vec4 wn = texelFetch(u_W,c,0); vec2 v = wn.ba; float sp = length(v);
      float conc = clamp(wd.g/max(wd.r,0.003), 0., 0.2), mud = smoothstep(0.,0.05,conc);
      vec3 wc = mix(vec3(0.33,0.62,0.74), vec3(0.58,0.40,0.25), mud);
      wc *= 1.-0.35*smoothstep(0.1,2.5,d);
      float ph = fract(u_time*0.6), w0 = 1.-abs(2.*ph-1.);
      float r0 = noise((w*0.35 - v*ph*0.5)*2.), r1 = noise((w*0.35 - v*fract(ph+.5)*0.5)*2.+7.3);
      float rip = r0*w0 + r1*(1.-w0);
      wc += 0.14*(rip-0.5)*(0.35+min(sp,4.)/4.)*zk;
      wc = mix(wc, vec3(0.97,0.95,0.90), smoothstep(0.62,0.82,rip)*smoothstep(1.5,3.5,sp)*0.7*zk);
      float a = max(smoothstep(0.003,0.06,d)*0.88, mud*0.9);
      col = mix(col, wc*mix(1.,lit,0.5), a);
    }
  }

  // --- field edges
  { float ef = max(0.9*fp, 0.3*u_dx); int f1 = int(texelFetch(u_M,cellOf(w+vec2(ef,0.)),0).a+.5), f2 = int(texelFetch(u_M,cellOf(w+vec2(0.,ef)),0).a+.5);
    if ((f1!=fid && f1!=0 && fid!=0) || (f2!=fid && f2!=0 && fid!=0)) col = mix(col, vec3(0.27,0.20,0.12), 0.38); }

  // --- contour lines
  if (u_contour > 0. && ci!=4){
    float a = h/u_contour, fw = clamp(fwidth(a),0.004,0.6);
    float ln = 1.-smoothstep(0.,1.3*fw, abs(fract(a-0.5)-0.5));
    float b = h/(u_contour*5.), fb = clamp(fwidth(b),0.004,0.6);
    float ln5 = 1.-smoothstep(0.,2.0*fb, abs(fract(b-0.5)-0.5));
    col = mix(col, vec3(0.42,0.25,0.12), clamp(0.36*ln + 0.5*ln5, 0., 0.85));
  }
  if (u_hiH > -100.){                                                // the contour you are following
    float fh = max(fwidth(h),1e-5), hi = 1.-smoothstep(1.2*fh, 2.6*fh, abs(h-u_hiH));
    col = mix(col, vec3(1.0,0.55,0.1), hi*(0.7+0.3*sin(u_time*5.)));
  }

  // --- hints, brush
  for (int i=0;i<4;i++){ if (i>=u_nHints) break;
    float pul = 0.5+0.5*sin(u_time*3.); float R = u_hints[i].z*(0.92+0.08*pul);
    col = mix(col, vec3(1.0,0.62,0.18), ring(w,u_hints[i].xy,R,3.5)*0.95);
    col = mix(col, vec3(1.0,0.78,0.35), (1.-smoothstep(0.,R,length(w-u_hints[i].xy)))*0.10); }
  if (u_brush.w > 0.5){
    float r = ring(w,u_brush.xy,u_brush.z,2.2); float r2 = ring(w,u_brush.xy,u_brush.z+1.8/u_scale,1.6);
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
    [['u_T', v.T], ['u_W', v.W], ['u_M', v.M], ['u_C', v.C], ['u_I', v.I]].forEach(([n, t], k) => {
      gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u(n), k);
    });
    gl.uniform2i(u('u_n'), v.nx, v.ny); gl.uniform1f(u('u_dx'), v.dx);
    gl.uniform1f(u('u_time'), s.time); gl.uniform1f(u('u_scale'), s.cam.scale);
    gl.uniform1f(u('u_contour'), s.contour); gl.uniform2f(u('u_res'), w, h);
    gl.uniform2f(u('u_cam'), s.cam.x, s.cam.y); gl.uniform2f(u('u_mapSize'), C.mapW, C.mapH);
    gl.uniform1i(u('u_lens'), s.lens); gl.uniform1f(u('u_hiH'), s.hiH == null ? -999 : s.hiH);
    gl.uniform4f(u('u_brush'), s.brush.x, s.brush.y, s.brush.r, s.brush.on ? 1 : 0);
    const hs = new Float32Array(16); (s.hints || []).slice(0, 4).forEach((q, k) => { hs[k * 4] = q.x; hs[k * 4 + 1] = q.y; hs[k * 4 + 2] = q.r; });
    gl.uniform4fv(u('u_hints'), hs); gl.uniform1i(u('u_nHints'), Math.min(4, (s.hints || []).length));
    gl.uniform4fv(u('u_tint'), new Float32Array(s.tint || [0, 0, 0, 0]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  Creek.Renderer = Renderer;
})();
