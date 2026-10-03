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
            wars: { apex: false, scrapper: false, vanguard: false }, strikes: {}, conquests: [], sieges: {}, history: [],
            settings: { sound: true, volume: 0.22, quality: 'auto', aimAssist: true, reducedMotion: false } };
    }
    Reach.createEmpire = createEmpire;
    // One sample a game minute for the dashboard's income graph: two hours of play.
    Reach.HISTORY_SAMPLES = 120;
    function restoreEmpire(raw) {
        const fresh = createEmpire();
        if (!raw || raw.version !== 2)
            return fresh;
        return { ...fresh, ...raw, settings: { ...fresh.settings, ...raw.settings }, metrics: { ...fresh.metrics, ...raw.metrics }, reputation: { ...fresh.reputation, ...raw.reputation },
            claimed: [...new Set(raw.claimed || [])], visited: [...new Set(raw.visited || ['home'])], journal: (raw.journal || []).slice(-70), outposts: raw.outposts || [],
            wars: { ...fresh.wars, ...raw.wars }, strikes: { ...raw.strikes }, conquests: raw.conquests || [], sieges: { ...raw.sieges }, history: (raw.history || []).slice(-Reach.HISTORY_SAMPLES) };
    }
    Reach.restoreEmpire = restoreEmpire;
    /* The game is one loop, and the first six objectives teach it in order:
         earn (a miner sells ore) -> go (fleet to the frontier) -> build (a
         facility makes influence and income) -> claim (the system pays you every
         minute) -> grow (more ships) -> and round again, further out.
       Then three side goals show the rest of the toolbox, and after that the
       objectives are just the size of the empire. Ids are what saves record,
       so the old ones are kept where the meaning survived. `tier` decides how
       the map presents them; `why` is the one line that says what it is for. */
    const owned = (s) => s.claims.length + (s.conquests || []).length;
    Reach.MILESTONES = [
        { id: 'orders', tier: 'tutorial', title: 'Put your miner to work', why: 'Ladle is a mining ship. Order it to mine and it digs ore and sells it at the station by itself. That is your first income.', reward: 300, xp: 60, panel: 'fleet', progress: (s) => s.metrics.orders, target: 1 },
        { id: 'trade', tier: 'tutorial', title: 'Earn from ore', why: 'Ladle fills its hold, flies to the station and sells. Watch it in the system view, and tap 1× to speed time up.', reward: 1500, xp: 100, panel: 'fleet', progress: (s) => s.metrics.sold, target: 20 },
        { id: 'frontier', tier: 'tutorial', title: 'Reach the frontier', why: 'Grey systems belong to nobody. Send your fleet to one. Harrow Deep is the closest.', reward: 3000, xp: 120, panel: 'overview', progress: (s) => s.visited.some((id) => SE.SECTOR_BY_ID[id] && !SE.SECTOR_BY_ID[id].owner && !SE.SECTOR_BY_ID[id].station) ? 1 : 0, target: 1 },
        { id: 'industry', tier: 'tutorial', title: 'Build a facility', why: 'A facility makes goods, sells the surplus for you, and builds your influence in the system.', reward: 1500, xp: 160, panel: 'industry', progress: (s) => s.outposts.length, target: 1 },
        { id: 'claim', tier: 'tutorial', title: 'Claim your first system', why: 'At 60 influence, register a charter. The system turns your colour and pays you every minute.', reward: 2500, xp: 300, panel: 'industry', progress: (s) => s.claims.length, target: 1 },
        { id: 'expand', tier: 'tutorial', title: 'Grow your fleet', why: 'Dock at a shipyard and commission a ship. More ships protect your miners and let you push further.', reward: 1000, xp: 180, panel: 'shipyard', progress: (s) => s.metrics.bought, target: 1 },
        { id: 'fit', tier: 'side', title: 'Outfit your flagship', why: 'Docked, fit a module. Every part trades one strength for another.', reward: 400, xp: 100, panel: 'outfit', progress: (s) => s.metrics.modules, target: 1 },
        { id: 'battle', tier: 'side', title: 'Win a battle', why: 'Pirates hunt miners and freighters. Take your fleet in, select your ships and tap an enemy to focus fire. Pause whenever you need to think.', reward: 600, xp: 150, panel: 'fleet', progress: (s) => s.metrics.kills, target: 2 },
        { id: 'contract', tier: 'side', title: 'Complete a contract', why: 'Stations post work that matches what is really happening nearby. Contracts pay well and raise faction standing.', reward: 800, xp: 180, panel: 'contracts', progress: (s) => s.metrics.contracts, target: 1 },
        { id: 'systems3', tier: 'goal', title: 'Hold 3 systems', why: 'Every system you hold pays you every minute. Find the next frontier system and repeat the loop.', reward: 3000, xp: 400, panel: 'industry', progress: owned, target: 3 },
        { id: 'systems5', tier: 'goal', title: 'Hold 5 systems', why: 'A wider empire earns faster. Upgrade facilities to build influence quicker.', reward: 6000, xp: 600, panel: 'industry', progress: owned, target: 5 },
        { id: 'conquest', tier: 'side', title: 'Capture a faction system', why: 'Faction systems come with a station and pay more than a frontier claim. Knock out the defences, then hold the station until its shield fails. They will want it back.', reward: 5000, xp: 500, panel: 'factions', progress: (s) => (s.conquests || []).length, target: 1 },
        { id: 'systems10', tier: 'goal', title: 'Hold 10 systems', why: 'A tenth of the galaxy carries your charter.', reward: 12000, xp: 900, panel: 'industry', progress: owned, target: 10 },
        { id: 'systems20', tier: 'goal', title: 'Hold 20 systems', why: 'The frontier is running out. The factions hold the rest.', reward: 25000, xp: 1400, panel: 'industry', progress: owned, target: 20 },
        { id: 'systems29', tier: 'goal', title: 'Charter the whole frontier', why: 'Every unclaimed system in the galaxy is yours.', reward: 50000, xp: 2400, panel: 'industry', progress: owned, target: 29 }
    ];
    Reach.TUTORIAL_STEPS = Reach.MILESTONES.filter((m) => m.tier === 'tutorial').length;
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
