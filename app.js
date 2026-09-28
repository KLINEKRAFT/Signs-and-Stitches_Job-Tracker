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
    { key: 'updatedAt', label: 'Updated At', kind: 'stamp' },
    { key: 'order', label: 'Order #' }
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
    'Being Designed': 'amber',
    Waiting: 'red', 'On Hold': 'red',
    'Not Sent': 'grey',
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
    picker: null, // { job, field }
    newLinkTo: 0 // when adding a project to an existing order
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    sync: $('sync'), tableWrap: $('table-wrap'), cards: $('cards'), empty: $('empty'),
    search: $('f-search'), type: $('f-type'), field: $('f-field'), value: $('f-value'), clear: $('f-clear'),
    count: $('result-count'), picker: $('picker'), pickerTitle: $('picker-title'), pickerOptions: $('picker-options'),
    pickerBackdrop: $('picker-backdrop'), drawer: $('drawer'), drawerBackdrop: $('drawer-backdrop'),
    drawerBody: $('drawer-body'), drawerTitle: $('drawer-title'), drawerKicker: $('drawer-kicker'),
    newDialog: $('new-dialog'), newForm: $('new-form'), newError: $('new-error'), newSubmit: $('new-submit'),
    newTitle: $('new-title'), newNote: $('new-note'), projects: $('projects'), customers: $('customer-list'),
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

  // sticky toasts stay until dismissed (used for "rest of the order is not ready" warnings).
  function toast(msg, kind, sticky) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' toast-' + kind : '') + (sticky ? ' toast-sticky' : '');
    t.setAttribute('role', kind === 'error' || kind === 'warn' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.textContent = msg;
    t.appendChild(text);
    el.toasts.appendChild(t);
    if (sticky) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-close';
      b.textContent = 'Got it';
      b.addEventListener('click', () => t.remove());
      t.appendChild(b);
      return;
    }
    setTimeout(() => t.classList.add('toast-out'), kind === 'error' ? 5000 : 2800);
    setTimeout(() => t.remove(), kind === 'error' ? 5400 : 3200);
  }

  /* ------------------------------------------------------------ Orders (linked projects) */

  // Projects that came in together share an Order # so nobody tells the customer
  // it is ready while part of it is still in the works.
  // A project counts as ready once Production is Finished or it is Complete. Dead ones drop out.
  function isReady(j) {
    return j.status === 'Complete' || j.production === 'Finished';
  }

  function orderOf(j) {
    return j.order === '' || j.order == null || isNaN(Number(j.order)) ? 0 : Number(j.order);
  }

  // null when the job is on its own.
  function orderInfo(j) {
    const o = orderOf(j);
    if (!o) return null;
    const mates = state.jobs.filter((x) => x.job !== j.job && orderOf(x) === o);
    if (!mates.length) return null;
    const live = [j].concat(mates).filter((x) => x.status !== 'Dead');
    return {
      order: o,
      mates: mates.sort((a, b) => a.job - b.job),
      total: live.length,
      ready: live.filter(isReady).length,
      waiting: mates.filter((x) => x.status !== 'Dead' && !isReady(x))
    };
  }

  function orderBadge(j) {
    const info = orderInfo(j);
    if (!info) return '';
    const all = info.ready === info.total;
    return '<button type="button" class="order-badge ' + (all ? 'order-ready' : 'order-waiting') +
      '" data-order-filter="' + info.order + '" title="Show every project in this order">' +
      'Order ' + info.order + ' - ' + (all ? 'all ' + info.total + ' ready' : info.ready + ' of ' + info.total + ' ready') +
      '</button>';
  }

  function describe(j) {
    return '#' + j.job + ' ' + j.type + (j.description ? ' (' + j.description + ')' : '');
  }

  // Called when a project is marked Finished or Complete.
  function warnAboutOrder(job) {
    const info = orderInfo(job);
    if (!info) return;
    if (info.waiting.length) {
      toast('Heads up: ' + job.customer + ' has ' + info.waiting.length + ' more ' +
        (info.waiting.length === 1 ? 'project' : 'projects') + ' in order ' + info.order + ' that ' +
        (info.waiting.length === 1 ? 'is' : 'are') + ' not ready: ' + info.waiting.map(describe).join(', ') +
        '. Do not tell the customer the order is ready yet.', 'warn', true);
    } else {
      toast('All ' + info.total + ' projects in order ' + info.order + ' are ready. OK to let ' + job.customer + ' know.', 'ok');
    }
  }

  function mergeJobs(list) {
    (list || []).forEach((saved) => {
      const i = state.jobs.findIndex((j) => j.job === saved.job);
      if (i >= 0) state.jobs[i] = applyPending(saved); else state.jobs.push(saved);
    });
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
    if ((field === 'production' && job.production === 'Finished') || (field === 'status' && job.status === 'Complete')) {
      warnAboutOrder(job);
    }
    if (state.drawerJob === job.job) syncDrawer();
  }

  /* ------------------------------------------------------------ Filters */

  function fillFilterOptions() {
    el.field.innerHTML = '<option value="">Any field</option>' +
      TRACK.map((k) => '<option value="' + k + '">' + esc(LABEL[k]) + '</option>').join('');
    refreshFilterOptions();
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
      const ok = f.q.split(/\s+/).every((w) => {
        // "#1002" means exactly job 1002 or anything in order 1002.
        const exact = /^#(\d+)$/.exec(w);
        if (exact) return job.job === Number(exact[1]) || orderOf(job) === Number(exact[1]);
        return hay.includes(w);
      });
      if (!ok) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ Rendering */

  function visibleJobs() {
    const open = state.view === 'open';
    const list = state.jobs.filter((j) => (open ? !isClosed(j) : isClosed(j))).filter(matches);
    const dueKey = (j) => j.due || (open ? '9999-99-99' : '0000-00-00');
    // Keep an order's projects next to each other, placed by its most urgent one.
    const lead = new Map();
    list.forEach((j) => {
      const o = orderOf(j);
      if (!o) return;
      const d = dueKey(j);
      const cur = lead.get(o);
      if (cur === undefined || (open ? d < cur : d > cur)) lead.set(o, d);
    });
    const groupDue = (j) => (lead.has(orderOf(j)) ? lead.get(orderOf(j)) : dueKey(j));
    const groupId = (j) => orderOf(j) || j.job;
    const dir = open ? 1 : -1;
    list.sort((a, b) =>
      dir * groupDue(a).localeCompare(groupDue(b)) ||
      dir * (groupId(a) - groupId(b)) ||
      dir * dueKey(a).localeCompare(dueKey(b)) ||
      dir * (a.job - b.job));
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
      '<th>Project Type</th><th class="col-desc">Description</th><th>Due Date</th>' +
      TRACK.map((k) => '<th>' + esc(LABEL[k]) + '</th>').join('') + '</tr>';

    const rows = jobs.map((j) => {
      const dead = j.status === 'Dead' ? ' row-dead' : '';
      const linked = orderInfo(j) ? ' row-linked' : '';
      return '<tr class="row' + dead + linked + '" data-job="' + j.job + '">' +
        '<td class="col-job sticky-1">' + j.job + '</td>' +
        '<td class="col-customer sticky-2"><button type="button" class="open-job" data-open="' + j.job + '">' +
          esc(j.customer || '(no customer)') + '</button>' +
          (j.contact ? '<span class="sub">' + esc(j.contact) + '</span>' : '') + orderBadge(j) + '</td>' +
        '<td class="col-type">' + esc(j.type) + '</td>' +
        '<td class="col-desc"><span class="clamp">' + esc(j.description) + '</span></td>' +
        '<td class="col-due">' + dueCell(j) + '</td>' +
        TRACK.map((k) => '<td>' + chip(j, k) + '</td>').join('') +
        '</tr>';
    }).join('');

    el.tableWrap.innerHTML = jobs.length
      ? '<table class="jobs"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>' : '';

    el.cards.innerHTML = jobs.map((j) => {
      const dead = j.status === 'Dead' ? ' card-dead' : '';
      const flag = dueFlag(j);
      const linked = orderInfo(j) ? ' card-linked' : '';
      return '<article class="card' + dead + linked + (flag ? ' card-' + flag : '') + '" data-job="' + j.job + '">' +
        '<button type="button" class="card-head open-job" data-open="' + j.job + '">' +
          '<span class="card-top"><span class="card-customer">' + esc(j.customer || '(no customer)') + '</span>' +
          '<span class="card-no">#' + j.job + '</span></span>' +
          '<span class="card-meta">' + esc(j.type) + '</span>' +
          (j.description ? '<span class="card-desc">' + esc(j.description) + '</span>' : '') +
          '<span class="card-due">Due ' + dueCell(j) + '</span>' +
        '</button>' +
        (orderInfo(j) ? '<div class="card-order">' + orderBadge(j) + '</div>' : '') +
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
      '<section class="drawer-order" id="drawer-order" aria-label="Linked projects"></section>' +
      '<h3 class="section-title">Job</h3>' +
      '<div class="form-grid">' + group(['customer', 'type', 'dateIn', 'due', 'description']) + '</div>' +
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
    const orderBox = $('drawer-order');
    if (!orderBox.contains(document.activeElement) || force) orderBox.innerHTML = drawerOrder(job);
    $('drawer-stamps').textContent =
      (job.createdAt ? 'Created ' + fmtStamp(job.createdAt) : '') +
      (job.updatedAt ? (job.createdAt ? ' - ' : '') + 'Last changed ' + fmtStamp(job.updatedAt) : '');
  }

  function drawerOrder(job) {
    const info = orderInfo(job);
    const addBtn = '<button type="button" class="btn btn-ghost" data-act="add-to-order">' +
      (info ? 'Add another project to this order' : 'Add another project for this customer') + '</button>';
    if (info) {
      const all = info.ready === info.total;
      return '<div class="order-banner ' + (all ? 'order-ready' : 'order-waiting') + '">' +
        '<strong>Order ' + info.order + ': ' + info.total + ' projects, ' +
        (all ? 'all ready.' : info.ready + ' of ' + info.total + ' ready.') + '</strong> ' +
        (all ? 'OK to let the customer know.' : 'Do not tell the customer it is ready until every project is.') +
        '</div>' +
        '<ul class="mates">' + info.mates.map((m) =>
          '<li><button type="button" class="mate" data-mate="' + m.job + '">' +
          '<span class="mate-name">#' + m.job + ' ' + esc(m.type) + (m.description ? ' - ' + esc(m.description) : '') + '</span>' +
          '<span class="mate-state">' + esc(mateState(m)) + '</span></button></li>').join('') + '</ul>' +
        '<div class="order-actions">' + addBtn +
        '<button type="button" class="btn btn-ghost" data-act="unlink">Unlink this job</button></div>';
    }
    const others = state.jobs.filter((x) => x.job !== job.job && !isClosed(x));
    const same = others.filter((x) => sameCustomer(x, job));
    const rest = others.filter((x) => !sameCustomer(x, job));
    const opt = (x) => '<option value="' + x.job + '">#' + x.job + ' ' + esc(x.customer) + ' - ' + esc(x.type) + '</option>';
    return '<p class="order-solo">' + (same.length
      ? '<strong>' + same.length + ' other open ' + (same.length === 1 ? 'job' : 'jobs') + ' for this customer, not linked.</strong> Link them if they were ordered together.'
      : 'This job is on its own.') + '</p>' +
      '<div class="order-actions">' + addBtn +
      (others.length ? '<label class="link-pick">Link to' +
        '<select class="input" data-act="link"><option value="">Choose a job...</option>' +
        (same.length ? '<optgroup label="Same customer">' + same.map(opt).join('') + '</optgroup>' : '') +
        (rest.length ? '<optgroup label="Other open jobs">' + rest.map(opt).join('') + '</optgroup>' : '') +
        '</select></label>' : '') + '</div>';
  }

  function mateState(m) {
    if (m.status === 'Dead') return 'Dead';
    if (isReady(m)) return 'Ready';
    return [m.status !== 'Active' ? m.status : '', m.production ? 'Production: ' + m.production : 'Not started',
      m.artwork ? 'Artwork: ' + m.artwork : ''].filter(Boolean).join(' - ');
  }

  function sameCustomer(a, b) {
    return String(a.customer).trim().toLowerCase() === String(b.customer).trim().toLowerCase();
  }

  async function linkTo(jobNo, to) {
    try {
      const jobs = await window.API.linkJob(jobNo, to);
      mergeJobs(jobs);
      render();
      if (state.drawerJob === jobNo) { syncDrawer(true); loadActivity(jobNo); }
      toast('Job ' + jobNo + ' linked to order ' + orderOf(findJob(jobNo)));
    } catch (err) {
      toast('Could not link job ' + jobNo + ': ' + (err.message || err), 'error');
      if (state.drawerJob === jobNo) syncDrawer(true);
    }
  }

  function onDrawerOrderClick(e) {
    const mate = e.target.closest('[data-mate]');
    if (mate) { openDrawer(Number(mate.dataset.mate)); return; }
    const act = e.target.closest('[data-act]');
    if (!act || state.drawerJob == null) return;
    const job = findJob(state.drawerJob);
    if (act.dataset.act === 'add-to-order') openNew(job);
    if (act.dataset.act === 'unlink') {
      setField(job.job, 'order', '').then((ok) => { if (ok) { syncDrawer(true); toast('Job ' + job.job + ' unlinked'); } });
    }
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
    if (input.dataset.act === 'link') {
      if (input.value) linkTo(state.drawerJob, Number(input.value));
      return;
    }
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

  // from: an existing job when adding another project to its order (or starting one).
  function openNew(from) {
    el.newForm.reset();
    el.newForm.elements.dateIn.value = todayIso();
    el.projects.innerHTML = '';
    addProjectRow();
    state.newLinkTo = 0;
    el.newTitle.textContent = 'New Job';
    el.newNote.hidden = true;
    el.customers.innerHTML = customerNames().map((c) => '<option value="' + esc(c) + '">').join('');
    if (from && from.job) {
      state.newLinkTo = orderOf(from) || from.job;
      const f = el.newForm.elements;
      ['customer', 'due', 'contact', 'phone', 'email'].forEach((k) => { f[k].value = from[k] || ''; });
      el.newTitle.textContent = orderOf(from) ? 'Add to Order ' + state.newLinkTo : 'Add a Linked Project';
      el.newNote.textContent = 'This project will be linked with ' +
        [from].concat(orderInfo(from) ? orderInfo(from).mates : []).map((j) => '#' + j.job).join(', ') + '.';
      el.newNote.hidden = false;
    }
    showDates(el.newForm);
    el.newError.hidden = true;
    el.newSubmit.disabled = false;
    updateSubmitLabel();
    el.newDialog.showModal();
    (from ? el.projects.querySelector('select') : el.newForm.elements.customer).focus();
  }

  function customerNames() {
    const seen = new Map();
    state.jobs.slice().sort((a, b) => b.job - a.job).forEach((j) => {
      const k = String(j.customer).trim().toLowerCase();
      if (k && !seen.has(k)) seen.set(k, j.customer.trim());
    });
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  // Picking a known customer fills in their contact details from their latest job.
  function fillKnownCustomer() {
    const f = el.newForm.elements;
    const name = f.customer.value.trim().toLowerCase();
    if (!name) return;
    const last = state.jobs.filter((j) => String(j.customer).trim().toLowerCase() === name).sort((a, b) => b.job - a.job)[0];
    if (!last) return;
    ['contact', 'phone', 'email'].forEach((k) => { if (!f[k].value && last[k]) f[k].value = last[k]; });
  }

  function addProjectRow() {
    const n = el.projects.children.length + 1;
    const row = document.createElement('div');
    row.className = 'project-row';
    row.innerHTML =
      '<label class="field">Project Type <span class="req">required</span>' +
        '<select class="input" name="type" aria-label="Project type for project ' + n + '"><option value="">Choose...</option>' +
        state.lists.types.map((t) => '<option>' + esc(t) + '</option>').join('') + '</select></label>' +
      '<label class="field">What is it?' +
        '<input class="input" name="description" autocomplete="off" placeholder="e.g. 24 hats, left-front logo"></label>' +
      '<button type="button" class="btn btn-ghost remove-project" aria-label="Remove project ' + n + '">Remove</button>';
    el.projects.appendChild(row);
    updateSubmitLabel();
    return row;
  }

  function updateSubmitLabel() {
    const rows = el.projects.children.length;
    el.projects.classList.toggle('is-multi', rows > 1);
    el.newSubmit.textContent = rows > 1 ? 'Create ' + rows + ' Linked Jobs' : 'Create Job';
  }

  async function submitNew(e) {
    e.preventDefault();
    const form = el.newForm.elements;
    const shared = {};
    ['customer', 'due', 'dateIn', 'contact', 'phone', 'email', 'notes'].forEach((k) => {
      const v = form[k].value.trim();
      if (v !== '') shared[k] = v;
    });
    const rows = [...el.projects.querySelectorAll('.project-row')].map((r) => ({
      type: r.querySelector('select').value,
      description: r.querySelector('input').value.trim(),
      el: r
    }));
    const missing = [];
    if (!shared.customer) missing.push('Customer');
    if (!shared.due) missing.push('Due Date');
    const noType = rows.filter((r) => !r.type);
    if (noType.length) missing.push('Project Type');
    if (missing.length) {
      el.newError.textContent = 'Please fill in: ' + missing.join(', ') + '.';
      el.newError.hidden = false;
      (!shared.customer ? form.customer : !shared.due ? form.due : noType[0].el.querySelector('select')).focus();
      return;
    }
    const list = rows.map((r) => Object.assign({}, shared, { type: r.type, description: r.description }));
    el.newSubmit.disabled = true;
    el.newSubmit.textContent = 'Saving...';
    try {
      const linkTo = state.newLinkTo;
      const jobs = await window.API.createJobs(list, linkTo);
      mergeJobs(jobs);
      el.newDialog.close();
      if (state.view !== 'open') setView('open');
      render();
      if (linkTo) toast('Job ' + jobs.map((j) => j.job).join(', ') + ' added to order ' + linkTo);
      else if (jobs.length > 1) toast(jobs.length + ' linked jobs created for ' + jobs[0].customer + ' (order ' + jobs[0].order + ')');
      else toast('Job ' + jobs[0].job + ' created for ' + jobs[0].customer);
      if (linkTo) refresh(); // the job we linked to may have just been given its Order #
      jobs.forEach((job) => {
        const row = [...document.querySelectorAll('.row[data-job="' + job.job + '"], .card[data-job="' + job.job + '"]')].find((n) => n.offsetParent);
        if (row) row.classList.add('flash');
      });
      const first = [...document.querySelectorAll('[data-job="' + jobs[0].job + '"]')].find((n) => n.offsetParent);
      if (first) first.scrollIntoView({ block: 'center' });
      if (state.drawerJob != null) syncDrawer(true);
    } catch (err) {
      el.newError.textContent = 'Could not create job: ' + (err.message || err);
      el.newError.hidden = false;
      el.newSubmit.disabled = false;
      updateSubmitLabel();
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
    $('new-btn').addEventListener('click', () => openNew());
    $('add-project').addEventListener('click', () => { addProjectRow().querySelector('select').focus(); });
    el.projects.addEventListener('click', (e) => {
      const b = e.target.closest('.remove-project');
      if (!b || el.projects.children.length < 2) return;
      b.closest('.project-row').remove();
      updateSubmitLabel();
    });
    el.newForm.elements.customer.addEventListener('change', fillKnownCustomer);
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
      const of = e.target.closest('[data-order-filter]');
      if (of) {
        e.stopPropagation();
        el.search.value = '#' + of.dataset.orderFilter;
        readFilters();
        render();
        return;
      }
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
    el.drawerBody.addEventListener('click', (e) => { if (e.target.closest('#drawer-order')) onDrawerOrderClick(e); });
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
