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

def get_token(org)
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
  raise "Authentication failed for '#{org['name']}': HTTP #{res.code} – #{res.body[0..200]}" unless res.code == '200'

  data       = JSON.parse(res.body)
  token      = data['access_token']
  expires_in = data['expires_in'].to_i

  TOKEN_CACHE_MUTEX.synchronize do
    TOKEN_CACHE[org_id] = { token: token, expires_at: Time.now + expires_in }
  end

  token
end

def api_get(org, path)
  token = get_token(org)
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
def fetch_all_sims(org)
  all_sims = []
  page     = 1

  loop do
    code, data, res = api_get(org, "/v1/sims?pageSize=100&page=#{page}")
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
# Returns { volume_mb, total_volume_mb, expiry_date } or nil on error.
def fetch_quota_detail(org, iccid)
  code, data, _res = api_get(org, "/v1/sims/#{iccid}/quota/data")
  return nil unless code == 200 && data.is_a?(Hash)

  {
    volume_mb:       data['volume'].to_f,
    total_volume_mb: data['total_volume'].to_f,
    expiry_date:     data['expiry_date']
  }
end

PORTAL_DEFAULT = 'https://api.1nce.com/management-api/v1/sims/{iccid}'.freeze

def portal_url(org, iccid)
  tpl = org['portal_url_template'].to_s
  tpl = PORTAL_DEFAULT if tpl.empty?
  tpl.gsub('{iccid}', iccid.to_s)
     .gsub('{customer_number}', org['customer_number'].to_s)
end

# Build the full usage result set for one org.
# detailed: if true, calls individual quota endpoint for each SIM (slower but gets expiry_date).
def check_org_usage(org, detailed: false)
  sims    = fetch_all_sims(org)
  results = []
  mutex   = Mutex.new

  # Thread pool (20 workers) for parallel quota calls when detailed mode.
  if detailed
    queue = Queue.new
    sims.each { |sim| queue << sim }

    workers = 20.times.map do
      Thread.new do
        loop do
          sim = begin; queue.pop(true); rescue ThreadError; break; end

          iccid  = sim['iccid']
          quota  = fetch_quota_detail(org, iccid) || {}
          rem    = quota[:volume_mb] || sim['current_quota'].to_f
          total  = quota[:total_volume_mb] || 0.0
          expiry = quota[:expiry_date]

          mutex.synchronize do
            results << build_sim_row(org, sim, rem, total, expiry)
          end
        end
      end
    end
    workers.each(&:join)
  else
    # Fast path: use current_quota from SIM list directly.
    sims.each do |sim|
      rem = sim['current_quota'].to_f
      results << build_sim_row(org, sim, rem, 0.0, nil)
    end
  end

  results
end

def build_sim_row(org, sim, remaining_mb, total_mb, expiry_date)
  qs = sim['quota_status']
  quota_status_str = qs.is_a?(Hash) ? (qs['status'] || qs.to_s) : qs.to_s

  {
    iccid:            sim['iccid'].to_s,
    label:            sim['label'].to_s,
    msisdn:           sim['msisdn'].to_s,
    ip_address:       sim['ip_address'].to_s,
    sim_status:       sim['status'].to_s,
    remaining_mb:     remaining_mb,
    total_mb:         total_mb,
    expiry_date:      expiry_date.to_s,
    quota_status:     quota_status_str,
    org_id:           org['id'],
    org_name:         org['name'],
    customer_number:  org['customer_number'].to_s,
    portal_url:       portal_url(org, sim['iccid'].to_s)
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
    'id'                  => SecureRandom.hex(8),
    'name'                => name,
    'customer_number'     => data['customer_number'].to_s.strip,
    'username'            => username,
    'password'            => data['password'].to_s,
    'portal_url_template' => data['portal_url_template'].to_s.strip
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

  org['name']                = data['name'].strip                       if data.key?('name')      && !data['name'].to_s.strip.empty?
  org['customer_number']     = data['customer_number'].strip            if data.key?('customer_number')
  org['username']            = data['username'].strip                   if data.key?('username')   && !data['username'].to_s.strip.empty?
  org['password']            = data['password']                        if data.key?('password')   && !data['password'].to_s.empty?
  org['portal_url_template'] = data['portal_url_template'].to_s.strip  if data.key?('portal_url_template')

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

  orgs = (config['organizations'] || [])
  orgs = orgs.select { |o| o['id'] == org_id } if org_id
  halt 404, { error: 'No organisations configured' }.to_json if orgs.empty?

  all_results = []
  errors      = []

  orgs.each do |org|
    begin
      all_results.concat(check_org_usage(org, detailed: detailed))
    rescue => e
      errors << { org_id: org['id'], org_name: org['name'], error: e.message }
    end
  end

  { results: all_results, errors: errors }.to_json
end

# ---------------------------------------------------------------------------
# Routes – export
# ---------------------------------------------------------------------------

# GET /api/export?format=csv|excel&org_id=<id>&exhausted_only=true
get '/api/export' do
  config         = load_config
  org_id         = params[:org_id]
  fmt            = params[:format] || 'csv'
  exhausted_only = params[:exhausted_only] != 'false'
  detailed       = params[:detailed] != 'false'  # default true for exports

  orgs = (config['organizations'] || [])
  orgs = orgs.select { |o| o['id'] == org_id } if org_id
  halt 400, 'No organisations configured' if orgs.empty?

  all_results = []
  orgs.each do |org|
    begin
      rows = check_org_usage(org, detailed: detailed)
      rows = rows.select { |r| r[:remaining_mb].to_f == 0 } if exhausted_only
      all_results.concat(rows)
    rescue => e
      # silently skip failed orgs during export; errors shown in UI
    end
  end

  # Sort: org name → ICCID
  all_results.sort_by! { |r| [r[:org_name], r[:iccid]] }

  if fmt == 'excel'
    export_excel(all_results, exhausted_only)
  else
    export_csv(all_results, exhausted_only)
  end
end

# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

HEADERS = ['Organisation', 'Customer Number', 'ICCID', 'Label', 'MSISDN',
           'IP Address', 'SIM Status', 'Remaining Data (MB)',
           'Total Data (MB)', 'Expiry Date', 'Quota Status', 'Portal Link'].freeze

def row_values(r)
  [r[:org_name], r[:customer_number], r[:iccid], r[:label], r[:msisdn],
   r[:ip_address], r[:sim_status], r[:remaining_mb],
   r[:total_mb], r[:expiry_date], r[:quota_status], r[:portal_url]]
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

  col_widths = [24, 16, 22, 22, 16, 14, 12, 20, 18, 14, 14, 55]

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
        fmt = if col == 11        then link_fmt   # portal link column always blue
               elsif is_zero      then zero_fmt   # red background for exhausted rows
               end
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
