// The add/edit data project wizard's form model: one flat, string-typed form (what the inputs
// edit), converted to and from the contract's DataConnectionConfig / secrets / create & update
// inputs, plus per-field validation. Pure functions only, so the URL ↔ fields round trip, the
// edit-mode secret semantics and the validation rules are unit-tested without rendering.
//
// Secrets in edit mode: the renderer never receives stored secrets. Each secret has a mode:
// 'keep' (send nothing: the server keeps what it has), 'replace' (send the typed value) or
// 'clear' (send null). In create mode every secret is 'replace' and an empty value means none.

import {
  DATA_ENGINE_INFO,
  DATA_ENVIRONMENT_DEFAULTS,
  DATA_HARD_ROW_CAP,
  type DataConnectionConfig,
  type DataEngine,
  type DataEnvironment,
  type DataParsedConnectionUrl,
  type DataProject,
  type DataProjectCreateInput,
  type DataProjectIcon,
  type DataProjectUpdateInput,
  type DataSafeMode,
  type DataSecrets,
  type DataSecretsPatch,
  type DataSshAuthMethod,
  type DataSslMode
} from '@shared/data-projects/types'
import { buildConnectionUrl } from '@shared/data-projects/connection-url'
import type { DataProjectDefaults } from '@/stores/useDataProjectStore'
import { fileBaseName, isLocalHost, stricterSafeMode } from '../data-project-ui'

export type WizardStepId = 'engine' | 'connection' | 'test' | 'details'
export type SecretMode = 'keep' | 'replace' | 'clear'

/** Engines that can tunnel through SSH (server: SSH_ENGINES in connection-manager.ts). */
export const SSH_CAPABLE_ENGINES: ReadonlySet<DataEngine> = new Set([
  'mysql',
  'mariadb',
  'postgres',
  'clickhouse'
])

/** Engines with a libpq-style SSL mode select (ClickHouse uses http/https, Mongo a TLS switch). */
export const SSL_MODE_ENGINES: ReadonlySet<DataEngine> = new Set(['mysql', 'mariadb', 'postgres'])

export interface WizardForm {
  engine: DataEngine
  // ---- network engines ----
  host: string
  port: string
  user: string
  database: string
  password: string
  passwordMode: SecretMode
  /** '' = no SSL section in the config (driver default: plain). */
  sslMode: DataSslMode | ''
  caPath: string
  certPath: string
  keyPath: string
  // ---- SQLite ----
  filePath: string
  readOnlyFile: boolean
  /**
   * `filePath` came from "New file…" (a save dialog: nothing exists there yet). The connection
   * test — or the save, when the test was skipped — creates the empty database; the saved
   * connection never carries the create flag, so a file that goes missing later is reported,
   * not silently re-created empty.
   */
  createFile: boolean
  // ---- MongoDB ----
  mongoSrv: boolean
  /** Comma-separated "host:port" seed list (one host, no port, for SRV). */
  mongoHosts: string
  authSource: string
  authMechanism: string
  replicaSet: string
  directConnection: boolean
  mongoTls: boolean
  tlsAllowInvalidCertificates: boolean
  readPreference: string
  // ---- ClickHouse ----
  clickhouseProtocol: 'http' | 'https'
  // ---- SSH tunnel ----
  sshEnabled: boolean
  sshHost: string
  sshPort: string
  sshUser: string
  sshAuthMethod: DataSshAuthMethod
  sshKeyPath: string
  sshPassword: string
  sshPasswordMode: SecretMode
  sshPassphrase: string
  sshPassphraseMode: SecretMode
  /** URL params and config fields the wizard does not edit, carried through unchanged. */
  options: Record<string, string>
  timezone: string
  /** Statement timeout in seconds ('' or 0 = none). */
  queryTimeoutSec: string
  // ---- details ----
  name: string
  /** The user typed a name: stop suggesting one from host/database. */
  nameEdited: boolean
  icon: DataProjectIcon | null
  iconColor: string | null
  environment: DataEnvironment
  environmentEdited: boolean
  safeMode: DataSafeMode
  safeModeEdited: boolean
  defaultLimit: string
  allowAiDataAccess: boolean
  pinned: boolean
}

export type WizardField =
  | 'host'
  | 'port'
  | 'user'
  | 'database'
  | 'password'
  | 'filePath'
  | 'mongoHosts'
  | 'caPath'
  | 'certPath'
  | 'keyPath'
  | 'sshHost'
  | 'sshPort'
  | 'sshUser'
  | 'sshKeyPath'
  | 'name'
  | 'defaultLimit'
  | 'queryTimeoutSec'
  | 'url'

export type FieldErrors = Partial<Record<WizardField, string>>

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

/** The safe mode new connections in `environment` start with, given the user's defaults. */
export function defaultSafeModeFor(
  environment: DataEnvironment,
  defaults: Pick<DataProjectDefaults, 'safeMode'>
): DataSafeMode {
  const envDefault = DATA_ENVIRONMENT_DEFAULTS[environment].safeMode
  // An explicit global default never makes production/staging less guarded than their own.
  return defaults.safeMode === 'auto' ? envDefault : stricterSafeMode(defaults.safeMode, envDefault)
}

const engineDefaultSsl = (engine: DataEngine): DataSslMode | '' =>
  SSL_MODE_ENGINES.has(engine) ? 'prefer' : ''

export function emptyForm(engine: DataEngine, defaults: DataProjectDefaults): WizardForm {
  const info = DATA_ENGINE_INFO[engine]
  const environment: DataEnvironment = engine === 'sqlite' ? 'local' : defaults.environment
  return {
    engine,
    host: engine === 'sqlite' ? '' : 'localhost',
    port: info.defaultPort ? String(info.defaultPort) : '',
    user: info.defaultUser,
    database: engine === 'sqlite' ? '' : info.defaultDatabase,
    password: '',
    passwordMode: 'replace',
    sslMode: engineDefaultSsl(engine),
    caPath: '',
    certPath: '',
    keyPath: '',
    filePath: '',
    readOnlyFile: false,
    createFile: false,
    mongoSrv: false,
    mongoHosts: engine === 'mongodb' ? `localhost:${info.defaultPort}` : '',
    authSource: '',
    authMechanism: '',
    replicaSet: '',
    directConnection: false,
    mongoTls: false,
    tlsAllowInvalidCertificates: false,
    readPreference: '',
    clickhouseProtocol: 'http',
    sshEnabled: false,
    sshHost: '',
    sshPort: '22',
    sshUser: '',
    sshAuthMethod: 'agent',
    sshKeyPath: '',
    sshPassword: '',
    sshPasswordMode: 'replace',
    sshPassphrase: '',
    sshPassphraseMode: 'replace',
    options: {},
    timezone: '',
    queryTimeoutSec:
      defaults.queryTimeoutMs > 0 ? String(Math.round(defaults.queryTimeoutMs / 1000)) : '',
    name: '',
    nameEdited: false,
    icon: null,
    iconColor: null,
    environment,
    environmentEdited: false,
    safeMode: defaultSafeModeFor(environment, defaults),
    safeModeEdited: false,
    defaultLimit: String(defaults.defaultLimit),
    allowAiDataAccess: defaults.allowAiDataAccess,
    pinned: false
  }
}

/** Copies a config into the connection fields of `form` (engine-specific parts included). */
function withConfig(
  form: WizardForm,
  engine: DataEngine,
  config: DataConnectionConfig
): WizardForm {
  const info = DATA_ENGINE_INFO[engine]
  const next: WizardForm = { ...form, engine }
  if (engine === 'sqlite') {
    next.filePath = config.filePath ?? ''
    next.readOnlyFile = config.readOnlyFile ?? false
    next.createFile = false
    next.host = ''
    next.port = ''
  } else {
    next.host = config.host ?? ''
    next.port = config.port ? String(config.port) : info.defaultPort ? String(info.defaultPort) : ''
    next.user = config.user ?? ''
    next.database = config.database ?? ''
  }
  next.sslMode = config.ssl?.mode ?? ''
  next.caPath = config.ssl?.caPath ?? ''
  next.certPath = config.ssl?.certPath ?? ''
  next.keyPath = config.ssl?.keyPath ?? ''
  if (engine === 'mongodb') {
    const mongo = config.mongo
    next.mongoSrv = mongo?.srv ?? false
    const hosts =
      mongo && mongo.hosts.length > 0
        ? mongo.hosts
        : config.host
          ? [next.mongoSrv ? config.host : `${config.host}:${config.port ?? info.defaultPort}`]
          : []
    next.mongoHosts = hosts.join(', ')
    next.authSource = mongo?.authSource ?? ''
    next.authMechanism = mongo?.authMechanism ?? ''
    next.replicaSet = mongo?.replicaSet ?? ''
    next.directConnection = mongo?.directConnection ?? false
    next.mongoTls = mongo?.tls ?? (config.ssl ? config.ssl.mode !== 'disable' : next.mongoSrv)
    next.tlsAllowInvalidCertificates = mongo?.tlsAllowInvalidCertificates ?? false
    next.readPreference = mongo?.readPreference ?? ''
  }
  if (engine === 'clickhouse') {
    next.clickhouseProtocol =
      config.clickhouseProtocol ?? (config.port === 8443 || config.port === 443 ? 'https' : 'http')
  }
  const ssh = config.ssh
  next.sshEnabled = ssh?.enabled ?? false
  next.sshHost = ssh?.host ?? ''
  next.sshPort = ssh?.port ? String(ssh.port) : '22'
  next.sshUser = ssh?.username ?? ''
  next.sshAuthMethod = ssh?.authMethod ?? 'agent'
  next.sshKeyPath = ssh?.privateKeyPath ?? ''
  next.options = withoutCreateOption(config.options)
  next.timezone = config.timezone ?? ''
  next.queryTimeoutSec =
    config.queryTimeoutMs && config.queryTimeoutMs > 0
      ? String(Math.round(config.queryTimeoutMs / 1000))
      : ''
  return next
}

/** Edit mode: the project's settings; secrets start as 'keep' when something is stored. */
export function formFromProject(project: DataProject, defaults: DataProjectDefaults): WizardForm {
  const base = withConfig(emptyForm(project.engine, defaults), project.engine, project.config)
  const hasSecret = project.secretState === 'stored' || project.secretState === 'session'
  const secretMode: SecretMode = hasSecret ? 'keep' : 'replace'
  return {
    ...base,
    passwordMode: secretMode,
    sshPasswordMode: secretMode,
    sshPassphraseMode: secretMode,
    name: project.name,
    nameEdited: true,
    icon: project.icon,
    iconColor: project.iconColor,
    environment: project.environment,
    environmentEdited: true,
    safeMode: project.safeMode,
    safeModeEdited: true,
    defaultLimit: String(project.defaultLimit),
    allowAiDataAccess: project.allowAiDataAccess,
    pinned: project.pinned
  }
}

/** Switching engine in create mode: engine defaults for the engine-specific fields. */
export function switchEngine(
  form: WizardForm,
  engine: DataEngine,
  defaults: DataProjectDefaults
): WizardForm {
  if (form.engine === engine) return form
  const fresh = emptyForm(engine, defaults)
  return {
    ...fresh,
    // Keep what the user already decided about the project itself.
    name: form.nameEdited ? form.name : '',
    nameEdited: form.nameEdited,
    icon: form.icon?.kind === 'engine' ? null : form.icon,
    iconColor: form.iconColor,
    pinned: form.pinned,
    allowAiDataAccess: form.allowAiDataAccess,
    defaultLimit: form.defaultLimit,
    password: form.password
  }
}

/**
 * Applies a parsed URL. The password (when the URL had one) becomes the typed password; in edit
 * mode that is a 'replace'. Details the user already set (name, environment) are kept.
 */
export function applyParsedUrl(
  form: WizardForm,
  parsed: DataParsedConnectionUrl,
  defaults: DataProjectDefaults
): WizardForm {
  let next = withConfig(
    { ...emptyForm(parsed.engine, defaults), ...pickDetails(form) },
    parsed.engine,
    parsed.config
  )
  // A URL without sslmode means libpq's default, "prefer" (try TLS, fall back to plain).
  if (!parsed.config.ssl && SSL_MODE_ENGINES.has(parsed.engine)) next.sslMode = 'prefer'
  if (parsed.secrets.password !== undefined) {
    next = { ...next, password: parsed.secrets.password, passwordMode: 'replace' }
  } else {
    next = { ...next, password: form.password, passwordMode: form.passwordMode }
  }
  // SSH secrets never come from a URL: keep the edit-mode choices.
  next = {
    ...next,
    sshPassword: form.sshPassword,
    sshPasswordMode: form.sshPasswordMode,
    sshPassphrase: form.sshPassphrase,
    sshPassphraseMode: form.sshPassphraseMode
  }
  // The URL carries no SSH section: keep the tunnel the user configured.
  if (form.sshEnabled && SSH_CAPABLE_ENGINES.has(parsed.engine)) {
    next = {
      ...next,
      sshEnabled: form.sshEnabled,
      sshHost: form.sshHost,
      sshPort: form.sshPort,
      sshUser: form.sshUser,
      sshAuthMethod: form.sshAuthMethod,
      sshKeyPath: form.sshKeyPath
    }
  }
  if (!form.nameEdited) next.name = parsed.suggestedName
  return autoEnvironment(next, defaults)
}

function pickDetails(form: WizardForm): Partial<WizardForm> {
  return {
    name: form.name,
    nameEdited: form.nameEdited,
    icon: form.icon,
    iconColor: form.iconColor,
    environment: form.environment,
    environmentEdited: form.environmentEdited,
    safeMode: form.safeMode,
    safeModeEdited: form.safeModeEdited,
    defaultLimit: form.defaultLimit,
    allowAiDataAccess: form.allowAiDataAccess,
    pinned: form.pinned,
    passwordMode: form.passwordMode,
    sshPasswordMode: form.sshPasswordMode,
    sshPassphraseMode: form.sshPassphraseMode
  }
}

/**
 * While the user has not picked an environment: SQLite and localhost are 'local', anything else
 * the default environment; the safe mode follows unless the user picked one.
 */
export function autoEnvironment(form: WizardForm, defaults: DataProjectDefaults): WizardForm {
  if (form.environmentEdited) return form
  const firstHost = form.engine === 'mongodb' ? splitHostList(form.mongoHosts)[0]?.host : form.host
  const environment: DataEnvironment =
    form.engine === 'sqlite' || (firstHost && isLocalHost(firstHost))
      ? 'local'
      : defaults.environment
  if (environment === form.environment) return form
  return {
    ...form,
    environment,
    safeMode: form.safeModeEdited ? form.safeMode : defaultSafeModeFor(environment, defaults)
  }
}

/** Picking an environment in the details step: its safe mode follows unless picked by hand. */
export function chooseEnvironment(
  form: WizardForm,
  environment: DataEnvironment,
  defaults: DataProjectDefaults
): WizardForm {
  return {
    ...form,
    environment,
    environmentEdited: true,
    safeMode: form.safeModeEdited
      ? // A hand-picked mode still never stays below the new environment's floor.
        stricterSafeMode(form.safeMode, DATA_ENVIRONMENT_DEFAULTS[environment].safeMode)
      : defaultSafeModeFor(environment, defaults)
  }
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

export interface HostEntry {
  host: string
  port?: number
  raw: string
}

/** "a:1, b:2" → entries; IPv6 in brackets ("[::1]:27017"). Invalid ports are kept as NaN. */
export function splitHostList(text: string): HostEntry[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((raw) => {
      const match = /^(\[[^\]]+\]|[^:]+)(?::(.*))?$/.exec(raw)
      if (!match) return { host: raw, raw }
      const port = match[2] === undefined ? undefined : Number(match[2])
      return { host: match[1], port, raw }
    })
}

const toInt = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isInteger(n) ? n : undefined
}

const nonEmpty = (text: string): string | undefined => {
  const trimmed = text.trim()
  return trimmed ? trimmed : undefined
}

/** SQLite's "create the file when it is missing" switch (drivers/sqlite.ts, first open only). */
const CREATE_OPTION = 'create'

/** Config options without the create switch: it is never part of a saved connection. */
function withoutCreateOption(options: Record<string, string> | undefined): Record<string, string> {
  const rest = { ...options }
  delete rest[CREATE_OPTION]
  return rest
}

/** The SQLite file "New file…" picked and the wizard still has to create, else null. */
export function fileToCreate(form: WizardForm): string | null {
  const path = form.filePath.trim()
  return form.engine === 'sqlite' && form.createFile && !form.readOnlyFile && path ? path : null
}

/**
 * The config "Test connection" sends: the saved config, plus the create switch for a file picked
 * with "New file…", so the test creates the empty database (and later connects find it).
 */
export function testConfig(form: WizardForm): DataConnectionConfig {
  const config = formToConfig(form)
  if (fileToCreate(form)) config.options = { ...config.options, [CREATE_OPTION]: 'true' }
  return config
}

/** The non-secret connection config the form describes (what is saved). */
export function formToConfig(form: WizardForm): DataConnectionConfig {
  const engine = form.engine
  const config: DataConnectionConfig = {}
  const options = withoutCreateOption(form.options)
  if (Object.keys(options).length > 0) config.options = options
  const timezone = nonEmpty(form.timezone)
  if (timezone) config.timezone = timezone
  const timeoutSec = toInt(form.queryTimeoutSec)
  if (timeoutSec && timeoutSec > 0) config.queryTimeoutMs = timeoutSec * 1000

  if (engine === 'sqlite') {
    config.filePath = form.filePath.trim()
    config.database = 'main'
    if (form.readOnlyFile) config.readOnlyFile = true
    return config
  }

  const user = nonEmpty(form.user)
  if (user) config.user = user
  const database = nonEmpty(form.database)
  if (database) config.database = database

  if (engine === 'mongodb') {
    const entries = splitHostList(form.mongoHosts)
    const hosts = form.mongoSrv
      ? entries.slice(0, 1).map((e) => e.host)
      : entries.map((e) => `${e.host}:${e.port ?? DATA_ENGINE_INFO.mongodb.defaultPort}`)
    config.host = entries[0]?.host ?? ''
    if (!form.mongoSrv && entries[0])
      config.port = entries[0].port ?? DATA_ENGINE_INFO.mongodb.defaultPort ?? undefined
    config.mongo = {
      srv: form.mongoSrv,
      hosts,
      ...(nonEmpty(form.authSource) ? { authSource: form.authSource.trim() } : {}),
      ...(nonEmpty(form.authMechanism) ? { authMechanism: form.authMechanism.trim() } : {}),
      ...(nonEmpty(form.replicaSet) ? { replicaSet: form.replicaSet.trim() } : {}),
      ...(form.directConnection && !form.mongoSrv ? { directConnection: true } : {}),
      tls: form.mongoTls || form.mongoSrv,
      ...(form.tlsAllowInvalidCertificates ? { tlsAllowInvalidCertificates: true } : {}),
      ...(nonEmpty(form.readPreference) ? { readPreference: form.readPreference.trim() } : {})
    }
    const caPath = nonEmpty(form.caPath)
    const certPath = nonEmpty(form.certPath)
    if (caPath || certPath) {
      config.ssl = {
        mode: config.mongo.tls ? 'verify-full' : 'disable',
        ...(caPath ? { caPath } : {}),
        ...(certPath ? { certPath } : {})
      }
    }
    return config
  }

  config.host = form.host.trim()
  const port = toInt(form.port)
  if (port) config.port = port

  if (engine === 'clickhouse') {
    config.clickhouseProtocol = form.clickhouseProtocol
    if (form.clickhouseProtocol === 'https') {
      config.ssl = sslSection(form.sslMode || 'verify-full', form)
    }
  } else if (form.sslMode) {
    config.ssl = sslSection(form.sslMode, form)
  }

  if (form.sshEnabled && SSH_CAPABLE_ENGINES.has(engine)) {
    config.ssh = {
      enabled: true,
      host: form.sshHost.trim(),
      port: toInt(form.sshPort) ?? 22,
      username: form.sshUser.trim(),
      authMethod: form.sshAuthMethod,
      ...(form.sshAuthMethod === 'privateKey' && nonEmpty(form.sshKeyPath)
        ? { privateKeyPath: form.sshKeyPath.trim() }
        : {})
    }
  }
  return config
}

function sslSection(mode: DataSslMode, form: WizardForm): NonNullable<DataConnectionConfig['ssl']> {
  if (mode === 'disable') return { mode }
  return {
    mode,
    ...(nonEmpty(form.caPath) ? { caPath: form.caPath.trim() } : {}),
    ...(nonEmpty(form.certPath) ? { certPath: form.certPath.trim() } : {}),
    ...(nonEmpty(form.keyPath) ? { keyPath: form.keyPath.trim() } : {})
  }
}

const usesSshPassword = (form: WizardForm): boolean =>
  form.sshEnabled && SSH_CAPABLE_ENGINES.has(form.engine) && form.sshAuthMethod === 'password'
const usesSshPassphrase = (form: WizardForm): boolean =>
  form.sshEnabled && SSH_CAPABLE_ENGINES.has(form.engine) && form.sshAuthMethod === 'privateKey'

/** Create mode: every typed secret (empty = none). */
export function formSecrets(form: WizardForm): DataSecrets {
  const secrets: DataSecrets = {}
  if (form.engine !== 'sqlite' && form.passwordMode === 'replace' && form.password !== '') {
    secrets.password = form.password
  }
  if (usesSshPassword(form) && form.sshPasswordMode === 'replace' && form.sshPassword !== '') {
    secrets.sshPassword = form.sshPassword
  }
  if (
    usesSshPassphrase(form) &&
    form.sshPassphraseMode === 'replace' &&
    form.sshPassphrase !== ''
  ) {
    secrets.sshPassphrase = form.sshPassphrase
  }
  return secrets
}

/** Edit mode: replace / clear / keep per secret (undefined = keep). */
export function formSecretsPatch(form: WizardForm): DataSecretsPatch | undefined {
  const patch: DataSecretsPatch = {}
  const apply = (key: keyof DataSecretsPatch, mode: SecretMode, value: string): void => {
    if (mode === 'clear') patch[key] = null
    // An empty 'replace' on a project without a stored secret simply sets none.
    else if (mode === 'replace' && value !== '') patch[key] = value
  }
  if (form.engine !== 'sqlite') apply('password', form.passwordMode, form.password)
  if (usesSshPassword(form)) apply('sshPassword', form.sshPasswordMode, form.sshPassword)
  if (usesSshPassphrase(form)) apply('sshPassphrase', form.sshPassphraseMode, form.sshPassphrase)
  return Object.keys(patch).length > 0 ? patch : undefined
}

/**
 * Secrets for "Test connection": what was typed. In edit mode the server fills anything not
 * typed from the stored secrets (`dataProjectId` is sent along). A cleared secret is tested as
 * an empty one so the test shows what saving would do.
 */
export function testSecrets(form: WizardForm): DataSecrets {
  const secrets = formSecrets(form)
  if (form.engine !== 'sqlite' && form.passwordMode === 'clear') secrets.password = ''
  if (usesSshPassword(form) && form.sshPasswordMode === 'clear') secrets.sshPassword = ''
  if (usesSshPassphrase(form) && form.sshPassphraseMode === 'clear') secrets.sshPassphrase = ''
  return secrets
}

/** "shop @ db.example.com", "shop" (SQLite file), engine label as the last resort. */
export function suggestName(form: WizardForm): string {
  if (form.engine === 'sqlite') {
    const base = fileBaseName(form.filePath.trim()).replace(/\.(sqlite3?|db3?|s3db|sl3)$/i, '')
    return base || DATA_ENGINE_INFO.sqlite.label
  }
  const host =
    form.engine === 'mongodb' ? (splitHostList(form.mongoHosts)[0]?.host ?? '') : form.host.trim()
  const database = form.database.trim()
  if (database && host) return `${database} @ ${host}`
  return database || host || DATA_ENGINE_INFO[form.engine].label
}

/** The name the project will get: what the user typed, else the suggestion. */
export const effectiveName = (form: WizardForm): string =>
  (form.nameEdited ? form.name : form.name || suggestName(form)).trim()

const limitOf = (form: WizardForm): number => toInt(form.defaultLimit) ?? 0

export function formToCreateInput(form: WizardForm): DataProjectCreateInput {
  const secrets = formSecrets(form)
  return {
    name: effectiveName(form),
    engine: form.engine,
    config: formToConfig(form),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    icon: form.icon,
    iconColor: form.iconColor,
    environment: form.environment,
    safeMode: form.safeMode,
    defaultLimit: limitOf(form),
    allowAiDataAccess: form.allowAiDataAccess,
    pinned: form.pinned
  }
}

/** JSON with sorted keys and no undefined values: key order never counts as a change. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, inner]) => inner !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, normalize(inner)])
      )
    }
    return v
  }
  return JSON.stringify(normalize(value))
}

/**
 * Only what changed, so an untouched connection keeps its open connections (a config or secret
 * change makes the server close them). The stored config is compared after the same form round
 * trip, so defaults the form fills in (port, SSL mode) never count as an edit.
 */
export function formToUpdatePatch(form: WizardForm, project: DataProject): DataProjectUpdateInput {
  const patch: DataProjectUpdateInput = {}
  const name = effectiveName(form)
  if (name !== project.name) patch.name = name
  const config = formToConfig(form)
  const unchanged = formToConfig(withConfig(form, project.engine, project.config))
  if (canonicalJson(config) !== canonicalJson(unchanged)) patch.config = config
  const secrets = formSecretsPatch(form)
  if (secrets) patch.secrets = secrets
  if (JSON.stringify(form.icon) !== JSON.stringify(project.icon)) patch.icon = form.icon
  if (form.iconColor !== project.iconColor) patch.iconColor = form.iconColor
  if (form.environment !== project.environment) patch.environment = form.environment
  if (form.safeMode !== project.safeMode) patch.safeMode = form.safeMode
  const limit = limitOf(form)
  if (limit !== project.defaultLimit) patch.defaultLimit = limit
  if (form.allowAiDataAccess !== project.allowAiDataAccess) {
    patch.allowAiDataAccess = form.allowAiDataAccess
  }
  if (form.pinned !== project.pinned) patch.pinned = form.pinned
  return patch
}

/** The URL tab's text: the form as a connection URL, never with the password. */
export function urlFromForm(form: WizardForm): string {
  try {
    return buildConnectionUrl(form.engine, formToConfig(form))
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const HOST_PATTERN = /^(\[[0-9a-fA-F:.]+\]|[^\s/:?#@[\]]+|[0-9a-fA-F:]+)$/

const validPort = (text: string): boolean => {
  const n = toInt(text)
  return n !== undefined && n >= 1 && n <= 65_535
}

const absoluteOrHome = (path: string): boolean =>
  path.startsWith('/') || path.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(path)

export function validateConnection(form: WizardForm): FieldErrors {
  const errors: FieldErrors = {}
  if (form.engine === 'sqlite') {
    const path = form.filePath.trim()
    if (!path) errors.filePath = 'Choose the SQLite database file'
    else if (!absoluteOrHome(path))
      errors.filePath = 'Use an absolute path (or one starting with ~/)'
    return errors
  }

  if (form.engine === 'mongodb') {
    const entries = splitHostList(form.mongoHosts)
    if (entries.length === 0) errors.mongoHosts = 'At least one host is required'
    else if (form.mongoSrv && entries.length > 1) {
      errors.mongoHosts = 'An SRV connection takes exactly one host name'
    } else if (form.mongoSrv && entries[0].port !== undefined) {
      errors.mongoHosts = 'An SRV host name has no port'
    } else {
      const bad = entries.find(
        (e) =>
          !HOST_PATTERN.test(e.host) ||
          (e.port !== undefined && !(Number.isInteger(e.port) && e.port >= 1 && e.port <= 65_535))
      )
      if (bad) errors.mongoHosts = `"${bad.raw}" is not a valid host[:port]`
    }
  } else {
    const host = form.host.trim()
    if (!host) errors.host = 'Host is required'
    else if (!HOST_PATTERN.test(host)) errors.host = 'Enter a host name or IP address only'
    if (form.port.trim() && !validPort(form.port)) errors.port = 'Port must be 1–65535'
  }

  for (const key of ['caPath', 'certPath', 'keyPath'] as const) {
    const value = form[key].trim()
    if (value && !absoluteOrHome(value))
      errors[key] = 'Use an absolute path (or one starting with ~/)'
  }

  if (form.sshEnabled && SSH_CAPABLE_ENGINES.has(form.engine)) {
    const sshHost = form.sshHost.trim()
    if (!sshHost) errors.sshHost = 'SSH host is required'
    else if (!HOST_PATTERN.test(sshHost)) errors.sshHost = 'Enter a host name or IP address only'
    if (!validPort(form.sshPort)) errors.sshPort = 'Port must be 1–65535'
    if (!form.sshUser.trim()) errors.sshUser = 'SSH user is required'
    if (form.sshAuthMethod === 'privateKey') {
      const keyPath = form.sshKeyPath.trim()
      if (!keyPath) errors.sshKeyPath = 'Choose the private key file'
      else if (!absoluteOrHome(keyPath))
        errors.sshKeyPath = 'Use an absolute path (or one starting with ~/)'
    }
  }
  return errors
}

export function validateDetails(form: WizardForm): FieldErrors {
  const errors: FieldErrors = {}
  const name = effectiveName(form)
  if (!name) errors.name = 'Name is required'
  else if (name.length > 200) errors.name = 'Keep the name under 200 characters'
  const limit = toInt(form.defaultLimit)
  if (
    form.defaultLimit.trim() === '' ||
    limit === undefined ||
    limit < 0 ||
    limit > DATA_HARD_ROW_CAP
  ) {
    errors.defaultLimit = `Enter a number from 0 (no limit) to ${DATA_HARD_ROW_CAP.toLocaleString('en-US')}`
  }
  if (form.queryTimeoutSec.trim()) {
    const seconds = toInt(form.queryTimeoutSec)
    if (seconds === undefined || seconds < 0 || seconds > 86_400) {
      errors.queryTimeoutSec = 'Enter seconds from 0 (none) to 86400'
    }
  }
  return errors
}

export const hasErrors = (errors: FieldErrors): boolean => Object.keys(errors).length > 0
