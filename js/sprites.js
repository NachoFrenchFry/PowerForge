/* ==========================================================================
   Power Forge — sprites.js
   Sprite sheet loading and animation state.

   The art is authored on a 128x128 grid with the character standing on a
   fixed baseline: horizontal centre at x=64, feet at y=80. Every frame in
   every sheet shares that anchor, so we can pin the sprite to the entity's
   feet and never worry about per-frame offsets.

   The collision box (34x52) is deliberately NOT the sprite size. The sprite
   is drawn around the box at SCALE, so art and physics can be tuned apart.

   Animations can be WHOLE-BODY or SPLIT into two layers. A split pose draws a
   legs-only sheet with a torso-only sheet composited on top, each running its
   own clock — that's how you can shoot while running without the legs
   freezing. Both halves share the same 128x128 anchor, so they line up for
   free.

   Splitting is opt-in per combination and degrades safely: if either half is
   missing we fall back to the whole-body sheet. Right now only run+shoot is
   drawn, so walking or standing while shooting still uses whole-body 'shoot'
   until walk_bottom / idle_bottom exist.

   Adding an animation later:
     1. drop the sheet in textures/
     2. add an entry to SHEETS below
     3. for a whole-body pose, add a line to resolve()
        for a new bottom half, add it to BOTTOM_VARIANT — nothing else
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;

  /* ---- per-power recolouring ----
     The character art is drawn on a fixed 10-colour indexed palette (every
     real animation sheet uses exactly these 10 values, confirmed by
     scanning idle/walk/run/jump/fall/shoot pixel-for-pixel — nothing else
     ever appears). Only clothing (shirt + pants) is meant to change with
     your power; hair and skin stay put. The art already has hand-recoloured
     128x128 reference frames per power (textures/player/<power>.png,
     matched against design.png, the neutral reference) for exactly the
     poses that got full treatment — this table is that same mapping
     generalised to every sheet, applied at draw time on an offscreen
     canvas instead of needing a whole second set of sheets per power.

     One base colour, [41,22,0], is shared by TWO different parts of the
     rig: hair shadow AND the back leg's shadow. In the hand-done reference
     frame, hair shadow is the one that consistently
     stayed unrecoloured across all five power variants while the back leg's
     copy of that same value got tinted — but a flat colour-keyed swap can't
     tell those apart in frames where the reference wasn't hand-done (there
     is no positional data to fall back on once you're off that one frame).
     Between "hair changes colour with your power" (glaring) and "the back
     leg's shadow doesn't tint on some frames" (a few dark pixels, already a
     shadow tone), the second is the far smaller loss — so [41,22,0] is
     deliberately left out of RECOLOR_MAP and always renders as authored. */
  const RECOLOR_MAP = {
    fire: {
      '51,90,44': [255, 0, 0],      // shirt
      '46,77,40': [219, 6, 6],      // shirt shadow
      '64,34,0': [120, 37, 0],      // pants
      '90,48,0': [176, 54, 0],      // pants highlight
      '75,40,1': [150, 46, 0]       // pants shadow
    },
    water: {
      '51,90,44': [14, 56, 216],
      '46,77,40': [14, 49, 187],
      '64,34,0': [13, 32, 109],
      '90,48,0': [17, 43, 144],
      '75,40,1': [13, 36, 128]
    },
    sand: {
      '51,90,44': [225, 169, 0],
      '46,77,40': [197, 152, 19],
      '64,34,0': [141, 103, 30],
      '90,48,0': [182, 133, 39],
      '75,40,1': [161, 118, 32]
    },
    lightning: {
      '51,90,44': [255, 215, 60],
      '46,77,40': [238, 189, 0],
      '64,34,0': [148, 112, 40],
      '90,48,0': [199, 146, 44],
      '75,40,1': [176, 131, 43]
    },
    rain: {
      '51,90,44': [14, 171, 216],
      '46,77,40': [14, 141, 187],
      '64,34,0': [13, 101, 109],
      '90,48,0': [17, 122, 144],
      '75,40,1': [13, 103, 128]
    }
    // wind: no entry — the base art IS wind's colouring, so it draws as
    // authored with no recolour pass at all.
  };

  /* Authoring grid — matches how the frames were drawn. */
  const FRAME = {
    w: 128,
    h: 128,
    anchorX: 64,   // horizontal centre of the character within a frame
    anchorY: 80    // the ground line the character stands on
  };

  /* In-game pixels per texture pixel. Raise it for a chunkier character —
     bumped from the original 1.6 as part of the general "make everything
     bigger" pass (mobs get an even bigger bump than this, see mobs.js). */
  const SCALE = 2.4;

  /* Sheets are time-driven at `fps`. The art is authored for 100ms per frame,
     so 10fps — a 10-frame cycle takes exactly one second.

     A sheet can instead specify `stride` (pixels of horizontal travel per
     frame) to drive the cycle by distance, which stops the feet skating when
     movement speed changes. Swap `fps: 10` for `stride: 27` on walk (or 42 on
     run) if you'd rather have that. */
  const SHEETS = {
    // A breathing loop — it eases out to a hold around frames 4-5 and back,
    // and the 9→0 seam is tight, so it cycles without a visible pop.
    idle: { src: 'textures/player/idle.png', frames: 10, fps: 10 },
    walk: { src: 'textures/player/walk.png', frames: 10, fps: 10 },
    run: { src: 'textures/player/run.png', frames: 10, fps: 10 },

    /* Recoil-and-recover, fired on every ranged attack. Frame 0 is a braced
       crouch and frame 6 lands back on the idle pose, so it blends out without
       a pop. Firing again restarts it, which is why the fast elements read as
       a continuous braced recoil rather than a full recovery each time. */
    shoot: { src: 'textures/player/shoot.png', frames: 7, fps: 10, loop: false },

    /* Airborne one-shots. `loop: false` means the sheet plays once; when it
       ends it either hands off to `next` or holds its final frame.
         jump  — plays out and holds the last pose while you're still rising
         fall  — plays once as you tip over, then chains into…
         fallLoop — …which cycles until you land.
       `from` marks a sheet as a continuation, so once fall has handed off,
       stateFor asking for 'fall' again won't restart the sequence. */
    jump: { src: 'textures/player/jump.png', frames: 6, fps: 10, loop: false },
    fall: { src: 'textures/player/fall.png', frames: 4, fps: 10, loop: false, next: 'fallLoop' },
    fallLoop: { src: 'textures/player/fall_loop.png', frames: 3, fps: 10, from: 'fall' },

    /* ---- split layers ----
       `layer` marks a sheet as half a character. `phaseWith` names the
       whole-body sheet it shares a cycle with, so switching between the two
       keeps the leg phase instead of snapping back to frame 0. */
    run_bottom: { src: 'textures/player/run_bottom.png', frames: 10, fps: 10, layer: 'bottom', phaseWith: 'run' },
    shoot_top: { src: 'textures/player/shoot_top.png', frames: 7, fps: 10, loop: false, layer: 'top' },
    walk_bottom: { src: 'textures/player/walk_bottom.png', frames: 10, fps: 10, layer: 'bottom', phaseWith: 'walk' },

    /* Airborne legs-only halves. Same deal as run_bottom/walk_bottom: the
       whole-body jump/fall/fallLoop sheet is what plays normally while
       airborne, and this split only kicks in — shoot_top riding on top —
       while you're actually firing mid-air, per resolve() below. */
    jump_bottom: { src: 'textures/player/jump_bottom.png', frames: 6, fps: 10, loop: false, layer: 'bottom', phaseWith: 'jump' },
    fall_bottom: { src: 'textures/player/fall_bottom.png', frames: 4, fps: 10, loop: false, layer: 'bottom', phaseWith: 'fall', next: 'fall_loop_bottom' },
    fall_loop_bottom: { src: 'textures/player/fall_loop_bottom.png', frames: 3, fps: 10, layer: 'bottom', phaseWith: 'fallLoop', from: 'fall_bottom' }
  };

  /* Which legs-only sheet stands in for each grounded/airborne movement
     state, and which torso-only sheet overlays each action. A pose splits
     only when both halves are present. */
  const BOTTOM_VARIANT = {
    idle: 'idle_bottom', walk: 'walk_bottom', run: 'run_bottom',
    jump: 'jump_bottom', fall: 'fall_bottom'
  };
  const TOP_VARIANT = { shoot: 'shoot_top' };

  function has(name) {
    return !!(name && SHEETS[name] && SHEETS[name].image);
  }

  /* Builds (once) and caches a recoloured copy of one sheet's image for one
     power, by remapping RECOLOR_MAP's handful of exact palette colours in
     the raw pixel data — everything else (hair, skin, outlines, and every
     fully-transparent pixel) passes through untouched. Cached per
     (sheet, power) on the sheet object itself, so this only ever runs once
     per sheet/power pair actually used in a run, not per frame. */
  function recoloredImage(sheet, powerId) {
    const map = RECOLOR_MAP[powerId];
    if (!map || !sheet.image) return sheet.image;

    if (!sheet._recolored) sheet._recolored = {};
    const cached = sheet._recolored[powerId];
    if (cached) return cached;

    const img = sheet.image;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const cctx = canvas.getContext('2d');
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(img, 0, 0);

    const data = cctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;   // transparent — nothing to key on
      const key = px[i] + ',' + px[i + 1] + ',' + px[i + 2];
      const to = map[key];
      if (to) { px[i] = to[0]; px[i + 1] = to[1]; px[i + 2] = to[2]; }
    }
    cctx.putImageData(data, 0, 0);

    sheet._recolored[powerId] = canvas;
    return canvas;
  }

  const MOVING_THRESHOLD = 22;   // px/sec below which we consider you standing

  const Sprites = {
    FRAME: FRAME,
    SCALE: SCALE,
    SHEETS: SHEETS,
    ready: false,
    failed: false,

    /* Kick off loading. The game runs fine before this resolves — entities
       fall back to the procedural character until the art arrives. */
    load(onDone) {
      const self = this;
      const names = Object.keys(SHEETS);
      let pending = names.length;

      /* Declared before the loop on purpose: a cached image can fire onload
         synchronously from the `src` assignment, so `done` and everything it
         closes over must already exist by then. */
      function done() {
        pending--;
        if (pending > 0) return;
        // Usable as long as at least the idle frame arrived.
        self.ready = !!SHEETS.idle.image;
        if (onDone) onDone(self.ready);
      }

      if (!pending) { this.ready = true; if (onDone) onDone(true); return; }

      names.forEach(function (name) {
        const sheet = SHEETS[name];
        const img = new Image();
        sheet.image = null;
        img.onload = function () {
          sheet.image = img;
          // Trust the file over the declared frame count.
          sheet.frames = Math.max(1, Math.round(img.width / FRAME.w));
          done();
        };
        img.onerror = function () {
          console.warn('Power Forge: could not load ' + sheet.src +
            ' — falling back to the built-in character.');
          self.failed = true;
          done();
        };
        // encodeURI so filenames containing spaces still resolve.
        img.src = encodeURI(sheet.src);
      });
    },

    sheet(name) {
      const s = SHEETS[name];
      return (s && s.image) ? s : SHEETS.idle;
    },

    /* What should this entity be drawing right now?

         base — the whole-body sheet, or the legs when `top` is also set
         top  — a torso overlay, or null

       Airborne stays whole-body (jump/fall/fallLoop) normally, same as
       grounded movement — it only splits into legs (jump_bottom/fall_bottom/
       fall_loop_bottom) with shoot_top riding on top as the torso while
       you're actually firing, mirroring exactly how walk/run split for the
       grounded shoot pose. Falls back to the whole-body sheet if either
       half hasn't loaded. */
    resolve(e) {
      // Flight has no art of its own yet, so it keeps the floating idle.
      if (e.flying) return { base: 'idle', top: null };
      if (!e.onGround) {
        let move = null;
        if (e.vy < 0 && has('jump')) move = 'jump';
        else if (has('fall')) move = 'fall';
        if (!move) return { base: 'idle', top: null };

        if (e.shootTimer > 0) {
          const bottom = BOTTOM_VARIANT[move];
          const top = TOP_VARIANT.shoot;
          if (has(bottom) && has(top)) return { base: bottom, top: top };
        }
        return { base: move, top: null };
      }

      const moving = Math.abs(e.vx) >= MOVING_THRESHOLD;
      const move = moving ? (e.running ? 'run' : 'walk') : 'idle';

      if (e.shootTimer > 0) {
        const top = TOP_VARIANT.shoot;
        const bottom = BOTTOM_VARIANT[move];
        // Split only when both halves are drawn…
        if (has(top) && has(bottom)) return { base: bottom, top: top };
        // …otherwise the whole-body recoil still reads fine.
        if (has('shoot')) return { base: 'shoot', top: null };
      }
      return { base: move, top: null };
    },

    /* Kept for callers that only care about the main sheet. */
    stateFor(e) {
      return this.resolve(e).base;
    },

    _track(name) {
      return { name: name || 'idle', frame: 0, time: 0, dist: 0, done: false, overrideFps: undefined };
    },

    /* Point a track at a new sheet. Switching between a whole-body cycle and
       its legs-only twin keeps the phase, so starting or stopping fire never
       makes the legs stutter. */
    _switch(track, name) {
      if (track.name === name) return;
      const from = SHEETS[track.name];
      const to = SHEETS[name];
      const shared = !!(to && from && (to.phaseWith === track.name || from.phaseWith === name));
      track.name = name;
      track.done = false;
      if (!shared) {
        track.frame = 0;
        track.time = 0;
        track.dist = 0;
      } else if (to && track.frame >= to.frames) {
        track.frame = track.frame % to.frames;
      }
      // A speed override only applies to the shoot pose it was computed for;
      // moving on to a different animation (walk/idle/jump/...) must not
      // inherit it.
      if (name !== 'shoot' && name !== TOP_VARIANT.shoot) track.overrideFps = undefined;
    },

    /* Step one track's clock. Shared by the base and overlay layers so both
       obey loop / one-shot / hand-off rules identically. */
    _step(track, e, dt) {
      if (track.done) return;
      let sheet = SHEETS[track.name];
      if (!sheet) return;

      /* Returns false once a one-shot has parked on its final frame. */
      const stepFrame = () => {
        track.frame++;
        if (track.frame < sheet.frames) return true;
        if (sheet.loop !== false) { track.frame = 0; return true; }
        const next = sheet.next;
        if (has(next)) {
          track.name = next;
          sheet = SHEETS[next];
          track.frame = 0;
          return true;
        }
        track.frame = sheet.frames - 1;
        track.done = true;
        return false;
      };

      /* Step by subtracting whole frame periods rather than doing
         floor(elapsed * fps): accumulated floating point error in the latter
         makes the cycle stutter (…6, 7, 7, 9, 9…) after a few seconds. */
      if (sheet.stride) {
        track.dist += Math.abs(e.vx) * dt;
        let guard = 0;
        while (track.dist >= sheet.stride && guard++ < 64) {
          track.dist -= sheet.stride;
          if (!stepFrame()) break;
        }
      } else {
        let guard = 0;
        track.time += dt;
        while (guard++ < 64) {
          const period = 1 / (track.overrideFps || sheet.fps || 8);
          if (track.time < period) break;
          track.time -= period;
          if (!stepFrame()) break;
        }
      }
    },

    /* Advance an entity's animation. Tracks are created lazily. */
    advance(e, dt) {
      if (!e.anim) e.anim = this._track('idle');
      const want = this.resolve(e);

      // A one-shot that has already handed off keeps its successor rather than
      // restarting: 'fall' plays once, then 'fallLoop' holds until you land.
      let base = want.base;
      const current = SHEETS[e.anim.name];
      if (current && current.from === base) base = e.anim.name;

      this._switch(e.anim, base);
      this._step(e.anim, e, dt);

      if (want.top) {
        if (!e.animTop) e.animTop = this._track(want.top);
        this._switch(e.animTop, want.top);
        this._step(e.animTop, e, dt);
      } else if (e.animTop) {
        e.animTop = null;
      }
    },

    /* Fire the attack pose. Restarts whichever layer is carrying it, so
       shooting again mid-animation replays the recoil from the top.

       `cooldown` (the shooter's actual time between shots) drives the
       playback speed: the recoil is stretched or compressed so it finishes
       at 85% of the cooldown, leaving a small settle-frame before the next
       shot is allowed to restart it, rather than always playing at the
       sheet's fixed authored fps regardless of fire rate. */
    triggerShoot(e, cooldown) {
      const sheetName = has('shoot_top') ? 'shoot_top' : 'shoot';
      const sheet = SHEETS[sheetName];
      const baseFps = sheet.fps || 10;
      let fps = baseFps;
      if (cooldown > 0) {
        const targetDuration = cooldown * 0.85;
        // Floor at the sheet's authored rate (never play slower than drawn);
        // ceiling keeps a future fire-rate buff from blurring into noise.
        fps = U.clamp(sheet.frames / targetDuration, baseFps, 40);
      }

      // Set the timer first — resolve() keys off it.
      e.shootTimer = sheet.frames / fps;
      if (!e.anim) e.anim = this._track('idle');
      const want = this.resolve(e);
      if (want.top) {
        if (!e.animTop) e.animTop = this._track(want.top);
        this._switch(e.animTop, want.top);
        e.animTop.frame = 0; e.animTop.time = 0; e.animTop.dist = 0; e.animTop.done = false;
        e.animTop.overrideFps = fps;
      } else if (want.base === 'shoot') {
        this._switch(e.anim, 'shoot');
        e.anim.frame = 0; e.anim.time = 0; e.anim.dist = 0; e.anim.done = false;
        e.anim.overrideFps = fps;
      }
    },

    /* Draw one layer, pinned to the bottom-centre of the hitbox and flipped
       to match `spriteFacing`. Both halves use the same anchor, so a split
       pose composites with no per-layer offsets. */
    _drawTrack(ctx, e, track) {
      const sheet = SHEETS[track.name];
      if (!sheet || !sheet.image) return false;

      // Wind (or no power yet, e.g. mid-transition) draws the sheet exactly
      // as authored; every other power draws a recoloured copy instead —
      // see RECOLOR_MAP/recoloredImage above.
      const powerId = e.power && e.power.id;
      const image = recoloredImage(sheet, powerId);

      const frame = Math.min(track.frame | 0, sheet.frames - 1);
      const dw = FRAME.w * SCALE;
      const dh = FRAME.h * SCALE;
      const footX = Math.round(e.x + e.w * 0.5);
      const footY = Math.round(e.y + e.h);
      const flip = (e.spriteFacing || 1) < 0;

      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(footX, footY);
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(
        image,
        frame * FRAME.w, 0, FRAME.w, FRAME.h,
        -FRAME.anchorX * SCALE, -FRAME.anchorY * SCALE, dw, dh
      );

      // Hit flash: the same frame drawn additively reads as a white blowout.
      if (e.hurtFlash > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, e.hurtFlash / 0.22) * 0.85;
        ctx.drawImage(
          image,
          frame * FRAME.w, 0, FRAME.w, FRAME.h,
          -FRAME.anchorX * SCALE, -FRAME.anchorY * SCALE, dw, dh
        );
      }
      ctx.restore();
      return true;
    },

    /* Legs first, torso over the top. */
    draw(ctx, e) {
      if (!this.ready) return false;
      if (!e.anim) e.anim = this._track('idle');
      const drew = this._drawTrack(ctx, e, e.anim);
      if (e.animTop) this._drawTrack(ctx, e, e.animTop);
      return drew;
    }
  };

  PF.Sprites = Sprites;
})(window.PF);
