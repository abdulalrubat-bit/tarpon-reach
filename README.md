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
src/view.js         ShipPhysicsView — the palette, hulls from primitives,
                    the bake that collapses them, bodies and teleports
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
| Draw calls, whole scene | **7** |
| Triangles | 76,460 |
| Rocks in the belt | 10,000 (3,200 drawn) |
| Ships in the galaxy | 37, of which 9 have physics bodies |
| Out-of-sector simulation | 0.058 ms per simulated second, ~30 ships, 6 sectors |
| Save file | 12.5 KB serialised, 16.7 KB encrypted |
| Shipped shell | 3.63 MB over 25 files |

Seven draw calls covers the belt, every ship on screen, the station, every
projectile in flight, the crates, the starfield and the entire 2D HUD.

Where the triangles actually go is worth knowing, because it is not where it
feels like they go:

| | triangles |
|---|---|
| The belt (3,200 rocks drawn) | 64,000 |
| Vanguard fortress | 6,974 |
| Apex ring and tower | 5,588 |
| Dreadnought | 4,330 |
| Scrapper junk station | 3,438 |
| Corvette | 1,672 |
| Freighter | 1,456 |
| Extractor | 1,208 |
| Interceptor | 1,024 |

The belt is 81% of the scene and every station ever built for this game put
together is under a tenth of it. Detail on hulls is not what costs; twelve
thousand instanced rocks is.

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

## The art direction, and why it is geometry

The ships are drawn from the concept art's palettes rather than its pixels.
Every value in `FACPAL` was sampled off a reference ship, which is why they are
odd numbers instead of round ones.

None of it is a texture. The reference pieces are top-down and rear-view
sprites; the game has a chase camera sitting about sixteen degrees above and
behind the ship, so a billboard would be cardboard the moment you pitched.
Everything is geometry and vertex colour, which works from every angle and
still ships no assets.

**The faction is the hull.** An earlier pass put every ship in the same navy
and let a stripe carry the faction. The art says otherwise, in eight ships and
without ambiguity: the corporate shuttle is white with deep navy panels, the
junkyard rig is rust with amber hazard banding, the military hull is slate
stencilled in yellow. So the hull carries the identity now and the trim is the
smallest part of it — a fleet you can name at a glance from its colour beats
one you can only name from a stripe.

| | hull | banding | drives |
|---|---|---|---|
| **You** | dark navy | gold | magenta |
| **Apex Logistics** | white — the only light faction, and most of why they read as expensive | blue | cold cyan |
| **The Scrapper Syndicate** | rust over dark iron | amber hazard | burning amber |
| **Vanguard Division** | slate | yellow hazard | blue |

Three things that only matter because of the camera and the lighting:

- **The wings have anhedral.** A flat wing seen from sixteen degrees up is very
  nearly edge-on — all trailing edge, no planform. Drooping the tips turns the
  swept shape back toward the camera so it is visible in play.
- **A painted edge and a wing's thickness are different materials.** They were
  the same near-white at first, and since a chase camera sees mostly trailing
  edge, every wing came out banded in chrome.
- **The palette is albedo, not appearance.** The reference art is already lit,
  so authoring a material at the reference's apparent colour and lighting it
  again darkens it twice: the first version of this palette put a slate
  military hull and a navy one at the same near-black, which a
  hull-identifies-the-faction scheme cannot survive. Each value is opened up by
  roughly what the scene's lighting takes back out.

The scene lighting changed with it, from a flat dark-blue ambient to a
hemisphere. A flat ambient meant every surface facing away from the key light
collapsed to near-black, which is atmospheric and useless: it is exactly the
surfaces a chase camera sees. The hemisphere keeps undersides dark and lets the
tops of things be the colour they actually are — the belt gained more from this
than the ships did.

### Authored as parts, drawn as one object

`buildHull()` returns twenty-odd little meshes, which is a pleasant way to
author a ship and a bad way to draw one. So the parts are authored and then
immediately collapsed: each part's transform is baked into its vertices, its
material's colour into a per-vertex colour, and the whole ship lands in one
geometry with two groups — the surfaces that take the light, and the surfaces
that *are* light. Two draw calls per ship whatever it is made of, cached per
class and faction because every Vanguard interceptor is the same bytes.

The re-skin took the scene from 11 draw calls to 46 before this; baking took it
to 5. The detail is free — adding hazard striping, lattice bracing, container
ribs and a canopy to the whole roster afterwards cost 24 triangles and no draw
calls at all.

## The rendering pass — provisional

Built to answer one question: how close can real-time geometry get to the
concept art before it is worth abandoning 3D? It is in the tree so it can be
judged, and the answer is not settled.

What it adds:

- **Bloom**, at half resolution. Every drive, window and neon strip in the
  reference bleeds light, and that bleed is most of what makes those images
  read as photographs of something hot rather than as diagrams. A threshold
  above every lit hull tone and below the glow bucket means only things that
  ARE light bloom, so a white Apex hull does not turn into a lamp. Bloom is a
  five-level gaussian pyramid over the whole frame — the most expensive thing
  in the renderer — and it is also blur, the one effect where half the
  resolution costs nothing you can see.
- **A generated panel texture.** Plates from a recursive split rather than a
  grid, seams, rivets along the plate edges, and wear. Drawn into a canvas at
  boot, about 40ms and one 512-square texture, no files.
- **Metal.** MeshStandardMaterial with a generated environment, because a
  specular response is a large part of what "painted metal" means and Lambert
  has none. The environment is not optional: a metal surface with nothing to
  reflect renders black, which is correct physics and a useless picture.
- **Three stations that are three buildings.** Vanguard is a disc fortress:
  saucer hull, rim gun blisters, command spire, antenna crown, two hangar pods
  slung beneath. Apex is a commercial ring around an advertising tower, where
  everything bright is signage. Scrapper is not designed but accumulated — two
  pressure hulls off different ships bolted either side of somebody else's
  mast, patched with plate that does not match, ringed with the debris it has
  not cut up yet. The only symmetry on it is accidental, which is what makes it
  read as salvage next to two stations that are perfectly symmetrical.
- **A shared parts bin.** The references keep reusing the same pieces — banded
  tank modules, solar wings on trusses, lattice masts, dishes, glass domes — so
  those are written once and assembled differently. It is what lets three
  stations be three buildings instead of three versions of one.
- **A ship roster rebuilt to the same standard.** The capital is a terraced
  arrowhead — four swept plates stacked narrower and narrower, gold along each
  terrace EDGE rather than across it, a ladder of lit segments down the spine
  and a row of barrels on every step. The freighter carries one big container a
  side with corner brackets and hazard diagonals rather than a stack of small
  ones, because a single slab says freight instantly where three little boxes
  just say greebles. The corvette got the same greeble density the stations
  got; the shuttle deliberately did not, because on that hull the smoothness is
  the statement, so it got seams and nav lights instead.

What it costs, measured in the same software rasteriser as everything else:
about a third of the frame for the material and texture, and a further fifth
for bloom. On a GPU both are the work the hardware exists to do, so the real
figure is unknown and probably much smaller — but it is a real cost, and it is
the reason this section says provisional.

Two texture lessons worth keeping: detail meant to survive a reflective surface
has to be drawn far harder than detail meant to be seen flat (the first version
was invisible), and the bake re-projects UVs from world space rather than
carrying the primitives' own, because a box maps every face to 0..1 and a
54-metre plate would otherwise get the same panel count as a 1-metre collar.

## Four bugs worth writing down

Found by testing rather than by reading, and every one was silent:

1. **`body.needUpdate = true` does nothing on most bodies.** enable3d only
   honours it for *kinematic* objects. On a dynamic or static body it is
   ignored, Ammo writes its stale transform back the next frame, and the object
   appears where you put it for exactly one frame. This made salvage crates
   snap back to their parking spot the instant they spawned.
2. **Setting a dynamic body's motion state moves nothing.** Bullet reads the
   motion state for kinematic bodies and *writes* it for dynamic ones — a
   dynamic body's authority is its own world transform. `SE.placeBody()` in
   `view.js` now sets both, clears forces, and wakes the body.
3. **`placeBody` moved bodies without rotating them.** Ammo kept the old
   orientation and wrote it back over the mesh on the next frame, so a ship
   teleported to the right place pointing the wrong way, one frame after being
   aimed. It takes an optional quaternion now.
4. **The belt was completely intangible.** The pooled rock collision bodies
   were static, so by (1) they never moved off their parking spot and nothing
   ever collided with a rock. They are kinematic now. Verified: a corvette
   closing at 60 m/s stops dead at 11.8 m from a rock of radius 8.6.

## What is built

Four factions you can tell apart across a sector by hull colour alone — white
Apex, slate Vanguard, rust Scrapper, navy yours — drawn from geometry and
vertex colour, no textures, two draw calls each.

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
