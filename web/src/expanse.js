/* What fills a system beyond its station: the expanse.
 *
 * Systems used to be a station with one asteroid ring hugging it and gates
 * 1.7 km out. Now the gates stand about 5 km out and the space between holds
 * things worth flying to:
 *
 *   fields   two or three separate asteroid fields well away from the
 *            station (belt systems only); miners work one of them
 *   sites    points of interest: a derelict hulk, a debris field, a nebula
 *            pocket. Galaxy events (warlords, caches, distress calls, raids)
 *            happen at them
 *   bodies   a planet or two with moons: scenery, kept clear of everything
 *
 * Every layout is derived from the sector id alone, so it is the same on
 * every load and needs nothing in the save. Placement keeps clear of the gate
 * approaches and of each other.
 */
(function (SE) {
  'use strict';

  const SCALE = 3;                       // against the old 1.7 km system
  const cache = new Map();

  // The gate directions, as transit.js lays them out (galaxy-map bearings).
  function gateAngles(id) {
    const o = SE.SECTOR_BY_ID[id], out = [];
    for (const [a, b] of SE.LANES) {
      const t = a === id ? b : b === id ? a : null;
      if (!t) continue;
      const d = SE.SECTOR_BY_ID[t];
      out.push(Math.atan2(d.gy - o.gy, d.gx - o.gx));
    }
    return out;
  }
  const gap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

  function layout(id) {
    if (cache.has(id)) return cache.get(id);
    const sec = SE.SECTOR_BY_ID[id];
    const rng = SE.Rng('expanse:' + id);
    const gates = gateAngles(id);
    const placed = [];                   // {x, z, r} already used
    // Pick a point at a distance band, clear of gate lanes and earlier picks.
    const pick = (lo, hi, radius, laneClear) => {
      let best = null, bestScore = -Infinity;
      for (let k = 0; k < 40; k++) {
        const a = rng.float(0, Math.PI * 2), d = rng.float(lo, hi);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const lane = gates.length ? Math.min(...gates.map(g => gap(a, g))) * d : 1e9;
        const room = placed.length ? Math.min(...placed.map(p => Math.hypot(p.x - x, p.z - z) - p.r)) - radius : 1e9;
        const score = Math.min(lane - laneClear, room);
        if (score > bestScore) { bestScore = score; best = { x, z }; }
        if (score > 300) break;
      }
      placed.push({ ...best, r: radius });
      return best;
    };
    const greek = ['Alpha', 'Beta', 'Gamma'];
    const fields = [];
    if (sec.belt) {
      const n = rng.int(2, 3);
      for (let i = 0; i < n; i++) {
        const r = rng.float(430, 680), p = pick(1700, 3700, r, r + 260);
        fields.push({ id: 'f' + i, name: greek[i] + ' Field', x: p.x, z: p.z, r, rich: rng.float(0.8, 1.25) });
      }
    }
    const KINDS = [
      { kind: 'derelict', name: 'Derelict hulk' },
      { kind: 'debris', name: 'Debris field' },
      { kind: 'nebula', name: 'Nebula pocket' }
    ];
    const sites = [];
    const nSites = rng.int(2, 3);
    const order = KINDS.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = rng.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
    for (let i = 0; i < nSites; i++) {
      const k = order[i], r = k.kind === 'nebula' ? 520 : k.kind === 'debris' ? 300 : 160;
      const p = pick(2200, 4500, r, r + 200);
      sites.push({ id: 's' + i, kind: k.kind, name: k.name, code: id.slice(0, 2).toUpperCase() + '-' + (100 + Math.floor(rng.float(0, 899))), x: p.x, z: p.z, r });
    }
    const bodies = [];
    const nPlanets = rng.chance(0.55) ? 2 : 1;
    for (let i = 0; i < nPlanets; i++) {
      const r = i ? rng.float(260, 420) : rng.float(520, 820);
      const p = pick(i ? 3600 : 3000, i ? 5600 : 5000, r * 1.5, r + 300);
      const moons = [];
      for (let m = 0, nm = rng.int(0, 2); m < nm; m++) {
        const a = rng.float(0, Math.PI * 2), d = r * rng.float(1.7, 2.4);
        moons.push({ x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d, r: r * rng.float(0.12, 0.22) });
      }
      bodies.push({ id: 'p' + i, x: p.x, z: p.z, r, moons, hue: rng.int(0, 3), code: id.slice(0, 2).toUpperCase() + '-' + (1000 + Math.floor(rng.float(0, 8999))) });
    }
    const result = { fields, sites, bodies };
    cache.set(id, result);
    return result;
  }

  // A random point inside a field, for a miner's next deposit.
  function pointIn(field, rng) {
    const a = rng.float(0, Math.PI * 2), d = Math.sqrt(rng.float(0, 1)) * field.r * 0.9;
    return { x: field.x + Math.cos(a) * d, z: field.z + Math.sin(a) * d };
  }
  // The field nearest a point (a miner works the one closest to where it is).
  function nearestField(id, x, z) {
    let best = null, bd = Infinity;
    for (const f of layout(id).fields) { const d = Math.hypot(f.x - x, f.z - z); if (d < bd) { bd = d; best = f; } }
    return best;
  }
  // Where an event happens: one of the sites, chosen from the event's id.
  function siteFor(id, key) {
    const sites = layout(id).sites;
    if (!sites.length) return null;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
    return sites[h % sites.length];
  }

  SE.Expanse = { SCALE, layout, pointIn, nearestField, siteFor };
})(window.SE = window.SE || {});
