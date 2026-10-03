/* Ship art: one drawn hull per class, in any faction's colours.
 *
 * Painted once into a small canvas per class and faction and cached. The
 * system view turns these into Phaser textures; the Fleet tab and battle
 * panels use them as icons. One drawing, so a ship looks the same
 * everywhere it appears.
 */
(function (SE) {
  'use strict';

  /* Hull outlines in unit coordinates, nose at -y. Each class is a different
     silhouette so a fight reads at a glance: darts are interceptors, the
     arrowhead with pods is a corvette, the box with an arm is a miner, the
     long spine of pods is a freighter, the big wedge is a capital. */
  const SHAPES = {
    interceptor: { hull: [[0, -1], [0.16, -0.4], [0.78, 0.5], [0.26, 0.38], [0.16, 0.82], [-0.16, 0.82], [-0.26, 0.38], [-0.78, 0.5], [-0.16, -0.4]], engines: [[0, 0.82, 0.12]], canopy: [0, -0.35, 0.09, 0.2] },
    corvette: { hull: [[0, -1], [0.3, -0.42], [0.34, 0.18], [0.72, 0.42], [0.72, 0.82], [0.3, 0.7], [0.24, 0.92], [-0.24, 0.92], [-0.3, 0.7], [-0.72, 0.82], [-0.72, 0.42], [-0.34, 0.18], [-0.3, -0.42]], engines: [[-0.5, 0.82, 0.12], [0.5, 0.82, 0.12], [0, 0.92, 0.14]], canopy: [0, -0.4, 0.11, 0.22] },
    extractor: { hull: [[-0.12, -1], [0.12, -1], [0.12, -0.62], [0.48, -0.62], [0.62, -0.32], [0.62, 0.74], [0.36, 0.92], [-0.36, 0.92], [-0.62, 0.74], [-0.62, -0.32], [-0.48, -0.62], [-0.12, -0.62]], engines: [[-0.3, 0.92, 0.13], [0.3, 0.92, 0.13]], canopy: [0, -0.4, 0.16, 0.12], panels: [[-0.62, 0.05, 0.62, 0.05], [-0.62, 0.42, 0.62, 0.42]] },
    freighter: { hull: [[0, -1], [0.22, -0.78], [0.22, -0.66], [0.52, -0.62], [0.52, -0.3], [0.22, -0.26], [0.22, -0.18], [0.52, -0.14], [0.52, 0.18], [0.22, 0.22], [0.22, 0.3], [0.52, 0.34], [0.52, 0.66], [0.22, 0.7], [0.2, 0.94], [-0.2, 0.94], [-0.22, 0.7], [-0.52, 0.66], [-0.52, 0.34], [-0.22, 0.3], [-0.22, 0.22], [-0.52, 0.18], [-0.52, -0.14], [-0.22, -0.18], [-0.22, -0.26], [-0.52, -0.3], [-0.52, -0.62], [-0.22, -0.66], [-0.22, -0.78]], engines: [[0, 0.94, 0.15]], canopy: [0, -0.8, 0.1, 0.1] },
    dreadnought: { hull: [[0, -1], [0.2, -0.78], [0.36, -0.46], [0.56, 0.24], [0.58, 0.72], [0.4, 0.94], [-0.4, 0.94], [-0.58, 0.72], [-0.56, 0.24], [-0.36, -0.46], [-0.2, -0.78]], engines: [[-0.36, 0.94, 0.11], [-0.12, 0.94, 0.11], [0.12, 0.94, 0.11], [0.36, 0.94, 0.11]], canopy: [0, 0.38, 0.14, 0.12], turrets: [[0, -0.5], [-0.24, -0.06], [0.24, -0.06], [0, 0.12]], panels: [[0, -0.85, 0, 0.88]] }
  };

  const SIZE = 96;              // canvas side, pixels; nose up
  const cache = new Map(), urls = new Map();

  // Lighten (k > 0) or darken (k < 0) a colour given as a number.
  function shadeInt(c, k) {
    const ch = n => Math.round(k < 0 ? n * (1 + k) : n + (255 - n) * k);
    return (ch(c >> 16 & 255) << 16) | (ch(c >> 8 & 255) << 8) | ch(c & 255);
  }
  const css = n => '#' + n.toString(16).padStart(6, '0');

  /* A faction-coloured body lit down the spine, dark panel lines, turrets,
     a canopy, engine ports, and a white rim on your own ships. */
  function canvas(cls, faction) {
    const f = SE.FACTIONS[faction] ? faction : 'apex', shape = SHAPES[cls] || SHAPES.corvette;
    const key = cls + ':' + f;
    if (cache.has(key)) return cache.get(key);
    const cv = document.createElement('canvas');
    cv.width = cv.height = SIZE;
    const c = cv.getContext('2d'), u = SIZE * 0.44, col = SE.FACTIONS[f].colour;
    c.translate(SIZE / 2, SIZE / 2);
    const path = () => { c.beginPath(); shape.hull.forEach(([x, y], i) => i ? c.lineTo(x * u, y * u) : c.moveTo(x * u, y * u)); c.closePath(); };
    const grad = c.createLinearGradient(-u, 0, u, 0);
    grad.addColorStop(0, css(shadeInt(col, -0.45))); grad.addColorStop(0.5, css(shadeInt(col, 0.15))); grad.addColorStop(1, css(shadeInt(col, -0.45)));
    path(); c.fillStyle = grad; c.fill();
    c.save(); path(); c.clip();
    c.strokeStyle = 'rgba(5,10,17,.55)'; c.lineWidth = 1.5;
    for (const [x1, y1, x2, y2] of shape.panels || []) { c.beginPath(); c.moveTo(x1 * u, y1 * u); c.lineTo(x2 * u, y2 * u); c.stroke(); }
    c.beginPath(); c.moveTo(0, -u); c.lineTo(0, u); c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 2; c.stroke();
    c.restore();
    for (const [x, y] of shape.turrets || []) { c.beginPath(); c.arc(x * u, y * u, 0.09 * u, 0, Math.PI * 2); c.fillStyle = css(shadeInt(col, -0.6)); c.fill(); c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; c.stroke(); }
    const [cx, cy, cw, ch] = shape.canopy;
    c.beginPath(); c.ellipse(cx * u, cy * u, cw * u, ch * u, 0, 0, Math.PI * 2); c.fillStyle = 'rgba(220,240,255,.85)'; c.fill();
    for (const [x, y, w] of shape.engines) { c.fillStyle = '#2a1a10'; c.fillRect((x - w) * u, (y - 0.08) * u, w * 2 * u, 0.1 * u); }
    path(); c.lineJoin = 'round';
    c.strokeStyle = f === 'player' ? 'rgba(255,255,255,.95)' : 'rgba(5,10,17,.9)'; c.lineWidth = f === 'player' ? 3 : 2; c.stroke();
    cache.set(key, cv);
    return cv;
  }

  function icon(cls, faction) {
    const key = cls + ':' + faction;
    if (!urls.has(key)) urls.set(key, canvas(cls, faction).toDataURL());
    return urls.get(key);
  }

  SE.ShipArt = { SHAPES, canvas, icon, shadeInt };
})(window.SE = window.SE || {});
