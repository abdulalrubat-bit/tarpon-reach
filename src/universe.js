/* The universe: factions, hull classes, commodities, and the galaxy graph.
 *
 * Nothing in this file knows about Three.js, Ammo or Phaser. It is the rule
 * book — numbers and relationships — and both halves of the game read it: the
 * sector you are flying in and the sectors simulating themselves without you.
 */
(function (SE) {
  'use strict';

  /* ---- Factions -------------------------------------------------------
     Three powers plus the player. Colour is not decoration: it is the only
     identification channel that survives being a four-pixel blip on a radar
     ring, so each is picked to stay distinct against the others at that size
     and against the belt's grey. */
  const FACTIONS = {
    /* Magenta, not the interface teal. The hull is navy with white edges and
       gold banding, and the one accent that composition wants is the same
       magenta the drives burn — put teal on it as well and the ship is five
       colours arguing. The HUD stays teal because the HUD is not a faction:
       it is the glass you are looking through, and it should not look like
       anything in the scene. */
    player: { id: 'player', name: 'Your Command', short: 'YOU', colour: 0xef5cc4, hostileTo: [] },
    apex: {
      id: 'apex', name: 'Apex Logistics Network', short: 'APX', colour: 0x4d9bff,
      hostileTo: ['scrapper'],
      // Corporate supply chain. Owns the deep-space hubs, runs bulk freight,
      // and would rather pay a patrol than fight anyone itself.
      blurb: 'Supply-chain monopolists. Bulk freight, deep-space hubs, paid protection.'
    },
    scrapper: {
      id: 'scrapper', name: 'The Scrapper Syndicate', short: 'SCR', colour: 0xff7a3c,
      hostileTo: ['apex', 'vanguard', 'player'],
      blurb: 'Junkyard mechanics and pirates. Owns the belts, buys anything, asks nothing.'
    },
    vanguard: {
      id: 'vanguard', name: 'Vanguard Division', short: 'VGD', colour: 0x9fe870,
      hostileTo: ['scrapper'],
      blurb: 'A military remnant with no state left to serve. Patrols, bounties, and a long memory.'
    }
  };

  function hostile(a, b) {
    if (a === b) return false;
    const fa = FACTIONS[a];
    return !!(fa && fa.hostileTo.indexOf(b) !== -1);
  }

  /* ---- Hull classes ---------------------------------------------------
     Three silhouettes, and the differences between them are deliberately
     large. A freighter that handles almost like an interceptor is a freighter
     nobody feels, and the whole reason to own more than one ship is that each
     one is bad at something.

       mass        drives inertia in Ammo, and inertia is what the player reads
                   as "heavy" long before they read the stat
       thrust      forward force in newtons-ish; accel = thrust / mass
       torque      how hard it can rotate, fighting the same mass
       topSpeed    a soft cap enforced by drag, not a hard clamp
       agility     out-of-sector turn rate, so an OOS freighter is still slow */
  const CLASSES = {
    interceptor: {
      id: 'interceptor', name: 'Interceptor', tier: 'light',
      mass: 6, thrust: 210, torque: 26, topSpeed: 96, agility: 2.6,
      hull: 90, shield: 70, shieldRegen: 4.0,
      cargoMax: 8, size: 3.4,
      weapon: 'pulse', hardpoints: 2, miner: false,
      blurb: 'Fragile, quick, fixed forward guns. Fights in wings or not at all.'
    },
    extractor: {
      id: 'extractor', name: 'Extractor', tier: 'medium',
      mass: 42, thrust: 460, torque: 34, topSpeed: 46, agility: 0.85,
      hull: 320, shield: 110, shieldRegen: 2.0,
      cargoMax: 220, size: 8.5,
      weapon: 'pulse', hardpoints: 1, miner: true,
      blurb: 'Reinforced hull wrapped around a mining laser and a hold. Turns like a moon.'
    },
    freighter: {
      id: 'freighter', name: 'Freighter', tier: 'medium',
      mass: 58, thrust: 520, torque: 30, topSpeed: 42, agility: 0.7,
      hull: 380, shield: 140, shieldRegen: 2.2,
      cargoMax: 480, size: 10.5,
      weapon: 'pulse', hardpoints: 1, miner: false,
      blurb: 'Cargo with engines attached. Everything about it is the hold.'
    },
    corvette: {
      id: 'corvette', name: 'Corvette', tier: 'light',
      mass: 14, thrust: 300, torque: 22, topSpeed: 74, agility: 1.8,
      hull: 220, shield: 180, shieldRegen: 4.5,
      cargoMax: 24, size: 5.0,
      weapon: 'pulse', hardpoints: 2, miner: false,
      blurb: 'The compromise hull. Not the best at anything, adequate at all of it.'
    },
    dreadnought: {
      id: 'dreadnought', name: 'Dreadnought', tier: 'heavy',
      mass: 260, thrust: 1500, torque: 90, topSpeed: 28, agility: 0.35,
      hull: 2600, shield: 900, shieldRegen: 6.0,
      cargoMax: 600, size: 26,
      weapon: 'turret', hardpoints: 4, miner: false,
      blurb: 'Capital hull with turrets that track on their own. Arrives late, decides everything.'
    },
    station: {
      id: 'station', name: 'Station', tier: 'structure',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 6000, shield: 2400, shieldRegen: 14,
      cargoMax: 20000, size: 46,
      weapon: 'turret', hardpoints: 6, miner: false,
      blurb: 'Fixed. Trades, repairs, and regenerates shields only while it has Energy Cells.'
    }
  };

  /* ---- Weapons --------------------------------------------------------
     Projectiles are pooled (see pools.js), so "rate" is also a statement
     about how many corpses per second the pool has to absorb. */
  /* Damage is low relative to shields on purpose. Shields regenerate and hulls
     do not, so where the damage number sits between them decides what a fight
     IS: high, and every engagement is decided in the first second by whoever
     shot first; low, and a fight is a thing you can lose, break off from and
     come back to. These numbers put a two-on-one on the player at roughly
     three seconds of sustained fire, which is enough time to make a decision
     and not enough to make several.

     Not yet verified against a player. This is the arithmetic, not playtesting. */
  const WEAPONS = {
    pulse: { id: 'pulse', damage: 5, speed: 320, life: 2.2, rate: 6.5, spread: 0.012, range: 620, colour: 0x7fd4ff },
    turret: { id: 'turret', damage: 18, speed: 260, life: 3.2, rate: 1.6, spread: 0.02, range: 820, colour: 0xffcf6b }
  };

  /* ---- Commodities ----------------------------------------------------
     Base prices. A station's actual price moves with its stock, so the trade
     loop is "find where it is cheap" rather than "look up the number". */
  const GOODS = {
    ore: { id: 'ore', name: 'Raw Ore', base: 14, vol: 1 },
    alloy: { id: 'alloy', name: 'Refined Alloy', base: 52, vol: 1 },
    cells: { id: 'cells', name: 'Energy Cells', base: 88, vol: 1 },
    scrap: { id: 'scrap', name: 'Salvage', base: 31, vol: 1 }
  };

  /* ---- The galaxy graph -----------------------------------------------
     Sectors are nodes, jump lanes are edges. Positions are galactic-map
     coordinates and have nothing to do with in-sector metres.

     Only `home` is built in three dimensions in this slice. The others exist
     as state, run their economies, and are where out-of-sector fleets go. */
  const SECTORS = [
    { id: 'home', name: 'Tarpon Reach', gx: 0, gy: 0, owner: 'apex', belt: true, station: 'Reach Anchorage' },
    { id: 'sill', name: 'The Sill', gx: 120, gy: -70, owner: 'scrapper', belt: true, station: 'Sill Breakers' },
    { id: 'kestrel', name: 'Kestrel Gate', gx: -110, gy: -50, owner: 'vanguard', belt: false, station: 'Gate Watch' },
    { id: 'lowmark', name: 'Lowmark', gx: 40, gy: 130, owner: 'apex', belt: false, station: 'Lowmark Depot' },
    { id: 'ossuary', name: 'The Ossuary', gx: 200, gy: 40, owner: 'scrapper', belt: true, station: 'Bone Yard' },
    { id: 'harrow', name: 'Harrow Deep', gx: -80, gy: 110, owner: null, belt: true, station: null },
    { id: 'pilot', name: "Pilot's Rest", gx: -180, gy: 30, owner: 'vanguard', belt: false, station: 'Rest Station' }
  ];

  const LANES = [
    ['home', 'sill'], ['home', 'kestrel'], ['home', 'lowmark'],
    ['sill', 'ossuary'], ['kestrel', 'pilot'], ['lowmark', 'harrow'],
    ['harrow', 'pilot'], ['sill', 'lowmark']
  ];

  // Adjacency, built once. A* over this is how a fleet ordered to a sector it
  // cannot see works out the legs in between.
  const ADJ = {};
  SECTORS.forEach(s => { ADJ[s.id] = []; });
  LANES.forEach(([a, b]) => { ADJ[a].push(b); ADJ[b].push(a); });

  const SECTOR_BY_ID = {};
  SECTORS.forEach(s => { SECTOR_BY_ID[s.id] = s; });

  function laneCost(a, b) {
    const A = SECTOR_BY_ID[a], B = SECTOR_BY_ID[b];
    return Math.hypot(A.gx - B.gx, A.gy - B.gy);
  }

  /* A* across the galaxy graph. Euclidean distance on the map is an
     admissible heuristic because no lane is shorter than the straight line
     between its ends, which is what keeps the result actually optimal rather
     than merely quick. */
  function route(from, to) {
    if (from === to) return [from];
    const open = [from];
    const g = { [from]: 0 };
    const f = { [from]: laneCost(from, to) };
    const came = {};
    const seen = {};
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === to) {
        const path = [cur];
        let c = cur;
        while (came[c]) { c = came[c]; path.unshift(c); }
        return path;
      }
      seen[cur] = true;
      for (const nb of ADJ[cur]) {
        if (seen[nb]) continue;
        const tentative = g[cur] + laneCost(cur, nb);
        if (g[nb] === undefined || tentative < g[nb]) {
          came[nb] = cur;
          g[nb] = tentative;
          f[nb] = tentative + laneCost(nb, to);
          if (open.indexOf(nb) === -1) open.push(nb);
        }
      }
    }
    return null;   // graph is connected, so this means a bad sector id
  }

  SE.FACTIONS = FACTIONS;
  SE.CLASSES = CLASSES;
  SE.WEAPONS = WEAPONS;
  SE.GOODS = GOODS;
  SE.SECTORS = SECTORS;
  SE.SECTOR_BY_ID = SECTOR_BY_ID;
  SE.LANES = LANES;
  SE.ADJ = ADJ;
  SE.hostile = hostile;
  SE.route = route;

  // In-sector metres. The belt sits between these radii and the station near
  // the middle; the radar's outer ring is SECTOR_R.
  SE.SECTOR_R = 1400;
  SE.BELT_INNER = 420;
  SE.BELT_OUTER = 1050;
})(window.SE = window.SE || {});
