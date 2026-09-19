/* ==========================================================================
   Power Forge — healthbar.js
   Shared world-space health bar rendering for the player and every mob.

   The bar's FRAME (the outline/corners) is a hand-drawn texture; the actual
   health fill is plain code-drawn rectangles dropped into the frame's hollow
   interior — no fill texture needed for that part, and it lets the color
   grade live from green to red as health drops, which a static asset can't
   do on its own.

   The mob frame (40x5) is cropped down to just its own drawn content. The
   player's bar.png and hearth.png are different: they're two 46x10 canvases
   that were authored to be drawn TOGETHER at the same origin — the heart
   sits at the left edge, the bar frame fills the rest — so those two are
   drawn using that full shared coordinate space instead of being cropped
   separately, which is what keeps the heart exactly where it was drawn
   relative to the bar. See PLAYER_UNIT below for the measurements.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;

  /* `sx/sy/sw/sh`: the sub-rect of the source PNG that actually has content.
     `inX/inY/inW/inH`: the hollow interior where the fill goes, relative to
     that cropped sub-rect's own (0,0) origin — i.e. add these to (sx,sy) to
     get real source coordinates, or (as _draw does) scale them the same as
     the rest of the crop when drawing at a different on-screen size. */
  const MOB_FRAME = { sx: 0, sy: 0, sw: 40, sh: 5, inX: 1, inY: 1, inW: 38, inH: 3 };

  /* The player's bar.png and hearth.png are two 46x10 canvases that share
     ONE coordinate space — the heart lives at its left edge (x0-11) and the
     bar frame fills the rest (x9-45), exactly the layout the artist intends
     to be drawn together. So unlike MOB_FRAME above, this ISN'T cropped down
     to just the bar's own content — PLAYER_UNIT spans the whole shared
     canvas, and both images get drawn at that same (x,y,w,h) so their
     relative position comes out pixel-exact, the way they were authored. */
  const PLAYER_UNIT = { w: 46, h: 10, fillX: 10, fillY: 3, fillW: 35, fillH: 3 };

  const HealthBar = {
    ready: false,
    mobFrame: null,
    playerFrame: null,
    heart: null,

    load(onDone) {
      let pending = 3;
      const done = () => { pending--; if (pending <= 0) { this.ready = true; if (onDone) onDone(); } };
      const one = (prop, src) => {
        const img = new Image();
        img.onload = done;
        img.onerror = function () {
          console.warn('Power Forge: could not load ' + src);
          done();
        };
        img.src = encodeURI(src);
        this[prop] = img;
      };
      one('mobFrame', 'textures/mobs/health_bar/bar.png');
      one('playerFrame', 'textures/player/health_bar/bar.png');
      one('heart', 'textures/player/health_bar/hearth.png');
    },

    /* Fixed fill color regardless of remaining health — only the bar's
       length shows how hurt something is, not its color. */
    fillColor() {
      return [70, 210, 90];
    },

    /* Draws one frame+fill bar centered on `cx`, bottom edge at `bottomY`
       (so stacking another element — the heart, another bar — above it is
       just "subtract the height this returned from bottomY"). Returns the
       rendered height. */
    _draw(ctx, cx, bottomY, width, frame, frameImg, frac) {
      const scale = width / frame.sw;
      const height = frame.sh * scale;
      const x = Math.round(cx - width / 2);
      const y = Math.round(bottomY - height);

      const innerW = frame.inW * scale;
      const innerH = frame.inH * scale;
      const innerX = Math.round(x + frame.inX * scale);
      const innerY = Math.round(y + frame.inY * scale);

      // Fill the whole interior black first, so the lost portion of a
      // damaged bar reads as an emptied bar, not a hole showing whatever's
      // behind it (the mob's own sprite, the world) — then lay the colored
      // fill on top, sized to `frac`. The frame is drawn AFTER (see below)
      // via its own separate drawImage scaling, which rounds independently
      // from this rect at fractional scales — a 1px BLEED grows the black
      // backdrop just past the frame's own hollow interior on every side
      // so the frame's opaque border pixels always fully cover the seam
      // between the two instead of leaving a hairline gap.
      const BLEED = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(
        innerX - BLEED, innerY - BLEED,
        Math.max(1, Math.round(innerW) + BLEED * 2), Math.max(1, Math.round(innerH) + BLEED * 2)
      );

      if (frac > 0) {
        ctx.fillStyle = U.rgb(this.fillColor(frac));
        ctx.fillRect(
          innerX - BLEED, innerY - BLEED,
          Math.max(1, Math.round(innerW * frac) + (frac >= 1 ? BLEED * 2 : BLEED)), Math.max(1, Math.round(innerH) + BLEED * 2)
        );
      }

      if (this.ready && frameImg && frameImg.complete && frameImg.naturalWidth) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(frameImg, frame.sx, frame.sy, frame.sw, frame.sh, x, y, width, height);
      }
      return height;
    },

    /* Mob bars scale with the mob's own on-screen width, so a cow's bar is
       visibly bigger than a chicken's, clamped so tiny mobs stay legible and
       huge ones don't get a comically wide one. `bottomY` is the caller's
       job to compute — mobs.js works out where the creature is actually
       drawn (its sprite frame has a lot of empty padding the hitbox doesn't
       know about) and passes the right anchor in, rather than this guessing
       from the entity box alone. Returns the new topmost occupied y, so a
       caller stacking something else above it (the hunter's aggro "!" mark)
       knows where it's safe to start without overlapping. */
    renderMob(ctx, entity, frac, bottomY) {
      const width = U.clamp(entity.w * 0.85, 30, 110);
      const cx = U.cx(entity);
      const h = this._draw(ctx, cx, bottomY, width, MOB_FRAME, this.mobFrame, frac);

      // Species name, left-aligned to the bar's own left edge rather than
      // centered over it — the bar's length is the "at a glance" read, the
      // name is only something you look for once you already care which
      // one this specific mob is, so it sits off to the side of that instead
      // of competing for the same centre line.
      const rawName = entity.name || entity.species || '';
      const label = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      if (label) {
        const barLeftX = Math.round(cx - width / 2);
        const nameY = bottomY - h - 3;
        ctx.save();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '700 10px "PowerForge", "Trebuchet MS", sans-serif';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(6,8,14,0.85)';
        ctx.strokeText(label, barLeftX, nameY);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, barLeftX, nameY);
        ctx.restore();
      }

      return bottomY - h;
    },

    /* Player: heart and bar drawn together as one unit (see PLAYER_UNIT) so
       the heart lands to the left of the bar exactly as authored, with the
       heart drawn AFTER the bar so it layers above it wherever the two
       overlap. `bottomY` again comes from the caller (entity.js), which
       knows how much empty padding sits above the player's own sprite. */
    renderPlayer(ctx, entity, frac, bottomY) {
      const width = 116;
      const scale = width / PLAYER_UNIT.w;
      const height = PLAYER_UNIT.h * scale;
      const cx = U.cx(entity);
      const x = Math.round(cx - width / 2);
      const y = Math.round(bottomY - height);

      const fillX = Math.round(x + PLAYER_UNIT.fillX * scale);
      const fillY = Math.round(y + PLAYER_UNIT.fillY * scale);
      const fillW = Math.max(1, Math.round(PLAYER_UNIT.fillW * scale));
      const fillH = Math.max(1, Math.round(PLAYER_UNIT.fillH * scale));

      // Black backdrop for the whole bar first, so lost health reads as an
      // emptied bar rather than a hole showing the world through it. The
      // frame (playerFrame) is drawn AFTER via its own independently-scaled
      // drawImage call, which rounds separately from this rect at
      // fractional scales — a 1px BLEED grows the backdrop past the
      // frame's own hollow interior on every side so the frame's opaque
      // border pixels always fully cover the seam instead of leaving a
      // hairline gap of whatever's behind it.
      const BLEED = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(fillX - BLEED, fillY - BLEED, fillW + BLEED * 2, fillH + BLEED * 2);

      // Damage trail: entity.js eases trailHp down to hp over time instead
      // of snapping, so a hit leaves this bright-red strip sitting out past
      // the current fill — "this much just got taken" — that itself drains
      // away over the next moment, same idea as the delayed health bar in
      // most other action games.
      const trailFrac = U.clamp((entity.trailHp == null ? entity.hp : entity.trailHp) / entity.maxHp, 0, 1);
      if (trailFrac > frac) {
        ctx.fillStyle = '#e23b3b';
        const trailW = Math.max(1, Math.round(PLAYER_UNIT.fillW * scale * trailFrac));
        ctx.fillRect(fillX - BLEED, fillY - BLEED, trailW + BLEED, fillH + BLEED * 2);
      }

      if (frac > 0) {
        ctx.fillStyle = U.rgb(this.fillColor(frac));
        const partial = Math.max(1, Math.round(PLAYER_UNIT.fillW * scale * frac));
        ctx.fillRect(fillX - BLEED, fillY - BLEED, partial + (frac >= 1 ? BLEED * 2 : BLEED), fillH + BLEED * 2);
      }

      if (!this.ready) return height;
      ctx.imageSmoothingEnabled = false;
      if (this.playerFrame && this.playerFrame.complete && this.playerFrame.naturalWidth) {
        ctx.drawImage(this.playerFrame, 0, 0, PLAYER_UNIT.w, PLAYER_UNIT.h, x, y, width, height);
      }
      if (this.heart && this.heart.complete && this.heart.naturalWidth) {
        ctx.drawImage(this.heart, 0, 0, PLAYER_UNIT.w, PLAYER_UNIT.h, x, y, width, height);
      }
      return height;
    }
  };

  PF.HealthBar = HealthBar;
})(window.PF);
