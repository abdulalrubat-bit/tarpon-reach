/* The system view's look: two themes and the scenery art, drawn in code.
 *
 * Operations is a cream blueprint (routes, cargo, what your industry is
 * doing); Tactical is a dark green plot (contacts, threats, escorts). Both
 * draw the same scene, so everything here takes a theme and returns plain
 * canvases that the view turns into textures once.
 *
 * The art is top-down industrial: gunmetal hulls with a dark edge, lit
 * windows, orange running lights, in the style of the reference mockup. It
 * is all canvas paths, so it stays sharp at any zoom and costs nothing to
 * ship in the APK.
 */
(function (SE) {
  'use strict';

  const THEMES = {
    ops: {
      id: 'ops', bg: '#ece5d6', bgEdge: '#ddd3bf', grid: 0x9c8f78, gridA: 0.34, cross: 0x6f6658,
      ink: '#1b1d20', inkHalo: '#ece5d6', sub: '#1f7f72', chipBg: 0x4e5a62, chipInk: '#eef2f3',
      accent: 0xe2601e, accentCss: '#e2601e', ret: 0xb06a42, lane: 0x5a5246, laneA: 0.16,
      marker: 0x1b1d20, warn: '#c93a2a', hostile: 0xd2402e, planet: [0xb3a796, 0xa39b8f, 0x9aa1a3, 0xb7a58c], atmos: false, dust: false
    },
    tactical: {
      id: 'tactical', bg: '#0b1510', bgEdge: '#07100b', grid: 0x2f7a4c, gridA: 0.30, cross: 0x4f9a6c,
      ink: '#e4f2e6', inkHalo: '#08110c', sub: '#b9d7bd', chipBg: 0x1d3a28, chipInk: '#c9f5cf',
      accent: 0x8eea8a, accentCss: '#8eea8a', ret: 0x5fa86a, lane: 0x8eea8a, laneA: 0.12,
      marker: 0xf2c84b, warn: '#ff5a48', hostile: 0xff4a3a, planet: [0xb09f8c, 0x9c948a, 0x8e979c, 0xa89880], atmos: true, dust: true
    }
  };

  // Shared hull palette.
  const P = { edge: '#101316', dark: '#23272b', hull: '#383e44', mid: '#4a525a', light: '#6b747c', glint: '#8d969e', orange: '#ff6a1f', amber: '#ffb35c', teal: '#5fe0d0', window: '#ffd9a0' };

  function canvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
  const hex = n => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

  // A plated box: gradient body, dark edge, a highlight line and panel seams.
  function plate(c, x, y, w, h, opt = {}) {
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, opt.light || P.mid); g.addColorStop(1, opt.dark || P.dark);
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.lineWidth = opt.lw || 2; c.strokeStyle = P.edge; c.strokeRect(x, y, w, h);
    c.strokeStyle = 'rgba(255,255,255,.10)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x + 2, y + 2); c.lineTo(x + w - 2, y + 2); c.stroke();
    if (opt.seams) {
      c.strokeStyle = 'rgba(0,0,0,.35)';
      for (let k = 1; k < opt.seams; k++) { const sx = x + w * k / opt.seams; c.beginPath(); c.moveTo(sx, y + 1); c.lineTo(sx, y + h - 1); c.stroke(); }
    }
  }
  function light(c, x, y, r, col) {
    const g = c.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, col); g.addColorStop(0.3, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 3, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff6e8'; c.beginPath(); c.arc(x, y, r * 0.5, 0, Math.PI * 2); c.fill();
  }
  function disc(c, r, light0, dark0) {
    const g = c.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
    g.addColorStop(0, light0); g.addColorStop(1, dark0);
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
    c.lineWidth = 3; c.strokeStyle = P.edge; c.stroke();
  }

  /* A station's spars and modules, without its hub ring (which turns). Four
     long arms with modules along them, short diagonal antennae, and a band
     of the owner's colour near the root of each arm. */
  function stationFrame(factionColour) {
    const S = 640, u = S / 2, cv = canvas(S), c = cv.getContext('2d');
    c.translate(u, u);
    const band = hex(factionColour);
    // Diagonal antennae under everything.
    for (let i = 0; i < 4; i++) {
      c.save(); c.rotate(Math.PI / 4 + i * Math.PI / 2);
      c.fillStyle = P.dark; c.fillRect(-4, -0.7 * u, 8, 0.36 * u);
      c.strokeStyle = P.edge; c.lineWidth = 2; c.strokeRect(-4, -0.7 * u, 8, 0.36 * u);
      plate(c, -14, -0.62 * u, 28, 22);
      light(c, 0, -0.71 * u, 3, i % 2 ? P.orange : P.teal);
      c.restore();
    }
    for (let i = 0; i < 4; i++) {
      c.save(); c.rotate(i * Math.PI / 2);
      // Truss.
      c.fillStyle = P.dark; c.fillRect(-11, -0.97 * u, 22, 0.66 * u);
      c.strokeStyle = P.edge; c.lineWidth = 2; c.strokeRect(-11, -0.97 * u, 22, 0.66 * u);
      c.strokeStyle = 'rgba(140,150,160,.35)'; c.lineWidth = 1.5;
      for (let y = -0.95 * u; y < -0.33 * u; y += 18) { c.beginPath(); c.moveTo(-10, y); c.lineTo(10, y + 18); c.moveTo(10, y); c.lineTo(-10, y + 18); c.stroke(); }
      // Modules along the arm, widest nearest the hub.
      const mods = [[-0.52, 0.30, 0.13], [-0.68, 0.24, 0.11], [-0.82, 0.17, 0.09]];
      for (const [y, w, h] of mods) {
        plate(c, -w * u / 2, y * u, w * u, h * u, { seams: 4 });
        for (let k = 0; k < 5; k++) { c.fillStyle = k % 2 ? P.window : 'rgba(255,140,60,.9)'; c.fillRect(-w * u / 2 + 6 + k * (w * u - 12) / 4 - 2, y * u + h * u / 2 - 2, 4, 4); }
      }
      // Docking clamps either side of the first module.
      plate(c, -0.22 * u, -0.47 * u, 0.06 * u, 0.04 * u); plate(c, 0.16 * u, -0.47 * u, 0.06 * u, 0.04 * u);
      // The owner's band.
      c.fillStyle = band; c.fillRect(-0.15 * u, -0.405 * u, 0.3 * u, 0.018 * u);
      // Tip: a rod and a beacon.
      c.fillStyle = P.light; c.fillRect(-3, -1 * u + 4, 6, 0.05 * u);
      light(c, 0, -0.985 * u, 4, P.orange);
      c.restore();
    }
    return cv;
  }

  // The hub: a ring of habitat modules round a plated core with an orange heart.
  function stationHub() {
    const S = 512, u = S / 2, cv = canvas(S), c = cv.getContext('2d');
    c.translate(u, u);
    // Outer module ring.
    const n = 20;
    for (let k = 0; k < n; k++) {
      c.save(); c.rotate(k / n * Math.PI * 2);
      plate(c, -0.13 * u, -0.98 * u, 0.26 * u, 0.2 * u, { seams: 3, lw: 2.5 });
      c.fillStyle = k % 3 ? P.window : P.orange; c.fillRect(-3, -0.9 * u, 6, 5);
      c.restore();
    }
    // Plated deck.
    disc(c, 0.76 * u, P.mid, P.dark);
    c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 2;
    for (let k = 0; k < 16; k++) { const t = k / 16 * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(t) * 0.42 * u, Math.sin(t) * 0.42 * u); c.lineTo(Math.cos(t) * 0.76 * u, Math.sin(t) * 0.76 * u); c.stroke(); }
    c.beginPath(); c.arc(0, 0, 0.6 * u, 0, Math.PI * 2); c.stroke();
    for (let k = 0; k < 24; k++) { const t = (k + 0.5) / 24 * Math.PI * 2; c.fillStyle = k % 4 ? 'rgba(255,217,160,.85)' : 'rgba(255,106,31,.95)'; c.fillRect(Math.cos(t) * 0.68 * u - 3, Math.sin(t) * 0.68 * u - 3, 6, 6); }
    // Inner ring and core.
    disc(c, 0.42 * u, P.light, P.hull);
    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 2;
    for (let k = 0; k < 8; k++) { const t = k / 8 * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(t) * 0.2 * u, Math.sin(t) * 0.2 * u); c.lineTo(Math.cos(t) * 0.42 * u, Math.sin(t) * 0.42 * u); c.stroke(); }
    disc(c, 0.2 * u, P.dark, P.edge);
    const core = c.createRadialGradient(0, 0, 0, 0, 0, 0.17 * u);
    core.addColorStop(0, '#fff2d8'); core.addColorStop(0.3, '#ff8a3a'); core.addColorStop(1, 'rgba(255,106,31,0)');
    c.fillStyle = core; c.beginPath(); c.arc(0, 0, 0.17 * u, 0, Math.PI * 2); c.fill();
    return cv;
  }

  /* A jump gate: a heavy segmented ring on three struts with thruster pods,
     the way the mockup's Lowmark gate stands. Drawn pointing up; the view
     turns it to face the system's middle. */
  function gate() {
    const S = 384, u = S / 2, cv = canvas(S), c = cv.getContext('2d');
    c.translate(u, u);
    for (const a of [Math.PI, Math.PI * 0.5 + 0.9, Math.PI * 0.5 - 0.9 + Math.PI * 2]) {
      c.save(); c.rotate(a + Math.PI / 2);
      c.fillStyle = P.dark; c.fillRect(-7, -0.96 * u, 14, 0.4 * u);
      c.strokeStyle = P.edge; c.lineWidth = 2; c.strokeRect(-7, -0.96 * u, 14, 0.4 * u);
      plate(c, -16, -0.98 * u, 32, 26);
      light(c, 0, -0.93 * u, 3, P.teal);
      c.restore();
    }
    const n = 14;
    for (let k = 0; k < n; k++) {
      c.save(); c.rotate(k / n * Math.PI * 2);
      plate(c, -0.12 * u, -0.66 * u, 0.24 * u, 0.15 * u, { seams: 2, lw: 2.5 });
      if (k % 2) { c.fillStyle = P.orange; c.fillRect(-2.5, -0.6 * u, 5, 5); }
      c.restore();
    }
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,106,31,.55)';
    c.beginPath(); c.arc(0, 0, 0.5 * u, 0, Math.PI * 2); c.stroke();
    return cv;
  }

  /* Your facilities. A foundry: three tanks, a processing block, pipes and a
     stack. An extractor: a drill head on a three-legged rig with a conveyor.
     A solar exchange: a core between two wings of cells. */
  function facility(kind) {
    const S = 256, u = S / 2, cv = canvas(S), c = cv.getContext('2d');
    c.translate(u, u);
    if (kind === 'refinery') {
      plate(c, -0.62 * u, -0.5 * u, 1.2 * u, 1.0 * u, { dark: '#1d2124', light: '#30363b' });
      // Pipes first, so tanks and blocks sit on them.
      c.strokeStyle = P.edge; c.lineWidth = 9;
      c.beginPath(); c.moveTo(-0.6 * u, -0.3 * u); c.lineTo(0.1 * u, -0.3 * u); c.lineTo(0.1 * u, -0.86 * u); c.moveTo(-0.6 * u, 0.3 * u); c.lineTo(0.4 * u, 0.3 * u); c.stroke();
      c.strokeStyle = P.light; c.lineWidth = 5; c.stroke();
      for (const y of [-0.55, 0, 0.55]) {
        c.save(); c.translate(-0.68 * u, y * u); disc(c, 0.22 * u, P.light, P.dark);
        c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 0.13 * u, 0, Math.PI * 2); c.stroke();
        c.restore();
      }
      plate(c, -0.25 * u, -0.45 * u, 0.62 * u, 0.85 * u, { seams: 5 });
      c.fillStyle = 'rgba(0,0,0,.35)'; for (let k = 0; k < 5; k++) c.fillRect(-0.18 * u, -0.3 * u + k * 0.13 * u, 0.48 * u, 0.05 * u);
      plate(c, 0.38 * u, -0.1 * u, 0.3 * u, 0.42 * u, { seams: 2 });
      plate(c, 0.02 * u, -0.98 * u, 0.16 * u, 0.5 * u);
      light(c, 0.1 * u, -0.95 * u, 4, P.orange);
      for (const [x, y] of [[0.5, 0.05], [0.5, 0.2], [-0.05, 0.3]]) light(c, x * u, y * u, 3, P.orange);
    } else if (kind === 'solar') {
      for (const s of [-1, 1]) {
        c.fillStyle = P.dark; c.fillRect(s < 0 ? -0.95 * u : 0.25 * u, -0.06 * u, 0.7 * u, 0.12 * u);
        for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) {
          const x = (s < 0 ? -0.95 : 0.27) * u + k * 0.17 * u, y = (r ? 0.1 : -0.42) * u;
          c.fillStyle = '#2f4d6e'; c.fillRect(x, y, 0.15 * u, 0.32 * u);
          c.strokeStyle = '#8fb2d6'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, 0.15 * u - 1, 0.32 * u - 1);
          c.beginPath(); c.moveTo(x + 0.075 * u, y); c.lineTo(x + 0.075 * u, y + 0.32 * u); c.stroke();
        }
      }
      disc(c, 0.26 * u, P.light, P.dark);
      light(c, 0, 0, 5, P.amber);
    } else {
      for (const a of [0, 2.1, 4.2]) {
        c.save(); c.rotate(a);
        c.fillStyle = P.dark; c.fillRect(-6, -0.88 * u, 12, 0.6 * u); c.strokeStyle = P.edge; c.lineWidth = 2; c.strokeRect(-6, -0.88 * u, 12, 0.6 * u);
        plate(c, -14, -0.95 * u, 28, 20);
        c.restore();
      }
      plate(c, -0.38 * u, -0.38 * u, 0.76 * u, 0.76 * u, { seams: 3 });
      plate(c, 0.3 * u, -0.08 * u, 0.62 * u, 0.16 * u, { seams: 5 });
      c.save(); disc(c, 0.24 * u, P.glint, P.hull);
      c.strokeStyle = P.edge; c.lineWidth = 3;
      for (let k = 0; k < 3; k++) { c.rotate(Math.PI * 2 / 3); c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -0.24 * u); c.stroke(); }
      c.restore();
      light(c, 0.85 * u, 0, 3, P.orange);
    }
    return cv;
  }

  SE.SysArt = { THEMES, stationFrame, stationHub, gate, facility, hex };
})(window.SE = window.SE || {});
