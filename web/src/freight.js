/* Freight routes: the supply chain's legs.
 *
 * A route is set and forgotten. One of your freighters picks up one good
 * from your facilities in a source system and delivers it to one of:
 *
 *   market    a friendly station, which buys it at its market price, well
 *             above the broker price facilities get for selling on their own
 *   yard      your store at a shipyard: alloy delivered there makes the ships
 *             you buy at that yard cheaper (up to 30% off)
 *   industry  your facilities in another system that use it, such as ore for
 *             a foundry that has no extractor beside it
 *
 * then goes back for more. Each route is a small job with explicit phases:
 * travel to the source, load, travel to the destination, unload, settle,
 * and round again. Goods move only by ledger-style transfers between
 * inventories that already exist (a facility's stock, the hold, a station's
 * warehouse, the yard store), so nothing is created or lost on the way, and
 * a route that cannot proceed says why in its status instead of stalling
 * silently.
 */
(function (SE) {
  'use strict';

  const LOAD_WAIT = 90;           // game seconds to wait at a dry source before leaving with a part load
  const MIN_LOAD = 20;            // ...but never leave with less than this
  const LOAD_WINDOW = 240;        // a round trip's longest stay at a source that trickles
  const STALL = 120;              // seconds without progress before a route is "needs attention"
  const YARD_DISCOUNT = 0.3;      // the most a yard store can take off a hull's price

  function Freight(host) {
    const world = host.world;
    const state = () => host.director.state;
    const name = id => SE.SECTOR_BY_ID[id].name;
    const goodName = g => SE.GOODS[g].name;

    // What a facility in a system keeps for itself before a route may take it:
    // a foundry's next few cycles of ore stays put.
    function keepFor(sector, good) {
      let keep = 0;
      for (const p of state().outposts) {
        const r = Reach.INDUSTRIES.find(x => x.id === p.kind);
        if (p.sector === sector && p.online && r && r.input && r.input.good === good) keep += r.input.quantity * p.level * 2;
      }
      return keep;
    }
    function available(sector, good) {
      let n = 0;
      for (const p of state().outposts) if (p.sector === sector) n += p.stock[good] || 0;
      return Math.max(0, Math.floor(n - keepFor(sector, good)));
    }
    // Facilities that turn this good into something, in a system.
    const consumers = (sector, good) => state().outposts.filter(p => { const r = Reach.INDUSTRIES.find(x => x.id === p.kind); return p.sector === sector && r && r.input && r.input.good === good; });

    /* ---- Creating and ending routes -------------------------------------- */
    function create(shipId, from, good, to) {
      const s = state(), ship = world.get(shipId);
      if (!ship || !ship.owned || ship.dead || ship.isPlayer) return 'Choose one of your ships.';
      if (ship.cargoMax < 100) return `${ship.name} has room for only ${ship.cargoMax} units. Use a freighter.`;
      if (!SE.SECTOR_BY_ID[from] || !SE.SECTOR_BY_ID[to.sector]) return 'Unknown system.';
      if (!s.outposts.some(p => p.sector === from)) return `You have no facilities in ${name(from)} to load from.`;
      if (!Reach.GOODS.includes(good)) return 'Unknown cargo.';
      if (to.kind === 'yard') {
        const st = world.get('st_' + to.sector);
        if (!st || !host.director.economy.profile(st).yard) return `${name(to.sector)} has no shipyard.`;
        if (good !== 'alloy') return 'Shipyards take alloy for your ships.';
      } else if (to.kind === 'market') {
        const st = world.get('st_' + to.sector);
        if (!st || SE.hostile('player', st.faction)) return `${name(to.sector)} has no friendly market.`;
      } else if (to.kind === 'industry') {
        if (!consumers(to.sector, good).length) return `Nothing of yours in ${name(to.sector)} uses ${goodName(good)}.`;
      } else return 'Unknown destination.';
      // One route per ship.
      s.routes = s.routes.filter(r => r.ship !== shipId);
      const route = { id: 'rt' + s.nextRoute++, ship: shipId, from, good, to: { kind: to.kind, sector: to.sector }, phase: 'load', since: world.elapsed, delivered: 0, trips: 0, earned: 0, rate: 0, tripStart: world.elapsed, note: '' };
      s.routes.push(route);
      ship.duty = 'freight';
      ship.post = undefined;
      ship.orders = [];
      ship.battleOrder = false;
      return null;
    }

    function cancel(id) {
      const s = state(), r = s.routes.find(x => x.id === id);
      if (!r) return 'Route not found.';
      s.routes = s.routes.filter(x => x !== r);
      const ship = world.get(r.ship);
      if (ship && ship.duty === 'freight') { ship.duty = 'hold'; ship.orders = []; }
      return null;
    }

    /* ---- Running routes -------------------------------------------------- */
    function travel(ship, sector) {
      if (ship.sector === sector) return true;
      const head = ship.orders[0];
      if (!head || head.type !== 'JUMP') {
        const path = host.route(ship.sector, sector);
        if (path && path.length > 1) { ship.orders = [{ type: 'JUMP', to: path[1] }]; ship.orderT = 0; }
      }
      return false;
    }
    function approach(ship, target) {
      const p = world.transit.dockPoint(target, ship);
      if (Math.hypot(ship.x - target.x, ship.z - target.z) <= SE.Transit.rules.dockRange * 0.95) return true;
      const head = ship.orders[0];
      if (!head || head.type !== 'MOVE') { ship.orders = [{ type: 'MOVE', x: p.x, y: p.y, z: p.z }]; ship.orderT = 0; }
      return false;
    }
    const progress = (r, note) => { r.note = note; r.since = world.elapsed; };
    const wait = (r, note) => { r.note = note; };

    function load(r, ship) {
      if (!travel(ship, r.from)) return wait(r, `Flying to ${name(r.from)} to load`);
      const room = Math.floor(ship.cargoMax - SE.cargoUsed(ship));
      const have = Math.floor(ship.cargo[r.good] || 0);
      const avail = available(r.from, r.good);
      if (room > 0 && avail > 0) {
        // Take from the facilities, fullest first; the hold and the stores move together.
        let want = Math.min(room, avail);
        const list = state().outposts.filter(p => p.sector === r.from).sort((a, b) => (b.stock[r.good] || 0) - (a.stock[r.good] || 0));
        const keep = keepFor(r.from, r.good);
        let left = list.reduce((n, p) => n + (p.stock[r.good] || 0), 0) - keep;
        for (const p of list) {
          if (want <= 0 || left <= 0) break;
          const take = Math.min(want, Math.floor(p.stock[r.good] || 0), left);
          if (take <= 0) continue;
          p.stock[r.good] -= take;
          SE.addCargo(ship, r.good, take);
          want -= take; left -= take;
        }
        return progress(r, `Loading ${goodName(r.good)} in ${name(r.from)} · ${Math.floor(ship.cargo[r.good] || 0)}/${ship.cargoMax}`);
      }
      // Full, or the source is dry: go once it is full, or after a wait with a part load.
      // A slow source (a foundry trickling alloy) would otherwise keep the hold waiting for an age.
      const waited = world.elapsed - r.since > LOAD_WAIT || world.elapsed - r.tripStart > LOAD_WINDOW;
      if (room <= 0 || (have >= MIN_LOAD && waited)) { r.phase = 'deliver'; return progress(r, `Leaving ${name(r.from)} with ${have} ${goodName(r.good)}`); }
      wait(r, `Waiting for ${goodName(r.good)} in ${name(r.from)} · ${have} aboard`);
    }

    function deliver(r, ship) {
      if (!travel(ship, r.to.sector)) return wait(r, `Delivering to ${name(r.to.sector)} · ${Math.floor(ship.cargo[r.good] || 0)} ${goodName(r.good)} aboard`);
      const qty = Math.floor(ship.cargo[r.good] || 0);
      if (qty <= 0) return finishTrip(r, ship, 0, 0);
      if (r.to.kind === 'industry') {
        const users = consumers(r.to.sector, r.good);
        if (!users.length) return wait(r, `Nothing in ${name(r.to.sector)} uses ${goodName(r.good)} any more`);
        let moved = 0;
        for (const p of users) {
          const room = Math.max(0, 600 - (p.stock[r.good] || 0)), n = Math.min(room, qty - moved);
          if (n > 0) { p.stock[r.good] = (p.stock[r.good] || 0) + n; moved += n; }
        }
        if (!moved) return wait(r, `Storage full in ${name(r.to.sector)}`);
        ship.cargo[r.good] -= moved;
        return finishTrip(r, ship, moved, 0);
      }
      const st = world.get('st_' + r.to.sector);
      if (!st || st.dead || SE.hostile('player', st.faction)) return wait(r, `${name(r.to.sector)} no longer has a friendly station`);
      if (!approach(ship, st)) return wait(r, `Docking at ${st.name}`);
      if (r.to.kind === 'yard') {
        const s = state(), store = s.yardStock[st.id] || (s.yardStock[st.id] = {});
        store[r.good] = (store[r.good] || 0) + qty;
        ship.cargo[r.good] = 0;
        return finishTrip(r, ship, qty, 0);
      }
      const result = host.director.economy.trade(ship, st, r.good, 'sell', qty);
      if (!result.ok) return wait(r, `${st.name} is not buying: ${result.message}`);
      return finishTrip(r, ship, result.quantity, result.amount / 100);
    }

    function finishTrip(r, ship, qty, credits) {
      const secs = Math.max(30, world.elapsed - r.tripStart);
      if (qty > 0) {
        r.delivered += qty; r.trips++; r.earned += credits;
        world.events.emit({ type: 'freight-delivered', ship, route: r.id, quantity: qty, good: r.good });
        // A smoothed delivery rate, units a game minute, for forecasts.
        const now = qty / secs * 60;
        r.rate = r.rate ? r.rate * 0.6 + now * 0.4 : now;
      }
      r.tripStart = world.elapsed;
      r.phase = 'load';
      ship.orders = [];
      progress(r, qty ? `Delivered ${qty} ${goodName(r.good)} to ${name(r.to.sector)}${credits ? ` for ${Reach.credits(credits)} cr` : ''}` : 'Back to load');
    }

    function tick() {
      const s = state();
      for (const r of s.routes) {
        const ship = world.get(r.ship);
        if (!ship || ship.dead) { wait(r, 'No ship: assign a freighter to this route'); r.lost = true; continue; }
        if (ship.duty !== 'freight') { ship.duty = 'freight'; }
        // Fleeing pirates or fighting back takes priority; the route resumes after.
        const head = ship.orders[0];
        if (head && (head.type === 'FLEE' || head.type === 'ATTACK')) { wait(r, 'Under attack: route paused'); continue; }
        if (r.phase === 'deliver') deliver(r, ship); else load(r, ship);
      }
    }

    /* ---- What the rest of the game asks ---------------------------------- */
    const routeOf = shipId => state().routes.find(r => r.ship === shipId) || null;
    const stalled = r => world.elapsed - r.since > STALL;
    // Is this good in this system collected by a route? (Facilities then keep it for the freighter.)
    const exported = (sector, good) => state().routes.some(r => r.from === sector && r.good === good && !r.lost);
    // Ore arriving by route, units a game minute, for forecasts.
    const importRate = (sector, good) => state().routes.filter(r => r.to.kind === 'industry' && r.to.sector === sector && r.good === good).reduce((n, r) => n + (r.rate || 0), 0);

    // A shipyard's store of your alloy and what it takes off a hull.
    function yardDiscount(stationId, hull) {
      const def = Reach.BUILD_DEFINITIONS[hull], store = state().yardStock[stationId] || {};
      if (!def) return { fraction: 0, alloy: 0 };
      const need = def.materials.alloy || 0;
      const use = Math.min(need, Math.floor(store.alloy || 0));
      return { fraction: need ? YARD_DISCOUNT * use / need : 0, alloy: use };
    }
    function useYardAlloy(stationId, n) {
      const store = state().yardStock[stationId];
      if (store) store.alloy = Math.max(0, (store.alloy || 0) - n);
    }

    return { create, cancel, tick, routeOf, stalled, exported, importRate, yardDiscount, useYardAlloy, available, consumers, keepFor, LOAD_WAIT, YARD_DISCOUNT };
  }

  SE.Freight = Freight;
})(window.SE = window.SE || {});
