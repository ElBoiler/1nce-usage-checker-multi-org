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
