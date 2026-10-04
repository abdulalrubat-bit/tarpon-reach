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
      events: new SE.EventBus(),
      log: [],

      get player() { return registry.all.find(s => s.isPlayer); },
      get(id) { return registry.get(id); },

      say(msg) {
        w.log.push({ t: w.elapsed, msg });
        if (w.log.length > 60) w.log.shift();
        if (w.onSay) w.onSay(msg);
      }
    };

    w.transit = new SE.TransitNetwork(w);

    /* ---- The interface the AI sees --------------------------------------
       `live` is true for the sector with geometry in it. Everything below
       branches on it exactly once, in the two places where the answer really
       does differ, and nowhere else. */
    // No room for the main thing this ship carries (ore for a miner).
    function full(st, s) {
      if (!w.economy || !w.economy.room) return false;
      let good = 'ore', most = 0;
      for (const g in s.cargo) if ((s.cargo[g] || 0) > most) { most = s.cargo[g]; good = g; }
      return w.economy.room(st, good) < 1;
    }
    function iface(sectorId) {
      const live = () => sectorId === w.sectorId && w.belt;

      return {
        get: id => registry.get(id),
        now: () => w.elapsed,
        /* A station that just refused this ship's cargo, for a while, or one
           whose warehouse is visibly full: a miner should not fly to a door
           it can see is shut. */
        refused: (s, st) => !!(s.noSale && s.noSale.station === st.id && w.elapsed < s.noSale.until) || full(st, s),
        atWar: f => !!(w.atWar && w.atWar(f)),
        navigate: (ship, intent, dt, order) => w.transit.steer(ship, intent, dt, order),
        dockPoint: (station, ship) => w.transit.dockPoint(station, ship),
        miningPoint: (ship, node) => w.transit.miningPoint(ship, node) || {x:node.x,y:node.y+112,z:node.z},
        freightLeg(ship) {
          const candidates = SE.ADJ[ship.sector].filter(id => { const station = registry.get("st_" + id); return station && !SE.hostile(ship.faction, station.faction); });
          return candidates.length ? candidates[Math.floor(w.elapsed / 30) % candidates.length] : null;
        },

        formationSlot(ship, leader) {
          // Reserve a free slot across queued guards as well as active guards.
          // Escorts returning from other sectors must not all claim slot zero.
          const occupied = new Set();
          for (const other of registry.all) {
            if (other.id === ship.id || other.dead) continue;
            for (const order of other.orders) {
              if (order.type === 'GUARD' && order.target === leader.id && Number.isInteger(order.slot)) occupied.add(order.slot);
            }
          }
          let slot = 0;
          while (occupied.has(slot)) ++slot;
          return slot;
        },

        nearestHostile(s, range) {
          return registry.nearest(s, sectorId,
            t => !t.dead && SE.hostile(s.faction, t.faction), range);
        },

        // The nearest hostile that also satisfies a predicate — the nearest
        // thing worth robbing, or the nearest pirate. Factions want different
        // things and "nearest enemy" cannot express that.
        nearestHostileMatching(s, range, pred) {
          return registry.nearest(s, sectorId,
            t => !t.dead && SE.hostile(s.faction, t.faction) && pred(t), range);
        },

        // A rock to mine. In the live sector that is an actual instance in the
        // belt; elsewhere it is a plausible point in the band, remembered on
        // the order so the ship does not wander between imaginary rocks.
        mineNode(s, idx) {
          if (live()) {
            if (idx >= 0) {
              const n = w.belt.node(idx);
              if (n && w.transit.miningPoint(s, n)) return n;
            }
            const near = w.belt.nearestOre(s.x, s.y, s.z, 4000, node => !!w.transit.miningPoint(s, node));
            if (near && s.orders[0]) s.orders[0].node = near.index;
            return near;
          }
          // No belt, nothing to mine. An exhausted deposit is replaced, not
          // revisited: a miner once sat forever on a seam with no ore left.
          if (!SE.SECTOR_BY_ID[sectorId].belt) return null;
          if (!s.orderData || s.orderData.sector !== sectorId || !(s.orderData.ore > 0)) {
            // A fresh deposit in the asteroid field nearest the miner (src/expanse.js).
            const field = SE.Expanse && SE.Expanse.nearestField(sectorId, s.x, s.z);
            let p;
            if (field) p = SE.Expanse.pointIn(field, rng);
            else { const a = rng.float(0, Math.PI * 2), r = rng.float(SE.BELT_INNER, SE.BELT_OUTER); p = { x: Math.cos(a) * r, z: Math.sin(a) * r }; }
            s.orderData = { sector: sectorId, field: field ? field.id : undefined, x: p.x, y: rng.float(-60, 60), z: p.z, ore: Math.round(400 * (field ? field.rich : 1)) };
          }
          return { index: -1, x: s.orderData.x, y: s.orderData.y, z: s.orderData.z, ore: s.orderData.ore };
        },

        // Yield per second. Deliberately identical in both branches — the
        // economy must not depend on whether anyone is watching, or a player
        // learns to sit in a sector to make their miners work faster.
        mine(s, node, dt) {
          const rate = (SE.CLASSES[s.cls].miner ? 26 : 7) * (SE.stats(s).mineRate || 1) * (w.mineFactor ? w.mineFactor(s.sector) : 1);
          const want = Math.max(0, Math.min(rate * dt, s.cargoMax - SE.cargoUsed(s)));
          if (want <= 0) return 0;
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
          if (w.economy) {
            if ((s.cargo[good] || 0) < 1) return 0;
            const result = w.economy.trade(s, st, good, 'sell', s.cargo[good] || 0);
            s.tradeStatus = result.message;
            return result.ok ? result.amount / 100 : 0;
          }
          const qty = Math.floor(s.cargo[good] || 0);
          if (qty <= 0) return 0;
          const price = priceAt(st.id, good);
          s.cargo[good] = Math.max(0, (s.cargo[good] || 0) - qty);
          const paid = Math.round(qty * price);
          const stock = w.stationStock[st.id] || (w.stationStock[st.id] = {});
          stock[good] = (stock[good] || 0) + qty;
          if (s.owned) {
            w.credits += paid;
            w.events.emit({ type: 'trade', ship: s, station: st, good, quantity: qty, credits: paid });
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
            if ((s.noSale && s.noSale.station === st.id && w.elapsed < s.noSale.until) || full(st, s)) continue;
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
        patrolPoint(s) { return w.transit.patrol(s); },

        laneExit(from, to) { return w.transit.gate(from, to); },

        jump(s, to) {
          const from = s.sector;
          const arrival = w.transit.gate(to, from);
          registry.move(s, to);
          // Arrive at the far side's matching lane mouth rather than at the
          // origin: a fleet that jumps in should appear at the edge it came
          // from, which is also the edge a player watching would expect.
          if (arrival) {
            const n = Math.hypot(arrival.x, arrival.z) || 1;
            s.x = arrival.x - arrival.x / n * 110;
            s.z = arrival.z - arrival.z / n * 110;
            s.y = 0;
            SE.AI.quatFromForward(s, -arrival.x / n, 0, -arrival.z / n);
          }
          w.transit.reset(s);
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
      if (w.economy && registry.get(stationId)) return w.economy.price(registry.get(stationId), good, 'sell');
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
    const oosShips = [];
    let economyClock = 0;
    /* Being shot changes what you are doing. The 3D build did this in its
       collision handler, and it went with it: without this a miner kept
       mining and an escort kept escorting while a pirate took them apart.
       Haulers run; anything armed turns on whoever is shooting it. A ship
       carrying out an order its commander gave in battle keeps doing it —
       that order is the commander's answer to being shot. */
    function retaliate(victim, shooter) {
      const cls = SE.CLASSES[victim.cls];
      if (SE.isStatic(cls) || victim.battleOrder) return;
      const head = victim.orders[0];
      if (cls.miner || victim.cls === 'freighter') {
        if (!head || head.type !== 'FLEE') { victim.orders.unshift({ type: 'FLEE', from: shooter.id }); victim.orderT = 0; }
        return;
      }
      if (head && head.type === 'ATTACK') return;
      if (head && head.type === 'JUMP' && victim.isPlayer) return;   // a flagship on a course keeps flying it
      victim.orders.unshift({ type: 'ATTACK', target: shooter.id });
      victim.orderT = 0;
    }

    w.tickOOS = function (dt) {
      oosShips.length = 0;
      /* Headless (src/empire.js): there is no live sector, so this is the
         whole galaxy, the flagship included. Otherwise it is every sector
         but the one with physics in it, as it always was. */
      for (const ship of registry.all) if (w.headless || (ship.sector !== w.sectorId && !ship.isPlayer)) oosShips.push(ship);
      for (const s of oosShips) {
        if (s.dead) { if (!s.isPlayer) registry.remove(s); continue; }
        const sid = s.sector, api = iface(sid);
        s.cool = Math.max(0, s.cool - dt);
        if (w.elapsed - (s.damageAt ?? -100) > 3) s.shield = Math.min(s.shieldMax, s.shield + SE.stats(s).shieldRegen * dt);
        const it = SE.AI.think(s, api, dt);
        s.aim = it.target;       // what it is pointing its guns at, for the system view
        if (s.sector !== sid) continue;
        SE.AI.applyAbstract(s, it, dt);
        // A besieged station's guns are silenced (siege.js).
        if (it.fire && it.target && !s.suppressed) {
          const foe = registry.get(it.target);
          if (foe && !foe.dead && foe.sector === sid && s.cool <= 0) {
            const weapon = SE.weaponOf(s);
            s.cool = 1 / weapon.rate;
            foe.lastHitBy = s.id; foe.damageAt = w.elapsed;
            if (w.onShot) w.onShot(s, foe, weapon);
            /* 0.1, not the 3D build's 0.55. That number was tuned for fights
               nobody watched; with battles you command, three interceptors
               killed a corvette in four seconds, before a single order could
               be given. At 0.1 a three-on-three lasts about half a minute. */
            SE.damage(foe, weapon.damage * SE.stats(s).hardpoints * 0.1 * (w.damageScale ? w.damageScale(s, foe) : 1));
            if (foe.dead && w.onOOSKill) w.onOOSKill(foe, s);
            else if (!foe.dead) retaliate(foe, s);
          }
        }
      }
      // Remove off-screen losses now; a later sector arrival must not award them a second time.
      for (let i = registry.all.length - 1; i >= 0; i--) {
        const ship = registry.all[i];
        if (ship.dead && (w.headless || ship.sector !== w.sectorId) && !ship.isPlayer) registry.remove(ship);
      }
      if (w.economy) return; // The typed economy is the sole production owner.
      economyClock += dt;
      if (economyClock >= 20) {
        economyClock -= 20;
        for (const station of registry.all) {
          if (SE.CLASSES[station.cls].tier !== 'structure') continue;
          const stock = w.stationStock[station.id] || (w.stationStock[station.id] = {});
          if ((stock.ore || 0) >= 18 && (stock.alloy || 0) < 450) { stock.ore -= 18; stock.alloy = (stock.alloy || 0) + 6; }
          stock.cells = Math.min(360, (stock.cells || 0) + 4);
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

    /* The authored seven draw from one shared sequence, as they always have.
       Every generated system gets its own stream keyed by its id, so filling
       one in later (see populateMissing) produces exactly what a fresh game
       would have put there. */
    SE.SECTORS.forEach(sec => populateSector(world, sec, sec.generated ? SE.Rng(world.seed + ':pop:' + sec.id) : rng));

    /* A Scrapper blockade in the home sector, out on the belt.

       Without it the emplacements are unreachable: home is Apex-owned, Apex is
       not hostile to the player, and the player has no jump drive — so every
       platform in the game would be something you watch shoot somebody else.
       A feature the player cannot touch is not a feature.

       Two platforms on the far side of the belt, far enough out that you go
       looking for them rather than blundering into them on the way to the
       station. They are also the seed of the blockade mechanic proper: a
       Scrapper position sitting across a trade approach, which is exactly what
       a siege is once stations can be starved. */
    {
      const a = 2.35;                         // out past the belt, off the plane
      const r = SE.BELT_OUTER + 120;
      SE.DEFENCES.scrapper.forEach((cls, i) => {
        const aa = a + (i - 0.5) * 0.10;
        reg.add(SE.makeShip({
          id: 'blk_' + i, name: SE.CLASSES[cls].name + ' ' + (i + 1),
          cls, faction: 'scrapper', sector: 'home',
          x: Math.cos(aa) * r, y: -40 + i * 26, z: Math.sin(aa) * r,
          // Facing back down the approach, at the station they are blocking.
          yaw: aa - Math.PI / 2
        }));
      });
    }

    // The player, and the two hulls they start with.
    // Opening position: in the clear space between the station and the inner
    // edge of the belt, nose already pointed at the station. The identity
    // quaternion faces -Z, so a positive Z start is a start facing the middle
    // of the sector — the belt is ahead and to the sides, not wrapped around
    // the camera, and the first thing on screen is somewhere to go.
    const me = SE.makeShip({
      id: 'player', name: 'Kestrel', cls: 'corvette', faction: 'player',
      sector: 'home', x: 0, y: 70, z: 580, isPlayer: true, owned: true
    });
    reg.add(me);

    const wing = SE.makeShip({
      id: 'wing1', name: 'Shrike', cls: 'interceptor', faction: 'player',
      sector: 'home', x: 65, y: 55, z: 615, owned: true,
      orders: [{ type: 'GUARD', target: 'player', slot: 0 }]
    });
    reg.add(wing);

    const miner = SE.makeShip({
      id: 'mine1', name: 'Ladle', cls: 'extractor', faction: 'player',
      sector: 'home', x: -65, y: 50, z: 615, owned: true,
      orders: [{ type: 'GUARD', target: 'player', slot: 1 }]
    });
    reg.add(miner);

    return world;
  }

  function populateSector(world, sec, rng) {
    const reg = world.registry;
    if (sec.station) {
      const st = SE.makeShip({
        id: 'st_' + sec.id, name: sec.station, cls: 'station',
        faction: sec.owner || 'apex', sector: sec.id,
        x: 0, y: 0, z: 0
      });
      reg.add(st);
      world.stationStock[st.id] = { ore: sec.belt ? 420 : 130, alloy: sec.id === "home" ? 8 : sec.owner === "apex" ? 140 : 70, cells: 90, scrap: sec.owner === "scrapper" ? 240 : 60 };

      /* A perimeter of defence emplacements, in the owner's two platform
         types, on a ring around the station.
         Not flush against the hull: the point of a perimeter is that you
         meet it BEFORE you reach what it is guarding, and a turret welded to
         the station's side is just more station. 200 metres out is far
         enough that you have to decide whether to cross it, and close enough
         that the platforms and the station support each other rather than
         being defeated one at a time.
         Every platform is yawed to face outwards. Their heads track, so the
         resting bearing only matters for the second before something
         arrives — but that second is what a player sees on approach, and a
         perimeter all facing the same way looks like scenery someone forgot
         to rotate. */
      const kinds = SE.DEFENCES[sec.owner || 'apex'] || SE.DEFENCES.apex;
      const count = sec.id === 'home' ? 4 : rng.int(2, 4);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rng.float(-0.2, 0.2);
        const r = 370 + rng.float(-12, 12);
        const cls = kinds[i % kinds.length];
        reg.add(SE.makeShip({
          id: 'def_' + sec.id + '_' + i,
          name: SE.CLASSES[cls].name + ' ' + (i + 1),
          cls, faction: sec.owner || 'apex', sector: sec.id,
          x: Math.cos(a) * r, y: rng.float(-30, 30), z: Math.sin(a) * r,
          // Identity faces -Z, so yawing by (a + PI/2) turns the platform's
          // nose along the outward radius.
          yaw: a + Math.PI / 2
        }));
      }
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
  }

  /* A save written before the galaxy grew knows only the authored seven, so
     every generated system would load empty: no station, no traffic, nothing
     to claim or fight. Fill in whichever generated systems the file had no
     ships in at all, using the same per-system stream a new game would. */
  function populateMissing(world) {
    const occupied = new Set(world.registry.all.map(s => s.sector));
    let filled = 0;
    for (const sec of SE.SECTORS) {
      if (!sec.generated || occupied.has(sec.id)) continue;
      populateSector(world, sec, SE.Rng(world.seed + ':pop:' + sec.id));
      ++filled;
    }
    return filled;
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
  SE.populateMissing = populateMissing;
})(window.SE = window.SE || {});
