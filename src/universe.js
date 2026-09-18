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

  /* Hostility is MUTUAL, and it was not.
   *
   * The table below is written from each faction's point of view: the Scrapper
   * Syndicate lists the player as an enemy, and the player's own entry lists
   * nobody — because the player does not declare wars, they just get attacked.
   * Read one-directionally, as this was at first, that meant hostile(player,
   * scrapper) came back FALSE, and the consequences were much worse than the
   * wrong colour on a targeting bracket that first gave it away:
   *
   *   - the player's wingmen could never see an enemy, because they search
   *     with nearestHostile and it matched nothing, so an escort would fly
   *     calmly alongside a pirate until the pirate opened fire
   *   - the player's own miner would never flee anything
   *
   * If either side considers it a fight, it is a fight.
   */
  function hostile(a, b) {
    if (a === b) return false;
    const fa = FACTIONS[a], fb = FACTIONS[b];
    return !!(fa && fa.hostileTo.indexOf(b) !== -1) ||
           !!(fb && fb.hostileTo.indexOf(a) !== -1);
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
      // Shields are the whole defence, and they are meant to be. Raised hard
      // once rounds actually started landing: a skirmish should visibly push a
      // station's shield down and it should climb back afterwards, which reads
      // as a fortress holding rather than as a fortress being whittled away.
      hull: 6000, shield: 9000, shieldRegen: 90,
      cargoMax: 20000, size: 46,
      // Three turrets, not six. A station that one-volleys an interceptor is
      // not a deterrent, it is an exclusion zone, and there is nothing to do
      // near one.
      weapon: 'turret', hardpoints: 3, miner: false,
      blurb: 'Fixed. Trades, repairs, and regenerates shields only while it has Energy Cells.'
    },

    /* ---- Defence emplacements -------------------------------------------
       Perimeter and blockade weapons: fixed platforms with a tracking head,
       no engine and no orders. Two per faction.

       Their tier is 'emplacement' and not 'structure', and the difference is
       the entire point. A structure is indestructible and never reaped, which
       is right for a station — the design has always been that stations fall
       to a siege, not to a corvette with a grudge. An emplacement is the
       opposite: it is meant to be shot off, because a perimeter you cannot
       breach is a wall, and a wall is not a fight.

       They are still static: mass 0, no thrust, no torque, no agility. The AI
       branch they share with stations never asks them to move. What moves is
       the head, which tracks in the view.
    */
    pylon: {
      id: 'pylon', name: 'Pylon Battery', tier: 'emplacement', faction: 'apex',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 540, shield: 760, shieldRegen: 11,
      cargoMax: 0, size: 9.5,
      muzzleY: 4.6,
      weapon: 'lance', hardpoints: 2, miner: false,
      blurb: 'Twin energy pods on a splayed footing. Apex pays for the shield, not the gun.'
    },
    aegis: {
      id: 'aegis', name: 'Aegis Pillar', tier: 'emplacement', faction: 'apex',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 420, shield: 1180, shieldRegen: 16,
      cargoMax: 0, size: 11,
      muzzleY: 6.6,
      weapon: 'arc', hardpoints: 1, miner: false,
      blurb: 'Ring accelerator. One shot, a long way out, and shields it goes through.'
    },
    grinder: {
      id: 'grinder', name: 'Grinder Mount', tier: 'emplacement', faction: 'scrapper',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 760, shield: 180, shieldRegen: 3,
      cargoMax: 0, size: 9,
      muzzleY: 4.7,
      weapon: 'gatling', hardpoints: 2, miner: false,
      blurb: 'Rotary barrels bolted to a walkway. Harmless at range, ruinous up close.'
    },
    slugger: {
      id: 'slugger', name: 'Slughammer', tier: 'emplacement', faction: 'scrapper',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 880, shield: 140, shieldRegen: 2.5,
      cargoMax: 0, size: 10,
      muzzleY: 3.8,
      weapon: 'slug', hardpoints: 1, miner: false,
      blurb: 'One barrel, one hose-fed breech, one very bad afternoon.'
    },
    picket: {
      id: 'picket', name: 'Picket R-07', tier: 'emplacement', faction: 'vanguard',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 620, shield: 520, shieldRegen: 9,
      cargoMax: 0, size: 9.5,
      muzzleY: 4.4,
      weapon: 'rail', hardpoints: 2, miner: false,
      blurb: 'Twin rails on a stencilled housing. Hits what it aims at, from anywhere.'
    },
    redoubt: {
      id: 'redoubt', name: 'Redoubt Turret', tier: 'emplacement', faction: 'vanguard',
      mass: 0, thrust: 0, torque: 0, topSpeed: 0, agility: 0,
      hull: 940, shield: 600, shieldRegen: 10,
      cargoMax: 0, size: 10.5,
      muzzleY: 4.7,
      weapon: 'autocannon', hardpoints: 3, miner: false,
      blurb: 'Three barrels and a bunker. Built to hold a lane rather than win a duel.'
    }
  };

  /* Static means "has a position and no way to change it". Stations and
     emplacements share every code path that asks whether a thing flies —
     steering, out-of-sector integration, physics body type — and differ only
     in whether they can be destroyed, so that one question gets its own
     answer rather than being read off the tier in nine places. */
  const STATIC_TIERS = { structure: 1, emplacement: 1 };
  function isStatic(cls) { return STATIC_TIERS[cls.tier] === 1; }
  function isEmplacement(cls) { return cls.tier === 'emplacement'; }

  // The two platforms each faction fields, in the order they are deployed.
  const DEFENCES = {
    apex: ['pylon', 'aegis'],
    scrapper: ['grinder', 'slugger'],
    vanguard: ['picket', 'redoubt'],
    player: ['picket', 'redoubt']
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

     These numbers have never been tested, and for a long time they could not
     have been: rounds were not landing at all (see the swept-collision note in
     the README), so every time-to-kill reasoned from this table described
     damage that was never delivered. The arithmetic is at least connected to
     the game now. It is still not playtesting. */
  const WEAPONS = {
    pulse: { id: 'pulse', damage: 5, speed: 320, life: 2.2, rate: 6.5, spread: 0.012, range: 620, colour: 0x7fd4ff },
    // `tracks` means the weapon is laid on its target rather than fired down
    // the hull's nose. It used to be inferred from the weapon being NAMED
    // 'turret', which stopped being true the moment there was more than one
    // kind of turret.
    turret: { id: 'turret', damage: 18, speed: 260, life: 3.2, rate: 1.6, spread: 0.02, range: 820, colour: 0xffcf6b, tracks: true },

    /* ---- Emplacement guns -------------------------------------------
       Every one of these out-ranges and out-damages a ship's weapon,
       deliberately. A defence platform has no engine, no manoeuvre and no way
       to withdraw; the only thing it has is that flying into its envelope is
       a bad idea. A turret a corvette can safely trade with is scenery.

       Each faction's pair is meant to be a different PROBLEM, not a different
       number. Apex holds you off at range and strips shields. Scrapper is
       almost harmless past 500 metres and appalling inside it. Vanguard hits
       exactly what it aims at from anywhere and is the only pair with no
       weakness to exploit — which is why they are the most expensive. */
    lance:      { id: 'lance',      damage: 22,  speed: 430, life: 2.4, rate: 1.1,  spread: 0.006, range: 900,  colour: 0xc98cff, tracks: true },
    arc:        { id: 'arc',        damage: 30,  speed: 380, life: 3.0, rate: 0.6,  spread: 0.004, range: 1150, colour: 0x6fd0ff, tracks: true },
    gatling:    { id: 'gatling',    damage: 3.5, speed: 300, life: 1.5, rate: 15,   spread: 0.055, range: 440,  colour: 0xffb54a, tracks: true },
    slug:       { id: 'slug',       damage: 46,  speed: 240, life: 3.4, rate: 0.45, spread: 0.014, range: 860,  colour: 0xff8a3c, tracks: true },
    rail:       { id: 'rail',       damage: 32,  speed: 620, life: 2.0, rate: 0.8,  spread: 0.0025, range: 1100, colour: 0xbfe6ff, tracks: true },
    autocannon: { id: 'autocannon', damage: 11,  speed: 340, life: 2.4, rate: 3.4,  spread: 0.018, range: 760,  colour: 0xffe07a, tracks: true }
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
  SE.isStatic = isStatic;
  SE.isEmplacement = isEmplacement;
  SE.DEFENCES = DEFENCES;
  SE.route = route;

  // In-sector metres. The belt sits between these radii and the station near
  // the middle; the radar's outer ring is SECTOR_R.
  SE.SECTOR_R = 1400;
  SE.BELT_INNER = 420;
  SE.BELT_OUTER = 1050;
})(window.SE = window.SE || {});
