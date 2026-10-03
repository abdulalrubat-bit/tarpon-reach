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
  const HULL_PX = { interceptor: 7, corvette: 9, extractor: 10, freighter: 11.5, dreadnought: 18 };
  const TAP_PX = 26;

  const colourOf = faction => (SE.FACTIONS[faction] || {}).colour || NEUTRAL;
  const shadeInt = (c, k) => SE.ShipArt.shadeInt(c, k);
  const cssInt = n => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
  const rgbaInt = (n, a) => `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  // Blend two colours: k = 0 gives a, k = 1 gives b.
  const mix = (a, b, k) => [16, 8, 0].reduce((n, sh) => n | (Math.round((a >> sh & 255) * (1 - k) + (b >> sh & 255) * k) << sh), 0);

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
    const group = new Set();        // your ships selected for command (battle controls)
    let result = null;              // the last battle's result, shown until dismissed
    const marks = [];               // brief markers where a command was given
    const battleBar = document.getElementById('sys-battle');
    const siegeBar = document.getElementById('sys-siege');
    let framedBattle = null;
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
    /* A shot is drawn as a bolt flying from gun to target, with a muzzle
       flash at one end and, when it lands, a shield ripple (shields up) or
       sparks (shields down) at the other. The damage itself has already been
       done by the simulation; this is the picture of it. */
    function onShot(from, to, weapon) {
      if (from.sector !== sectorId || shots.length > 120) return;
      if (host.director) host.director.audio.shot(weapon);
      const ax = from._vx ?? from.x, az = from._vy ?? from.z, bx = to._vx ?? to.x, bz = to._vy ?? to.z;
      const dist = Math.hypot(bx - ax, bz - az);
      shots.push({ ax, az, bx, bz, to: to.id, colour: weapon.colour || 0xffffff, heavy: weapon.damage >= 18, age: 0, dur: Math.max(0.08, Math.min(0.32, dist / 1700)), shield: to.shield > 1 });
    }

    // Explosions, impacts and debris: short-lived, drawn on top.
    const effects = [];
    function explode(s) {
      if (effects.length > 60) return;
      const cls = SE.CLASSES[s.cls];
      const big = cls.tier === 'heavy' ? 2.4 : cls.tier === 'emplacement' ? 1.8 : cls.tier === 'medium' ? 1.3 : 1;
      const debris = [];
      for (let i = 0, n = Math.round(8 * big); i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = (30 + Math.random() * 60) * big;
        debris.push({ a, v, r: 1 + Math.random() * 1.6 });
      }
      effects.push({ kind: 'boom', x: s._vx ?? s.x, y: s._vy ?? s.z, age: 0, dur: 1.1 + 0.3 * big, big, debris, colour: colourOf(s.faction) });
    }
    world.events.subscribe(event => {
      if (event.type === 'kill' && sectorId && event.victim.sector === sectorId) explode(event.victim);
    });

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
        this.nebula = this.add.image(0, 0, '__DEFAULT').setVisible(false);
        this.backdrop = this.add.image(0, 0, '__DEFAULT').setVisible(false);
        this.planet = this.add.image(0, 0, '__DEFAULT').setVisible(false);
        this.beltImage = this.add.image(0, 0, '__DEFAULT').setVisible(false);
        // The station and the gates are sprites, so they can turn and glow.
        this.stationRing = this.add.image(0, 0, '__DEFAULT').setVisible(false).setDepth(0.5);
        this.stationHub = this.add.image(0, 0, '__DEFAULT').setVisible(false).setDepth(0.6);
        this.stationGlow = this.add.image(0, 0, '__DEFAULT').setVisible(false).setDepth(0.4);
        this.gates = [];
        this.ground = this.add.graphics();      // rings, lanes, gates, station: redrawn on zoom
        this.under = this.add.graphics().setDepth(1);   // target lines, beams, engine trails
        this.live = this.add.graphics().setDepth(3);    // shots, bars, effects, rings: every frame
        this.sprites = new Map();               // ship id -> { hull, glow } images
        this.labels = [];
        this.ui.ignore([this.nebula, this.backdrop, this.planet, this.beltImage, this.stationRing, this.stationHub, this.stationGlow, this.ground, this.under, this.live]);
        this.bake();
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
        this.clearSprites();
        effects.length = 0;
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
        if (host.battles && host.battles.in(sectorId)) { this.focusBattle(); framedBattle = host.battles.in(sectorId).id; }
      }

      /* Hull art (src/shipart.js) as textures, once per class and faction.
         Sprites are far cheaper per frame than redrawing shapes. */
      bake() {
        for (const cls in SE.ShipArt.SHAPES) for (const f of Object.keys(SE.FACTIONS)) {
          const key = 'hull-' + cls + '-' + f;
          if (!this.textures.exists(key)) this.textures.addCanvas(key, SE.ShipArt.canvas(cls, f));
        }
        if (!this.textures.exists('fx-glow')) {
          const tex = this.textures.createCanvas('fx-glow', 64, 64), c = tex.getContext();
          const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
          g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = g; c.fillRect(0, 0, 64, 64); tex.refresh();
        }
      }

      sprite(s) {
        let sp = this.sprites.get(s.id);
        if (sp && sp.faction !== s.faction) { sp.hull.destroy(); sp.glow.destroy(); sp = null; }
        if (!sp) {
          const glow = this.add.image(0, 0, 'fx-glow').setDepth(1.5);
          const hull = this.add.image(0, 0, 'hull-' + s.cls + '-' + (SE.FACTIONS[s.faction] ? s.faction : 'apex')).setDepth(2);
          this.ui.ignore([glow, hull]);
          sp = { hull, glow, faction: s.faction, seen: 0 };
          this.sprites.set(s.id, sp);
        }
        return sp;
      }

      // Shield over hull, small, above the ship. Shield only shows if it has one.
      bars(g, s, x, y, half, px) {
        const w = Math.max(20 * px, half * 1.4), top = y - half - 9 * px, h = 2.6 * px;
        const k = Math.max(0, s.hull / s.hullMax);
        g.fillStyle(0x050a11, 0.75); g.fillRect(x - w / 2 - px, top - px, w + 2 * px, (s.shieldMax ? h * 2 + px : h) + 2 * px);
        let row = top;
        if (s.shieldMax) {
          g.fillStyle(0x6fd0ff, 1); g.fillRect(x - w / 2, row, w * Math.max(0, s.shield / s.shieldMax), h);
          row += h + px;
        }
        g.fillStyle(k > 0.5 ? 0x8be38b : k > 0.25 ? 0xf2c14e : 0xf06a5a, 1); g.fillRect(x - w / 2, row, w * k, h);
      }

      clearSprites() { for (const sp of this.sprites.values()) { sp.hull.destroy(); sp.glow.destroy(); } this.sprites.clear(); }

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

      /* Scenery, painted once per system into textures, in the star chart's
         style: a nebula wash in two colours leaning towards the owner's, the
         sun, a planet, a belt of actual rocks, and sprite art for the station
         and gates. The starfield stays the wrapper's CSS background: a static
         layer the compositor already holds costs nothing. */
      drawStars() {
        const rng = SE.Rng('stars:' + sectorId), sec = SE.SECTOR_BY_ID[sectorId];
        const G = SE.Transit.rules.gate;
        const a = rng.float(0, Math.PI * 2), d = G * 1.35, R = 520;
        if (!this.textures.exists('sys-sun')) {
          this.paint('sys-sun', R, 256, c => {
            const glow = c.createRadialGradient(0, 0, 20, 0, 0, R);
            glow.addColorStop(0, 'rgba(255,243,218,1)'); glow.addColorStop(0.12, 'rgba(255,213,154,.55)'); glow.addColorStop(1, 'rgba(255,213,154,0)');
            c.fillStyle = glow; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
          });
        }
        const sunX = Math.cos(a) * d, sunY = Math.sin(a) * d;
        this.backdrop.setTexture('sys-sun').setDisplaySize(R * 2, R * 2).setPosition(sunX, sunY).setVisible(!!this.lowFx);

        // Nebula: soft clouds in two hues, the first nudged towards the owner's colour.
        const owner = sec.owner ? colourOf(sec.owner) : 0x6a7f99;
        const hues = [mix(owner, rng.pick([0x3a6ea8, 0x7a3fa0, 0x2f8f8a, 0xa0503a]), 0.55), rng.pick([0x3a2a6a, 0x1e4a6a, 0x5a2a4a, 0x2a5a4a])];
        const N = G + 1100;
        this.paint('sys-nebula', N, 1024, c => {
          for (let i = 0; i < 26; i++) {
            const col = hues[i % 2], cx = rng.float(-N, N) * 0.8, cy = rng.float(-N, N) * 0.8, rr = rng.float(N * 0.25, N * 0.6);
            const g = c.createRadialGradient(cx, cy, 0, cx, cy, rr);
            g.addColorStop(0, rgbaInt(col, rng.float(0.10, 0.22))); g.addColorStop(1, rgbaInt(col, 0));
            c.fillStyle = g; c.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
          }
          // Dark dust lanes across the wash.
          c.globalCompositeOperation = 'destination-out';
          for (let i = 0; i < 6; i++) {
            const cx = rng.float(-N, N) * 0.7, cy = rng.float(-N, N) * 0.7, rr = rng.float(N * 0.12, N * 0.3);
            const g = c.createRadialGradient(cx, cy, 0, cx, cy, rr);
            g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
            c.fillStyle = g; c.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
          }
          // The sun, painted into the same image: one full-screen layer fewer.
          c.globalCompositeOperation = 'source-over';
          const sun = c.createRadialGradient(sunX, sunY, 20, sunX, sunY, R);
          sun.addColorStop(0, 'rgba(255,243,218,1)'); sun.addColorStop(0.12, 'rgba(255,213,154,.55)'); sun.addColorStop(1, 'rgba(255,213,154,0)');
          c.fillStyle = sun; c.beginPath(); c.arc(sunX, sunY, R, 0, Math.PI * 2); c.fill();
        });
        this.nebula.setTexture('sys-nebula').setDisplaySize(N * 2, N * 2).setPosition(0, 0).setVisible(!this.lowFx);

        // A planet, placed away from the gates and the sun.
        const layout = world.transit.layout(sectorId);
        // Keep clear of gates, the sun, and anything parked far out (a blockade).
        const outliers = world.registry.inSector(sectorId).filter(x => SE.isStatic(SE.CLASSES[x.cls]) && Math.hypot(x.x, x.z) > 900).map(x => Math.atan2(x.z, x.x));
        const gateAngles = Object.values(layout.gates).map(k => Math.atan2(layout.nodes[k].z, layout.nodes[k].x)).concat([a], outliers);
        let best = 0, bestGap = -1;
        for (let k = 0; k < 24; k++) {
          const t = k / 24 * Math.PI * 2;
          const gap = Math.min(...gateAngles.map(g => Math.abs(Math.atan2(Math.sin(t - g), Math.cos(t - g)))));
          if (gap > bestGap) { bestGap = gap; best = t; }
        }
        const PR = rng.float(300, 430), pd = G * 1.02;
        const pcol = rng.pick([0xc98a5a, 0x5a8ac9, 0x8ac98a, 0xb58ad0, 0xd0c08a, 0x7ab8c0]);
        this.paint('sys-planet', PR * 1.5, 512, c => {
          // Atmosphere glow.
          const atm = c.createRadialGradient(0, 0, PR * 0.95, 0, 0, PR * 1.45);
          atm.addColorStop(0, rgbaInt(shadeInt(pcol, 0.4), 0.45)); atm.addColorStop(1, rgbaInt(pcol, 0));
          c.fillStyle = atm; c.beginPath(); c.arc(0, 0, PR * 1.45, 0, Math.PI * 2); c.fill();
          // Body with bands.
          c.save(); c.beginPath(); c.arc(0, 0, PR, 0, Math.PI * 2); c.clip();
          c.fillStyle = cssInt(pcol); c.fillRect(-PR, -PR, PR * 2, PR * 2);
          for (let i = 0; i < 9; i++) {
            const y = rng.float(-PR, PR), h = rng.float(PR * 0.05, PR * 0.22);
            c.fillStyle = rgbaInt(shadeInt(pcol, rng.float(-0.35, 0.3)), rng.float(0.3, 0.6));
            c.fillRect(-PR, y, PR * 2, h);
          }
          // Night side, turned away from the sun.
          const sx = Math.cos(a - best), sy = Math.sin(a - best);
          const night = c.createLinearGradient(sx * PR, sy * PR, -sx * PR, -sy * PR);
          night.addColorStop(0, 'rgba(0,0,0,0)'); night.addColorStop(0.55, 'rgba(2,5,10,.55)'); night.addColorStop(1, 'rgba(2,5,10,.92)');
          c.fillStyle = night; c.fillRect(-PR, -PR, PR * 2, PR * 2);
          c.restore();
        });
        this.planet.setTexture('sys-planet').setDisplaySize(PR * 3, PR * 3).setPosition(Math.cos(best) * pd, Math.sin(best) * pd).setVisible(true);

        // Station art, per faction, and the gates.
        const st = world.get('st_' + sectorId);
        if (st) {
          const f = SE.FACTIONS[st.faction] ? st.faction : 'apex';
          this.bakeStation(f);
          this.stationHub.setTexture('sv-st-hub-' + f).setVisible(true);
          this.stationRing.setTexture('sv-st-ring-' + f).setVisible(true);
          this.stationGlow.setTexture('fx-glow').setTint(colourOf(f)).setVisible(true);
          this.stationFaction = f;
        } else { this.stationHub.setVisible(false); this.stationRing.setVisible(false); this.stationGlow.setVisible(false); }
        this.bakeGate();
        for (const gt of this.gates) { gt.ring.destroy(); gt.core.destroy(); }
        this.gates = [];
        for (const to in layout.gates) {
          const n = layout.nodes[layout.gates[to]], o = SE.SECTOR_BY_ID[to].owner, col = o ? colourOf(o) : 0x7fa8c0;
          const core = this.add.image(n.x, n.z, 'fx-glow').setTint(col).setDepth(0.3);
          const ring = this.add.image(n.x, n.z, 'sv-gate').setTint(mix(col, 0xffffff, 0.35)).setDepth(0.35).setRotation(Math.atan2(n.z, n.x));
          this.ui.ignore([core, ring]);
          this.gates.push({ ring, core, col });
        }

        if (!sec.belt) { this.beltImage.setVisible(false); return; }
        const bhalf = SE.BELT_OUTER + 40, brng = SE.Rng(world.seed + ':' + sectorId + ':view');
        this.paint('sys-belt', bhalf, 1024, (c, k) => {
          // Rocks: lumpy polygons, lit from the sun's side, with a darker rim.
          const lx = Math.cos(a), ly = Math.sin(a);
          for (let i = 0; i < 700; i++) {
            const ang = brng.float(0, Math.PI * 2), r = brng.float(SE.BELT_INNER, SE.BELT_OUTER);
            const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
            const size = Math.max(brng.float(5, 20), 2 / k), sides = 6 + Math.floor(brng.float(0, 4)), rot = brng.float(0, Math.PI * 2);
            c.beginPath();
            for (let v = 0; v < sides; v++) { const t = rot + v / sides * Math.PI * 2, rr = size * brng.float(0.65, 1.15); v ? c.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr) : c.moveTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
            c.closePath();
            const base = brng.chance(0.3) ? [154, 143, 128] : brng.chance(0.5) ? [125, 116, 104] : [108, 112, 120];
            const g = c.createLinearGradient(x + lx * size, y + ly * size, x - lx * size, y - ly * size);
            g.addColorStop(0, `rgb(${base.map(v => Math.min(255, v + 50)).join(',')})`); g.addColorStop(1, `rgb(${base.map(v => v * 0.45 | 0).join(',')})`);
            c.globalAlpha = brng.float(0.7, 1); c.fillStyle = g; c.fill();
            c.lineWidth = Math.max(1, 0.8 / k); c.strokeStyle = 'rgba(10,12,16,.6)'; c.stroke();
          }
          // A faint dust band under the rocks.
          c.globalAlpha = 1; c.globalCompositeOperation = 'destination-over';
          const dust = c.createRadialGradient(0, 0, SE.BELT_INNER * 0.9, 0, 0, SE.BELT_OUTER * 1.05);
          dust.addColorStop(0, 'rgba(160,150,130,0)'); dust.addColorStop(0.5, 'rgba(160,150,130,.10)'); dust.addColorStop(1, 'rgba(160,150,130,0)');
          c.fillStyle = dust; c.beginPath(); c.arc(0, 0, SE.BELT_OUTER * 1.05, 0, Math.PI * 2); c.fill();
        });
        this.beltImage.setTexture('sys-belt').setDisplaySize(bhalf * 2, bhalf * 2).setPosition(0, 0).setVisible(true);
      }

      /* A station: a hub with docking arms and lit windows in the owner's
         colour, inside a segmented habitat ring that turns slowly. Apex
         builds four arms, Vanguard six, the Scrappers three; yours have five. */
      bakeStation(f) {
        const hubKey = 'sv-st-hub-' + f, ringKey = 'sv-st-ring-' + f;
        if (this.textures.exists(hubKey)) return;
        const col = colourOf(f), S = 512, u = S / 2;
        const arms = { apex: 4, vanguard: 6, scrapper: 3, player: 5 }[f] || 4;
        let tex = this.textures.createCanvas(hubKey, S, S), c = tex.getContext();
        c.translate(u, u);
        for (let i = 0; i < arms; i++) {
          c.save(); c.rotate(i / arms * Math.PI * 2);
          c.fillStyle = cssInt(shadeInt(col, -0.55)); c.fillRect(-0.06 * u, -0.86 * u, 0.12 * u, 0.6 * u);
          c.fillStyle = cssInt(shadeInt(col, -0.2)); c.fillRect(-0.1 * u, -0.9 * u, 0.2 * u, 0.1 * u);
          c.fillStyle = 'rgba(255,240,200,.9)'; c.fillRect(-0.02 * u, -0.84 * u, 0.04 * u, 0.04 * u);
          c.restore();
        }
        const g = c.createRadialGradient(-0.1 * u, -0.1 * u, 0, 0, 0, 0.42 * u);
        g.addColorStop(0, cssInt(shadeInt(col, 0.35))); g.addColorStop(1, cssInt(shadeInt(col, -0.5)));
        c.beginPath(); for (let k = 0; k < 8; k++) { const t = k / 8 * Math.PI * 2 + Math.PI / 8; c.lineTo(Math.cos(t) * 0.4 * u, Math.sin(t) * 0.4 * u); } c.closePath();
        c.fillStyle = g; c.fill(); c.lineWidth = 4; c.strokeStyle = 'rgba(5,10,17,.9)'; c.stroke();
        for (let k = 0; k < 16; k++) { const t = k / 16 * Math.PI * 2; c.fillStyle = k % 3 ? 'rgba(255,236,190,.85)' : 'rgba(150,220,255,.85)'; c.fillRect(Math.cos(t) * 0.3 * u - 3, Math.sin(t) * 0.3 * u - 3, 6, 6); }
        const core = c.createRadialGradient(0, 0, 0, 0, 0, 0.16 * u);
        core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(0.4, cssInt(shadeInt(col, 0.5))); core.addColorStop(1, rgbaInt(col, 0));
        c.fillStyle = core; c.beginPath(); c.arc(0, 0, 0.16 * u, 0, Math.PI * 2); c.fill();
        tex.refresh();
        tex = this.textures.createCanvas(ringKey, S, S); c = tex.getContext(); c.translate(u, u);
        for (let k = 0; k < 12; k++) {
          const t0 = k / 12 * Math.PI * 2 + 0.04, t1 = (k + 1) / 12 * Math.PI * 2 - 0.04;
          c.beginPath(); c.arc(0, 0, 0.96 * u, t0, t1); c.arc(0, 0, 0.84 * u, t1, t0, true); c.closePath();
          c.fillStyle = cssInt(shadeInt(col, k % 2 ? -0.35 : -0.5)); c.fill();
          c.strokeStyle = 'rgba(5,10,17,.8)'; c.lineWidth = 2; c.stroke();
          const tm = (t0 + t1) / 2; c.fillStyle = 'rgba(255,240,200,.8)'; c.fillRect(Math.cos(tm) * 0.9 * u - 3, Math.sin(tm) * 0.9 * u - 3, 6, 6);
        }
        tex.refresh();
      }

      // A jump gate: a broken ring of pylons, painted white and tinted per destination.
      bakeGate() {
        if (this.textures.exists('sv-gate')) return;
        const S = 256, u = S / 2, tex = this.textures.createCanvas('sv-gate', S, S), c = tex.getContext();
        c.translate(u, u);
        for (let k = 0; k < 8; k++) {
          const t0 = k / 8 * Math.PI * 2 + 0.12, t1 = (k + 1) / 8 * Math.PI * 2 - 0.12;
          c.beginPath(); c.arc(0, 0, 0.92 * u, t0, t1); c.arc(0, 0, 0.74 * u, t1, t0, true); c.closePath();
          c.fillStyle = 'rgba(225,235,245,.92)'; c.fill(); c.strokeStyle = 'rgba(5,10,17,.85)'; c.lineWidth = 3; c.stroke();
          const tm = t0 - 0.06; c.fillStyle = '#ffffff'; c.beginPath(); c.arc(Math.cos(tm) * 0.83 * u, Math.sin(tm) * 0.83 * u, 5, 0, Math.PI * 2); c.fill();
        }
        tex.refresh();
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
        const station = world.get('st_' + sectorId);
        if (station) { g.lineStyle(1 * px, colourOf(station.faction), 0.18); g.strokeCircle(0, 0, SE.Transit.rules.dockRange); }
        /* Your facilities in this system, on a ring round the middle: a drill
           rig, a foundry or a solar array, each in your colour. */
        const works = host.director ? host.director.state.outposts.filter(p => p.sector === sectorId) : [];
        works.forEach((p, i) => {
          const u = Math.max(34, 11 * px), rr = station ? 600 : 420, step = Math.min(0.9, u * 3 / rr);
          const ang = -Math.PI / 2 + (i - (works.length - 1) / 2) * step;
          const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
          const col = colourOf('player'), on = p.online !== false;
          g.lineStyle(1.4 * px, col, on ? 0.95 : 0.4);
          g.fillStyle(0x0b1520, 0.95); g.fillRect(x - u, y - u * 0.7, u * 2, u * 1.4); g.strokeRect(x - u, y - u * 0.7, u * 2, u * 1.4);
          if (p.kind === 'solar') {
            g.fillStyle(0x3d7fd0, on ? 1 : 0.4);
            for (const sx of [-1, 1]) g.fillRect(x + sx * u * 1.1 - (sx < 0 ? u * 1.2 : 0), y - u * 0.45, u * 1.2, u * 0.9);
          } else if (p.kind === 'refinery') {
            g.fillStyle(0xff9a3c, on ? 0.9 : 0.35); g.fillCircle(x, y, u * 0.45);
            g.fillStyle(0xdfe8ef, 1); g.fillRect(x + u * 0.4, y - u * 1.2, u * 0.25, u * 0.6);
          } else {
            g.fillStyle(0xb79a6a, on ? 1 : 0.4); g.fillTriangle(x - u * 0.5, y + u * 0.5, x + u * 0.5, y + u * 0.5, x, y - u * 0.6);
          }
          for (let k = 1; k < (p.level || 1) + 1; k++) { g.fillStyle(0xefbc7f, 1); g.fillCircle(x - u + k * u * 0.45, y + u * 0.95, u * 0.12); }
        });
        // Station and gate sprites keep a minimum on-screen size when zoomed out.
        const sd = Math.max(SE.Transit.rules.stationRadius * 1.5, 92 * px);
        this.stationHub.setDisplaySize(sd * 0.82, sd * 0.82); this.stationRing.setDisplaySize(sd, sd); this.stationGlow.setDisplaySize(sd * 1.6, sd * 1.6);
        const gd = Math.max(250, 30 * px);
        for (const gt of this.gates) { gt.ring.setDisplaySize(gd, gd); gt.core.setDisplaySize(gd * 1.1, gd * 1.1); }
      }

      update(time, deltaMs) {
        if (!sectorId) return;
        const cam = this.cameras.main;
        if (cam.zoom !== this.lastZoom) { this.lastZoom = cam.zoom; this.drawGround(); }
        const dt = deltaMs / 1000;
        const alpha = host.tickAlpha();
        /* A safety net for slow phones: if the view averages under 28 fps for
           three seconds, drop the nebula (the costliest layer) and show the
           sun on its own instead, for the rest of the session. */
        if (!this.lowFx) {
          this.fpsT = (this.fpsT || 0) + dt; this.fpsN = (this.fpsN || 0) + 1;
          if (this.fpsT >= 3) {
            if (this.fpsN / this.fpsT < 28 && this.fpsSkip) { this.lowFx = true; this.nebula.setVisible(false); this.backdrop.setVisible(true); }
            this.fpsSkip = true; this.fpsT = 0; this.fpsN = 0;   // the first window is warm-up
          }
        }
        // Scenery motion: the habitat ring turns, gate cores breathe.
        this.stationRing.rotation += dt * 0.08;
        this.stationGlow.setAlpha(0.35 + 0.1 * Math.sin(time * 0.0015));
        for (let k = 0; k < this.gates.length; k++) { const gt = this.gates[k]; gt.core.setAlpha(0.45 + 0.25 * Math.sin(time * 0.002 + k)); gt.ring.rotation += dt * 0.05; }
        const stNow = world.get('st_' + sectorId);
        if (stNow && this.stationFaction && stNow.faction !== this.stationFaction) this.drawStars();
        const z = cam.zoom, px = dpr / z;
        // Ships keep a readable size zoomed out and grow as you zoom in on a fight.
        const grow = Math.min(1.8, Math.max(1, Math.sqrt(z / (this.fit * 2.5))));
        const g = this.live;
        g.clear();

        const u = this.under;
        u.clear();
        const list = world.registry.inSector(sectorId);
        const battle = host.battles && host.battles.in(sectorId);
        const fighting = battle ? host.battles.contacts(sectorId) : null;
        const inFight = new Set(fighting ? fighting.ours.concat(fighting.foes).map(x => x.id) : []);
        const now = world.elapsed;
        let sel = null;
        const tick = this.frameNo = (this.frameNo || 0) + 1;
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
          const aim = s.aim && world.get(s.aim);
          const aiming = aim && !aim.dead && aim.sector === sectorId;
          if (cls.tier === 'emplacement') {
            // A platform: an octagonal base and a barrel that tracks its target.
            const r = 9 * px * grow, pts = [];
            for (let k = 0; k < 8; k++) pts.push({ x: x + Math.cos(k * Math.PI / 4 + Math.PI / 8) * r, y: y + Math.sin(k * Math.PI / 4 + Math.PI / 8) * r });
            g.fillStyle(shadeInt(col, -0.35), 1); g.fillPoints(pts, true);
            g.lineStyle(1.4 * px, col, 1); g.strokePoints(pts, true);
            const ang = aiming ? Math.atan2((aim._vy ?? aim.z) - y, (aim._vx ?? aim.x) - x) : (s._barrel ?? 0);
            s._barrel = ang;
            g.lineStyle(2.6 * px, 0xdfe8ef, 1); g.lineBetween(x, y, x + Math.cos(ang) * r * 1.5, y + Math.sin(ang) * r * 1.5);
            g.fillStyle(col, 1); g.fillCircle(x, y, r * 0.42);
            if (inFight.has(s.id) || now - (s.damageAt ?? -100) < 6) this.bars(g, s, x, y, r * 1.6, px);
            if (battle && aiming) { u.lineStyle(1 * px, 0xf06a5a, 0.16); u.lineBetween(x, y, aim._vx ?? aim.x, aim._vy ?? aim.z); }
            continue;
          }
          // Mining beam, while the ship is on its seam.
          const o = s.orders[0];
          if (o && o.type === 'MINE' && s.orderData && Math.hypot(s.orderData.x - s.x, s.orderData.z - s.z) < SE.AI.MINE_RANGE * 1.2) {
            u.lineStyle(1.4 * px, 0x7fe0ff, 0.75);
            u.lineBetween(x, y, s.orderData.x, s.orderData.z);
            u.fillStyle(0x7fe0ff, 0.5); u.fillCircle(s.orderData.x, s.orderData.z, 3 * px);
          }
          const f = SE.AI.forward(s, _f);
          const fl = Math.hypot(f.x, f.z);
          const fx = fl > 1e-4 ? f.x / fl : 0, fz = fl > 1e-4 ? f.z / fl : -1;
          const size = (HULL_PX[s.cls] || 8) * px * grow;
          const sp = this.sprite(s);
          sp.seen = tick;
          sp.hull.setPosition(x, y).setRotation(Math.atan2(fz, fx) + Math.PI / 2).setDisplaySize(size * 4, size * 4).setVisible(true);
          // Engine glow: brighter when moving, a gentle flicker.
          const speed = Math.hypot(s.vx, s.vz), top = cls.topSpeed || 1;
          const thrust = Math.min(1, speed / top);
          const gr = size * (1.1 + thrust * 0.9) * (0.92 + 0.08 * Math.sin(time * 0.03 + s.id.length));
          sp.glow.setPosition(x - fx * size * 1.7, y - fz * size * 1.7).setDisplaySize(gr * 2, gr * 2)
            .setTint(s.faction === 'scrapper' ? 0xffa04a : s.faction === 'vanguard' ? 0xc8ff9a : 0x8fd8ff).setAlpha(0.35 + thrust * 0.55).setVisible(true);
          // Who is shooting whom, faintly, in a fight.
          if (battle && aiming && inFight.has(s.id)) {
            u.lineStyle(1 * px, s.owned ? 0x9fdcff : 0xf06a5a, s.owned ? 0.28 : 0.2);
            u.lineBetween(x, y, aim._vx ?? aim.x, aim._vy ?? aim.z);
          }
          // Hull and shield bars: in a fight, when hurt recently, or selected.
          if (inFight.has(s.id) || group.has(s.id) || now - (s.damageAt ?? -100) < 6 || s.hull < s.hullMax * 0.999) this.bars(g, s, x, y, size * 1.9, px);
        }
        for (const [id, sp] of this.sprites) if (sp.seen !== tick) { sp.hull.destroy(); sp.glow.destroy(); this.sprites.delete(id); }

        // Bolts in flight, muzzle flashes, and what happens where they land.
        for (let i = shots.length - 1; i >= 0; i--) {
          const s = shots[i];
          s.age += dt;
          const t = s.age / s.dur;
          const tgt = world.get(s.to);
          if (tgt && !tgt.dead) { s.bx = tgt._vx ?? s.bx; s.bz = tgt._vy ?? s.bz; }
          if (t >= 1) {
            shots.splice(i, 1);
            if (effects.length < 80) effects.push({ kind: s.shield ? 'shield' : 'spark', x: s.bx, y: s.bz, from: Math.atan2(s.az - s.bz, s.ax - s.bx), age: 0, dur: s.shield ? 0.32 : 0.24, colour: s.colour, r: tgt ? (HULL_PX[tgt.cls] || 8) : 8 });
            continue;
          }
          const hx = s.ax + (s.bx - s.ax) * t, hz = s.az + (s.bz - s.az) * t;
          const len = Math.min(1, 0.25 + t), dx = (s.bx - s.ax), dz = (s.bz - s.az), d = Math.hypot(dx, dz) || 1;
          const tail = Math.min(d * 0.35, (s.heavy ? 26 : 18) * px) * len;
          const tx = hx - dx / d * tail, tz = hz - dz / d * tail;
          g.lineStyle((s.heavy ? 5 : 3.4) * px, s.colour, 0.22); g.lineBetween(tx, tz, hx, hz);
          g.lineStyle((s.heavy ? 2.2 : 1.5) * px, 0xffffff, 0.95); g.lineBetween(tx + (hx - tx) * 0.4, tz + (hz - tz) * 0.4, hx, hz);
          if (s.age < 0.06) { g.fillStyle(s.colour, 0.9 - s.age * 10); g.fillCircle(s.ax, s.az, (s.heavy ? 5 : 3.5) * px); }
        }
        for (let i = effects.length - 1; i >= 0; i--) {
          const e = effects[i];
          e.age += dt;
          const t = e.age / e.dur;
          if (t >= 1) { effects.splice(i, 1); continue; }
          if (e.kind === 'shield') {
            // A ripple on the side the shot came from.
            const r = e.r * 2.3 * px * (1 + t * 0.2);
            g.lineStyle(1.5 * px, 0x8fe3ff, 0.6 * (1 - t));
            g.beginPath(); g.arc(e.x, e.y, r, e.from - 0.7, e.from + 0.7); g.strokePath();
          } else if (e.kind === 'spark') {
            g.fillStyle(0xffd27a, 1 - t); g.fillCircle(e.x, e.y, 3 * px * (1 - t * 0.5));
            for (let k = 0; k < 4; k++) { const a = e.from + Math.PI + (k - 1.5) * 0.5; g.fillCircle(e.x + Math.cos(a) * 10 * px * t, e.y + Math.sin(a) * 10 * px * t, 1.2 * px); }
          } else if (e.kind === 'boom') {
            const B = e.big * px * 1.5;
            if (t < 0.18) { g.fillStyle(0xffffff, 1 - t / 0.18); g.fillCircle(e.x, e.y, 14 * B * (0.4 + t * 3)); }
            g.fillStyle(0xff9a3c, 0.7 * (1 - t)); g.fillCircle(e.x, e.y, 10 * B * (0.6 + t * 0.8));
            g.fillStyle(0xffe08a, 0.8 * (1 - t) * (1 - t)); g.fillCircle(e.x, e.y, 6 * B * (0.6 + t * 0.4));
            g.lineStyle(1.6 * px, 0xffd8a8, 0.6 * (1 - t)); g.strokeCircle(e.x, e.y, 34 * B * t);
            const k = 1 - Math.pow(1 - t, 2);
            for (const d of e.debris) { g.fillStyle(t < 0.5 ? 0xffc070 : e.colour, 1 - t); g.fillCircle(e.x + Math.cos(d.a) * d.v * B * k * 0.6, e.y + Math.sin(d.a) * d.v * B * k * 0.6, d.r * px); }
          }
        }

        // Your selected group: a ring each, and where each one is headed.
        for (const id of group) {
          const s = world.get(id);
          if (!s || s.dead || s.sector !== sectorId) { group.delete(id); continue; }
          const x = s._vx ?? s.x, y = s._vy ?? s.z;
          g.lineStyle(2 * px, 0xefbc7f, 0.95); g.strokeCircle(x, y, Math.max(15 * px, (HULL_PX[s.cls] || 8) * px * grow * 2.1));
          const o = s.orders[0];
          if (o && o.type === 'ATTACK') {
            const t = world.get(o.target);
            if (t && !t.dead && t.sector === sectorId) {
              const tx = t._vx ?? t.x, ty = t._vy ?? t.z;
              g.lineStyle(1.2 * px, 0xf06a5a, 0.55); g.lineBetween(x, y, tx, ty);
              // Crosshair on the focus target.
              g.lineStyle(1.6 * px, 0xf06a5a, 0.95); g.strokeCircle(tx, ty, 13 * px);
              for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; g.lineBetween(tx + Math.cos(a) * 9 * px, ty + Math.sin(a) * 9 * px, tx + Math.cos(a) * 17 * px, ty + Math.sin(a) * 17 * px); }
            }
          } else if (o && o.type === 'MOVE') {
            g.lineStyle(1 * px, 0x6fceeb, 0.6); g.lineBetween(x, y, o.x, o.z);
            g.strokeCircle(o.x, o.z, 5 * px);
          }
        }
        // Where a command was just given.
        for (let i = marks.length - 1; i >= 0; i--) {
          const m = marks[i];
          m.t -= dt;
          if (m.t <= 0) { marks.splice(i, 1); continue; }
          const r = (1 - m.t / 0.6) * 22 * px + 6 * px;
          g.lineStyle(2 * px, m.colour, Math.min(1, m.t / 0.6 + 0.1)); g.strokeCircle(m.x, m.y, r);
        }

        // Selection ring, and the line to whatever a selected ship is shooting.
        if (sel) {
          g.lineStyle(1.6 * px, 0xffe3b0, 0.95);
          g.strokeCircle(sel._vx, sel._vy, Math.max(16 * px, (HULL_PX[sel.cls] || 8) * px * grow * 2.2));
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
      /* Fights happen in a few hundred metres of a four-kilometre system: at
         the whole-system zoom both fleets are one blob. Frame the fight so
         the closest pair of ships is well apart on screen. */
      focusBattle() {
        const c = host.battles.contacts(sectorId), all = c.ours.concat(c.foes);
        if (!all.length) return;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const s of all) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
        const span = Math.max(500, x1 - x0, z1 - z0) * 1.6;
        const cam = this.cameras.main;
        cam.setZoom(Math.min(this.scale.width, this.scale.height) / span);
        cam.centerOn((x0 + x1) / 2, (z0 + z1) / 2);
        this.clampCam();
      }
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
        const battle = host.battles && host.battles.in(sectorId);
        const ship = best && best.kind === 'ship' ? world.get(best.id) : null;
        // Your ship: toggle it in the command group.
        if (ship && ship.owned) {
          if (group.has(ship.id)) group.delete(ship.id); else group.add(ship.id);
          result = null;
          selected = group.size ? null : best;
          describe();
          return;
        }
        // With ships selected: an enemy is a target, open space is a destination.
        if (group.size) {
          if (ship && SE.hostile('player', ship.faction)) {
            host.battles.attack([...group], ship.id);
            marks.push({ x: ship._vx ?? ship.x, y: ship._vy ?? ship.z, t: 0.6, colour: 0xf06a5a });
            describe();
            return;
          }
          if (!best && battle) {
            host.battles.move([...group], w.x, w.y);
            marks.push({ x: w.x, y: w.y, t: 0.6, colour: 0x6fceeb });
            describe();
            return;
          }
          // Anything else — a station, a gate, a neutral, or open space with no
          // fight on — is not a command: let go of the group and show it.
          group.clear();
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

    function renderBattleBar() {
      const b = host.battles && host.battles.in(sectorId);
      battleBar.classList.toggle('on', !!b);
      if (!b) { if (host.frozen) setFrozen(false); return; }
      // A fight that starts while you are watching gets framed once.
      if (framedBattle !== b.id && scene) { framedBattle = b.id; scene.focusBattle(); }
      const c = host.battles.contacts(sectorId);
      // Strength: what is left of each side's hulls and shields.
      const hp = list => list.reduce((n, x) => n + x.hull + x.shield, 0);
      const us = hp(c.ours), them = hp(c.foes), total = us + them || 1;
      const html = `<div class="sb-row"><span class="sb-title">⚔ BATTLE</span><span class="sb-vs"><b class="us">${c.ours.length}</b> vs <b class="them">${c.foes.length}</b>${b.killed.length ? ` · ${b.killed.length} down` : ''}</span>
        <button class="button sb-btn" data-sys-cmd="pause" aria-label="${host.frozen ? 'Resume' : 'Pause'}">${host.frozen ? '▶' : '❚❚'}</button>
        <button class="button sb-btn" data-sys-cmd="all">All</button>
        <button class="button sb-btn" data-sys-cmd="retreat-all">Retreat</button></div>
        <div class="sb-strength" title="Remaining strength"><i class="us" style="width:${(us / total * 100).toFixed(1)}%"></i><i class="them"></i></div>`;
      if (battleBar.dataset.html !== html) { battleBar.dataset.html = html; battleBar.innerHTML = html; }
    }

    /* A siege in this system, when there is no fight to show instead: what
       stage it is at, how far the station's shield has fallen, and the one
       command that moves it on. */
    function renderSiegeBar() {
      const S = host.sieges;
      const st = S && !(host.battles && host.battles.in(sectorId)) ? S.status(sectorId) : null;
      let html = '';
      if (st && (st.phase !== 'idle' || st.progress > 0)) {
        const what = st.phase === 'defences' ? `Knock out the defences · ${st.guns.length} left`
          : st.phase === 'contested' ? `Clear the guard · ${st.ships.length} warship${st.ships.length === 1 ? '' : 's'}`
          : st.phase === 'sieging' ? `Station shield failing · ${st.ours.length} warship${st.ours.length === 1 ? '' : 's'} · ×${st.rate.toFixed(2)}`
          : 'No warships here · siege falling back';
        const k = Math.round(st.progress * 100);
        html = `<span class="sb-title">🏰 SIEGE</span><span class="sb-count">${what}</span><span class="sg-prog"><i><b style="width:${k}%"></b></i><em>${k}%</em></span>` +
          (st.phase === 'defences' ? `<button class="button" data-action="siege-attack" data-value="${sectorId}">Attack defences</button>` : '');
      }
      siegeBar.classList.toggle('on', !!html);
      if (siegeBar.dataset.html !== html) { siegeBar.dataset.html = html; siegeBar.innerHTML = html; }
    }

    function setFrozen(on) {
      host.frozen = on;
      battleBar.classList.toggle('paused', on);
      battleBar.dataset.html = '';
    }

    // A ship's hull art as a small inline icon, for the panels.
    const iconFor = ship => `<img class="sv-ico" src="${SE.ShipArt.icon(ship.cls, ship.faction)}" alt="">`;
    function miniBars(s) {
      const k = Math.max(0, Math.round(s.hull / s.hullMax * 100)), sh = s.shieldMax ? Math.max(0, Math.round(s.shield / s.shieldMax * 100)) : 0;
      return `<i class="mb">${s.shieldMax ? `<b class="sh" style="width:${sh}%"></b>` : ''}<b class="hl ${k > 50 ? '' : k > 25 ? 'mid' : 'low'}" style="width:${k}%"></b></i>`;
    }

    /* Enemy ships as buttons: tap one and every selected ship (or, with none
       selected, every ship of yours here) focuses fire on it. */
    function targetChips() {
      const c = host.battles.contacts(sectorId);
      if (!c.foes.length) return '';
      const from = c.ours[0];
      const foes = c.foes.slice().sort((a, b) => from ? Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z) : 0).slice(0, 6);
      const focus = new Set(c.ours.map(s => s.orders[0] && s.orders[0].type === 'ATTACK' ? s.orders[0].target : null));
      return `<div class="sys-kicker">TARGETS · tap to focus fire</div><div class="tgt">${foes.map(f => `<button class="tgt-chip${focus.has(f.id) ? ' on' : ''}" data-sys-cmd="target" data-id="${esc(f.id)}">${iconFor(f)}<span>${esc(f.name)}</span>${miniBars(f)}</button>`).join('')}</div>`;
    }

    function groupPanel() {
      const list = [...group].map(id => world.get(id)).filter(Boolean);
      const rows = list.map(s => `<div class="grp-row">${iconFor(s)}<span>${esc(s.name)}${s.isPlayer ? ' ★' : ''}</span>${miniBars(s)}<em>${esc(orderText(s))}</em></div>`).join('');
      const battle = host.battles.in(sectorId);
      return `<div class="sys-kicker">YOUR FLEET · ${list.length} SELECTED</div>
        <div class="grp">${rows}</div>
        ${battle ? targetChips() : '<p class="sys-doing">Tap an enemy to attack it. Tap a ship again to deselect.</p>'}
        <div class="sys-actions"><button class="button" data-sys-cmd="nearest">Attack nearest</button><button class="button" data-sys-cmd="hold">Hold</button><button class="button" data-sys-cmd="retreat">Retreat</button><button class="button" data-sys-cmd="clear">Done</button></div>`;
    }

    function resultPanel(r) {
      const title = r.won ? 'Victory' : r.retreated ? 'Withdrawn' : r.defeat ? 'Defeat' : 'Battle over';
      const list = (names, empty) => names.length ? names.map(esc).join(', ') : empty;
      return `<div class="sys-kicker ${r.won ? 'win' : 'loss'}">BATTLE REPORT · ${r.seconds}s</div><h3>${title}</h3>
        <p class="sys-doing">Destroyed: ${list(r.killed, 'none')}<br>Lost: ${list(r.lost, 'none')}${r.salvage ? `<br>Salvage: <b class="gold">+${r.salvage.toLocaleString('en-US')} cr</b>` : ''}</p>
        <div class="sys-actions"><button class="button primary" data-sys-cmd="dismiss">OK</button></div>`;
    }

    function siegeNote(st) {
      const S = host.sieges, x = S && S.status(st.sector);
      if (!x) return 'Hostile port. Docking refused.';
      if (x.phase === 'idle') return `Hostile port. Bring warships to besiege it: ${x.guns.length} defence platform${x.guns.length === 1 ? '' : 's'} first.`;
      return 'Under siege by your fleet.';
    }

    /* What this system is and what you can do in it, when nothing is
       selected: who holds it, what it has, what you have here and earn from
       it, what is threatening it, what is happening in it, and the buttons
       for the next thing to do. */
    function systemOverview() {
      const d = host.director;
      if (!d) return '';
      const sec = SE.SECTOR_BY_ID[sectorId], s = d.state, me = world.player;
      const st = world.get('st_' + sectorId);
      const here = me.sector === sectorId && !host.course;
      const mine = sec.owner === 'player';
      const hostile = !!(sec.owner && !mine && SE.hostile('player', sec.owner));
      const list = world.registry.inSector(sectorId);
      const ours = list.filter(x => x.owned && !x.dead).length;
      const foes = list.filter(x => !x.dead && !x.owned && !SE.isStatic(SE.CLASSES[x.cls]) && SE.hostile('player', x.faction)).length;
      const guns = list.filter(x => !x.dead && SE.isEmplacement(SE.CLASSES[x.cls]) && SE.hostile('player', x.faction)).length;
      const works = s.outposts.filter(p => p.sector === sectorId);
      const inf = Math.floor(s.influence[sectorId] || 0);
      const path = host.route(me.sector, sectorId), hops = path ? path.length - 1 : 0;
      const conquest = s.conquests.find(c => c.sector === sectorId);
      const chips = [];
      if (st) chips.push(`⬡ ${esc(st.name)} · ${esc(d.economy.profile(st).name)}`);
      if (sec.belt) chips.push('◌ Asteroid belt');
      if (ours) chips.push(`<span class="ok">▲ ${ours} of yours</span>`);
      if (works.length) chips.push(`<span class="ok">■ ${works.length} facilit${works.length === 1 ? 'y' : 'ies'}</span>`);
      if (foes) chips.push(`<span class="bad">⚔ ${foes} hostile ship${foes === 1 ? '' : 's'}</span>`);
      if (guns) chips.push(`<span class="bad">▣ ${guns} hostile gun${guns === 1 ? '' : 's'}</span>`);
      // One line on what this system is to you.
      let line;
      if (mine) {
        let pay = d.charterTax(sectorId);
        for (const p of works) pay += d.economy.outpostRate(p);
        line = `${conquest ? 'Captured' : 'Your charter'}. Pays you <b class="gold">+${Reach.credits(Math.round(pay))} cr/min</b>.`;
      } else if (!sec.owner) {
        line = works.length ? `Unclaimed. Your influence here: <b>${inf}/60</b>${inf >= 60 ? ' — ready to claim.' : '. Facilities build it.'}` : 'Unclaimed frontier. Build a facility here to start earning influence, then claim it.';
      } else if (hostile) {
        line = `${esc(SE.FACTIONS[sec.owner].name)} is hostile. ${st ? 'Besiege the station to take this system.' : ''}`;
      } else {
        line = `${esc(SE.FACTIONS[sec.owner].name)} territory. ${st ? 'Friendly port: dock to trade, refit and buy ships.' : ''}`;
      }
      const E = host.events, happening = E ? E.list.filter(e => e.sector === sectorId) : [];
      const evHtml = happening.map(e => { const k = E.KINDS[e.kind], left = E.left(e); return `<p class="sv-ev"><b style="color:${k.colour}">${k.icon} ${esc(k.title)}</b> · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left · ${esc(e.text)}</p>`; }).join('');
      const siege = host.sieges && host.sieges.status(sectorId);
      // The buttons: the next sensible things to do here.
      const btn = (label, action, value, primary, off) => `<button class="button${primary ? ' primary' : ''}" data-action="${action}" data-value="${esc(value || '')}" ${off ? 'disabled' : ''}>${label}</button>`;
      const acts = [];
      if (!here) acts.push(btn(`Send fleet here · ${hops} jump${hops === 1 ? '' : 's'}`, 'course', sectorId, true));
      if (here && st && !SE.hostile('player', st.faction)) acts.push(btn('Dock', 'context', '', true));
      if (here && (!sec.owner || mine)) acts.push(btn('Build facility', 'panel', 'industry'));
      if (here && !sec.owner && works.length && inf >= 60) acts.push(btn('Claim (3,000 cr)', 'claim', '', true, world.credits < 3000));
      if (hostile && st && here && siege && siege.phase === 'defences') acts.push(btn(`Attack defences (${siege.guns.length})`, 'siege-attack', sectorId, true));
      if (sec.owner && !mine && st && !hostile) acts.push(btn('War & peace', 'panel', 'factions'));
      if (ours && !here) acts.push(btn('Fleet', 'panel', 'fleet'));
      const stance = mine ? 'YOUR SYSTEM' : sec.owner ? esc(SE.FACTIONS[sec.owner].short) + (hostile ? ' · HOSTILE' : ' · FRIENDLY') : 'UNCLAIMED';
      return `<div class="sys-kicker">${stance}${here ? ' · YOUR FLEET IS HERE' : ` · ${hops} JUMP${hops === 1 ? '' : 'S'} AWAY`}</div>
        <p class="sv-line">${line}</p>
        ${chips.length ? `<div class="sv-chips">${chips.map(c => `<span class="sv-chip">${c}</span>`).join('')}</div>` : ''}
        ${evHtml}
        ${acts.length ? `<div class="sys-actions">${acts.join('')}</div>` : ''}
        <p class="sys-hint">Tap a ship, the station or a gate for details.</p>`;
    }

    let lastPanel = '';
    function describe(soft) {
      if (!sectorId) return;
      const c = summary();
      census.textContent = `${c.mine} yours · ${c.foe} hostile · ${c.other} other`;
      renderBattleBar();
      renderSiegeBar();
      if (!result && host.battles && !host.battles.in(sectorId)) result = host.battles.takeResult(sectorId);
      let html;
      const d = host.director;
      if (result) {
        html = resultPanel(result);
      } else if (group.size > 1 || (group.size && host.battles.in(sectorId))) {
        html = groupPanel();
      } else if (group.size || (selected && selected.kind === 'ship')) {
        // One of your ships outside a fight gets its full card, job buttons
        // included; the ring still marks it as selected for commands.
        const s = world.get(group.size ? [...group][0] : selected.id);
        if (!s) { selected = null; return describe(soft); }
        const cls = SE.CLASSES[s.cls];
        const fac = SE.FACTIONS[s.faction] || {};
        const stance = s.owned ? 'YOUR FLEET' : SE.hostile('player', s.faction) ? 'HOSTILE' : 'NEUTRAL';
        const hold = Math.floor(SE.cargoUsed(s));
        let actions = '';
        if (s.owned && !s.isPlayer) {
          const on = role => (s.duty || 'escort') === role ? ' on' : '';
          const b2 = (label, role, off) => `<button class="button fl-job${on(role)}" data-action="order" data-value="${s.id}:${role}" ${off ? 'disabled' : ''}>${label}</button>`;
          actions = `<div class="sys-actions">${b2('Escort', 'escort')}${b2('Guard here', 'patrol')}${cls.miner ? b2('Mine', 'mine', !SE.SECTOR_BY_ID[s.sector].belt) : ''}${b2('Hold', 'hold')}${s.hull < s.hullMax - 0.5 ? b2('Repair', 'repair') : ''}</div>`;
        } else if (s.isPlayer) {
          actions = `<div class="sys-actions"><button class="button" data-action="sys-map">Send fleet from the map</button></div>`;
        }
        html = `<div class="sys-kicker" style="color:#${colourOf(s.faction).toString(16).padStart(6, '0')}">${stance} · ${esc(fac.short || s.faction)} · ${esc(cls.name.toUpperCase())}</div>
          <h3>${esc(s.name)}${s.isPlayer ? ' <small>FLAGSHIP</small>' : ''}</h3>
          <p class="sys-doing">${esc(s.owned && host.director ? host.director.shell.shipStatus(s) : orderText(s))}${cls.cargoMax && !s.owned ? ` · hold ${hold}/${s.cargoMax}` : ''}</p>
          ${bar('HULL', s.hull, s.hullMax, 'hull')}${s.shieldMax ? bar('SHIELD', s.shield, s.shieldMax, 'shield') : ''}${actions}`;
      } else if (selected && selected.kind === 'station') {
        const st = world.get(selected.id);
        const friendly = st && !SE.hostile('player', st.faction);
        const here = st && st.sector === world.sectorId && !host.course;
        html = `<div class="sys-kicker">${esc((SE.FACTIONS[st.faction] || {}).name || '')} · STATION</div><h3>${esc(st.name)}</h3>
          <p class="sys-doing">${esc(d && d.economy ? d.economy.profile(st).name : '')}</p>
          ${bar('SHIELD', st.shield, st.shieldMax, 'shield')}
          <div class="sys-actions">${friendly && here ? '<button class="button primary" data-action="context">Dock</button>' : `<span class="sys-note">${friendly ? 'Bring your fleet here to dock.' : siegeNote(st)}</span>`}${!friendly || st.faction === 'player' ? '' : '<button class="button" data-action="panel" data-value="factions">War &amp; peace</button>'}</div>`;
      } else if (selected && selected.kind === 'gate') {
        const to = SE.SECTOR_BY_ID[selected.to];
        html = `<div class="sys-kicker">JUMP GATE</div><h3>To ${esc(to.name)}</h3><p class="sys-doing">${to.owner ? esc(SE.FACTIONS[to.owner].name) : 'Unclaimed frontier'}${to.station ? ' · ' + esc(to.station) : ''}</p>
          <div class="sys-actions"><button class="button" data-action="sys-open" data-value="${to.id}">Look through</button><button class="button primary" data-action="course" data-value="${to.id}">Send fleet</button></div>`;
      } else {
        html = host.battles && host.battles.in(sectorId)
          ? `${targetChips()}<p class="sys-hint">Tap a target to send all your ships at it, or tap your own ships (white outline) to command just those. Pause any time.</p>`
          : systemOverview();
      }
      if (html !== lastPanel) {
        // Soft refreshes must not rebuild buttons under a finger mid-tap.
        if (soft && panel.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' && html.replace(/<em>.*?<\/em>|style="width:[^"]*"/g, '') === lastPanel.replace(/<em>.*?<\/em>|style="width:[^"]*"/g, '')) {
          const fresh = document.createElement('div');
          fresh.innerHTML = html;
          for (const sel of ['.sys-bar', '.mb'])
            panel.querySelectorAll(sel).forEach((b, i) => { const n = fresh.querySelectorAll(sel)[i]; if (n) b.innerHTML = n.innerHTML; });
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
      group.clear();
      result = null;
      lastPanel = '';
      prev.clear();
      shots.length = 0;
      onTick();
      const sec = SE.SECTOR_BY_ID[id];
      title.textContent = sec.name;
      sub.textContent = sec.owner === 'player' ? 'YOUR CHARTER' : sec.owner ? SE.FACTIONS[sec.owner].name.toUpperCase() : 'UNCLAIMED FRONTIER';
      sub.style.color = sec.owner ? '#' + colourOf(sec.owner).toString(16).padStart(6, '0') : '';
      root.classList.add('on');
      document.body.classList.add('sys-open');
      // Nothing to see under a full-screen view, and composited anyway if shown.
      document.getElementById('galaxy').style.visibility = 'hidden';
      if (!game) ensureGame();
      else { game.loop.wake(); resize(); if (scene) scene.build(); }
      describe();
    }

    function close() {
      root.classList.remove('on');
      document.body.classList.remove('sys-open');
      document.getElementById('galaxy').style.visibility = '';
      sectorId = null;
      selected = null;
      group.clear();
      setFrozen(false);
      if (game) game.loop.sleep();
    }

    // Back (and Escape) leaves the view before anything else hears it.
    window.addEventListener('keydown', ev => {
      if (sectorId && ev.code === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); close(); host.director && host.director.resume(); }
    }, true);

    root.addEventListener('click', ev => {
      const cmd = ev.target.closest('[data-sys-cmd]');
      if (cmd && sectorId) {
        const B = host.battles, ids = [...group];
        switch (cmd.dataset.sysCmd) {
          case 'pause': setFrozen(!host.frozen); break;
          case 'all':
            for (const s of world.registry.inSector(sectorId)) if (s.owned && !s.dead) group.add(s.id);
            result = null; selected = null; break;
          case 'clear': group.clear(); break;
          case 'dismiss': result = null; break;
          case 'hold': B.hold(ids); break;
          case 'target': {
            const t = world.get(cmd.dataset.id);
            const who = ids.length ? ids : world.registry.inSector(sectorId).filter(s => s.owned && !s.dead).map(s => s.id);
            if (t && B.attack(who, t.id)) marks.push({ x: t._vx ?? t.x, y: t._vy ?? t.z, t: 0.6, colour: 0xf06a5a });
            break;
          }
          case 'nearest': {
            const foes = B.contacts(sectorId).foes;
            const ref = world.get(ids[0]);
            const t = ref && foes.sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))[0];
            if (t) { B.attack(ids, t.id); marks.push({ x: t.x, y: t.z, t: 0.6, colour: 0xf06a5a }); }
            else host.director.shell.toast('No hostile ships in range.', 'warn');
            break;
          }
          case 'retreat':
          case 'retreat-all': {
            const who = cmd.dataset.sysCmd === 'retreat' ? ids : world.registry.inSector(sectorId).filter(s => s.owned && !s.dead).map(s => s.id);
            const to = B.retreat(who);
            host.director.shell.toast(to ? 'Retreating to ' + SE.SECTOR_BY_ID[to].name : 'Nowhere safe to retreat to.', to ? 'info' : 'warn');
            if (to) { group.clear(); setFrozen(false); }
            break;
          }
        }
        describe();
        return;
      }
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
