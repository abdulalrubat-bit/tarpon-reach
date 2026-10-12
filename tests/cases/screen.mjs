// The system map is the main feature: it must get the screen. The canvas
// fills the whole system view; header and details float over it, and the
// details sheet collapses to a strip so the map keeps the room.
import { ok, eq } from '../assert.mjs';

export default [
  {
    name: 'the map fills the system screen and the details sheet collapses',
    async run(game) {
      const r = await game.eval(async () => {
        const wait = ms => new Promise(res => setTimeout(res, ms));
        const v = SE_HOST.systemView, rect = el => el.getBoundingClientRect();
        SE_HOST.director.resume();
        v.close(); v.open('home');
        await wait(700);
        const sys = rect(document.getElementById('system'));
        const canvas = rect(document.querySelector('#syswrap > canvas:not(#sys-mini)'));
        const head = rect(document.getElementById('syshead')), sheet = () => rect(document.getElementById('sys-sheet'));
        const collapsed = { open: v.sheetOpen, h: sheet().height };
        v.select('wing1'); await wait(300);
        const opened = { open: v.sheetOpen, h: sheet().height };
        document.getElementById('sys-grab').click(); await wait(300);
        const full = { open: v.sheetOpen, full: v.sheetFull, h: sheet().height };
        document.getElementById('sys-grab').click(); await wait(300);
        const shut = { open: v.sheetOpen, h: sheet().height };
        // Overlays stay inside the visible band.
        const zoom = rect(document.querySelector('.sys-zoom')), jump = rect(document.getElementById('sys-jump'));
        return { full, sys: [sys.width, sys.height], canvas: [canvas.width, canvas.height, canvas.top - sys.top], head: head.height, collapsed, opened, shut,
          band: (sys.height - head.height - collapsed.h) / sys.height, zoomAbove: zoom.bottom <= sheet().top + 1, jumpBelow: jump.top >= head.bottom - 1 };
      });
      ok(Math.abs(r.canvas[0] - r.sys[0]) < 2 && Math.abs(r.canvas[1] - r.sys[1]) < 2 && Math.abs(r.canvas[2]) < 2, 'canvas does not fill the screen: ' + JSON.stringify(r));
      ok(r.head < 110, 'header too tall: ' + r.head);
      ok(!r.collapsed.open && r.collapsed.h < 100, 'sheet should start collapsed: ' + JSON.stringify(r.collapsed));
      ok(r.band > 0.7, 'visible map band only ' + Math.round(r.band * 100) + '% of the screen');
      ok(r.opened.open && r.opened.h > r.collapsed.h + 60, 'selecting a ship should open the sheet: ' + JSON.stringify(r.opened));
      ok(r.opened.h < r.sys[1] * 0.5, 'the sheet should open only halfway: ' + JSON.stringify(r.opened));
      ok(r.full.full && r.full.h >= r.opened.h, 'the handle should open it fully: ' + JSON.stringify(r.full));
      ok(!r.shut.open && r.shut.h < 100, 'the handle should collapse it: ' + JSON.stringify(r.shut));
      ok(r.zoomAbove && r.jumpBelow, 'overlays outside the visible band: ' + JSON.stringify(r));
    }
  },
  {
    name: 'map-only full screen hides the bars; a selection shows as a popup',
    async run(game) {
      const r = await game.eval(async () => {
        const wait = ms => new Promise(res => setTimeout(res, ms));
        const v = SE_HOST.systemView, $ = id => document.getElementById(id), shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
        SE_HOST.director.resume(); v.close(); v.open('home'); await wait(500);
        $('sys-full').click(); await wait(400);
        const canvas = document.querySelector('#syswrap > canvas:not(#sys-mini)').getBoundingClientRect();
        const full = { on: v.immersive, head: shown($('syshead')), nav: shown($('navbar')), sheet: shown($('sys-sheet')), bottom: Math.round(canvas.bottom), height: window.innerHeight };
        v.select('wing1'); await wait(300);
        const popup = { sheet: shown($('sys-sheet')), text: $('sys-panel').innerText.slice(0, 40), head: shown($('syshead')) };
        $('sys-full').click(); await wait(400);
        const back = { on: v.immersive, head: shown($('syshead')), nav: shown($('navbar')) };
        return { full, popup, back };
      });
      ok(r.full.on && !r.full.head && !r.full.nav && !r.full.sheet, 'full screen should hide header, bottom bar and strip: ' + JSON.stringify(r.full));
      ok(Math.abs(r.full.bottom - r.full.height) < 2, 'map should reach the bottom of the screen: ' + JSON.stringify(r.full));
      ok(r.popup.sheet && !r.popup.head && /Shrike/.test(r.popup.text), 'selection popup: ' + JSON.stringify(r.popup));
      ok(!r.back.on && r.back.head && r.back.nav, 'toggling back should restore the controls: ' + JSON.stringify(r.back));
    }
  }
];
