# Manual E2E Test Checklist — 1NCE Usage Checker Chrome Extension

Run this checklist after any significant change and before merging to main.
Requires at least one real set of 1NCE credentials.

---

## Setup

- [ ] Load the extension: open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select the `extension/` folder
- [ ] Confirm the extension card shows no errors
- [ ] Click the extension icon — a new tab opens showing the 1NCE Usage & Orders UI

---

## Org Management

- [ ] Click **Add** → enter org name, customer number, username, and password → click Save
- [ ] Org appears in the list with a green lock badge (credentials set)
- [ ] Click the pencil icon → edit the org name → Save → name updates immediately
- [ ] Close and reopen the tab — org and name change persist
- [ ] Add a second org, then click its trash icon → confirm removal → org disappears
- [ ] Reopen the tab — deleted org does not reappear

---

## Settings Modal (Metabase)

- [ ] Click the gear icon (⚙) in the top bar → Settings modal opens
- [ ] Both fields (Public CSV URL, Parameter ID) are empty on first use
- [ ] Enter a dummy URL and UUID → click Save → modal closes and a green "Settings saved." alert appears
- [ ] Reopen the gear modal → both values are still populated

---

## Usage Check

- [ ] Select all orgs (or click a single org to check) → click **Check All Orgs** (or **Check Selected**)
- [ ] Progress bar appears with org name and `completed / total` SIM count
- [ ] Results table populates after the check completes
- [ ] Stats row shows per-org breakdown: Total, No Data, <10 MB, OK, API Error columns
- [ ] Rows with 0 MB remaining are highlighted red
- [ ] Rows with > 0 and < 10 MB are highlighted amber
- [ ] Rows with ≥ 10 MB have a **blank** IMSI column
- [ ] Rows with < 10 MB remaining (and no fetch error) show the IMSI value
- [ ] Rows with a fetch error show `ERROR:<reason>` in the Remaining column and a blank IMSI
- [ ] Click the portal icon on any row → correct 1NCE portal URL opens in a new tab
- [ ] Filter tabs (Issues / All / No Data / Low <10 MB) correctly subset the table
- [ ] Search box filters by ICCID, Label, or MSISDN
- [ ] Org dropdown narrows results to the selected org

---

## Token Invalidation

- [ ] After a successful check (tokens are cached), click **Refresh Tokens**
- [ ] Button briefly disables, then re-enables with no error
- [ ] Run another check — it completes successfully (re-authenticates transparently)

---

## Service Worker Recovery

- [ ] Run a check to completion
- [ ] Wait 60+ seconds without interacting (Chrome may kill the idle service worker)
- [ ] Run another check — it completes without errors or manual intervention

---

## Exports — SIM Usage

- [ ] With results loaded, select scope **No Data** and click **Export CSV**
  - File downloads as `sims_no_data.csv`
  - Open in a spreadsheet — first row headers: `Organisation, Customer Number, ICCID, Label, MSISDN, IMSI, IP Address, SIM Status, Remaining Data (MB), Total Data (MB), Expiry Date, Quota Status, Portal Link, Advizeo Infra, Advizeo Admin`
  - IMSI column is blank for all rows with ≥ 10 MB remaining
- [ ] Select scope **All** and click **Export Excel**
  - File downloads as `sims_usage.xlsx`
  - One sheet per org named `OrgName (CustomerNumber)` (max 31 chars)
  - If more than one org: a **Summary** sheet is present
- [ ] Click **Export Config**
  - File downloads as `config.json`
  - Open in a text editor — no `password` fields present

---

## Orders Tab

- [ ] Switch to the **Orders** tab
- [ ] Select **Last year** and click **Load / Refresh**
- [ ] Orders table populates; per-org spend breakdown table renders
- [ ] Spend over time chart renders with bars per org and a total line
- [ ] Org checkbox filter narrows table rows
- [ ] Search box filters by order number, invoice number, or org name
- [ ] Click **Export CSV** → `orders.csv` downloads; first row headers: `Organisation, Customer Number, Order Number, Order Date, Order Type, Order Status, Invoice Number, Amount, Currency, SIM Count, Products`
- [ ] Click **Export Excel** → `orders.xlsx` downloads; one sheet per org + Summary sheet (if >1 org)

---

## Metabase Enrichment (if a Metabase instance is available)

- [ ] Open gear → enter a valid Public CSV URL and Parameter ID → Save
- [ ] Run a usage check — after results load, trigger enrichment for low-data SIMs
- [ ] Advizeo Infra and Advizeo Admin columns populate for matched IMSIs
- [ ] Export Excel → infra/admin columns contain the URLs from Metabase

---

## Dark Mode

- [ ] Click the moon/sun button in the top bar → UI switches to dark mode
- [ ] Reopen the tab — dark mode preference persists (stored in localStorage)
- [ ] Switch back to light mode — preference persists

---

## Verbose Log

- [ ] Expand the **Activity Log** panel at the bottom
- [ ] Enable the **Verbose** toggle before running a check
- [ ] After the check, the log shows individual API request entries (POST /oauth/token, GET /v1/sims, GET /v1/sims/{iccid}/quota/data)
- [ ] Click **Clear** → log panel empties
