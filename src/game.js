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
  const CAM_BACK = 34, CAM_UP = 11;

  class SectorScene extends E.Scene3D {
    constructor() { super({ key: 'Sector' }); }

    init() {
      this.accessThirdDimension({ gravity: { x: 0, y: 0, z: 0 }, maxSubSteps: 4, fixedTimeStep: 1 / 60 });
    }

    create() {
      const third = this.third;
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
          if (s.isPlayer) this.say('TRACTOR +' + Math.round(qty) + ' ' + good.toUpperCase());
        }
      });

      this.radar = SE.Radar(this, {
        centre: () => this.world.player || { x: 0, y: 0, z: 0 },
        heading: () => this.heading,
        ships: () => this.world.registry.inSector(this.world.sectorId),
        get: id => this.world.get(id),
        node: i => this.world.belt ? this.world.belt.node(i) : null,
        nearestOre: (x, y, z) => this.world.belt ? this.world.belt.nearestOre(x, y, z, 2400) : null,
        station: () => this.world.iface(this.world.sectorId).stationFor(this.world.player),
        target: () => this.playerTarget,
        setTarget: id => { this.playerTarget = id; },
        say: m => this.say(m)
      });

      this.controls = SE.Controls(this, {
        radarTap: (x, y) => this.radar.handleTap(x, y),
        viewTap: (x, y) => this.viewTap(x, y)
      });

      this.heading = 0;
      this._camFwd = new THREE.Vector3(0, 0, -1);
      this._collectors = [];
      this.buildMiningBeam();
      this.enterSector('home');

      this.persist = SE.Persistence();
      this.wireDom();
      this.restore();
    }

    /* ---- Scenery -------------------------------------------------------
       Stars are one Points object with a flat material: three thousand of them
       cost one draw and no lighting. They sit on a sphere that follows the
       camera, so they never get closer — which is the only property of a star
       that matters at this range. */
    buildStarfield() {
      const rng = SE.Rng('stars');
      const N = 3000;
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
        size: 2.4, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false
      }));
      this.stars.frustumCulled = false;
      this.third.scene.add(this.stars);
    }

    buildMiningBeam() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this.beam = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.85 }));
      this.beam.frustumCulled = false;
      this.beam.visible = false;
      this.third.scene.add(this.beam);
    }

    /* ---- Sector entry and exit -----------------------------------------
       The moment the split is visible. Everything in the new sector grows a
       body; everything in the old one loses one and carries on as numbers. */
    enterSector(id) {
      const third = this.third;
      for (const k in this.views) { this.views[k].destroy(); delete this.views[k]; }
      if (this.world.belt) { this.world.belt.destroy(); this.world.belt = null; }

      this.world.sectorId = id;
      const sec = SE.SECTOR_BY_ID[id];
      if (sec.belt) this.world.belt = SE.Belt(third, E, this.world.seed + ':' + id);

      const list = this.world.registry.inSector(id);
      for (let i = 0; i < list.length; i++) this.attach(list[i]);
      // Fill the draw window before the first frame, or the belt is invisible
      // until the player has travelled far enough to trigger a repack.
      const me = this.world.player;
      if (this.world.belt && me) this.world.belt.repack(me.x, me.y, me.z, 0, 0, -1, true);
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
      // Clamped: a tab that was backgrounded for ten seconds must not deliver
      // a ten-second step to a physics engine, which resolves as every ship in
      // the sector teleporting through every rock in it.
      const dt = Math.min(0.05, deltaMs / 1000);
      const w = this.world;
      w.elapsed += dt;

      this.controls.readKeys(dt);
      const me = w.player;
      const api = w.iface(w.sectorId);
      const list = w.registry.inSector(w.sectorId);

      // 1. decide and apply, for everything with a body in this sector
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.dead) continue;
        s.cool = Math.max(0, s.cool - dt);
        const cls = SE.CLASSES[s.cls];
        if (s.shield < s.shieldMax) s.shield = Math.min(s.shieldMax, s.shield + cls.shieldRegen * dt);

        const v = this.views[s.id];
        if (s.isPlayer) { this.flyPlayer(s, v, dt); continue; }

        const it = SE.AI.think(s, api, dt);
        if (v && v.body && !v.isStructure) SE.AI.applyPhysical(s, it, dt, v.body);
        if (it.fire && it.target) {
          const foe = w.get(it.target);
          if (foe && !foe.dead) this.combat.fire(s, foe.x, foe.y, foe.z);
        }
      }

      // 2. let Ammo step — Phaser calls third's own update after this method,
      //    so by the time we pull below we are reading the previous solve. That
      //    one-frame lag is invisible and it is the only way to avoid asking
      //    the engine to step twice a frame.

      // 3. physics -> state
      for (const k in this.views) this.views[k].pull();
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
      if (w.belt && me) {
        w.belt.updateBodies(me.x, me.y, me.z);
        const cam = this.third.camera;
        cam.getWorldDirection(this._camFwd);
        w.belt.repack(cam.position.x, cam.position.y, cam.position.z,
          this._camFwd.x, this._camFwd.y, this._camFwd.z, false);
      }
      this.stepMining(me, dt);
      this.reapDead(list);

      // 5. the rest of the galaxy, on its own coarser clock
      this.oosAcc += dt;
      while (this.oosAcc >= OOS_STEP) { w.tickOOS(OOS_STEP); this.oosAcc -= OOS_STEP; }

      // 6. draw the 2D layer, then the DOM, then think about saving
      if (me) this.chase(me, dt);
      this.radar.draw();
      this.controls.draw();

      this.hudAcc += dt;
      if (this.hudAcc > 0.1) { this.hudAcc = 0; this.updateDom(); }

      this.saveAcc += dt;
      if (this.saveAcc > AUTOSAVE) { this.saveAcc = 0; this.autosave(); }
    }

    /* ---- Flying it yourself ---------------------------------------------
       Not the AI's seek-a-point steering: the stick is a rate command on the
       ship's own axes, which is what makes a corvette feel like a thing you
       are piloting rather than a thing you are pointing at. Thrust is still
       real force through the real rigid body, so the mass in the class table
       is the mass you feel. */
    flyPlayer(s, v, dt) {
      if (!v || !v.body) return;
      const st = this.controls.state;
      const body = v.body;
      const cls = SE.CLASSES[s.cls];

      const q = new THREE.Quaternion(s.qx, s.qy, s.qz, s.qw);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);

      const rate = cls.torque / Math.sqrt(cls.mass) * 0.40;
      const ax = right.x * (-st.pitch) + up.x * (-st.yaw);
      const ay = right.y * (-st.pitch) + up.y * (-st.yaw);
      const az = right.z * (-st.pitch) + up.z * (-st.yaw);
      body.setAngularVelocity(ax * rate, ay * rate, az * rate);

      const t = cls.thrust * st.throttle;
      if (t > 0) body.applyCentralForce(fwd.x * t, fwd.y * t, fwd.z * t);

      const vel = body.velocity;
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      if (speed > cls.topSpeed) {
        const k = Math.min(1, (speed - cls.topSpeed) / cls.topSpeed * 2.6 * dt);
        body.setVelocity(vel.x * (1 - k), vel.y * (1 - k), vel.z * (1 - k));
      }
      this.speed = speed;

      if (st.firing && s.cool <= 0) {
        const tgt = this.playerTarget ? this.world.get(this.playerTarget) : null;
        this.combat.fire(s, tgt ? tgt.x : undefined, tgt ? tgt.y : undefined, tgt ? tgt.z : undefined);
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
        const crates = cls.tier === 'heavy' ? 7 : (cls.tier === 'structure' ? 10 : (cls.tier === 'medium' ? 4 : 2));
        const held = Math.round(SE.cargoUsed(s));
        this.combat.scatter(s.x, s.y, s.z, crates, held > 20 ? 'ore' : 'scrap',
          held > 20 ? Math.round(held / crates) : Math.round(cls.hull / 22));
        if (s.isPlayer) { this.playerDown(s); continue; }
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
      s.x = 90; s.y = 0; s.z = -150;
      s.vx = s.vy = s.vz = 0;
      s.qx = s.qy = s.qz = 0; s.qw = 1;
      this.attach(s);
      this.dead = false;
      this.mineNode = -1;
    }

    /* ---- Camera ---------------------------------------------------------
       Chase, lerped, with the lag scaled by speed so that accelerating pushes
       the ship toward the far edge of frame and braking pulls it back. It is a
       cheap trick and it does more for the sense of speed than the speed does. */
    chase(s, dt) {
      const cam = this.third.camera;
      const q = new THREE.Quaternion(s.qx, s.qy, s.qz, s.qw);
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const size = SE.CLASSES[s.cls].size;
      const lag = 1 + Math.min(0.55, (this.speed || 0) / 260);
      const want = new THREE.Vector3(
        s.x + back.x * CAM_BACK * size * 0.22 * lag + up.x * CAM_UP,
        s.y + back.y * CAM_BACK * size * 0.22 * lag + up.y * CAM_UP,
        s.z + back.z * CAM_BACK * size * 0.22 * lag + up.z * CAM_UP
      );
      const k = 1 - Math.pow(0.0016, dt);
      cam.position.lerp(want, k);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      cam.lookAt(s.x + fwd.x * 60, s.y + fwd.y * 60, s.z + fwd.z * 60);
      this.stars.position.copy(cam.position);
    }

    /* ---- Tapping the world ---------------------------------------------- */
    viewTap(sx, sy) {
      const w = this.world;
      const cam = this.third.camera;
      const nx = (sx / this.scale.width) * 2 - 1;
      const ny = -(sy / this.scale.height) * 2 + 1;

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
      this.dom = {
        hull: $('hull'), shield: $('shield'),
        credits: $('credits'), cargo: $('cargo'), speed: $('speed'),
        sector: $('sector'), msg: $('msg'), fleet: $('fleet'), mode: $('mode')
      };
      const setMode = m => {
        this.radar.mode = m;
        [...document.querySelectorAll('#mode button')].forEach(b => b.classList.toggle('on', b.dataset.m === m));
      };
      document.querySelectorAll('#mode button').forEach(b => {
        b.addEventListener('click', () => setMode(b.dataset.m));
      });
      setMode('MOVE');
      $('recall').addEventListener('click', () => {
        const me = this.world.player;
        let n = 0;
        this.world.registry.inSector(this.world.sectorId).forEach((s, i) => {
          if (!s.owned || s.isPlayer || s.dead) return;
          s.orders.length = 0; s.orderT = 0;
          s.orders.push({ type: 'GUARD', target: me.id, slot: n++ });
        });
        this.radar.selected = null;
        this.say('FLEET RECALLED — ' + n + ' HULL' + (n === 1 ? '' : 'S'));
      });
    }

    say(msg) {
      if (!this.dom || !this.dom.msg) return;
      this.dom.msg.textContent = msg;
      this.dom.msg.classList.remove('flash');
      void this.dom.msg.offsetWidth;      // restart the animation
      this.dom.msg.classList.add('flash');
    }

    updateDom() {
      const w = this.world, me = w.player, d = this.dom;
      if (!me || !d.hull) return;
      d.hull.style.width = (100 * me.hull / me.hullMax).toFixed(1) + '%';
      d.shield.style.width = (100 * me.shield / me.shieldMax).toFixed(1) + '%';
      d.credits.textContent = Math.round(w.credits).toLocaleString();
      d.cargo.textContent = Math.round(SE.cargoUsed(me)) + '/' + me.cargoMax;
      d.speed.textContent = Math.round(this.speed || 0);
      d.sector.textContent = SE.SECTOR_BY_ID[w.sectorId].name;

      const fleet = w.registry.all.filter(s => s.owned && !s.isPlayer && !s.dead);
      let html = '';
      for (const s of fleet) {
        const o = s.orders[0];
        const what = !o ? 'IDLE' : (o.type === 'MINE' ? 'MINING' : o.type);
        const sel = s.id === this.radar.selected;
        const hp = Math.round(100 * s.hull / s.hullMax);
        html += '<li class="' + (sel ? 'sel' : '') + '" data-id="' + s.id + '">' +
          '<b>' + s.name + '</b><span>' + what + '</span>' +
          '<i style="width:' + hp + '%"></i></li>';
      }
      if (d.fleet.innerHTML !== html) {
        d.fleet.innerHTML = html;
        d.fleet.querySelectorAll('li').forEach(li => li.addEventListener('click', () => {
          const id = li.dataset.id;
          this.radar.selected = this.radar.selected === id ? null : id;
          const s = w.get(id);
          this.say(this.radar.selected ? 'COMMANDING ' + s.name.toUpperCase() : 'SELECTION CLEARED');
        }));
      }
    }

    /* ---- Saving ---------------------------------------------------------- */
    autosave() {
      const snap = SE.snapshot(this.world);
      this.persist.save(snap).then(bytes => {
        if (bytes) this.say('SAVED — ' + Math.round(bytes / 1024) + ' KB');
      }).catch(err => this.say('SAVE FAILED: ' + err.message));
    }

    async restore() {
      let data = null;
      try { data = await this.persist.load(); }
      catch (err) { this.say('SAVE UNREADABLE — STARTING FRESH'); return; }
      if (!data || data.seed !== this.world.seed) return;
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
          cargo: r.cargo || {}, credits: r.credits || 0, orders: r.orders || [], dead: !!r.dead
        });
        w.registry.add(s);
      });
      w.credits = data.credits;
      w.elapsed = data.elapsed || 0;
      w.stationStock = data.stations || {};
      this.enterSector(data.sector || 'home');
      // Belt deltas last: the belt only exists once the sector is built.
      if (w.belt && data.belt) {
        for (let i = 0; i < data.belt.length; i += 2) {
          const idx = data.belt[i], remaining = data.belt[i + 1];
          w.belt.take(idx, Math.max(0, w.belt.ore[idx] - remaining));
        }
      }
      this.say('COMMANDER FILE RESTORED');
      window.SE_RESTORED = true;
    }
  }

  SE.SectorScene = SectorScene;
  SE.boot = function () {
    E.PhysicsLoader('vendor/ammo', () => {
      window.SE_GAME = new Phaser.Game({
        type: Phaser.WEBGL,
        transparent: true,
        scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
        scene: [SectorScene],
        ...E.Canvas()
      });
    });
  };
})(window.SE = window.SE || {});
