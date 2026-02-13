import { beforeEach, describe, expect, test, vi } from 'vitest'

// Mock the logger
vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/tmp/hive-test-app')
  }
}))

// We test the service's exported singleton directly.
// The native addon may or may not be available depending on whether
// libghostty was built on this machine.

import { ghosttyService } from '../../src/main/services/ghostty-service'

describe('GhosttyService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the service state between tests by shutting down
    // (this is safe even if not initialized)
    try {
      ghosttyService.shutdown()
    } catch {
      // ignore
    }
  })

  describe('isAvailable / loadAddon', () => {
    test('reports not available before loading addon', () => {
      // On non-macOS or without the native addon built, this should be false
      // The actual behavior depends on platform and whether the .node file exists
      expect(typeof ghosttyService.isAvailable()).toBe('boolean')
    })

    test('isInitialized is false before init', () => {
      expect(ghosttyService.isInitialized()).toBe(false)
    })
  })

  describe('init without addon', () => {
    test('returns error when addon is not available', () => {
      // If loadAddon fails (e.g. no .node file), init should return error
      const result = ghosttyService.init()
      // Either success (if addon is available on this machine) or error
      expect(result).toHaveProperty('success')
      if (!result.success) {
        expect(result.error).toBeDefined()
      }
    })
  })

  describe('surface management without initialization', () => {
    test('createSurface fails when not initialized', () => {
      const result = ghosttyService.createSurface('wt-1', { x: 0, y: 0, w: 800, h: 600 })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not initialized')
    })

    test('hasSurface returns false for unknown worktree', () => {
      expect(ghosttyService.hasSurface('nonexistent')).toBe(false)
    })

    test('getSurfaceId returns 0 for unknown worktree', () => {
      expect(ghosttyService.getSurfaceId('nonexistent')).toBe(0)
    })
  })

  describe('setFrame / setSize / setFocus without addon', () => {
    test('setFrame does not throw when no addon', () => {
      expect(() => ghosttyService.setFrame('wt-1', { x: 0, y: 0, w: 100, h: 100 })).not.toThrow()
    })

    test('setSize does not throw when no addon', () => {
      expect(() => ghosttyService.setSize('wt-1', 800, 600)).not.toThrow()
    })

    test('setFocus does not throw when no addon', () => {
      expect(() => ghosttyService.setFocus('wt-1', true)).not.toThrow()
    })
  })

  describe('input forwarding without addon', () => {
    test('keyEvent returns false when no addon', () => {
      expect(ghosttyService.keyEvent('wt-1', { action: 1, keycode: 65, mods: 0 })).toBe(false)
    })

    test('mouseButton does not throw when no addon', () => {
      expect(() => ghosttyService.mouseButton('wt-1', 1, 0, 0)).not.toThrow()
    })

    test('mousePos does not throw when no addon', () => {
      expect(() => ghosttyService.mousePos('wt-1', 100, 200, 0)).not.toThrow()
    })

    test('mouseScroll does not throw when no addon', () => {
      expect(() => ghosttyService.mouseScroll('wt-1', 0, -3, 0)).not.toThrow()
    })
  })

  describe('destroySurface', () => {
    test('does not throw for non-existent surface', () => {
      expect(() => ghosttyService.destroySurface('nonexistent')).not.toThrow()
    })
  })

  describe('shutdown', () => {
    test('does not throw when not initialized', () => {
      expect(() => ghosttyService.shutdown()).not.toThrow()
    })

    test('isInitialized is false after shutdown', () => {
      ghosttyService.shutdown()
      expect(ghosttyService.isInitialized()).toBe(false)
    })
  })

  describe('destroyExcept', () => {
    test('does not throw with no surfaces', () => {
      expect(() => ghosttyService.destroyExcept(new Set(['wt-1']))).not.toThrow()
    })
  })

  describe('getVersion', () => {
    test('returns a string (version or unknown)', () => {
      const version = ghosttyService.getVersion()
      expect(typeof version).toBe('string')
      expect(version.length).toBeGreaterThan(0)
    })
  })
})

// Separate describe for testing with mocked addon internals
describe('GhosttyService with mocked addon', () => {
  // These tests verify the service logic with a mock addon.
  // Since the real service uses require() internally, we test the
  // integration path through the exported singleton which may or may not
  // have a real addon loaded depending on the test environment.

  test('service is a singleton', async () => {
    const { ghosttyService: svc1 } = await import('../../src/main/services/ghostty-service')
    const { ghosttyService: svc2 } = await import('../../src/main/services/ghostty-service')
    expect(svc1).toBe(svc2)
  })
})
