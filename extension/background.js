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

// ============================================================
// Auth
// logArr: array to push request log entries into, or null if not logging.
// ============================================================
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

  if (!res.ok) {
    const errText = await res.text();
    if (logArr) logArr.push({ method: 'POST', path: '/oauth/token', status: res.status, response: { error: errText.slice(0, 200) } });
    throw new Error(`Auth failed for '${org.name}': HTTP ${res.status} – ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  if (logArr) logArr.push({ method: 'POST', path: '/oauth/token', status: res.status, response: { expires_in: data.expires_in } });
  TOKEN_CACHE[org.id] = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// ============================================================
// Throttled fetch with retry on 429
// logArr: array to push request log entries into, or null if not logging.
// ============================================================
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
    volume_mb:       parseFloat(body.volume)       || 0,
    total_volume_mb: parseFloat(body.total_volume) || 0,
    expiry_date:     body.expiry_date ?? '',
  };
}

// logArr: array to push request log entries into, or null if not logging.
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

// ============================================================
// Long-lived port: 'check'
// MV3 service workers are terminated after ~30s idle.
// chrome.runtime.connect() keeps the worker alive for the duration.
// ============================================================

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'check')        handleCheckPort(port);
  if (port.name === 'fetchOrders')  handleOrdersPort(port);
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

// Orders fetches are intentionally not logged (matching Ruby app.rb behaviour —
// fetch_all_orders never receives req_log). Verbose logging only covers SIM checks.
// onProgress(page, collected) is called after each successful page fetch so the
// caller can emit a Chrome API call (port.postMessage) to keep the MV3 service
// worker alive – without it Chrome terminates the SW after ~30s of "idle"
// (native fetch/setTimeout don't count as Chrome API activity).
async function fetchAllOrders(org, startMs, endMs, onProgress) {
  const orders = [];
  let page = 1;
  while (true) {
    const { status, body } = await throttledFetch(
      org, `/v1/orders?pageSize=10&page=${page}&sort=order_date`, null
    );

    if (page === 1 && status !== 200) {
      const detail = body ? ` – ${JSON.stringify(body).slice(0, 200)}` : '';
      throw new Error(`Orders API returned HTTP ${status}${detail}`);
    }
    // Break on error OR empty page (API may return empty array before total_pages is reached)
    if (status !== 200 || !Array.isArray(body) || body.length === 0) break;

    // Heartbeat – keeps the MV3 SW alive via a Chrome API call each page
    if (onProgress) onProgress(page, orders.length + body.length);

    const pageDates = body
      .map(o => o.order_date ? new Date(o.order_date).getTime() : null)
      .filter(d => d !== null);

    // Early exit: ascending sort → first date > endMs means all remaining pages are also past end
    if (pageDates.length > 0 && pageDates.every(d => d > endMs)) break;
    // Early exit: descending sort → last date < startMs means all remaining pages are before start
    if (pageDates.length > 0 && pageDates.every(d => d < startMs)) break;

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
        sims:            (order.sims ?? []).map(s =>
          typeof s === 'string'
            ? { iccid: s, imsi: '' }
            : { iccid: String(s.iccid ?? ''), imsi: String(s.imsi ?? '') }
        ),
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
  const { orgIds, startDate, endDate } = msg;

  const config = await new Promise(r => chrome.storage.local.get('config', d => r(d.config ?? {})));
  let orgs = config.organizations ?? [];
  if (orgIds && orgIds.length > 0) orgs = orgs.filter(o => orgIds.includes(o.id));

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
      const orders = await fetchAllOrders(org, startMs, endMs, (page, count) => {
        // port.postMessage is a Chrome API call → resets the SW idle timer
        port.postMessage({ type: 'progress', org_name: org.name, page, count });
      });
      allOrders.push(...orders);
    } catch (e) {
      errors.push({ org_id: org.id, org_name: org.name, error: e.message });
    }
  }));

  port.postMessage({ type: 'done', results: allOrders, errors });
}

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
    return true; // keep message channel open for async response
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
