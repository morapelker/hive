import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface HeadlessConfig {
  port: number
  bindAddress: string
  tls: {
    certPath: string
    keyPath: string
  }
  security: {
    bruteForceMaxAttempts: number
    bruteForceWindowSec: number
    bruteForceBlockSec: number
    inactivityTimeoutMin: number
    allowedIps: string[]
  }
}

const DEFAULTS: HeadlessConfig = {
  port: 8443,
  bindAddress: '0.0.0.0',
  tls: {
    certPath: join(homedir(), '.hive', 'tls', 'server.crt'),
    keyPath: join(homedir(), '.hive', 'tls', 'server.key')
  },
  security: {
    bruteForceMaxAttempts: 5,
    bruteForceWindowSec: 60,
    bruteForceBlockSec: 300,
    inactivityTimeoutMin: 30,
    allowedIps: []
  }
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const targetVal = result[key as keyof T]
    const sourceVal = source[key]
    if (
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal)
    ) {
      ;(result as Record<string, unknown>)[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      )
    } else if (sourceVal !== undefined) {
      ;(result as Record<string, unknown>)[key] = sourceVal
    }
  }
  return result
}

function cloneDefaults(): HeadlessConfig {
  return {
    ...DEFAULTS,
    tls: { ...DEFAULTS.tls },
    security: { ...DEFAULTS.security }
  }
}

export function loadHeadlessConfig(configPath?: string): HeadlessConfig {
  const path = configPath ?? join(homedir(), '.hive', 'headless.json')
  if (!existsSync(path)) return cloneDefaults()

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return deepMerge(cloneDefaults(), parsed)
  } catch {
    console.warn('Failed to parse headless config, using defaults')
    return cloneDefaults()
  }
}
