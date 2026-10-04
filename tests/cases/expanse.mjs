// Systems are a large expanse: gates ~5 km out, asteroid fields away from the
// station, points of interest where events happen, a minimap and jump chips.
import { ok, eq } from '../assert.mjs';

export default [
  {
    name: 'layouts are fixed per system, spread out and clear of the gate lanes',
    async run(game) {
      const r = await game.eval(() => {
        const out = [];
        for (const sec of SE.SECTORS.slice(0, 20)) {
          const L = SE.Expanse.layout(sec.id), again = JSON.stringify(SE.Expanse.layout(sec.id));
          const lay = SE_HOST.world.transit.layout(sec.id);
          const gates = Object.values(lay.gates).map(k => lay.nodes[k]);
          const near = (p, r) => gates.some(g => { const len = Math.hypot(g.x, g.z), t = Math.max(0, Math.min(1, (p.x * g.x + p.z * g.z) / (len * len))); return Math.hypot(p.x - g.x * t, p.z - g.z * t) < r; });
          out.push({ id: sec.id, belt: !!sec.belt, fields: L.fields.length, sites: L.sites.length, bodies: L.bodies.length, same: again === JSON.stringify(L),
            far: L.fields.every(f => Math.hypot(f.x, f.z) > 1500) && L.sites.every(s => Math.hypot(s.x, s.z) > 2000),
            lanes: L.fields.filter(f => near({ x: f.x, z: f.z }, f.r * 0.8)).length, gate: Math.round(Math.hypot(gates[0].x, gates[0].z)) });
        }
        return out;
      });
      for (const s of r) {
        ok(s.same, s.id + ': layout changed between calls');
        ok(s.belt ? s.fields >= 2 && s.fields <= 3 : s.fields === 0, s.id + ': fields ' + s.fields);
        ok(s.sites >= 2 && s.bodies >= 1 && s.far, s.id + ': ' + JSON.stringify(s));
        eq(s.gate, 5200, s.id + ' gate distance');
      }
      const crossing = r.reduce((n, s) => n + s.lanes, 0);
      ok(crossing <= 2, crossing + ' fields sit across a gate lane');
    }
  },
  {
    name: 'miners dig inside a field, events happen at a site, and a field order works',
    async run(game) {
      const r = await game.eval(() => {
        const w = SE_HOST.world, d = SE_HOST.director, m = w.get('mine1');
        for (const s of w.registry.all) if (!s.owned && SE.hostile('player', s.faction)) s.dead = true;
        d.execute({ type: 'fleet.order', shipId: 'mine1', role: 'mine' }); d.resume();
        for (let i = 0; i < 4 * 30; i++) SE_HOST.step(0.25);
        const L = SE.Expanse.layout('home'), od = m.orderData;
        const inField = od && L.fields.some(f => Math.hypot(od.x - f.x, od.z - f.z) <= f.r);
        // Send it to the field farthest from the station.
        const far = L.fields.slice().sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z))[0];
        const order = d.execute({ type: 'fleet.direct', shipIds: ['mine1'], kind: 'field', field: far.id });
        const sent = m.orderData && Math.hypot(m.orderData.x - far.x, m.orderData.z - far.z) <= far.r;
        // A raid: its ships appear at one of the system's points of interest.
        const E = d.scene.events;
        E.start('surge');
        const raiders = w.registry.all.filter(s => s.ev && !s.dead);
        const atSite = raiders.every(s => SE.Expanse.layout(s.sector).sites.some(site => Math.hypot(s.x - site.x, s.z - site.z) < site.r + 400));
        return { inField, order: order.ok, sent, duty: m.duty, raiders: raiders.length, atSite, hasStart: !!E.start };
      });
      ok(r.inField, 'mining point not inside a field');
      ok(r.order && r.sent && r.duty === 'mine', 'field order: ' + JSON.stringify(r));
      ok(r.raiders > 0, 'the raid spawned no ships');
      ok(r.atSite, 'raiders spawned away from every site');
    }
  },
  {
    name: 'minimap and jump chips move the view across the system',
    async run(game) {
      const r = await game.eval(async () => {
        const v = SE_HOST.systemView; v.close(); v.open('home');
        await new Promise(res => setTimeout(res, 700));
        const sc = v._scene(), cam = sc.cameras.main, mid = () => ({ x: Math.round(cam.midPoint.x), y: Math.round(cam.midPoint.y) });
        const start = mid();
        document.querySelector('#sys-jump [data-what="field"]').click();
        await new Promise(res => setTimeout(res, 700));
        const field = mid(), L = SE.Expanse.layout('home');
        const onField = L.fields.some(f => Math.hypot(f.x - field.x, f.z - field.y) < 60);
        const mini = document.getElementById('sys-mini'), box = mini.getBoundingClientRect();
        mini.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5 }));
        await new Promise(res => setTimeout(res, 700));
        const centre = mid();
        return { start, field, onField, centre, mini: [Math.round(box.width), Math.round(box.height)] };
      });
      ok(r.onField, 'Field chip did not centre a field: ' + JSON.stringify(r));
      ok(Math.hypot(r.centre.x, r.centre.y) < 120, 'minimap tap did not centre the system: ' + JSON.stringify(r.centre));
      ok(r.mini[0] > 80 && r.mini[1] > 80, 'minimap size ' + r.mini);
    }
  }
];
