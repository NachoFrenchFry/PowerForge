/* ==========================================================================
   Power Forge — abilities.js
   Data-driven ability system.

   Eleven abilities per element, unlocking at 2 · 5 · 8 · 12 · 16 · 20 · 25 ·
   30 · 36 · 43 · 50, so the kit keeps growing for the whole run instead of
   being finished in the first half hour.

   DESIGN RULE: no two abilities anywhere in the game share a mechanic. Every
   active below has its own effect handler — there is no "shockwave with
   different numbers" repeated across five elements. Where two things look
   superficially similar they behave differently in play (Wind's Skyward
   Column launches and holds; Fire's Lava Geyser erupts along the ground and
   burns; Rain's Torrent is a sustained pin).

   Each element's kit is built around what the element actually IS:
     WIND      — movement, displacement, keeping things off the ground
     WATER     — flow, sustain, pressure, control of a single target
     FIRE      — commitment, burning ground, damage that keeps ticking
     SAND      — terrain, denial, weight, making enemies stop
     LIGHTNING — speed, instant reach, chaining, going through things
     RAIN      — falling volume, area denial, attrition

   Anything that lands somewhere other than on top of you draws a target box
   first (game.addTelegraph) so you can see where it's about to hit.

   Damage values are multipliers of the caster's basic attack damage, so
   abilities scale with level automatically.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;

  /* ---- shared helpers -------------------------------------------------- */

  function dmgOf(fx, caster) { return (fx.damage || 1) * caster.stats.damage * caster.buffDealt(); }
  function targetsOf(game, caster) { return game.getDamageables(caster.team); }
  function colorsOf(caster) { return caster.power.colors; }

  /* World y of the ground surface under `x` — walks the tile column down
     so painted levels with varying terrain work too.

     `fromY` is where that walk STARTS (defaults to the top of the map).
     Ground-targeted abilities pass the caster's own feet: scanning from the
     top instead finds the topmost solid tile in the whole column, so
     standing under any platform or overhang made a geyser/quicksand erupt
     out of the platform's roof high above the player rather than the floor
     they're aiming at. Starting at the caster's level skips everything
     overhead and finds the surface they actually mean — and effects that
     travel along the ground pass their own y for the same reason. */
  function groundYAt(game, x, fromY) {
    const area = game.area;
    const ts = area.tileSize || 64;
    const col = Math.floor(x / ts);
    const startRow = fromY == null ? 0 : Math.max(0, Math.floor((fromY - area.groundY) / ts));
    for (let row = startRow; row < 80; row++) {
      if (area.filledAt(col, row)) return area.groundY + row * ts;
    }
    // Nothing solid below the reference height — aiming out over a pit or
    // off the edge of the map. Erupt level with whoever cast it rather than
    // at area.groundY, which is the TOP of the tile grid (i.e. the sky).
    return fromY == null ? area.groundY : fromY;
  }

  /* Ground-follow step for the effects that WALK along the surface (tornado,
     tide surge, sandstorm, the earthquake cracks…), called every tick with
     the surface y they were on last tick.

     groundYAt alone is wrong for these, because it only ever scans DOWNWARD:
     the moment one stepped into a column whose terrain rises — a step, a
     hill, a wall — the tile at its own height was already solid, so the scan
     returned that same height and the effect just carried on at its old y,
     buried inside the rock it should have climbed. So when the reference
     height is inside solid ground, walk UP to the top of that run instead
     and ride over it; only fall through to the downward scan when the
     reference is genuinely in open air (a ledge, a pit).

     `fromY` must be a real surface height — seed it from groundYAt at cast
     time, never 0. Passing 0 makes the row index negative, which clamps to
     row 0 and finds the topmost solid tile in the whole column, i.e. it
     teleports the effect up onto whatever platform happens to be overhead. */
  function groundFollowY(game, x, fromY) {
    const area = game.area;
    const ts = area.tileSize || 64;
    const col = Math.floor(x / ts);
    let row = Math.floor((fromY - area.groundY) / ts);
    if (row < 0) row = 0;

    if (area.filledAt(col, row)) {
      while (row > 0 && area.filledAt(col, row - 1)) row--;
      return area.groundY + row * ts;
    }
    for (; row < 80; row++) {
      if (area.filledAt(col, row)) return area.groundY + row * ts;
    }
    return fromY;
  }

  /* Damage everything inside a circle. `falloff:false` for effects that
     should hit equally hard anywhere inside their area. */
  function hitCircle(game, caster, x, y, radius, damage, info, falloff) {
    const list = targetsOf(game, caster);
    let hits = 0;
    for (const e of list) {
      if (!e.alive) continue;
      const d = U.dist(x, y, U.cx(e), U.cy(e));
      if (d > radius + Math.max(e.w, e.h) * 0.35) continue;
      const f = falloff === false ? 1 : U.clamp(1 - d / (radius * 1.5), 0.4, 1);
      const ang = Math.atan2(U.cy(e) - y, U.cx(e) - x);
      const payload = Object.assign({
        x: U.cx(e), y: U.cy(e), colors: colorsOf(caster), source: caster,
        dirX: Math.cos(ang), dirY: Math.sin(ang)
      }, info || {});
      game.combat.applyDamage(e, damage * f, payload);
      hits++;
    }
    return hits;
  }

  /* Damage everything overlapping an axis-aligned box. */
  function hitRect(game, caster, x, y, w, h, damage, info) {
    const box = { x: x, y: y, w: w, h: h };
    const list = targetsOf(game, caster);
    let hits = 0;
    for (const e of list) {
      if (!e.alive || !U.aabb(box, e)) continue;
      const payload = Object.assign({
        x: U.cx(e), y: U.cy(e), colors: colorsOf(caster), source: caster,
        dirX: U.sign(U.cx(e) - (x + w / 2)) || 1, dirY: -0.2
      }, info || {});
      game.combat.applyDamage(e, damage, payload);
      hits++;
    }
    return hits;
  }

  function telegraph(game, caster, x, y, w, h, time, onDone) {
    game.addTelegraph({ x: x, y: y, w: w, h: h, time: time, colors: colorsOf(caster), onDone: onDone });
  }

  /* Common scaffolding for the self-running ability entities (clouds,
     tornadoes, drifting orbs, decoys…). `tick`/`draw` are the per-summon
     parts; lifetime bookkeeping is handled here. */
  function summon(game, spec) {
    const s = Object.assign({
      dead: false,
      update(dt, g) {
        this.time -= dt;
        if (this.tick) this.tick(dt, g, this);
        if (this.time <= 0) this.dead = true;
      },
      render(ctx, g) { if (this.draw) this.draw(ctx, this, g); }
    }, spec);
    s.maxTime = s.time;
    return game.addSummon(s);
  }

  /* A dense burst that still reads as fire. Particles are additive by
     default, so dumping a hundred glowing embers on one point just saturates
     to a white blob. Most of these are opaque 'grain' chunks (which keep
     their colour however deep the pile gets) with a dim additive minority for
     the heat, and a little dark smoke on top. */
  function fireBurst(game, x, y, count, c, opts) {
    const o = opts || {};
    const speed = o.speed || [160, 820];
    const gravity = o.gravity == null ? 720 : o.gravity;
    const up = o.up || 0;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = U.rand(speed[0], speed[1]);
      const base = {
        x: x + U.rand(-6, 6), y: y + U.rand(-6, 6),
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - up,
        gravity: gravity
      };
      const roll = Math.random();
      if (roll < 0.55) {
        game.particles.spawn(Object.assign({}, base, {
          size: U.rand(3, 10), life: U.rand(0.3, 0.75),
          color: Math.random() < 0.35 ? c.secondary : c.primary,
          shape: 'grain', spin: U.rand(-14, 14), drag: 0.9
        }));
      } else if (roll < 0.85) {
        game.particles.spawn(Object.assign({}, base, {
          size: U.rand(4, 9), life: U.rand(0.25, 0.6),
          color: c.secondary, shape: 'ember', glow: 0.45, drag: 1.3
        }));
      } else {
        game.particles.spawn(Object.assign({}, base, {
          gravity: gravity * 0.25,
          size: U.rand(7, 15), life: U.rand(0.5, 1.1),
          color: c.dark, shape: 'ember', glow: 0.3, additive: false, drag: 1.5
        }));
      }
    }
  }

  function puff(game, x, y, count, colors, opts) {
    game.particles.burst(x, y, Object.assign({
      count: count, speed: [70, 320], size: [2, 7], life: [0.2, 0.55], shape: 'spark'
    }, opts || {}), colors, 1);
  }

  /* ---- effect implementations ----------------------------------------- */

  const EFFECTS = {

    /* ================================================================ WIND */

    /* Gale Step — a committed rush that damages whatever you pass through. */
    dash(fx, caster, game, aimX, aimY) {
      const a = Math.atan2(aimY - U.cy(caster), aimX - U.cx(caster));
      caster.dash = {
        timer: fx.duration, vx: Math.cos(a) * fx.speed, vy: Math.sin(a) * fx.speed,
        damage: dmgOf(fx, caster), radius: fx.radius || 40, hitIds: {}, colors: colorsOf(caster)
      };
      caster.invulnTime = Math.max(caster.invulnTime, fx.invuln || 0);
      puff(game, U.cx(caster), U.cy(caster), 20, colorsOf(caster), { shape: 'wisp', ring: true });
      return true;
    },

    /* Skyward Column — a standing updraft that holds things in the air.
       Anything caught keeps getting re-lifted for as long as it lasts, so
       it's a way to take a group out of the fight, not a damage button. */
    launchColumn(fx, caster, game, aimX) {
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      const w = fx.width, h = fx.height;
      telegraph(game, caster, aimX, gy - h / 2, w, h, 0.3, () => {
        const c = colorsOf(caster);
        summon(game, {
          x: aimX, y: gy, time: fx.duration, w: w, h: h, tickT: 0,
          tick(dt, g, s) {
            s.tickT -= dt;
            if (s.tickT <= 0) {
              s.tickT = 0.35;
              hitRect(g, caster, s.x - w / 2, gy - h, w, h, dmgOf(fx, caster) * 0.35, {
                launch: fx.lift, colors: c
              });
            }
            for (let i = 0; i < 4; i++) {
              if (Math.random() > dt * 26) continue;
              g.particles.spawn({
                x: s.x + U.rand(-w / 2, w / 2), y: gy - U.rand(0, 20),
                vx: U.rand(-40, 40), vy: -U.rand(320, 720),
                size: U.rand(2, 6), life: U.rand(0.4, 0.8),
                color: Math.random() < 0.5 ? c.secondary : c.primary,
                shape: 'wisp', drag: 0.4
              });
            }
          },
          draw(ctx, s) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const g2 = ctx.createLinearGradient(0, gy, 0, gy - h);
            g2.addColorStop(0, U.rgba(c.primary, 0.30));
            g2.addColorStop(1, U.rgba(c.primary, 0));
            ctx.fillStyle = g2;
            ctx.fillRect(s.x - w / 2, gy - h, w, h);
            ctx.restore();
          }
        });
        game.shake(6, 0.2);
      });
      return true;
    },

    /* Cyclone Blade — flies out, stalls, and comes back to you, so it can
       hit the same line of enemies twice if you place yourself well. */
    boomerang(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const a = Math.atan2(aimY - U.cy(caster), aimX - U.cx(caster));
      summon(game, {
        x: U.cx(caster), y: U.cy(caster), time: fx.duration,
        vx: Math.cos(a) * fx.speed, vy: Math.sin(a) * fx.speed,
        spin: 0, hitIds: {}, returning: false,
        tick(dt, g, s) {
          const half = s.maxTime * 0.42;
          if (!s.returning && s.time <= s.maxTime - half) { s.returning = true; s.hitIds = {}; }
          if (s.returning) {
            // Home back onto the caster, accelerating as it comes.
            const ang = Math.atan2(U.cy(caster) - s.y, U.cx(caster) - s.x);
            const sp = fx.speed * 1.15;
            s.vx = U.damp(s.vx, Math.cos(ang) * sp, 7, dt);
            s.vy = U.damp(s.vy, Math.sin(ang) * sp, 7, dt);
            if (U.dist(s.x, s.y, U.cx(caster), U.cy(caster)) < 34) s.dead = true;
          } else {
            s.vx = U.damp(s.vx, 0, 1.4, dt);
            s.vy = U.damp(s.vy, 0, 1.4, dt);
          }
          s.x += s.vx * dt; s.y += s.vy * dt;
          s.spin += dt * 22;

          for (const e of targetsOf(g, caster)) {
            if (!e.alive || s.hitIds[e.uid]) continue;
            if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > fx.radius + e.w * 0.4) continue;
            s.hitIds[e.uid] = true;
            g.combat.applyDamage(e, dmgOf(fx, caster), {
              x: U.cx(e), y: U.cy(e), colors: c, source: caster,
              knockback: 150, dirX: U.sign(s.vx) || 1, dirY: -0.3
            });
          }
          if (Math.random() < dt * 50) {
            g.particles.spawn({
              x: s.x, y: s.y, vx: U.rand(-40, 40), vy: U.rand(-40, 40),
              size: U.rand(2, 5), life: 0.25, color: c.primary, shape: 'wisp'
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.translate(s.x, s.y);
          ctx.rotate(s.spin);
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = U.rgba(c.secondary, 0.95);
          ctx.lineWidth = 3;
          for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.arc(0, 0, fx.radius * (0.5 + i * 0.25), i * 2, i * 2 + 2.2);
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      return true;
    },

    /* Vacuum — drags everything nearby into your lap. No damage of its own;
       it exists to set up whatever you press next. */
    vacuum(fx, caster, game) {
      const c = colorsOf(caster);
      const cx = U.cx(caster), cy = U.cy(caster);
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const d = U.dist(cx, cy, U.cx(e), U.cy(e));
        if (d > fx.radius || d < 6) continue;
        const ang = Math.atan2(cy - U.cy(e), cx - U.cx(e));
        game.combat.applyDamage(e, dmgOf(fx, caster), {
          x: U.cx(e), y: U.cy(e), colors: c, source: caster,
          knockback: fx.pull, dirX: Math.cos(ang), dirY: 0, slow: 0.3, slowTime: 1.2
        });
      }
      for (let i = 0; i < 60; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = fx.radius * U.rand(0.5, 1);
        game.particles.spawn({
          x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r * 0.8,
          vx: -Math.cos(ang) * 460, vy: -Math.sin(ang) * 380,
          size: U.rand(2, 6), life: U.rand(0.25, 0.5),
          color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'wisp', drag: 0.8
        });
      }
      game.particles.ring(cx, cy, c.secondary, fx.radius * 0.5, 0.4);
      game.shake(5, 0.18);
      return true;
    },

    /* Slipstream — pure movement buff with afterimages. */
    haste(fx, caster, game) {
      caster.addBuff({ id: 'slipstream', time: fx.duration, move: fx.move, fire: fx.fire });
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, trailT: 0,
        tick(dt, g, s) {
          s.trailT -= dt;
          if (s.trailT > 0) return;
          s.trailT = 0.05;
          for (let i = 0; i < 3; i++) {
            g.particles.spawn({
              x: U.cx(caster) + U.rand(-14, 14), y: U.cy(caster) + U.rand(-22, 22),
              vx: -caster.vx * 0.25 + U.rand(-30, 30), vy: U.rand(-20, 20),
              size: U.rand(3, 7), life: U.rand(0.2, 0.4),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'wisp', drag: 2
            });
          }
        }
      });
      game.combat.addNumber(U.cx(caster), caster.y - 12, 'SLIPSTREAM', c.secondary, 18);
      return true;
    },

    /* Wind Wall — a standing barrier that continuously shoves anything that
       tries to come through it. Doesn't block your own shots. */
    pushWall(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      const dir = U.sign(aimX - U.cx(caster)) || caster.facing || 1;
      summon(game, {
        x: aimX, y: gy, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.2;
            hitRect(g, caster, s.x - fx.width / 2, gy - fx.height, fx.width, fx.height,
              dmgOf(fx, caster) * 0.2, { knockback: fx.push, dirX: dir, dirY: -0.25 });
          }
          for (let i = 0; i < 3; i++) {
            if (Math.random() > dt * 30) continue;
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: gy - Math.random() * fx.height,
              vx: dir * U.rand(160, 420), vy: U.rand(-60, 20),
              size: U.rand(2, 5), life: U.rand(0.2, 0.45),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'wisp', drag: 1
            });
          }
        },
        draw(ctx, s) {
          const a = U.clamp(s.time / 0.6, 0, 1);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g2 = ctx.createLinearGradient(s.x - fx.width / 2, 0, s.x + fx.width / 2, 0);
          g2.addColorStop(0, U.rgba(c.primary, 0));
          g2.addColorStop(0.5, U.rgba(c.primary, 0.28 * a));
          g2.addColorStop(1, U.rgba(c.primary, 0));
          ctx.fillStyle = g2;
          ctx.fillRect(s.x - fx.width / 2, gy - fx.height, fx.width, fx.height);
          ctx.restore();
        }
      });
      return true;
    },

    /* Tempest Ring — a ring that grows outward and hits each enemy exactly
       once, as it passes them. Reaches much further than a burst would. */
    expandRing(fx, caster, game) {
      const c = colorsOf(caster);
      const cx = U.cx(caster), cy = U.cy(caster);
      summon(game, {
        x: cx, y: cy, time: fx.duration, r: 0, hitIds: {},
        tick(dt, g, s) {
          const prev = s.r;
          s.r += fx.speed * dt;
          for (const e of targetsOf(g, caster)) {
            if (!e.alive || s.hitIds[e.uid]) continue;
            const d = U.dist(cx, cy, U.cx(e), U.cy(e));
            if (d < prev || d > s.r) continue;
            s.hitIds[e.uid] = true;
            const ang = Math.atan2(U.cy(e) - cy, U.cx(e) - cx);
            g.combat.applyDamage(e, dmgOf(fx, caster), {
              x: U.cx(e), y: U.cy(e), colors: c, source: caster,
              knockback: fx.knockback, dirX: Math.cos(ang), dirY: Math.sin(ang) - 0.4
            });
          }
          for (let i = 0; i < 5; i++) {
            const ang = Math.random() * Math.PI * 2;
            g.particles.spawn({
              x: cx + Math.cos(ang) * s.r, y: cy + Math.sin(ang) * s.r * 0.85,
              vx: Math.cos(ang) * 120, vy: Math.sin(ang) * 90,
              size: U.rand(2, 6), life: 0.3, color: c.secondary, shape: 'wisp'
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = U.rgba(c.secondary, U.clamp(s.time / s.maxTime, 0, 1) * 0.9);
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.ellipse(cx, cy, s.r, s.r * 0.85, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      });
      game.shake(9, 0.25);
      PF.Audio.explode();
      return true;
    },

    /* Gale Force — a flat horizontal shove down a wide lane. Barely hurts;
       it moves everything a very long way. */
    gustLine(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const dir = U.sign(aimX - U.cx(caster)) || caster.facing || 1;
      const x = dir > 0 ? U.cx(caster) : U.cx(caster) - fx.length;
      const y = U.cy(caster) - fx.height / 2;
      hitRect(game, caster, x, y, fx.length, fx.height, dmgOf(fx, caster), {
        knockback: fx.push, dirX: dir, dirY: -0.5, slow: 0.2, slowTime: 1
      });
      for (let i = 0; i < 90; i++) {
        const px = U.cx(caster) + dir * U.rand(0, fx.length);
        game.particles.spawn({
          x: px, y: y + Math.random() * fx.height,
          vx: dir * U.rand(500, 1100), vy: U.rand(-50, 50),
          size: U.rand(2, 6), life: U.rand(0.2, 0.5),
          color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'wisp', drag: 0.7
        });
      }
      game.shake(7, 0.2);
      return true;
    },

    /* Tornado — walks across the ground on its own, dragging whatever it
       touches along with it. */
    tornado(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const dir = U.sign(aimX - U.cx(caster)) || 1;
      const startX = U.cx(caster) + dir * 40;
      summon(game, {
        x: startX, y: groundYAt(game, startX, caster.y + caster.h),
        time: fx.duration, tickT: 0, phase: 0,
        tick(dt, g, s) {
          s.x += dir * fx.speed * dt;
          s.y = groundFollowY(g, s.x, s.y);
          s.phase += dt * 8;
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.22;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              // X-only used to mean a mob standing on a totally different
              // platform, far above or below, still got caught the instant
              // its X lined up with the funnel. Bound it to the funnel's own
              // drawn height (it reaches from the ground up) so it only
              // catches what's actually inside the twister.
              if (Math.abs(U.cx(e) - s.x) > fx.radius) continue;
              if (U.cy(e) < s.y - fx.height || U.cy(e) > s.y + 40) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.3, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                knockback: 90, dirX: dir, dirY: -0.2, launch: fx.lift
              });
            }
          }
          for (let i = 0; i < 6; i++) {
            if (Math.random() > dt * 40) continue;
            const t = Math.random();
            const rr = fx.radius * (0.25 + t * 0.85);
            const ang = s.phase + t * 9;
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y - t * fx.height,
              vx: -Math.sin(ang) * 320, vy: -U.rand(60, 200),
              size: U.rand(2, 6), life: U.rand(0.25, 0.5),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'wisp', drag: 1
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = U.rgba(c.primary, 0.5);
          ctx.lineWidth = 3;
          for (let i = 0; i < 7; i++) {
            const t = i / 7;
            const rr = fx.radius * (0.22 + t * 0.9);
            ctx.beginPath();
            ctx.ellipse(s.x + Math.sin(s.phase + i) * 8, s.y - t * fx.height, rr, rr * 0.3, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      return true;
    },

    /* Hurricane (ultimate) — the whole screen becomes weather. Sustained
       damage plus constant displacement for everything in view. */
    hurricane(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          const sweep = Math.sin(g.time * 2.2);
          if (s.tickT <= 0) {
            s.tickT = 0.25;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              // "the whole battlefield becomes weather" means everywhere
              // around you, not literally any height at all — an X-only
              // check let this reach a mob standing on a completely
              // separate platform far overhead. Bounded to roughly the same
              // vertical spread the storm's own particles actually cover.
              if (Math.abs(U.cx(e) - U.cx(caster)) > fx.radius) continue;
              if (Math.abs(U.cy(e) - U.cy(caster)) > 400) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.28, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                knockback: 220, dirX: sweep > 0 ? 1 : -1, dirY: -0.4, launch: 120
              });
            }
          }
          for (let i = 0; i < 14; i++) {
            g.particles.spawn({
              x: U.cx(caster) + U.rand(-fx.radius, fx.radius),
              y: U.cy(caster) + U.rand(-360, 240),
              vx: sweep * U.rand(500, 1300), vy: U.rand(-120, 120),
              size: U.rand(2, 7), life: U.rand(0.25, 0.6),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'wisp', drag: 0.4
            });
          }
          if (Math.random() < dt * 6) g.shake(6, 0.2);
        }
      });
      game.shake(14, 0.5);
      PF.Audio.explode();
      return true;
    },

    /* =============================================================== WATER */

    /* Hydro Jet — a short, wide, instant pressure blast straight ahead. */
    jetStream(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox);
      const steps = 12;
      const hit = {};
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = ox + Math.cos(ang) * fx.length * t;
        const py = oy + Math.sin(ang) * fx.length * t;
        for (const e of targetsOf(game, caster)) {
          if (!e.alive || hit[e.uid]) continue;
          if (U.dist(px, py, U.cx(e), U.cy(e)) > fx.width) continue;
          hit[e.uid] = true;
          game.combat.applyDamage(e, dmgOf(fx, caster), {
            x: U.cx(e), y: U.cy(e), colors: c, source: caster,
            knockback: fx.push, dirX: Math.cos(ang), dirY: Math.sin(ang) - 0.2
          });
        }
        for (let k = 0; k < 5; k++) {
          game.particles.spawn({
            x: px + U.rand(-10, 10), y: py + U.rand(-10, 10),
            vx: Math.cos(ang) * U.rand(300, 700), vy: Math.sin(ang) * U.rand(300, 700) + U.rand(-40, 40),
            size: U.rand(2, 6), life: U.rand(0.15, 0.4),
            color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', drag: 2
          });
        }
      }
      game.shake(5, 0.15);
      return true;
    },

    heal(fx, caster, game) {
      const total = caster.stats.maxHp * fx.amount;
      caster.regen = { rate: total / fx.duration, time: fx.duration };
      puff(game, U.cx(caster), U.cy(caster), 22, colorsOf(caster), { shape: 'drop', ring: true, gravity: -60 });
      return true;
    },

    /* Bubble Trap — takes ONE enemy out of the fight completely: lifted off
       the ground, held, and stunned until the bubble pops. */
    bubbleLock(fx, caster, game, aimX, aimY) {
      let best = null, bestD = fx.range;
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const d = U.dist(aimX, aimY, U.cx(e), U.cy(e));
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) return false;

      const c = colorsOf(caster);
      best.applyStun(fx.duration);
      best.launch(fx.lift);
      game.combat.applyDamage(best, dmgOf(fx, caster), {
        x: U.cx(best), y: U.cy(best), colors: c, source: caster, vuln: 1.35, vulnTime: fx.duration
      });
      summon(game, {
        x: 0, y: 0, time: fx.duration, target: best,
        tick(dt, g, s) {
          if (!s.target.alive) { s.dead = true; return; }
          s.x = U.cx(s.target); s.y = U.cy(s.target);
          if (Math.random() < dt * 24) {
            g.particles.spawn({
              x: s.x + U.rand(-18, 18), y: s.y + U.rand(-18, 18),
              vx: U.rand(-20, 20), vy: -U.rand(20, 70),
              size: U.rand(2, 5), life: 0.4, color: c.secondary, shape: 'drop'
            });
          }
        },
        draw(ctx, s) {
          const r = Math.max(s.target.w, s.target.h) * 0.75;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = U.rgba(c.secondary, 0.8);
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + Math.sin(s.time * 8) * 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = U.rgba(c.primary, 0.16);
          ctx.fill();
          ctx.restore();
        }
      });
      PF.Audio.hit();
      return true;
    },

    /* Tide Surge — a wave that rolls along the floor away from you, hitting
       each enemy once and carrying it forward. */
    groundWave(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const dir = U.sign(aimX - U.cx(caster)) || caster.facing || 1;
      summon(game, {
        x: U.cx(caster), y: groundYAt(game, U.cx(caster), caster.y + caster.h),
        time: fx.duration, hitIds: {},
        tick(dt, g, s) {
          s.x += dir * fx.speed * dt;
          s.y = groundFollowY(g, s.x, s.y);
          for (const e of targetsOf(g, caster)) {
            if (!e.alive || s.hitIds[e.uid]) continue;
            if (Math.abs(U.cx(e) - s.x) > fx.width * 0.5) continue;
            // Only checked how far ABOVE the wave's surface a target could
            // be — nothing stopped it reaching something standing far BELOW
            // (a lower ledge, a pit) the instant its X lined up, which read
            // as "hits anything at this X no matter how far down". A wave
            // rolling across the ground shouldn't reach that far under it.
            if (U.cy(e) < s.y - fx.height * 1.4 || U.cy(e) > s.y + 60) continue;
            s.hitIds[e.uid] = true;
            g.combat.applyDamage(e, dmgOf(fx, caster), {
              x: U.cx(e), y: U.cy(e), colors: c, source: caster,
              knockback: fx.push, dirX: dir, dirY: -0.5, slow: 0.25, slowTime: 1.5
            });
          }
          for (let i = 0; i < 8; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2),
              y: s.y - Math.random() * fx.height,
              vx: dir * U.rand(120, 460), vy: -U.rand(40, 260),
              size: U.rand(3, 8), life: U.rand(0.25, 0.55),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', gravity: 420
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g2 = ctx.createLinearGradient(0, s.y, 0, s.y - fx.height);
          g2.addColorStop(0, U.rgba(c.primary, 0.55));
          g2.addColorStop(1, U.rgba(c.secondary, 0));
          ctx.fillStyle = g2;
          ctx.beginPath();
          ctx.ellipse(s.x, s.y - fx.height * 0.4, fx.width * 0.5, fx.height * 0.6, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      return true;
    },

    /* Whirlpool — a fixed drain that keeps pulling things toward its centre
       and holds them there, slowed. */
    whirlpool(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      const cy = Math.min(aimY, gy - 20);
      summon(game, {
        x: aimX, y: cy, time: fx.duration, tickT: 0, phase: 0,
        tick(dt, g, s) {
          s.phase += dt * 5;
          s.tickT -= dt;
          const pull = s.tickT <= 0;
          if (pull) s.tickT = 0.25;
          for (const e of targetsOf(g, caster)) {
            if (!e.alive) continue;
            const d = U.dist(s.x, s.y, U.cx(e), U.cy(e));
            if (d > fx.radius) continue;
            const ang = Math.atan2(s.y - U.cy(e), s.x - U.cx(e));
            if (pull) {
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.3, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                knockback: fx.pull, dirX: Math.cos(ang), dirY: 0,
                slow: fx.slow, slowTime: 0.6
              });
            }
          }
          for (let i = 0; i < 6; i++) {
            const ang = s.phase + Math.random() * 6.28;
            const rr = fx.radius * U.rand(0.3, 1);
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y + Math.sin(ang) * rr * 0.5,
              vx: -Math.cos(ang) * 260 - Math.sin(ang) * 200,
              vy: (-Math.sin(ang) * 160 + Math.cos(ang) * 140) * 0.5,
              size: U.rand(2, 6), life: U.rand(0.2, 0.45),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', drag: 1.4
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = U.rgba(c.secondary, 0.5);
          ctx.lineWidth = 2;
          for (let i = 0; i < 4; i++) {
            const rr = fx.radius * (0.3 + i * 0.22);
            ctx.beginPath();
            ctx.ellipse(s.x, s.y, rr, rr * 0.45, s.phase * 0.4 + i, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      return true;
    },

    shield(fx, caster, game) {
      const amount = Math.round(caster.stats.maxHp * fx.amount);
      caster.shield = { amount: amount, max: amount, time: fx.duration };
      caster.addBuff({ id: 'aqua_shield', time: fx.duration, taken: fx.taken || 1 });
      puff(game, U.cx(caster), U.cy(caster), 22, colorsOf(caster), { shape: 'drop', ring: true });
      game.combat.addNumber(U.cx(caster), caster.y - 10, '+' + amount + ' SHIELD', colorsOf(caster).secondary, 18);
      return true;
    },

    /* Pressure Cutter — an instant hairline cut across a long line. Ignores
       everything about positioning except the angle you aimed it at. */
    pressureCut(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox);
      const ex = ox + Math.cos(ang) * fx.length, ey = oy + Math.sin(ang) * fx.length;
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        // Perpendicular distance from the enemy to the cut line.
        const vx = ex - ox, vy = ey - oy;
        const len2 = vx * vx + vy * vy;
        const t = U.clamp(((U.cx(e) - ox) * vx + (U.cy(e) - oy) * vy) / len2, 0, 1);
        const px = ox + vx * t, py = oy + vy * t;
        if (U.dist(px, py, U.cx(e), U.cy(e)) > fx.width) continue;
        game.combat.applyDamage(e, dmgOf(fx, caster), {
          x: U.cx(e), y: U.cy(e), colors: c, source: caster,
          knockback: 90, dirX: Math.cos(ang), dirY: Math.sin(ang), vuln: 1.2, vulnTime: 2.5
        });
      }
      for (let i = 0; i < 70; i++) {
        const t = Math.random();
        game.particles.spawn({
          x: ox + (ex - ox) * t + U.rand(-4, 4), y: oy + (ey - oy) * t + U.rand(-4, 4),
          vx: U.rand(-70, 70), vy: U.rand(-70, 70),
          size: U.rand(1, 4), life: U.rand(0.12, 0.35),
          color: c.secondary, shape: 'drop', drag: 3
        });
      }
      game.addBolt(ox, oy, ex, ey, c);
      game.shake(6, 0.15);
      return true;
    },

    /* Drowning Mist — heavy slow plus a suffocating tick. Enemies inside
       barely move; it does not knock them anywhere. */
    drownMist(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      game.addField({
        x: aimX, y: aimY, radius: fx.radius, time: fx.duration, maxTime: fx.duration,
        slow: fx.slow, dps: dmgOf(fx, caster), tick: 0.4, timer: 0,
        team: caster.team, colors: c, owner: caster
      });
      summon(game, {
        x: aimX, y: aimY, time: fx.duration,
        tick(dt, g, s) {
          for (let i = 0; i < 5; i++) {
            if (Math.random() > dt * 30) continue;
            const ang = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(Math.random()) * fx.radius;
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y + Math.sin(ang) * rr * 0.6,
              vx: U.rand(-30, 30), vy: U.rand(-26, 10),
              size: U.rand(4, 10), life: U.rand(0.5, 1.1),
              color: c.primary, shape: 'ember', glow: 0.3, drag: 1
            });
          }
        }
      });
      game.particles.ring(aimX, aimY, c.secondary, fx.radius * 0.35, 0.5);
      return true;
    },

    /* Tsunami — a full-height wall of water that crosses the entire view
       from the side you aimed at. */
    screenSweep(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const dir = U.sign(aimX - U.cx(caster)) || 1;
      const startX = U.cx(caster) - dir * U.GW * 0.55;
      summon(game, {
        x: startX, y: groundYAt(game, startX, caster.y + caster.h),
        time: fx.duration, hitIds: {},
        tick(dt, g, s) {
          s.x += dir * fx.speed * dt;
          s.y = groundFollowY(g, s.x, s.y);
          for (const e of targetsOf(g, caster)) {
            if (!e.alive || s.hitIds[e.uid]) continue;
            if (Math.abs(U.cx(e) - s.x) > fx.width * 0.5) continue;
            // Tall as this wall of water is, it still only reaches as high as
            // it's actually drawn (fx.height up off the ground it's rolling
            // over) — an X-only check swept anything sharing its column, on
            // a platform far overhead or down a pit well below it.
            if (U.cy(e) < s.y - fx.height || U.cy(e) > s.y + 60) continue;
            s.hitIds[e.uid] = true;
            g.combat.applyDamage(e, dmgOf(fx, caster), {
              x: U.cx(e), y: U.cy(e), colors: c, source: caster,
              knockback: fx.push, dirX: dir, dirY: -0.6, launch: 220, slow: 0.3, slowTime: 2
            });
          }
          for (let i = 0; i < 16; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2),
              y: s.y - Math.random() * fx.height,
              vx: dir * U.rand(200, 700), vy: -U.rand(60, 420),
              size: U.rand(3, 9), life: U.rand(0.3, 0.7),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', gravity: 520
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g2 = ctx.createLinearGradient(0, s.y, 0, s.y - fx.height);
          g2.addColorStop(0, U.rgba(c.primary, 0.6));
          g2.addColorStop(0.6, U.rgba(c.primary, 0.28));
          g2.addColorStop(1, U.rgba(c.secondary, 0));
          ctx.fillStyle = g2;
          ctx.fillRect(s.x - fx.width / 2, s.y - fx.height, fx.width, fx.height);
          ctx.restore();
        }
      });
      game.shake(11, 0.4);
      return true;
    },

    /* Healing Spring — a fixed point that mends you while it corrodes them.
       The only ability in the game that does both at once. */
    fountain(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      summon(game, {
        x: aimX, y: gy, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.5;
            if (U.dist(s.x, s.y, U.cx(caster), U.cy(caster)) < fx.radius) {
              const healed = caster.heal(caster.stats.maxHp * fx.healFrac);
              if (healed > 1) g.combat.addNumber(U.cx(caster), caster.y - 6, '+' + Math.round(healed), [120, 255, 190], 17);
            }
            hitCircle(g, caster, s.x, s.y - 20, fx.radius, dmgOf(fx, caster) * 0.4, { slow: 0.2, slowTime: 1 });
          }
          for (let i = 0; i < 4; i++) {
            if (Math.random() > dt * 40) continue;
            g.particles.spawn({
              x: s.x + U.rand(-10, 10), y: s.y,
              vx: U.rand(-90, 90), vy: -U.rand(260, 520),
              size: U.rand(2, 6), life: U.rand(0.5, 0.9),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', gravity: 620
            });
          }
        },
        draw() {
          // Deliberately draws nothing: the spouting particles above already
          // show where this is. The dashed ground ellipse that used to ring
          // it read as a range/targeting overlay.
        }
      });
      return true;
    },

    /* Maelstrom (ultimate) — everything around you is dragged into a
       grinding rotation that will not let go. */
    maelstrom(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0, phase: 0,
        tick(dt, g, s) {
          s.x = U.cx(caster); s.y = U.cy(caster);
          s.phase += dt * 7;
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.2;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              const d = U.dist(s.x, s.y, U.cx(e), U.cy(e));
              if (d > fx.radius) continue;
              const ang = Math.atan2(s.y - U.cy(e), s.x - U.cx(e));
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.3, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                knockback: 200, dirX: Math.cos(ang + 1.2), dirY: Math.sin(ang + 1.2) * 0.4,
                slow: 0.5, slowTime: 0.8
              });
            }
          }
          for (let i = 0; i < 12; i++) {
            const ang = s.phase + Math.random() * 6.28;
            const rr = fx.radius * U.rand(0.25, 1);
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y + Math.sin(ang) * rr * 0.6,
              vx: -Math.sin(ang) * 460, vy: Math.cos(ang) * 300,
              size: U.rand(3, 8), life: U.rand(0.25, 0.55),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', drag: 1.1
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = U.rgba(c.primary, 0.4);
          ctx.lineWidth = 4;
          for (let i = 0; i < 5; i++) {
            ctx.beginPath();
            ctx.ellipse(s.x, s.y, fx.radius * (0.3 + i * 0.18), fx.radius * (0.15 + i * 0.1),
              s.phase * 0.5 + i, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      });
      game.shake(12, 0.4);
      PF.Audio.explode();
      return true;
    },

    /* ================================================================ FIRE */

    /* Lava Geyser — the ground splits where you aimed and throws a column of
       molten rock up, hurling anything standing there and leaving it burning.
       Deliberately the loudest low-level ability in the game. */
    groundEruption(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - fx.height / 2, fx.width, fx.height, fx.windup, () => {
        hitRect(game, caster, aimX - fx.width / 2, gy - fx.height, fx.width, fx.height,
          dmgOf(fx, caster), { launch: fx.lift, burn: dmgOf(fx, caster) * 0.25, burnTime: fx.burnTime, colors: c });

        /* The eruption itself — a few hundred particles fed out over the
           lifetime rather than dumped in one frame.

           The mix matters more than the count here. Particles are additive by
           default, so a few hundred glowing embers stacked in one column just
           saturate to a white cloud and stop reading as fire at all. So the
           bulk is opaque 'grain' chunks (which force source-over and keep
           their colour no matter how deep the pile gets) — molten rock thrown
           out of the ground — with a minority of additive embers for the heat
           haze and a few dark ones on top for smoke. */
        game.addSpawner(fx.duration, fx.bursts, function () {
          for (let i = 0; i < 26; i++) {
            const roll = Math.random();
            const spread = fx.width * 0.46;
            const common = {
              x: aimX + U.rand(-spread, spread),
              y: gy - U.rand(0, 16),
              vx: U.rand(-230, 230),
              vy: -U.rand(420, 1220),
              gravity: 980
            };
            if (roll < 0.58) {
              // Molten rock. Opaque, tumbling, falls back down.
              game.particles.spawn(Object.assign({}, common, {
                size: U.rand(3, 10), life: U.rand(0.5, 1.15),
                color: Math.random() < 0.35 ? c.secondary : c.primary,
                shape: 'grain', spin: U.rand(-14, 14), drag: 0.2
              }));
            } else if (roll < 0.86) {
              // Heat. Additive, but dim enough not to wash the chunks out.
              game.particles.spawn(Object.assign({}, common, {
                size: U.rand(4, 9), life: U.rand(0.35, 0.75),
                color: c.secondary, shape: 'ember', glow: 0.45, drag: 0.6
              }));
            } else {
              // Smoke off the top of the plume.
              game.particles.spawn(Object.assign({}, common, {
                vy: -U.rand(300, 700), gravity: 180,
                size: U.rand(7, 16), life: U.rand(0.7, 1.4),
                color: c.dark, shape: 'ember', glow: 0.32,
                additive: false, drag: 1.1
              }));
            }
          }
        });
        // Lingering scorched ground.
        game.addField({
          x: aimX, y: gy - 16, radius: fx.width * 0.55, time: fx.burnTime, maxTime: fx.burnTime,
          dps: dmgOf(fx, caster) * 0.25, tick: 0.4, timer: 0,
          team: caster.team, colors: c, owner: caster
        });
        game.particles.flash(aimX, gy - 30, c.primary, fx.width, 0.3);
        game.shake(13, 0.4);
        PF.Audio.explode();
      });
      return true;
    },

    /* Flame Cone — a wide close-range spray that sets everything alight. */
    flameCone(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox);
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const d = U.dist(ox, oy, U.cx(e), U.cy(e));
        if (d > fx.length) continue;
        let diff = Math.atan2(U.cy(e) - oy, U.cx(e) - ox) - ang;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        if (Math.abs(diff) > fx.spread) continue;
        game.combat.applyDamage(e, dmgOf(fx, caster), {
          x: U.cx(e), y: U.cy(e), colors: c, source: caster,
          knockback: 120, dirX: Math.cos(ang), dirY: Math.sin(ang),
          burn: dmgOf(fx, caster) * 0.3, burnTime: fx.burnTime
        });
      }
      for (let i = 0; i < 110; i++) {
        const a2 = ang + U.rand(-fx.spread, fx.spread);
        const sp = U.rand(220, fx.length * 2.4);
        game.particles.spawn({
          x: ox + Math.cos(a2) * 18, y: oy + Math.sin(a2) * 18,
          vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp - 40,
          size: U.rand(3, 9), life: U.rand(0.25, 0.6),
          color: Math.random() < 0.45 ? c.secondary : c.primary,
          shape: 'ember', drag: 1.6, glow: 0.9
        });
      }
      game.shake(6, 0.2);
      return true;
    },

    /* Meteor — falls from off-screen onto the marked spot and leaves a
       burning crater behind. */
    skyStrike(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      // The rock is visibly falling for the whole wind-up, so the target box
      // isn't the only warning you get.
      summon(game, {
        x: aimX + 200, y: gy - 900, time: fx.windup,
        tick(dt, g, s) {
          const t = 1 - U.clamp(s.time / fx.windup, 0, 1);
          s.x = aimX + 200 * (1 - t);
          s.y = gy - 900 * (1 - t) - 30;
          for (let i = 0; i < 3; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-14, 14), y: s.y + U.rand(-14, 14),
              vx: U.rand(-60, 60) + 180, vy: U.rand(-60, 60) - 320,
              size: U.rand(4, 11), life: U.rand(0.2, 0.45),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'ember', glow: 1
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 34);
          gr.addColorStop(0, U.rgba(c.secondary, 0.95));
          gr.addColorStop(1, U.rgba(c.primary, 0));
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 34, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      telegraph(game, caster, aimX, gy - fx.radius * 0.6, fx.radius * 2, fx.radius * 1.2, fx.windup, () => {
        hitCircle(game, caster, aimX, gy - 20, fx.radius, dmgOf(fx, caster), {
          knockback: fx.knockback, burn: dmgOf(fx, caster) * 0.2, burnTime: fx.burnTime, colors: c
        });
        game.addField({
          x: aimX, y: gy - 14, radius: fx.radius * 0.8, time: fx.craterTime, maxTime: fx.craterTime,
          dps: dmgOf(fx, caster) * 0.22, tick: 0.4, timer: 0,
          team: caster.team, colors: c, owner: caster
        });
        fireBurst(game, aimX, gy - 16, 100, c, { speed: [120, 720], up: 260, gravity: 760 });
        game.particles.flash(aimX, gy - 20, c.primary, fx.radius * 2, 0.28);
        game.particles.ring(aimX, gy - 20, c.secondary, fx.radius * 0.5, 0.5);
        game.shake(15, 0.42);
        PF.Audio.explode();
      });
      return true;
    },

    /* Immolation — you become the hazard. Nothing can stand next to you. */
    immolation(fx, caster, game) {
      const c = colorsOf(caster);
      caster.aura = {
        time: fx.duration, maxTime: fx.duration, radius: fx.radius,
        dps: dmgOf(fx, caster), tick: 0.25, timer: 0,
        knockback: 30, slow: 0, colors: c, shape: 'ember'
      };
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              if (U.dist(U.cx(caster), U.cy(caster), U.cx(e), U.cy(e)) > fx.radius) continue;
              e.applyBurn(dmgOf(fx, caster) * 0.35, 2.5, c);
            }
          }
          for (let i = 0; i < 6; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rr = fx.radius * U.rand(0.2, 1);
            g.particles.spawn({
              x: U.cx(caster) + Math.cos(ang) * rr, y: U.cy(caster) + Math.sin(ang) * rr * 0.8,
              vx: U.rand(-40, 40), vy: -U.rand(120, 320),
              size: U.rand(3, 8), life: U.rand(0.3, 0.6),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'ember', glow: 0.9
            });
          }
        }
      });
      return true;
    },

    /* Backdraft — sucks everything in, holds a beat, then detonates. The
       pull and the blast are one ability, so positioning IS the damage. */
    backdraft(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      const cx = aimX, cy = gy - 40;
      telegraph(game, caster, cx, cy, fx.radius * 2, fx.radius * 1.6, fx.windup, () => {
        hitCircle(game, caster, cx, cy, fx.radius, dmgOf(fx, caster), {
          knockback: fx.knockback, burn: dmgOf(fx, caster) * 0.3, burnTime: fx.burnTime, colors: c
        }, false);
        fireBurst(game, cx, cy, 130, c, { speed: [200, 900], gravity: 380 });
        game.particles.flash(cx, cy, c.primary, fx.radius * 2.2, 0.3);
        game.shake(14, 0.4);
        PF.Audio.explode();
      });
      // The inhale, while the telegraph runs.
      summon(game, {
        x: cx, y: cy, time: fx.windup, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.12;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              const d = U.dist(cx, cy, U.cx(e), U.cy(e));
              if (d > fx.pullRadius || d < 8) continue;
              const ang = Math.atan2(cy - U.cy(e), cx - U.cx(e));
              e.vx += Math.cos(ang) * fx.pull / (e.weight || 1) * 0.25;
            }
          }
          for (let i = 0; i < 8; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rr = fx.pullRadius * U.rand(0.5, 1);
            g.particles.spawn({
              x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr * 0.7,
              vx: -Math.cos(ang) * 600, vy: -Math.sin(ang) * 500,
              size: U.rand(2, 6), life: 0.3,
              color: c.primary, shape: 'ember', glow: 0.8
            });
          }
        }
      });
      return true;
    },

    /* Fire Chain — burning arcs that hop outward from the first thing hit,
       spreading the burn rather than the raw damage. */
    fireChain(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      let src = null, bestD = fx.range;
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const d = U.dist(aimX, aimY, U.cx(e), U.cy(e));
        if (d < bestD) { bestD = d; src = e; }
      }
      if (!src) return false;

      const used = {};
      let cur = src, from = { x: U.cx(caster), y: U.cy(caster) };
      let dmg = dmgOf(fx, caster);
      for (let jump = 0; jump <= fx.jumps && cur; jump++) {
        used[cur.uid] = true;
        game.addBolt(from.x, from.y, U.cx(cur), U.cy(cur), c);
        game.combat.applyDamage(cur, dmg, {
          x: U.cx(cur), y: U.cy(cur), colors: c, source: caster,
          burn: dmg * 0.4, burnTime: fx.burnTime
        });
        puff(game, U.cx(cur), U.cy(cur), 20, c, { shape: 'ember', gravity: -60, flash: true });
        from = { x: U.cx(cur), y: U.cy(cur) };
        dmg *= fx.falloff;
        let next = null, nd = fx.jumpRange;
        for (const e of targetsOf(game, caster)) {
          if (!e.alive || used[e.uid]) continue;
          const d = U.dist(from.x, from.y, U.cx(e), U.cy(e));
          if (d < nd) { nd = d; next = e; }
        }
        cur = next;
      }
      game.shake(7, 0.2);
      return true;
    },

    /* Wall of Flame — a long, thin line of fire on the ground. It doesn't
       block movement; it punishes crossing it. */
    hazardWall(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      summon(game, {
        x: aimX, y: gy, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            hitRect(g, caster, s.x - fx.length / 2, gy - fx.height, fx.length, fx.height,
              dmgOf(fx, caster) * 0.4, { burn: dmgOf(fx, caster) * 0.35, burnTime: fx.burnTime, colors: c });
          }
          for (let i = 0; i < 10; i++) {
            if (Math.random() > dt * 55) continue;
            g.particles.spawn({
              x: s.x + U.rand(-fx.length / 2, fx.length / 2), y: gy - U.rand(0, 8),
              vx: U.rand(-40, 40), vy: -U.rand(140, 460),
              size: U.rand(3, 9), life: U.rand(0.3, 0.7),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'ember', glow: 0.95
            });
          }
        },
        draw(ctx, s) {
          const a = U.clamp(s.time / 0.8, 0, 1);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g2 = ctx.createLinearGradient(0, s.y, 0, s.y - fx.height);
          g2.addColorStop(0, U.rgba(c.primary, 0.5 * a));
          g2.addColorStop(1, U.rgba(c.secondary, 0));
          ctx.fillStyle = g2;
          ctx.fillRect(s.x - fx.length / 2, s.y - fx.height, fx.length, fx.height);
          ctx.restore();
        }
      });
      PF.Audio.explode();
      return true;
    },

    /* Blazing Comet — starts small and slow, ends enormous and fast. The
       further it flies, the harder it lands. */
    growingComet(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox);
      summon(game, {
        x: ox + Math.cos(ang) * 28, y: oy + Math.sin(ang) * 28,
        time: fx.duration, vx: Math.cos(ang) * fx.speed, vy: Math.sin(ang) * fx.speed,
        r: fx.radius, grown: 0,
        tick(dt, g, s) {
          s.grown = 1 - U.clamp(s.time / s.maxTime, 0, 1);
          const boost = 1 + s.grown * fx.accel;
          s.x += s.vx * boost * dt;
          s.y += s.vy * boost * dt;
          s.r = fx.radius * (1 + s.grown * fx.growth);

          for (let i = 0; i < 6; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-s.r, s.r) * 0.5, y: s.y + U.rand(-s.r, s.r) * 0.5,
              vx: -s.vx * 0.12 + U.rand(-60, 60), vy: -s.vy * 0.12 + U.rand(-60, 60),
              size: U.rand(3, 4 + s.r * 0.25), life: U.rand(0.2, 0.5),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'ember', glow: 1
            });
          }

          let boom = s.time <= 0;
          for (const e of targetsOf(g, caster)) {
            if (!e.alive) continue;
            if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > s.r + e.w * 0.4) continue;
            boom = true; break;
          }
          if (g.area.hitsSolid(s.x, s.y, s.r * 0.5)) boom = true;
          if (!boom) return;

          s.dead = true;
          const scale = 1 + s.grown * fx.growth;
          hitCircle(g, caster, s.x, s.y, fx.blast * scale, dmgOf(fx, caster) * scale, {
            knockback: 320, burn: dmgOf(fx, caster) * 0.3, burnTime: fx.burnTime, colors: c
          });
          fireBurst(g, s.x, s.y, 110, c, { speed: [150 * scale, 800 * scale], gravity: 420 });
          g.particles.flash(s.x, s.y, c.primary, fx.blast * 2 * scale, 0.3);
          g.shake(10 + scale * 4, 0.35);
          PF.Audio.explode();
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 2.2);
          gr.addColorStop(0, U.rgba(c.secondary, 0.95));
          gr.addColorStop(0.4, U.rgba(c.primary, 0.6));
          gr.addColorStop(1, U.rgba(c.primary, 0));
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      return true;
    },

    /* Phoenix Dive — you leave the ground entirely, then come down on the
       marked spot. Invulnerable in the air, committed to the landing. */
    diveBomb(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      caster.invulnTime = Math.max(caster.invulnTime, fx.windup + 0.2);
      caster.vy = -fx.rise;
      caster.flying = false;
      telegraph(game, caster, aimX, gy - 40, fx.radius * 2, fx.radius * 1.4, fx.windup, () => {
        caster.x = aimX - caster.w / 2;
        caster.y = gy - caster.h;
        caster.vy = 0;
        hitCircle(game, caster, aimX, gy - 20, fx.radius, dmgOf(fx, caster), {
          knockback: fx.knockback, launch: 260,
          burn: dmgOf(fx, caster) * 0.3, burnTime: fx.burnTime, colors: c
        });
        game.addField({
          x: aimX, y: gy - 14, radius: fx.radius * 0.7, time: fx.burnTime, maxTime: fx.burnTime,
          dps: dmgOf(fx, caster) * 0.25, tick: 0.4, timer: 0,
          team: caster.team, colors: c, owner: caster
        });
        fireBurst(game, aimX, gy - 14, 150, c, { speed: [180, 900], up: 200, gravity: 680 });
        game.particles.flash(aimX, gy - 20, c.primary, fx.radius * 2.4, 0.35);
        game.shake(18, 0.5);
        PF.Audio.explode();
      });
      return true;
    },

    /* Inferno (ultimate) — a standing firestorm centred on you that keeps
       re-igniting everything for its whole duration. */
    inferno(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.x = U.cx(caster); s.y = U.cy(caster);
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.25;
            hitCircle(g, caster, s.x, s.y, fx.radius, dmgOf(fx, caster) * 0.3, {
              burn: dmgOf(fx, caster) * 0.4, burnTime: 3, knockback: 40, colors: c
            }, false);
          }
          for (let i = 0; i < 18; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rr = fx.radius * Math.sqrt(Math.random());
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y + Math.sin(ang) * rr * 0.7,
              vx: U.rand(-70, 70), vy: -U.rand(180, 620),
              size: U.rand(3, 10), life: U.rand(0.3, 0.8),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'ember', glow: 1
            });
          }
          if (Math.random() < dt * 8) g.shake(7, 0.2);
        }
      });
      game.shake(16, 0.5);
      PF.Audio.explode();
      return true;
    },

    /* ================================================================ SAND */

    /* Grit Spray — a short, wide cone of stinging sand. Modest damage; what
       it's really for is caking anything it hits in grit heavy enough to
       bog its next few steps down to a crawl. (This used to be Sand Wall, a
       solid barrier — except mobs never actually check the game's temp-solid
       collision list, only the player does, so the "wall" blocked no one
       but its own caster. Rather than build out mob-side wall collision for
       one ability, it's a cone attack instead — something that works the
       instant you press it, every time.) */
    gritCone(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox);
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const d = U.dist(ox, oy, U.cx(e), U.cy(e));
        if (d > fx.length) continue;
        let diff = Math.atan2(U.cy(e) - oy, U.cx(e) - ox) - ang;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        if (Math.abs(diff) > fx.spread) continue;
        game.combat.applyDamage(e, dmgOf(fx, caster), {
          x: U.cx(e), y: U.cy(e), colors: c, source: caster,
          knockback: 100, dirX: Math.cos(ang), dirY: Math.sin(ang) * 0.3 - 0.15,
          slow: fx.slow, slowTime: fx.slowTime
        });
      }
      for (let i = 0; i < 90; i++) {
        const a2 = ang + U.rand(-fx.spread, fx.spread);
        const sp = U.rand(200, fx.length * 2.2);
        game.particles.spawn({
          x: ox + Math.cos(a2) * 16, y: oy + Math.sin(a2) * 16,
          vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp - 40,
          size: U.rand(2, 6), life: U.rand(0.2, 0.45),
          color: Math.random() < 0.5 ? c.secondary : c.primary,
          shape: 'grain', drag: 1.8, spin: U.rand(-10, 10)
        });
      }
      game.shake(5, 0.15);
      return true;
    },

    /* Quicksand — enemies inside are rooted in place: they can still be hit,
       they just cannot leave. */
    quicksand(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      summon(game, {
        x: aimX, y: gy, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              // A shallow ground pit — X-only used to also catch anything
              // on a platform above it, or below it entirely, the instant
              // their X lined up. Only the ground surface itself is soup.
              if (Math.abs(U.cx(e) - s.x) > fx.radius) continue;
              if (Math.abs(U.cy(e) - gy) > 60) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.25, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                slow: 0.92, slowTime: 0.6, stun: 0.32
              });
            }
          }
          for (let i = 0; i < 4; i++) {
            if (Math.random() > dt * 26) continue;
            g.particles.spawn({
              x: s.x + U.rand(-fx.radius, fx.radius), y: gy - U.rand(0, 6),
              vx: U.rand(-30, 30), vy: -U.rand(20, 90),
              size: U.rand(2, 6), life: U.rand(0.3, 0.7),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', gravity: 260
            });
          }
        },
        draw(ctx, s) {
          const a = U.clamp(s.time / 1.2, 0, 1);
          ctx.save();
          // The sunken sand itself, with no outline ring around it — that
          // ring read as a range/targeting overlay rather than terrain.
          ctx.fillStyle = U.rgba(c.dark, 0.4 * a);
          ctx.beginPath();
          ctx.ellipse(s.x, s.y - 4, fx.radius, 12, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      return true;
    },

    /* Boulder Toss — one heavy arcing rock. Massive knockback and a stun,
       low rate of fire. */
    boulder(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox) - 0.25;
      summon(game, {
        x: ox, y: oy, time: fx.duration, rot: 0,
        vx: Math.cos(ang) * fx.speed, vy: Math.sin(ang) * fx.speed,
        tick(dt, g, s) {
          s.vy += 900 * dt;
          s.x += s.vx * dt; s.y += s.vy * dt;
          s.rot += dt * 9;
          let boom = g.area.hitsSolid(s.x, s.y, fx.radius * 0.6);
          for (const e of targetsOf(g, caster)) {
            if (!e.alive) continue;
            if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > fx.radius + e.w * 0.4) continue;
            boom = true; break;
          }
          if (Math.random() < dt * 40) {
            g.particles.spawn({
              x: s.x, y: s.y, vx: U.rand(-50, 50), vy: U.rand(-50, 50),
              size: U.rand(2, 6), life: 0.3, color: c.dark, shape: 'grain'
            });
          }
          if (!boom && s.time > 0) return;
          s.dead = true;
          hitCircle(g, caster, s.x, s.y, fx.blast, dmgOf(fx, caster), {
            knockback: fx.knockback, stun: fx.stun, launch: 160, colors: c
          });
          for (let i = 0; i < 70; i++) {
            const a2 = Math.random() * Math.PI * 2;
            g.particles.spawn({
              x: s.x, y: s.y, vx: Math.cos(a2) * U.rand(120, 620), vy: Math.sin(a2) * U.rand(120, 500) - 160,
              size: U.rand(3, 9), life: U.rand(0.3, 0.7),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', gravity: 780
            });
          }
          g.shake(13, 0.35);
          PF.Audio.explode();
        },
        draw(ctx, s) {
          ctx.save();
          ctx.translate(s.x, s.y);
          ctx.rotate(s.rot);
          ctx.fillStyle = U.rgb(c.primary);
          U.starPath(ctx, 0, 0, 7, fx.radius, fx.radius * 0.78, 0);
          ctx.fill();
          ctx.strokeStyle = U.rgba(c.dark, 0.9);
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.restore();
        }
      });
      return true;
    },

    /* Burrow — drop under the surface: untouchable and much faster, but you
       surface with a blast wherever you come up. */
    burrow(fx, caster, game) {
      const c = colorsOf(caster);
      caster.burrowTime = fx.duration;
      caster.invulnTime = Math.max(caster.invulnTime, fx.duration);
      caster.addBuff({ id: 'burrow', time: fx.duration, move: fx.move });
      puff(game, U.cx(caster), caster.y + caster.h, 40, c, { shape: 'grain', gravity: 520, ring: true });
      summon(game, {
        x: 0, y: 0, time: fx.duration, erupted: false,
        tick(dt, g, s) {
          // Spray of dirt tracking the player's tunnel.
          if (Math.random() < dt * 50) {
            g.particles.spawn({
              x: U.cx(caster) + U.rand(-12, 12), y: caster.y + caster.h,
              vx: U.rand(-90, 90), vy: -U.rand(40, 180),
              size: U.rand(2, 7), life: U.rand(0.25, 0.5),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', gravity: 500
            });
          }
          if (s.time > 0 || s.erupted) return;
          // Surfacing blast, wherever the tunnel happened to end.
          s.erupted = true;
          hitCircle(g, caster, U.cx(caster), U.cy(caster), fx.blast, dmgOf(fx, caster), {
            knockback: 340, launch: 220, colors: c
          });
          puff(g, U.cx(caster), U.cy(caster), 60, c, { shape: 'grain', gravity: 600, ring: true, flash: true });
          g.shake(11, 0.3);
        }
      });
      return true;
    },

    /* Sandstorm — a rolling cloud that leaves enemies unable to hold a
       direction; they stumble around while it grinds them down. */
    sandstorm(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const dir = U.sign(aimX - U.cx(caster)) || 1;
      const gy0 = groundYAt(game, U.cx(caster), caster.y + caster.h);
      summon(game, {
        // `gy` is the surface the cloud is rolling over; `y` is its own
        // centre, floating above that — they're tracked separately so the
        // ground-follow always gets a real surface height back as its
        // reference, not the raised centre.
        x: U.cx(caster), y: gy0 - fx.height * 0.4, gy: gy0,
        time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.x += dir * fx.speed * dt;
          s.gy = groundFollowY(g, s.x, s.gy);
          s.y = s.gy - fx.height * 0.4;
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > fx.radius) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.3, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster, slow: 0.4, slowTime: 1
              });
              // Blinded: it can't keep a heading.
              if (e.facing !== undefined && Math.random() < 0.5) e.facing = U.chance(0.5) ? 1 : -1;
            }
          }
          for (let i = 0; i < 14; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rr = fx.radius * Math.sqrt(Math.random());
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y + Math.sin(ang) * rr * 0.6,
              vx: dir * U.rand(120, 520), vy: U.rand(-90, 60),
              size: U.rand(2, 7), life: U.rand(0.25, 0.6),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', drag: 0.9
            });
          }
        }
      });
      return true;
    },

    /* Stone Skin — flat damage reduction. Sand's answer to not having an
       escape button. */
    stoneSkin(fx, caster, game) {
      const c = colorsOf(caster);
      caster.addBuff({ id: 'stone_skin', time: fx.duration, taken: fx.taken, move: fx.move });
      puff(game, U.cx(caster), U.cy(caster), 26, c, { shape: 'grain', ring: true });
      game.combat.addNumber(U.cx(caster), caster.y - 12, 'STONE SKIN', c.secondary, 18);
      return true;
    },

    /* Earthquake — a split shockwave that runs along the floor in BOTH
       directions from you, stunning what it reaches. Ground only. */
    earthquake(fx, caster, game) {
      if (!caster.onGround) return false;
      const c = colorsOf(caster);
      const originX = U.cx(caster);
      const originY = groundYAt(game, originX, caster.y + caster.h);
      [-1, 1].forEach((dir) => {
        summon(game, {
          x: originX, y: originY, time: fx.duration, hitIds: {},
          tick(dt, g, s) {
            s.x += dir * fx.speed * dt;
            s.y = groundFollowY(g, s.x, s.y);
            for (const e of targetsOf(g, caster)) {
              if (!e.alive || s.hitIds[e.uid]) continue;
              // A crack running "along the floor" — X-only used to also
              // reach anything on a platform above it, not just what's
              // actually standing on the ground it's cracking.
              if (Math.abs(U.cx(e) - s.x) > 40) continue;
              if (U.cy(e) < s.y - 50 || U.cy(e) > s.y + 50) continue;
              s.hitIds[e.uid] = true;
              g.combat.applyDamage(e, dmgOf(fx, caster), {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                knockback: fx.knockback, dirX: dir, dirY: -0.7,
                launch: fx.launch, stun: fx.stun
              });
            }
            for (let i = 0; i < 5; i++) {
              g.particles.spawn({
                x: s.x + U.rand(-20, 20), y: s.y - U.rand(0, 6),
                vx: U.rand(-90, 90), vy: -U.rand(120, 420),
                size: U.rand(3, 9), life: U.rand(0.25, 0.6),
                color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', gravity: 760
              });
            }
          },
          draw(ctx, s) {
            ctx.save();
            ctx.strokeStyle = U.rgba(c.secondary, U.clamp(s.time / s.maxTime, 0, 1) * 0.8);
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(s.x - dir * 30, s.y);
            ctx.lineTo(s.x, s.y - 26);
            ctx.lineTo(s.x + dir * 30, s.y);
            ctx.stroke();
            ctx.restore();
          }
        });
      });
      game.shake(16, 0.45);
      PF.Audio.explode();
      return true;
    },

    /* Petrify — no damage worth mentioning; it turns a group to stone and
       makes everything you do to them afterwards hurt far more. */
    petrify(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const hits = hitCircle(game, caster, aimX, aimY, fx.radius, dmgOf(fx, caster), {
        stun: fx.duration, vuln: fx.vuln, vulnTime: fx.duration, slow: 0.95, slowTime: fx.duration
      }, false);
      for (let i = 0; i < 70; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = fx.radius * Math.sqrt(Math.random());
        game.particles.spawn({
          x: aimX + Math.cos(ang) * rr, y: aimY + Math.sin(ang) * rr * 0.7,
          vx: U.rand(-60, 60), vy: -U.rand(30, 180),
          size: U.rand(3, 8), life: U.rand(0.3, 0.7),
          color: Math.random() < 0.5 ? c.dark : c.primary, shape: 'grain', gravity: 420
        });
      }
      game.particles.ring(aimX, aimY, c.secondary, fx.radius * 0.4, 0.5);
      if (hits) PF.Audio.hit();
      return true;
    },

    /* Sinkhole — the floor gives way. Anything over it is dragged to the
       centre, held there, and ground down. */
    sinkhole(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - 20, fx.radius * 2, 44, 0.35, () => {
        summon(game, {
          x: aimX, y: gy, time: fx.duration, tickT: 0,
          tick(dt, g, s) {
            s.tickT -= dt;
            if (s.tickT <= 0) {
              s.tickT = 0.28;
              for (const e of targetsOf(g, caster)) {
                if (!e.alive) continue;
                // X-only used to also drag in anything on a platform above
                // the pit, or below it entirely — the collapsing floor only
                // reaches things actually standing near its own surface.
                const d = Math.abs(U.cx(e) - s.x);
                if (d > fx.radius) continue;
                if (Math.abs(U.cy(e) - gy) > 70) continue;
                const dir = U.sign(s.x - U.cx(e)) || 1;
                g.combat.applyDamage(e, dmgOf(fx, caster) * 0.4, {
                  x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                  knockback: fx.pull, dirX: dir, dirY: 0,
                  slow: 0.8, slowTime: 0.6, stun: 0.2
                });
              }
            }
            for (let i = 0; i < 6; i++) {
              if (Math.random() > dt * 40) continue;
              const off = U.rand(-fx.radius, fx.radius);
              g.particles.spawn({
                x: s.x + off, y: gy - U.rand(0, 10),
                vx: -U.sign(off) * U.rand(60, 240), vy: U.rand(20, 120),
                size: U.rand(2, 7), life: U.rand(0.3, 0.6),
                color: Math.random() < 0.5 ? c.dark : c.primary, shape: 'grain'
              });
            }
          },
          draw(ctx, s) {
            const a = U.clamp(s.time / 1, 0, 1);
            ctx.save();
            const gr = ctx.createRadialGradient(s.x, s.y, 4, s.x, s.y, fx.radius);
            gr.addColorStop(0, U.rgba([10, 8, 6], 0.85 * a));
            gr.addColorStop(1, U.rgba(c.dark, 0));
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.ellipse(s.x, s.y, fx.radius, 22, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        });
        game.shake(10, 0.3);
      });
      return true;
    },

    /* Mirage — sand copies of you. Hostiles chase the nearest decoy instead
       of the real thing, then it collapses on them. */
    mirage(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      for (let i = 0; i < fx.count; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        const px = U.cx(caster) + dir * fx.spread * (1 + Math.floor(i / 2));
        const gy = groundYAt(game, px, caster.y + caster.h);
        summon(game, {
          x: px, y: gy, time: fx.duration, phase: Math.random() * 6.28, collapsed: false,
          tick(dt, g, s) {
            s.phase += dt * 3;
            // Keep pulling hostile attention while alive.
            g.taunt = { x: s.x, y: s.y - 30, until: g.time + 0.2 };
            if (Math.random() < dt * 14) {
              g.particles.spawn({
                x: s.x + U.rand(-12, 12), y: s.y - U.rand(0, 50),
                vx: U.rand(-25, 25), vy: -U.rand(20, 70),
                size: U.rand(2, 6), life: 0.4, color: c.primary, shape: 'grain'
              });
            }
            if (s.time > 0 || s.collapsed) return;
            s.collapsed = true;
            hitCircle(g, caster, s.x, s.y - 20, fx.blast, dmgOf(fx, caster), {
              knockback: 260, stun: 0.5, colors: c
            });
            for (let k = 0; k < 60; k++) {
              const a2 = Math.random() * Math.PI * 2;
              g.particles.spawn({
                x: s.x, y: s.y - 24,
                vx: Math.cos(a2) * U.rand(120, 560), vy: Math.sin(a2) * U.rand(90, 400) - 120,
                size: U.rand(3, 8), life: U.rand(0.25, 0.6),
                color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', gravity: 640
              });
            }
            g.shake(8, 0.25);
          },
          draw(ctx, s) {
            ctx.save();
            ctx.globalAlpha = 0.55 + Math.sin(s.phase) * 0.15;
            ctx.fillStyle = U.rgba(c.primary, 0.8);
            ctx.fillRect(s.x - 14, s.y - 62, 28, 62);
            ctx.fillStyle = U.rgba(c.secondary, 0.5);
            ctx.fillRect(s.x - 9, s.y - 58, 18, 22);
            ctx.restore();
          }
        });
      }
      return true;
    },

    /* Desert's Wrath (ultimate) — the entire view becomes a burial. */
    desertWrath(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.x = U.cx(caster); s.y = U.cy(caster);
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              // X-only used to reach a mob on a totally different platform
              // far above/below the second their X lined up. Bounded to
              // roughly the same vertical spread its own burial particles
              // actually cover around you.
              if (Math.abs(U.cx(e) - s.x) > fx.radius) continue;
              if (Math.abs(U.cy(e) - s.y) > 380) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.35, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                stun: 0.4, slow: 0.7, slowTime: 1, vuln: 1.3, vulnTime: 1.5
              });
            }
          }
          for (let i = 0; i < 22; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.radius, fx.radius), y: s.y + U.rand(-320, 220),
              vx: U.rand(-700, 700), vy: U.rand(-160, 160),
              size: U.rand(2, 9), life: U.rand(0.25, 0.7),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'grain', drag: 0.5
            });
          }
          if (Math.random() < dt * 7) g.shake(8, 0.25);
        }
      });
      game.shake(18, 0.6);
      PF.Audio.explode();
      return true;
    },

    /* =========================================================== LIGHTNING */

    blink(fx, caster, game, aimX, aimY) {
      const sx = U.cx(caster), sy = U.cy(caster);
      const a = Math.atan2(aimY - sy, aimX - sx);
      const want = Math.min(fx.range, U.dist(sx, sy, aimX, aimY) + 40);
      let placed = null;
      for (let d = want; d >= 24; d -= 12) {
        const nx = sx + Math.cos(a) * d - caster.w / 2;
        const ny = sy + Math.sin(a) * d - caster.h / 2;
        if (!game.area.rectBlocked(nx, ny, caster.w, caster.h) &&
            nx > 0 && nx + caster.w < game.area.width && ny > -600 && ny < game.area.height + 100) {
          placed = { x: nx, y: ny };
          break;
        }
      }
      if (!placed) return false;
      const c = colorsOf(caster);
      puff(game, sx, sy, 22, c, { ring: true, flash: true });
      caster.x = placed.x; caster.y = placed.y;
      caster.vx *= 0.4; caster.vy = Math.min(caster.vy, 0);
      caster.invulnTime = Math.max(caster.invulnTime, 0.14);
      game.addBolt(sx, sy, U.cx(caster), U.cy(caster), c);
      puff(game, U.cx(caster), U.cy(caster), 24, c, { ring: true, flash: true });
      return true;
    },

    /* Railgun — near-instant, punches through an entire line of enemies
       without slowing down. Lightning's "speed is the weapon" button. */
    railgun(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ox = U.cx(caster), oy = U.cy(caster);
      const ang = Math.atan2(aimY - oy, aimX - ox);
      game.combat.spawn({
        x: ox + Math.cos(ang) * 26, y: oy + Math.sin(ang) * 26,
        vx: Math.cos(ang) * fx.speed, vy: Math.sin(ang) * fx.speed,
        r: fx.radius, damage: dmgOf(fx, caster),
        team: caster.team, owner: caster, colors: c, shape: 'bolt',
        life: fx.life, gravity: 0, knockback: 120, pierce: fx.pierce,
        trail: caster.power.trail, impact: caster.power.impact, scale: 1.4
      });
      const ex = ox + Math.cos(ang) * 900, ey = oy + Math.sin(ang) * 900;
      game.addBolt(ox, oy, ex, ey, c);
      for (let i = 0; i < 50; i++) {
        const t = Math.random();
        game.particles.spawn({
          x: ox + (ex - ox) * t * 0.4, y: oy + (ey - oy) * t * 0.4,
          vx: U.rand(-120, 120), vy: U.rand(-120, 120),
          size: U.rand(1, 4), life: U.rand(0.1, 0.3), color: c.secondary, shape: 'spark'
        });
      }
      game.shake(8, 0.18);
      return true;
    },

    /* Chain Lightning — pure damage that hops. Unlike Fire Chain it does not
       burn; it hits harder per jump and reaches much further. */
    chainLightning(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      let cur = null, bestD = fx.range;
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const d = U.dist(aimX, aimY, U.cx(e), U.cy(e));
        if (d < bestD) { bestD = d; cur = e; }
      }
      if (!cur) return false;
      const used = {};
      let from = { x: U.cx(caster), y: U.cy(caster) };
      let dmg = dmgOf(fx, caster);
      for (let jump = 0; jump <= fx.jumps && cur; jump++) {
        used[cur.uid] = true;
        game.addBolt(from.x, from.y, U.cx(cur), U.cy(cur), c);
        game.combat.applyDamage(cur, dmg, {
          x: U.cx(cur), y: U.cy(cur), colors: c, source: caster, stun: 0.12
        });
        puff(game, U.cx(cur), U.cy(cur), 16, c, { flash: true, shape: 'spark' });
        from = { x: U.cx(cur), y: U.cy(cur) };
        dmg *= fx.falloff;
        let next = null, nd = fx.jumpRange;
        for (const e of targetsOf(game, caster)) {
          if (!e.alive || used[e.uid]) continue;
          const d = U.dist(from.x, from.y, U.cx(e), U.cy(e));
          if (d < nd) { nd = d; next = e; }
        }
        cur = next;
      }
      PF.Audio.hit();
      return true;
    },

    /* Overcharge — fire rate and projectile speed, not movement. Distinct
       from Wind's Slipstream, which is the opposite trade. */
    overcharge(fx, caster, game) {
      const c = colorsOf(caster);
      caster.addBuff({ id: 'overcharge', time: fx.duration, fire: fx.fire, dealt: fx.dealt });
      summon(game, {
        x: 0, y: 0, time: fx.duration, arcT: 0,
        tick(dt, g, s) {
          s.arcT -= dt;
          if (s.arcT <= 0) {
            s.arcT = U.rand(0.08, 0.2);
            const ang = Math.random() * Math.PI * 2;
            const r = 30;
            g.addBolt(U.cx(caster), U.cy(caster),
              U.cx(caster) + Math.cos(ang) * r, U.cy(caster) + Math.sin(ang) * r, c);
          }
          if (Math.random() < dt * 40) {
            g.particles.spawn({
              x: U.cx(caster) + U.rand(-22, 22), y: U.cy(caster) + U.rand(-30, 30),
              vx: U.rand(-80, 80), vy: U.rand(-80, 80),
              size: U.rand(2, 5), life: 0.2, color: c.secondary, shape: 'spark'
            });
          }
        }
      });
      game.combat.addNumber(U.cx(caster), caster.y - 12, 'OVERCHARGE', c.secondary, 18);
      return true;
    },

    /* Thunderstrike — one enormous bolt onto the marked spot. */
    thunderStrike(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - fx.radius * 0.7, fx.radius * 1.6, fx.radius * 1.4, fx.windup, () => {
        game.addBolt(aimX + U.rand(-40, 40), gy - 900, aimX, gy - 10, c);
        game.addBolt(aimX + U.rand(-60, 60), gy - 700, aimX, gy - 10, c);
        hitCircle(game, caster, aimX, gy - 24, fx.radius, dmgOf(fx, caster), {
          knockback: 260, stun: fx.stun, colors: c
        }, false);
        for (let i = 0; i < 90; i++) {
          const a2 = Math.random() * Math.PI * 2;
          game.particles.spawn({
            x: aimX + U.rand(-14, 14), y: gy - U.rand(0, 40),
            vx: Math.cos(a2) * U.rand(160, 780), vy: Math.sin(a2) * U.rand(120, 500) - 180,
            size: U.rand(2, 7), life: U.rand(0.15, 0.5),
            color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'spark', drag: 1.4, glow: 1
          });
        }
        game.particles.flash(aimX, gy - 30, c.secondary, fx.radius * 2.4, 0.25);
        game.shake(16, 0.35);
        PF.Audio.explode();
      });
      return true;
    },

    /* Static Field — a fixed zone that paralyses. Damage is secondary to the
       fact that nothing inside it can act reliably. */
    staticField(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      summon(game, {
        x: aimX, y: aimY, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = fx.tick;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > fx.radius) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.4, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                stun: fx.stun, slow: 0.5, slowTime: 0.6
              });
              g.addBolt(s.x, s.y, U.cx(e), U.cy(e), c);
            }
          }
          if (Math.random() < dt * 30) {
            const ang = Math.random() * Math.PI * 2;
            g.addBolt(s.x, s.y,
              s.x + Math.cos(ang) * fx.radius, s.y + Math.sin(ang) * fx.radius * 0.7, c);
          }
        },
        draw() {
          // No ring — the arcing bolts above already mark the field's reach,
          // and the dashed ellipse read as a range/targeting overlay.
        }
      });
      return true;
    },

    /* Lightning Rush — you cross the whole gap instantly and everything on
       the line takes it. Not a dash: there is no travel time at all. */
    lineDash(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const sx = U.cx(caster), sy = U.cy(caster);
      const ang = Math.atan2(aimY - sy, aimX - sx);
      const dist = Math.min(fx.range, U.dist(sx, sy, aimX, aimY) + 60);

      let placed = null;
      for (let d = dist; d >= 24; d -= 14) {
        const nx = sx + Math.cos(ang) * d - caster.w / 2;
        const ny = sy + Math.sin(ang) * d - caster.h / 2;
        if (!game.area.rectBlocked(nx, ny, caster.w, caster.h) &&
            nx > 0 && nx + caster.w < game.area.width) { placed = { x: nx, y: ny, d: d }; break; }
      }
      if (!placed) return false;

      // Everything within `width` of the travelled segment gets hit.
      const ex = sx + Math.cos(ang) * placed.d, ey = sy + Math.sin(ang) * placed.d;
      for (const e of targetsOf(game, caster)) {
        if (!e.alive) continue;
        const vx = ex - sx, vy = ey - sy;
        const len2 = Math.max(1, vx * vx + vy * vy);
        const t = U.clamp(((U.cx(e) - sx) * vx + (U.cy(e) - sy) * vy) / len2, 0, 1);
        if (U.dist(sx + vx * t, sy + vy * t, U.cx(e), U.cy(e)) > fx.width) continue;
        game.combat.applyDamage(e, dmgOf(fx, caster), {
          x: U.cx(e), y: U.cy(e), colors: c, source: caster,
          knockback: 180, dirX: Math.cos(ang), dirY: -0.3, stun: 0.2
        });
      }

      caster.x = placed.x; caster.y = placed.y;
      caster.vy = Math.min(caster.vy, 0);
      caster.invulnTime = Math.max(caster.invulnTime, 0.2);
      game.addBolt(sx, sy, ex, ey, c);
      for (let i = 0; i < 60; i++) {
        const t = Math.random();
        game.particles.spawn({
          x: sx + (ex - sx) * t, y: sy + (ey - sy) * t,
          vx: U.rand(-140, 140), vy: U.rand(-140, 140),
          size: U.rand(2, 6), life: U.rand(0.12, 0.35),
          color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'spark', glow: 1
        });
      }
      game.shake(9, 0.22);
      return true;
    },

    /* Ball Lightning — a slow drifting orb that keeps zapping whatever comes
       near it. The opposite of everything else lightning does. */
    ballLightning(fx, caster, game, aimX, aimY) {
      const c = colorsOf(caster);
      const ang = Math.atan2(aimY - U.cy(caster), aimX - U.cx(caster));
      summon(game, {
        x: U.cx(caster) + Math.cos(ang) * 30, y: U.cy(caster) + Math.sin(ang) * 30,
        time: fx.duration, vx: Math.cos(ang) * fx.speed, vy: Math.sin(ang) * fx.speed,
        tickT: 0, phase: 0,
        tick(dt, g, s) {
          s.x += s.vx * dt; s.y += s.vy * dt;
          s.phase += dt * 6;
          if (g.area.hitsSolid(s.x, s.y, 10)) { s.vy = -Math.abs(s.vy) * 0.4; s.y -= 4; }
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = fx.tick;
            let zapped = 0;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive || zapped >= fx.maxZaps) continue;
              if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > fx.radius) continue;
              zapped++;
              g.addBolt(s.x, s.y, U.cx(e), U.cy(e), c);
              g.combat.applyDamage(e, dmgOf(fx, caster), {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster, stun: 0.1
              });
            }
          }
          if (Math.random() < dt * 60) {
            g.particles.spawn({
              x: s.x + U.rand(-10, 10), y: s.y + U.rand(-10, 10),
              vx: U.rand(-90, 90), vy: U.rand(-90, 90),
              size: U.rand(2, 5), life: 0.22, color: c.secondary, shape: 'spark', glow: 1
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 26);
          gr.addColorStop(0, U.rgba(c.secondary, 0.95));
          gr.addColorStop(1, U.rgba(c.primary, 0));
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 26, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      return true;
    },

    /* Arc Tether — bolts stay attached to nearby enemies and burn them for
       as long as you keep MOVING. Standing still does nothing. */
    tether(fx, caster, game) {
      const c = colorsOf(caster);
      const linked = [];
      for (const e of targetsOf(game, caster)) {
        if (!e.alive || linked.length >= fx.count) continue;
        if (U.dist(U.cx(caster), U.cy(caster), U.cx(e), U.cy(e)) > fx.range) continue;
        linked.push(e);
      }
      if (!linked.length) return false;
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0, lastX: U.cx(caster),
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT > 0) return;
          s.tickT = 0.2;
          // Damage scales with the distance covered since the last tick.
          // lastX is sampled HERE, per tick — updating it every frame
          // instead measured one frame of travel (~4px) rather than a
          // tick's worth (~52px at run speed), so the multiplier sat near
          // 0.7 and its cap was unreachable. Divisor is a tick of ordinary
          // running, so sprinting a full tick reads ~1x and the cap is 2x.
          const moved = Math.abs(U.cx(caster) - s.lastX);
          s.lastX = U.cx(caster);
          const mult = U.clamp(moved / 50, 0, 2);
          for (const e of linked) {
            if (!e.alive) continue;
            if (U.dist(U.cx(caster), U.cy(caster), U.cx(e), U.cy(e)) > fx.breakRange) continue;
            g.addBolt(U.cx(caster), U.cy(caster), U.cx(e), U.cy(e), c);
            if (mult <= 0.05) continue;
            g.combat.applyDamage(e, dmgOf(fx, caster) * mult, {
              x: U.cx(e), y: U.cy(e), colors: c, source: caster, slow: 0.2, slowTime: 0.4
            });
          }
        }
      });
      game.combat.addNumber(U.cx(caster), caster.y - 12, 'TETHERED x' + linked.length, c.secondary, 17);
      return true;
    },

    /* Judgment (ultimate) — a rolling barrage of strikes across a huge
       marked band, each one chaining outward from where it lands. */
    judgment(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - 90, fx.width, 180, fx.windup, () => {
        game.addSpawner(fx.duration, fx.strikes, function () {
          const x = aimX + U.rand(-fx.width / 2, fx.width / 2);
          // Follow rather than plain scan-down: a strike landing on a column
          // whose ground rises above the band's own level would otherwise
          // resolve to that level and go off buried inside the slope.
          const y = groundFollowY(game, x, gy);
          game.addBolt(x + U.rand(-30, 30), y - 900, x, y - 10, c);
          hitCircle(game, caster, x, y - 24, fx.radius, dmgOf(fx, caster), {
            knockback: 200, stun: 0.25, colors: c
          }, false);
          for (let i = 0; i < 30; i++) {
            const a2 = Math.random() * Math.PI * 2;
            game.particles.spawn({
              x: x, y: y - 16,
              vx: Math.cos(a2) * U.rand(140, 620), vy: Math.sin(a2) * U.rand(100, 420) - 160,
              size: U.rand(2, 7), life: U.rand(0.15, 0.45),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'spark', glow: 1
            });
          }
          game.particles.flash(x, y - 24, c.secondary, fx.radius * 1.8, 0.2);
          game.shake(9, 0.2);
        });
      });
      PF.Audio.explode();
      return true;
    },

    /* ================================================================ RAIN */

    /* Downpour — a marked band that rains real projectiles for a while. */
    downpour(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - 60, fx.width, 120, fx.windup, () => {
        game.addSpawner(fx.duration, fx.count, function () {
          game.combat.spawn({
            x: aimX + U.rand(-fx.width / 2, fx.width / 2), y: gy - U.rand(430, 520),
            vx: U.rand(-30, 30), vy: fx.speed,
            r: 9, damage: dmgOf(fx, caster),
            team: caster.team, owner: caster, colors: c, shape: 'droplet',
            life: 2.2, gravity: 260, knockback: 40,
            trail: caster.power.trail, impact: caster.power.impact, trailBudget: 0.3
          });
        });
      });
      return true;
    },

    /* Drizzle Veil — a shroud that clings to YOU and drags on anything that
       gets close. No damage; it exists to keep things off you. */
    drizzleVeil(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.x = U.cx(caster); s.y = U.cy(caster);
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              if (U.dist(s.x, s.y, U.cx(e), U.cy(e)) > fx.radius) continue;
              e.applySlow(fx.slow, 0.8);
            }
          }
          for (let i = 0; i < 6; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rr = fx.radius * Math.sqrt(Math.random());
            g.particles.spawn({
              x: s.x + Math.cos(ang) * rr, y: s.y + Math.sin(ang) * rr * 0.7 - 20,
              vx: U.rand(-20, 20), vy: U.rand(120, 300),
              size: U.rand(1, 4), life: U.rand(0.25, 0.5),
              color: c.primary, shape: 'drop'
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const gr = ctx.createRadialGradient(s.x, s.y, 10, s.x, s.y, fx.radius);
          gr.addColorStop(0, U.rgba(c.primary, 0.12));
          gr.addColorStop(1, U.rgba(c.primary, 0));
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(s.x, s.y, fx.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      return true;
    },

    /* Cloudburst — all of a storm's water in one vertical slam on a single
       point. Instant, unlike Downpour's drizzle over time. */
    cloudburst(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - 50, fx.width, 100, fx.windup, () => {
        hitRect(game, caster, aimX - fx.width / 2, gy - 460, fx.width, 460,
          dmgOf(fx, caster), { knockback: 120, dirY: 1, slow: 0.4, slowTime: 2, colors: c });
        for (let i = 0; i < 160; i++) {
          const px = aimX + U.rand(-fx.width / 2, fx.width / 2);
          game.particles.spawn({
            x: px, y: gy - U.rand(0, 460),
            vx: U.rand(-60, 60), vy: U.rand(700, 1500),
            size: U.rand(2, 7), life: U.rand(0.2, 0.5),
            color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop'
          });
        }
        for (let i = 0; i < 50; i++) {
          const a2 = Math.random() * Math.PI;
          game.particles.spawn({
            x: aimX + U.rand(-fx.width / 2, fx.width / 2), y: gy - 6,
            vx: Math.cos(a2) * U.rand(120, 520), vy: -Math.abs(Math.sin(a2)) * U.rand(120, 420),
            size: U.rand(2, 6), life: U.rand(0.25, 0.55),
            color: c.secondary, shape: 'drop', gravity: 720
          });
        }
        game.shake(11, 0.3);
        PF.Audio.explode();
      });
      return true;
    },

    /* Storm Cloud — follows you overhead and rains on its own. The only
       ability that keeps attacking without you aiming it. */
    stormCloud(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: U.cx(caster), y: U.cy(caster) - fx.height, time: fx.duration, dropT: 0,
        tick(dt, g, s) {
          s.x = U.damp(s.x, U.cx(caster), 3, dt);
          s.y = U.damp(s.y, U.cy(caster) - fx.height, 3, dt);
          s.dropT -= dt;
          if (s.dropT <= 0) {
            s.dropT = fx.interval;
            g.combat.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: s.y + 10,
              vx: U.rand(-20, 20), vy: fx.speed,
              r: 8, damage: dmgOf(fx, caster),
              team: caster.team, owner: caster, colors: c, shape: 'droplet',
              life: 2.4, gravity: 300, knockback: 30,
              trail: caster.power.trail, impact: caster.power.impact, trailBudget: 0.25
            });
          }
          if (Math.random() < dt * 26) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: s.y + U.rand(-8, 8),
              vx: U.rand(-16, 16), vy: U.rand(-8, 24),
              size: U.rand(5, 12), life: U.rand(0.4, 0.9),
              color: c.dark, shape: 'ember', glow: 0.25
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.fillStyle = U.rgba(c.dark, 0.5);
          for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.ellipse(s.x + (i - 1.5) * fx.width * 0.24, s.y + Math.sin(i) * 5,
              fx.width * 0.24, 14, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      });
      return true;
    },

    /* Puddles — several small pools placed at once. Cheap, persistent area
       denial rather than one big zone. */
    puddles(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      for (let i = 0; i < fx.count; i++) {
        const px = aimX + (i - (fx.count - 1) / 2) * fx.spacing;
        const gy = groundYAt(game, px, caster.y + caster.h);
        summon(game, {
          x: px, y: gy, time: fx.duration, tickT: U.rand(0, 0.3),
          tick(dt, g, s) {
            s.tickT -= dt;
            if (s.tickT > 0) return;
            s.tickT = 0.4;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              // Same shallow-puddle problem as quicksand — X-only caught
              // anything above or below it too, not just things standing
              // in the actual pool.
              if (Math.abs(U.cx(e) - s.x) > fx.radius) continue;
              if (Math.abs(U.cy(e) - gy) > 60) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.5, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster, slow: fx.slow, slowTime: 1
              });
            }
            g.particles.spawn({
              x: s.x + U.rand(-fx.radius, fx.radius), y: s.y - 4,
              vx: U.rand(-40, 40), vy: -U.rand(30, 110),
              size: U.rand(2, 5), life: 0.4, color: c.secondary, shape: 'drop', gravity: 420
            });
          },
          draw(ctx, s) {
            const a = U.clamp(s.time / 1, 0, 1);
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = U.rgba(c.primary, 0.3 * a);
            ctx.beginPath();
            ctx.ellipse(s.x, s.y - 3, fx.radius, 7, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        });
      }
      return true;
    },

    /* Hailstorm — heavier, slower rain that staggers what it lands on. */
    hailstorm(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      telegraph(game, caster, aimX, gy - 70, fx.width, 140, fx.windup, () => {
        game.addSpawner(fx.duration, fx.count, function () {
          const x = aimX + U.rand(-fx.width / 2, fx.width / 2);
          // Follow rather than plain scan-down: a strike landing on a column
          // whose ground rises above the band's own level would otherwise
          // resolve to that level and go off buried inside the slope.
          const y = groundFollowY(game, x, gy);
          hitCircle(game, caster, x, y - 20, fx.radius, dmgOf(fx, caster), {
            knockback: 140, stun: Math.random() < fx.stunChance ? 0.4 : 0, colors: c
          });
          for (let i = 0; i < 16; i++) {
            game.particles.spawn({
              x: x + U.rand(-14, 14), y: y - U.rand(0, 380),
              vx: U.rand(-40, 40), vy: U.rand(600, 1100),
              size: U.rand(3, 8), life: U.rand(0.2, 0.45),
              color: Math.random() < 0.5 ? c.secondary : [235, 250, 255], shape: 'grain'
            });
          }
          game.particles.ring(x, y - 12, c.secondary, 14, 0.3);
        });
        game.shake(8, 0.3);
      });
      return true;
    },

    /* Torrent — a sustained vertical column that pins whatever is under it
       in place for as long as it runs. */
    torrent(fx, caster, game, aimX) {
      const c = colorsOf(caster);
      const gy = groundYAt(game, aimX, caster.y + caster.h);
      summon(game, {
        x: aimX, y: gy, time: fx.duration, tickT: 0,
        tick(dt, g, s) {
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.15;
            hitRect(g, caster, s.x - fx.width / 2, gy - 420, fx.width, 420,
              dmgOf(fx, caster) * 0.3, {
                knockback: 40, dirY: 1, slow: 0.75, slowTime: 0.5, colors: c
              });
          }
          for (let i = 0; i < 14; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: gy - U.rand(0, 420),
              vx: U.rand(-30, 30), vy: U.rand(800, 1500),
              size: U.rand(2, 7), life: U.rand(0.15, 0.35),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop'
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g2 = ctx.createLinearGradient(s.x - fx.width / 2, 0, s.x + fx.width / 2, 0);
          g2.addColorStop(0, U.rgba(c.primary, 0));
          g2.addColorStop(0.5, U.rgba(c.primary, 0.3));
          g2.addColorStop(1, U.rgba(c.primary, 0));
          ctx.fillStyle = g2;
          ctx.fillRect(s.x - fx.width / 2, s.y - 420, fx.width, 420);
          ctx.restore();
        }
      });
      return true;
    },

    /* Flood — the ground itself fills with water across a huge span, rising
       as it goes. Everything standing in it is slowed and drowning. */
    flood(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: U.cx(caster), y: groundYAt(game, U.cx(caster), caster.y + caster.h),
        time: fx.duration, level: 0, tickT: 0,
        tick(dt, g, s) {
          const prog = 1 - U.clamp(s.time / s.maxTime, 0, 1);
          s.level = fx.height * Math.min(1, prog * 3);
          s.y = groundFollowY(g, s.x, s.y);
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.35;
            hitRect(g, caster, s.x - fx.width / 2, s.y - s.level, fx.width, s.level + 30,
              dmgOf(fx, caster) * 0.35, { slow: fx.slow, slowTime: 1.2, colors: c });
          }
          for (let i = 0; i < 10; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: s.y - U.rand(0, Math.max(6, s.level)),
              vx: U.rand(-120, 120), vy: -U.rand(20, 160),
              size: U.rand(2, 7), life: U.rand(0.25, 0.6),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop', gravity: 500
            });
          }
        },
        draw(ctx, s) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = U.rgba(c.primary, 0.28);
          ctx.fillRect(s.x - fx.width / 2, s.y - s.level, fx.width, s.level);
          ctx.strokeStyle = U.rgba(c.secondary, 0.5);
          ctx.lineWidth = 3;
          ctx.beginPath();
          for (let x = -fx.width / 2; x <= fx.width / 2; x += 24) {
            const yy = s.y - s.level + Math.sin((x + s.time * 200) * 0.03) * 5;
            if (x === -fx.width / 2) ctx.moveTo(s.x + x, yy); else ctx.lineTo(s.x + x, yy);
          }
          ctx.stroke();
          ctx.restore();
        }
      });
      return true;
    },

    /* Monsoon — a long, wide, continuous fall of real projectiles centred on
       you and moving with you. */
    monsoon(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, dropT: 0,
        tick(dt, g, s) {
          s.x = U.cx(caster);
          s.dropT -= dt;
          if (s.dropT > 0) return;
          s.dropT = fx.interval;
          for (let i = 0; i < fx.perDrop; i++) {
            g.combat.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: U.cy(caster) - U.rand(380, 560),
              vx: U.rand(-40, 40), vy: fx.speed,
              r: 8, damage: dmgOf(fx, caster),
              team: caster.team, owner: caster, colors: c, shape: 'droplet',
              life: 2.6, gravity: 300, knockback: 30,
              trail: caster.power.trail, impact: caster.power.impact, trailBudget: 0.2
            });
          }
        }
      });
      return true;
    },

    /* Deluge (ultimate) — monsoon, flood and hail at once, everywhere. */
    deluge(fx, caster, game) {
      const c = colorsOf(caster);
      summon(game, {
        x: 0, y: 0, time: fx.duration, dropT: 0, tickT: 0,
        tick(dt, g, s) {
          s.x = U.cx(caster);
          s.dropT -= dt;
          if (s.dropT <= 0) {
            s.dropT = 0.05;
            for (let i = 0; i < 4; i++) {
              g.combat.spawn({
                x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: U.cy(caster) - U.rand(400, 620),
                vx: U.rand(-60, 60), vy: fx.speed,
                r: 10, damage: dmgOf(fx, caster),
                team: caster.team, owner: caster, colors: c, shape: 'droplet',
                life: 2.6, gravity: 320, knockback: 60,
                trail: caster.power.trail, impact: caster.power.impact, trailBudget: 0.2
              });
            }
          }
          s.tickT -= dt;
          if (s.tickT <= 0) {
            s.tickT = 0.3;
            for (const e of targetsOf(g, caster)) {
              if (!e.alive) continue;
              // Supplementary tick on top of the real falling droplets above
              // — X-only reached anything on a totally different platform
              // as long as it shared a column with you, however far above
              // or below. Bounded to the same vertical spread the droplets
              // themselves actually fall through.
              if (Math.abs(U.cx(e) - s.x) > fx.width / 2) continue;
              if (Math.abs(U.cy(e) - U.cy(caster)) > 500) continue;
              g.combat.applyDamage(e, dmgOf(fx, caster) * 0.3, {
                x: U.cx(e), y: U.cy(e), colors: c, source: caster,
                slow: 0.6, slowTime: 1.2, knockback: 60, dirY: 1
              });
            }
          }
          for (let i = 0; i < 20; i++) {
            g.particles.spawn({
              x: s.x + U.rand(-fx.width / 2, fx.width / 2), y: U.cy(caster) + U.rand(-400, 200),
              vx: U.rand(-60, 60), vy: U.rand(700, 1400),
              size: U.rand(2, 7), life: U.rand(0.2, 0.5),
              color: Math.random() < 0.5 ? c.secondary : c.primary, shape: 'drop'
            });
          }
          if (Math.random() < dt * 5) g.shake(7, 0.25);
        }
      });
      game.shake(14, 0.5);
      PF.Audio.explode();
      return true;
    }
  };

  /* ---- ability data ---------------------------------------------------- */

  /* One ability per level: every level from 2 to 12 hands you the next
     one, instead of the old spread that made you grind to 50 for the
     last few. */
  const TIERS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const BY_POWER = {
    /* ---------------------------------------------------------------- WIND
       Displacement. Wind rarely kills things by itself — it decides where
       they are, how fast they get there, and whether they touch the ground. */
    wind: [
      { id: 'gale_step', name: 'Wind Dash', icon: '»', unlockLevel: 2, type: 'active', cooldown: 4,
        desc: 'Dash toward your cursor. Enemies you run through get hurt.',
        effect: { type: 'dash', speed: 1180, duration: 0.22, damage: 10.24, radius: 40, invuln: 0.26 } },

      { id: 'skyward_column', name: 'Updraft', icon: '⇡', unlockLevel: 3, type: 'active', cooldown: 9,
        desc: 'A column of wind that keeps throwing enemies up into the air for 3s.',
        effect: { type: 'launchColumn', width: 150, height: 320, duration: 3.2, lift: 620, damage: 7.584 } },

      { id: 'cyclone_blade', name: 'Wind Blade', icon: '◎', unlockLevel: 4, type: 'active', cooldown: 8,
        desc: 'Throw a spinning blade of wind. It slows down and comes back to you.',
        effect: { type: 'boomerang', speed: 760, duration: 1.9, damage: 14.008, radius: 34 } },

      { id: 'flight', name: 'Flight', icon: '✦', unlockLevel: 5, type: 'toggle', trigger: 'Double-tap W', cooldown: 0,
        desc: 'Fly around. W goes up, S goes down, A and D steer. Double-tap W to land.' },

      { id: 'vacuum', name: 'Vacuum', icon: '⊙', unlockLevel: 6, type: 'active', cooldown: 12,
        desc: 'Pulls all nearby enemies in close to you.',
        effect: { type: 'vacuum', radius: 340, pull: 620, damage: 31.052 } },

      { id: 'slipstream', name: 'Speed Boost', icon: '➤', unlockLevel: 7, type: 'active', cooldown: 18,
        desc: 'Run a lot faster and shoot a little faster for 6s.',
        effect: { type: 'haste', duration: 6, move: 1.75, fire: 1.15 } },

      { id: 'wind_wall', name: 'Wind Wall', icon: '║', unlockLevel: 8, type: 'active', cooldown: 16,
        desc: 'A wall of wind that pushes enemies back for 6s.',
        effect: { type: 'pushWall', width: 90, height: 300, duration: 6, push: 340, damage: 7.872 } },

      { id: 'tempest_ring', name: 'Wind Ring', icon: '◌', unlockLevel: 9, type: 'active', cooldown: 15,
        desc: 'A ring of wind grows out from you and hits each enemy once.',
        effect: { type: 'expandRing', speed: 620, duration: 1.1, damage: 52.713, knockback: 520 } },

      { id: 'gale_force', name: 'Big Gust', icon: '⇛', unlockLevel: 10, type: 'active', cooldown: 14,
        desc: 'A strong gust in front of you. It barely hurts, but it blows enemies far away.',
        effect: { type: 'gustLine', length: 620, height: 190, push: 900, damage: 63.194 } },

      { id: 'tornado', name: 'Tornado', icon: '🌀', unlockLevel: 11, type: 'active', cooldown: 24,
        desc: 'A tornado that moves across the ground on its own and throws enemies up. Lasts 6s.',
        effect: { type: 'tornado', speed: 210, duration: 6, radius: 110, height: 240, damage: 63.137, lift: 260 } },

      { id: 'hurricane', name: 'Hurricane', icon: '✺', unlockLevel: 12, type: 'active', cooldown: 55,
        desc: 'A huge storm all around you for 7s. It hurts enemies and knocks them around.',
        effect: { type: 'hurricane', duration: 7, radius: 620, damage: 12.061 } }
    ],

    /* --------------------------------------------------------------- WATER
       Flow and control. No flight — instead the deepest toolkit for keeping
       yourself alive and taking single targets out of the fight. */
    water: [
      { id: 'hydro_jet', name: 'Water Jet', icon: '↠', unlockLevel: 2, type: 'active', cooldown: 5,
        desc: 'Shoot a blast of water straight ahead. It pushes enemies back.',
        effect: { type: 'jetStream', length: 300, width: 44, push: 420, damage: 12.32 } },

      { id: 'mending_current', name: 'Healing Water', icon: '✚', unlockLevel: 3, type: 'active', cooldown: 20,
        desc: 'Heal 45% of your health over 3s.',
        effect: { type: 'heal', amount: 0.45, duration: 3 } },

      { id: 'bubble_trap', name: 'Bubble Trap', icon: '◯', unlockLevel: 4, type: 'active', cooldown: 14,
        desc: 'Trap one enemy in a bubble for 3.5s. It floats, cannot move, and takes more damage.',
        failHint: 'No enemy close enough',
        effect: { type: 'bubbleLock', range: 260, duration: 3.5, lift: 420, damage: 16.851 } },

      { id: 'tide_surge', name: 'Big Wave', icon: '≋', unlockLevel: 5, type: 'active', cooldown: 11,
        desc: 'A wave rolls along the ground and carries enemies forward.',
        effect: { type: 'groundWave', speed: 620, duration: 1.6, width: 120, height: 150, push: 520, damage: 19.819 } },

      { id: 'whirlpool', name: 'Whirlpool', icon: '❂', unlockLevel: 6, type: 'active', cooldown: 15,
        desc: 'A whirlpool that pulls enemies to the middle and slows them for 5s.',
        effect: { type: 'whirlpool', radius: 190, duration: 5, pull: 320, slow: 0.5, damage: 4.122 } },

      { id: 'aqua_shield', name: 'Water Shield', icon: '⬡', unlockLevel: 7, type: 'active', cooldown: 18,
        desc: 'A shield that blocks damage equal to 55% of your health for 9s. You also take 20% less damage.',
        effect: { type: 'shield', amount: 0.55, duration: 9, taken: 0.8 } },

      { id: 'pressure_cutter', name: 'Water Slice', icon: '─', unlockLevel: 8, type: 'active', cooldown: 12,
        desc: 'A thin slice of water in a long line. Enemies it hits take more damage for a while.',
        effect: { type: 'pressureCut', length: 640, width: 26, damage: 33.296 } },

      { id: 'drowning_mist', name: 'Thick Mist', icon: '◍', unlockLevel: 9, type: 'active', cooldown: 17,
        desc: 'A cloud that slows enemies a lot and hurts them over time for 7s.',
        effect: { type: 'drownMist', radius: 200, duration: 7, slow: 0.65, damage: 5.844 } },

      { id: 'tsunami', name: 'Tsunami', icon: '⩗', unlockLevel: 10, type: 'active', cooldown: 26,
        desc: 'A giant wave crosses the screen and throws enemies.',
        effect: { type: 'screenSweep', speed: 900, duration: 2.6, width: 190, height: 400, push: 700, damage: 47.618 } },

      { id: 'healing_spring', name: 'Healing Spring', icon: '⌇', unlockLevel: 11, type: 'active', cooldown: 30,
        desc: 'A fountain that heals you and hurts enemies standing in it for 9s.',
        effect: { type: 'fountain', radius: 210, duration: 9, healFrac: 0.05, damage: 8.524 } },

      { id: 'maelstrom', name: 'Big Whirlpool', icon: '⊛', unlockLevel: 12, type: 'active', cooldown: 55,
        desc: 'A spinning water storm around you for 8s. It pulls enemies in and hurts them.',
        effect: { type: 'maelstrom', radius: 300, duration: 8, damage: 6.206 } }
    ],

    /* ---------------------------------------------------------------- FIRE
       Commitment. Fire does not reposition — it makes places dangerous and
       keeps them dangerous long after the cast. */
    fire: [
      { id: 'lava_geyser', name: 'Lava Burst', icon: '⇈', unlockLevel: 2, type: 'active', cooldown: 6,
        desc: 'Lava shoots up from the ground where you aim. It throws enemies up and sets them on fire.',
        effect: {
          type: 'groundEruption', width: 160, height: 360, windup: 0.42, duration: 0.7,
          bursts: 14, lift: 520, burnTime: 3.5, damage: 2.069
        } },

      { id: 'flame_cone', name: 'Flamethrower', icon: '≺', unlockLevel: 3, type: 'active', cooldown: 6,
        desc: 'Spray fire in front of you. Enemies hit keep burning.',
        effect: { type: 'flameCone', length: 230, spread: 0.55, burnTime: 4, damage: 3.052 } },

      { id: 'meteor', name: 'Meteor', icon: '☄', unlockLevel: 4, type: 'active', cooldown: 12,
        desc: 'Drop a big rock from the sky. The ground keeps burning where it lands.',
        effect: { type: 'skyStrike', radius: 150, windup: 0.55, knockback: 420, burnTime: 3, craterTime: 5, damage: 2.977 } },

      { id: 'flight', name: 'Flight', icon: '✦', unlockLevel: 5, type: 'toggle', trigger: 'Double-tap W', cooldown: 0,
        desc: 'Fly around. W goes up, S goes down, A and D steer. Double-tap W to land.' },

      { id: 'immolation', name: 'Fire Aura', icon: '❈', unlockLevel: 6, type: 'active', cooldown: 16,
        desc: 'Set yourself on fire for 6s. Enemies close to you catch fire too.',
        effect: { type: 'immolation', radius: 165, duration: 6, damage: 1.015 } },

      { id: 'backdraft', name: 'Fire Bomb', icon: '◉', unlockLevel: 7, type: 'active', cooldown: 15,
        desc: 'Pulls enemies toward a spot, then blows up.',
        effect: {
          type: 'backdraft', radius: 190, pullRadius: 330, pull: 900,
          windup: 0.8, knockback: 560, burnTime: 3, damage: 5.463
        } },

      { id: 'fire_chain', name: 'Fire Chain', icon: '⌥', unlockLevel: 8, type: 'active', cooldown: 12,
        desc: 'Fire jumps from one enemy to the next and sets each one on fire.',
        failHint: 'Nothing in range to catch',
        effect: { type: 'fireChain', range: 300, jumps: 4, jumpRange: 260, falloff: 0.85, burnTime: 5, damage: 4.117 } },

      { id: 'wall_of_flame', name: 'Wall of Flame', icon: '▤', unlockLevel: 9, type: 'active', cooldown: 18,
        desc: 'A line of fire on the ground for 8s. It does not block anything, but it burns enemies who cross it.',
        effect: { type: 'hazardWall', length: 420, height: 130, duration: 8, burnTime: 4, damage: 1.016 } },

      { id: 'blazing_comet', name: 'Comet', icon: '✹', unlockLevel: 10, type: 'active', cooldown: 16,
        desc: 'A fireball that gets bigger and faster the farther it flies. Farther means more damage.',
        effect: {
          type: 'growingComet', speed: 380, duration: 1.5, radius: 16, growth: 1.6,
          accel: 1.4, blast: 130, burnTime: 4, damage: 8.567
        } },

      { id: 'phoenix_dive', name: 'Phoenix Dive', icon: '⌁', unlockLevel: 11, type: 'active', cooldown: 26,
        desc: 'Fly up into the air, then slam down where you aim. You cannot be hurt while you are up there.',
        effect: { type: 'diveBomb', rise: 900, windup: 0.85, radius: 200, knockback: 620, burnTime: 5, damage: 5.702 } },

      { id: 'inferno', name: 'Inferno', icon: '⁂', unlockLevel: 12, type: 'active', cooldown: 55,
        desc: 'A big fire around you for 8s. It keeps setting enemies on fire.',
        effect: { type: 'inferno', radius: 300, duration: 8, damage: 1.872 } }
    ],

    /* ---------------------------------------------------------------- SAND
       Terrain and denial. Sand does not chase — it decides where the fight
       happens and makes leaving impossible. No flight. */
    sand: [
      { id: 'grit_spray', name: 'Sand Spray', icon: '⁘', unlockLevel: 2, type: 'active', cooldown: 6,
        desc: 'Spray sand in front of you. It does a little damage and slows enemies down.',
        effect: { type: 'gritCone', length: 210, spread: 0.6, slow: 0.6, slowTime: 2.5, damage: 7.089 } },

      { id: 'quicksand', name: 'Quicksand', icon: '◌', unlockLevel: 3, type: 'active', cooldown: 12,
        desc: 'Turns the ground to mud for 6s. Enemies standing in it get stuck.',
        effect: { type: 'quicksand', radius: 150, duration: 6, damage: 1.743 } },

      { id: 'boulder_toss', name: 'Boulder Toss', icon: '⬤', unlockLevel: 4, type: 'active', cooldown: 9,
        desc: 'Throw a heavy rock. It hits hard and stuns enemies.',
        effect: { type: 'boulder', speed: 700, duration: 2.4, radius: 26, blast: 140, knockback: 620, stun: 0.9, damage: 12.673 } },

      { id: 'burrow', name: 'Burrow', icon: '⇣', unlockLevel: 5, type: 'active', cooldown: 15,
        desc: 'Dig underground for 2s. You move faster and cannot be hurt. Then you pop back out with a blast.',
        effect: { type: 'burrow', duration: 2, move: 1.7, blast: 170, damage: 19.28 } },

      { id: 'sandstorm', name: 'Sandstorm', icon: '❋', unlockLevel: 6, type: 'active', cooldown: 18,
        desc: 'A sandstorm that moves forward, hurts enemies, and slows them. They cannot tell where they are going.',
        effect: { type: 'sandstorm', speed: 180, duration: 6, radius: 170, height: 220, damage: 9.026 } },

      { id: 'stone_skin', name: 'Stone Skin', icon: '⬢', unlockLevel: 7, type: 'active', cooldown: 22,
        desc: 'Take 45% less damage for 7s, but you move a little slower.',
        effect: { type: 'stoneSkin', duration: 7, taken: 0.55, move: 0.85 } },

      { id: 'earthquake', name: 'Earthquake', icon: '≣', unlockLevel: 8, type: 'active', cooldown: 16,
        desc: 'Crack the ground. A shockwave runs both ways and stuns enemies it hits.',
        failHint: 'You must be standing on the ground',
        effect: { type: 'earthquake', speed: 760, duration: 1.4, knockback: 520, launch: 320, stun: 0.8, damage: 19.206 } },

      { id: 'petrify', name: 'Turn to Stone', icon: '⌂', unlockLevel: 9, type: 'active', cooldown: 20,
        desc: 'Turns nearby enemies to stone. They cannot move and take 60% more damage.',
        effect: { type: 'petrify', radius: 175, duration: 2.6, vuln: 1.6, damage: 22.974 } },

      { id: 'sinkhole', name: 'Sinkhole', icon: '◕', unlockLevel: 10, type: 'active', cooldown: 22,
        desc: 'The ground caves in and pulls enemies to the middle while it hurts them.',
        effect: { type: 'sinkhole', radius: 190, duration: 6, pull: 420, damage: 3.123 } },

      { id: 'mirage', name: 'Sand Clones', icon: '⧉', unlockLevel: 11, type: 'active', cooldown: 26,
        desc: 'Make 3 sand copies of yourself. Enemies chase them, then they blow up.',
        effect: { type: 'mirage', count: 3, spread: 120, duration: 5, blast: 150, damage: 25.822 } },

      { id: 'desert_wrath', name: 'Bury', icon: '☰', unlockLevel: 12, type: 'active', cooldown: 55,
        desc: 'Bury everything around you for 8s. Enemies get stunned, slowed, and take more damage.',
        effect: { type: 'desertWrath', radius: 560, duration: 8, damage: 3.39 } }
    ],

    /* ----------------------------------------------------------- LIGHTNING
       Speed and reach. Lightning gets there first, goes through things, and
       spreads between them. */
    lightning: [
      { id: 'blink', name: 'Blink', icon: '⇢', unlockLevel: 2, type: 'active', cooldown: 4,
        desc: 'Teleport to your cursor right away.',
        failHint: 'Nowhere to blink to',
        effect: { type: 'blink', range: 340 } },

      { id: 'railgun', name: 'Railgun', icon: '⟶', unlockLevel: 3, type: 'active', cooldown: 7,
        desc: 'A super fast bolt that goes through every enemy in a line.',
        effect: { type: 'railgun', speed: 3200, life: 0.6, radius: 15, pierce: 8, damage: 10.239 } },

      { id: 'chain_lightning', name: 'Chain Lightning', icon: '⚟', unlockLevel: 4, type: 'active', cooldown: 10,
        desc: 'Lightning jumps from enemy to enemy and hits up to 5.',
        failHint: 'Nothing in range to arc to',
        effect: { type: 'chainLightning', range: 330, jumps: 4, jumpRange: 320, falloff: 0.88, damage: 12.049 } },

      { id: 'flight', name: 'Flight', icon: '✦', unlockLevel: 5, type: 'toggle', trigger: 'Double-tap W', cooldown: 0,
        desc: 'Fly around. W goes up, S goes down, A and D steer. Double-tap W to land.' },

      { id: 'overcharge', name: 'Rapid Fire', icon: '◈', unlockLevel: 6, type: 'active', cooldown: 20,
        desc: 'Shoot twice as fast for 6s.',
        effect: { type: 'overcharge', duration: 6, fire: 2.0, dealt: 1.15 } },

      { id: 'thunderstrike', name: 'Lightning Strike', icon: '⚡', unlockLevel: 7, type: 'active', cooldown: 13,
        desc: 'Call down a huge bolt where you aim. It stuns enemies under it.',
        effect: { type: 'thunderStrike', radius: 165, windup: 0.45, stun: 0.9, damage: 15.839 } },

      { id: 'static_field', name: 'Shock Zone', icon: '⁘', unlockLevel: 8, type: 'active', cooldown: 18,
        desc: 'A zone that keeps stunning enemies inside it for 7s.',
        effect: { type: 'staticField', radius: 185, duration: 7, tick: 0.55, stun: 0.35, damage: 3.632 } },

      { id: 'lightning_rush', name: 'Lightning Dash', icon: '↯', unlockLevel: 9, type: 'active', cooldown: 12,
        desc: 'Zip forward instantly. Enemies in your way get hit.',
        failHint: 'Nowhere to rush to',
        effect: { type: 'lineDash', range: 520, width: 54, damage: 22.58 } },

      { id: 'ball_lightning', name: 'Ball Lightning', icon: '◍', unlockLevel: 10, type: 'active', cooldown: 20,
        desc: 'A slow floating ball that zaps enemies near it for 8s.',
        effect: { type: 'ballLightning', speed: 130, duration: 8, radius: 190, tick: 0.4, maxZaps: 3, damage: 5.405 } },

      { id: 'arc_tether', name: 'Shock Link', icon: '⌇', unlockLevel: 11, type: 'active', cooldown: 22,
        desc: 'Link yourself to 4 enemies. They take damage while you keep moving.',
        failHint: 'No enemy close enough to link',
        effect: { type: 'tether', count: 4, range: 330, breakRange: 520, duration: 7, damage: 0.928 } },

      { id: 'judgment', name: 'Lightning Storm', icon: '⩘', unlockLevel: 12, type: 'active', cooldown: 55,
        desc: 'Lots of lightning strikes hit a wide area.',
        effect: { type: 'judgment', width: 620, windup: 0.6, duration: 4, strikes: 22, radius: 130, damage: 4.343 } }
    ],

    /* ---------------------------------------------------------------- RAIN
       Volume and attrition. Rain rarely does much per hit — it just never
       stops, and it covers ground nothing else can. */
    rain: [
      { id: 'downpour', name: 'Downpour', icon: '⁝', unlockLevel: 2, type: 'active', cooldown: 7,
        desc: 'Heavy rain falls on a wide spot where you aim.',
        effect: { type: 'downpour', width: 260, windup: 0.35, duration: 1.8, count: 30, speed: 720, damage: 4.45 } },

      { id: 'drizzle_veil', name: 'Rain Cloak', icon: '◌', unlockLevel: 3, type: 'active', cooldown: 14,
        desc: 'A cloak of rain around you. It slows enemies that get close.',
        effect: { type: 'drizzleVeil', radius: 190, duration: 8, slow: 0.5 } },

      { id: 'cloudburst', name: 'Water Slam', icon: '⇩', unlockLevel: 4, type: 'active', cooldown: 10,
        desc: 'Drop a huge amount of water on one spot all at once.',
        effect: { type: 'cloudburst', width: 170, windup: 0.4, damage: 54.932 } },

      { id: 'flight', name: 'Flight', icon: '✦', unlockLevel: 5, type: 'toggle', trigger: 'Double-tap W', cooldown: 0,
        desc: 'Fly around. W goes up, S goes down, A and D steer. Double-tap W to land.' },

      { id: 'storm_cloud', name: 'Storm Cloud', icon: '☁', unlockLevel: 6, type: 'active', cooldown: 20,
        desc: 'A cloud follows you around and rains on enemies for 10s.',
        effect: { type: 'stormCloud', width: 190, height: 150, duration: 10, interval: 0.16, speed: 760, damage: 6.77 } },

      { id: 'puddles', name: 'Puddles', icon: '⋯', unlockLevel: 7, type: 'active', cooldown: 14,
        desc: 'Make 5 puddles on the ground. They slow and hurt enemies who walk through.',
        effect: { type: 'puddles', count: 5, spacing: 90, radius: 52, duration: 9, slow: 0.45, damage: 6.889 } },

      { id: 'hailstorm', name: 'Hailstorm', icon: '⁙', unlockLevel: 8, type: 'active', cooldown: 17,
        desc: 'Hail falls on a wide area for 3s. It can stun enemies.',
        effect: { type: 'hailstorm', width: 340, windup: 0.4, duration: 3, count: 20, radius: 70, stunChance: 0.35, damage: 11.26 } },

      { id: 'torrent', name: 'Torrent', icon: '⇓', unlockLevel: 9, type: 'active', cooldown: 16,
        desc: 'A heavy stream of water that holds enemies in place under it for 4s.',
        effect: { type: 'torrent', width: 130, duration: 4, damage: 13.731 } },

      { id: 'flood', name: 'Flood', icon: '≈', unlockLevel: 10, type: 'active', cooldown: 24,
        desc: 'Water rises around you and slows and hurts enemies standing in it.',
        effect: { type: 'flood', width: 720, height: 130, duration: 8, slow: 0.55, damage: 16.024 } },

      { id: 'monsoon', name: 'Monsoon', icon: '⁛', unlockLevel: 11, type: 'active', cooldown: 30,
        desc: 'Heavy rain follows you for 8s.',
        effect: { type: 'monsoon', width: 520, duration: 8, interval: 0.09, perDrop: 3, speed: 800, damage: 3.71 } },

      { id: 'deluge', name: 'Deluge', icon: '☔', unlockLevel: 12, type: 'active', cooldown: 55,
        desc: 'Rain, flood, and hail all at once for 9s.',
        effect: { type: 'deluge', width: 700, duration: 9, speed: 900, damage: 2.211 } }
    ]
  };

  /* Eleven slots. F stays free for interacting, WASD/Shift for movement. */
  const KEY_SLOTS = ['KeyQ', 'KeyE', 'KeyR', 'KeyT', 'KeyG', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN'];
  const KEY_LABELS = {
    KeyQ: 'Q', KeyE: 'E', KeyR: 'R', KeyT: 'T', KeyG: 'G', KeyZ: 'Z',
    KeyX: 'X', KeyC: 'C', KeyV: 'V', KeyB: 'B', KeyN: 'N'
  };

  /* ---- public API ----------------------------------------------------- */

  const Abilities = {
    byPower: BY_POWER,
    unlockTiers: TIERS,

    /* Full ability list for a power, sorted by unlock level, with input keys
       assigned to the active ones. */
    forPower(powerId) {
      const list = (BY_POWER[powerId] || []).slice();
      list.sort((a, b) => a.unlockLevel - b.unlockLevel);
      let slot = 0;
      return list.map((a) => {
        const copy = Object.assign({}, a);
        if (copy.type === 'active' && slot < KEY_SLOTS.length) {
          copy.key = KEY_SLOTS[slot];
          copy.keyLabel = KEY_LABELS[KEY_SLOTS[slot]];
          slot++;
        } else if (copy.type === 'toggle') {
          copy.keyLabel = 'W W';
        }
        return copy;
      });
    },

    get(powerId, abilityId) {
      return this.forPower(powerId).filter((a) => a.id === abilityId)[0] || null;
    },

    isUnlocked(ability, level) { return level >= ability.unlockLevel; },

    /* Attempt to cast. Returns true if it actually fired. */
    use(ability, caster, game, aimX, aimY) {
      if (!ability || ability.type !== 'active') return false;
      if (caster.level < ability.unlockLevel) return false;
      if ((caster.cooldowns[ability.id] || 0) > 0) return false;
      if (caster.stunTime > 0) return false;

      const handler = EFFECTS[ability.effect.type];
      if (!handler) {
        console.warn('Power Forge: unknown ability effect type "' + ability.effect.type + '"');
        return false;
      }
      const ok = handler(ability.effect, caster, game, aimX, aimY);
      if (!ok) {
        // A cast can legitimately fail (no ground, no target, no space). Say
        // why instead of eating the input, and don't burn the cooldown.
        if (caster.isPlayer && ability.failHint) {
          game.ui.toast(ability.name.toUpperCase(), ability.failHint);
        }
        return false;
      }

      caster.cooldowns[ability.id] = ability.cooldown;
      PF.Audio.ability();
      if (caster.isPlayer) game.ui.flashAbility(ability);
      return true;
    },

    effects: EFFECTS
  };

  PF.Abilities = Abilities;
})(window.PF);
