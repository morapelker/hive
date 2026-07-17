// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  platform: vi.fn(),
  userInfo: vi.fn()
}))

vi.mock('child_process', () => ({
  default: { execFile: (...args: unknown[]) => mocks.execFile(...args) },
  execFile: (...args: unknown[]) => mocks.execFile(...args)
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, platform: () => mocks.platform(), userInfo: () => mocks.userInfo() },
    platform: () => mocks.platform(),
    userInfo: () => mocks.userInfo()
  }
})

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { keychainRead, keychainWrite, keychainDelete } from '../../src/main/services/keychain'

type ExecFileCallback = (error: Error | null, stdout: string, stderr?: string) => void

describe('keychain', () => {
  const originalUser = process.env.USER

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.platform.mockReturnValue('darwin')
    mocks.userInfo.mockReturnValue({ username: 'fallback-user' })
    process.env.USER = 'test-user'
  })

  afterEach(() => {
    if (originalUser === undefined) delete process.env.USER
    else process.env.USER = originalUser
  })

  describe('keychainRead', () => {
    it('returns the trimmed secret on success', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) =>
          cb(null, '  the-secret  \n')
      )

      await expect(keychainRead('My Service')).resolves.toBe('the-secret')
      expect(mocks.execFile).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'My Service', '-w'],
        { timeout: 5000 },
        expect.any(Function)
      )
    })

    it('returns null when the security CLI fails (item not found, etc.)', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) =>
          cb(new Error('security: item could not be found in the keychain.'), '')
      )

      await expect(keychainRead('My Service')).resolves.toBeNull()
    })

    it('returns null without touching execFile on non-macOS platforms', async () => {
      mocks.platform.mockReturnValue('linux')

      await expect(keychainRead('My Service')).resolves.toBeNull()
      expect(mocks.execFile).not.toHaveBeenCalled()
    })
  })

  describe('keychainWrite', () => {
    it('invokes security with the expected argument shape', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => cb(null, '')
      )

      await keychainWrite('My Service', 'sekret')

      expect(mocks.execFile).toHaveBeenCalledWith(
        'security',
        ['add-generic-password', '-U', '-s', 'My Service', '-a', 'test-user', '-w', 'sekret'],
        { timeout: 5000 },
        expect.any(Function)
      )
    })

    it('falls back to os.userInfo().username when process.env.USER is unset', async () => {
      delete process.env.USER
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => cb(null, '')
      )

      await keychainWrite('My Service', 'sekret')

      expect(mocks.execFile).toHaveBeenCalledWith(
        'security',
        ['add-generic-password', '-U', '-s', 'My Service', '-a', 'fallback-user', '-w', 'sekret'],
        { timeout: 5000 },
        expect.any(Function)
      )
    })

    it('throws when the security CLI fails', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) =>
          cb(new Error('security: something went wrong'), '', 'security: something went wrong')
      )

      await expect(keychainWrite('My Service', 'sekret')).rejects.toThrow(
        'security: something went wrong'
      )
    })

    it('never leaks the -w secret (or raw command line) in the thrown/logged error', async () => {
      const secret = 'super-secret-refresh-token'
      // Node's real ExecFileException.message embeds the full argv, secret and
      // all. runSecurity must sanitize it away.
      mocks.execFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
          const raw = Object.assign(
            new Error(`Command failed: security ${args.join(' ')}\nsecurity: write failed`),
            { code: 1 }
          )
          cb(raw, '', 'security: write failed')
        }
      )

      const error = await keychainWrite('My Service', secret).catch((e) => e as Error)

      expect(error).toBeInstanceOf(Error)
      expect(error.message).not.toContain(secret)
      expect(error.message).not.toContain('-w')
      expect(error.message).toContain('add-generic-password')
      // security's stderr is safe to surface (it never echoes -w values).
      expect(error.message).toContain('security: write failed')
    })

    it('throws on non-macOS platforms without calling execFile', async () => {
      mocks.platform.mockReturnValue('linux')

      await expect(keychainWrite('My Service', 'sekret')).rejects.toThrow(
        'Keychain is only available on macOS'
      )
      expect(mocks.execFile).not.toHaveBeenCalled()
    })
  })

  describe('keychainDelete', () => {
    it('resolves silently when the item is not found', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) =>
          cb(new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'), '')
      )

      await expect(keychainDelete('My Service')).resolves.toBeUndefined()
    })

    it('resolves silently based on exit code 44 (errSecItemNotFound), even if the message wording drifts', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
          const error = Object.assign(new Error('security: some unrecognized future wording'), {
            code: 44
          })
          cb(error, '')
        }
      )

      await expect(keychainDelete('My Service')).resolves.toBeUndefined()
    })

    it('re-throws when neither the exit code nor the message indicate item-not-found', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
          const error = Object.assign(new Error('security: some other unexpected failure'), {
            code: 1
          })
          cb(error, '', 'security: some other unexpected failure')
        }
      )

      await expect(keychainDelete('My Service')).rejects.toThrow(
        'security: some other unexpected failure'
      )
    })

    it('re-throws other security CLI failures', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) =>
          cb(
            new Error('security: some other unexpected failure'),
            '',
            'security: some other unexpected failure'
          )
      )

      await expect(keychainDelete('My Service')).rejects.toThrow(
        'security: some other unexpected failure'
      )
    })

    it('calls security with the expected argument shape', async () => {
      mocks.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => cb(null, '')
      )

      await keychainDelete('My Service')

      expect(mocks.execFile).toHaveBeenCalledWith(
        'security',
        ['delete-generic-password', '-s', 'My Service'],
        { timeout: 5000 },
        expect.any(Function)
      )
    })

    it('throws on non-macOS platforms without calling execFile', async () => {
      mocks.platform.mockReturnValue('linux')

      await expect(keychainDelete('My Service')).rejects.toThrow(
        'Keychain is only available on macOS'
      )
      expect(mocks.execFile).not.toHaveBeenCalled()
    })
  })
})
