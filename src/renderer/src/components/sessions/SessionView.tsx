import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { Send, ListPlus, Loader2, AlertCircle, RefreshCw, Square, Archive, X, Github, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ProviderIcon } from '@/components/ui/provider-icon'
import { toast } from '@/lib/toast'
import { ModeToggle } from './ModeToggle'
import { SuperToggle } from './SuperToggle'
import { ModelSelector } from './ModelSelector'
import { VirtualizedMessageList, type VirtualizedMessageListHandle } from './VirtualizedMessageList'
import { ContextIndicator } from './ContextIndicator'
import { AttachmentButton } from './AttachmentButton'
import { AttachmentPreview } from './AttachmentPreview'
import { TicketAttachments } from './TicketAttachments'
import { CodexFastToggle } from './CodexFastToggle'
import type { Attachment } from './AttachmentPreview'
import { buildMessageParts, buildDisplayContent, MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'
import { TicketPickerModal } from '@/components/kanban/TicketPickerModal'
import type { TicketAttachmentData } from '@/components/kanban/TicketPickerModal'
import { SlashCommandPopover } from './SlashCommandPopover'
import { FileMentionPopover } from './FileMentionPopover'
import { ScrollToBottomFab } from './ScrollToBottomFab'
import { PlanReadyImplementFab } from './PlanReadyImplementFab'
import { IndeterminateProgressBar } from './IndeterminateProgressBar'
import { useFileMentions } from '@/hooks/useFileMentions'
import { useSessionTimer } from '@/hooks/useSessionTimer'
import type { FlatFile } from '@/lib/file-search-utils'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useContextStore } from '@/stores/useContextStore'
import { maybeExtractJsonTitle } from '@shared/title-utils'
import type { TokenInfo, SessionModelRef } from '@/stores/useContextStore'
import {
  extractTokens,
  extractCost,
  extractModelRef,
  extractSelectedModel,
  extractModelUsage
} from '@/lib/token-utils'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import type { SelectedModel } from '@/stores/useSettingsStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { checkAutoApprove } from '@/lib/permissionUtils'
import { usePromptHistoryStore } from '@/stores/usePromptHistoryStore'
import { useWorktreeStore, useDropAttachmentStore } from '@/stores'
import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { usePRReviewStore } from '@/stores/usePRReviewStore'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { mapOpencodeMessagesToSessionViewMessages } from '@/lib/opencode-transcript'
import { appendStreamedAssistantFallback } from '@/lib/transcript-refresh'
import { deriveCodexTimelineMessages, mergeCodexActivityMessages } from '@/lib/codex-timeline'
import { COMPLETION_WORDS } from '@/lib/format-utils'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline, computeTokenDelta } from '@/lib/token-baselines'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'
import { handleSessionIdleFollowUp } from '@/lib/session-follow-up-dispatch'
import {
  buildSdkPlanImplementationPrompt,
  looksLikeCodexProposedPlan
} from '@/lib/proposedPlan'

// Stable empty array to avoid creating new references in selectors
const EMPTY_FILE_INDEX: FlatFile[] = []
const EMPTY_STRING_ARRAY: string[] = []
import { QuestionPrompt } from './QuestionPrompt'
import { PermissionPrompt } from './PermissionPrompt'
import { CommandApprovalPrompt } from './CommandApprovalPrompt'
import type { ToolStatus, ToolUseInfo } from './ToolCard'
import { PLAN_MODE_PREFIX, ASK_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX, stripPlanModePrefix, isPlanLike } from '@/lib/constants'

/**
 * Resolve an OpenCode session ID to the corresponding Hive session ID
 * by looking up sessions with a matching `opencode_session_id` in the store.
 * Returns null if no matching Hive session is found.
 */
function resolveHiveSessionIdFromOpencodeId(opencodeSessionId: string): string | null {
  const sessionState = useSessionStore.getState()

  for (const sessions of sessionState.sessionsByWorktree.values()) {
    const match = sessions.find((s) => s.opencode_session_id === opencodeSessionId)
    if (match) return match.id
  }

  for (const sessions of sessionState.sessionsByConnection.values()) {
    const match = sessions.find((s) => s.opencode_session_id === opencodeSessionId)
    if (match) return match.id
  }

  return null
}

interface SlashCommandInfo {
  name: string
  description?: string
  template: string
  agent?: string
  builtIn?: boolean
}

export const BUILT_IN_SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'undo',
    description: 'Undo the last message and file changes',
    template: '/undo',
    builtIn: true
  },
  {
    name: 'redo',
    description: 'Redo the last undone message and file changes',
    template: '/redo',
    builtIn: true
  },
  {
    name: 'clear',
    description: 'Close current tab and open a new one',
    template: '/clear',
    builtIn: true
  },
  {
    name: 'ask',
    description: 'Ask a question without making code changes',
    template: '/ask ',
    builtIn: true
  }
]

// Types for OpenCode SDK integration
export interface OpenCodeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** Interleaved parts for assistant messages with tool calls */
  parts?: StreamingPart[]
}

export interface SessionViewState {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  errorMessage?: string
}

/** A single part of a streaming assistant message */
export interface StreamingPart {
  type: 'text' | 'tool_use' | 'subtask' | 'step_start' | 'step_finish' | 'reasoning' | 'compaction'
  /** Accumulated text for text parts */
  text?: string
  /** Tool info for tool_use parts */
  toolUse?: ToolUseInfo
  /** Subtask/subagent spawn info */
  subtask?: {
    id: string
    sessionID: string
    prompt: string
    description: string
    agent: string
    parts: StreamingPart[]
    status: 'running' | 'completed' | 'error'
  }
  /** Step start boundary */
  stepStart?: { snapshot?: string }
  /** Step finish boundary */
  stepFinish?: {
    reason: string
    cost: number
    tokens: { input: number; output: number; reasoning: number }
  }
  /** Reasoning/thinking content */
  reasoning?: string
  /** Whether compaction was automatic */
  compactionAuto?: boolean
}

function derivePendingCodexPlan(
  sessionId: string,
  messages: OpenCodeMessage[]
): { requestId: string; planContent: string; toolUseID: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue

    for (let j = (message.parts?.length ?? 0) - 1; j >= 0; j--) {
      const part = message.parts?.[j]
      if (part?.type !== 'tool_use' || part.toolUse?.name !== 'ExitPlanMode') continue

      const planContent = String(part.toolUse.input?.plan ?? '').trim()
      if (!looksLikeCodexProposedPlan(planContent)) continue

      const toolUseID = part.toolUse.id ?? ''
      return {
        requestId: toolUseID || `codex-plan-${sessionId}`,
        planContent,
        toolUseID
      }
    }
  }

  return null
}

function hasSuspiciousCodexRoleGrouping(messages: OpenCodeMessage[]): boolean {
  const userIndices: number[] = []
  const assistantIndices: number[] = []

  messages.forEach((message, index) => {
    if (message.role === 'user') userIndices.push(index)
    if (message.role === 'assistant') assistantIndices.push(index)
  })

  if (userIndices.length < 2 || assistantIndices.length < 2) return false

  const lastUserIndex = userIndices[userIndices.length - 1]
  const firstAssistantIndex = assistantIndices[0]
  return lastUserIndex < firstAssistantIndex
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

interface SessionViewProps {
  sessionId: string
}

interface SessionRetryState {
  attempt?: number
  message?: string
  next?: number
}

// Session type from database
interface DbSession {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

// Worktree type from database
interface DbWorktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  created_at: string
  last_accessed_at: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function extractSessionErrorMessage(data: unknown): string {
  if (typeof data === 'string') return data

  const record = asRecord(data)
  if (!record) return 'OpenCode session failed'

  const nestedError = asRecord(record.error)
  const nestedData = asRecord(record.data)

  return (
    asString(nestedError?.message) ||
    asString(nestedError?.name) ||
    asString(nestedData?.message) ||
    asString(record.message) ||
    asString(record.error) ||
    'OpenCode session failed'
  )
}

function extractSessionErrorStderr(data: unknown): string | null {
  const record = asRecord(data)
  if (!record) return null

  const nestedData = asRecord(record.data)
  return asString(nestedData?.stderr) || asString(record.stderr) || null
}

function createLocalMessage(role: OpenCodeMessage['role'], content: string): OpenCodeMessage {
  return {
    id: `local-${crypto.randomUUID()}`,
    role,
    content,
    timestamp: new Date().toISOString()
  }
}

async function loadCodexDurableState(
  sessionId: string
): Promise<{ messages: OpenCodeMessage[]; activities: SessionActivity[] }> {
  if (!window.db.sessionMessage?.list || !window.db.sessionActivity?.list) {
    return { messages: [], activities: [] }
  }
  const [messageRows, activityRows] = await Promise.all([
    window.db.sessionMessage.list(sessionId),
    window.db.sessionActivity.list(sessionId)
  ])
  return {
    messages: deriveCodexTimelineMessages(messageRows, activityRows, true),
    activities: activityRows
  }
}

const TRANSCRIPT_CACHE_KEY_PREFIX = 'hive:session-transcript:'

function getTranscriptCacheKey(sessionId: string): string {
  return `${TRANSCRIPT_CACHE_KEY_PREFIX}${sessionId}`
}

function isTestRuntime(): boolean {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'test'
}

function readTranscriptCache(sessionId: string): OpenCodeMessage[] {
  if (isTestRuntime()) return []
  try {
    const raw = window.sessionStorage.getItem(getTranscriptCacheKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as OpenCodeMessage[]) : []
  } catch {
    return []
  }
}

function writeTranscriptCache(sessionId: string, messages: OpenCodeMessage[]): void {
  if (isTestRuntime()) return
  try {
    window.sessionStorage.setItem(getTranscriptCacheKey(sessionId), JSON.stringify(messages))
  } catch {
    // Non-fatal cache write failure
  }
}

// Loading state component
function LoadingState(): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4"
      data-testid="loading-state"
    >
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">Connecting to session...</p>
        <p className="text-xs text-muted-foreground mt-1">This may take a moment</p>
      </div>
    </div>
  )
}

// Error state component
interface ErrorStateProps {
  message: string
  onRetry: () => void
}

function ErrorState({ message, onRetry }: ErrorStateProps): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4"
      data-testid="error-state"
    >
      <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">Connection Error</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry} className="mt-2" data-testid="retry-button">
        <RefreshCw className="h-4 w-4 mr-2" />
        Retry Connection
      </Button>
    </div>
  )
}

function PrCommentAttachments(): React.JSX.Element | null {
  const attachedComments = usePRReviewStore((s) => s.attachedComments)
  const removeAttachment = usePRReviewStore((s) => s.removeAttachment)

  if (attachedComments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachedComments.map((c) => {
        const fileName = c.path.split('/').pop() ?? c.path
        return (
          <div
            key={c.id}
            className="group relative flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
          >
            <div className="flex items-center gap-2">
              <ProviderIcon provider="github" />
              <img
                src={c.user.avatarUrl}
                alt={c.user.login}
                className="h-4 w-4 rounded-full shrink-0"
              />
              <span className="font-medium text-foreground truncate">{c.user.login}</span>
              <button
                onClick={() => removeAttachment(c.id)}
                className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <span className="text-xs text-muted-foreground truncate">
              {fileName}:{c.line ?? '?'}
            </span>
            <span className="text-xs text-muted-foreground line-clamp-2">
              {c.body.length > 80 ? c.body.slice(0, 80) + '...' : c.body}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Main SessionView component
export function SessionView({ sessionId }: SessionViewProps): React.JSX.Element {
  // State
  const [messages, setMessages] = useState<OpenCodeMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [viewState, setViewState] = useState<SessionViewState>({ status: 'connecting' })
  const [isSending, setIsSending] = useState(false)
  const [queuedMessages, setQueuedMessages] = useState<
    Array<{
      id: string
      content: string
      timestamp: number
    }>
  >([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [ticketPickerOpen, setTicketPickerOpen] = useState(false)

  // Consume files dropped from Finder via the global drop zone
  const pendingDropFiles = useDropAttachmentStore((s) => s.pending)

  useEffect(() => {
    if (pendingDropFiles.length === 0) return
    const items = useDropAttachmentStore.getState().consume()
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length
      if (remaining <= 0) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      if (items.length > remaining) {
        toast.warning(
          `Only ${remaining} of ${items.length} files attached (maximum ${MAX_ATTACHMENTS})`
        )
      }
      const toAdd = items.slice(0, remaining)
      return [...prev, ...toAdd.map((item) => ({ id: crypto.randomUUID(), ...item }))]
    })
  }, [pendingDropFiles])

  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([])
  const [showSlashCommands, setShowSlashCommands] = useState(false)
  const [revertMessageID, setRevertMessageID] = useState<string | null>(null)
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null)
  const revertDiffRef = useRef<string | null>(null)

  // Runtime capabilities for undo/redo gating
  const [sessionCapabilities, setSessionCapabilities] = useState<{
    supportsUndo: boolean
    supportsRedo: boolean
  } | null>(null)

  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const sessionCapabilitiesRef = useRef(sessionCapabilities)
  useEffect(() => {
    sessionCapabilitiesRef.current = sessionCapabilities
  }, [sessionCapabilities])

  const allSlashCommands = useMemo(() => {
    const seen = new Set<string>()
    const ordered = [...BUILT_IN_SLASH_COMMANDS, ...slashCommands]
    return ordered.filter((command) => {
      const key = command.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      if (key === 'undo' && sessionCapabilities && !sessionCapabilities.supportsUndo) return false
      if (key === 'redo' && sessionCapabilities && !sessionCapabilities.supportsRedo) return false
      return true
    })
  }, [slashCommands, sessionCapabilities])

  const hasSuperpowers = useMemo(
    () => slashCommands.some((c) => c.name === 'using-superpowers'),
    [slashCommands]
  )

  // Mode state for input border color
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId) || 'build')
  const persistedFollowUpMessages =
    useSessionStore((state) => state.pendingFollowUpMessages.get(sessionId)) ?? EMPTY_STRING_ARRAY

  // OpenCode state
  const [worktreePath, setWorktreePath] = useState<string | null>(null)
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const isStreamingRef = useRef(isStreaming)
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
  const [isCompacting, setIsCompacting] = useState(false)
  const [sessionRetry, setSessionRetry] = useState<SessionRetryState | null>(null)
  const [sessionErrorMessage, setSessionErrorMessage] = useState<string | null>(null)
  const [sessionErrorStderr, setSessionErrorStderr] = useState<string | null>(null)
  const [retryTickMs, setRetryTickMs] = useState<number>(Date.now())
  const [planSavedAsTicket, setPlanSavedAsTicket] = useState(false)

  // Prompt history key: works for both worktree and connection sessions
  const historyKey = worktreeId ?? connectionId

  // Fetch runtime capabilities when the opencode session changes
  useEffect(() => {
    if (!opencodeSessionId) {
      setSessionCapabilities(null)
      return
    }
    window.opencodeOps
      ?.capabilities?.(opencodeSessionId)
      ?.then((result) => {
        if (result.success && result.capabilities) {
          setSessionCapabilities(result.capabilities)
        }
      })
      ?.catch(() => {})
  }, [opencodeSessionId])

  // Prompt history navigation
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)

  useEffect(() => {
    setQueuedMessages((prev) => {
      const sameLength = prev.length === persistedFollowUpMessages.length
      const sameContent =
        sameLength &&
        prev.every((entry, index) => entry.content === persistedFollowUpMessages[index])

      if (sameContent) {
        return prev
      }

      return persistedFollowUpMessages.map((content, index) => ({
        id: prev[index]?.content === content ? prev[index].id : crypto.randomUUID(),
        content,
        timestamp: prev[index]?.content === content ? prev[index].timestamp : Date.now() + index
      }))
    })
  }, [persistedFollowUpMessages])

  const savedDraftRef = useRef<string>('')

  // Session-bound model with global fallback for legacy/null sessions
  const sessionRecord = useSessionStore((state) => {
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((session) => session.id === sessionId)
      if (found) return found
    }
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((session) => session.id === sessionId)
      if (found) return found
    }
    // Check orphaned sessions
    const orphaned = state.orphanedSessions.get(sessionId)
    if (orphaned) return orphaned
    return null
  })

  // Check if this is an orphaned (read-only) session
  const isOrphanedSession = useSessionStore((state) => state.orphanedSessions.has(sessionId))
  const sessionAgentSdk = sessionRecord?.agent_sdk ?? 'opencode'
  const globalModel = useSettingsStore((state) => resolveModelForSdk(sessionAgentSdk, state))
  const effectiveModel: SelectedModel | null =
    sessionRecord?.model_provider_id && sessionRecord.model_id
      ? {
          providerID: sessionRecord.model_provider_id,
          modelID: sessionRecord.model_id,
          variant: sessionRecord.model_variant ?? undefined
        }
      : globalModel
  const currentModelId = effectiveModel?.modelID ?? 'claude-opus-4-5-20251101'
  const currentProviderId = effectiveModel?.providerID ?? 'anthropic'
  // Claude Code and Codex SDKs skip PLAN_MODE_PREFIX (they don't use the text-prefix approach)
  const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'
  const skipPlanModePrefix = isClaudeCode || sessionRecord?.agent_sdk === 'codex'

  // Active question prompt from AI
  const activeQuestion = useQuestionStore((s) => s.getActiveQuestion(sessionId))
  const activePermission = usePermissionStore((s) => s.getActivePermission(sessionId))
  const activeCommandApproval = useCommandApprovalStore((s) => s.getActiveApproval(sessionId))

  // Pending plan approval (ExitPlanMode blocking tool)
  const pendingPlan = useSessionStore((s) => s.pendingPlans.get(sessionId) ?? null)

  // Completion badge — reactive subscription to this session's status entry
  const completionEntry = useWorktreeStatusStore((state) => {
    const entry = state.sessionStatuses[sessionId]
    return entry?.status === 'completed' ? entry : null
  })

  // Streaming parts - tracks interleaved text and tool use during streaming
  const [streamingParts, setStreamingParts] = useState<StreamingPart[]>([])
  const streamingPartsRef = useRef<StreamingPart[]>([])

  // XML tag detection state for Codex plan streaming.
  // In plan mode, Codex wraps plan content in <proposed_plan>...</proposed_plan>.
  // We scan the stream for these tags and route only the plan content into an
  // ExitPlanMode tool card, leaving reasoning/preamble as regular chat text.
  const planXmlDetectionRef = useRef<{
    state: 'scanning' | 'routing' | 'done'
    buffer: string // partial-tag buffer (≤ tag length chars)
    cardId: string | null
  }>({ state: 'scanning', buffer: '', cardId: null })

  // Legacy streaming content for backward compatibility
  const [streamingContent, setStreamingContent] = useState<string>('')
  const streamingContentRef = useRef<string>('')

  // Refs
  const virtualizedListRef = useRef<VirtualizedMessageListHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const scrollContainerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    scrollContainerRef.current = el
    setScrollElement(el)
  }, [])

  // Smart auto-scroll tracking
  const isAutoScrollEnabledRef = useRef(true)
  const [showScrollFab, setShowScrollFab] = useState(false)
  const lastScrollTopRef = useRef(0)
  const userHasScrolledUpRef = useRef(false)
  const isProgrammaticScrollRef = useRef(false)
  const programmaticScrollResetRef = useRef<number | null>(null)
  const manualScrollIntentRef = useRef(false)
  const pointerDownInScrollerRef = useRef(false)

  // Streaming rAF ref (frame-synced flushing for text updates)
  const rafRef = useRef<number | null>(null)
  const pendingTextCharsRef = useRef(0)

  // Response logging refs
  const isLogModeRef = useRef<boolean>(false)
  const logFilePathRef = useRef<string | null>(null)

  // Child session → subtask index mapping for subagent content routing
  const childToSubtaskIndexRef = useRef<Map<string, number>>(new Map())

  // Cursor position tracking for file mentions
  const cursorPositionRef = useRef(0)
  const [cursorPosition, setCursorPosition] = useState(0)
  const isPastingRef = useRef(false)
  const isImeComposingRef = useRef(false)

  // Draft persistence refs
  const inputValueRef = useRef('')
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flat file index for file mentions and search — keyed by worktree path.
  // Uses git ls-files for a complete, gitignore-respecting file list.
  // Ensure the index is loaded when worktreePath is resolved — SessionView cannot
  // rely on the FileTree sidebar component having already populated the store
  // (sidebar may be collapsed, on a different tab, or targeting a different worktree).
  const fileIndex = useFileTreeStore((state) =>
    worktreePath
      ? (state.fileIndexByWorktree.get(worktreePath) ?? EMPTY_FILE_INDEX)
      : EMPTY_FILE_INDEX
  )
  useEffect(() => {
    if (worktreePath && fileIndex === EMPTY_FILE_INDEX) {
      useFileTreeStore.getState().loadFileIndex(worktreePath)
    }
  }, [worktreePath, fileIndex])

  // File mentions hook
  const fileMentions = useFileMentions(inputValue, cursorPosition, fileIndex)

  // stripAtMentions setting
  const stripAtMentions = useSettingsStore((state) => state.stripAtMentions)
  const codexFastMode = useSettingsStore((state) => state.codexFastMode)
  const codexFastModeAccepted = useSettingsStore((state) => state.codexFastModeAccepted)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  const codexPromptOptions = useMemo(
    () => (sessionAgentSdk === 'codex' ? { codexFastMode } : undefined),
    [sessionAgentSdk, codexFastMode]
  )

  // Streaming dedup refs
  const finalizedMessageIdsRef = useRef<Set<string>>(new Set())
  const hasFinalizedCurrentResponseRef = useRef(false)
  const sessionModelHydratedRef = useRef(false)
  const codexRefreshRafRef = useRef<number | null>(null)
  const codexRefreshInFlightRef = useRef(false)
  const codexRefreshPendingRef = useRef(false)
  const codexStreamingMessageIdRef = useRef<string | null>(null)
  const seenCodexEventIdsRef = useRef<Set<string>>(new Set())
  const seenCodexEventIdsQueueRef = useRef<string[]>([])

  // Guard: tracks whether a new prompt was sent during the current streaming cycle.
  // When true, finalizeResponse skips the full reload to avoid
  // reordering the newly-sent user message.
  const newPromptPendingRef = useRef(false)

  // Generation counter to prevent stale closures from processing events for
  // the wrong session (cross-tab bleed prevention). Incremented on every
  // sessionId change; the stream handler captures the current value and rejects
  // events when the ref has moved on.
  const streamGenerationRef = useRef(0)

  // Echo detection: stores the full prompt text (including mode prefix) so we
  // can recognise SDK echoes of the user message even when the event lacks a
  // role field.
  const lastSentPromptRef = useRef<string | null>(null)

  // Canonical transcript source used by reload/finalize/retry paths.
  const transcriptSourceRef = useRef<{
    worktreePath: string | null
    opencodeSessionId: string | null
  }>({
    worktreePath: null,
    opencodeSessionId: null
  })

  const getModelForRequests = useCallback((): SelectedModel | undefined => {
    const state = useSessionStore.getState()

    // Find session record (search both worktree and connection sessions)
    let session: typeof sessionRecord = null
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) {
        session = found
        break
      }
    }
    if (!session) {
      for (const sessions of state.sessionsByConnection.values()) {
        const found = sessions.find((s) => s.id === sessionId)
        if (found) {
          session = found
          break
        }
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
  }, [sessionId])

  // Extract message role from OpenCode stream payloads across known shapes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getEventMessageRole = useCallback((data: any): string | undefined => {
    return (
      data?.message?.role ??
      data?.info?.role ??
      data?.part?.role ??
      data?.role ??
      data?.properties?.message?.role ??
      data?.properties?.info?.role ??
      data?.properties?.part?.role ??
      data?.properties?.role
    )
  }, [])

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true
    if (programmaticScrollResetRef.current !== null) {
      cancelAnimationFrame(programmaticScrollResetRef.current)
    }
    programmaticScrollResetRef.current = requestAnimationFrame(() => {
      programmaticScrollResetRef.current = requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false
        programmaticScrollResetRef.current = null
      })
    })
  }, [])

  const resetAutoScrollState = useCallback(() => {
    if (programmaticScrollResetRef.current !== null) {
      cancelAnimationFrame(programmaticScrollResetRef.current)
      programmaticScrollResetRef.current = null
    }
    isProgrammaticScrollRef.current = false
    manualScrollIntentRef.current = false
    pointerDownInScrollerRef.current = false
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
    userHasScrolledUpRef.current = false
    const el = scrollContainerRef.current
    if (el) {
      lastScrollTopRef.current = el.scrollTop
    }
  }, [])

  // Auto-scroll to bottom when new messages arrive or streaming updates
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = isStreaming ? 'instant' : 'smooth') => {
      markProgrammaticScroll()
      virtualizedListRef.current?.scrollToEnd(behavior)
    },
    [isStreaming, markProgrammaticScroll]
  )

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const currentScrollTop = el.scrollTop
    const previousScrollTop = lastScrollTopRef.current
    lastScrollTopRef.current = currentScrollTop

    const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight
    const isNearBottom = distanceFromBottom < 80
    const hasManualIntent = manualScrollIntentRef.current || pointerDownInScrollerRef.current
    const isManualScrollUp = hasManualIntent && currentScrollTop < previousScrollTop

    if (isProgrammaticScrollRef.current) {
      manualScrollIntentRef.current = false
      return
    }

    if (isManualScrollUp && (isSending || isStreaming)) {
      userHasScrolledUpRef.current = true
      isAutoScrollEnabledRef.current = false
      setShowScrollFab(true)
      manualScrollIntentRef.current = false
      return
    }

    if (isNearBottom && hasManualIntent) {
      isAutoScrollEnabledRef.current = true
      setShowScrollFab(false)
      userHasScrolledUpRef.current = false
      manualScrollIntentRef.current = false
      return
    }

    if (!hasManualIntent) {
      return
    }

    if (!isNearBottom && (isSending || isStreaming)) {
      userHasScrolledUpRef.current = true
      isAutoScrollEnabledRef.current = false
      setShowScrollFab(true)
    }
    manualScrollIntentRef.current = false
  }, [isSending, isStreaming])

  const handleScrollToBottomClick = useCallback(() => {
    resetAutoScrollState()
    scrollToBottom('smooth')
  }, [resetAutoScrollState, scrollToBottom])

  const handleScrollWheel = useCallback(() => {
    manualScrollIntentRef.current = true
  }, [])

  const handleScrollPointerDown = useCallback(() => {
    pointerDownInScrollerRef.current = true
  }, [])

  const handleScrollPointerUp = useCallback(() => {
    pointerDownInScrollerRef.current = false
    manualScrollIntentRef.current = false
  }, [])

  const handleScrollPointerCancel = useCallback(() => {
    pointerDownInScrollerRef.current = false
    manualScrollIntentRef.current = false
  }, [])

  // Conditional auto-scroll: only scroll when enabled
  useEffect(() => {
    if (isAutoScrollEnabledRef.current) {
      scrollToBottom()
    }
  }, [messages, streamingContent, streamingParts, scrollToBottom])

  // Reset auto-scroll state on session switch
  useEffect(() => {
    resetAutoScrollState()
  }, [resetAutoScrollState, sessionId])

  // Instant scroll to bottom when session view becomes connected with messages.
  // This must wait for viewState === 'connected' because the message list DOM
  // is only rendered in that state (connecting shows a loading spinner).
  useEffect(() => {
    if (viewState.status === 'connected' && messages.length > 0) {
      requestAnimationFrame(() => {
        scrollToBottom('instant')
      })
    }
    // Only trigger on viewState and sessionId changes, NOT on every messages update
    // (streaming appends messages continuously and should use smooth scroll instead)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewState.status, sessionId])

  // Reset prompt history navigation on session change
  useEffect(() => {
    setHistoryIndex(null)
    savedDraftRef.current = ''
  }, [sessionId])

  // Auto-focus textarea whenever session changes or view becomes connected.
  // The textarea only exists in the DOM when viewState is 'connected',
  // so we need to re-trigger focus when transitioning from 'connecting' → 'connected'.
  useEffect(() => {
    if (vimModeEnabled) return
    if (textareaRef.current) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
      })
    }
  }, [sessionId, viewState.status, vimModeEnabled])

  // Push per-session model to OpenCode on tab switch
  useEffect(() => {
    const model = getModelForRequests()
    if (!model) return
    window.opencodeOps.setModel(model).catch((error) => {
      console.error('Failed to push session model to OpenCode:', error)
    })
  }, [
    getModelForRequests,
    sessionId,
    sessionRecord?.model_provider_id,
    sessionRecord?.model_id,
    sessionRecord?.model_variant
  ])

  // Auto-resize textarea (depends on sessionId to handle pre-populated drafts)
  // Uses useLayoutEffect to measure and set height synchronously before paint,
  // ensuring correct height when drafts are loaded on worktree navigation.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [inputValue, sessionId])

  // Set 'answering' status when a question is pending, revert when answered.
  // Guard: only mutate the store when the status actually needs to change,
  // to avoid triggering cascading re-renders from no-op updates.
  useEffect(() => {
    const statusStore = useWorktreeStatusStore.getState()
    const currentStatus = statusStore.sessionStatuses[sessionId]
    if (activeQuestion && sessionId) {
      if (currentStatus?.status !== 'answering') {
        statusStore.setSessionStatus(sessionId, 'answering')
      }
    } else if (!activeQuestion && sessionId) {
      // Question answered/dismissed — restore status based on session mode
      if (currentStatus?.status === 'answering') {
        const currentMode = useSessionStore.getState().getSessionMode(sessionId)
        statusStore.setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
      }
    }
  }, [activeQuestion, sessionId])

  // Set 'permission' status when a permission is pending, revert when replied.
  // Guard: only mutate the store when the status actually needs to change.
  useEffect(() => {
    const statusStore = useWorktreeStatusStore.getState()
    const currentStatus = statusStore.sessionStatuses[sessionId]
    if (activePermission && sessionId) {
      if (currentStatus?.status !== 'permission') {
        statusStore.setSessionStatus(sessionId, 'permission')
      }
    } else if (!activePermission && sessionId) {
      if (currentStatus?.status === 'permission') {
        const currentMode = useSessionStore.getState().getSessionMode(sessionId)
        statusStore.setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
      }
    }
  }, [activePermission, sessionId])

  // Periodic permission hydration while the session is actively streaming.
  // The live SSE event path may occasionally miss `permission.asked` events
  // (e.g., due to event format mismatches), so we poll the REST API as a
  // safety net to ensure the permission dialog appears promptly.
  useEffect(() => {
    if (!isStreaming || !worktreePath || activePermission) return

    // First check after a short delay, then periodic
    const timerId = setInterval(() => {
      window.opencodeOps
        ?.permissionList(worktreePath)
        .then((result) => {
          if (result.success && result.permissions) {
            for (const req of result.permissions) {
              const r = req as PermissionRequest
              if (r.id && r.permission) {
                const targetSessionId =
                  (r.sessionID && resolveHiveSessionIdFromOpencodeId(r.sessionID)) || sessionId
                usePermissionStore.getState().addPermission(targetSessionId, r)
              }
            }
          }
        })
        .catch(() => {
          // Silently ignore — this is a best-effort check
        })
    }, 3000)

    return () => clearInterval(timerId)
  }, [isStreaming, worktreePath, activePermission, sessionId])

  // Clean up rAF-based streaming and scroll guards on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
      if (codexRefreshRafRef.current !== null) {
        cancelAnimationFrame(codexRefreshRafRef.current)
      }
      if (programmaticScrollResetRef.current !== null) {
        cancelAnimationFrame(programmaticScrollResetRef.current)
      }
    }
  }, [])

  // Check if response logging is enabled on mount
  useEffect(() => {
    window.systemOps
      .isLogMode()
      .then((enabled) => {
        isLogModeRef.current = enabled
      })
      .catch(() => {
        // Ignore — logging not available
      })
  }, [])

  // Flush streaming refs to state (used by throttle and immediate flush)
  const flushStreamingState = useCallback(() => {
    setStreamingParts([...streamingPartsRef.current])
    setStreamingContent(streamingContentRef.current)
    pendingTextCharsRef.current = 0
  }, [])

  // Schedule a frame-synced flush (requestAnimationFrame for text updates)
  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        flushStreamingState()
      })
    }
  }, [flushStreamingState])

  // Immediate flush — cancels pending rAF and flushes now (for tool updates and stream end)
  const immediateFlush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    flushStreamingState()
  }, [flushStreamingState])

  // Helper to update streaming parts ref only (no state update — caller decides flush strategy)
  const updateStreamingPartsRef = useCallback(
    (updater: (parts: StreamingPart[]) => StreamingPart[]) => {
      streamingPartsRef.current = updater(streamingPartsRef.current)
    },
    []
  )

  // Helper: ensure the last part is a text part, or add one (throttled)
  const appendTextDelta = useCallback(
    (delta: string) => {
      updateStreamingPartsRef((parts) => {
        const lastPart = parts[parts.length - 1]
        if (lastPart && lastPart.type === 'text') {
          // Append to existing text part
          return [...parts.slice(0, -1), { ...lastPart, text: (lastPart.text || '') + delta }]
        }
        // Create new text part
        return [...parts, { type: 'text' as const, text: delta }]
      })
      // Also update legacy streamingContent for backward compat
      streamingContentRef.current += delta
      pendingTextCharsRef.current += delta.length

      // Flush immediately when enough text has accumulated or at natural line breaks
      // to avoid the "batched single long line" visual jump effect.
      const TEXT_FLUSH_CHAR_THRESHOLD = 100
      if (pendingTextCharsRef.current >= TEXT_FLUSH_CHAR_THRESHOLD || delta.includes('\n')) {
        pendingTextCharsRef.current = 0
        immediateFlush()
      } else {
        scheduleFlush()
      }
    },
    [updateStreamingPartsRef, scheduleFlush, immediateFlush]
  )

  // Helper: set full text on the last text part (frame-synced)
  const setTextContent = useCallback(
    (text: string) => {
      updateStreamingPartsRef((parts) => {
        const lastPart = parts[parts.length - 1]
        if (lastPart && lastPart.type === 'text') {
          return [...parts.slice(0, -1), { ...lastPart, text }]
        }
        return [...parts, { type: 'text' as const, text }]
      })
      streamingContentRef.current = text
      // Frame-synced: batch text updates per animation frame
      scheduleFlush()
    },
    [updateStreamingPartsRef, scheduleFlush]
  )

  // Helper: add or update a tool use part (immediate flush — tools should appear instantly)
  const upsertToolUse = useCallback(
    (
      toolId: string,
      update: Partial<ToolUseInfo> & { name?: string; input?: Record<string, unknown> }
    ) => {
      updateStreamingPartsRef((parts) => {
        const existingIndex = parts.findIndex(
          (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
        )

        console.debug('[TOOL_DEBUG] upsertToolUse', {
          toolId,
          isNew: existingIndex < 0,
          existingName: existingIndex >= 0 ? parts[existingIndex].toolUse?.name : undefined,
          updateName: update.name,
          updateStatus: update.status,
          hasOutput: !!update.output
        })

        if (existingIndex >= 0) {
          // Update existing — preserve name if update doesn't provide one
          const existing = parts[existingIndex]
          const updatedParts = [...parts]
          // Don't let a 'running' status overwrite 'pending' (race: content_block_stop
          // arrives after plan.ready already set status to 'pending')
          const preserveStatus =
            existing.toolUse?.status === 'pending' &&
            (update.status === 'running' || !update.status)
          updatedParts[existingIndex] = {
            ...existing,
            toolUse: {
              ...existing.toolUse!,
              ...update,
              name: update.name || existing.toolUse!.name,
              ...(preserveStatus ? { status: 'pending' as const } : {})
            }
          }
          return updatedParts
        }

        // Add new tool use part
        const newToolUse: ToolUseInfo = {
          id: toolId,
          name: update.name || 'Unknown',
          input: update.input || {},
          status: update.status || ('pending' as ToolStatus),
          startTime: update.startTime || Date.now(),
          ...update
        }
        return [...parts, { type: 'tool_use' as const, toolUse: newToolUse }]
      })
      // Immediate flush for tool updates — tool cards should appear instantly
      immediateFlush()
    },
    [updateStreamingPartsRef, immediateFlush]
  )

  // Reset streaming state
  const resetStreamingState = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingTextCharsRef.current = 0
    streamingPartsRef.current = []
    setStreamingParts([])
    streamingContentRef.current = ''
    setStreamingContent('')
    setIsStreaming(false)
    setIsCompacting(false)
    lastSentPromptRef.current = null
    planXmlDetectionRef.current = { state: 'scanning', buffer: '', cardId: null }
  }, [])

  // Load session info and connect to OpenCode
  useEffect(() => {
    finalizedMessageIdsRef.current.clear()
    hasFinalizedCurrentResponseRef.current = false
    sessionModelHydratedRef.current = false
    childToSubtaskIndexRef.current.clear()

    // Load saved draft for this session
    window.db.session.getDraft(sessionId).then((draft) => {
      if (draft) {
        setInputValue(draft)
        inputValueRef.current = draft
      }
    })

    transcriptSourceRef.current = {
      worktreePath: null,
      opencodeSessionId: null
    }
    const isCodexSession = sessionRecord?.agent_sdk === 'codex'

    const loadMessages = async (
      source?: {
        worktreePath?: string | null
        opencodeSessionId?: string | null
      },
      options?: {
        preferDurableCodex?: boolean
      }
    ): Promise<OpenCodeMessage[]> => {
      const sourceWorktreePath = source?.worktreePath ?? transcriptSourceRef.current.worktreePath
      const sourceOpencodeSessionId =
        source?.opencodeSessionId ?? transcriptSourceRef.current.opencodeSessionId

      if (typeof sourceWorktreePath === 'string' && sourceWorktreePath.length > 0) {
        transcriptSourceRef.current.worktreePath = sourceWorktreePath
      }
      if (typeof sourceOpencodeSessionId === 'string' && sourceOpencodeSessionId.length > 0) {
        transcriptSourceRef.current.opencodeSessionId = sourceOpencodeSessionId
      }

      const canUseOpenCodeSource =
        Boolean(window.opencodeOps) &&
        typeof sourceWorktreePath === 'string' &&
        sourceWorktreePath.length > 0 &&
        typeof sourceOpencodeSessionId === 'string' &&
        sourceOpencodeSessionId.length > 0

      let loadedMessages: OpenCodeMessage[] = []
      let loadedFromOpenCode = false
      let codexActivities: SessionActivity[] = []
      const currentStoredStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]

      if (isCodexSession) {
        const durableState = await loadCodexDurableState(sessionId)
        loadedMessages = durableState.messages
        codexActivities = durableState.activities

        if (options?.preferDurableCodex && hasSuspiciousCodexRoleGrouping(loadedMessages)) {
          for (let attempt = 0; attempt < 4; attempt++) {
            await delay(100 * (attempt + 1))
            const retriedState = await loadCodexDurableState(sessionId)
            loadedMessages = retriedState.messages
            codexActivities = retriedState.activities
            if (!hasSuspiciousCodexRoleGrouping(loadedMessages)) break
          }
        }
      }

      const preferLiveCodexSource =
        isCodexSession &&
        !options?.preferDurableCodex &&
        canUseOpenCodeSource &&
        (currentStoredStatus?.status === 'working' ||
          currentStoredStatus?.status === 'planning' ||
          loadedMessages.length === 0)

      if (
        (!isCodexSession || loadedMessages.length === 0 || preferLiveCodexSource) &&
        canUseOpenCodeSource
      ) {
        const result = await window.opencodeOps.getMessages(
          sourceWorktreePath,
          sourceOpencodeSessionId
        )
        if (result.success) {
          loadedFromOpenCode = true

          const opencodeMessages = Array.isArray(result.messages) ? result.messages : []
          if (isCodexSession) {
            const isIdle = currentStoredStatus?.type !== 'busy'
            loadedMessages = mergeCodexActivityMessages(
              mapOpencodeMessagesToSessionViewMessages(opencodeMessages),
              codexActivities,
              isIdle
            )
          } else if (loadedMessages.length === 0) {
            loadedMessages = mapOpencodeMessagesToSessionViewMessages(opencodeMessages)
          }

          let totalCost = 0
          let snapshotTokens: TokenInfo | null = null
          let snapshotModelRef: SessionModelRef | undefined
          let latestUserModel: SelectedModel | null = null

          for (let i = opencodeMessages.length - 1; i >= 0; i--) {
            const rawMessage = opencodeMessages[i]
            if (typeof rawMessage !== 'object' || rawMessage === null) continue

            const messageRecord = rawMessage as Record<string, unknown>
            const info = asRecord(messageRecord.info)
            const role = info?.role ?? messageRecord.role

            if (!latestUserModel && role === 'user') {
              latestUserModel = extractSelectedModel(messageRecord)
            }

            if (role !== 'assistant') continue

            totalCost += extractCost(messageRecord)

            if (!snapshotTokens) {
              const tokens = extractTokens(messageRecord)
              if (tokens) {
                snapshotTokens = tokens
                snapshotModelRef = extractModelRef(messageRecord) ?? undefined
              }
            }
          }

          if (snapshotTokens || totalCost > 0) {
            useContextStore.getState().resetSessionTokens(sessionId)
            if (snapshotTokens) {
              useContextStore
                .getState()
                .setSessionTokens(sessionId, snapshotTokens, snapshotModelRef)
            }
            if (totalCost > 0) {
              useContextStore.getState().setSessionCost(sessionId, totalCost)
            }
          }

          if (!sessionModelHydratedRef.current && latestUserModel) {
            sessionModelHydratedRef.current = true
            await useSessionStore.getState().setSessionModel(sessionId, latestUserModel)
          }
        } else {
          console.warn('Failed to load OpenCode transcript:', result.error)
        }
      }

      // If there's a pending plan, override ExitPlanMode tool status to 'pending'
      // so the tool card shows as awaiting approval (transcript reports 'completed').
      let pendingPlanForLoad = useSessionStore.getState().getPendingPlan(sessionId)
      const sessionModeForLoad = useSessionStore.getState().getSessionMode(sessionId)
      if (isCodexSession && !pendingPlanForLoad && sessionModeForLoad === 'plan') {
        const derivedPendingPlan = derivePendingCodexPlan(sessionId, loadedMessages)
        if (derivedPendingPlan) {
          useSessionStore.getState().setPendingPlan(sessionId, derivedPendingPlan)
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
          pendingPlanForLoad = derivedPendingPlan
        }
      }
      if (pendingPlanForLoad?.toolUseID) {
        for (const msg of loadedMessages) {
          if (msg.parts) {
            for (const part of msg.parts) {
              if (part.type === 'tool_use' && part.toolUse?.id === pendingPlanForLoad.toolUseID) {
                part.toolUse.status = 'pending'
              }
            }
          }
        }
      }

      if (isCodexSession && loadedMessages.length > 0) {
        setMessages(loadedMessages)
      } else if (loadedFromOpenCode) {
        // Guard: don't replace existing messages with an empty transcript.
        // This prevents a race where getMessages returns before the SDK has
        // committed the final transcript, which would wipe the visible chat.
        setMessages((currentMessages) => {
          const cachedMessages = readTranscriptCache(sessionId)
          const useCache =
            loadedMessages.length === 0 && currentMessages.length === 0 && cachedMessages.length > 0
          const keepCurrent = loadedMessages.length === 0 && currentMessages.length > 0
          const nextMessages = keepCurrent
            ? currentMessages
            : useCache
              ? cachedMessages
              : loadedMessages
          return nextMessages
        })
      } else {
        setMessages((currentMessages) => {
          const loadedIds = new Set(loadedMessages.map((m) => m.id))
          const localOnly = currentMessages.filter((m) => !loadedIds.has(m.id))
          const nextMessages =
            localOnly.length > 0 ? [...loadedMessages, ...localOnly] : loadedMessages
          return nextMessages
        })
      }

      // NOTE: Do not clear session status here. Status decisions are the
      // responsibility of authoritative sources: the reconnect handler,
      // SSE event handlers, and the global listener.

      return loadedMessages
    }

    const finalizeResponse = async (): Promise<void> => {
      if (newPromptPendingRef.current) {
        // A new prompt was sent during this stream — skip full reload.
        // The next stream completion will finalize both responses.
        newPromptPendingRef.current = false
        resetStreamingState()
        return
      }

      let streamedPartsSnapshot: StreamingPart[] = []
      try {
        streamedPartsSnapshot = JSON.parse(
          JSON.stringify(streamingPartsRef.current ?? [])
        ) as StreamingPart[]
      } catch {
        streamedPartsSnapshot = [...(streamingPartsRef.current ?? [])]
      }
      const streamedContentSnapshot = streamingContentRef.current

      console.debug('[TOOL_DEBUG] finalizeResponse START', {
        streamingPartsCount: streamingPartsRef.current.length,
        toolParts: streamingPartsRef.current
          .filter((p) => p.type === 'tool_use')
          .map((p) => ({
            id: p.toolUse?.id,
            name: p.toolUse?.name,
            status: p.toolUse?.status,
            hasOutput: !!p.toolUse?.output
          }))
      })

      try {
        const refreshedMessages = await loadMessages(undefined, { preferDurableCodex: true })

        console.debug('[TOOL_DEBUG] finalizeResponse LOADED', {
          loadedCount: refreshedMessages.length,
          roles: refreshedMessages.map((m) => m.role),
          toolInfo: refreshedMessages
            .filter((m) => m.role === 'assistant')
            .flatMap((m) =>
              (m.parts ?? [])
                .filter((p) => p.type === 'tool_use')
                .map((p) => ({
                  id: p.toolUse?.id,
                  name: p.toolUse?.name,
                  status: p.toolUse?.status,
                  hasOutput: !!p.toolUse?.output
                }))
            )
        })

        if (
          !isCodexSession &&
          refreshedMessages.length === 0 &&
          (streamedPartsSnapshot.length > 0 || streamedContentSnapshot.length > 0)
        ) {
          setMessages((currentMessages) => {
            const alreadyHasAssistant = currentMessages.some(
              (message) => message.role === 'assistant'
            )
            if (alreadyHasAssistant) return currentMessages

            return [
              ...currentMessages,
              {
                id: `local-stream-${crypto.randomUUID()}`,
                role: 'assistant',
                content: streamedContentSnapshot,
                timestamp: new Date().toISOString(),
                parts: streamedPartsSnapshot
              }
            ]
          })
        }

        if (
          !isCodexSession &&
          (streamedPartsSnapshot.length > 0 || streamedContentSnapshot.length > 0)
        ) {
          setMessages((currentMessages) =>
            appendStreamedAssistantFallback(currentMessages, {
              streamedContent: streamedContentSnapshot,
              streamedParts: streamedPartsSnapshot
            })
          )
        }
      } catch (error) {
        console.error('Failed to refresh messages after stream completion:', error)
        toast.error('Failed to refresh response')
      } finally {
        resetStreamingState()
        setIsSending(false)
        console.debug('[TOOL_DEBUG] finalizeResponse DONE — streaming state cleared')
      }
    }

    // Increment generation counter to invalidate stale closures from previous
    // sessions. This prevents cross-tab content bleed when multiple SessionView
    // instances process events concurrently during tab transitions.
    streamGenerationRef.current += 1
    const currentGeneration = streamGenerationRef.current
    let isEffectActive = true

    const shouldAbortInit = (): boolean => {
      return !isEffectActive || streamGenerationRef.current !== currentGeneration
    }

    // Clear streaming display state. The key={sessionId} on SessionView forces a
    // full remount on session change, so this always starts fresh.
    streamingPartsRef.current = []
    streamingContentRef.current = ''
    childToSubtaskIndexRef.current = new Map()
    codexStreamingMessageIdRef.current = null
    seenCodexEventIdsRef.current = new Set()
    seenCodexEventIdsQueueRef.current = []
    codexRefreshPendingRef.current = false
    codexRefreshInFlightRef.current = false
    if (codexRefreshRafRef.current !== null) {
      cancelAnimationFrame(codexRefreshRafRef.current)
      codexRefreshRafRef.current = null
    }
    setStreamingParts([])
    setStreamingContent('')
    hasFinalizedCurrentResponseRef.current = false
    planXmlDetectionRef.current = { state: 'scanning', buffer: '', cardId: null }

    // Subscribe to OpenCode stream events SYNCHRONOUSLY before any async work.
    // This prevents a race condition where session.idle arrives during async
    // initialization (DB loads, reconnect) and is missed by both this handler
    // (not yet set up) and the global listener (which skips the active session).
    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          // Debug: log ALL session.updated events, even if filtered out
          if (event.type === 'session.updated') {
            console.log('[TITLE_DEBUG] onStream received session.updated (before filter)', {
              eventSessionId: event.sessionId,
              componentSessionId: sessionId,
              match: event.sessionId === sessionId,
              title: event.data?.info?.title || event.data?.title
            })
          }

          // Only handle events for this session
          if (event.sessionId !== sessionId) return

          // Guard: generation check — prevents stale closures from processing
          // events when the user has already switched to a different session.
          if (streamGenerationRef.current !== currentGeneration) return

          if (sessionRecord?.agent_sdk === 'codex') {
            const codexEventId =
              event.data &&
              typeof event.data === 'object' &&
              !Array.isArray(event.data) &&
              typeof (event.data as Record<string, unknown>)._codexEventId === 'string'
                ? ((event.data as Record<string, unknown>)._codexEventId as string)
                : null

            if (codexEventId) {
              if (seenCodexEventIdsRef.current.has(codexEventId)) {
                return
              }
              seenCodexEventIdsRef.current.add(codexEventId)
              seenCodexEventIdsQueueRef.current.push(codexEventId)
              if (seenCodexEventIdsQueueRef.current.length > 500) {
                const recentIds = seenCodexEventIdsQueueRef.current.slice(-250)
                seenCodexEventIdsRef.current = new Set(recentIds)
                seenCodexEventIdsQueueRef.current = recentIds
              }
            }
          }

          // Log event if response logging is active
          if (isLogModeRef.current && logFilePathRef.current) {
            try {
              if (event.type === 'message.part.updated') {
                window.loggingOps.appendResponseLog(logFilePathRef.current, {
                  type: 'part_updated',
                  event: event.data
                })
              } else if (event.type === 'message.updated') {
                window.loggingOps.appendResponseLog(logFilePathRef.current, {
                  type: 'message_updated',
                  event: event.data
                })
              } else if (event.type === 'session.idle') {
                window.loggingOps.appendResponseLog(logFilePathRef.current, {
                  type: 'session_idle'
                })
              }
            } catch {
              // Never let logging failures break the UI
            }
          }

          // Handle session.updated events — update session title in store
          // The SDK event structure is: { data: { info: { title, ... } } }
          if (event.type === 'session.updated') {
            const rawTitle = event.data?.info?.title || event.data?.title
            const sessionTitle = rawTitle ? maybeExtractJsonTitle(rawTitle) : rawTitle
            console.log('[TITLE_DEBUG] SessionView received session.updated', {
              eventSessionId: event.sessionId,
              componentSessionId: sessionId,
              sessionTitle,
              eventData: event.data
            })
            // Skip OpenCode default placeholder titles like "New session - 2026-02-12T21:33:03.013Z"
            const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(
              sessionTitle || ''
            )
            if (sessionTitle && !isOpenCodeDefault) {
              console.log('[TITLE_DEBUG] SessionView calling updateSessionName', { sessionId, sessionTitle })
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
            } else {
              console.log('[TITLE_DEBUG] SessionView SKIPPED updateSessionName', { sessionTitle, isOpenCodeDefault })
            }
            return
          }

          // Handle session materialization — update the stale pending:: session ID
          // so subsequent loadMessages() calls use the real SDK session ID.
          // Also handles fork transitions: when the SDK returns a new session ID
          // after forkSession: true, clear old messages to avoid showing stale
          // content from the pre-fork branch.
          if (event.type === 'session.materialized') {
            const newId = event.data?.newSessionId as string | undefined
            if (newId) {
              // Use the authoritative wasFork flag from the backend instead of
              // guessing based on the old session ID format. The backend knows
              // whether this is initial materialization (pending:: → real ID),
              // an actual fork (undo+resend with forkSession: true), or just an
              // SDK session ID change during normal resume. Only true forks
              // should clear messages. Defaults to false (safe — no clearing)
              // if the backend doesn't send the flag.
              const wasFork = event.data?.wasFork === true
              setOpencodeSessionId(newId)
              transcriptSourceRef.current.opencodeSessionId = newId
              useSessionStore.getState().setOpenCodeSessionId(sessionId, newId)

              // On fork, the new session has its own transcript. Clear old
              // messages so the user only sees the local prompt bubble while
              // the fork streams. finalizeResponse() will reload from the
              // new transcript when the stream completes.
              if (wasFork) {
                setMessages((prev) => prev.filter((m) => m.id.startsWith('local-')))
              }
            }
            return
          }

          // Handle commands_available — re-fetch slash commands after SDK init
          if (event.type === 'session.commands_available') {
            const wtPath = transcriptSourceRef.current.worktreePath
            const opcSid = transcriptSourceRef.current.opencodeSessionId
            if (wtPath) {
              window.opencodeOps
                .commands(wtPath, opcSid ?? undefined)
                .then((result) => {
                  if (result.success && result.commands) {
                    setSlashCommands(result.commands)
                  }
                })
                .catch(() => {
                  // Silently ignore — commands will be fetched on next prompt cycle
                })
            }
            return
          }

          // Handle question events
          if (event.type === 'question.asked') {
            const request = event.data
            if (request?.id && request?.questions) {
              useQuestionStore.getState().addQuestion(sessionId, request)
            }
            return
          }

          if (event.type === 'question.replied' || event.type === 'question.rejected') {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              useQuestionStore.getState().removeQuestion(sessionId, requestId)
            }
            return
          }

          // Handle permission events
          if (event.type === 'permission.asked') {
            const request = event.data
            if (request?.id && request?.permission) {
              const { commandFilter } = useSettingsStore.getState()
              // Security globally off OR all sub-patterns in commandFilter allowlist → auto-approve
              if (
                !commandFilter.enabled ||
                checkAutoApprove(request as PermissionRequest, commandFilter.allowlist)
              ) {
                window.opencodeOps
                  .permissionReply(request.id, 'once', worktreePath || undefined)
                  .catch((err: unknown) => {
                    console.warn('Auto-approve permissionReply failed:', err)
                  })
                return
              }
              usePermissionStore.getState().addPermission(sessionId, request)
            }
            return
          }

          if (event.type === 'permission.replied') {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              usePermissionStore.getState().removePermission(sessionId, requestId)
            }
            return
          }

          // Handle command approval events (command filter system)
          if (event.type === 'command.approval_needed') {
            const request = event.data
            if (request?.id && request?.toolName) {
              useCommandApprovalStore.getState().addApproval(sessionId, request)
            }
            return
          }

          // Handle command approval replies
          if (event.type === 'command.approval_replied') {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
              // Reset status if no more pending approvals (handles transition from background to active)
              const remaining = useCommandApprovalStore.getState().getApprovals(sessionId)
              if (remaining.length === 0) {
                const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
                if (currentStatus?.status === 'command_approval') {
                  const mode = useSessionStore.getState().getSessionMode(sessionId)
                  useWorktreeStatusStore
                    .getState()
                    .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')
                }
              }
            }
            return
          }

          // Handle plan events (ExitPlanMode blocking tool)
          if (event.type === 'plan.ready') {
            const data = event.data as {
              id?: string
              requestId?: string
              plan?: string
              toolUseID?: string
            }
            const requestId = data?.id || data?.requestId
            if (requestId) {
              let planText = data.plan ?? ''

              // If backend didn't provide plan content, extract from preceding streaming text
              if (!planText && data.toolUseID) {
                const parts = streamingPartsRef.current
                const toolIdx = parts.findIndex(
                  (p) => p.type === 'tool_use' && p.toolUse?.id === data.toolUseID
                )
                if (toolIdx > 0) {
                  for (let i = toolIdx - 1; i >= 0; i--) {
                    if (parts[i].type === 'text' && parts[i].text) {
                      planText = parts[i].text!
                      break
                    }
                  }
                }
              }

              // Finalize the streaming plan card (if XML tag detection created one)
              // or create a new one from plan.ready data (fallback for Claude Code /
              // sessions where <proposed_plan> tags weren't present).
              const det = planXmlDetectionRef.current
              const streamingCardId = det.cardId

              // Flush any leftover scanning buffer as regular text
              if (det.buffer) {
                appendTextDelta(det.buffer)
                det.buffer = ''
              }
              // Reset detection state
              planXmlDetectionRef.current = { state: 'scanning', buffer: '', cardId: null }

              if (streamingCardId) {
                // Progressive card exists — finalize with clean plan text + real ID
                updateStreamingPartsRef((parts) =>
                  parts.map((p) => {
                    if (p.type !== 'tool_use' || p.toolUse?.id !== streamingCardId) return p
                    const finalPlan = planText || (p.toolUse!.input.plan as string) || ''
                    return {
                      ...p,
                      toolUse: {
                        ...p.toolUse!,
                        id: data.toolUseID || p.toolUse!.id,
                        input: { ...p.toolUse!.input, plan: finalPlan },
                        status: 'pending' as const
                      }
                    }
                  })
                )
                immediateFlush()
              } else {
                // No progressive card — strip XML from text parts and inject card
                updateStreamingPartsRef((parts) =>
                  parts.map((p) => {
                    if (p.type !== 'text' || !p.text) return p
                    const stripped = p.text
                      .replace(/<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/gi, '')
                      .trim()
                    if (!stripped) return { ...p, text: '' }
                    return { ...p, text: stripped }
                  })
                )

                if (planText && data.toolUseID) {
                  const hasExisting = streamingPartsRef.current.some(
                    (p) => p.type === 'tool_use' && p.toolUse?.id === data.toolUseID
                  )
                  if (hasExisting) {
                    updateStreamingPartsRef((parts) =>
                      parts.map((p) =>
                        p.type === 'tool_use' && p.toolUse?.id === data.toolUseID
                          ? {
                              ...p,
                              toolUse: {
                                ...p.toolUse!,
                                input: { ...p.toolUse!.input, plan: planText },
                                status: 'pending' as const
                              }
                            }
                          : p
                      )
                    )
                  } else {
                    updateStreamingPartsRef((parts) => [
                      ...parts,
                      {
                        type: 'tool_use' as const,
                        toolUse: {
                          id: data.toolUseID,
                          name: 'ExitPlanMode',
                          input: { plan: planText },
                          status: 'pending' as const,
                          startTime: Date.now()
                        }
                      }
                    ])
                  }
                  immediateFlush()
                }
              }

              useSessionStore.getState().setPendingPlan(sessionId, {
                requestId,
                planContent: planText,
                toolUseID: data.toolUseID ?? ''
              })
              if (sessionRecord?.agent_sdk === 'codex') {
                scheduleCodexStreamingRefresh()
              }
              setIsStreaming(false)
              setIsSending(false)
              setQueuedMessages([])
              useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
            }
            return
          }

          if (event.type === 'plan.resolved') {
            useSessionStore.getState().clearPendingPlan(sessionId)
            if (sessionRecord?.agent_sdk === 'codex') {
              scheduleCodexStreamingRefresh()
            }
            return
          }

          // Handle different event types
          const eventRole = getEventMessageRole(event.data)

          if (event.type === 'session.error') {
            if (event.childSessionId) return
            setSessionErrorMessage(extractSessionErrorMessage(event.data))
            setSessionErrorStderr(extractSessionErrorStderr(event.data))
            // Notify kanban store so errored tickets auto-move to review
            notifyKanbanSessionSync(sessionId, { type: 'session_error' })
            return
          }

          if (event.type === 'message.part.updated') {
            // Skip user-message echoes; user messages are already rendered locally.
            if (eventRole === 'user') return

            // Route child/subagent events into their SubtaskCard
            if (event.childSessionId) {
              let subtaskIdx = childToSubtaskIndexRef.current.get(event.childSessionId)

              // Auto-create subtask entry on first child event (SDK doesn't
              // emit a dedicated "subtask" part — the child session just starts
              // streaming).
              if (subtaskIdx === undefined) {
                subtaskIdx = streamingPartsRef.current.length
                updateStreamingPartsRef((parts) => [
                  ...parts,
                  {
                    type: 'subtask',
                    subtask: {
                      id: event.childSessionId!,
                      sessionID: event.childSessionId!,
                      prompt: '',
                      description: '',
                      agent: 'task',
                      parts: [],
                      status: 'running'
                    }
                  }
                ])
                childToSubtaskIndexRef.current.set(event.childSessionId, subtaskIdx)
                immediateFlush()
              }

              if (subtaskIdx !== undefined) {
                const childPart = event.data?.part
                if (childPart?.type === 'text') {
                  updateStreamingPartsRef((parts) => {
                    const updated = [...parts]
                    const subtask = updated[subtaskIdx]
                    if (subtask?.type === 'subtask' && subtask.subtask) {
                      const lastPart = subtask.subtask.parts[subtask.subtask.parts.length - 1]
                      if (lastPart?.type === 'text') {
                        lastPart.text =
                          (lastPart.text || '') + (event.data?.delta || childPart.text || '')
                      } else {
                        subtask.subtask.parts = [
                          ...subtask.subtask.parts,
                          { type: 'text', text: event.data?.delta || childPart.text || '' }
                        ]
                      }
                    }
                    return updated
                  })
                  scheduleFlush()
                } else if (childPart?.type === 'tool') {
                  const state = childPart.state || childPart
                  const toolId =
                    state.toolCallId || childPart.callID || childPart.id || `tool-${Date.now()}`
                  updateStreamingPartsRef((parts) => {
                    const updated = [...parts]
                    const subtask = updated[subtaskIdx]
                    if (subtask?.type === 'subtask' && subtask.subtask) {
                      const existing = subtask.subtask.parts.find(
                        (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
                      )
                      if (existing && existing.type === 'tool_use' && existing.toolUse) {
                        // Update existing tool
                        const statusMap: Record<string, string> = {
                          running: 'running',
                          completed: 'success',
                          error: 'error'
                        }
                        existing.toolUse.status = (statusMap[state.status] || 'running') as
                          | 'pending'
                          | 'running'
                          | 'success'
                          | 'error'
                        if (state.time?.end) existing.toolUse.endTime = state.time.end
                        if (state.status === 'completed') existing.toolUse.output = state.output
                        if (state.status === 'error') existing.toolUse.error = state.error
                      } else {
                        // Add new tool
                        subtask.subtask.parts = [
                          ...subtask.subtask.parts,
                          {
                            type: 'tool_use',
                            toolUse: {
                              id: toolId,
                              name: childPart.tool || state.name || 'unknown',
                              input: state.input,
                              status: 'running',
                              startTime: state.time?.start || Date.now()
                            }
                          }
                        ]
                      }
                    }
                    return updated
                  })
                  immediateFlush()
                }
                setIsStreaming(true)
                return // Don't process as top-level part
              }
            }

            const part = event.data?.part
            if (!part) return

            // Detect echoed user prompts by content.  The SDK often re-emits
            // the user message as a text part without any role field, so we
            // compare against the prompt we just sent.  Once we see non-matching
            // content (i.e. the real assistant response) we clear the ref so it
            // doesn't interfere with later messages.
            if (lastSentPromptRef.current && part.type === 'text') {
              const incoming = (event.data?.delta || part.text || '').trimEnd()
              if (incoming.length > 0 && lastSentPromptRef.current.startsWith(incoming)) {
                // Looks like an echo — skip it
                return
              }
              // First non-matching text means assistant response has started
              lastSentPromptRef.current = null
            }

            if (sessionRecord?.agent_sdk === 'codex') {
              if (part.type === 'text') {
                const delta = event.data?.delta || part.text || ''
                if (delta) {
                  applyCodexStreamingPart({ type: 'text', text: delta })
                }
              } else if (part.type === 'reasoning') {
                const delta = event.data?.delta || part.text || ''
                if (delta) {
                  applyCodexStreamingPart({ type: 'reasoning', reasoning: delta })
                }
              } else if (part.type === 'tool') {
                const state = part.state || {}
                const statusMap: Record<string, ToolStatus> = {
                  pending: 'pending',
                  running: 'running',
                  completed: 'success',
                  error: 'error'
                }
                applyCodexStreamingPart({
                  type: 'tool_use',
                  toolUse: {
                    id: part.callID || part.id || `tool-${Date.now()}`,
                    name: part.tool || 'Unknown',
                    input: state.input || {},
                    status: statusMap[state.status] || 'running',
                    startTime: state.time?.start || Date.now(),
                    endTime: state.time?.end,
                    output: state.status === 'completed' ? state.output : undefined,
                    error: state.status === 'error' ? state.error : undefined
                  }
                })
              }

              setIsStreaming(true)
              return
            }

            // New stream content means we're processing a new assistant response.
            if (
              streamingPartsRef.current.length === 0 &&
              streamingContentRef.current.length === 0
            ) {
              hasFinalizedCurrentResponseRef.current = false
            }

            if (part.type === 'text') {
              setIsCompacting(false)
              const delta = event.data?.delta

              // Codex plan mode: scan for <proposed_plan> XML tags and route
              // only the plan content into an ExitPlanMode card. Text before/
              // after the tags renders as normal chat text.
              const isCodexPlan =
                sessionRecord?.agent_sdk === 'codex' &&
                useSessionStore.getState().getSessionMode(sessionId) === 'plan'

              if (isCodexPlan) {
                const textDelta = delta || part.text || ''
                if (!textDelta) {
                  setIsStreaming(true)
                } else {
                  const det = planXmlDetectionRef.current
                  const OPEN_TAG = '<proposed_plan>'
                  const CLOSE_TAG = '</proposed_plan>'

                  if (det.state === 'scanning') {
                    det.buffer += textDelta
                    const tagIdx = det.buffer.toLowerCase().indexOf(OPEN_TAG)

                    if (tagIdx !== -1) {
                      // Found opening tag — split at the tag boundary
                      const beforeTag = det.buffer.slice(0, tagIdx)
                      const afterTag = det.buffer.slice(tagIdx + OPEN_TAG.length)
                      det.buffer = ''

                      if (beforeTag) appendTextDelta(beforeTag)

                      // Check if closing tag is already present
                      const closeIdx = afterTag.toLowerCase().indexOf(CLOSE_TAG)
                      let planContent: string

                      if (closeIdx !== -1) {
                        planContent = afterTag.slice(0, closeIdx).trim()
                        det.state = 'done'
                        const afterClose = afterTag.slice(closeIdx + CLOSE_TAG.length)
                        if (afterClose.trim()) appendTextDelta(afterClose)
                      } else {
                        planContent = afterTag
                        det.state = 'routing'
                      }

                      const tempId = `codex-plan-streaming-${Date.now()}`
                      det.cardId = tempId
                      updateStreamingPartsRef((parts) => [
                        ...parts,
                        {
                          type: 'tool_use' as const,
                          toolUse: {
                            id: tempId,
                            name: 'ExitPlanMode',
                            input: { plan: planContent },
                            status: 'running' as const,
                            startTime: Date.now()
                          }
                        }
                      ])
                      immediateFlush()
                    } else {
                      // No opening tag yet — flush text that can't be a partial tag match.
                      // Any suffix of the buffer that matches a prefix of the open tag
                      // must be retained (e.g. buffer ends with "<propo").
                      const maxPartial = Math.min(det.buffer.length, OPEN_TAG.length - 1)
                      let safePoint = det.buffer.length
                      for (let len = maxPartial; len >= 1; len--) {
                        if (OPEN_TAG.startsWith(det.buffer.slice(-len).toLowerCase())) {
                          safePoint = det.buffer.length - len
                          break
                        }
                      }
                      if (safePoint > 0) {
                        appendTextDelta(det.buffer.slice(0, safePoint))
                        det.buffer = det.buffer.slice(safePoint)
                      }
                    }
                  } else if (det.state === 'routing') {
                    // Inside <proposed_plan> — append to card, watch for close tag
                    const toolId = det.cardId!
                    const currentCard = streamingPartsRef.current.find(
                      (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
                    )
                    const currentPlan = (currentCard?.toolUse?.input?.plan as string) || ''
                    const combined = currentPlan + textDelta
                    const closeIdx = combined.toLowerCase().indexOf(CLOSE_TAG)

                    if (closeIdx !== -1) {
                      const planContent = combined.slice(0, closeIdx)
                      const afterClose = combined.slice(closeIdx + CLOSE_TAG.length)
                      det.state = 'done'

                      updateStreamingPartsRef((parts) =>
                        parts.map((p) =>
                          p.type === 'tool_use' && p.toolUse?.id === toolId
                            ? {
                                ...p,
                                toolUse: {
                                  ...p.toolUse!,
                                  input: { ...p.toolUse!.input, plan: planContent }
                                }
                              }
                            : p
                        )
                      )
                      scheduleFlush()
                      if (afterClose.trim()) appendTextDelta(afterClose)
                    } else {
                      updateStreamingPartsRef((parts) =>
                        parts.map((p) =>
                          p.type === 'tool_use' && p.toolUse?.id === toolId
                            ? {
                                ...p,
                                toolUse: {
                                  ...p.toolUse!,
                                  input: { ...p.toolUse!.input, plan: combined }
                                }
                              }
                            : p
                        )
                      )
                      scheduleFlush()
                    }
                  } else {
                    // state === 'done' — after closing tag, route as regular text
                    if (delta) appendTextDelta(delta)
                    else if (part.text) setTextContent(part.text)
                  }
                  setIsStreaming(true)
                }
              } else {
                // Normal text handling (non-Codex or non-plan mode)
                if (delta) {
                  appendTextDelta(delta)
                } else if (part.text) {
                  setTextContent(part.text)
                }
                setIsStreaming(true)
              }
            } else if (part.type === 'tool') {
              setIsCompacting(false)
              // Tool part from OpenCode SDK - has callID, tool (name), state
              const toolId = part.callID || part.id || `tool-${Date.now()}`
              const toolName = part.tool || undefined
              const state = part.state || {}

              console.debug('[TOOL_DEBUG] stream event', {
                toolId,
                toolName,
                status: state.status,
                hasOutput: !!state.output,
                hasError: !!state.error,
                hasInput: !!state.input
              })

              const statusMap: Record<string, ToolStatus> = {
                pending: 'pending',
                running: 'running',
                completed: 'success',
                error: 'error'
              }

              upsertToolUse(toolId, {
                ...(toolName ? { name: toolName } : {}),
                // Only include input when the SDK actually provides it, so we don't
                // overwrite the initial input with {} on subsequent status updates.
                ...(state.input ? { input: state.input } : {}),
                status: statusMap[state.status] || 'running',
                startTime: state.time?.start || Date.now(),
                endTime: state.time?.end,
                output: state.status === 'completed' ? state.output : undefined,
                error: state.status === 'error' ? state.error : undefined
              })
              setIsStreaming(true)
            } else if (part.type === 'subtask') {
              const subtaskIndex = streamingPartsRef.current.length // index it will be at
              updateStreamingPartsRef((parts) => [
                ...parts,
                {
                  type: 'subtask',
                  subtask: {
                    id: part.id || `subtask-${Date.now()}`,
                    sessionID: part.sessionID || '',
                    prompt: part.prompt || '',
                    description: part.description || '',
                    agent: part.agent || 'unknown',
                    parts: [],
                    status: 'running'
                  }
                }
              ])
              // Map child session ID to this subtask's index
              if (part.sessionID) {
                childToSubtaskIndexRef.current.set(part.sessionID, subtaskIndex)
              }
              immediateFlush()
              setIsStreaming(true)
            } else if (part.type === 'reasoning') {
              updateStreamingPartsRef((parts) => {
                const last = parts[parts.length - 1]
                if (last?.type === 'reasoning') {
                  return [
                    ...parts.slice(0, -1),
                    {
                      ...last,
                      reasoning: (last.reasoning || '') + (event.data?.delta || part.text || '')
                    }
                  ]
                }
                return [
                  ...parts,
                  { type: 'reasoning' as const, reasoning: event.data?.delta || part.text || '' }
                ]
              })
              scheduleFlush()
              setIsStreaming(true)
            } else if (part.type === 'step-start') {
              updateStreamingPartsRef((parts) => [
                ...parts,
                { type: 'step_start' as const, stepStart: { snapshot: part.snapshot } }
              ])
              immediateFlush()
              setIsStreaming(true)
            } else if (part.type === 'step-finish') {
              updateStreamingPartsRef((parts) => [
                ...parts,
                {
                  type: 'step_finish' as const,
                  stepFinish: {
                    reason: part.reason || '',
                    cost: typeof part.cost === 'number' ? part.cost : 0,
                    tokens: {
                      input: typeof part.tokens?.input === 'number' ? part.tokens.input : 0,
                      output: typeof part.tokens?.output === 'number' ? part.tokens.output : 0,
                      reasoning:
                        typeof part.tokens?.reasoning === 'number' ? part.tokens.reasoning : 0
                    }
                  }
                }
              ])
              immediateFlush()
              setIsStreaming(true)
            } else if (part.type === 'compaction_started') {
              setIsCompacting(true)
              setIsStreaming(true)
              immediateFlush()
            } else if (part.type === 'compaction') {
              setIsCompacting(false)
              updateStreamingPartsRef((parts) => [
                ...parts,
                { type: 'compaction' as const, compactionAuto: part.auto === true }
              ])
              // Reset stale token snapshot — compaction truncates the context window.
              // The next assistant message.updated will carry accurate post-compaction tokens.
              // Use clearSessionTokenSnapshot (not resetSessionTokens) to preserve
              // the accumulated cost and model identity for the session.
              useContextStore.getState().clearSessionTokenSnapshot(sessionId)
              immediateFlush()
              setIsStreaming(true)
            }
          } else if (event.type === 'message.updated') {
            // Skip user-message echoes
            if (eventRole === 'user') return

            // Skip child/subagent messages
            if (event.childSessionId) return

            // Content-based echo detection for message.updated
            if (lastSentPromptRef.current) {
              const parts = event.data?.parts
              if (Array.isArray(parts) && parts.length > 0) {
                const textContent = parts
                  .filter((p: { type?: string }) => p?.type === 'text')
                  .map((p: { text?: string }) => p?.text || '')
                  .join('')
                  .trimEnd()
                if (textContent.length > 0 && lastSentPromptRef.current.startsWith(textContent)) {
                  return // echo -- skip
                }
              }
            }

            // Extract token usage from completed messages (snapshot replacement).
            // On each completed assistant message, replace the token snapshot.
            const info = event.data?.info
            if (info?.time?.completed) {
              const data = event.data as Record<string, unknown> | undefined
              if (data) {
                const tokens = extractTokens(data)
                if (tokens) {
                  const modelRef = extractModelRef(data) ?? undefined
                  useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
                }
                const cost = extractCost(data)
                if (cost > 0) {
                  useContextStore.getState().addSessionCost(sessionId, cost)
                }
                // Extract per-model usage (from SDK result messages) to update context limits
                const modelUsageEntries = extractModelUsage(data)
                if (modelUsageEntries) {
                  for (const entry of modelUsageEntries) {
                    if (entry.contextWindow > 0) {
                      useContextStore.getState().setModelLimit(entry.modelName, entry.contextWindow)
                    }
                  }
                }
              }
            }
          } else if (event.type === 'session.idle') {
            // Child session idle — update subtask status, don't finalize parent
            if (event.childSessionId) {
              const subtaskIdx = childToSubtaskIndexRef.current.get(event.childSessionId)
              if (subtaskIdx !== undefined) {
                updateStreamingPartsRef((parts) => {
                  const updated = [...parts]
                  const subtask = updated[subtaskIdx]
                  if (subtask?.type === 'subtask' && subtask.subtask) {
                    subtask.subtask.status = 'completed'
                  }
                  return updated
                })
                immediateFlush()
              }
              return // Don't finalize the parent session
            }

            // Fallback: session.idle for parent acts as safety net.
            // Primary finalization is handled by session.status {type:'idle'}.
            // This catches edge cases where session.status events are unavailable.
            immediateFlush()
            setIsSending(false)
            setIsCompacting(false)
            // Only clear visual queue if no follow-ups remain
            const hasFollowUps =
              (useSessionStore.getState().pendingFollowUpMessages.get(sessionId)?.length ?? 0) > 0
            if (!hasFollowUps) {
              setQueuedMessages([])
            }
            // Clear any stale command approvals when session goes idle
            useCommandApprovalStore.getState().clearSession(sessionId)

            if (!hasFinalizedCurrentResponseRef.current) {
              hasFinalizedCurrentResponseRef.current = true
              void finalizeResponse()
            }
          } else if (event.type === 'session.status') {
            const status = event.statusPayload || event.data?.status
            if (!status) return

            // Skip child session status -- only parent status drives isStreaming
            if (event.childSessionId) return

            if (status.type === 'busy') {
              // Don't overwrite plan_ready — session is blocked waiting for plan approval
              if (useSessionStore.getState().getPendingPlan(sessionId)) return

              // Session became active (again) — restart streaming state.
              // If we previously finalized on idle, reset so the next idle
              // can finalize the new response.
              setSessionRetry(null)
              setSessionErrorMessage(null)
              setSessionErrorStderr(null)
              setIsCompacting(false)
              setIsStreaming(true)
              codexStreamingMessageIdRef.current = null
              hasFinalizedCurrentResponseRef.current = false
              newPromptPendingRef.current = false
              planXmlDetectionRef.current = { state: 'scanning', buffer: '', cardId: null }
              setIsSending(true)

              // Restore worktree status to working/planning
              const currentMode = useSessionStore.getState().getSessionMode(sessionId)
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
            } else if (status.type === 'idle') {
              // Don't overwrite plan_ready — session is blocked waiting for plan approval
              if (useSessionStore.getState().getPendingPlan(sessionId)) return

              setIsCompacting(false)
              let optimisticMessageId: string | null = null

              void handleSessionIdleFollowUp({
                sessionId,
                isBlocked: () => {
                  const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
                  return currentStatus?.status === 'command_approval' || currentStatus?.status === 'permission'
                },
                dequeueFollowUp: () => useSessionStore.getState().consumeFollowUpMessage(sessionId),
                requeueFollowUp: (message) =>
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message),
                onBeforeDispatch: (message) => {
                  const optimisticMessage = createLocalMessage('user', message)
                  optimisticMessageId = optimisticMessage.id
                  setQueuedMessages((prev) => prev.slice(1))
                  hasFinalizedCurrentResponseRef.current = false
                  setIsStreaming(true)
                  setIsSending(true)
                  setMessages((prev) => [...prev, optimisticMessage])
                  newPromptPendingRef.current = true
                  messageSendTimes.set(sessionId, Date.now())
                  lastSendMode.set(sessionId, 'build')
                  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
                  lastSentPromptRef.current = message
                },
                dispatchFollowUp: async (message) => {
                  const wtPath = transcriptSourceRef.current.worktreePath
                  const opcSid = transcriptSourceRef.current.opencodeSessionId
                  if (!wtPath || !opcSid) {
                    return false
                  }

                  const result = await window.opencodeOps.prompt(
                    wtPath,
                    opcSid,
                    [{ type: 'text', text: message }],
                    getModelForRequests()
                  )

                  if (!result.success) {
                    console.error('Failed to send follow-up message:', result.error)
                    return false
                  }

                  return true
                },
                onDispatchFailure: (message) => {
                  toast.error('Failed to send follow-up prompt')
                  setIsStreaming(false)
                  setIsSending(false)
                  useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
                  setQueuedMessages((prev) => [
                    {
                      id: `queued-${crypto.randomUUID()}`,
                      content: message,
                      timestamp: Date.now()
                    },
                    ...prev
                  ])
                  if (optimisticMessageId) {
                    setMessages((prev) =>
                      prev.filter((entry) => entry.id !== optimisticMessageId)
                    )
                  }
                },
                onComplete: () => {
                  // Session is done — flush and finalize immediately
                  setSessionRetry(null)
                  immediateFlush()
                  setIsSending(false)
                  setQueuedMessages([])
                  // Clear any stale command approvals when session goes idle
                  useCommandApprovalStore.getState().clearSession(sessionId)

                  if (!hasFinalizedCurrentResponseRef.current) {
                    hasFinalizedCurrentResponseRef.current = true
                    void finalizeResponse()
                  }

                  // Set completion badge with duration since user sent the message
                  const sendTime = messageSendTimes.get(sessionId)
                  const durationMs = sendTime ? Date.now() - sendTime : 0
                  const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]
                  const tokenDelta = computeTokenDelta(sessionId)
                  const statusStore = useWorktreeStatusStore.getState()
                  statusStore.setSessionStatus(sessionId, 'completed', { word, durationMs, tokenDelta })
                }
              })
            } else if (status.type === 'retry') {
              setIsStreaming(true)
              setIsSending(true)
              setSessionRetry({
                attempt: asNumber(status.attempt),
                message: asString(status.message),
                next: asNumber(status.next)
              })
            }
          }
        })
      : () => {}

    const initializeSession = async (): Promise<void> => {
      if (shouldAbortInit()) return

      setViewState({ status: 'connecting' })
      setSessionRetry(null)
      setSessionErrorMessage(null)
      setSessionErrorStderr(null)

      // Part A: Instantly restore streaming indicators from the global status store.
      // useWorktreeStatusStore persists across SessionView remounts (key= causes remount),
      // so if this session was busy before the tab switch, we restore the UI immediately
      // without waiting for the async reconnect or an SSE event.
      const storedStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
      if (storedStatus?.status === 'working' || storedStatus?.status === 'planning') {
        setIsStreaming(true)
        setIsSending(true)
      }

      try {
        // 1. Resolve session/worktree metadata so transcript loading can prefer OpenCode
        const session = (await window.db.session.get(sessionId)) as DbSession | null
        if (shouldAbortInit()) return
        if (!session) {
          throw new Error('Session not found')
        }

        if (session.model_provider_id && session.model_id) {
          sessionModelHydratedRef.current = true
          await window.opencodeOps
            .setModel({
              providerID: session.model_provider_id,
              modelID: session.model_id,
              variant: session.model_variant ?? undefined
            })
            .catch((error) => {
              console.error('Failed to hydrate session model from database:', error)
            })
        }

        let wtPath: string | null = null
        if (session.worktree_id) {
          setWorktreeId(session.worktree_id)
          const worktree = (await window.db.worktree.get(session.worktree_id)) as DbWorktree | null
          if (shouldAbortInit()) return
          if (worktree) {
            wtPath = worktree.path
            setWorktreePath(wtPath)
            transcriptSourceRef.current.worktreePath = wtPath
          }
        } else if (session.connection_id) {
          // Connection session: resolve the connection folder path
          setConnectionId(session.connection_id)
          try {
            const connResult = await window.connectionOps.get(session.connection_id)
            if (shouldAbortInit()) return
            if (connResult.success && connResult.connection) {
              wtPath = connResult.connection.path
              setWorktreePath(wtPath)
              transcriptSourceRef.current.worktreePath = wtPath
            }
          } catch {
            console.warn('Failed to resolve connection path for session')
          }
        }

        const existingOpcSessionId = session.opencode_session_id
        if (existingOpcSessionId) {
          setOpencodeSessionId(existingOpcSessionId)
          transcriptSourceRef.current.opencodeSessionId = existingOpcSessionId
        }

        // 1b. Hydrate revert boundary BEFORE loading messages so the filter
        // is applied to the very first render that includes transcript data.
        if (wtPath && existingOpcSessionId && window.opencodeOps?.sessionInfo) {
          try {
            const sessionInfo = await window.opencodeOps.sessionInfo(wtPath, existingOpcSessionId)
            if (shouldAbortInit()) return
            if (sessionInfo.success) {
              setRevertMessageID(sessionInfo.revertMessageID ?? null)
              revertDiffRef.current = sessionInfo.revertDiff ?? null
            }
          } catch {
            // Non-critical — reconnect will also provide revertMessageID
          }
        }

        // 2. Hydrate transcript (OpenCode canonical source when possible)
        const loadedMessages = await loadMessages({
          worktreePath: wtPath,
          opencodeSessionId: existingOpcSessionId
        })
        if (shouldAbortInit()) return

        // 2b. Restore streaming parts from the last persisted assistant message,
        // but ONLY when the session is actively busy. For idle sessions the
        // completed response is already in `messages` from the DB — populating
        // the streaming overlay would cause the assistant message to render twice.
        const isSessionBusy =
          storedStatus?.status === 'working' || storedStatus?.status === 'planning'
        if (isSessionBusy && loadedMessages.length > 0) {
          const lastMsg = loadedMessages[loadedMessages.length - 1]
          if (lastMsg.role === 'assistant' && lastMsg.parts && lastMsg.parts.length > 0) {
            const dbParts = lastMsg.parts.map((p) => ({ ...p }))
            let restoredParts = dbParts

            if (streamingPartsRef.current.length > 0) {
              // Merge: DB parts are the base, but keep any streaming parts
              // that have a tool_use with a callID not yet in the DB parts.
              // This handles tool calls that arrived after the DB snapshot.
              const dbToolIds = new Set(
                dbParts
                  .filter((p) => p.type === 'tool_use' && p.toolUse?.id)
                  .map((p) => p.toolUse!.id)
              )
              const extraParts = streamingPartsRef.current.filter(
                (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
              )
              restoredParts = [...dbParts, ...extraParts]
            }

            if (restoredParts.length > 0) {
              streamingPartsRef.current = restoredParts
              setStreamingParts([...streamingPartsRef.current])

              const textParts = streamingPartsRef.current.filter((p) => p.type === 'text')
              const content = textParts.map((p) => p.text || '').join('')
              streamingContentRef.current = content
              setStreamingContent(content)
              setIsStreaming(true)
              setMessages((currentMessages) => {
                const currentLast = currentMessages[currentMessages.length - 1]
                if (
                  currentLast &&
                  currentLast.role === 'assistant' &&
                  currentLast.id === lastMsg.id &&
                  !currentLast.id.startsWith('local-')
                ) {
                  return currentMessages.slice(0, -1)
                }
                return currentMessages
              })
            } else {
              streamingPartsRef.current = []
              streamingContentRef.current = ''
              setStreamingParts([])
              setStreamingContent('')
            }
          }
        }

        // 3. Continue with OpenCode connection setup

        if (!wtPath) {
          // No worktree - just show messages without OpenCode
          console.warn('No worktree path for session, OpenCode disabled')
          setViewState({ status: 'connected' })
          return
        }

        if (!window.opencodeOps) {
          console.warn('OpenCode API unavailable, session view running in local-only mode')
          setViewState({ status: 'connected' })
          return
        }

        // 4. Connect to OpenCode

        // For Claude Code sessions, set known model limits immediately so the
        // ContextIndicator shows the 200k limit without waiting for the first
        // SDK init message.  The init message will also emit session.model_limits
        // to confirm, but this avoids a flash of "limit unavailable".
        if (sessionRecord?.agent_sdk === 'claude-code') {
          const claudeModels = [
            { id: 'opus', context: 1000000 },
            { id: 'sonnet', context: 200000 },
            { id: 'haiku', context: 200000 }
          ]
          for (const m of claudeModels) {
            // Store without providerID (wildcard "*") so the limit is found
            // regardless of whether the session uses providerID "claude-code"
            // or "anthropic".
            useContextStore.getState().setModelLimit(m.id, m.context)
          }
        }

        // For Codex sessions, pre-seed known model limits so the context bar
        // renders immediately before the first thread/tokenUsage/updated event.
        if (sessionRecord?.agent_sdk === 'codex') {
          const codexModels = [
            { id: 'gpt-5.4', context: 258400 },
            { id: 'gpt-5.3-codex', context: 258400 },
            { id: 'gpt-5.3-codex-spark', context: 258400 },
            { id: 'gpt-5.2-codex', context: 258400 }
          ]
          for (const m of codexModels) {
            useContextStore.getState().setModelLimit(m.id, m.context, 'codex')
            useContextStore.getState().setModelLimit(m.id, m.context)
          }
        }

        // Fetch context limits for all provider/model combinations (fire-and-forget).
        // This avoids model-id collisions across providers and lets context usage use
        // the exact model that produced the latest assistant message.
        const fetchModelLimits = (): void => {
          window.opencodeOps
            .listModels()
            .then((result) => {
              const providers = Array.isArray(result.providers)
                ? result.providers
                : (result.providers as { providers?: unknown[] } | undefined)?.providers
              if (!result.success || !Array.isArray(providers)) return

              for (const provider of providers) {
                if (typeof provider !== 'object' || provider === null) continue

                const providerRecord = provider as Record<string, unknown>
                const providerID =
                  typeof providerRecord.id === 'string' ? providerRecord.id : undefined
                if (!providerID) continue

                const models =
                  typeof providerRecord.models === 'object' && providerRecord.models !== null
                    ? (providerRecord.models as Record<string, unknown>)
                    : {}

                for (const [modelID, modelValue] of Object.entries(models)) {
                  if (typeof modelValue !== 'object' || modelValue === null) continue
                  const modelRecord = modelValue as Record<string, unknown>
                  const limit =
                    typeof modelRecord.limit === 'object' && modelRecord.limit !== null
                      ? (modelRecord.limit as Record<string, unknown>)
                      : undefined
                  const context = typeof limit?.context === 'number' ? limit.context : 0

                  if (context > 0) {
                    useContextStore.getState().setModelLimit(modelID, context, providerID)
                  }
                }
              }
            })
            .catch((err) => {
              console.warn('Failed to fetch model limits:', err)
            })
        }

        // Fetch slash commands (fire-and-forget)
        const fetchCommands = (path: string, opcSessionId?: string): void => {
          window.opencodeOps
            .commands(path, opcSessionId)
            .then((result) => {
              if (result.success && result.commands) {
                setSlashCommands(result.commands)
              }
            })
            .catch((err) => {
              console.warn('Failed to fetch slash commands:', err)
            })
        }

        // Hydrate any pending permission requests (fire-and-forget).
        // The REST endpoint returns ALL pending permissions for the directory,
        // so we use PermissionRequest.sessionID (OpenCode session ID) to route
        // each permission to the correct Hive session rather than blindly
        // assigning to the mounting session.
        const hydratePermissions = (path: string): void => {
          window.opencodeOps
            .permissionList(path)
            .then((result) => {
              if (result.success && result.permissions) {
                for (const req of result.permissions) {
                  const r = req as PermissionRequest
                  if (r.id && r.permission) {
                    const targetSessionId =
                      (r.sessionID && resolveHiveSessionIdFromOpencodeId(r.sessionID)) || sessionId
                    usePermissionStore.getState().addPermission(targetSessionId, r)
                  }
                }
              }
            })
            .catch((err) => {
              console.warn('Failed to hydrate permissions:', err)
            })
        }

        // Send any pending initial message (e.g., from code review)
        const sendPendingMessage = async (path: string, opcId: string): Promise<void> => {
          if (shouldAbortInit()) return
          const pendingMsg = useSessionStore.getState().dequeuePendingMessage(sessionId)
          if (!pendingMsg) return

          const restorePendingAfterFailure = (): void => {
            useSessionStore.getState().requeuePendingMessage(sessionId, pendingMsg)
            newPromptPendingRef.current = false
            useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
          }

          try {
            // Mirror handleSend: set streaming/sending state BEFORE the prompt call
            // so the UI shows the correct state and finalizeResponse behaves correctly.
            hasFinalizedCurrentResponseRef.current = false
            setIsSending(true)

            setMessages((prev) => [...prev, createLocalMessage('user', pendingMsg)])

            // Mark that a new prompt is in flight — prevents finalizeResponse
            // from reordering this message if a previous stream is still completing.
            newPromptPendingRef.current = true

            // Start completion timer for auto-sent pending prompts (e.g. PR creation)
            messageSendTimes.set(sessionId, Date.now())
            userExplicitSendTimes.set(sessionId, Date.now())
            snapshotTokenBaseline(sessionId)
            // Set worktree status based on session mode
            const currentMode = useSessionStore.getState().getSessionMode(sessionId)
            lastSendMode.set(sessionId, currentMode)
            useWorktreeStatusStore
              .getState()
              .setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
            // Apply mode prefix for OpenCode sessions (Claude Code uses native plan mode)
            const modePrefix =
              currentMode === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
              : currentMode === 'plan' && !skipPlanModePrefix ? PLAN_MODE_PREFIX
              : ''
            const promptMessage = modePrefix + pendingMsg
            // Store the full prompt so the stream handler can detect SDK echoes
            lastSentPromptRef.current = promptMessage
            const model = getModelForRequests()
            // Send as parts array (matching handleSend format) for consistent SDK handling
            const parts: Array<{ type: 'text'; text: string }> = [
              { type: 'text' as const, text: promptMessage }
            ]
            const result = await window.opencodeOps.prompt(
              path,
              opcId,
              parts,
              model,
              codexPromptOptions
            )
            if (shouldAbortInit()) {
              if (!result.success) {
                restorePendingAfterFailure()
              }
              setIsSending(false)
              return
            }
            if (!result.success) {
              console.error('Failed to send pending message:', result.error)
              toast.error('Failed to send review prompt')
              restorePendingAfterFailure()
              setIsSending(false)
            }
          } catch (err) {
            console.error('Failed to send pending message:', err)
            toast.error('Failed to send review prompt')
            restorePendingAfterFailure()
            setIsSending(false)
          }
        }

        if (existingOpcSessionId) {
          // Try to reconnect to existing session
          const reconnectResult = await window.opencodeOps.reconnect(
            wtPath,
            existingOpcSessionId,
            sessionId
          )
          if (shouldAbortInit()) return
          if (reconnectResult.success) {
            setOpencodeSessionId(existingOpcSessionId)
            useSessionStore.getState().setOpenCodeSessionId(sessionId, existingOpcSessionId)
            transcriptSourceRef.current.opencodeSessionId = existingOpcSessionId
            // Only update revertMessageID from reconnect if it carries a value;
            // sessionInfo already hydrated the authoritative value earlier.
            if (reconnectResult.revertMessageID != null) {
              setRevertMessageID(reconnectResult.revertMessageID)
            }
            fetchModelLimits()
            fetchCommands(wtPath, existingOpcSessionId)
            hydratePermissions(wtPath)
            // Create response log file if logging is enabled
            if (isLogModeRef.current) {
              try {
                const logPath = await window.loggingOps.createResponseLog(sessionId)
                logFilePathRef.current = logPath
              } catch (e) {
                console.warn('Failed to create response log:', e)
              }
            }
            setViewState({ status: 'connected' })

            // Part B: Authoritative status from OpenCode SDK.
            // Corrects Part A if the session finished while we were away,
            // or confirms busy if the store was accurate.
            // Don't overwrite plan_ready — session is blocked waiting for plan approval.
            const hasPendingPlanOnReconnect = useSessionStore.getState().getPendingPlan(sessionId)
            if (reconnectResult.sessionStatus === 'busy') {
              if (!hasPendingPlanOnReconnect) {
                setSessionRetry(null)
                setSessionErrorMessage(null)
                setSessionErrorStderr(null)
                setIsStreaming(true)
                setIsSending(true)
                const currentMode = useSessionStore.getState().getSessionMode(sessionId)
                useWorktreeStatusStore
                  .getState()
                  .setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
              }
            } else if (reconnectResult.sessionStatus === 'idle') {
              if (!hasPendingPlanOnReconnect) {
                setIsStreaming(false)
                setIsSending(false)
                setSessionRetry(null)
                setSessionErrorMessage(null)
                setSessionErrorStderr(null)
                // If the session was previously busy, the agent finished while we
                // were away — show a completion badge instead of clearing to "Ready".
                if (storedStatus?.status === 'working' || storedStatus?.status === 'planning') {
                  const sendTime = messageSendTimes.get(sessionId)
                  const durationMs = sendTime ? Date.now() - sendTime : 0
                  const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]
                  const tokenDelta = computeTokenDelta(sessionId)
                  useWorktreeStatusStore
                    .getState()
                    .setSessionStatus(sessionId, 'completed', { word, durationMs, tokenDelta })
                } else {
                  useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
                }
              }
            } else if (reconnectResult.sessionStatus === 'retry') {
              setIsStreaming(true)
              setIsSending(true)
              setSessionRetry({})
            }

            // Reload transcript for busy/retry sessions (new messages may have arrived
            // between first load and reconnect completion). For idle sessions the first
            // load already has the complete transcript.
            if (reconnectResult.sessionStatus !== 'idle') {
              await loadMessages({ worktreePath: wtPath, opencodeSessionId: existingOpcSessionId })
              if (shouldAbortInit()) return
            }

            await sendPendingMessage(wtPath, existingOpcSessionId)
            return
          }
        }

        // Create new OpenCode session
        const connectResult = await window.opencodeOps.connect(wtPath, sessionId)
        if (shouldAbortInit()) return
        if (connectResult.success && connectResult.sessionId) {
          setOpencodeSessionId(connectResult.sessionId)
          useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
          transcriptSourceRef.current.opencodeSessionId = connectResult.sessionId
          setRevertMessageID(null)
          fetchModelLimits()
          fetchCommands(wtPath, connectResult.sessionId)
          hydratePermissions(wtPath)
          // Persist only for first-time session connections.
          // If reconnect to an existing OpenCode session failed and we had to
          // open a temporary replacement session, keep the original pointer in
          // DB to avoid losing historical transcript linkage.
          if (!existingOpcSessionId) {
            await window.db.session.update(sessionId, {
              opencode_session_id: connectResult.sessionId
            })
          }
          // Create response log file if logging is enabled
          if (isLogModeRef.current) {
            try {
              const logPath = await window.loggingOps.createResponseLog(sessionId)
              logFilePathRef.current = logPath
            } catch (e) {
              console.warn('Failed to create response log:', e)
            }
          }
          setViewState({ status: 'connected' })

          // Refresh transcript after establishing the active OpenCode session.
          await loadMessages({ worktreePath: wtPath, opencodeSessionId: connectResult.sessionId })
          if (shouldAbortInit()) return

          await sendPendingMessage(wtPath, connectResult.sessionId)
        } else {
          throw new Error(connectResult.error || 'Failed to connect to OpenCode')
        }
      } catch (error) {
        console.error('Failed to initialize session:', error)
        setViewState({
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Failed to connect to session'
        })
      }
    }

    initializeSession()

    // Cleanup on unmount or session change
    return () => {
      isEffectActive = false
      unsubscribe()
      // DO NOT clear questions or permissions — they must persist across tab switches.
      // They are removed individually when answered/rejected via removeQuestion/removePermission.
      // Note: We intentionally do NOT disconnect from OpenCode on unmount.
      // Sessions persist across project switches. The main process keeps
      // event subscriptions alive so responses are not lost.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Save draft on unmount or session change
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      const currentValue = inputValueRef.current
      if (currentValue) {
        window.db.session.updateDraft(sessionId, currentValue)
      }
    }
  }, [sessionId])

  // Handle retry connection
  const handleRetry = useCallback(async () => {
    setViewState({ status: 'connecting' })
    setOpencodeSessionId(null)
    setRevertMessageID(null)
    setSessionRetry(null)
    setSessionErrorMessage(null)
    setSessionErrorStderr(null)
    setWorktreePath(null)
    transcriptSourceRef.current = {
      worktreePath: null,
      opencodeSessionId: null
    }

    try {
      const session = (await window.db.session.get(sessionId)) as DbSession | null
      if (!session) {
        throw new Error('Session not found')
      }

      if (!session.worktree_id) {
        setMessages([])
        setViewState({ status: 'connected' })
        return
      }

      const worktree = (await window.db.worktree.get(session.worktree_id)) as DbWorktree | null
      if (!worktree) {
        setMessages([])
        setViewState({ status: 'connected' })
        return
      }

      setWorktreePath(worktree.path)
      transcriptSourceRef.current.worktreePath = worktree.path
      const existingOpcSessionId = session.opencode_session_id

      if (!window.opencodeOps) {
        console.warn('OpenCode API unavailable, retry falling back to local-only mode')
        setMessages([])
        setViewState({ status: 'connected' })
        return
      }

      let activeOpcSessionId = existingOpcSessionId

      if (existingOpcSessionId) {
        const reconnectResult = await window.opencodeOps.reconnect(
          worktree.path,
          existingOpcSessionId,
          sessionId
        )
        if (reconnectResult.success) {
          setOpencodeSessionId(existingOpcSessionId)
          useSessionStore.getState().setOpenCodeSessionId(sessionId, existingOpcSessionId)
          transcriptSourceRef.current.opencodeSessionId = existingOpcSessionId
          if (reconnectResult.revertMessageID != null) {
            setRevertMessageID(reconnectResult.revertMessageID)
          }
          activeOpcSessionId = existingOpcSessionId
        } else {
          setRevertMessageID(null)
          activeOpcSessionId = null
        }
      }

      if (!activeOpcSessionId) {
        const connectResult = await window.opencodeOps.connect(worktree.path, sessionId)
        if (!connectResult.success || !connectResult.sessionId) {
          throw new Error(connectResult.error || 'Failed to connect')
        }

        activeOpcSessionId = connectResult.sessionId
        setOpencodeSessionId(connectResult.sessionId)
        useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
        transcriptSourceRef.current.opencodeSessionId = connectResult.sessionId
        setRevertMessageID(null)
        if (!existingOpcSessionId) {
          await window.db.session.update(sessionId, {
            opencode_session_id: connectResult.sessionId
          })
        }
      }

      const transcriptResult = await window.opencodeOps.getMessages(
        worktree.path,
        activeOpcSessionId
      )
      if (!transcriptResult.success) {
        console.warn('Retry transcript load from OpenCode failed:', transcriptResult.error)
        setMessages([])
        setViewState({ status: 'connected' })
        return
      }

      const rawMessages = Array.isArray(transcriptResult.messages) ? transcriptResult.messages : []
      let loadedMessages = mapOpencodeMessagesToSessionViewMessages(rawMessages)
      if (session.agent_sdk === 'codex') {
        const durableState = await loadCodexDurableState(sessionId)
        loadedMessages = mergeCodexActivityMessages(loadedMessages, durableState.activities, true)
      }
      setMessages(loadedMessages)
      setViewState({ status: 'connected' })
    } catch (error) {
      console.error('Retry failed:', error)
      setViewState({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to connect'
      })
    }
  }, [sessionId])

  // Handle question reply
  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      try {
        await window.opencodeOps.questionReply(requestId, answers, worktreePath || undefined)
      } catch (err) {
        console.error('Failed to reply to question:', err)
        toast.error('Failed to send answer')
      }
    },
    [worktreePath]
  )

  // Handle question reject/dismiss
  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      try {
        await window.opencodeOps.questionReject(requestId, worktreePath || undefined)
      } catch (err) {
        console.error('Failed to reject question:', err)
        toast.error('Failed to dismiss question')
      }
    },
    [worktreePath]
  )

  // Handle permission reply (allow once, allow always, or reject)
  const handlePermissionReply = useCallback(
    async (requestId: string, reply: 'once' | 'always' | 'reject', message?: string) => {
      try {
        await window.opencodeOps.permissionReply(
          requestId,
          reply,
          worktreePath || undefined,
          message
        )
      } catch (err) {
        console.error('Failed to reply to permission:', err)
        toast.error('Failed to send permission reply')
      }
    },
    [worktreePath]
  )

  // Handle command approval reply (approve/deny with optional remember + pattern/patterns)
  const handleCommandApprovalReply = useCallback(
    async (
      requestId: string,
      approved: boolean,
      remember?: 'allow' | 'block',
      pattern?: string,
      patterns?: string[]
    ) => {
      try {
        await window.opencodeOps.commandApprovalReply(
          requestId,
          approved,
          remember,
          pattern,
          worktreePath || undefined,
          patterns
        )
        // Remove from store after sending reply
        useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
      } catch (err) {
        console.error('Failed to reply to command approval:', err)
        toast.error('Failed to send command approval reply')
      }
    },
    [worktreePath, sessionId]
  )

  const refreshMessagesFromOpenCode = useCallback(async (): Promise<boolean> => {
    if (sessionRecord?.agent_sdk === 'codex') {
      const durableState = await loadCodexDurableState(sessionId)
      if (worktreePath && opencodeSessionId) {
        const transcriptResult = await window.opencodeOps.getMessages(
          worktreePath,
          opencodeSessionId
        )
        if (transcriptResult.success) {
          const isIdle = !isStreamingRef.current
          const liveMessages = mergeCodexActivityMessages(
            mapOpencodeMessagesToSessionViewMessages(
              Array.isArray(transcriptResult.messages) ? transcriptResult.messages : []
            ),
            durableState.activities,
            isIdle
          )
          setMessages(liveMessages)
          return liveMessages.length > 0
        }
      }

      if (durableState.messages.length > 0) {
        setMessages(durableState.messages)
        return true
      }
    }

    if (!worktreePath || !opencodeSessionId) return false

    const transcriptResult = await window.opencodeOps.getMessages(worktreePath, opencodeSessionId)
    if (!transcriptResult.success) {
      console.warn('Failed to refresh OpenCode transcript:', transcriptResult.error)
      return false
    }

    const loadedMessages = mapOpencodeMessagesToSessionViewMessages(
      Array.isArray(transcriptResult.messages) ? transcriptResult.messages : []
    )
    setMessages(loadedMessages)
    return true
  }, [opencodeSessionId, sessionId, sessionRecord?.agent_sdk, worktreePath])

  const refreshCodexStreamingMessages = useCallback(async (): Promise<void> => {
    if (sessionRecord?.agent_sdk !== 'codex') return
    if (!worktreePath || !opencodeSessionId) return

    const durableState = await loadCodexDurableState(sessionId)
    const transcriptResult = await window.opencodeOps.getMessages(worktreePath, opencodeSessionId)
    if (!transcriptResult.success) return

    const liveMessages = mergeCodexActivityMessages(
      mapOpencodeMessagesToSessionViewMessages(
        Array.isArray(transcriptResult.messages) ? transcriptResult.messages : []
      ),
      durableState.activities,
      !isStreamingRef.current
    )
    setMessages(liveMessages)
  }, [opencodeSessionId, sessionId, sessionRecord?.agent_sdk, worktreePath])

  const scheduleCodexStreamingRefresh = useCallback(() => {
    if (sessionRecord?.agent_sdk !== 'codex') return
    if (codexRefreshRafRef.current !== null) return

    codexRefreshRafRef.current = requestAnimationFrame(() => {
      codexRefreshRafRef.current = null
      if (codexRefreshInFlightRef.current) {
        codexRefreshPendingRef.current = true
        return
      }

      codexRefreshInFlightRef.current = true
      refreshCodexStreamingMessages()
        .catch(() => {
          // Best effort; finalization path still does a full refresh.
        })
        .finally(() => {
          codexRefreshInFlightRef.current = false
          if (codexRefreshPendingRef.current) {
            codexRefreshPendingRef.current = false
            scheduleCodexStreamingRefresh()
          }
        })
    })
  }, [refreshCodexStreamingMessages, sessionRecord?.agent_sdk])

  const applyCodexStreamingPart = useCallback(
    (part: StreamingPart) => {
      setMessages((currentMessages) => {
        const messageId =
          codexStreamingMessageIdRef.current ?? `codex-streaming-${crypto.randomUUID()}`
        codexStreamingMessageIdRef.current = messageId

        const existingIndex = currentMessages.findIndex((message) => message.id === messageId)
        const nextMessages = [...currentMessages]
        const existingMessage =
          existingIndex >= 0
            ? {
                ...nextMessages[existingIndex],
                parts: nextMessages[existingIndex].parts
                  ? nextMessages[existingIndex].parts!.map((existingPart) => {
                      if (existingPart.type === 'tool_use' && existingPart.toolUse) {
                        return {
                          ...existingPart,
                          toolUse: { ...existingPart.toolUse }
                        }
                      }
                      if (existingPart.type === 'subtask' && existingPart.subtask) {
                        return {
                          ...existingPart,
                          subtask: {
                            ...existingPart.subtask,
                            parts: [...existingPart.subtask.parts]
                          }
                        }
                      }
                      return { ...existingPart }
                    })
                  : ([] as StreamingPart[])
              }
            : {
                id: messageId,
                role: 'assistant' as const,
                content: '',
                timestamp: new Date().toISOString(),
                parts: [] as StreamingPart[]
              }

        const nextParts = [...(existingMessage.parts ?? [])]

        if (part.type === 'text') {
          const lastPart = nextParts[nextParts.length - 1]
          if (lastPart?.type === 'text') {
            nextParts[nextParts.length - 1] = {
              ...lastPart,
              text: `${lastPart.text ?? ''}${part.text ?? ''}`
            }
          } else {
            nextParts.push({ type: 'text', text: part.text ?? '' })
          }
        } else if (part.type === 'reasoning') {
          const lastPart = nextParts[nextParts.length - 1]
          if (lastPart?.type === 'reasoning') {
            nextParts[nextParts.length - 1] = {
              ...lastPart,
              reasoning: `${lastPart.reasoning ?? ''}${part.reasoning ?? ''}`
            }
          } else {
            nextParts.push({ type: 'reasoning', reasoning: part.reasoning ?? '' })
          }
        } else if (part.type === 'tool_use' && part.toolUse) {
          const existingToolIndex = nextParts.findIndex(
            (candidate) =>
              candidate.type === 'tool_use' && candidate.toolUse?.id === part.toolUse?.id
          )
          if (existingToolIndex >= 0) {
            nextParts[existingToolIndex] = {
              type: 'tool_use',
              toolUse: {
                ...nextParts[existingToolIndex].toolUse!,
                ...part.toolUse
              }
            }
          } else {
            nextParts.push(part)
          }
        } else {
          nextParts.push(part)
        }

        const nextContent = nextParts
          .filter((candidate) => candidate.type === 'text')
          .map((candidate) => candidate.text ?? '')
          .join('')

        const nextMessage: OpenCodeMessage = {
          ...existingMessage,
          content: nextContent,
          parts: nextParts
        }

        if (existingIndex >= 0) {
          nextMessages[existingIndex] = nextMessage
          return nextMessages
        }

        return [...nextMessages, nextMessage]
      })
    },
    [setMessages]
  )

  const handleForkFromAssistantMessage = useCallback(
    async (message: OpenCodeMessage) => {
      if (forkingMessageId) return

      if (!worktreePath || !opencodeSessionId) {
        toast.error('Session is not ready to fork yet')
        return
      }

      const sourceSession = sessionRecord ?? (await window.db.session.get(sessionId))
      if (!sourceSession) {
        toast.error('Session is not ready to fork yet')
        return
      }

      const targetWorktreeId = worktreeId ?? sourceSession.worktree_id
      if (!targetWorktreeId) {
        toast.error('Session has no worktree to fork into')
        return
      }

      const messageIndex = messagesRef.current.findIndex((candidate) => candidate.id === message.id)
      if (messageIndex === -1) {
        toast.error('Could not locate the selected message')
        return
      }

      const cutoffMessage = messagesRef.current
        .slice(messageIndex + 1)
        .find((candidate) => !candidate.id.startsWith('local-'))

      setForkingMessageId(message.id)

      try {
        const forkResult = await window.opencodeOps.fork(
          worktreePath,
          opencodeSessionId,
          cutoffMessage?.id
        )

        if (!forkResult.success || !forkResult.sessionId) {
          throw new Error(forkResult.error || 'Failed to fork session')
        }

        const fallbackForkName = sourceSession.name ? `${sourceSession.name} (fork)` : null
        const forkedSession = await window.db.session.create({
          worktree_id: targetWorktreeId,
          project_id: sourceSession.project_id,
          name: fallbackForkName,
          opencode_session_id: forkResult.sessionId,
          model_provider_id: sourceSession.model_provider_id,
          model_id: sourceSession.model_id,
          model_variant: sourceSession.model_variant
        })

        await useSessionStore.getState().loadSessions(targetWorktreeId, sourceSession.project_id)
        useSessionStore.getState().setActiveSession(forkedSession.id)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to fork session')
      } finally {
        setForkingMessageId(null)
      }
    },
    [
      forkingMessageId,
      opencodeSessionId,
      sessionId,
      sessionRecord,
      worktreeId,
      worktreePath
    ]
  )

  // Handle send message
  const handleSend = useCallback(
    async (overrideValue?: string) => {
      // Apply mention stripping when sending (unless overrideValue is provided,
      // e.g. for built-in commands like "Implement")
      const rawValue = overrideValue ?? fileMentions.getTextForSend(stripAtMentions)
      const trimmedValue = rawValue.trim()
      if (!trimmedValue) return

      if (trimmedValue.startsWith('/')) {
        const spaceIndex = trimmedValue.indexOf(' ')
        const commandName =
          spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex).toLowerCase() : trimmedValue.slice(1)

        if (commandName === 'undo' || commandName === 'redo') {
          if (!worktreePath || !opencodeSessionId) {
            toast.error('OpenCode is not connected')
            return
          }

          setShowSlashCommands(false)
          setInputValue('')
          inputValueRef.current = ''
          setHistoryIndex(null)
          savedDraftRef.current = ''
          if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
          window.db.session.updateDraft(sessionId, null)

          try {
            if (commandName === 'undo') {
              const result = await window.opencodeOps.undo(worktreePath, opencodeSessionId)
              if (!result.success) {
                toast.error(result.error || 'Nothing to undo')
                return
              }

              setRevertMessageID(result.revertMessageID ?? null)
              revertDiffRef.current = result.revertDiff ?? null

              const restoredPrompt =
                typeof result.restoredPrompt === 'string'
                  ? stripPlanModePrefix(result.restoredPrompt)
                  : ''
              setInputValue(restoredPrompt)
              inputValueRef.current = restoredPrompt
            } else {
              if (sessionCapabilities && !sessionCapabilities.supportsRedo) {
                toast.error('Redo is not supported for this session type')
                return
              }
              const result = await window.opencodeOps.redo(worktreePath, opencodeSessionId)
              if (!result.success) {
                toast.error(result.error || 'Nothing to redo')
                return
              }

              setRevertMessageID(result.revertMessageID ?? null)
              if (result.revertMessageID === null) {
                revertDiffRef.current = null
                setInputValue('')
                inputValueRef.current = ''
              }
            }

            const refreshed = await refreshMessagesFromOpenCode()
            if (!refreshed) {
              toast.error('Undo/redo completed, but refresh failed')
            }
          } catch (error) {
            console.error('Built-in command failed:', error)
            toast.error(commandName === 'undo' ? 'Undo failed' : 'Redo failed')
          }

          return
        }

        if (commandName === 'clear') {
          setInputValue('')
          inputValueRef.current = ''
          setShowSlashCommands(false)

          const currentSessionId = sessionId
          const currentWorktreeId = worktreeId
          const currentProjectId = sessionRecord?.project_id

          // Close current tab
          await useSessionStore.getState().closeSession(currentSessionId)

          // Create new session in the same worktree
          if (currentWorktreeId && currentProjectId) {
            const { success, session } = await useSessionStore
              .getState()
              .createSession(currentWorktreeId, currentProjectId)
            if (success && session) {
              useSessionStore.getState().setActiveSession(session.id)
            }
          }

          return
        }

        if (commandName === 'ask') {
          const question = trimmedValue.slice(5).trim() // Remove "/ask " prefix

          if (!question) {
            toast.error('Please provide a question after /ask')
            return
          }

          if (!worktreePath || !opencodeSessionId) {
            toast.error('OpenCode is not connected')
            return
          }

          setShowSlashCommands(false)

          // Clear input and update UI state immediately
          setInputValue('')
          inputValueRef.current = ''
          fileMentions.clearMentions()
          if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
          window.db.session.updateDraft(sessionId, null)

          // Set sending state
          hasFinalizedCurrentResponseRef.current = false
          setIsSending(true)

          resetAutoScrollState()

          // Start completion badge timer
          messageSendTimes.set(sessionId, Date.now())
          userExplicitSendTimes.set(sessionId, Date.now())
          snapshotTokenBaseline(sessionId)
          lastSendMode.set(sessionId, 'ask')
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')

          // Use the ask-specific model if configured, otherwise use session model
          const { useSettingsStore } = await import('@/stores/useSettingsStore')
          const settings = useSettingsStore.getState()
          const askModel = settings.getModelForMode('ask') ?? settings.selectedModel
          const selectedModel = askModel || getModelForRequests()

          // Build PR review comment context for /ask
          const prAskComments = usePRReviewStore.getState().attachedComments
          let prAskContext = ''
          if (prAskComments.length > 0) {
            prAskContext =
              prAskComments
                .map(
                  (c) =>
                    `<pr-comment author="${c.user.login}" file="${c.path}" line="${c.line ?? 'file-level'}">\n${c.body}\n<diff-hunk>${c.diffHunk}</diff-hunk>\n</pr-comment>`
                )
                .join('\n\n') + '\n\n'
          }

          // Prefix with ASK_MODE_PREFIX to prevent code changes
          const prefixedQuestion = prAskContext + ASK_MODE_PREFIX + question

          // Add user message to UI immediately (before response)
          // Include attachment XML so cards render instantly
          const askDisplayContent = buildDisplayContent(attachments, prefixedQuestion)
          setMessages((prev) => [...prev, createLocalMessage('user', askDisplayContent)])

          // Mark that a new prompt is in flight
          newPromptPendingRef.current = true

          // Record prompt to history
          if (worktreeId) {
            usePromptHistoryStore.getState().addPrompt(worktreeId, question)
            useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
          }

          // Build message parts (support file attachments if any)
          const parts = buildMessageParts(attachments, prefixedQuestion)
          setAttachments([])
          usePRReviewStore.getState().clearAttachments()

          try {
            const result = await window.opencodeOps.prompt(
              worktreePath,
              opencodeSessionId,
              parts,
              selectedModel,
              codexPromptOptions
            )

            if (!result.success) {
              console.error('Failed to send /ask question:', result.error)
              toast.error('Failed to send question')
              setIsSending(false)
            }
          } catch (error) {
            console.error('Error sending /ask question:', error)
            toast.error('Failed to send question')
            setIsSending(false)
          }

          return
        }
      }

      // If already streaming, this is a queued follow-up
      const isQueuedMessage = isStreaming

      if (!isQueuedMessage) {
        hasFinalizedCurrentResponseRef.current = false
        setIsSending(true)
      } else {
        setQueuedMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), content: trimmedValue, timestamp: Date.now() }
        ])
        // Persist to the follow-up queue so the idle handler sends it
        useSessionStore.getState().enqueueFollowUpMessage(sessionId, trimmedValue)
        // Clear input but do NOT send — the idle handler will send when the agent finishes
        setInputValue('')
        inputValueRef.current = ''
        fileMentions.clearMentions()
        if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
        window.db.session.updateDraft(sessionId, null)
        return
      }
      setInputValue('')
      inputValueRef.current = ''
      fileMentions.clearMentions()
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      window.db.session.updateDraft(sessionId, null)

      resetAutoScrollState()

      // Clear any stale command approvals from previous turns
      useCommandApprovalStore.getState().clearSession(sessionId)

      // Start the completion badge timer from when the user sends the message
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)

      // Record the mode at send time — used to derive "Plan ready" vs "Ready"
      const currentModeForStatus = useSessionStore.getState().getSessionMode(sessionId)
      lastSendMode.set(sessionId, currentModeForStatus)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(currentModeForStatus) ? 'planning' : 'working')

      // Auto-revert super-plan → plan immediately (one-shot mode).
      // The captured `currentModeForStatus` preserves the original mode for prefix logic below.
      if (currentModeForStatus === 'super-plan') {
        useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      try {
        setSessionRetry(null)
        setSessionErrorMessage(null)
        setSessionErrorStderr(null)

        // When sending after an undo, trim the messages array to remove the
        // undone tail.  Simply clearing revertMessageID would make visibleMessages
        // show ALL messages (including the undone ones) for a brief flash before
        // finalizeResponse() replaces them with the forked transcript.
        const currentRevertId = revertMessageID
        setRevertMessageID(null)
        revertDiffRef.current = null

        // Build the full display content for the optimistic message so that
        // attachment cards (tickets, PR comments, files) render immediately
        // instead of only appearing after a session reload from disk.
        const optimisticMode = currentModeForStatus
        const optimisticModePrefix =
          optimisticMode === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
          : optimisticMode === 'plan' && !skipPlanModePrefix ? PLAN_MODE_PREFIX
          : ''
        const optimisticPrComments = usePRReviewStore.getState().attachedComments
        let optimisticPrContext = ''
        if (optimisticPrComments.length > 0) {
          optimisticPrContext =
            optimisticPrComments
              .map(
                (c) =>
                  `<pr-comment author="${c.user.login}" file="${c.path}" line="${c.line ?? 'file-level'}">\n${c.body}\n<diff-hunk>${c.diffHunk}</diff-hunk>\n</pr-comment>`
              )
              .join('\n\n') + '\n\n'
        }
        const optimisticContent = buildDisplayContent(
          attachments,
          optimisticPrContext + optimisticModePrefix + trimmedValue
        )

        setMessages((prev) => {
          let base = prev
          if (currentRevertId) {
            const boundaryIndex = prev.findIndex((m) => m.id === currentRevertId)
            if (boundaryIndex !== -1) {
              base = prev.slice(0, boundaryIndex)
            }
          }
          return [...base, createLocalMessage('user', optimisticContent)]
        })

        // Mark that a new prompt is in flight — prevents finalizeResponse
        // from reordering this message if a previous stream is still completing.
        newPromptPendingRef.current = true

        // Record prompt to history for Up/Down navigation
        const hKey = worktreeId ?? connectionId
        if (hKey) {
          usePromptHistoryStore.getState().addPrompt(hKey, trimmedValue)
        }
        if (worktreeId) {
          useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
        } else if (connectionId) {
          // Connection session — update all member worktrees
          const connection = useConnectionStore
            .getState()
            .connections.find((c) => c.id === connectionId)
          if (connection) {
            const now = Date.now()
            for (const member of connection.members) {
              useWorktreeStatusStore.getState().setLastMessageTime(member.worktree_id, now)
            }
          }
        }
        setHistoryIndex(null)
        savedDraftRef.current = ''

        // Log user prompt if response logging is active
        if (isLogModeRef.current && logFilePathRef.current) {
          try {
            const currentMode = useSessionStore.getState().getSessionMode(sessionId)
            window.loggingOps.appendResponseLog(logFilePathRef.current, {
              type: 'user_prompt',
              content: trimmedValue,
              mode: currentMode
            })
          } catch {
            // Never let logging failures break the UI
          }
        }

        // Send to OpenCode if connected
        if (worktreePath && opencodeSessionId) {
          const requestModel = getModelForRequests()

          // Track which model is being used on this worktree
          if (requestModel && worktreeId) {
            useWorktreeStore.getState().updateWorktreeModel(worktreeId, requestModel)
            window.db?.worktree
              ?.updateModel({
                worktreeId,
                modelProviderId: requestModel.providerID,
                modelId: requestModel.modelID,
                modelVariant: requestModel.variant ?? null
              })
              .catch(() => {})
          }

          // Detect slash commands and route through the SDK command endpoint
          if (trimmedValue.startsWith('/')) {
            const spaceIndex = trimmedValue.indexOf(' ')
            const commandName =
              spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)
            const commandArgs = spaceIndex > 0 ? trimmedValue.slice(spaceIndex + 1).trim() : ''

            const matchedCommand = allSlashCommands.find((c) => c.name === commandName)

            if (matchedCommand && !matchedCommand.builtIn) {
              // Auto-switch mode based on command's agent field
              if (matchedCommand.agent) {
                const currentMode = useSessionStore.getState().getSessionMode(sessionId)
                const targetMode = matchedCommand.agent === 'plan' ? 'plan' : 'build'
                if (currentMode !== targetMode) {
                  await useSessionStore.getState().setSessionMode(sessionId, targetMode)
                }
              }

              lastSentPromptRef.current = trimmedValue
              setAttachments([])
              usePRReviewStore.getState().clearAttachments()
              const result = await window.opencodeOps.command(
                worktreePath,
                opencodeSessionId,
                commandName,
                commandArgs,
                requestModel
              )
              if (!result.success) {
                console.error('Failed to send command:', result.error)
                toast.error('Failed to send command')
                setIsSending(false)
              }
            } else {
              // Unknown command — send as regular prompt (SDK may handle it)
              const modePrefix =
                currentModeForStatus === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
                : currentModeForStatus === 'plan' && !skipPlanModePrefix ? PLAN_MODE_PREFIX
                : ''
              // Build PR review comment context
              const prAttachedComments = usePRReviewStore.getState().attachedComments
              let prContext = ''
              if (prAttachedComments.length > 0) {
                prContext =
                  prAttachedComments
                    .map(
                      (c) =>
                        `<pr-comment author="${c.user.login}" file="${c.path}" line="${c.line ?? 'file-level'}">\n${c.body}\n<diff-hunk>${c.diffHunk}</diff-hunk>\n</pr-comment>`
                    )
                    .join('\n\n') + '\n\n'
              }
              const promptMessage = prContext + modePrefix + trimmedValue
              lastSentPromptRef.current = promptMessage
              const parts = buildMessageParts(attachments, promptMessage)
              setAttachments([])
              usePRReviewStore.getState().clearAttachments()
              const result = await window.opencodeOps.prompt(
                worktreePath,
                opencodeSessionId,
                parts,
                requestModel,
                codexPromptOptions
              )
              if (!result.success) {
                console.error('Failed to send prompt to OpenCode:', result.error)
                toast.error('Failed to send message to AI')
                setIsSending(false)
              }
            }
          } else {
            // Regular prompt — existing code (with mode prefix, attachments, etc.)
            const modePrefix =
              currentModeForStatus === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
              : currentModeForStatus === 'plan' && !skipPlanModePrefix ? PLAN_MODE_PREFIX
              : ''
            // Build PR review comment context
            const prAttachedComments = usePRReviewStore.getState().attachedComments
            let prContext = ''
            if (prAttachedComments.length > 0) {
              prContext =
                prAttachedComments
                  .map(
                    (c) =>
                      `<pr-comment author="${c.user.login}" file="${c.path}" line="${c.line ?? 'file-level'}">\n${c.body}\n<diff-hunk>${c.diffHunk}</diff-hunk>\n</pr-comment>`
                  )
                  .join('\n\n') + '\n\n'
            }
            const promptMessage = prContext + modePrefix + trimmedValue
            // Store the full prompt so the stream handler can detect SDK echoes
            // of the user message (the SDK often re-emits the prompt without a
            // role field, making it indistinguishable from assistant text).
            lastSentPromptRef.current = promptMessage
            const parts = buildMessageParts(attachments, promptMessage)
            setAttachments([])
            usePRReviewStore.getState().clearAttachments()
            const result = await window.opencodeOps.prompt(
              worktreePath,
              opencodeSessionId,
              parts,
              requestModel,
              codexPromptOptions
            )
            if (!result.success) {
              console.error('Failed to send prompt to OpenCode:', result.error)
              toast.error('Failed to send message to AI')
              setIsSending(false)
            }
          }
          // Don't set isSending to false here - wait for streaming to complete
        } else {
          // No OpenCode connection - show placeholder
          setAttachments([])
          usePRReviewStore.getState().clearAttachments()
          console.warn('No OpenCode connection, showing placeholder response')
          setTimeout(() => {
            const placeholderContent =
              'OpenCode is not connected. Please ensure a worktree is selected and the connection is established.'
            setMessages((prev) => [...prev, createLocalMessage('assistant', placeholderContent)])
            setIsSending(false)
          }, 500)
        }
      } catch (error) {
        console.error('Failed to send message:', error)
        toast.error('Failed to send message')
        setIsSending(false)
      }
    },
    [
      isStreaming,
      sessionId,
      sessionRecord,
      worktreePath,
      worktreeId,
      connectionId,
      opencodeSessionId,
      attachments,
      allSlashCommands,
      sessionCapabilities,
      revertMessageID,
      skipPlanModePrefix,
      codexPromptOptions,
      refreshMessagesFromOpenCode,
      getModelForRequests,
      fileMentions,
      resetAutoScrollState,
      stripAtMentions
    ]
  )

  const handlePlanReadyImplement = useCallback(async () => {
    if (pendingPlan && !isClaudeCode) {
      const pendingBeforeAction = pendingPlan
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

      // Transition ExitPlanMode tool card to "accepted" state
      if (pendingBeforeAction.toolUseID) {
        updateStreamingPartsRef((parts) =>
          parts.map((p) =>
            p.type === 'tool_use' && p.toolUse?.id === pendingBeforeAction.toolUseID
              ? { ...p, toolUse: { ...p.toolUse!, status: 'success' as const } }
              : p
          )
        )
        immediateFlush()
      }

      await useSessionStore.getState().setSessionMode(sessionId, 'build')
      lastSendMode.set(sessionId, 'build')
      notifyKanbanSessionSync(sessionId, { type: 'implement' })
      await handleSend(
        buildSdkPlanImplementationPrompt(sessionRecord?.agent_sdk, pendingBeforeAction.planContent)
      )
      return
    }

    // Claude Code sessions must resolve a real pending ExitPlanMode request.
    if (isClaudeCode) {
      if (!worktreePath || !pendingPlan) {
        toast.error('No pending plan approval found')
        return
      }

      const pendingBeforeAction = pendingPlan
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

      try {
        // Approve first (unblocks the SDK), then update frontend state.
        const result = await window.opencodeOps.planApprove(
          worktreePath,
          sessionId,
          pendingBeforeAction.requestId
        )
        if (!result.success) {
          toast.error(`Plan approve failed: ${result.error ?? 'unknown'}`)
          // Avoid stale FAB loops if backend no longer has a pending request.
          if (!(result.error ?? '').toLowerCase().includes('no pending plan')) {
            useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
            useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
          }
          return
        }
        await useSessionStore.getState().setSessionMode(sessionId, 'build')
        lastSendMode.set(sessionId, 'build')
        notifyKanbanSessionSync(sessionId, { type: 'implement' })

        // The SDK resumes within the same prompt cycle after plan approval —
        // it won't emit a new session.status:busy event. Set status explicitly.
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
        setIsStreaming(true)
        setIsSending(true)
        userExplicitSendTimes.set(sessionId, Date.now())
        snapshotTokenBaseline(sessionId)

        // Transition the ExitPlanMode tool card to "accepted" state
        updateStreamingPartsRef((parts) =>
          parts.map((p) =>
            p.type === 'tool_use' && p.toolUse?.id === pendingBeforeAction.toolUseID
              ? { ...p, toolUse: { ...p.toolUse!, status: 'success' as const } }
              : p
          )
        )
        immediateFlush()
      } catch (err) {
        toast.error(`Plan approve error: ${err instanceof Error ? err.message : String(err)}`)
        useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
      }
      return
    }

    // OpenCode sessions: legacy non-blocking behavior.
    await useSessionStore.getState().setSessionMode(sessionId, 'build')
    lastSendMode.set(sessionId, 'build')
    notifyKanbanSessionSync(sessionId, { type: 'implement' })
    await handleSend('Implement')
  }, [
    sessionId,
    handleSend,
    worktreePath,
    pendingPlan,
    isClaudeCode,
    sessionRecord?.agent_sdk,
    updateStreamingPartsRef,
    immediateFlush
  ])

  const handlePlanReject = useCallback(
    async (feedback: string) => {
      if (!pendingPlan) return

      if (!isClaudeCode) {
        const pendingBeforeAction = pendingPlan
        useSessionStore.getState().clearPendingPlan(sessionId)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

        // Transition ExitPlanMode tool card to "rejected" state
        if (pendingBeforeAction?.toolUseID) {
          updateStreamingPartsRef((parts) =>
            parts.map((p) =>
              p.type === 'tool_use' && p.toolUse?.id === pendingBeforeAction.toolUseID
                ? { ...p, toolUse: { ...p.toolUse!, status: 'error' as const, error: feedback } }
                : p
            )
          )
          immediateFlush()
        }

        await useSessionStore.getState().setSessionMode(sessionId, 'plan')
        lastSendMode.set(sessionId, 'plan')
        await handleSend(feedback)
        return
      }

      if (!worktreePath) return
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      const pendingBeforeAction = pendingPlan
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      try {
        // Reject first (unblocks the SDK with feedback), then clear frontend state
        const result = await window.opencodeOps.planReject(
          worktreePath,
          sessionId,
          feedback,
          pendingBeforeAction.requestId
        )
        if (!result.success) {
          toast.error(`Plan reject failed: ${result.error ?? 'unknown'}`)
          if (!(result.error ?? '').toLowerCase().includes('no pending plan')) {
            useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
            useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
          }
          return
        }

        // Transition the ExitPlanMode tool card to "rejected" state with feedback
        updateStreamingPartsRef((parts) =>
          parts.map((p) =>
            p.type === 'tool_use' && p.toolUse?.id === pendingBeforeAction.toolUseID
              ? { ...p, toolUse: { ...p.toolUse!, status: 'error' as const, error: feedback } }
              : p
          )
        )
        immediateFlush()

        // The SDK resumes within the same prompt cycle after rejection —
        // it won't emit a new session.status:busy event. Restore status explicitly.
        const currentMode = useSessionStore.getState().getSessionMode(sessionId)
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
      } catch (err) {
        toast.error(`Plan reject error: ${err instanceof Error ? err.message : String(err)}`)
        useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
      }
    },
    [
      sessionId,
      worktreePath,
      pendingPlan,
      isClaudeCode,
      updateStreamingPartsRef,
      immediateFlush,
      handleSend
    ]
  )

  const handlePlanReadyHandoff = useCallback(async () => {
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim().length > 0)

    if (!lastAssistantMessage) {
      toast.error('No assistant plan message to hand off')
      return
    }

    useSessionStore.getState().clearPendingPlan(sessionId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
    lastSendMode.delete(sessionId)

    // Abort the original backend session so it stops spinning
    if (worktreePath && opencodeSessionId) {
      useCommandApprovalStore.getState().clearSession(sessionId)
      await window.opencodeOps.abort(worktreePath, opencodeSessionId)
    }

    if (connectionId) {
      const handoffPrompt = `Implement the following plan\n${lastAssistantMessage.content}`
      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createConnectionSession(connectionId)
      if (!result.success || !result.session) {
        toast.error(result.error ?? 'Failed to create handoff session')
        return
      }
      const setModePromise = sessionStore.setSessionMode(result.session.id, 'build')
      sessionStore.setPendingMessage(result.session.id, handoffPrompt)
      notifyKanbanSessionSync(sessionId, { type: 'supercharge', newSessionId: result.session.id })
      sessionStore.setActiveConnectionSession(result.session.id)
      await setModePromise
      return
    }

    const currentWorktreeId = worktreeId
    const currentProjectId = sessionRecord?.project_id
    if (!currentWorktreeId || !currentProjectId) {
      toast.error('Could not start handoff session')
      return
    }

    const handoffPrompt = `Implement the following plan\n${lastAssistantMessage.content}`

    const sessionStore = useSessionStore.getState()
    const result = await sessionStore.createSession(currentWorktreeId, currentProjectId)
    if (!result.success || !result.session) {
      toast.error(result.error ?? 'Failed to create handoff session')
      return
    }

    const setModePromise = sessionStore.setSessionMode(result.session.id, 'build')
    sessionStore.setPendingMessage(result.session.id, handoffPrompt)
    notifyKanbanSessionSync(sessionId, { type: 'supercharge', newSessionId: result.session.id })
    sessionStore.setActiveSession(result.session.id)
    await setModePromise
  }, [messages, worktreeId, sessionRecord?.project_id, connectionId, sessionId, worktreePath, opencodeSessionId])

  const handlePlanReadySuperpowers = useCallback(async () => {
    // 1. Extract plan content
    const planContent =
      pendingPlan?.planContent ??
      [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim().length > 0)
        ?.content
    if (!planContent) {
      toast.error('No plan content found to supercharge')
      return
    }

    useSessionStore.getState().clearPendingPlan(sessionId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
    lastSendMode.delete(sessionId)

    // Abort the original backend session so it stops spinning
    if (worktreePath && opencodeSessionId) {
      useCommandApprovalStore.getState().clearSession(sessionId)
      await window.opencodeOps.abort(worktreePath, opencodeSessionId)
    }

    if (connectionId) {
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createConnectionSession(connectionId)
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create supercharge session')
        return
      }
      const newSessionId = sessionResult.session.id
      const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')
      sessionStore.setPendingMessage(newSessionId, '/using-superpowers')
      sessionStore.setPendingFollowUpMessages(newSessionId, [
        'use the subagent development skill to implement the following plan:\n' + planContent
      ])
      // Notify kanban store: supercharge re-attaches ticket to new session
      notifyKanbanSessionSync(sessionId, {
        type: 'supercharge',
        newSessionId
      })
      sessionStore.setActiveConnectionSession(newSessionId)
      await setModePromise
      return
    }

    // 2. Look up worktree and project metadata
    const worktreeStore = useWorktreeStore.getState()
    let worktree: Worktree | undefined
    for (const worktrees of worktreeStore.worktreesByProject.values()) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) break
    }
    if (!worktree) {
      toast.error('Could not find current worktree')
      return
    }

    const project = useProjectStore.getState().projects.find((p) => p.id === worktree!.project_id)
    if (!project) {
      toast.error('Could not find project for worktree')
      return
    }

    // 3. Duplicate worktree
    const dupResult = await worktreeStore.duplicateWorktree(
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

    // 4. Create session in the new worktree
    const sessionStore = useSessionStore.getState()
    const sessionResult = await sessionStore.createSession(dupResult.worktree.id, project.id)
    if (!sessionResult.success || !sessionResult.session) {
      toast.error(sessionResult.error ?? 'Failed to create supercharge session')
      return
    }

    // 5. Configure 2-step flow
    const newSessionId = sessionResult.session.id
    const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')
    sessionStore.setPendingMessage(newSessionId, '/using-superpowers')
    sessionStore.setPendingFollowUpMessages(newSessionId, [
      'use the subagent development skill to implement the following plan:\n' + planContent
    ])

    // 5b. Notify kanban store: supercharge re-attaches ticket to new session
    notifyKanbanSessionSync(sessionId, {
      type: 'supercharge',
      newSessionId
    })

    // 6. Navigate to the new worktree
    worktreeStore.selectWorktree(dupResult.worktree.id)
    await setModePromise
  }, [messages, worktreeId, pendingPlan, connectionId, sessionId, worktreePath, opencodeSessionId])

  const handlePlanReadySuperpowersLocal = useCallback(async () => {
    // 1. Extract plan content
    const planContent =
      pendingPlan?.planContent ??
      [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim().length > 0)
        ?.content
    if (!planContent) {
      toast.error('No plan content found to supercharge')
      return
    }

    useSessionStore.getState().clearPendingPlan(sessionId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
    lastSendMode.delete(sessionId)

    // Abort the original backend session so it stops spinning
    if (worktreePath && opencodeSessionId) {
      useCommandApprovalStore.getState().clearSession(sessionId)
      await window.opencodeOps.abort(worktreePath, opencodeSessionId)
    }

    // 2. Create session in the same worktree (no duplication)
    const currentWorktreeId = worktreeId
    const currentProjectId = sessionRecord?.project_id
    if (!currentWorktreeId || !currentProjectId) {
      toast.error('Could not start local supercharge session')
      return
    }

    const sessionStore = useSessionStore.getState()
    const sessionResult = await sessionStore.createSession(currentWorktreeId, currentProjectId)
    if (!sessionResult.success || !sessionResult.session) {
      toast.error(sessionResult.error ?? 'Failed to create local supercharge session')
      return
    }

    // 3. Configure 2-step flow
    const newSessionId = sessionResult.session.id
    const setModePromise = sessionStore.setSessionMode(newSessionId, 'build')
    sessionStore.setPendingMessage(newSessionId, '/using-superpowers')
    sessionStore.setPendingFollowUpMessages(newSessionId, [
      'use the subagent development skill to implement the following plan:\n' + planContent
    ])

    // 3b. Notify kanban store: supercharge re-attaches ticket to new session
    notifyKanbanSessionSync(sessionId, {
      type: 'supercharge',
      newSessionId
    })

    // 4. Navigate to the new session (same worktree)
    sessionStore.setActiveSession(newSessionId)
    await setModePromise
  }, [messages, worktreeId, sessionRecord?.project_id, pendingPlan, sessionId, worktreePath, opencodeSessionId])

  const handlePlanReadySaveAsTicket = useCallback(async () => {
    const projectId = sessionRecord?.project_id
    if (!projectId) {
      toast.error('No project associated with this session')
      return
    }

    const planContent =
      pendingPlan?.planContent ??
      [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim().length > 0)
        ?.content

    if (!planContent) {
      toast.error('No plan content found')
      return
    }

    // Extract title from first markdown heading, or fall back to first non-empty line
    const headingMatch = planContent.match(/^#+\s+(.+)$/m)
    const title = headingMatch
      ? headingMatch[1].trim()
      : (planContent
          .split('\n')
          .find((line: string) => line.trim().length > 0)
          ?.trim()
          .slice(0, 100) ?? 'Plan ticket')

    try {
      await useKanbanStore.getState().createTicket(projectId, {
        project_id: projectId,
        title,
        description: planContent,
        column: 'todo'
      })
      setPlanSavedAsTicket(true)
      toast.success('Saved as ticket')
    } catch {
      toast.error('Failed to save as ticket')
    }
  }, [messages, pendingPlan, sessionRecord?.project_id])

  // Abort streaming
  const handleAbort = useCallback(async () => {
    if (!worktreePath || !opencodeSessionId) return
    // Clear any pending command approvals — the abort will auto-deny them on the main process side
    useCommandApprovalStore.getState().clearSession(sessionId)
    await window.opencodeOps.abort(worktreePath, opencodeSessionId)
  }, [worktreePath, opencodeSessionId, sessionId])

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When file mention popover is open, let the popover's capture-phase
      // listener handle ArrowUp/ArrowDown/Enter/Escape. Do NOT process them here.
      if (fileMentions.isOpen) {
        if (
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'Enter' ||
          e.key === 'Escape'
        ) {
          return
        }
      }

      if (
        e.key === 'Enter' &&
        isComposingKeyboardEvent(
          e.nativeEvent as KeyboardEvent & { keyCode?: number },
          isImeComposingRef.current
        )
      ) {
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        // When a plan is pending, sending text rejects the plan with feedback
        const plan = useSessionStore.getState().pendingPlans.get(sessionId)
        if (plan && inputValue.trim()) {
          void handlePlanReject(inputValue.trim())
          setInputValue('')
          inputValueRef.current = ''
          if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
          window.db.session.updateDraft(sessionId, null)
          return
        }
        handleSend()
        return
      }

      // Prompt history navigation with Up/Down arrows
      if (e.key === 'ArrowUp') {
        const textarea = e.currentTarget
        // Only activate at cursor position 0 (very beginning)
        if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) return

        const hKey = historyKey
        if (!hKey) return
        const history = usePromptHistoryStore.getState().getHistory(hKey)
        if (history.length === 0) return

        e.preventDefault()

        if (historyIndex === null) {
          // Entering navigation: save current draft, go to most recent
          savedDraftRef.current = inputValue
          const newIndex = history.length - 1
          setHistoryIndex(newIndex)
          setInputValue(history[newIndex])
          inputValueRef.current = history[newIndex]
        } else if (historyIndex > 0) {
          // Navigate backward
          const newIndex = historyIndex - 1
          setHistoryIndex(newIndex)
          setInputValue(history[newIndex])
          inputValueRef.current = history[newIndex]
        }
        // Place cursor at start so next Up arrow fires immediately
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(0, 0)
        })
        // If historyIndex === 0, at oldest — do nothing
        return
      }

      if (e.key === 'ArrowDown') {
        const textarea = e.currentTarget
        // Only activate at cursor end (very end of text)
        if (
          textarea.selectionStart !== textarea.value.length ||
          textarea.selectionEnd !== textarea.value.length
        ) {
          return
        }

        if (historyIndex === null) return // Not navigating

        const hKey = historyKey
        if (!hKey) return
        const history = usePromptHistoryStore.getState().getHistory(hKey)

        e.preventDefault()

        let newValue: string
        if (historyIndex < history.length - 1) {
          // Navigate forward
          const newIndex = historyIndex + 1
          setHistoryIndex(newIndex)
          newValue = history[newIndex]
        } else {
          // At newest entry — exit navigation, restore draft
          setHistoryIndex(null)
          newValue = savedDraftRef.current
          savedDraftRef.current = ''
        }
        setInputValue(newValue)
        inputValueRef.current = newValue
        // Place cursor at end so next Down arrow fires immediately
        requestAnimationFrame(() => {
          const len = textareaRef.current?.value.length ?? 0
          textareaRef.current?.setSelectionRange(len, len)
        })
      }
    },
    [
      handleSend,
      handlePlanReject,
      sessionId,
      historyKey,
      historyIndex,
      inputValue,
      fileMentions.isOpen
    ]
  )

  // Attachment handlers
  const handleAttach = useCallback((file: Omit<Attachment, 'id'>) => {
    setAttachments((prev) => [...prev, { id: crypto.randomUUID(), ...file }])
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleTicketPickerSelect = useCallback(
    (tickets: TicketAttachmentData[]) => {
      setAttachments((prev) => {
        const remaining = MAX_ATTACHMENTS - prev.length
        if (remaining <= 0) {
          toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
          return prev
        }
        const toAdd = tickets.slice(0, remaining).map((t) => ({
          kind: 'ticket' as const,
          id: crypto.randomUUID(),
          name: t.title,
          ticketId: t.ticketId,
          title: t.title,
          description: t.description,
          attachments: t.attachments
        }))
        if (tickets.length > remaining) {
          toast.warning(
            `Only ${remaining} of ${tickets.length} tickets attached (${MAX_ATTACHMENTS} max)`
          )
        }
        return [...prev, ...toAdd]
      })
    },
    []
  )

  // Slash command handlers
  const handleInputChange = useCallback(
    (value: string, newCursorPos?: number) => {
      const oldValue = inputValueRef.current
      setInputValue(value)
      inputValueRef.current = value

      // Update mention indices for the text change (skip if pasting to avoid
      // opening the popover for pasted '@' characters)
      if (!isPastingRef.current) {
        fileMentions.updateMentions(oldValue, value)
      }
      isPastingRef.current = false

      // Track cursor position
      if (newCursorPos !== undefined) {
        cursorPositionRef.current = newCursorPos
        setCursorPosition(newCursorPos)
      }

      // Exit history navigation on manual typing
      if (historyIndex !== null) {
        setHistoryIndex(null)
      }

      if (value.startsWith('/') && !value.includes(' ')) {
        setShowSlashCommands(true)
      } else {
        setShowSlashCommands(false)
      }

      // Debounce draft persistence (3 seconds)
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      draftTimerRef.current = setTimeout(() => {
        window.db.session.updateDraft(sessionId, value || null)
      }, 3000)
    },
    [sessionId, historyIndex, fileMentions]
  )

  const handleCommandSelect = useCallback((cmd: { name: string; template: string }) => {
    setInputValue(`/${cmd.name} `)
    setShowSlashCommands(false)
    textareaRef.current?.focus()
  }, [])

  // File mention selection handler
  const handleFileMentionSelect = useCallback(
    (file: { name: string; path: string; relativePath: string; extension: string | null }) => {
      const result = fileMentions.selectFile(file)
      setInputValue(result.newValue)
      inputValueRef.current = result.newValue
      cursorPositionRef.current = result.newCursorPosition
      setCursorPosition(result.newCursorPosition)

      // Set cursor position on the textarea
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(result.newCursorPosition, result.newCursorPosition)
          textareaRef.current.focus()
        }
      })
    },
    [fileMentions]
  )

  const handleSlashClose = useCallback(() => {
    setShowSlashCommands(false)
  }, [])

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // Flag paste so handleInputChange skips opening the file mention popover
      // for any '@' characters introduced by paste
      isPastingRef.current = true

      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (!file) continue
          const reader = new FileReader()
          reader.onload = () => {
            handleAttach({
              kind: 'data',
              name: file.name || 'pasted-image.png',
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.readAsDataURL(file)
        }
      }
    },
    [handleAttach]
  )

  // Global Tab key handler — toggles Build/Plan mode, blocks tab character insertion
  const toggleSessionMode = useSessionStore((state) => state.toggleSessionMode)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Don't intercept Tab inside the ticket creation modal — it needs
        // natural tab navigation between title / description fields.
        const createModal = document.querySelector('[data-testid="ticket-create-modal"]')
        if (createModal?.contains(document.activeElement)) return

        // Don't intercept Tab when the xterm terminal is focused — it needs
        // to reach the shell for tab completion.
        const terminalContainer = document.querySelector('[data-testid="terminal-view-container"]')
        if (terminalContainer?.contains(document.activeElement)) return

        e.preventDefault()
        e.stopPropagation()
        toggleSessionMode(sessionId)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
    }
  }, [sessionId, toggleSessionMode])

  // Listen for undo/redo turn events from the application menu
  useEffect(() => {
    const handleUndo = async (): Promise<void> => {
      if (useSessionStore.getState().activeSessionId !== sessionId) return
      if (!worktreePath || !opencodeSessionId) return
      try {
        const result = await window.opencodeOps.undo(worktreePath, opencodeSessionId)
        if (!result.success) {
          toast.error(result.error || 'Nothing to undo')
          return
        }
        setRevertMessageID(result.revertMessageID ?? null)
        revertDiffRef.current = result.revertDiff ?? null
        const restoredPrompt =
          typeof result.restoredPrompt === 'string'
            ? stripPlanModePrefix(result.restoredPrompt)
            : ''
        setInputValue(restoredPrompt)
        inputValueRef.current = restoredPrompt
        await refreshMessagesFromOpenCode()
      } catch {
        toast.error('Undo failed')
      }
    }

    const handleRedo = async (): Promise<void> => {
      if (useSessionStore.getState().activeSessionId !== sessionId) return
      if (!worktreePath || !opencodeSessionId) return
      if (sessionCapabilitiesRef.current && !sessionCapabilitiesRef.current.supportsRedo) {
        toast.error('Redo is not supported for this session type')
        return
      }
      try {
        const result = await window.opencodeOps.redo(worktreePath, opencodeSessionId)
        if (!result.success) {
          toast.error(result.error || 'Nothing to redo')
          return
        }
        setRevertMessageID(result.revertMessageID ?? null)
        if (result.revertMessageID === null) {
          revertDiffRef.current = null
          setInputValue('')
          inputValueRef.current = ''
        }
        await refreshMessagesFromOpenCode()
      } catch {
        toast.error('Redo failed')
      }
    }

    const onUndo = (): void => {
      handleUndo()
    }
    const onRedo = (): void => {
      handleRedo()
    }

    window.addEventListener('hive:undo-turn', onUndo)
    window.addEventListener('hive:redo-turn', onRedo)
    return () => {
      window.removeEventListener('hive:undo-turn', onUndo)
      window.removeEventListener('hive:redo-turn', onRedo)
    }
  }, [sessionId, worktreePath, opencodeSessionId, refreshMessagesFromOpenCode])

  // Determine if there's streaming content to show
  const visibleMessages = useMemo(() => {
    if (!revertMessageID) return messages

    // IDs are not guaranteed to be lexicographically ordered across providers.
    // Use the message array order (already time-sorted) and trim by index.
    const boundaryIndex = messages.findIndex((message) => message.id === revertMessageID)
    if (boundaryIndex === -1) return messages

    return messages.filter(
      (message, index) => message.id.startsWith('local-') || index < boundaryIndex
    )
  }, [messages, revertMessageID])

  const revertedUserCount = useMemo(() => {
    if (!revertMessageID) return 0

    const boundaryIndex = messages.findIndex((message) => message.id === revertMessageID)
    if (boundaryIndex === -1) return 0

    return messages.filter(
      (message, index) =>
        message.role === 'user' && !message.id.startsWith('local-') && index >= boundaryIndex
    ).length
  }, [messages, revertMessageID])

  // Revert boundaries can become stale when transcript compacts or provider IDs change.
  // If boundary message no longer exists, clear the boundary instead of hiding content.
  useEffect(() => {
    if (!revertMessageID) return
    if (messages.length === 0) return
    const boundaryExists = messages.some((message) => message.id === revertMessageID)
    if (!boundaryExists) {
      setRevertMessageID(null)
    }
  }, [messages, revertMessageID])

  useEffect(() => {
    if (sessionRecord?.agent_sdk === 'codex') return
    if (messages.length === 0) return
    // Defense-in-depth: don't overwrite the cache with a degraded state.
    // If the only messages are local-* (optimistic user messages not yet
    // confirmed by the server), the transcript hasn't been loaded yet.
    // Overwriting now would destroy the good cache that loadMessages()
    // uses as a fallback when the backend returns empty.
    const hasServerMessages = messages.some((m) => !m.id.startsWith('local-'))
    if (!hasServerMessages) return
    writeTranscriptCache(sessionId, messages)
  }, [sessionId, messages, sessionRecord?.agent_sdk])

  // Determine if there's streaming content to show
  const hasStreamingContent =
    sessionRecord?.agent_sdk === 'codex'
      ? false
      : streamingParts.length > 0 || streamingContent.length > 0

  const streamingStartTimeRef = useRef<string>('')
  const streamingMessage = useMemo(() => {
    if (sessionRecord?.agent_sdk === 'codex') {
      streamingStartTimeRef.current = ''
      return null
    }
    if (!hasStreamingContent) {
      streamingStartTimeRef.current = ''
      return null
    }
    if (!streamingStartTimeRef.current) {
      streamingStartTimeRef.current = new Date().toISOString()
    }
    return {
      id: 'streaming' as const,
      role: 'assistant' as const,
      content: streamingContent,
      timestamp: streamingStartTimeRef.current,
      parts: streamingParts
    }
  }, [hasStreamingContent, sessionRecord?.agent_sdk, streamingContent, streamingParts])

  const handleRedoRevert = useCallback(() => {
    setInputValue('/redo')
    inputValueRef.current = '/redo'
    textareaRef.current?.focus()
  }, [])

  // The StreamingCursor (blinking cursor) only renders after text or tool_use parts.
  // Parts like reasoning, step_start, step_finish, compaction don't show it.
  // When those are the only parts, we still need the 3-dot loading indicator.
  const codexHasWritingCursor = useMemo(() => {
    if (sessionRecord?.agent_sdk !== 'codex' || !isStreaming) return false
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === 'assistant') {
        const msg = visibleMessages[i]
        const lastPart = msg.parts?.[msg.parts.length - 1]
        if (lastPart?.type === 'tool_use') return true
        return Boolean(msg.content.trim())
      }
    }
    return false
  }, [visibleMessages, isStreaming, sessionRecord?.agent_sdk])

  const hasVisibleWritingCursor =
    sessionRecord?.agent_sdk === 'codex'
      ? codexHasWritingCursor
      : hasStreamingContent &&
        isStreaming &&
        (streamingContent.length > 0 ||
          (streamingParts.length > 0 &&
            (streamingParts[streamingParts.length - 1].type === 'text' ||
              streamingParts[streamingParts.length - 1].type === 'tool_use')))

  const codexPlanCandidate = useMemo(() => {
    const pendingPlanText = pendingPlan?.planContent?.trim()
    if (pendingPlanText) return pendingPlanText

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'assistant') continue

      for (let j = (message.parts?.length ?? 0) - 1; j >= 0; j--) {
        const part = message.parts?.[j]
        const toolPlan =
          part?.type === 'tool_use' && part.toolUse?.name === 'ExitPlanMode'
            ? String(part.toolUse.input?.plan ?? '').trim()
            : ''
        if (toolPlan) return toolPlan
      }

      const messageText = message.content.trim()
      if (messageText) return messageText
    }

    for (let i = streamingParts.length - 1; i >= 0; i--) {
      const part = streamingParts[i]
      const toolPlan =
        part.type === 'tool_use' && part.toolUse?.name === 'ExitPlanMode'
          ? String(part.toolUse.input?.plan ?? '').trim()
          : ''
      if (toolPlan) return toolPlan
      if (part.type === 'text' && part.text?.trim()) return part.text.trim()
    }

    return ''
  }, [messages, pendingPlan, streamingParts])

  const hasCodexProposedPlan =
    sessionRecord?.agent_sdk === 'codex' && looksLikeCodexProposedPlan(codexPlanCandidate)

  // Show the floating Implement FAB when:
  // 1. Claude Code sessions: ExitPlanMode is pending approval.
  // 2. Codex sessions: the pending plan content is a real <proposed_plan>.
  // 3. OpenCode sessions: legacy non-blocking plan mode completed.
  const showPlanReadyImplementFab = isClaudeCode
    ? !!pendingPlan
    : sessionRecord?.agent_sdk === 'codex'
      ? !!pendingPlan && hasCodexProposedPlan
      : lastSendMode.get(sessionId) === 'plan' && !isSending && !isStreaming && !pendingPlan

  // Reset "saved as ticket" flag when the plan changes (new plan → fresh button)
  const pendingPlanRef = useRef(pendingPlan)
  if (pendingPlanRef.current !== pendingPlan) {
    pendingPlanRef.current = pendingPlan
    if (planSavedAsTicket) setPlanSavedAsTicket(false)
  }

  const retrySecondsRemaining = useMemo(() => {
    if (!sessionRetry?.next) return null
    return Math.max(0, Math.ceil((sessionRetry.next - retryTickMs) / 1000))
  }, [sessionRetry, retryTickMs])

  useEffect(() => {
    if (!sessionRetry?.next) return

    setRetryTickMs(Date.now())
    const timer = window.setInterval(() => {
      setRetryTickMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [sessionRetry?.next])

  const isActive = isStreaming || isSending
  const elapsedTimerText = useSessionTimer(sessionId, isActive)

  // Render based on view state
  if (viewState.status === 'connecting') {
    return (
      <div className="flex-1 flex flex-col" data-testid="session-view" data-session-id={sessionId}>
        <LoadingState />
      </div>
    )
  }

  if (viewState.status === 'error') {
    return (
      <div className="flex-1 flex flex-col" data-testid="session-view" data-session-id={sessionId}>
        <ErrorState
          message={viewState.errorMessage || 'Failed to connect to session'}
          onRetry={handleRetry}
        />
      </div>
    )
  }

  return (
    <div
      className="flex-1 flex flex-col min-h-0"
      data-testid="session-view"
      data-session-id={sessionId}
    >
      {/* Message list with scroll tracking */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerCallbackRef}
          className="h-full overflow-y-auto"
          onScroll={handleScroll}
          onWheel={handleScrollWheel}
          onPointerDown={handleScrollPointerDown}
          onPointerUp={handleScrollPointerUp}
          onPointerCancel={handleScrollPointerCancel}
          data-testid="message-list"
        >
          {/* Read-only banner for orphaned sessions */}
          {isOrphanedSession && (
            <div
              className="mx-6 mt-4 mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3"
              data-testid="readonly-banner"
            >
              <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
                <Archive className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Read-Only Mode</p>
                  <p className="mt-0.5 text-sm opacity-90">
                    {sessionRecord?.connection_id
                      ? 'This session is from a deleted connection. You can view the conversation history but cannot send new messages.'
                      : sessionRecord?.worktree_id
                        ? 'This session is from an archived worktree. You can view the conversation history but cannot send new messages.'
                        : 'This session is no longer accessible. You can view the conversation history but cannot send new messages.'}
                  </p>
                </div>
              </div>
            </div>
          )}
          {visibleMessages.length === 0 && !hasStreamingContent ? (
            <div className="flex-1 flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <p className="text-lg font-medium">Start a conversation</p>
                <p className="text-sm mt-1">Type a message below to begin</p>
                {!opencodeSessionId && worktreePath && (
                  <p className="text-xs mt-2 text-yellow-500">Connecting to OpenCode...</p>
                )}
                {!worktreePath && (
                  <p className="text-xs mt-2 text-yellow-500">No worktree selected</p>
                )}
              </div>
            </div>
          ) : (
            <VirtualizedMessageList
              ref={virtualizedListRef}
              messages={visibleMessages}
              streamingMessage={streamingMessage}
              isStreaming={isStreaming}
              isSending={isSending}
              isCompacting={isCompacting}
              cwd={worktreePath}
              onForkAssistantMessage={handleForkFromAssistantMessage}
              forkingMessageId={forkingMessageId}
              revertMessageID={revertMessageID}
              revertedUserCount={revertedUserCount}
              onRedoRevert={handleRedoRevert}
              sessionErrorMessage={sessionErrorMessage}
              sessionErrorStderr={sessionErrorStderr}
              sessionRetry={sessionRetry}
              retrySecondsRemaining={retrySecondsRemaining}
              hasVisibleWritingCursor={hasVisibleWritingCursor}
              queuedMessages={queuedMessages}
              completionEntry={completionEntry}
              scrollElement={scrollElement}
            />
          )}
        </div>
        <PlanReadyImplementFab
          onImplement={handlePlanReadyImplement}
          onHandoff={handlePlanReadyHandoff}
          visible={showPlanReadyImplementFab}
          superpowersAvailable={hasSuperpowers}
          onSuperpowers={handlePlanReadySuperpowers}
          onSuperpowersLocal={handlePlanReadySuperpowersLocal}
          isConnectionSession={!!connectionId}
          onSaveAsTicket={sessionRecord?.project_id && !planSavedAsTicket ? handlePlanReadySaveAsTicket : undefined}
        />
        {/* Scroll-to-bottom FAB */}
        <ScrollToBottomFab
          onClick={handleScrollToBottomClick}
          visible={showScrollFab}
          bottomClass={showPlanReadyImplementFab ? 'bottom-16' : 'bottom-4'}
        />
      </div>

      {/* Permission prompt from AI */}
      {activePermission && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto">
            <PermissionPrompt
              key={activePermission.id}
              request={activePermission}
              onReply={handlePermissionReply}
            />
          </div>
        </div>
      )}

      {/* Command approval prompt from AI (command filter system) */}
      {activeCommandApproval && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto">
            <CommandApprovalPrompt
              key={activeCommandApproval.id}
              request={activeCommandApproval}
              sessionId={sessionId}
              onReply={handleCommandApprovalReply}
            />
          </div>
        </div>
      )}

      {/* Question prompt from AI */}
      {activeQuestion && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto">
            <QuestionPrompt
              key={activeQuestion.id}
              request={activeQuestion}
              onReply={handleQuestionReply}
              onReject={handleQuestionReject}
            />
          </div>
        </div>
      )}

      {/* Input area */}
      <div
        className="p-4 bg-background"
        data-testid="input-area"
        role="form"
        aria-label="Message input"
      >
        <div className="max-w-4xl mx-auto relative">
          {/* Slash command popover — outside overflow-hidden so it can render above */}
          <SlashCommandPopover
            commands={allSlashCommands}
            filter={inputValue}
            onSelect={handleCommandSelect}
            onClose={handleSlashClose}
            visible={showSlashCommands}
          />
          {/* File mention popover — only when slash commands are not showing */}
          <FileMentionPopover
            suggestions={fileMentions.suggestions}
            selectedIndex={fileMentions.selectedIndex}
            visible={fileMentions.isOpen && !showSlashCommands}
            onSelect={handleFileMentionSelect}
            onClose={fileMentions.dismiss}
            onNavigate={fileMentions.moveSelection}
          />
          {/* PR review comment attachments — above the input container */}
          <PrCommentAttachments />
          {/* Ticket attachments — above the input container */}
          <TicketAttachments attachments={attachments} onRemove={handleRemoveAttachment} />
          <div
            className={cn(
              'rounded-xl border-2 transition-colors duration-200 overflow-hidden',
              mode === 'build'
                ? 'border-blue-500/50 bg-blue-500/5'
                : mode === 'super-plan'
                  ? 'border-orange-500/50 bg-orange-500/5'
                  : 'border-violet-500/50 bg-violet-500/5'
            )}
          >
            {/* Top row: mode toggle */}
            <div className="px-3 pt-2.5 pb-1 flex items-center gap-1.5">
              <ModeToggle sessionId={sessionId} />
              <SuperToggle sessionId={sessionId} />
            </div>

            {/* Attachment previews */}
            <AttachmentPreview attachments={attachments} onRemove={handleRemoveAttachment} />

            {/* Middle: textarea */}
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => {
                const pos = e.currentTarget.selectionStart ?? 0
                handleInputChange(e.target.value, pos)
              }}
              onKeyUp={(e) => {
                const pos = e.currentTarget.selectionStart ?? 0
                cursorPositionRef.current = pos
                setCursorPosition(pos)
              }}
              onClick={(e) => {
                const pos = e.currentTarget.selectionStart ?? 0
                cursorPositionRef.current = pos
                setCursorPosition(pos)
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isImeComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isImeComposingRef.current = false
              }}
              onPaste={handlePaste}
              disabled={!!activePermission || isOrphanedSession}
              placeholder={
                isOrphanedSession
                  ? 'Read-only mode - cannot send messages'
                  : activePermission
                    ? 'Waiting for permission response...'
                    : pendingPlan
                      ? 'Send feedback to revise the plan...'
                      : 'Type your message...'
              }
              aria-label="Message input"
              aria-haspopup="listbox"
              aria-expanded={fileMentions.isOpen && !showSlashCommands}
              className={cn(
                'w-full resize-none bg-transparent px-3 py-2',
                'text-sm placeholder:text-muted-foreground',
                'focus:outline-none border-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'min-h-[40px] max-h-[200px]'
              )}
              rows={1}
              data-testid="message-input"
            />

            {/* Bottom row: model selector + context indicator + hint text + send/implement buttons */}
            <div className="flex items-center justify-between px-3 pb-2.5 @container">
              <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                <ModelSelector sessionId={sessionId} />
                {sessionAgentSdk === 'codex' && (
                  <CodexFastToggle
                    enabled={codexFastMode}
                    accepted={codexFastModeAccepted}
                    onToggle={() => updateSetting('codexFastMode', !codexFastMode)}
                    onAccept={() => updateSetting('codexFastModeAccepted', true)}
                  />
                )}
                <AttachmentButton
                  onAttach={handleAttach}
                  projectId={sessionRecord?.project_id ?? null}
                  onPickTicket={() => setTicketPickerOpen(true)}
                  disabled={isOrphanedSession}
                />
                <ContextIndicator
                  sessionId={sessionId}
                  modelId={currentModelId}
                  providerId={currentProviderId}
                />
                <span
                  className={cn(
                    'text-xs tabular-nums whitespace-nowrap',
                    elapsedTimerText && isActive
                      ? activeQuestion
                        ? 'text-amber-500 font-semibold'
                        : mode === 'build'
                          ? 'text-blue-500 font-semibold'
                          : mode === 'super-plan'
                            ? 'text-orange-500 font-semibold'
                            : 'text-violet-500 font-semibold'
                      : 'text-muted-foreground'
                  )}
                >
                  {elapsedTimerText ??
                    (pendingPlan
                      ? 'Enter to send feedback to revise the plan'
                      : <span className="hidden @min-[42rem]:inline">{`${navigator.platform.includes('Mac') ? '⌃' : 'Ctrl+'}T to change variant, Shift+Enter for new line`}</span>)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {isStreaming && (
                  <IndeterminateProgressBar mode={mode} isAsking={!!activeQuestion} isCompacting={isCompacting} />
                )}
                {isStreaming && !inputValue.trim() ? (
                  <Button
                    onClick={handleAbort}
                    size="sm"
                    variant="destructive"
                    className="h-7 w-7 p-0"
                    aria-label="Stop streaming"
                    title="Stop streaming"
                    data-testid="stop-button"
                  >
                    <Square className="h-3 w-3" />
                  </Button>
                ) : (
                  <Button
                    onClick={() => {
                      // When a plan is pending and there's text, send as feedback (reject)
                      if (pendingPlan && inputValue.trim()) {
                        void handlePlanReject(inputValue.trim())
                        setInputValue('')
                        inputValueRef.current = ''
                        if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
                        window.db.session.updateDraft(sessionId, null)
                        return
                      }
                      void handleSend()
                    }}
                    disabled={!inputValue.trim() || !!activePermission || isOrphanedSession}
                    size="sm"
                    className="h-7 w-7 p-0"
                    aria-label={
                      pendingPlan && inputValue.trim()
                        ? 'Send feedback'
                        : isStreaming
                          ? 'Queue message'
                          : 'Send message'
                    }
                    title={
                      pendingPlan && inputValue.trim()
                        ? 'Send feedback to revise the plan'
                        : isStreaming
                          ? 'Queue message'
                          : 'Send message'
                    }
                    data-testid="send-button"
                  >
                    {isStreaming ? (
                      <ListPlus className="h-3.5 w-3.5" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Ticket picker modal for attaching board tickets */}
      {sessionRecord?.project_id && (
        <TicketPickerModal
          projectId={sessionRecord.project_id}
          open={ticketPickerOpen}
          onOpenChange={setTicketPickerOpen}
          onSelectTickets={handleTicketPickerSelect}
        />
      )}
    </div>
  )
}
