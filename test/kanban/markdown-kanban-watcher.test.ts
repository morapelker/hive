import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface FakeWatcher {
  paths: string[]
  options: Record<string, unknown>
  handlers: Map<string, (path: string) => void>
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const { fakeWatchers, watchMock, mockDatabase, mockState, publishDesktopBackendEvent } = vi.hoisted(() => {
  const fakeWatchers: FakeWatcher[] = []
  const watchMock = vi.fn((paths: string[], options: Record<string, unknown>) => {
    const watcher: FakeWatcher = {
      paths,
      options,
      handlers: new Map(),
      on: vi.fn((event: string, callback: (path: string) => void) => {
        watcher.handlers.set(event, callback)
        return watcher
      }),
      close: vi.fn(async () => undefined)
    }
    fakeWatchers.push(watcher)
    return watcher
  })
  const mockState = {
    project: {
      id: 'project-1',
      name: 'Project 1',
      path: '/repo',
      kanban_storage_mode: 'markdown',
      kanban_markdown_config: JSON.stringify({
        layout: 'single-folder',
        singleFolder: 'cards'
      })
    }
  }
  const mockDatabase = {
    getProject: vi.fn((projectId: string) => (projectId === mockState.project.id ? mockState.project : null))
  }
  const publishDesktopBackendEvent = vi.fn(async () => undefined)
  return { fakeWatchers, watchMock, mockDatabase, mockState, publishDesktopBackendEvent }
})

vi.mock('chokidar', () => ({
  watch: watchMock
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mockDatabase
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../src/main/desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent
}))

function emit(index: number, event: 'add' | 'change' | 'unlink', path: string): void {
  fakeWatchers[index].handlers.get(event)?.(path)
}

describe('MarkdownKanbanWatcher', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    fakeWatchers.length = 0
    mockState.project = {
      id: 'project-1',
      name: 'Project 1',
      path: '/repo',
      kanban_storage_mode: 'markdown',
      kanban_markdown_config: JSON.stringify({
        layout: 'single-folder',
        singleFolder: 'cards'
      })
    }
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    await watcher.cleanupMarkdownKanbanWatchers()
    watcher.setMarkdownKanbanEventPublisher(null)
    watcher.initMarkdownKanbanWatcher()
  })

  afterEach(async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    await watcher.cleanupMarkdownKanbanWatchers()
    watcher.setMarkdownKanbanEventPublisher(null)
    vi.useRealTimers()
  })

  test('watch.start no-ops for internal-mode projects', async () => {
    mockState.project = { ...mockState.project, kanban_storage_mode: 'internal' }
    const { startMarkdownKanbanProjectWatch } = await import('../../src/main/services/markdown-kanban-watcher')

    const result = await startMarkdownKanbanProjectWatch('project-1')

    expect(result).toEqual({ success: true })
    expect(watchMock).not.toHaveBeenCalled()
  })

  test('internal-mode watch interest starts watching after mode switches to markdown', async () => {
    mockState.project = { ...mockState.project, kanban_storage_mode: 'internal' }
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')

    await watcher.startMarkdownKanbanProjectWatch('project-1')
    expect(watchMock).not.toHaveBeenCalled()

    mockState.project = { ...mockState.project, kanban_storage_mode: 'markdown' }
    await watcher.restartMarkdownKanbanProjectWatch('project-1')

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(fakeWatchers[0].paths).toEqual(['/repo/cards'])
  })

  test('stopping an internal-mode no-op watch clears pending interest', async () => {
    mockState.project = { ...mockState.project, kanban_storage_mode: 'internal' }
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')

    await watcher.startMarkdownKanbanProjectWatch('project-1')
    await watcher.stopMarkdownKanbanProjectWatch('project-1')
    mockState.project = { ...mockState.project, kanban_storage_mode: 'markdown' }
    await watcher.restartMarkdownKanbanProjectWatch('project-1')

    expect(watchMock).not.toHaveBeenCalled()
  })

  test('starts one-level watchers for status folders', async () => {
    mockState.project = {
      ...mockState.project,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    }
    const { startMarkdownKanbanProjectWatch } = await import('../../src/main/services/markdown-kanban-watcher')

    await startMarkdownKanbanProjectWatch('project-1')

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(fakeWatchers[0].paths).toEqual([
      '/repo/cards/todo',
      '/repo/cards/in-progress',
      '/repo/cards/review',
      '/repo/cards/done'
    ])
    expect(fakeWatchers[0].options).toMatchObject({ depth: 0, ignoreInitial: true })
  })

  test('debounces markdown candidate file changes into one project event', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    watcher.initMarkdownKanbanWatcher()
    await watcher.startMarkdownKanbanProjectWatch('project-1')

    emit(0, 'change', '/repo/cards/first.md')
    emit(0, 'add', '/repo/cards/.hidden.md')
    emit(0, 'change', '/repo/cards/not-a-card.txt')
    emit(0, 'unlink', '/repo/cards/second.markdown')

    vi.advanceTimersByTime(299)
    expect(publishDesktopBackendEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await vi.dynamicImportSettled()

    expect(publishDesktopBackendEvent).toHaveBeenCalledWith('kanban:markdown:changed', {
      projectId: 'project-1',
      paths: ['/repo/cards/first.md', '/repo/cards/second.markdown'],
      eventTypes: ['change', 'unlink']
    })
  })

  test('publishes debounced changes through an injected server event publisher', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    const publisher = vi.fn()
    watcher.setMarkdownKanbanEventPublisher(publisher)
    await watcher.startMarkdownKanbanProjectWatch('project-1')

    emit(0, 'change', '/repo/cards/first.md')
    vi.advanceTimersByTime(300)
    await vi.dynamicImportSettled()

    expect(publisher).toHaveBeenCalledWith('kanban:markdown:changed', {
      projectId: 'project-1',
      paths: ['/repo/cards/first.md'],
      eventTypes: ['change']
    })
    expect(publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  test('does not publish a debounced event after its watcher has stopped', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    await watcher.startMarkdownKanbanProjectWatch('project-1')

    emit(0, 'change', '/repo/cards/first.md')
    vi.advanceTimersByTime(300)
    await watcher.stopMarkdownKanbanProjectWatch('project-1')
    await vi.dynamicImportSettled()

    expect(publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  test('refcounting prevents premature watcher close', async () => {
    const { startMarkdownKanbanProjectWatch, stopMarkdownKanbanProjectWatch } = await import(
      '../../src/main/services/markdown-kanban-watcher'
    )

    await startMarkdownKanbanProjectWatch('project-1')
    await startMarkdownKanbanProjectWatch('project-1')
    await stopMarkdownKanbanProjectWatch('project-1')

    expect(fakeWatchers[0].close).not.toHaveBeenCalled()

    await stopMarkdownKanbanProjectWatch('project-1')

    expect(fakeWatchers[0].close).toHaveBeenCalledTimes(1)
  })

  test('start followed by stop during watcher creation does not leak a watcher', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')

    const startPromise = watcher.startMarkdownKanbanProjectWatch('project-1')
    await watcher.stopMarkdownKanbanProjectWatch('project-1')
    await startPromise

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(fakeWatchers[0].close).toHaveBeenCalledTimes(1)
    expect(watcher.getMarkdownKanbanWatcherCount()).toBe(0)
  })

  test('concurrent starts create one active watcher for a project', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')

    await Promise.all([
      watcher.startMarkdownKanbanProjectWatch('project-1'),
      watcher.startMarkdownKanbanProjectWatch('project-1')
    ])

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(watcher.getMarkdownKanbanWatcherCount()).toBe(1)
  })

  test('forced stop clears interest and active watcher state', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')

    await watcher.startMarkdownKanbanProjectWatch('project-1')
    await watcher.startMarkdownKanbanProjectWatch('project-1')
    await watcher.stopMarkdownKanbanProjectWatch('project-1', { force: true })
    await watcher.restartMarkdownKanbanProjectWatch('project-1')

    expect(fakeWatchers[0].close).toHaveBeenCalledTimes(1)
    expect(watchMock).toHaveBeenCalledTimes(1)
  })

  test('suppresses Hive-write events only for the written path', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    watcher.initMarkdownKanbanWatcher()
    await watcher.startMarkdownKanbanProjectWatch('project-1')

    watcher.suppressMarkdownKanbanWatch('project-1', '/repo/cards/first.md', 1_000)
    emit(0, 'change', '/repo/cards/first.md')
    emit(0, 'change', '/repo/cards/second.md')
    vi.advanceTimersByTime(300)
    await vi.dynamicImportSettled()

    expect(publishDesktopBackendEvent).toHaveBeenCalledWith('kanban:markdown:changed', {
      projectId: 'project-1',
      paths: ['/repo/cards/second.md'],
      eventTypes: ['change']
    })
  })

  test('allows path changes again after self-write suppression expires', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    watcher.initMarkdownKanbanWatcher()
    await watcher.startMarkdownKanbanProjectWatch('project-1')

    watcher.suppressMarkdownKanbanWatch('project-1', '/repo/cards/first.md', 1_000)
    emit(0, 'change', '/repo/cards/first.md')
    vi.advanceTimersByTime(500)
    expect(publishDesktopBackendEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(501)

    emit(0, 'change', '/repo/cards/first.md')
    vi.advanceTimersByTime(300)
    await vi.dynamicImportSettled()

    expect(publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
  })

  test('suppresses multiple Hive-written paths independently', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    watcher.initMarkdownKanbanWatcher()
    await watcher.startMarkdownKanbanProjectWatch('project-1')

    watcher.suppressMarkdownKanbanWatch(
      'project-1',
      ['/repo/cards/first.md', '/repo/cards/second.md'],
      1_000
    )
    emit(0, 'change', '/repo/cards/first.md')
    emit(0, 'unlink', '/repo/cards/second.md')
    emit(0, 'add', '/repo/cards/third.md')
    vi.advanceTimersByTime(300)
    await vi.dynamicImportSettled()

    expect(publishDesktopBackendEvent).toHaveBeenCalledWith('kanban:markdown:changed', {
      projectId: 'project-1',
      paths: ['/repo/cards/third.md'],
      eventTypes: ['add']
    })
  })

  test('restarts active watchers after config changes', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')
    await watcher.startMarkdownKanbanProjectWatch('project-1')
    mockState.project = {
      ...mockState.project,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        statusFolders: {
          todo: 'new/todo',
          in_progress: 'new/in-progress',
          review: 'new/review',
          done: 'new/done'
        }
      })
    }

    await watcher.restartMarkdownKanbanProjectWatch('project-1')

    expect(fakeWatchers[0].close).toHaveBeenCalledTimes(1)
    expect(fakeWatchers[1].paths).toEqual([
      '/repo/new/todo',
      '/repo/new/in-progress',
      '/repo/new/review',
      '/repo/new/done'
    ])
  })

  test('deactivating for markdown-to-internal mode switch preserves visible-board interest', async () => {
    const watcher = await import('../../src/main/services/markdown-kanban-watcher')

    await watcher.startMarkdownKanbanProjectWatch('project-1')
    mockState.project = { ...mockState.project, kanban_storage_mode: 'internal' }
    await watcher.deactivateMarkdownKanbanProjectWatch('project-1')

    expect(fakeWatchers[0].close).toHaveBeenCalledTimes(1)

    mockState.project = { ...mockState.project, kanban_storage_mode: 'markdown' }
    await watcher.restartMarkdownKanbanProjectWatch('project-1')

    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(fakeWatchers[1].paths).toEqual(['/repo/cards'])
  })
})
