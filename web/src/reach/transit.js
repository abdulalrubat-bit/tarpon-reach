"use strict";
var Reach;
(function (Reach) {
    const RULES = Object.freeze({ stationScale: 3, stationRadius: 300, dockRange: 440, dockStop: 385, orbit: 490, gate: 1740, corridor: 118, lane: 38, cruise: 270 });
    const layouts = new Map();
    const radiusByHull = Object.freeze({ interceptor: 9, corvette: 14, extractor: 19, freighter: 29, dreadnought: 66, station: 300 });
    const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    function segmentDistance(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const t = Reach.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / (dx * dx + dy * dy + dz * dz || 1), 0, 1);
        return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t, p.z - a.z - dz * t);
    }
    function sectorLayout(sector) {
        const cached = layouts.get(sector);
        if (cached)
            return cached;
        const nodes = [], edges = [], gates = {};
        const connect = (a, b) => { nodes[a].links.push(b); nodes[b].links.push(a); edges.push({ a, b }); };
        for (let i = 0; i < 16; ++i) {
            const a = i * Math.PI / 8;
            nodes.push({ id: 'orbit_' + i, x: Math.cos(a) * RULES.orbit, y: 0, z: Math.sin(a) * RULES.orbit, links: [] });
        }
        for (let i = 0; i < 16; ++i)
            connect(i, (i + 1) % 16);
        const origin = SE.SECTOR_BY_ID[sector];
        for (const pair of SE.LANES) {
            const target = pair[0] === sector ? pair[1] : pair[1] === sector ? pair[0] : undefined;
            if (!target)
                continue;
            const destination = SE.SECTOR_BY_ID[target], dx = destination.gx - origin.gx, dz = destination.gy - origin.gy, n = Math.hypot(dx, dz);
            const index = nodes.length;
            gates[target] = index;
            nodes.push({ id: 'gate_' + target, x: dx / n * RULES.gate, y: 0, z: dz / n * RULES.gate, links: [] });
            let nearest = 0;
            for (let k = 1; k < 16; ++k)
                if (length(nodes[k], nodes[index]) < length(nodes[nearest], nodes[index]))
                    nearest = k;
            connect(nearest, index);
        }
        const result = { sector, nodes, edges, gates };
        layouts.set(sector, result);
        return result;
    }
    function laneFree(sector, p, radius) {
        const layout = sectorLayout(sector);
        if (Math.hypot(p.x, p.y, p.z) < RULES.orbit + RULES.corridor + radius)
            return false;
        for (const edge of layout.edges)
            if (segmentDistance(p, layout.nodes[edge.a], layout.nodes[edge.b]) < RULES.corridor + radius)
                return false;
        return true;
    }
    class TransitNetwork {
        constructor(world) {
            this.world = world;
            this.diagnostics = { plans: 0, recoveries: 0, probes: 0 };
            this.routes = new WeakMap();
            this.rocks = [];
            this.mining = new WeakMap();
        }
        layout(sector) { return sectorLayout(sector); }
        radius(ship) { return radiusByHull[ship.cls] || SE.CLASSES[ship.cls].size * 1.5; }
        gate(from, to) { const layout = this.layout(from), index = layout.gates[to]; return index === undefined ? null : layout.nodes[index]; }
        reset(ship) { this.routes.delete(ship); }
        /** Hash-derived side keeps a ship's berth stable; no per-frame randomness. */
        hash(ship) {
            let h = 0;
            for (let i = 0; i < ship.id.length; ++i)
                h = (Math.imul(h, 31) + ship.id.charCodeAt(i)) >>> 0;
            return h;
        }
        dockPoint(station, ship) {
            const a = (this.hash(ship) % 16) * Math.PI / 8;
            return { x: station.x + Math.cos(a) * RULES.dockStop, y: station.y, z: station.z + Math.sin(a) * RULES.dockStop };
        }
        patrol(ship) {
            const layout = this.layout(ship.sector);
            let closest = 0;
            for (let i = 1; i < layout.nodes.length; ++i)
                if (length(ship, layout.nodes[i]) < length(ship, layout.nodes[closest]))
                    closest = i;
            const node = layout.nodes[closest];
            const next = node.links[(this.hash(ship) + Math.floor(this.world.elapsed / 25)) % node.links.length];
            return { ...layout.nodes[next] };
        }
        /** Segment/sphere entry, including an already embedded starting position. */
        hit(a, b, p, r) {
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const ox = a.x - p.x, oy = a.y - p.y, oz = a.z - p.z;
            const c = ox * ox + oy * oy + oz * oz - r * r;
            if (c < 0)
                return 0;
            const aa = dx * dx + dy * dy + dz * dz;
            if (aa < 1e-9)
                return Infinity;
            const bb = ox * dx + oy * dy + oz * dz, discriminant = bb * bb - aa * c;
            if (discriminant < 0)
                return Infinity;
            const t = (-bb - Math.sqrt(discriminant)) / aa;
            return t >= 0 && t <= 1 ? t : Infinity;
        }
        obstacle(a, b, ship) {
            ++this.diagnostics.probes;
            const radius = this.radius(ship) + 12;
            let first = Infinity, result = null;
            for (const other of this.world.registry.inSector(ship.sector)) {
                if (other.dead || !SE.CLASSES[other.cls] || SE.CLASSES[other.cls].mass !== 0)
                    continue;
                const r = this.radius(other) + radius, t = this.hit(a, b, other, r);
                if (t < first) {
                    first = t;
                    result = { x: other.x, y: other.y, z: other.z, radius: r };
                }
            }
            const belt = ship.sector === this.world.sectorId ? this.world.belt : null;
            if (!belt)
                return result;
            const span = length(a, b), steps = Math.max(1, Math.ceil(span / 100));
            // Short spatial-grid probes avoid a capped query dropping the first rock on a long ray.
            for (let k = 0; k <= steps; ++k) {
                const f = k / steps;
                if (f > first + 100 / Math.max(1, span))
                    break;
                belt.near(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f, 100 + radius, this.rocks, 192);
                for (const index of this.rocks) {
                    const p = { x: belt.px[index], y: belt.py[index], z: belt.pz[index] }, r = belt.sc[index] * 1.3 + radius;
                    const t = this.hit(a, b, p, r);
                    if (t < first) {
                        first = t;
                        result = { ...p, radius: r };
                    }
                }
            }
            return result;
        }
        overhead(a, b, ship, out) {
            // Off-lane access travels above the belt, then descends to the work site.
            // The ring graph handles the central structure; this connector never crosses it.
            const belt = SE.SECTOR_BY_ID[ship.sector].belt;
            if (belt && length(a, b) > 180 && Math.max(Math.hypot(a.x, a.z), Math.hypot(b.x, b.z)) > 610) {
                const y = Math.max(RULES.cruise + this.radius(ship), a.y, b.y);
                if (Math.abs(a.y - y) > 20)
                    out.push({ x: a.x, y, z: a.z });
                out.push({ x: b.x, y, z: b.z });
            }
            out.push({ ...b });
        }
        plan(ship, goal, order) {
            ++this.diagnostics.plans;
            const layout = this.layout(ship.sector), points = [];
            if (length(ship, goal) < 260 && !this.obstacle(ship, goal, ship))
                points.push({ ...goal });
            else {
                // Dijkstra on a small immutable graph; lane costs remain independent of frame rate.
                let start = 0, end = 0;
                for (let i = 1; i < layout.nodes.length; ++i) {
                    if (length(ship, layout.nodes[i]) < length(ship, layout.nodes[start]))
                        start = i;
                    if (length(goal, layout.nodes[i]) < length(goal, layout.nodes[end]))
                        end = i;
                }
                const costs = new Float64Array(layout.nodes.length).fill(Infinity), previous = new Int16Array(layout.nodes.length).fill(-1), closed = new Uint8Array(layout.nodes.length);
                costs[start] = 0;
                for (let visit = 0; visit < layout.nodes.length; ++visit) {
                    let current = -1;
                    for (let i = 0; i < costs.length; ++i)
                        if (!closed[i] && (current < 0 || costs[i] < costs[current]))
                            current = i;
                    if (current < 0 || !Number.isFinite(costs[current]) || current === end)
                        break;
                    closed[current] = 1;
                    for (const next of layout.nodes[current].links) {
                        const candidate = costs[current] + length(layout.nodes[current], layout.nodes[next]);
                        if (candidate < costs[next]) {
                            costs[next] = candidate;
                            previous[next] = current;
                        }
                    }
                }
                const path = [end];
                while (path[0] !== start && previous[path[0]] >= 0)
                    path.unshift(previous[path[0]]);
                this.overhead(ship, layout.nodes[start], ship, points);
                for (let i = 1; i < path.length; ++i) {
                    const a = layout.nodes[path[i - 1]], b = layout.nodes[path[i]], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
                    const x = -(b.z - a.z) / l * RULES.lane, z = (b.x - a.x) / l * RULES.lane;
                    points.push({ x: a.x + x, y: 0, z: a.z + z }, { x: b.x + x, y: 0, z: b.z + z });
                }
                this.overhead(points[points.length - 1], goal, ship, points);
            }
            const state = { order, sector: ship.sector, goal: { ...goal }, points, cursor: 0, probe: 0, detour: null, last: { x: ship.x, y: ship.y, z: ship.z }, stalled: 0, recoveries: 0, routed: true, best: Infinity, noProgress: 0, lastCursor: 0 };
            this.routes.set(ship, state);
            return state;
        }
        miningPoint(ship, node) {
            const cached = this.mining.get(ship);
            if (cached && cached.sector === ship.sector && length(cached.node, node) < 1)
                return cached.point;
            const remember = (point) => { this.mining.set(ship, { node: { ...node }, sector: ship.sector, point }); return point; };
            // A stable stand-off on the upper hemisphere gives the laser access without driving at a rock's centre.
            const base = this.hash(ship) * 2.399963;
            for (let i = 0; i < 32; ++i) {
                const a = base + i * 2.399963, r = i === 0 ? 0 : Math.sqrt(i / 32) * 98;
                const p = { x: node.x + Math.cos(a) * r, y: node.y + Math.sqrt(104 * 104 - r * r), z: node.z + Math.sin(a) * r };
                const access = { x: p.x, y: RULES.cruise + this.radius(ship), z: p.z };
                if (!this.obstacle(p, p, ship) && !this.obstacle(access, p, ship))
                    return remember(p);
            }
            return remember(null);
        }
        bypass(ship, target, rock) {
            const dx = target.x - ship.x, dy = target.y - ship.y, dz = target.z - ship.z, l = Math.hypot(dx, dz) || 1;
            const margin = rock.radius + Math.max(35, this.radius(ship));
            const candidates = [{ x: rock.x, y: rock.y + margin, z: rock.z }, { x: rock.x - dz / l * margin, y: rock.y, z: rock.z + dx / l * margin }, { x: rock.x + dz / l * margin, y: rock.y, z: rock.z - dx / l * margin }, { x: rock.x, y: rock.y - margin, z: rock.z }];
            let best = candidates[0], score = Infinity;
            for (const point of candidates) {
                // Embedded ships must first exit radially; rejecting the starting overlap would deadlock recovery.
                const embedded = length(ship, rock) < rock.radius;
                const start = embedded ? { x: rock.x + (point.x - rock.x) / margin * (rock.radius + 2), y: rock.y + (point.y - rock.y) / margin * (rock.radius + 2), z: rock.z + (point.z - rock.z) / margin * (rock.radius + 2) } : ship;
                if (this.obstacle(start, point, ship))
                    continue;
                const cost = length(ship, point) + length(point, target) + (this.obstacle(point, target, ship) ? 600 : 0);
                if (cost < score) {
                    score = cost;
                    best = point;
                }
            }
            return best;
        }
        steer(ship, it, dt, order) {
            if (it.brake || it.throttle <= 0) {
                this.reset(ship);
                return;
            }
            const goal = { x: it.sx, y: it.sy, z: it.sz };
            const routed = ['MOVE', 'JUMP', 'TRADE', 'MINE'].includes(order.type) || (order.type === 'GUARD' && length(ship, goal) > 450 && !it.fire);
            let state = this.routes.get(ship);
            if (!state || state.routed !== routed || state.order !== order || state.sector !== ship.sector || length(state.goal, goal) > 100) {
                state = routed ? this.plan(ship, goal, order) : { order, sector: ship.sector, goal, points: [goal], cursor: 0, probe: 0, detour: null, last: { x: ship.x, y: ship.y, z: ship.z }, stalled: 0, recoveries: 0, routed: false, best: Infinity, noProgress: 0, lastCursor: 0 };
                this.routes.set(ship, state);
            }
            if (!routed) {
                state.points.length = 1;
                state.points[0] = goal;
                state.cursor = 0;
            }
            // Through-waypoints never apply an arrival brake; only the actual task endpoint does.
            // Passing over a waypoint counts, whatever the altitude; a climb waypoint above the ship still has to be climbed to.
            const passed = (p) => (ship.y >= p.y ? Math.hypot(ship.x - p.x, ship.z - p.z) : length(ship, p)) < Math.max(35, this.radius(ship) * 0.6);
            while (state.cursor < state.points.length - 1 && passed(state.points[state.cursor]))
                ++state.cursor;
            let target = state.points[state.cursor];
            const final = state.cursor === state.points.length - 1;
            if (final) {
                target = goal;
                state.points[state.cursor] = goal;
            }
            if (state.detour && length(ship, state.detour) < 30)
                state.detour = null;
            state.probe -= dt;
            if (state.probe <= 0) {
                state.probe = 0.25;
                const advanced = length(ship, state.last);
                state.last = { x: ship.x, y: ship.y, z: ship.z };
                state.stalled = advanced < 0.45 && length(ship, target) > it.stopRadius + 35 ? state.stalled + 0.25 : 0;
                if (!state.detour) {
                    const span = length(ship, target), look = Math.min(span, Math.max(140, Math.hypot(ship.vx, ship.vy, ship.vz) * 3 + this.radius(ship))), f = look / Math.max(1, span);
                    const probe = { x: ship.x + (target.x - ship.x) * f, y: ship.y + (target.y - ship.y) * f, z: ship.z + (target.z - ship.z) * f };
                    const obstacle = this.obstacle(ship, probe, ship);
                    if (obstacle)
                        state.detour = this.bypass(ship, target, obstacle);
                }
                const remaining = length(ship, target);
                if (state.cursor !== state.lastCursor || remaining < state.best - 3) {
                    state.best = remaining;
                    state.noProgress = 0;
                    state.lastCursor = state.cursor;
                }
                else if (remaining > it.stopRadius + 35)
                    state.noProgress += 0.25;
                if (state.stalled > 5 || state.noProgress > 14) {
                    // Climb clear, but only so far: repeated recoveries once lifted a miner kilometres up.
                    const ceiling = RULES.cruise + this.radius(ship) + 320;
                    state.detour = { x: ship.x, y: Math.max(RULES.cruise + this.radius(ship), Math.min(ceiling, ship.y + 160)), z: ship.z };
                    state.stalled = 0;
                    state.noProgress = 0;
                    state.best = Infinity;
                    ++state.recoveries;
                    ++this.diagnostics.recoveries;
                }
            }
            if (state.detour)
                target = state.detour;
            it.sx = target.x;
            it.sy = target.y;
            it.sz = target.z;
            if (!final || state.detour) {
                it.stopRadius = 0;
                it.tvx = it.tvy = it.tvz = 0;
            }
            // Follow slower traffic ahead without stopping both sides of a passing manoeuvre.
            const dx = target.x - ship.x, dz = target.z - ship.z, l = Math.hypot(dx, dz) || 1;
            for (const other of this.world.registry.inSector(ship.sector)) {
                if (other.id === ship.id || other.dead || SE.CLASSES[other.cls].mass === 0)
                    continue;
                const ox = other.x - ship.x, oz = other.z - ship.z, ahead = (ox * dx + oz * dz) / l;
                if (ahead <= 0 || ahead > this.radius(ship) + this.radius(other) + 95 || Math.abs(other.y - ship.y) > this.radius(ship) + this.radius(other) + 10)
                    continue;
                const lateral = Math.abs(ox * dz - oz * dx) / l;
                if (lateral > this.radius(ship) + this.radius(other) + 12)
                    continue;
                if (ship.id < other.id) {
                    it.sy += this.radius(ship) + this.radius(other) + 30;
                    it.throttle = Math.min(it.throttle, 0.65);
                }
                else
                    it.throttle = Math.min(it.throttle, 0.45);
            }
        }
        /** Layout migration only moves ships which would start inside enlarged static geometry or a rock. */
        reconcile(sector) {
            for (const ship of this.world.registry.inSector(sector)) {
                if (ship.cls === 'station')
                    continue;
                const station = this.world.registry.inSector(sector).find((item) => item.cls === 'station');
                if (SE.CLASSES[ship.cls].mass === 0) {
                    if (station && length(ship, station) < RULES.stationRadius + this.radius(ship) + 35) {
                        const a = Math.atan2(ship.z - station.z, ship.x - station.x);
                        ship.x = station.x + Math.cos(a) * 370;
                        ship.z = station.z + Math.sin(a) * 370;
                    }
                    continue;
                }
                if (station && length(ship, station) < RULES.stationRadius + this.radius(ship) + 25) {
                    const point = this.dockPoint(station, ship);
                    ship.x = point.x;
                    ship.y = point.y;
                    ship.z = point.z;
                    ship.vx = ship.vy = ship.vz = 0;
                }
                const obstruction = this.obstacle(ship, ship, ship);
                if (obstruction) {
                    ship.y = Math.max(RULES.cruise + this.radius(ship), ship.y + obstruction.radius + 40);
                    ship.vx = ship.vy = ship.vz = 0;
                }
                this.reset(ship);
            }
        }
    }
    Reach.TransitNetwork = TransitNetwork;
    Reach.Transit = { rules: RULES, layout: sectorLayout, laneFree, segmentDistance };
})(Reach || (Reach = {}));
Object.assign(SE, { Transit: Reach.Transit, TransitNetwork: Reach.TransitNetwork });
