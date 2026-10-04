import { ok } from '../assert.mjs';

export default [
  {
    name: 'art is distinct, cached, theme-aware and bounded for unknown values',
    async run(game) {
      const r = await game.eval(() => {
        const a = SE.ShipArt, classes = Object.keys(a.SHAPES);
        const images = classes.map(c => a.icon(c, 'player', 'ops'));
        const fallback = a.canvas('missing', 'missing', 'unknown', 'unknown');
        return {
          distinct: new Set(images).size === classes.length,
          theme: a.icon('freighter', 'player', 'ops') !== a.icon('freighter', 'player', 'tactical'),
          reuse: a.canvas('corvette', 'apex') === fallback,
          safe: ['toString', '__proto__', 'constructor'].every(c => a.canvas(c, c) === fallback),
          sizes: classes.every(c => [0, .2, 1, 6, 1000, NaN].every(z => { const n = a.mapSize(c, z); return Number.isFinite(n) && n >= 22 && n <= 62; }))
        };
      });
      for (const [key, value] of Object.entries(r)) ok(value, key + ' failed');
    }
  },
  {
    name: 'mobile map keeps small hulls selectable and refreshes textures without replacing sprites',
    async run(game) {
      const r = await game.eval(async () => {
        const w = SE_HOST.world, v = SE_HOST.systemView;
        const ship = SE.makeShip({ id: 'icon_probe', name: 'Icon probe', cls: 'interceptor', faction: 'player', sector: 'home', x: 700, y: 0, z: 600, owned: true });
        ship.duty = 'hold'; ship.vx = ship.vz = 0; w.registry.add(ship);
        v.close(); v.open('home'); v.setTheme('ops');
        await new Promise(r => setTimeout(r, 600));
        const sc = v._scene(), cam = sc.cameras.main;
        const old = sc.sprites.get(ship.id).hull;
        const small = old.displayWidth * cam.zoom;
        // Tap outside the visible interceptor, but within its 26px touch radius.
        sc.pick((ship._vx - cam.worldView.x) * cam.zoom + 22, (ship._vy - cam.worldView.y) * cam.zoom);
        const picked = /Icon probe/.test(document.getElementById('sys-panel').textContent);
        const glowIdle = !sc.sprites.get(ship.id).glow.visible;
        ship.cls = 'freighter'; ship.faction = 'apex';
        await new Promise(r => setTimeout(r, 100));
        const changed = sc.sprites.get(ship.id);
        const reuse = changed.hull === old && changed.key.includes('freighter:apex:ops:');
        cam.setZoom(sc.fit * 6);
        await new Promise(r => setTimeout(r, 100));
        const close = changed.hull.displayWidth * cam.zoom;
        const smallerThanPort = changed.hull.displayWidth < sc.stationFrame.displayWidth / 2;
        v.setTheme('tactical');
        await new Promise(r => setTimeout(r, 200));
        const tactical = sc.sprites.get(ship.id).key.includes(':tactical:');
        v.close(); v.open('home');
        await new Promise(r => setTimeout(r, 200));
        const reopen = v._scene().sprites.has(ship.id);
        return { picked, glowIdle, reuse, small, close, smallerThanPort, tactical, reopen };
      });
      ok(r.picked, 'small ship lost its touch target');
      ok(r.glowIdle, 'idle ship still glows');
      ok(r.reuse, 'class/faction did not refresh in place');
      ok(r.small <= 34 && r.close <= 46.01, 'hull exceeded size cap: ' + JSON.stringify(r));
      ok(r.smallerThanPort, 'ship obscures the port');
      ok(r.tactical && r.reopen, 'theme/reopen lost the icon');
    }
  }
];
