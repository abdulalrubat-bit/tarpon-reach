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
            sound: 'M4 9h4l5-5v16l-5-5H4zm12-1c3 3 3 5 0 8m3-11c5 4 5 10 0 14', bars: 'M4 6h16M4 12h16M4 18h16', crown: 'M3 19h18M4 16 3 7l5 4 4-7 4 7 5-4-1 9z'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.diamond}"/></svg>`;
    }
    Reach.icon = icon;
    const labelForPanel = { overview: 'Command', fleet: 'Fleet', contracts: 'Contracts', industry: 'Industry', factions: 'Factions', market: 'Market', outfit: 'Outfitting', shipyard: 'Shipyard', settings: 'Settings' };
    const panels = ['overview', 'empire', 'fleet', 'contracts', 'industry', 'factions', 'market', 'outfit', 'shipyard', 'settings'];
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
            const body = this.el('panel-body');
            for (const type of ['pointermove', 'pointerdown', 'pointerleave'])
                body.addEventListener(type, (event) => this.graphHover(event));
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
            this.el('command-kicker').textContent = d.atPort ? 'DOCKED · STATION SERVICES' : 'GALAXY PAUSED · INDEPENDENT COMMAND';
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
                overview: () => this.overview(), empire: () => this.empire(), fleet: () => this.fleet(), contracts: () => this.contracts(), industry: () => this.industry(), factions: () => this.factions(),
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
        /* ---- The empire dashboard --------------------------------------------
           One screen to glance at and leave: how big, how rich, what is wrong,
           how it has grown, and what to do next. Everything on it is a button
           to somewhere you can act on it. */
        empire() {
            const d = this.director, s = d.state, world = d.world, S = d.scene.sieges;
            const esc = Reach.escapeHTML, name = (id) => esc(SE.SECTOR_BY_ID[id].name);
            const held = [...s.claims.map((id) => ({ id, kind: 'Charter' })), ...s.conquests.map((c) => ({ id: c.sector, kind: 'Captured', from: c.from }))];
            const actual = d.actualIncome, potential = d.incomePerMinute;
            const warships = d.fleet.filter((x) => !SE.CLASSES[x.cls].miner && x.cls !== 'freighter').length;
            const miners = d.fleet.filter((x) => SE.CLASSES[x.cls].miner).length;
            const tiles = `<div class="emp-tiles">
                <div class="emp-tile"><span>SYSTEMS</span><b>${held.length}</b><small>${s.claims.length} chartered · ${s.conquests.length} captured</small></div>
                <div class="emp-tile"><span>EARNING NOW</span><b class="gold">${actual === null ? 'measuring…' : (actual >= 0 ? '+' : '') + Reach.credits(actual)}</b><small>cr a minute, measured · potential ${potential >= 0 ? '+' : ''}${Reach.credits(potential)}</small></div>
                <div class="emp-tile"><span>FLEET</span><b>${d.fleet.length}</b><small>${warships} warship${warships === 1 ? '' : 's'} · ${miners} miner${miners === 1 ? '' : 's'}</small></div>
                <div class="emp-tile"><span>CAPITAL</span><b>${Reach.credits(world.credits)}</b><small>credits</small></div></div>`;
            // Go there: a course from the map, or the system view if the fleet is already there.
            const goto = (id, label) => world.sectorId === id ? `<button class="button" data-action="sys-open" data-value="${id}">View</button>` : `<button class="button" data-action="course" data-value="${id}">${label || 'Go'}</button>`;
            const threats = [];
            for (const b of d.scene.battles ? d.scene.battles.list : [])
                threats.push({ level: 'critical', text: `Battle in <b>${name(b.sector)}</b> · ${b.foes.size} hostile${b.foes.size === 1 ? '' : 's'}`, button: `<button class="button" data-action="sys-open" data-value="${b.sector}">Command</button>` });
            if (S) {
                for (const x of S.underAttack())
                    threats.push(x.left !== null
                        ? { level: 'critical', text: `<b>${name(x.sector)}</b> is undefended · lost in ${x.left}s`, button: goto(x.sector, 'Defend') }
                        : { level: 'serious', text: `<b>${name(x.sector)}</b> under attack · garrison holding`, button: goto(x.sector, 'Defend') });
                for (const g of S.incoming())
                    threats.push({ level: 'serious', text: `${esc(SE.FACTIONS[g.faction].short)} strike group (${g.ships}) heading for <b>${name(g.to)}</b>${g.jumps ? ` · ${g.jumps} jump${g.jumps === 1 ? '' : 's'} out` : ''}`, button: goto(g.to, 'Defend') });
                for (const x of S.active)
                    threats.push({ level: 'info', text: `Your siege of <b>${name(x.sector)}</b> · ${x.phase === 'defences' ? x.guns.length + ' platforms left' : x.phase === 'contested' ? 'guard ships left' : x.phase === 'sieging' ? Math.floor(x.progress * 100) + '%' : x.phase === 'outside' ? 'stalled, ships too far from the station' : 'stalled, no warships'}`, button: `<button class="button" data-action="sys-open" data-value="${x.sector}">View</button>` });
            }
            const wars = Reach.FACTIONS.filter((f) => s.wars[f]);
            const warLine = wars.length ? `<div class="emp-wars">At war with ${wars.map((f) => `<span class="emp-chip" style="--faction:#${SE.FACTIONS[f].colour.toString(16).padStart(6, '0')}">${esc(SE.FACTIONS[f].name)}</span>`).join(' ')}<button class="button" data-action="panel" data-value="factions">Factions</button></div>` : '';
            const icons = { critical: '⚠', serious: '⚠', info: '🏰' };
            const threatCard = `<section class="card emp-card"><div class="eyebrow">THREATS</div>${warLine}${threats.length ? `<div class="emp-threats">${threats.map((t) => `<div class="emp-threat ${t.level}"><span class="emp-ti" aria-hidden="true">${icons[t.level]}</span><p>${t.text}</p>${t.button}</div>`).join('')}</div>` : `<p class="emp-quiet">✓ All quiet. No raids, strikes or fights involving your ships.</p>`}</section>`;
            const graphCard = `<section class="card emp-card"><div class="eyebrow">INCOME PER MINUTE · MEASURED</div>${this.incomeGraph(s.history)}</section>`;
            const stuck = d.blocked;
            const attentionCard = stuck.length ? `<section class="card emp-card"><div class="eyebrow">NEEDS ATTENTION · ${stuck.length}</div><div class="emp-threats">${stuck.slice(0, 8).map((b) => `<div class="emp-threat serious"><span class="emp-ti" aria-hidden="true">!</span><p>${esc(b.text)}</p>${goto(b.sector)}</div>`).join('')}</div></section>` : '';
            const E = d.scene.events;
            const evRows = E ? E.list.map((e) => { const k = E.KINDS[e.kind], left = E.left(e); return `<div class="emp-threat ev"><span class="emp-ti" style="color:${k.colour}" aria-hidden="true">${k.icon}</span><p><b>${esc(k.title)}</b> · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left<br>${esc(e.text)}</p>${goto(e.sector)}</div>`; }).join('') : '';
            const recent = s.news.slice(-4).reverse().map((n) => `<li class="${n.kind}">${esc(n.text)}</li>`).join('');
            const eventsCard = `<section class="card emp-card"><div class="eyebrow">GALAXY EVENTS</div>${evRows ? `<div class="emp-threats">${evRows}</div>` : '<p class="emp-quiet">Nothing happening right now. Something new turns up every few minutes.</p>'}${recent ? `<div class="eyebrow">RECENT NEWS</div><ul class="emp-news">${recent}</ul>` : ''}</section>`;
            const rows = held.map((h) => {
                let income = d.charterTax(h.id), facilities = 0;
                for (const p of s.outposts)
                    if (p.sector === h.id) { income += d.economy.outpostRate(p); ++facilities; }
                return { ...h, income: Math.round(income), facilities };
            }).sort((a, b) => b.income - a.income);
            const attacked = new Set(S ? S.underAttack().map((x) => x.sector) : []);
            const systems = `<section class="card emp-card"><div class="eyebrow">YOUR SYSTEMS · ${held.length}</div>${rows.length ? `<div class="emp-systems">${rows.map((r) => `<div class="emp-sys${attacked.has(r.id) ? ' hit' : ''}"><div><strong>${name(r.id)}</strong><small>${r.kind}${r.from ? ' from ' + esc(SE.FACTIONS[r.from].short) : ''} · ${r.facilities} facilit${r.facilities === 1 ? 'y' : 'ies'}${attacked.has(r.id) ? ' · under attack' : ''}</small></div><b class="gold">+${Reach.credits(r.income)}<small>/min</small></b>${goto(r.id)}</div>`).join('')}</div>` : `<p class="emp-quiet">No systems yet. Build a facility in a grey frontier system, then claim it.</p>`}</section>`;
            const rank = Reach.rank(s.xp), next = Reach.RANKS.find((r) => r.xp > s.xp);
            const into = next ? (s.xp - rank.xp) / (next.xp - rank.xp) * 100 : 100;
            const done = s.claimed.length, total = Reach.MILESTONES.length, m = d.currentMilestone;
            const goal = m ? `<div class="emp-goal"><span class="eyebrow">NEXT · ${m.tier === 'tutorial' ? 'GETTING STARTED' : m.tier === 'side' ? 'SIDE GOAL' : 'EMPIRE GOAL'}</span><strong>${esc(m.title)}</strong><div class="progress"><i style="width:${Reach.clamp(m.progress(s) / m.target * 100, 0, 100)}%"></i></div><small>${Math.min(m.target, Math.floor(m.progress(s)))}/${m.target} · +${Reach.credits(m.reward)} cr</small>${this.guideButton(this.guide(m))}</div>` : '<p class="emp-quiet">Every goal complete. The galaxy is a sandbox now.</p>';
            const progress = `<section class="card emp-card"><div class="eyebrow">PROGRESS</div><div class="emp-rank"><strong>${esc(rank.name)}</strong><small>${Math.floor(s.xp)} XP${next ? ' · ' + (next.xp - Math.floor(s.xp)) + ' to ' + esc(next.name) : ' · highest rank'}</small></div><div class="progress"><i style="width:${into}%"></i></div><p class="small">${done} of ${total} goals complete</p>${goal}</section>`;
            return `<div class="section-heading"><div><h2>Your empire.</h2><p>Everything you hold, what it earns, and what is threatening it.</p></div><span class="badge">${esc(rank.name)}</span></div>${tiles}<div class="emp-grid">${threatCard}${attentionCard}${eventsCard}${graphCard}${systems}${progress}</div>`;
        }
        /* Income over time as one line, one hue, on one axis. Points are a game
           minute apart; tap or hover for the value. */
        incomeGraph(history) {
            if (history.length < 2)
                return '<p class="emp-quiet">The graph fills in as you play: one point every game minute.</p>';
            const W = 320, H = 132, L = 38, R = 10, T = 12, B = 22;
            const max = Math.max(60, ...history.map((h) => h.income));
            const step = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000].find((v) => max / v <= 4) || Math.ceil(max / 4);
            const top = Math.ceil(max / step) * step, min = Math.min(0, ...history.map((h) => h.income));
            const t0 = history[0].t, t1 = history[history.length - 1].t || 1;
            const x = (t) => L + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - L - R);
            const y = (v) => T + (1 - (v - min) / (top - min || 1)) * (H - T - B);
            const pts = history.map((h) => `${x(h.t).toFixed(1)},${y(h.income).toFixed(1)}`);
            const grid = [];
            for (let v = 0; v <= top; v += step)
                grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v >= 1000 ? v / 1000 + 'k' : v}</text>`);
            const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
            const last = history[history.length - 1];
            const data = history.map((h) => `${h.t},${h.income},${h.systems}`).join(';');
            return `<div class="emp-graph"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income per minute rose from ${history[0].income} to ${last.income} cr over ${Math.round((t1 - t0) / 60)} minutes" data-graph="${data}" data-box="${L},${R},${T},${B},${min},${top}">
                ${grid.join('')}<line x1="${L}" x2="${W - R}" y1="${y(Math.max(0, min))}" y2="${y(Math.max(0, min))}" class="axis"/>
                <polygon points="${x(t0)},${y(Math.max(0, min))} ${pts.join(' ')} ${x(t1)},${y(Math.max(0, min))}" class="area"/>
                <polyline points="${pts.join(' ')}" class="line"/>
                <circle cx="${x(t1)}" cy="${y(last.income)}" r="4" class="end"/>
                <text x="${L}" y="${H - 6}">${clock(t0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${clock(t1)}</text>
                <g class="hover" visibility="hidden"><line class="cross" y1="${T}" y2="${H - B}"/><circle r="4" class="dot"/></g>
              </svg><div class="emp-tip" hidden></div></div><p class="small">Now <b class="gold">+${Reach.credits(last.income)} cr/min</b> · ${last.systems} system${last.systems === 1 ? '' : 's'} · game time ${clock(t1)}</p>`;
        }
        /* Crosshair and tooltip for the income graph: the nearest sample to the
           finger, with its value and how many systems you held then. */
        graphHover(event) {
            const svg = event.target?.closest?.('svg[data-graph]');
            const box = this.el('panel-body').querySelector('.emp-graph');
            if (!box)
                return;
            const tip = box.querySelector('.emp-tip'), g = box.querySelector('.hover');
            // A finger lifting off counts as leaving; on touch the tooltip stays until the next tap.
            if (event.type === 'pointerleave' && event.pointerType === 'touch')
                return;
            if (!svg || event.type === 'pointerleave') { tip.hidden = true; g.setAttribute('visibility', 'hidden'); return; }
            const pts = svg.dataset.graph.split(';').map((p) => p.split(',').map(Number));
            const [L, R, T, B, min, top] = svg.dataset.box.split(',').map(Number);
            const W = 320, H = 132, r = svg.getBoundingClientRect();
            const vx = (event.clientX - r.left) / r.width * W;
            const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
            const t = t0 + (vx - L) / (W - L - R) * (t1 - t0);
            let best = pts[0];
            for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
            const px = L + (t1 === t0 ? 0 : (best[0] - t0) / (t1 - t0)) * (W - L - R);
            const py = T + (1 - (best[1] - min) / (top - min || 1)) * (H - T - B);
            g.setAttribute('visibility', 'visible');
            g.querySelector('.cross').setAttribute('x1', px); g.querySelector('.cross').setAttribute('x2', px);
            g.querySelector('.dot').setAttribute('cx', px); g.querySelector('.dot').setAttribute('cy', py);
            tip.hidden = false;
            tip.innerHTML = `<b>+${Reach.credits(best[1])} cr/min</b><span>${Math.floor(best[0] / 60)}:${String(best[0] % 60).padStart(2, '0')} · ${best[2]} system${best[2] === 1 ? '' : 's'}</span>`;
            const left = px / W * r.width;
            tip.style.left = Math.min(r.width - 120, Math.max(0, left - 60)) + 'px';
        }
        /* ---- The Fleet tab --------------------------------------------------
           One short row per ship, grouped by the system it is in, saying in
           plain words what it is doing. Tap a row for its jobs; tick several
           rows to order them together or make a squadron. */
        shipStatus(ship) {
            const d = this.director, me = d.world.player, here = (id) => SE.SECTOR_BY_ID[id].name;
            const o = ship.orders[0], hops = (to) => { const p = d.scene.route(ship.sector, to); return p ? p.length - 1 : 0; };
            if (ship.isPlayer)
                return d.scene.course ? `Flagship · under way to ${here(d.scene.course.to)}` : `Flagship · holding in ${here(ship.sector)}`;
            if (ship.battleOrder && o)
                return 'In battle · ' + (o.type === 'ATTACK' ? 'attacking ' + (d.world.get(o.target)?.name || 'a target') : o.type === 'WAIT' ? 'holding' : 'moving');
            switch (ship.duty) {
                case 'repair': {
                    const st = ship.repairAt && d.world.get(ship.repairAt);
                    if (!st)
                        return 'Looking for a port to repair at';
                    return st.sector === ship.sector && Math.hypot(ship.x - st.x, ship.z - st.z) < 520
                        ? `Repairing at ${st.name} · ${Math.floor(ship.hull / ship.hullMax * 100)}%`
                        : `Going to repair at ${st.name}${st.sector !== ship.sector ? ` · ${hops(st.sector)} jump${hops(st.sector) === 1 ? '' : 's'}` : ''}`;
                }
                case 'patrol': {
                    const post = ship.post || ship.sector;
                    if (post !== ship.sector)
                        return `Flying to guard ${here(post)} · ${hops(post)} jump${hops(post) === 1 ? '' : 's'}`;
                    return o && o.type === 'ATTACK' ? `Guarding ${here(post)} · attacking ${d.world.get(o.target)?.name || 'a hostile'}` : `Guarding ${here(post)}`;
                }
                case 'mine':
                    if (!SE.SECTOR_BY_ID[ship.sector].belt)
                        return 'No asteroid belt here: send it to a system with one';
                    if (o && o.type === 'JUMP')
                        return SE.cargoUsed(ship) < 1 ? `Returning to its belt in ${SE.SECTOR_BY_ID[ship.mineAt || ship.sector].name}` : (ship.noSale && d.world.elapsed < ship.noSale.until ? 'Local station is full: taking ore to another market' : 'Taking ore to market');
                    return !o ? 'Mining' : o.type === 'FLEE' ? 'Fleeing from pirates!' : o.type === 'TRADE' ? 'Selling ore at the station' : `Mining · hold ${Math.floor(SE.cargoUsed(ship))}/${ship.cargoMax}`;
                case 'hold':
                    return 'Holding position';
                default:
                    return ship.sector === me.sector ? `Escorting ${me.name}` : `Rejoining ${me.name} · ${hops(me.sector)} jump${hops(me.sector) === 1 ? '' : 's'}`;
            }
        }
        fleetBars(ship) {
            const k = Math.max(0, Math.round(ship.hull / ship.hullMax * 100)), sh = ship.shieldMax ? Math.max(0, Math.round(ship.shield / ship.shieldMax * 100)) : 0;
            return `<span class="fl-bars" title="Shield ${sh}% · Hull ${k}%"><i class="sh" style="width:${sh}%"></i><i class="hl ${k > 50 ? '' : k > 25 ? 'mid' : 'low'}" style="width:${k}%"></i></span>`;
        }
        fleet() {
            const d = this.director, s = d.state, me = d.world.player, esc = Reach.escapeHTML;
            const sel = this.fleetSel || (this.fleetSel = new Set());
            const ships = d.fleet;
            for (const id of [...sel]) if (!ships.some((x) => x.id === id)) sel.delete(id);
            d.pruneSquads();
            const squads = s.squads;
            const squadName = (id) => squads.find((q) => q.id === id)?.name;
            const ico = (ship) => `<img class="sv-ico" src="${SE.ShipArt.icon(ship.cls, 'player')}" alt="">`;
            const warships = ships.filter((x) => !x.isPlayer && !SE.CLASSES[x.cls].miner && x.cls !== 'freighter');
            const damaged = ships.filter((x) => !x.isPlayer && x.hull < x.hullMax - 0.5 && x.duty !== 'repair');
            const repairCost = Math.ceil(damaged.reduce((n, x) => n + x.hullMax - x.hull, 0));
            // A system picker, when a Send-to is in progress.
            if (this.fleetPick)
                return this.fleetPicker();
            const top = `<div class="fl-top"><div class="fl-sum"><b>${ships.length}</b> ships · ${warships.length + 1} warship${warships.length ? 's' : ''} · ${ships.filter((x) => SE.CLASSES[x.cls].miner).length} miner${ships.filter((x) => SE.CLASSES[x.cls].miner).length === 1 ? '' : 's'}${damaged.length ? ` · <span class="fl-warn">${damaged.length} damaged</span>` : ''}</div>
                <div class="button-row">${this.button('Recall all warships', 'fleet-recall', '', !warships.length)}${damaged.length ? this.button(`Repair all damaged · ~${Reach.credits(repairCost)} cr`, 'fleet-job', 'repair:' + damaged.map((x) => x.id).join(',')) : ''}</div></div>
                <details class="fl-help"><summary>What do the jobs do?</summary>${Object.values(Reach.JOBS).map((j) => `<p><b>${j.label}</b> ${esc(j.help)}</p>`).join('')}</details>`;
            const squadHtml = squads.length ? `<h3 class="fl-h">Squadrons</h3>${squads.map((q) => {
                const members = ships.filter((x) => x.squad === q.id);
                const where = [...new Set(members.map((x) => SE.SECTOR_BY_ID[x.sector].name))].join(', ');
                const ids = members.map((x) => x.id).join(',');
                const naming = this.squadEdit === q.id;
                return `<div class="fl-squad"><div class="fl-squad-head">${naming ? `<input id="squad-name" maxlength="24" value="${esc(q.name)}" aria-label="Squadron name">${this.button('Save', 'squad-rename', q.id, false, true)}` : `<strong>${esc(q.name)}</strong><button class="fl-link" data-action="squad-edit" data-value="${q.id}">Rename</button>`}<span class="fl-squad-n">${members.length} ship${members.length === 1 ? '' : 's'} · ${esc(where)}</span></div>
                    <div class="fl-squad-ships">${members.map((x) => `${ico(x)}<span>${esc(x.name)}</span>`).join('')}</div>
                    <div class="button-row fl-jobs">${this.button('Escort', 'fleet-job', 'escort:' + ids)}${this.button('Guard here', 'fleet-job', 'patrol:' + ids)}${this.button('Send to…', 'fleet-send', ids)}${this.button('Hold', 'fleet-job', 'hold:' + ids)}${this.button('Disband', 'squad-disband', q.id)}</div></div>`;
            }).join('')}` : '';
            // Ships grouped by system, the flagship's first.
            const bySector = new Map();
            for (const ship of [me, ...ships.filter((x) => !x.isPlayer)]) {
                if (!bySector.has(ship.sector)) bySector.set(ship.sector, []);
                bySector.get(ship.sector).push(ship);
            }
            const groups = [...bySector.entries()].map(([sector, list]) => `<h3 class="fl-h">${esc(SE.SECTOR_BY_ID[sector].name)} <small>${list.length} ship${list.length === 1 ? '' : 's'}${sector === me.sector ? ' · flagship here' : ''}</small></h3>${list.map((ship) => this.fleetRow(ship, sel, squadName)).join('')}`).join('');
            const bar = sel.size ? `<div class="fl-selbar"><span>${sel.size} selected</span><div class="button-row">${this.button('Escort', 'fleet-job', 'escort:' + [...sel].join(','))}${this.button('Guard here', 'fleet-job', 'patrol:' + [...sel].join(','))}${this.button('Send to…', 'fleet-send', [...sel].join(','))}${this.button('Hold', 'fleet-job', 'hold:' + [...sel].join(','))}${this.button('Repair', 'fleet-job', 'repair:' + [...sel].join(','))}${this.button('Make squadron', 'squad-make', [...sel].join(','), false, true)}${this.button('Clear', 'fleet-clear')}</div></div>` : '';
            return `<div class="section-heading"><div><h2>Your fleet</h2><p>Tap a ship to see and change its job. Tick several ships to order them together or make a squadron.</p></div><span class="badge">${ships.length} / 24 HULLS</span></div>${top}${squadHtml}${groups}${bar}`;
        }
        fleetRow(ship, sel, squadName) {
            const d = this.director, esc = Reach.escapeHTML, open = this.fleetOpen === ship.id;
            const cls = SE.CLASSES[ship.cls];
            const squad = ship.squad && squadName(ship.squad);
            let body = '';
            if (open && ship.isPlayer) {
                body = `<div class="fl-detail"><p class="small">Your flagship. Send it with SEND FLEET on the map; its escorts go with it.</p><div class="button-row">${this.button('Outfit flagship', 'panel', 'outfit', !d.atPort)}${d.atPort ? '' : '<span class="small">Dock to outfit.</span>'}</div></div>`;
            }
            else if (open) {
                const job = (role, label, off, why) => `<button class="button fl-job${ship.duty === role || (!ship.duty && role === 'escort') ? ' on' : ''}" data-action="fleet-job" data-value="${role}:${ship.id}" ${off ? 'disabled' : ''} title="${esc(why || Reach.JOBS[role].help)}">${label}</button>`;
                const damaged = ship.hull < ship.hullMax - 0.5;
                const canTake = d.atPort && ship.sector === d.world.sectorId;
                body = `<div class="fl-detail"><p class="small fl-jobhelp">${esc(Reach.JOBS[ship.duty || 'escort'].help)}</p>
                    <div class="button-row fl-jobs">${job('escort', 'Escort')}${job('patrol', 'Guard here')}${this.button('Send to…', 'fleet-send', ship.id)}${cls.miner ? job('mine', 'Mine', !SE.SECTOR_BY_ID[ship.sector].belt, 'Needs a system with an asteroid belt.') : ''}${job('hold', 'Hold')}${job('repair', damaged ? `Repair · ~${Reach.credits(Math.ceil(ship.hullMax - ship.hull))} cr` : 'Repair', !damaged && ship.duty !== 'repair', 'Not damaged.')}</div>
                    <div class="button-row">${ship.squad ? this.button('Leave ' + esc(squad || 'squadron'), 'squad-leave', ship.id) : ''}${this.button('Take command', 'transfer', ship.id, !canTake)}${canTake ? '' : '<span class="small">To make it your flagship, dock in the system it is in.</span>'}</div></div>`;
            }
            return `<div class="fl-row${open ? ' open' : ''}${sel.has(ship.id) ? ' sel' : ''}">
                ${ship.isPlayer ? '<span class="fl-check fl-flag" title="Flagship">★</span>' : `<button class="fl-check" data-action="fleet-select" data-value="${ship.id}" aria-label="Select ${esc(ship.name)}" aria-pressed="${sel.has(ship.id)}">${sel.has(ship.id) ? '✓' : ''}</button>`}
                <button class="fl-main" data-action="fleet-open" data-value="${ship.id}" aria-expanded="${open}"><img class="sv-ico" src="${SE.ShipArt.icon(ship.cls, 'player')}" alt=""><span class="fl-name"><b>${esc(ship.name)}</b> <small>${esc(cls.name)}${squad ? ' · ' + esc(squad) : ''}</small><em>${esc(this.shipStatus(ship))}</em></span>${this.fleetBars(ship)}</button>${body}</div>`;
        }
        // Where to send ships: your systems, systems your fleet is in, and nearby ones.
        fleetPicker() {
            const d = this.director, s = d.state, esc = Reach.escapeHTML, ids = this.fleetPick;
            const ships = ids.map((id) => d.world.get(id)).filter(Boolean);
            const from = ships[0] ? ships[0].sector : d.world.sectorId;
            const mine = [...s.claims, ...s.conquests.map((c) => c.sector)];
            const fleetAt = [...new Set(d.fleet.map((x) => x.sector))];
            const near = SE.SECTORS.filter((sec) => { const p = d.scene.route(d.world.sectorId, sec.id); return p && p.length <= 4; }).map((sec) => sec.id);
            const seen = new Set();
            const row = (id) => {
                if (seen.has(id)) return '';
                seen.add(id);
                const sec = SE.SECTOR_BY_ID[id], path = d.scene.route(from, id), hops = path ? path.length - 1 : 0;
                const danger = sec.owner && sec.owner !== 'player' && SE.hostile('player', sec.owner);
                return `<button class="fl-pick" data-action="fleet-send-to" data-value="${id}"><b>${esc(sec.name)}</b><small>${sec.owner === 'player' ? 'Yours' : sec.owner ? esc(SE.FACTIONS[sec.owner].short) : 'Unclaimed'} · ${hops} jump${hops === 1 ? '' : 's'}${danger ? ' · <span class="fl-warn">hostile defences</span>' : ''}</small></button>`;
            };
            const section = (title, list) => { const html = list.map(row).join(''); return html ? `<h3 class="fl-h">${title}</h3><div class="fl-picks">${html}</div>` : ''; };
            return `<div class="section-heading"><div><h2>Send to guard…</h2><p>${esc(ships.map((x) => x.name).join(', '))} will fly there and guard it.</p></div>${this.button('Cancel', 'fleet-send-cancel')}</div>${section('Your systems', mine)}${section('Where your ships are', fleetAt)}${section('Nearby', near)}`;
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
        portNotice() { return `<div class="port-notice">${icon('port')}<div><h2>Station services are within reach.</h2><p>Dock to trade, commission ships and change your loadout. Your flagship can dock wherever it holds in a system with a friendly station.</p>${this.button('Back to the map', 'resume', '', false, true)}</div></div>`; }
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
            return `<div class="section-heading"><div><h2>Supply changes the Reach.</h2><p>${Reach.escapeHTML(d.economy.profile(station).name)} · Available stock excludes construction reserves. Button totals include the price impact of every unit.</p></div><span class="badge">HOLD ${Math.floor(SE.cargoUsed(me))} / ${me.cargoMax}</span></div>${this.supplySummary()}<div class="market-table"><div class="market-row table-head"><span>COMMODITY</span><span>AVAILABLE</span><span>ABOARD</span><span>NEXT UNIT · BUY / SELL</span><span>EXACT TRADE TOTAL</span></div>${rows}</div><p class="small">Station purchasing budget: ${(account.treasury / 100).toFixed(2)} cr. Quotes are local and current. Menus pause production; return to the map to advance build timers.</p><div class="service-strip"><div><strong>Ship services</strong><p>Hull ${Math.ceil(me.hull)} / ${me.hullMax} · repairs include shield recharge</p></div>${this.button(d.repairCost ? `Repair · ${Reach.credits(d.repairCost)} cr` : 'Hull intact', 'repair', '', !d.repairCost || d.world.credits < d.repairCost)}${this.button('Deliver contracts', 'deliver', '')}</div>`;
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
                return this.card(job.owned ? 'YOUR COMMISSION' : 'CIVIC COMMISSION · LOCAL DEFENCE', Reach.escapeHTML(job.name), Reach.escapeHTML(job.status), `<div class="progress"><i style="width:${job.progress / job.duration * 100}%"></i></div>${job.owned ? '' : `<div class="build-materials">${materials}</div>`}<p class="small">${job.phase === 'waiting' ? 'Sell missing materials to this station. The first waiting job reserves them automatically.' : job.phase === 'complete' ? 'Construction complete. This hull is now an independent ship in the universe.' : `${Math.ceil(job.duration - job.progress)} seconds remaining. Construction continues in distant sectors.`}</p>${job.owned && job.phase === 'waiting' ? this.economicButton('Cancel · refund ' + Reach.credits(job.price / 100) + ' cr', 'cancel-build', job.id) : ''}`, job.phase === 'complete' ? '' : 'featured');
            }).join('');
            const offers = Reach.HULLS.map((offer) => {
                const hull = SE.CLASSES[offer.id];
                const build = Reach.BUILD_DEFINITIONS[offer.id];
                const locked = d.state.xp < offer.xp;
                                return this.card(hull.tier.toUpperCase() + ' CLASS', hull.name, offer.role, `<p class="stock-line">Credits only · ${build.quick}s build</p><p class="small">Built in its own berth while the galaxy runs, then joins your fleet as an escort.</p><div class="card-foot"><b class="gold">${Reach.credits(offer.price)} cr</b>${this.economicButton(locked ? offer.xp + ' XP required' : 'Commission', 'buy-ship', offer.id, locked || d.world.credits < offer.price, true)}</div>`);
            }).join('');
            return `<div class="section-heading"><div><h2>Credits become a fleet.</h2><p>Pay and it is built: each ship gets its own berth, up to four at a time per yard. Return to the map and they finish while the galaxy runs.</p></div><span class="badge">${d.fleet.length} + ${d.economy.pendingOwned()} QUEUED / 24</span></div><div class="cards">${jobs || this.card('CONSTRUCTION QUEUE', 'Berth available', 'Commission a hull below. It costs credits only.')}</div><h2 class="subheading">Commission a hull</h2><div class="cards">${offers}</div>`;
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
            const forecast = d.economy.forecast();
            const facilities = d.state.outposts.map((p) => {
                const recipe = Reach.INDUSTRIES.find((r) => r.id === p.kind);
                const f = forecast.get(p.id) || { rate: 0, reason: '' };
                const contents = Reach.GOODS.filter((g) => p.stock[g] > 0).map((g) => `${Math.floor(p.stock[g])} ${SE.GOODS[g].name}`).join(' · ');
                return this.card(`${Reach.escapeHTML(SE.SECTOR_BY_ID[p.sector].name)} · LEVEL ${p.level}`, recipe.name, Reach.escapeHTML(p.status), `<div class="progress"><i style="width:${p.cycle / recipe.seconds * 100}%"></i></div><p class="small">Potential ${f.rate >= 0 ? '+' : ''}${Reach.credits(f.rate)} cr/min${p.earned ? ` · earned ${Reach.credits(p.earned)} cr so far` : ''}${f.reason ? ` · <b class="warn-text">${Reach.escapeHTML(f.reason)}</b>` : ''}</p><p class="stock-line">${contents || 'Storage empty'} · 600 / commodity capacity</p><div class="button-row">${this.button('Load onto flagship', 'collect', p.id, p.sector !== sector.id)}${this.button(p.online ? 'Suspend' : 'Resume', 'toggle-industry', p.id)}${this.button(p.level >= 3 ? 'Maximum level' : 'Upgrade · ' + Reach.credits(recipe.cost * 0.7 * p.level) + ' cr', 'upgrade-industry', p.id, p.level >= 3)}</div>`);
            }).join('');
            return `<div class="section-heading"><div><h2>Build a lasting presence.</h2><p>Production runs while the galaxy runs, even in distant systems. Each facility keeps 120 units and sells the rest for you; foundries draw ore from extractors in the same system.</p></div><span class="badge">${d.state.outposts.length} FACILITIES</span></div><div class="territory-strip"><div><strong>${Reach.escapeHTML(sector.name)}</strong><p>Authority: ${Reach.escapeHTML(sector.owner ? SE.FACTIONS[sector.owner]?.name || 'Independent command' : 'Unclaimed')} · Your influence: ${Math.floor(d.state.influence[sector.id] || 0)} / 100</p></div>${this.button(sector.owner === 'player' ? 'Charter established' : 'Register charter · 3,000 cr', 'claim', '', !!sector.owner || (d.state.influence[sector.id] || 0) < 60)}</div>${facilities ? '<div class="cards">' + facilities + '</div><h2 class="subheading">Expand local infrastructure</h2>' : ''}<div class="cards">${Reach.INDUSTRIES.map((r) => this.card('CONSTRUCTION · ' + Reach.escapeHTML(sector.name), r.name, r.description, `<div class="recipe"><span>+${r.quantity} ${SE.GOODS[r.good].name} / ${r.seconds}s</span><span>−${r.upkeep} cr${r.input ? ' · −' + r.input.quantity + ' ' + SE.GOODS[r.input.good].name : ''} per cycle</span></div><div class="card-foot"><b class="gold">${Reach.credits(r.cost)} cr</b>${this.button('Construct', 'build', r.id, d.world.credits < r.cost || (r.id === 'extractor' && !sector.belt), true)}</div>`)).join('')}</div>${this.stationProduction()}`;
        }
        factions() {
            const d = this.director;
            return `<div class="section-heading"><div><h2>Every alliance has a price.</h2><p>Contracts earn standing. Attacks damage it. Trusted captains receive lower market prices; hostile factions deny docking and engage your fleet.</p></div></div><div class="cards faction-cards">${Reach.FACTIONS.map((id) => {
                const faction = SE.FACTIONS[id];
                const value = d.state.reputation[id];
                const standing = value < -60 ? 'Hunted' : value < -20 ? 'Hostile' : value <= 20 ? 'Neutral' : value <= 60 ? 'Trusted' : 'Allied';
                const war = !!d.state.wars[id], armed = this.warArmed === id;
                return `<article class="card faction-card" style="--faction:#${faction.colour.toString(16).padStart(6, '0')}"><div class="faction-seal">${faction.short}</div><div class="eyebrow">${war ? 'AT WAR' : standing.toUpperCase()} · ${value > 0 ? '+' : ''}${value} STANDING</div><h3>${Reach.escapeHTML(faction.name)}</h3><p>${Reach.escapeHTML(faction.blurb)}</p><div class="standing"><i style="width:${(value + 100) / 2}%"></i></div>${war ? `<p class="small war-note">At war. Their platforms and stations fire on you, their warships hunt yours, and they send strike groups after systems you took.</p>` : `<p class="small">Send 8 Energy Cells as relief: +12 standing. Each faction accepts one shipment every 120 seconds.</p>`}<div class="button-row">${war ? this.button('Offer peace · ' + Reach.credits(d.scene.sieges.PEACE_COST) + ' cr', 'peace', id, d.world.credits < d.scene.sieges.PEACE_COST) : this.button('Dispatch relief', 'relief', id, (d.world.player.cargo.cells || 0) < 8) + (value >= -20 ? this.button(armed ? 'Tap again to declare war' : 'Declare war', 'war', id, false, armed) : '')}</div>${!war && value < -20 ? '<p class="small">Already hostile: their systems can be besieged now.</p>' : ''}${armed && id === 'apex' ? '<p class="small war-note">Tarpon Reach, your home port, is Apex. It will close to you.</p>' : ''}</article>`;
            }).join('')}</div>`;
        }
        settings() {
            const settings = this.director.state.settings;
            return `<div class="section-heading"><div><h2>Your bridge. Your controls.</h2><p>Portrait and landscape touch. On a keyboard, F docks and Escape opens or closes the command deck.</p></div></div><div class="settings-grid"><section class="card"><div class="eyebrow">DISPLAY & SOUND</div><label class="setting-row"><span>Reduce interface motion</span><input type="checkbox" data-setting="reducedMotion" ${settings.reducedMotion ? 'checked' : ''}></label><label class="setting-row"><span>Music</span><input type="checkbox" data-setting="music" ${settings.music ? 'checked' : ''}></label><label class="setting-row"><span>Music volume</span><input type="range" min="0" max="100" step="5" data-setting="musicVolume" value="${Math.round(settings.musicVolume * 100)}"></label><label class="setting-row"><span>Sound effects</span><input type="checkbox" data-setting="sound" ${settings.sound ? 'checked' : ''}></label><label class="setting-row"><span>Effects volume</span><input type="range" min="0" max="100" step="5" data-setting="volume" value="${Math.round(settings.volume * 100)}"></label></section><section class="card"><div class="eyebrow">COMMANDER FILE</div><h3>Keep your progress with you.</h3>${this.saveLine()}<p>Progress autosaves on every jump, after important commands, and when you leave the app. Export a backup before changing devices or browsers.</p><div class="button-row">${this.button(icon('save') + ' Save now', 'save')}${this.button('Export backup', 'export')}${this.button('Import backup', 'import')}</div><input id="save-import" type="file" accept="application/json,.json" class="hidden"><div id="save-note" class="small"></div><div class="control-guide"><strong>The star chart</strong><p>Drag to pan, pinch to zoom. Tap a system, then SEND FLEET: your flagship and its escorts fly the lanes and go round hostile strongholds when they can. 1× / 2× / 4× sets the game speed.</p></div></section></div><details class="card diagnostics"><summary>Simulation diagnostics</summary><p class="small">Economy work p95 ${this.director.economy.workP95.toFixed(2)} ms · peak ${this.director.economy.diagnostics.peakMilliseconds.toFixed(2)} ms. ${this.director.economy.diagnostics.transactions} transaction attempts this session; ${this.director.economy.state.receipts.length} recent receipts retained.</p><p class="small">${this.director.world.registry.all.length} entities · ${this.director.scene.motionClock.ticks} simulation steps. Economy timings measure economic work only, not total frame rate.</p></details>`;
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
        /* The main screen's own readouts: where the fleet is, what it is doing,
           and the two things you can do about it from here. Cheap enough to
           run with every map refresh. */
        updateMap() {
            const d = this.director, me = d.world.player, scene = d.scene;
            if (!me)
                return;
            const ui = this.instruments;
            const sector = SE.SECTOR_BY_ID[d.world.sectorId];
            ui.text('gx-authority', sector.owner === 'player' ? 'YOUR CHARTER' : sector.owner ? (SE.FACTIONS[sector.owner]?.short || 'INDEPENDENT') + ' JURISDICTION' : 'UNCLAIMED SPACE');
            ui.text('gx-credits', Reach.credits(d.world.credits));
            // Measured income when there is a measurement; until then the forecast, marked as one.
            const actual = d.actualIncome, rate = actual ?? d.incomePerMinute;
            ui.text('gx-income', rate ? (actual === null ? '~' : '') + (rate > 0 ? '+' : '') + Reach.credits(rate) + ' cr/min' : '');
            this.renderSaveStatus();
            this.renderObjective();
            this.renderBattleAlert();
            this.renderNews();
            const escorts = d.fleet.filter((s) => !s.isPlayer && s.sector === me.sector).length;
            const hull = Math.round(me.hull / Math.max(1, me.hullMax) * 100);
            const crew = `${Reach.escapeHTML(me.name)}${escorts ? ' + ' + escorts + ' escort' + (escorts === 1 ? '' : 's') : ''}`;
            let line;
            if (scene.course) {
                const leg = scene.nextLeg();
                line = `${crew} · under way to <b>${Reach.escapeHTML(SE.SECTOR_BY_ID[scene.course.to].name)}</b>` + (leg ? ` · ${leg.hops} jump${leg.hops === 1 ? '' : 's'} · next ${Reach.escapeHTML(SE.SECTOR_BY_ID[leg.leg].name)}` : '');
            }
            else {
                const port = d.nearbyPort;
                line = `${crew} · holding ${port ? 'at <b>' + Reach.escapeHTML(port.name) + '</b>' : 'in <b>' + Reach.escapeHTML(sector.name) + '</b>'}`;
            }
            line += ` · hull ${hull}%`;
            const fleetLine = this.el('gx-fleet');
            if (fleetLine.dataset.line !== line) {
                fleetLine.dataset.line = line;
                fleetLine.innerHTML = line;
            }
            const port = d.nearbyPort;
            this.el('gxport').classList.toggle('hidden', !port);
            if (port)
                ui.text('gxport', 'Dock');
            this.el('gxstop').classList.toggle('hidden', !scene.course);
        }
        /* Saving is silent when it works. When it does not, a red tag sits in
           the header until a save succeeds, and tapping it opens Settings with
           the reason and a Save now button. */
        saveLine() {
            const st = this.director.scene.saveStatus, now = this.director.world.elapsed;
            if (st && st.error)
                return `<p class="save-line bad">⚠ The last save failed: ${Reach.escapeHTML(st.error)} Your previous save is still safe. Try Save now; if it keeps failing, export a backup.</p>`;
            if (st && st.at !== null)
                return `<p class="save-line">✓ Saved ${Math.max(0, Math.round((now - st.at) / 60))} game min ago.</p>`;
            return '';
        }
        renderSaveStatus() {
            // The Empire tab carries a count of things that need you.
            const n = this.director.blocked.length, tab = document.querySelector('.gx-tabs [data-value="empire"]');
            if (tab && tab.dataset.count !== String(n)) { tab.dataset.count = String(n); tab.classList.toggle('has-count', n > 0); }
            const st = this.director.scene.saveStatus, tag = this.el('gx-save');
            const failing = !!(st && st.error);
            tag.classList.toggle('hidden', !failing);
            if (failing && tag.dataset.err !== st.error) { tag.dataset.err = st.error; tag.title = st.error; }
        }
        /* The newest galaxy event headline, for a minute after it happens;
           tapping it opens the Empire tab with every event listed. */
        renderNews() {
            const d = this.director, n = d.state.news[d.state.news.length - 1];
            const line = this.el('gx-news');
            const show = n && d.world.elapsed - n.at < 60;
            const html = show ? `<span class="gxn-tag">NEWS</span><span>${Reach.escapeHTML(n.text)}</span>` : '';
            if (line.dataset.html !== html) {
                line.dataset.html = html;
                line.innerHTML = html;
                line.classList.toggle('hidden', !show);
                line.dataset.kind = n ? n.kind : '';
            }
        }
        /* A fight involving your ships outranks the guide: a red bar above it
           with one button, straight into the system to command it. */
        renderBattleAlert() {
            const d = this.director, list = d.scene.battles ? d.scene.battles.list : [];
            const bar = this.el('gx-battle');
            const b = list[0];
            let html = b ? `<span>⚔ Battle in <b>${Reach.escapeHTML(SE.SECTOR_BY_ID[b.sector].name)}</b> · ${b.foes.size} hostile${b.foes.size === 1 ? '' : 's'}${list.length > 1 ? ` · +${list.length - 1} more` : ''}</span><button class="button" data-action="sys-open" data-value="${b.sector}">Command</button>` : '';
            let kind = b ? 'battle' : '';
            const S = d.scene.sieges;
            if (!html && S) {
                const name = (id) => Reach.escapeHTML(SE.SECTOR_BY_ID[id].name);
                const send = (id) => d.scene.course && d.scene.course.to === id ? '' : d.world.sectorId === id ? `<button class="button" data-action="sys-open" data-value="${id}">View</button>` : `<button class="button" data-action="course" data-value="${id}">Defend</button>`;
                const raids = S.underAttack();
                const lost = raids.find((x) => x.left !== null) || raids[0];
                const strike = S.incoming()[0];
                const siege = S.active.find((x) => x.phase && x.phase !== 'idle');
                if (lost) {
                    html = lost.left !== null
                        ? `<span>⚠ <b>${name(lost.sector)}</b> is undefended · lost in ${lost.left}s</span>${send(lost.sector)}`
                        : `<span>⚠ <b>${name(lost.sector)}</b> under attack · ${lost.foes} ship${lost.foes === 1 ? '' : 's'} · garrison holding</span>${send(lost.sector)}`;
                    kind = lost.left !== null ? 'battle' : 'strike';
                }
                else if (strike) {
                    html = `<span>⚠ ${Reach.escapeHTML(SE.FACTIONS[strike.faction].short)} strike group (${strike.ships}) heading for <b>${name(strike.to)}</b>${strike.jumps ? ` · ${strike.jumps} jump${strike.jumps === 1 ? '' : 's'} out` : ' · arriving'}</span>${send(strike.to)}`;
                    kind = 'strike';
                }
                else if (siege) {
                    const what = siege.phase === 'defences' ? `${siege.guns.length} platform${siege.guns.length === 1 ? '' : 's'} left` : siege.phase === 'contested' ? `${siege.ships.length} warship${siege.ships.length === 1 ? '' : 's'} guarding` : siege.phase === 'outside' ? 'ships too far from the station' : `shield failing · ${Math.floor(siege.progress * 100)}%`;
                    html = `<span>🏰 Siege of <b>${name(siege.sector)}</b> · ${what}</span><button class="button" data-action="sys-open" data-value="${siege.sector}">View</button>`;
                    kind = 'siege';
                }
            }
            if (bar.dataset.html !== html) {
                bar.dataset.html = html;
                bar.innerHTML = html;
                bar.classList.toggle('on', !!html);
                bar.dataset.kind = kind;
            }
        }
        /* ---- The guide --------------------------------------------------------
           One card on the map: what to do next, one line on why, and a button
           that does it. The button is worked out from where the fleet is and
           what it has, so it is always the actual next action — "send the
           fleet", then "build", then "claim" — never "go and find the Industry
           tab". */
        renderObjective() {
            const d = this.director, s = d.state, m = d.currentMilestone;
            let html;
            if (!m) {
                const next = this.expansionStep();
                html = `<div class="gxo-top"><span class="eyebrow">YOUR EMPIRE · ${s.claims.length + s.conquests.length} SYSTEMS</span></div><strong>Keep expanding</strong><p>Every system you hold pays you every minute.</p>${this.guideButton(next)}`;
            }
            else {
                const steps = Reach.TUTORIAL_STEPS;
                const index = Reach.MILESTONES.indexOf(m);
                const kicker = m.tier === 'tutorial' ? `GETTING STARTED · ${index + 1}/${steps}` : m.tier === 'side' ? 'SIDE GOAL' : 'EMPIRE GOAL';
                const progress = Math.min(m.target, Math.floor(m.progress(s)));
                html = `<div class="gxo-top"><span class="eyebrow">${kicker}</span><small>${m.target > 1 ? progress + '/' + m.target + ' · ' : ''}+${Reach.credits(m.reward)} cr</small></div><strong>${Reach.escapeHTML(m.title)}</strong><p>${Reach.escapeHTML(m.why)}</p>${this.guideButton(this.guide(m))}`;
            }
            const card = this.el('gx-objective');
            if (card.dataset.html !== html) {
                card.dataset.html = html;
                card.innerHTML = html;
            }
        }
        guideButton(g) {
            if (!g)
                return '';
            const note = g.note ? `<span class="gxo-note">${Reach.escapeHTML(g.note)}</span>` : '';
            if (!g.action)
                return `<div class="gxo-row">${note}</div>`;
            return `<div class="gxo-row"><button class="button primary" data-action="${g.action}" data-value="${Reach.escapeHTML(g.value || '')}" ${g.disabled ? 'disabled' : ''}>${Reach.escapeHTML(g.label)}</button>${note}</div>`;
        }
        // Unclaimed, stationless systems in jump order from the fleet; belts first
        // when asked, because an extractor is the facility a new charter can afford.
        nearestFrontier(beltFirst) {
            const d = this.director, here = d.world.sectorId;
            let best = null, bestCost = Infinity;
            for (const sec of SE.SECTORS) {
                if (sec.owner || sec.station)
                    continue;
                const path = d.scene.route(here, sec.id);
                if (!path)
                    continue;
                const cost = path.length + (beltFirst && !sec.belt ? 6 : 0);
                if (cost < bestCost) { bestCost = cost; best = sec; }
            }
            return best;
        }
        sendTo(sec, verb) {
            const d = this.director;
            if (d.scene.course && d.scene.course.to === sec.id)
                return { label: 'Fleet under way to ' + sec.name, disabled: true, action: 'stop', note: '' };
            const hops = d.scene.route(d.world.sectorId, sec.id).length - 1;
            return { label: (verb || 'Send fleet to ') + sec.name + ` (${hops} jump${hops === 1 ? '' : 's'})`, action: 'course', value: sec.id };
        }
        /* The next step of the loop for one more system: go to a frontier
           system, build there, wait for influence, claim. Used by the tutorial
           steps that teach it and by every empire goal after them. */
        expansionStep() {
            const d = this.director, s = d.state, here = SE.SECTOR_BY_ID[d.world.sectorId];
            const frontierHere = !here.owner && !here.station;
            const mine = s.outposts.filter((p) => p.sector === here.id);
            if (frontierHere && !mine.length) {
                const kind = here.belt ? Reach.INDUSTRIES.find((r) => r.id === 'extractor') : Reach.INDUSTRIES.find((r) => r.id === 'solar');
                const short = d.world.credits < kind.cost;
                return { label: `Build ${kind.name.toLowerCase()} (${Reach.credits(kind.cost)} cr)`, action: 'build', value: kind.id, disabled: short, note: short ? `Need ${Reach.credits(kind.cost - d.world.credits)} more credits. Your miner and facilities are earning.` : '' };
            }
            if (frontierHere && mine.length) {
                const inf = Math.floor(s.influence[here.id] || 0);
                if (inf < 60)
                    return { label: `Influence ${inf}/60`, action: 'pace', disabled: true, note: 'Your facility builds influence as it works. Tap the speed button (1×) to speed time up.' };
                const short = d.world.credits < 3000;
                return { label: 'Claim ' + here.name + ' (3,000 cr)', action: 'claim', disabled: short, note: short ? `Need ${Reach.credits(3000 - d.world.credits)} more credits.` : '' };
            }
            // A facility already started somewhere else that is not yet claimed.
            const pending = s.outposts.find((p) => !s.claims.includes(p.sector) && !SE.SECTOR_BY_ID[p.sector].owner);
            if (pending)
                return this.sendTo(SE.SECTOR_BY_ID[pending.sector], 'Return to ');
            const target = this.nearestFrontier(true);
            return target ? this.sendTo(target) : { note: 'Every frontier system is yours. The rest of the galaxy belongs to the factions.' };
        }
        /* The next step of a siege: break the defences, clear the guard, hold
           the station; or, with no siege on, the softest system to start one. */
        siegeStep() {
            const d = this.director, world = d.world, S = d.scene.sieges;
            const here = S.status(world.sectorId);
            if (here && here.phase === 'defences')
                return { label: `Attack defences (${here.guns.length} left)`, action: 'siege-attack', value: here.sector, note: 'Every warship here targets the nearest platform.' };
            if (here && here.phase === 'contested')
                return { label: `Clear ${here.ships.length} guard ship${here.ships.length === 1 ? '' : 's'}`, action: 'sys-open', value: here.sector };
            if (here && here.phase === 'outside')
                return { label: 'View siege', action: 'sys-open', value: here.sector, note: 'Your warships must be near the station to besiege it. Select them and tap near the station.' };
            if (here && here.phase === 'sieging')
                return { label: `Siege ${Math.floor(here.progress * 100)}% · view`, action: 'sys-open', value: here.sector, note: 'Hold the station. More warships, faster.' };
            let best = null, bestScore = Infinity, bestGuns = 0;
            for (const sec of SE.SECTORS) {
                const t = S.target(sec.id);
                if (!t || !t.hostile)
                    continue;
                const guns = world.registry.inSector(sec.id).filter((x) => !x.dead && SE.isEmplacement(SE.CLASSES[x.cls]) && x.faction === t.faction).length;
                const path = d.scene.route(world.sectorId, sec.id);
                if (!path)
                    continue;
                const score = guns * 3 + path.length;
                if (score < bestScore) { bestScore = score; best = sec; bestGuns = guns; }
            }
            if (!best)
                return { label: 'Open Factions', action: 'panel', value: 'factions', note: 'Declare war on a faction to besiege its systems.' };
            const warships = d.fleet.filter((x) => !SE.CLASSES[x.cls].miner && x.cls !== 'freighter').length;
            const g = this.sendTo(best, 'Besiege ');
            g.note = warships < 4 ? `${bestGuns} defence platforms. Bring at least 4 warships: commission corvettes first.` : `${bestGuns} defence platforms. Your ${warships} warships go in together.`;
            return g;
        }
        guide(m) {
            const d = this.director, s = d.state, world = d.world;
            switch (m.id) {
                case 'orders': {
                    const miner = d.fleet.find((ship) => SE.CLASSES[ship.cls].miner && !ship.isPlayer);
                    if (!miner)
                        return { label: 'Open Fleet', action: 'panel', value: 'fleet' };
                    if (!SE.SECTOR_BY_ID[miner.sector].belt)
                        return { label: 'Open Fleet', action: 'panel', value: 'fleet', note: miner.name + ' needs a system with an asteroid belt.' };
                    return { label: `Order ${miner.name} to mine`, action: 'order', value: miner.id + ':mine' };
                }
                case 'trade': {
                    const miner = d.fleet.find((ship) => SE.CLASSES[ship.cls].miner && ship.duty === 'mine') || d.fleet.find((ship) => SE.CLASSES[ship.cls].miner);
                    return { label: 'Watch it work', action: 'sys-open', value: miner ? miner.sector : world.sectorId, note: `${Math.floor(s.metrics.sold)}/20 sold` };
                }
                case 'frontier': {
                    const target = this.nearestFrontier(true);
                    return target ? this.sendTo(target) : null;
                }
                case 'industry':
                case 'claim':
                    return this.expansionStep();
                case 'battle': {
                    const b = d.scene.battles && d.scene.battles.list[0];
                    if (b)
                        return { label: 'Command the battle in ' + SE.SECTOR_BY_ID[b.sector].name, action: 'sys-open', value: b.sector };
                    // Somewhere with pirates near your own space, but not a stronghold.
                    let best = null, bestHops = Infinity;
                    for (const sec of SE.SECTORS) {
                        if (sec.owner && sec.owner !== 'player' && SE.hostile('player', sec.owner))
                            continue;
                        const pirates = world.registry.inSector(sec.id).filter((s) => !s.dead && !s.owned && SE.hostile('player', s.faction) && !SE.isStatic(SE.CLASSES[s.cls])).length;
                        if (!pirates)
                            continue;
                        const path = d.scene.route(world.sectorId, sec.id);
                        if (path && path.length < bestHops) { bestHops = path.length; best = sec; }
                    }
                    return best ? this.sendTo(best, 'Hunt pirates in ') : { note: 'Pirates attack miners and freighters. When they do, a red bar appears here.' };
                }
                case 'conquest':
                    return this.siegeStep();
                case 'expand':
                case 'fit':
                case 'contract': {
                    // Bought and building: say so, or the card keeps offering the shipyard.
                    const job = m.id === 'expand' && d.economy.state.jobs.find((j) => j.owned && !['complete', 'cancelled'].includes(j.phase));
                    if (job)
                        return { label: job.name + ' · ' + job.status, disabled: true, action: 'pace', note: 'It joins your fleet as soon as it is built.' };
                    const panel = m.id === 'expand' ? 'shipyard' : m.id === 'fit' ? 'outfit' : 'contracts';
                    const needYard = m.id === 'expand';
                    const ok = (st) => st && !SE.hostile('player', st.faction) && (!needYard || d.economy.profile(st).yard);
                    if (d.atPort && ok(d.station))
                        return { label: 'Open ' + Reach.PANEL_PRESENTATION[panel].label, action: 'panel', value: panel };
                    const port = d.nearbyPort;
                    if (ok(port))
                        return { label: 'Dock at ' + port.name, action: 'context' };
                    // Nearest friendly port that offers it.
                    let best = null, bestHops = Infinity;
                    for (const sec of SE.SECTORS) {
                        const st = world.get('st_' + sec.id);
                        if (!ok(st))
                            continue;
                        const path = d.scene.route(world.sectorId, sec.id);
                        if (path && path.length < bestHops) { bestHops = path.length; best = sec; }
                    }
                    return best ? this.sendTo(best) : null;
                }
                default:
                    return this.expansionStep();
            }
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
            d.audio.play('click');
            switch (action) {
                case 'launch':
                case 'resume':
                    d.resume();
                    break;
                case 'panel':
                    if (panels.includes(value)) {
                        d.scene.systemView.close();
                        d.pause(value);
                    }
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
                        this.updateMap();
                    }
                    break;
                }
                case 'course':
                    if (SE.SECTOR_BY_ID[value]) {
                        d.scene.setCourse(value);
                        d.scene.systemView.close();
                        d.resume();
                    }
                    break;
                case 'view-system':
                    d.scene.systemView.open(d.scene.galaxy.picked || d.world.sectorId);
                    break;
                case 'sys-open':
                    if (SE.SECTOR_BY_ID[value]) {
                        if (d.paused)
                            d.resume();
                        d.scene.systemView.open(value);
                    }
                    break;
                case 'sys-map':
                    d.scene.systemView.close();
                    d.resume();
                    break;
                case 'pace':
                    this.toast('Game speed ' + d.scene.cyclePace() + '×', 'info');
                    break;
                case 'stop':
                    d.scene.clearCourse();
                    d.scene.galaxy.refresh();
                    this.updateMap();
                    break;
                case 'context':
                    if (d.nearbyPort)
                        d.scene.systemView.close();
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
                    if (['escort', 'mine', 'hold', 'patrol', 'repair'].includes(role))
                        d.execute({ type: 'fleet.order', shipId, role: role });
                    break;
                }
                case 'fleet-open':
                    this.fleetOpen = this.fleetOpen === value ? null : value;
                    this.render();
                    break;
                case 'fleet-select': {
                    const sel = this.fleetSel || (this.fleetSel = new Set());
                    if (sel.has(value)) sel.delete(value); else sel.add(value);
                    this.render();
                    break;
                }
                case 'fleet-clear':
                    this.fleetSel?.clear();
                    this.render();
                    break;
                case 'fleet-job': {
                    const [role, list] = value.split(':');
                    d.execute({ type: 'fleet.order', shipIds: list.split(','), role });
                    break;
                }
                case 'fleet-recall':
                    d.execute({ type: 'fleet.recall' });
                    break;
                case 'fleet-send':
                    this.fleetPick = value.split(',');
                    this.render();
                    this.el('panel-body').scrollTop = 0;
                    break;
                case 'fleet-send-cancel':
                    this.fleetPick = null;
                    this.render();
                    break;
                case 'fleet-send-to': {
                    const ids = this.fleetPick || [];
                    this.fleetPick = null;
                    if (SE.SECTOR_BY_ID[value])
                        d.execute({ type: 'fleet.order', shipIds: ids, role: 'patrol', post: value });
                    else
                        this.render();
                    break;
                }
                case 'squad-make':
                    d.execute({ type: 'squad.create', shipIds: value.split(',') });
                    this.fleetSel?.clear();
                    this.render();
                    break;
                case 'squad-edit':
                    this.squadEdit = value;
                    this.render();
                    document.getElementById('squad-name')?.focus();
                    break;
                case 'squad-rename':
                    this.squadEdit = null;
                    d.execute({ type: 'squad.rename', id: value, name: document.getElementById('squad-name')?.value });
                    break;
                case 'squad-disband':
                    d.execute({ type: 'squad.disband', id: value });
                    break;
                case 'squad-leave':
                    d.execute({ type: 'squad.leave', shipId: value });
                    break;
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
                case 'war':
                    if (!Reach.FACTIONS.includes(value))
                        break;
                    // Two taps: a war is not something to start by brushing a button.
                    if (this.warArmed !== value) {
                        this.warArmed = value;
                        clearTimeout(this.warTimer);
                        this.warTimer = setTimeout(() => { this.warArmed = null; if (this.panel === 'factions') this.render(); }, 5000);
                        this.render();
                        break;
                    }
                    this.warArmed = null;
                    d.execute({ type: 'faction.war', faction: value });
                    break;
                case 'peace':
                    if (Reach.FACTIONS.includes(value))
                        d.execute({ type: 'faction.peace', faction: value });
                    break;
                case 'siege-attack': {
                    const n = d.scene.sieges.attackDefences(value || d.world.sectorId);
                    this.toast(n ? `${n} warship${n === 1 ? '' : 's'} attacking the defences.` : 'No warships here to attack with.', n ? 'info' : 'warn');
                    this.updateMap();
                    break;
                }
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
            else if (key === 'aimAssist' || key === 'sound' || key === 'music' || key === 'reducedMotion')
                settings[key] = target.checked;
            else if (key === 'volume' || key === 'musicVolume')
                settings[key] = Reach.clamp(Number(target.value) / 100, 0, 1);
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
