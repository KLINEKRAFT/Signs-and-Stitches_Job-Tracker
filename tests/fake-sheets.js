// Minimal in-memory stand-in for the Apps Script services Code.gs uses.
// Enough to exercise doGet/doPost/setup logic in Node; not a full emulator.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  cells(fn) {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(fn(this.row + r, this.col + c, r, c));
      out.push(line);
    }
    return out;
  }
  getValues() { return this.cells((r, c) => this.sheet.get(r, c)); }
  getValue() { return this.sheet.get(this.row, this.col); }
  getFormulas() { return this.cells((r, c) => this.sheet.formulas[`${r},${c}`] || ''); }
  setValue(v) { this.cells((r, c) => this.sheet.set(r, c, v)); return this; }
  setValues(vals) { this.cells((r, c, i, j) => this.sheet.set(r, c, vals[i][j])); return this; }
  setFormula(f) { this.sheet.formulas[`${this.row},${this.col}`] = f; return this; }
  setNumberFormat(f) { this.cells((r, c) => { this.sheet.formats[`${r},${c}`] = f; }); return this; }
  setNumberFormats(fs) { this.cells((r, c, i, j) => { this.sheet.formats[`${r},${c}`] = fs[i][j]; }); return this; }
  clearContent() { this.cells((r, c) => this.sheet.set(r, c, '')); return this; }
  setFontWeight() { return this; }
  copyTo(target) { this.sheet.copies.push([this.row, target.row, target.rows]); }
  setDataValidation(rule) { this.sheet.validations.push({ row: this.row, col: this.col, rows: this.rows, rule }); return this; }
}

class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.data = (rows || []).map((r) => r.slice());
    this.formats = {};
    this.formulas = {};
    this.copies = [];
    this.validations = [];
    this.maxRows = 1000;
  }
  get(r, c) { const row = this.data[r - 1]; return row && row[c - 1] !== undefined ? row[c - 1] : ''; }
  set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    // Mimic Sheets parsing a typed string, unless the cell is plain text.
    if (typeof v === 'string' && this.formats[`${r},${c}`] !== '@') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = new Date(v + 'T00:00:00Z');
      else if (v.trim() !== '' && isFinite(Number(v))) v = Number(v);
    }
    row[c - 1] = v;
  }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr || 1, nc || 1); }
  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) if (this.data[r - 1].some((v) => v !== '')) return r;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((row) => row.forEach((v, i) => { if (v !== '') max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return Math.max(this.maxRows, this.data.length); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  setFrozenRows() {}
  setColumnWidth() {}
}

function makeSpreadsheet(tabs) {
  const sheets = {};
  Object.keys(tabs).forEach((k) => { sheets[k] = new FakeSheet(k, tabs[k]); });
  return {
    sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new FakeSheet(n, [])),
    getSpreadsheetTimeZone: () => 'UTC'
  };
}

function loadCodeGs(spreadsheet) {
  const lockLog = [];
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush: () => {},
      newDataValidation: () => {
        const rule = {};
        const b = {
          requireValueInRange: (range, show) => { rule.range = range; rule.show = show; return b; },
          setAllowInvalid: (v) => { rule.allowInvalid = v; return b; },
          build: () => rule
        };
        return b;
      },
      CopyPasteType: { PASTE_DATA_VALIDATION: 'PASTE_DATA_VALIDATION' }
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => lockLog.push('lock'),
        releaseLock: () => lockLog.push('release')
      })
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } })
    },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        if (fmt !== 'yyyy-MM-dd') throw new Error('fake formatDate only knows yyyy-MM-dd');
        return d.toISOString().slice(0, 10);
      }
    },
    Logger: { log: () => {} }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  ctx.lockLog = lockLog;
  return ctx;
}

// The owner's sheet, as exported (see /reference).
function ownerSheet() {
  const header = ['Job #', 'Date In', 'Due Date', 'Customer', 'Contact Name', 'Phone', 'Email', 'Project Type',
    'Description', 'Qty', 'Status', 'Estimate', 'Material', 'Artwork', 'Production', 'Delivery', 'Payment', 'Notes'];
  const d = (s) => new Date(s + 'T00:00:00Z');
  return makeSpreadsheet({
    'Job Log': [
      header,
      [1001, d('2026-09-18'), d('2026-09-28'), 'SAMPLE - Sand Springs Youth Football', 'Jane Doe', '918-555-0100',
        'jane@example.com', 'T-Shirts - Screen Print', 'Team tees, 2-color front', 48, 'Active', 'Approved',
        'Ordered', 'Approved', 'In Queue', 'Pick-Up', 'Billed', 'Example row - delete when you start'],
      [1002, d('2026-09-14'), d('2026-09-23'), 'SAMPLE - Main St Coffee', 'John Roe', '918-555-0101',
        'john@example.com', 'Embroidery - Hats', 'Richardson 112, left-front logo', 24, 'Active', 'Approved',
        'Received', 'Digitized', 'Working', 'Pick-Up', 'Billed', 'Overdue example - due date is past'],
      [1003, d('2026-09-04'), d('2026-09-12'), 'SAMPLE - Garfield Ave Dental', 'Amy Poe', '918-555-0102',
        'amy@example.com', 'Vinyl - Signage', 'Window hours decal', 1, 'Complete', 'Approved', 'Received',
        'Approved', 'Finished', 'Pick-Up', 'Paid in Full', 'Complete example - shows on Closed tab']
    ],
    Lists: [
      ['Dropdown options. Add to the bottom of a column and the dropdown picks it up.'],
      ['Project Type', 'Status', 'Estimate', 'Material', 'Artwork', 'Production', 'Delivery', 'Payment'],
      ['Embroidery - Hats', 'Active', 'Sent', 'Waiting', 'Sent to Customer', 'In Queue', 'Pick-Up', 'Billed'],
      ['Embroidery - Apparel', 'Complete', 'Approved', 'Ordered', 'Approved', 'Working', 'Ship', 'Paid in Full'],
      ['Embroidery - Other', 'Dead', '', 'Received', 'Digitized', 'Finished', 'Courier', ''],
      ['Vinyl - Apparel'], ['Vinyl - Signage'], ['Vinyl - Other'], ['Promo'], ['T-Shirts - Screen Print'],
      ['Heat Press - Hat'], ['Heat Press - Other'], ['Leather Work'], ['Other']
    ],
    'Open Jobs': [['OPEN JOBS  -  soonest due first'], ['View only.'], ['Job #']],
    'Closed Jobs': [['CLOSED JOBS  -  complete and dead'], ['View only.'], ['Job #']]
  });
}

module.exports = { makeSpreadsheet, loadCodeGs, ownerSheet };
