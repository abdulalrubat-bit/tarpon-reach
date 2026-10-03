/* The star chart: the main screen of the game.
 *
 * Painted space underneath, crisp instruments on top. The painted layers are
 * expensive and almost never change, so they are drawn once into offscreen
 * canvases in galaxy units and blitted through the camera every frame:
 *
 *   backdrop   nebulae, dust and a few thousand stars — built once
 *   territory  each power's space as a soft glow — rebuilt only when a
 *              system changes hands
 *   sprites    one glowing star per spectral colour — built once
 *
 * Everything that moves or must stay sharp — lanes, borders, stars, the
 * fleet, routes, battle markers, labels — is vector, drawn each frame. The
 * map runs its own animation loop while it is showing (it has pulses, a
 * fleet in motion and an easing camera), and drops to half rate when nothing
 * is being touched or animated, for the battery's sake.
 *
 * Territory is still the Voronoi of the systems, clipped to each system's
 * reach — space belongs to whoever is nearest, and the border is where two
 * claims meet — but it is drawn as a glow with a border line only where the
 * owner actually changes, rather than as sixty outlined polygons.
 */
(function (SE) {
  'use strict';

  const NEUTRAL = 0x5a6472;
  const HOLDERS = ['player', 'apex', 'scrapper', 'vanguard'];
  const REACH = 95;               // how far a system's territory extends, galaxy units
  const PAD = 320;                // backdrop margin beyond the outermost systems
  // Spectral colours for the stars themselves, independent of who owns them.
  const SPECTRA = [
    { rgb: [255, 236, 196], size: 1.0 },   // yellow
    { rgb: [255, 250, 242], size: 0.9 },   // white
    { rgb: [255, 196, 146], size: 1.1 },   // orange
    { rgb: [255, 150, 120], size: 0.8 },   // red dwarf
    { rgb: [186, 214, 255], size: 1.25 }   // blue
  ];

  const rgba = (n, a) => 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  const colourOf = sec => sec.owner ? (SE.FACTIONS[sec.owner] || {}).colour || NEUTRAL : NEUTRAL;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function Galaxy(ctx) {
    const root = document.getElementById('galaxy');
    const wrap = document.getElementById('gxwrap');
    const cv = document.getElementById('galaxymap');
    const g = cv.getContext('2d');
    const title = document.getElementById('gxwhere');
    const detail = document.getElementById('gxdetail');
    const setBtn = document.getElementById('gxset');

    let open = false;
    let picked = null;
    let W = 0, H = 0, dpr = 1;
    const cam = { k: 1, x: 0, y: 0, fit: 1 };          // px per galaxy unit; galaxy point at screen centre
    const goal = { k: 1, x: 0, y: 0, active: false };  // where the camera is easing to
    const vel = { x: 0, y: 0 };                        // pan momentum, galaxy units per second
    const screen = {};
    const labelBoxes = [];
    let clock = 0, lastFrame = 0, raf = 0, idleFrames = 0, lastTap = { t: 0, x: 0, y: 0 };

    /* ---- Static geometry ------------------------------------------------- */
    const extent = (() => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of SE.SECTORS) { x0 = Math.min(x0, s.gx); x1 = Math.max(x1, s.gx); y0 = Math.min(y0, s.gy); y1 = Math.max(y1, s.gy); }
      return { x0, y0, x1, y1 };
    })();
    const box = { x0: extent.x0 - PAD, y0: extent.y0 - PAD, x1: extent.x1 + PAD, y1: extent.y1 + PAD };
    const spectrum = SE.SECTORS.map(s => SPECTRA[SE.hashSeed('star:' + s.id) % SPECTRA.length]);

    const D = window.d3 && window.d3.Delaunay;
    const delaunay = D ? D.from(SE.SECTORS.map(s => [s.gx, s.gy])) : null;
    const voronoi = delaunay ? delaunay.voronoi([box.x0 - 2000, box.y0 - 2000, box.x1 + 2000, box.y1 + 2000]) : null;
    const cells = voronoi ? SE.SECTORS.map((s, i) => voronoi.cellPolygon(i)) : [];

    /* Shared Voronoi edges between neighbouring systems, clipped to both
       systems' reach. A border is drawn along one of these only when the two
       sides have different owners, so it is computed once and filtered per
       frame. */
    const edges = [];
    function clipToDisc(a, b, c, r) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const fx = a[0] - c[0], fy = a[1] - c[1];
      const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
      const disc = B * B - 4 * A * C;
      if (disc <= 0 || A < 1e-12) return null;
      const s = Math.sqrt(disc);
      const t0 = Math.max(0, (-B - s) / (2 * A)), t1 = Math.min(1, (-B + s) / (2 * A));
      if (t1 <= t0) return null;
      return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
    }
    if (delaunay) {
      SE.SECTORS.forEach((s, i) => {
        for (const j of delaunay.neighbors(i)) {
          if (j <= i || !cells[i] || !cells[j]) continue;
          const shared = cells[i].filter(p => cells[j].some(q => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6));
          if (shared.length < 2) continue;
          let seg = clipToDisc(shared[0], shared[1], [s.gx, s.gy], REACH);
          if (seg) seg = clipToDisc(seg[0], seg[1], [SE.SECTORS[j].gx, SE.SECTORS[j].gy], REACH);
          if (seg) edges.push({ i, j, a: seg[0], b: seg[1] });
        }
      });
    }

    /* ---- Painted layers --------------------------------------------------- */
    const BACK_SCALE = 1.6;          // backdrop pixels per galaxy unit
    function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

    const backdrop = (() => {
      const w = Math.round((box.x1 - box.x0) * BACK_SCALE), h = Math.round((box.y1 - box.y0) * BACK_SCALE);
      const c = canvas(w, h), b = c.getContext('2d'), rng = SE.Rng('galaxy-backdrop');
      b.scale(BACK_SCALE, BACK_SCALE); b.translate(-box.x0, -box.y0);
      b.globalCompositeOperation = 'lighter';
      // A faint core where the old powers are, then nebulae scattered across.
      const core = b.createRadialGradient(0, 30, 0, 0, 30, 520);
      core.addColorStop(0, 'rgba(120,150,190,.16)'); core.addColorStop(1, 'rgba(120,150,190,0)');
      b.fillStyle = core; b.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      const hues = [[70, 120, 200], [130, 80, 190], [40, 150, 160], [190, 80, 120], [90, 70, 170]];
      for (let i = 0; i < 26; i++) {
        const x = rng.float(box.x0 + 80, box.x1 - 80), y = rng.float(box.y0 + 80, box.y1 - 80);
        const r = rng.float(90, 300), h = rng.pick(hues), a = rng.float(0.05, 0.13);
        // Each cloud is a few offset puffs, so it reads as gas rather than a disc.
        for (let k = 0; k < 4; k++) {
          const px = x + rng.float(-r, r) * 0.5, py = y + rng.float(-r, r) * 0.5, pr = r * rng.float(0.45, 0.9);
          const grad = b.createRadialGradient(px, py, 0, px, py, pr);
          grad.addColorStop(0, `rgba(${h[0]},${h[1]},${h[2]},${a})`); grad.addColorStop(1, `rgba(${h[0]},${h[1]},${h[2]},0)`);
          b.fillStyle = grad; b.beginPath(); b.arc(px, py, pr, 0, Math.PI * 2); b.fill();
        }
      }
      // Dust: dark wisps cut back out of the glow.
      b.globalCompositeOperation = 'source-over';
      for (let i = 0; i < 18; i++) {
        const x = rng.float(box.x0, box.x1), y = rng.float(box.y0, box.y1), r = rng.float(60, 180);
        const grad = b.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(4,8,14,.35)'); grad.addColorStop(1, 'rgba(4,8,14,0)');
        b.fillStyle = grad; b.beginPath(); b.arc(x, y, r, 0, Math.PI * 2); b.fill();
      }
      // Background stars, denser towards the core.
      for (let i = 0; i < 2600; i++) {
        let x, y;
        if (rng.chance(0.55)) { const a = rng.float(0, Math.PI * 2), d = Math.abs(rng.float(-1, 1) * rng.float(0, 1)) * 650; x = Math.cos(a) * d; y = 30 + Math.sin(a) * d * 0.82; }
        else { x = rng.float(box.x0, box.x1); y = rng.float(box.y0, box.y1); }
        const bright = rng.next();
        b.fillStyle = `rgba(${bright > 0.8 ? '255,230,210' : bright > 0.6 ? '200,220,255' : '220,230,240'},${rng.float(0.12, 0.7)})`;
        b.fillRect(x, y, rng.float(0.35, 0.9), rng.float(0.35, 0.9));
      }
      // Fade the whole layer out towards its own edges, so zoomed out there is
      // no rectangle where the painting stops.
      b.globalCompositeOperation = 'destination-in';
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, rr = Math.max(box.x1 - box.x0, box.y1 - box.y0) / 2;
      const fade = b.createRadialGradient(cx, cy, rr * 0.45, cx, cy, rr);
      fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
      b.fillStyle = fade; b.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      b.globalCompositeOperation = 'source-over';
      return c;
    })();

    /* One glowing star per spectral colour, drawn at 64 px and scaled down. */
    const sprites = SPECTRA.map(sp => {
      const c = canvas(64, 64), s = c.getContext('2d');
      const grad = s.createRadialGradient(32, 32, 0, 32, 32, 32);
      const [r, gg, b] = sp.rgb;
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.12, `rgba(${r},${gg},${b},1)`);
      grad.addColorStop(0.3, `rgba(${r},${gg},${b},.35)`);
      grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      s.fillStyle = grad; s.fillRect(0, 0, 64, 64);
      return c;
    });

    let territory = null, territorySig = '';
    const TERR_SCALE = 1.2;
    function buildTerritory() {
      const sig = SE.SECTORS.map(s => s.owner || '-').join(',');
      if (sig === territorySig && territory) return;
      territorySig = sig;
      const w = Math.round((box.x1 - box.x0) * TERR_SCALE), h = Math.round((box.y1 - box.y0) * TERR_SCALE);
      const raw = canvas(w, h), r = raw.getContext('2d');
      r.scale(TERR_SCALE, TERR_SCALE); r.translate(-box.x0, -box.y0);
      SE.SECTORS.forEach((sec, i) => {
        if (!sec.owner || !cells[i]) return;
        r.save();
        r.beginPath(); r.arc(sec.gx, sec.gy, REACH, 0, Math.PI * 2); r.clip();
        r.beginPath();
        const poly = cells[i];
        r.moveTo(poly[0][0], poly[0][1]);
        for (let k = 1; k < poly.length; k++) r.lineTo(poly[k][0], poly[k][1]);
        r.closePath();
        // Brightest at the star, fading to nothing at the edge of its reach:
        // flat fills read as paint-by-numbers once you zoom in.
        const col = colourOf(sec), peak = sec.owner === 'player' ? 0.5 : 0.36;
        const grad = r.createRadialGradient(sec.gx, sec.gy, 0, sec.gx, sec.gy, REACH);
        grad.addColorStop(0, rgba(col, peak));
        grad.addColorStop(0.55, rgba(col, peak * 0.55));
        grad.addColorStop(1, rgba(col, 0.04));
        r.fillStyle = grad;
        r.fill();
        r.restore();
      });
      // Soften: blur once into the cached layer. A canvas filter is far too
      // slow to run per frame, and free when it runs once per change of hands.
      territory = canvas(w, h);
      const t = territory.getContext('2d');
      t.filter = 'blur(6px)';
      t.drawImage(raw, 0, 0);
      t.filter = 'none';
    }

    /* ---- Camera ------------------------------------------------------------ */
    const sx = gx => (gx - cam.x) * cam.k + W / 2;
    const sy = gy => (gy - cam.y) * cam.k + H / 2;
    const wx = px => (px - W / 2) / cam.k + cam.x;
    const wy = py => (py - H / 2) / cam.k + cam.y;
    const minK = () => cam.fit * 0.9, maxK = () => cam.fit * 7;

    function clamp(c) {
      c.k = Math.max(minK(), Math.min(maxK(), c.k));
      const mx = W / 2 / c.k, my = H / 2 / c.k;
      c.x = Math.max(extent.x0 - mx * 0.6, Math.min(extent.x1 + mx * 0.6, c.x));
      c.y = Math.max(extent.y0 - my * 0.6, Math.min(extent.y1 + my * 0.6, c.y));
    }
    function easeTo(x, y, k) {
      goal.x = x; goal.y = y; goal.k = k || cam.k; goal.active = true;
      clamp(goal);
      vel.x = vel.y = 0;
      wake();
    }
    function zoomAt(px, py, factor, animate) {
      const gx = wx(px), gy = wy(py);
      const k = Math.max(minK(), Math.min(maxK(), (animate && goal.active ? goal.k : cam.k) * factor));
      // Keep the galaxy point under the finger where it is.
      const x = gx - (px - W / 2) / k, y = gy - (py - H / 2) / k;
      if (animate) easeTo(x, y, k);
      else { cam.k = k; cam.x = x; cam.y = y; clamp(cam); goal.active = false; }
    }

    function layout() {
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      cam.fit = Math.min((W - 40) / Math.max(1, extent.x1 - extent.x0), (H - 70) / Math.max(1, extent.y1 - extent.y0));
      clamp(cam);
    }

    function focus(id, k) {
      const s = SE.SECTOR_BY_ID[id];
      if (s) { cam.x = s.gx; cam.y = s.gy; }
      cam.k = k || Math.max(cam.fit * 1.4, Math.min(W, H) / 400);
      clamp(cam);
      goal.active = false;
    }

    /* ---- What is where ----------------------------------------------------- */
    function census(id) {
      let mine = 0, foe = 0, guns = 0;
      for (const s of ctx.ships(id)) {
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

    /* Where a ship of yours is, on the chart. Gates sit out at the edge of a
       system in the direction of the system they lead to, so a ship's position
       inside its system maps onto the chart as an offset from the star in that
       same direction — a fleet flying to a gate visibly heads up the lane,
       and after the jump it comes in from the other end. */
    const HALF_LANE = 34;
    function shipOnChart(s) {
      const sec = SE.SECTOR_BY_ID[s.sector];
      const k = HALF_LANE / SE.Transit.rules.gate;
      return { x: sec.gx + s.x * k, y: sec.gy + s.z * k };
    }

    /* ---- Drawing -------------------------------------------------------------- */
    const textWidth = new Map();
    function measure(font, text) {
      const key = font + '|' + text;
      let w = textWidth.get(key);
      if (w === undefined) { g.font = font; w = g.measureText(text).width; textWidth.set(key, w); }
      return w;
    }

    function blit(img, scale) {
      // An offscreen layer in galaxy units, through the camera.
      g.drawImage(img, sx(box.x0), sy(box.y0), img.width / scale * cam.k, img.height / scale * cam.k);
    }

    function draw() {
      const here = ctx.here();
      const t = clock;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      labelBoxes.length = 0;

      for (const s of SE.SECTORS) { const p = screen[s.id] || (screen[s.id] = { x: 0, y: 0 }); p.x = sx(s.gx); p.y = sy(s.gy); }
      const visible = p => p.x > -80 && p.x < W + 80 && p.y > -80 && p.y < H + 80;

      // Painted space.
      blit(backdrop, BACK_SCALE);
      buildTerritory();
      blit(territory, TERR_SCALE);

      // Borders: only where the owner changes, each side in its own colour.
      for (const e of edges) {
        const A = SE.SECTORS[e.i], B = SE.SECTORS[e.j];
        if (A.owner === B.owner) continue;
        const ax = sx(e.a[0]), ay = sy(e.a[1]), bx = sx(e.b[0]), by = sy(e.b[1]);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        let nx = -(by - ay) / len, ny = (bx - ax) / len;
        // Normal pointing towards A's system.
        if ((screen[A.id].x - ax) * nx + (screen[A.id].y - ay) * ny < 0) { nx = -nx; ny = -ny; }
        for (const [sec, sign] of [[A, 1], [B, -1]]) {
          if (!sec.owner) continue;
          const o = 1.6 * sign;
          g.strokeStyle = rgba(colourOf(sec), 0.75);
          g.lineWidth = 1.3;
          g.beginPath(); g.moveTo(ax + nx * o, ay + ny * o); g.lineTo(bx + nx * o, by + ny * o); g.stroke();
        }
      }

      // Lanes: faint generally, warm inside your own space.
      g.lineCap = 'round';
      for (const [a, b] of SE.LANES) {
        const A = screen[a], B = screen[b];
        if (!visible(A) && !visible(B)) continue;
        const ours = SE.SECTOR_BY_ID[a].owner === 'player' && SE.SECTOR_BY_ID[b].owner === 'player';
        g.strokeStyle = ours ? 'rgba(239,92,196,.55)' : 'rgba(150,205,225,.22)';
        g.lineWidth = ours ? 1.8 : 1.1;
        g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
      }

      // The fleet's course, flowing towards where it is going; and a preview
      // of the route to whatever has been tapped.
      const course = ctx.courseTo();
      const drawRoute = (to, colour, width) => {
        const path = (ctx.route || SE.route)(here, to);
        if (!path || path.length < 2) return;
        g.strokeStyle = colour; g.lineWidth = width;
        g.setLineDash([7, 6]); g.lineDashOffset = -t * 18;
        g.beginPath();
        path.forEach((id, i) => i ? g.lineTo(screen[id].x, screen[id].y) : g.moveTo(screen[id].x, screen[id].y));
        g.stroke();
        g.setLineDash([]); g.lineDashOffset = 0;
      };
      if (picked && picked !== here && picked !== course) drawRoute(picked, 'rgba(63,224,200,.6)', 1.6);
      if (course) drawRoute(course, 'rgba(239,188,127,.95)', 2.4);

      // Systems.
      const z = Math.max(0.75, Math.min(1.35, cam.k / (cam.fit * 2)));
      const battles = ctx.battles ? ctx.battles() : [];
      const battleAt = new Set(battles.map(b => b.sector));
      const eventAt = new Map((ctx.events ? ctx.events() : []).map(e => [e.sector, e]));
      const siegeAt = new Map((ctx.sieges ? ctx.sieges() : []).map(x => [x.sector, x.progress || 0]));
      for (let i = 0; i < SE.SECTORS.length; i++) {
        const sec = SE.SECTORS[i], p = screen[sec.id];
        if (!visible(p)) continue;
        const sp = spectrum[i], col = colourOf(sec);
        const r = (sec.station ? 15 : 11) * sp.size * z;
        g.globalAlpha = sec.owner || sec.station ? 1 : 0.75;
        g.drawImage(sprites[SPECTRA.indexOf(sp)], p.x - r, p.y - r, r * 2, r * 2);
        g.globalAlpha = 1;
        // Who holds it: a ring in their colour; yours doubled.
        if (sec.owner) {
          g.strokeStyle = rgba(col, 0.9); g.lineWidth = 1.4;
          g.beginPath(); g.arc(p.x, p.y, 8.5 * z, 0, Math.PI * 2); g.stroke();
          if (sec.owner === 'player') { g.strokeStyle = rgba(col, 0.55); g.beginPath(); g.arc(p.x, p.y, 12 * z, 0, Math.PI * 2); g.stroke(); }
        }
        // A station: a small hexagon riding the ring.
        if (sec.station) {
          const hx = p.x + 8.5 * z * 0.71, hy = p.y - 8.5 * z * 0.71, hr = 3.2 * z;
          g.fillStyle = rgba(col, 1); g.strokeStyle = '#04080e'; g.lineWidth = 1.2;
          g.beginPath();
          for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; g.lineTo(hx + Math.cos(a) * hr, hy + Math.sin(a) * hr); }
          g.closePath(); g.fill(); g.stroke();
        }
        if (sec.id === here) {
          const pr = 17 * z + Math.sin(t * 3) * 2;
          g.strokeStyle = 'rgba(239,188,127,.95)'; g.lineWidth = 2;
          g.beginPath(); g.arc(p.x, p.y, pr, 0, Math.PI * 2); g.stroke();
        }
        if (sec.id === picked && sec.id !== here) {
          g.strokeStyle = 'rgba(63,224,200,.95)'; g.lineWidth = 1.6;
          g.setLineDash([5, 5]); g.lineDashOffset = -t * 12;
          g.beginPath(); g.arc(p.x, p.y, 20 * z, 0, Math.PI * 2); g.stroke();
          g.setLineDash([]); g.lineDashOffset = 0;
        }
        // A galaxy event here: a small badge with its symbol, up and to the left.
        const badge = eventAt.get(sec.id);
        if (badge) {
          const bx = p.x - 13 * z, by = p.y - 13 * z, br = 7 * z;
          g.fillStyle = '#05090f'; g.strokeStyle = badge.colour; g.lineWidth = 1.5;
          g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill(); g.stroke();
          g.fillStyle = badge.colour; g.font = `600 ${Math.round(9 * z)}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(badge.icon, bx, by + 0.5);
        }
        // A siege: how far the station's shield has fallen, as an arc.
        if (siegeAt.has(sec.id)) {
          const r0 = 15 * z;
          g.strokeStyle = 'rgba(239,188,127,.25)'; g.lineWidth = 3;
          g.beginPath(); g.arc(p.x, p.y, r0, 0, Math.PI * 2); g.stroke();
          g.strokeStyle = 'rgba(255,170,80,.95)';
          g.beginPath(); g.arc(p.x, p.y, r0, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, siegeAt.get(sec.id)) * Math.PI * 2); g.stroke();
        }
        if (battleAt.has(sec.id)) {
          const pulse = (t * 1.6) % 1;
          g.strokeStyle = `rgba(240,106,90,${1 - pulse})`; g.lineWidth = 2.2;
          g.beginPath(); g.arc(p.x, p.y, 14 * z + pulse * 22, 0, Math.PI * 2); g.stroke();
        }
      }

      // Your ships: the flagship as a chevron, the rest as dots.
      const mine = ctx.fleet ? ctx.fleet() : [];
      for (const s of mine) {
        if (s.isPlayer) continue;
        const q = shipOnChart(s), x = sx(q.x), y = sy(q.y);
        g.fillStyle = 'rgba(247,140,214,.85)';
        g.beginPath(); g.arc(x, y, 2.1, 0, Math.PI * 2); g.fill();
      }
      const me = mine.find(s => s.isPlayer);
      if (me) {
        const q = shipOnChart(me), x = sx(q.x), y = sy(q.y);
        const f = SE.AI.forward(me, { x: 0, y: 0, z: 0 });
        const fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
        const s = 6;
        g.fillStyle = '#ffd7f1'; g.strokeStyle = '#ef5cc4'; g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x + fx * s * 1.4, y + fz * s * 1.4);
        g.lineTo(x - fx * s + fz * s * 0.8, y - fz * s - fx * s * 0.8);
        g.lineTo(x - fx * s * 0.4, y - fz * s * 0.4);
        g.lineTo(x - fx * s - fz * s * 0.8, y - fz * s + fx * s * 0.8);
        g.closePath(); g.fill(); g.stroke();
      }

      // Labels and status icons. Most important first; a label that would
      // collide is left out rather than shoved away from its star.
      const named = cam.k >= cam.fit * 1.25;
      const detailed = cam.k >= cam.fit * 2.2;
      const dots = SE.SECTORS.map(s => screen[s.id]).filter(visible);
      const toolsRect = tools.getBoundingClientRect(), mapRect = cv.getBoundingClientRect();
      const toolsLeft = toolsRect.left - mapRect.left - 6, toolsTop = toolsRect.top - mapRect.top - 6;
      const rank = s => (s.id === here ? 100 : 0) + (s.id === picked ? 90 : 0) + (battleAt.has(s.id) ? 60 : 0) +
        (s.owner === 'player' ? 40 : 0) + (s.station ? 10 : 0) + (s.generated ? 0 : 5);
      const order = SE.SECTORS.filter(s => visible(screen[s.id])).sort((a, b) => rank(b) - rank(a));
      const NAME = '600 10px ui-monospace,monospace';
      for (const sec of order) {
        const p = screen[sec.id];
        const important = sec.id === here || sec.id === picked || battleAt.has(sec.id) || sec.owner === 'player';
        if (!named && !important) continue;
        const name = sec.name.toUpperCase();
        const c = detailed || important ? census(sec.id) : null;
        const icons = [];
        if (c && (c.foe + c.guns)) icons.push({ kind: 'foe', n: c.foe + c.guns });
        if (detailed && sec.belt) icons.push({ kind: 'belt' });
        if (detailed && ctx.outposts && ctx.outposts(sec.id)) icons.push({ kind: 'works', n: ctx.outposts(sec.id) });
        const w = Math.max(measure(NAME, name), icons.length * 22) + 10;
        const h = icons.length ? 28 : 15;
        const y0 = p.y + 14 * z + 4;
        const boxR = { x: p.x - w / 2, y: y0, w, h, id: sec.id };
        const clash = boxR.x < 2 || boxR.x + w > W - 2 || boxR.y + h > H - 2 ||
          (boxR.x + w > toolsLeft && boxR.y + h > toolsTop) ||
          labelBoxes.some(o => boxR.x < o.x + o.w + 2 && o.x < boxR.x + w + 2 && boxR.y < o.y + o.h + 2 && o.y < boxR.y + h + 2) ||
          dots.some(q => q !== p && q.x > boxR.x - 6 && q.x < boxR.x + w + 6 && q.y > boxR.y - 6 && q.y < boxR.y + h + 6);
        if (clash && !(sec.id === here || sec.id === picked)) continue;
        labelBoxes.push(boxR);
        g.font = NAME; g.textAlign = 'center'; g.textBaseline = 'top';
        g.lineWidth = 3; g.lineJoin = 'round'; g.miterLimit = 2; g.strokeStyle = 'rgba(5,10,17,.85)';
        const ink = sec.id === here ? '#efbc7f' : sec.owner === 'player' ? '#f7c3e6' : sec.owner ? '#e1edf3' : '#aab8c4';
        g.strokeText(name, p.x, y0); g.fillStyle = ink; g.fillText(name, p.x, y0);
        let ix = p.x - (icons.length * 22 - 4) / 2;
        for (const ic of icons) { drawIcon(ic, ix, y0 + 14); ix += 22; }
      }
      g.textBaseline = 'alphabetic';

      // Who holds what, across the top.
      const n = holdings();
      g.fillStyle = 'rgba(8,16,25,.82)'; g.fillRect(0, 0, W, 26);
      g.font = '600 10px ui-monospace,monospace'; g.textAlign = 'left';
      let x = 12;
      for (const f of HOLDERS) {
        const label = (f === 'player' ? 'YOU ' : SE.FACTIONS[f].short + ' ') + n[f];
        g.fillStyle = rgba(SE.FACTIONS[f].colour, 0.95); g.beginPath(); g.arc(x + 3.5, 13, 3.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = f === 'player' ? '#f7d3ec' : '#b9d0dc'; g.fillText(label, x + 11, 17);
        x += measure('600 10px ui-monospace,monospace', label) + 24;
      }
      g.fillStyle = '#7f98a8'; g.fillText('FREE ' + n.none, x, 17);
    }

    // Tiny status glyphs under a name: hostiles, asteroid belt, your facilities.
    function drawIcon(ic, x, y) {
      g.save();
      if (ic.kind === 'foe') {
        g.fillStyle = 'rgba(240,106,90,.95)'; g.beginPath(); g.arc(x + 6, y + 6, 6, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#1a0b0d'; g.font = '700 8px ui-monospace,monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(ic.n > 9 ? '9+' : String(ic.n), x + 6, y + 6.5);
      } else if (ic.kind === 'belt') {
        g.fillStyle = 'rgba(190,175,150,.9)';
        for (const [dx, dy, r] of [[2, 8, 1.6], [5.5, 4, 2.2], [9.5, 7, 1.7], [12, 3, 1.2]]) { g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI * 2); g.fill(); }
      } else if (ic.kind === 'works') {
        g.fillStyle = 'rgba(239,188,127,.95)'; g.fillRect(x + 1, y + 1, 10, 10);
        g.fillStyle = '#1a140b'; g.font = '700 8px ui-monospace,monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(ic.n), x + 6, y + 6.5);
      }
      g.restore();
    }

    /* ---- The animation loop ---------------------------------------------------- */
    function wake() { idleFrames = 0; if (open && !raf) raf = requestAnimationFrame(frame); }
    function frame(now) {
      raf = 0;
      if (!open) return;
      const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.016;
      lastFrame = now;
      clock += dt;
      let moving = false;
      if (goal.active) {
        // Ease in log space for zoom, so zooming feels even at every scale.
        const e = 1 - Math.exp(-dt * 9);
        cam.x += (goal.x - cam.x) * e; cam.y += (goal.y - cam.y) * e;
        cam.k = Math.exp(Math.log(cam.k) + (Math.log(goal.k) - Math.log(cam.k)) * e);
        if (Math.abs(goal.x - cam.x) * cam.k < 0.3 && Math.abs(goal.y - cam.y) * cam.k < 0.3 && Math.abs(goal.k / cam.k - 1) < 0.002) {
          cam.x = goal.x; cam.y = goal.y; cam.k = goal.k; goal.active = false;
        }
        moving = true;
      } else if (Math.hypot(vel.x, vel.y) * cam.k > 4 && !pointers.size) {
        cam.x += vel.x * dt; cam.y += vel.y * dt;
        const decay = Math.exp(-dt * 4.5);
        vel.x *= decay; vel.y *= decay;
        clamp(cam);
        moving = true;
      }
      // Half rate when nothing is moving: the pulses still breathe, the
      // battery notices less.
      idleFrames = moving || pointers.size ? 0 : idleFrames + 1;
      if (moving || pointers.size || idleFrames % 2 === 0) draw();
      raf = requestAnimationFrame(frame);
    }

    /* ---- The info card ------------------------------------------------------------ */
    function describe() {
      const here = ctx.here();
      title.textContent = SE.SECTOR_BY_ID[here].name;
      if (!picked || picked === here) {
        detail.innerHTML = '';
        setBtn.disabled = true;
        setBtn.textContent = 'SEND FLEET';
        return;
      }
      const sec = SE.SECTOR_BY_ID[picked];
      const path = (ctx.route || SE.route)(here, picked);
      const c = census(picked);
      const hops = path.length - 1;
      const owner = sec.owner === 'player' ? 'Your charter' : sec.owner ? SE.FACTIONS[sec.owner].name : 'Unclaimed frontier';
      const danger = ctx.hostileHeld ? path.slice(1).filter(ctx.hostileHeld).length : 0;
      const works = ctx.outposts ? ctx.outposts(picked) : 0;
      const inf = ctx.influence ? Math.floor(ctx.influence(picked) || 0) : 0;
      const chips = [];
      if (sec.station) chips.push(`<span class="gxi-chip">⬡ ${esc(sec.station)}</span>`);
      if (sec.belt) chips.push('<span class="gxi-chip">◌ Asteroid belt</span>');
      if (c.foe) chips.push(`<span class="gxi-chip foe">⚔ ${c.foe} hostile ship${c.foe === 1 ? '' : 's'}</span>`);
      if (c.guns) chips.push(`<span class="gxi-chip foe">▣ ${c.guns} hostile gun${c.guns === 1 ? '' : 's'}</span>`);
      if (c.mine) chips.push(`<span class="gxi-chip mine">▲ ${c.mine} of yours</span>`);
      if (works) chips.push(`<span class="gxi-chip mine">■ ${works} facilit${works === 1 ? 'y' : 'ies'}</span>`);
      if (!sec.owner && inf) chips.push(`<span class="gxi-chip">Influence ${inf}/60</span>`);
      const happening = ctx.eventsAt ? ctx.eventsAt(picked) : [];
      for (const e of happening) chips.push(`<span class="gxi-chip ev" style="border-color:${SE.Events.KINDS[e.kind].colour}">${SE.Events.KINDS[e.kind].icon} ${esc(SE.Events.KINDS[e.kind].title)}</span>`);
      detail.innerHTML = `<div class="gxi"><div class="gxi-head"><b>${esc(sec.name)}</b><span class="gxi-owner" style="color:${rgba(colourOf(sec), 1)}">${esc(owner)}</span><span class="gxi-hops">${hops} jump${hops === 1 ? '' : 's'}</span></div>` +
        (chips.length ? `<div class="gxi-chips">${chips.join('')}</div>` : '') +
        (danger ? `<div class="gxi-warn">⚠ Route crosses ${danger} hostile system${danger === 1 ? '' : 's'}</div>` : '') +
        happening.map(e => `<div class="gxi-ev">${esc(e.text)}</div>`).join('') + '</div>';
      const going = ctx.courseTo() === picked;
      setBtn.disabled = going;
      setBtn.textContent = going ? 'FLEET UNDER WAY' : 'SEND FLEET · ' + hops + ' JUMP' + (hops === 1 ? '' : 'S');
    }

    function pick(x, y) {
      let best = null, bd = 30;
      for (const s of SE.SECTORS) {
        const p = screen[s.id];
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = s.id; }
      }
      if (!best) { const label = labelBoxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h); if (label) best = label.id; }
      if (!best) return;
      picked = (picked === best) ? null : best;
      // Bring a system tapped near the edge in towards the middle.
      if (picked) {
        const p = screen[picked];
        if (p.x < W * 0.2 || p.x > W * 0.8 || p.y < H * 0.2 || p.y > H * 0.75) easeTo(SE.SECTOR_BY_ID[picked].gx, SE.SECTOR_BY_ID[picked].gy);
      }
      describe(); wake();
    }

    /* ---- Input: drag pans with momentum, pinch zooms, double-tap zooms in ---------- */
    const pointers = new Map();
    let gesture = null;
    const local = ev => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top, t: performance.now() }; };
    function startGesture() {
      const pts = [...pointers.values()];
      if (pts.length === 1) gesture = { kind: 'pan', sx: pts[0].x, sy: pts[0].y, cx: cam.x, cy: cam.y, moved: 0, lx: pts[0].x, ly: pts[0].y, lt: pts[0].t };
      else if (pts.length === 2) gesture = { kind: 'pinch', d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, k: cam.k, moved: 99 };
    }
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', ev => {
      cv.setPointerCapture && cv.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, local(ev));
      goal.active = false; vel.x = vel.y = 0;
      startGesture(); wake();
    });
    cv.addEventListener('pointermove', ev => {
      if (!pointers.has(ev.pointerId) || !gesture) return;
      const p = local(ev);
      pointers.set(ev.pointerId, p);
      const pts = [...pointers.values()];
      if (gesture.kind === 'pan' && pts.length === 1) {
        const dx = p.x - gesture.sx, dy = p.y - gesture.sy;
        gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
        if (gesture.moved < 6) return;
        cam.x = gesture.cx - dx / cam.k; cam.y = gesture.cy - dy / cam.k;
        clamp(cam);
        // Velocity from the last few milliseconds, for the fling.
        const dtm = Math.max(1, p.t - gesture.lt);
        vel.x = -(p.x - gesture.lx) / cam.k / dtm * 1000; vel.y = -(p.y - gesture.ly) / cam.k / dtm * 1000;
        gesture.lx = p.x; gesture.ly = p.y; gesture.lt = p.t;
      } else if (gesture.kind === 'pinch' && pts.length === 2) {
        const dNow = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, gesture.k * dNow / gesture.d / cam.k, false);
      }
      wake();
    });
    const end = ev => {
      if (!pointers.has(ev.pointerId)) return;
      const p = local(ev);
      const tap = gesture && gesture.kind === 'pan' && gesture.moved < 6 && pointers.size === 1;
      // A fling only if the finger was still moving when it lifted.
      if (gesture && gesture.kind === 'pan' && p.t - gesture.lt > 60) vel.x = vel.y = 0;
      pointers.delete(ev.pointerId);
      if (tap && ev.type === 'pointerup') {
        const dbl = p.t - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30;
        if (dbl) { zoomAt(p.x, p.y, 2, true); lastTap.t = 0; }
        else { pick(p.x, p.y); lastTap = { t: p.t, x: p.x, y: p.y }; }
        vel.x = vel.y = 0;
      }
      gesture = null;
      if (pointers.size) startGesture();
      wake();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const p = local(ev);
      zoomAt(p.x, p.y, Math.exp(-ev.deltaY * 0.0015), false);
      wake();
    }, { passive: false });

    // Zoom buttons, because one-handed on a phone is the normal case.
    const tools = document.createElement('div');
    tools.className = 'gx-zoom';
    tools.innerHTML = '<button type="button" data-z="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-z="out" aria-label="Zoom out">−</button>' +
      '<button type="button" data-z="here" aria-label="Centre on your fleet">◎</button>' +
      '<button type="button" data-z="all" aria-label="Show whole galaxy">▢</button>';
    wrap.appendChild(tools);
    tools.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      const z = b.dataset.z;
      if (z === 'in') zoomAt(W / 2, H / 2, 1.6, true);
      else if (z === 'out') zoomAt(W / 2, H / 2, 1 / 1.6, true);
      else if (z === 'here') { const s = SE.SECTOR_BY_ID[ctx.here()]; easeTo(s.gx, s.gy, Math.max(cam.fit * 1.4, Math.min(W, H) / 400)); }
      else easeTo((extent.x0 + extent.x1) / 2, (extent.y0 + extent.y1) / 2, cam.fit);
    });

    window.addEventListener('resize', () => { if (open) { layout(); wake(); } });

    return {
      get open() { return open; },
      show() {
        const first = !open;
        open = true;
        picked = ctx.courseTo() || null;
        root.classList.add('on');
        layout();
        if (first) focus(ctx.here());
        describe(); wake();
      },
      hide() { open = false; root.classList.remove('on'); pointers.clear(); gesture = null; if (raf) cancelAnimationFrame(raf); raf = 0; lastFrame = 0; },
      toggle() { open ? this.hide() : this.show(); },
      get picked() { return picked; },
      refresh() { if (open) { describe(); wake(); } }
    };
  }

  SE.Galaxy = Galaxy;
})(window.SE = window.SE || {});
