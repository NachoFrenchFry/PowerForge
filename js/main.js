/* ==========================================================================
   Power Forge — main.js
   Bootstrap. Everything else is already registered on the PF namespace by
   the time this runs.
   ========================================================================== */
(function (PF) {
  'use strict';

  /* DOM text just reflows whenever a @font-face webfont finishes loading,
     but canvas text (combat.js's damage numbers, world.js's area label)
     doesn't get that for free — a draw call issued before the font is
     actually ready silently falls back for that frame, then jumps to the
     real face once it lands. Kicking off the load explicitly, this early,
     means it's almost always resolved long before the player reaches
     anything drawn on the canvas. */
  if (document.fonts && document.fonts.load) {
    document.fonts.load('16px "PowerForge"').catch(() => {});
  }

  function boot() {
    const canvas = document.getElementById('game');
    if (!canvas || !canvas.getContext) {
      document.body.innerHTML =
        '<div style="color:#fff;font:16px sans-serif;padding:40px">' +
        'Power Forge needs a browser with HTML5 canvas support.</div>';
      return;
    }

    const game = new PF.Game(canvas);
    PF.game = game;          // handy for debugging from the console
    game.init();
    game.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.PF);
