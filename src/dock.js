/* The station panel: the first place in this game where the player can hand
 * something over rather than only shoot it.
 *
 * Worth saying plainly, because it was a real hole: until this file existed
 * the player could not sell a single unit of anything. Mining worked, the
 * hold filled, prices moved, freighters traded all day — and the one ship with
 * a person aboard had no way to open its cargo doors. You could fly to a
 * station and look at it. That is also why haulage contracts could not exist:
 * there was no delivering.
 *
 * Built in DOM for the same reason the galaxy map is: it is a document you
 * stop to read, with real text, a scroll and buttons. The one rule it adds is
 * that docking does NOT pause the sector — a station panel that freezes the
 * world would make the safest place in the game the inside of a menu.
 */
(function (SE) {
  'use strict';

  function Dock(ctx) {
    const root = document.getElementById('dock');
    const who = document.getElementById('dkwho');
    const body = document.getElementById('dkbody');
    let open = false;
    let station = null;

    function row(title, sub, right, label, enabled, onClick, live) {
      const d = document.createElement('div');
      d.className = 'dkrow' + (live ? ' live' : '');
      const g = document.createElement('div');
      g.className = 'grow';
      const b = document.createElement('b'); b.textContent = title;
      const sp = document.createElement('span'); sp.textContent = sub;
      g.appendChild(b); g.appendChild(sp);
      d.appendChild(g);
      if (right) { const r = document.createElement('div'); r.className = 'cr'; r.textContent = right; d.appendChild(r); }
      if (label) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.disabled = !enabled;
        if (enabled) btn.addEventListener('click', onClick);
        d.appendChild(btn);
      }
      body.appendChild(d);
      return d;
    }

    function heading(t) {
      const h = document.createElement('h3'); h.textContent = t; body.appendChild(h);
    }
    function empty(t) {
      const e = document.createElement('div'); e.className = 'dkempty'; e.textContent = t; body.appendChild(e);
    }

    function render() {
      if (!open || !station) return;
      const me = ctx.player();
      body.innerHTML = '';
      who.textContent = station.name;

      /* ---- the hold ---- */
      heading('Your hold — ' + Math.round(SE.cargoUsed(me)) + '/' + me.cargoMax);
      let any = false;
      for (const g of Object.keys(SE.GOODS)) {
        const qty = Math.floor(me.cargo[g] || 0);
        if (qty <= 0) continue;
        any = true;
        const unit = ctx.priceAt(station.id, g);
        const total = Math.round(qty * unit);
        row(SE.GOODS[g].name, qty + ' units at ' + unit.toFixed(1) + ' cr',
          '+' + total.toLocaleString() + ' cr', 'SELL', true, () => { ctx.sell(station, g); render(); });
      }
      if (!any) empty('Nothing aboard to sell.');

      /* ---- contracts in progress ---- */
      const active = ctx.contracts();
      if (active.length) {
        heading('In progress');
        for (const c of active) {
          const prog = c.type === 'HAUL'
            ? Math.floor(me.cargo[c.good] || 0) + '/' + c.need + ' aboard'
            : c.type === 'ESCORT' ? 'hauler under way' : c.done + '/' + c.need;
          // Haulage is delivered by docking, so the button lives here and is
          // live only at the station the cargo is addressed to.
          const deliverable = c.type === 'HAUL' && c.station === station.id &&
            Math.floor(me.cargo[c.good] || 0) >= c.need;
          row(c.title, prog + ' · ' + c.fromName,
            c.reward.toLocaleString() + ' cr',
            c.type === 'HAUL' && c.station === station.id ? 'DELIVER' : null,
            deliverable, () => { ctx.deliver(station); render(); }, true);
        }
      }

      /* ---- the board ---- */
      heading('Contracts — ' + (SE.FACTIONS[station.faction] || {}).name);
      const offers = ctx.board(station);
      if (!offers.length) empty('Nothing on the board. Come back later.');
      for (const m of offers) {
        row(m.title, m.blurb, m.reward.toLocaleString() + ' cr', 'ACCEPT', true, () => {
          const err = ctx.accept(m);
          if (err) ctx.say(err);
          render();
        });
      }
    }

    document.getElementById('dkclose').addEventListener('click', () => api.hide());

    const api = {
      get open() { return open; },
      show(st) {
        station = st; open = true;
        root.classList.add('on');
        render();
      },
      hide() { open = false; root.classList.remove('on'); },
      refresh() { render(); },
      get station() { return station; }
    };
    return api;
  }

  SE.Dock = Dock;
})(window.SE = window.SE || {});
