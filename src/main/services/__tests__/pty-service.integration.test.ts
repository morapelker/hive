import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_BASE_URL_ENV,
  ASSUME_FIRST_PARTY_ENV
} from '../claude-api-proxy/claude-api-proxy-env'
import { ptyService, type PtyCreateOpts } from '../pty-service'

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

/**
 * Really spawns env(1) in a node-pty PTY under plain Node and reads back the
 * environment the process got, the two proxy variables being the reason
 * `unsetEnv` exists.
 */
const ENV_BINARY = '/usr/bin/env'
const TEST_TIMEOUT_MS = 20_000
const KEPT = 'HIVE_TEST_KEPT'
const CALLER_ONLY = 'HIVE_TEST_CALLER_ONLY'

const unsupported = process.platform === 'win32' || !existsSync(ENV_BINARY)

describe.skipIf(unsupported)('ptyService.create unsetEnv (real process)', () => {
  const touchedKeys = [ANTHROPIC_BASE_URL_ENV, ASSUME_FIRST_PARTY_ENV, KEPT]
  const savedEnv: Record<string, string | undefined> = {}
  let nextId = 0

  beforeEach(() => {
    for (const key of touchedKeys) savedEnv[key] = process.env[key]
    process.env[ANTHROPIC_BASE_URL_ENV] = 'http://127.0.0.1:42411'
    process.env[ASSUME_FIRST_PARTY_ENV] = '1'
    process.env[KEPT] = 'kept'
  })

  afterEach(() => {
    ptyService.destroyAll()
    for (const key of touchedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  /** The `NAME=value` lines env(1) printed from inside the PTY. */
  function spawnedProcessEnv(opts: Partial<PtyCreateOpts>): Promise<string[]> {
    return new Promise((resolve) => {
      const id = `pty-unset-env-real-${nextId++}`
      let output = ''
      ptyService.create(id, { cwd: process.cwd(), command: ENV_BINARY, ...opts })
      ptyService.onData(id, (data) => {
        output += data
      })
      ptyService.onExit(id, () => resolve(output.split(/\r?\n/)))
    })
  }

  function namesIn(lines: string[]): string[] {
    return lines.filter((line) => line.includes('=')).map((line) => line.split('=')[0])
  }

  it(
    'the process lacks the removed variables that the app and the caller both set',
    async () => {
      const inherited = await spawnedProcessEnv({})
      const removed = await spawnedProcessEnv({
        env: { [ANTHROPIC_BASE_URL_ENV]: 'http://caller.invalid', [CALLER_ONLY]: 'yes' },
        unsetEnv: [ANTHROPIC_BASE_URL_ENV, ASSUME_FIRST_PARTY_ENV]
      })

      expect(inherited).toContain(`${ANTHROPIC_BASE_URL_ENV}=http://127.0.0.1:42411`)
      expect(inherited).toContain(`${ASSUME_FIRST_PARTY_ENV}=1`)

      expect(namesIn(removed)).not.toContain(ANTHROPIC_BASE_URL_ENV)
      expect(namesIn(removed)).not.toContain(ASSUME_FIRST_PARTY_ENV)
      expect(removed).toContain(`${KEPT}=kept`)
      expect(removed).toContain(`${CALLER_ONLY}=yes`)
      // Nothing else went missing.
      expect(
        namesIn(inherited)
          .filter((name) => !namesIn(removed).includes(name))
          .sort()
      ).toEqual([ANTHROPIC_BASE_URL_ENV, ASSUME_FIRST_PARTY_ENV].sort())
    },
    TEST_TIMEOUT_MS
  )
})
