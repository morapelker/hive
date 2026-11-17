// A project moved to the dev folder while its files were on screen. Seen in the app: the
// watcher of the old folder reported the folder going away, the store scanned the old path
// once more, and "Error loading files: Directory does not exist" stayed over the folder at
// its new place, because the store has one `error` for every folder. After
// `rekeyWorktreePaths` nothing is loaded, watched or reported for a path that moved away,
// and an answer that is already on its way about it is dropped. That lasts a minute: the late
// report comes within seconds, and the same path may hold another project later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  scan: vi.fn(),
  scanFlat: vi.fn(),
  loadChildren: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
  onChange: vi.fn()
}))

vi.mock('@/api/file-tree-api', () => ({ fileTreeApi: api }))

import { useFileTreeStore } from './useFileTreeStore'

type ScanAnswer = { success: boolean; tree?: unknown[]; error?: string }

const tree = (root: string): ScanAnswer => ({
  success: true,
  tree: [
    {
      name: 'README.md',
      path: `${root}/README.md`,
      relativePath: 'README.md',
      isDirectory: false,
      extension: '.md'
    }
  ]
})

const gone: ScanAnswer = { success: false, error: 'Directory does not exist' }

/** A scan that answers when the test says so. */
const heldScan = (): { answer: (value: ScanAnswer) => void; promise: Promise<ScanAnswer> } => {
  let answer: (value: ScanAnswer) => void = () => {}
  const promise = new Promise<ScanAnswer>((resolve) => {
    answer = resolve
  })
  return { answer, promise }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// The store remembers the folders that moved away for a minute, longer than this suite runs,
// so every test moves folders of its own.
let run = 0
const folders = (): { from: string; to: string } => {
  run += 1
  return { from: `/old-${run}/app`, to: `/dev-${run}/app` }
}

describe('useFileTreeStore after a folder moved away', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    api.scan.mockResolvedValue(gone)
    api.scanFlat.mockResolvedValue({ success: true, files: [] })
    api.watch.mockResolvedValue(undefined)
    api.unwatch.mockResolvedValue(undefined)
    api.onChange.mockReturnValue(() => {})
    useFileTreeStore.setState({
      fileTreeByWorktree: new Map(),
      fileIndexByWorktree: new Map(),
      fileIndexLoadingByWorktree: new Map(),
      expandedPathsByWorktree: new Map(),
      filterByWorktree: new Map(),
      isLoading: false,
      error: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not scan the old path again and keeps its failure off the panel', async () => {
    const { from, to } = folders()
    api.scan.mockImplementation(async (path: string) => (path === to ? tree(to) : gone))
    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])

    await useFileTreeStore.getState().loadFileTree(to)
    // The report of the old folder's watcher, arriving after the new place was read.
    await useFileTreeStore.getState().handleFileChange(from, [])
    await useFileTreeStore.getState().loadFileTree(from)
    await useFileTreeStore.getState().loadFileTree(`${from}/packages/web`)

    const state = useFileTreeStore.getState()
    expect(api.scan.mock.calls.map(([path]) => path)).toEqual([to])
    expect(state.error).toBeNull()
    expect(state.isLoading).toBe(false)
    expect(state.fileTreeByWorktree.get(to)).toHaveLength(1)
    expect(state.fileTreeByWorktree.has(from)).toBe(false)
  })

  it('drops the answer of a scan of the old path that was under way when the folder moved', async () => {
    const { from, to } = folders()
    const old = heldScan()
    api.scan.mockImplementation((path: string) =>
      path === from ? old.promise : Promise.resolve(tree(to))
    )

    const stale = useFileTreeStore.getState().loadFileTree(from)
    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])
    await useFileTreeStore.getState().loadFileTree(to)
    old.answer(gone)
    await stale

    const state = useFileTreeStore.getState()
    expect(state.error).toBeNull()
    expect(state.isLoading).toBe(false)
    expect(state.fileTreeByWorktree.get(to)).toHaveLength(1)
  })

  it('stops showing "loading" when the only scan under way was of the folder that moved', async () => {
    const { from, to } = folders()
    const old = heldScan()
    api.scan.mockImplementation(() => old.promise)

    const stale = useFileTreeStore.getState().loadFileTree(from)
    expect(useFileTreeStore.getState().isLoading).toBe(true)
    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])
    old.answer(tree(from))
    await stale

    const state = useFileTreeStore.getState()
    expect(state.isLoading).toBe(false)
    expect(state.error).toBeNull()
    // A tree of a path that is gone is not kept either.
    expect(state.fileTreeByWorktree.has(from)).toBe(false)
  })

  it('lets only the newest load say what went wrong', async () => {
    const { from: slowPath, to: currentPath } = folders()
    const slow = heldScan()
    api.scan.mockImplementation((path: string) =>
      path === slowPath ? slow.promise : Promise.resolve(tree(currentPath))
    )

    const earlier = useFileTreeStore.getState().loadFileTree(slowPath)
    await useFileTreeStore.getState().loadFileTree(currentPath)
    slow.answer(gone)
    await earlier

    expect(useFileTreeStore.getState().error).toBeNull()
    expect(useFileTreeStore.getState().isLoading).toBe(false)
  })

  it('still reports a failure of the newest load', async () => {
    const { from } = folders()
    api.scan.mockResolvedValue(gone)

    await useFileTreeStore.getState().loadFileTree(from)

    expect(useFileTreeStore.getState().error).toBe('Directory does not exist')
    expect(useFileTreeStore.getState().isLoading).toBe(false)
  })

  it('ends the watch of a folder that moved and starts none for it afterwards', async () => {
    const { from, to } = folders()
    const unsubscribe = vi.fn()
    api.onChange.mockReturnValue(unsubscribe)

    await useFileTreeStore.getState().startWatching(from)
    expect(api.watch).toHaveBeenCalledWith(from)

    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])
    await settle()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(api.unwatch).toHaveBeenCalledWith(from)

    // The view that started the watch stops it by the old path when it follows the worktree.
    api.unwatch.mockClear()
    await useFileTreeStore.getState().stopWatching(from)
    expect(api.unwatch).not.toHaveBeenCalled()

    api.watch.mockClear()
    await useFileTreeStore.getState().startWatching(from)
    expect(api.watch).not.toHaveBeenCalled()

    await useFileTreeStore.getState().startWatching(to)
    expect(api.watch).toHaveBeenCalledWith(to)
  })

  it('reads a folder again once it has moved back', async () => {
    const { from, to } = folders()
    api.scan.mockImplementation(async (path: string) => tree(path))

    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])
    await useFileTreeStore.getState().loadFileTree(from)
    expect(api.scan).not.toHaveBeenCalled()

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: to, to: from }])
    await useFileTreeStore.getState().loadFileTree(from)
    await useFileTreeStore.getState().loadFileTree(to)

    expect(api.scan.mock.calls.map(([path]) => path)).toEqual([from])
    expect(useFileTreeStore.getState().fileTreeByWorktree.get(from)).toHaveLength(1)
  })

  it('loads a path that moved away again once the mark has expired', async () => {
    vi.useFakeTimers()
    const { from, to } = folders()
    // Another project was put where the moved one used to be.
    api.scan.mockImplementation(async (path: string) => tree(path))

    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])
    await useFileTreeStore.getState().loadFileTree(from)
    vi.advanceTimersByTime(59_000)
    await useFileTreeStore.getState().loadFileTree(`${from}/packages/web`)
    await useFileTreeStore.getState().startWatching(from)
    expect(api.scan).not.toHaveBeenCalled()
    expect(api.watch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    await useFileTreeStore.getState().loadFileTree(from)
    await useFileTreeStore.getState().startWatching(from)

    expect(api.scan.mock.calls.map(([path]) => path)).toEqual([from])
    expect(api.watch).toHaveBeenCalledWith(from)
    const state = useFileTreeStore.getState()
    expect(state.fileTreeByWorktree.get(from)).toHaveLength(1)
    expect(state.isLoading).toBe(false)
    expect(state.error).toBeNull()
    await useFileTreeStore.getState().stopWatching(from)
  })

  it('keeps the mark of a folder that moved later when an older one expires', async () => {
    vi.useFakeTimers()
    const first = folders()
    const second = folders()
    api.scan.mockImplementation(async (path: string) => tree(path))

    useFileTreeStore.getState().rekeyWorktreePaths([first])
    vi.advanceTimersByTime(45_000)
    useFileTreeStore.getState().rekeyWorktreePaths([second])
    vi.advanceTimersByTime(30_000)
    await useFileTreeStore.getState().loadFileTree(first.from)
    await useFileTreeStore.getState().loadFileTree(second.from)

    expect(api.scan.mock.calls.map(([path]) => path)).toEqual([first.from])
  })

  it('leaves a folder with a longer name that starts the same alone', async () => {
    const { from, to } = folders()
    const neighbour = `${from}-legacy`
    api.scan.mockImplementation(async (path: string) => tree(path))

    useFileTreeStore.getState().rekeyWorktreePaths([{ from, to }])
    await useFileTreeStore.getState().loadFileTree(neighbour)

    expect(api.scan).toHaveBeenCalledWith(neighbour)
    expect(useFileTreeStore.getState().fileTreeByWorktree.get(neighbour)).toHaveLength(1)
  })
})
