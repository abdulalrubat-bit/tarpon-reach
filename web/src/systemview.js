/* The system view: one star system, top down, live.
 *
 * The star chart says what you own. This says what it is doing: miners on the
 * belt, freighters on the lanes, a patrol circling, two pirates working over a
 * hauler. Nothing here decides anything — every position, order and shot is
 * the same simulation the chart reads (world.tickOOS); this file only draws it
 * and turns taps into the same commands the Fleet panel issues.
 *
 * Phaser, because this is the one screen that is a scene rather than a
 * document: it redraws every frame, it pans and zooms, and the battles that
 * come next will want its tweens and particles.
 *
 * Coordinates: world X is screen X and world Z is screen Y. The game's height
 * axis is dropped; this is a plan view, the way the lanes and gates are laid
 * out. The simulation ticks four times a second, so every ship is drawn
 * interpolated between its last two ticks or it would move in hops.
 */
(function (SE) {
  'use strict';

  const NEUTRAL = 0x8a96a6;
  // On-screen size of a hull, in CSS pixels, whatever the zoom. Real sizes
  // (3 m to 26 m against a 4 km system) would make every ship a speck.
  const HULL_PX = { interceptor: 5, corvette: 6.5, extractor: 7.5, freighter: 8.5, dreadnought: 13 };
  const TAP_PX = 26;
  const SHOT_LIFE = 0.16;

  const colourOf = faction => (SE.FACTIONS[faction] || {}).colour || NEUTRAL;

  function SystemView(host) {
    const root = document.getElementById('system');
    const wrap = document.getElementById('syswrap');
    const title = document.getElementById('sys-name');
    const sub = document.getElementById('sys-owner');
    const census = document.getElementById('sys-census');
    const panel = document.getElementById('sys-panel');
    const world = host.world;

    let game = null, scene = null;
    let sectorId = null;
    let selected = null;            // { kind: 'ship', id } | { kind: 'station', id } | { kind: 'gate', to }
    const prev = new Map();         // ship id -> {x, z} at the previous tick
    const shots = [];               // short-lived weapon flashes
    let dpr = 1;

    /* ---- Simulation hooks -------------------------------------------------- */
    function onTick() {
      if (!sectorId) return;
      for (const s of world.registry.inSector(sectorId)) {
        const p = prev.get(s.id);
        if (p) { p.x = p.nx; p.z = p.nz; p.nx = s.x; p.nz = s.z; }
        else prev.set(s.id, { x: s.x, z: s.z, nx: s.x, nz: s.z });
      }
      for (const id of prev.keys()) { const s = world.get(id); if (!s || s.sector !== sectorId) prev.delete(id); }
    }
    function onShot(from, to, weapon) {
      if (from.sector !== sectorId || shots.length > 120) return;
      shots.push({ ax: from.x, az: from.z, bx: to.x, bz: to.z, colour: weapon.colour || 0xffffff, t: SHOT_LIFE });
    }

    /* ---- The Phaser scene ---------------------------------------------------- */
    class SystemScene extends Phaser.Scene {
      constructor() { super('system'); }

      create() {
        scene = this;
        const cam = this.cameras.main;
        this.ui = this.cameras.add(0, 0, this.scale.width, this.scale.height);
        /* Stars and the belt are hundreds of dots that never move. A Phaser
           Graphics object replays every command every frame, so drawing them
           there cost the frame rate a factor of six in the test browser; they
           are painted once per system into textures instead. */
        this.backdrop = this.add.image(0, 0, '__DEFAULT').setVisible(false);
        this.beltImage = this.add.image(0, 0, '__DEFAULT').setVisible(false);
        this.ground = this.add.graphics();      // rings, lanes, gates, station: redrawn on zoom
        this.live = this.add.graphics();        // ships, beams, shots: every frame
        this.labels = [];
        this.ui.ignore([this.backdrop, this.beltImage, this.ground, this.live]);
        this.pointers = new Map();
        this.gesture = null;
        this.input.addPointer(2);
        this.input.on('pointerdown', p => this.down(p));
        this.input.on('pointermove', p => this.move(p));
        this.input.on('pointerup', p => this.up(p));
        this.input.on('pointerupoutside', p => this.up(p));
        this.input.on('wheel', (p, over, dx, dy) => this.zoomAt(p.x, p.y, Math.exp(-dy * 0.0015)));
        this.fit = 1;
        this.lastZoom = 0;
        if (sectorId) this.build();
      }

      /* Fit the system's gate ring to the shorter screen side, then let the
         player zoom from a third of that to eight times it. */
      frame() {
        const w = this.scale.width, h = this.scale.height;
        this.fit = Math.min(w, h) / (SE.Transit.rules.gate * 2 + 520);
        const cam = this.cameras.main;
        cam.setZoom(this.fit);
        cam.centerOn(0, 0);
      }

      clampCam() {
        const cam = this.cameras.main;
        cam.setZoom(Math.max(this.fit * 0.6, Math.min(this.fit * 9, cam.zoom)));
        const lim = SE.Transit.rules.gate + 400;
        const mid = cam.midPoint;
        cam.centerOn(Math.max(-lim, Math.min(lim, mid.x)), Math.max(-lim, Math.min(lim, mid.y)));
      }

      build() {
        this.frame();
        this.drawStars();
        this.lastZoom = 0;
        for (const l of this.labels) l.text.destroy();
        this.labels = [];
        const station = world.get('st_' + sectorId);
        if (station) this.label(station.name.toUpperCase(), () => ({ x: 0, y: SE.Transit.rules.stationRadius }), 22, '#dfeaf2', 11);
        const layout = world.transit.layout(sectorId);
        for (const to in layout.gates) {
          const n = layout.nodes[layout.gates[to]];
          this.label('→ ' + SE.SECTOR_BY_ID[to].name.toUpperCase(), () => ({ x: n.x, y: n.z }), 24, '#8fd3e0', 10);
        }
        this.selLabel = this.label('', () => null, -26, '#ffe3b0', 11);
      }

      label(str, at, dy, colour, size) {
        const text = this.add.text(0, 0, str, {
          fontFamily: 'ui-monospace, Menlo, monospace', fontSize: Math.round(size * dpr) + 'px', color: colour,
          stroke: '#050a11', strokeThickness: Math.round(3 * dpr)
        }).setOrigin(0.5, 0.5);
        this.cameras.main.ignore(text);
        const l = { text, at, dy };
        this.labels.push(l);
        return l;
      }

      // Paint a square canvas texture spanning ±half world units.
      paint(key, half, size, fn) {
        if (this.textures.exists(key)) this.textures.remove(key);
        const tex = this.textures.createCanvas(key, size, size);
        const ctx = tex.getContext(), k = size / (half * 2);
        ctx.save(); ctx.translate(size / 2, size / 2); ctx.scale(k, k);
        fn(ctx, k);
        ctx.restore(); tex.refresh();
        return key;
      }

      /* The starfield is the wrapper's CSS background (see starfield()), not
         part of the scene: a full-screen textured quad was the single biggest
         cost in the frame, and a static background the compositor already
         holds costs nothing. Only the sun is in the scene, so it can sit at a
         place in the system and move when you pan. */
      drawStars() {
        const rng = SE.Rng('stars:' + sectorId);
        const a = rng.float(0, Math.PI * 2), d = SE.Transit.rules.gate * 1.35, R = 520;
        if (!this.textures.exists('sys-sun')) {
          this.paint('sys-sun', R, 256, c => {
            const glow = c.createRadialGradient(0, 0, 20, 0, 0, R);
            glow.addColorStop(0, 'rgba(255,243,218,1)'); glow.addColorStop(0.12, 'rgba(255,213,154,.55)'); glow.addColorStop(1, 'rgba(255,213,154,0)');
            c.fillStyle = glow; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
          });
        }
        this.backdrop.setTexture('sys-sun').setDisplaySize(R * 2, R * 2).setPosition(Math.cos(a) * d, Math.sin(a) * d).setVisible(true);

        const sec = SE.SECTOR_BY_ID[sectorId];
        if (!sec.belt) { this.beltImage.setVisible(false); return; }
        const bhalf = SE.BELT_OUTER + 40, brng = SE.Rng(world.seed + ':' + sectorId + ':view');
        this.paint('sys-belt', bhalf, 1024, (c, k) => {
          for (let i = 0; i < 900; i++) {
            const a = brng.float(0, Math.PI * 2), r = brng.float(SE.BELT_INNER, SE.BELT_OUTER);
            const s = Math.max(brng.float(4, 16), 1.6 / k);
            c.globalAlpha = brng.float(0.55, 0.95);
            c.fillStyle = brng.chance(0.3) ? '#9a8f80' : '#7d7468';
            c.beginPath(); c.arc(Math.cos(a) * r, Math.sin(a) * r, s, 0, Math.PI * 2); c.fill();
          }
        });
        this.beltImage.setTexture('sys-belt').setDisplaySize(bhalf * 2, bhalf * 2).setPosition(0, 0).setVisible(true);
      }

      /* Everything that does not move, in world units. Line widths are set so
         they come out a fixed number of screen pixels, which is why this is
         redrawn when the zoom changes and not otherwise. */
      drawGround() {
        const g = this.ground, z = this.cameras.main.zoom, px = dpr / z;
        g.clear();
        const layout = world.transit.layout(sectorId);
        g.lineStyle(1 * px, 0x6fceeb, 0.16);
        for (const e of layout.edges) {
          const a = layout.nodes[e.a], b = layout.nodes[e.b];
          g.lineBetween(a.x, a.z, b.x, b.z);
        }
        for (const to in layout.gates) {
          const n = layout.nodes[layout.gates[to]];
          const owner = SE.SECTOR_BY_ID[to].owner;
          g.lineStyle(2.2 * px, owner ? colourOf(owner) : 0x507f99, 0.8);
          g.strokeCircle(n.x, n.z, Math.max(108, 9 * px));
        }
        const station = world.get('st_' + sectorId);
        if (station) {
          const col = colourOf(station.faction), r = SE.Transit.rules.stationRadius * 0.62;
          const hex = [];
          for (let k = 0; k < 6; k++) hex.push({ x: Math.cos(k * Math.PI / 3 + Math.PI / 6) * r, y: Math.sin(k * Math.PI / 3 + Math.PI / 6) * r });
          g.fillStyle(col, 0.18); g.fillPoints(hex, true);
          g.lineStyle(2 * px, col, 0.95); g.strokePoints(hex, true);
          g.fillStyle(col, 0.9); g.fillCircle(0, 0, r * 0.28);
          g.lineStyle(1 * px, col, 0.25); g.strokeCircle(0, 0, SE.Transit.rules.dockRange);
        }
      }

      update(time, deltaMs) {
        if (!sectorId) return;
        const cam = this.cameras.main;
        if (cam.zoom !== this.lastZoom) { this.lastZoom = cam.zoom; this.drawGround(); }
        const dt = deltaMs / 1000;
        const alpha = host.tickAlpha();
        const z = cam.zoom, px = dpr / z;
        const g = this.live;
        g.clear();

        // Weapon flashes.
        for (let i = shots.length - 1; i >= 0; i--) {
          const s = shots[i];
          s.t -= dt;
          if (s.t <= 0) { shots.splice(i, 1); continue; }
          g.lineStyle(1.6 * px, s.colour, Math.min(1, s.t / SHOT_LIFE + 0.2));
          g.lineBetween(s.ax, s.az, s.bx, s.bz);
        }

        const list = world.registry.inSector(sectorId);
        let sel = null;
        for (const s of list) {
          if (s.dead) continue;
          const cls = SE.CLASSES[s.cls];
          const p = prev.get(s.id);
          const x = p ? p.x + (p.nx - p.x) * alpha : s.x;
          const y = p ? p.z + (p.nz - p.z) * alpha : s.z;
          s._vx = x; s._vy = y;
          const col = colourOf(s.faction);
          if (selected && selected.kind === 'ship' && selected.id === s.id) sel = s;
          if (cls.tier === 'structure') continue;
          if (cls.tier === 'emplacement') {
            const r = 6 * px;
            g.fillStyle(col, 0.95); g.fillRect(x - r, y - r, r * 2, r * 2);
            g.lineStyle(1 * px, 0x050a11, 1); g.strokeRect(x - r, y - r, r * 2, r * 2);
            continue;
          }
          // Mining beam, while the ship is on its seam.
          const o = s.orders[0];
          if (o && o.type === 'MINE' && s.orderData && Math.hypot(s.orderData.x - s.x, s.orderData.z - s.z) < SE.AI.MINE_RANGE * 1.2) {
            g.lineStyle(1.4 * px, 0x7fe0ff, 0.75);
            g.lineBetween(x, y, s.orderData.x, s.orderData.z);
            g.fillStyle(0x7fe0ff, 0.5); g.fillCircle(s.orderData.x, s.orderData.z, 3 * px);
          }
          const f = SE.AI.forward(s, _f);
          let fl = Math.hypot(f.x, f.z);
          const fx = fl > 1e-4 ? f.x / fl : 0, fz = fl > 1e-4 ? f.z / fl : -1;
          const size = (HULL_PX[s.cls] || 6) * px;
          const nx = x + fx * size * 1.5, ny = y + fz * size * 1.5;
          const lx = x - fx * size + fz * size, ly = y - fz * size - fx * size;
          const rx = x - fx * size - fz * size, ry = y - fz * size + fx * size;
          g.fillStyle(col, s.owned ? 1 : 0.85);
          g.fillTriangle(nx, ny, lx, ly, rx, ry);
          if (s.owned) { g.lineStyle(1.3 * px, 0xffffff, s.isPlayer ? 0.95 : 0.55); g.strokeTriangle(nx, ny, lx, ly, rx, ry); }
          // A hull bar only once it is hurt: forty full bars is noise.
          if (s.hull < s.hullMax) {
            const w = size * 2.4, k = Math.max(0, s.hull / s.hullMax);
            g.fillStyle(0x000000, 0.6); g.fillRect(x - w / 2, y + size * 1.7, w, 2.5 * px);
            g.fillStyle(k > 0.5 ? 0x8be38b : k > 0.25 ? 0xf2c14e : 0xf06a5a, 1); g.fillRect(x - w / 2, y + size * 1.7, w * k, 2.5 * px);
          }
        }

        // Selection ring, and the line to whatever a selected ship is shooting.
        if (sel) {
          g.lineStyle(1.6 * px, 0xffe3b0, 0.95);
          g.strokeCircle(sel._vx, sel._vy, 14 * px);
          const t = sel.target && world.get(sel.target);
          if (t && !t.dead && t.sector === sectorId) { g.lineStyle(1 * px, 0xf06a5a, 0.5); g.lineBetween(sel._vx, sel._vy, t._vx ?? t.x, t._vy ?? t.z); }
          this.selLabel.at = () => ({ x: sel._vx, y: sel._vy });
          this.selLabel.text.setText(sel.name);
        } else if (selected && selected.kind === 'ship') {
          selected = null; describe();        // it died or left
        } else {
          this.selLabel.at = () => null;
        }

        // Screen-space labels, positioned from world points.
        for (const l of this.labels) {
          const at = l.at();
          if (!at) { l.text.setVisible(false); continue; }
          const sx = (at.x - cam.worldView.x) * z, sy = (at.y - cam.worldView.y) * z + l.dy * dpr;
          l.text.setPosition(sx, sy).setVisible(sx > -100 && sx < this.scale.width + 100 && sy > -40 && sy < this.scale.height + 40);
        }

        this.panelClock = (this.panelClock || 0) + dt;
        if (this.panelClock > 0.4) { this.panelClock = 0; describe(true); }
      }

      /* ---- Input: one finger pans, two pinch, a still tap selects ---------- */
      down(p) {
        this.pointers.set(p.id, { x: p.x, y: p.y });
        this.startGesture();
      }
      startGesture() {
        const pts = [...this.pointers.values()], cam = this.cameras.main;
        if (pts.length === 1) this.gesture = { kind: 'pan', sx: pts[0].x, sy: pts[0].y, cx: cam.midPoint.x, cy: cam.midPoint.y, moved: 0 };
        else if (pts.length === 2) this.gesture = { kind: 'pinch', d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, z: cam.zoom };
      }
      move(p) {
        if (!this.pointers.has(p.id) || !this.gesture) return;
        this.pointers.set(p.id, { x: p.x, y: p.y });
        const pts = [...this.pointers.values()], cam = this.cameras.main;
        if (this.gesture.kind === 'pan' && pts.length === 1) {
          const dx = pts[0].x - this.gesture.sx, dy = pts[0].y - this.gesture.sy;
          this.gesture.moved = Math.max(this.gesture.moved, Math.hypot(dx, dy));
          if (this.gesture.moved < 6 * dpr) return;
          cam.centerOn(this.gesture.cx - dx / cam.zoom, this.gesture.cy - dy / cam.zoom);
          this.clampCam();
        } else if (this.gesture.kind === 'pinch' && pts.length === 2) {
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
          this.zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, this.gesture.z * d / this.gesture.d / cam.zoom);
        }
      }
      up(p) {
        if (!this.pointers.has(p.id)) return;
        const tap = this.gesture && this.gesture.kind === 'pan' && this.gesture.moved < 6 * dpr && this.pointers.size === 1;
        this.pointers.delete(p.id);
        if (tap) this.pick(p.x, p.y);
        this.gesture = null;
        if (this.pointers.size) this.startGesture();
      }
      zoomAt(sx, sy, factor) {
        const cam = this.cameras.main;
        const before = cam.getWorldPoint(sx, sy);
        cam.setZoom(cam.zoom * factor);
        this.clampCam();
        const after = cam.getWorldPoint(sx, sy);
        cam.centerOn(cam.midPoint.x + before.x - after.x, cam.midPoint.y + before.y - after.y);
        this.clampCam();
      }
      zoomBy(f) { this.zoomAt(this.scale.width / 2, this.scale.height / 2, f); }
      recentre() { this.frame(); }

      pick(sx, sy) {
        const cam = this.cameras.main, w = cam.getWorldPoint(sx, sy);
        const reach = TAP_PX * dpr / cam.zoom;
        let best = null, bd = reach;
        for (const s of world.registry.inSector(sectorId)) {
          if (s.dead || SE.CLASSES[s.cls].tier === 'structure') continue;
          const d = Math.hypot((s._vx ?? s.x) - w.x, (s._vy ?? s.z) - w.y);
          if (d < bd) { bd = d; best = { kind: 'ship', id: s.id }; }
        }
        /* Ships crowd the station, so a tap on the station's core picks the
           station unless a ship is almost exactly under the finger. */
        const st = world.get('st_' + sectorId);
        if (st) {
          const core = Math.hypot(w.x, w.y) < SE.Transit.rules.stationRadius * 0.62;
          if ((core && bd > reach * 0.4) || (!best && Math.hypot(w.x, w.y) < SE.Transit.rules.stationRadius * 0.7 + reach)) best = { kind: 'station', id: st.id };
        }
        if (!best) {
          const layout = world.transit.layout(sectorId);
          for (const to in layout.gates) {
            const n = layout.nodes[layout.gates[to]];
            if (Math.hypot(n.x - w.x, n.z - w.y) < 130 + reach) best = { kind: 'gate', to };
          }
        }
        selected = best;
        describe();
      }
    }
    const _f = { x: 0, y: 0, z: 0 };

    /* ---- The DOM around the canvas ------------------------------------------ */
    function summary() {
      let mine = 0, foe = 0, other = 0;
      for (const s of world.registry.inSector(sectorId)) {
        if (s.dead || SE.isStatic(SE.CLASSES[s.cls])) continue;
        if (s.owned) mine++; else if (SE.hostile('player', s.faction)) foe++; else other++;
      }
      return { mine, foe, other };
    }

    function bar(label, v, max, cls) {
      const k = Math.max(0, Math.min(100, v / Math.max(1, max) * 100));
      return `<div class="sys-bar ${cls}"><span>${label}</span><i><b style="width:${k}%"></b></i><em>${Math.ceil(v)}/${Math.round(max)}</em></div>`;
    }
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function orderText(s) {
      const o = s.orders[0];
      if (!o) return 'Idle';
      switch (o.type) {
        case 'MINE': return 'Mining';
        case 'TRADE': { const st = world.get(o.station); return 'Hauling to ' + (st ? st.name : 'port'); }
        case 'ATTACK': { const t = world.get(o.target); return 'Attacking ' + (t ? t.name : 'a target'); }
        case 'GUARD': { const t = world.get(o.target); return 'Escorting ' + (t ? t.name : ''); }
        case 'JUMP': return 'Jumping to ' + ((SE.SECTOR_BY_ID[o.to] || {}).name || '?');
        case 'FLEE': return 'Fleeing';
        case 'MOVE': return 'Patrolling';
        case 'WAIT': return 'Holding';
        case 'RETURN': return 'Returning to fleet';
        default: return o.type;
      }
    }

    let lastPanel = '';
    function describe(soft) {
      if (!sectorId) return;
      const c = summary();
      census.textContent = `${c.mine} yours · ${c.foe} hostile · ${c.other} other`;
      let html;
      const d = host.director;
      if (selected && selected.kind === 'ship') {
        const s = world.get(selected.id);
        if (!s) { selected = null; return describe(soft); }
        const cls = SE.CLASSES[s.cls];
        const fac = SE.FACTIONS[s.faction] || {};
        const stance = s.owned ? 'YOUR FLEET' : SE.hostile('player', s.faction) ? 'HOSTILE' : 'NEUTRAL';
        const hold = Math.floor(SE.cargoUsed(s));
        let actions = '';
        if (s.owned && !s.isPlayer) {
          const b = (label, role, off) => `<button class="button" data-action="order" data-value="${s.id}:${role}" ${off ? 'disabled' : ''}>${label}</button>`;
          actions = `<div class="sys-actions">${b('Escort', 'escort')}${cls.miner ? b('Mine', 'mine', !SE.SECTOR_BY_ID[s.sector].belt) : b('Patrol', 'patrol')}${b('Hold', 'hold')}</div>`;
        } else if (s.isPlayer) {
          actions = `<div class="sys-actions"><button class="button" data-action="sys-map">Send fleet from the map</button></div>`;
        }
        html = `<div class="sys-kicker" style="color:#${colourOf(s.faction).toString(16).padStart(6, '0')}">${stance} · ${esc(fac.short || s.faction)} · ${esc(cls.name.toUpperCase())}</div>
          <h3>${esc(s.name)}${s.isPlayer ? ' <small>FLAGSHIP</small>' : ''}</h3>
          <p class="sys-doing">${esc(orderText(s))}${cls.cargoMax ? ` · hold ${hold}/${s.cargoMax}` : ''}</p>
          ${bar('HULL', s.hull, s.hullMax, 'hull')}${s.shieldMax ? bar('SHIELD', s.shield, s.shieldMax, 'shield') : ''}${actions}`;
      } else if (selected && selected.kind === 'station') {
        const st = world.get(selected.id);
        const friendly = st && !SE.hostile('player', st.faction);
        const here = st && st.sector === world.sectorId && !host.course;
        html = `<div class="sys-kicker">${esc((SE.FACTIONS[st.faction] || {}).name || '')} · STATION</div><h3>${esc(st.name)}</h3>
          <p class="sys-doing">${esc(d && d.economy ? d.economy.profile(st).name : '')}</p>
          ${bar('SHIELD', st.shield, st.shieldMax, 'shield')}
          <div class="sys-actions">${friendly && here ? '<button class="button primary" data-action="context">Dock</button>' : `<span class="sys-note">${friendly ? 'Bring your fleet here to dock.' : 'Hostile port. Docking refused.'}</span>`}</div>`;
      } else if (selected && selected.kind === 'gate') {
        const to = SE.SECTOR_BY_ID[selected.to];
        html = `<div class="sys-kicker">JUMP GATE</div><h3>To ${esc(to.name)}</h3><p class="sys-doing">${to.owner ? esc(SE.FACTIONS[to.owner].name) : 'Unclaimed frontier'}${to.station ? ' · ' + esc(to.station) : ''}</p>
          <div class="sys-actions"><button class="button" data-action="sys-open" data-value="${to.id}">Look through</button><button class="button primary" data-action="course" data-value="${to.id}">Send fleet</button></div>`;
      } else {
        html = `<p class="sys-hint">Tap a ship, the station or a gate. Drag to pan, pinch to zoom.</p>`;
      }
      if (html !== lastPanel) {
        // Soft refreshes must not rebuild buttons under a finger mid-tap.
        if (soft && panel.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' && html.replace(/<em>.*?<\/em>|style="width:[^"]*"/g, '') === lastPanel.replace(/<em>.*?<\/em>|style="width:[^"]*"/g, '')) {
          const fresh = document.createElement('div');
          fresh.innerHTML = html;
          panel.querySelectorAll('.sys-bar').forEach((b, i) => { const n = fresh.querySelectorAll('.sys-bar')[i]; if (n) b.innerHTML = n.innerHTML; });
        } else {
          panel.innerHTML = html;
        }
        lastPanel = html;
      }
    }

    // Painted once, in CSS pixels, as the wrapper's background.
    function starfield() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const g = c.getContext('2d'), rng = SE.Rng('starfield');
      for (let i = 0; i < 160; i++) {
        g.globalAlpha = rng.float(0.15, 0.65);
        g.fillStyle = '#bfd8ee';
        g.beginPath(); g.arc(rng.float(0, 512), rng.float(0, 512), rng.float(0.5, 1.3), 0, Math.PI * 2); g.fill();
      }
      wrap.style.background = '#050a11 url(' + c.toDataURL() + ') repeat';
      wrap.style.backgroundSize = '256px 256px';
    }

    function ensureGame() {
      starfield();
      if (game) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = wrap.getBoundingClientRect();
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: wrap,
        transparent: true,
        antialias: true,
        // Device pixels, scaled back down by zoom: the lesson of the 3D build's
        // "pixelated" report, which was a CSS-pixel framebuffer stretched 3x.
        scale: { mode: Phaser.Scale.NONE, width: Math.max(1, Math.round(r.width * dpr)), height: Math.max(1, Math.round(r.height * dpr)), zoom: 1 / dpr },
        input: { touch: true, mouse: true },
        banner: false,
        scene: SystemScene
      });
      window.addEventListener('resize', resize);
    }

    function resize() {
      if (!game || !root.classList.contains('on')) return;
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      game.scale.setZoom(1 / dpr);
      game.scale.resize(w, h);
      if (scene) {
        scene.cameras.main.setSize(w, h);
        scene.ui.setSize(w, h);
        scene.frame();
      }
    }

    function open(id) {
      if (!SE.SECTOR_BY_ID[id]) return;
      sectorId = id;
      selected = null;
      lastPanel = '';
      prev.clear();
      shots.length = 0;
      onTick();
      const sec = SE.SECTOR_BY_ID[id];
      title.textContent = sec.name;
      sub.textContent = sec.owner === 'player' ? 'YOUR CHARTER' : sec.owner ? SE.FACTIONS[sec.owner].name.toUpperCase() : 'UNCLAIMED FRONTIER';
      sub.style.color = sec.owner ? '#' + colourOf(sec.owner).toString(16).padStart(6, '0') : '';
      root.classList.add('on');
      // Nothing to see under a full-screen view, and composited anyway if shown.
      document.getElementById('galaxy').style.visibility = 'hidden';
      if (!game) ensureGame();
      else { game.loop.wake(); resize(); if (scene) scene.build(); }
      describe();
    }

    function close() {
      root.classList.remove('on');
      document.getElementById('galaxy').style.visibility = '';
      sectorId = null;
      selected = null;
      if (game) game.loop.sleep();
    }

    // Back (and Escape) leaves the view before anything else hears it.
    window.addEventListener('keydown', ev => {
      if (sectorId && ev.code === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); close(); host.director && host.director.resume(); }
    }, true);

    root.addEventListener('click', ev => {
      const b = ev.target.closest('[data-sys]');
      if (!b || !scene) return;
      const a = b.dataset.sys;
      if (a === 'in') scene.zoomBy(1.5);
      else if (a === 'out') scene.zoomBy(1 / 1.5);
      else if (a === 'fit') scene.recentre();
    });

    return {
      open, close, onTick, onShot,
      _scene: () => scene,           // for the test harness
      get open_() { return !!sectorId; },
      get sector() { return sectorId; },
      refresh() { if (sectorId) describe(); }
    };
  }

  SE.SystemView = SystemView;
})(window.SE = window.SE || {});
