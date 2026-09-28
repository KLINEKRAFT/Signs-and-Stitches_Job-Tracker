# Signs & Stitches Job Tracker

A simple, shared job tracker for **Signs & Stitches** (110 N Garfield Ave, Sand Springs, OK). It works on the shop PC, laptops and phones.

The Google Sheet **"Signs & Stitches - Job Tracker"** is the database. The web page reads and writes it through a small Google Apps Script. The owner can work in the sheet or in the web page, and both always show the same jobs.

```
Browser (index.html + app.js)  --api.js-->  Apps Script web app (Code.gs)  -->  Google Sheet
```

- Plain HTML, CSS and JavaScript. No framework and no bundler. Vercel hosts it.
- No login for now. The page is marked `noindex` and `robots.txt` blocks search engines, but anyone who has the link can use it. See [Open Questions](#open-questions-for-the-owner).
- Every data call is in `api.js`. Adding a login or moving to a real database (Supabase) later means changing that one file.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `api.js` | All data calls (load, activity, create, update). With no URL configured it runs in demo mode |
| `options.js` | Works out which options each project type gets (per-type rules) |
| `config.example.js` | Copy to `config.js` and paste the Apps Script URL. `config.js` is gitignored |
| `apps-script/Code.gs` | The backend. Paste it into the Google Sheet (steps below) |
| `scripts/vercel-build.js` | Vercel build: copies the files to `dist/` and writes `config.js` from `API_URL` |
| `tests/` | Backend tests (against a fake sheet) and browser tests (Playwright) |
| `reference/` | The owner's sheet (`.xlsx` export) and the logo |

## 1. Set up the Google Sheet backend (Apps Script)

Do this once, signed in as the Google account that owns the sheet.

1. Open the Google Sheet **Signs & Stitches - Job Tracker**.
2. Check the sheet's time zone: **File > Settings > Time zone** should be **(GMT-05:00) Central Time - Chicago**. Dates are read in this time zone.
3. Go to **Extensions > Apps Script**. A new tab opens with a file called `Code.gs`.
4. Delete everything in `Code.gs`. Paste in the whole of [`apps-script/Code.gs`](apps-script/Code.gs) from this repo. Click the **Save** icon.
5. **Run setup once.** In the toolbar's function dropdown, pick **`setup`**, then click **Run**.
   - Google asks for permission. Click **Review permissions**, pick the account, then **Advanced > Go to (project name) (unsafe) > Allow**. This is normal for your own scripts.
   - `setup` does the following (it's safe to run again later):
     - Adds **Created At**, **Updated At** and **Order #** columns to **Job Log**, after Notes (columns S, T and U).
     - Adds an **Activity** tab (Timestamp, Job #, Field, Old Value, New Value).
     - Adds an **Options By Type** tab with the Digitized rule (see below).
     - Makes the **Open Jobs** and **Closed Jobs** views cover every row. The old formulas stopped at row 500. Open Jobs also shows **On Hold** jobs. Nothing else about those tabs changes.
     - Adds the new options to the **Lists** tab, next to the options they belong with: **On Hold** (Status), **Not Sent** (Estimate) and **Being Designed** (Artwork).
     - Formats Date In and Due Date as Day Month Year (`24 Sep 2026`). Points each Job Log dropdown at its whole Lists column, so options added later show up in the sheet's dropdowns too.
   - **Already ran `setup` before?** Paste the new code and run `setup` again. It only adds what's missing.
6. **Deploy as a web app.** Click **Deploy > New deployment**, click the gear next to "Select type" and choose **Web app**, then set:
   - Description: `Job Tracker`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.
7. Test it by pasting the URL into a browser. You should see JSON that starts with `{"ok":true,"jobs":[...`.

**Updating the script later.** Paste the new code and save, then go to **Deploy > Manage deployments**, click the pencil, set **Version: New version** and click **Deploy**. The URL stays the same. If you create a new deployment instead, you get a new URL and have to update Vercel.

**How it stays safe with several people:** every write takes a script lock, so two saves can't collide. Rows are always found by **Job #**, never by row position, so sorting or filtering the sheet by hand is fine. If two people change the same field at the same moment, the last save wins.

## 2. Configure and run the app locally

```sh
cp config.example.js config.js     # then paste the /exec URL into API_URL
npm start                          # or: python3 -m http.server 8080
```

Open http://localhost:8080.

If `config.js` is missing or `API_URL` is empty, the app runs in **demo mode**. It shows a yellow banner and uses sample jobs stored in your browser only. That's handy for trying it out.

## 3. Deploy on Vercel

1. In Vercel, click **Add New > Project** and import this GitHub repo.
2. Leave Framework Preset as **Other**. The build settings come from `vercel.json`: `node scripts/vercel-build.js` builds into `dist/`.
3. Under **Environment Variables**, add `API_URL` = your Apps Script `/exec` URL.
4. Click **Deploy**. If you change `API_URL` later, redeploy so it takes effect.

The build only copies the app files into `dist/`, so the Apps Script source, tests and reference files are never served.

## Using it

- **Open Jobs** (the default) shows Active and On Hold jobs, soonest due first.
  - Tap a colored chip to change it. It saves right away, with no Save button. If a save fails, the chip goes back to its old value and a red message appears.
  - Chip colors: **green** = done, **amber** = in progress (including Being Designed), **red** = blocked (Waiting, On Hold), **blue** = neutral, **grey** = Not Sent, **grey outline** = not set.
  - Due dates turn **red** when overdue and **amber** when due within 3 days.
  - Search by customer, job # or description. Type `#1002` to see job 1002 and everything linked to it. Filter by project type, or by any tracking field ("Material = Waiting", "Status = On Hold", ...).
  - Tap a customer name (or a card on a phone) to open the job detail.
- **Closed** shows Complete and Dead jobs together, newest due date first, matching the sheet's Closed Jobs tab. Dead jobs are shown with a black DEAD chip. Nothing is ever deleted. To reopen a job, set its Status back to **Active**.
- **Job detail** has every field, editable. A field saves when you leave it. The bottom of the panel shows the activity log (what changed and when).
- **New Job**: Customer, Due Date and Project Type, plus an optional "What is it?" line. That's all. Date In (defaults to today), contact details and notes are tucked under "More details". Picking a customer you've had before fills in their contact details. Estimate starts as **Not Sent**. There's no Qty; this is a status tracker, not an order form. (The Qty column stays in the sheet, untouched.) Job numbers count up from 1001.

### Several projects for one customer (orders)

Customers often order several things at once, like hats, a vinyl banner and golf balls. Each one is its own job with its own statuses, but they're **linked as one order** so nobody tells the customer "it's ready" while part of it is still in the works.

- **Creating them:** in New Job, press **+ Add another project for this customer** for each extra item. One click creates them all, linked. The Order # is the first job's number.
- **Seeing them:** every linked job shows a badge like **Order 1002 - 1 of 3 ready** (amber), which turns green (**all 3 ready**) once every project is done. Linked jobs sit together in the list. Tap the badge to show just that order.
- **"Ready"** means Production is **Finished** or Status is **Complete**. Dead projects don't count.
- **The warning:** when someone sets Production to Finished or Status to Complete on part of an order, a yellow message stays on screen until they tap **Got it**. It lists exactly which projects aren't ready yet. When the last one is done, it says it's OK to let the customer know.
- **In the job panel:** the top shows the rest of the order and where each piece stands. Tap one to jump to it. You can **Add another project to this order** later (customer and contact are filled in for you), or **Unlink this job**. A job on its own can be **linked to** another job; other open jobs for the same customer are listed first, with a note if there are any.
- **In the sheet**, linked jobs share the same number in the **Order #** column (U). You can also type or clear it there.
- **Export CSV** downloads every job as a backup (desktop and laptop only).
- Every open screen refreshes every 20 seconds, and again as soon as you switch back to the tab.

## Editing options and per-type rules (in the sheet)

**Dropdown options** come from the **Lists** tab, one column per field, exactly as before. To add an option, type it at the bottom of its column. The app picks it up on its next refresh. (New options show as a grey chip. To give one a color, add it to `CHIP_TONE` near the top of `app.js`.)

**Options that only apply to some project types** live in the **Options By Type** tab. Each row limits one option to certain project types:

| Field | Option | Only For Project Types |
|---|---|---|
| Artwork | Digitized | Embroidery - Hats, Embroidery - Apparel, Embroidery - Other |

- **Field** is the Job Log column name (Status, Estimate, Material, Artwork, Production, Delivery, Payment).
- **Option** has to match the Lists tab exactly.
- **Only For Project Types** is a comma-separated list. A trailing `*` matches the start of a name, so `Embroidery*` covers every Embroidery type.
- Options with no row show for every project type.
- A job that already has a value always keeps it, even if a rule would now hide it.

To give a project type its own option, add the option to the Lists tab, then add a row here limiting it to that type. That's the only per-type rule set up so far. The rest are open questions below.

## Tests

```sh
npm test
```

- `tests/apps-script.test.js` runs `Code.gs` against an in-memory copy of the owner's sheet. It covers reads, create (single, several linked, add to an order), link/unlink, update-by-Job #, activity, setup (including the new options and On Hold view) and bad input.
- `tests/ui.test.js` drives the real page in Chromium (Playwright). It covers chips and colors, the new options, the Digitized rule, optimistic save and rollback, the drawer, new job (single and several projects), orders (badges, the not-ready warning, adding, unlinking and linking), filters, Closed and reopening, CSV export, the phone layout (cards, bottom-sheet picker, 44px tap targets), and a remote-mode run where the browser talks to `Code.gs` using `text/plain` POSTs. It's skipped if Playwright isn't installed.

## Open Questions (for the owner)

1. **Per-type options:** which other project types need their own options? For example, screen print (screens burned, test print?), vinyl (weeded, transfer taped?), leather work, and so on. Only "Digitized = Embroidery only" is set up so far.
2. **Password protection:** the page is unprotected right now. Anyone with the link can view and change jobs. Do you want one shared shop password, or separate staff logins (which would also record *who* made each change in the activity log)?
3. **Customer notifications:** should customers get a text or email when a job is ready for pickup?
4. **Art and proof files:** should art and proof files be attached to jobs (for example, linked from Google Drive)?
5. **Closed order:** Closed jobs are sorted newest due date first, the same as the sheet's Closed Jobs tab. Would you rather see the most recently *closed* jobs first?
6. **What counts as "ready" in an order:** right now a project is ready when Production is **Finished** (or Status is Complete). Is that the moment you'd call the customer, or should it wait for something else, like Payment?
