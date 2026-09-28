// Run: node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCodeGs, ownerSheet } = require('./fake-sheets');

function setupEnv() {
  const ss = ownerSheet();
  ss.sheets['Open Jobs'].formulas['4,1'] =
    "=IFERROR(SORT(FILTER('Job Log'!A2:R500,'Job Log'!K2:K500=\"Active\"),3,TRUE),\"No jobs here yet\")";
  ss.sheets['Closed Jobs'].formulas['4,1'] =
    "=IFERROR(SORT(FILTER('Job Log'!A2:R500,('Job Log'!K2:K500=\"Complete\")+('Job Log'!K2:K500=\"Dead\")),3,FALSE),\"No jobs here yet\")";
  const gs = loadCodeGs(ss);
  const get = (params) => JSON.parse(gs.doGet({ parameter: params || {} }).text);
  const post = (body) => JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ss, gs, get, post };
}

test('doGet returns jobs, lists and rules from the owner sheet', () => {
  const { get } = setupEnv();
  const res = get();
  assert.equal(res.ok, true);
  assert.equal(res.jobs.length, 3);
  const j = res.jobs[1];
  assert.equal(j.job, 1002);
  assert.equal(j.due, '2026-09-23');
  assert.equal(j.customer, 'SAMPLE - Main St Coffee');
  assert.equal(j.artwork, 'Digitized');
  assert.equal(j.qty, 24);
  assert.equal(res.lists.types.length, 12);
  assert.deepEqual(res.lists.options.status, ['Active', 'Complete', 'Dead']);
  assert.deepEqual(res.lists.options.artwork, ['Sent to Customer', 'Approved', 'Digitized']);
  assert.deepEqual(res.lists.options.estimate, ['Sent', 'Approved']);
  assert.deepEqual(res.rules, []); // no Options By Type tab until setup() runs
});

test('setup adds tabs, tracking columns and open-ended views; safe to re-run', () => {
  const { ss, gs, get } = setupEnv();
  gs.setup();
  const log = ss.sheets['Job Log'];
  assert.equal(log.get(1, 19), 'Created At');
  assert.equal(log.get(1, 20), 'Updated At');
  assert.equal(log.get(1, 21), 'Order #');
  assert.deepEqual(ss.sheets.Activity.data[0], ['Timestamp', 'Job #', 'Field', 'Old Value', 'New Value']);
  assert.equal(ss.sheets['Options By Type'].get(2, 2), 'Digitized');
  assert.doesNotMatch(ss.sheets['Closed Jobs'].formulas['4,1'], /500/);
  assert.equal(log.formats['2,2'], 'dd mmm yyyy');

  // New options slot in next to their neighbours
  const lists = get().lists.options;
  assert.deepEqual(lists.status, ['Active', 'On Hold', 'Complete', 'Dead']);
  assert.deepEqual(lists.estimate, ['Not Sent', 'Sent', 'Approved']);
  assert.deepEqual(lists.artwork, ['Being Designed', 'Sent to Customer', 'Approved', 'Digitized']);
  assert.deepEqual(get().lists.types.length, 12, 'project types untouched');
  // On Hold jobs show on the sheet's Open Jobs tab
  assert.equal(ss.sheets['Open Jobs'].formulas['4,1'],
    "=IFERROR(SORT(FILTER('Job Log'!A2:R,('Job Log'!K2:K=\"Active\")+('Job Log'!K2:K=\"On Hold\")),3,TRUE),\"No jobs here yet\")");
  // Dropdowns read whole Lists columns and only warn on other values
  const status = log.validations.find((v) => v.col === 11);
  assert.equal(status.rule.allowInvalid, true);
  assert.equal(status.rule.range.col, 2);
  assert.equal(status.rule.range.row, 3);

  gs.setup();
  assert.equal(log.get(1, 22), '', 'no duplicate columns on re-run');
  assert.deepEqual(get().lists.options.status, ['Active', 'On Hold', 'Complete', 'Dead'], 'options not duplicated');
  assert.equal(ss.sheets['Options By Type'].getLastRow(), 2, 'seed rule not duplicated');

  const rules = get().rules;
  assert.deepEqual(rules, [{ field: 'artwork', option: 'Digitized',
    types: ['Embroidery - Hats', 'Embroidery - Apparel', 'Embroidery - Other'] }]);
});

test('create assigns the next Job #, defaults, and logs activity', () => {
  const { ss, gs, post, get } = setupEnv();
  const res = post({ action: 'create', job: { customer: 'Test Co', type: 'Promo', due: '2026-10-01', qty: '12', notes: '=1+1' } });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.job.job, 1004);
  assert.equal(res.job.status, 'Active');
  assert.equal(res.job.estimate, 'Not Sent', 'estimate starts as Not Sent');
  assert.equal(res.job.order, '', 'a single job is not linked');
  assert.equal(res.job.due, '2026-10-01');
  assert.equal(res.job.qty, 12);
  assert.equal(res.job.notes, '=1+1');
  assert.match(res.job.dateIn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(res.job.createdAt);
  assert.equal(ss.sheets['Job Log'].formats['5,18'], '@', 'text written as plain text');
  assert.ok(gs.lockLog.includes('lock') && gs.lockLog.at(-1) === 'release');

  const second = post({ action: 'create', job: { customer: 'B', type: 'Other', due: '2026-10-02' } });
  assert.equal(second.job.job, 1005);
  assert.equal(get().jobs.length, 5);
  const act = get({ action: 'activity', job: '1004' }).activity;
  assert.equal(act[0].field, 'Created');
});

test('create starts at 1001 on an empty Job Log and requires Customer/Type/Due', () => {
  const { ss, post } = setupEnv();
  ss.sheets['Job Log'].data.length = 1;
  assert.equal(post({ action: 'create', job: { customer: 'A', type: 'Promo' } }).ok, false);
  const res = post({ action: 'create', job: { customer: 'A', type: 'Promo', due: '2026-10-01' } });
  assert.equal(res.job.job, 1001);
});

test('update finds the row by Job # (not position) and records activity', () => {
  const { ss, post, get } = setupEnv();
  // Sort the sheet by hand to prove row position does not matter.
  const log = ss.sheets['Job Log'];
  log.data = [log.data[0], log.data[3], log.data[1], log.data[2]];

  const res = post({ action: 'update', job: 1002, field: 'production', value: 'Finished' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.job.production, 'Finished');
  assert.equal(log.data[3][14], 'Finished');
  assert.ok(res.job.updatedAt);

  post({ action: 'update', job: 1002, field: 'due', value: '2026-10-05' });
  post({ action: 'update', job: 1002, field: 'material', value: '' });
  const act = get({ action: 'activity', job: 1002 }).activity;
  assert.deepEqual(act.map((a) => [a.field, a.oldValue, a.newValue]), [
    ['Material', 'Received', ''],
    ['Due Date', '23 Sep 2026', '05 Oct 2026'],
    ['Production', 'Working', 'Finished']
  ]);
  assert.equal(get().jobs.find((j) => j.job === 1002).material, '');
});

test('update with the same value does not log activity', () => {
  const { post, get } = setupEnv();
  post({ action: 'update', job: 1001, field: 'status', value: 'Active' });
  assert.equal(get({ action: 'activity', job: 1001 }).activity.length, 0);
});

test('update rejects bad input', () => {
  const { post } = setupEnv();
  assert.match(post({ action: 'update', job: 9999, field: 'status', value: 'Dead' }).error, /not found/);
  assert.match(post({ action: 'update', job: 1001, field: 'job', value: 5 }).error, /cannot be edited/);
  assert.match(post({ action: 'update', job: 1001, field: 'customer', value: ' ' }).error, /required/);
  assert.match(post({ action: 'update', job: 1001, field: 'due', value: '9/1/2026' }).error, /yyyy-mm-dd/);
  assert.match(post({ action: 'nope' }).error, /Unknown action/);
});

test('appendActivity writes a row', () => {
  const { post, get } = setupEnv();
  assert.equal(post({ action: 'appendActivity', job: 1001, field: 'Note', oldValue: '', newValue: 'Called customer' }).ok, true);
  assert.equal(get({ action: 'activity', job: 1001 }).activity[0].newValue, 'Called customer');
});

test('create with several projects links them under the first job number', () => {
  const { post, get } = setupEnv();
  const res = post({ action: 'create', jobs: [
    { customer: 'Main St Coffee', type: 'Embroidery - Hats', due: '2026-10-10', description: 'Hats' },
    { customer: 'Main St Coffee', type: 'Vinyl - Signage', due: '2026-10-10', description: 'Banner' },
    { customer: 'Main St Coffee', type: 'Promo', due: '2026-10-10', description: 'Golf balls' }
  ] });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.jobs.map((j) => [j.job, j.order]), [[1004, 1004], [1005, 1004], [1006, 1004]]);
  assert.equal(get().jobs.filter((j) => j.order === 1004).length, 3);
});

test('create is all or nothing when one project is missing a required field', () => {
  const { post, get } = setupEnv();
  const res = post({ action: 'create', jobs: [
    { customer: 'A', type: 'Promo', due: '2026-10-10' },
    { customer: 'A', due: '2026-10-10' }
  ] });
  assert.match(res.error, /Project Type is required/);
  assert.equal(get().jobs.length, 3);
});

test('create with linkTo joins an existing job, giving it an Order # first', () => {
  const { post, get } = setupEnv();
  const res = post({ action: 'create', linkTo: 1002, jobs: [{ customer: 'SAMPLE - Main St Coffee', type: 'Promo', due: '2026-10-01' }] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.job.order, 1002);
  assert.equal(get().jobs.find((j) => j.job === 1002).order, 1002);
});

test('link and unlink existing jobs', () => {
  const { post, get } = setupEnv();
  let res = post({ action: 'link', job: 1001, to: 1002 });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.jobs.map((j) => [j.job, j.order]), [[1002, 1002], [1001, 1002]]);
  res = post({ action: 'link', job: 1003, to: 1001 });
  assert.equal(res.jobs[1].order, 1002, 'joins the existing order, not a new one');
  post({ action: 'update', job: 1003, field: 'order', value: '' });
  assert.equal(get().jobs.find((j) => j.job === 1003).order, '');
  assert.match(post({ action: 'link', job: 1001, to: 1001 }).error, /itself/);
  const act = get({ action: 'activity', job: 1001 }).activity;
  assert.deepEqual([act[0].field, act[0].newValue], ['Order #', '1002']);
});
