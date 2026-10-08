/* Sound for the ranch. Module id "audio". Exposes Creek.audio.
   Everything is made on the fly with WebAudio (no sound files): rain, running water, wind, thunder, soft nature sounds for each season,
   little tool sounds and a chime for new postcards. Nothing is made until the player has touched the screen once (browsers insist),
   and a missing or broken AudioContext never gets in the way: every call here is wrapped so that the game just stays quiet.
   Cheap by design: one looped noise buffer of each kind, a handful of always-there nodes, and only tiny one-shot nodes for tool sounds.
   Other code can use: Creek.audio.chime(), Creek.audio.play(name), Creek.audio.enabled(), Creek.audio.setEnabled(on), Creek.audio.state(). */
(function () {
  const S = () => Creek.settings;
  const warned = {};
  /** Run fn; a throw is reported once (as a warning) and swallowed: sound must never break the game. */
  function guard(what, fn) {
    try { return fn(); } catch (e) { if (!warned[what]) { warned[what] = 1; try { console.warn('[creek] audio: ' + what + ' failed:', e); } catch (x) { /* ignore */ } } }
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rnd = (a, b) => a + Math.random() * (b - a);

  let game = null, ui = null, btn = null;
  let ctx = null, N = null;                 // N = the permanent nodes, built once the context exists
  let gestured = false, broken = false, hiddenSuspend = false, offTimer = 0, schedTimer = 0;
  let acc = 0, prevFlash = 0;
  let flowLvl = 0, trickleLvl = 0, active = 0;
  let lastTick = 0, lastProbe = 0, lastCash = null;
  const L = { rain: 0, water: 0, wind: 0, amb: 0 };    // the last targets we set (for tests and for skipping no-op updates)
  const amb = { cic: 0, cri: 0, bird: 0 };            // when the next cricket chirp / bird call may start (context time)

  // ---------------------------------------------------------------- settings
  const enabled = () => S().get('sound', true) !== false;
  const volume = () => clamp(+S().get('audio.volume', 0.5), 0, 1);
  const nature = () => S().get('audio.nature', true) !== false;
  const masterTarget = () => 0.9 * Math.pow(volume(), 1.5);

  // ---------------------------------------------------------------- building the sound world (once, after a gesture)
  function noiseBuffer(seconds, pink) {
    const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (!pink) { d[i] = w * 0.8; continue; }
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.12; b6 = w * 0.115926;
    }
    return buf;
  }
  function loopSrc(buf) { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * buf.duration * 0.9); return s; }
  function biq(type, f, q) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; }
  function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function osc(type, f) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; }

  function build() {
    N = {};
    N.white = noiseBuffer(2, false); N.pink = noiseBuffer(3, true);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.3;
    N.master = gain(0); N.master.connect(comp); comp.connect(ctx.destination);
    N.sfx = gain(1); N.sfx.connect(N.master);
    const white = loopSrc(N.white), pink = loopSrc(N.pink);
    // rain: hissing noise, no deep rumble and no harsh top
    N.rain = gain(0); const rhp = biq('highpass', 900, 0.7), rlp = biq('lowpass', 7500, 0.5);
    white.connect(rhp); rhp.connect(rlp); rlp.connect(N.rain); N.rain.connect(N.master);
    // running water: band-passed noise whose pitch wanders slowly, so it burbles
    N.water = gain(0); const wbp = biq('bandpass', 520, 0.9); pink.connect(wbp); wbp.connect(N.water); N.water.connect(N.master);
    const wl = osc('sine', 0.37), wlg = gain(170); wl.connect(wlg); wlg.connect(wbp.frequency);
    // wind: low, slowly swelling noise
    N.wind = gain(0); const wlp = biq('lowpass', 520, 0.6), wmod = gain(1); pink.connect(wlp); wlp.connect(wmod); wmod.connect(N.wind); N.wind.connect(N.master);
    const wo = osc('sine', 0.07), wog = gain(0.45); wo.connect(wog); wog.connect(wmod.gain);
    // thunder: a deep rumble that only opens for a thunderclap
    N.thunder = gain(0); N.thunderLP = biq('lowpass', 220, 0.7); pink.connect(N.thunderLP); N.thunderLP.connect(N.thunder); N.thunder.connect(N.master);
    // nature: three little instruments that stay silent until the scheduler plays them, all through one soft gain
    N.amb = gain(0); N.amb.connect(N.master);
    N.cicEnv = gain(0); const cicAm = gain(0.5), cicOsc = osc('sine', 4300), cicLfo = osc('sine', 31), cicDepth = gain(0.5);
    cicOsc.connect(cicAm); cicLfo.connect(cicDepth); cicDepth.connect(cicAm.gain); cicAm.connect(N.cicEnv); N.cicEnv.connect(N.amb);
    N.criEnv = gain(0); N.criOsc = osc('sine', 4700); N.criOsc.connect(N.criEnv); N.criEnv.connect(N.amb);
    N.birdEnv = gain(0); N.birdOsc = osc('sine', 3000); N.birdOsc.connect(N.birdEnv); N.birdEnv.connect(N.amb);
    N.sources = [white, pink];
  }

  /** Make the context the first time it is wanted and allowed (after a gesture, with sound on). */
  function ensure() {
    if (ctx) return true;
    if (broken || !gestured || !enabled()) return false;
    const ok = guard('start', () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
      build(); applyEnabled(); startScheduler();
      return true;
    });
    if (!ok) { broken = true; try { if (ctx) ctx.close(); } catch (e) { /* ignore */ } ctx = null; N = null; return false; }
    return true;
  }

  // ---------------------------------------------------------------- on / off, hidden page
  function setTarget(param, v, tc) { param.setTargetAtTime(v, ctx.currentTime, tc || 0.2); }
  function applyEnabled() {
    if (!ctx || !N) return;
    guard('apply', () => {
      const on = enabled() && !document.hidden;
      clearTimeout(offTimer);
      if (on) {
        if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
        setTarget(N.master.gain, masterTarget(), 0.12); startScheduler(); lastCash = game ? game.cash : null; updateLevels(true);
      } else {
        setTarget(N.master.gain, 0, 0.05);
        offTimer = setTimeout(() => { if (ctx && !(enabled() && !document.hidden)) { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } }, 350);
        stopScheduler();
      }
    });
  }
  function onVisibility() { if (ctx) applyEnabled(); }
  function onGesture() {
    gestured = true;
    if (!enabled()) return;
    if (!ctx) ensure();
    else if (!document.hidden && ctx.state === 'suspended') applyEnabled();      // the browser may have paused us (autoplay rules, a phone call)
  }
  function syncButton() {
    if (!btn) return;
    const on = enabled(); btn.classList.toggle('on', on); btn.textContent = on ? '🔊' : '🔇';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---------------------------------------------------------------- the ambient mix: follows the weather and the creek
  /** Set a gain smoothly; skips tiny changes so the audio thread is not given new automation for nothing. */
  function follow(key, param, v, tc) {
    if (Math.abs(v - L[key]) < 0.002 && !(v === 0 && L[key] !== 0)) return;
    L[key] = v; setTarget(param, v, tc);
  }
  function updateLevels(force) {
    if (!ctx || !N || ctx.state !== 'running' && !force) return;
    const w = game.weather || { rain: 0 }, rain = clamp(w.rain || 0, 0, 1);
    if (force) { L.rain = L.water = L.wind = L.amb = -1; }
    follow('rain', N.rain.gain, 0.34 * Math.pow(rain, 1.3), 0.25);
    follow('water', N.water.gain, clamp(trickleLvl + flowLvl * 0.26, 0, 0.3), 0.35);
    follow('wind', N.wind.gain, 0.05 + 0.13 * rain + (game.season === 'winter' ? 0.02 : 0), 0.6);
    follow('amb', N.amb.gain, nature() ? 0.09 * (1 - rain) * (1 - clamp(flowLvl * 1.5, 0, 0.6)) : 0, 0.8);
  }
  /** How loud the dry-weather trickle is, from the creek's base flow (litres a second). Called on events, never per frame. */
  function updateTrickle() {
    const bf = game && game.baseflow ? game.baseflow() : 0;
    trickleLvl = 0.11 * clamp(Math.log10(1 + Math.max(bf, 0)) / Math.log10(61), 0, 1);
  }

  // ---------------------------------------------------------------- nature (season ambience), scheduled a little ahead of time
  function startScheduler() { if (!schedTimer && ctx) schedTimer = setInterval(() => guard('nature', schedule), 450); }
  function stopScheduler() { clearInterval(schedTimer); schedTimer = 0; }
  function schedule() {
    if (!ctx || !N || ctx.state !== 'running' || document.hidden || !enabled() || !nature()) return;
    const now = ctx.currentTime, ahead = now + 0.9, season = game.season, calm = (game.weather ? game.weather.rain : 0) < 0.25;
    if (!calm) return;
    if (season === 'summer' && now >= amb.cic) {                 // cicadas: a buzz that swells and fades every few seconds
      const peak = rnd(0.25, 0.6), len = rnd(2.5, 6);
      N.cicEnv.gain.setTargetAtTime(peak, now, 0.9); N.cicEnv.gain.setTargetAtTime(0, now + len, 1.2);
      amb.cic = now + len + rnd(1.5, 5);
    } else if (season === 'fall') {                             // crickets: little groups of three quick chirps
      while (amb.cri < ahead) {
        let t = Math.max(amb.cri, now + 0.05); const g = N.criEnv.gain, f = rnd(4400, 5000);
        N.criOsc.frequency.setValueAtTime(f, t);
        for (let k = 0; k < 3; k++) { g.setValueAtTime(0, t); g.linearRampToValueAtTime(0.5, t + 0.008); g.linearRampToValueAtTime(0, t + 0.026); t += 0.055; }
        amb.cri = t + rnd(0.25, 1.1);
      }
    } else if (season === 'spring' && now >= amb.bird) {        // birds: a short rising whistle, sometimes two or three
      let t = now + 0.05; const n = 1 + Math.floor(Math.random() * 3), f0 = rnd(2200, 3200), up = Math.random() < 0.7;
      for (let k = 0; k < n; k++) {
        const a = f0 * (1 + 0.08 * k), b = up ? a * rnd(1.25, 1.5) : a * rnd(0.65, 0.8);
        N.birdOsc.frequency.setValueAtTime(a, t); N.birdOsc.frequency.exponentialRampToValueAtTime(b, t + 0.1);
        const g = N.birdEnv.gain; g.setValueAtTime(0, t); g.linearRampToValueAtTime(0.7, t + 0.02); g.linearRampToValueAtTime(0, t + 0.12);
        t += 0.16;
      }
      amb.bird = t + rnd(1.2, 4.5);
    }
  }

  // ---------------------------------------------------------------- thunder
  function thunder(strength) {
    if (!ctx || !N || ctx.state !== 'running') return;
    const t = ctx.currentTime + rnd(0.35, 2.3), peak = clamp(0.25 + 0.4 * strength, 0.2, 0.7), tail = rnd(1.1, 2.2);
    N.thunderLP.frequency.cancelScheduledValues(t); N.thunderLP.frequency.setValueAtTime(rnd(220, 330), t);
    N.thunderLP.frequency.exponentialRampToValueAtTime(70, t + 2.4);
    N.thunder.gain.setTargetAtTime(peak, t, 0.06); N.thunder.gain.setTargetAtTime(0, t + 0.25, tail * 0.5);
  }

  // ---------------------------------------------------------------- one-shot sounds (tool sounds, chime, tick)
  const MAX_VOICES = 14;
  function endVoice(node) { active++; node.onended = () => { active--; }; }
  /** A short pitched sound. type: sine|triangle..., slides from f0 to f1 over dur seconds. */
  function tone(type, f0, f1, dur, peak, when, attack) {
    if (active >= MAX_VOICES) return;
    const t = ctx.currentTime + (when || 0), o = ctx.createOscillator(), g = ctx.createGain(), a = attack || 0.006;
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(N.sfx); o.start(t); o.stop(t + dur + 0.03); endVoice(o);
  }
  /** A short burst of noise through one filter whose pitch slides from f0 to f1. */
  function burst(kind, ftype, f0, f1, q, dur, peak, when, attack) {
    if (active >= MAX_VOICES) return;
    const t = ctx.currentTime + (when || 0), s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), a = attack || 0.01;
    s.buffer = kind === 'pink' ? N.pink : N.white; f.type = ftype; f.Q.value = q; f.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(N.sfx); s.start(t, Math.random() * 1.2, dur + 0.05); endVoice(s);
  }
  const SOUNDS = {
    thunk:  (v) => { tone('sine', 150 * (v || 1), 55, 0.16, 0.5); burst('pink', 'lowpass', 500 * (v || 1), 200, 0.7, 0.12, 0.3); },
    settle: () => { tone('sine', 110, 50, 0.13, 0.28); burst('pink', 'lowpass', 350, 150, 0.7, 0.09, 0.16); },
    splash: () => { burst('white', 'bandpass', 900, 2400, 1.1, 0.4, 0.3, 0, 0.03); tone('sine', 560, 250, 0.2, 0.22); tone('sine', 480, 220, 0.18, 0.15, 0.11); burst('white', 'bandpass', 1600, 700, 1.4, 0.25, 0.14, 0.14, 0.02); },
    rustle: () => { for (let k = 0; k < 3; k++) burst('white', 'highpass', 3200, 5200, 0.6, 0.12, 0.13, k * 0.075, 0.015); },
    knock:  () => { tone('triangle', 430, 380, 0.1, 0.4); burst('white', 'lowpass', 1800, 900, 0.8, 0.04, 0.2); tone('triangle', 470, 410, 0.1, 0.34, 0.12); },
    coin:   () => { tone('sine', 1568, 1568, 0.32, 0.16); tone('sine', 2093, 2093, 0.4, 0.14, 0.07); tone('sine', 3136, 3136, 0.25, 0.04, 0.07); },
    tick:   () => { tone('sine', 1320, 1180, 0.07, 0.12); tone('sine', 2640, 2400, 0.04, 0.04); },
    probe:  () => { tone('sine', 900, 700, 0.05, 0.07); },
    chime:  () => { [784, 988, 1175, 1568].forEach((f, k) => { tone('sine', f, f, 0.9 - k * 0.1, 0.17, k * 0.13, 0.01); tone('sine', f * 2, f * 2, 0.5, 0.03, k * 0.13, 0.01); }); },
    pop:    () => { tone('sine', 420, 640, 0.09, 0.14); tone('sine', 640, 900, 0.1, 0.1, 0.07); }
  };
  /** Play a named sound if sound is on and the context is running. Returns true if it was played. */
  function play(name, a) {
    if (!ctx || !N || ctx.state !== 'running' || !enabled() || document.hidden || !SOUNDS[name]) return false;
    return !!guard('play ' + name, () => { SOUNDS[name](a); return true; });
  }

  // ---------------------------------------------------------------- what the game tells us
  function onStrokeStart(e) {
    if (!e) return;
    const t = e.tool;
    if (t === 'dig') play('thunk', 1); else if (t === 'pile') play('thunk', 1.25); else if (t === 'swale') play('thunk', 1.15);
    else if (t === 'dam') play('knock'); else if (t === 'plant' && (e.opt === 'grass' || e.opt === 'willow')) play('rustle');
  }
  function onStrokeEnd(e) {
    if (!e || e.cancelled) return;
    const t = e.tool;
    if (t === 'pond') play('splash');
    else if (t === 'plant' && e.opt === 'tree') { play('thunk', 1.3); play('rustle'); }
    else if (t === 'dig' || t === 'pile' || t === 'swale') play('settle');
    else if (t === 'dam') play('knock');
  }
  function onCash(v) {
    const prev = lastCash; lastCash = v;
    if (prev == null || v === prev) return;
    const now = performance.now(); if (now - lastTick < 120) return; lastTick = now;
    play(v > prev ? 'coin' : 'tick');
  }
  function onProbe() { const now = performance.now(); if (now - lastProbe < 160) return; lastProbe = now; play('probe'); }
  function onFrame(dt) {
    const w = game.weather; if (!w) return;
    const f = w.flash || 0;
    if (f > prevFlash + 0.25 && f > 0.4) guard('thunder', () => thunder(f));       // a flash just started
    prevFlash = f;
    acc += dt; if (acc < 0.1) return; acc = 0;
    guard('levels', updateLevels);
  }

  // ---------------------------------------------------------------- the public face
  Creek.audio = {
    /** Is sound switched on (the speaker button / Settings)? */
    enabled: enabled,
    setEnabled: function (on) { S().set('sound', !!on); },
    volume: volume,
    setVolume: function (v) { S().set('audio.volume', clamp(+v || 0, 0, 1)); },
    /** The gentle postcard chime. */
    chime: function () { return play('chime'); },
    /** Play one of: thunk settle splash rustle knock coin tick probe chime pop. */
    play: play,
    /** For tests and curiosity: what exists and how loud things are right now. */
    state: function () {
      return {
        created: !!ctx, ctxState: ctx ? ctx.state : null, enabled: enabled(), gestured: gestured, broken: broken, hidden: !!document.hidden,
        voices: active, targets: Object.assign({}, L),
        master: N ? N.master.gain.value : null, rain: N ? N.rain.gain.value : null, water: N ? N.water.gain.value : null,
        wind: N ? N.wind.gain.value : null, thunder: N ? N.thunder.gain.value : null, amb: N ? N.amb.gain.value : null, flow: flowLvl, trickle: trickleLvl,
        nature: { cicadas: N ? N.cicEnv.gain.value : null, nextCricket: amb.cri, nextBird: amb.bird, nextCicada: amb.cic }
      };
    }
  };

  Creek.registerModule({
    id: 'audio',
    init: function (g, u) {
      game = g; ui = u;
      guard('init', () => {
        ui.addSetting({ id: 'sound', label: 'Sound', help: 'Rain, water, wind and little tool sounds.', type: 'toggle', default: true });
        ui.addSetting({ id: 'audio.volume', label: 'Volume', type: 'slider', min: 0, max: 10, step: 1, default: 5,
          get: () => Math.round(volume() * 10), set: (v) => S().set('audio.volume', clamp(v / 10, 0, 1)) });
        ui.addSetting({ id: 'audio.nature', label: 'Nature sounds', help: 'Soft birds, crickets and cicadas that change with the season.', type: 'toggle', default: true });
        btn = ui.addButton({ slot: 'view', id: 'soundBtn', label: '🔊', title: 'Sound on or off', toggle: true, on: enabled(),
          onClick: (on) => { onGesture(); S().set('sound', !!on); syncButton(); } });
        syncButton();
        S().on('sound', () => { syncButton(); onGesture(); if (ctx) applyEnabled(); });
        S().on('audio.volume', () => { if (ctx && N && enabled() && !document.hidden) setTarget(N.master.gain, masterTarget(), 0.1); });
        S().on('audio.nature', () => { if (ctx) updateLevels(true); });
        ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach((ev) => document.addEventListener(ev, onGesture, { capture: true, passive: true }));
        document.addEventListener('visibilitychange', onVisibility);
        // the game's events: each handler is guarded so a sound problem can never reach the game loop
        game.on('frame', (dt) => guard('frame', () => onFrame(dt)));
        game.on('stormStart', () => { flowLvl = 0; prevFlash = 0; });
        game.on('stormStep', (s) => { flowLvl = clamp(Math.log(1 + Math.max(s.Qout, 0)) / Math.log(41), 0, 1); });
        game.on('stormEnd', () => { flowLvl = 0; guard('trickle', updateTrickle); });
        game.on('season', () => guard('trickle', () => { updateTrickle(); if (ctx) updateLevels(true); }));
        game.on('reset', () => { flowLvl = 0; guard('trickle', updateTrickle); });
        game.on('strokeStart', (e) => guard('strokeStart', () => onStrokeStart(e)));
        game.on('strokeEnd', (e) => guard('strokeEnd', () => onStrokeEnd(e)));
        game.on('cash', (v) => guard('cash', () => onCash(v)));
        game.on('probe', () => guard('probe', onProbe));
        game.on('fieldUse', () => guard('fieldUse', () => play('pop')));
      });
    },
    ready: function () { guard('ready', () => { updateTrickle(); lastCash = game.cash; if (ctx) updateLevels(true); }); }
  });
})();
