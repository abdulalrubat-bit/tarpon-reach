# Tarpon Reach

A space empire strategy game for Android. Claim unclaimed star systems, build
industry, grow a fleet, and spread your colour across a sixty-system galaxy
while three factions run their own economies around you.

**Get the latest build:** open
[Releases → Latest debug build](../../releases/tag/latest-debug) on your phone
and download `TarponReach-debug.apk`. Each new build installs over the last
and keeps your save.

## How to play

The game teaches itself: the card at the top of the star chart always says
what to do next and has a button that does it. The loop is:

**earn** (your miner sells ore) → **go** (send the fleet to a grey,
unclaimed system) → **build** (a facility there) → **claim** (the system
pays you every minute) → **grow** (buy ships) → repeat, further out.

When pirates jump your ships, a red bar on the map takes you to the fight.
Select your ships, tap an enemy to focus fire, tap space to move, pause any
time, or retreat.

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
