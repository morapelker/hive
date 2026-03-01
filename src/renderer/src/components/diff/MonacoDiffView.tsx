import { useState, useEffect, useCallback, useRef } from 'react'
import '@/lib/monaco-setup'
import { DiffEditor, type Monaco } from '@monaco-editor/react'
import { Loader2 } from 'lucide-react'
import { registerHiveTheme, HIVE_THEME_NAME } from '@/lib/monaco-theme'
import { parseHunks, getMonacoLanguage } from '@/lib/diff-utils'
import type { Hunk } from '@/lib/diff-utils'
import { MonacoDiffToolbar } from './MonacoDiffToolbar'
import { HunkActionGutter } from './HunkActionGutter'
import type { editor } from 'monaco-editor'

interface MonacoDiffViewProps {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
  compareBranch?: string
  onClose: () => void
}

export default function MonacoDiffView({
  worktreePath,
  filePath,
  fileName,
  staged,
  isUntracked,
  compareBranch,
  onClose
}: MonacoDiffViewProps): React.JSX.Element {
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [modifiedContent, setModifiedContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [hunks, setHunks] = useState<Hunk[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const isInitialLoad = useRef(true)
  const recentActionRef = useRef(false)

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const modifiedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  // Fetch file contents for the diff
  const fetchContent = useCallback(async () => {
    // Only show loading spinner on initial mount, not on refresh
    if (isInitialLoad.current) {
      setIsLoading(true)
    }
    setError(null)

    try {
      if (compareBranch) {
        // Branch diff: original = branch ref, modified = working tree
        const [origResult, modResult] = await Promise.all([
          window.gitOps.getRefContent(worktreePath, compareBranch, filePath),
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
          window.gitOps.getRefContent(worktreePath, '', filePath).catch(() =>
            window.gitOps.getRefContent(worktreePath, 'HEAD', filePath)
          ),
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
  }, [worktreePath, filePath, staged, compareBranch])

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
  const handleEditorDidMount = useCallback(
    (editor: editor.IStandaloneDiffEditor) => {
      diffEditorRef.current = editor
      modifiedEditorRef.current = editor.getModifiedEditor()

      // Get initial diff changes
      const changes = editor.getLineChanges()
      setHunks(parseHunks(changes))

      // Listen for diff updates
      editor.onDidUpdateDiff(() => {
        const newChanges = editor.getLineChanges()
        setHunks(parseHunks(newChanges))
      })
    },
    []
  )

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
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
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
      </div>
    </div>
  )
}
