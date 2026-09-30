/* The sector: where the arithmetic grows a body.
 *
 * Everything above this file is renderer-agnostic. This is the one place that
 * knows about Three.js, Ammo and Phaser at the same time, and its whole job is
 * to keep the two halves of the game honest with each other:
 *
 *   - ships in this sector get a ShipPhysicsView, are stepped by Ammo, and
 *     have their transforms pulled back into their ShipState every frame
 *   - ships anywhere else are ticked as arithmetic by world.tickOOS
 *   - both are driven by the same ai.js
 *
 * The update order below is not arbitrary. Intent is decided from last frame's
 * state, applied as force, stepped by the physics engine, and only then pulled
 * back — so nothing in a frame ever reads a transform that is half-updated.
 */
(function (SE) {
  'use strict';

  const E = window.ENABLE3D;
  const THREE = E.THREE;

  const OOS_STEP = 0.25;      // out-of-sector ticks, seconds
  const AUTOSAVE = 25;        // seconds between autosaves
  const BLOOM_SCALE = 0.5;    // bloom is blur; half resolution is free-looking

  /* The display ratio, capped at 2 — and the cap is the one number here worth
     arguing about.
     Rivenmark caps at 3 and is right to: it is 2D sprite work where the fill
     rate is nearly free, so there is no reason not to take every pixel the
     screen has. This is a 3D scene with a five-level bloom pyramid over the
     whole frame, where cost goes as the SQUARE of the ratio. Three is nine
     times the fill rate of one; two is four. Measured here, rendering at 3
     took the software rasteriser to 0.8 fps.
     Two is where the argument lands because the eye stops being the limit
     first: 1 to 2 is the difference between a stretched image and a sharp
     one, and 2 to 3 is a difference almost nobody can see on a phone held at
     arm's length, bought at more than twice the price. */
  function dpr() { return Math.max(1, Math.min(2, window.devicePixelRatio || 1)); }
  SE.dpr = dpr;
  const GATE_R = 120;         // how close to a lane mouth counts as "in the gate"
  const JUMP_SPOOL = 4.0;     // seconds the drive takes to charge, uninterrupted

  /* Move `cur` toward `want` at a fixed rate, taking `up` seconds to cross the
     full -1..1 range when the magnitude is growing and `down` when it is
     shrinking. Rate-limited rather than exponential on purpose: an exponential
     chase never actually arrives, so full stick would never quite be full
     rate, and the last few percent would drift in over a second of holding. */
  function spool(cur, want, dt, up, down) {
    const growing = Math.abs(want) > Math.abs(cur) && want * cur >= 0;
    const step = dt / (growing ? up : down);
    const d = want - cur;
    if (Math.abs(d) <= step) return want;
    return cur + (d > 0 ? step : -step);
  }

  class SectorScene extends E.Scene3D {
    constructor() { super({ key: 'Sector' }); }

    init() {
      /* maxSubSteps caps how much time Ammo will advance in one call:
         4 x 1/60 is 66ms, so on a frame that took longer than that, physics
         silently fell behind real time. At nine frames a second — which is
         what a phone was actually getting — that alone put the world into
         slow motion, and slow motion is indistinguishable from unresponsive
         controls. Twelve sub-steps covers a 200ms frame, i.e. down to 5fps. */
      this.accessThirdDimension({ gravity: { x: 0, y: 0, z: 0 }, maxSubSteps: 12, fixedTimeStep: 1 / 60 });
    }

    create() {
      this.loading = true;
      const third = this.third;
      this.motionClock = new SE.FixedClock(1 / 60, 12);
      this._physicsStep = third.physics.update.bind(third.physics);
      this._simulate = dt => this.simulate(dt);
      // enable3d invokes this adapter in postupdate. It is the sole clock owner;
      // the captured engine step is called exactly once per fixed simulation tick.
      third.physics.update = () => this.advanceFrame(this._frameSeconds || 0);
      this._frameSeconds = 0;
      third.physics.setGravity(0, 0, 0);
      third.scene.background = new THREE.Color(0x04060c);
      // Fog hides the far edge of the belt without a cutoff plane, and on a
      // phone it is also the cheapest depth cue available.
      // The far plane of the fog and the belt's cull radius are the same
      // number on purpose: a rock reaches the background colour at exactly the
      // distance it stops being drawn, so the window has no visible edge.
      third.scene.fog = new THREE.Fog(0x04060c, 420, 1500);

      third.camera.near = 0.6;
      third.camera.far = 4200;
      third.camera.updateProjectionMatrix();

      /* Lit to match the concept art, which is studio lighting rather than
         deep space: a strong key from the front-left, a cold rim from behind,
         and — the part that matters — a HEMISPHERE rather than a flat ambient.
         A flat dark-blue ambient meant every surface facing away from the key
         collapsed to near-black, so a slate-grey military hull and a navy one
         came out the same colour, and a palette that identifies a faction by
         its hull cannot afford that. The hemisphere keeps the underside dark
         while letting the tops of things actually be the colour they are. */
      third.lights.hemisphereLight({ skyColor: 0x9fb4d4, groundColor: 0x232a3d, intensity: 0.95 });
      const key = third.lights.directionalLight({ color: 0xfff2e2, intensity: 1.25 });
      key.position.set(-420, 300, 180);
      const rim = third.lights.directionalLight({ color: 0x4a7dff, intensity: 0.55 });
      rim.position.set(300, -160, -280);

      this.buildStarfield();
      this.scenery = SE.Scenery(third, E);
      this.buildPostChain();

      this.world = SE.populate(SE.World(window.SE_SEED || 'tarpon-1'));
      this.world.onSay = m => this.say(m);
      this.views = Object.create(null);
      this.oosAcc = 0;
      this.saveAcc = 0;
      this.hudAcc = 0;
      this.playerTarget = null;
      this.mineNode = -1;
      this.dead = false;

      this.combat = SE.Combat(third, E, {
        onHit: (t, sh) => this.onHit(t, sh),
        onSalvage: (s, good, qty) => {
          this.world.events.emit({ type: 'salvage', ship: s, good, quantity: qty });
          if (s.isPlayer) this.say('TRACTOR +' + Math.round(qty) + ' ' + good.toUpperCase());
        }
      });

      this.radar = SE.Radar(this, {
        centre: () => this.world.player || { x: 0, y: 0, z: 0 },
        heading: () => this.heading,
        ships: () => this.world.registry.inSector(this.world.sectorId),
        corridors: () => this.world.transit.layout(this.world.sectorId),
        get: id => this.world.get(id),
        node: i => this.world.belt ? this.world.belt.node(i) : null,
        nearestOre: (x, y, z) => this.world.belt ? this.world.belt.nearestOre(x, y, z, 2400) : null,
        station: () => this.world.iface(this.world.sectorId).stationFor(this.world.player),
        target: () => this.playerTarget,
        gate: () => { const l = this.nextLeg(); return l ? l.exit : null; },
        setTarget: id => { this.playerTarget = id; },
        say: m => this.say(m)
      });

      this.controls = SE.Controls(this, {
        radarTap: (x, y) => this.radar.handleTap(x, y),
        viewTap: (x, y) => this.viewTap(x, y)
      });

      this.heading = 0;
      this.buildSight();
      this._camFwd = new THREE.Vector3(0, 0, -1);
      this.cameraRig = new SE.OrbitCamera();
      this._collectors = [];
      // Scratch for the flight model and the gunsight. Both run every frame,
      // and a fresh Vector3 per axis per frame is 240 allocations a second.
      this._q = new THREE.Quaternion();
      this._right = new THREE.Vector3();
      this._up = new THREE.Vector3();
      this._fwd = new THREE.Vector3();
      this._proj = new THREE.Vector3();
      this._lead = new THREE.Vector3();
      this.buildMiningBeam();
      this.buildGate();

      this.galaxy = SE.Galaxy({
        here: () => this.world.sectorId,
        ships: id => this.world.registry.inSector(id),
        courseTo: () => this.course ? this.course.to : null
      });
      this.course = null;        // { to } — the far end, not the next leg
      this.charge = 0;           // seconds the drive has been spooling

      this.missions = SE.Missions(this.world);
      // The world raises kills; the board decides whether any of them were
      // worth money. Routed through here rather than called from combat so
      // that out-of-sector attrition counts the same as a kill you watched.
      this.world.onOOSKill = (v, k) => this.missions.onKill(v, k);
      this.world.onEscortSpawn = ship => { if (ship.sector === this.world.sectorId) this.attach(ship); };
      this.world.onJump = ship => {
        // State already contains the arrival transform: pulling the departed body would undo it.
        const view = this.views[ship.id];
        if (view) { view.destroy(); delete this.views[ship.id]; }
        if (ship.sector === this.world.sectorId) this.attach(ship);
      };

      this.dock = SE.Dock({
        player: () => this.world.player,
        priceAt: (id, g) => this.world.priceAt(id, g),
        sell: (st, g) => this.world.iface(this.world.sectorId).trade(this.world.player, st, g),
        credits: () => this.world.credits,
        buy: id => this.buyModule(id),
        unfit: id => this.unfitModule(id),
        board: st => this.missions.board(st),
        accept: m => this.missions.accept(m),
        deliver: st => this.missions.onDock(st, this.world.player),
        contracts: () => this.missions.active,
        say: m => this.say(m)
      });

      this.enterSector('home');

      this.persist = SE.Persistence();
      this.wireDom();
      this.wireSaveOnExit();
      this.restore().then(() => {
        this.loading = false;
        this.director = new SE.Director(this);
        this.chase(this.world.player, 1);
        window.SE_READY = true;
        this.events.once('shutdown', () => {
          this.director.dispose(); this.controls.destroy(); this.persist.destroy();
          this.combat.destroy(); this.scenery.dispose(); this.transitView?.destroy();
        });
      }).catch(error => {
        this.loading = true;
        document.getElementById('bootmsg').textContent = 'COMMANDER FILE NEEDS ATTENTION';
        const node = document.getElementById('boot-error');
        node.textContent = error.message; node.classList.remove('hidden');
        document.getElementById('boot-retry').classList.remove('hidden');
      });
    }

    /* ---- Scenery -------------------------------------------------------
       Stars are one Points object with a flat material: three thousand of them
       cost one draw and no lighting. They sit on a sphere that follows the
       camera, so they never get closer — which is the only property of a star
       that matters at this range. */
    /* ---- Post-processing -------------------------------------------------
       Bloom, and it is not a flourish. Every drive, window and neon strip in
       the concept art bleeds light into the pixels around it, and that bleed
       is most of what makes those images read as photographs of something hot
       rather than as diagrams. A MeshBasicMaterial at full brightness with
       hard edges looks like a sticker; the same material under a threshold
       bloom looks like it is emitting.

       Threshold sits above every lit hull tone and below the glow bucket, so
       only the things that ARE light bloom, and a white Apex hull does not
       turn into a lamp.

       OutputPass is mandatory rather than optional: once a composer is in the
       chain the renderer stops doing its own sRGB conversion, and without a
       pass that does it instead the entire game renders dark and desaturated.
    */
    buildPostChain() {
      const third = this.third;
      const size = third.renderer.getSize(new THREE.Vector2());

      /* The composer gets a MULTISAMPLED target, and this is the second half
         of the "pixelated" complaint.
         Asking Phaser for `antialias: true` gets MSAA on the DEFAULT
         framebuffer — and the moment an EffectComposer exists, the scene is
         no longer drawn to the default framebuffer. It goes to the composer's
         own render target, which has no samples, so every edge in the game
         was hard-aliased no matter what the context was asked for. Adding
         bloom silently turned antialiasing off.
         Four samples is the usual sweet spot: it removes the staircase on the
         long straight edges this art direction is made of, and 8 costs more
         bandwidth than it buys on a phone. */
      const samples = third.renderer.capabilities.isWebGL2 ? 4 : 0;
      const target = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        samples: samples
      });
      const composer = new E.EffectComposer(third.renderer, target);
      composer.addPass(new E.RenderPass(third.scene, third.camera));
      // Bloom runs at half resolution. It is a five-level gaussian pyramid over
      // the whole frame, which is the most expensive thing in the renderer by
      // some distance, and it is also blur — the one effect where throwing away
      // half the resolution costs almost nothing you can see. Full-res bloom
      // took a third of the frame here; half-res is a quarter of that.
      const bloom = new E.UnrealBloomPass(size.clone().multiplyScalar(BLOOM_SCALE), 0.62, 0.72, 0.86);
      composer.addPass(bloom);
      composer.addPass(new E.OutputPass());
      third.composer = composer;
      this.bloom = bloom;
      this.scale.on('resize', s => {
        composer.setSize(s.width, s.height);
        bloom.setSize(s.width * BLOOM_SCALE, s.height * BLOOM_SCALE);
      });
    }

    buildStarfield() {
      const rng = SE.Rng('stars');
      const N = 1500;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const p = rng.onSphere(3200);
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        const warm = rng.float(0.55, 1);
        c.setHSL(rng.float(0.52, 0.66), rng.float(0.05, 0.45), rng.float(0.45, 0.95) * warm);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.stars = new THREE.Points(g, new THREE.PointsMaterial({
        size: 1.1 * dpr(), sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, transparent: true, opacity: 0.65
      }));
      this.stars.frustumCulled = false;
      this.third.scene.add(this.stars);
    }

    /* ---- The gunsight ----------------------------------------------------
       There was none, which on a ship with fixed forward guns means you are
       aiming by guessing where the nose is. Three things, in the order they
       matter:

       THE PIPPER. A point projected a long way down the nose and drawn where
       it lands on screen. That is literally where rounds go, and because the
       chase camera trails and swings it is NOT the middle of the screen —
       which is exactly why guessing did not work.

       THE BOX. Whatever is targeted, with its range, so a tap on the radar has
       a visible consequence in the world.

       THE LEAD PIP. Rounds take time to arrive. This is where the target will
       be when they do, accounting for the target's velocity and for the fact
       that shots inherit the shooter's. Aim the pipper at the pip and you hit;
       without it, hitting anything crossing is luck.
    */
    buildSight() {
      // Scaled by the display ratio like the rest of the 2D layer, so a
      // 9-pixel pipper stays a 9-pixel pipper and is drawn with 27 real ones.
      const S = dpr();
      this.sightRoot = this.add.container(0, 0).setScale(S).setDepth(8);
      this.sight = this.add.graphics();
      this.sightTxt = this.add.text(0, 0, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '10px', color: '#ff9d9d'
      }).setVisible(false);
      this.sightRoot.add(this.sight);
      this.sightRoot.add(this.sightTxt);
    }

    /* World point to CSS pixels. Returns null when the point is behind the
       camera, where projection maths gives a confident and completely wrong
       answer on the opposite side of the screen.
       CSS and not device pixels, because everything that consumes this draws
       inside the ratio-scaled container — handing it device pixels would put
       the pipper at three times the distance from the corner. */
    toScreen(v3) {
      const cam = this.third.camera;
      this._proj.copy(v3).project(cam);
      if (this._proj.z > 1) return null;
      const S = dpr();
      const W = this.scale.width / S, H = this.scale.height / S;
      return { x: (this._proj.x + 1) / 2 * W, y: (-this._proj.y + 1) / 2 * H };
    }

    drawSight() {
      const g = this.sight;
      g.clear();
      this.sightTxt.setVisible(false);
      const me = this.world.player;
      if (!me || me.dead) return;

      const q = this._q.set(me.qx, me.qy, me.qz, me.qw);
      const fwd = this._fwd.set(0, 0, -1).applyQuaternion(q);
      const cls = SE.CLASSES[me.cls];
      const wep = SE.WEAPONS[cls.weapon];

      // the pipper, out at the guns' effective range
      const aim = this._lead.set(me.x + fwd.x * wep.range, me.y + fwd.y * wep.range, me.z + fwd.z * wep.range);
      const p = this.toScreen(aim);
      if (p) {
        g.lineStyle(1.4, 0xff8a8a, 0.9);
        g.strokeCircle(p.x, p.y, 9);
        g.lineStyle(1.2, 0xff8a8a, 0.75);
        g.lineBetween(p.x - 17, p.y, p.x - 11, p.y).lineBetween(p.x + 11, p.y, p.x + 17, p.y);
        g.lineBetween(p.x, p.y - 17, p.x, p.y - 11).lineBetween(p.x, p.y + 11, p.x, p.y + 17);
        g.fillStyle(0xff8a8a, 0.9).fillCircle(p.x, p.y, 1.5);
      }

      const tgt = this.playerTarget ? this.world.get(this.playerTarget) : null;
      if (!tgt || tgt.dead) return;

      const dx = tgt.x - me.x, dy = tgt.y - me.y, dz = tgt.z - me.z;
      const dist = Math.hypot(dx, dy, dz);
      const tp = this.toScreen(this._lead.set(tgt.x, tgt.y, tgt.z));
      if (tp) {
        // Box scaled by how big the target actually is on screen, so a
        // dreadnought at 600m does not get the same bracket as an interceptor.
        const size = Math.max(9, Math.min(64, SE.CLASSES[tgt.cls].size * 900 / Math.max(60, dist)));
        const hostile = SE.hostile('player', tgt.faction);
        const col = hostile ? 0xff5d5d : 0x3fe0c8;
        g.lineStyle(1.4, col, 0.95);
        const h = size;
        for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          g.lineBetween(tp.x + ox * h, tp.y + oy * h, tp.x + ox * h * 0.45, tp.y + oy * h);
          g.lineBetween(tp.x + ox * h, tp.y + oy * h, tp.x + ox * h, tp.y + oy * h * 0.45);
        }
        /* Moving the label is free. Changing its TEXT is not: Phaser redraws a
           Text object into its own canvas and re-uploads it to the GPU on
           every setText, and the range in this label changes every single
           frame. Written naively it re-rendered a texture sixty times a second
           for a number whose last digit nobody can read at that rate — enough
           to make the whole page too slow to screenshot. Position tracks the
           target every frame; the string is rebuilt a few times a second, and
           only when it actually differs. */
        this.sightTxt.setPosition(tp.x + h + 5, tp.y - h).setVisible(true);
        this.sightAcc = (this.sightAcc || 0) + 1;
        if (this.sightAcc >= 8) {
          this.sightAcc = 0;
          const label = tgt.name.toUpperCase() + '\n' + Math.round(dist / 10) * 10 + 'm';
          if (label !== this._sightLabel) {
            this._sightLabel = label;
            this.sightTxt.setText(label).setColor(hostile ? '#ff9d9d' : '#8ff3e4');
          }
        }
      }

      // the lead pip
      const flight = dist / wep.speed;
      if (flight < wep.life && dist < wep.range * 1.3) {
        const lx = tgt.x + (tgt.vx - me.vx) * flight;
        const ly = tgt.y + (tgt.vy - me.vy) * flight;
        const lz = tgt.z + (tgt.vz - me.vz) * flight;
        const lp = this.toScreen(this._lead.set(lx, ly, lz));
        if (lp && tp) {
          g.lineStyle(1, 0xffd166, 0.5).lineBetween(tp.x, tp.y, lp.x, lp.y);
          g.lineStyle(1.6, 0xffd166, 0.95).strokeCircle(lp.x, lp.y, 5.5);
          g.fillStyle(0xffd166, 0.85).fillCircle(lp.x, lp.y, 1.6);
        }
      }
    }

    buildMiningBeam() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this.beam = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.85 }));
      this.beam.frustumCulled = false;
      this.beam.visible = false;
      this.third.scene.add(this.beam);
    }

    /* ---- The jump drive -------------------------------------------------
       Everything under here existed already except the player's half of it.
       The galaxy graph, A* across it, the lane exits and the sector transfer
       have been running since the first build — out-of-sector freighters use
       them dozens of times an hour. The only thing missing was that the one
       ship with a person in it could not leave.

       So this is not a travel system. It is a door onto one.
    */
    buildGate() {
      /* Something to fly AT. A course with no marker is a course you navigate
         by reading a distance off the HUD and guessing, which is not flying.
         One group, two rings, and it is only in the scene while a course is
         set — a permanent gate in every sector would be scenery you learn to
         stop seeing. */
      const THREE = E.THREE;
      const grp = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(108, 2.2, 8, 40),
        new THREE.MeshBasicMaterial({ color: 0x3fe0c8, transparent: true, opacity: 0.55 }));
      const inner = new THREE.Mesh(
        new THREE.TorusGeometry(101, 0.8, 6, 32),
        new THREE.MeshBasicMaterial({ color: 0xeafffb, transparent: true, opacity: 0.35 }));
      grp.add(ring); grp.add(inner);
      grp.visible = false;
      grp.frustumCulled = false;
      this.gate = grp; this.gateRing = ring; this.gateInner = inner;
      this.third.scene.add(grp);
    }

    /* Plot a course to a sector anywhere on the graph. Only the FAR END is
       stored: the next leg is re-derived from wherever the ship actually is,
       so a course survives being blown off route, and arriving somewhere
       unplanned re-plans instead of breaking. */
    setCourse(to) {
      if (!to || to === this.world.sectorId) { this.clearCourse(); return; }
      this.course = { to };
      this.charge = 0;
      const path = SE.route(this.world.sectorId, to);
      this.say('COURSE ' + SE.SECTOR_BY_ID[to].name.toUpperCase() +
        ' — ' + (path.length - 1) + ' JUMP' + (path.length === 2 ? '' : 'S'));
    }

    clearCourse() {
      this.course = null;
      this.charge = 0;
      if (this.gate) this.gate.visible = false;
      if (this.dom && this.dom.jump) this.dom.jump.classList.remove('on');
    }

    // The next hop, and where in this sector its lane mouth is.
    nextLeg() {
      if (!this.course) return null;
      const here = this.world.sectorId;
      if (this.course.to === here) return null;
      const path = SE.route(here, this.course.to);
      if (!path || path.length < 2) return null;
      const leg = path[1];
      const exit = this.world.iface(here).laneExit(here, leg);
      return exit ? { leg, exit, hops: path.length - 1 } : null;
    }

    /* Charging, and what stops it.

       The drive spools only while the ship is inside the gate and only while
       nothing is hurting it. That second rule is the whole of interdiction in
       this build: a pirate sitting on a lane mouth cannot stop you flying, but
       it can stop you LEAVING — which is the pressure the brief wants from
       interdiction, without a separate system rolling dice to produce it. */
    stepJump(dt) {
      const leg = this.nextLeg();
      const me = this.world.player;
      const dom = this.dom;
      if (!leg || !me || me.dead) {
        if (this.gate) this.gate.visible = false;
        if (dom && dom.jump) dom.jump.classList.remove('on');
        this.charge = 0;
        return;
      }

      const gx = leg.exit.x, gy = leg.exit.y, gz = leg.exit.z;
      this.gate.visible = true;
      this.gate.position.set(gx, gy, gz);
      // Turn the ring to face the ship, so it reads as a hoop to fly through
      // rather than as a line on edge.
      this.gate.lookAt(0, 0, 0);
      this.gateRing.rotation.z += dt * 0.5;
      this.gateInner.rotation.z -= dt * 0.9;

      const d = Math.hypot(me.x - gx, me.y - gy, me.z - gz);
      const inside = d < GATE_R;

      // Taking a hit resets the spool. Measured off hull PLUS shield, so a
      // shield quietly regenerating is not mistaken for being shot at.
      const hp = me.hull + me.shield;
      const hurt = this._lastHp !== undefined && hp < this._lastHp - 0.01;
      this._lastHp = hp;

      if (hurt) { if (this.charge > 0) this.say('JUMP DISRUPTED'); this.charge = 0; }
      else if (inside) this.charge += dt;
      else this.charge = 0;

      if (dom && dom.jump) {
        dom.jump.classList.add('on');
        const name = SE.SECTOR_BY_ID[leg.leg].name.toUpperCase();
        const need = JUMP_SPOOL * (SE.stats(me).spool || 1);
        dom.jumptext.textContent = inside
          ? 'JUMP ' + name + ' — ' + Math.max(0, need - this.charge).toFixed(1) + 's'
          : name + ' GATE — ' + Math.round(d) + 'm';
        dom.jumpbar.style.width = Math.min(100, this.charge / need * 100) + '%';
      }

      if (this.charge >= JUMP_SPOOL * (SE.stats(me).spool || 1)) this.doJump(leg.leg);
    }

    /* The transfer. The player and every owned hull in the sector go together:
       leaving your own wingmen behind in a sector you have left is technically
       the simulation working correctly, and is a bug report every single time. */
    doJump(to) {
      const w = this.world;
      const here = w.sectorId;
      const iface = w.iface(here);
      const going = w.registry.inSector(here).filter(s => s.owned && !s.dead && (s.isPlayer || (!s.duty || s.duty === 'escort')));

      for (const s of going) {
        this.detach(s);
        iface.jump(s, to);
      }
      // Fan the fleet out around the arrival mouth. Without this they all land
      // on the same cubic metre and spend the first second shoving each other
      // apart, which is the first thing the player sees on arrival.
      const me = w.player;
      let k = 0;
      for (const s of going) {
        if (s.isPlayer) continue;
        const a = (k++) * 2.2;
        s.x = me.x + Math.cos(a) * 52;
        s.z = me.z + Math.sin(a) * 52;
        s.y = me.y + (k % 2 ? 14 : -14);
      }

      this.charge = 0;
      this.mineNode = -1;
      this.playerTarget = null;
      this.radar.selected = null;
      this.enterSector(to);
      if (this.galaxy) this.galaxy.refresh();

      if (this.course && this.course.to === to) {
        this.clearCourse();
        this.say('ARRIVED ' + SE.SECTOR_BY_ID[to].name.toUpperCase());
      }
      w.events.emit({ type: 'sector', sector: to });
      this.autosave();
    }

    /* Buying and fitting are one action, because they are one decision. A
       module bought and left in a locker is a second inventory screen to
       build and a second place for the player to lose track of what they own;
       there is no locker, so removing a module sells it back at half. */
    buyModule(id) {
      if (this.director && !this.director.atPort) return 'DOCK BEFORE REFITTING';
      const me = this.world.player;
      const m = SE.MODULES[id];
      if (!m) return 'unknown module';
      if (this.world.credits < m.cost) return 'NOT ENOUGH CREDITS';
      const err = SE.fitModule(me, id);
      if (err) return err;
      this.world.credits -= m.cost;
      this.refitView(me);
      this.say('FITTED ' + m.name.toUpperCase() + ' — ' + m.cost + ' CR');
      this.autosave(true);
      return null;
    }

    unfitModule(id) {
      if (this.director && !this.director.atPort) return 'DOCK BEFORE REFITTING';
      const me = this.world.player;
      const m = SE.MODULES[id];
      const err = SE.unfitModule(me, id);
      if (err) return err;
      const back = Math.round(m.cost * 0.5);
      this.world.credits += back;
      this.refitView(me);
      this.say('REMOVED ' + m.name.toUpperCase() + ' — ' + back + ' CR BACK');
      this.autosave(true);
      return null;
    }

    /* Ammo takes mass at body construction and will not be told otherwise, so
       a refit that changes mass has to rebuild the body. Detach and reattach,
       carrying the transform across — which is free here because refitting
       only happens docked, at rest, with nothing shooting. */
    refitView(ship) {
      const v = this.views[ship.id];
      if (!v) return;
      v.pull();
      const vx = ship.vx, vy = ship.vy, vz = ship.vz;
      this.detach(ship);
      this.attach(ship);
      const nv = this.views[ship.id];
      if (nv && nv.body) nv.body.setVelocity(vx, vy, vz);
    }

    /* Am I close enough to a station to talk to it? The button appears and
       disappears on its own rather than being always present and sometimes
       refusing — a control that is there but says no teaches nothing about
       where you have to be. */
    stepDock(me) {
      const btn = this.dom && this.dom.dockbtn;
      if (!btn) return;
      const st = me && !me.dead
        ? this.world.iface(this.world.sectorId).stationFor(me) : null;
      const near = st && Math.hypot(me.x - st.x, me.y - st.y, me.z - st.z) <
        SE.Transit.rules.dockRange;
      btn.classList.toggle('on', !!near);
      this._nearStation = near ? st : null;
      // Drifting out of range closes the panel rather than leaving a menu open
      // over a station you can no longer reach.
      if (!near && this.dock.open) { this.dock.hide(); this.say('DOCKING RANGE LOST'); }
    }

    /* ---- Sector entry and exit -----------------------------------------
       The moment the split is visible. Everything in the new sector grows a
       body; everything in the old one loses one and carries on as numbers. */
    enterSector(id) {
      const third = this.third;
      const w = this.world;
      w.beltState = w.beltState || {};
      for (const k in this.views) { this.views[k].destroy(); delete this.views[k]; }
      // Take the mined seams with us. The belt object is about to stop
      // existing, and it is the only record of what has been dug out of it.
      if (w.belt) {
        w.beltState[w.sectorId] = SE.harvestBelt(w.belt);
        w.belt.destroy();
        w.belt = null;
      }

      this.world.sectorId = id;
      if (this.cameraRig) this.cameraRig.ready = false;
      const sec = SE.SECTOR_BY_ID[id];
      if (sec.belt) {
        this.world.belt = SE.Belt(third, E, this.world.seed + ':' + id, id);
        SE.applyBelt(this.world.belt, w.beltState[id]);
      }

      this.world.transit.reconcile(id);
      if (this.transitView) this.transitView.destroy();
      this.transitView = SE.TransitView(third, E, this.world.transit.layout(id));
      const list = this.world.registry.inSector(id);
      for (let i = 0; i < list.length; i++) this.attach(list[i]);
      // Fill the draw window before the first frame, or the belt is invisible
      // until the player has travelled far enough to trigger a repack.
      const me = this.world.player;
      if (this.world.belt && me) this.world.belt.repack(me.x, me.y, me.z, 0, 0, -1, true);
      if (this.quality !== undefined) this.setQuality(this.quality);
      this.say('ENTERING ' + sec.name.toUpperCase());
    }

    attach(ship) {
      if (this.views[ship.id] || ship.dead) return null;
      const v = SE.ShipPhysicsView(this.third, E, ship);
      this.views[ship.id] = v;
      return v;
    }

    detach(ship) {
      const v = this.views[ship.id];
      if (!v) return;
      v.pull();                 // last word from physics before it stops existing
      v.destroy();
      delete this.views[ship.id];
    }

    /* ---- Frame ---------------------------------------------------------- */
    update(time, deltaMs) {
      const now = performance.now();
      this._frameSeconds = this._lastFrameAt ? Math.max(0, (now - this._lastFrameAt) / 1000) : Math.max(0, deltaMs / 1000);
      this._lastFrameAt = now;
    }

    resetMotion() {
      this.motionClock.reset(); this._lastFrameAt = performance.now(); this._frameSeconds = 0;
      if (this._turnCmd) { this._turnCmd.p = 0; this._turnCmd.y = 0; }
      // Resume from the displayed current pose, without replaying an old sample.
      for (const id in this.views) {
        const view = this.views[id];view.pose.reset(view.ship);view.present(1);
      }
    }

    advanceFrame(seconds) {
      if (this.loading || this.director?.paused) { this.motionClock.reset(); return; }
      this.trackPace(seconds * 1000);
      this.motionClock.advance(seconds, this._simulate);
      const alpha = this.director?.paused ? 1 : this.motionClock.alpha;
      for (const id in this.views) this.views[id].present(alpha);
      const w = this.world, me = w.player, view = me && this.views[me.id];
      if (me) {
        this.speed = Math.hypot(me.vx, me.vy, me.vz);
        this.chase(view ? view.pose.rendered : me, Math.min(seconds, 0.2));
      }
      this.scenery?.update(this.third.camera);
      if (w.belt) {
        const cam = this.third.camera;
        cam.getWorldDirection(this._camFwd);
        w.belt.repack(cam.position.x,cam.position.y,cam.position.z,this._camFwd.x,this._camFwd.y,this._camFwd.z,false);
      }
      this.drawSight(); this.radar.draw(); this.controls.draw();
      this.hudAcc += seconds;
      if (this.hudAcc > 0.1) { this.hudAcc = 0; this.updateDom(); }
    }

    simulate(dt) {
      if (this.loading || this.director?.paused) return false;
      const w = this.world;
      w.elapsed += dt;

      this.controls.readKeys(dt);
      const me = w.player;
      const api = w.iface(w.sectorId);
      const bucket = w.registry.inSector(w.sectorId);
      const list = this._tickShips || (this._tickShips = []);
      list.length = 0;
      for (let i = 0; i < bucket.length; i++) list.push(bucket[i]);

      // 1. decide and apply, for everything with a body in this sector
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.dead) continue;
        s.cool = Math.max(0, s.cool - dt);
        const cls = SE.CLASSES[s.cls];
        if (s.shield < s.shieldMax) s.shield = Math.min(s.shieldMax, s.shield + (w.elapsed - (s.damageAt ?? -100) > 3 ? SE.stats(s).shieldRegen * dt : 0));

        const v = this.views[s.id];
        if (s.isPlayer) { this.flyPlayer(s, v, dt); continue; }

        const it = SE.AI.think(s, api, dt);
        if (s.sector !== w.sectorId) continue;
        if (v && v.body && !v.isStructure) SE.AI.applyPhysical(s, it, dt, v.body);

        const foe = it.fire && it.target ? w.get(it.target) : null;
        const live = foe && !foe.dead;

        /* A platform with a swivelling head has to finish swivelling before
           it shoots. Without the gate the barrels lag the rounds, which reads
           as the turret firing out of its own side — and it is also the only
           thing that makes traverse rate a real stat rather than decoration:
           a fast mover crossing a heavy mount's arc genuinely outruns its
           guns. */
        let laid = true;
        if (v && v.hasHead) {
          laid = live ? v.aimHead(foe.x, foe.y, foe.z, dt) : (v.restHead(dt), false);
        }
        if (live && laid) this.combat.fire(s, foe.x, foe.y, foe.z);
      }

      // Collision residency is resolved before the solver, then all consumers
      // observe the same authoritative post-solve transforms.
      if (w.belt && me) w.belt.updateBodies(me.x, me.y, me.z);
      this._physicsStep(dt * 1000);

      // 3. physics -> state
      for (const k in this.views) {
        const ship = w.get(k);
        if (!ship || ship.sector !== w.sectorId) { this.views[k].destroy(); delete this.views[k]; }
        else this.views[k].pull();
      }
      if (me) {
        const f = SE.AI.forward(me, { x: 0, y: 0, z: 0 });
        this.heading = Math.atan2(f.x, f.z) + Math.PI;
      }

      // 4. projectiles, wreckage, rocks
      this.combat.stepShots(dt, list);
      // Reused scratch array. list.filter() here is one allocation per frame
      // in the hot path, which is the exact thing the pools exist to avoid.
      this._collectors.length = 0;
      for (let i = 0; i < list.length; i++) if (list[i].owned && !list[i].dead) this._collectors.push(list[i]);
      this.combat.stepCrates(dt, this._collectors);
      this.stepMining(me, dt);
      this.stepJump(dt);
      this.stepDock(me);
      this.missions.tick();
      this.reapDead(list);
      this.director?.tick(dt);


      // 5. the rest of the galaxy, on its own coarser clock
      this.oosAcc += dt;
      while (this.oosAcc >= OOS_STEP) { w.tickOOS(OOS_STEP); this.oosAcc -= OOS_STEP; }

      this.saveAcc += dt;
      if (this.saveAcc > AUTOSAVE) { this.saveAcc = 0; this.autosave(); }
      return !this.director?.paused;
    }

    /* ---- Flying it yourself ---------------------------------------------
       The stick commands pitch/yaw rates in the ship's own axes. Throttle
       requests a speed; the velocity servo accelerates and removes sideslip
       within the hull's thrust / mass limit. Hands off also levels roll. */
    flyPlayer(s, v, dt) {
      if (!v || !v.body) return;
      if (this.director?.pilot(s, v, dt)) return;
      const st = this.controls.state;
      if (st.throttle > 0.05 || Math.abs(st.pitch) + Math.abs(st.yaw) > 0.15 || st.firing) this.mineNode = -1;
      const body = v.body;
      // Effective, not nominal: what the hull does with what is bolted to it.
      const cls = SE.stats(s);

      const q = this._q.set(s.qx, s.qy, s.qz, s.qw);
      const right = this._right.set(1, 0, 0).applyQuaternion(q);
      const up = this._up.set(0, 1, 0).applyQuaternion(q);
      const fwd = this._fwd.set(0, 0, -1).applyQuaternion(q);

      /* --- rotation: pitch and yaw from the stick, roll from the horizon
         The stick commands a RATE, but the ship is not allowed to reach that
         rate instantly. It used to: setAngularVelocity was handed the stick
         value directly, which is infinite angular acceleration in both
         directions — the nose snapped to 135 degrees a second the frame a
         thumb landed and stopped dead the frame it lifted. Every input was a
         step function, and no amount of tuning the peak rate fixes a step.

         So the command is spooled. SPOOL_UP is how long full deflection takes
         to build; SPOOL_DOWN is shorter, because a ship that keeps turning
         after the thumb is off overshoots the thing you were lining up, and
         overshoot is what a player reads as "it won't stop". Asymmetric feels
         right for the same reason car brakes outrun the engine. */
      const cmd = this._turnCmd || (this._turnCmd = { p: 0, y: 0 });
      const SPOOL_UP = 0.26, SPOOL_DOWN = 0.13;
      cmd.p = spool(cmd.p, st.pitch, dt, SPOOL_UP, SPOOL_DOWN);
      cmd.y = spool(cmd.y, st.yaw, dt, SPOOL_UP, SPOOL_DOWN);

      /* 0.40 put the corvette at 135 deg/s at full stick, which is a rate for
         a mouse and not for a thumb: more than a third of a full turn in a
         second, past anything a person can stop on. 0.26 is 88, which still
         out-turns every AI hull and can be aimed. */
      const rate = cls.torque / Math.sqrt(cls.mass) * 0.26;
      let rx = right.x * (-cmd.p) + up.x * (-cmd.y);
      let ry = right.y * (-cmd.p) + up.y * (-cmd.y);
      let rz = right.z * (-cmd.p) + up.z * (-cmd.y);
      let wx = rx * rate, wy = ry * rate, wz = rz * rate;

      // Hands off is asked of the STICK, not of the spooled command: the roll
      // should start levelling the moment the thumb lifts, not once the turn
      // has finished bleeding off.
      const handsOff = Math.abs(st.pitch) < 0.04 && Math.abs(st.yaw) < 0.04;
      if (handsOff) {
        // Bank angle is the ship's own right vector tipped out of the world
        // horizontal. Roll about the nose until it is flat again.
        /* Sign, carefully, because getting it wrong does not look like a bug —
           it looks like the ship rolling itself upside down on purpose.
           Rolling by phi about the nose (which is -Z) puts right.y at -sin(phi)
           and up.y at cos(phi), so this angle is -phi, and driving phi to zero
           means an angular velocity about the nose of the SAME sign as the
           measurement. The first version negated it and flew the ship past
           inverted, which the test caught: banked 73 degrees, ended at 176. */
        const bank = Math.atan2(right.y, up.y);
        if (Math.abs(bank) > 0.008) {
          const roll = Math.max(-1, Math.min(1, bank * 2.2)) * rate * 0.55;
          wx += fwd.x * roll; wy += fwd.y * roll; wz += fwd.z * roll;
        }
      }
      body.setAngularVelocity(wx, wy, wz);

      // Bounded velocity convergence has no accelerate/brake threshold chatter.
      const drive = this.director ? this.director.boost(dt) : 1;
      SE.Motion.drive(s,body,fwd.x,fwd.y,fwd.z,cls.topSpeed * st.throttle * drive,dt,drive);

      if (st.firing && s.cool <= 0) {
        const tgt = this.playerTarget ? this.world.get(this.playerTarget) : null;
        const lead = tgt ? Math.min(2, Math.hypot(tgt.x-s.x, tgt.y-s.y, tgt.z-s.z) / SE.weaponOf(s).speed) : 0;
        if (this.combat.fire(s, tgt ? tgt.x + (tgt.vx-s.vx)*lead : undefined, tgt ? tgt.y + (tgt.vy-s.vy)*lead : undefined, tgt ? tgt.z + (tgt.vz-s.vz)*lead : undefined, !!this.director?.state.settings.aimAssist)) this.director?.audio.play('shot');
      }
    }

    /* The player mines whatever rock they last tapped, whenever they are close
       enough to it. No button: the flagship's guns and its cutting laser are
       not both things you want to be choosing between with the same thumb. */
    stepMining(me, dt) {
      const w = this.world;
      if (!me || !w.belt || this.mineNode < 0) { this.beam.visible = false; return; }
      const node = w.belt.node(this.mineNode);
      if (!node) { this.mineNode = -1; this.beam.visible = false; return; }
      const d = Math.hypot(node.x - me.x, node.y - me.y, node.z - me.z);
      if (d > SE.AI.MINE_RANGE) { this.beam.visible = false; return; }
      const got = w.iface(w.sectorId).mine(me, node, dt);
      const p = this.beam.geometry.attributes.position;
      p.setXYZ(0, me.x, me.y, me.z);
      p.setXYZ(1, node.x, node.y, node.z);
      p.needsUpdate = true;
      this.beam.visible = true;
      if (got <= 0) {
        this.mineNode = -1;
        this.beam.visible = false;
        this.say(SE.cargoUsed(me) >= me.cargoMax ? 'HOLD FULL' : 'SEAM EXHAUSTED');
      }
    }

    /* ---- Death ---------------------------------------------------------- */
    onHit(target, shot) {
      target.lastHitBy = shot.owner; target.damageAt = this.world.elapsed;
      this.world.events.emit({ type: 'damage', target, attacker: shot.owner, amount: shot.dmg });
      if (target.dead) return;
      // Being shot at by someone you were ignoring is a good enough reason to
      // stop ignoring them — for the AI, and for the player's wingmen.
      if (!target.isPlayer && (!target.orders.length || target.orders[0].type === 'MOVE' || target.orders[0].type === 'GUARD')) {
        const shooter = this.world.get(shot.owner);
        if (shooter && !shooter.dead && SE.hostile(target.faction, shooter.faction)) {
          target.orders.unshift({ type: 'ATTACK', target: shooter.id });
          target.orderT = 0;
        }
      }
    }

    reapDead(list) {
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (!s.dead) continue;
        const cls = SE.CLASSES[s.cls];
        // Wreckage, in proportion: a dreadnought is worth flying back for.
        const crates = cls.tier === 'heavy' ? 7
          : cls.tier === 'structure' ? 10
          : cls.tier === 'emplacement' ? 5
          : cls.tier === 'medium' ? 4 : 2;
        const held = Math.round(SE.cargoUsed(s));
        this.combat.scatter(s.x, s.y, s.z, crates, held > 20 ? 'ore' : 'scrap',
          held > 20 ? Math.round(held / crates) : Math.round(cls.hull / 22));
        // Who did it. The killer is not tracked on the round, so the honest
        // answer is "the player's side" — every hostile that dies in the
        // sector the player is flying in is one the player or their wingmen
        // shot, because nothing else in a sector shoots a hostile of ours.
        this.missions.onKill(s, s.lastHitBy ? this.world.get(s.lastHitBy) : null);
        if (s.isPlayer) { this.playerDown(s); continue; }
        // A structure is never reaped. Belt and braces with the rule in
        // damage(): losing the only station in a sector would take that
        // sector's trade with it, and the save would remember.
        if (cls.tier === 'structure') { s.dead = false; s.hull = Math.max(1, s.hull); continue; }
        this.detach(s);
        this.world.registry.remove(s);
        if (this.playerTarget === s.id) this.playerTarget = null;
        this.say(s.name.toUpperCase() + ' DESTROYED');
      }
    }

    playerDown(s) {
      if (this.dead) return;
      this.dead = true;
      const lost = Math.round(this.world.credits * 0.35);
      this.world.credits -= lost;
      this.say('HULL LOST — TOWED IN. ' + lost + ' CR IN SALVAGE FEES');
      // Rebuilt at the station rather than game over. This is a sandbox; a
      // permadeath rule in a game about building an empire deletes the empire.
      this.detach(s);
      s.dead = false;
      s.hull = s.hullMax; s.shield = s.shieldMax;
      s.cargo = {};
      const port = this.world.iface(s.sector).stationFor(s);
      const berth = port ? this.world.transit.dockPoint(port, s) : {x:0,y:100,z:580};
      s.x = berth.x; s.y = berth.y; s.z = berth.z;
      s.invulnerableUntil = performance.now() + 6000;
      this.director?.cancelNavigation(); this.controls.reset(true);
      this.clearCourse(); this.playerTarget = null;
      if (this._turnCmd) { this._turnCmd.p = 0; this._turnCmd.y = 0; }
      s.vx = s.vy = s.vz = 0;
      s.qx = s.qy = s.qz = 0; s.qw = 1;
      this.attach(s);
      this.dead = false;
      this.mineNode = -1;
    }

    /* ---- Adaptive quality -------------------------------------------------
       Raising the step ceiling stops low frame rates becoming slow motion, but
       the honest fix is not to have low frame rates. The belt is 81% of the
       scene, and bloom is a full-frame blur, so those are the two dials.

       Hysteresis matters more than the thresholds: a single slow frame must
       not drop quality, and being near the boundary must not oscillate, or the
       picture visibly breathes. A long average, two separate thresholds, and a
       cooldown between changes.
    */
    trackPace(deltaMs) {
      if (this.director && this.director.state.settings.quality !== 'auto') return;
      const ms = Math.min(500, deltaMs);
      this.paceMs = this.paceMs === undefined ? ms : this.paceMs * 0.94 + ms * 0.06;
      // Counted in SECONDS, not frames: a frame-count threshold takes twenty
      // seconds to trigger at the frame rates that most need it.
      this.paceSecs = (this.paceSecs || 0) + ms / 1000;
      if (this.paceSecs < 4) return;
      this.paceSecs = 0;
      const level = this.quality === undefined ? 2 : this.quality;
      let next = level;
      if (this.paceMs > 58 && level > 0) next = level - 1;        // under ~17fps
      else if (this.paceMs < 26 && level < 2) next = level + 1;   // over ~38fps
      if (next === level) return;
      this.setQuality(next);
    }

    setQuality(level) {
      this.quality = level;
      const belt = this.world.belt;
      // 0: half the rocks drawn and no bloom. 1: fewer rocks, bloom on.
      // 2: everything.
      const cap = [1200, 2200, 3200][level];
      if (belt && belt.setDrawCap) belt.setDrawCap(cap);
      if (this.third.composer) {
        const want = level > 0;
        if (want !== this._bloomOn) {
          this._bloomOn = want;
          this.bloom.enabled = want;
        }
      }
      this.say('GRAPHICS ' + ['LOW', 'MEDIUM', 'HIGH'][level]);
    }

    /* ---- Camera ---------------------------------------------------------
       Follow and orbit share one presentation rig. Its sector-up reference is
       independent of the hull roll, and its focus follows the displayed pose. */
    chase(s, dt) {
      const cam = this.third.camera;
      const frame = this.cameraRig.update(s, this.world.transit.radius(this.world.player), this.speed || 0, dt);
      cam.position.set(frame.position.x,frame.position.y,frame.position.z);
      cam.up.set(0,1,0);
      cam.lookAt(frame.aim.x,frame.aim.y,frame.aim.z);
      this.stars.position.copy(cam.position);
    }

    /* ---- Tapping the world ---------------------------------------------- */
    viewTap(sx, sy) {
      const w = this.world;
      const cam = this.third.camera;
      // sx/sy arrive in CSS pixels; the ratio cancels, but both halves of the
      // fraction have to be in the same space for it to.
      const S = dpr();
      const nx = (sx / (this.scale.width / S)) * 2 - 1;
      const ny = -(sy / (this.scale.height / S)) * 2 + 1;

      // Cast at both, then decide. Ships win ties and win narrowly-behind,
      // because they are smaller and they move and a tap meant for a raider
      // that lands on the rock behind it is the more annoying mistake. But
      // they do not win outright: a boulder filling the screen losing a tap to
      // a station eight hundred metres past it is the other annoying mistake,
      // and that one is worse because the rock is the thing you are looking at.
      const objs = [];
      for (const k in this.views) if (!this.views[k].ship.isPlayer) objs.push(this.views[k].obj);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
      const hits = ray.intersectObjects(objs, true);
      const rock = w.belt ? w.belt.pick(nx, ny, cam) : null;
      const shipD = hits.length ? hits[0].distance : Infinity;
      const rockD = rock ? rock.dist : Infinity;

      if (hits.length && shipD < rockD * 1.35) {
        let o = hits[0].object;
        while (o && !o.name.startsWith('s') && !w.get(o.name) && o.parent) o = o.parent;
        const ship = o && w.get(o.name);
        if (ship) {
          const sel = this.radar.selected ? w.get(this.radar.selected) : null;
          if (sel) {
            sel.orders.length = 0; sel.orderT = 0;
            sel.orders.push({ type: 'ATTACK', target: ship.id });
            this.say(sel.name.toUpperCase() + ' > ATTACK ' + ship.name.toUpperCase());
          } else {
            this.playerTarget = ship.id;
            this.say('TARGET ' + ship.name.toUpperCase() + ' — ' + (SE.FACTIONS[ship.faction] || {}).short);
          }
          return;
        }
      }

      // Then the belt. instanceId is the whole mechanism: without it a tap on
      // ten thousand rocks selects one object called "belt".
      if (rock) {
        const sel = this.radar.selected ? w.get(this.radar.selected) : null;
        if (sel) {
          sel.orders.length = 0; sel.orderT = 0;
          sel.orders.push({ type: 'MINE', node: rock.index });
          this.say(sel.name.toUpperCase() + ' > MINE #' + rock.index);
        } else if (rock.ore > 0) {
          this.mineNode = rock.index;
          this.say('SEAM #' + rock.index + ' — ' + Math.round(rock.ore) + ' ORE');
        } else {
          this.say('BARREN ROCK');
        }
        return;
      }
      this.playerTarget = null;
    }

    /* ---- DOM HUD --------------------------------------------------------
       Fixed furniture, so DOM: crisp text, real layout, safe-area insets
       handled by the browser. Updated ten times a second rather than sixty —
       nothing here changes fast enough to need more, and every write is a
       potential reflow. */
    wireDom() {
      const $ = id => document.getElementById(id);
      this.dom = { hull: $('hull'), shield: $('shield'), credits: $('credits'), cargo: $('cargo'), speed: $('speed'),
        sector: $('sector'), msg: $('msg'), jump: $('jump'), jumptext: $('jumptext'), jumpbar: $('jumpbar').firstElementChild,
        dockbtn: $('dockbtn') };
    }

    say(msg) {
      if (this.director && !msg.startsWith('SAVED') && !msg.startsWith('GRAPHICS')) this.director.shell.toast(msg);
      if (!this.dom || !this.dom.msg) return;
      this.dom.msg.textContent = msg;
      this.dom.msg.classList.remove('flash');
      void this.dom.msg.offsetWidth;      // restart the animation
      this.dom.msg.classList.add('flash');
    }

    updateDom() { this.director?.shell.updateHUD(); }

    /* ---- Saving ---------------------------------------------------------- */
    /* Returns the promise. It used to swallow it, which meant `await
       autosave()` resolved before anything had been written — harmless in the
       game, and it made a test reload the page mid-write and report that
       contracts were not being saved when they were. */
    autosave(quiet) {
      if (this.loading || this._gone) return Promise.resolve(0);
      const snap = SE.snapshot(this.world);
      return this.persist.save(snap).then(bytes => {
        if (bytes && !quiet) this.say('SAVED — ' + Math.round(bytes / 1024) + ' KB');
        return bytes;
      }).catch(err => { this.say('SAVE FAILED: ' + err.message); return 0; });
    }

    /* Leaving the app is the normal way to stop playing on a phone, and it
       does not announce itself — there is no quit button to hang a save off.
       visibilitychange fires when the app is backgrounded, which is the last
       reliable moment there is; pagehide covers the tab actually going away.
       Without these, up to a full autosave interval of play is simply lost,
       and the player's evidence for that is a mined seam that came back. */
    wireSaveOnExit() {
      const flush = () => {
        if (this._gone) return;
        try { this.autosave(true); } catch (e) { /* going away regardless */ }
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
      window.addEventListener('pagehide', flush);
    }

    async restore() {
      let data = null;
      try { data = await this.persist.load(); }
      catch (err) { throw new Error('Your existing commander could not be read. No save was overwritten. ' + err.message); }
      if (!data) return;
      if (data.seed !== this.world.seed) throw new Error('This commander belongs to a different universe seed. No save was overwritten.');
      const w = this.world;

      // Rebuild the registry from the file rather than patching the generated
      // one: a saved galaxy has ships that were born after generation and is
      // missing ships that died, and reconciling those two lists is a bug farm.
      for (const k in this.views) { this.views[k].destroy(); delete this.views[k]; }
      w.registry.all.slice().forEach(s => w.registry.remove(s));
      SE.setNextId(data.nextId || 1);
      data.ships.forEach(r => {
        const s = SE.makeShip({ id: r.id, name: r.name, cls: r.cls, faction: r.faction, sector: r.sector, isPlayer: r.isPlayer, owned: r.owned });
        Object.assign(s, {
          x: r.x, y: r.y, z: r.z, qx: r.qx, qy: r.qy, qz: r.qz, qw: r.qw,
          vx: r.vx, vy: r.vy, vz: r.vz, hull: r.hull, shield: r.shield,
          cargo: r.cargo || {}, credits: r.credits || 0, orders: r.orders || [], dead: !!r.dead,
          duty: r.duty, commanderId: r.commanderId, escortOf: r.escortOf, damageAt: r.damageAt
        });
        /* Equipment, if the file carries any. Assigned separately rather than
           in the object above, because `fit: undefined` would overwrite the
           empty fit makeShip just handed an owned hull — and a ship with no
           fit object cannot be refitted at all. bumpFit then rebuilds the
           ceilings the modules imply, so armour restores as 380/380 rather
           than as 380 hull inside a 220 maximum. */
        if (r.fit) { s.fit = r.fit; SE.bumpFit(s); }
        w.registry.add(s);
      });
      /* Written before the galaxy grew, or by a different generation of it:
         whatever generated systems the file knows nothing about are filled in
         now, before the economy is built, so their stations get accounts. */
      if (data.galaxy !== SE.GALAXY_SEED) {
        const filled = SE.populateMissing(w);
        if (filled) this.say(filled + ' NEW SYSTEMS CHARTED');
      }
      w.credits = data.credits;
      w.empire = data.empire;
      w.economyState = data.economy;
      w.contracts = data.contracts || [];
      w.completed = data.completed || [];
      w.boards = {};
      w.elapsed = data.elapsed || 0;
      w.stationStock = data.stations || {};
      /* Belt deltas for EVERY sector, not just the one being entered. The
         table is installed before enterSector so that the sector it builds
         picks up its own depletion on the way in, and every other sector's
         waits in the table until the player arrives there.
         `data.belt` is the old single-sector shape; a save written before this
         existed is honoured by filing it under the sector it was taken in,
         which is the only sector it could possibly have described. */
      if (w.belt) { w.belt.destroy(); w.belt = null; }
      w.beltState = data.belts || {};
      if (data.belt && !data.belts) w.beltState[data.sector || 'home'] = data.belt;
      this.enterSector(data.sector || 'home');
      this.say('COMMANDER FILE RESTORED');
      window.SE_RESTORED = true;
    }
  }

  SE.SectorScene = SectorScene;

  /* ---- Rendering at the resolution the screen actually has ---------------
   *
   * This was the whole of the "pixelated" complaint and it had nothing to do
   * with the art.
   *
   * Phaser's RESIZE mode sizes the canvas BACKING STORE in CSS pixels. On a
   * phone reporting devicePixelRatio 3, a 412-wide layout got a 412-wide
   * framebuffer stretched across 1236 physical pixels — every edge in the
   * game resampled up by three, which is exactly what "pixelated" looks like.
   * The scene was always being drawn correctly; it was being drawn small and
   * then blown up.
   *
   * The fix is the one already shipped in Rivenmark, which is the same engine:
   * make the game as many pixels as the device has, then scale the CANVAS
   * ELEMENT back down with zoom so it still occupies the same space on screen.
   * The backing store is native; the layout is unchanged.
   *
   * The ratio is capped at 2, which is lower than Rivenmark's 3 for a reason
   * given at the cap itself: this is a 3D scene with a full-frame bloom
   * pyramid, and fill cost goes as the square of the ratio.
   */

  SE.boot = function () {
    SE.portablePhysics(() => {
      const r = dpr();
      const game = new Phaser.Game({
        type: Phaser.WEBGL,
        transparent: true,
        /* pixelArt would set NEAREST filtering on every texture, which is the
           literal setting for "make it pixelated". antialias asks the context
           for MSAA. roundPixels snaps draws to integers, which at a fractional
           zoom is what makes a HUD shimmer as it moves. */
        pixelArt: false,
        antialias: true,
        roundPixels: false,
        scale: {
          // NONE, not RESIZE: the size is being computed here, and RESIZE
          // would overwrite it with CSS pixels on the first resize event.
          mode: Phaser.Scale.NONE,
          autoCenter: Phaser.Scale.NO_CENTER,
          width: Math.round(window.innerWidth * r),
          height: Math.round(window.innerHeight * r),
          zoom: 1 / r
        },
        scene: [SectorScene],
        ...E.Canvas()
      });
      window.SE_GAME = game;

      // Rotating a phone changes both the size and, on some devices, the
      // ratio. Recompute both rather than assuming one of them held.
      const fit = () => {
        const k = dpr();
        game.scale.zoom = 1 / k;
        game.scale.resize(Math.round(window.innerWidth * k), Math.round(window.innerHeight * k));
      };
      window.addEventListener('resize', fit);
      window.addEventListener('orientationchange', () => setTimeout(fit, 120));
    });
  };
})(window.SE = window.SE || {});
