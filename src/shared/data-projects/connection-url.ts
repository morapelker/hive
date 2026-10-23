// Connection-URL import/export for the data-project wizard ("paste a URL" ↔ fields), plus
// redaction for error texts and logs. Pure TS with no dependencies: WHATWG `URL` cannot parse
// multi-host MongoDB URLs, unencoded `@`/`#`/spaces in passwords, or `jdbc:` prefixes, so the
// authority is parsed by hand.
//
// Parsing rules (research/drivers.md §2–§6, safety.md §D4):
// - Accepted forms: `scheme://[user[:password]@]host[:port][,host2…][/database][?params]` with
//   optional `jdbc:` prefix (`jdbc:mysql:`, `jdbc:postgresql:`, `jdbc:clickhouse:`, `jdbc:ch:`,
//   `jdbc:clickhouse:https:`), libpq `key=value` DSNs, Go-MySQL `user:pw@tcp(host:3306)/db`,
//   env lines (`DATABASE_URL="postgres://…"`), and for SQLite plain paths (`/abs.db`, `~/x.db`),
//   `sqlite:///abs`, `file:/abs?mode=ro`, `jdbc:sqlite:/abs`, `:memory:`.
// - The authority ends at the first `/` or `?`; userinfo ends at the LAST `@` before that, so
//   unencoded `@`, `#`, `!` and spaces in a password survive. `/` and `?` must be encoded.
//   Userinfo and the path are percent-decoded leniently (an invalid `%` stays literal).
// - Missing ports get the engine default. Secrets never end up in `config`: the password (from
//   userinfo or `password`/`pass`/`pwd`) goes to `secrets`; other secret-looking params
//   (sslpassword, tlsCertificateKeyFilePassword, tokens, …) are dropped with a warning.
// - TLS: PG `sslmode`, MySQL `ssl-mode`/`sslmode`/`ssl=true|{json}`/`sslaccept`/JDBC `useSSL`,
//   ClickHouse `secure`/`ssl`/https, Mongo `tls`/`ssl` (implied by +srv). ClickHouse native
//   ports are mapped to HTTP: 9000 → 8123, 9440 → 8443 (https).
// - Unmapped, non-secret params are kept in `config.options`.

import {
  DATA_ENGINE_INFO,
  type DataConnectionConfig,
  type DataEngine,
  type DataMongoConfig,
  type DataParseConnectionUrlResult,
  type DataSecrets,
  type DataSslConfig,
  type DataSslMode
} from './types'

type Param = [string, string]

interface RawUrl {
  /** First scheme segment after an optional `jdbc:`, lowercase (`postgresql`, `mongodb+srv`). */
  scheme: string
  /** Further segments (`jdbc:clickhouse:https://` → ['https']). */
  subSchemes: string[]
  user?: string
  password?: string
  hosts: Array<{ host: string; port?: number }>
  /** Decoded path without the leading '/'. */
  path: string
  params: Param[]
}

type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

const ENCODE_HINT = 'If the password contains "/", "?" or "#", percent-encode it (e.g. %2F, %3F).'

/** Decodes valid %XX runs; anything malformed stays as typed. */
function percentDecode(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

function cleanInput(input: string): string {
  let s = input.trim()
  s = s.replace(/^export\s+/, '')
  const env = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*([\s\S]+)$/.exec(s)
  if (env?.[1] && /^["'`]?[a-z][a-z0-9+.:-]*:\/\//i.test(env[1].trim())) s = env[1].trim()
  const pairs: Record<string, string> = { '"': '"', "'": "'", '`': '`', '<': '>' }
  const close = pairs[s[0] ?? '']
  if (close && s.length >= 2 && s.endsWith(close)) s = s.slice(1, -1).trim()
  return s
}

function parsePort(value: string): number | null | 'invalid' {
  if (value === '') return null
  if (!/^\d{1,5}$/.test(value)) return 'invalid'
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : 'invalid'
}

function parseHosts(hostPart: string): Array<{ host: string; port?: number }> | Fail {
  if (!hostPart) return []
  const out: Array<{ host: string; port?: number }> = []
  for (const piece of hostPart.split(',')) {
    const p = piece.trim()
    if (!p) continue
    let host: string
    let portText = ''
    if (p.startsWith('[')) {
      const close = p.indexOf(']')
      if (close < 0) return fail(`Invalid IPv6 host "${p}"`)
      host = p.slice(1, close)
      const rest = p.slice(close + 1)
      if (rest.startsWith(':')) portText = rest.slice(1)
      else if (rest) return fail(`Invalid host "${p}"`)
    } else {
      const colons = p.split(':').length - 1
      if (colons === 1) {
        const idx = p.indexOf(':')
        host = p.slice(0, idx)
        portText = p.slice(idx + 1)
      } else host = p // a bare IPv6 address (no port possible) or a plain host
    }
    const port = parsePort(portText)
    if (port === 'invalid') {
      return fail(
        /^\d+$/.test(portText)
          ? `Invalid port "${portText}" (expected 1–65535)`
          : `Invalid port "${portText}". ${ENCODE_HINT}`
      )
    }
    out.push(port === null ? { host: percentDecode(host) } : { host: percentDecode(host), port })
  }
  return out
}

function parseQuery(query: string): Param[] {
  const out: Param[] = []
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = percentDecode(eq < 0 ? part : part.slice(0, eq)).trim()
    if (!key) continue
    out.push([key, eq < 0 ? '' : percentDecode(part.slice(eq + 1))])
  }
  return out
}

/** `scheme://…` after the scheme has been recognised. */
function parseAuthorityUrl(scheme: string, subSchemes: string[], rest: string): RawUrl | Fail {
  const cut = rest.search(/[/?]/)
  const authority = cut < 0 ? rest : rest.slice(0, cut)
  let tail = cut < 0 ? '' : rest.slice(cut)
  const at = authority.lastIndexOf('@')
  const userinfo = at >= 0 ? authority.slice(0, at) : null
  let hostPart = at >= 0 ? authority.slice(at + 1) : authority
  const hash = hostPart.indexOf('#')
  if (hash >= 0) {
    hostPart = hostPart.slice(0, hash)
    tail = ''
  }
  const hosts = parseHosts(hostPart)
  if (!Array.isArray(hosts)) return hosts

  const fragment = tail.indexOf('#')
  if (fragment >= 0) tail = tail.slice(0, fragment)
  const q = tail.indexOf('?')
  const rawPath = (q < 0 ? tail : tail.slice(0, q)).replace(/^\/+/, '')
  const query = q < 0 ? '' : tail.slice(q + 1)

  const raw: RawUrl = {
    scheme,
    subSchemes,
    hosts,
    path: percentDecode(rawPath),
    params: parseQuery(query)
  }
  if (userinfo !== null) {
    const colon = userinfo.indexOf(':')
    const user = percentDecode(colon < 0 ? userinfo : userinfo.slice(0, colon))
    if (user) raw.user = user
    if (colon >= 0) raw.password = percentDecode(userinfo.slice(colon + 1))
  }
  return raw
}

// ---------------------------------------------------------------------------------------------
// Parameter bag (case-insensitive lookup; whatever is left becomes config.options)
// ---------------------------------------------------------------------------------------------

interface ParamBag {
  take(...names: string[]): string | undefined
  has(...names: string[]): boolean
  /** Remaining params; secret-looking ones are dropped (and reported). */
  rest(warnings: string[]): Record<string, string> | undefined
}

const SECRET_PARAM = /pass(word)?|pwd|secret|token|credential|private_?key|api_?key|^key$|cipher/i

function paramBag(params: Param[]): ParamBag {
  const list = params.slice()
  const matches = (key: string, names: string[]): boolean =>
    names.some((n) => n.toLowerCase() === key.toLowerCase())
  return {
    take(...names) {
      let value: string | undefined
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i] as Param
        if (matches(entry[0], names)) {
          value ??= entry[1]
          list.splice(i, 1)
        }
      }
      return value
    },
    has(...names) {
      return list.some(([k]) => matches(k, names))
    },
    rest(warnings) {
      const out: Record<string, string> = {}
      for (const [k, v] of list) {
        if (SECRET_PARAM.test(k)) {
          warnings.push(
            `Dropped the "${k}" parameter: secrets other than the password are not stored`
          )
          continue
        }
        out[k] = v
      }
      return Object.keys(out).length > 0 ? out : undefined
    }
  }
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', 'y'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', 'n'])
const parseBool = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (v === '' || TRUE_WORDS.has(v)) return true
  if (FALSE_WORDS.has(v)) return false
  return undefined
}

const SSL_MODE_ALIASES: Readonly<Record<string, DataSslMode>> = {
  disable: 'disable',
  disabled: 'disable',
  false: 'disable',
  off: 'disable',
  '0': 'disable',
  allow: 'prefer',
  prefer: 'prefer',
  preferred: 'prefer',
  require: 'require',
  required: 'require',
  true: 'require',
  on: 'require',
  '1': 'require',
  'verify-ca': 'verify-ca',
  verify_ca: 'verify-ca',
  'verify-full': 'verify-full',
  verify_full: 'verify-full',
  verify_identity: 'verify-full',
  'verify-identity': 'verify-full',
  strict: 'verify-full'
}

function sslModeOf(
  value: string | undefined,
  warnings: string[],
  param: string
): DataSslMode | undefined {
  if (value === undefined) return undefined
  const mode = SSL_MODE_ALIASES[value.trim().toLowerCase()]
  if (!mode) warnings.push(`Unknown ${param} "${value}" ignored`)
  return mode
}

function sslConfig(
  mode: DataSslMode | undefined,
  paths: { caPath?: string; certPath?: string; keyPath?: string }
): DataSslConfig | undefined {
  const hasPath = !!(paths.caPath || paths.certPath || paths.keyPath)
  if (!mode && !hasPath) return undefined
  const ssl: DataSslConfig = { mode: mode ?? (paths.caPath ? 'verify-ca' : 'require') }
  if (paths.caPath) ssl.caPath = paths.caPath
  if (paths.certPath) ssl.certPath = paths.certPath
  if (paths.keyPath) ssl.keyPath = paths.keyPath
  return ssl
}

function suggestedNameOf(
  database: string | undefined,
  host: string | undefined,
  engine: DataEngine
): string {
  if (database && host) return `${database} @ ${host}`
  return database || host || DATA_ENGINE_INFO[engine].label
}

const formatHost = (host: string): string => (host.includes(':') ? `[${host}]` : host)

// ---------------------------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------------------------

function firstHost(raw: RawUrl, warnings: string[]): { host?: string; port?: number } {
  if (raw.hosts.length > 1) {
    warnings.push(`Multi-host URL: using the first host (${raw.hosts[0]?.host})`)
  }
  return raw.hosts[0] ?? {}
}

function takePassword(raw: RawUrl, params: ParamBag, secrets: DataSecrets): void {
  const fromParam = params.take('password', 'pass', 'pwd')
  const password = raw.password ?? fromParam
  if (password !== undefined && password !== '') secrets.password = password
}

function parseMysqlFamily(engine: 'mysql' | 'mariadb', raw: RawUrl): DataParseConnectionUrlResult {
  const warnings: string[] = []
  const params = paramBag(raw.params)
  const secrets: DataSecrets = {}
  const first = firstHost(raw, warnings)
  const hostParam = params.take('host')
  const portParam = params.take('port')
  const portFromParam = portParam !== undefined ? parsePort(portParam) : null
  if (portFromParam === 'invalid') return fail(`Invalid port "${portParam}"`)
  const host = first.host || hostParam || 'localhost'
  const port = first.port ?? portFromParam ?? 3306
  const user = raw.user ?? params.take('user', 'username')
  takePassword(raw, params, secrets)
  const database = raw.path.split('/')[0] || params.take('database', 'db', 'dbname') || undefined

  let mode = sslModeOf(params.take('ssl-mode', 'sslmode', 'ssl_mode'), warnings, 'ssl-mode')
  const sslAccept = params.take('sslaccept')
  if (!mode && sslAccept !== undefined) {
    mode = sslAccept.toLowerCase() === 'strict' ? 'verify-full' : 'require'
  }
  const sslParam = params.take('ssl')
  if (!mode && sslParam !== undefined) {
    const trimmed = sslParam.trim()
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed) as { rejectUnauthorized?: boolean }
        mode = json.rejectUnauthorized === false ? 'require' : 'verify-full'
      } catch {
        warnings.push('Could not read the ssl={…} parameter; using SSL without verification')
        mode = 'require'
      }
    } else {
      const b = parseBool(trimmed)
      mode = b === false ? 'disable' : b === true ? 'require' : sslModeOf(trimmed, warnings, 'ssl')
    }
  }
  const useSsl = parseBool(params.take('useSSL', 'useSsl', 'requireSSL'))
  const verifyServer = parseBool(params.take('verifyServerCertificate'))
  if (!mode && useSsl !== undefined) {
    mode = useSsl ? (verifyServer ? 'verify-ca' : 'require') : 'disable'
  }
  const ssl = sslConfig(mode, {
    caPath: params.take('ssl-ca', 'sslca', 'ssl_ca', 'sslrootcert', 'serverSslCert'),
    certPath: params.take('ssl-cert', 'sslcert', 'ssl_cert'),
    keyPath: params.take('ssl-key', 'sslkey', 'ssl_key')
  })

  const config: DataConnectionConfig = { host, port }
  if (database) config.database = database
  if (user) config.user = user
  if (ssl) config.ssl = ssl
  const options = params.rest(warnings)
  if (options) config.options = options
  return {
    ok: true,
    value: {
      engine,
      config,
      secrets,
      suggestedName: suggestedNameOf(database, host, engine),
      warnings
    }
  }
}

function parsePostgres(raw: RawUrl): DataParseConnectionUrlResult {
  const warnings: string[] = []
  const params = paramBag(raw.params)
  const secrets: DataSecrets = {}
  let hosts = raw.hosts
  const hostParam = params.take('host')
  const hostAddr = params.take('hostaddr')
  if (hosts.length === 0 && hostParam) {
    // libpq allows host=a,b and Unix-socket directories (host=/var/run/postgresql).
    const list = hostParam.startsWith('/') ? [{ host: hostParam }] : parseHosts(hostParam)
    if (!Array.isArray(list)) return list
    hosts = list
  }
  if (hosts.length > 1) warnings.push(`Multi-host URL: using the first host (${hosts[0]?.host})`)
  const portParam = params.take('port')
  const portFromParam = portParam !== undefined ? parsePort(portParam.split(',')[0] ?? '') : null
  if (portFromParam === 'invalid') return fail(`Invalid port "${portParam}"`)
  const host = hosts[0]?.host || hostAddr || 'localhost'
  const port = hosts[0]?.port ?? portFromParam ?? 5432
  const user = raw.user ?? params.take('user', 'username')
  takePassword(raw, params, secrets)
  const database = raw.path.split('/')[0] || params.take('dbname', 'database', 'db') || undefined

  let mode = sslModeOf(params.take('sslmode'), warnings, 'sslmode')
  const sslParam = params.take('ssl')
  if (!mode && sslParam !== undefined) {
    const b = parseBool(sslParam)
    mode = b === false ? 'disable' : 'require'
  }
  const ssl = sslConfig(mode, {
    caPath: params.take('sslrootcert'),
    certPath: params.take('sslcert'),
    keyPath: params.take('sslkey')
  })

  const config: DataConnectionConfig = { host, port }
  if (database) config.database = database
  if (user) config.user = user
  if (ssl) config.ssl = ssl
  const options = params.rest(warnings)
  if (options) config.options = options
  return {
    ok: true,
    value: {
      engine: 'postgres',
      config,
      secrets,
      suggestedName: suggestedNameOf(database, host, 'postgres'),
      warnings
    }
  }
}

function parseClickHouse(raw: RawUrl): DataParseConnectionUrlResult {
  const warnings: string[] = []
  const params = paramBag(raw.params)
  const secrets: DataSecrets = {}
  const first = firstHost(raw, warnings)
  const explicitHttp = raw.scheme === 'http' || raw.subSchemes.includes('http')
  let https =
    raw.scheme === 'https' || raw.scheme === 'clickhouses' || raw.subSchemes.includes('https')
  const secure = parseBool(params.take('secure', 'ssl', 'tls'))
  if (secure !== undefined) https = secure
  const portParam = params.take('port')
  const portFromParam = portParam !== undefined ? parsePort(portParam) : null
  if (portFromParam === 'invalid') return fail(`Invalid port "${portParam}"`)
  let port = first.port ?? portFromParam ?? undefined
  if (port === 9000) {
    warnings.push('Native protocol port 9000 mapped to the HTTP port 8123')
    port = 8123
  } else if (port === 9440) {
    warnings.push('Native TLS port 9440 mapped to the HTTPS port 8443')
    port = 8443
    https = true
  } else if ((port === 8443 || port === 443) && !explicitHttp && secure === undefined) {
    https = true
  }
  if (port === undefined) port = https ? 8443 : 8123
  const host = first.host || params.take('host') || 'localhost'
  const user = raw.user ?? params.take('user', 'username')
  takePassword(raw, params, secrets)
  const database = raw.path.split('/')[0] || params.take('database', 'db') || undefined
  const sslmode = params.take('sslmode')
  let mode: DataSslMode | undefined
  if (sslmode !== undefined) {
    // clickhouse-jdbc: sslmode=strict (verify) | none (encrypt only)
    mode = sslmode.toLowerCase() === 'none' ? 'require' : sslModeOf(sslmode, warnings, 'sslmode')
  }
  const ssl = https
    ? sslConfig(mode, {
        caPath: params.take('sslrootcert', 'ca_cert', 'ca'),
        certPath: params.take('sslcert', 'cert'),
        keyPath: params.take('sslkey', 'key')
      })
    : undefined

  const config: DataConnectionConfig = { host, port, clickhouseProtocol: https ? 'https' : 'http' }
  if (database) config.database = database
  if (user) config.user = user
  if (ssl) config.ssl = ssl
  const options = params.rest(warnings)
  if (options) config.options = options
  return {
    ok: true,
    value: {
      engine: 'clickhouse',
      config,
      secrets,
      suggestedName: suggestedNameOf(database, host, 'clickhouse'),
      warnings
    }
  }
}

function parseMongo(raw: RawUrl): DataParseConnectionUrlResult {
  const warnings: string[] = []
  const params = paramBag(raw.params)
  const secrets: DataSecrets = {}
  const srv = raw.scheme === 'mongodb+srv'
  if (raw.hosts.length === 0) return fail('The MongoDB URL has no host')
  if (srv && raw.hosts.length > 1) return fail('A mongodb+srv URL takes exactly one host name')
  if (srv && raw.hosts[0]?.port !== undefined) return fail('A mongodb+srv URL cannot have a port')
  if (raw.password !== undefined && raw.password !== '') secrets.password = raw.password
  const hosts = raw.hosts.map((h) =>
    srv ? formatHost(h.host) : `${formatHost(h.host)}:${h.port ?? 27017}`
  )
  const database = raw.path.split('/')[0] || undefined

  const mongo: DataMongoConfig = { srv, hosts }
  const authSource = params.take('authSource')
  if (authSource) mongo.authSource = authSource
  const authMechanism = params.take('authMechanism')
  if (authMechanism) mongo.authMechanism = authMechanism
  const replicaSet = params.take('replicaSet')
  if (replicaSet) mongo.replicaSet = replicaSet
  const direct = parseBool(params.take('directConnection'))
  if (direct !== undefined) mongo.directConnection = direct
  const tlsParam = parseBool(params.take('tls', 'ssl'))
  const tls = tlsParam ?? (srv ? true : undefined)
  if (tls !== undefined) mongo.tls = tls
  const insecure = parseBool(params.take('tlsInsecure'))
  const allowInvalid = parseBool(
    params.take('tlsAllowInvalidCertificates', 'sslAllowInvalidCertificates')
  )
  if (allowInvalid !== undefined || insecure)
    mongo.tlsAllowInvalidCertificates = !!(allowInvalid || insecure)
  const readPreference = params.take('readPreference')
  if (readPreference) mongo.readPreference = readPreference
  const mechProps = params.take('authMechanismProperties')

  const caPath = params.take('tlsCAFile', 'sslCAFile')
  const certPath = params.take('tlsCertificateKeyFile', 'sslPEMKeyFile')
  const allowInvalidHostnames = parseBool(params.take('tlsAllowInvalidHostnames'))
  const mode: DataSslMode | undefined =
    tls === false
      ? 'disable'
      : mongo.tlsAllowInvalidCertificates
        ? 'require'
        : allowInvalidHostnames
          ? 'verify-ca'
          : 'verify-full'
  const ssl = caPath || certPath ? sslConfig(mode, { caPath, certPath }) : undefined

  const first = raw.hosts[0] as { host: string; port?: number }
  const config: DataConnectionConfig = { host: first.host, mongo }
  if (!srv) config.port = first.port ?? 27017
  if (database) config.database = database
  if (raw.user) config.user = raw.user
  if (ssl) config.ssl = ssl
  const options = params.rest(warnings) ?? {}
  if (allowInvalidHostnames !== undefined)
    options.tlsAllowInvalidHostnames = String(allowInvalidHostnames)
  if (mechProps !== undefined) {
    if (/TOKEN|SECRET/i.test(mechProps)) {
      warnings.push('Dropped authMechanismProperties: it contains a session token or secret')
    } else options.authMechanismProperties = mechProps
  }
  if (Object.keys(options).length > 0) config.options = options
  return {
    ok: true,
    value: {
      engine: 'mongodb',
      config,
      secrets,
      suggestedName: suggestedNameOf(database, first.host, 'mongodb'),
      warnings
    }
  }
}

// ---------------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------------

const SQLITE_EXT = /\.(db|sqlite|sqlite3|db3|s3db|sl3)$/i

function looksLikeSqlitePath(s: string): boolean {
  if (s.includes('://')) return false
  if (s === ':memory:') return true
  if (/^(\/|~\/|~$|\.\.?\/)/.test(s)) return !/\s\w+=/.test(s)
  return SQLITE_EXT.test(s) && !s.includes('=') && !s.includes('@')
}

/** Resolves `.` and `..` segments of an absolute or `~/` path (pure: no filesystem access). */
function normalizeSlashPath(path: string): string {
  if (path === ':memory:' || !path.includes('.')) return path
  const [head, ...segments] = path.split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return [head, ...out].join('/') || '/'
}

function parseSqlite(input: string): DataParseConnectionUrlResult {
  const warnings: string[] = []
  let s = input
  let isUrl = false
  const scheme = /^(?:jdbc:)?(sqlite3?|file):/i.exec(s)
  if (scheme) {
    isUrl = true
    s = s.slice(scheme[0].length)
    if (s.startsWith('//')) {
      const rest = s.slice(2)
      if (rest.startsWith('/')) s = rest
      else if (/^localhost\//i.test(rest)) s = rest.slice('localhost'.length)
      else s = rest // `sqlite://rel.db`, `sqlite://~/x.db`, `sqlite://:memory:`
    }
  }
  let query: Param[] = []
  if (isUrl) {
    const hash = s.indexOf('#')
    if (hash >= 0) s = s.slice(0, hash)
    const q = s.indexOf('?')
    if (q >= 0) {
      query = parseQuery(s.slice(q + 1))
      s = s.slice(0, q)
    }
    s = percentDecode(s)
  }
  const bag = paramBag(query)
  let path = s.replace(/^\/{2,}/, '/')
  if (!path) return fail('The SQLite URL has no file path')
  let readOnlyFile: boolean | undefined
  const mode = bag.take('mode')
  if (mode !== undefined) readOnlyFile = mode.toLowerCase() === 'ro'
  if (parseBool(bag.take('immutable')) === true) readOnlyFile = true
  const ro = parseBool(bag.take('readonly', 'read_only', 'readOnly'))
  if (ro !== undefined) readOnlyFile = ro
  const openMode = bag.take('open_mode')
  if (openMode !== undefined && /^\d+$/.test(openMode) && (Number(openMode) & 1) === 1)
    readOnlyFile = true

  if (path === ':memory:') {
    warnings.push('An in-memory database starts empty and is lost when the connection closes')
  } else if (path === '~' || path.startsWith('~/')) {
    // expanded server-side
  } else if (!path.startsWith('/')) {
    return fail(`SQLite needs an absolute file path (got "${path}"); choose the file instead`)
  }
  path = normalizeSlashPath(path.replace(/\/{2,}/g, '/'))
  const config: DataConnectionConfig = { filePath: path, database: 'main' }
  if (readOnlyFile !== undefined) config.readOnlyFile = readOnlyFile
  const options = bag.rest(warnings)
  if (options) config.options = options
  const base = path.split('/').pop() ?? path
  const name = path === ':memory:' ? 'In-memory SQLite' : base.replace(SQLITE_EXT, '') || base
  return {
    ok: true,
    value: { engine: 'sqlite', config, secrets: {}, suggestedName: name, warnings }
  }
}

// ---------------------------------------------------------------------------------------------
// DSN forms without a scheme
// ---------------------------------------------------------------------------------------------

const DSN_KEYS = new Set(['host', 'hostaddr', 'port', 'dbname', 'user', 'password', 'sslmode'])

/** libpq `key=value key='quoted value'` → params, or null when it is not a DSN. */
function parseLibpqDsn(s: string): Param[] | null {
  const out: Param[] = []
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*('(?:[^'\\]|\\.)*'|[^\s']*)/y
  let i = 0
  while (i < s.length) {
    re.lastIndex = i
    const m = re.exec(s)
    if (!m) return /^\s*$/.test(s.slice(i)) ? out : null
    let value = m[2] ?? ''
    if (value.startsWith("'")) value = value.slice(1, -1).replace(/\\(.)/g, '$1')
    out.push([m[1] as string, value])
    i = re.lastIndex
  }
  return out.length > 0 && out.some(([k]) => DSN_KEYS.has(k.toLowerCase())) ? out : null
}

const GO_MYSQL_DSN = /^(?:([^:@]*?)(?::(.*))?@)?(tcp|unix)\(([^)]*)\)\/([^?]*)(?:\?(.*))?$/

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const SCHEME_ENGINES: Readonly<Record<string, DataEngine>> = {
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mariadb',
  postgres: 'postgres',
  postgresql: 'postgres',
  pgsql: 'postgres',
  clickhouse: 'clickhouse',
  clickhouses: 'clickhouse',
  ch: 'clickhouse',
  http: 'clickhouse',
  https: 'clickhouse',
  tcp: 'clickhouse',
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite'
}

const UNSUPPORTED: Readonly<Record<string, string>> = {
  mysqlx: 'mysqlx:// is the MySQL X Protocol; use the classic protocol (mysql://, port 3306)',
  redis: 'Redis is not supported',
  rediss: 'Redis is not supported',
  mssql: 'SQL Server is not supported',
  sqlserver: 'SQL Server is not supported',
  oracle: 'Oracle is not supported',
  snowflake: 'Snowflake is not supported',
  cockroachdb: 'Use a postgresql:// URL for CockroachDB'
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*(?::[a-z][a-z0-9+.-]*)*):\/\//i

type Detection =
  | { kind: 'url'; engine: DataEngine; scheme: string; subSchemes: string[]; rest: string }
  | { kind: 'sqlite' }
  | { kind: 'dsn'; params: Param[] }
  | { kind: 'go-mysql'; match: RegExpExecArray }
  | { kind: 'error'; error: string }

function detect(s: string, hint?: DataEngine): Detection | null {
  if (!s) return null
  if (looksLikeSqlitePath(s)) return { kind: 'sqlite' }
  const m = SCHEME_RE.exec(s)
  if (m) {
    let segments = (m[1] as string).toLowerCase().split(':')
    if (segments[0] === 'jdbc') segments = segments.slice(1)
    const scheme = segments[0] ?? ''
    const unsupported = UNSUPPORTED[scheme]
    if (unsupported) return { kind: 'error', error: unsupported }
    const engine = SCHEME_ENGINES[scheme]
    if (!engine) return { kind: 'error', error: `Unrecognised URL scheme "${scheme}://"` }
    if (engine === 'sqlite') return { kind: 'sqlite' }
    return {
      kind: 'url',
      engine,
      scheme,
      subSchemes: segments.slice(1),
      rest: s.slice(m[0].length)
    }
  }
  if (/^(?:jdbc:)?(sqlite3?|file):/i.test(s)) return { kind: 'sqlite' }
  const dsn = parseLibpqDsn(s)
  if (dsn) return { kind: 'dsn', params: dsn }
  const go = GO_MYSQL_DSN.exec(s)
  if (go) return { kind: 'go-mysql', match: go }
  if (hint === 'sqlite') return { kind: 'sqlite' }
  if (hint && !/\s/.test(s)) {
    // `user:pw@host:port/db` typed for the engine picked in the wizard.
    const scheme = hint === 'postgres' ? 'postgresql' : hint
    return { kind: 'url', engine: hint, scheme, subSchemes: [], rest: s }
  }
  return null
}

/** The engine a URL/DSN/path is for, or null when it is not recognisable. */
export function detectEngineFromUrl(url: string): DataEngine | null {
  const d = detect(cleanInput(url))
  if (!d) return null
  switch (d.kind) {
    case 'url':
      return d.engine
    case 'sqlite':
      return 'sqlite'
    case 'dsn':
      return 'postgres'
    case 'go-mysql':
      return 'mysql'
    default:
      return null
  }
}

/**
 * Parses a pasted connection string into config + secrets (see the file header). `engineHint`
 * is the engine picked in the wizard: it disambiguates scheme-less input, `tcp://`, and MySQL
 * vs MariaDB; a URL that clearly names another engine wins (with a warning).
 */
export function parseConnectionUrl(
  url: string,
  engineHint?: DataEngine
): DataParseConnectionUrlResult {
  const s = cleanInput(url ?? '')
  if (!s) return fail('Paste a connection URL')
  const d = detect(s, engineHint)
  if (!d) {
    return fail(
      'Not a recognisable connection URL (expected e.g. postgres://user@host:5432/db, mysql://…, mongodb://…, clickhouse://…, or a SQLite file path)'
    )
  }
  let result: DataParseConnectionUrlResult
  switch (d.kind) {
    case 'error':
      return fail(d.error)
    case 'sqlite':
      result = parseSqlite(s)
      break
    case 'dsn':
      result = parsePostgres({
        scheme: 'postgresql',
        subSchemes: [],
        hosts: [],
        path: '',
        params: d.params
      })
      break
    case 'go-mysql': {
      const [, user, password, proto, addr, db, query] = d.match
      const params = parseQuery(query ?? '')
      let hosts: Array<{ host: string; port?: number }> = []
      if (proto === 'tcp') {
        const parsed = parseHosts(addr ?? '')
        if (!Array.isArray(parsed)) return parsed
        hosts = parsed
      } else if (addr) params.push(['socket', addr])
      const engine = engineHint === 'mariadb' ? 'mariadb' : 'mysql'
      const raw: RawUrl = {
        scheme: engine,
        subSchemes: [],
        hosts,
        path: percentDecode(db ?? ''),
        params
      }
      if (user) raw.user = user
      if (password !== undefined) raw.password = password
      result = parseMysqlFamily(engine, raw)
      break
    }
    case 'url': {
      let engine = d.engine
      if (
        (engine === 'mysql' || engine === 'mariadb') &&
        (engineHint === 'mysql' || engineHint === 'mariadb')
      )
        engine = engineHint
      if (d.scheme === 'tcp' && engineHint && engineHint !== 'sqlite') engine = engineHint
      const raw = parseAuthorityUrl(d.scheme, d.subSchemes, d.rest)
      if ('ok' in raw) return raw
      switch (engine) {
        case 'mysql':
        case 'mariadb':
          result = parseMysqlFamily(engine, raw)
          break
        case 'postgres':
          result = parsePostgres(raw)
          break
        case 'clickhouse':
          result = parseClickHouse(raw)
          break
        case 'mongodb':
          if (d.scheme !== 'mongodb' && d.scheme !== 'mongodb+srv') raw.scheme = 'mongodb'
          result = parseMongo(raw)
          break
        default:
          return fail('Unsupported engine')
      }
      break
    }
  }
  if (result.ok && engineHint && result.value.engine !== engineHint) {
    result.value.warnings.unshift(
      `This is a ${DATA_ENGINE_INFO[result.value.engine].label} connection string, not ${DATA_ENGINE_INFO[engineHint].label}`
    )
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// Building and redacting
// ---------------------------------------------------------------------------------------------

const MYSQL_SSL_NAMES: Readonly<Record<DataSslMode, string>> = {
  disable: 'DISABLED',
  prefer: 'PREFERRED',
  require: 'REQUIRED',
  'verify-ca': 'VERIFY_CA',
  'verify-full': 'VERIFY_IDENTITY'
}

const enc = encodeURIComponent
const encodePath = (path: string): string => path.split('/').map(enc).join('/')

/**
 * A URL for `config` ("Copy URL"). The password is only included when passed explicitly in
 * `options.password` ("Copy with password"); `config.options` are appended as params.
 */
export function buildConnectionUrl(
  engine: DataEngine,
  config: DataConnectionConfig,
  options: { password?: string } = {}
): string {
  const params: Param[] = []
  const add = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') params.push([key, value])
  }
  const appendOptions = (): void => {
    for (const [k, v] of Object.entries(config.options ?? {})) {
      if (!params.some(([existing]) => existing.toLowerCase() === k.toLowerCase()))
        params.push([k, v])
    }
  }
  const query = (): string =>
    params.length > 0 ? `?${params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')}` : ''
  const password =
    typeof options.password === 'string' && options.password !== '' ? options.password : undefined
  const userinfo = (): string => {
    if (!config.user && password === undefined) return ''
    return `${enc(config.user ?? '')}${password !== undefined ? `:${enc(password)}` : ''}@`
  }
  const dbPath = (): string =>
    config.database ? `/${enc(config.database)}` : params.length > 0 ? '/' : ''

  if (engine === 'sqlite') {
    const path = config.filePath ?? ''
    if (config.readOnlyFile) add('mode', 'ro')
    appendOptions()
    // sqlite:///abs/x.db, sqlite://~/x.db (the parser reads both back).
    return `sqlite://${encodePath(path)}${query()}`
  }

  if (engine === 'mongodb') {
    const m = config.mongo
    const srv = m?.srv ?? false
    const hosts =
      m?.hosts && m.hosts.length > 0
        ? m.hosts
        : [
            srv
              ? formatHost(config.host ?? 'localhost')
              : `${formatHost(config.host ?? 'localhost')}:${config.port ?? 27017}`
          ]
    add('authSource', m?.authSource)
    add('authMechanism', m?.authMechanism)
    add('replicaSet', m?.replicaSet)
    if (m?.directConnection !== undefined) add('directConnection', String(m.directConnection))
    if (m?.tls !== undefined && !(srv && m.tls)) add('tls', String(m.tls))
    if (m?.tlsAllowInvalidCertificates) add('tlsAllowInvalidCertificates', 'true')
    add('readPreference', m?.readPreference)
    add('tlsCAFile', config.ssl?.caPath)
    add('tlsCertificateKeyFile', config.ssl?.certPath)
    appendOptions()
    return `${srv ? 'mongodb+srv' : 'mongodb'}://${userinfo()}${hosts.join(',')}${dbPath()}${query()}`
  }

  const info = DATA_ENGINE_INFO[engine]
  const host = formatHost(config.host || 'localhost')
  let scheme: string
  let port = config.port ?? info.defaultPort ?? undefined
  if (engine === 'clickhouse') {
    const https = config.clickhouseProtocol
      ? config.clickhouseProtocol === 'https'
      : port === 8443 || port === 443
    scheme = https ? 'https' : 'http'
    port = config.port ?? (https ? 8443 : 8123)
  } else if (engine === 'postgres') {
    scheme = 'postgresql'
    if (config.ssl) add('sslmode', config.ssl.mode)
    add('sslrootcert', config.ssl?.caPath)
    add('sslcert', config.ssl?.certPath)
    add('sslkey', config.ssl?.keyPath)
  } else {
    scheme = engine
    if (config.ssl) add('ssl-mode', MYSQL_SSL_NAMES[config.ssl.mode])
    add('ssl-ca', config.ssl?.caPath)
    add('ssl-cert', config.ssl?.certPath)
    add('ssl-key', config.ssl?.keyPath)
  }
  appendOptions()
  return `${scheme}://${userinfo()}${host}${port ? `:${port}` : ''}${dbPath()}${query()}`
}

const SECRET_QUERY_PARAM =
  /((?:^|[?&;\s,(])(?:password|pass|pwd|sslpassword|proxyPassword|tlsCertificateKeyFilePassword|access_token|token|secret)\s*=\s*)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^&\s'",;)]*)/gi

/**
 * Replaces credentials in free text (error messages, logs): `scheme://user:pass@` →
 * `scheme://user:***@`, and secret params (`password=…`, `token=…`) → `***`.
 */
export function redactConnectionUrl(text: string): string {
  if (!text) return text
  // A scheme only starts after a non-scheme character: linear on long `a-b-c…` runs.
  let out = text.replace(
    /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/?'"<>]*)/gi,
    (whole, scheme: string, authority: string) => {
      const at = authority.lastIndexOf('@')
      if (at < 0) return whole
      const userinfo = authority.slice(0, at)
      const colon = userinfo.indexOf(':')
      if (colon < 0) return whole
      return `${scheme}${userinfo.slice(0, colon)}:***${authority.slice(at)}`
    }
  )
  out = out.replace(SECRET_QUERY_PARAM, (_m, head: string, value: string) => {
    if (value === '' || value === '***') return head + value
    const q = value[0]
    return head + (q === "'" || q === '"' ? `${q}***${q}` : '***')
  })
  return out
}
