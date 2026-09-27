import { useMemo, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ChevronRight, Loader2, Search } from 'lucide-react'
import { FileIcon } from '@/components/file-tree/FileIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isImageFile } from '@shared/types/file-utils'
import {
  CHANGED_FILE_STATUS,
  fileExtension,
  filterChangedFiles,
  splitPath,
  type ChangedFile
} from './changed-files'

/** Lists longer than this get a filter box */
export const FILTER_THRESHOLD = 8

export function ChangedFileStatusBadge({
  status,
  className
}: {
  status: ChangedFile['status']
  className?: string
}): React.JSX.Element {
  const meta = CHANGED_FILE_STATUS[status]
  return (
    <span
      role="img"
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted font-mono text-[10px] font-semibold leading-none',
        meta.className,
        className
      )}
      title={meta.label}
      aria-label={meta.label}
      data-testid="merge-file-status"
    >
      {meta.letter}
    </span>
  )
}

/** Directory muted and end-truncated, file name always fully visible */
export function ChangedFilePath({
  path,
  className
}: {
  path: string
  className?: string
}): React.JSX.Element {
  const { dir, name } = splitPath(path)
  return (
    <span
      className={cn('flex min-w-0 items-baseline font-mono text-xs', className)}
      title={path}
      data-testid="merge-file-path"
    >
      {dir && <span className="truncate text-muted-foreground">{dir}</span>}
      <span className="shrink-0 font-medium text-foreground">{name}</span>
    </span>
  )
}

export function ChangedFileCounts({ file }: { file: ChangedFile }): React.JSX.Element {
  if (file.binary) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {isImageFile(file.path) ? 'image' : 'binary'}
      </span>
    )
  }
  return (
    <span className="shrink-0 space-x-2 font-mono text-[11px]">
      <span className="text-emerald-500">+{file.additions}</span>
      <span className="text-rose-500">-{file.deletions}</span>
    </span>
  )
}

interface ChangedFilesListProps {
  files: ChangedFile[] | null
  loading: boolean
  error: string | null
  emptyState: ReactNode
  listRef: RefObject<HTMLUListElement | null>
  /** Filter text; owned by the panel so it survives opening a diff */
  query: string
  onQueryChange: (query: string) => void
  onOpen: (file: ChangedFile) => void
  onRetry: () => void
}

export function ChangedFilesList({
  files,
  loading,
  error,
  emptyState,
  listRef,
  query,
  onQueryChange,
  onOpen,
  onRetry
}: ChangedFilesListProps): React.JSX.Element | null {
  const visible = useMemo(() => (files ? filterChangedFiles(files, query) : []), [files, query])
  const showFilter = (files?.length ?? 0) > FILTER_THRESHOLD

  // ArrowUp/ArrowDown/Home/End move between rows; Enter/Space open (native button)
  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-path]')
    )
    if (rows.length === 0) return
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, current + 1)
            : Math.max(0, current - 1)
    event.preventDefault()
    rows[target]?.focus()
  }

  if (!files) {
    if (error) {
      return (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs"
          data-testid="merge-file-list-error"
        >
          <p className="text-destructive">Couldn&apos;t load the changed files: {error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )
    }
    return (
      <div
        className="flex flex-1 items-center justify-center gap-2 py-8 text-xs text-muted-foreground"
        data-testid="merge-file-list-loading"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading changed files...
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center text-xs text-muted-foreground"
        data-testid="merge-file-list-empty"
      >
        {emptyState}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showFilter && (
        <div className="relative shrink-0 border-b border-border/60 px-2 py-1.5">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter files... (Esc clears)"
            aria-label="Filter changed files"
            className="h-7 pl-7 text-xs"
            data-testid="merge-file-filter"
          />
        </div>
      )}
      <ul
        ref={listRef}
        role="list"
        aria-label="Changed files"
        className="min-h-0 flex-1 overflow-y-auto py-1"
        data-testid="merge-file-list"
        onKeyDown={handleListKeyDown}
      >
        {visible.map((file) => {
          const { name } = splitPath(file.path)
          const meta = CHANGED_FILE_STATUS[file.status]
          return (
            <li key={file.path}>
              <button
                type="button"
                data-path={file.path}
                data-testid="merge-file-row"
                aria-label={`${file.path}, ${meta.label}${
                  file.binary ? '' : `, ${file.additions} additions, ${file.deletions} deletions`
                }`}
                className="flex h-7 w-full items-center gap-2 rounded-sm px-3 text-left text-xs hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                onClick={() => onOpen(file)}
              >
                <ChangedFileStatusBadge status={file.status} />
                <FileIcon
                  name={name}
                  extension={fileExtension(name)}
                  isDirectory={false}
                  className="h-3.5 w-3.5"
                />
                <ChangedFilePath path={file.path} className="flex-1" />
                <ChangedFileCounts file={file} />
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </button>
            </li>
          )
        })}
        {visible.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            No files match &ldquo;{query}&rdquo;.
          </li>
        )}
      </ul>
      {error ? (
        // A failed refresh keeps the last good list on screen
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-1 text-[11px] text-destructive"
          data-testid="merge-file-list-refresh-error"
        >
          <span className="truncate">Couldn&apos;t refresh: {error}</span>
          <button type="button" onClick={onRetry} className="shrink-0 underline">
            Retry
          </button>
        </div>
      ) : (
        loading && (
          <div className="flex shrink-0 items-center gap-1 border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing...
          </div>
        )
      )}
    </div>
  )
}
