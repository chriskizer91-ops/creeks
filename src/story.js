/* Free play and the one-year Story. No timers, no way to lose.
   Story: summer (dry creek) → fall (storms test it) → winter (planting) → spring (big storms) → before/after. */
(function () {
  const C = Creek.CONFIG, P = () => Creek.ui.PICS;
  const story = Creek.story = { token: 0 };
  const NON_PLANT = ['look', 'dig', 'pile', 'barrel', 'garden', 'bda'];
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const ft = (m) => (m * 3.281).toFixed(1);

  function stormDone(g, ui) { return new Promise((res) => { ui.stormEndHook = (r) => { ui.stormEndHook = null; res(r); }; }); }

  story.free = function () {
    const g = Creek.game, ui = Creek.ui; story.token++;
    ui.mode = 'free'; g.allowed = null; g.setSeason(null); g.season = null; g.baseMoist = 0.15;
    g.resetMap(); ui.setBanner(null); document.getElementById('btnGrow').classList.remove('hidden');
    ui.onStorm = (size) => g.startStorm(size);
    g.fitCamera(); ui.refreshHints();
    ui.toast('Free play: everything is open. Try a storm!');
  };

  story.start = async function () {
    const g = Creek.game, ui = Creek.ui, tok = ++story.token, alive = () => tok === story.token;
    ui.mode = 'story'; document.getElementById('btnGrow').classList.add('hidden');
    g.resetMap(); g.allowed = ['look']; g.season = null; g.fitCamera(); ui.setBanner(null);
    ui.onStorm = null; ui.updateTools();

    await ui.card({ img: P().moveIn, title: 'Move-in day', text: 'The boxes are stacked on the driveway. Your house sits at the bottom of a shallow bowl of about a hundred yards. Everything that falls on them, roofs and streets and lawns, runs downhill to one place: the little creek that begins right behind your back fence.', buttons: [{ label: 'Go see the creek' }] });
    await ui.card({ img: P().dryCreek, title: 'The creek behind the fence', text: 'It is summer, and the creek is dry. The banks are tall, bare and crumbling, and under them is pale stone. It will not stay dry. Before you unpack, picture what a big storm would do to the land as it is now.', buttons: [{ label: 'Picture it' }] });
    if (!alive()) return;

    // A quick preview storm on the untouched land: it is the "before" the year is measured against.
    const beforeImg = g.snapshot(520);
    let skipped = false;
    ui.setBanner('Imagining a big storm on the land as it is…', 'Skip', () => { skipped = true; g.stopStorm(); });
    g.setSeason('summer'); g.baseMoist = 0.05;
    g.startStorm(10, { turbo: true, tag: 'baseline' });
    await stormDone(g, ui);
    const baseline = skipped ? null : g.lastStorm;
    g.resetMap(); g.setSeason('summer'); if (!alive()) return;
    g.analysis = null;

    const seasons = [
      { name: 'summer', label: 'Summer', note: 'Summer: the creek is dry. Work in it.', allowed: NON_PLANT, next: 'On to fall →' },
      { name: 'fall', label: 'Fall', note: 'Fall: storms test what you built.', allowed: NON_PLANT, next: 'On to winter →',
        card: { img: P().storm, title: 'Fall: the storms come', text: 'The first real rains arrive. Send a storm of your own and watch where the water goes, and what it takes with it. Fix what it shows you.' } },
      { name: 'winter', label: 'Winter', note: 'Winter: planting season.', allowed: null, next: 'On to spring →',
        card: { img: Creek.ui.PICS.makingRoom, title: 'Winter: planting season', text: 'The ground is soft and the plants are asleep, which is the right time to move them. Native grasses, trees and willow stakes are open to you now. Roots take a season or two to reach their depth.' } },
      { name: 'spring', label: 'Spring', note: 'Spring: the big storms.', allowed: null, next: 'Finish the year ✓' }
    ];
    for (let k = 0; k < seasons.length; k++) {
      const s = seasons[k]; if (!alive()) return;
      g.setSeason(s.name); g.allowed = s.allowed; ui.updateTools();
      if (s.card) await ui.card(Object.assign({ buttons: [{ label: 'Continue' }] }, s.card));
      ui.setBanner(s.note, s.next, null);
      ui.onStorm = (size) => g.startStorm(size);
      ui.refreshHints();
      await new Promise((res) => { document.getElementById('bannerBtn').onclick = () => { if (!g.storm) res(); }; });
      if (!alive()) return;
      if (s.name !== 'summer') g.growSeason(); else g.growSeason();
    }

    // The same storm again, on the year's work.
    ui.setBanner('One last test: the same storm as the first day.', null);
    g.allowed = ['look']; ui.updateTools(); ui.onStorm = null;
    g.startStorm(10, { turbo: false, tag: 'final' });
    await stormDone(g, ui);
    const final = g.lastStorm; g.sim.dryOut(g.baseMoist, 0.5);
    const afterImg = g.snapshot(520);
    ui.setBanner(null);
    await results(g, ui, baseline, final, beforeImg, afterImg);
    await ui.card({ img: P().neighbors, title: 'A neighbour leans on the fence', text: '“What are you doing down there?” You hand them a shovel. “Making room for the water.” By winter there are six of you in the creek, weaving branches between posts.', buttons: [{ label: 'Then what?' }] });
    await ui.card({ img: P().yearsLater, title: 'Years later', text: 'Same street, same bowl, same creek. The water that used to rush now walks. There was never a villain here, only water and habit, and habits can change.', buttons: [{ label: 'Keep playing (free play)', value: 'free' }] });
    story.free();
  };

  async function results(g, ui, b, f, beforeImg, afterImg) {
    const A0 = g.initialAnalysis, A1 = g.analyze(g.sim.readTerrain());
    const bath = (m3) => Math.round(m3 / 0.3), pct = (a, c) => (a > 0 ? Math.round((1 - c / a) * 100) : 0);
    const mud = (r) => (r ? (r.mudConc * 2650).toFixed(1) + ' g/L' : '—');
    const row = (lab, a, c) => '<tr><td>' + lab + '</td><td class="n">' + a + '</td><td class="n">' + c + '</td></tr>';
    const yardCut = b ? pct(b.volFence, f.volFence) : null, creekCut = b ? pct(b.peakOut, f.peakOut) : null;
    let html = '<div class="pair"><figure><img src="' + beforeImg + '"><figcaption>Day one</figcaption></figure><figure><img src="' + afterImg + '"><figcaption>One year later</figcaption></figure></div>' +
      '<table class="res"><tr><th></th><th class="n">Before</th><th class="n">After</th></tr>' +
      row('Creek bank height', ft(A0.bankMean) + ' ft', ft(A1.bankMean) + ' ft') +
      row('Water out the back of your yard', b ? bath(b.volFence) + ' bathtubs' : '—', bath(f.volFence) + ' bathtubs') +
      row('How muddy the water ran', mud(b), mud(f)) +
      row('Soil washed from creek banks', b ? Math.round(b.creekSoilLost / 0.1) + ' wheelbarrows' : '—', Math.round(f.creekSoilLost / 0.1) + ' wheelbarrows') +
      row('Peak flow leaving the map', b ? b.peakOut.toFixed(1) + ' m³/s' : '—', f.peakOut.toFixed(1) + ' m³/s') + '</table>';
    let text = 'Both runs are the same 10-year storm.';
    if (b) text += ' Your yard sent ' + (yardCut >= 0 ? yardCut + '% less' : Math.abs(yardCut) + '% more') + ' water out the back. The creek’s peak flow changed by only ' + Math.abs(creekCut) + '%.';
    text += ' That is the true part: your yard is only about 1% of this watershed (about 2,500 m² of 250,000 m²), so even a perfect yard barely moves the creek. The creek itself, and neighbours doing the same, are what change it.';
    await ui.card({ title: 'One year at the house', text, html, buttons: [{ label: 'Continue' }] });
  }
})();
