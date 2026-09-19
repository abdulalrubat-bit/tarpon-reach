/* ShipState — the whole universe, as arithmetic.
 *
 * This is one half of the split the whole engine is built around. A ShipState
 * is a flat data object: position, orientation, velocity, hull, hold, orders.
 * It has no mesh, no rigid body, and no idea whether anyone is watching. Every
 * ship in every sector has one, permanently, and they are cheap enough that
 * having a few hundred costs nothing measurable.
 *
 * The other half is ShipPhysicsView (view.js), which is attached only to the
 * ships in the sector the player is actually in, and destroyed the moment they
 * leave. When a view exists it OWNS the transform and writes it back here each
 * frame; when it does not, ai.js integrates these numbers directly. Nothing
 * else in the game is allowed to care which of those two is happening.
 *
 * Flat fields rather than nested vectors, on purpose: this object is
 * structured-cloned to a worker on every autosave, and nesting is the thing
 * that makes that expensive.
 */
(function (SE) {
  'use strict';

  let nextId = 1;

  function makeShip(opts) {
    const cls = SE.CLASSES[opts.cls];
    if (!cls) throw new Error('unknown hull class: ' + opts.cls);
    return {
      id: opts.id || ('s' + (nextId++)),
      name: opts.name || cls.name,
      cls: cls.id,
      faction: opts.faction || 'independent',
      sector: opts.sector || 'home',

      // Transform. The quaternion is stored rather than euler angles because
      // it is what Ammo hands back, and converting every frame to store a
      // prettier number is a cost paid for nothing.
      x: opts.x || 0, y: opts.y || 0, z: opts.z || 0,
      // `yaw` is a convenience for placing things that never move and whose
      // facing is part of the level design — a defence perimeter, mostly. It
      // is converted here and then forgotten; the quaternion is the state.
      qx: 0, qy: opts.yaw ? Math.sin(opts.yaw / 2) : 0, qz: 0,
      qw: opts.yaw ? Math.cos(opts.yaw / 2) : 1,
      vx: 0, vy: 0, vz: 0,

      hull: opts.hull !== undefined ? opts.hull : cls.hull,
      hullMax: cls.hull,
      shield: cls.shield,
      shieldMax: cls.shield,

      /* Only ships the player owns carry a fit. An NPC with `fit: null` takes
         the fast path through SE.stats and reads its class table directly,
         which is what thirty-odd hulls a frame want. Refitting NPC ships is a
         later phase; pretending they can now would cost every one of them a
         recompute to answer "nothing is fitted". */
      fit: (opts.owned && SE.slotsFor && SE.slotsFor(cls.id).engine !== undefined
        && cls.tier !== 'structure' && cls.tier !== 'emplacement')
        ? (opts.fit || SE.emptyFit()) : null,
      fitRev: 0,

      cargo: opts.cargo || {},
      cargoMax: cls.cargoMax,
      credits: opts.credits || 0,

      // The order queue. ai.js pops the front when it completes. This is the
      // only channel through which anything — the player's radar taps, a
      // station's contract, a patrol's standing brief — tells a ship to act.
      orders: opts.orders || [],
      orderT: 0,
      orderData: null,

      stuckT: 0,          // seconds spent going nowhere with somewhere to be
      target: null,       // ship id this one is shooting at
      mineTarget: -1,     // instance index into the belt, or -1
      cool: 0,            // seconds until the guns may fire again
      dead: false,

      isPlayer: !!opts.isPlayer,
      owned: !!opts.owned || !!opts.isPlayer,   // part of the player's fleet
      docked: false
    };
  }

  function cargoUsed(ship) {
    let n = 0;
    for (const k in ship.cargo) n += ship.cargo[k];
    return n;
  }

  function addCargo(ship, good, qty) {
    const room = ship.cargoMax - cargoUsed(ship);
    const took = Math.max(0, Math.min(qty, room));
    if (took > 0) ship.cargo[good] = (ship.cargo[good] || 0) + took;
    return took;
  }

  /* Damage resolves against shields first, then hull. Overflow carries into
     the hull in the same hit rather than being discarded — otherwise a shot
     that happens to land on the last point of shield is worth nothing, and
     players notice that even when they cannot articulate it. */
  function damage(ship, amount) {
    if (ship.dead) return 0;
    let left = amount;
    if (ship.shield > 0) {
      const absorbed = Math.min(ship.shield, left);
      ship.shield -= absorbed;
      left -= absorbed;
    }
    if (left > 0) {
      /* A station's hull is not exposed by shooting at it.
         The design has always been that a station falls to a SIEGE: blockade
         the trade routes, starve it of the Energy Cells its shield generator
         runs on, watch regeneration drop to zero, and only then is there a
         hull to breach. Blockades are not built yet — so until they are, the
         shield takes everything and the hull is never touched.
         Without this, a sector's trade hub could be ground down by a routine
         pirate skirmish and then DELETED from the registry, which takes the
         economy of that sector with it, permanently, into the save file. */
      if (SE.CLASSES[ship.cls].tier === 'structure') return amount;
      ship.hull -= left;
    }
    if (ship.hull <= 0) { ship.hull = 0; ship.dead = true; }
    return amount;
  }

  /* ---- The registry ---------------------------------------------------
     One flat array of every ship anywhere, plus an id index and a per-sector
     index kept in step. Rebuilding the per-sector list every frame is the
     obvious version and it is also the one that allocates 60 arrays a second,
     so the buckets are maintained on mutation instead. */
  function Registry() {
    const all = [];
    const byId = Object.create(null);
    const bySector = Object.create(null);
    SE.SECTORS.forEach(s => { bySector[s.id] = []; });

    function add(ship) {
      all.push(ship);
      byId[ship.id] = ship;
      (bySector[ship.sector] || (bySector[ship.sector] = [])).push(ship);
      return ship;
    }

    function move(ship, toSector) {
      const from = bySector[ship.sector];
      if (from) {
        const i = from.indexOf(ship);
        if (i !== -1) from.splice(i, 1);
      }
      ship.sector = toSector;
      (bySector[toSector] || (bySector[toSector] = [])).push(ship);
    }

    function remove(ship) {
      let i = all.indexOf(ship);
      if (i !== -1) all.splice(i, 1);
      delete byId[ship.id];
      const b = bySector[ship.sector];
      if (b) { i = b.indexOf(ship); if (i !== -1) b.splice(i, 1); }
    }

    return {
      all, byId, bySector, add, move, remove,
      inSector: id => bySector[id] || [],
      get: id => byId[id],
      // Nearest ship matching a predicate, squared-distance only — the square
      // root is never needed to decide which of two things is closer.
      nearest(from, sectorId, pred, maxRange) {
        const list = bySector[sectorId] || [];
        const maxSq = maxRange ? maxRange * maxRange : Infinity;
        let best = null, bestSq = maxSq;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (s === from || s.dead || !pred(s)) continue;
          const dx = s.x - from.x, dy = s.y - from.y, dz = s.z - from.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestSq) { bestSq = d2; best = s; }
        }
        return best;
      }
    };
  }

  SE.makeShip = makeShip;
  SE.cargoUsed = cargoUsed;
  SE.addCargo = addCargo;
  SE.damage = damage;
  SE.Registry = Registry;
  SE.setNextId = n => { nextId = n; };
  SE.getNextId = () => nextId;
})(window.SE = window.SE || {});
