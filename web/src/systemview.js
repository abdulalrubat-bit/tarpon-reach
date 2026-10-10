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
    // Operations (cream blueprint) or Tactical (dark plot); remembered per device.
    const ART = SE.SysArt;
    let theme = ART.THEMES.ops;
    try { if (localStorage.getItem('tr.sysTheme') === 'tactical') theme = ART.THEMES.tactical; } catch (e) { /* storage blocked: default */ }
    const contactsChip = document.getElementById('sys-contacts');
    /* Getting round a big system: a minimap in the corner (tap to go there)
       and jump chips that cycle through the station, fields, sites and your
       ships. */
    const mini = document.createElement('canvas');
    mini.id = 'sys-mini'; mini.setAttribute('aria-label', 'System minimap: tap to look there');
    wrap.appendChild(mini);
    const jump = document.createElement('div');
    jump.id = 'sys-jump';
    jump.innerHTML = [['station', 'Station'], ['field', 'Field'], ['site', 'Site'], ['ships', 'Ships']].map(([k, l]) => `<button type="button" data-sys="jump" data-what="${k}">${l}</button>`).join('');
    wrap.appendChild(jump);
    const jumpAt = { field: 0, site: 0, ships: 0 };
    const CONDENSED = SE.Presentation.tokens.sans;

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
        this.stationFrame = this.add.image(0, 0, '__DEFAULT').setVisible(false).setDepth(0.45);
        this.facilities = [];                   // your facilities' sprites: { id, kind, img, x, y }
        this.tags = [];                         // map labels: title, sub-line, status chip
        this.routeChips = [];                   // cargo chips on route lines
        this.overlay = this.add.graphics().setDepth(10);   // screen-space markers and chip plates
        this.cameras.main.ignore(this.overlay);
        this.gates = [];
        this.ground = this.add.graphics();      // rings, lanes, gates, station: redrawn on zoom
        this.under = this.add.graphics().setDepth(1);   // target lines, beams, engine trails
        this.live = this.add.graphics().setDepth(3);    // shots, bars, effects, rings: every frame
        this.sprites = new Map();               // ship id -> { hull, glow } images
        this.labels = [];
        this.ui.ignore([this.nebula, this.backdrop, this.planet, this.beltImage, this.stationRing, this.stationHub, this.stationGlow, this.stationFrame, this.ground, this.under, this.live]);
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
      /* The default frame is the reference's: in close on the station and
         its belt, the gates at or past the screen edge (they get edge
         markers). Zoom out to see the whole system. */
      frame() {
        const w = this.scale.width, h = this.scale.height;
        this.fitAll = Math.min(w, h) / (SE.Transit.rules.gate * 2 + 520);
        this.fit = Math.max(this.fitAll, Math.min(w / 1900, h / 2600));
        const cam = this.cameras.main;
        cam.setZoom(this.fit);
        cam.centerOn(160, 380);
      }

      clampCam() {
        const cam = this.cameras.main;
        cam.setZoom(Math.max(this.fitAll * 0.8, Math.min(this.fit * 6, cam.zoom)));
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
        // Where your miners' ore comes from: the field nearest the station.
        const near = SE.Expanse.nearestField(sectorId, 0, 0);
        this.beltPt = near ? { x: near.x, y: near.z } : { x: Math.cos(-Math.PI / 4) * 960, y: Math.sin(-Math.PI / 4) * 960 };
        this.buildFacilities();
        this.makeTags();
        this.selLabel = this.label('', () => null, -26, theme.ink, 11);
        if (host.battles && host.battles.in(sectorId)) { this.focusBattle(); framedBattle = host.battles.in(sectorId).id; }
      }

      /* Hull art (src/shipart.js) as textures, once per class and faction.
         Sprites are far cheaper per frame than redrawing shapes. */
      bake() {
        if (!this.textures.exists('fx-glow')) {
          const tex = this.textures.createCanvas('fx-glow', 64, 64), c = tex.getContext();
          const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
          g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = g; c.fillRect(0, 0, 64, 64); tex.refresh();
        }
      }

      sprite(s, diameter) {
        const art = SE.ShipArt;
        const id = art.identity(s.cls, s.faction, theme.id, diameter < 31 ? 'small' : 'full');
        const key = 'hull-' + id.key;
        if (!this.textures.exists(key)) this.textures.addCanvas(key, art.canvas(id.cls, id.faction, id.mode, id.detail));
        let sp = this.sprites.get(s.id);
        if (!sp) {
          const glow = this.add.image(0, 0, 'fx-glow').setDepth(1.5);
          const hull = this.add.image(0, 0, key).setDepth(2);
          this.ui.ignore([glow, hull]);
          sp = { hull, glow, key, seen: 0 };
          this.sprites.set(s.id, sp);
        } else if (sp.key !== key) {
          sp.hull.setTexture(key); sp.key = key;
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
          stroke: theme.inkHalo, strokeThickness: Math.round(3 * dpr)
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
        // The plotting themes are flat: a coloured sheet and a grid, no nebula.
        this.nebula.setVisible(false); this.backdrop.setVisible(false);
        setWrapBackground();

        // The expanse (src/expanse.js): planets and moons, asteroid fields and
        // points of interest, spread across a system three times the old size.
        const L = SE.Expanse.layout(sectorId), layout = world.transit.layout(sectorId);
        for (const im of this.scenery || []) im.destroy();
        this.scenery = [];
        const addImg = (key, x, y, size, depth) => { const im = this.add.image(x, y, key).setDisplaySize(size, size).setDepth(depth); this.ui.ignore(im); this.scenery.push(im); return im; };
        const paintBody = (key, PR, pcol) => {
          const brng = SE.Rng(key);
          this.paint(key, PR * 1.5, 512, c => {
            if (theme.atmos) {
              const atm = c.createRadialGradient(0, 0, PR * 0.95, 0, 0, PR * 1.45);
              atm.addColorStop(0, rgbaInt(shadeInt(pcol, 0.4), 0.45)); atm.addColorStop(1, rgbaInt(pcol, 0));
              c.fillStyle = atm; c.beginPath(); c.arc(0, 0, PR * 1.45, 0, Math.PI * 2); c.fill();
            }
            c.save(); c.beginPath(); c.arc(0, 0, PR, 0, Math.PI * 2); c.clip();
            c.fillStyle = cssInt(pcol); c.fillRect(-PR, -PR, PR * 2, PR * 2);
            for (let i = 0; i < 9; i++) {
              const y = brng.float(-PR, PR), h = brng.float(PR * 0.05, PR * 0.22);
              c.fillStyle = rgbaInt(shadeInt(pcol, brng.float(-0.25, 0.2)), brng.float(0.12, 0.28));
              c.fillRect(-PR, y, PR * 2, h);
            }
            const sx = Math.cos(a), sy = Math.sin(a);
            const night = c.createLinearGradient(sx * PR, sy * PR, -sx * PR, -sy * PR);
            night.addColorStop(0, 'rgba(0,0,0,0)'); night.addColorStop(0.55, 'rgba(2,5,10,.5)'); night.addColorStop(1, 'rgba(2,5,10,.9)');
            c.fillStyle = night; c.fillRect(-PR, -PR, PR * 2, PR * 2);
            for (let i = 0; i < 14; i++) { const cx = brng.float(-PR, PR) * 0.8, cy = brng.float(-PR, PR) * 0.8, cr = brng.float(PR * 0.03, PR * 0.11); c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = PR * 0.012; c.beginPath(); c.arc(cx, cy, cr, 0, Math.PI * 2); c.stroke(); }
            c.restore();
            c.strokeStyle = 'rgba(20,22,24,.55)'; c.lineWidth = PR * 0.015; c.beginPath(); c.arc(0, 0, PR, 0, Math.PI * 2); c.stroke();
          });
          return key;
        };
        this.planet.setVisible(false);
        this.bodies = L.bodies;
        L.bodies.forEach(b => {
          const pcol = theme.planet[b.hue % theme.planet.length], key = `sys-body-${sectorId}-${b.id}-${theme.id}`;
          addImg(paintBody(key, b.r, pcol), b.x, b.z, b.r * 3, 0.05);
          b.moons.forEach((m, k) => addImg(paintBody(key + '-m' + k, m.r, shadeInt(pcol, -0.2)), m.x, m.z, m.r * 3, 0.05));
        });

        // Station art, per faction, and the gates.
        const st = world.get('st_' + sectorId);
        if (st) {
          const f = SE.FACTIONS[st.faction] ? st.faction : 'apex';
          const fk = 'sv2-frame-' + f;
          if (!this.textures.exists(fk)) this.textures.addCanvas(fk, ART.stationFrame(colourOf(f)));
          if (!this.textures.exists('sv2-hub')) this.textures.addCanvas('sv2-hub', ART.stationHub());
          this.stationFrame.setTexture(fk).setVisible(true);
          this.stationHub.setTexture('sv2-hub').setVisible(true);
          this.stationRing.setVisible(false);
          this.stationGlow.setTexture('fx-glow').setTint(0xff7a2a).setVisible(theme.id === 'tactical');
          this.stationFaction = f;
        } else { this.stationHub.setVisible(false); this.stationRing.setVisible(false); this.stationGlow.setVisible(false); this.stationFrame.setVisible(false); }
        if (!this.textures.exists('sv2-gate')) this.textures.addCanvas('sv2-gate', ART.gate());
        for (const gt of this.gates) { gt.ring.destroy(); gt.core.destroy(); }
        this.gates = [];
        for (const to in layout.gates) {
          const n = layout.nodes[layout.gates[to]], o = SE.SECTOR_BY_ID[to].owner, col = o ? colourOf(o) : 0x7fa8c0;
          const core = this.add.image(n.x, n.z, 'fx-glow').setTint(col).setDepth(0.3).setVisible(theme.id === 'tactical');
          const ring = this.add.image(n.x, n.z, 'sv2-gate').setDepth(0.35).setRotation(Math.atan2(n.z, n.x) - Math.PI / 2);
          this.ui.ignore([core, ring]);
          this.gates.push({ ring, core, col });
        }

        // Asteroid fields: separate clouds of rock, well away from the station.
        this.beltImage.setVisible(false);
        this.fields = L.fields;
        const lx = Math.cos(a), ly = Math.sin(a);
        for (const f of L.fields) {
          const half = f.r + 80, key = `sys-field-${sectorId}-${f.id}-${theme.id}`, frng = SE.Rng(world.seed + ':' + sectorId + ':' + f.id);
          this.paint(key, half, 1024, (c, k) => {
            if (theme.dust) {
              const dust = c.createRadialGradient(0, 0, 0, 0, 0, f.r * 1.1);
              dust.addColorStop(0, 'rgba(160,150,130,.12)'); dust.addColorStop(1, 'rgba(160,150,130,0)');
              c.fillStyle = dust; c.beginPath(); c.arc(0, 0, f.r * 1.1, 0, Math.PI * 2); c.fill();
            }
            for (let i = 0; i < 700; i++) {
              const ang = frng.float(0, Math.PI * 2), d = Math.sqrt(frng.float(0, 1)) * (f.r + 40);
              c.globalAlpha = frng.float(0.4, 0.9); c.fillStyle = frng.chance(0.5) ? 'rgb(120,116,110)' : 'rgb(80,82,86)';
              c.beginPath(); c.arc(Math.cos(ang) * d, Math.sin(ang) * d, Math.max(frng.float(1.5, 4), 1.2 / k), 0, Math.PI * 2); c.fill();
            }
            for (let i = 0; i < 240; i++) {
              const ang = frng.float(0, Math.PI * 2), d = Math.pow(frng.float(0, 1), 0.7) * f.r;
              const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
              const size = Math.max(frng.chance(0.08) ? frng.float(40, 80) : frng.float(8, 30), 2 / k), sides = 6 + Math.floor(frng.float(0, 4)), rot = frng.float(0, Math.PI * 2);
              c.beginPath();
              for (let v = 0; v < sides; v++) { const t = rot + v / sides * Math.PI * 2, rr = size * frng.float(0.65, 1.15); v ? c.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr) : c.moveTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
              c.closePath();
              const base = frng.chance(0.3) ? [154, 143, 128] : frng.chance(0.5) ? [125, 116, 104] : [108, 112, 120];
              const g = c.createLinearGradient(x + lx * size, y + ly * size, x - lx * size, y - ly * size);
              g.addColorStop(0, `rgb(${base.map(v => Math.min(255, v + 50)).join(',')})`); g.addColorStop(1, `rgb(${base.map(v => v * 0.45 | 0).join(',')})`);
              c.globalAlpha = frng.float(0.75, 1); c.fillStyle = g; c.fill();
              c.lineWidth = Math.max(1, 0.8 / k); c.strokeStyle = 'rgba(10,12,16,.6)'; c.stroke();
            }
          });
          addImg(key, f.x, f.z, half * 2, 0.1);
        }
        // Points of interest: a derelict hulk, a debris field, a nebula pocket.
        this.sites = L.sites;
        for (const site of L.sites) addImg(this.siteArt(site.kind), site.x, site.z, site.r * 2.4, site.kind === 'nebula' ? 0.04 : 0.12);
      }

      // One texture per site kind and theme, drawn in a unit square.
      siteArt(kind) {
        const key = 'sv-site-' + kind + '-' + theme.id;
        if (this.textures.exists(key)) return key;
        const rng = SE.Rng(key);
        this.paint(key, 100, 512, c => {
          if (kind === 'nebula') {
            const tint = theme.id === 'ops' ? [150, 120, 175] : [70, 190, 140];
            for (let i = 0; i < 22; i++) {
              const x = rng.float(-55, 55), y = rng.float(-55, 55), r = rng.float(22, 48);
              const g = c.createRadialGradient(x, y, 0, x, y, r);
              g.addColorStop(0, `rgba(${tint.join(',')},${rng.float(0.10, 0.22)})`); g.addColorStop(1, `rgba(${tint.join(',')},0)`);
              c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
            }
            for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(${tint.join(',')},.5)`; c.beginPath(); c.arc(rng.float(-60, 60), rng.float(-60, 60), rng.float(0.4, 1.2), 0, Math.PI * 2); c.fill(); }
            return;
          }
          const plate = (x, y, w, h, rot) => {
            c.save(); c.translate(x, y); c.rotate(rot);
            const g = c.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2); g.addColorStop(0, '#5a636b'); g.addColorStop(1, '#23272b');
            c.fillStyle = g; c.fillRect(-w / 2, -h / 2, w, h); c.lineWidth = 0.8; c.strokeStyle = '#101316'; c.strokeRect(-w / 2, -h / 2, w, h);
            c.restore();
          };
          if (kind === 'derelict') {
            // A broken capital hull in two pieces, a few dim lights still on.
            for (const [x, y, rot, len] of [[-14, -10, -0.5, 70], [22, 18, -0.7, 46]]) {
              c.save(); c.translate(x, y); c.rotate(rot);
              const g = c.createLinearGradient(-12, 0, 12, 0); g.addColorStop(0, '#2c3136'); g.addColorStop(0.5, '#5d666e'); g.addColorStop(1, '#2c3136');
              c.beginPath(); c.moveTo(0, -len / 2); c.lineTo(12, -len / 2 + 14); c.lineTo(13, len / 2 - 4); c.lineTo(5, len / 2); c.lineTo(-3, len / 2 - 7); c.lineTo(-9, len / 2); c.lineTo(-13, len / 2 - 6); c.lineTo(-12, -len / 2 + 14); c.closePath();
              c.fillStyle = g; c.fill(); c.lineWidth = 1.4; c.strokeStyle = '#101316'; c.stroke();
              for (let k = 0; k < 4; k++) { c.fillStyle = k % 2 ? 'rgba(255,140,60,.8)' : 'rgba(255,217,160,.6)'; c.fillRect(-2, -len / 2 + 12 + k * len / 6, 3, 3); }
              c.restore();
            }
            for (let i = 0; i < 18; i++) plate(rng.float(-60, 60), rng.float(-60, 60), rng.float(3, 9), rng.float(2, 5), rng.float(0, 6.3));
            return;
          }
          // Debris: a scatter of plates, spars and frozen fragments.
          for (let i = 0; i < 70; i++) {
            const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * 80;
            plate(Math.cos(a) * d, Math.sin(a) * d, rng.float(3, 14), rng.float(2, 6), rng.float(0, 6.3));
          }
          c.strokeStyle = 'rgba(16,19,22,.8)'; c.lineWidth = 1.6;
          for (let i = 0; i < 8; i++) { const x = rng.float(-60, 60), y = rng.float(-60, 60), a = rng.float(0, 6.3), l = rng.float(10, 26); c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); }
        });
        return key;
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
        const G = SE.Transit.rules.gate, far = G + 700, rng = SE.Rng('grid:' + sectorId);
        // A polar plotting grid round the station, and survey crosses.
        g.lineStyle(1 * px, theme.grid, theme.gridA);
        for (let r = 350; r <= far; r += 350) g.strokeCircle(0, 0, r);
        g.lineStyle(1 * px, theme.grid, theme.gridA * 0.55);
        for (let k = 0; k < 24; k++) { const t = k / 24 * Math.PI * 2; g.lineBetween(Math.cos(t) * 350, Math.sin(t) * 350, Math.cos(t) * far, Math.sin(t) * far); }
        g.lineStyle(1.3 * px, theme.cross, 0.6);
        for (let i = 0; i < 110; i++) { const x = rng.float(-far, far), y = rng.float(-far, far), c = 5 * px; g.lineBetween(x - c, y, x + c, y); g.lineBetween(x, y - c, x, y + c); }
        const layout = world.transit.layout(sectorId);
        g.lineStyle(1 * px, theme.lane, theme.laneA);
        for (const e of layout.edges) {
          const a = layout.nodes[e.a], b = layout.nodes[e.b];
          g.lineBetween(a.x, a.z, b.x, b.z);
        }
        // Station, gates and facilities keep a minimum on-screen size when zoomed out.
        // Smaller floor when zoomed far out, or the station hides the fields around it.
        const sd = this.sd = Math.max(SE.Transit.rules.stationRadius * 1.5, (z < this.fit * 0.7 ? 56 : 92) * px);
        this.stationFrame.setDisplaySize(sd * 2.1, sd * 2.1); this.stationHub.setDisplaySize(sd * 0.95, sd * 0.95); this.stationGlow.setDisplaySize(sd * 1.2, sd * 1.2);
        const gd = this.gd = Math.max(300, 50 * px);
        for (const gt of this.gates) { gt.ring.setDisplaySize(gd, gd); gt.core.setDisplaySize(gd * 0.7, gd * 0.7); }
        const fd = this.fd = Math.max(300, 56 * px);
        for (const f of this.facilities) f.img.setDisplaySize(fd, fd);
      }

      /* Your facilities in this system, drawn as installations in an arc on
         the lower right, the way the reference has its foundry. */
      buildFacilities() {
        for (const f of this.facilities) f.img.destroy();
        this.facilities = [];
        const works = host.director ? host.director.state.outposts.filter(p => p.sector === sectorId) : [];
        this.facSig = works.map(p => p.id + p.online).join();
        const station = world.get('st_' + sectorId);
        works.forEach((p, i) => {
          const key = 'sv2-fac-' + p.kind;
          if (!this.textures.exists(key)) this.textures.addCanvas(key, ART.facility(p.kind));
          // A column below and right of the station, two abreast past four.
          const col = Math.floor(i / 4), row = i % 4;
          const x = (station ? -60 : 0) - col * 520, y = (station ? 700 : 300) + row * 400;
          const img = this.add.image(x, y, key).setDepth(0.5).setAlpha(p.online === false ? 0.5 : 1);
          this.ui.ignore(img);
          this.facilities.push({ id: p.id, kind: p.kind, img, x, y });
        });
        this.lastZoom = 0;
      }

      /* Map labels in the reference's style: a bold condensed name with a
         square marker, a coloured line under it, and sometimes a status chip.
         They are screen-space text placed from world points every frame. */
      tag(title, at, opt = {}) {
        const mk = (str, size, colour, bold) => {
          const t = this.add.text(0, 0, str, { fontFamily: CONDENSED, fontStyle: bold ? 'bold' : 'normal', fontSize: Math.round(size * dpr) + 'px', color: colour, stroke: theme.inkHalo, strokeThickness: Math.round((bold ? 4 : 3) * dpr) }).setOrigin(0, 0.5).setDepth(11);
          this.cameras.main.ignore(t);
          return t;
        };
        const t = { at, opt, title: mk(title, opt.size || 12, theme.ink, true), sub: opt.sub ? mk('', 10.5, theme.sub, true) : null, chip: opt.chip ? mk('', 9.5, theme.chipInk, true).setStroke(theme.inkHalo, 0) : null };
        this.tags.push(t);
        return t;
      }
      makeTags() {
        for (const t of this.tags) { t.title.destroy(); t.sub?.destroy(); t.chip?.destroy(); }
        this.tags = [];
        for (const c of this.routeChips) c.destroy();
        this.routeChips = [];
        const d = host.director, sec = SE.SECTOR_BY_ID[sectorId];
        const station = world.get('st_' + sectorId);
        if (station) this.tag(station.name.replace(/^Reach /, '').toUpperCase(), () => ({ x: this.sd * 0.42, y: this.sd * 0.62 }), { size: 14, sub: () => this.stationLine(station) });
        const L = SE.Expanse.layout(sectorId);
        for (const f of L.fields) this.tag(f.name.toUpperCase(), () => ({ x: f.x + f.r * 0.55, y: f.z - f.r * 0.75 }), { marker: true, sub: () => {
          const n = world.registry.inSector(sectorId).filter(x => !x.dead && SE.CLASSES[x.cls].miner && Math.hypot(x.x - f.x, x.z - f.z) < f.r * 1.4).length;
          return (f.rich > 1.1 ? 'RICH · ' : f.rich < 0.9 ? 'THIN · ' : '') + (n ? n + (n === 1 ? ' MINER' : ' MINERS') : 'ASTEROID FIELD');
        } });
        for (const site of L.sites) this.tag(site.name.toUpperCase(), () => ({ x: site.x + site.r * 0.6, y: site.z - site.r * 0.5 }), { marker: true, sub: () => {
          const here = world.registry.inSector(sectorId).filter(x => !x.dead && !SE.isStatic(SE.CLASSES[x.cls]) && Math.hypot(x.x - site.x, x.z - site.z) < site.r + 400);
          const foes = here.filter(x => SE.hostile('player', x.faction)).length;
          return foes ? foes + ' HOSTILE' + (foes === 1 ? '' : 'S') + ' · ' + site.code : site.code;
        } });
        const counts = {};
        for (const f of this.facilities) {
          const p = d.state.outposts.find(o => o.id === f.id), n = counts[f.kind] = (counts[f.kind] || 0) + 1;
          const name = { refinery: 'FOUNDRY', extractor: 'EXTRACTOR', solar: 'SOLAR ARRAY' }[f.kind] || f.kind.toUpperCase();
          this.tag(name + ' ' + String(n).padStart(2, '0'), () => ({ x: f.x + this.fd * 0.55, y: f.y - this.fd * 0.12 }), { marker: true, chip: () => facilityChip(d.state.outposts.find(o => o.id === f.id) || p) });
        }
        const layout = world.transit.layout(sectorId);
        for (const to in layout.gates) {
          const n = layout.nodes[layout.gates[to]];
          this.tag(gateName(to), () => ({ x: n.x, y: n.z + this.gd * 0.62 }), { marker: true, centre: true });
        }
        for (const b of L.bodies) this.tag(b.code, () => ({ x: b.x, y: b.z + b.r * 1.2 }), { size: 10, plain: true, centre: true });
      }
      edgeMarkers(cam, z) {
        const layout = world.transit.layout(sectorId), W = this.scale.width, H = this.scale.height;
        if (!this.edges || this.edgesFor !== sectorId) {
          for (const e of wrap.querySelectorAll('.sys-edge')) e.remove();
          this.edges = {}; this.edgesFor = sectorId;
          for (const to in layout.gates) {
            const el = document.createElement('button');
            el.type = 'button'; el.className = 'sys-edge'; el.dataset.sys = 'gate'; el.dataset.to = to;
            el.textContent = gateName(to) + ' ›';
            wrap.appendChild(el); this.edges[to] = el;
          }
        }
        const cx = W / 2, cy = H / 2, pad = 34 * dpr;
        for (const to in this.edges) {
          const n = layout.nodes[layout.gates[to]], el = this.edges[to];
          const sx = (n.x - cam.worldView.x) * z, sy = (n.z - cam.worldView.y) * z;
          const off = sx < 0 || sx > W || sy < 0 || sy > H;
          el.classList.toggle('on', off);
          if (!off) continue;
          // Where the line from the middle to the gate crosses the screen's inset edge.
          const dx = sx - cx, dy = sy - cy, k = Math.min((cx - pad) / Math.abs(dx || 1e-6), (cy - pad) / Math.abs(dy || 1e-6));
          // Pinned to the edge it points past, never hanging off it.
          const hw = el.offsetWidth / 2 + 6, hh = el.offsetHeight / 2 + 6, Wc = W / dpr, Hc = H / dpr;
          el.style.left = Math.max(hw, Math.min(Wc - hw, (cx + dx * k) / dpr)) + 'px';
          el.style.top = Math.max(hh, Math.min(Hc - hh, (cy + dy * k) / dpr)) + 'px';
        }
      }
      panTo(x, y, zoom, instant = false) {
        const cam = this.cameras.main;
        // A new navigation command must replace a pan already in flight.
        const reduced = host.director?.state.settings.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (instant || reduced) { cam.panEffect.reset(); cam.zoomEffect.reset(); cam.centerOn(x, y); if (zoom) cam.setZoom(zoom); return; }
        cam.pan(x, y, 450, 'Sine.easeInOut', true);
        if (zoom) cam.zoomTo(zoom, 450, 'Sine.easeInOut', true);
      }
      drawMini() {
        const css = 116, k = Math.min(2, window.devicePixelRatio || 1);
        if (mini.width !== css * k) { mini.width = mini.height = css * k; mini.style.width = mini.style.height = css + 'px'; }
        const c = mini.getContext('2d'), span = SE.Transit.rules.gate + 700, sc = css * k / (span * 2);
        const X = x => (x + span) * sc, Y = z => (z + span) * sc, cam = this.cameras.main, L = SE.Expanse.layout(sectorId);
        const ink = theme.ink, accent = cssInt(theme.accent);
        c.clearRect(0, 0, mini.width, mini.height);
        c.fillStyle = theme.bg; c.fillRect(0, 0, mini.width, mini.height);
        c.strokeStyle = rgbaInt(theme.grid, 0.6); c.lineWidth = k; c.beginPath(); c.arc(X(0), Y(0), SE.Transit.rules.gate * sc, 0, Math.PI * 2); c.stroke();
        for (const b of L.bodies) { c.fillStyle = rgbaInt(theme.planet[b.hue % theme.planet.length], 0.8); c.beginPath(); c.arc(X(b.x), Y(b.z), Math.max(2 * k, b.r * sc), 0, Math.PI * 2); c.fill(); }
        for (const f of L.fields) { c.fillStyle = 'rgba(120,116,110,.45)'; c.beginPath(); c.arc(X(f.x), Y(f.z), f.r * sc, 0, Math.PI * 2); c.fill(); }
        for (const site of L.sites) { const x = X(site.x), y = Y(site.z), r = 3 * k; c.strokeStyle = ink; c.lineWidth = k; c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.stroke(); }
        const layout = world.transit.layout(sectorId);
        for (const to in layout.gates) { const n = layout.nodes[layout.gates[to]]; c.strokeStyle = ink; c.lineWidth = 1.4 * k; c.beginPath(); c.arc(X(n.x), Y(n.z), 3 * k, 0, Math.PI * 2); c.stroke(); }
        if (world.get('st_' + sectorId)) { c.fillStyle = ink; c.fillRect(X(0) - 3 * k, Y(0) - 3 * k, 6 * k, 6 * k); }
        for (const s of world.registry.inSector(sectorId)) {
          if (s.dead || SE.isStatic(SE.CLASSES[s.cls])) continue;
          c.fillStyle = s.owned ? accent : SE.hostile('player', s.faction) ? '#e0402e' : 'rgba(120,130,140,.8)';
          c.beginPath(); c.arc(X(s._vx ?? s.x), Y(s._vy ?? s.z), (s.owned ? 2.2 : 1.6) * k, 0, Math.PI * 2); c.fill();
        }
        const v = cam.worldView;
        c.strokeStyle = accent; c.lineWidth = 1.5 * k; c.strokeRect(X(v.x), Y(v.y), v.width * sc, v.height * sc);
      }
      jumpTo(what) {
        const L = SE.Expanse.layout(sectorId), next = (list, key) => { if (!list.length) return null; const it = list[jumpAt[key] % list.length]; jumpAt[key]++; return it; };
        let p = null;
        if (what === 'station') p = { x: 0, z: 0 };
        else if (what === 'field') p = next(L.fields, 'field');
        else if (what === 'site') p = next(L.sites, 'site');
        else { const s = next(world.registry.inSector(sectorId).filter(x => x.owned && !x.dead), 'ships'); if (s) p = { x: s.x, z: s.z }; }
        if (!p) { host.director?.shell.toast(what === 'field' ? 'No asteroid fields in this system.' : 'Nothing to jump to.', 'info'); return; }
        follow = null;
        this.panTo(p.x, p.z, Math.max(this.cameras.main.zoom, this.fit));
      }
      stationLine(st) {
        const d = host.director;
        if (!d || SE.hostile('player', st.faction)) return SE.hostile('player', st.faction) ? 'HOSTILE' : '';
        const prof = d.economy.profile(st);
        if (prof.yard) { const n = d.economy.jobsAt(st).filter(j => !['complete', 'cancelled'].includes(j.phase)).length; return n + (n === 1 ? ' ACTIVE BERTH' : ' ACTIVE BERTHS'); }
        return prof.name.split('·')[0].trim().toUpperCase();
      }

      drawTags(cam, z) {
        const o = this.overlay, W = this.scale.width, H = this.scale.height;
        o.clear();
        for (const t of this.tags) {
          const at = t.at();
          if (!at) { t.title.setVisible(false); t.sub?.setVisible(false); t.chip?.setVisible(false); continue; }
          let sx = (at.x - cam.worldView.x) * z, sy = (at.y - cam.worldView.y) * z;
          const vis = sx > -160 * dpr && sx < W + 40 * dpr && sy > -40 * dpr && sy < H + 40 * dpr;
          const m = t.opt.marker ? 16 * dpr : 0;
          if (t.opt.centre) sx -= (t.title.width + m) / 2;
          // Keep names on screen: a label near the right edge slides left.
          const wide = Math.max(t.title.width, t.sub ? t.sub.width : 0) + m;
          if (sx + wide > W - 6 * dpr && sx < W) sx = Math.max(6 * dpr, W - 6 * dpr - wide);
          if (t.opt.plain) t.title.setColor(theme.sub);
          t.title.setPosition(sx + m, sy).setVisible(vis);
          if (vis && m) {
            o.lineStyle(1.8 * dpr, theme.marker, 1); o.strokeRect(sx, sy - 5 * dpr, 10 * dpr, 10 * dpr);
            o.fillStyle(theme.accent, 1); o.fillRect(sx + 3 * dpr, sy - 2 * dpr, 4 * dpr, 4 * dpr);
          }
          let row = sy + 15 * dpr;
          if (t.sub) { const str = t.opt.sub(); t.sub.setText(str).setPosition(sx + m, row).setVisible(vis && !!str); if (str) row += 15 * dpr; }
          if (t.chip) {
            const str = t.opt.chip();
            t.chip.setText(str).setPosition(sx + m + 7 * dpr, row + 2 * dpr).setVisible(vis && !!str);
            if (vis && str) { o.fillStyle(theme.chipBg, 0.95); o.fillRoundedRect(sx + m, row - 7 * dpr, t.chip.width + 14 * dpr, 18 * dpr, 3 * dpr); }
          }
        }
      }

      /* Supply lines: where goods move in this system, drawn as dashed
         arrows that march in the direction of travel, loaded leg bold and
         the empty way back faint. Freight routes come from freight.js; your
         miners' belt-to-station run and an extractor feeding a foundry are
         drawn too. Ends that lie in another system point at its gate. */
      routeLegs() {
        const d = host.director;
        if (!d) return [];
        const here = sectorId, layout = world.transit.layout(here), st = world.get('st_' + here), legs = [];
        const gateTo = target => {
          const path = host.route(here, target), k = path && path[1] !== undefined ? layout.gates[path[1]] : undefined;
          return k === undefined || k === null ? null : { x: layout.nodes[k].x, y: layout.nodes[k].z, r: this.gd * 0.35 };
        };
        const makes = { ore: 'extractor', alloy: 'refinery', cells: 'solar' };
        const facAt = kind => {
          const fs = this.facilities.filter(f => !kind || f.kind === kind);
          return fs.length ? { x: fs.reduce((n, f) => n + f.x, 0) / fs.length, y: fs.reduce((n, f) => n + f.y, 0) / fs.length, r: this.fd * 0.4 } : null;
        };
        const stPt = st ? { x: 0, y: 0, r: this.sd * 0.5 } : null;
        for (const r of d.state.routes) {
          if (r.lost) continue;
          let a = null, b = null;
          if (r.from === here) a = facAt(makes[r.good]) || facAt();
          else if (r.to.sector === here) a = gateTo(r.from);
          if (r.to.sector === here) b = r.to.kind === 'industry' ? facAt('refinery') : stPt;
          else if (r.from === here) b = gateTo(r.to.sector);
          if (a && b) legs.push({ a, b, label: SE.GOODS[r.good].name.split(' ').pop().toUpperCase() });
        }
        const miners = world.registry.inSector(here).some(s => s.owned && !s.dead && SE.CLASSES[s.cls].miner && s.duty === 'mine');
        if (miners && SE.SECTOR_BY_ID[here].belt && stPt && !SE.hostile('player', st.faction)) legs.push({ a: { ...this.beltPt, r: 120 }, b: stPt, label: 'ORE' });
        const ex = facAt('extractor'), fo = facAt('refinery');
        if (ex && fo && Math.hypot(ex.x - fo.x, ex.y - fo.y) > 80) legs.push({ a: ex, b: fo, label: null });
        return legs;
      }
      drawLeg(g, a, b, px, time, col, alpha, width, arrows) {
        let dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (len < 60) return null;
        const nx = -dy / len, ny = dx / len, bend = len * 0.2;
        const cx = (a.x + b.x) / 2 + nx * bend, cy = (a.y + b.y) / 2 + ny * bend;
        const P = t => { const m = 1 - t; return { x: m * m * a.x + 2 * m * t * cx + t * t * b.x, y: m * m * a.y + 2 * m * t * cy + t * t * b.y }; };
        const N = 36, pts = [];
        let acc = 0;
        for (let i = 0; i <= N; i++) { const p = P(i / N); if (i) acc += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); p.d = acc; pts.push(p); }
        const at = dist => {
          let i = 1;
          while (i < N && pts[i].d < dist) i++;
          const p0 = pts[i - 1], p1 = pts[i], k = (dist - p0.d) / ((p1.d - p0.d) || 1);
          return { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k, ang: Math.atan2(p1.y - p0.y, p1.x - p0.x) };
        };
        const s0 = Math.min(acc * 0.3, a.r || 0), s1 = acc - Math.min(acc * 0.3, b.r || 0);
        const dash = 12 * px, gap = 8 * px, period = dash + gap, off = (time * 0.001 * 26 * px) % period;
        g.lineStyle(width * px, col, alpha);
        for (let d0 = s0 - period + off; d0 < s1; d0 += period) {
          const from = Math.max(s0, d0), to = Math.min(s1, d0 + dash);
          if (to <= from) continue;
          const p0 = at(from), p1 = at(to);
          g.lineBetween(p0.x, p0.y, p1.x, p1.y);
        }
        if (arrows) {
          g.fillStyle(col, alpha);
          for (const d1 of [s0 + (s1 - s0) * 0.5, s1]) {
            const p = at(d1), L = 9 * px, W = 5 * px;
            g.fillTriangle(p.x + Math.cos(p.ang) * L * 0.4, p.y + Math.sin(p.ang) * L * 0.4,
              p.x - Math.cos(p.ang) * L * 0.6 + Math.cos(p.ang + Math.PI / 2) * W, p.y - Math.sin(p.ang) * L * 0.6 + Math.sin(p.ang + Math.PI / 2) * W,
              p.x - Math.cos(p.ang) * L * 0.6 - Math.cos(p.ang + Math.PI / 2) * W, p.y - Math.sin(p.ang) * L * 0.6 - Math.sin(p.ang + Math.PI / 2) * W);
          }
        }
        return at(s0 + (s1 - s0) * 0.32);
      }
      drawRoutes(g, px, time, cam, z) {
        const legs = this.routeLegs();
        let n = 0;
        for (const leg of legs) {
          this.drawLeg(g, leg.b, leg.a, px, time, theme.ret, 0.5, 1.8, false);
          const mid = this.drawLeg(g, leg.a, leg.b, px, time, theme.accent, 0.95, 3, true);
          if (!leg.label || !mid) continue;
          let chip = this.routeChips[n];
          if (!chip) {
            chip = this.add.text(0, 0, '', { fontFamily: CONDENSED, fontStyle: 'bold', fontSize: Math.round(9.5 * dpr) + 'px', color: theme.chipInk }).setOrigin(0.5, 0.5).setDepth(11);
            this.cameras.main.ignore(chip);
            this.routeChips.push(chip);
          }
          n++;
          const sx = (mid.x - cam.worldView.x) * z, sy = (mid.y - cam.worldView.y) * z;
          chip.setText(leg.label).setPosition(sx, sy).setVisible(true);
          this.overlay.fillStyle(theme.chipBg, 0.95);
          this.overlay.fillRoundedRect(sx - chip.width / 2 - 6 * dpr, sy - 8 * dpr, chip.width + 12 * dpr, 16 * dpr, 3 * dpr);
        }
        for (let i = n; i < this.routeChips.length; i++) this.routeChips[i].setVisible(false);
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
        this.stationHub.rotation += dt * 0.05;
        this.stationGlow.setAlpha(0.3 + 0.1 * Math.sin(time * 0.0015));
        for (let k = 0; k < this.gates.length; k++) this.gates[k].core.setAlpha(0.35 + 0.2 * Math.sin(time * 0.002 + k));
        // Facilities built or switched off since the view opened.
        if ((this.frameNo & 31) === 0 && host.director) {
          const sig = host.director.state.outposts.filter(p => p.sector === sectorId).map(p => p.id + p.online).join();
          if (sig !== this.facSig) { this.buildFacilities(); this.makeTags(); }
        }
        const stNow = world.get('st_' + sectorId);
        if (stNow && this.stationFaction && stNow.faction !== this.stationFaction) this.drawStars();
        const z = cam.zoom, px = dpr / z;
        // Map artwork stays legible at overview zoom and is capped at close zoom.
        const grow = Math.min(1.8, Math.max(1, Math.sqrt(z / (this.fit * 2.5))));
        const zoomRatio = z / this.fit;
        const shipDiameter = cls => SE.ShipArt.mapSize(cls, zoomRatio);
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
          // Tactical marks every hostile hull with a red diamond and its heading.
          if (theme.id === 'tactical' && !SE.isStatic(cls) && SE.hostile('player', s.faction)) {
            const r = Math.max(15, shipDiameter(s.cls) * 0.46 + 4) * px;
            g.lineStyle(1.6 * px, theme.hostile, 0.95);
            g.strokePoints([{ x, y: y - r }, { x: x + r, y }, { x, y: y + r }, { x: x - r, y }], true);
            if (Math.hypot(s.vx, s.vz) > 5) { g.lineStyle(1.2 * px, theme.hostile, 0.6); g.lineBetween(x, y, x + s.vx * 3, y + s.vz * 3); }
          }
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
          const diameter = shipDiameter(s.cls), size = diameter * px;
          const sp = this.sprite(s, diameter);
          sp.seen = tick;
          sp.hull.setPosition(x, y).setRotation(Math.atan2(fz, fx) + Math.PI / 2).setDisplaySize(size, size).setVisible(true);
          // Small, steady wake behind moving ships; stationary ports stay clear.
          const speed = Math.hypot(s.vx, s.vz), top = cls.topSpeed || 1;
          const thrust = Math.min(1, speed / top);
          const wake = size * (0.12 + thrust * 0.08);
          sp.glow.setPosition(x - fx * size * 0.44, y - fz * size * 0.44)
            .setDisplaySize(wake, wake * (1 + thrust)).setRotation(Math.atan2(fz, fx) + Math.PI / 2)
            .setTint(0x91cbd1).setAlpha(thrust * (theme.id === 'ops' ? 0.3 : 0.5)).setVisible(thrust > 0.05);
          // Who is shooting whom, faintly, in a fight.
          if (battle && aiming && inFight.has(s.id)) {
            u.lineStyle(1 * px, s.owned ? 0x9fdcff : 0xf06a5a, s.owned ? 0.28 : 0.2);
            u.lineBetween(x, y, aim._vx ?? aim.x, aim._vy ?? aim.z);
          }
          // Hull and shield bars: in a fight, when hurt recently, or selected.
          if (inFight.has(s.id) || group.has(s.id) || now - (s.damageAt ?? -100) < 6 || s.hull < s.hullMax * 0.999) this.bars(g, s, x, y, size * 0.46, px);
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
          g.lineStyle(2 * px, 0xefbc7f, 0.95); g.strokeCircle(x, y, Math.max(15, shipDiameter(s.cls) * 0.46 + 4) * px);
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
          g.lineStyle(1.6 * px, theme.id === 'ops' ? theme.accent : 0xffe3b0, 0.95);
          g.strokeCircle(sel._vx, sel._vy, Math.max(16, shipDiameter(sel.cls) * 0.46 + 5) * px);
          const t = sel.target && world.get(sel.target);
          if (t && !t.dead && t.sector === sectorId) { g.lineStyle(1 * px, 0xf06a5a, 0.5); g.lineBetween(sel._vx, sel._vy, t._vx ?? t.x, t._vy ?? t.z); }
          this.selLabel.at = () => ({ x: sel._vx, y: sel._vy });
          this.selLabel.dy = -Math.max(26, shipDiameter(sel.cls) * 0.46 + 15);
          this.selLabel.text.setText(sel.name);
        } else if (selected && selected.kind === 'ship') {
          selected = null; describe();        // it died or left
        } else {
          this.selLabel.at = () => null;
        }

        // Focus: keep the chosen ship centred, gently.
        if (follow) {
          const f = world.get(follow);
          if (!f || f.dead || f.sector !== sectorId) follow = null;
          else { const k = Math.min(1, dt * 4), m = cam.midPoint; cam.centerOn(m.x + ((f._vx ?? f.x) - m.x) * k, m.y + ((f._vy ?? f.z) - m.y) * k); }
        }
        // Map labels and supply lines, and markers at the edge for gates off screen.
        this.drawTags(cam, z);
        this.edgeMarkers(cam, z);
        this.drawRoutes(u, px, time, cam, z);

        // Screen-space labels, positioned from world points.
        for (const l of this.labels) {
          const at = l.at();
          if (!at) { l.text.setVisible(false); continue; }
          const sx = (at.x - cam.worldView.x) * z, sy = (at.y - cam.worldView.y) * z + l.dy * dpr;
          l.text.setPosition(sx, sy).setVisible(sx > -100 && sx < this.scale.width + 100 && sy > -40 && sy < this.scale.height + 40);
        }

        this.panelClock = (this.panelClock || 0) + dt;
        if (this.panelClock > 0.4) { this.panelClock = 0; describe(true); renderContacts(); }
        this.miniClock = (this.miniClock || 0) + dt;
        if (this.miniClock > 0.2) { this.miniClock = 0; this.drawMini(); }
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
          if (follow) { follow = null; describe(); }
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
        // Points of interest, then asteroid fields (the open space inside one counts).
        if (!best) {
          const L = SE.Expanse.layout(sectorId);
          for (const site of L.sites) if (Math.hypot(site.x - w.x, site.z - w.y) < Math.max(site.r * 0.8, reach)) best = { kind: 'site', id: site.id };
          if (!best) for (const f of L.fields) if (Math.hypot(f.x - w.x, f.z - w.y) < f.r) best = { kind: 'field', id: f.id };
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
        /* With ships selected, the next tap is an order, fight or no fight:
           open space is a destination, an enemy a target, a station somewhere
           to go (or to attack), a gate a system to go and guard. */
        if (group.size) {
          const ids = [...group], d = host.director;
          const direct = c => {
            const r = d.execute(Object.assign({ type: 'fleet.direct', shipIds: ids }, c));
            if (!r.ok || /route/.test(r.message)) d.shell.toast(r.message, r.ok ? 'info' : 'warn');
            return r.ok;
          };
          if (ship && SE.hostile('player', ship.faction)) {
            if (battle ? host.battles.attack(ids, ship.id) : direct({ kind: 'attack', target: ship.id }))
              marks.push({ x: ship._vx ?? ship.x, y: ship._vy ?? ship.z, t: 0.6, colour: 0xf06a5a });
            describe();
            return;
          }
          if (best && best.kind === 'station') {
            const st = world.get(best.id);
            if (SE.hostile('player', st.faction)) direct({ kind: 'attack', target: st.id });
            else { const p = world.transit.dockPoint(st, world.get(ids[0])); direct({ kind: 'move', x: p.x, z: p.z }); }
            marks.push({ x: st.x, y: st.z, t: 0.6, colour: 0x6fceeb });
            describe();
            return;
          }
          if (best && (best.kind === 'field' || best.kind === 'site')) {
            const L = SE.Expanse.layout(sectorId), spot = (best.kind === 'field' ? L.fields : L.sites).find(x => x.id === best.id);
            if (best.kind === 'field') direct({ kind: 'field', field: spot.id });
            else direct({ kind: 'move', x: spot.x, z: spot.z });
            marks.push({ x: spot.x, y: spot.z, t: 0.6, colour: 0x6fceeb });
            describe();
            return;
          }
          if (best && best.kind === 'gate') {
            if (direct({ kind: 'gate', to: best.to })) { const n = world.transit.layout(sectorId).nodes[world.transit.layout(sectorId).gates[best.to]]; marks.push({ x: n.x, y: n.z, t: 0.6, colour: 0x6fceeb }); group.clear(); }
            describe();
            return;
          }
          if (!best) {
            if (battle) host.battles.move(ids, w.x, w.y); else direct({ kind: 'move', x: w.x, z: w.y });
            marks.push({ x: w.x, y: w.y, t: 0.6, colour: 0x6fceeb });
            describe();
            return;
          }
          // A neutral ship: let go of the group and show it.
          group.clear();
        }
        selected = best;
        describe();
      }
    }
    const _f = { x: 0, y: 0, z: 0 };

    /* ---- The DOM around the canvas ------------------------------------------ */
    // One word for what a facility is doing, for its map chip.
    function facilityChip(p) {
      if (!p) return '';
      const st = p.status || '';
      if (p.online === false || /Suspended/.test(st)) return 'OFFLINE';
      if (/^Needs .*Ore|Waiting for resources/.test(st)) return 'NO ORE';
      if (/Storage full/.test(st)) return 'STORE FULL';
      if (/credits/.test(st)) return 'NO CREDITS';
      return { refinery: 'REFINING', extractor: 'EXTRACTING', solar: 'GENERATING' }[p.kind] || 'WORKING';
    }

    // "Kestrel Gate" is already a gate; "Lowmark" gets one.
    const gateName = to => { const n = SE.SECTOR_BY_ID[to].name.toUpperCase(); return / GATE$/.test(n) ? n : n + ' GATE'; };
    function setWrapBackground() {
      wrap.style.background = `${SE.Presentation.stars}, radial-gradient(ellipse at 18% 12%, #234b6630, transparent 58%), radial-gradient(ellipse at 88% 86%, #493b641b, transparent 52%), radial-gradient(ellipse at 50% 45%, ${theme.bg} 35%, ${theme.bgEdge})`;
    }
    function applyTheme() {
      root.classList.toggle('theme-ops', theme.id === 'ops');
      root.classList.toggle('theme-tac', theme.id === 'tactical');
      for (const b of root.querySelectorAll('[data-sys-mode]')) b.setAttribute('aria-pressed', String(b.dataset.sysMode === theme.id));
      setWrapBackground();
    }
    function setTheme(id) {
      if (!ART.THEMES[id] || theme.id === id) return;
      theme = ART.THEMES[id];
      try { localStorage.setItem('tr.sysTheme', id); } catch (e) { /* not remembered */ }
      applyTheme();
      if (scene && sectorId) scene.build();
      host.director?.shell.renderNav();
    }

    /* "2 contacts detected", or in Tactical "convoy at risk" when a hostile
       is close to one of your miners or freighters. */
    function renderContacts() {
      if (!contactsChip) return;
      let foes = 0, risk = false;
      const list = world.registry.inSector(sectorId);
      const haulers = list.filter(s => s.owned && !s.dead && (SE.CLASSES[s.cls].miner || s.cls === 'freighter'));
      for (const s of list) {
        if (s.dead || SE.isStatic(SE.CLASSES[s.cls]) || !SE.hostile('player', s.faction)) continue;
        foes++;
        if (haulers.some(h => Math.hypot(h.x - s.x, h.z - s.z) < 700)) risk = true;
      }
      const text = theme.id === 'tactical' && risk ? 'CONVOY AT RISK' : foes ? `${foes} ${foes === 1 ? 'CONTACT' : 'CONTACTS'} DETECTED` : '';
      contactsChip.classList.toggle('on', !!text);
      contactsChip.classList.toggle('risk', theme.id === 'tactical' && risk);
      if (contactsChip.dataset.text !== text) { contactsChip.dataset.text = text; contactsChip.innerHTML = text ? '<b>!</b><span>' + text + '</span>' : ''; }
    }
    function summary() {
      let mine = 0, foe = 0, other = 0;
      for (const s of world.registry.inSector(sectorId)) {
        if (s.dead || SE.isStatic(SE.CLASSES[s.cls])) continue;
        if (s.owned) mine++; else if (SE.hostile('player', s.faction)) foe++; else other++;
      }
      return { mine, foe, other };
    }

    /* The selected ship, as the reference's bottom card: hull art in a frame,
       name and what it is doing, cargo and its route in Operations, shield
       and hull in Tactical, and the two or three things you would do next. */
    const svg = d => `<svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ICONS = {
      route: svg('M5 19a2 2 0 1 0 0-.01M19 5a2 2 0 1 0 0-.01M7 17 17 7M13 7h4v4'),
      focus: svg('M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14M12 2v5M12 17v5M2 12h5M17 12h5'),
      escort: svg('M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 8 1 8 5'),
      evade: svg('M5 5l7 7-7 7M12 5l7 7-7 7'),
      hold: svg('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z')
    };
    function shipCard(s) {
      const d = host.director, cls = SE.CLASSES[s.cls], tac = theme.id === 'tactical';
      const mine = s.owned && !s.isPlayer, hostile = SE.hostile('player', s.faction);
      const place = id => SE.SECTOR_BY_ID[id].name;
      const status = s.owned && d ? d.shell.shipStatus(s) : orderText(s);
      const hold = Math.floor(SE.cargoUsed(s));
      const route = d && d.scene.freight.routeOf(s.id);
      const art = `<div class="sc-art${hostile ? ' foe' : ''}"><img src="${SE.ShipArt.icon(s.cls, SE.FACTIONS[s.faction] ? s.faction : 'apex', theme.id)}" alt=""></div>`;
      let goods = '';
      if (route) {
        const to = route.to.kind === 'yard' ? place(route.to.sector) + ' yard' : route.to.kind === 'industry' ? 'your works in ' + place(route.to.sector) : place(route.to.sector) + ' market';
        goods = `<span class="sc-good">${esc(SE.GOODS[route.good].name)}</span><span>${esc(place(route.from))} → ${esc(to)}</span>`;
      } else if (cls.miner && s.duty === 'mine' && s.mineAt) {
        const st = world.get('st_' + s.mineAt);
        goods = `<span class="sc-good">${esc(SE.GOODS.ore.name)}</span><span>${esc(place(s.mineAt))} belt → ${esc(st && !SE.hostile('player', st.faction) ? st.name : 'nearest market')}</span>`;
      }
      const cargo = !tac && s.cargoMax >= 50 ? `<div class="sys-bar sc-cargo"><span>CARGO</span><i><b style="width:${Math.min(100, hold / s.cargoMax * 100)}%"></b></i><em>${hold} / ${s.cargoMax}</em></div>` : '';
      const pct = (label, v, max, c) => `<div class="sys-bar ${c}"><span>${label}</span><i><b style="width:${Math.max(0, Math.min(100, v / Math.max(1, max) * 100))}%"></b></i><em>${Math.max(0, Math.round(v / Math.max(1, max) * 100))}%</em></div>`;
      const bars = tac || !mine || s.hull < s.hullMax - 0.5 ? `<div class="sc-bars">${s.shieldMax ? pct('SHIELDS', s.shield, s.shieldMax, 'shield') : ''}${pct('HULL', s.hull, s.hullMax, 'hull')}</div>` : '';
      const escorts = mine ? (d ? d.fleet : []).filter(x => !x.dead && x.commanderId === s.id && x.duty === 'escort') : [];
      const kicker = `${s.owned ? (s.isPlayer ? 'FLAGSHIP' : 'YOUR FLEET') : hostile ? 'HOSTILE' : 'NEUTRAL'} · ${esc(((SE.FACTIONS[s.faction] || {}).short || s.faction).toUpperCase())} · ${esc(cls.name.toUpperCase())}`;
      const sub = tac && mine ? `${esc(cls.name)} · ${escorts.length ? 'Escorted by ' + esc(escorts.map(x => x.name).join(', ')) : 'No escort'}` : esc(status);
      const btn = (label, attrs, kind = '', icon = '') => `<button type="button" class="button sc-btn ${kind}" ${attrs}>${icon ? ICONS[icon] : ''}${label}</button>`;
      const hauler = cls.miner || s.cls === 'freighter';
      const focusBtn = btn(follow === s.id ? 'Unfocus' : 'Focus', `data-sys-cmd="focus" data-id="${s.id}"`, '', 'focus');
      let acts = '';
      if (mine && tac) {
        acts = (hauler ? btn('Assign escort', `data-sys-cmd="escort" data-id="${s.id}"`, 'primary', 'escort') : btn('Engage nearest', 'data-sys-cmd="nearest"', 'primary', 'focus'))
          + btn('Evade', `data-sys-cmd="evade" data-id="${s.id}"`, '', 'evade')
          + btn('Hold', `data-action="order" data-value="${s.id}:hold"`, s.duty === 'hold' ? 'on' : '', 'hold');
      } else if (mine) {
        const primary = s.cargoMax >= 100 ? btn(route ? 'Change route' : 'Freight route', `data-action="sys-route" data-value="${s.id}"`, 'primary', 'route')
          : cls.miner ? btn(s.duty === 'mine' ? 'Stop mining' : 'Mine here', `data-action="order" data-value="${s.id}:${s.duty === 'mine' ? 'hold' : 'mine'}"`, 'primary', 'route')
          : btn(s.duty === 'patrol' ? 'Escort flagship' : 'Guard here', `data-action="order" data-value="${s.id}:${s.duty === 'patrol' ? 'escort' : 'patrol'}"`, 'primary', 'escort');
        acts = primary + focusBtn;
      } else if (s.isPlayer) {
        acts = btn('Send fleet', 'data-action="sys-map"', 'primary', 'route') + focusBtn;
      } else {
        acts = focusBtn;
      }
      // Every job, small, under the card (Operations): the full list the Fleet tab has.
      let jobs = '';
      if (mine && !tac) {
        const on = role => (s.duty || 'escort') === role ? ' on' : '';
        const j = (label, role, off) => `<button class="fl-job sc-job${on(role)}" data-action="order" data-value="${s.id}:${role}" ${off ? 'disabled' : ''}>${label}</button>`;
        jobs = `<div class="sc-jobs">${j('Escort', 'escort')}${j('Guard', 'patrol')}${cls.miner ? j('Mine', 'mine', !SE.SECTOR_BY_ID[s.sector].belt) : ''}${j('Hold', 'hold')}${s.hull < s.hullMax - 0.5 ? j('Repair', 'repair') : ''}</div>`;
      }
      const hint = s.owned ? '<p class="sys-hint sc-hint">Tap the map to move · an enemy to attack · a station or gate to send it there. Tap more of your ships to add them.</p>' : '';
      return hint + `<div class="sc ${tac ? 'tac' : 'ops'}">${art}<div class="sc-main">${s.owned ? '' : `<div class="sys-kicker">${kicker}</div>`}<h3>${esc(s.name)}</h3><p class="sc-doing">${sub}</p>${cargo}${goods && !tac ? `<p class="sc-goods">${goods}</p>` : ''}${tac ? bars : ''}</div><div class="sc-acts">${acts}</div></div>${!tac ? bars : ''}${jobs}`;
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
          : st.phase === 'outside' ? `Too far from the station · bring warships within ${(st.range / 1000).toFixed(1)} km`
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
    const iconFor = ship => `<img class="sv-ico" src="${SE.ShipArt.icon(ship.cls, ship.faction, theme.id)}" alt="">`;
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
        ${battle ? targetChips() : '<p class="sys-doing">Tap the map to move them · an enemy to attack · a station or gate to send them there. Tap a ship again to deselect.</p>'}
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
      if (sec.belt) { const n = SE.Expanse.layout(sectorId).fields.length; chips.push('◌ ' + n + ' asteroid field' + (n === 1 ? '' : 's')); }
      { const n = SE.Expanse.layout(sectorId).sites.length; if (n) chips.push('◇ ' + n + ' point' + (n === 1 ? '' : 's') + ' of interest'); }
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
    let follow = null;              // ship id the camera keeps centred (Focus)
    // The header's money and controls, after the reference: credits, income, pause, speed.
    const headCredits = document.getElementById('sys-credits'), headIncome = document.getElementById('sys-income');
    const headPace = document.getElementById('sys-pace'), headPause = document.getElementById('sys-pause');
    function renderHeader() {
      const d = host.director;
      if (!d) return;
      const cr = Reach.credits(world.credits);
      if (headCredits.textContent !== cr) headCredits.textContent = cr;
      const actual = d.actualIncome, rate = actual ?? d.incomePerMinute;
      const inc = rate ? (actual === null ? '~' : '') + (rate > 0 ? '+' : '') + Reach.credits(rate) + ' cr/min' : '';
      if (headIncome.textContent !== inc) headIncome.textContent = inc;
      const pace = (host.pace || 1) + '× <span aria-hidden="true">▾</span>';
      if (headPace.innerHTML !== pace) headPace.innerHTML = pace;
      headPause.setAttribute('aria-pressed', String(!!host.frozen));
      headPause.classList.toggle('on', !!host.frozen);
    }

    function describe(soft) {
      if (!sectorId) return;
      const c = summary();
      census.textContent = `${c.mine} yours · ${c.foe} hostile · ${c.other} other`;
      renderHeader();
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
        html = shipCard(s);
      } else if (selected && selected.kind === 'station') {
        const st = world.get(selected.id);
        const friendly = st && !SE.hostile('player', st.faction);
        const here = st && st.sector === world.sectorId && !host.course;
        html = `<div class="sys-kicker">${esc((SE.FACTIONS[st.faction] || {}).name || '')} · STATION</div><h3>${esc(st.name)}</h3>
          <p class="sys-doing">${esc(d && d.economy ? d.economy.profile(st).name : '')}</p>
          ${bar('SHIELD', st.shield, st.shieldMax, 'shield')}
          <div class="sys-actions">${friendly && here ? '<button class="button primary" data-action="context">Dock</button>' : `<span class="sys-note">${friendly ? 'Bring your fleet here to dock.' : siegeNote(st)}</span>`}${!friendly || st.faction === 'player' ? '' : '<button class="button" data-action="panel" data-value="factions">War &amp; peace</button>'}</div>`;
      } else if (selected && (selected.kind === 'site' || selected.kind === 'field')) {
        const L = SE.Expanse.layout(sectorId), spot = (selected.kind === 'field' ? L.fields : L.sites).find(x => x.id === selected.id);
        const near = world.registry.inSector(sectorId).filter(x => !x.dead && !SE.isStatic(SE.CLASSES[x.cls]) && Math.hypot(x.x - spot.x, x.z - spot.z) < spot.r + 400);
        const foes = near.filter(x => SE.hostile('player', x.faction)).length, mine = near.filter(x => x.owned).length;
        const blurb = selected.kind === 'field'
          ? `Asteroid field · ${spot.rich > 1.1 ? 'rich' : spot.rich < 0.9 ? 'thin' : 'average'} ore. Select a miner, then tap the field to work it.`
          : { derelict: 'A dead capital ship drifting far from the lanes.', debris: 'Wreckage from old fights, spread over a wide area.', nebula: 'A pocket of glowing gas, far out from the station.' }[spot.kind] + ' Galaxy events in this system happen at its points of interest.';
        html = `<div class="sys-kicker">${selected.kind === 'field' ? 'ASTEROID FIELD' : 'POINT OF INTEREST · ' + esc(spot.code)}</div><h3>${esc(spot.name)}</h3>
          <p class="sys-doing">${esc(blurb)}</p><p class="sys-hint">${mine ? mine + ' of your ships here · ' : ''}${foes ? foes + ' hostile' + (foes === 1 ? '' : 's') + ' here · ' : ''}Select your ships, then tap it to send them.</p>`;
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
    function ensureGame() {
      setWrapBackground();
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
      follow = null;
      group.clear();
      result = null;
      lastPanel = '';
      prev.clear();
      shots.length = 0;
      onTick();
      const sec = SE.SECTOR_BY_ID[id];
      title.textContent = sec.name;
      sub.textContent = sec.owner === 'player' ? 'YOUR CHARTER' : sec.owner ? (SE.FACTIONS[sec.owner].short || sec.owner).toUpperCase() + ' TERRITORY' : 'UNCLAIMED FRONTIER';
      sub.style.color = sec.owner ? '#' + colourOf(sec.owner).toString(16).padStart(6, '0') : '';
      root.classList.add('on');
      document.body.classList.add('sys-open');
      // Nothing to see under a full-screen view, and composited anyway if shown.
      document.getElementById('galaxy').style.visibility = 'hidden';
      if (!game) ensureGame();
      else { game.loop.wake(); resize(); if (scene) scene.build(); }
      describe();
      host.director?.shell.renderNav();
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
      host.director?.shell.renderNav();
    }

    // Back (and Escape) leaves the view before anything else hears it.
    window.addEventListener('keydown', ev => {
      if (sectorId && ev.code === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); close(); host.director && host.director.resume(); }
    }, true);

    mini.addEventListener('pointerdown', ev => {
      if (!scene || !sectorId) return;
      ev.stopPropagation();
      const r = mini.getBoundingClientRect(), span = SE.Transit.rules.gate + 700;
      // The overview is direct positioning, so it must not lag behind another pan.
      scene.panTo((ev.clientX - r.left) / r.width * span * 2 - span, (ev.clientY - r.top) / r.height * span * 2 - span, undefined, true);
      follow = null;
    });
    applyTheme();
    root.addEventListener('click', ev => {
      const mode = ev.target.closest('[data-sys-mode]');
      if (mode) { setTheme(mode.dataset.sysMode); return; }
      const cmd = ev.target.closest('[data-sys-cmd]');
      if (cmd && sectorId) {
        const B = host.battles, ids = [...group];
        switch (cmd.dataset.sysCmd) {
          case 'pause': setFrozen(!host.frozen); break;
          case 'all':
            for (const s of world.registry.inSector(sectorId)) if (s.owned && !s.dead) group.add(s.id);
            result = null; selected = null; break;
          case 'clear': group.clear(); break;
          case 'focus': follow = follow === cmd.dataset.id ? null : cmd.dataset.id; break;
          case 'escort':
          case 'evade': {
            const r = host.director.execute({ type: cmd.dataset.sysCmd === 'escort' ? 'fleet.escort' : 'fleet.evade', shipId: cmd.dataset.id });
            host.director.shell.toast(r.message, r.ok ? 'info' : 'warn');
            break;
          }
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
      else if (a === 'jump') scene.jumpTo(b.dataset.what);
      else if (a === 'gate') { const layout = world.transit.layout(sectorId), n = layout.nodes[layout.gates[b.dataset.to]]; if (n) scene.panTo(n.x, n.z); }
    });

    return {
      open, close, onTick, onShot,
      _scene: () => scene,           // for the test harness
      get open_() { return !!sectorId; },
      get sector() { return sectorId; },
      get theme() { return theme.id; },
      // Select a ship as a tap would (the test harness and tutorials use this).
      select(id) { const s = world.get(id); if (!s || !sectorId) return; group.clear(); result = null; if (s.owned) { group.add(id); selected = null; } else selected = { kind: 'ship', id }; describe(); },
      setTheme,
      refresh() { if (sectorId) describe(); }
    };
  }

  SE.SystemView = SystemView;
})(window.SE = window.SE || {});
