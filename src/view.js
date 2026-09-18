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
    const P = FACPAL[factionId] || FACPAL.player;
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

        for (const sx of [1, -1]) {
          push(new THREE.Mesh(geo('c-nac', () => new THREE.CylinderGeometry(0.66, 0.74, 6.2, 10)), lit),
            sx * 1.32, -0.42, 2.2, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('c-band', () => new THREE.TorusGeometry(0.73, 0.10, 6, 12)), band), sx * 1.32, -0.42, 1.1);
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
        push(new THREE.Mesh(geo('i-nac', () => new THREE.CylinderGeometry(0.62, 0.68, 2.8, 10)), lit), 0, -0.18, 2.4, Math.PI / 2, 0, 0);
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
      case 'freighter': {
        push(new THREE.Mesh(geo('f-spine', () => new THREE.BoxGeometry(2.6, 2.6, 21)), dark), 0, 0, 0);
        push(new THREE.Mesh(geo('f-cab', () => new THREE.BoxGeometry(4.4, 3.6, 5.0)), body), 0, 0.8, -10.0);
        push(new THREE.Mesh(geo('f-glass', () => new THREE.BoxGeometry(3.4, 0.9, 0.5)), panel), 0, 1.5, -12.4);
        push(new THREE.Mesh(geo('f-brow', () => new THREE.BoxGeometry(4.5, 0.26, 0.5)), edge), 0, 2.5, -11.6);
        for (const sx of [1, -1]) {
          // the pod, on its pylon, stacked in three visible containers
          push(new THREE.Mesh(geo('f-pylon', () => new THREE.BoxGeometry(2.6, 0.8, 8.0)), dark), sx * 2.6, 0.2, 0.4);
          for (let i = 0; i < 3; i++) {
            const z = -3.0 + i * 4.3;
            push(new THREE.Mesh(geo('f-can', () => new THREE.BoxGeometry(3.6, 4.4, 4.0)), body), sx * 4.6, 0.4, z);
            push(new THREE.Mesh(geo('f-canface', () => new THREE.BoxGeometry(0.16, 3.0, 2.6)), panel), sx * 6.42, 0.4, z);
            push(new THREE.Mesh(geo('f-canrib', () => new THREE.BoxGeometry(3.7, 0.22, 0.34)), band), sx * 4.6, 2.5, z);
          }
          engine(sx * 2.2, -0.4, 11.4, 1.24);
        }
        push(new THREE.Mesh(geo('f-strip', () => new THREE.BoxGeometry(0.42, 0.24, 18)), trim), 0, 1.45, 0);
        collision = [{ shape: 'box', width: 14.4, height: 5.2, depth: 24 }];
        break;
      }

      /* A capital hull is the same language at a scale where it stops being
         elegant: layered slabs, a prow you could dock a corvette in, banding
         across the deck, and a whole row of drives instead of a pair. */
      case 'dreadnought': {
        push(new THREE.Mesh(geo('d-spine', () => new THREE.BoxGeometry(10.4, 6.6, 54)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('d-deck', () => new THREE.BoxGeometry(11.0, 0.6, 44)), lit), 0, 3.4, 2);
        push(new THREE.Mesh(geo('d-under', () => new THREE.BoxGeometry(9.0, 1.2, 40)), panel), 0, -3.4, 2);
        hazard(0, 3.8, -16, 9.0, 1.1);
        hazard(0, 3.8, 18, 9.0, 1.1);
        push(new THREE.Mesh(geo('d-prow', () => new THREE.ConeGeometry(5.2, 14, 6)), body), 0, 0, -32, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-prowtip', () => new THREE.ConeGeometry(1.7, 4.4, 6)), edge), 0, 0, -40.2, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-bridge', () => new THREE.BoxGeometry(6.6, 4.8, 11.6)), lit), 0, 5.6, 12);
        push(new THREE.Mesh(geo('d-brow', () => new THREE.BoxGeometry(6.9, 0.34, 0.6)), edge), 0, 7.6, 6.4);
        push(new THREE.Mesh(geo('d-mast', () => new THREE.CylinderGeometry(0.16, 0.24, 7.0, 6)), dark), 0, 11.0, 15);
        const SPON = [[3.0, -10], [9.6, 2.0], [8.4, 5.0], [3.0, 5.0]];
        push(new THREE.Mesh(planform('d-spon', SPON, 3.6, false), [body, rimLit]), 0, -0.9, -2);
        push(new THREE.Mesh(planform('d-spon', SPON, 3.6, true), [body, rimLit]), 0, -0.9, -2);
        for (let i = 0; i < 4; i++) {
          const sx = i < 2 ? 5.9 : -5.9, sz = (i % 2) ? -12 : 6;
          push(new THREE.Mesh(geo('d-turb', () => new THREE.CylinderGeometry(2.0, 2.3, 1.1, 8)), lit), sx, 3.9, sz);
          push(new THREE.Mesh(geo('d-tur', () => new THREE.CylinderGeometry(1.5, 1.8, 1.7, 8)), trim), sx, 4.9, sz);
        }
        // six drives in a row, as on the art's capital
        for (let i = 0; i < 6; i++) {
          const gx = (i - 2.5) * 2.5;
          engine(gx, i % 2 ? 1.1 : -1.3, 28.4, 1.05);
        }
        collision = [
          { shape: 'box', width: 10.4, height: 6.6, depth: 54 },
          { shape: 'box', width: 7.0, height: 4.0, depth: 17, x: 8.0, y: -0.9, z: -2 },
          { shape: 'box', width: 7.0, height: 4.0, depth: 17, x: -8.0, y: -0.9, z: -2 },
          { shape: 'box', width: 6.6, height: 4.8, depth: 11.6, x: 0, y: 5.6, z: 12 },
          { shape: 'box', width: 8, height: 6.6, depth: 12, x: 0, y: 0, z: -32 }
        ];
        break;
      }

      case 'station':
      default: {
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
    const lit = { pos: [], nrm: [], col: [] };
    const glow = { pos: [], nrm: [], col: [] };
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
          sink.pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          sink.nrm.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
          sink.col.push(_c.r, _c.g, _c.b);
        }
      }
      g.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(lit.pos.length + glow.pos.length);
    const nrm = new Float32Array(pos.length);
    const col = new Float32Array(pos.length);
    pos.set(lit.pos, 0); pos.set(glow.pos, lit.pos.length);
    nrm.set(lit.nrm, 0); nrm.set(glow.nrm, lit.nrm.length);
    col.set(lit.col, 0); col.set(glow.col, lit.col.length);
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const litVerts = lit.pos.length / 3, glowVerts = glow.pos.length / 3;
    if (litVerts) geometry.addGroup(0, litVerts, 0);
    if (glowVerts) geometry.addGroup(litVerts, glowVerts, 1);
    geometry.computeBoundingSphere();

    if (!matCache.__litVC) matCache.__litVC = new THREE.MeshLambertMaterial({ vertexColors: true });
    if (!matCache.__glowVC) matCache.__glowVC = new THREE.MeshBasicMaterial({ vertexColors: true });

    bakeCache[key] = { geometry, materials: [matCache.__litVC, matCache.__glowVC], collision: built.collision };
    return bakeCache[key];
  }

  /* ---- attach / detach ------------------------------------------------ */

  function ShipPhysicsView(third, E, ship) {
    THREE = E.THREE;
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
  function placeBody(body, x, y, z) {
    if (!body || !body.ammo) return;
    // transform() fills the physics world's scratch btTransform from this
    // body's motion state; setPosition() moves that scratch's origin.
    body.transform();
    body.setPosition(x, y, z);
    const t = body.physics.worldTransform;
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
