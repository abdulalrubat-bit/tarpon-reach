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

  /* ---- The palette ----------------------------------------------------
     Sampled off the concept art rather than guessed, which is why these are
     odd numbers instead of round ones. The hull clusters around hsl(230, 40%,
     18%) — a navy so dark it reads as black anywhere the key light is not —
     the edges are a near-white with a violet cast, and the engines run a
     blue-violet rim into a magenta-pink core.

     The important property is that the HULL carries no faction information at
     all. Every ship in the game is this navy; what tells you whose it is, is
     the trim, and the trim is the one colour taken from the faction table. So
     the fleet reads as one design language and still identifies at a glance,
     which is the thing a per-faction hull colour gets wrong in both directions
     at once. */
  const PAL = {
    hull: 0x1a2148,      // the ship, mid-tone
    hullLit: 0x2b3160,   // raised panels catching the key light
    hullDark: 0x0d0f22,  // recesses, intakes, the underside
    edge: 0xe4dced,      // painted panel lines and nose flashes — near-white
    rimLit: 0x5a5880,    // the lit thickness of a wing seen side-on
    gold: 0xba9159,      // spine panel and nacelle bands
    goldDim: 0x78623d,
    flame: 0xf47ac8,     // exhaust core
    flameRim: 0x5a4fe0   // the blue-violet ring around it
  };

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
   * the side walls. Hand it two materials and every wing gets a bright rim
   * around its whole outline at no cost, which is exactly what the concept art
   * does with a painted edge highlight and what a box cannot do at all.
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
     Drawn from primitives, no model files. Each returns { parts, collision },
     where collision is the compound box list Ammo gets — always simpler than
     what you can see, because a collision hull that matches the silhouette
     exactly is a collision hull that costs four times as much and plays worse.
  */
  function buildHull(clsId, colour) {
    const body = mat(PAL.hull);
    const lit = mat(PAL.hullLit);
    const dark = mat(PAL.hullDark);
    // Two different jobs that both look like "edge" in the concept art. A
    // painted flash on a surface facing you is near-white; the THICKNESS of a
    // wing seen side-on is not — it is a lit navy. They were the same material
    // at first, and from a chase camera, which sees mostly trailing edge, the
    // wings came out banded in chrome.
    const edge = mat(PAL.edge, PAL.edge, 0.05);
    const rimLit = mat(PAL.rimLit);
    const gold = mat(PAL.gold, PAL.gold, 0.22);
    const trim = mat(colour, colour, 0.62);
    const flame = glowMat(PAL.flame);
    const flameHot = glowMat(0xffd8f2);
    const rim = mat(PAL.flameRim, PAL.flameRim, 0.85);
    const parts = [];
    let collision;

    const push = (m, x, y, z, rx, ry, rz) => {
      m.position.set(x, y, z);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      parts.push(m);
      return m;
    };

    // An engine: a recessed bell, a blue-violet rim and a magenta core. Three
    // cheap pieces, and between them they do the one thing the concept art's
    // engines do, which is look hot in the middle and cold at the edge.
    const engine = (x, y, z, r) => {
      push(new THREE.Mesh(geo('eng-bell' + r, () => new THREE.CylinderGeometry(r, r * 1.16, r * 1.5, 10)), dark),
        x, y, z, Math.PI / 2, 0, 0);
      push(new THREE.Mesh(geo('eng-rim' + r, () => new THREE.TorusGeometry(r * 0.86, r * 0.20, 6, 12)), rim),
        x, y, z + r * 0.72);
      // CircleGeometry faces +Z, which is already astern — where the chase
      // camera lives. Rotating it to "face out" turned it away and let
      // backface culling render the drives as two black holes.
      push(new THREE.Mesh(geo('eng-core' + r, () => new THREE.CircleGeometry(r * 0.80, 14)), flame),
        x, y, z + r * 0.78);
      push(new THREE.Mesh(geo('eng-hot' + r, () => new THREE.CircleGeometry(r * 0.42, 12)), flameHot),
        x, y, z + r * 0.82);
    };

    switch (clsId) {

      /* The corvette is the ship in the concept art, so it is the one that
         defines the language every other hull then borrows: a narrow spine
         with a sharp nose, delta wings swept hard back to a point, twin
         nacelles slung below and behind, gold banding, and a pair of thin
         forward masts. */
      case 'corvette': {
        /* Anhedral, and it is not decoration. The chase camera sits about
           sixteen degrees above the ship, and a flat wing at sixteen degrees
           is very nearly edge-on — all trailing edge and no planform. Drooping
           the tips turns the wing back toward the camera so the swept shape
           is actually visible in play, and it happens to be what the concept
           art does anyway. */
        const WING = [[0.55, -2.4], [5.2, 3.2], [4.2, 3.9], [0.55, 2.4]];
        const DROOP = 0.24;
        push(new THREE.Mesh(planform('c-wing', WING, 0.18, false), [body, rimLit]), 0, 0.02, 0.2, 0, 0, DROOP);
        push(new THREE.Mesh(planform('c-wing', WING, 0.18, true), [body, rimLit]), 0, 0.02, 0.2, 0, 0, -DROOP);
        // A chevron painted ON the skin, so it has to be thin and sit just
        // proud of it — at any real thickness it reads as a slab bolted on.
        const STRAKE = [[0.85, -1.8], [3.6, 1.4], [3.0, 2.0], [0.85, -0.9]];
        push(new THREE.Mesh(planform('c-strake', STRAKE, 0.10, false), [trim, trim]), 0, 0.19, 0.2, 0, 0, DROOP);
        push(new THREE.Mesh(planform('c-strake', STRAKE, 0.10, true), [trim, trim]), 0, 0.19, 0.2, 0, 0, -DROOP);

        push(new THREE.Mesh(geo('c-spine', () => new THREE.BoxGeometry(1.5, 1.25, 9.4)), body), 0, 0.12, -0.3);
        push(new THREE.Mesh(geo('c-dorsal', () => new THREE.BoxGeometry(0.66, 0.5, 7.4)), lit), 0, 0.78, -0.6);
        push(new THREE.Mesh(geo('c-gold', () => new THREE.BoxGeometry(0.24, 0.16, 5.2)), gold), 0, 1.02, -0.4);
        push(new THREE.Mesh(geo('c-nose', () => new THREE.ConeGeometry(0.78, 3.6, 6)), body), 0, 0.10, -6.6, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('c-nosetip', () => new THREE.ConeGeometry(0.30, 1.1, 6)), edge), 0, 0.10, -8.0, -Math.PI / 2, 0, 0);

        // forward masts — the thin vertical rods on the art
        push(new THREE.Mesh(geo('c-mast', () => new THREE.CylinderGeometry(0.075, 0.11, 3.0, 5)), dark), 1.18, 1.1, -2.6);
        push(new THREE.Mesh(geo('c-mast', () => new THREE.CylinderGeometry(0.075, 0.11, 3.0, 5)), dark), -1.18, 1.1, -2.6);

        // nacelles, slung low and aft, banded in gold
        for (const sx of [1, -1]) {
          push(new THREE.Mesh(geo('c-nac', () => new THREE.CylinderGeometry(0.66, 0.74, 6.2, 10)), lit),
            sx * 1.32, -0.42, 2.2, Math.PI / 2, 0, 0);
          push(new THREE.Mesh(geo('c-band', () => new THREE.TorusGeometry(0.73, 0.10, 6, 12)), gold), sx * 1.32, -0.42, 1.1);
          push(new THREE.Mesh(geo('c-band', () => new THREE.TorusGeometry(0.73, 0.10, 6, 12)), gold), sx * 1.32, -0.42, 3.0);
          engine(sx * 1.32, -0.42, 5.3, 0.66);
        }
        collision = [
          { shape: 'box', width: 3.4, height: 2.6, depth: 13 },
          { shape: 'box', width: 10.6, height: 0.7, depth: 6.4, x: 0, y: -0.05, z: 0.8 }
        ];
        break;
      }

      /* The interceptor is the corvette's language at three-quarter scale with
         everything sharpened: more sweep, one nacelle, no masts. */
      case 'interceptor': {
        const WING = [[0.4, -1.6], [3.9, 2.1], [3.1, 2.7], [0.4, 1.7]];
        const IDROOP = 0.28;
        push(new THREE.Mesh(planform('i-wing', WING, 0.14, false), [body, rimLit]), 0, 0.02, 0.3, 0, 0, IDROOP);
        push(new THREE.Mesh(planform('i-wing', WING, 0.14, true), [body, rimLit]), 0, 0.02, 0.3, 0, 0, -IDROOP);
        const ISTRAKE = [[0.6, -1.2], [2.6, 1.1], [2.2, 1.6], [0.6, -0.5]];
        push(new THREE.Mesh(planform('i-strake', ISTRAKE, 0.08, false), [trim, trim]), 0, 0.14, 0.3, 0, 0, IDROOP);
        push(new THREE.Mesh(planform('i-strake', ISTRAKE, 0.08, true), [trim, trim]), 0, 0.14, 0.3, 0, 0, -IDROOP);
        push(new THREE.Mesh(geo('i-spine', () => new THREE.BoxGeometry(0.95, 0.85, 6.0)), body), 0, 0.08, 0);
        push(new THREE.Mesh(geo('i-nose', () => new THREE.ConeGeometry(0.50, 2.6, 6)), body), 0, 0.08, -4.2, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('i-tip', () => new THREE.ConeGeometry(0.19, 0.8, 6)), edge), 0, 0.08, -5.2, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('i-fin', () => new THREE.BoxGeometry(0.16, 1.25, 1.5)), trim), 0, 0.85, 1.6);
        push(new THREE.Mesh(geo('i-gold', () => new THREE.BoxGeometry(0.18, 0.12, 3.0)), gold), 0, 0.53, -0.4);
        push(new THREE.Mesh(geo('i-nac', () => new THREE.CylinderGeometry(0.46, 0.52, 3.4, 8)), lit), 0, -0.26, 2.0, Math.PI / 2, 0, 0);
        engine(0, -0.26, 3.9, 0.46);
        collision = [{ shape: 'box', width: 7.8, height: 1.8, depth: 8.4 }];
        break;
      }

      /* The working hulls are the same palette with none of the grace: slab
         sides, visible framing, and the wings cut down to stubs that exist to
         carry the nacelles rather than to turn. */
      case 'extractor': {
        push(new THREE.Mesh(geo('e-body', () => new THREE.BoxGeometry(6.0, 4.8, 12.0)), body), 0, 0, 1.4);
        push(new THREE.Mesh(geo('e-shoulder', () => new THREE.BoxGeometry(6.4, 0.5, 9.0)), lit), 0, 2.3, 1.0);
        push(new THREE.Mesh(geo('e-gold', () => new THREE.BoxGeometry(5.2, 0.2, 0.5)), gold), 0, 2.58, -2.6);
        push(new THREE.Mesh(geo('e-drill', () => new THREE.ConeGeometry(2.0, 5.4, 8)), dark), 0, 0, -7.2, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('e-ring', () => new THREE.TorusGeometry(2.3, 0.40, 6, 12)), trim), 0, 0, -4.5);
        push(new THREE.Mesh(geo('e-hold', () => new THREE.BoxGeometry(4.2, 3.2, 4.4)), lit), 0, 0.2, 6.0);
        push(new THREE.Mesh(geo('e-rib', () => new THREE.BoxGeometry(6.3, 0.22, 0.35)), edge), 0, 1.7, 4.2);
        push(new THREE.Mesh(geo('e-rib', () => new THREE.BoxGeometry(6.3, 0.22, 0.35)), edge), 0, 1.7, 6.6);
        for (const sx of [1, -1]) engine(sx * 2.05, -0.3, 8.6, 1.02);
        collision = [{ shape: 'box', width: 6.6, height: 5.2, depth: 20 }];
        break;
      }

      case 'freighter': {
        push(new THREE.Mesh(geo('f-spine', () => new THREE.BoxGeometry(3.0, 3.0, 22)), dark), 0, 0, 0);
        push(new THREE.Mesh(geo('f-cab', () => new THREE.BoxGeometry(5.0, 4.0, 5.2)), body), 0, 0.6, -10.2);
        push(new THREE.Mesh(geo('f-brow', () => new THREE.BoxGeometry(4.4, 0.3, 0.5)), edge), 0, 2.2, -12.4);
        push(new THREE.Mesh(geo('f-gold', () => new THREE.BoxGeometry(3.6, 0.18, 0.42)), gold), 0, 2.5, -9.6);
        for (let i = 0; i < 3; i++) {
          for (const sx of [1, -1]) {
            push(new THREE.Mesh(geo('f-can', () => new THREE.BoxGeometry(4.0, 4.0, 4.4)), body), sx * 3.7, 0, -1.6 + i * 5.1);
            push(new THREE.Mesh(geo('f-canrib', () => new THREE.BoxGeometry(4.15, 0.18, 0.3)), lit), sx * 3.7, 1.6, -1.6 + i * 5.1);
          }
        }
        push(new THREE.Mesh(geo('f-strip', () => new THREE.BoxGeometry(0.45, 0.26, 19)), trim), 0, 1.7, 0);
        for (const sx of [1, -1]) engine(sx * 1.5, 0, 11.6, 1.28);
        collision = [{ shape: 'box', width: 11.8, height: 4.6, depth: 24 }];
        break;
      }

      /* A capital hull is the corvette's shapes at a scale where they stop
         being elegant: the same prow, the same banding, five times the slab. */
      case 'dreadnought': {
        push(new THREE.Mesh(geo('d-spine', () => new THREE.BoxGeometry(10.4, 6.6, 54)), body), 0, 0, 0);
        push(new THREE.Mesh(geo('d-deck', () => new THREE.BoxGeometry(11.0, 0.6, 44)), lit), 0, 3.4, 2);
        push(new THREE.Mesh(geo('d-gold', () => new THREE.BoxGeometry(9.0, 0.24, 0.7)), gold), 0, 3.8, -16);
        push(new THREE.Mesh(geo('d-gold', () => new THREE.BoxGeometry(9.0, 0.24, 0.7)), gold), 0, 3.8, 18);
        push(new THREE.Mesh(geo('d-prow', () => new THREE.ConeGeometry(5.2, 14, 6)), body), 0, 0, -32, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-prowtip', () => new THREE.ConeGeometry(1.7, 4.4, 6)), edge), 0, 0, -40.2, -Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('d-bridge', () => new THREE.BoxGeometry(6.6, 4.8, 11.6)), lit), 0, 5.6, 12);
        push(new THREE.Mesh(geo('d-brow', () => new THREE.BoxGeometry(6.9, 0.34, 0.6)), edge), 0, 7.6, 6.4);
        const SPON = [[3.0, -10], [9.6, 2.0], [8.4, 5.0], [3.0, 5.0]];
        push(new THREE.Mesh(planform('d-spon', SPON, 3.6, false), [body, rimLit]), 0, -0.9, -2);
        push(new THREE.Mesh(planform('d-spon', SPON, 3.6, true), [body, rimLit]), 0, -0.9, -2);
        for (let i = 0; i < 4; i++) {
          const sx = i < 2 ? 5.9 : -5.9, sz = (i % 2) ? -12 : 6;
          push(new THREE.Mesh(geo('d-turb', () => new THREE.CylinderGeometry(2.0, 2.3, 1.1, 8)), lit), sx, 3.9, sz);
          push(new THREE.Mesh(geo('d-tur', () => new THREE.CylinderGeometry(1.5, 1.8, 1.7, 8)), trim), sx, 4.9, sz);
        }
        for (const sx of [1, -1]) engine(sx * 3.5, 0, 28.4, 3.0);
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
        push(new THREE.Mesh(geo('st-ringlip', () => new THREE.TorusGeometry(40, 0.7, 6, 24)), edge), 0, 4.6, 0, Math.PI / 2, 0, 0);
        push(new THREE.Mesh(geo('st-cap', () => new THREE.CylinderGeometry(7, 13, 9, 12)), dark), 0, 20, 0);
        push(new THREE.Mesh(geo('st-cap2', () => new THREE.CylinderGeometry(13, 7, 9, 12)), dark), 0, -20, 0);
        push(new THREE.Mesh(geo('st-gold', () => new THREE.TorusGeometry(13.2, 0.55, 6, 16)), gold), 0, 15, 0, Math.PI / 2, 0, 0);
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

  function bakeHull(clsId, colour) {
    const key = clsId + ':' + colour;
    if (bakeCache[key]) return bakeCache[key];

    const built = buildHull(clsId, colour);
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
    const colour = (SE.FACTIONS[ship.faction] || SE.FACTIONS.player).colour;

    const obj = new E.ExtendedObject3D();
    obj.name = ship.id;
    const hull = bakeHull(cls.id, colour);
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
