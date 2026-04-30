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
