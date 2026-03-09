# 1NCE SIM Usage Checker

A web tool that checks data-quota usage across multiple 1NCE organisations
and highlights SIM cards with no data volume remaining.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker Desktop** | [Download](https://www.docker.com/products/docker-desktop/) — free for personal use |
| **Git** | To clone the repo |

---

## Setup & run

### 1. Clone the repo

```bash
git clone https://github.com/ElBoiler/1nce-usage-checker-multi-org.git
cd 1nce-usage-checker-multi-org
```

### 2. Build the image

```bash
docker build -t 1nce-app .
```

### 3. Run the app

```bash
docker run --rm -p 4567:4567 1nce-app
```

Then open **http://127.0.0.1:4567** in your browser.

Press `Ctrl+C` to stop.

---

## Persisting your configuration

By default, organisations you add via the UI are stored inside the container
and lost when it stops. To keep them permanently:

```bash
# After adding orgs via the UI, copy the config out of the container:
docker cp $(docker ps -lq) /app/config.yml ./config.yml

# On future runs, mount it back in:
docker run --rm -p 4567:4567 -v "%cd%/config.yml:/app/config.yml" 1nce-app
```

> **PowerShell users:** replace `%cd%` with `${PWD}`:
> ```powershell
> docker run --rm -p 4567:4567 -v "${PWD}/config.yml:/app/config.yml" 1nce-app
> ```

Alternatively, edit `config.yml` directly (copy `config.example.yml` as a
starting point) and mount it from the first run.

---

## Changing the port

```bash
docker run --rm -p 8080:4567 1nce-app
# → http://127.0.0.1:8080
```

---

## Usage workflow

1. **Add organisations** — click **Add** in the left sidebar and enter your 1NCE credentials. The green lock icon confirms credentials are saved.
2. **Check usage** — click **Check All Orgs** to scan every organisation, or click an org name then **Check Selected Org**.
3. **Read the results** — the table highlights SIMs in red (0 MB left) and amber (<10 MB left). Use the filter tabs, search box, and org dropdown to narrow down the list.
4. **Open a SIM** — click the **Portal** button on any row to open the 1NCE API record for that SIM directly.
5. **Export** — choose *Exhausted SIMs only* or all results, then click **Export CSV** or **Export Excel**.

### Detailed mode

Toggle **Detailed mode** in the sidebar before checking. This calls the
individual `/quota/data` endpoint for every SIM (using 20 parallel threads)
to retrieve expiry dates and total volume. Slower for large organisations
but gives richer data in the table and exports.

---

## Organisation management

Credentials are stored in `config.yml` on the server only.
The browser **never** receives passwords — the API only returns org name, ID,
customer number, and whether credentials have been set.

| Method | How |
|--------|-----|
| **Web UI** | Click **Add** in the left sidebar; use the pencil/trash icons to edit or remove |
| **config.yml** | Edit directly and rebuild: `docker build -t 1nce-app . && docker run ...` |

### Portal URL template

Each org can override the link shown in the **Portal** column using placeholders:

```
{iccid}            – replaced with the SIM's ICCID
{customer_number}  – replaced with the org's customer number
```

Default (used when left blank):

```
https://api.1nce.com/management-api/v1/sims/{iccid}
```

---

## API endpoints used

| Endpoint | Purpose |
|----------|---------|
| `POST /oauth/token` | Obtain Bearer token (cached, auto-refreshed before expiry) |
| `GET /v1/sims?pageSize=100&page=N` | Paginated SIM list including `current_quota` |
| `GET /v1/sims/{iccid}/quota/data` | Per-SIM detailed quota (detailed mode only) |

Base URL: `https://api.1nce.com/management-api`

---

## Dependencies

| Gem | Purpose |
|-----|---------|
| `sinatra` | Web framework |
| `webrick` | HTTP server |
| `write_xlsx` | Excel (.xlsx) export |
