// F1: buying ships must never make the game unsaveable.
import { ok, eq } from '../assert.mjs';

let req = 1;
const buy = (game, hull = 'interceptor') => game.eval(([h, r]) => SE_HOST.director.execute({ type: 'ship.buy', hullId: h, request: r }), [hull, 1000 + req++]);
const dockHome = game => game.eval(() => { SE_HOST.world.credits = 100000; SE_HOST.director.dock(SE_HOST.world.get('st_home')); });
const live = game => game.eval(() => SE_HOST.director.economy.state.jobs.filter(j => !['complete', 'cancelled'].includes(j.phase)).map(j => [j.owned, j.phase]));

export default [
  { name: 'a fresh game saves', async run(game) { eq(await game.save(), null, 'save error'); } },
  {
    name: 'one, two and four commissions beside the civic job all save',
    async run(game) {
      await dockHome(game);
      for (const n of [1, 2, 3, 4]) {
        const r = await buy(game);
        ok(r.ok, `purchase ${n} refused: ${r.message}`);
        eq(await game.save(), null, `save after ${n} purchase(s)`);
      }
      const jobs = await live(game);
      eq(jobs.filter(j => j[0]).length, 4, 'player jobs');
      ok(jobs.some(j => !j[0]), 'civic job still present');
    }
  },
  {
    name: 'a fifth commission at one yard is refused',
    async run(game) {
      await dockHome(game);
      for (let n = 0; n < 4; n++) ok((await buy(game)).ok, 'purchase refused');
      const fifth = await buy(game);
      ok(!fifth.ok, 'fifth purchase was accepted');
      eq(await game.save(), null, 'save after refusal');
    }
  },
  {
    name: 'mid-build save reloads, and every paid hull is commissioned exactly once',
    async run(game) {
      await dockHome(game);
      for (let n = 0; n < 3; n++) ok((await buy(game)).ok, 'purchase refused');
      await game.step(10);
      eq(await game.save(), null, 'mid-build save');
      await game.reload();
      eq((await live(game)).filter(j => j[0]).length, 3, 'player jobs after reload');
      await game.eval(() => SE_HOST.director.resume());
      await game.step(60);
      const ids = await game.eval(() => SE_HOST.world.registry.all.filter(s => s.id.startsWith('commission_')).map(s => s.id));
      eq(ids.length, 3, 'commissioned hulls');
      eq(new Set(ids).size, 3, 'distinct hulls');
      eq(await game.save(), null, 'save after commissioning');
    }
  },
  {
    name: 'an older save with a waiting paid commission loads and builds it',
    async run(game) {
      // Shape of a commission written before ships became credits-only.
      await game.eval(() => {
        const e = SE_HOST.director.economy, st = SE_HOST.world.get('st_home');
        const job = e.makeJob(st, 'interceptor', false, 220000, 'Legacy');
        Object.assign(job, { owned: true, escrow: 220000, phase: 'waiting', duration: Reach.BUILD_DEFINITIONS.interceptor.seconds, status: 'Waiting for materials' });
        e.state.jobs.push(job);
      });
      eq(await game.save(), null, 'legacy save');
      await game.reload();
      await game.eval(() => SE_HOST.director.resume());
      await game.step(40);
      const built = await game.eval(() => SE_HOST.world.registry.all.filter(s => s.id.startsWith('commission_') && s.owned).length);
      eq(built, 1, 'legacy hull commissioned');
      eq(await game.save(), null, 'save afterwards');
    }
  }
];
