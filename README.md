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
src/galaxy.js       the galaxy map: Voronoi territory, lanes, census, courses
src/gear.js         modules, slots and the effective-stat recalculation
src/missions.js     contracts, generated from what is already true
src/dock.js         the station panel: selling, and the board
src/world.js        what the AI is allowed to ask, and who answers
src/persistence.js  localForage bridge and the snapshot
src/saveWorker.js   serialise and encrypt, off the main thread
src/game.js         the sector scene, which wires all of the above together
tools/stamp-sw.py   the service-worker stamper — run it after ANY change
vendor/             Phaser 3, enable3d (Three.js), Ammo WASM, localForage,
                    CryptoJS, d3-delaunay
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

Two things were dropped as dead weight, one of them since reinstated:

- **Ammo's asm.js fallback (2 MB).** `PhysicsLoader` reaches for it only when
  `WebAssembly` is missing, and nothing that can run Phaser 3 on WebGL2 is
  missing WebAssembly.
- **d3-delaunay** was dropped on the same argument and has since come back:
  the brief wants Voronoi faction borders on a galaxy map, there was no galaxy
  map, so the library was 19 KB of nothing. The screen is built now and the
  19 KB went in with it, exactly as the note here said it would.

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

## What the first real playtest changed

Every number before this came from a software rasteriser and a harness. The
first time it was played on a phone, four things came back, and three of them
were the same mistake in different clothes: treating a control as a direct wire
to the physics engine.

**The ship would not stop.** The throttle added force while held and nothing
when released, and linear damping is near zero, so it coasted for ever with no
control anywhere that could stop it. The throttle is a SPEED now: it asks, and
the drive works out whether to burn forward or retro. Zero means stopped.
Inertia is still real, because how fast a hull can change its mind is still
thrust over mass, and a freighter still takes an age.

**There was no way to correct a spin.** A stick has two axes and both were
spent on pitch and yaw, so there was no roll. A collision banked you, and since
zeroing angular velocity stops the SPIN but not the BANK, you flew sideways for
ever. Hands off the stick now rolls the ship upright on its own. The first
version of that had the sign inverted and flew the ship *past* inverted — the
test caught it: banked 73 degrees, ended at 176.

**There was no crosshair.** On a ship with fixed forward guns that means aiming
by guessing where the nose is, and because a chase camera trails and swings,
the nose is not the middle of the screen. There is now a pipper projected down
the gun line, a bracket on the target with its range, and a lead pip showing
where the target will be when the rounds arrive.

**AI ships fought each other and wedged themselves in the belt.** Aggression
reached 1,400 metres — most of the inhabited part of a sector — so on the first
tick after loading, every armed ship found somebody to hate. It reaches a fifth
as far now, and the factions want different things instead of all wanting the
same thing: pirates hunt cargo and leave warships alone, patrols hunt pirates,
corporate never starts anything, and haulers run rather than fight. What the
player arrives into is piracy, which they can intervene in, rather than a brawl
that has nothing to do with them.

The wedging needed a spatial grid over the belt, built once because a rock never
moves. Before it, "what is near this point" was a scan of all ten thousand
rocks — `updateBodies` did exactly that once a frame, and the AI could not
afford to ask at all, which is why ships flew into the belt and stayed there.
Now they steer around what is ahead of them, and anything that manages to get
stuck anyway gets a shove perpendicular to wherever it was trying to go.

## The bug that made combat not exist

Worth its own section, because it invalidated more than it looked like.

Projectiles used a POINT hit test: move the round, then ask whether the point it
landed on is inside a target's sphere. A pulse round covers sixteen metres per
simulation step at the clamped timestep. An interceptor's hit sphere is three
metres across. The round teleported straight past it, every time.

Measured on the shipped build — identical setup, same pool, same step size, the
only difference being the test itself:

| | hits out of 240 | |
|---|---|---|
| point test | **0** | 0.0% |
| swept segment | **224** | 93.3% |

Two hundred and forty rounds fired point blank down the nose at a stationary
target, and not one of them connected.

The same arithmetic explains the other half of the same bug report — *"the AI
destroys the station"*. A station's hit sphere is forty-one metres, bigger than
the step, so rounds landed on stations perfectly well. Small things were
invulnerable and large things were not, so a routine pirate skirmish ground the
trade hub down while nothing anybody fired could kill a ship.

Two more things fed the same fire. Rounds bit anything that was not the
shooter's OWN faction, so every neutral was a backstop: flying at a pirate with
the station behind it emptied the burst into the station. And a station that
died was REMOVED from the registry, taking that sector's economy with it,
permanently, into the save file.

Rounds are now tested as a swept segment, they only bite what the shooter is at
war with, a station's hull is not exposed by shooting at it — the design has
always been that stations fall to a siege, and sieges are not built — and a
structure is never reaped.

## The game was running at 17% of real time

The report was *"the ship doesn't maintain control, it doesn't stop or turn, it
just drifts"*, on a build that already had the flight-model fix in it. So the
first job was to work out what was left.

Touch was ruled out: a real multi-touch dispatch registered yaw 0.96, throttle
0.89 and firing simultaneously and independently. The save/restore path was
ruled out: a reloaded ship stops fine. Then it reproduced — full stick held for
six seconds turned the ship **16 degrees**.

Instrumenting the body showed the angular velocity was *correct and steady* at
-2.227 rad/s. The ship was being told to turn at the right rate and was barely
moving. Which pointed at time, not at flight:

```
sim seconds per wall second : 0.174
```

The game was running at a sixth of real time. Everything worked. Everything was
in slow motion, so nothing felt like it worked — a turn that should take 1.4
seconds took 8, and a stop that should take 3 took 17. On a frame-rate graph
that is a performance problem; from the cockpit it is a broken ship.

Three separate ceilings, compounding:

- `dt = Math.min(0.05, …)` in the update loop — a hard 20 fps ceiling on
  simulated time. Every frame slower than 50ms silently threw the rest away.
- Ammo's `maxSubSteps: 4` at a 1/60 fixed step — physics could advance at most
  66ms per frame no matter what it was handed.
- And the one that made this hard to find: **Phaser smooths its own delta.**
  `TimeStep` averages recent frames and clamps the result at
  `deltaSmoothingMax`, which is 50ms by default. Raising my own cap changed the
  measurement not at all — 0.174 to 0.178 — because the number being capped had
  already been capped upstream.

So the frame time is now measured from `performance.now()` directly rather than
taken from Phaser, the dt cap is 0.2, and `maxSubSteps` is 12. And because the
honest fix for a device that cannot hold 20 fps is to draw less rather than to
slow time down, there is now an adaptive quality step: a smoothed frame pace
drops the belt draw cap to 2200 and then 1200 rocks and switches bloom off below
~17 fps, and climbs back when the pace recovers. It announces itself on the HUD
so it is never a silent downgrade.

| | before | after |
|---|---|---|
| sim seconds per wall second | 0.174 | **0.994** |
| full stick held, degrees turned | 16° in 6s | **246° in 4s** |
| frames per second (software rasteriser) | ~9 | **21** |

The turn and stop figures are from real dispatched touch events on the built
page, not from calling the flight code directly.

## The stick was a step function

*"The movement still needs work, it's really sensitive."* Third report on the
same control, and the first two fixes were both real — the throttle became a
speed, and the game stopped running at a sixth of real time — so what was left
was the stick itself.

It was a rate command wired straight to the solver. `setAngularVelocity` was
handed the stick value every frame, which is infinite angular acceleration in
both directions: the nose snapped to its full rate the frame a thumb landed and
stopped dead the frame it lifted. Every input was a step function, and there is
no peak rate at which a step function feels good.

Linear travel made it worse. A linear stick spends the same degrees per pixel
everywhere, so the half of the travel nearest the centre — the half doing all
the aiming — was exactly as touchy as the half doing the hard turns. A thumb on
glass has maybe two millimetres of real precision.

Three changes. The stick curve is now 62% cubic, applied to the magnitude of
the deflection rather than per-axis — per-axis expo makes a diagonal push weaker
than a straight one by a different amount at every angle, which is unlearnable.
The command is spooled rather than applied instantly, and asymmetrically: 0.26 s
to build, 0.13 s to bleed, because a ship that keeps turning after the thumb is
off overshoots what you were lining up, and overshoot is what reads as "it won't
stop". And the peak coefficient went from 0.40 to 0.26.

Measured on the built page with real dispatched touch, reading the rigid body's
own angular velocity:

| stick | before | after |
|---|---|---|
| quarter | 18.2 °/s | **4.6 °/s** |
| half | 55.5 °/s | **17.6 °/s** |
| three-quarter | 95.3 °/s | **43.4 °/s** |
| full | 128.4 °/s | **83.1 °/s** |
| thumb down to full rate | 88 ms | **316 ms** |
| thumb up to stopped | 59 ms | **193 ms** |

Half stick used to ask for 55 degrees a second. It now asks for 17. Full stick
still out-turns every AI hull in the game.

There is also a **STICK** stepper in the orders panel, 0.40 to 1.60, remembered
in `localStorage`. Thumb size and how a person holds a phone vary more than any
single tuning value can cover, and it lives in the HUD rather than behind a
settings screen because the moment you want to change it is during the fight
that made you want to change it.

**A note on how this was measured, because the first attempt lied.** The obvious
test is to hold the stick and watch the heading. That test reported the new
build turning at 20.6 °/s at full deflection — a third of what the code asks
for — and reported the same 21 degrees of post-release coast before and after a
change that should have altered it. Heading is downstream of bank, flight
assist, and every rock the ship clips on the way round; it measures the outcome,
not the tuning. The numbers above come from reading `body.angularVelocity`
directly, which is the quantity the flight model actually sets.

## The radar has a third axis now

*"The map needs a depth to it."*

The dial mapped world X and Z to a circle and threw Y away, on the argument —
written into the file, in as many words — that "which way do I turn" is a 2D
question. That argument is wrong in a game where ships arrive from above. A
contact 200 m ahead and a contact 200 m overhead landed on the same pixel, and
the only thing telling them apart was a seven-pixel tick that nobody reads
mid-fight.

The dial is now a **plane seen at an angle**: an ellipse, squashed to 54%. The
squash is the whole trick — it frees the vertical screen axis, so altitude can
be drawn as a stalk standing off the deck instead of competing with
forward-and-back for the same pixels. Every contact is drawn twice: a foot on
the plane, which is where it is, and a mark at the top of a stalk, which is how
far above or below you it is. Neither works alone. A mark by itself is ambiguous
about range; a foot by itself is the old flat radar.

Altitude runs through `tanh` rather than a linear scale, for the same reason the
stick does. Linear spends most of the stalk on contacts far enough above you to
be irrelevant and crushes the near-level ones — the ones you are fighting —
together at the deck.

Details that turned out to matter more than they sound:

- **The range test stays circular.** Testing the squashed ellipse would make a
  contact dead ahead drop off the dial at 54% of the range of one directly
  beside it — a radar whose range depends on the bearing.
- **The tap test hits the mark, not the foot.** Tapping what you can see is the
  whole contract. Verified by round trip: ask the radar where it drew each
  contact, tap exactly there, check the right ship comes back. 8 of 8, across
  +340 m to −310 m, counting a wingman as *selected for orders* and a hostile as
  *targeted*, which is the distinction the first version of that test got wrong.
- **Four posts stand off the rim at the cardinals.** They carry no information
  whatsoever. A flat ellipse reads as an oval until something sticks up out of
  it, and then it reads as a plane. Cheapest depth cue there is.
- **The feet started at 0.34 alpha** on the theory that a shadow should be
  faint, and vanished against the plate. A stalk with no visible base is a
  floating line.
- **The altitude readout sits in a fixed spot under the rim**, not beside the
  mark. Pinned to the mark it moved with the target, collided with every wingman
  label it passed, and had to be found again every glance.

## Six defence emplacements, and the difference between a wall and a fight

Two perimeter platforms per faction, from reference art, built as geometry in
each faction's own palette like everything else here.

| | platform | gun | the problem it sets |
|---|---|---|---|
| **Apex** | Pylon Battery | twin energy pods | heavy hits at 900 m, behind a big shield |
| | Aegis Pillar | ring accelerator | one shot at 1150 m, and it goes through shields |
| **Scrapper** | Grinder Mount | six-barrel rotary | 15 rounds a second inside 440 m, nothing outside it |
| | Slughammer | one enormous tube | 46 a hit, one shot every two seconds |
| **Vanguard** | Picket R-07 | twin rails | 620 m/s, almost no spread, 1100 m |
| | Redoubt Turret | triple autocannon | sustained fire and the most armour of the six |

Every one of them out-ranges and out-damages a ship's weapon, deliberately. A
platform has no engine, no manoeuvre and no way to withdraw; the only thing it
has is that entering its envelope is a bad idea. A turret a corvette can safely
trade with is scenery.

Each faction's pair is meant to be a different *problem* rather than a different
number. Apex holds you off. Scrapper is nearly harmless past 500 metres and
appalling inside it. Vanguard hits exactly what it aims at from anywhere and is
the only pair with no weakness to exploit.

### `emplacement` is not `structure`, and that is the whole point

A structure is indestructible and never reaped. That is right for a station —
the design has always been that stations fall to a siege, not to a corvette with
a grudge, and a station that died took its sector's economy into the save file
with it.

An emplacement is the opposite. It is *meant* to be shot off, because a
perimeter you cannot breach is a wall, and a wall is not a fight. So the tier
is new, and the nine places that asked "is this a structure" were sorted into
the ones that meant "can it move" (now `SE.isStatic`, true for both) and the
ones that meant "can it die" (still structure-only).

### The head turns

The brief's complaint about the dreadnought — *"capital-ship turrets do not
track independently; the turret meshes are decoration"* — was about to be true
of six more things. So the bake was split in two. It used to fold every
authored part into one geometry, which is what keeps a ship at two draw calls;
now it can be run twice, once for the base and once for the head, and the head
is a child object that yaws and elevates.

Order matters and is not free to choose: yaw first about the platform's own
axis, then elevate about the yawed one, which is how a real trunnion moves and
the only order that keeps the gun upright. Any other order rolls the barrels as
they traverse. Traverse is rate-limited — 1.7 rad/s, 1.1 for the heavy mounts —
and a platform will not fire until the head is within about six degrees of its
target. That gate is what makes traverse rate a real stat rather than a
decoration: a fast mover crossing a heavy mount's arc genuinely outruns its
guns.

### Two bugs this turned up

**Every new gun would have fired straight ahead.** Whether a weapon is laid on
its target or fired down the hull's nose was decided by
`cls.weapon === 'turret'` — a test that quietly meant "any gun I have not
written yet is a fixed gun". Six new tracking weapons bolted to a head that
visibly swivels would all have shot past their targets. Tracking is now a
property in the weapon table.

**Rounds would have left from inside the footing.** Shots originate at the
ship's position, which for a platform is down at the base, not up at the
barrels. A platform firing over its own shoulder would have put the first round
through its own plinth — and the swept-collision test would have happily scored
that as a hit on whatever was behind it. Classes now carry a muzzle height,
applied along the platform's own up-axis.

### Palettes: one per faction, glow per platform

The references have Apex's two platforms in violet and in blue and Scrapper's in
steel and in orange. Both were built on a single palette per faction anyway,
with only the glow varying, because two palettes inside one faction stops
reading as a faction — you get six unrelated objects instead of three pairs.
What the reference art is really distinguishing is the *glow*, and a violet
energy pod and a blue accelerator ring on the same dark violet housing still
read as one organisation fielding two weapons.

Apex's platforms are the clearest case for giving them their own palette at all:
its ships are white because white reads as expensive, and a white gun
emplacement reads as a fridge.

### Somewhere to actually meet one

Home is Apex-owned, Apex is not hostile to the player, and the player still has
no jump drive — so every platform in the game would have been something you
watch shoot somebody else. There is now a two-platform Scrapper blockade out
past the belt at about 1170 metres, facing back down the approach to the
station. It is also the seed of the blockade mechanic proper: a Scrapper
position sitting across a trade lane is what a siege becomes once stations can
be starved.

### Measured

| | |
|---|---|
| Head laid on a target from cold | 1.28 s, to 125° of traverse |
| Scrapper corvette parked 260 m off one Pylon | shield 180 → 0, hull 220 → 121 in 9 s |
| Aegis under fire | 1600 hp, destroyed, removed from registry, view detached |
| Station under the same fire | 6000 → 6000, still untouchable |
| Emplacements in the galaxy | 21, all six classes, 6 of them in Tarpon Reach |
| Save and reload | all 21 restored with their facing intact |

Triangles, against things already in the game:

| | triangles |
|---|---|
| Aegis Pillar | 2,900 |
| Grinder Mount | 2,620 |
| Pylon Battery | 1,736 |
| Slughammer | 1,638 |
| Redoubt Turret | 1,530 |
| Picket R-07 | 1,192 |
| *(corvette, for scale)* | *1,672* |
| *(Apex station, for scale)* | *5,588* |

All six together are 11,616 triangles — about 18% of the belt, or two stations.
The cost that is not free is draw calls: a platform is two meshes rather than
one, because the head has to be able to turn.

A/B in one session, quality pinned so the adaptive ladder cannot move under the
measurement, with all six of Tarpon Reach's platforms in frame and then hidden:
**12.3 fps against 13.3**, about 7.5%. That is the software rasteriser's
number, and it over-weights draw calls and small meshes more than any real GPU
does, so treat it as the pessimistic end.

## The galaxy map, and finally leaving Tarpon Reach

These are one feature. A map you cannot travel on is a picture, and a jump
drive with nothing to point it at is a menu.

### The map is a document, so it is DOM

The radar lives on the Phaser canvas because it is part of the glass you are
flying behind: it redraws sixty times a second and it has to be in the same
frame as the ship it describes. This is the opposite kind of thing. It is a
screen you *stop* to read, it redraws when something changes and not otherwise,
it wants real text at real sizes, and it wants to cover the game rather than
float over it. That is a document. Documents are cheaper and sharper in DOM,
so the map is its own 2D canvas in an overlay and owes the render loop nothing.

Opening it does not pause the sector. The galaxy keeps running underneath,
which is correct for a map you can pull up mid-fight and is the reason it
redraws on demand rather than holding a frozen copy.

### Voronoi is the right answer, not just the available one

This is the one place the brief's **d3-delaunay** earns its 19 KB. It was
deliberately left out of the first build with a note saying it would arrive
with this screen, because a geometry library with no geometry to do is 19 KB of
nothing.

Faction borders drawn as circles around each station say *this faction owns a
radius*. Drawn as a tessellation they say *space belongs to whoever is nearest,
and the border is wherever two claims meet* — which is how a frontier between
two powers with no natural boundary actually works, and it puts the contested
edge exactly where a player would guess it is. Apex's blue meets Scrapper's
orange on a line halfway between Tarpon Reach and The Sill, and that line is
where the fighting would be.

The tessellation is computed over a box four times the screen and then drawn
clipped. Computed at the screen edge instead, the outer cells get cut square
against the viewport and the territory looks like it stops at the bezel rather
than carrying on past it.

Every sector carries one line of what is actually there — how many of your
hulls, how many hostiles, how many hostile guns, whether there is a belt. That
line is the only reason to open a map you have already memorised.

### The jump drive was a door, not a travel system

Everything underneath it already existed. The galaxy graph, A* across it, the
lane exits and the sector transfer have been running since the first build —
out-of-sector freighters use them dozens of times an hour. `enterSector` was
already parameterised, already tore down every physics body and rebuilt the
belt from the destination's own seed. The only thing missing was that the one
ship with a person aboard could not leave.

Four decisions were not free:

- **A course stores the far end, not the next leg.** The next hop is re-derived
  from wherever the ship actually is, every frame. So a course survives being
  blown off route, and arriving somewhere unplanned re-plans instead of
  breaking.
- **There is a gate to fly at.** A course with no marker is one you navigate by
  reading a distance off the HUD and guessing, which is not flying. A ring
  appears at the lane mouth while a course is set and nowhere otherwise — a
  permanent gate in every sector is scenery you learn to stop seeing. It also
  gets a diamond on the radar, clamped to the rim when it is out of range,
  because the exit sits at 92% of sector radius and the dial only reaches
  1500 m.
- **The whole fleet goes.** Leaving your own wingmen behind in a sector you
  have left is technically the simulation working correctly, and is a bug
  report every single time. They arrive fanned out around the mouth rather than
  stacked on one cubic metre, because the alternative is that the first thing
  you see on arrival is your own ships shoving each other apart.
- **Interdiction is the charge timer.** The drive spools for four seconds and
  only while nothing is hurting you. A pirate sitting on a lane mouth cannot
  stop you flying, but it can stop you *leaving* — which is the pressure the
  brief wants from interdiction, with no separate system rolling dice to
  produce it. Hull plus shield is the test, so a shield quietly regenerating is
  not mistaken for being shot at.

### The bug that would have shipped

The map looked perfect and **SET COURSE could not be pressed** — on a phone or
in a test. The canvas sized itself from the overlay's bounding box rather than
from its own flex slot, so it was laid out as tall as the whole screen, spilled
over the footer, and an absolutely positioned canvas on top of a button eats
that button's taps. The canvas measures its own wrapper now.

Worth writing down because nothing about it was visible: the picture was
correct, the button was correct, the button was even reported as *"visible,
enabled and stable"*. The only symptom was that clicking did nothing.

### Measured

| | |
|---|---|
| Course Tarpon Reach → Pilot's Rest | 2 legs, 4.2 s and 4.1 s, fleet of 3 arriving intact both times |
| On arrival | course cleared, gate gone, readout gone, autosaved |
| Interdiction | spooled to 1.73 s, one hit, back to 0 |
| Save and restore mid-course | sector and all three owned hulls restored where they were |
| Every sector entered in turn | all 7 build clean — belts in home, Sill, Ossuary, Harrow, and only there |
| Page errors across the whole run | none |
| d3-delaunay | 19 KB, shipped size now 3.80 MB over 27 files |

## Contracts, and the fact that nobody could sell anything

### The hole nobody had noticed

Until this build the player could not sell a single unit of anything. Mining
worked, the hold filled, prices moved against stock, and NPC freighters traded
all day long — and the one ship with a person aboard had no way to open its
cargo doors. You could fly to a station and look at it. `trade()` existed and
only the AI's TRADE order ever called it.

That is also why haulage contracts could not exist: there was nothing to
deliver *to*. So docking came first, and contracts came with it.

Docking is 150 metres clear of the station's hull and a button that appears on
its own. A docking ring you have to hit exactly is a precision task at the end
of a journey, which is the least interesting place to put one.

### A contract has to describe something already true

The rule the whole generator is built on: not "kill four pirates somewhere" but
"kill four pirates in The Sill, where there are in fact four pirates right
now". Not "deliver ore" but "deliver ore to Gate Watch, which is in fact short
of it".

This costs nothing. The numbers it needs — who is where, what each station is
holding — are already simulated every tick for the out-of-sector economy. The
board just reads them. And it means the board *cannot* offer something nobody
could complete, which is the failure mode of generating the other way round:
roll a type, invent a target to fit it, and sooner or later you send the player
to clear pirates out of an empty sector.

Four kinds of work:

| | what it is | where it comes from |
|---|---|---|
| **Bounty** | destroy N hostile hulls in a named sector | sectors that have them, never more than two-thirds of the count |
| **Sweep** | destroy N hostile emplacements | the blockades that actually exist |
| **Haulage** | carry goods to a named station and dock | that station's real shortage |
| **Escort** | see a freighter to another sector | a real freighter, spawned, flying the route on ordinary JUMP orders |

Bounties never ask for more than two-thirds of a sector's hostiles, because a
contract needing every single one fails the moment one wanders off down a lane,
which they do constantly. The escort is the only contract that creates
something, and what it creates is a real hull with a real faction and the same
orders any NPC uses — an escort mission whose subject is a marker that
teleports on success is a timer with a story attached.

### The board was four haulage runs

First board this generated: four haulage contracts and nothing else.

Drawing from one weighted pool looks correct and is not. There is one bounty
candidate per sector that has hostiles and one sweep candidate per sector that
has guns — but there is a haulage candidate for *every good at every station*,
so haulage outnumbered everything else about four to one before any weighting
happened. The galaxy was asked "what is most worth saying" and answered
"cargo", four times, because cargo had four times as many mouths.

The fix is to pick a TYPE first, weighted by its strongest candidate, then pick
within it. A sector with six pirates still shouts louder than a station mildly
short of ore; taking a type halves its weight rather than removing it, so two
bounties on one board are possible when the galaxy really is that violent and
unlikely otherwise.

### Measured

| | |
|---|---|
| Selling | 20 ore → 280 cr, hold emptied, station stock rose |
| Bounty | 2 kills, progress ticked 1/2, paid 680 cr, cleared |
| Sweep | 2 emplacements, paid 1440 cr, cleared |
| Haulage | pays on docking at the addressed station, deducts the cargo |
| Escort | real freighter spawned with a real JUMP order to the contracted sector |
| Contracts across a reload | survive; boards do not |

Boards are deliberately not saved. A board is an offer, and an offer that
survives a reload is a save-scum: quit, reload, get a different four. They are
regenerated from the galaxy's own state on the next dock, which is where they
came from in the first place.

## Phase 0: four ways the save was lying

Written against the build plan's Phase 0, and three of its five items turned
out to be live bugs rather than hardening.

**Asteroid depletion was global.** One flat array, taken from whichever belt
happened to be loaded and restored onto whichever belt happened to be loaded
next. Harmless while the player could not leave Tarpon Reach; silent corruption
the moment they could. Mine a seam at home, jump to The Sill, save — and The
Sill's rocks come back wearing Tarpon Reach's holes. Depletion is a table keyed
by sector now, folded in when you jump out of a sector and applied when you
arrive.

**Nothing saved when the app was backgrounded.** Backgrounding is the normal
way to stop playing on a phone and it does not announce itself — there is no
quit button to hang a save off, so up to a full autosave interval of play was
simply lost, and the player's evidence for that was a mined seam that came
back. `visibilitychange` and `pagehide` now flush.

**The save worker had a fallback that did not exist.** `onerror` rejected every
in-flight request with a comment saying the caller would fall back, and no
caller did, because there was nothing to fall back *to*. Those rejections
became "SAVE FAILED" and the game quietly stopped saving. There is now a
main-thread pack/unpack behind the same key, used once and then permanently
once the worker is known dead. It costs a few dropped frames, which is a worse
outcome than a dropped frame only until you compare it with losing the save.

**`autosave()` swallowed its own promise**, so `await autosave()` resolved
before anything was written. Harmless in the game; it made a test reload
mid-write and report that contracts were not being saved when they were.

And one the plan named that had grown since: **the shell list was
hand-written**. `src/` was enumerated by hand while `vendor/` was walked, on the
argument that vendor was the part most likely to gain a file and least likely
to be remembered. The argument turned out to apply just as well to `src/`:
`galaxy.js`, `missions.js` and `dock.js` were all in `index.html` and none of
them were in the offline shell, so an installed player would have had a game
that ran online and died offline — the one failure that script exists to
prevent. Both directories are walked now, and the stamper refuses to run if
`index.html` loads a script the shell does not carry.

| | |
|---|---|
| Belt depletion | home dug 207 → 104, Sill untouched, home restored on return |
| Backgrounding | autosave fires on `visibilitychange` |
| Worker blocked | packed on the main thread and read back correctly |
| Offline shell | 30 files, and every `<script src>` in `index.html` verified present |

## Equipment, and the first thing credits have ever been for

Money accumulated and did nothing. You could earn it by mining, by selling,
and — since the contract board — by working, and then it sat in the corner of
the HUD being a number. A game where the reward for doing the thing is a bigger
number that buys nothing has no second act.

Twelve modules across four slot categories, all of them from the build plan's
own tables, with the plan's own stated drawbacks.

### Three rules, each one a trap avoided

**A module is a trade-off, never a straight upgrade.** If a part is better in
every respect there is no decision, only an errand: earn the money, fit the
part, never think about it again.

This one is enforced by a test rather than by good intentions. It walks the
table, previews fitting each module, and fails any that produces no worse
number. **Two did on the first pass** — the Fire-Control Computer and the
Navigation Computer. Both are justified in the plan by an *opportunity* cost:
"no defensive benefit", "no direct combat benefit". That reasoning holds only
while every slot is already full. With a spare slot they were free, and a free
module is not a decision. Both carry mass now, which is what added hardware
does.

**Ships store only the ids.** Final statistics are recomputed from the hull and
the fitted list every time. Nothing writes a derived number into the save, so
rebalancing a module later changes every ship already carrying it instead of
only the ones fitted after the patch — and an old save cannot smuggle in a stat
the table no longer agrees with.

**Flat first, then multipliers**: `(base + flat) × mult`. Stated once, applied
everywhere, because the alternative is two modules that each say "+20%" and a
player who cannot predict what fitting both will do. Verified by hand:
thrusters and cargo pods on a corvette give `(300 + 90) × 0.90 = 351`, and the
game agrees to four decimal places.

### What it touches

Effective stats are cached against a revision counter that fitting bumps. This
runs inside the flight model and the AI, sixty times a second per ship, and
recomputing a dozen multiplications for every hull every frame would be a real
cost for an answer that changes when somebody presses a button. NPCs carry no
fit at all and take a fast path straight to the class table — refitting their
ships is a later phase, and pretending otherwise would charge thirty hulls a
frame for the answer "nothing is fitted".

Weapons go through the fit too: a Rangefinder Array turns the corvette's pulse
from 620 m at 6.5 rounds a second into 837 m at 5.2.

Two things needed more care than they looked:

- **Ammo takes mass at body construction and will not be told otherwise**, so a
  refit that changes mass rebuilds the rigid body. Free, because refitting only
  happens docked, at rest, with nothing shooting.
- **Fitting armour raises the hull ceiling; fitting a hold lowers the cargo
  ceiling.** Both have to be re-clamped on every change, or a refit leaves a
  ship reporting 180/160 hull, or carrying more than it can hold.

Buying and fitting are one action, because they are one decision. A module
bought and left in a locker is a second inventory screen to build and a second
place to lose track of what you own. There is no locker; removing a module
sells it back at half.

### Measured

| | |
|---|---|
| Every module has at least one worse number | 12 of 12 |
| `(base + flat) × mult` | 351 predicted, 351 measured |
| Buying at a station | 900 cr moved, module fitted, rigid body rebuilt, mass 14 → 17 |
| Weapon through the fit | pulse 620 m / 6.5 rps → 837 m / 5.2 rps |
| Fit across a reload | ids and the ceilings they imply both restored |

## Five bugs worth writing down

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
4. **Hostility was one-directional, and the player declares no wars.** The
   faction table is written from each side's point of view: the Scrapper
   Syndicate lists the player as an enemy, and the player's own entry lists
   nobody, because the player does not declare wars — they get attacked. Read
   one way round, `hostile(player, scrapper)` was FALSE. A wrong colour on a
   targeting bracket is what gave it away; the real cost was that the player's
   wingmen searched for enemies with a predicate that matched nothing, so an
   escort would fly calmly alongside a pirate until the pirate opened fire. If
   either side considers it a fight, it is a fight.
5. **The belt was completely intangible.** The pooled rock collision bodies
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

- **No second hull.** Modules exist, so credits have a use — but there is no
  shipyard, no subclass, and no way to own anything the game did not hand you
  at the start.
- **No sieges or blockades**, in the mechanical sense. The defence emplacements
  are built and one Scrapper blockade is standing across the approach to Tarpon
  Reach, but nothing yet starves a station of Energy Cells to drop its shield
  regeneration to zero, which is what would let a blockade actually decide
  anything.
- **No hangar docking.** The three-phase lerp-in sequence is not written.
- **No reputation.** Contracts pay credits and nothing else: helping Vanguard
  clear a blockade does not make Vanguard like you, and there is no standing to
  unlock anything with. That is the next thing, and it is what turns a board
  into politics.
- **No interdiction roll against NPCs.** The player's own drive can be
  disrupted by being shot while it spools, which is interdiction where it
  matters; pirates still do not roll against out-of-sector haulers crossing
  lanes.
- **Capital-ship turrets do not track independently.** A dreadnought fires at
  its target from the hull; the turret meshes are decoration. The emplacements
  now have the mechanism — a separately baked head, yaw-then-elevate, rate
  limited — so this is a matter of giving the dreadnought four of them rather
  than of inventing anything.
- **Adaptive quality has three steps and nothing finer.** Below ~17 fps it
  drops the belt to 1200 rocks and kills bloom; that is the whole ladder. It
  does not touch shadow resolution, texture size or the render scale, so a
  device that still cannot hold frame rate at LOW has nothing further to give.
- **Balance is arithmetic, not playtesting** — and until the swept-collision
  fix above, it was arithmetic about damage that was never being delivered. Every
  time-to-kill figure previously reasoned from the weapon table described shots
  that passed straight through their targets. The numbers are connected to the
  game now; they have still never been tuned against a person playing.

## Adding it to the studio page

Not done. `spaceempire/` is playable at `/spaceempire/` as soon as this merges,
but nothing links to it from the site's front page — putting an unreleased
prototype on a public storefront is a decision, not a chore, and it is yours.
