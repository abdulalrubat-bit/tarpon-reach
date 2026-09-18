/* Surface detail, drawn at boot.
 *
 * The concept art's hulls are covered in plating, panel seams, rivets, wear and
 * lit windows. Flat-shaded primitives have none of that, and it is most of why
 * a low-poly ship reads as a prototype next to a painted one — not the polygon
 * count, the fact that every face is one uncomplicated colour.
 *
 * All of it is generated into a canvas on first use and uploaded once. No image
 * files, which keeps the studio's rule intact, and the whole lot costs about
 * 40ms at boot and a single 512-square texture in memory.
 *
 * The map is near-white with darker seams, because it MULTIPLIES the vertex
 * colour. A ship's colour still comes from its faction palette; this only takes
 * light away in the places a panel line would.
 */
(function (SE) {
  'use strict';

  let THREE = null;
  let detailTex = null;
  let envTex = null;

  function rnd(r) { return r(); }

  /* ---- The hull map ----------------------------------------------------
     Three layers, coarse to fine: big plates, seams within them, then rivets
     and wear. Drawn at 512 and tiled, so the smallest feature is still a pixel
     or two when a ship fills a phone screen. */
  function hullDetail() {
    if (detailTex) return detailTex;
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    const rng = SE.Rng('hull-detail');

    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, S, S);

    // The first version of this was far too polite — plates within 8% of white
    // and hairline seams. Under a metal material with a live environment that
    // is completely invisible: the specular term swamps a 7% albedo variation.
    // Detail meant to survive reflection has to be drawn much harder than
    // detail meant to be looked at flat.

    // Plates. A recursive split rather than a grid: a regular grid reads as
    // graph paper, and no hull anybody has ever built is panelled regularly.
    const plates = [];
    (function split(px, py, pw, ph, depth) {
      if (depth <= 0 || pw < 44 || ph < 44) { plates.push([px, py, pw, ph]); return; }
      const vertical = pw > ph ? rng.chance(0.78) : rng.chance(0.22);
      const t = rng.float(0.34, 0.66);
      if (vertical) {
        const w = Math.round(pw * t);
        split(px, py, w, ph, depth - 1);
        split(px + w, py, pw - w, ph, depth - 1);
      } else {
        const h = Math.round(ph * t);
        split(px, py, pw, h, depth - 1);
        split(px, py + h, pw, ph - h, depth - 1);
      }
    })(0, 0, S, S, 4);

    // Each plate a shade off its neighbours, so the eye reads separate sheets
    // of metal rather than one painted surface.
    plates.forEach(([px, py, pw, ph]) => {
      const v = 188 + Math.round(rng.float(0, 67));
      x.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      x.fillRect(px, py, pw, ph);
      x.strokeStyle = 'rgba(28,31,38,0.92)';
      x.lineWidth = 1.6;
      x.strokeRect(px + 0.8, py + 0.8, pw - 1.6, ph - 1.6);
      // a lighter lip on two sides reads as a raised edge under any light
      x.strokeStyle = 'rgba(255,255,255,0.9)';
      x.beginPath();
      x.moveTo(px + 1.5, py + ph - 1.5); x.lineTo(px + 1.5, py + 1.5); x.lineTo(px + pw - 1.5, py + 1.5);
      x.stroke();
    });

    // Seams inside the larger plates.
    plates.forEach(([px, py, pw, ph]) => {
      if (pw < 70 && ph < 70) return;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        x.strokeStyle = 'rgba(44,48,58,0.7)';
        x.lineWidth = 1.2;
        x.beginPath();
        if (pw > ph) { const lx = px + rng.float(0.2, 0.8) * pw; x.moveTo(lx, py + 3); x.lineTo(lx, py + ph - 3); }
        else { const ly = py + rng.float(0.2, 0.8) * ph; x.moveTo(px + 3, ly); x.lineTo(px + pw - 3, ly); }
        x.stroke();
      }
    });

    // Rivets, run along plate edges rather than scattered.
    plates.forEach(([px, py, pw, ph]) => {
      if (!rng.chance(0.55)) return;
      const along = pw > ph;
      const count = Math.floor((along ? pw : ph) / 13);
      for (let i = 1; i < count; i++) {
        const t = i / count;
        const rx = along ? px + t * pw : px + rng.pick([4, pw - 4]);
        const ry = along ? py + rng.pick([4, ph - 4]) : py + t * ph;
        x.fillStyle = 'rgba(40,44,54,0.8)';
        x.beginPath(); x.arc(rx, ry, 1.5, 0, 6.283); x.fill();
      }
    });

    // Wear: a scatter of soft dark blots, heavier near seams. Keeps large flat
    // areas from looking vacuum-formed.
    for (let i = 0; i < 1200; i++) {
      const wx = rng.float(0, S), wy = rng.float(0, S), r = rng.float(0.8, 7);
      const g = x.createRadialGradient(wx, wy, 0, wx, wy, r);
      const a = rng.float(0.05, 0.22);
      g.addColorStop(0, 'rgba(58,62,72,' + a + ')');
      g.addColorStop(1, 'rgba(58,62,72,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(wx, wy, r, 0, 6.283); x.fill();
    }

    detailTex = new THREE.CanvasTexture(c);
    detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
    detailTex.anisotropy = 4;
    detailTex.colorSpace = THREE.SRGBColorSpace;
    return detailTex;
  }

  /* ---- The environment -------------------------------------------------
     Metal only reads as metal when it has something to reflect. There is no
     skybox here worth reflecting, so one is drawn: a dark floor, a cold blue
     upper field, and one hot spot where the key light is. Run through PMREM so
     roughness actually blurs it.

     Without this, a metalness of 0.7 makes everything BLACK — a mirror in an
     empty room is a black object, which is the correct physics and the wrong
     picture. */
  function environment(renderer) {
    if (envTex) return envTex;
    const W = 256, H = 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, '#9fb4d4');
    g.addColorStop(0.42, '#3d4a68');
    g.addColorStop(0.55, '#171c2b');
    g.addColorStop(1.00, '#090c14');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    // the key, warm and high on the left, matching the scene's directional
    const kx = W * 0.30, ky = H * 0.26;
    const k = x.createRadialGradient(kx, ky, 0, kx, ky, W * 0.20);
    k.addColorStop(0, 'rgba(255,246,232,0.95)');
    k.addColorStop(1, 'rgba(255,246,232,0)');
    x.fillStyle = k; x.beginPath(); x.arc(kx, ky, W * 0.20, 0, 6.283); x.fill();
    // a cold fill opposite it, so unlit sides pick up something
    const bx = W * 0.78, by = H * 0.44;
    const b = x.createRadialGradient(bx, by, 0, bx, by, W * 0.22);
    b.addColorStop(0, 'rgba(74,125,255,0.5)');
    b.addColorStop(1, 'rgba(74,125,255,0)');
    x.fillStyle = b; x.beginPath(); x.arc(bx, by, W * 0.22, 0, 6.283); x.fill();

    const src = new THREE.CanvasTexture(c);
    src.mapping = THREE.EquirectangularReflectionMapping;
    src.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    envTex = pmrem.fromEquirectangular(src).texture;
    pmrem.dispose();
    src.dispose();
    return envTex;
  }

  SE.Detail = {
    init(three) { THREE = three; },
    hullDetail,
    environment,
    dispose() {
      if (detailTex) { detailTex.dispose(); detailTex = null; }
      if (envTex) { envTex.dispose(); envTex = null; }
    }
  };
})(window.SE = window.SE || {});
