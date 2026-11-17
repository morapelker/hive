import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'

const mockedHome = vi.hoisted(() => ({ path: '' }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => mockedHome.path
}))

const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
vi.mock('../logger', () => ({ createLogger: () => logMocks }))

import { tmpdir } from 'os'
import {
  setClaudeApiProxyBaseUrl,
  setClaudeApiProxyUserBaseUrl
} from '../claude-api-proxy/claude-api-proxy-env'
import {
  CODE_MODE_ENV,
  decideClaudeUsageTransport,
  readClaudeSettingsEnv,
  resolveClaudeUsageTransport,
  type ClaudeLaunchEnvSource,
  type ClaudeUsageTransport,
  type ClaudeUsageTransportInput,
  type CodeModeExclusion
} from '../claude-usage-transport'

const PROXY_URL = 'http://127.0.0.1:42411'
const GATEWAY_URL = 'https://gateway.example.com/v1'

type Env = Record<string, string>

function input(overrides: Partial<ClaudeUsageTransportInput> = {}): ClaudeUsageTransportInput {
  return { featureEnabled: true, settingsEnv: {}, appEnv: {}, claudeSettingsEnv: {}, ...overrides }
}

/** The same variables, placed in one of the three sources. */
function inSource(source: ClaudeLaunchEnvSource, env: Env): Partial<ClaudeUsageTransportInput> {
  if (source === 'settings') return { settingsEnv: env }
  if (source === 'app-environment') return { appEnv: env }
  return { claudeSettingsEnv: env }
}

const SOURCES: ClaudeLaunchEnvSource[] = ['settings', 'app-environment', 'claude-settings']
const CODE_MODE_ON: Env = { [CODE_MODE_ENV]: '1' }

describe('decideClaudeUsageTransport', () => {
  describe('decision table', () => {
    interface Row {
      name: string
      requested: boolean
      enabled: boolean
      exclusion: Partial<ClaudeUsageTransportInput>
      transport: ClaudeUsageTransport
    }
    const ownAddress = { settingsEnv: { ANTHROPIC_BASE_URL: GATEWAY_URL } }
    const thirdParty = { settingsEnv: { CLAUDE_CODE_USE_BEDROCK: '1' } }
    const customProvider = { customProviderCommand: 'my-provider claude' }
    const rows: Row[] = [
      { name: 'nothing set', requested: false, enabled: true, exclusion: {}, transport: 'proxy' },
      {
        name: 'nothing set, feature disabled',
        requested: false,
        enabled: false,
        exclusion: {},
        transport: 'proxy'
      },
      {
        name: 'Code Mode requested, feature enabled',
        requested: true,
        enabled: true,
        exclusion: {},
        transport: 'debug-log'
      },
      {
        name: 'Code Mode requested, feature disabled',
        requested: true,
        enabled: false,
        exclusion: {},
        transport: 'none'
      },
      ...[true, false].flatMap((requested) =>
        [true, false].flatMap((enabled) =>
          [
            { label: 'own API address', exclusion: ownAddress },
            { label: 'third-party provider', exclusion: thirdParty },
            { label: 'custom provider', exclusion: customProvider }
          ].map(({ label, exclusion }): Row => ({
            name: `${label}, Code Mode ${requested ? 'requested' : 'not requested'}, feature ${enabled ? 'enabled' : 'disabled'}`,
            requested,
            enabled,
            exclusion,
            transport: 'proxy'
          }))
        )
      )
    ]

    it.each(rows)('$name → $transport', ({ requested, enabled, exclusion, transport }) => {
      const decision = decideClaudeUsageTransport(
        input({
          featureEnabled: enabled,
          appEnv: requested ? CODE_MODE_ON : {},
          ...exclusion
        })
      )
      expect(decision.transport).toBe(transport)
    })
  })

  describe('where Code Mode is requested from', () => {
    it.each(SOURCES)('counts as requested when %s sets the variable to 1', (source) => {
      expect(decideClaudeUsageTransport(input(inSource(source, CODE_MODE_ON)))).toEqual({
        transport: 'debug-log',
        codeModeSource: source,
        exclusion: null
      })
      expect(
        decideClaudeUsageTransport(
          input({ featureEnabled: false, ...inSource(source, CODE_MODE_ON) })
        ).transport
      ).toBe('none')
    })

    it('is not requested when no source has the variable', () => {
      expect(decideClaudeUsageTransport(input())).toEqual({
        transport: 'proxy',
        codeModeSource: null,
        exclusion: null
      })
      expect(decideClaudeUsageTransport(input({ claudeSettingsEnv: null })).transport).toBe('proxy')
      expect(decideClaudeUsageTransport(input({ claudeSettingsEnv: undefined })).transport).toBe(
        'proxy'
      )
    })

    // [Settings, app environment, Claude settings file] → the source that decides.
    const precedence: Array<
      [string, string | null, string | null, string | null, ClaudeLaunchEnvSource | null]
    > = [
      ['Settings says 0, the shell says 1', '0', '1', null, null],
      ['Settings says 1, the shell says 0', '1', '0', null, 'settings'],
      ['Settings says 0, the Claude settings file says 1', '0', null, '1', null],
      ['Settings says 1, the Claude settings file says 0', '1', null, '0', 'settings'],
      ['the shell says 0, the Claude settings file says 1', null, '0', '1', null],
      ['the shell says 1, the Claude settings file says 0', null, '1', '0', 'app-environment'],
      ['Settings blanks it, the shell says 1', '', '1', '1', null],
      ['the shell blanks it, the Claude settings file says 1', null, '', '1', null],
      ['Settings says 0, both others say 1', '0', '1', '1', null],
      ['all three say 1', '1', '1', '1', 'settings'],
      ['only the lowest source says 1', null, null, '1', 'claude-settings']
    ]

    it.each(precedence)('%s', (_name, settings, app, claude, expected) => {
      const env = (value: string | null): Env => (value === null ? {} : { [CODE_MODE_ENV]: value })
      const decision = decideClaudeUsageTransport(
        input({ settingsEnv: env(settings), appEnv: env(app), claudeSettingsEnv: env(claude) })
      )
      expect(decision.codeModeSource).toBe(expected)
      expect(decision.transport).toBe(expected === null ? 'proxy' : 'debug-log')
    })

    const notRequested = ['0', '', ' ', 'true', 'TRUE', 'yes', 'on', '2', '11', '01', '1.0', '-1']
    const cases = SOURCES.flatMap((source) => notRequested.map((value) => [source, value] as const))

    it.each(cases)('%s with value "%s" is not a request', (source, value) => {
      for (const featureEnabled of [true, false]) {
        const decision = decideClaudeUsageTransport(
          input({ featureEnabled, ...inSource(source, { [CODE_MODE_ENV]: value }) })
        )
        expect(decision).toEqual({ transport: 'proxy', codeModeSource: null, exclusion: null })
      }
    })

    it('ignores whitespace around the 1', () => {
      expect(
        decideClaudeUsageTransport(input({ settingsEnv: { [CODE_MODE_ENV]: ' 1 ' } })).transport
      ).toBe('debug-log')
    })
  })

  describe('exclusions', () => {
    const requested = (overrides: Partial<ClaudeUsageTransportInput>): ClaudeUsageTransportInput =>
      input({ appEnv: CODE_MODE_ON, ...overrides })

    function expectExcluded(
      overrides: Partial<ClaudeUsageTransportInput>,
      by: CodeModeExclusion
    ): void {
      for (const featureEnabled of [true, false]) {
        const decision = decideClaudeUsageTransport(requested({ featureEnabled, ...overrides }))
        expect(decision.transport).toBe('proxy')
        expect(decision.exclusion).toBe(by)
      }
    }

    function expectNotExcluded(overrides: Partial<ClaudeUsageTransportInput>): void {
      expect(decideClaudeUsageTransport(requested(overrides))).toEqual({
        transport: 'debug-log',
        codeModeSource: 'app-environment',
        exclusion: null
      })
    }

    it.each(SOURCES)('stays on proxy for the user’s own API address in %s', (source) => {
      const env = { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: GATEWAY_URL }
      const decision = decideClaudeUsageTransport(input(inSource(source, env)))
      expect(decision).toEqual({
        transport: 'proxy',
        codeModeSource: source,
        exclusion: 'own-api-address'
      })
    })

    it.each([
      'http://localhost:8080',
      'https://api.anthropic.com.evil.example',
      'https://anthropic.com',
      'https://eu.api.anthropic.com',
      'api.anthropic.com',
      'not a url'
    ])('treats %s as a non-Anthropic address', (address) => {
      expectExcluded({ settingsEnv: { ANTHROPIC_BASE_URL: address } }, 'own-api-address')
    })

    it.each([
      'https://api.anthropic.com',
      'https://api.anthropic.com/',
      'https://API.Anthropic.com/v1',
      '  https://api.anthropic.com  ',
      '',
      '   '
    ])('does not exclude the Anthropic address "%s"', (address) => {
      expectNotExcluded({ settingsEnv: { ANTHROPIC_BASE_URL: address } })
    })

    it('resolves the API address by the same precedence as the variable', () => {
      expectNotExcluded({
        settingsEnv: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
        appEnv: { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: GATEWAY_URL }
      })
      expectNotExcluded({
        settingsEnv: { ANTHROPIC_BASE_URL: '' },
        appEnv: { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: GATEWAY_URL }
      })
      expectExcluded(
        {
          settingsEnv: { ANTHROPIC_BASE_URL: GATEWAY_URL },
          appEnv: { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }
        },
        'own-api-address'
      )
    })

    it('does not mistake the app’s proxy address in its own environment for the user’s', () => {
      const appEnv = { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: PROXY_URL }
      expectNotExcluded({ appEnv, appProxyBaseUrl: PROXY_URL })
      expectNotExcluded({ appEnv, appProxyBaseUrl: PROXY_URL, userBaseUrl: null })
      expectNotExcluded({
        appEnv,
        appProxyBaseUrl: PROXY_URL,
        userBaseUrl: 'https://api.anthropic.com'
      })
      // Without a running proxy that loopback address is the user's own.
      expectExcluded({ appEnv }, 'own-api-address')
    })

    it('uses the address the proxy replaced as the user’s shell address', () => {
      const appEnv = { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: PROXY_URL }
      expectExcluded(
        { appEnv, appProxyBaseUrl: PROXY_URL, userBaseUrl: GATEWAY_URL },
        'own-api-address'
      )
      // Settings still wins over the shell.
      expectNotExcluded({
        settingsEnv: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
        appEnv,
        appProxyBaseUrl: PROXY_URL,
        userBaseUrl: GATEWAY_URL
      })
      // With no shell address, the Claude settings file is next.
      expectExcluded(
        {
          appEnv,
          appProxyBaseUrl: PROXY_URL,
          claudeSettingsEnv: { ANTHROPIC_BASE_URL: GATEWAY_URL }
        },
        'own-api-address'
      )
    })

    const providerVariables = [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'
    ]
    const providerCases = SOURCES.flatMap((source) =>
      providerVariables.map((variable) => [variable, source] as const)
    )

    it.each(providerCases)('stays on proxy for %s in %s', (variable, source) => {
      const decision = decideClaudeUsageTransport(
        input(inSource(source, { ...CODE_MODE_ON, [variable]: '1' }))
      )
      expect(decision).toEqual({
        transport: 'proxy',
        codeModeSource: source,
        exclusion: 'third-party-provider'
      })
    })

    it('reads a provider variable the way the proxy does', () => {
      expectExcluded({ settingsEnv: { CLAUDE_CODE_USE_VERTEX: 'true' } }, 'third-party-provider')
      expectNotExcluded({ settingsEnv: { CLAUDE_CODE_USE_BEDROCK: '0' } })
      expectNotExcluded({ settingsEnv: { CLAUDE_CODE_USE_BEDROCK: 'false' } })
      expectNotExcluded({ settingsEnv: { CLAUDE_CODE_USE_BEDROCK: '' } })
      // Settings turning the provider off beats the shell turning it on.
      expectNotExcluded({
        settingsEnv: { CLAUDE_CODE_USE_BEDROCK: '0' },
        appEnv: { ...CODE_MODE_ON, CLAUDE_CODE_USE_BEDROCK: '1' }
      })
    })

    it('stays on proxy for a custom provider session', () => {
      expectExcluded({ customProviderCommand: 'my-provider claude' }, 'custom-provider')
    })

    it.each([null, undefined, '', '   '])('does not count %j as a custom provider', (command) => {
      expectNotExcluded({ customProviderCommand: command })
    })
  })
})

describe('with files on disk', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-usage-transport-')))
    mockedHome.path = join(root, 'home')
  })

  afterEach(() => {
    setClaudeApiProxyBaseUrl(null)
    setClaudeApiProxyUserBaseUrl(null)
    rmSync(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeSettings(configDir: string, contents: string): void {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'settings.json'), contents)
  }

  function dbWithEnvVars(vars: Env): { getSetting(key: string): string | null } {
    const environmentVariables = Object.entries(vars).map(([key, value]) => ({ key, value }))
    return {
      getSetting: (key) =>
        key === APP_SETTINGS_DB_KEY ? JSON.stringify({ environmentVariables }) : null
    }
  }

  describe('readClaudeSettingsEnv', () => {
    it('returns the env block', async () => {
      const configDir = join(root, 'config')
      writeSettings(
        configDir,
        JSON.stringify({ model: 'haiku', env: { [CODE_MODE_ENV]: '1', OTHER: 'x' } })
      )
      expect(await readClaudeSettingsEnv(configDir)).toEqual({ [CODE_MODE_ENV]: '1', OTHER: 'x' })
    })

    it('reads a file that starts with a byte order mark', async () => {
      const configDir = join(root, 'config')
      writeSettings(configDir, '﻿' + JSON.stringify({ env: { [CODE_MODE_ENV]: '1' } }))
      expect(await readClaudeSettingsEnv(configDir)).toEqual({ [CODE_MODE_ENV]: '1' })
    })

    it('keeps scalar values as strings and drops the rest', async () => {
      const configDir = join(root, 'config')
      writeSettings(
        configDir,
        JSON.stringify({ env: { A: 1, B: true, C: 'c', D: null, E: { nested: '1' }, F: ['1'] } })
      )
      expect(await readClaudeSettingsEnv(configDir)).toEqual({ A: '1', B: 'true', C: 'c' })
    })

    it('sets nothing when the directory or the file is missing', async () => {
      expect(await readClaudeSettingsEnv(join(root, 'nowhere'))).toEqual({})
      mkdirSync(join(root, 'empty'))
      expect(await readClaudeSettingsEnv(join(root, 'empty'))).toEqual({})
    })

    it('sets nothing when the file cannot be read', async () => {
      const configDir = join(root, 'config')
      mkdirSync(join(configDir, 'settings.json'), { recursive: true })
      expect(await readClaudeSettingsEnv(configDir)).toEqual({})
    })

    it.each([
      ['empty', ''],
      ['truncated JSON', `{"env": {"${CODE_MODE_ENV}": "1"`],
      ['JSON with a comment', `{\n  // on\n  "env": {"${CODE_MODE_ENV}": "1"}\n}`],
      ['not JSON at all', 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1'],
      ['a JSON array', `[{"env": {"${CODE_MODE_ENV}": "1"}}]`],
      ['a JSON string', '"1"'],
      ['JSON null', 'null'],
      ['without an env block', '{"model": "haiku"}'],
      ['with env as a string', `{"env": "${CODE_MODE_ENV}=1"}`],
      ['with env as an array', `{"env": ["${CODE_MODE_ENV}=1"]}`],
      ['with env as null', '{"env": null}']
    ])('sets nothing for a settings file that is %s', async (_what, contents) => {
      const configDir = join(root, 'config')
      writeSettings(configDir, contents)
      expect(await readClaudeSettingsEnv(configDir)).toEqual({})
    })
  })

  describe('resolveClaudeUsageTransport', () => {
    const settingsWithCodeMode = JSON.stringify({ env: { [CODE_MODE_ENV]: '1' } })

    it('stays on proxy when nothing asks for Code Mode, and says nothing', async () => {
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: {} })).toBe(
        'proxy'
      )
      expect(logMocks.info).not.toHaveBeenCalled()
    })

    it('finds the variable in Settings → Environment Variables', async () => {
      const db = dbWithEnvVars(CODE_MODE_ON)
      expect(await resolveClaudeUsageTransport({ db, featureEnabled: true, env: {} })).toBe(
        'debug-log'
      )
      expect(await resolveClaudeUsageTransport({ db, featureEnabled: false, env: {} })).toBe('none')
    })

    it('finds the variable in the app’s own environment', async () => {
      const env = { ...CODE_MODE_ON }
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env })).toBe(
        'debug-log'
      )
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: false, env })).toBe(
        'none'
      )
    })

    it('defaults to process.env for the app’s own environment', async () => {
      vi.stubEnv(CODE_MODE_ENV, '1')
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'nowhere'))
      vi.stubEnv('ANTHROPIC_BASE_URL', undefined)
      for (const name of [
        'BEDROCK',
        'VERTEX',
        'FOUNDRY',
        'ANTHROPIC_AWS',
        'ANTHROPIC_GOOGLE_CLOUD'
      ]) {
        vi.stubEnv(`CLAUDE_CODE_USE_${name}`, undefined)
      }
      try {
        expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true })).toBe(
          'debug-log'
        )
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('finds the variable in ~/.claude/settings.json', async () => {
      writeSettings(join(mockedHome.path, '.claude'), settingsWithCodeMode)
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: {} })).toBe(
        'debug-log'
      )
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: false, env: {} })).toBe(
        'none'
      )
    })

    it('honours a Claude config directory relocated in the app’s environment', async () => {
      const relocated = join(root, 'relocated')
      writeSettings(relocated, settingsWithCodeMode)
      const env = { CLAUDE_CONFIG_DIR: relocated }
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env })).toBe(
        'debug-log'
      )
      // The relocated directory replaces ~/.claude, it does not add to it.
      writeSettings(join(mockedHome.path, '.claude'), settingsWithCodeMode)
      const elsewhere = { CLAUDE_CONFIG_DIR: join(root, 'nowhere') }
      expect(
        await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: elsewhere })
      ).toBe('proxy')
    })

    it('honours a Claude config directory relocated in Settings, over the app’s environment', async () => {
      const relocated = join(root, 'relocated')
      writeSettings(relocated, settingsWithCodeMode)
      const db = dbWithEnvVars({ CLAUDE_CONFIG_DIR: relocated })
      const env = { CLAUDE_CONFIG_DIR: join(root, 'nowhere') }
      expect(await resolveClaudeUsageTransport({ db, featureEnabled: true, env })).toBe('debug-log')
    })

    it('falls back to ~/.claude when the relocation is blank', async () => {
      writeSettings(join(mockedHome.path, '.claude'), settingsWithCodeMode)
      const env = { CLAUDE_CONFIG_DIR: '  ' }
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env })).toBe(
        'debug-log'
      )
    })

    it('lets a higher source overrule the Claude settings file', async () => {
      writeSettings(join(mockedHome.path, '.claude'), settingsWithCodeMode)
      const off = { [CODE_MODE_ENV]: '0' }
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: off })).toBe(
        'proxy'
      )
      expect(
        await resolveClaudeUsageTransport({ db: dbWithEnvVars(off), featureEnabled: true, env: {} })
      ).toBe('proxy')
    })

    it('lets Settings overrule the app’s environment', async () => {
      const db = dbWithEnvVars({ [CODE_MODE_ENV]: '0' })
      const env = { ...CODE_MODE_ON }
      expect(await resolveClaudeUsageTransport({ db, featureEnabled: true, env })).toBe('proxy')
    })

    it.each([
      ['missing', null],
      ['malformed', '{"env": {'],
      ['not an object', '[]']
    ])('never fails on a %s Claude settings file', async (_what, contents) => {
      if (contents !== null) writeSettings(join(mockedHome.path, '.claude'), contents)
      await expect(
        resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: {} })
      ).resolves.toBe('proxy')
      // The other sources still count.
      await expect(
        resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: { ...CODE_MODE_ON } })
      ).resolves.toBe('debug-log')
    })

    it('never fails on an unreadable Claude settings file', async () => {
      mkdirSync(join(mockedHome.path, '.claude', 'settings.json'), { recursive: true })
      await expect(
        resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: {} })
      ).resolves.toBe('proxy')
    })

    it('never fails on unreadable Settings', async () => {
      const db = {
        getSetting: (): string | null => {
          throw new Error('database is closed')
        }
      }
      const env = { ...CODE_MODE_ON }
      await expect(resolveClaudeUsageTransport({ db, featureEnabled: true, env })).resolves.toBe(
        'debug-log'
      )
    })

    it('stays on proxy for each exclusion, with Code Mode requested and the feature enabled', async () => {
      const env = { ...CODE_MODE_ON }
      expect(
        await resolveClaudeUsageTransport({
          db: dbWithEnvVars({ ANTHROPIC_BASE_URL: GATEWAY_URL }),
          featureEnabled: true,
          env
        })
      ).toBe('proxy')
      expect(
        await resolveClaudeUsageTransport({
          db: null,
          featureEnabled: true,
          env: { ...env, ANTHROPIC_BASE_URL: GATEWAY_URL }
        })
      ).toBe('proxy')
      expect(
        await resolveClaudeUsageTransport({
          db: null,
          featureEnabled: true,
          env: { ...env, CLAUDE_CODE_USE_BEDROCK: '1' }
        })
      ).toBe('proxy')
      expect(
        await resolveClaudeUsageTransport({
          db: null,
          featureEnabled: true,
          env,
          customProviderCommand: 'my-provider claude'
        })
      ).toBe('proxy')
    })

    it('counts an exclusion set in the Claude settings file', async () => {
      writeSettings(
        join(mockedHome.path, '.claude'),
        JSON.stringify({ env: { [CODE_MODE_ENV]: '1', CLAUDE_CODE_USE_VERTEX: '1' } })
      )
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env: {} })).toBe(
        'proxy'
      )
    })

    it('sees through the running proxy’s address on the app’s environment', async () => {
      const env = { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: PROXY_URL }
      setClaudeApiProxyBaseUrl(PROXY_URL)
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env })).toBe(
        'debug-log'
      )
      // The user's own gateway, which the proxy replaced there, still excludes.
      setClaudeApiProxyUserBaseUrl(GATEWAY_URL)
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env })).toBe(
        'proxy'
      )
    })

    it('logs a Code Mode decision without any variable value', async () => {
      const env = { ...CODE_MODE_ON, ANTHROPIC_BASE_URL: 'https://user:secret@gateway.example.com' }
      expect(await resolveClaudeUsageTransport({ db: null, featureEnabled: true, env })).toBe(
        'proxy'
      )
      expect(logMocks.info).toHaveBeenCalledTimes(1)
      expect(logMocks.info.mock.calls[0][1]).toEqual({
        transport: 'proxy',
        codeModeSource: 'app-environment',
        exclusion: 'own-api-address'
      })
    })
  })
})
