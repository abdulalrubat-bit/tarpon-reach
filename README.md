# Tarpon Reach

A space empire strategy game for Android. Claim unclaimed star systems, build
industry, grow a fleet, and spread your colour across a sixty-system galaxy
while three factions run their own economies around you.

**Get the latest build:** open
[Releases → Latest debug build](../../releases/tag/latest-debug) on your phone
and download `TarponReach-debug.apk`. Each new build installs over the last
and keeps your save.

The speed button in the top bar sets game speed: 1×, 2×, 4×, 8× or 16×.
Battles drop it back to 1×. Ships cost credits only and are built in
seconds at any friendly shipyard.

The **Fleet** tab lists every ship by system with what it is doing. Tap one
to change its job (Escort, Guard, Mine, Hold, Repair), send it to guard
another system, or tick several to order them together or form a squadron.

Things happen without you: trade booms, mining rushes, pirate surges and
warlords with bounties, AI faction wars that move borders, distress calls,
derelicts and ancient caches. They show as badges on the star chart and in the
Empire tab's Galaxy Events card.

Music and sound effects are generated in code. Turn either off, or change
their volume, in Settings.

## How to play

The game teaches itself: the card at the top of the star chart always says
what to do next and has a button that does it. The loop is:

**earn** (your miner sells ore) → **go** (send the fleet to a grey,
unclaimed system) → **build** (a facility there) → **claim** (the system
pays you every minute) → **grow** (buy ships) → repeat, further out.

When pirates jump your ships, a red bar on the map takes you to the fight.
Select your ships, tap an enemy to focus fire, tap space to move, pause any
time, or retreat.

Faction systems can be taken by **siege**. Bring warships, knock out the
station's defence platforms, clear any guard ships, then hold the station
until its shield fails. A captured system keeps its station, gets two of your
own platforms and pays more than a frontier claim. Capturing a system starts a
war: that faction sends strike groups to take it back (each one your
defences destroy makes the next smaller), and a conquest
with nothing defending it falls in 90 seconds. Declare war or buy peace from
the Factions tab.

**Supply routes** (Industry tab → New route, or Freight route on a ship in
the Fleet tab) put a freighter on a set-and-forget loop: pick up one good from
your facilities in a system and deliver it to a friendly market (market
price), to your store at a shipyard (alloy there takes up to 30% off ships you
buy at that yard), or to your own facilities elsewhere (ore for a foundry with
no extractor). Anything left unrouted is sold to a broker at a low price. A
route that waits says why, and a stuck or lost one shows up under Needs
attention.

The **Empire** tab is the dashboard: systems held, income, fleet and capital
at a glance; every threat with a Defend button; an income-per-minute graph
(tap it for values); each system's earnings with a Go button; and your rank
and next goal.

## Layout

```
web/        the game: HTML, CSS and JavaScript (Phaser for the system view)
android/    the Android app: one WebView that runs web/ from the APK
docs/       history.md — the design record, from the first 3D build onward
.github/    the workflow that builds the APK on every push
```

The game is plain JavaScript with no build step. `web/index.html` runs in
any browser over http (`python3 -m http.server` in `web/`), which is the
quickest way to try a change before building an APK.

## Tests

`node tests/run.mjs` runs the gameplay regression tests in headless Chromium
(needs `npm install playwright` and `npx playwright install chromium`). The
APK workflow runs them before every build. `node tests/run.mjs mining` runs
only the files whose name contains "mining".

## Building the APK yourself

Needs JDK 17+ and the Android SDK with `platforms;android-35` and
`build-tools;35.0.0`.

```
cd android
echo "sdk.dir=$HOME/android-sdk" > local.properties   # once, or set ANDROID_HOME
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

`android/debug.keystore` is the standard Android debug key (password
`android`), committed so that every build — yours, CI's — is signed the
same way and installs over the last. It is not a secret and this is not a
release signing setup.

## Where it came from

Tarpon Reach started as a 3D flight sim in the
[abdulalrubat-bit.github.io](https://github.com/abdulalrubat-bit/abdulalrubat-bit.github.io)
site repo, became a map-first strategy game, and moved here when it became
Android-only. The full history of that is in `docs/history.md`, and this
repo's git history carries every commit from it.
