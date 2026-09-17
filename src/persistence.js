/* Saving, without a hitch.
 *
 * localForage rather than localStorage, for two reasons that are really the
 * same reason. localStorage is synchronous — every read and write blocks the
 * main thread, including the paint you were in the middle of — and it is
 * capped around 5MB of UTF-16, which a galaxy of ship states plus a belt's
 * worth of deltas will pass. localForage routes to IndexedDB, which is
 * asynchronous and effectively unbounded, and falls back on its own if a
 * browser somehow has neither.
 *
 * The heavy part — stringify and encrypt — happens in saveWorker.js. This file
 * is only the bridge: it builds the snapshot, ships it to the worker, and
 * hands whatever comes back to localForage without ever waiting on either.
 */
(function (SE) {
  'use strict';

  const STORE_KEY = 'commander';

  function Persistence() {
    let worker = null;
    let seq = 1;
    const pending = Object.create(null);
    let saving = false;
    let queued = null;

    const store = localforage.createInstance({
      name: 'space-empire',
      storeName: 'saves',
      description: 'Encrypted commander files'
    });

    function ensureWorker() {
      if (worker) return worker;
      worker = new Worker('src/saveWorker.js');
      worker.onmessage = e => {
        const m = e.data || {};
        const p = pending[m.id];
        if (!p) return;
        delete pending[m.id];
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve(m);
      };
      worker.onerror = err => {
        // A worker that cannot start is not a reason to lose the game. Every
        // in-flight request fails, the caller falls back, and play continues.
        for (const id in pending) { pending[id].reject(new Error('save worker failed: ' + err.message)); delete pending[id]; }
      };
      return worker;
    }

    function ask(type, data) {
      return new Promise((resolve, reject) => {
        const id = seq++;
        pending[id] = { resolve, reject };
        ensureWorker().postMessage(Object.assign({ type, id }, data));
      });
    }

    /* Only one save in flight at a time, and only the newest one waiting. An
       autosave that lands during a slow write should replace the queued one,
       not join a growing line of stale snapshots that all have to be written. */
    async function save(snapshot) {
      if (saving) { queued = snapshot; return; }
      saving = true;
      try {
        const packed = await ask('pack', { payload: snapshot });
        await store.setItem(STORE_KEY, { blob: packed.blob, at: Date.now(), v: 1 });
        return packed.bytes;
      } finally {
        saving = false;
        if (queued) { const q = queued; queued = null; save(q); }
      }
    }

    async function load() {
      const rec = await store.getItem(STORE_KEY);
      if (!rec || !rec.blob) return null;
      const out = await ask('unpack', { blob: rec.blob });
      return out.payload;
    }

    async function wipe() { await store.removeItem(STORE_KEY); }

    async function has() { return !!(await store.getItem(STORE_KEY)); }

    return { save, load, wipe, has };
  }

  /* ---- The snapshot ----------------------------------------------------
     What is worth writing down, and nothing else. The belt is the interesting
     case: ten thousand rocks are generated from a seed, so they are not saved
     — only the handful that have been mined, as index/remaining pairs. That is
     the whole reason the universe is seeded. */
  function snapshot(world) {
    const ships = world.registry.all.map(s => ({
      id: s.id, name: s.name, cls: s.cls, faction: s.faction, sector: s.sector,
      x: r2(s.x), y: r2(s.y), z: r2(s.z),
      qx: r4(s.qx), qy: r4(s.qy), qz: r4(s.qz), qw: r4(s.qw),
      vx: r2(s.vx), vy: r2(s.vy), vz: r2(s.vz),
      hull: r2(s.hull), shield: r2(s.shield),
      cargo: s.cargo, credits: s.credits,
      orders: s.orders, dead: s.dead,
      isPlayer: s.isPlayer, owned: s.owned
    }));

    const belt = [];
    if (world.belt) {
      const b = world.belt;
      for (let k = 0; k < b.oreIdx.length; k++) {
        const i = b.oreIdx[k];
        if (b.ore[i] < b.oreMax[i] - 0.5) belt.push(i, Math.round(b.ore[i]));
      }
    }

    return {
      v: 1,
      seed: world.seed,
      at: Date.now(),
      elapsed: r2(world.elapsed),
      sector: world.sectorId,
      credits: world.credits,
      nextId: SE.getNextId(),
      ships,
      belt,                      // flat [index, remaining, index, remaining, ...]
      stations: world.stationStock || {}
    };
  }

  // Positions do not need seventeen significant figures. Rounding before the
  // stringify is the single biggest saving available on a file this shape.
  function r2(n) { return Math.round(n * 100) / 100; }
  function r4(n) { return Math.round(n * 10000) / 10000; }

  SE.Persistence = Persistence;
  SE.snapshot = snapshot;
})(window.SE = window.SE || {});
