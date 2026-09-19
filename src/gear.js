/* Equipment: the first thing credits have ever been for.
 *
 * Until now money accumulated and did nothing. You could earn it by mining,
 * selling, and — since the contract board — by working, and then it sat in the
 * corner of the HUD being a number. A game where the reward for doing the
 * thing is a bigger number that buys nothing is a game with no second act.
 *
 * Three rules, taken from the build plan and worth restating because each one
 * is a trap avoided:
 *
 * 1. A MODULE MUST BE A TRADE-OFF, NEVER A STRAIGHT UPGRADE. If a part is
 *    better in every respect there is no decision, only an errand: earn the
 *    money, fit the part, never think about it again. Every module here costs
 *    something real, and the cost is in the same units the player already
 *    reads off the HUD.
 *
 *    This is enforced by a test rather than by good intentions: it walks the
 *    table, previews fitting each module, and fails any that produces no
 *    worse number. Two did on the first pass — the Fire-Control Computer and
 *    the Navigation Computer, both of which the plan justifies with an
 *    OPPORTUNITY cost ("no defensive benefit", "no direct combat benefit")
 *    rather than a stat one. That reasoning holds only while every slot is
 *    already full. With a spare slot they were free, and a free module is not
 *    a decision. Both carry mass now, which is what added hardware does.
 *
 * 2. SHIPS STORE ONLY THE IDS. Final statistics are recomputed from the hull
 *    and the fitted list, every time. Nothing writes a derived number into the
 *    save, so rebalancing a module later changes every ship already carrying
 *    it instead of only the ones fitted after the patch — and an old save
 *    cannot smuggle a stat the table no longer agrees with.
 *
 * 3. FLAT FIRST, THEN MULTIPLIERS: (base + flat) x mult. Stated once, applied
 *    everywhere, because the alternative is two modules that each say "+20%"
 *    and a player who cannot predict what fitting both will do.
 */
(function (SE) {
  'use strict';

  /* Slots by hull. The plan's starting layout, with the same warning attached:
     these are numbers for balance testing, not a settled design. A subclass
     may later move a slot between categories; it must not simply add one. */
  const SLOTS = {
    interceptor: { engine: 1, defence: 1, power: 1, utility: 1 },
    extractor:   { engine: 1, defence: 1, power: 0, utility: 3 },
    freighter:   { engine: 1, defence: 1, power: 0, utility: 3 },
    corvette:    { engine: 1, defence: 2, power: 1, utility: 2 },
    dreadnought: { engine: 2, defence: 3, power: 2, utility: 3 }
  };

  /* The modules.
     `flat` is added to the hull's own number; `mult` scales what that
     produces. Weapon-facing keys (damage, rate, range, spread) are
     multipliers on the fitted weapon rather than on the hull, because a
     weapon's numbers live in its own table and a module has no business
     rewriting it.
     Every one of these is from the plan's own tables, including its stated
     drawback — which is the part that is easy to quietly drop later when a
     module feels weak, and the part that makes it a choice. */
  const MODULES = {
    /* ---- engine ---- */
    thrusters: {
      id: 'thrusters', name: 'High-Output Thrusters', cat: 'engine', grade: 'Civilian', cost: 900,
      flat: { thrust: 90, mass: 3 },
      blurb: 'More push. More to push.'
    },
    nozzles: {
      id: 'nozzles', name: 'Vectoring Nozzles', cat: 'engine', grade: 'Civilian', cost: 1100,
      flat: { torque: 7 }, mult: { topSpeed: 0.92 },
      blurb: 'Turns harder, runs slower.'
    },
    cruise: {
      id: 'cruise', name: 'Cruise Drive', cat: 'engine', grade: 'Industrial', cost: 1450,
      mult: { topSpeed: 1.28, thrust: 0.82 },
      blurb: 'Gets there faster once it is moving. Takes longer to start.'
    },

    /* ---- defence ---- */
    shieldbank: {
      id: 'shieldbank', name: 'Expanded Shield Bank', cat: 'defence', grade: 'Civilian', cost: 1250,
      flat: { shield: 120, mass: 4 }, mult: { shieldRegen: 0.72 },
      blurb: 'A deeper pool that refills more slowly.'
    },
    regenmatrix: {
      id: 'regenmatrix', name: 'Regeneration Matrix', cat: 'defence', grade: 'Industrial', cost: 1600,
      mult: { shieldRegen: 1.85, shield: 0.78 },
      blurb: 'Back on its feet fast, from a shallower start.'
    },
    bulkheads: {
      id: 'bulkheads', name: 'Reinforced Bulkheads', cat: 'defence', grade: 'Military', cost: 1900,
      flat: { hull: 160, mass: 9 }, mult: { cargoMax: 0.82 },
      blurb: 'Armour where the hold used to be.'
    },

    /* ---- power ---- */
    capacitor: {
      id: 'capacitor', name: 'Weapon Capacitor', cat: 'power', grade: 'Military', cost: 2100,
      mult: { rate: 1.30, shieldRegen: 0.70 },
      blurb: 'Fires faster. Recovers slower.'
    },
    firecontrol: {
      id: 'firecontrol', name: 'Fire-Control Computer', cat: 'power', grade: 'Military', cost: 1800,
      flat: { mass: 5 }, mult: { spread: 0.55, speed: 1.22 },
      blurb: 'Tighter grouping and faster rounds, and a rack to carry.'
    },
    rangefinder: {
      id: 'rangefinder', name: 'Rangefinder Array', cat: 'power', grade: 'Industrial', cost: 1500,
      mult: { range: 1.35, rate: 0.80 },
      blurb: 'Reaches further between shots.'
    },

    /* ---- utility ---- */
    cargopods: {
      id: 'cargopods', name: 'Cargo Expansion', cat: 'utility', grade: 'Civilian', cost: 800,
      flat: { cargoMax: 40, mass: 6 }, mult: { thrust: 0.90 },
      blurb: 'Room for more, and slower to move it.'
    },
    mininglens: {
      id: 'mininglens', name: 'Mining Lens', cat: 'utility', grade: 'Industrial', cost: 1200,
      mult: { mineRate: 1.60, damage: 0.75 },
      blurb: 'Cuts rock better and ships worse.'
    },
    navcomputer: {
      id: 'navcomputer', name: 'Navigation Computer', cat: 'utility', grade: 'Civilian', cost: 1000,
      flat: { mass: 4 }, mult: { spool: 0.60 },
      blurb: 'Jumps sooner, helps with nothing else, and weighs something.'
    }
  };

  const CATS = ['engine', 'defence', 'power', 'utility'];

  // Everything a fit can touch, and what it means when nothing is fitted.
  const WEAPON_KEYS = { damage: 1, rate: 1, range: 1, spread: 1, speed: 1 };

  function slotsFor(clsId) { return SLOTS[clsId] || { engine: 0, defence: 0, power: 0, utility: 0 }; }

  function emptyFit() { return { engine: [], defence: [], power: [], utility: [] }; }

  /* Effective statistics, recomputed rather than stored.
     Cached on the ship against a revision counter that every fitting change
     bumps — this runs inside the flight model and the AI, sixty times a second
     per ship, and recomputing a dozen multiplications for every one of them
     every frame would be a real cost for an answer that changes when somebody
     presses a button. */
  function stats(ship) {
    const cls = SE.CLASSES[ship.cls];
    const fit = ship.fit;
    if (!fit) return cls;
    if (ship._eff && ship._effRev === ship.fitRev) return ship._eff;

    const out = Object.assign({}, cls);
    for (const k in WEAPON_KEYS) out[k] = 1;
    out.mineRate = 1;
    out.spool = 1;

    const flat = {}, mult = {};
    for (const cat of CATS) {
      for (const id of (fit[cat] || [])) {
        const m = MODULES[id];
        if (!m) continue;
        for (const k in (m.flat || {})) flat[k] = (flat[k] || 0) + m.flat[k];
        for (const k in (m.mult || {})) mult[k] = (mult[k] || 1) * m.mult[k];
      }
    }
    for (const k in flat) out[k] = (out[k] || 0) + flat[k];
    for (const k in mult) out[k] = (out[k] || 0) * mult[k];

    // Nothing may be tuned into uselessness by stacking drawbacks.
    out.mass = Math.max(1, out.mass);
    out.thrust = Math.max(1, out.thrust);
    out.topSpeed = Math.max(4, out.topSpeed);
    out.cargoMax = Math.max(0, Math.round(out.cargoMax));
    out.hull = Math.round(out.hull);
    out.shield = Math.round(out.shield);

    ship._eff = out;
    ship._effRev = ship.fitRev;
    return out;
  }

  // The weapon as this ship actually fires it.
  function weaponOf(ship) {
    const st = stats(ship);
    const base = SE.WEAPONS[st.weapon];
    if (!ship.fit) return base;
    return {
      id: base.id, colour: base.colour, life: base.life, tracks: base.tracks,
      damage: base.damage * (st.damage || 1),
      rate: base.rate * (st.rate || 1),
      range: base.range * (st.range || 1),
      spread: base.spread * (st.spread || 1),
      speed: base.speed * (st.speed || 1)
    };
  }

  function bump(ship) {
    ship.fitRev = (ship.fitRev || 0) + 1;
    // Fitting armour can raise the hull ceiling and fitting a hold can lower
    // the cargo ceiling. Re-clamp both, or a refit leaves a ship carrying more
    // than it can hold or reporting 180/160 hull.
    const st = stats(ship);
    ship.hullMax = st.hull;
    ship.shieldMax = st.shield;
    ship.cargoMax = st.cargoMax;
    if (ship.hull > ship.hullMax) ship.hull = ship.hullMax;
    if (ship.shield > ship.shieldMax) ship.shield = ship.shieldMax;
  }

  function fitted(ship) {
    const all = [];
    for (const cat of CATS) for (const id of (ship.fit ? ship.fit[cat] : [])) all.push(MODULES[id]);
    return all.filter(Boolean);
  }

  function canFit(ship, id) {
    const m = MODULES[id];
    if (!m) return 'unknown module';
    if (!ship.fit) return 'this hull cannot be refitted';
    const cap = slotsFor(ship.cls)[m.cat] || 0;
    if (cap === 0) return 'no ' + m.cat + ' slot on this hull';
    if (ship.fit[m.cat].length >= cap) return m.cat.toUpperCase() + ' SLOTS FULL';
    return null;
  }

  function fit(ship, id) {
    const err = canFit(ship, id);
    if (err) return err;
    ship.fit[MODULES[id].cat].push(id);
    bump(ship);
    return null;
  }

  function unfit(ship, id) {
    const m = MODULES[id];
    if (!m || !ship.fit) return 'not fitted';
    const arr = ship.fit[m.cat];
    const i = arr.indexOf(id);
    if (i < 0) return 'not fitted';
    arr.splice(i, 1);
    bump(ship);
    return null;
  }

  /* What fitting this would actually do, as a list of changed numbers.
     The plan asks for only the statistics that change, with the good and the
     bad shown together — a comparison that hides the drawback is marketing,
     and the whole point of the module table is that there is always one. */
  const SHOWN = [
    ['thrust', 'Thrust', 0], ['torque', 'Turn', 1], ['topSpeed', 'Top speed', 0],
    ['mass', 'Mass', 0], ['hull', 'Hull', 0], ['shield', 'Shield', 0],
    ['shieldRegen', 'Shield regen', 1], ['cargoMax', 'Hold', 0],
    ['damage', 'Gun damage', 2], ['rate', 'Fire rate', 2], ['range', 'Gun range', 2],
    ['spread', 'Spread', 2], ['speed', 'Round speed', 2],
    ['mineRate', 'Mining', 2], ['spool', 'Jump spool', 2]
  ];
  const BETTER_LOWER = { mass: 1, spread: 1, spool: 1 };

  function preview(ship, id, removing) {
    if (!ship.fit) return [];
    const before = stats(ship);
    const snapshot = {};
    for (const [k] of SHOWN) snapshot[k] = before[k];

    const saveRev = ship.fitRev, saveEff = ship._eff, saveEffRev = ship._effRev;
    const cat = MODULES[id].cat;
    const arr = ship.fit[cat];
    const copy = arr.slice();
    if (removing) { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); }
    else arr.push(id);
    ship.fitRev = saveRev + 1; ship._eff = null;
    const after = stats(ship);

    const rows = [];
    for (const [k, label, dp] of SHOWN) {
      const a = snapshot[k], b = after[k];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a - b) < 0.0005) continue;
      rows.push({ label, from: a.toFixed(dp), to: b.toFixed(dp),
        good: BETTER_LOWER[k] ? b < a : b > a });
    }

    // Put it back exactly as it was. preview() is asked on every render.
    ship.fit[cat] = copy;
    ship.fitRev = saveRev; ship._eff = saveEff; ship._effRev = saveEffRev;
    return rows;
  }

  SE.MODULES = MODULES;
  SE.MODULE_CATS = CATS;
  SE.slotsFor = slotsFor;
  SE.emptyFit = emptyFit;
  SE.stats = stats;
  SE.weaponOf = weaponOf;
  SE.fitModule = fit;
  SE.unfitModule = unfit;
  SE.canFitModule = canFit;
  SE.fittedModules = fitted;
  SE.previewFit = preview;
  SE.bumpFit = bump;
})(window.SE = window.SE || {});
