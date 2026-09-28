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

// Selectors into the desktop table.
const stepSel = (job, field) => `.table-wrap .step[data-job="${job}"][data-chip="${field}"]`;
const pillSel = (job) => `.table-wrap .pill[data-job="${job}"]`;
const pick = (value) => `#picker-options [data-value="${value}"]`;

test('UI', { skip: !chromium && 'playwright not installed' }, async (t) => {
  const server = await serve();
  const base = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });

  const rowsOf = (page) => page.$$eval('table.jobs tbody tr', (r) => r.map((x) => x.dataset.job));
  const dismissToasts = (page) => page.$$eval('.toast', (ts) => ts.forEach((x) => x.remove()));
  const text = async (page, sel) => (await page.textContent(sel)).trim();
  const stepStates = (page, job) => page.$$eval(`.table-wrap tr[data-job="${job}"] .step`, (b) =>
    b.map((x) => x.dataset.chip + ':' + x.className.match(/step-(done|current|todo)/)[1]));

  async function freshPage(opts) {
    const page = await browser.newPage(Object.assign({ viewport: { width: 1600, height: 1000 } }, opts));
    await blockExternal(page);
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('table.jobs tbody tr');
    return page;
  }

  await t.test('board: summary cards, categories, stepper, status pills', async () => {
    const page = await freshPage();
    assert.equal(await page.isVisible('#demo-banner'), true);
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007', '1004', '1001', '1008'],
      'soonest due first, an order kept together, On Hold still open, closed jobs hidden');
    assert.equal(await text(page, '#count-open'), '6');
    assert.equal(await text(page, '#count-closed'), '2');
    assert.equal(await page.locator('table.jobs th:has-text("Qty")').count(), 0, 'no Qty column');

    // Summary cards
    assert.equal(await text(page, '[data-stat="open"]'), '6');
    assert.equal(await text(page, '[data-stat="attention"]'), '5');
    assert.equal(await text(page, '[data-stat="today"]'), '0');
    assert.equal(await text(page, '[data-stat="ready"]'), '0');
    await page.click('[data-quick="attention"]');
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007', '1004', '1008']);
    assert.equal(await page.isVisible('#active-filters'), true);
    await page.click('[data-quick="attention"]');
    assert.equal((await rowsOf(page)).length, 6, 'clicking again clears it');

    // Category pills
    assert.match(await text(page, '[data-cat="embroidery"]'), /Embroidery\s+2/);
    assert.match(await text(page, '[data-cat="signs"]'), /Signs\s+2/);
    assert.match(await text(page, '[data-cat="vehicle"]'), /Vehicle\s+0/);
    await page.click('[data-cat="embroidery"]');
    assert.deepEqual(await rowsOf(page), ['1002', '1008']);
    await page.click('[data-cat=""]');

    // Stepper: done / current / not started, coloured by how the job is doing
    assert.deepEqual(await stepStates(page, 1002), ['estimate:done', 'material:done', 'artwork:done', 'production:current', 'delivery:todo']);
    assert.deepEqual(await stepStates(page, 1001), ['estimate:done', 'material:current', 'artwork:done', 'production:todo', 'delivery:todo']);
    assert.match(await page.getAttribute('tr[data-job="1002"] .stepper', 'class'), /stepper-red/, 'overdue');
    assert.match(await page.getAttribute('tr[data-job="1004"] .stepper', 'class'), /stepper-amber/, 'due soon');
    assert.match(await page.getAttribute('tr[data-job="1001"] .stepper', 'class'), /stepper-green/);
    assert.match(await page.getAttribute('tr[data-job="1008"] .stepper', 'class'), /stepper-red/, 'on hold');

    // Status column shows where each job is
    assert.equal(await text(page, pillSel(1002)), 'Working');
    assert.match(await page.getAttribute(pillSel(1002), 'class'), /pill-amber/);
    assert.equal(await text(page, pillSel(1006)), 'Being Designed');
    assert.equal(await text(page, pillSel(1004)), 'Sent');
    assert.equal(await text(page, pillSel(1001)), 'Ordered');
    assert.equal(await text(page, pillSel(1008)), 'On Hold');
    assert.match(await page.getAttribute(pillSel(1008), 'class'), /pill-red/);
    assert.equal(await text(page, 'tr[data-job="1002"] .order-badge'), 'Order 1002 - 0 of 3 ready');

    // Tapping a step opens its options; Digitized is embroidery-only
    await page.click(stepSel(1001, 'artwork'));
    let opts = await page.$$eval('#picker-options [data-value]', (b) => b.map((x) => x.dataset.value));
    assert.deepEqual(opts, ['Being Designed', 'Sent to Customer', 'Approved', '']);
    await shot(page, 'desktop-picker');
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#picker'), true);
    await page.click(stepSel(1002, 'artwork'));
    opts = await page.$$eval('#picker-options [data-value]', (b) => b.map((x) => x.dataset.value));
    assert.deepEqual(opts, ['Being Designed', 'Sent to Customer', 'Approved', 'Digitized', '']);
    await page.keyboard.press('Escape');
    await page.click(pillSel(1008));
    opts = await page.$$eval('#picker-options [data-value]', (b) => b.map((x) => x.dataset.value));
    assert.deepEqual(opts, ['Active', 'On Hold', 'Complete', 'Dead', ''], 'On Hold pill edits Status');
    await page.keyboard.press('Escape');

    // Change a step: updates immediately and persists
    await page.click(stepSel(1004, 'material'));
    await page.click(pick('Ordered'));
    await page.waitForFunction(() => window.__app.state.pending.size === 0);
    await page.reload();
    await page.waitForSelector('table.jobs tbody tr');
    assert.equal(await page.getAttribute(stepSel(1004, 'material'), 'title'), 'Material: Ordered');
    assert.equal(await text(page, '[data-stat="attention"]'), '4', 'no longer waiting on material');

    // Failed save rolls back with an error
    await page.evaluate(() => { window.API.updateField = () => new Promise((_, rej) => setTimeout(() => rej(new Error('network down')), 200)); });
    await page.click(pillSel(1004));
    await page.click(pick('Approved'));
    assert.equal(await text(page, pillSel(1004)), 'Ordered', 'optimistic: estimate done, material is next');
    await page.waitForSelector('.toast-error');
    assert.equal(await text(page, pillSel(1004)), 'Sent', 'rolled back');
    assert.match(await page.textContent('.toast-error'), /network down/);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test('job panel: mark next step, edit, files, notes, history', async () => {
    const page = await freshPage();
    await page.click('tr[data-job="1001"] .go');
    await page.waitForSelector('#panel.is-open');
    assert.equal(await text(page, '#panel-title'), 'Job #1001');
    assert.match(await page.getAttribute('tr[data-job="1001"]', 'class'), /is-selected/);
    assert.equal(await page.isVisible('#panel-backdrop'), false, 'docked beside the board on a wide screen');
    assert.match(await text(page, '.who-big'), /Sand Springs Youth Football.*Jane Doe.*918-555-0100/s);
    assert.equal(await text(page, '.next-hint'), 'Next: Material: Received');
    assert.equal(await page.locator('#panel .prog-current .prog-label').first().textContent(), 'Material');

    // Mark Next Step moves the job along
    await page.click('#panel [data-act="next"]');
    await page.waitForFunction(() => document.querySelector('.table-wrap .pill[data-job="1001"]').textContent === 'In Queue');
    assert.equal(await text(page, '.next-hint'), 'Next: Production: Working');
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('#panel .prog')].find((r) => r.textContent.includes('Material'));
      return row && row.classList.contains('prog-done') && row.querySelector('.prog-date').textContent.trim() !== '';
    }, null, { timeout: 5000 });

    // The caret lists every step to jump to
    await page.click('#panel [data-act="steps"]');
    const items = await page.$$eval('#picker-options .menu-item', (b) => b.map((x) => x.textContent));
    assert.deepEqual(items, ['Estimate: Approved', 'Material: Received', 'Artwork: Approved', 'Production: In Queue',
      'Delivery: Pick-Up', 'Payment: Billed', 'Status: Active']);
    await page.click('#picker-options .menu-item:has-text("Payment")');
    await page.click(pick('Paid in Full'));
    await page.waitForFunction(() => [...document.querySelectorAll('#panel .prog')].some((r) => r.textContent.includes('Paid in Full') && r.classList.contains('prog-done')));

    // Edit Job shows every field
    await page.click('#panel [data-act="edit"]');
    assert.equal(await page.inputValue('#d-customer'), 'SAMPLE - Sand Springs Youth Football');
    assert.equal(await page.locator('#d-qty').count(), 0, 'no Qty');
    assert.match(await text(page, '#panel [data-says="due"]'), /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}$/, 'Day Month Year');
    await page.fill('#d-customer', '');
    await page.click('#d-contact');
    await page.waitForSelector('.toast-error:has-text("Customer is required")');
    assert.equal(await page.inputValue('#d-customer'), 'SAMPLE - Sand Springs Youth Football');
    await page.selectOption('#d-type', 'Embroidery - Apparel');
    await page.waitForFunction(() => document.querySelector('.table-wrap .pill[data-job="1001"]').textContent === 'Approved',
      null, { timeout: 5000 });  // Artwork is no longer done until Digitized
    await page.click('#panel [data-act="edit"]');
    assert.equal(await page.locator('#d-customer').count(), 0, 'Done Editing returns to details');

    // Files
    await page.click('#panel [data-tab="files"]');
    await page.fill('#file-url', 'not a link');
    await page.click('#panel [data-act="add-file"]');
    await page.waitForSelector('.toast-error:has-text("https://")');
    await page.fill('#file-url', 'https://drive.google.com/file/d/proof123');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#panel .files a[href="https://drive.google.com/file/d/proof123"]');
    assert.equal(await page.getAttribute('#panel .files a', 'rel'), 'noopener noreferrer');
    await page.click('#panel [data-remove-file="0"]');
    await page.waitForSelector('#panel .files li.muted');

    // Notes
    await page.click('#panel [data-tab="notes"]');
    await page.fill('#d-notes', 'Customer wants navy');
    await page.click('#panel [data-tab="details"]');
    await page.waitForSelector('#panel .notes-text:has-text("Customer wants navy")');
    await shot(page, 'desktop-panel');

    // History
    await page.click('#panel [data-tab="history"]');
    await page.waitForSelector('#activity li:has-text("Notes")');
    assert.match(await text(page, '#activity'), /Material.*Ordered.*to.*Received/s);

    // Row menu
    await page.click('[data-row-menu="1004"]');
    assert.deepEqual(await page.$$eval('#picker-options .menu-item', (b) => b.map((x) => x.textContent)),
      ['Open details', 'Mark next step (Estimate: Approved)', 'Put on hold', 'Mark complete', 'Mark dead (quote lost)']);
    await page.click('#picker-options .menu-item:has-text("Put on hold")');
    await page.waitForFunction(() => document.querySelector('.table-wrap .pill[data-job="1004"]').textContent === 'On Hold');

    await page.click('#panel-close');
    assert.equal(await page.isHidden('#panel'), true);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test('new job, search, fields filter, sort, bulk', async () => {
    const page = await freshPage();

    await page.click('#new-btn');
    assert.equal(await page.locator('#new-form [name="qty"]').count(), 0);
    assert.equal(await page.isVisible('#new-form [name="contact"]'), false, 'extra fields tucked away');
    await page.click('#new-submit');
    assert.match(await page.textContent('#new-error'), /Customer, Due Date, Project Type/);
    await page.fill('#new-form [name="customer"]', 'Tulsa Hardware');
    await page.selectOption('.project-row select', 'Heat Press - Hat');
    await page.fill('#new-form [name="due"]', '2030-01-15');
    assert.equal(await page.textContent('#new-form [data-says="due"]'), 'Tue 15 Jan 2030');
    await shot(page, 'desktop-new-job');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1009"]');
    assert.match(await page.textContent('tr[data-job="1009"] .col-due'), /15 Jan 2030/);
    assert.equal(await text(page, pillSel(1009)), 'Not Sent', 'estimate starts as Not Sent');
    assert.match(await page.getAttribute(pillSel(1009), 'class'), /pill-grey/);
    assert.equal(await text(page, '[data-cat="other"]'), 'Other 1', 'heat press falls under Other');

    // Ctrl+K jumps to search
    await page.keyboard.press('Control+k');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-search');
    await page.keyboard.type('tulsa');
    assert.deepEqual(await rowsOf(page), ['1009']);
    await page.fill('#f-search', '#1002');
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007'], '#order shows the whole order');
    await page.click('[data-clear="q"]');
    assert.equal(await page.inputValue('#f-search'), '');

    // All Fields filter
    await page.click('#fields-btn');
    await page.click('#picker-options .menu-item:has-text("Material")');
    await page.click(pick('Waiting'));
    assert.deepEqual(await rowsOf(page), ['1004', '1008']);
    assert.equal(await text(page, '#fields-label'), 'Material: Waiting');
    await page.click('[data-clear="field"]');
    assert.equal(await text(page, '#fields-label'), 'All Fields');

    // Sort
    await page.selectOption('#f-sort', 'customer');
    const byName = await rowsOf(page);
    assert.equal(byName[0], '1008');
    assert.equal(byName.at(-1), '1009');
    await page.selectOption('#f-sort', 'due');

    // Bulk: tick two jobs, move both on
    await page.check('[data-check="1004"]');
    await page.check('[data-check="1001"]');
    assert.equal(await text(page, '#bulk-count'), '2 jobs selected');
    await page.click('#bulk [data-bulk="next"]');
    await page.waitForFunction(() => document.querySelector('.table-wrap .pill[data-job="1001"]').textContent === 'In Queue');
    assert.equal(await text(page, pillSel(1004)), 'Waiting', 'estimate approved, material next');
    await page.click('#bulk [data-bulk="status"]');
    await page.click(pick('On Hold'));
    await page.waitForFunction(() => document.querySelector('.table-wrap .pill[data-job="1001"]').textContent === 'On Hold');
    assert.equal(await page.isHidden('#bulk'), true, 'selection cleared');
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test('linked projects (orders)', async () => {
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
    assert.equal(await text(page, '#new-submit'), 'Create 3 Linked Jobs');
    await shot(page, 'desktop-new-order');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1011"]');
    const rows = await rowsOf(page);
    const at = rows.indexOf('1009');
    assert.deepEqual(rows.slice(at, at + 3), ['1009', '1010', '1011'], 'kept together');
    for (const j of [1009, 1010, 1011]) {
      assert.equal(await text(page, `tr[data-job="${j}"] .order-badge`), 'Order 1009 - 0 of 3 ready');
    }

    // Finishing part of an order warns that the rest is not ready
    await page.click(stepSel(1009, 'production'));
    await page.click(pick('Finished'));
    const warn = page.locator('.toast-warn');
    await warn.waitFor();
    const msg = await warn.textContent();
    assert.match(msg, /Garfield Grill has 2 more projects in order 1009/);
    assert.match(msg, /#1010 Vinyl - Signage \(Banner\)/);
    assert.match(msg, /#1011 Promo \(Golf balls\)/);
    assert.match(msg, /Do not tell the customer/);
    await page.waitForTimeout(3500);
    assert.equal(await warn.count(), 1, 'warning stays until dismissed');
    await shot(page, 'desktop-order-warning');
    await page.click('.toast-warn .toast-close');
    assert.equal(await text(page, pillSel(1009)), 'Ready for Pickup');
    assert.equal(await text(page, '[data-stat="ready"]'), '1');
    assert.equal(await text(page, 'tr[data-job="1010"] .order-badge'), 'Order 1009 - 1 of 3 ready');

    await page.click(stepSel(1010, 'production'));
    await page.click(pick('Finished'));
    await page.click('.toast-warn .toast-close');
    await page.click('[data-row-menu="1011"]');
    await page.click('#picker-options .menu-item:has-text("Mark complete")');
    await page.waitForSelector('.toast-ok:has-text("All 3 projects in order 1009 are ready")');
    assert.equal(await text(page, 'tr[data-job="1009"] .order-badge'), 'Order 1009 - all 3 ready');
    await dismissToasts(page);

    // Badge click filters to the order
    await page.click('tr[data-job="1002"] .order-badge');
    assert.equal(await page.inputValue('#f-search'), '#1002');
    assert.deepEqual(await rowsOf(page), ['1002', '1006', '1007']);
    await page.click('[data-clear="q"]');

    // Panel shows the rest of the order and can add to it
    await page.click('tr[data-job="1002"] .go');
    await page.waitForSelector('#panel.is-open');
    assert.match(await text(page, '#drawer-order .order-banner'), /Order 1002: 3 projects, 0 of 3 ready/);
    assert.match(await text(page, '#panel .info'), /Order Info\s*Order 1002 - 0 of 3 ready/);
    assert.equal(await text(page, '#panel .mini:not(.mini-due) .mini-value'), '0 / 3');
    assert.deepEqual(await page.$$eval('#drawer-order [data-mate]', (b) => b.map((x) => x.dataset.mate)), ['1006', '1007']);
    await shot(page, 'desktop-panel-order');
    await page.click('#drawer-order [data-act="add-to-order"]');
    assert.equal(await text(page, '#new-title'), 'Add to Order 1002');
    assert.equal(await page.inputValue('#new-form [name="customer"]'), 'SAMPLE - Main St Coffee');
    assert.equal(await page.inputValue('#new-form [name="contact"]'), 'John Roe');
    await page.selectOption('.project-row select', 'Heat Press - Other');
    await page.click('#new-submit');
    await page.waitForSelector('tr[data-job="1012"]');
    await page.waitForFunction(() => document.querySelectorAll('#drawer-order [data-mate]').length === 3);
    assert.match(await text(page, 'tr[data-job="1012"] .order-badge'), /Order 1002 - 0 of 4 ready/);

    // Jump to a linked project, then unlink it
    await page.click('#drawer-order [data-mate="1012"]');
    await page.waitForFunction(() => document.getElementById('panel-title').textContent === 'Job #1012');
    await page.click('#drawer-order [data-act="unlink"]');
    await page.waitForSelector('#drawer-order .order-solo:has-text("3 other open jobs for this customer")');
    assert.equal(await page.locator('tr[data-job="1012"] .order-badge').count(), 0);

    // Link it back; same-customer jobs are offered first
    assert.equal(await page.$eval('#drawer-order select optgroup', (g) => g.label), 'Same customer');
    await page.selectOption('#drawer-order select', '1006');
    await page.waitForSelector('#drawer-order .order-banner');
    assert.match(await text(page, 'tr[data-job="1012"] .order-badge'), /Order 1002 - 0 of 4 ready/);
    await page.click('#panel-close');
    await dismissToasts(page);

    // Completed tab
    await page.click('[data-row-menu="1002"]');
    await page.click('#picker-options .menu-item:has-text("Mark complete")');
    await page.waitForSelector('.toast-warn');
    await dismissToasts(page);
    await page.click('#tab-closed');
    assert.deepEqual(await rowsOf(page), ['1011', '1002', '1003', '1005'], 'most recent first');
    assert.equal(await page.isVisible('#stats'), true);
    assert.match(await page.getAttribute('tr[data-job="1005"]', 'class'), /row-dead/);
    assert.equal(await text(page, pillSel(1005)), 'Dead');
    await shot(page, 'desktop-completed');
    await page.click(pillSel(1005));
    await page.click(pick('Active'));
    await page.waitForSelector('tr[data-job="1005"]', { state: 'detached' });
    await page.click('#tab-open');
    await page.waitForSelector('tr[data-job="1005"]');

    // Export from the menu includes Order # and Files
    await page.click('#more-btn');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#picker-options .menu-item:has-text("Export CSV")')]);
    const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'Job #,Date In,Due Date,Customer,Contact Name,Phone,Email,Project Type,Description,Qty,' +
      'Status,Estimate,Material,Artwork,Production,Delivery,Payment,Notes,Created At,Updated At,Order #,Files');
    assert.equal(lines.length, 13);
    assert.match(lines[10], /^1010,.*,1 Mar 2030,Garfield Grill,.*,1009,$/);
    assert.match(download.suggestedFilename(), /^signs-stitches-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  await t.test('medium screen: panel slides over the board', async () => {
    const page = await freshPage({ viewport: { width: 1100, height: 900 } });
    await page.click('tr[data-job="1002"] .go');
    await page.waitForSelector('#panel.is-open');
    assert.equal(await page.isVisible('#panel-backdrop'), true);
    await page.click('#panel-backdrop', { position: { x: 20, y: 400 } });
    assert.equal(await page.isHidden('#panel'), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no page-wide horizontal scroll');
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
    assert.equal(await page.locator('.cards .card[data-job="1002"] .step').count(), 5);
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(noHScroll, 'no horizontal page scroll');
    const small = await page.$$eval('.cards .pill, .cards .step, .cards .order-badge, .btn, .tab, .cat, .stat, .select-btn, .search-box', (els) =>
      els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.className));
    assert.deepEqual(small, [], 'tap targets at least 44px');
    await shot(page, 'phone-board');
    await page.tap('.cards .step[data-job="1004"][data-chip="estimate"]');
    const box = await page.locator('#picker').boundingBox();
    assert.ok(box.y + box.height >= 843 && box.width >= 389, 'picker is a bottom sheet');
    await shot(page, 'phone-picker');
    await page.tap(pick('Approved'));
    assert.equal((await page.textContent('.cards .pill[data-job="1004"]')).trim(), 'Waiting');
    await page.tap('.cards .card[data-job="1002"] .open-job');
    await page.waitForSelector('#panel.is-open');
    await page.waitForTimeout(300); // slide-in
    const pbox = await page.locator('#panel').boundingBox();
    assert.ok(pbox.width >= 389, 'panel is full screen');
    await shot(page, 'phone-panel');
    await page.tap('#panel-close');
    await page.tap('#new-btn');
    await page.tap('#add-project');
    const fits = await page.evaluate(() => {
      const d = document.getElementById('new-dialog');
      return d.scrollWidth <= d.clientWidth && [...d.querySelectorAll('*')].every((e) => e.getBoundingClientRect().right <= window.innerWidth);
    });
    assert.ok(fits, 'new job form fits a phone');
    await shot(page, 'phone-new-job');
    await ctx.close();
  });

  await t.test('remote mode: talks to Code.gs with text/plain POSTs and polls', async () => {
    const ss = ownerSheet();
    const gs = loadCodeGs(ss);
    gs.setup();
    const seen = [];
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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

    await page.click(stepSel(1001, 'material'));
    await page.click(pick('Received'));
    await page.waitForFunction(() => window.__app.state.pending.size === 0);
    assert.equal(ss.sheets['Job Log'].data[1][12], 'Received', 'written to the sheet');
    const post = seen.find((s) => s.method === 'POST');
    assert.match(post.type, /^text\/plain/, 'POST sent as text/plain (no preflight)');
    assert.ok(!seen.some((s) => s.method === 'OPTIONS'));

    // Someone edits the sheet directly; the next poll picks it up.
    ss.sheets['Job Log'].data[2][14] = 'Finished';
    await page.evaluate(() => window.__app.refresh());
    await page.waitForFunction(() => document.querySelector('.table-wrap .pill[data-job="1002"]').textContent === 'Ready for Pickup');

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

    // Mark Next Step, file links and linking through the backend
    await page.click('tr[data-job="1001"] .go');
    await page.waitForSelector('#panel.is-open');
    await page.click('#panel [data-act="next"]');
    await page.waitForFunction(() => window.__app.state.pending.size === 0);
    assert.equal(log[1][14], 'Working', 'production moved from In Queue to Working');
    await page.click('#panel [data-tab="files"]');
    await page.fill('#file-url', 'https://drive.google.com/file/d/xyz');
    await page.click('#panel [data-act="add-file"]');
    await page.waitForFunction(() => window.__app.state.pending.size === 0);
    assert.equal(log[1][21], 'https://drive.google.com/file/d/xyz');
    await page.click('#panel [data-tab="details"]');
    await page.selectOption('#drawer-order select', '1002');
    await page.waitForSelector('#drawer-order .order-banner');
    assert.deepEqual([log[1][20], log[2][20]], [1002, 1002]);
    await page.click('#panel [data-tab="history"]');
    await page.waitForSelector('#activity li:has-text("Production")');
    await shot(page, 'desktop-remote');
    assert.deepEqual(errors, []);
    await page.close();
  });
});
