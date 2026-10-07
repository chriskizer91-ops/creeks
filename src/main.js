/* Start-up: make the game, survey the ranch, show the title picture, wait for a choice. */
(function () {
  const q = new URLSearchParams(location.search);
  async function main() {
    const ui = Creek.ui, game = Creek.game = new Creek.Game(document.getElementById('gl'));
    window.game = game;   // handy for poking around in the browser console
    ui.init(game);
    try {
      await game.boot(q.has('level') ? +q.get('level') : null);
    } catch (e) {
      ui.splash(null);
      await ui.card({ title: 'This device can’t run the game yet', text: String(e.message || e) + ' It needs a browser with WebGL2 (recent Chrome, Safari 15+ or Firefox) and a decent graphics chip.', buttons: [{ label: 'OK' }] });
      return;
    }
    if (q.has('free')) { Creek.story.free(); return; }
    const v = await ui.card({
      cls: 'title', img: ui.PICS.title, title: Creek.CONFIG.title, text: 'You have inherited a 500-acre ranch and the creek that runs through it. Dig, plant and farm differently, then watch what the storm does.',
      buttons: [{ label: 'Story: the first years', value: 'story' }, { label: 'Free play', value: 'free', alt: true }, { label: 'Picture book', value: 'book', alt: true }]
    });
    if (v === 'story') Creek.story.start(); else if (v === 'book') { Creek.story.free(); ui.book(); } else Creek.story.free();
  }
  main();
})();
