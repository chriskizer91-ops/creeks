/* Screen furniture: tool tray, storm buttons, hints, picture cards, ranch books, menus.
   Pictures live in assets/. Each slot below can name a picture and a fallback; if neither
   file exists the card simply shows a plain placeholder, so the game works without them. */
(function () {
  const C = Creek.CONFIG;
  const $ = (id) => document.getElementById(id);
  const ui = Creek.ui = {};
  ui.mode = 'free';

  const PIC = 'assets/pictures/', EX = 'assets/extras/';
  const ranch = (n) => PIC + 'ranch-' + n + '.jpg';
  // Slots for the ranch pictures. Until the ranch paintings exist, each falls back to a picture from the first set.
  ui.PICS = {
    title:      [ranch('01-title'), EX + 'creekside-evening.jpg', PIC + '01-title.jpg'],
    inherit:    [ranch('02-inherit'), PIC + '03-dry-creek.jpg'],
    dryCreek:   [ranch('03-dry-creek'), PIC + '03-dry-creek.jpg'],
    storm:      [ranch('04-storm'), PIC + '04-storm.jpg'],
    gully:      [ranch('05-field-gully'), PIC + '04-storm.jpg'],
    cattle:     [ranch('06-cattle'), EX + 'prairie-visitors.jpg'],
    neighbors:  [ranch('07-neighbors'), PIC + '05-neighbors.jpg'],
    yearsLater: [ranch('08-years-later'), EX + 'creekside-evening.jpg', PIC + '06-years-later.jpg'],
    swale:      [ranch('card-swale'), PIC + '08-rain-garden.jpg'],
    pond:       [ranch('card-pond'), PIC + '08-rain-garden.jpg'],
    roots:      [ranch('card-roots'), PIC + '09-roots.jpg'],
    bda:        [ranch('card-bda'), PIC + '10-bda.jpg'],
    willow:     [ranch('card-willow'), EX + 'willow-work.jpg'],
    fields:     [ranch('card-fields'), EX + 'prairie-visitors.jpg'],
    winter:     [ranch('09-winter'), EX + 'making-room-for-roots.jpg'],
    firstFlow:  [ranch('10-first-flow'), EX + 'first-flow.jpg']
  };
  // How-to cards, shown the first time a tool is offered. Captions are text, not part of the pictures.
  ui.HOWTO = {
    swale: { img: ui.PICS.swale, square: true, title: 'Swale', text: 'A level ditch with its soil piled on the downhill side. Dug along a contour line, it stops running water, spreads it out and lets it soak in. Drag along a line: the contour you are following lights up. If you wander off it, one end gets deep and the other turns into a dam.' },
    pond: { img: ui.PICS.pond, square: true, title: 'Pond', text: 'A pond catches the water that does run off, holds it for cattle and wildlife, and lets it settle out its mud. Tap low ground, where water already collects, such as the head of a draw.' },
    roots: { img: ui.PICS.roots, square: true, title: 'Roots hold the bank', text: 'Bare soil holds nothing. Pasture roots go down a foot. Native grasses reach six feet. Trees go deepest. But roots only protect a bank as deep as they reach: where the bank is taller than the roots, water undercuts it and it falls.' },
    bda: { img: ui.PICS.bda, square: true, title: 'Check dam (BDA)', text: 'Posts with woven branches across a gully or creek. They slow the water so it drops its soil and the bed builds back up. Drag across the channel from bank to bank.' },
    willow: { img: ui.PICS.willow, title: 'Willow stakes', text: 'Willow sticks pushed into a creek bank sprout and grow fast, and their roots knit the soil together. Drag along a bank.' },
    fields: { img: ui.PICS.fields, square: true, title: 'Fields', text: 'Pick a land use from the row above the tools, then tap a field to switch it. Cover crops and no-till build soil that soaks up water. Rotational grazing lets grass recover. Switching costs money, and it takes seasons to pay off.' }
  };

  function seen(k, set) {
    try { const s = JSON.parse(localStorage.getItem('creek.seen') || '{}'); if (set) { s[k] = 1; localStorage.setItem('creek.seen', JSON.stringify(s)); } return !!s[k]; } catch (e) { return false; }
  }
  const money = (v) => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString();
  const SEASON_NAME = { summer: 'Summer', fall: 'Fall', winter: 'Winter', spring: 'Spring' };
  ui.money = money;

  // ---------------------------------------------------------------- cards and splash
  /** Show a picture card. `img` may be one path or a list (first that loads wins). Resolves with the pressed button's value. */
  ui.card = function (o) {
    return new Promise((resolve) => {
      const card = $('card'), btns = o.buttons || [{ label: 'Continue', value: 'ok' }];
      card.className = o.cls || '';
      card.innerHTML = (o.img ? '<img class="pic' + (o.square ? ' square' : '') + '" alt="">' : '') +
        '<div class="over">' + (o.cls === 'title' ? '<h1></h1>' : '<h2></h2>') + '<p class="t"></p>' + (o.html || '') + '<div class="btns"></div></div>';
      if (o.img) {
        const im = card.querySelector('img'), list = [].concat(o.img); let k = 0;
        im.onerror = () => { k++; if (k < list.length) im.src = list[k]; else im.removeAttribute('src'); };
        im.src = list[0];
      }
      card.querySelector(o.cls === 'title' ? 'h1' : 'h2').textContent = o.title || '';
      const p = card.querySelector('p.t'); if (o.text) p.textContent = o.text; else p.remove();
      const bx = card.querySelector('.btns');
      btns.forEach((b) => {
        const el = document.createElement('button'); el.className = 'go' + (b.alt ? ' alt' : ''); el.textContent = b.label;
        el.onclick = () => { $('modal').classList.add('hidden'); resolve(b.value); }; bx.appendChild(el);
      });
      $('modal').classList.remove('hidden'); card.scrollTop = 0;
      if (o.onShow) o.onShow(card);
    });
  };
  ui.closeCard = function () { $('modal').classList.add('hidden'); };
  ui.splash = function (msg, frac) {
    const s = $('splash');
    if (msg == null) { s.classList.remove('on'); return; }
    s.classList.add('on'); $('splashText').textContent = msg; $('splashBar').style.width = Math.round((frac || 0) * 100) + '%';
  };

  ui.toast = function (msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(ui._tt); ui._tt = setTimeout(() => t.classList.add('hidden'), 2800);
  };

  // ---------------------------------------------------------------- season bar
  ui.seasonBar = function (note, onAdvance) {
    ui.note = note; ui.onAdvance = onAdvance; ui.refreshSeasonBar();
  };
  ui.refreshSeasonBar = function () {
    const g = ui.game, b = $('banner');
    if (!ui.onAdvance && !ui.note) { b.classList.add('hidden'); return; }
    const next = Creek.SEASONS[(Creek.SEASONS.indexOf(g.season) + 1) % 4];
    $('bannerText').textContent = 'Year ' + g.year + ' · ' + SEASON_NAME[g.season] + (ui.note ? ': ' + ui.note : '');
    const bt = $('bannerBtn');
    if (ui.onAdvance) { bt.textContent = ui.advanceLabel || ('On to ' + SEASON_NAME[next].toLowerCase() + ' →'); bt.classList.remove('hidden'); bt.onclick = () => { if (!g.storm && ui.onAdvance) ui.onAdvance(); }; }
    else bt.classList.add('hidden');
    b.classList.remove('hidden');
  };

  // ---------------------------------------------------------------- init
  ui.init = function (game) {
    ui.game = game;
    const tools = $('tools');
    Creek.TOOLS.forEach((t) => {
      const b = document.createElement('button'); b.className = 'tool'; b.dataset.id = t.id;
      b.innerHTML = '<span class="ic">' + t.icon + '</span>' + t.label; b.onclick = () => ui.pickTool(t.id); tools.appendChild(b);
    });
    $('btnUndo').onclick = () => { if (!game.undo()) ui.toast('Nothing to undo.'); };
    $('btnLines').onclick = () => { game.contourOn = !game.contourOn; $('btnLines').classList.toggle('on', game.contourOn); };
    const LENS = [['🗺️ Map', 'Back to the map.'], ['🟤 Soil health', 'Soil health: dark = rich in organic matter, pale = tired soil. Rich soil soaks up water.'],
      ['🔴 Soil moved', 'Soil moved since the start: red = washed away, blue = piled up. This is where the land is changing.'], ['🔵 Flood depth', 'How deep the water got in the last storm. Dark blue is deepest.']];
    $('btnLens').onclick = () => { game.lens = (game.lens + 1) % 4; $('btnLens').textContent = LENS[game.lens][0]; $('btnLens').classList.toggle('on', !!game.lens); ui.toast(LENS[game.lens][1]); };
    $('btnMenu').onclick = () => ui.menu();
    $('btnCash').onclick = () => ui.books();
    document.querySelectorAll('.storm').forEach((b) => b.onclick = () => ui.onStorm && ui.onStorm(+b.dataset.size));
    $('stormEnd').onclick = () => game.stopStorm();
    $('hintHide').onclick = () => { $('hint').classList.add('hidden'); game.activeHint = null; };
    $('hintNext').onclick = () => { ui.hintIdx++; ui.showHint(); };
    $('hintShow').onclick = () => { const h = ui.hintList[ui.hintIdx % ui.hintList.length]; if (h) { game.focusOn(h.x, h.y, Math.max(1.2, 400 / h.r / 4)); game.activeHint = h; } };
    $('hintTool').onclick = () => { const h = ui.hintList[ui.hintIdx % ui.hintList.length]; if (h) ui.pickTool(h.tool); };

    game.cbs.toast = ui.toast;
    game.cbs.toolChanged = ui.updateTools;
    game.cbs.changed = () => {};
    game.cbs.probe = ui.probe;
    game.cbs.progress = (m, f) => ui.splash(m, f);
    game.cbs.cash = (v) => { const b = $('btnCash'); b.textContent = money(v); b.classList.toggle('neg', v < 0); };
    game.cbs.fieldsChanged = ui.buildLabels;
    game.cbs.seasonChanged = () => ui.refreshSeasonBar();
    game.cbs.stormStart = (st) => { if (!st.turbo || true) $('stormProg').classList.remove('hidden'); ui.lockStorms(true); $('report').classList.add('hidden'); };
    game.cbs.stormEnd = (r) => { $('stormProg').classList.add('hidden'); ui.lockStorms(false); ui.refreshHints(); ui.stormEndHook ? ui.stormEndHook(r) : ui.report(r); };
    game.cbs.scale = ui.scale;
    game.cbs.labels = ui.labels;
    game.cbs.error = (e) => ui.card({ title: 'Something went wrong', text: String(e && e.message || e), buttons: [{ label: 'OK' }] });
    setInterval(ui.tick, 250);
    ui.updateTools();
  };

  ui.lockStorms = function (lock) { document.querySelectorAll('.storm').forEach(b => b.disabled = lock); };
  ui.tick = function () {
    const g = ui.game, st = g.storm; if (!st) return;
    const pct = Math.min(1, st.t / (C.stormBurst + C.stormTail));
    $('stormBar').style.width = (pct * 100) + '%';
    const phase = st.t < C.stormBurst ? 'Raining' : 'Draining';
    $('stormLabel').textContent = phase + ' · ' + Math.round(pct * 100) + '%';
  };
  setInterval(() => { const g = ui.game; if (g && g.contourStep) $('linesText').textContent = g.contourOn ? 'Lines every ' + g.contourStep + ' m' : 'Lines off'; }, 500);

  // ---------------------------------------------------------------- tools
  ui.pickTool = function (id) {
    const g = ui.game;
    if (!g.setTool(id)) return;
    const t = Creek.TOOLS.find(x => x.id === id);
    if (t.card && !seen(t.card)) {
      seen(t.card, true); const h = ui.HOWTO[t.card];
      ui.card({ img: h.img, square: h.square, title: h.title, text: h.text, buttons: [{ label: 'Got it' }] });
    } else ui.toast(t.help);
  };
  ui.updateTools = function () {
    const g = ui.game;
    document.querySelectorAll('.tool').forEach((b) => { b.classList.toggle('sel', b.dataset.id === g.tool); b.classList.toggle('locked', !g.canUse(b.dataset.id)); });
    const t = Creek.TOOLS.find(x => x.id === g.tool), vb = $('variants');
    vb.innerHTML = '';
    if (t && t.opts) {
      vb.classList.remove('hidden');
      t.opts.forEach((o, k) => {
        const b = document.createElement('button'); b.textContent = o.icon + ' ' + o.label; b.className = (g.optIdx[t.id] || 0) === k ? 'sel' : '';
        b.title = o.long || '';
        b.onclick = () => { g.optIdx[t.id] = k; g.sizeIdx = Math.min(g.sizeIdx, (g.cur().sizes || [0]).length - 1); ui.updateTools(); ui.toast(o.long ? o.long + (C.uses[o.id] && C.uses[o.id].hint ? ': ' + C.uses[o.id].hint : '') : o.label); };
        vb.appendChild(b);
      });
    } else vb.classList.add('hidden');
    ui.buildSizes();
  };
  ui.buildSizes = function () {
    const g = ui.game, d = g.cur(), box = $('sizes'); box.innerHTML = '';
    if (!d.sizes || d.sizes.length < 2) { box.style.visibility = 'hidden'; return; }
    box.style.visibility = 'visible';
    d.sizes.forEach((r, k) => {
      const b = document.createElement('button'); b.textContent = r + ' m'; b.className = k === Math.min(g.sizeIdx, d.sizes.length - 1) ? 'on' : '';
      b.onclick = () => { g.sizeIdx = k; ui.buildSizes(); }; box.appendChild(b);
    });
  };

  ui.probe = function (d) {
    const el = $('probe'); if (!d) { el.classList.add('hidden'); return; }
    const g = ui.game, i = d.info, covers = ['Bare soil', 'Pasture', 'Native prairie', 'Trees', 'Roof', 'Road', 'Willow', 'Cover crop', 'Check dam', 'Crop field', 'Pond'];
    const rock = i.h - i.bed < 0.03, f = i.field && g.fields[i.field - 1];
    let html = '<b>Height ' + i.h.toFixed(2) + ' m</b>' + (f ? '<br>' + f.name + ' · ' + C.uses[f.use].short : '') + '<br>' + covers[i.cover] +
      (i.growth > 0 && [1, 2, 3, 6, 7, 9].indexOf(i.cover) >= 0 ? ' (' + Math.round(i.growth * 100) + '% grown)' : '') + '<br>' +
      (rock ? 'Limestone' : (i.soil ? 'Sandy loam' : 'Black clay') + ', ' + Math.round((i.h - i.bed) * 100) + ' cm over limestone') +
      '<br>Organic matter ' + Math.round(i.som * 100) + '%';
    if (i.depth > 0.004) html += '<br>Water ' + Math.round(i.depth * 100) + ' cm deep, ' + i.speed.toFixed(1) + ' m/s';
    el.innerHTML = html; el.classList.remove('hidden');
    const r = $('app').getBoundingClientRect();
    el.style.left = Math.min(d.x + 16, r.width - 240) + 'px'; el.style.top = Math.max(d.y - 110, 60) + 'px';
  };

  ui.scale = function (s) {
    const m = [1, 2, 5, 10, 20, 50, 100, 200, 500]; let len = 10;
    for (const v of m) if (v * s <= 110) len = v;
    $('scaleLine').style.width = (len * s) + 'px'; $('scaleText').textContent = len >= 1000 ? len / 1000 + ' km' : len + ' m';
  };

  // ---------------------------------------------------------------- map labels
  ui.labelEls = [];
  ui.buildLabels = function () {
    const g = ui.game, box = $('labels'); box.innerHTML = ''; ui.labelEls = [];
    if (!g.fields) return;
    g.fields.forEach((f) => {
      if (f.kind !== 'field') return;
      const el = document.createElement('div'); el.className = 'flabel'; box.appendChild(el);
      ui.labelEls.push({ el, x: f.cx, y: f.cy, f, max: 2.4, min: 0 });
    });
    g.world.meta.streams.forEach((s, k) => {
      const p = s.pts[Math.floor(s.pts.length * (k === 0 ? 0.45 : 0.5))];
      const el = document.createElement('div'); el.className = 'flabel stream'; el.textContent = s.name; box.appendChild(el);
      ui.labelEls.push({ el, x: p[0], y: p[1], stream: true, max: k === 0 ? 3 : 1.6, min: 0 });
    });
    ui.labels();
  };
  ui.labels = function () {
    const g = ui.game, s = g.cam.scale;
    for (const L of ui.labelEls) {
      const show = s <= L.max && s >= L.min;
      if (!show) { if (L.shown !== false) { L.el.style.display = 'none'; L.shown = false; } continue; }
      if (L.f && L.f.use !== L.use) { L.use = L.f.use; L.el.innerHTML = C.uses[L.f.use].icon + ' <b>' + L.f.name + '</b>'; }
      if (L.shown !== true) { L.el.style.display = ''; L.shown = true; }
      const p = g.project(L.x, L.y);
      L.el.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y) + 'px) translate(-50%,-50%)';
    }
  };

  // ---------------------------------------------------------------- hints
  ui.hintList = []; ui.hintIdx = 0;
  ui.refreshHints = function () { ui.hintList = ui.game.computeHints(); ui.hintIdx = 0; ui.showHint(); };
  ui.showHint = function () {
    const g = ui.game, l = ui.hintList; if (!l.length) { $('hint').classList.add('hidden'); g.activeHint = null; return; }
    const h = l[ui.hintIdx % l.length];
    g.hintsShown[h.id] = (g.hintsShown[h.id] || 0) + 0.5;
    $('hintText').textContent = '💡 ' + h.text; g.activeHint = null;
    const t = Creek.TOOLS.find(x => x.id === h.tool), bt = $('hintTool');
    if (t && g.canUse(t.id)) { bt.textContent = 'Try: ' + t.label; bt.classList.remove('hidden'); } else bt.classList.add('hidden');
    $('hint').classList.remove('hidden');
  };

  // ---------------------------------------------------------------- storm report and the ranch books
  const acres = (ha) => ha * 2.471;
  ui.report = function (r) {
    if (!r) return;
    const el = $('report'), S = C.storms[r.size];
    el.innerHTML = '<button class="x">✕</button><h4>' + S.label + ' storm</h4>' +
      'Soaked in: <b>' + Math.round(r.soakShare * 100) + '%</b> of the rain<br>' +
      'Peak flow leaving: <b>' + Math.round(r.peakOut) + ' m³/s</b><br>' +
      'Soil washed off: <b>' + Math.round(r.soilLost * 1.3).toLocaleString() + ' tons</b><br>' +
      'Flooded: <b>' + acres(r.floodHa).toFixed(0) + ' acres</b>' +
      '<br><button class="go more">Ranch books</button>';
    el.classList.remove('hidden');
    el.querySelector('.x').onclick = () => el.classList.add('hidden');
    el.querySelector('.more').onclick = () => ui.books();
  };

  ui.books = async function () {
    const g = ui.game, ls = g.lastStorm;
    ui.splash('Counting the harvest…', 0.5);
    await new Promise(r => setTimeout(r, 30));
    let eco; try { eco = g.computeEconomy(); } catch (e) { eco = null; }
    ui.splash(null);
    const U = C.uses;
    const rows = g.fields.filter(f => f.kind === 'field').map((f, i) => {
      const e = eco && eco.per[f.id - 1], ha = f.area / 1e4;
      const som = e ? e.somMean : 0;
      return '<tr><td>' + U[f.use].icon + ' ' + f.name + '</td><td>' + Math.round(acres(ha)) + ' ac</td><td><span class="meter"><i style="width:' + Math.min(100, Math.round(som / 0.7 * 100)) + '%"></i></span> ' + Math.round(som * 100) + '%</td>' +
        '<td class="n ' + (e && e.net * 4 / Math.max(ha, 0.1) < 0 ? 'neg' : '') + '">' + (e ? money(e.net * 4 / Math.max(ha, 0.1)) : '–') + '/ha</td></tr>';
    }).join('');
    const hist = g.ledger.slice(-14).reverse().map(l => '<tr><td>Y' + l.y + ' ' + SEASON_NAME[l.s] + '</td><td>' + l.text + '</td><td class="n ' + (l.amount < 0 ? 'neg' : 'pos') + '">' + money(l.amount) + '</td></tr>').join('') || '<tr><td colspan="3">Nothing yet.</td></tr>';
    const an = g.analysis || g.analyze(g.sim.readTerrain());
    const html = '<p class="sub">Bank height along ' + C.creekName + ': <b>' + (an.main.mean * 3.281).toFixed(1) + ' ft</b> · gullies: <b>' + (an.gullyMean * 3.281).toFixed(1) + ' ft</b> · dry-season creek flow index: <b>' + g.baseflow().toFixed(0) + ' L/s</b>' +
      (ls ? ' · soil organic matter: <b>' + Math.round(ls.somMean * 100) + '%</b>' : '') + '</p>' +
      '<h2 style="font-size:16px">Fields <span class="pill">soil health · income per hectare per year</span></h2><div class="scroll"><table class="res small">' + rows + '</table></div>' +
      '<h2 style="font-size:16px">The ledger</h2><div class="scroll"><table class="res small">' + hist + '</table></div>';
    await ui.card({ title: 'Ranch books · ' + money(g.cash), html, buttons: [{ label: 'Close' }] });
  };

  // ---------------------------------------------------------------- menu & picture book
  ui.menu = async function () {
    const g = ui.game;
    const v = await ui.card({
      title: C.ranchName, text: 'Detail: ' + C.levelNames[g.level] + '. ' + (ui.mode === 'story' ? 'You are playing the story.' : 'You are in free play.'),
      buttons: [{ label: 'Story: the first years', value: 'story' }, { label: 'Free play', value: 'free' }, { label: 'Change detail level', value: 'level', alt: true }, { label: 'Picture book', value: 'book', alt: true }, { label: 'Start the ranch over', value: 'reset', alt: true }, { label: 'Close', value: 'close', alt: true }]
    });
    if (v === 'story') Creek.story.start(); else if (v === 'free') Creek.story.free(); else if (v === 'level') ui.levelPicker(); else if (v === 'book') ui.book(); else if (v === 'reset') { g.resetMap(); ui.toast('The ranch is back as you found it.'); ui.refreshHints(); ui.refreshSeasonBar(); }
  };
  ui.levelPicker = async function () {
    const g = ui.game;
    const v = await ui.card({
      title: 'Detail level', text: 'Finer cells show more but make storms slower. The 1 m level is two million cells and wants a good laptop. Changing it starts the ranch over.',
      buttons: C.levels.map((dx, k) => ({ label: (k === g.level ? '✓ ' : '') + C.levelNames[k], value: k, alt: k !== g.level })).concat([{ label: 'Cancel', value: -1, alt: true }])
    });
    if (v >= 0 && v !== g.level) { await g.loadLevel(v); g.fitCamera(); Creek.story.free(); }
  };
  ui.book = async function () {
    const all = [PIC + '01-title.jpg', PIC + '02-move-in-day.jpg', PIC + '03-dry-creek.jpg', PIC + '04-storm.jpg', PIC + '05-neighbors.jpg', PIC + '06-years-later.jpg', PIC + '07-rain-barrel.jpg', PIC + '08-rain-garden.jpg', PIC + '09-roots.jpg', PIC + '10-bda.jpg']
      .concat(['making-room-for-roots', 'willow-work', 'first-flow', 'prairie-visitors', 'turtle-return', 'heron-at-dawn', 'creekside-evening'].map(n => EX + n + '.jpg'));
    const html = '<div class="gallery">' + all.map((s, i) => '<img data-i="' + i + '" src="' + s + '" alt="">').join('') + '</div>';
    const p = ui.card({ title: 'Picture book', html, buttons: [{ label: 'Close' }] });
    document.querySelectorAll('.gallery img').forEach((im) => im.onclick = () => { $('modal').classList.add('hidden'); ui.card({ img: all[+im.dataset.i], buttons: [{ label: 'Back', value: 'b' }] }).then(ui.book); });
    return p;
  };
})();
