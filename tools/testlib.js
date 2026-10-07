/* Test library for Creek Care: headless Chromium with SOFTWARE GL (there is no real GPU here).

   Usage (Node 22):
     const T = require("/home/user/creeks/tools/testlib.js");
     const t = await T.open({ root, query, viewport, dir, touch, ignore });
     ... await t.close();

   T.open(opts) -> Promise<t>
     opts.root      folder to serve (default: the repo root). Any folder with an index.html works, e.g. a git
                    export of an older commit, so you can compare before/after.
     opts.query     address query. A string ("level=3&quick=1") or an object ({level:3, quick:1, mods:"a,b"}).
                    Default: "level=3&quick=1&free=1" (4 m cells, short storms, skip the title card).
     opts.viewport  {width, height}. Default 1280x800. (Phone: {width:360, height:740}.)
     opts.touch     true = emulate a touch screen (hasTouch + isMobile).
     opts.dir       where shot() writes PNGs. Default /tmp/creek-work/shots.
     opts.ignore    extra console-error texts or RegExps to ignore (in addition to the 404s listed below).
     opts.waitReady false = do not wait for game.ready inside open() (default: wait).

   t.page                   the Playwright page.        t.browser   the Playwright browser.
   t.url                    the address that was opened. t.root, t.dir
   t.errors                 array of strings: every console "error" message and every uncaught page error.
                            404s for ranch-*.jpg and favicon are ignored on purpose (the game falls back).
   t.warnings               array of console "warning" strings.   t.logs   every console line, "type: text".
   t.shot(name)             screenshot of the page -> PNG in opts.dir. Returns the file path. Open it with the Read tool.
   t.eval(fn, arg)          run fn(arg) inside the page (page.evaluate). window.game is the game.
   t.waitReady(ms)          wait until window.game.ready (default 120000 ms).
   t.quickStorm(size, opts) start a turbo storm (size 1, 10 or 100) with game.draw switched off until it ends.
                            opts: timeout (ms, default 180000), tag, moist (passed to game.startStorm).
                            Resolves with a compact summary of game.lastStorm:
                              {size, tag, peakOut, volOut, rainVol, mudVol, mudConc, soilLost, infilVol, soakShare,
                               floodHa, somMean, groundwater, bankMean, gullyMean, seriesPoints, peakQin, peakQout,
                               lastT, wallMs}
                            Rejects (after stopping the storm) if it takes longer than the timeout.
   t.world(x, y)            world metres -> {x, y} in page pixels (uses game.project).
   t.drag(points, opts)     mouse press at points[0], move through the rest, release. points are page pixels.
                            opts: {steps: moves between points (default 4), button: "left"|"right"|"middle"}
   t.tap(x, y)              click at page pixels.
   t.press(key)             keyboard press (Playwright key names: "z", "?", "1", "Shift+/").
   t.frames(n)              wait n animation frames. t.sleep(ms) waits.
   t.close()                close the browser and the little web server. Always call it (use try/finally).

   T.REPO, T.DEFAULT_QUERY, T.serve(root) (the static server alone: resolves {port, close()}), T.sleep(ms).

   Software GL is about 100x slower than a real GPU: ignore frame rates, judge correctness and LOOK at the PNGs.
   For functional tests always use level=3 and quick=1; never run storms at level 0 or 1. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const PW = '/opt/node22/lib/node_modules/playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const REPO = path.resolve(__dirname, '..');
const DEFAULT_QUERY = 'level=3&quick=1&free=1';
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox',
  '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny static file server on an ephemeral port. Resolves {port, close()}. */
function serve(root) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad url'); return; }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('no'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); })
    }));
  });
}

function toQuery(q) {
  if (q == null) q = DEFAULT_QUERY;
  if (typeof q === 'object') q = Object.keys(q).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  q = String(q).replace(/^\?/, '');
  return q ? '?' + q : '';
}

async function open(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || REPO), dir = opts.dir || '/tmp/creek-work/shots';
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = require(PW);
  const srv = await serve(root);
  let browser = null;
  const t = { root, dir, errors: [], warnings: [], logs: [] };
  const ignore = (opts.ignore || []).map((x) => (x instanceof RegExp ? x : new RegExp(String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
  const ignorable = (text, url) => /ranch-[\w-]*\.jpg|favicon/.test(url || '') || ignore.some((r) => r.test(text) || r.test(url || ''));
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ARGS });
    const vp = opts.viewport || { width: 1280, height: 800 };
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: opts.dpr || 1, hasTouch: !!opts.touch, isMobile: !!opts.touch });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      const text = m.text(), type = m.type(), url = (m.location() && m.location().url) || '';
      t.logs.push(type + ': ' + text);
      if (type === 'error') { if (!ignorable(text, url)) t.errors.push(text + (url ? '  [' + url + ']' : '')); }
      else if (type === 'warning') t.warnings.push(text);
    });
    page.on('pageerror', (e) => { const text = 'pageerror: ' + (e && e.stack ? e.stack : e); if (!ignorable(text, '')) t.errors.push(text); });
    t.browser = browser; t.page = page; t.url = 'http://127.0.0.1:' + srv.port + '/index.html' + toQuery(opts.query);

    t.shot = async (name) => {
      const file = path.join(dir, /\.png$/i.test(name) ? name : name + '.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      return file;
    };
    t.eval = (fn, arg) => page.evaluate(fn, arg);
    t.waitReady = (ms) => page.waitForFunction(() => window.game && window.game.ready, null, { timeout: ms || 120000, polling: 100 });
    t.sleep = sleep;
    t.frames = (n) => page.evaluate((k) => new Promise((res) => { let i = 0; const f = () => { if (++i >= k) res(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n || 1);
    t.world = (x, y) => page.evaluate(([a, b]) => { const p = window.game.project(a, b); return p && { x: p.x, y: p.y }; }, [x, y]);
    t.tap = (x, y) => page.mouse.click(x, y);
    t.press = (key) => page.keyboard.press(key);
    t.drag = async (pts, o) => {
      o = o || {}; const steps = o.steps || 4, button = o.button || 'left';
      await page.mouse.move(pts[0].x, pts[0].y);
      await page.mouse.down({ button });
      for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i].x, pts[i].y, { steps });
      await page.mouse.up({ button });
    };
    t.quickStorm = async (size, o) => {
      o = o || {};
      const timeout = o.timeout || 180000, sopts = Object.assign({}, o); delete sopts.timeout;
      return page.evaluate(([sz, so, to]) => new Promise((resolve, reject) => {
        const g = window.game, t0 = performance.now();
        if (!g || !g.ready) return reject(new Error('game is not ready'));
        if (g.storm) return reject(new Error('a storm is already running'));
        g.draw = function () {};                                   // no drawing while the storm runs (software GL is slow)
        const restore = () => { delete g.draw; };
        if (!g.startStorm(sz, Object.assign({ turbo: true }, so))) { restore(); return reject(new Error('startStorm refused')); }
        const iv = setInterval(() => {
          if (g.storm) {
            if (performance.now() - t0 > to) { clearInterval(iv); const tt = g.storm.t; try { g.stopStorm(); } catch (e) {} restore(); reject(new Error('storm timed out after ' + to + ' ms (sim time ' + Math.round(tt) + ' s)')); }
            return;
          }
          clearInterval(iv); restore();
          const r = g.lastStorm, s = r.series;
          resolve({
            size: r.size, tag: r.tag, peakOut: r.peakOut, volOut: r.volOut, rainVol: r.rainVol, mudVol: r.mudVol, mudConc: r.mudConc, soilLost: r.soilLost,
            infilVol: r.infilVol, soakShare: r.soakShare, floodHa: r.floodHa, somMean: r.somMean, groundwater: r.groundwater,
            bankMean: r.an && r.an.bankMean, gullyMean: r.an && r.an.gullyMean,
            seriesPoints: s ? s.t.length : null, peakQin: s ? Math.max.apply(null, s.Qin) : null, peakQout: s ? Math.max.apply(null, s.Qout) : null,
            lastT: s ? s.t[s.t.length - 1] : null, wallMs: Math.round(performance.now() - t0)
          });
        }, 100);
      }), [size, sopts, timeout]);
    };
    t.close = async () => {
      try { if (browser) await browser.close(); } catch (e) {}
      try { await srv.close(); } catch (e) {}
    };
    await page.goto(t.url, { waitUntil: 'load' });
    if (opts.waitReady !== false) await t.waitReady();
    return t;
  } catch (e) {
    try { if (browser) await browser.close(); } catch (e2) {}
    try { await srv.close(); } catch (e2) {}
    throw e;
  }
}

module.exports = { open, serve, sleep, REPO, DEFAULT_QUERY, CHROME };
