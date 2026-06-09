import type { DesktopBridge, LocalEnvironmentBootstrap } from './desktop-bridge'

export type BackendTargetSource = 'desktop' | 'vite' | 'browser'

export interface BackendTarget {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly bootstrapToken: string | null
  readonly source: BackendTargetSource
}

export interface ResolveBackendTargetOptions {
  readonly desktopBridge?: Pick<DesktopBridge, 'getLocalEnvironmentBootstrap'> | null
  readonly env?: Record<string, string | undefined>
  readonly location?: Pick<Location, 'origin' | 'protocol' | 'host'>
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const normalizeHttpBaseUrl = (value: string): string => trimTrailingSlash(value.trim())

const normalizeWsBaseUrl = (value: string): string => {
  const trimmed = trimTrailingSlash(value.trim())
  return trimmed.endsWith('/ws') ? trimmed : `${trimmed}/ws`
}

const wsFromHttp = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return trimTrailingSlash(url.toString())
}

const fromBootstrap = (bootstrap: LocalEnvironmentBootstrap): BackendTarget => ({
  httpBaseUrl: normalizeHttpBaseUrl(bootstrap.httpBaseUrl),
  wsBaseUrl: normalizeWsBaseUrl(bootstrap.wsBaseUrl),
  bootstrapToken: bootstrap.bootstrapToken,
  source: 'desktop'
})

const getDefaultEnv = (): Record<string, string | undefined> => {
  return (
    (import.meta.env as Record<string, string | undefined> | undefined) ?? {}
  )
}

const getDefaultLocation = (): Pick<Location, 'origin' | 'protocol' | 'host'> | undefined =>
  typeof window === 'undefined' ? undefined : window.location

const getDefaultDesktopBridge = ():
  | Pick<DesktopBridge, 'getLocalEnvironmentBootstrap'>
  | null => (typeof window === 'undefined' ? null : (window.desktopBridge ?? null))

export const resolveBackendTarget = async (
  options: ResolveBackendTargetOptions = {}
): Promise<BackendTarget> => {
  const desktopBridge =
    options.desktopBridge === undefined ? getDefaultDesktopBridge() : options.desktopBridge
  const desktopBootstrap = await desktopBridge?.getLocalEnvironmentBootstrap()
  if (desktopBootstrap) return fromBootstrap(desktopBootstrap)

  const env = options.env ?? getDefaultEnv()
  const viteHttpBaseUrl = env.VITE_HIVE_HTTP_BASE_URL ?? env.VITE_HIVE_BACKEND_HTTP_BASE_URL
  if (viteHttpBaseUrl) {
    const httpBaseUrl = normalizeHttpBaseUrl(viteHttpBaseUrl)
    return {
      httpBaseUrl,
      wsBaseUrl: normalizeWsBaseUrl(
        env.VITE_HIVE_WS_BASE_URL ?? env.VITE_HIVE_BACKEND_WS_BASE_URL ?? wsFromHttp(httpBaseUrl)
      ),
      bootstrapToken: env.VITE_HIVE_BOOTSTRAP_TOKEN ?? null,
      source: 'vite'
    }
  }

  const location = options.location ?? getDefaultLocation()
  if (!location) {
    throw new Error('Unable to resolve Hive backend target without desktopBridge, Vite env, or window.location')
  }

  const httpBaseUrl = normalizeHttpBaseUrl(location.origin)
  return {
    httpBaseUrl,
    wsBaseUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    bootstrapToken: null,
    source: 'browser'
  }
}
