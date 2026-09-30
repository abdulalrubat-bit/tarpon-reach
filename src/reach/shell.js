"use strict";
var Reach;
(function (Reach) {
    function icon(name) {
        const paths = {
            orbit: 'M3 12a9 5 0 1 0 18 0 9 5 0 1 0-18 0M12 3v18M3 7l2 5-4 2', center: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8', contract: 'M7 3h10l3 3v15H4V3zm1 5h8m-8 4h8m-8 4h5', trade: 'M3 7h17l-4-4m5 14H4l4 4', sliders: 'M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4M10 17v4',
            arrow: 'M5 12h14m-6-6 6 6-6 6', chart: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15',
            fleet: 'm12 3 5 15-5-3-5 3zm-7 8-3 9 3-2 3 2m11-9 3 9-3-2-3 2',
            target: 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6M8 12h8m-4-4v8',
            port: 'M4 21V9l8-6 8 6v12M8 21v-8h8v8M2 21h20', industry: 'M3 21V9l6 4V7l6 5V3h5v18zm4-4h1m4 0h1m4 0h1',
            close: 'm6 6 12 12M6 18 18 6', pause: 'M8 5v14M16 5v14', gear: 'M8 4h8l1 4 4 1v6l-4 1-1 4H8l-1-4-4-1V9l4-1zm1 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
            diamond: 'm12 3 8 9-8 9-8-9z', shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z', bolt: 'm13 2-8 12h6l-1 8 9-13h-6z',
            ore: 'm8 3 9 2 4 10-8 6-10-7zm0 0 2 9-7 2m7-2 11 3m-11-3 3 9', check: 'm5 12 4 4L19 6', save: 'M4 3h13l3 3v15H4zm3 0v7h9V3M7 21v-7h10v7',
            sound: 'M4 9h4l5-5v16l-5-5H4zm12-1c3 3 3 5 0 8m3-11c5 4 5 10 0 14', bars: 'M4 6h16M4 12h16M4 18h16'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.diamond}"/></svg>`;
    }
    Reach.icon = icon;
    const labelForPanel = { overview: 'Command', fleet: 'Fleet', contracts: 'Contracts', industry: 'Industry', factions: 'Factions', market: 'Market', outfit: 'Outfitting', shipyard: 'Shipyard', settings: 'Settings' };
    const panels = ['overview', 'fleet', 'contracts', 'industry', 'factions', 'market', 'outfit', 'shipyard', 'settings'];
    class Shell {
        constructor(director) {
            this.director = director;
            this.panel = 'overview';
            this.instruments = new Reach.InstrumentView();
            this.title = true;
            this.toastTimer = null;
            this.damageTimer = null;
            this.hitTimer = null;
            this.lastToast = '';
            this.keyListener = (event) => this.navigateKeys(event);
            document.addEventListener('keydown', this.keyListener);
            this.clickListener = (event) => this.click(event);
            this.changeListener = (event) => this.change(event);
            document.addEventListener('click', this.clickListener);
            document.addEventListener('change', this.changeListener);
            for (const node of document.querySelectorAll('[data-icon]'))
                node.innerHTML = icon(node.dataset.icon || 'diamond');
            this.el('boot').classList.add('hidden');
            this.updateHUD();
        }
        el(id) { const node = document.getElementById(id); if (!node)
            throw new Error(`Missing interface node ${id}`); return node; }
        button(label, action, value = '', disabled = false, primary = false) {
            return `<button class="button ${primary ? 'primary' : ''}" data-action="${action}" data-value="${Reach.escapeHTML(value)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        }
        economicButton(label, action, value, disabled = false, primary = false) {
            return this.button(label, action, value, disabled, primary).replace('data-action=', `data-request="${this.director.economy.nextRequest()}" data-revision="${this.director.economy.revision}" data-action=`);
        }
        supplySummary() {
            const d = this.director;
            const job = d.economy.state.jobs.find((item) => !['complete', 'cancelled'].includes(item.phase));
            if (!job)
                return '';
            const station = d.world.get(job.station);
            if (!station)
                return '';
            const missing = Reach.GOODS.find((good) => d.economy.need(job, good) > 0);
            const source = missing ? d.economy.sourceFor(missing, station) : undefined;
            const atSource = !!source && d.atPort && d.station?.id === source.id;
            const hint = job.phase === 'waiting' ? `${Reach.escapeHTML(job.status)}. Sell the missing cargo at ${Reach.escapeHTML(station.name)} to supply construction.` : `${Reach.escapeHTML(job.status)} at ${Reach.escapeHTML(station.name)}. Production advances while you fly.`;
            return this.card('SUPPLY NETWORK · ' + Reach.escapeHTML(SE.SECTOR_BY_ID[station.sector].name), Reach.escapeHTML(job.name), hint, `<div class="button-row">${source ? this.button(atSource ? 'Buy materials here' : 'Source ' + SE.GOODS[missing].name + ' · ' + SE.SECTOR_BY_ID[source.sector].name, atSource ? 'panel' : source.sector === d.world.sectorId ? 'navigate' : 'course', atSource ? 'market' : source.sector === d.world.sectorId ? 'port' : source.sector, false, true) : ''}${this.button(d.atPort && d.station?.id === station.id ? 'Open shipyard' : 'Course to shipyard', d.atPort && d.station?.id === station.id ? 'panel' : station.sector === d.world.sectorId ? 'navigate' : 'course', d.atPort && d.station?.id === station.id ? 'shipyard' : station.sector === d.world.sectorId ? 'port' : station.sector)}</div>`, 'supply-card');
        }
        card(kicker, title, body, extra = '', className = '') {
            return `<article class="card ${className}"><div class="eyebrow">${kicker}</div><h3>${title}</h3><p>${body}</p>${extra}</article>`;
        }
        showTitle() {
            this.title = true;
            this.el('title-screen').classList.remove('hidden');
            this.el('command-screen').classList.add('hidden');
            document.body.classList.add('in-menu');
            this.el('launch-label').textContent = window.SE_RESTORED ? 'Continue your command' : 'Enter the Reach';
            this.el('title-rank').textContent = Reach.rank(this.director.state.xp).name;
            this.el('title-fleet').textContent = `${this.director.fleet.length} operational hulls`;
            this.el('title-sector').textContent = SE.SECTOR_BY_ID[this.director.world.sectorId].name;
            this.el('title-session').textContent = window.SE_RESTORED ? 'COMMANDER FILE RESTORED' : 'A NEW INDEPENDENT CHARTER';
        }
        showPanel(panel) {
            const changed = this.panel !== panel;
            const opening = this.el('command-screen').classList.contains('hidden');
            this.title = false;
            this.panel = panel;
            this.el('title-screen').classList.add('hidden');
            this.el('command-screen').classList.remove('hidden');
            document.body.classList.add('in-menu');
            this.render();
            if (changed)
                this.el('panel-body').scrollTop = 0;
            if (opening)
                this.el('command-close').focus({ preventScroll: true });
        }
        hide() { this.title = false; this.el('title-screen').classList.add('hidden'); this.el('command-screen').classList.add('hidden'); document.body.classList.remove('in-menu'); }
        render() {
            if (!this.director.paused || this.title)
                return;
            const d = this.director;
            this.el('command-kicker').textContent = d.atPort ? 'DOCKED · STATION SERVICES' : 'FLIGHT PAUSED · INDEPENDENT COMMAND';
            this.el('command-title').textContent = d.atPort ? d.station.name : 'Command deck';
            this.el('command-credits').textContent = Reach.credits(d.world.credits);
            const tabs = this.el('panel-tabs');
            const scroll = tabs.scrollLeft;
            const focused = tabs.contains(document.activeElement);
            tabs.innerHTML = panels.map((panel) => {
                const spec = Reach.PANEL_PRESENTATION[panel];
                return `<button id="tab-${panel}" class="tab ${panel === this.panel ? 'active' : ''}" role="tab" aria-controls="panel-body" aria-selected="${panel === this.panel}" tabindex="${panel === this.panel ? 0 : -1}" data-action="panel" data-value="${panel}">${icon(spec.icon)}<span>${spec.label}</span>${spec.group === 'station' && !d.atPort ? '<small class="port-required">PORT</small>' : ''}</button>`;
            }).join('');
            tabs.scrollLeft = scroll;
            const selected = this.el('tab-' + this.panel);
            // Reveal only the horizontal tab strip; never scroll the whole game viewport.
            if (selected.offsetLeft < tabs.scrollLeft)
                tabs.scrollLeft = selected.offsetLeft;
            else if (selected.offsetLeft + selected.offsetWidth > tabs.scrollLeft + tabs.clientWidth)
                tabs.scrollLeft = selected.offsetLeft + selected.offsetWidth - tabs.clientWidth;
            if (focused)
                selected.focus({ preventScroll: true });
            this.el('panel-body').setAttribute('aria-labelledby', 'tab-' + this.panel);
            this.el('command-screen').dataset.panel = this.panel;
            const renderers = {
                overview: () => this.overview(), fleet: () => this.fleet(), contracts: () => this.contracts(), industry: () => this.industry(), factions: () => this.factions(),
                market: () => this.market(), outfit: () => this.outfit(), shipyard: () => this.shipyard(), settings: () => this.settings()
            };
            const body = this.el('panel-body');
            const active = document.activeElement;
            const restore = !!active && body.contains(active);
            const action = active?.dataset.action, value = active?.dataset.value;
            const scrollTop = body.scrollTop;
            body.innerHTML = renderers[this.panel]();
            body.scrollTop = scrollTop;
            // Transaction refreshes replace quotes and buttons. Keep keyboard focus inside the same service.
            if (restore) {
                const replacement = action ? Array.from(body.querySelectorAll('[data-action]')).find((node) => node.dataset.action === action && node.dataset.value === value && !node.disabled) : undefined;
                (replacement || body).focus({ preventScroll: true });
            }
        }
        overview() {
            const d = this.director;
            const s = d.state;
            const current = d.currentMilestone;
            const nextRank = Reach.RANKS.find((r) => r.xp > s.xp);
            const mission = current ? this.card('INDEPENDENT CHARTER · ' + (s.claimed.length + 1).toString().padStart(2, '0'), Reach.escapeHTML(current.title), Reach.escapeHTML(current.description), `<div class="progress"><i style="width:${Reach.clamp(current.progress(s) / current.target * 100, 0, 100)}%"></i></div><div class="card-foot"><span class="gold">+${Reach.credits(current.reward)} cr · ${current.xp} XP</span>${this.button('Open ' + labelForPanel[current.panel], 'panel', current.panel, false, true)}</div>`, 'featured') : this.card('CHARTER ESTABLISHED', 'The Reach is yours to shape.', 'Expand production, protect your fleet, and decide which factions deserve your support.', this.button('Manage territory', 'panel', 'industry'), 'featured');
            return `<div class="command-hero"><div class="command-emblem">${icon('fleet')}</div><div><span class="eyebrow">${Reach.escapeHTML(SE.SECTOR_BY_ID[d.world.sectorId].name)} / COMMAND OVERVIEW</span><h2>Your corner of the universe.</h2><p>${Reach.escapeHTML(d.world.player.name)} leads ${d.fleet.length} hulls. Your next move shapes the Reach.</p></div><span class="badge">${Reach.escapeHTML(Reach.rank(s.xp).name)}</span></div><div class="quick-commands">${['fleet', 'industry', 'contracts'].map((panel) => `<button data-action="panel" data-value="${panel}">${icon(Reach.PANEL_PRESENTATION[panel].icon)}<span>${panel === 'fleet' ? 'Command your fleet' : panel === 'industry' ? 'Manage production' : 'Find your next contract'}</span>${icon('arrow')}</button>`).join('')}</div><div class="overview-grid"><section>${mission}${this.supplySummary()}<div class="stat-grid"><div class="stat"><span>COMMAND RANK</span><b>${Reach.rank(s.xp).name}</b><small>${Math.floor(s.xp)} XP ${nextRank ? '/ ' + nextRank.xp + ' to ' + nextRank.name : '· highest rank'}</small></div><div class="stat"><span>YOUR FLEET</span><b>${d.fleet.length.toString().padStart(2, '0')} <em>hulls</em></b><small>${d.fleet.filter((h) => h.duty === 'mine').length} mining operations</small></div><div class="stat"><span>INDUSTRY</span><b>${s.outposts.length.toString().padStart(2, '0')} <em>facilities</em></b><small>${s.claims.length} independent sectors</small></div><div class="stat"><span>TRADE REVENUE</span><b>${Reach.credits(s.metrics.earnings)} <em>cr</em></b><small>${Math.floor(s.metrics.sold)} units delivered</small></div></div></section><section class="card log-card"><div class="eyebrow">COMMAND LOG</div><h3>A record of your influence</h3><div class="journal">${s.journal.slice(-9).reverse().map((entry) => `<div class="journal-row ${entry.kind}"><span>${Math.floor(entry.at / 60).toString().padStart(2, '0')}:${Math.floor(entry.at % 60).toString().padStart(2, '0')}</span><p>${Reach.escapeHTML(entry.message)}</p></div>`).join('')}</div></section></div>`;
        }
        fleet() {
            const d = this.director;
            return `<div class="section-heading"><div><h2>Your command, in motion.</h2><p>Assign a role. Miners work independently; escorts travel with your flagship.</p></div><span class="badge">${d.fleet.length} / 24 HULLS</span></div><div class="cards">${d.fleet.map((ship) => {
                const hull = SE.stats(ship);
                const hp = Math.round(ship.hull / ship.hullMax * 100);
                const role = ship.isPlayer ? 'Flagship · direct control' : (ship.duty || ship.orders[0]?.type || 'ready');
                return `<article class="card ship-card ${ship.isPlayer ? 'featured' : ''}"><div class="ship-glyph">${icon(ship.cls === 'extractor' ? 'ore' : ship.cls === 'dreadnought' ? 'shield' : 'fleet')}</div><div class="eyebrow">${Reach.escapeHTML(hull.name)} · ${Reach.escapeHTML(SE.SECTOR_BY_ID[ship.sector].name)}</div><h3>${Reach.escapeHTML(ship.name)}</h3><p class="ship-role"><i class="signal-dot"></i>${Reach.escapeHTML(role)}</p>${ship.tradeStatus ? `<p class="small">Last trade: ${Reach.escapeHTML(ship.tradeStatus)}</p>` : ''}<div class="progress"><i style="width:${hp}%"></i></div><div class="mini-stats"><span>HULL <b>${hp}%</b></span><span>HOLD <b>${Math.floor(SE.cargoUsed(ship))}/${ship.cargoMax}</b></span></div><div class="button-row">${ship.isPlayer ? this.button('Outfit flagship', 'panel', 'outfit') : this.button('Escort', 'order', ship.id + ':escort') + (hull.miner ? this.button('Mine & sell', 'order', ship.id + ':mine', !SE.SECTOR_BY_ID[ship.sector].belt, true) : this.button('Patrol', 'order', ship.id + ':patrol')) + this.button('Hold', 'order', ship.id + ':hold') + this.button('Take command', 'transfer', ship.id, !d.atPort)}</div></article>`;
            }).join('')}</div>`;
        }
        contracts() {
            const d = this.director;
            const active = d.world.contracts.map((c) => {
                const progress = c.type === 'HAUL' ? `${Math.floor(d.world.player.cargo[c.good] || 0)}/${c.need} ${SE.GOODS[c.good].name} aboard` : c.type === 'ESCORT' ? 'Escort in transit' : `${c.done}/${c.need} targets neutralised`;
                return this.card('ACTIVE · ' + c.type, Reach.escapeHTML(c.title), `${Reach.escapeHTML(progress)} · ${Reach.escapeHTML(SE.SECTOR_BY_ID[c.sector]?.name || c.sector)}`, `<div class="card-foot"><span class="gold">${Reach.credits(c.reward)} cr</span><div class="button-row">${this.button('Plot course', 'course', c.sector)}${c.type === 'HAUL' ? this.button('Deliver', 'deliver', '', !d.atPort) : ''}</div></div>`, 'featured');
            }).join('');
            const offers = d.atPort ? d.scene.missions.board(d.station) : [];
            return `<div class="section-heading"><div><h2>Work worth doing.</h2><p>Contracts respond to actual threats and shortages in the Reach. Completing one earns faction standing.</p></div><span class="badge">${d.world.contracts.length} ACTIVE</span></div><div class="cards">${active || this.card('YOUR CONTRACTS', 'No active assignments', 'Dock at a friendly port to accept local work. Your fleet’s combat victories count too.')}</div><h2 class="subheading">${d.atPort ? 'Station opportunities' : 'Visit a port for new opportunities'}</h2><div class="cards">${offers.map((c) => this.card(c.type + ' · ' + Reach.escapeHTML(SE.FACTIONS[c.faction]?.short || 'LOCAL'), Reach.escapeHTML(c.title), Reach.escapeHTML(c.blurb), `<div class="card-foot"><span class="gold">${Reach.credits(c.reward)} cr</span>${this.button('Accept contract', 'accept', c.id, d.world.contracts.length >= 3, true)}</div>`)).join('')}</div>`;
        }
        portNotice() { return `<div class="port-notice">${icon('port')}<div><h2>Station services are within reach.</h2><p>Dock to trade, commission ships and change your loadout. Navigation assist can fly you to the nearest friendly port.</p>${this.button('Fly to port', 'navigate', 'port', false, true)}</div></div>`; }
        market() {
            const d = this.director;
            if (!d.atPort)
                return this.portNotice();
            const me = d.world.player;
            const station = d.station;
            const stock = d.world.stationStock[station.id] || {};
            const account = d.economy.station(station);
            const rows = Reach.GOODS.map((good) => {
                const buy = d.economy.quote(me, station, good, 'buy', 10);
                const sell = d.economy.quote(me, station, good, 'sell', Math.floor(me.cargo[good] || 0));
                const reserved = d.economy.reservedAt(station, good);
                return `<div class="market-row"><div class="commodity">${icon(good === 'cells' ? 'bolt' : good === 'alloy' ? 'shield' : 'ore')}<div><b>${SE.GOODS[good].name}</b>${reserved ? `<small>${Math.floor(reserved)} committed to builds</small>` : ''}</div></div><span data-label="AVAILABLE">${Math.floor(stock[good] || 0)}</span><span data-label="ABOARD">${Math.floor(me.cargo[good] || 0)}</span><span data-label="BUY / SELL"><b class="gold">${d.buyPrice(station, good).toFixed(2)}</b> / ${d.world.priceAt(station.id, good).toFixed(2)} cr</span><div class="button-row">${this.economicButton(buy.quantity ? `Buy ${buy.quantity} · ${(buy.amount / 100).toFixed(2)} cr` : 'Buy · unavailable', 'buy-good', good, !buy.quantity)}${this.economicButton(sell.quantity ? `Sell ${sell.quantity} · ${(sell.amount / 100).toFixed(2)} cr` : 'Sell · unavailable', 'sell-good', good, !sell.quantity)}</div></div>`;
            }).join('');
            return `<div class="section-heading"><div><h2>Supply changes the Reach.</h2><p>${Reach.escapeHTML(d.economy.profile(station).name)} · Available stock excludes construction reserves. Button totals include the price impact of every unit.</p></div><span class="badge">HOLD ${Math.floor(SE.cargoUsed(me))} / ${me.cargoMax}</span></div>${this.supplySummary()}<div class="market-table"><div class="market-row table-head"><span>COMMODITY</span><span>AVAILABLE</span><span>ABOARD</span><span>NEXT UNIT · BUY / SELL</span><span>EXACT TRADE TOTAL</span></div>${rows}</div><p class="small">Station purchasing budget: ${(account.treasury / 100).toFixed(2)} cr. Quotes are local and current. Docked menus pause production; resume flight to advance build timers.</p><div class="service-strip"><div><strong>Ship services</strong><p>Hull ${Math.ceil(me.hull)} / ${me.hullMax} · repairs include shield recharge</p></div>${this.button(d.repairCost ? `Repair · ${Reach.credits(d.repairCost)} cr` : 'Hull intact', 'repair', '', !d.repairCost || d.world.credits < d.repairCost)}${this.button('Deliver contracts', 'deliver', '')}</div>`;
        }
        outfit() {
            const d = this.director;
            if (!d.atPort)
                return this.portNotice();
            const me = d.world.player;
            const fitted = SE.fittedModules(me);
            const slots = SE.slotsFor(me.cls);
            const slotText = SE.MODULE_CATS.map((c) => `${c} ${(me.fit?.[c] || []).length}/${slots[c] || 0}`).join(' · ');
            return `<div class="section-heading"><div><h2>A ship with a purpose.</h2><p>${Reach.escapeHTML(me.name)} · ${slotText}</p></div><span class="badge">${fitted.length} MODULES</span></div><div class="loadout-strip">${fitted.length ? fitted.map((m) => `<div class="loadout-item"><b>${Reach.escapeHTML(m.name)}</b>${this.button('Remove · +' + Reach.credits(Math.round(m.cost * 0.5)) + ' cr', 'unfit', m.id)}</div>`).join('') : '<p>No modules fitted. Choose a role and build around it.</p>'}</div><div class="cards">${Object.values(SE.MODULES).map((m) => {
                const error = SE.canFitModule(me, m.id);
                const stats = error ? [] : SE.previewFit(me, m.id, false);
                return this.card(m.cat.toUpperCase() + ' · ' + m.grade, Reach.escapeHTML(m.name), Reach.escapeHTML(m.blurb), `<div class="module-diff">${stats.slice(0, 5).map((r) => `<span class="${r.good ? 'positive' : 'negative'}">${r.label} ${r.from} → ${r.to}</span>`).join('')}</div><div class="card-foot"><b class="gold">${Reach.credits(m.cost)} cr</b>${this.button(error ? 'Slots full' : 'Buy & fit', 'fit', m.id, !!error || d.world.credits < m.cost, true)}</div>`);
            }).join('')}</div>`;
        }
        shipyard() {
            const d = this.director;
            if (!d.atPort)
                return this.portNotice();
            const station = d.station;
            if (!d.economy.profile(station).yard)
                return this.card('STATION CAPABILITIES', 'Production and trade hub', `${Reach.escapeHTML(station.name)} supplies materials. Reach Anchorage, Gate Watch and Rest Station have construction berths.`, this.button('Course to Reach Anchorage', 'course', 'home', false, true));
            const jobs = d.economy.jobsAt(station).map((job) => {
                const materials = Reach.GOODS.filter((good) => (job.materials[good] || 0) > 0).map((good) => {
                    const remaining = d.economy.need(job, good);
                    const source = remaining ? d.economy.sourceFor(good, station) : undefined;
                    return `<div class="material-row"><span>${SE.GOODS[good].name}</span><strong class="${remaining ? 'gold' : 'positive'}">${job.phase === 'waiting' ? Math.floor(job.reserved[good] || 0) : job.materials[good]} / ${job.materials[good]}</strong>${remaining && source ? this.button('Source · ' + SE.SECTOR_BY_ID[source.sector].name, 'course', source.sector) : ''}</div>`;
                }).join('');
                return this.card(job.owned ? 'YOUR COMMISSION' : 'CIVIC COMMISSION · LOCAL DEFENCE', Reach.escapeHTML(job.name), Reach.escapeHTML(job.status), `<div class="progress"><i style="width:${job.progress / job.duration * 100}%"></i></div><div class="build-materials">${materials}</div><p class="small">${job.phase === 'waiting' ? 'Sell missing materials to this station. The first waiting job reserves them automatically.' : job.phase === 'complete' ? 'Construction complete. This hull is now an independent ship in the universe.' : `${Math.ceil(job.duration - job.progress)} seconds of flight remaining. Construction continues in distant sectors.`}</p>${job.owned && job.phase === 'waiting' ? this.economicButton('Cancel · refund ' + Reach.credits(job.price / 100) + ' cr', 'cancel-build', job.id) : ''}`, job.phase === 'complete' ? '' : 'featured');
            }).join('');
            const offers = Reach.HULLS.map((offer) => {
                const hull = SE.CLASSES[offer.id];
                const build = Reach.BUILD_DEFINITIONS[offer.id];
                const locked = d.state.xp < offer.xp;
                const needs = Reach.GOODS.filter((good) => !!build.materials[good]).map((good) => `${build.materials[good]} ${SE.GOODS[good].name}`).join(' · ');
                return this.card(hull.tier.toUpperCase() + ' CLASS', hull.name, offer.role, `<p class="stock-line">${needs} · ${build.seconds}s construction</p><p class="small">Materials come from the station warehouse. Your payment is held until construction starts; waiting orders can be cancelled for a full refund.</p><div class="card-foot"><b class="gold">${Reach.credits(offer.price)} cr</b>${this.economicButton(locked ? offer.xp + ' XP required' : 'Commission', 'buy-ship', offer.id, locked || d.world.credits < offer.price, true)}</div>`);
            }).join('');
            return `<div class="section-heading"><div><h2>Materials become a fleet.</h2><p>One construction berth, four queue slots. Supply the first job to release the berth for the next. Resume flight to advance construction.</p></div><span class="badge">${d.fleet.length} + ${d.economy.pendingOwned()} QUEUED / 24</span></div><div class="cards">${jobs || this.card('CONSTRUCTION QUEUE', 'Berth available', 'Commission a hull below. Station inventory will supply its construction.')}</div><h2 class="subheading">Commission a hull</h2><div class="cards">${offers}</div>`;
        }
        stationProduction() {
            const d = this.director;
            return `<h2 class="subheading">Station supply network</h2><div class="cards">${Object.values(d.economy.state.stations).map((account) => {
                const station = d.world.get(account.id);
                if (!station)
                    return '';
                const production = account.production.map((slot) => {
                    const recipe = Reach.STATION_RECIPES[slot.recipe];
                    const input = Reach.GOODS.filter((good) => !!recipe.inputs[good]).map((good) => `${recipe.inputs[good]} ${SE.GOODS[good].name}`).join(' + ') || 'Solar energy';
                    const output = Reach.GOODS.filter((good) => !!recipe.outputs[good]).map((good) => `${recipe.outputs[good]} ${SE.GOODS[good].name}`).join(' + ');
                    return `<div class="production-row"><strong>${recipe.name}</strong><span>${Reach.escapeHTML(slot.status)}</span><p>${input} → ${output} / ${recipe.seconds}s</p><div class="progress"><i style="width:${slot.progress / recipe.seconds * 100}%"></i></div></div>`;
                }).join('');
                return this.card(Reach.escapeHTML(SE.SECTOR_BY_ID[station.sector].name), Reach.escapeHTML(station.name), Reach.escapeHTML(d.economy.profile(station).name), production + this.button('Plot course', 'course', station.sector));
            }).join('')}</div>`;
        }
        industry() {
            const d = this.director;
            const sector = SE.SECTOR_BY_ID[d.world.sectorId];
            const facilities = d.state.outposts.map((p) => {
                const recipe = Reach.INDUSTRIES.find((r) => r.id === p.kind);
                const contents = Reach.GOODS.filter((g) => p.stock[g] > 0).map((g) => `${Math.floor(p.stock[g])} ${SE.GOODS[g].name}`).join(' · ');
                return this.card(`${Reach.escapeHTML(SE.SECTOR_BY_ID[p.sector].name)} · LEVEL ${p.level}`, recipe.name, Reach.escapeHTML(p.status), `<div class="progress"><i style="width:${p.cycle / recipe.seconds * 100}%"></i></div><p class="stock-line">${contents || 'Storage empty'} · 600 / commodity capacity</p><div class="button-row">${this.button('Collect output', 'collect', p.id, p.sector !== sector.id)}${this.button(p.online ? 'Suspend' : 'Resume', 'toggle-industry', p.id)}${this.button(p.level >= 3 ? 'Maximum level' : 'Upgrade · ' + Reach.credits(recipe.cost * 0.7 * p.level) + ' cr', 'upgrade-industry', p.id, p.level >= 3)}</div>`);
            }).join('');
            return `<div class="section-heading"><div><h2>Build a lasting presence.</h2><p>Production runs during flight, including in distant sectors. Collect output in person; local facilities share recipe inputs.</p></div><span class="badge">${d.state.outposts.length} FACILITIES</span></div><div class="territory-strip"><div><strong>${Reach.escapeHTML(sector.name)}</strong><p>Authority: ${Reach.escapeHTML(sector.owner ? SE.FACTIONS[sector.owner]?.name || 'Independent command' : 'Unclaimed')} · Your influence: ${Math.floor(d.state.influence[sector.id] || 0)} / 100</p></div>${this.button(sector.owner === 'player' ? 'Charter established' : 'Register charter · 3,000 cr', 'claim', '', !!sector.owner || (d.state.influence[sector.id] || 0) < 60)}</div>${facilities ? '<div class="cards">' + facilities + '</div><h2 class="subheading">Expand local infrastructure</h2>' : ''}<div class="cards">${Reach.INDUSTRIES.map((r) => this.card('CONSTRUCTION · ' + Reach.escapeHTML(sector.name), r.name, r.description, `<div class="recipe"><span>+${r.quantity} ${SE.GOODS[r.good].name} / ${r.seconds}s</span><span>−${r.upkeep} cr${r.input ? ' · −' + r.input.quantity + ' ' + SE.GOODS[r.input.good].name : ''} per cycle</span></div><div class="card-foot"><b class="gold">${Reach.credits(r.cost)} cr</b>${this.button('Construct', 'build', r.id, d.world.credits < r.cost || (r.id === 'extractor' && !sector.belt), true)}</div>`)).join('')}</div>${this.stationProduction()}`;
        }
        factions() {
            const d = this.director;
            return `<div class="section-heading"><div><h2>Every alliance has a price.</h2><p>Contracts earn standing. Attacks damage it. Trusted captains receive lower market prices; hostile factions deny docking and engage your fleet.</p></div></div><div class="cards faction-cards">${Reach.FACTIONS.map((id) => {
                const faction = SE.FACTIONS[id];
                const value = d.state.reputation[id];
                const standing = value < -60 ? 'Hunted' : value < -20 ? 'Hostile' : value <= 20 ? 'Neutral' : value <= 60 ? 'Trusted' : 'Allied';
                return `<article class="card faction-card" style="--faction:#${faction.colour.toString(16).padStart(6, '0')}"><div class="faction-seal">${faction.short}</div><div class="eyebrow">${standing.toUpperCase()} · ${value > 0 ? '+' : ''}${value} STANDING</div><h3>${Reach.escapeHTML(faction.name)}</h3><p>${Reach.escapeHTML(faction.blurb)}</p><div class="standing"><i style="width:${(value + 100) / 2}%"></i></div><p class="small">Send 8 Energy Cells as relief: +12 standing. Each faction accepts one shipment per 120 seconds of flight.</p>${this.button('Dispatch relief', 'relief', id, (d.world.player.cargo.cells || 0) < 8)}</article>`;
            }).join('')}</div>`;
        }
        settings() {
            const settings = this.director.state.settings;
            return `<div class="section-heading"><div><h2>Your bridge. Your controls.</h2><p>Portrait and landscape touch. Keyboard flight supports W/A/S/D, Q/E throttle, Space fire, Shift boost, B brake, T target, F interact, M chart, C recenter, and Escape pause.</p></div></div><div class="settings-grid"><section class="card"><div class="eyebrow">FLIGHT & DISPLAY</div><label class="setting-row"><span>Steering sensitivity</span><input aria-label="Steering sensitivity" data-setting="sensitivity" type="range" min="0.4" max="1.6" step="0.1" value="${this.director.scene.controls.sens}"></label><label class="setting-row"><span>Graphics</span><select aria-label="Graphics quality" data-setting="quality">${['auto', 'low', 'medium', 'high'].map((q) => `<option value="${q}" ${settings.quality === q ? 'selected' : ''}>${q === 'auto' ? 'Adaptive' : q[0].toUpperCase() + q.slice(1)}</option>`).join('')}</select></label><label class="setting-row"><span>Assisted targeting <small>Small aim cone; you still line up the target.</small></span><input type="checkbox" data-setting="aimAssist" ${settings.aimAssist ? 'checked' : ''}></label><label class="setting-row"><span>Reduce interface motion</span><input type="checkbox" data-setting="reducedMotion" ${settings.reducedMotion ? 'checked' : ''}></label><label class="setting-row"><span>Sound effects</span><input type="checkbox" data-setting="sound" ${settings.sound ? 'checked' : ''}></label></section><section class="card"><div class="eyebrow">COMMANDER FILE</div><h3>Keep your progress with you.</h3><p>Progress autosaves during flight and after important commands. Export a backup before changing devices or browsers.</p><div class="button-row">${this.button(icon('save') + ' Save now', 'save')}${this.button('Export backup', 'export')}${this.button('Import backup', 'import')}</div><input id="save-import" type="file" accept="application/json,.json" class="hidden"><div id="save-note" class="small"></div><div class="control-guide"><strong>Touch flight</strong><p>Left thumb: steer. Right slider: set speed. Large right trigger: fire. Tap a visible ship to target it; use ORE to find and approach a seam. Navigation assist yields whenever you steer.</p><strong>Independent camera</strong><p>Tap LOOK and drag open space to orbit while moving. Pinch or use − / + to zoom. CENTER returns behind the ship without cancelling its course.</p></div></section></div><details class="card diagnostics"><summary>Simulation diagnostics</summary><p class="small">Economy work p95 ${this.director.economy.workP95.toFixed(2)} ms · peak ${this.director.economy.diagnostics.peakMilliseconds.toFixed(2)} ms. ${this.director.economy.diagnostics.transactions} transaction attempts this session; ${this.director.economy.state.receipts.length} recent receipts retained.</p><p class="small">${this.director.world.registry.all.length} entities · ${Object.keys(this.director.scene.views).length} local ship views · ${this.director.scene.motionClock.ticks} physics steps · ${this.director.scene.motionClock.droppedSeconds.toFixed(2)}s discarded stall debt. Economy timings measure economic work only, not total frame rate.</p></details>`;
        }
        updateHUD() {
            const d = this.director, me = d.world.player;
            if (!me)
                return;
            const ui = this.instruments;
            const health = Reach.clamp(me.hull / Math.max(1, me.hullMax) * 100, 0, 100);
            const sector = SE.SECTOR_BY_ID[d.world.sectorId];
            ui.text('sector-authority', sector.owner ? (SE.FACTIONS[sector.owner]?.short || 'INDEPENDENT') + ' JURISDICTION' : 'UNCLAIMED SPACE');
            ui.text('sector', sector.name);
            ui.text('credits', Reach.credits(d.world.credits));
            ui.meter('hull', health);
            ui.meter('shield', me.shield / Math.max(1, me.shieldMax) * 100);
            ui.text('hull-value', Math.ceil(me.hull) + ' / ' + me.hullMax);
            ui.text('shield-value', Math.ceil(me.shield) + ' / ' + me.shieldMax);
            ui.text('ship-name', me.name);
            ui.text('ship-class', SE.CLASSES[me.cls].name.toUpperCase());
            ui.text('speed', Math.round(d.scene.speed || 0).toString());
            ui.text('cargo', `${Math.floor(SE.cargoUsed(me))} / ${me.cargoMax}`);
            ui.text('ship-condition', health < 30 ? 'CRITICAL' : health < 70 ? 'DAMAGED' : 'NOMINAL');
            ui.state('vitals', 'data-condition', health < 30 ? 'critical' : health < 70 ? 'damaged' : 'nominal');
            ui.meter('boost-fill', d.driveEnergy);
            const current = d.currentMilestone;
            ui.text('objective-title', current?.title || 'Build your legacy');
            ui.text('objective-progress', current ? `${Math.min(current.target, Math.floor(current.progress(d.state)))}/${current.target} · +${Reach.credits(current.reward)} cr` : `${d.state.claims.length} sectors under your charter`);
            ui.meter('objective-fill', current ? current.progress(d.state) / Math.max(1, current.target) * 100 : 100);
            ui.text('context-button', d.nearbyPort ? 'DOCK AT PORT' : d.navigation ? 'CANCEL ASSIST' : d.scene.course ? 'FLY TO GATE' : 'FLY TO PORT');
            ui.state('context-button', 'data-engaged', String(!!d.navigation));
            ui.text('nav-status', d.navigation ? 'AUTOPILOT / ' + d.navigation.toUpperCase() : 'MANUAL FLIGHT');
            ui.state('hud', 'data-navigation', d.navigation ? 'auto' : 'manual');
            const target = d.scene.playerTarget ? d.world.get(d.scene.playerTarget) : undefined;
            this.el('target-info').classList.toggle('hidden', !target || !!target.dead);
            if (target && !target.dead) {
                ui.text('target-name', target.name);
                ui.text('target-range', Math.round(Reach.distance(me, target)) + ' m · ' + Math.ceil(target.hull / target.hullMax * 100) + '% HULL');
                ui.meter('target-fill', target.hull / Math.max(1, target.hullMax) * 100);
            }
            ui.text('flight-rank', Reach.rank(d.state.xp).name);
        }
        navigateKeys(event) {
            if (this.el('command-screen').classList.contains('hidden'))
                return;
            const active = document.activeElement;
            if (active?.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const index = panels.indexOf(this.panel);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length;
                this.showPanel(panels[next]);
                this.el('tab-' + panels[next]).focus({ preventScroll: true });
                return;
            }
            if (event.key !== 'Tab')
                return;
            const elements = Array.from(this.el('command-screen').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0);
            if (!elements.length)
                return;
            const first = elements[0], last = elements[elements.length - 1];
            if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        }
        toast(message, kind = 'info') {
            if (!message || message === this.lastToast)
                return;
            this.lastToast = message;
            const root = this.el('toast');
            root.textContent = message;
            root.className = 'toast on ' + kind;
            if (this.toastTimer)
                clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => { root.classList.remove('on'); this.lastToast = ''; }, 4300);
        }
        flashDamage() { document.body.classList.add('damage'); if (this.damageTimer)
            clearTimeout(this.damageTimer); this.damageTimer = setTimeout(() => document.body.classList.remove('damage'), 220); }
        flashHit() { this.el('hit-marker').classList.add('on'); if (this.hitTimer)
            clearTimeout(this.hitTimer); this.hitTimer = setTimeout(() => this.el('hit-marker').classList.remove('on'), 110); }
        click(event) {
            const button = event.target?.closest('[data-action]');
            if (!button || button.disabled)
                return;
            const action = button.dataset.action || '';
            const value = button.dataset.value || '';
            const d = this.director;
            d.audio.unlock();
            switch (action) {
                case 'launch':
                case 'resume':
                    d.resume();
                    break;
                case 'panel':
                    if (panels.includes(value))
                        d.pause(value);
                    break;
                case 'objective':
                    d.pause(d.currentMilestone?.panel || 'overview');
                    break;
                case 'menu':
                    d.pause();
                    break;
                case 'title':
                    d.pause();
                    this.showTitle();
                    break;
                case 'chart':
                    d.openChart();
                    break;
                case 'chart-close':
                    d.resume();
                    break;
                case 'chart-course': {
                    const to = d.scene.galaxy.picked;
                    if (to) {
                        d.scene.setCourse(to);
                        d.resume();
                        d.setNavigation('gate');
                    }
                    break;
                }
                case 'course':
                    if (SE.SECTOR_BY_ID[value]) {
                        d.scene.setCourse(value);
                        d.resume();
                        if (value !== d.world.sectorId)
                            d.setNavigation('gate');
                    }
                    break;
                case 'context':
                    d.contextAction();
                    break;
                case 'navigate':
                    if (value === 'port' || value === 'mine' || value === 'gate') {
                        d.resume();
                        d.setNavigation(value);
                    }
                    break;
                case 'target':
                    d.targetNearest();
                    break;
                case 'brake':
                    d.brake();
                    break;
                case 'order': {
                    const [shipId, role] = value.split(':');
                    if (['escort', 'mine', 'hold', 'patrol'].includes(role))
                        d.execute({ type: 'fleet.order', shipId, role: role });
                    break;
                }
                case 'transfer':
                    d.execute({ type: 'fleet.transfer', shipId: value });
                    break;
                case 'buy-ship':
                    d.execute({ type: 'ship.buy', hullId: value, request: Number(button.dataset.request) });
                    break;
                case 'cancel-build':
                    d.execute({ type: 'ship.cancel', jobId: value, request: Number(button.dataset.request) });
                    break;
                case 'buy-good':
                case 'sell-good':
                    if (Reach.GOODS.includes(value))
                        d.execute({ type: action === 'buy-good' ? 'market.buy' : 'market.sell', good: value, request: Number(button.dataset.request), revision: Number(button.dataset.revision), quantity: action === 'buy-good' ? 10 : Math.floor(d.world.player.cargo[value] || 0) });
                    break;
                case 'fit':
                case 'unfit':
                    d.execute({ type: action === 'fit' ? 'module.fit' : 'module.remove', moduleId: value });
                    break;
                case 'repair':
                    d.execute({ type: 'ship.repair' });
                    break;
                case 'accept':
                    d.execute({ type: 'contract.accept', id: value });
                    break;
                case 'deliver':
                    d.execute({ type: 'contract.deliver' });
                    break;
                case 'build':
                    if (Reach.INDUSTRIES.some((r) => r.id === value))
                        d.execute({ type: 'industry.build', kind: value });
                    break;
                case 'collect':
                case 'upgrade-industry':
                case 'toggle-industry':
                    d.execute({ type: action === 'collect' ? 'industry.collect' : action === 'upgrade-industry' ? 'industry.upgrade' : 'industry.toggle', id: value });
                    break;
                case 'claim':
                    d.execute({ type: 'sector.claim' });
                    break;
                case 'relief':
                    if (Reach.FACTIONS.includes(value))
                        d.execute({ type: 'faction.relief', faction: value });
                    break;
                case 'save':
                    void d.scene.autosave(true).then((bytes) => this.toast(bytes ? 'Commander file saved.' : 'Save failed. Export a backup to protect this session.', bytes ? 'gain' : 'warn')).catch(() => this.toast('Save failed. Export a backup to protect this session.', 'warn'));
                    break;
                case 'export':
                    this.exportSave();
                    break;
                case 'import':
                    this.el('save-import').click();
                    break;
            }
        }
        change(event) {
            const target = event.target;
            if (target.id === 'save-import') {
                const file = target.files?.[0];
                if (file)
                    void this.importSave(file);
                return;
            }
            const key = target.dataset.setting;
            if (!key)
                return;
            const d = this.director;
            const settings = d.state.settings;
            if (key === 'sensitivity')
                d.scene.controls.sens = Reach.clamp(Number(target.value), 0.4, 1.6);
            else if (key === 'quality' && ['auto', 'low', 'medium', 'high'].includes(target.value))
                settings.quality = target.value;
            else if (key === 'aimAssist' || key === 'sound' || key === 'reducedMotion')
                settings[key] = target.checked;
            d.applySettings();
            d.audio.unlock();
            void d.scene.autosave(true);
        }
        exportSave() {
            const json = JSON.stringify(SE.snapshot(this.director.world), null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'Tarpon-Reach-Commander.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.toast('Commander backup exported.', 'gain');
        }
        async importSave(file) {
            try {
                if (file.size > 8 * 1024 * 1024)
                    throw new Error('Backup exceeds the 8 MB limit.');
                const snapshot = SE.validateSnapshot(JSON.parse(await file.text()));
                if (!window.confirm('Replace the current commander with this backup? A recovery copy of the current save will be retained.'))
                    return;
                // Suppress exit/visibility autosaves before replacing the active commander.
                // Otherwise pagehide can queue the old world after the imported snapshot.
                const scene = this.director.scene;
                scene._gone = true;
                try {
                    await scene.persist.save(snapshot);
                }
                catch (error) {
                    scene._gone = false;
                    throw error;
                }
                location.reload();
            }
            catch (error) {
                this.toast(error instanceof Error ? error.message : 'Unable to import this commander file.', 'warn');
            }
        }
        dispose() {
            this.instruments.clear();
            document.removeEventListener('keydown', this.keyListener);
            document.removeEventListener('click', this.clickListener);
            document.removeEventListener('change', this.changeListener);
            if (this.toastTimer)
                clearTimeout(this.toastTimer);
            if (this.damageTimer)
                clearTimeout(this.damageTimer);
            if (this.hitTimer)
                clearTimeout(this.hitTimer);
        }
    }
    Reach.Shell = Shell;
})(Reach || (Reach = {}));
