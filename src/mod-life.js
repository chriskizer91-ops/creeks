/* Ranch health, postcards and neighbours. Module id "life". Exposes Creek.life and Creek.neighbors.
   - Ranch health: one number from 0 to 100 made of six simple parts (soil, ground cover, deep-rooted plants, creek banks, rain that soaks in,
     the creek in dry weather), with a friendly panel that says in plain words what each part means and what would help.
   - Postcards: seven painted pictures that unlock when something good happens on the ranch. A small toast tells you; it never blocks play.
   - Neighbours: once a year, if the health number went up by 5 or more, one more neighbour upstream tries your methods, which makes the
     water arriving from upstream a little smaller (game.upstreamFactor). A letter says so.
   Reading the land costs a GPU read-back, so the numbers are worked out only when a season ends, when a storm ends and when the panel
   opens, and kept for as long as the land has not changed (game.terrainVersion). Never per frame.
   Other code can use: Creek.life.score() / check() / postcards(), Creek.neighbors.state() / factor(). */
(function () {
  const C = Creek.CONFIG, CV = C.COVER;
  const EX = 'assets/extras/';
  const FT = 3.281;
  const START_GW = 9000;                                   // the groundwater the ranch starts with (game.groundwater)
  const START_BASE = START_GW * 1.5e-3;                    // ...which is this many litres a second of dry-weather creek (game.baseflow())
  const STEP = 0.04, FLOOR = 0.75;                         // each neighbour: 4% less water from upstream, never below 75%
  const NEED_RISE = 5;                                     // health points a year must gain for a neighbour to join
  const esc = (t) => (Creek.ui && Creek.ui.esc ? Creek.ui.esc(t) : String(t));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const warned = {};
  function guard(what, fn) {
    try { return fn(); } catch (e) { if (!warned[what]) { warned[what] = 1; try { console.warn('[creek] life: ' + what + ' failed:', e); } catch (x) { /* ignore */ } } }
  }

  let game = null, ui = null;
  let startStats = null;       // the land as it was handed to you, worked out from the world data (no GPU read)
  let cur = null;              // the last measurement of the real land: {ver, sim, ...stats}

  // ---------------------------------------------------------------- measuring the land
  /** Count what is on the land. T = terrain texture data (height, rock, cover, growth), M = ground data (moisture, soil, organic matter, field). */
  function statsFrom(T, M) {
    const g = game, n = g.sim.nx * g.sim.ny, isField = g.fields.map((f) => f.kind === 'field');
    let somSum = 0, somN = 0, land = 0, live = 0, per = 0, pond = 0, dam = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 4, c = Math.round(T[k + 2]);
      if (c === CV.POND) pond++; else if (c === CV.DAM) dam++;
      const fid = Math.round(M[k + 3]); if (fid < 1) continue;
      land++;
      if (isField[fid - 1]) { somSum += M[k + 2]; somN++; }
      // living cover: something green and growing, or crop residue left on the ground
      if (c === CV.COVERCROP || ((c === CV.PASTURE || c === CV.PRAIRIE || c === CV.TREE || c === CV.WILLOW || c === CV.CROP) && T[k + 3] > 0.5)) live++;
      if (c === CV.PASTURE || c === CV.PRAIRIE || c === CV.TREE || c === CV.WILLOW) per++;
    }
    const an = g.analyze(T);
    return { som: somN ? somSum / somN : 0, live: land ? live / land : 0, per: land ? per / land : 0, pond, dam, mainH: an.main.mean, gullyH: an.gullyMean };
  }
  /** The measurement of the real land now, reusing the last one if the land has not changed. Never reads while a storm is running. */
  function stats(force) {
    const g = game; if (!g || !g.ready || !g.sim) return startStats;
    if (cur && cur.sim === g.sim && !force && (cur.ver === g.terrainVersion || g.storm)) return cur;
    if (g.storm && !cur) return startStats;
    const r = guard('measure', () => { const T = g.sim.readTerrain(), M = g.sim.readMoisture(), s = statsFrom(T, M); s.ver = g.terrainVersion; s.sim = g.sim; return s; });
    if (r) cur = r;
    return cur || startStats;
  }

  // ---------------------------------------------------------------- the six parts of ranch health
  const PARTS = [
    { id: 'som', label: 'Rich soil', w: 20 },
    { id: 'cover', label: 'Covered ground', w: 15 },
    { id: 'roots', label: 'Deep roots', w: 17 },
    { id: 'banks', label: 'Creek banks', w: 22 },
    { id: 'soak', label: 'Rain soaks in', w: 18 },
    { id: 'flow', label: 'Creek in dry weather', w: 8 }
  ];
  const pc = (v) => Math.round(v * 100) + '%';
  const ft1 = (m) => (m * FT).toFixed(1);

  /** Work out the parts from a measurement and the facts about storms and groundwater. Pure: touches nothing. */
  function buildScore(st, env) {
    const init = env.init || { main: { mean: st.mainH }, gullyMean: st.gullyH };
    const mainR = init.main.mean > 0 ? st.mainH / init.main.mean : 1, gulR = init.gullyMean > 0 ? st.gullyH / init.gullyMean : 1;
    const ratio = (mainR + gulR) / 2;                        // 1 = as tall as the start, 0.5 = half as tall
    const parts = [];
    const add = (id, value, raw, text, tip, known) => {
      const d = PARTS.find((p) => p.id === id);
      parts.push({ id, label: d.label, value: Math.round(clamp(value, 0, 100)), raw, text, tip, known: known !== false, weight: d.w });
    };
    add('som', (st.som - 0.15) / 0.5 * 100, st.som,
      'Soil is full of bits of old plants and roots, and that holds water like a sponge. Yours is ' + pc(st.som) + ' of this stuff.',
      'No-till fields with cover crops, and cattle that move often, both build richer soil.');
    add('cover', (st.live - 0.4) / 0.55 * 100, st.live,
      'Growing plants and left-over stalks cover the ground like a blanket, so raindrops do not hit bare dirt. ' + pc(st.live) + ' of your land is covered' +
      (env.season && env.season !== 'summer' && env.season !== 'spring' ? ' (plowed fields sit bare in ' + env.season + ')' : '') + '.',
      'Cover crops and no-till keep a blanket on the fields all year.');
    add('roots', (st.per - 0.45) / 0.5 * 100, st.per,
      'Prairie grass, pasture, trees and willows live for years and their roots go deep. ' + pc(st.per) + ' of your land has them.',
      'Plant native prairie or trees on a tilled field, or put willow stakes along the creek.');
    add('banks', 100 * (1.25 - ratio) / 0.75, ratio,
      'Tall bare banks crumble into the creek. Plum Creek’s banks are ' + ft1(st.mainH) + ' feet tall and the gullies ' + ft1(st.gullyH) + ' feet (at the start: ' + ft1(init.main.mean) + ' and ' + ft1(init.gullyMean) + ').',
      'Check dams build the creek bed back up. Digging a bank back and planting it lets the water spread out.');
    if (env.storm) {
      const so = env.storm.soakShare;
      add('soak', so / 0.45 * 100, so,
        'In the last storm, ' + pc(so) + ' of the rain soaked into the ground. The rest ran off.',
        'Swales, ponds, rich soil and deep roots all help rain soak in.');
    } else {
      add('soak', 0, null, 'Send a storm to find out how much of the rain soaks in.', 'Swales, ponds, rich soil and deep roots all help rain soak in.', false);
    }
    const bf = Math.max(env.bf, 0.01), fv = 35 + 35 * Math.log(bf / START_BASE) / Math.log(4);
    add('flow', fv, bf,
      'When it has not rained for a while, the creek still trickles with water that soaked in earlier. Right now it is about ' + (bf >= 10 ? Math.round(bf) : bf.toFixed(1)) + ' litres a second.',
      'The more rain soaks in, the longer the creek keeps flowing.');
    return finish(parts);
  }
  /** Weighted total of the known parts (0..100). `only` limits it to some part ids. */
  function totalOf(parts, only) {
    let s = 0, w = 0;
    parts.forEach((p) => { if (p.known && (!only || only.indexOf(p.id) >= 0)) { s += p.value * p.weight; w += p.weight; } });
    return w ? s / w : 0;
  }
  function finish(parts) {
    const total = Math.round(totalOf(parts) * 10) / 10;
    return { total, parts };
  }
  function envNow() {
    const g = game;
    return { storm: g.lastStorm || g.baseline || null, bf: g.baseflow(), init: g.initialAnalysis, season: g.season };
  }
  let lastScore = null;
  /** {total 0..100, parts: [{id, label, value 0..100, raw, text, tip, known}]}. Reads the land only if it has changed since the last time. */
  function score(force) {
    if (!game || !game.ready) return lastScore;
    const st = stats(force); if (!st) return lastScore;
    lastScore = guard('score', () => buildScore(st, envNow())) || lastScore;
    return lastScore;
  }

  // ---------------------------------------------------------------- state that is saved
  const flags = { roots: false, willow: false, pond: false, dig: [] };       // what the player has done on this ranch
  const nb = { count: 0, letters: [], prev: null };                          // neighbours: how many, their letters, last year's scores
  const unlocked = {};                                                       // postcards: id -> time. Kept between ranches (it is a collection).

  function loadUnlocked() {
    try { const o = JSON.parse(localStorage.getItem('creek.postcards') || 'null'); if (o && o.ids) o.ids.forEach((id) => { unlocked[id] = unlocked[id] || 1; }); } catch (e) { /* no storage: fine */ }
  }
  function saveUnlocked() { try { localStorage.setItem('creek.postcards', JSON.stringify({ ids: Object.keys(unlocked) })); } catch (e) { /* ignore */ } }
  const snapOf = (sc, year) => { const v = {}; sc.parts.forEach((p) => { if (p.known) v[p.id] = p.value; }); return { year, vals: v }; };
  /** Weighted total of last year's and this year's values for the parts both of them know about, so the two are fairly compared. */
  function compare(a, b) {
    const ids = PARTS.filter((p) => a.vals[p.id] != null && b.vals[p.id] != null);
    if (!ids.length) return 0;
    let sa = 0, sb = 0, w = 0; ids.forEach((p) => { sa += a.vals[p.id] * p.w; sb += b.vals[p.id] * p.w; w += p.w; });
    return (sb - sa) / w;
  }

  // ---------------------------------------------------------------- postcards
  const CARDS = [
    { id: 'making-room-for-roots', title: 'Making room for roots', img: EX + 'making-room-for-roots.jpg', square: false,
      hint: 'Dig a creek bank back to a gentler slope, then plant it.',
      caption: 'You gave the creek room and then tucked plants into the new slope. Roots hold soil together like tiny fingers, so a gentle, planted bank stays put when the water rises. It is quiet work, and it lasts.' },
    { id: 'willow-work', title: 'Willow work', img: EX + 'willow-work.jpg', square: false,
      hint: 'Plant willow stakes along a creek bank.',
      caption: 'Willow sticks pushed into the mud will sprout, even in winter. Their roots grab the bank and their branches slow the water down. Everyone can help with this job, young or old.' },
    { id: 'prairie-visitors', title: 'Prairie visitors', img: EX + 'prairie-visitors.jpg', square: true,
      hint: 'Grow deep-rooted native plants on much more of the ranch.',
      caption: 'The tall prairie flowers are back, and so are the butterflies, the bees and a painted bunting. When the land grows plants that belong here, wild neighbours come to visit and some of them stay.' },
    { id: 'first-flow', title: 'First flow', img: EX + 'first-flow.jpg', square: false,
      hint: 'Make the creek banks or the gullies 15% shorter than at the start.',
      caption: 'The banks are lower and the creek is finding its feet again. You stand and watch the water move slowly over the rocks. This is what a healing creek looks like.' },
    { id: 'turtle-return', title: 'Turtle return', img: EX + 'turtle-return.jpg', square: true,
      hint: 'Dig a pond, and get the dry-weather creek running better than when you began.',
      caption: 'A turtle is sunning itself on a warm rock, and tiny fish dart in the clear water below. A pond and a creek that keeps flowing give wild animals a place to live. They noticed before anyone told them.' },
    { id: 'heron-at-dawn', title: 'Heron at dawn', img: EX + 'heron-at-dawn.jpg', square: false,
      hint: 'Raise your ranch health to 60.',
      caption: 'Early in the morning, mist rises off the creek and a great blue heron stands in the shallows. Herons only come where there is food and clean water. Your ranch is getting healthy enough to feed one.' },
    { id: 'creekside-evening', title: 'Creekside evening', img: EX + 'creekside-evening.jpg', square: false,
      hint: 'Raise your ranch health to 80.',
      caption: 'The family comes down to the creek at sunset. The water runs clear, fireflies drift over the flowers, and nobody is worried about the next big storm. This is what all that hard work was for.' }
  ];
  const cardById = (id) => CARDS.find((c) => c.id === id);
  /** The tests. `x` is what we know now: score pieces may be null when only a quick check (no land reading) was done. */
  const TESTS = {
    'making-room-for-roots': (x) => flags.roots,
    'willow-work': (x) => flags.willow,
    'prairie-visitors': (x) => x.per != null && x.per >= 0.80,
    'first-flow': (x) => x.mainDrop != null && (x.mainDrop >= 0.15 || x.gullyDrop >= 0.15),
    'turtle-return': (x) => (flags.pond || (x.pond != null && x.pond > 0)) && x.bf > START_BASE,
    'heron-at-dawn': (x) => x.total != null && x.total >= 60,
    'creekside-evening': (x) => x.total != null && x.total >= 80
  };
  let toasts = [], toastEl = null, toastTimer = 0, pumpTimer = 0, letterQueue = [];

  /** Look at what we know and unlock any postcard whose moment has come. `full`: also use the land measurement (a GPU read if it changed). */
  function check(full) {
    if (!game || !game.ready) return [];
    const x = { bf: game.baseflow(), total: null, per: null, pond: null, mainDrop: null, gullyDrop: null };
    const sc = full ? score() : lastScore, st = full ? cur || stats() : cur;
    if (sc) x.total = sc.total;
    if (st && (full || (st.sim === game.sim && st.ver === game.terrainVersion))) {
      x.per = st.per; x.pond = st.pond;
      const A = game.initialAnalysis;
      if (A) { x.mainDrop = A.main.mean > 0 ? 1 - st.mainH / A.main.mean : 0; x.gullyDrop = A.gullyMean > 0 ? 1 - st.gullyH / A.gullyMean : 0; }
    }
    const fresh = [];
    CARDS.forEach((c) => { if (!unlocked[c.id] && guard('test ' + c.id, () => TESTS[c.id](x))) fresh.push(c.id); });
    fresh.forEach(unlock);
    return fresh;
  }
  function unlock(id) {
    if (unlocked[id]) return false;
    unlocked[id] = Date.now(); saveUnlocked(); updateMenuLabel();
    toasts.push(id); pump();
    if (Creek.audio && Creek.audio.chime) guard('chime', () => Creek.audio.chime());
    renderPanel();
    return true;
  }
  function postcards() {
    return CARDS.map((c) => ({ id: c.id, title: c.title, hint: c.hint, caption: c.caption, img: c.img, unlocked: !!unlocked[c.id] }));
  }
  function modalOpen() { const m = document.getElementById('modal'); return !!(m && !m.classList.contains('hidden')); }

  // ---- the small "new postcard" note (does not block play) and the letters, both held back while a big card is open
  function pump() {
    if (!pumpTimer && (toasts.length || letterQueue.length)) pumpTimer = setInterval(() => guard('pump', pumpTick), 500);
  }
  function pumpTick() {
    if (!toasts.length && !letterQueue.length) { clearInterval(pumpTimer); pumpTimer = 0; return; }
    if (modalOpen() || !game.ready) return;
    if (letterQueue.length && !game.storm) { showLetter(letterQueue.shift()); return; }
    if (toasts.length && !toastEl.classList.contains('lf-on')) showToast(toasts.shift());
  }
  function placeToast() {
    const hint = document.getElementById('hint'), h = hint && !hint.classList.contains('hidden') ? hint.offsetHeight + 8 : 0;
    toastEl.style.bottom = 'calc(' + (150 + h) + 'px + env(safe-area-inset-bottom, 0px))';
  }
  function showToast(id) {
    const c = cardById(id); if (!c) return;
    toastEl.innerHTML = '<img alt="" src="' + esc(c.img) + '"><div class="lf-tt"><small>New postcard</small><b>' + esc(c.title) + '</b></div>' +
      '<button class="go lf-see">See it</button><button class="lf-x" aria-label="Close">✕</button>';
    toastEl.querySelector('.lf-see').onclick = () => { hideToast(); showPostcard(id); };
    toastEl.querySelector('.lf-x').onclick = hideToast;
    placeToast(); toastEl.classList.add('lf-on');
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 10000);
  }
  function hideToast() { clearTimeout(toastTimer); toastEl.classList.remove('lf-on'); }

  function showPostcard(id, fromGallery) {
    const c = cardById(id); if (!c) return Promise.resolve();
    return ui.card({ img: [c.img], square: c.square, title: c.title, text: c.caption,
      buttons: [{ label: fromGallery ? 'Back to postcards' : 'Lovely', value: 'ok' }].concat(fromGallery ? [] : [{ label: 'All postcards', value: 'all', alt: true }]) })
      .then((v) => { if (fromGallery || v === 'all') openGallery(); });
  }
  function openGallery() {
    const n = CARDS.filter((c) => unlocked[c.id]).length;
    const tiles = CARDS.map((c, i) => {
      const on = !!unlocked[c.id];
      return '<button class="lf-tile' + (on ? '' : ' lock') + '" data-i="' + i + '"' + (on ? '' : ' disabled') + '><span class="lf-img"><img alt="" src="' + esc(c.img) + '"></span>' +
        '<b>' + (on ? esc(c.title) : 'A postcard to find') + '</b>' + (on ? '' : '<small>' + esc(c.hint) + '</small>') + '</button>';
    }).join('');
    ui.card({ title: 'Postcards (' + n + ' of ' + CARDS.length + ')', text: 'Pictures from your ranch. Each one arrives when something good happens here.',
      html: '<div class="lf-grid">' + tiles + '</div>', buttons: [{ label: 'Close' }],
      onShow: (card) => card.querySelectorAll('.lf-tile:not(.lock)').forEach((b) => { b.onclick = () => { ui.closeCard(); showPostcard(CARDS[+b.dataset.i].id, true); }; }) });
  }
  let menuItem = null;
  function updateMenuLabel() { if (menuItem) menuItem.label = 'Postcards (' + CARDS.filter((c) => unlocked[c.id]).length + ' of ' + CARDS.length + ')'; }

  // ---------------------------------------------------------------- stroke clues (no land reading needed)
  /** Is this point within a bank's reach of one of the creeks? */
  function nearBank(x, y) {
    const S = game.world && game.world.meta && game.world.meta.samples; if (!S) return false;
    for (let i = 0; i < S.length; i++) { const s = S[i], r = s.wb + s.run + 10, dx = x - s.x, dy = y - s.y; if (dx * dx + dy * dy < r * r) return true; }
    return false;
  }
  function onStrokeEnd(e) {
    if (!e || e.cancelled || !game.ready) return;
    const path = e.path || [];
    if (e.tool === 'dig') {
      for (let i = 0; i < path.length && flags.dig.length < 160; i += 2) if (nearBank(path[i].x, path[i].y)) flags.dig.push([Math.round(path[i].x), Math.round(path[i].y)]);
    } else if (e.tool === 'plant') {
      if (e.opt === 'willow' && (e.cost > 0 || path.length > 2)) flags.willow = true;
      if (flags.dig.length && !flags.roots) {
        outer: for (let i = 0; i < path.length; i++) for (let k = 0; k < flags.dig.length; k++) {
          const dx = path[i].x - flags.dig[k][0], dy = path[i].y - flags.dig[k][1];
          if (dx * dx + dy * dy < 15 * 15) { flags.roots = true; break outer; }
        }
      }
    } else if (e.tool === 'pond') flags.pond = true;
    check(false);
  }

  // ---------------------------------------------------------------- neighbours
  const NEIGHBOURS = [
    { name: 'Hank Alvarez', say: { soil: 'I saw how dark and crumbly your soil has got, and the cover crop growing between the rows.', cover: 'Your fields were never bare this year, not even in winter.', roots: 'All that native grass you planted is waving in the wind.', banks: 'I walked your creek and the banks are lower and greener than I remember.', soak: 'After the rain, your fields soaked it up while mine ran like a river.', flow: 'Your creek kept running in the dry weeks, and mine did not.' } },
    { name: 'June Whitfield', say: { soil: 'My grandson dug a hole in your field and the soil was full of worms.', cover: 'That green blanket on your fields made me stop my truck.', roots: 'The roots on your prairie go down taller than my grandson.', banks: 'The check dams in your creek are holding mud back like little steps.', soak: 'Your ground drinks the rain. Mine just sheds it.', flow: 'A trickle of water in August! I had forgotten what that looked like.' } },
    { name: 'Dolores Ortiz', say: { soil: 'I hear your soil is getting richer every year.', cover: 'You keep something growing on the ground all the time.', roots: 'You have planted trees and grass where I only ever plowed.', banks: 'Your banks used to be a crumbling wall, and look at them now.', soak: 'You hold the rain on your land, and I want to do that too.', flow: 'The creek running by your fence in dry weather made my whole family smile.' } },
    { name: 'Walt Tanner', say: { soil: 'I put a shovel in your dirt and it was dark all the way down.', cover: 'I am tired of bare fields in winter, so I am following your lead.', roots: 'Deep-rooted grass is tougher than it looks.', banks: 'You fixed your banks one little piece at a time, and that worked.', soak: 'More water soaking in means less water rushing past my gate.', flow: 'Water in the creek in summer. It is a small thing and it is also not small.' } },
    { name: 'Priya and Sam Nair', say: { soil: 'The kids are counting earthworms in your soil.', cover: 'We saw the stubble you left on your fields and tried it on ours.', roots: 'We planted a strip of prairie flowers and the bees found it in a day.', banks: 'Your creek banks look strong, and we want ours to look like that.', soak: 'The rain soaks in at your place. We are going to dig a swale and see.', flow: 'Our children saw minnows in your creek this summer.' } },
    { name: 'Old Mr. Bell', say: { soil: 'My daddy farmed this valley and I never saw soil this dark.', cover: 'Covering the ground is the oldest trick there is, and you remembered it.', roots: 'I remember when this valley was all tall grass. It is coming back.', banks: 'I remember a creek with gentle banks. You are bringing it back.', soak: 'When I was a boy the rain soaked in. I am glad to see it do that again.', flow: 'I remember this creek running all summer long. Thank you.' } },
    { name: 'The Rivera family', say: { soil: 'We learned about no-till from you and our soil is already softer.', cover: 'We planted cover crops this fall, just like you.', roots: 'We have a hill that nobody farms, so we are putting prairie on it.', banks: 'A neighbour who fixes her creek is a neighbour worth copying.', soak: 'We tried a pond and a swale. The water stays put now.', flow: 'We are trying to get water to stay in our creek too.' } }
  ];
  const DRIVER = { som: 'soil', cover: 'cover', roots: 'roots', banks: 'banks', soak: 'soak', flow: 'flow' };
  const factorOf = (count) => Math.max(FLOOR, 1 - STEP * count);
  function applyFactor() { if (game) game.upstreamFactor = factorOf(nb.count); }
  function effectText() {
    const less = Math.round((1 - factorOf(nb.count)) * 100);
    return 'The water arriving from upstream is now ' + less + '% less' + (nb.count > 1 ? ' than when you started' : '') + '.' + (factorOf(nb.count) <= FLOOR ? ' That is as much as neighbours can change it.' : '');
  }
  /** Called when spring turns into summer. A neighbour joins if the health number rose enough since last year. */
  function yearEnd(sc, year) {
    const snap = snapOf(sc, year), prev = nb.prev;
    nb.prev = snap;
    if (!prev || nb.count >= Math.ceil((1 - FLOOR) / STEP)) return false;
    const rise = compare(prev, snap);
    nb.lastRise = Math.round(rise * 10) / 10;
    if (rise < NEED_RISE) return false;
    // the part that improved the most, so the letter talks about something the player really did
    let best = 'soil', gain = -1e9;
    PARTS.forEach((p) => { if (prev.vals[p.id] != null && snap.vals[p.id] != null) { const d = (snap.vals[p.id] - prev.vals[p.id]) * p.w; if (d > gain) { gain = d; best = DRIVER[p.id]; } } });
    const who = NEIGHBOURS[nb.count % NEIGHBOURS.length];
    nb.count++; applyFactor();
    const letter = { year, name: who.name, text: 'Hello over the fence! ' + who.say[best] + ' So I am going to try your ways on my land this year. Wish me luck. — ' + who.name, effect: effectText() };
    nb.letters.push(letter); letterQueue.push(letter); pump(); renderPanel();
    return true;
  }
  function showLetter(l) {
    ui.card({ img: ui.PICS.neighbors, title: 'A letter from ' + l.name, text: l.text,
      html: '<p class="t lf-effect">' + esc(l.effect) + '</p>', buttons: [{ label: 'How kind!' }] });
  }
  function showAllLetters() {
    const html = nb.letters.length ? nb.letters.map((l) => '<p class="t"><b>' + esc(l.name) + '</b> · year ' + l.year + '<br>' + esc(l.text) + '</p>').join('') + '<p class="t lf-effect">' + esc(effectText()) + '</p>'
      : '<p class="t">No letters yet. When your ranch gets healthier from one year to the next, a neighbour upstream will notice and try your ways.</p>';
    ui.card({ title: 'Letters from neighbours', html, buttons: [{ label: 'Close' }] });
  }
  Creek.neighbors = {
    state: function () { return { count: nb.count, factor: factorOf(nb.count), letters: nb.letters.map((l) => Object.assign({}, l)), lastRise: nb.lastRise == null ? null : nb.lastRise }; },
    factor: function () { return factorOf(nb.count); }
  };

  // ---------------------------------------------------------------- the Ranch health panel
  let panel = null, panelBody = null, btn = null;
  const WORDS = [[25, 'Just getting started'], [45, 'Waking up'], [65, 'Getting healthier'], [80, 'Thriving'], [101, 'Bursting with life']];
  const word = (t) => WORDS.find((w) => t < w[0])[1];
  function meterHtml(v, big) { return '<div class="lf-meter' + (big ? ' big' : '') + '"><b style="width:' + (100 - clamp(v, 0, 100)) + '%"></b></div>'; }
  function renderPanel() {
    if (!panel || !panel.visible) return;
    guard('panel', () => {
      const sc = score(); if (!sc) { panelBody.textContent = 'Load the ranch first.'; return; }
      let h = '<div class="lf-top"><div class="lf-big"><b>' + Math.round(sc.total) + '</b><span> / 100</span></div><div class="lf-word">' + esc(word(sc.total)) + '</div></div>' + meterHtml(sc.total, true);
      const was = nb.prev ? Math.round(totalOf(PARTS.map((p) => ({ id: p.id, known: nb.prev.vals[p.id] != null, value: nb.prev.vals[p.id] || 0, weight: p.w })))) : null;
      if (was != null && (game.year > 1 || was !== Math.round(sc.total))) {
        h += '<div class="lf-small">' + (game.year > 1 ? 'At the start of this year it was ' : 'When you started it was ') + was + '.</div>';
      }
      h += '<div class="lf-parts">' + sc.parts.map((p) => '<div class="lf-part' + (p.known ? '' : ' unk') + '"><div class="lf-row"><span class="lf-name">' + esc(p.label) + '</span><span class="lf-val">' + (p.known ? p.value : '?') + '</span></div>' +
        meterHtml(p.known ? p.value : 0) + '<p>' + esc(p.text) + '</p><p class="lf-tip"><b>To help:</b> ' + esc(p.tip) + '</p></div>').join('') + '</div>';
      const nbn = nb.count;
      h += '<div class="lf-foot"><p>' + (nbn ? nbn + (nbn === 1 ? ' neighbour is' : ' neighbours are') + ' trying your ways. ' + esc(effectText()) : 'When your ranch gets healthier from one year to the next, a neighbour upstream will try your ways, and less water will rush down to you.') + '</p>' +
        (nbn ? '<button class="go alt lf-letters">Read their letters</button> ' : '') + '<button class="go alt lf-cards">Postcards (' + CARDS.filter((c) => unlocked[c.id]).length + ' of ' + CARDS.length + ')</button></div>';
      if (!unlocked['heron-at-dawn']) h += '<div class="lf-small">Keep going: at 60 a heron comes to visit.</div>';
      else if (!unlocked['creekside-evening']) h += '<div class="lf-small">Keep going: at 80 the whole family comes down to the creek.</div>';
      panelBody.innerHTML = h;
      const a = panelBody.querySelector('.lf-letters'), b = panelBody.querySelector('.lf-cards');
      if (a) a.onclick = showAllLetters; if (b) b.onclick = openGallery;
    });
  }

  // ---------------------------------------------------------------- what the game tells us
  function onSeason(e) {
    score();                                      // the land has just changed, so this is one fresh read (the version moved)
    check(true);
    if (e && e.season === 'summer' && e.passing === 'spring' && lastScore) yearEnd(lastScore, e.year);
    renderPanel();
  }
  function onStormEnd() { score(); check(true); renderPanel(); }
  function resetRanch() {
    flags.roots = flags.willow = flags.pond = false; flags.dig = [];
    nb.count = 0; nb.letters = []; nb.lastRise = null; letterQueue = [];
    nb.prev = startStats ? snapOf(buildScore(startStats, { storm: null, bf: START_BASE, init: game.initialAnalysis, season: 'summer' }), 1) : null;
    cur = null; lastScore = null; applyFactor();
  }

  Creek.life = {
    /** {total 0..100, parts: [{id, label, value 0..100, raw, text, tip, known}]}. Cached until the land changes. */
    score: function (force) { return score(force); },
    /** Look for new postcards now. Returns the ids that just unlocked. */
    check: function () { return check(true); },
    /** [{id, title, hint, caption, img, unlocked}] */
    postcards: postcards
  };

  Creek.registerModule({
    id: 'life',
    init: function (g, u) {
      game = g; ui = u;
      loadUnlocked();
      ui.styles([
        /* phone: under the storm buttons, so they stay usable. Wide screens: down the left side, away from the storm buttons. */
        '.panel[data-panel="health"]{right:10px;left:auto;transform:none;top:calc(200px + var(--safe-t));width:min(350px,calc(100vw - 20px));max-height:calc(100% - 200px - 150px - var(--safe-b));min-height:120px}',
        '@media (min-width:640px){.panel[data-panel="health"]{left:10px;right:auto;top:calc(120px + var(--safe-t));max-height:calc(100% - 120px - 150px)}}',
        '.lf-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:2px 0 6px}',
        '.lf-big b{font:700 34px Georgia,serif;color:var(--moss)}.lf-big span{color:var(--ink2);font-size:13px}',
        '.lf-word{font:italic 15px Georgia,serif;color:var(--ink2);text-align:right}',
        '.lf-meter{position:relative;height:10px;border-radius:6px;background:linear-gradient(90deg,var(--clay),var(--gold) 50%,var(--moss));overflow:hidden}',
        '.lf-meter.big{height:16px;border-radius:9px}',
        '.lf-meter b{position:absolute;right:0;top:0;bottom:0;background:#d9ccae;transition:width .5s}',
        '.lf-part.unk .lf-meter{background:repeating-linear-gradient(45deg,#d9ccae,#d9ccae 6px,#e6dbc0 6px,#e6dbc0 12px)}.lf-part.unk .lf-meter b{display:none}',
        '.lf-small{margin:8px 0 2px;color:var(--ink2);font-size:12px}',
        '.lf-parts{margin-top:6px}.lf-part{padding:9px 0 4px;border-top:1px solid #d9ccae}',
        '.lf-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}.lf-name{font-weight:700;font-size:13.5px}.lf-val{font-variant-numeric:tabular-nums;color:var(--ink2)}',
        '.lf-part p{margin:5px 0 0;font:13.5px/1.4 Georgia,serif}.lf-part p.lf-tip{font:12.5px/1.35 system-ui,sans-serif;color:var(--ink2)}',
        '.lf-foot{border-top:1px solid #d9ccae;margin-top:8px;padding-top:6px}.lf-foot p{margin:0 0 8px;font:13.5px/1.4 Georgia,serif}',
        '.lf-foot .go{padding:8px 12px;min-height:40px;font-size:13px;margin:0 6px 6px 0}',
        '.lf-effect{font-weight:700;color:var(--moss)}',
        /* the new-postcard note */
        '.lf-toast{position:absolute;left:50%;bottom:150px;transform:translate(-50%,16px);z-index:12;width:min(360px,calc(100vw - 20px));display:flex;align-items:center;gap:10px;padding:8px 8px 8px 8px;' +
          'background:var(--paper);border-radius:16px;box-shadow:var(--shadow);border-left:6px solid var(--gold);opacity:0;pointer-events:none;transition:opacity .3s,transform .3s}',
        '.lf-toast.lf-on{opacity:1;transform:translate(-50%,0)}.lf-toast.lf-on button{pointer-events:auto}',
        '.lf-toast img{width:52px;height:52px;border-radius:10px;object-fit:cover;flex:0 0 auto;background:#d9ccae}',
        '.lf-tt{flex:1;min-width:0;line-height:1.25}.lf-tt small{display:block;color:var(--ink2);font-size:11.5px}.lf-tt b{font:700 15px Georgia,serif}',
        '.lf-toast .go{padding:8px 14px;min-height:40px;flex:0 0 auto}.lf-x{background:transparent;color:var(--ink2);width:40px;height:40px;flex:0 0 auto;font-size:16px}',
        /* the postcard gallery */
        '.lf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:10px;margin:8px 0}',
        '.lf-tile{display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;background:var(--paper2);border-radius:14px;padding:6px 6px 8px;text-align:left;font:inherit;min-height:40px;box-shadow:0 1px 4px rgba(59,42,26,.2)}',
        '.lf-tile .lf-img{display:block;position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:#cdbf9f}.lf-tile img{width:100%;height:100%;object-fit:cover;display:block}',
        '.lf-tile b{display:block;margin:6px 2px 0;font:700 13.5px Georgia,serif;color:var(--ink)}.lf-tile small{display:block;margin:2px 2px 0;color:var(--ink2);font-size:11.5px;line-height:1.3}',
        '.lf-tile.lock{cursor:default}.lf-tile.lock img{filter:grayscale(1) brightness(.4) blur(5px);transform:scale(1.15);opacity:.55}.lf-tile.lock b{color:var(--ink2)}',
        '.lf-tile.lock .lf-img::after{content:"?";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 38px Georgia,serif;color:#f4ecd8}'
      ].join('\n'));
      toastEl = document.createElement('div'); toastEl.className = 'lf-toast'; toastEl.setAttribute('role', 'status'); document.getElementById('app').appendChild(toastEl);
      panel = ui.panel({ id: 'health', title: '🌿 Ranch health', corner: 'tr', closable: true,
        onShow: () => { if (btn) btn.classList.add('on'); renderPanel(); }, onHide: () => { if (btn) btn.classList.remove('on'); } });
      panelBody = panel.body;
      btn = ui.addButton({ slot: 'view', id: 'lifeBtn', label: '🌿 Health', title: 'How healthy is the ranch?', toggle: true,
        onClick: (on) => { if (on) { game.ready && score(); panel.show(); } else panel.hide(); } });
      menuItem = { label: 'Postcards', onClick: () => openGallery(), alt: true }; updateMenuLabel(); ui.addMenuItem(menuItem);
      ui.addMenuItem({ label: '🌿 Ranch health', onClick: () => { if (!panel.visible) { if (game.ready) score(); panel.show(); } }, alt: true });   // the chip may be scrolled out of sight on a phone
      Creek.shortcuts.add({ key: 'h', desc: 'Ranch health panel', fn: () => { if (!game.ready) return false; if (game.ready && !panel.visible) score(); panel.toggle(); } });
      game.on('season', (e) => guard('season', () => onSeason(e)));
      game.on('stormEnd', () => guard('stormEnd', onStormEnd));
      game.on('strokeEnd', (e) => guard('strokeEnd', () => onStrokeEnd(e)));
      // while the panel is open, keep it up to date, but only a moment after the land stops changing (a read-back is not free)
      let later = 0;
      game.on('terrain', () => { if (panel && panel.visible) { clearTimeout(later); later = setTimeout(() => { if (!game.storm && !game.stroke) renderPanel(); }, 1200); } });
      game.on('reset', () => guard('reset', resetRanch));
      game.registerState('life', {
        save: () => ({ cards: Object.keys(unlocked), flags: { roots: flags.roots, willow: flags.willow, pond: flags.pond, dig: flags.dig.slice(0, 160) },
          nb: { count: nb.count, letters: nb.letters, prev: nb.prev, lastRise: nb.lastRise == null ? null : nb.lastRise } }),
        load: (j) => guard('load', () => {
          if (!j) return;
          (j.cards || []).forEach((id) => { if (cardById(id)) unlocked[id] = unlocked[id] || 1; }); saveUnlocked(); updateMenuLabel();
          const f = j.flags || {}; flags.roots = !!f.roots; flags.willow = !!f.willow; flags.pond = !!f.pond; flags.dig = Array.isArray(f.dig) ? f.dig.slice(0, 160) : [];
          const n = j.nb || {}; nb.count = clamp(Math.floor(+n.count || 0), 0, 20); nb.letters = Array.isArray(n.letters) ? n.letters.slice(0, 20) : []; nb.prev = n.prev && n.prev.vals ? n.prev : nb.prev; nb.lastRise = n.lastRise == null ? null : n.lastRise;
          applyFactor(); cur = null; lastScore = null; renderPanel();
        })
      });
    },
    ready: function (g) {
      guard('ready', () => {
        // the start of the ranch, worked out from the world data itself (no GPU read-back)
        startStats = statsFrom(g.world.T, g.world.M); startStats.sim = null;
        resetRanch();
      });
    }
  });
})();
