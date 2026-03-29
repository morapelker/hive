import { useState, useCallback, useRef, useEffect } from 'react'
import { Eye, EyeOff, Plus, X, Ticket, Figma, Link as LinkIcon } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { parseAttachmentUrl } from '@/lib/attachment-utils'
import type { AttachmentInfo } from '@/lib/attachment-utils'
import { toast } from '@/lib/toast'

// ── Types ───────────────────────────────────────────────────────────
interface TicketAttachment extends AttachmentInfo {
  url: string
}

interface TicketCreateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}

// ── Component ───────────────────────────────────────────────────────
export function TicketCreateModal({ open, onOpenChange, projectId }: TicketCreateModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [attachments, setAttachments] = useState<TicketAttachment[]>([])
  const [showAttachInput, setShowAttachInput] = useState(false)
  const [attachUrl, setAttachUrl] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const titleInputRef = useRef<HTMLInputElement>(null)
  const createTicket = useKanbanStore((state) => state.createTicket)

  // Allow natural Tab navigation between form fields — block SessionView's
  // global capture-phase Tab handler which would toggle Build/Plan mode instead.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
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

  // Reset form when modal opens/closes
  useEffect(() => {
    if (open) {
      setTitle('')
      setDescription('')
      setShowPreview(false)
      setAttachments([])
      setShowAttachInput(false)
      setAttachUrl('')
      setIsCreating(false)
      // Auto-focus the title input after dialog animation
      setTimeout(() => titleInputRef.current?.focus(), 50)
    }
  }, [open])

  // ── Attachment handling ────────────────────────────────────────────
  const detectedAttachment = attachUrl.trim() ? parseAttachmentUrl(attachUrl.trim()) : null

  const handleAddAttachment = useCallback(() => {
    if (!detectedAttachment || !attachUrl.trim()) return
    setAttachments((prev) => [
      ...prev,
      { ...detectedAttachment, url: attachUrl.trim() }
    ])
    setAttachUrl('')
    setShowAttachInput(false)
  }, [detectedAttachment, attachUrl])

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ── Submission ─────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!title.trim() || isCreating) return

    setIsCreating(true)
    try {
      await createTicket(projectId, {
        project_id: projectId,
        title: title.trim(),
        description: description.trim() || null,
        attachments: attachments.map((a) => ({ type: a.type, url: a.url, label: a.label })),
        column: 'todo'
      })
      toast.success('Ticket created')
      onOpenChange(false)
    } catch {
      toast.error('Failed to create ticket')
    } finally {
      setIsCreating(false)
    }
  }, [title, description, attachments, isCreating, createTicket, projectId, onOpenChange])

  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && e.metaKey && title.trim()) {
        handleCreate()
      }
    },
    [handleCreate, title]
  )

  const isTitleEmpty = !title.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="ticket-create-modal"
        className="sm:max-w-lg"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Create Ticket</DialogTitle>
          <DialogDescription>Add a new ticket to the To Do column.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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
              <Textarea
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

          {/* Attachments */}
          <div className="space-y-2">
            {/* Existing attachment chips */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map((attachment, index) => (
                  <span
                    key={index}
                    data-testid={`ticket-attachment-chip-${index}`}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                  >
                    {attachment.type === 'jira' ? (
                      <Ticket className="h-3 w-3 text-blue-500" />
                    ) : attachment.type === 'figma' ? (
                      <Figma className="h-3 w-3 text-purple-500" />
                    ) : (
                      <LinkIcon className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="max-w-[180px] truncate">{attachment.label}</span>
                    <button
                      data-testid={`ticket-attachment-remove-${index}`}
                      onClick={() => handleRemoveAttachment(index)}
                      className="ml-0.5 rounded-sm hover:bg-muted transition-colors"
                    >
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {!showAttachInput && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="ticket-add-attachment-btn"
                className="gap-1 text-xs"
                onClick={() => setShowAttachInput(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                Add attachment
              </Button>
            )}

            {/* Inline attachment URL input */}
            {showAttachInput && (
              <div className="flex items-center gap-2">
                <Input
                  data-testid="ticket-attachment-url-input"
                  placeholder="Paste a Jira or Figma URL"
                  value={attachUrl}
                  onChange={(e) => setAttachUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && detectedAttachment) {
                      e.preventDefault()
                      handleAddAttachment()
                    }
                    if (e.key === 'Escape') {
                      setShowAttachInput(false)
                      setAttachUrl('')
                    }
                  }}
                  autoFocus
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  data-testid="ticket-attachment-confirm-btn"
                  disabled={!detectedAttachment}
                  onClick={handleAddAttachment}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowAttachInput(false)
                    setAttachUrl('')
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
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
            data-testid="ticket-create-btn"
            disabled={isTitleEmpty || isCreating}
            onClick={handleCreate}
          >
            {isCreating ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
