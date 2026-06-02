import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import '@/lib/monaco-setup'
import { DiffEditor, type Monaco } from '@monaco-editor/react'
import { Loader2 } from 'lucide-react'
import { registerHiveTheme, HIVE_THEME_NAME } from '@/lib/monaco-theme'
import {
  computeHiddenAreas,
  createHunkPatch,
  parseHunks,
  getMonacoLanguage
} from '@/lib/diff-utils'
import type { HiddenAreasResult, Hunk } from '@/lib/diff-utils'
import { MonacoDiffToolbar } from './MonacoDiffToolbar'
import { HunkActionGutter } from './HunkActionGutter'
import type { HunkHeaderActions } from './HunkViewDecorations'
import { HunkViewDecorations } from './HunkViewDecorations'
import { PrCommentGutter } from './PrCommentGutter'
import { DiffCommentGutter } from './DiffCommentGutter'
import { DiffCommentToolbar } from './DiffCommentToolbar'
import { DiffCommentSidePanel } from './DiffCommentSidePanel'
import { usePRReviewStore } from '@/stores/usePRReviewStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'
import { useDiffPrefsStore } from '@/stores/useDiffPrefsStore'
import { useGitStore } from '@/stores/useGitStore'
import { toast } from '@/lib/toast'
import { gitApi } from '@/api/git-api'
import { projectApi } from '@/api/project-api'
import type { PRReviewComment } from '@shared/types/git'
import type { editor } from 'monaco-editor'

interface MonacoDiffViewProps {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
  compareBranch?: string
  scrollToLine?: number
  scrollTrigger?: number
  prReviewWorktreeId?: string
  onClose: () => void
}

interface HiddenAreasEditor extends editor.IStandaloneCodeEditor {
  setHiddenAreas?: (ranges: HiddenAreasResult['modifiedRanges']) => void
}

const EMPTY_COMMENTS: PRReviewComment[] = []
const EMPTY_DIFF_COMMENTS: DiffComment[] = []
const HUNK_CONTEXT_LINES = 3
const HUNK_EXPAND_LINES = 10
const EMPTY_HIDDEN_AREAS: HiddenAreasResult = {
  originalRanges: [],
  modifiedRanges: [],
  gaps: []
}

export default function MonacoDiffView({
  worktreePath,
  filePath,
  fileName,
  staged,
  isUntracked,
  isNewFile,
  compareBranch,
  scrollToLine,
  scrollTrigger,
  prReviewWorktreeId,
  onClose
}: MonacoDiffViewProps): React.JSX.Element {
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [modifiedContent, setModifiedContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hunks, setHunks] = useState<Hunk[]>([])
  const [expandedRanges, setExpandedRanges] = useState<Array<{ start: number; end: number }>>([])
  const [hunkActionLoading, setHunkActionLoading] = useState<number | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const isInitialLoad = useRef(true)
  const recentActionRef = useRef(false)

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const modifiedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [diffComputed, setDiffComputed] = useState(false)
  const [zonesReady, setZonesReady] = useState(!prReviewWorktreeId)

  // Worktree ID for diff comment toolbar
  const worktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const viewMode = useDiffPrefsStore((s) => s.viewMode)
  const setViewMode = useDiffPrefsStore((s) => s.setViewMode)

  const [sidePanelOpen, setSidePanelOpen] = useState(false)

  const handleToggleSidePanel = useCallback(() => {
    setSidePanelOpen((prev) => !prev)
  }, [])

  // PR review comments for this file (when in PR review mode)
  const allPrComments = usePRReviewStore(
    (s) => (prReviewWorktreeId ? s.comments.get(prReviewWorktreeId) : undefined) ?? EMPTY_COMMENTS
  )
  const fileComments = useMemo(
    () => (prReviewWorktreeId ? allPrComments.filter((c) => c.path === filePath) : EMPTY_COMMENTS),
    [allPrComments, filePath, prReviewWorktreeId]
  )
  const allDiffComments =
    useDiffCommentStore((s) =>
      !prReviewWorktreeId && worktreeId ? s.comments.get(worktreeId) : undefined
    ) ?? EMPTY_DIFF_COMMENTS
  const fileDiffComments = useMemo(
    () =>
      !prReviewWorktreeId && worktreeId
        ? allDiffComments.filter((c) => c.file_path === filePath)
        : EMPTY_DIFF_COMMENTS,
    [allDiffComments, filePath, prReviewWorktreeId, worktreeId]
  )

  const effectiveViewMode = prReviewWorktreeId && viewMode === 'split' ? 'inline' : viewMode
  const fallsBackToInline =
    effectiveViewMode === 'hunk' &&
    (isUntracked || isNewFile || originalContent === '' || modifiedContent === '')
  const renderedViewMode = fallsBackToInline ? 'inline' : effectiveViewMode

  // Fetch file contents for the diff
  const fetchContent = useCallback(async () => {
    // Only show loading spinner on initial mount, not on refresh
    if (isInitialLoad.current) {
      setIsLoading(true)
    }
    setError(null)

    try {
      if (isNewFile || isUntracked) {
        // Untracked/new files have no git history – read from disk
        const modResult = await gitApi.getFileContent(worktreePath, filePath)
        setOriginalContent('')
        setModifiedContent(modResult.success ? (modResult.content ?? '') : '')
        return
      }

      if (compareBranch) {
        // Branch diff: original = merge-base content, modified = working tree.
        // Uses merge-base so only changes from commits ahead of the target branch
        // are shown (not changes introduced on the target after divergence).
        const [origResult, modResult] = await Promise.all([
          gitApi.getBranchBaseContent(worktreePath, compareBranch, filePath),
          gitApi.getFileContent(worktreePath, filePath)
        ])

        // File added (doesn't exist in branch) — empty original
        setOriginalContent(origResult.success ? (origResult.content ?? '') : '')
        // File deleted (doesn't exist in working tree) — empty modified
        setModifiedContent(modResult.success ? (modResult.content ?? '') : '')
      } else if (staged) {
        // Staged diff: original = HEAD, modified = Index (staged)
        const [origResult, modResult] = await Promise.all([
          gitApi.getRefContent(worktreePath, 'HEAD', filePath),
          gitApi.getRefContent(worktreePath, '', filePath)
        ])

        if (!origResult.success && !origResult.error?.includes('does not exist')) {
          setError(origResult.error || 'Failed to load HEAD version')
          return
        }
        if (!modResult.success) {
          setError(modResult.error || 'Failed to load staged version')
          return
        }

        setOriginalContent(origResult.content ?? '')
        setModifiedContent(modResult.content ?? '')
      } else {
        // Unstaged diff: original = Index (or HEAD if nothing staged), modified = Working tree
        const [origResult, modResult] = await Promise.all([
          gitApi
            .getRefContent(worktreePath, '', filePath)
            .catch(() => gitApi.getRefContent(worktreePath, 'HEAD', filePath)),
          gitApi.getFileContent(worktreePath, filePath)
        ])

        if (!origResult.success && !origResult.error?.includes('does not exist')) {
          setError(origResult.error || 'Failed to load original version')
          return
        }
        if (!modResult.success) {
          setError(modResult.error || 'Failed to load file content')
          return
        }

        setOriginalContent(origResult.content ?? '')
        setModifiedContent(modResult.content ?? '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff content')
    } finally {
      setIsLoading(false)
      isInitialLoad.current = false
    }
  }, [worktreePath, filePath, staged, isNewFile, isUntracked, compareBranch])

  // Fetch on mount and when refresh is triggered
  useEffect(() => {
    fetchContent()
  }, [fetchContent, refreshKey])

  useEffect(() => {
    setExpandedRanges([])
    setDiffComputed(false)
  }, [worktreePath, filePath, staged, compareBranch])

  // Listen for external file changes (but skip if we just did a manual action)
  useEffect(() => {
    const cleanup = gitApi.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath && !recentActionRef.current) {
        setRefreshKey((k) => k + 1)
      }
    })
    return cleanup
  }, [worktreePath])

  // Handle Monaco mount
  const handleEditorDidMount = useCallback((diffEd: editor.IStandaloneDiffEditor) => {
    diffEditorRef.current = diffEd
    modifiedEditorRef.current = diffEd.getModifiedEditor()

    // Get initial diff changes
    const changes = diffEd.getLineChanges()
    setHunks(parseHunks(changes))
    if (changes !== null) {
      setDiffComputed(true)
    }

    // Listen for diff updates
    diffEd.onDidUpdateDiff(() => {
      const newChanges = diffEd.getLineChanges()
      setHunks(parseHunks(newChanges))
      setDiffComputed(true)
    })

    // Signal that the editor is mounted and ready for scrolling
    setEditorReady(true)
  }, [])

  // Auto-scroll to the target line (e.g. when navigating from a PR comment).
  // Waits for: editor mounted (editorReady), content loaded (!isLoading),
  // and view zones created + sized (zonesReady — signalled by PrCommentGutter).
  // scrollTrigger changes on every navigation so re-clicking the same comment
  // (same scrollToLine value) still triggers a scroll.
  useEffect(() => {
    if (!scrollToLine || !editorReady || isLoading || !zonesReady) return
    const modEditor = modifiedEditorRef.current
    if (!modEditor) return

    modEditor.revealLineInCenter(scrollToLine)
    modEditor.setPosition({ lineNumber: scrollToLine, column: 1 })
  }, [scrollToLine, scrollTrigger, editorReady, isLoading, zonesReady])

  // Register theme before Monaco loads
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    registerHiveTheme(monaco)
  }, [])

  // Hunk navigation — scroll to next/prev hunk in the modified editor
  const handleNextHunk = useCallback(() => {
    const modEditor = modifiedEditorRef.current
    if (!modEditor || hunks.length === 0) return
    const currentLine = modEditor.getPosition()?.lineNumber ?? 0
    const next = hunks.find((h) => h.modifiedStartLine > currentLine)
    const target = next ?? hunks[0] // wrap around
    modEditor.revealLineInCenter(target.modifiedStartLine)
    modEditor.setPosition({ lineNumber: target.modifiedStartLine, column: 1 })
  }, [hunks])

  const handlePrevHunk = useCallback(() => {
    const modEditor = modifiedEditorRef.current
    if (!modEditor || hunks.length === 0) return
    const currentLine = modEditor.getPosition()?.lineNumber ?? Infinity
    const prev = [...hunks].reverse().find((h) => h.modifiedStartLine < currentLine)
    const target = prev ?? hunks[hunks.length - 1] // wrap around
    modEditor.revealLineInCenter(target.modifiedStartLine)
    modEditor.setPosition({ lineNumber: target.modifiedStartLine, column: 1 })
  }, [hunks])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        handleNextHunk()
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        handlePrevHunk()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, handleNextHunk, handlePrevHunk])

  const prCommentLines = useMemo(
    () =>
      fileComments
        .map((comment) => comment.line ?? comment.originalLine ?? null)
        .filter((line): line is number => typeof line === 'number' && line > 0),
    [fileComments]
  )

  const diffCommentLines = useMemo(
    () =>
      fileDiffComments.flatMap((comment) => expandLineRange(comment.line_start, comment.line_end)),
    [fileDiffComments]
  )

  const expandedLineNumbers = useMemo(
    () => expandedRanges.flatMap((range) => expandLineRange(range.start, range.end)),
    [expandedRanges]
  )
  const originalLines = useMemo(() => (originalContent ?? '').split('\n'), [originalContent])
  const modifiedLines = useMemo(() => (modifiedContent ?? '').split('\n'), [modifiedContent])

  const hiddenAreas = useMemo<HiddenAreasResult>(() => {
    if (renderedViewMode !== 'hunk' || !editorReady) return EMPTY_HIDDEN_AREAS
    const originalLineCount =
      diffEditorRef.current?.getOriginalEditor().getModel()?.getLineCount() ??
      getContentLineCount(originalContent)
    const modifiedLineCount =
      modifiedEditorRef.current?.getModel()?.getLineCount() ?? getContentLineCount(modifiedContent)

    return computeHiddenAreas({
      hunks,
      contextLines: HUNK_CONTEXT_LINES,
      originalLineCount,
      modifiedLineCount,
      extraVisibleModified: [...prCommentLines, ...diffCommentLines, ...expandedLineNumbers]
    })
  }, [
    renderedViewMode,
    hunks,
    prCommentLines,
    diffCommentLines,
    expandedLineNumbers,
    originalContent,
    modifiedContent,
    editorReady
  ])

  useEffect(() => {
    const originalEditor = diffEditorRef.current?.getOriginalEditor()
    const modifiedEditor = modifiedEditorRef.current
    if (!originalEditor || !modifiedEditor) return

    setEditorHiddenAreas(
      originalEditor,
      renderedViewMode === 'hunk' ? hiddenAreas.originalRanges : []
    )
    setEditorHiddenAreas(
      modifiedEditor,
      renderedViewMode === 'hunk' ? hiddenAreas.modifiedRanges : []
    )
  }, [hiddenAreas, renderedViewMode, editorReady])

  const handleExpandGap = useCallback(
    (gapIndex: number, direction: 'up' | 'down' | 'all') => {
      const gap = hiddenAreas.gaps[gapIndex]
      if (!gap) return

      let start = gap.firstHiddenModified
      let end = gap.lastHiddenModified
      if (direction === 'up') {
        end = Math.min(gap.lastHiddenModified, gap.firstHiddenModified + HUNK_EXPAND_LINES - 1)
      } else if (direction === 'down') {
        start = Math.max(gap.firstHiddenModified, gap.lastHiddenModified - HUNK_EXPAND_LINES + 1)
      }

      setExpandedRanges((prev) => [...prev, { start, end }])
    },
    [hiddenAreas.gaps]
  )

  // Trigger re-fetch after hunk actions — suppress watcher duplicate for 500ms
  const handleContentChanged = useCallback(() => {
    recentActionRef.current = true
    setRefreshKey((k) => k + 1)
    setTimeout(() => {
      recentActionRef.current = false
    }, 500)
  }, [])

  const handleStageHunk = useCallback(
    async (hunk: Hunk) => {
      setHunkActionLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await gitApi.stageHunk(worktreePath, patch)
        if (result.success) {
          toast.success('Hunk staged')
          useGitStore.getState().refreshStatuses(worktreePath)
          handleContentChanged()
        } else {
          toast.error(result.error || 'Failed to stage hunk')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to stage hunk')
      } finally {
        setHunkActionLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, handleContentChanged]
  )

  const handleUnstageHunk = useCallback(
    async (hunk: Hunk) => {
      setHunkActionLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await gitApi.unstageHunk(worktreePath, patch)
        if (result.success) {
          toast.success('Hunk unstaged')
          useGitStore.getState().refreshStatuses(worktreePath)
          handleContentChanged()
        } else {
          toast.error(result.error || 'Failed to unstage hunk')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to unstage hunk')
      } finally {
        setHunkActionLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, handleContentChanged]
  )

  const handleDiscardHunk = useCallback(
    async (hunk: Hunk) => {
      setHunkActionLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await gitApi.revertHunk(worktreePath, patch)
        if (result.success) {
          toast.success('Hunk discarded')
          useGitStore.getState().refreshStatuses(worktreePath)
          handleContentChanged()
        } else {
          toast.error(result.error || 'Failed to discard hunk')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to discard hunk')
      } finally {
        setHunkActionLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, handleContentChanged]
  )

  const hunkHeaderActions = useMemo<HunkHeaderActions | undefined>(() => {
    if (compareBranch || originalContent === null || modifiedContent === null) return undefined
    return {
      staged,
      loadingHunkIndex: hunkActionLoading,
      onStage: handleStageHunk,
      onUnstage: handleUnstageHunk,
      onDiscard: handleDiscardHunk
    }
  }, [
    compareBranch,
    originalContent,
    modifiedContent,
    staged,
    hunkActionLoading,
    handleStageHunk,
    handleUnstageHunk,
    handleDiscardHunk
  ])

  // Copy diff content
  const handleCopy = useCallback(async () => {
    if (compareBranch) {
      const result = await gitApi.getBranchFileDiff(worktreePath, compareBranch, filePath)
      if (result.success && result.diff) {
        await projectApi.copyToClipboard(result.diff)
      }
    } else {
      const result = await gitApi.getDiff(worktreePath, filePath, staged, isUntracked)
      if (result.success && result.diff) {
        await projectApi.copyToClipboard(result.diff)
      }
    }
  }, [worktreePath, filePath, staged, isUntracked, compareBranch])

  const language = getMonacoLanguage(filePath)
  const isNoChangesInHunkView = renderedViewMode === 'hunk' && hunks.length === 0 && diffComputed

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col min-h-0" data-testid="monaco-diff-view">
        <MonacoDiffToolbar
          fileName={fileName}
          staged={staged}
          isUntracked={isUntracked}
          compareBranch={compareBranch}
          viewMode={renderedViewMode}
          onSetViewMode={setViewMode}
          splitDisabled={Boolean(prReviewWorktreeId)}
          onPrevHunk={handlePrevHunk}
          onNextHunk={handleNextHunk}
          onCopy={handleCopy}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center" data-testid="monaco-diff-loading">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col min-h-0" data-testid="monaco-diff-view">
        <MonacoDiffToolbar
          fileName={fileName}
          staged={staged}
          isUntracked={isUntracked}
          compareBranch={compareBranch}
          viewMode={renderedViewMode}
          onSetViewMode={setViewMode}
          splitDisabled={Boolean(prReviewWorktreeId)}
          onPrevHunk={handlePrevHunk}
          onNextHunk={handleNextHunk}
          onCopy={handleCopy}
          onClose={onClose}
        />
        <div
          className="flex-1 flex items-center justify-center text-destructive"
          data-testid="monaco-diff-error"
        >
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="monaco-diff-view">
      <MonacoDiffToolbar
        fileName={fileName}
        staged={staged}
        isUntracked={isUntracked}
        compareBranch={compareBranch}
        viewMode={renderedViewMode}
        onSetViewMode={setViewMode}
        splitDisabled={Boolean(prReviewWorktreeId)}
        onPrevHunk={handlePrevHunk}
        onNextHunk={handleNextHunk}
        onCopy={handleCopy}
        onClose={onClose}
      />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 relative min-h-0">
          <DiffEditor
            original={originalContent ?? ''}
            modified={modifiedContent ?? ''}
            language={language}
            theme={HIVE_THEME_NAME}
            onMount={handleEditorDidMount}
            beforeMount={handleBeforeMount}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: renderedViewMode === 'split',
              enableSplitViewResizing: true,
              ignoreTrimWhitespace: false,
              renderIndicators: true,
              renderMarginRevertIcon: false,
              diffAlgorithm: 'advanced',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineHeight: 20,
              fontFamily: 'var(--font-mono)',
              automaticLayout: true,
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10
              }
            }}
            loading={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          />
          <HunkViewDecorations
            modifiedEditor={modifiedEditorRef.current}
            hunks={hunks}
            gaps={hiddenAreas.gaps}
            contextLines={HUNK_CONTEXT_LINES}
            enabled={renderedViewMode === 'hunk'}
            onExpand={handleExpandGap}
            hunkActions={hunkHeaderActions}
          />
          {!compareBranch &&
            renderedViewMode !== 'hunk' &&
            originalContent !== null &&
            modifiedContent !== null && (
              <HunkActionGutter
                hunks={hunks}
                staged={staged}
                worktreePath={worktreePath}
                filePath={filePath}
                originalContent={originalContent}
                modifiedContent={modifiedContent}
                modifiedEditor={modifiedEditorRef.current}
                onContentChanged={handleContentChanged}
              />
            )}
          {prReviewWorktreeId &&
            fileComments.length > 0 &&
            originalContent !== null &&
            modifiedContent !== null && (
              <PrCommentGutter
                comments={fileComments}
                modifiedEditor={modifiedEditorRef.current}
                highlightLine={scrollToLine}
                onZonesReady={() => setZonesReady(true)}
              />
            )}
          {!prReviewWorktreeId && originalContent !== null && modifiedContent !== null && (
            <DiffCommentGutter modifiedEditor={modifiedEditorRef.current} filePath={filePath} />
          )}
          {isNoChangesInHunkView && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-sm text-muted-foreground">
              No changes
            </div>
          )}
          {!prReviewWorktreeId &&
            originalContent !== null &&
            modifiedContent !== null &&
            worktreeId && (
              <DiffCommentToolbar
                worktreeId={worktreeId}
                onToggleSidePanel={handleToggleSidePanel}
                sidePanelOpen={sidePanelOpen}
              />
            )}
        </div>
        {!prReviewWorktreeId && sidePanelOpen && worktreeId && (
          <DiffCommentSidePanel
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            onClose={() => setSidePanelOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

function getContentLineCount(content: string | null): number {
  if (!content) return 0
  return content.split('\n').length
}

function expandLineRange(start: number, end?: number | null): number[] {
  const safeStart = Math.max(1, start)
  const safeEnd = Math.max(safeStart, end ?? safeStart)
  return Array.from({ length: safeEnd - safeStart + 1 }, (_, index) => safeStart + index)
}

function setEditorHiddenAreas(
  editorInstance: editor.IStandaloneCodeEditor,
  ranges: HiddenAreasResult['modifiedRanges']
): void {
  const hiddenAreasEditor = editorInstance as HiddenAreasEditor
  if (typeof hiddenAreasEditor.setHiddenAreas !== 'function') {
    console.warn(
      'Monaco editor setHiddenAreas API is unavailable; hunk view cannot collapse lines.'
    )
    return
  }

  hiddenAreasEditor.setHiddenAreas(ranges)
}
