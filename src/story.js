/* Free play and the Story. No timers, no way to lose (money can go negative; the bank waits).
   Story: three years at the ranch. Each year: summer (dry creek, build) → fall (storms test it) →
   winter (planting) → spring (the big storms). It opens with a "before" storm on the land as you
   found it and closes with the same storm on the land as you left it. */
(function () {
  const C = Creek.CONFIG, P = () => Creek.ui.PICS;
  const story = Creek.story = { token: 0 };
  const NO_PLANTS = ['look', 'dig', 'pile', 'swale', 'pond', 'dam', 'fields'];
  const YEARS = 3;
  const ft = (m) => (m * 3.281).toFixed(1);
  const SEASON_NAME = { summer: 'Summer', fall: 'Fall', winter: 'Winter', spring: 'Spring' };

  function stormDone(ui) { return new Promise((res) => { ui.stormEndHook = (r) => { ui.stormEndHook = null; res(r); }; }); }
  const money = (v) => Creek.ui.money(v);

  function seasonSummary(r) {
    return (r.net >= 0 ? 'The season earned ' : 'The season cost ') + money(Math.abs(r.net)) + '.';
  }

  story.free = function () {
    const g = Creek.game, ui = Creek.ui; story.token++;
    ui.mode = 'free'; g.allowed = null;
    g.resetMap(); ui.stormEndHook = null; ui.onStorm = (size) => g.startStorm(size);
    ui.advanceLabel = null;
    ui.seasonBar(null, async () => {
      const r = g.advanceSeason(); ui.toast(seasonSummary(r)); ui.refreshSeasonBar(); ui.refreshHints();
    });
    g.fitCamera(); ui.updateTools(); ui.refreshHints();
    ui.toast('Free play: every tool is open. Try a storm.');
  };

  story.start = async function () {
    const g = Creek.game, ui = Creek.ui, tok = ++story.token, alive = () => tok === story.token;
    ui.mode = 'story'; g.resetMap(); g.allowed = ['look']; g.fitCamera(); ui.seasonBar(null, null); ui.onStorm = null; ui.updateTools(); ui.advanceLabel = null;

    await ui.card({ img: P().inherit, title: 'Bluestem Ranch', text: 'Five hundred acres are yours now: fields, pasture, prairie remnants and a creek. Plum Creek crosses the ranch, and five small draws feed it. The creek drains about 2,500 acres, and you own 500 of them. Everything that falls on the rest of that land arrives at your fence.', buttons: [{ label: 'Walk the ranch' }] });
    await ui.card({ img: P().dryCreek, title: 'The creek', text: 'It is summer and the creek is dry. The banks are tall, bare and crumbling, and under them is pale limestone. The draws have cut gullies into the fields. It will not stay dry. Before you change anything, picture what a big storm would do to the ranch as it is.', buttons: [{ label: 'Picture it' }] });
    if (!alive()) return;

    // The "before": a 10-year storm on the untouched ranch.
    const beforeImg = g.snapshot(520);
    let skipped = false;
    ui.seasonBar('imagining a big storm on the land as it is…', null); ui.refreshSeasonBar();
    document.getElementById('bannerBtn').classList.add('hidden');
    ui.stormEndHook = null;
    g.startStorm(10, { turbo: true, tag: 'baseline', moist: 0.1 });
    const skipBtn = document.getElementById('stormEnd'); const oldSkip = skipBtn.onclick; skipBtn.onclick = () => { skipped = true; g.stopStorm(); };
    const stormEnded = stormDone(ui);
    await stormEnded;
    skipBtn.onclick = oldSkip;
    const baseline = skipped ? null : g.lastStorm;
    g.resetMap(); if (!alive()) return;
    g.analysis = null; g.baseline = baseline;

    const years = [];
    for (let y = 1; y <= YEARS; y++) {
      const startCash = g.cash;
      for (let k = 0; k < 4; k++) {
        if (!alive()) return;
        const season = Creek.SEASONS[k];
        g.allowed = (season === 'winter' || season === 'spring') ? null : NO_PLANTS;
        ui.updateTools();
        // a little story at the start of each season in year 1
        if (y === 1 && season === 'fall') await ui.card({ img: P().storm, title: 'Fall: the storms come', text: 'The first real rains arrive. Send a storm of your own and watch where the water goes and what it takes with it. Then fix what it shows you.', buttons: [{ label: 'Continue' }] });
        if (y === 1 && season === 'winter') await ui.card({ img: P().winter, title: 'Winter: planting season', text: 'The ground is soft and the plants are asleep, which is the right time to move them. Native grasses, trees and willow stakes are open to you now. Roots take a season or two to reach their depth, and trees much longer.', buttons: [{ label: 'Continue' }] });
        if (y === 1 && season === 'spring') await ui.card({ img: P().cattle, title: 'Spring: growth and big rain', text: 'Everything grows now. The big storms come in spring, so this is the test of what you did over the winter.', buttons: [{ label: 'Continue' }] });
        const note = { summer: 'the creek is dry. Work in it.', fall: 'storms test what you built.', winter: 'planting season.', spring: 'the big storms.' }[season];
        const last = (y === YEARS && season === 'spring');
        ui.onStorm = (size) => g.startStorm(size);
        ui.advanceLabel = last ? 'Finish: the final test ✓' : null;
        await new Promise((res) => { ui.seasonBar(note, () => { res(); }); ui.refreshHints(); });
        if (!alive()) return;
        const r = g.advanceSeason(); ui.toast(seasonSummary(r));
      }
      years.push({ y, cash: g.cash, change: g.cash - startCash });
      if (y < YEARS) {
        const M = g.sim.readMoisture(), som = g.meanSom(M), an = g.analysis;
        await ui.card({ img: y === 1 ? undefined : P().firstFlow, title: 'Year ' + y + ' is done', text: 'Cash: ' + money(g.cash) + ' (' + (g.cash - startCash >= 0 ? '+' : '−') + money(Math.abs(g.cash - startCash)).replace('−', '') + ' this year). Soil organic matter is ' + Math.round(som * 100) + '%. Plum Creek’s banks are ' + ft(an.main.mean) + ' feet tall and the gullies ' + ft(an.gullyMean) + ' feet. Dry-season creek flow index: ' + g.baseflow().toFixed(0) + ' L/s.', buttons: [{ label: 'On to year ' + (y + 1) }] });
      }
    }

    // The same storm again, on the land as you left it (same season as the first: the crops look the same).
    ui.advanceLabel = null; ui.seasonBar('one last test: the same storm as the first day.', null);
    document.getElementById('bannerBtn').classList.add('hidden');
    g.allowed = ['look']; ui.updateTools(); ui.onStorm = null;
    g.startStorm(10, { turbo: true, tag: 'final', moist: 0.1 });
    await stormDone(ui);
    const final = g.lastStorm; g.sim.dryOut(g.baseMoist, 0.5);
    const afterImg = g.snapshot(520);
    ui.seasonBar(null, null); ui.refreshSeasonBar();
    await results(g, ui, baseline, final, beforeImg, afterImg);
    await ui.card({ img: P().neighbors, title: 'A neighbour at the fence', text: '“Your creek ran in August,” says the rancher upstream. “Mine didn’t. What are you doing down there?” You hand over a shovel and a bag of seed. “Making room for the water.”', buttons: [{ label: 'Then what?' }] });
    await ui.card({ img: P().yearsLater, title: 'Years later', text: 'Same ranch, same creek. The water that used to rush through in an afternoon now walks, and the soil keeps more of it. There was never a villain here, only water and habit, and habits can change.', buttons: [{ label: 'Keep playing (free play)', value: 'free' }] });
    story.free();
  };

  async function results(g, ui, b, f, beforeImg, afterImg) {
    const A0 = g.initialAnalysis, A1 = f.an, ha2ac = 2.471;
    const pct = (a, c) => (a > 0 ? Math.round((1 - c / a) * 100) : 0);
    const row = (lab, a, c, goodDown) => '<tr><td>' + lab + '</td><td class="n">' + a + '</td><td class="n">' + c + '</td></tr>';
    const mud = (r) => (r ? (r.mudConc * 2650).toFixed(1) + ' g/L' : '—');
    const startCash = C.money.start;
    let html = '<div class="pair"><figure><img src="' + beforeImg + '"><figcaption>Day one</figcaption></figure><figure><img src="' + afterImg + '"><figcaption>After ' + 3 + ' years</figcaption></figure></div>' +
      '<table class="res small"><tr><th></th><th class="n">Before</th><th class="n">After</th></tr>' +
      row('Rain that soaked in', b ? Math.round(b.soakShare * 100) + '%' : '—', Math.round(f.soakShare * 100) + '%') +
      row('Peak flow leaving the ranch', b ? Math.round(b.peakOut) + ' m³/s' : '—', Math.round(f.peakOut) + ' m³/s') +
      row('Land flooded', b ? Math.round(b.floodHa * ha2ac) + ' acres' : '—', Math.round(f.floodHa * ha2ac) + ' acres') +
      row('Muddiness of the water', mud(b), mud(f)) +
      row('Soil washed off its place', b ? Math.round(b.soilLost * 1.3).toLocaleString() + ' tons' : '—', Math.round(f.soilLost * 1.3).toLocaleString() + ' tons') +
      row('Plum Creek bank height', ft(A0.main.mean) + ' ft', ft(A1.main.mean) + ' ft') +
      row('Gully depth (the five draws)', ft(A0.gullyMean) + ' ft', ft(A1.gullyMean) + ' ft') +
      row('Soil organic matter', b ? Math.round(b.somMean * 100) + '%' : '—', Math.round(f.somMean * 100) + '%') +
      row('Money in the bank', money(startCash), money(g.cash)) + '</table>';
    let text = 'Both runs are the same 10-year storm.';
    if (b) text += ' Your ranch changed the peak flow leaving it by ' + Math.abs(pct(b.peakOut, f.peakOut)) + '% (' + (pct(b.peakOut, f.peakOut) >= 0 ? 'lower' : 'higher') + ').';
    text += ' That is the honest part: your 500 acres are one fifth of the 2,500 the creek drains. The other four fifths sent the same water as before. Work in the creek itself, and neighbours upstream doing the same, is what turns a creek around.';
    await ui.card({ title: 'Three years at Bluestem Ranch', text, html, buttons: [{ label: 'Continue' }] });
  }
})();
