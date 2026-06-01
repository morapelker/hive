import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

export const DEFAULT_DESKTOP_BACKEND_HOST = '127.0.0.1'
export const DEFAULT_DESKTOP_BACKEND_PORT = 3773
export const DEFAULT_DESKTOP_BACKEND_MAX_PORT = 3873

export interface DesktopBackendEndpoint {
  readonly host: string
  readonly port: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
}

export interface DesktopBackendSpawnConfig extends DesktopBackendEndpoint {
  readonly executablePath: string
  readonly entryPath: string
  readonly cwd: string
  readonly baseDir: string
  readonly bootstrapToken: string
  readonly env: NodeJS.ProcessEnv
}

export interface DesktopBackendConfigInput {
  readonly executablePath?: string
  readonly entryPath?: string
  readonly cwd?: string
  readonly baseDir: string
  readonly host?: string
  readonly port?: number
  readonly maxPort?: number
  readonly bootstrapToken?: string
  readonly env?: NodeJS.ProcessEnv
}

export const createDesktopBootstrapToken = (): string => randomBytes(24).toString('hex')

export const isPortAvailable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolvePortAvailable) => {
    const server = createServer()

    server.once('error', () => {
      resolvePortAvailable(false)
    })

    server.once('listening', () => {
      server.close(() => resolvePortAvailable(true))
    })

    server.listen(port, host)
  })

export const selectDesktopBackendPort = async (
  host = DEFAULT_DESKTOP_BACKEND_HOST,
  startPort = DEFAULT_DESKTOP_BACKEND_PORT,
  maxPort = DEFAULT_DESKTOP_BACKEND_MAX_PORT
): Promise<number> => {
  for (let port = startPort; port <= maxPort; port += 1) {
    if (await isPortAvailable(host, port)) {
      return port
    }
  }

  throw new Error(`No free backend port found on ${host} from ${startPort} to ${maxPort}`)
}

export const resolveDesktopBackendEntryPath = (dirname: string): string => {
  if (process.env.HIVE_SERVER_ENTRY_PATH) {
    return resolve(process.env.HIVE_SERVER_ENTRY_PATH)
  }

  const siblingServerPath = join(dirname, 'server.js')
  if (existsSync(siblingServerPath)) return siblingServerPath

  return resolve(dirname, '..', 'server.js')
}

export const makeDesktopBackendSpawnConfig = async (
  input: DesktopBackendConfigInput
): Promise<DesktopBackendSpawnConfig> => {
  const host = input.host ?? DEFAULT_DESKTOP_BACKEND_HOST
  const port = await selectDesktopBackendPort(
    host,
    input.port ?? DEFAULT_DESKTOP_BACKEND_PORT,
    input.maxPort ?? DEFAULT_DESKTOP_BACKEND_MAX_PORT
  )
  const httpBaseUrl = `http://${host}:${port}`
  const wsBaseUrl = `ws://${host}:${port}/ws`
  const bootstrapToken = input.bootstrapToken ?? createDesktopBootstrapToken()
  const entryPath = input.entryPath ?? resolveDesktopBackendEntryPath(__dirname)
  const cwd = input.cwd ?? process.cwd()

  return {
    host,
    port,
    httpBaseUrl,
    wsBaseUrl,
    executablePath: input.executablePath ?? process.execPath,
    entryPath,
    cwd,
    baseDir: input.baseDir,
    bootstrapToken,
    env: {
      ...process.env,
      ...input.env,
      ELECTRON_RUN_AS_NODE: '1',
      HIVE_SERVER_MODE: 'desktop',
      HIVE_SERVER_HOST: host,
      HIVE_SERVER_PORT: String(port),
      HIVE_SERVER_BASE_DIR: input.baseDir,
      HIVE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken
    }
  }
}
