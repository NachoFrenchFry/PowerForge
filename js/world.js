/* ==========================================================================
   Power Forge — world.js
   Areas (currently just the hub), tile-grid ground, collision, and the
   camera. Areas are plain data; the Area class turns them into a playable
   space. The ground is a tile grid (see tiles.js for the autotile lookup);
   for now every area is a uniform flat fill computed analytically rather
   than stored as an explicit 2D array, but `tileGrid` (an explicit array of
   rows) is supported too so a level exported from the level editor can be
   dropped in later without touching this file again.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const SKY_BLUE = '#6ec6ff';

  /* ---- physics -------------------------------------------------------- */

  const Physics = {
    GRAVITY: 2200,
    MAX_FALL: 1500,

    step(e, area, dt) {
      const solids = area.solids();

      /* --- horizontal --- */
      e.x += e.vx * dt;
      e.hitWall = false;
      for (let i = 0; i < solids.length; i++) {
        const s = solids[i];
        if (!U.aabb(e, s)) continue;

        if (e.vx > 0) e.x = s.x - e.w;
        else if (e.vx < 0) e.x = s.x + s.w;
        else {
          // Pushed into a wall that appeared around us — eject the short way.
          const leftOut = s.x - e.w, rightOut = s.x + s.w;
          e.x = (Math.abs(e.x - leftOut) < Math.abs(e.x - rightOut)) ? leftOut : rightOut;
        }
        e.vx = 0;
        e.hitWall = true;
      }
      e.x = U.clamp(e.x, 0, area.width - e.w);

      /* --- vertical ---
         Every platform is fully solid: you land on top, you bonk underneath,
         and the only way down is off the edge. */
      e.y += e.vy * dt;
      const wasGrounded = e.onGround;
      e.onGround = false;

      for (let i = 0; i < solids.length; i++) {
        const s = solids[i];
        if (!U.aabb(e, s)) continue;
        if (e.vy >= 0) { e.y = s.y - e.h; e.vy = 0; e.onGround = true; }
        else { e.y = s.y + s.h; e.vy = 0; }
      }

      if (e.onGround && !wasGrounded && e.landCallback) e.landCallback();
      return e;
    }
  };

  /* ---- area ----------------------------------------------------------- */

  class Area {
    constructor(def) {
      this.def = def;
      this.id = def.id;
      this.name = def.name;
      this.theme = def.theme;
      this.width = def.width;
      this.height = def.height;
      this.groundY = def.groundY;
      this.minY = def.minY == null ? -400 : def.minY;   // how far the camera may rise
      this.spawn = def.spawn;
      this.portals = (def.portals || []).map((p) => Object.assign({}, p));

      this.tileSize = def.tileSize || 64;
      this.groundDepthTiles = def.groundDepthTiles == null ? 12 : def.groundDepthTiles;
      this.tilesWide = Math.ceil(this.width / this.tileSize);
      // An explicit 2D grid (array of rows, each an array/typed-array of
      // 0/1, row 0 = the surface) overrides the analytic flat fill below —
      // this is the hook a future level-editor export plugs into.
      this.tileGrid = def.tileGrid || null;
      this.noMobZone = def.noMobZone || null;       // { x0, x1 } — nothing spawns in here
      this.peacefulZone = def.peacefulZone || null; // { x0, x1 } fallback ranges when there's
      this.hostileZone = def.hostileZone || null;   // no painted mask; they may overlap
      // Per-tile spawn masks painted in the level editor:
      // { peaceful: [rowArrays], hostile: [rowArrays] }. Overrides the zones.
      this.spawnMask = def.spawnMask || null;

      this.platforms = [];  // collision geometry — everything is solid
      this.temp = [];        // ability-created walls
      this._solids = [];

      // Ground strips become solid platforms with a tall body under them.
      for (const g of def.ground) {
        this.platforms.push({
          x: g[0], y: def.groundY, w: g[1] - g[0], h: def.height - def.groundY + 200, kind: 'ground'
        });
      }
      for (const p of def.platforms || []) {
        this.platforms.push({ x: p[0], y: p[1], w: p[2], h: p[3], kind: p[4] || 'plate' });
      }
      this._rebuild();

      this.time = 0;
    }

    _rebuild() {
      this._solids = this.platforms.concat(this.temp);
    }

    solids() { return this._solids; }

    /* Ability-created temporary solid geometry (was Sand's old wall ability;
       nothing currently uses it — see the removal note on abilities.js's
       `gritCone`). Only the PLAYER actually collides with this: Physics.step
       (which reads solids()) is called from entity.js's applyPhysics, which
       only the Player subclass drives — mobs.js moves mobs by hand and never
       consults solids() at all. A future "wall" ability needs mob-side
       collision added first, or it'll block the caster and nobody else. */
    addTempSolid(rect) { this.temp.push(rect); this._rebuild(); }
    removeTempSolid(rect) {
      const i = this.temp.indexOf(rect);
      if (i >= 0) { this.temp.splice(i, 1); this._rebuild(); }
    }
    clearTemp() { this.temp.length = 0; this._rebuild(); }

    hitsSolid(x, y, r) {
      const s = this._solids;
      for (let i = 0; i < s.length; i++) if (U.circleRect(x, y, r, s[i])) return true;
      return false;
    }

    rectBlocked(x, y, w, h) {
      const box = { x: x, y: y, w: w, h: h };
      const s = this._solids;
      for (let i = 0; i < s.length; i++) if (U.aabb(box, s[i])) return true;
      return false;
    }

    /* Is there floor within `look` pixels below this point? Used by bot AI to
       avoid walking into pits. */
    groundAhead(x, y, look) {
      const probe = { x: x - 6, y: y, w: 12, h: look };
      for (const s of this._solids) if (U.aabb(probe, s)) return true;
      return false;
    }

    portalAt(entity) {
      for (const p of this.portals) if (U.aabb(entity, p)) return p;
      return null;
    }

    /* ---- tile grid ----
       (col, row) are grid coordinates — row 0 is the surface row, growing
       downward. World pixel position of a cell's top-left corner is
       (col*tileSize, groundY + row*tileSize). */
    filledAt(col, row) {
      if (row < 0) return false;
      if (this.tileGrid) {
        const r = this.tileGrid[row];
        return !!(r && r[col]);
      }
      if (col < 0 || col >= this.tilesWide) return false;
      return row < this.groundDepthTiles;
    }

    update(dt) {
      this.time += dt;
      // Expire temporary walls.
      for (let i = this.temp.length - 1; i >= 0; i--) {
        const w = this.temp[i];
        w.time -= dt;
        if (w.time <= 0) { this.temp.splice(i, 1); this._rebuild(); }
      }
    }

    /* ---- rendering ---- */

    renderBackground(ctx) {
      // Sky blue and nothing else.
      ctx.fillStyle = SKY_BLUE;
      ctx.fillRect(0, 0, U.GW, U.GH);
    }

    renderAmbient() { /* no ambient decoration in the open-world pass */ }

    renderTerrain(ctx, cam) {
      const ts = this.tileSize;
      const Tiles = PF.Tiles;
      if (!Tiles || !Tiles.ready) return;

      const colStart = Math.max(0, Math.floor((cam.x) / ts) - 1);
      const colEnd = Math.min(this.tilesWide - 1, Math.floor((cam.x + U.GW) / ts) + 1);
      const rowStart = Math.max(0, Math.floor((cam.y - this.groundY) / ts) - 1);
      const rowEnd = Math.floor((cam.y + U.GH - this.groundY) / ts) + 1;

      // One composited-then-scaled blit for the whole visible range instead
      // of one scaled drawImage per tile — see tiles.js's renderChunk for
      // why that's what actually kills the inter-tile seams.
      Tiles.renderChunk(
        ctx, colStart, colEnd, rowStart, rowEnd, ts,
        colStart * ts, this.groundY + rowStart * ts,
        (col, row) => this.filledAt(col, row)
      );

      // Temporary ability walls (sand).
      for (const w of this.temp) {
        const a = U.clamp(w.time / 0.6, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        const grad = ctx.createLinearGradient(w.x, 0, w.x + w.w, 0);
        grad.addColorStop(0, U.rgba(w.colors.dark, 1));
        grad.addColorStop(0.5, U.rgba(w.colors.primary, 1));
        grad.addColorStop(1, U.rgba(w.colors.dark, 1));
        ctx.fillStyle = grad;
        U.roundRect(ctx, w.x, w.y, w.w, w.h, 6);
        ctx.fill();
        ctx.strokeStyle = U.rgba(w.colors.secondary, 0.8);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = U.rgba(w.colors.secondary, 0.12);
        for (let y = w.y + 8; y < w.y + w.h; y += 18) {
          ctx.fillRect(w.x + 4, y, w.w - 8, 5);
        }
        ctx.restore();
      }
    }

    renderProps(ctx, cam) {
      // Portals only, for now — no signs, no lamps, no buildings.
      for (const p of this.portals) this._drawPortal(ctx, p);
    }

    _drawPortal(ctx, p) {
      const t = this.time;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      const col = p.color || [255, 170, 70];
      ctx.save();
      // Frame.
      ctx.fillStyle = '#2a3040';
      U.roundRect(ctx, p.x - 12, p.y - 14, p.w + 24, p.h + 16, 10);
      ctx.fill();
      ctx.strokeStyle = U.rgba(col, 0.7);
      ctx.lineWidth = 3;
      ctx.stroke();

      // Swirling gate.
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, p.w * 0.9);
      g.addColorStop(0, U.rgba(col, 0.85));
      g.addColorStop(0.5, U.rgba(col, 0.32));
      g.addColorStop(1, U.rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - 40, p.y - 40, p.w + 80, p.h + 80);

      ctx.strokeStyle = U.rgba(col, 0.85);
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const r = (p.w * 0.22) + i * 12 + Math.sin(t * 2 + i) * 5;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 1.5, Math.sin(t + i) * 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      // Label plate.
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '800 13px "PowerForge", "Trebuchet MS", sans-serif';
      ctx.fillStyle = 'rgba(10,12,18,0.75)';
      const tw = ctx.measureText(p.label).width + 22;
      U.roundRect(ctx, cx - tw / 2, p.y - 44, tw, 22, 6);
      ctx.fill();
      ctx.fillStyle = U.rgba(col, 1);
      ctx.fillText(p.label, cx, p.y - 29);
      ctx.restore();
    }
  }

  /* ---- camera ---------------------------------------------------------- */

  class Camera {
    constructor() {
      this.x = 0; this.y = 0;
      this.shakeAmp = 0; this.shakeTime = 0;
      this.ox = 0; this.oy = 0;
    }

    snapTo(target, area) {
      this.x = U.clamp(U.cx(target) - U.GW / 2, 0, Math.max(0, area.width - U.GW));
      this.y = U.clamp(U.cy(target) - U.GH * 0.58, area.minY, Math.max(area.minY, area.height - U.GH));
    }

    follow(target, area, dt) {
      // Lead the camera slightly in the direction of travel.
      const lead = U.clamp(target.vx * 0.22, -170, 170);
      const tx = U.cx(target) + lead - U.GW / 2;
      const ty = U.cy(target) - U.GH * 0.58;
      this.x = U.damp(this.x, tx, 6.5, dt);
      this.y = U.damp(this.y, ty, 5, dt);
      this.x = U.clamp(this.x, 0, Math.max(0, area.width - U.GW));
      this.y = U.clamp(this.y, area.minY, Math.max(area.minY, area.height - U.GH));

      if (this.shakeTime > 0) {
        this.shakeTime -= dt;
        const k = Math.max(0, this.shakeTime) * this.shakeAmp;
        this.ox = U.rand(-k, k);
        this.oy = U.rand(-k, k);
      } else { this.ox = 0; this.oy = 0; }
    }

    shake(amp, time) {
      if (amp * time > this.shakeAmp * this.shakeTime) {
        this.shakeAmp = amp * (1 / Math.max(0.05, time));
        this.shakeTime = time;
      }
    }
  }

  /* ---- area definitions ------------------------------------------------ */

  /* Tile render size (64px) and ground depth (12 tiles) are starting points
     — bump them if the world should feel chunkier/thinner. The hub's actual
     width/terrain now comes from decoding HUB_MAP_CODE below (a level-editor
     export), not an analytic flat fill — see AREA_DEFS. */
  const TILE_SIZE = 64;
  const GROUND_DEPTH_TILES = 12;
  const HUB_GROUND_Y = 640;

  /* No wildlife spawns in this many tiles at the world's left edge — the
     user's setting up an area-transition zone there for later. */
  const NO_MOB_TILES = 20;

  /* Turn a level-editor export code into the fields an area def wants.
     Handles both format versions: v2 carries the two spawn masks alongside
     the terrain, v1 is terrain only and comes back with spawnMask null (so
     the area falls through to its peacefulZone/hostileZone ranges).

       Object.assign(PF.AreaDefs.hub, PF.decodeLevelCode(code));

     The masks are stored exactly as painted; mobs.js is what enforces the
     "air with solid ground directly beneath" rule at spawn time, so a stray
     mark up in the sky costs nothing but a wasted byte.

     `decodeRows`/`platformsFromGrid`/`decodeLevelCode` are plain function
     declarations (not const arrow functions) specifically so they're hoisted
     — AREA_DEFS below calls decodeLevelCode() while building the hub's
     def, which textually comes before this point in the file but works
     because of that hoisting. */
  function decodeRows(src, w, h) {
    if (!src) return null;
    const g = new Array(h);
    for (let r = 0; r < h; r++) {
      const row = src[r] || '';
      const out = new Uint8Array(w);
      for (let c = 0; c < w; c++) out[c] = row.charCodeAt(c) === 49 ? 1 : 0;
      g[r] = out;
    }
    return g;
  }

  /* Column-by-column collision, generated from a decoded tileGrid. The
     VISUAL tile system (filledAt/renderChunk) already handles arbitrary
     painted shapes, but actual movement collision is a separate list of
     rectangles (Area.platforms) — without this, a painted hill is just
     wallpaper the player falls straight through.

     Painted terrain isn't always one solid column from its surface down —
     a floating tuft, overhang, or disconnected chunk leaves empty rows
     underneath it before the real ground resumes. So each column is split
     into its individual vertical runs of filled cells (not just "topmost
     filled row down"), and only the LOWEST run in a column extends past its
     own bottom (the +400 margin, so falling/knockback still has room before
     the world's own floor). Any run above that is bounded to exactly its
     own painted extent, so the open space underneath it stays walkable.
     Columns sharing an identical run pattern are then merged sideways into
     as few rectangles as possible, same as the old run-length compression —
     a staircase silhouette still collapses to a handful of wide slabs. */
  function platformsFromGrid(grid, w, h, tileSize, groundY) {
    const colRuns = new Array(w);
    for (let c = 0; c < w; c++) {
      const runs = [];
      let r = 0;
      while (r < h) {
        if (grid[r] && grid[r][c]) {
          const top = r;
          while (r < h && grid[r] && grid[r][c]) r++;
          runs.push([top, r - 1]);
        } else {
          r++;
        }
      }
      colRuns[c] = runs;
    }

    const runsEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let k = 0; k < a.length; k++) {
        if (a[k][0] !== b[k][0] || a[k][1] !== b[k][1]) return false;
      }
      return true;
    };

    const rects = [];
    let i = 0;
    while (i < w) {
      if (colRuns[i].length === 0) { i++; continue; }
      let j = i;
      while (j + 1 < w && runsEqual(colRuns[j + 1], colRuns[i])) j++;
      const runs = colRuns[i];
      for (let k = 0; k < runs.length; k++) {
        const top = runs[k][0], bottom = runs[k][1];
        const y = groundY + top * tileSize;
        const isLowest = k === runs.length - 1;
        const rectH = isLowest ? (h - top) * tileSize + 400 : (bottom - top + 1) * tileSize;
        rects.push([i * tileSize, y, (j - i + 1) * tileSize, rectH]);
      }
      i = j + 1;
    }
    return rects;
  }

  /* `groundY` defaults to the hub's own reference surface (640) since that's
     the only area this currently feeds; pass a different one explicitly if
     a future area uses a different baseline. */
  function decodeLevelCode(code, groundY) {
    const data = JSON.parse(decodeURIComponent(escape(atob(String(code).trim()))));
    const w = data.w, h = data.h;
    const gy = groundY == null ? HUB_GROUND_Y : groundY;
    const peaceful = decodeRows(data.peaceful, w, h);
    const hostile = decodeRows(data.hostile, w, h);
    const tileGrid = decodeRows(data.rows, w, h);
    return {
      width: w * TILE_SIZE,
      // +400 below the lowest painted row so falling/knockback has margin
      // before the "you fell out of the world" check — same margin the old
      // flat-ground slabs and platformsFromGrid's own rects use.
      height: gy + h * TILE_SIZE + 400,
      groundY: gy,
      tilesWide: w,
      tileGrid: tileGrid,
      ground: [],
      platforms: platformsFromGrid(tileGrid, w, h, TILE_SIZE, gy),
      spawnMask: (peaceful || hostile) ? { peaceful: peaceful, hostile: hostile } : null
    };
  }

  /* A level-editor export: a stepped hill sitting on a flat floor, used to
     verify painted terrain (not just the flat analytic fill) actually
     renders AND collides correctly. Swap this for a different exported
     code, or delete the Object.assign below, to go back to a plain flat
     hub. */
  const HUB_MAP_CODE = 'eyJ2IjoyLCJ3IjoyMDAsImgiOjMwLCJyb3dzIjpbIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDExMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDExMTEwMDExMTExMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTExMTExMDAxMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDExMTExMTExMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDExMTExMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTExMTExMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTExMTExMTExMDAwMDAxMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDExMTExMTAxMTExMTExMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTExMTExMTExMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTExMTExMTAwMDAxMTEwMDAwMDExMTExMTExMTExMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTAwMDAxMTExMTExMTExMTExMTExMTExMTExMTExMDAwMDAwMDExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIiwiMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMDAwMDExMTExMTExMTExMTExMTExMTExMTExMTEwMDAwMDExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMDAwMDExMTExMTExMTExMTExMTExMTExMTExMTAwMDAxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSIsIjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMDAwMDAxMTExMTExMTExMTExMTExMTEwMDAwMDAxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSIsIjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIiwiMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSIsIjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIiwiMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSJdLCJwZWFjZWZ1bCI6WyIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMTAwMDAwMTExMTExMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDExMTExMTExMDAwMDExMTAwMDAwMTAwMDAwMDAwMDAwMDAwMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMDAwMDAwMTExMTEwMDAwMDAwMDAwMDAwMDAwMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIl0sImhvc3RpbGUiOlsiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTExMTExMTExMTExMTExMTExMTExMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiXX0=';

  const HUB_DECODED = decodeLevelCode(HUB_MAP_CODE, HUB_GROUND_Y);

  const AREA_DEFS = {
    hub: Object.assign(
      {
        id: 'hub', name: 'THE FORGE YARD', theme: 'forge',
        minY: -560,
        tileSize: TILE_SIZE,
        groundDepthTiles: GROUND_DEPTH_TILES,
        portals: []
      },
      HUB_DECODED,
      {
        // Fields the decoded map can't know on its own: where the player
        // starts, and the spawn zones (only used as a fallback where the
        // map's own painted spawnMask doesn't cover a kind — see
        // decodeLevelCode's comment). Sized to fit THIS map's actual
        // width, not the old flat hub's — recompute if HUB_MAP_CODE
        // changes.
        spawn: { x: 600, y: 1578 },
        noMobZone: { x0: 0, x1: NO_MOB_TILES * TILE_SIZE },
        peacefulZone: { x0: NO_MOB_TILES * TILE_SIZE, x1: 200 * TILE_SIZE - 200 },
        hostileZone: { x0: 125 * TILE_SIZE, x1: 200 * TILE_SIZE - 200 }
      }
    )
  };


  PF.Physics = Physics;
  PF.Area = Area;
  PF.Camera = Camera;
  PF.AreaDefs = AREA_DEFS;
  PF.createArea = function (id) {
    const def = AREA_DEFS[id];
    if (!def) throw new Error('Unknown area: ' + id);
    const area = new Area(def);
    area.minY = def.minY;
    return area;
  };
})(window.PF);
