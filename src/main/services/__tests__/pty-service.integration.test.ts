import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_BASE_URL_ENV,
  ASSUME_FIRST_PARTY_ENV,
  setClaudeApiProxyBaseUrl
} from '../claude-api-proxy/claude-api-proxy-env'
import {
  ANTHROPIC_LOG_ENV,
  CLAUDE_ENV_FILE_ENV,
  buildClaudeCliPtySpawn,
  type ClaudeCliUsageLaunch
} from '../claude-cli-spawner'
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
  const touchedKeys = [
    ANTHROPIC_BASE_URL_ENV,
    ASSUME_FIRST_PARTY_ENV,
    ANTHROPIC_LOG_ENV,
    CLAUDE_ENV_FILE_ENV,
    KEPT
  ]
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
    setClaudeApiProxyBaseUrl(null)
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

  // Code Mode T15: what the CLI spawner asks for, through to the process. The command is
  // env(1) in place of the CLI; the environment and the removal list are the spawner's.
  describe('an interactive Claude CLI launch built by the spawner', () => {
    const PROXY_URL = 'http://127.0.0.1:42411'
    const DEBUG_LOG: ClaudeCliUsageLaunch = {
      transport: 'debug-log',
      debugLogFile: '/tmp/hive-test/usage.log',
      envFile: '/tmp/hive-test/env.sh'
    }

    function launchedProcessEnv(usage: ClaudeCliUsageLaunch | null): Promise<string[]> {
      const spawn = buildClaudeCliPtySpawn({
        session: {
          mode: 'build',
          model_provider_id: 'anthropic',
          model_id: 'sonnet',
          model_variant: 'high',
          claude_session_id: null
        },
        worktreePath: process.cwd(),
        usage
      })
      return spawnedProcessEnv({ env: spawn.env, unsetEnv: spawn.unsetEnv })
    }

    beforeEach(() => {
      // The running proxy: `process.env` already holds its two variables (see above).
      setClaudeApiProxyBaseUrl(PROXY_URL)
    })

    it(
      'on the proxy, the process is pointed at it as before',
      async () => {
        const env = await launchedProcessEnv(null)

        expect(env).toContain(`${ANTHROPIC_BASE_URL_ENV}=${PROXY_URL}`)
        expect(env).toContain(`${ASSUME_FIRST_PARTY_ENV}=1`)
        expect(namesIn(env)).not.toContain(ANTHROPIC_LOG_ENV)
        expect(namesIn(env)).not.toContain(CLAUDE_ENV_FILE_ENV)
      },
      TEST_TIMEOUT_MS
    )

    it(
      'on the debug log, the process has neither proxy variable and logs at debug level',
      async () => {
        // A level the user exported in their shell: the launch's own wins.
        process.env[ANTHROPIC_LOG_ENV] = 'info'
        const env = await launchedProcessEnv(DEBUG_LOG)

        expect(namesIn(env)).not.toContain(ANTHROPIC_BASE_URL_ENV)
        expect(namesIn(env)).not.toContain(ASSUME_FIRST_PARTY_ENV)
        expect(env).toContain(`${ANTHROPIC_LOG_ENV}=debug`)
        expect(env).toContain(`${CLAUDE_ENV_FILE_ENV}=${DEBUG_LOG.envFile}`)
        expect(env).toContain(`${KEPT}=kept`)
      },
      TEST_TIMEOUT_MS
    )

    it(
      'with no usage transport, the process has neither proxy variable and no log level',
      async () => {
        const env = await launchedProcessEnv({ transport: 'none' })

        expect(namesIn(env)).not.toContain(ANTHROPIC_BASE_URL_ENV)
        expect(namesIn(env)).not.toContain(ASSUME_FIRST_PARTY_ENV)
        expect(namesIn(env)).not.toContain(ANTHROPIC_LOG_ENV)
        expect(namesIn(env)).not.toContain(CLAUDE_ENV_FILE_ENV)
      },
      TEST_TIMEOUT_MS
    )

    it(
      "off the proxy, the process keeps an API address that is the user's own",
      async () => {
        process.env[ANTHROPIC_BASE_URL_ENV] = 'https://api.anthropic.com'
        delete process.env[ASSUME_FIRST_PARTY_ENV]
        const env = await launchedProcessEnv(DEBUG_LOG)

        expect(env).toContain(`${ANTHROPIC_BASE_URL_ENV}=https://api.anthropic.com`)
        expect(env).toContain(`${ANTHROPIC_LOG_ENV}=debug`)
      },
      TEST_TIMEOUT_MS
    )
  })
})
