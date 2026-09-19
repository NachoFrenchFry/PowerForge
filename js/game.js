/* ==========================================================================
   Power Forge — game.js
   Central game state, the fixed-logical-resolution renderer, and the loop.
   Everything the player owns lives on `game.player`; everything the world
   owns lives on `game.area`. Nothing important is a loose global.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const Levels = PF.Levels;

  /* Developer tools. Set to false (or delete the DEV block in _devKeys)
     to strip test shortcuts from a release build. */
  const DEV_TOOLS_ENABLED = true;

  class Game {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.state = 'title';          // title | select | playing
      this.time = 0;
      this.timeScale = 1;
      this.frames = 0;
      this.fps = 60;
      this._fpsAcc = 0;
      this._fpsFrames = 0;

      this.ui = new PF.UI(this);
      this.particles = new PF.ParticleSystem();
      this.combat = new PF.Combat(this);
      this.camera = new PF.Camera();
      this.mobs = new PF.Mobs(this);
      this.items = new PF.Items(this);

      this.areas = {};
      this.area = null;
      this.player = null;

      this.fields = [];              // lingering slow/damage clouds
      this.bolts = [];               // chain-lightning visuals
      this.spawners = [];            // timed projectile emitters (rain, storms)
      this.telegraphs = [];          // "this is where it lands" target boxes
      this.summons = [];             // self-updating ability entities (clouds, tornadoes…)
      // { x, y, until } — hostiles chase this instead of the player while it
      // is fresh. Sand's decoys refresh it every frame they're alive.
      this.taunt = null;

      this.debug = false;
      this.lowHpPulse = 0;
    }

    /* ---- setup ---------------------------------------------------------- */

    init() {
      this.ui.init();
      PF.Sprites.load();
      PF.Tiles.load();
      PF.HealthBar.load();
      PF.Input.init(this.canvas);
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this.ui.showScreen('title');
      this._bindGlobalKeys();
    }

    /* The frame always exactly fills the window — no letterbox bars, no
       overflow/cropping — while the physical size everything renders at
       (buttons, mobs, the player, tiles) is governed by whichever of
       width/height is currently the SHORTER window dimension, measured
       against a fixed reference (GAME_REF_SHORT, the 720 the game was
       designed around). That's what makes a bigger window make everything
       physically bigger without either hiding content (the old `min`/
       "contain" approach, which left bars) or clipping it (the `max`/
       "cover" approach, which could push corner-anchored HUD off-screen —
       exactly the "doesn't move" bug that was reported).

       U.GW/U.GH — the logical design resolution — are recomputed every
       resize to whatever exactly matches the window at that scale, instead
       of staying fixed at 1280x720. Every consumer (camera, input,
       culling) already reads U.GW/U.GH live, so this is safe; the fixed
       1280x720 assumption only lived in this function and in the CSS
       #frame/canvas rules (now sized in JS below instead). */
    resize() {
      const GAME_REF_SHORT = 720;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const availW = Math.max(240, window.innerWidth);
      const availH = Math.max(160, window.innerHeight);
      const scale = Math.min(availW, availH) / GAME_REF_SHORT;

      U.GW = availW / scale;
      U.GH = availH / scale;

      const frame = document.getElementById('frame');
      if (frame) {
        frame.style.width = U.GW + 'px';
        frame.style.height = U.GH + 'px';
        frame.style.setProperty('--scale', scale);
      }

      // The canvas keeps its logical CSS size (the frame transform does the
      // scaling, matching U.GW/U.GH exactly); only the backing store
      // follows the device pixel count.
      this.canvas.width = Math.max(1, Math.round(availW * dpr));
      this.canvas.height = Math.max(1, Math.round(availH * dpr));
      this.ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = false;   // keep pixel art crisp
      this.viewScale = scale;
    }

    _bindGlobalKeys() {
      window.addEventListener('keydown', (e) => {
        if (e.repeat) return;

        if (e.code === 'Escape') {
          if (this.state !== 'playing') return;
          this.ui.toggleMenu();
          return;
        }

        if (e.code === 'Tab' && this.state === 'playing') {
          this.ui.toggleAbilityPanel();
          return;
        }

        if (this.state !== 'playing') return;
        this._devKeys(e.code);
      });
    }

    /* ------------------------------------------------------------------
       DEV BLOCK — testing shortcuts only. Safe to delete wholesale.
       ------------------------------------------------------------------ */
    _devKeys(code) {
      if (!DEV_TOOLS_ENABLED || !this.player) return;
      const p = this.player;
      switch (code) {
        case 'F1':
          this.debug = this.ui.toggleDebug();
          break;
        case 'F2':
          p.addExp(Levels.expToNext(p.level));
          this.ui.toast('DEV', '+' + U.fmt(Levels.expToNext(p.level)) + ' EXP');
          break;
        case 'F3':
          p.addExp(Math.max(1, p.expToNext - p.exp));
          break;
        case 'F4':
          while (p.level < 30) p.addExp(Math.max(1, p.expToNext - p.exp));
          this.ui.toast('DEV', 'Jumped to level 30');
          break;
        case 'F6':
          p.healFull();
          this.ui.toast('DEV', 'Health restored');
          break;
        case 'F7':
          p.meatCount += 500;
          this.ui.toast('DEV', '+500 meat');
          break;
        default: break;
      }
    }
    /* ---------------------- END DEV BLOCK ---------------------------- */

    /* ---- run lifecycle --------------------------------------------------- */

    startRun(powerId) {
      this.player = new PF.Player(this, powerId);
      this.areas = {};
      this.fields.length = 0;
      this.bolts.length = 0;
      this.spawners.length = 0;
      this.telegraphs.length = 0;
      this.summons.length = 0;
      this.taunt = null;
      this.particles.clear();
      this.combat.reset();
      this.mobs.reset();
      this.items.reset();

      this.area = this._getArea('hub');
      this.player.spawnAt(this.area.spawn.x, this.area.spawn.y);
      this.mobs.buildFor(this.area);
      this.camera.snapTo(this.player, this.area);

      this.ui.setPowerTheme(this.player.power);
      this.ui.buildAbilityBar(this.player);
      this.ui.buildShopPanel(this.player);
      this.ui.showScreen('game');
      this.ui.showHint(20);
      this.state = 'playing';

      PF.Audio.portal();
      this.ui.toast('POWER FORGED', this.player.power.name + ' — go hunt something');

      // Welcome burst.
      this.particles.burst(U.cx(this.player), U.cy(this.player), {
        count: 40, speed: [80, 380], size: [3, 8], life: [0.4, 0.9],
        shape: this.player.power.trail.shape, ring: true, flash: true
      }, this.player.power.colors, 1.4);
    }

    _getArea(id) {
      if (!this.areas[id]) this.areas[id] = PF.createArea(id);
      return this.areas[id];
    }

    travelTo(id) {
      const area = this._getArea(id);
      this.area = area;
      area.clearTemp();
      this.combat.reset();
      this.particles.clear();
      this.fields.length = 0;
      this.bolts.length = 0;
      this.spawners.length = 0;
      this.telegraphs.length = 0;
      this.summons.length = 0;
      this.taunt = null;
      this.items.reset();

      this.player.flying = false;
      this.player.spawnAt(area.spawn.x, area.spawn.y);
      this.camera.snapTo(this.player, area);

      // Wildlife belongs to the area, and returning to it restocks the run.
      this.mobs.buildFor(area);

      PF.Audio.portal();
      this.ui.toast('ENTERED', area.name);
      this.ui.showHint(7);
      this.particles.burst(U.cx(this.player), U.cy(this.player), {
        count: 26, speed: [70, 300], size: [3, 7], life: [0.3, 0.6],
        shape: this.player.power.trail.shape, ring: true
      }, this.player.power.colors, 1.1);
    }

    respawnPlayer() {
      const p = this.player;
      p.alive = true;
      p.healFull();
      p.flying = false;
      p.spawnAt(this.area.spawn.x, this.area.spawn.y);
      p.invulnTime = 1.4;

      // A death wipes the slate with every hostile that was chasing you —
      // otherwise you'd reappear at the spawn point already being hunted by
      // mobs from wherever you just died, sometimes clear across the map.
      for (const m of this.mobs.list) {
        if (!m.hostile) continue;
        m.aggro = false;
        m.outOfRangeTime = 0;
        m.state = 'idle';
        m.stateTimer = U.rand(1, 2.5);
      }
    }

    onLevelUp(level, newAbility) {
      const p = this.player;
      const before = Levels.statsFor(p.power, level - 1);
      const after = Levels.statsFor(p.power, level);
      const deltas = [
        '+' + (after.damage - before.damage).toFixed(1) + ' DMG',
        '+' + (after.maxHp - before.maxHp) + ' HP',
        '+' + Math.max(0, after.projSpeed - before.projSpeed) + ' SPD'
      ];

      this.ui.showLevelUp(level, newAbility, deltas);
      PF.Audio.levelUp();
      if (newAbility) setTimeout(() => PF.Audio.unlockAbility(), 420);

      this.particles.burst(U.cx(p), U.cy(p), {
        count: 60, speed: [90, 460], size: [3, 9], life: [0.4, 1.0],
        shape: p.power.trail.shape, gravity: -60, ring: true, flash: true
      }, p.power.colors, 1.8);
      for (let i = 0; i < 3; i++) {
        this.particles.ring(U.cx(p), U.cy(p), p.power.colors.secondary, 14 + i * 12, 0.5 + i * 0.15);
      }
      this.shake(9, 0.3);

      // A short dip in time makes the moment land without fully freezing play.
      this.timeScale = 0.35;

      if (newAbility) {
        this.ui.toast('ABILITY UNLOCKED', newAbility.name + ' — ' + (newAbility.keyLabel || ''));
      }
    }

    /* ---- shared services ------------------------------------------------- */

    shake(amp, time) { this.camera.shake(amp, time); }

    /* Everything a projectile owned by `team` is allowed to hurt. */
    getDamageables(team) {
      if (team === 'player') return this.mobs.alive();
      const out = [];
      if (this.player && this.player.alive) out.push(this.player);
      return out;
    }

    nearestEnemy(x, y, team, maxDist) {
      const list = this.getDamageables(team);
      let best = null, bestD = maxDist || Infinity;
      for (const e of list) {
        const d = U.dist(x, y, U.cx(e), U.cy(e));
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    }

    addWall(x, y, w, h, duration, colors) {
      const wall = { x: x, y: y, w: w, h: h, time: duration, maxTime: duration, colors: colors, kind: 'temp' };
      this.area.addTempSolid(wall);
      return wall;
    }

    addField(f) {
      if (this.fields.length > 8) this.fields.shift();
      this.fields.push(f);
      return f;
    }

    addBolt(x1, y1, x2, y2, colors) {
      if (this.bolts.length > 24) this.bolts.shift();
      this.bolts.push({
        x1: x1, y1: y1, x2: x2, y2: y2, colors: colors,
        life: 0.22, maxLife: 0.22, seed: ((Math.random() * 9000) | 0) + 1
      });
    }

    addSpawner(duration, count, fn) {
      this.spawners.push({
        interval: duration / Math.max(1, count),
        timer: 0, left: count, fn: fn
      });
    }

    /* A target marker drawn on the ground before a big area attack lands, so
       you can see exactly where it's about to hit. `onDone` fires when the
       wind-up finishes — that's where the actual effect goes. */
    addTelegraph(t) {
      t.time = t.time == null ? 0.4 : t.time;
      t.maxTime = t.time;
      t.shape = t.shape || 'box';
      this.telegraphs.push(t);
      return t;
    }

    /* A self-contained ability entity that lives for a while and runs its own
       update/render (storm clouds, tornadoes, drifting orbs, decoys…).
       `s.update(dt, game)` should set `s.dead = true` when it's finished. */
    addSummon(s) {
      if (this.summons.length > 24) this.summons.shift();
      this.summons.push(s);
      return s;
    }

    acceptsGameInput() {
      return this.state === 'playing' && !this.ui.isBlocking();
    }

    /* ---- update ---------------------------------------------------------- */

    update(dt) {
      PF.Input.tick(dt);
      this.ui.update(dt);

      if (this.state !== 'playing') return;

      // Ease the level-up time dilation back to normal.
      if (this.timeScale < 1) this.timeScale = Math.min(1, this.timeScale + dt * 1.6);

      if (this.ui.isBlocking()) return;   // menus freeze the world

      const sdt = dt * this.timeScale;
      this.time += sdt;

      this.area.update(sdt);
      this.player.update(sdt, PF.Input);
      this.mobs.update(sdt);
      this.items.update(sdt);

      this._updateSpawners(sdt);
      this._updateFields(sdt);
      this._updateBolts(sdt);
      this._updateTelegraphs(sdt);
      this._updateSummons(sdt);

      this.combat.update(sdt);
      this.particles.update(sdt);
      this.camera.follow(this.player, this.area, dt);

      this._updateInteractions();

      this.lowHpPulse = this.player.hp / this.player.maxHp < 0.3
        ? Math.min(1, this.lowHpPulse + dt * 3)
        : Math.max(0, this.lowHpPulse - dt * 3);

      this.ui.updateHUD(this.player);
      if (this.debug) this._updateDebug();
    }

    _updateSpawners(dt) {
      for (let i = this.spawners.length - 1; i >= 0; i--) {
        const s = this.spawners[i];
        s.timer -= dt;
        while (s.timer <= 0 && s.left > 0) {
          s.timer += s.interval;
          s.left--;
          s.fn();
        }
        if (s.left <= 0) this.spawners.splice(i, 1);
      }
    }

    _updateFields(dt) {
      for (let i = this.fields.length - 1; i >= 0; i--) {
        const f = this.fields[i];
        f.time -= dt;
        f.timer -= dt;
        if (f.timer <= 0) {
          f.timer = f.tick;
          const list = this.getDamageables(f.team);
          for (const e of list) {
            if (!e.alive) continue;
            if (U.dist(f.x, f.y, U.cx(e), U.cy(e)) > f.radius) continue;
            this.combat.applyDamage(e, f.dps * f.tick, {
              x: U.cx(e), y: U.cy(e), colors: f.colors, slow: f.slow, source: f.owner
            });
          }
        }
        // Drifting mist particles.
        if (Math.random() < dt * 26) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * f.radius;
          this.particles.spawn({
            x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r * 0.7,
            vx: U.rand(-20, 20), vy: U.rand(-24, 8),
            size: U.rand(3, 8), life: U.rand(0.5, 1.1),
            color: f.colors.primary, shape: 'drop', glow: 0.35, drag: 1
          });
        }
        if (f.time <= 0) this.fields.splice(i, 1);
      }
    }

    _updateBolts(dt) {
      for (let i = this.bolts.length - 1; i >= 0; i--) {
        this.bolts[i].life -= dt;
        if (this.bolts[i].life <= 0) this.bolts.splice(i, 1);
      }
    }

    _updateTelegraphs(dt) {
      for (let i = this.telegraphs.length - 1; i >= 0; i--) {
        const t = this.telegraphs[i];
        t.time -= dt;
        if (t.time > 0) continue;
        this.telegraphs.splice(i, 1);
        if (t.onDone) t.onDone();
      }
    }

    _updateSummons(dt) {
      for (let i = this.summons.length - 1; i >= 0; i--) {
        const s = this.summons[i];
        s.update(dt, this);
        if (s.dead) this.summons.splice(i, 1);
      }
    }

    _updateInteractions() {
      const p = this.player;
      const area = this.area;

      const portal = area.portalAt(p);
      const interactPressed = PF.Input.pressed('KeyF');

      if (portal) {
        this.ui.showPrompt('<b>F</b> ' + portal.label);
        if (interactPressed) this.travelTo(portal.to);
      } else if (p.meatCount > 0 && p.hp < p.maxHp) {
        // Only offered while actually hurt — nothing to gain by eating at
        // full HP, and heal() would just silently waste the meat. Right
        // click rather than F since F stays dedicated to portals/world
        // interactables, and eating needs its own key that isn't already
        // claimed by an ability slot (Q/E/R/T/G/Z/X/C/V/B/N).
        this.ui.showPrompt('<b>RMB</b> Eat Meat (' + p.meatCount + ')');
        if (PF.Input.rightPressed()) p.eatMeat();
      } else {
        this.ui.hidePrompt();
      }
    }

    _updateDebug() {
      const p = this.player;
      this.ui.setDebug(
        'FPS        ' + Math.round(this.fps) + '\n' +
        'AREA       ' + this.area.id + '  (' + this.area.width + 'px)\n' +
        'POS        ' + Math.round(p.x) + ', ' + Math.round(p.y) + '\n' +
        'VEL        ' + Math.round(p.vx) + ', ' + Math.round(p.vy) + '\n' +
        'GROUND     ' + (p.onGround ? 'yes' : 'no') + '   FLY ' + (p.flying ? 'yes' : 'no') + '\n' +
        'HP         ' + Math.ceil(p.hp) + '/' + p.maxHp + (p.shield ? '  +' + Math.round(p.shield.amount) : '') + '\n' +
        'LEVEL      ' + p.level + '   EXP ' + Math.round(p.exp) + '/' + p.expToNext + '\n' +
        'DMG/CD     ' + p.stats.damage.toFixed(1) + ' / ' + p.stats.cooldown.toFixed(2) + '\n' +
        'PROJ       ' + this.combat.projectiles.length + '   PARTS ' + this.particles.count + '\n' +
        'MOBS       ' + this.mobs.list.length
      );
    }

    /* ---- render ----------------------------------------------------------- */

    render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, U.GW, U.GH);

      if (this.state !== 'playing') {
        // Menus sit over a plain backdrop; the DOM screens do the work.
        ctx.fillStyle = '#05060c';
        ctx.fillRect(0, 0, U.GW, U.GH);
        return;
      }

      const cam = this.camera;
      this.area.renderBackground(ctx, cam);

      ctx.save();
      ctx.translate(-Math.round(cam.x) + cam.ox, -Math.round(cam.y) + cam.oy);

      this.area.renderTerrain(ctx, cam);
      this.area.renderProps(ctx, cam);

      // Target markers sit on the ground, under everything that moves.
      this._renderTelegraphs(ctx);

      this.items.render(ctx);
      this.mobs.render(ctx);

      this._renderFields(ctx);
      this._renderBolts(ctx);
      this._renderSummons(ctx);

      // Half the player's power-swirl (behindPlayer particles) draws here,
      // under the sprite; the rest draws with everything else below, on top
      // of it — the wraparound is what sells the semi-3D loop.
      this.particles.render(ctx, cam, true);
      if (this.player.alive) this.player.render(ctx);

      this.combat.render(ctx, cam);
      this.particles.render(ctx, cam);
      this.combat.renderNumbers(ctx);
      this._renderCrosshair(ctx);

      ctx.restore();

      this.area.renderAmbient(ctx, cam);
      this._renderLowHpPulse(ctx);
    }

    /* Corner-bracket target box that fills up as the wind-up runs out, so
       you can read exactly where an area attack is about to land. */
    _renderTelegraphs(ctx) {
      for (const t of this.telegraphs) {
        const prog = 1 - U.clamp(t.time / t.maxTime, 0, 1);   // 0 -> 1
        const c = t.colors || { primary: [255, 255, 255], secondary: [255, 255, 255] };
        const x = t.x - t.w / 2, y = t.y - t.h / 2;
        ctx.save();

        // Ground shading that sweeps in as it charges.
        ctx.fillStyle = U.rgba(c.primary, 0.10 + prog * 0.20);
        ctx.fillRect(x, y, t.w * prog, t.h);
        ctx.strokeStyle = U.rgba(c.secondary, 0.55 + prog * 0.4);
        ctx.lineWidth = 2;
        ctx.setLineDash([9, 7]);
        ctx.lineDashOffset = -this.time * 40;
        ctx.strokeRect(x, y, t.w, t.h);
        ctx.setLineDash([]);

        // Corner brackets — the part that reads instantly as "target".
        const arm = Math.min(18, t.w * 0.25, t.h * 0.25);
        ctx.strokeStyle = U.rgba(c.secondary, 0.95);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y + arm); ctx.lineTo(x, y); ctx.lineTo(x + arm, y);
        ctx.moveTo(x + t.w - arm, y); ctx.lineTo(x + t.w, y); ctx.lineTo(x + t.w, y + arm);
        ctx.moveTo(x + t.w, y + t.h - arm); ctx.lineTo(x + t.w, y + t.h); ctx.lineTo(x + t.w - arm, y + t.h);
        ctx.moveTo(x + arm, y + t.h); ctx.lineTo(x, y + t.h); ctx.lineTo(x, y + t.h - arm);
        ctx.stroke();
        ctx.restore();
      }
    }

    _renderSummons(ctx) {
      for (const s of this.summons) if (s.render) s.render(ctx, this);
    }

    _renderFields(ctx) {
      for (const f of this.fields) {
        const a = U.clamp(f.time / 0.8, 0, 1) * 0.5;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(f.x, f.y, 4, f.x, f.y, f.radius);
        g.addColorStop(0, U.rgba(f.colors.secondary, 0.16 * a));
        g.addColorStop(0.7, U.rgba(f.colors.primary, 0.14 * a));
        g.addColorStop(1, U.rgba(f.colors.primary, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(f.x, f.y, f.radius, f.radius * 0.78, 0, 0, Math.PI * 2);
        ctx.fill();
        // No outline ring. The soft glow alone is enough to read the hazard;
        // the crisp dashed circle that used to sit on top of it looked like
        // a targeting/range overlay rather than part of the world.
        ctx.restore();
      }
    }

    _renderBolts(ctx) {
      for (const b of this.bolts) {
        const a = b.life / b.maxLife;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.strokeStyle = U.rgba(b.colors.primary, 0.5 * a);
        ctx.lineWidth = 9;
        U.boltPath(ctx, b.x1, b.y1, b.x2, b.y2, 8, 26, b.seed);
        ctx.stroke();
        ctx.strokeStyle = U.rgba(b.colors.secondary, 0.95 * a);
        ctx.lineWidth = 3;
        U.boltPath(ctx, b.x1, b.y1, b.x2, b.y2, 8, 26, b.seed);
        ctx.stroke();
        ctx.restore();
      }
    }

    /* A subtle world-space crosshair that also shows attack readiness. */
    _renderCrosshair(ctx) {
      const p = this.player;
      const mx = PF.Input.mouse.x + this.camera.x;
      const my = PF.Input.mouse.y + this.camera.y;
      const ready = p.attackCooldown <= 0;
      const c = p.power.colors;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = U.rgba(ready ? c.secondary : c.dark, ready ? 0.85 : 0.4);
      ctx.lineWidth = 1.6;
      const r = ready ? 9 : 13;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx - r - 6, my); ctx.lineTo(mx - r - 1, my);
      ctx.moveTo(mx + r + 1, my); ctx.lineTo(mx + r + 6, my);
      ctx.moveTo(mx, my - r - 6); ctx.lineTo(mx, my - r - 1);
      ctx.moveTo(mx, my + r + 1); ctx.lineTo(mx, my + r + 6);
      ctx.stroke();
      ctx.fillStyle = U.rgba(c.primary, 0.8);
      ctx.fillRect(mx - 1, my - 1, 2, 2);
      ctx.restore();
    }

    /* The neutral always-on darkened-edge vignette is gone — just the
       low-HP red warning pulse remains, since that's a functional gameplay
       cue rather than a constant cosmetic dimming. */
    _renderLowHpPulse(ctx) {
      if (this.lowHpPulse <= 0.01) return;
      const pulse = (0.5 + Math.sin(this.time * 6) * 0.5) * this.lowHpPulse;
      const rg = ctx.createRadialGradient(U.GW / 2, U.GH / 2, U.GH * 0.3, U.GW / 2, U.GH / 2, U.GH * 0.85);
      rg.addColorStop(0, 'rgba(255,0,40,0)');
      rg.addColorStop(1, 'rgba(255,0,40,' + (0.28 * pulse).toFixed(3) + ')');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, U.GW, U.GH);
    }

    /* ---- main loop --------------------------------------------------------- */

    /* ---- fixed-timestep loop --------------------------------------------
       The simulation always advances in 1/60s slices, however slowly the
       machine can draw. A frame that took 50ms runs three catch-up steps
       instead of one big one, so the game keeps real-time pace on a struggling
       computer rather than crawling in slow motion — and physics stays stable
       because no single step is ever oversized.

       MAX_CATCHUP bounds how much lost time we try to reclaim: past that we
       let the clock slip, which prevents a stall from snowballing into an
       ever-growing backlog of updates. */
    start() {
      const FIXED_DT = 1 / 60;
      const MAX_CATCHUP = 0.25;   // seconds of backlog we're willing to replay
      const MAX_STEPS = 15;

      let last = performance.now();
      this.accumulator = 0;

      const frame = (now) => {
        const raw = Math.max(0, (now - last) / 1000);
        last = now;

        this._fpsAcc += raw;
        this._fpsFrames++;
        if (this._fpsAcc >= 0.5) {
          this.fps = this._fpsFrames / this._fpsAcc;
          this._fpsAcc = 0;
          this._fpsFrames = 0;
        }

        this.accumulator = Math.min(this.accumulator + raw, MAX_CATCHUP);

        let steps = 0;
        try {
          while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
            this.update(FIXED_DT);
            this.accumulator -= FIXED_DT;
            steps++;
          }
          this.render();
        } catch (err) {
          // A rendering hiccup should never brick the session.
          console.error('Power Forge loop error:', err);
        }

        // Only retire this frame's input once it has actually been simulated.
        // On a 144Hz display most frames run zero steps; clearing there would
        // silently swallow key presses.
        if (steps > 0) PF.Input.endFrame();
        this.simSteps = steps;
        this.frames++;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
  }

  PF.Game = Game;
})(window.PF);
