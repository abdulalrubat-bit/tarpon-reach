// F3: a siege needs your warships near the station, not just in the system.
import { ok, eq } from '../assert.mjs';

// Your fleet in The Sill with the defences and guards cleared away.
const stage = (game, x, z) => game.eval(([x, z]) => {
  const H = SE_HOST, w = H.world;
  for (const s of w.registry.all.filter(s => s.owned && s.cls !== 'extractor')) w.iface(s.sector).jump(s, 'sill');
  w.sectorId = 'sill'; H.playerSector = 'sill';
  for (const s of w.registry.inSector('sill')) if (!s.owned && s.cls !== 'station') s.dead = true;
  for (const s of w.registry.inSector('sill')) if (s.owned) { s.x = x; s.z = z; s.orders = [{ type: 'WAIT', secs: 9999 }]; s.duty = 'hold'; s.battleOrder = true; }
  H.director.resume();
}, [x, z]);
const siege = game => game.eval(() => { const x = SE_HOST.sieges.status('sill'); return { phase: x.phase, progress: x.progress, suppressed: !!x.station.suppressed }; });

export default [
  {
    name: 'ships far from the station make no progress',
    async run(game) {
      await stage(game, 1600, 1600);       // inside the system, ~2.3 km out
      await game.step(60);
      const s = await siege(game);
      eq(s.phase, 'outside', 'phase');
      eq(s.progress, 0, 'progress');
      ok(!s.suppressed, 'station guns were silenced from outside the blockade');
    }
  },
  {
    name: 'ships near the station besiege it, and leaving lets it recover',
    async run(game) {
      await stage(game, 600, 300);
      await game.step(30);
      const a = await siege(game);
      eq(a.phase, 'sieging', 'phase near the station');
      ok(a.progress > 0.15, `progress ${a.progress}`);
      ok(a.suppressed, 'station guns not silenced');
      await game.eval(() => { for (const s of SE_HOST.world.registry.inSector('sill')) if (s.owned) { s.x = 1600; s.z = 1600; } });
      await game.step(30);
      const b = await siege(game);
      eq(b.phase, 'outside', 'phase after pulling back');
      ok(b.progress < a.progress, 'progress did not fall back');
    }
  },
  {
    name: 'siege progress survives save and reload',
    async run(game) {
      await stage(game, 600, 300);
      await game.step(30);
      const before = (await siege(game)).progress;
      eq(await game.save(), null, 'save');
      await game.reload();
      const after = await game.eval(() => SE_HOST.director.state.sieges.sill || 0);
      ok(Math.abs(after - before) < 0.02, `progress ${before} -> ${after}`);
    }
  }
];
