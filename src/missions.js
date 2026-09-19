/* Contracts: what there is to DO, as opposed to what there is to fly to.
 *
 * The rule the whole file is built on: a contract must describe something that
 * is ALREADY TRUE about the galaxy. Not "kill four pirates somewhere" but
 * "kill four pirates in The Sill, where there are in fact four pirates right
 * now". Not "deliver ore" but "deliver ore to Gate Watch, which is in fact
 * short of it".
 *
 * That is the difference between a board that generates errands and one that
 * reads like the galaxy is asking you for help, and it costs nothing: the
 * numbers it needs — who is where, what each station is holding — are already
 * being simulated every tick for the out-of-sector economy. The board just
 * looks at them.
 *
 * It also means the board CANNOT offer a contract nobody could complete, which
 * is the failure mode of weighted random generation done the other way round:
 * roll a type, then invent a target to fit it, and sooner or later you send the
 * player to clear pirates out of an empty sector.
 */
(function (SE) {
  'use strict';

  const OFFERS = 4;            // contracts on a board at once
  const REFRESH = 260;         // seconds before a board is rewritten

  /* ---- Survey ---------------------------------------------------------
     One pass over the registry, reused by every generator below. Doing it
     once per board rather than once per candidate is the difference between
     four scans and forty. */
  function survey(world) {
    const out = {};
    for (const sec of SE.SECTORS) {
      const list = world.registry.inSector(sec.id);
      const s = { id: sec.id, hostiles: [], guns: [], mine: 0, station: null };
      for (const ship of list) {
        if (ship.dead) continue;
        const cls = SE.CLASSES[ship.cls];
        if (cls.tier === 'structure') { s.station = ship; continue; }
        if (ship.owned) { s.mine++; continue; }
        if (!SE.hostile(ship.faction, 'player')) continue;
        (cls.tier === 'emplacement' ? s.guns : s.hostiles).push(ship);
      }
      out[sec.id] = s;
    }
    return out;
  }

  function hops(from, to) {
    const p = SE.route(from, to);
    return p ? p.length - 1 : 99;
  }

  /* ---- Candidates ------------------------------------------------------
     Each generator returns zero or more { weight, make } pairs. Weight is
     roughly "how much does the galaxy want to say this right now", and it is
     derived from the survey rather than from a constant, so a quiet galaxy
     offers quiet work.
  */
  function candidates(world, station, sur, rng) {
    const home = station.sector;
    const out = [];

    for (const sec of SE.SECTORS) {
      const s = sur[sec.id];
      const d = hops(home, sec.id);
      if (d > 3) continue;                       // nobody contracts across the galaxy

      /* BOUNTY. Only offered where there are hulls to collect on, and never
         for more than two thirds of them — a contract that requires killing
         every single hostile in a sector fails the moment one of them wanders
         off through a lane, which they do constantly. */
      if (s.hostiles.length >= 2) {
        const n = Math.max(1, Math.min(4, Math.floor(s.hostiles.length * 0.66)));
        out.push({
          type: 'BOUNTY',
          weight: s.hostiles.length * 2.4 + (d === 0 ? 3 : 0),
          make: () => ({
            type: 'BOUNTY', sector: sec.id, need: n, done: 0,
            title: 'Bounty — ' + sec.name,
            blurb: 'Destroy ' + n + ' hostile hull' + (n === 1 ? '' : 's') + ' in ' + sec.name + '.',
            reward: Math.round((260 + n * 210) * (1 + d * 0.35))
          })
        });
      }

      /* SWEEP. Emplacements are a different job from ships: they do not move,
         they out-range you, and clearing them is the thing that makes a
         blockade breakable. Offered separately so the board can say so. */
      if (s.guns.length >= 1) {
        const n = Math.min(2, s.guns.length);
        out.push({
          type: 'SWEEP',
          weight: s.guns.length * 3.1 + (d === 0 ? 2 : 0),
          make: () => ({
            type: 'SWEEP', sector: sec.id, need: n, done: 0,
            title: 'Sweep — ' + sec.name,
            blurb: 'Destroy ' + n + ' hostile emplacement' + (n === 1 ? '' : 's') +
              ' holding ' + sec.name + '.',
            reward: Math.round((520 + n * 460) * (1 + d * 0.3))
          })
        });
      }
    }

    /* HAUL. Driven by what stations are actually short of. The stock table is
       the same one the NPC economy trades against, so a hauler contract is
       competing with real freighters for the same shortage — and a station
       somebody else has just supplied stops asking. */
    for (const sec of SE.SECTORS) {
      const st = sur[sec.id].station;
      if (!st || st.id === station.id) continue;
      if (SE.hostile(st.faction, station.faction)) continue;
      const d = hops(home, sec.id);
      if (d > 3 || d === 0) continue;
      const stock = (world.stationStock[st.id] || {});
      for (const g of ['ore', 'alloy', 'cells']) {
        const have = stock[g] || 0;
        if (have > 900) continue;                // not short of it
        const qty = g === 'ore' ? 24 : 14;
        out.push({
          type: 'HAUL',
          weight: (1100 - have) / 220 + (3 - d),
          make: () => ({
            type: 'HAUL', sector: sec.id, station: st.id, good: g, need: qty, done: 0,
            title: 'Haulage — ' + SE.GOODS[g].name,
            blurb: 'Carry ' + qty + ' ' + SE.GOODS[g].name + ' to ' + st.name +
              ' in ' + sec.name + '. Dock there to deliver.',
            reward: Math.round(qty * SE.GOODS[g].base * 1.75 * (1 + d * 0.28))
          })
        });
      }
    }

    /* ESCORT. The only contract that creates something. A hauler is spawned
       here and given the same JUMP orders any NPC uses, so it really flies the
       route and really can be killed on the way — an escort mission whose
       subject is a marker that teleports on success is a timer with a story
       attached. */
    const dests = SE.SECTORS.filter(sec => {
      const st = sur[sec.id].station;
      const d = hops(home, sec.id);
      return st && d >= 1 && d <= 2 && !SE.hostile(st.faction, station.faction);
    });
    if (dests.length) {
      const dst = rng.pick(dests);
      const risk = sur[dst.id].hostiles.length;
      out.push({
        type: 'ESCORT',
        weight: 3 + risk * 1.3,
        make: () => ({
          type: 'ESCORT', sector: dst.id, need: 1, done: 0, spawn: true,
          title: 'Escort — ' + dst.name,
          blurb: 'See a freighter safely to ' + dst.name + '. It leaves when you accept.',
          reward: Math.round((640 + risk * 180) * (1 + hops(home, dst.id) * 0.4))
        })
      });
    }

    return out;
  }

  /* Pick a TYPE first, then a candidate within it.
     Drawing straight from one pool of candidates looks correct and is not.
     There is one bounty candidate per sector that has hostiles and one sweep
     candidate per sector that has guns, but there is a haulage candidate for
     every good at every station — so haulage outnumbers everything else about
     four to one before any weighting happens, and the first board this
     generated was four haulage runs and nothing else. The galaxy was being
     asked "what is the most worth saying", and it answered "cargo" four times
     because cargo had four times as many mouths.

     Weighting by type fixes the count without flattening the state: a type's
     weight is its strongest candidate, so a sector with six pirates still
     shouts louder than a station that is mildly short of ore. Taking a type
     halves its weight rather than removing it, so two bounties on one board
     are possible when the galaxy really is that violent, and unlikely
     otherwise. */
  function pick(list, rng, n) {
    const byType = {};
    for (const c of list) (byType[c.type] = byType[c.type] || []).push(c);
    const types = Object.keys(byType).map(t => ({
      t, w: byType[t].reduce((m, c) => Math.max(m, c.weight), 0)
    }));

    const chosen = [];
    while (chosen.length < n) {
      const live = types.filter(x => x.w > 0 && byType[x.t].length);
      if (!live.length) break;
      let total = 0;
      for (const x of live) total += x.w;
      let r = rng.float(0, total), ti = 0;
      while (ti < live.length - 1 && (r -= live[ti].w) > 0) ti++;
      const slot = live[ti];
      const pool = byType[slot.t];

      let ptotal = 0;
      for (const c of pool) ptotal += c.weight;
      let pr = rng.float(0, ptotal), i = 0;
      while (i < pool.length - 1 && (pr -= pool[i].weight) > 0) i++;
      chosen.push(pool.splice(i, 1)[0]);
      slot.w *= 0.5;
    }
    return chosen;
  }

  /* ---- The board ------------------------------------------------------ */
  function Missions(world) {
    const rng = SE.Rng(world.seed + ':missions');
    let nextId = 1;

    // What a station is offering right now, and when it was written.
    world.boards = world.boards || {};
    // What the player has taken on.
    world.contracts = world.contracts || [];

    function board(station) {
      const b = world.boards[station.id];
      if (b && world.elapsed - b.at < REFRESH) return b.list;
      const sur = survey(world);
      const cands = candidates(world, station, sur, rng);
      const list = pick(cands, rng, OFFERS).map(c => {
        const m = c.make();
        m.id = 'ct' + (nextId++);
        m.from = station.id;
        m.fromName = station.name;
        m.faction = station.faction;
        return m;
      });
      world.boards[station.id] = { at: world.elapsed, list };
      return list;
    }

    function accept(m) {
      if (world.contracts.length >= 3) return 'THREE CONTRACTS IS THE LIMIT';
      if (world.contracts.some(c => c.id === m.id)) return 'ALREADY ACCEPTED';
      const c = Object.assign({}, m, { state: 'active', took: world.elapsed });
      world.contracts.push(c);
      // Take it off the board it came from, so it cannot be accepted twice.
      const b = world.boards[m.from];
      if (b) b.list = b.list.filter(x => x.id !== m.id);
      if (c.spawn) spawnEscort(c);
      return null;
    }

    /* The escorted hauler. Given a real hull, a real faction and the same
       JUMP order an NPC uses to cross the galaxy, so everything that happens
       to it afterwards happens for ordinary reasons. */
    function spawnEscort(c) {
      const here = world.sectorId;
      const a = rng.float(0, Math.PI * 2);
      const ship = SE.makeShip({
        id: 'esc_' + c.id, name: 'Contract Hauler', cls: 'freighter',
        faction: c.faction, sector: here,
        x: Math.cos(a) * 260, y: rng.float(-20, 20), z: Math.sin(a) * 260
      });
      ship.escortOf = c.id;
      world.registry.add(ship);
      c.target = ship.id;
      const path = SE.route(here, c.sector);
      if (path && path.length > 1) ship.orders.push({ type: 'JUMP', to: path[1] });
      if (world.onEscortSpawn) world.onEscortSpawn(ship);
    }

    function pay(c, why) {
      c.state = 'done';
      world.credits += c.reward;
      world.say('CONTRACT COMPLETE — ' + c.reward + ' CR' + (why ? ' (' + why + ')' : ''));
      world.contracts = world.contracts.filter(x => x !== c);
      (world.completed = world.completed || []).push({ id: c.id, type: c.type, reward: c.reward });
    }

    function fail(c, why) {
      c.state = 'failed';
      world.say('CONTRACT FAILED — ' + c.title.toUpperCase() + (why ? ' (' + why + ')' : ''));
      world.contracts = world.contracts.filter(x => x !== c);
    }

    /* ---- Hooks the rest of the game calls ---------------------------- */

    // Something died. Called for in-sector kills and out-of-sector attrition
    // alike, which is what stops a bounty being completable only while you are
    // watching — your wingmen count, in any sector.
    function onKill(victim, killer) {
      if (!victim || !killer) return;
      if (!killer.owned) {
        // The escortee dying is the one thing anyone else can do to a contract.
        for (const c of world.contracts.slice()) {
          if (c.type === 'ESCORT' && victim.id === c.target) fail(c, 'hauler lost');
        }
        return;
      }
      const cls = SE.CLASSES[victim.cls];
      for (const c of world.contracts.slice()) {
        if (c.sector !== victim.sector) continue;
        if (!SE.hostile(victim.faction, 'player')) continue;
        if (c.type === 'BOUNTY' && cls.tier !== 'emplacement') {
          if (++c.done >= c.need) pay(c);
          else world.say(c.title.toUpperCase() + ' — ' + c.done + '/' + c.need);
        } else if (c.type === 'SWEEP' && cls.tier === 'emplacement') {
          if (++c.done >= c.need) pay(c);
          else world.say(c.title.toUpperCase() + ' — ' + c.done + '/' + c.need);
        }
      }
    }

    // The player docked somewhere. Haulage pays here, if this is the door it
    // was addressed to and the hold has the goods.
    function onDock(station, ship) {
      for (const c of world.contracts.slice()) {
        if (c.type !== 'HAUL' || c.station !== station.id) continue;
        const have = Math.floor(ship.cargo[c.good] || 0);
        if (have < c.need) {
          world.say('NEED ' + (c.need - have) + ' MORE ' + c.good.toUpperCase());
          continue;
        }
        ship.cargo[c.good] = have - c.need;
        const stock = world.stationStock[station.id] || (world.stationStock[station.id] = {});
        stock[c.good] = (stock[c.good] || 0) + c.need;
        pay(c, 'delivered');
      }
    }

    // Called once a tick. Only the escort needs watching — everything else is
    // event-driven, and a contract system that polls is a contract system that
    // costs something when nothing is happening.
    function tick() {
      for (const c of world.contracts.slice()) {
        if (c.type !== 'ESCORT') continue;
        const ship = world.registry.get(c.target);
        if (!ship || ship.dead) { fail(c, 'hauler lost'); continue; }
        if (ship.sector === c.sector) { world.registry.remove(ship); pay(c, 'delivered'); }
      }
    }

    return { board, accept, onKill, onDock, tick, survey: () => survey(world),
      get active() { return world.contracts; } };
  }

  SE.Missions = Missions;
})(window.SE = window.SE || {});
