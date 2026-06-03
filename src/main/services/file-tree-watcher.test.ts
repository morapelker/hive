import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_TREE_CHANGE_CHANNEL } from '../../shared/file-tree-events'

const chokidarMocks = vi.hoisted(() => ({
  handlers: new Map<string, (path: string) => void>(),
  watch: vi.fn()
}))

const backendManagerMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('chokidar', () => ({
  watch: chokidarMocks.watch
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: backendManagerMocks.publishDesktopBackendEvent
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { cleanupFileTreeWatchers, startFileTreeWatcher } from './file-tree-watcher'

describe('file tree watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    chokidarMocks.handlers.clear()
    chokidarMocks.watch.mockImplementation(() => ({
      on: vi.fn((event: string, handler: (path: string) => void) => {
        chokidarMocks.handlers.set(event, handler)
      }),
      close: vi.fn().mockResolvedValue(undefined)
    }))
    backendManagerMocks.publishDesktopBackendEvent.mockResolvedValue(true)
  })

  afterEach(async () => {
    await cleanupFileTreeWatchers()
    vi.useRealTimers()
    chokidarMocks.watch.mockReset()
    backendManagerMocks.publishDesktopBackendEvent.mockReset()
  })

  it('publishes debounced file tree change events to the backend event bus bridge', async () => {
    startFileTreeWatcher('/tmp/hive')

    chokidarMocks.handlers.get('add')?.('/tmp/hive/src/App.tsx')
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()

    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      FILE_TREE_CHANGE_CHANNEL,
      {
        worktreePath: '/tmp/hive',
        events: [
          {
            eventType: 'add',
            changedPath: '/tmp/hive/src/App.tsx',
            relativePath: 'src/App.tsx'
          }
        ]
      }
    )
  })
})
