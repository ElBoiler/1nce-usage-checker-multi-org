# 1NCE SIM Usage Checker

A Sinatra web app that checks data-quota usage across multiple 1NCE organisations
and highlights SIM cards with no data volume remaining.

---

## Quick start

```bash
# 1. Install Ruby gems
bundle install

# 2. Set up credentials (optional – you can also use the web UI)
cp config.example.yml config.yml
# then edit config.yml with your 1NCE usernames & passwords

# 3. Run the app
bundle exec ruby app.rb
# → open http://localhost:4567
```

The app binds to `0.0.0.0:4567` by default.
Override with `PORT=8080 bundle exec ruby app.rb`.

---

## Organisation management

Credentials are stored in `config.yml` on the server only.
The browser **never** receives passwords.

You can manage organisations two ways:

| Method | How |
|--------|-----|
| Web UI | Click **Add** in the left sidebar; edit/delete buttons on each row |
| Manual | Edit `config.yml` directly (see `config.example.yml`) |

### Portal URL template

Each org can have a custom portal URL template with two placeholders:

```
{iccid}            – replaced with the SIM's ICCID
{customer_number}  – replaced with the org's customer number
```

Default (used when left blank):
```
https://portal.1nce.com/#/customer/{customer_number}/sims/{iccid}
```

---

## Usage workflow

1. **Check All Orgs** – fetches every SIM across all configured orgs.
2. **Check Selected Org** – click an org in the sidebar first, then this button.
3. Filter the table by **No Data Left** / **Low (<10 MB)** / **All**.
4. Use the search box to filter by ICCID, label, or MSISDN.
5. Click the **Portal** button on any row to open the SIM directly in the 1NCE portal.
6. **Export** the list as CSV or Excel (grouped by org, sorted by ICCID).

### Detailed mode

Enable **Detailed mode** (toggle in the sidebar) to also fetch individual quota
endpoints per SIM. This gives expiry dates and total volume but is slower for
large orgs (uses 20 parallel threads).

---

## API used

| Endpoint | Purpose |
|----------|---------|
| `POST /oauth/token` | Obtain Bearer token (auto-refreshed, cached 1 h) |
| `GET /v1/sims?pageSize=100&page=N` | Paginated SIM list with `current_quota` |
| `GET /v1/sims/{iccid}/quota/data` | Detailed quota (detailed mode only) |

Base URL: `https://api.1nce.com/management-api`

---

## Dependencies

| Gem | Purpose |
|-----|---------|
| `sinatra` | Web framework |
| `puma` | HTTP server |
| `caxlsx` | Excel (.xlsx) export |
