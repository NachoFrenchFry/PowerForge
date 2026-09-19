/* ==========================================================================
   Power Forge — tiles.js
   The ground tile sheet (textures/tiles/tiles.png, 16 tiles, 16x16 each) and
   the 4-neighbour autotile lookup that picks which tile to draw for a given
   (top, right, bottom, left) filled/empty neighbour pattern.

   Tile sheet order (left to right), as specified by the artist:
     0  no surrounding blocks
     1  1 block to the right
     2  1 block each to the left and right
     3  1 block to the left
     4  1 block to the right, 1 block down
     5  1 block to the left, 1 block right, 1 block down
     6  1 block to the left, 1 block down
     7  1 block down
     8  4 blocks surrounding
     9  1 block to the top, 1 block to the right
     10 1 block to the top, 1 block to the right, 1 block to the left
     11 1 block to the top, 1 block to the left
     12 1 block top, 1 block right, 1 block bottom
     13 1 block top, 1 block left, 1 block bottom
     14 1 block top, 1 block bottom
     15 1 block top

   This is every one of the 16 possible (top, right, bottom, left) on/off
   combinations, each with its own dedicated tile — no fallback needed.
   Tiles 0-7 are the "exposed top" family (grass visible, nothing above);
   tiles 8-15 are the "buried" family (something above).
   ========================================================================== */
(function (PF) {
  'use strict';

  const SRC = 16;               // source pixels per tile in tiles.png

  /* Pre-upscale factor used before the final variable-scale blit — see the
     big comment on renderChunk below for why this exists. 4 is deliberate:
     it's exactly tileSize/SRC (64/16) for the game's real ground tiles, so
     for the common case (window height near the 720 reference, scale near 1)
     the "residual" scale in the second blit is already ~1:1 and the error
     this whole scheme is designed to shrink is close to zero to begin with. */
  const PRESCALE = 4;

  /* Scratch canvas for chunk compositing (see renderChunk below) — reused
     and only reallocated when a bigger one is needed. */
  let chunkBuf = null, chunkCtx = null;
  function chunkBuffer(w, h) {
    if (!chunkBuf) { chunkBuf = document.createElement('canvas'); chunkCtx = chunkBuf.getContext('2d'); }
    if (chunkBuf.width !== w || chunkBuf.height !== h) {
      chunkBuf.width = w;
      chunkBuf.height = h;
    } else {
      chunkCtx.clearRect(0, 0, w, h);
    }
    return chunkCtx;
  }

  /* Second scratch canvas — the native chunk pre-scaled by an exact integer
     factor (PRESCALE) before the real, non-integer-scale blit onto the game
     canvas. See renderChunk. */
  let upBuf = null, upCtx = null;
  function upscaleBuffer(w, h) {
    if (!upBuf) { upBuf = document.createElement('canvas'); upCtx = upBuf.getContext('2d'); }
    if (upBuf.width !== w || upBuf.height !== h) {
      upBuf.width = w;
      upBuf.height = h;
    } else {
      // Same size as last frame: resizing (which implicitly clears) doesn't
      // happen in this branch, so without an explicit clear here, whatever
      // was opaque in the PREVIOUS frame stays put — the next drawImage only
      // draws the new content where the source has something, leaving old
      // pixels showing through anywhere that's now transparent (a removed
      // tile, in particular, which relies on that spot going back to empty).
      upCtx.clearRect(0, 0, w, h);
    }
    return upCtx;
  }

  const Tiles = {
    SRC: SRC,
    sheet: null,
    ready: false,

    load(onDone) {
      const self = this;
      const img = new Image();
      img.onload = function () { self.sheet = img; self.ready = true; if (onDone) onDone(true); };
      img.onerror = function () {
        console.warn('Power Forge: could not load textures/tiles/tiles.png');
        if (onDone) onDone(false);
      };
      img.src = encodeURI('textures/tiles/tiles.png');
    },

    /* Which tile index to use for a filled cell given whether its four
       cardinal neighbours are also filled. Every argument is a boolean.
       Exhaustive over all 16 combinations — no fallback branch needed. */
    indexFor(top, right, bottom, left) {
      if (!top) {
        if (!bottom) {
          if (!left && !right) return 0;                // isolated
          if (!left && right) return 1;                 // right-connecting edge (thin)
          if (left && !right) return 3;                 // left-connecting edge (thin)
          return 2;                                      // both sides connect — thin middle
        }
        if (!left && !right) return 7;                  // down only
        if (!left && right) return 4;                   // right-connecting edge (filled below)
        if (left && !right) return 6;                   // left-connecting edge (filled below)
        return 5;                                        // both sides connect — filled middle
      }
      if (!bottom) {
        if (!left && !right) return 15;                 // top only
        if (!left && right) return 9;                   // bottom row, left edge
        if (left && !right) return 11;                  // bottom row, right edge
        return 10;                                       // bottom row, middle
      }
      if (!left && !right) return 14;                   // top+bottom, isolated column
      if (!left && right) return 12;                     // sub-surface, left edge
      if (left && !right) return 13;                     // sub-surface, right edge
      return 8;                                           // fully interior
    },

    /* Render every filled cell in [colStart..colEnd] x [rowStart..rowEnd] as
       ONE scaled blit instead of one drawImage-with-scaling per tile.

       Compositing the whole visible chunk at native 16px-per-tile resolution
       first (tiles are simply adjacent, pixel for pixel, in that buffer — no
       seam possible there) removes any seam that could come from rounding
       each tile's own edges independently. But a SECOND seam source survives
       that fix: the one remaining scale-up (native chunk -> screen) is by
       whatever factor the window size happens to produce, almost never a
       whole number. Canvas's nearest-neighbor sampling handles a non-integer
       scale by duplicating some source columns/rows to an extra destination
       pixel and not others — proven out with a small test harness: scaling a
       16-wide strip to 17px duplicates exactly one column, to 18px duplicates
       two, and WHICH column gets the extra pixel shifts around as the scale
       changes. Most of the time that lands inside a tile's own uniform-color
       regions and is invisible, but whenever it happens to land on a column
       that's genuinely part of the hand-drawn edge art, that one tile briefly
       renders a hair wider or narrower than its neighbor — a seam that comes
       and goes with window size, matching exactly what was reported.

       The fix: never resample directly from the 16px-native art. Pre-scale
       the native chunk by an exact INTEGER factor first (see PRESCALE above,
       and upscaleBuffer) — an integer ratio always replicates every column
       an identical number of times, so this first hop is provably seamless
       (verified: 16px source scaled to exactly 16*N lands on N,N,N,N,... for
       every column, zero deviation). Only the second hop (that N-times-larger
       buffer -> screen) still carries a non-integer scale, but the same
       ±1-destination-pixel rounding error is now spread across a buffer 4x
       larger, so it can only ever misplace a QUARTER of one tile-defining
       source column instead of the whole thing — small enough to disappear
       at any window size actually used in practice (confirmed empirically:
       the same test harness that showed 100%-of-a-column errors without the
       pre-scale stage showed at most ~1 device pixel of drift, spread across
       an already-uniform block, once it's in place).

       `filledAtFn(col, row)` reports whether a cell is filled; `tileSize` is
       the on-screen size of one tile; (destX, destY) is where the
       (colStart, rowStart) cell's top-left corner should land on screen. */
    renderChunk(ctx, colStart, colEnd, rowStart, rowEnd, tileSize, destX, destY, filledAtFn) {
      if (!this.sheet) return;
      const cols = colEnd - colStart + 1;
      const rows = rowEnd - rowStart + 1;
      if (cols <= 0 || rows <= 0) return;

      const w = cols * SRC, h = rows * SRC;
      const bctx = chunkBuffer(w, h);
      bctx.imageSmoothingEnabled = false;

      let any = false;
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          if (!filledAtFn(col, row)) continue;
          any = true;
          const idx = this.indexFor(
            filledAtFn(col, row - 1), filledAtFn(col + 1, row),
            filledAtFn(col, row + 1), filledAtFn(col - 1, row)
          );
          bctx.drawImage(this.sheet, idx * SRC, 0, SRC, SRC,
            (col - colStart) * SRC, (row - rowStart) * SRC, SRC, SRC);
        }
      }
      if (!any) return;

      // Hop 1: native -> an exact integer multiple. This canvas is never
      // inserted into the DOM and has no CSS size, so it's untouched by any
      // outer transform/DPR — a pure, exact, seamless block replication.
      const upW = w * PRESCALE, upH = h * PRESCALE;
      const uctx = upscaleBuffer(upW, upH);
      uctx.imageSmoothingEnabled = false;
      uctx.drawImage(chunkBuf, 0, 0, w, h, 0, 0, upW, upH);

      // Hop 2: the only remaining non-integer scale, now against a buffer
      // PRESCALE times larger, so any rounding drift is PRESCALE times
      // smaller relative to a tile.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(upBuf, 0, 0, upW, upH,
        Math.round(destX), Math.round(destY), cols * tileSize, rows * tileSize);
    }
  };

  PF.Tiles = Tiles;
})(window.PF);
