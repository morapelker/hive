import { AutoReviewPreference } from './AutoReviewPreference'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { autoReviewTaskKey } from '@/lib/auto-review'
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Eye, EyeOff, Send } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TicketDescriptionTextarea } from './TicketDescriptionTextarea'
import { isInlineSuggestionTarget } from '@/lib/inline-suggestion'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore, useProjectStore } from '@/stores'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { TicketAttachmentEditor, MAX_ATTACHMENTS } from './TicketAttachmentEditor'
import { TicketDiscardChangesDialog } from './TicketDiscardChangesDialog'
import type { TicketAttachment } from './TicketAttachmentEditor'
import type { KanbanTicket } from '../../../../main/db/types'
import { useImagePaste } from '@/hooks/useImagePaste'
import { attachmentApi } from '@/api/attachment-api'
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import { submitShortcutLabel } from '@/lib/shortcut-labels'
import { quickLaunchTicket, quickLaunchTicketOnConnection } from './WorktreePickerModal'

interface TicketCreateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  connectionId?: string
  isPinnedMode?: boolean
}

// ── Component ───────────────────────────────────────────────────────
export function TicketCreateModal({
  open,
  onOpenChange,
  projectId,
  connectionId,
  isPinnedMode
}: TicketCreateModalProps) {
  const [autoReview, setAutoReview] = useState<boolean | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [attachments, setAttachments] = useState<TicketAttachment[]>([])
  // Which submit is in flight — 'send' also launches the ticket right after
  // creating it (right-button drag defaults: new worktree, build mode,
  // default SDK/model — or a connection session on connection boards).
  const [creatingAction, setCreatingAction] = useState<'create' | 'send' | null>(null)
  const isCreating = creatingAction !== null
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  const titleInputRef = useRef<HTMLInputElement>(null)
  const createdSuccessfully = useRef(false)
  const createTicket = useKanbanStore((state) => state.createTicket)

  const isConnectionMode = !!connectionId
  const connections = useConnectionStore((state) => state.connections)
  const connectionProjects = useMemo(() => {
    if (!connectionId) return []
    const connection = connections.find((c) => c.id === connectionId)
    if (!connection) return []
    const seen = new Set<string>()
    return connection.members.reduce<{ id: string; name: string }[]>((acc, m) => {
      if (!seen.has(m.project_id)) {
        seen.add(m.project_id)
        acc.push({ id: m.project_id, name: m.project_name })
      }
      return acc
    }, [])
  }, [connectionId, connections])

  const pinnedProjectIds = usePinnedStore((s) => s.pinnedProjectIds)
  const allProjects = useProjectStore((s) => s.projects)
  const pinnedProjects = useMemo(() => {
    if (!isPinnedMode) return []
    return [...pinnedProjectIds]
      .map((pid) => {
        const project = allProjects.find((p) => p.id === pid)
        return project ? { id: pid, name: project.name } : null
      })
      .filter((p): p is { id: string; name: string } => p !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [isPinnedMode, pinnedProjectIds, allProjects])

  const isMultiProjectMode = isConnectionMode || !!isPinnedMode
  const availableProjects = isConnectionMode ? connectionProjects : pinnedProjects
  // Pinned board: default to the project used for the last created ticket (if still pinned)
  const pinnedBoardLastCreateProjectId = useKanbanStore((s) => s.pinnedBoardLastCreateProjectId)
  const setPinnedBoardLastCreateProjectId = useKanbanStore(
    (s) => s.setPinnedBoardLastCreateProjectId
  )
  const initialSelectedProjectId = useMemo(() => {
    if (
      isPinnedMode &&
      pinnedBoardLastCreateProjectId &&
      availableProjects.some((p) => p.id === pinnedBoardLastCreateProjectId)
    ) {
      return pinnedBoardLastCreateProjectId
    }
    return availableProjects[0]?.id ?? ''
  }, [isPinnedMode, pinnedBoardLastCreateProjectId, availableProjects])
  const isDirty =
    title.trim().length > 0 ||
    description.trim().length > 0 ||
    attachments.length > 0 ||
    autoReview !== undefined ||
    (isMultiProjectMode &&
      selectedProjectId !== '' &&
      selectedProjectId !== initialSelectedProjectId)

  // Allow natural Tab navigation between form fields — block SessionView's
  // global capture-phase Tab handler which would toggle Build/Plan mode instead.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Tab accepts an inline suggestion in the description; its own handler takes it.
        if (isInlineSuggestionTarget(e.target)) return
        const modal = document.querySelector('[data-testid="ticket-create-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.stopImmediatePropagation()
          // Don't preventDefault — let the browser move focus naturally
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open])

  // Clean up orphaned image files when modal closes without successful creation
  useEffect(() => {
    if (open) {
      createdSuccessfully.current = false
    } else {
      setShowDiscardConfirm(false)
      // Modal just closed — if creation didn't succeed, delete any saved images
      if (!createdSuccessfully.current) {
        for (const att of attachments) {
          if (att.type === 'image' && att.url) {
            attachmentApi.deleteImage(att.url).catch(() => {})
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only react to open/close transitions
  }, [open])

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setAutoReview(undefined)
      setTitle('')
      setDescription('')
      setShowPreview(false)
      setAttachments([])
      setCreatingAction(null)
      setSelectedProjectId(initialSelectedProjectId)
      // Auto-focus the title input after dialog animation
      setTimeout(() => titleInputRef.current?.focus(), 50)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset on open; initialSelectedProjectId is read at open time
  }, [open])

  // Keep the selection valid if the project list populates/changes while open
  useEffect(() => {
    if (!open || !isMultiProjectMode) return
    if (selectedProjectId && availableProjects.some((p) => p.id === selectedProjectId)) return
    setSelectedProjectId(initialSelectedProjectId)
  }, [open, isMultiProjectMode, selectedProjectId, availableProjects, initialSelectedProjectId])

  // ── Image paste/drop ───────────────────────────────────────────────
  const { isDragOver, handlePaste, handleDragOver, handleDragEnter, handleDragLeave, handleDrop } =
    useImagePaste({
      maxAttachments: MAX_ATTACHMENTS,
      currentCount: attachments.length,
      onAttach: (attachment) => setAttachments((prev) => [...prev, attachment])
    })

  // ── Submission ─────────────────────────────────────────────────────
  const submit = useCallback(
    async (action: 'create' | 'send') => {
      if (!title.trim() || isCreating) return

      const targetProjectId = isMultiProjectMode ? selectedProjectId : projectId
      if (!targetProjectId) return

      setCreatingAction(action)
      let created: KanbanTicket
      try {
        created = await createTicket(targetProjectId, {
          project_id: targetProjectId,
          title: title.trim(),
          description: description.trim() || null,
          attachments: attachments.map((a) => ({ type: a.type, url: a.url, label: a.label })),
          column: 'todo'
        })
        if (autoReview !== undefined) {
          const settings = useSettingsStore.getState()
          settings.updateSetting('autoReviewTasks', {
            ...settings.autoReviewTasks,
            [autoReviewTaskKey(targetProjectId, created.id)]: autoReview
          })
        }
        createdSuccessfully.current = true
        if (isPinnedMode) setPinnedBoardLastCreateProjectId(targetProjectId)
        setShowDiscardConfirm(false)
        toast.success('Ticket created')
        onOpenChange(false)
      } catch {
        toast.error('Failed to create ticket')
        return
      } finally {
        setCreatingAction(null)
      }

      // Create & Send: launch exactly like a right-button drag into In
      // Progress. Runs after the modal closes; the launch reports its own
      // success/failure toasts.
      if (action === 'send') {
        if (connectionId) void quickLaunchTicketOnConnection(created, connectionId)
        else void quickLaunchTicket(created)
      }
    },
    [
      autoReview,
      title,
      description,
      attachments,
      isCreating,
      createTicket,
      projectId,
      selectedProjectId,
      isMultiProjectMode,
      isPinnedMode,
      setPinnedBoardLastCreateProjectId,
      onOpenChange,
      connectionId
    ]
  )

  const handleCreate = useCallback(() => submit('create'), [submit])
  const handleCreateAndSend = useCallback(() => submit('send'), [submit])

  const closeImmediately = useCallback(() => {
    setShowDiscardConfirm(false)
    onOpenChange(false)
  }, [onOpenChange])

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardConfirm(true)
      return
    }
    closeImmediately()
  }, [closeImmediately, isDirty])

  const handleCancel = useCallback(() => {
    requestClose()
  }, [requestClose])

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        requestClose()
        return
      }
      onOpenChange(true)
    },
    [onOpenChange, requestClose]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim()) {
        e.preventDefault()
        // Cmd/Ctrl+Shift+Enter creates and sends with the default launch
        // arguments; Cmd/Ctrl+Enter just creates.
        if (e.shiftKey) handleCreateAndSend()
        else handleCreate()
      }
    },
    [handleCreate, handleCreateAndSend, title]
  )

  const isTitleEmpty = !title.trim()

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        data-testid="ticket-create-modal"
        className={cn('sm:max-w-lg', isDragOver && 'ring-[3px] ring-ring/50 border-ring')}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <DialogHeader>
          <DialogTitle>Create Ticket</DialogTitle>
          <DialogDescription>Add a new ticket to the To Do column.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Project picker (connection mode or pinned mode) */}
          {isMultiProjectMode && availableProjects.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Project
              </label>
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {availableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Title */}
          <div className="space-y-1.5">
            <label htmlFor="ticket-title" className="text-sm font-medium text-foreground">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              id="ticket-title"
              ref={titleInputRef}
              data-testid="ticket-title-input"
              placeholder="What needs to be done?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          {/* Description with preview toggle */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="ticket-description" className="text-sm font-medium text-foreground">
                Description
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                tabIndex={-1}
                data-testid="ticket-preview-toggle"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={() => setShowPreview((prev) => !prev)}
              >
                {showPreview ? (
                  <>
                    <EyeOff className="h-3.5 w-3.5" /> Edit
                  </>
                ) : (
                  <>
                    <Eye className="h-3.5 w-3.5" /> Preview
                  </>
                )}
              </Button>
            </div>

            {showPreview ? (
              <div
                data-testid="ticket-description-preview"
                className="min-h-[120px] rounded-md border border-input bg-muted/30 px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none"
              >
                {description.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
                ) : (
                  <p className="text-muted-foreground/60 italic">No description</p>
                )}
              </div>
            ) : (
              <TicketDescriptionTextarea
                id="ticket-description"
                data-testid="ticket-description-input"
                placeholder="Describe the ticket (supports markdown)..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                className="resize-y"
              />
            )}
          </div>

          <AutoReviewPreference
            projectId={isMultiProjectMode ? selectedProjectId : projectId}
            draft={{ value: autoReview, onChange: setAutoReview }}
          />

          {/* Attachments */}
          <TicketAttachmentEditor
            attachments={attachments}
            onChange={setAttachments}
            testIdPrefix="ticket"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="ticket-cancel-btn"
            onClick={handleCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="ticket-create-send-btn"
            title="Create the ticket and start it now with the default launch settings"
            disabled={isTitleEmpty || isCreating}
            onClick={handleCreateAndSend}
          >
            <Send className="h-3.5 w-3.5" />
            {creatingAction === 'send' ? 'Sending...' : 'Create & Send'}
            <ShortcutHint label={submitShortcutLabel({ shift: true })} />
          </Button>
          <Button
            type="button"
            data-testid="ticket-create-btn"
            disabled={isTitleEmpty || isCreating}
            onClick={handleCreate}
          >
            {creatingAction === 'create' ? 'Creating...' : 'Create'}
            <ShortcutHint label={submitShortcutLabel()} />
          </Button>
        </DialogFooter>
      </DialogContent>
      <TicketDiscardChangesDialog
        open={showDiscardConfirm}
        onKeepEditing={() => setShowDiscardConfirm(false)}
        onDiscard={closeImmediately}
      />
    </Dialog>
  )
}
