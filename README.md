# Tarpon Reach

Open-world space exploration and empire management, built for a phone. You fly
one hull directly — stick, throttle, trigger — inside a sector rendered in 3D
with real rigid-body physics. Everywhere else, your freighters keep hauling,
your miners keep filling holds and three factions keep running their economies
as arithmetic, at about a twentieth of a millisecond per simulated second.

This is a **vertical slice**, not a finished game. What is here is playable end
to end and verified; a good deal of the design brief is not built yet, and the
last section of this file says exactly which parts.

Open `index.html` over http, or from `file://` — the service worker is skipped
there on purpose, so local dev and a WebView build both work.

## The one idea the whole thing is built on

Every ship in the galaxy is a **ShipState**: a flat data object with a position,
a quaternion, a hold and an order queue. No mesh, no rigid body, no idea whether
anyone is watching. Thirty-seven of them cost nothing measurable.

Ships in the sector you are actually in also get a **ShipPhysicsView** — a
Three.js group and an Ammo rigid body, attached on entry and destroyed on exit.
While a view exists, physics owns the transform and writes it back into the
state every frame. When it does not, the same AI integrates the same numbers by
hand.

That is the whole architecture, and everything else follows from it:

- `ai.js` is written against an interface, never against a sector. It asks
  "where is the nearest ore" and gets back a rock in the live sector and a
  plausible point in the band everywhere else. It cannot tell which, and it is
  not allowed to find out — the moment the AI can reach for a mesh, every ship
  needs one.
- Mining yields the same ore per second in both branches, deliberately. An
  economy that depends on whether anyone is looking teaches players to sit in
  a sector to make their miners work faster.
- `ShipState` is flat, with no methods, because the save worker
  structured-clones it to another thread. A state with behaviour attached
  cannot make that trip at all.

A miner three jumps away fills its hold, finds no buyer in its sector, runs A*
across the galaxy graph, takes the first leg, jumps, and sells. Nobody watches
it happen. Fast-forwarding an hour of that for six sectors takes 70 ms.

## Files

```
index.html          shell, HUD chrome, all CSS, boot
src/rng.js          seeded randomness — the universe is regenerated, not stored
src/universe.js     the rule book: factions, hull classes, weapons, goods,
                    the galaxy graph and A* across it
src/state.js        ShipState and the registry
src/ai.js           one order-queue state machine, two ways of applying it
src/pools.js        the object pool
src/view.js         ShipPhysicsView — hulls from primitives, bodies, teleports
src/field.js        the belt: 10,000 rocks, one draw call, instance-id picking
src/combat.js       guns, wreckage, the tractor beam
src/radar.js        the holographic dial, and touch-to-command
src/controls.js     the floating stick, the throttle, the trigger
src/world.js        what the AI is allowed to ask, and who answers
src/persistence.js  localForage bridge and the snapshot
src/saveWorker.js   serialise and encrypt, off the main thread
src/game.js         the sector scene, which wires all of the above together
tools/stamp-sw.py   the service-worker stamper — run it after ANY change
vendor/             Phaser 3, enable3d (Three.js), Ammo WASM, localForage, CryptoJS
```

About 3,400 lines of game over 3.5 MB of engine.

## The engine, and what it cost

The studio line is "hand-written, no engine unless one earns its place", and
this build breaks it on purpose: Phaser 3 for the 2D layer and input, enable3d
for the Three.js/Ammo glue, Ammo's WebAssembly build for rigid-body physics,
localForage for storage and CryptoJS for the save file. All of it is vendored
into `vendor/` rather than loaded from a CDN, so the game still installs and
runs with no network.

The bill is about 3.5 MB, against roughly 210 KB for *Vanguard Orbit*. It buys
a solver that handles a compound capital-ship hull hitting an asteroid without
anyone writing a contact manifold, and it is paid once at install rather than
every launch.

Two things were dropped as dead weight:

- **Ammo's asm.js fallback (2 MB).** `PhysicsLoader` reaches for it only when
  `WebAssembly` is missing, and nothing that can run Phaser 3 on WebGL2 is
  missing WebAssembly.
- **d3-delaunay.** The brief wants Voronoi faction borders on a galaxy map.
  There is no galaxy map screen yet, so the library would be 19 KB of nothing.
  It goes in with the screen.

enable3d no longer publishes a browser bundle — the npm package is ES modules
for a bundler. `vendor/enable3d.bundle.min.js` is built from
`@enable3d/phaser-extension@0.26.1` with esbuild, as an IIFE exposing
`window.ENABLE3D`, with `phaser` aliased to a shim that reads `window.Phaser`
so Phaser is not bundled twice.

## What the numbers actually are

Measured in headless Chromium at 412×915. Every one of these is from a real
run, not an estimate:

| | |
|---|---|
| Draw calls, whole scene | **11** |
| Triangles | 69,376 |
| Rocks in the belt | 10,000 (3,200 drawn) |
| Ships in the galaxy | 37, of which 9 have physics bodies |
| Out-of-sector simulation | 0.058 ms per simulated second, ~30 ships, 6 sectors |
| Save file | 12.5 KB serialised, 16.7 KB encrypted |
| Shipped shell | 3.61 MB over 25 files |

Eleven draw calls covers the belt, every ship, every projectile in flight, the
crates, the starfield and the entire 2D HUD.

**The frame rate is the one number not to trust.** The test browser rasterises
in software (SwiftShader), where each instanced rock costs about 11.5 µs of CPU
regardless of its size on screen — so the belt alone takes the frame from 54 fps
to 7.5 fps there. That cost is linear in instance count and almost entirely the
software rasteriser's instancing path, which is exactly the work a real GPU
parallelises; 69k triangles is a mid-range phone's idle budget. But it has not
been run on a phone, so **on-device frame rate is unknown**, and the honest
reading of the numbers above is "the draw-call and triangle budget is right",
not "it runs at 60".

The belt is drawn through a **window**: the mesh has 3,200 instance slots and
each repack fills them with the nearest rocks that are not far behind the
camera, keyed slot→rock so a raycast hit still maps to the right row. One draw
call either way, but a bounded one, and the fog's far plane is set to the cull
radius so the window has no visible edge. Repacking runs only after 40 m of
travel or a noticeable turn — every frame would re-upload the buffer sixty
times a second to answer a question whose answer barely changes.

## Three bugs worth writing down

Found by testing rather than by reading, and all three were silent:

1. **`body.needUpdate = true` does nothing on most bodies.** enable3d only
   honours it for *kinematic* objects. On a dynamic or static body it is
   ignored, Ammo writes its stale transform back the next frame, and the object
   appears where you put it for exactly one frame. This made salvage crates
   snap back to their parking spot the instant they spawned.
2. **Setting a dynamic body's motion state moves nothing.** Bullet reads the
   motion state for kinematic bodies and *writes* it for dynamic ones — a
   dynamic body's authority is its own world transform. `SE.placeBody()` in
   `view.js` now sets both, clears forces, and wakes the body.
3. **The belt was completely intangible.** The pooled rock collision bodies
   were static, so by (1) they never moved off their parking spot and nothing
   ever collided with a rock. They are kinematic now. Verified: a corvette
   closing at 60 m/s stops dead at 11.8 m from a rock of radius 8.6.

## What is built

Flying, with a floating stick whose centre is wherever your thumb lands, a
throttle that stays where you leave it, and thrust as real force through a real
rigid body against the mass in the class table. Guns, shields that regenerate
and hulls that do not, wreckage that scatters on an impulse and a tractor beam
that pulls harder the closer you get. A belt you can tap a rock in and mine, and
bounce off. A radar that projects world X/Z onto a dial and un-projects a tap
back into a world point — select one of your hulls, tap the map, and that is the
fleet interface. Wingmen that take MOVE, ATTACK, MINE, TRADE and GUARD orders
and carry them out with the same code whether you are watching or not. Trade
against station stock, with prices that fall as a station gluts. Autosave that
serialises and AES-encrypts on a worker thread and lands in IndexedDB. The whole
thing installs and plays with no network.

## What is not built

Straight from the brief, so it is clear what is missing rather than merely
absent:

- **The player cannot jump between sectors.** The graph, A*, lane exits and the
  transfer all work and out-of-sector fleets use them constantly — there is no
  jump drive on your own hull yet, so you play in Tarpon Reach.
- **No galaxy map screen**, and therefore no Voronoi borders. These are one
  feature, not two.
- **No sieges or blockades.** Stations have shields and a hold; nothing yet
  starves them of Energy Cells to drop the regeneration to zero.
- **No hangar docking.** The three-phase lerp-in sequence is not written.
- **No mission board.** No weighted generation, no bounties, no escorts.
- **No interdiction.** Pirates do not roll against haulers crossing lanes.
- **Capital-ship turrets do not track independently.** A dreadnought fires at
  its target from the hull; the turret meshes are decoration.
- **The dt clamp means the game slows down rather than skipping** below 20 fps.
  That is the right trade against a physics engine exploding on a long step,
  but on a device that cannot hold 20 fps it will read as slow motion.
- **Balance is arithmetic, not playtesting.** The damage and shield numbers
  were chosen so a two-on-one takes about three seconds of sustained fire. No
  human has played it.

## Adding it to the studio page

Not done. `spaceempire/` is playable at `/spaceempire/` as soon as this merges,
but nothing links to it from the site's front page — putting an unreleased
prototype on a public storefront is a decision, not a chore, and it is yours.
