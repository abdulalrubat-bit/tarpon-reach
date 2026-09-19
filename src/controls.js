/* Touch controls: one floating stick, one throttle, one trigger.
 *
 * The stick has no fixed home. Wherever the left thumb lands becomes the
 * centre, and the deflection is measured from there. A stick painted at a
 * fixed spot is a stick the player has to look down at to find, and in a
 * dogfight they will not look down — they will miss it, and blame the game.
 *
 * Everything here is drawn on the Phaser canvas rather than in DOM, which is
 * the opposite of the rule that fixed furniture belongs in DOM. The stick
 * earns the exception because it MOVES: its base follows the thumb, it has to
 * be drawn in the same frame as the deflection it represents, and a DOM
 * element chasing a touch at 60Hz is a layout thrash per frame. The throttle
 * and the trigger sit beside it on the same canvas simply because splitting
 * three related controls across two rendering systems to save nothing is how
 * an interface stops feeling like one interface.
 */
(function (SE) {
  'use strict';

  const STICK_R = 62;        // maximum deflection in pixels
  const DEAD = 0.14;         // fraction of travel ignored at the centre

  /* EXPO is the fraction of the stick curve that is cubic rather than linear.
     A linear stick spends the same degrees per pixel everywhere, which means
     the half of the travel nearest the centre — the half doing all the aiming
     — is exactly as touchy as the half doing the hard turns. A thumb on glass
     has maybe two millimetres of real precision, so linear reads as "the ship
     is too sensitive" no matter how the peak rate is tuned.

     Curved, at 0.62: half deflection asks for 27% of the rate, a third asks
     for 13%. Full stick is untouched, so nothing is taken away at the top —
     the fine end simply gets most of the travel. */
  const EXPO = 0.62;

  // Player-facing multiplier on top of that, 0.40 to 1.60, stepped in the HUD
  // and remembered. Thumb size and how a person holds a phone vary more than
  // any single tuning value can cover.
  const SENS_MIN = 0.40, SENS_MAX = 1.60;
  let sens = 1;
  try {
    const st = localStorage.getItem('se.sens');
    if (st) sens = Math.max(SENS_MIN, Math.min(SENS_MAX, parseFloat(st) || 1));
  } catch (e) { /* private mode: the default is fine */ }

  function Controls(scene, ctx) {
    /* The canvas is now as many pixels as the device has, so the game's own
       coordinate space is DEVICE pixels — a 412-wide phone at ratio 3 is a
       1236-wide game. Every number in this file is a thumb-sized measurement
       in CSS pixels and none of them should change because a screen got
       denser, so the whole layer goes in a container scaled by the ratio and
       carries on drawing in the units it was written in. Line widths and
       radii scale with it; pointer coordinates come back the other way. */
    const S = SE.dpr();
    const root = scene.add.container(0, 0).setScale(S).setDepth(9);
    const g = scene.add.graphics();
    root.add(g);

    scene.input.addPointer(3);   // four simultaneous touches: stick, throttle, fire, radar

    // CSS pixels, which is what the zones and the stick are measured in.
    const cssW = () => scene.scale.width / S;
    const cssH = () => scene.scale.height / S;
    let W = cssW(), H = cssH();
    const zone = {};
    function layout(w, h) {
      W = w; H = h;
      zone.fire = { x: w - 96, y: h - 118, r: 54 };
      zone.thr = { x: w - 26, y0: 250, y1: h - 200, w: 20 };
      zone.stickArea = { x0: 0, x1: w * 0.56, y0: 150, y1: h };
    }
    layout(W, H);
    scene.scale.on('resize', () => layout(cssW(), cssH()));

    const state = {
      pitch: 0, yaw: 0,        // -1..1 stick deflection
      // Starts at zero, and zero now means STOPPED rather than "no thrust" —
      // the throttle asks for a speed. Spawning already under way was fine
      // when it meant a gentle push; it is wrong when it means the ship
      // actively drives itself away from the station you started at.
      throttle: 0,             // 0..1, sticky: it stays where you left it
      firing: false,
      boost: false
    };

    let stickId = -1, stickOX = 0, stickOY = 0, stickX = 0, stickY = 0;
    let thrId = -1, fireId = -1;
    let tapT = 0, tapMoved = 0;

    function inFire(x, y) { return Math.hypot(x - zone.fire.x, y - zone.fire.y) <= zone.fire.r; }
    function inThr(x, y) {
      return x > zone.thr.x - 26 && x < zone.thr.x + 26 && y > zone.thr.y0 - 20 && y < zone.thr.y1 + 20;
    }
    function inStickArea(x, y) {
      return x >= zone.stickArea.x0 && x <= zone.stickArea.x1 && y >= zone.stickArea.y0 && y <= zone.stickArea.y1;
    }

    function setThrottleFromY(y) {
      const t = 1 - (y - zone.thr.y0) / (zone.thr.y1 - zone.thr.y0);
      state.throttle = Math.max(0, Math.min(1, t));
    }

    // Pointer coordinates arrive in the game's device-pixel space. Everything
    // below thinks in CSS pixels, so they convert once, here, at the door.
    const px = v => v / S;

    scene.input.on('pointerdown', p => {
      const x = px(p.x), y = px(p.y);
      // The radar gets first refusal on every touch: it is the smallest target
      // on screen and the one where a swallowed tap is most annoying.
      if (ctx.radarTap(x, y)) return;
      if (inFire(x, y)) { fireId = p.id; state.firing = true; return; }
      if (inThr(x, y)) { thrId = p.id; setThrottleFromY(y); return; }
      if (stickId === -1 && inStickArea(x, y)) {
        stickId = p.id; stickOX = x; stickOY = y; stickX = x; stickY = y;
        tapT = performance.now(); tapMoved = 0;
      }
    });

    scene.input.on('pointermove', p => {
      if (p.id === stickId) {
        stickX = px(p.x); stickY = px(p.y);
        tapMoved = Math.max(tapMoved, Math.hypot(stickX - stickOX, stickY - stickOY));
        let dx = stickX - stickOX, dy = stickY - stickOY;
        const d = Math.hypot(dx, dy);
        if (d > STICK_R) { dx = dx / d * STICK_R; dy = dy / d * STICK_R; stickX = stickOX + dx; stickY = stickOY + dy; }
        const nx = dx / STICK_R, ny = dy / STICK_R;
        const mag = Math.hypot(nx, ny);
        if (mag < DEAD) { state.yaw = 0; state.pitch = 0; }
        else {
          // Rescale past the dead zone so the first pixel of real travel is
          // not also a jump to 14% deflection, then bend the result.
          //
          // The curve is applied to the MAGNITUDE, not to each axis on its
          // own. Per-axis expo makes a diagonal push weaker than a straight
          // one by a different amount at every angle, so the ship turns at a
          // rate that depends on which way the thumb is pointing — which is
          // unlearnable, and feels like the stick catching.
          const k = (mag - DEAD) / (1 - DEAD);
          const curved = k * (EXPO * k * k + (1 - EXPO)) * sens;
          const scale = curved / mag;
          state.yaw = nx * scale;
          state.pitch = ny * scale;
        }
      } else if (p.id === thrId) {
        setThrottleFromY(px(p.y));
      }
    });

    function release(p) {
      if (p.id === stickId) {
        // A touch in the flight area that never really moved was not a stick
        // input, it was someone pointing at something. Handing it on as a tap
        // is what lets the same thumb fly the ship and pick a rock to mine
        // without a mode button between the two.
        if (tapMoved < 9 && performance.now() - tapT < 260 && ctx.viewTap) ctx.viewTap(px(p.x), px(p.y));
        stickId = -1; state.yaw = 0; state.pitch = 0;
      }
      if (p.id === thrId) thrId = -1;
      if (p.id === fireId) { fireId = -1; state.firing = false; }
    }
    scene.input.on('pointerup', release);
    scene.input.on('pointerupoutside', release);
    scene.input.on('gameout', () => { state.yaw = 0; state.pitch = 0; state.firing = false; stickId = thrId = fireId = -1; });

    // Keyboard, for developing this on a desktop. Not shipped as a feature,
    // and not documented in the game, but the alternative is testing a flight
    // model through a mouse pretending to be a thumb.
    const keys = scene.input.keyboard ? scene.input.keyboard.addKeys({
      up: 'W', down: 'S', left: 'A', right: 'D', fire: 'SPACE', more: 'E', less: 'Q'
    }) : null;

    function readKeys(dt) {
      if (!keys) return;
      let kx = 0, ky = 0;
      if (keys.left.isDown) kx -= 1;
      if (keys.right.isDown) kx += 1;
      if (keys.up.isDown) ky -= 1;
      if (keys.down.isDown) ky += 1;
      if (kx || ky) { state.yaw = kx; state.pitch = ky; }
      else if (stickId === -1) { state.yaw = 0; state.pitch = 0; }
      if (keys.more.isDown) state.throttle = Math.min(1, state.throttle + dt * 0.8);
      if (keys.less.isDown) state.throttle = Math.max(0, state.throttle - dt * 0.8);
      if (keys.fire.isDown) state.firing = true;
      else if (fireId === -1) state.firing = false;
    }

    function draw() {
      g.clear();

      // Stick, only while held. An empty ring sitting there the rest of the
      // time is noise over the only part of the screen that is the game.
      if (stickId !== -1) {
        g.lineStyle(1.5, 0x3fe0c8, 0.32).strokeCircle(stickOX, stickOY, STICK_R);
        g.lineStyle(1, 0x3fe0c8, 0.16).strokeCircle(stickOX, stickOY, STICK_R * DEAD);
        g.fillStyle(0x3fe0c8, 0.16).fillCircle(stickX, stickY, 26);
        g.lineStyle(2, 0x3fe0c8, 0.8).strokeCircle(stickX, stickY, 26);
        g.lineStyle(1, 0x3fe0c8, 0.4).lineBetween(stickOX, stickOY, stickX, stickY);
      }

      // Throttle. The filled part is how much drive is committed, and it stays
      // put when the thumb leaves — a throttle that springs back to zero is a
      // throttle you have to hold, and both thumbs are already busy.
      const t = zone.thr;
      const h = t.y1 - t.y0;
      g.fillStyle(0x0b1a1c, 0.55).fillRoundedRect(t.x - t.w / 2, t.y0, t.w, h, t.w / 2);
      g.lineStyle(1, 0x2aa892, 0.5).strokeRoundedRect(t.x - t.w / 2, t.y0, t.w, h, t.w / 2);
      const fh = h * state.throttle;
      if (fh > 2) g.fillStyle(0x3fe0c8, 0.62).fillRoundedRect(t.x - t.w / 2 + 3, t.y1 - fh, t.w - 6, fh - 2, (t.w - 6) / 2);
      g.fillStyle(0xeafffb, 0.95).fillRect(t.x - t.w / 2 - 5, t.y1 - fh - 1.5, t.w + 10, 3);

      // Trigger.
      const f = zone.fire;
      g.fillStyle(state.firing ? 0xff6a4d : 0x1a2630, state.firing ? 0.5 : 0.42).fillCircle(f.x, f.y, f.r);
      g.lineStyle(2, state.firing ? 0xff8a6d : 0x4f6572, 0.95).strokeCircle(f.x, f.y, f.r);
      g.lineStyle(1.4, state.firing ? 0xffd9cd : 0x8aa2b0, 0.9);
      g.strokeCircle(f.x, f.y, 13);
      g.lineBetween(f.x - 24, f.y, f.x - 17, f.y).lineBetween(f.x + 17, f.y, f.x + 24, f.y);
      g.lineBetween(f.x, f.y - 24, f.x, f.y - 17).lineBetween(f.x, f.y + 17, f.x, f.y + 24);
    }

    return {
      state, draw, readKeys, zone,
      get sens() { return sens; },
      set sens(v) {
        sens = Math.max(SENS_MIN, Math.min(SENS_MAX, v));
        try { localStorage.setItem('se.sens', String(sens)); } catch (e) { /* ignore */ }
      },
      destroy() { root.destroy(); }
    };
  }

  SE.Controls = Controls;
})(window.SE = window.SE || {});
