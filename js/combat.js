/* ==========================================================================
   Power Forge — combat.js
   Projectiles, hit detection, splash damage and floating damage numbers.
   Projectiles are pure data + a shape id; powers.js decides how they behave.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const MAX_PROJECTILES = 220;
  const MAX_NUMBERS = 60;


  let nextUid = 1;
  function uid() { return nextUid++; }

  class Projectile {
    constructor() { this.alive = false; }

    init(cfg) {
      this.alive = true;
      this.uid = uid();
      this.x = cfg.x; this.y = cfg.y;
      this.vx = cfg.vx; this.vy = cfg.vy;
      this.r = cfg.r || 10;
      this.damage = cfg.damage;
      this.team = cfg.team;                 // 'player' | 'enemy'
      this.owner = cfg.owner || null;
      this.colors = cfg.colors;
      this.shape = cfg.shape || 'orb';
      this.life = cfg.life || 1.2;
      this.maxLife = this.life;
      this.gravity = cfg.gravity || 0;
      this.knockback = cfg.knockback || 0;
      this.pierce = cfg.pierce || 0;
      this.splash = cfg.splash || 0;
      this.splashFactor = cfg.splashFactor == null ? 0.5 : cfg.splashFactor;
      this.trailRecipe = cfg.trail || null;
      this.impactRecipe = cfg.impact || null;
      this.hitIds = {};
      this.angle = Math.atan2(this.vy, this.vx);
      this.spin = cfg.spin || 0;
      this.rot = 0;
      this.homing = cfg.homing || 0;
      this.stopsOnWall = cfg.stopsOnWall !== false;
      this.slow = cfg.slow || 0;            // optional on-hit slow (rain mist)
      this.chain = cfg.chain || 0;
      this.chainRange = cfg.chainRange || 260;
      this.scale = cfg.scale || 1;
      this.trailBudget = cfg.trailBudget == null ? 1 : cfg.trailBudget;
      // Only basic shots count toward the accuracy readout, and only once
      // each — splash and ability projectiles are not aim tests.
      this.tracked = !!cfg.tracked;
      this.counted = false;
      return this;
    }
  }

  class Combat {
    constructor(game) {
      this.game = game;
      this.projectiles = [];
      this._pool = [];
      this.numbers = [];
      this._targets = null;   // per-frame target lists, see update()
    }

    reset() {
      for (const p of this.projectiles) { p.alive = false; this._pool.push(p); }
      this.projectiles.length = 0;
      this.numbers.length = 0;
      this._targets = null;
    }

    _obtain() {
      const p = this._pool.pop();
      return p || new Projectile();
    }

    spawn(cfg) {
      if (this.projectiles.length >= MAX_PROJECTILES) {
        // Drop the oldest rather than refusing to fire — feels better.
        const old = this.projectiles.shift();
        old.alive = false;
        this._pool.push(old);
      }
      const p = this._obtain().init(cfg);
      this.projectiles.push(p);
      return p;
    }

    /* Fire a power's basic attack from `shooter` toward (aimX, aimY). */
    fireBasic(shooter, aimX, aimY, overrides) {
      const power = shooter.power;
      const shot = Object.assign({}, power.shot, overrides || {});
      const stats = shooter.stats;
      const ox = U.cx(shooter);
      const oy = U.cy(shooter) - 2;
      let ang = Math.atan2(aimY - oy, aimX - ox);
      const count = shot.count || 1;
      const speed = (overrides && overrides.projSpeed) || stats.projSpeed;
      const dmg = (overrides && overrides.damage) || stats.damage;

      for (let i = 0; i < count; i++) {
        const offset = count === 1 ? 0 : (i - (count - 1) / 2) * (shot.spread || 0.1);
        const a = ang + offset + U.rand(-(shot.spread || 0) * 0.25, (shot.spread || 0) * 0.25) + (shooter.aimError || 0);
        const sp = speed * U.rand(0.96, 1.04);
        this.spawn({
          x: ox + Math.cos(a) * 20,
          y: oy + Math.sin(a) * 20,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          r: shot.radius * (shot.scale || 1),
          damage: dmg,
          team: shooter.team,
          owner: shooter,
          colors: power.colors,
          shape: shot.shape,
          life: shot.life,
          gravity: shot.gravity,
          knockback: shot.knockback,
          pierce: shot.pierce,
          splash: shot.splash,
          splashFactor: shot.splashFactor,
          trail: power.trail,
          impact: power.impact,
          trailBudget: count > 1 ? 0.5 : 1,
          tracked: !!shooter.isPlayer
        });
      }

      // Recoil pose. Restarts on every shot, so rapid elements stay braced.
      // fps is derived from the shooter's actual fire rate (see sprites.js)
      // so the recoil finishes before the next shot can restart it.
      PF.Sprites.triggerShoot(shooter, stats.cooldown);

      // Muzzle flash + recoil kick.
      this.game.particles.cone(
        ox + Math.cos(ang) * 20, oy + Math.sin(ang) * 20,
        ang, 0.4,
        { count: 6, speed: [60, 220], size: [2, 5], life: [0.1, 0.24], shape: power.trail.shape },
        power.colors, 1
      );
      PF.Audio.shoot(power.sfx);
    }

    /* ---- damage helpers ---------------------------------------------- */

    applyDamage(entity, amount, info) {
      if (!entity || !entity.alive) return 0;
      const dealt = entity.takeDamage(amount, info || {});
      // Mobs report EXP on death instead of chip damage, so they opt out here.
      if (dealt > 0 && entity.showDamageNumbers !== false) {
        this.addNumber(U.cx(entity), entity.y - 6, '-' + Math.round(dealt),
          info && info.crit ? [255, 220, 120] : [255, 236, 236], info && info.crit ? 26 : 20);
      }
      return dealt;
    }

    splashDamage(x, y, radius, damage, team, colors, sourceProj) {
      const list = (this._targets && this._targets[team]) || this.game.getDamageables(team);
      for (const e of list) {
        if (!e.alive) continue;
        if (sourceProj && sourceProj.hitIds[e.uid]) continue;
        const d = U.dist(x, y, U.cx(e), U.cy(e));
        if (d <= radius + Math.max(e.w, e.h) * 0.4) {
          const falloff = U.clamp(1 - d / (radius * 1.4), 0.25, 1);
          this.applyDamage(e, damage * falloff, { x: x, y: y, colors: colors, splash: true });
        }
      }
    }

    addNumber(x, y, text, color, size) {
      if (this.numbers.length >= MAX_NUMBERS) this.numbers.shift();
      this.numbers.push({
        x: x + U.rand(-8, 8), y: y,
        vx: U.rand(-22, 22), vy: -70,
        life: 0.85, maxLife: 0.85,
        text: text, color: color || [255, 255, 255], size: size || 20
      });
    }

    /* ---- update -------------------------------------------------------- */

    update(dt) {
      const game = this.game;
      const area = game.area;
      const parts = game.particles;

      // Resolve the two possible target lists once per frame instead of once
      // per projectile — with 200 projectiles in flight that matters.
      this._targets = {
        player: game.getDamageables('player'),
        enemy: game.getDamageables('enemy')
      };

      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const p = this.projectiles[i];
        p.life -= dt;
        if (p.life <= 0) { this._kill(i, false); continue; }

        // Simple homing (used by a couple of abilities).
        if (p.homing > 0) {
          const target = game.nearestEnemy(p.x, p.y, p.team, 520);
          if (target) {
            const desired = Math.atan2(U.cy(target) - p.y, U.cx(target) - p.x);
            const cur = Math.atan2(p.vy, p.vx);
            let diff = desired - cur;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            const na = cur + U.clamp(diff, -p.homing * dt, p.homing * dt);
            const sp = Math.hypot(p.vx, p.vy);
            p.vx = Math.cos(na) * sp;
            p.vy = Math.sin(na) * sp;
          }
        }

        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.angle = Math.atan2(p.vy, p.vx);
        p.rot += p.spin * dt;

        if (p.trailRecipe) parts.trail(p.x, p.y, p.trailRecipe, p.colors, dt, p.trailBudget);

        // World bounds / out of play.
        if (p.x < -120 || p.x > area.width + 120 || p.y > area.height + 400 || p.y < -900) {
          this._kill(i, false);
          continue;
        }

        // Solid geometry.
        if (p.stopsOnWall && area.hitsSolid(p.x, p.y, p.r * 0.7)) {
          this._impact(p, p.x, p.y, null);
          this._kill(i, false);
          continue;
        }

        // Entities.
        const list = this._targets[p.team] || game.getDamageables(p.team);
        let consumed = false;
        for (let k = 0; k < list.length; k++) {
          const e = list[k];
          if (!e.alive || p.hitIds[e.uid]) continue;
          if (e === p.owner) continue;
          if (e.invulnerable) continue;
          if (!U.circleRect(p.x, p.y, p.r, e)) continue;

          p.hitIds[e.uid] = true;
          const hx = U.clamp(p.x, e.x, e.x + e.w);
          const hy = U.clamp(p.y, e.y, e.y + e.h);

          const firstHit = p.tracked && !p.counted;
          if (firstHit) p.counted = true;
          this.applyDamage(e, p.damage, {
            x: hx, y: hy, colors: p.colors, knockback: p.knockback,
            dirX: Math.cos(p.angle), dirY: Math.sin(p.angle),
            source: p.owner, slow: p.slow, tracked: firstHit
          });
          this._impact(p, hx, hy, e);

          if (p.chain > 0) this._chain(p, e);

          if (p.pierce > 0) {
            p.pierce--;
            p.damage *= 0.82;
          } else {
            consumed = true;
          }
          break;
        }
        if (consumed) this._kill(i, false);
      }

      // Floating damage numbers.
      for (let i = this.numbers.length - 1; i >= 0; i--) {
        const n = this.numbers[i];
        n.life -= dt;
        if (n.life <= 0) { this.numbers.splice(i, 1); continue; }
        n.vy += 130 * dt;
        n.x += n.vx * dt;
        n.y += n.vy * dt;
      }
    }

    _chain(p, from) {
      const list = this.game.getDamageables(p.team);
      let jumps = p.chain;
      let src = from;
      const used = { };
      used[from.uid] = true;
      while (jumps > 0) {
        let best = null, bestD = p.chainRange;
        for (const e of list) {
          if (!e.alive || used[e.uid]) continue;
          const d = U.dist(U.cx(src), U.cy(src), U.cx(e), U.cy(e));
          if (d < bestD) { bestD = d; best = e; }
        }
        if (!best) break;
        used[best.uid] = true;
        this.applyDamage(best, p.damage * 0.7, { x: U.cx(best), y: U.cy(best), colors: p.colors });
        this.game.addBolt(U.cx(src), U.cy(src), U.cx(best), U.cy(best), p.colors);
        this.game.particles.burst(U.cx(best), U.cy(best), {
          count: 12, speed: [80, 300], size: [2, 5], life: [0.12, 0.3], shape: 'spark', flash: true
        }, p.colors, 1);
        src = best;
        jumps--;
      }
    }

    _impact(p, x, y, entity) {
      const parts = this.game.particles;
      if (p.impactRecipe) parts.burst(x, y, p.impactRecipe, p.colors, p.scale);
      if (p.splash > 0) {
        this.splashDamage(x, y, p.splash, p.damage * p.splashFactor, p.team, p.colors, p);
        parts.ring(x, y, p.colors.secondary, p.splash * 0.4, 0.35);
        parts.flash(x, y, p.colors.primary, p.splash * 1.1, 0.2);
        PF.Audio.explode();
      } else if (entity) {
        PF.Audio.hit();
      }
      this.game.shake(entity ? 4 : 2, 0.12);
    }

    _kill(index, silent) {
      const p = this.projectiles[index];
      p.alive = false;
      this.projectiles.splice(index, 1);
      this._pool.push(p);
    }

    /* ---- render -------------------------------------------------------- */

    render(ctx, cam) {
      ctx.save();
      for (const p of this.projectiles) {
        const c = p.colors;
        const t = p.life / p.maxLife;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.globalCompositeOperation = 'lighter';

        // Shared soft glow.
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, p.r * 2.6);
        gr.addColorStop(0, U.rgba(c.secondary, 0.55));
        gr.addColorStop(0.4, U.rgba(c.primary, 0.35));
        gr.addColorStop(1, U.rgba(c.primary, 0));
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 2.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.rotate(p.angle);
        switch (p.shape) {
          case 'slash': {
            ctx.fillStyle = U.rgba(c.secondary, 0.95);
            ctx.beginPath();
            ctx.ellipse(0, 0, p.r * 2.1, p.r * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = U.rgba(c.primary, 0.8);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(-p.r * 0.8, 0, p.r * 1.5, -0.9, 0.9);
            ctx.stroke();
            break;
          }
          case 'bolt': {
            ctx.strokeStyle = U.rgba(c.secondary, 0.95);
            ctx.lineWidth = 3.5;
            ctx.lineCap = 'round';
            U.boltPath(ctx, -p.r * 2.6, 0, p.r * 1.6, 0, 5, p.r * 0.9, (p.uid * 37) % 9973 + 1);
            ctx.stroke();
            ctx.strokeStyle = U.rgba(c.primary, 0.6);
            ctx.lineWidth = 7;
            ctx.stroke();
            break;
          }
          case 'droplet': {
            ctx.fillStyle = U.rgba(c.secondary, 0.95);
            ctx.beginPath();
            ctx.moveTo(p.r * 1.5, 0);
            ctx.quadraticCurveTo(-p.r * 0.4, p.r * 0.85, -p.r * 1.4, 0);
            ctx.quadraticCurveTo(-p.r * 0.4, -p.r * 0.85, p.r * 1.5, 0);
            ctx.fill();
            break;
          }
          case 'fireball': {
            const pulse = 1 + Math.sin(p.life * 34) * 0.08;
            ctx.fillStyle = U.rgba(c.primary, 0.9);
            ctx.beginPath();
            ctx.arc(0, 0, p.r * pulse, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = U.rgba(c.secondary, 0.95);
            ctx.beginPath();
            ctx.arc(p.r * 0.15, 0, p.r * 0.55 * pulse, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'boulder': {
            ctx.globalCompositeOperation = 'source-over';
            ctx.rotate(p.rot);
            ctx.fillStyle = U.rgb(c.primary);
            U.starPath(ctx, 0, 0, 7, p.r, p.r * 0.78, p.rot);
            ctx.fill();
            ctx.strokeStyle = U.rgba(c.dark, 0.9);
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = U.rgba(c.secondary, 0.55);
            ctx.beginPath();
            ctx.arc(-p.r * 0.25, -p.r * 0.25, p.r * 0.3, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'wave': {
            ctx.fillStyle = U.rgba(c.primary, 0.55);
            ctx.beginPath();
            ctx.ellipse(0, 0, p.r * 1.2, p.r * 1.9, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = U.rgba(c.secondary, 0.75);
            ctx.beginPath();
            ctx.ellipse(p.r * 0.3, 0, p.r * 0.55, p.r * 1.3, 0, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'meteor': {
            ctx.fillStyle = U.rgba(c.primary, 0.92);
            ctx.beginPath();
            ctx.arc(0, 0, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = U.rgba(c.secondary, 0.9);
            U.starPath(ctx, 0, 0, 6, p.r * 0.85, p.r * 0.4, p.rot);
            ctx.fill();
            break;
          }
          case 'orb':
          default: {
            ctx.fillStyle = U.rgba(c.primary, 0.9);
            ctx.beginPath();
            ctx.ellipse(0, 0, p.r * 1.25, p.r * 0.9, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = U.rgba(c.secondary, 0.9);
            ctx.beginPath();
            ctx.arc(p.r * 0.2, -p.r * 0.15, p.r * 0.42, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
        }
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }

    renderNumbers(ctx) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const n of this.numbers) {
        const t = n.life / n.maxLife;
        const a = t > 0.7 ? 1 : t / 0.7;
        const size = n.size * (1 + (1 - t) * 0.12);
        ctx.font = '700 ' + size.toFixed(1) + 'px "PowerForge", "Trebuchet MS", "Segoe UI", sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(6,8,14,' + (a * 0.85) + ')';
        ctx.strokeText(n.text, n.x, n.y);
        ctx.fillStyle = U.rgba(n.color, a);
        ctx.fillText(n.text, n.x, n.y);
      }
      ctx.restore();
    }
  }

  PF.Combat = Combat;
  PF.newUid = uid;
})(window.PF);
