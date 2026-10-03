/* Gameplay regression tests.
 *
 * Each file in tests/cases exports an array of { name, run(game) } cases.
 * The runner serves web/ over http, opens it in headless Chromium at a
 * phone size, and gives each case a fresh game. Cases drive the simulation
 * directly (game.step) rather than waiting in real time, so the suite is
 * quick enough to run before every APK build.
 *
 *   node tests/run.mjs            all cases
 *   node tests/run.mjs mining     only files whose name contains "mining"
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../web');
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(webRoot, url === '/' ? 'index.html' : url);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const filter = process.argv[2] || '';
const files = fs.readdirSync(path.join(here, 'cases')).filter(f => f.endsWith('.mjs') && f.includes(filter)).sort();
const browser = await playwright.chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// One game in one browser context; reload() keeps the context so the save survives.
async function newGame() {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  let page;
  const open = async () => {
    page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.SE_READY, null, { timeout: 30000 });
    await page.click('#launch-button');
    await page.waitForTimeout(200);
  };
  await open();
  const game = {
    get page() { return page; },
    errors,
    eval: (fn, arg) => page.evaluate(fn, arg),
    // Advance the simulation by game seconds, as fast as the browser can.
    step: secs => page.evaluate(n => { for (let i = 0; i < n * 4; i++) SE_HOST.step(0.25); }, secs),
    // Validate and write the current game exactly as autosave does; returns null or the error.
    save: () => page.evaluate(async () => { try { await SE_HOST.persist.save(SE.snapshot(SE_HOST.world)); return null; } catch (e) { return e.message; } }),
    reload: async () => { await page.close(); await open(); },
    close: () => context.close()
  };
  return game;
}

let pass = 0, fail = 0;
for (const file of files) {
  const cases = (await import(pathToFileURL(path.join(here, 'cases', file)))).default;
  for (const c of cases) {
    const game = await newGame();
    const started = Date.now();
    try {
      await c.run(game);
      if (game.errors.length) throw new Error('page error: ' + game.errors[0]);
      pass++;
      console.log(`  ok   ${file.replace('.mjs', '')} · ${c.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (e) {
      fail++;
      console.log(`  FAIL ${file.replace('.mjs', '')} · ${c.name}\n       ${e.message}`);
    }
    await game.close();
  }
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
