/* Galaxy events: things that happen without you.
 *
 * Every few game minutes something starts somewhere within reach of your
 * fleet, and no more than three run at once:
 *
 *   economy   trade boom (a station pays double for one good), mining rush
 *             (miners in one system dig twice as fast)
 *   pirates   pirate surge (raiders flood a few systems for a while), warlord
 *             (a tough named pirate with a bounty on its hull)
 *   politics  faction war: two AI factions fight over a border system, and it
 *             changes hands if the attacker holds it when the war ends
 *   finds     distress call (save a freighter from pirates for a reward),
 *             derelict (send any ship to salvage it), ancient cache (bigger
 *             reward, guarded, further out)
 *
 * Events are ordinary ships and ordinary prices: a surge is raiders with no
 * special rules, a war is two factions made hostile to each other for a few
 * minutes, and the fights are fought by the same simulation as everything
 * else. Events and their ships are saved with the game.
 */
(function (SE) {
  'use strict';

  const EVERY = [180, 300];       // game seconds between events
  const MAX = 3;                  // running at once
  const KINDS = {
    boom:     { icon: '$', colour: '#efbc7f', weight: 3,   title: 'Trade boom', calm: true },
    rush:     { icon: '⛏', colour: '#8fd3e0', weight: 2,   title: 'Mining rush', calm: true },
    derelict: { icon: '◆', colour: '#c8d8ff', weight: 2,   title: 'Derelict', calm: true },
    surge:    { icon: '☠', colour: '#ff8a5a', weight: 2,   title: 'Pirate surge' },
    warlord:  { icon: '☠', colour: '#f06a5a', weight: 1,   title: 'Pirate warlord' },
    war:      { icon: '⚔', colour: '#ffb46a', weight: 1.5, title: 'Faction war' },
    distress: { icon: '✚', colour: '#8be38b', weight: 2,   title: 'Distress call' },
    cache:    { icon: '★', colour: '#ffe08a', weight: 0.7, title: 'Ancient cache' }
  };
  const WARLORDS = ['Grin Vosk', 'Mother Rust', 'Hatchet Kael', 'Old Sorrow', 'Ninefingers', 'The Tallyman'];

  function Events(host) {
    const world = host.world;
    const state = () => host.director.state;
    const sec = id => SE.SECTOR_BY_ID[id];
    const name = id => sec(id).name;
    const rand = (a, b) => a + Math.random() * (b - a);
    const pickOne = list => list[Math.floor(Math.random() * list.length)];
    const hostileHeld = id => { const s = sec(id); return !!(s.owner && s.owner !== 'player' && SE.hostile('player', s.owner)); };
    const warship = s => !s.dead && !SE.CLASSES[s.cls].miner && s.cls !== 'freighter' && !SE.isStatic(SE.CLASSES[s.cls]);

    // Systems by jump distance from the flagship, so events land within reach.
    function within(lo, hi) {
      const start = world.player ? world.player.sector : 'home';
      const dist = { [start]: 0 }, queue = [start], out = [];
      while (queue.length) {
        const id = queue.shift();
        if (dist[id] >= lo) out.push(id);
        if (dist[id] >= hi) continue;
        for (const nb of SE.ADJ[id]) if (dist[nb] === undefined) { dist[nb] = dist[id] + 1; queue.push(nb); }
      }
      return out;
    }

    function spawn(ev, cls, faction, sector, name, extra) {
      // Events happen at one of the system's points of interest (src/expanse.js).
      const site = SE.Expanse && SE.Expanse.siteFor(sector, ev.id);
      const a = Math.random() * Math.PI * 2, r = site ? rand(80, Math.max(120, site.r)) : rand(500, 1100);
      const s = SE.makeShip({ cls, faction, sector, name, x: (site ? site.x : 0) + Math.cos(a) * r, y: 0, z: (site ? site.z : 0) + Math.sin(a) * r });
      s.ev = ev.id;
      if (extra) Object.assign(s, extra);
      world.registry.add(s);
      return s;
    }
    const shipsOf = ev => world.registry.all.filter(s => !s.dead && s.ev === ev.id);

    function news(text, kind) {
      const s = state();
      s.news.push({ at: Math.round(world.elapsed), text, kind: kind || 'info' });
      if (s.news.length > 20) s.news.splice(0, s.news.length - 20);
      host.director.log(text, kind === 'gain' ? 'gain' : kind === 'warn' ? 'warn' : 'info', true);
      if (host.director.shell) host.director.shell.renderNews();
    }

    /* ---- Starting an event ----------------------------------------------- */
    const starters = {
      boom() {
        const options = within(0, 6).filter(id => { const st = world.get('st_' + id); return st && !st.dead && !SE.hostile('player', st.faction); });
        if (!options.length) return null;
        const sector = pickOne(options), good = pickOne(Reach.GOODS);
        return { sector, dur: 300, data: { good, station: 'st_' + sector },
          text: `${world.get('st_' + sector).name} in ${name(sector)} pays double for ${SE.GOODS[good].name} for 5 minutes.` };
      },
      rush() {
        const options = within(0, 6).filter(id => sec(id).belt && !hostileHeld(id));
        if (!options.length) return null;
        const sector = pickOne(options);
        return { sector, dur: 300, data: {}, text: `Rich seam found in ${name(sector)}: miners there dig twice as fast for 5 minutes.` };
      },
      derelict() {
        const options = within(1, 5).filter(id => !hostileHeld(id));
        if (!options.length) return null;
        const sector = pickOne(options);
        return { sector, dur: 420, data: { reward: Math.round(rand(8, 20)) * 100 },
          text: `A derelict freighter drifts in ${name(sector)}. Send any ship to salvage it within 7 minutes.` };
      },
      surge(ev) {
        const options = within(0, 5).filter(id => !hostileHeld(id) && sec(id).owner !== 'scrapper');
        if (!options.length) return null;
        const sector = pickOne(options);
        const n = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) spawn(ev, i % 3 === 2 ? 'corvette' : 'interceptor', 'scrapper', sector, 'Raider ' + (i + 1));
        const next = pickOne(SE.ADJ[sector]);
        if (next && !hostileHeld(next)) for (let i = 0; i < 2; i++) spawn(ev, 'interceptor', 'scrapper', next, 'Raider ' + (n + i + 1));
        return { sector, dur: 300, data: {}, text: `Pirates swarm around ${name(sector)} for 5 minutes. Keep miners and freighters clear, or hunt them.` };
      },
      warlord(ev) {
        const options = within(1, 6).filter(id => !sec(id).owner || sec(id).owner === 'scrapper');
        if (!options.length) return null;
        const sector = pickOne(options), who = pickOne(WARLORDS);
        const boss = spawn(ev, 'corvette', 'scrapper', sector, 'Warlord ' + who, { warlord: true });
        boss.hullMax *= 4; boss.hull = boss.hullMax; boss.shieldMax *= 2; boss.shield = boss.shieldMax;
        for (let i = 0; i < 2; i++) { const g = spawn(ev, 'interceptor', 'scrapper', sector, who.split(' ')[0] + "'s Guard " + (i + 1)); g.orders = [{ type: 'GUARD', target: boss.id }]; }
        return { sector, dur: 600, data: { bounty: 4000, boss: boss.id },
          text: `Warlord ${who} has been seen in ${name(sector)}. 4,000 cr bounty if your ships destroy them within 10 minutes.` };
      },
      war(ev) {
        const pairs = [['apex', 'vanguard'], ['apex', 'scrapper'], ['vanguard', 'scrapper']].sort(() => Math.random() - 0.5);
        const s = state(), conquered = new Set(s.conquests.map(c => c.sector));
        for (const pair of pairs) {
          const [attacker, defender] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
          if (s.aiWars.some(w => (w.a === attacker && w.b === defender) || (w.a === defender && w.b === attacker))) continue;
          const reach = new Set(within(0, 8));
          // Never your home port: losing it to a war you had no part in would be cruel.
          const options = SE.SECTORS.filter(x => x.id !== 'home' && x.owner === defender && x.station && reach.has(x.id) && !conquered.has(x.id) &&
            SE.ADJ[x.id].some(nb => sec(nb).owner === attacker));
          if (!options.length) continue;
          const sector = pickOne(options).id;
          s.aiWars.push({ a: attacker, b: defender, until: world.elapsed + 360 });
          ['corvette', 'corvette', 'interceptor', 'interceptor'].forEach((c, i) => spawn(ev, c, attacker, sector, (attacker === 'apex' ? 'Contract ' : attacker === 'vanguard' ? 'Lance ' : 'Wrecker ') + (i + 1)));
          ['corvette', 'interceptor'].forEach((c, i) => spawn(ev, c, defender, sector, 'Defender ' + (i + 1)));
          return { sector, dur: 360, data: { attacker, defender },
            text: `${SE.FACTIONS[attacker].name} has gone to war with ${SE.FACTIONS[defender].name}. They are fighting over ${name(sector)}.` };
        }
        return null;
      },
      distress(ev) {
        const options = within(1, 4).filter(id => !hostileHeld(id));
        const faction = ['apex', 'vanguard'].filter(f => !SE.hostile('player', f));
        if (!options.length || !faction.length) return null;
        const sector = pickOne(options), f = pickOne(faction);
        const ship = spawn(ev, 'freighter', f, sector, 'Distressed ' + (f === 'apex' ? 'Manifest' : 'Picket'), { distressed: true });
        ship.hullMax *= 6; ship.hull = ship.hullMax; ship.orders = [{ type: 'WAIT', secs: 9999 }];
        for (let i = 0; i < 3; i++) { const p = spawn(ev, 'interceptor', 'scrapper', sector, 'Raider ' + (i + 1)); p.x = ship.x + rand(-160, 160); p.z = ship.z + rand(-160, 160); p.orders = [{ type: 'ATTACK', target: ship.id, committed: true }]; }
        return { sector, dur: 240, data: { faction: f, freighter: ship.id, reward: 1500 },
          text: `Distress call from a ${SE.FACTIONS[f].short} freighter in ${name(sector)}: pirates are attacking it. Save it for 1,500 cr.` };
      },
      cache(ev) {
        const options = within(3, 7).filter(id => !hostileHeld(id));
        if (!options.length) return null;
        const sector = pickOne(options);
        for (let i = 0; i < 2; i++) spawn(ev, 'corvette', 'scrapper', sector, 'Cache Guard ' + (i + 1));
        return { sector, dur: 600, data: { reward: Math.round(rand(30, 50)) * 100 },
          text: `An ancient cache has been found in ${name(sector)}, guarded by pirates. Clear the guards to claim it within 10 minutes.` };
      }
    };

    function start(kind) {
      const s = state();
      const ev = { id: 'ev' + s.eventNo++, kind, start: Math.round(world.elapsed) };
      const made = starters[kind](ev);
      if (!made) { for (const x of shipsOf(ev)) world.registry.remove(x); return null; }
      Object.assign(ev, { sector: made.sector, end: Math.round(world.elapsed + made.dur), data: made.data, text: made.text });
      s.events.push(ev);
      news(made.text, kind === 'surge' || kind === 'warlord' || kind === 'war' ? 'warn' : 'info');
      host.director.audio.play(kind === 'surge' || kind === 'war' ? 'alert' : 'ready');
      host.galaxy.refresh();
      return ev;
    }

    function finish(ev, text, kind, despawn) {
      const s = state();
      s.events = s.events.filter(x => x !== ev);
      if (despawn) for (const x of shipsOf(ev)) world.registry.remove(x);
      if (text) news(text, kind);
      if (kind === 'gain') host.director.audio.play('reward');
      host.galaxy.refresh();
    }

    /* ---- Running events ---------------------------------------------------- */
    const ours = sector => world.registry.inSector(sector).some(x => x.owned && !x.dead);
    const runners = {
      boom(ev, over) { if (over) finish(ev, `The trade boom at ${world.get(ev.data.station)?.name || name(ev.sector)} is over.`); },
      rush(ev, over) { if (over) finish(ev, `The mining rush in ${name(ev.sector)} has played out.`); },
      derelict(ev, over) {
        if (ours(ev.sector)) {
          world.credits += ev.data.reward;
          return finish(ev, `Derelict salvaged in ${name(ev.sector)}: +${Reach.credits(ev.data.reward)} cr.`, 'gain');
        }
        if (over) finish(ev, `The derelict in ${name(ev.sector)} drifted out of reach.`);
      },
      surge(ev, over) {
        if (!shipsOf(ev).length) return finish(ev, `The pirate surge around ${name(ev.sector)} has been broken.`, 'gain');
        if (over) finish(ev, `The pirates around ${name(ev.sector)} have moved on.`, 'info', true);
      },
      warlord(ev, over) {
        if (!world.get(ev.data.boss) || world.get(ev.data.boss).dead) return;   // the kill handler settles it
        if (over) finish(ev, `${world.get(ev.data.boss).name} slipped away.`, 'info', true);
      },
      war(ev, over) {
        if (!over) return;
        const s = state(), { attacker, defender } = ev.data;
        s.aiWars = s.aiWars.filter(w => !((w.a === attacker && w.b === defender) || (w.a === defender && w.b === attacker)));
        const here = world.registry.inSector(ev.sector).filter(warship);
        const att = here.filter(x => x.faction === attacker).length, def = here.filter(x => x.faction === defender).length;
        if (att > def && sec(ev.sector).owner === defender) {
          flip(ev.sector, attacker);
          finish(ev, `${name(ev.sector)} has fallen to ${SE.FACTIONS[attacker].name}. The war is over.`, 'warn');
        } else {
          finish(ev, `${SE.FACTIONS[defender].name} held ${name(ev.sector)}. The war is over.`);
        }
      },
      distress(ev, over) {
        const freighter = world.get(ev.data.freighter);
        const raiders = shipsOf(ev).filter(x => x.faction === 'scrapper');
        if (!freighter || freighter.dead) return finish(ev, `The freighter in ${name(ev.sector)} was lost.`, 'warn', true);
        if (!raiders.length) {
          if (ours(ev.sector)) {
            world.credits += ev.data.reward;
            host.director.reputation(ev.data.faction, 10);
            finish(ev, `Freighter saved in ${name(ev.sector)}: +${Reach.credits(ev.data.reward)} cr and +10 ${SE.FACTIONS[ev.data.faction].short} standing.`, 'gain', true);
          } else finish(ev, `A patrol drove the pirates off the freighter in ${name(ev.sector)}.`, 'info', true);
          return;
        }
        if (over) finish(ev, `The freighter in ${name(ev.sector)} limped away. The pirates went with it.`, 'info', true);
      },
      cache(ev, over) {
        if (!shipsOf(ev).length && ours(ev.sector)) {
          world.credits += ev.data.reward;
          return finish(ev, `Ancient cache claimed in ${name(ev.sector)}: +${Reach.credits(ev.data.reward)} cr.`, 'gain');
        }
        if (over) finish(ev, `The cache in ${name(ev.sector)} was taken by someone else.`, 'info', true);
      }
    };

    // A faction war taking a system: new owner, new defences, recorded for the save.
    function flip(sector, faction) {
      const s = state(), x = sec(sector), st = world.get('st_' + sector);
      x.owner = faction;
      if (st) st.faction = faction;
      for (const g of world.registry.inSector(sector).slice())
        if (!g.owned && SE.isEmplacement(SE.CLASSES[g.cls])) world.registry.remove(g);
      const kinds = SE.DEFENCES[faction];
      for (let i = 0; i < 2; i++) {
        const a = i * Math.PI + 1.1;
        world.registry.add(SE.makeShip({ id: 'def_' + sector + '_f' + s.eventNo + '_' + i, name: SE.CLASSES[kinds[i]].name + ' ' + (i + 1), cls: kinds[i], faction, sector,
          x: Math.cos(a) * 370, y: 0, z: Math.sin(a) * 370, yaw: a + Math.PI / 2 }));
      }
      s.flips[sector] = faction;
    }

    world.events.subscribe(event => {
      if (event.type !== 'kill' || !event.victim.ev) return;
      const ev = state().events.find(x => x.id === event.victim.ev);
      if (!ev || ev.kind !== 'warlord' || !event.victim.warlord) return;
      if (event.killer && event.killer.owned) {
        world.credits += ev.data.bounty;
        finish(ev, `${event.victim.name} destroyed by ${event.killer.name}: +${Reach.credits(ev.data.bounty)} cr bounty.`, 'gain', true);
      } else finish(ev, `${event.victim.name} was killed by someone else. No bounty.`, 'info', true);
    });

    let clock = 0;
    function tick(dt) {
      clock += dt;
      if (clock < 1) return;
      clock = 0;
      const s = state();
      for (const ev of s.events.slice()) runners[ev.kind](ev, world.elapsed >= ev.end);
      if (s.nextEventAt === undefined || s.nextEventAt === null) s.nextEventAt = world.elapsed + 90;
      if (world.elapsed < s.nextEventAt || s.events.length >= MAX) return;
      s.nextEventAt = world.elapsed + rand(EVERY[0], EVERY[1]);
      // Until the tutorial is done, only the gentle kinds.
      const learning = Reach.MILESTONES.some(m => m.tier === 'tutorial' && !s.claimed.includes(m.id));
      const pool = Object.entries(KINDS).filter(([k, d]) => (!learning || d.calm) && !s.events.some(e => e.kind === k));
      let roll = Math.random() * pool.reduce((n, [, d]) => n + d.weight, 0);
      for (const [k, d] of pool) { roll -= d.weight; if (roll <= 0) { if (!start(k)) s.nextEventAt = world.elapsed + 30; break; } }
    }

    // Prices and mining, adjusted by whatever is running.
    world.priceFactor = (stationId, good, side) => {
      if (side !== 'sell') return 1;
      return state().events.some(e => e.kind === 'boom' && e.data.station === stationId && e.data.good === good) ? 2 : 1;
    };
    world.mineFactor = sector => state().events.some(e => e.kind === 'rush' && e.sector === sector) ? 2 : 1;

    function restore() {
      for (const [id, f] of Object.entries(state().flips)) if (sec(id) && !state().conquests.some(c => c.sector === id)) sec(id).owner = f;
    }

    return {
      tick, start, restore, KINDS,
      get list() { return state().events; },
      // For the map: one badge per event.
      badges: () => state().events.map(e => ({ sector: e.sector, icon: KINDS[e.kind].icon, colour: KINDS[e.kind].colour })),
      left: ev => Math.max(0, Math.ceil(ev.end - world.elapsed))
    };
  }

  Events.KINDS = KINDS;
  SE.Events = Events;
})(window.SE = window.SE || {});
