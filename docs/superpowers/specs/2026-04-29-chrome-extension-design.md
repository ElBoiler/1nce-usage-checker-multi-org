# 1NCE Usage Checker — Chrome Extension Design

**Date:** 2026-04-29  
**Status:** Approved  
**Goal:** Convert the existing Ruby/Sinatra Docker app into a Manifest V3 Chrome extension that opens as a full browser tab, with no server or Docker required.

---

## Problem

The current app requires Docker to run. Non-technical users or environments without Docker cannot use it. The core blocker for a plain static web page is CORS — the 1NCE management API does not support browser cross-origin requests. A Chrome extension service worker bypasses CORS entirely, making a zero-server approach viable.

---

## Architecture

### File structure

```
1nce-usage-checker-extension/
├── manifest.json       # Extension declaration
├── background.js       # Service worker — all API calls, token cache, rate limiting
├── index.html          # Full-tab UI
├── app.js              # Tab-side logic — org management, messages, table, export
└── lib/
    ├── xlsx.min.js     # SheetJS (bundled locally)
    ├── bootstrap.min.css
    ├── bootstrap-icons.min.css
    ├── fonts/          # Bootstrap Icons webfonts
    └── chart.min.js    # Chart.js (bundled locally)
```

All third-party dependencies (Bootstrap 5.3.3, Bootstrap Icons 1.11.3, Chart.js 4.4.3, SheetJS) are bundled locally in `lib/`. No CDN links — CDN requests require a relaxed `content_security_policy` in the manifest and internet access at page-load time; bundling avoids both.

No build step. Load via Chrome → Extensions → Load unpacked.

### Permissions (`manifest.json`)

```json
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "host_permissions": [
    "https://api.1nce.com/*",
    "<all_urls>"
  ],
  "background": { "service_worker": "background.js" },
  "action": { "default_title": "1NCE Usage Checker" }
}
```

**`<all_urls>`** is required because the Metabase enrichment endpoint URL is user-configured at runtime and unknown at build time. On personal/internal use this is fine. If the extension is ever published to the Chrome Web Store, this triggers an extended review process — document the justification in the store listing. Alternative: if Metabase's public CSV endpoint allows CORS, the fetch can be done directly from `app.js` and `<all_urls>` can be narrowed; test at implementation time.

**Note:** `chrome.tabs.create()` (used to open the full-tab UI) does **not** require the `"tabs"` permission — do not add it.

**Note:** `chrome.storage.local` does not require a separate permission declaration beyond `"storage"`.

**Note:** No `content_security_policy` override is needed. The MV3 default (`script-src 'self'; object-src 'self'`) is satisfied by bundled scripts. `host_permissions` (not CSP) governs what `fetch()` in `background.js` can reach, so the Metabase URL is covered by `<all_urls>` without any CSP change.

---

## Tab Opening

Clicking the extension icon opens a new tab. In MV3 this requires a listener in `background.js`:

```js
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
```

The manifest `action` block must **not** include a `default_popup` — the two mechanisms are mutually exclusive.

---

## Data Flow

```
app.js  →  chrome.runtime.connect({ name: 'check' | 'fetchOrders' })  (long-lived ports)
app.js  →  chrome.runtime.sendMessage(...)                            (short messages)
                     ↓
background.js  →  fetch(https://api.1nce.com/...)
                     ↓
background.js  →  port.postMessage(data) / sendResponse(data)
                     ↓
app.js  →  render result / show error
```

The tab page never calls `fetch()` directly. All network I/O lives in `background.js`.

### Long-lived port for `check`

MV3 service workers are terminated by Chrome after ~30 seconds of inactivity. A `check` operation against a large org (hundreds of SIMs, each needing a `/quota/data` call) can run for several minutes. Using `chrome.runtime.sendMessage` would silently fail if the service worker is killed mid-check — `app.js` would never receive a response.

Solution: use `chrome.runtime.connect()` for the `check` and `fetchOrders` operations. An open port keeps the service worker alive for its duration. `background.js` listens on `chrome.runtime.onConnect` and posts incremental progress messages (e.g. `{ type: 'progress', completed: 42, total: 150 }`) followed by a final `{ type: 'done', results, errors }` or `{ type: 'error', message }`.

### Message API

**Short messages (sendMessage / sendResponse):**

| `action`           | Payload                            | Background does                                           | Response shape           |
|--------------------|------------------------------------|-----------------------------------------------------------|--------------------------|
| `enrich`           | `{ imsis: string[] }`              | Fetches Metabase public CSV, parses IMSI→enrichment map   | `{ enriched, error? }`   |
| `invalidateTokens` | —                                  | Clears in-memory token cache                              | `{ ok: true }`           |

**Long-lived ports (connect / postMessage):**

| Port `name`    | Payload                                        | Background streams                                             |
|----------------|------------------------------------------------|----------------------------------------------------------------|
| `check`        | `{ orgId?, verbose? }`                         | Progress updates, then `{ type: 'done', results, errors, requestLog? }` |
| `fetchOrders`  | `{ orgId?, startDate?, endDate? }`             | Progress updates, then `{ type: 'done', results, errors }`     |

**Note on `detailed`:** The Ruby app accepted a `detailed` query param but the implementation **always** fetched `/quota/data` per SIM regardless of its value. The JS port does the same — quota fetch is unconditional. The `detailed` param is dropped entirely from the message API.

---

## Config & Credentials

Stored in `chrome.storage.local` as:

```json
{
  "organizations": [
    {
      "id": "abc12345",
      "name": "ACME GmbH",
      "customer_number": "10012345",
      "username": "admin@acme.example.com",
      "password": "super-secret-password"
    }
  ],
  "metabase": {
    "public_url": "https://metabase.example.com/public/question/UUID.csv",
    "parameter_id": "4c8a6f9e-7c75-4d7b-931f-90098123faf4"
  }
}
```

`metabase.parameter_id` is the Metabase template-tag UUID used to build the `parameters` query string. The Ruby app hardcoded this; the JS port makes it configurable per installation via the settings UI.

**Security:** `chrome.storage.local` is encrypted at rest on platforms that support it (ChromeOS, macOS with Keychain integration). On Windows it relies on OS-level user account isolation rather than explicit encryption. For a single-user personal tool this is acceptable. Passwords are read only inside `background.js` and are **never sent back to `app.js`**. The UI exposes `has_credentials: true/false` only.

---

## Concurrency & Rate Limiting

Direct port of the Ruby logic to JavaScript. **All delays use milliseconds** (JS `setTimeout`) where the Ruby source uses seconds (`sleep`).

| Constant | Ruby value | JS value | Purpose |
|----------|-----------|----------|---------|
| `THREAD_POOL_SIZE` | 5 | 5 | Max concurrent quota/data fetches per org |
| `MAX_RETRIES` | 4 | 4 | Retry attempts on HTTP 429 |
| `RETRY_BASE_DELAY` | 1.0 s | 1000 ms | Base for exponential backoff |
| `RETRY_MAX_DELAY` | 30.0 s | 30000 ms | Backoff ceiling |
| `MIN_REQUEST_GAP` | 0.25 s | 250 ms | Minimum gap between request starts per org |

- **Paged SIM fetch** — sequential per page, stops when current page ≥ `X-Total-Pages`
- **Quota fetches** — async queue: slice SIM list into chunks of 5, `await Promise.all(chunk)` sequentially
- **Throttling** — per-org `lastRequestAt` timestamp; `await sleep(Math.max(0, MIN_REQUEST_GAP - elapsed))` before each request start
- **Retry** — on 429, honour `Retry-After` header or use exponential backoff with ±50% jitter; after `MAX_RETRIES` exhausted, return `{ fetch_error: 'rate_limited' }`

---

## Token Cache

In-memory object in `background.js`:

```js
// { [orgId]: { token: string, expiresAt: number (ms timestamp) } }
const TOKEN_CACHE = {};
```

Resets when the service worker is killed. On next check the service worker re-authenticates transparently. No user action required.

---

## Feature Parity

| Feature | Current (Ruby) | Extension (JS) |
|---------|---------------|----------------|
| Add / edit / delete orgs | `POST/PUT/DELETE /api/orgs` | `chrome.storage.local` read/write in `app.js` |
| Passwords write-only in UI | Server never returns password field | `app.js` never receives passwords from background |
| Check all orgs or one org | `GET /api/check?org_id=` | `check` port with optional `orgId` |
| Per-SIM quota fetch (always) | `/v1/sims/:iccid/quota/data` (unconditional) | Same endpoint via background, `detailed` flag dropped |
| Metabase enrichment | `POST /api/enrich` with hardcoded UUID | `enrich` message; UUID stored in config |
| Verbose/debug request log | `?verbose=true` query param | `verbose: true` in port payload |
| Export CSV | `POST /api/export?format=csv` | `Blob` + `<a download>` in `app.js` |
| Export Excel | write_xlsx gem, sheet per org + summary | SheetJS in `app.js`, same structure |
| Export orders (CSV + Excel) | `POST /api/export/orders` | Same pattern with SheetJS |
| Export config (redacted) | `GET /api/export/config` | JS stringify, passwords removed, `Blob` download |
| Token invalidation | `POST /api/tokens/invalidate` | `invalidateTokens` message |
| 1NCE portal link per SIM | `https://portal.1nce.com/...?iccid=` | Same URL construction in JS |
| Orders date filtering | Default: last 365 days; filter after fetching all pages (API has no date-range param); paging stops early on empty-data response, not just on page ≥ total_pages | Same: fetch all pages with early-exit on empty array, filter in background; default start = now − 365 days |
| IMSI blanking in exports | IMSI is shown (non-blank) only when `remaining_mb < 10` **and** `fetch_error` is nil; blank in all other cases (high data or API error rows) | Same business rule in JS export helpers |

**Intentionally removed:** Docker, Dockerfile, docker-compose.yml, Gemfile, `app.rb`, `config.yml` on disk, Sinatra server.

---

## UI

Convert `views/index.erb` to a static `index.html`. All ERB template logic (loops, conditionals) becomes JavaScript DOM manipulation in `app.js`. CDN links replaced with local `lib/` references. No visual changes.

The extension `action` click opens a new tab via `chrome.tabs.create({ url: chrome.runtime.getURL('index.html') })` in `background.js`.

---

## Out of Scope

- Any cloud sync or shared config between users
- Automated scheduled checks
- Authentication to the extension itself
