// Every data call the app makes lives here. To move to another backend
// (Supabase, etc.) only this file needs to change.
//
//   API.load()                        -> { jobs, lists: { types, options }, rules }
//   API.activity(jobNo)               -> [{ at, field, oldValue, newValue }]
//   API.createJobs([fields], linkTo)  -> [job]   several at once are linked by Order #;
//                                                 linkTo adds them to that job's order
//   API.updateField(jobNo, key, val)  -> job
//   API.linkJob(jobNo, toJobNo)       -> [job]   put a job in another job's order
//
// With no API_URL in config.js the app runs in demo mode against browser storage.

(function () {
  'use strict';

  const API_URL = ((window.APP_CONFIG || {}).API_URL || '').trim();

  async function readJson(res) {
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function get(params) {
    const url = new URL(API_URL);
    Object.keys(params || {}).forEach((k) => url.searchParams.set(k, params[k]));
    return readJson(await fetch(url, { cache: 'no-store' }));
  }

  // text/plain keeps this a "simple" request, so the browser skips the CORS
  // preflight that Apps Script cannot answer.
  async function post(body) {
    return readJson(await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }));
  }

  const remote = {
    demo: false,
    async load() {
      const d = await get();
      return { jobs: d.jobs, lists: d.lists, rules: d.rules };
    },
    async activity(jobNo) {
      return (await get({ action: 'activity', job: jobNo })).activity;
    },
    async createJobs(list, linkTo) {
      return (await post({ action: 'create', jobs: list, linkTo: linkTo || 0 })).jobs;
    },
    async updateField(jobNo, field, value) {
      return (await post({ action: 'update', job: jobNo, field, value })).job;
    },
    async linkJob(jobNo, to) {
      return (await post({ action: 'link', job: jobNo, to })).jobs;
    }
  };

  /* ------------------------------------------------------------ Demo mode */

  const DEMO_KEY = 'sns-job-tracker-demo-v2';
  const REQUIRED = { customer: 'Customer', type: 'Project Type', due: 'Due Date' };
  const NEW_JOB_DEFAULTS = { status: 'Active', estimate: 'Not Sent' };

  function isoDay(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function demoSeed() {
    const now = new Date().toISOString();
    const job = (o) => Object.assign({
      job: 0, dateIn: '', due: '', customer: '', contact: '', phone: '', email: '', type: '', description: '',
      qty: '', status: 'Active', estimate: '', material: '', artwork: '', production: '', delivery: '',
      payment: '', notes: '', createdAt: now, updatedAt: now, order: ''
    }, o);
    return {
      jobs: [
        job({ job: 1001, dateIn: isoDay(-6), due: isoDay(4), customer: 'SAMPLE - Sand Springs Youth Football',
          contact: 'Jane Doe', phone: '918-555-0100', email: 'jane@example.com', type: 'T-Shirts - Screen Print',
          description: 'Team tees, 2-color front', qty: 48, estimate: 'Approved', material: 'Ordered',
          artwork: 'Approved', production: 'In Queue', delivery: 'Pick-Up', payment: 'Billed',
          notes: 'Example row - delete when you start' }),
        job({ job: 1002, dateIn: isoDay(-10), due: isoDay(-1), customer: 'SAMPLE - Main St Coffee',
          contact: 'John Roe', phone: '918-555-0101', email: 'john@example.com', type: 'Embroidery - Hats',
          description: 'Richardson 112, left-front logo', qty: 24, estimate: 'Approved', material: 'Received',
          artwork: 'Digitized', production: 'Working', delivery: 'Pick-Up', payment: 'Billed',
          notes: 'Overdue example - due date is past', order: 1002 }),
        job({ job: 1003, dateIn: isoDay(-20), due: isoDay(-12), customer: 'SAMPLE - Garfield Ave Dental',
          contact: 'Amy Poe', phone: '918-555-0102', email: 'amy@example.com', type: 'Vinyl - Signage',
          description: 'Window hours decal', qty: 1, status: 'Complete', estimate: 'Approved',
          material: 'Received', artwork: 'Approved', production: 'Finished', delivery: 'Pick-Up',
          payment: 'Paid in Full', notes: 'Complete example - shows on Closed tab' }),
        job({ job: 1004, dateIn: isoDay(-2), due: isoDay(2), customer: 'SAMPLE - River City Realty',
          type: 'Vinyl - Signage', description: 'Yard signs, 18x24', qty: 30, estimate: 'Sent',
          material: 'Waiting' }),
        job({ job: 1005, dateIn: isoDay(-30), due: isoDay(-25), customer: 'SAMPLE - Lakeside Church',
          type: 'Promo', description: 'Koozies', qty: 200, status: 'Dead', estimate: 'Sent',
          notes: 'Quote did not go through' }),
        job({ job: 1006, dateIn: isoDay(-10), due: isoDay(-1), customer: 'SAMPLE - Main St Coffee',
          contact: 'John Roe', phone: '918-555-0101', email: 'john@example.com', type: 'Vinyl - Signage',
          description: 'Grand opening banner', estimate: 'Approved', material: 'Received',
          artwork: 'Being Designed', delivery: 'Pick-Up', payment: 'Billed', order: 1002 }),
        job({ job: 1007, dateIn: isoDay(-10), due: isoDay(-1), customer: 'SAMPLE - Main St Coffee',
          contact: 'John Roe', phone: '918-555-0101', email: 'john@example.com', type: 'Promo',
          description: 'Logo golf balls', estimate: 'Approved', material: 'Ordered', artwork: 'Approved',
          production: 'In Queue', delivery: 'Pick-Up', payment: 'Billed', order: 1002 }),
        job({ job: 1008, dateIn: isoDay(-3), due: isoDay(9), customer: 'SAMPLE - Keystone Little League',
          type: 'Embroidery - Apparel', description: 'Coach polos, club brings own shirts', status: 'On Hold',
          estimate: 'Not Sent', material: 'Waiting' })
      ],
      activity: [],
      lists: {
        types: ['Embroidery - Hats', 'Embroidery - Apparel', 'Embroidery - Other', 'Vinyl - Apparel',
          'Vinyl - Signage', 'Vinyl - Other', 'Promo', 'T-Shirts - Screen Print', 'Heat Press - Hat',
          'Heat Press - Other', 'Leather Work', 'Other'],
        options: {
          status: ['Active', 'On Hold', 'Complete', 'Dead'],
          estimate: ['Not Sent', 'Sent', 'Approved'],
          material: ['Waiting', 'Ordered', 'Received'],
          artwork: ['Being Designed', 'Sent to Customer', 'Approved', 'Digitized'],
          production: ['In Queue', 'Working', 'Finished'],
          delivery: ['Pick-Up', 'Ship', 'Courier'],
          payment: ['Billed', 'Paid in Full']
        }
      },
      rules: [{ field: 'artwork', option: 'Digitized',
        types: ['Embroidery - Hats', 'Embroidery - Apparel', 'Embroidery - Other'] }]
    };
  }

  let memory = null;
  function db() {
    if (memory) return memory;
    try { memory = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch (e) { memory = null; }
    if (!memory || !memory.jobs) memory = demoSeed();
    return memory;
  }
  function save() {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(memory)); } catch (e) { /* storage unavailable */ }
  }
  const pause = () => new Promise((r) => setTimeout(r, 150));
  const copy = (o) => JSON.parse(JSON.stringify(o));

  const demo = {
    demo: true,
    async load() {
      await pause();
      const d = db();
      return copy({ jobs: d.jobs, lists: d.lists, rules: d.rules });
    },
    async activity(jobNo) {
      await pause();
      return copy(db().activity.filter((a) => a.job === Number(jobNo)).reverse());
    },
    async createJobs(list, linkTo) {
      await pause();
      if (!list.length) throw new Error('Nothing to create');
      list.forEach((fields) => Object.keys(REQUIRED).forEach((k) => {
        if (!String(fields[k] || '').trim()) throw new Error(REQUIRED[k] + ' is required');
      }));
      const d = db();
      const now = new Date().toISOString();
      let next = d.jobs.reduce((m, j) => Math.max(m, j.job), 1000) + 1;
      let group = '';
      if (linkTo) group = demoEnsureOrder(Number(linkTo));
      else if (list.length > 1) group = next;
      const made = list.map((fields) => {
        const job = Object.assign({ dateIn: isoDay(0), order: '' }, NEW_JOB_DEFAULTS, fields,
          { job: next++, createdAt: now, updatedAt: now });
        Object.keys(NEW_JOB_DEFAULTS).forEach((k) => { if (!job[k]) job[k] = NEW_JOB_DEFAULTS[k]; });
        if (group) job.order = group;
        d.jobs.push(job);
        d.activity.push({ job: job.job, at: now, field: 'Created', oldValue: '', newValue: job.customer + ' - ' + job.type });
        return job;
      });
      save();
      return copy(made);
    },
    async linkJob(jobNo, to) {
      await pause();
      if (Number(jobNo) === Number(to)) throw new Error('A job cannot be linked to itself');
      const group = demoEnsureOrder(Number(to));
      const job = demoSet(Number(jobNo), 'order', group);
      return copy([db().jobs.find((j) => j.job === Number(to)), job]);
    },
    async updateField(jobNo, field, value) {
      await pause();
      return copy(demoSet(jobNo, field, value));
    },
    reset() {
      memory = demoSeed();
      save();
    }
  };

  function demoEnsureOrder(jobNo) {
    const job = db().jobs.find((j) => j.job === jobNo);
    if (!job) throw new Error('Job ' + jobNo + ' not found');
    if (job.order !== '' && job.order != null) return Number(job.order);
    demoSet(jobNo, 'order', jobNo);
    return jobNo;
  }

  function demoSet(jobNo, field, value) {
    const d = db();
    const job = d.jobs.find((j) => j.job === Number(jobNo));
    if (!job) throw new Error('Job ' + jobNo + ' not found');
    if (REQUIRED[field] && !String(value || '').trim()) throw new Error(REQUIRED[field] + ' is required');
    const old = job[field] == null ? '' : job[field];
    if (String(old) !== String(value)) {
      job[field] = value;
      job.updatedAt = new Date().toISOString();
      d.activity.push({ job: job.job, at: job.updatedAt, field: window.FIELD_LABELS[field] || field,
        oldValue: String(old), newValue: String(value) });
      save();
    }
    return job;
  }

  window.API = API_URL ? remote : demo;
})();
