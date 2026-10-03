"use strict";
var Reach;
(function (Reach) {
    /** Owns domain commands and their consequences; the scene remains an engine adapter. */
    class Director {
        constructor(scene) {
            this.scene = scene;
            this.paused = true;
            this.station = null;
            this.driveEnergy = 100;
            this.navigation = null;
            this.navigationNode = -1;
            this.accumulator = 0;
            this.transaction = false;
            this.world = scene.world;
            this.state = Reach.restoreEmpire(this.world.empire);
            this.world.empire = this.state;
            this.economy = new Reach.Economy(this.world, (ship) => { this.scene.attach(ship); });
            this.audio = new Reach.AudioSystem(this.state.settings);
            this.priorHostility = SE.hostile;
            SE.hostile = (a, b) => {
                const other = a === 'player' ? b : b === 'player' ? a : null;
                if (other && Reach.FACTIONS.includes(other))
                    return this.state.reputation[other] < -20;
                // Two AI factions at war for a galaxy event (src/events.js).
                if (this.state.aiWars.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a)))
                    return true;
                return this.priorHostility(a, b);
            };
            for (const id of this.state.claims)
                if (SE.SECTOR_BY_ID[id])
                    SE.SECTOR_BY_ID[id].owner = 'player';
            // Systems that changed hands in AI faction wars (src/events.js).
            for (const [id, f] of Object.entries(this.state.flips || {}))
                if (SE.SECTOR_BY_ID[id])
                    SE.SECTOR_BY_ID[id].owner = f;
            // Conquered systems: the station's faction is in the ship records;
            // the system's ownership is recorded here.
            for (const c of this.state.conquests || []) {
                if (SE.SECTOR_BY_ID[c.sector])
                    SE.SECTOR_BY_ID[c.sector].owner = 'player';
                const st = this.world.get('st_' + c.sector);
                if (st)
                    st.faction = 'player';
            }
            this.unsubscribe = this.world.events.subscribe((event) => this.receive(event));
            this.shell = new Reach.Shell(this);
            // Menu ownership lives here so neither an invisible joystick nor Ammo keeps running behind a modal.
            this.scene.dock.show = (station) => this.dock(station);
            this.scene.dock.hide = () => this.resume();
            this.scene.dock.refresh = () => this.shell.render();
            this.visibility = () => { if (document.hidden) {
                this.pause('overview');
                void this.scene.autosave(true);
            } };
            this.keyHandler = (event) => {
                if (event.target?.matches('input,select,textarea'))
                    return;
                if (event.code === 'Escape') {
                    event.preventDefault();
                    this.paused ? this.resume() : this.pause('overview');
                }
                if (!this.paused && event.code === 'KeyM') {
                    event.preventDefault();
                    this.openChart();
                }
                if (!this.paused && event.code === 'KeyT') {
                    event.preventDefault();
                    this.targetNearest();
                }
                if (!this.paused && event.code === 'KeyF') {
                    event.preventDefault();
                    this.contextAction();
                }
                if (!this.paused && event.code === 'KeyB') {
                    event.preventDefault();
                    this.brake();
                }
            };
            document.addEventListener('visibilitychange', this.visibility);
            document.addEventListener('keydown', this.keyHandler);
            if (!this.state.journal.length)
                this.state.journal.push({ at: this.world.elapsed, message: 'Independent charter authenticated. Kestrel, Shrike and Ladle are yours to command.', kind: 'info' });
            this.applySettings();
            this.scene.scene.pause();
            this.shell.showTitle();
        }
        get fleet() { return this.world.registry.all.filter((s) => s.owned && !s.dead); }
        get currentMilestone() { return Reach.MILESTONES.find((m) => !this.state.claimed.includes(m.id)); }
        /* Map-first (src/empire.js): there is no docking ring to fly to. A port
           is any friendly station in the system the flagship is in, while the
           flagship is not under way to somewhere else. */
        get atPort() {
            return !!this.station && !this.station.dead && this.station.sector === this.world.sectorId && !SE.hostile('player', this.station.faction) && !this.scene.course;
        }
        get nearbyPort() {
            if (this.scene.course)
                return null;
            return this.world.iface(this.world.sectorId).stationFor(this.world.player);
        }
        // `quiet` keeps it in the journal without a toast (the news line shows it instead).
        log(message, kind = 'info', quiet = false) {
            this.state.journal.push({ at: this.world.elapsed, message, kind });
            if (this.state.journal.length > 70)
                this.state.journal.shift();
            if (!quiet)
                this.shell?.toast(message, kind);
        }
        receive(event) {
            const m = this.state.metrics;
            switch (event.type) {
                case 'trade':
                    if (!event.ship.owned)
                        break;
                    m.sold += event.quantity;
                    m.earnings += event.credits;
                    this.state.xp += Math.max(1, Math.floor(event.quantity / 8));
                    this.log(`${event.ship.name}: ${Reach.credits(event.credits)} cr earned selling ${Math.floor(event.quantity)} ${SE.GOODS[event.good].name}.`, 'gain');
                    break;
                case 'kill':
                    this.killSound(event.victim);
                    if (event.victim.owned && !event.victim.isPlayer) {
                        this.log(`${event.victim.name} was destroyed.`, 'warn');
                        break;
                    }
                    if (!event.killer?.owned || event.victim.owned)
                        break;
                    ++m.kills;
                    this.state.xp += SE.CLASSES[event.victim.cls].tier === 'emplacement' ? 90 : 45;
                    if (Reach.FACTIONS.includes(event.victim.faction))
                        this.reputation(event.victim.faction, -3);
                    this.log(`${event.victim.name} destroyed by ${event.killer.name}.`, 'gain');
                    break;
                case 'contract':
                    ++m.contracts;
                    m.earnings += event.contract.reward;
                    this.state.xp += 110;
                    this.reputation(event.contract.faction, 8);
                    this.state.influence[event.contract.sector] = Reach.clamp((this.state.influence[event.contract.sector] || 0) + 8, 0, 100);
                    this.log(`${event.contract.title} completed. +${Reach.credits(event.contract.reward)} cr · +8 standing.`, 'gain');
                    this.audio.play('reward');
                    break;
                case 'sector':
                    if (!this.state.visited.includes(event.sector)) {
                        this.state.visited.push(event.sector);
                        this.state.xp += 55;
                        this.log(`Discovered ${SE.SECTOR_BY_ID[event.sector].name}. +55 command XP.`, 'gain');
                    }
                    this.audio.play('jump');
                    this.station = null;
                    break;
                case 'damage':
                    if (event.target.isPlayer) {
                        this.shell.flashDamage();
                        this.audio.play('hit');
                    }
                    else if (this.world.get(event.attacker)?.owned)
                        this.shell.flashHit();
                    break;
                case 'salvage':
                    if (event.ship.isPlayer)
                        this.audio.play('tap');
                    break;
                case 'commission':
                    if (event.owned) {
                        ++m.bought;
                        this.log(`${event.ship.name} commissioned at ${event.station.name}. Escort orders issued.`, 'gain');
                        this.audio.play('ready');
                    }
                    else
                        this.log(`${event.station.name} commissioned ${event.ship.name} from delivered materials.`, 'info');
                    break;
                case 'changed': break;
            }
            this.checkMilestones();
        }
        /* What holding territory is for. A chartered system pays a flat sum a
           minute, more for every facility level in it, so the empire's size
           and its income are the same number seen two ways. */
        charterTax(sectorId) {
            let levels = 0;
            for (const p of this.state.outposts)
                if (p.sector === sectorId && p.online)
                    levels += p.level;
            // A conquered system comes with a working station and its trade.
            const base = this.state.conquests.some((c) => c.sector === sectorId) ? 150 : 60;
            return base + 30 * levels;
        }
        charterIncome() {
            let sum = 0;
            for (const id of this.state.claims)
                sum += this.charterTax(id);
            for (const c of this.state.conquests)
                sum += this.charterTax(c.sector);
            return sum;
        }
        // Steady income a minute: charters plus facilities, after upkeep.
        // Miners are left out; their sales come in lumps, not a rate.
        get incomePerMinute() {
            let sum = this.charterIncome();
            for (const p of this.state.outposts)
                sum += this.economy.outpostRate(p);
            return Math.round(sum);
        }
        reputation(faction, amount) {
            if (Reach.FACTIONS.includes(faction))
                this.state.reputation[faction] = Reach.clamp((this.state.reputation[faction] || 0) + amount, -100, 100);
        }
        checkMilestones() {
            for (const milestone of Reach.MILESTONES) {
                if (this.state.claimed.includes(milestone.id) || milestone.progress(this.state) < milestone.target)
                    continue;
                // Commit the claimed ID before emitting any feedback: nested events cannot award it twice.
                this.state.claimed.push(milestone.id);
                this.state.xp += milestone.xp;
                this.world.credits += milestone.reward;
                this.log(`Charter complete: ${milestone.title}. +${Reach.credits(milestone.reward)} cr · +${milestone.xp} XP.`, 'gain');
                this.audio.play('reward');
            }
        }
        tick(dt) {
            if (this.paused)
                return;
            this.accumulator += dt;
            if (this.accumulator < 0.25)
                return;
            const elapsed = this.accumulator;
            this.accumulator = 0;
            this.economy.advance(elapsed);
            for (const outpost of this.state.outposts)
                this.economy.produceOutpost(outpost, elapsed);
            const tax = this.charterIncome() * elapsed / 60;
            if (tax > 0) {
                this.world.credits += tax;
                this.state.metrics.earnings += tax;
            }
            this.sample();
            this.checkMilestones();
            this.shell.updateHUD();
        }
        /* A point on the dashboard's graph every game minute: what the empire
           earns a minute, how many systems it holds, what is in the bank. */
        sample() {
            const h = this.state.history, last = h[h.length - 1], now = this.world.elapsed;
            if (last && now - last.t < 60 && now >= last.t)
                return;
            h.push({ t: Math.round(now), income: this.incomePerMinute, systems: this.state.claims.length + this.state.conquests.length, credits: Math.round(this.world.credits) });
            if (h.length > Reach.HISTORY_SAMPLES)
                h.splice(0, h.length - Reach.HISTORY_SAMPLES);
        }
        execute(command) {
            if (this.transaction)
                return { ok: false, message: 'Command already in progress' };
            this.transaction = true;
            let result;
            try {
                result = this.apply(command);
            }
            finally {
                this.transaction = false;
            }
            if (result.replayed)
                return result;
            if (result.ok) {
                this.checkMilestones();
                this.audio.play(command.type === 'market.buy' || command.type === 'market.sell' ? 'trade' : command.type === 'sector.claim' ? 'fanfare' : command.type === 'faction.war' ? 'alert' : 'tap');
                this.log(result.message, 'info');
                this.shell.render();
                this.shell.updateHUD();
                this.shell.updateMap();
                void this.scene.autosave(true);
            }
            else {
                this.audio.play('error');
                this.shell.toast(result.message, 'warn');
                this.shell.render();
                this.shell.updateMap();
            }
            return result;
        }
        apply(command) {
            const me = this.world.player;
            const ok = (message) => ({ ok: true, message });
            const fail = (message) => ({ ok: false, message });
            switch (command.type) {
                case 'fleet.order': {
                    // One ship (shipId) or several (shipIds), all given the same job.
                    const ids = command.shipIds || [command.shipId];
                    const ships = ids.map((id) => this.world.get(id)).filter((ship) => ship && ship.owned && !ship.dead && !ship.isPlayer);
                    if (!ships.length)
                        return fail('Select a ship of yours other than the flagship.');
                    const role = command.role;
                    if (!Reach.JOBS[role])
                        return fail('Unknown job.');
                    if (command.post && !SE.SECTOR_BY_ID[command.post])
                        return fail('Unknown system.');
                    const done = [];
                    for (const ship of ships) {
                        if (role === 'mine' && (!SE.CLASSES[ship.cls].miner || !SE.SECTOR_BY_ID[ship.sector].belt))
                            continue;
                        if (role === 'repair') {
                            if (ship.hull >= ship.hullMax - 0.5)
                                continue;
                            if (ship.duty !== 'repair')
                                ship.prevDuty = ship.duty || 'escort';
                            ship.repairAt = undefined;
                        }
                        ship.duty = role;
                        ship.post = role === 'patrol' ? command.post || ship.sector : undefined;
                        ship.commanderId = me.id;
                        ship.orders.length = 0;
                        ship.orderT = 0;
                        ship.orderData = null;
                        ship.battleOrder = false;
                        if (role === 'mine')
                            ship.orders.push({ type: 'MINE', node: -1 });
                        else if (role === 'escort')
                            ship.orders.push(ship.sector !== me.sector ? { type: 'RETURN', target: me.id } : { type: 'GUARD', target: me.id, slot: this.fleet.indexOf(ship) });
                        else if (role === 'hold')
                            ship.orders.push({ type: 'WAIT', secs: 3600 });
                        done.push(ship);
                    }
                    if (!done.length)
                        return fail(role === 'mine' ? 'Mining needs a miner in a system with an asteroid belt.' : role === 'repair' ? 'None of those ships is damaged.' : 'No ship could take that job.');
                    ++this.state.metrics.orders;
                    const who = done.length === 1 ? done[0].name : done.length + ' ships';
                    const post = role === 'patrol' && command.post ? SE.SECTOR_BY_ID[command.post].name : null;
                    const what = role === 'mine' ? 'mining and selling ore' : role === 'escort' ? 'escorting your flagship' : role === 'hold' ? 'holding position' : role === 'repair' ? 'going to the nearest port to repair' : post ? 'heading to guard ' + post : 'guarding ' + (done.length === 1 ? SE.SECTOR_BY_ID[done[0].sector].name : 'their systems');
                    return ok(`${who}: ${what}.`);
                }
                case 'fleet.recall': {
                    const ships = this.fleet.filter((ship) => !ship.isPlayer && !SE.CLASSES[ship.cls].miner && ship.duty !== 'repair');
                    for (const ship of ships) {
                        ship.duty = 'escort';
                        ship.post = undefined;
                        ship.battleOrder = false;
                        ship.orders = [ship.sector !== me.sector ? { type: 'RETURN', target: me.id } : { type: 'GUARD', target: me.id }];
                        ship.orderT = 0;
                    }
                    return ships.length ? ok(`${ships.length} warship${ships.length === 1 ? '' : 's'} recalled to ${me.name}. Miners keep mining.`) : fail('No warships to recall.');
                }
                case 'squad.create': {
                    const ships = (command.shipIds || []).map((id) => this.world.get(id)).filter((ship) => ship && ship.owned && !ship.dead && !ship.isPlayer);
                    if (!ships.length)
                        return fail('Tick the ships to put in the squadron first.');
                    const used = new Set(this.state.squads.map((q) => q.name));
                    const name = Reach.SQUAD_NAMES.find((n) => !used.has(n)) || 'Wing ' + this.state.nextSquad;
                    const squad = { id: 'sq' + this.state.nextSquad++, name };
                    this.state.squads.push(squad);
                    for (const ship of ships)
                        ship.squad = squad.id;
                    this.pruneSquads();
                    return ok(`${name} formed: ${ships.map((ship) => ship.name).join(', ')}.`);
                }
                case 'squad.rename': {
                    const squad = this.state.squads.find((q) => q.id === command.id);
                    const name = String(command.name || '').trim().slice(0, 24);
                    if (!squad || !name)
                        return fail('Type a name for the squadron.');
                    squad.name = name;
                    return ok(`Squadron renamed ${name}.`);
                }
                case 'squad.disband': {
                    const squad = this.state.squads.find((q) => q.id === command.id);
                    if (!squad)
                        return fail('Squadron not found.');
                    for (const ship of this.fleet)
                        if (ship.squad === squad.id)
                            ship.squad = undefined;
                    this.state.squads = this.state.squads.filter((q) => q !== squad);
                    return ok(`${squad.name} disbanded. Its ships keep their jobs.`);
                }
                case 'squad.leave': {
                    const ship = this.world.get(command.shipId);
                    if (!ship || !ship.owned || !ship.squad)
                        return fail('That ship is not in a squadron.');
                    ship.squad = undefined;
                    this.pruneSquads();
                    return ok(`${ship.name} left its squadron.`);
                }
                case 'fleet.transfer': {
                    const ship = this.world.get(command.shipId);
                    if (!this.atPort)
                        return fail('Dock before transferring command.');
                    if (!ship || !ship.owned || ship.dead || ship.isPlayer || ship.sector !== me.sector)
                        return fail('Recall that ship to this system before transferring command.');
                    me.isPlayer = false;
                    me.duty = 'escort';
                    me.orders = [{ type: 'GUARD', target: ship.id, slot: 0 }];
                    ship.isPlayer = true;
                    ship.duty = undefined;
                    ship.orders = [];
                    for (const follower of this.fleet)
                        if (!follower.isPlayer)
                            follower.commanderId = ship.id;
                    this.scene.controls.reset(true);
                    this.scene.playerTarget = null;
                    this.scene.mineNode = -1;
                    this.scene.refitView(me);
                    this.scene.refitView(ship);
                    return ok(`Command transferred to ${ship.name}.`);
                }
                case 'ship.buy': {
                    if (!this.atPort)
                        return fail('Dock at a shipyard to commission a hull.');
                    return this.economy.queue(this.station, command.hullId, command.request);
                }
                case 'ship.cancel': return this.economy.cancel(command.jobId, command.request);
                case 'market.buy':
                case 'market.sell': {
                    if (!this.atPort)
                        return fail('Dock to use the market.');
                    return this.economy.trade(me, this.station, command.good, command.type === 'market.buy' ? 'buy' : 'sell', command.quantity, command.request, command.revision);
                }
                case 'ship.repair': {
                    if (!this.atPort)
                        return fail('Hull repairs require a port.');
                    const cost = this.repairCost;
                    if (!cost)
                        return fail('Hull is already fully repaired.');
                    if (this.world.credits < cost)
                        return fail('Insufficient credits for repairs.');
                    this.world.credits -= cost;
                    me.hull = me.hullMax;
                    me.shield = me.shieldMax;
                    return ok(`Hull and shields restored for ${Reach.credits(cost)} cr.`);
                }
                case 'module.fit':
                case 'module.remove': {
                    if (!this.atPort)
                        return fail('Dock before changing equipment.');
                    if (!SE.MODULES[command.moduleId])
                        return fail('Unknown equipment.');
                    const error = command.type === 'module.fit' ? this.scene.buyModule(command.moduleId) : this.scene.unfitModule(command.moduleId);
                    if (error)
                        return fail(error);
                    if (command.type === 'module.fit')
                        ++this.state.metrics.modules;
                    return ok(`${SE.MODULES[command.moduleId].name} ${command.type === 'module.fit' ? 'fitted' : 'removed'}.`);
                }
                case 'contract.accept': {
                    if (!this.atPort)
                        return fail('Dock to accept a station contract.');
                    const contract = this.scene.missions.board(this.station).find((c) => c.id === command.id);
                    if (!contract)
                        return fail('This contract is no longer available.');
                    if (contract.type === 'HAUL' && contract.need > me.cargoMax)
                        return fail(`This delivery requires ${contract.need} cargo capacity. Transfer to a larger hull first.`);
                    const error = this.scene.missions.accept(contract);
                    return error ? fail(error) : ok(`Accepted: ${contract.title}. Track it in Contracts.`);
                }
                case 'contract.deliver': {
                    if (!this.atPort)
                        return fail('Dock at the destination station.');
                    const before = this.world.contracts.length;
                    this.scene.missions.onDock(this.station, me);
                    return before === this.world.contracts.length ? fail('No complete delivery for this station. Check destination and cargo.') : ok('Delivery accepted. Contract rewards transferred.');
                }
                case 'industry.build': {
                    const recipe = Reach.INDUSTRIES.find((r) => r.id === command.kind);
                    if (!recipe)
                        return fail('Unknown facility.');
                    const sector = SE.SECTOR_BY_ID[this.world.sectorId];
                    if (sector.owner && SE.hostile('player', sector.owner))
                        return fail('Hostile authorities deny construction in this sector.');
                    if (recipe.id === 'extractor' && !sector.belt)
                        return fail('An orbital extractor needs an asteroid belt.');
                    if (this.state.outposts.filter((p) => p.sector === sector.id).length >= 6)
                        return fail('Sector infrastructure capacity is six facilities.');
                    if (this.world.credits < recipe.cost)
                        return fail('Insufficient construction credits.');
                    this.world.credits -= recipe.cost;
                    this.state.outposts.push({ id: 'outpost_' + this.state.nextOutpost++, kind: recipe.id, sector: sector.id, level: 1, stored: 0, stock: { ore: 0, alloy: 0, cells: 0, scrap: 0 }, cycle: 0, online: true, status: 'Producing' });
                    this.state.influence[sector.id] = Reach.clamp((this.state.influence[sector.id] || 0) + 15, 0, 100);
                    this.state.xp += 80;
                    return ok(`${recipe.name} established in ${sector.name}.`);
                }
                case 'industry.collect':
                case 'industry.upgrade':
                case 'industry.toggle': {
                    const outpost = this.state.outposts.find((p) => p.id === command.id);
                    if (!outpost)
                        return fail('Facility not found.');
                    const recipe = Reach.INDUSTRIES.find((r) => r.id === outpost.kind);
                    if (command.type === 'industry.toggle') {
                        outpost.online = !outpost.online;
                        return ok(`${recipe.name} ${outpost.online ? 'resumed' : 'suspended'}.`);
                    }
                    if (command.type === 'industry.upgrade') {
                        if (outpost.level >= 3)
                            return fail('Facility is at maximum level.');
                        const cost = Math.round(recipe.cost * 0.7 * outpost.level);
                        if (this.world.credits < cost)
                            return fail('Insufficient upgrade credits.');
                        this.world.credits -= cost;
                        ++outpost.level;
                        return ok(`${recipe.name} upgraded to level ${outpost.level}.`);
                    }
                    if (outpost.sector !== me.sector)
                        return fail('Travel to this sector to collect facility output.');
                    let room = Math.floor(me.cargoMax - SE.cargoUsed(me));
                    let taken = 0;
                    for (const good of Reach.GOODS) {
                        const quantity = Math.min(room, outpost.stock[good]);
                        me.cargo[good] = (me.cargo[good] || 0) + quantity;
                        outpost.stock[good] -= quantity;
                        taken += quantity;
                        room -= quantity;
                    }
                    return taken ? ok(`Transferred ${taken} units to ${me.name}.`) : fail('Storage is empty or your hold is full.');
                }
                case 'faction.war': {
                    const error = this.scene.sieges.declare(command.faction);
                    if (error)
                        return fail(error);
                    const name = SE.FACTIONS[command.faction].name;
                    return ok(`War declared on ${name}. Their stations and platforms will fire on your ships, and their systems can be besieged.`);
                }
                case 'faction.peace': {
                    const error = this.scene.sieges.peace(command.faction);
                    return error ? fail(error) : ok(`Peace agreed with ${SE.FACTIONS[command.faction].name}. ${Reach.credits(this.scene.sieges.PEACE_COST)} cr in reparations paid. Systems you took stay yours.`);
                }
                case 'faction.relief': {
                    if (!Reach.FACTIONS.includes(command.faction))
                        return fail('Unknown faction.');
                    if (this.state.wars[command.faction])
                        return fail('You are at war with them. Make peace first.');
                    const previous = this.state.reliefAt[command.faction];
                    if (previous !== undefined && this.world.elapsed - previous < 120)
                        return fail(`Next relief shipment in ${Math.ceil(120 - this.world.elapsed + previous)} seconds.`);
                    if ((me.cargo.cells || 0) < 8)
                        return fail('Carry 8 Energy Cells to commission a relief shipment.');
                    me.cargo.cells -= 8;
                    this.state.reliefAt[command.faction] = this.world.elapsed;
                    this.reputation(command.faction, 12);
                    this.state.xp += 40;
                    return ok(`Relief dispatched to ${SE.FACTIONS[command.faction].name}. +12 standing.`);
                }
                case 'sector.claim': {
                    const sector = SE.SECTOR_BY_ID[this.world.sectorId];
                    if (sector.owner)
                        return fail('Only an unclaimed sector can receive an independent charter.');
                    if (!this.state.outposts.some((p) => p.sector === sector.id) || (this.state.influence[sector.id] || 0) < 60)
                        return fail('Requires a local facility and 60 sector influence. Production builds influence.');
                    if (this.world.credits < 3000)
                        return fail('Charter registration costs 3,000 cr.');
                    this.world.credits -= 3000;
                    this.state.claims.push(sector.id);
                    sector.owner = 'player';
                    return ok(`${sector.name} is yours. It pays ${this.charterTax(sector.id)} cr a minute, more with every facility you build or upgrade there.`);
                }
            }
        }
        // A squadron with no ships left in it is gone.
        pruneSquads() {
            const live = new Set(this.fleet.map((ship) => ship.squad).filter(Boolean));
            this.state.squads = this.state.squads.filter((q) => live.has(q.id));
        }
        buyPrice(station, good) {
            return this.economy.price(station, good, 'buy', undefined, this.state.reputation[station.faction] || 0);
        }
        get repairCost() { return Math.ceil(Math.max(0, this.world.player.hullMax - this.world.player.hull) * 2); }
        pause(panel = 'overview') {
            this.paused = true;
            this.scene.controls.reset();
            this.scene.scene.pause();
            this.scene.galaxy.hide();
            this.shell.showPanel(panel);
        }
        /* The star chart is the main screen, so resuming means going back to
           it, with the galaxy running. */
        resume() {
            this.shell.hide();
            this.paused = false;
            this.scene.galaxy.show();
            this.shell.updateMap();
            this.audio.unlock();
        }
        dock(station) {
            if (!station || station.dead || station.sector !== this.world.sectorId || SE.hostile('player', station.faction) || this.scene.course) {
                this.shell.toast('Your flagship must be holding in a system with a friendly station to dock.', 'warn');
                return;
            }
            this.station = station;
            ++this.state.metrics.docked;
            this.checkMilestones();
            this.pause('market');
            void this.scene.autosave(true);
        }
        openChart() { this.resume(); }
        targetNearest() {
            const target = this.world.iface(this.world.sectorId).nearestHostile(this.world.player, 2200);
            this.scene.playerTarget = target?.id || null;
            this.scene.mineNode = -1;
            this.shell.toast(target ? `Target acquired: ${target.name}` : 'No hostile contacts within 2.2 km.', target ? 'info' : 'warn');
        }
        brake() { this.cancelNavigation(); this.scene.mineNode = -1; this.scene.controls.reset(true); this.shell.updateHUD(); }
        cancelNavigation() { this.navigation = null; this.world.player.orders.length = 0; this.scene.controls.state.throttle = 0; }
        /* Flight assists became map actions: "port" docks where the flagship
           already is, and travel is a course on the chart. */
        setNavigation(mode) {
            if (mode === 'port') {
                this.contextAction();
                return;
            }
            if (mode === 'mine') {
                this.shell.toast('Mining is done by your extractors. Give one a mining order in Fleet.', 'info');
                return;
            }
            if (mode === 'gate')
                return;
            const me = this.world.player;
            let destination = null;
            if (mode === 'port') {
                const port = this.world.iface(this.world.sectorId).stationFor(me);
                destination = port ? this.world.transit.dockPoint(port, me) : null;
            }
            else if (mode === 'gate')
                destination = this.scene.nextLeg()?.exit || null;
            else {
                const node = this.world.belt?.nearestOre(me.x, me.y, me.z, 6000) || null;
                if (node) {
                    this.navigationNode = node.index;
                    destination = node;
                }
            }
            if (!destination) {
                this.shell.toast(mode === 'gate' ? 'Set a course on the star chart first.' : 'No reachable destination in this sector.', 'warn');
                return;
            }
            this.scene.controls.reset(true);
            this.scene.mineNode = -1;
            this.navigation = mode;
            me.orderT = 0;
            me.orderData = null;
            me.orders = [{ type: 'MOVE', x: destination.x, y: destination.y, z: destination.z }];
            this.shell.toast(`Navigation assist: ${mode === 'port' ? 'nearest port' : mode === 'gate' ? 'jump gate' : 'ore seam'}. Steer to take control.`, 'info');
        }
        pilot(ship, view, dt) {
            if (!this.navigation || !view?.body)
                return false;
            const input = this.scene.controls.state;
            if (Math.abs(input.pitch) + Math.abs(input.yaw) > 0.15 || input.firing) {
                this.cancelNavigation();
                return false;
            }
            const order = ship.orders[0];
            if (!order || order.x === undefined || order.y === undefined || order.z === undefined) {
                this.cancelNavigation();
                return false;
            }
            const target = { x: order.x, y: order.y, z: order.z };
            const range = Reach.distance(ship, target);
            if (range < (this.navigation === 'port' ? 55 : this.navigation === 'mine' ? 100 : 95)) {
                view.body.setVelocity(0, 0, 0);
                view.body.setAngularVelocity(0, 0, 0);
                this.scene.speed = 0;
                if (this.navigation === 'port') {
                    const port = this.world.iface(ship.sector).stationFor(ship);
                    if (port)
                        this.dock(port);
                }
                else if (this.navigation === 'mine') {
                    const node = this.navigationNode;
                    this.cancelNavigation();
                    this.scene.mineNode = node;
                    this.shell.toast('Mining beam engaged. Fly or brake to depart.', 'info');
                }
                return true;
            }
            const intent = SE.AI.think(ship, this.world.iface(ship.sector), dt);
            SE.AI.applyPhysical(ship, intent, dt, view.body);
            this.scene.speed = Math.hypot(ship.vx, ship.vy, ship.vz);
            return true;
        }
        contextAction() {
            const port = this.nearbyPort;
            if (port) {
                this.dock(port);
                return;
            }
            this.shell.toast(this.scene.course ? 'Your fleet is under way. Dock when it arrives.' : 'No friendly station in this system.', 'warn');
        }
        boost(dt) {
            const active = this.scene.controls.state.boost && this.driveEnergy > 1;
            this.driveEnergy = Reach.clamp(this.driveEnergy + (active ? -24 : 9) * dt, 0, 100);
            return active ? 1.65 : 1;
        }
        /* An explosion you can hear is one in the system you are watching (or
           where your flagship is); losing a ship of yours anywhere is a sting. */
        killSound(victim) {
            const view = this.scene.systemView;
            const watching = view && view.open_ ? view.sector : this.world.sectorId;
            const cls = SE.CLASSES[victim.cls];
            if (victim.sector === watching)
                this.audio.play(cls.tier === 'heavy' || cls.tier === 'emplacement' ? 'boom' : 'explosion');
            if (victim.owned)
                this.audio.play('loss');
        }
        applySettings() {
            this.audio.applySettings();
            document.body.classList.toggle('reduce-motion', this.state.settings.reducedMotion);
            const level = ['low', 'medium', 'high'].indexOf(this.state.settings.quality);
            if (level >= 0)
                this.scene.setQuality(level);
        }
        dispose() {
            this.unsubscribe();
            document.removeEventListener('visibilitychange', this.visibility);
            document.removeEventListener('keydown', this.keyHandler);
            this.audio.dispose();
            this.shell.dispose();
            SE.hostile = this.priorHostility;
        }
    }
    Reach.Director = Director;
})(Reach || (Reach = {}));
SE.Director = Reach.Director;
