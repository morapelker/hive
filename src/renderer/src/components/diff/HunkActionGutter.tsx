import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Minus, Undo2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useGitStore } from '@/stores/useGitStore'
import type { Hunk } from '@/lib/diff-utils'
import { createHunkPatch } from '@/lib/diff-utils'
import type { editor } from 'monaco-editor'

interface HunkActionGutterProps {
  hunks: Hunk[]
  staged: boolean
  worktreePath: string
  filePath: string
  originalContent: string
  modifiedContent: string
  modifiedEditor: editor.IStandaloneCodeEditor | null
  onContentChanged: () => void
}

interface HunkPosition {
  hunk: Hunk
  top: number
}

export function HunkActionGutter({
  hunks,
  staged,
  worktreePath,
  filePath,
  originalContent,
  modifiedContent,
  modifiedEditor,
  onContentChanged
}: HunkActionGutterProps): React.JSX.Element | null {
  const [positions, setPositions] = useState<HunkPosition[]>([])
  const [loading, setLoading] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const originalLines = originalContent.split('\n')
  const modifiedLines = modifiedContent.split('\n')

  // Calculate hunk positions based on Monaco editor's line positions
  const updatePositions = useCallback(() => {
    if (!modifiedEditor) return

    const newPositions: HunkPosition[] = hunks.map((hunk) => {
      // For additions and modifications, use modified side line number
      // For deletions, use the modified side anchor point
      const lineNumber =
        hunk.type === 'delete'
          ? Math.max(1, hunk.modifiedStartLine || 1)
          : hunk.modifiedStartLine

      const top = modifiedEditor.getTopForLineNumber(lineNumber)
      const scrollTop = modifiedEditor.getScrollTop()

      return {
        hunk,
        top: top - scrollTop
      }
    })

    setPositions(newPositions)
  }, [modifiedEditor, hunks])

  // Update positions on scroll and layout changes
  useEffect(() => {
    if (!modifiedEditor) return

    const disposables = [
      modifiedEditor.onDidScrollChange(() => updatePositions()),
      modifiedEditor.onDidLayoutChange(() => updatePositions())
    ]

    // Initial position calculation
    updatePositions()

    return () => disposables.forEach((d) => d.dispose())
  }, [modifiedEditor, updatePositions])

  // Recalculate when hunks change
  useEffect(() => {
    updatePositions()
  }, [hunks, updatePositions])

  const handleStageHunk = useCallback(
    async (hunk: Hunk) => {
      setLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await window.gitOps.stageHunk(worktreePath, patch)
        if (result.success) {
          toast.success('Hunk staged')
          useGitStore.getState().refreshStatuses(worktreePath)
          onContentChanged()
        } else {
          toast.error(result.error || 'Failed to stage hunk')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to stage hunk')
      } finally {
        setLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, onContentChanged]
  )

  const handleUnstageHunk = useCallback(
    async (hunk: Hunk) => {
      setLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await window.gitOps.unstageHunk(worktreePath, patch)
        if (result.success) {
          toast.success('Hunk unstaged')
          useGitStore.getState().refreshStatuses(worktreePath)
          onContentChanged()
        } else {
          toast.error(result.error || 'Failed to unstage hunk')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to unstage hunk')
      } finally {
        setLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, onContentChanged]
  )

  const handleRevertHunk = useCallback(
    async (hunk: Hunk) => {
      setLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await window.gitOps.revertHunk(worktreePath, patch)
        if (result.success) {
          toast.success('Hunk reverted')
          useGitStore.getState().refreshStatuses(worktreePath)
          onContentChanged()
        } else {
          toast.error(result.error || 'Failed to revert hunk')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to revert hunk')
      } finally {
        setLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, onContentChanged]
  )

  if (!modifiedEditor || hunks.length === 0) return null

  return (
    <div
      ref={containerRef}
      className="absolute right-2 top-0 bottom-0 z-10 pointer-events-none"
      style={{ width: 32 }}
    >
      {positions.map(({ hunk, top }) => (
        <div
          key={hunk.index}
          className="absolute pointer-events-auto flex flex-col gap-0.5"
          style={{ top: top, right: 0 }}
        >
          {staged ? (
            // Staged diff: show Unstage button
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 bg-orange-500/20 hover:bg-orange-500/40 border border-orange-500/30"
              onClick={() => handleUnstageHunk(hunk)}
              disabled={loading === hunk.index}
              title="Unstage this change"
            >
              <Minus className="h-3 w-3 text-orange-400" />
            </Button>
          ) : (
            // Unstaged diff: show Stage + Revert buttons
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 bg-green-500/20 hover:bg-green-500/40 border border-green-500/30"
                onClick={() => handleStageHunk(hunk)}
                disabled={loading === hunk.index}
                title="Stage this change"
              >
                <Plus className="h-3 w-3 text-green-400" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 bg-red-500/20 hover:bg-red-500/40 border border-red-500/30"
                onClick={() => handleRevertHunk(hunk)}
                disabled={loading === hunk.index}
                title="Revert this change"
              >
                <Undo2 className="h-3 w-3 text-red-400" />
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
