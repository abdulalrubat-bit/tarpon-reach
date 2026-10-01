/* The wider galaxy: fifty-odd systems generated around the hand-built seven.
 *
 * The seven sectors in universe.js are authored — the tutorial, the charter
 * objective and every existing save refer to them by id — so they stay exactly
 * where they are, and the rest of the galaxy is grown around them. The seed is
 * a constant, not the save's seed, because a save stores ship positions by
 * sector id: a galaxy that differed per save would be fine, but a galaxy that
 * changed under an existing save would strand its ships in systems that no
 * longer exist. Changing anything here changes every generated id; bump
 * GALAXY_SEED's version suffix when that is the intent, never by accident.
 *
 * Three decisions carry the rest:
 *
 *  - Lanes are a relative-neighbourhood graph over the systems. It is
 *    connected, it only joins systems that are genuinely each other's
 *    neighbours, and no two lanes leave a system less than sixty degrees
 *    apart. That last property matters inside the sector, not on the map:
 *    every lane is a gate ring out at the sector's edge in the direction of
 *    its destination, and two lanes at a shallow angle would put two gates on
 *    top of each other.
 *  - Territory is grown along the lanes, not painted by distance. Each faction
 *    takes the nearest unclaimed system its space already touches, in turn, so
 *    every faction's space is contiguous and the borders fall on lanes — which
 *    is where a player meets them.
 *  - What is left over is the frontier: unowned systems, mostly on the rim and
 *    in the gaps between powers, with more belts than settled space. That is
 *    where an independent command claims its first foothold.
 */
(function (SE) {
  'use strict';

  const GALAXY_SEED = 'tarpon-reach/galaxy/v1';
  const TOTAL = 60;            // systems, the seven hand-built ones included
  const RADIUS = 560;          // galaxy-map units; the core seven span ~380
  const SPACING = 96;          // minimum distance between two systems
  const MAX_LANES = 5;         // gate rings per sector before they crowd

  // How many generated systems each power holds, on top of its core two.
  const QUOTA = { apex: 8, scrapper: 9, vanguard: 8 };

  const HEAD = ['Vel', 'Kor', 'Ash', 'Brim', 'Cal', 'Dun', 'Esk', 'Fen', 'Gal', 'Hol', 'Ister', 'Jas',
    'Kel', 'Lor', 'Mar', 'Nor', 'Ost', 'Pell', 'Quar', 'Ros', 'Sal', 'Tor', 'Ul', 'Vey', 'Wren',
    'Yar', 'Zel', 'Cor', 'Hask', 'Mire', 'Sten', 'Thal', 'Oro', 'Bel', 'Carn', 'Drav'];
  const TAIL = ['ara', 'ion', 'is', 'ek', 'mouth', 'reach', 'fall', 'gate', 'hold', 'ven', 'dra', 'mere',
    'spire', 'wick', 'stone', 'rift', 'haven', 'crest', 'moor', 'ith', 'ane', 'ost'];
  const WORD = ['Drift', 'Shallows', 'Expanse', 'Verge', 'Narrows', 'Cradle', 'Hollow', 'Crossing', 'Rest', 'Span'];
  const STATION = {
    apex: ['Exchange', 'Depot', 'Terminal', 'Hub', 'Clearing House'],
    scrapper: ['Breakers', 'Scrapworks', 'Den', 'Chop Yard', 'Salvage'],
    vanguard: ['Watch', 'Bastion', 'Post', 'Garrison', 'Outpost']
  };
  /* Station kinds, which the economy maps to what a station makes and whether
     it has a shipyard. Weighted per owner: Scrapper space reclaims salvage,
     Vanguard builds warships, Apex trades. */
  const KINDS = {
    apex: ['depot', 'depot', 'refinery', 'refinery', 'yard'],
    scrapper: ['reclaim', 'reclaim', 'refinery', 'depot'],
    vanguard: ['depot', 'refinery', 'yard', 'yard']
  };

  function expand(SECTORS, LANES) {
    const rng = SE.Rng(GALAXY_SEED);
    const D = window.d3 && window.d3.Delaunay;
    if (!D) throw new Error('d3-delaunay must load before cosmos.js');

    /* ---- Positions: dart-throwing inside a disc ----------------------------
       Poisson-disc spacing reads as a scattered galaxy rather than a grid, and
       rejects anything that would crowd the core seven. */
    const pts = SECTORS.map(s => ({ x: s.gx, y: s.gy }));
    let tries = 0;
    while (pts.length < TOTAL && tries < 20000) {
      ++tries;
      const a = rng.float(0, Math.PI * 2);
      const r = RADIUS * Math.sqrt(rng.next());
      const p = { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r * 0.82) };
      if (pts.every(q => Math.hypot(q.x - p.x, q.y - p.y) >= SPACING)) pts.push(p);
    }

    const names = new Set(SECTORS.map(s => s.name));
    const coreCount = SECTORS.length;
    for (let i = coreCount; i < pts.length; i++) {
      SECTORS.push({ id: 'x' + (i - coreCount + 1), name: uniqueName(rng, names), gx: pts[i].x, gy: pts[i].y,
        owner: null, belt: false, station: null, generated: true });
    }

    /* ---- Lanes --------------------------------------------------------------
       Start from the hand-built lanes, then add every relative-neighbourhood
       edge that touches a generated system. Delaunay first, because the RNG is
       a subgraph of it and testing only Delaunay edges is what keeps this fast. */
    const n = SECTORS.length;
    const adj = SECTORS.map(() => []);
    const index = {};
    SECTORS.forEach((s, i) => { index[s.id] = i; });
    const d = (i, j) => Math.hypot(SECTORS[i].gx - SECTORS[j].gx, SECTORS[i].gy - SECTORS[j].gy);
    const link = (i, j) => { adj[i].push(j); adj[j].push(i); LANES.push([SECTORS[i].id, SECTORS[j].id]); };
    LANES.forEach(([a, b]) => { adj[index[a]].push(index[b]); adj[index[b]].push(index[a]); });

    // Smallest angle between a proposed lane out of i and the lanes it already has.
    function clearance(i, j) {
      const a = Math.atan2(SECTORS[j].gy - SECTORS[i].gy, SECTORS[j].gx - SECTORS[i].gx);
      let min = Math.PI;
      for (const k of adj[i]) {
        const b = Math.atan2(SECTORS[k].gy - SECTORS[i].gy, SECTORS[k].gx - SECTORS[i].gx);
        let diff = Math.abs(a - b) % (Math.PI * 2);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        min = Math.min(min, diff);
      }
      return min;
    }
    const ok = (i, j, angle) => adj[i].indexOf(j) === -1 && adj[i].length < MAX_LANES && adj[j].length < MAX_LANES &&
      clearance(i, j) >= angle && clearance(j, i) >= angle;

    const del = D.from(SECTORS.map(s => [s.gx, s.gy]));
    const edges = [];
    const seen = new Set();
    for (let t = 0; t < del.triangles.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i = del.triangles[t + e], j = del.triangles[t + (e + 1) % 3];
        const key = i < j ? i + ':' + j : j + ':' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([Math.min(i, j), Math.max(i, j), d(i, j)]);
      }
    }
    edges.sort((a, b) => a[2] - b[2]);
    const isRng = ([i, j, dij]) => {
      for (let k = 0; k < n; k++) if (k !== i && k !== j && Math.max(d(i, k), d(j, k)) < dij) return false;
      return true;
    };
    const extras = [];
    for (const e of edges) {
      const [i, j] = e;
      if (i < coreCount && j < coreCount) continue;          // the core's lanes are authored
      if (isRng(e)) { if (ok(i, j, 0.7)) link(i, j); } else extras.push(e);
    }

    /* A pure neighbourhood graph is nearly a tree: every route is a corridor
       and every system past the first fork is a dead end. A few of the next
       shortest links put loops back in, so there is more than one way into
       most places — which is what makes a border something to hold rather
       than a single door. */
    const lengths = edges.map(e => e[2]).sort((a, b) => a - b);
    const median = lengths[lengths.length >> 1];
    let loops = Math.round(n * 0.14);
    for (const e of extras) {
      if (loops <= 0) break;
      const [i, j, dij] = e;
      if (dij < median * 1.3 && ok(i, j, 0.95)) { link(i, j); --loops; }
    }

    // Anything the angle rules cut off gets its shortest way back in.
    for (;;) {
      const reach = new Set([0]), stack = [0];
      while (stack.length) { const i = stack.pop(); for (const k of adj[i]) if (!reach.has(k)) { reach.add(k); stack.push(k); } }
      if (reach.size === n) break;
      let best = null;
      for (const e of edges) if (reach.has(e[0]) !== reach.has(e[1]) && (!best || e[2] < best[2])) best = e;
      link(best[0], best[1]);
    }

    /* ---- Territory ----------------------------------------------------------
       Round-robin growth along lanes from each power's core systems. Only
       generated systems are handed out; the authored seven keep their owners. */
    const factions = Object.keys(QUOTA);
    const left = Object.assign({}, QUOTA);
    for (let guard = 0; guard < 400 && factions.some(f => left[f] > 0); guard++) {
      for (const f of factions) {
        if (left[f] <= 0) continue;
        let best = -1, bestD = Infinity;
        SECTORS.forEach((s, i) => {
          if (s.owner !== f) return;
          for (const k of adj[i]) {
            const t = SECTORS[k];
            if (!t.generated || t.owner) continue;
            // A little noise, so borders are not all perfectly bisected.
            const dk = d(i, k) * (0.85 + (SE.hashSeed(f + t.id) % 1000) / 3300);
            if (dk < bestD) { bestD = dk; best = k; }
          }
        });
        if (best === -1) { left[f] = 0; continue; }
        SECTORS[best].owner = f;
        --left[f];
      }
    }

    for (const s of SECTORS) {
      if (!s.generated) continue;
      s.belt = rng.chance(s.owner ? 0.45 : 0.65);
      if (s.owner) {
        s.station = s.name.replace(/^The /, '') + ' ' + rng.pick(STATION[s.owner]);
        s.kind = rng.pick(KINDS[s.owner]);
      }
    }
  }

  function uniqueName(rng, used) {
    for (;;) {
      const root = rng.pick(HEAD) + rng.pick(TAIL);
      const roll = rng.next();
      const name = roll < 0.68 ? root : roll < 0.86 ? rng.pick(HEAD) + ' ' + rng.pick(WORD) : 'The ' + root;
      if (!used.has(name)) { used.add(name); return name; }
    }
  }

  SE.expandGalaxy = expand;
  SE.GALAXY_SEED = GALAXY_SEED;
})(window.SE = window.SE || {});
