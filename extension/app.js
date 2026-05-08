import { SIM_HEADERS, ORDER_HEADERS, rowValues, orderRowValues } from './lib/utils.js';

// ===========================================================================
// State
// ===========================================================================
let allResults      = [];    // raw API results
let filteredResults = [];    // after filter/search
let orgs            = [];    // org list
let selectedOrgIds  = new Set();
let currentFilter   = 'problems';
let sortField       = 'remaining_mb';
let sortAsc         = true;
let orgModal, deleteModal, settingsModal;

// ===========================================================================
// Init
// ===========================================================================
// Dark mode: restore preference before first paint
(function() {
  if (localStorage.getItem('darkMode') === '1') {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    document.body.classList.add('dark');
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  orgModal      = new bootstrap.Modal(document.getElementById('orgModal'));
  deleteModal   = new bootstrap.Modal(document.getElementById('deleteModal'));
  settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));

  // Sync toggle icon after DOM ready
  if (document.body.classList.contains('dark'))
    document.getElementById('darkToggleBtn').innerHTML = '<i class="bi bi-sun-fill"></i>';

  // -------------------------------------------------------------------------
  // Wire all static onclick handlers via addEventListener (MV3 module scope)
  // -------------------------------------------------------------------------

  // Top bar
  document.getElementById('darkToggleBtn')?.addEventListener('click', toggleDark);
  document.getElementById('btnSettings')?.addEventListener('click', openSettingsModal);
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings);

  // Org sidebar
  document.getElementById('btnSelectAllOrgs')?.addEventListener('click', selectAllOrgs);
  document.getElementById('btnDeselectAllOrgs')?.addEventListener('click', deselectAllOrgs);
  document.getElementById('btnAddOrg')?.addEventListener('click', () => openOrgModal());

  // Check buttons
  document.getElementById('btnCheckAll')?.addEventListener('click', () => checkUsage(null));
  document.getElementById('btnCheckOne')?.addEventListener('click', () => checkUsage([...selectedOrgIds]));
  document.getElementById('btnInvalidateTokens')?.addEventListener('click', invalidateTokens);

  // Usage export
  document.getElementById('btnExportCsv')?.addEventListener('click', () => exportData('csv'));
  document.getElementById('btnExportExcel')?.addEventListener('click', () => exportData('excel'));
  document.getElementById('btnExportConfig')?.addEventListener('click', exportConfig);

  // Orders sidebar
  document.getElementById('btnOrderOrgsAll')?.addEventListener('click', () => setAllOrderOrgs(true));
  document.getElementById('btnOrderOrgsNone')?.addEventListener('click', () => setAllOrderOrgs(false));
  document.getElementById('btnLoadOrders')?.addEventListener('click', loadOrders);

  // Orders export
  document.getElementById('btnExportOrdersCsv')?.addEventListener('click', () => exportOrders('csv'));
  document.getElementById('btnExportOrdersExcel')?.addEventListener('click', () => exportOrders('excel'));

  // Activity log
  document.getElementById('logHeader')?.addEventListener('click', toggleLog);
  document.getElementById('btnClearLog')?.addEventListener('click', (e) => { e.stopPropagation(); clearLog(); });
  document.getElementById('verboseLogWrapper')?.addEventListener('click', e => e.stopPropagation());

  // Password toggle
  document.getElementById('togglePw')?.addEventListener('click', togglePassword);

  // Org modal save
  document.getElementById('orgSaveBtn')?.addEventListener('click', saveOrg);

  // Filter tabs (static; dynamic filter tabs built by buildOrderFilterTabs use event delegation)
  document.querySelectorAll('[data-filter]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); setFilter(el.dataset.filter); });
  });

  // Search / filter inputs
  document.getElementById('searchInput')?.addEventListener('input', applyFilters);
  document.getElementById('orgFilter')?.addEventListener('change', applyFilters);
  document.getElementById('orderSearchInput')?.addEventListener('input', applyOrderFilters);
  document.getElementById('orderOrgFilter')?.addEventListener('change', applyOrderFilters);

  // Table sort headers — usage
  document.querySelectorAll('[data-sortby]').forEach(el => {
    el.addEventListener('click', () => sortBy(el.dataset.sortby));
  });

  // Table sort headers — orders
  document.querySelectorAll('[data-sortorders]').forEach(el => {
    el.addEventListener('click', () => sortOrdersBy(el.dataset.sortorders));
  });

  // Static orders filter tab (the initial "All" tab in HTML)
  document.querySelectorAll('[data-ofilter]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); setOrderFilter(el.dataset.ofilter); });
  });

  // Auto-load orders on first tab switch
  document.getElementById('tab-orders-btn')?.addEventListener('shown.bs.tab', () => {
    if (!ordersLoaded) loadOrders();
  });

  // Show/hide custom date range
  document.querySelectorAll('input[name="orderPeriod"]').forEach(input => {
    input.addEventListener('change', () => {
      document.getElementById('customDateRange').style.display =
        document.getElementById('periodCustom').checked ? '' : 'none';
    });
  });

  loadOrgs();
});

// ===========================================================================
// Chrome storage helpers — org CRUD
// ===========================================================================
async function loadOrgs() {
  return new Promise(resolve => {
    chrome.storage.local.get('config', data => {
      const orgList = (data.config?.organizations ?? []).map(o => ({
        id:              o.id,
        name:            o.name,
        customer_number: o.customer_number,
        has_credentials: !!o.username,
      }));
      orgs = orgList;
      orgs.sort((a, b) => a.name.localeCompare(b.name));
      renderOrgList();
      resolve(orgs);
    });
  });
}

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

async function deleteOrg(id) {
  return new Promise(resolve => {
    chrome.storage.local.get('config', d => {
      const config = d.config ?? {};
      config.organizations = (config.organizations ?? []).filter(o => o.id !== id);
      chrome.storage.local.set({ config }, () => resolve({ success: true }));
    });
  });
}

// ===========================================================================
// Org management — UI
// ===========================================================================
function renderOrgList() {
  const el = document.getElementById('orgList');
  if (!orgs.length) {
    el.innerHTML = `<div class="text-center text-muted py-3" style="font-size:.8rem">
      No organisations yet.<br/>Click <strong>Add</strong> to get started.
    </div>`;
    return;
  }

  el.innerHTML = orgs.map(o => `
    <div class="org-item ${selectedOrgIds.has(o.id) ? 'active' : ''}"
         id="orgItem_${o.id}" data-orgid="${o.id}">
      <input type="checkbox" class="form-check-input flex-shrink-0" style="pointer-events:none"
             ${selectedOrgIds.has(o.id) ? 'checked' : ''} />
      <div class="flex-grow-1 overflow-hidden">
        <div class="text-truncate" title="${esc(o.name)}">${esc(o.name)}</div>
        <div style="font-size:.7rem; color:#888">${esc(o.customer_number || '–')}</div>
      </div>
      <span class="badge ${o.has_credentials ? 'bg-success' : 'bg-warning text-dark'} badge-cred ms-auto"
            title="${o.has_credentials ? 'Credentials set' : 'No credentials'}">
        <i class="bi ${o.has_credentials ? 'bi-lock-fill' : 'bi-unlock-fill'}"></i>
      </span>
      <button class="btn btn-sm p-0 ms-1 btn-edit-org" data-editid="${o.id}" style="font-size:.78rem; color:#888" title="Edit">
        <i class="bi bi-pencil"></i>
      </button>
      <button class="btn btn-sm p-0 ms-1 btn-delete-org" data-deleteid="${o.id}" data-deletename="${esc(o.name)}" style="font-size:.78rem; color:#c00" title="Remove">
        <i class="bi bi-trash"></i>
      </button>
    </div>
  `).join('');

  // Delegate click events for dynamically rendered org items
  el.querySelectorAll('[data-orgid]').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't toggle selection if edit/delete button was clicked
      if (e.target.closest('.btn-edit-org') || e.target.closest('.btn-delete-org')) return;
      selectOrg(item.dataset.orgid);
    });
  });
  el.querySelectorAll('.btn-edit-org').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openOrgModal(btn.dataset.editid); });
  });
  el.querySelectorAll('.btn-delete-org').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); confirmDelete(btn.dataset.deleteid, btn.dataset.deletename); });
  });

  // Org filter dropdown in usage table
  const sel = document.getElementById('orgFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All orgs</option>' +
    orgs.map(o => `<option value="${o.id}" ${o.id === cur ? 'selected' : ''}>${esc(o.name)}</option>`).join('');

  // Org filter dropdown in orders table
  const osel = document.getElementById('orderOrgFilter');
  if (osel) {
    const ocur = osel.value;
    osel.innerHTML = '<option value="">All orgs</option>' +
      orgs.map(o => `<option value="${o.id}" ${o.id === ocur ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  }

  renderOrdersOrgFilter();
  updateExportLabel();
}

function selectOrg(id) {
  if (selectedOrgIds.has(id)) selectedOrgIds.delete(id);
  else selectedOrgIds.add(id);
  updateSelectedOrgUI();
  renderOrgList();
  updateExportLabel();
}

function updateSelectedOrgUI() {
  const count = selectedOrgIds.size;
  document.getElementById('btnCheckOne').disabled = count === 0;
  const countEl = document.getElementById('selectedOrgCount');
  if (countEl) countEl.textContent = count > 0 ? `(${count})` : '';
}

function selectAllOrgs() {
  orgs.forEach(o => selectedOrgIds.add(o.id));
  updateSelectedOrgUI();
  renderOrgList();
  updateExportLabel();
}

function deselectAllOrgs() {
  selectedOrgIds.clear();
  updateSelectedOrgUI();
  renderOrgList();
  updateExportLabel();
}

function updateExportLabel() {
  let label;
  if (selectedOrgIds.size === 0) {
    label = 'All orgs';
  } else if (selectedOrgIds.size === 1) {
    const org = orgs.find(o => selectedOrgIds.has(o.id));
    label = org ? org.name : '1 org';
  } else {
    label = `${selectedOrgIds.size} orgs selected`;
  }
  document.getElementById('exportScopeLabel').textContent = label;
}

// Modal helpers
function openOrgModal(id = null) {
  const editing = !!id;
  document.getElementById('orgModalTitle').textContent = editing ? 'Edit Organisation' : 'Add Organisation';
  document.getElementById('orgModalId').value          = id || '';
  document.getElementById('orgName').value             = '';
  document.getElementById('orgCustomerNumber').value   = '';
  document.getElementById('orgUsername').value         = '';
  document.getElementById('orgPassword').value         = '';
  document.getElementById('orgUsernameHint').textContent  = '';
  document.getElementById('orgPasswordHint').textContent  = '';
  document.getElementById('pwRequired').style.display     = editing ? 'none' : '';

  if (editing) {
    const o = orgs.find(x => x.id === id);
    if (o) {
      document.getElementById('orgName').value           = o.name;
      document.getElementById('orgCustomerNumber').value = o.customer_number || '';
      document.getElementById('orgUsernameHint').textContent  = 'Leave blank to keep existing value';
      document.getElementById('orgPasswordHint').textContent  = 'Leave blank to keep existing password';
    }
  }

  orgModal.show();
}

async function saveOrg() {
  const id   = document.getElementById('orgModalId').value;
  const body = {
    name:            document.getElementById('orgName').value.trim(),
    customer_number: document.getElementById('orgCustomerNumber').value.trim(),
    username:        document.getElementById('orgUsername').value.trim(),
    password:        document.getElementById('orgPassword').value
  };

  if (!body.name) { flash('danger', 'Organisation name is required.'); return; }
  if (!id && !body.username) { flash('danger', 'Username is required for new organisations.'); return; }

  let result;
  if (id) {
    result = await updateOrg(id, body);
  } else {
    result = await createOrg(body);
  }

  if (result.error) { flash('danger', result.error || 'Save failed.'); return; }

  orgModal.hide();
  flash('success', id ? 'Organisation updated.' : 'Organisation added.');
  await loadOrgs();
}

function confirmDelete(id, name) {
  document.getElementById('deleteOrgName').textContent = name;
  document.getElementById('confirmDeleteBtn').onclick  = () => doDeleteOrg(id);
  deleteModal.show();
}

async function doDeleteOrg(id) {
  await deleteOrg(id);
  deleteModal.hide();
  selectedOrgIds.delete(id);
  updateSelectedOrgUI();
  await loadOrgs();
  // Remove from results
  allResults = allResults.filter(r => r.org_id !== id);
  applyFilters();
}

function togglePassword() {
  const inp = document.getElementById('orgPassword');
  const btn = document.getElementById('togglePw');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.innerHTML = inp.type === 'password' ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
}

// ===========================================================================
// Usage check — Chrome long-lived port
// ===========================================================================
async function checkUsage(orgIds) {
  document.getElementById('btnCheckAll').disabled = true;
  document.getElementById('btnCheckOne').disabled = true;
  document.getElementById('alertArea').innerHTML  = '';
  document.getElementById('emptyState').style.display = 'none';

  setLogOpen(true);

  const orgsToCheck = (orgIds && orgIds.length) ? orgs.filter(o => orgIds.includes(o.id)) : [...orgs];
  if (!orgsToCheck.length) {
    flash('danger', 'No organisations to check.');
    document.getElementById('btnCheckAll').disabled = false;
    return;
  }

  log(`Starting check for ${orgsToCheck.length} organisation(s)…`, 'info');
  showProgress(`Checking ${orgsToCheck.length} organisation(s)…`);

  // If checking specific orgs, preserve results for orgs not being checked
  if (orgIds && orgIds.length) {
    allResults = allResults.filter(r => !orgIds.includes(r.org_id));
  } else {
    allResults = [];
  }

  const verbose = document.getElementById('verboseLog').checked;

  // Fire one port per org sequentially (background handles concurrency)
  for (const org of orgsToCheck) {
    log(`→ ${org.name} (${org.customer_number || 'no cust. no.'}) — requesting quota data…`, 'info');
    await new Promise(resolve => {
      const port = chrome.runtime.connect({ name: 'check' });
      port.postMessage({ orgId: org.id, verbose });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        log(`  ✗ ${org.name}: service worker disconnected`, 'error');
        resolve(); // unblock the loop
      });
      port.onMessage.addListener(msg => {
        if (msg.type === 'progress') {
          showProgress(`Checking ${org.name}…`);
        } else if (msg.type === 'done') {
          const results   = msg.results || [];
          const exhausted = results.filter(r => r.remaining_mb === 0).length;
          const low       = results.filter(r => r.remaining_mb > 0 && r.remaining_mb < 10).length;
          const ok        = results.length - exhausted - low;
          log(`  ✓ ${results.length} SIMs — ${exhausted} exhausted, ${low} low, ${ok} ok`, 'success');

          if (msg.request_log && msg.request_log.length) {
            msg.request_log.forEach(entry => {
              const resp = entry.response ? '  ' + JSON.stringify(entry.response) : '';
              const type = entry.status >= 400 ? 'error' : 'info';
              log(`    ${entry.method} ${entry.path} → ${entry.status}${resp}`, type);
            });
          }

          if (msg.errors && msg.errors.length) {
            msg.errors.forEach(e => {
              log(`  ⚠ ${e.org_name}: ${e.error}`, 'warn');
              flash('warning', `<strong>${esc(e.org_name)}:</strong> ${esc(e.error)}`);
            });
          }

          allResults = allResults.filter(r => r.org_id !== org.id).concat(results);
          resolve();
        } else if (msg.type === 'error') {
          log(`  ✗ ${org.name}: ${msg.message}`, 'error');
          flash('warning', `<strong>${esc(org.name)}:</strong> ${esc(msg.message)}`);
          resolve();
        }
      });
    });
  }

  const totalExhausted = allResults.filter(r => !r.fetch_error && r.remaining_mb <= 0).length;
  const totalErrors    = allResults.filter(r => r.fetch_error).length;
  const errNote        = totalErrors ? `, ${totalErrors} API errors` : '';
  log(`Done — ${allResults.length} SIMs across ${orgsToCheck.length} org(s), ${totalExhausted} exhausted${errNote}`, 'info');

  document.getElementById('lastCheckedLabel').textContent =
    'Last checked: ' + new Date().toLocaleTimeString();

  hideProgress();
  document.getElementById('btnCheckAll').disabled = false;
  updateSelectedOrgUI();
  applyFilters();
  updateStats();
  await enrichResults();
}

// ===========================================================================
// Filtering & Sorting
// ===========================================================================
function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('[data-filter]').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === f);
  });
  applyFilters();
}

function applyFilters() {
  const q      = document.getElementById('searchInput').value.toLowerCase();
  const orgF   = document.getElementById('orgFilter').value;

  filteredResults = allResults.filter(r => {
    const exhausted = !r.fetch_error && r.remaining_mb <= 0;
    const low       = !r.fetch_error && r.remaining_mb > 0 && r.remaining_mb < 10;
    if (currentFilter === 'problems'  && !exhausted && !low) return false;
    if (currentFilter === 'exhausted' && !exhausted) return false;
    if (currentFilter === 'low'       && !low) return false;
    if (orgF && r.org_id !== orgF) return false;
    if (q) {
      const hay = (r.iccid + r.label + r.msisdn + r.ip_address).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  sortResults();
  renderTable();
}

function sortBy(field) {
  if (sortField === field) sortAsc = !sortAsc;
  else { sortField = field; sortAsc = true; }
  sortResults();
  renderTable();
}

function sortResults() {
  filteredResults.sort((a, b) => {
    let va = a[sortField], vb = b[sortField];
    // Nulls always sort last (ascending) or first (descending)
    if (va === null && vb === null) return 0;
    if (va === null) return sortAsc ? 1 : -1;
    if (vb === null) return sortAsc ? -1 : 1;
    if (typeof va === 'number') return sortAsc ? va - vb : vb - va;
    va = String(va || '').toLowerCase();
    vb = String(vb || '').toLowerCase();
    return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
}

// ===========================================================================
// Table rendering
// ===========================================================================
function renderTable() {
  const tbody = document.getElementById('simTableBody');

  if (!filteredResults.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center text-muted py-4">No SIMs match the current filter.</td></tr>`;
  } else {
    tbody.innerHTML = filteredResults.map(r => {
      const isError    = !!r.fetch_error;
      const isExhaust  = !isError && r.remaining_mb <= 0;
      const isLow      = !isError && r.remaining_mb > 0 && r.remaining_mb < 10;
      const rowClass   = isError ? '' : isExhaust ? 'row-exhausted' : isLow ? 'row-low' : 'row-ok';
      let   volLabel;
      if (isError) {
        volLabel = `<span class="badge bg-secondary" title="${esc(r.fetch_error)}">API Error</span>`;
      } else if (r.remaining_mb <= 0) {
        volLabel = `<span class="vol-badge vol-zero">${r.remaining_mb < 0 ? r.remaining_mb.toFixed(2) + ' MB' : '0 MB'}</span>`;
      } else if (r.remaining_mb < 1) {
        volLabel = `<span class="vol-badge vol-low">${(r.remaining_mb * 1024).toFixed(1)} KB</span>`;
      } else {
        volLabel = `<span class="vol-badge vol-ok">${r.remaining_mb.toFixed(2)} MB</span>`;
      }
      const totLabel = r.total_mb != null ? r.total_mb.toFixed(0) + ' MB' : '–';
      const expLabel = r.expiry_date ? r.expiry_date.substring(0,10) : '–';
      const iccid    = esc(r.iccid);

      return `<tr class="${rowClass}">
        <td class="text-truncate" style="max-width:120px" title="${esc(r.org_name)}">${esc(r.org_name)}</td>
        <td>
          <span class="font-monospace" style="font-size:.78rem">${iccid}</span>
          <i class="bi bi-clipboard iccid-copy ms-1" data-copy="${iccid}" title="Copy ICCID"></i>
        </td>
        <td style="text-align:center">
          ${r.portal_url
            ? `<a href="${r.portal_url}" target="_blank" rel="noopener" title="Open in 1NCE portal" style="font-size:.85rem; color:var(--brand-primary)"><i class="bi bi-box-arrow-up-right"></i></a>`
            : ''}
        </td>
        <td class="font-monospace" style="font-size:.75rem; white-space:nowrap">
          ${r.infra_url
            ? `<a href="${r.infra_url}" target="_blank" rel="noopener" title="Open in Advizeo infrastructure">${esc(r.serial_number) || '<i class="bi bi-hdd-network"></i>'}</a>`
            : r.serial_number ? esc(r.serial_number) : '<span class="text-muted">–</span>'}
        </td>
        <td style="text-align:center">
          ${r.admin_url
            ? `<a href="${r.admin_url}" target="_blank" rel="noopener" title="Open in Comgy admin" style="font-size:.85rem; color:var(--brand-primary)"><i class="bi bi-gear"></i></a>`
            : ''}
        </td>
        <td>${esc(r.label) || '<span class="text-muted">–</span>'}</td>
        <td class="font-monospace" style="font-size:.78rem">${esc(r.msisdn) || '–'}</td>
        <td class="font-monospace" style="font-size:.78rem">${(isExhaust || isLow) && r.imsi ? esc(r.imsi) : '<span class="text-muted">–</span>'}</td>
        <td>${simStatusBadge(r.sim_status)}</td>
        <td>${volLabel}</td>
        <td style="color:#999; font-size:.78rem">${totLabel}</td>
        <td style="font-size:.78rem">${expLabel}</td>
      </tr>`;
    }).join('');

    // Wire ICCID copy icons (dynamically rendered)
    tbody.querySelectorAll('[data-copy]').forEach(el => {
      el.addEventListener('click', () => copy(el.dataset.copy));
    });
  }

  document.getElementById('rowCount').textContent = filteredResults.length;
  showTableArea();
}

function simStatusBadge(status) {
  if (!status) return '<span class="text-muted">–</span>';
  const cls = status.toLowerCase() === 'enabled' ? 'bg-success' : 'bg-secondary';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function showTableArea() {
  document.getElementById('tableCard').style.display     = '';
  document.getElementById('tableControls').style.display = '';
  document.getElementById('statsRow').style.display      = '';
  document.getElementById('emptyState').style.display    = 'none';
}

function updateStats() {
  const orgIds = [...new Set(allResults.map(r => r.org_id))];

  let totalEx = 0, totalLow = 0;

  const rows = orgIds.map(oid => {
    const rs       = allResults.filter(r => r.org_id === oid);
    const name     = rs[0].org_name;
    const total    = rs.length;
    const errors   = rs.filter(r => r.fetch_error).length;
    const exhaust  = rs.filter(r => !r.fetch_error && r.remaining_mb <= 0).length;
    const low      = rs.filter(r => !r.fetch_error && r.remaining_mb > 0 && r.remaining_mb < 10).length;
    const ok       = total - exhaust - low - errors;
    totalEx += exhaust; totalLow += low;
    const exStyle  = exhaust > 0 ? `color:var(--danger-text);font-weight:600` : 'color:#aaa';
    const lowStyle = low     > 0 ? `color:var(--warn-text);font-weight:600`   : 'color:#aaa';
    const errStyle = errors  > 0 ? `color:#888;font-style:italic`             : 'color:#ddd';
    return `<tr>
      <td>${esc(name)}</td>
      <td class="text-end">${total}</td>
      <td class="text-end" style="${exStyle}">${exhaust}</td>
      <td class="text-end" style="${lowStyle}">${low}</td>
      <td class="text-end" style="color:var(--ok-text)">${ok}</td>
      <td class="text-end" style="${errStyle}">${errors || '–'}</td>
    </tr>`;
  });

  const grand = allResults.length;
  const gErr  = allResults.filter(r => r.fetch_error).length;
  const gEx   = allResults.filter(r => !r.fetch_error && r.remaining_mb <= 0).length;
  const gLow  = allResults.filter(r => !r.fetch_error && r.remaining_mb > 0 && r.remaining_mb < 10).length;
  const gOk   = grand - gEx - gLow - gErr;

  document.getElementById('statsTableBody').innerHTML = rows.join('');
  document.getElementById('statsTableFoot').innerHTML = `<tr class="stats-stripe" style="font-weight:600">
    <td>Total</td>
    <td class="text-end">${grand}</td>
    <td class="text-end" style="color:var(--danger-text)">${gEx}</td>
    <td class="text-end" style="color:var(--warn-text)">${gLow}</td>
    <td class="text-end" style="color:var(--ok-text)">${gOk}</td>
    <td class="text-end" style="color:#888">${gErr || '–'}</td>
  </tr>`;

  document.getElementById('tabBadgeProblems').textContent  = gEx + gLow;
  document.getElementById('tabBadgeExhausted').textContent = gEx;
  document.getElementById('tabBadgeLow').textContent       = gLow;
}

// ===========================================================================
// Metabase enrichment — Chrome message
// ===========================================================================
async function enrichSims(imsis) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'enrich', imsis }, response => {
      void chrome.runtime.lastError;
      resolve(response ?? { enriched: {} });
    });
  });
}

async function enrichResults() {
  const lowData = allResults.filter(r => !r.fetch_error && r.remaining_mb < 10);
  const imsis = [...new Set(lowData.filter(r => r.imsi).map(r => r.imsi))];
  if (!imsis.length) {
    if (lowData.length === 0) {
      log('Metabase enrichment skipped – no SIMs below 10 MB threshold', 'info');
    } else {
      log(`Metabase enrichment skipped – ${lowData.length} low-data SIM(s) have no IMSI in 1NCE response`, 'warn');
    }
    return;
  }

  log(`Enriching ${imsis.length} SIM(s) with internal links…`, 'info');
  try {
    const data = await enrichSims(imsis);
    if (data.error) { log(`  ⚠ Metabase enrichment: ${data.error}`, 'warn'); return; }

    const enriched = data.enriched || {};
    let count = 0;
    allResults.forEach(r => {
      const e = enriched[r.imsi];
      if (e) {
        r.infra_url     = e.infra_url     || '';
        r.admin_url     = e.admin_url     || '';
        r.serial_number = e.serial_number || '';
        count++;
      }
    });
    if (count) {
      log(`  ✓ Enriched ${count} SIM(s) with internal links`, 'success');
      applyFilters();
    } else {
      log(`  ⚠ Metabase returned no matches for ${imsis.length} IMSI(s)`, 'warn');
    }
  } catch (err) {
    log(`  ✗ Metabase enrichment error: ${err.message}`, 'error');
  }
}

// ===========================================================================
// Token invalidation — Chrome message
// ===========================================================================
async function invalidateTokens() {
  const btn = document.getElementById('btnInvalidateTokens');
  btn.disabled = true;
  try {
    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'invalidateTokens' }, response => {
        void chrome.runtime.lastError;
        resolve(response);
      });
    });
    if (response && response.success !== false) {
      log('Token cache cleared — all orgs will re-authenticate on next check.', 'warn');
      flash('success', 'Token cache cleared. Next check will fetch fresh tokens.');
    } else {
      flash('danger', 'Failed to clear token cache.');
    }
  } catch (err) {
    flash('danger', 'Error: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ===========================================================================
// Export — Usage data
// ===========================================================================
function exportData(format) {
  // allResults is the global array of SIM check results
  // Export scope is controlled by the exportScope radio group in the sidebar
  const scope = document.querySelector('input[name="exportScope"]:checked')?.value ?? 'all';
  const rows = scope === 'no_data'
    ? allResults.filter(r => !r.fetch_error && r.remaining_mb !== null && r.remaining_mb <= 0)
    : scope === 'issues'
      ? allResults.filter(r => !r.fetch_error && r.remaining_mb !== null && r.remaining_mb < 10)
      : allResults;
  const exhaustedOnly = scope === 'no_data';

  if (!rows.length) {
    flash('warning', 'No data to export.');
    return;
  }

  if (format === 'csv') {
    exportSimsCsv(rows, exhaustedOnly);
  } else if (format === 'excel') {
    exportSimsExcel(rows, exhaustedOnly);
  }
}

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

function exportSimsExcel(rows, exhaustedOnly) {
  const XLSX = window.XLSX;
  if (!XLSX) {
    flash('danger', 'Excel export unavailable: SheetJS library failed to load.');
    return;
  }
  const sorted = [...rows].sort((a, b) =>
    a.org_name.localeCompare(b.org_name) || a.iccid.localeCompare(b.iccid)
  );
  const orgNames = [...new Set(sorted.map(r => r.org_name))];
  const wb = XLSX.utils.book_new();

  for (const orgName of orgNames) {
    const orgRows = sorted.filter(r => r.org_name === orgName);
    const custNum = orgRows[0]?.customer_number ?? '';
    const sheetName = `${orgName} (${custNum})`.replace(/[\\/*?:[\]]/g, '_').slice(0, 31);
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

// ===========================================================================
// downloadBlob helper
// ===========================================================================
function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===========================================================================
// Config export — Chrome storage
// ===========================================================================
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

// ===========================================================================
// Settings modal — Metabase config
// ===========================================================================
function openSettingsModal() {
  chrome.storage.local.get('config', d => {
    const mb = d.config?.metabase ?? {};
    document.getElementById('mbPublicUrl').value   = mb.public_url   ?? '';
    document.getElementById('mbParameterId').value = mb.parameter_id ?? '';
    settingsModal.show();
  });
}

function saveSettings() {
  const public_url   = document.getElementById('mbPublicUrl').value.trim();
  const parameter_id = document.getElementById('mbParameterId').value.trim();
  chrome.storage.local.get('config', d => {
    const config = d.config ?? {};
    config.metabase = { public_url, parameter_id };
    chrome.storage.local.set({ config }, () => {
      settingsModal.hide();
      flash('success', '<i class="bi bi-check-circle me-1"></i>Settings saved.');
    });
  });
}

function toggleDark() {
  const isDark = document.body.classList.toggle('dark');
  document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
  document.getElementById('darkToggleBtn').innerHTML =
    isDark ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-stars-fill"></i>';
  localStorage.setItem('darkMode', isDark ? '1' : '0');
}

// ===========================================================================
// Progress / alert helpers
// ===========================================================================
function showProgress(label) {
  document.getElementById('progressLabel').textContent = label;
  document.getElementById('progressArea').style.display = '';
}
function hideProgress() {
  document.getElementById('progressArea').style.display = 'none';
}

function flash(type, msg) {
  const id = 'alert_' + Date.now();
  const el = document.createElement('div');
  el.className   = `alert alert-${type} alert-dismissible fade show py-2 px-3 mb-2`;
  el.style.fontSize = '.83rem';
  el.innerHTML   = `${msg} <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>`;
  el.id          = id;
  document.getElementById('alertArea').prepend(el);
  if (type === 'success') setTimeout(() => el.remove(), 4000);
}

// ===========================================================================
// Activity log
// ===========================================================================
function log(msg, type = 'info') {
  const panel = document.getElementById('logPanel');
  const colours = { info: '#90caf9', success: '#a5d6a7', warn: '#ffe082', error: '#ef9a9a' };
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.style.color = colours[type] || '#cdd3de';
  line.textContent = `[${time}] ${msg}`;
  // Remove placeholder if still there
  const placeholder = panel.querySelector('.text-muted');
  if (placeholder) placeholder.remove();
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

function clearLog() {
  const panel = document.getElementById('logPanel');
  panel.innerHTML = '<div style="color:#555">— cleared —</div>';
}

function setLogOpen(open) {
  const panel   = document.getElementById('logPanel');
  const chevron = document.getElementById('logChevron');
  panel.style.display   = open ? '' : 'none';
  chevron.className     = open ? 'bi bi-chevron-up' : 'bi bi-chevron-down';
}

function toggleLog() {
  const panel = document.getElementById('logPanel');
  setLogOpen(panel.style.display === 'none');
}

// ===========================================================================
// Utility
// ===========================================================================
function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => flash('success', `Copied: ${text}`));
}

// ===========================================================================
// Orders tab – state
// ===========================================================================
let allOrders         = [];
let filteredOrders    = [];
let orderFilter       = 'all';
let orderSortField    = 'order_date';
let orderSortAsc      = false;   // newest first by default
let ordersLoaded      = false;
let ordersChart       = null;
let ordersSelectedOrgs = null;  // null = all orgs; otherwise Set of org IDs

const CHART_COLORS = [
  '#E8573A','#3A8FE8','#3AC49E','#E8C23A','#A03AE8',
  '#E83A8F','#3AE8E8','#E88E3A','#3AE869','#8E3AE8'
];

// ===========================================================================
// Orders – date range helpers
// ===========================================================================
function getOrderDateRange() {
  const period = document.querySelector('input[name="orderPeriod"]:checked')?.value || '1y';
  const now    = new Date();
  const end    = now.toISOString().substring(0, 10);
  if (period === 'custom') {
    return {
      start: document.getElementById('orderStartDate').value || end,
      end:   document.getElementById('orderEndDate').value   || end
    };
  }
  const days = { '30d': 30, '3m': 90, '6m': 180, '1y': 365 }[period] || 365;
  const d    = new Date(now);
  d.setDate(d.getDate() - days);
  return { start: d.toISOString().substring(0, 10), end };
}

// ===========================================================================
// Orders – load via Chrome long-lived port
// ===========================================================================
function fetchOrders(orgId, startDate, endDate) {
  const port = chrome.runtime.connect({ name: 'fetchOrders' });
  port.postMessage({ orgId, startDate, endDate });

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    onOrdersError('Service worker disconnected — please try again.');
  });
  port.onMessage.addListener(msg => {
    if (msg.type === 'done') onOrdersDone(msg.results, msg.errors);
    if (msg.type === 'error') onOrdersError(msg.message);
  });
}

function onOrdersDone(results, errors) {
  const btn = document.getElementById('btnLoadOrders');

  (errors || []).forEach(e => {
    log(`  ⚠ ${e.org_name}: ${e.error}`, 'warn');
    ordersFlash('warning', `<strong>${esc(e.org_name)}:</strong> ${esc(e.error)}`);
  });

  allOrders         = results || [];
  ordersLoaded      = true;
  ordersSelectedOrgs = null;
  renderOrdersOrgFilter();

  document.getElementById('ordersLastLoadedLabel').textContent =
    'Last loaded: ' + new Date().toLocaleTimeString();
  log(`✓ ${allOrders.length} orders loaded`, 'success');

  applyOrderFilters();
  updateOrderStats();
  renderOrdersChart();
  buildOrderFilterTabs();

  hideOrdersProgress();
  if (btn) btn.disabled = false;
}

function onOrdersError(message) {
  const btn = document.getElementById('btnLoadOrders');
  ordersFlash('danger', message || 'Failed to load orders.');
  log(`✗ Orders load failed: ${message}`, 'error');
  hideOrdersProgress();
  if (btn) btn.disabled = false;
}

async function loadOrders() {
  const btn = document.getElementById('btnLoadOrders');
  btn.disabled = true;
  document.getElementById('ordersAlertArea').innerHTML = '';

  const { start, end } = getOrderDateRange();
  showOrdersProgress(`Loading orders ${start} → ${end}…`);
  log(`Loading orders from ${start} to ${end}…`, 'info');
  setLogOpen(true);

  // Pass a single orgId string or null (background expects a scalar)
  const orgIds = orgs.map(o => o.id);
  const orgId = orgIds.length === 1 ? orgIds[0] : null;
  fetchOrders(orgId, start, end);
}

// ===========================================================================
// Orders – filter tabs (built from distinct statuses)
// ===========================================================================
function buildOrderFilterTabs() {
  const statuses = [...new Set(allOrders.map(r => r.order_status).filter(Boolean))].sort();
  const ul = document.getElementById('ordersFilterTabs');
  const allBadge = allOrders.length;

  ul.innerHTML = `<li class="nav-item">
    <a class="nav-link ${orderFilter === 'all' ? 'active' : ''}" href="#"
       data-ofilter="all">
      All <span class="badge bg-secondary ms-1">${allBadge}</span>
    </a>
  </li>` + statuses.map(s => {
    const cnt   = allOrders.filter(r => r.order_status === s).length;
    const cls   = orderStatusClass(s);
    return `<li class="nav-item">
      <a class="nav-link ${orderFilter === s ? 'active' : ''}" href="#"
         data-ofilter="${esc(s)}">
        ${esc(s)} <span class="badge ${cls} ms-1">${cnt}</span>
      </a>
    </li>`;
  }).join('');

  // Delegate clicks on dynamically built filter tabs
  ul.querySelectorAll('[data-ofilter]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); setOrderFilter(el.dataset.ofilter); });
  });
}

function orderStatusClass(s) {
  if (!s) return 'bg-secondary';
  const sl = s.toLowerCase();
  if (sl.includes('complet') || sl.includes('deliver') || sl.includes('shipped')) return 'bg-success';
  if (sl.includes('pending') || sl.includes('process'))   return 'bg-warning text-dark';
  if (sl.includes('cancel'))  return 'bg-danger';
  return 'bg-secondary';
}

// ===========================================================================
// Orders – filtering & sorting
// ===========================================================================
function setOrderFilter(f) {
  orderFilter = f;
  document.querySelectorAll('[data-ofilter]').forEach(el => {
    el.classList.toggle('active', el.dataset.ofilter === f);
  });
  applyOrderFilters();
}

function applyOrderFilters() {
  const q    = document.getElementById('orderSearchInput').value.toLowerCase();
  const orgF = document.getElementById('orderOrgFilter').value;

  filteredOrders = allOrders.filter(r => {
    if (orderFilter !== 'all' && r.order_status !== orderFilter) return false;
    if (ordersSelectedOrgs !== null && !ordersSelectedOrgs.has(r.org_id)) return false;
    if (orgF && r.org_id !== orgF) return false;
    if (q) {
      const hay = (String(r.order_number) + r.invoice_number + r.org_name + r.order_type).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  sortOrderResults();
  renderOrdersTable();
}

function sortOrdersBy(field) {
  if (orderSortField === field) orderSortAsc = !orderSortAsc;
  else { orderSortField = field; orderSortAsc = field !== 'order_date'; }
  sortOrderResults();
  renderOrdersTable();
}

function sortOrderResults() {
  filteredOrders.sort((a, b) => {
    let va = a[orderSortField], vb = b[orderSortField];
    if (va === null && vb === null) return 0;
    if (va === null) return orderSortAsc ? 1 : -1;
    if (vb === null) return orderSortAsc ? -1 : 1;
    if (typeof va === 'number') return orderSortAsc ? va - vb : vb - va;
    va = String(va || '').toLowerCase();
    vb = String(vb || '').toLowerCase();
    return orderSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
}

// ===========================================================================
// Orders – table rendering
// ===========================================================================
function renderOrdersTable() {
  const tbody = document.getElementById('ordersTableBody');

  if (!filteredOrders.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">No orders match the current filter.</td></tr>`;
  } else {
    tbody.innerHTML = filteredOrders.map(r => {
      const amt = r.invoice_amount != null ? Number(r.invoice_amount).toFixed(2) : '–';
      return `<tr>
        <td class="text-truncate" style="max-width:120px" title="${esc(r.org_name)}">${esc(r.org_name)}</td>
        <td class="font-monospace" style="font-size:.78rem">${esc(String(r.order_number || '–'))}</td>
        <td style="font-size:.78rem; white-space:nowrap">${r.order_date ? r.order_date.substring(0,10) : '–'}</td>
        <td><span class="badge bg-secondary" style="font-size:.7rem">${esc(orderTypeName(r.order_type))}</span></td>
        <td>${orderStatusBadge(r.order_status)}</td>
        <td class="font-monospace" style="font-size:.78rem">${esc(r.invoice_number) || '–'}</td>
        <td class="text-end font-monospace" style="font-size:.78rem">${amt}</td>
        <td style="font-size:.78rem">${esc(r.currency) || '–'}</td>
        <td class="text-end" style="font-size:.78rem">${r.sim_count ?? '–'}</td>
        <td style="font-size:.75rem; color:var(--text-muted); max-width:180px" class="text-truncate"
            title="${esc(r.products)}">${esc(r.products) || '–'}</td>
      </tr>`;
    }).join('');
  }

  document.getElementById('orderRowCount').textContent = filteredOrders.length;
  showOrdersArea();
}

function orderTypeName(t) {
  const names = {
    FIRST_ORDER: 'First Order', ADDITIONAL_ORDER: 'Additional',
    TOPUP: 'Top-up', BULK_TOPUP: 'Bulk Top-up', TARIFF_CHANGE: 'Tariff Change'
  };
  return names[t] || t || '–';
}

function orderStatusBadge(status) {
  if (!status) return '<span class="text-muted">–</span>';
  return `<span class="badge ${orderStatusClass(status)}" style="font-size:.7rem">${esc(status)}</span>`;
}

function showOrdersArea() {
  document.getElementById('ordersTableCard').style.display     = '';
  document.getElementById('ordersTableControls').style.display = '';
  document.getElementById('ordersStatsRow').style.display      = '';
  document.getElementById('orgSpendCard').style.display        = '';
  document.getElementById('ordersChartCard').style.display     = '';
  document.getElementById('ordersEmptyState').style.display    = 'none';
}

// ===========================================================================
// Orders – stats
// ===========================================================================
function updateOrderStats() {
  document.getElementById('statTotalOrders').textContent = allOrders.length;

  // Sum by currency
  const byCurrency = {};
  allOrders.forEach(r => {
    const cur = r.currency || '?';
    byCurrency[cur] = (byCurrency[cur] || 0) + (r.invoice_amount || 0);
  });
  const spendStr = Object.entries(byCurrency)
    .map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`)
    .join(' + ') || '–';
  document.getElementById('statTotalSpend').textContent = spendStr;

  // Order type breakdown
  const byType = {};
  allOrders.forEach(r => { const t = orderTypeName(r.order_type); byType[t] = (byType[t] || 0) + 1; });
  document.getElementById('statOrderTypes').textContent =
    Object.entries(byType).map(([t, n]) => `${n}× ${t}`).join(', ') || '–';

  // Per-org spend breakdown table
  const orgIds = [...new Set(allOrders.map(r => r.org_id))];
  const rows   = orgIds.map(oid => {
    const orgOrders = allOrders.filter(r => r.org_id === oid);
    const name      = orgOrders[0].org_name;
    const count     = orgOrders.length;
    const byCur     = {};
    orgOrders.forEach(r => {
      const cur = r.currency || '?';
      byCur[cur] = (byCur[cur] || 0) + (r.invoice_amount || 0);
    });
    const totalStr = Object.entries(byCur).map(([c, a]) => `${a.toFixed(2)} ${c}`).join(', ');
    const avgStr   = Object.entries(byCur).map(([c, a]) => `${(a / count).toFixed(2)} ${c}`).join(', ');
    return `<tr>
      <td class="text-truncate" style="max-width:180px" title="${esc(name)}">${esc(name)}</td>
      <td class="text-end">${count}</td>
      <td class="text-end font-monospace" style="font-size:.82rem">${totalStr || '–'}</td>
      <td class="text-end font-monospace" style="font-size:.82rem; color:var(--text-muted)">${avgStr || '–'}</td>
    </tr>`;
  }).join('');
  document.getElementById('orgSpendTableBody').innerHTML = rows;
}

// ===========================================================================
// Orders – chart
// ===========================================================================
function renderOrdersChart() {
  const allOrgNames = [...new Set(allOrders.map(r => r.org_name))];
  const period      = document.querySelector('input[name="orderPeriod"]:checked')?.value || '1y';
  const useWeeks    = period === '30d';

  // Determine visible orgs from sidebar selection
  const visibleOrgs = ordersSelectedOrgs === null
    ? allOrgNames
    : allOrgNames.filter(name => {
        const org = orgs.find(o => o.name === name);
        return org && ordersSelectedOrgs.has(org.id);
      });
  const visibleOrders = allOrders.filter(r => visibleOrgs.includes(r.org_name));

  // Build time bucket labels
  const now    = new Date();
  const labels = [];
  if (useWeeks) {
    for (let i = 3; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      labels.push(d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
    }
  } else {
    const months = { '3m': 3, '6m': 6, '1y': 12, 'custom': 12 }[period] || 12;
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleString('default', { month: 'short', year: '2-digit' }));
    }
  }

  // Build bucket key for an order date
  function bucketKey(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    if (useWeeks) {
      const msPerWeek = 7 * 24 * 3600 * 1000;
      const fourWeeksAgo = new Date(now.getTime() - 3 * msPerWeek);
      for (let i = 0; i < 4; i++) {
        const wStart = new Date(fourWeeksAgo.getTime() + i * msPerWeek);
        const wEnd   = new Date(wStart.getTime() + msPerWeek);
        if (d >= wStart && d < wEnd) {
          return wStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        }
      }
      return null;
    }
    return d.toLocaleString('default', { month: 'short', year: '2-digit' });
  }

  // Build datasets: one per visible org
  const barDatasets = visibleOrgs.map((orgName, i) => {
    const orgOrders = visibleOrders.filter(r => r.org_name === orgName);
    const data      = labels.map(lbl => {
      const bucket = orgOrders.filter(r => bucketKey(r.order_date) === lbl);
      return bucket.reduce((sum, r) => sum + (r.invoice_amount || 0), 0);
    });
    const color = CHART_COLORS[allOrgNames.indexOf(orgName) % CHART_COLORS.length];
    return {
      type:            'bar',
      label:           orgName,
      data,
      backgroundColor: color + 'BB',
      borderColor:     color,
      borderWidth:     1,
      yAxisID:         'y'
    };
  });

  // Total line dataset (sum of all visible orgs per bucket)
  const totalData = labels.map((_, li) =>
    barDatasets.reduce((sum, ds) => sum + (ds.data[li] || 0), 0)
  );
  const totalDataset = {
    type:            'line',
    label:           'Total',
    data:            totalData,
    borderColor:     '#ffffffCC',
    backgroundColor: 'transparent',
    borderWidth:     2,
    borderDash:      [5, 3],
    pointRadius:     3,
    tension:         0.3,
    yAxisID:         'y1',
    order:           -1
  };

  const datasets = [...barDatasets, totalDataset];

  // Determine currency for y-axis label
  const currencies = [...new Set(allOrders.map(r => r.currency).filter(Boolean))];
  const yLabel     = currencies.length === 1 ? currencies[0] : 'Amount';

  // Compute shared max so both axes show the same scale
  const yMax = Math.max(...totalData, 1) * 1.15;

  const ctx = document.getElementById('ordersChart').getContext('2d');
  if (ordersChart) ordersChart.destroy();
  ordersChart = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(2)} ${currencies[0] || ''}`
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 11 } } },
        y: {
          stacked: true, beginAtZero: true, max: yMax,
          title: { display: true, text: yLabel, font: { size: 11 } },
          ticks: { font: { size: 11 } }
        },
        y1: {
          type: 'linear', display: false,
          beginAtZero: true, max: yMax
        }
      }
    }
  });
}

function renderOrdersOrgFilter() {
  const el = document.getElementById('ordersOrgList');
  if (!el || !orgs.length) return;
  el.innerHTML = orgs.map((o, i) => {
    const checked = ordersSelectedOrgs === null || ordersSelectedOrgs.has(o.id);
    const color   = CHART_COLORS[i % CHART_COLORS.length];
    return `<div class="org-item" data-toggleorgid="${esc(o.id)}">
      <input type="checkbox" class="form-check-input flex-shrink-0"
             style="pointer-events:none; accent-color:${color}"
             ${checked ? 'checked' : ''} />
      <div class="flex-grow-1 text-truncate" style="font-size:.82rem"
           title="${esc(o.name)}">${esc(o.name)}</div>
    </div>`;
  }).join('');

  // Delegate clicks
  el.querySelectorAll('[data-toggleorgid]').forEach(item => {
    item.addEventListener('click', () => toggleOrderOrg(item.dataset.toggleorgid));
  });
}

function toggleOrderOrg(orgId) {
  const allIds = new Set(orgs.map(o => o.id));
  if (ordersSelectedOrgs === null) {
    ordersSelectedOrgs = new Set([...allIds].filter(id => id !== orgId));
  } else {
    if (ordersSelectedOrgs.has(orgId)) ordersSelectedOrgs.delete(orgId);
    else ordersSelectedOrgs.add(orgId);
    if (ordersSelectedOrgs.size === allIds.size) ordersSelectedOrgs = null;
  }
  renderOrdersOrgFilter();
  applyOrderFilters();
  renderOrdersChart();
}

function setAllOrderOrgs(selectAll) {
  ordersSelectedOrgs = selectAll ? null : new Set();
  renderOrdersOrgFilter();
  applyOrderFilters();
  renderOrdersChart();
}

// ===========================================================================
// Orders – export
// ===========================================================================
function exportOrders(format) {
  if (!allOrders.length) {
    flash('warning', 'No orders to export.');
    return;
  }
  if (format === 'csv') {
    exportOrdersCsv(allOrders);
  } else if (format === 'excel') {
    exportOrdersExcel(allOrders);
  }
}

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

function exportOrdersExcel(rows) {
  const XLSX = window.XLSX;
  if (!XLSX) {
    flash('danger', 'Excel export unavailable: SheetJS library failed to load.');
    return;
  }
  const sorted = [...rows].sort((a, b) =>
    a.org_name.localeCompare(b.org_name) || a.order_date.localeCompare(b.order_date)
  );
  const orgNames = [...new Set(sorted.map(r => r.org_name))];
  const wb = XLSX.utils.book_new();

  for (const orgName of orgNames) {
    const orgRows = sorted.filter(r => r.org_name === orgName);
    const custNum = orgRows[0]?.customer_number ?? '';
    const sheetName = `${orgName} (${custNum})`.replace(/[\\/*?:[\]]/g, '_').slice(0, 31);
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([ORDER_HEADERS, ...orgRows.map(r => orderRowValues(r))]),
      sheetName
    );
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

// ===========================================================================
// Orders – progress / alerts
// ===========================================================================
function showOrdersProgress(label) {
  document.getElementById('ordersProgressLabel').textContent = label;
  document.getElementById('ordersProgressArea').style.display = '';
}
function hideOrdersProgress() {
  document.getElementById('ordersProgressArea').style.display = 'none';
}
function ordersFlash(type, msg) {
  const el = document.createElement('div');
  el.className  = `alert alert-${type} alert-dismissible fade show py-2 px-3 mb-2`;
  el.style.fontSize = '.83rem';
  el.innerHTML  = `${msg} <button type="button" class="btn-close py-2" data-bs-dismiss="alert"></button>`;
  document.getElementById('ordersAlertArea').prepend(el);
  if (type === 'success') setTimeout(() => el.remove(), 4000);
}
