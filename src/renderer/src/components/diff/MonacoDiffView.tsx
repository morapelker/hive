import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import '@/lib/monaco-setup'
import { DiffEditor, type Monaco } from '@monaco-editor/react'
import { Loader2 } from 'lucide-react'
import { registerHiveTheme, HIVE_THEME_NAME } from '@/lib/monaco-theme'
import { parseHunks, getMonacoLanguage } from '@/lib/diff-utils'
import type { Hunk } from '@/lib/diff-utils'
import { MonacoDiffToolbar } from './MonacoDiffToolbar'
import { HunkActionGutter } from './HunkActionGutter'
import { PrCommentGutter } from './PrCommentGutter'
import { DiffCommentGutter } from './DiffCommentGutter'
import { DiffCommentToolbar } from './DiffCommentToolbar'
import { DiffCommentSidePanel } from './DiffCommentSidePanel'
import { usePRReviewStore } from '@/stores/usePRReviewStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
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

const EMPTY_COMMENTS: PRReviewComment[] = []

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
  // PR review diffs always use inline mode so view zones render naturally
  const [sideBySide, setSideBySide] = useState(!prReviewWorktreeId)
  const [hunks, setHunks] = useState<Hunk[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const isInitialLoad = useRef(true)
  const recentActionRef = useRef(false)

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const modifiedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [zonesReady, setZonesReady] = useState(!prReviewWorktreeId)

  // Worktree ID for diff comment toolbar
  const worktreeId = useWorktreeStore((s) => s.selectedWorktreeId)

  const [sidePanelOpen, setSidePanelOpen] = useState(false)

  const handleToggleSidePanel = useCallback(() => {
    setSidePanelOpen(prev => !prev)
  }, [])

  // PR review comments for this file (when in PR review mode)
  const allPrComments = usePRReviewStore(
    (s) => (prReviewWorktreeId ? s.comments.get(prReviewWorktreeId) : undefined) ?? EMPTY_COMMENTS
  )
  const fileComments = useMemo(
    () =>
      prReviewWorktreeId
        ? allPrComments.filter((c) => c.path === filePath)
        : EMPTY_COMMENTS,
    [allPrComments, filePath, prReviewWorktreeId]
  )

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
        const modResult = await window.gitOps.getFileContent(worktreePath, filePath)
        setOriginalContent('')
        setModifiedContent(modResult.success ? (modResult.content ?? '') : '')
        return
      }

      if (compareBranch) {
        // Branch diff: original = merge-base content, modified = working tree.
        // Uses merge-base so only changes from commits ahead of the target branch
        // are shown (not changes introduced on the target after divergence).
        const [origResult, modResult] = await Promise.all([
          window.gitOps.getBranchBaseContent(worktreePath, compareBranch, filePath),
          window.gitOps.getFileContent(worktreePath, filePath)
        ])

        // File added (doesn't exist in branch) — empty original
        setOriginalContent(origResult.success ? (origResult.content ?? '') : '')
        // File deleted (doesn't exist in working tree) — empty modified
        setModifiedContent(modResult.success ? (modResult.content ?? '') : '')
      } else if (staged) {
        // Staged diff: original = HEAD, modified = Index (staged)
        const [origResult, modResult] = await Promise.all([
          window.gitOps.getRefContent(worktreePath, 'HEAD', filePath),
          window.gitOps.getRefContent(worktreePath, '', filePath)
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
          window.gitOps
            .getRefContent(worktreePath, '', filePath)
            .catch(() => window.gitOps.getRefContent(worktreePath, 'HEAD', filePath)),
          window.gitOps.getFileContent(worktreePath, filePath)
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

  // Listen for external file changes (but skip if we just did a manual action)
  useEffect(() => {
    const cleanup = window.gitOps.onStatusChanged((event) => {
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

    // Listen for diff updates
    diffEd.onDidUpdateDiff(() => {
      const newChanges = diffEd.getLineChanges()
      setHunks(parseHunks(newChanges))
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

  // Toggle side-by-side / inline
  const handleToggleSideBySide = useCallback(() => {
    setSideBySide((prev) => !prev)
  }, [])

  // Copy diff content
  const handleCopy = useCallback(async () => {
    if (compareBranch) {
      const result = await window.gitOps.getBranchFileDiff(worktreePath, compareBranch, filePath)
      if (result.success && result.diff) {
        await window.projectOps.copyToClipboard(result.diff)
      }
    } else {
      // Get the unified diff via existing IPC
      const result = await window.gitOps.getDiff(worktreePath, filePath, staged, isUntracked)
      if (result.success && result.diff) {
        await window.projectOps.copyToClipboard(result.diff)
      }
    }
  }, [worktreePath, filePath, staged, isUntracked, compareBranch])

  // Trigger re-fetch after hunk actions — suppress watcher duplicate for 500ms
  const handleContentChanged = useCallback(() => {
    recentActionRef.current = true
    setRefreshKey((k) => k + 1)
    setTimeout(() => {
      recentActionRef.current = false
    }, 500)
  }, [])

  const language = getMonacoLanguage(filePath)

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col min-h-0" data-testid="monaco-diff-view">
        <MonacoDiffToolbar
          fileName={fileName}
          staged={staged}
          isUntracked={isUntracked}
          compareBranch={compareBranch}
          sideBySide={sideBySide}
          onToggleSideBySide={handleToggleSideBySide}
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
          sideBySide={sideBySide}
          onToggleSideBySide={handleToggleSideBySide}
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
        sideBySide={sideBySide}
        onToggleSideBySide={handleToggleSideBySide}
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
              renderSideBySide: sideBySide,
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
          {!compareBranch && originalContent !== null && modifiedContent !== null && (
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
            <DiffCommentGutter
              modifiedEditor={modifiedEditorRef.current}
              filePath={filePath}
            />
          )}
          {!prReviewWorktreeId && originalContent !== null && modifiedContent !== null && worktreeId && (
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
