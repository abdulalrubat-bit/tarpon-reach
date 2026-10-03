// Phase 3: freight routes connect facilities, markets and shipyards, keep
// goods and money whole, and say why whenever they wait.
import { ok, eq } from '../assert.mjs';

const facility = (game, kind, sector, level = 1, stock = {}) => game.eval(([kind, sector, level, stock]) => {
  const s = SE_HOST.director.state;
  const p = { id: 'outpost_' + s.nextOutpost++, kind, sector, level, stored: 0, stock: Object.assign({ ore: 0, alloy: 0, cells: 0, scrap: 0 }, stock), cycle: 0, online: true, status: 'Producing' };
  s.outposts.push(p);
  return p.id;
}, [kind, sector, level, stock]);

// A freighter of your own, docked at Reach Anchorage, with the sky cleared of pirates.
const freighter = (game, id = 'fr1') => game.eval(id => {
  const w = SE_HOST.world, st = w.get('st_home');
  const s = SE.makeShip({ id, name: 'Barge ' + id, cls: 'freighter', faction: 'player', sector: 'home', x: st.x + 120, y: 0, z: st.z + 120, owned: true });
  w.registry.add(s);
  s.duty = 'hold';
  SE_HOST.director.resume();
  return s.cargoMax;
}, id);
const calm = game => game.eval(() => { for (const s of SE_HOST.world.registry.all) if (!s.owned && !SE.isStatic(SE.CLASSES[s.cls]) && SE.hostile('player', s.faction)) s.dead = true; });
const route = (game, cmd) => game.eval(cmd => SE_HOST.director.execute(Object.assign({ type: 'route.create' }, cmd)), cmd);
const routeState = game => game.eval(() => JSON.parse(JSON.stringify(SE_HOST.director.state.routes[0] || null)));
const steps = async (game, secs) => { for (let t = 0; t < secs; t += 60) { await calm(game); await game.step(60); } };

export default [
  {
    name: 'extract, refine and ship alloy to the home yard for a sustained session',
    async run(game) {
      ok(await freighter(game) >= 100, 'freighter hold');
      await facility(game, 'extractor', 'home', 3);
      await facility(game, 'refinery', 'home', 2);
      const r = await route(game, { shipId: 'fr1', from: 'home', good: 'alloy', to: { kind: 'yard', sector: 'home' } });
      ok(r.ok, 'route.create: ' + r.message);
      const seen = [];
      for (let k = 0; k < 4; k++) {
        await steps(game, 600);
        const s = await game.eval(() => ({ stock: SE_HOST.director.state.yardStock.st_home?.alloy || 0, route: SE_HOST.director.state.routes[0], blocked: SE_HOST.director.blocked.map(b => b.text) }));
        seen.push(s.stock);
        eq(s.stock, s.route.delivered, 'yard store equals what the route delivered');
        ok(!s.blocked.some(t => /Supply route/.test(t)), 'route needed attention: ' + s.blocked.join(' | '));
      }
      for (let k = 1; k < seen.length; k++) ok(seen[k] > seen[k - 1], `deliveries stalled: ${seen.join(' -> ')}`);
    }
  },
  {
    name: 'alloy in the yard store takes 30% off a hull, once',
    async run(game) {
      const r = await game.eval(() => {
        const d = SE_HOST.director, w = SE_HOST.world, me = w.get('player'), st = w.get('st_home');
        me.sector = 'home'; me.x = st.x + 80; me.z = st.z + 80;
        d.state.xp = 5000;
        w.credits = 200000;
        const need = Reach.BUILD_DEFINITIONS.corvette.materials.alloy;
        d.state.yardStock.st_home = { alloy: need + 7 };
        const offer = Reach.HULLS.find(h => h.id === 'corvette');
        const before = w.credits;
        const a = d.economy.queue(st, 'corvette', 9101);
        const paidA = before - w.credits;
        const mid = w.credits;
        const b = d.economy.queue(st, 'corvette', 9102);
        const paidB = mid - w.credits;
        return { a: a.ok, b: b.ok, msg: a.message, paidA, paidB, price: offer.price, need, left: d.state.yardStock.st_home.alloy };
      });
      ok(r.a && r.b, 'commission failed: ' + r.msg);
      ok(Math.abs(r.paidA - r.price * 0.7) < 1, `first hull paid ${r.paidA} of ${r.price}`);
      // The 7 left over take a sliver off the second.
      const partial = r.price * (1 - 0.3 * 7 / r.need);
      ok(Math.abs(r.paidB - partial) < 1, `second hull paid ${r.paidB}, expected ${partial}`);
      eq(r.left, 0, 'alloy left in the store');
      ok(/30% off/.test(r.msg), 'message: ' + r.msg);
    }
  },
  {
    name: 'a market route sells at the market price and earns credits',
    async run(game) {
      await freighter(game);
      await facility(game, 'extractor', 'home', 1, { ore: 400 });
      ok((await route(game, { shipId: 'fr1', from: 'home', good: 'ore', to: { kind: 'market', sector: 'lowmark' } })).ok, 'route.create');
      await steps(game, 900);
      const r = await routeState(game);
      ok(r.trips >= 1, 'no trip finished: ' + r.note);
      ok(r.earned > 0, 'earned nothing');
    }
  },
  {
    name: 'an industry route feeds a foundry with no extractor beside it',
    async run(game) {
      await freighter(game);
      await facility(game, 'extractor', 'home', 3, { ore: 300 });
      const foundry = await facility(game, 'refinery', 'harrow');
      ok((await route(game, { shipId: 'fr1', from: 'home', good: 'ore', to: { kind: 'industry', sector: 'harrow' } })).ok, 'route.create');
      await steps(game, 1200);
      const r = await game.eval(id => { const p = SE_HOST.director.state.outposts.find(o => o.id === id); return { ore: p.stock.ore, alloy: p.stock.alloy, sold: p.stored, route: SE_HOST.director.state.routes[0], rate: SE_HOST.director.economy.forecast().get(id).rate }; }, foundry);
      ok(r.route.delivered > 0, 'nothing delivered: ' + r.route.note);
      ok(r.alloy > 0 || r.sold > 0 || r.rate > 0, 'the foundry made nothing from imported ore');
    }
  },
  {
    name: 'a lost freighter and a hostile destination both explain themselves',
    async run(game) {
      await freighter(game, 'fr1');
      await freighter(game, 'fr2');
      await facility(game, 'extractor', 'home', 1, { ore: 400 });
      ok((await route(game, { shipId: 'fr1', from: 'home', good: 'ore', to: { kind: 'market', sector: 'lowmark' } })).ok, 'route 1');
      ok((await route(game, { shipId: 'fr2', from: 'home', good: 'ore', to: { kind: 'market', sector: 'lowmark' } })).ok, 'route 2');
      await game.eval(() => { SE_HOST.world.get('fr1').dead = true; });
      await steps(game, 60);
      const lost = await game.eval(() => ({ route: SE_HOST.director.state.routes.find(r => r.ship === 'fr1'), blocked: SE_HOST.director.blocked.map(b => b.text) }));
      ok(lost.route.lost, 'route not marked lost');
      ok(lost.blocked.some(t => /Supply route/.test(t) && /freighter/.test(t)), 'lost route not in the attention list');
      // Lowmark's station turns hostile while the second freighter is on its way.
      await game.eval(() => { const st = SE_HOST.world.get('st_lowmark'); st.faction = Object.keys(SE.FACTIONS).find(f => SE.hostile('player', f)); const r = SE_HOST.director.state.routes.find(r => r.ship === 'fr2'); r.phase = 'deliver'; SE.addCargo(SE_HOST.world.get('fr2'), 'ore', 50); });
      const aboard = await game.eval(() => Math.floor(SE_HOST.world.get('fr2').cargo.ore || 0));
      let note = '';
      for (let k = 0; k < 15 && !/no longer has a friendly station/.test(note); k++) { await steps(game, 60); note = (await game.eval(() => SE_HOST.director.state.routes.find(r => r.ship === 'fr2').note)); }
      ok(/no longer has a friendly station/.test(note), 'note: ' + note);
      eq(await game.eval(() => Math.floor(SE_HOST.world.get('fr2').cargo.ore || 0)), aboard, 'cargo kept aboard while waiting');
    }
  },
  {
    name: 'reload mid-delivery keeps the cargo, phase and route',
    async run(game) {
      await freighter(game);
      await facility(game, 'extractor', 'home', 1, { ore: 400 });
      ok((await route(game, { shipId: 'fr1', from: 'home', good: 'ore', to: { kind: 'market', sector: 'lowmark' } })).ok, 'route.create');
      let r;
      for (let k = 0; k < 20; k++) { await steps(game, 30); r = await routeState(game); if (r.phase === 'deliver') break; }
      eq(r.phase, 'deliver', 'never set off');
      const before = await game.eval(() => ({ ore: SE_HOST.world.get('fr1').cargo.ore, credits: SE_HOST.world.credits }));
      eq(await game.save(), null, 'save error');
      await game.reload();
      const after = await game.eval(() => ({ ore: SE_HOST.world.get('fr1')?.cargo.ore, duty: SE_HOST.world.get('fr1')?.duty, route: SE_HOST.director.state.routes[0], credits: SE_HOST.world.credits }));
      eq(after.ore, before.ore, 'cargo after reload');
      eq(after.duty, 'freight', 'duty after reload');
      eq(after.route.phase, 'deliver', 'phase after reload');
      ok(Math.abs(after.credits - before.credits) < 1, 'credits changed across reload');
      await game.eval(() => SE_HOST.director.resume());
      await steps(game, 600);
      ok((await routeState(game)).trips >= 1, 'route did not resume after reload');
    }
  },
  {
    name: 'facilities keep exported goods for the freighter instead of selling them to a broker',
    async run(game) {
      await freighter(game);
      const ex = await facility(game, 'extractor', 'home', 1, { ore: 300 });
      await facility(game, 'refinery', 'harrow');
      ok((await route(game, { shipId: 'fr1', from: 'home', good: 'ore', to: { kind: 'industry', sector: 'harrow' } })).ok, 'route.create');
      await game.eval(() => { SE_HOST.world.get('fr1').orders = [{ type: 'FLEE', from: 'x' }]; });
      // While the freighter is held up, the source keeps its ore well past the usual 120.
      await game.eval(() => { for (let i = 0; i < 40 * 4; i++) { SE_HOST.world.get('fr1').orders = [{ type: 'FLEE', from: 'x' }]; SE_HOST.step(0.25); } });
      // Ore at the source plus ore in the hold: none of it went to a broker.
      const ore = await game.eval(id => SE_HOST.director.state.outposts.find(o => o.id === id).stock.ore + (SE_HOST.world.get('fr1').cargo.ore || 0), ex);
      ok(ore >= 300, `only ${ore} of 300+ ore left between the source and the hold`);
      const note = await game.eval(() => { const d = SE_HOST.director; SE_HOST.world.get('fr1').orders = [{ type: 'FLEE', from: 'x' }]; d.scene.freight.tick(); return d.state.routes[0].note; });
      eq(note, 'Under attack: route paused', 'paused note');
    }
  }
];
