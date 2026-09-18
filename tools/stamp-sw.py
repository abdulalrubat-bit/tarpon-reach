#!/usr/bin/env python3
"""Regenerate sw.js with the current shell list and a content-derived version.

    python3 tools/stamp-sw.py

Run after ANY change to the shipped files. VERSION is a hash of the bytes being
shipped, so it cannot be forgotten the way a hand-edited cache key can — and a
forgotten bump strands an installed player on an old build with no way to know
it, on a device you cannot reach.

The vendor directory is walked rather than listed, because it is the part of the
shell most likely to gain a file and least likely to be remembered.
"""
import hashlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))

OWN = [
    'index.html',
    'src/rng.js', 'src/universe.js', 'src/state.js', 'src/ai.js', 'src/pools.js',
    'src/detail.js', 'src/view.js', 'src/field.js', 'src/combat.js', 'src/radar.js', 'src/controls.js',
    'src/world.js', 'src/persistence.js', 'src/game.js', 'src/saveWorker.js',
    'app.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-mask-512.png',
]

vendor = []
for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, 'vendor')):
    dirnames.sort()
    for f in sorted(filenames):
        rel = os.path.relpath(os.path.join(dirpath, f), ROOT).replace(os.sep, '/')
        vendor.append(rel)

files = OWN + vendor

missing = [f for f in files if not os.path.exists(os.path.join(ROOT, f))]
if missing:
    raise SystemExit('stamp-sw: these are in the shell list but not on disk:\n  ' + '\n  '.join(missing))

h = hashlib.sha256()
total = 0
for f in files:
    h.update(f.encode())
    with open(os.path.join(ROOT, f), 'rb') as fh:
        b = fh.read()
        total += len(b)
        h.update(b)
version = h.hexdigest()[:12]
shell = '\n'.join("  '%s'," % f for f in files).rstrip(',')

TEMPLATE = '''/* Tarpon Reach, offline.
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
const VERSION = '{version}';
const CACHE = 'tarponreach-' + VERSION;

const SHELL = [
  './',
{shell}
];

self.addEventListener('install', e => {{
  // Take over at once rather than waiting for every tab to close. A game is one
  // tab, and the alternative is an update that lands whenever.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
}});

self.addEventListener('activate', e => {{
  e.waitUntil((async () => {{
    // Drop every older build's cache: two copies of a shell this size on a phone
    // is not free, and a stale one can never be served by accident.
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  }})());
}});

self.addEventListener('fetch', e => {{
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;   // never touch remote
  e.respondWith((async () => {{
    const hit = await caches.match(req, {{ ignoreSearch: true }});
    if (hit) return hit;
    try {{
      const res = await fetch(req);
      // Caching a 404 is how a half-succeeded deploy becomes permanent.
      if (res && res.ok && res.type === 'basic') {{
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }}
      return res;
    }} catch (err) {{
      if (req.mode === 'navigate') {{
        const shell = await caches.match('index.html', {{ ignoreSearch: true }});
        if (shell) return shell;
      }}
      throw err;
    }}
  }})());
}});
'''

with open(os.path.join(ROOT, 'sw.js'), 'w') as fh:
    fh.write(TEMPLATE.format(version=version, shell=shell))

print('sw.js stamped %s over %d files, %.2f MB' % (version, len(files), total / 1048576.0))
