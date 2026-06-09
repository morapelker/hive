export const LOCAL_ENVIRONMENT_BOOTSTRAP_ARG_PREFIX = '--hive-local-environment-bootstrap='

export interface LocalEnvironmentBootstrap {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly bootstrapToken: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const encodeLocalEnvironmentBootstrapArg = (
  bootstrap: LocalEnvironmentBootstrap | null
): string =>
  `${LOCAL_ENVIRONMENT_BOOTSTRAP_ARG_PREFIX}${encodeURIComponent(JSON.stringify(bootstrap))}`

export const decodeLocalEnvironmentBootstrapArg = (
  argv: readonly string[]
): LocalEnvironmentBootstrap | null => {
  const arg = argv.find((value) => value.startsWith(LOCAL_ENVIRONMENT_BOOTSTRAP_ARG_PREFIX))
  if (!arg) return null

  try {
    const parsed = JSON.parse(
      decodeURIComponent(arg.slice(LOCAL_ENVIRONMENT_BOOTSTRAP_ARG_PREFIX.length))
    ) as unknown
    if (!isRecord(parsed)) return null
    if (
      typeof parsed.httpBaseUrl !== 'string' ||
      typeof parsed.wsBaseUrl !== 'string' ||
      typeof parsed.bootstrapToken !== 'string'
    ) {
      return null
    }
    return {
      httpBaseUrl: parsed.httpBaseUrl,
      wsBaseUrl: parsed.wsBaseUrl,
      bootstrapToken: parsed.bootstrapToken
    }
  } catch {
    return null
  }
}
