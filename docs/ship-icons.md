# Map ship icons

Ship hulls now use steel armour with faction markings, instead of a fully coloured body and broad engine bloom. The interceptor has swept wings, the corvette has twin nacelles, the extractor has a forked mining bow, the freighter carries separate cargo pods, and the dreadnought has a long armoured spine. Operations uses dark edges against cream; Tactical uses light edges against the night plot. Fleet cards share these drawings.

Map size grows gently with zoom and is capped independently of device pixel ratio. Touch picking retains its existing 26 CSS pixel radius. Selection rings, hostile diamonds, labels and health bars follow the new artwork size. Engine wakes only appear on moving ships. Ships at identical world positions can still overlap; their positions and navigation are unchanged.

| Class | Overview minimum | Default view | Close-up maximum |
| --- | ---: | ---: | ---: |
| Interceptor | 22 px | 27 px | 34 px |
| Corvette | 27 px | 33 px | 42 px |
| Extractor | 28 px | 34 px | 42 px |
| Freighter | 30 px | 37 px | 46 px |
| Dreadnought | 40 px | 49 px | 62 px |

Sizes are the square sprite canvas; visible hulls occupy roughly 86% of its height.

## Art and renderer

`web/src/shipart.js` owns normalized hull specifications, map size limits and cached drawings. The existing `canvas(cls, faction)`, `icon(cls, faction)` and `shadeInt` interfaces remain available. `canvas` and `icon` accept optional mode (`ops` or `tactical`) and detail (`small` or `full`). Defaults suit existing dark fleet panels. Invalid class/faction inputs are normalized before caching. Unknown classes use a corvette, and unknown factions use Apex.

The system renderer creates textures on demand and reuses sprites when class, faction or detail changes. With the current five classes and four factions, the finite upper bound is 80 hull textures across both modes and detail levels. There are no downloaded image assets or new game dependencies. Geometry and caches are presentation-only; saves and simulation are unchanged.

## Review and validation

Serve `web/` locally and open `/dev/ship-icons.html` for the interactive workshop. It compares all classes and factions in both modes at actual CSS map sizes, with a zoom slider and larger fleet-card samples.

- All 36 browser regression cases passed, including two new ship-art cases.
- Checked distinct art, theme variants, fallback/cache reuse, capped zoom sizes, selection outside the visible hull, idle glow, class/faction refresh, theme changes and reopening the map.
- Visually reviewed Operations and Tactical at a 412 × 915 viewport, device scale factor 2, and the side-by-side workshop.
- JavaScript syntax and whitespace checks passed.

Validation used headless Chromium 153 with software graphics in this environment. Physical Android performance and APK packaging have not been tested. This change is based on `claude/system-screen` at `abdb77a` and should be reviewed alongside that screen redesign.
