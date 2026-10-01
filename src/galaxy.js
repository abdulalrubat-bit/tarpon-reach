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

  const NEUTRAL = 0x5a6472;
  const HOLDERS = ['player', 'apex', 'scrapper', 'vanguard'];
  const REACH = 95;             // how far a system's territory extends, galaxy units

  function hex(n, a) {
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  const colourOf = sec => sec.owner ? (SE.FACTIONS[sec.owner] || {}).colour || NEUTRAL : NEUTRAL;

  /* Sixty systems do not fit on a phone at a size anyone can tap, so the map
     is a camera over the galaxy rather than a picture of all of it: drag to
     pan, pinch or wheel to zoom, and it opens centred on where you are at the
     zoom that shows your neighbours. Everything below works in galaxy units
     and goes through view() once, at draw time. */
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
    let W = 0, H = 0, dpr = 1;
    const cam = { k: 1, x: 0, y: 0, fit: 1 };   // px per galaxy unit; galaxy point at screen centre
    const screen = {};          // sector id -> {x, y}, rebuilt every draw
    const labelBoxes = [];      // reused across event-driven redraws, never a frame loop

    /* Territory, computed once in galaxy units. Sectors never move; only their
       owners change, and that is a colour, not a geometry. The box is far
       larger than the galaxy so the outermost cells carry on past the edge of
       the map instead of stopping square at it. */
    const cells = (() => {
      const D = window.d3 && window.d3.Delaunay;
      if (!D) return null;
      const v = D.from(SE.SECTORS.map(s => [s.gx, s.gy])).voronoi([-4000, -4000, 4000, 4000]);
      return SE.SECTORS.map((s, i) => v.cellPolygon(i));
    })();
    const extent = (() => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of SE.SECTORS) { x0 = Math.min(x0, s.gx); x1 = Math.max(x1, s.gx); y0 = Math.min(y0, s.gy); y1 = Math.max(y1, s.gy); }
      return { x0, y0, x1, y1 };
    })();

    const sx = gx => (gx - cam.x) * cam.k + W / 2;
    const sy = gy => (gy - cam.y) * cam.k + H / 2;

    function clampCam() {
      cam.k = Math.max(cam.fit * 0.9, Math.min(cam.fit * 7, cam.k));
      const mx = W / 2 / cam.k, my = H / 2 / cam.k;
      cam.x = Math.max(extent.x0 - mx * 0.6, Math.min(extent.x1 + mx * 0.6, cam.x));
      cam.y = Math.max(extent.y0 - my * 0.6, Math.min(extent.y1 + my * 0.6, cam.y));
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
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Uniform scale on both axes: a galaxy stretched to fill a portrait
      // screen is a galaxy whose distances lie.
      cam.fit = Math.min((W - 40) / Math.max(1, extent.x1 - extent.x0), (H - 70) / Math.max(1, extent.y1 - extent.y0));
      clampCam();
    }

    function focus(id, k) {
      const s = SE.SECTOR_BY_ID[id];
      if (s) { cam.x = s.gx; cam.y = s.gy; }
      // About four hundred units across: you, your neighbours and theirs.
      cam.k = k || Math.max(cam.fit * 1.4, Math.min(W, H) / 400);
      clampCam();
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

    function holdings() {
      const n = { player: 0, apex: 0, scrapper: 0, vanguard: 0, none: 0 };
      for (const s of SE.SECTORS) n[s.owner || 'none'] = (n[s.owner || 'none'] || 0) + 1;
      return n;
    }

    function draw() {
      if (!open) return;
      const here = ctx.here();
      g.clearRect(0, 0, W, H); labelBoxes.length = 0;
      g.fillStyle = '#091722'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#86b7cd0b'; g.lineWidth = 1; g.beginPath();
      for (let x = 24; x < W; x += 40) { g.moveTo(x, 0); g.lineTo(x, H); }
      for (let y = 24; y < H; y += 40) { g.moveTo(0, y); g.lineTo(W, y); } g.stroke();
      for (let i = 0; i < 64; i++) { const x = (i * 173.31 + 31) % W, y = (i * i * 19.73 + 17) % H; g.fillStyle = i % 3 ? '#b7d6e92b' : '#b7d6e957'; g.fillRect(x, y, 1, 1); }

      for (const s of SE.SECTORS) { const p = screen[s.id] || (screen[s.id] = { x: 0, y: 0 }); p.x = sx(s.gx); p.y = sy(s.gy); }
      const visible = p => p.x > -60 && p.x < W + 60 && p.y > -60 && p.y < H + 60;

      /* Territory. Each cell is clipped to a disc around its own system:
         unclipped, the cells on the rim run out to the edge of the Voronoi box
         and a frontier system appears to own a wedge of empty space ten times
         the size of the galaxy. */
      if (cells) {
        SE.SECTORS.forEach((sec, i) => {
          const poly = cells[i];
          if (!poly) return;
          const col = colourOf(sec);
          g.save();
          g.beginPath(); g.arc(screen[sec.id].x, screen[sec.id].y, REACH * cam.k, 0, Math.PI * 2); g.clip();
          g.beginPath();
          g.moveTo(sx(poly[0][0]), sy(poly[0][1]));
          for (let k = 1; k < poly.length; k++) g.lineTo(sx(poly[k][0]), sy(poly[k][1]));
          g.closePath();
          g.fillStyle = hex(col, sec.owner === 'player' ? 0.16 : sec.owner ? 0.075 : 0.02);
          g.fill();
          g.strokeStyle = hex(col, sec.owner ? 0.28 : 0.1);
          g.lineWidth = 1;
          g.stroke();
          g.restore();
        });
      }

      // Lanes.
      g.lineWidth = 1.3;
      g.strokeStyle = 'rgba(130,203,216,.3)';
      g.beginPath();
      for (const [a, b] of SE.LANES) { g.moveTo(screen[a].x, screen[a].y); g.lineTo(screen[b].x, screen[b].y); }
      g.stroke();

      // The route to wherever the player has tapped, over the top of the lanes.
      if (picked && picked !== here) {
        const path = (ctx.route || SE.route)(here, picked);
        if (path && path.length > 1) {
          g.lineWidth = 2.6;
          g.strokeStyle = 'rgba(239,188,127,.95)';
          g.setLineDash([7, 5]);
          g.beginPath();
          path.forEach((id, i) => i ? g.lineTo(screen[id].x, screen[id].y) : g.moveTo(screen[id].x, screen[id].y));
          g.stroke();
          g.setLineDash([]);
        }
      }

      // Systems. Size grows gently with zoom so a zoomed-out map is not blobs.
      const z = Math.max(0.7, Math.min(1.25, cam.k / (cam.fit * 2)));
      for (const sec of SE.SECTORS) {
        const p = screen[sec.id];
        if (!visible(p)) continue;
        const col = colourOf(sec);
        if (sec.station) {
          g.beginPath(); g.arc(p.x, p.y, 11 * z, 0, Math.PI * 2);
          g.fillStyle = hex(col, 0.22); g.fill();
        }
        g.beginPath(); g.arc(p.x, p.y, (sec.station ? 6 : 4) * z, 0, Math.PI * 2);
        g.fillStyle = hex(col, sec.owner ? 0.95 : 0.7); g.fill();
        if (sec.owner === 'player') {
          g.beginPath(); g.arc(p.x, p.y, 14 * z, 0, Math.PI * 2);
          g.lineWidth = 1.5; g.strokeStyle = hex(col, 0.9); g.stroke();
        }
        if (sec.id === here) {
          // Amber matches the bridge's primary-action and current-location accent.
          g.beginPath(); g.arc(p.x, p.y, 18, 0, Math.PI * 2);
          g.lineWidth = 2; g.strokeStyle = '#efbc7f'; g.stroke();
        }
        if (sec.id === picked && sec.id !== here) {
          g.beginPath(); g.arc(p.x, p.y, 21, 0, Math.PI * 2);
          g.lineWidth = 1.6; g.strokeStyle = 'rgba(63,224,200,.9)'; g.setLineDash([4, 4]);
          g.stroke(); g.setLineDash([]);
        }
      }

      /* Labels, greedily, most important first, and a label that would
         collide is simply not drawn. Sixty labels cannot all fit on a phone at
         any zoom that shows more than a handful of systems, and a label pushed
         a hundred pixels from its dot to make room is worse than none: you
         zoom in for the ones you want. Close in, they grow a status line. */
      const detailed = cam.k >= cam.fit * 2.2;
      const dots = SE.SECTORS.map(s => screen[s.id]).filter(visible);
      const toolRect = tools.getBoundingClientRect(), mapRect = cv.getBoundingClientRect();
      const toolsLeft = toolRect.left - mapRect.left - 6, toolsTop = toolRect.top - mapRect.top - 6;
      const order = SE.SECTORS.filter(s => visible(screen[s.id])).sort((a, b) => rank(b) - rank(a));
      function rank(s) {
        return (s.id === here ? 100 : 0) + (s.id === picked ? 90 : 0) + (s.owner === 'player' ? 40 : 0) +
          (s.station ? 10 : 0) + (s.generated ? 0 : 5);
      }
      for (const sec of order) {
        const p = screen[sec.id];
        const isHere = sec.id === here;
        const name = sec.name.toUpperCase();
        const c = census(sec.id);
        const status = isHere ? 'CURRENT SYSTEM' : (c.foe + c.guns) ? (c.foe + c.guns) + ' HOSTILE' :
          sec.owner === 'player' ? 'YOUR CHARTER' : sec.station ? (SE.FACTIONS[sec.owner] || {}).short + ' STATION' :
          sec.belt ? 'UNCLAIMED · BELT' : 'UNCLAIMED';
        g.font = '600 10px ui-monospace,monospace';
        const nameWidth = g.measureText(name).width;
        g.font = '8px ui-monospace,monospace';
        const w = detailed ? Math.max(nameWidth, g.measureText(status).width) + 14 : nameWidth + 10;
        const h = detailed ? 30 : 16;
        let placed = null;
        for (const [dx, dy] of [[0, 15], [0, -15 - h], [16, -h / 2], [-16 - w, -h / 2]]) {
          const box = { x: dx === 0 ? p.x - w / 2 : p.x + dx, y: p.y + dy, w, h, id: sec.id };
          if (box.x < 4 || box.y < 30 || box.x + w > W - 4 || box.y + h > H - 4) continue;
          if (labelBoxes.some(o => box.x < o.x + o.w + 3 && o.x < box.x + box.w + 3 && box.y < o.y + o.h + 3 && o.y < box.y + box.h + 3)) continue;
          // Never over another system's dot, and never under the zoom buttons.
          if (dots.some(q => q !== p && q.x > box.x - 7 && q.x < box.x + w + 7 && q.y > box.y - 7 && q.y < box.y + h + 7)) continue;
          if (box.x + w > toolsLeft && box.y + h > toolsTop) continue;
          placed = box; break;
        }
        // Where you are and where you are going are always labelled, even if
        // that means sitting over a neighbour.
        if (!placed && (isHere || sec.id === picked)) placed = { x: Math.max(4, Math.min(W - w - 4, p.x - w / 2)), y: Math.max(30, p.y + 15), w, h, id: sec.id };
        if (!placed) continue;
        labelBoxes.push(placed);
        const cx = placed.x + w / 2;
        g.textAlign = 'center';
        if (detailed) {
          g.fillStyle = isHere ? '#172b36f2' : '#0b1b28e0'; g.fillRect(placed.x, placed.y, w, h);
          g.strokeStyle = isHere ? '#efbc7f65' : '#6d9ab338'; g.lineWidth = 1; g.strokeRect(placed.x, placed.y, w, h);
          g.font = '600 10px ui-monospace,monospace'; g.fillStyle = '#e1edf3'; g.fillText(name, cx, placed.y + 12);
          g.font = '8px ui-monospace,monospace'; g.fillStyle = c.foe || c.guns ? '#eaa690' : sec.owner === 'player' ? '#f3a6dc' : '#a1c7d6';
          g.fillText(status, cx, placed.y + 24);
        } else {
          g.font = '600 10px ui-monospace,monospace'; g.fillStyle = isHere ? '#efbc7f' : sec.owner === 'player' ? '#f3a6dc' : '#cfe0ea';
          g.fillText(name, cx, placed.y + 11);
        }
      }

      /* Who holds what. The number that matters most in an empire game is how
         much of the map is yours, so it is the first thing on the map. */
      const n = holdings();
      g.textAlign = 'left';
      g.fillStyle = '#0b1b28d8'; g.fillRect(0, 0, W, 26);
      g.font = '600 10px ui-monospace,monospace';
      let x = 12;
      for (const f of HOLDERS) {
        const label = (f === 'player' ? 'YOU ' : SE.FACTIONS[f].short + ' ') + n[f];
        g.fillStyle = hex(SE.FACTIONS[f].colour, 0.95); g.fillRect(x, 10, 7, 7);
        g.fillStyle = f === 'player' ? '#f7d3ec' : '#b9d0dc'; g.fillText(label, x + 11, 17);
        x += g.measureText(label).width + 24;
      }
      g.fillStyle = '#7f98a8'; g.fillText('FREE ' + n.none, x, 17);
    }

    function describe() {
      const here = ctx.here();
      title.textContent = SE.SECTOR_BY_ID[here].name;
      if (!picked || picked === here) {
        detail.textContent = 'Drag to pan, pinch to zoom. Tap a system to inspect it.';
        setBtn.disabled = true;
        setBtn.textContent = 'SEND FLEET';
        return;
      }
      const sec = SE.SECTOR_BY_ID[picked];
      const path = (ctx.route || SE.route)(here, picked);
      const c = census(picked);
      const hops = path.length - 1;
      const owner = sec.owner ? SE.FACTIONS[sec.owner].name : 'Unclaimed frontier';
      // Systems on the way that will shoot first. The destination counts too.
      const danger = ctx.hostileHeld ? path.slice(1).filter(ctx.hostileHeld).length : 0;
      detail.textContent = (danger ? '⚠ Route crosses ' + danger + ' hostile system' + (danger === 1 ? '' : 's') + '. ' : '') +
        sec.name + ' — ' + owner + ' · ' + hops + ' jump' + (hops === 1 ? '' : 's') +
        (c.foe || c.guns ? ' · ' + (c.foe + c.guns) + ' hostile' : '') +
        (sec.station ? ' · ' + sec.station : ' · no station') + (sec.belt ? ' · asteroid belt' : '');
      setBtn.disabled = false;
      const going = ctx.courseTo() === picked;
      setBtn.disabled = going;
      setBtn.textContent = going ? 'FLEET UNDER WAY' : 'SEND FLEET — ' + hops + ' JUMP' + (hops === 1 ? '' : 'S');
    }

    function pick(x, y) {
      const label = labelBoxes.find(box => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
      let best = label ? label.id : null, bd = label ? 0 : 30;
      for (const s of SE.SECTORS) {
        const p = screen[s.id];
        const dd = Math.hypot(p.x - x, p.y - y);
        if (dd < bd) { bd = dd; best = s.id; }
      }
      if (best) { picked = (picked === best) ? null : best; describe(); draw(); }
    }

    /* ---- Input: one finger pans, two pinch, a still tap picks ------------- */
    const pointers = new Map();
    let gesture = null;
    const local = ev => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    function zoomAt(px, py, factor) {
      const gx = (px - W / 2) / cam.k + cam.x, gy = (py - H / 2) / cam.k + cam.y;
      cam.k *= factor;
      clampCam();
      cam.x = gx - (px - W / 2) / cam.k; cam.y = gy - (py - H / 2) / cam.k;
      clampCam();
      draw();
    }
    function startGesture() {
      const pts = [...pointers.values()];
      if (pts.length === 1) gesture = { kind: 'pan', sx: pts[0].x, sy: pts[0].y, cx: cam.x, cy: cam.y, moved: 0 };
      else if (pts.length === 2) gesture = { kind: 'pinch', d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, k: cam.k, moved: 99 };
    }
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', ev => {
      cv.setPointerCapture && cv.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, local(ev));
      startGesture();
    });
    cv.addEventListener('pointermove', ev => {
      if (!pointers.has(ev.pointerId) || !gesture) return;
      pointers.set(ev.pointerId, local(ev));
      const pts = [...pointers.values()];
      if (gesture.kind === 'pan' && pts.length === 1) {
        const dx = pts[0].x - gesture.sx, dy = pts[0].y - gesture.sy;
        gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
        if (gesture.moved < 6) return;       // a tap with a wobble is still a tap
        cam.x = gesture.cx - dx / cam.k; cam.y = gesture.cy - dy / cam.k;
        clampCam(); draw();
      } else if (gesture.kind === 'pinch' && pts.length === 2) {
        const dNow = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
        zoomAt(mx, my, gesture.k * dNow / gesture.d / cam.k);
      }
    });
    const end = ev => {
      if (!pointers.has(ev.pointerId)) return;
      const p = local(ev);
      const wasTap = gesture && gesture.kind === 'pan' && gesture.moved < 6 && pointers.size === 1;
      pointers.delete(ev.pointerId);
      if (wasTap && ev.type === 'pointerup') pick(p.x, p.y);
      gesture = null;
      if (pointers.size) startGesture();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const p = local(ev);
      zoomAt(p.x, p.y, Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });

    // Zoom buttons, because one-handed on a phone is the normal case.
    const tools = document.createElement('div');
    tools.className = 'gx-zoom';
    tools.innerHTML = '<button type="button" data-z="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-z="out" aria-label="Zoom out">−</button>' +
      '<button type="button" data-z="here" aria-label="Centre on current system">◎</button>' +
      '<button type="button" data-z="all" aria-label="Show whole galaxy">▢</button>';
    wrap.appendChild(tools);
    tools.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      const z = b.dataset.z;
      if (z === 'in') zoomAt(W / 2, H / 2, 1.5);
      else if (z === 'out') zoomAt(W / 2, H / 2, 1 / 1.5);
      else if (z === 'here') { focus(ctx.here()); draw(); }
      else { cam.x = (extent.x0 + extent.x1) / 2; cam.y = (extent.y0 + extent.y1) / 2; cam.k = cam.fit; clampCam(); draw(); }
    });

    window.addEventListener('resize', () => { if (open) { layout(); draw(); } });

    return {
      get open() { return open; },
      show() {
        open = true;
        picked = ctx.courseTo() || null;
        root.classList.add('on');
        layout(); focus(ctx.here()); describe(); draw();
      },
      hide() { open = false; root.classList.remove('on'); pointers.clear(); gesture = null; },
      toggle() { open ? this.hide() : this.show(); },
      get picked() { return picked; },
      refresh() { if (open) { describe(); draw(); } }
    };
  }

  SE.Galaxy = Galaxy;
})(window.SE = window.SE || {});
