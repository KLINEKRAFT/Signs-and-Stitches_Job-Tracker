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

  const rowsOf = (page) => page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job));
  const dismissToasts = (page) => page.$$eval('.toast', (ts) => ts.forEach((t) => t.remove()));

  async function freshPage(opts) {
    const page = await browser.newPage(Object.assign({ viewport: { width: 1400, height: 900 } }, opts));
    await blockExternal(page);
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('table.jobs tbody tr');
    return page;
  }

  await t.test('demo mode: open jobs, chips, picker rules, optimistic save', async () => {
    const page = await freshPage();
    assert.equal(await page.isVisible('#demo-banner'), true);
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007', '1004', '1001', '1008'],
      'soonest due first, an order kept together, On Hold still open, closed jobs hidden');
    assert.equal(await page.textContent('#count-open'), '6');
    assert.equal(await page.textContent('#count-closed'), '2');
    assert.equal(await page.locator('tr[data-job="1002"] .due-overdue').count(), 1);
    assert.equal(await page.locator('tr[data-job="1004"] .due-soon').count(), 1);
    assert.equal(await page.locator('tr[data-job="1001"] .due-soon, tr[data-job="1001"] .due-overdue').count(), 0);
    assert.equal(await page.locator('table.jobs th:has-text("Qty")').count(), 0, 'no Qty column');

    // Chip colours, including the new options
    assert.match(await page.getAttribute(chipSel(1004, 'material'), 'class'), /chip-red/);
    assert.match(await page.getAttribute(chipSel(1002, 'artwork'), 'class'), /chip-green/);
    assert.match(await page.getAttribute(chipSel(1004, 'artwork'), 'class'), /chip-blank/);
    assert.match(await page.getAttribute(chipSel(1001, 'estimate'), 'class'), /chip-green/);
    assert.match(await page.getAttribute(chipSel(1001, 'production'), 'class'), /chip-blue/);
    assert.match(await page.getAttribute(chipSel(1008, 'status'), 'class'), /chip-red/, 'On Hold');
    assert.match(await page.getAttribute(chipSel(1008, 'estimate'), 'class'), /chip-grey/, 'Not Sent');
    assert.match(await page.getAttribute(chipSel(1006, 'artwork'), 'class'), /chip-amber/, 'Being Designed');

    // Linked projects show where the order stands
    assert.equal((await page.textContent('tr[data-job="1002"] .order-badge')).trim(), 'Order 1002 - 0 of 3 ready');
    assert.equal(await page.locator('tr[data-job="1001"] .order-badge').count(), 0);

    // Picker options: new Status option; Digitized only for Embroidery
    await page.click(chipSel(1001, 'status'));
    let opts = await page.$$eval('#picker-options [data-pick]', (b) => b.map((x) => x.dataset.pick));
    assert.deepEqual(opts, ['Active', 'On Hold', 'Complete', 'Dead', '']);
    await page.keyboard.press('Escape');
    await page.click(chipSel(1001, 'artwork'));
    opts = await page.$$eval('#picker-options [data-pick]', (b) => b.map((x) => x.dataset.pick));
    assert.deepEqual(opts, ['Being Designed', 'Sent to Customer', 'Approved', '']);
    await shot(page, 'desktop-picker');
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#picker'), true);
    await page.click(chipSel(1002, 'artwork'));
    opts = await page.$$eval('#picker-options [data-pick]', (b) => b.map((x) => x.dataset.pick));
    assert.deepEqual(opts, ['Being Designed', 'Sent to Customer', 'Approved', 'Digitized', '']);
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
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test('demo mode: drawer, simple new job, filters', async () => {
    const page = await freshPage();

    await page.click('tr[data-job="1001"] .open-job');
    await page.waitForSelector('#drawer.is-open');
    assert.equal(await page.inputValue('#d-customer'), 'SAMPLE - Sand Springs Youth Football');
    assert.match(await page.textContent('#drawer [data-says="due"]'), /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}$/, 'Day Month Year');
    assert.equal(await page.locator('#d-qty').count(), 0, 'no Qty in the drawer');
    assert.match(await page.textContent('#drawer-order'), /on its own/);
    const artOpts = await page.$$eval('#d-artwork option', (o) => o.map((x) => x.value));
    assert.deepEqual(artOpts, ['', 'Being Designed', 'Sent to Customer', 'Approved']);
    await page.fill('#d-notes', 'Customer called, wants navy');
    await page.click('#d-contact'); // blur saves
    await page.waitForSelector('#activity li:has-text("Customer called")');
    await page.selectOption('#d-type', 'Embroidery - Apparel');
    await page.waitForFunction(() => [...document.querySelectorAll('#d-artwork option')].some((o) => o.value === 'Digitized'));
    await page.fill('#d-customer', '');
    await page.click('#d-contact');
    await page.waitForSelector('.toast-error:has-text("Customer is required")');
    assert.equal(await page.inputValue('#d-customer'), 'SAMPLE - Sand Springs Youth Football');
    await page.click('#drawer-close');
    await page.waitForSelector('#drawer', { state: 'hidden' });
    assert.equal(await page.textContent('tr[data-job="1001"] .col-type'), 'Embroidery - Apparel');

    // Simple new job: three things to fill in, no Qty
    await page.click('#new-btn');
    assert.equal(await page.locator('#new-form [name="qty"]').count(), 0);
    assert.equal(await page.isVisible('#new-form [name="contact"]'), false, 'extra fields tucked away');
    assert.ok(await page.inputValue('#new-form [name="dateIn"]'));
    await page.click('#new-submit');
    assert.match(await page.textContent('#new-error'), /Customer, Due Date, Project Type/);
    await page.fill('#new-form [name="customer"]', 'Tulsa Hardware');
    await page.selectOption('.project-row select', 'Heat Press - Hat');
    await page.fill('#new-form [name="due"]', '2030-01-15');
    assert.equal(await page.textContent('#new-form [data-says="due"]'), 'Tue 15 Jan 2030');
    assert.equal((await page.textContent('#new-submit')).trim(), 'Create Job');
    await shot(page, 'desktop-new-job');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1009"]');
    assert.match(await page.textContent('tr[data-job="1009"] .col-due'), /15 Jan 2030/);
    assert.equal((await page.textContent(chipSel(1009, 'estimate'))).trim(), 'Not Sent', 'estimate starts as Not Sent');
    assert.equal(await page.locator('tr[data-job="1009"] .order-badge').count(), 0);
    assert.equal(await page.textContent('#count-open'), '7');

    // Filters
    await page.fill('#f-search', 'tulsa');
    assert.deepEqual(await rowsOf(page), ['1009']);
    await page.fill('#f-search', '#1002');
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007'], '#order shows the whole order');
    await page.click('#f-clear');
    await page.selectOption('#f-field', 'material');
    await page.selectOption('#f-value', 'Waiting');
    assert.deepEqual(await rowsOf(page), ['1004', '1008']);
    await page.selectOption('#f-field', 'status');
    await page.selectOption('#f-value', 'On Hold');
    assert.deepEqual(await rowsOf(page), ['1008']);
    await page.click('#f-clear');
    await page.selectOption('#f-type', 'Embroidery - Hats');
    assert.deepEqual(await rowsOf(page), ['1002']);
    await page.click('#f-clear');
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test('demo mode: linked projects (orders)', async () => {
    const page = await freshPage({ acceptDownloads: true });

    // One customer, three projects in one go
    await page.click('#new-btn');
    await page.fill('#new-form [name="customer"]', 'Garfield Grill');
    await page.fill('#new-form [name="due"]', '2030-03-01');
    await page.selectOption('.project-row:nth-child(1) select', 'Embroidery - Hats');
    await page.fill('.project-row:nth-child(1) input', 'Staff hats');
    await page.click('#add-project');
    await page.selectOption('.project-row:nth-child(2) select', 'Vinyl - Signage');
    await page.fill('.project-row:nth-child(2) input', 'Banner');
    await page.click('#add-project');
    await page.click('#add-project');
    await page.click('.project-row:nth-child(4) .remove-project');
    await page.selectOption('.project-row:nth-child(3) select', 'Promo');
    await page.fill('.project-row:nth-child(3) input', 'Golf balls');
    assert.equal((await page.textContent('#new-submit')).trim(), 'Create 3 Linked Jobs');
    await shot(page, 'desktop-new-order');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1011"]');
    const rows = await rowsOf(page);
    const at = rows.indexOf('1009');
    assert.deepEqual(rows.slice(at, at + 3), ['1009', '1010', '1011'], 'kept together');
    for (const j of [1009, 1010, 1011]) {
      assert.equal((await page.textContent(`tr[data-job="${j}"] .order-badge`)).trim(), 'Order 1009 - 0 of 3 ready');
    }

    // Finishing part of an order warns that the rest is not ready
    await page.click(chipSel(1009, 'production'));
    await page.click('#picker-options [data-pick="Finished"]');
    const warn = page.locator('.toast-warn');
    await warn.waitFor();
    const text = await warn.textContent();
    assert.match(text, /Garfield Grill has 2 more projects in order 1009/);
    assert.match(text, /#1010 Vinyl - Signage \(Banner\)/);
    assert.match(text, /#1011 Promo \(Golf balls\)/);
    assert.match(text, /Do not tell the customer/);
    await page.waitForTimeout(3500);
    assert.equal(await warn.count(), 1, 'warning stays until dismissed');
    await shot(page, 'desktop-order-warning');
    await page.click('.toast-warn .toast-close');
    assert.equal(await page.locator('.toast-warn').count(), 0);
    assert.equal((await page.textContent('tr[data-job="1010"] .order-badge')).trim(), 'Order 1009 - 1 of 3 ready');

    await page.click(chipSel(1010, 'production'));
    await page.click('#picker-options [data-pick="Finished"]');
    await page.click('.toast-warn .toast-close');
    await page.click(chipSel(1011, 'status'));
    await page.click('#picker-options [data-pick="Complete"]');
    await page.waitForSelector('.toast-ok:has-text("All 3 projects in order 1009 are ready")');
    assert.equal((await page.textContent('tr[data-job="1009"] .order-badge')).trim(), 'Order 1009 - all 3 ready');
    await dismissToasts(page);

    // Badge click filters to the order (including the one already closed)
    await page.click('tr[data-job="1002"] .order-badge');
    assert.equal(await page.inputValue('#f-search'), '#1002');
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007']);
    await page.click('#f-clear');

    // Drawer shows the rest of the order, and can add to it
    await page.click('tr[data-job="1002"] .open-job');
    await page.waitForSelector('#drawer.is-open');
    assert.match(await page.textContent('#drawer-order .order-banner'), /Order 1002: 3 projects, 0 of 3 ready/);
    assert.deepEqual(await page.$$eval('#drawer-order [data-mate]', (b) => b.map((x) => x.dataset.mate)), ['1006', '1007']);
    await page.waitForTimeout(300); // slide-in
    await shot(page, 'desktop-drawer-order');
    await page.click('#drawer-order [data-act="add-to-order"]');
    assert.equal(await page.textContent('#new-title'), 'Add to Order 1002');
    assert.equal(await page.inputValue('#new-form [name="customer"]'), 'SAMPLE - Main St Coffee');
    assert.equal(await page.inputValue('#new-form [name="contact"]'), 'John Roe');
    await page.selectOption('.project-row select', 'Heat Press - Other');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1012"]');
    await page.waitForFunction(() => document.querySelectorAll('#drawer-order [data-mate]').length === 3);
    assert.match(await page.textContent('tr[data-job="1012"] .order-badge'), /Order 1002 - 0 of 4 ready/);

    // Jump to a linked project, then unlink it
    await page.click('#drawer-order [data-mate="1012"]');
    await page.waitForFunction(() => document.getElementById('drawer-kicker').textContent === 'Job #1012');
    await page.click('#drawer-order [data-act="unlink"]');
    await page.waitForSelector('#drawer-order .order-solo:has-text("3 other open jobs for this customer")');
    assert.equal(await page.locator('tr[data-job="1012"] .order-badge').count(), 0);
    assert.match(await page.textContent('tr[data-job="1002"] .order-badge'), /0 of 3 ready/);

    // Link an existing job; same-customer jobs are offered first
    await page.click('#drawer-close');
    await page.click('tr[data-job="1012"] .open-job');
    await page.waitForSelector('#drawer.is-open');
    assert.match(await page.textContent('#drawer-order .order-solo'), /3 other open jobs for this customer, not linked/);
    const firstGroup = await page.$eval('#drawer-order select optgroup', (g) => g.label);
    assert.equal(firstGroup, 'Same customer');
    await page.selectOption('#drawer-order select', '1006');
    await page.waitForSelector('#drawer-order .order-banner');
    assert.match(await page.textContent('tr[data-job="1012"] .order-badge'), /Order 1002 - 0 of 4 ready/);
    await page.click('#drawer-close');
    await dismissToasts(page);

    // Completing part of an order moves it to Closed, but the badge still shows the rest
    await page.click(chipSel(1002, 'status'));
    await page.click('#picker-options [data-pick="Complete"]');
    await page.waitForSelector('.toast-warn');
    await dismissToasts(page);
    await page.click('#tab-closed');
    assert.deepEqual(await rowsOf(page), ['1011', '1002', '1003', '1005'], 'most recent first');
    assert.match(await page.textContent('tr[data-job="1002"] .order-badge'), /1 of 4 ready/);
    assert.match(await page.getAttribute('tr[data-job="1005"]', 'class'), /row-dead/);
    assert.match(await page.getAttribute(chipSel(1005, 'status'), 'class'), /chip-dead/);
    await shot(page, 'desktop-closed');

    // Reopen dead job
    await page.click(chipSel(1005, 'status'));
    await page.click('#picker-options [data-pick="Active"]');
    await page.waitForSelector('tr[data-job="1005"]', { state: 'detached' });
    await page.click('#tab-open');
    await page.waitForSelector('tr[data-job="1005"]');

    // Export includes Order #
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'Job #,Date In,Due Date,Customer,Contact Name,Phone,Email,Project Type,Description,Qty,' +
      'Status,Estimate,Material,Artwork,Production,Delivery,Payment,Notes,Created At,Updated At,Order #');
    assert.equal(lines.length, 13);
    assert.match(lines[10], /^1010,.*,1 Mar 2030,Garfield Grill,.*,1009$/);
    assert.match(download.suggestedFilename(), /^signs-stitches-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(page.errors, []);
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
    assert.equal(await page.locator('.cards .card').count(), 6);
    assert.equal(await page.locator('.cards .card[data-job="1006"] .order-badge').count(), 1);
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(noHScroll, 'no horizontal page scroll');
    const small = await page.$$eval('.cards .chip, .cards .order-badge, .btn, .tab, .input', (els) =>
      els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).length);
    assert.equal(small, 0, 'tap targets at least 44px');
    await shot(page, 'phone-open-jobs');
    await page.tap('.cards [data-job="1004"][data-chip="estimate"]');
    const box = await page.locator('#picker').boundingBox();
    assert.ok(box.y + box.height >= 843 && box.width >= 389, 'picker is a bottom sheet');
    await shot(page, 'phone-picker');
    await page.tap('#picker-options [data-pick="Approved"]');
    assert.equal((await page.textContent('.cards [data-job="1004"][data-chip="estimate"] .chip-value')).trim(), 'Approved');
    await page.tap('.cards .card[data-job="1006"] .open-job');
    await page.waitForSelector('#drawer.is-open');
    await page.waitForTimeout(300); // slide-in
    await shot(page, 'phone-drawer');
    await page.tap('#drawer-close');
    await page.waitForSelector('#drawer', { state: 'hidden' });
    await page.tap('#new-btn');
    await page.tap('#add-project');
    const noHScrollDialog = await page.evaluate(() => {
      const d = document.getElementById('new-dialog');
      return d.scrollWidth <= d.clientWidth &&
        [...d.querySelectorAll('*')].every((e) => e.getBoundingClientRect().right <= window.innerWidth);
    });
    assert.ok(noHScrollDialog, 'new job form fits a phone');
    await shot(page, 'phone-new-job');
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
    assert.deepEqual(await rowsOf(page), ['1002', '1001']);

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

    // Two projects for one customer through the sheet backend
    await page.click('#new-btn');
    await page.fill('#new-form [name="customer"]', 'Remote Co');
    await page.fill('#new-form [name="due"]', '2031-02-03');
    await page.selectOption('.project-row:nth-child(1) select', 'Embroidery - Hats');
    await page.click('#add-project');
    await page.selectOption('.project-row:nth-child(2) select', 'Vinyl - Signage');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1005"]');
    const log = ss.sheets['Job Log'].data;
    assert.deepEqual([log[4][0], log[4][3], log[4][10], log[4][11], log[4][20]], [1004, 'Remote Co', 'Active', 'Not Sent', 1004]);
    assert.deepEqual([log[5][0], log[5][20]], [1005, 1004]);
    assert.match(await page.textContent('tr[data-job="1005"] .order-badge'), /Order 1004 - 0 of 2 ready/);

    // Link through the backend
    await page.click('tr[data-job="1001"] .open-job');
    await page.waitForSelector('#activity li:has-text("Material")');
    await page.selectOption('#drawer-order select', '1002');
    await page.waitForSelector('#drawer-order .order-banner');
    assert.deepEqual([log[1][20], log[2][20]], [1002, 1002]);
    await shot(page, 'desktop-open-jobs-remote');
    assert.deepEqual(errors, []);
    await page.close();
  });
});
