// Browser tests with Playwright. Run: node --test tests/
// Needs Playwright + Chromium (preinstalled in the dev container, or `npm i -D playwright`).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadCodeGs, ownerSheet } = require('./fake-sheets');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e2) { chromium = null; }
}

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain' };
const FAKE_API = 'https://script.google.com/macros/s/TEST/exec';

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || p === '/config.js') {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}

// Fonts come from Google; block them so tests run offline and fast.
async function blockExternal(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
}

const chipSel = (job, field) => `.table-wrap [data-job="${job}"][data-chip="${field}"]`;

test('UI', { skip: !chromium && 'playwright not installed' }, async (t) => {
  const server = await serve();
  const base = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });

  await t.test('demo mode: open jobs, chips, picker rules, optimistic save', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await blockExternal(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForSelector('table.jobs tbody tr');

    assert.equal(await page.isVisible('#demo-banner'), true);
    const order = await page.$$eval('table.jobs tbody tr', (rows) => rows.map((r) => r.dataset.job));
    assert.deepEqual(order, ['1002', '1004', '1001'], 'soonest due first; closed jobs hidden');
    assert.equal(await page.textContent('#count-open'), '3');
    assert.equal(await page.textContent('#count-closed'), '2');
    assert.equal(await page.locator('tr[data-job="1002"] .due-overdue').count(), 1);
    assert.equal(await page.locator('tr[data-job="1004"] .due-soon').count(), 1);
    assert.equal(await page.locator('tr[data-job="1001"] .due-soon, tr[data-job="1001"] .due-overdue').count(), 0);

    // Chip colours
    assert.match(await page.getAttribute(chipSel(1004, 'material'), 'class'), /chip-red/);
    assert.match(await page.getAttribute(chipSel(1002, 'artwork'), 'class'), /chip-green/);
    assert.match(await page.getAttribute(chipSel(1004, 'artwork'), 'class'), /chip-blank/);
    assert.match(await page.getAttribute(chipSel(1001, 'estimate'), 'class'), /chip-green/);
    assert.match(await page.getAttribute(chipSel(1001, 'production'), 'class'), /chip-blue/);

    // Digitized only for Embroidery
    await page.click(chipSel(1001, 'artwork'));
    let opts = await page.$$eval('#picker-options [data-pick]', (b) => b.map((x) => x.dataset.pick));
    assert.deepEqual(opts, ['Sent to Customer', 'Approved', '']);
    await shot(page, 'desktop-picker');
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#picker'), true);
    await page.click(chipSel(1002, 'artwork'));
    opts = await page.$$eval('#picker-options [data-pick]', (b) => b.map((x) => x.dataset.pick));
    assert.deepEqual(opts, ['Sent to Customer', 'Approved', 'Digitized', '']);
    await page.keyboard.press('Escape');

    // Pick a value: updates immediately and persists
    await page.click(chipSel(1004, 'material'));
    await page.click('#picker-options [data-pick="Ordered"]');
    assert.equal((await page.textContent(chipSel(1004, 'material'))).trim(), 'Ordered');
    await page.waitForFunction(() => window.__app.state.pending.size === 0);
    await page.reload();
    await page.waitForSelector('table.jobs tbody tr');
    assert.equal((await page.textContent(chipSel(1004, 'material'))).trim(), 'Ordered');

    // Failed save rolls back with an error
    await page.evaluate(() => { window.API.updateField = () => new Promise((_, rej) => setTimeout(() => rej(new Error('network down')), 200)); });
    await page.click(chipSel(1001, 'payment'));
    await page.click('#picker-options [data-pick="Paid in Full"]');
    assert.equal((await page.textContent(chipSel(1001, 'payment'))).trim(), 'Paid in Full', 'optimistic');
    await page.waitForSelector('.toast-error');
    assert.equal((await page.textContent(chipSel(1001, 'payment'))).trim(), 'Billed', 'rolled back');
    assert.match(await page.textContent('.toast-error'), /network down/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('demo mode: detail drawer, new job, closed, reopen, filters, export', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await blockExternal(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('table.jobs tbody tr');

    // Drawer
    await page.click('tr[data-job="1001"] .open-job');
    await page.waitForSelector('#drawer.is-open');
    assert.equal(await page.inputValue('#d-customer'), 'SAMPLE - Sand Springs Youth Football');
    assert.match(await page.textContent('#drawer [data-says="due"]'), /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}$/, 'Day Month Year');
    const artOpts = await page.$$eval('#d-artwork option', (o) => o.map((x) => x.value));
    assert.deepEqual(artOpts, ['', 'Sent to Customer', 'Approved']);
    await page.fill('#d-notes', 'Customer called, wants navy');
    await page.click('#d-contact'); // blur saves
    await page.waitForSelector('#activity li:has-text("Customer called")');
    // Switching to an Embroidery type unlocks Digitized
    await page.selectOption('#d-type', 'Embroidery - Apparel');
    await page.waitForFunction(() => [...document.querySelectorAll('#d-artwork option')].some((o) => o.value === 'Digitized'));
    // Required field cannot be blanked
    await page.fill('#d-customer', '');
    await page.click('#d-contact');
    await page.waitForSelector('.toast-error:has-text("Customer is required")');
    assert.equal(await page.inputValue('#d-customer'), 'SAMPLE - Sand Springs Youth Football');
    await shot(page, 'desktop-drawer');
    await page.click('#drawer-close');
    await page.waitForSelector('#drawer', { state: 'hidden' });
    assert.equal(await page.textContent('tr[data-job="1001"] .col-type'), 'Embroidery - Apparel');

    // New job
    await page.click('#new-btn');
    assert.ok(await page.inputValue('#new-form [name="dateIn"]'));
    await page.click('#new-submit');
    assert.match(await page.textContent('#new-error'), /Customer, Project Type, Due Date/);
    await page.fill('#new-form [name="customer"]', 'Tulsa Hardware');
    await page.selectOption('#new-form [name="type"]', 'Heat Press - Hat');
    await page.fill('#new-form [name="due"]', '2030-01-15');
    assert.equal(await page.textContent('#new-form [data-says="due"]'), 'Tue 15 Jan 2030');
    await page.fill('#new-form [name="qty"]', '36');
    await shot(page, 'desktop-new-job');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1006"]');
    assert.match(await page.textContent('tr[data-job="1006"] .col-due'), /15 Jan 2030/);
    assert.equal(await page.textContent('#count-open'), '4');

    // Filters
    await page.fill('#f-search', 'tulsa');
    assert.deepEqual(await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job)), ['1006']);
    await page.fill('#f-search', '1002');
    assert.deepEqual(await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job)), ['1002']);
    await page.click('#f-clear');
    await page.selectOption('#f-field', 'material');
    await page.selectOption('#f-value', 'Waiting');
    assert.deepEqual(await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job)), ['1004']);
    await page.selectOption('#f-value', '__blank__');
    assert.deepEqual(await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job)), ['1006']);
    await page.click('#f-clear');
    await page.selectOption('#f-type', 'Embroidery - Hats');
    assert.deepEqual(await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job)), ['1002']);
    await page.click('#f-clear');

    // Complete a job -> Closed
    await page.click(chipSel(1002, 'status'));
    await page.click('#picker-options [data-pick="Complete"]');
    await page.waitForSelector('tr[data-job="1002"]', { state: 'detached' });

    await page.click('#tab-closed');
    const closed = await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job));
    assert.deepEqual(closed, ['1002', '1003', '1005'], 'most recent first');
    assert.match(await page.getAttribute('tr[data-job="1005"]', 'class'), /row-dead/);
    assert.match(await page.getAttribute(chipSel(1005, 'status'), 'class'), /chip-dead/);
    await shot(page, 'desktop-closed');

    // Reopen dead job
    await page.click(chipSel(1005, 'status'));
    await page.click('#picker-options [data-pick="Active"]');
    await page.waitForSelector('tr[data-job="1005"]', { state: 'detached' });
    await page.click('#tab-open');
    await page.waitForSelector('tr[data-job="1005"]');

    // Export
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'Job #,Date In,Due Date,Customer,Contact Name,Phone,Email,Project Type,Description,Qty,' +
      'Status,Estimate,Material,Artwork,Production,Delivery,Payment,Notes,Created At,Updated At');
    assert.equal(lines.length, 7);
    assert.match(lines[6], /^1006,.*,15 Jan 2030,Tulsa Hardware,/);
    assert.match(download.suggestedFilename(), /^signs-stitches-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('phone layout: cards and bottom-sheet picker', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await blockExternal(page);
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.cards .card');
    assert.equal(await page.isVisible('.table-wrap'), false);
    assert.equal(await page.locator('.cards .card').count(), 3);
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(noHScroll, 'no horizontal page scroll');
    const small = await page.$$eval('.cards .chip, .btn, .tab, .input', (els) =>
      els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).length);
    assert.equal(small, 0, 'tap targets at least 44px');
    await shot(page, 'phone-open-jobs');
    await page.tap('.cards [data-job="1004"][data-chip="estimate"]');
    const box = await page.locator('#picker').boundingBox();
    assert.ok(box.y + box.height >= 843 && box.width >= 389, 'picker is a bottom sheet');
    await shot(page, 'phone-picker');
    await page.tap('#picker-options [data-pick="Approved"]');
    assert.equal((await page.textContent('.cards [data-job="1004"][data-chip="estimate"] .chip-value')).trim(), 'Approved');
    await page.tap('.cards .card[data-job="1004"] .open-job');
    await page.waitForSelector('#drawer.is-open');
    await page.waitForTimeout(300); // slide-in
    await shot(page, 'phone-drawer');
    await ctx.close();
  });

  await t.test('remote mode: talks to Code.gs with text/plain POSTs and polls', async () => {
    const ss = ownerSheet();
    const gs = loadCodeGs(ss);
    gs.setup();
    const seen = [];
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await blockExternal(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/config.js', (r) => r.fulfill({
      contentType: 'text/javascript', body: `window.APP_CONFIG = { API_URL: '${FAKE_API}' };`
    }));
    await page.route(FAKE_API + '*', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      seen.push({ method: req.method(), type: req.headers()['content-type'] || '' });
      let out;
      if (req.method() === 'POST') out = gs.doPost({ postData: { contents: req.postData() } });
      else out = gs.doGet({ parameter: Object.fromEntries(url.searchParams) });
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: out.text });
    });
    await page.goto(base);
    await page.waitForSelector('table.jobs tbody tr');
    assert.equal(await page.isVisible('#demo-banner'), false);
    assert.deepEqual(await page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job)), ['1002', '1001']);

    await page.click(chipSel(1001, 'material'));
    await page.click('#picker-options [data-pick="Received"]');
    await page.waitForFunction(() => window.__app.state.pending.size === 0);
    assert.equal(ss.sheets['Job Log'].data[1][12], 'Received', 'written to the sheet');
    const post = seen.find((s) => s.method === 'POST');
    assert.match(post.type, /^text\/plain/, 'POST sent as text/plain (no preflight)');
    assert.ok(!seen.some((s) => s.method === 'OPTIONS'));

    // Someone edits the sheet directly; the next poll picks it up.
    ss.sheets['Job Log'].data[2][14] = 'Finished';
    await page.evaluate(() => window.__app.refresh());
    await page.waitForFunction(() => document.querySelector('.table-wrap [data-job="1002"][data-chip="production"]').textContent.trim() === 'Finished');

    // New job through the sheet backend
    await page.click('#new-btn');
    await page.fill('#new-form [name="customer"]', 'Remote Co');
    await page.selectOption('#new-form [name="type"]', 'Embroidery - Hats');
    await page.fill('#new-form [name="due"]', '2031-02-03');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1004"]');
    const row = ss.sheets['Job Log'].data[4];
    assert.equal(row[0], 1004);
    assert.equal(row[3], 'Remote Co');
    assert.equal(row[10], 'Active');

    // Activity in the drawer comes from the Activity tab
    await page.click('tr[data-job="1001"] .open-job');
    await page.waitForSelector('#activity li:has-text("Material")');
    await shot(page, 'desktop-open-jobs-remote');
    assert.deepEqual(errors, []);
    await page.close();
  });
});
