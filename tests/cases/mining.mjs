// F2: a miner left alone keeps mining and selling, deposit after deposit.
import { ok, eq } from '../assert.mjs';

export default [
  {
    name: 'mine and sell cycles continue for 40 game minutes without new orders',
    async run(game) {
      await game.eval(() => {
        const w = SE_HOST.world;
        for (const s of w.registry.all) if (!s.owned && !SE.isStatic(SE.CLASSES[s.cls]) && SE.hostile('player', s.faction)) s.dead = true;
        SE_HOST.director.execute({ type: 'fleet.order', shipId: 'mine1', role: 'mine' });
        SE_HOST.director.resume();
      });
      const sold = [];
      for (let m = 0; m < 4; m++) {
        await game.step(600);
        await game.eval(() => { for (const s of SE_HOST.world.registry.all) if (!s.owned && !SE.isStatic(SE.CLASSES[s.cls]) && SE.hostile('player', s.faction)) s.dead = true; });
        sold.push(await game.eval(() => Math.floor(SE_HOST.director.state.metrics.sold)));
        // A stuck ship's recovery climb once ran away to kilometres of altitude.
        const y = await game.eval(() => SE_HOST.world.get('mine1').y);
        ok(y < 1200, `miner climbed to ${Math.round(y)} m`);
      }
      for (let k = 1; k < sold.length; k++) ok(sold[k] > sold[k - 1], `sales stalled between checks: ${sold.join(' -> ')}`);
      ok(sold[3] > 600, `only ${sold[3]} ore sold in 40 minutes`);
    }
  },
  {
    name: 'an exhausted deposit is never mined again',
    async run(game) {
      const r = await game.eval(() => {
        const w = SE_HOST.world, s = w.get('mine1'), api = w.iface(s.sector);
        s.orderData = { sector: s.sector, x: 900, y: 0, z: 0, ore: 0 };
        const node = api.mineNode(s, -1);
        return { ore: node.ore, same: node.x === 900 && node.z === 0 };
      });
      ok(r.ore > 0, 'selected an empty deposit');
      ok(!r.same, 'reused the exhausted deposit');
    }
  },
  {
    name: 'a miner in a system without a belt sells its load instead of mining',
    async run(game) {
      const r = await game.eval(() => {
        const w = SE_HOST.world, s = w.get('mine1');
        w.iface(s.sector).jump(s, 'lowmark');
        s.cargo = { ore: 60 }; s.duty = 'mine'; s.orders = [];
        for (let i = 0; i < 4 * 120; i++) SE_HOST.step(0.25);
        return { ore: Math.floor(s.cargo.ore || 0), status: SE_HOST.director.shell.shipStatus(s) };
      });
      eq(r.ore, 0, 'ore left aboard');
      ok(/No asteroid belt/.test(r.status), 'status: ' + r.status);
    }
  }
];
