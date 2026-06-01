import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Effect } from 'effect'

export type ServerMode = 'desktop' | 'browser'
export type ServerLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ServerDerivedPaths {
  readonly stateDir: string
  readonly dbPath: string
  readonly attachmentsDir: string
  readonly logsDir: string
}

export interface ServerConfig extends ServerDerivedPaths {
  readonly mode: ServerMode
  readonly host: string
  readonly port: number
  readonly baseDir: string
  readonly devUrl: string | null
  readonly staticDir: string | null
  readonly desktopBootstrapToken: string | null
  readonly logLevel: ServerLogLevel
}

export interface ServerConfigInput {
  readonly mode?: ServerMode
  readonly host?: string
  readonly port?: number
  readonly baseDir?: string
  readonly devUrl?: string | null
  readonly staticDir?: string | null
  readonly desktopBootstrapToken?: string | null
  readonly logLevel?: ServerLogLevel
}

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3773

export const deriveServerPaths = (baseDir: string): ServerDerivedPaths => {
  const stateDir = join(baseDir, 'userdata')
  return {
    stateDir,
    dbPath: join(stateDir, 'state.sqlite'),
    attachmentsDir: join(stateDir, 'attachments'),
    logsDir: join(stateDir, 'logs')
  }
}

const parsePort = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback
}

const parseMode = (value: string | undefined): ServerMode =>
  value === 'browser' || value === 'desktop' ? value : 'desktop'

const parseLogLevel = (value: string | undefined): ServerLogLevel =>
  value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info'

export const resolveServerConfig = (
  input: ServerConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): Effect.Effect<ServerConfig> =>
  Effect.sync(() => {
    const baseDir = resolve(input.baseDir ?? env.HIVE_SERVER_BASE_DIR ?? join(homedir(), '.hive'))
    return {
      mode: input.mode ?? parseMode(env.HIVE_SERVER_MODE),
      host: input.host ?? env.HIVE_SERVER_HOST ?? DEFAULT_HOST,
      port: input.port ?? parsePort(env.HIVE_SERVER_PORT, DEFAULT_PORT),
      baseDir,
      devUrl: input.devUrl ?? env.HIVE_SERVER_DEV_URL ?? null,
      staticDir: input.staticDir ?? env.HIVE_SERVER_STATIC_DIR ?? null,
      desktopBootstrapToken:
        input.desktopBootstrapToken ?? env.HIVE_DESKTOP_BOOTSTRAP_TOKEN ?? null,
      logLevel: input.logLevel ?? parseLogLevel(env.HIVE_SERVER_LOG_LEVEL),
      ...deriveServerPaths(baseDir)
    }
  })

