// F4: income figures must describe what really happens.
import { ok, eq } from '../assert.mjs';

const facility = (game, kind, sector, level = 1) => game.eval(([kind, sector, level]) => {
  const s = SE_HOST.director.state;
  const p = { id: 'outpost_' + s.nextOutpost++, kind, sector, level, stored: 0, stock: { ore: 0, alloy: 0, cells: 0, scrap: 0 }, cycle: 0, online: true, status: 'Producing' };
  s.outposts.push(p);
  return p.id;
}, [kind, sector, level]);

export default [
  {
    name: 'a foundry with no ore forecasts nothing and is listed as needing attention',
    async run(game) {
      const id = await facility(game, 'refinery', 'harrow');
      const r = await game.eval(id => { const d = SE_HOST.director; const f = d.economy.forecast().get(id); return { rate: f.rate, reason: f.reason, total: d.incomePerMinute, blocked: d.blocked.map(b => b.text) }; }, id);
      eq(r.rate, 0, 'refinery forecast');
      eq(r.total, 0, 'potential income');
      ok(/No ore/.test(r.reason), 'reason: ' + r.reason);
      ok(r.blocked.some(t => /Alloy foundry in Harrow Deep/.test(t)), 'not in the attention list');
    }
  },
  {
    name: 'ore that feeds a foundry is not also counted as sold',
    async run(game) {
      const ex = await facility(game, 'extractor', 'harrow');
      const alone = await game.eval(id => SE_HOST.director.economy.forecast().get(id).rate, ex);
      await facility(game, 'refinery', 'harrow');
      const fed = await game.eval(id => SE_HOST.director.economy.forecast().get(id).rate, ex);
      ok(fed < alone, `extractor forecast ${alone} -> ${fed} with a foundry drawing its ore`);
    }
  },
  {
    name: 'measured income matches what was actually earned',
    async run(game) {
      await game.eval(() => { const d = SE_HOST.director; d.state.claims.push('harrow'); SE.SECTOR_BY_ID.harrow.owner = 'player'; d.resume(); for (const s of SE_HOST.world.registry.all) if (s.duty === 'mine') s.duty = 'escort'; });
      eq(await game.eval(() => SE_HOST.director.actualIncome), null, 'should be measuring at first');
      await game.step(240);
      const r = await game.eval(() => ({ actual: SE_HOST.director.actualIncome, tax: SE_HOST.director.charterIncome() }));
      ok(r.actual !== null, 'no measurement after 4 minutes');
      ok(Math.abs(r.actual - r.tax) <= 2, `measured ${r.actual} vs charter tax ${r.tax}`);
    }
  },
  {
    name: 'a failing save shows a Not saved tag until a save succeeds',
    async run(game) {
      await game.eval(() => SE_HOST.director.resume());
      await game.eval(async () => { const p = SE_HOST.persist, real = p.save; p.save = () => Promise.reject(new Error('Disk full.')); await SE_HOST.autosave(true); p.save = real; SE_HOST.director.shell.updateMap(); });
      ok(!(await game.eval(() => document.getElementById('gx-save').classList.contains('hidden'))), 'tag hidden after a failure');
      await game.eval(async () => { await SE_HOST.autosave(true); SE_HOST.director.shell.updateMap(); });
      ok(await game.eval(() => document.getElementById('gx-save').classList.contains('hidden')), 'tag still shown after a good save');
    }
  }
];
