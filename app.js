// Signs & Stitches Production Board - app state, rendering and interactions.
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
    { key: 'order', label: 'Order #' },
    { key: 'files', label: 'Files', kind: 'long' }
  ];
  const LABEL = {};
  FIELDS.forEach((f) => { LABEL[f.key] = f.label; });
  window.FIELD_LABELS = LABEL;
  const TRACK = FIELDS.filter((f) => f.track).map((f) => f.key);
  const REQUIRED = ['customer', 'type', 'due'];
  const CLOSED = ['Complete', 'Dead'];

  // The production line a job moves along, left to right.
  // Delivery counts as done once the job is Complete (picked up / shipped).
  const STEPS = ['estimate', 'material', 'artwork', 'production', 'delivery'];

  // Category pills. Project types that match none of these fall under "Other".
  const CATEGORIES = [
    { id: 'embroidery', label: 'Embroidery', test: (t) => /^embroidery/i.test(t) },
    { id: 'screen', label: 'Screen Print', test: (t) => /screen ?print/i.test(t) },
    { id: 'signs', label: 'Signs', test: (t) => /sign/i.test(t) },
    { id: 'vehicle', label: 'Vehicle', test: (t) => /vehicle/i.test(t) },
    { id: 'promo', label: 'Promo', test: (t) => /^promo/i.test(t) }
  ];

  // Chip colours. Options not listed here (added later in the sheet) show grey.
  const CHIP_TONE = {
    Approved: 'green', Received: 'green', Digitized: 'green', Finished: 'green', 'Paid in Full': 'green', Complete: 'green',
    Sent: 'amber', Ordered: 'amber', 'Sent to Customer': 'amber', Working: 'amber', Billed: 'amber',
    'Being Designed': 'amber',
    Waiting: 'red', 'On Hold': 'red',
    'In Queue': 'blue', Active: 'blue', 'Pick-Up': 'blue', Ship: 'blue', Courier: 'blue',
    'Not Sent': 'grey',
    Dead: 'dead'
  };

  const POLL_MS = 20000;
  const SOON_DAYS = 3;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WIDE = '(min-width: 1280px)';
  const PHONE = '(max-width: 767px)';

  /* ------------------------------------------------------------ State */

  const state = {
    jobs: [],
    lists: { types: [], options: {} },
    rules: [],
    view: 'open',
    filters: { q: '', cat: '', quick: '', field: '', value: '', sort: 'due' },
    selected: new Set(),
    pending: new Map(), // "job|field" -> { value, token } for saves in flight
    loaded: false,
    loading: false,
    lastSync: null,
    syncError: null,
    drawerJob: null,
    panelTab: 'details',
    editing: false,
    activity: { job: null, items: [] },
    picker: null, // { anchor, items, onPick } plus { job, field } for a field picker
    newLinkTo: 0 // when adding a project to an existing order
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    sync: $('sync'), tableWrap: $('table-wrap'), cards: $('cards'), empty: $('empty'),
    search: $('f-search'), sort: $('f-sort'), pills: $('pills'), stats: $('stats'),
    fieldsBtn: $('fields-btn'), fieldsLabel: $('fields-label'), activeFilters: $('active-filters'),
    picker: $('picker'), pickerTitle: $('picker-title'), pickerOptions: $('picker-options'),
    pickerBackdrop: $('picker-backdrop'), panel: $('panel'), panelBackdrop: $('panel-backdrop'),
    panelBody: $('panel-body'), panelTitle: $('panel-title'), bulk: $('bulk'), bulkCount: $('bulk-count'),
    newDialog: $('new-dialog'), newForm: $('new-form'), newError: $('new-error'), newSubmit: $('new-submit'),
    newTitle: $('new-title'), newNote: $('new-note'), projects: $('projects'), customers: $('customer-list'),
    toasts: $('toasts')
  };

  /* ------------------------------------------------------------ Utilities */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const ICONS = {
    chevron: '<path d="m9 6 6 6-6 6"/>',
    caret: '<path d="m6 9 6 6 6-6"/>',
    dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    list: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6M12 16.5v.01"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
    note: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
  };
  const icon = (name, cls) => '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';

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

  function fmtDay(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtValue(key, v) {
    const f = FIELDS.find((x) => x.key === key);
    if (f && f.kind === 'date') return fmtDate(v);
    if (f && f.kind === 'stamp') return fmtStamp(v);
    return v == null ? '' : String(v);
  }

  function initials(name) {
    const words = String(name || '').replace(/^SAMPLE\s*-\s*/i, '').split(/[\s-]+/).filter((w) => /[a-z0-9]/i.test(w));
    return ((words[0] || '?')[0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  function findJob(no) {
    return state.jobs.find((j) => j.job === Number(no));
  }

  function isClosed(job) {
    return CLOSED.includes(job.status);
  }

  function dueFlag(job) {
    if (isClosed(job) || !job.due) return '';
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

  function allowed(job, field, keepCurrent) {
    return window.Options.allowedOptions(field, job.type, state.lists, state.rules, keepCurrent === false ? '' : job[field]);
  }

  function category(type) {
    const c = CATEGORIES.find((x) => x.test(String(type || '')));
    return c ? c.id : 'other';
  }

  /* ------------------------------------------------------------ Production steps */

  // A step is done when it reaches the last option it offers for this project type
  // (e.g. Artwork is done at Approved, or at Digitized for embroidery).
  function stepInfo(job, key) {
    if (key === 'delivery') {
      return { key, value: job.delivery || '', done: job.status === 'Complete' };
    }
    const value = job[key] || '';
    const opts = allowed(job, key, false);
    const done = !!value && (value === opts[opts.length - 1] || value === 'Digitized');
    return { key, value, done };
  }

  function steps(job) {
    const list = STEPS.map((k) => stepInfo(job, k));
    const cur = list.findIndex((s) => !s.done);
    list.forEach((s, i) => { s.current = i === cur; });
    return list;
  }

  function currentStep(job) {
    return steps(job).find((s) => s.current) || null;
  }

  function health(job) {
    if (job.status === 'Dead') return 'dead';
    if (job.status === 'Complete') return 'green';
    if (job.status === 'On Hold' || dueFlag(job) === 'overdue') return 'red';
    if (dueFlag(job) === 'soon') return 'amber';
    return 'green';
  }

  function needsAttention(job) {
    return !isClosed(job) && (dueFlag(job) === 'overdue' || job.status === 'On Hold' ||
      TRACK.some((k) => job[k] === 'Waiting'));
  }

  function readyForPickup(job) {
    return !isClosed(job) && job.production === 'Finished';
  }

  // The short state shown in the Status column, and the field a tap on it edits.
  function statusPill(job) {
    if (job.status === 'Dead') return { text: 'Dead', tone: 'dead', field: 'status' };
    if (job.status === 'Complete') return { text: 'Complete', tone: 'green', field: 'status' };
    if (job.status === 'On Hold') return { text: 'On Hold', tone: 'red', field: 'status' };
    if (readyForPickup(job)) {
      const how = { Ship: 'Ready to Ship', Courier: 'Ready for Courier' }[job.delivery] || 'Ready for Pickup';
      return { text: how, tone: 'green', field: 'status' };
    }
    const cur = currentStep(job);
    if (!cur) return { text: job.status || 'Active', tone: 'blue', field: 'status' };
    if (!cur.value) return { text: LABEL[cur.key] + ' not started', tone: 'blank', field: cur.key };
    return { text: cur.value, tone: CHIP_TONE[cur.value] || 'grey', field: cur.key };
  }

  // What "Mark Next Step" would do, or null if there is nothing left.
  function nextMove(job) {
    if (isClosed(job)) return null;
    const cur = currentStep(job);
    if (!cur) return null;
    if (cur.key === 'delivery') return { field: 'status', value: 'Complete', label: 'Mark Complete' };
    const opts = allowed(job, cur.key, false);
    const value = opts[opts.indexOf(cur.value) + 1];
    if (!value) return null;
    return { field: cur.key, value, label: LABEL[cur.key] + ': ' + value };
  }

  function markNextStep(jobNo) {
    const job = findJob(jobNo);
    const move = job && nextMove(job);
    if (!move) { toast('Nothing left to do on job ' + jobNo); return Promise.resolve(false); }
    return setField(job.job, move.field, move.value);
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

  function orderText(info) {
    return 'Order ' + info.order + ' - ' + (info.ready === info.total ? 'all ' + info.total + ' ready' : info.ready + ' of ' + info.total + ' ready');
  }

  function orderBadge(j) {
    const info = orderInfo(j);
    if (!info) return '';
    const all = info.ready === info.total;
    return '<button type="button" class="order-badge ' + (all ? 'order-ready' : 'order-waiting') +
      '" data-order-filter="' + info.order + '" title="Show every project in this order">' +
      icon('link') + esc(orderText(info)) + '</button>';
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
      state.loaded = true;
      [...state.selected].forEach((n) => { if (!findJob(n)) state.selected.delete(n); });
      render();
      if (state.drawerJob != null) renderPanel();
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
      el.sync.textContent = 'Updated ' + state.lastSync.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        ' - refreshes every 20 seconds';
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
      if (saved) mergeJobs([saved]);
      render();
      if (state.drawerJob === jobNo) { renderPanel(); loadActivity(jobNo); }
      return true;
    } catch (err) {
      if (state.pending.get(key) && state.pending.get(key).token === token) {
        state.pending.delete(key);
        const j = findJob(jobNo);
        if (j) j[field] = old;
      }
      toast('Could not save ' + LABEL[field] + ' for job ' + jobNo + ': ' + (err.message || err), 'error');
      render();
      if (state.drawerJob === jobNo) renderPanel(true);
      return false;
    }
  }

  function afterLocalChange(job, field, old) {
    render();
    if (field === 'status' && CLOSED.includes(job.status) !== CLOSED.includes(old)) {
      toast('Job ' + job.job + (isClosed(job) ? ' moved to Completed' : ' reopened'));
    }
    if ((field === 'production' && job.production === 'Finished') || (field === 'status' && job.status === 'Complete')) {
      warnAboutOrder(job);
    }
    if (state.drawerJob === job.job) renderPanel();
  }

  /* ------------------------------------------------------------ Filtering */

  function inView(j) {
    return state.view === 'open' ? !isClosed(j) : isClosed(j);
  }

  function matches(job, skip) {
    const f = state.filters;
    if (skip !== 'cat' && f.cat && category(job.type) !== f.cat) return false;
    if (f.quick) {
      if (f.quick === 'attention' && !needsAttention(job)) return false;
      if (f.quick === 'today' && daysFromToday(job.due) !== 0) return false;
      if (f.quick === 'ready' && !readyForPickup(job)) return false;
    }
    if (f.field && f.value) {
      const v = job[f.field] || '';
      if (f.value === '__blank__' ? v !== '' : v !== f.value) return false;
    }
    if (f.q) {
      const hay = [job.job, job.customer, job.description, job.contact, job.type].join(' ').toLowerCase();
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

  function visibleJobs() {
    const open = state.view === 'open';
    const list = state.jobs.filter(inView).filter((j) => matches(j));
    const sort = state.filters.sort;
    if (sort === 'job') return list.sort((a, b) => (open ? a.job - b.job : b.job - a.job));
    if (sort === 'customer') return list.sort((a, b) => String(a.customer).localeCompare(String(b.customer)) || a.job - b.job);
    if (sort === 'updated') return list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.job - a.job);

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
    return list.sort((a, b) =>
      dir * groupDue(a).localeCompare(groupDue(b)) ||
      dir * (groupId(a) - groupId(b)) ||
      dir * dueKey(a).localeCompare(dueKey(b)) ||
      dir * (a.job - b.job));
  }

  /* ------------------------------------------------------------ Rendering: board */

  function stepper(job, opts) {
    const tone = health(job);
    const list = steps(job);
    return '<div class="stepper stepper-' + tone + (opts && opts.big ? ' stepper-big' : '') + '" role="list" aria-label="Production steps">' +
      list.map((s, i) => {
        const st = s.done ? 'done' : s.current ? 'current' : 'todo';
        const title = LABEL[s.key] + ': ' + (s.value || 'not started') + (s.done ? ' (done)' : s.current ? ' (next up)' : '');
        return '<button type="button" role="listitem" class="step step-' + st + (i && list[i - 1].done ? ' step-after-done' : '') +
          '" data-chip="' + s.key + '" data-job="' + job.job + '" title="' + esc(title) + '" aria-label="' + esc(title + '. Change') + '">' +
          '<span class="dot"></span><span class="step-label">' + esc(LABEL[s.key]) + '</span></button>';
      }).join('') + '</div>';
  }

  function pill(job) {
    const p = statusPill(job);
    const pending = state.pending.has(job.job + '|' + p.field) ? ' is-pending' : '';
    return '<button type="button" class="pill pill-' + p.tone + pending + '" data-chip="' + p.field + '" data-job="' + job.job +
      '" aria-label="' + esc('Status: ' + p.text + '. Change ' + LABEL[p.field]) + '">' + esc(p.text) + '</button>';
  }

  function dueCell(job) {
    const flag = dueFlag(job);
    const note = dueNote(job);
    return '<span class="due' + (flag ? ' due-' + flag : '') + '"><span class="due-date">' + esc(fmtDate(job.due) || '-') + '</span>' +
      (note ? '<span class="due-note">' + esc(note) + '</span>' : '') + '</span>';
  }

  function avatar(name) {
    return '<span class="avatar" aria-hidden="true">' + esc(initials(name)) + '</span>';
  }

  // A save triggered by blur (e.g. clicking a tab after typing) must not redraw the
  // button being clicked, or the click is lost. Hold redraws until the click lands.
  const deferred = { down: false, board: false, panel: false };

  function render() {
    if (!state.loaded) return;
    if (deferred.down) { deferred.board = true; return; }
    renderCounts();
    renderStats();
    renderPills();
    renderActiveFilters();

    const jobs = visibleJobs();
    const allChecked = jobs.length && jobs.every((j) => state.selected.has(j.job));

    const head = '<tr>' +
      '<th class="col-check"><input type="checkbox" id="check-all" aria-label="Select all shown jobs"' + (allChecked ? ' checked' : '') + '></th>' +
      '<th class="col-job">Job #</th><th class="col-customer">Customer</th><th class="col-desc">Description</th>' +
      '<th class="col-stage">Stage</th><th class="col-due">Due Date</th><th class="col-status">Status</th><th class="col-go"><span class="sr">Open</span></th></tr>';

    const rows = jobs.map((j) => {
      const cls = ['row', 'row-' + health(j)];
      if (j.status === 'Dead') cls.push('row-dead');
      if (state.drawerJob === j.job) cls.push('is-selected');
      if (orderInfo(j)) cls.push('row-linked');
      return '<tr class="' + cls.join(' ') + '" data-job="' + j.job + '">' +
        '<td class="col-check"><input type="checkbox" data-check="' + j.job + '" aria-label="Select job ' + j.job + '"' +
          (state.selected.has(j.job) ? ' checked' : '') + '></td>' +
        '<td class="col-job"><span class="job-no">' + j.job + '</span>' +
          '<button type="button" class="row-menu" data-row-menu="' + j.job + '" aria-label="Actions for job ' + j.job + '">' + icon('dots') + '</button></td>' +
        '<td class="col-customer"><div class="who">' + avatar(j.customer) + '<div class="who-text">' +
          '<button type="button" class="open-job" data-open="' + j.job + '">' + esc(j.customer || '(no customer)') + '</button>' +
          (j.contact ? '<span class="sub">' + esc(j.contact) + '</span>' : '') + '</div></div></td>' +
        '<td class="col-desc"><span class="desc">' + esc(j.description || '-') + '</span>' +
          '<span class="sub">' + esc(j.type) + '</span>' + orderBadge(j) + '</td>' +
        '<td class="col-stage">' + stepper(j) + '</td>' +
        '<td class="col-due">' + dueCell(j) + '</td>' +
        '<td class="col-status">' + pill(j) + '</td>' +
        '<td class="col-go"><button type="button" class="go" data-open="' + j.job + '" aria-label="Open job ' + j.job + '">' + icon('chevron') + '</button></td>' +
        '</tr>';
    }).join('');

    el.tableWrap.innerHTML = jobs.length
      ? '<table class="jobs"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>' : '';

    el.cards.innerHTML = jobs.map((j) => {
      const cls = ['card', 'card-' + health(j)];
      if (j.status === 'Dead') cls.push('card-dead');
      return '<article class="' + cls.join(' ') + '" data-job="' + j.job + '">' +
        '<button type="button" class="card-head open-job" data-open="' + j.job + '">' +
          avatar(j.customer) +
          '<span class="card-main"><span class="card-top"><span class="card-customer">' + esc(j.customer || '(no customer)') + '</span>' +
          '<span class="card-no">#' + j.job + '</span></span>' +
          '<span class="card-desc">' + esc(j.description || j.type) + '</span>' +
          '<span class="card-meta">' + esc(j.type) + '</span></span>' +
        '</button>' +
        (orderInfo(j) ? '<div class="card-order">' + orderBadge(j) + '</div>' : '') +
        '<div class="card-stage">' + stepper(j) + '</div>' +
        '<div class="card-foot">' + dueCell(j) + pill(j) + '</div>' +
      '</article>';
    }).join('');

    const total = state.jobs.filter(inView).length;
    el.empty.hidden = jobs.length > 0;
    el.empty.textContent = total === 0
      ? (state.view === 'open' ? 'No open jobs. Press New Job to add one.' : 'No completed jobs yet.')
      : 'No jobs match these filters.';

    renderBulk();

    // A refresh replaced the chips; keep the open picker tied to the new one.
    if (state.picker && state.picker.job != null) {
      const sel = '[data-chip="' + state.picker.field + '"][data-job="' + state.picker.job + '"]';
      const next = [...document.querySelectorAll(sel)].find((n) => n.offsetParent);
      if (next) state.picker.anchor = next;
    }
  }

  function renderCounts() {
    const open = state.jobs.filter((j) => !isClosed(j)).length;
    $('count-open').textContent = open;
    $('count-closed').textContent = state.jobs.length - open;
  }

  function renderStats() {
    const open = state.jobs.filter((j) => !isClosed(j));
    const cards = [
      { id: '', tone: 'neutral', icon: 'list', title: 'Open Jobs', n: open.length, sub: 'Total in production' },
      { id: 'attention', tone: 'red', icon: 'alert', title: 'Needs Attention', n: open.filter(needsAttention).length, sub: 'Waiting, on hold, or overdue' },
      { id: 'today', tone: 'amber', icon: 'calendar', title: 'Due Today', n: open.filter((j) => daysFromToday(j.due) === 0).length, sub: 'Jobs due today' },
      { id: 'ready', tone: 'green', icon: 'check', title: 'Ready for Pickup', n: open.filter(readyForPickup).length, sub: 'Finished, awaiting pickup' }
    ];
    el.stats.innerHTML = cards.map((c) => {
      const active = !!c.id && state.view === 'open' && state.filters.quick === c.id;
      return '<button type="button" class="stat stat-' + c.tone + (active ? ' is-active' : '') + '" data-quick="' + c.id +
        '" aria-pressed="' + active + '">' +
        '<span class="stat-icon">' + icon(c.icon) + '</span>' +
        '<span class="stat-text"><span class="stat-title">' + c.title + '</span>' +
        '<span class="stat-n" data-stat="' + (c.id || 'open') + '">' + c.n + '</span>' +
        '<span class="stat-sub">' + c.sub + '</span></span>' + icon('chevron', 'stat-go') + '</button>';
    }).join('');
  }

  function renderPills() {
    const pool = state.jobs.filter(inView).filter((j) => matches(j, 'cat'));
    const count = (id) => pool.filter((j) => !id || category(j.type) === id).length;
    const pills = [{ id: '', label: 'All' }].concat(CATEGORIES, [{ id: 'other', label: 'Other' }]);
    el.pills.innerHTML = pills
      .filter((p) => p.id !== 'other' || state.jobs.some((j) => category(j.type) === 'other'))
      .map((p) => '<button type="button" class="cat' + (state.filters.cat === p.id ? ' is-active' : '') + '" data-cat="' + p.id +
        '" aria-pressed="' + (state.filters.cat === p.id) + '">' + esc(p.label) + ' <span class="cat-n">' + count(p.id) + '</span></button>')
      .join('');
  }

  function renderActiveFilters() {
    const f = state.filters;
    el.fieldsLabel.textContent = f.field && f.value
      ? LABEL[f.field] + ': ' + (f.value === '__blank__' ? 'Not set' : f.value) : 'All Fields';
    el.fieldsBtn.classList.toggle('is-active', !!(f.field && f.value));
    const bits = [];
    if (f.quick) bits.push({ k: 'quick', t: { attention: 'Needs Attention', today: 'Due Today', ready: 'Ready for Pickup' }[f.quick] });
    if (f.q) bits.push({ k: 'q', t: 'Search: ' + f.q });
    if (f.field && f.value) bits.push({ k: 'field', t: el.fieldsLabel.textContent });
    el.activeFilters.hidden = !bits.length;
    el.activeFilters.innerHTML = bits.map((b) => '<button type="button" class="chip-filter" data-clear="' + b.k + '">' + esc(b.t) +
      ' <span aria-hidden="true">x</span><span class="sr">Remove filter</span></button>').join('') +
      (bits.length > 1 ? '<button type="button" class="link-btn" data-clear="all">Clear all</button>' : '');
  }

  function renderBulk() {
    const n = state.selected.size;
    el.bulk.hidden = !n;
    el.bulkCount.textContent = n + (n === 1 ? ' job selected' : ' jobs selected');
  }

  /* ------------------------------------------------------------ Picker / menus */

  // items: [{ label, value, tone, current, ... }]; onPick(item) runs after the menu closes.
  function openMenu(anchor, title, items, onPick, ctx) {
    closePicker(true);
    state.picker = Object.assign({ anchor, onPick, items }, ctx || {});
    el.pickerTitle.textContent = title;
    el.pickerOptions.innerHTML = items.map((it, i) =>
      '<button type="button" class="' + (it.tone ? 'pill pill-' + it.tone : 'menu-item') + (it.current ? ' is-current' : '') +
      '" data-pick="' + i + '"' + (it.value != null ? ' data-value="' + esc(it.value) + '"' : '') + '>' + esc(it.label) + '</button>').join('');
    el.picker.hidden = false;
    el.pickerBackdrop.hidden = false;
    positionPicker(anchor);
    const first = el.pickerOptions.querySelector('.is-current') || el.pickerOptions.querySelector('button');
    if (first) first.focus();
  }

  function openFieldPicker(jobNo, field, anchor) {
    const job = findJob(jobNo);
    if (!job) return;
    const items = allowed(job, field).map((o) => ({ label: o, value: o, tone: CHIP_TONE[o] || 'grey', current: o === job[field] }))
      .concat([{ label: 'Not set', value: '', tone: 'blank', current: !job[field] }]);
    openMenu(anchor, LABEL[field] + ' - ' + job.customer, items, (it) => setField(jobNo, field, it.value), { job: jobNo, field });
  }

  function positionPicker(anchor) {
    if (window.matchMedia(PHONE).matches || !anchor) {
      el.picker.style.left = el.picker.style.top = '';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const pw = el.picker.offsetWidth;
    const ph = el.picker.offsetHeight;
    const left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    el.picker.style.left = Math.max(8, left) + 'px';
    el.picker.style.top = top + 'px';
  }

  function closePicker(silent) {
    if (!state.picker) return;
    const p = state.picker;
    state.picker = null;
    el.picker.hidden = true;
    el.pickerBackdrop.hidden = true;
    if (!silent && p.anchor && p.anchor.isConnected && p.anchor.offsetParent) p.anchor.focus({ preventScroll: true });
  }

  function rowMenu(jobNo, anchor) {
    const job = findJob(jobNo);
    if (!job) return;
    const move = nextMove(job);
    const items = [{ label: 'Open details', act: 'open' }];
    if (move) items.push({ label: 'Mark next step (' + move.label + ')', act: 'next' });
    if (job.status === 'On Hold') items.push({ label: 'Take off hold', act: 'status', value: 'Active' });
    else if (!isClosed(job)) items.push({ label: 'Put on hold', act: 'status', value: 'On Hold' });
    if (!isClosed(job)) items.push({ label: 'Mark complete', act: 'status', value: 'Complete' }, { label: 'Mark dead (quote lost)', act: 'status', value: 'Dead' });
    else items.push({ label: 'Reopen', act: 'status', value: 'Active' });
    openMenu(anchor, 'Job #' + jobNo + ' - ' + job.customer, items, (it) => {
      if (it.act === 'open') openPanel(jobNo);
      if (it.act === 'next') markNextStep(jobNo);
      if (it.act === 'status') setField(jobNo, 'status', it.value);
    });
  }

  /* ------------------------------------------------------------ Job panel */

  function openPanel(jobNo) {
    if (!findJob(jobNo)) return;
    closePicker(true);
    const switching = state.drawerJob !== jobNo;
    state.drawerJob = jobNo;
    if (switching) { state.panelTab = 'details'; state.editing = false; state.activity = { job: jobNo, items: [], loading: true }; }
    renderPanel(true);
    el.panel.hidden = false;
    document.body.classList.add('panel-open');
    const docked = window.matchMedia(WIDE).matches;
    el.panelBackdrop.hidden = docked;
    document.body.classList.toggle('no-scroll', !docked);
    requestAnimationFrame(() => el.panel.classList.add('is-open'));
    render();
    if (switching) loadActivity(jobNo);
    if (!docked) $('panel-close').focus();
  }

  function closePanel() {
    if (state.drawerJob == null) return;
    const no = state.drawerJob;
    const active = document.activeElement;
    if (active && active.dataset && active.dataset.field) active.blur(); // commits a pending text edit
    state.drawerJob = null;
    state.editing = false;
    el.panel.classList.remove('is-open');
    el.panelBackdrop.hidden = true;
    document.body.classList.remove('no-scroll', 'panel-open');
    el.panel.hidden = true;
    render();
    const back = [...document.querySelectorAll('[data-open="' + no + '"]')].find((n) => n.offsetParent);
    if (back) back.focus({ preventScroll: true });
  }

  function lastChange(label, value) {
    const hit = state.activity.items.find((a) => a.field === label && (value == null || a.newValue === value));
    return hit ? fmtDay(hit.at) : '';
  }

  function progressRows(job) {
    const list = steps(job);
    const pay = job.payment || '';
    const rows = list.map((s) => ({
      key: s.key, label: LABEL[s.key], value: s.value, state: s.done ? 'done' : s.current ? 'current' : 'todo',
      date: s.done ? (s.key === 'delivery' ? lastChange('Status', 'Complete') : lastChange(LABEL[s.key], s.value)) : ''
    }));
    rows.push({ key: 'payment', label: 'Payment', value: pay, state: pay === 'Paid in Full' ? 'done' : pay ? 'current' : 'todo',
      date: pay === 'Paid in Full' ? lastChange('Payment', pay) : '' });
    return rows.map((r) =>
      '<li class="prog prog-' + r.state + '"><span class="prog-mark" aria-hidden="true"></span>' +
      '<span class="prog-label">' + esc(r.label) + '</span>' +
      '<button type="button" class="prog-value" data-chip="' + r.key + '" data-job="' + job.job + '" aria-label="' +
        esc(r.label + ': ' + (r.value || 'not set') + '. Change') + '">' + esc(r.value || '-') + '</button>' +
      '<span class="prog-date">' + esc(r.date) + '</span></li>').join('');
  }

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
    if (f.kind === 'long') return '<textarea' + attrs + ' rows="' + (f.rows || 3) + '">' + esc(v) + '</textarea>';
    const type = { date: 'date', number: 'number', tel: 'tel', email: 'email' }[f.kind] || 'text';
    return '<input type="' + type + '"' + attrs + ' value="' + esc(v) + '" autocomplete="off">';
  }

  function fieldGroup(job, keys) {
    return keys.map((k) => {
      const f = FIELDS.find((x) => x.key === k);
      const wide = f.kind === 'long' || k === 'customer' || k === 'email' ? ' span-2' : '';
      return '<label class="field' + wide + '" for="d-' + k + '">' + esc(f.label) +
        (REQUIRED.includes(k) ? ' <span class="req">required</span>' : '') +
        (f.kind === 'date' ? '<span class="date-says" data-says="' + k + '"></span>' : '') + inputFor(f, job) + '</label>';
    }).join('');
  }

  function fileLinks(job) {
    return String(job.files || '').split(/\n+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  }

  // Re-draws the panel. While someone is typing in it, only the other inputs are refreshed.
  function renderPanel(force) {
    if (!force && deferred.down) { deferred.panel = true; return; }
    const job = findJob(state.drawerJob);
    if (!job) { if (state.drawerJob != null) closePanel(); return; }
    const focused = document.activeElement;
    if (!force && focused && el.panelBody.contains(focused) && focused.dataset.field) {
      patchPanelInputs(job, focused);
      return;
    }
    el.panelTitle.textContent = 'Job #' + job.job;
    el.panel.classList.toggle('panel-dead', job.status === 'Dead');
    const move = nextMove(job);
    const info = orderInfo(job);
    const tab = state.panelTab;
    const flag = dueFlag(job);
    const tabs = [['details', 'Details'], ['files', 'Files'], ['notes', 'Notes'], ['history', 'History']];

    let body = '';
    if (tab === 'details' && state.editing) {
      body =
        '<h3 class="section-title">Job</h3><div class="form-grid">' + fieldGroup(job, ['customer', 'type', 'dateIn', 'due', 'description']) + '</div>' +
        '<h3 class="section-title">Tracking</h3><div class="form-grid">' + fieldGroup(job, TRACK) + '</div>' +
        '<h3 class="section-title">Contact</h3><div class="form-grid">' + fieldGroup(job, ['contact', 'phone', 'email']) + '</div>' +
        '<p class="stamps">' + esc((job.createdAt ? 'Created ' + fmtStamp(job.createdAt) : '') +
          (job.updatedAt ? ' - Last changed ' + fmtStamp(job.updatedAt) : '')) + '</p>';
    } else if (tab === 'details') {
      body =
        '<dl class="info card-box">' +
          '<dt>Project Type</dt><dd>' + esc(job.type || '-') + '</dd>' +
          '<dt>Description</dt><dd>' + esc(job.description || '-') + '</dd>' +
          '<dt>Order Info</dt><dd>' + (info ? esc(orderText(info)) : 'On its own') + '</dd>' +
          '<dt>Date In</dt><dd>' + esc(fmtDate(job.dateIn) || '-') + '</dd>' +
        '</dl>' +
        '<section class="drawer-order card-box" id="drawer-order" aria-label="Linked projects">' + drawerOrder(job) + '</section>' +
        '<section class="card-box progress"><h3 class="box-title">Production Progress</h3>' + stepper(job, { big: true }) +
          '<ul class="prog-list">' + progressRows(job) + '</ul></section>' +
        '<div class="mini-cards">' +
          '<button type="button" class="mini mini-due' + (flag ? ' mini-' + flag : '') + '" data-act="edit-due">' + icon('calendar') +
            '<span><span class="mini-label">Due Date</span><span class="mini-value">' + esc(fmtDate(job.due) || '-') + '</span>' +
            (dueNote(job) ? '<span class="mini-note">' + esc(dueNote(job)) + '</span>' : '') + '</span></button>' +
          (info
            ? '<div class="mini">' + icon('layers') + '<span><span class="mini-label">Order</span><span class="mini-value">' +
              info.ready + ' / ' + info.total + '</span><span class="mini-note">ready</span></span></div>'
            : '<button type="button" class="mini" data-chip="payment" data-job="' + job.job + '">' + icon('layers') +
              '<span><span class="mini-label">Payment</span><span class="mini-value">' + esc(job.payment || 'Not set') + '</span></span></button>') +
        '</div>' +
        '<button type="button" class="card-box notes-box" data-tab="notes">' + icon('note') +
          '<span><span class="box-title">Notes</span><span class="notes-text">' + esc(job.notes || 'No notes yet. Tap to add one.') + '</span></span></button>';
    } else if (tab === 'files') {
      const links = fileLinks(job);
      body = '<p class="muted small">Link art and proof files (Google Drive, Dropbox, and so on). Paste a link and press Add.</p>' +
        '<ul class="files">' + (links.length ? links.map((u, i) =>
          '<li><a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + icon('link') + '<span>' + esc(u.replace(/^https?:\/\/(www\.)?/i, '')) + '</span></a>' +
          '<button type="button" class="btn btn-ghost btn-small" data-remove-file="' + i + '">Remove</button></li>').join('')
          : '<li class="muted">No files linked yet.</li>') + '</ul>' +
        '<div class="add-file"><input class="input" id="file-url" type="url" placeholder="https://..." aria-label="File link">' +
        '<button type="button" class="btn btn-primary" data-act="add-file">Add</button></div>';
    } else if (tab === 'notes') {
      body = '<label class="field" for="d-notes">Notes' + inputFor({ key: 'notes', kind: 'long', rows: 10 }, job) + '</label>' +
        '<p class="muted small">Saves when you click away.</p>';
    } else {
      body = '<ol class="activity" id="activity">' + activityItems() + '</ol>';
    }

    el.panelBody.innerHTML =
      '<div class="who-big">' + avatar(job.customer) + '<div>' +
        '<div class="who-name">' + esc(job.customer || '(no customer)') + '</div>' +
        (job.contact ? '<div class="who-line">' + esc(job.contact) + '</div>' : '') +
        (job.phone ? '<div class="who-line"><a href="tel:' + esc(job.phone.replace(/[^\d+]/g, '')) + '">' + esc(job.phone) + '</a></div>' : '') +
        (job.email ? '<div class="who-line"><a href="mailto:' + esc(job.email) + '">' + esc(job.email) + '</a></div>' : '') +
      '</div></div>' +
      '<div class="panel-actions">' +
        '<div class="split">' +
          '<button type="button" class="btn btn-primary" data-act="next"' + (move ? ' title="' + esc(move.label) + '"' : ' disabled') + '>' +
            (move ? 'Mark Next Step' : 'All Steps Done') + '</button>' +
          '<button type="button" class="btn btn-primary split-caret" data-act="steps" aria-label="Choose a step to update">' + icon('caret') + '</button>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost" data-act="edit">' + (state.editing ? 'Done Editing' : 'Edit Job') + '</button>' +
      '</div>' +
      (move ? '<p class="next-hint">Next: ' + esc(move.label) + '</p>' : '') +
      '<div class="panel-tabs" role="tablist">' + tabs.map(([k, t]) =>
        '<button type="button" role="tab" class="ptab" data-tab="' + k + '" aria-selected="' + (tab === k) + '">' + t + '</button>').join('') + '</div>' +
      '<div class="panel-content">' + body + '</div>';
    showDates(el.panelBody, job);
  }

  function patchPanelInputs(job, focused) {
    el.panelBody.querySelectorAll('[data-field]').forEach((input) => {
      if (input === focused) return;
      input.value = job[input.dataset.field] == null ? '' : job[input.dataset.field];
    });
  }

  function activityItems() {
    if (state.activity.loading && !state.activity.items.length) return '<li class="muted">Loading...</li>';
    if (state.activity.error) return '<li class="muted">Could not load history.</li>';
    if (!state.activity.items.length) return '<li class="muted">No changes recorded yet.</li>';
    return state.activity.items.map((a) =>
      '<li><span class="act-when">' + esc(fmtStamp(a.at)) + '</span>' +
      '<span class="act-what"><strong>' + esc(a.field) + '</strong> ' +
      (a.field === 'Created' ? esc(a.newValue)
        : esc(a.oldValue || 'Not set') + ' <span class="arrow" aria-label="changed to">to</span> ' + esc(a.newValue || 'Not set')) +
      '</span></li>').join('');
  }

  async function loadActivity(jobNo) {
    try {
      const items = await window.API.activity(jobNo);
      if (state.drawerJob !== jobNo) return;
      state.activity = { job: jobNo, items };
    } catch (err) {
      if (state.drawerJob !== jobNo) return;
      state.activity = { job: jobNo, items: [], error: true };
    }
    renderPanel();
  }

  function drawerOrder(job) {
    const info = orderInfo(job);
    const addBtn = '<button type="button" class="btn btn-ghost btn-small" data-act="add-to-order">' +
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
        '<button type="button" class="btn btn-ghost btn-small" data-act="unlink">Unlink this job</button></div>';
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
    const cur = currentStep(m);
    const hold = m.status === 'On Hold' ? 'On Hold - ' : '';
    if (!cur) return hold + statusPill(m).text;
    return hold + LABEL[cur.key] + ': ' + (cur.value || 'not started');
  }

  function sameCustomer(a, b) {
    return String(a.customer).trim().toLowerCase() === String(b.customer).trim().toLowerCase();
  }

  async function linkTo(jobNo, to) {
    try {
      const jobs = await window.API.linkJob(jobNo, to);
      mergeJobs(jobs);
      render();
      if (state.drawerJob === jobNo) { renderPanel(true); loadActivity(jobNo); }
      toast('Job ' + jobNo + ' linked to order ' + orderOf(findJob(jobNo)));
    } catch (err) {
      toast('Could not link job ' + jobNo + ': ' + (err.message || err), 'error');
      if (state.drawerJob === jobNo) renderPanel(true);
    }
  }

  function onPanelClick(e) {
    const job = findJob(state.drawerJob);
    if (!job) return;
    const chipBtn = e.target.closest('[data-chip]');
    if (chipBtn) { openFieldPicker(job.job, chipBtn.dataset.chip, chipBtn); return; }
    const mate = e.target.closest('[data-mate]');
    if (mate) { openPanel(Number(mate.dataset.mate)); return; }
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.panelTab = tabBtn.dataset.tab;
      if (state.panelTab !== 'details') state.editing = false;
      renderPanel(true);
      if (state.panelTab === 'notes') { const n = $('d-notes'); if (n) n.focus(); }
      return;
    }
    const rm = e.target.closest('[data-remove-file]');
    if (rm) {
      const links = fileLinks(job);
      links.splice(Number(rm.dataset.removeFile), 1);
      setField(job.job, 'files', links.join('\n'));
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act || act.tagName === 'SELECT') return;
    switch (act.dataset.act) {
      case 'next': markNextStep(job.job); break;
      case 'steps': {
        const items = STEPS.concat(['payment', 'status']).map((k) => ({ label: LABEL[k] + ': ' + (job[k] || 'Not set'), field: k }));
        openMenu(act, 'Update a step - Job #' + job.job, items, (it) => {
          const anchor = el.panelBody.querySelector('[data-act="steps"]');
          openFieldPicker(job.job, it.field, anchor);
        });
        break;
      }
      case 'edit':
        state.editing = !state.editing;
        state.panelTab = 'details';
        renderPanel(true);
        if (state.editing) { const c = $('d-customer'); if (c) c.focus(); }
        break;
      case 'edit-due': {
        state.editing = true;
        renderPanel(true);
        const d = $('d-due');
        if (d) d.focus();
        break;
      }
      case 'add-file': {
        const input = $('file-url');
        const url = input.value.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) { toast('Paste a full link starting with https://', 'error'); input.focus(); return; }
        input.value = '';
        input.blur();
        setField(job.job, 'files', fileLinks(job).concat([url]).join('\n'));
        break;
      }
      case 'add-to-order': openNew(job); break;
      case 'unlink':
        setField(job.job, 'order', '').then((ok) => { if (ok) { renderPanel(true); toast('Job ' + job.job + ' unlinked'); } });
        break;
      default:
    }
  }

  function onPanelChange(e) {
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

  // Date inputs follow the browser's locale, so spell the date out Day Month Year beside them.
  function showDates(root, values) {
    root.querySelectorAll('[data-says]').forEach((n) => {
      const src = values ? values[n.dataset.says] : (root.querySelector('[name="' + n.dataset.says + '"]') || {}).value;
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(src || '');
      n.textContent = d ? new Date(+d[1], d[2] - 1, +d[3]).toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + fmtDate(src) : '';
    });
  }

  /* ------------------------------------------------------------ New job */

  // from: an existing job when adding another project to its order (or starting one).
  function openNew(from) {
    closePicker(true);
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
      if (state.drawerJob != null) renderPanel(true);
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

  /* ------------------------------------------------------------ Views & filters */

  function setView(view) {
    state.view = view;
    if (view !== 'open') state.filters.quick = '';
    state.selected.clear();
    document.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.view === view));
    });
    document.body.dataset.view = view;
    render();
  }

  function fieldsFilterMenu(anchor) {
    const items = [{ label: 'All Fields (no filter)', field: '' }]
      .concat(TRACK.map((k) => ({ label: LABEL[k] + '...', field: k })));
    openMenu(anchor, 'Filter by a tracking field', items, (it) => {
      if (!it.field) { state.filters.field = ''; state.filters.value = ''; render(); return; }
      const opts = (state.lists.options[it.field] || []).slice();
      state.jobs.forEach((j) => { if (j[it.field] && !opts.includes(j[it.field])) opts.push(j[it.field]); });
      const values = opts.map((o) => ({ label: o, value: o, tone: CHIP_TONE[o] || 'grey',
        current: state.filters.field === it.field && state.filters.value === o }))
        .concat([{ label: 'Not set', value: '__blank__', tone: 'blank' }]);
      openMenu(el.fieldsBtn, LABEL[it.field] + ' is...', values, (v) => {
        state.filters.field = it.field;
        state.filters.value = v.value;
        render();
      });
    });
  }

  function clearFilter(k) {
    const f = state.filters;
    if (k === 'quick' || k === 'all') f.quick = '';
    if (k === 'q' || k === 'all') { f.q = ''; el.search.value = ''; }
    if (k === 'field' || k === 'all') { f.field = ''; f.value = ''; }
    if (k === 'all') f.cat = '';
    render();
  }

  async function bulk(action, anchor) {
    const jobs = [...state.selected].map(findJob).filter(Boolean);
    if (!jobs.length) return;
    if (action === 'clear') { state.selected.clear(); render(); return; }
    if (action === 'next') {
      const results = await Promise.all(jobs.map((j) => (nextMove(j) ? markNextStep(j.job) : Promise.resolve(false))));
      toast('Moved ' + results.filter(Boolean).length + ' of ' + jobs.length + ' jobs to their next step');
      return;
    }
    if (action === 'status') {
      const items = (state.lists.options.status || []).map((o) => ({ label: o, value: o, tone: CHIP_TONE[o] || 'grey' }));
      openMenu(anchor, 'Set Status for ' + jobs.length + ' jobs', items, (it) => {
        state.selected.clear();
        jobs.forEach((j) => setField(j.job, 'status', it.value));
        render();
      });
    }
  }

  /* ------------------------------------------------------------ Events */

  function bindDeferredRedraws() {
    document.addEventListener('pointerdown', () => { deferred.down = true; }, true);
    // The click itself fires right after pointerup and redraws as usual;
    // anything held back during the press is caught up once the click is done.
    const release = () => {
      if (!deferred.down) return;
      deferred.down = false;
      if (!deferred.board && !deferred.panel) return;
      setTimeout(() => {
        if (deferred.board) { deferred.board = false; render(); }
        if (deferred.panel) { deferred.panel = false; renderPanel(); }
      }, 0);
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  }

  function bind() {
    bindDeferredRedraws();
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
    $('new-btn').addEventListener('click', () => openNew());
    $('new-cancel').addEventListener('click', () => el.newDialog.close());
    $('more-btn').addEventListener('click', (e) => {
      const items = [{ label: 'Export CSV (backup)', act: 'export' }];
      if (window.API.demo) items.push({ label: 'Reset demo data', act: 'reset' });
      openMenu(e.currentTarget, 'More', items, (it) => {
        if (it.act === 'export') exportCsv();
        if (it.act === 'reset') { window.API.reset(); refresh(); toast('Demo data reset'); }
      });
    });
    el.newForm.addEventListener('submit', submitNew);
    el.newForm.addEventListener('input', () => { showDates(el.newForm); el.newError.hidden = true; });
    $('add-project').addEventListener('click', () => { addProjectRow().querySelector('select').focus(); });
    el.projects.addEventListener('click', (e) => {
      const b = e.target.closest('.remove-project');
      if (!b || el.projects.children.length < 2) return;
      b.closest('.project-row').remove();
      updateSubmitLabel();
    });
    el.newForm.elements.customer.addEventListener('change', fillKnownCustomer);

    el.search.addEventListener('input', () => { state.filters.q = el.search.value.trim().toLowerCase(); render(); });
    el.sort.addEventListener('change', () => { state.filters.sort = el.sort.value; render(); });
    el.fieldsBtn.addEventListener('click', () => fieldsFilterMenu(el.fieldsBtn));
    el.stats.addEventListener('click', (e) => {
      const b = e.target.closest('[data-quick]');
      if (!b) return;
      if (state.view !== 'open') setView('open');
      const q = b.dataset.quick;
      state.filters.quick = state.filters.quick === q ? '' : q;
      render();
    });
    el.pills.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      state.filters.cat = b.dataset.cat;
      render();
    });
    el.activeFilters.addEventListener('click', (e) => {
      const b = e.target.closest('[data-clear]');
      if (b) clearFilter(b.dataset.clear);
    });

    // One listener for rows, cards, steps and pills.
    $('main').addEventListener('click', (e) => {
      const check = e.target.closest('[data-check]');
      if (check) {
        const n = Number(check.dataset.check);
        if (check.checked) state.selected.add(n); else state.selected.delete(n);
        renderBulk();
        return;
      }
      if (e.target.id === 'check-all') {
        visibleJobs().forEach((j) => { if (e.target.checked) state.selected.add(j.job); else state.selected.delete(j.job); });
        render();
        return;
      }
      if (e.target.closest('.col-check')) return;
      const of = e.target.closest('[data-order-filter]');
      if (of) {
        el.search.value = '#' + of.dataset.orderFilter;
        state.filters.q = el.search.value.toLowerCase();
        render();
        return;
      }
      const menu = e.target.closest('[data-row-menu]');
      if (menu) { rowMenu(Number(menu.dataset.rowMenu), menu); return; }
      const c = e.target.closest('[data-chip]');
      if (c) {
        const same = state.picker && state.picker.job === Number(c.dataset.job) && state.picker.field === c.dataset.chip;
        closePicker(true);
        if (!same) openFieldPicker(Number(c.dataset.job), c.dataset.chip, c);
        return;
      }
      const o = e.target.closest('[data-open]') || e.target.closest('tr.row');
      if (o) openPanel(Number(o.dataset.open || o.dataset.job));
    });

    el.pickerOptions.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b || !state.picker) return;
      const p = state.picker;
      const item = p.items[Number(b.dataset.pick)];
      closePicker();
      p.onPick(item);
    });
    el.pickerBackdrop.addEventListener('click', () => closePicker());

    el.panelBody.addEventListener('change', onPanelChange);
    el.panelBody.addEventListener('click', onPanelClick);
    el.panelBody.addEventListener('input', (e) => {
      const n = e.target.dataset.field && el.panelBody.querySelector('[data-says="' + e.target.dataset.field + '"]');
      if (n) showDates(n.parentNode, { [e.target.dataset.field]: e.target.value });
    });
    el.panelBody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'file-url') { e.preventDefault(); el.panelBody.querySelector('[data-act="add-file"]').click(); }
    });
    $('panel-close').addEventListener('click', closePanel);
    $('panel-more').addEventListener('click', (e) => { if (state.drawerJob != null) rowMenu(state.drawerJob, e.currentTarget); });
    el.panelBackdrop.addEventListener('click', closePanel);
    el.bulk.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bulk]');
      if (b) bulk(b.dataset.bulk, b);
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        el.search.focus();
        el.search.select();
        return;
      }
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !el.newDialog.open) {
        e.preventDefault();
        el.search.focus();
        return;
      }
      if (e.key !== 'Escape') return;
      if (state.picker) { closePicker(); e.preventDefault(); }
      else if (state.drawerJob != null && !el.newDialog.open) { closePanel(); e.preventDefault(); }
    });
    // Keep the picker attached to its anchor while things scroll.
    const follow = () => {
      if (!state.picker) return;
      const a = state.picker.anchor;
      if (a && a.isConnected) positionPicker(a); else closePicker(true);
    };
    const measureTop = () => document.documentElement.style.setProperty('--top', document.querySelector('.topbar').offsetHeight + 'px');
    measureTop();
    window.addEventListener('resize', () => {
      measureTop();
      follow();
      if (state.drawerJob != null) {
        const docked = window.matchMedia(WIDE).matches;
        el.panelBackdrop.hidden = docked;
        document.body.classList.toggle('no-scroll', !docked);
      }
    });
    window.addEventListener('scroll', follow, true);

    // Keep every screen in step: poll, and refresh when the tab comes back.
    setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);

    if (window.API.demo) $('demo-banner').hidden = false;
    if (/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelector('.kbd').textContent = '⌘K';
  }

  // Test hook (used by tests/ui.test.js).
  window.__app = { state, refresh, setField, markNextStep, POLL_MS };

  document.body.dataset.view = 'open';
  bind();
  refresh();
})();
