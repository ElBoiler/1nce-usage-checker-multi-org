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

// Placeholder — will be implemented in Task 5
async function handleOrdersPort(port) {
  port.postMessage({ type: 'error', message: 'Not yet implemented' });
}
