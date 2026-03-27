import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  Eye,
  EyeOff,
  Plus,
  X,
  Ticket,
  Figma,
  Link as LinkIcon,
  Trash2,
  ExternalLink,
  Hammer,
  Map,
  Send,
  Zap,
  ArrowRight,
  AlertCircle,
  Bolt
} from 'lucide-react'
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
import { MarkdownRenderer } from '../sessions/MarkdownRenderer'
import { cn } from '@/lib/utils'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { messageSendTimes, lastSendMode } from '@/lib/message-send-times'
import { PLAN_MODE_PREFIX } from '@/lib/constants'
import { parseAttachmentUrl } from '@/lib/attachment-utils'
import type { AttachmentInfo } from '@/lib/attachment-utils'
import { toast } from '@/lib/toast'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'
import { QuestionPrompt } from '@/components/sessions/QuestionPrompt'
import type { KanbanTicket, KanbanTicketUpdate } from '../../../../main/db/types'

// ── Types ───────────────────────────────────────────────────────────
type ModalMode = 'edit' | 'plan_review' | 'review' | 'error' | 'question'
type FollowUpMode = 'build' | 'plan'

interface TicketAttachment extends AttachmentInfo {
  url: string
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Find a worktree by its ID across all projects */
function findWorktreeById(
  worktreeId: string
): { id: string; path: string; branch_name: string; project_id: string } | null {
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const wt = worktrees.find((w) => w.id === worktreeId)
    if (wt) return wt
  }
  return null
}

/** Find a worktree path by its ID across all projects */
function findWorktreePathById(worktreeId: string): string | null {
  return findWorktreeById(worktreeId)?.path ?? null
}

/** Find a session by ID across worktree and connection session maps */
function findSessionById(sessionId: string): {
  session: { id: string; worktree_id: string | null; opencode_session_id: string | null; agent_sdk: string }
  worktreePath: string | null
} | null {
  const sessionStore = useSessionStore.getState()
  for (const sessions of sessionStore.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      const worktreePath = found.worktree_id ? findWorktreePathById(found.worktree_id) : null
      return { session: found, worktreePath }
    }
  }
  for (const sessions of sessionStore.sessionsByConnection.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      const worktreePath = found.worktree_id ? findWorktreePathById(found.worktree_id) : null
      return { session: found, worktreePath }
    }
  }
  return null
}

/** Resolve the model to use for a session's next prompt (mirrors SessionView.getModelForRequests) */
function resolveSessionModel(
  sessionId: string
): { providerID: string; modelID: string; variant?: string } | undefined {
  const state = useSessionStore.getState()
  // Search both worktree and connection session maps
  let session: { model_provider_id: string | null; model_id: string | null; model_variant: string | null; agent_sdk: string } | null = null
  for (const sessions of state.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) { session = found; break }
  }
  if (!session) {
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) { session = found; break }
    }
  }
  // Session has an explicit model — use it
  if (session?.model_provider_id && session.model_id) {
    return {
      providerID: session.model_provider_id,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    }
  }
  // Fall back to per-provider default for this session's SDK
  const agentSdk = session?.agent_sdk ?? 'opencode'
  return resolveModelForSdk(agentSdk) ?? undefined
}

/** Send a followup prompt to an existing session and update ticket mode */
async function sendFollowupToSession(opts: {
  sessionId: string
  prompt: string
  followUpMode: FollowUpMode
  ticketId: string
  projectId: string
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
}): Promise<void> {
  const result = findSessionById(opts.sessionId)
  if (!result) return

  const { session, worktreePath } = result

  // Set session mode so the agent SDK knows we're in plan mode (matches Tab toggle in SessionView).
  // This updates modeBySession, persists to DB, and applies mode-specific default model.
  await useSessionStore.getState().setSessionMode(opts.sessionId, opts.followUpMode)

  // Claude Code & Codex handle plan mode via the SDK — don't prepend the text prefix
  const skipPrefix = session.agent_sdk === 'claude-code' || session.agent_sdk === 'codex'
  const modePrefix = opts.followUpMode === 'plan' && !skipPrefix ? PLAN_MODE_PREFIX : ''
  const fullPrompt = modePrefix + opts.prompt

  if (worktreePath && session.opencode_session_id) {
    messageSendTimes.set(opts.sessionId, Date.now())
    lastSendMode.set(opts.sessionId, opts.followUpMode)
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(opts.sessionId, opts.followUpMode === 'plan' ? 'planning' : 'working')

    // Resolve model AFTER setSessionMode (which may have applied a mode-specific default)
    const model = resolveSessionModel(opts.sessionId)

    // Persist the followup message
    window.kanban.followup.create({
      ticket_id: opts.ticketId,
      content: opts.prompt,
      mode: opts.followUpMode,
      session_id: opts.sessionId,
      source: 'direct'
    }).catch(() => {})

    const result = await window.opencodeOps.prompt(worktreePath, session.opencode_session_id, [
      { type: 'text', text: fullPrompt }
    ], model)

    if (result && !result.success) {
      throw new Error(result.error || 'Failed to send prompt to session')
    }
  }

  await opts.updateTicket(opts.ticketId, opts.projectId, { mode: opts.followUpMode, plan_ready: false })
}

/** Determine what mode the modal should operate in */
function resolveModalMode(ticket: KanbanTicket, sessionStatus: string | null): ModalMode {
  // Error mode: in_progress + linked session has error
  if (ticket.column === 'in_progress' && sessionStatus === 'error') {
    return 'error'
  }
  // Plan review mode: in_progress + plan_ready
  if (ticket.column === 'in_progress' && ticket.plan_ready) {
    return 'plan_review'
  }
  // Review mode: review column
  if (ticket.column === 'review') {
    return 'review'
  }
  // Default: edit mode (todo, done, or simple in_progress tickets)
  return 'edit'
}

// ── Component ───────────────────────────────────────────────────────
export function KanbanTicketModal() {
  const selectedTicketId = useKanbanStore((s) => s.selectedTicketId)
  const setSelectedTicketId = useKanbanStore((s) => s.setSelectedTicketId)
  const tickets = useKanbanStore((s) => s.tickets)

  // Find the ticket across all projects
  const ticket = useMemo<KanbanTicket | null>(() => {
    if (!selectedTicketId) return null
    for (const projectTickets of tickets.values()) {
      const found = projectTickets.find((t) => t.id === selectedTicketId)
      if (found) return found
    }
    return null
  }, [selectedTicketId, tickets])

  const open = ticket !== null
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) setSelectedTicketId(null)
    },
    [setSelectedTicketId]
  )

  if (!ticket) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <KanbanTicketModalContent ticket={ticket} onClose={() => setSelectedTicketId(null)} />
    </Dialog>
  )
}

// ── Inner content (only rendered when ticket is non-null) ───────────
function KanbanTicketModalContent({
  ticket,
  onClose
}: {
  ticket: KanbanTicket
  onClose: () => void
}) {
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const deleteTicket = useKanbanStore((s) => s.deleteTicket)
  const moveTicket = useKanbanStore((s) => s.moveTicket)

  // ── Session lookup ────────────────────────────────────────────────
  const sessionStatus = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  const sessionRecord = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  const pendingPlan = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.pendingPlans.get(ticket.current_session_id) ?? null
      },
      [ticket.current_session_id]
    )
  )

  const activeQuestion = useQuestionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        const questions = state.pendingBySession.get(ticket.current_session_id)
        return questions?.[0] ?? null
      },
      [ticket.current_session_id]
    )
  )

  const baseModalMode = resolveModalMode(ticket, sessionStatus)
  // Question mode takes highest priority — an unanswered question blocks
  // the agent regardless of other ticket state (error, plan_ready, etc.)
  const modalMode = activeQuestion ? 'question' : baseModalMode

  // Render the appropriate content based on mode
  switch (modalMode) {
    case 'edit':
      return (
        <EditModeContent
          ticket={ticket}
          onClose={onClose}
          updateTicket={updateTicket}
          deleteTicket={deleteTicket}
        />
      )
    case 'plan_review':
      return (
        <PlanReviewModeContent
          ticket={ticket}
          onClose={onClose}
          pendingPlan={pendingPlan}
          sessionRecord={sessionRecord}
          updateTicket={updateTicket}
        />
      )
    case 'review':
      return (
        <ReviewModeContent
          ticket={ticket}
          onClose={onClose}
          moveTicket={moveTicket}
          updateTicket={updateTicket}
        />
      )
    case 'error':
      return <ErrorModeContent ticket={ticket} onClose={onClose} />
    case 'question':
      return (
        <QuestionModeContent
          ticket={ticket}
          onClose={onClose}
          activeQuestion={activeQuestion!}
        />
      )
  }
}

// ════════════════════════════════════════════════════════════════════
// EDIT MODE
// ════════════════════════════════════════════════════════════════════

function EditModeContent({
  ticket,
  onClose,
  updateTicket,
  deleteTicket
}: {
  ticket: KanbanTicket
  onClose: () => void
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  deleteTicket: (ticketId: string, projectId: string) => Promise<void>
}) {
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description ?? '')
  const [showPreview, setShowPreview] = useState(false)
  const [attachments, setAttachments] = useState<TicketAttachment[]>(
    () =>
      (ticket.attachments as Array<{ type: string; url: string; label: string }>).map((a) => ({
        type: a.type as 'jira' | 'figma' | 'generic',
        url: a.url,
        label: a.label
      })) ?? []
  )
  const [showAttachInput, setShowAttachInput] = useState(false)
  const [attachUrl, setAttachUrl] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const detectedAttachment = attachUrl.trim() ? parseAttachmentUrl(attachUrl.trim()) : null

  const handleAddAttachment = useCallback(() => {
    if (!detectedAttachment || !attachUrl.trim()) return
    setAttachments((prev) => [...prev, { ...detectedAttachment, url: attachUrl.trim() }])
    setAttachUrl('')
    setShowAttachInput(false)
  }, [detectedAttachment, attachUrl])

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleSave = useCallback(async () => {
    if (!title.trim() || isSaving) return
    setIsSaving(true)
    try {
      await updateTicket(ticket.id, ticket.project_id, {
        title: title.trim(),
        description: description.trim() || null,
        attachments: attachments.map((a) => ({ type: a.type, url: a.url, label: a.label }))
      })
      toast.success('Ticket updated')
      onClose()
    } catch {
      toast.error('Failed to update ticket')
    } finally {
      setIsSaving(false)
    }
  }, [title, description, attachments, isSaving, updateTicket, ticket.id, ticket.project_id, onClose])

  const handleDelete = useCallback(async () => {
    try {
      await deleteTicket(ticket.id, ticket.project_id)
      toast.success('Ticket deleted')
      onClose()
    } catch {
      toast.error('Failed to delete ticket')
    }
  }, [deleteTicket, ticket.id, ticket.project_id, onClose])

  return (
    <DialogContent data-testid="kanban-ticket-modal" className="sm:max-w-lg">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle>Edit Ticket</DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Update ticket details.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Title */}
        <div className="space-y-1.5">
          <label htmlFor="ticket-edit-title" className="text-sm font-medium text-foreground">
            Title <span className="text-destructive">*</span>
          </label>
          <Input
            id="ticket-edit-title"
            data-testid="ticket-edit-title-input"
            placeholder="What needs to be done?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="ticket-edit-description"
              className="text-sm font-medium text-foreground"
            >
              Description
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ticket-edit-preview-toggle"
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
              data-testid="ticket-edit-description-preview"
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
              id="ticket-edit-description"
              data-testid="ticket-edit-description-input"
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
          <label className="text-sm font-medium text-foreground">Attachments</label>

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((attachment, index) => (
                <span
                  key={index}
                  data-testid={`ticket-edit-attachment-chip-${index}`}
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
                    data-testid={`ticket-edit-attachment-remove-${index}`}
                    onClick={() => handleRemoveAttachment(index)}
                    className="ml-0.5 rounded-sm hover:bg-muted transition-colors"
                  >
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {showAttachInput ? (
            <div className="flex items-center gap-2">
              <Input
                data-testid="ticket-edit-attachment-url-input"
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
                data-testid="ticket-edit-attachment-confirm-btn"
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
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="ticket-edit-add-attachment-btn"
              className="gap-1 text-xs"
              onClick={() => setShowAttachInput(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Add attachment
            </Button>
          )}
        </div>
      </div>

      <DialogFooter className="flex items-center justify-between sm:justify-between">
        <div>
          {showDeleteConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">Delete this ticket?</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="ticket-edit-delete-confirm-btn"
                onClick={handleDelete}
              >
                Yes, delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ticket-edit-delete-btn"
              className="text-destructive hover:text-destructive"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="ticket-edit-cancel-btn"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="ticket-edit-save-btn"
            disabled={!title.trim() || isSaving}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  )
}

// ════════════════════════════════════════════════════════════════════
// PLAN REVIEW MODE
// ════════════════════════════════════════════════════════════════════

function PlanReviewModeContent({
  ticket,
  onClose,
  pendingPlan,
  sessionRecord,
  updateTicket
}: {
  ticket: KanbanTicket
  onClose: () => void
  pendingPlan: { requestId: string; planContent: string; toolUseID: string } | null
  sessionRecord: {
    id: string
    worktree_id: string | null
    project_id: string
    agent_sdk: string
  } | null
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
}) {
  const [isActioning, setIsActioning] = useState(false)
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('plan')
  const [isSending, setIsSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; role: 'user' | 'assistant'; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])

  useEffect(() => {
    window.kanban.followup.getByTicket(ticket.id).then(setFollowupHistory).catch(() => {})
  }, [ticket.id])

  const planContent = pendingPlan?.planContent ?? ticket.description ?? ''

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => (prev === 'build' ? 'plan' : 'build'))
  }, [])

  // Tab key toggles mode
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const modal = document.querySelector('[data-testid="kanban-ticket-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          toggleMode()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [toggleMode])

  // ── Send followup (reject pending plan + iterate) ────────────────
  const handleSendFollowup = useCallback(async () => {
    if (!followUpText.trim() || !ticket.current_session_id || isSending) return
    setIsSending(true)

    try {
      const sessionId = ticket.current_session_id
      const feedback = followUpText.trim()
      const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'

      // Reject the pending plan before sending the followup (mirrors SessionView)
      if (pendingPlan) {
        useSessionStore.getState().clearPendingPlan(sessionId)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

        if (isClaudeCode && sessionRecord?.worktree_id) {
          const worktreePath = findWorktreePathById(sessionRecord.worktree_id)
          if (worktreePath) {
            await window.opencodeOps.planReject(
              worktreePath,
              sessionId,
              feedback,
              pendingPlan.requestId
            )
          }
          // planReject already sends the feedback as the next prompt for Claude Code
          window.kanban.followup.create({
            ticket_id: ticket.id,
            content: feedback,
            mode: 'plan',
            session_id: sessionId,
            source: 'direct'
          }).catch(() => {})
          await updateTicket(ticket.id, ticket.project_id, { plan_ready: false, mode: 'plan' })
          toast.success('Plan rejected with feedback')
          onClose()
          return
        }
      }

      // For non-Claude Code (or no pending plan): send as a regular followup
      await sendFollowupToSession({
        sessionId,
        prompt: feedback,
        followUpMode,
        ticketId: ticket.id,
        projectId: ticket.project_id,
        updateTicket
      })

      toast.success('Followup sent')
      onClose()
    } catch {
      toast.error('Failed to send followup')
    } finally {
      setIsSending(false)
    }
  }, [followUpText, followUpMode, ticket, isSending, pendingPlan, sessionRecord, updateTicket, onClose])

  // Enter sends, Shift+Enter for newline
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSendFollowup()
      }
    },
    [handleSendFollowup]
  )

  // ── Implement handler ─────────────────────────────────────────────
  const handleImplement = useCallback(async () => {
    if (!ticket.current_session_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      await useSessionStore.getState().setSessionMode(sessionId, 'build')
      lastSendMode.set(sessionId, 'build')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
      messageSendTimes.set(sessionId, Date.now())

      // Clear plan_ready badge — ticket is back to working
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, { plan_ready: false, mode: 'build' })

      // For opencode agents, approve the plan if there's a pending one
      if (pendingPlan && sessionRecord?.worktree_id) {
        const worktreePath = findWorktreePathById(sessionRecord.worktree_id)
        if (worktreePath) {
          await window.opencodeOps.planApprove(worktreePath, sessionId, pendingPlan.requestId)
        }
      }

      toast.success('Implementation started')
      onClose()
    } catch {
      toast.error('Failed to start implementation')
    } finally {
      setIsActioning(false)
    }
  }, [ticket.current_session_id, isActioning, pendingPlan, sessionRecord, onClose])

  // ── Handoff handler ───────────────────────────────────────────────
  const handleHandoff = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createSession(ticket.worktree_id, ticket.project_id)
      if (!result.success || !result.session) {
        toast.error(result.error ?? 'Failed to create handoff session')
        return
      }

      const handoffPrompt = `Implement the following plan\n${planContent}`
      await sessionStore.setSessionMode(result.session.id, 'build')
      sessionStore.setPendingMessage(result.session.id, handoffPrompt)
      sessionStore.setActiveSession(result.session.id)

      // Clear plan_ready badge and link to new session
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
        current_session_id: result.session.id,
        plan_ready: false,
        mode: 'build'
      })

      toast.success('Handoff session created')
      onClose()
    } catch {
      toast.error('Failed to create handoff session')
    } finally {
      setIsActioning(false)
    }
  }, [ticket, isActioning, planContent, onClose])

  // ── Shared: eagerly connect, send /using-superpowers, queue follow-up for global listener ──
  const eagerSuperchargeStart = useCallback(async (
    worktreePath: string,
    newSessionId: string
  ) => {
    // Connect to OpenCode
    const connectResult = await window.opencodeOps.connect(worktreePath, newSessionId)
    if (!connectResult.success || !connectResult.sessionId) return

    // Persist the opencode session ID to Zustand + DB
    useSessionStore.getState().setOpenCodeSessionId(newSessionId, connectResult.sessionId)
    await window.db.session.update(newSessionId, {
      opencode_session_id: connectResult.sessionId
    })

    // Queue the follow-up for the global idle listener to dispatch after /using-superpowers completes
    useSessionStore.getState().setPendingFollowUpMessages(newSessionId, [
      'use the subagent development skill to implement the following plan:\n' + planContent
    ])

    // Set status tracking
    messageSendTimes.set(newSessionId, Date.now())
    lastSendMode.set(newSessionId, 'build')
    useWorktreeStatusStore.getState().setSessionStatus(newSessionId, 'working')

    // Send /using-superpowers — global listener handles follow-up on idle
    const model = resolveSessionModel(newSessionId)
    await window.opencodeOps.prompt(worktreePath, connectResult.sessionId, [
      { type: 'text', text: '/using-superpowers' }
    ], model)
  }, [planContent])

  // ── Supercharge handler (new branch) ────────────────────────────
  const handleSupercharge = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

      // Look up worktree and project for duplication
      const worktree = findWorktreeById(ticket.worktree_id!)
      if (!worktree) {
        toast.error('Could not find worktree')
        return
      }

      const project = useProjectStore.getState().projects.find((p) => p.id === worktree.project_id)
      if (!project) {
        toast.error('Could not find project')
        return
      }

      // Duplicate worktree
      const dupResult = await useWorktreeStore.getState().duplicateWorktree(
        project.id,
        project.path,
        project.name,
        worktree.branch_name,
        worktree.path
      )
      if (!dupResult.success || !dupResult.worktree) {
        toast.error(dupResult.error ?? 'Failed to duplicate worktree')
        return
      }

      // Create session in the new worktree
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createSession(dupResult.worktree.id, project.id)
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create supercharge session')
        return
      }

      const newSessionId = sessionResult.session.id
      await sessionStore.setSessionMode(newSessionId, 'build')

      // Notify kanban store: supercharge re-attaches ticket to new session
      notifyKanbanSessionSync(sessionId, {
        type: 'supercharge',
        newSessionId
      })

      toast.success('Supercharge session started')
      onClose()

      // Eagerly connect + send /using-superpowers in background; follow-up dispatched by global listener
      await eagerSuperchargeStart(dupResult.worktree.path, newSessionId)
    } catch {
      toast.error('Failed to supercharge')
    } finally {
      setIsActioning(false)
    }
  }, [ticket, isActioning, planContent, onClose, eagerSuperchargeStart])

  // ── Supercharge Local handler (same worktree, no duplication) ───
  const handleSuperchargeLocal = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

      const worktreePath = findWorktreePathById(ticket.worktree_id)
      if (!worktreePath) {
        toast.error('Could not find worktree path')
        return
      }

      // Create a new session in the SAME worktree
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createSession(ticket.worktree_id, ticket.project_id)
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create local supercharge session')
        return
      }

      const newSessionId = sessionResult.session.id
      await sessionStore.setSessionMode(newSessionId, 'build')

      // Re-attach ticket to the new session, clear plan_ready
      notifyKanbanSessionSync(sessionId, {
        type: 'supercharge',
        newSessionId
      })

      toast.success('Local supercharge session started')
      onClose()

      // Eagerly connect + send /using-superpowers in background; follow-up dispatched by global listener
      await eagerSuperchargeStart(worktreePath, newSessionId)
    } catch {
      toast.error('Failed to supercharge locally')
    } finally {
      setIsActioning(false)
    }
  }, [ticket, isActioning, planContent, onClose, eagerSuperchargeStart])

  return (
    <DialogContent data-testid="kanban-ticket-modal" className="sm:max-w-2xl max-h-[80vh] flex flex-col">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            {ticket.title}
            <span className="inline-flex items-center rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[11px] font-medium text-violet-500">
              Plan ready
            </span>
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Review the plan and choose an action.</DialogDescription>
      </DialogHeader>

      <div
        data-testid="plan-review-content"
        className="flex-1 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-4 prose prose-sm dark:prose-invert max-w-none"
      >
        <MarkdownRenderer content={planContent} />
      </div>

      <ConversationHistory messages={followupHistory} />

      {/* Followup input — iterate on the plan */}
      <div className="space-y-1.5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Followup
          </label>
          <button
            data-testid="plan-review-mode-toggle"
            data-mode={followUpMode}
            type="button"
            onClick={toggleMode}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
              'border select-none',
              followUpMode === 'build'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                : 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
            )}
          >
            {followUpMode === 'build' ? <Hammer className="h-3 w-3" /> : <Map className="h-3 w-3" />}
            <span>{followUpMode === 'build' ? 'Build' : 'Plan'}</span>
          </button>
        </div>
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            data-testid="plan-review-followup-input"
            value={followUpText}
            onChange={(e) => setFollowUpText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Iterate on the plan… (Enter to send)"
            className="resize-y font-mono text-xs leading-relaxed flex-1"
          />
          <Button
            type="button"
            data-testid="plan-review-send-followup-btn"
            disabled={isSending || !followUpText.trim()}
            onClick={handleSendFollowup}
            size="icon"
            className="shrink-0 h-8 w-8"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <DialogFooter className="flex-shrink-0 gap-1.5">
        <Button
          type="button"
          data-testid="plan-review-implement-btn"
          disabled={isActioning}
          onClick={handleImplement}
          className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
        >
          <Hammer className="h-3.5 w-3.5" />
          Implement
        </Button>
        <Button
          type="button"
          data-testid="plan-review-handoff-btn"
          disabled={isActioning}
          onClick={handleHandoff}
          className="gap-1.5"
          variant="outline"
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Handoff
        </Button>
        <Button
          type="button"
          data-testid="plan-review-supercharge-local-btn"
          disabled={isActioning}
          onClick={handleSuperchargeLocal}
          className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
        >
          <Bolt className="h-3.5 w-3.5" />
          Supercharge
        </Button>
        <Button
          type="button"
          data-testid="plan-review-supercharge-btn"
          disabled={isActioning}
          onClick={handleSupercharge}
          className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
          variant="outline"
        >
          <Zap className="h-3.5 w-3.5" />
          Supercharge (new branch)
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

// ════════════════════════════════════════════════════════════════════
// REVIEW MODE
// ════════════════════════════════════════════════════════════════════

function ReviewModeContent({
  ticket,
  onClose,
  moveTicket,
  updateTicket
}: {
  ticket: KanbanTicket
  onClose: () => void
  moveTicket: (ticketId: string, projectId: string, column: 'todo' | 'in_progress' | 'review' | 'done', sortOrder: number) => Promise<void>
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
}) {
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('build')
  const [isSending, setIsSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; role: 'user' | 'assistant'; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])

  useEffect(() => {
    window.kanban.followup.getByTicket(ticket.id).then(setFollowupHistory).catch(() => {})
  }, [ticket.id])

  // Display ticket description as context, with notice to view session for full conversation
  const reviewDescription = ticket.description ?? null

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => (prev === 'build' ? 'plan' : 'build'))
  }, [])

  // Tab key toggles mode
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Only intercept when the modal is focused
        const modal = document.querySelector('[data-testid="kanban-ticket-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          toggleMode()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [toggleMode])

  // ── Send followup ─────────────────────────────────────────────────
  const handleSendFollowup = useCallback(async () => {
    if (!followUpText.trim() || !ticket.current_session_id || isSending) return
    setIsSending(true)

    try {
      // Move ticket back to in_progress FIRST for immediate UI feedback.
      const kanbanStore = useKanbanStore.getState()
      const inProgressTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'in_progress')
      const sortOrder = kanbanStore.computeSortOrder(inProgressTickets, 0)
      await moveTicket(ticket.id, ticket.project_id, 'in_progress', sortOrder)

      // Capture values before closing modal
      const sessionId = ticket.current_session_id
      const prompt = followUpText.trim()
      const mode = followUpMode
      const ticketId = ticket.id
      const projectId = ticket.project_id

      toast.success('Followup sent')
      onClose()

      // Send followup in background. sendFollowupToSession awaits the full
      // Claude session, but the UI is already updated (ticket moved, modal
      // closed). Errors surface via the session error pipeline.
      sendFollowupToSession({
        sessionId,
        prompt,
        followUpMode: mode,
        ticketId,
        projectId,
        updateTicket
      }).catch(() => {
        toast.error('Failed to send followup')
      })
    } catch {
      toast.error('Failed to move ticket')
    } finally {
      setIsSending(false)
    }
  }, [followUpText, followUpMode, ticket, isSending, moveTicket, updateTicket, onClose])

  // Enter sends, Shift+Enter for newline
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSendFollowup()
      }
    },
    [handleSendFollowup]
  )

  // ── Move to Done ──────────────────────────────────────────────────
  const handleMoveToDone = useCallback(async () => {
    try {
      const kanbanStore = useKanbanStore.getState()
      const doneTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'done')
      const sortOrder = kanbanStore.computeSortOrder(doneTickets, doneTickets.length)
      await moveTicket(ticket.id, ticket.project_id, 'done', sortOrder)
      toast.success('Ticket moved to Done')
      onClose()
    } catch {
      toast.error('Failed to move ticket')
    }
  }, [ticket, moveTicket, onClose])

  const ModeIcon = followUpMode === 'build' ? Hammer : Map
  const modeLabel = followUpMode === 'build' ? 'Build' : 'Plan'

  return (
    <DialogContent data-testid="kanban-ticket-modal" className="sm:max-w-2xl max-h-[80vh] flex flex-col">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle>{ticket.title}</DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Review the session output and provide followup.</DialogDescription>
      </DialogHeader>

      <div
        data-testid="review-content"
        className="flex-1 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-4 space-y-3"
      >
        {reviewDescription ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={reviewDescription} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Session completed.</p>
        )}
        <p data-testid="review-session-notice" className="text-xs text-muted-foreground/80">
          View the full session conversation by clicking &quot;Jump to session&quot; above.
        </p>
      </div>

      <ConversationHistory messages={followupHistory} />

      {/* Followup input area */}
      <div className="space-y-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Followup
          </label>
          <button
            data-testid="review-mode-toggle"
            data-mode={followUpMode}
            type="button"
            onClick={toggleMode}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
              'border select-none',
              followUpMode === 'build'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                : 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
            )}
          >
            <ModeIcon className="h-3 w-3" />
            <span>{modeLabel}</span>
          </button>
        </div>
        <Textarea
          ref={textareaRef}
          data-testid="review-followup-input"
          value={followUpText}
          onChange={(e) => setFollowUpText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Provide followup instructions… (Enter to send)"
          className="resize-y font-mono text-xs leading-relaxed"
        />
      </div>

      <DialogFooter className="flex-shrink-0">
        <Button
          type="button"
          variant="outline"
          data-testid="review-cancel-btn"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="review-move-done-btn"
          variant="outline"
          onClick={handleMoveToDone}
        >
          Move to Done
        </Button>
        <Button
          type="button"
          data-testid="review-send-followup-btn"
          disabled={!followUpText.trim() || isSending}
          onClick={handleSendFollowup}
          className={cn(
            'gap-1.5',
            followUpMode === 'build'
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-violet-600 hover:bg-violet-700 text-white'
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {isSending ? 'Sending...' : 'Send'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

// ════════════════════════════════════════════════════════════════════
// ERROR MODE
// ════════════════════════════════════════════════════════════════════

function ErrorModeContent({
  ticket,
  onClose
}: {
  ticket: KanbanTicket
  onClose: () => void
}) {
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('build')
  const [isSending, setIsSending] = useState(false)
  const updateTicket = useKanbanStore((s) => s.updateTicket)

  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; role: 'user' | 'assistant'; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])

  useEffect(() => {
    window.kanban.followup.getByTicket(ticket.id).then(setFollowupHistory).catch(() => {})
  }, [ticket.id])

  // Look up session status entry for error details
  const sessionStatusEntry = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.sessionStatuses[ticket.current_session_id] ?? null
      },
      [ticket.current_session_id]
    )
  )

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => (prev === 'build' ? 'plan' : 'build'))
  }, [])

  // ── Send followup for error retry ─────────────────────────────────
  const handleSendFollowup = useCallback(async () => {
    if (!followUpText.trim() || !ticket.current_session_id || isSending) return
    setIsSending(true)

    try {
      await sendFollowupToSession({
        sessionId: ticket.current_session_id,
        prompt: followUpText.trim(),
        followUpMode,
        ticketId: ticket.id,
        projectId: ticket.project_id,
        updateTicket
      })

      toast.success('Retry sent')
      onClose()
    } catch {
      toast.error('Failed to send retry')
    } finally {
      setIsSending(false)
    }
  }, [followUpText, followUpMode, ticket, isSending, updateTicket, onClose])

  // Enter sends, Shift+Enter for newline
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSendFollowup()
      }
    },
    [handleSendFollowup]
  )

  const ModeIcon = followUpMode === 'build' ? Hammer : Map
  const modeLabel = followUpMode === 'build' ? 'Build' : 'Plan'

  return (
    <DialogContent data-testid="kanban-ticket-modal" className="sm:max-w-lg">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            {ticket.title}
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[11px] font-medium text-red-500">
              <AlertCircle className="h-3 w-3" />
              Error
            </span>
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>The session encountered an error. Send a followup to retry or correct.</DialogDescription>
      </DialogHeader>

      <div
        data-testid="error-info"
        className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 space-y-1"
      >
        <p>The linked session reported an error. You can send a followup message to retry or provide corrections.</p>
        {sessionStatusEntry && (
          <p className="text-xs text-red-400/70" data-testid="error-status-detail">
            Status: {sessionStatusEntry.status}
            {sessionStatusEntry.word ? ` - ${sessionStatusEntry.word}` : ''}
            {sessionStatusEntry.durationMs ? ` (${Math.round(sessionStatusEntry.durationMs / 1000)}s ago)` : ''}
          </p>
        )}
        <p className="text-xs text-red-400/70">
          Session: {ticket.current_session_id}
          {' \u2014 use "Jump to session" for full details.'}
        </p>
      </div>

      <ConversationHistory messages={followupHistory} />

      {/* Followup input */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Followup
          </label>
          <button
            data-testid="error-mode-toggle"
            data-mode={followUpMode}
            type="button"
            onClick={toggleMode}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
              'border select-none',
              followUpMode === 'build'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                : 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
            )}
          >
            <ModeIcon className="h-3 w-3" />
            <span>{modeLabel}</span>
          </button>
        </div>
        <Textarea
          data-testid="error-followup-input"
          value={followUpText}
          onChange={(e) => setFollowUpText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Describe the fix or retry instructions… (Enter to send)"
          className="resize-y font-mono text-xs leading-relaxed"
        />
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          data-testid="error-cancel-btn"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="error-send-followup-btn"
          disabled={!followUpText.trim() || isSending}
          onClick={handleSendFollowup}
          className={cn(
            'gap-1.5',
            followUpMode === 'build'
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-violet-600 hover:bg-violet-700 text-white'
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {isSending ? 'Sending...' : 'Send'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

// ════════════════════════════════════════════════════════════════════
// QUESTION MODE
// ════════════════════════════════════════════════════════════════════

function QuestionModeContent({
  ticket,
  onClose,
  activeQuestion
}: {
  ticket: KanbanTicket
  onClose: () => void
  activeQuestion: QuestionRequest
}) {
  const handleReply = useCallback(async (requestId: string, answers: string[][]) => {
    try {
      const worktreePath = ticket.worktree_id ? findWorktreePathById(ticket.worktree_id) : null
      await window.opencodeOps.questionReply(requestId, answers, worktreePath || undefined)
      // Optimistically set session back to working so the progress bar resumes immediately
      if (ticket.current_session_id) {
        useWorktreeStatusStore.getState().setSessionStatus(
          ticket.current_session_id,
          ticket.mode === 'plan' ? 'planning' : 'working'
        )
      }
      onClose()
    } catch (err) {
      console.error('Failed to send answer:', err)
      toast.error('Failed to send answer')
    }
  }, [ticket.worktree_id, ticket.current_session_id, ticket.mode, onClose])

  const handleReject = useCallback(async (requestId: string) => {
    try {
      const worktreePath = ticket.worktree_id ? findWorktreePathById(ticket.worktree_id) : null
      await window.opencodeOps.questionReject(requestId, worktreePath || undefined)
      // Optimistically set session back to working so the progress bar resumes immediately
      if (ticket.current_session_id) {
        useWorktreeStatusStore.getState().setSessionStatus(
          ticket.current_session_id,
          ticket.mode === 'plan' ? 'planning' : 'working'
        )
      }
      onClose()
    } catch (err) {
      console.error('Failed to dismiss question:', err)
      toast.error('Failed to dismiss question')
    }
  }, [ticket.worktree_id, ticket.current_session_id, ticket.mode, onClose])

  return (
    <DialogContent data-testid="kanban-ticket-modal" className="sm:max-w-lg">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            Question from Agent
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription className="truncate">{ticket.title}</DialogDescription>
      </DialogHeader>
      <QuestionPrompt
        key={activeQuestion.id}
        request={activeQuestion}
        onReply={handleReply}
        onReject={handleReject}
      />
    </DialogContent>
  )
}

// ════════════════════════════════════════════════════════════════════
// CONVERSATION HISTORY
// ════════════════════════════════════════════════════════════════════

function ConversationHistory({ messages }: {
  messages: Array<{
    id: string
    content: string
    role: 'user' | 'assistant'
    mode: 'build' | 'plan'
    source: string
    created_at: string
  }>
}) {
  if (messages.length === 0) return null

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Conversation history
      </label>
      <div className="max-h-64 overflow-y-auto space-y-1.5 rounded-md border border-border/40 bg-muted/10 p-2">
        {messages.map((msg) => (
          <div key={msg.id} className={cn(
            'flex items-start gap-2 text-xs',
            msg.role === 'assistant' && 'bg-muted/30 rounded-md p-1.5 -mx-0.5'
          )}>
            <span className={cn(
              'shrink-0 mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              msg.role === 'assistant'
                ? 'bg-emerald-500/10 text-emerald-500'
                : msg.mode === 'build'
                  ? 'bg-blue-500/10 text-blue-500'
                  : 'bg-violet-500/10 text-violet-500'
            )}>
              {msg.role === 'assistant' ? 'ai' : msg.mode}
            </span>
            <p className="text-foreground/80 whitespace-pre-wrap break-words flex-1 font-mono leading-relaxed">
              {msg.content}
            </p>
            <span className="shrink-0 text-muted-foreground/50 text-[10px]">
              {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// JUMP TO SESSION BUTTON
// ════════════════════════════════════════════════════════════════════

function JumpToSessionButton({
  ticket,
  onClose
}: {
  ticket: KanbanTicket
  onClose: () => void
}) {
  const handleJump = useCallback(() => {
    if (!ticket.current_session_id) return

    // Switch off board view
    const kanbanStore = useKanbanStore.getState()
    if (kanbanStore.isBoardViewActive) {
      kanbanStore.toggleBoardView()
    }

    // Select the ticket's worktree
    if (ticket.worktree_id) {
      useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
    }

    // Focus the session tab
    useSessionStore.getState().setActiveSession(ticket.current_session_id)

    onClose()
  }, [ticket.current_session_id, ticket.worktree_id, onClose])

  if (!ticket.current_session_id) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="jump-to-session-btn"
      className="gap-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={handleJump}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      Jump to session
    </Button>
  )
}
