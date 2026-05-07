# TMC Quote Web App

A lightweight web UI for the **TMC Quotation Builder** Odoo module. The
frontend is a single-page app (`index.html` + `app.js`) and the backend is a
small Python (stdlib-only) bridge that forwards JSON requests to Odoo via
JSON-RPC.

---

## Project layout

```
.
├── api/
│   └── index.py          # Vercel serverless entrypoint (re-uses ROUTES from server.py)
├── app.js                # Frontend logic
├── index.html            # Frontend UI
├── server.py             # Local stdlib HTTP server (used for dev via run.bat)
├── run.bat               # Windows launcher for local dev
├── requirements.txt      # Empty — stdlib only; tells Vercel to use Python runtime
├── vercel.json           # Vercel build + routing config
└── .vercelignore         # Files excluded from Vercel deploy
```

---

## Local development (Windows)

1. Edit the Odoo connection vars at the top of `run.bat` if needed:
   ```
   set ODOO_URL=https://demo.tallymarkscloud.com:8046
   set ODOO_DB=TMC_Prod_Ess
   set ODOO_USER=admin
   set ODOO_PASS=admin
   ```
2. Double-click `run.bat` (or run `python server.py`).
3. Open <http://127.0.0.1:5066/>.

Requires Python 3.9+. No third-party packages.

---

## Deploy to Vercel

### Option A — via Vercel CLI

```bash
npm i -g vercel
vercel            # first deploy (preview)
vercel --prod     # production deploy
```

### Option B — via GitHub import

1. Push this repo to GitHub.
2. On <https://vercel.com/new> import the repo.
3. Framework preset: **Other**. No build command needed — `vercel.json`
   handles everything.

### Required environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (for
Production *and* Preview):

| Key         | Example value                              |
| ----------- | ------------------------------------------ |
| `ODOO_URL`  | `https://demo.tallymarkscloud.com:8046`    |
| `ODOO_DB`   | `TMC_Prod_Ess`                             |
| `ODOO_USER` | `admin`                                    |
| `ODOO_PASS` | `admin`                                    |

> The Odoo server **must be reachable from the public internet** — Vercel's
> serverless functions cannot hit `localhost`.

---

## API endpoints (handled by `api/index.py` → `server.ROUTES`)

```
GET/POST  /api/ping
GET       /api/quotes
GET       /api/quote?id=<n>
GET       /api/partners
GET       /api/leads
GET       /api/skills
GET       /api/levels
GET       /api/skill_cost?skill_id=<n>&level_id=<n>
GET       /api/approvals_pending
POST      /api/quote/create
POST      /api/quote/update
POST      /api/quote/action
POST      /api/quote/comment
GET       /api/quote/logs?id=<n>
```
