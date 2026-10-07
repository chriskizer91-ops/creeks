/* Web worker: builds a slab of the ranch terrain so several CPU cores can share the work. */
self.window = self;
importScripts('config.js', 'world.js');
onmessage = function (e) {
  const d = e.data, r = Creek.generateSlab(d.dx, d.j0, d.j1);
  postMessage(r, [r.T.buffer, r.M.buffer]);
};
