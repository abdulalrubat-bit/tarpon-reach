// The system screen: scenery builds, and the overview offers the right next step.
import { ok } from '../assert.mjs';

const panel = (game, id) => game.eval(async id => { SE_HOST.systemView.close(); SE_HOST.systemView.open(id); await new Promise(r => setTimeout(r, 900)); return document.getElementById('sys-panel').innerText; }, id);

export default [
  {
    name: 'overview: dock at home, send fleet to a frontier, besiege a hostile system',
    async run(game) {
      const home = await panel(game, 'home');
      ok(/Dock/.test(home) && /Friendly port/i.test(home), 'home: ' + home);
      const harrow = await panel(game, 'harrow');
      ok(/Send fleet here/.test(harrow) && /Unclaimed/.test(harrow), 'harrow: ' + harrow);
      const sill = await panel(game, 'sill');
      ok(/hostile/i.test(sill) && /Besiege/.test(sill), 'sill: ' + sill);
      ok(await game.eval(() => { const sc = SE_HOST.systemView._scene(); return sc.nebula.visible || sc.lowFx; }), 'scenery missing');
    }
  }
];
