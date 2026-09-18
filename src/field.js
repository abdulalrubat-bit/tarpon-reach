/* The belt: ten thousand rocks, one draw call.
 *
 * Every asteroid in the sector is an instance of one geometry in one
 * THREE.InstancedMesh. The GPU is told the shape once and the transforms in
 * bulk, and the whole belt costs the renderer a single draw. The alternative —
 * ten thousand Mesh objects — costs ten thousand draws and a matrix update per
 * object per frame, and on a phone it is not slow, it is a slideshow.
 *
 * What that buys in framerate it charges back in indirection: an instance is
 * not an object, so it cannot carry an ore count or a name. The per-rock data
 * lives in parallel typed arrays indexed by ROCK id, and the bridge between a
 * tap on the glass and a row in those arrays is raycasting against the
 * instanced mesh, reading intersection.instanceId, and mapping it back.
 *
 * That mapping exists because the mesh does not hold all ten thousand rocks.
 * It holds a window of up to CAP of them — the ones near the camera and
 * roughly in front of it — repacked when the view has moved enough to matter.
 * One draw call either way, but a bounded one: a rock two kilometres behind
 * the player, on the far side of opaque fog, costs nothing instead of costing
 * the same as one filling the screen. The full ten thousand still exist as
 * data, are still mined, saved and searched; they are simply not all drawn.
 *
 * Collision uses the same trick as ships. Ten thousand rigid bodies is not a
 * thing anyone can afford, so a small pool of static Ammo spheres is parked on
 * whichever rocks are currently near the player and recycled as they pass.
 */
(function (SE) {
  'use strict';

  const COUNT = 10000;        // rocks that exist
  const CAP = 3200;           // rocks that can be on screen at once
  const DRAW_R = 1500;        // cull radius, metres — matches the far fog
  const BEHIND = -0.42;       // cone test: how far past the edge of view to keep
  const REPACK_MOVE = 40;     // metres of travel before the window is rebuilt
  const REPACK_TURN = 0.12;   // radians of turn before the same

  const NEAR_BODIES = 22;     // rocks that are solid at any one time
  const NEAR_RADIUS = 240;    // metres within which a rock earns a body
  const ORE_MIN_SCALE = 7.4;  // rocks this big carry ore worth stopping for

  function Belt(third, E, seedStr) {
    const THREE = E.THREE;
    const rng = SE.Rng(seedStr + ':belt');

    // Parallel arrays, not objects. Ten thousand little objects is ten
    // thousand allocations and a cache miss on every one; typed arrays are
    // contiguous runs the CPU can actually stream.
    const px = new Float32Array(COUNT);
    const py = new Float32Array(COUNT);
    const pz = new Float32Array(COUNT);
    const sc = new Float32Array(COUNT);
    const ore = new Float32Array(COUNT);
    const oreMax = new Float32Array(COUNT);
    const mats = new Float32Array(COUNT * 16);   // every rock's transform, packed
    const oreIdx = [];

    const geo = new THREE.IcosahedronGeometry(1, 0);
    // A flat-shaded icosahedron is twenty triangles and reads as a rock from
    // any distance a player will ever see one at. Subdividing it once is four
    // times the triangles for a silhouette nobody can tell apart.
    const matr = new THREE.MeshLambertMaterial({ color: 0x7e7466, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, matr, CAP);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;   // the window below is the culling
    mesh.name = 'belt';
    mesh.count = 0;

    const m4 = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const vp = new THREE.Vector3();
    const vs = new THREE.Vector3();

    for (let i = 0; i < COUNT; i++) {
      // A torus band, thicker in the middle: density that falls off toward the
      // edges is the difference between a belt and a cylinder of gravel.
      const a = rng.float(0, Math.PI * 2);
      const t = rng.next();
      const r = SE.BELT_INNER + (SE.BELT_OUTER - SE.BELT_INNER) * t;
      const thick = 90 * (1 - Math.abs(t - 0.5) * 1.4);
      px[i] = Math.cos(a) * r + rng.float(-30, 30);
      py[i] = rng.float(-thick, thick);
      pz[i] = Math.sin(a) * r + rng.float(-30, 30);
      // Mostly gravel, occasionally something worth flying to.
      sc[i] = rng.next() < 0.055 ? rng.float(7.4, 17) : rng.float(1.1, 5.2);
      if (sc[i] >= ORE_MIN_SCALE) {
        oreMax[i] = Math.round(sc[i] * rng.float(9, 17));
        ore[i] = oreMax[i];
        oreIdx.push(i);
      }
      eu.set(rng.float(0, 6.28), rng.float(0, 6.28), rng.float(0, 6.28));
      qt.setFromEuler(eu);
      vp.set(px[i], py[i], pz[i]);
      // Slightly irregular scaling, so a belt of identical icosahedra does not
      // read as a belt of identical icosahedra.
      vs.set(sc[i] * rng.float(0.75, 1.25), sc[i] * rng.float(0.75, 1.25), sc[i] * rng.float(0.75, 1.25));
      m4.compose(vp, qt, vs);
      m4.toArray(mats, i * 16);
    }
    third.scene.add(mesh);

    /* ---- A spatial grid over the rocks ---------------------------------
       Built once, because a rock never moves. Without it, every question of
       the form "what is near this point" was a scan of all ten thousand —
       updateBodies did exactly that once a frame, and the AI could not afford
       to ask at all, which is why ships flew into the belt and wedged
       themselves in it.

       Only rocks big enough to matter go in. Gravel is scenery: you cannot hit
       it and you do not need to steer around it. */
    const CELL = 128;
    const grid = new Map();
    const cellKey = (ix, iy, iz) => ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
    let gridded = 0;
    for (let i = 0; i < COUNT; i++) {
      if (sc[i] < 2.4) continue;
      const k = cellKey(Math.floor(px[i] / CELL), Math.floor(py[i] / CELL), Math.floor(pz[i] / CELL));
      let cell = grid.get(k);
      if (!cell) { cell = []; grid.set(k, cell); }
      cell.push(i);
      gridded++;
    }

    // Indices of substantial rocks within `radius` of a point, appended to
    // `out` and capped, so a caller can never be handed unbounded work.
    function near(x, y, z, radius, out, cap) {
      out.length = 0;
      const r2 = radius * radius;
      const x0 = Math.floor((x - radius) / CELL), x1 = Math.floor((x + radius) / CELL);
      const y0 = Math.floor((y - radius) / CELL), y1 = Math.floor((y + radius) / CELL);
      const z0 = Math.floor((z - radius) / CELL), z1 = Math.floor((z + radius) / CELL);
      for (let ix = x0; ix <= x1; ix++)
        for (let iy = y0; iy <= y1; iy++)
          for (let iz = z0; iz <= z1; iz++) {
            const cell = grid.get(cellKey(ix, iy, iz));
            if (!cell) continue;
            for (let n = 0; n < cell.length; n++) {
              const i = cell[n];
              if (ore[i] <= 0 && oreMax[i] > 0) continue;
              const dx = px[i] - x, dy = py[i] - y, dz = pz[i] - z;
              if (dx * dx + dy * dy + dz * dz < r2) {
                out.push(i);
                if (out.length >= cap) return out;
              }
            }
          }
      return out;
    }

    /* ---- The visible window --------------------------------------------
       slot -> rock id, so a raycast hit can be turned back into a row in the
       arrays above. Rebuilt only when the camera has actually moved or turned;
       repacking every frame would upload the whole buffer sixty times a second
       to answer a question whose answer barely changes. */
    const slotRock = new Int32Array(CAP).fill(-1);
    const rockSlot = new Int32Array(COUNT).fill(-1);
    const cand = new Int32Array(COUNT);
    const candD = new Float32Array(COUNT);
    let lastX = NaN, lastY = 0, lastZ = 0, lastFx = 0, lastFy = 0, lastFz = 0;

    function repack(cx, cy, cz, fx, fy, fz, force) {
      if (!force) {
        const moved = Math.hypot(cx - lastX, cy - lastY, cz - lastZ);
        const turned = 1 - (fx * lastFx + fy * lastFy + fz * lastFz);
        if (moved < REPACK_MOVE && turned < REPACK_TURN * REPACK_TURN * 0.5) return;
      }
      lastX = cx; lastY = cy; lastZ = cz; lastFx = fx; lastFy = fy; lastFz = fz;

      const r2 = DRAW_R * DRAW_R;
      let n = 0;
      for (let i = 0; i < COUNT; i++) {
        if (ore[i] <= 0 && oreMax[i] > 0) continue;        // mined out, scaled to nothing
        const dx = px[i] - cx, dy = py[i] - cy, dz = pz[i] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        // Behind the camera by more than a generous margin: never drawn. The
        // margin is what stops rocks popping in at the edge of the screen when
        // the ship yaws.
        if (d2 > 900) {
          const inv = 1 / Math.sqrt(d2);
          if ((dx * fx + dy * fy + dz * fz) * inv < BEHIND) continue;
        }
        cand[n] = i; candD[n] = d2; n++;
      }

      // More candidates than slots: keep the nearest. A partial selection
      // would be neater; a full sort of a few thousand ints a few times a
      // second is already lost in the noise, and this is the version that is
      // obviously correct.
      let list;
      if (n > CAP) {
        const order = new Array(n);
        for (let k = 0; k < n; k++) order[k] = k;
        order.sort((a, b) => candD[a] - candD[b]);
        list = order;
      } else list = null;

      const take = Math.min(n, CAP);
      for (let s = 0; s < take; s++) {
        const i = cand[list ? list[s] : s];
        if (slotRock[s] !== i) {
          if (slotRock[s] >= 0) rockSlot[slotRock[s]] = -1;
          slotRock[s] = i;
          rockSlot[i] = s;
        }
        mesh.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), s * 16);
      }
      for (let s = take; s < CAP; s++) {
        if (slotRock[s] >= 0) { rockSlot[slotRock[s]] = -1; slotRock[s] = -1; }
      }
      mesh.count = take;
      mesh.instanceMatrix.needsUpdate = true;
    }

    /* ---- Proximity collision ------------------------------------------
       Static spheres, pooled. Each frame the nearest rocks to the player get
       one; the rest of the belt is scenery you cannot hit because you are
       nowhere near it. */
    const bodies = [];
    for (let i = 0; i < NEAR_BODIES; i++) {
      const o = new E.ExtendedObject3D();
      o.name = 'rockbody' + i;
      o.position.set(0, -99999, 0);
      third.add.existing(o);
      // Unit sphere, always. The rock it is standing in for is whatever size
      // it is, and the shape is scaled to match below rather than rebuilt —
      // rebuilding a collision shape means destroying and re-adding a rigid
      // body, and doing that a few times a second while flying is a hitch.
      //
      // KINEMATIC (flag 2), not static (flag 1), although a rock never moves
      // under its own power. These bodies are constantly re-parked onto
      // whichever rock is nearest, and enable3d only pushes a Three transform
      // into Ammo for kinematic bodies — a static one silently ignores it and
      // the whole belt stays intangible.
      third.physics.add.existing(o, { shape: 'sphere', radius: 1, mass: 0, collisionFlags: 2 });
      if (o.body) {
        o.body.setGravity(0, 0, 0);
        o.body.setRestitution(0.35);
        // A kinematic body that is allowed to sleep stops being re-read, and
        // then it is a rock in the wrong place rather than no rock at all.
        if (o.body.ammo && o.body.ammo.setActivationState) o.body.ammo.setActivationState(4);
      }
      bodies.push({ obj: o, idx: -1, radius: 0 });
    }

    // btCollisionShape::setLocalScaling is the cheap way to resize a shape in
    // place. The AABB has to be refreshed by hand afterwards or broadphase
    // keeps testing against the old one, which shows up as a rock you bounce
    // off from several metres away.
    const _av = (typeof Ammo !== 'undefined') ? new Ammo.btVector3(1, 1, 1) : null;
    function setBodyRadius(slot, r) {
      const b = slot.obj.body;
      if (!b || !b.ammo || !_av) return;
      const shape = b.ammo.getCollisionShape();
      if (!shape || !shape.setLocalScaling) return;
      _av.setValue(r, r, r);
      shape.setLocalScaling(_av);
      const world = third.physics.physicsWorld || third.physics.world;
      if (world && world.updateSingleAabb) world.updateSingleAabb(b.ammo);
      slot.radius = r;
    }

    const nearIdx = new Int32Array(NEAR_BODIES * 8);
    const nearD = new Float32Array(NEAR_BODIES * 8);
    const _scratch = [];
    function updateBodies(cx, cy, cz) {
      // Was a full ten-thousand-rock scan every single frame. The grid turns
      // it into a look at the handful of cells the ship is actually inside.
      near(cx, cy, cz, NEAR_RADIUS, _scratch, nearIdx.length);
      let n = 0;
      for (let k = 0; k < _scratch.length; k++) {
        const i = _scratch[k];
        const dx = px[i] - cx, dy = py[i] - cy, dz = pz[i] - cz;
        nearIdx[n] = i; nearD[n] = dx * dx + dy * dy + dz * dz;
        n++;
      }
      const order = [];
      for (let k = 0; k < n; k++) order.push(k);
      order.sort((a, b) => nearD[a] - nearD[b]);
      for (let b = 0; b < bodies.length; b++) {
        const slot = bodies[b];
        if (b < order.length) {
          const i = nearIdx[order[b]];
          if (slot.idx !== i) {
            slot.idx = i;
            const r = Math.max(1, sc[i] * 0.92);
            slot.obj.position.set(px[i], py[i], pz[i]);
            slot.obj.scale.setScalar(r);
            if (slot.obj.body) {
              slot.obj.body.needUpdate = true;
              if (Math.abs(slot.radius - r) > 0.01) setBodyRadius(slot, r);
            }
          }
        } else if (slot.idx !== -1) {
          slot.idx = -1;
          slot.obj.position.set(0, -99999, 0);
          if (slot.obj.body) slot.obj.body.needUpdate = true;
        }
      }
    }

    /* ---- Tap to target -------------------------------------------------
       The raycaster hands back instanceId, which is a SLOT, not a rock. The
       window maps it back. Without both halves a tap on a belt is a tap on one
       indivisible object called "belt". */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function pick(nx, ny, camera) {
      ndc.set(nx, ny);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(mesh, false);
      for (let i = 0; i < hits.length; i++) {
        const slot = hits[i].instanceId;
        if (slot === undefined || slot === null || slot < 0 || slot >= CAP) continue;
        const id = slotRock[slot];
        if (id >= 0 && sc[id] > 1.6) {
          return { index: id, x: px[id], y: py[id], z: pz[id], scale: sc[id], ore: ore[id], dist: hits[i].distance };
        }
      }
      return null;
    }

    function node(i) {
      if (i < 0 || i >= COUNT || ore[i] <= 0) return null;
      return { index: i, x: px[i], y: py[i], z: pz[i], scale: sc[i], ore: ore[i] };
    }

    // Nearest rock still carrying ore. Scans only the ore list — a few hundred
    // entries — never the full ten thousand.
    function nearestOre(x, y, z, maxRange) {
      let best = -1, bestD = maxRange ? maxRange * maxRange : Infinity;
      for (let k = 0; k < oreIdx.length; k++) {
        const i = oreIdx[k];
        if (ore[i] <= 0) continue;
        const dx = px[i] - x, dy = py[i] - y, dz = pz[i] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      return best === -1 ? null : node(best);
    }

    /* Take ore out of a rock. The instance shrinks as it empties, which is the
       only feedback a belt can give without a UI element. A spent rock is
       scaled to nothing and then skipped by the repack, so it stops costing
       anything at all — an InstancedMesh has no way to remove one member, but
       a window has a way to stop including it. */
    function take(i, amount) {
      if (i < 0 || ore[i] <= 0) return 0;
      const got = Math.min(ore[i], amount);
      ore[i] -= got;
      const frac = oreMax[i] > 0 ? ore[i] / oreMax[i] : 0;
      const s = ore[i] <= 0 ? 0.0001 : sc[i] * (0.45 + 0.55 * frac);
      m4.fromArray(mats, i * 16);
      m4.decompose(vp, qt, vs);
      vs.setScalar(s);
      m4.compose(vp, qt, vs);
      m4.toArray(mats, i * 16);
      const slot = rockSlot[i];
      if (slot >= 0 && slot < mesh.count) {
        mesh.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), slot * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (ore[i] <= 0) repack(lastX, lastY, lastZ, lastFx, lastFy, lastFz, true);
      return got;
    }

    function destroy() {
      third.scene.remove(mesh);
      geo.dispose(); matr.dispose();
      bodies.forEach(b => { if (b.obj.body) third.physics.destroy(b.obj); third.scene.remove(b.obj); });
      bodies.length = 0;
    }

    return {
      mesh, count: COUNT, cap: CAP, px, py, pz, sc, ore, oreMax, oreIdx,
      pick, node, nearestOre, take, updateBodies, repack, destroy, near,
      get gridCells() { return grid.size; }, get gridded() { return gridded; },
      get drawn() { return mesh.count; },
      isRockBody: obj => obj && typeof obj.name === 'string' && obj.name.indexOf('rockbody') === 0
    };
  }

  SE.Belt = Belt;
  SE.BELT_COUNT = COUNT;
})(window.SE = window.SE || {});
