import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('posthog-node', () => ({
  PostHog: vi.fn()
}))

vi.mock('../db', () => ({
  getDatabase: vi.fn()
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { resolveTelemetryAppVersion } from './telemetry-service'

describe('telemetry service', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('resolves telemetry app version from the Node package environment', () => {
    vi.stubEnv('npm_package_version', '1.2.3-test')

    expect(resolveTelemetryAppVersion()).toBe('1.2.3-test')
  })
})
