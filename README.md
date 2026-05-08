# 1NCE Usage Checker

A Chrome extension that checks data-quota usage across multiple 1NCE organisations and
highlights SIM cards with no data remaining or critically low data.

No server, no Docker, no build step — install from source in under a minute.

---

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Click the **1NCE Usage Checker** icon in the toolbar — a full tab opens

---

## Configuration

### Adding organisations

Click **Add** in the left sidebar and enter:

| Field | Notes |
|-------|-------|
| Organisation Name | Display name only — any string |
| Customer Number | Your 1NCE customer number |
| Username (email) | Your 1NCE portal login |
| Password | Stored locally in Chrome's encrypted storage only |

Credentials are stored in `chrome.storage.local` and are **never sent back to the UI** —
the app only receives a `has_credentials: true/false` flag per org.

### Metabase enrichment (optional)

Click the **⚙ gear icon** in the top bar to open Settings. Provide:

| Field | Notes |
|-------|-------|
| Public CSV URL | Metabase public question URL ending in `.csv` |
| Parameter ID | UUID of the IMSI template tag in the question |

When configured, low-data SIMs (<10 MB) are enriched with infrastructure and admin
links fetched from your Metabase instance.

---

## Usage

1. **Check usage** — click **Check All Orgs** or select specific orgs and click **Check Selected**
2. **Read the results** — rows are highlighted red (0 MB) or amber (<10 MB). The IMSI column is only populated for low/no-data SIMs
3. **Filter** — use the Issues / All / No Data / Low <10 MB tabs, the search box, or the org dropdown
4. **Open in portal** — click the portal icon on any row to open that SIM in the 1NCE portal
5. **Export** — choose a scope (All / No Data / + Low) then click **Export CSV** or **Export Excel**

The **Orders** tab fetches spend history across orgs and renders a spend-over-time chart. Select a date range and click **Load / Refresh**.

---

## Exports

| Export | File | Contents |
|--------|------|---------|
| SIM Usage CSV | `sims_usage.csv` or `sims_no_data.csv` | All columns including portal links |
| SIM Usage Excel | `sims_usage.xlsx` or `sims_no_data.xlsx` | One sheet per org + Summary sheet |
| Orders CSV | `orders.csv` | Order number, date, type, status, amount |
| Orders Excel | `orders.xlsx` | One sheet per org + Summary sheet |
| Config | `config.json` | Orgs without passwords — safe to share |

---

## Unit tests

```bash
node --test tests/utils.test.js
```

Requires Node.js 18+. No `npm install` needed — tests run against the bundled `extension/lib/utils.js` directly.

See [`tests/manual-checklist.md`](tests/manual-checklist.md) for the full manual E2E checklist.

---

## API endpoints used

| Endpoint | Purpose |
|----------|---------|
| `POST /oauth/token` | Obtain Bearer token (cached, auto-refreshed before expiry) |
| `GET /v1/sims?pageSize=100&page=N` | Paginated SIM list |
| `GET /v1/sims/{iccid}/quota/data` | Per-SIM remaining quota, total, expiry |
| `GET /v1/orders?pageSize=10&page=N` | Paginated order history |

Base URL: `https://api.1nce.com/management-api`

---

## Architecture

| File | Role |
|------|------|
| `extension/manifest.json` | MV3 manifest — permissions, service worker declaration |
| `extension/background.js` | Service worker — all API calls, token cache, rate limiting |
| `extension/index.html` | Full-tab UI |
| `extension/app.js` | UI logic — org management, messaging, table, exports |
| `extension/lib/utils.js` | Shared pure functions (testable without a browser) |
| `extension/lib/` | Bundled Bootstrap 5.3.3, Bootstrap Icons, Chart.js, SheetJS |
