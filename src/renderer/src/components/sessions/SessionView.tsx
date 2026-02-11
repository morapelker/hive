import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, ListPlus, Loader2, AlertCircle, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { MessageRenderer } from './MessageRenderer'
import { ModeToggle } from './ModeToggle'
import { ModelSelector } from './ModelSelector'
import { QueuedMessageBubble } from './QueuedMessageBubble'
import { ContextIndicator } from './ContextIndicator'
import { AttachmentButton } from './AttachmentButton'
import { AttachmentPreview } from './AttachmentPreview'
import type { Attachment } from './AttachmentPreview'
import { SlashCommandPopover } from './SlashCommandPopover'
import { ScrollToBottomFab } from './ScrollToBottomFab'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useContextStore } from '@/stores/useContextStore'
import type { TokenInfo, SessionModelRef } from '@/stores/useContextStore'
import { extractTokens, extractCost, extractModelRef } from '@/lib/token-utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { usePromptHistoryStore } from '@/stores/usePromptHistoryStore'
import { mapOpencodeMessagesToSessionViewMessages } from '@/lib/opencode-transcript'
import { QuestionPrompt } from './QuestionPrompt'
import { PermissionPrompt } from './PermissionPrompt'
import type { ToolStatus, ToolUseInfo } from './ToolCard'

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

interface SessionViewProps {
  sessionId: string
}

// Session type from database
interface DbSession {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
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

function createLocalMessage(role: OpenCodeMessage['role'], content: string): OpenCodeMessage {
  return {
    id: `local-${crypto.randomUUID()}`,
    role,
    content,
    timestamp: new Date().toISOString()
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
  const [slashCommands, setSlashCommands] = useState<
    Array<{ name: string; description?: string; template: string; agent?: string }>
  >([])
  const [showSlashCommands, setShowSlashCommands] = useState(false)

  // Mode state for input border color
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId) || 'build')

  // OpenCode state
  const [worktreePath, setWorktreePath] = useState<string | null>(null)
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)

  // Prompt history navigation
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const savedDraftRef = useRef<string>('')

  // Current selected model used as fallback when session snapshot model is unknown
  const selectedModel = useSettingsStore((state) => state.selectedModel)
  const currentModelId = selectedModel?.modelID ?? 'claude-opus-4-5-20251101'
  const currentProviderId = selectedModel?.providerID ?? 'anthropic'

  // Active question prompt from AI
  const activeQuestion = useQuestionStore((s) => s.getActiveQuestion(sessionId))
  const activePermission = usePermissionStore((s) => s.getActivePermission(sessionId))

  // Streaming parts - tracks interleaved text and tool use during streaming
  const [streamingParts, setStreamingParts] = useState<StreamingPart[]>([])
  const streamingPartsRef = useRef<StreamingPart[]>([])

  // Legacy streaming content for backward compatibility
  const [streamingContent, setStreamingContent] = useState<string>('')
  const streamingContentRef = useRef<string>('')

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Smart auto-scroll tracking
  const isAutoScrollEnabledRef = useRef(true)
  const [showScrollFab, setShowScrollFab] = useState(false)
  const lastScrollTopRef = useRef(0)
  const scrollCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isScrollCooldownActiveRef = useRef(false)
  const userHasScrolledUpRef = useRef(false)

  // Streaming rAF ref (frame-synced flushing for text updates)
  const rafRef = useRef<number | null>(null)

  // Response logging refs
  const isLogModeRef = useRef<boolean>(false)
  const logFilePathRef = useRef<string | null>(null)

  // Child session → subtask index mapping for subagent content routing
  const childToSubtaskIndexRef = useRef<Map<string, number>>(new Map())

  // Draft persistence refs
  const inputValueRef = useRef('')
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Streaming dedup refs
  const finalizedMessageIdsRef = useRef<Set<string>>(new Set())
  const hasFinalizedCurrentResponseRef = useRef(false)

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

  // Auto-scroll to bottom when new messages arrive or streaming updates
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Smart auto-scroll: detect upward scroll and lock out auto-scroll with cooldown
  const SCROLL_COOLDOWN_MS = 2000

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const currentScrollTop = el.scrollTop
    const scrollingUp = currentScrollTop < lastScrollTopRef.current
    lastScrollTopRef.current = currentScrollTop

    const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight
    const isNearBottom = distanceFromBottom < 80

    // Upward scroll during streaming → mark as intentional, disable + start cooldown
    if (scrollingUp && (isSending || isStreaming)) {
      userHasScrolledUpRef.current = true
      isAutoScrollEnabledRef.current = false
      setShowScrollFab(true)
      isScrollCooldownActiveRef.current = true

      // Reset cooldown timer
      if (scrollCooldownRef.current !== null) {
        clearTimeout(scrollCooldownRef.current)
      }
      scrollCooldownRef.current = setTimeout(() => {
        scrollCooldownRef.current = null
        isScrollCooldownActiveRef.current = false
        // After cooldown, check if user has scrolled back to bottom
        const elNow = scrollContainerRef.current
        if (elNow) {
          const dist = elNow.scrollHeight - elNow.scrollTop - elNow.clientHeight
          if (dist < 80) {
            isAutoScrollEnabledRef.current = true
            setShowScrollFab(false)
            userHasScrolledUpRef.current = false
          }
        }
      }, SCROLL_COOLDOWN_MS)
      return
    }

    // Near bottom and no active cooldown → re-enable auto-scroll
    if (isNearBottom && !isScrollCooldownActiveRef.current) {
      isAutoScrollEnabledRef.current = true
      setShowScrollFab(false)
      userHasScrolledUpRef.current = false
    } else if (!isNearBottom && (isSending || isStreaming) && userHasScrolledUpRef.current) {
      // Far from bottom during streaming, but only if user intentionally scrolled up
      isAutoScrollEnabledRef.current = false
      setShowScrollFab(true)
    }
  }, [isSending, isStreaming])

  // Handle FAB click — cancel cooldown, re-enable auto-scroll, scroll to bottom
  const handleScrollToBottomClick = useCallback(() => {
    if (scrollCooldownRef.current !== null) {
      clearTimeout(scrollCooldownRef.current)
      scrollCooldownRef.current = null
    }
    isScrollCooldownActiveRef.current = false
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
    userHasScrolledUpRef.current = false
    scrollToBottom()
  }, [scrollToBottom])

  // Conditional auto-scroll: only scroll when enabled
  useEffect(() => {
    if (isAutoScrollEnabledRef.current) {
      scrollToBottom()
    }
  }, [messages, streamingContent, streamingParts, scrollToBottom])

  // Reset auto-scroll state on session switch
  useEffect(() => {
    if (scrollCooldownRef.current !== null) {
      clearTimeout(scrollCooldownRef.current)
      scrollCooldownRef.current = null
    }
    isScrollCooldownActiveRef.current = false
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
    userHasScrolledUpRef.current = false
  }, [sessionId])

  // Instant scroll to bottom when session view becomes connected with messages.
  // This must wait for viewState === 'connected' because the message list DOM
  // is only rendered in that state (connecting shows a loading spinner).
  useEffect(() => {
    if (viewState.status === 'connected' && messages.length > 0) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
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

  // Auto-focus textarea whenever session changes (new session or tab switch)
  // Focus immediately without waiting for connection — users can type while connecting
  useEffect(() => {
    if (textareaRef.current) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
      })
    }
  }, [sessionId])

  // Auto-resize textarea (depends on sessionId to handle pre-populated drafts)
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      requestAnimationFrame(() => {
        textarea.style.height = 'auto'
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
      })
    }
  }, [inputValue, sessionId])

  // Set 'answering' status when a question is pending, revert when answered
  useEffect(() => {
    if (activeQuestion && sessionId) {
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
    } else if (!activeQuestion && sessionId) {
      // Question answered/dismissed — restore status based on session mode
      const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
      if (currentStatus?.status === 'answering') {
        const currentMode = useSessionStore.getState().getSessionMode(sessionId)
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
      }
    }
  }, [activeQuestion, sessionId])

  // Clean up rAF and scroll cooldown on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
      if (scrollCooldownRef.current !== null) {
        clearTimeout(scrollCooldownRef.current)
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
      // Frame-synced: batch text updates per animation frame
      scheduleFlush()
    },
    [updateStreamingPartsRef, scheduleFlush]
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

        if (existingIndex >= 0) {
          // Update existing
          const existing = parts[existingIndex]
          const updatedParts = [...parts]
          updatedParts[existingIndex] = {
            ...existing,
            toolUse: { ...existing.toolUse!, ...update }
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
    streamingPartsRef.current = []
    setStreamingParts([])
    streamingContentRef.current = ''
    setStreamingContent('')
    setIsStreaming(false)
    lastSentPromptRef.current = null
  }, [])

  // Load session info and connect to OpenCode
  useEffect(() => {
    finalizedMessageIdsRef.current.clear()
    hasFinalizedCurrentResponseRef.current = false
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

    const loadMessages = async (source?: {
      worktreePath?: string | null
      opencodeSessionId?: string | null
    }): Promise<OpenCodeMessage[]> => {
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

      if (canUseOpenCodeSource) {
        const result = await window.opencodeOps.getMessages(
          sourceWorktreePath,
          sourceOpencodeSessionId
        )
        if (result.success) {
          loadedFromOpenCode = true

          const opencodeMessages = Array.isArray(result.messages) ? result.messages : []
          loadedMessages = mapOpencodeMessagesToSessionViewMessages(opencodeMessages)

          let totalCost = 0
          let snapshotTokens: TokenInfo | null = null
          let snapshotModelRef: SessionModelRef | undefined

          for (let i = opencodeMessages.length - 1; i >= 0; i--) {
            const rawMessage = opencodeMessages[i]
            if (typeof rawMessage !== 'object' || rawMessage === null) continue

            const messageRecord = rawMessage as Record<string, unknown>
            const info = asRecord(messageRecord.info)
            const role = info?.role ?? messageRecord.role
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
        } else {
          console.warn('Failed to load OpenCode transcript:', result.error)
        }
      }

      if (loadedFromOpenCode) {
        setMessages(loadedMessages)
      } else {
        setMessages((currentMessages) => {
          const loadedIds = new Set(loadedMessages.map((m) => m.id))
          const localOnly = currentMessages.filter((m) => !loadedIds.has(m.id))
          return localOnly.length > 0 ? [...loadedMessages, ...localOnly] : loadedMessages
        })
      }

      const lastMessage = loadedMessages[loadedMessages.length - 1]
      if (lastMessage?.role === 'assistant') {
        const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
        if (currentStatus?.status !== 'working') {
          useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        }
      }

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

      try {
        await loadMessages()
      } catch (error) {
        console.error('Failed to refresh messages after stream completion:', error)
        toast.error('Failed to refresh response')
      } finally {
        resetStreamingState()
        setIsSending(false)
      }
    }

    // Increment generation counter to invalidate stale closures from previous
    // sessions. This prevents cross-tab content bleed when multiple SessionView
    // instances process events concurrently during tab transitions.
    streamGenerationRef.current += 1
    const currentGeneration = streamGenerationRef.current

    // Only clear streaming display state if NOT currently streaming this session.
    // When the user switches away and back to an actively-streaming session,
    // we preserve streamingPartsRef so incoming tool results can find their
    // matching callID via upsertToolUse instead of creating detached entries.
    if (!isStreaming) {
      streamingPartsRef.current = []
      streamingContentRef.current = ''
      childToSubtaskIndexRef.current = new Map()
      setStreamingParts([])
      setStreamingContent('')
    }
    hasFinalizedCurrentResponseRef.current = false

    // Subscribe to OpenCode stream events SYNCHRONOUSLY before any async work.
    // This prevents a race condition where session.idle arrives during async
    // initialization (DB loads, reconnect) and is missed by both this handler
    // (not yet set up) and the global listener (which skips the active session).
    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          // Only handle events for this session
          if (event.sessionId !== sessionId) return

          // Guard: generation check — prevents stale closures from processing
          // events when the user has already switched to a different session.
          if (streamGenerationRef.current !== currentGeneration) return

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
            const sessionTitle = event.data?.info?.title || event.data?.title
            if (sessionTitle) {
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
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

          // Handle different event types
          const eventRole = getEventMessageRole(event.data)

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

            // New stream content means we're processing a new assistant response.
            if (
              streamingPartsRef.current.length === 0 &&
              streamingContentRef.current.length === 0
            ) {
              hasFinalizedCurrentResponseRef.current = false
            }

            if (part.type === 'text') {
              // Update streaming text content with delta or full text
              const delta = event.data?.delta
              if (delta) {
                appendTextDelta(delta)
              } else if (part.text) {
                setTextContent(part.text)
              }
              setIsStreaming(true)
            } else if (part.type === 'tool') {
              // Tool part from OpenCode SDK - has callID, tool (name), state
              const toolId = part.callID || part.id || `tool-${Date.now()}`
              const toolName = part.tool || 'Unknown'
              const state = part.state || {}

              const statusMap: Record<string, ToolStatus> = {
                pending: 'pending',
                running: 'running',
                completed: 'success',
                error: 'error'
              }

              upsertToolUse(toolId, {
                name: toolName,
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
            } else if (part.type === 'compaction') {
              updateStreamingPartsRef((parts) => [
                ...parts,
                { type: 'compaction' as const, compactionAuto: part.auto === true }
              ])
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
            setQueuedMessages([])

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
              // Session became active (again) — restart streaming state.
              // If we previously finalized on idle, reset so the next idle
              // can finalize the new response.
              setIsStreaming(true)
              hasFinalizedCurrentResponseRef.current = false
              newPromptPendingRef.current = false
              setIsSending(true)

              // Restore worktree status to working/planning
              const currentMode = useSessionStore.getState().getSessionMode(sessionId)
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
            } else if (status.type === 'idle') {
              // Session is done — flush and finalize immediately
              immediateFlush()
              setIsSending(false)
              setQueuedMessages([])

              if (!hasFinalizedCurrentResponseRef.current) {
                hasFinalizedCurrentResponseRef.current = true
                void finalizeResponse()
              }

              // Update worktree status
              const activeId = useSessionStore.getState().activeSessionId
              const statusStore = useWorktreeStatusStore.getState()
              if (activeId === sessionId) {
                statusStore.clearSessionStatus(sessionId)
              } else {
                statusStore.setSessionStatus(sessionId, 'unread')
              }
            }
            // 'retry' status: keep isStreaming true, could add retry UI later
          }
        })
      : () => {}

    const initializeSession = async (): Promise<void> => {
      setViewState({ status: 'connecting' })

      try {
        // 1. Resolve session/worktree metadata so transcript loading can prefer OpenCode
        const session = (await window.db.session.get(sessionId)) as DbSession | null
        if (!session) {
          throw new Error('Session not found')
        }

        let wtPath: string | null = null
        if (session.worktree_id) {
          setWorktreeId(session.worktree_id)
          const worktree = (await window.db.worktree.get(session.worktree_id)) as DbWorktree | null
          if (worktree) {
            wtPath = worktree.path
            setWorktreePath(wtPath)
            transcriptSourceRef.current.worktreePath = wtPath
          }
        }

        const existingOpcSessionId = session.opencode_session_id
        if (existingOpcSessionId) {
          setOpencodeSessionId(existingOpcSessionId)
          transcriptSourceRef.current.opencodeSessionId = existingOpcSessionId
        }

        // 2. Hydrate transcript (OpenCode canonical source when possible)
        const loadedMessages = await loadMessages({
          worktreePath: wtPath,
          opencodeSessionId: existingOpcSessionId
        })

        // 2b. Restore streaming parts from the last persisted assistant message.
        // When the user switches away from a session with an active tool call
        // and then switches back, streamingPartsRef is empty. Without this
        // restoration, incoming tool results can't find their matching callID
        // and create a new detached entry. Re-populating the parts ref from
        // the DB lets tool results merge correctly.
        if (loadedMessages.length > 0) {
          const lastMsg = loadedMessages[loadedMessages.length - 1]
          if (lastMsg.role === 'assistant' && lastMsg.parts && lastMsg.parts.length > 0) {
            const dbParts = lastMsg.parts.map((p) => ({ ...p }))

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
              streamingPartsRef.current = [...dbParts, ...extraParts]
            } else {
              streamingPartsRef.current = dbParts
            }

            setStreamingParts([...streamingPartsRef.current])

            const textParts = streamingPartsRef.current.filter((p) => p.type === 'text')
            if (textParts.length > 0) {
              const content = textParts.map((p) => p.text || '').join('')
              streamingContentRef.current = content
              setStreamingContent(content)
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
        const fetchCommands = (path: string): void => {
          window.opencodeOps
            .commands(path)
            .then((result) => {
              if (result.success && result.commands) {
                setSlashCommands(result.commands)
              }
            })
            .catch((err) => {
              console.warn('Failed to fetch slash commands:', err)
            })
        }

        // Hydrate any pending permission requests (fire-and-forget)
        const hydratePermissions = (path: string): void => {
          window.opencodeOps
            .permissionList(path)
            .then((result) => {
              if (result.success && result.permissions) {
                for (const req of result.permissions) {
                  const r = req as PermissionRequest
                  if (r.id && r.permission) {
                    usePermissionStore.getState().addPermission(sessionId, r)
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
          const pendingMsg = useSessionStore.getState().consumePendingMessage(sessionId)
          if (!pendingMsg) return
          try {
            setMessages((prev) => [...prev, createLocalMessage('user', pendingMsg)])
            // Set worktree status based on session mode
            const currentMode = useSessionStore.getState().getSessionMode(sessionId)
            useWorktreeStatusStore
              .getState()
              .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
            // Apply mode prefix (e.g., plan mode for code reviews)
            const modePrefix =
              currentMode === 'plan'
                ? '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
                : ''
            // Send to OpenCode
            await window.opencodeOps.prompt(path, opcId, modePrefix + pendingMsg)
          } catch (err) {
            console.error('Failed to send pending message:', err)
            toast.error('Failed to send review prompt')
          }
        }

        if (existingOpcSessionId) {
          // Try to reconnect to existing session
          const reconnectResult = await window.opencodeOps.reconnect(
            wtPath,
            existingOpcSessionId,
            sessionId
          )
          if (reconnectResult.success) {
            setOpencodeSessionId(existingOpcSessionId)
            transcriptSourceRef.current.opencodeSessionId = existingOpcSessionId
            fetchModelLimits()
            fetchCommands(wtPath)
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
            await sendPendingMessage(wtPath, existingOpcSessionId)
            return
          }
        }

        // Create new OpenCode session
        const connectResult = await window.opencodeOps.connect(wtPath, sessionId)
        if (connectResult.success && connectResult.sessionId) {
          setOpencodeSessionId(connectResult.sessionId)
          transcriptSourceRef.current.opencodeSessionId = connectResult.sessionId
          fetchModelLimits()
          fetchCommands(wtPath)
          hydratePermissions(wtPath)
          // Store the OpenCode session ID in database for future reconnection
          await window.db.session.update(sessionId, {
            opencode_session_id: connectResult.sessionId
          })
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
          transcriptSourceRef.current.opencodeSessionId = existingOpcSessionId
          activeOpcSessionId = existingOpcSessionId
        } else {
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
        transcriptSourceRef.current.opencodeSessionId = connectResult.sessionId
        await window.db.session.update(sessionId, {
          opencode_session_id: connectResult.sessionId
        })
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

      const loadedMessages = mapOpencodeMessagesToSessionViewMessages(
        Array.isArray(transcriptResult.messages) ? transcriptResult.messages : []
      )
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

  // Handle send message
  const handleSend = useCallback(async () => {
    const trimmedValue = inputValue.trim()
    if (!trimmedValue) return

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
    }
    setInputValue('')
    inputValueRef.current = ''
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    window.db.session.updateDraft(sessionId, null)

    // User just sent a message — cancel any scroll cooldown and resume auto-scroll
    if (scrollCooldownRef.current !== null) {
      clearTimeout(scrollCooldownRef.current)
      scrollCooldownRef.current = null
    }
    isScrollCooldownActiveRef.current = false
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
    userHasScrolledUpRef.current = false

    // Set worktree status based on session mode (plan → planning, build → working)
    const currentModeForStatus = useSessionStore.getState().getSessionMode(sessionId)
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, currentModeForStatus === 'plan' ? 'planning' : 'working')

    try {
      setMessages((prev) => [...prev, createLocalMessage('user', trimmedValue)])

      // Mark that a new prompt is in flight — prevents finalizeResponse
      // from reordering this message if a previous stream is still completing.
      newPromptPendingRef.current = true

      // Record prompt to history for Up/Down navigation
      if (worktreeId) {
        usePromptHistoryStore.getState().addPrompt(worktreeId, trimmedValue)
        useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
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
        // Detect slash commands and route through the SDK command endpoint
        if (trimmedValue.startsWith('/')) {
          const spaceIndex = trimmedValue.indexOf(' ')
          const commandName =
            spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)
          const commandArgs = spaceIndex > 0 ? trimmedValue.slice(spaceIndex + 1).trim() : ''

          const matchedCommand = slashCommands.find((c) => c.name === commandName)

          if (matchedCommand) {
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
            const result = await window.opencodeOps.command(
              worktreePath,
              opencodeSessionId,
              commandName,
              commandArgs
            )
            if (!result.success) {
              console.error('Failed to send command:', result.error)
              toast.error('Failed to send command')
              setIsSending(false)
            }
          } else {
            // Unknown command — send as regular prompt (SDK may handle it)
            const currentMode = useSessionStore.getState().getSessionMode(sessionId)
            const modePrefix =
              currentMode === 'plan'
                ? '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
                : ''
            const promptMessage = modePrefix + trimmedValue
            lastSentPromptRef.current = promptMessage
            const parts: MessagePart[] = [
              ...attachments.map((a) => ({
                type: 'file' as const,
                mime: a.mime,
                url: a.dataUrl,
                filename: a.name
              })),
              { type: 'text' as const, text: promptMessage }
            ]
            setAttachments([])
            const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, parts)
            if (!result.success) {
              console.error('Failed to send prompt to OpenCode:', result.error)
              toast.error('Failed to send message to AI')
              setIsSending(false)
            }
          }
        } else {
          // Regular prompt — existing code (with mode prefix, attachments, etc.)
          const currentMode = useSessionStore.getState().getSessionMode(sessionId)
          const modePrefix =
            currentMode === 'plan'
              ? '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
              : ''
          const promptMessage = modePrefix + trimmedValue
          // Store the full prompt so the stream handler can detect SDK echoes
          // of the user message (the SDK often re-emits the prompt without a
          // role field, making it indistinguishable from assistant text).
          lastSentPromptRef.current = promptMessage
          const parts: MessagePart[] = [
            ...attachments.map((a) => ({
              type: 'file' as const,
              mime: a.mime,
              url: a.dataUrl,
              filename: a.name
            })),
            { type: 'text' as const, text: promptMessage }
          ]
          setAttachments([])
          const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, parts)
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
  }, [
    inputValue,
    isStreaming,
    sessionId,
    worktreePath,
    worktreeId,
    opencodeSessionId,
    attachments,
    slashCommands
  ])

  // Abort streaming
  const handleAbort = useCallback(async () => {
    if (!worktreePath || !opencodeSessionId) return
    await window.opencodeOps.abort(worktreePath, opencodeSessionId)
  }, [worktreePath, opencodeSessionId])

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
        return
      }

      // Prompt history navigation with Up/Down arrows
      if (e.key === 'ArrowUp') {
        const textarea = e.currentTarget
        // Only activate at cursor position 0 (very beginning)
        if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) return

        const wId = worktreeId
        if (!wId) return
        const history = usePromptHistoryStore.getState().getHistory(wId)
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

        const wId = worktreeId
        if (!wId) return
        const history = usePromptHistoryStore.getState().getHistory(wId)

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
    [handleSend, worktreeId, historyIndex, inputValue]
  )

  // Attachment handlers
  const handleAttach = useCallback((file: { name: string; mime: string; dataUrl: string }) => {
    setAttachments((prev) => [...prev, { id: crypto.randomUUID(), ...file }])
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // Slash command handlers
  const handleInputChange = useCallback(
    (value: string) => {
      setInputValue(value)
      inputValueRef.current = value

      // Exit history navigation on manual typing
      if (historyIndex !== null) {
        setHistoryIndex(null)
      }

      if (value.startsWith('/') && value.length >= 1) {
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
    [sessionId, historyIndex]
  )

  const handleCommandSelect = useCallback((cmd: { name: string; template: string }) => {
    setInputValue(`/${cmd.name} `)
    setShowSlashCommands(false)
    textareaRef.current?.focus()
  }, [])

  const handleSlashClose = useCallback(() => {
    setShowSlashCommands(false)
  }, [])

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
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

  // Determine if there's streaming content to show
  const hasStreamingContent = streamingParts.length > 0 || streamingContent.length > 0

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
          ref={scrollContainerRef}
          className="h-full overflow-y-auto"
          onScroll={handleScroll}
          data-testid="message-list"
        >
          {messages.length === 0 && !hasStreamingContent ? (
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
            <div className="py-4">
              {messages.map((message) => (
                <MessageRenderer key={message.id} message={message} cwd={worktreePath} />
              ))}
              {/* Streaming message */}
              {hasStreamingContent && (
                <MessageRenderer
                  message={{
                    id: 'streaming',
                    role: 'assistant',
                    content: streamingContent,
                    timestamp: new Date().toISOString(),
                    parts: streamingParts
                  }}
                  isStreaming={isStreaming}
                  cwd={worktreePath}
                />
              )}
              {/* Typing indicator when waiting for response */}
              {isSending && !hasStreamingContent && (
                <div className="px-6 py-5" data-testid="typing-indicator">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
                    <span
                      className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                      style={{ animationDelay: '0.1s' }}
                    />
                    <span
                      className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                      style={{ animationDelay: '0.2s' }}
                    />
                  </div>
                </div>
              )}
              {/* Queued messages rendered as visible bubbles */}
              {queuedMessages.map((msg) => (
                <QueuedMessageBubble key={msg.id} content={msg.content} />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
        {/* Scroll-to-bottom FAB */}
        <ScrollToBottomFab onClick={handleScrollToBottomClick} visible={showScrollFab} />
      </div>

      {/* Permission prompt from AI */}
      {activePermission && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto">
            <PermissionPrompt request={activePermission} onReply={handlePermissionReply} />
          </div>
        </div>
      )}

      {/* Question prompt from AI */}
      {activeQuestion && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto">
            <QuestionPrompt
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
            commands={slashCommands}
            filter={inputValue}
            onSelect={handleCommandSelect}
            onClose={handleSlashClose}
            visible={showSlashCommands}
          />
          <div
            className={cn(
              'rounded-xl border-2 transition-colors duration-200 overflow-hidden',
              mode === 'build'
                ? 'border-blue-500/50 bg-blue-500/5'
                : 'border-violet-500/50 bg-violet-500/5'
            )}
          >
            {/* Top row: mode toggle */}
            <div className="px-3 pt-2.5 pb-1">
              <ModeToggle sessionId={sessionId} />
            </div>

            {/* Attachment previews */}
            <AttachmentPreview attachments={attachments} onRemove={handleRemoveAttachment} />

            {/* Middle: textarea */}
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={!!activePermission}
              placeholder={
                activePermission ? 'Waiting for permission response...' : 'Type your message...'
              }
              aria-label="Message input"
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

            {/* Bottom row: model selector + context indicator + hint text + send button */}
            <div className="flex items-center justify-between px-3 pb-2.5">
              <div className="flex items-center gap-2">
                <ModelSelector />
                <AttachmentButton onAttach={handleAttach} />
                <ContextIndicator
                  sessionId={sessionId}
                  modelId={currentModelId}
                  providerId={currentProviderId}
                />
                <span className="text-xs text-muted-foreground">
                  Enter to send, Shift+Enter for new line
                </span>
              </div>
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
                  onClick={handleSend}
                  disabled={!inputValue.trim() || !!activePermission}
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label={isStreaming ? 'Queue message' : 'Send message'}
                  title={isStreaming ? 'Queue message' : 'Send message'}
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
  )
}
