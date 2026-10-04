// Playtest asks: command any ship from the system view at any time, and buy
// ships without docking.
import { ok, eq } from '../assert.mjs';

const calm = game => game.eval(() => { for (const s of SE_HOST.world.registry.all) if (!s.owned && !SE.isStatic(SE.CLASSES[s.cls]) && SE.hostile('player', s.faction)) s.dead = true; });

// Tap the system view at a world point, as a finger would.
const tapAt = (game, x, z) => game.eval(([x, z]) => {
  const sc = SE_HOST.systemView._scene(), cam = sc.cameras.main;
  sc.pick((x - cam.worldView.x) * cam.zoom, (z - cam.worldView.y) * cam.zoom);
}, [x, z]);

export default [
  {
    name: 'select a ship, tap open space: it flies there and holds, no battle needed',
    async run(game) {
      await calm(game);
      // Tarpon Reach has hostile gun platforms; this test is about moving, not surviving them.
      await game.eval(() => { for (const s of SE_HOST.world.registry.all) if (!s.owned && SE.hostile('player', s.faction)) s.dead = true; });
      await game.eval(async () => { const v = SE_HOST.systemView; v.close(); v.open('home'); await new Promise(r => setTimeout(r, 600)); v.select('wing1'); });
      // Somewhere empty, clear of the station, gates and other ships.
      await tapAt(game, -700, 900);
      const r = await game.eval(() => { const s = SE_HOST.world.get('wing1'); return { duty: s.duty, o: s.orders[0], battle: !!SE_HOST.battles.in('home') }; });
      ok(!r.battle, 'a battle was running');
      eq(r.o && r.o.type, 'MOVE', 'order');
      ok(Math.hypot(r.o.x + 700, r.o.z - 900) < 60, 'destination ' + JSON.stringify(r.o));
      eq(r.duty, 'hold', 'duty');
      await game.step(90);
      const at = await game.eval(() => { const s = SE_HOST.world.get('wing1'); return Math.hypot(s.x + 700, s.z - 900); });
      ok(at < 200, `wing1 is ${Math.round(at)} m from where it was sent`);
    }
  },
  {
    name: 'direct orders: attack a hostile, send through a gate, a freighter leaves its route',
    async run(game) {
      const r = await game.eval(() => {
        const d = SE_HOST.director, w = SE_HOST.world, st = w.get('st_home');
        const foe = SE.makeShip({ id: 'px1', name: 'Raider', cls: 'interceptor', faction: Object.keys(SE.FACTIONS).find(k => SE.hostile('player', k)), sector: 'home', x: 900, y: 0, z: 900, owned: false });
        w.registry.add(foe);
        const atk = d.execute({ type: 'fleet.direct', shipIds: ['wing1'], kind: 'attack', target: 'px1' });
        const atkOrder = w.get('wing1').orders[0];
        const gate = d.execute({ type: 'fleet.direct', shipIds: ['wing1'], kind: 'gate', to: 'lowmark' });
        const g = w.get('wing1');
        {
          d.state.outposts.push({ id: 'outpost_' + d.state.nextOutpost++, kind: 'refinery', sector: 'home', level: 1, stored: 0, stock: { ore: 0, alloy: 100, cells: 0, scrap: 0 }, cycle: 0, online: true, status: 'Producing' });
        }
        const f = SE.makeShip({ id: 'fr1', name: 'Barge', cls: 'freighter', faction: 'player', sector: 'home', x: st.x + 200, y: 0, z: st.z + 200, owned: true });
        w.registry.add(f);
        d.execute({ type: 'route.create', shipId: 'fr1', from: 'home', good: 'alloy', to: { kind: 'market', sector: 'lowmark' } });
        const mv = d.execute({ type: 'fleet.direct', shipIds: ['fr1'], kind: 'move', x: 300, z: 300 });
        return { atk: atk.ok, atkOrder: atkOrder && atkOrder.type + ':' + atkOrder.target, gate: gate.ok, duty: g.duty, post: g.post, jump: g.orders[0] && g.orders[0].to, mv: mv.message, routes: d.state.routes.length, frDuty: f.duty };
      });
      ok(r.atk && r.atkOrder === 'ATTACK:px1', 'attack: ' + r.atkOrder);
      ok(r.gate && r.duty === 'patrol' && r.post === 'lowmark' && r.jump === 'lowmark', 'gate: ' + JSON.stringify(r));
      ok(/left its supply route/.test(r.mv), 'freighter message: ' + r.mv);
      eq(r.routes, 0, 'route still listed');
      eq(r.frDuty, 'hold', 'freighter duty');
    }
  },
  {
    name: 'buy a ship from anywhere at a chosen yard; it saves, builds and joins the fleet',
    async run(game) {
      const r = await game.eval(() => {
        const d = SE_HOST.director, w = SE_HOST.world;
        w.credits = 50000;
        d.resume();
        const docked = d.atPort;
        d.pause('shipyard');
        const html = document.getElementById('panel-body').innerHTML;
        const yards = [...document.querySelectorAll('.yard-chip')].map(b => b.dataset.value);
        document.querySelector('.yard-chip[data-value="st_kestrel"]')?.click();
        document.querySelector('[data-action="buy-ship"][data-value="interceptor"]')?.click();
        const job = d.economy.state.jobs.find(j => j.owned && j.hull === 'interceptor');
        return { docked, port: /Station services are within reach/.test(html), yards, job: job && { station: job.station, phase: job.phase }, credits: w.credits };
      });
      ok(!r.docked, 'test should start undocked');
      ok(!r.port, 'shipyard still asks to dock');
      ok(r.yards.includes('st_kestrel') && r.yards.includes('st_home'), 'yards offered: ' + r.yards.join(','));
      ok(r.job && r.job.station === 'st_kestrel', 'job: ' + JSON.stringify(r.job));
      eq(await game.save(), null, 'save after a remote purchase');
      await game.reload();
      await game.eval(() => SE_HOST.director.resume());
      await calm(game);
      await game.step(120);
      const after = await game.eval(() => { const d = SE_HOST.director, job = d.economy.state.jobs.find(j => j.owned && j.hull === 'interceptor'); const s = job && SE_HOST.world.get(job.shipId); return { phase: job && job.phase, owned: s && s.owned, duty: s && s.duty }; });
      eq(after.phase, 'complete', 'build phase');
      ok(after.owned && (after.duty || 'escort') === 'escort', 'new ship: ' + JSON.stringify(after));
    }
  }
];
