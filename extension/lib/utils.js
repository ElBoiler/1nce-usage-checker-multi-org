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
  'Order Type', 'Order Status', 'Invoice Number', 'Order Amount',
  'Amount per SIM', 'Currency', 'ICCID', 'IMSI', 'Products',
];

/**
 * @param {number} attempt - 1-based retry attempt number
 * @param {number|null} retryAfterMs - value of Retry-After header in ms, or null
 * @returns {number} delay in milliseconds
 */
export function calculateBackoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs != null && retryAfterMs > 0) return retryAfterMs;
  const base = Math.min(RETRY_BASE_DELAY * Math.pow(2, attempt - 1), RETRY_MAX_DELAY);
  return base + Math.random() * base * 0.5;
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

/**
 * Expands one order into one row per SIM card. Orders with no SIMs
 * (e.g. TARIFF_CHANGE, TOPUP) still emit a single row with blank ICCID/IMSI
 * so the order is never dropped from the export.
 * @returns {Array<Array>} one or more row value-arrays
 */
export function orderSimRows(order) {
  const sims = order.sims ?? [];
  // Order amount is the total for the whole order; per-SIM is total / SIM count,
  // rounded to one decimal place. All values are emitted as strings.
  const amountPerSim = sims.length > 0
    ? ((order.invoice_amount ?? 0) / sims.length).toFixed(2)
    : '';
  const base = [
    String(order.org_name ?? ''),
    String(order.customer_number ?? ''),
    String(order.order_number ?? ''),
    String(order.order_date ?? ''),
    String(order.order_type ?? ''),
    String(order.order_status ?? ''),
    String(order.invoice_number ?? ''),
    String(order.invoice_amount ?? ''),
    amountPerSim,
    String(order.currency ?? ''),
  ];
  const products = String(order.products ?? '');
  if (sims.length === 0) return [[...base, '', '', products]];
  return sims.map(s => [...base, String(s.iccid ?? ''), String(s.imsi ?? ''), products]);
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
