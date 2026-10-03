/* Battles: noticing them, commanding them, and saying how they went.
 *
 * A battle is not a separate mode with its own rules. It is the ordinary
 * simulation, in one system, at a moment when your ships and hostile ones
 * are close enough to shoot each other — the same tickOOS that resolves every
 * fight in the galaxy resolves this one. What this file adds is the part a
 * player needs: knowing it is happening, being able to tell ships what to do
 * about it, a pause to do that in, and a result at the end.
 *
 * Commands are just orders on the ships' queues (ATTACK, MOVE, WAIT, JUMP), so
 * a commanded ship behaves exactly like any other ship given that order, and
 * keeps doing it if you close the view.
 */
(function (SE) {
  'use strict';

  const DETECT = 1100;        // metres: a hostile this close to one of yours is a battle
  const QUIET = 6;            // seconds without contact or damage before it is over
  const RECENT_HIT = 3;       // seconds a hit counts as "still being shot at"

  function Battles(host) {
    const world = host.world;
    const active = new Map();          // sector id -> battle
    const finished = [];               // results not yet shown
    let nextId = 1;

    const hostileMobile = s => !s.dead && !s.owned && !SE.isStatic(SE.CLASSES[s.cls]) && SE.hostile('player', s.faction);

    // What a kill is worth: a fraction of what the hull would cost to build.
    function salvageOf(victim) {
      const cls = SE.CLASSES[victim.cls];
      return Math.round((cls.hull * 0.9 + cls.shield * 0.3) * 2 / 10) * 10;
    }

    function contacts(sector) {
      const ours = [], foes = [];
      for (const s of world.registry.inSector(sector)) {
        if (s.dead) continue;
        if (s.owned) ours.push(s);
        else if (hostileMobile(s)) foes.push(s);
      }
      const near = foes.filter(f => ours.some(o => Math.hypot(o.x - f.x, o.z - f.z) < DETECT));
      const hit = ours.some(o => world.elapsed - (o.damageAt ?? -100) < RECENT_HIT);
      return { ours, foes: near, engaged: near.length > 0 || hit };
    }

    function start(sector, c) {
      const b = {
        id: 'battle' + nextId++, sector, startedAt: world.elapsed, quiet: 0,
        ours: new Set(c.ours.map(s => s.id)), foes: new Set(c.foes.map(s => s.id)),
        killed: [], lost: [], salvage: 0, retreated: false
      };
      active.set(sector, b);
      const where = SE.SECTOR_BY_ID[sector].name;
      host.director.log(`Battle in ${where}: ${c.foes.length} hostile${c.foes.length === 1 ? '' : 's'} engaging your ships.`, 'warn');
      host.director.audio.play('alert');
      // A fight at 16x is over before you can see it: drop to 1x.
      if (host.pace > 2) { host.setPace(1); host.say('BATTLE — SPEED SET TO 1×'); }
      return b;
    }

    function end(b) {
      active.delete(b.sector);
      // Survivors are the ships still in the system: a flagship towed to port
      // after being destroyed did not survive the fight.
      const survivors = [...b.ours].filter(id => { const s = world.get(id); return s && !s.dead && s.sector === b.sector; });
      const left = world.registry.inSector(b.sector).filter(hostileMobile).length;
      const won = survivors.length > 0 && !b.retreated && b.killed.length > 0 && left === 0;
      const result = {
        id: b.id, sector: b.sector, won, retreated: b.retreated, defeat: !survivors.length,
        killed: b.killed, lost: b.lost, salvage: b.salvage, seconds: Math.round(world.elapsed - b.startedAt)
      };
      finished.push(result);
      if (finished.length > 6) finished.shift();
      const where = SE.SECTOR_BY_ID[b.sector].name;
      host.director.log(
        (won ? `Victory in ${where}` : b.retreated ? `Withdrew from ${where}` : !survivors.length ? `Defeat in ${where}` : `Battle over in ${where}`) +
        ` · ${b.killed.length} destroyed · ${b.lost.length} lost` + (b.salvage ? ` · +${b.salvage.toLocaleString('en-US')} cr salvage` : ''),
        won ? 'gain' : b.lost.length ? 'warn' : 'info');
      // Whatever was ordered for the fight is finished with it.
      for (const id of b.ours) {
        const s = world.get(id);
        if (!s || s.dead) continue;
        if (s.battleOrder) { s.battleOrder = false; if (!s.isPlayer || !host.course) s.orders = []; }
      }
      return result;
    }

    world.events.subscribe(event => {
      if (event.type !== 'kill') return;
      const b = active.get(event.victim.sector);
      if (!b) return;
      if (event.victim.owned) { b.lost.push(event.victim.name); return; }
      if (event.killer && event.killer.owned) {
        const value = salvageOf(event.victim);
        b.killed.push(event.victim.name);
        b.salvage += value;
        world.credits += value;
      }
    });

    /* ---- Per simulation step -------------------------------------------- */
    function tick(dt) {
      const sectors = new Set();
      for (const s of world.registry.all) if (s.owned && !s.dead) sectors.add(s.sector);
      for (const b of active.values()) sectors.add(b.sector);
      for (const sector of sectors) {
        const c = contacts(sector);
        let b = active.get(sector);
        if (!b) {
          if (c.engaged && c.foes.length) b = start(sector, c);
          continue;
        }
        for (const s of c.ours) b.ours.add(s.id);
        for (const s of c.foes) b.foes.add(s.id);
        b.quiet = c.engaged ? 0 : b.quiet + dt;
        if (b.quiet >= QUIET || !c.ours.length) end(b);
      }
    }

    /* ---- Commands --------------------------------------------------------
       Each takes a list of your ship ids and turns it into ordinary orders. */
    function ships(ids) { return ids.map(id => world.get(id)).filter(s => s && s.owned && !s.dead); }

    function attack(ids, targetId) {
      const t = world.get(targetId);
      if (!t || t.dead) return 0;
      const list = ships(ids).filter(s => s.sector === t.sector);
      for (const s of list) { s.orders = [{ type: 'ATTACK', target: t.id, committed: true }]; s.orderT = 0; s.battleOrder = true; }
      if (list.some(s => s.isPlayer)) host.clearCourse();
      return list.length;
    }

    function move(ids, x, z) {
      const list = ships(ids);
      list.forEach((s, k) => {
        // Spread a group round the point so they do not stack on one pixel.
        const a = k * 2.4, r = k ? 40 + 14 * k : 0;
        s.orders = [{ type: 'MOVE', x: x + Math.cos(a) * r, y: 0, z: z + Math.sin(a) * r }, { type: 'WAIT', secs: 600 }];
        s.orderT = 0; s.battleOrder = true;
      });
      if (list.some(s => s.isPlayer)) host.clearCourse();
      return list.length;
    }

    function hold(ids) {
      const list = ships(ids);
      for (const s of list) { s.orders = [{ type: 'WAIT', secs: 600 }]; s.orderT = 0; s.battleOrder = true; }
      if (list.some(s => s.isPlayer)) host.clearCourse();
      return list.length;
    }

    /* Where to run: the neighbouring system that will not shoot you, with a
       friendly station if possible and the fewest hostiles in it. */
    function safeNeighbour(sector) {
      let best = null, bestScore = Infinity;
      for (const id of SE.ADJ[sector]) {
        const sec = SE.SECTOR_BY_ID[id];
        if (sec.owner && sec.owner !== 'player' && SE.hostile('player', sec.owner)) continue;
        const foes = world.registry.inSector(id).filter(hostileMobile).length;
        const score = foes * 10 + (sec.owner === 'player' ? -5 : sec.station ? -3 : 0);
        if (score < bestScore) { bestScore = score; best = id; }
      }
      return best;
    }

    function retreat(ids) {
      const list = ships(ids);
      if (!list.length) return null;
      const sector = list[0].sector;
      const to = safeNeighbour(sector);
      if (!to) return null;
      for (const s of list) {
        if (s.isPlayer) { s.battleOrder = false; s.orders = []; host.setCourse(to); continue; }
        s.orders = [{ type: 'JUMP', to }]; s.orderT = 0; s.battleOrder = true; s.duty = s.duty || 'escort';
      }
      const b = active.get(sector);
      if (b) b.retreated = true;
      return to;
    }

    return {
      tick, attack, move, hold, retreat, safeNeighbour,
      in: sector => active.get(sector) || null,
      get list() { return [...active.values()]; },
      // The latest result for a sector, once, for whoever shows it.
      takeResult(sector) {
        const i = finished.findIndex(r => !sector || r.sector === sector);
        return i === -1 ? null : finished.splice(i, 1)[0];
      },
      contacts
    };
  }

  SE.Battles = Battles;
})(window.SE = window.SE || {});
