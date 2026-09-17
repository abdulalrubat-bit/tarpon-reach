/* ShipPhysicsView — the other half of the split.
 *
 * A view is a Three.js group and an Ammo rigid body bolted onto a ShipState
 * for exactly as long as that state is in the sector the player is flying in.
 * It exists to be deleted. Attach on entry, sync both ways every frame, detach
 * on exit and the state carries on as arithmetic with no idea anything
 * happened.
 *
 * The sync direction matters and is not symmetric. While a view exists the
 * rigid body is the authority on where the ship is: physics writes into the
 * state each frame. The state is the authority on everything physics does not
 * model — hull, shields, hold, orders — and on the transform only at the two
 * moments of attach and detach.
 *
 * Geometry and materials are built once per hull class and shared by every
 * ship of that class. Forty interceptors are forty transforms over one set of
 * buffers; building forty copies is how a phone runs out of memory politely.
 */
(function (SE) {
  'use strict';

  let THREE = null;
  const geoCache = Object.create(null);
  const matCache = Object.create(null);

  function mat(colour, emissive, emissiveIntensity) {
    const key = colour + ':' + (emissive || 0) + ':' + (emissiveIntensity || 0);
    if (!matCache[key]) {
      matCache[key] = new THREE.MeshLambertMaterial({
        color: colour,
        emissive: emissive || 0x000000,
        emissiveIntensity: emissiveIntensity === undefined ? 1 : emissiveIntensity
      });
    }
    return matCache[key];
  }

  function geo(key, build) {
    if (!geoCache[key]) geoCache[key] = build();
    return geoCache[key];
  }

  /* ---- Hulls ----------------------------------------------------------
     Drawn from primitives, no model files. Each returns { parts, collision },
     where collision is the compound box list Ammo gets — always simpler than
     what you can see, because a collision hull that matches the silhouette
     exactly is a collision hull that costs four times as much and plays worse.
  */
  function buildHull(clsId, colour) {
    const body = mat(0x9aa4b2);
    const dark = mat(0x3b434f);
    const trim = mat(colour, colour, 0.55);
    const glow = mat(0x2a2f38, 0x66e0ff, 0.9);
    const parts = [];
    let collision;

    const push = (m, x, y, z, rx, ry, rz) => {
      m.position.set(x, y, z);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      parts.push(m);
      return m;
    };

    switch (clsId) {
      case 'interceptor': {
        push(new THREE.Mesh(geo('i-body', () => new THREE.ConeGeometry(1.1, 6.2, 6)), body), 0, 0, 0, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('i-wing', () => new THREE.BoxGeometry(6.4, 0.3, 1.7)), dark), 0, -0.1, 0.9);
        push(new THREE.Mesh(geo('i-fin', () => new THREE.BoxGeometry(0.28, 1.5, 1.4)), trim), 0, 0.75, 1.5);
        push(new THREE.Mesh(geo('i-eng', () => new THREE.CylinderGeometry(0.5, 0.62, 0.7, 8)), glow), 0, 0, 3.2, Math.PI / 2, 0, 0);
        collision = [{ shape: 'box', width: 6.4, height: 1.6, depth: 6.4 }];
        break;
      }
      case 'corvette': {
        push(new THREE.Mesh(geo('c-body', () => new THREE.BoxGeometry(2.6, 1.9, 8.4)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('c-nose', () => new THREE.ConeGeometry(1.3, 3.4, 6)), body), 0, 0, -5.4, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-nac', () => new THREE.CylinderGeometry(0.6, 0.6, 5.2, 8)), dark), 2.6, 0, 1.1, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-nac', () => new THREE.CylinderGeometry(0.6, 0.6, 5.2, 8)), dark), -2.6, 0, 1.1, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-strip', () => new THREE.BoxGeometry(0.4, 0.22, 6.2)), trim), 1.45, 0.9, 0.2);
        push(new THREE.Mesh(geo('c-strip', () => new THREE.BoxGeometry(0.4, 0.22, 6.2)), trim), -1.45, 0.9, 0.2);
        push(new THREE.Mesh(geo('c-eng', () => new THREE.CylinderGeometry(0.62, 0.72, 0.6, 8)), glow), 2.6, 0, 3.9, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-eng', () => new THREE.CylinderGeometry(0.62, 0.72, 0.6, 8)), glow), -2.6, 0, 3.9, Math.PI / 2, 0, 0);
        collision = [{ shape: 'box', width: 6.2, height: 2.4, depth: 11 }];
        break;
      }
      case 'extractor': {
        push(new THREE.Mesh(geo('e-body', () => new THREE.BoxGeometry(6.4, 5.2, 12.4)), body), 0, 0, 1.4);
        push(new THREE.Mesh(geo('e-drill', () => new THREE.ConeGeometry(2.1, 5.6, 8)), dark), 0, 0, -7.4, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('e-ring', () => new THREE.TorusGeometry(2.4, 0.42, 6, 12)), trim), 0, 0, -4.6);
        push(new THREE.Mesh(geo('e-hold', () => new THREE.BoxGeometry(4.4, 3.4, 4.6)), dark), 0, 0.2, 6.2);
        push(new THREE.Mesh(geo('e-eng', () => new THREE.CylinderGeometry(1.1, 1.35, 1.1, 8)), glow), 2.1, 0, 8.8, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('e-eng', () => new THREE.CylinderGeometry(1.1, 1.35, 1.1, 8)), glow), -2.1, 0, 8.8, Math.PI / 2, 0, 0);
        collision = [{ shape: 'box', width: 6.6, height: 5.4, depth: 20 }];
        break;
      }
      case 'freighter': {
        push(new THREE.Mesh(geo('f-spine', () => new THREE.BoxGeometry(3.2, 3.2, 22)), dark), 0, 0, 0);
        push(new THREE.Mesh(geo('f-cab', () => new THREE.BoxGeometry(5.2, 4.2, 5.4)), body), 0, 0.6, -10.4);
        for (let i = 0; i < 3; i++) {
          push(new THREE.Mesh(geo('f-can', () => new THREE.BoxGeometry(4.2, 4.2, 4.6)), body), 3.8, 0, -1.6 + i * 5.2);
          push(new THREE.Mesh(geo('f-can', () => new THREE.BoxGeometry(4.2, 4.2, 4.6)), body), -3.8, 0, -1.6 + i * 5.2);
        }
        push(new THREE.Mesh(geo('f-strip', () => new THREE.BoxGeometry(0.5, 0.3, 20)), trim), 0, 1.8, 0);
        push(new THREE.Mesh(geo('f-eng', () => new THREE.CylinderGeometry(1.4, 1.7, 1.4, 8)), glow), 0, 0, 12, Math.PI / 2, 0, 0);
        collision = [{ shape: 'box', width: 11.8, height: 4.6, depth: 24 }];
        break;
      }
      case 'dreadnought': {
        // Compound hull, as the brief asks: a spine, a raised bridge and four
        // sponsons. Ammo gets five boxes; the eye gets a warship.
        push(new THREE.Mesh(geo('d-spine', () => new THREE.BoxGeometry(11, 7, 54)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('d-prow', () => new THREE.ConeGeometry(5.6, 14, 6)), body), 0, 0, -32, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-bridge', () => new THREE.BoxGeometry(7, 5, 12)), dark), 0, 5.4, 12);
        push(new THREE.Mesh(geo('d-spon', () => new THREE.BoxGeometry(5, 4.4, 20)), dark), 8.6, -0.6, -2);
        push(new THREE.Mesh(geo('d-spon', () => new THREE.BoxGeometry(5, 4.4, 20)), dark), -8.6, -0.6, -2);
        for (let i = 0; i < 4; i++) {
          const sx = i < 2 ? 6.2 : -6.2, sz = (i % 2) ? -12 : 6;
          push(new THREE.Mesh(geo('d-tur', () => new THREE.CylinderGeometry(1.7, 2.1, 1.8, 8)), trim), sx, 4.1, sz);
        }
        push(new THREE.Mesh(geo('d-eng', () => new THREE.CylinderGeometry(3.1, 3.7, 3, 10)), glow), 3.6, 0, 28.6, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-eng', () => new THREE.CylinderGeometry(3.1, 3.7, 3, 10)), glow), -3.6, 0, 28.6, Math.PI / 2, 0, 0);
        collision = [
          { shape: 'box', width: 11, height: 7, depth: 54 },
          { shape: 'box', width: 5, height: 4.4, depth: 20, x: 8.6, y: -0.6, z: -2 },
          { shape: 'box', width: 5, height: 4.4, depth: 20, x: -8.6, y: -0.6, z: -2 },
          { shape: 'box', width: 7, height: 5, depth: 12, x: 0, y: 5.4, z: 12 },
          { shape: 'box', width: 8, height: 7, depth: 12, x: 0, y: 0, z: -32 }
        ];
        break;
      }
      case 'station':
      default: {
        push(new THREE.Mesh(geo('st-core', () => new THREE.CylinderGeometry(13, 13, 34, 12)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('st-ring', () => new THREE.TorusGeometry(40, 4.4, 8, 24)), dark), 0, 0, 0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('st-cap', () => new THREE.CylinderGeometry(7, 13, 9, 12)), dark), 0, 20, 0);
        push(new THREE.Mesh(geo('st-cap', () => new THREE.CylinderGeometry(13, 7, 9, 12)), dark), 0, -20, 0);
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2;
          push(new THREE.Mesh(geo('st-spoke', () => new THREE.BoxGeometry(2.6, 2.6, 28)), dark),
            Math.cos(a) * 26, 0, Math.sin(a) * 26, 0, -a, 0);
        }
        push(new THREE.Mesh(geo('st-lamp', () => new THREE.TorusGeometry(13.4, 0.9, 6, 16)), trim), 0, 9, 0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('st-lamp', () => new THREE.TorusGeometry(13.4, 0.9, 6, 16)), trim), 0, -9, 0, Math.PI / 2, 0, 0);
        collision = [
          { shape: 'box', width: 26, height: 44, depth: 26 },
          { shape: 'box', width: 88, height: 9, depth: 9 },
          { shape: 'box', width: 9, height: 9, depth: 88 }
        ];
        break;
      }
    }
    return { parts, collision };
  }

  /* ---- attach / detach ------------------------------------------------ */

  function ShipPhysicsView(third, E, ship) {
    THREE = E.THREE;
    const cls = SE.CLASSES[ship.cls];
    const colour = (SE.FACTIONS[ship.faction] || SE.FACTIONS.player).colour;

    const obj = new E.ExtendedObject3D();
    obj.name = ship.id;
    const hull = buildHull(cls.id, colour);
    hull.parts.forEach(p => obj.add(p));

    // The state is the authority at exactly this moment, and not again until
    // detach.
    obj.position.set(ship.x, ship.y, ship.z);
    obj.quaternion.set(ship.qx, ship.qy, ship.qz, ship.qw);
    third.add.existing(obj);

    const isStructure = cls.tier === 'structure';
    third.physics.add.existing(obj, {
      mass: isStructure ? 0 : cls.mass,
      collisionFlags: isStructure ? 1 : 0,       // 1 = static
      shape: hull.collision.length > 1 ? 'box' : 'box',
      compound: hull.collision.length > 1 ? hull.collision : [],
      width: hull.collision[0].width,
      height: hull.collision[0].height,
      depth: hull.collision[0].depth
    });

    const body = obj.body;
    if (body) {
      // Space: no gravity anywhere, and near-zero drag. The AI's own retro
      // burn and top-speed bleed do all the slowing down, so that a ship at
      // full throttle with the stick let go keeps its velocity like a ship in
      // a vacuum rather than gliding to a stop like a boat.
      body.setGravity(0, 0, 0);
      body.setDamping(0.02, 0.62);
      if (!isStructure) {
        body.setVelocity(ship.vx, ship.vy, ship.vz);
        // Ammo parks a body that has been nearly still for two seconds. A
        // docked wingman waiting for an order is exactly that, and a parked
        // body ignores the force that would wake it up.
        if (body.ammo && body.ammo.setActivationState) body.ammo.setActivationState(4);
      }
    }

    return {
      ship, obj, body,
      isStructure,

      /* Physics -> state. Called once per frame for every ship in the sector,
         so it reads the body's cached transform rather than asking Ammo. */
      pull() {
        const p = obj.position, q = obj.quaternion;
        ship.x = p.x; ship.y = p.y; ship.z = p.z;
        ship.qx = q.x; ship.qy = q.y; ship.qz = q.z; ship.qw = q.w;
        if (body && !isStructure) {
          const v = body.velocity;
          ship.vx = v.x; ship.vy = v.y; ship.vz = v.z;
        }
      },

      destroy() {
        // Order matters: the rigid body has to leave the world before the mesh
        // leaves the scene, or Ammo keeps stepping a body whose transform
        // nothing reads and the leak is invisible until the fourth sector.
        if (obj.body) third.physics.destroy(obj);
        third.scene.remove(obj);
        // Geometry and materials are shared per class and deliberately NOT
        // disposed here — the next ship of this class wants them.
        obj.clear();
      }
    };
  }

  /* Teleporting a rigid body.
   *
   * Setting obj.position and raising body.needUpdate looks like it should do
   * this, and for a KINEMATIC body it does — but enable3d only honours
   * needUpdate for kinematic objects, so on a dynamic or static body it is
   * silently ignored and Ammo writes its own stale transform back over yours
   * on the next frame. The symptom is an object that appears where you put it
   * for exactly one frame and then snaps back.
   *
   * The sequence below goes through the motion state directly, which works for
   * any body type: read the current transform into the physics scratch, move
   * it, write it back, then clear the velocities so the body does not carry
   * its old momentum into its new position, and wake it so the solver looks at
   * it at all.
   */
  function placeBody(body, x, y, z) {
    if (!body || !body.ammo) return;
    // transform() fills the physics world's scratch btTransform from this
    // body's motion state; setPosition() moves that scratch's origin.
    body.transform();
    body.setPosition(x, y, z);
    const t = body.physics.worldTransform;
    // The motion state alone is not enough. Bullet reads it for KINEMATIC
    // bodies and writes it for dynamic ones — a dynamic body's authority is
    // its own world transform, so setting only the motion state moves nothing
    // and the next frame reports the old position straight back. Set both.
    body.ammo.setWorldTransform(t);
    const ms = body.ammo.getMotionState();
    if (ms) ms.setWorldTransform(t);
    if (body.ammo.clearForces) body.ammo.clearForces();
    body.setVelocity(0, 0, 0);
    body.setAngularVelocity(0, 0, 0);
    if (body.ammo.activate) body.ammo.activate();
  }

  SE.ShipPhysicsView = ShipPhysicsView;
  SE.placeBody = placeBody;
  SE.viewMaterial = c => mat(c);
})(window.SE = window.SE || {});
