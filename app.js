// Signs & Stitches Job Tracker - app state, rendering and interactions.
// All data access goes through window.API (api.js).

(function () {
  'use strict';

  /* ------------------------------------------------------------ Fields */

  // Column names and order match the owner's Job Log.
  const FIELDS = [
    { key: 'job', label: 'Job #' },
    { key: 'dateIn', label: 'Date In', kind: 'date' },
    { key: 'due', label: 'Due Date', kind: 'date' },
    { key: 'customer', label: 'Customer' },
    { key: 'contact', label: 'Contact Name' },
    { key: 'phone', label: 'Phone', kind: 'tel' },
    { key: 'email', label: 'Email', kind: 'email' },
    { key: 'type', label: 'Project Type' },
    { key: 'description', label: 'Description', kind: 'long' },
    { key: 'qty', label: 'Qty', kind: 'number' },
    { key: 'status', label: 'Status', track: true },
    { key: 'estimate', label: 'Estimate', track: true },
    { key: 'material', label: 'Material', track: true },
    { key: 'artwork', label: 'Artwork', track: true },
    { key: 'production', label: 'Production', track: true },
    { key: 'delivery', label: 'Delivery', track: true },
    { key: 'payment', label: 'Payment', track: true },
    { key: 'notes', label: 'Notes', kind: 'long' },
    { key: 'createdAt', label: 'Created At', kind: 'stamp' },
    { key: 'updatedAt', label: 'Updated At', kind: 'stamp' }
  ];
  const LABEL = {};
  FIELDS.forEach((f) => { LABEL[f.key] = f.label; });
  window.FIELD_LABELS = LABEL;
  const TRACK = FIELDS.filter((f) => f.track).map((f) => f.key);
  const REQUIRED = ['customer', 'type', 'due'];
  const CLOSED = ['Complete', 'Dead'];

  // Chip colours. Options not listed here (added later in the sheet) show grey.
  const CHIP_TONE = {
    Approved: 'green', Received: 'green', Digitized: 'green', Finished: 'green', 'Paid in Full': 'green', Complete: 'green',
    Sent: 'amber', Ordered: 'amber', 'Sent to Customer': 'amber', Working: 'amber', Billed: 'amber',
    Waiting: 'red',
    'In Queue': 'blue', Active: 'blue', 'Pick-Up': 'blue', Ship: 'blue', Courier: 'blue',
    Dead: 'dead'
  };

  const POLL_MS = 20000;
  const SOON_DAYS = 3;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ------------------------------------------------------------ State */

  const state = {
    jobs: [],
    lists: { types: [], options: {} },
    rules: [],
    view: 'open',
    filters: { q: '', type: '', field: '', value: '' },
    pending: new Map(), // "job|field" -> { value, token } for saves in flight
    loaded: false,
    loading: false,
    lastSync: null,
    syncError: null,
    drawerJob: null,
    picker: null // { job, field }
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    sync: $('sync'), tableWrap: $('table-wrap'), cards: $('cards'), empty: $('empty'),
    search: $('f-search'), type: $('f-type'), field: $('f-field'), value: $('f-value'), clear: $('f-clear'),
    count: $('result-count'), picker: $('picker'), pickerTitle: $('picker-title'), pickerOptions: $('picker-options'),
    pickerBackdrop: $('picker-backdrop'), drawer: $('drawer'), drawerBackdrop: $('drawer-backdrop'),
    drawerBody: $('drawer-body'), drawerTitle: $('drawer-title'), drawerKicker: $('drawer-kicker'),
    newDialog: $('new-dialog'), newForm: $('new-form'), newError: $('new-error'), newSubmit: $('new-submit'),
    toasts: $('toasts')
  };

  /* ------------------------------------------------------------ Utilities */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function daysFromToday(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return null;
    const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((due - today) / 86400000);
  }

  // Day Month Year, e.g. "24 Sep 2026".
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : (iso || '');
  }

  function fmtStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtValue(key, v) {
    const f = FIELDS.find((x) => x.key === key);
    if (f && f.kind === 'date') return fmtDate(v);
    if (f && f.kind === 'stamp') return fmtStamp(v);
    return v == null ? '' : String(v);
  }

  function findJob(no) {
    return state.jobs.find((j) => j.job === Number(no));
  }

  function isClosed(job) {
    return CLOSED.includes(job.status);
  }

  function dueFlag(job) {
    if (isClosed(job) || job.status !== 'Active' || !job.due) return '';
    const d = daysFromToday(job.due);
    if (d === null) return '';
    if (d < 0) return 'overdue';
    if (d <= SOON_DAYS) return 'soon';
    return '';
  }

  function dueNote(job) {
    const flag = dueFlag(job);
    const d = daysFromToday(job.due);
    if (flag === 'overdue') return d === -1 ? '1 day late' : -d + ' days late';
    if (flag === 'soon') return d === 0 ? 'Due today' : d === 1 ? 'Tomorrow' : 'In ' + d + ' days';
    return '';
  }

  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(() => t.classList.add('toast-out'), kind === 'error' ? 5000 : 2800);
    setTimeout(() => t.remove(), kind === 'error' ? 5400 : 3200);
  }

  function allowed(job, field) {
    return window.Options.allowedOptions(field, job.type, state.lists, state.rules, job[field]);
  }

  /* ------------------------------------------------------------ Data sync */

  function applyPending(job) {
    state.pending.forEach((p, key) => {
      const [no, field] = key.split('|');
      if (Number(no) === job.job) job[field] = p.value;
    });
    return job;
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const data = await window.API.load();
      state.jobs = data.jobs.map(applyPending);
      state.lists = data.lists || state.lists;
      state.rules = data.rules || [];
      state.lastSync = new Date();
      state.syncError = null;
      if (!state.loaded) {
        state.loaded = true;
        fillFilterOptions();
      } else {
        refreshFilterOptions();
      }
      render();
      if (state.drawerJob) syncDrawer();
    } catch (err) {
      state.syncError = err.message || String(err);
      if (!state.loaded) {
        el.empty.hidden = false;
        el.empty.textContent = 'Could not load jobs: ' + state.syncError + '. Retrying...';
      }
    } finally {
      state.loading = false;
      renderSync();
    }
  }

  function renderSync() {
    if (state.syncError) {
      el.sync.textContent = 'Offline - retrying';
      el.sync.classList.add('sync-bad');
    } else if (state.lastSync) {
      el.sync.textContent = 'Updated ' + state.lastSync.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      el.sync.classList.remove('sync-bad');
    }
  }

  // Optimistic save: show the new value now, roll back if the save fails.
  async function setField(jobNo, field, value) {
    const job = findJob(jobNo);
    if (!job) return false;
    const old = job[field] == null ? '' : job[field];
    if (String(old) === String(value)) return true;
    if (REQUIRED.includes(field) && !String(value).trim()) {
      toast(LABEL[field] + ' is required', 'error');
      return false;
    }
    const key = jobNo + '|' + field;
    const token = {};
    state.pending.set(key, { value, token });
    job[field] = value;
    afterLocalChange(job, field, old);
    try {
      const saved = await window.API.updateField(jobNo, field, value);
      if (state.pending.get(key) && state.pending.get(key).token === token) state.pending.delete(key);
      const i = state.jobs.findIndex((j) => j.job === jobNo);
      if (i >= 0 && saved) state.jobs[i] = applyPending(saved);
      if (state.drawerJob === jobNo) { syncDrawer(); loadActivity(jobNo); }
      render();
      return true;
    } catch (err) {
      if (state.pending.get(key) && state.pending.get(key).token === token) {
        state.pending.delete(key);
        const j = findJob(jobNo);
        if (j) j[field] = old;
      }
      toast('Could not save ' + LABEL[field] + ' for job ' + jobNo + ': ' + (err.message || err), 'error');
      render();
      if (state.drawerJob === jobNo) syncDrawer(true);
      return false;
    }
  }

  function afterLocalChange(job, field, old) {
    render();
    if (field === 'status' && CLOSED.includes(job.status) !== CLOSED.includes(old)) {
      toast('Job ' + job.job + (isClosed(job) ? ' moved to Closed' : ' reopened'));
    }
    if (state.drawerJob === job.job) syncDrawer();
  }

  /* ------------------------------------------------------------ Filters */

  function fillFilterOptions() {
    el.field.innerHTML = '<option value="">Any field</option>' +
      TRACK.map((k) => '<option value="' + k + '">' + esc(LABEL[k]) + '</option>').join('');
    refreshFilterOptions();
    const typeSelect = el.newForm.elements.type;
    typeSelect.innerHTML = '<option value="">Choose...</option>' +
      state.lists.types.map((t) => '<option>' + esc(t) + '</option>').join('');
  }

  function refreshFilterOptions() {
    const cur = el.type.value;
    el.type.innerHTML = '<option value="">All types</option>' +
      state.lists.types.map((t) => '<option>' + esc(t) + '</option>').join('');
    el.type.value = cur;
    fillValueOptions();
  }

  function fillValueOptions() {
    const field = el.field.value;
    const cur = el.value.value;
    el.value.disabled = !field;
    if (!field) {
      el.value.innerHTML = '<option value="">Any value</option>';
      return;
    }
    const opts = (state.lists.options[field] || []).slice();
    state.jobs.forEach((j) => { if (j[field] && !opts.includes(j[field])) opts.push(j[field]); });
    el.value.innerHTML = '<option value="">Any ' + esc(LABEL[field]) + '</option>' +
      '<option value="__blank__">Not set</option>' +
      opts.map((o) => '<option>' + esc(o) + '</option>').join('');
    el.value.value = opts.includes(cur) || cur === '__blank__' ? cur : '';
  }

  function readFilters() {
    state.filters = {
      q: el.search.value.trim().toLowerCase(),
      type: el.type.value,
      field: el.field.value,
      value: el.value.value
    };
    const any = state.filters.q || state.filters.type || state.filters.field;
    el.clear.hidden = !any;
  }

  function matches(job) {
    const f = state.filters;
    if (f.type && job.type !== f.type) return false;
    if (f.field && f.value) {
      const v = job[f.field] || '';
      if (f.value === '__blank__' ? v !== '' : v !== f.value) return false;
    }
    if (f.q) {
      const hay = [job.job, job.customer, job.description, job.contact].join(' ').toLowerCase();
      if (!f.q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ Rendering */

  function visibleJobs() {
    const open = state.view === 'open';
    const list = state.jobs.filter((j) => (open ? !isClosed(j) : isClosed(j))).filter(matches);
    const dueKey = (j) => j.due || (open ? '9999-99-99' : '0000-00-00');
    list.sort((a, b) => {
      const c = dueKey(a).localeCompare(dueKey(b));
      if (c) return open ? c : -c;
      return open ? a.job - b.job : b.job - a.job;
    });
    return list;
  }

  function chip(job, field, opts) {
    const v = job[field] || '';
    const tone = v ? (CHIP_TONE[v] || 'grey') : 'blank';
    const pending = state.pending.has(job.job + '|' + field) ? ' is-pending' : '';
    const label = opts && opts.showLabel ? '<span class="chip-label">' + esc(LABEL[field]) + '</span>' : '';
    return '<button type="button" class="chip chip-' + tone + pending + '" data-chip="' + field + '" data-job="' + job.job +
      '" aria-label="' + esc(LABEL[field] + ': ' + (v || 'not set') + '. Change') + '">' +
      label + '<span class="chip-value">' + esc(v || 'Not set') + '</span></button>';
  }

  function dueCell(job) {
    const flag = dueFlag(job);
    const note = dueNote(job);
    return '<span class="due' + (flag ? ' due-' + flag : '') + '">' + esc(fmtDate(job.due) || '-') +
      (note ? '<span class="due-note">' + esc(note) + '</span>' : '') + '</span>';
  }

  function render() {
    if (!state.loaded) return;
    const jobs = visibleJobs();
    const open = state.jobs.filter((j) => !isClosed(j)).length;
    $('count-open').textContent = open;
    $('count-closed').textContent = state.jobs.length - open;

    const head = '<tr>' +
      '<th class="col-job sticky-1">Job #</th>' +
      '<th class="col-customer sticky-2">Customer</th>' +
      '<th>Project Type</th><th class="col-desc">Description</th><th class="num">Qty</th><th>Due Date</th>' +
      TRACK.map((k) => '<th>' + esc(LABEL[k]) + '</th>').join('') + '</tr>';

    const rows = jobs.map((j) => {
      const dead = j.status === 'Dead' ? ' row-dead' : '';
      return '<tr class="row' + dead + '" data-job="' + j.job + '">' +
        '<td class="col-job sticky-1">' + j.job + '</td>' +
        '<td class="col-customer sticky-2"><button type="button" class="open-job" data-open="' + j.job + '">' +
          esc(j.customer || '(no customer)') + '</button>' +
          (j.contact ? '<span class="sub">' + esc(j.contact) + '</span>' : '') + '</td>' +
        '<td class="col-type">' + esc(j.type) + '</td>' +
        '<td class="col-desc"><span class="clamp">' + esc(j.description) + '</span></td>' +
        '<td class="num">' + esc(j.qty) + '</td>' +
        '<td class="col-due">' + dueCell(j) + '</td>' +
        TRACK.map((k) => '<td>' + chip(j, k) + '</td>').join('') +
        '</tr>';
    }).join('');

    el.tableWrap.innerHTML = jobs.length
      ? '<table class="jobs"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>' : '';

    el.cards.innerHTML = jobs.map((j) => {
      const dead = j.status === 'Dead' ? ' card-dead' : '';
      const flag = dueFlag(j);
      return '<article class="card' + dead + (flag ? ' card-' + flag : '') + '" data-job="' + j.job + '">' +
        '<button type="button" class="card-head open-job" data-open="' + j.job + '">' +
          '<span class="card-top"><span class="card-customer">' + esc(j.customer || '(no customer)') + '</span>' +
          '<span class="card-no">#' + j.job + '</span></span>' +
          '<span class="card-meta">' + esc(j.type) + (j.qty !== '' ? ' - Qty ' + esc(j.qty) : '') + '</span>' +
          (j.description ? '<span class="card-desc">' + esc(j.description) + '</span>' : '') +
          '<span class="card-due">Due ' + dueCell(j) + '</span>' +
        '</button>' +
        '<div class="card-chips">' + TRACK.map((k) => chip(j, k, { showLabel: true })).join('') + '</div>' +
      '</article>';
    }).join('');

    const total = state.jobs.filter((j) => (state.view === 'open' ? !isClosed(j) : isClosed(j))).length;
    el.count.textContent = jobs.length === total ? total + ' jobs' : jobs.length + ' of ' + total + ' jobs';
    el.empty.hidden = jobs.length > 0;
    el.empty.textContent = total === 0
      ? (state.view === 'open' ? 'No open jobs. Press New Job to add one.' : 'No closed jobs yet.')
      : 'No jobs match these filters.';

    // A refresh replaced the chips; keep the open picker tied to the new one.
    if (state.picker) {
      const sel = '[data-chip="' + state.picker.field + '"][data-job="' + state.picker.job + '"]';
      const next = [...document.querySelectorAll(sel)].find((n) => n.offsetParent);
      if (next) state.picker.anchor = next; else closePicker();
    }
  }

  /* ------------------------------------------------------------ Chip picker */

  function openPicker(jobNo, field, anchor) {
    const job = findJob(jobNo);
    if (!job) return;
    state.picker = { job: jobNo, field, anchor };
    el.pickerTitle.textContent = LABEL[field] + ' - ' + job.customer;
    const opts = allowed(job, field);
    el.pickerOptions.innerHTML = opts.map((o) =>
      '<button type="button" class="chip chip-' + (CHIP_TONE[o] || 'grey') + (o === job[field] ? ' is-current' : '') +
      '" data-pick="' + esc(o) + '">' + esc(o) + '</button>').join('') +
      '<button type="button" class="chip chip-blank' + (!job[field] ? ' is-current' : '') + '" data-pick="">Not set</button>';
    el.picker.hidden = false;
    el.pickerBackdrop.hidden = false;
    positionPicker(anchor);
    const first = el.pickerOptions.querySelector('.is-current') || el.pickerOptions.querySelector('button');
    if (first) first.focus();
  }

  function positionPicker(anchor) {
    if (window.matchMedia('(max-width: 767px)').matches) {
      el.picker.style.left = el.picker.style.top = '';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const pw = el.picker.offsetWidth;
    const ph = el.picker.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    el.picker.style.left = Math.max(8, left) + 'px';
    el.picker.style.top = top + 'px';
  }

  function closePicker() {
    if (!state.picker) return;
    const { job, field } = state.picker;
    state.picker = null;
    el.picker.hidden = true;
    el.pickerBackdrop.hidden = true;
    const back = document.querySelector('[data-chip="' + field + '"][data-job="' + job + '"]');
    if (back && back.offsetParent) back.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ Drawer */

  function inputFor(f, job) {
    const v = job[f.key] == null ? '' : job[f.key];
    const req = REQUIRED.includes(f.key) ? ' required' : '';
    const attrs = ' class="input" data-field="' + f.key + '" id="d-' + f.key + '"' + req;
    if (f.key === 'type') {
      const types = state.lists.types.slice();
      if (v && !types.includes(v)) types.push(v);
      return '<select' + attrs + '>' + types.map((t) =>
        '<option' + (t === v ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>';
    }
    if (f.track) {
      return '<select' + attrs + '><option value="">Not set</option>' + allowed(job, f.key).map((o) =>
        '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    }
    if (f.kind === 'long') return '<textarea' + attrs + ' rows="3">' + esc(v) + '</textarea>';
    const type = { date: 'date', number: 'number', tel: 'tel', email: 'email' }[f.kind] || 'text';
    const extra = f.kind === 'number' ? ' min="0" inputmode="numeric"' : '';
    return '<input type="' + type + '"' + attrs + extra + ' value="' + esc(v) + '" autocomplete="off">';
  }

  function openDrawer(jobNo) {
    const job = findJob(jobNo);
    if (!job) return;
    closePicker();
    state.drawerJob = jobNo;
    const group = (keys) => keys.map((k) => {
      const f = FIELDS.find((x) => x.key === k);
      const wide = f.kind === 'long' || k === 'customer' || k === 'email' ? ' span-2' : '';
      return '<label class="field' + wide + '" for="d-' + k + '">' + esc(f.label) +
        (REQUIRED.includes(k) ? ' <span class="req">required</span>' : '') +
        (f.kind === 'date' ? '<span class="date-says" data-says="' + k + '"></span>' : '') + inputFor(f, job) + '</label>';
    }).join('');

    el.drawerBody.innerHTML =
      '<div class="drawer-chips" id="drawer-chips"></div>' +
      '<h3 class="section-title">Job</h3>' +
      '<div class="form-grid">' + group(['customer', 'type', 'dateIn', 'due', 'qty', 'description']) + '</div>' +
      '<h3 class="section-title">Tracking</h3>' +
      '<div class="form-grid">' + group(TRACK) + '</div>' +
      '<h3 class="section-title">Contact</h3>' +
      '<div class="form-grid">' + group(['contact', 'phone', 'email']) + '</div>' +
      '<h3 class="section-title">Notes</h3>' +
      '<div class="form-grid">' + group(['notes']) + '</div>' +
      '<p class="stamps" id="drawer-stamps"></p>' +
      '<h3 class="section-title">Activity</h3>' +
      '<ol class="activity" id="activity"><li class="muted">Loading...</li></ol>';

    syncDrawer();
    el.drawer.hidden = false;
    el.drawerBackdrop.hidden = false;
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => el.drawer.classList.add('is-open'));
    $('drawer-close').focus();
    loadActivity(jobNo);
  }

  // Refresh drawer inputs from state, leaving alone whatever the user is typing in.
  function syncDrawer(force) {
    const job = findJob(state.drawerJob);
    if (!job) return;
    el.drawerKicker.textContent = 'Job #' + job.job + (job.status === 'Dead' ? ' - Dead' : '');
    el.drawerTitle.textContent = job.customer || '(no customer)';
    el.drawer.classList.toggle('drawer-dead', job.status === 'Dead');
    $('drawer-chips').innerHTML = '<span class="drawer-due-label">Due</span> ' + dueCell(job);
    FIELDS.forEach((f) => {
      const input = $('d-' + f.key);
      if (!input || (!force && input === document.activeElement)) return;
      if (f.track || f.key === 'type') {
        const tmp = document.createElement('div');
        tmp.innerHTML = inputFor(f, job);
        input.innerHTML = tmp.firstChild.innerHTML;
      }
      input.value = job[f.key] == null ? '' : job[f.key];
    });
    showDates(el.drawerBody, job);
    $('drawer-stamps').textContent =
      (job.createdAt ? 'Created ' + fmtStamp(job.createdAt) : '') +
      (job.updatedAt ? (job.createdAt ? ' - ' : '') + 'Last changed ' + fmtStamp(job.updatedAt) : '');
  }

  // Date inputs follow the browser's locale, so spell the date out Day Month Year beside them.
  function showDates(root, values) {
    root.querySelectorAll('[data-says]').forEach((n) => {
      const v = values ? values[n.dataset.says] : root.querySelector('[name="' + n.dataset.says + '"]').value;
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
      n.textContent = d ? new Date(+d[1], d[2] - 1, +d[3]).toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + fmtDate(v) : '';
    });
  }

  async function loadActivity(jobNo) {
    const list = $('activity');
    try {
      const items = await window.API.activity(jobNo);
      if (state.drawerJob !== jobNo || !list.isConnected) return;
      list.innerHTML = items.length ? items.map((a) =>
        '<li><span class="act-when">' + esc(fmtStamp(a.at)) + '</span>' +
        '<span class="act-what"><strong>' + esc(a.field) + '</strong> ' +
        (a.field === 'Created' ? esc(a.newValue)
          : esc(a.oldValue || 'Not set') + ' <span class="arrow" aria-label="changed to">to</span> ' + esc(a.newValue || 'Not set')) +
        '</span></li>').join('') : '<li class="muted">No changes recorded yet.</li>';
    } catch (err) {
      if (list.isConnected) list.innerHTML = '<li class="muted">Could not load activity.</li>';
    }
  }

  function closeDrawer() {
    if (state.drawerJob == null) return;
    const no = state.drawerJob;
    const active = document.activeElement;
    if (active && active.dataset && active.dataset.field) active.blur(); // commits a pending text edit
    state.drawerJob = null;
    el.drawer.classList.remove('is-open');
    el.drawerBackdrop.hidden = true;
    document.body.classList.remove('no-scroll');
    setTimeout(() => { if (state.drawerJob == null) el.drawer.hidden = true; }, 200);
    const back = document.querySelector('[data-open="' + no + '"]');
    if (back && back.offsetParent) back.focus({ preventScroll: true });
  }

  function onDrawerChange(e) {
    const input = e.target;
    const field = input.dataset.field;
    if (!field || state.drawerJob == null) return;
    const jobNo = state.drawerJob;
    let value = input.value;
    if (field === 'qty') value = value === '' ? '' : Number(value);
    else if (typeof value === 'string' && input.tagName !== 'SELECT') value = value.trim();
    if (REQUIRED.includes(field) && value === '') {
      toast(LABEL[field] + ' is required', 'error');
      const job = findJob(jobNo);
      input.value = job ? job[field] : '';
      return;
    }
    setField(jobNo, field, value);
  }

  /* ------------------------------------------------------------ New job */

  function openNew() {
    el.newForm.reset();
    el.newForm.elements.dateIn.value = todayIso();
    showDates(el.newForm);
    el.newError.hidden = true;
    el.newSubmit.disabled = false;
    el.newSubmit.textContent = 'Create Job';
    el.newDialog.showModal();
    el.newForm.elements.customer.focus();
  }

  async function submitNew(e) {
    e.preventDefault();
    const form = el.newForm.elements;
    const data = {};
    ['customer', 'type', 'due', 'dateIn', 'qty', 'description', 'contact', 'phone', 'email', 'notes'].forEach((k) => {
      const v = form[k].value.trim();
      if (v !== '') data[k] = k === 'qty' ? Number(v) : v;
    });
    const missing = REQUIRED.filter((k) => !data[k]);
    if (missing.length) {
      el.newError.textContent = 'Please fill in: ' + missing.map((k) => LABEL[k]).join(', ') + '.';
      el.newError.hidden = false;
      form[missing[0]].focus();
      return;
    }
    data.status = 'Active';
    el.newSubmit.disabled = true;
    el.newSubmit.textContent = 'Saving...';
    try {
      const job = await window.API.createJob(data);
      state.jobs.push(job);
      el.newDialog.close();
      if (state.view !== 'open') setView('open');
      render();
      toast('Job ' + job.job + ' created for ' + job.customer);
      const row = document.querySelector('.row[data-job="' + job.job + '"], .card[data-job="' + job.job + '"]');
      if (row && row.offsetParent) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('flash');
      }
    } catch (err) {
      el.newError.textContent = 'Could not create job: ' + (err.message || err);
      el.newError.hidden = false;
      el.newSubmit.disabled = false;
      el.newSubmit.textContent = 'Create Job';
    }
  }

  /* ------------------------------------------------------------ Export */

  function exportCsv() {
    if (!state.jobs.length) { toast('No jobs to export'); return; }
    const cell = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+@]/.test(s)) s = "'" + s; // keep spreadsheet apps from running it as a formula
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [FIELDS.map((f) => cell(f.label)).join(',')];
    state.jobs.slice().sort((a, b) => a.job - b.job).forEach((j) => {
      rows.push(FIELDS.map((f) => cell(fmtValue(f.key, j[f.key]))).join(','));
    });
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'signs-stitches-jobs-' + todayIso() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Exported ' + state.jobs.length + ' jobs');
  }

  /* ------------------------------------------------------------ Views */

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.view === view));
    });
    document.body.dataset.view = view;
    render();
  }

  /* ------------------------------------------------------------ Events */

  function bind() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
    $('new-btn').addEventListener('click', openNew);
    $('new-cancel').addEventListener('click', () => el.newDialog.close());
    $('export-btn').addEventListener('click', exportCsv);
    el.newForm.addEventListener('submit', submitNew);
    el.newForm.addEventListener('input', () => { showDates(el.newForm); el.newError.hidden = true; });

    el.search.addEventListener('input', () => { readFilters(); render(); });
    el.type.addEventListener('change', () => { readFilters(); render(); });
    el.field.addEventListener('change', () => { fillValueOptions(); readFilters(); render(); });
    el.value.addEventListener('change', () => { readFilters(); render(); });
    el.clear.addEventListener('click', () => {
      el.search.value = '';
      el.type.value = '';
      el.field.value = '';
      fillValueOptions();
      readFilters();
      render();
    });

    // One listener for rows, cards and chips.
    $('main').addEventListener('click', (e) => {
      const c = e.target.closest('[data-chip]');
      if (c) {
        e.stopPropagation();
        const same = state.picker && state.picker.job === Number(c.dataset.job) && state.picker.field === c.dataset.chip;
        closePicker();
        if (!same) openPicker(Number(c.dataset.job), c.dataset.chip, c);
        return;
      }
      const o = e.target.closest('[data-open]') || e.target.closest('tr.row');
      if (o) openDrawer(Number(o.dataset.open || o.dataset.job));
    });

    el.pickerOptions.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b || !state.picker) return;
      const { job, field } = state.picker;
      closePicker();
      setField(job, field, b.dataset.pick);
    });
    el.pickerBackdrop.addEventListener('click', closePicker);

    el.drawerBody.addEventListener('change', onDrawerChange);
    el.drawerBody.addEventListener('input', (e) => {
      const n = e.target.dataset.field && el.drawerBody.querySelector('[data-says="' + e.target.dataset.field + '"]');
      if (n) showDates(n.parentNode, { [e.target.dataset.field]: e.target.value });
    });
    $('drawer-close').addEventListener('click', closeDrawer);
    el.drawerBackdrop.addEventListener('click', closeDrawer);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (state.picker) { closePicker(); e.preventDefault(); }
      else if (state.drawerJob != null && !el.newDialog.open) { closeDrawer(); e.preventDefault(); }
    });
    // Keep the picker attached to its chip while the table or page scrolls.
    const follow = () => {
      if (!state.picker) return;
      const a = state.picker.anchor;
      if (a && a.isConnected) positionPicker(a); else closePicker();
    };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);

    // Keep every screen in step: poll, and refresh when the tab comes back.
    setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);

    if (window.API.demo) {
      $('demo-banner').hidden = false;
      $('demo-reset').addEventListener('click', () => { window.API.reset(); refresh(); toast('Demo data reset'); });
    }
  }

  // Test hook (used by tests/ui.test.js).
  window.__app = { state, refresh, setField, POLL_MS };

  document.body.dataset.view = 'open';
  bind();
  refresh();
})();
