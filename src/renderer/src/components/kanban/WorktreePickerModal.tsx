import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  Hammer,
  Map,
  Plus,
  GitBranch,
  Send,
  ChevronDown,
  Loader2,
  Search,
  Check,
  X
} from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { cn } from '@/lib/utils'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSettingsStore, resolveModelForSdk, type SelectedModel } from '@/stores/useSettingsStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { CodexFastToggle } from '@/components/sessions/CodexFastToggle'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { autoPinBaseWorktree } from '@/lib/auto-pin'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix, isPlanLike } from '@/lib/constants'
import { toast } from '@/lib/toast'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { gitApi } from '@/api/git-api'
import { remoteLaunchApi } from '@/api/remote-launch-api'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import type { KanbanTicket, Session } from '../../../../main/db/types'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { supportsGoalMode } from '@shared/types/agent-sdk'
import { createPlanFile, exceedsGoalPromptLimit, planFilePrompt } from '@/lib/goal-plan-file'
import {
  REMOTE_LAUNCH_STEPS,
  type RemoteLaunchModelSelection,
  type RemoteLaunchMode,
  type RemoteLaunchPreflightResult,
  type RemoteLaunchStep
} from '@shared/types/remote-launch'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import { runMultiModelLaunch, type MultiModelLaunchPlan } from '@/lib/multi-model-launch'
import { resolveBadgeModel, type LaunchModelConfig } from '@/lib/ticket-launch'
import type { AvailableAgentSdks } from '@/lib/agent-sdk-availability'

// Stable empty array to avoid referential-inequality loops in Zustand selectors
const EMPTY_ARRAY: readonly never[] = []

// ── Types ───────────────────────────────────────────────────────────
type PickerMode = 'build' | 'plan' | 'super-plan'
type PickerAgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'

function completionSendMode(mode: PickerMode): 'build' | 'plan' {
  return isPlanLike(mode) ? 'plan' : 'build'
}

interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

/** Labels for the 7-step remote-launch checklist, in `REMOTE_LAUNCH_STEPS` order. */
const REMOTE_LAUNCH_STEP_LABELS: Record<RemoteLaunchStep, string> = {
  connect: 'Connect',
  'branch-check': 'Check branch',
  clone: 'Clone project',
  worktree: 'Create worktree',
  'file-transfer': 'Transfer files',
  'setup-script': 'Run setup script',
  launch: 'Launch session'
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
  /** When true, serializes config as JSON on the ticket instead of creating a session */
  saveConfigOnly?: boolean
}

/** In-memory: last-chosen source branch per project (resets on app restart) */
const _lastSourceBranchByProject: Record<string, string> = {}

/**
 * In-memory: launchId of a FAILED remote launch per ticket. Reopening the
 * modal after a failure reuses it so the whole server-side idempotency chain
 * (client-session reuse, prepare reuse, setupAppliedAt, live-tmux
 * short-circuit) still applies — a fresh id would start a second remote
 * worktree/session next to the first attempt's leftovers. Cleared on success
 * so an intentional relaunch of the same ticket gets a fresh id.
 * (A plain record — this module imports lucide's `Map` icon, which shadows
 * the global Map constructor.)
 */
const _failedRemoteLaunchIdByTicket: Record<string, string> = {}

/** @internal — for test cleanup only */
export function _resetLastSourceBranch(): void {
  for (const key of Object.keys(_lastSourceBranchByProject)) {
    delete _lastSourceBranchByProject[key]
  }
  for (const key of Object.keys(_failedRemoteLaunchIdByTicket)) {
    delete _failedRemoteLaunchIdByTicket[key]
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
  if (fromPrefix === toPrefix) return text // plan ↔ super-plan: same prefix
  if (text.startsWith(fromPrefix)) {
    return toPrefix + text.slice(fromPrefix.length) // swap prefix, keep the rest
  }
  return text // prefix not found: don't touch
}

function buildPrompt(mode: PickerMode, ticket: KanbanTicket): string {
  const prefix = getModePrefix(mode)
  const description = ticket.description ?? ''
  const attachments = (ticket.attachments ?? []) as Array<{
    type: string
    url: string
    label: string
  }>

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

function wrapGoalPrompt(prompt: string, criteria: string): string {
  const stripped = prompt.replace(/^\/goal\s+/, '')
  return `/goal ${stripped}. Goal success criteria: ${criteria}`
}

function composePromptForSdk(
  mode: PickerMode,
  sessionAgentSdk: string | null | undefined,
  prompt: string,
  goalMode: boolean,
  goalCriteria: string,
  options: { claudeCli: boolean }
): string | null {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) return null

  const skipPrefix =
    options.claudeCli ||
    sessionAgentSdk === 'claude-code' ||
    sessionAgentSdk === 'codex' ||
    sessionAgentSdk === 'claude-code-cli'
  const modePrefix =
    mode === 'super-plan'
      ? getSuperPlanModePrefix(sessionAgentSdk)
      : mode === 'plan' && !skipPrefix
        ? PLAN_MODE_PREFIX
        : ''
  const fullPrompt = modePrefix + trimmedPrompt

  return goalMode && goalCriteria.trim()
    ? wrapGoalPrompt(fullPrompt, goalCriteria.trim())
    : fullPrompt
}

// Matches the `\n<attachments>...\n</attachments>` block `buildPrompt` inserts
// before the closing `</ticket>` tag, so it can be stripped from prefilled
// text a user has since edited (attachments aren't sent to remote launches).
const ATTACHMENTS_BLOCK_RE = /\n<attachments>[\s\S]*?<\/attachments>/g

function stripAttachmentsBlock(text: string): string {
  return text.replace(ATTACHMENTS_BLOCK_RE, '')
}

/**
 * Compose the outbound prompt for a remote launch (always claude-code-cli,
 * goal mode off). If the caller's `editedPrompt` still matches the unedited
 * prefill for `mode` (i.e. the user never touched the textarea beyond the
 * automatic mode-prefix swap), attachments are dropped by rebuilding the
 * prompt from an attachment-less ticket. Otherwise the edited text is used
 * verbatim, with any embedded `<attachments>` block stripped.
 */
export function buildRemotePrompt(
  mode: 'build' | 'plan',
  ticket: KanbanTicket,
  editedPrompt: string
): string {
  const prefilled = buildPrompt(mode, ticket)
  const basePrompt =
    editedPrompt === prefilled
      ? buildPrompt(mode, { ...ticket, attachments: [] })
      : stripAttachmentsBlock(editedPrompt)

  return (
    composePromptForSdk(mode, 'claude-code-cli', basePrompt, false, '', { claudeCli: true }) ?? ''
  )
}

// Oversized goal prompts get rejected by the CLI. When the composed goal prompt
// exceeds the limit, persist the full ticket prompt as PLAN_{uuid}.md in the
// session root and swap the prompt body for "Implement PLAN_{uuid}.md" — the
// /goal wrapper and success criteria stay as-is. Returns the prompt text to
// compose the outbound prompt from.
async function convertOversizedGoalPrompt(
  promptText: string,
  composedGoalPrompt: string | null,
  rootPath: string | null | undefined
): Promise<string> {
  if (!exceedsGoalPromptLimit(composedGoalPrompt) || !rootPath) return promptText
  const fileName = await createPlanFile(rootPath, promptText.trim())
  return planFilePrompt(fileName)
}

// Strip a SelectedModel down to the shape the prompt RPC accepts. The renderer's
// model objects carry an extra `agentSdk` field used for SDK routing, but the
// `opencodeOps.prompt` model schema is .strict() and rejects unknown keys — so
// passing the raw model fails with "RPC parameters failed validation".
function toRequestModel(
  model: { providerID: string; modelID: string; variant?: string } | undefined
): { providerID: string; modelID: string; variant?: string } | undefined {
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
}

// One extra provider/model launched alongside the existing row-1 controls.
interface ExtraModelRow {
  key: string // crypto.randomUUID() — stable React key
  sdk: PickerAgentSdk
  model: SelectedModel | null // null = resolve for that row's sdk at launch
  codexFastMode: boolean // per-row; seeded from the global codexFastMode
}

// Resolve a row's display/launch-default model. Never inherits another SDK's
// default: the mode default only wins when it's already for this SDK, otherwise
// the per-SDK resolution then the hard SDK fallback.
function resolveRowDefaultModel(sdk: PickerAgentSdk, mode: PickerMode): SelectedModel {
  const settings = useSettingsStore.getState()
  const modeModel = settings.getModelForMode(mode)
  if (modeModel && modeModel.agentSdk === sdk) return modeModel
  const resolved = resolveModelForSdk(sdk) ?? FALLBACK_MODELS[sdk]
  return { providerID: resolved.providerID, modelID: resolved.modelID, variant: resolved.variant }
}

// ── SDK toggle button group (shared by row 1 and each extra row) ────
interface SdkToggleGroupProps {
  value: PickerAgentSdk
  onChange: (sdk: PickerAgentSdk) => void
  availableAgentSdks: AvailableAgentSdks | null
  idPrefix: string
  disabled?: boolean
  disabledTitle?: string
}

function SdkToggleGroup({
  value,
  onChange,
  availableAgentSdks,
  idPrefix,
  disabled,
  disabledTitle
}: SdkToggleGroupProps): React.JSX.Element | null {
  // Only render when 2+ SDKs are available (a single SDK has nothing to toggle).
  const buttonCount = availableAgentSdks
    ? [
        availableAgentSdks.opencode,
        availableAgentSdks.claude,
        availableAgentSdks.codex,
        availableAgentSdks.claude
      ].filter(Boolean).length
    : 0
  if (!availableAgentSdks || buttonCount < 2) return null

  const buttonClass = (active: boolean): string =>
    cn(
      'px-2.5 py-1 rounded-md text-xs border transition-colors',
      'disabled:opacity-40 disabled:cursor-not-allowed',
      active
        ? 'bg-primary text-primary-foreground border-primary'
        : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
    )
  const buttonTitle = disabled ? disabledTitle : undefined

  return (
    <div className="flex gap-1.5" data-testid={idPrefix}>
      {availableAgentSdks.opencode && (
        <button
          type="button"
          data-testid={`${idPrefix}-opencode`}
          onClick={() => onChange('opencode')}
          disabled={disabled}
          aria-pressed={value === 'opencode'}
          title={buttonTitle}
          className={buttonClass(value === 'opencode')}
        >
          OpenCode
        </button>
      )}
      {availableAgentSdks.claude && (
        <button
          type="button"
          data-testid={`${idPrefix}-claude-code`}
          onClick={() => onChange('claude-code')}
          disabled={disabled}
          aria-pressed={value === 'claude-code'}
          title={buttonTitle}
          className={buttonClass(value === 'claude-code')}
        >
          Claude Code
        </button>
      )}
      {availableAgentSdks.codex && (
        <button
          type="button"
          data-testid={`${idPrefix}-codex`}
          onClick={() => onChange('codex')}
          disabled={disabled}
          aria-pressed={value === 'codex'}
          title={buttonTitle}
          className={buttonClass(value === 'codex')}
        >
          Codex
        </button>
      )}
      {availableAgentSdks.claude && (
        <button
          type="button"
          data-testid={`${idPrefix}-claude-code-cli`}
          onClick={() => onChange('claude-code-cli')}
          disabled={disabled}
          aria-pressed={value === 'claude-code-cli'}
          title={buttonTitle}
          className={buttonClass(value === 'claude-code-cli')}
        >
          Claude CLI
        </button>
      )}
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────
export function WorktreePickerModal({
  ticket,
  projectId,
  open,
  onOpenChange,
  onSendComplete,
  preAssignOnly = false,
  connectionId,
  saveConfigOnly = false
}: WorktreePickerModalProps) {
  const isConnectionMode = !!connectionId
  const [mode, setMode] = useState<PickerMode>('build')
  const [superArmed, setSuperArmed] = useState(false)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [isNewWorktree, setIsNewWorktree] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [goalMode, setGoalMode] = useState(false)
  const [goalCriteria, setGoalCriteria] = useState('')
  // A ticket that already carries a goal re-arms the switch on open. The
  // stored criteria waits here until the goal switch is actually available
  // (build mode + a goal-capable SDK) and is applied once per open, so a
  // manual uncheck is never overridden.
  const goalPrefillRef = useRef<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [sourceBranch, setSourceBranch] = useState<string | null>(null) // null = default
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchFilter, setBranchFilter] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<{
    agentSdk?: PickerAgentSdk
    providerID: string
    modelID: string
    variant?: string
  } | null>(null)
  const [selectedSdk, setSelectedSdk] = useState<PickerAgentSdk | null>(null)
  const [extraModelRows, setExtraModelRows] = useState<ExtraModelRow[]>([])

  // ── Remote launch state ──────────────────────────────────────────
  const [runOnRemote, setRunOnRemote] = useState(false)
  const [remotePreflight, setRemotePreflight] = useState<RemoteLaunchPreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [remotePhase, setRemotePhase] = useState<'idle' | 'launching' | 'failed'>('idle')
  const [remoteProgress, setRemoteProgress] = useState<
    Partial<Record<RemoteLaunchStep, 'running' | 'done' | 'error'>>
  >({})
  const [remoteError, setRemoteError] = useState<{
    step: RemoteLaunchStep
    message: string
  } | null>(null)
  const launchIdRef = useRef<string>('')
  const remoteUnsubRef = useRef<(() => void) | null>(null)

  // ── Store access ────────────────────────────────────────────────
  const worktrees = useWorktreeStore(
    useCallback((state) => state.worktreesByProject.get(projectId) ?? EMPTY_ARRAY, [projectId])
  )

  const ticketsForProject = useKanbanStore(
    useCallback((state) => state.tickets.get(projectId) ?? EMPTY_ARRAY, [projectId])
  )

  const updateTicket = useKanbanStore((state) => state.updateTicket)
  const createSession = useSessionStore((state) => state.createSession)
  const createWorktreeFromBranch = useWorktreeStore((state) => state.createWorktreeFromBranch)
  const syncWorktrees = useWorktreeStore((state) => state.syncWorktrees)

  const project = useProjectStore(
    useCallback((state) => state.projects.find((p) => p.id === projectId) ?? null, [projectId])
  )

  const defaultBranchName = useMemo(() => {
    const defaultWt = worktrees.find((w) => w.is_default)
    return defaultWt?.branch_name ?? 'main'
  }, [worktrees])

  // The branch a new worktree — local or remote — would be created from:
  // the user's explicit pick, else the same default the branch picker shows.
  const resolvedSourceBranch = sourceBranch ?? defaultBranchName

  // The picker names remote-only branches `origin/<branch>`; the server
  // strips that prefix before git operations, so user-facing remote copy
  // must too — otherwise it reads "origin/origin/<branch>".
  const remoteBranchDisplay = resolvedSourceBranch.startsWith('origin/')
    ? resolvedSourceBranch.slice('origin/'.length)
    : resolvedSourceBranch

  const worktreeNamePreview = useMemo(() => {
    return canonicalizeTicketTitle(ticket.title)
  }, [ticket.title])

  // ── SDK / Model resolution ──────────────────────────────────────
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'opencode'
  const codexFastMode = useSettingsStore((s) => s.codexFastMode)
  const codexFastModeAccepted = useSettingsStore((s) => s.codexFastModeAccepted)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const teleport = useSettingsStore((s) => s.teleport)
  const defaultSdkNormalized = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
  const baseAgentSdk = selectedSdk ?? defaultSdkNormalized

  const autoResolvedModel = useMemo(() => {
    const settings = useSettingsStore.getState()
    // Remote launches always run claude-code-cli — resolve against that SDK
    // regardless of what's actually selected, so a leftover default from a
    // different SDK never leaks into the remote payload.
    const effectiveSelectedSdk = runOnRemote ? 'claude-code-cli' : selectedSdk
    // Priority 1: mode-specific default
    const modeModel = settings.getModelForMode(mode)
    if (modeModel && (!effectiveSelectedSdk || modeModel.agentSdk === effectiveSelectedSdk)) {
      return modeModel
    }
    // Priority 2: per-provider / global default
    return resolveModelForSdk(runOnRemote ? 'claude-code-cli' : baseAgentSdk) ?? null
  }, [mode, baseAgentSdk, selectedSdk, runOnRemote])

  const agentSdk =
    selectedSdk ?? selectedModel?.agentSdk ?? autoResolvedModel?.agentSdk ?? baseAgentSdk
  // Remote launches always run claude-code-cli — drives the SDK-picker
  // highlight/tooltip and the ModelSelector's catalog without mutating
  // `selectedSdk` itself (so turning remote back off restores whatever the
  // user had actually picked).
  const uiAgentSdk: PickerAgentSdk = runOnRemote ? 'claude-code-cli' : agentSdk

  // ── Remote section visibility + preflight ─────────────────────────
  const remoteSectionVisible =
    isNewWorktree &&
    !!teleport?.url &&
    !!teleport?.bootstrapToken &&
    !connectionId &&
    !preAssignOnly &&
    !saveConfigOnly

  const hasAttachments = (ticket.attachments ?? []).length > 0

  const remoteSendBlocked =
    runOnRemote &&
    (preflightLoading ||
      !remotePreflight ||
      !remotePreflight.remoteConfigured ||
      !!remotePreflight.error ||
      !remotePreflight.branchOnOrigin ||
      remotePreflight.transferErrors.length > 0)

  // Extra model rows + the "+ Add model" button only apply to a brand-new
  // worktree in the normal or save-config flows (an existing worktree hosts one
  // session; connection/pre-assign never multi-launch, and a remote launch
  // always runs a single claude-code-cli session).
  const extraRowsVisible = isNewWorktree && !isConnectionMode && !preAssignOnly && !runOnRemote
  const isMultiModel = extraRowsVisible && extraModelRows.length > 0
  // Goal mode needs EVERY launched SDK to support it — row 1 (already gated
  // below via agentSdk) plus every visible extra row.
  const goalAvailable =
    supportsGoalMode(agentSdk) &&
    (extraRowsVisible ? extraModelRows.every((r) => supportsGoalMode(r.sdk)) : true) &&
    mode === 'build' &&
    !preAssignOnly &&
    !runOnRemote

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
    gitApi
      .listBranchesWithStatus(project.path)
      .then((result) => {
        if (result.success) {
          setBranches(result.branches)
          const remembered = _lastSourceBranchByProject[projectId]
          if (remembered && !result.branches.some((b) => b.name === remembered)) {
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
      setGoalMode(false)
      setGoalCriteria('')
      goalPrefillRef.current =
        ticket.goal_mode && ticket.goal_success_criteria?.trim()
          ? ticket.goal_success_criteria
          : null
      setSelectedModel(null)
      setSelectedSdk(null)
      setExtraModelRows([])
      setSourceBranch(_lastSourceBranchByProject[projectId] ?? null)
      setBranches([])
      setBranchFilter('')
      setBranchPopoverOpen(false)
      setRunOnRemote(false)
      setRemotePreflight(null)
      setPreflightLoading(false)
      setRemotePhase('idle')
      setRemoteProgress({})
      setRemoteError(null)
      // Retries within one open reuse this id. A fresh open also reuses the
      // id of a previously FAILED launch for this ticket (see
      // _failedRemoteLaunchIdByTicket); otherwise it gets a new one.
      launchIdRef.current = _failedRemoteLaunchIdByTicket[ticket.id] ?? crypto.randomUUID()
      // Refresh worktree list from git so the picker shows current state
      if (project?.path) {
        syncWorktrees(projectId, project.path, { force: true })
      }
    }
  }, [open, ticket, projectId, project?.path, syncWorktrees])

  // ── Apply the ticket's stored goal once the switch is available ──
  // Fires immediately when the default SDK supports goal mode, or later when
  // the user switches to a goal-capable SDK. One-shot per open.
  useEffect(() => {
    if (!open || !goalAvailable || goalPrefillRef.current === null) return
    setGoalMode(true)
    setGoalCriteria(goalPrefillRef.current)
    goalPrefillRef.current = null
  }, [open, goalAvailable])

  // Backstop: goal mode must never stay on while the switch is hidden — the
  // send path wraps the outgoing prompt with /goal whenever goalMode is set,
  // which a non-goal SDK can't parse. (The first render after `open` flips can
  // briefly see stale availability from a previous open of a mounted modal.)
  useEffect(() => {
    if (!goalMode || goalAvailable) return
    setGoalMode(false)
    setGoalCriteria('')
  }, [goalMode, goalAvailable])

  // ── Reset remote state + unsubscribe when the modal closes ───────
  useEffect(() => {
    if (open) return
    remoteUnsubRef.current?.()
    remoteUnsubRef.current = null
    setRunOnRemote(false)
    setRemotePreflight(null)
    setPreflightLoading(false)
    setRemotePhase('idle')
    setRemoteProgress({})
    setRemoteError(null)
  }, [open])

  // ── Clamp mode/goal-mode/model when remote is toggled on ──────────
  useEffect(() => {
    if (!runOnRemote) return
    setGoalMode(false)
    setGoalCriteria('')
    setMode((prev) => {
      if (prev !== 'super-plan') return prev
      setSuperArmed(false)
      return 'plan'
    })
    // A model picked for a different SDK isn't valid for claude-code-cli —
    // same reset `handleSdkChange` does on an explicit SDK switch.
    setSelectedModel(null)
  }, [runOnRemote])

  // ── Preflight check while remote is on, re-fired on branch change ─
  useEffect(() => {
    if (!runOnRemote || !isNewWorktree) return
    let cancelled = false
    setPreflightLoading(true)
    setRemotePreflight(null)
    remoteLaunchApi
      .preflight({ projectId, branch: resolvedSourceBranch })
      .then((result) => {
        if (!cancelled) setRemotePreflight(result)
      })
      .catch(() => {
        if (!cancelled) {
          setRemotePreflight({
            remoteConfigured: false,
            branchOnOrigin: false,
            localAhead: 0,
            localBehind: 0,
            diverged: false,
            transfers: [],
            transferErrors: [],
            error: 'Failed to check remote status'
          })
        }
      })
      .finally(() => {
        if (!cancelled) setPreflightLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [runOnRemote, isNewWorktree, projectId, resolvedSourceBranch])

  // ── Branch filtering ───────────────────────────────────────────
  const filteredBranches = useMemo(() => {
    const lower = branchFilter.toLowerCase()
    return branches
      .filter((b) => b.name.toLowerCase().includes(lower))
      .sort((a, b) => {
        // Active (checked-out by a worktree) branches first
        if (a.isCheckedOut !== b.isCheckedOut) return a.isCheckedOut ? -1 : 1
        if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }, [branches, branchFilter])

  // ── Handle SDK change ───────────────────────────────────────────
  const handleSdkChange = useCallback((sdk: PickerAgentSdk) => {
    setSelectedSdk(sdk)
    setSelectedModel(null) // reset model — new SDK has different models
    if (!supportsGoalMode(sdk)) {
      setGoalMode(false)
      setGoalCriteria('')
    }
  }, [])

  // ── Extra model rows ────────────────────────────────────────────
  const addModelRow = useCallback(() => {
    setExtraModelRows((rows) => [
      ...rows,
      { key: crypto.randomUUID(), sdk: agentSdk, model: null, codexFastMode }
    ])
  }, [agentSdk, codexFastMode])

  const removeModelRow = useCallback((key: string) => {
    setExtraModelRows((rows) => rows.filter((r) => r.key !== key))
  }, [])

  const handleRowSdkChange = useCallback((key: string, sdk: PickerAgentSdk) => {
    // Reset the row's model (new SDK has different models), mirroring handleSdkChange.
    setExtraModelRows((rows) => rows.map((r) => (r.key === key ? { ...r, sdk, model: null } : r)))
    if (!supportsGoalMode(sdk)) {
      setGoalMode(false)
      setGoalCriteria('')
    }
  }, [])

  const updateRowModel = useCallback((key: string, model: SelectedModel) => {
    setExtraModelRows((rows) => rows.map((r) => (r.key === key ? { ...r, model } : r)))
  }, [])

  const updateRowCodexFastMode = useCallback((key: string, value: boolean) => {
    setExtraModelRows((rows) =>
      rows.map((r) => (r.key === key ? { ...r, codexFastMode: value } : r))
    )
  }, [])

  // ── Handle mode toggle ──────────────────────────────────────────
  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next: PickerMode = prev === 'build' ? (superArmed ? 'super-plan' : 'plan') : 'build'
      setPromptText((current) => swapModePrefix(current, prev, next))
      setGoalMode(false)
      setGoalCriteria('')
      return next
    })
  }, [superArmed])

  // ── Handle SUPER toggle ─────────────────────────────────────────
  const toggleSuper = useCallback(() => {
    if (runOnRemote) return // super-plan is unavailable for remote launches
    if (mode === 'plan') {
      setMode('super-plan')
      setSuperArmed(true)
      setGoalMode(false)
      setGoalCriteria('')
    } else if (mode === 'super-plan') {
      setMode('plan')
      setSuperArmed(false)
    }
  }, [mode, runOnRemote])

  // ── Handle Shift+Tab super-plan shortcut ─────────────────────
  const toggleSuperShortcut = useCallback(() => {
    if (runOnRemote) return // super-plan is unavailable for remote launches
    setMode((prev) => {
      const next: PickerMode = prev === 'super-plan' ? 'plan' : 'super-plan'
      setPromptText((current) => swapModePrefix(current, prev, next))
      setGoalMode(false)
      setGoalCriteria('')
      return next
    })
  }, [runOnRemote])

  // ── Handle Tab / Shift+Tab keys ─────────────────────────────────
  // Must use window-level capture-phase listener to beat SessionView's
  // global Tab handler which also uses capture and stops propagation.
  // Tab = toggle build↔plan, Shift+Tab = toggle ±super-plan.
  useEffect(() => {
    if (!open || preAssignOnly) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return
      if (branchPopoverOpen) return // Don't toggle mode while picking a branch
      e.preventDefault()
      e.stopImmediatePropagation()

      if (e.shiftKey) {
        toggleSuperShortcut()
      } else {
        toggleMode()
      }
      // Also focus the prompt textarea if it isn't already focused
      if (document.activeElement !== promptRef.current) {
        promptRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler, true) // capture phase
    return () => {
      window.removeEventListener('keydown', handler, true)
    }
  }, [open, toggleMode, toggleSuperShortcut, branchPopoverOpen, preAssignOnly])

  // Keep React keydown for test compatibility (jsdom doesn't have capture-phase issues)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Tab' && !preAssignOnly) {
        if (branchPopoverOpen) return
        e.preventDefault()
        if (e.shiftKey) {
          toggleSuperShortcut()
        } else {
          toggleMode()
        }
        // Also focus the prompt textarea if it isn't already focused
        if (document.activeElement !== promptRef.current) {
          promptRef.current?.focus()
        }
      }
    },
    [toggleMode, toggleSuperShortcut, branchPopoverOpen, preAssignOnly]
  )

  // ── Handle worktree selection ───────────────────────────────────
  const handleSelectWorktree = useCallback((wtId: string) => {
    setSelectedWorktreeId(wtId)
    setIsNewWorktree(false)
    setRunOnRemote(false) // remote launches only apply to new worktrees
  }, [])

  const handleSelectNewWorktree = useCallback(() => {
    setSelectedWorktreeId(null)
    setIsNewWorktree(true)
  }, [])

  // ── Send flow ───────────────────────────────────────────────────
  const goalCriteriaValid = !goalMode || goalCriteria.trim().length > 0
  const isRemoteLaunchActive =
    runOnRemote && isNewWorktree && !isConnectionMode && !preAssignOnly && !saveConfigOnly
  const canSend =
    (isConnectionMode
      ? !isSending
      : (selectedWorktreeId !== null || isNewWorktree) && !isSending) &&
    goalCriteriaValid &&
    !remoteSendBlocked

  // The goal prompt as it would go out. Goal mode is build-only, so the mode
  // prefix is empty and this matches the outbound prompt for every SDK.
  const composedGoalPrompt = useMemo(() => {
    if (!goalMode || !goalAvailable) return null
    return composePromptForSdk(mode, agentSdk, promptText, goalMode, goalCriteria, {
      claudeCli: agentSdk === 'claude-code-cli'
    })
  }, [goalMode, goalAvailable, mode, agentSdk, promptText, goalCriteria])
  const willUsePlanFile = exceedsGoalPromptLimit(composedGoalPrompt)

  const handleSend = useCallback(async () => {
    const isRemoteRetry = isRemoteLaunchActive && remotePhase === 'failed'
    if (!isRemoteRetry && !canSend) return
    setIsSending(true)

    // ── Remote launch path (new worktree only, opt-in) ────────────
    if (isRemoteLaunchActive) {
      setRemotePhase('launching')
      setRemoteProgress({})
      setRemoteError(null)
      const launchId = launchIdRef.current
      const clampedMode: RemoteLaunchMode = mode === 'build' ? 'build' : 'plan'
      const effectiveModel = selectedModel ?? autoResolvedModel ?? null
      const model: RemoteLaunchModelSelection | null = effectiveModel
        ? {
            providerId: effectiveModel.providerID,
            id: effectiveModel.modelID,
            variant: effectiveModel.variant
          }
        : null
      const prompt = buildRemotePrompt(clampedMode, ticket, promptText)

      let lastRunningStep: RemoteLaunchStep = 'connect'
      const unsub = remoteLaunchApi.onProgress(launchId, (event) => {
        setRemoteProgress((prev) => ({ ...prev, [event.step]: event.status }))
        if (event.status === 'running') lastRunningStep = event.step
        if (event.status === 'error') {
          setRemoteError({ step: event.step, message: event.error ?? 'Remote launch failed' })
        }
      })
      remoteUnsubRef.current = unsub

      try {
        const result = await remoteLaunchApi.start({
          launchId,
          ticketId: ticket.id,
          projectId,
          branch: resolvedSourceBranch,
          prompt,
          mode: clampedMode,
          model,
          ticketTitle: ticket.title
        })

        if (!result.success) {
          const step = result.step ?? lastRunningStep
          const message = result.error ?? 'Remote launch failed'
          _failedRemoteLaunchIdByTicket[ticket.id] = launchId
          setRemoteProgress((prev) => ({ ...prev, [step]: 'error' }))
          setRemoteError({ step, message })
          setRemotePhase('failed')
          return
        }

        if (result.localSessionId) {
          // Best-effort store priming for the ticket card's remote badge — the
          // launch already succeeded, so a transient session-row fetch failure
          // must not gate the ticket move or render the launch as failed.
          // Consumers re-call ensureLoaded on mount anyway.
          void useRemoteLaunchStore
            .getState()
            .ensureLoaded(result.localSessionId)
            .catch(() => {})
        }

        // Past this point the remote launch itself succeeded — a failure in
        // the local ticket move must not be reported as a failed launch (the
        // outer catch would repaint the green steps and imply the remote
        // session doesn't exist). Surface it against the launch step with an
        // explicit message instead; Retry reuses the same launchId, so it
        // relinks the already-running session rather than launching twice.
        try {
          const sortOrder = useKanbanStore
            .getState()
            .computeSortOrder(
              useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress'),
              0
            )

          await updateTicket(ticket.id, projectId, {
            current_session_id: result.localSessionId ?? null,
            worktree_id: null,
            mode: clampedMode,
            column: 'in_progress',
            sort_order: sortOrder,
            plan_ready: false,
            goal_mode: false,
            goal_success_criteria: null,
            model_provider_id: model?.providerId ?? null,
            model_id: model?.id ?? null,
            model_variant: model?.variant ?? null,
            // A single-model (re)launch shouldn't keep claiming membership in a
            // stale multi-launch group, and a manually-launched queued ticket
            // can't be auto-launched again later (same as the local paths).
            variant_group_id: null,
            pending_launch_config: null
          })
        } catch (error) {
          const message = `Remote session launched, but moving the ticket failed: ${error instanceof Error ? error.message : String(error)}. Retry to relink — the running remote session will be reused, not relaunched.`
          _failedRemoteLaunchIdByTicket[ticket.id] = launchId
          setRemoteProgress((prev) => ({ ...prev, launch: 'error' }))
          setRemoteError({ step: 'launch', message })
          setRemotePhase('failed')
          return
        }

        delete _failedRemoteLaunchIdByTicket[ticket.id]
        toast.success('Launched on remote machine')
        onSendComplete?.()
        onOpenChange(false)
      } catch (error) {
        const step = lastRunningStep
        const message = error instanceof Error ? error.message : 'Failed to start remote launch'
        _failedRemoteLaunchIdByTicket[ticket.id] = launchId
        setRemoteProgress((prev) => ({ ...prev, [step]: 'error' }))
        setRemoteError({ step, message })
        setRemotePhase('failed')
      } finally {
        unsub()
        remoteUnsubRef.current = null
        setIsSending(false)
      }
      return
    }

    // ── Connection mode path ──────────────────────────────────────
    if (isConnectionMode && connectionId) {
      try {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === connectionId)
        const connectionPath = connection?.path
        const effectivePromptText = await convertOversizedGoalPrompt(
          promptText,
          composedGoalPrompt,
          connectionPath
        )

        // Create connection session
        const createConnectionSession = useSessionStore.getState().createConnectionSession
        const effectiveModel = selectedModel ?? autoResolvedModel ?? undefined
        const modelOverride = effectiveModel ? { ...effectiveModel, agentSdk } : undefined
        const cliPendingPrompt =
          agentSdk === 'claude-code-cli'
            ? composePromptForSdk(mode, agentSdk, effectivePromptText, goalMode, goalCriteria, {
                claudeCli: true
              })
            : null
        const createOptions = {
          ...(modelOverride ? { modelOverride } : {}),
          ...(cliPendingPrompt ? { pendingMessage: cliPendingPrompt } : {})
        }
        const sessionResult = await createConnectionSession(connectionId, agentSdk, mode, {
          ...createOptions
        })

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
        lastSendMode.set(sessionId, completionSendMode(mode))
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

        // Apply model override
        if (selectedModel) {
          await useSessionStore.getState().setSessionModel(sessionId, selectedModel)
        }

        // Update ticket — worktree_id stays null for connection sessions
        const sortOrder = useKanbanStore
          .getState()
          .computeSortOrder(
            useKanbanStore.getState().getTicketsByColumnForConnection(connectionId, 'in_progress'),
            0
          )

        // Badge records what the session ACTUALLY runs: the created session
        // row's resolved model wins over the modal's own chain (createSession
        // resolves independently and can differ), then the picked/auto model,
        // then the per-SDK resolution + hard fallback (never null).
        const badgeModel = resolveBadgeModel(
          { sdk: agentSdk, model: effectiveModel ?? null, codexFastMode },
          sessionResult.session
        )
        await updateTicket(ticket.id, ticket.project_id, {
          current_session_id: sessionId,
          worktree_id: null,
          mode,
          column: 'in_progress',
          sort_order: sortOrder,
          plan_ready: false,
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? goalCriteria.trim() : null,
          model_provider_id: badgeModel.providerID,
          model_id: badgeModel.modelID,
          model_variant: badgeModel.variant,
          // A single-model (re)launch shouldn't keep claiming membership in a
          // stale multi-launch group.
          variant_group_id: null,
          // Clears a stale Save & Queue config so this manual launch can't be
          // auto-launched again later (same hole as the worktree path below).
          pending_launch_config: null
        })

        // Name the connection after the ticket unless the user already renamed it
        const ticketTitle = ticket.title.trim()
        if (connection && !connection.custom_name && ticketTitle) {
          void useConnectionStore.getState().renameConnection(connectionId, ticketTitle)
        }

        void autoPinBaseWorktree(ticket.project_id)

        // Trigger usage refresh so the board shows up-to-date usage (debounced in store)
        useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(agentSdk))

        // In sticky-tab mode, stay on the board instead of switching to the new session
        if (useSettingsStore.getState().boardMode === 'sticky-tab') {
          const { BOARD_TAB_ID } = await import('@/stores/useSessionStore')
          useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
        }

        // Close modal
        onSendComplete?.()
        onOpenChange(false)
        toast.success('Session started')

        if (sessionAgentSdk === 'claude-code-cli') {
          const outboundPrompt =
            cliPendingPrompt ??
            composePromptForSdk(mode, sessionAgentSdk, effectivePromptText, goalMode, goalCriteria, {
              claudeCli: true
            })

          if (mode === 'super-plan') {
            // Await so the persisted mode is committed before the main process
            // reads it in buildClaudeCliPtySpawn (createClaudeCli).
            await useSessionStore.getState().setSessionMode(sessionId, 'plan')
          }

          bumpWorktreeLastMessage({ connectionId })
          const result = unwrapEnvelope(
            await terminalApi.createClaudeCli(sessionId, {
              pendingPrompt: outboundPrompt
            })
          )
          if (result.success && outboundPrompt) {
            useSessionStore.getState().dequeuePendingMessage(sessionId)
          }
          return
        }

        // Connect to opencode using connection path
        if (!connectionPath) return

        const connectResult = unwrapEnvelope(await opencodeApi.connect(connectionPath, sessionId))
        if (!connectResult.success || !connectResult.sessionId) {
          toast.error(connectResult.error || 'Failed to start session')
          return
        }

        useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
        await dbApi.session.update<Session>(sessionId, {
          opencode_session_id: connectResult.sessionId
        })

        // Send prompt
        if (effectivePromptText.trim()) {
          const outboundPrompt = composePromptForSdk(
            mode,
            sessionAgentSdk,
            effectivePromptText,
            goalMode,
            goalCriteria,
            { claudeCli: false }
          )
          if (!outboundPrompt) return
          const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

          if (mode === 'super-plan') {
            useSessionStore.getState().setSessionMode(sessionId, 'plan')
          }
          if (!connectResult.sessionId) {
            throw new Error('Missing opencode session id')
          }

          bumpWorktreeLastMessage({ connectionId })
          startHivePromptTelemetry({
            sessionId,
            prompt: outboundPrompt,
            worktreeId: null,
            modelId: effectiveModel?.modelID,
            providerId: effectiveModel?.providerID,
            modelVariant: effectiveModel?.variant,
            mode
          })
          unwrapEnvelope(
            await opencodeApi.prompt(
              connectionPath,
              connectResult.sessionId,
              [{ type: 'text', text: outboundPrompt }],
              toRequestModel(effectiveModel),
              promptOptions
            )
          )
        }
        return // Done with connection path
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to start session')
      } finally {
        setIsSending(false)
      }
      return // Don't fall through to worktree logic
    }

    try {
      let worktreeId = selectedWorktreeId

      // Row 1 (the existing controls) first, then each extra model row. Row 1's
      // model uses the same effective-model chain as the single-model launch;
      // unpicked extra rows snapshot the concrete row-resolved model the
      // ModelSelector displayed — downstream null-resolution ignores mode
      // defaults, so passing null could launch a different model than shown.
      const entries: LaunchModelConfig[] = [
        { sdk: agentSdk, model: selectedModel ?? autoResolvedModel ?? null, codexFastMode },
        ...extraModelRows.map((r) => ({
          sdk: r.sdk,
          model: r.model ?? resolveRowDefaultModel(r.sdk, mode),
          codexFastMode: r.codexFastMode
        }))
      ]

      // ── Save config only path: serialize config, don't create session ─
      if (saveConfigOnly) {
        const pendingConfig = {
          worktree: isNewWorktree
            ? { type: 'new' as const, sourceBranch: sourceBranch ?? defaultBranchName }
            : { type: 'existing' as const, worktreeId: worktreeId! },
          prompt: promptText.trim() || buildPrompt(mode, ticket),
          mode,
          model: selectedModel ?? null,
          sdk: agentSdk,
          codexFastMode,
          goalMode,
          goalSuccessCriteria: goalMode ? goalCriteria.trim() : null,
          // Multi-model entries (row 1 first). Legacy sdk/model/codexFastMode
          // above stay so older builds can still auto-launch entries[0].
          ...(isMultiModel ? { models: entries } : {})
        }

        const sortOrder = useKanbanStore
          .getState()
          .computeSortOrder(
            useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress'),
            0
          )

        await updateTicket(ticket.id, projectId, {
          pending_launch_config: JSON.stringify(pendingConfig),
          column: 'in_progress',
          sort_order: sortOrder,
          mode,
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? goalCriteria.trim() : null,
          // Badge fields mean "what launched" — a queued-not-yet-launched
          // ticket must have none (backward-drag doesn't clear them, so a
          // relaunch-requeue would show the PREVIOUS launch's badge until
          // auto-launch overwrites). Auto-launch stamps them at launch time.
          model_provider_id: null,
          model_id: null,
          model_variant: null,
          variant_group_id: null
        })

        onSendComplete?.()
        onOpenChange(false)
        toast.success('Launch config saved — will auto-launch when dependencies resolve')
        setIsSending(false)
        return
      }

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

      void autoPinBaseWorktree(projectId)

      // ── Multi-model launch: hand off to the background orchestrator ──
      // It owns EVERYTHING after this point — worktree creation, ticket
      // duplication, all ticket updates, and the per-SDK prompt composition — so
      // the modal creates/mutates nothing here and closes immediately (no spinner).
      if (isMultiModel) {
        const targetBranch = sourceBranch ?? defaultBranchName
        _lastSourceBranchByProject[projectId] = targetBranch
        const plan: MultiModelLaunchPlan = {
          ticket: { id: ticket.id, title: ticket.title },
          projectId,
          // RAW prompt — the pipeline composes per SDK (plan prefix, goal wrap,
          // oversized-goal plan-file swap) inside launchTicketWithModel; composing
          // it here would double-prefix.
          prompt: promptText.trim() || buildPrompt(mode, ticket),
          mode,
          sourceBranch: targetBranch,
          goalMode,
          goalSuccessCriteria: goalMode ? goalCriteria.trim() : null,
          entries
        }
        onSendComplete?.()
        onOpenChange(false)
        toast.success(`Starting ${entries.length} sessions`)
        // The orchestrator itself never rethrows (it toasts internally) — this
        // .catch is defense-in-depth against an unhandled rejection reaching here.
        void runMultiModelLaunch(plan).catch((err) => {
          console.error('runMultiModelLaunch rejected unexpectedly', err)
        })
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

      // Resolve the worktree record once — needed for plan-file creation and
      // the OpenCode connect below. Newly created worktrees are already in the
      // store at this point.
      const allWorktrees = Array.from(
        useWorktreeStore.getState().worktreesByProject.values()
      ).flat()
      const worktree = allWorktrees.find((w) => w.id === worktreeId)

      const effectivePromptText = await convertOversizedGoalPrompt(
        promptText,
        composedGoalPrompt,
        worktree?.path
      )

      // Create session in the selected worktree
      const effectiveModel = selectedModel ?? autoResolvedModel ?? undefined
      const modelOverride = effectiveModel ? { ...effectiveModel, agentSdk } : undefined
      const cliPendingPrompt =
        agentSdk === 'claude-code-cli'
          ? composePromptForSdk(mode, agentSdk, effectivePromptText, goalMode, goalCriteria, {
              claudeCli: true
            })
          : null
      const createOptions = {
        ...(modelOverride ? { modelOverride } : {}),
        ...(cliPendingPrompt ? { pendingMessage: cliPendingPrompt } : {})
      }
      const sessionResult = await createSession(
        worktreeId,
        projectId,
        agentSdk,
        mode,
        createOptions
      )

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
      lastSendMode.set(sessionId, completionSendMode(mode))
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

      // Apply user's model override to the session if they explicitly picked one
      if (selectedModel) {
        await useSessionStore.getState().setSessionModel(sessionId, selectedModel)
      }

      // Update the ticket with session info and move to in_progress
      const sortOrder = useKanbanStore
        .getState()
        .computeSortOrder(useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress'), 0)

      // Badge records what the session ACTUALLY runs: the created session
      // row's resolved model wins over the modal's own chain (createSession
      // resolves independently and can differ), then the picked/auto model,
      // then the per-SDK resolution + hard fallback (never null).
      const badgeModel = resolveBadgeModel(
        { sdk: agentSdk, model: effectiveModel ?? null, codexFastMode },
        sessionResult.session
      )
      await updateTicket(ticket.id, projectId, {
        current_session_id: sessionId,
        worktree_id: worktreeId,
        mode,
        column: 'in_progress',
        sort_order: sortOrder,
        plan_ready: false,
        goal_mode: goalMode,
        goal_success_criteria: goalMode ? goalCriteria.trim() : null,
        model_provider_id: badgeModel.providerID,
        model_id: badgeModel.modelID,
        model_variant: badgeModel.variant,
        // A single-model (re)launch shouldn't keep claiming membership in a
        // stale multi-launch group.
        variant_group_id: null,
        // Clears a stale Save & Queue config so this manual launch can't be
        // auto-launched again later (e.g. once its blocking dependency resolves).
        pending_launch_config: null
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

      if (sessionAgentSdk === 'claude-code-cli') {
        const outboundPrompt =
          cliPendingPrompt ??
          composePromptForSdk(mode, sessionAgentSdk, effectivePromptText, goalMode, goalCriteria, {
            claudeCli: true
          })

        if (mode === 'super-plan') {
          // Await so the persisted mode is committed before the main process
          // reads it in buildClaudeCliPtySpawn (createClaudeCli).
          await useSessionStore.getState().setSessionMode(sessionId, 'plan')
        }

        bumpWorktreeLastMessage({ worktreeId })
        const result = unwrapEnvelope(
          await terminalApi.createClaudeCli(sessionId, {
            pendingPrompt: outboundPrompt
          })
        )
        if (result.success && outboundPrompt) {
          useSessionStore.getState().dequeuePendingMessage(sessionId)
        }
        return
      }

      // ── Start the OpenCode session in the background ──────────
      if (!worktree?.path) return

      // Connect to OpenCode to create the AI session
      const connectResult = unwrapEnvelope(await opencodeApi.connect(worktree.path, sessionId))
      if (!connectResult.success || !connectResult.sessionId) {
        toast.error(connectResult.error || 'Failed to start session')
        return
      }

      // Persist the opencodeSessionId to Zustand + DB
      useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
      await dbApi.session.update<Session>(sessionId, {
        opencode_session_id: connectResult.sessionId
      })

      // Send the prompt — apply plan mode prefix for opencode SDK
      if (effectivePromptText.trim()) {
        const outboundPrompt = composePromptForSdk(
          mode,
          sessionAgentSdk,
          effectivePromptText,
          goalMode,
          goalCriteria,
          { claudeCli: false }
        )
        if (!outboundPrompt) return
        const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

        // Auto-revert super-plan → plan immediately (one-shot mode).
        // The prefix is already captured in fullPrompt above.
          if (mode === 'super-plan') {
            useSessionStore.getState().setSessionMode(sessionId, 'plan')
          }
          if (!connectResult.sessionId) {
            throw new Error('Missing opencode session id')
          }

          bumpWorktreeLastMessage({ worktreeId })
        startHivePromptTelemetry({
          sessionId,
          prompt: outboundPrompt,
          worktreeId,
          modelId: effectiveModel?.modelID,
          providerId: effectiveModel?.providerID,
          modelVariant: effectiveModel?.variant,
          mode
        })
        unwrapEnvelope(
          await opencodeApi.prompt(
            worktree.path,
            connectResult.sessionId,
            [{ type: 'text', text: outboundPrompt }],
            toRequestModel(effectiveModel),
            promptOptions
          )
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start session')
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
    ticket,
    onSendComplete,
    onOpenChange,
    preAssignOnly,
    saveConfigOnly,
    selectedModel,
    autoResolvedModel,
    codexFastMode,
    goalMode,
    goalCriteria,
    composedGoalPrompt,
    isConnectionMode,
    connectionId,
    isRemoteLaunchActive,
    remotePhase,
    resolvedSourceBranch,
    extraModelRows,
    isMultiModel
  ])

  // ── Mode toggle chip ────────────────────────────────────────────
  const ModeIcon = mode === 'build' ? Hammer : Map
  const modeLabel = mode === 'build' ? 'Build' : 'Plan'

  // Block Esc / overlay-click / X-button close while a remote launch is in
  // flight — the RPC keeps running server-side regardless, but v1 keeps the
  // modal up so the checklist stays visible.
  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      if (!next && runOnRemote && remotePhase === 'launching') return
      onOpenChange(next)
    },
    [onOpenChange, runOnRemote, remotePhase]
  )

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        data-testid="worktree-picker-modal"
        className="sm:max-w-[520px] overflow-visible"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="space-y-2.5 pb-1">
          <DialogTitle className="text-base">
            {saveConfigOnly
              ? 'Pre-configure Launch'
              : preAssignOnly
                ? 'Assign Worktree'
                : 'Start Session'}
          </DialogTitle>
          <DialogDescription>
            {preAssignOnly
              ? 'Pre-assign a worktree to'
              : isConnectionMode
                ? 'Start a session for'
                : 'Pick a worktree for'}{' '}
            <span className="font-medium text-foreground">{ticket.title}</span>
          </DialogDescription>
          {/* Build/Plan chip toggle — below description to avoid overlapping the X close button */}
          {!preAssignOnly && (
            <div className="flex items-center gap-1.5">
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
                  disabled={runOnRemote}
                  aria-pressed={mode === 'super-plan'}
                  aria-label={`Super mode ${mode === 'super-plan' ? 'enabled' : 'disabled'}`}
                  data-testid="wt-picker-super-toggle"
                  title={runOnRemote ? 'Not available for remote launches' : undefined}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
                    'border select-none whitespace-nowrap',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    mode === 'super-plan'
                      ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20 super-sparkle'
                      : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  SUPER
                </button>
              </div>
            </div>
          )}
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Worktree list (hidden in connection mode) ────── */}
          {!isConnectionMode && (
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
            </div>
          )}

          {/* ── Run on remote machine ────────────────────────────── */}
          {remoteSectionVisible && (
            <div
              data-testid="remote-launch-section"
              className="space-y-2.5 rounded-md border border-border/50 bg-muted/10 px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    Run on remote machine
                  </span>
                  <p className="truncate text-xs text-muted-foreground">{teleport?.url}</p>
                </div>
                <Switch
                  checked={runOnRemote}
                  onCheckedChange={setRunOnRemote}
                  disabled={remotePhase === 'launching'}
                  data-testid="remote-launch-toggle"
                />
              </div>

              {runOnRemote && (
                <>
                  {hasAttachments && (
                    <p
                      data-testid="remote-attachments-notice"
                      className="text-xs text-amber-600 dark:text-amber-400"
                    >
                      Attachments aren&apos;t sent to remote launches and will be stripped.
                    </p>
                  )}

                  {remotePhase === 'idle' ? (
                    <div className="space-y-1.5">
                      {preflightLoading && (
                        <p className="text-xs text-muted-foreground">
                          Checking remote status…
                        </p>
                      )}
                      {remotePreflight && !preflightLoading && (
                        <>
                          {(!remotePreflight.remoteConfigured || remotePreflight.error) && (
                            <p
                              data-testid="remote-preflight-error"
                              className="text-xs text-destructive"
                            >
                              {remotePreflight.error || 'Remote machine is not configured'}
                            </p>
                          )}
                          {remotePreflight.remoteConfigured &&
                            !remotePreflight.branchOnOrigin && (
                              <p
                                data-testid="remote-branch-missing"
                                className="text-xs text-destructive"
                              >
                                Branch {remoteBranchDisplay} doesn&apos;t exist on origin — push
                                it first
                              </p>
                            )}
                          {remotePreflight.transferErrors.length > 0 && (
                            <ul
                              data-testid="remote-transfer-errors"
                              className="list-disc pl-4 text-xs text-destructive"
                            >
                              {remotePreflight.transferErrors.map((err) => (
                                <li key={err}>{err}</li>
                              ))}
                            </ul>
                          )}
                          {(remotePreflight.localAhead > 0 || remotePreflight.diverged) && (
                            <p
                              data-testid="remote-ahead-warning"
                              className="text-xs text-amber-600 dark:text-amber-400"
                            >
                              Remote will run from origin/{remoteBranchDisplay} — missing{' '}
                              {remotePreflight.localAhead} local commit
                              {remotePreflight.localAhead === 1 ? '' : 's'}
                            </p>
                          )}
                          {remotePreflight.transfers.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              <p>Will copy to remote:</p>
                              <ul className="list-disc pl-4">
                                {remotePreflight.transfers.map((file) => (
                                  <li key={file} className="truncate">
                                    {file}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div data-testid="remote-launch-checklist" className="space-y-1.5">
                      {REMOTE_LAUNCH_STEPS.map((step) => {
                        const status = remoteProgress[step]
                        return (
                          <div
                            key={step}
                            data-testid={`remote-step-${step}`}
                            className="flex items-center gap-2 text-xs"
                          >
                            {status === 'done' ? (
                              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                            ) : status === 'running' ? (
                              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                            ) : status === 'error' ? (
                              <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
                            ) : (
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                            )}
                            <span
                              className={cn(
                                'flex-1',
                                status === 'error' ? 'text-destructive' : 'text-foreground'
                              )}
                            >
                              {REMOTE_LAUNCH_STEP_LABELS[step]}
                              {status === 'error' && remoteError?.step === step
                                ? `: ${remoteError.message}`
                                : ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Provider & Model picker (hidden in pre-assign mode) ── */}
          {!preAssignOnly && (
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Provider & Model
              </label>
              {/* SDK toggle — only when 2+ SDKs are available */}
              <SdkToggleGroup
                value={uiAgentSdk}
                onChange={handleSdkChange}
                availableAgentSdks={availableAgentSdks}
                idPrefix="sdk-toggle"
                disabled={runOnRemote}
                disabledTitle="Remote launches always use Claude CLI"
              />
              {goalAvailable && (
                <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">Goal mode</span>
                    <Switch
                      checked={goalMode}
                      onCheckedChange={setGoalMode}
                      data-testid="goal-mode-toggle"
                    />
                  </div>
                  {goalMode && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="goal-success-criteria"
                        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
                      >
                        Success criteria <span className="text-destructive">*</span>
                      </label>
                      <Textarea
                        id="goal-success-criteria"
                        value={goalCriteria}
                        onChange={(e) => setGoalCriteria(e.target.value)}
                        placeholder="What does success look like?"
                        data-testid="goal-success-criteria"
                        rows={3}
                        className="resize-y text-sm"
                      />
                      {goalCriteria.trim().length === 0 && (
                        <p className="text-xs text-destructive">Required</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="min-w-0">
                  <ModelSelector
                    value={selectedModel ?? autoResolvedModel}
                    onChange={setSelectedModel}
                    agentSdkOverride={
                      runOnRemote
                        ? 'claude-code-cli'
                        : (selectedModel?.agentSdk ?? autoResolvedModel?.agentSdk ?? agentSdk)
                    }
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

              {/* ── Extra model rows (new worktree only) ── */}
              {extraRowsVisible && (
                <div className="space-y-2" data-testid="extra-model-rows">
                  {extraModelRows.map((row, i) => {
                    const rowIndex = i + 1
                    const rowModelValue = row.model ?? resolveRowDefaultModel(row.sdk, mode)
                    return (
                      <div
                        key={row.key}
                        data-testid={`extra-model-row-${rowIndex}`}
                        className="space-y-2 rounded-md border border-border/50 bg-muted/10 px-3 py-2.5"
                      >
                        <SdkToggleGroup
                          value={row.sdk}
                          onChange={(sdk) => handleRowSdkChange(row.key, sdk)}
                          availableAgentSdks={availableAgentSdks}
                          idPrefix={`extra-model-row-${rowIndex}-sdk`}
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="min-w-0">
                            <ModelSelector
                              value={rowModelValue}
                              onChange={(model) => updateRowModel(row.key, model)}
                              agentSdkOverride={row.sdk}
                            />
                          </div>
                          {row.sdk === 'codex' && (
                            <div className="shrink-0">
                              <CodexFastToggle
                                enabled={row.codexFastMode}
                                accepted={codexFastModeAccepted}
                                onToggle={() =>
                                  updateRowCodexFastMode(row.key, !row.codexFastMode)
                                }
                                onAccept={() => updateSetting('codexFastModeAccepted', true)}
                              />
                            </div>
                          )}
                          <button
                            type="button"
                            data-testid={`extra-model-row-${rowIndex}-remove`}
                            onClick={() => removeModelRow(row.key)}
                            aria-label="Remove model"
                            className="ml-auto shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  <button
                    type="button"
                    data-testid="add-model-row"
                    onClick={addModelRow}
                    className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add model
                  </button>
                </div>
              )}
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

        {willUsePlanFile && (
          <div
            data-testid="goal-plan-file-notice"
            className="w-full rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            Will be converted to an md file for implementation (&gt;3k characters)
          </div>
        )}

        <DialogFooter className="pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={runOnRemote && remotePhase === 'launching'}
            data-testid="wt-picker-cancel-btn"
          >
            {runOnRemote && remotePhase === 'failed' ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            data-testid="wt-picker-send-btn"
            disabled={
              runOnRemote && remotePhase === 'launching'
                ? true
                : runOnRemote && remotePhase === 'failed'
                  ? false
                  : !canSend
            }
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
            ) : saveConfigOnly ? (
              <>
                <Send className="h-3.5 w-3.5" />
                {isSending ? 'Saving...' : 'Save & Queue'}
              </>
            ) : runOnRemote && remotePhase === 'launching' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Launching…
              </>
            ) : runOnRemote && remotePhase === 'failed' ? (
              <>
                <Send className="h-3.5 w-3.5" />
                Retry
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                {isSending
                  ? 'Starting...'
                  : isMultiModel
                    ? `Start ${1 + extraModelRows.length} sessions`
                    : 'Send'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
