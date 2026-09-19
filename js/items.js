/* ==========================================================================
   Power Forge — items.js
   World pickups: things a dead peaceful mob can leave behind, that fall to
   the ground under real physics and get collected by simply touching them
   — no dedicated pickup key, same as walking over a coin in most action
   games. Currently just meat (mobs.js's _die rolls the drop, this module
   only owns the dropped object's life on the ground), feeding the player's
   one-slot inventory (see player.js's meatCount / eatMeat()).
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;

  /* Recommended home for item art: textures/items/<name>.png, a new
     top-level folder alongside textures/player, textures/mobs, textures/ui
     — parallel to how those are already organised by "kind of thing", not
     nested under something else. Missing/not-yet-dropped-in art falls back
     to a plain coloured square (see WorldItem.render) rather than failing
     to render at all. */
  const ICON_SRC = { meat: 'textures/items/meat.png' };
  const FALLBACK_COLOR = { meat: '#b5533d' };

  const icons = {};
  Object.keys(ICON_SRC).forEach((kind) => {
    const img = new Image();
    img.onload = () => { icons[kind] = img; };
    img.onerror = () => {
      console.warn('Power Forge: could not load ' + ICON_SRC[kind] +
        ' — drawing ' + kind + ' as a placeholder square until the art is in place.');
    };
    img.src = encodeURI(ICON_SRC[kind]);
  });

  const SIZE = 22;             // world-space pickup box (both hitbox and drawn size)
  const POP_SPEED = [50, 90];  // horizontal scatter on drop, like a Minecraft item pop
  const POP_LIFT = [140, 220]; // upward kick on drop
  const ICON_SCALE = 2;        // in-game pixels per texture pixel for dropped-item art

  class WorldItem {
    constructor(kind, x, y) {
      this.kind = kind;
      this.w = SIZE;
      this.h = SIZE;
      this.x = x - this.w / 2;
      this.y = y - this.h;
      this.vx = U.rand(-1, 1) * U.rand(POP_SPEED[0], POP_SPEED[1]);
      this.vy = -U.rand(POP_LIFT[0], POP_LIFT[1]);
      this.onGround = false;
      this.hitWall = false;
      this.dead = false;
      this.bobPhase = Math.random() * Math.PI * 2;
      // A picked-up item is consumed on the SAME frame it lands inside the
      // player, but shouldn't be collectible the instant it spawns out of a
      // mob that was just standing inside the player's own hitbox mid-hit.
      this.pickupDelay = 0.15;
    }

    update(dt, game) {
      const area = game.area;
      this.vy += PF.Physics.GRAVITY * dt;
      if (this.vy > PF.Physics.MAX_FALL) this.vy = PF.Physics.MAX_FALL;
      PF.Physics.step(this, area, dt);
      if (this.onGround) this.vx = U.damp(this.vx, 0, 10, dt);
      this.bobPhase += dt * 3;

      if (this.pickupDelay > 0) { this.pickupDelay -= dt; return; }

      const p = game.player;
      if (p.alive && U.aabb(this, p)) {
        this.dead = true;
        if (this.kind === 'meat') p.meatCount++;
        PF.Audio.pickup();
        game.particles.burst(U.cx(this), U.cy(this), {
          count: 10, speed: [40, 140], size: [2, 4], life: [0.2, 0.4],
          shape: 'spark', gravity: -60
        }, { primary: [255, 210, 160], secondary: [255, 255, 255] }, 0.6);
      }
    }

    render(ctx) {
      const bob = Math.sin(this.bobPhase) * 3;
      const cx = Math.round(this.x + this.w / 2);
      const cy = Math.round(this.y + this.h / 2 + bob);
      const icon = icons[this.kind];

      ctx.save();
      ctx.translate(cx, cy);
      if (icon && icon.complete && icon.naturalWidth) {
        // Drawn at its own aspect ratio, independent of the pickup hitbox
        // (this.w/this.h) — same reasoning as mobs.js's sprites: forcing
        // whatever the source image's actual shape happens to be into a
        // fixed square hitbox size would visibly stretch/squash it.
        ctx.imageSmoothingEnabled = false;
        const dw = icon.naturalWidth * ICON_SCALE;
        const dh = icon.naturalHeight * ICON_SCALE;
        ctx.drawImage(icon, -dw / 2, -dh / 2, dw, dh);
      } else {
        ctx.fillStyle = FALLBACK_COLOR[this.kind] || '#c8c8c8';
        ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h);
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(-this.w / 2 + 1, -this.h / 2 + 1, this.w - 2, this.h - 2);
      }
      ctx.restore();
    }
  }

  class Items {
    constructor(game) {
      this.game = game;
      this.list = [];
    }

    reset() {
      this.list.length = 0;
    }

    spawn(kind, x, y) {
      const it = new WorldItem(kind, x, y);
      this.list.push(it);
      return it;
    }

    /* Called from mobs.js's _die for peaceful kills — a flat 30% chance,
       rolled once per death, not per something else that might scale it
       later (crits, multi-kill AoE, etc.) since none of that exists yet. */
    maybeDropMeat(x, y) {
      if (Math.random() < 0.3) this.spawn('meat', x, y);
    }

    update(dt) {
      const game = this.game;
      for (let i = this.list.length - 1; i >= 0; i--) {
        const it = this.list[i];
        it.update(dt, game);
        if (it.dead) this.list.splice(i, 1);
      }
    }

    render(ctx) {
      for (const it of this.list) it.render(ctx);
    }
  }

  PF.Items = Items;
})(window.PF);
