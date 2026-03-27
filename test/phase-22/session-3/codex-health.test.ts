import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for codex-health.ts — version parsing, auth output parsing,
 * and health check orchestration.
 *
 * We test the pure parsing functions directly and mock child_process
 * for the async functions that shell out to the codex CLI.
 */

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock child_process — must provide default export for jsdom environment
const mockExecFile = vi.fn()
vi.mock('node:child_process', () => {
  return {
    default: { execFile: (...args: unknown[]) => mockExecFile(...args) },
    execFile: (...args: unknown[]) => mockExecFile(...args)
  }
})

import {
  parseVersionOutput,
  parseAuthOutput,
  getCodexVersion,
  checkCodexAuth,
  checkCodexHealth
} from '../../../src/main/services/codex-health'

describe('codex-health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── parseVersionOutput ─────────────────────────────────────────

  describe('parseVersionOutput', () => {
    it('parses "codex 1.2.3" format', () => {
      expect(parseVersionOutput('codex 1.2.3')).toBe('1.2.3')
    })

    it('parses "codex/1.2.3" format', () => {
      expect(parseVersionOutput('codex/1.2.3')).toBe('1.2.3')
    })

    it('parses bare version "1.2.3"', () => {
      expect(parseVersionOutput('1.2.3')).toBe('1.2.3')
    })

    it('parses version with trailing newline', () => {
      expect(parseVersionOutput('codex 0.9.1\n')).toBe('0.9.1')
    })

    it('parses multiline output (takes first line)', () => {
      expect(parseVersionOutput('codex 2.0.0\nsome other info')).toBe('2.0.0')
    })

    it('parses version with pre-release suffix', () => {
      expect(parseVersionOutput('1.0.0-beta.1')).toBe('1.0.0-beta.1')
    })

    it('returns null for empty string', () => {
      expect(parseVersionOutput('')).toBe(null)
    })

    it('returns null for whitespace-only string', () => {
      expect(parseVersionOutput('   \n  ')).toBe(null)
    })

    it('returns raw first line for non-version output', () => {
      expect(parseVersionOutput('something unexpected')).toBe('something unexpected')
    })
  })

  // ── parseAuthOutput ────────────────────────────────────────────

  describe('parseAuthOutput', () => {
    it('detects "not logged in" as unauthenticated', () => {
      expect(parseAuthOutput('You are not logged in')).toBe('unauthenticated')
    })

    it('detects "login required" as unauthenticated', () => {
      expect(parseAuthOutput('Login required to continue')).toBe('unauthenticated')
    })

    it('detects "run codex login" as unauthenticated', () => {
      expect(parseAuthOutput('Please run codex login first')).toBe('unauthenticated')
    })

    it('detects "unauthenticated" keyword as unauthenticated', () => {
      expect(parseAuthOutput('Status: unauthenticated')).toBe('unauthenticated')
    })

    it('detects "not authenticated" as unauthenticated', () => {
      expect(parseAuthOutput('User is not authenticated')).toBe('unauthenticated')
    })

    it('parses JSON with authenticated: true', () => {
      expect(parseAuthOutput('{"authenticated": true}')).toBe('authenticated')
    })

    it('parses JSON with authenticated: false', () => {
      expect(parseAuthOutput('{"authenticated": false}')).toBe('unauthenticated')
    })

    it('parses JSON with isAuthenticated: true', () => {
      expect(parseAuthOutput('{"isAuthenticated": true}')).toBe('authenticated')
    })

    it('parses JSON with loggedIn: true', () => {
      expect(parseAuthOutput('{"loggedIn": true}')).toBe('authenticated')
    })

    it('parses JSON with loggedIn: false', () => {
      expect(parseAuthOutput('{"loggedIn": false}')).toBe('unauthenticated')
    })

    it('assumes authenticated for unknown text output', () => {
      expect(parseAuthOutput('Logged in as user@example.com')).toBe('authenticated')
    })

    it('is case-insensitive for keyword matching', () => {
      expect(parseAuthOutput('NOT LOGGED IN')).toBe('unauthenticated')
    })
  })

  // ── getCodexVersion ────────────────────────────────────────────

  describe('getCodexVersion', () => {
    it('returns version string when codex is installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'codex 1.5.0\n')
        }
      )

      const version = await getCodexVersion()
      expect(version).toBe('1.5.0')
    })

    it('returns null when codex is not installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(new Error('command not found'))
        }
      )

      const version = await getCodexVersion()
      expect(version).toBe(null)
    })

    it('returns null on timeout', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(new Error('ETIMEDOUT'))
        }
      )

      const version = await getCodexVersion()
      expect(version).toBe(null)
    })

    it('calls codex with --version flag', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, '1.0.0')
        }
      )

      await getCodexVersion()
      expect(mockExecFile).toHaveBeenCalledWith(
        'codex',
        ['--version'],
        expect.objectContaining({ timeout: 5000 }),
        expect.any(Function)
      )
    })
  })

  // ── checkCodexAuth ─────────────────────────────────────────────

  describe('checkCodexAuth', () => {
    it('returns authenticated when logged in', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, '{"authenticated": true}')
        }
      )

      const status = await checkCodexAuth()
      expect(status).toBe('authenticated')
    })

    it('returns unauthenticated when not logged in', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'You are not logged in. Run codex login.')
        }
      )

      const status = await checkCodexAuth()
      expect(status).toBe('unauthenticated')
    })

    it('returns unknown when command fails', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(new Error('command not found'))
        }
      )

      const status = await checkCodexAuth()
      expect(status).toBe('unknown')
    })

    it('calls codex with login status args', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'ok')
        }
      )

      await checkCodexAuth()
      expect(mockExecFile).toHaveBeenCalledWith(
        'codex',
        ['login', 'status'],
        expect.objectContaining({ timeout: 5000 }),
        expect.any(Function)
      )
    })
  })

  // ── checkCodexHealth ───────────────────────────────────────────

  describe('checkCodexHealth', () => {
    it('returns unavailable when codex is not installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(new Error('command not found'))
        }
      )

      const health = await checkCodexHealth()
      expect(health.available).toBe(false)
      expect(health.authStatus).toBe('unknown')
      expect(health.message).toContain('not found')
    })

    it('returns available with auth status when codex is installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          if (args[0] === '--version') {
            cb(null, 'codex 1.0.0\n')
          } else if (args[0] === 'login') {
            cb(null, '{"authenticated": true}')
          }
        }
      )

      const health = await checkCodexHealth()
      expect(health.available).toBe(true)
      expect(health.version).toBe('1.0.0')
      expect(health.authStatus).toBe('authenticated')
      expect(health.message).toBeUndefined()
    })

    it('returns unauthenticated message when not logged in', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          if (args[0] === '--version') {
            cb(null, 'codex 1.0.0\n')
          } else if (args[0] === 'login') {
            cb(null, 'not logged in')
          }
        }
      )

      const health = await checkCodexHealth()
      expect(health.available).toBe(true)
      expect(health.authStatus).toBe('unauthenticated')
      expect(health.message).toContain('codex login')
    })

    it('skips auth check when checkAuth is false', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          if (args[0] === '--version') {
            cb(null, 'codex 1.0.0\n')
          } else {
            cb(new Error('should not be called'))
          }
        }
      )

      const health = await checkCodexHealth({ checkAuth: false })
      expect(health.available).toBe(true)
      expect(health.authStatus).toBe('unknown')
    })

    it('health status has correct shape', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(new Error('not found'))
        }
      )

      const health = await checkCodexHealth()
      expect(health).toHaveProperty('available')
      expect(health).toHaveProperty('authStatus')
    })
  })
})
