# Graph Report - C:/Users/thoma/Documents/Tools/1nce-usage-checker-multi-org  (2026-04-14)

## Corpus Check
- Corpus is ~3,672 words - fits in a single context window. You may not need a graph.

## Summary
- 45 nodes · 74 edges · 7 communities detected
- Extraction: 85% EXTRACTED · 15% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.84)
- Token cost: 4,200 input · 2,100 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Export & Data Output|Export & Data Output]]
- [[_COMMUNITY_Org Config & Metabase Enrichment|Org Config & Metabase Enrichment]]
- [[_COMMUNITY_Rate Limiting & Paginated Fetch|Rate Limiting & Paginated Fetch]]
- [[_COMMUNITY_SIM Usage Check Pipeline|SIM Usage Check Pipeline]]
- [[_COMMUNITY_1NCE API Client & Auth|1NCE API Client & Auth]]
- [[_COMMUNITY_App Bootstrap & Deployment|App Bootstrap & Deployment]]
- [[_COMMUNITY_Organisation Security Model|Organisation Security Model]]

## God Nodes (most connected - your core abstractions)
1. `load_config()` - 9 edges
2. `throttled_api_get()` - 8 edges
3. `check_org_usage()` - 7 edges
4. `save_config()` - 5 edges
5. `get_token()` - 5 edges
6. `export_excel()` - 5 edges
7. `export_orders_excel()` - 5 edges
8. `api_get()` - 4 edges
9. `fetch_all_sims()` - 4 edges
10. `fetch_quota_detail()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Detailed Mode (per-SIM quota endpoint)` --references--> `fetch_quota_detail()`  [INFERRED]
  README.md → app.rb
- `Portal URL Template with Placeholders` --references--> `build_sim_row()`  [INFERRED]
  README.md → app.rb
- `export_excel()` --references--> `write_xlsx Gem`  [EXTRACTED]
  app.rb → README.md
- `export_orders_excel()` --references--> `write_xlsx Gem`  [EXTRACTED]
  app.rb → README.md
- `Docker Compose Deployment` --references--> `Sinatra Application (app.rb)`  [INFERRED]
  README.md → app.rb

## Hyperedges (group relationships)
- **Rate Limiting and Retry System** — app_throttled_api_get, app_org_rate_limiters, app_exponential_backoff [EXTRACTED 0.95]
- **SIM Usage Check Pipeline** — app_check_org_usage, app_fetch_all_sims, app_fetch_quota_detail, app_build_sim_row, app_thread_pool [EXTRACTED 0.95]
- **Organisation CRUD with Token Cache Invalidation** — app_route_put_orgs, app_route_delete_orgs, app_token_cache [EXTRACTED 0.90]

## Communities

### Community 0 - "Export & Data Output"
Cohesion: 0.35
Nodes (10): export_csv(), export_excel(), export_orders_csv(), export_orders_excel(), order_row_values(), POST /api/export Route, POST /api/export/orders Route, row_values() (+2 more)

### Community 1 - "Org Config & Metabase Enrichment"
Cohesion: 0.29
Nodes (10): CONFIG_FILE Constant, load_config(), Metabase CSV Enrichment Integration, DELETE /api/orgs/:id Route, POST /api/enrich Route (Metabase), POST /api/orgs Route, PUT /api/orgs/:id Route, save_config() (+2 more)

### Community 2 - "Rate Limiting & Paginated Fetch"
Cohesion: 0.38
Nodes (7): Exponential Backoff with Jitter (HTTP 429), fetch_all_orders(), fetch_all_sims(), org_rate_limiter(), Per-Org Rate Limiter State (ORG_RATE_LIMITERS), GET /api/orders Route, throttled_api_get()

### Community 3 - "SIM Usage Check Pipeline"
Cohesion: 0.33
Nodes (7): build_sim_row(), check_org_usage(), fetch_quota_detail(), GET /api/check Route, Thread Pool Worker Pattern, Detailed Mode (per-SIM quota endpoint), Portal URL Template with Placeholders

### Community 4 - "1NCE API Client & Auth"
Cohesion: 0.67
Nodes (4): API_BASE Constant, api_get(), get_token(), 1NCE Management API

### Community 5 - "App Bootstrap & Deployment"
Cohesion: 0.67
Nodes (3): Sinatra Application (app.rb), Docker Compose Deployment, Sinatra Web Framework Gem

### Community 6 - "Organisation Security Model"
Cohesion: 0.67
Nodes (3): GET /api/orgs Route, 1NCE SIM Usage Checker, Rationale: Passwords Never Sent to Browser

## Knowledge Gaps
- **8 isolated node(s):** `1NCE SIM Usage Checker`, `Docker Compose Deployment`, `config.yml Organisation Credentials File`, `1NCE Management API`, `Portal URL Template with Placeholders` (+3 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `load_config()` connect `Org Config & Metabase Enrichment` to `Export & Data Output`, `Rate Limiting & Paginated Fetch`, `SIM Usage Check Pipeline`, `Organisation Security Model`?**
  _High betweenness centrality (0.306) - this node is a cross-community bridge._
- **Why does `throttled_api_get()` connect `Rate Limiting & Paginated Fetch` to `Export & Data Output`, `SIM Usage Check Pipeline`, `1NCE API Client & Auth`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `GET /api/orgs Route` connect `Organisation Security Model` to `Org Config & Metabase Enrichment`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **What connects `1NCE SIM Usage Checker`, `Docker Compose Deployment`, `config.yml Organisation Credentials File` to the rest of the system?**
  _8 weakly-connected nodes found - possible documentation gaps or missing edges._