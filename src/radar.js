/* The holographic radar, and the only place the player commands a fleet.
 *
 * Drawn with Phaser's 2D Graphics API on the canvas layered over the Three.js
 * one. Both canvases share a WebGL context, so this costs a handful of
 * batched draws and nothing else — and it means the tactical display is real
 * 2D vector work rather than a billboard in the 3D scene fighting the camera.
 *
 * It used to map world X and Z to a circle and throw Y away, on the argument
 * that "which way do I turn" is a 2D question. That argument is wrong in a
 * game where ships arrive from above: a contact 200 m ahead and a contact
 * 200 m overhead landed on the same pixel, and the only thing distinguishing
 * them was a seven-pixel tick nobody reads mid-fight.
 *
 * So the dial is now a PLANE SEEN AT AN ANGLE — an ellipse, squashed to 54%.
 * That squash is what buys the depth: it frees the vertical screen axis, so
 * altitude can be drawn as a stalk standing off the deck instead of competing
 * with forward-and-back for the same pixels. Every contact is a foot on the
 * plane (bearing and range, exactly as before) and a blip at the top of a
 * stalk (how far above or below you it is). Frontier's radar has worked this
 * way since 1993 because it is the only arrangement that fits three axes on a
 * dial the size of a thumbnail.
 *
 * Altitude goes through tanh rather than a linear scale. Linear spends most of
 * the stalk on contacts far enough above you to be irrelevant, and leaves the
 * near-level ones — the ones you are actually fighting — crushed together at
 * the deck. tanh gives the first hundred metres most of the travel and lets
 * everything beyond saturate at the top, which is the same argument as the
 * expo curve on the stick.
 *
 * The important part is still that the projection runs backwards. A tap inside
 * the ring is un-projected into a world X/Z at the selected unit's own
 * altitude, and that point becomes the destination of a MOVE order. That is
 * the whole fleet interface: pick a unit, tap the map.
 */
(function (SE) {
  'use strict';

  const RING = 96;         // radius of the dial in CSS pixels, across
  const MARGIN = 14;

  /* How far the deck plane is tipped away from the viewer. 1.0 is a circle
     seen from directly overhead, which is where this started and which leaves
     nowhere to put altitude. Lower is a flatter, more side-on plane with more
     vertical room for stalks — but the flatter it gets, the worse the dial is
     at its day job of separating "ahead" from "beside". 0.54 is the point
     where both still read. */
  const SQUASH = 0.54;
  const RING_Y = RING * SQUASH;

  const ALT_PX = 62;       // longest a stalk is allowed to get
  const ALT_K = 0.30;      // fraction of dial range at which tanh is ~76% out

  function Radar(scene, ctx) {
    const g = scene.add.graphics();
    g.setDepth(10);
    const labels = [];
    let cx = 0, cy = 0;
    let range = 1500;      // world metres from centre to ring
    let selected = null;   // ship id the player is commanding
    let mode = 'MOVE';     // what a tap on empty space means

    // Text objects are pooled too. Creating a Phaser.Text per blip per frame
    // uploads a new texture per label per frame, which is the single most
    // expensive thing anyone has ever done to a HUD.
    for (let i = 0; i < 10; i++) {
      const t = scene.add.text(0, 0, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '9px', color: '#8ff3e4'
      });
      t.setDepth(11).setVisible(false);
      labels.push(t);
    }

    /* The stalk says which way and roughly how far. This says how far exactly,
       for the one contact that matters — a picture answers "is it above me",
       a number answers "by how much", and closing on something 300 m above is
       a different manoeuvre from closing on something 30 m above.

       It sits in a FIXED spot under the rim rather than beside the mark it
       describes. Pinned to the mark it moved with the target, collided with
       every wingman label it passed, and had to be found again each glance.
       There is only ever one target, it already wears a red box, and a readout
       you can look at without searching is worth more than one that is
       physically next to its subject. */
    const altText = scene.add.text(0, 0, '', {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '9px', color: '#ff9c9c'
    });
    altText.setDepth(11).setVisible(false);

    function layout(w, h) {
      cx = w - RING - MARGIN;
      cy = RING + MARGIN + 26;
    }
    layout(scene.scale.width, scene.scale.height);
    scene.scale.on('resize', s => layout(s.width, s.height));

    /* World -> dial. Rotated by the player's heading so the dial is always
       nose-up: a north-up radar forces the player to do the rotation in their
       head every time they turn, mid-fight, on a phone. */
    function project(x, z, heading) {
      const dx = x - ctx.centre().x;
      const dz = z - ctx.centre().z;
      const s = Math.sin(heading), c = Math.cos(heading);
      const rx = dx * c - dz * s;
      const rz = dx * s + dz * c;
      const k = RING / range;
      // The `out` test is done in WORLD units, before the squash. Testing the
      // squashed ellipse instead would make a contact directly ahead drop off
      // the dial at 54% of the range of one directly beside — a radar whose
      // range depends on the bearing.
      return { x: cx + rx * k, y: cy + rz * k * SQUASH, out: Math.hypot(rx, rz) > range };
    }

    /* Metres above or below the player, as pixels of stalk. Negative is up,
       because screen Y is. */
    function altPx(dy) {
      return -Math.tanh(dy / (range * ALT_K)) * ALT_PX;
    }

    // ...and back. The inverse of the same operations, in reverse order — note
    // the squash is undone here too, or every MOVE order given by tapping the
    // dial lands short of where it was aimed.
    function unproject(sx, sy, heading) {
      const k = range / RING;
      const rx = (sx - cx) * k;
      const rz = (sy - cy) / SQUASH * k;
      const s = Math.sin(-heading), c = Math.cos(-heading);
      return {
        x: ctx.centre().x + (rx * c - rz * s),
        z: ctx.centre().z + (rx * s + rz * c)
      };
    }

    /* The touchable area is the ellipse GROWN UPWARDS AND DOWNWARDS by a full
       stalk, because a contact high above you is drawn well outside the plate
       and has to still be tappable. Generous on purpose: this is the smallest
       target on the screen. */
    function inDial(sx, sy) {
      const ux = (sx - cx) / (RING + 8);
      const uy = (sy - cy) / (RING_Y + ALT_PX + 8);
      return ux * ux + uy * uy <= 1;
    }

    /* ---- Input ---------------------------------------------------------
       One pointer handler for the whole dial. A tap on a blip selects or
       targets it; a tap on empty space is an order to the selected unit at
       that point. The selection is what disambiguates MOVE from ATTACK, so
       there is no mode switch to forget you are in. */
    function handleTap(sx, sy) {
      if (!inDial(sx, sy)) return false;
      const heading = ctx.heading();
      const fleet = ctx.ships();

      // Nearest blip within a fat finger's reach.
      let hit = null, hitD = 22;
      for (let i = 0; i < fleet.length; i++) {
        const s = fleet[i];
        if (s.dead) continue;
        const p = project(s.x, s.z, heading);
        if (p.out) continue;
        // Against where the blip is DRAWN — at the top of its stalk — not
        // against its foot. Tapping the mark you can see is the whole contract.
        const by = p.y + altPx(s.y - ctx.centre().y);
        const d = Math.hypot(p.x - sx, by - sy);
        if (d < hitD) { hitD = d; hit = s; }
      }

      if (hit) {
        if (hit.owned && !hit.isPlayer) {
          selected = (selected === hit.id) ? null : hit.id;
          ctx.say(selected ? 'COMMANDING ' + hit.name.toUpperCase() : 'SELECTION CLEARED');
        } else if (selected) {
          const cmd = ctx.get(selected);
          if (cmd) {
            cmd.orders.length = 0;
            cmd.orders.push({ type: 'ATTACK', target: hit.id });
            cmd.orderT = 0;
            ctx.say(cmd.name.toUpperCase() + ' > ATTACK ' + hit.name.toUpperCase());
          }
        } else {
          ctx.setTarget(hit.id);
          ctx.say('TARGET ' + hit.name.toUpperCase());
        }
        return true;
      }

      if (selected) {
        const cmd = ctx.get(selected);
        if (cmd) {
          const w = unproject(sx, sy, heading);
          cmd.orders.length = 0;
          cmd.orderT = 0;
          if (mode === 'MINE') {
            const node = ctx.nearestOre(w.x, cmd.y, w.z);
            if (node) {
              cmd.orders.push({ type: 'MINE', node: node.index });
              ctx.say(cmd.name.toUpperCase() + ' > MINE');
            } else {
              ctx.say('NO ORE IN RANGE');
            }
          } else if (mode === 'TRADE') {
            const st = ctx.station();
            if (st) {
              cmd.orders.push({ type: 'TRADE', station: st.id, good: 'ore' });
              ctx.say(cmd.name.toUpperCase() + ' > TRADE');
            }
          } else {
            cmd.orders.push({ type: 'MOVE', x: w.x, y: cmd.y, z: w.z });
            ctx.say(cmd.name.toUpperCase() + ' > MOVE');
          }
        }
        return true;
      }
      return true;   // swallow the tap so it does not also fire the guns
    }

    /* ---- Draw ----------------------------------------------------------
       Cleared and rebuilt every frame. Phaser's Graphics is immediate-mode
       under a retained wrapper: redrawing 40 blips is cheaper than tracking
       40 persistent objects and their dirty state. */
    function draw() {
      g.clear();
      const heading = ctx.heading();
      const ships = ctx.ships();

      /* Dial furniture. The deck plane first, as an ellipse: a filled plate,
         a rim, two range rings and the two axes. Ellipses rather than circles
         are the entire reason there is anywhere to draw altitude. */
      g.fillStyle(0x03130f, 0.62).fillEllipse(cx, cy, RING * 2, RING_Y * 2);
      g.lineStyle(1, 0x1f6f60, 0.8).strokeEllipse(cx, cy, RING * 2, RING_Y * 2, 44);
      g.lineStyle(1, 0x155448, 0.5)
        .strokeEllipse(cx, cy, RING * 1.32, RING_Y * 1.32, 32)
        .strokeEllipse(cx, cy, RING * 0.66, RING_Y * 0.66, 24);
      g.lineStyle(1, 0x155448, 0.38)
        .lineBetween(cx - RING, cy, cx + RING, cy)
        .lineBetween(cx, cy - RING_Y, cx, cy + RING_Y);

      /* Four posts standing off the rim at the cardinals. They carry no
         information at all; they are there because a flat ellipse reads as an
         oval until something sticks up out of it, and then it reads as a
         plane. This is the cheapest possible depth cue and it does more work
         than any of the real ones. */
      g.lineStyle(1, 0x1f6f60, 0.3);
      for (let a = 0; a < 4; a++) {
        const th = a * Math.PI / 2;
        const px = cx + Math.cos(th) * RING, py = cy + Math.sin(th) * RING_Y;
        g.lineBetween(px, py - 5, px, py + 5);
      }

      /* The player's own nose, always up, always at the centre — and now with
         its own short mast, because the player is the datum every stalk is
         measured against and the datum has to be visible. */
      g.lineStyle(1, 0x155448, 0.3).lineBetween(cx, cy - ALT_PX, cx, cy + ALT_PX);
      g.lineStyle(1, 0x2aa892, 0.45)
        .lineBetween(cx - 4, cy - ALT_PX, cx + 4, cy - ALT_PX)
        .lineBetween(cx - 4, cy + ALT_PX, cx + 4, cy + ALT_PX);
      // Drawn in the player's faction colour rather than the interface teal,
      // so the blip and the hull it stands for are the same colour.
      g.fillStyle(SE.FACTIONS.player.colour, 1);
      g.beginPath();
      g.moveTo(cx, cy - 7); g.lineTo(cx + 4.5, cy + 5); g.lineTo(cx, cy + 2.5); g.lineTo(cx - 4.5, cy + 5);
      g.closePath(); g.fillPath();

      let li = 0;
      for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (s.dead || s.isPlayer) continue;
        const p = project(s.x, s.z, heading);
        const cls = SE.CLASSES[s.cls];
        const col = (SE.FACTIONS[s.faction] || SE.FACTIONS.player).colour;

        if (p.out) {
          // Off the edge: a chevron on the rim, because knowing something is
          // out there and roughly which way matters more than its exact range.
          // The bearing is taken in CIRCULAR space and re-squashed, or every
          // off-dial contact would bunch towards the sides of the ellipse.
          const a = Math.atan2((p.y - cy) / SQUASH, p.x - cx);
          g.fillStyle(col, 0.55).fillCircle(
            cx + Math.cos(a) * (RING - 4), cy + Math.sin(a) * (RING_Y - 3), 1.8);
          continue;
        }

        const sel = (s.id === selected);
        const tgt = (s.id === ctx.target());
        const size = cls.tier === 'heavy' || cls.tier === 'structure' ? 5 : (cls.tier === 'medium' ? 3.6 : 2.6);

        /* The contact is drawn twice: a FOOT on the deck plane, which is where
           it is, and a MARK at the top of a stalk, which is how far above or
           below you it is. Neither works without the other — a mark alone is
           ambiguous about range, a foot alone is the old flat radar. */
        const dy = s.y - ctx.centre().y;
        const a = altPx(dy);
        const by = p.y + a;

        /* Foot: a flat dash, so it reads as lying ON the plane rather than
           floating over it. It was drawn at 0.34 alpha on the theory that a
           shadow should be faint — at which point it vanished against the
           plate, and a stalk with no visible base is just a floating line.
           The foot is half the information on this display; it gets to be
           seen. */
        g.lineStyle(1.2, col, 0.6).lineBetween(p.x - 3, p.y, p.x + 3, p.y);

        // Stalk. Brightness follows how far off the deck the contact is, so a
        // wingman holding formation beside you barely draws one and something
        // diving on you from above draws a hard bright line.
        if (Math.abs(a) > 1.2) {
          const lift = Math.min(1, Math.abs(a) / ALT_PX);
          g.lineStyle(1, col, 0.22 + lift * 0.42).lineBetween(p.x, p.y, p.x, by);
        }

        if (cls.tier === 'structure') {
          g.lineStyle(1.4, col, 0.95).strokeRect(p.x - size, by - size, size * 2, size * 2);
        } else {
          g.fillStyle(col, 0.95).fillCircle(p.x, by, size);
        }

        if (sel) g.lineStyle(1.4, 0x3fe0c8, 1).strokeCircle(p.x, by, size + 4.5);
        if (tgt) {
          g.lineStyle(1.2, 0xff5d5d, 1);
          g.strokeRect(p.x - size - 5, by - size - 5, (size + 5) * 2, (size + 5) * 2);
        }

        // Order line: where a commanded ship has been told to go. Without it,
        // an order given to something off the far side of the dial produces no
        // feedback at all until the ship is halfway there.
        if (s.owned && s.orders.length) {
          const o = s.orders[0];
          let ox = null, oz = null;
          if (o.type === 'MOVE') { ox = o.x; oz = o.z; }
          else if (o.type === 'ATTACK') { const t = ctx.get(o.target); if (t) { ox = t.x; oz = t.z; } }
          else if (o.type === 'TRADE') { const t = ctx.get(o.station); if (t) { ox = t.x; oz = t.z; } }
          else if (o.type === 'MINE') { const n = ctx.node(o.node); if (n) { ox = n.x; oz = n.z; } }
          if (ox !== null) {
            const q = project(ox, oz, heading);
            const qx = Math.max(cx - RING, Math.min(cx + RING, q.x));
            const qy = Math.max(cy - RING_Y, Math.min(cy + RING_Y, q.y));
            // Drawn foot-to-foot, along the deck. An order line that climbed
            // to the mark would cross every stalk on the dial at a slant and
            // turn the display into a cat's cradle.
            g.lineStyle(1, 0x3fe0c8, 0.42).lineBetween(p.x, p.y, qx, qy);
            g.fillStyle(0x3fe0c8, 0.5).fillCircle(qx, qy, 2);
          }
        }

        if (s.owned && li < labels.length) {
          // Two wingmen holding station on the same leader sit a few pixels
          // apart on a 96-pixel dial, and their labels overprint into one
          // unreadable word. Nudge each new label clear of the ones already
          // placed rather than dropping it: which hull is which is exactly
          // what the label is for.
          let lx = p.x + 7, ly = by - 5;
          for (let g = 0; g < li; g++) {
            const o = labels[g];
            if (Math.abs(o.x - lx) < 34 && Math.abs(o.y - ly) < 11) { ly = o.y + 11; g = -1; }
          }
          const t = labels[li++];
          t.setPosition(lx, ly).setText(s.name.slice(0, 7).toUpperCase()).setVisible(true);
        }
      }
      for (; li < labels.length; li++) labels[li].setVisible(false);

      // Altitude readout, target only.
      const tid = ctx.target();
      const t = tid ? ctx.get(tid) : null;
      if (t && !t.dead) {
        const d = Math.round(t.y - ctx.centre().y);
        const r = Math.round(Math.hypot(t.x - ctx.centre().x, t.z - ctx.centre().z));
        altText.setPosition(cx - RING + 26, cy + RING_Y + 10)
          .setText((d >= 0 ? '+' : '') + d + 'm  ' + r + 'm out')
          .setVisible(true);
      } else {
        altText.setVisible(false);
      }

      // Range legend on the rim.
      g.lineStyle(1, 0x2aa892, 0.9);
      g.lineBetween(cx - RING, cy + RING_Y + 14, cx - RING + 18, cy + RING_Y + 14);
    }

    /* Where a given ship's mark is drawn, in screen pixels. The HUD has no use
       for this yet; the tests do, and a display whose hit test cannot be
       checked against its own output is a display whose hit test is wrong the
       first time something moves. */
    function markOf(id) {
      const fleet = ctx.ships();
      const heading = ctx.heading();
      for (let i = 0; i < fleet.length; i++) {
        const s = fleet[i];
        if (s.id !== id || s.dead) continue;
        const p = project(s.x, s.z, heading);
        if (p.out) return null;
        return { x: p.x, y: p.y + altPx(s.y - ctx.centre().y), foot: p.y };
      }
      return null;
    }

    return {
      draw, handleTap, inDial, markOf,
      get selected() { return selected; },
      set selected(v) { selected = v; },
      get mode() { return mode; },
      set mode(v) { mode = v; },
      get range() { return range; },
      set range(v) { range = v; },
      destroy() { g.destroy(); labels.forEach(t => t.destroy()); altText.destroy(); }
    };
  }

  SE.Radar = Radar;
  SE.RADAR_RING = RING;
})(window.SE = window.SE || {});
