import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'

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
  readonly staticDir?: string
  readonly env?: NodeJS.ProcessEnv
}

export const createDesktopBootstrapToken = (): string => randomBytes(24).toString('hex')

// Optional override (used by `dev:web`) to pin the desktop backend to a known free
// port so a separate Vite dev server can target it. Returns undefined when unset or
// invalid, leaving the default port-scan behaviour in place.
export const parseDesktopBackendPortEnv = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined
}

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

// The web build (`vite.web.config.ts`) outputs to `out/renderer-web`, a sibling of
// `out/main` (where the server entry `server.js` lives). Derive from the resolved
// server entry path rather than this module's __dirname, since backend-config may be
// bundled into `out/main/chunks/*` — making a __dirname-relative hop point at the
// wrong directory. The same relative layout holds inside the packaged asar.
export const resolveDesktopWebStaticDir = (serverEntryPath: string): string => {
  if (process.env.HIVE_SERVER_STATIC_DIR) {
    return resolve(process.env.HIVE_SERVER_STATIC_DIR)
  }

  return resolve(dirname(serverEntryPath), '..', 'renderer-web')
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
  const staticDir = input.staticDir ?? resolveDesktopWebStaticDir(entryPath)
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
      HIVE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
      // Also serve the built web UI from the same loopback origin, with auth
      // disabled so a plain browser tab can connect without a bootstrap token.
      HIVE_SERVER_STATIC_DIR: staticDir,
      HIVE_SERVER_REQUIRE_AUTH: 'false'
    }
  }
}
