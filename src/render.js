/* The flat map view. Draws only — it reads the land/water data from the engine
   (sim.views()) and never changes it. All the colouring (ground, relief, water, contour lines, markers, storm light)
   lives in shade.js, which the 3D view (mod-view3d.js) uses too, so the two always look the same.
   This file only adds the camera of the flat map: pixels to metres, the paper around the ranch, rain on the glass.

   Views (lens): 0 map · 1 soil health · 2 soil lost / gained since the start · 3 how deep the last flood got
   Extras (state.extras, from other modules): flow lines, the trace, the section line, and the storm weather. */
(function () {
  const C = Creek.CONFIG, GL = Creek.GLSL;

  const VERT = GL.head({}) + `
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.-1., 0., 1.); }`;

  const FRAG = GL.head({ water: 1 }) + GL.core + GL.shade + `
uniform vec2 u_res, u_cam; uniform float u_scale;
out vec4 o;

void main(){
  vec2 fc = vec2(gl_FragCoord.x, u_res.y-gl_FragCoord.y);
  vec2 w = u_cam + (fc-0.5*u_res)/u_scale;
  float fp = 1./u_scale;                                         // metres per pixel
  vec3 col;
  if (w.x<0.||w.y<0.||w.x>=u_mapSize.x||w.y>=u_mapSize.y){        // the paper around the ranch, with a soft shadow at its edge
    vec3 paper = vec3(0.925,0.885,0.80)*(0.96+0.06*noise(fc*0.7));
    vec2 q = max(vec2(-w.x,-w.y), max(w-u_mapSize, 0.)); float sh = exp(-max(max(q.x,q.y),0.)*u_scale*0.25);
    col = paper*(1.-0.20*sh);
  } else {
    vec3 nrm = reliefNormal(w, max(u_dx, 0.9*fp), 5., 0., 1.);    // heights stretched so gentle slopes read
    float lit; col = shadeLand(w, fp, nrm, lit);
    col = mix(col, u_tint.rgb, u_tint.a);
    col = weatherGrade(col, w);
    col *= 0.975+0.05*noise(fc*0.9);
  }
  vec4 rn = rainOverlay(fc, vec2(0.));
  col = mix(col, rn.rgb, rn.a);
  o = vec4(col,1.);
}`;

  function Renderer(gl) {
    this.gl = gl;
    this.prog = new Creek.Shade.Program(gl, VERT, FRAG, 'map');
  }
  /** Draw the map. v = sim.views(), s = the state game.draw builds, w/h = canvas size in device pixels. */
  Renderer.prototype.draw = function (v, s, w, h) {
    const gl = this.gl, P = this.prog;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    Creek.Shade.bind(gl, P, s, v);
    gl.uniform2f(P.u('u_res'), w, h); gl.uniform2f(P.u('u_cam'), s.cam.x, s.cam.y); gl.uniform1f(P.u('u_scale'), s.cam.scale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  Creek.Renderer = Renderer;
})();
