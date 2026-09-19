/* ==========================================================================
   Power Forge — powers.js
   Data-driven Power Type definitions. Adding a new element = adding one entry
   here plus (optionally) an ability set in abilities.js. Nothing else in the
   engine hard-codes an element name.
   ========================================================================== */
(function (PF) {
  'use strict';

  /*
    Each power declares:
      colors      : palette used by projectiles, particles, HUD and the aura
      base        : level-1 stats (scaled by levels.js)
      shot        : projectile shape/behaviour data consumed by combat.js
      trail/impact: particle recipes consumed by particles.js
      sfx         : synth descriptor consumed by audio.js
    Roughly equal DPS, very different delivery.
  */
  const POWERS = {
    wind: {
      id: 'wind',
      name: 'WIND',
      tagline: 'Fast · Mobile · Relentless',
      blurb: 'Compressed air blades that cross the arena in a blink. Highest mobility, lowest weight class.',
      icon: '≈',
      colors: {
        primary: [168, 236, 255],
        secondary: [255, 255, 255],
        dark: [92, 160, 190],
        aura: [190, 245, 255]
      },
      base: {
        maxHp: 92, damage: 9, moveSpeed: 260, jumpForce: 983,
        // Nudged from 0.20 — the user said Wind's fire rate is "really
        // fast" and wanted it just slightly slower, not a rebalance.
        projSpeed: 980, cooldown: 0.23, flySpeed: 330
      },
      shot: {
        shape: 'slash', radius: 10, life: 0.85, count: 1, spread: 0.02,
        gravity: 0, knockback: 70, pierce: 0, splash: 0, wobble: 0
      },
      trail: { rate: 45, size: [2, 5], life: [0.18, 0.34], drag: 3, gravity: -40, shape: 'wisp' },
      impact: { count: 14, speed: [80, 300], size: [2, 6], life: [0.2, 0.45], gravity: -60, shape: 'wisp', ring: true },
      sfx: { type: 'sine', from: 900, to: 1700, dur: 0.09, gain: 0.07, noise: { from: 1400, to: 3200, dur: 0.12, gain: 0.06, q: 0.7 } }
    },

    water: {
      id: 'water',
      name: 'WATER',
      tagline: 'Balanced · Controlled · Sustaining',
      blurb: 'A disciplined stream with reliable damage, solid health and the only true self-heal.',
      icon: '◍',
      colors: {
        primary: [76, 168, 255],
        secondary: [186, 232, 255],
        dark: [24, 84, 160],
        aura: [120, 200, 255]
      },
      base: {
        maxHp: 108, damage: 15, moveSpeed: 260, jumpForce: 983,
        projSpeed: 720, cooldown: 0.33, flySpeed: 300
      },
      shot: {
        shape: 'orb', radius: 13, life: 1.4, count: 1, spread: 0,
        gravity: 60, knockback: 110, pierce: 0, splash: 0, wobble: 0
      },
      trail: { rate: 34, size: [2, 5], life: [0.22, 0.4], drag: 2, gravity: 220, shape: 'drop' },
      impact: { count: 18, speed: [70, 280], size: [2, 6], life: [0.25, 0.55], gravity: 520, shape: 'drop', ring: true },
      sfx: { type: 'sine', from: 520, to: 220, dur: 0.16, gain: 0.11, noise: { from: 900, to: 300, dur: 0.16, gain: 0.05, q: 1.4 } }
    },

    fire: {
      id: 'fire',
      name: 'FIRE',
      tagline: 'Heavy · Explosive · Punishing',
      blurb: 'Slow, arcing fireballs that detonate on contact. Every hit splashes — misses still hurt.',
      icon: '✷',
      colors: {
        primary: [255, 126, 42],
        secondary: [255, 214, 92],
        dark: [168, 44, 16],
        aura: [255, 160, 70]
      },
      base: {
        maxHp: 104, damage: 32, moveSpeed: 260, jumpForce: 983,
        projSpeed: 560, cooldown: 0.72, flySpeed: 275
      },
      shot: {
        shape: 'fireball', radius: 17, life: 1.7, count: 1, spread: 0,
        gravity: 110, knockback: 180, pierce: 0, splash: 74, splashFactor: 0.55, wobble: 0
      },
      trail: { rate: 52, size: [3, 9], life: [0.22, 0.5], drag: 2.2, gravity: -110, shape: 'ember' },
      impact: { count: 24, speed: [100, 400], size: [3, 10], life: [0.25, 0.6], gravity: -80, shape: 'ember', ring: true, flash: true },
      sfx: { type: 'sawtooth', from: 380, to: 90, dur: 0.22, gain: 0.1, noise: { type: 'lowpass', from: 1800, to: 300, dur: 0.26, gain: 0.12, q: 0.8 } }
    },

    sand: {
      id: 'sand',
      name: 'SAND',
      tagline: 'Heavy · Defensive · Unmovable',
      blurb: 'Dense compacted shot with brutal knockback, the deepest health pool and a deployable wall.',
      icon: '◈',
      colors: {
        primary: [226, 186, 106],
        secondary: [255, 232, 176],
        dark: [148, 106, 44],
        aura: [235, 205, 140]
      },
      base: {
        maxHp: 126, damage: 26, moveSpeed: 260, jumpForce: 983,
        projSpeed: 670, cooldown: 0.58, flySpeed: 255
      },
      /* Still the heaviest arc in the game, but shallow enough to lead by eye
         at fighting range. Sand's weight lives in its knockback and health. */
      shot: {
        shape: 'boulder', radius: 16, life: 1.6, count: 1, spread: 0,
        gravity: 230, knockback: 340, pierce: 0, splash: 46, splashFactor: 0.45, wobble: 0
      },
      trail: { rate: 40, size: [2, 6], life: [0.3, 0.6], drag: 1.4, gravity: 300, shape: 'grain' },
      impact: { count: 22, speed: [80, 300], size: [2, 7], life: [0.3, 0.7], gravity: 420, shape: 'grain', ring: true },
      sfx: { type: 'triangle', from: 240, to: 70, dur: 0.2, gain: 0.1, noise: { type: 'lowpass', from: 900, to: 180, dur: 0.24, gain: 0.11, q: 0.5 } }
    },

    lightning: {
      id: 'lightning',
      name: 'LIGHTNING',
      tagline: 'Instant · Piercing · Lethal',
      blurb: 'Near-instant bolts that punch straight through the first target. Fragile, but nothing is faster.',
      icon: '⚡',
      colors: {
        primary: [255, 236, 96],
        secondary: [255, 255, 255],
        dark: [176, 140, 20],
        aura: [255, 246, 150]
      },
      base: {
        maxHp: 88, damage: 21, moveSpeed: 260, jumpForce: 983,
        projSpeed: 1500, cooldown: 0.44, flySpeed: 345
      },
      shot: {
        shape: 'bolt', radius: 11, life: 0.6, count: 1, spread: 0.015,
        gravity: 0, knockback: 90, pierce: 1, splash: 0, wobble: 0
      },
      trail: { rate: 60, size: [2, 5], life: [0.1, 0.22], drag: 6, gravity: 0, shape: 'spark' },
      impact: { count: 20, speed: [140, 520], size: [2, 6], life: [0.12, 0.3], gravity: 0, shape: 'spark', ring: true, flash: true },
      sfx: { type: 'square', from: 1700, to: 420, dur: 0.09, gain: 0.08, noise: { type: 'highpass', from: 3000, to: 1200, dur: 0.12, gain: 0.09, q: 0.6 } }
    },

    rain: {
      id: 'rain',
      name: 'RAIN',
      tagline: 'Rapid · Area · Suffocating',
      blurb: 'A three-drop volley on a hair trigger. Tiny hits that stack faster than anything can heal.',
      icon: '⁙',
      colors: {
        primary: [128, 196, 255],
        secondary: [220, 244, 255],
        dark: [52, 108, 178],
        aura: [160, 214, 255]
      },
      /* Damage is per droplet — a full three-drop volley only lands at close
         range, which is what keeps Rain's theoretical DPS in check. */
      base: {
        maxHp: 96, damage: 4.6, moveSpeed: 260, jumpForce: 983,
        projSpeed: 860, cooldown: 0.24, flySpeed: 315
      },
      shot: {
        shape: 'droplet', radius: 7, life: 1.0, count: 3, spread: 0.13,
        gravity: 190, knockback: 34, pierce: 0, splash: 0, wobble: 0
      },
      trail: { rate: 26, size: [1, 3], life: [0.14, 0.28], drag: 2, gravity: 260, shape: 'drop' },
      impact: { count: 9, speed: [60, 210], size: [1, 4], life: [0.18, 0.4], gravity: 500, shape: 'drop', ring: false },
      sfx: { type: 'sine', from: 1200, to: 620, dur: 0.07, gain: 0.06, noise: { from: 2200, to: 900, dur: 0.09, gain: 0.05, q: 1.6 } }
    }
  };

  const ORDER = ['wind', 'water', 'fire', 'sand', 'lightning', 'rain'];

  PF.Powers = {
    all: POWERS,
    order: ORDER,
    get(id) { return POWERS[id] || POWERS.wind; },
    list() { return ORDER.map((id) => POWERS[id]); }
  };
})(window.PF);
