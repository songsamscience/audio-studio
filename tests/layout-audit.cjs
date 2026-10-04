/* NODE_PATH=/path/to/node_modules node tests/layout-audit.cjs [base URL] */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8765';
  const out = path.resolve(__dirname, 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [], requests = [], failed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('request', req => requests.push({ url: req.url(), method: req.method(), body: !!req.postData() }));
  page.on('requestfailed', req => failed.push({ url: req.url(), error: req.failure()?.errorText }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const results = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 1280, 678, 375]) {
      await page.setViewportSize({ width, height: 960 });
      const result = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('body *')].filter(el => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        });
        const outside = visible.filter(el => {
          // Horizontally scrollable navigation owns its overflow intentionally.
          if (el.closest('.rail')) return false;
          const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1;
        }).slice(0, 15).map(el => ({ tag: el.tagName, id: el.id, class: el.className, text: el.textContent.slice(0, 60), rect: el.getBoundingClientRect().toJSON() }));
        const root = getComputedStyle(document.documentElement);
        const colors = Object.fromEntries(['text-main', 'text-sub', 'text-mute', 'bg-main', 'bg-card', 'bg-soft', 'bg-input', 'accent', 'accent-soft', 'primary', 'primary-hover', 'rail-text', 'rail-mute', 'rail-bg', 'rail-active', 'rail-active-text', 'story-ink', 'story-sub', 'story-eyebrow', 'story-bg'].map(key => [key, root.getPropertyValue('--' + key).trim()]));
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, outside, colors, fontStatus: document.fonts.status, fontLoaded: document.fonts.check('400 13px Pretendard') };
      });
      result.theme = theme;
      await page.screenshot({ path: path.join(out, `welcome-${width}-${theme}.png`), fullPage: true });
      results.push(result);
    }
  }
  function lum(hex) {
    const values = hex.replace('#', '').match(/.{2}/g).slice(0, 3).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
  }
  const contrast = [];
  for (const theme of ['light', 'dark']) {
    const colors = results.find(r => r.theme === theme).colors;
    const pairs = [
      ...['text-main', 'text-sub', 'text-mute'].flatMap(fg => ['bg-main', 'bg-card', 'bg-soft', 'bg-input'].map(bg => [fg, bg])),
      ['accent', 'accent-soft'], ['rail-text', 'rail-bg'], ['rail-mute', 'rail-bg'],
      ['rail-active-text', 'rail-active'], ['story-ink', 'story-bg'], ['story-sub', 'story-bg'], ['story-eyebrow', 'story-bg'],
      ['#ffffff', 'primary'], ['#ffffff', 'primary-hover'],
    ];
    for (const [fg, bg] of pairs) {
      const f = lum(colors[fg] || fg), b = lum(colors[bg] || bg);
      const ratio = (Math.max(f, b) + .05) / (Math.min(f, b) + .05);
      contrast.push({ theme, foreground: fg, background: bg, ratio: +ratio.toFixed(2), pass: ratio >= 4.5 });
    }
  }
  const report = { browser: await browser.version(), base, results, contrast, errors: [...new Set(errors)], failed, requests };
  fs.writeFileSync(path.join(out, 'layout-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ browser: report.browser, layouts: results.map(({ width, theme, documentWidth, outside, fontLoaded }) => ({ width, theme, documentWidth, outside, fontLoaded })), contrastFailures: contrast.filter(c => !c.pass), errors: report.errors, failed }, null, 2));
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
