import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'events'

// Mock node-pty
const spawnMock = vi.fn()

vi.mock('node-pty', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  default: {
    spawn: (...args: unknown[]) => spawnMock(...args)
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

class MockPty extends EventEmitter {
  cols: number
  rows: number
  pid = 12345
  private _dataHandlers: Array<(data: string) => void> = []
  private _exitHandlers: Array<(e: { exitCode: number; signal: number }) => void> = []

  write = vi.fn()
  resize = vi.fn()
  kill = vi.fn()

  constructor(cols: number, rows: number) {
    super()
    this.cols = cols
    this.rows = rows
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    this._dataHandlers.push(handler)
    return {
      dispose: () => {
        const idx = this._dataHandlers.indexOf(handler)
        if (idx !== -1) this._dataHandlers.splice(idx, 1)
      }
    }
  }

  onExit(handler: (e: { exitCode: number; signal: number }) => void): { dispose: () => void } {
    this._exitHandlers.push(handler)
    return {
      dispose: () => {
        const idx = this._exitHandlers.indexOf(handler)
        if (idx !== -1) this._exitHandlers.splice(idx, 1)
      }
    }
  }

  // Test helpers to simulate events
  simulateData(data: string): void {
    for (const h of this._dataHandlers) h(data)
  }

  simulateExit(exitCode: number, signal: number): void {
    for (const h of this._exitHandlers) h({ exitCode, signal })
  }
}

// Must import after mocks are set up
import { ptyService } from '../../src/main/services/pty-service'

describe('PtyService', () => {
  let mockPty: MockPty

  beforeEach(() => {
    vi.clearAllMocks()
    // Clean up any existing PTYs from previous tests
    ptyService.destroyAll()

    mockPty = new MockPty(80, 24)
    spawnMock.mockReturnValue(mockPty)
  })

  describe('create', () => {
    test('creates a PTY with default settings', () => {
      const result = ptyService.create('wt-1', { cwd: '/tmp' })

      expect(spawnMock).toHaveBeenCalledOnce()
      expect(result).toEqual({ cols: 80, rows: 24 })
      expect(ptyService.has('wt-1')).toBe(true)
    })

    test('passes shell, cols, rows, and cwd to pty.spawn', () => {
      ptyService.create('wt-2', {
        cwd: '/home/user/project',
        shell: '/bin/fish',
        cols: 120,
        rows: 40
      })

      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/fish',
        [],
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: '/home/user/project'
        })
      )
    })

    test('sets TERM and COLORTERM env vars', () => {
      ptyService.create('wt-3', { cwd: '/tmp' })

      const callArgs = spawnMock.mock.calls[0][2]
      expect(callArgs.env.TERM).toBe('xterm-256color')
      expect(callArgs.env.COLORTERM).toBe('truecolor')
    })

    test('reuses existing PTY for same id', () => {
      const customPty = new MockPty(100, 50)
      spawnMock.mockReturnValueOnce(customPty)

      ptyService.create('wt-4', { cwd: '/tmp' })
      const result = ptyService.create('wt-4', { cwd: '/other' })

      // Should only spawn once
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(result).toEqual({ cols: 100, rows: 50 })
    })

    test('merges custom env with process env', () => {
      ptyService.create('wt-5', {
        cwd: '/tmp',
        env: { MY_VAR: 'hello' }
      })

      const callArgs = spawnMock.mock.calls[0][2]
      expect(callArgs.env.MY_VAR).toBe('hello')
      // Should still have TERM set
      expect(callArgs.env.TERM).toBe('xterm-256color')
    })
  })

  describe('write', () => {
    test('writes data to the PTY', () => {
      ptyService.create('wt-write', { cwd: '/tmp' })
      ptyService.write('wt-write', 'echo hello\n')

      expect(mockPty.write).toHaveBeenCalledWith('echo hello\n')
    })

    test('does not throw for non-existent PTY', () => {
      expect(() => ptyService.write('nonexistent', 'data')).not.toThrow()
    })
  })

  describe('resize', () => {
    test('resizes the PTY', () => {
      ptyService.create('wt-resize', { cwd: '/tmp' })
      ptyService.resize('wt-resize', 120, 40)

      expect(mockPty.resize).toHaveBeenCalledWith(120, 40)
    })

    test('does not throw for non-existent PTY', () => {
      expect(() => ptyService.resize('nonexistent', 80, 24)).not.toThrow()
    })

    test('handles resize errors gracefully', () => {
      ptyService.create('wt-resize-err', { cwd: '/tmp' })
      mockPty.resize.mockImplementation(() => {
        throw new Error('resize failed')
      })

      expect(() => ptyService.resize('wt-resize-err', 0, 0)).not.toThrow()
    })
  })

  describe('destroy', () => {
    test('kills the PTY and removes it', () => {
      ptyService.create('wt-destroy', { cwd: '/tmp' })
      expect(ptyService.has('wt-destroy')).toBe(true)

      ptyService.destroy('wt-destroy')

      expect(mockPty.kill).toHaveBeenCalled()
      expect(ptyService.has('wt-destroy')).toBe(false)
    })

    test('does not throw for non-existent PTY', () => {
      expect(() => ptyService.destroy('nonexistent')).not.toThrow()
    })

    test('handles kill errors gracefully', () => {
      ptyService.create('wt-kill-err', { cwd: '/tmp' })
      mockPty.kill.mockImplementation(() => {
        throw new Error('kill failed')
      })

      expect(() => ptyService.destroy('wt-kill-err')).not.toThrow()
      expect(ptyService.has('wt-kill-err')).toBe(false)
    })
  })

  describe('destroyAll', () => {
    test('destroys all PTYs', () => {
      const pty1 = new MockPty(80, 24)
      const pty2 = new MockPty(80, 24)
      spawnMock.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2)

      ptyService.create('wt-a', { cwd: '/tmp' })
      ptyService.create('wt-b', { cwd: '/tmp' })

      expect(ptyService.getIds()).toHaveLength(2)

      ptyService.destroyAll()

      expect(ptyService.getIds()).toHaveLength(0)
      expect(pty1.kill).toHaveBeenCalled()
      expect(pty2.kill).toHaveBeenCalled()
    })
  })

  describe('onData', () => {
    test('receives data from PTY', () => {
      ptyService.create('wt-data', { cwd: '/tmp' })

      const callback = vi.fn()
      ptyService.onData('wt-data', callback)

      mockPty.simulateData('hello world')

      expect(callback).toHaveBeenCalledWith('hello world')
    })

    test('supports multiple listeners', () => {
      ptyService.create('wt-multi', { cwd: '/tmp' })

      const cb1 = vi.fn()
      const cb2 = vi.fn()
      ptyService.onData('wt-multi', cb1)
      ptyService.onData('wt-multi', cb2)

      mockPty.simulateData('test')

      expect(cb1).toHaveBeenCalledWith('test')
      expect(cb2).toHaveBeenCalledWith('test')
    })

    test('unsubscribe works', () => {
      ptyService.create('wt-unsub', { cwd: '/tmp' })

      const callback = vi.fn()
      const unsub = ptyService.onData('wt-unsub', callback)

      mockPty.simulateData('first')
      expect(callback).toHaveBeenCalledTimes(1)

      unsub()
      mockPty.simulateData('second')
      expect(callback).toHaveBeenCalledTimes(1)
    })

    test('returns no-op for non-existent PTY', () => {
      const unsub = ptyService.onData('nonexistent', vi.fn())
      expect(typeof unsub).toBe('function')
      expect(() => unsub()).not.toThrow()
    })
  })

  describe('onExit', () => {
    test('receives exit events from PTY', () => {
      ptyService.create('wt-exit', { cwd: '/tmp' })

      const callback = vi.fn()
      ptyService.onExit('wt-exit', callback)

      mockPty.simulateExit(0, 0)

      expect(callback).toHaveBeenCalledWith(0, 0)
    })

    test('removes PTY from map on exit', () => {
      ptyService.create('wt-exit-rm', { cwd: '/tmp' })
      expect(ptyService.has('wt-exit-rm')).toBe(true)

      mockPty.simulateExit(0, 0)

      expect(ptyService.has('wt-exit-rm')).toBe(false)
    })

    test('unsubscribe works', () => {
      ptyService.create('wt-exit-unsub', { cwd: '/tmp' })

      const callback = vi.fn()
      const unsub = ptyService.onExit('wt-exit-unsub', callback)

      unsub()
      mockPty.simulateExit(1, 15)

      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('has and getIds', () => {
    test('has returns true for existing PTY', () => {
      ptyService.create('wt-has', { cwd: '/tmp' })
      expect(ptyService.has('wt-has')).toBe(true)
      expect(ptyService.has('nonexistent')).toBe(false)
    })

    test('getIds returns all active PTY ids', () => {
      const pty1 = new MockPty(80, 24)
      const pty2 = new MockPty(80, 24)
      spawnMock.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2)

      ptyService.create('wt-x', { cwd: '/tmp' })
      ptyService.create('wt-y', { cwd: '/tmp' })

      const ids = ptyService.getIds()
      expect(ids).toContain('wt-x')
      expect(ids).toContain('wt-y')
      expect(ids).toHaveLength(2)
    })
  })
})
