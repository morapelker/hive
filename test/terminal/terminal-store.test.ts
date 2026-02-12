import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'

// Mock window.terminalOps before importing the store
const mockCreate = vi.fn()
const mockDestroy = vi.fn()
const mockOnExit = vi.fn()

Object.defineProperty(window, 'terminalOps', {
  writable: true,
  value: {
    create: mockCreate,
    write: vi.fn(),
    resize: vi.fn(),
    destroy: mockDestroy,
    onData: vi.fn().mockReturnValue(() => {}),
    onExit: mockOnExit.mockReturnValue(() => {})
  }
})

import { useTerminalStore } from '../../src/renderer/src/stores/useTerminalStore'

describe('useTerminalStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state
    act(() => {
      useTerminalStore.setState({ terminals: new Map() })
    })
  })

  describe('createTerminal', () => {
    test('creates terminal and transitions to running status', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-1', '/tmp/project')
      })

      const terminal = useTerminalStore.getState().terminals.get('wt-1')
      expect(terminal).toBeDefined()
      expect(terminal!.status).toBe('running')
      expect(mockCreate).toHaveBeenCalledWith('wt-1', '/tmp/project', undefined)
    })

    test('sets creating status during creation', async () => {
      let resolveCreate: (value: unknown) => void
      mockCreate.mockReturnValue(
        new Promise((resolve) => {
          resolveCreate = resolve
        })
      )

      const store = useTerminalStore.getState()

      // Start creation but don't await
      let createPromise: Promise<unknown>
      act(() => {
        createPromise = store.createTerminal('wt-2', '/tmp')
      })

      // During creation, status should be 'creating'
      const creating = useTerminalStore.getState().terminals.get('wt-2')
      expect(creating).toBeDefined()
      expect(creating!.status).toBe('creating')

      // Resolve and finish
      await act(async () => {
        resolveCreate!({ success: true, cols: 80, rows: 24 })
        await createPromise!
      })

      const running = useTerminalStore.getState().terminals.get('wt-2')
      expect(running!.status).toBe('running')
    })

    test('removes terminal on creation failure', async () => {
      mockCreate.mockResolvedValue({ success: false, error: 'spawn failed' })

      const store = useTerminalStore.getState()
      let result: { success: boolean; error?: string }
      await act(async () => {
        result = await store.createTerminal('wt-fail', '/tmp')
      })

      expect(result!.success).toBe(false)
      expect(result!.error).toBe('spawn failed')
      expect(useTerminalStore.getState().terminals.has('wt-fail')).toBe(false)
    })

    test('removes terminal on exception', async () => {
      mockCreate.mockRejectedValue(new Error('network error'))

      const store = useTerminalStore.getState()
      let result: { success: boolean; error?: string }
      await act(async () => {
        result = await store.createTerminal('wt-err', '/tmp')
      })

      expect(result!.success).toBe(false)
      expect(result!.error).toBe('network error')
      expect(useTerminalStore.getState().terminals.has('wt-err')).toBe(false)
    })

    test('does not recreate already running terminal', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-dup', '/tmp')
      })

      // Try to create again
      await act(async () => {
        await store.createTerminal('wt-dup', '/tmp')
      })

      // Should only have called create once
      expect(mockCreate).toHaveBeenCalledTimes(1)
    })

    test('registers onExit listener after creation', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-exit', '/tmp')
      })

      expect(mockOnExit).toHaveBeenCalledWith('wt-exit', expect.any(Function))
    })

    test('onExit callback updates terminal status to exited', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })

      let exitCallback: (code: number) => void
      mockOnExit.mockImplementation((_id: string, cb: (code: number) => void) => {
        exitCallback = cb
        return () => {}
      })

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-exit-cb', '/tmp')
      })

      // Simulate exit
      act(() => {
        exitCallback!(0)
      })

      const terminal = useTerminalStore.getState().terminals.get('wt-exit-cb')
      expect(terminal).toBeDefined()
      expect(terminal!.status).toBe('exited')
      expect(terminal!.exitCode).toBe(0)
    })

    test('onExit callback preserves non-zero exit codes', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })

      let exitCallback: (code: number) => void
      mockOnExit.mockImplementation((_id: string, cb: (code: number) => void) => {
        exitCallback = cb
        return () => {}
      })

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-exit-code', '/tmp')
      })

      act(() => {
        exitCallback!(127)
      })

      const terminal = useTerminalStore.getState().terminals.get('wt-exit-code')
      expect(terminal!.exitCode).toBe(127)
    })
  })

  describe('destroyTerminal', () => {
    test('destroys terminal and removes from state', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })
      mockDestroy.mockResolvedValue(undefined)

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-destroy', '/tmp')
      })
      expect(useTerminalStore.getState().terminals.has('wt-destroy')).toBe(true)

      await act(async () => {
        await store.destroyTerminal('wt-destroy')
      })

      expect(mockDestroy).toHaveBeenCalledWith('wt-destroy')
      expect(useTerminalStore.getState().terminals.has('wt-destroy')).toBe(false)
    })

    test('removes from state even if destroy IPC throws', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })
      mockDestroy.mockRejectedValue(new Error('already dead'))

      const store = useTerminalStore.getState()
      await act(async () => {
        await store.createTerminal('wt-destroy-err', '/tmp')
      })

      await act(async () => {
        await store.destroyTerminal('wt-destroy-err')
      })

      expect(useTerminalStore.getState().terminals.has('wt-destroy-err')).toBe(false)
    })
  })

  describe('setTerminalStatus', () => {
    test('sets terminal status', () => {
      act(() => {
        useTerminalStore.getState().setTerminalStatus('wt-status', 'running')
      })

      const terminal = useTerminalStore.getState().terminals.get('wt-status')
      expect(terminal).toEqual({ status: 'running' })
    })

    test('sets terminal status with exit code', () => {
      act(() => {
        useTerminalStore.getState().setTerminalStatus('wt-exit-status', 'exited', 1)
      })

      const terminal = useTerminalStore.getState().terminals.get('wt-exit-status')
      expect(terminal).toEqual({ status: 'exited', exitCode: 1 })
    })
  })

  describe('getTerminal', () => {
    test('returns terminal info for existing terminal', async () => {
      mockCreate.mockResolvedValue({ success: true, cols: 80, rows: 24 })

      await act(async () => {
        await useTerminalStore.getState().createTerminal('wt-get', '/tmp')
      })

      const terminal = useTerminalStore.getState().getTerminal('wt-get')
      expect(terminal).toBeDefined()
      expect(terminal!.status).toBe('running')
    })

    test('returns undefined for non-existent terminal', () => {
      const terminal = useTerminalStore.getState().getTerminal('nonexistent')
      expect(terminal).toBeUndefined()
    })
  })
})
