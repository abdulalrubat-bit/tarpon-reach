/* Sieges: taking a faction's system away from it.
 *
 * Claiming is how you grow into empty space; a siege is how you grow into
 * somebody else's. It runs in three steps, each one something you can see:
 *
 *   defences   the station's perimeter platforms are up. Your warships have
 *              to knock them out first, and they shoot back hard.
 *   contested  the platforms are down but the owner still has warships near
 *              the station. Clear them.
 *   sieging    nothing is defending it. The station's guns are silenced and
 *              its shield drains on a timer; more warships, faster.
 *
 * When the shield is gone the system is yours: station, a fresh pair of your
 * own platforms, and a bigger charter income than a frontier claim pays.
 *
 * Taking a system starts a war with whoever owned it, and a war is not one
 * fight. Every few minutes the faction sends a strike group to take its
 * system back, and a conquered system with nobody defending it falls. Peace
 * can be bought.
 *
 * Everything here is ordinary orders and ordinary ships, like battles: a
 * strike group is three hulls with JUMP orders, and the fights it causes are
 * fought by tickOOS like any other.
 */
(function (SE) {
  'use strict';

  const SIEGE_SECS = 120;     // seconds to drain a station with one warship
  const DECAY_SECS = 300;     // seconds for an abandoned siege to fall back to nothing
  const RETAKE_SECS = 90;     // seconds an undefended conquest survives enemy warships
  const STRIKE_EVERY = 240;   // seconds between counterattacks, per faction at war
  const NEAR = 1500;          // metres from the station that count as "at the station"
  const PEACE_COST = 5000;

  function Sieges(host) {
    const world = host.world;
    const state = () => host.director.state;
    const retake = {};        // sector -> seconds enemy warships have held it
    const nextStrike = {};    // faction -> world.elapsed of its next strike
    const lastPhase = {};     // sector -> phase last reported, for the log
    const attacked = {};      // sector -> enemy warships in a conquest right now
    const groups = new Map(); // strike group id -> { faction, goal }, to notice one wiped out
    let groupClock = 0;
    let strikeNo = 1;

    const cls = s => SE.CLASSES[s.cls];
    const warship = s => !s.dead && !cls(s).miner && s.cls !== 'freighter' && !SE.isStatic(cls(s));
    const near = (s, st) => Math.hypot(s.x - st.x, s.z - st.z) < NEAR;

    /* A system you could besiege: a faction holds it, it has a station, and
       that faction is hostile to you (at war, or the pirates). */
    function target(sector) {
      const sec = SE.SECTOR_BY_ID[sector];
      if (!sec || !sec.owner || sec.owner === 'player' || !sec.station) return null;
      const st = world.get('st_' + sector);
      if (!st || st.dead) return null;
      return { sec, st, faction: sec.owner, hostile: SE.hostile('player', sec.owner) };
    }

    function status(sector) {
      const t = target(sector);
      if (!t || !t.hostile) return null;
      /* The blockade region: only your warships within NEAR of the station
         hold a siege. Ships elsewhere in the system can still fight the
         perimeter, but a corvette at the far gate besieges nothing. */
      const fleet = [], ours = [], guns = [], ships = [];
      for (const s of world.registry.inSector(sector)) {
        if (s.dead) continue;
        if (s.owned) { if (warship(s)) { fleet.push(s); if (near(s, t.st)) ours.push(s); } continue; }
        if (SE.isEmplacement(cls(s))) { if (s.faction === t.faction) guns.push(s); continue; }
        if (warship(s) && SE.hostile('player', s.faction) && near(s, t.st)) ships.push(s);
      }
      const phase = !fleet.length ? 'idle' : guns.length ? 'defences' : ships.length ? 'contested' : !ours.length ? 'outside' : 'sieging';
      const rate = Math.min(2, 1 + 0.25 * (Math.max(1, ours.length) - 1));
      return { sector, faction: t.faction, station: t.st, fleet, ours, guns, ships, phase, rate, range: NEAR, progress: state().sieges[sector] || 0 };
    }

    /* ---- Per simulation step --------------------------------------------- */
    function tick(dt) {
      const s = state();
      // A war is a war: contracts or relief cannot quietly end one.
      for (const f in s.wars) if (s.wars[f] && s.reputation[f] > -60) s.reputation[f] = -60;

      const sectors = new Set(Object.keys(s.sieges));
      for (const ship of world.registry.all) if (ship.owned && !ship.dead) sectors.add(ship.sector);
      for (const sector of sectors) {
        const st = status(sector);
        const station = world.get('st_' + sector);
        if (!st) {
          delete s.sieges[sector];
          if (station) station.suppressed = false;
          continue;
        }
        let p = s.sieges[sector] || 0;
        if (st.phase === 'sieging') p += dt / SIEGE_SECS * st.rate;
        else if (st.phase === 'idle' || st.phase === 'outside') p -= dt / DECAY_SECS;
        p = Math.max(0, p);
        if (p > 0) s.sieges[sector] = p; else delete s.sieges[sector];
        // The perimeter is down and your ships are on the station: its guns
        // are the first thing a siege takes away.
        st.station.suppressed = (st.phase === 'sieging' || st.phase === 'contested') && st.ours.length > 0;
        if (p > 0) st.station.shield = Math.min(st.station.shield, st.station.shieldMax * (1 - p));
        report(st);
        // Ships sent at the defences go on to the next platform by themselves.
        for (const ship of st.fleet) {
          if (ship.siegeAttack !== sector) continue;
          if (st.phase !== 'defences') { ship.siegeAttack = null; continue; }
          const head = ship.orders[0];
          if (!head || head.type !== 'ATTACK' || !world.get(head.target) || world.get(head.target).dead) aim(ship, st.guns);
        }
        if (p >= 1) capture(sector);
      }

      for (const c of s.conquests) holdConquest(c, dt);
      for (const f of Reach.FACTIONS) strikes(f);
      groupClock += dt;
      if (groupClock >= 2) { groupClock = 0; strikeLosses(); }
    }

    function report(st) {
      const was = lastPhase[st.sector];
      if (was === st.phase) return;
      lastPhase[st.sector] = st.phase;
      const where = SE.SECTOR_BY_ID[st.sector].name;
      const d = host.director;
      if (st.phase === 'defences' && was !== 'contested' && was !== 'sieging')
        d.log(`Siege of ${where}: knock out ${st.guns.length} defence platform${st.guns.length === 1 ? '' : 's'} first.`, 'warn');
      else if (st.phase === 'contested' && was === 'defences')
        d.log(`${where}: the perimeter is down. Clear the warships guarding the station.`, 'info');
      else if (st.phase === 'sieging')
        d.log(`${where}: the station is under siege. Its guns are silent and its shield is failing.`, 'gain');
    }

    /* ---- Capture --------------------------------------------------------- */
    function rivalsOf(f) {
      return Reach.FACTIONS.filter(g => g !== f && (SE.FACTIONS[f].hostileTo.includes(g) || SE.FACTIONS[g].hostileTo.includes(f)));
    }

    function garrison(sector, faction) {
      const kinds = SE.DEFENCES[faction] || SE.DEFENCES.player;
      for (let i = 0; i < 2; i++) {
        const a = i * Math.PI + 0.6, r = 370;
        const id = (faction === 'player' ? 'gar_' : 'def_') + sector + '_r' + strikeNo++;
        world.registry.add(SE.makeShip({
          id, name: SE.CLASSES[kinds[i]].name + ' ' + (i + 1), cls: kinds[i], faction, sector,
          x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, yaw: a + Math.PI / 2
        }));
      }
    }

    function capture(sector) {
      const s = state(), d = host.director;
      const sec = SE.SECTOR_BY_ID[sector], st = world.get('st_' + sector);
      const from = sec.owner;
      sec.owner = 'player';
      st.faction = 'player';
      st.suppressed = false;
      st.shield = st.shieldMax * 0.3;
      delete s.sieges[sector];
      delete lastPhase[sector];
      garrison(sector, 'player');
      s.conquests.push({ sector, from, at: world.elapsed });
      s.influence[sector] = 100;
      s.xp += 400;
      const plunder = 2500;
      world.credits += plunder;
      s.wars[from] = true;
      d.reputation(from, -100);
      for (const g of rivalsOf(from)) d.reputation(g, 10);
      // The first counterattack comes after a breather, not on the next tick.
      nextStrike[from] = Math.max(nextStrike[from] || 0, world.elapsed + STRIKE_EVERY * 0.75);
      d.log(`${sec.name} captured from ${SE.FACTIONS[from].name}. +${Reach.credits(plunder)} cr plunder. It pays ${d.charterTax(sector)} cr a minute. Expect them back.`, 'gain');
      d.audio.play('fanfare');
      world.events.emit({ type: 'capture', sector, from });
      d.checkMilestones();
      host.galaxy.refresh();
      void host.autosave(true);
    }

    /* ---- Holding what you took ------------------------------------------- */
    function holdConquest(c, dt) {
      const sec = SE.SECTOR_BY_ID[c.sector];
      let ours = 0, guns = 0, foes = 0;
      for (const s of world.registry.inSector(c.sector)) {
        if (s.dead) continue;
        if (s.owned) { if (warship(s)) ours++; }
        else if (s.faction === 'player' && SE.isEmplacement(cls(s))) guns++;
        else if (warship(s) && s.faction === c.from && SE.hostile('player', s.faction)) foes++;
      }
      if (foes) attacked[c.sector] = foes; else delete attacked[c.sector];
      if (!foes || ours || guns) { delete retake[c.sector]; return; }
      const t = (retake[c.sector] || 0) + dt;
      retake[c.sector] = t;
      if (t === dt) { host.director.log(`${sec.name} is undefended and ${SE.FACTIONS[c.from].name} warships are taking it back. Send your fleet.`, 'warn'); host.director.audio.play('alert'); }
      if (t >= RETAKE_SECS) lose(c);
    }

    function lose(c) {
      const s = state(), d = host.director;
      const sec = SE.SECTOR_BY_ID[c.sector], st = world.get('st_' + c.sector);
      sec.owner = c.from;
      if (st) { st.faction = c.from; st.shield = st.shieldMax; }
      for (const g of world.registry.inSector(c.sector).slice())
        if (g.faction === 'player' && !g.owned && SE.isEmplacement(cls(g))) world.registry.remove(g);
      garrison(c.sector, c.from);
      s.conquests = s.conquests.filter(x => x !== c);
      s.influence[c.sector] = 0;
      delete retake[c.sector];
      delete attacked[c.sector];
      d.log(`${sec.name} has fallen back to ${SE.FACTIONS[c.from].name}.`, 'warn');
      d.audio.play('loss');
      world.events.emit({ type: 'lost', sector: c.sector, to: c.from });
      host.galaxy.refresh();
      void host.autosave(true);
    }

    /* ---- Counterattacks -------------------------------------------------- */
    function strikes(f) {
      const s = state();
      if (!s.wars[f]) return;
      const lost = s.conquests.filter(c => c.from === f);
      if (!lost.length) return;
      if (nextStrike[f] === undefined) nextStrike[f] = world.elapsed + STRIKE_EVERY * 0.75;
      if (world.elapsed < nextStrike[f]) return;
      nextStrike[f] = world.elapsed + STRIKE_EVERY;
      // At most two strike groups of a faction in flight at once.
      const flying = new Set(world.registry.all.filter(x => !x.dead && x.strike && x.faction === f).map(x => x.strikeGroup));
      if (flying.size >= 2) return;
      const goal = lost[Math.floor(Math.random() * lost.length)].sector;
      // From the nearest system the faction still has a station in.
      let from = null, path = null;
      for (const sec of SE.SECTORS) {
        if (sec.owner !== f || !sec.station) continue;
        const p = SE.route(sec.id, goal);
        if (p && (!path || p.length < path.length)) { path = p; from = sec.id; }
      }
      if (!from) return;
      launch(f, from, goal, path, lost.length);
    }

    /* Each strike is bigger than the last, up to a capital ship after a few.
       But a strike your defences wipe out costs the faction: the next one is
       smaller than the one you destroyed, so holding firm calms a war down
       rather than escalating it forever. The wave count lives in the war
       record, so it survives a reload. */
    function strikeLosses() {
      const alive = new Map();
      for (const x of world.registry.all) {
        if (x.dead || !x.strikeGroup) continue;
        alive.set(x.strikeGroup, (alive.get(x.strikeGroup) || 0) + 1);
        // Groups from a reloaded save are picked up here.
        if (!groups.has(x.strikeGroup)) groups.set(x.strikeGroup, { faction: x.faction, goal: x.strike });
      }
      const s = state();
      for (const [id, g] of groups) {
        if (alive.get(id)) continue;
        groups.delete(id);
        // A strike that retook its target won; that is no reason to send fewer.
        if (!s.wars[g.faction] || (g.goal && !s.conquests.some(c => c.sector === g.goal))) continue;
        s.strikes[g.faction] = Math.max(0, (s.strikes[g.faction] || 0) - 2);
        host.director.log(`${SE.FACTIONS[g.faction].name} strike group destroyed. Their next one will be smaller.`, 'gain');
        host.director.audio.play('reward');
        world.events.emit({ type: 'strike-defeated', faction: g.faction, sector: g.goal });
      }
    }

    function launch(f, from, goal, path, size) {
      // Unique across reloads: a saved group id must never be reused.
      const group = 'strike' + Math.round(world.elapsed) + '_' + strikeNo++;
      groups.set(group, { faction: f, goal });
      const s = state();
      const wave = s.strikes[f] = (s.strikes[f] || 0) + 1;
      const hulls = ['corvette', 'interceptor', 'interceptor'];
      for (let i = 1; i < Math.min(wave, 5) + (size >= 2 ? 1 : 0); i++) hulls.push(i % 2 ? 'corvette' : 'interceptor');
      if (wave >= 3 && wave % 2 === 1) hulls.push('dreadnought');
      const legs = path.slice(1).map(to => ({ type: 'JUMP', to }));
      const base = Math.random() * Math.PI * 2;
      hulls.forEach((c, i) => {
        const a = base + i * 0.5;
        const ship = SE.makeShip({
          cls: c, faction: f, sector: from,
          name: (f === 'apex' ? 'Recovery ' : f === 'vanguard' ? 'Reprisal ' : 'Raid ') + String.fromCharCode(65 + i),
          x: Math.cos(a) * 560, y: 0, z: Math.sin(a) * 560,
          orders: legs.map(o => ({ ...o }))
        });
        ship.strike = goal; ship.strikeGroup = group;
        world.registry.add(ship);
      });
      host.director.log(`${SE.FACTIONS[f].name} strike group (${hulls.length} ships) leaving ${SE.SECTOR_BY_ID[from].name} for ${SE.SECTOR_BY_ID[goal].name}.`, 'warn');
      host.director.audio.play('alert');
    }

    // Strike groups still on their way, for the map's warning.
    function incoming() {
      const by = new Map();
      for (const s of world.registry.all) {
        if (s.dead || !s.strike) continue;
        if (s.sector === s.strike && !s.orders.some(o => o.type === 'JUMP')) { s.strike = null; continue; }
        const g = by.get(s.strikeGroup) || { faction: s.faction, to: s.strike, at: s.sector, ships: 0, jumps: 0 };
        g.ships++;
        g.jumps = Math.max(g.jumps, s.orders.filter(o => o.type === 'JUMP').length);
        by.set(s.strikeGroup, g);
      }
      return [...by.values()];
    }

    /* ---- War and peace --------------------------------------------------- */
    function declare(f) {
      const s = state();
      if (!Reach.FACTIONS.includes(f)) return 'Unknown faction.';
      if (s.wars[f]) return 'You are already at war with ' + SE.FACTIONS[f].name + '.';
      s.wars[f] = true;
      host.director.reputation(f, -100);
      nextStrike[f] = world.elapsed + STRIKE_EVERY;
      return null;
    }

    function peace(f) {
      const s = state();
      if (!s.wars[f]) return 'You are not at war with ' + SE.FACTIONS[f].name + '.';
      if (world.credits < PEACE_COST) return `Peace costs ${Reach.credits(PEACE_COST)} cr in reparations.`;
      world.credits -= PEACE_COST;
      s.wars[f] = false;
      s.strikes[f] = 0;
      s.reputation[f] = -10;
      for (const x of world.registry.all) if (x.strike && x.faction === f) { x.strike = null; x.orders = []; }
      return null;
    }

    function aim(ship, guns) {
      const g = guns.slice().sort((a, b) => Math.hypot(a.x - ship.x, a.z - ship.z) - Math.hypot(b.x - ship.x, b.z - ship.z))[0];
      if (!g || !host.battles.attack([ship.id], g.id)) return false;
      ship.siegeAttack = ship.sector;
      return true;
    }

    // Every warship of yours in the system turns its guns on the nearest
    // platform, and keeps going until the perimeter is down.
    function attackDefences(sector) {
      const st = status(sector);
      if (!st || !st.guns.length) return 0;
      let n = 0;
      for (const s of st.fleet) if (aim(s, st.guns)) n++;
      return n;
    }

    function restore() {
      const s = state();
      for (const c of s.conquests) {
        const sec = SE.SECTOR_BY_ID[c.sector];
        if (sec) sec.owner = 'player';
        const st = world.get('st_' + c.sector);
        if (st) st.faction = 'player';
      }
    }

    return {
      tick, status, target, capture, declare, peace, attackDefences, incoming, restore,
      // Every siege worth showing: your warships on a hostile station, or one
      // left part-done.
      get active() {
        const ids = new Set(Object.keys(state().sieges));
        for (const x of world.registry.all) if (x.owned && !x.dead && warship(x)) ids.add(x.sector);
        const out = [];
        for (const id of ids) { const x = status(id); if (x && (x.phase !== 'idle' || x.progress > 0)) out.push(x); }
        return out;
      },
      atWar: f => !!state().wars[f],
      // Conquests with enemy warships in them; `left` once nothing defends them.
      underAttack: () => Object.entries(attacked).map(([sector, foes]) => ({ sector, foes, left: retake[sector] === undefined ? null : Math.max(0, Math.ceil(RETAKE_SECS - retake[sector])) })),
      PEACE_COST
    };
  }

  SE.Sieges = Sieges;
})(window.SE = window.SE || {});
