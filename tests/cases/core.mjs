// The main loops, end to end: if one of these breaks, the game is broken.
import { ok, eq } from '../assert.mjs';

const clearHostiles = game => game.eval(() => { for (const s of SE_HOST.world.registry.all) if (!s.owned && !SE.isStatic(SE.CLASSES[s.cls]) && SE.hostile('player', s.faction)) s.dead = true; });

export default [
  {
    name: 'save and reload keep credits, ships and position',
    async run(game) {
      const before = await game.eval(() => { SE_HOST.world.credits = 12345; return { ships: SE_HOST.world.registry.all.length, sector: SE_HOST.world.sectorId }; });
      eq(await game.save(), null, 'save');
      await game.reload();
      const after = await game.eval(() => ({ credits: Math.round(SE_HOST.world.credits), ships: SE_HOST.world.registry.all.length, sector: SE_HOST.world.sectorId }));
      eq(after.credits, 12345, 'credits');
      eq(after.ships, before.ships, 'ship count');
      eq(after.sector, before.sector, 'sector');
    }
  },
  {
    name: 'the tutorial can be finished by following the guide card',
    async run(game) {
      await game.eval(() => SE_HOST.director.resume());
      for (let i = 0; i < 160; i++) {
        const done = await game.eval(() => Reach.MILESTONES.filter(m => m.tier === 'tutorial').every(m => SE_HOST.director.state.claimed.includes(m.id)));
        if (done) return;
        await clearHostiles(game);
        await game.eval(() => {
          const d = SE_HOST.director;
          if (d.paused && d.shell.panel === 'shipyard') { const b = document.querySelector('button[data-action="buy-ship"][data-value="interceptor"]:not([disabled])'); if (b) b.click(); d.resume(); return; }
          if (SE_HOST.systemView.open_) SE_HOST.systemView.close();   // back to the map, as a player would
          if (d.paused) d.resume();
          d.shell.updateMap();
          const b = document.querySelector('#gx-objective button:not([disabled])');
          if (b) b.click();
        });
        await game.step(20);
      }
      const left = await game.eval(() => Reach.MILESTONES.filter(m => m.tier === 'tutorial' && !SE_HOST.director.state.claimed.includes(m.id)).map(m => m.id));
      eq(left, [], 'tutorial steps left');
    }
  },
  {
    name: 'five warships capture a two-platform Scrapper system',
    async run(game) {
      await game.eval(() => {
        const H = SE_HOST, w = H.world, me = w.player;
        for (const s of w.registry.all.filter(s => s.owned && s.cls !== 'extractor')) w.iface(s.sector).jump(s, 'sill');
        ['corvette', 'corvette', 'corvette'].forEach((c, i) => { const s = SE.makeShip({ cls: c, faction: 'player', sector: 'sill', owned: true, name: 'Extra ' + i, x: 0, y: 0, z: 0 }); s.duty = 'escort'; w.registry.add(s); });
        w.sectorId = 'sill'; H.playerSector = 'sill';
        for (const s of w.registry.all.filter(s => s.owned && s.sector === 'sill')) { s.x = 1300; s.z = 200; s.orders = []; }
        for (const s of w.registry.inSector('sill')) if (!s.owned && !SE.isStatic(SE.CLASSES[s.cls])) s.dead = true;
        H.director.resume();
        H.sieges.attackDefences('sill');
      });
      let owner = null;
      for (let k = 0; k < 20 && owner !== 'player'; k++) { await game.step(30); owner = await game.eval(() => SE.SECTOR_BY_ID.sill.owner); }
      eq(owner, 'player', 'owner after 10 minutes');
      eq(await game.save(), null, 'save after capture');
    }
  },
  {
    name: 'every galaxy event kind starts and ends cleanly',
    async run(game) {
      await game.eval(() => { const d = SE_HOST.director; for (const m of Reach.MILESTONES) if (m.tier === 'tutorial') d.state.claimed.push(m.id); d.state.nextEventAt = 1e9; d.resume(); });
      const started = await game.eval(() => ['boom', 'rush', 'derelict', 'surge', 'warlord', 'war', 'distress', 'cache'].filter(k => SE_HOST.events.start(k)));
      ok(started.length >= 7, 'only started: ' + started.join(','));
      eq(await game.save(), null, 'save with events running');
      await game.step(660);
      eq(await game.eval(() => SE_HOST.events.list.length), 0, 'events still running after 11 minutes');
    }
  },
  {
    name: 'fleet orders: squadron, send to guard, recall',
    async run(game) {
      await game.eval(() => SE_HOST.director.resume());
      const r = await game.eval(() => {
        const d = SE_HOST.director;
        d.execute({ type: 'squad.create', shipIds: ['wing1'] });
        d.execute({ type: 'fleet.order', shipIds: ['wing1'], role: 'patrol', post: 'harrow' });
        return { squads: d.state.squads.length, duty: SE_HOST.world.get('wing1').duty, post: SE_HOST.world.get('wing1').post };
      });
      eq(r, { squads: 1, duty: 'patrol', post: 'harrow' }, 'after orders');
      // Pirates on the way are gameplay, not what this case checks.
      for (let k = 0; k < 6; k++) { await clearHostiles(game); await game.step(20); }
      eq(await game.eval(() => SE_HOST.world.get('wing1')?.sector), 'harrow', 'guard did not reach its post');
      await game.eval(() => SE_HOST.director.execute({ type: 'fleet.recall' }));
      eq(await game.eval(() => SE_HOST.world.get('wing1').duty), 'escort', 'recall');
      eq(await game.save(), null, 'save');
    }
  },
  {
    name: 'every panel and the system view render without errors',
    async run(game) {
      for (const p of ['overview', 'empire', 'fleet', 'contracts', 'industry', 'factions', 'settings']) await game.eval(p => SE_HOST.director.pause(p), p);
      await game.eval(() => { SE_HOST.director.resume(); SE_HOST.systemView.open('home'); });
      await game.page.waitForTimeout(800);
      await game.eval(() => SE_HOST.systemView.close());
    }
  }
];
