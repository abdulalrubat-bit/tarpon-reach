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
        /* A worker that cannot start is not a reason to lose the game. This
           used to reject every in-flight request with a comment claiming the
           caller would fall back — and no caller did, because there was
           nothing to fall back TO. The rejections became "SAVE FAILED" and the
           game quietly stopped saving. Now the rejection is caught in ask()
           and the work is done here instead. */
        workerDead = true;
        for (const id in pending) { pending[id].reject(new Error('save worker unavailable')); delete pending[id]; }
      };
      return worker;
    }

    /* The same key the worker uses, and the same reasoning behind it: this
       stops a save file being edited in a text editor to grant a few million
       credits. It is obfuscation with a good algorithm behind it, not
       security, and a single-player game with no server has nothing better —
       the device holds both the lock and the key. */
    const KEY = 'se:tarpon-reach:v1:6f2a91c4';

    /* Doing it here, on the main thread, costs a few milliseconds and four
       dropped frames. That is exactly why the worker exists and exactly why
       this is only a fallback — but a stutter is a worse outcome than a
       dropped frame only until you compare it with losing the save entirely.
       Workers fail for reasons the game cannot fix: a file:// page, a locked
       down WebView, a browser that refuses the request. */
    function packHere(payload) {
      const json = JSON.stringify(payload);
      return { blob: CryptoJS.AES.encrypt(json, KEY).toString(), bytes: json.length };
    }
    function unpackHere(blob) {
      const json = CryptoJS.AES.decrypt(blob, KEY).toString(CryptoJS.enc.Utf8);
      if (!json) throw new Error('save did not decrypt — wrong key or corrupt file');
      return { payload: JSON.parse(json) };
    }

    // Once the worker has failed, stop asking. Every save after the first
    // failure would otherwise pay a timeout before falling back.
    let workerDead = false;

    function ask(type, data) {
      if (workerDead) return Promise.resolve(here(type, data));
      return new Promise((resolve, reject) => {
        const id = seq++;
        pending[id] = { resolve, reject };
        try { ensureWorker().postMessage(Object.assign({ type, id }, data)); }
        catch (err) { delete pending[id]; workerDead = true; resolve(here(type, data)); }
      }).catch(err => {
        workerDead = true;
        return here(type, data);
      });
    }

    function here(type, data) {
      return type === 'pack' ? packHere(data.payload) : unpackHere(data.blob);
    }

    /* Only one save in flight at a time, and only the newest one waiting. An
       autosave that lands during a slow write should replace the queued one,
       not join a growing line of stale snapshots that all have to be written. */
    async function save(snapshot) {
      if (saving) { queued = snapshot; return 0; }
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
      isPlayer: s.isPlayer, owned: s.owned,
      // Equipment is saved as ids and nothing else. No derived statistic ever
      // enters the file, so rebalancing a module later changes every ship
      // already carrying it rather than only the ones fitted after the patch.
      fit: s.fit || undefined
    }));

    /* Belt depletion, PER SECTOR.
       It used to be one flat array taken from whichever belt happened to be
       loaded, and restored onto whichever belt happened to be loaded next.
       That was harmless while the player could not leave Tarpon Reach and is
       silent corruption now: mine a seam at home, jump to The Sill, save, and
       The Sill's rocks come back wearing Tarpon Reach's holes. The live
       sector's belt is folded into the table here; every other sector's was
       folded in when the player jumped out of it. */
    const belts = Object.assign({}, world.beltState || {});
    if (world.belt) belts[world.sectorId] = SE.harvestBelt(world.belt);

    return {
      v: 1,
      seed: world.seed,
      at: Date.now(),
      elapsed: r2(world.elapsed),
      sector: world.sectorId,
      credits: world.credits,
      nextId: SE.getNextId(),
      ships,
      belts,                     // { sectorId: [index, remaining, ...] }
      stations: world.stationStock || {},
      /* Accepted contracts are saved; boards are NOT. A board is an offer, and
         an offer that survives a reload is a save-scum: quit, reload, get a
         different four. They are regenerated from the galaxy's own state on
         the next dock, which is where they came from in the first place. */
      contracts: world.contracts || [],
      completed: world.completed || []
    };
  }

  // Positions do not need seventeen significant figures. Rounding before the
  // stringify is the single biggest saving available on a file this shape.
  function r2(n) { return Math.round(n * 100) / 100; }
  function r4(n) { return Math.round(n * 10000) / 10000; }

  SE.Persistence = Persistence;
  SE.snapshot = snapshot;
})(window.SE = window.SE || {});
