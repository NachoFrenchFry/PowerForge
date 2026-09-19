/* ==========================================================================
   Power Forge — particles.js
   Pooled particle system with a hard cap so the game can never drown itself
   in effects. Shapes are drawn procedurally; each power supplies a recipe.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  /* Raised from 1400: the reworked abilities lean hard on particle count
     (a lava geyser alone emits a few hundred over its lifetime), and the
     pool is shared with the player's permanent swirl and all combat FX.
     Everything off-screen is culled before it costs a draw call. */
  const MAX = 2600;

  function makeParticle() {
    return {
      alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1,
      size: 3, color: [255, 255, 255], gravity: 0, drag: 0,
      shape: 'spark', rot: 0, spin: 0, glow: 0.6, fadeIn: 0, additive: true,
      behindPlayer: false
    };
  }

  class ParticleSystem {
    constructor() {
      this.pool = new Array(MAX);
      for (let i = 0; i < MAX; i++) this.pool[i] = makeParticle();
      this.count = 0;
      this._cursor = 0;
    }

    clear() {
      for (let i = 0; i < MAX; i++) this.pool[i].alive = false;
      this.count = 0;
    }

    /* Grab a free slot; when full, recycle the oldest scanned slot so new
       (more relevant) effects always show. */
    _acquire() {
      for (let i = 0; i < MAX; i++) {
        const idx = (this._cursor + i) % MAX;
        if (!this.pool[idx].alive) {
          this._cursor = (idx + 1) % MAX;
          this.count++;
          return this.pool[idx];
        }
      }
      const p = this.pool[this._cursor];
      this._cursor = (this._cursor + 1) % MAX;
      return p;
    }

    spawn(opts) {
      const p = this._acquire();
      p.alive = true;
      p.x = opts.x; p.y = opts.y;
      p.vx = opts.vx || 0; p.vy = opts.vy || 0;
      p.maxLife = opts.life || 0.4;
      p.life = p.maxLife;
      p.size = opts.size || 3;
      p.color = opts.color || [255, 255, 255];
      p.gravity = opts.gravity || 0;
      p.drag = opts.drag || 0;
      p.shape = opts.shape || 'spark';
      p.rot = opts.rot || Math.random() * Math.PI * 2;
      p.spin = opts.spin || 0;
      p.glow = opts.glow == null ? 0.7 : opts.glow;
      p.additive = opts.additive !== false;
      // Set only by the player's power-swirl: draws this particle in the
      // pass BEFORE the player sprite instead of after, so half the swirl
      // reads as passing behind the body — a cheap semi-3D wraparound.
      p.behindPlayer = !!opts.behindPlayer;
      return p;
    }

    /* Radial burst — impacts, explosions, level ups. */
    burst(x, y, recipe, colors, scale) {
      const s = scale || 1;
      const n = Math.round((recipe.count || 10) * s);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = U.rand(recipe.speed[0], recipe.speed[1]) * s;
        this.spawn({
          x: x, y: y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          size: U.rand(recipe.size[0], recipe.size[1]) * s,
          life: U.rand(recipe.life[0], recipe.life[1]),
          color: Math.random() < 0.45 ? colors.secondary : colors.primary,
          gravity: recipe.gravity || 0,
          drag: 2.2,
          shape: recipe.shape || 'spark',
          spin: U.rand(-8, 8)
        });
      }
      if (recipe.ring) this.ring(x, y, colors.secondary, 8 * s, 0.28);
      if (recipe.flash) this.flash(x, y, colors.primary, 40 * s, 0.16);
    }

    /* Directional cone — muzzle flashes, dash smoke. */
    cone(x, y, angle, spread, recipe, colors, scale) {
      const s = scale || 1;
      const n = Math.round((recipe.count || 8) * s);
      for (let i = 0; i < n; i++) {
        const a = angle + U.rand(-spread, spread);
        const sp = U.rand(recipe.speed[0], recipe.speed[1]) * s;
        this.spawn({
          x: x, y: y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          size: U.rand(recipe.size[0], recipe.size[1]) * s,
          life: U.rand(recipe.life[0], recipe.life[1]),
          color: Math.random() < 0.5 ? colors.secondary : colors.primary,
          gravity: recipe.gravity || 0,
          drag: 2.6,
          shape: recipe.shape || 'spark',
          spin: U.rand(-6, 6)
        });
      }
    }

    ring(x, y, color, size, life) {
      this.spawn({ x, y, size: size, life: life || 0.3, color: color, shape: 'ring', glow: 0.9, drag: 0 });
    }

    flash(x, y, color, size, life) {
      this.spawn({ x, y, size: size, life: life || 0.15, color: color, shape: 'flash', glow: 1 });
    }

    /* Persistent trail behind a moving object. */
    trail(x, y, recipe, colors, dt, budget) {
      const rate = (recipe.rate || 30) * (budget == null ? 1 : budget);
      let n = rate * dt;
      let whole = Math.floor(n);
      if (Math.random() < n - whole) whole++;
      for (let i = 0; i < whole; i++) {
        this.spawn({
          x: x + U.rand(-3, 3), y: y + U.rand(-3, 3),
          vx: U.rand(-24, 24), vy: U.rand(-24, 24),
          size: U.rand(recipe.size[0], recipe.size[1]),
          life: U.rand(recipe.life[0], recipe.life[1]),
          color: Math.random() < 0.4 ? colors.secondary : colors.primary,
          gravity: recipe.gravity || 0,
          drag: recipe.drag || 2,
          shape: recipe.shape || 'spark',
          spin: U.rand(-5, 5)
        });
      }
    }

    update(dt) {
      let alive = 0;
      for (let i = 0; i < MAX; i++) {
        const p = this.pool[i];
        if (!p.alive) continue;
        p.life -= dt;
        if (p.life <= 0) { p.alive = false; continue; }
        p.vy += p.gravity * dt;
        if (p.drag) {
          const d = Math.exp(-p.drag * dt);
          p.vx *= d; p.vy *= d;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        alive++;
      }
      this.count = alive;
    }

    /* `wantBehind`: omit (or false) to draw every particle NOT flagged
       behindPlayer (the normal pass, called after the player sprite); pass
       true to draw only the ones that are (a pass called BEFORE the player
       sprite instead). Everything except the player's power-swirl leaves
       behindPlayer false, so omitting the flag renders exactly as before. */
    render(ctx, cam, wantBehind) {
      const left = cam.x - 80, right = cam.x + U.GW + 80;
      const top = cam.y - 80, bottom = cam.y + U.GH + 80;
      ctx.save();
      for (let i = 0; i < MAX; i++) {
        const p = this.pool[i];
        if (!p.alive) continue;
        if (!!p.behindPlayer !== !!wantBehind) continue;
        if (p.x < left || p.x > right || p.y < top || p.y > bottom) continue;
        const t = p.life / p.maxLife;         // 1 -> 0
        const a = Math.max(0, Math.min(1, t)) * p.glow;
        ctx.globalCompositeOperation = p.additive ? 'lighter' : 'source-over';

        switch (p.shape) {
          case 'ring': {
            const r = p.size * (1 + (1 - t) * 4.5);
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = U.rgba(p.color, a * 0.85);
            ctx.lineWidth = Math.max(1, 3 * t);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.stroke();
            break;
          }
          case 'flash': {
            const r = p.size * (0.6 + (1 - t) * 1.1);
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
            g.addColorStop(0, U.rgba(p.color, a));
            g.addColorStop(1, U.rgba(p.color, 0));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'wisp': {
            ctx.strokeStyle = U.rgba(p.color, a * 0.9);
            ctx.lineWidth = Math.max(1, p.size * 0.6);
            ctx.lineCap = 'round';
            const len = p.size * 3;
            const ang = Math.atan2(p.vy, p.vx);
            ctx.beginPath();
            ctx.moveTo(p.x - Math.cos(ang) * len, p.y - Math.sin(ang) * len);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            break;
          }
          case 'drop': {
            ctx.fillStyle = U.rgba(p.color, a);
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, p.size * 0.6, p.size * 1.25, Math.atan2(p.vy, p.vx) - Math.PI / 2, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'grain': {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = U.rgba(p.color, a);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillRect(-p.size * 0.5, -p.size * 0.5, p.size, p.size);
            ctx.restore();
            break;
          }
          /* Same square as 'grain', plus a dark outline and an additive glow
             behind it — used by the player's power-swirl, which needs to
             read clearly against any background, including the light
             sky-blue one that pale element colors alone can nearly vanish
             into. */
          case 'chip': {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = U.rgba(p.color, a * 0.55);
            ctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2);
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = U.rgba(p.color, a);
            ctx.fillRect(-p.size * 0.5, -p.size * 0.5, p.size, p.size);
            ctx.strokeStyle = 'rgba(8,10,16,' + (a * 0.7).toFixed(2) + ')';
            ctx.lineWidth = Math.max(1, p.size * 0.22);
            ctx.strokeRect(-p.size * 0.5, -p.size * 0.5, p.size, p.size);
            ctx.restore();
            break;
          }
          case 'ember': {
            const r = p.size * (0.5 + t * 0.9);
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2);
            g.addColorStop(0, U.rgba(p.color, a));
            g.addColorStop(0.5, U.rgba(p.color, a * 0.35));
            g.addColorStop(1, U.rgba(p.color, 0));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'shard': {
            ctx.fillStyle = U.rgba(p.color, a);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.beginPath();
            ctx.moveTo(0, -p.size);
            ctx.lineTo(p.size * 0.6, p.size);
            ctx.lineTo(-p.size * 0.6, p.size * 0.7);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            break;
          }
          case 'spark':
          default: {
            ctx.fillStyle = U.rgba(p.color, a);
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.5, p.size * (0.4 + t * 0.6)), 0, Math.PI * 2);
            ctx.fill();
            break;
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
  }

  PF.ParticleSystem = ParticleSystem;
})(window.PF);
