/* ==========================================================================
   Power Forge — levels.js
   EXP curve and stat scaling. One place to tune the whole progression.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;

  const Levels = {
    MAX_LEVEL: 60,
    /* Every level from 2-12 hands you an ability, and those abilities are
       now worth having, so a level is a real purchase: 3x the old cost
       (65 -> 195), and the curve is steepened as well (1.65 -> 1.9) so the
       later ones cost progressively more rather than just uniformly more.
       Both together, the last ability costs ~5.6x what it used to. */
    BASE_EXP: 195,
    EXP_POWER: 1.9,

    /* EXP needed to go from `level` to `level + 1`. Superlinear on purpose:
       L1→2 = 195 (~3 cows), L5→6 = ~4150 (~59), L11→12 = ~18500 (~265). */
    expToNext(level) {
      if (level >= this.MAX_LEVEL) return Infinity;
      return Math.floor(this.BASE_EXP * Math.pow(level, this.EXP_POWER));
    },

    /* Total EXP invested to reach `level` from 1 — used for level loss. */
    totalExpTo(level) {
      let sum = 0;
      for (let i = 1; i < level; i++) sum += this.expToNext(i);
      return sum;
    },

    /* ---- stat scaling ------------------------------------------------
       Growth is deliberately gentle so a level 5 fight stays readable and a
       level 30 fight doesn't become one-shot roulette. */
    statsFor(power, level) {
      const b = power.base;
      const n = Math.max(0, level - 1);
      return {
        maxHp: Math.round(b.maxHp + 7.5 * n),
        damage: +(b.damage * (1 + 0.085 * n)).toFixed(2),
        moveSpeed: Math.round(b.moveSpeed * (1 + Math.min(0.30, 0.006 * n))),
        jumpForce: Math.round(b.jumpForce * (1 + Math.min(0.14, 0.003 * n))),
        projSpeed: Math.round(b.projSpeed * (1 + Math.min(0.45, 0.014 * n))),
        cooldown: +(b.cooldown * Math.max(0.62, 1 - 0.011 * n)).toFixed(3),
        flySpeed: Math.round(b.flySpeed * (1 + Math.min(0.28, 0.006 * n)))
      };
    },

    /* Rough "power score" shown in menus as an at-a-glance strength readout. */
    powerScore(stats) {
      return Math.round(stats.damage / stats.cooldown * 4 + stats.maxHp * 0.6);
    },

    /* ---- wildlife rewards ----------------------------------------------
       Start simple — a flat per-species reward, no level scaling — and see
       how it feels. The primary EXP source just changed from training-dummy
       breaking to mob-killing, so the curve above (BASE_EXP/EXP_POWER) may
       need a rebalancing pass once the user has played it; that's a tuning
       pass for later, not something to solve here. */
    expForMobKill(expReward, playerLevel) {
      return expReward;
    },

    clampLevel(level) {
      return U.clamp(Math.floor(level), 1, this.MAX_LEVEL);
    }
  };

  PF.Levels = Levels;
})(window.PF);
