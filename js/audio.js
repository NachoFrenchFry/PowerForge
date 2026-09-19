/* ==========================================================================
   Power Forge — audio.js
   Tiny Web Audio synth. No external files, no copyrighted assets.
   All sounds are generated from oscillators + filtered noise.
   ========================================================================== */
(function (PF) {
  'use strict';

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let muted = false;
  let supported = true;

  function ensure() {
    if (ctx || !supported) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { supported = false; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.28;
      master.connect(ctx.destination);

      // 1s of white noise, reused by every noise-based effect.
      const len = ctx.sampleRate;
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) {
      supported = false;
    }
    return ctx;
  }

  function t0() { return ctx.currentTime; }

  /* A pitch-swept oscillator blip. */
  function blip(o) {
    if (muted || !ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = t0();
    const dur = o.dur || 0.12;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.from || 440, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to || o.from || 440), now + dur);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain || 0.2), now + (o.attack || 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      gain.connect(f); f.connect(master);
    } else {
      gain.connect(master);
    }
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  /* A filtered noise burst — impacts, wind, rain, explosions. */
  function noise(o) {
    if (muted || !ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = t0();
    const dur = o.dur || 0.16;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = o.type || 'bandpass';
    filt.frequency.setValueAtTime(o.from || 900, now);
    filt.frequency.exponentialRampToValueAtTime(Math.max(60, o.to || o.from || 900), now + dur);
    filt.Q.value = o.q == null ? 1.2 : o.q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain || 0.18), now + (o.attack || 0.006));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt); filt.connect(gain); gain.connect(master);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /* Named effects. Powers pass their own `sfx` descriptor for shots. */
  const Audio = {
    unlock() { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); },
    setMuted(v) { muted = !!v; },
    isMuted() { return muted; },
    toggleMute() { muted = !muted; return muted; },

    click() { blip({ type: 'square', from: 520, to: 720, dur: 0.06, gain: 0.08 }); },
    hover() { blip({ type: 'sine', from: 700, to: 820, dur: 0.04, gain: 0.03 }); },

    /* sfx = { type, from, to, dur, gain, noise:{...} } declared per power. */
    shoot(sfx) {
      if (!sfx) { blip({ from: 600, to: 300, dur: 0.09, gain: 0.12 }); return; }
      blip({ type: sfx.type, from: sfx.from, to: sfx.to, dur: sfx.dur, gain: sfx.gain || 0.13 });
      if (sfx.noise) noise(sfx.noise);
    },
    hit() {
      noise({ type: 'bandpass', from: 1600, to: 300, dur: 0.12, gain: 0.14, q: 0.9 });
      blip({ type: 'triangle', from: 300, to: 120, dur: 0.1, gain: 0.09 });
    },
    explode() {
      noise({ type: 'lowpass', from: 1400, to: 90, dur: 0.42, gain: 0.26, q: 0.6 });
      blip({ type: 'sine', from: 160, to: 45, dur: 0.4, gain: 0.16 });
    },
    hurt() { blip({ type: 'sawtooth', from: 260, to: 90, dur: 0.2, gain: 0.14, filter: 900 }); },
    ability() {
      blip({ type: 'triangle', from: 420, to: 900, dur: 0.16, gain: 0.12 });
      noise({ from: 1200, to: 2400, dur: 0.18, gain: 0.07 });
    },
    fly() {
      blip({ type: 'sine', from: 300, to: 900, dur: 0.3, gain: 0.11 });
      noise({ from: 500, to: 1800, dur: 0.35, gain: 0.06 });
    },
    land() { noise({ type: 'lowpass', from: 700, to: 120, dur: 0.1, gain: 0.07 }); },
    exp() { blip({ type: 'sine', from: 900, to: 1500, dur: 0.07, gain: 0.05 }); },
    pickup() {
      blip({ type: 'sine', from: 520, to: 1040, dur: 0.09, gain: 0.09 });
      setTimeout(() => blip({ type: 'sine', from: 780, to: 1300, dur: 0.08, gain: 0.07 }), 55);
    },
    eat() {
      noise({ type: 'lowpass', from: 500, to: 200, dur: 0.08, gain: 0.1, q: 0.8 });
      blip({ type: 'triangle', from: 220, to: 340, dur: 0.14, gain: 0.1 });
    },
    levelUp() {
      const notes = [523, 659, 784, 1046];
      notes.forEach((f, i) => setTimeout(() => blip({ type: 'triangle', from: f, to: f * 1.01, dur: 0.34, gain: 0.16 }), i * 95));
    },
    unlockAbility() {
      const notes = [784, 1046, 1318];
      notes.forEach((f, i) => setTimeout(() => blip({ type: 'sine', from: f, to: f * 1.5, dur: 0.4, gain: 0.14 }), i * 120));
    },
    victory() {
      const notes = [523, 659, 784, 1046, 1318];
      notes.forEach((f, i) => setTimeout(() => blip({ type: 'square', from: f, to: f, dur: 0.28, gain: 0.1 }), i * 110));
    },
    defeat() {
      const notes = [440, 370, 294, 220];
      notes.forEach((f, i) => setTimeout(() => blip({ type: 'sawtooth', from: f, to: f * 0.98, dur: 0.42, gain: 0.11, filter: 1200 }), i * 170));
    },
    countdown(final) {
      blip({ type: 'square', from: final ? 900 : 500, to: final ? 1400 : 500, dur: final ? 0.4 : 0.12, gain: 0.13 });
    },
    portal() {
      blip({ type: 'sine', from: 200, to: 1200, dur: 0.45, gain: 0.11 });
      noise({ from: 400, to: 3000, dur: 0.4, gain: 0.06 });
    },
    targetBreak() {
      noise({ type: 'highpass', from: 2200, to: 800, dur: 0.28, gain: 0.14 });
      blip({ type: 'square', from: 800, to: 200, dur: 0.2, gain: 0.09 });
    }
  };

  PF.Audio = Audio;
})(window.PF);
