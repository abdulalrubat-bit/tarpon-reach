// Miners and freighters do not tag along: they wait at a station on standby
// until given a job, and the station lists them with their jobs.
import { ok, eq } from '../assert.mjs';

const calm = game => game.eval(() => { for (const s of SE_HOST.world.registry.all) if (!s.owned && SE.hostile('player', s.faction)) s.dead = true; });

export default [
  {
    name: 'a new game: Ladle waits at the station, and the station card lists it with jobs',
    async run(game) {
      await calm(game);
      await game.eval(() => SE_HOST.director.resume());
      await game.step(120);
      const r = await game.eval(async () => {
        const w = SE_HOST.world, m = w.get('mine1'), st = w.get('st_home'), v = SE_HOST.systemView;
        v.close(); v.open('home'); await new Promise(res => setTimeout(res, 500));
        const sc = v._scene(), cam = sc.cameras.main;
        sc.pick((st.x - cam.worldView.x) * cam.zoom, (st.z - cam.worldView.y) * cam.zoom);
        const panel = document.getElementById('sys-panel');
        const text = panel.innerText, mine = panel.querySelector('[data-action="order"][data-value="mine1:mine"]');
        mine && mine.click();
        return { duty0: 'standby', near: Math.round(Math.hypot(m.x - st.x, m.z - st.z)), text, clicked: !!mine, duty: m.duty, status: SE_HOST.director.shell.shipStatus(m) };
      });
      ok(r.near < 600, 'Ladle is not parked at the station: ' + r.near + ' m');
      ok(/WAITING HERE/.test(r.text) && /Ladle/.test(r.text), 'station card: ' + r.text);
      ok(r.clicked && r.duty === 'mine', 'Mine button did not assign the job: ' + JSON.stringify(r));
    }
  },
  {
    name: 'haulers stay when the flagship jumps; a bought freighter waits at its yard',
    async run(game) {
      await calm(game);
      const r = await game.eval(() => {
        const d = SE_HOST.director, w = SE_HOST.world;
        d.resume();
        w.credits = 60000; d.state.xp = 5000;
        const buy = d.execute({ type: 'ship.buy', hullId: 'freighter', stationId: 'st_home', request: 7001 });
        for (let i = 0; i < 4 * 90; i++) SE_HOST.step(0.25);
        const job = d.economy.state.jobs.find(j => j.owned && j.hull === 'freighter'), f = job && w.get(job.shipId);
        const before = { ladle: w.get('mine1').sector, wing: w.get('wing1').sector };
        d.scene.setCourse('lowmark');
        for (let i = 0; i < 4 * 400 && w.player.sector === 'home'; i++) SE_HOST.step(0.25);
        for (let i = 0; i < 4 * 20; i++) SE_HOST.step(0.25);
        return { buy: buy.ok, msg: buy.message, fduty: f && f.duty, fsector: f && f.sector, me: w.player.sector, ladle: w.get('mine1').sector, wing: w.get('wing1').sector, wingDuty: w.get('wing1').duty, before };
      });
      ok(r.buy, 'purchase failed: ' + r.msg);
      eq(r.fduty, 'standby', 'new freighter duty');
      eq(r.me, 'lowmark', 'flagship did not arrive');
      eq(r.ladle, 'home', 'Ladle followed the flagship');
      eq(r.fsector, 'home', 'the new freighter followed the flagship');
      eq(r.wing, 'lowmark', 'the escort warship should still follow');
    }
  },
  {
    name: 'an older save: escorting haulers are parked once, and standby survives reload',
    async run(game) {
      await game.eval(() => {
        const d = SE_HOST.director, m = SE_HOST.world.get('mine1');
        m.duty = 'escort'; d.state.haulersParked = false;
      });
      eq(await game.save(), null, 'save');
      await game.reload();
      const r = await game.eval(() => { SE_HOST.director.resume(); for (let i = 0; i < 8; i++) SE_HOST.step(0.25); return { duty: SE_HOST.world.get('mine1').duty, parked: SE_HOST.director.state.haulersParked }; });
      eq(r.duty, 'standby', 'old escorting miner not parked');
      ok(r.parked, 'migration flag not set');
      eq(await game.save(), null, 'save after migration');
      await game.reload();
      eq(await game.eval(() => SE_HOST.world.get('mine1').duty), 'standby', 'standby lost on reload');
    }
  }
];
