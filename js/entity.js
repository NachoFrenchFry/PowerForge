/* ==========================================================================
   Power Forge — entity.js
   Shared base for the player: stats, damage, status effects, movement
   physics and the character rendering.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const Levels = PF.Levels;

  /* How many native (pre-SCALE) pixel rows of transparent padding sit above
     the player's own drawn art within its 128x128 sprite frame — measured
     from the source sheets (idle 48, walk 46, run 47, shoot 48, jump 39,
     fall 40 — the raised-arm jump pose reaches highest). Deliberately a
     little short of the absolute safe minimum (39): that placed the bar
     comfortably above even a raised arm, but far enough off the head during
     ordinary standing/walking to look disconnected from the character. 44
     sits close above the normal poses and only grazes the very tip of a
     raised arm during the brief jump/attack poses — a much smaller cost. */
  const PLAYER_HEADROOM = 44;

  let uidCounter = 1000;

  class Entity {
    constructor(game, powerId, level, team) {
      this.game = game;
      this.uid = uidCounter++;
      this.team = team;                 // 'player' | 'enemy'
      this.power = PF.Powers.get(powerId);
      this.level = Levels.clampLevel(level);
      this.stats = Levels.statsFor(this.power, this.level);

      this.w = 34; this.h = 52;
      this.x = 0; this.y = 0;
      this.vx = 0; this.vy = 0;
      this.onGround = false;
      this.hitWall = false;
      this.facing = 1;          // aim-facing, used by gameplay (wall side etc)
      this.spriteFacing = 1;    // art-facing, follows movement while moving
      this.running = false;
      this.anim = { name: 'idle', frame: 0, dist: 0, time: 0, done: false };
      this.animTop = null;      // torso overlay for split poses

      this.alive = true;
      this.maxHp = this.stats.maxHp;
      this.hp = this.maxHp;

      // The health bar's trailing "damage taken" indicator — see
      // updateStatus and healthbar.js's renderPlayer. Sits at hp normally;
      // a hit leaves it behind at the pre-hit value, holds there briefly,
      // then eases back down to match hp, so a hit reads as a chunk of red
      // draining away rather than the bar just silently being shorter.
      this.trailHp = this.hp;
      this.trailHoldTimer = 0;

      this.attackCooldown = 0;
      this.shootTimer = 0;   // how long the recoil pose stays up
      this.cooldowns = Object.create(null);

      this.shield = null;               // { amount, max, time }
      this.aura = null;                 // { time, radius, dps, ... }
      this.regen = null;                // { rate, time }
      this.dash = null;                 // { timer, vx, vy, damage, radius }
      this.invulnTime = 0;
      this.stunTime = 0;
      this.slowTime = 0;
      this.slowFactor = 1;
      this.hurtFlash = 0;
      this.knockFacingLock = 0;         // see takeDamage / _updateSpriteState
      /* Timed stat buffs from abilities. Each entry is
         { id, time, move, fire, taken, dealt } — multipliers, all optional.
         Casting the same ability again refreshes its entry rather than
         stacking a second copy. */
      this.buffs = [];
      this.burrowTime = 0;
      this.flying = false;

      this.walkPhase = 0;
      this.spawnTime = 0;
      this.aimError = 0;
      this.isPlayer = false;
    }

    /* ---- stats --------------------------------------------------------- */

    recomputeStats(preserveRatio) {
      const ratio = preserveRatio ? U.clamp(this.hp / this.maxHp, 0, 1) : 1;
      this.stats = Levels.statsFor(this.power, this.level);
      this.maxHp = this.stats.maxHp;
      this.hp = Math.max(1, Math.round(this.maxHp * ratio));
    }

    healFull() {
      this.hp = this.maxHp;
      this.shield = null;
      this.regen = null;
    }

    /* ---- damage -------------------------------------------------------- */

    takeDamage(amount, info) {
      if (!this.alive || this.invulnTime > 0) return 0;
      let dmg = Math.max(1, amount) * this.buffTaken();

      if (this.shield && this.shield.amount > 0) {
        const absorbed = Math.min(this.shield.amount, dmg);
        this.shield.amount -= absorbed;
        dmg -= absorbed;
        this.game.particles.burst(U.cx(this), U.cy(this), {
          count: 6, speed: [60, 200], size: [2, 5], life: [0.15, 0.3], shape: 'drop', ring: false
        }, this.power.colors, 0.8);
        if (this.shield.amount <= 0) {
          this.shield = null;
          this.game.particles.ring(U.cx(this), U.cy(this), this.power.colors.secondary, 20, 0.35);
        }
        if (dmg <= 0) return absorbed;
      }

      this.hp -= dmg;
      this.hurtFlash = 0.22;
      this.trailHoldTimer = 0.15;   // pause here before the trail starts draining

      if (info && info.knockback) {
        const kb = info.knockback * (90 / Math.max(60, this.maxHp * 0.75));
        this.vx += (info.dirX || 0) * kb;
        this.vy += (info.dirY || 0) * kb * 0.55 - kb * 0.12;
        this.vx = U.clamp(this.vx, -900, 900);
        this.vy = U.clamp(this.vy, -700, 700);
        // The shove itself shouldn't spin the sprite around — without this,
        // getting knocked backward while facing a mob flips spriteFacing to
        // match the knockback's direction of travel (see
        // _updateSpriteState), so the character visibly turns its back on
        // whatever just hit it for a moment.
        this.knockFacingLock = 0.3;
      }
      if (info && info.slow) {
        this.slowTime = Math.max(this.slowTime, 1.4);
        this.slowFactor = Math.min(this.slowFactor, 1 - info.slow);
      }

      const c = (info && info.colors) || this.power.colors;
      this.game.particles.burst(
        (info && info.x) || U.cx(this), (info && info.y) || U.cy(this),
        { count: 8, speed: [60, 240], size: [2, 5], life: [0.15, 0.35], shape: 'spark' }, c, 0.9
      );

      if (this.hp <= 0) {
        this.hp = 0;
        this.die(info);
      } else if (this.isPlayer) {
        PF.Audio.hurt();
      }
      return amount;
    }

    heal(amount) {
      if (!this.alive) return 0;
      const before = this.hp;
      this.hp = Math.min(this.maxHp, this.hp + amount);
      return this.hp - before;
    }

    die(info) {
      this.alive = false;
      const c = this.power.colors;
      this.game.particles.burst(U.cx(this), U.cy(this), {
        count: 46, speed: [120, 520], size: [3, 9], life: [0.35, 0.9],
        shape: this.power.impact.shape, gravity: 260, ring: true, flash: true
      }, c, 1.6);
      this.game.shake(14, 0.35);
      PF.Audio.explode();
      if (this.onDeath) this.onDeath(info);
    }

    /* ---- per-frame ------------------------------------------------------ */

    /* ---- timed buffs ---- */

    addBuff(buff) {
      const existing = this.buffs.filter((b) => b.id === buff.id)[0];
      if (existing) Object.assign(existing, buff);
      else this.buffs.push(buff);
      return buff;
    }

    _buffProduct(key) {
      let m = 1;
      for (const b of this.buffs) if (b[key]) m *= b[key];
      return m;
    }

    buffMove() { return this._buffProduct('move'); }
    buffFire() { return this._buffProduct('fire'); }
    buffTaken() { return this._buffProduct('taken'); }
    buffDealt() { return this._buffProduct('dealt'); }

    updateStatus(dt) {
      this.spawnTime += dt;
      if (this.invulnTime > 0) this.invulnTime -= dt;
      if (this.stunTime > 0) this.stunTime -= dt;
      if (this.hurtFlash > 0) this.hurtFlash -= dt;
      if (this.burrowTime > 0) this.burrowTime -= dt;

      // Healing (or simply not having lost anything) has nothing to show
      // off, so it snaps immediately — only a drop in HP gets the delayed
      // drain, and only once takeDamage's hold window has run out.
      if (this.trailHp > this.hp) {
        if (this.trailHoldTimer > 0) {
          this.trailHoldTimer -= dt;
        } else {
          const drainPerSecond = this.maxHp * 1.1;
          this.trailHp = Math.max(this.hp, this.trailHp - drainPerSecond * dt);
        }
      } else {
        this.trailHp = this.hp;
        this.trailHoldTimer = 0;
      }

      for (let i = this.buffs.length - 1; i >= 0; i--) {
        this.buffs[i].time -= dt;
        if (this.buffs[i].time <= 0) this.buffs.splice(i, 1);
      }

      if (this.attackCooldown > 0) this.attackCooldown -= dt;
      if (this.shootTimer > 0) this.shootTimer -= dt;

      for (const k in this.cooldowns) {
        if (this.cooldowns[k] > 0) {
          this.cooldowns[k] -= dt;
          if (this.cooldowns[k] < 0) this.cooldowns[k] = 0;
        }
      }

      if (this.slowTime > 0) {
        this.slowTime -= dt;
        if (this.slowTime <= 0) this.slowFactor = 1;
      }

      if (this.shield) {
        this.shield.time -= dt;
        if (this.shield.time <= 0) this.shield = null;
      }

      if (this.regen) {
        const amt = this.regen.rate * dt;
        const healed = this.heal(amt);
        this.regen.acc = (this.regen.acc || 0) + healed;
        if (this.regen.acc >= 12) {
          this.game.combat.addNumber(U.cx(this), this.y - 4, '+' + Math.round(this.regen.acc), [120, 255, 170], 18);
          this.regen.acc = 0;
        }
        if (Math.random() < dt * 26) {
          this.game.particles.spawn({
            x: U.cx(this) + U.rand(-16, 16), y: this.y + this.h - U.rand(0, 10),
            vx: U.rand(-14, 14), vy: U.rand(-90, -40),
            size: U.rand(2, 4), life: U.rand(0.3, 0.6),
            color: [140, 255, 190], shape: 'drop'
          });
        }
        this.regen.time -= dt;
        if (this.regen.time <= 0) this.regen = null;
      }

      if (this.aura) this._updateAura(dt);
      if (this.dash) this._updateDash(dt);
    }

    _updateAura(dt) {
      const a = this.aura;
      a.time -= dt;
      a.timer -= dt;
      const cx = U.cx(this), cy = U.cy(this);

      if (a.timer <= 0) {
        a.timer = a.tick;
        const list = this.game.getDamageables(this.team);
        for (const e of list) {
          if (!e.alive) continue;
          const d = U.dist(cx, cy, U.cx(e), U.cy(e));
          if (d > a.radius) continue;
          const ang = Math.atan2(U.cy(e) - cy, U.cx(e) - cx);
          this.game.combat.applyDamage(e, a.dps * a.tick, {
            x: U.cx(e), y: U.cy(e), colors: a.colors,
            knockback: a.knockback, dirX: Math.cos(ang), dirY: Math.sin(ang),
            slow: a.slow, source: this
          });
        }
      }

      // Swirling visual.
      const n = 3;
      for (let i = 0; i < n; i++) {
        if (Math.random() > dt * 30) continue;
        const ang = Math.random() * Math.PI * 2;
        const r = a.radius * U.rand(0.5, 1);
        this.game.particles.spawn({
          x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r * 0.8,
          vx: -Math.sin(ang) * 220, vy: Math.cos(ang) * 130 - 40,
          size: U.rand(2, 6), life: U.rand(0.2, 0.45),
          color: Math.random() < 0.5 ? a.colors.secondary : a.colors.primary,
          shape: a.shape, drag: 1.5
        });
      }

      if (a.time <= 0) this.aura = null;
    }

    _updateDash(dt) {
      const d = this.dash;
      d.timer -= dt;
      this.vx = d.vx;
      this.vy = d.vy;

      if (d.damage > 0) {
        const list = this.game.getDamageables(this.team);
        for (const e of list) {
          if (!e.alive || d.hitIds[e.uid]) continue;
          if (U.dist(U.cx(this), U.cy(this), U.cx(e), U.cy(e)) < d.radius + e.w * 0.4) {
            d.hitIds[e.uid] = true;
            const ang = Math.atan2(d.vy, d.vx);
            this.game.combat.applyDamage(e, d.damage, {
              x: U.cx(e), y: U.cy(e), colors: d.colors, knockback: 260,
              dirX: Math.cos(ang), dirY: Math.sin(ang), source: this
            });
          }
        }
      }

      this.game.particles.spawn({
        x: U.cx(this) + U.rand(-8, 8), y: U.cy(this) + U.rand(-14, 14),
        vx: -d.vx * 0.12, vy: -d.vy * 0.12,
        size: U.rand(3, 7), life: U.rand(0.15, 0.32),
        color: d.colors.secondary, shape: this.power.trail.shape, drag: 3
      });

      if (d.timer <= 0) {
        this.vx *= 0.35;
        this.vy *= 0.3;
        this.dash = null;
      }
    }

    /* Standard gravity + platform movement. `flying` bypasses gravity. */
    applyPhysics(dt, area) {
      if (this.dash) {
        // Dash controls velocity directly, but still collides.
        PF.Physics.step(this, area, dt);
      } else {
        if (!this.flying) {
          this.vy += PF.Physics.GRAVITY * dt;
          if (this.vy > PF.Physics.MAX_FALL) this.vy = PF.Physics.MAX_FALL;
        }
        PF.Physics.step(this, area, dt);
        if (this.onGround) this.walkPhase += Math.abs(this.vx) * dt * 0.035;
        else this.walkPhase += dt * 3;
      }
      this._updateSpriteState(dt);
    }

    /* The art faces the way you last travelled and STAYS there when you stop.
       Snapping back to the cursor on release made the character spin round
       for no reason the moment you let go of a key. */
    _updateSpriteState(dt) {
      if (this.knockFacingLock > 0) {
        this.knockFacingLock -= dt;
      } else if (Math.abs(this.vx) > 30) {
        this.spriteFacing = this.vx > 0 ? 1 : -1;
      }
      PF.Sprites.advance(this, dt);
    }

    /* ---- rendering ------------------------------------------------------ */

    render(ctx) {
      const c = this.power.colors;
      const cx = U.cx(this);
      const cy = U.cy(this);
      const t = this.game.time;

      ctx.save();

      // Ground shadow.
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(cx, this.y + this.h + 3, this.w * 0.45, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Power aura.
      ctx.globalCompositeOperation = 'lighter';
      const auraPulse = 0.55 + Math.sin(t * 3 + this.uid) * 0.12 + (this.flying ? 0.35 : 0);
      const ag = ctx.createRadialGradient(cx, cy, 4, cx, cy, this.w * 1.7);
      ag.addColorStop(0, U.rgba(c.aura, 0.30 * auraPulse));
      ag.addColorStop(1, U.rgba(c.aura, 0));
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(cx, cy, this.w * 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      // Invulnerability / hurt tint.
      const flash = this.hurtFlash > 0 ? U.clamp(this.hurtFlash / 0.22, 0, 1) : 0;
      if (this.invulnTime > 0 && !this.dash) ctx.globalAlpha = 0.55 + Math.sin(t * 40) * 0.25;
      // Burrowed: mostly under the surface, just a shadow of a silhouette.
      if (this.burrowTime > 0) ctx.globalAlpha = 0.22;

      const bob = this.flying ? Math.sin(t * 4 + this.uid) * 3 : 0;
      ctx.translate(0, bob);

      /* Hand-drawn sprite when the art has loaded; the built-in vector
         character otherwise, so a missing texture never blanks the player. */
      if (PF.Sprites.draw(ctx, this)) {
        ctx.restore();
        this._renderAimGlow(ctx, bob);
        this._renderStatusOverlays(ctx, cx, cy, t);
        return;
      }

      // Legs.
      const swing = this.onGround && Math.abs(this.vx) > 20 ? Math.sin(this.walkPhase * 6) * 7 : 0;
      const legY = this.y + this.h - 16;
      ctx.fillStyle = '#1b2130';
      ctx.fillRect(cx - 11 + swing * 0.4, legY, 9, 17);
      ctx.fillRect(cx + 2 - swing * 0.4, legY, 9, 17);
      ctx.fillStyle = U.rgba(c.dark, 1);
      ctx.fillRect(cx - 11 + swing * 0.4, legY + 13, 9, 4);
      ctx.fillRect(cx + 2 - swing * 0.4, legY + 13, 9, 4);

      // Torso.
      const bodyX = cx - 13, bodyY = this.y + 12, bw = 26, bh = 26;
      const grad = ctx.createLinearGradient(bodyX, bodyY, bodyX, bodyY + bh);
      grad.addColorStop(0, '#39415c');
      grad.addColorStop(1, '#232a3d');
      ctx.fillStyle = grad;
      U.roundRect(ctx, bodyX, bodyY, bw, bh, 7);
      ctx.fill();
      ctx.strokeStyle = U.rgba(c.primary, 0.85);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Chest core.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const corePulse = 0.7 + Math.sin(t * 5 + this.uid) * 0.3;
      ctx.fillStyle = U.rgba(c.secondary, 0.9 * corePulse);
      ctx.beginPath();
      ctx.arc(cx, bodyY + 12, 5.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = U.rgba(c.primary, 0.5 * corePulse);
      ctx.beginPath();
      ctx.arc(cx, bodyY + 12, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Head.
      const headY = this.y + 6;
      ctx.fillStyle = '#414a68';
      ctx.beginPath();
      ctx.arc(cx, headY, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = U.rgba(c.primary, 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();
      // Visor faces the aim direction.
      const fx = Math.cos(this.aimAngle) >= 0 ? 1 : -1;
      ctx.fillStyle = U.rgba(c.secondary, 0.95);
      U.roundRect(ctx, cx - 2 + fx * 2, headY - 3.5, 8, 5.5, 2.5);
      ctx.fill();

      // Aiming arm.
      const ax = cx + Math.cos(this.aimAngle) * 6;
      const ay = bodyY + 11 + Math.sin(this.aimAngle) * 6;
      ctx.strokeStyle = '#4b5474';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, bodyY + 11);
      ctx.lineTo(ax + Math.cos(this.aimAngle) * 13, ay + Math.sin(this.aimAngle) * 13);
      ctx.stroke();
      // Emitter on the hand.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const hx = ax + Math.cos(this.aimAngle) * 17;
      const hy = ay + Math.sin(this.aimAngle) * 17;
      const charge = this.attackCooldown > 0 ? 0.4 : 1;
      ctx.fillStyle = U.rgba(c.secondary, 0.85 * charge);
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = U.rgba(c.primary, 0.4 * charge);
      ctx.beginPath();
      ctx.arc(hx, hy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Hurt overlay.
      if (flash > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,90,90,' + (flash * 0.5) + ')';
        U.roundRect(ctx, this.x - 2, this.y - 2, this.w + 4, this.h + 4, 8);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.restore();
      this._renderStatusOverlays(ctx, cx, cy, t);
    }

    /* A small emitter glow on the aiming side. With the sprite in play this is
       the only cue for where shots will come from, and it doubles as the
       attack-ready indicator. */
    _renderAimGlow(ctx, bob) {
      const c = this.power.colors;
      // Sits out past the shoulder and stays small — the character is only
      // ~32px wide, so anything bigger swallows the face.
      const hx = U.cx(this) + Math.cos(this.aimAngle) * 26;
      const hy = U.cy(this) + Math.sin(this.aimAngle) * 26 + 4 + (bob || 0);
      const charge = this.attackCooldown > 0 ? 0.3 : 1;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = U.rgba(c.secondary, 0.7 * charge);
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 7);
      g.addColorStop(0, U.rgba(c.primary, 0.4 * charge));
      g.addColorStop(1, U.rgba(c.primary, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderStatusOverlays(ctx, cx, cy, t) {
      const c = this.power.colors;

      // Shield bubble.
      if (this.shield) {
        const s = this.shield;
        const a = U.clamp(s.amount / s.max, 0.15, 1);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = U.rgba(c.secondary, 0.35 + a * 0.4);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(cx, cy, this.w * 0.95, this.h * 0.78, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = U.rgba(c.primary, 0.10 + a * 0.10);
        ctx.fill();
        ctx.restore();
      }

      // Aura ring.
      if (this.aura) {
        const a = this.aura;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = U.rgba(a.colors.secondary, 0.25 + Math.sin(t * 8) * 0.1);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(cx, cy, a.radius, a.radius * 0.82, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // World-space health bar (heart to its left) — the HUD no longer
      // shows the player's HP (see index.html/ui.js), so this is the only
      // place it's visible now. Anchored off the sprite's actual visual
      // top (same footY/anchorY math PF.Sprites itself draws with), not the
      // hitbox — the hitbox is much smaller than the 128px sprite frame and
      // sits well below where the character is actually drawn, which is
      // what put the bar on top of the player before.
      if (this.isPlayer) {
        const F = PF.Sprites.FRAME, SCALE = PF.Sprites.SCALE;
        const footY = Math.round(this.y + this.h);
        const visualTopY = footY - F.anchorY * SCALE + PLAYER_HEADROOM * SCALE;
        PF.HealthBar.renderPlayer(ctx, this, U.clamp(this.hp / this.maxHp, 0, 1), visualTopY - 4);
      }
    }
  }

  PF.Entity = Entity;
})(window.PF);
