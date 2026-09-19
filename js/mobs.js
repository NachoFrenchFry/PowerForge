/* ==========================================================================
   Power Forge — mobs.js
   Wildlife and hostiles.

   PEACEFUL mobs (cow, sheep, pig, chicken, turkey, rooster) wander, take
   damage from the player's projectiles via getDamageables, and pay out EXP
   on death. HOSTILE mobs (hunter, for now) wander the same way until the
   player enters their aggro range, then chase and melee.

   None of it routes through PF.Sprites: that module assumes one fixed
   128x128 player-shaped frame geometry, while mobs have per-species cell
   sizes and foot anchors measured directly from each sheet.

   Mobs carry a small status system (burn / slow / stun / knockback /
   launch) so the ability rework has something to actually DO to them
   beyond subtracting hit points.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const Levels = PF.Levels;

  /* Scans down from row `fromRow` (default: the very top of the map) at
     world-x `x` to find the actual terrain height there, the same way
     abilities.js's groundYAt does — needed because the def's plain zone
     fallback (below) used to hand every mob the area's flat reference
     groundY regardless of the painted terrain's real shape, stranding them
     wherever that reference line happened to sit (often mid-air over a
     hill, or underground). Returns null if there's no ground anywhere at
     or below fromRow in that column.

     _collectSites passes the mask mark's OWN row as fromRow: scanning from
     row 0 instead would find the topmost solid cell in the WHOLE column,
     which on a map with overhangs/floating platforms is routinely some
     unrelated structure floating high above where the mark was actually
     painted, not the ground beneath it. The zone fallback has no such
     reference row to start from, so it keeps scanning from the top — the
     usual "drop it wherever there's floor" case. */
  function groundLineAt(area, x, fromRow) {
    const ts = area.tileSize || 64;
    const col = Math.floor(x / ts);
    const maxRow = area.tileGrid ? area.tileGrid.length : 80;
    for (let row = Math.max(0, fromRow || 0); row < maxRow; row++) {
      if (area.filledAt(col, row)) return area.groundY + row * ts;
    }
    return null;
  }

  /* cell = both the frame width and height (frame width == texture height,
     per how the sheets were exported). anchorY = measured foot position
     within a cell, in source-texture pixels. `weight` scales how much
     knockback/launch actually moves them — a chicken should fly, a cow
     should barely budge. hp/expReward/scale are tuning values; cell,
     anchorY and the frame counts are measured facts, not tunable. */
  /* `headroom`: how many native (pre-scale) pixel rows of transparent
     padding sit above the actual drawn creature within its frame, measured
     from the source art itself (the minimum across idle/walk/attack, so the
     bar clears the tallest pose too). The frame box (cell x cell) is mostly
     empty padding — the anchor/hitbox math alone puts the bar way above
     wherever the animal actually is, worse the bigger the padding, which is
     exactly why the cows were the most visibly wrong. Without a measured
     value a species defaults to 0 (bar sits at the very top of the frame —
     conservative, if anything a little high, never overlapping). */
  const MOB_SPECIES = {
    /* ---- peaceful wildlife ---- */
    cow: {
      path: 'peaceful/cow', cell: 64, anchorY: 42, idleFrames: 4, walkFrames: 6,
      scale: 2.94, hp: 380, expReward: 70, weight: 2.2, headroom: 12,
      // The default hitbox formula (cell*scale*0.6 / anchorY*scale*0.95)
      // sizes it off the cow's large 64px cell and 2.94 scale same as
      // every other species — reads noticeably oversized next to the
      // actual drawn cow, more than the others, so it gets its own
      // shrink on top of that shared formula.
      hitboxScale: 0.7
    },
    sheep: {
      path: 'peaceful/sheep', cell: 32, anchorY: 26, idleFrames: 4, walkFrames: 6,
      scale: 2.58, hp: 170, expReward: 30, weight: 1.0, headroom: 4
    },
    pig: {
      path: 'peaceful/pig', cell: 32, anchorY: 26, idleFrames: 4, walkFrames: 6,
      scale: 2.58, hp: 170, expReward: 30, weight: 1.0, headroom: 11
    },
    chicken: {
      path: 'peaceful/chicken', cell: 16, anchorY: 13, idleFrames: 4, walkFrames: 6,
      scale: 2.94, hp: 70, expReward: 12, weight: 0.5, headroom: 3
    },
    turkey: {
      path: 'peaceful/turkey', cell: 32, anchorY: 25, idleFrames: 4, walkFrames: 6,
      scale: 2.58, hp: 120, expReward: 22, weight: 0.7, headroom: 6
    },
    rooster: {
      path: 'peaceful/rooster', cell: 32, anchorY: 25, idleFrames: 6, walkFrames: 6,
      scale: 2.58, hp: 120, expReward: 22, weight: 0.7, headroom: 8
    },

    /* ---- hostiles ----
       The hunter's cells are NOT square like the wildlife's: they're 40 wide
       by 32 tall (idle/attack are 160px = 4 frames, walk is 195px = 5 frames
       with the trailing 5px of empty padding trimmed off the sheet). `cellW`
       overrides the square assumption; species without it stay square.
       Feet sit on the very last pixel row, so anchorY is the full cell
       height. Scale is high because the source is only 32px tall; 3.2 puts it
       on screen a little taller than the player, which is where a humanoid
       enemy should sit — the player's own art is a 128px frame that's mostly
       padding, so it draws far smaller than its frame size suggests. */
    hunter: {
      path: 'hostile/normal/hunter', cell: 32, cellW: 40, anchorY: 32,
      idleFrames: 4, walkFrames: 5, attackFrames: 4,
      scale: 3.2, hp: 450, expReward: 300, weight: 2.5, headroom: 0,
      // Every other sheet in MOB_SPECIES is drawn facing right by default
      // (render()'s flip assumes that), but the hunter's own art was drawn
      // facing left — this flags it as the one exception instead of
      // flipping the convention (and every other species) around it.
      facesLeft: true,
      hostile: true,
      aggroRange: 200,       // player must come this close to be noticed
      /* Melee reach, measured centre-to-centre. The hunter's own half-width
         is ~38px and the player's ~17, so ~55 of this is just the two bodies
         touching — 120 leaves about one 64px block of real gap, which is the
         reach the swing animation looks like it has. */
      attackRange: 120,
      chaseSpeed: 165,
      attackDamage: 30,
      windup: 0.30,          // frozen in place, telegraphing the swing
      recover: 0.22,         // still frozen, then it re-decides
      loseAggro: 10          // seconds spent beyond 2x aggro before giving up
    },

    /* Wolf — same AI shape as the hunter (aggro/chase/windup/strike/recover
       are all shared code in _hostileAI/_attackPhase; only the numbers
       below differ), but it notices you from much further off, closes
       distance faster, and hits harder.
       Sheet is 48x29 per frame (idle/attack 192px = 4 frames, walk 288px =
       6), measured directly off the art. Feet sit on the very last pixel
       row same as the hunter, so anchorY is the full cell height; headroom
       is 0 since at least one attack frame (a lunging pose) draws all the
       way to row 0 with no empty margin above it. Like the hunter, the
       source art faces left, opposite the render() default. */
    wolf: {
      path: 'hostile/normal/wolf', cell: 29, cellW: 48, anchorY: 29,
      idleFrames: 4, walkFrames: 6, attackFrames: 4,
      scale: 3.2, hp: 750, expReward: 800, weight: 3, headroom: 0,
      facesLeft: true,
      hostile: true,
      aggroRange: 420,       // notices you from much further than the hunter's 200
      attackRange: 130,
      chaseSpeed: 260,       // faster than the hunter's 165
      attackDamage: 60,
      // 695 clears exactly 2 blocks (128px) — computed the same
      // discrete-step way MOB_JUMP_FORCE (~1.3 blocks) was tuned, since the
      // continuous v^2/2g formula overshoots the game's real per-frame
      // gravity integration. See _tickPhysics's hop trigger.
      jumpForce: 695,
      windup: 0.24,
      recover: 0.18,
      loseAggro: 10
    },

    /* Frog — same shared AI as the hunter/wolf. Sheet is 47x26 per frame
       (idle/attack 188px = 4 frames, walk 282px = 6), measured off the art
       the same way. Feet sit on the last pixel row, so anchorY is the full
       cell height; headroom is 0 since one walk frame (the leaping pose)
       draws all the way to row 0. Source art faces left too, same as the
       other two hostiles. */
    frog: {
      path: 'hostile/normal/frog', cell: 26, cellW: 47, anchorY: 26,
      idleFrames: 4, walkFrames: 6, attackFrames: 4,
      scale: 3.2, hp: 200, expReward: 100, weight: 1.5, headroom: 0,
      facesLeft: true,
      hostile: true,
      aggroRange: 150,
      attackRange: 160,
      chaseSpeed: 100,
      attackDamage: 20,
      // 848 clears exactly 3 blocks (192px) — same discrete-step tuning
      // as the wolf's jumpForce above.
      jumpForce: 848,
      windup: 0.28,
      recover: 0.20,
      loseAggro: 10
    }
  };

  const FPS = 10;                       // matches the rest of the game's authored rate
  const PEACEFUL_MIX = Object.keys(MOB_SPECIES).filter((k) => !MOB_SPECIES[k].hostile);
  const HOSTILE_MIX = Object.keys(MOB_SPECIES).filter((k) => MOB_SPECIES[k].hostile);
  /* Hard caps — a dead one is replaced immediately. Tuned for the original
     68000px-wide flat hub; scaled down proportionally for any smaller area
     (like a level-editor test map) so wildlife density stays roughly the
     same instead of packing the same 200+60 mobs into a much smaller space. */
  const PEACEFUL_CAP = 200;
  const HOSTILE_CAP = 60;
  const CAP_REFERENCE_WIDTH = 68000;
  const MIN_PEACEFUL_CAP = 10;
  const MIN_HOSTILE_CAP = 5;

  function capsFor(area) {
    const scale = U.clamp(area.width / CAP_REFERENCE_WIDTH, 0, 1);
    return {
      peaceful: Math.max(MIN_PEACEFUL_CAP, Math.round(PEACEFUL_CAP * scale)),
      hostile: Math.max(MIN_HOSTILE_CAP, Math.round(HOSTILE_CAP * scale))
    };
  }
  const HIT_FLASH_TIME = 0.16;          // ~10 frames at 60fps
  const MOB_GRAVITY = 1800;
  /* Apex ~1.3 tiles (83px) at MOB_GRAVITY — just enough to hop a single
     64px ledge with a little room to spare, not scale a cliff. Computed the
     same way player.js's jumpForce was tuned: simulated against the game's
     actual discrete-step gravity (1/60s ticks), not the continuous-formula
     estimate, since that overshoots the real in-engine apex by a few
     percent. */
  const MOB_JUMP_FORCE = 563;
  const KNOCK_CONTROL_LOCK = 0.4;       // AI leaves vx alone this long after a hit
  /* Ability knockback numbers (info.knockback) were landing mobs several
     tiles away from a single hit — visibly far more than a hit should move
     something. Scaled down hard so the impulse is barely noticeable rather
     than removed outright (a hit should still read as a hit). */
  const MOB_KNOCKBACK_MULT = 0.03;

  let uidCounter = 20000;

  /* Scratch canvas for the hit-flash. 'source-atop' composites against
     whatever is already painted at that spot on the shared game canvas
     (ground, sky, other sprites) — not just the frame we just drew — so
     doing it directly on the main canvas bleeds white into the background
     instead of cutting to the mob's own silhouette. Compositing on an
     isolated offscreen buffer first (which starts fully transparent) keeps
     'source-atop' scoped to just this sprite's own alpha. */
  let flashBuf = null, flashCtx = null;
  function flashBuffer(w, h) {
    if (!flashBuf) { flashBuf = document.createElement('canvas'); flashCtx = flashBuf.getContext('2d'); }
    if (flashBuf.width < w || flashBuf.height < h) {
      flashBuf.width = Math.ceil(w);
      flashBuf.height = Math.ceil(h);
    }
    flashCtx.clearRect(0, 0, w, h);
    return flashCtx;
  }

  /* Loads idle/walk (+ attack where present) sheets per species.
     Deliberately standalone rather than going through PF.Sprites.load(). */
  function loadSpecies(onDone) {
    const names = Object.keys(MOB_SPECIES).filter((n) => !MOB_SPECIES[n].placeholder);
    let pending = 0;
    names.forEach((n) => { pending += MOB_SPECIES[n].attackFrames ? 3 : 2; });
    function one() { pending--; if (pending <= 0 && onDone) onDone(); }
    if (!names.length && onDone) onDone();
    names.forEach((name) => {
      const sp = MOB_SPECIES[name];
      const states = sp.attackFrames ? ['idle', 'walk', 'attack'] : ['idle', 'walk'];
      states.forEach((state) => {
        const img = new Image();
        img.onload = function () { sp[state + 'Image'] = img; one(); };
        img.onerror = function () {
          console.warn('Power Forge: could not load mob texture textures/mobs/' + sp.path + '/' + state + '.png');
          one();
        };
        img.src = encodeURI('textures/mobs/' + sp.path + '/' + state + '.png');
      });
    });
  }

  /* Which sheet a given AI state draws from. */
  const STATE_SHEET = {
    idle: 'idle', walk: 'walk', chase: 'walk',
    windup: 'attack', strike: 'attack', recover: 'attack'
  };
  const ATTACK_STATES = { windup: 1, strike: 1, recover: 1 };

  class Mob {
    constructor(species, x, groundLine) {
      this.species = species;
      const sp = MOB_SPECIES[species];
      this.uid = uidCounter++;
      this.team = 'enemy';
      this.alive = true;
      this.hostile = !!sp.hostile;
      this.showDamageNumbers = false;   // death pays out a custom "+N EXP" label instead

      if (sp.placeholder) {
        // No sprite sheet yet — the hitbox IS the drawn box, sized directly
        // rather than derived from cell/scale/anchorY (see render()).
        this.w = sp.placeholder.w;
        this.h = sp.placeholder.h;
      } else {
        // The hitbox is deliberately smaller than the full cell*scale frame
        // — that frame includes padding around the actual creature, so
        // sizing the hitbox to the whole frame made shots register well
        // outside the visible animal. Doesn't affect rendering: render()
        // draws from cell/scale/anchorY directly, independent of the hitbox.
        const hbScale = sp.hitboxScale || 1;
        this.w = (sp.cellW || sp.cell) * sp.scale * 0.6 * hbScale;
        this.h = sp.anchorY * sp.scale * 0.95 * hbScale;
      }
      this.x = x - this.w / 2;
      this.y = groundLine - this.h;      // groundLine only matters at spawn now — see _tickPhysics

      this.maxHp = sp.hp;
      this.hp = this.maxHp;
      this.weight = sp.weight || 1;

      this.state = U.chance(0.5) ? 'idle' : 'walk';
      this.stateTimer = U.rand(1.5, 3.5);
      this.facing = U.chance(0.5) ? 1 : -1;
      this.walkSpeed = U.rand(32, 60);

      this.animFrame = 0;
      this.animTime = 0;
      this.hitFlash = 0;
      this.dying = 0;

      /* ---- physics & statuses ---- */
      this.vx = 0;                  // AI-driven walk/chase speed, or knockback drift
      this.vy = 0;
      this.onGround = true;         // set for real each frame by PF.Physics.step
      this.hitWall = false;
      this.airborne = false;        // kept in sync with !onGround, for the AI/anim checks
      this.knockTimer = 0;          // while >0, AI leaves vx alone so knockback can decay
      this.jumpCooldown = 0;        // throttles repeated hops against the same obstacle
      this._aiWantsMove = false;
      this._hopping = false;        // mid-hop-over-a-ledge — see _tickPhysics
      this._hopVx = 0;
      this.burn = null;             // { dps, time, colors }
      this.slowTime = 0;
      this.slowFactor = 1;
      this.stunTime = 0;
      this.vulnTime = 0;
      this.vulnMult = 1;            // >1 while petrified/marked

      /* ---- hostile AI ---- */
      this.aggro = false;
      this.outOfRangeTime = 0;
      this.phaseTimer = 0;
    }

    /* ---- damage & status ------------------------------------------------ */

    takeDamage(amount, info) {
      if (!this.alive) return 0;

      // Getting hit is always aggro, regardless of aggroRange — a hunter
      // struck from off in the distance (a projectile, an AoE that reached
      // further than its notice range) should retaliate instead of standing
      // there ignoring the player who's actively attacking it.
      if (this.hostile && !this.aggro) {
        this.aggro = true;
        this.outOfRangeTime = 0;
      }

      const raw = Math.max(1, amount) * this.vulnMult;
      const dealt = Math.min(this.hp, raw);
      this.hp -= dealt;
      this.hitFlash = HIT_FLASH_TIME;

      if (info) {
        if (info.knockback) {
          // MOB_KNOCKBACK_MULT only softens the horizontal shove itself —
          // info.launch and direct .launch() calls (tornado lift, backdraft's
          // throw, etc.) are a separate, deliberate mechanic and stay as
          // ability-authored, not touched by this.
          const imp = (info.knockback / this.weight) * MOB_KNOCKBACK_MULT;
          this.vx += (info.dirX || 0) * imp;
          this.vx = U.clamp(this.vx, -900, 900);
          this.knockTimer = KNOCK_CONTROL_LOCK;
          if (info.dirY && info.dirY < 0) this.launch(-info.dirY * imp * 0.7);
        }
        if (info.launch) this.launch(info.launch);
        if (info.burn) this.applyBurn(info.burn, info.burnTime || 3, info.colors);
        if (info.slow) this.applySlow(info.slow, info.slowTime || 2);
        if (info.stun) this.applyStun(info.stun);
        if (info.vuln) this.applyVuln(info.vuln, info.vulnTime || 3);
      }

      if (this.hp <= 0) this._die(info);
      return dealt;
    }

    launch(power) {
      const v = power / this.weight;
      if (v <= 0) return;
      this.vy = -v;
      this.airborne = true;
      this.knockTimer = KNOCK_CONTROL_LOCK;
    }

    applyBurn(dps, time, colors) {
      // Refreshing a burn takes the stronger tick and the longer timer,
      // rather than stacking into something unbounded.
      if (!this.burn || dps >= this.burn.dps) {
        this.burn = { dps: dps, time: Math.max(time, this.burn ? this.burn.time : 0), colors: colors || null };
      } else {
        this.burn.time = Math.max(this.burn.time, time);
      }
    }

    applySlow(factor, time) {
      this.slowFactor = Math.min(this.slowFactor, 1 - factor);
      this.slowTime = Math.max(this.slowTime, time);
    }

    applyStun(time) { this.stunTime = Math.max(this.stunTime, time); }

    applyVuln(mult, time) {
      this.vulnMult = Math.max(this.vulnMult, mult);
      this.vulnTime = Math.max(this.vulnTime, time);
    }

    _die(info) {
      const game = this._game;
      this.alive = false;
      this.dying = 0.3;
      if (!game) return;

      const c = (info && info.colors) || { primary: [255, 220, 150], secondary: [255, 255, 255] };
      game.particles.burst(U.cx(this), U.cy(this), {
        count: this.hostile ? 34 : 18, speed: [60, 300], size: [2, 7], life: [0.2, 0.6],
        shape: 'spark', gravity: 300, ring: true, flash: this.hostile
      }, c, this.hostile ? 1.3 : 0.9);

      const exp = Levels.expForMobKill(MOB_SPECIES[this.species].expReward, game.player.level);
      game.player.addExp(exp);
      game.combat.addNumber(U.cx(this), this.y - 4, '+' + exp + ' EXP', [190, 255, 190], 18);
      PF.Audio.hit();

      // Wildlife only — a hostile hunter/wolf/frog doesn't leave meat behind.
      if (!this.hostile) game.items.maybeDropMeat(U.cx(this), this.y + this.h);
    }

    /* ---- per-frame ------------------------------------------------------ */

    update(dt, game) {
      this._game = game;
      if (this.hitFlash > 0) this.hitFlash -= dt;

      if (!this.alive) {
        if (this.dying > 0) this.dying -= dt;
        return;
      }

      this._tickStatuses(dt, game);

      // AI decides its desired vx/facing BEFORE physics runs, same order
      // the player uses (input, then applyPhysics) — so a walk/chase
      // decision made this frame actually moves the mob this frame,
      // instead of sitting a frame behind.
      if (this.stunTime <= 0) {
        if (this.hostile) this._hostileAI(dt, game);
        else this._wander(dt, game);
      }

      this._tickPhysics(dt, game);
      this._stepAnimation(dt);
    }

    _tickStatuses(dt, game) {
      if (this.stunTime > 0) this.stunTime -= dt;

      if (this.slowTime > 0) {
        this.slowTime -= dt;
        if (this.slowTime <= 0) this.slowFactor = 1;
      }

      if (this.vulnTime > 0) {
        this.vulnTime -= dt;
        if (this.vulnTime <= 0) this.vulnMult = 1;
      }

      if (this.burn) {
        this.burn.time -= dt;
        this.hp -= this.burn.dps * dt;
        if (Math.random() < dt * 22) {
          game.particles.spawn({
            x: U.cx(this) + U.rand(-this.w * 0.4, this.w * 0.4),
            y: U.cy(this) + U.rand(-this.h * 0.3, this.h * 0.3),
            vx: U.rand(-18, 18), vy: U.rand(-70, -25),
            size: U.rand(2, 5), life: U.rand(0.2, 0.45),
            color: (this.burn.colors && this.burn.colors.primary) || [255, 140, 50],
            shape: 'ember', glow: 0.8
          });
        }
        if (this.burn.time <= 0) this.burn = null;
        if (this.hp <= 0) { this._die({ colors: this.burn && this.burn.colors }); return; }
      }
    }

    /* Real gravity + solid-object collision, routed through the exact same
       PF.Physics.step the player uses against area.solids() — mobs used to
       move by direct x/y assignment against a groundLine frozen at spawn,
       so they never noticed the terrain changing height under them and
       never collided with a wall at all. */
    _tickPhysics(dt, game) {
      const area = game.area;
      if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
      if (this.knockTimer > 0) this.knockTimer -= dt;

      // Mid-hop, keep re-asserting the push every frame BEFORE Physics.step
      // runs — Physics.step resolves horizontal collision using this
      // frame's height, which hasn't risen yet on the very frames right
      // after takeoff, so it re-collides with the same wall and zeros vx
      // right back out each time until the mob actually rises clear of it.
      // Without this, that repeated zeroing wins: the mob reaches full
      // height with 0 horizontal speed and just drops straight back down
      // in front of the wall it was trying to clear, never landing past it.
      if (this._hopping) this.vx = this._hopVx;

      // Captured before Physics.step can zero it out on a wall hit — the
      // hop trigger below needs to know what the AI was actually trying
      // to do.
      const desiredVx = this.vx;

      this.vy += MOB_GRAVITY * dt;
      if (this.vy > PF.Physics.MAX_FALL) this.vy = PF.Physics.MAX_FALL;
      PF.Physics.step(this, area, dt);
      this.airborne = !this.onGround;

      if (this.onGround) this._hopping = false;

      // A wall stopped an intentional stride (not a knockback stagger) —
      // hop over it, the way the player steps up a low ledge, capped low
      // (MOB_JUMP_FORCE, ~1.3 tiles, unless the species overrides it — the
      // wolf clears a full 2 blocks) so it reads as climbing a curb, not
      // scaling a cliff. Too tall to clear just bonks the mob's head and
      // drops it back — same collision the wall itself gets, no special
      // case needed. jumpCooldown stops it from spamming hops in place
      // against something it can never clear.
      if (this.hitWall && this.onGround && this._aiWantsMove &&
          this.knockTimer <= 0 && this.jumpCooldown <= 0) {
        this.vx = desiredVx;
        this.vy = -(MOB_SPECIES[this.species].jumpForce || MOB_JUMP_FORCE);
        this.onGround = false;
        this.airborne = true;
        this.jumpCooldown = 0.5;
        this._hopping = true;
        this._hopVx = desiredVx;
      }

      // Knockback drift decays with ground friction once back down. AI
      // reassigns vx itself every frame it wants to move (see
      // _wander/_hostileAI), so this only matters while knockback owns vx.
      if (this.knockTimer > 0 && this.vx !== 0) {
        const drag = this.onGround ? 6 : 0.6;
        this.vx = U.damp(this.vx, 0, drag, dt);
        if (Math.abs(this.vx) < 4) this.vx = 0;
      }
      this._aiWantsMove = false;

      const minX = 40, maxX = area.width - 40 - this.w;
      if (this.x < minX) { this.x = minX; if (this.vx < 0) this.vx = 0; }
      if (this.x > maxX) { this.x = maxX; if (this.vx > 0) this.vx = 0; }
    }

    _wander(dt, game) {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        if (this.state === 'walk') {
          this.state = 'idle';
          this.stateTimer = U.rand(1.5, 3.5);
        } else {
          this.state = 'walk';
          this.facing = U.chance(0.5) ? 1 : -1;
          this.stateTimer = U.rand(1.5, 4);
        }
      }
      if (this.knockTimer > 0 || !this.onGround) return;
      if (this.state === 'walk') {
        this.vx = this.facing * this.walkSpeed * this.slowFactor;
        this._aiWantsMove = true;
      } else {
        this.vx = 0;
      }
    }

    /* Wander until the player comes close, then close the distance and
       swing. Freezes completely while swinging, and only gives up after
       the player has stayed beyond twice the aggro range for a while. */
    _hostileAI(dt, game) {
      const sp = MOB_SPECIES[this.species];
      const real = game.player;
      if (!real || !real.alive) { this._wander(dt, game); return; }

      // A live decoy (the Sand Clones ability) steals attention while it lasts.
      const taunt = game.taunt && game.taunt.until > game.time ? game.taunt : null;
      const player = taunt ? { x: taunt.x, y: taunt.y, w: 0, h: 0, alive: true } : real;

      // Real 2D distance, not just horizontal — an X-only check let a
      // hunter on a completely different platform (or the far side of a
      // wall it can't actually reach) notice and even land hits on the
      // player purely because their X happened to line up, however far
      // apart they actually were vertically.
      const dist = Math.hypot(U.cx(this) - U.cx(player), U.cy(this) - U.cy(player));

      if (!this.aggro) {
        if (dist <= sp.aggroRange) {
          this.aggro = true;
          this.outOfRangeTime = 0;
          this.state = 'chase';
        } else {
          this._wander(dt, game);
          return;
        }
      }

      // Losing interest: the player has to stay far away, not just step out.
      if (dist > sp.aggroRange * 2) {
        this.outOfRangeTime += dt;
        if (this.outOfRangeTime >= sp.loseAggro) {
          this.aggro = false;
          this.state = 'idle';
          this.stateTimer = U.rand(1, 2.5);
          return;
        }
      } else {
        this.outOfRangeTime = 0;
      }

      if (ATTACK_STATES[this.state]) { this._attackPhase(dt, game, sp, dist, player, player === real); return; }

      // Chasing: face the player and close in, until in reach.
      if (dist <= sp.attackRange) { this._beginWindup(sp); return; }
      this.state = 'chase';
      this.facing = U.cx(player) > U.cx(this) ? 1 : -1;
      if (this.knockTimer <= 0 && this.onGround) {
        this.vx = this.facing * sp.chaseSpeed * this.slowFactor;
        this._aiWantsMove = true;
      }
    }

    _beginWindup(sp) {
      this.state = 'windup';
      this.phaseTimer = sp.windup;
      this.animFrame = 0;
      this.animTime = 0;
      this.vx = 0;
    }

    _attackPhase(dt, game, sp, dist, player, isRealPlayer) {
      this.phaseTimer -= dt;
      if (this.phaseTimer > 0) return;

      if (this.state === 'windup') {
        // The swing lands. Reach is slightly forgiving so a player walking
        // out on the last frame still risks getting clipped. A swing aimed
        // at a decoy connects with nothing but sand.
        this.state = 'strike';
        this.phaseTimer = sp.recover;
        if (isRealPlayer && dist <= sp.attackRange * 1.25) {
          const dirX = U.cx(player) > U.cx(this) ? 1 : -1;
          game.combat.applyDamage(player, sp.attackDamage, {
            x: U.cx(player), y: U.cy(player),
            colors: { primary: [255, 90, 90], secondary: [255, 210, 210], dark: [140, 30, 30] },
            knockback: 240, dirX: dirX, dirY: -0.35, source: this
          });
          game.shake(7, 0.18);
        }
        // Slash arc in front of it either way — a whiff should read as a whiff.
        const ax = U.cx(this) + this.facing * this.w * 0.7;
        game.particles.cone(ax, U.cy(this), this.facing > 0 ? 0 : Math.PI, 0.7, {
          count: 16, speed: [120, 380], size: [2, 6], life: [0.12, 0.3], shape: 'spark'
        }, { primary: [255, 120, 90], secondary: [255, 235, 220] }, 1);
        return;
      }

      if (this.state === 'strike') { this.state = 'recover'; this.phaseTimer = sp.recover; return; }

      // recover finished — swing again right away if still in reach.
      if (dist <= sp.attackRange) this._beginWindup(sp);
      else this.state = 'chase';
    }

    _stepAnimation(dt) {
      const sp = MOB_SPECIES[this.species];
      if (sp.placeholder) return;   // no sheet to cycle frames on
      const sheet = STATE_SHEET[this.state] || 'idle';
      const frames = sheet === 'walk' ? sp.walkFrames
        : sheet === 'attack' ? sp.attackFrames : sp.idleFrames;

      this.animTime += dt;
      const period = 1 / FPS;
      let guard = 0;
      while (this.animTime >= period && guard++ < 8) {
        this.animTime -= period;
        // The attack sheet plays once and holds its last pose; movement
        // sheets loop.
        if (sheet === 'attack') this.animFrame = Math.min(this.animFrame + 1, frames - 1);
        else this.animFrame = (this.animFrame + 1) % frames;
      }
      if (this.animFrame >= frames) this.animFrame = frames - 1;
    }

    render(ctx) {
      if (!this.alive && this.dying <= 0) return;
      const sp = MOB_SPECIES[this.species];
      if (sp.placeholder) { this._renderPlaceholder(ctx, sp); return; }
      const sheetName = STATE_SHEET[this.state] || 'idle';
      const img = sp[sheetName + 'Image'] || sp.idleImage;
      if (!img) return;

      const frames = sheetName === 'walk' ? sp.walkFrames
        : sheetName === 'attack' ? sp.attackFrames : sp.idleFrames;
      const frame = Math.min(this.animFrame, frames - 1);
      const cell = sp.cell;
      // Cells are square unless a species says otherwise (the hunter's are
      // 40x32), so `cellW` steps the sheet horizontally while `cell` stays
      // the row height.
      const cellW = sp.cellW || cell;
      const scale = sp.scale;
      const footX = Math.round(this.x + this.w * 0.5);
      const footY = Math.round(this.y + this.h);
      const flip = sp.facesLeft ? this.facing > 0 : this.facing < 0;
      const dw = cellW * scale, dh = cell * scale;
      const ox = -cellW * 0.5 * scale, oy = -sp.anchorY * scale;

      ctx.save();
      if (!this.alive) ctx.globalAlpha = Math.max(0, this.dying / 0.3);
      ctx.imageSmoothingEnabled = false;
      ctx.translate(footX, footY);
      if (flip) ctx.scale(-1, 1);

      if (this.hitFlash > 0) {
        // Composite the flash on an isolated offscreen buffer (see
        // flashBuffer() above) so 'source-atop' only whites out this
        // sprite's own drawn pixels, not the ground/sky behind it.
        const bctx = flashBuffer(dw, dh);
        bctx.imageSmoothingEnabled = false;
        // The buffer is shared across every mob's flash, and a PREVIOUS
        // flash leaves this set to 'source-atop' — drawing the fresh sprite
        // under that mode into a just-cleared (fully transparent) buffer
        // paints nothing at all, since source-atop only paints where the
        // destination is already opaque. Reset it before the sprite draw.
        bctx.globalCompositeOperation = 'source-over';
        bctx.drawImage(img, frame * cellW, 0, cellW, cell, 0, 0, dw, dh);
        bctx.globalCompositeOperation = 'source-atop';
        bctx.fillStyle = 'rgba(255,255,255,' + U.clamp(this.hitFlash / HIT_FLASH_TIME, 0, 1) + ')';
        bctx.fillRect(0, 0, dw, dh);
        ctx.drawImage(flashBuf, 0, 0, dw, dh, ox, oy, dw, dh);
      } else {
        ctx.drawImage(img, frame * cellW, 0, cellW, cell, ox, oy, dw, dh);
      }
      ctx.restore();

      this._renderBars(ctx);
    }

    /* No sprite sheet yet — a labelled box sized to the actual hitbox
       (see [[placeholder-art-for-new-content]]), so it's obviously a
       stand-in rather than a real texture gone missing. Swapping in real
       art later just means dropping a `path`/`cell`/`scale`/frame counts
       onto the species def and deleting `placeholder`; nothing else about
       this mob (AI, collision, damage, spawning) has to change. */
    _renderPlaceholder(ctx, sp) {
      const x = Math.round(this.x), y = Math.round(this.y);
      ctx.save();
      if (!this.alive) ctx.globalAlpha = Math.max(0, this.dying / 0.3);
      ctx.fillStyle = sp.placeholder.color;
      ctx.fillRect(x, y, this.w, this.h);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, this.w - 2, this.h - 2);
      if (this.hitFlash > 0) {
        ctx.fillStyle = 'rgba(255,255,255,' + U.clamp(this.hitFlash / HIT_FLASH_TIME, 0, 1) + ')';
        ctx.fillRect(x, y, this.w, this.h);
      }
      // A little direction wedge, since there's no art to otherwise show
      // which way it's actually facing (relevant for its attack lunge).
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      const ax = this.facing > 0 ? x + this.w : x;
      ctx.beginPath();
      ctx.moveTo(ax, y + this.h * 0.35);
      ctx.lineTo(ax + this.facing * 10, y + this.h * 0.5);
      ctx.lineTo(ax, y + this.h * 0.65);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '700 12px "PowerForge", sans-serif';
      ctx.fillText(this.species.toUpperCase(), x + this.w / 2, y + this.h / 2 + 4);
      ctx.restore();

      this._renderBars(ctx);
    }

    /* Every mob (peaceful included, now that they can take damage too) gets
       a health bar and name label, shown always rather than only once
       they're actually hurt — same as the player's own bar (see entity.js),
       so you can identify what something is before you've already hit it.
       Hostiles additionally get an "it has noticed you" tell, explicitly
       stacked above whatever the bar just occupied so the two can never
       overlap regardless of whether the bar is showing.

       Anchored to the creature's actual VISUAL top, not the hitbox: the
       hitbox (this.y/this.h) is deliberately smaller than the sprite's own
       frame (see the constructor), and the frame itself is mostly empty
       padding around the drawn animal (see `headroom` above) — anchoring
       off the hitbox alone is what put the bars way above the actual cows
       and co. This redoes the same footY/anchorY math render() uses to
       place the sprite, then walks down by `headroom` rows (scaled) to land
       right above the creature's actual drawn pixels instead of its frame's
       empty top margin. */
    _renderBars(ctx) {
      if (!this.alive) return;
      const sp = MOB_SPECIES[this.species];
      // A placeholder's drawn box IS the hitbox — no frame padding to walk
      // past the way a real sprite needs (see the comment above).
      let visualTopY;
      if (sp.placeholder) {
        visualTopY = Math.round(this.y);
      } else {
        const footY = Math.round(this.y + this.h);
        const frameTopY = footY - sp.anchorY * sp.scale;
        visualTopY = frameTopY + (sp.headroom || 0) * sp.scale;
      }

      PF.HealthBar.renderMob(ctx, this, U.clamp(this.hp / this.maxHp, 0, 1), visualTopY - 6);
    }
  }

  /* ---- manager --------------------------------------------------------- */

  class Mobs {
    constructor(game) {
      this.game = game;
      this.list = [];
      this.ready = false;
      this._sites = null;   // { peaceful: [...], hostile: [...] } when an area defines masks
      loadSpecies(() => { this.ready = true; });
    }

    /* Rebuild for whichever area we just walked into. */
    buildFor(area) {
      this.list.length = 0;
      this._sites = this._collectSites(area);
      this._caps = capsFor(area);
      for (let i = 0; i < this._caps.peaceful; i++) this._spawnOne(area, false);
      for (let i = 0; i < this._caps.hostile; i++) this._spawnOne(area, true);
    }

    reset() {
      this.list.length = 0;
      this._sites = null;
    }

    /* A level painted in the editor carries per-tile spawn masks. A mark
       only pins down a COLUMN, not an exact stand height — the editor's
       brush lands wherever the artist clicked along the terrain's
       silhouette, which is routinely a row or two off the real surface
       (painted a little into the hill, or a little above it), so this
       scans that column for its actual ground the same way the def's
       plain-zone fallback does (groundLineAt), rather than demanding the
       exact marked cell be open air directly over solid ground. Areas
       without masks fall back to the def's plain x-range zones. */
    _collectSites(area) {
      const mask = area.spawnMask;
      if (!mask) return null;
      const ts = area.tileSize;
      // `defined` is deliberately separate from "has sites": a layer that was
      // painted and then left empty means "nothing of this kind spawns here",
      // which is a real choice and must not silently fall back to the def's
      // x-range zone.
      const out = { peaceful: [], hostile: [], defined: { peaceful: false, hostile: false } };
      ['peaceful', 'hostile'].forEach((kind) => {
        const rows = mask[kind];
        if (!rows) return;
        out.defined[kind] = true;
        const seenCols = new Set();
        for (let row = 0; row < rows.length; row++) {
          const r = rows[row];
          if (!r) continue;
          for (let col = 0; col < r.length; col++) {
            if (!r[col] || seenCols.has(col)) continue;
            seenCols.add(col);
            const x = col * ts + ts / 2;
            const groundLine = groundLineAt(area, x, row);
            if (groundLine == null) continue;   // no ground at or below the mark
            out[kind].push({ x, groundLine });
          }
        }
      });
      if (!out.defined.peaceful && !out.defined.hostile) return null;
      return out;
    }

    _spawnOne(area, hostile) {
      const species = U.pick(hostile ? HOSTILE_MIX : PEACEFUL_MIX);
      if (!species) return null;

      const kind = hostile ? 'hostile' : 'peaceful';
      const sites = this._sites && this._sites[kind];
      // Painted-but-empty layer: this kind simply doesn't spawn in this area.
      if (this._sites && this._sites.defined[kind] && !sites.length) return null;

      let x, groundLine;
      if (sites && sites.length) {
        const site = U.pick(sites);
        x = site.x;
        groundLine = site.groundLine;
      } else {
        const zone = (hostile ? area.hostileZone : area.peacefulZone) ||
          { x0: 80, x1: area.width - 80 };
        const no = area.noMobZone;
        let tries = 0;
        do {
          x = U.rand(zone.x0, zone.x1);
          groundLine = groundLineAt(area, x);
          tries++;
        } while ((groundLine == null || (no && x >= no.x0 && x <= no.x1)) && tries < 24);
        if (groundLine == null) return null;
      }

      const mob = new Mob(species, x, groundLine);
      this.list.push(mob);
      return mob;
    }

    update(dt) {
      const game = this.game;
      const area = game.area;

      // Mobs never despawn on their own (no distance-based recycling) —
      // only death frees up a slot, immediately backfilled below.
      let peaceful = 0, hostile = 0;
      for (let i = this.list.length - 1; i >= 0; i--) {
        const m = this.list[i];
        m.update(dt, game);
        if (!m.alive && m.dying <= 0) { this.list.splice(i, 1); continue; }
        if (m.hostile) hostile++; else peaceful++;
      }

      // Hard caps with an immediate replacement the instant a slot frees up.
      const caps = this._caps || capsFor(area);
      while (peaceful < caps.peaceful) { this._spawnOne(area, false); peaceful++; }
      while (hostile < caps.hostile) { this._spawnOne(area, true); hostile++; }
    }

    render(ctx) {
      for (const m of this.list) m.render(ctx);
    }

    /* Everything a player projectile is allowed to hurt right now. */
    alive() {
      const out = [];
      for (const m of this.list) if (m.alive) out.push(m);
      return out;
    }
  }

  PF.MobSpecies = MOB_SPECIES;
  PF.Mob = Mob;
  PF.Mobs = Mobs;
})(window.PF);
