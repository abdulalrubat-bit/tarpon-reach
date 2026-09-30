"use strict";
var Reach;
(function (Reach) {
    /** Validate every debit and capacity before writing any participant. Values are integer subunits. */
    class LedgerBatch {
        constructor() {
            this.entries = new Map();
        }
        add(cell, delta) {
            const entry = this.entries.get(cell.key) || { cell, before: cell.read(), after: cell.read() };
            entry.after += delta;
            this.entries.set(cell.key, entry);
        }
        commit() {
            for (const e of this.entries.values())
                if (!Number.isSafeInteger(e.after) || e.after < 0 || e.after > e.cell.max || e.cell.read() !== e.before)
                    return false;
            for (const e of this.entries.values())
                e.cell.write(e.after);
            return true;
        }
    }
    const MONEY_LIMIT = 1e14;
    const STOCK_LIMIT = 1e9;
    const RECEIPT_LIMIT = 96;
    const JOB_LIMIT = 96;
    const cents = (value) => Math.round(value * 100);
    const units = (value) => Math.round(value * 1000);
    Reach.BUILD_DEFINITIONS = {
        interceptor: { hull: 'interceptor', seconds: 35, materials: { alloy: 20, cells: 8 } },
        extractor: { hull: 'extractor', seconds: 50, materials: { alloy: 32, cells: 12 } },
        freighter: { hull: 'freighter', seconds: 70, materials: { alloy: 48, cells: 18 } },
        corvette: { hull: 'corvette', seconds: 90, materials: { alloy: 65, cells: 28 } },
        dreadnought: { hull: 'dreadnought', seconds: 180, materials: { alloy: 220, cells: 80 } }
    };
    Reach.STATION_RECIPES = {
        foundry: { id: 'foundry', name: 'Alloy foundry', seconds: 18, inputs: { ore: 12, cells: 2 }, outputs: { alloy: 6 }, cost: 12 },
        solar: { id: 'solar', name: 'Solar collectors', seconds: 15, inputs: {}, outputs: { cells: 6 }, cost: 4 },
        reclaim: { id: 'reclaim', name: 'Scrap reclamation', seconds: 22, inputs: { scrap: 8, cells: 1 }, outputs: { alloy: 4 }, cost: 8 }
    };
    Reach.STATION_PROFILES = {
        home: { name: 'Shipyard · solar', yard: true, recipes: ['solar'] },
        sill: { name: 'Reclamation · refinery', yard: false, recipes: ['foundry', 'reclaim', 'solar'] },
        kestrel: { name: 'Naval shipyard · solar', yard: true, recipes: ['solar'] },
        lowmark: { name: 'Industrial refinery · solar', yard: false, recipes: ['foundry', 'solar'] },
        ossuary: { name: 'Reclamation · refinery', yard: false, recipes: ['foundry', 'reclaim', 'solar'] },
        pilot: { name: 'Shipyard · refinery', yard: true, recipes: ['foundry', 'solar'] }
    };
    /* Generated systems (cosmos.js) carry a station KIND rather than a
       hand-written profile. Same shapes as the authored ones above. */
    Reach.STATION_KINDS = {
        depot: { name: 'Trade depot · solar', yard: false, recipes: ['solar'] },
        refinery: { name: 'Industrial refinery · solar', yard: false, recipes: ['foundry', 'solar'] },
        reclaim: { name: 'Reclamation · refinery', yard: false, recipes: ['foundry', 'reclaim', 'solar'] },
        yard: { name: 'Shipyard · solar', yard: true, recipes: ['solar'] }
    };
    const FALLBACK_PROFILE = { name: 'Trade depot', yard: false, recipes: [] };
    const TARGET_STOCK = { ore: 240, alloy: 100, cells: 120, scrap: 100 };
    class Economy {
        constructor(world, attach = () => { }) {
            this.world = world;
            this.attach = attach;
            this.active = false;
            this.accumulator = 0;
            this.timings = new Float32Array(128);
            this.timingCursor = 0;
            this.timingCount = 0;
            this.diagnostics = { steps: 0, transactions: 0, lastMilliseconds: 0, peakMilliseconds: 0 };
            this.state = world.economyState || { version: 1, time: world.elapsed, nextRequest: 1, settledThrough: 0, nextJob: 1, revision: 0, stations: {}, jobs: [], receipts: [], grants: 0, civilianPurchases: 0, operatingCosts: 0, completed: 0 };
            const initial = !world.economyState;
            world.economyState = this.state;
            world.economy = this;
            for (const ship of world.registry.all) {
                if (SE.CLASSES[ship.cls].tier !== 'structure' || this.state.stations[ship.id])
                    continue;
                const profile = this.profile(ship);
                this.state.stations[ship.id] = { id: ship.id, treasury: 4000000, capacity: Math.max(2000, ...Reach.GOODS.map((good) => Math.ceil((world.stationStock[ship.id] || {})[good] || 0))), production: profile.recipes.map((recipe) => ({ recipe, progress: 0, status: 'Ready', cycles: 0 })), demandClock: 0 };
                this.state.grants += 4000000;
            }
            this.stationList = Object.values(this.state.stations);
            // One funded civic commission introduces the supply chain. The saved job is its durable identity.
            const home = world.get('st_home');
            if (initial && home && this.station(home)) {
                const price = 220000;
                const account = this.station(home);
                account.treasury -= price;
                this.state.operatingCosts += price;
                this.state.jobs.push(this.makeJob(home, 'interceptor', false, price, 'Anchorage Watch'));
            }
        }
        profile(station) { var _a; return Reach.STATION_PROFILES[station.sector] || Reach.STATION_KINDS[(_a = SE.SECTOR_BY_ID[station.sector]) === null || _a === void 0 ? void 0 : _a.kind] || FALLBACK_PROFILE; }
        station(station) { return this.state.stations[station.id]; }
        get revision() { return this.state.revision; }
        get workP95() {
            if (!this.timingCount)
                return 0;
            const sorted = this.timings.slice(0, this.timingCount).sort();
            return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
        }
        nextRequest() { return this.state.nextRequest++; }
        stock(station) { var _a, _b; return (_a = this.world.stationStock)[_b = station.id] || (_a[_b] = {}); }
        inventoryCell(id, manifest, good, maximum = STOCK_LIMIT) {
            return { key: id + ':' + good, read: () => units(manifest[good] || 0), write: (v) => { manifest[good] = v / 1000; }, max: units(maximum) };
        }
        accountCell(ship) {
            return ship.owned ? { key: 'account:player', read: () => cents(this.world.credits), write: (v) => { this.world.credits = v / 100; }, max: MONEY_LIMIT }
                : { key: 'account:' + ship.id, read: () => cents(ship.credits), write: (v) => { ship.credits = v / 100; }, max: MONEY_LIMIT };
        }
        stationCell(account) { return { key: 'treasury:' + account.id, read: () => account.treasury, write: (v) => { account.treasury = v; }, max: MONEY_LIMIT }; }
        transact(request, fingerprint, operation) {
            const id = request === undefined ? this.nextRequest() : request;
            if (!Number.isSafeInteger(id) || id < 1 || id >= Number.MAX_SAFE_INTEGER)
                return { ok: false, message: 'Invalid transaction identity.' };
            const old = this.state.receipts.find((receipt) => receipt.id === id);
            if (old)
                return old.fingerprint === fingerprint ? { ...old.result, replayed: true } : { ok: false, message: 'Transaction identity belongs to a different command.' };
            if (id <= this.state.settledThrough)
                return { ok: false, message: 'This transaction was already settled. Refresh the service panel.' };
            if (this.active)
                return { ok: false, message: 'Another economic operation is committing.' };
            this.active = true;
            let result;
            try {
                result = operation();
                this.state.settledThrough = id;
                this.state.nextRequest = Math.max(this.state.nextRequest, id + 1);
                this.state.receipts.push({ id, fingerprint, at: this.state.time, result: { ...result } });
                if (this.state.receipts.length > RECEIPT_LIMIT)
                    this.state.receipts.shift();
                if (result.ok)
                    ++this.state.revision;
                ++this.diagnostics.transactions;
            }
            finally {
                this.active = false;
            }
            return result;
        }
        midpoint(station, good, quantity) {
            const target = TARGET_STOCK[good];
            const scarcity = Reach.clamp((target - quantity) / target, -1, 1);
            return SE.GOODS[good].base * Reach.clamp(Math.exp(0.65 * scarcity), 0.5, 2);
        }
        price(station, good, side, stock = this.stock(station)[good] || 0, reputation = 0) {
            // Matching midpoint bands make splitting a trade equivalent to one larger trade.
            const midpoint = this.midpoint(station, good, stock + (side === 'buy' ? -0.5 : 0.5));
            const spread = side === 'buy' ? 1.12 - Reach.clamp(reputation, 0, 100) * 0.0004 : 0.88;
            return (side === 'buy' ? Math.ceil(midpoint * spread * 100) : Math.floor(midpoint * spread * 100)) / 100;
        }
        quote(ship, station, good, side, requested) {
            const quote = { station: station.id, ship: ship.id, good, side, requested, quantity: 0, amount: 0, revision: this.revision, reason: '' };
            const account = this.station(station);
            if (!account || ship.dead || station.dead || ship.sector !== station.sector || SE.hostile(ship.faction, station.faction) || Reach.distance(ship, station) > Reach.Transit.rules.dockRange) {
                quote.reason = 'Move within docking range of a friendly station.';
                return quote;
            }
            if (!Reach.GOODS.includes(good) || !Number.isFinite(requested) || requested <= 0) {
                quote.reason = 'Choose a valid cargo quantity.';
                return quote;
            }
            const stock = this.stock(station)[good] || 0;
            const room = Math.max(0, Math.floor(ship.cargoMax - SE.cargoUsed(ship) + 1e-8));
            const maximum = Math.min(2000, Math.floor(requested), side === 'buy' ? Math.min(Math.floor(stock), room) : Math.min(Math.floor(ship.cargo[good] || 0), Math.floor(account.capacity - this.reservedAt(station, good) - stock)));
            const budget = side === 'buy' ? this.accountCell(ship).read() : account.treasury;
            const reputation = ship.owned ? this.world.empire?.reputation[station.faction] || 0 : 0;
            for (let i = 0; i < maximum; ++i) {
                const unit = cents(this.price(station, good, side, stock + (side === 'buy' ? -i : i), reputation));
                if (quote.amount + unit > budget)
                    break;
                ++quote.quantity;
                quote.amount += unit;
            }
            if (!quote.quantity)
                quote.reason = side === 'buy' ? 'Insufficient funds, available stock or cargo space.' : 'No whole units to sell, warehouse full, or station funds exhausted.';
            return quote;
        }
        trade(ship, station, good, side, requested, request, expectedRevision) {
            const result = this.transact(request, JSON.stringify(['trade', ship.id, station.id, good, side, requested]), () => {
                if (expectedRevision !== undefined && expectedRevision !== this.revision)
                    return { ok: false, message: 'The market changed. Review the updated quote.' };
                const q = this.quote(ship, station, good, side, requested);
                if (!q.quantity)
                    return { ok: false, message: q.reason };
                const account = this.station(station);
                const sign = side === 'buy' ? 1 : -1;
                const batch = new LedgerBatch();
                batch.add(this.inventoryCell('ship:' + ship.id, ship.cargo, good, ship.cargoMax), sign * units(q.quantity));
                batch.add(this.inventoryCell('station:' + station.id, this.stock(station), good, account.capacity - this.reservedAt(station, good)), -sign * units(q.quantity));
                batch.add(this.accountCell(ship), -sign * q.amount);
                batch.add(this.stationCell(account), sign * q.amount);
                if (!batch.commit())
                    return { ok: false, message: 'The transaction could not settle. No resources were transferred.' };
                return { ok: true, message: (side === 'buy' ? 'Bought ' : 'Sold ') + q.quantity + ' ' + SE.GOODS[good].name + ' for ' + (q.amount / 100).toFixed(2) + ' cr.', quantity: q.quantity, amount: q.amount };
            });
            if (result.ok && !result.replayed)
                this.reserveHead(station);
            if (result.ok && !result.replayed && side === 'sell' && ship.owned)
                this.world.events.emit({ type: 'trade', ship, station, good, quantity: result.quantity, credits: result.amount / 100 });
            return result;
        }
        makeJob(station, hull, owned, price, name) {
            const definition = Reach.BUILD_DEFINITIONS[hull];
            const id = 'build_' + this.state.nextJob++;
            return { id, station: station.id, hull, name, owned, price, escrow: 0, phase: 'waiting', materials: { ...definition.materials }, reserved: {}, duration: definition.seconds, progress: 0, shipId: 'commission_' + id, status: 'Waiting for materials' };
        }
        pendingOwned() { return this.state.jobs.filter((job) => job.owned && !['complete', 'cancelled'].includes(job.phase)).length; }
        queue(station, hull, request) {
            return this.transact(request, JSON.stringify(['queue', station.id, hull]), () => {
                const offer = Reach.HULLS.find((item) => item.id === hull);
                const account = this.station(station);
                const me = this.world.player;
                if (!offer || !Reach.BUILD_DEFINITIONS[hull] || !account || !this.profile(station).yard || station.dead || me.sector !== station.sector || Reach.distance(me, station) > Reach.Transit.rules.dockRange || SE.hostile(me.faction, station.faction))
                    return { ok: false, message: 'Dock at a friendly shipyard to commission this hull.' };
                if ((this.world.empire?.xp || 0) < offer.xp)
                    return { ok: false, message: 'This hull requires ' + offer.xp + ' command XP.' };
                if (this.world.registry.all.filter((ship) => ship.owned && !ship.dead).length + this.pendingOwned() >= 24)
                    return { ok: false, message: 'Fleet capacity includes commissioned hulls: 24 maximum.' };
                if (this.state.jobs.filter((job) => job.station === station.id && !['complete', 'cancelled'].includes(job.phase)).length >= 4)
                    return { ok: false, message: 'All four construction queue slots are reserved.' };
                this.compactJobs();
                if (this.state.jobs.length >= JOB_LIMIT)
                    return { ok: false, message: 'Construction records are at capacity. Complete existing orders first.' };
                const cost = cents(offer.price);
                const job = this.makeJob(station, hull, true, cost, SE.CLASSES[hull].name + ' ' + this.state.nextJob);
                const batch = new LedgerBatch();
                batch.add(this.accountCell(me), -cost);
                batch.add(this.escrowCell(job), cost);
                if (!batch.commit())
                    return { ok: false, message: 'Insufficient construction credits.' };
                this.state.jobs.push(job);
                return { ok: true, jobId: job.id, amount: cost, message: job.name + ' commissioned. Construction uses station materials; supply shortages appear in Shipyard.' };
            });
        }
        escrowCell(job) { return { key: 'escrow:' + job.id, read: () => job.escrow, write: (v) => { job.escrow = v; }, max: MONEY_LIMIT }; }
        cancel(jobId, request) {
            return this.transact(request, JSON.stringify(['cancel', jobId]), () => {
                const job = this.state.jobs.find((item) => item.id === jobId);
                if (!job || !job.owned || job.phase !== 'waiting')
                    return { ok: false, message: 'Only your unstarted commissions can be cancelled.' };
                const station = this.world.get(job.station);
                const account = station && this.station(station);
                if (!station || !account)
                    return { ok: false, message: 'Construction station is unavailable.' };
                const batch = new LedgerBatch();
                batch.add(this.escrowCell(job), -job.escrow);
                batch.add(this.accountCell(this.world.player), job.escrow);
                for (const good of Reach.GOODS)
                    if (job.reserved[good]) {
                        batch.add(this.inventoryCell('station:' + station.id, this.stock(station), good, account.capacity), units(job.reserved[good]));
                        batch.add(this.inventoryCell('reservation:' + job.id, job.reserved, good), -units(job.reserved[good]));
                    }
                if (!batch.commit())
                    return { ok: false, message: 'The station needs refund funds or warehouse space before cancellation can settle.' };
                job.phase = 'cancelled';
                job.status = 'Cancelled · credits refunded';
                return { ok: true, message: job.name + ' cancelled. Construction credits refunded.', jobId: job.id, amount: job.price };
            });
        }
        reserveHead(station) {
            const job = this.state.jobs.find((item) => item.station === station.id && !['complete', 'cancelled'].includes(item.phase));
            const account = this.station(station);
            if (job?.phase === 'waiting' && account)
                this.progressBuild(station, account, job, 0);
        }
        jobsAt(station) { return this.state.jobs.filter((job) => job.station === station.id && job.phase !== 'cancelled').slice(-8); }
        reservedAt(station, good) { return this.state.jobs.reduce((sum, job) => sum + (job.station === station.id && job.phase === 'waiting' ? job.reserved[good] || 0 : 0), 0); }
        need(job, good) { return job.phase === 'waiting' ? Math.max(0, (job.materials[good] || 0) - (job.reserved[good] || 0)) : 0; }
        sourceFor(good, destination) {
            return this.world.registry.all.filter((ship) => ship.id !== destination.id && !ship.dead && SE.CLASSES[ship.cls].tier === 'structure' && !SE.hostile('player', ship.faction) && (this.stock(ship)[good] || 0) >= 1)
                .sort((a, b) => this.price(a, good, 'buy') - this.price(b, good, 'buy'))[0];
        }
        compactJobs() {
            while (this.state.jobs.length >= JOB_LIMIT - 1) {
                const index = this.state.jobs.findIndex((job) => job.phase === 'complete' || job.phase === 'cancelled');
                if (index < 0)
                    return;
                this.state.jobs.splice(index, 1);
            }
        }
        advance(dt) {
            if (!Number.isFinite(dt) || dt <= 0)
                return;
            this.state.time += dt;
            this.accumulator += dt;
            if (this.accumulator + 1e-8 < 0.25)
                return;
            const elapsed = this.accumulator;
            this.accumulator = 0;
            const started = performance.now();
            for (const account of this.stationList) {
                const station = this.world.get(account.id);
                if (!station || station.dead)
                    continue;
                for (const slot of account.production)
                    this.produceStation(station, account, slot, elapsed);
                this.civilianDemand(station, account, elapsed);
                const job = this.state.jobs.find((item) => item.station === station.id && !['complete', 'cancelled'].includes(item.phase));
                if (job)
                    this.progressBuild(station, account, job, elapsed);
            }
            ++this.diagnostics.steps;
            this.diagnostics.lastMilliseconds = performance.now() - started;
            this.diagnostics.peakMilliseconds = Math.max(this.diagnostics.peakMilliseconds, this.diagnostics.lastMilliseconds);
            this.timings[this.timingCursor] = this.diagnostics.lastMilliseconds;
            this.timingCursor = (this.timingCursor + 1) % this.timings.length;
            this.timingCount = Math.min(this.timings.length, this.timingCount + 1);
        }
        produceStation(station, account, slot, dt) {
            const recipe = Reach.STATION_RECIPES[slot.recipe];
            const stock = this.stock(station);
            for (const good of Reach.GOODS) {
                if ((stock[good] || 0) < (recipe.inputs[good] || 0)) {
                    slot.status = 'Needs ' + SE.GOODS[good].name;
                    return;
                }
                if ((stock[good] || 0) - (recipe.inputs[good] || 0) + (recipe.outputs[good] || 0) + this.reservedAt(station, good) > account.capacity) {
                    slot.status = 'Output storage full';
                    return;
                }
            }
            if (account.treasury < cents(recipe.cost)) {
                slot.status = 'Needs operating credits';
                return;
            }
            slot.progress = Math.min(recipe.seconds, slot.progress + dt);
            if (slot.progress + 1e-8 < recipe.seconds) {
                slot.status = 'Producing';
                return;
            }
            const batch = new LedgerBatch();
            for (const good of Reach.GOODS)
                batch.add(this.inventoryCell('station:' + station.id, stock, good, account.capacity - this.reservedAt(station, good)), units((recipe.outputs[good] || 0) - (recipe.inputs[good] || 0)));
            batch.add(this.stationCell(account), -cents(recipe.cost));
            if (!batch.commit()) {
                slot.status = 'Awaiting a valid inventory state';
                return;
            }
            this.state.operatingCosts += cents(recipe.cost);
            slot.progress = 0;
            ++slot.cycles;
            slot.status = 'Producing';
            ++this.state.revision;
        }
        civilianDemand(station, account, dt) {
            account.demandClock = Math.min(30, account.demandClock + dt);
            if (account.demandClock < 30)
                return;
            account.demandClock = 0;
            const stock = this.stock(station);
            const quantity = Math.min(4, Math.floor(stock.cells || 0));
            if (!quantity)
                return;
            // Civilian procurement is an explicit external demand source, not money created by an AI sale.
            const payment = quantity * cents(SE.GOODS.cells.base);
            const batch = new LedgerBatch();
            batch.add(this.inventoryCell('station:' + station.id, stock, 'cells', account.capacity), -units(quantity));
            batch.add(this.stationCell(account), payment);
            if (batch.commit()) {
                this.state.civilianPurchases += payment;
                ++this.state.revision;
            }
        }
        progressBuild(station, account, job, dt) {
            if (job.phase === 'waiting') {
                const batch = new LedgerBatch();
                let allocated = 0;
                for (const good of Reach.GOODS) {
                    const quantity = Math.min(this.need(job, good), this.stock(station)[good] || 0);
                    if (quantity <= 0)
                        continue;
                    batch.add(this.inventoryCell('station:' + station.id, this.stock(station), good, account.capacity), -units(quantity));
                    batch.add(this.inventoryCell('reservation:' + job.id, job.reserved, good), units(quantity));
                    allocated += quantity;
                }
                if (allocated > 0 && batch.commit())
                    ++this.state.revision;
                const missing = Reach.GOODS.filter((good) => this.need(job, good) > 0).map((good) => this.need(job, good).toFixed(0) + ' ' + SE.GOODS[good].name).join(' · ');
                if (missing) {
                    job.status = 'Needs ' + missing;
                    return;
                }
                // Reserved cargo is consumed once at this durable phase transition.
                const settle = new LedgerBatch();
                settle.add(this.escrowCell(job), -job.escrow);
                settle.add(this.stationCell(account), job.escrow);
                if (!settle.commit()) {
                    job.status = 'Awaiting station settlement capacity';
                    return;
                }
                job.reserved = {};
                job.phase = 'building';
                job.status = 'Building';
                ++this.state.revision;
                return;
            }
            if (job.phase === 'building') {
                job.progress = Math.min(job.duration, job.progress + dt);
                job.status = 'Building · ' + Math.ceil(job.duration - job.progress) + 's remaining';
                if (job.progress + 1e-8 < job.duration)
                    return;
                job.phase = 'ready';
                ++this.state.revision;
            }
            if (job.phase === 'ready')
                this.commission(station, job);
        }
        commission(station, job) {
            if (this.world.get(job.shipId)) {
                job.phase = 'complete';
                job.status = 'Commissioned';
                return;
            }
            if (this.world.registry.all.length >= 1900 || (job.owned && this.world.registry.all.filter((ship) => ship.owned && !ship.dead).length >= 24)) {
                job.status = 'Ready · waiting for fleet capacity';
                return;
            }
            let position = null;
            const size = SE.CLASSES[job.hull].size;
            for (let i = 0; i < 48; ++i) {
                const angle = (i + Number(job.id.slice(6))) * 2.399963;
                const radius = Reach.Transit.rules.dockStop + Math.floor(i / 16) * 90;
                const candidate = { x: station.x + Math.cos(angle) * radius, y: station.y + 45 + size, z: station.z + Math.sin(angle) * radius };
                if (this.world.registry.inSector(station.sector).every((ship) => ship.dead || Reach.distance(candidate, ship) > SE.CLASSES[ship.cls].size + size + 18)) {
                    position = candidate;
                    break;
                }
            }
            if (!position) {
                job.status = 'Ready · launch approach occupied';
                return;
            }
            const ship = SE.makeShip({ id: job.shipId, name: job.name, cls: job.hull, sector: station.sector, faction: job.owned ? 'player' : station.faction, owned: job.owned, ...position });
            if (job.owned) {
                ship.duty = 'escort';
                ship.commanderId = this.world.player.id;
                ship.orders = [{ type: this.world.player.sector === ship.sector ? 'GUARD' : 'RETURN', target: this.world.player.id }];
            }
            else
                ship.orders = [{ type: 'GUARD', target: station.id }];
            this.world.registry.add(ship);
            job.phase = 'complete';
            job.status = 'Commissioned';
            ++this.state.completed;
            ++this.state.revision;
            if (ship.sector === this.world.sectorId)
                this.attach(ship);
            this.world.events.emit({ type: 'commission', ship, station, owned: job.owned });
        }
        produceOutpost(outpost, dt) {
            const recipe = Reach.INDUSTRIES.find((item) => item.id === outpost.kind);
            if (!recipe || !outpost.online) {
                outpost.status = 'Suspended';
                return;
            }
            outpost.cycle = Math.min(recipe.seconds, outpost.cycle + dt);
            if (outpost.cycle + 1e-8 < recipe.seconds)
                return;
            const output = recipe.quantity * outpost.level;
            const cost = Math.ceil(recipe.upkeep * outpost.level * (this.world.empire?.claims.includes(outpost.sector) ? 0.85 : 1));
            if (outpost.stock[recipe.good] + output > 600) {
                outpost.status = 'Storage full · collect output';
                return;
            }
            if (this.world.credits < cost) {
                outpost.status = 'Waiting for operating credits';
                return;
            }
            const batch = new LedgerBatch();
            if (recipe.input) {
                let needed = recipe.input.quantity * outpost.level;
                const good = recipe.input.good;
                for (const supplier of this.world.empire?.outposts || []) {
                    if (supplier.sector !== outpost.sector)
                        continue;
                    const quantity = Math.min(needed, supplier.stock[good]);
                    batch.add(this.inventoryCell('facility:' + supplier.id, supplier.stock, good, 600), -units(quantity));
                    needed -= quantity;
                    if (needed <= 0)
                        break;
                }
                if (needed > 0) {
                    outpost.status = 'Needs ' + needed + ' ' + SE.GOODS[good].name + ' in local storage';
                    return;
                }
            }
            batch.add(this.inventoryCell('facility:' + outpost.id, outpost.stock, recipe.good, 600), units(output));
            batch.add(this.accountCell(this.world.player), -cents(cost));
            if (!batch.commit()) {
                outpost.status = 'Waiting for resources';
                return;
            }
            outpost.cycle = 0;
            outpost.status = 'Producing';
            this.state.operatingCosts += cents(cost);
            ++this.state.revision;
            if (this.world.empire) {
                this.world.empire.metrics.production += output;
                this.world.empire.influence[outpost.sector] = Reach.clamp((this.world.empire.influence[outpost.sector] || 0) + 1, 0, 100);
            }
        }
    }
    Reach.Economy = Economy;
})(Reach || (Reach = {}));
Object.assign(SE, { Economy: Reach.Economy, BUILD_DEFINITIONS: Reach.BUILD_DEFINITIONS, STATION_RECIPES: Reach.STATION_RECIPES });
