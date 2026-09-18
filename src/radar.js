/* The holographic radar, and the only place the player commands a fleet.
 *
 * Drawn with Phaser's 2D Graphics API on the canvas layered over the Three.js
 * one. Both canvases share a WebGL context, so this costs a handful of
 * batched draws and nothing else — and it means the tactical display is real
 * 2D vector work rather than a billboard in the 3D scene fighting the camera.
 *
 * It maps world X and Z to a circle. Y — up and down — is deliberately thrown
 * away and replaced by a small tick above or below each blip. A true 3D
 * display on a phone-sized dial is unreadable, and the question a player
 * actually asks the radar is "which way do I turn", which is a 2D question.
 *
 * The important part is that the projection runs backwards too. A tap inside
 * the ring is un-projected into a world X/Z at the selected unit's own
 * altitude, and that point becomes the destination of a MOVE order. That is
 * the whole fleet interface: pick a unit, tap the map.
 */
(function (SE) {
  'use strict';

  const RING = 96;         // radius of the dial in CSS pixels
  const MARGIN = 14;

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
      return { x: cx + rx * k, y: cy + rz * k, out: Math.hypot(rx, rz) > range };
    }

    // ...and back. The inverse of the same two operations, in reverse order.
    function unproject(sx, sy, heading) {
      const k = range / RING;
      const rx = (sx - cx) * k;
      const rz = (sy - cy) * k;
      const s = Math.sin(-heading), c = Math.cos(-heading);
      return {
        x: ctx.centre().x + (rx * c - rz * s),
        z: ctx.centre().z + (rx * s + rz * c)
      };
    }

    function inDial(sx, sy) {
      return Math.hypot(sx - cx, sy - cy) <= RING + 6;
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
        const d = Math.hypot(p.x - sx, p.y - sy);
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

      // Dial furniture.
      g.fillStyle(0x03130f, 0.62).fillCircle(cx, cy, RING);
      g.lineStyle(1, 0x1f6f60, 0.8).strokeCircle(cx, cy, RING);
      g.lineStyle(1, 0x155448, 0.55).strokeCircle(cx, cy, RING * 0.66).strokeCircle(cx, cy, RING * 0.33);
      g.lineStyle(1, 0x155448, 0.4)
        .lineBetween(cx - RING, cy, cx + RING, cy)
        .lineBetween(cx, cy - RING, cx, cy + RING);

      // The player's own nose, always up, always at the centre. Drawn in the
      // player's faction colour rather than the interface teal, so the blip
      // and the hull it stands for are the same colour.
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
          const a = Math.atan2(p.y - cy, p.x - cx);
          g.fillStyle(col, 0.55).fillCircle(cx + Math.cos(a) * (RING - 4), cy + Math.sin(a) * (RING - 4), 1.8);
          continue;
        }

        const sel = (s.id === selected);
        const tgt = (s.id === ctx.target());
        const size = cls.tier === 'heavy' || cls.tier === 'structure' ? 5 : (cls.tier === 'medium' ? 3.6 : 2.6);

        if (cls.tier === 'structure') {
          g.lineStyle(1.4, col, 0.95).strokeRect(p.x - size, p.y - size, size * 2, size * 2);
        } else {
          g.fillStyle(col, 0.95).fillCircle(p.x, p.y, size);
        }

        // Altitude tick: the Y axis the dial threw away, reduced to the only
        // part of it worth reading — above me, below me, or level.
        const dy = s.y - ctx.centre().y;
        if (Math.abs(dy) > 28) {
          g.lineStyle(1, col, 0.7).lineBetween(p.x, p.y, p.x, p.y + (dy > 0 ? -7 : 7));
        }

        if (sel) g.lineStyle(1.4, 0x3fe0c8, 1).strokeCircle(p.x, p.y, size + 4.5);
        if (tgt) {
          g.lineStyle(1.2, 0xff5d5d, 1);
          g.strokeRect(p.x - size - 5, p.y - size - 5, (size + 5) * 2, (size + 5) * 2);
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
            const qy = Math.max(cy - RING, Math.min(cy + RING, q.y));
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
          let lx = p.x + 7, ly = p.y - 5;
          for (let g = 0; g < li; g++) {
            const o = labels[g];
            if (Math.abs(o.x - lx) < 34 && Math.abs(o.y - ly) < 11) { ly = o.y + 11; g = -1; }
          }
          const t = labels[li++];
          t.setPosition(lx, ly).setText(s.name.slice(0, 7).toUpperCase()).setVisible(true);
        }
      }
      for (; li < labels.length; li++) labels[li].setVisible(false);

      // Range legend on the rim.
      g.lineStyle(1, 0x2aa892, 0.9);
      g.lineBetween(cx - RING, cy + RING + 4, cx - RING + 18, cy + RING + 4);
    }

    return {
      draw, handleTap, inDial,
      get selected() { return selected; },
      set selected(v) { selected = v; },
      get mode() { return mode; },
      set mode(v) { mode = v; },
      get range() { return range; },
      set range(v) { range = v; },
      destroy() { g.destroy(); labels.forEach(t => t.destroy()); }
    };
  }

  SE.Radar = Radar;
  SE.RADAR_RING = RING;
})(window.SE = window.SE || {});
