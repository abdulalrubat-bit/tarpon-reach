"use strict";
var Reach;
(function (Reach) {
    /** FIFO event delivery prevents a reward callback from recursively mutating the current event. */
    class EventBus {
        constructor() {
            this.listeners = new Set();
            this.pending = [];
            this.draining = false;
        }
        subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
        emit(event) {
            this.pending.push(event);
            if (this.draining)
                return;
            this.draining = true;
            try {
                let count = 0;
                while (this.pending.length > 0) {
                    if (++count > 512)
                        throw new Error('Event feedback loop exceeded its frame budget');
                    const next = this.pending.shift();
                    for (const listener of this.listeners)
                        listener(next);
                }
            }
            finally {
                this.draining = false;
                this.pending.length = 0;
            }
        }
        dispose() { this.listeners.clear(); this.pending.length = 0; }
    }
    Reach.EventBus = EventBus;
    Reach.GOODS = ['ore', 'alloy', 'cells', 'scrap'];
    Reach.FACTIONS = ['apex', 'scrapper', 'vanguard'];
    Reach.HULLS = [
        { id: 'interceptor', price: 2200, xp: 0, role: 'Fast escort · pursuit and defence' },
        { id: 'extractor', price: 3400, xp: 0, role: 'Autonomous mining · recurring revenue' },
        { id: 'freighter', price: 6200, xp: 250, role: '480-unit hold · bulk delivery and building supplies' },
        { id: 'corvette', price: 9800, xp: 600, role: 'Multi-role combat · two weapon mounts' },
        { id: 'dreadnought', price: 48000, xp: 1800, role: 'Capital command · four tracking batteries' }
    ];
    Reach.INDUSTRIES = [
        { id: 'extractor', name: 'Orbital extractor', description: 'Harvests an asteroid concession. Requires a belt.', cost: 5600, good: 'ore', quantity: 16, seconds: 20, upkeep: 18 },
        { id: 'refinery', name: 'Alloy foundry', description: 'Processes local extractor stock into valuable alloy.', cost: 9200, good: 'alloy', quantity: 5, seconds: 25, upkeep: 24, input: { good: 'ore', quantity: 14 } },
        { id: 'solar', name: 'Solar exchange', description: 'Produces energy cells for trade and faction relief.', cost: 12500, good: 'cells', quantity: 4, seconds: 30, upkeep: 30 }
    ];
    Reach.RANKS = [
        { xp: 0, name: 'Independent' }, { xp: 250, name: 'Free Captain' }, { xp: 600, name: 'Pathfinder' },
        { xp: 1100, name: 'Sector Warden' }, { xp: 1800, name: 'Commodore' }, { xp: 3200, name: 'Reach Marshal' }
    ];
    Reach.clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
    Reach.distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    Reach.credits = (value) => Math.round(value).toLocaleString('en-US');
    Reach.escapeHTML = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function rank(xp) { return [...Reach.RANKS].reverse().find((r) => xp >= r.xp) || Reach.RANKS[0]; }
    Reach.rank = rank;
    function createEmpire() {
        return { version: 2, xp: 0, claimed: [], visited: ['home'], reputation: { apex: 0, scrapper: -35, vanguard: 0 }, influence: {}, claims: [], outposts: [], journal: [],
            metrics: { sold: 0, earnings: 0, kills: 0, bought: 0, contracts: 0, modules: 0, docked: 0, orders: 0, production: 0 }, reliefAt: {}, nextOutpost: 1,
            settings: { sound: true, volume: 0.22, quality: 'auto', aimAssist: true, reducedMotion: false } };
    }
    Reach.createEmpire = createEmpire;
    function restoreEmpire(raw) {
        const fresh = createEmpire();
        if (!raw || raw.version !== 2)
            return fresh;
        return { ...fresh, ...raw, settings: { ...fresh.settings, ...raw.settings }, metrics: { ...fresh.metrics, ...raw.metrics }, reputation: { ...fresh.reputation, ...raw.reputation },
            claimed: [...new Set(raw.claimed || [])], visited: [...new Set(raw.visited || ['home'])], journal: (raw.journal || []).slice(-70), outposts: raw.outposts || [] };
    }
    Reach.restoreEmpire = restoreEmpire;
    Reach.MILESTONES = [
        { id: 'orders', title: 'Make your first command', description: 'Give Ladle a mining assignment in Fleet. It will mine, return to port and sell without your help.', reward: 180, xp: 60, panel: 'fleet', progress: (s) => s.metrics.orders, target: 1 },
        { id: 'dock', title: 'A port to call home', description: 'Approach Reach Anchorage and dock. Trade, refit, and accept work at the station.', reward: 150, xp: 70, panel: 'overview', progress: (s) => s.metrics.docked, target: 1 },
        { id: 'trade', title: 'Turn cargo into capital', description: 'Sell 20 units of cargo. Your mining fleet’s sales count toward this charter.', reward: 400, xp: 100, panel: 'market', progress: (s) => s.metrics.sold, target: 20 },
        { id: 'fit', title: 'Build for a purpose', description: 'Fit a module at port. Every upgrade has a trade-off; choose the ship you want to fly.', reward: 250, xp: 100, panel: 'outfit', progress: (s) => s.metrics.modules, target: 1 },
        { id: 'expand', title: 'A growing command', description: 'Commission another ship. More miners generate income; escorts protect the investment.', reward: 600, xp: 180, panel: 'shipyard', progress: (s) => s.metrics.bought, target: 1 },
        { id: 'contract', title: 'Earn a name in the Reach', description: 'Complete a station contract to earn credits and improve your standing with its faction.', reward: 650, xp: 180, panel: 'contracts', progress: (s) => s.metrics.contracts, target: 1 },
        { id: 'explore', title: 'Beyond the Anchorage', description: 'Visit three sectors. Set a course on the chart and engage navigation assist to the gate.', reward: 900, xp: 200, panel: 'overview', progress: (s) => s.visited.length, target: 3 },
        { id: 'industry', title: 'Something that lasts', description: 'Build your first orbital facility. Produce, collect, refine and sell its output.', reward: 1400, xp: 260, panel: 'industry', progress: (s) => s.outposts.length, target: 1 },
        { id: 'claim', title: 'An independent foothold', description: 'Establish industry in Harrow Deep, reach 60 influence, and register your sector charter.', reward: 3500, xp: 600, panel: 'industry', progress: (s) => s.claims.length, target: 1 }
    ];
    /** A bounded audio voice budget avoids accumulating oscillators during automatic fire. */
    class AudioSystem {
        constructor(settings) {
            this.settings = settings;
            this.context = null;
            this.master = null;
            this.voices = 0;
            this.shotAt = 0;
        }
        unlock() {
            if (!this.settings.sound)
                return;
            try {
                this.context || (this.context = new AudioContext());
                if (!this.master) {
                    this.master = this.context.createGain();
                    this.master.connect(this.context.destination);
                }
                this.master.gain.value = this.settings.volume;
                if (this.context.state === 'suspended')
                    void this.context.resume().catch(() => { });
            }
            catch {
                this.context = null;
            }
        }
        play(kind) {
            const ctx = this.context;
            if (!ctx || !this.master || !this.settings.sound || this.voices >= 8)
                return;
            if (kind === 'shot' && ctx.currentTime - this.shotAt < 0.12)
                return;
            if (kind === 'shot')
                this.shotAt = ctx.currentTime;
            const frequency = { tap: 660, reward: 520, hit: 88, shot: 170, jump: 120 }[kind];
            const duration = kind === 'reward' ? 0.32 : kind === 'jump' ? 0.55 : 0.1;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = kind === 'hit' || kind === 'shot' ? 'triangle' : 'sine';
            osc.frequency.setValueAtTime(frequency, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(kind === 'reward' || kind === 'jump' ? frequency * 2 : frequency * 0.55, ctx.currentTime + duration);
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(this.master);
            ++this.voices;
            osc.onended = () => { osc.disconnect(); gain.disconnect(); --this.voices; };
            osc.start();
            osc.stop(ctx.currentTime + duration + 0.02);
        }
        dispose() { if (this.context)
            void this.context.close().catch(() => { }); this.context = null; }
    }
    Reach.AudioSystem = AudioSystem;
})(Reach || (Reach = {}));
SE.EventBus = Reach.EventBus;
