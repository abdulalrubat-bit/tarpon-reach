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
      ok(await game.eval(() => { const sc = SE_HOST.systemView._scene(); return sc.stationFrame.visible && sc.tags.length > 0; }), 'scenery missing');
    }
  },
  {
    name: 'map modes switch and supply lines follow freight routes',
    async run(game) {
      const r = await game.eval(async () => {
        const d = SE_HOST.director, s = d.state, w = SE_HOST.world, st = w.get('st_home');
        s.outposts.push({ id: 'outpost_' + s.nextOutpost++, kind: 'refinery', sector: 'home', level: 1, stored: 0, stock: { ore: 0, alloy: 200, cells: 0, scrap: 0 }, cycle: 0, online: true, status: 'Producing' });
        const f = SE.makeShip({ id: 'fr1', name: 'Barge', cls: 'freighter', faction: 'player', sector: 'home', x: st.x + 200, y: 0, z: st.z + 200, owned: true });
        w.registry.add(f);
        d.execute({ type: 'route.create', shipId: 'fr1', from: 'home', good: 'alloy', to: { kind: 'market', sector: 'lowmark' } });
        const v = SE_HOST.systemView;
        v.close(); v.open('home');
        await new Promise(res => setTimeout(res, 700));
        const sc = v._scene(), legs = sc.routeLegs().map(l => l.label);
        const tags = sc.tags.map(t => t.title.text);
        v.setTheme('tactical');
        await new Promise(res => setTimeout(res, 300));
        const tac = { cls: document.getElementById('system').className, pressed: document.querySelector('[data-sys-mode=tactical]').getAttribute('aria-pressed') };
        v.setTheme('ops');
        return { legs, tags, tac, ops: document.getElementById('system').className };
      });
      ok(r.legs.includes('ALLOY'), 'no alloy route line: ' + r.legs.join(','));
      ok(r.tags.includes('FOUNDRY 01'), 'no foundry label: ' + r.tags.join(','));
      ok(r.tags.some(t => / GATE$/.test(t)), 'no gate labels');
      ok(/theme-tac/.test(r.tac.cls) && r.tac.pressed === 'true', 'tactical not applied: ' + JSON.stringify(r.tac));
      ok(/theme-ops/.test(r.ops), 'operations not restored');
    }
  },
  {
    name: 'ship card: escort, evade, focus and the route button',
    async run(game) {
      const r = await game.eval(async () => {
        const d = SE_HOST.director, w = SE_HOST.world, st = w.get('st_home'), v = SE_HOST.systemView;
        const f = SE.makeShip({ id: 'fr1', name: 'Barge', cls: 'freighter', faction: 'player', sector: 'home', x: st.x + 200, y: 0, z: st.z + 200, owned: true });
        w.registry.add(f); f.duty = 'hold';
        v.close(); v.open('home');
        await new Promise(res => setTimeout(res, 500));
        v.setTheme('ops'); v.select('fr1');
        const ops = document.getElementById('sys-panel').innerText;
        v.setTheme('tactical'); v.select('fr1');
        const tac = document.getElementById('sys-panel').innerText;
        document.querySelector('#sys-panel [data-sys-cmd=escort]').click();
        const guard = d.fleet.find(x => x.commanderId === 'fr1');
        const evadeNone = d.execute({ type: 'fleet.evade', shipId: 'fr1' });
        const foe = SE.makeShip({ id: 'px1', name: 'Raider', cls: 'interceptor', faction: Object.keys(SE.FACTIONS).find(k => SE.hostile('player', k)), sector: 'home', x: f.x + 300, y: 0, z: f.z, owned: false });
        w.registry.add(foe);
        const evade = d.execute({ type: 'fleet.evade', shipId: 'fr1' });
        document.querySelector('#sys-panel [data-sys-cmd=focus]')?.click();
        v.setTheme('ops');
        return { ops, tac, guard: guard && { duty: guard.duty, order: guard.orders[0]?.type, status: d.shell.shipStatus(guard) }, evadeNone: evadeNone.ok, evade: evade.ok, head: f.orders[0]?.type, hostile: SE.hostile('player', foe.faction) };
      });
      ok(/CHANGE ROUTE|FREIGHT ROUTE/i.test(r.ops) && /FOCUS/i.test(r.ops) && /CARGO/.test(r.ops), 'operations card: ' + r.ops);
      ok(/ASSIGN ESCORT/i.test(r.tac) && /EVADE/i.test(r.tac) && /HULL/.test(r.tac), 'tactical card: ' + r.tac);
      ok(r.guard && r.guard.duty === 'escort' && /Escorting Barge/.test(r.guard.status), 'escort not assigned: ' + JSON.stringify(r.guard));
      ok(!r.evadeNone, 'evade with nobody near should refuse');
      ok(r.hostile, 'test foe is not hostile');
      ok(r.evade && r.head === 'FLEE', 'evade did not flee: ' + r.head);
    }
  }
];
