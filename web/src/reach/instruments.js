"use strict";
var Reach;
(function (Reach) {
    /** One catalogue drives navigation identity; game commands stay in Director. */
    Reach.PANEL_PRESENTATION = {
        overview: { label: 'Command', icon: 'fleet', group: 'command' },
        empire: { label: 'Empire', icon: 'crown', group: 'command' },
        fleet: { label: 'Fleet', icon: 'fleet', group: 'command' },
        contracts: { label: 'Contracts', icon: 'contract', group: 'command' },
        industry: { label: 'Industry', icon: 'industry', group: 'command' },
        factions: { label: 'Factions', icon: 'shield', group: 'command' },
        market: { label: 'Market', icon: 'trade', group: 'station' },
        outfit: { label: 'Outfitting', icon: 'gear', group: 'station' },
        shipyard: { label: 'Shipyard', icon: 'port', group: 'station' },
        settings: { label: 'Settings', icon: 'sliders', group: 'command' }
    };
    /** Fixed instruments outlive panel renders. Cache nodes and diff writes at HUD cadence. */
    class InstrumentView {
        constructor() {
            this.nodes = new Map();
            this.values = new Map();
        }
        node(id) {
            let element = this.nodes.get(id);
            if (!element) {
                element = document.getElementById(id) || undefined;
                if (!element)
                    throw new Error(`Missing instrument ${id}`);
                this.nodes.set(id, element);
            }
            return element;
        }
        text(id, value) { const key = id + ':text'; if (this.values.get(key) === value)
            return; this.values.set(key, value); this.node(id).textContent = value; }
        meter(id, value) {
            const percent = Math.round(Reach.clamp(Number.isFinite(value) ? value : 0, 0, 100) * 10) / 10;
            const text = percent + '%', key = id + ':width';
            if (this.values.get(key) === text)
                return;
            this.values.set(key, text);
            this.node(id).style.width = text;
        }
        state(id, key, value) {
            const cache = id + ':' + key;
            if (this.values.get(cache) === value)
                return;
            this.values.set(cache, value);
            this.node(id).setAttribute(key, value);
        }
        clear() { this.nodes.clear(); this.values.clear(); }
    }
    Reach.InstrumentView = InstrumentView;
})(Reach || (Reach = {}));
