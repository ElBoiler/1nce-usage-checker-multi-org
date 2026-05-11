# 1NCE Usage Checker

A Chrome extension that checks data-quota usage across multiple 1NCE organisations and highlights SIM cards that are out of data or running low. Runs entirely in the browser — no server, no Docker, no build step.

---

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** → select the `extension/` folder inside this repo
5. The 1NCE icon appears in your Chrome toolbar

Click the icon any time to open the checker in a new tab.

---

## First-time setup

### Adding an organisation

You need one entry per 1NCE account. Each org has its own credentials.

1. Click **Add** in the *Organisations* panel on the left
2. Fill in the form:

   | Field | What to enter |
   |-------|---------------|
   | **Organisation Name** | A display label — anything you like (e.g. "ACME Production") |
   | **Customer Number** | Your 1NCE customer number (shown in the 1NCE portal under your account) |
   | **Username** | The email address you use to log into the 1NCE portal |
   | **Password** | Your 1NCE portal password |

3. Click **Save**

A **green lock badge** next to the org name confirms credentials are stored. Repeat for each organisation.

> **Where are credentials stored?** Inside Chrome's `chrome.storage.local` — encrypted at rest on the device and never sent anywhere except directly to `api.1nce.com`. The UI never receives your password back from storage; it only knows whether credentials exist (`has_credentials: true/false`).

---

## Importing credentials from a backup

If you have a `config.json` exported from a previous installation (see [Exporting your config](#exporting-your-config) below), you can restore all orgs in one step instead of adding them manually.

1. Click **Import Config** in the Export panel (bottom of the left sidebar)
2. Select your `config.json` file
3. A success message shows how many orgs were added or updated

> **Passwords are not included in exports** (by design — the file is safe to share or commit). After importing, click the pencil icon next to each org and re-enter its password. The green lock badge will turn on once the password is saved.

---

## Checking SIM usage

1. **Select orgs** — check one or more orgs in the list, or leave all unchecked to check everything
2. Click **Check All Orgs** (or **Check Selected** if you picked specific ones)
3. Watch the progress bar — it shows the current org and SIM count
4. When complete, the results table appears

### Reading the results

| Row colour | Meaning |
|------------|---------|
| 🔴 Red | 0 MB remaining — SIM is out of data |
| 🟡 Amber | 1–9 MB remaining — running low |
| White | 10 MB or more — OK |

The **IMSI column** is intentionally blank for SIMs with ≥ 10 MB remaining. It only shows for low/no-data SIMs where it's needed for diagnostics — this is a deliberate privacy/security measure.

### Filtering and searching

- **Filter tabs** — Issues (red + amber), All, No Data, Low <10 MB
- **Search box** — filters by ICCID, Label, or MSISDN (partial match)
- **Org dropdown** — narrows the table to one organisation

Click any column header to sort. Click again to reverse.

### Opening a SIM in the 1NCE portal

Click the portal icon (↗) on any row to open that SIM's record directly in the 1NCE portal.

---

## Orders tab

1. Switch to the **Orders** tab (top nav)
2. Select a time period on the left (Last 30 days / 3 months / 6 months / Last year / Custom)
3. Click **Load / Refresh**

The tab shows:
- Total order count and spend across all selected orgs
- Per-org spend breakdown table
- Spend-over-time bar chart (one series per org, total line overlay)
- Full order table (sortable, searchable, filterable by org)

---

## Exporting data

### SIM usage export

In the **Usage Checker** tab, pick a scope first:

| Scope | What's included |
|-------|----------------|
| **No Data** | Only SIMs with 0 MB remaining |
| **+ Low** | SIMs with 0–9 MB remaining |
| **All** | Every SIM that was checked |

Then click **Export CSV** or **Export Excel**.

Excel exports create one sheet per organisation plus a **Summary** sheet when more than one org is included.

### Orders export

In the **Orders** tab, choose **All loaded** or **Filtered view**, then click **Export CSV** or **Export Excel**.

### Exporting your config

Click **Export Config** to download a `config.json` file containing all your org names, customer numbers, and usernames — **passwords are not included**.

Keep this file as a backup. You can use it to restore your setup on another machine (see [Importing credentials from a backup](#importing-credentials-from-a-backup)).

---

## Settings — Metabase enrichment (optional)

If your team uses Metabase to track infrastructure, you can enrich low-data SIMs with internal links.

1. Click the **⚙ gear icon** in the top bar
2. Enter:

   | Field | What to enter |
   |-------|---------------|
   | **Public CSV URL** | The URL of a Metabase public question, ending in `.csv` |
   | **Parameter ID** | The UUID of the IMSI template tag in that question |

3. Click **Save**

After a check, low-data SIMs whose IMSIs are found in the Metabase export will have **Advizeo Infra** and **Advizeo Admin** links populated in the table. Leave both fields blank to disable enrichment.

---

## Token management

The extension caches authentication tokens in memory (never on disk). They expire automatically and are refreshed transparently before the next check.

To force all orgs to re-authenticate immediately, click **Refresh Tokens** in the left sidebar. This is useful if you've just changed a password.

---

## Editing or removing an organisation

- **Edit** — click the pencil icon next to the org name. You can update the name, customer number, username, or password. Leave the password field blank to keep the existing one.
- **Remove** — click the trash icon, then confirm. This removes the org and its stored credentials permanently.

---

## Dark mode

Click the moon/sun icon in the top-right corner to toggle dark mode. The preference is saved in `localStorage` and persists across sessions.

---

## Verbose logging

Expand the **Activity Log** panel at the bottom of the page. Enable **Verbose** before running a check to see every API request — useful for diagnosing rate-limit issues or checking which orgs are slow.

---

## Unit tests

```bash
node --test tests/utils.test.js
```

Requires Node.js 18+. No `npm install` needed.

See [`tests/manual-checklist.md`](tests/manual-checklist.md) for the full manual E2E checklist.

---

## API endpoints used

| Endpoint | Purpose |
|----------|---------|
| `POST /oauth/token` | Obtain Bearer token (Basic auth, cached per org, refreshed 60 s before expiry) |
| `GET /v1/sims?pageSize=100&page=N` | Paginated SIM list |
| `GET /v1/sims/{iccid}/quota/data` | Per-SIM remaining quota, total volume, expiry date |
| `GET /v1/orders?pageSize=10&page=N` | Paginated order history |

Base URL: `https://api.1nce.com/management-api`

---

## Architecture

| File | Role |
|------|------|
| `extension/manifest.json` | MV3 manifest — permissions, icons, service worker declaration |
| `extension/background.js` | Service worker — all API calls, token cache, rate limiting, retry logic |
| `extension/index.html` | Full-tab UI |
| `extension/app.js` | UI logic — org management, messaging, table rendering, exports |
| `extension/lib/utils.js` | Shared pure functions (tested independently with Node.js) |
| `extension/icons/` | Extension icons at 16, 48, and 128 px (sourced from 1nce.com) |
| `extension/lib/` | Bundled Bootstrap 5.3.3, Bootstrap Icons 1.11.3, Chart.js 4.4.3, SheetJS |
