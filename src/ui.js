/* Screen furniture: tool tray, storm buttons, hints, picture cards, menus.
   Pictures live in assets/. Each slot below has a plain placeholder, so the game
   still works if a picture file is missing. */
(function () {
  const C = Creek.CONFIG;
  const $ = (id) => document.getElementById(id);
  const ui = Creek.ui = {};

  const PIC = 'assets/pictures/', EX = 'assets/extras/';
  ui.PICS = {
    title: PIC + '01-title.jpg', moveIn: PIC + '02-move-in-day.jpg', dryCreek: PIC + '03-dry-creek.jpg', storm: PIC + '04-storm.jpg',
    neighbors: PIC + '05-neighbors.jpg', yearsLater: PIC + '06-years-later.jpg',
    barrel: PIC + '07-rain-barrel.jpg', garden: PIC + '08-rain-garden.jpg', roots: PIC + '09-roots.jpg', bda: PIC + '10-bda.jpg',
    makingRoom: EX + 'making-room-for-roots.jpg', willow: EX + 'willow-work.jpg', firstFlow: EX + 'first-flow.jpg'
  };
  // How-to cards, shown the first time a tool is offered. Captions are text, not part of the pictures.
  ui.HOWTO = {
    barrel: { img: ui.PICS.barrel, square: true, title: 'Rain barrel', text: 'A barrel under a downspout holds roof water while it pours, then lets it out slowly once the storm has passed. Tap near a corner of the house to add one. A barrel is small, so it helps most in small storms.' },
    garden: { img: ui.PICS.garden, square: true, title: 'Rain garden', text: 'A shallow planted dip. It holds the water for a while and lets it soak down through the roots instead of racing away. Tap the ground to dig one.' },
    roots: { img: ui.PICS.roots, square: true, title: 'Roots hold the bank', text: 'Bare soil holds nothing. Lawn roots go down a few inches. Native grasses reach several feet. Trees go deepest. But roots only protect a bank as deep as they reach: where the bank is taller than the roots, water undercuts it and it falls.' },
    willow: { img: ui.PICS.willow, title: 'Willow stakes', text: 'Willow sticks pushed into a creek bank sprout and grow fast, and their roots knit the soil together. Tap or drag along a bank.' },
    bda: { img: ui.PICS.bda, square: true, title: 'Beaver dam analog (BDA)', text: 'Posts with woven branches across the creek. They slow the water down, so it drops its soil and the bed builds back up. Drag across the creek from bank to bank.' }
  };

  function seen(k, set) {
    try { const s = JSON.parse(localStorage.getItem('creek.seen') || '{}'); if (set) { s[k] = 1; localStorage.setItem('creek.seen', JSON.stringify(s)); } return !!s[k]; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- cards
  /** Show a picture card. Returns a promise that resolves with the value of the button pressed. */
  ui.card = function (o) {
    return new Promise((resolve) => {
      const card = $('card'), btns = o.buttons || [{ label: 'Continue', value: 'ok' }];
      card.className = o.cls || '';
      card.innerHTML = (o.img ? '<img class="pic' + (o.square ? ' square' : '') + '" alt="">' : '') +
        '<div class="over">' + (o.cls === 'title' ? '<h1></h1>' : '<h2></h2>') + '<p class="t"></p>' + (o.html || '') + '<div class="btns"></div></div>';
      if (o.img) { const im = card.querySelector('img'); im.onerror = () => { im.removeAttribute('src'); }; im.src = o.img; }
      card.querySelector(o.cls === 'title' ? 'h1' : 'h2').textContent = o.title || '';
      const p = card.querySelector('p.t'); if (o.text) p.textContent = o.text; else p.remove();
      const bx = card.querySelector('.btns');
      btns.forEach((b) => {
        const el = document.createElement('button'); el.className = 'go' + (b.alt ? ' alt' : ''); el.textContent = b.label;
        el.onclick = () => { $('modal').classList.add('hidden'); resolve(b.value); }; bx.appendChild(el);
      });
      $('modal').classList.remove('hidden'); card.scrollTop = 0;
    });
  };

  ui.toast = function (msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(ui._tt); ui._tt = setTimeout(() => t.classList.add('hidden'), 2400);
  };

  ui.setBanner = function (text, btn, cb) {
    const b = $('banner'); if (!text) { b.classList.add('hidden'); return; }
    $('bannerText').textContent = text; b.classList.remove('hidden');
    const bt = $('bannerBtn'); if (btn) { bt.textContent = btn; bt.classList.remove('hidden'); bt.onclick = cb; } else bt.classList.add('hidden');
  };

  // ---------------------------------------------------------------- init
  ui.init = function (game) {
    ui.game = game;
    const tools = $('tools');
    Creek.TOOLS.forEach((t) => {
      const b = document.createElement('button'); b.className = 'tool'; b.dataset.id = t.id;
      b.innerHTML = '<span class="ic">' + t.icon + '</span>' + t.label; b.onclick = () => ui.pickTool(t.id); tools.appendChild(b);
    });
    document.querySelectorAll('#sizes button').forEach((b) => b.onclick = () => {
      game.sizeIdx = +b.dataset.s; document.querySelectorAll('#sizes button').forEach(x => x.classList.toggle('on', x === b));
    });
    $('btnUndo').onclick = () => { if (!game.undo()) ui.toast('Nothing to undo.'); };
    $('btnLines').onclick = () => { game.contourOn = !game.contourOn; $('btnLines').classList.toggle('on', game.contourOn); };
    $('btnLens').onclick = () => { game.lens = game.lens ? 0 : 1; $('btnLens').classList.toggle('on', !!game.lens); ui.toast(game.lens ? 'Ground view: dark = clay, tan = loam, green = deep roots.' : 'Back to the map.'); };
    $('btnGrow').onclick = () => { game.growSeason(); ui.toast('A season passes. Plants grow.'); ui.refreshHints(); };
    $('btnMenu').onclick = () => ui.menu();
    document.querySelectorAll('.storm').forEach((b) => b.onclick = () => ui.onStorm && ui.onStorm(+b.dataset.size));
    $('stormEnd').onclick = () => game.stopStorm();
    $('hintHide').onclick = () => { $('hint').classList.add('hidden'); game.activeHint = null; };
    $('hintNext').onclick = () => { ui.hintIdx++; ui.showHint(); };
    $('hintShow').onclick = () => { const h = ui.hintList[ui.hintIdx % ui.hintList.length]; if (h) { game.focusOn(h.x, h.y, 11); game.activeHint = h; } };
    $('hintTool').onclick = () => { const h = ui.hintList[ui.hintIdx % ui.hintList.length]; if (h) ui.pickTool(h.tool); };

    game.cbs.toast = ui.toast;
    game.cbs.toolChanged = ui.updateTools;
    game.cbs.changed = () => {};
    game.cbs.probe = ui.probe;
    game.cbs.stormStart = () => { $('stormProg').classList.remove('hidden'); ui.lockStorms(true); };
    game.cbs.stormEnd = (r) => { $('stormProg').classList.add('hidden'); ui.lockStorms(false); ui.refreshHints(); ui.stormEndHook && ui.stormEndHook(r); };
    game.cbs.scale = ui.scale;
    game.cbs.error = (e) => ui.card({ title: 'Something went wrong', text: String(e && e.message || e), buttons: [{ label: 'OK' }] });
    setInterval(ui.tick, 200);
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
    const t = Creek.TOOLS.find(x => x.id === g.tool);
    $('sizes').style.visibility = t && t.sizes ? 'visible' : 'hidden';
  };

  ui.probe = function (d) {
    const el = $('probe'); if (!d) { el.classList.add('hidden'); return; }
    const i = d.info, covers = ['Bare soil', 'Mowed lawn', 'Native grass', 'Tree', 'Roof', 'Pavement', 'Willow', 'Rain garden', 'BDA', 'Fence'];
    const rock = i.h - i.bed < 0.03;
    let html = '<b>Height ' + i.h.toFixed(2) + ' m</b><br>' + covers[i.cover] + (i.cover === 2 || i.cover === 3 || i.cover === 6 ? ' (' + Math.round(i.growth * 100) + '% grown)' : '') + '<br>' +
      (rock ? 'Limestone' : (i.soil ? 'Sandy loam' : 'Black clay') + ', ' + Math.round((i.h - i.bed) * 100) + ' cm over limestone');
    if (i.depth > 0.004) html += '<br>Water ' + Math.round(i.depth * 100) + ' cm deep, ' + i.speed.toFixed(1) + ' m/s';
    el.innerHTML = html; el.classList.remove('hidden');
    const r = $('app').getBoundingClientRect();
    el.style.left = Math.min(d.x + 16, r.width - 240) + 'px'; el.style.top = Math.max(d.y - 90, 60) + 'px';
  };

  ui.scale = function (s) {
    const m = [1, 2, 5, 10, 20, 50]; let len = 10;
    for (const v of m) if (v * s <= 110) len = v;
    $('scaleLine').style.width = (len * s) + 'px'; $('scaleText').textContent = len + ' m';
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

  // ---------------------------------------------------------------- menu & picture book
  ui.menu = async function () {
    const g = ui.game;
    const v = await ui.card({
      title: C.title, text: 'Detail level: ' + (C.levels[g.level] * 100) + ' cm cells. ' + (ui.mode === 'story' ? 'You are playing the story.' : 'You are in free play.'),
      buttons: [{ label: 'Story: one year at the house', value: 'story' }, { label: 'Free play', value: 'free' }, { label: 'Picture book', value: 'book', alt: true }, { label: 'Reset the map', value: 'reset', alt: true }, { label: 'Close', value: 'close', alt: true }]
    });
    if (v === 'story') Creek.story.start(); else if (v === 'free') Creek.story.free(); else if (v === 'book') ui.book(); else if (v === 'reset') { g.resetMap(); ui.toast('Map reset.'); ui.refreshHints(); }
  };
  ui.book = async function () {
    const all = Object.values(ui.PICS).concat(['turtle-return', 'heron-at-dawn', 'creekside-evening', 'prairie-visitors'].map(n => EX + n + '.jpg'));
    const html = '<div class="gallery">' + all.map((s, i) => '<img data-i="' + i + '" src="' + s + '" alt="">').join('') + '</div>';
    const p = ui.card({ title: 'Picture book', html, buttons: [{ label: 'Close' }] });
    document.querySelectorAll('.gallery img').forEach((im) => im.onclick = () => { $('modal').classList.add('hidden'); ui.card({ img: all[+im.dataset.i], buttons: [{ label: 'Back', value: 'b' }] }).then(ui.book); });
    return p;
  };
})();
