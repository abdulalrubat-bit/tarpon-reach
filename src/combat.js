/* Guns, wreckage and the tractor beam.
 *
 * Projectiles do not get rigid bodies. A pulse round lives about two seconds,
 * never rests, never stacks and never needs to be pushed by anything — all it
 * has to do is travel in a straight line and notice when it has reached
 * something. Handing that to Ammo means a broadphase entry, an island, and a
 * contact manifold per shot, to answer a question a dot product answers for
 * free. So the rounds are integrated by hand and tested against the sector's
 * ship list, which is thirty entries, not ten thousand.
 *
 * Salvage crates are the opposite case and do get bodies: they are supposed to
 * tumble out of an explosion, bounce off the hull that dropped them and drift,
 * and all of that is what a physics engine is for.
 *
 * Both are pooled. Nothing here allocates after boot.
 */
(function (SE) {
  'use strict';

  const MAX_SHOTS = 260;
  const MAX_CRATES = 40;
  const TRACTOR_RANGE = 150;
  const TRACTOR_GRAB = 22;

  function Combat(third, E, ctx) {
    const THREE = E.THREE;

    /* ---- Rounds -------------------------------------------------------
       One InstancedMesh for every round in flight from every ship in the
       sector. A pool slot's index IS its instance index, so firing is writing
       one matrix and expiring is writing a zero-scale one. */
    const shotGeo = new THREE.CylinderGeometry(0.22, 0.22, 5.2, 5);
    shotGeo.rotateX(Math.PI / 2);          // lie along -Z, the way ships face
    const shotMat = new THREE.MeshBasicMaterial({ color: 0xbfe9ff });
    const shotMesh = new THREE.InstancedMesh(shotGeo, shotMat, MAX_SHOTS);
    shotMesh.frustumCulled = false;
    shotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    third.scene.add(shotMesh);
    // Per-instance colour, so a scrapper's guns and yours are different
    // tracers without being different meshes or different draw calls.
    shotMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHOTS * 3), 3);
    shotMat.vertexColors = false;

    const HIDDEN = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
    for (let i = 0; i < MAX_SHOTS; i++) shotMesh.setMatrixAt(i, HIDDEN);
    shotMesh.instanceMatrix.needsUpdate = true;

    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(1, 1, 1);
    const _up = new THREE.Vector3(0, 0, -1);
    const _dir = new THREE.Vector3();
    const _mu = new THREE.Vector3();
    const _col = new THREE.Color();

    const shots = SE.Pool(MAX_SHOTS,
      i => ({ i, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, vx: 0, vy: 0, vz: 0, speed: 0, life: 0, dmg: 0, owner: null, faction: '' }),
      s => { s.life = 0; s.owner = null; shotMesh.setMatrixAt(s.i, HIDDEN); shotMesh.instanceMatrix.needsUpdate = true; }
    );

    function fire(ship, aimX, aimY, aimZ) {
      const cls = SE.CLASSES[ship.cls];
      const w = SE.WEAPONS[cls.weapon];
      if (ship.cool > 0) return false;
      ship.cool = 1 / w.rate;

      // Fixed guns fire down the nose; tracking guns are laid on the target,
      // which is the entire mechanical difference between the two on this
      // scale. The test used to be `weapon === 'turret'`, which quietly meant
      // "any gun I have not written yet fires straight ahead" — including six
      // emplacement guns bolted to a head that visibly swivels.
      if (w.tracks && aimX !== undefined) {
        _dir.set(aimX - ship.x, aimY - ship.y, aimZ - ship.z).normalize();
      } else {
        const f = SE.AI.forward(ship, { x: 0, y: 0, z: 0 });
        _dir.set(f.x, f.y, f.z);
      }

      /* Emplacements shoot from the top of a column, not from the middle of
         their footing. Without this the rounds leave from inside the base and
         a platform firing over its own shoulder puts the first round through
         its own plinth — which the swept collision test would happily count
         as a hit on whatever was behind it. */
      let mx = 0, my = 0, mz = 0;
      if (cls.muzzleY) {
        _q.set(ship.qx, ship.qy, ship.qz, ship.qw);
        _mu.set(0, cls.muzzleY, 0).applyQuaternion(_q);
        mx = _mu.x; my = _mu.y; mz = _mu.z;
      }

      const n = Math.max(1, cls.hardpoints);
      for (let k = 0; k < n; k++) {
        const sh = shots.take();
        sh.owner = ship.id;
        sh.faction = ship.faction;
        sh.dmg = w.damage;
        sh.speed = w.speed;
        sh.life = w.life;
        // Hardpoints spread across the hull, so a two-gun interceptor visibly
        // fires two streams rather than one doubled one.
        const off = (k - (n - 1) / 2) * cls.size * 0.55;
        const rx = -_dir.z, rz = _dir.x;                // right vector, flat
        const rl = Math.hypot(rx, rz) || 1;
        sh.x = ship.x + mx + rx / rl * off;
        sh.y = ship.y + my;
        sh.z = ship.z + mz + rz / rl * off;
        const sp = w.spread;
        sh.dx = _dir.x + (Math.random() - 0.5) * sp;
        sh.dy = _dir.y + (Math.random() - 0.5) * sp;
        sh.dz = _dir.z + (Math.random() - 0.5) * sp;
        const l = Math.hypot(sh.dx, sh.dy, sh.dz) || 1;
        sh.dx /= l; sh.dy /= l; sh.dz /= l;
        // Inherit the shooter's velocity, or shots from a ship at full burn
        // appear to fall behind it.
        sh.vx = ship.vx; sh.vy = ship.vy; sh.vz = ship.vz;
        _col.setHex(ship.faction === 'player' ? 0xbfe9ff : (SE.FACTIONS[ship.faction] || {}).colour || 0xffffff);
        shotMesh.instanceColor.setXYZ(sh.i, _col.r, _col.g, _col.b);
      }
      shotMesh.instanceColor.needsUpdate = true;
      return true;
    }

    function stepShots(dt, ships) {
      let dirty = false;
      shots.forEachLive(sh => {
        sh.life -= dt;
        if (sh.life <= 0) { shots.give(sh); dirty = true; return; }
        // Where it was, before it moved. The whole hit test depends on this.
        const ox = sh.x, oy = sh.y, oz = sh.z;
        const step = sh.speed * dt;
        sh.x += sh.dx * step + sh.vx * dt;
        sh.y += sh.dy * step + sh.vy * dt;
        sh.z += sh.dz * step + sh.vz * dt;
        const mx = sh.x - ox, my = sh.y - oy, mz = sh.z - oz;
        const mm = mx * mx + my * my + mz * mz;

        /* SWEPT hit test: the segment the round travelled this step against
           the target sphere, not the point it happened to land on.
           This was a point test, and it did not work at all. A pulse round
           covers sixteen metres per simulation step at the clamped timestep;
           an interceptor's hit sphere is three metres across. The round
           teleported straight past it, every time. Measured on the real build:
           240 rounds fired point blank down the nose at a stationary target,
           zero hits, a 0.0% hit rate.
           It also explains the other half of the same bug report. A station's
           hit sphere is forty-one metres — bigger than the step — so rounds
           landed on stations perfectly well. Small things were invulnerable,
           large things were not, so the AI ground the station down while
           nothing the station or anyone else fired could kill a ship. */
        for (let i = 0; i < ships.length; i++) {
          const t = ships[i];
          if (t.dead || t.id === sh.owner) continue;
          /* Rounds only bite things the shooter is actually at war with.
             It used to be "not my own faction", which meant everything neutral
             was a backstop: flying at a pirate with the Apex station somewhere
             behind it poured the whole burst into the station, and pirates
             shooting at haulers parked near it did the same. A trade hub being
             ground down by crossfire nobody aimed at it is not a war, it is a
             bug with a body count. */
          if (!SE.hostile(sh.faction, t.faction)) continue;
          const r = SE.CLASSES[t.cls].size * 0.9;
          // closest approach of the travelled segment to the target centre
          const fx = ox - t.x, fy = oy - t.y, fz = oz - t.z;
          let u = mm > 1e-6 ? -(fx * mx + fy * my + fz * mz) / mm : 0;
          u = u < 0 ? 0 : (u > 1 ? 1 : u);
          const cx = fx + mx * u, cy = fy + my * u, cz = fz + mz * u;
          if (cx * cx + cy * cy + cz * cz < r * r) {
            SE.damage(t, sh.dmg);
            if (ctx.onHit) ctx.onHit(t, sh);
            shots.give(sh);
            dirty = true;
            return;
          }
        }

        _p.set(sh.x, sh.y, sh.z);
        _dir.set(sh.dx, sh.dy, sh.dz);
        _q.setFromUnitVectors(_up, _dir);
        _m.compose(_p, _q, _s);
        shotMesh.setMatrixAt(sh.i, _m);
        dirty = true;
      });
      if (dirty) shotMesh.instanceMatrix.needsUpdate = true;
    }

    /* ---- Salvage ------------------------------------------------------
       Real bodies, thrown outward on an impulse. A wreck that simply awards
       credits is a number; a wreck that sprays crates you have to go and
       collect is a decision about whether the fight was worth it. */
    const crateGeo = new THREE.BoxGeometry(2.6, 2.6, 2.6);
    const crateMat = new THREE.MeshLambertMaterial({ color: 0xc8a552, emissive: 0x4a3a10, emissiveIntensity: 0.8 });

    const crates = SE.Pool(MAX_CRATES,
      i => {
        const o = new E.ExtendedObject3D();
        o.name = 'crate' + i;
        o.add(new THREE.Mesh(crateGeo, crateMat));
        o.position.set(0, -99999, 0);
        third.add.existing(o);
        third.physics.add.existing(o, { shape: 'box', width: 2.6, height: 2.6, depth: 2.6, mass: 2 });
        if (o.body) {
          o.body.setGravity(0, 0, 0);
          o.body.setDamping(0.12, 0.2);
          o.body.setRestitution(0.4);
        }
        return { i, obj: o, good: 'scrap', qty: 0, ttl: 0 };
      },
      c => {
        c.qty = 0; c.ttl = 0;
        c.obj.visible = false;
        // Parked far below the sector rather than destroyed. A pooled body is
        // only cheap if it stays in the world; taking it out and putting it
        // back is the allocation the pool exists to avoid.
        SE.placeBody(c.obj.body, 0, -99999, 0);
        c.obj.position.set(0, -99999, 0);
      }
    );
    crates.items.forEach(c => { c.obj.visible = false; });

    function scatter(x, y, z, count, good, qtyEach) {
      for (let k = 0; k < count; k++) {
        const c = crates.take();
        c.good = good;
        c.qty = qtyEach;
        c.ttl = 180;                 // crates are not forever, or a long fight litters the sector
        c.obj.visible = true;
        const cxp = x + (Math.random() - 0.5) * 6;
        const cyp = y + (Math.random() - 0.5) * 6;
        const czp = z + (Math.random() - 0.5) * 6;
        c.obj.position.set(cxp, cyp, czp);
        if (c.obj.body) {
          SE.placeBody(c.obj.body, cxp, cyp, czp);
          const imp = 26;
          c.obj.body.applyCentralImpulse(
            (Math.random() - 0.5) * imp, (Math.random() - 0.5) * imp, (Math.random() - 0.5) * imp);
          c.obj.body.setAngularVelocity((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
        }
      }
    }

    /* Tractor beam. Pull strength falls off with distance, so a crate right
       on the nose snaps in and one at the edge of range drifts over — which
       makes flying closer a thing worth doing rather than a formality. */
    function stepCrates(dt, collectors) {
      crates.forEachLive(c => {
        c.ttl -= dt;
        if (c.ttl <= 0) { crates.give(c); return; }
        const p = c.obj.position;
        for (let i = 0; i < collectors.length; i++) {
          const s = collectors[i];
          if (s.dead) continue;
          const dx = s.x - p.x, dy = s.y - p.y, dz = s.z - p.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > TRACTOR_RANGE * TRACTOR_RANGE) continue;
          const d = Math.sqrt(d2) || 1;
          if (d < TRACTOR_GRAB) {
            const took = SE.addCargo(s, c.good, c.qty);
            if (took > 0 && ctx.onSalvage) ctx.onSalvage(s, c.good, took);
            crates.give(c);
            return;
          }
          if (c.obj.body) {
            const pull = 120 * (1 - d / TRACTOR_RANGE);
            c.obj.body.applyCentralForce(dx / d * pull, dy / d * pull, dz / d * pull);
          }
          break;
        }
      });
    }

    function destroy() {
      shots.releaseAll();
      crates.releaseAll();
      third.scene.remove(shotMesh);
      shotGeo.dispose(); shotMat.dispose();
      crates.items.forEach(c => { if (c.obj.body) third.physics.destroy(c.obj); third.scene.remove(c.obj); });
      crateGeo.dispose(); crateMat.dispose();
    }

    return { fire, stepShots, stepCrates, scatter, destroy, shots, crates, TRACTOR_RANGE };
  }

  SE.Combat = Combat;
})(window.SE = window.SE || {});
