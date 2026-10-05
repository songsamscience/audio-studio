/* Real Chromium Worker/WASM regression. Set NODE_PATH to installed Playwright. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8765';
  const out = path.join(__dirname, 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  const files = Object.fromEntries(fs.readdirSync(path.join(__dirname, 'fixtures')).filter(name => name !== 'manifest.json')
    .map(name => [name, fs.readFileSync(path.join(__dirname, 'fixtures', name)).toString('base64')]));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [], failures = [], consoleErrors = [];
  page.on('request', req => requests.push({ url: req.url(), method: req.method(), hasBody: !!req.postData() }));
  page.on('requestfailed', req => failures.push({ url: req.url(), error: req.failure()?.errorText }));
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.exposeFunction('qaProgress', message => console.log(message));
  await page.goto(base + '/tests/engine-runner.html', { waitUntil: 'networkidle' });
  const result = await page.evaluate(async files => {
    const load = name => new File([Uint8Array.from(atob(files[name]), c => c.charCodeAt(0))], name);
    return window.runEngineSuite(load, message => window.qaProgress(message));
  }, files);
  const origin = new URL(base).origin;
  const unexpectedNetwork = requests.filter(r => new URL(r.url).origin !== origin || r.method !== 'GET' || r.hasBody);
  const report = { browser: await browser.version(), base, ...result, requests, unexpectedNetwork, failures, consoleErrors };
  fs.writeFileSync(path.join(out, 'browser-engine.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: result.results.filter(r => r.pass).length, failed: result.results.filter(r => !r.pass), unexpectedNetwork, failures, consoleErrors, storage: result.storage }, null, 2));
  await browser.close();
  if (result.results.some(r => !r.pass) || unexpectedNetwork.length || failures.length || consoleErrors.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
