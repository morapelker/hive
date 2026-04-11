import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Hammer, Map, Sparkles, Plus, GitBranch, Send, ChevronDown, Loader2, Search } from 'lucide-react'
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
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { CodexFastToggle } from '@/components/sessions/CodexFastToggle'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX, isPlanLike } from '@/lib/constants'
import { toast } from '@/lib/toast'
import type { KanbanTicket } from '../../../../main/db/types'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'

// Stable empty array to avoid referential-inequality loops in Zustand selectors
const EMPTY_ARRAY: readonly never[] = []

// ── Types ───────────────────────────────────────────────────────────
type PickerMode = 'build' | 'plan' | 'super-plan'

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
  /** When true, only assigns worktree_id without creating a session or moving columns */
  preAssignOnly?: boolean
  /** When set, operates in connection mode — no worktree selection, uses connection path */
  connectionId?: string
}

/** In-memory: last-chosen source branch per project (resets on app restart) */
const _lastSourceBranchByProject: Record<string, string> = {}

/** @internal — for test cleanup only */
export function _resetLastSourceBranch(): void {
  for (const key of Object.keys(_lastSourceBranchByProject)) {
    delete _lastSourceBranchByProject[key]
  }
}

// ── Prompt template builders ────────────────────────────────────────
function getModePrefix(mode: PickerMode): string {
  return mode === 'build'
    ? 'Please implement the following ticket.'
    : 'Please review the following ticket and create a detailed implementation plan.'
}

function swapModePrefix(text: string, fromMode: PickerMode, toMode: PickerMode): string {
  const fromPrefix = getModePrefix(fromMode)
  const toPrefix = getModePrefix(toMode)
  if (fromPrefix === toPrefix) return text          // plan ↔ super-plan: same prefix
  if (text.startsWith(fromPrefix)) {
    return toPrefix + text.slice(fromPrefix.length)  // swap prefix, keep the rest
  }
  return text                                        // prefix not found: don't touch
}

function buildPrompt(mode: PickerMode, ticket: KanbanTicket): string {
  const prefix = getModePrefix(mode)
  const description = ticket.description ?? ''
  const attachments = (ticket.attachments ?? []) as Array<{ type: string; url: string; label: string }>

  let attachmentsXml = ''
  if (attachments.length > 0) {
    const items: string[] = []
    for (const a of attachments) {
      if (a.type === 'image' || a.type === 'file') {
        items.push(`<file path="${a.url}">${a.label}</file>`)
      } else {
        items.push(`<link type="${a.type}" url="${a.url}">${a.label}</link>`)
      }
    }
    attachmentsXml = `\n<attachments>\n${items.join('\n')}\n</attachments>`
  }

  return `${prefix}\n\n<ticket title="${ticket.title}">${description}${attachmentsXml}</ticket>`
}

// ── Component ───────────────────────────────────────────────────────
export function WorktreePickerModal({
  ticket,
  projectId,
  open,
  onOpenChange,
  onSendComplete,
  preAssignOnly = false,
  connectionId
}: WorktreePickerModalProps) {
  const isConnectionMode = !!connectionId
  const [mode, setMode] = useState<PickerMode>('build')
  const [superArmed, setSuperArmed] = useState(false)
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
  const [selectedModel, setSelectedModel] = useState<{
    providerID: string; modelID: string; variant?: string
  } | null>(null)
  const [selectedSdk, setSelectedSdk] = useState<'opencode' | 'claude-code' | 'codex' | null>(null)

  // ── Store access ────────────────────────────────────────────────
  const worktrees = useWorktreeStore(
    useCallback(
      (state) => state.worktreesByProject.get(projectId) ?? EMPTY_ARRAY,
      [projectId]
    )
  )

  const ticketsForProject = useKanbanStore(
    useCallback(
      (state) => state.tickets.get(projectId) ?? EMPTY_ARRAY,
      [projectId]
    )
  )

  const updateTicket = useKanbanStore((state) => state.updateTicket)
  const createSession = useSessionStore((state) => state.createSession)
  const createWorktreeFromBranch = useWorktreeStore((state) => state.createWorktreeFromBranch)
  const syncWorktrees = useWorktreeStore((state) => state.syncWorktrees)

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

  // ── SDK / Model resolution ──────────────────────────────────────
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'opencode'
  const codexFastMode = useSettingsStore((s) => s.codexFastMode)
  const codexFastModeAccepted = useSettingsStore((s) => s.codexFastModeAccepted)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const defaultSdkNormalized = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
  const agentSdk = selectedSdk ?? defaultSdkNormalized

  const autoResolvedModel = useMemo(() => {
    const settings = useSettingsStore.getState()
    // Priority 1: mode-specific default
    const modeModel = settings.getModelForMode(mode)
    if (modeModel) return modeModel
    // Priority 2: per-provider / global default
    return resolveModelForSdk(agentSdk) ?? null
  }, [mode, agentSdk])

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
        if (result.success) {
          setBranches(result.branches)
          const remembered = _lastSourceBranchByProject[projectId]
          if (remembered && !result.branches.some(b => b.name === remembered)) {
            setSourceBranch(null)
          }
        }
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
      // Default to "New worktree" — it's the most common choice when starting work
      setSelectedWorktreeId(null)
      setIsNewWorktree(true)
      setPromptText(buildPrompt('build', ticket))
      setIsSending(false)
      setSelectedModel(null)
      setSelectedSdk(null)
      setSourceBranch(_lastSourceBranchByProject[projectId] ?? null)
      setBranches([])
      setBranchFilter('')
      setBranchPopoverOpen(false)
      // Refresh worktree list from git so the picker shows current state
      if (project?.path) {
        syncWorktrees(projectId, project.path)
      }
    }
  }, [open, ticket, projectId, project?.path, syncWorktrees])

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

  // ── Handle SDK change ───────────────────────────────────────────
  const handleSdkChange = useCallback((sdk: 'opencode' | 'claude-code' | 'codex') => {
    setSelectedSdk(sdk)
    setSelectedModel(null)  // reset model — new SDK has different models
  }, [])

  // ── Handle mode toggle ──────────────────────────────────────────
  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next: PickerMode = prev === 'build'
        ? (superArmed ? 'super-plan' : 'plan')
        : 'build'
      setPromptText((current) => swapModePrefix(current, prev, next))
      return next
    })
  }, [superArmed])

  // ── Handle SUPER toggle ─────────────────────────────────────────
  const toggleSuper = useCallback(() => {
    if (mode === 'plan') {
      setMode('super-plan')
      setSuperArmed(true)
    } else if (mode === 'super-plan') {
      setMode('plan')
      setSuperArmed(false)
    }
  }, [mode])

  // ── Handle Tab key: toggle mode + focus prompt textarea ────────
  // Must use window-level capture-phase listener to beat SessionView's
  // global Tab handler which also uses capture and stops propagation.
  useEffect(() => {
    if (!open || preAssignOnly) return
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
  }, [open, toggleMode, branchPopoverOpen, preAssignOnly])

  // Keep React keydown for test compatibility (jsdom doesn't have capture-phase issues)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Tab' && !preAssignOnly) {
        if (branchPopoverOpen) return
        e.preventDefault()
        toggleMode()
        // Also focus the prompt textarea if it isn't already focused
        if (document.activeElement !== promptRef.current) {
          promptRef.current?.focus()
        }
      }
    },
    [toggleMode, branchPopoverOpen, preAssignOnly]
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
  const canSend = isConnectionMode
    ? !isSending
    : (selectedWorktreeId !== null || isNewWorktree) && !isSending

  const handleSend = useCallback(async () => {
    if (!canSend) return
    setIsSending(true)

    // ── Connection mode path ──────────────────────────────────────
    if (isConnectionMode && connectionId) {
      try {
        // Create connection session
        const createConnectionSession = useSessionStore.getState().createConnectionSession
        const sessionResult = await createConnectionSession(connectionId, agentSdk, mode)

        if (!sessionResult.success || !sessionResult.session) {
          toast.error(sessionResult.error || 'Failed to create session')
          setIsSending(false)
          return
        }

        const sessionId = sessionResult.session.id
        const sessionAgentSdk = sessionResult.session.agent_sdk

        // Set status tracking immediately so the sidebar shows spinning right away.
        messageSendTimes.set(sessionId, Date.now())
        userExplicitSendTimes.set(sessionId, Date.now())
        snapshotTokenBaseline(sessionId)
        lastSendMode.set(sessionId, mode)
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

        // Apply model override
        const effectiveModel = selectedModel ?? autoResolvedModel ?? undefined
        if (selectedModel) {
          await useSessionStore.getState().setSessionModel(sessionId, selectedModel)
        }

        // Update ticket — worktree_id stays null for connection sessions
        const sortOrder = useKanbanStore.getState().computeSortOrder(
          useKanbanStore.getState().getTicketsByColumnForConnection(connectionId, 'in_progress'),
          0
        )

        await updateTicket(ticket.id, ticket.project_id, {
          current_session_id: sessionId,
          worktree_id: null,
          mode,
          column: 'in_progress',
          sort_order: sortOrder,
          plan_ready: false
        })

        // Trigger usage refresh so the board shows up-to-date usage (debounced in store)
        useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(agentSdk))

        // Close modal
        onSendComplete?.()
        onOpenChange(false)
        toast.success('Session started')

        // Connect to opencode using connection path
        const connectionPath = useConnectionStore.getState().connections.find(c => c.id === connectionId)?.path
        if (!connectionPath) return

        const connectResult = await window.opencodeOps.connect(connectionPath, sessionId)
        if (!connectResult.success || !connectResult.sessionId) return

        useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
        await window.db.session.update(sessionId, { opencode_session_id: connectResult.sessionId })

        // Send prompt
        if (promptText.trim()) {
          const skipPrefix = sessionAgentSdk === 'claude-code' || sessionAgentSdk === 'codex'
          const modePrefix = mode === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
            : mode === 'plan' && !skipPrefix ? PLAN_MODE_PREFIX
            : ''
          const fullPrompt = modePrefix + promptText.trim()
          const promptOptions =
            sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

          if (mode === 'super-plan') {
            useSessionStore.getState().setSessionMode(sessionId, 'plan')
          }

          await window.opencodeOps.prompt(connectionPath, connectResult.sessionId, [
            { type: 'text', text: fullPrompt }
          ], effectiveModel, promptOptions)
        }
        return  // Done with connection path
      } catch {
        toast.error('Failed to start session')
      } finally {
        setIsSending(false)
      }
      return  // Don't fall through to worktree logic
    }

    try {
      let worktreeId = selectedWorktreeId

      // ── Pre-assign path: only set worktree_id, no session ────────
      if (preAssignOnly) {
        // Create new worktree if needed
        if (isNewWorktree && project) {
          const targetBranch = sourceBranch ?? defaultBranchName
          _lastSourceBranchByProject[projectId] = targetBranch
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

        // If the worktree already has sessions, auto-attach the most recent one
        // so the ticket tracks session lifecycle (progress bar, auto-advance).
        const existingSessions = useSessionStore.getState().sessionsByWorktree.get(worktreeId) || []
        const activeSession = existingSessions[0]
        if (activeSession) {
          await updateTicket(ticket.id, projectId, {
            worktree_id: worktreeId,
            current_session_id: activeSession.id,
            mode: (activeSession.mode as 'build' | 'plan') || 'build',
            plan_ready: false
          })
        } else {
          await updateTicket(ticket.id, projectId, { worktree_id: worktreeId })
        }
        onOpenChange(false)
        toast.success('Worktree assigned')
        return
      }

      // Create new worktree if needed
      if (isNewWorktree && project) {
        const targetBranch = sourceBranch ?? defaultBranchName
        _lastSourceBranchByProject[projectId] = targetBranch
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
      const sessionResult = await createSession(worktreeId, projectId, agentSdk, mode)

      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error || 'Failed to create session')
        setIsSending(false)
        return
      }

      const sessionId = sessionResult.session.id
      const sessionAgentSdk = sessionResult.session.agent_sdk

      // Set status tracking immediately so the sidebar shows spinning right away.
      // This must happen before any async work (connect, prompt) to avoid a race
      // where loadSessions wipes the session from sessionsByWorktree before the
      // status is set.
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, mode)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

      // Apply user's model override to the session if they explicitly picked one
      const effectiveModel = selectedModel ?? autoResolvedModel ?? undefined
      if (selectedModel) {
        await useSessionStore.getState().setSessionModel(sessionId, selectedModel)
      }

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

      // Trigger usage refresh so the board shows up-to-date usage (debounced in store)
      useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(agentSdk))

      // In sticky-tab mode, stay on the board instead of switching to the new session
      if (useSettingsStore.getState().boardMode === 'sticky-tab') {
        const { BOARD_TAB_ID } = await import('@/stores/useSessionStore')
        useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
      }

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

      // Send the prompt — apply plan mode prefix for opencode SDK
      if (promptText.trim()) {
        const skipPrefix = sessionAgentSdk === 'claude-code' || sessionAgentSdk === 'codex'
        const modePrefix =
          mode === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
          : mode === 'plan' && !skipPrefix ? PLAN_MODE_PREFIX
          : ''
        const fullPrompt = modePrefix + promptText.trim()
        const promptOptions =
          sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

        // Auto-revert super-plan → plan immediately (one-shot mode).
        // The prefix is already captured in fullPrompt above.
        if (mode === 'super-plan') {
          useSessionStore.getState().setSessionMode(sessionId, 'plan')
        }

        await window.opencodeOps.prompt(worktree.path, connectResult.sessionId, [
          { type: 'text', text: fullPrompt }
        ], effectiveModel, promptOptions)
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
    agentSdk,
    mode,
    promptText,
    updateTicket,
    ticket.id,
    ticket.title,
    ticket.project_id,
    onSendComplete,
    onOpenChange,
    preAssignOnly,
    selectedModel,
    autoResolvedModel,
    codexFastMode,
    isConnectionMode,
    connectionId
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
          <DialogTitle className="text-base">
            {preAssignOnly ? 'Assign Worktree' : 'Start Session'}
          </DialogTitle>
          <DialogDescription>
            {preAssignOnly ? 'Pre-assign a worktree to' : isConnectionMode ? 'Start a session for' : 'Pick a worktree for'}{' '}
            <span className="font-medium text-foreground">{ticket.title}</span>
          </DialogDescription>
          {/* Build/Plan chip toggle — below description to avoid overlapping the X close button */}
          {!preAssignOnly && <div className="flex items-center gap-1.5">
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
            <div
              className={cn(
                'transition-all duration-200 overflow-hidden',
                mode === 'plan' || mode === 'super-plan'
                  ? 'opacity-100 translate-x-0 max-w-[80px]'
                  : 'opacity-0 -translate-x-2 max-w-0 pointer-events-none'
              )}
            >
              <button
                type="button"
                onClick={toggleSuper}
                aria-pressed={mode === 'super-plan'}
                aria-label={`Super mode ${mode === 'super-plan' ? 'enabled' : 'disabled'}`}
                data-testid="wt-picker-super-toggle"
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
                  'border select-none whitespace-nowrap',
                  mode === 'super-plan'
                    ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20 super-sparkle'
                    : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                SUPER
              </button>
            </div>
          </div>}
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Worktree list (hidden in connection mode) ────── */}
          {!isConnectionMode && <div className="space-y-2">
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
                                _lastSourceBranchByProject[projectId] = branch.name
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
          </div>}

          {/* ── Provider & Model picker (hidden in pre-assign mode) ── */}
          {!preAssignOnly && (
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Provider & Model
              </label>
              {/* SDK toggle — only when 2+ SDKs are available */}
              {availableAgentSdks && (
                [availableAgentSdks.opencode, availableAgentSdks.claude, availableAgentSdks.codex].filter(Boolean).length >= 2
              ) && (
                <div className="flex gap-1.5" data-testid="sdk-toggle">
                  {availableAgentSdks.opencode && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-opencode"
                      onClick={() => handleSdkChange('opencode')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'opencode'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      OpenCode
                    </button>
                  )}
                  {availableAgentSdks.claude && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-claude-code"
                      onClick={() => handleSdkChange('claude-code')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'claude-code'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      Claude Code
                    </button>
                  )}
                  {availableAgentSdks.codex && (
                    <button
                      type="button"
                      data-testid="sdk-toggle-codex"
                      onClick={() => handleSdkChange('codex')}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        agentSdk === 'codex'
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
                      )}
                    >
                      Codex
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="min-w-0">
                  <ModelSelector
                    value={selectedModel ?? autoResolvedModel}
                    onChange={setSelectedModel}
                    agentSdkOverride={agentSdk}
                  />
                </div>
                {agentSdk === 'codex' && (
                  <div className="shrink-0">
                    <CodexFastToggle
                      enabled={codexFastMode}
                      accepted={codexFastModeAccepted}
                      onToggle={() => updateSetting('codexFastMode', !codexFastMode)}
                      onAccept={() => updateSetting('codexFastModeAccepted', true)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Prompt preview / editor (hidden in pre-assign mode) ── */}
          {!preAssignOnly && (
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
          )}
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
              preAssignOnly
                ? ''
                : mode === 'build'
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-violet-600 hover:bg-violet-700 text-white'
            )}
          >
            {preAssignOnly ? (
              <>
                <GitBranch className="h-3.5 w-3.5" />
                {isSending ? 'Assigning...' : 'Assign'}
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                {isSending ? 'Starting...' : 'Send'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
