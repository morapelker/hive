import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Hammer, Map, Plus, GitBranch, Send, ChevronDown, Loader2, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { messageSendTimes, lastSendMode } from '@/lib/message-send-times'
import { PLAN_MODE_PREFIX } from '@/lib/constants'
import { toast } from '@/lib/toast'
import type { KanbanTicket } from '../../../../main/db/types'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'

// ── Types ───────────────────────────────────────────────────────────
type PickerMode = 'build' | 'plan'

interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

interface WorktreePickerModalProps {
  ticket: KanbanTicket
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful send to complete the column move */
  onSendComplete?: () => void
}

// ── Prompt template builders ────────────────────────────────────────
function buildPrompt(mode: PickerMode, ticket: KanbanTicket): string {
  const prefix =
    mode === 'build'
      ? 'Please implement the following ticket.'
      : 'Please review the following ticket and create a detailed implementation plan.'

  const description = ticket.description ?? ''
  return `${prefix}\n\n<ticket title="${ticket.title}">${description}</ticket>`
}

// ── Component ───────────────────────────────────────────────────────
export function WorktreePickerModal({
  ticket,
  projectId,
  open,
  onOpenChange,
  onSendComplete
}: WorktreePickerModalProps) {
  const [mode, setMode] = useState<PickerMode>('build')
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [isNewWorktree, setIsNewWorktree] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [sourceBranch, setSourceBranch] = useState<string | null>(null) // null = default
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchFilter, setBranchFilter] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)

  // ── Store access ────────────────────────────────────────────────
  const worktrees = useWorktreeStore(
    useCallback(
      (state) => state.worktreesByProject.get(projectId) ?? [],
      [projectId]
    )
  )

  const ticketsForProject = useKanbanStore(
    useCallback(
      (state) => state.tickets.get(projectId) ?? [],
      [projectId]
    )
  )

  const updateTicket = useKanbanStore((state) => state.updateTicket)
  const createSession = useSessionStore((state) => state.createSession)
  const createWorktreeFromBranch = useWorktreeStore((state) => state.createWorktreeFromBranch)

  const project = useProjectStore(
    useCallback(
      (state) => state.projects.find((p) => p.id === projectId) ?? null,
      [projectId]
    )
  )

  const defaultBranchName = useMemo(() => {
    const defaultWt = worktrees.find(w => w.is_default)
    return defaultWt?.branch_name ?? 'main'
  }, [worktrees])

  const worktreeNamePreview = useMemo(() => {
    return canonicalizeTicketTitle(ticket.title)
  }, [ticket.title])

  // ── Count in-progress tickets per worktree ──────────────────────
  const ticketCountByWorktree = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of ticketsForProject) {
      if (t.column === 'in_progress' && t.worktree_id) {
        counts[t.worktree_id] = (counts[t.worktree_id] || 0) + 1
      }
    }
    return counts
  }, [ticketsForProject])

  // ── Lazy branch loading ────────────────────────────────────────
  useEffect(() => {
    // branches.length guard: only fetch once per modal-open cycle (reset clears branches on close)
    if (!isNewWorktree || !project?.path || branches.length > 0) return
    setBranchesLoading(true)
    window.gitOps.listBranchesWithStatus(project.path)
      .then((result) => {
        if (result.success) setBranches(result.branches)
      })
      .catch(() => {
        // IPC failure — branches stay empty, user sees "No branches found"
      })
      .finally(() => setBranchesLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewWorktree, project?.path])

  // ── Reset state when modal opens ────────────────────────────────
  useEffect(() => {
    if (open) {
      setMode('build')
      // Auto-select the current worktree if it belongs to this project
      const { selectedWorktreeId: currentId, worktreesByProject } =
        useWorktreeStore.getState()
      const projectWts = worktreesByProject.get(projectId) ?? []
      const match = currentId ? projectWts.find((wt) => wt.id === currentId) : null
      setSelectedWorktreeId(match ? currentId : null)
      setIsNewWorktree(false)
      setPromptText(buildPrompt('build', ticket))
      setIsSending(false)
      setSourceBranch(null)
      setBranches([])
      setBranchFilter('')
      setBranchPopoverOpen(false)
    }
  }, [open, ticket, projectId])

  // ── Branch filtering ───────────────────────────────────────────
  const filteredBranches = useMemo(() => {
    const lower = branchFilter.toLowerCase()
    return branches
      .filter(b => b.name.toLowerCase().includes(lower))
      .sort((a, b) => {
        if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }, [branches, branchFilter])

  // ── Handle mode toggle ──────────────────────────────────────────
  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next = prev === 'build' ? 'plan' : 'build'
      setPromptText(buildPrompt(next, ticket))
      return next
    })
  }, [ticket])

  // ── Handle Tab key: toggle mode + focus prompt textarea ────────
  // Must use window-level capture-phase listener to beat SessionView's
  // global Tab handler which also uses capture and stops propagation.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (branchPopoverOpen) return  // Don't toggle mode while picking a branch
        e.preventDefault()
        e.stopImmediatePropagation()
        toggleMode()
        // Also focus the prompt textarea if it isn't already focused
        if (document.activeElement !== promptRef.current) {
          promptRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', handler, true) // capture phase
    return () => {
      window.removeEventListener('keydown', handler, true)
    }
  }, [open, toggleMode, branchPopoverOpen])

  // Keep React keydown for test compatibility (jsdom doesn't have capture-phase issues)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Tab') {
        if (branchPopoverOpen) return
        e.preventDefault()
        toggleMode()
        // Also focus the prompt textarea if it isn't already focused
        if (document.activeElement !== promptRef.current) {
          promptRef.current?.focus()
        }
      }
    },
    [toggleMode, branchPopoverOpen]
  )

  // ── Handle worktree selection ───────────────────────────────────
  const handleSelectWorktree = useCallback((wtId: string) => {
    setSelectedWorktreeId(wtId)
    setIsNewWorktree(false)
  }, [])

  const handleSelectNewWorktree = useCallback(() => {
    setSelectedWorktreeId(null)
    setIsNewWorktree(true)
  }, [])

  // ── Send flow ───────────────────────────────────────────────────
  const canSend = (selectedWorktreeId !== null || isNewWorktree) && !isSending

  const handleSend = useCallback(async () => {
    if (!canSend) return
    setIsSending(true)

    try {
      let worktreeId = selectedWorktreeId

      // Create new worktree if needed
      if (isNewWorktree && project) {
        const targetBranch = sourceBranch ?? defaultBranchName
        const nameHint = canonicalizeTicketTitle(ticket.title)
        const result = await createWorktreeFromBranch(
          projectId,
          project.path,
          project.name,
          targetBranch,
          nameHint || undefined
        )
        if (!result.success || !result.worktree?.id) {
          toast.error(result.error || 'Failed to create worktree')
          setIsSending(false)
          return
        }
        worktreeId = result.worktree.id
      }

      if (!worktreeId) {
        toast.error('No worktree selected')
        setIsSending(false)
        return
      }

      // Create session in the selected worktree
      const sessionResult = await createSession(worktreeId, projectId, undefined, mode)

      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error || 'Failed to create session')
        setIsSending(false)
        return
      }

      const sessionId = sessionResult.session.id
      const agentSdk = sessionResult.session.agent_sdk

      // Update the ticket with session info and move to in_progress
      const sortOrder = useKanbanStore
        .getState()
        .computeSortOrder(
          useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress'),
          0
        )

      await updateTicket(ticket.id, projectId, {
        current_session_id: sessionId,
        worktree_id: worktreeId,
        mode,
        column: 'in_progress',
        sort_order: sortOrder,
        plan_ready: false
      })

      // Close modal immediately — session starts in background
      onSendComplete?.()
      onOpenChange(false)
      toast.success('Session started')

      // ── Start the OpenCode session in the background ──────────
      // Resolve worktree path from the store
      const allWorktrees = Array.from(
        useWorktreeStore.getState().worktreesByProject.values()
      ).flat()
      const worktree = allWorktrees.find((w) => w.id === worktreeId)
      if (!worktree?.path) return

      // Connect to OpenCode to create the AI session
      const connectResult = await window.opencodeOps.connect(worktree.path, sessionId)
      if (!connectResult.success || !connectResult.sessionId) return

      // Persist the opencodeSessionId to Zustand + DB
      useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
      await window.db.session.update(sessionId, {
        opencode_session_id: connectResult.sessionId
      })

      // Set status tracking so the global listener can compute completion badges
      messageSendTimes.set(sessionId, Date.now())
      lastSendMode.set(sessionId, mode)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')

      // Send the prompt — apply plan mode prefix for opencode SDK
      if (promptText.trim()) {
        const skipPrefix = agentSdk === 'claude-code' || agentSdk === 'codex'
        const modePrefix = mode === 'plan' && !skipPrefix ? PLAN_MODE_PREFIX : ''
        const fullPrompt = modePrefix + promptText.trim()

        // Resolve model from the freshly-created session (mirrors SessionView.getModelForRequests)
        const sessionState = useSessionStore.getState()
        let sessionModel: { providerID: string; modelID: string; variant?: string } | undefined
        for (const sessions of sessionState.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found?.model_provider_id && found.model_id) {
            sessionModel = {
              providerID: found.model_provider_id,
              modelID: found.model_id,
              variant: found.model_variant ?? undefined
            }
            break
          }
        }
        if (!sessionModel) {
          sessionModel = resolveModelForSdk(agentSdk) ?? undefined
        }

        await window.opencodeOps.prompt(worktree.path, connectResult.sessionId, [
          { type: 'text', text: fullPrompt }
        ], sessionModel)
      }
    } catch {
      toast.error('Failed to start session')
    } finally {
      setIsSending(false)
    }
  }, [
    canSend,
    selectedWorktreeId,
    isNewWorktree,
    project,
    createWorktreeFromBranch,
    sourceBranch,
    defaultBranchName,
    projectId,
    createSession,
    mode,
    promptText,
    updateTicket,
    ticket.id,
    onSendComplete,
    onOpenChange
  ])

  // ── Mode toggle chip ────────────────────────────────────────────
  const ModeIcon = mode === 'build' ? Hammer : Map
  const modeLabel = mode === 'build' ? 'Build' : 'Plan'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="worktree-picker-modal"
        className="sm:max-w-[520px]"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="space-y-2.5 pb-1">
          <DialogTitle className="text-base">Start Session</DialogTitle>
          <DialogDescription>
            Pick a worktree for{' '}
            <span className="font-medium text-foreground">{ticket.title}</span>
          </DialogDescription>
          {/* Build/Plan chip toggle — below description to avoid overlapping the X close button */}
          <div>
            <button
              data-testid="wt-picker-mode-toggle"
              data-mode={mode}
              type="button"
              onClick={toggleMode}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors',
                'border select-none',
                mode === 'build'
                  ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                  : 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
              )}
              title={`${modeLabel} mode`}
              aria-label={`Current mode: ${modeLabel}. Click to switch`}
            >
              <ModeIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{modeLabel}</span>
            </button>
          </div>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Worktree list ──────────────────────────────────── */}
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Worktree
            </label>
            <div
              data-testid="worktree-list"
              className="max-h-[200px] overflow-y-auto rounded-lg border border-border/60"
            >
              {/* "New worktree" option — always at top */}
              <button
                data-testid="worktree-item-new"
                type="button"
                onClick={handleSelectNewWorktree}
                className={cn(
                  'flex w-full items-center gap-3 px-3.5 py-2.5 text-sm transition-colors',
                  'border-b border-border/40',
                  'hover:bg-muted/30',
                  isNewWorktree && 'bg-primary/8 ring-1 ring-inset ring-primary/20'
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                    'bg-primary/10 text-primary'
                  )}
                >
                  <Plus className="h-3.5 w-3.5" />
                </span>
                <span className="font-medium text-foreground">New worktree</span>
              </button>

              {isNewWorktree && (
                <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border/40 bg-muted/5">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">from</span>
                  <Popover open={branchPopoverOpen} onOpenChange={setBranchPopoverOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        data-testid="source-branch-trigger"
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border border-border/60 hover:bg-muted/30 transition-colors"
                      >
                        <GitBranch className="h-3 w-3 text-muted-foreground" />
                        <span className="truncate max-w-[180px]">
                          {sourceBranch ?? defaultBranchName}
                        </span>
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-0" align="start">
                      <div className="p-2 border-b border-border/40">
                        <div className="relative">
                          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                          <Input
                            placeholder="Filter branches..."
                            value={branchFilter}
                            onChange={(e) => setBranchFilter(e.target.value)}
                            className="pl-7 h-8 text-xs"
                            autoFocus
                          />
                        </div>
                      </div>
                      <div className="max-h-[200px] overflow-y-auto py-1">
                        {branchesLoading ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : filteredBranches.length === 0 ? (
                          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                            No branches found
                          </div>
                        ) : (
                          filteredBranches.map((branch) => (
                            <button
                              type="button"
                              key={`${branch.name}-${branch.isRemote}`}
                              data-testid={`source-branch-${branch.name}`}
                              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-muted/30 transition-colors"
                              onClick={() => {
                                setSourceBranch(branch.name)
                                setBranchPopoverOpen(false)
                                setBranchFilter('')
                              }}
                            >
                              <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="flex-1 truncate">{branch.name}</span>
                              {branch.isRemote && (
                                <span className="text-[10px] text-muted-foreground">remote</span>
                              )}
                              {branch.isCheckedOut && (
                                <span className="text-[10px] text-primary">active</span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                  {worktreeNamePreview && (
                    <span className="ml-auto text-xs text-muted-foreground font-mono truncate max-w-[180px]">
                      {worktreeNamePreview}
                    </span>
                  )}
                </div>
              )}

              {/* Existing worktrees */}
              {worktrees.map((wt) => {
                const count = ticketCountByWorktree[wt.id] || 0
                const isSelected = selectedWorktreeId === wt.id

                return (
                  <button
                    key={wt.id}
                    data-testid={`worktree-item-${wt.id}`}
                    type="button"
                    onClick={() => handleSelectWorktree(wt.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2.5 text-sm transition-colors',
                      'border-b border-border/40 last:border-b-0',
                      'hover:bg-muted/30',
                      isSelected && 'bg-primary/8 ring-1 ring-inset ring-primary/20'
                    )}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                      <GitBranch className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex-1 truncate text-left font-medium text-foreground">
                      {wt.name}
                    </span>
                    {wt.is_default && (
                      <span className="rounded-full bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        default
                      </span>
                    )}
                    {count > 0 && (
                      <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-500/10 px-1.5 text-[11px] font-medium text-blue-500">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Prompt preview / editor ────────────────────────── */}
          <div className="space-y-2">
            <label
              htmlFor="wt-picker-prompt-input"
              className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Prompt
            </label>
            <Textarea
              id="wt-picker-prompt-input"
              ref={promptRef}
              data-testid="wt-picker-prompt"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={6}
              className="resize-y font-mono text-xs leading-relaxed"
              placeholder="Enter prompt for the session..."
            />
          </div>
        </div>

        <DialogFooter className="pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="wt-picker-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="wt-picker-send-btn"
            disabled={!canSend}
            onClick={handleSend}
            className={cn(
              'gap-1.5',
              mode === 'build'
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-violet-600 hover:bg-violet-700 text-white'
            )}
          >
            <Send className="h-3.5 w-3.5" />
            {isSending ? 'Starting...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
