/* The world: what the AI is allowed to ask, and who answers.
 *
 * ai.js is written against an interface, not against a sector. That interface
 * is implemented twice here — once by the sector the player is flying in,
 * which has a belt, a station and real geometry to answer with, and once for
 * every other sector in the galaxy, which answers the same questions with
 * arithmetic. A freighter three jumps away asking "where is the nearest ore"
 * gets a number rather than a rock, and neither the freighter nor the code
 * driving it can tell the difference.
 *
 * Getting this boundary right is what makes the whole state/view split pay
 * off. If the AI could reach for a mesh, every ship would need one.
 */
(function (SE) {
  'use strict';

  function World(seed) {
    const registry = SE.Registry();
    const rng = SE.Rng(seed + ':world');

    const w = {
      seed,
      registry,
      sectorId: 'home',
      elapsed: 0,
      credits: 2400,
      belt: null,              // set by the scene when the active sector builds one
      stationStock: {},
      log: [],

      get player() { return registry.all.find(s => s.isPlayer); },
      get(id) { return registry.get(id); },

      say(msg) {
        w.log.push({ t: w.elapsed, msg });
        if (w.log.length > 60) w.log.shift();
        if (w.onSay) w.onSay(msg);
      }
    };

    /* ---- The interface the AI sees --------------------------------------
       `live` is true for the sector with geometry in it. Everything below
       branches on it exactly once, in the two places where the answer really
       does differ, and nowhere else. */
    function iface(sectorId) {
      const live = () => sectorId === w.sectorId && w.belt;

      return {
        get: id => registry.get(id),

        nearestHostile(s, range) {
          return registry.nearest(s, sectorId,
            t => !t.dead && SE.hostile(s.faction, t.faction), range);
        },

        // A rock to mine. In the live sector that is an actual instance in the
        // belt; elsewhere it is a plausible point in the band, remembered on
        // the order so the ship does not wander between imaginary rocks.
        mineNode(s, idx) {
          if (live()) {
            if (idx >= 0) {
              const n = w.belt.node(idx);
              if (n) return n;
            }
            const near = w.belt.nearestOre(s.x, s.y, s.z, 2200);
            if (near && s.orders[0]) s.orders[0].node = near.index;
            return near;
          }
          if (!s.orderData || s.orderData.sector !== sectorId) {
            const a = rng.float(0, Math.PI * 2);
            const r = rng.float(SE.BELT_INNER, SE.BELT_OUTER);
            s.orderData = { sector: sectorId, x: Math.cos(a) * r, y: rng.float(-60, 60), z: Math.sin(a) * r, ore: 400 };
          }
          return { index: -1, x: s.orderData.x, y: s.orderData.y, z: s.orderData.z, ore: s.orderData.ore };
        },

        // Yield per second. Deliberately identical in both branches — the
        // economy must not depend on whether anyone is watching, or a player
        // learns to sit in a sector to make their miners work faster.
        mine(s, node, dt) {
          const rate = SE.CLASSES[s.cls].miner ? 26 : 7;
          const want = rate * dt;
          let got;
          if (live() && node.index >= 0) got = w.belt.take(node.index, want);
          else {
            got = Math.min(s.orderData ? s.orderData.ore : 0, want);
            if (s.orderData) s.orderData.ore -= got;
          }
          if (got > 0) got = SE.addCargo(s, 'ore', got);
          return got;
        },

        trade(s, st, good) {
          const qty = Math.floor(s.cargo[good] || 0);
          if (qty <= 0) return 0;
          const price = priceAt(st.id, good);
          s.cargo[good] = 0;
          const paid = Math.round(qty * price);
          const stock = w.stationStock[st.id] || (w.stationStock[st.id] = {});
          stock[good] = (stock[good] || 0) + qty;
          if (s.owned) {
            w.credits += paid;
            w.say(s.name.toUpperCase() + ' SOLD ' + qty + ' ' + good.toUpperCase() + ' — ' + paid + ' CR');
          }
          return paid;
        },

        stationFor(s) {
          const list = registry.inSector(sectorId);
          for (let i = 0; i < list.length; i++) {
            if (SE.CLASSES[list[i].cls].tier === 'structure' && !SE.hostile(s.faction, list[i].faction)) return list[i];
          }
          return null;
        },

        /* Where to take a full hold when this sector has nobody to sell it to.
           Runs A* across the galaxy graph to every sector that has a station
           willing to trade with this faction, keeps the cheapest route, and
           returns only the FIRST leg — the ship re-asks on arrival, so a lane
           that closes or a station that changes hands mid-journey is handled
           by the next decision rather than by a plan made twenty minutes ago. */
        routeToMarket(s) {
          let best = null, bestCost = Infinity;
          for (let i = 0; i < SE.SECTORS.length; i++) {
            const sec = SE.SECTORS[i];
            if (sec.id === sectorId || !sec.station) continue;
            const st = registry.get('st_' + sec.id);
            if (!st || st.dead || SE.hostile(s.faction, st.faction)) continue;
            const path = SE.route(sectorId, sec.id);
            if (!path || path.length < 2) continue;
            let cost = 0;
            for (let k = 1; k < path.length; k++) cost += laneLen(path[k - 1], path[k]);
            if (cost < bestCost) { bestCost = cost; best = path[1]; }
          }
          return best;
        },

        // Somewhere to be when there is nothing to do. Patrols orbit; haulers
        // drift toward the lanes; everyone stays inside the sector.
        patrolPoint(s) {
          const a = rng.float(0, Math.PI * 2);
          const r = rng.float(200, SE.SECTOR_R * 0.8);
          return { x: Math.cos(a) * r, y: rng.float(-120, 120), z: Math.sin(a) * r };
        },

        laneExit(from, to) {
          const A = SE.SECTOR_BY_ID[from], B = SE.SECTOR_BY_ID[to];
          if (!A || !B) return null;
          // The lane leaves in the direction of the destination on the galaxy
          // map, at the edge of the sector. Consistent, and it means a player
          // who learns the map knows which way to fly before being told.
          const dx = B.gx - A.gx, dy = B.gy - A.gy;
          const l = Math.hypot(dx, dy) || 1;
          return { x: dx / l * SE.SECTOR_R * 0.92, y: 0, z: dy / l * SE.SECTOR_R * 0.92 };
        },

        jump(s, to) {
          registry.move(s, to);
          // Arrive at the far side's matching lane mouth rather than at the
          // origin: a fleet that jumps in should appear at the edge it came
          // from, which is also the edge a player watching would expect.
          s.x *= -0.9; s.z *= -0.9; s.y = 0;
          s.vx = s.vy = s.vz = 0;
          s.orderData = null;
          if (w.onJump) w.onJump(s, to);
        }
      };
    }

    function laneLen(a, b) {
      const A = SE.SECTOR_BY_ID[a], B = SE.SECTOR_BY_ID[b];
      return Math.hypot(A.gx - B.gx, A.gy - B.gy);
    }

    // Price moves against stock: a station drowning in ore pays less for ore.
    // Simple, legible, and enough to make "where do I sell this" a question.
    function priceAt(stationId, good) {
      const base = SE.GOODS[good].base;
      const stock = (w.stationStock[stationId] || {})[good] || 0;
      const glut = Math.min(0.55, stock / 4000);
      return Math.max(base * 0.4, base * (1 - glut));
    }

    w.iface = iface;
    w.priceAt = priceAt;

    /* ---- Out-of-sector simulation ---------------------------------------
       Every ship the player is not looking at, ticked at a coarse step. This
       is the empire running itself: freighters filling holds, patrols hunting,
       stations accumulating stock, all as arithmetic, all of it costing about
       as much as one physics body would.
    */
    w.tickOOS = function (dt) {
      for (let i = 0; i < SE.SECTORS.length; i++) {
        const sid = SE.SECTORS[i].id;
        if (sid === w.sectorId) continue;
        const api = iface(sid);
        const list = registry.inSector(sid);
        for (let k = 0; k < list.length; k++) {
          const s = list[k];
          if (s.dead) continue;
          s.cool = Math.max(0, s.cool - dt);
          if (s.shield < s.shieldMax) s.shield = Math.min(s.shieldMax, s.shield + SE.CLASSES[s.cls].shieldRegen * dt);
          const it = SE.AI.think(s, api, dt);
          SE.AI.applyAbstract(s, it, dt);
          // Combat out of sector is resolved as attrition rather than as
          // simulated rounds. Two fleets that meet off-screen still decide
          // something; they just do not each need two hundred projectiles.
          if (it.fire && it.target) {
            const foe = registry.get(it.target);
            if (foe && !foe.dead && s.cool <= 0) {
              const wep = SE.WEAPONS[SE.CLASSES[s.cls].weapon];
              s.cool = 1 / wep.rate;
              SE.damage(foe, wep.damage * SE.CLASSES[s.cls].hardpoints * 0.55);
              if (foe.dead && w.onOOSKill) w.onOOSKill(foe, s);
            }
          }
        }
      }
    };

    return w;
  }

  /* ---- Populating the galaxy -------------------------------------------
     One pass, seeded. The player's own three ships are placed by hand because
     a starting position is a designed thing; everything else is generated so
     that the same seed always produces the same opposition. */
  function populate(world) {
    const rng = SE.Rng(world.seed + ':pop');
    const reg = world.registry;

    SE.SECTORS.forEach(sec => {
      if (sec.station) {
        const st = SE.makeShip({
          id: 'st_' + sec.id, name: sec.station, cls: 'station',
          faction: sec.owner || 'apex', sector: sec.id,
          x: 0, y: 0, z: 0
        });
        reg.add(st);
      }

      const traffic = sec.id === 'home' ? 4 : rng.int(2, 5);
      for (let i = 0; i < traffic; i++) {
        const a = rng.float(0, Math.PI * 2);
        const r = rng.float(260, SE.SECTOR_R * 0.75);
        const owner = sec.owner || rng.pick(['scrapper', 'apex']);
        const isPirate = owner === 'scrapper' ? rng.chance(0.62) : rng.chance(0.18);
        const cls = isPirate
          ? rng.pick(['interceptor', 'interceptor', 'corvette'])
          : (sec.belt ? rng.pick(['extractor', 'freighter', 'corvette']) : rng.pick(['freighter', 'corvette']));
        const fac = isPirate ? 'scrapper' : owner;
        reg.add(SE.makeShip({
          cls, faction: fac, sector: sec.id,
          name: shipName(rng, fac, cls),
          x: Math.cos(a) * r, y: rng.float(-140, 140), z: Math.sin(a) * r
        }));
      }

      // One capital per faction homeworld, so the heavy class exists in the
      // world rather than only in the roster.
      if (sec.owner && rng.chance(sec.id === 'home' ? 1 : 0.35)) {
        const a = rng.float(0, Math.PI * 2);
        reg.add(SE.makeShip({
          cls: 'dreadnought', faction: sec.owner, sector: sec.id,
          name: capitalName(rng, sec.owner),
          x: Math.cos(a) * 520, y: rng.float(-40, 40), z: Math.sin(a) * 520
        }));
      }
    });

    // The player, and the two hulls they start with.
    // Opening position: in the clear space between the station and the inner
    // edge of the belt, nose already pointed at the station. The identity
    // quaternion faces -Z, so a positive Z start is a start facing the middle
    // of the sector — the belt is ahead and to the sides, not wrapped around
    // the camera, and the first thing on screen is somewhere to go.
    const me = SE.makeShip({
      id: 'player', name: 'Kestrel', cls: 'corvette', faction: 'player',
      sector: 'home', x: 0, y: 16, z: 190, isPlayer: true, owned: true
    });
    reg.add(me);

    const wing = SE.makeShip({
      id: 'wing1', name: 'Shrike', cls: 'interceptor', faction: 'player',
      sector: 'home', x: 46, y: 6, z: 214, owned: true,
      orders: [{ type: 'GUARD', target: 'player', slot: 0 }]
    });
    reg.add(wing);

    const miner = SE.makeShip({
      id: 'mine1', name: 'Ladle', cls: 'extractor', faction: 'player',
      sector: 'home', x: -52, y: -8, z: 220, owned: true,
      orders: [{ type: 'GUARD', target: 'player', slot: 1 }]
    });
    reg.add(miner);

    return world;
  }

  const PREFIX = {
    apex: ['Ledger', 'Consignment', 'Margin', 'Tariff', 'Manifest', 'Quota', 'Dividend'],
    scrapper: ['Rust', 'Offcut', 'Crowbar', 'Gutted', 'Pigiron', 'Swarf', 'Tooth'],
    vanguard: ['Sentinel', 'Redoubt', 'Bastion', 'Picket', 'Vigil', 'Rampart'],
    player: ['Kestrel', 'Shrike', 'Ladle']
  };
  const SUFFIX = ['Run', 'Line', 'Hand', 'Watch', 'Turn', 'Mark', 'Wake', 'Reach'];

  function shipName(rng, faction, cls) {
    const p = PREFIX[faction] || PREFIX.apex;
    return rng.pick(p) + ' ' + rng.pick(SUFFIX);
  }
  function capitalName(rng, faction) {
    const p = PREFIX[faction] || PREFIX.apex;
    return rng.pick(p) + ' Ascendant';
  }

  SE.World = World;
  SE.populate = populate;
})(window.SE = window.SE || {});
