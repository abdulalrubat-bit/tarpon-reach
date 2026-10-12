// The star chart: the map fills the screen and the rest floats over it,
// decluttered: a goal pill, a legend behind a button, a details sheet that
// opens when a system is picked, and a full-screen button.
import { ok, eq } from '../assert.mjs';

export default [
  {
    name: 'the star chart map fills the screen; goal pill, legend, sheet and full screen',
    async run(game) {
      const r = await game.eval(async () => {
        const wait = ms => new Promise(res => setTimeout(res, ms)), $ = id => document.getElementById(id);
        const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
        const d = SE_HOST.director, gx = d.scene.galaxy;
        d.resume(); await wait(400);
        const root = $('galaxy').getBoundingClientRect(), cv = $('galaxymap').getBoundingClientRect();
        const pill = { cls: $('gx-objective').className, button: !!$('gx-objective').querySelector('button'), h: $('gx-objective').getBoundingClientRect().height };
        const sheet0 = { open: $('gx-sheet').classList.contains('open'), h: $('gx-sheet').getBoundingClientRect().height };
        gx.pick('lowmark'); d.shell.updateMap(); await wait(300);
        const sheet1 = { open: $('gx-sheet').classList.contains('open'), h: $('gx-sheet').getBoundingClientRect().height, send: shown($('gxset')) };
        $('gx-legend').click(); const legend = gx.legend;
        $('gx-full').click(); await wait(400);
        const cv2 = $('galaxymap').getBoundingClientRect();
        const full = { head: shown($('gxhead')), nav: shown($('navbar')), bottom: Math.round(cv2.bottom), height: innerHeight, exitTop: $('gx-full').getBoundingClientRect().top, pillBottom: $('gx-objective').getBoundingClientRect().bottom };
        $('gx-full').click(); await wait(300);
        const back = { head: shown($('gxhead')), nav: shown($('navbar')) };
        return { root: [root.width, root.height], cv: [cv.width, cv.height, cv.top - root.top], pill, sheet0, sheet1, legend, full, back };
      });
      ok(Math.abs(r.cv[0] - r.root[0]) < 2 && Math.abs(r.cv[1] - r.root[1]) < 2 && Math.abs(r.cv[2]) < 2, 'map does not fill the chart: ' + JSON.stringify(r));
      ok(/pill/.test(r.pill.cls) && r.pill.button && r.pill.h < 70, 'goal should be a one-line pill with its button: ' + JSON.stringify(r.pill));
      ok(!r.sheet0.open && r.sheet0.h < 90, 'sheet should start as one line: ' + JSON.stringify(r.sheet0));
      ok(r.sheet1.open && r.sheet1.send && r.sheet1.h > r.sheet0.h + 60, 'picking a system should open the sheet: ' + JSON.stringify(r.sheet1));
      ok(r.legend, 'legend button did not turn the legend on');
      ok(!r.full.head && !r.full.nav && Math.abs(r.full.bottom - r.full.height) < 2, 'full screen: ' + JSON.stringify(r.full));
      ok(r.full.exitTop >= r.full.pillBottom - 1, 'exit button hidden under the goal pill: ' + JSON.stringify(r.full));
      ok(r.back.head && r.back.nav, 'controls should come back: ' + JSON.stringify(r.back));
    }
  }
];
