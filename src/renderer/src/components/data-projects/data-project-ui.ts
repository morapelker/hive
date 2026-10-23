// Pure helpers shared by the data-project shell (sidebar row, pinned card, header label,
// toolbar, view states, wizard): how a connection is described in one line, what colour its
// environment is, which safe modes count as "less strict", which credentials a project can ask
// for, and how a connection error is explained. No React, no stores, so they are unit-testable
// and safe to import anywhere.

import {
  DATA_ENGINE_INFO,
  DATA_ENVIRONMENT_DEFAULTS,
  DATA_ERROR_CODES,
  type DataConnectionState,
  type DataEngine,
  type DataEnvironment,
  type DataProject,
  type DataSafeMode
} from '@shared/data-projects/types'

// ---------------------------------------------------------------------------------------------
// Safe modes
// ---------------------------------------------------------------------------------------------

export interface SafeModeInfo {
  label: string
  /** One line for menus. */
  short: string
  /** The wizard's radio explanation. */
  description: string
  /** Text colour class for the toolbar trigger and menus. */
  tone: string
  /** Dot colour. */
  dot: string
}

/** Display order: least to most strict. */
export const SAFE_MODE_ORDER: readonly DataSafeMode[] = ['off', 'half-safe', 'safe', 'read-only']

export const SAFE_MODE_INFO: Readonly<Record<DataSafeMode, SafeModeInfo>> = {
  off: {
    label: 'Off',
    short: 'Everything runs without asking',
    description:
      'Every statement runs without confirmation. Dangerous statements (DROP, TRUNCATE, DELETE without WHERE) still ask.',
    tone: 'text-muted-foreground',
    dot: 'bg-zinc-400'
  },
  'half-safe': {
    label: 'Half-safe',
    short: 'Reads run, writes ask first',
    description:
      'Reads run at once inside a read-only sandbox; anything that changes data or schema asks for confirmation first.',
    tone: 'text-sky-500',
    dot: 'bg-sky-500'
  },
  safe: {
    label: 'Safe',
    short: 'Every statement asks first',
    description: 'Every statement, reads included, is shown for confirmation before it runs.',
    tone: 'text-amber-500',
    dot: 'bg-amber-500'
  },
  'read-only': {
    label: 'Read-only',
    short: 'Writes are refused',
    description:
      'Reads run inside a read-only sandbox; writes, schema changes and admin commands are refused outright.',
    tone: 'text-emerald-500',
    dot: 'bg-emerald-500'
  }
}

/** Higher = stricter. read-only refuses writes, so it outranks safe (which can still write). */
export const safeModeRank = (mode: DataSafeMode): number => SAFE_MODE_ORDER.indexOf(mode)

/** True when moving from `from` to `to` lets more statements run without a confirmation. */
export const isLessStrictSafeMode = (from: DataSafeMode, to: DataSafeMode): boolean =>
  safeModeRank(to) < safeModeRank(from)

/** The stricter of two modes (used to keep production at least as strict as its default). */
export const stricterSafeMode = (a: DataSafeMode, b: DataSafeMode): DataSafeMode =>
  safeModeRank(a) >= safeModeRank(b) ? a : b

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

export const ENVIRONMENT_ORDER: readonly DataEnvironment[] = [
  'local',
  'development',
  'staging',
  'production'
]

/** The project's environment colour (override, else the environment default). */
export const environmentColor = (project: Pick<DataProject, 'environment' | 'color'>): string =>
  project.color ?? DATA_ENVIRONMENT_DEFAULTS[project.environment].color

export const environmentLabel = (environment: DataEnvironment): string =>
  DATA_ENVIRONMENT_DEFAULTS[environment].label

/** Staging and production get a dot on the icon, a coloured bar and a badge in the view. */
export const isFlaggedEnvironment = (environment: DataEnvironment): boolean =>
  environment === 'staging' || environment === 'production'

// ---------------------------------------------------------------------------------------------
// Describing a connection
// ---------------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'])

export const isLocalHost = (host: string | undefined | null): boolean =>
  LOCAL_HOSTS.has((host ?? '').trim().toLowerCase())

/** Last path segment of a file path ("/a/b/shop.sqlite" → "shop.sqlite"). */
export const fileBaseName = (path: string): string => {
  const trimmed = path.replace(/[/\\]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** "host:port" (port omitted when it is the engine default) or the Mongo host list. */
export function describeDataProjectHost(project: Pick<DataProject, 'engine' | 'config'>): string {
  const { engine, config } = project
  if (engine === 'sqlite') return config.filePath ? fileBaseName(config.filePath) : 'SQLite file'
  if (engine === 'mongodb' && config.mongo && config.mongo.hosts.length > 0) {
    const [first, ...rest] = config.mongo.hosts
    return rest.length > 0 ? `${first} +${rest.length}` : first
  }
  const host = config.host?.trim() || 'localhost'
  const defaultPort = DATA_ENGINE_INFO[engine].defaultPort
  return config.port && config.port !== defaultPort ? `${host}:${config.port}` : host
}

/**
 * One muted line under the name: "db.example.com:5433 / shop" or the SQLite file name. Never
 * contains the user or credentials.
 */
export function describeDataProjectTarget(project: Pick<DataProject, 'engine' | 'config'>): string {
  const host = describeDataProjectHost(project)
  if (project.engine === 'sqlite') return host
  const database = project.config.database?.trim()
  return database ? `${host} / ${database}` : host
}

/** A full, non-secret tooltip: engine, user@host:port/db, file path, SSH hop. */
export function describeDataProjectTooltip(project: DataProject): string {
  const info = DATA_ENGINE_INFO[project.engine]
  const lines = [`${project.name} · ${info.label}`]
  if (project.engine === 'sqlite') {
    if (project.config.filePath) lines.push(project.config.filePath)
  } else {
    const user = project.config.user?.trim()
    lines.push(`${user ? `${user}@` : ''}${describeDataProjectTarget(project)}`)
  }
  if (project.config.ssh?.enabled && project.config.ssh.host) {
    lines.push(`via SSH ${project.config.ssh.username || ''}@${project.config.ssh.host}`)
  }
  lines.push(`${environmentLabel(project.environment)} · ${SAFE_MODE_INFO[project.safeMode].label}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

export type CredentialField = 'password' | 'sshPassword' | 'sshPassphrase'

/** Which secrets the credentials prompt asks for (SQLite has none). */
export function credentialFieldsFor(
  project: Pick<DataProject, 'engine' | 'config'>
): CredentialField[] {
  const fields: CredentialField[] = []
  if (project.engine !== 'sqlite') fields.push('password')
  const ssh = project.config.ssh
  if (ssh?.enabled && project.engine !== 'sqlite' && project.engine !== 'mongodb') {
    if (ssh.authMethod === 'password') fields.push('sshPassword')
    if (ssh.authMethod === 'privateKey') fields.push('sshPassphrase')
  }
  return fields
}

// ---------------------------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------------------------

export const CONNECTION_STATE_LABEL: Readonly<Record<DataConnectionState, string>> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Not connected',
  error: 'Connection failed'
}

export const CONNECTION_STATE_DOT: Readonly<Record<DataConnectionState, string>> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-zinc-400/70',
  error: 'bg-red-500'
}

/** RPC errors carry their DATA_* code as `Error.name` (ws-transport). */
export function dataErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.startsWith('DATA_')) return name
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('DATA_')) return code
  }
  return null
}

export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

export const isCredentialsRequiredError = (error: unknown): boolean =>
  dataErrorCode(error) === DATA_ERROR_CODES.credentialsRequired

/**
 * A one-line hint for a failed connection, classified from the (already redacted) message:
 * auth, DNS, refused, timeout, TLS, SSH, missing database or file.
 */
export function connectionErrorHint(
  message: string | undefined | null,
  engine?: DataEngine
): string | null {
  const text = (message ?? '').toLowerCase()
  if (!text) return null
  if (/ssh host key/.test(text)) {
    return "The SSH server's host key is not the one saved for it. Check with the server's administrator before trusting a new key."
  }
  if (/ssh|handshake failed|all configured authentication methods failed|known_hosts/.test(text)) {
    return 'The SSH tunnel could not be opened. Check the SSH host, user and key or password.'
  }
  if (
    /access denied|authentication failed|password authentication|auth failed|bad auth|not authorized|invalid credentials|unauthorized|wrong password|code: 516|authentication_failed/.test(
      text
    )
  ) {
    return 'The server rejected the user name or password.'
  }
  if (/enotfound|getaddrinfo|name or service not known|nodename nor servname/.test(text)) {
    return 'The host name could not be resolved. Check the host for typos or VPN/DNS access.'
  }
  if (/econnrefused|connection refused/.test(text)) {
    return 'Nothing is listening on that host and port. Is the server running, and is the port right?'
  }
  if (/etimedout|timed out|timeout|ehostunreach|enetunreach/.test(text)) {
    return 'The server did not answer in time. A firewall, VPN or wrong port is the usual cause.'
  }
  if (/ssl|tls|certificate|self[- ]signed|cert_|unable to verify/.test(text)) {
    return 'The TLS handshake failed. Try another SSL mode or provide the CA certificate.'
  }
  if (/does not exist|unknown database|database .* not found/.test(text)) {
    return 'The database does not exist on this server. Leave it empty or pick another one.'
  }
  if (engine === 'sqlite' && /enoent|no such file|unable to open|cantopen/.test(text)) {
    return 'The database file could not be opened. Check that it exists and is readable.'
  }
  if (/sqlite_busy|database is locked/.test(text)) {
    return 'The file is locked by another process.'
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Tint palette (icon tile colours offered by the icon picker)
// ---------------------------------------------------------------------------------------------

export const ICON_TINTS: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#64748b'
]

/** Relative luminance (sRGB) of a #rgb/#rrggbb colour, 0..1; 0 for anything unparsable. */
export function hexLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim())
  if (!match) return 0
  let value = match[1]
  if (value.length === 3) value = value.replace(/./g, (c) => c + c)
  const channel = (offset: number): number => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** Glyph colour that reads on a tile of `background` (black on yellow, white on blue). */
export const glyphColorOn = (background: string): string =>
  hexLuminance(background) > 0.45 ? '#111111' : '#ffffff'
