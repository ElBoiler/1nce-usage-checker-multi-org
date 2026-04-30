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
  const delay = calculateBackoffDelay(1, null);
  assert.ok(delay >= 1000 && delay <= 1500, `got ${delay}`);
});

test('calculateBackoffDelay caps at RETRY_MAX_DELAY', () => {
  const delay = calculateBackoffDelay(10, null);
  assert.ok(delay <= 30000 * 1.5, `got ${delay}`);
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
  assert.equal(imsiBlanked(row), false);
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
  // Ruby shows IMSI when remaining_mb is nil. JS treats null as unknown → blank for safety.
  const row = buildSimRow(ORG, SIM, null, null, null, null);
  assert.equal(imsiBlanked(row), true);
});

test('rowValues produces correct column order', () => {
  const row = buildSimRow(ORG, SIM, 5, 500, '2026-12-31', null);
  const vals = rowValues(row);
  assert.equal(vals[0], 'Acme');
  assert.equal(vals[2], SIM.iccid);
  assert.equal(vals[5], SIM.imsi);
  assert.equal(vals[8], 5);
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
