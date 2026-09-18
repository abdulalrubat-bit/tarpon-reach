/* The galaxy map, and the only screen in the game that is not the cockpit.
 *
 * Drawn on its own 2D canvas in a DOM overlay rather than on the Phaser layer,
 * and that is a deliberate break from where the radar lives. The radar is part
 * of the glass you are flying behind: it is up sixty times a second, it has to
 * be in the same frame as the ship it describes, and it belongs on the game
 * canvas. This is a screen you STOP to read. It redraws when something changes
 * and not otherwise, it wants real text at real sizes, and it wants to cover
 * the game rather than float over it. That is a document, and documents are
 * cheaper and sharper in DOM.
 *
 * Territory is a Voronoi tessellation of the sector positions, coloured by
 * owner. This is the one place the brief's d3-delaunay earns its 19 KB: the
 * library was deliberately left out of the first build with a note saying it
 * would arrive with this screen, because a geometry library with no geometry
 * to do is 19 KB of nothing.
 *
 * Voronoi is also the right ANSWER and not just the available one. Faction
 * borders drawn as circles around each station say "this faction owns a radius";
 * drawn as a tessellation they say "space belongs to whoever is nearest, and
 * the border is wherever two claims meet" — which is how a border between two
 * powers with no natural frontier actually works, and it puts the contested
 * edge in exactly the place a player would guess.
 */
(function (SE) {
  'use strict';

  const PAD = 54;              // map margin in CSS pixels
  const NEUTRAL = 0x5a6472;

  function hex(n, a) {
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function Galaxy(ctx) {
    const root = document.getElementById('galaxy');
    const wrap = document.getElementById('gxwrap');
    const cv = document.getElementById('galaxymap');
    const g = cv.getContext('2d');
    const title = document.getElementById('gxwhere');
    const detail = document.getElementById('gxdetail');
    const setBtn = document.getElementById('gxset');

    let open = false;
    let picked = null;          // sector id the player has tapped
    let cells = null;           // Voronoi polygons, in map pixels
    let pts = null;             // sector centres, in map pixels
    let W = 0, H = 0, dpr = 1;

    /* Galaxy coordinates -> map pixels. Recomputed on every layout because the
       map is sized to whatever the screen is, and a phone rotates. */
    function project() {
      const S = SE.SECTORS;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of S) {
        if (s.gx < x0) x0 = s.gx; if (s.gx > x1) x1 = s.gx;
        if (s.gy < y0) y0 = s.gy; if (s.gy > y1) y1 = s.gy;
      }
      // Uniform scale on both axes: a galaxy stretched to fill a portrait
      // screen is a galaxy whose distances lie, and distance is the whole
      // content of this picture.
      const k = Math.min((W - PAD * 2) / Math.max(1, x1 - x0), (H - PAD * 2) / Math.max(1, y1 - y0));
      const ox = (W - (x1 - x0) * k) / 2 - x0 * k;
      const oy = (H - (y1 - y0) * k) / 2 - y0 * k;
      pts = S.map(s => ({ id: s.id, x: s.gx * k + ox, y: s.gy * k + oy }));

      /* The Voronoi is computed over a box much larger than the screen and
         then drawn clipped. Computed at the screen edge instead, the outermost
         cells get cut square against the viewport and the territory looks like
         it stops at the bezel rather than carrying on past it. */
      const D = window.d3 && window.d3.Delaunay;
      cells = null;
      if (D) {
        const d = D.from(pts.map(p => [p.x, p.y]));
        const v = d.voronoi([-W, -H, W * 2, H * 2]);
        cells = pts.map((p, i) => v.cellPolygon(i));
      }
    }

    function layout() {
      /* Measured from the WRAP, not from the overlay.
         Measuring the overlay sized the canvas to the full screen height while
         it was positioned inside a flex slot shorter than that, so it spilled
         over the footer — and an absolutely positioned canvas on top of a
         button eats the button's taps. The map looked perfect and SET COURSE
         could not be pressed, on a phone or in a test. */
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(200, Math.round(r.width));
      H = Math.max(200, Math.round(r.height));
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      project();
    }

    // How many hulls of each persuasion are sitting in a sector right now. The
    // registry is the authority whether or not the sector is the live one,
    // which is the point of the whole state/view split.
    function census(id) {
      const list = ctx.ships(id);
      let mine = 0, foe = 0, guns = 0;
      for (const s of list) {
        if (s.dead) continue;
        const cls = SE.CLASSES[s.cls];
        if (cls.tier === 'emplacement') { if (SE.hostile(s.faction, 'player')) guns++; continue; }
        if (cls.tier === 'structure') continue;
        if (s.owned) mine++;
        else if (SE.hostile(s.faction, 'player')) foe++;
      }
      return { mine, foe, guns };
    }

    function draw() {
      if (!open) return;
      const here = ctx.here();
      g.clearRect(0, 0, W, H);

      // Territory.
      if (cells) {
        for (let i = 0; i < pts.length; i++) {
          const poly = cells[i];
          if (!poly) continue;
          const sec = SE.SECTOR_BY_ID[pts[i].id];
          const col = sec.owner ? (SE.FACTIONS[sec.owner] || {}).colour || NEUTRAL : NEUTRAL;
          g.beginPath();
          g.moveTo(poly[0][0], poly[0][1]);
          for (let k = 1; k < poly.length; k++) g.lineTo(poly[k][0], poly[k][1]);
          g.closePath();
          g.fillStyle = hex(col, sec.owner ? 0.13 : 0.05);
          g.fill();
          g.strokeStyle = hex(col, sec.owner ? 0.5 : 0.22);
          g.lineWidth = 1;
          g.stroke();
        }
      }

      // Lanes.
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(63,224,200,.22)';
      for (const [a, b] of SE.LANES) {
        const A = pts.find(p => p.id === a), B = pts.find(p => p.id === b);
        g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
      }

      // The route to wherever the player has tapped, over the top of the lanes.
      if (picked && picked !== here) {
        const path = SE.route(here, picked);
        if (path && path.length > 1) {
          g.lineWidth = 2.6;
          g.strokeStyle = 'rgba(63,224,200,.95)';
          g.setLineDash([7, 5]);
          g.beginPath();
          for (let i = 0; i < path.length; i++) {
            const p = pts.find(q => q.id === path[i]);
            i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y);
          }
          g.stroke();
          g.setLineDash([]);
        }
      }

      // Sectors.
      g.textAlign = 'center';
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const sec = SE.SECTOR_BY_ID[p.id];
        const col = sec.owner ? (SE.FACTIONS[sec.owner] || {}).colour || NEUTRAL : NEUTRAL;
        const c = census(p.id);
        const isHere = p.id === here;
        const isPicked = p.id === picked;

        if (sec.station) {
          g.beginPath(); g.arc(p.x, p.y, 13, 0, Math.PI * 2);
          g.fillStyle = hex(col, 0.22); g.fill();
        }
        g.beginPath(); g.arc(p.x, p.y, sec.station ? 7 : 4.5, 0, Math.PI * 2);
        g.fillStyle = hex(col, 0.95); g.fill();

        if (isHere) {
          // You are here: a ring and the player's own magenta, so the eye finds
          // it before it reads a single word.
          g.beginPath(); g.arc(p.x, p.y, 19, 0, Math.PI * 2);
          g.lineWidth = 2; g.strokeStyle = hex(SE.FACTIONS.player.colour, 1); g.stroke();
        }
        if (isPicked && !isHere) {
          g.beginPath(); g.arc(p.x, p.y, 22, 0, Math.PI * 2);
          g.lineWidth = 1.6; g.strokeStyle = 'rgba(63,224,200,.9)'; g.setLineDash([4, 4]);
          g.stroke(); g.setLineDash([]);
        }

        /* Labels are centred on the sector, so a sector near either edge has
           half its name off the canvas — The Ossuary lost the word BELT
           entirely. Nudge the label back inside instead of letting it run off:
           a label a few pixels from its dot still clearly belongs to it, and
           one that is cut in half does not. */
        g.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
        const name = sec.name.toUpperCase();
        const clamp = (text, x) => {
          const half = g.measureText(text).width / 2 + 6;
          return Math.max(half, Math.min(W - half, x));
        };
        g.fillStyle = '#eafffb';
        g.fillText(name, clamp(name, p.x), p.y + 34);

        // One line of what is actually there, which is the only reason to look
        // at a map you have already memorised.
        const bits = [];
        if (c.mine) bits.push(c.mine + ' YOURS');
        if (c.foe) bits.push(c.foe + ' HOSTILE');
        if (c.guns) bits.push(c.guns + ' GUNS');
        if (sec.belt) bits.push('BELT');
        if (bits.length) {
          g.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
          g.fillStyle = c.foe || c.guns ? 'rgba(255,120,110,.92)' : 'rgba(138,243,228,.75)';
          const line = bits.join('  ');
          g.fillText(line, clamp(line, p.x), p.y + 47);
        }
      }
    }

    function describe() {
      const here = ctx.here();
      title.textContent = SE.SECTOR_BY_ID[here].name;
      if (!picked || picked === here) {
        detail.textContent = 'Tap a sector to plot a course.';
        setBtn.disabled = true;
        setBtn.textContent = 'SET COURSE';
        return;
      }
      const sec = SE.SECTOR_BY_ID[picked];
      const path = SE.route(here, picked);
      const c = census(picked);
      const hops = path.length - 1;
      const owner = sec.owner ? SE.FACTIONS[sec.owner].name : 'Unclaimed';
      detail.textContent = sec.name + ' — ' + owner + ' · ' + hops + ' jump' + (hops === 1 ? '' : 's') +
        (c.foe || c.guns ? ' · ' + (c.foe + c.guns) + ' hostile' : '') +
        (sec.station ? ' · ' + sec.station : ' · no station');
      setBtn.disabled = false;
      setBtn.textContent = 'SET COURSE — ' + path[1].toUpperCase();
    }

    function tap(ev) {
      const r = cv.getBoundingClientRect();
      const t = ev.changedTouches ? ev.changedTouches[0] : ev;
      const x = t.clientX - r.left, y = t.clientY - r.top;
      let best = null, bd = 44;
      for (const p of pts) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = p.id; }
      }
      if (best) { picked = (picked === best) ? null : best; describe(); draw(); }
    }

    cv.addEventListener('pointerdown', tap);
    window.addEventListener('resize', () => { if (open) { layout(); draw(); } });

    return {
      get open() { return open; },
      show() {
        open = true;
        picked = ctx.courseTo() || null;
        root.classList.add('on');
        layout(); describe(); draw();
      },
      hide() { open = false; root.classList.remove('on'); },
      toggle() { open ? this.hide() : this.show(); },
      get picked() { return picked; },
      refresh() { if (open) { describe(); draw(); } }
    };
  }

  SE.Galaxy = Galaxy;
})(window.SE = window.SE || {});
