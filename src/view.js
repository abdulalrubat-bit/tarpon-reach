/* ShipPhysicsView — the other half of the split.
 *
 * A view is a Three.js group and an Ammo rigid body bolted onto a ShipState
 * for exactly as long as that state is in the sector the player is flying in.
 * It exists to be deleted. Attach on entry, sync both ways every frame, detach
 * on exit and the state carries on as arithmetic with no idea anything
 * happened.
 *
 * The sync direction matters and is not symmetric. While a view exists the
 * rigid body is the authority on where the ship is: physics writes into the
 * state each frame. The state is the authority on everything physics does not
 * model — hull, shields, hold, orders — and on the transform only at the two
 * moments of attach and detach.
 *
 * Geometry and materials are built once per hull class and shared by every
 * ship of that class. Forty interceptors are forty transforms over one set of
 * buffers; building forty copies is how a phone runs out of memory politely.
 */
(function (SE) {
  'use strict';

  let THREE = null;
  const geoCache = Object.create(null);
  const matCache = Object.create(null);

  /* ---- The palettes ---------------------------------------------------
     Sampled off the concept art rather than guessed, which is why these are
     odd numbers instead of round ones.

     These are ALBEDO, not the colours you see. The art is already lit, so
     authoring a material at the reference's apparent colour and then lighting
     it again darkens it twice — the first pass of this palette put a slate
     military hull and a navy one at the same near-black. Each value here is
     the reference tone opened up by roughly the amount the scene's lighting
     takes back out, checked by sampling the rendered pixels rather than by eye.

     The earlier build put every ship in the same navy and let the trim carry
     the faction. The art says otherwise, in eight ships and without ambiguity:
     the corporate shuttle is white with deep navy panels, the junkyard rig is
     rust with amber hazard banding, the military hull is slate with the same
     banding in yellow. The faction IS the hull. So the trim has stopped being
     the only identification and become the smallest part of it, which is the
     right way round — a fleet you can name at a glance from its colour beats a
     fleet you can only name from a stripe.

     Each palette carries the same seven roles so that a hull built once reads
     correctly in any of them:

       hull / hullLit / hullDark   the three tones every panel picks from
       panel                       inset blocks, intakes, the darker structure
       band                        hazard striping and banding, the loud one
       glow / glowHot              the drive, rim into core
  */
  const FACPAL = {
    // Dark navy, magenta drives, gold banding — the ship in the first piece of
    // concept art, and the palette the player flies.
    player: {
      hull: 0x323f7e, hullLit: 0x4b56a0, hullDark: 0x1a1f42,
      panel: 0x4560c4, band: 0xe0b06a,
      glow: 0xf47ac8, glowHot: 0xffd8f2, rimLit: 0x8f8cb8
    },
    // Corporate. White with deep navy blocks and a cold blue drive: the only
    // faction whose ships are LIGHT, which is most of why they read as
    // expensive next to everybody else's.
    apex: {
      hull: 0xfafcff, hullLit: 0xffffff, hullDark: 0xc2cad8,
      panel: 0x1276d8, band: 0x3f9ff0,
      glow: 0x7fe6ff, glowHot: 0xe8fbff, rimLit: 0xdfe5ee
    },
    // Junkyard. Rust over dark iron, amber hazard banding, and a drive the
    // colour of something burning that should not be.
    scrapper: {
      hull: 0xf5834a, hullLit: 0xffa070, hullDark: 0x6e4e3c,
      panel: 0x4a474c, band: 0xffc84a,
      glow: 0xffb54a, glowHot: 0xffe9c2, rimLit: 0xbb8464
    },
    // What is left of a navy. Slate grey, yellow hazard striping, blue drives:
    // nothing decorative, everything stencilled.
    vanguard: {
      hull: 0x848b99, hullLit: 0x9aa1af, hullDark: 0x424650,
      panel: 0x35373d, band: 0xf2ce34,
      glow: 0x4ea8ff, glowHot: 0xd8efff, rimLit: 0xa8aeba
    }
  };

  /* A faction's ships and its architecture do not have to be the same colour,
     and in the reference art they are not: Vanguard's fighters are slate with
     yellow stencilling, and Vanguard's fortress is navy with gold. That is how
     real navies work too — the grey is for the hull that has to disappear, the
     colours are for the building that wants to be seen. Stations may override
     their faction's palette; anything not listed here just uses it. */
  const STATIONPAL = {
    // Navy and gold: a fortress that wants to be seen from a long way off.
    vanguard: {
      hull: 0x39496f, hullLit: 0x4c5f8c, hullDark: 0x1d2540,
      panel: 0x28304e, band: 0xe8b93a,
      glow: 0x7fd0ff, glowHot: 0xe6f6ff, rimLit: 0x6d7ea6
    },
    // Dark indigo carrying neon. Apex's SHIPS are white because a hull that
    // looks expensive is the product; Apex's hub is dark because everything
    // bright on it is signage, and signage does not read against white.
    apex: {
      hull: 0x2e2b52, hullLit: 0x423d74, hullDark: 0x171531,
      panel: 0x5a3492, band: 0xc77ef0,
      glow: 0x4fd6ff, glowHot: 0xdffaff, rimLit: 0x6f689e
    },
    // Rust, patched with whatever was to hand, lit green from inside.
    scrapper: {
      hull: 0x96613f, hullLit: 0xc08356, hullDark: 0x402e24,
      panel: 0x4d4b47, band: 0xe0a020,
      glow: 0x74ec80, glowHot: 0xe0ffe2, rimLit: 0x8a7059
    }
  };

  FACPAL.independent = FACPAL.vanguard;

  const EDGE = 0xe4dced;     // painted flashes and nose stripes, every faction

  function mat(colour, emissive, emissiveIntensity) {
    const key = colour + ':' + (emissive || 0) + ':' + (emissiveIntensity || 0);
    if (!matCache[key]) {
      matCache[key] = new THREE.MeshLambertMaterial({
        color: colour,
        emissive: emissive || 0x000000,
        emissiveIntensity: emissiveIntensity === undefined ? 1 : emissiveIntensity
      });
    }
    return matCache[key];
  }

  // Something that IS a light source rather than something lit by one. Lambert
  // with a high emissive still takes a shading term and so still goes dull when
  // it faces away from the key; an exhaust must not.
  function glowMat(colour, opacity) {
    const key = 'basic:' + colour + ':' + (opacity || 1);
    if (!matCache[key]) {
      matCache[key] = new THREE.MeshBasicMaterial({
        color: colour,
        transparent: opacity !== undefined && opacity < 1,
        opacity: opacity === undefined ? 1 : opacity,
        side: THREE.DoubleSide
      });
    }
    return matCache[key];
  }

  function geo(key, build) {
    if (!geoCache[key]) geoCache[key] = build();
    return geoCache[key];
  }

  /* A swept planform — wing, fin, strake — from a list of points.
   *
   * ExtrudeGeometry is the right tool for this and gives something better than
   * a swept shape for free: it emits two material groups, the flat caps and
   * the side walls. Hand it two materials and every wing gets a rim around its
   * whole outline at no cost, which is exactly what the concept art does with
   * a painted edge and what a box cannot do at all.
   *
   * The shape is authored in (span, length) and rotated flat, so the numbers
   * below read the way the planform looks from above.
   */
  function planform(key, pts, thickness, mirror) {
    return geo(key + (mirror ? ':m' : ''), () => {
      const shape = new THREE.Shape();
      const sx = mirror ? -1 : 1;
      shape.moveTo(pts[0][0] * sx, pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0] * sx, pts[i][1]);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
      g.translate(0, 0, -thickness / 2);
      g.rotateX(Math.PI / 2);     // shape-y becomes world-z, extrusion becomes thickness in y
      g.computeVertexNormals();
      return g;
    });
  }

  /* ---- Hulls ----------------------------------------------------------
     Drawn from primitives, no model files, in the faction's own palette. Each
     returns { parts, collision }, where collision is the compound box list
     Ammo gets — always simpler than what you can see, because a collision hull
     that matches the silhouette exactly is one that costs four times as much
     and plays worse.
  */
  function buildHull(clsId, factionId) {
    const P = (clsId === 'station' && STATIONPAL[factionId]) || FACPAL[factionId] || FACPAL.player;
    const trimColour = (SE.FACTIONS[factionId] || SE.FACTIONS.player).colour;

    const body = mat(P.hull);
    const lit = mat(P.hullLit);
    const dark = mat(P.hullDark);
    const panel = mat(P.panel);
    const band = mat(P.band, P.band, 0.25);
    const edge = mat(EDGE, EDGE, 0.05);
    const rimLit = mat(P.rimLit);
    const trim = mat(trimColour, trimColour, 0.62);
    const flame = glowMat(P.glow);
    const flameHot = glowMat(P.glowHot);
    const rim = mat(P.glow, P.glow, 0.7);

    const parts = [];
    let collision;

    const push = (m, x, y, z, rx, ry, rz) => {
      m.position.set(x, y, z);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      parts.push(m);
      return m;
    };

    // An engine: a recessed bell, a banded collar, a rim and a hot core. The
    // concept art's drives are all this shape at different sizes.
    const engine = (x, y, z, r) => {
      push(new THREE.Mesh(geo('eng-bell' + r, () => new THREE.CylinderGeometry(r, r * 1.16, r * 1.5, 10)), dark),
        x, y, z, Math.PI / 2, 0, 0);
      push(new THREE.Mesh(geo('eng-collar' + r, () => new THREE.TorusGeometry(r * 1.06, r * 0.16, 6, 12)), band),
        x, y, z - r * 0.55);
      push(new THREE.Mesh(geo('eng-rim' + r, () => new THREE.TorusGeometry(r * 0.86, r * 0.20, 6, 12)), rim),
        x, y, z + r * 0.72);
      // CircleGeometry faces +Z, which is already astern — where the chase
      // camera lives. Rotating it to "face out" turns it away and lets
      // backface culling render the drives as black holes.
      push(new THREE.Mesh(geo('eng-core' + r, () => new THREE.CircleGeometry(r * 0.80, 14)), flame), x, y, z + r * 0.78);
      push(new THREE.Mesh(geo('eng-hot' + r, () => new THREE.CircleGeometry(r * 0.42, 12)), flameHot), x, y, z + r * 0.82);
    };

    // Hazard striping: the loud band the art puts on everything industrial or
    // military, and never on anything corporate.
    const hazard = (x, y, z, w, d) => push(new THREE.Mesh(
      geo('hz' + w + 'x' + d, () => new THREE.BoxGeometry(w, 0.18, d)), band), x, y, z);

    /* ---- Station vocabulary ------------------------------------------
       The five station references share a parts bin: pressurised tank modules
       with a coloured band, solar wings on trusses, lattice masts, dishes and
       glass domes. Written once here, they are what lets three stations be
       three different buildings rather than three versions of one, and each
       costs nothing at draw time because the whole station bakes to one mesh.
    */

    // A pressurised module: white cylinder, ribbed ends, one band of colour.
    // On the depot these are numbered tanks; on the research station they are
    // habitation. Same part, different job.
    const tankModule = (x, y, z, r, len, axis, skin) => {
      const rot = axis === 'z' ? [Math.PI / 2, 0, 0] : (axis === 'x' ? [0, 0, Math.PI / 2] : [0, 0, 0]);
      push(new THREE.Mesh(geo('tk' + r + len, () => new THREE.CylinderGeometry(r, r, len, 12)), skin || lit), x, y, z, rot[0], rot[1], rot[2]);
      push(new THREE.Mesh(geo('tkb' + r, () => new THREE.TorusGeometry(r * 1.02, r * 0.13, 6, 14)), band), x, y, z, rot[0] === 0 ? Math.PI / 2 : rot[0], rot[1], rot[2]);
      for (const e of [-1, 1]) {
        const ex = axis === 'x' ? x + e * len / 2 : x, ey = axis === 'y' ? y + e * len / 2 : y, ez = axis === 'z' ? z + e * len / 2 : z;
        push(new THREE.Mesh(geo('tke' + r, () => new THREE.CylinderGeometry(r * 0.72, r * 0.95, r * 0.5, 12)), panel), ex, ey, ez, rot[0], rot[1], rot[2]);
      }
    };

    // A solar wing: a boom out to a panel, the panel split into cells by a
    // gold frame. Deep indigo, because that is what a real array looks like and
    // also what the reference painted.
    const solarWing = (x, y, z, dirX, span, chord) => {
      const bl = span * 0.34;
      push(new THREE.Mesh(geo('sw-boom' + span, () => new THREE.CylinderGeometry(0.5, 0.5, bl, 6)), panel),
        x + dirX * bl / 2, y, z, 0, 0, Math.PI / 2);
      const px2 = x + dirX * (bl + span / 2);
      push(new THREE.Mesh(geo('sw-panel' + span + chord, () => new THREE.BoxGeometry(span, 0.3, chord)), mat(0x2b3578)), px2, y, z);
      push(new THREE.Mesh(geo('sw-frame' + span + chord, () => new THREE.BoxGeometry(span + 0.6, 0.5, 0.6)), band), px2, y, z + chord / 2);
      push(new THREE.Mesh(geo('sw-frame' + span + chord, () => new THREE.BoxGeometry(span + 0.6, 0.5, 0.6)), band), px2, y, z - chord / 2);
      for (let i = 1; i < 5; i++) {
        push(new THREE.Mesh(geo('sw-rib' + chord, () => new THREE.BoxGeometry(0.34, 0.42, chord)), mat(0x151a3a)),
          px2 - span / 2 + (span / 5) * i, 0.06 + y, z);
      }
    };

    // A lattice mast — the spine every industrial station in the references is
    // built along. Four rails and a zig-zag of bracing.
    const trussMast = (x, y, z, len, w, axis) => {
      const t = w * 0.13;
      const long = axis === 'y' ? [t, len, t] : (axis === 'z' ? [t, t, len] : [len, t, t]);
      for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
        const ox = axis === 'y' || axis === 'z' ? sa * w / 2 : 0;
        const oy = axis === 'y' ? 0 : sb * w / 2;
        const oz = axis === 'z' ? 0 : (axis === 'y' ? sb * w / 2 : sa * w / 2);
        push(new THREE.Mesh(geo('tm' + len + w + axis, () => new THREE.BoxGeometry(long[0], long[1], long[2])), band), x + ox, y + oy, z + oz);
      }
      const rungs = Math.max(2, Math.round(len / (w * 1.5)));
      for (let i = 0; i <= rungs; i++) {
        const f = -len / 2 + (len / rungs) * i;
        const rx = axis === 'x' ? x + f : x, ry = axis === 'y' ? y + f : y, rz = axis === 'z' ? z + f : z;
        push(new THREE.Mesh(geo('tmr' + w + axis, () => new THREE.BoxGeometry(axis === 'x' ? t : w, axis === 'y' ? t : w, axis === 'z' ? t : w)), dark), rx, ry, rz);
      }
    };

    const dish = (x, y, z, r, tiltX, yaw) => {
      push(new THREE.Mesh(geo('dh-st' + r, () => new THREE.CylinderGeometry(r * 0.10, r * 0.14, r * 1.1, 6)), panel), x, y - r * 0.5, z);
      push(new THREE.Mesh(geo('dh' + r, () => new THREE.SphereGeometry(r, 14, 8, 0, 6.283, 0, 0.95)), mat(0x2b3578)), x, y, z, Math.PI + tiltX, yaw, 0);
      push(new THREE.Mesh(geo('dhr' + r, () => new THREE.TorusGeometry(r * 0.82, r * 0.07, 6, 16)), band), x, y, z, Math.PI + tiltX, yaw, 0);
    };

    const glassDome = (x, y, z, r) => {
      push(new THREE.Mesh(geo('gd' + r, () => new THREE.SphereGeometry(r, 16, 10, 0, 6.283, 0, 1.25)), lit), x, y, z);
      push(new THREE.Mesh(geo('gdg' + r, () => new THREE.SphereGeometry(r * 0.88, 16, 9, 0, 6.283, 0, 1.15)), flame), x, y + r * 0.04, z);
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * Math.PI * 2;
        push(new THREE.Mesh(geo('gdrib' + r, () => new THREE.BoxGeometry(r * 0.09, r * 1.0, r * 0.09)), band),
          Math.cos(t) * r * 0.62 + x, y + r * 0.42, Math.sin(t) * r * 0.62 + z, 0, -t, 0);
      }
      push(new THREE.Mesh(geo('gdc' + r, () => new THREE.CylinderGeometry(r * 0.22, r * 0.3, r * 0.26, 10)), panel), x, y + r * 0.96, z);
    };

    // An open lattice pod face, as on the mining rig: four struts and a cross
    // brace. Cheap, and it is the single detail that makes a hull read as
    // industrial rather than as a box.
    const lattice = (x, y, z, w, h, d) => {
      const t = Math.min(w, h) * 0.10;
      push(new THREE.Mesh(geo('lat-v' + w + h + d, () => new THREE.BoxGeometry(t, h, t)), dark), x - w / 2, y, z - d / 2);
      push(new THREE.Mesh(geo('lat-v' + w + h + d, () => new THREE.BoxGeometry(t, h, t)), dark), x + w / 2, y, z - d / 2);
      push(new THREE.Mesh(geo('lat-v' + w + h + d, () => new THREE.BoxGeometry(t, h, t)), dark), x - w / 2, y, z + d / 2);
      push(new THREE.Mesh(geo('lat-v' + w + h + d, () => new THREE.BoxGeometry(t, h, t)), dark), x + w / 2, y, z + d / 2);
      push(new THREE.Mesh(geo('lat-h' + w + h + d, () => new THREE.BoxGeometry(w, t, t)), band), x, y + h / 2 - t, z - d / 2);
      push(new THREE.Mesh(geo('lat-h' + w + h + d, () => new THREE.BoxGeometry(w, t, t)), band), x, y - h / 2 + t, z - d / 2);
      const diag = Math.hypot(w, h);
      push(new THREE.Mesh(geo('lat-d' + w + h + d, () => new THREE.BoxGeometry(diag, t, t)), dark), x, y, z - d / 2, 0, 0, Math.atan2(h, w));
      push(new THREE.Mesh(geo('lat-d' + w + h + d, () => new THREE.BoxGeometry(diag, t, t)), dark), x, y, z - d / 2, 0, 0, -Math.atan2(h, w));
    };

    switch (clsId) {

      /* The corvette is the ship in the first concept piece: narrow spine,
         sharp nose, delta wings swept hard back to a point, nacelles slung low
         and aft, forward masts. It is the hull every other one borrows from. */
      case 'corvette': {
        const WING = [[0.55, -2.4], [5.2, 3.2], [4.2, 3.9], [0.55, 2.4]];
        const DROOP = 0.24;
        /* Anhedral, and it is not decoration. The chase camera sits about
           sixteen degrees above the ship, and a flat wing at sixteen degrees
           is very nearly edge-on — all trailing edge and no planform. */
        push(new THREE.Mesh(planform('c-wing', WING, 0.18, false), [body, rimLit]), 0, 0.02, 0.2, 0, 0, DROOP);
        push(new THREE.Mesh(planform('c-wing', WING, 0.18, true), [body, rimLit]), 0, 0.02, 0.2, 0, 0, -DROOP);
        const STRAKE = [[0.85, -1.8], [3.6, 1.4], [3.0, 2.0], [0.85, -0.9]];
        push(new THREE.Mesh(planform('c-strake', STRAKE, 0.10, false), [trim, trim]), 0, 0.19, 0.2, 0, 0, DROOP);
        push(new THREE.Mesh(planform('c-strake', STRAKE, 0.10, true), [trim, trim]), 0, 0.19, 0.2, 0, 0, -DROOP);

        push(new THREE.Mesh(geo('c-spine', () => new THREE.BoxGeometry(1.5, 1.25, 9.4)), body), 0, 0.12, -0.3);
        push(new THREE.Mesh(geo('c-dorsal', () => new THREE.BoxGeometry(0.66, 0.5, 7.4)), lit), 0, 0.78, -0.6);
        push(new THREE.Mesh(geo('c-gold', () => new THREE.BoxGeometry(0.24, 0.16, 5.2)), band), 0, 1.02, -0.4);
        push(new THREE.Mesh(geo('c-flank', () => new THREE.BoxGeometry(0.2, 0.7, 4.6)), panel), 0.78, 0.12, -0.6);
        push(new THREE.Mesh(geo('c-flank', () => new THREE.BoxGeometry(0.2, 0.7, 4.6)), panel), -0.78, 0.12, -0.6);
        push(new THREE.Mesh(geo('c-nose', () => new THREE.ConeGeometry(0.78, 3.6, 6)), body), 0, 0.10, -6.6, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-nosetip', () => new THREE.ConeGeometry(0.30, 1.1, 6)), edge), 0, 0.10, -8.0, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-mast', () => new THREE.CylinderGeometry(0.075, 0.11, 3.0, 5)), dark), 1.18, 1.1, -2.6);
        push(new THREE.Mesh(geo('c-mast', () => new THREE.CylinderGeometry(0.075, 0.11, 3.0, 5)), dark), -1.18, 1.1, -2.6);

        // Greebles, to the same density the stations got. Every one of these
        // is a handful of triangles and none of them is a draw call, so the
        // only reason the corvette was bare was that nothing had been added.
        push(new THREE.Mesh(geo('c-canopy', () => new THREE.SphereGeometry(0.52, 10, 7)), dark), 0, 0.82, -3.0);
        push(new THREE.Mesh(geo('c-canfr', () => new THREE.BoxGeometry(1.16, 0.16, 1.5)), band), 0, 0.92, -3.0);
        push(new THREE.Mesh(geo('c-intake', () => new THREE.BoxGeometry(0.85, 0.62, 1.5)), panel), 0.92, -0.18, -1.2);
        push(new THREE.Mesh(geo('c-intake', () => new THREE.BoxGeometry(0.85, 0.62, 1.5)), panel), -0.92, -0.18, -1.2);
        for (let i = 0; i < 4; i++) {
          const z = -3.4 + i * 2.3;
          push(new THREE.Mesh(geo('c-rib', () => new THREE.BoxGeometry(1.62, 0.22, 0.34)), panel), 0, 0.76, z);
          push(new THREE.Mesh(geo('c-lamp', () => new THREE.BoxGeometry(0.16, 0.16, 0.9)), flame), 0.80, 0.42, z + 0.6);
          push(new THREE.Mesh(geo('c-lamp', () => new THREE.BoxGeometry(0.16, 0.16, 0.9)), flame), -0.80, 0.42, z + 0.6);
        }
        push(new THREE.Mesh(geo('c-vent', () => new THREE.BoxGeometry(2.4, 0.3, 1.1)), dark), 0, 0.68, 3.6);
        push(new THREE.Mesh(geo('c-tail', () => new THREE.BoxGeometry(0.26, 1.55, 1.7)), lit), 0, 1.2, 3.9);
        push(new THREE.Mesh(geo('c-tailtip', () => new THREE.BoxGeometry(0.3, 0.3, 0.7)), trim), 0, 1.92, 4.0);

        for (const sx of [1, -1]) {
          push(new THREE.Mesh(geo('c-nac', () => new THREE.CylinderGeometry(0.66, 0.74, 6.2, 10)), lit),
            sx * 1.32, -0.42, 2.2, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('c-band', () => new THREE.TorusGeometry(0.73, 0.10, 6, 12)), band), sx * 1.32, -0.42, 1.1);
          push(new THREE.Mesh(geo('c-nacspine', () => new THREE.BoxGeometry(0.4, 0.5, 5.0)), panel), sx * 1.32, 0.28, 2.4);
          push(new THREE.Mesh(geo('c-pylon', () => new THREE.BoxGeometry(1.1, 0.42, 2.2)), panel), sx * 0.85, -0.22, 1.4);
          push(new THREE.Mesh(geo('c-hardpt', () => new THREE.CylinderGeometry(0.16, 0.2, 2.6, 5)), dark),
            sx * 2.5, -0.30, -1.6, Math.PI / 2, 0, 0);
          engine(sx * 1.32, -0.42, 5.3, 0.66);
        }
        collision = [
          { shape: 'box', width: 3.4, height: 2.6, depth: 13 },
          { shape: 'box', width: 10.6, height: 0.7, depth: 6.4, x: 0, y: -0.05, z: 0.8 }
        ];
        break;
      }

      /* The interceptor follows the corporate shuttle: one clean delta, a
         bubble canopy set well forward, upturned tips, one big drive. Almost
         no greebling — on this hull the smoothness IS the statement. */
      case 'interceptor': {
        const WING = [[0.42, -2.0], [4.1, 2.0], [3.5, 2.9], [0.42, 2.1]];
        const IDROOP = 0.14;
        push(new THREE.Mesh(planform('i-wing', WING, 0.20, false), [body, rimLit]), 0, -0.02, 0.4, 0, 0, IDROOP);
        push(new THREE.Mesh(planform('i-wing', WING, 0.20, true), [body, rimLit]), 0, -0.02, 0.4, 0, 0, -IDROOP);
        // upturned winglets, as on the shuttle
        push(new THREE.Mesh(geo('i-let', () => new THREE.BoxGeometry(0.16, 1.15, 1.5)), panel), 3.72, 0.52, 2.5, 0, 0, -0.20);
        push(new THREE.Mesh(geo('i-let', () => new THREE.BoxGeometry(0.16, 1.15, 1.5)), panel), -3.72, 0.52, 2.5, 0, 0, 0.20);
        push(new THREE.Mesh(geo('i-tipb', () => new THREE.BoxGeometry(0.2, 0.3, 0.55)), band), 3.72, 1.02, 2.9);
        push(new THREE.Mesh(geo('i-tipb', () => new THREE.BoxGeometry(0.2, 0.3, 0.55)), band), -3.72, 1.02, 2.9);

        push(new THREE.Mesh(geo('i-spine', () => new THREE.BoxGeometry(1.15, 0.95, 6.4)), body), 0, 0.10, -0.2);
        push(new THREE.Mesh(geo('i-belly', () => new THREE.BoxGeometry(0.9, 0.5, 4.4)), panel), 0, -0.42, 0.6);
        push(new THREE.Mesh(geo('i-stripe', () => new THREE.BoxGeometry(0.42, 0.14, 5.6)), panel), 0, 0.60, -0.4);
        push(new THREE.Mesh(geo('i-nose', () => new THREE.ConeGeometry(0.58, 2.8, 7)), body), 0, 0.10, -4.6, -Math.PI / 2, 0, 0);
        // the canopy: dark, glassy, set forward and proud of the spine
        push(new THREE.Mesh(geo('i-canopy', () => new THREE.SphereGeometry(0.62, 10, 8)), dark), 0, 0.62, -2.9);
        push(new THREE.Mesh(geo('i-canopy2', () => new THREE.SphereGeometry(0.46, 10, 8)), panel), 0, 0.66, -3.5);
        push(new THREE.Mesh(geo('i-fin', () => new THREE.BoxGeometry(0.16, 1.0, 1.4)), trim), 0, 0.82, 1.9);
        // The shuttle is meant to stay clean — on this hull the smoothness is
        // the statement — so it gets seams and lights rather than greebles.
        push(new THREE.Mesh(geo('i-seam', () => new THREE.BoxGeometry(0.22, 0.14, 4.6)), panel), 0.58, 0.48, -0.6);
        push(new THREE.Mesh(geo('i-seam', () => new THREE.BoxGeometry(0.22, 0.14, 4.6)), panel), -0.58, 0.48, -0.6);
        push(new THREE.Mesh(geo('i-noseband', () => new THREE.BoxGeometry(1.0, 0.16, 0.5)), band), 0, 0.52, -3.9);
        push(new THREE.Mesh(geo('i-mark', () => new THREE.BoxGeometry(1.5, 0.12, 1.5)), trim), 0, 0.60, -1.5);
        push(new THREE.Mesh(geo('i-navL', () => new THREE.BoxGeometry(0.22, 0.22, 0.5)), flame), 3.55, 0.30, 2.2);
        push(new THREE.Mesh(geo('i-navR', () => new THREE.BoxGeometry(0.22, 0.22, 0.5)), flame), -3.55, 0.30, 2.2);
        push(new THREE.Mesh(geo('i-nac', () => new THREE.CylinderGeometry(0.62, 0.68, 2.8, 10)), lit), 0, -0.18, 2.4, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('i-nacband', () => new THREE.TorusGeometry(0.70, 0.09, 6, 12)), band), 0, -0.18, 1.6);
        engine(0, -0.18, 4.2, 0.62);
        collision = [{ shape: 'box', width: 8.2, height: 2.0, depth: 9.2 }];
        break;
      }

      /* The rig. A rounded central body with the ore tanks banded down it, two
         open lattice pods where a warship would carry weapons, and the whole
         thing striped like something you are not supposed to stand under. */
      case 'extractor': {
        push(new THREE.Mesh(geo('e-body', () => new THREE.CylinderGeometry(2.7, 3.0, 13.0, 10)), body), 0, 0, 1.0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('e-back', () => new THREE.BoxGeometry(4.6, 3.6, 4.2)), lit), 0, 0, 6.6);
        push(new THREE.Mesh(geo('e-spinal', () => new THREE.BoxGeometry(1.3, 0.7, 11.0)), panel), 0, 2.5, 1.2);
        hazard(0, 2.92, -2.2, 3.0, 0.9);
        hazard(0, 2.92, 3.4, 3.0, 0.9);
        push(new THREE.Mesh(geo('e-ladder', () => new THREE.BoxGeometry(0.9, 0.2, 9.0)), dark), 0, 2.92, 1.0);
        push(new THREE.Mesh(geo('e-drill', () => new THREE.ConeGeometry(2.0, 5.4, 8)), dark), 0, 0, -7.6, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('e-ring', () => new THREE.TorusGeometry(2.4, 0.42, 6, 12)), trim), 0, 0, -4.8);
        for (const sx of [1, -1]) {
          push(new THREE.Mesh(geo('e-boom', () => new THREE.BoxGeometry(1.5, 1.0, 7.0)), dark), sx * 3.5, -0.4, 1.4);
          lattice(sx * 4.6, -0.4, 1.4, 2.4, 3.2, 6.6);
          push(new THREE.Mesh(geo('e-pod', () => new THREE.BoxGeometry(1.1, 2.6, 6.0)), panel), sx * 5.7, -0.4, 1.4);
          engine(sx * 1.9, -1.2, 9.4, 1.10);
        }
        collision = [{ shape: 'box', width: 13.4, height: 6.4, depth: 21 }];
        break;
      }

      /* Cargo with engines attached, and the art is blunt about it: a thin
         spine you can barely see between two container stacks bigger than the
         ship. Banding on every pod, because everything here is somebody's
         consignment. */
      /* Cargo with engines attached. The reference carries ONE big container
         a side rather than a stack of small ones, and that is the better read:
         a single slab with corner brackets and hazard diagonals says "freight"
         instantly, where three little boxes just say "greebles". */
      case 'freighter': {
        push(new THREE.Mesh(geo('f-spine', () => new THREE.BoxGeometry(3.4, 3.8, 24)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('f-dorsal', () => new THREE.BoxGeometry(2.2, 1.2, 19)), lit), 0, 2.4, -1);
        push(new THREE.Mesh(geo('f-keel', () => new THREE.BoxGeometry(2.6, 1.4, 17)), panel), 0, -2.3, 1);
        push(new THREE.Mesh(geo('f-nose', () => new THREE.ConeGeometry(1.7, 7.5, 6)), body), 0, 0.3, -15.6, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('f-nosetip', () => new THREE.ConeGeometry(0.6, 2.4, 6)), band), 0, 0.3, -19.8, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('f-mast', () => new THREE.CylinderGeometry(0.1, 0.15, 4.0, 4)), dark), 0.9, 2.9, -12);
        push(new THREE.Mesh(geo('f-mast', () => new THREE.CylinderGeometry(0.1, 0.15, 4.0, 4)), dark), -0.9, 2.9, -12);
        // the red flash the reference runs down the spine and the nacelles
        push(new THREE.Mesh(geo('f-flash', () => new THREE.BoxGeometry(0.4, 0.9, 11)), trim), 1.75, 0.9, -4);
        push(new THREE.Mesh(geo('f-flash', () => new THREE.BoxGeometry(0.4, 0.9, 11)), trim), -1.75, 0.9, -4);

        for (const sx of [1, -1]) {
          // outrigger, then one big container
          push(new THREE.Mesh(geo('f-arm', () => new THREE.BoxGeometry(4.0, 1.6, 4.4)), panel), sx * 3.8, 0.6, -2.5);
          const cw = 5.4, ch = 7.0, cd = 15.5;
          push(new THREE.Mesh(geo('f-box', () => new THREE.BoxGeometry(cw, ch, cd)), mat(P.panel)), sx * 8.6, 0.8, -2.5);
          // corner brackets, the detail that makes it a container
          for (const cy of [-1, 1]) for (const cz of [-1, 1]) {
            push(new THREE.Mesh(geo('f-brk', () => new THREE.BoxGeometry(cw + 0.5, 1.0, 1.0)), band),
              sx * 8.6, 0.8 + cy * (ch / 2 - 0.3), -2.5 + cz * (cd / 2 - 0.5));
            push(new THREE.Mesh(geo('f-brkv', () => new THREE.BoxGeometry(cw + 0.4, ch - 1.2, 0.8)), band),
              sx * 8.6, 0.8, -2.5 + cz * (cd / 2 - 0.5));
          }
          // hazard diagonals and a placard on the outboard face
          for (let i = 0; i < 5; i++) {
            push(new THREE.Mesh(geo('f-haz', () => new THREE.BoxGeometry(0.4, 0.7, 4.2)), band),
              sx * (8.6 + cw / 2 + 0.05), -1.6, -7.0 + i * 2.4, 0.7, 0, 0);
          }
          push(new THREE.Mesh(geo('f-placard', () => new THREE.BoxGeometry(0.4, 1.6, 4.0)), lit), sx * (8.6 + cw / 2 + 0.06), 2.2, -2.5);
          push(new THREE.Mesh(geo('f-ribs', () => new THREE.BoxGeometry(cw + 0.3, 0.5, 0.5)), dark), sx * 8.6, 3.2, -2.5);

          // nacelle: housing, gold-ringed exhaust, side striping
          push(new THREE.Mesh(geo('f-nac', () => new THREE.BoxGeometry(5.0, 5.0, 14)), lit), sx * 4.4, -2.6, 10);
          push(new THREE.Mesh(geo('f-naccap', () => new THREE.CylinderGeometry(2.5, 2.7, 3.2, 10)), body), sx * 4.4, -2.6, 3.6, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('f-nacflash', () => new THREE.BoxGeometry(0.4, 0.8, 9)), trim), sx * (4.4 + 2.55), -0.9, 9);
          for (let i = 0; i < 4; i++) {
            push(new THREE.Mesh(geo('f-nacstripe', () => new THREE.BoxGeometry(0.4, 0.5, 1.6)), band),
              sx * (4.4 + 2.55), -4.2, 5.5 + i * 3.0);
          }
          engine(sx * 4.4, -2.6, 17.6, 2.35);
        }
        collision = [
          { shape: 'box', width: 28, height: 9, depth: 30 },
          { shape: 'box', width: 6, height: 6, depth: 40 }
        ];
        break;
      }

      /* The capital hull is a terraced arrowhead, and the terracing is the
         whole idea: the reference is not one slab but four or five swept
         plates stacked with each one narrower than the plate below, so the
         silhouette reads as a stepped pyramid from every angle and every step
         gives the eye an edge to catch. Down the middle runs a ladder of lit
         segments, and along each terrace edge sits a row of barrels. */
      case 'dreadnought': {
        const DECK = [
          // [half-span, nose z, tail z, y, thickness] — the steps overlap in
          // height on purpose, so it reads as armour layered over a hull
          // rather than as a staircase
          [17.0, -34, 27, -3.0, 5.6],
          [14.0, -38, 24, 0.9, 4.8],
          [10.6, -41, 21, 4.1, 4.2],
          [7.2, -43, 18, 6.9, 3.6],
          [4.4, -44, 14, 9.2, 3.0]
        ];
        DECK.forEach(([hs, nz, tz, dy, th], i) => {
          const shape = [[0.9, nz], [hs, tz * 0.35], [hs * 0.82, tz], [0.9, tz]];
          push(new THREE.Mesh(planform('d-deck' + i, shape, th, false), [i % 2 ? lit : body, rimLit]), 0, dy, 0);
          push(new THREE.Mesh(planform('d-deck' + i, shape, th, true), [i % 2 ? lit : body, rimLit]), 0, dy, 0);
          /* Gold along the EDGE of each terrace, not across it. The first
             version laid a gold planform on top of every deck, which is a
             filled plate rather than a rim — the whole capital came out as a
             gold ziggurat with a hull hidden somewhere underneath. Trim is a
             line, and a line has to be built as one. */
          const ex = hs - 0.9, ez = tz * 0.35 - nz;
          const elen = Math.hypot(ex, ez), eang = Math.atan2(ex, ez);
          for (const sx of [1, -1]) {
            push(new THREE.Mesh(geo('d-edge' + i, () => new THREE.BoxGeometry(0.55, 0.42, elen)), band),
              sx * (0.9 + ex / 2), dy + th / 2 + 0.12, nz + ez / 2, 0, sx * eang, 0);
          }
          // and one across the tail, closing the rim
          push(new THREE.Mesh(geo('d-tailedge' + i, () => new THREE.BoxGeometry(hs * 1.62, 0.42, 0.55)), band),
            0, dy + th / 2 + 0.12, tz - 0.4);
          // barrels along the terrace edge
          if (i < 4) {
            for (let k = 0; k < 4; k++) {
              const t = 0.18 + k * 0.2;
              const bx = hs * (0.55 + k * 0.1), bz = nz + (tz - nz) * t;
              for (const sx of [1, -1]) {
                push(new THREE.Mesh(geo('d-gun', () => new THREE.CylinderGeometry(0.28, 0.32, 7.5, 5)), dark),
                  sx * bx, dy + th / 2 + 0.7, bz - 3, Math.PI / 2, 0, 0);
                push(new THREE.Mesh(geo('d-gunb', () => new THREE.BoxGeometry(1.5, 1.0, 2.0)), panel),
                  sx * bx, dy + th / 2 + 0.6, bz + 1.4);
              }
            }
          }
        });

        // the lit spine: a ladder of glowing segments between armoured ribs
        for (let i = 0; i < 9; i++) {
          const z = -30 + i * 6.6;
          push(new THREE.Mesh(geo('d-rib', () => new THREE.BoxGeometry(5.6, 4.0, 3.4)), panel), 0, 10.6, z);
          push(new THREE.Mesh(geo('d-seg', () => new THREE.BoxGeometry(3.0, 1.4, 3.0)), flame), 0, 12.4, z + 3.3);
        }
        push(new THREE.Mesh(geo('d-prow', () => new THREE.ConeGeometry(2.6, 13, 6)), body), 0, 8.8, -47, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-prowlip', () => new THREE.ConeGeometry(0.95, 4.4, 6)), band), 0, 8.8, -53.6, -Math.PI / 2, 0, 0);

        // the flank panels, with the faction's mark on them
        for (const sx of [1, -1]) {
          push(new THREE.Mesh(geo('d-flank', () => new THREE.BoxGeometry(0.6, 5.4, 26)), dark), sx * 12.6, 1.4, -2, 0, 0, 0);
          push(new THREE.Mesh(geo('d-flanklip', () => new THREE.BoxGeometry(0.8, 0.5, 26)), band), sx * 12.6, 4.2, -2);
          push(new THREE.Mesh(geo('d-flanklip', () => new THREE.BoxGeometry(0.8, 0.5, 26)), band), sx * 12.6, -1.4, -2);
          push(new THREE.Mesh(geo('d-mark', () => new THREE.BoxGeometry(0.7, 3.2, 3.2)), trim), sx * 12.9, 1.4, -4);
          // hull greebles down the flank
          for (let i = 0; i < 6; i++) {
            push(new THREE.Mesh(geo('d-fgreeb' + (i % 3), () => new THREE.BoxGeometry(1.2, 1.4 + (i % 3) * 0.6, 2.6)), panel),
              sx * 11.8, -4.6, -22 + i * 8);
          }
        }

        // engine cluster: one big, four small, as on the reference
        engine(0, 0.2, 31, 3.4);
        for (let i = 0; i < 4; i++) {
          const ax2 = (i - 1.5) * 5.2;
          engine(ax2, -4.2, 29.5, 1.5);
        }
        for (const sx of [1, -1]) {
          push(new THREE.Mesh(geo('d-nozhous', () => new THREE.BoxGeometry(6.0, 5.0, 8.0)), lit), sx * 8.5, -2.0, 27);
          push(new THREE.Mesh(geo('d-nozband', () => new THREE.BoxGeometry(6.2, 0.6, 1.6)), band), sx * 8.5, 0.3, 24);
          engine(sx * 8.5, -2.0, 32, 1.9);
        }
        collision = [
          { shape: 'box', width: 35, height: 9, depth: 74 },
          { shape: 'box', width: 22, height: 14, depth: 60, x: 0, y: 6, z: -2 },
          { shape: 'box', width: 10, height: 10, depth: 16, x: 0, y: 8.8, z: -47 }
        ];
        break;
      }

      /* ---- Stations -------------------------------------------------
         Not one shape recoloured three times. The reference art gives each
         faction a different piece of ARCHITECTURE, and that is the difference
         the eye actually reads — a military fortress, a corporate ring with a
         tower, a junkyard spine are not the same building in three paints.

         Only Vanguard's is built to the reference so far. The others fall
         through to the old ring until this approach is judged worth
         continuing.
      */
      case 'station': {
        if (factionId === 'vanguard') {
          // --- a disc fortress: armoured saucer, radial gun blisters, a
          //     command spire above and two hangar pods slung beneath.

          // the saucer, built from stacked cylinders so it has a rim and a
          // shoulder rather than being a single slab
          push(new THREE.Mesh(geo('vs-hull', () => new THREE.CylinderGeometry(40, 44, 7, 22)), body), 0, 0, 0);
          push(new THREE.Mesh(geo('vs-belly', () => new THREE.CylinderGeometry(44, 30, 8, 22)), lit), 0, -7, 0);
          push(new THREE.Mesh(geo('vs-shoulder', () => new THREE.CylinderGeometry(31, 40, 7, 22)), lit), 0, 6.5, 0);
          push(new THREE.Mesh(geo('vs-rim', () => new THREE.TorusGeometry(43.4, 1.5, 6, 30)), band), 0, -1.6, 0, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('vs-rim2', () => new THREE.TorusGeometry(40.2, 0.8, 6, 30)), band), 0, 3.4, 0, Math.PI / 2, 0, 0);

          // deck plating: wedges radiating from the core, which is what stops
          // a 44-metre cylinder reading as a poker chip
          for (let i = 0; i < 11; i++) {
            const t = (i / 11) * Math.PI * 2;
            push(new THREE.Mesh(geo('vs-wedge', () => new THREE.BoxGeometry(3.0, 1.2, 26)), panel),
              Math.cos(t) * 26, 10.2, Math.sin(t) * 26, 0, -t, 0);
          }

          /* Density. The single biggest remaining difference from the
             reference is not shape or colour, it is the sheer COUNT of small
             parts — vents, housings, rails, aerials. Each one is a handful of
             triangles and, because the whole station bakes down to one mesh,
             none of them costs a draw call. So there is no reason to be
             sparing, and being sparing is exactly what made the first version
             read as a prototype. */
          for (let i = 0; i < 26; i++) {
            const t = (i / 26) * Math.PI * 2 + 0.12;
            const r = 34 + (i % 3) * 1.6;
            push(new THREE.Mesh(geo('vs-vent' + (i % 3), () => new THREE.BoxGeometry(2.2 + (i % 3), 1.1, 3.4)), panel),
              Math.cos(t) * r, 10.4, Math.sin(t) * r, 0, -t, 0);
          }
          for (let i = 0; i < 16; i++) {
            const t = (i / 16) * Math.PI * 2 + 0.2;
            push(new THREE.Mesh(geo('vs-box', () => new THREE.BoxGeometry(3.4, 2.4, 3.4)), lit),
              Math.cos(t) * 21, 11.0, Math.sin(t) * 21, 0, -t, 0);
            push(new THREE.Mesh(geo('vs-boxlip', () => new THREE.BoxGeometry(3.6, 0.4, 3.6)), band),
              Math.cos(t) * 21, 12.3, Math.sin(t) * 21, 0, -t, 0);
          }
          // a secondary ring of smaller housings between the guns
          for (let i = 0; i < 8; i++) {
            const t = (i / 8) * Math.PI * 2;
            push(new THREE.Mesh(geo('vs-pod2', () => new THREE.CylinderGeometry(2.6, 3.0, 3.2, 8)), lit),
              Math.cos(t) * 36, 9.6, Math.sin(t) * 36);
            push(new THREE.Mesh(geo('vs-aer', () => new THREE.ConeGeometry(0.22, 7, 4)), dark),
              Math.cos(t) * 36, 14.6, Math.sin(t) * 36);
          }
          // underside greebles, visible whenever you approach from below
          for (let i = 0; i < 14; i++) {
            const t = (i / 14) * Math.PI * 2 + 0.3;
            push(new THREE.Mesh(geo('vs-ubox', () => new THREE.BoxGeometry(3.0, 2.2, 5.0)), panel),
              Math.cos(t) * 30, -11.6, Math.sin(t) * 30, 0, -t, 0);
          }

          // gun blisters around the rim, each with a barrel pair
          for (let i = 0; i < 8; i++) {
            const t = (i / 8) * Math.PI * 2 + 0.39;
            const bx = Math.cos(t) * 31, bz = Math.sin(t) * 31;
            push(new THREE.Mesh(geo('vs-blister', () => new THREE.SphereGeometry(5.0, 10, 7, 0, 6.283, 0, 1.25)), lit), bx, 8.4, bz);
            push(new THREE.Mesh(geo('vs-bcollar', () => new THREE.CylinderGeometry(5.2, 5.6, 1.6, 10)), panel), bx, 8.0, bz);
            for (const off of [-1.6, 1.6]) {
              push(new THREE.Mesh(geo('vs-barrel', () => new THREE.CylinderGeometry(0.62, 0.62, 15, 6)), dark),
                bx + Math.cos(t) * 6 - Math.sin(t) * off, 10.4, bz + Math.sin(t) * 6 + Math.cos(t) * off,
                Math.PI / 2, -t + Math.PI / 2, 0);
            }
          }

          // lit windows around the hull skirt — the glow bucket, so they bloom
          for (let row = 0; row < 2; row++) {
            const n = 56, y = -3.2 + row * 3.4, rr = 42.4 - row * 1.1;
            for (let i = 0; i < n; i++) {
              const t = (i / n) * Math.PI * 2 + row * 0.05;
              push(new THREE.Mesh(geo('vs-win', () => new THREE.BoxGeometry(0.5, 1.0, 1.7)), flame),
                Math.cos(t) * rr, y, Math.sin(t) * rr, 0, -t, 0);
            }
          }

          // command spire
          push(new THREE.Mesh(geo('vs-drum', () => new THREE.CylinderGeometry(15, 19, 12, 14)), body), 0, 14.6, 0);
          push(new THREE.Mesh(geo('vs-drumband', () => new THREE.TorusGeometry(15.2, 0.9, 6, 20)), band), 0, 18.4, 0, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('vs-tower', () => new THREE.CylinderGeometry(9.5, 13.5, 16, 12)), lit), 0, 27.5, 0);
          push(new THREE.Mesh(geo('vs-crown', () => new THREE.CylinderGeometry(7, 9.5, 5, 12)), panel), 0, 37.5, 0);
          push(new THREE.Mesh(geo('vs-insig', () => new THREE.BoxGeometry(7.2, 4.4, 0.5)), trim), 0, 28.5, 13.2);
          for (let i = 0; i < 24; i++) {
            const t = (i / 24) * Math.PI * 2;
            push(new THREE.Mesh(geo('vs-twin', () => new THREE.BoxGeometry(0.42, 1.5, 0.42)), flame),
              Math.cos(t) * 13.9, 26.5, Math.sin(t) * 13.9, 0, -t, 0);
          }
          // the antenna crown the reference bristles with
          for (let i = 0; i < 9; i++) {
            const t = (i / 9) * Math.PI * 2;
            const r = i % 2 ? 4.5 : 6.6, h = i % 2 ? 19 : 13;
            push(new THREE.Mesh(geo('vs-ant' + (i % 2), () => new THREE.ConeGeometry(0.34, h, 5)), dark),
              Math.cos(t) * r, 40 + h / 2, Math.sin(t) * r);
          }
          push(new THREE.Mesh(geo('vs-mast', () => new THREE.ConeGeometry(0.55, 30, 6)), dark), 0, 55, 0);

          // two hangar pods slung below and forward, the heaviest shapes on the
          // whole silhouette in the reference and the reason it reads as a
          // warship rather than as a space station
          for (const sx of [1, -1]) {
            // These are the heaviest shapes in the reference — as wide as a
            // third of the saucer each and hanging most of its diameter below
            // it. Built thin the first time, and the station immediately read
            // as a table on legs rather than as a warship with its hangars
            // slung underneath.
            const px2 = sx * 25, pz2 = 4, tilt = 0.30, splay = sx * 0.11;
            push(new THREE.Mesh(geo('vs-pylon', () => new THREE.BoxGeometry(9.0, 16, 11.0)), panel), px2 * 0.70, -11, pz2 * 0.5, 0, 0, splay);
            push(new THREE.Mesh(geo('vs-pod', () => new THREE.BoxGeometry(26, 19, 72)), body), px2, -31, pz2, tilt, 0, splay);
            push(new THREE.Mesh(geo('vs-podtop', () => new THREE.BoxGeometry(19, 2.0, 68)), lit), px2, -21.4, pz2 + 0.6, tilt, 0, splay);
            push(new THREE.Mesh(geo('vs-podstripe', () => new THREE.BoxGeometry(2.4, 0.7, 60)), band), px2, -20.3, pz2 + 0.6, tilt, 0, splay);
            push(new THREE.Mesh(geo('vs-podflank', () => new THREE.BoxGeometry(1.4, 12, 66)), panel), px2 + sx * 13, -31, pz2, tilt, 0, splay);
            push(new THREE.Mesh(geo('vs-podnose', () => new THREE.BoxGeometry(21, 14, 12)), lit), px2, -41.5, pz2 - 37.0, tilt, 0, splay);
            push(new THREE.Mesh(geo('vs-podtail', () => new THREE.BoxGeometry(23, 16, 6)), panel), px2, -20.0, pz2 + 35.0, tilt, 0, splay);
            for (let i = 0; i < 6; i++) {
              const rz = -28 + i * 11;
              push(new THREE.Mesh(geo('vs-podbox', () => new THREE.BoxGeometry(4.0, 2.2, 4.4)), panel),
                px2 - sx * 6, -31 + rz * Math.sin(tilt) * -1 + 10.2, pz2 + rz, tilt, 0, splay);
              push(new THREE.Mesh(geo('vs-podbox2', () => new THREE.BoxGeometry(3.0, 1.6, 3.4)), lit),
                px2 + sx * 6, -31 + rz * Math.sin(tilt) * -1 + 10.4, pz2 + rz, tilt, 0, splay);
            }
            for (const rz of [-26, -8, 10, 26]) {
              push(new THREE.Mesh(geo('vs-podrib', () => new THREE.BoxGeometry(26.6, 1.4, 2.2)), panel),
                px2, -31 + rz * Math.sin(tilt) * -1, pz2 + rz, tilt, 0, splay);
            }
            // hangar mouth, lit from inside
            push(new THREE.Mesh(geo('vs-mouth', () => new THREE.BoxGeometry(14.0, 7.0, 0.8)), flame), px2, -42.6, pz2 - 43.2, tilt, 0, splay);
            for (let i = 0; i < 9; i++) {
              const rz = -30 + i * 8;
              push(new THREE.Mesh(geo('vs-podwin', () => new THREE.BoxGeometry(0.7, 1.3, 1.8)), flame),
                px2 + sx * 13.6, -31 + rz * Math.sin(tilt) * -1 + 2, pz2 + rz, tilt, 0, splay);
            }
          }

          collision = [
            { shape: 'box', width: 88, height: 16, depth: 88 },
            { shape: 'box', width: 30, height: 40, depth: 30, x: 0, y: 24, z: 0 },
            { shape: 'box', width: 28, height: 22, depth: 74, x: 25, y: -31, z: 4 },
            { shape: 'box', width: 28, height: 22, depth: 74, x: -25, y: -31, z: 4 }
          ];
          break;
        }

        if (factionId === 'apex') {
          /* Orbital Dynamics: a commercial ring around an advertising tower.
             Everything bright on it is signage. The reference is a building
             that sells you something before it docks you, and the tower is
             taller than the ring is wide for exactly that reason. */
          push(new THREE.Mesh(geo('ax-base', () => new THREE.CylinderGeometry(15, 20, 12, 14)), body), 0, -4, 0);
          push(new THREE.Mesh(geo('ax-tower', () => new THREE.BoxGeometry(15, 46, 15)), body), 0, 26, 0);
          push(new THREE.Mesh(geo('ax-tower2', () => new THREE.BoxGeometry(11, 20, 11)), lit), 0, 58, 0);
          push(new THREE.Mesh(geo('ax-cap', () => new THREE.CylinderGeometry(3.5, 6.5, 9, 8)), panel), 0, 72, 0);
          push(new THREE.Mesh(geo('ax-spire', () => new THREE.ConeGeometry(0.8, 26, 6)), dark), 0, 89, 0);
          // signage: tall lit panels on all four faces, which is the whole
          // personality of this station
          for (let i = 0; i < 4; i++) {
            const t = i * Math.PI / 2;
            push(new THREE.Mesh(geo('ax-sign', () => new THREE.BoxGeometry(11.5, 26, 0.5)), flame),
              Math.cos(t) * 7.8, 30, Math.sin(t) * 7.8, 0, -t, 0);
            push(new THREE.Mesh(geo('ax-signfr', () => new THREE.BoxGeometry(12.6, 27.4, 0.34)), band),
              Math.cos(t) * 7.6, 30, Math.sin(t) * 7.6, 0, -t, 0);
            push(new THREE.Mesh(geo('ax-logo', () => new THREE.BoxGeometry(6.0, 6.0, 0.5)), glowMat(P.band)),
              Math.cos(t) * 5.9, 57, Math.sin(t) * 5.9, 0, -t, 0);
          }
          // the ring, on spokes, lit along both rims
          push(new THREE.Mesh(geo('ax-ring', () => new THREE.TorusGeometry(42, 3.6, 8, 32)), lit), 0, 2, 0, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('ax-ringin', () => new THREE.TorusGeometry(42, 1.5, 6, 32)), flame), 0, 5.0, 0, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('ax-ringlo', () => new THREE.TorusGeometry(42, 1.1, 6, 32)), glowMat(P.band)), 0, -1.0, 0, Math.PI / 2, 0, 0);
          for (let i = 0; i < 6; i++) {
            const t = (i / 6) * Math.PI * 2;
            trussMast(Math.cos(t) * 30, 2, Math.sin(t) * 30, 26, 3.2, 'x');
            push(new THREE.Mesh(geo('ax-spoke', () => new THREE.BoxGeometry(26, 2.2, 3.2)), panel),
              Math.cos(t) * 30, 2, Math.sin(t) * 30, 0, -t, 0);
          }
          // docking arms with a freighter clamped on each, as the reference has
          for (let i = 0; i < 5; i++) {
            const t = (i / 5) * Math.PI * 2 + 0.3;
            const ax2 = Math.cos(t), az2 = Math.sin(t);
            push(new THREE.Mesh(geo('ax-arm', () => new THREE.BoxGeometry(4.2, 4.2, 22)), lit), ax2 * 52, -10, az2 * 52, 0, -t + Math.PI / 2, 0);
            tankModule(ax2 * 66, -12, az2 * 66, 4.0, 15, 'y', lit);
            push(new THREE.Mesh(geo('ax-clamp', () => new THREE.BoxGeometry(6.5, 2.0, 6.5)), band), ax2 * 66, -20.5, az2 * 66);
            for (const e of [-1, 1]) {
              push(new THREE.Mesh(geo('ax-thr', () => new THREE.CylinderGeometry(1.1, 1.4, 1.2, 8)), flame),
                ax2 * 66 + e * 2.6, -22.4, az2 * 66);
            }
          }
          // hab modules banded round the base
          for (let i = 0; i < 4; i++) {
            const t = i * Math.PI / 2 + Math.PI / 4;
            tankModule(Math.cos(t) * 21, -6, Math.sin(t) * 21, 4.6, 13, 'y', lit);
          }
          collision = [
            { shape: 'box', width: 40, height: 110, depth: 40, x: 0, y: 30, z: 0 },
            { shape: 'box', width: 92, height: 12, depth: 92, x: 0, y: 2, z: 0 },
            { shape: 'box', width: 140, height: 20, depth: 140, x: 0, y: -12, z: 0 }
          ];
          break;
        }

        if (factionId === 'scrapper') {
          /* Sill Breakers: not designed, accumulated. Two pressure hulls that
             came off different ships, bolted either side of a mast somebody
             else built, patched with plate that does not match, and ringed with
             the debris it has not got round to cutting up. The only symmetry
             on it is accidental, which is the point — every other station here
             is symmetrical, and that is what makes this one read as salvage. */
          trussMast(0, 0, 0, 96, 7.5, 'y');
          push(new THREE.Mesh(geo('sc-spine', () => new THREE.BoxGeometry(6.5, 74, 6.5)), body), 0, 2, 0);
          push(new THREE.Mesh(geo('sc-core', () => new THREE.CylinderGeometry(7.5, 9, 22, 10)), lit), 0, 6, 0);
          push(new THREE.Mesh(geo('sc-collar', () => new THREE.TorusGeometry(9.2, 1.1, 6, 14)), band), 0, 16, 0, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('sc-nose', () => new THREE.ConeGeometry(4.2, 12, 8)), panel), 0, -44, 0, Math.PI, 0, 0);
          push(new THREE.Mesh(geo('sc-mast', () => new THREE.ConeGeometry(0.7, 22, 5)), dark), 0, 58, 0);

          // two mismatched pressure hulls, deliberately at different heights
          for (const sx of [1, -1]) {
            const hy = sx > 0 ? 22 : 18, hr = sx > 0 ? 11.5 : 10.2;
            push(new THREE.Mesh(geo('sc-hull' + sx, () => new THREE.SphereGeometry(hr, 12, 9)), sx > 0 ? lit : body), sx * 21, hy, 0);
            push(new THREE.Mesh(geo('sc-hullcap' + sx, () => new THREE.CylinderGeometry(hr * 0.5, hr * 0.62, 5, 10)), panel), sx * 31, hy, 0, 0, 0, Math.PI / 2);
            push(new THREE.Mesh(geo('sc-strut', () => new THREE.BoxGeometry(14, 2.2, 2.2)), band), sx * 12, hy, 0);
            // patchwork: plates of whatever was to hand, on the side you see
            for (let i = 0; i < 7; i++) {
              const a = (i / 7) * Math.PI * 1.6 - 0.6;
              const pw = 3.4 + (i % 3) * 1.8, ph = 3.0 + (i % 2) * 2.0;
              push(new THREE.Mesh(geo('sc-patch' + i, () => new THREE.BoxGeometry(pw, ph, 0.5)),
                i % 3 === 0 ? panel : (i % 3 === 1 ? dark : band)),
                sx * 21 + Math.cos(a) * hr * 0.82, hy + Math.sin(a) * hr * 0.6, hr * 0.80, 0, 0, a * 0.4);
            }
            // green windows — lit from inside, and the only clean thing on it
            for (let i = 0; i < 5; i++) {
              push(new THREE.Mesh(geo('sc-win', () => new THREE.BoxGeometry(2.0, 1.4, 0.4)), flame),
                sx * 21 - 5 + i * 2.6, hy - 4.4, hr * 0.86);
            }
          }

          /* The crane, only on one side, because there is only one crane. Built
             the first time as a jib floating near a base it never touched —
             a tower has to physically reach the thing it carries or the eye
             refuses the whole assembly. Mast, pivot, jib, cable, load, each
             starting where the last one ended. */
          const cbx = -22, cby = 28;
          push(new THREE.Mesh(geo('sc-cbase', () => new THREE.BoxGeometry(6, 5, 6)), panel), cbx, cby, 0);
          trussMast(cbx, cby + 9, 0, 16, 3.4, 'y');
          push(new THREE.Mesh(geo('sc-cpiv', () => new THREE.CylinderGeometry(2.2, 2.6, 2.6, 8)), dark), cbx, cby + 18, 0);
          const jibLen = 30, jibA = 0.40;
          const jcx = cbx - Math.cos(jibA) * jibLen / 2, jcy = cby + 18 + Math.sin(jibA) * jibLen / 2;
          push(new THREE.Mesh(geo('sc-cjib', () => new THREE.BoxGeometry(jibLen, 1.7, 1.7)), band), jcx, jcy, 0, 0, 0, -jibA);
          push(new THREE.Mesh(geo('sc-cjib2', () => new THREE.BoxGeometry(jibLen, 1.2, 1.2)), band), jcx, jcy - 2.2, 0, 0, 0, -jibA);
          for (let i = 1; i < 6; i++) {
            const f = -jibLen / 2 + (jibLen / 6) * i;
            push(new THREE.Mesh(geo('sc-cbr', () => new THREE.BoxGeometry(0.7, 2.6, 0.7)), dark),
              jcx + Math.cos(jibA) * f, jcy - Math.sin(jibA) * f - 1.1, 0, 0, 0, -jibA);
          }
          push(new THREE.Mesh(geo('sc-ccab', () => new THREE.BoxGeometry(3.6, 3.2, 3.6)), lit), cbx - 3.5, cby + 15.5, 0);
          const tipX = cbx - Math.cos(jibA) * jibLen, tipY = cby + 18 + Math.sin(jibA) * jibLen;
          push(new THREE.Mesh(geo('sc-cable', () => new THREE.CylinderGeometry(0.18, 0.18, 15, 4)), dark), tipX, tipY - 7.5, 0);
          push(new THREE.Mesh(geo('sc-hook', () => new THREE.BoxGeometry(2.2, 1.2, 2.2)), band), tipX, tipY - 15.4, 0);
          push(new THREE.Mesh(geo('sc-load', () => new THREE.BoxGeometry(6.0, 4.8, 6.0)), panel), tipX, tipY - 18.6, 0);

          // storage tanks clamped wherever they fitted
          tankModule(9, -14, 6, 3.4, 15, 'y', lit);
          tankModule(-8, -20, -5, 3.0, 12, 'y', panel);
          tankModule(7, -30, -7, 2.6, 10, 'y', lit);

          // the debris ring: what has not been cut up yet, still on its tethers
          for (let ring = 0; ring < 2; ring++) {
            const rr = 46 + ring * 9, ry = ring ? -12 : 4, tilt = ring ? 0.22 : -0.16;
            push(new THREE.Mesh(geo('sc-teth' + ring, () => new THREE.TorusGeometry(rr, 0.42, 4, 40)), band), 0, ry, 0, Math.PI / 2 + tilt, 0, 0);
            const n = 15 + ring * 3;
            for (let i = 0; i < n; i++) {
              const t = (i / n) * Math.PI * 2 + ring;
              const w = 1.6 + ((i * 7) % 5) * 0.9;
              push(new THREE.Mesh(geo('sc-junk' + (i % 5), () => new THREE.BoxGeometry(w, w * 0.7, w * 1.3)),
                i % 4 === 0 ? band : (i % 3 === 0 ? lit : panel)),
                Math.cos(t) * rr, ry + Math.sin(t) * rr * Math.sin(tilt), Math.sin(t) * rr * Math.cos(tilt),
                i, t, i * 0.7);
            }
          }
          collision = [
            { shape: 'box', width: 16, height: 100, depth: 16 },
            { shape: 'box', width: 66, height: 26, depth: 26, x: 0, y: 20, z: 0 }
          ];
          break;
        }

        // anything else: the ring this started as
        push(new THREE.Mesh(geo('st-core', () => new THREE.CylinderGeometry(13, 13, 34, 12)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('st-ring', () => new THREE.TorusGeometry(40, 4.4, 8, 24)), lit), 0, 0, 0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('st-ringlip', () => new THREE.TorusGeometry(40, 0.7, 6, 24)), band), 0, 4.6, 0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('st-cap', () => new THREE.CylinderGeometry(7, 13, 9, 12)), panel), 0, 20, 0);
        push(new THREE.Mesh(geo('st-cap2', () => new THREE.CylinderGeometry(13, 7, 9, 12)), panel), 0, -20, 0);
        push(new THREE.Mesh(geo('st-gold', () => new THREE.TorusGeometry(13.2, 0.55, 6, 16)), band), 0, 15, 0, Math.PI / 2, 0, 0);
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2;
          push(new THREE.Mesh(geo('st-spoke', () => new THREE.BoxGeometry(2.4, 2.4, 28)), lit),
            Math.cos(a) * 26, 0, Math.sin(a) * 26, 0, -a, 0);
        }
        push(new THREE.Mesh(geo('st-lamp', () => new THREE.TorusGeometry(13.4, 0.9, 6, 16)), trim), 0, 9, 0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('st-lamp', () => new THREE.TorusGeometry(13.4, 0.9, 6, 16)), trim), 0, -9, 0, Math.PI / 2, 0, 0);
        collision = [
          { shape: 'box', width: 26, height: 44, depth: 26 },
          { shape: 'box', width: 88, height: 9, depth: 9 },
          { shape: 'box', width: 9, height: 9, depth: 88 }
        ];
        break;
      }

      default: {
        push(new THREE.Mesh(geo('unk', () => new THREE.BoxGeometry(4, 4, 8)), body), 0, 0, 0);
        collision = [{ shape: 'box', width: 4, height: 4, depth: 8 }];
        break;
      }
    }
    return { parts, collision };
  }

  /* ---- Baking ---------------------------------------------------------
   *
   * buildHull() returns twenty-odd little meshes, which is a pleasant way to
   * author a ship and a bad way to draw one: every mesh is its own draw call,
   * and a sector with six ships on screen was spending more draws on hulls
   * than on the ten-thousand-rock belt.
   *
   * So the parts are authored, then immediately collapsed. Each part's
   * transform is baked into its vertices, its material's colour is baked into
   * a per-vertex colour, and everything lands in ONE geometry with two groups:
   * the surfaces that take the light, and the surfaces that ARE light. Two
   * draw calls per ship, whatever it is made of.
   *
   * The result is cached per class and faction, because every Vanguard
   * interceptor is the same bytes, and shared by every ship that matches.
   * Authoring stays readable; the renderer sees one object.
   */
  const bakeCache = Object.create(null);
  const UV_TILE = 6.5;          // world metres per tile of the detail map
  let sharedRenderer = null;    // needed once, to pre-filter the environment

  // Materials that emit rather than reflect. These are the engine core, the
  // hot centre, the drive rim and the faction trim — the parts that should
  // stay bright when the hull they sit on is facing away from the sun.
  function isGlow(m) {
    return m.isMeshBasicMaterial === true ||
      (m.emissive && m.emissiveIntensity >= 0.5 && m.emissive.getHex() !== 0);
  }

  function bakeHull(clsId, factionId) {
    const key = clsId + ':' + factionId;
    if (bakeCache[key]) return bakeCache[key];

    const built = buildHull(clsId, factionId);
    const lit = { pos: [], nrm: [], col: [], uv: [] };
    const glow = { pos: [], nrm: [], col: [], uv: [] };
    const _c = new THREE.Color();

    for (const mesh of built.parts) {
      mesh.updateMatrix();
      // Never mutate a cached geometry: toNonIndexed and clone both hand back
      // a copy, and the copy is what gets the transform applied.
      const src = mesh.geometry;
      const g = src.index ? src.toNonIndexed() : src.clone();
      g.applyMatrix4(mesh.matrix);

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const total = g.attributes.position.count;
      const groups = (g.groups && g.groups.length) ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
      const P = g.attributes.position.array, N = g.attributes.normal.array;

      for (const grp of groups) {
        const m = mats[grp.materialIndex] || mats[0];
        const sink = isGlow(m) ? glow : lit;
        // material.color is already in the renderer's working space, so it can
        // be copied into a vertex colour as-is. Emissive is folded in here
        // because a single shared material cannot carry a per-part emissive.
        _c.copy(m.color);
        if (m.emissive && m.emissiveIntensity) {
          _c.r = Math.min(1, _c.r + m.emissive.r * m.emissiveIntensity);
          _c.g = Math.min(1, _c.g + m.emissive.g * m.emissiveIntensity);
          _c.b = Math.min(1, _c.b + m.emissive.b * m.emissiveIntensity);
        }
        const end = Math.min(grp.start + (grp.count === Infinity ? total : grp.count), total);
        for (let v = grp.start; v < end; v++) {
          const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
          const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
          sink.pos.push(px, py, pz);
          sink.nrm.push(nx, ny, nz);
          sink.col.push(_c.r, _c.g, _c.b);
          /* Texture coordinates are thrown away and re-projected from world
             space, not carried over from the primitive.
             A box's own UVs map every face to 0..1, so a 54-metre hull plate
             and a 1-metre collar would get the same number of panel lines —
             one stretched to nothing, the other a moire. Projecting along
             whichever axis the surface faces gives every square metre of the
             ship the same density of detail, which is the only way a shared
             tiling map works across parts that differ by fifty times in size.
             The seams where the dominant axis flips are invisible on a texture
             that is mostly grime and panel edges. */
          const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
          let u, vv;
          if (ay >= ax && ay >= az) { u = px; vv = pz; }
          else if (ax >= az) { u = pz; vv = py; }
          else { u = px; vv = py; }
          sink.uv.push(u / UV_TILE, vv / UV_TILE);
        }
      }
      g.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(lit.pos.length + glow.pos.length);
    const nrm = new Float32Array(pos.length);
    const col = new Float32Array(pos.length);
    const uvs = new Float32Array((lit.uv.length + glow.uv.length));
    pos.set(lit.pos, 0); pos.set(glow.pos, lit.pos.length);
    nrm.set(lit.nrm, 0); nrm.set(glow.nrm, lit.nrm.length);
    col.set(lit.col, 0); col.set(glow.col, lit.col.length);
    uvs.set(lit.uv, 0); uvs.set(glow.uv, lit.uv.length);
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const litVerts = lit.pos.length / 3, glowVerts = glow.pos.length / 3;
    if (litVerts) geometry.addGroup(0, litVerts, 0);
    if (glowVerts) geometry.addGroup(litVerts, glowVerts, 1);
    geometry.computeBoundingSphere();

    if (!matCache.__litVC) {
      /* Standard, not Lambert, and the reason is metalness. The reference art
         reads as painted metal: it has a specular response and it picks up the
         environment. Lambert has neither, so every hull came out as flat
         poster paint no matter what colour it was.
         envMap is not optional here — a metal surface with nothing to reflect
         renders black, which is correct physics and a useless picture. */
      matCache.__litVC = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: SE.Detail.hullDetail(),
        // Metalness was 0.68 to begin with, and every face the key light did
        // not reach went black — a metal surface shows you its environment and
        // nothing else, and the environment here is mostly empty space. Half
        // metal with a stronger environment keeps the specular without losing
        // the unlit side of every hull.
        metalness: 0.45,
        roughness: 0.50,
        envMap: SE.Detail.environment(sharedRenderer),
        envMapIntensity: 1.40
      });
    }
    if (!matCache.__glowVC) matCache.__glowVC = new THREE.MeshBasicMaterial({ vertexColors: true });

    bakeCache[key] = { geometry, materials: [matCache.__litVC, matCache.__glowVC], collision: built.collision };
    return bakeCache[key];
  }

  /* ---- attach / detach ------------------------------------------------ */

  function ShipPhysicsView(third, E, ship) {
    THREE = E.THREE;
    SE.Detail.init(THREE);
    sharedRenderer = third.renderer;
    const cls = SE.CLASSES[ship.cls];

    const obj = new E.ExtendedObject3D();
    obj.name = ship.id;
    const hull = bakeHull(cls.id, ship.faction);
    obj.add(new THREE.Mesh(hull.geometry, hull.materials));

    // The state is the authority at exactly this moment, and not again until
    // detach.
    obj.position.set(ship.x, ship.y, ship.z);
    obj.quaternion.set(ship.qx, ship.qy, ship.qz, ship.qw);
    third.add.existing(obj);

    const isStructure = cls.tier === 'structure';
    third.physics.add.existing(obj, {
      mass: isStructure ? 0 : cls.mass,
      collisionFlags: isStructure ? 1 : 0,       // 1 = static
      shape: hull.collision.length > 1 ? 'box' : 'box',
      compound: hull.collision.length > 1 ? hull.collision : [],
      width: hull.collision[0].width,
      height: hull.collision[0].height,
      depth: hull.collision[0].depth
    });

    const body = obj.body;
    if (body) {
      // Space: no gravity anywhere, and near-zero drag. The AI's own retro
      // burn and top-speed bleed do all the slowing down, so that a ship at
      // full throttle with the stick let go keeps its velocity like a ship in
      // a vacuum rather than gliding to a stop like a boat.
      body.setGravity(0, 0, 0);
      body.setDamping(0.02, 0.62);
      if (!isStructure) {
        body.setVelocity(ship.vx, ship.vy, ship.vz);
        // Ammo parks a body that has been nearly still for two seconds. A
        // docked wingman waiting for an order is exactly that, and a parked
        // body ignores the force that would wake it up.
        if (body.ammo && body.ammo.setActivationState) body.ammo.setActivationState(4);
      }
    }

    return {
      ship, obj, body,
      isStructure,

      /* Physics -> state. Called once per frame for every ship in the sector,
         so it reads the body's cached transform rather than asking Ammo. */
      pull() {
        const p = obj.position, q = obj.quaternion;
        ship.x = p.x; ship.y = p.y; ship.z = p.z;
        ship.qx = q.x; ship.qy = q.y; ship.qz = q.z; ship.qw = q.w;
        if (body && !isStructure) {
          const v = body.velocity;
          ship.vx = v.x; ship.vy = v.y; ship.vz = v.z;
        }
      },

      destroy() {
        // Order matters: the rigid body has to leave the world before the mesh
        // leaves the scene, or Ammo keeps stepping a body whose transform
        // nothing reads and the leak is invisible until the fourth sector.
        if (obj.body) third.physics.destroy(obj);
        third.scene.remove(obj);
        // Geometry and materials are shared per class and deliberately NOT
        // disposed here — the next ship of this class wants them.
        obj.clear();
      }
    };
  }

  /* Teleporting a rigid body.
   *
   * Setting obj.position and raising body.needUpdate looks like it should do
   * this, and for a KINEMATIC body it does — but enable3d only honours
   * needUpdate for kinematic objects, so on a dynamic or static body it is
   * silently ignored and Ammo writes its own stale transform back over yours
   * on the next frame. The symptom is an object that appears where you put it
   * for exactly one frame and then snaps back.
   *
   * The sequence below goes through the motion state directly, which works for
   * any body type: read the current transform into the physics scratch, move
   * it, write it back, then clear the velocities so the body does not carry
   * its old momentum into its new position, and wake it so the solver looks at
   * it at all.
   */
  function placeBody(body, x, y, z, quat) {
    if (!body || !body.ammo) return;
    // transform() fills the physics world's scratch btTransform from this
    // body's motion state; setPosition() moves that scratch's origin.
    body.transform();
    body.setPosition(x, y, z);
    const t = body.physics.worldTransform;
    /* Rotation has to go through the same scratch transform, and it was
       missing here at first: moving a body without also setting its rotation
       leaves Ammo holding the OLD orientation, which it then writes back over
       the mesh on the next frame. The symptom is a ship that teleports to the
       right place pointing the wrong way, one frame after you aimed it. */
    if (quat) {
      const q = body.tmpBtQuaternion;
      q.setValue(quat.x, quat.y, quat.z, quat.w);
      t.setRotation(q);
    }
    // The motion state alone is not enough. Bullet reads it for KINEMATIC
    // bodies and writes it for dynamic ones — a dynamic body's authority is
    // its own world transform, so setting only the motion state moves nothing
    // and the next frame reports the old position straight back. Set both.
    body.ammo.setWorldTransform(t);
    const ms = body.ammo.getMotionState();
    if (ms) ms.setWorldTransform(t);
    if (body.ammo.clearForces) body.ammo.clearForces();
    body.setVelocity(0, 0, 0);
    body.setAngularVelocity(0, 0, 0);
    if (body.ammo.activate) body.ammo.activate();
  }

  SE.ShipPhysicsView = ShipPhysicsView;
  SE.placeBody = placeBody;
  SE.viewMaterial = c => mat(c);
})(window.SE = window.SE || {});
