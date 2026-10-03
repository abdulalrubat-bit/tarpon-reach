"use strict";
var Reach;
(function (Reach) {
    /** Reject inconsistent economic snapshots rather than silently recreating paid assets. */
    function validateEconomy(raw, ships, inventories) {
        const object = (value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('Invalid economy record.');
            return value;
        };
        const number = (value, maximum = 1e14, integer = false) => {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isSafeInteger(value)))
                throw new Error('Invalid economic quantity.');
            return value;
        };
        const text = (value, maximum = 300) => {
            if (typeof value !== 'string' || value.length > maximum)
                throw new Error('Invalid economy identifier.');
            return value;
        };
        const array = (value, maximum) => {
            if (!Array.isArray(value) || value.length > maximum)
                throw new Error('Invalid economy collection.');
            return value;
        };
        const manifest = (value) => {
            const data = object(value);
            const result = {};
            for (const key of Object.keys(data)) {
                if (!Reach.GOODS.includes(key))
                    throw new Error('Unknown reserved material.');
                result[key] = number(data[key], 1000000);
            }
            return result;
        };
        const source = object(raw);
        if (source.version !== 1)
            throw new Error('Unsupported economy version.');
        const stations = {};
        const definitions = object(source.stations);
        const expectedStations = ships.filter((ship) => SE.CLASSES[ship.cls].tier === 'structure');
        if (Object.keys(definitions).length !== expectedStations.length)
            throw new Error('Station account records are incomplete.');
        for (const ship of expectedStations) {
            const data = object(definitions[ship.id]);
            if (data.id !== ship.id)
                throw new Error('Station account identity mismatch.');
            const capacity = number(data.capacity, 1000000, true);
            const profile = Reach.stationProfile(ship.sector);
            const production = array(data.production, 8).map((value) => {
                const slot = object(value);
                const recipe = text(slot.recipe, 40);
                if (!profile.recipes.includes(recipe) || !Reach.STATION_RECIPES[recipe])
                    throw new Error('Invalid station recipe.');
                return { recipe, progress: number(slot.progress, Reach.STATION_RECIPES[recipe].seconds), cycles: number(slot.cycles, 1e12, true), status: text(slot.status) };
            });
            if (new Set(production.map((slot) => slot.recipe)).size !== profile.recipes.length || production.length !== profile.recipes.length)
                throw new Error('Duplicated or missing production slot.');
            stations[ship.id] = { id: ship.id, treasury: number(data.treasury, 1e14, true), capacity, production, demandClock: number(data.demandClock, 30) };
        }
        const jobIds = new Set();
        const shipIds = new Set();
        const jobs = array(source.jobs, 96).map((value) => {
            const data = object(value);
            const id = text(data.id, 80);
            const station = text(data.station, 120);
            const hull = text(data.hull, 60);
            const shipId = text(data.shipId, 120);
            const phase = text(data.phase, 20);
            if (!/^build_[1-9]\d*$/.test(id) || jobIds.has(id) || !stations[station] || !Reach.BUILD_DEFINITIONS[hull] || shipId !== 'commission_' + id || shipIds.has(shipId) || !['waiting', 'building', 'ready', 'complete', 'cancelled'].includes(phase))
                throw new Error('Invalid construction identity or state.');
            jobIds.add(id);
            shipIds.add(shipId);
            if (typeof data.owned !== 'boolean')
                throw new Error('Invalid construction ownership.');
            const materials = manifest(data.materials);
            const reserved = manifest(data.reserved);
            if (Reach.GOODS.some((good) => (materials[good] || 0) !== (Reach.BUILD_DEFINITIONS[hull].materials[good] || 0) || (reserved[good] || 0) > (materials[good] || 0)))
                throw new Error('Construction bill of materials is inconsistent.');
            if (phase !== 'waiting' && Reach.GOODS.some((good) => (reserved[good] || 0) > 0))
                throw new Error('Consumed materials cannot remain reserved.');
            const duration = number(data.duration, 3600);
            const progress = number(data.progress, duration);
            const price = number(data.price, 1e14, true);
            const escrow = number(data.escrow, 1e14, true);
            if ((duration !== Reach.BUILD_DEFINITIONS[hull].seconds && !(data.owned && duration === Reach.BUILD_DEFINITIONS[hull].quick)) || (phase === 'waiting' && data.owned ? escrow !== price : escrow !== 0))
                throw new Error('Construction duration or escrow is inconsistent.');
            if ((phase === 'waiting' && progress !== 0) || (['ready', 'complete'].includes(phase) && progress !== duration))
                throw new Error('Construction progress is inconsistent.');
            const existing = ships.find((ship) => ship.id === shipId);
            if (existing && (phase !== 'complete' || existing.cls !== hull || existing.owned !== data.owned))
                throw new Error('Construction would duplicate a commissioned ship.');
            return { id, station, hull, shipId, phase, owned: data.owned, name: text(data.name, 80), price, escrow, duration, progress, materials, reserved, status: text(data.status) };
        });
        for (const [id, station] of Object.entries(stations)) {
            for (const good of Reach.GOODS) {
                const reserved = jobs.reduce((sum, job) => sum + (job.station === id && job.phase === 'waiting' ? job.reserved[good] || 0 : 0), 0);
                if ((inventories[id]?.[good] || 0) + reserved > station.capacity + 1e-7)
                    throw new Error('Station inventory exceeds its reserved capacity.');
            }
            // The same lane policy the shipyard uses (Reach.laneError in economy.js).
            const lane = Reach.laneError(jobs, id);
            if (lane)
                throw new Error(lane);
        }
        const settledThrough = number(source.settledThrough, Number.MAX_SAFE_INTEGER - 2, true);
        const nextRequest = number(source.nextRequest, Number.MAX_SAFE_INTEGER - 1, true);
        const nextJob = number(source.nextJob, 1e12, true);
        if (nextRequest <= settledThrough || nextJob <= Math.max(0, ...jobs.map((job) => Number(job.id.slice(6)))))
            throw new Error('Economic sequence would reuse an identity.');
        const receiptIds = new Set();
        const receipts = array(source.receipts, 96).map((value) => {
            const data = object(value);
            const result = object(data.result);
            const id = number(data.id, settledThrough, true);
            if (id < 1 || receiptIds.has(id) || typeof result.ok !== 'boolean')
                throw new Error('Invalid economic receipt.');
            receiptIds.add(id);
            const clean = { ok: result.ok, message: text(result.message, 500) };
            if (result.quantity !== undefined)
                clean.quantity = number(result.quantity, 1000000);
            if (result.amount !== undefined)
                clean.amount = number(result.amount, 1e14, true);
            if (result.jobId !== undefined)
                clean.jobId = text(result.jobId, 80);
            return { id, at: number(data.at), fingerprint: text(data.fingerprint, 1000), result: clean };
        });
        return { version: 1, time: number(source.time), nextRequest, settledThrough, nextJob, revision: number(source.revision, 1e14, true), stations, jobs, receipts,
            grants: number(source.grants, 1e14, true), civilianPurchases: number(source.civilianPurchases, 1e14, true), operatingCosts: number(source.operatingCosts, 1e14, true), completed: number(source.completed, 1e12, true) };
    }
    Reach.validateEconomy = validateEconomy;
})(Reach || (Reach = {}));
