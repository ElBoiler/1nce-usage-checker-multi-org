# 1NCE Usage Checker — Chrome Extension Conversion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Ruby/Sinatra Docker app into a Manifest V3 Chrome extension that opens as a full browser tab with no server or Docker required.

**Architecture:** A background service worker owns all 1NCE API calls (bypassing CORS), communicating with the tab page via `chrome.runtime.connect()` long-lived ports for `check` and `fetchOrders`, and `chrome.runtime.sendMessage()` for short operations. All config including credentials lives in `chrome.storage.local`. Pure helper functions live in `extension/lib/utils.js` so they can be unit-tested with Node.js without a browser.

**Tech Stack:** Vanilla JS (ES2022), Manifest V3, Bootstrap 5.3.3 (bundled), Bootstrap Icons 1.11.3 (bundled), Chart.js 4.4.3 (bundled), SheetJS/xlsx (bundled), Node.js for unit tests only.

---

## Status: 8 of 11 Tasks Complete

Tasks 1–8 are implemented on branch `claude/sharp-goldberg-60f544`. Tasks 9–11 remain.
See `docs/superpowers/plans/2026-04-29-chrome-extension.md` for the original detailed task breakdown.

---

## Architecture Reference

### Why a Background Service Worker?

`api.1nce.com` does not allow browser cross-origin requests. A Chrome extension service worker has full network access, bypassing CORS entirely. This is the critical architectural difference from simpler extensions like `advizeo-generic-readout-deleter` (which puts all logic in the popup because its API is either CORS-friendly or operations finish within popup lifetime). For 1NCE, a background worker is non-negotiable.

MV3 service workers terminate after ~30 seconds of inactivity. A check against a large org (hundreds of SIMs, each requiring a `/quota/data` call) can take several minutes. Solution: `chrome.runtime.connect()` long-lived ports — an open port keeps the service worker alive for its duration.

### Manifest Structure

```json
{
  "manifest_version": 3,
  "name": "1NCE Usage Checker",
  "version": "2.0.0",
  "description": "Check SIM data quota usage across multiple 1NCE organisations.",
  "permissions": ["storage"],
  "host_permissions": [
    "https://api.1nce.com/*",
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "1NCE Usage Checker"
  }
}
```

**Key decisions:**
- `"type": "module"` on the service worker — enables `import` statements in `background.js` so it can share pure functions from `lib/utils.js`. Supported Chrome 102+.
- No `"default_popup"` — mutually exclusive with `chrome.action.onClicked`. The extension opens a full tab via `chrome.tabs.create()` in `background.js`.
- `"<all_urls>"` in `host_permissions` — required because the Metabase enrichment URL is user-configured at runtime and unknown at build time. If ever submitted to the Web Store, this triggers extended review; document the justification.
- `"storage"` permission — for `chrome.storage.local` (credentials, org list, metabase config).
- No `"tabs"` permission — `chrome.tabs.create()` does not require it.
- No `content_security_policy` override — the MV3 default (`script-src 'self'; object-src 'self'`) is satisfied by bundled scripts.

### Script Split

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Tab page | `index.html`, `app.js` | UI rendering, org management, table display, filters, chart, export. Never calls `fetch()` directly. |
| Service worker | `background.js` | All network I/O. Token cache. Rate limiting. Retry logic. Port and message handlers. |
| Shared utilities | `lib/utils.js` | Pure functions: `buildSimRow`, `imsiBlanked`, `rowValues`, `orderRowValues`, `calculateBackoffDelay`, `sleep`. Shared by both layers via ES module `import`. |
| Content scripts | — | None. Not needed. |

### Message API

**Long-lived ports (chrome.runtime.connect)** — used for operations that stream progress and may run for minutes:

| Port name | Payload from app.js | Messages from background.js |
|-----------|--------------------|-----------------------------|
| `check` | `{ orgId?, verbose? }` | `{ type: 'progress', org_name, completed, total }` then `{ type: 'done', results, errors, request_log? }` or `{ type: 'error', message }` |
| `fetchOrders` | `{ orgId?, startDate?, endDate? }` | `{ type: 'done', results, errors }` or `{ type: 'error', message }` |

**Short messages (chrome.runtime.sendMessage)** — for operations with a single response:

| action | Payload | Response |
|--------|---------|----------|
| `enrich` | `{ imsis: string[] }` | `{ enriched: { [imsi]: { serial_number, infra_url, admin_url } }, error? }` |
| `invalidateTokens` | — | `{ ok: true }` |

### Authentication and Credentials Handling

- Credentials stored in `chrome.storage.local` — encrypted at rest on ChromeOS/macOS; user-account isolation on Windows. Acceptable for a single-user internal tool.
- `app.js` never sees passwords. `loadOrgs()` returns `has_credentials: true/false` only.
- `background.js` reads credentials from storage, calls `POST /oauth/token` with HTTP Basic auth (base64 `username:password`), then caches the JWT in-memory (`TOKEN_CACHE` object, never persisted).
- Token cache resets when the service worker is killed. The next check re-authenticates transparently — no user action required.
- Token considered valid until 60 seconds before its `expires_in` timestamp.

### Rate Limiting and Retry (mirrors Ruby app.rb exactly)

| Constant | Value | Purpose |
|----------|-------|---------|
| `THREAD_POOL_SIZE` | 5 | Max concurrent `/quota/data` fetches per org |
| `MAX_RETRIES` | 4 | Retry attempts on HTTP 429 |
| `RETRY_BASE_DELAY` | 1000 ms | Exponential backoff base |
| `RETRY_MAX_DELAY` | 30000 ms | Backoff ceiling |
| `MIN_REQUEST_GAP` | 250 ms | Minimum gap between request starts per org |

Effective throughput: 5 threads × (1 / 0.25 s) ≈ 4 requests/second per org.

### Notable Gotchas

1. **Service worker idle timeout** — Chrome kills MV3 service workers after ~30s idle. Use `chrome.runtime.connect()` ports (not `sendMessage`) for any operation that takes longer. The open port prevents termination.

2. **`type: "module"` on the service worker** — without it `background.js` cannot use `import`. Adding it after the fact requires the extension to be reloaded. Make sure the manifest has `"type": "module"` in the `"background"` block.

3. **SheetJS as classic script + `app.js` as ES module** — SheetJS (`xlsx.min.js`) is loaded as a classic `<script>` so it attaches to `window.XLSX`. `app.js` is `type="module"` so it can `import` from `lib/utils.js`. Load order in `index.html` must be: `bootstrap.bundle.min.js` → `xlsx.min.js` → `<script type="module" src="app.js">`. Loading xlsx before the module ensures `window.XLSX` is available when `app.js` runs.

4. **Password never returned to app.js** — `background.js` must never include the `password` field in any `port.postMessage()` or `sendResponse()` payload. The `loadOrgs()` function in `app.js` only exposes `has_credentials`.

5. **No `"tabs"` permission in manifest** — `chrome.tabs.create()` does not require the `tabs` permission. Adding it unnecessarily triggers a Chrome Web Store warning about accessing browsing history.

6. **`<all_urls>` for Metabase** — the Metabase public CSV URL is user-supplied so it cannot be narrowed to a specific host at build time. `background.js` must perform the Metabase fetch (not `app.js`) so it falls under `host_permissions` rather than CSP.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `extension/manifest.json` | ✅ Done | Extension declaration, permissions, service worker config |
| `extension/background.js` | ✅ Done | All API calls, token cache, rate limiting, port/message handlers |
| `extension/index.html` | ✅ Done | Static full-tab UI (converted from `views/index.erb`) |
| `extension/app.js` | ✅ Done | Tab-side logic: org management, Chrome messaging, table, chart, export |
| `extension/lib/utils.js` | ✅ Done | Pure shared functions: row builders, IMSI rule, backoff calc |
| `extension/lib/xlsx.min.js` | ✅ Done | SheetJS — Excel export |
| `extension/lib/bootstrap.min.css` | ✅ Done | Bootstrap 5.3.3 CSS |
| `extension/lib/bootstrap.bundle.min.js` | ✅ Done | Bootstrap JS (modals, tabs) |
| `extension/lib/bootstrap-icons.min.css` | ✅ Done | Bootstrap Icons 1.11.3 CSS |
| `extension/lib/fonts/` | ✅ Done | Bootstrap Icons woff/woff2 webfonts |
| `extension/lib/chart.min.js` | ✅ Done | Chart.js 4.4.3 |
| `tests/utils.test.js` | ✅ Done | Node.js unit tests for `lib/utils.js` pure functions |

**Still present (original server app):**

| File | Status |
|------|--------|
| `app.rb` | Leave until Task 11 |
| `Dockerfile` | Leave until Task 11 |
| `docker-compose.yml` | Leave until Task 11 |
| `Gemfile` | Leave until Task 11 |
| `config.example.yml` | Leave until Task 11 |
| `views/index.erb` | Leave until Task 11 |

---

## Completed Tasks Summary (1–8)

For full implementation details see `docs/superpowers/plans/2026-04-29-chrome-extension.md`.

**Task 1** — Scaffold extension directory; download Bootstrap 5.3.3, Bootstrap Icons 1.11.3, Chart.js 4.4.3, SheetJS; create `manifest.json`.  
**Task 2** — `extension/lib/utils.js` (pure functions) with `tests/utils.test.js` (Node.js unit tests).  
**Task 3** — `background.js`: auth flow, token cache, throttled fetch with retry/backoff.  
**Task 4** — `background.js`: `fetchAllSims`, `fetchQuotaDetail`, `checkOrgUsage`, `check` port handler.  
**Task 5** — `background.js`: `fetchAllOrders`, `handleOrdersPort`, `enrich` and `invalidateTokens` message handlers.  
**Task 6** — `extension/index.html` converted from `views/index.erb`; CDN links replaced with local `lib/` references.  
**Task 7** — `app.js`: `loadOrgs`, `createOrg`, `updateOrg`, `deleteOrg`, `runCheck`, `enrichSims`, `invalidateTokens`, `fetchOrders`, `exportConfig` — all replaced from server `fetch()` calls to Chrome APIs.  
**Task 8** — `app.js`: `exportSimsCsv`, `exportSimsExcel`, `exportOrdersCsv`, `exportOrdersExcel` implemented client-side with SheetJS.

---

## Task 9: Metabase Settings UI

The Ruby app read `metabase.public_url` and a hardcoded `parameter_id` from `config.yml`. The extension stores these in `chrome.storage.local` (written by `background.js`'s `handleEnrich`) but has no UI for the user to configure them.

**Files:**
- Modify: `extension/index.html`
- Modify: `extension/app.js`

- [ ] **Step 1: Locate the settings section in `index.html`**

```bash
grep -n "setting\|Settings\|config\|Config\|modal\|metabase" extension/index.html | head -30
```

Identify the existing settings modal or panel where the Metabase fields will be added. Note the line number.

- [ ] **Step 2: Add Metabase fields to the settings section in `index.html`**

Find the closing `</div>` or modal footer of the settings section. Insert before it:

```html
<hr class="my-3" />
<h6 class="mb-2">Metabase Enrichment <span class="text-muted fw-normal">(optional)</span></h6>
<div class="mb-2">
  <label class="form-label form-label-sm" for="mbPublicUrl">Public CSV URL</label>
  <input type="url" class="form-control form-control-sm" id="mbPublicUrl"
         placeholder="https://metabase.example.com/public/question/UUID.csv" />
  <div class="form-text">Metabase public question URL with <code>.csv</code> format appended.</div>
</div>
<div class="mb-2">
  <label class="form-label form-label-sm" for="mbParameterId">Parameter ID (template-tag UUID)</label>
  <input type="text" class="form-control form-control-sm" id="mbParameterId"
         placeholder="4c8a6f9e-7c75-4d7b-931f-90098123faf4" />
  <div class="form-text">UUID of the IMSI template tag inside the Metabase question.</div>
</div>
<button class="btn btn-sm btn-outline-secondary" id="saveMetabaseBtn">
  <i class="bi bi-save"></i> Save Metabase settings
</button>
<span class="ms-2 text-success d-none" id="metabaseSavedMsg">Saved</span>
```

- [ ] **Step 3: Load saved Metabase settings on page load in `app.js`**

Find the `DOMContentLoaded` initialisation block in `app.js` (look for `addEventListener('DOMContentLoaded'` or the init function it calls). Add inside it:

```js
chrome.storage.local.get('config', d => {
  const mb = d.config?.metabase ?? {};
  const urlEl = document.getElementById('mbPublicUrl');
  const idEl  = document.getElementById('mbParameterId');
  if (urlEl) urlEl.value = mb.public_url   ?? '';
  if (idEl)  idEl.value  = mb.parameter_id ?? '';
});
```

- [ ] **Step 4: Wire the Save button in `app.js`**

Add this handler at module level (not inside DOMContentLoaded — it uses event delegation on an element that already exists when the module runs):

```js
document.getElementById('saveMetabaseBtn')?.addEventListener('click', () => {
  const public_url   = document.getElementById('mbPublicUrl').value.trim();
  const parameter_id = document.getElementById('mbParameterId').value.trim();
  chrome.storage.local.get('config', d => {
    const config = d.config ?? {};
    config.metabase = { public_url, parameter_id };
    chrome.storage.local.set({ config }, () => {
      const msg = document.getElementById('metabaseSavedMsg');
      if (msg) {
        msg.classList.remove('d-none');
        setTimeout(() => msg.classList.add('d-none'), 2000);
      }
    });
  });
});
```

- [ ] **Step 5: Reload extension and verify Metabase settings persist**

1. Reload extension at `chrome://extensions`
2. Open the extension tab
3. Open the settings panel or modal
4. Enter a dummy URL (`https://example.com/public/question/test.csv`) and a dummy UUID
5. Click "Save Metabase settings" — verify the "Saved" message appears briefly
6. Close and reopen the tab
7. Verify both values are still populated

- [ ] **Step 6: Commit**

```bash
git add extension/index.html extension/app.js
git commit -m "feat: Metabase settings UI persisted in chrome.storage.local"
```

---

## Task 10: End-to-End Integration Test

Manual test checklist. Run with at least one real set of 1NCE credentials.

**Files:** none (manual verification)

- [ ] **Step 1: Add credentials and verify org management**

1. Open the extension tab
2. Click "Add Organisation", enter a real org name, customer number, username, and password
3. Verify the org appears in the list with a credentials indicator (has_credentials = true)
4. Edit the org name — verify the change persists after closing the tab
5. Add a second org, then delete it — verify it disappears and does not reappear after tab reload

- [ ] **Step 2: Run a full usage check**

1. Select all orgs and click Run/Check
2. Verify the progress bar advances per-org (shows org name + completed/total)
3. Verify the results table populates with SIM rows
4. Verify rows with 0 MB remaining are highlighted in red
5. Verify rows with > 0 and < 10 MB remaining are highlighted in yellow/orange
6. Verify rows with ≥ 10 MB remaining have a blank IMSI column
7. Verify rows with < 10 MB remaining (and no fetch error) show the IMSI value
8. Verify rows with a `fetch_error` have a blank IMSI column
9. Click a portal link — verify it opens the correct 1NCE portal URL for that ICCID

- [ ] **Step 3: Test exports**

Run: `node --test tests/utils.test.js` — all tests must pass before proceeding.

Export CSV (all SIMs):
- Click "Export CSV" → file `sims_usage.csv` downloads
- Open in a spreadsheet app
- Verify first row headers match exactly: `Organisation, Customer Number, ICCID, Label, MSISDN, IMSI, IP Address, SIM Status, Remaining Data (MB), Total Data (MB), Expiry Date, Quota Status, Portal Link, Advizeo Infra, Advizeo Admin`

Export Excel (all SIMs):
- Click "Export Excel" → file `sims_usage.xlsx` downloads
- Open in Excel or LibreOffice
- Verify one sheet per org named `OrgName (CustomerNumber)` (truncated to 31 chars)
- Verify a `Summary` sheet if more than one org was checked

Export config:
- Click "Export Config" → file `config.json` downloads
- Open in a text editor
- Verify no `password` fields are present

- [ ] **Step 4: Test Metabase enrichment (if a Metabase instance is available)**

1. Enter Metabase Public CSV URL and Parameter ID in settings
2. Run a check
3. After results load, trigger enrichment for low-data SIMs
4. Verify the Advizeo Infra and Advizeo Admin columns populate for matched IMSIs
5. Export Excel — verify infra/admin columns contain clickable URLs in the spreadsheet

- [ ] **Step 5: Test the Orders tab**

1. Switch to the Orders tab
2. Select a date range (e.g. last 90 days) and click Load/Refresh
3. Verify the orders table populates and the per-org spend chart renders
4. Export Orders CSV → open in a spreadsheet → verify first row headers match exactly: `Organisation, Customer Number, Order Number, Order Date, Order Type, Order Status, Invoice Number, Amount, Currency, SIM Count, Products`
5. Export Orders Excel → verify per-org sheets and Summary sheet

- [ ] **Step 6: Test token invalidation**

1. Run a check to completion (tokens are now cached in the service worker)
2. Click "Invalidate tokens" (or the equivalent button)
3. Run another check — verify it completes successfully (it will re-authenticate)

- [ ] **Step 7: Test service worker recovery**

1. Run a check to completion
2. Wait 60+ seconds without interacting with the extension (service worker will terminate)
3. Run another check — verify it completes without any error or manual intervention

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: complete E2E verification of Chrome extension conversion"
```

---

## Task 11: Remove Old Server Files (Separate PR)

Do not proceed until Task 10 is complete and the extension has been used successfully in real operation. Remove the Ruby/Sinatra server files in a dedicated PR to preserve them in git history without blocking the extension.

**Files to delete:**
- `app.rb`
- `Dockerfile`
- `docker-compose.yml`
- `Gemfile`
- `Gemfile.lock` (if present)
- `config.example.yml`
- `views/` (directory)

**Files to update:**
- `README.md` — replace Docker install/run instructions with Chrome extension instructions

- [ ] **Step 1: Confirm the extension passes all Task 10 checks**

Do not proceed until all Task 10 steps are verified.

- [ ] **Step 2: Remove server files**

```bash
git rm app.rb Dockerfile docker-compose.yml Gemfile config.example.yml
git rm -r views/
```

Check for Gemfile.lock:

```bash
git ls-files Gemfile.lock | xargs git rm 2>/dev/null || true
```

- [ ] **Step 3: Update README.md**

Replace the Docker Compose / `docker run` sections with:

```markdown
## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Click the 1NCE Usage Checker icon in the toolbar to open the app

## Configuration

Click the extension icon to open it, then use the **Add Organisation** button to add your
1NCE credentials. Credentials are stored locally in Chrome's encrypted storage and never
leave your machine.

## Running unit tests

```bash
node --test tests/utils.test.js
```

Requires Node.js 18+. No npm install needed.
```

- [ ] **Step 4: Commit and open a PR**

```bash
git add README.md
git commit -m "chore: remove Docker/Sinatra server files, update README for Chrome extension"
```

Open a PR titled `chore: remove Docker server files post-extension-conversion`.

---

## Patterns Observed from advizeo-generic-readout-deleter

The reference extension (`C:\Users\thoma\Documents\advizeo-generic-readout.-deleter`) follows the same no-build, zero-dependency MV3 approach. Key patterns already matched by this extension:

| Pattern | Reference | This extension |
|---------|-----------|----------------|
| No build step | ✅ Load unpacked | ✅ Same |
| Zero npm dependencies | ✅ Pure vanilla JS | ✅ Same |
| All libs bundled in `lib/` | ✅ | ✅ Same |
| Manifest V3 | ✅ | ✅ Same |
| No CDN links | ✅ | ✅ Same |

**Pattern not yet matched — optional enhancement:**

The reference extension has a comprehensive browser-based test suite (`tests/test.html`, 50+ tests) that loads the app in an iframe with `?test=1` and runs tests against `window.__mvd__`. This project currently has only Node.js unit tests for `lib/utils.js`. Adding a `tests/test.html` browser test suite for the `app.js` UI layer (org management, table rendering, export functions) would match this pattern and improve confidence in the UI logic. This is **out of scope** for the current conversion but noted for a follow-up task.
