# Chrome Extension Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Ruby/Sinatra Docker app into a Manifest V3 Chrome extension that opens as a full browser tab with no server or Docker required.

**Architecture:** A background service worker owns all 1NCE API calls (bypassing CORS), communicating with the tab page via `chrome.runtime.connect()` long-lived ports (for `check` and `fetchOrders`) and `chrome.runtime.sendMessage()` (for short operations). All config including credentials lives in `chrome.storage.local`. Pure helper functions are extracted to `extension/lib/utils.js` so they can be unit-tested with Node.js.

**Tech Stack:** Vanilla JS (ES2022), Manifest V3, Bootstrap 5.3.3 (bundled), Bootstrap Icons 1.11.3 (bundled), Chart.js 4.4.3 (bundled), SheetJS (xlsx, bundled), Node.js for running unit tests only (not required to run the extension).

**Spec:** `docs/superpowers/specs/2026-04-29-chrome-extension-design.md`

---

## File Map

| File | Created/Modified | Responsibility |
|------|-----------------|----------------|
| `extension/manifest.json` | Create | Extension declaration, permissions, service worker |
| `extension/background.js` | Create | All API calls, token cache, rate limiting, retry, port handlers, tab opening |
| `extension/index.html` | Create | Static full-tab UI (converted from `views/index.erb`) |
| `extension/app.js` | Create | Tab-side logic: org management, port messaging, table rendering, all exports |
| `extension/lib/utils.js` | Create | Pure testable functions: row builders, IMSI blank rule, backoff calc, CSV helpers |
| `extension/lib/xlsx.min.js` | Download | SheetJS — Excel export |
| `extension/lib/bootstrap.min.css` | Download | Bootstrap 5.3.3 CSS |
| `extension/lib/bootstrap-icons.min.css` | Download | Bootstrap Icons 1.11.3 CSS |
| `extension/lib/fonts/` | Download | Bootstrap Icons webfonts |
| `extension/lib/chart.min.js` | Download | Chart.js 4.4.3 |
| `tests/utils.test.js` | Create | Node.js unit tests for `lib/utils.js` pure functions |
| `extension/lib/bootstrap.bundle.min.js` | Download | Bootstrap JS (required for modals and tabs) |

**Not touched yet:** `app.rb`, `Dockerfile`, `docker-compose.yml`, `Gemfile`, `views/` — leave in place.

---

## Task 1: Scaffold extension directory and download libs

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/lib/` (directory with downloaded assets)

- [ ] **Step 1: Create extension directory**

```bash
mkdir -p extension/lib/fonts
```

- [ ] **Step 2: Create `extension/manifest.json`**

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

**Note:** `"type": "module"` enables ES module imports in the service worker. This allows `background.js` to `import` from `lib/utils.js` (Task 3), avoiding code duplication. Supported in Chrome 102+.

**Note:** The spec's file structure diagram shows the extension's internal layout. In this repo, all extension files live under `extension/` so the existing Ruby app and extension coexist during migration.

- [ ] **Step 3: Download Bootstrap 5.3.3 CSS**

```bash
curl -L "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" -o extension/lib/bootstrap.min.css
```

- [ ] **Step 4: Download Bootstrap Icons 1.11.3**

```bash
curl -L "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" -o extension/lib/bootstrap-icons.min.css
curl -L "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2" -o extension/lib/fonts/bootstrap-icons.woff2
curl -L "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff"  -o extension/lib/fonts/bootstrap-icons.woff
```

- [ ] **Step 5: Fix font paths in the downloaded Bootstrap Icons CSS**

Open `extension/lib/bootstrap-icons.min.css` and replace the `src:` URLs. The CDN CSS references `fonts/bootstrap-icons.woff2` with a relative path — verify it looks like `url("./fonts/bootstrap-icons.woff2")` or `url("fonts/bootstrap-icons.woff2")`. If the URL is absolute (e.g. `https://cdn.jsdelivr.net/...`), replace both occurrences with:

```
url("./fonts/bootstrap-icons.woff2") format("woff2"), url("./fonts/bootstrap-icons.woff") format("woff")
```

- [ ] **Step 6: Download Chart.js 4.4.3**

```bash
curl -L "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" -o extension/lib/chart.min.js
```

- [ ] **Step 7: Download SheetJS**

```bash
curl -L "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js" -o extension/lib/xlsx.min.js
```

- [ ] **Step 8: Verify all files exist**

```bash
ls -lh extension/lib/
```

Expected output: `bootstrap.min.css`, `bootstrap-icons.min.css`, `chart.min.js`, `xlsx.min.js`, `fonts/` directory with two `.woff` files.

- [ ] **Step 9: Create empty placeholder files to avoid load errors**

```bash
touch extension/background.js extension/app.js
echo '<!DOCTYPE html><html><body>Loading…</body></html>' > extension/index.html
```

- [ ] **Step 10: Load the extension in Chrome to verify scaffold**

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked" → select the `extension/` directory
4. Verify it appears without errors
5. Click the extension icon → a tab opens showing "Loading…"

- [ ] **Step 11: Commit**

```bash
git add extension/
git commit -m "feat: scaffold Chrome extension with manifest and bundled libs"
```

---

## Task 2: Pure utility functions + unit tests

Extract all pure functions into `extension/lib/utils.js` so they can be tested without a browser or Chrome APIs.

**Files:**
- Create: `extension/lib/utils.js`
- Create: `tests/utils.test.js`

- [ ] **Step 1: Create `tests/utils.test.js` with failing tests**

```js
// Run with: node --test tests/utils.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateBackoffDelay,
  buildSimRow,
  imsiBlanked,
  rowValues,
  orderRowValues,
  parseOrderDate,
} from '../extension/lib/utils.js';

const ORG = { id: 'org1', name: 'Acme', customer_number: '12345' };
const SIM = {
  iccid: '8988211234567890123',
  imsi:  '901405000000001',
  label: 'Device A',
  msisdn: '+4915100000001',
  ip_address: '10.0.0.1',
  status: 'Enabled',
  quota_status: { status: 'EXHAUSTED' },
};

test('calculateBackoffDelay uses Retry-After when provided', () => {
  const delay = calculateBackoffDelay(1, 5000);
  assert.equal(delay, 5000);
});

test('calculateBackoffDelay uses exponential backoff without Retry-After', () => {
  // attempt 1 → base = 1000ms, jitter makes it 1000–1500ms
  const delay = calculateBackoffDelay(1, null);
  assert.ok(delay >= 1000 && delay <= 1500, `got ${delay}`);
});

test('calculateBackoffDelay caps at RETRY_MAX_DELAY', () => {
  const delay = calculateBackoffDelay(10, null);
  assert.ok(delay <= 30000 * 1.5, `got ${delay}`); // max + max jitter
});

test('buildSimRow returns correct shape', () => {
  const row = buildSimRow(ORG, SIM, 0, 500, '2026-12-31', null);
  assert.equal(row.iccid, SIM.iccid);
  assert.equal(row.org_name, 'Acme');
  assert.equal(row.remaining_mb, 0);
  assert.equal(row.fetch_error, null);
  assert.ok(row.portal_url.includes(SIM.iccid));
});

test('buildSimRow sets fetch_error when provided', () => {
  const row = buildSimRow(ORG, SIM, null, null, null, 'rate_limited');
  assert.equal(row.fetch_error, 'rate_limited');
  assert.equal(row.remaining_mb, null);
});

test('imsiBlanked: shown when remaining_mb < 10 and no error', () => {
  const row = buildSimRow(ORG, SIM, 5, 500, '2026-12-31', null);
  assert.equal(imsiBlanked(row), false); // should NOT be blanked → show IMSI
});

test('imsiBlanked: blank when remaining_mb >= 10', () => {
  const row = buildSimRow(ORG, SIM, 50, 500, '2026-12-31', null);
  assert.equal(imsiBlanked(row), true);
});

test('imsiBlanked: blank when fetch_error is set', () => {
  const row = buildSimRow(ORG, SIM, null, null, null, 'rate_limited');
  assert.equal(imsiBlanked(row), true);
});

test('imsiBlanked: blank when remaining_mb is null and no error (deliberate divergence from Ruby)', () => {
  // Ruby shows IMSI when remaining_mb is nil (unknown treated as low data).
  // JS treats null remaining_mb as unknown → blank IMSI for safety.
  // This is an intentional defensive choice; not a bug.
  const row = buildSimRow(ORG, SIM, null, null, null, null);
  assert.equal(imsiBlanked(row), true);
});

test('rowValues produces correct column order', () => {
  const row = buildSimRow(ORG, SIM, 5, 500, '2026-12-31', null);
  const vals = rowValues(row);
  assert.equal(vals[0], 'Acme');       // org_name
  assert.equal(vals[2], SIM.iccid);   // iccid
  assert.equal(vals[5], SIM.imsi);    // imsi shown (remaining < 10, no error)
  assert.equal(vals[8], 5);           // remaining_mb
});

test('rowValues shows ERROR prefix for fetch errors', () => {
  const row = buildSimRow(ORG, SIM, null, null, null, 'rate_limited');
  const vals = rowValues(row);
  assert.equal(vals[8], 'ERROR:rate_limited');
});

test('rowValues blanks IMSI for error rows', () => {
  const row = buildSimRow(ORG, SIM, null, null, null, 'rate_limited');
  const vals = rowValues(row);
  assert.equal(vals[5], '');
});

test('orderRowValues produces correct column order', () => {
  const order = {
    org_name: 'Acme', customer_number: '12345',
    order_number: 'ORD-001', order_date: '2026-01-15T10:00:00Z',
    order_type: 'SIM', order_status: 'COMPLETE',
    invoice_number: 'INV-001', invoice_amount: 99.99,
    currency: 'EUR', sim_count: 10, products: 'SIM x10',
  };
  const vals = orderRowValues(order);
  assert.equal(vals[0], 'Acme');
  assert.equal(vals[2], 'ORD-001');
  assert.equal(vals[7], 99.99);
});

test('parseOrderDate handles ISO strings', () => {
  const d = parseOrderDate('2026-01-15T10:00:00Z');
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
});

test('parseOrderDate returns null for invalid input', () => {
  assert.equal(parseOrderDate('not-a-date'), null);
  assert.equal(parseOrderDate(null), null);
});
```

- [ ] **Step 2: Run tests — verify they all fail with "not defined" errors**

```bash
node --test tests/utils.test.js 2>&1 | head -20
```

Expected: errors about missing module `extension/lib/utils.js`.

- [ ] **Step 3: Create `extension/lib/utils.js`**

```js
export const RETRY_BASE_DELAY = 1000;
export const RETRY_MAX_DELAY  = 30000;
export const MIN_REQUEST_GAP  = 250;
export const MAX_RETRIES      = 4;
export const THREAD_POOL_SIZE = 5;

export const PORTAL_URL_BASE =
  'https://portal.1nce.com/portal/customer/sims?updateSettings=true&searchTerm=iccid&iccid=';

export const SIM_HEADERS = [
  'Organisation', 'Customer Number', 'ICCID', 'Label', 'MSISDN', 'IMSI',
  'IP Address', 'SIM Status', 'Remaining Data (MB)',
  'Total Data (MB)', 'Expiry Date', 'Quota Status', 'Portal Link',
  'Advizeo Infra', 'Advizeo Admin',
];

export const ORDER_HEADERS = [
  'Organisation', 'Customer Number', 'Order Number', 'Order Date',
  'Order Type', 'Order Status', 'Invoice Number', 'Amount', 'Currency',
  'SIM Count', 'Products',
];

/**
 * @param {number} attempt - 1-based retry attempt number
 * @param {number|null} retryAfterMs - value of Retry-After header in ms, or null
 * @returns {number} delay in milliseconds
 */
export function calculateBackoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs != null && retryAfterMs > 0) return retryAfterMs;
  const base = Math.min(RETRY_BASE_DELAY * Math.pow(2, attempt - 1), RETRY_MAX_DELAY);
  return base + Math.random() * base * 0.5; // 100–150% of base
}

/** @returns {boolean} true when IMSI should be blank in exports */
export function imsiBlanked(row) {
  if (row.fetch_error != null) return true;
  if (row.remaining_mb == null) return true;
  return row.remaining_mb >= 10;
}

export function buildSimRow(org, sim, remainingMb, totalMb, expiryDate, fetchError) {
  const qs = sim.quota_status;
  const quotaStatusStr = (qs && typeof qs === 'object') ? (qs.status || JSON.stringify(qs)) : String(qs ?? '');
  const iccid = String(sim.iccid ?? '');
  return {
    iccid,
    imsi:            String(sim.imsi      ?? ''),
    label:           String(sim.label     ?? ''),
    msisdn:          String(sim.msisdn    ?? ''),
    ip_address:      String(sim.ip_address ?? ''),
    sim_status:      String(sim.status    ?? ''),
    remaining_mb:    remainingMb,
    total_mb:        totalMb,
    expiry_date:     String(expiryDate    ?? ''),
    quota_status:    quotaStatusStr,
    fetch_error:     fetchError ?? null,
    portal_url:      iccid ? `${PORTAL_URL_BASE}${iccid}` : '',
    infra_url:       '',
    admin_url:       '',
    org_id:          org.id,
    org_name:        org.name,
    customer_number: String(org.customer_number ?? ''),
  };
}

export function rowValues(row) {
  const imsiVal = imsiBlanked(row) ? '' : row.imsi;
  return [
    row.org_name,
    row.customer_number,
    row.iccid,
    row.label,
    row.msisdn,
    imsiVal,
    row.ip_address,
    row.sim_status,
    row.fetch_error ? `ERROR:${row.fetch_error}` : row.remaining_mb,
    row.total_mb,
    row.expiry_date,
    row.quota_status,
    row.portal_url,
    String(row.infra_url ?? ''),
    String(row.admin_url ?? ''),
  ];
}

export function orderRowValues(order) {
  return [
    order.org_name,
    order.customer_number,
    order.order_number,
    order.order_date,
    order.order_type,
    order.order_status,
    order.invoice_number,
    order.invoice_amount,
    order.currency,
    order.sim_count,
    order.products,
  ];
}

/** @returns {Date|null} */
export function parseOrderDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/** @returns {Promise<void>} */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run tests — verify they all pass**

```bash
node --test tests/utils.test.js
```

Expected: all tests pass, no failures.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/utils.js tests/utils.test.js
git commit -m "feat: add utils.js pure functions with unit tests"
```

---

## Task 3: Background service worker — auth and throttled fetch

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Write the token fetch and caching section of `background.js`**

Replace the empty `extension/background.js` with:

```js
// background.js is a module service worker ("type": "module" in manifest.json).
// Import shared pure functions from lib/utils.js to avoid duplication.
import {
  RETRY_BASE_DELAY, RETRY_MAX_DELAY, MAX_RETRIES,
  MIN_REQUEST_GAP, THREAD_POOL_SIZE, PORTAL_URL_BASE,
  calculateBackoffDelay, buildSimRow, sleep,
} from './lib/utils.js';

const API_BASE = 'https://api.1nce.com/management-api';

// ============================================================
// Token cache  { [orgId]: { token, expiresAt (ms timestamp) } }
// ============================================================
const TOKEN_CACHE = {};

// ============================================================
// Per-org rate limiter  { [orgId]: { lastAt: number } }
// ============================================================
const RATE_LIMITERS = {};

// ============================================================
// Tab opening
// ============================================================
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

// logArr: array to push request log entries into, or null if not logging.
async function getToken(org, logArr) {
  const cached = TOKEN_CACHE[org.id];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const creds = btoa(`${org.username}:${org.password}`);
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (logArr) {
    const summary = res.ok ? { expires_in: null } : { error: (await res.clone().text()).slice(0, 200) };
    logArr.push({ method: 'POST', path: '/oauth/token', status: res.status, response: summary });
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Auth failed for '${org.name}': HTTP ${res.status} – ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  TOKEN_CACHE[org.id] = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function throttledFetch(org, path, logArr) {
  if (!RATE_LIMITERS[org.id]) RATE_LIMITERS[org.id] = { lastAt: 0 };
  const limiter = RATE_LIMITERS[org.id];

  const elapsed = Date.now() - limiter.lastAt;
  if (elapsed < MIN_REQUEST_GAP) await sleep(MIN_REQUEST_GAP - elapsed);
  limiter.lastAt = Date.now();

  let attempt = 0;
  while (true) {
    const token = await getToken(org, logArr);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (res.status !== 429) {
      const body = await res.json().catch(() => null);
      if (logArr) logArr.push({ method: 'GET', path, status: res.status, response: body });
      return { status: res.status, body, headers: res.headers };
    }

    attempt++;
    if (attempt > MAX_RETRIES) return { status: 429, body: null, headers: res.headers };

    const retryAfter = res.headers.get('Retry-After');
    const delay = calculateBackoffDelay(attempt, retryAfter ? parseFloat(retryAfter) * 1000 : null);
    await sleep(delay);
    limiter.lastAt = Date.now();
  }
}

// buildSimRow, calculateBackoffDelay, sleep imported from lib/utils.js above.
```

- [ ] **Step 2: Reload the extension in Chrome and verify no console errors**

1. Go to `chrome://extensions`
2. Click the reload icon on the extension card
3. Click the extension icon → tab opens
4. Open DevTools on the background service worker (click "Service Worker" link on the extension card)
5. Verify no JS errors in the console

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat: background service worker auth, token cache, throttled fetch"
```

---

## Task 4: Background service worker — SIM fetch, quota fetch, check handler

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Add SIM and quota fetch functions**

Append to `extension/background.js`:

```js
// ============================================================
// SIM fetching
// ============================================================

async function fetchAllSims(org, logArr) {
  const sims = [];
  let page = 1;
  while (true) {
    const { status, body, headers } = await throttledFetch(
      org, `/v1/sims?pageSize=100&page=${page}`, logArr
    );
    if (status !== 200) break;
    const page_sims = Array.isArray(body) ? body : [];
    sims.push(...page_sims);
    const totalPages = parseInt(headers.get('X-Total-Pages') ?? '1', 10);
    if (page >= totalPages) break;
    page++;
  }
  return sims;
}

async function fetchQuotaDetail(org, iccid, logArr) {
  const { status, body } = await throttledFetch(
    org, `/v1/sims/${iccid}/quota/data`, logArr
  );
  if (status === 429) return { fetch_error: 'rate_limited' };
  if (status !== 200 || !body || typeof body !== 'object') return { fetch_error: `http_${status}` };
  return {
    volume_mb:       parseFloat(body.volume)        ?? 0,
    total_volume_mb: parseFloat(body.total_volume)  ?? 0,
    expiry_date:     body.expiry_date ?? '',
  };
}

// logArr is an array to push request log entries into, or null if not logging.
async function checkOrgUsage(org, logArr, onProgress) {
  if (logArr) await getToken(org, logArr); // pre-warm auth log
  const sims = await fetchAllSims(org, logArr);
  const results = [];
  const total = sims.length;
  let completed = 0;

  // Process sims in chunks of THREAD_POOL_SIZE
  for (let i = 0; i < sims.length; i += THREAD_POOL_SIZE) {
    const chunk = sims.slice(i, i + THREAD_POOL_SIZE);
    const chunkResults = await Promise.all(chunk.map(async sim => {
      const quota = await fetchQuotaDetail(org, sim.iccid, logArr);
      const error   = quota.fetch_error ?? null;
      const rem     = error ? null : quota.volume_mb;
      const total_v = error ? null : quota.total_volume_mb;
      const expiry  = error ? null : quota.expiry_date;
      return buildSimRow(org, sim, rem, total_v, expiry, error);
    }));
    results.push(...chunkResults);
    completed += chunk.length;
    if (onProgress) onProgress(completed, total);
  }
  return results;
}
```

- [ ] **Step 2: Add the long-lived port handler for `check`**

Append to `extension/background.js`:

```js
// ============================================================
// Long-lived port: 'check'
// ============================================================

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'check') handleCheckPort(port);
  if (port.name === 'fetchOrders') handleOrdersPort(port);
});

async function handleCheckPort(port) {
  const msg = await new Promise(r => port.onMessage.addListener(r));
  const { orgId, verbose } = msg;

  const config = await new Promise(r => chrome.storage.local.get('config', d => r(d.config ?? {})));
  let orgs = config.organizations ?? [];
  if (orgId) orgs = orgs.filter(o => o.id === orgId);

  if (orgs.length === 0) {
    port.postMessage({ type: 'error', message: 'No organisations configured' });
    return;
  }

  const allResults = [];
  const errors     = [];
  const reqLog     = verbose ? [] : null;

  for (const org of orgs) {
    const orgLog = verbose ? [] : null;
    try {
      const results = await checkOrgUsage(org, orgLog, (done, total) => {
        port.postMessage({ type: 'progress', org_name: org.name, completed: done, total });
      });
      allResults.push(...results);
    } catch (e) {
      errors.push({ org_id: org.id, org_name: org.name, error: e.message });
    }
    if (verbose && orgLog) reqLog.push(...orgLog.map(e => ({ ...e, org_name: org.name })));
  }

  port.postMessage({ type: 'done', results: allResults, errors, request_log: reqLog });
}
```

- [ ] **Step 3: Reload extension and verify no console errors in service worker DevTools**

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat: background SIM fetch, quota fetch, check port handler"
```

---

## Task 5: Background service worker — orders and enrich handlers

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Add orders fetch function**

Append to `extension/background.js`:

```js
// ============================================================
// Orders fetching
// ============================================================

// Orders fetches are intentionally not logged (matching Ruby app.rb behaviour —
// fetch_all_orders never receives req_log). Verbose logging only covers SIM checks.
async function fetchAllOrders(org, startMs, endMs) {
  const orders = [];
  let page = 1;
  while (true) {
    const { status, body } = await throttledFetch(
      org, `/v1/orders?pageSize=10&page=${page}&sort=order_date`, null
    );
    // Break on error OR empty page (API returns empty array before total_pages is reached)
    if (status !== 200 || !Array.isArray(body) || body.length === 0) break;

    for (const order of body) {
      const orderDate = order.order_date ? new Date(order.order_date) : null;
      if (startMs && orderDate && orderDate.getTime() < startMs) continue;
      if (endMs   && orderDate && orderDate.getTime() > endMs)   continue;
      const amount = parseFloat(String(order.invoice_amount ?? '0').replace(',', '.')) || 0;
      orders.push({
        order_number:    order.order_number,
        order_type:      String(order.order_type ?? ''),
        order_date:      String(order.order_date ?? ''),
        order_status:    String(order.order_status ?? ''),
        invoice_number:  String(order.invoice_number ?? ''),
        invoice_amount:  amount,
        currency:        String(order.currency ?? ''),
        sim_count:       (order.sims ?? []).length,
        products:        (order.products ?? []).map(p => `${p.id} x${p.quantity}`).join(', '),
        org_id:          org.id,
        org_name:        org.name,
        customer_number: String(org.customer_number ?? ''),
      });
    }
    page++;
  }
  return orders;
}

async function handleOrdersPort(port) {
  const msg = await new Promise(r => port.onMessage.addListener(r));
  const { orgId, startDate, endDate } = msg;

  const config = await new Promise(r => chrome.storage.local.get('config', d => r(d.config ?? {})));
  let orgs = config.organizations ?? [];
  if (orgId) orgs = orgs.filter(o => o.id === orgId);

  if (orgs.length === 0) {
    port.postMessage({ type: 'error', message: 'No organisations configured' });
    return;
  }

  const startMs = startDate ? new Date(startDate).getTime() : Date.now() - 365 * 24 * 3600 * 1000;
  const endMs   = endDate   ? new Date(endDate).getTime()   : Date.now();

  const allOrders = [];
  const errors    = [];

  await Promise.all(orgs.map(async org => {
    try {
      const orders = await fetchAllOrders(org, startMs, endMs);
      allOrders.push(...orders);
    } catch (e) {
      errors.push({ org_id: org.id, org_name: org.name, error: e.message });
    }
  }));

  port.postMessage({ type: 'done', results: allOrders, errors });
}
```

- [ ] **Step 2: Add enrich and invalidateTokens message handlers**

Append to `extension/background.js`:

```js
// ============================================================
// Short messages: enrich + invalidateTokens
// ============================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'invalidateTokens') {
    Object.keys(TOKEN_CACHE).forEach(k => delete TOKEN_CACHE[k]);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'enrich') {
    handleEnrich(msg.imsis).then(sendResponse);
    return true; // async
  }
});

async function handleEnrich(imsis) {
  const config = await new Promise(r => chrome.storage.local.get('config', d => r(d.config ?? {})));
  const mbCfg = config.metabase ?? {};
  const publicUrl   = (mbCfg.public_url   ?? '').trim();
  const parameterId = (mbCfg.parameter_id ?? '').trim();

  if (!publicUrl || !imsis.length) return { enriched: {} };

  const params = JSON.stringify([{
    type: 'category', value: imsis.map(String), id: parameterId,
    target: ['variable', ['template-tag', 'imsi']],
  }]);
  const url = `${publicUrl}?parameters=${encodeURIComponent(params)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return { enriched: {}, error: `Metabase HTTP ${res.status}` };
    const text = await res.text();
    return { enriched: parseMetabaseCSV(text) };
  } catch (e) {
    return { enriched: {}, error: e.message };
  }
}

function parseMetabaseCSV(csvText) {
  const lines = csvText.split('\n').filter(Boolean);
  if (lines.length < 2) return {};
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').toLowerCase());
  const col = name => headers.findIndex(h => h.includes(name));
  const iCol = col('imsi'), sCol = col('serial'), infCol = col('infra'), admCol = col('admin');
  if (iCol < 0) return {};

  const enriched = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.replace(/^"|"$/g, ''));
    const imsi = cells[iCol]?.trim();
    if (!imsi) continue;
    enriched[imsi] = {
      serial_number: sCol >= 0 ? cells[sCol] ?? '' : '',
      infra_url:     infCol >= 0 ? cells[infCol] ?? '' : '',
      admin_url:     admCol >= 0 ? cells[admCol] ?? '' : '',
    };
  }
  return enriched;
}
```

- [ ] **Step 3: Reload extension and verify service worker starts without errors**

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat: background orders fetch, enrich handler, token invalidation"
```

---

## Task 6: Convert `index.erb` to `index.html`

The ERB view is almost pure HTML/CSS/JS — no Ruby template variables are used (the app is fully AJAX-driven). The only changes needed are: replace CDN links with local `lib/` references, and remove the Sinatra-specific `<% %>` tags if any exist.

**Files:**
- Modify: `extension/index.html`

- [ ] **Step 1: Copy the ERB file as the starting point**

```bash
cp views/index.erb extension/index.html
```

- [ ] **Step 2: Replace CDN stylesheet links**

Find these lines in `extension/index.html`:

```html
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" />
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
```

Replace with:

```html
<link href="lib/bootstrap.min.css" rel="stylesheet" />
<link href="lib/bootstrap-icons.min.css" rel="stylesheet" />
<script src="lib/chart.min.js"></script>
```

- [ ] **Step 3: Scan for ERB tags and confirm there are none**

```bash
grep -n "<%\|%>" extension/index.html
```

Expected: no output. If any ERB tags are found, remove them or convert to static HTML.

- [ ] **Step 4: Find the inline `<script>` block at the bottom of the file**

```bash
grep -n "<script" extension/index.html | tail -5
```

Note the line number where the main JavaScript block starts.

- [ ] **Step 5: Extract the inline script to `extension/app.js`**

- Cut everything between `<script>` and `</script>` (the last script block) from `index.html`
- Paste it into `extension/app.js`
- Replace the inline block in `index.html` with:

```html
<script src="lib/xlsx.min.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 6: Add Bootstrap JS bundle**

Download Bootstrap's JS bundle (required for modals, tabs, etc.):

```bash
curl -L "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" -o extension/lib/bootstrap.bundle.min.js
```

Add before `app.js` in `index.html`, and change `app.js` to a module so it can import from `lib/utils.js`:

```html
<script src="lib/bootstrap.bundle.min.js"></script>
<script src="lib/xlsx.min.js"></script>
<script type="module" src="app.js"></script>
```

**Note:** `type="module"` is required so `app.js` can `import` from `lib/utils.js`. Remove any earlier `<script src="lib/xlsx.min.js">` tag added in Step 5 to avoid loading it twice. SheetJS attaches to `window.XLSX` when loaded as a classic script; as a module, access it via the global after the classic script runs first.

- [ ] **Step 7: Reload extension, open tab, verify the UI renders correctly**

1. Reload extension at `chrome://extensions`
2. Click icon → tab opens
3. Verify: top bar, tab navigation, org list panel, main content area all render
4. Check browser DevTools console for errors

- [ ] **Step 8: Commit**

```bash
git add extension/index.html extension/lib/bootstrap.bundle.min.js
git commit -m "feat: convert index.erb to static index.html with bundled libs"
```

---

## Task 7: `app.js` — replace server API calls with Chrome messaging

The extracted `app.js` currently calls `/api/orgs`, `/api/check`, `/api/enrich`, etc. via `fetch()`. Replace each with the appropriate Chrome storage or message API call.

**Files:**
- Modify: `extension/app.js`

- [ ] **Step 0: Discover existing function names before replacing anything**

```bash
grep -n "function \|const .* = async\|async function" extension/app.js | head -60
```

Use this output to map the existing function names to the replacements in Steps 1–10 below. If a function in the plan (e.g. `loadOrgs`) doesn't match the existing name (e.g. `fetchOrganisations`), replace the existing function in-place rather than adding a duplicate.

- [ ] **Step 1: Replace org list loading (`GET /api/orgs`)**

Find the function that fetches `/api/orgs` (probably called `loadOrgs` or similar). Replace with:

```js
async function loadOrgs() {
  return new Promise(resolve => {
    chrome.storage.local.get('config', data => {
      const orgs = (data.config?.organizations ?? []).map(o => ({
        id:              o.id,
        name:            o.name,
        customer_number: o.customer_number,
        has_credentials: !!o.username,
      }));
      resolve(orgs);
    });
  });
}
```

- [ ] **Step 2: Replace org create (`POST /api/orgs`)**

Find the function that posts to `/api/orgs`. Replace with:

```js
async function createOrg(data) {
  return new Promise(resolve => {
    chrome.storage.local.get('config', d => {
      const config = d.config ?? { organizations: [] };
      config.organizations = config.organizations ?? [];
      const org = {
        id:              crypto.randomUUID().slice(0, 16).replace(/-/g, ''),
        name:            data.name.trim(),
        customer_number: (data.customer_number ?? '').trim(),
        username:        data.username.trim(),
        password:        data.password ?? '',
      };
      config.organizations.push(org);
      chrome.storage.local.set({ config }, () => resolve({ id: org.id, name: org.name }));
    });
  });
}
```

- [ ] **Step 3: Replace org update (`PUT /api/orgs/:id`)**

```js
async function updateOrg(id, data) {
  return new Promise(resolve => {
    chrome.storage.local.get('config', d => {
      const config = d.config ?? {};
      const org = (config.organizations ?? []).find(o => o.id === id);
      if (!org) return resolve({ error: 'Not found' });
      if (data.name?.trim())            org.name            = data.name.trim();
      if (data.customer_number != null) org.customer_number = data.customer_number.trim();
      if (data.username?.trim())        org.username        = data.username.trim();
      if (data.password)                org.password        = data.password;
      chrome.storage.local.set({ config }, () => resolve({ success: true }));
    });
  });
}
```

- [ ] **Step 4: Replace org delete (`DELETE /api/orgs/:id`)**

```js
async function deleteOrg(id) {
  return new Promise(resolve => {
    chrome.storage.local.get('config', d => {
      const config = d.config ?? {};
      config.organizations = (config.organizations ?? []).filter(o => o.id !== id);
      chrome.storage.local.set({ config }, () => resolve({ success: true }));
    });
  });
}
```

- [ ] **Step 5: Replace the check call (`GET /api/check`) with a long-lived port**

Find the function that calls `/api/check`. Replace with:

```js
function runCheck(orgId, verbose) {
  const port = chrome.runtime.connect({ name: 'check' });
  port.postMessage({ orgId, verbose });

  port.onMessage.addListener(msg => {
    if (msg.type === 'progress') {
      updateProgress(msg.org_name, msg.completed, msg.total);
    } else if (msg.type === 'done') {
      onCheckDone(msg.results, msg.errors, msg.request_log);
    } else if (msg.type === 'error') {
      onCheckError(msg.message);
    }
  });
}
```

Wire `updateProgress`, `onCheckDone`, and `onCheckError` to the existing UI update functions (rename/adapt as needed to match the existing function names in `app.js`).

- [ ] **Step 6: Replace enrich call (`POST /api/enrich`)**

```js
async function enrichSims(imsis) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'enrich', imsis }, response => {
      resolve(response ?? { enriched: {} });
    });
  });
}
```

- [ ] **Step 7: Replace token invalidation call**

```js
async function invalidateTokens() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'invalidateTokens' }, resolve);
  });
}
```

- [ ] **Step 8: Replace orders fetch (`GET /api/orders`)**

```js
function fetchOrders(orgId, startDate, endDate) {
  const port = chrome.runtime.connect({ name: 'fetchOrders' });
  port.postMessage({ orgId, startDate, endDate });

  port.onMessage.addListener(msg => {
    if (msg.type === 'done') onOrdersDone(msg.results, msg.errors);
    if (msg.type === 'error') onOrdersError(msg.message);
  });
}
```

- [ ] **Step 9: Replace export calls (`POST /api/export`, `POST /api/export/orders`)**

The existing `app.js` likely sends rows to the server for formatting. Replace with client-side CSV/Excel generation using the functions from `lib/utils.js` and SheetJS. See Task 8 for the full export implementation.

- [ ] **Step 10: Replace config export (`GET /api/export/config`)**

```js
function exportConfig() {
  chrome.storage.local.get('config', d => {
    const config = d.config ?? {};
    const safe = {
      ...config,
      organizations: (config.organizations ?? []).map(({ password: _pw, ...rest }) => rest),
    };
    downloadBlob(JSON.stringify(safe, null, 2), 'config.json', 'application/json');
  });
}
```

- [ ] **Step 11: Add `downloadBlob` helper if not already present**

```js
function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 12: Reload and test org management**

1. Reload extension
2. Open tab
3. Add an org via the UI
4. Verify it appears in the list
5. Edit the org name
6. Delete the org
7. Verify each action persists after closing and re-opening the tab

- [ ] **Step 13: Commit**

```bash
git add extension/app.js
git commit -m "feat: replace server API calls with Chrome storage and message API"
```

---

## Task 8: `app.js` — client-side CSV and Excel export

**Files:**
- Modify: `extension/app.js`

The existing `app.js` probably calls `POST /api/export` to generate exports server-side. Replace with client-side generation.

- [ ] **Step 0: Add import at the top of `app.js`**

`app.js` is now a module (`type="module"` added in Task 6). Add this import at the very top of `extension/app.js`:

```js
import { SIM_HEADERS, ORDER_HEADERS, imsiBlanked, rowValues, orderRowValues } from './lib/utils.js';
```

This replaces any inline re-declarations of these items in Task 8 steps below. Do not re-declare `SIM_HEADERS`, `ORDER_HEADERS`, `imsiBlanked`, or `orderRowValues` in `app.js`.

**Note:** The spec's `manifest.json` snippet omits `"type": "module"` for brevity. The plan's `manifest.json` (Task 1, Step 2) is authoritative.

- [ ] **Step 1: Add SIM CSV export**

```js
function exportSimsCsv(rows, exhaustedOnly) {
  const sorted = [...rows].sort((a, b) =>
    a.org_name.localeCompare(b.org_name) || a.iccid.localeCompare(b.iccid)
  );
  const lines = [SIM_HEADERS, ...sorted.map(r => rowValues(r))];
  const csv = lines.map(row =>
    row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');
  const fname = exhaustedOnly ? 'sims_no_data.csv' : 'sims_usage.csv';
  downloadBlob(csv, fname, 'text/csv;charset=utf-8');
}
```

- [ ] **Step 2: Add SIM Excel export using SheetJS**

```js
// SIM_HEADERS and rowValues imported from lib/utils.js — do not re-declare.
function exportSimsExcel(rows, exhaustedOnly) {
  const sorted = [...rows].sort((a, b) =>
    a.org_name.localeCompare(b.org_name) || a.iccid.localeCompare(b.iccid)
  );
  const orgNames = [...new Set(sorted.map(r => r.org_name))];
  const wb = XLSX.utils.book_new();

  for (const orgName of orgNames) {
    const orgRows = sorted.filter(r => r.org_name === orgName);
    const custNum = orgRows[0]?.customer_number ?? '';
    const sheetName = `${orgName} (${custNum})`.slice(0, 31);
    const ws = XLSX.utils.aoa_to_sheet([SIM_HEADERS, ...orgRows.map(r => rowValues(r))]);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  if (orgNames.length > 1) {
    const summaryData = [
      ['Organisation', 'Customer Number', 'SIMs Listed', 'Checked At'],
      ...orgNames.map(name => {
        const orgRows = sorted.filter(r => r.org_name === name);
        return [name, orgRows[0]?.customer_number, orgRows.length, new Date().toISOString()];
      }),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary');
  }

  const fname = exhaustedOnly ? 'sims_no_data.xlsx' : 'sims_usage.xlsx';
  XLSX.writeFile(wb, fname);
}
```

- [ ] **Step 3: Add orders CSV and Excel export**

```js
// ORDER_HEADERS and orderRowValues imported from lib/utils.js — do not re-declare.

function exportOrdersCsv(rows) {
  const sorted = [...rows].sort((a, b) =>
    a.org_name.localeCompare(b.org_name) || a.order_date.localeCompare(b.order_date)
  );
  const lines = [ORDER_HEADERS, ...sorted.map(orderRowValues)];
  const csv = lines.map(row =>
    row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');
  downloadBlob(csv, 'orders.csv', 'text/csv;charset=utf-8');
}

// ORDER_HEADERS and orderRowValues imported from lib/utils.js — do not re-declare.
function exportOrdersExcel(rows) {
  const sorted = [...rows].sort((a, b) =>
    a.org_name.localeCompare(b.org_name) || a.order_date.localeCompare(b.order_date)
  );
  const orgNames = [...new Set(sorted.map(r => r.org_name))];
  const wb = XLSX.utils.book_new();

  for (const orgName of orgNames) {
    const orgRows = sorted.filter(r => r.org_name === orgName);
    const custNum = orgRows[0]?.customer_number ?? '';
    const sheetName = `${orgName} (${custNum})`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ORDER_HEADERS, ...orgRows.map(r => orderRowValues(r))]), sheetName);
  }

  if (orgNames.length > 1) {
    const summaryData = [
      ['Organisation', 'Customer Number', 'Orders', 'Total Amount', 'Currency'],
      ...orgNames.map(name => {
        const orgRows = sorted.filter(r => r.org_name === name);
        const total = orgRows.reduce((s, r) => s + (r.invoice_amount ?? 0), 0).toFixed(2);
        const currency = [...new Set(orgRows.map(r => r.currency))].join('/');
        return [name, orgRows[0]?.customer_number, orgRows.length, parseFloat(total), currency];
      }),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary');
  }

  XLSX.writeFile(wb, 'orders.xlsx');
}
```

- [ ] **Step 4: Wire export buttons in `app.js` to new functions**

Find the export button click handlers (likely `exportData('csv')`, `exportData('excel')` or similar) and replace the `fetch('/api/export', ...)` calls with the new local functions.

- [ ] **Step 5: Reload extension and test exports**

1. Run a check against a real org (or use mocked data if available)
2. Click "Export CSV" → verify a `.csv` file downloads
3. Click "Export Excel" → verify a `.xlsx` file downloads and opens correctly in Excel/LibreOffice
4. Verify the IMSI column is blank for SIMs with ≥10 MB remaining

- [ ] **Step 6: Commit**

```bash
git add extension/app.js
git commit -m "feat: client-side CSV and Excel export using SheetJS"
```

---

## Task 9: Metabase settings UI

The current app reads Metabase config from `config.yml`. Add a settings section to the UI for `metabase.public_url` and `metabase.parameter_id`.

**Files:**
- Modify: `extension/index.html`
- Modify: `extension/app.js`

- [ ] **Step 1: Add Metabase settings fields to the existing settings/config modal in `index.html`**

Find the existing org management modal or settings section. Add:

```html
<hr class="my-3" />
<h6 class="mb-2">Metabase Enrichment <span class="text-muted fw-normal">(optional)</span></h6>
<div class="mb-2">
  <label class="form-label form-label-sm">Public CSV URL</label>
  <input type="url" class="form-control form-control-sm" id="mbPublicUrl"
         placeholder="https://metabase.example.com/public/question/UUID.csv" />
</div>
<div class="mb-2">
  <label class="form-label form-label-sm">Parameter ID (template-tag UUID)</label>
  <input type="text" class="form-control form-control-sm" id="mbParameterId"
         placeholder="4c8a6f9e-7c75-4d7b-931f-90098123faf4" />
</div>
<button class="btn btn-sm btn-outline-secondary" id="saveMetabaseBtn">Save Metabase settings</button>
```

- [ ] **Step 2: Wire the save button in `app.js`**

```js
document.getElementById('saveMetabaseBtn')?.addEventListener('click', () => {
  const public_url   = document.getElementById('mbPublicUrl').value.trim();
  const parameter_id = document.getElementById('mbParameterId').value.trim();
  chrome.storage.local.get('config', d => {
    const config = d.config ?? {};
    config.metabase = { public_url, parameter_id };
    chrome.storage.local.set({ config });
  });
});
```

- [ ] **Step 3: Load saved Metabase settings on page load**

In the `app.js` initialisation function (called on `DOMContentLoaded`), add:

```js
chrome.storage.local.get('config', d => {
  const mb = d.config?.metabase ?? {};
  const urlEl = document.getElementById('mbPublicUrl');
  const idEl  = document.getElementById('mbParameterId');
  if (urlEl) urlEl.value = mb.public_url   ?? '';
  if (idEl)  idEl.value  = mb.parameter_id ?? '';
});
```

- [ ] **Step 4: Reload and verify Metabase settings persist**

- [ ] **Step 5: Commit**

```bash
git add extension/index.html extension/app.js
git commit -m "feat: Metabase settings UI persisted in chrome.storage.local"
```

---

## Task 10: End-to-end integration test

Manual test checklist. Run through each scenario with real 1NCE credentials loaded into the extension.

**Files:** none

- [ ] **Step 1: Load credentials**

1. Open the extension tab
2. Add at least one org with real credentials
3. Verify it appears in the org list with a "credentials set" indicator

- [ ] **Step 2: Run a usage check**

1. Select "All orgs" (or a specific org)
2. Click Run / Check
3. Verify progress bar advances per-org
4. Verify the results table populates with SIM data
5. Verify rows with 0 MB are highlighted in red
6. Verify rows with < some threshold MB are highlighted in yellow
7. Verify the 1NCE portal link on each row is correct

- [ ] **Step 3: Test IMSI column blanking**

1. In the results table, find a SIM with ≥ 10 MB remaining
2. Verify its IMSI column is empty
3. Find a SIM with < 10 MB remaining and no error
4. Verify its IMSI is shown

- [ ] **Step 4: Test exports**

1. Export CSV → open in a spreadsheet → verify column headers match expected order
2. Export Excel → open in Excel/LibreOffice → verify per-org sheets + summary sheet
3. Export config → verify passwords are absent from the downloaded file

- [ ] **Step 5: Test Metabase enrichment (if configured)**

1. Set Metabase URL and parameter ID in settings
2. Run a check
3. Verify infra/admin URL columns are populated for low-data SIMs

- [ ] **Step 6: Test orders tab**

1. Switch to the Orders tab
2. Click Fetch Orders
3. Verify orders table populates
4. Export orders CSV and Excel

- [ ] **Step 7: Test token invalidation**

1. Run a check (tokens are cached)
2. Click "Invalidate tokens"
3. Run another check — verify it re-authenticates (watch for the auth log entry if verbose mode is on)

- [ ] **Step 8: Test service worker recovery**

1. Run a check
2. Wait 60+ seconds (service worker may be killed)
3. Run another check — verify it completes successfully without manual action

- [ ] **Step 9: Commit final state**

```bash
git add -A
git commit -m "feat: Chrome extension — complete conversion from Docker/Sinatra"
```

---

## Task 11: Clean up old Docker files (optional, separate PR)

Leave `app.rb`, `Gemfile`, `Dockerfile`, `docker-compose.yml`, `views/` in place until the extension is confirmed working in production use. Remove them in a follow-up PR to avoid losing reference code prematurely.
