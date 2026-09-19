/* ==========================================================================
   Power Forge — player.js
   The player character: input-driven movement, flight, attacking, and the
   EXP / level progression that everything else feeds into.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const Levels = PF.Levels;

  const COYOTE_TIME = 0.10;   // grace period to jump after leaving a ledge
  const JUMP_BUFFER = 0.12;   // grace period for pressing jump before landing
  const RUN_MULTIPLIER = 1.55; // hold Shift while moving

  class Player extends PF.Entity {
    constructor(game, powerId) {
      super(game, powerId, 1, 'player');
      this.isPlayer = true;
      this.name = 'YOU';

      this.exp = 0;
      this.expToNext = Levels.expToNext(1);
      this.abilities = PF.Abilities.forPower(powerId);

      this.coyote = 0;
      this.jumpBuffer = 0;
      this.flying = false;
      this.flyParticleTimer = 0;

      this.totalExpEarned = 0;
      this.deaths = 0;

      this.controlLock = 0;   // brief lockout after respawn

      this.meatCount = 0;     // the one inventory slot — see eatMeat()

      // Meat shop (js/shop.js) — permanent upgrades bought for the rest of
      // the run. shopUpgrades tracks which ones are owned (so the menu can
      // show OWNED instead of a Buy button and buyShopItem won't sell the
      // same one twice); permRegenRate is separate from Entity's `regen`
      // (a temporary { rate, time } buff abilities like Healing Spring use)
      // specifically so casting one of those can't clobber or expire a
      // purchase that's supposed to last forever.
      this.shopUpgrades = Object.create(null);
      this.permRegenRate = 0;
      this._permRegenAcc = 0;
    }

    /* ---- shop ------------------------------------------------------------ */

    buyShopItem(item) {
      if (this.shopUpgrades[item.id] || this.meatCount < item.cost) return false;
      this.meatCount -= item.cost;
      this.shopUpgrades[item.id] = true;
      item.apply(this);
      return true;
    }

    /* ---- progression ---------------------------------------------------- */

    get canFly() {
      const fly = this.getAbility('flight');
      return !!fly && this.level >= fly.unlockLevel;
    }

    getAbility(id) {
      for (const a of this.abilities) if (a.id === id) return a;
      return null;
    }

    unlockedAbilities() {
      return this.abilities.filter((a) => this.level >= a.unlockLevel);
    }

    lockedAbilities() {
      return this.abilities.filter((a) => this.level < a.unlockLevel);
    }

    addExp(amount, silent) {
      if (amount <= 0 || this.level >= Levels.MAX_LEVEL) return;
      this.exp += amount;
      this.totalExpEarned += amount;

      while (this.level < Levels.MAX_LEVEL && this.exp >= this.expToNext) {
        this.exp -= this.expToNext;
        this._levelUp();
      }
      if (this.level >= Levels.MAX_LEVEL) {
        this.exp = 0;
        this.expToNext = Infinity;
      }
    }

    _levelUp() {
      const before = this.maxHp;
      this.level++;
      this.expToNext = Levels.expToNext(this.level);

      this.stats = Levels.statsFor(this.power, this.level);
      this.maxHp = this.stats.maxHp;
      this.hp = Math.min(this.maxHp, this.hp + (this.maxHp - before) + Math.round(this.maxHp * 0.25));

      const newAbility = this.abilities.filter((a) => a.unlockLevel === this.level)[0] || null;
      this.game.onLevelUp(this.level, newAbility);
    }

    /* ---- inventory --------------------------------------------------------
       One slot, one item kind: meat, dropped by peaceful mobs (see mobs.js's
       _die) and picked up by touch (js/items.js). Eating it is a flat 20%
       of max HP rather than a fixed number, same reasoning as every other
       heal in this game (Healing Water, Healing Spring, the level-up
       bonus above) — a flat number either does nothing at high level or
       trivialises early fights. */
    eatMeat() {
      if (this.meatCount <= 0 || !this.alive) return false;
      this.meatCount--;
      const healed = this.heal(Math.round(this.maxHp * 0.2));
      if (healed > 0) {
        // Round for display — hp can carry tiny float drift from the
        // per-frame regen tick (this.hp += rate*dt many times over), so
        // `healed` (hp after minus hp before) isn't always a clean integer
        // even though the amount asked for was, e.g. "+11.499999999999998".
        this.game.combat.addNumber(U.cx(this), this.y - 4, '+' + Math.round(healed), [120, 255, 170], 18);
      }
      PF.Audio.eat();
      this.game.particles.burst(U.cx(this), U.cy(this), {
        count: 14, speed: [30, 110], size: [2, 5], life: [0.25, 0.5],
        shape: 'spark', gravity: -40
      }, { primary: [120, 255, 170], secondary: [220, 255, 230] }, 0.7);
      return true;
    }

    /* ---- lifecycle ------------------------------------------------------ */

    spawnAt(x, y) {
      this.x = x - this.w / 2;
      this.y = y - this.h;
      this.vx = 0; this.vy = 0;
      this.alive = true;
      this.dash = null;
      this.invulnTime = 0.6;
      this.controlLock = 0.15;
    }

    onDeath() {
      this.deaths++;
      this.game.respawnPlayer();
    }

    /* Falling out of the world hurts but never kills outright. */
    _checkOutOfBounds() {
      const area = this.game.area;
      if (this.y > area.height + 320) {
        this.game.ui.toast('OUCH', 'You fell into the pit');
        this.spawnAt(area.spawn.x, area.spawn.y);
        this.hp = Math.max(1, this.hp - Math.round(this.maxHp * 0.15));
        this.game.shake(10, 0.3);
      }
    }

    /* Permanent power-colored particles swirling around the player, always
       on regardless of ability state — two diagonal bands crossing the torso
       like a pair of bandolier straps (one shoulder to the opposite hip,
       mirrored), rather than one flat horizontal loop.

       Each particle's position is placed directly from an angle swept along
       its band (not given an initial position + left-to-drift velocity like
       a normal burst): `along` is where it sits lengthwise on the strap,
       `depth` is how far through the "wrap" it is. depth's sign decides
       which side of the player it's on: negative depth spawns tagged
       behindPlayer (drawn in the pass BEFORE the sprite, in game.js), positive
       depth draws after — so one half of each strap visibly passes behind
       the body and the other in front, faking a 3D loop around the torso
       with flat 2D particles. */
    _updatePowerAura(dt) {
      const c = this.power.colors;
      const cx = U.cx(this), cy = U.cy(this);
      const reach = this.h * 0.5;         // how far along the strap particles spread — hugs the body
      const thickness = this.w * 0.28;    // perpendicular "wrap" depth of the strap — hugs the body
      const RATE = 260;                   // particles/sec, combined across both straps — cut to a third

      // Two mirrored diagonals so the pair crosses in an X over the chest.
      const BANDS = [
        { dx: 0.707, dy: 0.707 },
        { dx: 0.707, dy: -0.707 }
      ];

      this._auraAcc = (this._auraAcc || 0) + dt * RATE;
      let n = Math.floor(this._auraAcc);
      if (Math.random() < this._auraAcc - n) n++;
      this._auraAcc -= n;
      if (n > 70) n = 70;   // guard against a huge catch-up burst after a stall

      for (let i = 0; i < n; i++) {
        const band = BANDS[i & 1];
        const theta = Math.random() * Math.PI * 2;
        const along = Math.sin(theta) * reach;
        const depth = Math.cos(theta);
        const perpX = -band.dy, perpY = band.dx;
        const x = cx + band.dx * along + perpX * depth * thickness;
        const y = cy + band.dy * along + perpY * depth * thickness;

        this.game.particles.spawn({
          x: x, y: y,
          vx: band.dx * depth * 14, vy: band.dy * depth * 14 - 8,
          size: U.rand(4, 7), life: U.rand(0.28, 0.5),
          color: Math.random() < 0.5 ? c.secondary : c.primary,
          shape: 'chip', drag: 2.2,
          behindPlayer: depth < 0
        });
      }
    }

    /* ---- per-frame ------------------------------------------------------ */

    update(dt, input) {
      if (!this.alive) return;
      const game = this.game;

      this.updateStatus(dt);
      this._updatePowerAura(dt);
      if (this.controlLock > 0) this.controlLock -= dt;

      // Shop-bought regen — always on, unlike Entity's timed `regen`, so it
      // gets its own tiny accumulator/number-popup instead of hooking into
      // that one (see the constructor note on permRegenRate).
      if (this.permRegenRate > 0) {
        const healed = this.heal(this.permRegenRate * dt);
        this._permRegenAcc += healed;
        if (this._permRegenAcc >= 12) {
          game.combat.addNumber(U.cx(this), this.y - 4, '+' + Math.round(this._permRegenAcc), [120, 255, 170], 16);
          this._permRegenAcc = 0;
        }
      }

      // Aim always tracks the cursor in world space.
      const mx = input.mouse.x + game.camera.x;
      const my = input.mouse.y + game.camera.y;
      this.aimAngle = Math.atan2(my - U.cy(this), mx - U.cx(this));
      this.facing = Math.cos(this.aimAngle) >= 0 ? 1 : -1;

      const canAct = this.controlLock <= 0 && this.stunTime <= 0 && game.acceptsGameInput();
      const canFight = canAct;

      /* ---- flight toggle (double-tap W) ---- */
      if (canAct && input.consumeDoubleTapUp()) {
        if (this.canFly) {
          this.flying = !this.flying;
          PF.Audio.fly();
          game.particles.burst(U.cx(this), U.cy(this), {
            count: 24, speed: [90, 320], size: [3, 7], life: [0.25, 0.55],
            shape: this.power.trail.shape, ring: true
          }, this.power.colors, 1.2);
          if (!this.flying) this.vy = Math.min(this.vy, 0);
        } else {
          // Powers without Flight simply double-jump-tap harmlessly; only
          // nag the ones that will eventually earn it.
          const fly = this.getAbility('flight');
          if (fly) game.ui.toast('FLIGHT LOCKED', 'Unlocks at level ' + fly.unlockLevel);
        }
      }

      /* ---- movement ---- */
      let ix = 0;
      if (canAct) {
        if (input.left()) ix -= 1;
        if (input.right()) ix += 1;
      }
      this.running = canAct && ix !== 0 &&
        (input.down('ShiftLeft') || input.down('ShiftRight'));
      const speed = this.stats.moveSpeed * this.slowFactor * this.buffMove() *
        (this.running ? RUN_MULTIPLIER : 1);

      if (!this.dash) {
        if (this.flying) {
          const fs = this.stats.flySpeed * this.slowFactor * (this.running ? RUN_MULTIPLIER : 1);
          const targetVX = ix * fs * 1.15;
          this.vx = U.damp(this.vx, targetVX, 9, dt);
          let iy = 0;
          if (canAct) {
            if (input.up()) iy -= 1;
            if (input.downKey()) iy += 1;
          }
          const targetVY = iy * fs;
          this.vy = U.damp(this.vy, targetVY + Math.sin(game.time * 2.2) * 14, 8, dt);

          this.flyParticleTimer -= dt;
          if (this.flyParticleTimer <= 0) {
            this.flyParticleTimer = 0.03;
            game.particles.spawn({
              x: U.cx(this) + U.rand(-10, 10), y: this.y + this.h - 4,
              vx: U.rand(-30, 30) - this.vx * 0.15, vy: U.rand(20, 90),
              size: U.rand(2, 5), life: U.rand(0.2, 0.45),
              color: Math.random() < 0.5 ? this.power.colors.secondary : this.power.colors.primary,
              shape: this.power.trail.shape, drag: 2
            });
          }
        } else {
          const accel = this.onGround ? 14 : 8;
          this.vx = U.damp(this.vx, ix * speed, accel, dt);
          if (Math.abs(this.vx) < 4 && ix === 0) this.vx = 0;

          /* ---- jump with coyote time + input buffering ---- */
          if (this.onGround) this.coyote = COYOTE_TIME;
          else if (this.coyote > 0) this.coyote -= dt;

          if (canAct && input.jumpPressed()) this.jumpBuffer = JUMP_BUFFER;
          else if (this.jumpBuffer > 0) this.jumpBuffer -= dt;

          /* Fixed-height jump — every jump reaches the same apex whether you
             tap W or hold it. Coyote time and input buffering stay, since
             those only forgive timing, they don't change the arc. */
          if (this.jumpBuffer > 0 && this.coyote > 0) {
            this.vy = -this.stats.jumpForce;
            this.onGround = false;
            this.coyote = 0;
            this.jumpBuffer = 0;
            PF.Audio.land();
            game.particles.burst(U.cx(this), this.y + this.h, {
              count: 8, speed: [40, 150], size: [2, 5], life: [0.15, 0.35],
              shape: this.power.trail.shape, gravity: 200
            }, this.power.colors, 0.8);
          }
        }
      }

      /* ---- attack ---- */
      if (canFight && input.mouse.down && this.attackCooldown <= 0) {
        game.combat.fireBasic(this, mx, my);
        this.attackCooldown = this.stats.cooldown / this.buffFire();
        // A little recoil sells the shot.
        this.vx -= Math.cos(this.aimAngle) * (this.power.shot.knockback * 0.06);
      }

      /* ---- abilities ---- */
      if (canFight) {
        for (const a of this.abilities) {
          if (a.type !== 'active' || !a.key) continue;
          if (this.level < a.unlockLevel) continue;
          if (input.pressed(a.key)) PF.Abilities.use(a, this, game, mx, my);
        }
      }

      this.applyPhysics(dt, game.area);
      this._checkOutOfBounds();
    }
  }

  PF.Player = Player;
})(window.PF);
