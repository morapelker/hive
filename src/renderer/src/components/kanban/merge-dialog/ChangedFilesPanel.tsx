import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import type { DiffViewMode } from '@/components/diff/DiffViewer'
import { cn } from '@/lib/utils'
import { ChangedFileDiff, type DiffCache } from './ChangedFileDiff'
import { ChangedFilesList } from './ChangedFilesList'
import {
  changedFilesSourceKey,
  filterChangedFiles,
  type ChangedFile,
  type ChangedFilesSource
} from './changed-files'

// Remembered for the app session, not persisted: a 720px dialog reads best
// unified, but someone who switched to split probably wants it again
let rememberedViewMode: DiffViewMode = 'unified'

export interface ChangedFilesPanelHandle {
  /**
   * Escape, innermost layer first: an open diff goes back to the list, a
   * non-empty filter clears. Returns true when the key was consumed so the
   * owner can keep the dialog open.
   */
  handleEscape: () => boolean
}

interface ChangedFilesPanelProps {
  source: ChangedFilesSource | null
  files: ChangedFile[] | null
  loading: boolean
  error: string | null
  emptyState: ReactNode
  onRetry: () => void
  className?: string
  ref?: Ref<ChangedFilesPanelHandle>
}

/**
 * The file list with an in-place drill-down into a single file's diff. Owns
 * the navigation state (open file, filter text, scroll memory); remount it
 * (via `key`) to start over.
 */
export function ChangedFilesPanel({
  source,
  files,
  loading,
  error,
  emptyState,
  onRetry,
  className,
  ref
}: ChangedFilesPanelProps): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLUListElement | null>(null)
  const listScrollTop = useRef(0)
  const returnFocusPath = useRef<string | null>(null)
  const cache = useRef<DiffCache>(new Map())
  // Bumped when the list refreshes so an open diff refetches its patch
  const [cacheVersion, setCacheVersion] = useState(0)
  const [viewMode, setViewModeState] = useState<DiffViewMode>(rememberedViewMode)

  const setViewMode = useCallback((mode: DiffViewMode) => {
    rememberedViewMode = mode
    setViewModeState(mode)
  }, [])

  const sourceKey = source ? changedFilesSourceKey(source) : null
  useEffect(() => {
    cache.current.clear()
    listScrollTop.current = 0
    returnFocusPath.current = null
  }, [sourceKey])

  // A refreshed list means the patches may have changed too
  useEffect(() => {
    cache.current.clear()
    setCacheVersion((v) => v + 1)
  }, [files])

  // Prev/next walk the rows the user can see, i.e. the filtered list
  const visibleFiles = useMemo(
    () => (files ? filterChangedFiles(files, query) : []),
    [files, query]
  )
  const navFiles = useMemo(
    () =>
      selectedPath !== null && !visibleFiles.some((f) => f.path === selectedPath)
        ? (files ?? [])
        : visibleFiles,
    [files, visibleFiles, selectedPath]
  )
  const selectedIndex =
    selectedPath !== null ? navFiles.findIndex((file) => file.path === selectedPath) : -1
  const selected = selectedIndex >= 0 ? navFiles[selectedIndex] : null

  // The open file vanished from a refreshed list — fall back to the list
  useEffect(() => {
    if (selectedPath !== null && files && !files.some((f) => f.path === selectedPath)) {
      setSelectedPath(null)
    }
  }, [selectedPath, files])

  const open = useCallback((file: ChangedFile) => {
    listScrollTop.current = listRef.current?.scrollTop ?? 0
    returnFocusPath.current = file.path
    setSelectedPath(file.path)
  }, [])

  const back = useCallback(() => setSelectedPath(null), [])

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= navFiles.length) return
      returnFocusPath.current = navFiles[index].path
      setSelectedPath(navFiles[index].path)
    },
    [navFiles]
  )

  useImperativeHandle(
    ref,
    () => ({
      handleEscape: () => {
        if (selectedPath !== null) {
          back()
          return true
        }
        if (query) {
          setQuery('')
          return true
        }
        return false
      }
    }),
    [selectedPath, query, back]
  )

  // Coming back: put the list where it was and focus the row that was opened
  useLayoutEffect(() => {
    if (selected) return
    const list = listRef.current
    if (!list) return
    list.scrollTop = listScrollTop.current
    const path = returnFocusPath.current
    if (!path) return
    const row = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-path]')).find(
      (el) => el.dataset.path === path
    )
    row?.focus()
  }, [selected])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!selected) return
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    if (event.key === '[') {
      event.preventDefault()
      goTo(selectedIndex - 1)
    } else if (event.key === ']') {
      event.preventDefault()
      goTo(selectedIndex + 1)
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} onKeyDown={handleKeyDown}>
      {selected && source ? (
        <ChangedFileDiff
          source={source}
          file={selected}
          index={selectedIndex}
          count={navFiles.length}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          cache={cache}
          version={cacheVersion}
          onBack={back}
          onPrev={() => goTo(selectedIndex - 1)}
          onNext={() => goTo(selectedIndex + 1)}
        />
      ) : (
        <ChangedFilesList
          files={files}
          loading={loading}
          error={error}
          emptyState={emptyState}
          listRef={listRef}
          query={query}
          onQueryChange={setQuery}
          onOpen={open}
          onRetry={onRetry}
        />
      )}
    </div>
  )
}
