/* ==========================================================================
   Power Forge — utils.js
   Shared math, geometry and drawing helpers. Everything hangs off the global
   PF namespace so the game runs from file:// without a module loader.
   ========================================================================== */
window.PF = window.PF || {};

(function (PF) {
  'use strict';

  const U = {
    /* Logical (design) resolution. All gameplay math uses these units, the
       canvas is simply scaled to fit the window. */
    GW: 1280,
    GH: 720,

    /* ---- numbers ---- */
    clamp(v, a, b) { return v < a ? a : (v > b ? b : v); },
    lerp(a, b, t) { return a + (b - a) * t; },
    /* Frame-rate independent smoothing (exponential decay). */
    damp(a, b, lambda, dt) { return U.lerp(a, b, 1 - Math.exp(-lambda * dt)); },
    approach(a, b, amount) { return a < b ? Math.min(a + amount, b) : Math.max(a - amount, b); },
    rand(a, b) { return a + Math.random() * (b - a); },
    randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },
    pick(arr) { return arr[(Math.random() * arr.length) | 0]; },
    chance(p) { return Math.random() < p; },
    sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); },
    fmt(n) { return Math.round(n).toLocaleString('en-US'); },

    /* ---- colour ---- */
    rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; },
    rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; },
    mix(c1, c2, t) {
      return [
        Math.round(U.lerp(c1[0], c2[0], t)),
        Math.round(U.lerp(c1[1], c2[1], t)),
        Math.round(U.lerp(c1[2], c2[2], t))
      ];
    },

    /* ---- geometry ---- */
    aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    },
    pointInRect(px, py, r) {
      return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    },
    circleRect(cx, cy, r, rect) {
      const nx = U.clamp(cx, rect.x, rect.x + rect.w);
      const ny = U.clamp(cy, rect.y, rect.y + rect.h);
      const dx = cx - nx, dy = cy - ny;
      return dx * dx + dy * dy <= r * r;
    },
    dist(ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay;
      return Math.sqrt(dx * dx + dy * dy);
    },
    dist2(ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay;
      return dx * dx + dy * dy;
    },
    /* Centre point of an entity/rect. */
    cx(e) { return e.x + e.w * 0.5; },
    cy(e) { return e.y + e.h * 0.5; },

    /* ---- canvas ---- */
    roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    },
    /* Simple star/burst polygon used for impacts and crystals. */
    starPath(ctx, x, y, spikes, outer, inner, rot) {
      ctx.beginPath();
      const step = Math.PI / spikes;
      let a = rot || -Math.PI / 2;
      ctx.moveTo(x + Math.cos(a) * outer, y + Math.sin(a) * outer);
      for (let i = 0; i < spikes; i++) {
        a += step;
        ctx.lineTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
        a += step;
        ctx.lineTo(x + Math.cos(a) * outer, y + Math.sin(a) * outer);
      }
      ctx.closePath();
    },
    /* Jagged polyline — lightning bolts, cracks. */
    boltPath(ctx, x1, y1, x2, y2, segments, jitter, seed) {
      let s = seed || 1;
      const rnd = () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647 - 0.5;
      };
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const nx = -(y2 - y1), ny = (x2 - x1);
        const len = Math.hypot(nx, ny) || 1;
        const off = rnd() * jitter;
        ctx.lineTo(
          U.lerp(x1, x2, t) + (nx / len) * off,
          U.lerp(y1, y2, t) + (ny / len) * off
        );
      }
      ctx.lineTo(x2, y2);
    }
  };

  PF.U = U;
})(window.PF);
