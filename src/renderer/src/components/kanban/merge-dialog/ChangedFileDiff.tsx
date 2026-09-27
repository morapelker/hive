import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  AlignJustify,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  FileWarning,
  Loader2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DiffViewer, type DiffViewMode } from '@/components/diff/DiffViewer'
import { ImageDiffView } from '@/components/diff/ImageDiffView'
import { projectApi } from '@/api/project-api'
import { cn } from '@/lib/utils'
import { isImageFile } from '@shared/types/file-utils'
import { ChangedFileCounts, ChangedFilePath, ChangedFileStatusBadge } from './ChangedFilesList'
import {
  changedFileKey,
  isLargeDiff,
  loadChangedFileDiff,
  splitPath,
  MAX_PATCH_BYTES,
  type ChangedFile,
  type ChangedFilesSource
} from './changed-files'

export type DiffCache = Map<string, string>

interface ChangedFileDiffProps {
  source: ChangedFilesSource
  file: ChangedFile
  /** Zero-based position of `file` in the list */
  index: number
  count: number
  viewMode: DiffViewMode
  onViewModeChange: (mode: DiffViewMode) => void
  /** Loaded patches keyed by changedFileKey; owned by the panel */
  cache: MutableRefObject<DiffCache>
  /** Bumped by the panel whenever the file list refreshes, so an open diff refetches */
  version: number
  onBack: () => void
  onPrev: () => void
  onNext: () => void
}

type BodyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ready'; diff: string }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Placeholder({
  title,
  body,
  action,
  role,
  testId
}: {
  title: string
  body: ReactNode
  action?: ReactNode
  role?: string
  testId: string
}): React.JSX.Element {
  return (
    <div
      role={role}
      className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center"
      data-testid={testId}
    >
      <FileWarning className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function ChangedFileDiff({
  source,
  file,
  index,
  count,
  viewMode,
  onViewModeChange,
  cache,
  version,
  onBack,
  onPrev,
  onNext
}: ChangedFileDiffProps): React.JSX.Element {
  const key = changedFileKey(source, file.path)
  const image = isImageFile(file.path)
  const large = isLargeDiff(file)
  const textDiff = !image && !file.binary
  const { name } = splitPath(file.path)

  // Large diffs wait for an explicit click (remembered per file, and a patch
  // already in the cache needs no second consent); everything else loads on entry
  const [loadRequestedFor, setLoadRequestedFor] = useState<string | null>(null)
  const loadRequested = !large || loadRequestedFor === key || cache.current.has(key)
  const [state, setState] = useState<BodyState>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const backRef = useRef<HTMLButtonElement>(null)

  // Entering the diff view focuses Back (Enter/Escape symmetry with the row
  // that opened it); prev/next keep focus where the user left it
  useEffect(() => {
    backRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!textDiff || !loadRequested) {
      setState({ kind: 'idle' })
      return
    }
    const cached = cache.current.get(key)
    if (cached !== undefined) {
      setState({ kind: 'ready', diff: cached })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    loadChangedFileDiff(source, file)
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          cache.current.set(key, result.value)
          setState({ kind: 'ready', diff: result.value })
        } else {
          setState({ kind: 'error', error: result.error })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
    // `file`/`source` are fully described by `key`; `version` forces a refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, textDiff, loadRequested, attempt, version, cache])

  const copyDiff = async (): Promise<void> => {
    if (state.kind !== 'ready') return
    try {
      await projectApi.copyToClipboard(state.diff)
      toast.success('Diff copied to clipboard')
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let body: ReactNode
  if (image) {
    body = (
      <ImageDiffView
        worktreePath={source.worktreePath}
        filePath={file.path}
        fileName={name}
        staged={false}
        isUntracked={file.status === '?'}
        isNewFile={file.status === 'A'}
        compareBranch={source.kind === 'branch' ? source.baseBranch : undefined}
        onClose={onBack}
      />
    )
  } else if (file.binary) {
    body = (
      <Placeholder
        testId="merge-diff-binary"
        title="Binary file"
        body="There is no text diff to show for this file."
      />
    )
  } else if (!loadRequested) {
    body = (
      <Placeholder
        testId="merge-diff-load-large"
        title="Large diff"
        body={`This file has ${(file.additions + file.deletions).toLocaleString()} changed lines. Loading it may be slow.`}
        action={
          <Button variant="outline" size="sm" onClick={() => setLoadRequestedFor(key)}>
            Load diff
          </Button>
        }
      />
    )
  } else if (state.kind === 'loading' || state.kind === 'idle') {
    body = (
      <div
        className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
        data-testid="merge-diff-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading diff...
      </div>
    )
  } else if (state.kind === 'error') {
    body = (
      <Placeholder
        testId="merge-diff-error"
        role="alert"
        title="Couldn't load the diff"
        body={state.error}
        action={
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        }
      />
    )
  } else if (state.diff.length > MAX_PATCH_BYTES) {
    body = (
      <Placeholder
        testId="merge-diff-too-large"
        title="Diff too large to display"
        body={`This patch is about ${formatBytes(state.diff.length)}. Copy it to inspect it elsewhere.`}
        action={
          <Button variant="outline" size="sm" onClick={copyDiff}>
            <Copy className="h-3.5 w-3.5" />
            Copy diff
          </Button>
        }
      />
    )
  } else if (state.diff.trim() === '') {
    body = (
      <Placeholder
        testId="merge-diff-empty"
        title="No diff to show"
        body="Git returned an empty patch for this file."
      />
    )
  } else {
    body = (
      <DiffViewer
        diff={state.diff}
        viewMode={viewMode}
        // The toolbar above already names the file, so drop diff2html's own header
        className="diff-viewer--bare"
      />
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      role="region"
      aria-label={`Diff for ${file.path}`}
      data-testid="merge-diff-view"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-2 py-1.5">
        <Button
          ref={backRef}
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back to file list"
          title="Back (Esc)"
          data-testid="merge-diff-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
        <ChangedFileStatusBadge status={file.status} />
        <ChangedFilePath path={file.path} className="min-w-0 flex-1" />
        <ChangedFileCounts file={file} />
        {textDiff && (
          <>
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <div
              role="group"
              aria-label="Diff layout"
              className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 p-0.5"
            >
              <button
                type="button"
                aria-pressed={viewMode === 'unified'}
                aria-label="Unified view"
                title="Unified view"
                onClick={() => onViewModeChange('unified')}
                className={cn(
                  'rounded-sm p-1 text-muted-foreground hover:text-foreground',
                  viewMode === 'unified' && 'bg-accent text-foreground'
                )}
                data-testid="merge-diff-view-unified"
              >
                <AlignJustify className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'split'}
                aria-label="Split view"
                title="Split view"
                onClick={() => onViewModeChange('split')}
                className={cn(
                  'rounded-sm p-1 text-muted-foreground hover:text-foreground',
                  viewMode === 'split' && 'bg-accent text-foreground'
                )}
                data-testid="merge-diff-view-split"
              >
                <Columns2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
        <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onPrev}
          disabled={index <= 0}
          aria-label="Previous file"
          title="Previous file ([)"
          data-testid="merge-diff-prev"
        >
          <ChevronUp />
        </Button>
        <span
          className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
          data-testid="merge-diff-position"
        >
          {index + 1} / {count}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNext}
          disabled={index >= count - 1}
          aria-label="Next file"
          title="Next file (])"
          data-testid="merge-diff-next"
        >
          <ChevronDown />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="merge-diff-body">
        {body}
      </div>
    </div>
  )
}
