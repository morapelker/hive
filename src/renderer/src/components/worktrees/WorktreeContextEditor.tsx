import { useState, useEffect, useCallback } from 'react'
import { FileText, X, Eye, Pencil, Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { toast } from '@/lib/toast'

interface WorktreeContextEditorProps {
  worktreeId: string
}

export function WorktreeContextEditor({
  worktreeId
}: WorktreeContextEditorProps): React.JSX.Element {
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const hasUnsavedChanges = content !== savedContent

  // Load context on mount
  useEffect(() => {
    let cancelled = false

    void (async () => {
      setIsLoading(true)
      try {
        const result = await window.worktreeOps.getContext(worktreeId)
        if (cancelled) return
        const ctx = result.success ? (result.context ?? '') : ''
        setContent(ctx)
        setSavedContent(ctx)
        // Default to edit mode when content is empty
        if (!ctx) {
          setIsEditing(true)
        }
      } catch {
        if (!cancelled) {
          toast.error('Failed to load worktree context')
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [worktreeId])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      const result = await window.worktreeOps.updateContext(
        worktreeId,
        content || null
      )
      if (result.success) {
        setSavedContent(content)
        toast.success('Context saved')
      } else {
        toast.error(result.error || 'Failed to save context')
      }
    } catch {
      toast.error('Failed to save context')
    } finally {
      setIsSaving(false)
    }
  }, [worktreeId, content])

  const handleClose = useCallback(() => {
    useFileViewerStore.getState().closeContextEditor()
  }, [])

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30">
        {/* Left: icon + title + unsaved indicator */}
        <FileText className="h-4 w-4 text-emerald-400 flex-shrink-0" />
        <span className="text-sm font-bold">Worktree Context</span>
        {hasUnsavedChanges && isEditing && (
          <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" title="Unsaved changes" />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Toggle buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant={!isEditing ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => setIsEditing(false)}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview
          </Button>
          <Button
            variant={isEditing ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        </div>

        {/* Close button */}
        <button
          onClick={handleClose}
          className="p-1 rounded hover:bg-accent transition-colors"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        {isEditing ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              'Enter worktree context here. This markdown will be injected into the first prompt of each new AI session.\n\nExample:\n## Feature: User Authentication\n- Working on login/signup flow\n- Backend API at /api/auth\n- Using JWT tokens'
            }
            className="w-full h-full resize-none bg-transparent font-mono text-sm p-4 focus:outline-none"
          />
        ) : content ? (
          <div className="p-4 text-sm">
            <MarkdownRenderer content={content} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground px-8 text-center">
            No worktree context set. Click Edit to add context that will be injected into AI sessions.
          </div>
        )}
      </div>

      {/* Footer with save button — only in edit mode */}
      {isEditing && (
        <div className="flex items-center justify-end px-4 py-2 border-t border-border bg-muted/30">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || !hasUnsavedChanges}
            className="gap-1.5"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save Context
          </Button>
        </div>
      )}
    </div>
  )
}
