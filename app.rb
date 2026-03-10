require 'sinatra'
require 'json'
require 'yaml'
require 'net/http'
require 'uri'
require 'base64'
require 'csv'
require 'securerandom'
require 'thread'
require 'time'

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIG_FILE = File.join(File.dirname(__FILE__), 'config.yml')
API_BASE    = 'https://api.1nce.com/management-api'

# In-memory token cache: { org_id => { token: String, expires_at: Time } }
TOKEN_CACHE       = {}
TOKEN_CACHE_MUTEX = Mutex.new

# ---------------------------------------------------------------------------
# Rate-limiting & retry configuration
# ---------------------------------------------------------------------------

# Number of concurrent quota-fetch workers per org.
# Kept low so we don't spray the API with parallel requests.
THREAD_POOL_SIZE = 5

# Maximum number of retry attempts when the API returns HTTP 429.
MAX_RETRIES = 4

# Base delay (seconds) for exponential backoff: 1 s, 2 s, 4 s, 8 s …
RETRY_BASE_DELAY = 1.0

# Upper cap on backoff delay regardless of how many retries have occurred.
RETRY_MAX_DELAY = 30.0

# Minimum gap between consecutive request *starts* for a single org.
# This is the primary guard against thundering-herd bursts:
#   5 threads × (1 / 0.25 s) = effective max ~4 requests / second per org.
MIN_REQUEST_GAP = 0.25

# Per-org rate-limiter state: { org_id => { mutex: Mutex, last_at: Time } }
ORG_RATE_LIMITERS      = {}
ORG_RATE_LIMITER_MUTEX = Mutex.new

def org_rate_limiter(org_id)
  ORG_RATE_LIMITER_MUTEX.synchronize do
    ORG_RATE_LIMITERS[org_id] ||= { mutex: Mutex.new, last_at: Time.at(0) }
  end
end

# api_get wrapper that:
#   1. Throttles request starts so each org never exceeds ~4 req/s.
#   2. Retries up to MAX_RETRIES times on HTTP 429, using exponential backoff
#      with ±50 % jitter, or the Retry-After header value when present.
def throttled_api_get(org, path)
  limiter = org_rate_limiter(org['id'])

  # Serialise request starts through the per-org mutex so bursts are smoothed.
  limiter[:mutex].synchronize do
    elapsed = Time.now - limiter[:last_at]
    sleep(MIN_REQUEST_GAP - elapsed) if elapsed < MIN_REQUEST_GAP
    limiter[:last_at] = Time.now
  end

  attempt = 0
  loop do
    code, body, res = api_get(org, path)
    return [code, body, res] unless code == 429

    attempt += 1
    return [code, body, res] if attempt > MAX_RETRIES

    # Honour Retry-After when the server provides it; otherwise back off
    # exponentially with jitter to avoid synchronised retry storms.
    retry_after = res['Retry-After']&.to_f
    delay = if retry_after && retry_after > 0
              retry_after
            else
              base = [RETRY_BASE_DELAY * (2**(attempt - 1)), RETRY_MAX_DELAY].min
              base + rand * base * 0.5   # jitter: 100–150 % of base
            end

    sleep(delay)

    # Push last_at forward so other threads don't pile in right after our sleep.
    limiter[:mutex].synchronize { limiter[:last_at] = Time.now }
  end
end

configure do
  set :port,           ENV.fetch('PORT', 4567).to_i
  set :bind,           '0.0.0.0'
  set :session_secret, ENV.fetch('SESSION_SECRET') { SecureRandom.hex(64) }
  enable :sessions
end

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def load_config
  return { 'organizations' => [] } unless File.file?(CONFIG_FILE)

  YAML.load_file(CONFIG_FILE) || { 'organizations' => [] }
end

def save_config(config)
  File.write(CONFIG_FILE, YAML.dump(config))
end

# ---------------------------------------------------------------------------
# 1NCE API helpers
# ---------------------------------------------------------------------------

def get_token(org, req_log: nil, log_mutex: nil)
  org_id = org['id']

  TOKEN_CACHE_MUTEX.synchronize do
    cached = TOKEN_CACHE[org_id]
    return cached[:token] if cached && cached[:expires_at] > Time.now + 60
  end

  uri  = URI("#{API_BASE}/oauth/token")
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl     = true
  http.read_timeout = 30

  req = Net::HTTP::Post.new(uri)
  req['Authorization'] = "Basic #{Base64.strict_encode64("#{org['username']}:#{org['password']}")}"
  req['Content-Type']  = 'application/x-www-form-urlencoded'
  req.body = 'grant_type=client_credentials'

  res = http.request(req)

  if req_log
    log_data     = JSON.parse(res.body) rescue {}
    resp_summary = res.code == '200' ? { expires_in: log_data['expires_in'] } : { error: res.body[0..200] }
    entry = { method: 'POST', path: '/oauth/token', status: res.code.to_i, response: resp_summary }
    log_mutex ? log_mutex.synchronize { req_log << entry } : req_log << entry
  end

  raise "Authentication failed for '#{org['name']}': HTTP #{res.code} – #{res.body[0..200]}" unless res.code == '200'

  data       = JSON.parse(res.body)
  token      = data['access_token']
  expires_in = data['expires_in'].to_i

  TOKEN_CACHE_MUTEX.synchronize do
    TOKEN_CACHE[org_id] = { token: token, expires_at: Time.now + expires_in }
  end

  token
end

def api_get(org, path, req_log: nil, log_mutex: nil)
  token = get_token(org, req_log: req_log, log_mutex: log_mutex)
  uri   = URI("#{API_BASE}#{path}")
  http  = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl      = true
  http.read_timeout = 30

  req = Net::HTTP::Get.new(uri)
  req['Authorization'] = "Bearer #{token}"
  req['Accept']        = 'application/json'

  res  = http.request(req)
  body = JSON.parse(res.body) rescue nil
  [res.code.to_i, body, res]
end

# Fetch every page of /v1/sims for an org (max 100 per page).
def fetch_all_sims(org, req_log: nil, log_mutex: nil)
  all_sims = []
  page     = 1

  loop do
    code, data, res = throttled_api_get(org, "/v1/sims?pageSize=100&page=#{page}")

    if req_log
      total_pages_hdr = res['X-Total-Pages']&.to_i || 1
      resp_summary    = code == 200 ? { sim_count: data.is_a?(Array) ? data.length : 0, total_pages: total_pages_hdr } : { error: res.body.to_s[0..200] }
      entry = { method: 'GET', path: "/v1/sims?pageSize=100&page=#{page}", status: code, response: resp_summary }
      log_mutex ? log_mutex.synchronize { req_log << entry } : req_log << entry
    end
    break unless code == 200

    sims = data.is_a?(Array) ? data : []
    all_sims.concat(sims)

    total_pages = res['X-Total-Pages']&.to_i || 1
    break if page >= total_pages
    page += 1
  end

  all_sims
end

# Fetch detailed data quota for a single SIM.
# Returns { volume_mb, total_volume_mb, expiry_date } on success,
# or { fetch_error: "reason" } when the API call fails/is rate-limited.
def fetch_quota_detail(org, iccid, req_log: nil, log_mutex: nil)
  code, data, _res = throttled_api_get(org, "/v1/sims/#{iccid}/quota/data")

  if req_log
    resp_summary = code == 200 && data.is_a?(Hash) \
      ? { volume_mb: data['volume'].to_f, total_volume_mb: data['total_volume'].to_f, expiry_date: data['expiry_date'] }
      : { error: code == 429 ? 'rate_limited' : "http_#{code}" }
    entry = { method: 'GET', path: "/v1/sims/#{iccid}/quota/data", status: code, response: resp_summary }
    log_mutex ? log_mutex.synchronize { req_log << entry } : req_log << entry
  end

  # 429 here means we exhausted all retries inside throttled_api_get.
  return { fetch_error: 'rate_limited' }  if code == 429
  return { fetch_error: "http_#{code}" }  unless code == 200 && data.is_a?(Hash)

  {
    volume_mb:       data['volume'].to_f,
    total_volume_mb: data['total_volume'].to_f,
    expiry_date:     data['expiry_date']
  }
end

# Build the full usage result set for one org.
# Always calls /quota/data per SIM (THREAD_POOL_SIZE parallel threads) – this
# is the only reliable source of remaining volume. The SIM list's current_quota
# field reflects the initial/total quota, not what's left.
# Concurrency is throttled by throttled_api_get to ~4 req/s per org.
def check_org_usage(org, detailed: false, req_log: nil)
  log_mutex = req_log ? Mutex.new : nil
  # Pre-warm auth token so the POST /oauth/token call appears in verbose logs.
  get_token(org, req_log: req_log, log_mutex: log_mutex) if req_log
  sims    = fetch_all_sims(org, req_log: req_log, log_mutex: log_mutex)
  results = []
  mutex   = Mutex.new

  queue = Queue.new
  sims.each { |sim| queue << sim }

  workers = THREAD_POOL_SIZE.times.map do
    Thread.new do
      loop do
        sim = begin; queue.pop(true); rescue ThreadError; break; end

        iccid  = sim['iccid']
        quota  = fetch_quota_detail(org, iccid, req_log: req_log, log_mutex: log_mutex) || { fetch_error: 'no_response' }
        error  = quota[:fetch_error]
        rem    = error ? nil : quota[:volume_mb]
        total  = error ? nil : quota[:total_volume_mb]
        expiry = error ? nil : quota[:expiry_date]

        mutex.synchronize do
          results << build_sim_row(org, sim, rem, total, expiry, error)
        end
      end
    end
  end
  workers.each(&:join)

  results
end

def build_sim_row(org, sim, remaining_mb, total_mb, expiry_date, fetch_error = nil)
  qs = sim['quota_status']
  quota_status_str = qs.is_a?(Hash) ? (qs['status'] || qs.to_s) : qs.to_s

  {
    iccid:            sim['iccid'].to_s,
    imsi:             sim['imsi'].to_s,
    label:            sim['label'].to_s,
    msisdn:           sim['msisdn'].to_s,
    ip_address:       sim['ip_address'].to_s,
    sim_status:       sim['status'].to_s,
    remaining_mb:     remaining_mb,   # nil means quota fetch failed
    total_mb:         total_mb,
    expiry_date:      expiry_date.to_s,
    quota_status:     quota_status_str,
    fetch_error:      fetch_error,    # non-nil = API error, not genuine zero
    org_id:           org['id'],
    org_name:         org['name'],
    customer_number:  org['customer_number'].to_s
  }
end

# ---------------------------------------------------------------------------
# Routes – frontend
# ---------------------------------------------------------------------------

get '/' do
  erb :index
end

# ---------------------------------------------------------------------------
# Routes – organisation management
# ---------------------------------------------------------------------------

# List orgs – never returns passwords.
get '/api/orgs' do
  content_type :json
  orgs = (load_config['organizations'] || []).map do |o|
    {
      id:                  o['id'],
      name:                o['name'],
      customer_number:     o['customer_number'],
      has_credentials:     !o['username'].to_s.empty?,
      portal_url_template: o['portal_url_template']
    }
  end
  orgs.to_json
end

# Add org.
post '/api/orgs' do
  content_type :json
  data   = JSON.parse(request.body.read)
  config = load_config
  config['organizations'] ||= []

  name     = data['name'].to_s.strip
  username = data['username'].to_s.strip
  halt 400, { error: 'Name and username are required' }.to_json if name.empty? || username.empty?

  org = {
    'id'              => SecureRandom.hex(8),
    'name'            => name,
    'customer_number' => data['customer_number'].to_s.strip,
    'username'        => username,
    'password'        => data['password'].to_s
  }

  config['organizations'] << org
  save_config(config)
  { id: org['id'], name: org['name'], customer_number: org['customer_number'] }.to_json
end

# Update org – omit password key or send empty string to leave it unchanged.
put '/api/orgs/:id' do
  content_type :json
  data   = JSON.parse(request.body.read)
  config = load_config
  org    = (config['organizations'] || []).find { |o| o['id'] == params[:id] }
  halt 404, { error: 'Organization not found' }.to_json unless org

  org['name']            = data['name'].strip            if data.key?('name')     && !data['name'].to_s.strip.empty?
  org['customer_number'] = data['customer_number'].strip if data.key?('customer_number')
  org['username']        = data['username'].strip        if data.key?('username') && !data['username'].to_s.strip.empty?
  org['password']        = data['password']              if data.key?('password') && !data['password'].to_s.empty?

  # Invalidate token cache on credential change.
  TOKEN_CACHE_MUTEX.synchronize { TOKEN_CACHE.delete(params[:id]) }
  save_config(config)
  { success: true }.to_json
end

# Delete org.
delete '/api/orgs/:id' do
  content_type :json
  config = load_config
  config['organizations']&.reject! { |o| o['id'] == params[:id] }
  TOKEN_CACHE_MUTEX.synchronize { TOKEN_CACHE.delete(params[:id]) }
  save_config(config)
  { success: true }.to_json
end

# ---------------------------------------------------------------------------
# Routes – usage check
# ---------------------------------------------------------------------------

# GET /api/check?org_id=<id>   (omit org_id to check all orgs)
# GET /api/check?org_id=<id>&detailed=true  (fetch individual quota endpoint)
get '/api/check' do
  content_type :json
  config   = load_config
  org_id   = params[:org_id]
  detailed = params[:detailed] == 'true'
  verbose  = params[:verbose]  == 'true'

  orgs = (config['organizations'] || [])
  orgs = orgs.select { |o| o['id'] == org_id } if org_id
  halt 404, { error: 'No organisations configured' }.to_json if orgs.empty?

  all_results = []
  errors      = []
  req_logs    = verbose ? [] : nil

  orgs.each do |org|
    org_log = verbose ? [] : nil
    begin
      all_results.concat(check_org_usage(org, detailed: detailed, req_log: org_log))
    rescue => e
      errors << { org_id: org['id'], org_name: org['name'], error: e.message }
    end
    req_logs.concat(org_log.map { |e| e.merge(org_name: org['name']) }) if verbose && org_log
  end

  resp = { results: all_results, errors: errors }
  resp[:request_log] = req_logs if verbose
  resp.to_json
end

# Force-expire all cached tokens so the next check re-authenticates.
post '/api/tokens/invalidate' do
  content_type :json
  TOKEN_CACHE_MUTEX.synchronize { TOKEN_CACHE.clear }
  { success: true }.to_json
end

# ---------------------------------------------------------------------------
# Routes – config export
# ---------------------------------------------------------------------------

# GET /api/export/config – downloads config.yml with passwords redacted.
get '/api/export/config' do
  config = load_config
  safe = config.dup
  safe['organizations'] = (config['organizations'] || []).map do |org|
    org.reject { |k, _| k == 'password' }
  end
  content_type 'text/yaml; charset=utf-8'
  headers['Content-Disposition'] = 'attachment; filename="config.yml"'
  YAML.dump(safe)
end

# ---------------------------------------------------------------------------
# Routes – export
# ---------------------------------------------------------------------------

# POST /api/export?format=csv|excel
# Accepts the already-loaded rows as a JSON array in the request body so we
# never re-fetch from the 1NCE API (which would immediately hit rate limits).
# The browser's exportData() function filters rows before sending, so we just
# sort and format here.
post '/api/export' do
  fmt  = params[:format] || 'csv'
  rows = JSON.parse(request.body.read).map { |r| r.transform_keys(&:to_sym) }
  halt 400, 'No rows provided' if rows.empty?

  # Sort: org name → ICCID
  rows.sort_by! { |r| [r[:org_name].to_s, r[:iccid].to_s] }

  # exhausted_only flag is purely for the filename; filtering already done client-side
  exhausted_only = rows.all? { |r| r[:fetch_error].nil? && r[:remaining_mb].to_f <= 0 }

  if fmt == 'excel'
    export_excel(rows, exhausted_only)
  else
    export_csv(rows, exhausted_only)
  end
end

# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

HEADERS = ['Organisation', 'Customer Number', 'ICCID', 'Label', 'MSISDN', 'IMSI',
           'IP Address', 'SIM Status', 'Remaining Data (MB)',
           'Total Data (MB)', 'Expiry Date', 'Quota Status'].freeze

def row_values(r)
  # IMSI is only populated for low/no-data SIMs; blank for OK SIMs in the export.
  imsi_val = (r[:remaining_mb].nil? || r[:remaining_mb] < 10) && r[:fetch_error].nil? ? r[:imsi] : ''
  [r[:org_name], r[:customer_number], r[:iccid], r[:label], r[:msisdn], imsi_val,
   r[:ip_address], r[:sim_status],
   r[:fetch_error] ? "ERROR:#{r[:fetch_error]}" : r[:remaining_mb],
   r[:total_mb], r[:expiry_date], r[:quota_status]]
end

def export_csv(rows, exhausted_only)
  fname = exhausted_only ? 'sims_no_data.csv' : 'sims_usage.csv'
  content_type 'text/csv; charset=utf-8'
  headers['Content-Disposition'] = "attachment; filename=\"#{fname}\""

  CSV.generate(force_quotes: true) do |csv|
    csv << HEADERS
    rows.each { |r| csv << row_values(r) }
  end
end

def export_excel(rows, exhausted_only)
  require 'write_xlsx'

  io = StringIO.new
  wb = WriteXLSX.new(io)

  # Formats
  hdr_fmt  = wb.add_format(bold: 1, bg_color: '#1E3A5F', color: '#FFFFFF', size: 11)
  zero_fmt = wb.add_format(bg_color: '#FDECEA', color: '#B71C1C')
  link_fmt = wb.add_format(color: '#1565C0', underline: 1)

  col_widths = [24, 16, 22, 22, 16, 20, 14, 12, 20, 18, 14, 14]

  # Group by org
  org_names = rows.map { |r| r[:org_name] }.uniq

  org_names.each do |org_name|
    org_rows   = rows.select { |r| r[:org_name] == org_name }
    cust_num   = org_rows.first[:customer_number]
    sheet_name = "#{org_name} (#{cust_num})"[0..30]
    ws         = wb.add_worksheet(sheet_name)

    # Column widths
    col_widths.each_with_index { |w, i| ws.set_column(i, i, w) }

    # Header row
    HEADERS.each_with_index { |h, i| ws.write(0, i, h, hdr_fmt) }

    # Data rows
    org_rows.each_with_index do |r, idx|
      row_num = idx + 1
      is_zero = r[:remaining_mb].to_f == 0
      row_values(r).each_with_index do |val, col|
        fmt = is_zero ? zero_fmt : nil
        ws.write(row_num, col, val, fmt)
      end
    end
  end

  # Summary sheet for multi-org exports
  if org_names.length > 1
    ws = wb.add_worksheet('Summary')
    ['Organisation', 'Customer Number', 'SIMs Listed', 'Checked At'].each_with_index { |h, i| ws.write(0, i, h, hdr_fmt) }
    org_names.each_with_index do |name, idx|
      org_rows = rows.select { |r| r[:org_name] == name }
      ws.write_row(idx + 1, 0, [name, org_rows.first[:customer_number], org_rows.count,
                                 Time.now.strftime('%Y-%m-%d %H:%M UTC')])
    end
  end

  wb.close

  fname = exhausted_only ? 'sims_no_data.xlsx' : 'sims_usage.xlsx'
  content_type 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  headers['Content-Disposition'] = "attachment; filename=\"#{fname}\""
  io.string
end
