/**
 * Signs & Stitches Job Tracker - Google Apps Script backend.
 *
 * The Google Sheet is the database. The web app reads and writes it through
 * this script:
 *   GET  ?                          -> all jobs, dropdown lists and per-type rules
 *   GET  ?action=activity&job=1001  -> activity log for one job
 *   POST {action:"create", job:{...}}                one job
 *   POST {action:"create", jobs:[{...},{...}]}       several projects for one customer, linked by Order #
 *   POST {action:"create", jobs:[{...}], linkTo:1001} add a project to job 1001's order
 *   POST {action:"update", job:1001, field:"artwork", value:"Approved"}
 *   POST {action:"link", job:1003, to:1001}          put job 1003 in job 1001's order
 *   POST {action:"appendActivity", job:1001, field:"Notes", oldValue:"", newValue:"..."}
 *
 * POST bodies are sent as text/plain JSON so browsers skip the CORS preflight.
 * Every write runs inside LockService, and rows are always found by Job #.
 *
 * First time: run setup() once from the Apps Script editor (see README).
 */

var JOB_SHEET = 'Job Log';
var LISTS_SHEET = 'Lists';
var ACTIVITY_SHEET = 'Activity';
var RULES_SHEET = 'Options By Type';
var VIEW_SHEETS = ['Open Jobs', 'Closed Jobs'];

var FIRST_JOB_NUMBER = 1001;
var DATE_FORMAT = 'dd mmm yyyy';
var STAMP_FORMAT = 'dd mmm yyyy h:mm am/pm';
var ACTIVITY_HEADERS = ['Timestamp', 'Job #', 'Field', 'Old Value', 'New Value'];
var RULES_HEADERS = ['Field', 'Option', 'Only For Project Types'];
// Options added to the Lists tab by setup(): [column, option, 'before'|'after', neighbour].
var LIST_ADDITIONS = [
  ['Status', 'On Hold', 'after', 'Active'],
  ['Estimate', 'Not Sent', 'before', 'Sent'],
  ['Artwork', 'Being Designed', 'before', 'Sent to Customer']
];
// Values a new job starts with when the form leaves them blank.
var NEW_JOB_DEFAULTS = { status: 'Active', estimate: 'Not Sent' };
var LIST_COLUMNS = ['Project Type', 'Status', 'Estimate', 'Material', 'Artwork', 'Production', 'Delivery', 'Payment'];
var RULES_SEED = [
  ['Artwork', 'Digitized', 'Embroidery - Hats, Embroidery - Apparel, Embroidery - Other']
];

// [key used by the web app, header in the Job Log, kind]
var FIELDS = [
  ['job', 'Job #', 'number'],
  ['dateIn', 'Date In', 'date'],
  ['due', 'Due Date', 'date'],
  ['customer', 'Customer', 'text'],
  ['contact', 'Contact Name', 'text'],
  ['phone', 'Phone', 'text'],
  ['email', 'Email', 'text'],
  ['type', 'Project Type', 'text'],
  ['description', 'Description', 'text'],
  ['qty', 'Qty', 'number'],
  ['status', 'Status', 'text'],
  ['estimate', 'Estimate', 'text'],
  ['material', 'Material', 'text'],
  ['artwork', 'Artwork', 'text'],
  ['production', 'Production', 'text'],
  ['delivery', 'Delivery', 'text'],
  ['payment', 'Payment', 'text'],
  ['notes', 'Notes', 'text'],
  ['createdAt', 'Created At', 'stamp'],
  ['updatedAt', 'Updated At', 'stamp'],
  // Jobs that came in together share an Order # (the first job's number). Blank = on its own.
  ['order', 'Order #', 'number']
];
var ADDED_COLUMNS = ['Created At', 'Updated At', 'Order #'];
var READ_ONLY = { job: true, createdAt: true, updatedAt: true };
var REQUIRED = { customer: 'Customer', type: 'Project Type', due: 'Due Date' };

/* ---------------------------------------------------------------- HTTP */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'activity') {
      return json_({ ok: true, activity: readActivity_(Number(p.job)) });
    }
    return json_({
      ok: true,
      jobs: readJobs_(),
      lists: readLists_(),
      rules: readRules_(),
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    return json_({ ok: false, error: errorText_(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var result = withLock_(function () {
      switch (body.action) {
        case 'create': {
          var made = createJobs_(body.jobs || [body.job || {}], Number(body.linkTo) || 0);
          return { job: made[0], jobs: made };
        }
        case 'link': return { jobs: linkJob_(Number(body.job), Number(body.to)) };
        case 'update': return { job: updateField_(Number(body.job), body.field, body.value) };
        case 'appendActivity':
          appendActivity_(Number(body.job), body.field, body.oldValue, body.newValue);
          return {};
        default: throw new Error('Unknown action: ' + body.action);
      }
    });
    result.ok = true;
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: errorText_(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorText_(err) {
  return String((err && err.message) || err);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var out = fn();
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------- Helpers */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function tz_() {
  return ss_().getSpreadsheetTimeZone();
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function getOrCreateSheet_(name, headers) {
  var sh = ss_().getSheetByName(name);
  var created = false;
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    created = true;
  }
  return { sheet: sh, created: created };
}

function fieldByKey_(key) {
  for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i][0] === key) return FIELDS[i];
  return null;
}

function fieldByHeader_(header) {
  var h = String(header).trim().toLowerCase();
  for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i][1].toLowerCase() === h) return FIELDS[i];
  return null;
}

/** Map of header text -> 1-based column in the Job Log. Adds Created At / Updated At / Order # if missing. */
function jobColumns_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var cols = {};
  headers.forEach(function (h, i) { if (h !== '') cols[String(h).trim()] = i + 1; });
  ADDED_COLUMNS.forEach(function (h) {
    if (!cols[h]) {
      lastCol++;
      sh.getRange(1, lastCol).setValue(h).setFontWeight('bold');
      cols[h] = lastCol;
    }
  });
  return cols;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function isoDate_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return v === '' || v == null ? '' : String(v);
}

function displayDate_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m[3] + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
}

/** Converts a raw cell value into the value the web app works with. */
function fromCell_(kind, v) {
  if (kind === 'date') return isoDate_(v);
  if (kind === 'stamp') return isDate_(v) ? v.toISOString() : (v === '' || v == null ? '' : String(v));
  if (kind === 'number') return v === '' || v == null ? '' : (isNaN(Number(v)) ? String(v) : Number(v));
  if (isDate_(v)) return isoDate_(v);
  return v == null ? '' : String(v);
}

function writeCell_(range, kind, value) {
  if (value === '' || value == null) {
    range.clearContent();
    return;
  }
  if (kind === 'date') {
    var iso = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Dates must be yyyy-mm-dd, got: ' + iso);
    // An ISO string is read by Sheets as a real date in the sheet's own time zone.
    range.setNumberFormat(DATE_FORMAT).setValue(iso);
  } else if (kind === 'stamp') {
    range.setNumberFormat(STAMP_FORMAT).setValue(value);
  } else if (kind === 'number') {
    var n = Number(value);
    if (String(value).trim() !== '' && isFinite(n)) range.setValue(n);
    else range.setNumberFormat('@').setValue(String(value));
  } else {
    // Plain-text format stops Sheets turning "1/2" into a date or "=..." into a formula.
    range.setNumberFormat('@').setValue(String(value));
  }
}

/* ---------------------------------------------------------------- Reads */

function readJobs_() {
  var sh = sheet_(JOB_SHEET);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var map = headers.map(function (h) { return fieldByHeader_(h); });
  var jobs = [];
  for (var r = 1; r < values.length; r++) {
    var job = rowToJob_(values[r], map);
    if (job) jobs.push(job);
  }
  return jobs;
}

function rowToJob_(row, map) {
  var job = {};
  FIELDS.forEach(function (f) { job[f[0]] = ''; });
  map.forEach(function (f, i) {
    if (f) job[f[0]] = fromCell_(f[2], row[i]);
  });
  if (job.job === '' || isNaN(Number(job.job))) return null;
  job.job = Number(job.job);
  return job;
}

function readJobAtRow_(sh, row) {
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sh.getRange(row, 1, 1, lastCol).getValues()[0];
  return rowToJob_(values, headers.map(function (h) { return fieldByHeader_(h); }));
}

/** Lists tab: finds the header row (the one starting with "Project Type"), then reads each column down. */
function readLists_() {
  var values = sheet_(LISTS_SHEET).getDataRange().getValues();
  var headerRow = -1;
  for (var r = 0; r < values.length && headerRow < 0; r++) {
    if (String(values[r][0]).trim().toLowerCase() === 'project type') headerRow = r;
  }
  if (headerRow < 0) throw new Error('Lists tab needs a header row starting with "Project Type"');
  var out = { types: [], options: {} };
  values[headerRow].forEach(function (h, c) {
    var header = String(h).trim();
    if (!header) return;
    var items = [];
    for (var r2 = headerRow + 1; r2 < values.length; r2++) {
      var v = String(values[r2][c]).trim();
      if (v && items.indexOf(v) < 0) items.push(v);
    }
    if (header.toLowerCase() === 'project type') {
      out.types = items;
    } else {
      var f = fieldByHeader_(header);
      if (f) out.options[f[0]] = items;
    }
  });
  return out;
}

/** Options By Type tab: each row limits one option of one field to the listed project types. */
function readRules_() {
  var sh = ss_().getSheetByName(RULES_SHEET);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var rules = [];
  for (var r = 1; r < values.length; r++) {
    var f = fieldByHeader_(values[r][0]);
    var option = String(values[r][1] || '').trim();
    var types = String(values[r][2] || '').split(',')
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t; });
    if (f && option && types.length) rules.push({ field: f[0], option: option, types: types });
  }
  return rules;
}

function readActivity_(jobNo) {
  if (!jobNo) throw new Error('Missing job number');
  var sh = ss_().getSheetByName(ACTIVITY_SHEET);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var r = values.length - 1; r >= 1 && out.length < 300; r--) {
    if (Number(values[r][1]) !== jobNo) continue;
    out.push({
      at: isDate_(values[r][0]) ? values[r][0].toISOString() : String(values[r][0]),
      field: String(values[r][2]),
      oldValue: String(values[r][3]),
      newValue: String(values[r][4])
    });
  }
  return out;
}

/* ---------------------------------------------------------------- Writes */

function findRow_(sh, cols, jobNo) {
  var col = cols['Job #'];
  var last = sh.getLastRow();
  if (!col || last < 2) return -1;
  var ids = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (Number(ids[i][0]) === jobNo && ids[i][0] !== '') return i + 2;
  }
  return -1;
}

function nextJobNumber_(sh, cols) {
  var last = sh.getLastRow();
  var max = FIRST_JOB_NUMBER - 1;
  if (last >= 2) {
    sh.getRange(2, cols['Job #'], last - 1, 1).getValues().forEach(function (r) {
      var n = Number(r[0]);
      if (r[0] !== '' && isFinite(n) && n > max) max = n;
    });
  }
  return max + 1;
}

function checkRequired_(data) {
  Object.keys(REQUIRED).forEach(function (k) {
    if (!String(data[k] == null ? '' : data[k]).trim()) throw new Error(REQUIRED[k] + ' is required');
  });
}

/**
 * Creates one or more jobs. Several at once (a customer ordering hats, a banner
 * and golf balls together) are linked with the first new job's number as Order #.
 * linkTo adds the new jobs to an existing job's order instead.
 */
function createJobs_(list, linkTo) {
  if (!list.length) throw new Error('Nothing to create');
  list.forEach(checkRequired_); // all or nothing
  var sh = sheet_(JOB_SHEET);
  var cols = jobColumns_(sh);
  var group = 0;
  if (linkTo) group = ensureOrder_(sh, cols, linkTo);
  else if (list.length > 1) group = nextJobNumber_(sh, cols);
  return list.map(function (data) {
    var d = {};
    Object.keys(data).forEach(function (k) { d[k] = data[k]; });
    if (group) d.order = group;
    return createJob_(d);
  });
}

/** Returns the Order # of a job, giving it one (its own number) if it has none yet. */
function ensureOrder_(sh, cols, jobNo) {
  var row = findRow_(sh, cols, jobNo);
  if (row < 0) throw new Error('Job ' + jobNo + ' not found');
  var current = sh.getRange(row, cols['Order #']).getValue();
  if (current !== '' && !isNaN(Number(current))) return Number(current);
  updateField_(jobNo, 'order', jobNo);
  return jobNo;
}

function linkJob_(jobNo, to) {
  if (!jobNo || !to) throw new Error('Missing job number');
  if (jobNo === to) throw new Error('A job cannot be linked to itself');
  var sh = sheet_(JOB_SHEET);
  var cols = jobColumns_(sh);
  var group = ensureOrder_(sh, cols, to);
  var job = updateField_(jobNo, 'order', group);
  return [readJobAtRow_(sh, findRow_(sh, cols, to)), job];
}

function createJob_(data) {
  checkRequired_(data);
  var sh = sheet_(JOB_SHEET);
  var cols = jobColumns_(sh);
  var jobNo = nextJobNumber_(sh, cols);
  var row = sh.getLastRow() + 1;
  var now = new Date();

  var values = {};
  FIELDS.forEach(function (f) {
    if (!READ_ONLY[f[0]] && data[f[0]] != null) values[f[0]] = data[f[0]];
  });
  if (!values.dateIn) values.dateIn = Utilities.formatDate(now, tz_(), 'yyyy-MM-dd');
  Object.keys(NEW_JOB_DEFAULTS).forEach(function (k) {
    if (!values[k]) values[k] = NEW_JOB_DEFAULTS[k];
  });
  values.job = jobNo;
  values.createdAt = now;
  values.updatedAt = now;

  if (row > 2) {
    // Carry the sheet's dropdowns down to the new row.
    var width = sh.getLastColumn();
    sh.getRange(2, 1, 1, width).copyTo(sh.getRange(row, 1, 1, width),
      SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  FIELDS.forEach(function (f) {
    var col = cols[f[1]];
    if (col && values[f[0]] !== undefined) writeCell_(sh.getRange(row, col), f[2], values[f[0]]);
  });
  appendActivity_(jobNo, 'Created', '', String(values.customer) + ' - ' + String(values.type));
  return readJobAtRow_(sh, row);
}

function updateField_(jobNo, key, value) {
  var f = fieldByKey_(key);
  if (!f || READ_ONLY[key]) throw new Error('Field cannot be edited: ' + key);
  if (!jobNo) throw new Error('Missing job number');
  value = value == null ? '' : value;
  if (REQUIRED[key] && !String(value).trim()) throw new Error(REQUIRED[key] + ' is required');

  var sh = sheet_(JOB_SHEET);
  var cols = jobColumns_(sh);
  var row = findRow_(sh, cols, jobNo);
  if (row < 0) throw new Error('Job ' + jobNo + ' not found');
  var col = cols[f[1]];
  if (!col) throw new Error('Job Log has no "' + f[1] + '" column');

  var cell = sh.getRange(row, col);
  var oldValue = fromCell_(f[2], cell.getValue());
  if (String(oldValue) === String(value)) return readJobAtRow_(sh, row);

  writeCell_(cell, f[2], value);
  writeCell_(sh.getRange(row, cols['Updated At']), 'stamp', new Date());
  var show = f[2] === 'date' ? displayDate_ : String;
  appendActivity_(jobNo, f[1], show(oldValue), show(value));
  return readJobAtRow_(sh, row);
}

function appendActivity_(jobNo, field, oldValue, newValue) {
  if (!jobNo) throw new Error('Missing job number');
  var sh = getOrCreateSheet_(ACTIVITY_SHEET, ACTIVITY_HEADERS).sheet;
  var row = sh.getLastRow() + 1;
  var range = sh.getRange(row, 1, 1, 5);
  range.setNumberFormats([[STAMP_FORMAT, '0', '@', '@', '@']]);
  range.setValues([[new Date(), jobNo, String(field || ''),
    String(oldValue == null ? '' : oldValue), String(newValue == null ? '' : newValue)]]);
}

/* ---------------------------------------------------------------- One-time setup */

/**
 * Run once from the Apps Script editor (select "setup", press Run).
 * Safe to run again: it only adds what is missing.
 */
function setup() {
  var notes = [];
  var jobs = sheet_(JOB_SHEET);
  var cols = jobColumns_(jobs);
  notes.push('Job Log: Created At in column ' + cols['Created At'] + ', Updated At in column ' + cols['Updated At']);

  var maxRows = jobs.getMaxRows();
  ['Date In', 'Due Date'].forEach(function (h) {
    if (cols[h]) jobs.getRange(2, cols[h], maxRows - 1, 1).setNumberFormat(DATE_FORMAT);
  });
  ['Created At', 'Updated At'].forEach(function (h) {
    jobs.getRange(2, cols[h], maxRows - 1, 1).setNumberFormat(STAMP_FORMAT);
  });

  var activity = getOrCreateSheet_(ACTIVITY_SHEET, ACTIVITY_HEADERS);
  notes.push(activity.created ? 'Added Activity tab' : 'Activity tab already there');

  var rules = getOrCreateSheet_(RULES_SHEET, RULES_HEADERS);
  if (rules.created) {
    rules.sheet.getRange(2, 1, RULES_SEED.length, 3).setValues(RULES_SEED);
    rules.sheet.setColumnWidth(3, 480);
    notes.push('Added Options By Type tab with the Digitized rule');
  } else {
    notes.push('Options By Type tab already there');
  }

  // Make the Open Jobs / Closed Jobs FILTER views open-ended (no 500-row limit).
  VIEW_SHEETS.forEach(function (name) {
    var sh = ss_().getSheetByName(name);
    if (!sh) return;
    var formulas = sh.getRange(1, 1, Math.min(10, sh.getMaxRows()), 1).getFormulas();
    for (var r = 0; r < formulas.length; r++) {
      var f = formulas[r][0];
      if (f && /FILTER\(/i.test(f)) {
        var open = f.replace(/(\$?[A-Z]{1,3}\$?2:\$?[A-Z]{1,3})\$?\d+/g, '$1');
        if (open !== f) {
          sh.getRange(r + 1, 1).setFormula(open);
          notes.push(name + ': view now covers every row');
        }
      }
    }
  });

  // On Hold jobs are still open: show them on the sheet's Open Jobs tab too.
  var openView = ss_().getSheetByName('Open Jobs');
  if (openView) {
    var of = openView.getRange(1, 1, Math.min(10, openView.getMaxRows()), 1).getFormulas();
    for (var i = 0; i < of.length; i++) {
      var fx = of[i][0];
      if (fx && /FILTER\(/i.test(fx) && fx.indexOf('On Hold') < 0) {
        var withHold = fx.replace(/('Job Log'!\$?[A-Z]{1,3}\$?2:\$?[A-Z]{1,3})="Active"/,
          '($1="Active")+($1="On Hold")');
        if (withHold !== fx) {
          openView.getRange(i + 1, 1).setFormula(withHold);
          notes.push('Open Jobs: now includes On Hold jobs');
        }
      }
    }
  }

  LIST_ADDITIONS.forEach(function (a) {
    if (addListOption_(a[0], a[1], a[2], a[3])) notes.push('Lists: added "' + a[1] + '" to ' + a[0]);
  });

  // Carry the Job Log dropdowns down the whole sheet.
  if (maxRows > 2) {
    var width = jobs.getLastColumn();
    jobs.getRange(2, 1, 1, width).copyTo(jobs.getRange(3, 1, maxRows - 2, width),
      SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }

  // Point each dropdown at its whole Lists column, so options added later show up in the sheet too.
  // Invalid entries only get a warning, never a rejection.
  var lists = listsLayout_();
  LIST_COLUMNS.forEach(function (h) {
    if (!cols[h] || !lists.cols[h]) return;
    var source = lists.sheet.getRange(lists.firstItemRow, lists.cols[h], lists.sheet.getMaxRows() - lists.firstItemRow + 1, 1);
    var rule = SpreadsheetApp.newDataValidation().requireValueInRange(source, true).setAllowInvalid(true).build();
    jobs.getRange(2, cols[h], maxRows - 1, 1).setDataValidation(rule);
  });
  notes.push('Job Log dropdowns now read the whole Lists columns');

  Logger.log(notes.join('\n'));
  return notes;
}

function listsLayout_() {
  var sh = sheet_(LISTS_SHEET);
  var values = sh.getDataRange().getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim().toLowerCase() === 'project type') {
      var cols = {};
      values[r].forEach(function (h, c) { if (String(h).trim()) cols[String(h).trim()] = c + 1; });
      return { sheet: sh, values: values, headerRow: r + 1, firstItemRow: r + 2, cols: cols };
    }
  }
  throw new Error('Lists tab needs a header row starting with "Project Type"');
}

/** Adds an option to a Lists column next to a neighbour, if it is not there yet. */
function addListOption_(header, option, where, neighbour) {
  var l = listsLayout_();
  var col = l.cols[header];
  if (!col) return false;
  var items = [];
  for (var r = l.headerRow; r < l.values.length; r++) {
    var v = String(l.values[r][col - 1]).trim();
    if (v) items.push(v);
  }
  if (items.indexOf(option) >= 0) return false;
  var at = items.indexOf(neighbour);
  if (at < 0) items.push(option);
  else items.splice(where === 'after' ? at + 1 : at, 0, option);
  var height = Math.max(items.length, l.values.length - l.headerRow);
  var out = [];
  for (var i = 0; i < height; i++) out.push([items[i] || '']);
  l.sheet.getRange(l.firstItemRow, col, height, 1).setValues(out);
  return true;
}
