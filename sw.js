/* Tarpon Reach, offline.
 *
 * Cache-first over the whole shell: none of it changes between deploys, and the
 * point of installing a game is a game that opens with no signal. The shell here
 * is large — most of it is Ammo's WebAssembly and Phaser — which is the bill for
 * choosing an engine, paid once at install rather than every launch.
 *
 * VERSION is a hash of the shipped bytes, stamped by tools/stamp-sw.py. Keyed by
 * hand it is a key someone forgets to bump, and a forgotten bump strands a player
 * on an old build with no way to know it.
 */
const VERSION = '08cc3cb1d795';
const CACHE = 'tarponreach-' + VERSION;

const SHELL = [
  './',
  'index.html',
  'src/rng.js',
  'src/universe.js',
  'src/state.js',
  'src/ai.js',
  'src/pools.js',
  'src/detail.js',
  'src/view.js',
  'src/field.js',
  'src/combat.js',
  'src/radar.js',
  'src/controls.js',
  'src/world.js',
  'src/persistence.js',
  'src/game.js',
  'src/saveWorker.js',
  'app.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-mask-512.png',
  'vendor/crypto-js.min.js',
  'vendor/enable3d.bundle.min.js',
  'vendor/localforage.min.js',
  'vendor/phaser.min.js',
  'vendor/ammo/ammo.wasm.js',
  'vendor/ammo/ammo.wasm.wasm'
];

self.addEventListener('install', e => {
  // Take over at once rather than waiting for every tab to close. A game is one
  // tab, and the alternative is an update that lands whenever.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Drop every older build's cache: two copies of a shell this size on a phone
    // is not free, and a stale one can never be served by accident.
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;   // never touch remote
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // Caching a 404 is how a half-succeeded deploy becomes permanent.
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await caches.match('index.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
