// Step 3 of the system screen: the bottom bar and the grouped deck tabs.
import { ok, eq } from '../assert.mjs';

export default [
  {
    name: 'bottom bar: System, Fleet, Industry, Galaxy, and the menu opens Settings',
    async run(game) {
      const r = await game.eval(async () => {
        const d = SE_HOST.director, wait = ms => new Promise(res => setTimeout(res, ms));
        const click = v => document.querySelector(`#navbar [data-value="${v}"]`).click();
        const lit = () => document.querySelector('#navbar button.on')?.dataset.value || null;
        const tabs = () => [...document.querySelectorAll('#panel-tabs .tab')].map(t => t.dataset.value).join(',');
        d.resume(); await wait(100);
        const out = { start: lit(), shown: !document.getElementById('navbar').classList.contains('hidden') };
        click('system'); await wait(700);
        out.system = { lit: lit(), open: SE_HOST.systemView.open_, sector: SE_HOST.systemView.sector, theme: document.getElementById('navbar').dataset.theme };
        click('fleet'); await wait(200);
        out.fleet = { lit: lit(), panel: d.shell.panel, tabs: tabs(), sys: SE_HOST.systemView.open_ };
        document.querySelector('#panel-tabs [data-value="shipyard"]').click(); await wait(100);
        click('industry'); await wait(100);
        out.industry = { lit: lit(), panel: d.shell.panel, single: document.getElementById('panel-tabs').classList.contains('single') };
        click('fleet'); await wait(100);
        out.fleetAgain = d.shell.panel;
        click('galaxy'); await wait(100);
        out.galaxy = { lit: lit(), paused: d.paused };
        document.querySelector('#gxhead [data-action="menu"]').click(); await wait(100);
        out.menu = { panel: d.shell.panel, lit: lit() };
        document.querySelector('.gx-tabs [data-value="contracts"]').click(); await wait(100);
        out.contracts = { panel: d.shell.panel, lit: lit(), tabs: tabs() };
        return out;
      });
      ok(r.shown && r.start === 'galaxy', 'start: ' + JSON.stringify(r));
      ok(r.system.lit === 'system' && r.system.open && r.system.sector === 'home' && r.system.theme, 'system: ' + JSON.stringify(r.system));
      ok(r.fleet.lit === 'fleet' && r.fleet.panel === 'fleet' && r.fleet.tabs === 'fleet,shipyard,outfit,market' && !r.fleet.sys, 'fleet: ' + JSON.stringify(r.fleet));
      ok(r.industry.lit === 'industry' && r.industry.panel === 'industry' && r.industry.single, 'industry: ' + JSON.stringify(r.industry));
      eq(r.fleetAgain, 'shipyard', 'Fleet remembers its last tab');
      ok(r.galaxy.lit === 'galaxy' && !r.galaxy.paused, 'galaxy: ' + JSON.stringify(r.galaxy));
      ok(r.menu.panel === 'settings' && !r.menu.lit, 'menu: ' + JSON.stringify(r.menu));
      ok(r.contracts.panel === 'contracts' && r.contracts.lit === 'galaxy' && r.contracts.tabs === 'overview,empire,contracts,factions', 'contracts: ' + JSON.stringify(r.contracts));
    }
  }
];
