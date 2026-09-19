/* ==========================================================================
   Power Forge — input.js
   Keyboard + mouse. Mouse coordinates are converted into the fixed logical
   game resolution so aiming stays accurate at any window size.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;

  const Input = {
    keys: Object.create(null),        // held keys, by KeyboardEvent.code
    pressedKeys: Object.create(null), // keys that went down this frame
    mouse: {
      x: U.GW * 0.5, y: U.GH * 0.5, down: false, pressed: false, released: false,
      rightDown: false, rightPressed: false, rightReleased: false
    },

    /* Double-tap W (flight toggle). Consumed by the player each frame. */
    doubleTapUp: false,
    _lastUpTap: -10,
    DOUBLE_TAP_WINDOW: 0.32,

    _canvas: null,
    _time: 0,
    enabled: true,

    init(canvas) {
      this._canvas = canvas;

      window.addEventListener('keydown', (e) => {
        // Keep browser shortcuts for reload/devtools usable.
        const code = e.code;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].indexOf(code) >= 0) e.preventDefault();
        // Only swallow the function keys the dev tools actually use — F5 and
        // F12 stay available for reload / devtools.
        if (['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].indexOf(code) >= 0) e.preventDefault();
        if (e.repeat) return;

        this.keys[code] = true;
        this.pressedKeys[code] = true;

        if (code === 'KeyW' || code === 'ArrowUp') {
          if (this._time - this._lastUpTap <= this.DOUBLE_TAP_WINDOW) {
            this.doubleTapUp = true;
            this._lastUpTap = -10; // reset so a third tap doesn't chain
          } else {
            this._lastUpTap = this._time;
          }
        }
        PF.Audio.unlock();
      });

      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

      // Losing focus must clear held keys or the player runs away on their own.
      window.addEventListener('blur', () => {
        this.keys = Object.create(null);
        this.mouse.down = false;
        this.mouse.rightDown = false;
      });

      const updateMouse = (e) => {
        const r = canvas.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        this.mouse.x = U.clamp((e.clientX - r.left) / r.width * U.GW, 0, U.GW);
        this.mouse.y = U.clamp((e.clientY - r.top) / r.height * U.GH, 0, U.GH);
      };

      window.addEventListener('mousemove', updateMouse);
      window.addEventListener('mousedown', (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        updateMouse(e);
        // Ignore clicks that land on menu UI above the canvas.
        if (e.target !== canvas && e.target !== document.body) return;
        if (e.button === 0) {
          this.mouse.down = true;
          this.mouse.pressed = true;
        } else {
          this.mouse.rightDown = true;
          this.mouse.rightPressed = true;
        }
        PF.Audio.unlock();
      });
      window.addEventListener('mouseup', (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        if (e.button === 0) {
          this.mouse.down = false;
          this.mouse.released = true;
        } else {
          this.mouse.rightDown = false;
          this.mouse.rightReleased = true;
        }
      });
      // A stray right-click shouldn't pop the browser menu mid-fight.
      const blockMenu = (e) => {
        if (e.target === canvas || e.target === document.body) e.preventDefault();
      };
      canvas.addEventListener('contextmenu', blockMenu);
      window.addEventListener('contextmenu', blockMenu);
    },

    tick(dt) { this._time += dt; },

    down(code) { return !!this.keys[code] && this.enabled; },
    /* True only on the frame the key went down. */
    pressed(code) { return !!this.pressedKeys[code] && this.enabled; },

    /* Convenience aliases so gameplay code reads clearly. */
    left() { return this.down('KeyA') || this.down('ArrowLeft'); },
    right() { return this.down('KeyD') || this.down('ArrowRight'); },
    up() { return this.down('KeyW') || this.down('ArrowUp'); },
    downKey() { return this.down('KeyS') || this.down('ArrowDown'); },
    jumpPressed() { return this.pressed('KeyW') || this.pressed('ArrowUp'); },

    consumeDoubleTapUp() {
      if (this.doubleTapUp) { this.doubleTapUp = false; return true; }
      return false;
    },

    /* True only on the frame the right mouse button went down. */
    rightPressed() { return !!this.mouse.rightPressed && this.enabled; },

    /* Called at the very end of each frame. */
    endFrame() {
      this.pressedKeys = Object.create(null);
      this.mouse.pressed = false;
      this.mouse.released = false;
      this.mouse.rightPressed = false;
      this.mouse.rightReleased = false;
      this.doubleTapUp = false;
    },

    /* Wipe transient state when switching screens/areas. */
    reset() {
      this.keys = Object.create(null);
      this.pressedKeys = Object.create(null);
      this.mouse.down = false;
      this.mouse.pressed = false;
      this.mouse.rightDown = false;
      this.mouse.rightPressed = false;
      this.doubleTapUp = false;
      this._lastUpTap = -10;
    }
  };

  PF.Input = Input;
})(window.PF);
